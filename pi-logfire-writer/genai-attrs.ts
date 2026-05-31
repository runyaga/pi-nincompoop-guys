/**
 * OpenTelemetry GenAI semantic-convention constants and message helpers,
 * matched to how Pydantic Logfire / pydantic-ai shape their spans.
 *
 * pydantic-ai span tree (what we mirror):
 *   agent run            gen_ai.operation.name = "invoke_agent"
 *   ├─ chat <model>      gen_ai.operation.name = "chat"
 *   └─ running tool      gen_ai.operation.name = "execute_tool"
 *
 * These helpers are pure so they can be unit-tested without an OTel SDK.
 */

// Operation / provider / identity
export const ATTR_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_SYSTEM = "gen_ai.system";
export const ATTR_PROVIDER_NAME = "gen_ai.provider.name";
export const ATTR_AGENT_NAME = "gen_ai.agent.name";
export const ATTR_AGENT_CALL_ID = "gen_ai.agent.call.id";
export const ATTR_CONVERSATION_ID = "gen_ai.conversation.id";
export const ATTR_ERROR_TYPE = "error.type";

// Request / response
export const ATTR_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_FINISH_REASONS = "gen_ai.response.finish_reasons";

// Usage
export const ATTR_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";

// Tool (pydantic-ai uses these on the `running tool` span)
export const ATTR_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_TOOL_ARGUMENTS = "tool_arguments";
export const ATTR_TOOL_RESPONSE = "tool_response";

// Messages (pydantic-ai records the running conversation on chat spans)
export const ATTR_INPUT_MESSAGES = "gen_ai.input.messages";
export const ATTR_OUTPUT_MESSAGES = "gen_ai.output.messages";

/**
 * Logfire reads this attribute to learn which (JSON-string) attributes are
 * structured, so its UI parses + renders them as rich panels rather than raw
 * strings. Verified necessary: without it, gen_ai.input.messages stays an
 * opaque string in the Logfire UI.
 */
export const ATTR_LOGFIRE_JSON_SCHEMA = "logfire.json_schema";

/** Build a logfire.json_schema value declaring the given attrs as JSON. */
export function buildLogfireJsonSchema(
	props: Record<string, "array" | "object">,
): string {
	const properties: Record<string, { type: string }> = {};
	for (const [k, t] of Object.entries(props)) properties[k] = { type: t };
	return JSON.stringify({ type: "object", properties });
}

// pydantic-ai convenience attributes on the agent-run span
export const ATTR_PAI_AGENT_NAME = "agent_name";
export const ATTR_PAI_MODEL_NAME = "model_name";
export const ATTR_PAI_FINAL_RESULT = "final_result";
export const ATTR_PAI_ALL_MESSAGES = "pydantic_ai.all_messages";

// Operation values
export const OP_INVOKE_AGENT = "invoke_agent";
export const OP_CHAT = "chat";
export const OP_EXECUTE_TOOL = "execute_tool";

// Span names (match pydantic-ai exactly)
export const SPAN_AGENT_RUN = "agent run";
export const SPAN_RUNNING_TOOL = "running tool";
export const spanChatName = (model: string | undefined): string =>
	model ? `chat ${model}` : "chat";

export type ContentCapture = "metadata_only" | "no_tool_content" | "full";

const MAX_ATTR_BYTES = 60 * 1024;

/** Truncate an attribute value to ~60 KB, JSON-stringifying non-strings. */
export function clampAttr(value: unknown): string {
	let s: string;
	if (typeof value === "string") s = value;
	else {
		try {
			s = JSON.stringify(value);
		} catch {
			s = String(value);
		}
	}
	if (Buffer.byteLength(s, "utf8") <= MAX_ATTR_BYTES) return s;
	let end = MAX_ATTR_BYTES;
	while (Buffer.byteLength(s.slice(0, end), "utf8") > MAX_ATTR_BYTES - 32)
		end -= 64;
	return `${s.slice(0, end)}…[truncated]`;
}

interface Part {
	type: string;
	[k: string]: unknown;
}

const PER_FIELD_MAX = 8000;
const TOTAL_MAX = 58000;

