import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const US_TOKEN = "pylf_v2_us_deadbeef_AaBbCcDdEeFf";

const OTEL_KEYS = [
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_HEADERS",
	"OTEL_SERVICE_NAME",
];
const OWNED_ENV = [
	...OTEL_KEYS,
	"LOGFIRE_WRITE_TOKEN",
	"LOGFIRE_TOKEN",
	"LOGFIRE_REGION",
	"LOGFIRE_WRITER_ENDPOINT",
	"PI_LOGFIRE_WRITER_DISABLED",
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

interface FakePi {
	events_on: string[];
	events_emit: string[];
	on: string[];
	commands: string[];
	pi: {
		on: (name: string, handler: unknown) => void;
		registerCommand: (name: string, opts: unknown) => void;
		events: {
			on: (name: string, handler: unknown) => void;
			emit: (name: string, data?: unknown) => void;
		};
	};
}

function makeFakePi(): FakePi {
	const rec: FakePi = {
		events_on: [],
		events_emit: [],
		on: [],
		commands: [],
		pi: undefined as never,
	};
	rec.pi = {
		on: (name) => rec.on.push(name),
		registerCommand: (name) => rec.commands.push(name),
		events: {
			on: (name) => rec.events_on.push(name),
			emit: (name) => rec.events_emit.push(name),
		},
	};
	return rec;
}

test("enabled: applies Logfire OTLP preset and delegates to pi-otel", async () => {
	process.env.LOGFIRE_WRITE_TOKEN = US_TOKEN;
	const { default: extension } = await import("../index.ts");
	const fake = makeFakePi();
	extension(fake.pi as never);

	// Preset applied to process.env for pi-otel to read.
	assert.equal(
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
		"https://logfire-us.pydantic.dev:443/v1/traces",
	);
	assert.equal(process.env.OTEL_EXPORTER_OTLP_PROTOCOL, "http/protobuf");
	assert.equal(
		process.env.OTEL_EXPORTER_OTLP_HEADERS,
		`Authorization=${US_TOKEN}`,
	);

	// Our status command is registered.
	assert.ok(fake.commands.includes("logfire-writer-status"));
	// pi-otel was delegated to: it registers the /otel command.
	assert.ok(fake.commands.includes("otel"), "expected pi-otel /otel command");
	// pi-otel wires its own session_start; so do we.
	assert.ok(fake.on.includes("session_start"));
	// pi-otel registers its extensibility log channel.
	assert.ok(fake.events_on.includes("pi-otel:log"));
});

test("respects a user-provided OTEL endpoint (no clobber)", async () => {
	process.env.LOGFIRE_WRITE_TOKEN = US_TOKEN;
	process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";
	const { default: extension } = await import("../index.ts");
	extension(makeFakePi().pi as never);
	assert.equal(
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
		"http://localhost:4318/v1/traces",
	);
	// auth header still injected
	assert.equal(
		process.env.OTEL_EXPORTER_OTLP_HEADERS,
		`Authorization=${US_TOKEN}`,
	);
});

test("disabled: no token -> registers status + warning, sets no OTLP env, no pi-otel", async () => {
	// no LOGFIRE_WRITE_TOKEN
	const { default: extension } = await import("../index.ts");
	const fake = makeFakePi();
	extension(fake.pi as never);

	assert.equal(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
	assert.equal(process.env.OTEL_EXPORTER_OTLP_HEADERS, undefined);
	assert.ok(fake.commands.includes("logfire-writer-status"));
	// pi-otel must NOT have been delegated to.
	assert.ok(!fake.commands.includes("otel"));
	assert.ok(!fake.events_on.includes("pi-otel:log"));
	// still registers a session_start (to warn the user).
	assert.ok(fake.on.includes("session_start"));
});
