import { isInsideScratch, workspaceRelPath } from './serve-gate';

/**
 * 回合契约模块（2026-11-12 申报层正式删除后的遗留面）：**领域无关**，零业务知识。
 *
 * 申报工具（route_current_turn）与其解析/复核/退回（parseTurnDeclaration /
 * inspectTurnDeclaration / reviewRouteDeclaration / isSelfContradictoryDeclaration /
 * declarationShapeOf）已随直连工具面整体删除——Main Agent 现在直接调用执行层委派工具
 * （缺省 run_task），普通回合直接文本回复。本文件只剩两件仍在服役的领域无关职责：
 *
 * 1. `TurnDeclaration`：**宿主内部委派管道**的形状（不进模型 schema、不进工具描述），
 *    是冻结附件与逐任务委派块的现有载体（context.ts 消费）。名字保留史实，语义 = 一次
 *    委派请求；conversation / resend 两枝已随申报层删除，不再存在。
 * 2. **范围守卫**（`validatePlanEntities`，架构 §2 第 9 条）：计划里每个实体都必须能在
 *    「① 当前正文 ② 本轮引用文字 ③ 本轮检索证据 ④ 本任务迄今的平台响应 ④′ 结构化叶值
 *    ⑤ 本会话用户亲自确立过的实体」的并集里逐字找到。来源全部由宿主持有并注入——恢复
 *    路径从既有任务条目的快照读回（`asPlanEntitySources` 做形状校验），不从请求字段推导。
 */

/** 一次委派的形状（宿主内部管道；模型可见的 schema 只有委派工具的 request / taskId）。 */
export type TurnDeclaration = {
  kind: 'delegate';
  request: string;
  continueTaskId?: string;
};

/**
 * 领域无关的实体来源集合（架构 §2 第 9 条）。宿主不懂业务，只做字符串包含：
 * 计划里每个实体都必须能在五个来源的并集里逐字找到。
 *
 * 五个来源全部由调用方注入——**不从任何请求字段推导**（申报契约已删除；直连后 request
 * 只描述"这一轮要做什么"，不承载实体）。恢复路径从既有任务条目/run metadata 的来源快照
 * 读回，形状校验用 `asPlanEntitySources`；无快照时 fail-closed，不静默省略。
 */
export interface PlanEntitySources {
  /** ① 本轮用户正文，不包含引用内容。 */
  currentMessage: string;
  /** ② 本轮引用中的文字；只证明本次确实收到这段引用，不证明原消息身份、真实性或授权。 */
  quotedEvidence?: string;
  /** ③ 本轮注入的指代消解证据文本（宿主主动回溯产出，可为空）。 */
  referenceEvidence?: string;
  /**
   * ④ 本任务迄今的平台响应（tool_result 内容，逐条）。
   *
   * 覆盖判据 = **本任务迄今全部**，不再取"最后 N 条"（D-085①：42 个历史验收库里单请求的
   * tool_call 数 9…87，20 条窗口把早期响应里确立的实体静默掉出判定材料）。单条按**保尾**
   * 截断（D-085②：SDK bash 工具保尾弃头、RESULT 信封又在末行，读头只会得到既不是开头
   * 也没有信封的中段）。
   */
  platformResponses?: readonly string[];
  /**
   * ④′ 本任务迄今平台响应里**结构化确立**的实体值：信封 `data` 的字符串叶
   * （platform-entities.ts 提取，取值卫生与 session-entities 同一把尺）。
   *
   * 与 ④ 是同一批响应的两种投影，因此它**只会增加覆盖、不会新增拒绝**：④′ 的每个值都是
   * 某条 ④ 的子串，唯一能多出来的形状是 JSON 转义叶值（原文里是 `\"`、叶值里是 `"`）。
   * 它把"实体来源应是结构化的"落到代码里，并在将来收窄 ④ 时不丢失已确立的值。
   */
  platformEntities?: readonly string[];
  /**
   * ⑤ 本会话确立过的实体（用户亲自执行过查询 / 选定过澄清候选）——连续会话的标定补丁。
   *
   * 为什么需要它（2026-09-27 真实企微通话事故）：实体门按**每轮无状态**标定，而这个
   * 产品是**连续会话**——用户"查完某个对象"之后只补一个范围编码（本轮消息里没有那个
   * 对象名）时，对象不在①②③④任一来源里，查询被门禁判死，用户被要求重新报名字。第五
   * 来源把标定从"单轮"修正为"本会话用户亲自确立过的"。
   *
   * 边界（这是**标定**，不是放宽）：只收"用户亲自操作过（执行过）/确认过（选过）"的
   * 实体——来源 A = 本会话执行过的任务的 calls 快照（平台 args 规格机械提取），来源 B =
   * 澄清候选里用户选定过的那一个。散文里提过但从未操作的实体**不**收（宿主不做领域
   * 解析），那条路由 correctForm 的检索指引兜底。防幻觉功能不变：进 haystack 的每条
   * 都有用户来源与确立轮次可审计（Conversation Log 的 clarification_event / platform_tasks）。
   */
  sessionEntities?: readonly string[];
}

