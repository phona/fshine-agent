/**
 * R6 Wave1 · 可单测的纯逻辑（参数解析 / 动态推进 / 结构泄漏批聚合）。
 *
 * **主线 harness 没有 `nextTurn`**：`scripts/eval/long-session/harness.ts` 只顺序跑 `plan.turns`，
 * 并在结束时统一做 Oracle 判定 + 结构泄漏扫描。Wave1 仍需「初始建立轮跑完后，按已观测
 * 的有效压缩次数决定是否追加推进轮」——本模块在每次 `send` 返回后向 `plan.turns`
 * 追加下一段真实内容；主线 harness 的 `for (const spec of plan.turns)` 是活数组迭代，
 * 追加项会被消费（`wave1-support.test.ts` 用 `FakeHarnessSession` 钉住该行为）。
 *
 * 边界（与 r6b 的 `nextTurn` 完全一致）：
 *   · 只在**初始计划全部跑完**后追加（`consumed >= initialTurns`），不会把推进轮插进建立轮中间；
 *   · 追加内容只决定「再注入哪段真实业务查询」，不读压缩阈值、不改变 Pi 压缩触发/门控；
 *   · 是否有效压缩由主线 `analyzeCompaction` 的既有算术回答，本模块不另建判据。
 *
 * 结构泄漏聚合只调用主线 `structure-leak.ts` 的 `aggregateStructureLeak`；本模块不实现
 * 第二套判据、不改 disposition（读数恒 `affectsDisposition: false`）。
 */
import type { HarnessSession } from './harness';
import {
  buildTrackPlan, type Track, type TrackPlan, type TurnSpec,
} from './load-generator';
import { analyzeCompaction, R6_COMPACTION_BOUNDS } from './compaction';
import {
  aggregateStructureLeak, type StructureLeakBatch, type StructureLeakReport,
} from './structure-leak';

export const WAVE1_TRACKS: readonly Track[] = ['LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LS6'];
/**
 * 每轨会话窗口（2026-11-18 owner 口径调整）：**默认全 40k**。
 * 理由：128k 单会话要跑到 ≥3 次压缩得烧 3M+ tokens，常换来 insufficient_coverage（实测 3.19M）；
 * 128k 只在"生产窗口专项"跑，用 `--smoke-window=128000` 或临时改本常量，并预注册预算。
 */
export const WAVE1_WINDOWS: readonly number[] = [40000, 40000, 40000];
/** 预注册缺省被测模型；`--model=` 可改用另一条基线。 */
export const WAVE1_DEFAULT_MODEL = 'step-3.7-flash';

export interface Wave1Args {
  readonly tracks: readonly Track[];
  readonly concurrency: number;
  readonly smoke: boolean;
  readonly smokeWindow: number;
  readonly model: string;
}

