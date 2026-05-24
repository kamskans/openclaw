/**
 * Codex (ChatGPT) OAuth — HTTP surface for the Mission Control admin UI.
 *
 * The wrapped CLI command (`openclaw models auth login --provider
 * openai-codex`) is interactive: it spawns clack prompts, opens a browser
 * locally, and races a callback-server listener against a manual-paste
 * fallback. None of that is reachable when the customer's gateway runs
 * inside a Docker container on a remote VM and the customer is sitting
 * in their browser five thousand miles away.
 *
 * This module re-wraps the same `loginOpenAICodex()` primitive from
 * `@mariozechner/pi-ai/oauth` with three HTTP endpoints so the
 * Mission Control web app can drive the flow end-to-end:
 *
 *   POST /mc/v1/codex/auth/start
 *        → kicks off the OAuth flow, returns { sessionId, authUrl,
 *          expiresIn }. The pi-ai login() call runs in the background
 *          and parks awaiting onManualCodeInput.
 *   GET  /mc/v1/codex/auth/status?sessionId=...
 *        → polled by the UI: returns
 *          { status: "awaiting_code" | "completing" | "connected" |
 *            "expired" | "error", error?, profileId?, accountId?,
 *            email? }
 *   POST /mc/v1/codex/auth/complete    body { sessionId, code }
 *        → fulfills the manual-code promise. The background login()
 *          resumes, completes the token exchange, persists the
 *          credential to auth-profiles.json (type: "oauth" so the
 *          existing refresh machinery in auth-profiles/oauth.ts
 *          auto-rotates it forever after), and flips the session
 *          to "connected". Also enables `codex` plugin entries and
 *          updates each agent's primary model to a codex route so the
 *          subscription is actually used.
 *   POST /mc/v1/codex/auth/cancel       body { sessionId }
 *        → rejects the manual-code promise; cleans up.
 *
 * Why a server-side session store: the OAuth library is callback-driven
 * — pi-ai's `loginOpenAICodex` returns a Promise that resolves with
 * credentials, and along the way it calls user-supplied `onAuth` /
 * `onManualCodeInput` callbacks. We can't hand the running flow to the
 * UI; we have to hold it here, expose its state via polling, and
 * resolve its manual-code prompt from a separate request. Sessions
 * expire after 15 min to avoid leaking dangling Promises if a user
 * walks away.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { loginOpenAICodex, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/upsert-with-lock.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { loadConfig, mutateConfigFile } from "../config/config.js";
import { sendJson, sendInvalidRequest } from "./http-common.js";

const SESSION_TTL_MS = 15 * 60 * 1000;
const AUTH_URL_WAIT_MS = 8_000;
const POLL_INTERVAL_MS = 100;

type SessionStatus =
  | "starting"
  | "awaiting_code"
  | "completing"
  | "connected"
  | "expired"
  | "error";

interface CodexAuthSession {
  sessionId: string;
  status: SessionStatus;
  authUrl?: string;
  error?: string;
  progress?: string;
  profileId?: string;
  accountId?: string;
  email?: string;
  createdAt: number;
  expiresAt: number;
  /** Set once we have the pi-ai Promise; awaited by /complete. */
  loginPromise?: Promise<OAuthCredentials>;
  /** Resolves with the manual-pasted code/URL when /complete is called. */
  resolveManualCode?: (codeOrUrl: string) => void;
  /** Rejects the manual code promise (used by /cancel). */
  rejectManualCode?: (err: Error) => void;
}

// Module-level Map intentional: HTTP handler is stateless across
// requests but the in-flight pi-ai login Promise needs to live somewhere
// the next request can find it. Cleared by sweepExpiredSessions on each
// touch + via setInterval.
const sessions = new Map<string, CodexAuthSession>();

function nowMs(): number {
  return Date.now();
}

function sweepExpiredSessions(): void {
  const now = nowMs();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now && session.status !== "connected") {
      if (session.status === "awaiting_code" || session.status === "starting") {
        session.status = "expired";
        session.error = "Session timed out — start a new sign-in flow.";
        // Reject the parked manual-code Promise so the background
        // loginOpenAICodex() call settles instead of leaking.
        try {
          session.rejectManualCode?.(new Error("session expired"));
        } catch {
          // ignore
        }
      }
      // Keep "connected" / "error" rows around briefly so the UI can
      // read the final state before a refresh discards them.
      if (now - session.expiresAt > 5 * 60 * 1000) {
        sessions.delete(id);
      }
    }
  }
}

// Periodic sweep so a user who closes the tab mid-flow doesn't leak
// a dangling pi-ai Promise. Tick is loose — actual expiry is enforced
// per request too.
const sweepTimer = setInterval(sweepExpiredSessions, 60_000);
sweepTimer.unref?.();

