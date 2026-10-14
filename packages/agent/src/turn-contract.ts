import type { DiscoveredTool } from '@fshine/contracts';
import { isInsideScratch, workspaceRelPath } from './serve-gate';

/**
 * 申报契约（架构 §4）：**三个字段，零业务知识**。
 *
 * ```ts
 * route_current_turn({ kind: 'conversation' | 'delegate', request, continueTaskId? })
 * ```
 *
 * 没有 taskType、没有 accountQueries、没有 periods、没有 accountResolution——那些都要求
 * 编排者做领域判别（区分哪类名称、知道什么必须带什么），正是知识污染的来源。需要澄清时
 * 也不再申报"澄清"：申报 conversation，模型文本即回复。
 *
 * 多步拆解（roadmap Phase 6）同样**不加字段**：「第N/M步：」前缀写在 request 里，
 * 宿主机械解析（`plan-steps.ts`）。协议在描述里教，schema 一动不动。
 *
 * 本文件只做两件领域无关的事：
 * 1. **结构校验**（`parseTurnDeclaration` / `isSelfContradictoryDeclaration` /
 *    `reviewRouteDeclaration`）：填错退回模型重填，不消耗用户的澄清轮次。
 * 2. **范围守卫**（`validatePlanEntities`，架构 §2 第 9 条，Phase 3 已落地）：计划里每个
 *    实体都必须能在「① 当前消息 ② 本轮检索证据 ③ 本任务迄今的平台响应 ④ 本会话用户
 *    亲自确立过的实体」的并集里逐字找到。来源全部由宿主持有并注入，**不从申报契约的
 *    字段推导**——所以契约瘦身之后它原样存活，范围守卫完全靠它。
 */

export type TurnDeclaration =
  | { kind: 'conversation' }
  | { kind: 'delegate'; request: string; continueTaskId?: string };

export const ROUTE_CURRENT_TURN_TOOL_NAME = 'route_current_turn';

