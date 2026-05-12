import { gunzipSync, gzipSync } from "node:zlib";
import { concatBytes, decodeString } from "./proto.ts";

export interface ConnectBinaryFrame {
  flags: number;
  payload: Uint8Array;
}

const CONNECT_FLAG_COMPRESSED = 0x01;
const CONNECT_FLAG_TRAILER = 0x02;

export function encodeConnectBinaryRequest(payload: Uint8Array): Uint8Array {
  const compressed = gzipSync(payload);
  const frame = new Uint8Array(5 + compressed.length);
  frame[0] = CONNECT_FLAG_COMPRESSED;
  writeUint32BE(frame, 1, compressed.length);
  frame.set(compressed, 5);
  return frame;
}

export async function* decodeConnectBinaryFrames(
  body: ReadableStream<Uint8Array<ArrayBufferLike>> | null,
): AsyncGenerator<ConnectBinaryFrame> {
  if (!body) {
    throw new Error("Connect response body was empty");
  }

  const reader = body.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.length === 0) {
      continue;
    }

    buffer = concatBytes(buffer, new Uint8Array(value));

    while (buffer.length >= 5) {
      const flags = buffer[0] ?? 0;
      const payloadLength = readUint32BE(buffer, 1);
      const frameLength = payloadLength + 5;
      if (buffer.length < frameLength) {
        break;
      }

      const payloadBytes = buffer.slice(5, frameLength);
      buffer = buffer.slice(frameLength);

      const payload = (flags & CONNECT_FLAG_COMPRESSED) !== 0
        ? new Uint8Array(gunzipSync(payloadBytes))
        : payloadBytes;

      yield { flags, payload };
    }
  }

  if (buffer.length > 0) {
    throw new Error("Truncated Connect frame received from Windsurf upstream");
  }
}

export function parseTrailerError(frame: ConnectBinaryFrame): string | undefined {
  if ((frame.flags & CONNECT_FLAG_TRAILER) === 0) {
    return undefined;
  }

  const raw = decodeString(frame.payload);
  if (!raw) {
    return undefined;
  }

  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const error = isRecord(payload.error) ? payload.error : payload;
    const code = typeof error.code === "string" ? error.code : undefined;
    const message = typeof error.message === "string" ? error.message : undefined;
    if (code || message) {
      return [code, message].filter(Boolean).join(": ");
    }
  } catch {
  }

  return raw;
}

export async function readResponseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `HTTP ${response.status} ${response.statusText}`;
  }

  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const error = isRecord(payload.error) ? payload.error : payload;
    const code = typeof error.code === "string" ? error.code : undefined;
    const message = typeof error.message === "string" ? error.message : undefined;
    if (code || message) {
      return [code, message].filter(Boolean).join(": ");
    }
  } catch {
  }

  return `HTTP ${response.status} ${response.statusText}: ${text}`;
}

export function createUpstreamHeaders(): HeadersInit {
  return {
    "Accept-Encoding": "identity",
    "Connect-Accept-Encoding": "gzip",
    "Connect-Content-Encoding": "gzip",
    "Connect-Protocol-Version": "1",
    "Content-Type": "application/connect+proto",
    "User-Agent": "connect-es/1.5.0",
    "Connect-Timeout-Ms": "120000",
  };
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32BE(source: Uint8Array, offset: number): number {
  return (
    ((source[offset] ?? 0) << 24) |
    ((source[offset + 1] ?? 0) << 16) |
    ((source[offset + 2] ?? 0) << 8) |
    (source[offset + 3] ?? 0)
  ) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
