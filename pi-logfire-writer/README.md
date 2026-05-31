# pi-logfire-writer

A [pi](https://github.com/earendil-works/pi) coding-agent extension that **ships
pi's activity to [Pydantic Logfire](https://pydantic.dev/logfire) as
OpenTelemetry traces shaped exactly like [pydantic-ai](https://ai.pydantic.dev)'s** —
so pi sessions render in Logfire's GenAI / agent views just like a pydantic-ai app.

It is the *write* counterpart to a Logfire MCP *reader*: instead of querying
telemetry, it **produces** it.

## Span shape (matches pydantic-ai)

```
agent run                 gen_ai.operation.name = invoke_agent
├─ chat <model>           gen_ai.operation.name = chat
└─ running tool           gen_ai.operation.name = execute_tool
```

The structure and attributes were reverse-engineered from real pydantic-ai
traces in Logfire and mirrored:

| span | key attributes |
|------|----------------|
| `agent run` | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.conversation.id`, aggregate `gen_ai.usage.*`, `final_result`, `model_name` |
| `chat <model>` | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.usage.*`, `gen_ai.input.messages`, `gen_ai.output.messages` |
| `running tool` | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `tool_arguments`, `tool_response` |

`gen_ai.input.messages` / `gen_ai.output.messages` use pydantic-ai's
`{role, parts:[{type:"text"|"thinking"|"tool_call", …}]}` shape and accumulate
the running conversation across turns.

## Requirements

- `pi` (`@earendil-works/pi-coding-agent`)
- A Logfire **write token** with the **`project:write`** and **`project:write_otlp`**
  scopes (`project:write_otlp` is what authorizes OTLP trace ingestion)
- Node.js ≥ 18

## Install

```bash
git clone <repo> && cd pi-logfire-writer
npm install
export LOGFIRE_WRITE_TOKEN="pylf_v2_us_..."
pi -e ./index.ts
```

## Configuration (token never hardcoded)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LOGFIRE_WRITE_TOKEN` | yes | — | Logfire write token. Needs **`project:write`** + **`project:write_otlp`** scopes. `LOGFIRE_TOKEN` also accepted. |
| `LOGFIRE_REGION` | no | inferred from token, else `us` | `us` or `eu`. |
| `LOGFIRE_WRITER_ENDPOINT` | no | region URL | Override OTLP base for self-hosted Logfire. |
| `PI_LOGFIRE_WRITER_CAPTURE_CONTENT` | no | `full` | `metadata_only` \| `no_tool_content` \| `full`. Defaults to `full` (pydantic-ai parity: records prompts/responses/tool IO so Logfire shows Input/Output/Thoughts). Set `metadata_only` to omit message bodies. `PI_OTEL_CAPTURE_CONTENT` also accepted. |
| `PI_LOGFIRE_WRITER_START_PAUSED` | no | `false` | `True`/`1` starts configured-but-**paused** (no spans until `/logfire-resume`). |
| `PI_LOGFIRE_WRITER_DISABLED` | no | — | `1` to hard-disable export (no commands, no wiring). |

Endpoint resolves to `https://logfire-<region>.pydantic.dev:443/v1/traces`
(traces are exported over OTLP/HTTP protobuf with `Authorization: <token>`).

> **Token region must match.** A `pylf_v2_us_*` token only authenticates against
> the US endpoint; `pylf_v?_eu_*` only against EU.

> **Content capture defaults to `full`** so Logfire's GenAI Input/Output/Thoughts
> panels populate like pydantic-ai (prompts, responses, and tool IO are sent to
> Logfire). Set `PI_LOGFIRE_WRITER_CAPTURE_CONTENT=metadata_only` to record only
> structure, models, token usage, finish reasons, and tool names — no message
> bodies. Message attributes carry `logfire.json_schema` so Logfire renders them
> as structured panels rather than raw strings.

## Commands

| Command | What it does |
|---------|--------------|
| `/logfire-writer-status` | Show whether export is enabled/paused, the endpoint, region, masked token, and capture mode |
| `/logfire-pause` | Pause tracing — stop emitting spans (an in-flight run still finishes) |
| `/logfire-resume` | Resume tracing |
| `/logfire-toggle` | Toggle tracing on/off |

You don't always need tracing — pause it for a few prompts, then resume. Start a
session already paused with `PI_LOGFIRE_WRITER_START_PAUSED=1`.

## How it maps pi → GenAI spans

| pi lifecycle event | effect |
|--------------------|--------|
| `before_agent_start` | open `agent run` (captures prompt + system prompt) |
| `before_provider_request` | open `chat <model>` (snapshots conversation as input messages) |
| `message_end` (assistant) | finalize `chat`: output messages, finish reason, usage, response model |
| `tool_execution_start` / `_end` | open/close `running tool` with args + response |
| `agent_end` | close `agent run` with final result + aggregate usage |
| `session_shutdown` | flush + shut down the exporter |

## Development & tests

```bash
npm install
npm test        # node --test — 21 tests
```

- `genai-attrs.ts` — pure GenAI attribute constants + message extraction helpers
- `genai-spans.ts` — the span tracker (`agent run` / `chat` / `running tool`)
- `otel-sdk.ts` — trace-only OTLP→Logfire SDK bootstrap
- `logfire-config.ts` — token/region/endpoint/capture resolution
- `index.ts` — wires pi lifecycle events into the tracker
- `test/` — config resolution, extension wiring, and span-mapping tests
  (driven through an in-memory exporter; asserts span names + `gen_ai.*` attrs)

## Credits

Span/event mapping is modeled on
[pydantic-ai](https://ai.pydantic.dev)'s OTel GenAI conventions and inspired by
the [pi-otel](https://github.com/NikiforovAll/pi-otel) extension. MIT-licensed.
