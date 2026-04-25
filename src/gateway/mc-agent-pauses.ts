/**
 * Mission Control: per-agent pause state.
 *
 * Stored at ~/.openclaw/agent-pauses.json as { "paused": ["agentId", ...] }.
 * The VM is the source of truth; Convex calls into the gateway to read/set
 * this state and gates outbound dispatch on it. The cron engine doesn't
 * need a fork-level change because the pause workflow uses the existing
 * `enabled` field on cron jobs — when an agent is paused we mark each of
 * its jobs `enabled: false` (with a `state.pausedByAgentPause` marker so
 * unpause only re-enables what we paused).
 *
 * The gate that matters for new one-shot dispatches (notifyAgent from
 * Convex) lives in handlePostCron in mc-api-http.ts: if the target
 * agent is paused, the POST is short-circuited and no cron is created.
 */

import fsPromises from "node:fs/promises";
import path from "node:path";

const PAUSES_FILE = path.join(
  process.env.OPENCLAW_STATE_DIR || `${process.env.HOME || "/root"}/.openclaw`,
  "agent-pauses.json",
);

type PausesFile = { paused: string[] };

let cache: { mtimeMs: number; set: Set<string> } | null = null;

async function readFromDisk(): Promise<{ mtimeMs: number; set: Set<string> }> {
  try {
    const stat = await fsPromises.stat(PAUSES_FILE);
    const raw = await fsPromises.readFile(PAUSES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PausesFile;
    const set = new Set<string>(
      Array.isArray(parsed?.paused) ? parsed.paused.filter((a) => typeof a === "string") : [],
    );
    return { mtimeMs: stat.mtimeMs, set };
  } catch {
    // Missing file or unreadable → treat as empty.
    return { mtimeMs: 0, set: new Set() };
  }
}

async function loadCached(): Promise<Set<string>> {
  try {
    const stat = await fsPromises.stat(PAUSES_FILE).catch(() => null);
    const mtimeMs = stat?.mtimeMs ?? 0;
    if (cache && cache.mtimeMs === mtimeMs) {
      return cache.set;
    }
    const fresh = await readFromDisk();
    cache = fresh;
    return fresh.set;
  } catch {
    return new Set();
  }
}

export async function isAgentPaused(agentId: string): Promise<boolean> {
  const id = (agentId || "").trim();
  if (!id) return false;
  const set = await loadCached();
  return set.has(id);
}

export async function listPausedAgents(): Promise<string[]> {
  const set = await loadCached();
  return Array.from(set).sort();
}

export async function setAgentPause(agentId: string, paused: boolean): Promise<void> {
  const id = (agentId || "").trim();
  if (!id) throw new Error("setAgentPause: agentId required");

  const set = new Set(await loadCached());
  if (paused) set.add(id);
  else set.delete(id);

  const dir = path.dirname(PAUSES_FILE);
  await fsPromises.mkdir(dir, { recursive: true });

  const tmp = `${PAUSES_FILE}.tmp`;
  await fsPromises.writeFile(
    tmp,
    JSON.stringify({ paused: Array.from(set).sort() }, null, 2),
    "utf-8",
  );
  await fsPromises.rename(tmp, PAUSES_FILE);

  // Bust cache by clearing — next read re-stats and reloads.
  cache = null;
}
