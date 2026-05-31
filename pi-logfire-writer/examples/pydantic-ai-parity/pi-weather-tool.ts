/** Minimal pi extension that mirrors the pydantic-ai demo's get_weather tool. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_weather",
		label: "Get Weather",
		description: "Return the current weather for a city.",
		parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
		async execute(_toolCallId, params: { city: string }) {
			return {
				content: [{ type: "text", text: `It is 21C and sunny in ${params.city}.` }],
				details: {},
			};
		},
	});
}