function generateSessionId(): string {
  return randomBytes(16).toString("hex");
}

function buildPublicSessionView(session: CodexAuthSession) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    authUrl: session.authUrl,
    error: session.error,
    progress: session.progress,
    profileId: session.profileId,
    accountId: session.accountId,
    email: session.email,
    expiresAt: session.expiresAt,
  };
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  return await new Promise<T | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const max = 64 * 1024;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        if (!text) {
          resolve(null);
          return;
        }
        resolve(JSON.parse(text) as T);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Build the profile id we'll persist under. Stable across re-auths for
 * the same provider so `refreshOAuthTokenWithLock` keeps finding the
 * same row. Multi-account ChatGPT support could namespace by accountId;
 * for now one profile per VM is the right shape (1 customer ⇒ 1 VM ⇒
 * 1 ChatGPT account).
 */
function buildCodexProfileId(): string {
  return "openai-codex:primary";
}

/**
 * After successful OAuth, flip the codex plugin on in openclaw.json
 * and set every agent's primary model to a codex route. This is what
 * makes the OAuth actually do something — without it the credential
 * just sits in auth-profiles.json with no inference traffic routed
 * through it. We keep the existing fallback intact (typically the
 * router / pandabots-default) so a transient codex outage doesn't
 * silence the agents.
 */
