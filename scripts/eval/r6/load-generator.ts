/**
 * R6 测试基建 · 负载生成器（确定性语料规划 + 上下文推进器；零模型）。
 *
 * 定位：为五轨（LS1–LS5）生成**确定性的逐轮语料计划**，并给出事实轮的原生期望
 * （供事实 Oracle 判定）。本模块是**纯函数面**：不 import 产品运行时、不读压缩阈值、
 * **不做任何压缩决策**。它的唯一职责是「给出要注入的真实内容轮」与「该轮的事实期望」。
 *
 * 上下文推进器（Context Pump）只**追加新的真实内容轮**（更多真实业务查询），
 * 以便在真实窗口下累积到 ≥3 次有效压缩；它**不读阈值、不决定何时压缩**
 * （对齐 harness 设计 §一 / 预注册 §三.6）。是否继续追加由执行器按「压缩计数」驱动。
 */
import { type FactExpectation, FACT_TRUTH } from './oracle';

export type Track = 'LS1' | 'LS2' | 'LS3' | 'LS4' | 'LS5';
export type TurnKind = 'establish' | 'fact' | 'task' | 'interaction' | 'pump' | 'probe';

export interface TurnSpec {
  readonly index: number;
  readonly text: string;
  readonly kind: TurnKind;
  /** 事实轮的机械期望（仅事实轮携带）。 */
  readonly fact?: FactExpectation;
  /** 任务轮的期望状态（Oracle 对照用；可省，任务判定以 registry 快照为准）。 */
  readonly expectTaskStatus?: string;
  /** 交互轮标签（NL1–NL10）。 */
  readonly label?: string;
}

export interface TrackPlan {
  readonly track: Track;
  readonly turns: readonly TurnSpec[];
}

function withIndex(turns: readonly Omit<TurnSpec, 'index'>[]): TurnSpec[] {
  return turns.map((t, i) => ({ ...t, index: i + 1 }));
}

/** LS1 事实语的建立轮（先建立事实，再经压缩后追问）。 */
function ls1Establish(): Omit<TurnSpec, 'index'>[] {
  return [
    { kind: 'establish', text: '先帮我查一下 alpha 集合 W1 窗口的记录总额，一共几条、总金额多少，把任务编号告诉我。' },
    { kind: 'establish', text: '同时再帮我开一个任务：查 beta 集合 W1 的记录，回头我要和 alpha 对比。' },
    { kind: 'establish', text: 'documents W202610 的记录也查一下，第二条金额是多少？' },
  ];
}

/** LS1 事实追问轮（F1–F8）。 */
function ls1Facts(): Omit<TurnSpec, 'index'>[] {
  const alpha = FACT_TRUTH['alpha']!;
  const beta = FACT_TRUTH['beta']!;
  return [
    { kind: 'fact', text: 'alpha 集合 W1 一共几条、总金额多少？', fact: { kind: 'exact', collection: 'alpha', count: alpha.count, sum: alpha.sum } },
    { kind: 'fact', text: 'beta 集合 W1 一共几条、总金额多少？alpha 比 beta 多多少？', fact: { kind: 'exact', collection: 'beta', count: beta.count, sum: beta.sum } },
    { kind: 'fact', text: 'documents W202610 第二条金额是多少？', fact: { kind: 'exact', collection: 'documents', value: 800 } },
    { kind: 'fact', text: '我刚才把 alpha 总额说错了，请按查询结果给出准确值。', fact: { kind: 'session_value', value: '2000' } },
    { kind: 'fact', text: '我之前让你按某个结论处理，现在那个结论作废，不要再按它回答。', fact: { kind: 'session_value', value: '作废' } },
    { kind: 'fact', text: '那个还没做完的汇总任务现在是什么状态？', fact: { kind: 'session_value', value: '未完成' } },
    { kind: 'fact', text: '记住：金额一律不要四舍五入。再报一次 alpha 总额。', fact: { kind: 'exact', collection: 'alpha', sum: 2000 } },
    { kind: 'fact', text: '帮我查一下 W9999 窗口的记录总额是多少？', fact: { kind: 'unanswerable', collection: 'alpha', window: 'W9999' } },
  ];
}