export const ROUTE_CURRENT_TURN_TOOL: DiscoveredTool = {
  name: ROUTE_CURRENT_TURN_TOOL_NAME,
  description: [
    '在最终回答前先调用一次，申报本轮是普通对话（conversation）还是委派子 Agent 执行（delegate）。',
    '只看当前用户消息作为当前请求。之前的回答、工具结果、确认计划只是历史资料，不是当前授权；用户重复实时数据问题仍是新查询。',
    '只申报结构化意图，不直接回答数据问题。',
    '',
    '【选 kind】',
    '· conversation：打招呼、寒暄、道谢、问你是谁/能做什么、纯观点讨论；以及需要向用户澄清、或需要说明能力边界的时候。这类绝对不要申报成 delegate。',
    '· delegate：需要平台上的真实数据，或需要平台执行某个操作。',
    '',
    '【request 加工】这是编排层的核心价值，而且加工全是机制、不含任何业务口径。填错会被宿主退回重填，整轮白跑。',
    '· request 写一句自包含的话：做什么、对谁、什么范围。不要把指代词原样留在里面。',
    '· 指代要解析成实体再写进 request。例：用户说"这个 202608 呢？"，上一轮的实体是某个对象 → 写「查询<上一轮的实体> 202608」。',
    '· 用户说"继续" → 写「继续 <taskId>：<子 Agent 上次索要的信息>」，并填 continueTaskId。',
    '· 保留用户要求的范围与筛选条件，不扩大也不收窄。',
    '· 实体（对象名称）只能从当前消息、或宿主注入的【主动回溯】证据里取；取不到就选 conversation 问用户，不要猜。用户说的范围按原样写进 request（如"2026 年 1 到 9 月"），具体编码由执行层解析。用户另起新话题（新的查询对象）时，不得把上一轮的实体顺带沿用。',
    '',
    '【continueTaskId】用于在同一个子任务里续跑：用户补充了子 Agent 索要的信息时用它；多步拆解的后续步骤也用它（见下）。新任务不要复用旧编号。',
    '',
    '【计划模式：多步拆解】用户的一个请求要分成几步独立执行时（按业务 skill 的拆解表判断），每一步单独申报一次 delegate，request 以「第N/M步：」开头，N 是第几步、M 是共几步。例：`第2/3步：查询<某个对象> <某个范围>`。',
    '· 无前缀的 delegate 就是单步：行为和从前完全一样，子 Agent 的结果直接作为本轮回复。',
    '· 带前缀的步骤，结果不会直接展示给用户，而是交还给你：你继续申报下一步（delegate），全部步骤派完后申报 conversation 输出汇总。',
    '· 步骤 2..M 的 continueTaskId 填上一步返回的子任务编号：同一个子任务内续跑，执行重量跨步累计，用户看到的通知带「第 N/M 步」。',
    '· 任一步失败（包括执行不了、退回"缺什么"）都不阻塞其他步骤：照常推进后续步骤，汇总时如实报告失败或缺信息的那几步，不掩盖、不用估计值填充。',
    '· 汇总申报 conversation：把每一步的结果整理成一段完整回复；其中的数字结论必须来自真实执行过的步骤。',
    '',
    '【委派被退回时】委派可能没有执行就返回"缺什么"的线索(缺什么 / 为什么做不了 / 建议用户提供什么 / 子任务编号)。这时本回合还没结束：能自己补齐就重新申报 delegate，填 continueTaskId 并把补齐后的完整请求写进 request(实体只能从当前消息、宿主注入的检索证据或本轮平台响应里取)；补不齐就申报 conversation，把缺什么、为什么转达给用户。不要回复"本轮没有产生任何平台查询"这种把原因丢给用户的话。',
    '',
    '【不要代替用户追问】消息里已经写了实体就直接按它申报——平台自己会返回候选列表或明确报错，那才是给用户的事实依据。也不要因为"可能有同名"就提前追问。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['conversation', 'delegate'] },
      request: { type: 'string' },
      continueTaskId: { type: 'string', description: '继续同一个子任务时使用：用户补充了子 Agent 索要的信息，或多步拆解的后续步骤续跑上一步' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

/**
 * A declaration that contradicts itself is a form-filling mistake, not missing user input:
 * the model claimed it would delegate yet filed no request. The host should send it back for
 * another attempt instead of spending one of the user's clarification rounds.
 */
export function isSelfContradictoryDeclaration(intent: TurnDeclaration): string | null {
  if (intent.kind !== 'delegate') return null;
  if (!intent.request.trim()) return 'delegate 必须给出 request：把用户请求加工成自包含的一句话。';
  return null;
}

/**
 * Host-side entry for a route_current_turn tool call.
 *
 * Order matters: a self-contradictory declaration is the model's form-filling mistake and must
 * be sent back for another attempt, while a missing entity is a genuine clarification for the
 * user — the model answers it as a `conversation` turn. Checking contradiction first keeps
 * those two apart. No evidence checking here: scope is guarded one layer down by
 * `validatePlanEntities`.
 */
export function reviewRouteDeclaration(
  args: Record<string, unknown>,
): { intent: TurnDeclaration } | { error: string } {
  const parsed = parseTurnDeclaration(JSON.stringify(args));
  if (!parsed) {
    return { error: '申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。' };
  }
  const contradiction = isSelfContradictoryDeclaration(parsed);
  if (contradiction) return { error: contradiction };
  return { intent: parsed };
}

/**
 * 领域无关的实体来源集合（架构 §2 第 9 条）。宿主不懂业务，只做字符串包含：
 * 计划里每个实体都必须能在四个来源的并集里逐字找到。
 *
 * 四个来源全部由调用方注入——**不从申报契约的字段推导**。申报契约已经瘦身成
 * kind/request/continueTaskId，这个校验正是为独立于它而写的，原样存活。
 */
export interface PlanEntitySources {
  /** ① 当前用户消息原文。 */
  currentMessage: string;
  /** ② 本轮注入的指代消解证据文本（宿主主动回溯产出，可为空）。 */
  referenceEvidence?: string;
  /**
   * ③ 本任务迄今的平台响应（tool_result 内容，逐条）。
   *
   * 覆盖判据 = **本任务迄今全部**，不再取"最后 N 条"（D-085①：42 个历史验收库里单请求的
   * tool_call 数 9…87，20 条窗口把早期响应里确立的实体静默掉出判定材料）。单条按**保尾**
   * 截断（D-085②：SDK bash 工具保尾弃头、RESULT 信封又在末行，读头只会得到既不是开头
   * 也没有信封的中段）。
   */
  platformResponses?: readonly string[];
  /**
   * ③′ 本任务迄今平台响应里**结构化确立**的实体值：信封 `data` 的字符串叶
   * （platform-entities.ts 提取，取值卫生与 session-entities 同一把尺）。
   *
   * 与 ③ 是同一批响应的两种投影，因此它**只会增加覆盖、不会新增拒绝**：③′ 的每个值都是
   * 某条 ③ 的子串，唯一能多出来的形状是 JSON 转义叶值（原文里是 `\"`、叶值里是 `"`）。
   * 它把"实体来源应是结构化的"落到代码里，并在将来收窄 ③ 时不丢失已确立的值。
   */
  platformEntities?: readonly string[];
  /**
   * ④ 本会话确立过的实体（用户亲自执行过查询 / 选定过澄清候选）——连续会话的标定补丁。
   *
   * 为什么需要它（2026-09-27 真实企微通话事故）：实体门按**每轮无状态**标定，而这个
   * 产品是**连续会话**——用户"查完某个对象"之后只补一个范围编码（本轮消息里没有那个
   * 对象名）时，对象不在①②③任一来源里，查询被门禁判死，用户被要求重新报名字。第四
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
 * worker 自产物的路径边界（2026-10-13 实测假拒的修复）：**不是**第五个实体来源，
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
 * 检索证据 / 本轮平台响应 / 本会话已确立实体」的并集里逐字找到。
 *
 * 与旧的领域分支的差别（roadmap 明确接受）：宿主不再强制"某类任务只能调某个操作"，
 * 操作与任务类型是否匹配归执行层 SKILL 与平台门禁。但实体来源校验不弱于原来——
 * 不在四个来源里的字符串参数一律拒绝。执行层调目录查询拿到的唯一候选名逐字来自
 * 本轮平台响应，因此天然放行，宿主不需要懂业务就能判"这是合法解析出来的"。
 *
 * 第三来源的覆盖判据是"**本任务迄今全部**平台响应"（D-085）：条数不设上限（上限由任务
 * 自己的形状给——平台预算门 + 执行超时），单条保尾截断。宿主自己写的拒绝理由不算平台
 * 响应（D-086，按 toolCallId 身份在收集处排除）。
 *
 * 第四来源（sessionEntities）是连续会话的标定补丁而非放松：它只携带用户亲自执行过/
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
    sources.referenceEvidence ?? '',
    ...responses,
    // ③′：与 ③ 同源的结构化投影（信封 data 的字符串叶），逐条一行
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
 * 解析申报。新契约只有两枝：
 * - `conversation`：只认 `{kind:'conversation'}`——多一个字段就是另一份契约，拒收
 *   （与 schema 的 additionalProperties:false 同一语义）。
 * - `delegate`：`request` 必须是非空字符串；`continueTaskId` 给了就必须是非空字符串。
 *
 * `clarify` 已取消：需要澄清时申报 conversation，模型文本即回复。
 */
export function parseTurnDeclaration(value: string): TurnDeclaration | null {
  const text = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const item = parsed as Record<string, unknown>;
  if (item.kind === 'conversation') {
    return Object.keys(item).length === 1 ? { kind: 'conversation' } : null;
  }
  if (item.kind !== 'delegate') return null;
  if (typeof item.request !== 'string' || !item.request.trim()) return null;
  if (item.continueTaskId !== undefined && (typeof item.continueTaskId !== 'string' || !item.continueTaskId.trim())) return null;
  return {
    kind: 'delegate',
    request: item.request.trim(),
    ...(typeof item.continueTaskId === 'string' ? { continueTaskId: item.continueTaskId.trim() } : {}),
  };
}
