import { buildGetChatMessageRequest, createStreamState, finalizeStream, getStoredWindsurfAccountId, getWindsurfDeltaMessages } from "../src/transform.ts";

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

const userMessage = { role: "user", content: "first user prompt" };
const assistantToolUse = {
  role: "assistant",
  responseId: "wsrid:v2:account-1:cid-1:bot-1",
  content: [
    { type: "thinking", thinking: "thinking" },
    { type: "toolCall", toolCallId: "tool-1", name: "bash", input: { command: "printf DELTA_OK" } },
  ],
  stopReason: "toolUse",
};
const toolResult = {
  role: "toolResult",
  toolName: "bash",
  toolCallId: "tool-1",
  isError: false,
  content: [{ type: "text", text: "DELTA_OK" }],
};

const fullConversation = [userMessage, assistantToolUse, toolResult];
const steeredConversation = [
  userMessage,
  assistantToolUse,
  { role: "user", content: "STEER: change direction now" },
  toolResult,
];

const newConversationPrompts = requestPromptSummaries([userMessage]);
const continuationDelta = getWindsurfDeltaMessages(fullConversation, "cid-1");
const continuationPrompts = requestPromptSummaries(fullConversation);
const storedAccountId = getStoredWindsurfAccountId(fullConversation);
const steeredDelta = getWindsurfDeltaMessages(steeredConversation, "cid-1");
const steeredContinuationPrompts = requestPromptSummaries(steeredConversation);

assert(newConversationPrompts.length === 1, "new conversation should send one prompt message");
assert(newConversationPrompts[0].source === 1, "new conversation should send the user message");
assert(storedAccountId === "account-1", "stored Windsurf account id should be recovered from responseId");
assert(continuationDelta.length === 1, "continuation delta should contain only new messages after the last Windsurf assistant response");
assert(continuationDelta[0].role === "toolResult", "continuation delta should contain the tool result");
assert(continuationPrompts.length === 1, "continuation request should encode only one prompt message");
assert(continuationPrompts[0].source === 4, "continuation request should encode a tool message");
assert(!continuationPrompts.some((prompt) => prompt.source === 1), "continuation request must not resend user messages");
assert(!continuationPrompts.some((prompt) => prompt.content?.includes("first user prompt")), "continuation request must not contain the original user prompt text");

assert(steeredDelta.map((message) => message.role).join(",") === "user,toolResult", "steered continuation should send the new steer and the tool result");
assert(steeredContinuationPrompts.length === 2, "steered continuation should encode the steer and the tool result");
assert(steeredContinuationPrompts[0].source === 1, "steered continuation should encode the new steer as a user message");
assert(steeredContinuationPrompts[0].content === "STEER: change direction now", "steered continuation should send the new steer text");
assert(steeredContinuationPrompts[1].source === 4, "steered continuation should encode the tool result after the steer");
assert(!steeredContinuationPrompts.some((prompt) => prompt.content?.includes("first user prompt")), "steered continuation must not contain the original user prompt text");

console.log(JSON.stringify({
  ok: true,
  newConversationPrompts: newConversationPrompts.map((prompt) => ({ source: prompt.source, content: prompt.content })),
  continuationPrompts: continuationPrompts.map((prompt) => ({ source: prompt.source, content: prompt.content })),
  steeredContinuationPrompts: steeredContinuationPrompts.map((prompt) => ({ source: prompt.source, content: prompt.content })),
}, null, 2));
