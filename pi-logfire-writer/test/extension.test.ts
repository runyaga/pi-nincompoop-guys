import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const US_TOKEN = "pylf_v2_us_deadbeef_AaBbCcDdEeFf";

const OWNED_ENV = [
	"LOGFIRE_WRITE_TOKEN",
	"LOGFIRE_TOKEN",
	"LOGFIRE_REGION",
	"LOGFIRE_WRITER_ENDPOINT",
	"PI_LOGFIRE_WRITER_DISABLED",
	"PI_LOGFIRE_WRITER_CAPTURE_CONTENT",
	"PI_OTEL_CAPTURE_CONTENT",
	"PI_LOGFIRE_WRITER_ENABLED",
	"PI_LOGFIRE_WRITER_START_PAUSED",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = {};
	for (const k of OWNED_ENV) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of OWNED_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

function makeFakePi() {
	const on: string[] = [];
	const commands: string[] = [];
	const pi = {
		on: (name: string) => on.push(name),
		registerCommand: (name: string) => commands.push(name),
		events: { on: () => {}, emit: () => {} },
	};
	return { on, commands, pi };
}

test("enabled: registers status command and the full GenAI event pipeline", async () => {
	process.env.LOGFIRE_WRITE_TOKEN = US_TOKEN;
	const { default: extension } = await import("../index.ts");
	const fake = makeFakePi();
	extension(fake.pi as never);

	assert.ok(fake.commands.includes("logfire-writer-status"));
	for (const ev of [
		"session_start",
		"before_agent_start",
		"message_start",
		"before_provider_request",
		"after_provider_response",
		"message_end",
		"tool_execution_start",
		"tool_execution_end",
		"agent_end",
		"session_shutdown",
	]) {
		assert.ok(fake.on.includes(ev), `expected handler for ${ev}`);
	}
});

test("disabled: no token -> only status + a warning session_start, no pipeline", async () => {
	const { default: extension } = await import("../index.ts");
	const fake = makeFakePi();
	extension(fake.pi as never);

	assert.ok(fake.commands.includes("logfire-writer-status"));
	assert.deepEqual(fake.on, ["session_start"]); // only the warning handler
	assert.ok(!fake.on.includes("before_provider_request"));
});
