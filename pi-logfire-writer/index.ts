/**
 * pi-logfire-writer
 *
 * Ships pi's activity to Pydantic Logfire as OpenTelemetry traces shaped like
 * pydantic-ai's, so they render in Logfire's GenAI / agent views:
 *
 *   agent run                 (gen_ai.operation.name = invoke_agent)
 *   ├─ chat <model>           (gen_ai.operation.name = chat)
 *   └─ running tool           (gen_ai.operation.name = execute_tool)
 *
 * Span shape / message conventions are modeled on pydantic-ai (verified against
 * live Logfire traces) and on the pi-otel extension's event→span mapping.
 *
 * Configuration (token never hardcoded):
 *   LOGFIRE_WRITE_TOKEN   (required)  Logfire write token (project:write).
 *   LOGFIRE_REGION        (optional)  us | eu (default inferred from token).
 *   LOGFIRE_WRITER_ENDPOINT (optional) override OTLP base for self-hosted.
 *   PI_LOGFIRE_WRITER_CAPTURE_CONTENT  metadata_only | no_tool_content | full
 *                                     (default metadata_only; "full" records
 *                                      prompts/responses/tool IO like pydantic-ai).
 *   PI_LOGFIRE_WRITER_DISABLED=1      Hard-disable export.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GenAiSpanTracker } from "./genai-spans.ts";
import { ATTR_RESPONSE_ID } from "./genai-attrs.ts";
import {
	describeConfig,
	type LogfireWriterConfig,
	resolveLogfireWriterConfig,
} from "./logfire-config.ts";
import { initSdk, shutdownSdk } from "./otel-sdk.ts";

export default function (pi: ExtensionAPI): void {
	const config: LogfireWriterConfig = resolveLogfireWriterConfig(process.env);

	pi.registerCommand("logfire-writer-status", {
		description: "Show pi-logfire-writer (Logfire OTLP trace export) status",
		handler: async (_args, ctx: ExtensionContext) => {
			ctx.ui.notify(
				`pi-logfire-writer: ${describeConfig(config)}, capture=${config.captureContent}`,
				config.enabled ? "info" : "warning",
			);
		},
	});

	if (!config.enabled || !config.token) {
		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			ctx.ui.notify(
				`pi-logfire-writer disabled: ${config.disabledReason}. Set LOGFIRE_WRITE_TOKEN and restart pi.`,
				"warning",
			);
		});
		return;
	}

	let tracker: GenAiSpanTracker | null = null;
	// pydantic-ai uses a clean UUID conversation id (not the session filename).
	let conversationId: string | undefined;

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		conversationId = randomUUID();
		const tracer = initSdk({
			tracesUrl: config.tracesUrl,
			token: config.token as string,
			serviceName: config.serviceName,
		});
		tracker = new GenAiSpanTracker({
			tracer,
			captureContent: config.captureContent,
			agentName: "pi",
			system: "pi",
			provider: "pi",
			conversationId: () => conversationId,
		});
		ctx.ui.notify(`pi-logfire-writer: traces -> ${config.tracesUrl}`, "info");
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const e = event as { prompt?: string; systemPrompt?: string };
		tracker?.startAgentRun(e?.prompt, e?.systemPrompt);
	});

	pi.on("message_start", async (event, _ctx) => {
		const msg = (event as { message?: Record<string, unknown> })?.message;
		if (!msg) return;
		if (msg.role === "user") {
			tracker?.noteUserMessage(msg.content);
		} else if (msg.role === "toolResult") {
			tracker?.noteToolResultMessage({
				toolCallId: msg.toolCallId as string,
				toolName: msg.toolName as string | undefined,
				content: msg.content,
			});
		}
	});

	pi.on("before_provider_request", async (event, _ctx) => {
		const payload = (event as { payload?: Record<string, unknown> })?.payload;
		const model = payload?.model ?? payload?.modelId ?? payload?.modelName;
		tracker?.startChat(typeof model === "string" ? model : undefined);
	});

	pi.on("after_provider_response", async (event, _ctx) => {
		const e = event as { headers?: Record<string, string> };
		const headers = e?.headers ?? {};
		const respId =
			headers["x-request-id"] ??
			headers["request-id"] ??
			headers["anthropic-request-id"] ??
			headers["openai-response-id"];
		if (typeof respId === "string") tracker?.setChatAttrs({ [ATTR_RESPONSE_ID]: respId });
	});

	pi.on("message_end", async (event, _ctx) => {
		const msg = (event as { message?: Record<string, unknown> })?.message;
		if (!msg || msg.role !== "assistant") return;
		tracker?.endChatWithAssistant(msg);
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		const e = event as { toolCallId?: string; toolName?: string; args?: unknown };
		if (!e?.toolCallId || !e?.toolName) return;
		tracker?.startTool(e.toolCallId, e.toolName, e.args);
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		const e = event as { toolCallId?: string; isError?: boolean; result?: unknown };
		if (!e?.toolCallId) return;
		tracker?.endTool(e.toolCallId, { isError: !!e.isError, result: e.result });
	});

	pi.on("agent_end", async (_event, _ctx) => {
		tracker?.endAgentRun();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		tracker?.endAgentRun();
		tracker = null;
		await shutdownSdk();
	});
}