function ls2Turns(): Omit<TurnSpec, 'index'>[] {
  return [
    { kind: 'task', text: '帮我开一个大任务：核对 alpha 和 beta 的记录，逐项说明。', expectTaskStatus: 'completed' },
    { kind: 'task', text: '把刚才那个 alpha/beta 核对任务取消掉，不要做了。', expectTaskStatus: 'cancelled' },
    { kind: 'task', text: '再开一个任务：查 empty-one W1 的记录。', expectTaskStatus: 'completed' },
    { kind: 'task', text: '再开一个任务：查 faulty-one W1 的记录。', expectTaskStatus: 'failed' },
    { kind: 'task', text: '把正在执行的任务再报一次状态，别重复建任务。', expectTaskStatus: 'running' },
    { kind: 'task', text: '第一个和第二个任务的编号分别是多少？结果对应哪个对象？' },
  ];
}

function ls3Turns(): Omit<TurnSpec, 'index'>[] {
  return [
    { kind: 'interaction', text: '刚才那个任务的结论是什么？', label: 'NL1' },
    { kind: 'interaction', text: '第二个结果是什么？', label: 'NL2' },
    { kind: 'interaction', text: '上次查的 alpha 总额是多少？', label: 'NL3' },
    { kind: 'interaction', text: '改成查 beta 吧，不要 alpha 了。', label: 'NL4' },
    { kind: 'interaction', text: '你数错了，alpha 是 2 条不是 3 条，按 2 条重来。', label: 'NL5' },
    { kind: 'interaction', text: '在这个任务上再加一条：只统计金额为正的记录。', label: 'NL6' },
    { kind: 'interaction', text: '先不聊账务了，帮我看看 documents 的异常。', label: 'NL7' },
    { kind: 'interaction', text: '暂停一下，稍后继续。……继续刚才的。', label: 'NL8' },
    { kind: 'interaction', text: '刚才那个任务取消了吗？', label: 'NL9' },
    { kind: 'interaction', text: '你刚才为什么把 alpha 判成 3 条？解释一下你的判断。', label: 'NL10' },
  ];
}

/** 上下文推进器：追加**新的真实内容轮**（更多真实业务查询），迫使上下文累积。 */
export function buildPumpTurns(startIndex: number, count: number): TurnSpec[] {
  // 每轮换一个新对象/新窗口的组合，都是真实可查的业务语料（不是无意义填充）。
  const pumpTexts: readonly string[] = [
    '再开一个任务：查 bankflow-oct 2025-10 的记录，逐条列出来，说明有没有异常。',
    'contoso-logistics W1 也查一下有什么。',
    'alpha-group W1 的记录也核对一下。',
    'contoso-trade W2 的记录查一下。',
    'locked-one W1 的记录查一下（只读）。',
    '把上面几个集合的条数各报一遍，然后重新核对 alpha。',
  ];
  const out: TurnSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ index: startIndex + i, kind: 'pump', text: pumpTexts[i % pumpTexts.length]! });
  }
  return out;
}

/**
 * 构建某轨的确定性语料计划。LS4/LS5 本身不产事实轮（生命周期/长稳），但同样注入
 * 真实内容轮以累积上下文（LS5 复用 pump；LS4 复用 LS1 建立轮）。
 */
export function buildTrackPlan(track: Track): TrackPlan {
  switch (track) {
    case 'LS1':
      return { track, turns: withIndex([...ls1Establish(), ...ls1Facts()]) };
    case 'LS2':
      return { track, turns: withIndex([...ls1Establish(), ...ls2Turns()]) };
    case 'LS3':
      return { track, turns: withIndex([...ls1Establish(), ...ls3Turns()]) };
    case 'LS4':
      return { track, turns: withIndex([...ls1Establish()]) };
    case 'LS5':
      return { track, turns: withIndex([...ls1Establish()]) };
  }
}

/** 事实轮（供事实 Oracle 聚合）。 */
export function factTurns(plan: TrackPlan): readonly TurnSpec[] {
  return plan.turns.filter((t) => t.kind === 'fact' && t.fact !== undefined);
}
