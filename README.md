# pi-windsurf-provider

Pi extension that exposes Windsurf upstream as Pi model provider `windsurf`.

## Important note

This project works, but it is **not** a drop-in full-time replacement for using Windsurf directly.

Why:

- Pi and Windsurf do not count prompt usage the same way
- a Pi tool-using workflow can still consume prompts less efficiently than the official Windsurf/Cascade app
- recent builds reduce this by sending only the new follow-up messages in the same conversation instead of replaying full history every time
- more work and other approaches are still being explored to make this more usable

If you mainly want the cheapest / safest day-to-day usage, do not route all of your work through this provider yet.

## What it does

- Uses your local Windsurf account credentials
- Talks to Windsurf upstream directly
- Keeps Pi system prompt, message history, tool calls, and tool results across turns
- Streams back text, thinking, and tool-call events
- Does not need local `language_server`

## Models

```text
windsurf/swe-1.6                   Cognition SWE-1.6 (uid "swe-1-6")
windsurf/swe-1.6-fast              Cognition SWE-1.6 Fast (uid "swe-1-6-fast")
windsurf/gpt-5.5                   GPT-5.5 via Windsurf
windsurf/claude-opus-4-7           Claude Opus 4.7 via Windsurf
windsurf/claude-opus-4-6           Claude Opus 4.6 via Windsurf
```

## Install

Local dev:

```bash
pi -e /absolute/path/to/pi-windsurf-provider
```

Install from local path as Pi package:

```bash
pi install /absolute/path/to/pi-windsurf-provider
```

Install from GitHub:

```bash
pi install git:https://github.com/wowyuarm/pi-windsurf-provider
```

## Use

List models:

```bash
pi -e /absolute/path/to/pi-windsurf-provider --list-models windsurf
```

Run:

```bash
pi -e /absolute/path/to/pi-windsurf-provider --provider windsurf --model claude-opus-4-6 -p --no-session "Say OK in one word"
```

## Requirements

- Pi installed
- Windsurf installed on the same machine
- Windsurf logged in at least once on that machine so local account data exists

Default setup uses your existing local Windsurf credentials. It does not need local `language_server`, but it does read Windsurf account data already stored on disk.

Default discovery currently covers:

- Linux / WSL state dir: `~/.windsurf-server/data`
- WSL Windows install: `/mnt/c/Users/*/AppData/Roaming/Windsurf/User/globalStorage/state.vscdb`

In plain words:

- yes, local Windsurf needs to exist by default
- yes, you need to have logged in already
- yes, this extension uses that local existing credential state

## macOS setup

On macOS, set the Windsurf state directory explicitly before using the provider:

```bash
export WINDSURF_STATE_DIR="$HOME/Library/Application Support/Windsurf"
```

Minimal test:

```bash
WINDSURF_STATE_DIR="$HOME/Library/Application Support/Windsurf" \
pi --provider windsurf --model swe-1.6 -p --no-session "Say OK"
```

If you want the request metadata to match macOS more closely, you can also try:

```bash
export WINDSURF_OS=darwin
```

## Model routing

Windsurf upstream `GetChatMessageRequest` selects models by external `chat_model_uid` (field 21), with `use_internal_chat_model=false`.

| Field | Name | Value |
|-------|------|-------|
| 5 | `use_internal_chat_model` | `0` |
| 21 | `chat_model_uid` | resolved per-model UID |
| 15 | `enterprise_chat_model_config` | max tokens / context window |

The old SWE internal-enum path is no longer used. Upstream now rejects the old enum-based SWE path with internal errors. Current SWE routing uses hyphenated UIDs:

- `swe-1-6`
- `swe-1-6-fast`

The dotted forms `swe-1.6` / `swe-1.6-fast` are model ids in Pi, not the upstream UIDs sent to Windsurf.

## Reasoning mapping

Windsurf is strict about which model UID variants it accepts. Pi reasoning levels are mapped per model.

### `claude-opus-4-7`

Every reasoning level uses an explicit suffixed UID. Bare UID is rejected.

