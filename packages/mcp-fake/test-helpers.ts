import type { Envelope, ErrorEnvelope, SuccessEnvelope } from '@fshine/contracts';
import {
  createFakeServerTransport,
  type FakeServerOptions,
  type FakeServerTransport,
} from './src/server';

export function makeTransport(options: FakeServerOptions = {}): FakeServerTransport {
  return createFakeServerTransport(options);
}

export type RpcResponse = Record<string, unknown>;

export function parseSingleLine(lines: string[]): RpcResponse {
  if (lines.length !== 1) throw new Error(`期望 1 行响应,实际 ${lines.length} 行`);
  const raw = lines[0];
  if (raw === undefined) throw new Error('响应行为空');
  return JSON.parse(raw) as RpcResponse;
}

export async function rpc(
  transport: FakeServerTransport,
  id: number,
  method: string,
  params?: unknown,
): Promise<RpcResponse> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
  if (params !== undefined) body.params = params;
  return parseSingleLine(await transport.handleLine(JSON.stringify(body)));
}

export interface ToolCallOutcome {
  raw: RpcResponse;
  isError: boolean;
  envelope: Envelope;
}

export async function callTool(
  transport: FakeServerTransport,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallOutcome> {
  const raw = await rpc(transport, id, 'tools/call', { name, arguments: args });
  const result = raw['result'] as { content?: Array<{ type?: unknown; text?: unknown }>; isError?: unknown };
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    throw new Error(`tools/call 响应缺少 content: ${JSON.stringify(raw)}`);
  }
  const first = result.content[0];
  if (!first || typeof first.text !== 'string') throw new Error('content[0].text 缺失');
  const envelope = JSON.parse(first.text) as Envelope;
  return { raw, isError: result.isError === true, envelope };
}

export function asSuccess(envelope: Envelope): SuccessEnvelope {
  if (!('data' in envelope)) throw new Error(`期望成功信封,实际: ${JSON.stringify(envelope)}`);
  return envelope as SuccessEnvelope;
}

export function asError(envelope: Envelope): ErrorEnvelope {
  if (!('error' in envelope)) throw new Error(`期望错误信封,实际: ${JSON.stringify(envelope)}`);
  return envelope as ErrorEnvelope;
}
