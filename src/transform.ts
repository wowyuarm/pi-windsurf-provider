import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
} from "@mariozechner/pi-ai";
import {
  concatBytes,
  decodeProtoFields,
  decodeString,
  encodeBoolField,
  encodeDoubleField,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  getBytesField,
  getRepeatedBytesFields,
  getStringField,
  getVarintField,
} from "./proto.ts";

const CHAT_MESSAGE_SOURCE_USER = 1;
const CHAT_MESSAGE_SOURCE_ASSISTANT = 2;
const CHAT_MESSAGE_SOURCE_TOOL = 4;
const REQUEST_TYPE_GENERAL = 5;
const PLANNER_MODE_DEFAULT = 1;

const STOP_REASON_STOP_PATTERN = 2;
const STOP_REASON_MAX_TOKENS = 3;
const STOP_REASON_FUNCTION_CALL = 10;
const STOP_REASON_ERROR = 13;

const TOOL_READ_ONLY_HINT_NAMES = new Set([
  "read",
  "read_file",
  "list_dir",
  "list_resources",
  "search_web",
  "read_url_content",
  "view_content_chunk",
  "grep",
]);

// All Windsurf models we expose are now selected via the external chat_model_uid
// path (request field 21), with use_internal_chat_model=false.
//
// SWE-1.6 used to be selected via the internal chat-model enum (field 6 = 420/421),
// but upstream now rejects those enum values with "internal error". The current
// SWE path uses the same external uid mechanism as Claude, with hyphenated
// identifiers ("swe-1-6", "swe-1-6-fast"). The dotted forms "swe-1.6" /
// "swe-1.6-fast" are rejected by the server.
//
// External chat_model_uid resolution.
// Windsurf upstream is picky about which (uid, reasoning-suffix) pairs it accepts:
//   claude-opus-4-7   : ONLY -low / -medium / -high / -xhigh (no bare uid)
//   claude-opus-4-6   : ONLY the bare uid; reasoning is expressed by switching
//                       to the separate -thinking variant, NOT by suffix.
//   swe-1-6 / swe-1-6-fast : ONLY the bare uid; any -low/-medium/-high suffix
//                            is rejected.
function resolveExternalModelUid(
  modelId: string,
  reasoning?: ThinkingLevel,
): string | undefined {
  if (modelId === "claude-opus-4-7") {
    const suffix = OPUS_4_7_REASONING_SUFFIX[reasoning ?? "high"] ?? "-high";
    return `claude-opus-4-7${suffix}`;
  }
  if (modelId === "claude-opus-4-6") {
    return OPUS_4_6_USE_THINKING[reasoning ?? "high"]
      ? "claude-opus-4-6-thinking"
      : "claude-opus-4-6";
  }
  if (modelId === "swe-1.6") return "swe-1-6";
  if (modelId === "swe-1.6-fast") return "swe-1-6-fast";
  return undefined;
}

// 4.7: every reasoning level maps to an explicit suffixed UID. Bare uid is rejected.
const OPUS_4_7_REASONING_SUFFIX: Record<ThinkingLevel, string> = {
  minimal: "-low",
  low: "-low",
  medium: "-medium",
  high: "-high",
  xhigh: "-xhigh",
};

// 4.6: low-effort thinking levels stay on the non-thinking model;
// medium and above switch to the dedicated -thinking model.
const OPUS_4_6_USE_THINKING: Record<ThinkingLevel, boolean> = {
  minimal: false,
  low: false,
  medium: true,
  high: true,
  xhigh: true,
};

export interface StreamState {
  output: AssistantMessage;
  conversationId: string;
  currentTextIndex?: number;
  currentThinkingIndex?: number;
  toolCallIndices: Map<string, number>;
  toolCallJson: Map<string, string>;
  openToolCallIds: Set<string>;
  lastToolCallId?: string;
}

export const WINDSURF_MODELS = [
  {
    id: "swe-1.6",
    name: "SWE-1.6",
    reasoning: false,
    input: ["text"] as Array<"text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "swe-1.6-fast",
    name: "SWE-1.6 Fast",
    reasoning: false,
    input: ["text"] as Array<"text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    input: ["text"] as Array<"text">,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text"] as Array<"text">,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
];

