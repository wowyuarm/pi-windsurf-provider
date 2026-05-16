import {
  buildGetChatMessageRequest,
  createStreamState,
  finalizeStream,
  getStoredWindsurfAccountId,
  getWindsurfUpstreamMessages,
} from "../src/transform.ts";

function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  let index = offset;
  while (index < bytes.length) {
    const byte = bytes[index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [Number(value), index];
    }
    shift += 7n;
  }
  throw new Error("Unterminated varint");
}

function readFields(bytes) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, offset);
    offset = afterTag;
    const field = tag >> 3;
    const wire = tag & 7;

    if (wire === 0) {
      const [value, next] = readVarint(bytes, offset);
      fields.push({ field, wire, value });
      offset = next;
      continue;
    }

    if (wire === 2) {
      const [length, afterLength] = readVarint(bytes, offset);
      const start = afterLength;
      const end = start + length;
      fields.push({ field, wire, bytes: bytes.slice(start, end) });
      offset = end;
      continue;
    }

    throw new Error(`Unsupported protobuf wire type ${wire} for field ${field}`);
  }
  return fields;
}

function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
}

function promptSummary(promptBytes) {
  const fields = readFields(promptBytes);
  const id = fields.find((field) => field.field === 1)?.bytes;
  const source = fields.find((field) => field.field === 2)?.value;
  const content = fields.find((field) => field.field === 3)?.bytes;
  const toolCallId = fields.find((field) => field.field === 7)?.bytes;
  return {
    id: id ? decodeText(id) : undefined,
    source,
    content: content ? decodeText(content) : undefined,
    toolCallId: toolCallId ? decodeText(toolCallId) : undefined,
    toolCalls: fields.filter((field) => field.field === 6).length,
  };
}

