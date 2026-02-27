import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process — must use vi.hoisted so the factory can reference it
const cpMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => "/usr/local/bin/agent-browser\n"),
}));
vi.mock("node:child_process", () => cpMocks);
const execFileMock = cpMocks.execFile;

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("../../config/config.js", () => configMocks);

const toolCommonMocks = vi.hoisted(() => ({
  imageResultFromFile: vi.fn(async () => ({
    content: [
      { type: "text", text: "MEDIA:/tmp/screenshot.png" },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ],
    details: { path: "/tmp/screenshot.png" },
  })),
}));
vi.mock("./common.js", async () => {
  const actual = await vi.importActual<typeof import("./common.js")>("./common.js");
  return {
    ...actual,
    imageResultFromFile: toolCommonMocks.imageResultFromFile,
  };
});

import { createBrowserTool } from "./browser-tool.js";

/** Helper: make execFileMock call its callback with given stdout/stderr/error */
function mockExecResult(stdout: string, stderr = "", error: Error | null = null) {
  execFileMock.mockImplementation(
    (
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(error, stdout, stderr);
    },
  );
}

/** Helper: extract args from last execFile call (skip binary path) */
function lastCliArgs(): string[] {
  const [, args] = execFileMock.mock.calls.at(-1) ?? [];
  return args ?? [];
}

/** Helper: extract env from last execFile call */
function lastCliEnv(): Record<string, string> {
  const [, , opts] = execFileMock.mock.calls.at(-1) ?? [];
  return opts?.env ?? {};
}

describe("browser tool — action routing", () => {
  beforeEach(() => {
    mockExecResult('{"ok":true}');
  });
  afterEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockReturnValue({ browser: {} });
  });

  it("open → agent-browser open <url>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "open", url: "https://example.com" });
    expect(lastCliArgs()).toEqual(["open", "https://example.com"]);
  });

  it("navigate → agent-browser goto <url>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "navigate", url: "https://example.com" });
    expect(lastCliArgs()).toEqual(["goto", "https://example.com"]);
  });

  it("close → agent-browser close", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "close" });
    expect(lastCliArgs()).toEqual(["close"]);
  });

  it("click → agent-browser click <ref>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "click", ref: "e12" });
    expect(lastCliArgs()).toEqual(["click", "e12"]);
  });

  it("fill → agent-browser fill <ref> <text>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "fill", ref: "e5", text: "hello" });
    expect(lastCliArgs()).toEqual(["fill", "e5", "hello"]);
  });

  it("type with ref → agent-browser type <ref> <text>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "type", ref: "e3", text: "world" });
    expect(lastCliArgs()).toEqual(["type", "e3", "world"]);
  });

  it("type without ref → agent-browser type <text>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "type", text: "just typing" });
    expect(lastCliArgs()).toEqual(["type", "just typing"]);
  });

  it("press → agent-browser press <key>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "press", key: "Enter" });
    expect(lastCliArgs()).toEqual(["press", "Enter"]);
  });

  it("hover → agent-browser hover <ref>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "hover", ref: "e7" });
    expect(lastCliArgs()).toEqual(["hover", "e7"]);
  });

  it("select → agent-browser select <ref> <values>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "select", ref: "e2", values: ["opt1", "opt2"] });
    expect(lastCliArgs()).toEqual(["select", "e2", "opt1", "opt2"]);
  });

  it("drag → agent-browser drag <startRef> <endRef>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "drag", startRef: "e1", endRef: "e9" });
    expect(lastCliArgs()).toEqual(["drag", "e1", "e9"]);
  });

  it("scroll with direction → agent-browser scroll <direction>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "scroll", direction: "down", amount: 300 });
    expect(lastCliArgs()).toEqual(["scroll", "down", "300"]);
  });

  it("scroll with ref → agent-browser scroll --ref <ref>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "scroll", direction: "up", ref: "e4" });
    expect(lastCliArgs()).toEqual(["scroll", "up", "--ref", "e4"]);
  });

  it("wait with ref → agent-browser wait <ref>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "wait", ref: "e10" });
    expect(lastCliArgs()).toEqual(["wait", "e10"]);
  });

  it("wait with text → agent-browser wait --text <text>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "wait", waitText: "Loading complete" });
    expect(lastCliArgs()).toEqual(["wait", "--text", "Loading complete"]);
  });

  it("wait with ms → agent-browser wait --ms <ms>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "wait", timeMs: 2000 });
    expect(lastCliArgs()).toEqual(["wait", "--ms", "2000"]);
  });

  it("tab list → agent-browser tab list", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "tab" });
    expect(lastCliArgs()).toEqual(["tab", "list"]);
  });

  it("tab new → agent-browser tab new", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "tab", tabAction: "new" });
    expect(lastCliArgs()).toEqual(["tab", "new"]);
  });

  it("console → agent-browser console", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "console" });
    expect(lastCliArgs()).toEqual(["console"]);
  });

  it("console with level → agent-browser console --level <level>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "console", level: "error" });
    expect(lastCliArgs()).toEqual(["console", "--level", "error"]);
  });

  it("dialog accept → agent-browser dialog accept", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "dialog", accept: true });
    expect(lastCliArgs()).toEqual(["dialog", "accept"]);
  });

  it("dialog dismiss → agent-browser dialog dismiss", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "dialog", accept: false });
    expect(lastCliArgs()).toEqual(["dialog", "dismiss"]);
  });

  it("dialog with promptText → agent-browser dialog accept --text <text>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "dialog", accept: true, promptText: "yes" });
    expect(lastCliArgs()).toEqual(["dialog", "accept", "--text", "yes"]);
  });

  it("upload → agent-browser upload <paths>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "upload", paths: ["/tmp/a.txt", "/tmp/b.txt"] });
    expect(lastCliArgs()).toEqual(["upload", "/tmp/a.txt", "/tmp/b.txt"]);
  });

  it("upload with ref → agent-browser upload <paths> --ref <ref>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "upload", paths: ["/tmp/f.txt"], ref: "e8" });
    expect(lastCliArgs()).toEqual(["upload", "/tmp/f.txt", "--ref", "e8"]);
  });

  it("get → agent-browser get <property>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "get", property: "url" });
    expect(lastCliArgs()).toEqual(["get", "url"]);
  });

  it("eval → agent-browser eval <expression>", async () => {
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "eval", expression: "document.title" });
    expect(lastCliArgs()).toEqual(["eval", "document.title"]);
  });
});

