# pi-windsurf-provider

Pi extension that exposes Windsurf upstream as Pi model provider `windsurf/swe-1.6`.

## What it does

- Uses your local Windsurf account credentials
- Talks to Windsurf upstream directly
- Keeps Pi system prompt, message history, tool calls, and tool results across turns
- Streams back text, thinking, and tool-call events
- Does not need local `language_server`

## Model

```text
windsurf/swe-1.6
```

Current route uses verified direct coding path for Pi-facing `SWE-1.6`.

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
pi install git:https://github.com/<owner>/pi-windsurf-provider
```

## Use

List models:

```bash
pi -e /absolute/path/to/pi-windsurf-provider --list-models windsurf
```

Run:

```bash
pi -e /absolute/path/to/pi-windsurf-provider --provider windsurf --model swe-1.6 -p --no-session "Say OK in one word"
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
- `WINDSURF_STATE_DIR`
- `PI_WINDSURF_PROVIDER_URL`
- `PI_WINDSURF_PROVIDER_DEBUG=1`

If you set `WINDSURF_METADATA_API_KEY`, that key is used directly instead of reading local `accounts.json`.

Default upstream endpoint:

- `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`

## Notes

- Extension is packaged for Pi community sharing through `pi install`
- Provider is intentionally focused on single Pi-facing model: `swe-1.6`
- Output history and tool follow-up have been verified in real Pi sessions