| Pi reasoning      | Windsurf UID                |
|-------------------|-----------------------------|
| `minimal` / `low` | `claude-opus-4-7-low`       |
| `medium`          | `claude-opus-4-7-medium`    |
| `high` (default)  | `claude-opus-4-7-high`      |
| `xhigh`           | `claude-opus-4-7-xhigh`     |

### `claude-opus-4-6`

Uses either the base model or the separate `-thinking` variant.

| Pi reasoning      | Windsurf UID                  |
|-------------------|-------------------------------|
| `minimal` / `low` | `claude-opus-4-6`             |
| `medium`          | `claude-opus-4-6-thinking`    |
| `high` (default)  | `claude-opus-4-6-thinking`    |
| `xhigh`           | `claude-opus-4-6-thinking`    |

### `gpt-5.5`

Follows the same suffix pattern as Opus 4.7.

| Pi reasoning      | Windsurf UID         |
|-------------------|----------------------|
| `minimal` / `low` | `gpt-5-5-low`        |
| `medium`          | `gpt-5-5-medium`     |
| `high` (default)  | `gpt-5-5-high`       |
| `xhigh`           | `gpt-5-5-xhigh`      |

### `swe-1.6` / `swe-1.6-fast`

Only the bare UID is accepted. Pi reasoning is currently ignored for these models.

## Multiple accounts

You can save several already-logged-in Windsurf accounts into a local account pool.

Default files:

- accounts: `~/.config/pi-windsurf-provider/accounts.json`
- switch state: `~/.local/state/pi-windsurf-provider/account-state.json`

Workflow inside Pi:

```text
# 1. Log in to Windsurf account A in the Windsurf app.
/windsurf-account add-current --name ws-a

# 2. Switch/login to Windsurf account B in the app.
/windsurf-account add-current --name ws-b

# 3. Check saved accounts and current usage.
/windsurf-account list
```

The provider keeps using the last successful account, and only switches when Windsurf returns a recoverable account-side failure before any answer text has streamed.

`list` calls Windsurf `GetUserStatus` for each saved account and shows the useful fields by default: account name, email, plan, and daily/weekly remaining quota.

Useful shell commands:

```bash
pi-windsurf-account add-current --name ws-a
pi-windsurf-account list
pi-windsurf-account list --no-usage
pi-windsurf-account list --verbose
pi-windsurf-account remove ws-a
pi-windsurf-account state
pi-windsurf-account clear-state
pi-windsurf-account where
```

The account file is written with `0600` permissions. It contains Windsurf API keys, so do not commit or share it.

If the account pool exists and has accounts, the provider uses the pool. If it does not exist or is empty, it falls back to the current local Windsurf login.

## Current behavior notes

### Prompt usage

Recent builds now send only the new continuation messages in the same conversation instead of replaying the full message history on every follow-up request. This is meant to reduce waste and make tool-using flows less expensive.

That said, prompt usage still does **not** perfectly match the official Windsurf app, so treat this project as useful but not fully solved.

### Error handling

Recent builds also improved how account failures are treated:

- usage / quota problems can trigger account failover
- some temporary upstream-side failures are retried without permanently punishing that account
- rate limit errors are surfaced more clearly

## Optional env

- `WINDSURF_METADATA_API_KEY`
- `WINDSURF_API_KEY`
- `WINDSURF_API_SERVER_URL`
- `WINDSURF_STATE_DIR`
- `WINDSURF_OS`
- `PI_WINDSURF_ACCOUNTS_FILE`
- `PI_WINDSURF_ACCOUNT_STATE_FILE`
- `PI_WINDSURF_ACCOUNT_COOLDOWN_MS`
- `PI_WINDSURF_USAGE_TIMEOUT_MS`
- `PI_WINDSURF_PROVIDER_URL`
- `PI_WINDSURF_PROVIDER_DEBUG=1`

If you set `WINDSURF_METADATA_API_KEY` or `WINDSURF_API_KEY`, that key is used directly instead of reading local credential state.

Default upstream endpoint is discovered from local Windsurf state when available, then falls back to:

- `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`

## Notes

- packaged for `pi install`
- model behavior was inferred from captured real Windsurf Cascade requests, then adapted for Pi
- output history and tool follow-up have been verified in real Pi sessions
