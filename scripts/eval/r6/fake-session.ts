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
import type { HarnessSession } from './harness';

export interface FakeTurnScript {
  readonly reply: string;
  readonly tasks: readonly TaskView[];
  readonly cancelCalled?: boolean;
  readonly modelCalls?: number;
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
  private readonly scenario: FakeScenario;

  constructor(scenario: FakeScenario) {
    this.scenario = scenario;
  }

  async send(_text: string): Promise<{ reply: string; taskIds: readonly string[] }> {
    const s = this.scenario.turns[this.index];
    if (s === undefined) throw new Error(`假会话脚本用尽：index=${this.index}`);
    this.index += 1;
    this.calls += s.modelCalls ?? 1;
    this.lastCancel = s.cancelCalled ?? false;
    if (s.newAttempts) this.attempts = [...this.attempts, ...s.newAttempts];
    return { reply: s.reply, taskIds: [] };
  }

  private last(): FakeTurnScript {
    return this.scenario.turns[Math.max(0, this.index - 1)]!;
  }

  tasks(): readonly TaskView[] { return this.last().tasks; }
  transcriptTokens(): number { return this.last().tokens; }
  transcriptMessages(): number { return this.last().messages; }
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
  cancelCalledLastTurn(): boolean { return this.lastCancel; }
}

/** 便捷构造：给一个空任务视图。 */
export function noTasks(): readonly TaskView[] { return []; }

/** 便捷：把 token 观测数组作为「新尝试」并入某轮（少量包装用）。 */
export function asAttempt(turn: number, kind: CompactionAttempt['kind'], before: number, after: number, summaryChunks?: number): CompactionAttempt {
  return summaryChunks === undefined ? { turn, kind, before, after } : { turn, kind, before, after, summaryChunks };
}

export type { TurnObservation, Track };
