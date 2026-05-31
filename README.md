# pi-logfire-mcp

A [pi](https://github.com/earendil-works/pi) coding-agent extension that bridges
the **[Pydantic Logfire](https://pydantic.dev/logfire) OpenTelemetry MCP server**
into pi as native tools.

Pi intentionally ships [without a built-in MCP client](https://github.com/earendil-works/pi#mcp).
This extension fills that gap for Logfire specifically: it acts as a
Streamable-HTTP [MCP](https://modelcontextprotocol.io) client, connects to the
remote Logfire MCP endpoint, **discovers whatever tools the server exposes**, and
registers each one as a native pi tool. The model can then query your
application's traces, metrics, exception data, and run arbitrary SQL against your
OpenTelemetry records — all from inside pi.

## How it works

```
pi (agent)
  └─ pi-logfire-mcp extension
       └─ MCP client (Streamable HTTP, Bearer auth)
            └─ https://logfire-eu.pydantic.dev/mcp   (Logfire remote MCP server)
                 ├─ tool: arbitrary_query
                 ├─ tool: find_exceptions
                 ├─ tool: get_logfire_records_schema
                 └─ ... (whatever the server advertises)
```

On `session_start` the extension connects, calls `tools/list`, and registers each
discovered tool under a `logfire_<name>` pi tool that proxies `tools/call` back
over MCP. Tools are discovered dynamically, so you always get the current Logfire
toolset without updating this extension.

## Requirements

- `pi` (the `@earendil-works/pi-coding-agent` CLI)
- A Logfire **read token** with at least the `project:read` scope
- Node.js 18+ (for `fetch` / Streamable HTTP)

## Install

Install as a pi package directly from GitHub:

```bash
pi install git:github.com/runyaga/pi-nincompoop-guys
```

Or clone and load locally for development:

```bash
git clone https://github.com/runyaga/pi-nincompoop-guys
cd pi-nincompoop-guys
npm install
pi -e ./index.ts
```

## Configuration

The read token is **never hardcoded** — it is read from the environment so it
never lands in version control.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LOGFIRE_READ_TOKEN` | yes | — | Logfire read token (`project:read` scope). `LOGFIRE_TOKEN` also accepted. |
| `LOGFIRE_MCP_URL` | no | `https://logfire-eu.pydantic.dev/mcp` | MCP endpoint. Use the US URL or a self-hosted URL as needed. |

```bash
export LOGFIRE_READ_TOKEN="pylf_v1_..."
# EU is the default; switch regions if your token is US-region:
# export LOGFIRE_MCP_URL="https://logfire-us.pydantic.dev/mcp"
pi
```

See [`.env.example`](./.env.example) for a template.

> **Token region must match the endpoint.** A `pylf_v1_us_*` token only
> authenticates against `https://logfire-us.pydantic.dev/mcp`, and a
> `pylf_v1_eu_*` token only against the EU URL. Mismatched region returns
> `invalid_token`; a token missing the required scope returns
> `insufficient_scope` (you need `project:read`).

## Commands

| Command | What it does |
|---------|--------------|
| `/logfire-status` | Show connection status and discovered tool count |
| `/logfire-reconnect` | Reconnect and refresh the Logfire toolset (e.g. after exporting a token) |

## Example tools

The exact set is whatever the live server advertises (the remote server iterates
on its toolset). Commonly available Logfire MCP tools include:

- `arbitrary_query` — run a SQL query against your Logfire OpenTelemetry records
- `get_logfire_records_schema` — fetch the schema of the records table to build queries
- `find_exceptions` — find exceptions across services over a time window
- `find_exceptions_in_file` — find exceptions originating in a specific file

These appear in pi as `logfire_arbitrary_query`, `logfire_find_exceptions`, etc.

## Development

```bash
npm install          # install the MCP SDK
pi -e ./index.ts     # load the extension into a pi session
```

Layout:

- `index.ts` — extension entry point (default factory)
- `logfire-mcp.ts` — MCP client bridge, tool discovery/proxying, and commands

## License

MIT — see [LICENSE](./LICENSE).
