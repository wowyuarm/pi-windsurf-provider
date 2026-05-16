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
  getWindsurfDeltaMessages,
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
          if (!hasStreamedOutput(state) && isAccountQuotaError(error)) {
            markAccountExhausted(account, errorToMessage(error));
            debugLog("account_quota_cooldown", {
              account: describeAccount(account),
              error: errorToMessage(error),
            });
            continue;
          }
          if (!hasStreamedOutput(state) && isNonPersistentAccountRetryError(error)) {
            debugLog("account_retry_without_cooldown", {
              account: describeAccount(account),
              error: errorToMessage(error),
            });
            continue;
          }
          if (!hasStreamedOutput(state) && isRateLimitError(error)) {
            debugLog("account_rate_limited", {
              account: describeAccount(account),
              error: errorToMessage(error),
            });
            throw new Error(`Windsurf rate limited. Wait a few minutes and try again. (${errorToMessage(error)})`);
          }
          throw error;
        }
      }

      throw new Error(`All available Windsurf accounts failed with recoverable account errors. Last error: ${errorToMessage(lastError)}`);
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
  const deltaMessages = getWindsurfDeltaMessages(context.messages, conversationId);
  const requestBytes = buildGetChatMessageRequest(model, context, metadataBytes, conversationId, options?.reasoning);
  const body = encodeConnectBinaryRequest(requestBytes);
  const url = buildUpstreamUrl(account);

  debugLog("request", {
    account: describeAccount(account),
    model: model.id,
    url,
    contextMessages: context.messages.length,
    upstreamMessages: deltaMessages.length,
    upstreamRoles: summarizeMessageRoles(deltaMessages),
    upstreamHasUserMessage: deltaMessages.some((message) => message.role === "user"),
    tools: (context.tools ?? []).length,
    contextTail: summarizeMessages(context.messages.slice(-4)),
    upstreamTail: summarizeMessages(deltaMessages.slice(-4)),
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

function isNonPersistentAccountRetryError(error: unknown): boolean {
  return isAccountVersionRejectedError(error)
    || isAccountServerTransientError(error);
}

function isRateLimitError(error: unknown): boolean {
  const message = errorToMessage(error).toLowerCase();
  return message.includes("rate limit") || message.includes("rate_limit");
}


/**
 * Check if the error is a quota/usage issue specific to this account.
 * Excludes upstream-provider-level resource exhaustion ("third-party model provider is experiencing issues"),
 * which affects all accounts and is not recoverable by switching accounts.
 */
function isAccountQuotaError(error: unknown): boolean {
  const message = errorToMessage(error).toLowerCase();
  if (message.includes("third-party model provider is experiencing issues")) {
    return false;
  }
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

function isAccountVersionRejectedError(error: unknown): boolean {
  const message = errorToMessage(error).toLowerCase();
  return message.includes("failed_precondition")
    && message.includes("windsurf version")
    && message.includes("out of date");
}

/**
 * Windsurf server sometimes returns invalid_argument with "an internal error occurred"
 * for transient server-side issues. Treat as recoverable so we skip to the next account.
 */
function isAccountServerTransientError(error: unknown): boolean {
  const message = errorToMessage(error).toLowerCase();
  if (!message.includes("internal error occurred")) {
    return false;
  }
  return message.includes("invalid_argument")
    || message.includes("permission_denied")
    || message.includes("unknown:");
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeAccount(account: WindsurfAccountCredentials): string {
  return account.name ?? account.email ?? `${account.source}:${account.id}`;
}

function summarizeMessageRoles(messages: Context["messages"]): Record<string, number> {
  const roles: Record<string, number> = {};
  for (const message of messages) {
    roles[message.role] = (roles[message.role] ?? 0) + 1;
  }
  return roles;
}

function summarizeMessages(messages: Context["messages"]): unknown[] {
  return messages.map((message) => {
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
