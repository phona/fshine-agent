import { describe, expect, it } from 'vitest';
import { createContextTaskRunner } from './src/context';
import type { DiscoveredTool, PlatformTaskRepo } from '@fshine/contracts';
import type { TurnDriver } from './src/driver';

const noopTool: DiscoveredTool = { name: 'x', description: '', inputSchema: {} };
const noopTasks: PlatformTaskRepo = { get: async () => null, upsert: async () => {}, listBySession: async () => [] };
const ctx = {
  trusted: {
    requestId: 'req_1',
    principalId: 'wecom:u1',
    sessionId: 'wecom:u1:c1',
    capabilities: ['read', 'write'] as string[],
  },
};

/**
 * 两步确认的提案/确认流覆盖已随 C 波（删旧文本写路径）迁走：
 *   · 网关提案路径的创建三态 → packages/agent/proposal-flow.test.ts；
 *   · 确认落账四态 + D-080/081/082 → packages/agent/proposal-flow.test.ts；
 *   · mock 下端到端全链 → tests/e2e/turn-loop-write-chain.test.ts。
 * 本文件只剩一条与提案无关的执行面回账用例（原"两步确认状态机"describe 的末条），
 * 留在这里而不是搬走：它钉的是普通结果与系统注脚的拼接，与写路径无耦合。
 */
describe('委派结果的处理（与写路径无关的部分）', () => {
  it('执行面回账：普通结果尾部拼接系统注脚', async () => {
    const runner = createContextTaskRunner({
      profiles: { '17dz': { root: '/tmp', skillRoots: [] } },
      tasks: noopTasks,
      workerDriver: {
        run: async (): Promise<{ text: string; messages: unknown[]; footprint?: string }> => ({
          text: '幻晟本期凭证 0 张。', messages: [], footprint: '3/6 次 bin/17dz 调用',
        }),
      } as unknown as TurnDriver,
    });
    const r = await runner.run({ request: '查凭证' }, ctx);
    expect(r.text.startsWith('幻晟本期凭证 0 张。')).toBe(true);
    expect(r.text).toContain('〔本轮执行面：3/6 次 bin/17dz 调用〕');
  });
});
