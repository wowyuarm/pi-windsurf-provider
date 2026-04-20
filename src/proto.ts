const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ProtoWireType = 0 | 1 | 2 | 5;

export interface ProtoField {
  number: number;
  wireType: ProtoWireType;
  value: number | Uint8Array;
}

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Cannot encode invalid varint value: ${value}`);
  }

  const bytes: number[] = [];
  let current = Math.trunc(value);
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

export function encodeDouble(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, true);
  return new Uint8Array(buffer);
}

export function encodeString(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  return concatBytes(encodeKey(fieldNumber, 0), encodeVarint(value));
}

export function encodeBoolField(fieldNumber: number, value: boolean): Uint8Array {
  return encodeVarintField(fieldNumber, value ? 1 : 0);
}

export function encodeDoubleField(fieldNumber: number, value: number): Uint8Array {
  return concatBytes(encodeKey(fieldNumber, 1), encodeDouble(value));
}

export function encodeBytesField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concatBytes(encodeKey(fieldNumber, 2), encodeVarint(value.length), value);
}

export function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  return encodeBytesField(fieldNumber, encodeString(value));
}

export function encodeMessageField(fieldNumber: number, value: Uint8Array): Uint8Array {
  return encodeBytesField(fieldNumber, value);
}

export function encodeTimestampField(fieldNumber: number, timestamp = Date.now()): Uint8Array {
  const seconds = Math.floor(timestamp / 1000);
  const nanos = Math.floor((timestamp % 1000) * 1_000_000);
  const message = concatBytes(
    encodeVarintField(1, seconds),
    encodeVarintField(2, nanos),
  );
  return encodeMessageField(fieldNumber, message);
}

export function decodeProtoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const [key, nextOffset] = readVarint(bytes, offset);
    offset = nextOffset;

    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (wireType === 0) {
      const [value, endOffset] = readVarint(bytes, offset);
      fields.push({ number: fieldNumber, wireType, value });
      offset = endOffset;
      continue;
    }

    if (wireType === 1) {
      fields.push({ number: fieldNumber, wireType, value: bytes.slice(offset, offset + 8) });
      offset += 8;
      continue;
    }

    if (wireType === 2) {
      const [length, endOffset] = readVarint(bytes, offset);
      const valueOffset = endOffset;
      const nextValueOffset = valueOffset + length;
      fields.push({ number: fieldNumber, wireType, value: bytes.slice(valueOffset, nextValueOffset) });
      offset = nextValueOffset;
      continue;
    }

    if (wireType === 5) {
      fields.push({ number: fieldNumber, wireType, value: bytes.slice(offset, offset + 4) });
      offset += 4;
      continue;
    }

    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }

  return fields;
}

export function getVarintField(fields: ProtoField[], fieldNumber: number): number | undefined {
  const field = fields.find((candidate) => candidate.number === fieldNumber && candidate.wireType === 0);
  return typeof field?.value === "number" ? field.value : undefined;
}

export function getStringField(fields: ProtoField[], fieldNumber: number): string | undefined {
  const field = fields.find((candidate) => candidate.number === fieldNumber && candidate.wireType === 2);
  return field && field.value instanceof Uint8Array ? decodeString(field.value) : undefined;
}

export function getBytesField(fields: ProtoField[], fieldNumber: number): Uint8Array | undefined {
  const field = fields.find((candidate) => candidate.number === fieldNumber && candidate.wireType === 2);
  return field && field.value instanceof Uint8Array ? field.value : undefined;
}

export function getRepeatedBytesFields(fields: ProtoField[], fieldNumber: number): Uint8Array[] {
  return fields
    .filter((candidate) => candidate.number === fieldNumber && candidate.wireType === 2)
    .map((candidate) => candidate.value)
    .filter((value): value is Uint8Array => value instanceof Uint8Array);
}

export function getRepeatedVarintFields(fields: ProtoField[], fieldNumber: number): number[] {
  return fields
    .filter((candidate) => candidate.number === fieldNumber && candidate.wireType === 0)
    .map((candidate) => candidate.value)
    .filter((value): value is number => typeof value === "number");
}

export function decodeDouble(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getFloat64(0, true);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodeKey(fieldNumber: number, wireType: ProtoWireType): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function readVarint(bytes: Uint8Array, startOffset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let offset = startOffset;

  while (offset < bytes.length) {
    const byte = bytes[offset] ?? 0;
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [value >>> 0, offset];
    }
    shift += 7;
  }

  throw new Error("Truncated protobuf varint");
}
