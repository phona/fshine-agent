/**
 * R6 测试基建 · 假会话（确定性，零模型）——仅供确定性测试使用。
 *
 * 提供一个实现 `HarnessSession` 的**脚本化假会话**：逐轮返回预置回复、任务快照、
 * 转录体量与压缩尝试，**不调用任何模型**。这样 R6 管线与 Oracle 可在无网、无 key、
 * 无真实窗口的情况下被端到端确定性验证。
 *
 * 纪律：假会话只用于**测试基建自证**（Oracle/证据/三态/生命周期判据跑得通且判得对），
 * **不得**用于任何质量/稳定结论（对齐预注册 §〇.1：质量结论只由真实模型产生）。
 */
import type { BudgetUsage, Track } from './evidence';
import type { CompactionAttempt, TurnObservation } from './compaction';
import type { TaskView } from './oracle';
import type { CancelFact, ExecutionFact, HarnessSession } from './harness';
import type { CallKind, ModelCallRecord } from './accounting';

/** 假会话单次调用脚本项（逐次调用账本用；缺省由 modelCalls 合成「主模型」记录）。 */
export interface FakeCallSpec {
  readonly kind: CallKind;
  readonly input?: number;
  readonly output?: number;
  readonly total?: number;
  readonly durationMs?: number;
  readonly observed?: boolean;
}

export interface FakeTurnScript {
  readonly reply: string;
  readonly tasks: readonly TaskView[];
  readonly cancelCalled?: boolean;
  readonly modelCalls?: number;
  /** 该轮实际发起的逐次调用（主/摘要/重试/溢出恢复）。给出则以此为准，否则按 modelCalls 合成主模型记录。 */
  readonly calls?: readonly FakeCallSpec[];
  /** 该轮机械上发起的执行调用（execute_operation 审计行；缺省 = 本轮零执行）。 */
  readonly executions?: readonly ExecutionFact[];
  /** 该轮 task_cancel 回执（目标任务/outcome；缺省 = 本轮无取消调用）。 */
  readonly cancelFacts?: readonly CancelFact[];
  readonly tokens: number;
  readonly messages: number;
  /** 该轮结束时把新出现的压缩尝试并入会话面（顺序追加）。 */
  readonly newAttempts?: readonly CompactionAttempt[];
}

export interface FakeScenario {
  readonly turns: readonly FakeTurnScript[];
  readonly tokensObserved?: boolean;
  readonly summaryCalls?: number | null;
}

/** 脚本化假会话：索引随 send 前进；只读事实面。 */
export class FakeHarnessSession implements HarnessSession {
  private index = 0;
  private calls = 0;
  private attempts: CompactionAttempt[] = [];
  private lastCancel = false;
  /** 当前任务账本（send 后更新；首轮之前为空 —— 与真实 registry 一致）。 */
  private currentTasks: readonly TaskView[] = [];
  private lastExecutions: readonly ExecutionFact[] = [];
  private lastCancelFacts: readonly CancelFact[] = [];
  private readonly ledger: ModelCallRecord[] = [];
  private readonly scenario: FakeScenario;
  /** `waitIdle` 实际被调用的次数与「当时会话面未收尾」的观测（确定性自证缝）。 */
  private waitIdleCalls = 0;
  private awaitingIdle = false;

  constructor(scenario: FakeScenario) {
    this.scenario = scenario;
  }

  async send(_text: string): Promise<{ reply: string; taskIds: readonly string[] }> {
    const result = await this.dispatchScript();
    this.awaitingIdle = false;
    return result;
  }

  /**
   * 只交办：脚本推进一轮但**不**标记收尾（`awaitingIdle=true`），供 harness 的
   * `deferIdle` 轮模拟 background 受理即返回；下一阻塞轮前 `waitIdle` 清标记。
   */
  async sendNoWait(_text: string): Promise<{ reply: string; taskIds: readonly string[] }> {
    const result = await this.dispatchScript();
    this.awaitingIdle = true;
    return result;
  }

