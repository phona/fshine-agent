/**
 * T9 归因不串判据（架构调整相位 1 的测量工具）。
 *
 * 判据一句话：**回复里的实体/期间 vs 审计里真实调用记录，逐条对**。它不读模型自述的
 * "我查过 X"——那是被审查的对象本身；真实调用记录只取执行层审计日志里**已执行**
 * 的行（refused 行不算，exitCode≠0 不算，非 query 行不算），entity/period 从查询参数
 * 与结果投影机械提取。
 *
 * 判红四种形态（今天实测的形状）：
 *   ① T3r 串轮：两次不同对象/期间的查询被并列成「刚才两次查询」，回复先点名更早那次；
 *   ② 答错：问「刚才查的是哪个」答成更早那次（最近一次的对象/期间缺席）；
 *   ③ 无据归因：回复点名了本会话没有任何真实调用的对象/期间（编造或旧记忆回流）；
 *   ④ 证据不足：真实调用去重后 <2 条——单条或零条不能冒充判定依据（fail-closed，
 *      不把"没有证据"读成"通过"）。
 *
 * 局限（如实声明，不假装覆盖）：本判据是表面事实核对，不判修辞。回复若既点名正确
 * 对象/期间、又把两次调用按时间顺序如实分列（"刚才查的是 Y；此前还查过 X"）即算过——
 * 那正是 T3r 事故的正确修法形态。回复原文随探针报告留档，供人工复核。
 */
import type { ExecutionAuditRow } from './evidence';

/** 判据消费的审计行子集（与 ExecutionAuditRow 同形；测试可直接构造）。 */
export type AttributionAuditRow = Pick<ExecutionAuditRow, 'mode' | 'script' | 'args' | 'refused' | 'exitCode' | 'result'>;

/** 判据消费的逐轮材料子集（探针 Turn 的真子集：回复 + 本轮审计窗口行）。 */
export interface AttributionTurn {
  reply: string;
  execution: readonly AttributionAuditRow[];
}

/** 一次真实发生的查询调用（对象 × 期间）。 */
export interface AttributionCall {
  entity: string;
  period: string;
}

/** 取 flag 后一个参数值（夹具审计行的 args 是扁平字符串数组）。 */
function argOf(args: unknown, flag: string): string | undefined {
  if (!Array.isArray(args)) return undefined;
  const index = args.indexOf(flag);
  if (index < 0 || typeof args[index + 1] !== 'string') return undefined;
  const value = args[index + 1];
  return value.trim() ? value : undefined;
}

/**
 * 全部**已执行**的查询调用，按时间顺序；同一 (entity, period) 重复出现时保留最后一次的
 * 位置（"最近一次"以最后发生为准）。refused 行、非零退出、非 query 行、缺对象/期间的
 * 行一律不进——调到了门不等于执行过。
 */
export function realQueryCalls(turns: readonly AttributionTurn[]): AttributionCall[] {
  const calls: AttributionCall[] = [];
  for (const turn of turns) {
    for (const row of turn.execution) {
      if (row.refused) continue;
      if (typeof row.exitCode === 'number' && row.exitCode !== 0) continue;
      if (row.mode !== 'query') continue;
      // result.collection 是执行层自己的对象规范名（dummy=collection）；索引签名是
      // unknown，只认字符串形态，其余回落参数提取——不做任意类型断言。
      const projected = row.result?.collection;
      const entity = typeof projected === 'string' && projected.trim() ? projected : argOf(row.args, '--collection');
      const period = argOf(row.args, '--window');
      if (!entity || !period) continue;
      const existing = calls.findIndex((call) => call.entity === entity && call.period === period);
      if (existing >= 0) calls.splice(existing, 1);
      calls.push({ entity, period });
    }
  }
  return calls;
}

/** 词边界内的实体/期间提及（避免 'alpha' 把 'alpha-group' 当成同一次调用）。 */
function mentionIndex(text: string, token: string): number {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[^A-Za-z0-9_-])(${escaped})(?:$|[^A-Za-z0-9_-])`, 'u').exec(text);
  return match ? (match.index ?? -1) : -1;
}

/**
 * 归因判据本体：对最后一轮（归因问句轮）的回复逐条核对。
 * 返回空数组 = 过；每条违例是一句可行动的人话（进探针报告的 notes）。
 */
export function attributionViolations(input: {
  turns: readonly AttributionTurn[];
  /** 夹具目录全集（抓"点了没查过的对象"）。判据不依赖夹具实现，调用方注入。 */
  knownEntities: readonly string[];
}): string[] {
  const { turns, knownEntities } = input;
  const calls = realQueryCalls(turns);
  if (calls.length < 2) {
    return [`T9 证据不足：审计里已执行的真实查询去重后仅 ${calls.length} 条（<2），无法判定归因是否串轮——不拿 0 或单条冒充依据`];
  }
  const reply = turns.at(-1)?.reply ?? '';
  if (!reply.trim()) return ['T9 证据不足：归因轮回复为空，无法判定'];

  const violations: string[] = [];
  const last = calls.at(-1)!;
  const lastIndex = mentionIndex(reply, last.entity);
  if (lastIndex < 0) {
    violations.push(`T9 归因未答对：最近一次真实调用是 ${last.entity} ${last.period}，回复未点名 ${last.entity}`);
  }
  if (mentionIndex(reply, last.period) < 0) {
    violations.push(`T9 归因未答对：最近一次真实调用是 ${last.entity} ${last.period}，回复未点名期间 ${last.period}`);
  }
  // ① 串轮/答错：回复先点名（或只点名）更早一次调用的对象。
  for (const call of calls.slice(0, -1)) {
    const index = mentionIndex(reply, call.entity);
    if (index >= 0 && (lastIndex < 0 || index < lastIndex)) {
      violations.push(
        `T9 归因串轮：回复先点名更早一次调用的对象 ${call.entity}（最近一次是 ${last.entity}）——`
        + '两次不同对象/期间的查询被混成一次或答成更早那次',
      );
    }
  }
  // ② 无据归因：点名了本会话没有任何真实调用的对象或期间。
  for (const name of knownEntities) {
    if (mentionIndex(reply, name) < 0) continue;
    if (calls.some((call) => call.entity === name)) continue;
    violations.push(`T9 无据归因：回复点名了本会话没有真实调用的对象 ${name}`);
  }
  const periods = new Set(reply.match(/\bW\d+\b/g) ?? []);
  for (const period of periods) {
    if (calls.some((call) => call.period === period)) continue;
    violations.push(`T9 无据归因：回复点名了本会话没有真实调用的期间 ${period}`);
  }
  return violations;
}
