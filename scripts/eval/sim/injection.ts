/**
 * SimCase 薄机制 · 故障注入锚点（确定性位置，不挂墙钟）。
 *
 * 注入只绑**计数位置**：第 `at` 个系统回合之前 / 第 `at` 个执行调用 / 第 `at` 个事件。
 * Harness 在每个系统回合开始前用当前计数决定「本回合是否把注入指令交给系统面」，回合结束后
 * 由适配器报告是否真的应用；证据里同时记 planned 与 applied——适配器不实现某锚点时必须如实
 * 报告未应用，**不得伪造命中**。
 */

export interface SystemCounts {
  /** 已完成的系统回合数。 */
  readonly systemTurn: number;
  /** 累计执行调用数。 */
  readonly toolCall: number;
  /** 累计事件数。 */
  readonly event: number;
}

/** 交给系统适配器的注入指令（`at` 为**全局**序号，适配器按自己的计数器在 at 处触发）。 */
export interface InjectionDirective {
  readonly anchor: 'systemTurn' | 'toolCall' | 'event';
  readonly at: number;
  readonly kind: string;
}

export interface InjectionReport extends InjectionDirective {
  /** 是否已把指令交给某个系统回合。 */
  readonly planned: boolean;
  /** 适配器是否确认故障已实际注入。 */
  readonly applied: boolean;
  /** 实际注入发生在第几个系统回合（1 起）。 */
  readonly appliedTurn: number | null;
  /** `applied` / `adapter_did_not_apply` / `anchor_not_reached` / `no_injection`。 */
  readonly reason: string;
}

export interface InjectionSpec {
  readonly anchor: 'systemTurn' | 'toolCall' | 'event';
  readonly at: number;
  readonly kind: string;
}

/**
 * 注入锚点跟踪器（每 trial 一个实例）。
 * 用法：`beforeTurn(counts)` → 交给 `system.send`；`settle({turn, counts, applied, reason})` 回填结果；
 * 结束时 `report()` 落证据。
 */
export class InjectionTracker {
  private readonly spec: InjectionSpec | undefined;
  private plannedTurn: number | null = null;
  private applied = false;
  private appliedTurn: number | null = null;
  private reason: string;

  constructor(spec?: InjectionSpec) {
    this.spec = spec;
    this.reason = spec === undefined ? 'no_injection' : 'anchor_not_reached';
  }

  /**
   * 在本回合（第 `counts.systemTurn + 1` 个系统回合）发送前调用。
   *   · systemTurn 锚点：恰好是第 `at` 个回合时交付（「第 at 个系统回合之前」）。
   *   · toolCall/event 锚点：只要全局计数还没到 `at`，就把指令交给本回合（适配器在 at 处触发）。
   */
  beforeTurn(counts: SystemCounts): InjectionDirective | null {
    const spec = this.spec;
    if (spec === undefined || this.applied || this.plannedTurn !== null) return null;
    if (spec.anchor === 'systemTurn') {
      if (counts.systemTurn + 1 !== spec.at) return null;
      this.plannedTurn = counts.systemTurn + 1;
      return { anchor: spec.anchor, at: spec.at, kind: spec.kind };
    }
    const current = spec.anchor === 'toolCall' ? counts.toolCall : counts.event;
    if (current >= spec.at) return null;
    this.plannedTurn = counts.systemTurn + 1;
    return { anchor: spec.anchor, at: spec.at, kind: spec.kind };
  }

  /** 回合结束后回填：适配器是否应用了注入。未应用且锚点尚未到达时，下回合继续交接。 */
  settle(input: { turn: number; counts: SystemCounts; applied: boolean; reason?: string }): void {
    if (this.plannedTurn === null || this.plannedTurn !== input.turn || this.applied) return;
    if (input.applied) {
      this.applied = true;
      this.appliedTurn = input.turn;
      this.reason = 'applied';
      return;
    }
    this.reason = input.reason ?? 'adapter_did_not_apply';
    const spec = this.spec;
    if (spec === undefined) return;
    const current = spec.anchor === 'systemTurn'
      ? input.counts.systemTurn
      : spec.anchor === 'toolCall' ? input.counts.toolCall : input.counts.event;
    if (spec.anchor !== 'systemTurn' && current < spec.at) this.plannedTurn = null;
  }

  report(): InjectionReport | null {
    const spec = this.spec;
    if (spec === undefined) return null;
    return {
      anchor: spec.anchor,
      at: spec.at,
      kind: spec.kind,
      planned: this.plannedTurn !== null,
      applied: this.applied,
      appliedTurn: this.appliedTurn,
      reason: this.reason,
    };
  }
}
