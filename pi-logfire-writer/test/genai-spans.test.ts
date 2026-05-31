import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	buildAssistantParts,
	extractMessageText,
	extractToolResultText,
	normalizeFinishReason,
	spanChatName,
} from "../genai-attrs.ts";
import { GenAiSpanTracker } from "../genai-spans.ts";

test("spanChatName matches pydantic-ai 'chat <model>'", () => {
	assert.equal(spanChatName("gpt-4o"), "chat gpt-4o");
	assert.equal(spanChatName(undefined), "chat");
});

test("extractMessageText flattens string and text parts", () => {
	assert.equal(extractMessageText("hi"), "hi");
	assert.equal(
		extractMessageText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
		"a\nb",
	);
	assert.equal(extractMessageText([{ type: "toolCall", id: "x" }]), "");
});

test("buildAssistantParts produces pydantic-ai part shapes", () => {
	const parts = buildAssistantParts(
		[
			{ type: "thinking", text: "hmm" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "tc1", name: "get_weather", arguments: { city: "Paris" } },
		],
		true,
	);
	assert.deepEqual(parts, [
		{ type: "thinking", content: "hmm" },
		{ type: "text", content: "answer" },
		{ type: "tool_call", id: "tc1", name: "get_weather", arguments: '{"city":"Paris"}' },
	]);
	// without tool content, the tool_call is kept but arguments dropped
	const noArgs = buildAssistantParts(
		[{ type: "toolCall", id: "tc1", name: "get_weather", arguments: { city: "Paris" } }],
		false,
	);
	assert.deepEqual(noArgs, [{ type: "tool_call", id: "tc1", name: "get_weather" }]);
});

test("extractToolResultText renders structured pi tool results to plain text", () => {
	assert.equal(extractToolResultText("plain"), "plain");
	assert.equal(
		extractToolResultText({ content: [{ type: "text", text: "hello-genai-trace" }], details: {} }),
		"hello-genai-trace",
	);
	// falls back to JSON when there is no text content
	assert.equal(extractToolResultText({ foo: 1 }), '{"foo":1}');
});

test("normalizeFinishReason reads pi finish/stop fields", () => {
	assert.equal(normalizeFinishReason({ finishReason: "tool_call" }), "tool_call");
	assert.equal(normalizeFinishReason({ stopReason: "end_turn" }), "end_turn");
	assert.equal(normalizeFinishReason({}), "stop");
});

function setup() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	const tracker = new GenAiSpanTracker({
		tracer: provider.getTracer("test"),
		captureContent: "full",
		agentName: "pi",
		system: "pi",
		provider: "pi",
		conversationId: () => "sess-123",
	});
	return { exporter, tracker };
}

