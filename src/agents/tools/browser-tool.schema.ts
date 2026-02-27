import { Type } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";

const BROWSER_TOOL_ACTIONS = [
  "open",
  "close",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "type",
  "press",
  "hover",
  "select",
  "drag",
  "scroll",
  "wait",
  "tab",
  "navigate",
  "console",
  "pdf",
  "upload",
  "dialog",
  "eval",
  "get",
] as const;

// NOTE: Keep this as a flat Type.Object — no Type.Union / anyOf.
// See google-antigravity guardrails in CLAUDE.md.
export const BrowserToolSchema = Type.Object({
  action: stringEnum(BROWSER_TOOL_ACTIONS),
  // URL for open / navigate
  url: Type.Optional(Type.String()),
  // Element ref from snapshot (e.g. "e12") for click/fill/hover/type/select/drag/scroll/wait
  ref: Type.Optional(Type.String()),
  // Text for fill / type
  text: Type.Optional(Type.String()),
  // Key combo for press (e.g. "Enter", "Control+A")
  key: Type.Optional(Type.String()),
  // Named session for isolation
  session: Type.Optional(Type.String()),
  // CSS selector (wait, screenshot)
  selector: Type.Optional(Type.String()),
  // Full-page screenshot
  fullPage: Type.Optional(Type.Boolean()),
  // Dialog accept/dismiss
  accept: Type.Optional(Type.Boolean()),
  // Dialog prompt text
  promptText: Type.Optional(Type.String()),
  // Tab sub-command: list | new | close | <index>
  tabAction: Type.Optional(Type.String()),
  // Scroll direction
  direction: Type.Optional(Type.String()),
  // Scroll amount in pixels
  amount: Type.Optional(Type.Number()),
  // Drag target ref
  startRef: Type.Optional(Type.String()),
  endRef: Type.Optional(Type.String()),
  // Select option values
  values: Type.Optional(Type.Array(Type.String())),
  // Wait: time in ms
  timeMs: Type.Optional(Type.Number()),
  // Wait: text to appear
  waitText: Type.Optional(Type.String()),
  // JavaScript expression for eval
  expression: Type.Optional(Type.String()),
  // File paths for upload
  paths: Type.Optional(Type.Array(Type.String())),
  // PDF output path
  outputPath: Type.Optional(Type.String()),
  // Console log level filter
  level: Type.Optional(Type.String()),
  // Get sub-command: url | title | text | innerText | attribute
  property: Type.Optional(Type.String()),
});
