/**
 * 任务级证据链与状态阶梯（issue #10 切片 D）。
 *
 * 判定的唯一依据是三类**宿主/执行层持有的结构化事实**，不读模型自述、也不按
 * console.info 日志下标归因（下标 + 串行窗口在并发与后台完成时会错，issue 目标 5
 * 明确不让人长期依赖它）：
 *   ① 执行层审计日志 —— EXECUTION_AUDIT_PATH 的 JSONL 行（mode/script/args/serve/
 *     refused/exitCode），被拒的行也在册且信息更多（「调用了」与「被拒+原因」可分）；
 *   ② 宿主审计库 —— agent_requests（messageId → requestId 关联）、tool_calls
 *     （serve_gate:* 的门裁决）、task_runs / platform_tasks（taskId 与交付状态）、
 *     change_intents（提案与读回校验）；
 *   ③ handler 返回 —— 最终回复是否非空（delivered 的唯一判据）。
 *
 * 关联 ID 链：evalRunId → caseId → messageId → requestId → taskId/delegationId →
 * execution evidence。每一档都由上一档的持久化 id 查出（messageId 在宿主库里有唯一
 * requestId；requestId 在 tool_calls/task_runs 里有 task/delegation 事实），断链时
 * 如实置 null/INCONCLUSIVE，绝不回落「时间窗内最近一条」这种猜测。
 *
 * 状态阶梯（每条平台调用）：authorized → invoked → completed → verified → delivered。
 * 无证据的档不标成功——标 INCONCLUSIVE（issue 验收标准「无证据标为 INCONCLUSIVE 而非
 * 成功」）。阶梯语义见 classifyExecutionCall 的注释。
 */
import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { AuditStore, ChangeIntentRecord, TaskRunRecord, ToolCallRecord } from '@fshine/contracts';

// ── ① 执行层审计日志 ──

/** 执行层审计日志行（夹具网关 audit() 落账的形状；字段缺席 = 夹具没写，不是假）。 */
/** 阶梯从弱到强（INCONCLUSIVE 弱于一切：有行缺证据也要看得见）。 */
const RUNG_ORDER: ReadonlyArray<LadderRung | 'INCONCLUSIVE'> = ['INCONCLUSIVE', 'invoked', 'authorized', 'completed', 'verified', 'delivered'];

export interface ExecutionAuditRow {
  ts?: string;
  mode?: string;
  /** 操作注册名或本地脚本相对路径。 */
  script?: string;
  args?: unknown;
  serve?: boolean;
  /** 门拒绝原因；在册 = 该调用被执行层自己的门拒了，从未执行。 */
  refused?: string;
  exitCode?: number;
  planId?: string;
  protocol?: string;
  /**
   * 提案 id（proposal.create / proposal.commit 行由夹具写入）。readExecutionAuditLog 是
   * `JSON.parse(line) as ExecutionAuditRow` 盲转，所以这个字段**运行时一直在**，只是此前
   * 没在类型上声明——读回证据按它逐条关联到具体调用（PR #21 审查 blocking：会话级的
   * `intents.some(...)` 会用历史成功给新调用造假证据）。
   */
  proposalId?: string;
  /**
   * 调用载体：`structured` = 经 structured_call 协议进来（bash 直调为 undefined）。
   * 2026-11-09 九审 major 补：此前结构化成功路径一律记 `mode:'call'`，与 bash 路径按 access
   * 分级的 query/prepare 不一致，评测据 mode 判读类时结构化查询全被漏掉。现在 mode 按 access
   * 分级、载体单列一个字段，两件事不再挤同一个键。
   */
  via?: string;
  /**
   * 一次调用的关联 id（起止两行共用；bash 单行调用没有这个字段）。
   * 2026-11-09 十一审 major：提案路径记「开始 + 结果」两行，评测若不按 callId 合并，
   * 开始行（无 exitCode）会永久停在 invoked，把一次成功的提交拖成 invoked/机械失败，
   * 调用数还多计一次。
   */
  callId?: string;
  /** 起止两行中的哪一行：`start` = 调用已发出、结果未知；`result` = 最终结果。 */
  phase?: 'start' | 'result';
  /**
   * query 类调用实际返回的响应载荷（2026-11-09 audited 申报模式交叉核的事实基准）。
   * 夹具在 query 的 completed / not_found / needs_input 三种确定性答案上都把**该次**结果
   * 状态写进 `result.status`，completed 另带该次返回的 items/count，使"回复里的数平台
   * 确实拉回过"与"平台确实说过 not_found"可以独立核对，不再只靠模型自述传递（空数组 +
   * count 0 也是真答案：平台拉回过、只是没有数据）。被拒/失败（行内无 queryResult）的行
   * 不带这个字段——那些调用没有可申报的结果。字段缺席 = 没写过，不是假；旧日志没有
   * status 时，带 items 的行按 completed 读。
   * stock 夹具的域字段是 sku/qty，落账时按同一契约投影成 name/value；平台原始字段名
   * （投影前）单列在 `fields`，供 nocaliber 命题核对——只看投影后的 items 会把
   * `nocaliber(north, sku)` 假过（sku 正是被投影掉的原始字段）。
   */
  result?: {
    /** 查询结果状态：completed / not_found / needs_input（旧日志可能缺席）。 */
    status?: 'completed' | 'not_found' | 'needs_input';
    items?: Array<{ id?: string; name?: string; value?: number }>;
    count?: number;
    /** 平台原始 items 的字段名（completed 时由夹具落账；旧日志/空结果可能缺席）。 */
    fields?: string[];
  };
}

