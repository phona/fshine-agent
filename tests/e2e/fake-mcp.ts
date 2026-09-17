import type {
  DiscoveredResource,
  DiscoveredTool,
  Envelope,
  HostToolClient,
  McpToolName,
  ResourceReadResult,
  ResourceOutcome,
  ToolOutcome,
} from '@fshine/contracts';
import { createFakeServerTransport, type FakeServerOptions, type FakeServerTransport } from '@fshine/mcp-fake';

type JsonRpcResponse = Record<string, unknown>;

/**
 * A HostToolClient backed directly by the Fake MCP transport.
 * There is deliberately no McpHost/stdio layer here: E2E tests must exercise
 * the MCP contract in-process and remain hermetic.
 */
export class InProcessFakeMcpClient implements HostToolClient {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  readonly resourceReads: string[] = [];
  readonly transport: FakeServerTransport;
  private id = 0;
  private discoveredTools: DiscoveredTool[] = [];
  private discoveredResources: DiscoveredResource[] = [];

  private constructor(transport: FakeServerTransport) {
    this.transport = transport;
  }

  static async create(options: FakeServerOptions = {}): Promise<InProcessFakeMcpClient> {
    const client = new InProcessFakeMcpClient(createFakeServerTransport(options));
    const initialized = await client.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { resources: {} },
      clientInfo: { name: 'fshine-e2e', version: '1' },
    });
    if (!initialized['result']) throw new Error(`Fake MCP initialize failed: ${JSON.stringify(initialized)}`);
    await client.notify('notifications/initialized');

    const tools = await client.rpc('tools/list');
    client.discoveredTools = ((tools['result'] as { tools?: DiscoveredTool[] } | undefined)?.tools ?? []);
    const resources = await client.rpc('resources/list');
    client.discoveredResources = ((resources['result'] as { resources?: DiscoveredResource[] } | undefined)?.resources ?? []);
    return client;
  }

  tools(): readonly DiscoveredTool[] {
    return this.discoveredTools;
  }

  resources(): readonly DiscoveredResource[] {
    return this.discoveredResources;
  }

  async call(tool: McpToolName, args: Record<string, unknown>): Promise<ToolOutcome> {
    this.calls.push({ tool, args });
    const response = await this.rpc('tools/call', { name: tool, arguments: args });
    return parseToolOutcome(response, tool);
  }

  async readResource(uri: string): Promise<ResourceOutcome> {
    this.resourceReads.push(uri);
    const response = await this.rpc('resources/read', { uri });
    const result = response['result'] as { contents?: unknown } | undefined;
    if (!result || !Array.isArray(result.contents)) {
      return { ok: false, error: { code: 'INTERNAL', message: `Fake resource read failed: ${uri}`, retryable: false } };
    }
    return { ok: true, data: { contents: result.contents as ResourceReadResult['contents'] } };
  }

  callsOf(tool: string): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.tool === tool).map((call) => call.args);
  }

  private async rpc(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', id: ++this.id, method };
    if (params !== undefined) body.params = params;
    const lines = await this.transport.handleLine(JSON.stringify(body));
    if (lines.length !== 1) throw new Error(`${method} expected one response, got ${lines.length}`);
    return JSON.parse(lines[0]!) as JsonRpcResponse;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    const lines = await this.transport.handleLine(JSON.stringify(body));
    if (lines.length !== 0) throw new Error(`${method} notification returned a response`);
  }
}

function parseToolOutcome(response: JsonRpcResponse, tool: string): ToolOutcome {
  const result = response['result'] as { content?: Array<{ text?: unknown }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'INTERNAL', message: `${tool} returned no envelope`, retryable: false } };
  }
  const envelope = JSON.parse(text) as Envelope;
  if ('error' in envelope) return { ok: false, error: envelope.error, meta: envelope.meta };
  return { ok: true, data: envelope.data, meta: envelope.meta };
}
