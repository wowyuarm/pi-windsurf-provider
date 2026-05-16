import { buildGetChatMessageRequest, getWindsurfDeltaMessages } from "../src/transform.ts";

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
    {
      id: "swe-1.6",
      api: "windsurf-upstream",
      provider: "windsurf",
      contextWindow: 200000,
      maxTokens: 128000,
    },
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

const userMessage = { role: "user", content: "first user prompt" };
const assistantToolUse = {
  role: "assistant",
  responseId: "wsrid:cid-1:bot-1",
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
const newConversationPrompts = requestPromptSummaries([userMessage]);
const continuationDelta = getWindsurfDeltaMessages(fullConversation, "cid-1");
const continuationPrompts = requestPromptSummaries(fullConversation);

assert(newConversationPrompts.length === 1, "new conversation should send one prompt message");
assert(newConversationPrompts[0].source === 1, "new conversation should send the user message");
assert(continuationDelta.length === 1, "continuation delta should contain only new messages after the last Windsurf assistant response");
assert(continuationDelta[0].role === "toolResult", "continuation delta should contain the tool result");
assert(continuationPrompts.length === 1, "continuation request should encode only one prompt message");
assert(continuationPrompts[0].source === 4, "continuation request should encode a tool message");
assert(!continuationPrompts.some((prompt) => prompt.source === 1), "continuation request must not resend user messages");
assert(!continuationPrompts.some((prompt) => prompt.content?.includes("first user prompt")), "continuation request must not contain the original user prompt text");

console.log(JSON.stringify({
  ok: true,
  newConversationPrompts: newConversationPrompts.map((prompt) => ({ source: prompt.source, content: prompt.content })),
  continuationPrompts: continuationPrompts.map((prompt) => ({ source: prompt.source, content: prompt.content })),
}, null, 2));
