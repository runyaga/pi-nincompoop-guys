# pi-nincompoop-guys

[pi](https://github.com/earendil-works/pi) coding-agent plugins for
[Pydantic Logfire](https://pydantic.dev/logfire). Two sibling extensions:

| Plugin | Role | Token | Summary |
|--------|------|-------|---------|
| [**pi-logfire-reader**](./pi-logfire-reader) | reader | `project:read` | Bridges the Logfire MCP server into pi as native `logfire_*` tools so the agent can **query** your telemetry (traces, metrics, SQL). |
| [**pi-logfire-writer**](./pi-logfire-writer) | writer | `project:write` | Ships pi's own activity to Logfire as **pydantic-ai-shaped** OpenTelemetry traces (`agent run` → `chat` → `running tool`). |

Run both together and pi can **read its own activity**: the writer records each
pi session as GenAI spans, and the reader lets pi query those spans back from
Logfire.

## Layout

```
pi-nincompoop-guys/
├── pi-logfire-reader/    # MCP reader extension  (+ README, tests, .env.example)
└── pi-logfire-writer/    # OTel writer extension (+ README, tests, examples/)
```

## Quick start

Each plugin is a self-contained pi extension. Clone, install its deps, and load
it with `pi -e`:

```bash
git clone https://github.com/runyaga/pi-nincompoop-guys
cd pi-nincompoop-guys

# reader
( cd pi-logfire-reader && npm install )
# writer
( cd pi-logfire-writer && npm install )

export LOGFIRE_READ_TOKEN="pylf_v2_us_..._read"     # reader
export LOGFIRE_WRITE_TOKEN="pylf_v2_us_..._write"   # writer

pi -e ./pi-logfire-reader/index.ts -e ./pi-logfire-writer/index.ts
```

To wire them in permanently, add the two `index.ts` paths to the `extensions`
array in `~/.pi/agent/settings.json`. See each plugin's README for full
configuration and tokens.

## License

MIT.