  async waitIdle(): Promise<void> {
    this.waitIdleCalls += 1;
    this.awaitingIdle = false;
  }

  /** 观测：`waitIdle` 次数（测试断言真交错轮确实等过）。 */
  waitIdleCount(): number { return this.waitIdleCalls; }
  /** 观测：会话面当前是否有未收尾的后台交办。 */
  hasPendingBackground(): boolean { return this.awaitingIdle; }

  private async dispatchScript(): Promise<{ reply: string; taskIds: readonly string[] }> {
    const s = this.scenario.turns[this.index];
    if (s === undefined) throw new Error(`假会话脚本用尽：index=${this.index}`);
    this.index += 1;
    // 逐次调用账本：给出 calls 则以之为准，否则按 modelCalls 合成「主模型」记录（默认 1）。
    const specs: readonly FakeCallSpec[] = s.calls
      ?? Array.from({ length: s.modelCalls ?? 1 }, () => ({ kind: 'main' as const }));
    for (const spec of specs) {
      const input = spec.input ?? 0;
      const output = spec.output ?? 0;
      const total = spec.total ?? input + output;
      this.ledger.push({
        seq: this.ledger.length + 1, kind: spec.kind, sessionId: 'fake-session', turn: this.index,
        tokens: { input, output, total },
        tokensObserved: spec.observed ?? (input + output > 0),
        durationMs: spec.durationMs ?? 0,
      });
    }
    this.calls += specs.length;
    this.lastCancel = s.cancelCalled ?? false;
    this.currentTasks = s.tasks;
    this.lastExecutions = s.executions ?? [];
    this.lastCancelFacts = s.cancelFacts ?? [];
    if (s.newAttempts) this.attempts = [...this.attempts, ...s.newAttempts];
    return { reply: s.reply, taskIds: [] };
  }

  private last(): FakeTurnScript {
    return this.scenario.turns[Math.max(0, this.index - 1)]!;
  }

  tasks(): readonly TaskView[] { return this.currentTasks; }
  transcriptTokens(): number { return this.index === 0 ? 0 : this.last().tokens; }
  transcriptMessages(): number { return this.index === 0 ? 0 : this.last().messages; }
  budget(): BudgetUsage {
    return {
      calls: this.calls,
      tokens: this.scenario.turns.reduce((s, t) => s + t.tokens, 0),
      tokensObserved: this.scenario.tokensObserved ?? true,
      ms: 0,
      summaryCalls: this.scenario.summaryCalls ?? null,
    };
  }
  compactionAttempts(): readonly CompactionAttempt[] { return this.attempts; }
  /** 逐次真实模型调用账本（主 / Pi 摘要 / 重试 / 溢出恢复）。 */
  modelCallLedger(): readonly ModelCallRecord[] { return this.ledger; }
  cancelCalledLastTurn(): boolean { return this.lastCancel; }
  /** 本回合 execute_operation 审计行（脚本 `executions`；缺省空 = 零执行）。 */
  executionsLastTurn(): readonly ExecutionFact[] { return this.lastExecutions; }
  /** 本回合 task_cancel 回执（脚本 `cancelFacts`；缺省空 = 本轮无取消调用）。 */
  cancelFactsLastTurn(): readonly CancelFact[] { return this.lastCancelFacts; }
}

/** 便捷构造：给一个空任务视图。 */
export function noTasks(): readonly TaskView[] { return []; }

/** 便捷：把 token 观测数组作为「新尝试」并入某轮（少量包装用）。 */
export function asAttempt(turn: number, kind: CompactionAttempt['kind'], before: number, after: number, summaryChunks?: number): CompactionAttempt {
  return summaryChunks === undefined ? { turn, kind, before, after } : { turn, kind, before, after, summaryChunks };
}

export type { TurnObservation, Track };