describe("browser tool — snapshot", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns text content directly from snapshot output", async () => {
    mockExecResult('- page: Example\n  [e1] button "Submit"');
    const tool = createBrowserTool();
    const result = await tool.execute?.(null, { action: "snapshot" });

    expect(lastCliArgs()).toEqual(["snapshot", "-i"]);
    expect(result?.content).toEqual([
      { type: "text", text: '- page: Example\n  [e1] button "Submit"' },
    ]);
  });
});

describe("browser tool — screenshot", () => {
  afterEach(() => vi.clearAllMocks());

  it("parses screenshot path from stdout and calls imageResultFromFile", async () => {
    mockExecResult("/tmp/screenshot.png");
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "screenshot" });

    expect(lastCliArgs()).toEqual(["screenshot"]);
    expect(toolCommonMocks.imageResultFromFile).toHaveBeenCalledWith({
      label: "browser:screenshot",
      path: "/tmp/screenshot.png",
    });
  });

  it("passes --full-page flag when fullPage is true", async () => {
    mockExecResult("/tmp/screenshot.png");
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "screenshot", fullPage: true });

    expect(lastCliArgs()).toEqual(["screenshot", "--full-page"]);
  });
});

describe("browser tool — pdf", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns FILE: path from pdf output", async () => {
    mockExecResult("/tmp/page.pdf");
    const tool = createBrowserTool();
    const result = await tool.execute?.(null, { action: "pdf" });

    expect(lastCliArgs()).toEqual(["pdf"]);
    expect(result?.content).toEqual([{ type: "text", text: "FILE:/tmp/page.pdf" }]);
  });

  it("passes output path when provided", async () => {
    mockExecResult("/custom/output.pdf");
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "pdf", outputPath: "/custom/output.pdf" });

    expect(lastCliArgs()).toEqual(["pdf", "/custom/output.pdf"]);
  });
});

