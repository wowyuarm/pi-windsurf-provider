#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_ACCOUNTS_FILE = "~/.config/pi-windsurf-provider/accounts.json";
const DEFAULT_STATE_FILE = "~/.local/state/pi-windsurf-provider/account-state.json";

const args = process.argv.slice(2);
const command = args[0];

try {
  switch (command) {
    case "add-current":
    case "add":
      addCurrent();
      break;
    case "list":
      listAccounts();
      break;
    case "remove":
    case "rm":
      removeAccount();
      break;
    case "where":
      showPaths();
      break;
    case "state":
      showState();
      break;
    case "clear-state":
      clearState();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`pi-windsurf-account: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function addCurrent() {
  const name = readFlag("--name") ?? readFlag("-n");
  if (!name) {
    throw new Error("add-current needs --name <name>");
  }

  const current = readCurrentWindsurfAccount();
  const file = accountsFilePath();
  const payload = readAccountsFile(file);
  const accounts = payload.accounts.filter((account) => account.name !== name && account.apiKey !== current.apiKey);
  accounts.push({
    name,
    email: current.email,
    apiKey: current.apiKey,
    apiServerUrl: current.apiServerUrl,
  });

  writeAccountsFile(file, { accounts });
  console.log(`Saved ${name} (${current.email ?? "no email"}, ${hashKey(current.apiKey)})`);
  console.log(file);
}

function listAccounts() {
  const file = accountsFilePath();
  const payload = readAccountsFile(file);
  if (payload.accounts.length === 0) {
    console.log(`No accounts in ${file}`);
    return;
  }

  for (const account of payload.accounts) {
    const flags = [];
    if (account.disabled === true) flags.push("disabled");
    console.log([
      account.name ?? "(no name)",
      account.email ?? "-",
      account.apiServerUrl ?? "-",
      hashKey(account.apiKey),
      flags.join(","),
    ].filter(Boolean).join("\t"));
  }
}

function removeAccount() {
  const name = args[1];
  if (!name) {
    throw new Error("remove needs <name>");
  }
  const file = accountsFilePath();
  const payload = readAccountsFile(file);
  const before = payload.accounts.length;
  payload.accounts = payload.accounts.filter((account) => account.name !== name);
  if (payload.accounts.length === before) {
    throw new Error(`No account named ${name}`);
  }
  writeAccountsFile(file, payload);
  console.log(`Removed ${name}`);
}

function showPaths() {
  console.log(`accounts: ${accountsFilePath()}`);
  console.log(`state:    ${stateFilePath()}`);
}

function showState() {
  const path = stateFilePath();
  if (!existsSync(path)) {
    console.log(`No state file: ${path}`);
    return;
  }
  console.log(readFileSync(path, "utf8"));
}

function clearState() {
  const path = stateFilePath();
  if (existsSync(path)) {
    rmSync(path);
  }
  console.log(`Cleared ${path}`);
}

function readCurrentWindsurfAccount() {
  const records = [];
  for (const path of stateDatabaseCandidates()) {
    const record = readStateDatabaseAccount(path);
    if (record?.apiKey) {
      records.push(record);
    }
  }

  if (records.length === 0) {
    throw new Error("No logged-in Windsurf account found. Log in to Windsurf first, then run add-current again.");
  }

  records.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return records[0];
}

function readStateDatabaseAccount(path) {
  const authStatus = readStateDatabaseJson(path, "windsurfAuthStatus");
  const windsurfState = readStateDatabaseJson(path, "codeium.windsurf");
  const apiKey = typeof authStatus?.apiKey === "string" ? authStatus.apiKey.trim() : "";
  if (!apiKey) {
    return undefined;
  }
  const apiServerUrl = typeof windsurfState?.apiServerUrl === "string" ? windsurfState.apiServerUrl.trim().replace(/\/+$/, "") : undefined;
  const email = typeof windsurfState?.lastLoginEmail === "string" ? windsurfState.lastLoginEmail : undefined;
  return {
    apiKey,
    apiServerUrl,
    email,
    path,
    mtimeMs: statSync(path).mtimeMs,
  };
}

function readStateDatabaseJson(path, key) {
  try {
    const escapedKey = key.replace(/'/g, "''");
    const output = execFileSync("sqlite3", ["-json", path, `select value from ItemTable where key = '${escapedKey}';`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rows = JSON.parse(output || "[]");
    const value = rows?.[0]?.value;
    return typeof value === "string" ? JSON.parse(value) : undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("sqlite3 is required to read Windsurf login state. Install sqlite3 first.");
    }
    return undefined;
  }
}

function stateDatabaseCandidates() {
  const candidates = [join(homedir(), ".windsurf-server", "data", "User", "globalStorage", "state.vscdb")];
  const usersRoot = "/mnt/c/Users";
  try {
    for (const entry of readdirSync(usersRoot)) {
      candidates.push(join(usersRoot, entry, "AppData", "Roaming", "Windsurf", "User", "globalStorage", "state.vscdb"));
    }
  } catch {
  }
  return candidates.filter((path) => existsSync(path));
}

function readAccountsFile(path) {
  if (!existsSync(path)) {
    return { accounts: [] };
  }
  const text = readFileSync(path, "utf8").trim();
  if (!text) {
    return { accounts: [] };
  }
  const payload = JSON.parse(text);
  const accounts = Array.isArray(payload) ? payload : Array.isArray(payload?.accounts) ? payload.accounts : [];
  return {
    accounts: accounts
      .filter((account) => account && typeof account === "object" && typeof account.apiKey === "string")
      .map((account) => ({
        name: typeof account.name === "string" ? account.name : undefined,
        email: typeof account.email === "string" ? account.email : undefined,
        apiKey: account.apiKey,
        apiServerUrl: typeof account.apiServerUrl === "string" ? account.apiServerUrl.replace(/\/+$/, "") : undefined,
        disabled: account.disabled === true,
      })),
  };
}

function writeAccountsFile(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function accountsFilePath() {
  return expandHome(readFlag("--file") ?? process.env.PI_WINDSURF_ACCOUNTS_FILE ?? process.env.WINDSURF_ACCOUNTS_FILE ?? DEFAULT_ACCOUNTS_FILE);
}

function stateFilePath() {
  return expandHome(process.env.PI_WINDSURF_ACCOUNT_STATE_FILE ?? DEFAULT_STATE_FILE);
}

function readFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function hashKey(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function printHelp() {
  console.log(`Usage:
  pi-windsurf-account add-current --name <name> [--file <path>]
  pi-windsurf-account list [--file <path>]
  pi-windsurf-account remove <name> [--file <path>]
  pi-windsurf-account state
  pi-windsurf-account clear-state
  pi-windsurf-account where

Workflow:
  1. Log in to one Windsurf account in the Windsurf app.
  2. Run: pi-windsurf-account add-current --name ws-a
  3. Switch Windsurf to another account, then repeat with another name.
`);
}
