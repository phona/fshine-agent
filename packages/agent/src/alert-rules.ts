/**
 * 运营告警规则（纯函数；仓内 ops 脚本的判定核心，不进产品运行时）。
 *
 * 为什么需要它：用户侧已经改成「静默到有结果」，出不出事必须由我们自己看得见。规则面
 * 只做两件事——把**一批结构化事实**（日志行 / 底账行的投影）判成告警项，并按
 * (rule, subject) 做冷却去重。它不读文件、不连网、不碰时钟：事实、`now`、冷却状态都由
 * 调用方（scripts/ops/alerts.ts）注入，因而可单测、可复现。
 *
 * 【回溯原始文本】：每条告警项都带 `raw`——被命中的**原始文本**（原始日志行 / 原始错误
 * 原文），**不截断**。告警只带摘要，真正能回到现场的是 `evidenceRef`（messageId / taskId /
 * 日志字节偏移 / 事件 id）+ `raw`。这是本模块的硬不变量：构造告警时只搬运原文，绝不改写、
 * 绝不裁剪（见 alert-rules.test.ts 的「证据含原文」用例与反向绊线）。
 *
 * 四条规则（阈值与判据集中在此，脚本与文档只引用，不另立口径）：
 *   · host_fault_reported —— 出现我方故障（执行失败分类为 host_fault、协议违约、确认句柄
 *     丢失等）≥1；
 *   · retry_storm         —— 同一任务执行事实 ≥5 条，或同一 (operation, 错误码) 在同一任务
 *     ≥3 次；
 *   · task_stuck          —— 任务 `running` 超 10 分钟无事件；`waiting_user` 超 30 分钟；
 *   · delivery_failed     —— 文件/结果投递失败 ≥1（`file_delivery` 状态非 sent、
 *     `task_result_delivery_failed`、通知投递终局 `notification_delivery_terminal` 的
 *     `exhausted`、长活提醒 `task_long_running_notice` 的 `failed`、**live 部署上的终态跳过**
 *     （`skipped` + `deliveryMode=live` = 渠道配置/路由配错，用户彻底收不到）；
 *     silent/unavailable 上的 skipped 是部署属性，不告警）。
 *
 * 去重：同一 `(rule, subject)` 在冷却窗口（缺省 30 分钟）内只出一次；冷却状态是可 JSON
 * 序列化的纯数据（`.runtime/ops/alerts-state.json` 持久化的正是它）。时间只从注入的 `now`
 * 取——绝不调用 Date.now()，保证「同样输入 + 同样 now」得到同样输出。
 */

/** 四条规则的身份。 */
export type AlertRule =
  | 'host_fault_reported'
  | 'retry_storm'
  | 'task_stuck'
  | 'delivery_failed';

/** 告警严重度（三条规则里我方故障与投递失败是对用户的直接伤害，判 higher）。 */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/** 每条规则的严重度（集中一处，脚本/文档不另立）。 */
export const ALERT_SEVERITY: Readonly<Record<AlertRule, AlertSeverity>> = {
  host_fault_reported: 'critical',
  delivery_failed: 'critical',
  retry_storm: 'warning',
  task_stuck: 'warning',
};

/** 任务 `running` 超过该时长无事件即判卡住（缺省 10 分钟）。 */
export const TASK_RUNNING_STUCK_MS = 10 * 60 * 1000;
/** 任务 `waiting_user` 超过该时长即判卡住（缺省 30 分钟）。 */
export const USER_WAITING_STUCK_MS = 30 * 60 * 1000;
/** 同一任务执行事实条数上限（达到即判重试风暴）。 */
export const RETRY_STORM_TASK_FACTS = 5;
/** 同一任务内同一 (operation, 错误码) 的重复次数上限（达到即判重试风暴）。 */
export const RETRY_STORM_OP_ERROR = 3;
/** 冷却窗口缺省值（毫秒）：同一 (rule, subject) 在此窗口内只告一次。 */
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/** 判定任务条数/操作重复这类聚合规则时要计入的执行事实事件名。 */
export const EXECUTION_FACT_EVENT = 'execution';
/** task_stuck 依赖的任务状态投影事件名。 */
export const TASK_STATE_EVENT = 'task_state';

