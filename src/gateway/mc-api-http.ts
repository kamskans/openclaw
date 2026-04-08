/**
 * Mission Control HTTP API endpoints.
 *
 * Exposes session, message, and agent-file data over HTTP so the Mission Control
 * frontend can query the gateway directly instead of routing through Convex.
 *
 * All endpoints require Bearer-token authentication (same token as `/v1/chat/completions`).
 *
 * Endpoints:
 *   POST /mc/v1/pairing/approve                    → approve a Telegram pairing code
 *   GET  /mc/v1/crons?agentId=X                   → list cron jobs (optionally filtered by agent)
 *   DELETE /mc/v1/crons/:id                        → delete a cron job
 *   GET  /mc/v1/sessions?agentId=X               → list sessions (with optional filters)
 *   GET  /mc/v1/sessions/:key/messages?limit=200  → chat history for a session
 *   GET  /mc/v1/agents/:agentId/files             → list workspace files
 *   GET  /mc/v1/agents/:agentId/files/:name        → read a workspace file
 *   PUT  /mc/v1/agents/:agentId/files/:name        → write a workspace file
 *   GET  /mc/v1/browser/linkedin-cookies           → extract LinkedIn cookies via CDP
 *   POST /mc/v1/browser/navigate                   → navigate Chromium to a URL via CDP
 */

import fsPromises from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  isWorkspaceOnboardingCompleted,
} from "../agents/workspace.js";
import { notifyPairingApproved } from "../channels/plugins/pairing.js";
import { loadConfig } from "../config/config.js";
import { loadCronStore, resolveCronStorePath, saveCronStore } from "../cron/store.js";
import { approveChannelPairingCode } from "../pairing/pairing-store.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-utils.js";
import { sendJson, sendInvalidRequest, sendMethodNotAllowed } from "./http-common.js";
import {
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  readSessionMessages,
} from "./session-utils.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MC_API_PREFIX = "/mc/v1";

const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
] as const;

const MEMORY_FILE_NAMES = [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME] as const;
const ALLOWED_FILE_NAMES = new Set<string>([...BOOTSTRAP_FILE_NAMES, ...MEMORY_FILE_NAMES]);
function isAllowedFileName(name: string): boolean {
  return ALLOWED_FILE_NAMES.has(name) || name.endsWith(".md");
}

const MAX_BODY_BYTES = 512 * 1024; // 512 KB for file writes

type McApiOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  rateLimiter?: AuthRateLimiter;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveAgentIdOrNull(agentIdRaw: string): string | null {
  const cfg = loadConfig();
  const agentId = normalizeAgentId(agentIdRaw);
  const allowed = new Set(listAgentIds(cfg));
  return allowed.has(agentId) ? agentId : null;
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function statFile(filePath: string): Promise<{ size: number; updatedAtMs: number } | null> {
  try {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return { size: stat.size, updatedAtMs: Math.floor(stat.mtimeMs) };
  } catch {
    return null;
  }
}

// ── Route: GET /mc/v1/sessions ─────────────────────────────────────────────

async function handleListSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const cfg = loadConfig();
  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);

  const agentId = url.searchParams.get("agentId") || undefined;
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? Math.min(Math.max(1, parseInt(limitStr, 10) || 100), 500) : 100;
  const includeLastMessage = url.searchParams.get("includeLastMessage") === "true";

  const result = listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      limit,
      agentId,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage,
    },
  });

  sendJson(res, 200, result);
}

// ── Route: GET /mc/v1/sessions/:key/messages ────────────────────────────────

async function handleGetMessages(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionKey: string,
  url: URL,
): Promise<void> {
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? Math.min(Math.max(1, parseInt(limitStr, 10) || 200), 1000) : 200;

  const { storePath, entry } = loadSessionEntry(sessionKey);

  if (!entry?.sessionId || !storePath) {
    sendJson(res, 200, {
      sessionKey,
      sessionId: null,
      messages: [],
    });
    return;
  }

  const rawMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);

  // Apply limit — take the last N messages
  const messages = rawMessages.length > limit ? rawMessages.slice(-limit) : rawMessages;

  sendJson(res, 200, {
    sessionKey,
    sessionId: entry.sessionId,
    messages,
  });
}