test("tracker emits pydantic-ai-shaped span tree (agent run / chat / running tool)", () => {
	const { exporter, tracker } = setup();

	tracker.startAgentRun("What is the weather in Paris?", "You are a helpful assistant.");
	tracker.noteUserMessage("What is the weather in Paris?");

	// First chat: model decides to call a tool.
	tracker.startChat("Qwen/Qwen3.5-122B-A10B-FP8");
	tracker.endChatWithAssistant({
		role: "assistant",
		model: "Qwen/Qwen3.5-122B-A10B-FP8",
		finishReason: "tool_call",
		usage: { inputTokens: 317, outputTokens: 64 },
		content: [{ type: "toolCall", id: "tc1", name: "get_weather", arguments: { city: "Paris" } }],
	});

	// Tool runs.
	tracker.startTool("tc1", "get_weather", { city: "Paris" });
	// pi tool results are structured objects; tool_response should be plain text.
	tracker.endTool("tc1", {
		isError: false,
		result: { content: [{ type: "text", text: "It is 21C and sunny in Paris." }], details: {} },
	});
	tracker.noteToolResultMessage({ toolCallId: "tc1", toolName: "get_weather", content: "It is 21C and sunny in Paris." });

	// Second chat: final answer.
	tracker.startChat("Qwen/Qwen3.5-122B-A10B-FP8");
	tracker.endChatWithAssistant({
		role: "assistant",
		model: "Qwen/Qwen3.5-122B-A10B-FP8",
		finishReason: "stop",
		usage: { inputTokens: 400, outputTokens: 12 },
		content: [{ type: "text", text: "It is 21C and sunny in Paris." }],
	});

	tracker.endAgentRun();

	const spans = exporter.getFinishedSpans();
	const byName = (n: string) => spans.filter((s) => s.name === n);

	// Names match pydantic-ai exactly.
	assert.equal(byName("agent run").length, 1);
	assert.equal(byName("chat Qwen/Qwen3.5-122B-A10B-FP8").length, 2);
	assert.equal(byName("running tool").length, 1);

	const agent = byName("agent run")[0];
	assert.equal(agent.attributes["gen_ai.operation.name"], "invoke_agent");
	assert.equal(agent.attributes["gen_ai.usage.input_tokens"], 717); // 317 + 400
	assert.equal(agent.attributes["gen_ai.usage.output_tokens"], 76); // 64 + 12
	assert.equal(agent.attributes["final_result"], "It is 21C and sunny in Paris.");

	const chat1 = byName("chat Qwen/Qwen3.5-122B-A10B-FP8")[0];
	assert.equal(chat1.attributes["gen_ai.operation.name"], "chat");
	assert.equal(chat1.attributes["gen_ai.request.model"], "Qwen/Qwen3.5-122B-A10B-FP8");
	assert.deepEqual(chat1.attributes["gen_ai.response.finish_reasons"], ["tool_call"]);
	// input messages = system + user (snapshot before assistant)
	const inMsgs = JSON.parse(chat1.attributes["gen_ai.input.messages"] as string);
	assert.equal(inMsgs[0].role, "system");
	assert.equal(inMsgs[1].role, "user");
	const outMsgs = JSON.parse(chat1.attributes["gen_ai.output.messages"] as string);
	assert.equal(outMsgs[0].role, "assistant");
	assert.equal(outMsgs[0].parts[0].type, "tool_call");
	assert.equal(outMsgs[0].finish_reason, "tool_call");

	const tool = byName("running tool")[0];
	assert.equal(tool.attributes["gen_ai.operation.name"], "execute_tool");
	assert.equal(tool.attributes["gen_ai.tool.name"], "get_weather");
	assert.equal(tool.attributes["gen_ai.tool.call.id"], "tc1");
	assert.equal(tool.attributes["tool_response"], "It is 21C and sunny in Paris.");

	// Tool and chat are children of agent run; all share one trace.
	const traceId = agent.spanContext().traceId;
	for (const s of spans) assert.equal(s.spanContext().traceId, traceId);
	const parentOf = (s: { parentSpanId?: string; parentSpanContext?: { spanId: string } }) =>
		s.parentSpanId ?? s.parentSpanContext?.spanId;
	assert.equal(parentOf(tool), agent.spanContext().spanId);
	assert.equal(parentOf(chat1), agent.spanContext().spanId);

	// Second chat's input includes the tool response (running conversation grows).
	const chat2 = byName("chat Qwen/Qwen3.5-122B-A10B-FP8")[1];
	const in2 = JSON.parse(chat2.attributes["gen_ai.input.messages"] as string);
	assert.ok(in2.some((m: { role: string }) => m.role === "tool"));
});

test("metadata_only capture omits message bodies but keeps structure", () => {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	const tracker = new GenAiSpanTracker({
		tracer: provider.getTracer("t"),
		captureContent: "metadata_only",
		agentName: "pi",
		system: "pi",
		provider: "pi",
		conversationId: () => undefined,
	});
	tracker.startAgentRun("secret prompt", "secret system");
	tracker.startChat("m");
	tracker.endChatWithAssistant({ role: "assistant", model: "m", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: "text", text: "secret answer" }] });
	tracker.endAgentRun();

	const chat = exporter.getFinishedSpans().find((s) => s.name === "chat m")!;
	assert.equal(chat.attributes["gen_ai.operation.name"], "chat");
	// no message content captured
	assert.equal(chat.attributes["gen_ai.input.messages"], undefined);
	assert.equal(chat.attributes["gen_ai.output.messages"], undefined);
	// but token usage / finish reason still present
	assert.deepEqual(chat.attributes["gen_ai.response.finish_reasons"], ["stop"]);
});
