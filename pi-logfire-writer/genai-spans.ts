/**
 * GenAI span tracker — maps pi's lifecycle events onto the pydantic-ai /
 * OpenTelemetry GenAI span shape so traces render in Logfire exactly like
 * pydantic-ai's:
 *
 *   agent run                 (invoke_agent)   one per user prompt
 *   ├─ chat <model>           (chat)           one per provider request
 *   └─ running tool           (execute_tool)   one per tool call
 *
 * chat/tool spans are direct children of `agent run` (no intermediate turn
 * span), matching pydantic-ai. The running conversation is accumulated and
 * recorded as gen_ai.input.messages / gen_ai.output.messages on chat spans.
 */

import {
	type Context,
	context as otelContext,
	type Span,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import {
	applyUsageAttrs,
	ATTR_AGENT_NAME,
	ATTR_CONVERSATION_ID,
	ATTR_ERROR_TYPE,
	ATTR_FINISH_REASONS,
	ATTR_INPUT_MESSAGES,
	ATTR_OPERATION_NAME,
	ATTR_OUTPUT_MESSAGES,
	ATTR_PAI_AGENT_NAME,
	ATTR_PAI_FINAL_RESULT,
	ATTR_PAI_MODEL_NAME,
	ATTR_PROVIDER_NAME,
	ATTR_REQUEST_MODEL,
	ATTR_RESPONSE_ID,
	ATTR_RESPONSE_MODEL,
	ATTR_SYSTEM,
	ATTR_TOOL_ARGUMENTS,
	ATTR_TOOL_CALL_ID,
	ATTR_TOOL_NAME,
	ATTR_TOOL_RESPONSE,
	buildAssistantParts,
	clampAttr,
	type ContentCapture,
	extractMessageText,
	extractToolResultText,
	normalizeFinishReason,
	OP_CHAT,
	OP_EXECUTE_TOOL,
	OP_INVOKE_AGENT,
	SPAN_AGENT_RUN,
	SPAN_RUNNING_TOOL,
	spanChatName,
} from "./genai-attrs.ts";

export interface GenAiTrackerOpts {
	tracer: Tracer;
	captureContent: ContentCapture;
	agentName: string;
	system: string;
	provider: string;
	conversationId: () => string | undefined;
}

interface Slot {
	span: Span;
	ctx: Context;
}

type ConvMessage = { role: string; parts: Array<Record<string, unknown>> };

export class GenAiSpanTracker {
	private opts: GenAiTrackerOpts;
	private agent: Slot | null = null;
	private chat: (Slot & { requestModel?: string }) | null = null;
	private tools = new Map<string, Slot>();
	/** Running conversation, in GenAI {role, parts[]} shape. */
	private conversation: ConvMessage[] = [];
	private lastAssistantText = "";
	private aggInput = 0;
	private aggOutput = 0;
	private lastModel: string | undefined;

	constructor(opts: GenAiTrackerOpts) {
		this.opts = opts;
	}

	private get captureMessages(): boolean {
		return this.opts.captureContent !== "metadata_only";
	}

	private get captureToolContent(): boolean {
		return this.opts.captureContent === "full";
	}

	private commonAttrs(): Record<string, string> {
		const attrs: Record<string, string> = {
			[ATTR_SYSTEM]: this.opts.system,
			[ATTR_PROVIDER_NAME]: this.opts.provider,
			[ATTR_AGENT_NAME]: this.opts.agentName,
		};
		const cid = this.opts.conversationId();
		if (cid) attrs[ATTR_CONVERSATION_ID] = cid;
		return attrs;
	}

	// ---- agent run --------------------------------------------------------

	startAgentRun(prompt: string | undefined, systemPrompt?: string): void {
		if (this.agent) return;
		this.conversation = [];
		this.lastAssistantText = "";
		this.aggInput = 0;
		this.aggOutput = 0;
		this.lastModel = undefined;

		if (this.captureMessages && systemPrompt) {
			this.conversation.push({
				role: "system",
				parts: [{ type: "text", content: systemPrompt }],
			});
		}
		if (this.captureMessages && typeof prompt === "string" && prompt) {
			this.conversation.push({
				role: "user",
				parts: [{ type: "text", content: prompt }],
			});
		}

		const attrs = this.commonAttrs();
		attrs[ATTR_OPERATION_NAME] = OP_INVOKE_AGENT;
		attrs[ATTR_PAI_AGENT_NAME] = this.opts.agentName;
		const span = this.opts.tracer.startSpan(SPAN_AGENT_RUN, { attributes: attrs });
		this.agent = { span, ctx: trace.setSpan(otelContext.active(), span) };
	}

	endAgentRun(error?: unknown): void {
		if (!this.agent) return;
		const { span } = this.agent;
		if (this.lastModel) span.setAttribute(ATTR_PAI_MODEL_NAME, this.lastModel);
		if (this.aggInput) span.setAttribute("gen_ai.usage.input_tokens", this.aggInput);
		if (this.aggOutput) span.setAttribute("gen_ai.usage.output_tokens", this.aggOutput);
		if (this.captureMessages && this.lastAssistantText) {
			span.setAttribute(ATTR_PAI_FINAL_RESULT, clampAttr(this.lastAssistantText));
		}
		if (error) this.markError(span, error);
		// Close stragglers.
		if (this.chat) {
			this.chat.span.end();
			this.chat = null;
		}
		for (const t of this.tools.values()) t.span.end();
		this.tools.clear();
		span.end();
		this.agent = null;
	}

	noteUserMessage(content: unknown): void {
		if (!this.captureMessages) return;
		const text = extractMessageText(content);
		if (text) this.conversation.push({ role: "user", parts: [{ type: "text", content: text }] });
	}

	noteToolResultMessage(msg: { toolCallId: string; toolName?: string; content: unknown }): void {
		if (!this.captureToolContent || !msg.toolCallId) return;
		const text = extractMessageText(msg.content);
		this.conversation.push({
			role: "tool",
			parts: [
				{
					type: "tool_call_response",
					id: msg.toolCallId,
					...(msg.toolName ? { name: msg.toolName } : {}),
					result: text,
				},
			],
		});
	}

	// ---- chat <model> -----------------------------------------------------

	startChat(model?: string): void {
		if (!this.agent) return;
		if (this.chat) {
			this.chat.span.end();
			this.chat = null;
		}
		if (model) this.lastModel = model;
		const attrs = this.commonAttrs();
		attrs[ATTR_OPERATION_NAME] = OP_CHAT;
		if (model) attrs[ATTR_REQUEST_MODEL] = model;
		// Snapshot the conversation as this request's input messages.
		if (this.captureMessages && this.conversation.length > 0) {
			attrs[ATTR_INPUT_MESSAGES] = clampAttr(this.conversation);
		}
		const span = this.opts.tracer.startSpan(
			spanChatName(model),
			{ attributes: attrs },
			this.agent.ctx,
		);
		this.chat = { span, ctx: trace.setSpan(this.agent.ctx, span), requestModel: model };
	}

	setChatAttrs(attrs: Record<string, unknown>): void {
		if (!this.chat) return;
		for (const [k, v] of Object.entries(attrs)) {
			if (v === undefined || v === null) continue;
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
				this.chat.span.setAttribute(k, v);
			} else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
				this.chat.span.setAttribute(k, v);
			}
		}
	}

	/** Apply assistant message details + finalize the chat span. */
	endChatWithAssistant(message: Record<string, unknown>): void {
		if (!this.chat) return;
		const span = this.chat.span;
		const model = typeof message.model === "string" ? message.model : undefined;
		if (model) {
			span.setAttribute(ATTR_RESPONSE_MODEL, model);
			this.lastModel = model;
		}
		const finish = normalizeFinishReason(message);
		span.setAttribute(ATTR_FINISH_REASONS, [finish]);

		const usageAttrs: Record<string, unknown> = {};
		applyUsageAttrs(usageAttrs, message.usage);
		for (const [k, v] of Object.entries(usageAttrs)) {
			if (typeof v === "number") span.setAttribute(k, v);
		}
		if (typeof usageAttrs["gen_ai.usage.input_tokens"] === "number")
			this.aggInput += usageAttrs["gen_ai.usage.input_tokens"] as number;
		if (typeof usageAttrs["gen_ai.usage.output_tokens"] === "number")
			this.aggOutput += usageAttrs["gen_ai.usage.output_tokens"] as number;

		const text = extractMessageText(message.content);
		if (text) this.lastAssistantText = text;

		if (this.captureMessages) {
			const parts = buildAssistantParts(message.content, this.captureToolContent);
			const outputMessage = { role: "assistant", parts, finish_reason: finish };
			span.setAttribute(ATTR_OUTPUT_MESSAGES, clampAttr([outputMessage]));
			// Append to running conversation for subsequent chat spans.
			this.conversation.push({ role: "assistant", parts });
		}

		span.end();
		this.chat = null;
	}

	endChatError(error: unknown): void {
		if (!this.chat) return;
		this.markError(this.chat.span, error);
		this.chat.span.end();
		this.chat = null;
	}

	// ---- running tool -----------------------------------------------------

	startTool(toolCallId: string, toolName: string, input: unknown): void {
		const parentCtx = this.agent?.ctx ?? otelContext.active();
		const attrs = this.commonAttrs();
		attrs[ATTR_OPERATION_NAME] = OP_EXECUTE_TOOL;
		attrs[ATTR_TOOL_NAME] = toolName;
		attrs[ATTR_TOOL_CALL_ID] = toolCallId;
		if (this.captureToolContent && input !== undefined) {
			attrs[ATTR_TOOL_ARGUMENTS] =
				typeof input === "string" ? input : clampAttr(input);
		}
		const span = this.opts.tracer.startSpan(SPAN_RUNNING_TOOL, { attributes: attrs }, parentCtx);
		this.tools.set(toolCallId, { span, ctx: trace.setSpan(parentCtx, span) });
	}

	endTool(toolCallId: string, args: { isError?: boolean; result?: unknown }): void {
		const slot = this.tools.get(toolCallId);
		if (!slot) return;
		if (this.captureToolContent && args.result !== undefined) {
			slot.span.setAttribute(ATTR_TOOL_RESPONSE, extractToolResultText(args.result));
		}
		if (args.isError) {
			slot.span.setAttribute(ATTR_ERROR_TYPE, "tool_error");
			slot.span.setStatus({ code: SpanStatusCode.ERROR });
		}
		slot.span.end();
		this.tools.delete(toolCallId);
	}

	private markError(span: Span, error: unknown): void {
		const name = (error as Error)?.name ?? "Error";
		span.setAttribute(ATTR_ERROR_TYPE, name);
		span.setStatus({ code: SpanStatusCode.ERROR, message: String((error as Error)?.message ?? error) });
	}

	activeTraceId(): string | undefined {
		return this.agent?.span.spanContext().traceId;
	}
}
