import { describe, expect, it, vi } from 'vitest';
import type { TrustedContext } from '@fshine/contracts';
import { INVALID_DECLARATION_TOLERANCE, judgeDeclarationContract } from '../../scripts/eval/declaration-criteria';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from './src/context';
import { ToolUserError, type TurnDriver, type TurnDriverInput, type TurnDriverResult } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { NO_EXECUTION_CLARIFICATION } from './src/runtime-messages';
import { ROUTE_CURRENT_TURN_TOOL_NAME, reviewRouteDeclaration } from './src/turn-contract';
import { FakeSessionRepo } from './test-helpers';

/**
 * 轨道 C：⑦ 申报层止血（不删除，只给退回收口）。
 *
 * ── 为什么这条测试存在（审计里撞出来的）────────────────────────────────────────
 * 当前最大单一失败源。三处实测同一病根：模型提交 `{kind:'conversation', request:'…'}`
 * （多带一个字段就是另一份契约，`parseTurnDeclaration` 拒收），宿主回一句**零信息**的
 * 「申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。」——它没说
 * 多带的是哪个字段，模型只能照同一形状再交一次：
 *   · T9 r01：同一回合 33 次 `route_declaration_invalid` → 模型弃权；
 *   · arch-d C2：同一回合 226 次 → 300s 看门狗收掉（0 轮 0 调用）。
 * 集成分支上的 P1 实跑（out/eval-after-merge/probe.log）同形状：单回合 4 次被拒 +
 * 探针等待超时，判据红 `retry-unbounded`。
 *
 * ── 本文件钉住两条（对应裁定原文 ① ②）────────────────────────────────────────
 * ① 退回话术必须点出**哪个字段多带了**（turn-contract.ts 的零信息句由此消失）；
 * ② 同一回合的申报拒收**有界**，超界不再把模型留在重填循环里，而是走
 *    `route_declaration_missing` → NO_EXECUTION_CLARIFICATION（裁定认可的可行动话术），
 *    并且回合必须闭合（有 turn_span），不许挂死。
 *
 * 纪律：这里的模型替身只交**坏申报**（不含任何平台动作）——测试不起真实执行面，
 * 全部走内存替身（与 tests/e2e 的 mock 纪律一致）。
 */

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

/** 捕获宿主埋点（console.warn / console.info 的 JSON 行），按 event 名取原文。 */
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

/**
 * 按 `script` 逐次交申报、最后一次成功后给 `finalText` 的模型替身
 * （健康样例形状：同回合内被退回过、随后自纠成功）。
 */
function scriptedDeclarationDriver(script: Array<Record<string, unknown>>, finalText: string) {
  let attempts = 0;
  const driver: TurnDriver = {
    async run(input: TurnDriverInput): Promise<TurnDriverResult> {
      const messages = [...input.messages] as unknown[];
      for (let index = 0; index < 10; index += 1) {
        const args = script[Math.min(attempts, script.length - 1)]!;
        const isLast = attempts >= script.length - 1;
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
        if (isLast) return { text: finalText, messages: messages as never };
      }
      return { text: '替身：撞到保险丝仍未收敛', messages: messages as never };
    },
  };
  return { driver, attempts: () => attempts };
}

// ── ① 退回话术必须点出多带/写错的字段 ────────────────────────────────────────
describe('申报退回话术：点出多带的是哪个字段（①）', () => {
  it('T9 r01 / arch-d C2 的形状（conversation 多带 request）退回原文点名 request', () => {
    const reviewed = reviewRouteDeclaration({ kind: 'conversation', request: '查 alpha collection W1 的记录' });
    expect('error' in reviewed).toBe(true);
    const error = 'error' in reviewed ? reviewed.error : '';
    // 零信息句的判据：它说不出多带的是哪个字段，模型只能照原样重交
    expect(error).toContain('request');
    expect(error).not.toBe('申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。');
  });

  it('resend 多带字段同样点名（多一个字段就是另一份契约）', () => {
    const reviewed = reviewRouteDeclaration({ kind: 'resend', artifactRef: '3', request: '顺带' });
    expect('error' in reviewed).toBe(true);
    const error = 'error' in reviewed ? reviewed.error : '';
    expect(error).toContain('request');
    expect(error).toContain('artifactRef');
  });

  it('kind 缺失或不在枚举内时退回原文说清实际收到什么', () => {
    const unknown = reviewRouteDeclaration({ kind: 'typo', request: '查询' });
    expect('error' in unknown).toBe(true);
    const unknownError = 'error' in unknown ? unknown.error : '';
    expect(unknownError).toContain('kind');
    expect(unknownError).toContain('typo');
    expect(unknownError).toContain('conversation');

    const missing = reviewRouteDeclaration({});
    expect('error' in missing).toBe(true);
    expect('error' in missing ? missing.error : '').toContain('kind');
  });

  it('delegate 缺 request 时退回原文说清缺的是 request', () => {
    const reviewed = reviewRouteDeclaration({ kind: 'delegate' });
    expect('error' in reviewed).toBe(true);
    expect('error' in reviewed ? reviewed.error : '').toContain('request');
  });

  it('kind 是非字符串（模型交了别的形状）时也说清实际收到什么', () => {
    const reviewed = reviewRouteDeclaration({ kind: 42, request: '查询' });
    expect('error' in reviewed).toBe(true);
    const error = 'error' in reviewed ? reviewed.error : '';
    expect(error).toContain('kind');
    expect(error).toContain('42');
  });
});

