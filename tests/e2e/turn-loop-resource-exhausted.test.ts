// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：资源耗尽终稿的事实变体（"失败必达"路径 1，2026-10 事故修复）。
 *
 * 事故形状：用户发"做幻骥达工资表"，worker 洗数据 15 分钟撞回合墙钟被强制截停，
 * 任务 outcome=failed，宿主兜底文案"平台响应超时，请稍后重试"——干巴巴、不可行动，
 * 且与企微流式回复的 10 分钟更新窗口叠加后整轮静默。修复后：超时失败被映射为协议
 * 失败分类 RESOURCE_EXHAUSTED，宿主从执行事实（platform_tasks 底账的结构化字段）
 * 合成终稿——已完成部分（已执行操作）/未完成部分/续跑入口。
 *
 * 与 turn-loop-worker-timeout（WT-1 的无事实变体：worker 没提交过计划）互补，本文件
 * 钉"worker 提交过计划、底账带结构化执行事实"的形状：终稿必须点出已执行操作的名字
 * （label + 账套/期间来自底账结构化字段，零 worker 文本嗅探）。分类留痕三处对账：
 * delegation_span 仍记 failed/timeout（context.ts 独立落账）、resource_exhausted_reply
 * 审计事件带 RESOURCE_EXHAUSTED、turn_span 的 outcome 记 resource_exhausted。
 *
 * 替身边界与 harness 同哲学：只替 Main Agent 与 worker 模型驱动，回合契约、
 * ContextTaskRunner、SQLite 底账全是生产代码。
 */
import { describe, expect, it } from 'vitest';
import { boot, mainDriver, type Boot } from './harness';

const PRINCIPAL = 'wecom:e2e_user';
const SESSION = 'wecom:e2e_user';

const USER_ASK = '做一下幻骥达的工资表';
const DELEGATE_ASK = '制作幻骥达 202609 的工资表';

/** worker 替身提交的计划事实（超时回合留下的结构化执行事实，D-065 口径）。 */
const PLAN_FACTS = {
  calls: [{ operation: 'payroll.compute', args: ['contract.json'] }],
  accountSet: '幻辰财税',
  period: '202609',
  label: '工资表计算',
};

/** patchProfile 打进活跃 profile 的 worker 超时（毫秒级，离线夹具不引入秒级等待）。 */
const WORKER_TIMEOUT_MS = 250;
const PAST_DEADLINE_EPSILON_MS = 15;

/** 捕获宿主审计事件（JSON 行的 event 字段），与 turn-loop-worker-timeout 同手法。 */
function captureEvents(): { events: Array<Record<string, unknown>>; restore: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const original = console.info;
  console.info = (line: string) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed['event'] === 'string') events.push(parsed);
    } catch { /* 非 JSON 行 */ }
  };
  return { events, restore: () => { console.info = original; } };
}

describe('[L4 集成] 离线全链 e2e：资源耗尽终稿（事实变体）', () => {
  it('worker 提交过计划后撞墙钟：终稿点出已执行操作（底账结构化事实），分类三处留痕', async () => {
    const worker = {
      // 复刻真实驱动的 deadline 契约：睡到 deadline+ε 再**返回**（不是抛）——
      // 空文本 + 计划事实（worker 撞墙钟前提交过计划，底账因此带结构化字段）。
      run: async (input: { deadline?: number; messages: unknown[] }) => {
        const remain = (input.deadline ?? Date.now()) + PAST_DEADLINE_EPSILON_MS - Date.now();
        if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain));
        return {
          text: '',
          planFacts: PLAN_FACTS,
          messages: [...input.messages, { role: 'assistant', content: '（洗数据进行中…）', timestamp: Date.now() }],
        };
      },
    };
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: mainDriver([{ kind: 'delegate', request: DELEGATE_ASK }]),
        worker: worker as never,
        patchProfile: { workerTimeoutMs: WORKER_TIMEOUT_MS },
      });

      const reply = await booted.send(USER_ASK);

      // ① 终稿三要素 + 事实行：已执行操作的名字来自底账结构化字段（label + 账套/期间），
      //    不是干巴巴的"请稍后重试"。
      expect(reply).toContain('[资源超时]');
      expect(reply).toContain('已完成部分');
      expect(reply).toContain('已执行操作：工资表计算（幻辰财税 202609）');
      expect(reply).toContain('未完成部分');
      expect(reply).toContain('回复“继续”可从断点续跑');
      expect(reply).not.toContain('请稍后重试');

      // ② 分类三处对账：delegation_span 仍 failed/timeout（context.ts 不被改写）；
      //    resource_exhausted_reply 带 RESOURCE_EXHAUSTED；turn_span 记 resource_exhausted。
      const span = audit.events.find((event) => event['event'] === 'delegation_span');
      expect(span?.['outcome']).toBe('failed');
      expect(span?.['failureClass']).toBe('timeout');
      const taskId = span?.['taskId'];
      const exhausted = audit.events.find((event) => event['event'] === 'resource_exhausted_reply');
      expect(exhausted).toBeDefined();
      expect(exhausted!['failureClass']).toBe('RESOURCE_EXHAUSTED');
      expect(exhausted!['taskId']).toBe(taskId);
      const turnSpan = audit.events.filter((event) => event['event'] === 'turn_span').at(-1);
      expect(turnSpan?.['outcome']).toBe('resource_exhausted');

      // ③ 底账：任务条目 outcome=failed 且带结构化执行事实（终稿的数据源），
      //    中间转录已持久化（续跑的断点）。
      const records = await booted.assembly.store.platformTasks!.listBySession(PRINCIPAL, SESSION);
      const failedRecord = records.find((entry) => entry.taskId === taskId);
      expect(failedRecord).toBeDefined();
      expect(failedRecord!.outcome).toBe('failed');
      expect(failedRecord!.label).toBe('工资表计算');
      expect(failedRecord!.accountSet).toBe('幻辰财税');
      expect(failedRecord!.period).toBe('202609');
      expect(JSON.stringify(failedRecord!.workerMessages)).toContain(DELEGATE_ASK);
    } finally {
      audit.restore();
      await booted?.assembly.close();
    }
  });
});
