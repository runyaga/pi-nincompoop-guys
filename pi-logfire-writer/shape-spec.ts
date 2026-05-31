/**
 * Shared span-shape conformance spec.
 *
 * Encodes the pydantic-ai GenAI span shape so the SAME checks can run against
 * both pydantic-ai's spans (fetched from Logfire) and pi-logfire-writer's spans
 * (in-memory or fetched). Keyed by gen_ai.operation.name.
 *
 * `required` = attribute keys that MUST be present (verified against real
 * pydantic-ai traces, with content capture on).
 * `forbidden` = keys that MUST NOT be present (pydantic-ai puts gen_ai.system /
 * gen_ai.provider.name only on `chat` spans, not on agent-run or tool spans).
 *
 * Provider/transport-specific extras that pydantic-ai adds but a generic agent
 * cannot always supply (gen_ai.response.id, server.address, server.port,
 * gen_ai.tool.definitions, model_request_parameters, logfire.metrics) are
 * intentionally NOT required.
 */

const COMMON = [
	"gen_ai.operation.name",
	"gen_ai.agent.name",
	"gen_ai.agent.call.id",
	"gen_ai.conversation.id",
];

export const SHAPE_SPEC: Record<
	string,
	{ spanNamePattern: RegExp; required: string[]; forbidden: string[] }
> = {
	invoke_agent: {
		spanNamePattern: /^agent run$/,
		required: [
			...COMMON,
			"agent_name",
			"model_name",
			"final_result",
			"gen_ai.usage.input_tokens",
			"gen_ai.usage.output_tokens",
			"pydantic_ai.all_messages",
		],
		forbidden: ["gen_ai.system", "gen_ai.provider.name"],
	},
	chat: {
		spanNamePattern: /^chat .+/,
		required: [
			...COMMON,
			"gen_ai.system",
			"gen_ai.provider.name",
			"gen_ai.request.model",
			"gen_ai.response.model",
			"gen_ai.response.finish_reasons",
			"gen_ai.usage.input_tokens",
			"gen_ai.usage.output_tokens",
			"gen_ai.input.messages",
			"gen_ai.output.messages",
		],
		forbidden: [],
	},
	execute_tool: {
		spanNamePattern: /^running tool/,
		required: [
			...COMMON,
			"gen_ai.tool.name",
			"gen_ai.tool.call.id",
			"tool_arguments",
			"tool_response",
		],
		forbidden: ["gen_ai.system", "gen_ai.provider.name"],
	},
};

export interface ShapeResult {
	operation: string;
	ok: boolean;
	missing: string[];
	forbiddenPresent: string[];
	spanNameOk: boolean;
}

/** Check one span's attributes (+ name) against the spec for its operation. */
export function checkShape(
	spanName: string,
	attributes: Record<string, unknown>,
): ShapeResult {
	const operation = String(attributes["gen_ai.operation.name"] ?? "");
	const spec = SHAPE_SPEC[operation];
	if (!spec) {
		return { operation, ok: false, missing: ["<unknown operation>"], forbiddenPresent: [], spanNameOk: false };
	}
	const has = (k: string) => attributes[k] !== undefined && attributes[k] !== null;
	const missing = spec.required.filter((k) => !has(k));
	const forbiddenPresent = spec.forbidden.filter((k) => has(k));
	const spanNameOk = spec.spanNamePattern.test(spanName);
	return {
		operation,
		ok: missing.length === 0 && forbiddenPresent.length === 0 && spanNameOk,
		missing,
		forbiddenPresent,
		spanNameOk,
	};
}