// ── Route: GET /mc/v1/agents/:agentId/files ─────────────────────────────────

async function handleListFiles(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<void> {
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  let hideBootstrap = false;
  try {
    hideBootstrap = await isWorkspaceOnboardingCompleted(workspaceDir);
  } catch {
    // Fall back to showing all files
  }

  const bootstrapNames = hideBootstrap
    ? BOOTSTRAP_FILE_NAMES.filter((n) => n !== DEFAULT_BOOTSTRAP_FILENAME)
    : BOOTSTRAP_FILE_NAMES;

  const files: Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }> = [];

  for (const name of bootstrapNames) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  // Memory files — check primary, fall back to alt
  for (const name of MEMORY_FILE_NAMES) {
    const filePath = path.join(workspaceDir, name);
    const meta = await statFile(filePath);
    if (meta) {
      files.push({
        name,
        path: filePath,
        missing: false,
        size: meta.size,
        updatedAtMs: meta.updatedAtMs,
      });
    } else {
      files.push({ name, path: filePath, missing: true });
    }
  }

  // Extra .md files in the workspace not in the known list (e.g. CREATIVE.md, WEBSITE.md)
  try {
    const listedNames = new Set(files.map((f) => f.name));
    const dirEntries = await fsPromises.readdir(workspaceDir);
    for (const entry of dirEntries) {
      if (!entry.endsWith(".md") || listedNames.has(entry)) continue;
      const filePath = path.join(workspaceDir, entry);
      const meta = await statFile(filePath);
      if (meta) {
        files.push({ name: entry, path: filePath, missing: false, size: meta.size, updatedAtMs: meta.updatedAtMs });
      }
    }
  } catch {
    // workspace dir may not exist yet — ignore
  }

  sendJson(res, 200, { agentId, workspace: workspaceDir, files });
}

// ── Route: GET /mc/v1/agents/:agentId/files/:name ───────────────────────────

async function handleGetFile(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  fileName: string,
): Promise<void> {
  if (!isAllowedFileName(fileName)) {
    sendInvalidRequest(res, `unsupported file "${fileName}"`);
    return;
  }

  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const filePath = path.join(workspaceDir, fileName);
  const meta = await statFile(filePath);

  if (!meta) {
    sendJson(res, 200, {
      agentId,
      workspace: workspaceDir,
      file: { name: fileName, path: filePath, missing: true },
    });
    return;
  }

  const content = await fsPromises.readFile(filePath, "utf-8");
  sendJson(res, 200, {
    agentId,
    workspace: workspaceDir,
    file: {
      name: fileName,
      path: filePath,
      missing: false,
      size: meta.size,
      updatedAtMs: meta.updatedAtMs,
      content,
    },
  });
}

// ── Route: PUT /mc/v1/agents/:agentId/files/:name ───────────────────────────

async function handlePutFile(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  fileName: string,
): Promise<void> {
  if (!isAllowedFileName(fileName)) {
    sendInvalidRequest(res, `unsupported file "${fileName}"`);
    return;
  }

  let body: Record<string, unknown> | undefined;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "payload too large") {
      sendJson(res, 413, {
        error: { message: "Payload too large", type: "invalid_request_error" },
      });
    } else {
      sendInvalidRequest(res, "Invalid JSON body");
    }
    return;
  }

  const rawContent = body?.content;
  const content = typeof rawContent === "string" ? rawContent : "";
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  await fsPromises.mkdir(workspaceDir, { recursive: true });
  const filePath = path.join(workspaceDir, fileName);
  await fsPromises.writeFile(filePath, content, "utf-8");

  const meta = await statFile(filePath);
  sendJson(res, 200, {
    ok: true,
    agentId,
    workspace: workspaceDir,
    file: {
      name: fileName,
      path: filePath,
      missing: false,
      size: meta?.size,
      updatedAtMs: meta?.updatedAtMs,
      content,
    },
  });
}

// ── Route: GET /mc/v1/crons ─────────────────────────────────────────────────

