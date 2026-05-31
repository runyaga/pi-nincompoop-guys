# pi-nincompoop-guys

[pi](https://github.com/earendil-works/pi) coding-agent plugins for
[Pydantic Logfire](https://pydantic.dev/logfire). Two sibling extensions:

| Plugin | Role | Token scopes | Summary |
|--------|------|--------------|---------|
| [**pi-logfire-reader**](./pi-logfire-reader) | reader | `project:read` + `project:read_otlp` | Bridges the Logfire MCP server into pi as native `logfire_*` tools so the agent can **query** your telemetry (traces, metrics, SQL). |
| [**pi-logfire-writer**](./pi-logfire-writer) | writer | `project:write` + `project:write_otlp` | Ships pi's own activity to Logfire as **pydantic-ai-shaped** OpenTelemetry traces (`agent run` → `chat` → `running tool`). |

> **Scopes matter.** The reader's MCP tools need `project:read`, and querying
> trace/span data needs `project:read_otlp`. The writer's OTLP ingestion needs
> `project:write_otlp` (plus `project:write`). A token missing a scope fails with
> `insufficient_scope`; check any token with the reader's `logfire_token_info`
> tool. Read and write are usually **separate tokens**.

Run both together and pi can **read its own activity**: the writer records each
pi session as GenAI spans, and the reader lets pi query those spans back from
Logfire.

## ⚠️ Limitation: pi cannot observe its *current* turn

Self-observation is **not real-time within a single turn**. pi can only query
activity from a *prior, already-flushed* run — not what it is doing right now.

Why:

1. **The agent-run span closes at `agent_end`.** The current `agent run` (and its
   child `chat` / `running tool` spans) are still open while pi is working, so
   they don't exist in Logfire yet.
2. **The writer batches spans.** It uses an OTLP `BatchSpanProcessor` that flushes
   on a timer (~5 s) and on `session_shutdown` — not immediately per span.
3. **Logfire ingestion lag.** Even after export, spans take a few seconds to
   become queryable.

**Consequence:** a prompt like *"query Logfire for what you just did"* will miss
the current turn's spans. Self-observation works **across turns/runs**: act in
one run, then query in a later one (after flush + a few seconds of ingestion).
If you need the most recent run included, end the session (forces a flush) and
wait briefly before querying.

This is inherent to async OTLP export + a remote backend; it is **not** a bug in
either plugin. A future option could expose a `/logfire-flush` command (force
`forceFlush()`), but it cannot remove ingestion lag or close the in-flight span.

## Layout

```
pi-nincompoop-guys/
├── pi-logfire-reader/    # MCP reader extension  (+ README, tests, .env.example)
└── pi-logfire-writer/    # OTel writer extension (+ README, tests, examples/)
```

## Install with pi

Both plugins install together in one command. The repo is private, so this uses
your existing git credentials:

```bash
pi install git:github.com/runyaga/pi-nincompoop-guys
```

This clones the repo, installs dependencies, and registers **both** extensions
(reader + writer) from the root `package.json` into your pi settings. Then set
the tokens and run pi:

```bash
export LOGFIRE_READ_TOKEN="pylf_v2_us_..._read"     # reader: project:read + project:read_otlp
export LOGFIRE_WRITE_TOKEN="pylf_v2_us_..._write"   # writer: project:write + project:write_otlp
pi
```

Manage it like any pi package:

```bash
pi list                                                # confirm install
pi update git:github.com/runyaga/pi-nincompoop-guys    # update / move to a new ref
pi remove git:github.com/runyaga/pi-nincompoop-guys    # uninstall
pi install -l git:github.com/runyaga/pi-nincompoop-guys  # project-local (.pi/settings.json)
```

### Install just one plugin

Each subfolder is a standalone pi package. Clone, then install by local path:

```bash
git clone https://github.com/runyaga/pi-nincompoop-guys
pi install ./pi-nincompoop-guys/pi-logfire-reader      # reader only
pi install ./pi-nincompoop-guys/pi-logfire-writer      # writer only
```

### Try without installing

```bash
pi -e ./pi-logfire-reader/index.ts -e ./pi-logfire-writer/index.ts
```

## License

MIT.