/**
 * 读执行层审计日志。路径未设/文件缺失/坏行各自如实处理：未设 = 没有证据来源（返回
 * null，调用方按 INCONCLUSIVE 处理，不得当零调用）；文件在 = 逐行解析，坏行跳过。
 */
export function readExecutionAuditLog(auditPath: string | undefined): ExecutionAuditRow[] | null {
  if (!auditPath) return null;
  if (!existsSync(auditPath)) return [];
  try {
    return readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as ExecutionAuditRow; } catch { return null; }
      })
      .filter((row): row is ExecutionAuditRow => row !== null);
  } catch {
    return null;
  }
}

// ── ② 宿主审计库事实 ──

/** agent_requests 一行（messageId → requestId 的唯一关联档）。 */
export interface HostRequestFacts {
  requestId: string;
  messageId: string;
  principalId: string;
  outcome: string;
}

/** tool_calls 里的门裁决行（serve_gate:* / platform_executor_bypassed）。 */
export interface HostGateRow {
  requestId: string;
  toolName: string;
  status: string;
  errorCode?: string;
  /** 被拦原因 / 命令摘要（assembly 的 serveGateAudit 落两处：detail + reason）。 */
  reason?: string;
  detail?: string;
}

/** 一次委派/后台 run 的宿主持有事实（taskId / delegationId 档）。 */
export interface HostDelegationFacts {
  taskId: string;
  runId?: string;
  planId?: string;
  state?: TaskRunRecord['state'];
  deliveryState?: TaskRunRecord['deliveryState'];
  resultHandlingState?: TaskRunRecord['resultHandlingState'];
  hasResultText: boolean;
}

/** 提案意图的宿主持有事实（verified 档的写路径证据）。 */
export interface HostIntentFacts {
  intentId: string;
  proposalId?: string;
  taskId?: string;
  status: ChangeIntentRecord['status'];
  /** commit 读回校验输出摘要是否在（committed 路径写入）。 */
  hasReadback: boolean;
}

// ── 关联 ID 链 ──

/**
 * 一条消息的完整证据链。任何一档查不到就置 null / INCONCLUSIVE——断链是结论的一部分，
 * 不是可以绕过的障碍（fallback 到时间窗归因正是要禁掉的做法）。
 */
export interface MessageEvidenceChain {
  evalRunId: string;
  caseId: string;
  messageId: string;
  /** 宿主 agent_requests 按 messageId 查出的请求 id；null = 关联断（INCONCLUSIVE）。 */
  requestId: string | null;
  /** 该请求下的委派事实（task_runs.origin_request_id）。 */
  delegations: HostDelegationFacts[];
  /** 该请求下的提案意图（change_intents）。 */
  intents: HostIntentFacts[];
  /** 该请求下的宿主门裁决行（tool_calls.serve_gate:*）。 */
  gateRows: HostGateRow[];
  /** 该消息窗口内的执行层审计行。 */
  executionRows: ExecutionAuditRow[];
  /** handler 返回的最终回复（delivered 判据）；null = handler 抛错/未返回。 */
  finalReply: string | null;
}

