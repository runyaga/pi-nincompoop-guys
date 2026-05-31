/**
 * Minimal trace-only OTel SDK that exports to Logfire over OTLP/HTTP protobuf.
 *
 * One provider per process. We manage a single global provider so the tracker
 * can create spans through `trace.getTracer()`.
 */

import { trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export const TRACER_NAME = "pi-logfire-writer";
export const TRACER_VERSION = "0.2.0";

let provider: BasicTracerProvider | null = null;

export interface SdkOptions {
	/** Full OTLP traces URL, e.g. https://logfire-us.pydantic.dev:443/v1/traces */
	tracesUrl: string;
	/** Logfire write token (sent verbatim in the Authorization header). */
	token: string;
	serviceName: string;
}

/** Initialize the global tracer provider wired to Logfire. Idempotent. */
export function initSdk(opts: SdkOptions): Tracer {
	if (!provider) {
		const exporter = new OTLPTraceExporter({
			url: opts.tracesUrl,
			headers: { Authorization: opts.token },
		});
		provider = new BasicTracerProvider({
			resource: new Resource({
				[ATTR_SERVICE_NAME]: opts.serviceName,
				[ATTR_SERVICE_VERSION]: TRACER_VERSION,
			}),
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		trace.setGlobalTracerProvider(provider);
	}
	return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/** Flush and tear down the provider. */
export async function shutdownSdk(): Promise<void> {
	if (!provider) return;
	try {
		await provider.forceFlush();
		await provider.shutdown();
	} catch {
		// best-effort flush on shutdown
	} finally {
		provider = null;
		trace.disable();
	}
}

export function isInitialized(): boolean {
	return provider !== null;
}