describe("browser tool — session support", () => {
  afterEach(() => vi.clearAllMocks());

  it("prepends --session flag when session is provided", async () => {
    mockExecResult('{"ok":true}');
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "open", url: "https://example.com", session: "s1" });

    expect(lastCliArgs()).toEqual(["--session", "s1", "open", "https://example.com"]);
  });

  it("uses defaultSession from opts", async () => {
    mockExecResult('{"ok":true}');
    const tool = createBrowserTool({ defaultSession: "default" });
    await tool.execute?.(null, { action: "close" });

    expect(lastCliArgs()).toEqual(["--session", "default", "close"]);
  });

  it("per-call session overrides defaultSession", async () => {
    mockExecResult('{"ok":true}');
    const tool = createBrowserTool({ defaultSession: "default" });
    await tool.execute?.(null, { action: "close", session: "override" });

    expect(lastCliArgs()).toEqual(["--session", "override", "close"]);
  });
});

describe("browser tool — error handling", () => {
  afterEach(() => vi.clearAllMocks());

  it("throws when agent-browser is not installed", async () => {
    // Make execFileSync throw to simulate missing binary.
    // Reset modules so the cached binary path is cleared.
    cpMocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    vi.resetModules();
    // Re-apply the mock for the fresh module import
    vi.doMock("node:child_process", () => cpMocks);
    vi.doMock("../../config/config.js", () => configMocks);
    vi.doMock("./common.js", async () => {
      const actual = await vi.importActual<typeof import("./common.js")>("./common.js");
      return { ...actual, imageResultFromFile: toolCommonMocks.imageResultFromFile };
    });
    const freshModule = await import("./browser-tool.js");
    const tool = freshModule.createBrowserTool();
    await expect(tool.execute?.(null, { action: "open", url: "https://x.com" })).rejects.toThrow(
      "agent-browser is not installed",
    );
    // Restore so subsequent tests work
    cpMocks.execFileSync.mockImplementation(() => "/usr/local/bin/agent-browser\n");
  });

  it("throws on non-zero exit code", async () => {
    const err = new Error("exit 1") as Error & { code: number };
    err.code = 1;
    mockExecResult("", "Element not found: e99", err);
    const tool = createBrowserTool();
    await expect(tool.execute?.(null, { action: "click", ref: "e99" })).rejects.toThrow(
      "agent-browser failed (exit 1): Element not found: e99",
    );
  });

  it("throws on timeout", async () => {
    execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const err = new Error("timed out") as Error & { killed: boolean };
        err.killed = true;
        cb(err, "", "");
      },
    );
    const tool = createBrowserTool();
    await expect(tool.execute?.(null, { action: "click", ref: "e1" })).rejects.toThrow(
      "agent-browser timed out",
    );
  });

  it("throws when eval is disabled in config", async () => {
    configMocks.loadConfig.mockReturnValue({ browser: { evaluateEnabled: false } });
    mockExecResult('{"ok":true}');
    const tool = createBrowserTool();
    await expect(tool.execute?.(null, { action: "eval", expression: "1+1" })).rejects.toThrow(
      "browser evaluate is disabled",
    );
  });

  it("throws for unknown action", async () => {
    mockExecResult('{"ok":true}');
    const tool = createBrowserTool();
    await expect(tool.execute?.(null, { action: "bogus" })).rejects.toThrow(
      "Unknown browser action",
    );
  });
});

describe("browser tool — NO_COLOR env", () => {
  afterEach(() => vi.clearAllMocks());

  it("sets NO_COLOR=1 in environment", async () => {
    mockExecResult('{"ok":true}');
    const tool = createBrowserTool();
    await tool.execute?.(null, { action: "open", url: "https://example.com" });
    expect(lastCliEnv().NO_COLOR).toBe("1");
  });
});