async function activateCodexInConfig(): Promise<void> {
  try {
    await mutateConfigFile({
      mutate: (draft) => {
        const next = draft as any;
        // Enable the codex plugin entry. Both `plugins.entries.<id>`
        // and the legacy `plugins.allow` list are touched so activation
        // works regardless of which surface the deployment is on.
        next.plugins = next.plugins ?? {};
        next.plugins.entries = next.plugins.entries ?? {};
        next.plugins.entries.codex = {
          ...(next.plugins.entries.codex ?? {}),
          enabled: true,
        };
        // Switch every agent's primary model to a codex route. We pick
        // gpt-5.5 (current Codex default in OpenClaw's plugin model
        // catalog); fallback chain unchanged so router still backstops.
        const codexPrimary = "openai-codex/gpt-5.5";
        const agents = next.agents ?? {};
        if (agents && typeof agents === "object") {
          if (agents.defaults && typeof agents.defaults === "object") {
            agents.defaults.model = agents.defaults.model ?? {};
            agents.defaults.model.primary = codexPrimary;
          }
          if (Array.isArray(agents.list)) {
            agents.list = agents.list.map((a: any) => {
              if (!a || typeof a !== "object") return a;
              const model = a.model ?? {};
              return { ...a, model: { ...model, primary: codexPrimary } };
            });
          }
        }
        next.agents = agents;
      },
    });
  } catch (err) {
    // Activation is best-effort — the credential is already persisted,
    // so the customer can still use it via /agents config edits if
    // this step throws. We surface the error in the session state so
    // the UI can warn the user.
    throw new Error(
      `Auth succeeded but config activation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

async function handleStart(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sweepExpiredSessions();
  ensureGlobalUndiciEnvProxyDispatcher();

  const session: CodexAuthSession = {
    sessionId: generateSessionId(),
    status: "starting",
    createdAt: nowMs(),
    expiresAt: nowMs() + SESSION_TTL_MS,
  };

  // Build the manual-code Promise the pi-ai login() call will await.
  const manualCodePromise = new Promise<string>((resolve, reject) => {
    session.resolveManualCode = resolve;
    session.rejectManualCode = reject;
  });

  // Kick off the OAuth flow in the background. Critically we do NOT
  // `await` this here — we want to return the authUrl to the caller
  // as soon as `onAuth` fires, then let pi-ai sit on
  // manualCodePromise until /complete arrives.
  session.loginPromise = (async () => {
    try {
      const creds = await loginOpenAICodex({
        onAuth: (info) => {
          session.authUrl = info.url;
          session.status = "awaiting_code";
        },
        // onPrompt is the secondary fallback path some flows use to
        // request a manual paste. Surface the same promise so either
        // wakeup completes the flow.
        onPrompt: () => manualCodePromise,
        onManualCodeInput: () => manualCodePromise,
        onProgress: (msg: string) => {
          session.progress = msg;
        },
      });
      return creds;
    } catch (err) {
      session.status = "error";
      session.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  })();

  // Wait briefly for `onAuth` to populate session.authUrl. pi-ai is
  // synchronous-ish here — it generates the PKCE challenge + URL
  // before any network roundtrip — but we still poll to keep the
  // response handler simple.
  const deadline = nowMs() + AUTH_URL_WAIT_MS;
  while (!session.authUrl && session.status === "starting" && nowMs() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (!session.authUrl) {
    // pi-ai never fired onAuth — treat as error so the UI can surface
    // a useful message instead of an empty modal.
    session.status = "error";
    session.error = "OAuth flow did not produce an authorization URL within 8s.";
    sessions.set(session.sessionId, session);
    sendJson(res, 500, {
      ok: false,
      sessionId: session.sessionId,
      error: session.error,
    });
    return;
  }

  sessions.set(session.sessionId, session);
  sendJson(res, 200, {
    ok: true,
    sessionId: session.sessionId,
    authUrl: session.authUrl,
    expiresAt: session.expiresAt,
  });
}

async function handleStatus(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  sweepExpiredSessions();
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    sendInvalidRequest(res, "Missing sessionId query parameter");
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: "Unknown sessionId" });
    return;
  }
  sendJson(res, 200, { ok: true, session: buildPublicSessionView(session) });
}

async function handleComplete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  sweepExpiredSessions();
  const body = await readJsonBody<{ sessionId?: unknown; code?: unknown }>(req);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!sessionId || !code) {
    sendInvalidRequest(res, "Both sessionId and code are required");
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: "Unknown sessionId" });
    return;
  }
  if (session.status !== "awaiting_code") {
    sendJson(res, 409, {
      ok: false,
      error: `Session is in state '${session.status}', not awaiting_code`,
    });
    return;
  }

  session.status = "completing";
  // Resolve the manual-code promise — pi-ai's login() will now finish
  // the token exchange and return creds via session.loginPromise.
  session.resolveManualCode?.(code);

  try {
    if (!session.loginPromise) {
      throw new Error("Login promise missing");
    }
    const creds = await session.loginPromise;
    const profileId = buildCodexProfileId();
    const credential = {
      type: "oauth" as const,
      provider: "openai-codex",
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      email: creds.email,
      accountId: creds.accountId,
      projectId: creds.projectId,
      enterpriseUrl: creds.enterpriseUrl,
    };

    // Fan out the credential to every agent's auth-profiles.json. The
    // auth store is per-agent on disk (~/.openclaw/agents/<id>/agent/
    // auth-profiles.json) — there's no global config-level store that
    // all agents inherit from. Without this fan-out, only `main`'s
    // store would get the OAuth and the other 5 agents would silently
    // fall back to the router (the deployment-level DEFAULT_MODEL),
    // wasting the customer's ChatGPT subscription.
    //
    // The same refresh machinery (refreshOAuthTokenWithLock at
    // auth-profiles/oauth.ts:158) runs per-agent on each call, so each
    // copy of the credential rotates independently when its expiry
    // hits. The refresh tokens are minted from the same OAuth flow
    // and remain valid in parallel — pi-ai's openai-codex provider
    // allows multiple concurrent refreshers for the same identity.
    const cfg = loadConfig();
    const agentIds = listAgentIds(cfg);
    const fanOutResults: Array<{ agentId: string; ok: boolean; error?: string }> = [];
    for (const agentId of agentIds) {
      const agentDir = resolveAgentDir(cfg, agentId);
      try {
        await upsertAuthProfileWithLock({
          profileId,
          credential,
          agentDir,
        });
        fanOutResults.push({ agentId, ok: true });
      } catch (err) {
        fanOutResults.push({
          agentId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const fanOutFailures = fanOutResults.filter((r) => !r.ok);
    if (fanOutFailures.length > 0 && fanOutFailures.length === agentIds.length) {
      // All writes failed — surface as a hard error so the UI doesn't
      // claim "connected" when nothing was persisted.
      throw new Error(
        `Failed to persist credential to any agent's auth store: ${fanOutFailures.map((f) => `${f.agentId}: ${f.error}`).join("; ")}`,
      );
    }

    session.profileId = profileId;
    session.accountId = creds.accountId;
    session.email = creds.email;
    if (fanOutFailures.length > 0) {
      // Partial success — keep state "connected" but record the warning
      // so the UI can surface "connected, but some agents may need a
      // restart". Common cause: an agent dir not yet provisioned on
      // first-boot when OAuth is connected very early.
      session.error = `Connected, but couldn't write to ${fanOutFailures.length}/${agentIds.length} agent stores: ${fanOutFailures.map((f) => f.agentId).join(", ")}`;
    }

    // Flip the codex plugin on + retarget every agent's primary model.
    // If this throws we still flip status to connected (the credential
    // is good) but surface the error so the UI can show a "connected
    // but model not auto-switched" warning.
    try {
      await activateCodexInConfig();
    } catch (activationErr) {
      session.error =
        activationErr instanceof Error ? activationErr.message : String(activationErr);
    }

    session.status = "connected";
    sendJson(res, 200, { ok: true, session: buildPublicSessionView(session) });
  } catch (err) {
    session.status = "error";
    session.error = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { ok: false, error: session.error });
  }
}