export function buildGetChatMessageRequest(
  model: Model<Api>,
  context: Context,
  metadataBytes: Uint8Array,
  conversationId: string,
  reasoning?: ThinkingLevel,
): Uint8Array {
  const externalUid = resolveExternalModelUid(model.id, reasoning);
  if (!externalUid) {
    throw new Error(`Unsupported Windsurf model: ${model.id}`);
  }

  const parts: Uint8Array[] = [
    encodeMessageField(1, metadataBytes),
    encodeStringField(2, buildSystemPrompt(context)),
    ...convertMessages(context.messages).map((message) => encodeMessageField(3, message)),
    encodeVarintField(5, 0),
    encodeStringField(21, externalUid),
    encodeVarintField(7, REQUEST_TYPE_GENERAL),
    encodeMessageField(8, buildCompletionConfiguration(model)),
    ...convertTools(context.tools ?? []).map((tool) => encodeMessageField(10, tool)),
    encodeMessageField(15, buildEnterpriseChatModelConfig(model)),
    encodeStringField(16, conversationId),
    encodeVarintField(20, PLANNER_MODE_DEFAULT),
  ];

  return concatBytes(...parts);
}

export function createStreamState(model: Model<Api>, conversationId: string): StreamState {
  return {
    output: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    conversationId,
    toolCallIndices: new Map(),
    toolCallJson: new Map(),
    openToolCallIds: new Set(),
  };
}

export function applyResponseFrame(
  model: Model<Api>,
  payloadBytes: Uint8Array,
  state: StreamState,
  stream: AssistantMessageEventStream,
): void {
  const fields = decodeProtoFields(payloadBytes);

  maybeAssignResponseIds(fields, state.output);
  maybeUpdateUsage(model, fields, state.output);
  maybeUpdateStopReason(fields, state.output);

  const deltaThinking = getStringField(fields, 9);
  if (deltaThinking) {
    closeTextIfOpen(state, stream);
    const normalizedThinking = normalizeLeadingStreamDelta(deltaThinking, state.currentThinkingIndex, state.output, "thinking");
    if (normalizedThinking) {
      const contentIndex = ensureThinkingBlock(state, stream);
      const block = state.output.content[contentIndex];
      if (block?.type === "thinking") {
        block.thinking += normalizedThinking;
        stream.push({ type: "thinking_delta", contentIndex, delta: normalizedThinking, partial: state.output });
      }
    }
  }

  const deltaText = getStringField(fields, 3);
  if (deltaText) {
    closeThinkingIfOpen(state, stream);
    const normalizedText = normalizeLeadingStreamDelta(deltaText, state.currentTextIndex, state.output, "text");
    if (normalizedText) {
      const contentIndex = ensureTextBlock(state, stream);
      const block = state.output.content[contentIndex];
      if (block?.type === "text") {
        block.text += normalizedText;
        stream.push({ type: "text_delta", contentIndex, delta: normalizedText, partial: state.output });
      }
    }
  }

  const deltaToolCalls = getRepeatedBytesFields(fields, 6);
  if (deltaToolCalls.length > 0) {
    closeTextIfOpen(state, stream);
    closeThinkingIfOpen(state, stream);
    for (const callBytes of deltaToolCalls) {
      applyToolCallDelta(callBytes, state, stream);
    }
  }
}

export function finalizeStream(state: StreamState, stream: AssistantMessageEventStream): void {
  closeTextIfOpen(state, stream);
  closeThinkingIfOpen(state, stream);
  closeToolCalls(state, stream);
  state.output.responseId = encodeStoredResponseId(state.conversationId, state.output.responseId);

  if (state.output.stopReason === "error" || state.output.stopReason === "aborted") {
    stream.push({ type: "error", reason: state.output.stopReason, error: state.output });
    return;
  }

  stream.push({
    type: "done",
    reason: state.output.stopReason as "stop" | "length" | "toolUse",
    message: state.output,
  });
}

export function failStream(
  state: StreamState,
  stream: AssistantMessageEventStream,
  error: unknown,
  aborted = false,
): void {
  closeTextIfOpen(state, stream);
  closeThinkingIfOpen(state, stream);
  closeToolCalls(state, stream);
  state.output.stopReason = aborted ? "aborted" : "error";
  state.output.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "error", reason: state.output.stopReason, error: state.output });
}