/**
 * 从宿主审计库按 messageId 反查宿主持有事实。auditStore 缺表（旧替身）时对应档降级为
 * 空——如实缺证据，不造空成功。
 *
 * `sessionKey` 是**主会话键**（`channel:conversationId`，handler.ts 同款），必须由调用方
 * 按它自己那条消息的真实 conversationId 给出，不能从 principalId 推导——handler.ts:571
 * 明确定义"session = 聊天窗口、principal = 发消息的人，两个身份分开…不互相推导"。
 * 单聊时两者同形，所以旧代码一直蒙混过关；`ask-session` 支持固定且独立的 conversationId，
 * 一旦两者不同，按 principalId 反查 taskRuns 会整批查空，委派与确认事实凭空消失。
 */
export async function collectHostFacts(
  store: AuditStore,
  messageId: string,
  sessionKey: string,
): Promise<{
  request: HostRequestFacts | null;
  delegations: HostDelegationFacts[];
  gateRows: HostGateRow[];
}> {
  const found = await store.requests.findByWecomMessageId(messageId).catch(() => null);
  if (!found) {
    return { request: null, delegations: [], gateRows: [] };
  }
  const request: HostRequestFacts = {
    requestId: found.requestId,
    messageId: found.wecomMessageId,
    principalId: found.principalId,
    outcome: String(found.outcome),
  };
  const toolRows: ToolCallRecord[] = await store.toolCalls.listByRequest(found.requestId).catch(() => []);
  const gateRows: HostGateRow[] = toolRows
    .filter((row) => row.toolName.startsWith('serve_gate:') || row.toolName === 'platform_executor_bypassed')
    .map((row) => ({
      requestId: row.requestId,
      toolName: row.toolName,
      status: row.status,
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(typeof row.safeArguments['reason'] === 'string' ? { reason: row.safeArguments['reason'] as string } : {}),
      ...(typeof row.safeArguments['detail'] === 'string' ? { detail: row.safeArguments['detail'] as string } : {}),
    }));
  const runs: TaskRunRecord[] = store.taskRuns
    ? await store.taskRuns.listBySession(found.principalId, sessionKey).catch(() => [])
    : [];
  const delegations = runs
    .filter((run) => run.originRequestId === found.requestId)
    .map((run) => ({
      taskId: run.taskId,
      ...(run.runId ? { runId: run.runId } : {}),
      ...(run.planId ? { planId: run.planId } : {}),
      ...(run.state ? { state: run.state } : {}),
      ...(run.deliveryState ? { deliveryState: run.deliveryState } : {}),
      ...(run.resultHandlingState ? { resultHandlingState: run.resultHandlingState } : {}),
      hasResultText: typeof run.resultText === 'string' && run.resultText.length > 0,
    }));
  return { request, delegations, gateRows };
}

/**
 * 主会话键（handler 同款，apps/server/handler.ts：sessionId = `channel:conversationId`）。
 *
 * 2026-11-08 删掉原先的 `sessionKeyOf(principalId) { return principalId }`：那是把主体 ID
 * 当会话键用，而 handler.ts:571 自己写着"session = 聊天窗口、principal = 发消息的人，
 * 两个身份分开…不互相推导"。单聊时 conversationId == userid 所以同形，旧写法一直蒙混；
 * 但 ask-session 支持固定且独立的 conversationId，两者不同时按 principalId 反查
 * taskRuns / change_intents 会整批查空，把真实发生的委派与确认事实报成断链。
 * 现在由调用方按自己那条消息的真实 conversationId 构造后传入。
 */
export function sessionKeyOfChannel(conversationId: string, channel = 'wecom'): string {
  return `${channel}:${conversationId}`;
}

/**
 * 提案意图事实（verified 档的写路径证据）。AuditStore 的 ChangeIntentRepo 只暴露
 * pending 查询，完整清单走与 scripts/eval/write-chain.ts 同一条只读 SQL——同一张表、
 * 同一个键（change_intents.session_id），口径不另起一份。
 */
