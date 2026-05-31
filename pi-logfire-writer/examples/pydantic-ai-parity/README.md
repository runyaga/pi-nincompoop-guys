# pydantic-ai parity harness

Proves pi-logfire-writer emits traces shaped like pydantic-ai's, by running the
**same `get_weather` interaction** through both and checking both against the
shared shape spec (`../../shape-spec.ts`).

## 1. pydantic-ai reference

```bash
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
LOGFIRE_TOKEN=pylf_v2_..._write ./.venv/bin/python app.py     # service: pydantic-ai-demo
```

## 2. mirrored pi interaction

`pi-weather-tool.ts` registers a matching `get_weather` tool so the pi run mirrors
the pydantic-ai one.

```bash
LOGFIRE_WRITE_TOKEN=pylf_v2_..._write OTEL_SERVICE_NAME=pi-writer-mirror3 \
  pi -p "What is the weather in Paris? Use the tool." \
  --system-prompt "You are a concise assistant. When asked about weather, you MUST call the get_weather tool. Keep answers to one short sentence." \
  -e ./pi-weather-tool.ts -e ../../index.ts \
  --provider <your-provider> --model <your-model>
```

## 3. cross-check (same spec, both sources)

```bash
npm i @modelcontextprotocol/sdk
LOGFIRE_READ_TOKEN=pylf_v2_..._read node conformance.mjs pydantic-ai-demo pi-writer-mirror3
```

Expected:

```
===== pydantic-ai-demo  =====
  PASS  agent run     op=invoke_agent
  PASS  chat <model>  op=chat
  PASS  running tool  op=execute_tool
  PASS  chat <model>  op=chat
  OVERALL: CONFORMS ✓
===== pi-writer-mirror3  =====
  PASS  agent run     op=invoke_agent
  PASS  chat <model>  op=chat
  PASS  running tool  op=execute_tool
  PASS  chat <model>  op=chat
  OVERALL: CONFORMS ✓
=== SAME SPEC, BOTH SOURCES: BOTH CONFORM ✓ ===
```

The offline equivalent (no Logfire needed) is `npm test` in the package root,
which drives the writer's tracker through an in-memory exporter and asserts the
same spec.
