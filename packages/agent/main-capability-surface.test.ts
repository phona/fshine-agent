/**
 * Main 能力面守卫（A4/A5·G2）：capabilities() 只读工具上 Main 面、输出无内部形态、
 * Worker 面不受影响；未注入目录 = 工具面逐字节不变。
 */
import { describe, expect, it } from 'vitest';
import { createTaskRegistry } from './src/task-registry';
import {
  createSession,
  CAPABILITIES_TOOL,
  EXECUTE_OPERATION_TOOL,
  type Session,
} from './src/execution-runtime';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';

const manifest: CapabilityManifest = { contractVersion: 4, operations: [{ name: 'dummy.query', args: [] }] };
const client: ExecutionClient = {
  async capabilities() { return manifest; },
  async execute(_request: ExecutionRequest): Promise<ExecutionOutcome> { return { status: 'completed' }; },
};
function toolingMain(sink: Array<{ tools: string[]; results: unknown[] }>, calls: readonly { tool: string; args: Record<string, unknown> }[]): TurnDriver {
  return {
    async run(input) {
      const results: unknown[] = [];
      for (const call of calls) {
        try { results.push({ ok: true, value: await input.exec(call.tool, call.args) }); }
        catch (error) { results.push({ ok: false, error: String(error) }); }
      }
      sink.push({ tools: input.tools.map((t) => t.name), results });
      return { text: '（测试）', messages: [...input.messages] };
    },
  };
}
const workerDriver: TurnDriver = {
  async run(input) {
    // Worker 面快照：绝不含 capabilities / execute_operation 之外的治理工具。
    return { text: '（worker）', messages: [...input.messages], tools: input.tools };
  },
};
async function build(catalog: Parameters<typeof createSession>[0]['capabilityCatalog'], calls: readonly { tool: string; args: Record<string, unknown> }[]): Promise<{ session: Session; sink: Array<{ tools: string[]; results: unknown[] }> }> {
  const sink: Array<{ tools: string[]; results: unknown[] }> = [];
  const session = await createSession({
    principalId: 'wecom:u', sessionId: 'c', client, allowedOperations: ['dummy.query'],
    mainDriver: toolingMain(sink, calls), workerDriver, mainSystemPrompt: '（测试）',
    taskRegistry: createTaskRegistry(),
    ...(catalog === undefined ? {} : { capabilityCatalog: catalog }),
  });
  return { session, sink };
}

describe('Main 能力目录工具面（A4/G2）', () => {
  it('① 未注入目录 → Main 工具面逐字节不变（无 capabilities）', async () => {
    const { session, sink } = await build(undefined, []);
    await session.send('hi');
    expect(sink[0]!.tools).toEqual(['task_run', 'task_status', 'task_result']);
    expect(sink[0]!.tools).not.toContain(CAPABILITIES_TOOL);
  });

  it('② 注入非空目录 → Main 多一个 capabilities 工具，无 execute_operation', async () => {
    const { session, sink } = await build([{ name: '记录办理', read: true, write: true }], []);
    await session.send('hi');
    expect(sink[0]!.tools).toContain(CAPABILITIES_TOOL);
    expect(sink[0]!.tools).not.toContain(EXECUTE_OPERATION_TOOL);
  });

  it('③ capabilities() 输出只含业务名 + 读/写；不含 operation 名、--、参数名', async () => {
    const catalog = [
      { name: '记录办理', read: true, write: true },
      { name: '长时导出', read: false, write: true },
    ];
    const { session, sink } = await build(catalog, [{ tool: CAPABILITIES_TOOL, args: {} }]);
    await session.send('能办什么');
    const result = JSON.stringify(sink[0]!.results[0]);
    expect(result).toContain('记录办理');
    expect(result).not.toContain('dummy.query');
    expect(result).not.toContain('dummy.');
    expect(result).not.toContain('--');
    expect(result).not.toContain('collection');
  });

  it('④ capabilities 硬发 execute_operation → 被拒（Main 工具面之外）', async () => {
    const { session, sink } = await build([{ name: '记录办理', read: true, write: true }], [
      { tool: EXECUTE_OPERATION_TOOL, args: {} },
    ]);
    await session.send('attempt');
    const result = sink[0]!.results[0] as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('Main 工具面之外的调用');
  });
});