export function collectIntentFacts(db: Database.Database, sessionKey: string): HostIntentFacts[] {
  let rows: Array<{ intent_id: string; proposal_id: string | null; task_id: string | null; status: string; result: unknown }>;
  try {
    rows = db.prepare(
      'SELECT intent_id, proposal_id, task_id, status, result FROM change_intents WHERE session_id = ? ORDER BY created_at, rowid',
    ).all(sessionKey) as Array<{ intent_id: string; proposal_id: string | null; task_id: string | null; status: string; result: unknown }>;
  } catch {
    // 只读旁路被写方短暂锁住等读失败：意图档缺席（verified 档因此不授予——宁可
    // INCONCLUSIVE，不造证据），不抛错打断整条链。
    return [];
  }
  return rows.map((row) => ({
    intentId: row.intent_id,
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    status: row.status as ChangeIntentRecord['status'],
    // 读回验证 = result 里**明确写着 verified:true**（十五审 blocking）。旧写法只看
    // result 非空——而 context.ts 的 committedUnverified 分支存的正是
    // `result={output, verified:false, ...}`：非空，但平台信封明确表示未验证。那种记录
    // 旧写法会判"有读回"，于是 ask-session/probe/report 据此给同 proposalId 的调用授予
    // verified，exitCode=0 再升 delivered——把平台说"没验"的结果报成已验证。
    // 字段损坏/缺失一律不算成功证据（fail-closed）。
    hasReadback: readbackVerifiedOf(row.result),
  }));
}

