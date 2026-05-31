import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "get_weather",
		label: "Get Weather",
		description: "Return the current weather for a city.",
		parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
		async execute(_id, params: { city: string }) {
			throw new Error(`weather service exploded for ${params.city}`);
		},
	});
}
