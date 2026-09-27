import type { DiscoveredTool } from '@fshine/contracts';

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
 *    实体都必须能在「① 当前消息 ② 本轮检索证据 ③ 本任务迄今的平台响应」的并集里逐字
 *    找到。三个来源全部由宿主持有并注入，**不从申报契约的字段推导**——所以契约瘦身之后
 *    它原样存活，范围守卫完全靠它。
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
 * 计划里每个实体都必须能在三个来源的并集里逐字找到。
 *
 * 三个来源全部由调用方注入——**不从申报契约的字段推导**。申报契约已经瘦身成
 * kind/request/continueTaskId，这个校验正是为独立于它而写的，原样存活。
 */
export interface PlanEntitySources {
  /** ① 当前用户消息原文。 */
  currentMessage: string;
  /** ② 本轮注入的指代消解证据文本（宿主主动回溯产出，可为空）。 */
  referenceEvidence?: string;
  /** ③ 本任务迄今的平台响应（tool_result 内容，逐条）。 */
  platformResponses?: readonly string[];
}

/** 单条平台响应纳入包含判定的截断长度（与宿主留存 tool_result 的截断一致）。 */
const PLATFORM_RESPONSE_LIMIT = 20_000;
/** 纳入判定的平台响应条数上限：覆盖"目录查询拿到唯一候选、再按候选名查"这类跨计划解析。 */
const PLATFORM_RESPONSE_MAX = 20;

/**
 * 计划实体来源校验（架构 §2 第 9 条，领域无关）。
 *
 * 每个 call 的 args 里所有字符串都要逐一检查：以 `-` 开头的是 flag 不是实体，跳过；
 * 其余字符串必须能在「当前消息 / 检索证据 / 本轮平台响应」的并集里逐字找到。
 *
 * 与旧的领域分支的差别（roadmap 明确接受）：宿主不再强制"某类任务只能调某个操作"，
 * 操作与任务类型是否匹配归执行层 SKILL 与平台门禁。但实体来源校验不弱于原来——
 * 不在三个来源里的字符串参数一律拒绝。执行层调目录查询拿到的唯一候选名逐字来自
 * 本轮平台响应，因此天然放行，宿主不需要懂业务就能判"这是合法解析出来的"。
 */
export function validatePlanEntities(
  calls: readonly { operation: string; args: readonly unknown[] }[],
  sources: PlanEntitySources,
): string | null {
  const responses = (sources.platformResponses ?? []).slice(-PLATFORM_RESPONSE_MAX);
  const haystack = [
    sources.currentMessage,
    sources.referenceEvidence ?? '',
    ...responses.map((response) => response.slice(0, PLATFORM_RESPONSE_LIMIT)),
  ].join('\n');
  for (const call of calls) {
    for (const value of call.args) {
      if (typeof value !== 'string') continue;
      const token = value.trim();
      // flag（--query）不是实体；空串无实体含义
      if (!token || token.startsWith('-')) continue;
      if (!haystack.includes(token)) {
        // 只报第一个越权值并截断：worker 修正后重新提交完整 calls，逐次暴露即可
        return `计划包含未在当前请求、检索证据或平台响应中出现的参数：${token.slice(0, 80)}`;
      }
    }
  }
  return null;
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
