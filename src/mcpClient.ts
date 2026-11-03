import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const DEFAULT_ENDPOINT = "https://mcp.excalidraw.com/mcp";
const REQUEST_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 45_000;

export interface McpToolInfo {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: unknown;
}

export interface McpToolResult {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface ExcalidrawMcp {
  readonly endpoint: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

const boundedFetch: typeof fetch = (url, options) =>
  fetch(url, {
    ...options,
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

/** The hosted Excalidraw MCP needs no credentials; every call opens a short-lived session. */
export class HostedExcalidrawMcp implements ExcalidrawMcp {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly endpoint: string = DEFAULT_ENDPOINT,
    private readonly request: typeof fetch = boundedFetch,
  ) {}

  private withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const client = new Client({ name: "marshal-excalidraw", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.endpoint), { fetch: this.request });
      try {
        await client.connect(transport);
        return await run(client);
      } catch (error) {
        throw new Error(`Excalidraw MCP at ${this.endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  listTools(): Promise<McpToolInfo[]> {
    return this.withClient(async (client) => {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(
          ...page.tools.map(({ name, title, description, inputSchema, annotations }) => ({
            name,
            title,
            description,
            inputSchema,
            annotations,
          })),
        );
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    });
  }

  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.withClient(
      async (client) => (await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS })) as McpToolResult,
    );
  }
}

export function resultText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function assertOk(result: McpToolResult, operation: string): McpToolResult {
  if (result.isError) throw Object.assign(new Error(`${operation}: ${resultText(result) || "the Excalidraw MCP returned an error."}`), { code: "invalid_request" });
  return result;
}
