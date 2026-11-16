/**
 * SimCase 薄机制 · 确定性假件（机制自检专用；零模型、不触网）。
 *
 * 只服务「机制本身可靠」的验证：假模型 / 脚本化 simulator / 假被测系统。
 * 这里不做任何判定、不读 env、不写产品码——判定仍归 `./run` 与 `./oracle`。
 *
 * 与 `./run.test.ts` 里就地定义的假件不冲突：那份保持原样（存量断言不动），
 * 本文件供「说真值 / 无限追问 / 并发 5 / 轨迹分叉」这几项新自检共用。
 */

import type { SimSystemCall, SimSystemTurn, SimSystemUnderTest } from './run';
import type { SimExecutionFact } from './oracle';
import type { SimModel, SimModelCompletion, SimulatorPrompt } from './simulator';
import type { InjectionDirective } from './injection';

// ─────────────────────────────────────────────────────────────────────────────
// 假被测系统
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeSystemTurn {
  readonly visibleReply: string;
  readonly toolCalls?: number;
  readonly events?: number;
  readonly calls?: readonly SimSystemCall[];
  readonly executions?: readonly SimExecutionFact[];
}

export interface ScriptedSystemOptions {
  /** 超出 `turns` 后继续使用的回合（未给则抛错：脚本用尽 = 装配缺陷）。 */
  readonly fallback?: FakeSystemTurn | ((index: number) => FakeSystemTurn);
  /** 是否按锚点真实应用注入（缺省 false → 如实回报未应用）。 */
  readonly honorInjection?: boolean;
  /** 每次 send 前让出事件循环（用于并发池真实交叠；不是注入锚点）。 */
  readonly yieldBeforeReply?: boolean;
}

/** 按回合脚本答复的假系统；记录每次 send 的文本与收到的注入指令（锚点命中日志来源）。 */
export class ScriptedSystem implements SimSystemUnderTest {
  readonly sends: string[] = [];
  /** 每次系统回合收到的注入指令（null = 该回合没有交付注入）。 */
  readonly injections: Array<InjectionDirective | null> = [];
  /** 每次系统回合适配器是否应用了注入（与 injections 同序）。 */
  readonly applied: boolean[] = [];
  private index = 0;
  private toolCallsSoFar = 0;
  private eventsSoFar = 0;

  constructor(private readonly turns: readonly FakeSystemTurn[], private readonly options: ScriptedSystemOptions = {}) {}

  async send(text: string, ctx: { readonly injection: InjectionDirective | null }): Promise<SimSystemTurn> {
    this.sends.push(text);
    const index = this.index + 1;
    const turn = this.turns[this.index] ?? this.resolveFallback();
    this.index += 1;
    if (this.options.yieldBeforeReply === true) await new Promise<void>((resolve) => setImmediate(resolve));

    const toolCalls = turn.toolCalls ?? 0;
    this.toolCallsSoFar += toolCalls;
    this.eventsSoFar += turn.events ?? 0;
    const injection = ctx.injection;
    const applied = this.options.honorInjection === true && injection !== null && (
      (injection.anchor === 'systemTurn' && injection.at === index) ||
      (injection.anchor === 'toolCall' && this.toolCallsSoFar >= injection.at) ||
      (injection.anchor === 'event' && this.eventsSoFar >= injection.at)
    );
    this.injections.push(injection);
    this.applied.push(applied);
    return {
      visibleReply: turn.visibleReply,
      toolCalls,
      events: turn.events ?? 0,
      ...(turn.calls === undefined ? {} : { calls: turn.calls }),
      ...(turn.executions === undefined ? {} : { executions: turn.executions }),
      injectionApplied: applied,
      injectionReason: applied ? 'applied' : 'fake 未应用注入',
    };
  }