async function handleListCrons(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const cfg = loadConfig();
  const storePath = resolveCronStorePath(cfg.cron?.store);
  const store = await loadCronStore(storePath);

  const agentIdFilter = url.searchParams.get("agentId") || undefined;
  let jobs = store.jobs;
  if (agentIdFilter) {
    jobs = jobs.filter((j) => j.agentId === agentIdFilter);
  }

  sendJson(res, 200, { jobs });
}

// ── Route: PATCH /mc/v1/crons/:id ───────────────────────────────────────────

async function handleUpdateCron(
  req: IncomingMessage,
  res: ServerResponse,
  cronId: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "payload too large") {
      sendJson(res, 413, {
        error: { message: "Payload too large", type: "invalid_request_error" },
      });
    } else {
      sendInvalidRequest(res, "Invalid JSON body");
    }
    return;
  }

  const cfg = loadConfig();
  const storePath = resolveCronStorePath(cfg.cron?.store);
  const store = await loadCronStore(storePath);

  const idx = store.jobs.findIndex((j) => j.id === cronId);
  if (idx === -1) {
    sendJson(res, 404, { ok: false, error: "Cron job not found" });
    return;
  }

  const schedule = body.schedule as Record<string, unknown> | undefined;
  if (schedule) {
    const job = store.jobs[idx];
    if (typeof schedule.expr === "string") {
      (job.schedule as any).expr = schedule.expr;
      (job.schedule as any).kind = "cron";
    }
    if (typeof schedule.tz === "string") {
      (job.schedule as any).tz = schedule.tz;
    }
    // Clear cached next-run so the cron runner recalculates from the new schedule.
    delete (job.state as any).nextRunAtMs;
    job.updatedAtMs = Date.now();
  }

  await saveCronStore(storePath, store);
  sendJson(res, 200, { ok: true, job: store.jobs[idx] });
}

// ── Route: PUT /mc/v1/system/timezone ────────────────────────────────────────

async function handleSetTimezone(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    sendInvalidRequest(res, "Invalid JSON body");
    return;
  }

  const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
  if (!tz) {
    sendInvalidRequest(res, "Missing required field: timezone");
    return;
  }

  // Patch all existing cron jobs to the new timezone.
  const cfg = loadConfig();
  const storePath = resolveCronStorePath(cfg.cron?.store);
  const store = await loadCronStore(storePath);
  let updated = 0;
  for (const job of store.jobs) {
    if (job.schedule && (job.schedule as any).tz !== tz) {
      (job.schedule as any).tz = tz;
      delete (job.state as any).nextRunAtMs;
      job.updatedAtMs = Date.now();
      updated++;
    }
  }
  if (updated > 0) {
    await saveCronStore(storePath, store);
  }

  sendJson(res, 200, { ok: true, updated, timezone: tz });
}

// ── Route: DELETE /mc/v1/crons/:id ──────────────────────────────────────────

async function handleDeleteCron(
  _req: IncomingMessage,
  res: ServerResponse,
  cronId: string,
): Promise<void> {
  const cfg = loadConfig();
  const storePath = resolveCronStorePath(cfg.cron?.store);
  const store = await loadCronStore(storePath);

  const idx = store.jobs.findIndex((j) => j.id === cronId);
  if (idx === -1) {
    sendJson(res, 404, { ok: false, error: "Cron job not found" });
    return;
  }

  store.jobs.splice(idx, 1);
  await saveCronStore(storePath, store);
  sendJson(res, 200, { ok: true, deleted: cronId });
}

// ── Route: GET /mc/v1/browser/linkedin-cookies ──────────────────────────────

const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9222;