/** 触发 host_fault_reported 的错误码集合（确认句柄丢失 / 协议违约）。 */
export const HOST_FAULT_ERROR_CODES: readonly string[] = [
  'CONFIRMATION_NOT_FOUND',
  'EXECUTION_PROTOCOL_VIOLATION',
];
/** 触发 host_fault_reported 的事件名集合（协议违约/装配缺陷在我方落 failed 时的事件）。 */
export const HOST_FAULT_EVENTS: readonly string[] = [
  'execution_accepted_undeclared',
  // 2026-11-19 唤醒切片（只读审计 #3）：后台任务以 accepted 结束、但装配没给等待端口
  // ——装配面缺陷（用户做不了什么，归宿第 3 档），落终态的同时记这条事件，进既有
  // host_fault 规则告警（不新建规则/机制）。
  'task_long_task_unsupported',
];

/**
 * 失败类结局集合：只有这些结局参与 retry_storm 的 `(operation, 错误码)` 重复计数。
 *
 * 为什么需要它：同一任务里对同一 operation 的多条**成功/待确认/受理**执行（例如按
 * W1/W2/无窗口各查一次 `dummy.query`，或对一个对象反复出提案 `needs_confirmation`）
 * 是合法业务形态，不是重试风暴。把它们当成「错误重复」是假阳性——2026-11-19 真部署
 * `--dry-run` 实测到两例：`dummy.query`（3× completed）、`dummy.prepare`（3× needs_confirmation）
 * 都被 "(无错误码) 重复 3 次" 误报。
 *
 * 判据只认失败类结局：`failed`（含 `result_unknown` 这类失败码）/ `refused` / `unknown`
 * （执行层无法确认，也不当成功）/ `timed_out`。`completed` / `needs_confirmation` /
 * `accepted` / `needs_input` 一律不参与；**无错误码时也必须有失败状态才算一条**。
 */
export const FAILURE_EXECUTION_STATUSES: readonly string[] = [
  'failed',
  'refused',
  'unknown',
  'timed_out',
];

/** 执行事实是否失败类结局（无状态 = 未知，不参与计数：宁可漏报也不误报）。 */
export function isFailureExecution(fact: AlertFact): boolean {
  const status = fact.detail?.status;
  return status !== undefined && FAILURE_EXECUTION_STATUSES.includes(status);
}

/**
 * 结构化事实的投影明细（日志行 / 底账行按需带字段；缺省字段 = 未知，不作猜测）。
 */
export interface AlertFactDetail {
  /** 执行事实：操作名。 */
  operation?: string;
  /** 执行事实：错误码。 */
  errorCode?: string;
  /** 执行事实：结局状态（'failed' / 'refused' / 'completed' / 'needs_confirmation' / …）。 */
  status?: string;
  /** 执行事实：失败分类（如 'host_fault'）。 */
  failureKind?: string;
  /** 投递事实：投递状态（'sent' / 'delivery_failed' / …）。 */
  deliveryStatus?: string;
  /**
   * 投递结果（2026-11-19 第 3 档接线）：`notification_delivery_terminal` 的
   * `'exhausted'`（失败到 attempts 上限）/ `'skipped'`（终态跳过），`task_long_running_notice`
   * 的 `'sent'` / `'failed'`。判据见 isDeliveryFailure——不猜缺省值。
   */
  deliveryResult?: string;
  /**
   * 部署模式事实（2026-11-19 owner 裁定；只随终态跳过带）：`'live'` / `'silent'` /
   * `'unavailable'`。判据：live 上的终态跳过 = 配错，要告警（见 isDeliveryFailure）。
   */
  deliveryMode?: string;
  /** 任务状态投影：'running' / 'waiting_user' / …。 */
  taskStatus?: string;
  /** 协议违约标记（执行层对未声明 long_running 的 operation 返回 accepted）。 */
  protocolViolation?: boolean;
  /** 确认句柄丢失标记。 */
  confirmationLost?: boolean;
}

