/**
 * 判据侧同锁：把宿主真实埋点喂进申报契约判据，证明"界生效"不只活在生产单测的断言里。
 *
 * 为什么在 eval 侧（2026-11-12 分层调整）：本条原先在
 * packages/agent/declaration-retry-bound.test.ts 里，import 了 ./declaration-criteria——
 * 那是"生产测试 → eval 脚本"的反向依赖。判据与用例归属都在这一层，搬过来后依赖方向
 * 只剩 eval → 生产（本文件 import 生产 runtime），方向不反。
 *
 * 抽掉生产侧的收敛界（turn-state.ts 的 MAX_DECLARATION_REJECTIONS），宿主会退回 8+ 次，
 * 本用例的 verdict 当场红——这是它与生产单测互补的那一半：生产单测断言"界在"，
 * 这里断言"判据认的证据与探针日志一致"。
 *
 * 纪律：模型替身只交坏申报、不起执行面、不碰真实平台（全程内存替身）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TrustedContext } from '@fshine/contracts';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from '../../packages/agent/src/context';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from '../../packages/agent/src/driver';
import { createTaxAgentRuntime } from '../../packages/agent/src/runtime';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from '../../packages/agent/src/turn-contract';
import { FakeSessionRepo } from '../../packages/agent/test-helpers';
import { INVALID_DECLARATION_TOLERANCE, judgeDeclarationContract } from './declaration-criteria';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return {
    requestId: 'req_declaration',
    principalId: 'wecom:user_a',
    sessionId: 'sess_declaration',
    ...overrides,
  };
}

/** 不会被本文件任何用例碰到的委派替身：被调用即说明路由判错了。 */
function unusedSubagent(): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: async (): Promise<SubagentTaskResult> => {
      throw new Error('本用例不该发生委派。');
    },
  };
}

/** 捕获宿主埋点（console.warn / console.info 的 JSON 行），并按原始行保序留存。 */
function captureHostEvents() {
  const warn: Array<Record<string, unknown>> = [];
  const info: Array<Record<string, unknown>> = [];
  /** 原始 JSON 行（保序）：判据侧的输入就是这些行，不经过任何加工。 */
  const lines: string[] = [];
  const collect = (sink: Array<Record<string, unknown>>) => (line: unknown): void => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      sink.push(parsed);
      lines.push(line);
    } catch { /* 非 JSON 行忽略 */ }
  };
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(collect(warn));
  const infoSpy = vi.spyOn(console, 'info').mockImplementation(collect(info));
  return {
    warn,
    info,
    lines,
    of: (event: string): Array<Record<string, unknown>> => [...warn, ...info].filter((entry) => entry['event'] === event),
    restore: () => { warnSpy.mockRestore(); infoSpy.mockRestore(); },
  };
}

/**
 * 只会反复交同一份坏申报的模型替身（T9 r01 的形状）：宿主退回一次，它照原样再交一次。
 *
 * `cap` 是替身自己的保险丝——**不是**被测的界。宿主若没有收敛，替身撞到保险丝后
 * 交出一句可辨认的文本（而不是让测试挂死），断言因此看得到"界没生效"这个事实。
 */
function stubbornInvalidDriver(args: Record<string, unknown>, cap = 25) {
  let attempts = 0;
  const driver: TurnDriver = {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const messages = [...input.messages] as unknown[];
      for (let index = 0; index < cap; index += 1) {
        attempts += 1;
        const callId = `call_${attempts}`;
        messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: ROUTE_CURRENT_TURN_TOOL_NAME, arguments: args }], timestamp: index } as never);
        try {
          const outcome = await input.exec(ROUTE_CURRENT_TURN_TOOL_NAME, args);
          messages.push({ role: 'toolResult', toolName: ROUTE_CURRENT_TURN_TOOL_NAME, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(outcome) }], timestamp: index } as never);
        } catch (error) {
          if (!(error instanceof ToolUserError)) throw error;
          return { text: error.message, messages: messages as never };
        }
      }
      return { text: '替身：撞到保险丝仍未收敛', messages: messages as never };
    },
  };
  return { driver, attempts: () => attempts };
}

describe('申报判据 ↔ 宿主埋点：判据侧同锁（P1）', () => {
  it('把风暴形状的埋点喂进**未改动**的申报判据，verdict 必须是绿', async () => {
    // 探针侧的红判据（./declaration-criteria.ts）吃的是宿主埋点原文。这条用例把
    // "连续交同一份坏申报"的回合埋点原样喂给它——判据认的证据与探针日志一致，
    // "界生效"因此不只活在生产单测的断言里：抽掉界，宿主会退回 8+ 次，判据当场红。
    const events = captureHostEvents();
    const { driver } = stubbornInvalidDriver({ kind: 'conversation', request: '查 alpha collection W1 的记录' }, 8);
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: unusedSubagent() });
    try {
      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_declaration_judge' }), '刚才查的是哪个？');
      const verdict = judgeDeclarationContract({
        logText: ['=== P1 申报契约：拒收必须收敛 ===', ...events.lines].join('\n'),
        turns: [{ reply: reply.text, requestId: 'req_declaration_judge' }],
        expectedTurns: 1,
        caseId: 'P1',
      });
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.evidence.maxInvalidPerTurn).toBeLessThanOrEqual(INVALID_DECLARATION_TOLERANCE);
    } finally {
      events.restore();
    }
  });
});