/** Fetch the first available CDP WebSocket debugger URL. */
async function getCdpDebuggerUrl(): Promise<string | null> {
  try {
    const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
    if (!res.ok) return null;
    const targets = (await res.json()) as Array<{ webSocketDebuggerUrl?: string; type?: string }>;
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    return page?.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/** Send a CDP command over a WebSocket and wait for the matching response. */
function cdpCommand(
  ws: any,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`CDP command ${method} timed out`));
    }, 10000);

    ws.addEventListener("message", function handler(ev: { data: string }) {
      try {
        const msg = JSON.parse(ev.data) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== id) return;
        ws.removeEventListener("message", handler);
        clearTimeout(timeout);
        if (msg.error) {
          reject(new Error(JSON.stringify(msg.error)));
        } else {
          resolve((msg.result ?? {}) as Record<string, unknown>);
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Open a CDP WebSocket, run a command, then close it. */
async function withCdp<T>(
  debuggerUrl: string,
  fn: (ws: any) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const WS = (globalThis as any).WebSocket as typeof WebSocket | undefined;
    if (!WS) {
      reject(new Error("WebSocket not available in this Node version"));
      return;
    }
    const ws = new WS(debuggerUrl);
    ws.addEventListener("error", (ev: any) => reject(new Error(String(ev?.message || "WebSocket error"))));
    ws.addEventListener("open", () => {
      fn(ws).then(resolve, reject).finally(() => {
        try { (ws as any).close(); } catch { /* ignore */ }
      });
    });
  });
}

async function handleGetLinkedInCookies(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const debuggerUrl = await getCdpDebuggerUrl();
  if (!debuggerUrl) {
    sendJson(res, 503, { ok: false, error: "Chromium CDP not available" });
    return;
  }

  try {
    const result = await withCdp(debuggerUrl, (ws) =>
      cdpCommand(ws, 1, "Network.getCookies", { urls: ["https://www.linkedin.com"] }),
    );
    const cookies = (result.cookies ?? []) as Array<{ name: string; value: string; domain: string }>;
    const liAt = cookies.find((c) => c.name === "li_at")?.value ?? null;
    const jsessionId = cookies.find((c) => c.name === "JSESSIONID")?.value ?? null;
    sendJson(res, 200, { ok: true, liAt, jsessionId, cookies });
  } catch (err: unknown) {
    sendJson(res, 500, { ok: false, error: String(err) });
  }
}

// ── Route: POST /mc/v1/browser/navigate ─────────────────────────────────────

async function handleBrowserNavigate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req, 4096);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    sendInvalidRequest(res, "Invalid JSON body");
    return;
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    sendInvalidRequest(res, "Missing required field: url");
    return;
  }

  const debuggerUrl = await getCdpDebuggerUrl();
  if (!debuggerUrl) {
    sendJson(res, 503, { ok: false, error: "Chromium CDP not available" });
    return;
  }

  try {
    await withCdp(debuggerUrl, (ws) => cdpCommand(ws, 1, "Page.navigate", { url }));
    sendJson(res, 200, { ok: true, url });
  } catch (err: unknown) {
    sendJson(res, 500, { ok: false, error: String(err) });
  }
}

// ── Route: POST /mc/v1/pairing/approve ─────────────────────────────────────

async function handlePairingApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 1024);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendInvalidRequest(res, "Invalid JSON body");
    return;
  }

  const rawChannel = parsed.channel;
  const rawCode = parsed.code;
  const channel = (typeof rawChannel === "string" ? rawChannel : "").trim().toLowerCase();
  const code = (typeof rawCode === "string" ? rawCode : "").trim();

  if (!channel) {
    sendInvalidRequest(res, "Missing channel");
    return;
  }
  if (!code || code.length < 4 || code.length > 64) {
    sendInvalidRequest(res, "Invalid code");
    return;
  }

  const approved = await approveChannelPairingCode({ channel, code });
  if (!approved) {
    sendJson(res, 404, { ok: false, error: "No pending pairing request found for that code" });
    return;
  }

  // Notify the Telegram user that pairing succeeded (best-effort).
  try {
    const cfg = loadConfig();
    await notifyPairingApproved({ channelId: channel, id: approved.id, cfg });
  } catch {
    // non-blocking
  }

  sendJson(res, 200, { ok: true, id: approved.id });
}

// ── Main handler ───────────────────────────────────────────────────────────

/**
 * Handle Mission Control API HTTP requests.
 *
 * Returns `true` if the request was handled, `false` if it did not match any
 * MC API route (so the caller should try the next handler).
 */
