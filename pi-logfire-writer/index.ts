/**
 * pi-logfire-writer
 *
 * Ships pi's OpenTelemetry traces to Pydantic Logfire.
 *
 * This is a thin Logfire *preset* built on top of the `pi-otel` extension:
 *   - pi-otel does the heavy lifting (wiring pi's lifecycle events into an OTel
 *     span tree: pi.interaction -> pi.llm_request / pi.tool.<name>, exported via
 *     OTLP).
 *   - pi-logfire-writer points that export at Logfire's OTLP HTTP ingest
 *     endpoint and authenticates with a Logfire *write* token, so you don't
 *     have to hand-configure OTEL_EXPORTER_OTLP_* yourself.
 *
 * Configuration (all via environment, token is never hardcoded):
 *   LOGFIRE_WRITE_TOKEN   (required)  Logfire write token (project:write scope).
 *   LOGFIRE_REGION        (optional)  "us" | "eu". Defaults: inferred from the
 *                                     token prefix, else "us".
 *   LOGFIRE_WRITER_ENDPOINT (optional) Override the OTLP base/traces URL for a
 *                                     self-hosted Logfire instance.
 *   PI_LOGFIRE_WRITER_DISABLED=1      Hard-disable export.
 *
 * pi-otel's own PI_OTEL_* / OTEL_* knobs (captureContent, sampleRatio, ...)
 * still apply. Explicit user-set OTEL_EXPORTER_OTLP_* values are respected and
 * not overwritten.
 *
 * Scope: traces only. pi-otel sends every signal to a single verbatim endpoint,
 * so enabling metrics/logs would mis-route them to /v1/traces; this preset
 * therefore targets traces, which is Logfire's primary view.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piOtel from "pi-otel";
import {
	applyOtelEnv,
	describeConfig,
	resolveLogfireWriterConfig,
	type LogfireWriterConfig,
} from "./logfire-config.ts";

export default function (pi: ExtensionAPI): void {
	const config: LogfireWriterConfig = resolveLogfireWriterConfig(process.env);

	// Status command is always available, even when disabled.
	pi.registerCommand("logfire-writer-status", {
		description: "Show pi-logfire-writer (Logfire OTLP trace export) status",
		handler: async (_args, ctx: ExtensionContext) => {
			ctx.ui.notify(
				`pi-logfire-writer: ${describeConfig(config)}`,
				config.enabled ? "info" : "warning",
			);
		},
	});

	if (!config.enabled) {
		// Do not wire pi-otel against an unconfigured endpoint; just inform once.
		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			ctx.ui.notify(
				`pi-logfire-writer disabled: ${config.disabledReason}. Set LOGFIRE_WRITE_TOKEN and restart pi.`,
				"warning",
			);
		});
		return;
	}

	// Apply the Logfire OTLP preset BEFORE pi-otel resolves its config (it reads
	// these env vars at session_start). Done at load time, which runs first.
	applyOtelEnv(config, process.env);

	// Track whether pi-otel managed to wire its exporter this session.
	let wired = false;
	pi.events.on("pi-otel:status", (s: unknown) => {
		const state = (s as { state?: string } | undefined)?.state;
		if (state === "ready") wired = true;
		else if (state === "shutdown" || state === "disabled") wired = false;
	});

	// Delegate to the pi-otel engine — it now exports to Logfire.
	piOtel(pi);

	// Registered AFTER pi-otel's own session_start, so this runs once pi-otel has
	// finished its startup wiring attempt. pi-otel gates wiring behind a 300ms
	// raw-TCP reachability probe meant for local collectors; against Logfire's
	// HTTPS cloud endpoint that probe can flap on a cold start and skip wiring.
	// If it didn't wire, force it via pi-otel's documented dashboard-ready hook,
	// which calls wireSdk directly without probing.
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!wired) {
			pi.events.emit("pi-otel:dashboard-ready", {
				endpoint: config.tracesUrl,
				protocol: config.protocol,
			});
		}
		ctx.ui.notify(`pi-logfire-writer: traces -> ${config.tracesUrl}`, "info");
	});
}