/**
 * 一条结构化事实。调用方（脚本）负责把原始日志行 / 底账行投影成这个形状；
 * `raw` 必须是被命中的**原始文本**（不截断），`at` 是事实时刻（ISO）。
 */
export interface AlertFact {
  /** 事实来源：'log' = 结构化日志行；'ledger' = 底账行。 */
  source: 'log' | 'ledger';
  /** 事件/行类型，如 'file_delivery' / 'task_result_delivery_failed' / 'execution' / 'task_state'。 */
  event: string;
  /** 事实时刻（ISO 字符串）。task_stuck 据它与 now 算时长。 */
  at: string;
  /** 被命中的原始文本（原始日志行 / 原始错误原文），**不截断**。 */
  raw: string;
  /** 任务归属（可缺省）。 */
  taskId?: string;
  /** 主体归属（可缺省）。 */
  principalId?: string;
  /** 会话归属（可缺省）。 */
  sessionId?: string;
  /** 消息 id（可回溯键之一）。 */
  messageId?: string;
  /** 日志字节偏移（可回溯键之一）。 */
  logOffset?: number;
  /** 显式回溯键；缺省按 task/message/log/event 派生。 */
  evidenceRef?: string;
  /** 结构化明细。 */
  detail?: AlertFactDetail;
}

/** 一条告警项。 */
export interface AlertItem {
  rule: AlertRule;
  severity: AlertSeverity;
  /** 同一 rule 下去重的键（任务 / 会话 / 全局）。 */
  subject: string;
  /** 回到原始现场的键（messageId / taskId / 日志偏移 / 事件 id）。 */
  evidenceRef: string;
  /** 人读摘要（不长于一段；原文在 raw）。 */
  summary: string;
  /** 被命中的原始文本（不截断）。 */
  raw: string;
  /** 本次判定的时刻（ISO）。 */
  at: string;
  /**
   * 任务归属（可缺省）：从命中的事实搬运，供持久化行做结构化消费（AI/人回溯）。
   * 不是新的去重键——去重仍按 (rule, subject)；这里只是把事实里已有的 taskId 带出来。
   */
  taskId?: string;
}

/** 冷却状态：`${rule}\u0000${subject}` → 上次告警时刻（ISO）。可 JSON 序列化后持久化。 */
export type AlertCooldownState = Readonly<Record<string, string>>;

export interface EvaluateAlertsOptions {
  /** 判定时刻（注入；不取系统时钟）。 */
  now: Date;
  /** 冷却窗口（毫秒）；缺省 DEFAULT_COOLDOWN_MS。 */
  cooldownMs?: number;
  /** 既有的冷却状态（来自持久化文件）；缺省空。 */
  cooldownState?: AlertCooldownState;
}

export interface EvaluateAlertsResult {
  /** 本次应发出的告警（已过冷却过滤）。 */
  alerts: AlertItem[];
  /** 更新后的冷却状态（调用方负责持久化）。 */
  cooldownState: AlertCooldownState;
}

/** 冷却键：rule + subject（\u0000 分隔，避免拼接歧义）。 */
export function cooldownKey(rule: AlertRule, subject: string): string {
  return `${rule}\u0000${subject}`;
}

