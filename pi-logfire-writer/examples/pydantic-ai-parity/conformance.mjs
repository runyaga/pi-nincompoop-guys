/**
 * Live cross-check: runs the SAME shape spec against a pydantic-ai trace and a
 * pi-logfire-writer trace fetched from Logfire, asserting both conform.
 *
 * Usage:
 *   npm i @modelcontextprotocol/sdk
 *   LOGFIRE_READ_TOKEN=pylf_v2_..._read node conformance.mjs <pai-service> <writer-service>
 *   # defaults: pydantic-ai-demo  pi-writer-mirror3
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkShape } from "../../shape-spec.ts";

const READ_TOKEN = process.env.LOGFIRE_READ_TOKEN;
const URL_ = process.env.LOGFIRE_MCP_URL || "https://logfire-us.pydantic.dev/mcp";
const [paiService = "pydantic-ai-demo", writerService = "pi-writer-mirror3"] = process.argv.slice(2);

const transport = new StreamableHTTPClientTransport(new URL(URL_), {
	requestInit: { headers: { Authorization: `Bearer ${READ_TOKEN}` } },
});
const client = new Client({ name: "conformance", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

const run = async (sql) =>
	JSON.parse(
		((await client.callTool({ name: "query_run", arguments: { query: sql } })).content || [])
			.map((c) => c.text || "")
			.join("\n"),
	);

async function conform(service) {
	const tid = (
		await run(
			`SELECT trace_id FROM records WHERE service_name='${service}' ORDER BY start_timestamp DESC LIMIT 1`,
		)
	).rows[0]?.trace_id;
	if (!tid) return { service, ok: false, results: [], note: "no trace" };
	const rows = (
		await run(`SELECT span_name, attributes FROM records WHERE trace_id='${tid}' ORDER BY start_timestamp ASC`)
	).rows.filter((r) => r.attributes && r.attributes["gen_ai.operation.name"]);
	const results = rows.map((r) => ({ name: r.span_name, ...checkShape(r.span_name, r.attributes) }));
	return { service, tid, results, ok: results.length > 0 && results.every((z) => z.ok) };
}

let allOk = true;
for (const svc of [paiService, writerService]) {
	const c = await conform(svc);
	console.log(`\n===== ${svc} ${c.note || `trace=${(c.tid || "").slice(0, 12)}`} =====`);
	for (const z of c.results) {
		console.log(
			`  ${z.ok ? "PASS" : "FAIL"}  ${String(z.name).padEnd(34)} op=${z.operation}` +
				(z.ok ? "" : `  missing=[${z.missing}] forbidden=[${z.forbiddenPresent}] nameOk=${z.spanNameOk}`),
		);
	}
	console.log(`  OVERALL: ${c.ok ? "CONFORMS ✓" : "DOES NOT CONFORM ✗"}`);
	allOk = allOk && c.ok;
}
console.log(`\n=== SAME SPEC, BOTH SOURCES: ${allOk ? "BOTH CONFORM ✓" : "MISMATCH ✗"} ===`);
await client.close();
process.exit(allOk ? 0 : 1);