function buildSystemPrompt(context: Context): string {
  const basePrompt = [
    "You are Cascade, a powerful agentic AI coding assistant.",
    "The user is interacting with you through Pi and will ask you to solve coding tasks by pair programming.",
    "The task may require modifying or debugging existing code, answering questions about code, or writing new code.",
    "Speak to the user in the language they use, unless they ask for another language.",
    "Be mindful that you are not the only actor in this environment.",
    "Do not overstep your bounds. Do not create unnecessary files or changes.",
    "",
    "<communication_style>",
    "Be terse and direct. Deliver fact-based progress updates. Ask for clarification only when genuinely uncertain.",
    "- Start with substantive content. Do not add praise, agreement, or other preamble.",
    "- Do not make ungrounded claims. When uncertain, use tools to verify.",
    "- Prefer concise bullet points and short paragraphs over long blocks of text.",
    "</communication_style>",
    "",
    "<tool_calling>",
    "Use only available tools. Never guess parameters. Do not invent tools, symbols, files, or results.",
    "- Before each tool call, briefly state why you are calling it.",
    "- Prefer the smallest number of tool calls needed.",
    "- Batch independent read-only tool calls in parallel.",
    "- Keep dependent or destructive actions sequential.",
    "- After every tool result, either answer directly or make one clearly necessary next tool call.",
    'Never output "No response requested".',
    "</tool_calling>",
    "",
    "<making_code_changes>",
    "Prefer minimal, focused edits that fix root cause.",
    "- Keep changes scoped and follow existing style.",
    "- Avoid unnecessary helper scripts, shortcuts, or broad rewrites.",
    "- By default, implement changes rather than only suggesting them.",
    "- Verify changes with tests, commands, or other concrete checks when practical.",
    "</making_code_changes>",
    "",
    "<pi_environment>",
    "Pi provides conversation history, tool definitions, and tool results.",
    "- Do not assume Windsurf IDE workspace metadata or hidden local runtime state unless it is explicitly provided.",
    "- Treat file system and processes as shared environment.",
    "</pi_environment>",
  ].join("\n");

  const prompt = context.systemPrompt?.trim();
  if (!prompt) {
    return basePrompt;
  }

  return `${basePrompt}\n\n<pi_system_prompt>\n${prompt}\n</pi_system_prompt>`;
}

function convertMessages(messages: Message[]): Uint8Array[] {
  const prompts: Uint8Array[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      prompts.push(
        concatBytes(
          encodeStringField(1, crypto.randomUUID()),
          encodeVarintField(2, CHAT_MESSAGE_SOURCE_USER),
          encodeStringField(3, stringifyContent(message.content)),
          encodeVarintField(5, 1),
          encodeBoolField(8, true),
        ),
      );
      continue;
    }

    if (message.role === "assistant") {
      const storedState = parseStoredResponseId(message.responseId);
      const assistantMessageId = storedState?.messageId ?? message.responseId ?? `bot-${crypto.randomUUID()}`;
      const parts: Uint8Array[] = [
        encodeStringField(1, assistantMessageId),
        encodeVarintField(2, CHAT_MESSAGE_SOURCE_ASSISTANT),
      ];

      const text = stringifyAssistantText(message.content);
      if (text) {
        parts.push(encodeStringField(3, text));
      }

      const thinking = stringifyAssistantThinking(message.content);
      if (thinking) {
        parts.push(encodeStringField(11, thinking));
      }

      const toolCalls = extractAssistantToolCalls(message.content);
      for (const toolCall of toolCalls) {
        parts.push(encodeMessageField(6, encodeToolCall(toolCall)));
      }

      if (parts.length > 2) {
        prompts.push(concatBytes(...parts));
      }
      continue;
    }

    const parts: Uint8Array[] = [
      encodeStringField(1, crypto.randomUUID()),
      encodeVarintField(2, CHAT_MESSAGE_SOURCE_TOOL),
      encodeStringField(3, formatToolResult(message.toolName, stringifyContent(message.content), message.isError)),
      encodeBoolField(8, true),
    ];

    if (message.toolCallId) {
      parts.push(encodeStringField(7, message.toolCallId));
    }
    if (message.isError) {
      parts.push(encodeBoolField(9, true));
    }

    prompts.push(concatBytes(...parts));
  }

  return prompts;
}

function convertTools(tools: Tool[]): Uint8Array[] {
  return tools.map((tool) => {
    const parts: Uint8Array[] = [
      encodeStringField(1, tool.name),
      encodeStringField(2, tool.description ?? ""),
      encodeStringField(3, JSON.stringify(tool.parameters ?? {})),
    ];

    if (TOOL_READ_ONLY_HINT_NAMES.has(tool.name)) {
      parts.push(encodeBoolField(7, true));
    }

    return concatBytes(...parts);
  });
}

function buildCompletionConfiguration(model: Model<Api>): Uint8Array {
  const maxTokens = Math.max(1, Math.min(model.maxTokens ?? 64000, 64000));
  const stopPatterns = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

  return concatBytes(
    encodeVarintField(1, 1),
    encodeVarintField(2, maxTokens),
    encodeVarintField(3, 200),
    encodeDoubleField(5, 0.4),
    encodeDoubleField(6, 0.4),
    encodeVarintField(7, 50),
    encodeDoubleField(8, 1),
    ...stopPatterns.map((pattern) => encodeStringField(9, pattern)),
    encodeDoubleField(11, 1),
  );
}

