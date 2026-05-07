import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { arch, cpus, homedir, hostname, platform, release, userInfo, version } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  concatBytes,
  decodeProtoFields,
  encodeMessageField,
  encodeStringField,
  encodeTimestampField,
  encodeVarintField,
  getStringField,
} from "./proto.ts";

const AUTH_URL = "https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt";
const DEFAULT_STATE_DIR = "~/.windsurf-server/data";
const DEFAULT_IDE_NAME = "windsurf";
const DEFAULT_IDE_VERSION = "1.110.1";
const DEFAULT_EXTENSION_NAME = "windsurf";
const DEFAULT_EXTENSION_VERSION = "0.2.0";
const DEFAULT_LOCALE = "en";
const DEFAULT_OS = "linux";
const ACCOUNTS_FILE_NAME = "accounts.json";
const USER_JWT_CACHE_MS = 5 * 60 * 1000;

export interface WindsurfMetadataConfig {
  stateDir: string;
  ideName: string;
  ideVersion: string;
  extensionName: string;
  extensionVersion: string;
  locale: string;
  os: string;
}

interface AccountRecord {
  apiKey?: unknown;
  apiServerUrl?: unknown;
  isActive?: unknown;
}

let cachedUserJwt:
  | {
      apiKey: string;
      value: string;
      expiresAt: number;
    }
  | undefined;

let nextRequestId = 1;

export function loadMetadataConfig(): WindsurfMetadataConfig {
  return {
    stateDir: expandHome(readEnv(["WINDSURF_STATE_DIR"]) ?? DEFAULT_STATE_DIR),
    ideName: readEnv(["WINDSURF_IDE_NAME"]) ?? DEFAULT_IDE_NAME,
    ideVersion: readEnv(["WINDSURF_IDE_VERSION"]) ?? DEFAULT_IDE_VERSION,
    extensionName: readEnv(["WINDSURF_EXTENSION_NAME"]) ?? DEFAULT_EXTENSION_NAME,
    extensionVersion: readEnv(["WINDSURF_EXTENSION_VERSION"]) ?? DEFAULT_EXTENSION_VERSION,
    locale: readEnv(["WINDSURF_LOCALE"]) ?? DEFAULT_LOCALE,
    os: readEnv(["WINDSURF_OS"]) ?? DEFAULT_OS,
  };
}

