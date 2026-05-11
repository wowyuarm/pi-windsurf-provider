# pi-windsurf-provider

Pi extension that exposes Windsurf upstream as Pi model provider `windsurf`.

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
windsurf/claude-opus-4-7           Claude Opus 4.7 via Windsurf
windsurf/claude-opus-4-6           Claude Opus 4.6 via Windsurf (auto thinking)
```

### Model routing

Windsurf upstream `GetChatMessageRequest` selects models by external
`chat_model_uid` (field 21), with `use_internal_chat_model=false`:

| Field | Name | Type | Value |
|-------|------|------|-------|
| 5 | `use_internal_chat_model` | bool | `0` |
| 21 | `chat_model_uid` | string | resolved per-model UID |
| 15 | `enterprise_chat_model_config` | message | max tokens / context window |

The internal-enum path (field 6) is no longer used: SWE-1.6's old enum values
(420/421) are rejected by upstream as "internal error". The current SWE UIDs
are hyphenated (`swe-1-6`, `swe-1-6-fast`); the dotted forms `swe-1.6` /
`swe-1.6-fast` are not accepted.

Claude model parameters mirror Pi's native Anthropic model defaults:
- contextWindow: 1M, maxTokens: 128K
- cost: $5/M input, $25/M output

### Reasoning (thinking) mapping

Windsurf upstream is strict about which (UID, reasoning-suffix) combinations it
accepts. Pi's `reasoning` level is translated separately for each model:

**`claude-opus-4-7`** — every level uses an explicit suffixed UID; bare UID is rejected.

| Pi reasoning      | Windsurf UID                |
|-------------------|-----------------------------|
| `minimal` / `low` | `claude-opus-4-7-low`       |
| `medium`          | `claude-opus-4-7-medium`    |
| `high` (default)  | `claude-opus-4-7-high`      |
| `xhigh`           | `claude-opus-4-7-xhigh`     |

**`claude-opus-4-6`** — only the bare UID and the dedicated `-thinking` UID are
accepted; reasoning suffixes are rejected. Pi's reasoning level is mapped to a
thinking on/off switch.

| Pi reasoning      | Windsurf UID                  |
|-------------------|-------------------------------|
| `minimal` / `low` | `claude-opus-4-6`             |
| `medium`          | `claude-opus-4-6-thinking`    |
| `high` (default)  | `claude-opus-4-6-thinking`    |
| `xhigh`           | `claude-opus-4-6-thinking`    |

**`swe-1.6` / `swe-1.6-fast`** — only the bare UID is accepted; reasoning suffixes
are rejected. The reasoning level Pi passes is currently ignored for these models.

## Install

Local dev:

```bash
pi -e /absolute/path/to/pi-windsurf-provider
```

Install from local path as Pi package:

```bash
pi install /absolute/path/to/pi-windsurf-provider
```

As Pi package after publishing repo:

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
- Windsurf installed on same machine
- Windsurf logged in at least once on that machine so local account data exists

Default setup uses your existing local Windsurf credentials. It does not need local `language_server`, but it does read Windsurf account data already stored on disk.

Reads existing Windsurf account data from:

- `~/.windsurf-server/data/User/globalStorage/**/accounts.json`
- `~/.windsurf-server/data/User/globalStorage/state.vscdb`
- WSL Windows install: `/mnt/c/Users/*/AppData/Roaming/Windsurf/User/globalStorage/state.vscdb`

In plain words:

- yes, local Windsurf needs to exist by default
- yes, you need to have logged in already
- yes, this extension uses that local existing credential state

## Multiple accounts

You can save several already-logged-in Windsurf accounts into a local account pool. The provider keeps using the last successful account, and only switches when Windsurf returns a usage/quota-style error before any answer text has streamed.

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

`list` calls Windsurf `GetUserStatus` for each saved account and shows plan + credits. Use `--no-usage` for a local-only list.

The same commands are available from shell if `pi-windsurf-account` is on `PATH`:

```bash
pi-windsurf-account add-current --name ws-a
pi-windsurf-account list
pi-windsurf-account list --no-usage
```

Useful commands:

```text
/windsurf-account remove ws-a
/windsurf-account state
/windsurf-account clear-state
/windsurf-account where
```

Shell equivalents use the same arguments with `pi-windsurf-account`.

The account file is written with `0600` permissions. It contains Windsurf API keys, so do not commit or share it.

If the account pool exists and has accounts, the provider uses the pool. If it does not exist or is empty, it falls back to the current local Windsurf login as before.

## Optional env

- `WINDSURF_METADATA_API_KEY`
- `WINDSURF_API_KEY`
- `WINDSURF_API_SERVER_URL`
- `WINDSURF_STATE_DIR`
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

- Extension is packaged for Pi community sharing through `pi install`
- Default model guidance is distilled from captured real Windsurf Cascade requests, then adapted to Pi runtime instead of copied verbatim
- Output history and tool follow-up have been verified in real Pi sessions
