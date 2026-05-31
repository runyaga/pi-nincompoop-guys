/**
 * Logfire OTLP configuration for pi-logfire-writer.
 *
 * This module is pure (no OpenTelemetry / pi imports) so it is trivially
 * testable. It turns environment variables into the OTLP settings that the
 * underlying `pi-otel` engine consumes — pointing pi's trace export at the
 * Pydantic Logfire ingest endpoint and authenticating with a write token.
 *
 * The Logfire write token is read from the environment and is NEVER hardcoded.
 */

export type LogfireRegion = "us" | "eu";

export interface LogfireWriterConfig {
	/** Whether trace export to Logfire should be wired. */
	enabled: boolean;
	/** Human-readable reason when disabled (e.g. missing token). */
	disabledReason?: string;
	/** The Logfire write token (secret — never logged in full). */
	token?: string;
	/** Resolved region. */
	region: LogfireRegion;
	/** Base Logfire URL, e.g. https://logfire-us.pydantic.dev */
	baseUrl: string;
	/**
	 * Full OTLP traces endpoint WITH an explicit port, e.g.
	 * https://logfire-us.pydantic.dev:443/v1/traces
	 *
	 * The explicit port is required: pi-otel both probes this endpoint (it
	 * refuses endpoints without a port) and passes it verbatim to the OTLP
	 * exporter, so it must already include the `/v1/traces` path.
	 */
	tracesUrl: string;
	/** OTLP protocol — always http/protobuf for the Logfire HTTP ingest. */
	protocol: "http/protobuf";
	/** service.name resource attribute. */
	serviceName: string;
}

const REGION_BASE: Record<LogfireRegion, string> = {
	us: "https://logfire-us.pydantic.dev",
	eu: "https://logfire-eu.pydantic.dev",
};

/** Infer the Logfire region from a write token prefix (pylf_v2_us_..., pylf_v1_eu_...). */
export function regionFromToken(token: string | undefined): LogfireRegion | undefined {
	if (!token) return undefined;
	const m = /^pylf_v\d+_(us|eu)_/i.exec(token.trim());
	return m ? (m[1].toLowerCase() as LogfireRegion) : undefined;
}

/**
 * Normalize a base or full Logfire URL into a traces endpoint that carries an
 * explicit port and the `/v1/traces` path. Constructed by hand because
 * `URL.toString()` strips default ports (443/80), which would break pi-otel's
 * port-requiring reachability probe.
 */
export function buildTracesEndpoint(baseOrFull: string): string {
	const u = new URL(baseOrFull);
	const port = u.port || (u.protocol === "http:" ? "80" : "443");
	const hasPath = u.pathname && u.pathname !== "/";
	const path = hasPath ? u.pathname.replace(/\/+$/, "") : "/v1/traces";
	return `${u.protocol}//${u.hostname}:${port}${path}`;
}

function envFlagTrue(v: string | undefined): boolean {
	return v === "1" || v?.toLowerCase() === "true";
}

/** Resolve the writer configuration from an environment map (defaults to process.env). */
export function resolveLogfireWriterConfig(
	env: NodeJS.ProcessEnv = process.env,
): LogfireWriterConfig {
	const token =
		env.LOGFIRE_WRITE_TOKEN?.trim() ||
		env.LOGFIRE_TOKEN?.trim() ||
		undefined;

	// Region: explicit override > token inference > us default.
	const explicitRegion = env.LOGFIRE_REGION?.trim().toLowerCase();
	const region: LogfireRegion =
		explicitRegion === "us" || explicitRegion === "eu"
			? explicitRegion
			: regionFromToken(token) ?? "us";

	// Endpoint: explicit override (self-hosted / custom) > region base.
	const override =
		env.LOGFIRE_WRITER_ENDPOINT?.trim() ||
		env.LOGFIRE_OTLP_ENDPOINT?.trim() ||
		undefined;
	const baseUrl = override ?? REGION_BASE[region];
	const tracesUrl = buildTracesEndpoint(baseUrl);

	const serviceName = env.OTEL_SERVICE_NAME?.trim() || "pi";

	const explicitlyDisabled = envFlagTrue(env.PI_LOGFIRE_WRITER_DISABLED);

	let enabled = true;
	let disabledReason: string | undefined;
	if (explicitlyDisabled) {
		enabled = false;
		disabledReason = "PI_LOGFIRE_WRITER_DISABLED is set";
	} else if (!token) {
		enabled = false;
		disabledReason = "LOGFIRE_WRITE_TOKEN is not set";
	}

	return {
		enabled,
		disabledReason,
		token,
		region,
		baseUrl: override ?? REGION_BASE[region],
		tracesUrl,
		protocol: "http/protobuf",
		serviceName,
	};
}

/**
 * Build the OTLP environment variables that pi-otel reads. The Logfire write
 * token is placed in the `Authorization` header (Logfire expects the raw token,
 * not a `Bearer` prefix).
 */
export function buildOtelEnv(config: LogfireWriterConfig): Record<string, string> {
	const out: Record<string, string> = {
		OTEL_EXPORTER_OTLP_ENDPOINT: config.tracesUrl,
		OTEL_EXPORTER_OTLP_PROTOCOL: config.protocol,
		OTEL_SERVICE_NAME: config.serviceName,
	};
	if (config.token) {
		out.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=${config.token}`;
	}
	return out;
}

/**
 * Apply the OTLP preset to a target env map (default process.env), WITHOUT
 * clobbering values the user has already set explicitly. Returns the keys that
 * were actually written.
 */
export function applyOtelEnv(
	config: LogfireWriterConfig,
	target: NodeJS.ProcessEnv = process.env,
): string[] {
	const written: string[] = [];
	for (const [key, value] of Object.entries(buildOtelEnv(config))) {
		if (target[key] === undefined || target[key] === "") {
			target[key] = value;
			written.push(key);
		}
	}
	return written;
}

/** Mask a token for safe display: keep the prefix, hide the secret tail. */
export function maskToken(token: string | undefined): string {
	if (!token) return "(none)";
	const m = /^(pylf_v\d+_(?:us|eu)_)/i.exec(token);
	const prefix = m ? m[1] : token.slice(0, 8);
	return `${prefix}…(${token.length} chars)`;
}

/** One-line status string for the /logfire-writer-status command. */
export function describeConfig(config: LogfireWriterConfig): string {
	if (!config.enabled) {
		return `disabled — ${config.disabledReason}`;
	}
	return `exporting traces to ${config.tracesUrl} (region=${config.region}, token=${maskToken(config.token)})`;
}
