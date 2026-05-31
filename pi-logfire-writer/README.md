# pi-logfire-writer

A [pi](https://github.com/earendil-works/pi) coding-agent extension that **ships
pi's OpenTelemetry traces to [Pydantic Logfire](https://pydantic.dev/logfire)**.

It is the *write* counterpart to a Logfire MCP *reader*: instead of querying
telemetry, this **produces** it — every pi prompt becomes a span tree in your
Logfire project.

## Built on pi-otel

This is a thin **Logfire preset** on top of [`pi-otel`](https://github.com/NikiforovAll/pi-otel),
which does the heavy lifting: it wires pi's lifecycle events into an OTel span
tree and exports it via OTLP.

```
pi (agent)
  └─ pi-logfire-writer        ← this package: Logfire endpoint + write-token auth
       └─ pi-otel             ← span tree: pi.interaction → pi.llm_request / pi.tool.<name>
            └─ OTLP/HTTP (protobuf, Authorization: <write-token>)
                 └─ https://logfire-us.pydantic.dev:443/v1/traces
```

pi-logfire-writer's job is purely to point pi-otel's export at Logfire and
authenticate it, so you don't hand-configure `OTEL_EXPORTER_OTLP_*` yourself.

## Requirements

- `pi` (`@earendil-works/pi-coding-agent`)
- A Logfire **write token** (`project:write` scope)
- Node.js ≥ 20

## Install

```bash
pi install git:github.com/<you>/pi-logfire-writer
```

Or load locally for development:

```bash
git clone <this repo> && cd pi-logfire-writer
npm install
export LOGFIRE_WRITE_TOKEN="pylf_v2_us_..."
pi -e ./index.ts
```

## Configuration

The write token is read from the environment and is **never hardcoded**.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LOGFIRE_WRITE_TOKEN` | yes | — | Logfire write token. `LOGFIRE_TOKEN` also accepted. |
| `LOGFIRE_REGION` | no | inferred from token, else `us` | `us` or `eu`. |
| `LOGFIRE_WRITER_ENDPOINT` | no | region URL | Override base/OTLP URL for self-hosted Logfire. |
| `PI_LOGFIRE_WRITER_DISABLED` | no | — | Set to `1` to hard-disable export. |

The endpoint resolves to `https://logfire-<region>.pydantic.dev:443/v1/traces`.
The explicit `:443` is intentional — pi-otel probes the endpoint (and refuses
one without a port) and passes it verbatim to the OTLP exporter.

> **Token region must match.** A `pylf_v2_us_*` token only authenticates against
> the US endpoint, `pylf_v?_eu_*` only against EU. Mismatch → `Unauthorized`.

pi-otel's own knobs still apply (e.g. `PI_OTEL_CAPTURE_CONTENT`,
`OTEL_SERVICE_NAME`, `sampleRatio` in `.pi/settings.json`). Any
`OTEL_EXPORTER_OTLP_*` value you set yourself is respected and not overwritten.

See [`.env.example`](./.env.example).

## Commands

| Command | What it does |
|---------|--------------|
| `/logfire-writer-status` | Show whether export is enabled, the target endpoint, region, and a masked token |

## What gets exported

pi-otel emits a per-prompt span tree:

- `pi.interaction` — one per user prompt
  - `pi.llm_request` — model, token usage, finish reason, response id
  - `pi.tool.<name>` — one per tool call, with id and error status

By default only metadata is captured (no prompt/response text); raise
`PI_OTEL_CAPTURE_CONTENT` to include content. Scope is **traces only** — pi-otel
sends every signal to a single verbatim endpoint, so metrics/logs would
mis-route to `/v1/traces` and are intentionally not enabled by this preset.

## A note on the startup "not reachable" message

pi-otel gates wiring behind a 300 ms raw-TCP reachability probe designed for
local collectors. Against Logfire's HTTPS cloud endpoint that probe can
occasionally flap on a cold start and print *"OTLP endpoint … not reachable"*.
pi-logfire-writer handles this: it force-wires the exporter via pi-otel's
`pi-otel:dashboard-ready` hook (which skips the probe), so export still works.
Run `/logfire-writer-status` to confirm, or check your Logfire Live view.

## Development & tests

```bash
npm install
npm test        # node --test (unit + integration)
```

- `logfire-config.ts` — pure config resolution (token → region → endpoint →
  OTLP env). Fully unit-tested.
- `index.ts` — applies the preset and delegates to pi-otel; integration-tested
  with a fake `pi` (verifies preset application, no-clobber of user env,
  delegation, and the disabled path).

## Credits

Built on [pi-otel](https://github.com/NikiforovAll/pi-otel) by nikiforovall
(Apache-2.0). This package is MIT-licensed.
