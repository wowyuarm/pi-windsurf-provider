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
import { markAccountExhausted, markAccountSuccessful, orderAccountsForAttempt } from "./account-state.ts";
import { buildRequestMetadataBytes, loadWindsurfAccounts, type WindsurfAccountCredentials } from "./metadata.ts";
import {
  applyResponseFrame,
  buildGetChatMessageRequest,
  createStreamState,
  failStream,
  finalizeStream,
  getOrCreateConversationId,
  type StreamState,
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
      const allAccounts = loadWindsurfAccounts();
      const accounts = orderAccountsForAttempt(allAccounts);
      if (allAccounts.length === 0) {
        throw new Error("No Windsurf account found. Log in to Windsurf once, or run pi-windsurf-account add-current after logging in.");
      }
      if (accounts.length === 0) {
        throw new Error("All configured Windsurf accounts are cooling down after usage/quota errors. Add another account or clear state with pi-windsurf-account clear-state.");
      }

      let lastError: unknown;
      for (const account of accounts) {
        try {
          await runWindsurfAttempt(account, model, context, options, conversationId, state, stream);
          markAccountSuccessful(account);
          finalizeStream(state, stream);
          stream.end();
          return;
        } catch (error) {
          lastError = error;
          if (options?.signal?.aborted === true) {
            throw error;
          }
          if (!hasStreamedOutput(state) && isQuotaExhaustedError(error)) {
            markAccountExhausted(account, errorToMessage(error));
            debugLog("account_exhausted", {
              account: describeAccount(account),
              error: errorToMessage(error),
            });
            continue;
          }
          throw error;
        }
      }

      throw new Error(`All available Windsurf accounts failed with usage/quota errors. Last error: ${errorToMessage(lastError)}`);
    } catch (error) {
      failStream(state, stream, error, options?.signal?.aborted === true);
      stream.end();
    }
  })();

  return stream;
}

async function runWindsurfAttempt(
  account: WindsurfAccountCredentials,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  conversationId: string,
  state: StreamState,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const metadataBytes = await buildRequestMetadataBytes(conversationId, account);
  const requestBytes = buildGetChatMessageRequest(model, context, metadataBytes, conversationId, options?.reasoning);
  const body = encodeConnectBinaryRequest(requestBytes);
  const url = buildUpstreamUrl(account);

  debugLog("request", {
    account: describeAccount(account),
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
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function buildUpstreamUrl(account: WindsurfAccountCredentials): string {
  const value = process.env.PI_WINDSURF_PROVIDER_URL?.trim();
  if (value) {
    return value;
  }
  if (account.apiServerUrl) {
    return `${account.apiServerUrl}${DEFAULT_ENDPOINT}`;
  }
  return `${DEFAULT_BASE_URL}${DEFAULT_ENDPOINT}`;
}

function hasStreamedOutput(state: StreamState): boolean {
  return state.output.content.length > 0;
}

function isQuotaExhaustedError(error: unknown): boolean {
  const message = errorToMessage(error).toLowerCase();
  return [
    "resource_exhausted",
    "quota",
    "usage limit",
    "usage exceeded",
    "usage exhausted",
    "limit exceeded",
    "credits exhausted",
    "insufficient credits",
    "quota_exceeded",
    "quota exhausted",
  ].some((fragment) => message.includes(fragment));
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeAccount(account: WindsurfAccountCredentials): string {
  return account.name ?? account.email ?? `${account.source}:${account.id}`;
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
