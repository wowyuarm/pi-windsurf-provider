import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWindsurfProvider } from "./src/provider.ts";

const ACCOUNT_CLI_PATH = fileURLToPath(new URL("./bin/pi-windsurf-account.mjs", import.meta.url));

export default function (pi: ExtensionAPI) {
  registerWindsurfProvider(pi);

  pi.registerCommand("windsurf-account", {
    description: "Manage saved Windsurf accounts for automatic provider failover",
    handler: async (args, ctx) => {
      try {
        const output = execFileSync(process.execPath, [ACCOUNT_CLI_PATH, ...splitArgs(args)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        ctx.ui.notify(output || "Done", "info");
      } catch (error) {
        const message = renderCommandError(error);
        ctx.ui.notify(message, "error");
      }
    },
  });
}

function splitArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function renderCommandError(error: unknown): string {
  if (isExecError(error)) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    return stderr || stdout || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isExecError(value: unknown): value is Error & { stdout?: unknown; stderr?: unknown } {
  return value instanceof Error;
}
