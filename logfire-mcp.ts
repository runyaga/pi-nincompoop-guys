import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Bridge between pi and the Pydantic Logfire OpenTelemetry MCP server.
 *
 * Pi has no native MCP client, so this acts as a Streamable-HTTP MCP client:
 * it connects to the remote Logfire MCP endpoint, discovers the tools it
 * exposes (querying traces/metrics, schemas, exceptions, arbitrary SQL, ...),
 * and registers each one as a native pi tool that proxies calls back over MCP.
 */

const DEFAULT_URL = "https://logfire-us.pydantic.dev/mcp";
const TOOL_PREFIX = "logfire_";
const CLIENT_INFO = { name: "pi-logfire-mcp", version: "0.1.0" };

interface LogfireConfig {
	url: string;
	token: string | undefined;
}

interface McpContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface McpCallResult {
	content?: McpContentBlock[];
	isError?: boolean;
	structuredContent?: unknown;
}

interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Read connection settings from the environment. The read token is never hardcoded. */
export function readConfig(): LogfireConfig {
	const url = process.env.LOGFIRE_MCP_URL?.trim() || DEFAULT_URL;
	const token =
		process.env.LOGFIRE_READ_TOKEN?.trim() ||
		process.env.LOGFIRE_TOKEN?.trim() ||
		undefined;
	return { url, token };
}

/** Turn an MCP tool name into a valid, namespaced pi tool name. */
function piToolName(mcpName: string): string {
	const sanitized = mcpName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `${TOOL_PREFIX}${sanitized || "tool"}`;
}

/** Flatten an MCP tool result into pi's text content + raw details. */
function toPiResult(result: McpCallResult): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: boolean;
} {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	const parts: string[] = [];
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else {
			// Non-text blocks (images, embedded resources, ...) are rare for
			// Logfire's data tools; preserve them as JSON so nothing is lost.
			parts.push(JSON.stringify(block));
		}
	}
	if (parts.length === 0 && result?.structuredContent !== undefined) {
		parts.push(JSON.stringify(result.structuredContent, null, 2));
	}
	const text = parts.join("\n").trim() || "(no content returned)";
	return {
		content: [{ type: "text", text }],
		details: { isError: Boolean(result?.isError), raw: result },
		isError: Boolean(result?.isError),
	};
}

export class LogfireMcpBridge {
	private readonly pi: ExtensionAPI;
	private config: LogfireConfig;
	private client: Client | undefined;
	private transport: StreamableHTTPClientTransport | undefined;
	private readonly registeredTools = new Set<string>();
	/** pi tool name -> original MCP tool name */
	private readonly toolNameMap = new Map<string, string>();
	private toolCount = 0;
	private lastError: string | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.config = readConfig();
	}

	hasToken(): boolean {
		return Boolean(this.config.token);
	}

	status(): string {
		if (!this.config.token) {
			return "no LOGFIRE_READ_TOKEN set";
		}
		if (this.lastError) {
			return `error: ${this.lastError}`;
		}
		if (this.client) {
			return `connected to ${this.config.url} (${this.toolCount} tools)`;
		}
		return "not connected";
	}

	/** Connect to the Logfire MCP server and register its tools as pi tools. */
	async connect(): Promise<{ ok: boolean; toolCount: number; error?: string }> {
		this.config = readConfig();
		if (!this.config.token) {
			this.lastError = "LOGFIRE_READ_TOKEN is not set";
			return { ok: false, toolCount: 0, error: this.lastError };
		}

		// Tear down any prior connection before reconnecting.
		await this.close();

		try {
			const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
				requestInit: {
					headers: { Authorization: `Bearer ${this.config.token}` },
				},
			});
			const client = new Client(CLIENT_INFO, { capabilities: {} });
			await client.connect(transport);

			this.transport = transport;
			this.client = client;
			this.lastError = undefined;

			const { tools } = (await client.listTools()) as { tools: McpToolDescriptor[] };
			this.toolCount = tools.length;
			for (const tool of tools) {
				this.registerProxyTool(tool);
			}
			return { ok: true, toolCount: tools.length };
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : String(err);
			this.client = undefined;
			this.transport = undefined;
			return { ok: false, toolCount: 0, error: this.lastError };
		}
	}

	private registerProxyTool(tool: McpToolDescriptor): void {
		const name = piToolName(tool.name);
		this.toolNameMap.set(name, tool.name);

		// pi refreshes tool definitions on re-registration, so updating an
		// already-registered tool (e.g. on reconnect) is safe and idempotent.
		const parameters = (tool.inputSchema as Record<string, unknown>) ?? {
			type: "object",
			properties: {},
		};

		this.pi.registerTool({
			name,
			label: `Logfire: ${tool.name}`,
			description: tool.description ?? `Logfire MCP tool "${tool.name}"`,
			parameters: parameters as never,
			promptSnippet: `Logfire observability — ${tool.name}`,
			execute: async (
				_toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
			) => {
				const result = await this.callTool(tool.name, params, signal);
				return toPiResult(result);
			},
		});

		this.registeredTools.add(name);
	}

	private async callTool(
		mcpName: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<McpCallResult> {
		if (!this.client) {
			const reconnect = await this.connect();
			if (!reconnect.ok || !this.client) {
				return {
					content: [
						{
							type: "text",
							text: `Not connected to Logfire MCP: ${reconnect.error ?? "unknown error"}`,
						},
					],
					isError: true,
				};
			}
		}

		try {
			return (await this.client!.callTool(
				{ name: mcpName, arguments: args },
				undefined,
				signal ? { signal } : undefined,
			)) as McpCallResult;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Logfire MCP call failed: ${message}` }],
				isError: true,
			};
		}
	}

	async close(): Promise<void> {
		try {
			await this.client?.close();
		} catch {
			// ignore teardown errors
		}
		this.client = undefined;
		this.transport = undefined;
	}

	registeredToolNames(): string[] {
		return [...this.registeredTools];
	}
}

/** Wire the bridge into pi: connect at startup, expose status/reconnect commands. */
export function installLogfireMcp(pi: ExtensionAPI): LogfireMcpBridge {
	const bridge = new LogfireMcpBridge(pi);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!bridge.hasToken()) {
			ctx.ui.notify(
				"logfire-mcp: LOGFIRE_READ_TOKEN not set — Logfire tools disabled. Run /logfire-reconnect after setting it.",
				"warning",
			);
			return;
		}
		const result = await bridge.connect();
		if (result.ok) {
			ctx.ui.notify(`logfire-mcp: connected, ${result.toolCount} tools available`, "info");
		} else {
			ctx.ui.notify(`logfire-mcp: connection failed — ${result.error}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await bridge.close();
	});

	pi.registerCommand("logfire-status", {
		description: "Show Logfire MCP connection status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`logfire-mcp: ${bridge.status()}`, "info");
		},
	});

	pi.registerCommand("logfire-reconnect", {
		description: "Reconnect to the Logfire MCP server and refresh tools",
		handler: async (_args, ctx) => {
			const result = await bridge.connect();
			if (result.ok) {
				ctx.ui.notify(`logfire-mcp: reconnected, ${result.toolCount} tools available`, "info");
			} else {
				ctx.ui.notify(`logfire-mcp: reconnect failed — ${result.error}`, "error");
			}
		},
	});

	return bridge;
}