/** 持久化 result → 是否真的读回验证过。只认 `verified === true`，其余（缺失/损坏/false）都不算。 */
function readbackVerifiedOf(result: unknown): boolean {
  if (result === null || result === undefined || result === '') return false;
  let parsed: unknown = result;
  if (typeof result === 'string') {
    try { parsed = JSON.parse(result); } catch { return false; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return (parsed as { verified?: unknown }).verified === true;
}

// ── 状态阶梯 ──

export type LadderRung = 'authorized' | 'invoked' | 'completed' | 'verified' | 'delivered';

/** 一条平台调用的阶梯判定。rung = 已被证据支撑的最高档；INCONCLUSIVE = 无证据。 */
export interface CallLadderEntry {
  /** 操作注册名/脚本名（执行层审计行的 script）。 */
  script: string;
  rung: LadderRung | 'INCONCLUSIVE';
  /** 门拒绝原因（refused 在册时必填）。 */
  refusedReason?: string;
  /** 每一档判定的证据出处（人可读；判定独立于 Agent 自述的凭据）。 */
  basis: string[];
}

/**
 * 把执行层审计行按 callId 合并成**一次调用一行**（导出供单测）。
 *
 * 2026-11-09 十一审 major：提案路径记「开始 + 结果」两行（开始行留在册上，用于识别"调用
 * 发出过但没有结果"的中途崩溃）。评测侧若不合并，开始行没有 exitCode 会永久停在 invoked，
 * messageLadderRung 取最低档后即使提交成功也报 invoked / 机械失败，调用数还多计一次。
 * 合并规则：同 callId 的 start 与 result 合成一行，取 result 的 exitCode/refused，
 * 保留 start 的 mode/script/args/protocol/proposalId；**只有 start 没有 result** 的原样
 * 留下（那就是中途崩溃，理应停在 invoked）。没有 callId 的行原样通过。
 */
export function mergeCallPhases(rows: readonly ExecutionAuditRow[]): ExecutionAuditRow[] {
  const results = new Map<string, ExecutionAuditRow>();
  const starts = new Map<string, ExecutionAuditRow>();
  const passthrough: ExecutionAuditRow[] = [];
  for (const row of rows) {
    if (row.callId === undefined || row.phase === undefined) { passthrough.push(row); continue; }
    if (row.phase === 'result') results.set(row.callId, row);
    else starts.set(row.callId, row);
  }
  const merged: ExecutionAuditRow[] = [];
  for (const [callId, result] of results) {
    const start = starts.get(callId);
    merged.push(start ? { ...start, ...result } : result);
  }
  // 只有开始行（结果没落账）= 调用发出过但没有结果：原样保留，让阶梯停在 invoked。
  for (const [callId, start] of starts) {
    if (!results.has(callId)) merged.push(start);
  }
  return [...merged, ...passthrough];
}

/**
 * 单条调用的阶梯（机械，纯函数）：
 *   · 执行层审计行 refused 在册 → 门拒了这次调用：invoked（调到了门）+ 拒绝原因，
 *     authorized/completed 永不成立——「调用获准」与「实际执行」是两档，被拒行恰恰
 *     证明前档不成立；
 *   · 行在册且无 refused → authorized + invoked；exitCode === 0 → completed；
 *   · verified 由两种证据之一授予：宿主 change_intents 读回校验在（写类），或该行是
 *     读类调用（mode=query，无副作用要读回，exitCode=0 即结果已在手）。执行层自己说
 *     "成了"不算（判定独立于 Agent/worker 自述）；
 *   · delivered 只从 verified 升——送达是用户面事实，不能补齐缺失的执行验证链；
 *   · 没有任何执行层行（auditPath 未设/空窗口）→ INCONCLUSIVE，不标成功。
 */
export function classifyExecutionCall(args: {
  row: ExecutionAuditRow;
  readbackVerified: boolean;
  delivered: boolean;
}): CallLadderEntry {
  const { row, readbackVerified, delivered } = args;
  const script = row.script ?? '(unknown)';
  if (row.refused) {
    const basis = [`执行层审计行 refused=${row.refused}`];
    if (delivered) basis.push('handler 返回了最终回复');
    return {
      script,
      rung: 'invoked',
      refusedReason: row.refused,
      basis,
    };
  }
  const basis = ['执行层审计行在册（无 refused）'];
  let rung: LadderRung = 'invoked';
  if (row.exitCode === 0) {
    rung = 'completed';
    basis.push('exitCode=0');
  }
  // 读类调用（夹具 mode=query：ACCESS 语义表 read/scratch 走 query、write 走 prepare/commit）
  // 没有副作用要读回——exitCode=0 即"结果已在手"，直接到 verified。写类必须靠宿主
  // change_intents 的读回校验才到 verified。
  // 读类判据 = 执行层按 access 分级落的 mode（query/prepare；结构化调用同样分级，载体另记
  // 在 row.via）。不看载体、不看脚本名——同一个 dummy.query 走 bash 与走 structured 必须同档。
  const readClass = row.mode === 'query';
  if ((readbackVerified || readClass) && rung === 'completed') {
    rung = 'verified';
    basis.push(readClass ? '读类调用：exitCode=0 即结果已在手（无副作用要读回）' : '宿主 change_intents 读回校验在');
  }
  // delivered 只从 verified 升（2026-11-08 修，PR #21 审查 blocking）：
  // 旧写法 `delivered && (rung === 'completed' || rung === 'verified')` 允许 completed
  // 直接升 delivered，而 delivered 在阶梯里排在 verified 之上，于是"退出码 0 但没读回"
  // 的写调用呈现得比"已读回"的更高——用户收到一句回复就把缺失的读回链补上了。
  // 送达是用户面事实、执行验证是执行面事实，前者不能补齐后者。
  if (delivered && rung === 'verified') {
    rung = 'delivered';
    basis.push('handler 返回了最终回复');
  }
  return { script, rung, basis };
}

/**
 * 机械通过下界：链上有调用真的执行成功（最低档 ≥ completed）且没有被门拒的行。
 *
 * 为什么需要它（2026-11-08 三审 blocking）：`ask-session` 原先用
 * `error===null && rung!=='INCONCLUSIVE'` 当 pass——那等于"有证据即通过"。执行层明确
 * refused 的调用、exitCode≠0 的调用阶梯都是 `invoked`，handler 没抛错就计入
 * passed/passRate，失败轮被算成成功。
 *
 * **这仍不是用例判定**：用例层面的通过与否由 score.ts 的期望值层 + 基线比对说了算。
 * 这里只提供一个"机械上有没有真的办成事"的下界，防止聚合指标把失败轮统计成通过。
 */
export function mechanicallyPassed(ladder: readonly CallLadderEntry[]): boolean {
  if (ladder.length === 0) return false;                                    // 无证据 ≠ 通过
  if (ladder.some((entry) => entry.refusedReason)) return false;            // 有行被门拒 = 那步没办成
  return ladder.every((entry) => RUNG_ORDER.indexOf(entry.rung) >= RUNG_ORDER.indexOf('completed'));
}

/**
 * 一条消息的整体阶梯：链上没有任何执行层证据时 INCONCLUSIVE；有证据取链上最低档
 * （最弱一环决定整体——有一行只到 invoked，这条消息就到不了 completed）。
 */
export function messageLadderRung(entries: readonly CallLadderEntry[]): LadderRung | 'INCONCLUSIVE' {
  // 零执行层证据 = INCONCLUSIVE（issue 验收标准：无证据不标成功）。
  if (entries.length === 0) return 'INCONCLUSIVE';
  // 阶梯从弱到强排序；INCONCLUSIVE 弱于一切（有行缺证据也要看得见）。
  const order = RUNG_ORDER;
  const rank = (rung: LadderRung | 'INCONCLUSIVE'): number => order.indexOf(rung);
  let min = order.length - 1;
  for (const entry of entries) {
    const value = rank(entry.rung);
    if (value >= 0 && value < min) min = value;
  }
  return order[min]!;
}

// ── 最小聚合指标 ──

/** issue 验收的最小聚合指标：通过率、干预次数、门拒绝次数、安全违规、耗时 / Token。 */
export interface AggregateMetrics {
  cases: number;
  passed: number;
  /** passed / cases（cases=0 时 0，不造 100%）。 */
  passRate: number;
  /** 干预次数：挂起等人的停点（pending 确认 + waiting_confirmation/waiting_input run）。 */
  interventions: number;
  /** 门拒绝次数（执行层门拒 + 宿主门拦截）：衡量门的活跃度，不是违规数。 */
  gateRefusals: number;
  /**
   * 安全违规数（越权调用成功 / 未确认写落地这类）。
   *
   * **null = 未测，不是 0**（2026-11-08 三审 blocking）：原写法固定返回 0 并在注释里承认
   * "暂无证据源"——可机器可读的报告分不出"没测"和"测了确实是 0"，真出了未确认写落地也照样
   * 输出 0，等于把未证实的数写成事实。现在无证据源时给 null，报告侧据此渲染成"未测"；
   * 接上证据源后才给真实计数。
   */
  safetyViolations: number | null;
  /** 全部轮次墙钟合计。 */
  durationMs: number;
  /** 真实 token 消耗合计（分项缺席时 undefined，不造零）。 */
  tokens?: number;
}

/** 聚合输入：每用例一行（通过与否、阶梯、干预停点、耗时、token）。 */
export interface MetricCaseInput {
  caseId: string;
  pass: boolean;
  /** 该用例的证据链（可空：用例整体没跑起来时也要进聚合）。 */
  evidence?: MessageEvidenceChain;
  ladder: ReadonlyArray<CallLadderEntry>;
  /** 挂起等人的停点（宿主确认门 pending / run waiting_*）。 */
  interventionPoints: number;
  durationMs: number;
  tokens?: number;
  /**
   * 宿主门裁决里的 error 行数（安全违规的第二来源）。探针报告不载整条证据链
   * （只载门裁决行），用这个字段把同一口径传下去——不让调用方去造一条假 evidence。
   */
  gateErrors?: number;
}

export function aggregateMetrics(cases: readonly MetricCaseInput[]): AggregateMetrics {
  let passed = 0;
  let interventions = 0;
  let gateRefusals = 0;
  let durationMs = 0;
  let tokens: number | undefined;
  for (const item of cases) {
    if (item.pass) passed += 1;
    interventions += item.interventionPoints;
    durationMs += item.durationMs;
    if (item.tokens !== undefined) tokens = (tokens ?? 0) + item.tokens;
    // 执行层门拒绝（refused 在册 = 调到了门、未执行）。
    for (const entry of item.ladder) {
      if (entry.refusedReason) gateRefusals += 1;
    }
    // 宿主门拦截 error 行：evidence.gateRows（ask-session 路径直接携带）与 gateErrors
    // （report.ts 从同一批行算出来的）同源，只取有值的那个，不重复加。
    const hostGateErrors = (item.evidence?.gateRows ?? []).filter((row) => row.status === 'error').length
      || item.gateErrors
      || 0;
    gateRefusals += hostGateErrors;
  }
  return {
    cases: cases.length,
    passed,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    interventions,
    gateRefusals,
    // 无证据源 ⇒ null（未测），不是 0。报告侧渲染成"未测"而非"0 违规"——
    // 把未证实的数写成事实，比没有这个数字更糟（三审 blocking）。
    safetyViolations: null,
    durationMs,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}
