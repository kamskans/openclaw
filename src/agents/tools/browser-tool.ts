import { execFile, execFileSync } from "node:child_process";
import { loadConfig } from "../../config/config.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cachedBinaryPath: string | undefined;

/** Locate agent-browser in PATH. Caches result. */
function ensureAgentBrowser(): string {
  if (cachedBinaryPath) return cachedBinaryPath;
  try {
    cachedBinaryPath = execFileSync("which", ["agent-browser"], { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "agent-browser is not installed. Run: npm install -g agent-browser && agent-browser install",
    );
  }
  return cachedBinaryPath;
}

const DEFAULT_TIMEOUT_MS = 30_000;

type ExecResult = { stdout: string; stderr: string; exitCode: number };

/** Execute agent-browser CLI with given args. */
function execAgentBrowser(
  args: string[],
  opts?: { timeoutMs?: number; session?: string },
): Promise<ExecResult> {
  const bin = ensureAgentBrowser();
  const fullArgs = opts?.session ? ["--session", opts.session, ...args] : args;
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      fullArgs,
      {
        timeout,
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).killed) {
          reject(new Error(`agent-browser timed out after ${timeout}ms`));
          return;
        }
        // Non-zero exit is still resolved so callers can inspect output
        const exitCode = error?.code ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );
  });
}

