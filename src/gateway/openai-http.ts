import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import { sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  messages?: unknown;
  user?: unknown;
};

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildAgentCommandInput(params: {
  prompt: {
    message: string;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    extraSystemPrompt?: string;
  };
  sessionKey: string;
  runId: string;
}) {
  return {
    message: params.prompt.message,
    images: params.prompt.images,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: "webchat" as const,
    bestEffortDeliver: false as const,
  };
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" } }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

type ExtractedContent = {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
};

function extractContent(content: unknown): ExtractedContent {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const images: ExtractedContent["images"] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      const inputText = (part as { input_text?: unknown }).input_text;
      if (type === "text" && typeof text === "string") {
        textParts.push(text);
      } else if (type === "input_text" && typeof text === "string") {
        textParts.push(text);
      } else if (typeof inputText === "string") {
        textParts.push(inputText);
      } else if (type === "image_url") {
        // OpenAI format: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
        const imageUrl = (part as { image_url?: { url?: unknown } }).image_url;
        const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
        if (url.startsWith("data:")) {
          const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (match) {
            images.push({ type: "image", mimeType: match[1], data: match[2] });
          }
        }
      }
    }
    return { text: textParts.filter(Boolean).join("\n"), images };
  }
  return { text: "", images: [] };
}

function buildAgentPrompt(messagesUnknown: unknown): {
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];
  // Collect images from the last user message only (avoid re-sending old images).
  let lastUserImages: Array<{ type: "image"; data: string; mimeType: string }> = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = typeof msg.role === "string" ? msg.role.trim() : "";
    const extracted = extractContent(msg.content);
    const content = extracted.text.trim();
    if (!role || (!content && extracted.images.length === 0)) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }

    // Track images from user messages; we only pass images from the current (last) user message.
    if (normalizedRole === "user" && extracted.images.length > 0) {
      lastUserImages = extracted.images;
    }

    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : name
            ? `Tool:${name}`
            : "Tool";

    if (content) {
      conversationEntries.push({
        role: normalizedRole,
        entry: { sender, body: content },
      });
    }
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    images: lastUserImages.length > 0 ? lastUserImages : undefined,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenAiSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openai" });
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? 20 * 1024 * 1024,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;

  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenAiSessionKey({ req, agentId, user });
  const prompt = buildAgentPrompt(payload.messages);
  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();
  const commandInput = buildAgentCommandInput({
    prompt,
    sessionKey,
    runId,
  });

  if (!stream) {
    try {
      const result = await agentCommand(commandInput, defaultRuntime, deps);

      const content = resolveAgentResponseText(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let sawAssistantDelta = false;
  let closed = false;
  const toolStartTimes = new Map<string, number>();

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    // Forward tool events as x_tool_event fields in SSE chunks so the
    // HQ frontend can render tool call pills and connect buttons.
    if (evt.stream === "tool") {
      const phase = evt.data?.phase as string | undefined;
      const name = typeof evt.data?.name === "string" ? evt.data.name : undefined;
      const tcId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : undefined;
      if (phase === "start" && tcId) {
        toolStartTimes.set(tcId, evt.ts);
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          x_tool_event: {
            phase: "start",
            name,
            toolCallId: tcId,
            args: evt.data?.args || {},
            ts: evt.ts,
          },
        });
      } else if (phase === "result" && tcId) {
        const startTs = toolStartTimes.get(tcId);
        const duration = startTs ? evt.ts - startTs : undefined;
        toolStartTimes.delete(tcId);
        writeSse(res, {
          id: runId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          x_tool_event: {
            phase: "result",
            name,
            toolCallId: tcId,
            result:
              typeof evt.data?.result === "string"
                ? evt.data.result
                : JSON.stringify(evt.data?.result || ""),
            isError: Boolean(evt.data?.isError),
            duration,
            ts: evt.ts,
          },
        });
      }
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommand(commandInput, defaultRuntime, deps);

      if (closed) {
        return;
      }

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
    } catch (err) {
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      if (closed) {
        return;
      }
      writeAssistantContentChunk(res, {
        runId,
        model,
        content: "Error: internal error",
        finishReason: "stop",
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        closed = true;
        unsubscribe();
        writeDone(res);
        res.end();
      }
    }
  })();

  return true;
}