function requestPromptSummaries(messages, conversationId = "cid-1") {
  const request = buildGetChatMessageRequest(
    model,
    { messages, tools: [] },
    new Uint8Array(),
    conversationId,
  );

  return readFields(request)
    .filter((field) => field.field === 3)
    .map((field) => promptSummary(field.bytes));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const model = {
  id: "swe-1.6",
  api: "windsurf-upstream",
  provider: "windsurf",
  contextWindow: 200000,
  maxTokens: 128000,
};

const state = createStreamState(model, "cid-1");
state.output.responseId = "bot-1";
finalizeStream(state, { push() {} }, "account-1");
assert(state.output.responseId === "wsrid:v2:account-1:cid-1:bot-1", "finalized responseId should store the owning Windsurf account id");

const userMessage = { role: "user", timestamp: 1, content: "first user prompt" };
const assistantToolUse = {
  role: "assistant",
  responseId: "wsrid:v2:account-1:cid-1:bot-1",
  content: [
    { type: "thinking", thinking: "thinking" },
    { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf DELTA_OK" } },
  ],
  stopReason: "toolUse",
  timestamp: 2,
};
const toolResult = {
  role: "toolResult",
  toolName: "bash",
  toolCallId: "tool-1",
  isError: false,
  timestamp: 3,
  content: [{ type: "text", text: "DELTA_OK" }],
};
const assistantAnswer = {
  role: "assistant",
  responseId: "wsrid:v2:account-1:cid-1:bot-2",
  content: [{ type: "text", text: "first answer" }],
  stopReason: "stop",
  timestamp: 4,
};
const followUpUser = { role: "user", timestamp: 5, content: "second user prompt" };

const fullConversation = [userMessage, assistantToolUse, toolResult];
const normalFollowUpConversation = [userMessage, assistantToolUse, toolResult, assistantAnswer, followUpUser];
const parallelAssistantToolUse = {
  role: "assistant",
  responseId: "wsrid:v2:account-1:cid-1:bot-3",
  content: [
    { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
    { type: "toolCall", id: "tool-2", name: "bash", arguments: { command: "printf OK" } },
  ],
  stopReason: "toolUse",
  timestamp: 6,
};
const secondToolResult = {
  role: "toolResult",
  toolName: "bash",
  toolCallId: "tool-2",
  isError: false,
  timestamp: 7,
  content: [{ type: "text", text: "FIND_OK" }],
};
const parallelConversation = [userMessage, parallelAssistantToolUse, toolResult, secondToolResult];

const steeredConversation = [
  userMessage,
  assistantToolUse,
  { role: "user", timestamp: 8, content: "STEER: change direction now" },
  toolResult,
];

const newConversationPrompts = requestPromptSummaries([userMessage]);
const continuationUpstream = getWindsurfUpstreamMessages(fullConversation);
const continuationPrompts = requestPromptSummaries(fullConversation);
const normalFollowUpPrompts = requestPromptSummaries(normalFollowUpConversation);
const storedAccountId = getStoredWindsurfAccountId(fullConversation);
const parallelUpstream = getWindsurfUpstreamMessages(parallelConversation);
const parallelContinuationPrompts = requestPromptSummaries(parallelConversation);
const steeredUpstream = getWindsurfUpstreamMessages(steeredConversation);
const steeredContinuationPrompts = requestPromptSummaries(steeredConversation);

assert(newConversationPrompts.length === 1, "new conversation should send one prompt message");
assert(newConversationPrompts[0].source === 1, "new conversation should send the user message");
assert(storedAccountId === "account-1", "stored Windsurf account id should be recovered from responseId");
assert(continuationUpstream.map((message) => message.role).join(",") === "user,assistant,toolResult", "tool continuation should send full visible history");
assert(continuationPrompts.map((prompt) => prompt.source).join(",") === "1,2,4", "tool continuation request should encode current user, assistant anchor, and tool message");
assert(continuationPrompts[0].content === "first user prompt", "tool continuation should include the user request for model context");

assert(normalFollowUpPrompts.map((prompt) => prompt.source).join(",") === "1,2,4,2,1", "normal follow-up should replay previous user/assistant/tool history plus the new user");
assert(normalFollowUpPrompts[0].id === continuationPrompts[0].id, "replayed user prompt should keep the same stable id");
assert(normalFollowUpPrompts[2].id === continuationPrompts[2].id, "replayed tool result should keep the same stable id");
assert(normalFollowUpPrompts[4].content === "second user prompt", "normal follow-up should include the new user prompt");

assert(parallelUpstream.map((message) => message.role).join(",") === "user,assistant,toolResult,toolResult", "parallel tool continuation should send full visible history");
assert(parallelContinuationPrompts.map((prompt) => prompt.source).join(",") === "1,2,4,4", "parallel tool continuation should encode current user, assistant anchor, plus two tool messages");

assert(steeredUpstream.map((message) => message.role).join(",") === "user,assistant,user,toolResult", "steered continuation should send original task, assistant anchor, new steer, and tool result");
assert(steeredContinuationPrompts.map((prompt) => prompt.source).join(",") === "1,2,1,4", "steered continuation should encode original task, assistant anchor, new steer, and tool result");
assert(steeredContinuationPrompts[2].content === "STEER: change direction now", "steered continuation should send the new steer text");
assert(steeredContinuationPrompts[0].content === "first user prompt", "steered continuation should include the original task for model context");

console.log(JSON.stringify({
  ok: true,
  newConversationPrompts: newConversationPrompts.map((prompt) => ({ id: prompt.id, source: prompt.source, content: prompt.content })),
  continuationPrompts: continuationPrompts.map((prompt) => ({ id: prompt.id, source: prompt.source, content: prompt.content })),
  normalFollowUpPrompts: normalFollowUpPrompts.map((prompt) => ({ id: prompt.id, source: prompt.source, content: prompt.content })),
  parallelContinuationPrompts: parallelContinuationPrompts.map((prompt) => ({ id: prompt.id, source: prompt.source, content: prompt.content })),
  steeredContinuationPrompts: steeredContinuationPrompts.map((prompt) => ({ id: prompt.id, source: prompt.source, content: prompt.content })),
}, null, 2));
