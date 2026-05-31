import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildTracesEndpoint,
	describeConfig,
	maskToken,
	regionFromToken,
	resolveLogfireWriterConfig,
} from "../logfire-config.ts";

const US_TOKEN = "pylf_v2_us_deadbeef_AaBbCcDdEeFf";
const EU_TOKEN = "pylf_v1_eu_deadbeef_AaBbCcDdEeFf";

test("regionFromToken infers region from prefix", () => {
	assert.equal(regionFromToken(US_TOKEN), "us");
	assert.equal(regionFromToken(EU_TOKEN), "eu");
	assert.equal(regionFromToken("not-a-token"), undefined);
	assert.equal(regionFromToken(undefined), undefined);
});

test("buildTracesEndpoint forces explicit port and /v1/traces path", () => {
	assert.equal(
		buildTracesEndpoint("https://logfire-us.pydantic.dev"),
		"https://logfire-us.pydantic.dev:443/v1/traces",
	);
	// trailing slash is fine
	assert.equal(
		buildTracesEndpoint("https://logfire-eu.pydantic.dev/"),
		"https://logfire-eu.pydantic.dev:443/v1/traces",
	);
	// http base keeps port 80
	assert.equal(
		buildTracesEndpoint("http://localhost"),
		"http://localhost:80/v1/traces",
	);
	// explicit port preserved
	assert.equal(
		buildTracesEndpoint("https://logfire.my-co.com:8443"),
		"https://logfire.my-co.com:8443/v1/traces",
	);
	// a full traces URL is kept (port made explicit)
	assert.equal(
		buildTracesEndpoint("https://logfire-us.pydantic.dev/v1/traces"),
		"https://logfire-us.pydantic.dev:443/v1/traces",
	);
});

test("resolveLogfireWriterConfig: US token enables export to US endpoint", () => {
	const cfg = resolveLogfireWriterConfig({ LOGFIRE_WRITE_TOKEN: US_TOKEN });
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.region, "us");
	assert.equal(cfg.tracesUrl, "https://logfire-us.pydantic.dev:443/v1/traces");
	assert.equal(cfg.protocol, "http/protobuf");
	assert.equal(cfg.token, US_TOKEN);
});

test("resolveLogfireWriterConfig: EU token routes to EU endpoint", () => {
	const cfg = resolveLogfireWriterConfig({ LOGFIRE_WRITE_TOKEN: EU_TOKEN });
	assert.equal(cfg.region, "eu");
	assert.equal(cfg.tracesUrl, "https://logfire-eu.pydantic.dev:443/v1/traces");
});

test("LOGFIRE_REGION overrides token-inferred region", () => {
	const cfg = resolveLogfireWriterConfig({
		LOGFIRE_WRITE_TOKEN: US_TOKEN,
		LOGFIRE_REGION: "eu",
	});
	assert.equal(cfg.region, "eu");
	assert.equal(cfg.tracesUrl, "https://logfire-eu.pydantic.dev:443/v1/traces");
});

test("LOGFIRE_WRITER_ENDPOINT overrides for self-hosted Logfire", () => {
	const cfg = resolveLogfireWriterConfig({
		LOGFIRE_WRITE_TOKEN: US_TOKEN,
		LOGFIRE_WRITER_ENDPOINT: "https://logfire.my-co.com",
	});
	assert.equal(cfg.tracesUrl, "https://logfire.my-co.com:443/v1/traces");
});

test("LOGFIRE_TOKEN is accepted as a fallback for the write token", () => {
	const cfg = resolveLogfireWriterConfig({ LOGFIRE_TOKEN: US_TOKEN });
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.token, US_TOKEN);
});

test("missing token disables export with a reason", () => {
	const cfg = resolveLogfireWriterConfig({});
	assert.equal(cfg.enabled, false);
	assert.match(cfg.disabledReason ?? "", /LOGFIRE_WRITE_TOKEN/);
});

test("PI_LOGFIRE_WRITER_DISABLED hard-disables even with a token", () => {
	const cfg = resolveLogfireWriterConfig({
		LOGFIRE_WRITE_TOKEN: US_TOKEN,
		PI_LOGFIRE_WRITER_DISABLED: "1",
	});
	assert.equal(cfg.enabled, false);
	assert.match(cfg.disabledReason ?? "", /DISABLED/);
});

test("captureContent defaults to metadata_only and honors overrides", () => {
	assert.equal(
		resolveLogfireWriterConfig({ LOGFIRE_WRITE_TOKEN: US_TOKEN }).captureContent,
		"metadata_only",
	);
	assert.equal(
		resolveLogfireWriterConfig({
			LOGFIRE_WRITE_TOKEN: US_TOKEN,
			PI_LOGFIRE_WRITER_CAPTURE_CONTENT: "full",
		}).captureContent,
		"full",
	);
	// pi-otel's env var is accepted for compatibility
	assert.equal(
		resolveLogfireWriterConfig({
			LOGFIRE_WRITE_TOKEN: US_TOKEN,
			PI_OTEL_CAPTURE_CONTENT: "no_tool_content",
		}).captureContent,
		"no_tool_content",
	);
});

test("maskToken hides the secret tail but keeps the prefix", () => {
	const masked = maskToken(US_TOKEN);
	assert.match(masked, /^pylf_v2_us_/);
	assert.ok(!masked.includes("AaBbCcDdEeFf"));
	assert.equal(maskToken(undefined), "(none)");
});

test("describeConfig summarizes enabled and disabled states", () => {
	const enabled = resolveLogfireWriterConfig({ LOGFIRE_WRITE_TOKEN: US_TOKEN });
	assert.match(describeConfig(enabled), /exporting traces to https:\/\/logfire-us/);
	const disabled = resolveLogfireWriterConfig({});
	assert.match(describeConfig(disabled), /disabled/);
});