function buildEnterpriseChatModelConfig(model: Model<Api>): Uint8Array {
  const maxOutput = Math.max(1, Math.min(model.maxTokens ?? 64000, 64000));
  const maxInput = Math.max(1, Math.min(model.contextWindow ?? 200000, 1000000));
  return concatBytes(
    encodeVarintField(2, maxOutput),
    encodeVarintField(3, maxInput),
  );
}

function extractAssistantToolCalls(content: Message["content"]): ToolCall[] {
  if (typeof content === "string") {
    return [];
  }
  return content.filter((block): block is ToolCall => block.type === "toolCall");
}

function stringifyAssistantText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function stringifyAssistantThinking(content: Message["content"]): string {
  if (typeof content === "string") {
    return "";
  }
  return content
    .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n");
}

function stringifyContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      return "[non-text content omitted]";
    })
    .join("\n");
}

function encodeToolCall(toolCall: ToolCall): Uint8Array {
  return concatBytes(
    encodeStringField(1, toolCall.id),
    encodeStringField(2, toolCall.name),
    encodeStringField(3, JSON.stringify(toolCall.arguments ?? {})),
  );
}

function applyToolCallDelta(bytes: Uint8Array, state: StreamState, stream: AssistantMessageEventStream): void {
  const fields = decodeProtoFields(bytes);
  const explicitId = getStringField(fields, 1);
  const explicitName = getStringField(fields, 2);
  const argumentsChunk = getStringField(fields, 3) ?? getStringField(fields, 4) ?? "";
  const id = explicitId ?? state.lastToolCallId;
  if (!id) {
    return;
  }

  let contentIndex = state.toolCallIndices.get(id);
  if (contentIndex === undefined) {
    state.output.content.push({ type: "toolCall", id, name: explicitName ?? "unknown_tool", arguments: {} });
    contentIndex = state.output.content.length - 1;
    state.toolCallIndices.set(id, contentIndex);
    state.toolCallJson.set(id, "");
    state.openToolCallIds.add(id);
    stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
  }

  state.lastToolCallId = id;

  const block = state.output.content[contentIndex];
  if (!block || block.type !== "toolCall") {
    return;
  }

  if (explicitName) {
    block.name = explicitName;
  }

  const previousJson = state.toolCallJson.get(id) ?? "";
  const nextJson = !argumentsChunk
    ? previousJson
    : !explicitId && !explicitName
      ? previousJson + argumentsChunk
      : !previousJson
        ? argumentsChunk
        : argumentsChunk.startsWith(previousJson)
          ? argumentsChunk
          : previousJson + argumentsChunk;

  if (nextJson) {
    block.arguments = parseArgumentsJson(nextJson, block.arguments);
    const delta = nextJson.startsWith(previousJson) ? nextJson.slice(previousJson.length) : argumentsChunk;
    if (delta) {
      stream.push({ type: "toolcall_delta", contentIndex, delta, partial: state.output });
    }
    state.toolCallJson.set(id, nextJson);
  }
}

function parseArgumentsJson(raw: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
  }
  return fallback;
}

function maybeAssignResponseIds(fields: ReturnType<typeof decodeProtoFields>, output: AssistantMessage): void {
  const messageId = getStringField(fields, 1);
  const outputId = getStringField(fields, 15);
  const requestId = getStringField(fields, 17);
  output.responseId = messageId ?? outputId ?? requestId ?? output.responseId;
}

function maybeUpdateStopReason(fields: ReturnType<typeof decodeProtoFields>, output: AssistantMessage): void {
  const raw = getVarintField(fields, 5);
  if (raw === undefined) {
    return;
  }
  if (raw === STOP_REASON_FUNCTION_CALL) {
    output.stopReason = "toolUse";
    return;
  }
  if (raw === STOP_REASON_MAX_TOKENS) {
    output.stopReason = "length";
    return;
  }
  if (raw === STOP_REASON_ERROR) {
    output.stopReason = "error";
    return;
  }
  if (raw === STOP_REASON_STOP_PATTERN) {
    output.stopReason = "stop";
  }
}