export async function handleMcApiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: McApiOptions,
): Promise<boolean> {
  const url = parseUrl(req);
  const pathname = url.pathname;

  // Quick prefix check — bail early if not our route
  if (!pathname.startsWith(MC_API_PREFIX)) {
    return false;
  }

  // Authenticate
  const authorized = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    rateLimiter: opts.rateLimiter,
  });
  if (!authorized) {
    return true; // Auth error already sent
  }

  const subPath = pathname.slice(MC_API_PREFIX.length);

  // ── GET /mc/v1/crons ──────────────────────────────────────────────────
  if (subPath === "/crons" && req.method === "GET") {
    await handleListCrons(req, res, url);
    return true;
  }

  // ── DELETE|PATCH /mc/v1/crons/:id ────────────────────────────────────
  const cronIdMatch = subPath.match(/^\/crons\/([^/]+)$/);
  if (cronIdMatch && req.method === "DELETE") {
    const cronId = decodeURIComponent(cronIdMatch[1]);
    await handleDeleteCron(req, res, cronId);
    return true;
  }
  if (cronIdMatch && req.method === "PATCH") {
    const cronId = decodeURIComponent(cronIdMatch[1]);
    await handleUpdateCron(req, res, cronId);
    return true;
  }

  // ── PUT /mc/v1/system/timezone ────────────────────────────────────────
  if (subPath === "/system/timezone" && req.method === "PUT") {
    await handleSetTimezone(req, res);
    return true;
  }

  // ── POST /mc/v1/pairing/approve ────────────────────────────────────────
  if (subPath === "/pairing/approve" && req.method === "POST") {
    await handlePairingApprove(req, res);
    return true;
  }

  // ── GET /mc/v1/sessions ──────────────────────────────────────────────
  if (subPath === "/sessions" && req.method === "GET") {
    await handleListSessions(req, res, url);
    return true;
  }

  // ── GET /mc/v1/sessions/:key/messages ────────────────────────────────
  const sessionsMatch = subPath.match(/^\/sessions\/([^/]+)\/messages$/);
  if (sessionsMatch && req.method === "GET") {
    const sessionKey = decodeURIComponent(sessionsMatch[1]);
    await handleGetMessages(req, res, sessionKey, url);
    return true;
  }

  // ── GET /mc/v1/agents/:agentId/files ─────────────────────────────────
  const agentFilesListMatch = subPath.match(/^\/agents\/([^/]+)\/files$/);
  if (agentFilesListMatch && req.method === "GET") {
    const agentId = resolveAgentIdOrNull(decodeURIComponent(agentFilesListMatch[1]));
    if (!agentId) {
      sendInvalidRequest(res, "unknown agent id");
      return true;
    }
    await handleListFiles(req, res, agentId);
    return true;
  }

  // ── GET /mc/v1/browser/linkedin-cookies ──────────────────────────────
  if (subPath === "/browser/linkedin-cookies" && req.method === "GET") {
    await handleGetLinkedInCookies(req, res);
    return true;
  }

  // ── POST /mc/v1/browser/navigate ─────────────────────────────────────
  if (subPath === "/browser/navigate" && req.method === "POST") {
    await handleBrowserNavigate(req, res);
    return true;
  }

  // ── GET|PUT /mc/v1/agents/:agentId/files/:name ───────────────────────
  const agentFileMatch = subPath.match(/^\/agents\/([^/]+)\/files\/([^/]+)$/);
  if (agentFileMatch) {
    const agentId = resolveAgentIdOrNull(decodeURIComponent(agentFileMatch[1]));
    if (!agentId) {
      sendInvalidRequest(res, "unknown agent id");
      return true;
    }
    const fileName = decodeURIComponent(agentFileMatch[2]);

    if (req.method === "GET") {
      await handleGetFile(req, res, agentId, fileName);
      return true;
    }
    if (req.method === "PUT") {
      await handlePutFile(req, res, agentId, fileName);
      return true;
    }
    sendMethodNotAllowed(res, "GET, PUT");
    return true;
  }

  // No match within MC API prefix — 404
  sendJson(res, 404, { error: { message: "Not Found", type: "not_found" } });
  return true;
}