/** 事实时刻解析（ISO → ms）；非法/缺省返回 undefined（按未知处理，不猜）。 */
function timeMsOf(fact: AlertFact): number | undefined {
  const ms = Date.parse(fact.at);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 回溯键：显式优先，否则按 task → message → log → event 派生。 */
export function evidenceRefOf(fact: AlertFact): string {
  if (fact.evidenceRef !== undefined && fact.evidenceRef !== '') return fact.evidenceRef;
  if (fact.taskId !== undefined && fact.taskId !== '') return `task:${fact.taskId}`;
  if (fact.messageId !== undefined && fact.messageId !== '') return `msg:${fact.messageId}`;
  if (fact.logOffset !== undefined) return `log@${fact.logOffset}`;
  return `event:${fact.event}`;
}

/** 归属主体：task → session → principal → 全局（同一 rule 下去重的键）。 */
export function subjectOf(fact: AlertFact, scope: 'task' | 'session' | 'event' = 'task'): string {
  if (scope === 'event') return `event:${fact.event}`;
  if (fact.taskId !== undefined && fact.taskId !== '') return `task:${fact.taskId}`;
  if (scope === 'session' && fact.sessionId !== undefined && fact.sessionId !== '') return `session:${fact.sessionId}`;
  if (fact.sessionId !== undefined && fact.sessionId !== '') return `session:${fact.sessionId}`;
  if (fact.principalId !== undefined && fact.principalId !== '') return `principal:${fact.principalId}`;
  return 'global';
}

/** 事实是否我方故障（host_fault_reported）。 */
export function isHostFault(fact: AlertFact): boolean {
  if (fact.detail?.failureKind === 'host_fault') return true;
  if (fact.detail?.protocolViolation === true) return true;
  if (fact.detail?.confirmationLost === true) return true;
  if (HOST_FAULT_EVENTS.includes(fact.event)) return true;
  const code = fact.detail?.errorCode;
  return code !== undefined && HOST_FAULT_ERROR_CODES.includes(code);
}

/** 事实是否是执行事实（retry_storm 计数单位）。 */
export function isExecutionFact(fact: AlertFact): boolean {
  return fact.event === EXECUTION_FACT_EVENT;
}

/** 事实是否是投递失败（delivery_failed）。 */
export function isDeliveryFailure(fact: AlertFact): boolean {
  if (fact.event === 'task_result_delivery_failed') return true;
  // 2026-11-19 第 3 档接线：**投递终局且未送达**才算失败——
  //   · `notification_delivery_terminal` 的 `exhausted`（失败到 attempts 上限：用户最终没收到）；
  //     终态跳过（skipped = 没有东西要发 / 永不可能送达）**不告警**（静默部署上每条都 skipped，
  //     告警就成了噪音，且开发也做不了什么）；
  //   · 长活提醒 `task_long_running_notice` 的 `failed`（渠道故障，用户没收到那条提醒）。
  if (fact.event === 'notification_delivery_terminal') {
    if (fact.detail?.deliveryResult === 'exhausted') return true;
    // owner 裁定（2026-11-19）：**按部署模式切**——live 部署上出现终态跳过 = 渠道配置/路由
    // 配错，用户那边表现为「彻底收不到任何消息」（最该死的黑盒），必须有人看见；
    // silent / unavailable 是部署属性（静默部署上每条都 skipped），不告警。
    return fact.detail?.deliveryResult === 'skipped' && fact.detail?.deliveryMode === 'live';
  }
  if (fact.event === 'task_long_running_notice') return fact.detail?.deliveryResult === 'failed';
  if (fact.event !== 'file_delivery') return false;
  const status = fact.detail?.deliveryStatus;
  // `file_delivery` 状态非 sent 即判投递失败（缺省字段 = 未知，不判）。
  return status !== undefined && status !== 'sent';
}

/** 把一组事实的原文拼成一段（不截断；用换行分隔，原样保留每条）。 */
function joinRaws(facts: readonly AlertFact[]): string {
  return facts.map((f) => f.raw).join('\n');
}

/** 分钟数（向下取整；用于摘要文案）。 */
function minutesOf(ms: number): number {
  return Math.floor(ms / 60_000);
}

/** 内部候选告警（未过冷却）。 */
interface Candidate {
  rule: AlertRule;
  subject: string;
  evidenceRef: string;
  summary: string;
  raw: string;
  /** 命中事实的任务归属（取第一条非空 taskId）；无归属时缺省。 */
  taskId?: string;
}

/** 从一组命中事实里取任务归属（第一条非空 taskId）；没有则 undefined。 */
function taskIdOf(facts: readonly AlertFact[]): string | undefined {
  return facts.find((fact) => fact.taskId !== undefined && fact.taskId !== '')?.taskId;
}

function hostFaultCandidates(facts: readonly AlertFact[]): Candidate[] {
  const out: Candidate[] = [];
  const bySubject = new Map<string, AlertFact[]>();
  for (const fact of facts) {
    if (!isHostFault(fact)) continue;
    const subject = subjectOf(fact, 'task');
    const bucket = bySubject.get(subject);
    if (bucket === undefined) bySubject.set(subject, [fact]);
    else bucket.push(fact);
  }
  for (const [subject, bucket] of bySubject) {
    const first = bucket[0]!;
    const events = [...new Set(bucket.map((f) => f.event))].join('、');
    out.push({
      rule: 'host_fault_reported',
      subject,
      evidenceRef: evidenceRefOf(first),
      summary: `我方故障（${events}）${subject === 'global' ? '' : `，归属 ${subject}`}`,
      raw: joinRaws(bucket),
      ...(taskIdOf(bucket) === undefined ? {} : { taskId: taskIdOf(bucket) }),
    });
  }
  return out;
}

function retryStormCandidates(facts: readonly AlertFact[]): Candidate[] {
  const executions = facts.filter(isExecutionFact);
  if (executions.length === 0) return [];
  const out: Candidate[] = [];

  // (a) 同一任务执行事实 ≥ RETRY_STORM_TASK_FACTS。
  const byTask = new Map<string, AlertFact[]>();
  for (const fact of executions) {
    if (fact.taskId === undefined || fact.taskId === '') continue;
    const bucket = byTask.get(fact.taskId);
    if (bucket === undefined) byTask.set(fact.taskId, [fact]);
    else bucket.push(fact);
  }
  for (const [taskId, bucket] of byTask) {
    if (bucket.length < RETRY_STORM_TASK_FACTS) continue;
    out.push({
      rule: 'retry_storm',
      subject: `task:${taskId}`,
      evidenceRef: evidenceRefOf(bucket[0]!),
      summary: `重试风暴：任务 ${taskId} 执行事实 ${bucket.length} 条（阈值 ${RETRY_STORM_TASK_FACTS}）`,
      raw: joinRaws(bucket),
      taskId,
    });
  }

  // (b) 同一 (operation, 错误码) 在同一任务 ≥ RETRY_STORM_OP_ERROR。
  //     只计失败类结局：成功/待确认/受理等合法重复（如按窗口各查一次、反复出提案）不算
  //     重试风暴；无错误码时也必须有失败状态才算一条（isFailureExecution）。
  const byOpError = new Map<string, { taskId: string; entry: AlertFact[] }>();
  for (const fact of executions) {
    if (fact.taskId === undefined || fact.taskId === '') continue;
    if (!isFailureExecution(fact)) continue; // 非失败类结局不参与
    const operation = fact.detail?.operation;
    if (operation === undefined || operation === '') continue;
    const code = fact.detail?.errorCode ?? '(无错误码)';
    const key = `${fact.taskId}\u0000${operation}\u0000${code}`;
    const found = byOpError.get(key);
    if (found === undefined) byOpError.set(key, { taskId: fact.taskId, entry: [fact] });
    else found.entry.push(fact);
  }
  for (const [key, { taskId, entry }] of byOpError) {
    if (entry.length < RETRY_STORM_OP_ERROR) continue;
    const [, operation, code] = key.split('\u0000');
    out.push({
      rule: 'retry_storm',
      subject: `task:${taskId}`,
      evidenceRef: evidenceRefOf(entry[0]!),
      summary: `重试风暴：任务 ${taskId} 操作 ${operation} 错误 ${code} 重复 ${entry.length} 次（阈值 ${RETRY_STORM_OP_ERROR}）`,
      raw: joinRaws(entry),
      taskId,
    });
  }
  return out;
}

function taskStuckCandidates(facts: readonly AlertFact[], nowMs: number): Candidate[] {
  const out: Candidate[] = [];
  for (const fact of facts) {
    if (fact.event !== TASK_STATE_EVENT) continue;
    const status = fact.detail?.taskStatus;
    const atMs = timeMsOf(fact);
    if (status === undefined || atMs === undefined) continue;
    const elapsed = nowMs - atMs;
    // 边界：刚好到阈值不告（严格大于才告）——「刚好 10 分钟不告、10 分 1 秒告」。
    if (status === 'running' && elapsed > TASK_RUNNING_STUCK_MS) {
      out.push({
        rule: 'task_stuck',
        subject: subjectOf(fact, 'task'),
        evidenceRef: evidenceRefOf(fact),
        summary: `任务卡住：${fact.taskId ?? '未知任务'} 处于 running 已 ${minutesOf(elapsed)} 分钟无事件（阈值 ${minutesOf(TASK_RUNNING_STUCK_MS)} 分钟）`,
        raw: fact.raw,
        ...(fact.taskId === undefined ? {} : { taskId: fact.taskId }),
      });
    } else if (status === 'waiting_user' && elapsed > USER_WAITING_STUCK_MS) {
      out.push({
        rule: 'task_stuck',
        subject: subjectOf(fact, 'task'),
        evidenceRef: evidenceRefOf(fact),
        summary: `任务卡住：${fact.taskId ?? '未知任务'} 处于 waiting_user 已 ${minutesOf(elapsed)} 分钟（阈值 ${minutesOf(USER_WAITING_STUCK_MS)} 分钟）`,
        raw: fact.raw,
        ...(fact.taskId === undefined ? {} : { taskId: fact.taskId }),
      });
    }
  }
  return out;
}

function deliveryFailedCandidates(facts: readonly AlertFact[]): Candidate[] {
  const out: Candidate[] = [];
  const bySubject = new Map<string, AlertFact[]>();
  for (const fact of facts) {
    if (!isDeliveryFailure(fact)) continue;
    const subject = subjectOf(fact, 'session');
    const bucket = bySubject.get(subject);
    if (bucket === undefined) bySubject.set(subject, [fact]);
    else bucket.push(fact);
  }
  for (const [subject, bucket] of bySubject) {
    const first = bucket[0]!;
    const events = [...new Set(bucket.map((f) => f.event))].join('、');
    out.push({
      rule: 'delivery_failed',
      subject,
      evidenceRef: evidenceRefOf(first),
      summary: `投递失败（${events}）${subject === 'global' ? '' : `，归属 ${subject}`}`,
      raw: joinRaws(bucket),
      ...(taskIdOf(bucket) === undefined ? {} : { taskId: taskIdOf(bucket) }),
    });
  }
  return out;
}

/** 全部候选（无冷却）。顺序稳定：规则固定序 → subject 字典序。 */
function allCandidates(facts: readonly AlertFact[], nowMs: number): Candidate[] {
  const candidates: Candidate[] = [
    ...hostFaultCandidates(facts),
    ...retryStormCandidates(facts),
    ...taskStuckCandidates(facts, nowMs),
    ...deliveryFailedCandidates(facts),
  ];
  return candidates.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return 0;
  });
}

