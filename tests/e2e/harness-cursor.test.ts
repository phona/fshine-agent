// [L4 集成] fshine + 17dz 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 夹具光标保真（2026-11-04 诊断的正式化）：
 * gatedWorker 一轮只消费光标后剩余的段，最后一项不夹回重跑。
 * 旧循环按脚本总长度跑，第二轮会把最后一项跑两次：
 * interactive 续跑案里 execute heavyPlan 因此 21 次变 42 次，5 秒等待超时。
 * 本案用纯文本段复现同一形状，不跑平台查询，速度快且不依赖财税语义。
 * end 段是分段点：第一轮在 end 处收手，乙段留给第二轮。
 */
import { describe, expect, it } from 'vitest';
import { boot, gatedWorker, mainDriver } from './harness';

describe('[L4 集成] harness 光标保真', () => {
  it('第二轮只消费剩余段一次，最后一项不重复', async () => {
    const b = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '第一段任务' },
        { kind: 'delegate', request: '第二段任务' },
      ]),
      worker: gatedWorker([
        { text: '光标甲' },
        { end: true },
        { text: '光标乙' },
      ]),
    });
    try {
      const first = await b.send('第一段任务');
      expect(first).toContain('光标甲');
      expect(first).not.toContain('光标乙');
      const second = await b.send('第二段任务');
      expect(second).toContain('光标乙');
      const count = second.split('光标乙').length - 1;
      expect(count, '第二轮把最后一项跑了两次（光标夹回）').toBe(1);
    } finally {
      await b.assembly.close();
    }
  });
});