/**
 * worker 自产物的路径边界（2026-10-13 实测假拒的修复）：**不是**第六个实体来源，
 * 而是"哪些字符串参数压根不是领域实体"的判据。
 *
 * 事故形状（真模型 + mock 平台 + 写开放）：worker 把提案 payload 写进自己的草稿位置后，
 * 按 `tmp/<requestId>/proposal.json` 排进计划提交。该路径不在①-④任何来源里——它是
 * worker 刚落盘的工作区产物，不是用户给过、平台返回过的名称——逐字包含判定必然拒；
 * 重提再拒，撞上 DECLINED_PLAN_LIMIT 后终局block，worker 只能告诉用户"操作申请已用尽"。
 * 旧路径（直接 bash 发同一条命令）反而能成，因为绕过了这道校验。
 *
 * 判据与 write 门 / 提案 payload 边界检查**同一把尺**（serve-gate 的 workspaceRelPath +
 * isInsideScratch，不另写一份）：路径经 workspaceRoot 解析后必须落在本轮 scratchDir
 * （`tmp/<requestId>`）内。豁免面因此只有"本任务私有草稿位置里的路径"一种——`../` 穿越、
 * 绝对路径越界、符号链接逃逸、工作区里别的位置、别轮次的草稿位置，一律照旧逐字校验。
 * 不给"任意字符串伪装成路径就免检"开门：判据是路径解析的结果，不是字符串长相。
 */
export interface PlanArtifactBoundary {
  /** 平台工作区根（worker cwd）：与 write 门同一基准。 */
  workspaceRoot: string;
  /** 本轮 scratch 位置（`tmp/<requestId>`）：worker 唯一可写位置。 */
  scratchDir: string;
}

/**
 * 单条平台响应纳入包含判定的截断长度。**保尾不保头**（D-085②）。
 *
 * 真正作用在会话转录上的是 SDK bash 工具的保尾弃头（truncateTail：2000 行 / 50KB），而
 * RESULT 信封由平台在 stdout 末行发出——读头只会得到"既不是开头、也没有信封"的中段。
 * 原注释说本常量"与宿主留存 tool_result 的截断一致"，那个截断在 turn-persistence.ts，
 * 只作用于落库流，从不经过 haystack 读的转录——那句注释已被 D-085② 证伪。
 *
 * 取值 = SDK 自己的单条工具结果上限：真实结果不可能比这更长，所以本常数对真实转录是恒真的
 * no-op，只约束调用方直接注入的超长字符串（宿主注入 platformResponses 那条路）。
 */
const PLATFORM_RESPONSE_TAIL_CHARS = 50_000;
/** 纳入判定的会话实体条数上限：haystack 是判定材料不是仓库，长会话只保留最近确立的。 */
const SESSION_ENTITY_MAX = 40;

/**
 * 计划实体来源校验（架构 §2 第 9 条，领域无关）。
 *
 * 每个 call 的 args 里所有字符串都要逐一检查：以 `-` 开头的是 flag 不是实体，跳过；
 * 落在本轮 scratch 位置内的路径是 worker 自产物不是实体，跳过（判据见
 * `PlanArtifactBoundary`，与 write 门同一把尺）；其余字符串必须能在「当前消息 /
 * 引用证据 / 检索证据 / 本轮平台响应 / 本会话已确立实体」的并集里逐字找到。
 *
 * 与旧的领域分支的差别（roadmap 明确接受）：宿主不再强制"某类任务只能调某个操作"，
 * 操作与任务类型是否匹配归执行层 SKILL 与平台门禁。但实体来源校验不弱于原来——
 * 不在五个来源里的字符串参数一律拒绝。执行层调目录查询拿到的唯一候选名逐字来自
 * 本轮平台响应，因此天然放行，宿主不需要懂业务就能判"这是合法解析出来的"。
 *
 * 第四来源的覆盖判据是"**本任务迄今全部**平台响应"（D-085）：条数不设上限（上限由任务
 * 自己的形状给——平台预算门 + 执行超时），单条保尾截断。宿主自己写的拒绝理由不算平台
 * 响应（D-086，按 toolCallId 身份在收集处排除）。
 *
 * 第五来源（sessionEntities）是连续会话的标定补丁而非放松：它只携带用户亲自执行过/
 * 确认过的实体，flash 模型幻觉出的对象名仍然被挡（幻觉名不在任何来源里）。
 *
 * 边界判据缺省不传：调用方不给 `PlanArtifactBoundary` 时，产物路径豁免整支不出现，
 * 判定与今天一字不差（老路径/测试替身不受影响）。
 */
