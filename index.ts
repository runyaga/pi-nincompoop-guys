import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installLogfireMcp } from "./logfire-mcp.ts";

/**
 * pi-logfire-mcp
 *
 * Bridges the Pydantic Logfire OpenTelemetry MCP server into pi as native tools.
 * Configure with the LOGFIRE_READ_TOKEN environment variable (and optionally
 * LOGFIRE_MCP_URL to point at a different region or a self-hosted instance).
 */
export default function (pi: ExtensionAPI) {
	installLogfireMcp(pi);
}