  private resolveFallback(): FakeSystemTurn {
    const fallback = this.options.fallback;
    if (fallback === undefined) throw new Error(`假系统回合脚本用尽（index=${this.index}）`);
    return typeof fallback === 'function' ? fallback(this.index) : fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 假模拟用户模型
// ─────────────────────────────────────────────────────────────────────────────

const TOKENS = { input: 100, output: 20, total: 120 } as const;

export function sayCompletion(text: string): SimModelCompletion {
  return { text: JSON.stringify({ action: 'say', text }), tokens: TOKENS, tokensObserved: true };
}
export function waitCompletion(reason: string): SimModelCompletion {
  return { text: JSON.stringify({ action: 'wait', reason }), tokens: TOKENS, tokensObserved: true };
}
export function finishCompletion(kind: 'satisfied' | 'gave_up', reason: string): SimModelCompletion {
  return { text: JSON.stringify({ action: 'finish', finishKind: kind, reason }), tokens: TOKENS, tokensObserved: true };
}

/** 按序吐出预设动作；用尽即抛（脚本用尽 = 用例装配缺陷，不得静默补齐）。 */
export class ScriptedSimulator implements SimModel {
  readonly prompts: SimulatorPrompt[] = [];
  private index = 0;

  constructor(private readonly outputs: readonly SimModelCompletion[]) {}

  async complete(prompt: SimulatorPrompt): Promise<SimModelCompletion> {
    this.prompts.push(prompt);
    const output = this.outputs[this.index];
    if (output === undefined) throw new Error(`模拟用户脚本用尽：index=${this.index}`);
    this.index += 1;
    return output;
  }
}

/** 永远追问（不主动收尾）：用于证明预算真的会停，而不是靠脚本刚好用完。 */
export class EndlessSimulator implements SimModel {
  readonly prompts: SimulatorPrompt[] = [];
  private index = 0;

  async complete(prompt: SimulatorPrompt): Promise<SimModelCompletion> {
    this.prompts.push(prompt);
    this.index += 1;
    return sayCompletion(`还有一点没明白，请再说明一下（第 ${this.index} 次追问）`);
  }
}

/**
 * 按 prompt 内容反应的模拟用户（不是预置动作序列）。
 *
 * 行为只来自两处用户视角可见的信息：
 *   · `# 人设` 段（严谨 / 急躁 / 耐心）——被赋予的人设决定它要不要等、要不要再确认一次；
 *   · `# 系统上一轮回复（用户可见）` 段——决定它这一轮说什么。
 * 人设段若缺少预期标记，直接抛错：证明行为确实读的是 prompt，而不是写死的脚本。
 */
export class ReactivePersonaSimulator implements SimModel {
  readonly prompts: SimulatorPrompt[] = [];
  constructor(private readonly style: 'thorough' | 'impatient' | 'patient') {}

  async complete(prompt: SimulatorPrompt): Promise<SimModelCompletion> {
    this.prompts.push(prompt);
    const persona = sectionOf(prompt.user, '# 人设');
    const marker = this.style === 'thorough' ? '严谨' : this.style === 'impatient' ? '急躁' : '耐心';
    if (!persona.includes(marker)) {
      throw new Error(`人设段缺少「${marker}」——模拟用户行为不是从 prompt 读出来的：${persona}`);
    }
    const lastReply = sectionOf(prompt.user, '# 系统上一轮回复（用户可见）');
    if (this.style === 'patient') {
      // 先等一轮（wait 不触发系统调用），等到结果再决定要不要复核。
      if (this.prompts.length === 1) return waitCompletion('先在面板上看看进度再问');
      if (lastReply.includes('需要我再发一次')) return sayCompletion('要，把刚才那份结果再发一次。');
      return finishCompletion('satisfied', '等到结果并复核一致');
    }
    if (this.style === 'thorough') {
      if (lastReply.includes('需要我再发一次')) return sayCompletion('要，把刚才那份结果再发一次。');
      return finishCompletion('satisfied', '两次结果一致');
    }
    return finishCompletion('satisfied', '一眼看到结果，够了');
  }
}

/** 取 prompt 里某个 `# 标题` 段落的正文（到下一个标题行为止）。 */
export function sectionOf(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('# ')) break;
    body.push(line);
  }
  return body.join('\n').trim();
}
