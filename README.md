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
windsurf/swe-1.6                   Codeium internal model (enum 420)
windsurf/swe-1.6-fast              Codeium internal model fast variant (enum 421)
windsurf/claude-opus-4-7           Claude Opus 4.7 via Windsurf
windsurf/claude-opus-4-6           Claude Opus 4.6 via Windsurf (auto thinking)
```

### Model routing

Windsurf upstream `GetChatMessageRequest` uses three fields for model selection:

| Field | Name | Type | Internal | External |
|-------|------|------|----------|----------|
| 5 | `use_internal_chat_model` | bool | `1` | `0` |
| 6 | `internal_chat_model` | enum | model enum | (absent) |
| 21 | `chat_model_uid` | string | (absent) | model UID |
| 15 | `enterprise_chat_model_config` | message | (absent) | max tokens |

- Internal models (SWE-1.6): field 5=true, field 6=enum_value
- External models (Claude Opus): field 5=false, field 21=model_uid, field 15=token config

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

Internal models (swe-1.6) are unaffected by reasoning level.

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

In plain words:

- yes, local Windsurf needs to exist by default
- yes, you need to have logged in already
- yes, this extension uses that local existing credential state

## Optional env

- `WINDSURF_METADATA_API_KEY`
- `WINDSURF_API_KEY`
- `WINDSURF_API_SERVER_URL`
- `WINDSURF_STATE_DIR`
- `PI_WINDSURF_PROVIDER_URL`
- `PI_WINDSURF_PROVIDER_DEBUG=1`

If you set `WINDSURF_METADATA_API_KEY` or `WINDSURF_API_KEY`, that key is used directly instead of reading local credential state.

Default upstream endpoint is discovered from local Windsurf state when available, then falls back to:

- `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`

## Notes

- Extension is packaged for Pi community sharing through `pi install`
- Default model guidance is distilled from captured real Windsurf Cascade requests, then adapted to Pi runtime instead of copied verbatim
- Output history and tool follow-up have been verified in real Pi sessions
