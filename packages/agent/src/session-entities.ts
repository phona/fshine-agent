/**
 * 会话实体（任务 1 标定修复，实体门禁的第四来源）。
 *
 * 背景（2026-09-27 一次真实企微通话暴露的事故）：实体溯源门按**每轮无状态**标定，而这个
 * 产品是**连续会话**——用户"查完某个对象"之后只补一个范围编码（本轮消息里没有那个对象
 * 名），查询被门禁判死，用户被要求重新报名字。门禁防幻觉的功能必须保留（flash 模型真
 * 幻觉过对象名），错的是出处范围：本会话用户**亲自操作过**的实体同样是合法出处。
 *
 * 来源 A（本文件）：`platform_tasks` 里**执行过**的任务的 calls 快照，按平台 args 规格
 * （`operation list --json`）机械提取实体承载参数的取值。与执行台账（execution-facts）
 * 同源同纪律：只认宿主持有的结构化底账，**绝不从结果原文/worker 文本解析**——转录里
 * "提过"不等于"执行过"；规格拿不到时降级为空数组（安全缺省，与 label/argStyles 派生
 * 一致：没有规格就不提取，绝不用宿主硬编码参数名顶替）。
 *
 * 边界（写在这里供走查）：只收"用户亲自操作过（执行过查询）"的实体；用户散文里提过但
 * 从未操作的实体**不**收（宿主不做领域解析）——那条路由 correctForm 的检索指引兜底
 * （见 error-codes.ts 的 ENTITY_OUT_OF_SCOPE）。防幻觉功能不变：进 haystack 的每条
 * 都有用户来源与确立轮次可审计。
 */
import type { PlatformTaskRecord, PlatformTaskRepo } from '@fshine/contracts';
import type { OperationArgsSpecs } from './operation-labels';

/** 单条提取取值的长度上限：实体名是短字段（与 planCallFacts 的取值卫生同一把尺）。 */
const ENTITY_VALUE_MAX_CHARS = 40;
/** 纳入提取的任务条数上限：与平台响应条数上限同族（覆盖跨回合解析，长会话只取最近的）。 */
const SESSION_TASK_SCAN_LIMIT = 20;

/**
 * 单次调用的实体承载参数取值（平台 args 规格查表，零硬编码参数名）。
 *
 * 判据只有规格声明：
 *   · 位置参数按序对应 `positionalNames`——规格声明过的位置参数才收（第几个位置参数
 *     就是第几个声明名，与 planCallFacts 同一套对应关系）；
 *   · flag 只收 `flagStyles` 里登记过的取值（平台自己声明了 name/code 样式的才有实体
 *     含义；none 布尔开关没有取值可摘）。
 * 规格查不到这个 operation → 这次调用不贡献任何值（宁缺勿猜）。
 *
 * 与 planCallFacts 的分工：那个只取 accountSet/period 两个**结构化字段**给任务条目
 * （--query 是检索词、刻意不当成已解析的规范名）；这里取**全部实体承载取值**给门禁
 * haystack——门禁要回答的是"这个参数值用户在本会话亲自确立过吗"，检索词同样算数
 * （用户确实带着它执行过）。
 */
function entityValuesOfCall(
  call: { operation: string; args: readonly unknown[] },
  specs: OperationArgsSpecs | undefined,
): string[] {
  const spec = specs?.get(call.operation);
  if (!spec) return [];
  const values: string[] = [];
  let positionalIndex = 0;
  for (let index = 0; index < call.args.length; index += 1) {
    const token = call.args[index];
    if (typeof token !== 'string') continue;
    if (token.startsWith('--')) {
      const next = call.args[index + 1];
      if (typeof next === 'string' && !next.startsWith('--')) {
        if (spec.flagStyles.has(token)) values.push(next);
        index += 1;
      }
      continue;
    }
    if (positionalIndex < spec.positionalNames.length) values.push(token);
    positionalIndex += 1;
  }
  return values;
}

/** 取值卫生：剥引号、去空白；空串与超长值（不是实体名的形状）丢弃。 */
function cleanEntityValue(value: string): string | undefined {
  const text = value.trim().replace(/^["']+|["']+$/g, '').trim();
  return text && text.length <= ENTITY_VALUE_MAX_CHARS ? text : undefined;
}

/**
 * 从本会话执行过的平台任务提取实体名（来源 A，纯函数）。
 *
 * 只取**执行过**的任务（`outcome === 'done'`，即有平台执行证据的那些）的 calls 快照：
 * 零执行的任务（needs/failed）可能带着从未执行的计划 calls，收进来等于把"没发生过"
 * 当成出处。搜索结果候选列表、结果原文里提到的名字同样不进——那是"提过"不是"操作过"。
 *
 * 规格缺失/空表 → 空数组（安全缺省：没有规格就不提取，判定回退到其余三个来源）。
 */
export function sessionEntitiesFromRecords(
  records: readonly PlatformTaskRecord[],
  specs: OperationArgsSpecs | undefined,
): string[] {
  if (!specs || specs.size === 0) return [];
  const executed = records.filter((record) => record.outcome === 'done' && (record.calls?.length ?? 0) > 0);
  const values: string[] = [];
  for (const record of executed.slice(-SESSION_TASK_SCAN_LIMIT)) {
    for (const call of record.calls ?? []) {
      for (const value of entityValuesOfCall(call, specs)) {
        const cleaned = cleanEntityValue(value);
        if (cleaned) values.push(cleaned);
      }
    }
  }
  return dedupe(values);
}

/** 去重保序（首次出现序；空白值跳过）。haystack 的条数上限由校验器一侧统一收口。 */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

/**
 * 合并去重（来源 A 的执行实体 + 来源 B 的澄清选定 + …）：并集去重，保序。
 * runtime 每回合调一次，产出即 `PlanEntitySources.sessionEntities`。
 */
export function mergeSessionEntities(...groups: ReadonlyArray<readonly string[]>): string[] {
  return dedupe(groups.flat());
}

/**
 * 读底账取来源 A（异步包装：存储抛错由调用方兜底降级，与执行台账/主动回溯同一套路径）。
 */
export async function collectSessionEntities(options: {
  platformTasks: Pick<PlatformTaskRepo, 'listBySession'>;
  operationArgSpecs?: OperationArgsSpecs;
  principalId: string;
  sessionId: string;
}): Promise<string[]> {
  const records = await options.platformTasks.listBySession(options.principalId, options.sessionId);
  return sessionEntitiesFromRecords(records, options.operationArgSpecs);
}