/**
 * 判定 + 冷却过滤。纯函数：同样 (facts, now, cooldownState) 得到同样输出；
 * 不读文件、不连网、不取系统时钟。
 */
export function evaluateAlerts(
  facts: readonly AlertFact[],
  options: EvaluateAlertsOptions,
): EvaluateAlertsResult {
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const prev = options.cooldownState ?? {};
  const nowMs = options.now.getTime();
  const nowIso = options.now.toISOString();
  const next: Record<string, string> = { ...prev };
  const alerts: AlertItem[] = [];

  for (const candidate of allCandidates(facts, nowMs)) {
    const key = cooldownKey(candidate.rule, candidate.subject);
    const last = prev[key];
    if (last !== undefined) {
      const lastMs = Date.parse(last);
      if (!Number.isNaN(lastMs) && nowMs - lastMs < cooldownMs) continue; // 冷却内不重复
    }
    next[key] = nowIso;
    alerts.push({
      rule: candidate.rule,
      severity: ALERT_SEVERITY[candidate.rule],
      subject: candidate.subject,
      evidenceRef: candidate.evidenceRef,
      summary: candidate.summary,
      raw: candidate.raw,
      at: nowIso,
      ...(candidate.taskId === undefined ? {} : { taskId: candidate.taskId }),
    });
  }

  return { alerts, cooldownState: next };
}