export function parseWave1Args(argv: readonly string[]): Wave1Args {
  let tracks: readonly Track[] = WAVE1_TRACKS;
  // 缺省串行：官方 step 端点模型级并发上限 5，单个会话回合还可能叠 Worker/摘要调用；
  // 高额度端点（本地 workbuddy）再显式 --concurrency=8。
  let concurrency = 1;
  let smoke = false;
  let smokeWindow = 128000;
  let model = WAVE1_DEFAULT_MODEL;
  for (const arg of argv) {
    if (arg === '--smoke') { smoke = true; continue; }
    if (arg.startsWith('--smoke-window=')) {
      smokeWindow = Number(arg.split('=')[1]);
      if (!Number.isInteger(smokeWindow) || smokeWindow <= 0) throw new Error(`--smoke-window 需要正整数：${arg}`);
      continue;
    }
    if (arg.startsWith('--all')) { tracks = WAVE1_TRACKS; continue; }
    if (arg.startsWith('--concurrency=')) {
      concurrency = Number(arg.split('=')[1]);
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency 需要正整数：${arg}`);
      continue;
    }
    if (arg.startsWith('--model=')) {
      const value = arg.slice('--model='.length).trim();
      if (value === '') throw new Error('--model 需要值');
      model = value;
      continue;
    }
    if (arg.startsWith('--track=')) {
      const raw = arg.split('=')[1]!.split(',').map((t) => t.trim().toUpperCase());
      tracks = raw.filter((t): t is Track => (WAVE1_TRACKS as readonly string[]).includes(t));
      if (tracks.length === 0) throw new Error(`--track 无效：${arg}`);
    }
  }
  return { tracks, concurrency, smoke, smokeWindow, model };
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐轨语料：建立轮 → （按压缩计数）推进轮 → 压缩后复查轮
// ─────────────────────────────────────────────────────────────────────────────

/** 会话标记：H7 跨会话泄漏与语料首轮共用同一机械文本。 */
export function sessionMarker(sessionId: string): string {
  return `会话标记 ${sessionId}。`;
}

function stripFact(turn: TurnSpec): TurnSpec {
  return { ...turn };
}

export interface TrackScript {
  /** 初始计划（LS1–LS5：建立轮，用例轮按需在压缩后发；LS6：完整 13 轮时间线）。 */
  readonly plan: TrackPlan;
  /** 压缩后复查轮（LS1/2/3 有；LS4/LS5 为生命周期探针；LS6 取 N2-B/N4/N5-B）。 */
  readonly probeTurns: readonly TurnSpec[];
  /** 压缩门槛达成后是否还追加稳态推进轮（LS5）。 */
  readonly steadyPumps: number;
}

/** 会话标记注入首轮（H7 跨会话泄漏与语料首轮共用同一机械文本）。 */
function markFirst(turns: readonly TurnSpec[], marker: string): TurnSpec[] {
  return turns.map((t, i) => (i === 0 ? { ...t, text: `${marker}${t.text}` } : t));
}

export function scriptFor(track: Track, sessionId: string): TrackScript {
  const base = buildTrackPlan(track);
  const establish = base.turns.filter((t) => t.kind === 'establish');
  const marker = sessionMarker(sessionId);
  const withMarker = markFirst(establish, marker);
  const facts = base.turns.filter((t) => t.kind === 'fact').map(stripFact);
  const tasks = base.turns.filter((t) => t.kind === 'task');
  const interactions = base.turns.filter((t) => t.kind === 'interaction');
  switch (track) {
    case 'LS1':
      return {
        plan: { track, turns: withMarker },
        probeTurns: facts,
        steadyPumps: 0,
      };
    case 'LS2':
      return {
        plan: { track, turns: withMarker },
        // 压缩后复查：同一批任务连续性问题（编号/对象/状态），不重开任务。
        probeTurns: [
          { index: 0, kind: 'probe', text: '不要新建任务：把目前所有任务的编号、对象、状态和结果逐一列出来。' },
          ...tasks.filter((t) => !t.text.startsWith('把刚才那个')).slice(0, 4).map((t) => ({ ...t, index: 0 })),
          { index: 0, kind: 'probe', text: '第一个和最后一个任务的编号分别是多少？结果对应哪个对象？' },
        ],
        steadyPumps: 0,
      };
    case 'LS3':
      return {
        plan: { track, turns: withMarker },
        probeTurns: interactions.map((t) => ({ ...t, index: 0 })),
        steadyPumps: 0,
      };
    case 'LS4':
      return {
        plan: { track, turns: withMarker },
        probeTurns: [
          { index: 0, kind: 'probe', text: '不要重新查询：凭你保留的上下文复述最早查的 alpha 结论（条数与总额）。' },
          { index: 0, kind: 'probe', text: '再复述一次 documents W202610 第二条的金额，并说明有没有四舍五入。' },
        ],
        steadyPumps: 0,
      };
    case 'LS5':
      return {
        plan: { track, turns: withMarker },
        probeTurns: [
          { index: 0, kind: 'probe', text: '不要重新查询：复述最早查的 alpha 结论（条数与总额）。' },
        ],
        steadyPumps: 6,
      };
    case 'LS6': {
      // LS6 是**时间线轨**：N1–N6 的 13 轮必须按序真发（不是压缩后复查的探针），
      // 否则交错/改口径/暂停/反悔/更正/取消的上下文根本不存在。首轮带会话标记（H7）。
      const keyLabels = new Set(['N2-B', 'N4', 'N5-B']);
      return {
        plan: { track, turns: markFirst(base.turns, marker) },
        // 压缩后复查：改口径后回头 / 反悔重做 / 自我更正（N2-B、N4、N5-B）。
        probeTurns: base.turns.filter((t) => t.label !== undefined && keyLabels.has(t.label)).map((t) => ({ ...t, index: 0 })),
        // LS6 是**交互轨**（时段/改口径/暂停/取消的机械判据），压缩不是它的目标：
        // 实测 21 轮 / 2.04M tokens 在 40k 下仍有效压缩=0（有界输出不涨上下文）。
        // 压缩覆盖交给 LS1/LS4/LS5；LS6 不再补推进轮（省 token 与时间）。
        steadyPumps: 0,
      };
    }
  }
}

/** 推进轮（真实大载荷：先开任务，再让 Main 取回完整结果 → 真实内容进入 Main 上下文）。 */
export function pumpTurn(index: number, fetchResult: boolean): TurnSpec {
  if (fetchResult) {
    return {
      index, kind: 'pump',
      text: '不要新建任务：把刚才受理的那个 bulk 任务（任务编号以你上一条回执为准）的结果报给我——先给总条数与总金额，再列出前 20 条的名称和金额即可。',
    };
  }
  const collection = index % 2 === 0 ? 'bulk-a' : 'bulk-b';
  return {
    index, kind: 'pump',
    text: `开一个任务：查 ${collection} 集合 W1 窗口的记录，给出总条数与总金额，并列前 20 条的名称与金额（不用全列）。`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主线 harness 适配：活计划追加（替代 r6b 的 nextTurn）
// ─────────────────────────────────────────────────────────────────────────────

/** 每回合结束后交给决策器的只读事实（与 r6b `HarnessProgress` 的消费面一致）。 */
export interface PumpProgress {
  readonly completedTurns: number;
  readonly effectiveCompactions: number;
}

export interface Wave1PumpOptions {
  readonly probeTurns: readonly TurnSpec[];
  readonly steadyPumps: number;
  /** 未达有效压缩门槛时最多追加的推进轮数。 */
  readonly pumpCap: number;
  readonly smoke: boolean;
  /** 有效压缩门槛（缺省 R6_COMPACTION_BOUNDS.minEffectiveCompactions）。
   *  交互轨（LS6）把它设为 0：压缩不是它的目标，否则会一直补推进轮撞模型调用预算
   *  （2026-11-18 实测：LS6 补满 24 轮 → 151 次调用 > 150 上限 → H6.b）。 */
  readonly minEffectiveCompactions?: number;
}

/**
 * 逐回合决策：压缩不足 → 追加推进轮；达标 → 压缩后复查轮（LS5 再追加稳态轮）。
 * 只在「再注入哪段真实内容」层面决策，不读阈值、不触发/抑制压缩。
 */
export function createWave1PumpDecider(options: Wave1PumpOptions): (progress: PumpProgress) => TurnSpec | null {
  let pumps = 0;
  let probeIndex = 0;
  const floor = options.minEffectiveCompactions ?? R6_COMPACTION_BOUNDS.minEffectiveCompactions;
  return (progress) => {
    if (
      progress.effectiveCompactions < floor
      && pumps < options.pumpCap
    ) {
      pumps += 1;
      return pumpTurn(progress.completedTurns + 1, pumps % 2 === 0);
    }
    if (!options.smoke && probeIndex < options.probeTurns.length) {
      const spec = options.probeTurns[probeIndex]!;
      probeIndex += 1;
      return { ...spec, index: progress.completedTurns + 1 };
    }
    if (pumps < options.pumpCap + options.steadyPumps) {
      pumps += 1;
      return pumpTurn(progress.completedTurns + 1, pumps % 2 === 0);
    }
    return null;
  };
}

export interface PumpedHarness {
  readonly session: HarnessSession;
  readonly plan: TrackPlan;
}

/**
 * 把 session 包一层：初始计划跑完后，每次 `send` 返回时询问 `nextTurn` 并把下一轮
 * **追加到同一个 `plan.turns` 数组**。主线 harness 的 `for...of` 会继续消费追加项，
 * 于是无需改 harness 签名即可保留 r6b 的动态推进语义。
 *
 * 该实现依赖「harness 以活数组迭代 `plan.turns`」；若主线将来改为快照迭代，
 * `wave1-support.test.ts` 的推进用例会先红，避免静默只跑初始计划。
 */
export function withPumpedTurns(
  session: HarnessSession,
  input: {
    readonly track: Track;
    readonly turns: readonly TurnSpec[];
    readonly nextTurn: (progress: PumpProgress) => TurnSpec | null;
  },
): PumpedHarness {
  const turns: TurnSpec[] = [...input.turns];
  const initialTurns = turns.length;
  let consumed = 0;
  let exhausted = false;
  const plan: TrackPlan = { track: input.track, turns };
  const advance = (): void => {
    consumed += 1;
    // 与 r6b 的 nextTurn 时机一致：初始计划跑完之前不插入推进轮。
    if (!exhausted && consumed >= initialTurns) {
      const next = input.nextTurn({
        completedTurns: consumed,
        effectiveCompactions: analyzeCompaction(session.compactionAttempts(), []).effectiveCount,
      });
      if (next === null) exhausted = true;
      else turns.push(next);
    }
  };
  const wrapped = new Proxy(session, {
    get(target, property, receiver) {
      if (property === 'send') {
        return async (text: string): Promise<{ reply: string; taskIds: readonly string[] }> => {
          const result = await target.send(text);
          advance();
          return result;
        };
      }
      // 延迟交办轮同样算「已消费一轮」，否则推进器永远等不到初始计划跑完。
      if (property === 'sendNoWait') {
        return async (text: string): Promise<{ reply: string; taskIds: readonly string[] }> => {
          if (typeof target.sendNoWait !== 'function') {
            throw new Error('计划含 deferIdle 轮，但会话面未提供 sendNoWait');
          }
          const result = await target.sendNoWait(text);
          advance();
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { session: wrapped, plan };
}

// ─────────────────────────────────────────────────────────────────────────────
// 批汇总：结构泄漏读数（复用主线判据，不参与 disposition）
// ─────────────────────────────────────────────────────────────────────────────

/** 批汇总的 `structureLeak` 字段：逐会话读数 + 总命中（来自主线 `aggregateStructureLeak`）。 */
export function structureLeakBatch(
  rows: readonly { readonly sessionId: string; readonly structureLeak: StructureLeakReport }[],
): StructureLeakBatch {
  return aggregateStructureLeak(rows.map((row) => ({ sessionId: row.sessionId, report: row.structureLeak })));
}
