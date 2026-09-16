import { fileURLToPath } from 'node:url';
import type { ToolOutcome } from '@fshine/contracts';
import type { McpProfileConfig } from '@fshine/contracts';
import { McpHost, type McpHostAudit, type McpHostOptions, type McpToolCallEndEvent, type McpToolCallStartEvent } from './src/index';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export function fakeProfile(env: Record<string, string> = {}, overrides: Partial<McpProfileConfig> = {}): McpProfileConfig {
  return {
    command: 'npx',
    args: ['tsx', 'packages/mcp-fake/src/main.ts'],
    cwd: repoRoot,
    requestTimeoutMs: 30_000,
    maxRetries: 0,
    env,
    ...overrides,
  };
}

export interface MakeHostOverrides extends Partial<Omit<McpHostOptions, 'profile'>> {
  profile?: Partial<McpProfileConfig>;
}

export function makeHost(env: Record<string, string> = {}, overrides: MakeHostOverrides = {}, audit?: McpHostAudit): McpHost {
  return new McpHost({
    profile: fakeProfile(env, overrides.profile ?? {}),
    channelBudgetMs: overrides.channelBudgetMs,
    audit,
  });
}

export function makeHostWithProfile(profile: McpProfileConfig, audit?: McpHostAudit): McpHost {
  return new McpHost({ profile, audit });
}

export class AuditRecorder implements McpHostAudit {
  readonly starts: McpToolCallStartEvent[] = [];
  readonly ends: McpToolCallEndEvent[] = [];
  readonly onStart = (event: McpToolCallStartEvent): void => {
    this.starts.push(event);
  };
  readonly onEnd = (event: McpToolCallEndEvent): void => {
    this.ends.push(event);
  };
}

export function expectOk(outcome: ToolOutcome): Extract<ToolOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望成功,实际错误: ${JSON.stringify(outcome.error)}`);
  return outcome;
}

export function expectErr(outcome: ToolOutcome): Extract<ToolOutcome, { ok: false }> {
  if (outcome.ok) throw new Error(`期望失败,实际数据: ${JSON.stringify(outcome.data)}`);
  return outcome;
}

/** 汇报 specVersion '0.4' 的最小 stdio JSON-RPC server(node -e 内联,CJS)。 */
export const BAD_SPEC_SERVER_SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'legacy', version: '9.9.9', specVersion: '0.4', allowedAccountSets: null },
      },
    }) + '\\n');
  } else if (msg.id !== undefined && msg.id !== null) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\\n');
  }
});
`;

/** 合法 17dz spec 但返回未协商的 MCP protocolVersion。 */
export const BAD_PROTOCOL_SERVER_SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05', capabilities: {},
      serverInfo: { name: 'legacy', version: '1.0.0', specVersion: '0.5', allowedAccountSets: null },
    }}) + '\\n');
  }
});
`;

/** 合法 specVersion 但 tools/list 混入写工具的"越权 server":验证 V0 只读白名单硬闸。 */
export const EXTRA_TOOL_SERVER_SCRIPT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const READ = ['get_login_status', 'search_account_sets', 'get_current_accounting_period', 'list_vouchers', 'inspect_account_set'];
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'rogue', version: '0.1.0', specVersion: '0.5', allowedAccountSets: null },
      },
    }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: [...READ, 'submit_voucher'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) },
    }) + '\\n');
  } else if (msg.id !== undefined && msg.id !== null) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ data: {}, meta: { traceId: 'trc_x', retrievedAt: '2026-09-16T00:00:00+08:00', source: 'api_cache' } }) }], isError: false },
    }) + '\\n');
  }
});
`;
