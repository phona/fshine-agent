/**
 * 离线全链 e2e：平台健康信号（Lane 2「治标补法」）——连续 AUTH 类平台失败的冷却。
 *
 * 背景（2026-09-29 真实模式实测，平台登录失效）：agent 行为已有边界——一次调用失败 +
 * 平台自动重登录一次 + 停止，回复诚实。缺口：用户连发多轮时会**轮轮重试**（每轮都真调
 * 一次平台：一次浏览器自动化 + 一个限流 token + 用户 10-60s 等待，结论早就确定），且
 * 归因靠平台登录层转述。本用例钉宿主侧补法：
 *   ① 前两回合平台（mock）返回登录/凭据类失败信封，回合照常结束、回复诚实；
 *   ② 第三回合宿主**前置拦截**：零平台委派（调用计数断言），终稿是宿主合成的
 *      PLATFORM_UNAVAILABLE（error-codes.ts 唯一措辞来源，一字不差）；
 *   ③ 合成消息不带内部控制词/错误码/协议形状（生产指纹尺），也不转述平台归因。
 *
 * 保真度：失败判据走**生产函数** platformAuthFailureFromResponses（与真实驱动同一条
 * 派生逻辑），只有平台 stdout 字节是 mock 的（与 harness 的 gatedWorker 同哲学——mock
 * 的是平台应答，不是宿主逻辑）。审计面：宿主日志事件 platform_auth_failure /
 * platform_cooldown_blocked 逐回合落痕。
 */
import { describe, expect, it } from 'vitest';
import { platformAuthFailureFromResponses } from '../../packages/agent/src/platform-contract';
import { platformUnavailableTextFor } from '../../packages/agent/src/error-codes';
import { executionLanguageFingerprints } from '../../packages/agent/src/runtime';
import { boot, mainDriver, type Boot } from './harness';

const REQUEST = '查询幻辰财税账套的应收账款余额';

/** 平台登录/凭据类失败信封：与真实网关 stdout 末行同形（status failed + 登录族错误码 → exit 1）。 */
function authEnvelope(code: string): string {
  return `RESULT ${JSON.stringify({
    v: 1, op: 'finance.query-receivables', status: 'failed', data: null,
    error: { code, message: `${code}: 平台登录态校验未通过` },
  })}`;
}

/**
 * 平台登录失效时的 worker 替身：每次委派都"调一次平台并拿到登录族失败信封"。
 *
 * 与真实驱动的同构点：失败的那次网关调用真发生过（execution.calls=1），worker 的诚实
 * 说明成为回合文本；authFailure 由**生产函数**从平台应答信封派生（判据只有一份）。
 * 文本刻意干净（无错误码/协议字段）——真实 worker 的诚实报告也不该带执行语言。
 */
function authFailingWorker(codes: readonly string[]) {
  let index = 0;
  const invocations = { count: 0 };
  return {
    invocations,
    run: async (input: { messages: unknown[] }) => {
      invocations.count += 1;
      const code = codes[Math.min(index, codes.length - 1)] ?? 'NEEDS_LOGIN';
      index += 1;
      const envelope = authEnvelope(code);
      // 生产派生：信封 → 登录/凭据类失败事实（与 pi-coding-driver 同一函数、同一边界）
      const authFailure = platformAuthFailureFromResponses([
        { role: 'toolResult', content: [{ type: 'text', text: envelope }] },
      ]);
      const text = '平台登录态校验未通过，本轮没有取到任何数据，也不会给出任何估算。';
      return {
        text,
        messages: [
          ...input.messages,
          { role: 'toolResult', toolCallId: 'call_platform', toolName: 'bash', content: [{ type: 'text', text: envelope }], timestamp: Date.now() },
          { role: 'assistant', content: text, timestamp: Date.now() },
        ],
        footprint: '1 次 bin/17dz 调用',
        execution: { planId: 'plan_auth_failure', version: 1, calls: 1 },
        ...(authFailure ? { authFailure } : {}),
      };
    },
  };
}

/** 捕获宿主审计事件（JSON 行的 event 字段），与 runtime.test.ts 同手法。 */
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

describe('离线全链 e2e：平台健康信号（Lane 2 冷却）', () => {
  it('连续两回合 AUTH 失败信封 → 第三回合终稿是宿主合成消息且零平台调用', async () => {
    const worker = authFailingWorker(['NEEDS_LOGIN', 'AUTH_EXPIRED']);
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({
        // 三个回合用户都重发查询（逐轮重试式重查的复现）；第三回合的申报根本到不了平台
        main: mainDriver([
          { kind: 'delegate', request: REQUEST },
          { kind: 'delegate', request: REQUEST },
          { kind: 'delegate', request: REQUEST },
        ]),
        worker: worker as never,
      });

      const first = await booted.send('查一下幻辰财税的应收账款');
      const second = await booted.send('再查一次');
      const third = await booted.send('还是查一下');

      // ① 前两回合：平台真被调用（各一次失败调用），回复是 worker 的诚实说明
      expect(worker.invocations.count).toBe(2);
      expect(first).toBe('平台登录态校验未通过，本轮没有取到任何数据，也不会给出任何估算。');
      expect(second).toBe(first);

      // ② 第三回合：宿主前置拦截——零平台调用（调用计数断言），终稿是宿主合成消息
      expect(worker.invocations.count).toBe(2);
      expect(third).toBe(platformUnavailableTextFor(10));

      // ③ 合成消息的措辞纪律：内部控制词/错误码/协议形状一个都不带，也不转述平台归因
      expect(executionLanguageFingerprints(third)).toEqual([]);
      expect(third).not.toContain('NEEDS_LOGIN');
      expect(third).not.toContain('AUTH_EXPIRED');
      expect(third).not.toContain('稍后');

      // 审计面：前两回合记 platform_auth_failure（第二次即进冷却），第三回合记拦截
      const authFailures = audit.events.filter((event) => event['event'] === 'platform_auth_failure');
      expect(authFailures.map((event) => event['consecutiveAuthFailures'])).toEqual([1, 2]);
      expect(authFailures[1]?.['cooldownEntered']).toBe(true);
      const blocked = audit.events.filter((event) => event['event'] === 'platform_cooldown_blocked');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.['sessionId']).toContain('e2e_user');
    } finally {
      audit.restore();
      await booted?.assembly.close();
    }
  });
});
