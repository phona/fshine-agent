/**
 * R6 测试基建 · 真实模型调用全量记账 + 单实验硬停（先验拒绝）。
 *
 * 定位（owner ③ 目标）：把一次会话里**全部实际发起的模型调用**逐次记账，并据此实施**先验硬停**
 * （达上限即拒绝发起下一请求、有界失败，不靠模型自觉）。记账面覆盖四类，缺一不可：
 *   · `main`              —— 主模型调用（streamSimple / lane，含最终回复请求）；
 *   · `summary`           —— Pi 原生压缩摘要调用（**独立按实际发起计数，不依赖 budget hook**
 *                             —— 旧路径摘要绕过 TaskBudget，故必须由会话面单独暴露逐次记录）；
 *   · `retry`             —— 主模型瞬时失败重试 / provider 重试的每一次实际请求；
 *   · `overflow_recovery` —— 溢出恢复 / 压缩触发的附带模型调用（如 overflow 后重发、摘要分片）。
 *
 * 硬停口径（**取自 R6 预注册 §十三.D 冻结值，不得修改**）：
 *   `maxModelCalls=150` / `maxTokens=3,000,000` / `wallMs=2h`（长稳轨按设计时长）。
 *   判定顺序固定 `ms → calls → tokens`（与既有 `TaskBudget.exhausted` / p3 `enforce.ts` 同序）。
 *   **先验** = 在发起下一请求**之前**检查：已耗用 `>=` 上限即抛 `R6HardStopError`，不发起该请求。
 *
 * 纪律：
 *   · 本模块是**纯函数 + 有状态累加器**，不 import 产品运行时、不改产品 `TaskBudget`/`resource-policy`
 *     语义（B3 明确不解耦生产语义，只增强评测侧计量）；
 *   · token 只按**观测到的 usage** 计（`tokensObserved`）；未观测到不虚增、不伪造（同 p3 纪律）；
 *   · 硬停 ≠ 全局额度闸（预注册 §〇.6）：本模块只做单会话/单实验硬停。
 */

/** 一次实际发起的模型调用类别（记账面四类）。 */
export type CallKind = 'main' | 'summary' | 'retry' | 'overflow_recovery';

/** 全部记账类别（顺序稳定，供遍历/校验）。 */
export const CALL_KINDS: readonly CallKind[] = ['main', 'summary', 'retry', 'overflow_recovery'];

/** 「完整覆盖」的必需类别：主模型 / 摘要 / 重试（§十三.D 点名三类；溢出恢复为附加面）。 */
export const REQUIRED_CALL_KINDS: readonly CallKind[] = ['main', 'summary', 'retry'];