// ── ② 同一回合的申报拒收有界，超界走确定性收尾 ──────────────────────────────
describe('申报拒收有界：超界收敛到 route_declaration_missing（②）', () => {
  it('同一形状连续被拒三次：第 3 次不再退回模型，回合以 NO_EXECUTION_CLARIFICATION 闭合', async () => {
    const events = captureHostEvents();
    const { driver, attempts } = stubbornInvalidDriver({ kind: 'conversation', request: '查 alpha collection W1 的记录' });
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: unusedSubagent() });
    try {
      const reply = await runtime.handleTurn(makeCtx(), '刚才查的是哪个？');

      // 界：同一回合内退回过上限次就停（容差 = 2，见声明处的取值依据）
      const invalid = events.of('route_declaration_invalid');
      expect(invalid).toHaveLength(2);
      // 模型没有被留在重填循环里：它一共只被叫了 3 次（2 次退回 + 1 次判超界）
      expect(attempts()).toBe(3);
      // 超界走 route_declaration_missing → 裁定认可的可行动话术
      const missing = events.of('route_declaration_missing');
      expect(missing).toHaveLength(1);
      expect(reply.text).toBe(NO_EXECUTION_CLARIFICATION);
      // 回合必须闭合（不许挂死、不许零信息兜底）
      const spans = events.of('turn_span');
      expect(spans.at(-1)?.['outcome']).toBe('route_declaration_missing');
    } finally {
      events.restore();
    }
  });

  it('换着形状交也不行：整例的退回次数同样有界（界在回合总次数上，不是只看单形状）', async () => {
    const events = captureHostEvents();
    // 每回合换一个形状：keys 各不相同，但都是被拒的申报
    const shapes = [
      { kind: 'conversation', request: '查 alpha collection W1 的记录' },
      { kind: 'resend', artifactRef: '3', request: '顺带' },
      { kind: 'typo', request: '查询' },
      { kind: 'delegate' },
    ];
    let attempts = 0;
    const driver: TurnDriver = {
      async run(input: TurnDriverInput): Promise<TurnDriverResult> {
        const messages = [...input.messages] as unknown[];
        for (let index = 0; index < 25; index += 1) {
          const args = shapes[Math.min(attempts, shapes.length - 1)]!;
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
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: unusedSubagent() });
    try {
      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_declaration_shapes' }), '先别查了，你先把打算说一下。');

      expect(events.of('route_declaration_invalid')).toHaveLength(2);
      expect(attempts).toBe(3);
      expect(reply.text).toBe(NO_EXECUTION_CLARIFICATION);
      expect(events.of('turn_span').at(-1)?.['outcome']).toBe('route_declaration_missing');
    } finally {
      events.restore();
    }
  });

  it('界不误伤自纠：退回到上限（2 次）后交出合法申报的回合照常正常收尾', async () => {
    const events = captureHostEvents();
    // 实测健康样例的边界形状：同回合内被退回 2 次（判据容差正是 2），第 3 次自纠成功
    const { driver, attempts } = scriptedDeclarationDriver(
      [
        { kind: 'conversation', request: '查 alpha collection W1 的记录' },
        { kind: 'conversation', request: '查 alpha collection W1 的记录' },
        { kind: 'conversation' },
      ],
      '你好，我可以帮你核对平台上的数据。',
    );
    const runtime = createTaxAgentRuntime({ driver, sessions: new FakeSessionRepo(), platformTask: unusedSubagent() });
    try {
      const reply = await runtime.handleTurn(makeCtx({ requestId: 'req_declaration_selfcorrect' }), '你好，你能做什么？');

      expect(events.of('route_declaration_invalid')).toHaveLength(2);
      expect(attempts()).toBe(3);
      expect(reply.text).toBe('你好，我可以帮你核对平台上的数据。');
      expect(events.of('turn_span').at(-1)?.['outcome']).toBe('ok');
      // 被退回过，但退回原文点名了多带的字段（①的运行时面）
      expect(String(events.of('route_declaration_invalid')[0]?.['reason'])).toContain('request');
      expect(String(events.of('route_declaration_invalid')[1]?.['reason'])).toContain('request');
    } finally {
      events.restore();
    }
  });

  it('判据侧同锁：把风暴形状的埋点喂进**未改动**的申报判据，verdict 必须是绿', async () => {
    // 探针侧的红判据（scripts/eval/declaration-criteria.ts，本文件不复制它）吃的是宿主埋点
    // 原文。这条用例把"连续交同一份坏申报"的回合埋点原样喂给它——判据认的证据与探针日志
    // 一致，"界生效"因此不只活在本文件的断言里：抽掉界，宿主会退回 8+ 次，判据当场红。
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