export async function buildRequestMetadataBytes(sessionId: string = crypto.randomUUID()): Promise<Uint8Array> {
  const config = loadMetadataConfig();
  const apiKey = discoverMetadataApiKey(config);
  const userJwt = await fetchUserJwt(apiKey, config);
  const requestId = takeRequestId();
  const deviceFingerprint = computeDeviceFingerprint();

  return concatBytes(
    encodeStringField(1, config.ideName),
    encodeStringField(2, config.extensionVersion),
    encodeStringField(3, apiKey),
    encodeStringField(4, config.locale),
    encodeStringField(5, JSON.stringify(buildOsInfo(config.os))),
    encodeStringField(7, config.ideVersion),
    encodeStringField(8, JSON.stringify(buildHardwareInfo())),
    encodeVarintField(9, requestId),
    encodeStringField(10, sessionId),
    encodeStringField(12, config.extensionName),
    encodeTimestampField(16),
    encodeStringField(21, userJwt),
    encodeStringField(24, deviceFingerprint),
    encodeStringField(27, crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")),
  );
}

export function discoverMetadataApiKey(config = loadMetadataConfig()): string {
  const envValue = readEnv(["WINDSURF_METADATA_API_KEY", "WINDSURF_API_KEY"]);
  if (envValue) {
    return envValue;
  }

  const chosen = chooseAccount(loadCredentialRecords(config.stateDir));
  const apiKey = typeof chosen?.apiKey === "string" ? chosen.apiKey.trim() : "";
  if (apiKey) {
    return apiKey;
  }

  throw new Error("Unable to discover Windsurf api key. Set WINDSURF_METADATA_API_KEY or WINDSURF_API_KEY.");
}

export function discoverApiServerBaseUrl(config = loadMetadataConfig()): string | undefined {
  const envValue = readEnv(["WINDSURF_API_SERVER_URL"]);
  if (envValue) {
    return envValue.replace(/\/+$/, "");
  }

  const chosen = chooseAccount(loadCredentialRecords(config.stateDir));
  const apiServerUrl = typeof chosen?.apiServerUrl === "string" ? chosen.apiServerUrl.trim() : "";
  return apiServerUrl ? apiServerUrl.replace(/\/+$/, "") : undefined;
}

async function fetchUserJwt(apiKey: string, config: WindsurfMetadataConfig): Promise<string> {
  const now = Date.now();
  if (cachedUserJwt && cachedUserJwt.apiKey === apiKey && cachedUserJwt.expiresAt > now) {
    return cachedUserJwt.value;
  }

  const payload = encodeMessageField(
    1,
    concatBytes(
      encodeStringField(1, config.ideName),
      encodeStringField(2, config.extensionVersion),
      encodeStringField(3, apiKey),
      encodeStringField(4, config.locale),
      encodeStringField(5, config.os),
      encodeStringField(7, config.ideVersion),
      encodeVarintField(9, 1),
      encodeStringField(10, crypto.randomUUID()),
      encodeStringField(12, config.extensionName),
      encodeStringField(24, computeDeviceFingerprint()),
    ),
  );

  const response = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      "Accept-Encoding": "gzip",
      "Connect-Protocol-Version": "1",
      "Content-Type": "application/proto",
    },
    body: toArrayBuffer(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch Windsurf user JWT: ${response.status} ${response.statusText}: ${body}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const userJwt = getStringField(decodeProtoFields(bytes), 1);
  if (!userJwt) {
    throw new Error("Windsurf AuthService/GetUserJwt returned no userJwt");
  }

  cachedUserJwt = {
    apiKey,
    value: userJwt,
    expiresAt: now + USER_JWT_CACHE_MS,
  };

  return userJwt;
}

function loadCredentialRecords(stateDir: string): AccountRecord[] {
  const records = [...loadAccounts(stateDir), ...loadStateDatabaseAuthRecords(stateDir), ...loadWindowsStateDatabaseAuthRecords()];
  records.sort(compareActiveFirst);
  return records;
}

function chooseAccount(accounts: AccountRecord[]): AccountRecord | undefined {
  return accounts.find((item) => item.isActive === true) ?? accounts[0];
}

function loadAccounts(stateDir: string): AccountRecord[] {
  const root = join(stateDir, "User", "globalStorage");
  if (!existsSync(root)) {
    return [];
  }

  const files = findFilesNamed(root, ACCOUNTS_FILE_NAME);
  const accounts: AccountRecord[] = [];

  for (const file of files) {
    try {
      const text = readFileSync(file, "utf8");
      const payload = JSON.parse(text) as unknown;
      const normalized = normalizeAccountsPayload(payload);
      normalized.sort(compareActiveFirst);
      accounts.push(...normalized);
    } catch {
    }
  }

  return accounts;
}

function loadStateDatabaseAuthRecords(stateDir: string): AccountRecord[] {
  return loadAuthRecordsFromStateDatabase(join(stateDir, "User", "globalStorage", "state.vscdb"));
}

function loadWindowsStateDatabaseAuthRecords(): AccountRecord[] {
  const records: AccountRecord[] = [];
  for (const path of windowsWindsurfStateDatabaseCandidates()) {
    records.push(...loadAuthRecordsFromStateDatabase(path));
  }
  return records;
}

function loadAuthRecordsFromStateDatabase(path: string): AccountRecord[] {
  if (!existsSync(path)) {
    return [];
  }

  const rows = readStateDatabaseJsonRows(path, ["windsurfAuthStatus", "codeium.windsurf"]);
  const authStatus = rows.get("windsurfAuthStatus");
  const windsurfState = rows.get("codeium.windsurf");
  const apiServerUrl = typeof windsurfState?.apiServerUrl === "string" ? windsurfState.apiServerUrl : undefined;
  const apiKey = typeof authStatus?.apiKey === "string" ? authStatus.apiKey : undefined;
  if (!apiKey && !apiServerUrl) {
    return [];
  }
  return [{ apiKey, apiServerUrl, isActive: true }];
}

function readStateDatabaseJsonRows(path: string, keys: string[]): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  try {
    const sql = `select key, value from ItemTable where key in (${keys.map((key) => `'${key.replace(/'/g, "''")}'`).join(",")});`;
    const output = execFileSync("sqlite3", ["-separator", "\t", path, sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split(/\r?\n/)) {
      const separator = line.indexOf("\t");
      if (separator === -1) {
        continue;
      }
      const key = line.slice(0, separator);
      const value = parseJsonRecord(line.slice(separator + 1));
      if (value) {
        rows.set(key, value);
      }
    }
  } catch {
  }
  return rows;
}

