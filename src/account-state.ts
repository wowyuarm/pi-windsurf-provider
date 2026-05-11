import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { WindsurfAccountCredentials } from "./metadata.ts";

const DEFAULT_STATE_FILE = "~/.local/state/pi-windsurf-provider/account-state.json";
const DEFAULT_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface AccountStateFile {
  lastSuccessfulAccountId?: unknown;
  exhausted?: unknown;
}

interface ExhaustedAccountState {
  until: number;
  reason?: string;
  name?: string;
}

interface NormalizedAccountState {
  lastSuccessfulAccountId?: string;
  exhausted: Record<string, ExhaustedAccountState>;
}

export function orderAccountsForAttempt(accounts: WindsurfAccountCredentials[], now = Date.now()): WindsurfAccountCredentials[] {
  const state = loadAccountState();
  const available = accounts.filter((account) => !isAccountCoolingDown(account, state, now));
  if (available.length <= 1) {
    return available;
  }

  const lastSuccessful = state.lastSuccessfulAccountId
    ? available.find((account) => account.id === state.lastSuccessfulAccountId)
    : undefined;
  if (!lastSuccessful) {
    return available;
  }

  return [lastSuccessful, ...available.filter((account) => account.id !== lastSuccessful.id)];
}

export function markAccountSuccessful(account: WindsurfAccountCredentials): void {
  const state = loadAccountState();
  delete state.exhausted[account.id];
  state.lastSuccessfulAccountId = account.id;
  saveAccountState(state);
}

export function markAccountExhausted(account: WindsurfAccountCredentials, reason: string, now = Date.now()): void {
  const state = loadAccountState();
  state.exhausted[account.id] = {
    until: now + exhaustedCooldownMs(),
    reason: reason.slice(0, 500),
    name: account.name ?? account.email,
  };
  if (state.lastSuccessfulAccountId === account.id) {
    delete state.lastSuccessfulAccountId;
  }
  saveAccountState(state);
}

export function getAccountStateFilePath(): string {
  return expandHome(process.env.PI_WINDSURF_ACCOUNT_STATE_FILE?.trim() || DEFAULT_STATE_FILE);
}

export function getAccountId(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function isAccountCoolingDown(account: WindsurfAccountCredentials, state: NormalizedAccountState, now: number): boolean {
  const exhausted = state.exhausted[account.id];
  return typeof exhausted?.until === "number" && exhausted.until > now;
}

function loadAccountState(): NormalizedAccountState {
  const path = getAccountStateFilePath();
  if (!existsSync(path)) {
    return { exhausted: {} };
  }

  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as AccountStateFile;
    const exhausted: Record<string, ExhaustedAccountState> = {};
    if (isRecord(payload.exhausted)) {
      for (const [id, raw] of Object.entries(payload.exhausted)) {
        if (!isRecord(raw) || typeof raw.until !== "number") {
          continue;
        }
        exhausted[id] = {
          until: raw.until,
          reason: typeof raw.reason === "string" ? raw.reason : undefined,
          name: typeof raw.name === "string" ? raw.name : undefined,
        };
      }
    }
    return {
      lastSuccessfulAccountId: typeof payload.lastSuccessfulAccountId === "string" ? payload.lastSuccessfulAccountId : undefined,
      exhausted,
    };
  } catch {
    return { exhausted: {} };
  }
}

function saveAccountState(state: NormalizedAccountState): void {
  const path = getAccountStateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function exhaustedCooldownMs(): number {
  const value = process.env.PI_WINDSURF_ACCOUNT_COOLDOWN_MS?.trim();
  if (!value) {
    return DEFAULT_EXHAUSTED_COOLDOWN_MS;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXHAUSTED_COOLDOWN_MS;
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
