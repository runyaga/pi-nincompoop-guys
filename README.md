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
            └─ https://logfire-us.pydantic.dev/mcp   (Logfire remote MCP server)
                 ├─ tool: query_run
                 ├─ tool: query_schema_reference
                 ├─ tool: query_find_exceptions_in_file
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
| `LOGFIRE_MCP_URL` | no | `https://logfire-us.pydantic.dev/mcp` | MCP endpoint. Use the EU URL or a self-hosted URL as needed. |

```bash
export LOGFIRE_READ_TOKEN="pylf_v2_us_..."
# US is the default; switch regions if your token is EU-region:
# export LOGFIRE_MCP_URL="https://logfire-eu.pydantic.dev/mcp"
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

## Tools

The exact set is whatever the live server advertises (the remote server iterates
on its toolset) and is discovered automatically at connect time. As verified
against the live US endpoint, the current toolset is:

| pi tool | Description |
|---------|-------------|
| `logfire_query_run` | Run an arbitrary SQL `SELECT` against the Logfire (DataFusion) database |
| `logfire_query_schema_reference` | Get the database schema and query handbook |
| `logfire_query_find_exceptions_in_file` | Details on the 10 most recent exceptions matching a source file path |
| `logfire_project_list` | List all readable projects for the authenticated user |
| `logfire_project_logfire_link` | Generate a Logfire UI link to view a specific trace |
| `logfire_project_logfire_ui_link` | Generate a Logfire project UI link for live-view/filter pages |
| `logfire_token_info` | Info about the current authentication token |
| `logfire_variable_list` | List managed variables (feature flags) in a project |
| `logfire_variable_get` | Get a managed variable (feature flag) by name |
| `logfire_variable_list_versions` | List all versions of a managed variable |

Every Logfire MCP tool is exposed under the `logfire_<name>` prefix.

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
