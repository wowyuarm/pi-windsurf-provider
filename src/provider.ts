import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  createUpstreamHeaders,
  decodeConnectBinaryFrames,
  encodeConnectBinaryRequest,
  parseTrailerError,
  readResponseError,
} from "./connect.ts";
import { buildRequestMetadataBytes, discoverApiServerBaseUrl } from "./metadata.ts";
import {
  applyResponseFrame,
  buildGetChatMessageRequest,
  createStreamState,
  failStream,
  finalizeStream,
  getOrCreateConversationId,
  WINDSURF_MODELS,
} from "./transform.ts";

const PROVIDER_NAME = "windsurf";
const PROVIDER_API = "windsurf-upstream";
const DEFAULT_BASE_URL = "https://server.codeium.com";
const DEFAULT_ENDPOINT = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const PLACEHOLDER_API_KEY = "windsurf";

export function registerWindsurfProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: PLACEHOLDER_API_KEY,
    api: PROVIDER_API,
    models: WINDSURF_MODELS,
    streamSimple: streamWindsurf,
  });
}

function streamWindsurf(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const conversationId = getOrCreateConversationId(context.messages);
    const state = createStreamState(model, conversationId);
    stream.push({ type: "start", partial: state.output });

    try {
      const metadataBytes = await buildRequestMetadataBytes(conversationId);
      const requestBytes = buildGetChatMessageRequest(model, context, metadataBytes, conversationId);
      const body = encodeConnectBinaryRequest(requestBytes);
      const url = buildUpstreamUrl();

      debugLog("request", {
        model: model.id,
        url,
        messages: context.messages.length,
        tools: (context.tools ?? []).length,
        tail: summarizeContextTail(context),
      });

      const response = await fetch(url, {
        method: "POST",
        headers: createUpstreamHeaders(),
        body: toArrayBuffer(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      for await (const frame of decodeConnectBinaryFrames(response.body)) {
        const trailerError = parseTrailerError(frame);
        if (trailerError) {
          if (trailerError === "{}") {
            continue;
          }
          throw new Error(trailerError);
        }
        applyResponseFrame(model, frame.payload, state, stream);
      }

      finalizeStream(state, stream);
      stream.end();
    } catch (error) {
      failStream(state, stream, error, options?.signal?.aborted === true);
      stream.end();
    }
  })();

  return stream;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function buildUpstreamUrl(): string {
  const value = process.env.PI_WINDSURF_PROVIDER_URL?.trim();
  if (value) {
    return value;
  }
  const discoveredBaseUrl = discoverApiServerBaseUrl();
  if (discoveredBaseUrl) {
    return `${discoveredBaseUrl}${DEFAULT_ENDPOINT}`;
  }
  return `${DEFAULT_BASE_URL}${DEFAULT_ENDPOINT}`;
}

function summarizeContextTail(context: Context): unknown[] {
  return context.messages.slice(-4).map((message) => {
    if (message.role === "user") {
      return { role: "user", content: typeof message.content === "string" ? message.content.slice(0, 120) : "blocks" };
    }
    if (message.role === "toolResult") {
      const text = message.content.map((item) => item.type === "text" ? item.text : `[${item.type}]`).join("\n");
      return {
        role: "toolResult",
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        isError: message.isError,
        content: text.slice(0, 160),
      };
    }
    return {
      role: "assistant",
      responseId: message.responseId,
      content: message.content.map((item) => item.type === "text"
        ? `text:${item.text.slice(0, 80)}`
        : item.type === "toolCall"
          ? `tool:${item.name}`
          : item.type,
      ),
      stopReason: message.stopReason,
    };
  });
}

function debugLog(label: string, value: unknown): void {
  if (!isDebugEnabled()) {
    return;
  }
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.error(`[pi-windsurf-provider] ${label}: ${rendered}`);
}

function isDebugEnabled(): boolean {
  const value = process.env.PI_WINDSURF_PROVIDER_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