function truncStr(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…[truncated]`;
}

/**
 * Serialize a GenAI messages array to JSON that stays VALID even when large.
 * Byte-truncating the final JSON string (as clampAttr does) yields invalid JSON
 * that Logfire stores as an opaque string instead of rendering — pi's system
 * prompt alone can exceed 60 KB. So we truncate the long *leaf* string fields
 * inside each message/part, then drop oldest messages if still over budget.
 */
export function clampMessages(messages: Array<Record<string, unknown>>): string {
	const leafKeys = ["content", "text", "arguments", "result", "response"];
	const safe = messages.map((m) => {
		const parts = Array.isArray(m.parts)
			? (m.parts as Part[]).map((p) => {
					const q: Record<string, unknown> = { ...p };
					for (const k of leafKeys) {
						if (typeof q[k] === "string") q[k] = truncStr(q[k] as string, PER_FIELD_MAX);
					}
					return q;
				})
			: m.parts;
		return { ...m, parts };
	});
	let out = JSON.stringify(safe);
	// Still too big: drop oldest non-system messages, keeping recent context.
	while (out.length > TOTAL_MAX && safe.length > 1) {
		safe.splice(safe[0]?.role === "system" ? 1 : 0, 1);
		out = JSON.stringify(safe);
	}
	return out;
}

/** Concatenate the text parts of a pi message `content` (string | parts[]). */
export function extractMessageText(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const p of content as Part[]) {
		if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
			parts.push(p.text);
	}
	return parts.join("\n");
}

/**
 * Build pydantic-ai-style assistant `parts` from pi assistant message content:
 *   [{type:"thinking",content}, {type:"text",content}, {type:"tool_call",id,name,arguments}]
 * `includeToolArgs=false` keeps the tool_call part but drops the arguments body.
 */
export function buildAssistantParts(
	content: unknown,
	includeToolArgs: boolean,
): Part[] {
	if (typeof content === "string") return content ? [{ type: "text", content }] : [];
	if (!Array.isArray(content)) return [];
	const parts: Part[] = [];
	for (const p of content as Part[]) {
		if (!p || typeof p !== "object") continue;
		if (p.type === "text" && typeof p.text === "string") {
			parts.push({ type: "text", content: p.text });
		} else if (
			(p.type === "thinking" || p.type === "reasoning") &&
			typeof (p.text ?? p.content) === "string"
		) {
			parts.push({ type: "thinking", content: (p.text ?? p.content) as string });
		} else if (p.type === "toolCall" || p.type === "tool_call" || p.type === "tool_use") {
			const id = p.id ?? p.toolCallId ?? p.tool_call_id ?? p.toolUseId;
			const name = p.name ?? p.toolName ?? p.tool_name;
			const rawArgs = p.arguments ?? p.input ?? p.args;
			const part: Part = { type: "tool_call", id, name };
			if (includeToolArgs && rawArgs !== undefined) {
				part.arguments = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
			}
			parts.push(part);
		}
	}
	return parts;
}

/**
 * Render a pi tool result to a plain string, like pydantic-ai's `tool_response`.
 * pi tool results are usually `{ content: [{type:"text",text}], details }`.
 */
export function extractToolResultText(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result;
	if (typeof result === "object") {
		const content = (result as { content?: unknown }).content;
		if (content !== undefined) {
			const text = extractMessageText(content);
			if (text) return text;
		}
	}
	return clampAttr(result);
}

/** Pull token usage off a pi assistant message.usage onto an attributes record. */
export function applyUsageAttrs(
	attrs: Record<string, unknown>,
	usage: unknown,
): void {
	if (!usage || typeof usage !== "object") return;
	const u = usage as Record<string, unknown>;
	const set = (k: string, v: unknown) => {
		if (typeof v === "number" && Number.isFinite(v)) attrs[k] = v;
	};
	set(ATTR_INPUT_TOKENS, u.input ?? u.inputTokens ?? u.input_tokens);
	set(ATTR_OUTPUT_TOKENS, u.output ?? u.outputTokens ?? u.output_tokens);
}

// pi uses provider-ish finish reasons (e.g. "toolUse", "end_turn"); map them to
// the snake_case GenAI/pydantic-ai vocabulary ("tool_call", "stop", …).
const FINISH_REASON_MAP: Record<string, string> = {
	tooluse: "tool_call",
	tool_use: "tool_call",
	toolcalls: "tool_call",
	tool_calls: "tool_call",
	tool_call: "tool_call",
	endturn: "stop",
	end_turn: "stop",
	stop: "stop",
	stop_sequence: "stop",
	maxtokens: "length",
	max_tokens: "length",
	length: "length",
	error: "error",
	content_filter: "content_filter",
};

/** Normalize a pi finish/stop reason to the snake_case GenAI vocabulary. */
export function normalizeFinishReason(message: Record<string, unknown>): string {
	const f = message.finishReason ?? message.stopReason ?? message.finish_reason;
	if (typeof f !== "string") return "stop";
	return FINISH_REASON_MAP[f.toLowerCase()] ?? f.toLowerCase();
}