export interface CallTokens {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

/** 逐次模型调用记录（会话面提供；缺任一类即记账不完整，须由测试绊线拦截）。 */
export interface ModelCallRecord {
  /** 会话内单调递增序号（1 起）。 */
  readonly seq: number;
  readonly kind: CallKind;
  /** 关联会话（会话面缺省留空，由 harness 统一回填）。 */
  readonly sessionId: string;
  /** 关联回合号。 */
  readonly turn: number;
  readonly tokens: CallTokens;
  /** 是否观测到真实 usage（false = 该次用量未知，token 硬停不计入）。 */
  readonly tokensObserved: boolean;
  /** 本次调用耗时（ms）。 */
  readonly durationMs: number;
}

/** 单实验硬停上限（pre-reg §十三.D 冻结值）。 */
export interface AccountingLimits {
  readonly maxModelCalls: number;
  readonly maxTokens: number;
  readonly wallMs: number;
}

/**
 * 预注册 §十三.D 冻结值：150 calls / 3,000,000 tokens / 2h。
 * **改此块 = 改已冻结口径，禁止**（只允许在测试中经 `resolveLimits` 传更小上限做确定性验证）。
 */
export const R6_HARD_LIMITS: AccountingLimits = Object.freeze({
  maxModelCalls: 150,
  maxTokens: 3_000_000,
  wallMs: 2 * 60 * 60 * 1000,
});

/** 把会话传入的 limits（可能只写部分键）补全为完整上限；缺省取 R6_HARD_LIMITS 冻结值。 */
export function resolveLimits(overrides: Readonly<Record<string, number>> = {}): AccountingLimits {
  return {
    maxModelCalls: overrides['maxModelCalls'] ?? R6_HARD_LIMITS.maxModelCalls,
    maxTokens: overrides['maxTokens'] ?? R6_HARD_LIMITS.maxTokens,
    wallMs: overrides['wallMs'] ?? R6_HARD_LIMITS.wallMs,
  };
}

export interface KindAccounting {
  readonly calls: number;
  readonly tokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
}

/** 全量记账读数（总计 + 分类别）。 */
export interface AccountedUsage {
  readonly calls: number;
  readonly tokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  /** 仅当**全部**记录的 usage 均被观测到才为 true（token 硬停的前提）。 */
  readonly tokensObserved: boolean;
  readonly byKind: Readonly<Record<CallKind, KindAccounting>>;
}

function emptyKind(): KindAccounting {
  return { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
}

/** 对逐次调用记录做全量记账（主/摘要/重试/溢出恢复分类别求和）。 */
export function accountCalls(records: readonly ModelCallRecord[]): AccountedUsage {
  const byKind: Record<CallKind, KindAccounting> = {
    main: emptyKind(), summary: emptyKind(), retry: emptyKind(), overflow_recovery: emptyKind(),
  };
  let calls = 0;
  let tokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let durationMs = 0;
  let tokensObserved = records.length > 0;
  for (const r of records) {
    const k = byKind[r.kind];
    byKind[r.kind] = {
      calls: k.calls + 1,
      tokens: k.tokens + r.tokens.total,
      inputTokens: k.inputTokens + r.tokens.input,
      outputTokens: k.outputTokens + r.tokens.output,
      durationMs: k.durationMs + r.durationMs,
    };
    calls += 1;
    tokens += r.tokens.total;
    inputTokens += r.tokens.input;
    outputTokens += r.tokens.output;
    durationMs += r.durationMs;
    if (!r.tokensObserved) tokensObserved = false;
  }
  return { calls, tokens, inputTokens, outputTokens, durationMs, tokensObserved, byKind };
}

/**
 * 反向绊线：返回 `required` 中**一条记录都没有**的类别（空数组 = 记账覆盖完整）。
 * 任一必需类别（主/摘要/重试）缺失即返回其名 —— 供测试把「漏记任一类」判红。
 */
export function missingCallKinds(
  usage: AccountedUsage,
  required: readonly CallKind[] = REQUIRED_CALL_KINDS,
): readonly CallKind[] {
  return required.filter((k) => usage.byKind[k].calls === 0);
}

export type HardStopReason = 'ms' | 'calls' | 'tokens';

export interface HardStopFact {
  readonly reason: HardStopReason;
  readonly limit: number;
  readonly used: number;
  readonly at: number;
}

export class R6HardStopError extends Error {
  readonly stop: HardStopFact;

  constructor(stop: HardStopFact) {
    super(`R6 单实验硬停（${stop.reason}: ${stop.used}/${stop.limit}），已拒绝发起下一请求`);
    this.name = 'R6HardStopError';
    this.stop = stop;
  }
}

/**
 * 耗尽判定（先验；判定顺序固定 ms → calls → tokens，与 p3 `enforce.ts` 同序）：
 *   · 墙钟已耗 `>= wallMs` → 'ms'；
 *   · 累计调用 `>= maxModelCalls` → 'calls'；
 *   · （且 token 已观测）累计 token `>= maxTokens` → 'tokens'；
 *   · 否则 null（未耗尽）。
 * **注意 `>=`**：达上限即视为耗尽，下一请求不发起。
 */
export function exhaustionOf(
  usage: AccountedUsage,
  limits: AccountingLimits,
  elapsedMs: number,
): HardStopReason | null {
  if (elapsedMs >= limits.wallMs) return 'ms';
  if (usage.calls >= limits.maxModelCalls) return 'calls';
  if (usage.tokensObserved && usage.tokens >= limits.maxTokens) return 'tokens';
  return null;
}

export interface AccountingGuardOptions {
  /** 注入墙钟（测试确定性）；缺省 `Date.now`。 */
  readonly now?: () => number;
}

/**
 * 有状态记账器 + 硬停守卫。
 * 用法：每回合**发请求前** `precheck()`（耗尽即抛，拒绝发起）；回合结束后 `replace(ledger)` 回填
 * 会话面暴露的**累计**逐次调用记录。多回合共享同一 guard = 同一会话级硬停口径。
 */
export class CallAccountingGuard {
  private records: ModelCallRecord[] = [];
  private stopFact: HardStopFact | null = null;
  private readonly limits: AccountingLimits;
  private readonly now: () => number;
  private readonly startMs: number;

  constructor(limits: AccountingLimits = R6_HARD_LIMITS, options: AccountingGuardOptions = {}) {
    this.limits = limits;
    this.now = options.now ?? Date.now;
    this.startMs = this.now();
  }

  /** 会话墙钟起点（ms）。 */
  startedAtMs(): number {
    return this.startMs;
  }

  /** 用会话面暴露的**累计**逐次记录替换当前账本（不重算、不重复计费）。 */
  replace(records: readonly ModelCallRecord[]): void {
    this.records = [...records];
  }

  /** 当前账本（逐次记录）。 */
  ledger(): readonly ModelCallRecord[] {
    return this.records;
  }

  usage(): AccountedUsage {
    return accountCalls(this.records);
  }

  /** 首次硬停事实（null = 未停）。 */
  stopped(): HardStopFact | null {
    return this.stopFact;
  }

  /**
   * 先验检查：已达上限即抛 `R6HardStopError`（**不发起下一请求**）。
   * 已停过则沿用首次事实直接抛（有界失败，不再前进）。
   */
  precheck(): void {
    if (this.stopFact !== null) throw new R6HardStopError(this.stopFact);
    const usage = this.usage();
    const elapsedMs = this.now() - this.startMs;
    const reason = exhaustionOf(usage, this.limits, elapsedMs);
    if (reason === null) return;
    const limit = reason === 'ms' ? this.limits.wallMs
      : reason === 'calls' ? this.limits.maxModelCalls
        : this.limits.maxTokens;
    const used = reason === 'ms' ? elapsedMs
      : reason === 'calls' ? usage.calls
        : usage.tokens;
    this.stopFact = { reason, limit, used, at: this.now() };
    throw new R6HardStopError(this.stopFact);
  }
}