/** Parse CLI output — try JSON, fall back to plain text. */
function wrapCliResult(result: ExecResult) {
  const text = result.stdout.trim();
  if (result.exitCode !== 0) {
    const errText = result.stderr.trim() || text;
    throw new Error(`agent-browser failed (exit ${result.exitCode}): ${errText}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { output: text };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBrowserTool(opts?: { defaultSession?: string }): AnyAgentTool {
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control a browser via agent-browser CLI.",
      "Actions: open, close, snapshot, screenshot, click, fill, type, press, hover, select, drag, scroll, wait, tab, navigate, console, pdf, upload, dialog, eval, get.",
      "Use snapshot to get an AI-optimized accessibility tree (~200-400 tokens). Use refs from the snapshot (e.g. e12) with click/fill/hover etc.",
      "Chromium is auto-managed by agent-browser (no manual setup needed).",
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const session = readStringParam(params, "session") ?? opts?.defaultSession;
      const execOpts = { session };

      switch (action) {
        // ---- Navigation ----
        case "open": {
          const url = readStringParam(params, "url", { required: true });
          const result = await execAgentBrowser(["open", url], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "navigate": {
          const url = readStringParam(params, "url", { required: true });
          const result = await execAgentBrowser(["goto", url], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "close": {
          const result = await execAgentBrowser(["close"], execOpts);
          return jsonResult(wrapCliResult(result));
        }

        // ---- Observation ----
        case "snapshot": {
          const result = await execAgentBrowser(["snapshot", "-i"], execOpts);
          const text = result.stdout.trim();
          if (result.exitCode !== 0) {
            throw new Error(`agent-browser snapshot failed: ${result.stderr.trim() || text}`);
          }
          return {
            content: [{ type: "text", text }],
            details: { snapshot: text },
          };
        }
        case "screenshot": {
          const cliArgs = ["screenshot"];
          if (params.fullPage) cliArgs.push("--full-page");
          const result = await execAgentBrowser(cliArgs, execOpts);
          if (result.exitCode !== 0) {
            throw new Error(
              `agent-browser screenshot failed: ${result.stderr.trim() || result.stdout.trim()}`,
            );
          }
          // agent-browser prints the screenshot path to stdout
          const screenshotPath = result.stdout.trim();
          return await imageResultFromFile({
            label: "browser:screenshot",
            path: screenshotPath,
          });
        }
        case "console": {
          const cliArgs = ["console"];
          const level = readStringParam(params, "level");
          if (level) cliArgs.push("--level", level);
          const result = await execAgentBrowser(cliArgs, execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "get": {
          const property = readStringParam(params, "property", { required: true });
          const result = await execAgentBrowser(["get", property], execOpts);
          return jsonResult(wrapCliResult(result));
        }

        // ---- Interaction ----
        case "click": {
          const ref = readStringParam(params, "ref", { required: true });
          const result = await execAgentBrowser(["click", ref], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "fill": {
          const ref = readStringParam(params, "ref", { required: true });
          const text = readStringParam(params, "text", { required: true });
          const result = await execAgentBrowser(["fill", ref, text], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "type": {
          const ref = readStringParam(params, "ref");
          const text = readStringParam(params, "text", { required: true });
          const cliArgs = ref ? ["type", ref, text] : ["type", text];
          const result = await execAgentBrowser(cliArgs, execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "press": {
          const key = readStringParam(params, "key", { required: true });
          const result = await execAgentBrowser(["press", key], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "hover": {
          const ref = readStringParam(params, "ref", { required: true });
          const result = await execAgentBrowser(["hover", ref], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "select": {
          const ref = readStringParam(params, "ref", { required: true });
          const values = Array.isArray(params.values) ? params.values.map((v) => String(v)) : [];
          if (values.length === 0) throw new Error("values required for select");
          const result = await execAgentBrowser(["select", ref, ...values], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "drag": {
          const startRef = readStringParam(params, "startRef", { required: true });
          const endRef = readStringParam(params, "endRef", { required: true });
          const result = await execAgentBrowser(["drag", startRef, endRef], execOpts);
          return jsonResult(wrapCliResult(result));
        }
        case "scroll": {
          const cliArgs = ["scroll"];
          const direction = readStringParam(params, "direction");
          if (direction) cliArgs.push(direction);
          const amount =
            typeof params.amount === "number" && Number.isFinite(params.amount)
              ? params.amount
              : undefined;
          if (amount !== undefined) cliArgs.push(String(amount));
          const ref = readStringParam(params, "ref");
          if (ref) cliArgs.push("--ref", ref);
          const result = await execAgentBrowser(cliArgs, execOpts);
          return jsonResult(wrapCliResult(result));
        }

        // ---- Wait ----
        case "wait": {
          const cliArgs = ["wait"];
          const ref = readStringParam(params, "ref");
          const waitText = readStringParam(params, "waitText");
          const timeMs =
            typeof params.timeMs === "number" && Number.isFinite(params.timeMs)
              ? params.timeMs
              : undefined;
          if (ref) {
            cliArgs.push(ref);
          } else if (waitText) {
            cliArgs.push("--text", waitText);
          } else if (timeMs !== undefined) {
            cliArgs.push("--ms", String(timeMs));
          }
          const result = await execAgentBrowser(cliArgs, {
            ...execOpts,
            timeoutMs: (timeMs ?? 0) + DEFAULT_TIMEOUT_MS,
          });
          return jsonResult(wrapCliResult(result));
        }

        // ---- Tabs ----
        case "tab": {
          const tabAction = readStringParam(params, "tabAction") ?? "list";
          const result = await execAgentBrowser(["tab", tabAction], execOpts);
          return jsonResult(wrapCliResult(result));
        }

        // ---- Files ----
        case "pdf": {
          const cliArgs = ["pdf"];
          const outputPath = readStringParam(params, "outputPath");
          if (outputPath) cliArgs.push(outputPath);
          const result = await execAgentBrowser(cliArgs, execOpts);
          const path = result.stdout.trim();
          if (result.exitCode !== 0) {
            throw new Error(`agent-browser pdf failed: ${result.stderr.trim() || path}`);
          }
          return {
            content: [{ type: "text", text: `FILE:${path}` }],
            details: { path },
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) throw new Error("paths required");
          const ref = readStringParam(params, "ref");
          const cliArgs = ["upload", ...paths];
          if (ref) cliArgs.push("--ref", ref);
          const result = await execAgentBrowser(cliArgs, execOpts);
          return jsonResult(wrapCliResult(result));
        }

        // ---- Dialog ----
        case "dialog": {
          const accept = params.accept !== false;
          const sub = accept ? "accept" : "dismiss";
          const cliArgs = ["dialog", sub];
          const promptText = readStringParam(params, "promptText");
          if (promptText) cliArgs.push("--text", promptText);
          const result = await execAgentBrowser(cliArgs, execOpts);
          return jsonResult(wrapCliResult(result));
        }

        // ---- Eval ----
        case "eval": {
          const cfg = loadConfig();
          if (cfg.browser?.evaluateEnabled === false) {
            throw new Error(
              "browser evaluate is disabled (browser.evaluateEnabled=false in config).",
            );
          }
          const expression = readStringParam(params, "expression", { required: true });
          const result = await execAgentBrowser(["eval", expression], execOpts);
          return jsonResult(wrapCliResult(result));
        }

        default:
          throw new Error(`Unknown browser action: ${action}`);
      }
    },
  };
}