export function validatePlanEntities(
  calls: readonly { operation: string; args: readonly unknown[] }[],
  sources: PlanEntitySources,
  artifactBoundary?: PlanArtifactBoundary,
): string | null {
  // ③ 没有条数上限：单条 ≤ 50KB（SDK 工具结果上限），条数由平台预算门与执行超时封顶
  // （实测最大 87 次）。宿主再设一个 20 只会把早期证据静默掉出判定材料。
  const responses = (sources.platformResponses ?? [])
    .map((response) => response.slice(-PLATFORM_RESPONSE_TAIL_CHARS));
  const haystack = [
    sources.currentMessage,
    sources.quotedEvidence ?? '',
    sources.referenceEvidence ?? '',
    ...responses,
    // ④′：与 ④ 同源的结构化投影（信封 data 的字符串叶），逐条一行
    ...(sources.platformEntities ?? []),
    ...(sources.sessionEntities ?? []).slice(-SESSION_ENTITY_MAX),
  ].join('\n');
  for (const call of calls) {
    for (const value of call.args) {
      if (typeof value !== 'string') continue;
      const token = value.trim();
      // flag（--query）不是实体；空串无实体含义
      if (!token || token.startsWith('-')) continue;
      // worker 刚落盘的自产物路径不是领域实体：只有解析进本轮 scratch 位置的才算，
      // 判据复用 write 门那把尺（workspaceRelPath + isInsideScratch），不另写一份
      if (isOwnArtifactPath(token, artifactBoundary)) continue;
      if (!haystack.includes(token)) {
        // 只报第一个越权值并截断：worker 修正后重新提交完整 calls，逐次暴露即可
        return `计划包含未在当前请求、检索证据、平台响应或本会话已确立实体中出现的参数：${token.slice(0, 80)}`;
      }
    }
  }
  return null;
}

/**
 * token 是否是 worker 本任务自己的产物路径（落在本轮 scratch 位置内）。
 *
 * 复用 serve-gate 的判据而非另写一份：`workspaceRelPath` 做词法 + 符号链接双层边界
 * （`../` 穿越、绝对路径越界、链接逃逸全返回 null），`isInsideScratch` 判"是不是本轮
 * 私产"。两者都过不了 = 不是本任务可写位置里的产物，仍按领域实体逐字校验。
 */
function isOwnArtifactPath(token: string, boundary: PlanArtifactBoundary | undefined): boolean {
  if (!boundary) return false;
  const rel = workspaceRelPath(boundary.workspaceRoot, token);
  return rel !== null && isInsideScratch(rel, boundary.scratchDir);
}

/**
 * 从存储快照（任务条目的 entitySources / run metadata 的 entitySources）读回实体来源。
 *
 * 形状不符（含缺 currentMessage、数组字段不是字符串数组）→ null：调用方据此走
 * fail-closed 路径（拒绝恢复或做严格更窄的重建），**不得静默省略**范围校验。
 * 只认五个已知字段，未知字段忽略——快照是宿主自己写的，读侧不引入新语义。
 */
export function asPlanEntitySources(value: unknown): PlanEntitySources | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const currentMessage = record['currentMessage'];
  if (typeof currentMessage !== 'string') return null;
  const quotedEvidence = record['quotedEvidence'];
  const referenceEvidence = record['referenceEvidence'];
  if (quotedEvidence !== undefined && typeof quotedEvidence !== 'string') return null;
  if (referenceEvidence !== undefined && typeof referenceEvidence !== 'string') return null;
  const arrays = {} as { platformResponses?: string[]; platformEntities?: string[]; sessionEntities?: string[] };
  for (const key of ['platformResponses', 'platformEntities', 'sessionEntities'] as const) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return null;
    arrays[key] = raw as string[];
  }
  return {
    currentMessage,
    ...(typeof quotedEvidence === 'string' ? { quotedEvidence } : {}),
    ...(typeof referenceEvidence === 'string' ? { referenceEvidence } : {}),
    ...(arrays.platformResponses ? { platformResponses: arrays.platformResponses } : {}),
    ...(arrays.platformEntities ? { platformEntities: arrays.platformEntities } : {}),
    ...(arrays.sessionEntities ? { sessionEntities: arrays.sessionEntities } : {}),
  };
}