function maybeUpdateUsage(
  model: Model<Api>,
  fields: ReturnType<typeof decodeProtoFields>,
  output: AssistantMessage,
): void {
  const usageBytes = getBytesField(fields, 7);
  if (usageBytes) {
    const usageFields = decodeProtoFields(usageBytes);
    output.usage.input = getVarintField(usageFields, 2) ?? output.usage.input;
    output.usage.output = getVarintField(usageFields, 3) ?? output.usage.output;
    output.usage.cacheWrite = getVarintField(usageFields, 4) ?? output.usage.cacheWrite;
    output.usage.cacheRead = getVarintField(usageFields, 5) ?? output.usage.cacheRead;
  }

  const deltaTokens = getVarintField(fields, 4);
  if (deltaTokens && !usageBytes) {
    output.usage.output += deltaTokens;
  }

  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function normalizeLeadingStreamDelta(
  delta: string,
  currentIndex: number | undefined,
  output: AssistantMessage,
  kind: "text" | "thinking",
): string {
  if (currentIndex !== undefined) {
    return delta;
  }

  const hasSameKindContent = output.content.some((block) => {
    if (kind === "text") {
      return block.type === "text" && block.text.length > 0;
    }
    return block.type === "thinking" && block.thinking.length > 0;
  });
  if (hasSameKindContent) {
    return delta;
  }

  return delta.replace(/^[\t ]*\r?\n+/, "");
}

function ensureTextBlock(state: StreamState, stream: AssistantMessageEventStream): number {
  if (state.currentTextIndex !== undefined) {
    return state.currentTextIndex;
  }
  state.output.content.push({ type: "text", text: "" });
  state.currentTextIndex = state.output.content.length - 1;
  stream.push({ type: "text_start", contentIndex: state.currentTextIndex, partial: state.output });
  return state.currentTextIndex;
}

function ensureThinkingBlock(state: StreamState, stream: AssistantMessageEventStream): number {
  if (state.currentThinkingIndex !== undefined) {
    return state.currentThinkingIndex;
  }
  state.output.content.push({ type: "thinking", thinking: "" });
  state.currentThinkingIndex = state.output.content.length - 1;
  stream.push({ type: "thinking_start", contentIndex: state.currentThinkingIndex, partial: state.output });
  return state.currentThinkingIndex;
}

function closeTextIfOpen(state: StreamState, stream: AssistantMessageEventStream): void {
  if (state.currentTextIndex === undefined) {
    return;
  }
  const contentIndex = state.currentTextIndex;
  const block = state.output.content[contentIndex];
  if (block?.type === "text") {
    stream.push({ type: "text_end", contentIndex, content: block.text, partial: state.output });
  }
  state.currentTextIndex = undefined;
}

function closeThinkingIfOpen(state: StreamState, stream: AssistantMessageEventStream): void {
  if (state.currentThinkingIndex === undefined) {
    return;
  }
  const contentIndex = state.currentThinkingIndex;
  const block = state.output.content[contentIndex];
  if (block?.type === "thinking") {
    stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: state.output });
  }
  state.currentThinkingIndex = undefined;
}

function closeToolCalls(state: StreamState, stream: AssistantMessageEventStream): void {
  for (const id of state.openToolCallIds) {
    const contentIndex = state.toolCallIndices.get(id);
    if (contentIndex === undefined) {
      continue;
    }
    const block = state.output.content[contentIndex];
    if (!block || block.type !== "toolCall") {
      continue;
    }
    stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: state.output });
  }
  state.openToolCallIds.clear();
  state.lastToolCallId = undefined;
}

export function getOrCreateConversationId(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const stored = parseStoredResponseId(message.responseId);
    if (stored?.conversationId) {
      return stored.conversationId;
    }
  }
  return crypto.randomUUID();
}

function parseStoredResponseId(value: string | undefined): { conversationId: string; messageId: string } | undefined {
  if (!value?.startsWith("wsrid:")) {
    return undefined;
  }
  const remainder = value.slice("wsrid:".length);
  const separator = remainder.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const conversationId = remainder.slice(0, separator);
  const messageId = remainder.slice(separator + 1);
  if (!conversationId || !messageId) {
    return undefined;
  }
  return { conversationId, messageId };
}

function encodeStoredResponseId(conversationId: string, messageId: string | undefined): string | undefined {
  if (!messageId) {
    return undefined;
  }
  return `wsrid:${conversationId}:${messageId}`;
}

function formatToolResult(toolName: string, content: string, isError: boolean): string {
  const label = isError ? `Tool error (${toolName})` : `Tool result (${toolName})`;
  const body = content.trim();
  const lines = [label + ":"];
  if (body) {
    lines.push(body);
  }
  lines.push('You must respond with a message or a tool call. You cannot output "No response requested"');
  return lines.join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
