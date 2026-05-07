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
windsurf/swe-1.6
windsurf/claude-opus-4.6-thinking
```

Both routes use verified direct coding path and keep Pi-facing prompts, history, and tools.

`claude-opus-4.6-thinking` maps to Windsurf's Opus 4.6 High Thinking route.

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
pi -e /absolute/path/to/pi-windsurf-provider --provider windsurf --model claude-opus-4.6-thinking -p --no-session "Say OK in one word"
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
- `swe-1.6` uses legacy Windsurf numeric model id `377`
- `claude-opus-4.6-thinking` uses Windsurf `chat_model_uid`
- Default model guidance is distilled from captured real Windsurf Cascade requests, then adapted to Pi runtime instead of copied verbatim
- Output history and tool follow-up have been verified in real Pi sessions