/**
 * Reverse `activateCodexInConfig`: pull codex out of the agent model
 * primaries, drop the codex plugin entry. Defensive — if the customer
 * was on a custom model before connecting, we don't know what to put
 * back. Reset to `router/auto` (the pandabots-default fallback) which
 * matches what convex/deployments.ts's updateDeploymentModel emits for
 * `mode: "pandabots-default"`. The customer can re-pick BYOM after.
 */
async function deactivateCodexInConfig(): Promise<void> {
  try {
    await mutateConfigFile({
      mutate: (draft) => {
        const next = draft as any;
        // Remove codex plugin entry if present (no-op if not).
        if (next.plugins?.entries?.codex) {
          delete next.plugins.entries.codex;
        }
        // Reset every agent's primary model back to the default
        // router route. Heartbeats/fallback chain remains untouched.
        const fallbackPrimary = "router/auto";
        const agents = next.agents ?? {};
        if (agents && typeof agents === "object") {
          if (agents.defaults && typeof agents.defaults === "object") {
            agents.defaults.model = agents.defaults.model ?? {};
            agents.defaults.model.primary = fallbackPrimary;
          }
          if (Array.isArray(agents.list)) {
            agents.list = agents.list.map((a: any) => {
              if (!a || typeof a !== "object") return a;
              const model = a.model ?? {};
              return { ...a, model: { ...model, primary: fallbackPrimary } };
            });
          }
        }
        next.agents = agents;
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to reset model config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Disconnect ChatGPT — removes the OAuth profile from every agent's
 * auth-profiles.json, drops the codex plugin entry, resets every
 * agent's model.primary back to router/auto.
 *
 * Idempotent: calling on a not-connected VM is a no-op (returns
 * { removed: 0 }).
 */
async function handleLogout(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = loadConfig();
  const agentIds = listAgentIds(cfg);
  const profileId = buildCodexProfileId();
  let removed = 0;
  let kept = 0;
  const errors: Array<{ agentId: string; error: string }> = [];

  for (const agentId of agentIds) {
    const agentDir = resolveAgentDir(cfg, agentId);
    try {
      const result = await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          if (store.profiles?.[profileId]) {
            delete store.profiles[profileId];
            // Also clean up any provider-order entry that referenced
            // this profile, so the next openai-codex lookup doesn't
            // resolve a stale id.
            if (store.order && Array.isArray(store.order["openai-codex"])) {
              store.order["openai-codex"] = store.order["openai-codex"].filter(
                (id: string) => id !== profileId,
              );
              if (store.order["openai-codex"].length === 0) {
                delete store.order["openai-codex"];
              }
            }
            return true;
          }
          return false;
        },
      });
      if (result) {
        removed++;
      } else {
        kept++;
      }
    } catch (err) {
      errors.push({
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Reset model config so future agent runs go back to the router. If
  // any of the agent-store removals failed we still try this — the
  // config reset is independent of the auth-store cleanup and useful
  // even on partial success.
  let configError: string | null = null;
  try {
    await deactivateCodexInConfig();
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }

  sendJson(res, 200, {
    ok: errors.length === 0 && !configError,
    removed,
    kept,
    errors,
    configError,
  });
}

async function handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ sessionId?: unknown }>(req);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    sendInvalidRequest(res, "Missing sessionId");
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: "Unknown sessionId" });
    return;
  }
  if (session.status === "awaiting_code" || session.status === "starting") {
    session.status = "error";
    session.error = "Cancelled by user.";
    try {
      session.rejectManualCode?.(new Error("cancelled"));
    } catch {
      // ignore
    }
  }
  sessions.delete(sessionId);
  sendJson(res, 200, { ok: true });
}

// ── Router entry — invoked from mc-api-http.ts after MC auth gate ──

/**
 * Returns true iff the request was handled here. Lets the parent
 * dispatcher fall through to other /mc/v1/* sub-routes when this
 * is not a codex auth path.
 */
export async function tryHandleCodexAuthRoute(
  subPath: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (subPath === "/codex/auth/start" && req.method === "POST") {
    await handleStart(req, res);
    return true;
  }
  if (subPath === "/codex/auth/status" && req.method === "GET") {
    await handleStatus(req, res, url);
    return true;
  }
  if (subPath === "/codex/auth/complete" && req.method === "POST") {
    await handleComplete(req, res);
    return true;
  }
  if (subPath === "/codex/auth/cancel" && req.method === "POST") {
    await handleCancel(req, res);
    return true;
  }
  if (subPath === "/codex/auth/logout" && req.method === "POST") {
    await handleLogout(req, res);
    return true;
  }
  return false;
}