function windowsWindsurfStateDatabaseCandidates(): string[] {
  const usersRoot = "/mnt/c/Users";
  try {
    return readdirSync(usersRoot)
      .map((entry) => join(usersRoot, entry, "AppData", "Roaming", "Windsurf", "User", "globalStorage", "state.vscdb"))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAccountsPayload(payload: unknown): AccountRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    const maybeAccounts = payload.accounts;
    if (Array.isArray(maybeAccounts)) {
      return maybeAccounts.filter(isRecord);
    }
    return [payload];
  }
  return [];
}

function compareActiveFirst(left: AccountRecord, right: AccountRecord): number {
  const leftActive = left.isActive === true ? 0 : 1;
  const rightActive = right.isActive === true ? 0 : 1;
  return leftActive - rightActive;
}

function computeDeviceFingerprint(): string {
  const serial = readFirstNonEmpty([
    "/sys/class/dmi/id/product_serial",
    "/sys/class/dmi/id/product_uuid",
    "/etc/machine-id",
  ]);

  const macAddresses: string[] = [];
  try {
    for (const entry of readdirSync("/sys/class/net")) {
      try {
        const address = readFileSync(join("/sys/class/net", entry, "address"), "utf8").trim();
        if (address && address !== "00:00:00:00:00:00") {
          macAddresses.push(address);
        }
      } catch {
      }
    }
  } catch {
  }

  const seed = [serial, macAddresses.sort().join(","), userInfo().username].sort().join("");
  return sha512Hex(seed);
}

function buildOsInfo(defaultOs: string): Record<string, string> {
  return {
    Os: defaultOs,
    Arch: arch(),
    Release: release(),
    Version: version(),
    Machine: arch(),
    Nodename: hostname(),
    Sysname: platform(),
  };
}

function buildHardwareInfo(): Record<string, string | number> {
  const info = {
    NumSockets: 1,
    NumCores: Math.max(1, cpuCountFromProc() ?? osCpuCount()),
    NumThreads: Math.max(1, osCpuCount()),
    VendorID: "",
    Family: "",
    Model: "",
    ModelName: "",
    Memory: memoryBytesFromProc(),
  };

  try {
    const cpuInfo = readFileSync("/proc/cpuinfo", "utf8");
    const blocks = cpuInfo.split("\n\n").filter((block) => block.trim().length > 0);
    const sockets = new Set<string>();

    for (const block of blocks) {
      const values = new Map<string, string>();
      for (const line of block.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) {
          continue;
        }
        values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }

      const socketId = values.get("physical id");
      if (socketId) {
        sockets.add(socketId);
      }

      info.VendorID ||= values.get("vendor_id") ?? "";
      info.Family ||= values.get("cpu family") ?? "";
      info.Model ||= values.get("model") ?? "";
      info.ModelName ||= values.get("model name") ?? "";

      const cpuCores = values.get("cpu cores");
      if (cpuCores) {
        const parsed = Number.parseInt(cpuCores, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          info.NumCores = parsed;
        }
      }
    }

    if (sockets.size > 0) {
      info.NumSockets = sockets.size;
    }
  } catch {
  }

  return info;
}

function cpuCountFromProc(): number | undefined {
  try {
    return readFileSync("/proc/cpuinfo", "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("processor"))
      .length;
  } catch {
    return undefined;
  }
}

function memoryBytesFromProc(): number {
  try {
    const line = readFileSync("/proc/meminfo", "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("MemTotal:"));
    if (!line) {
      return 0;
    }
    const kibibytes = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : 0;
  } catch {
    return 0;
  }
}

function osCpuCount(): number {
  return cpus().length || 1;
}

function sha512Hex(value: string): string {
  return createHash("sha512").update(value).digest("hex");
}

function takeRequestId(): number {
  const value = nextRequestId;
  nextRequestId += 1;
  return value;
}

function readFirstNonEmpty(paths: string[]): string {
  for (const path of paths) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) {
        return value;
      }
    } catch {
    }
  }
  return "";
}

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function findFilesNamed(root: string, fileName: string): string[] {
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(fullPath);
      } else if (stats.isFile() && entry === fileName) {
        results.push(fullPath);
      }
    }
  }

  return results;
}
