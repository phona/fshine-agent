/**
 * 用户可见的失败话术（唯一来源）。
 *
 * 判据（owner 2026-11-19）：「这些东西告诉给用户，他啥都干不了，跟他说，他还不愿意看，也不知道
 * 怎么办」——所以用户侧只允许出现两件事：**发生了什么（业务语言）+ 他能做的事（一个动作）**。
 * 执行层原文、协议细节、内部术语（凭据/令牌/句柄/参数/能力清单/异步/接口/字段）只进日志与
 * 底账，**不进模型可见投影，更不进用户文本**。
 *
 * 分层：
 *   · `classifyFailure`：执行层错误码/状态 → 封闭的失败种类（业务语义，不看文案）；
 *   · `failureMessageFor`：种类 + 上下文（对象名等）→ 一句用户话术 + 一个动作 id；
 *   · 宿主侧故障（我们自己的 bug/传输问题）单独一类，话术**不解释内部原因**，只承认「我这边的问题」，
 *     并落一条给运维看的事件。
 *
 * 不做：不解析执行层文案判断语义（那是红线）；不在这里编造业务细节；未知码按「执行端这次没办成」
 * 收敛，原文留日志。
 */

/** 封闭的失败种类（业务语义；新增一种必须同时在话术表里给出动作）。 */
export type UserFacingFailureKind =
  /** 等用户确认（提案已生成）。 */
  | 'needs_confirmation'
  /** 缺用户提供的信息（集合名、窗口、字段等）。 */
  | 'needs_input'
  /** 对象不存在（集合/记录/文件）。 */
  | 'not_found'
  /** 权限或对象限制（执行层拒绝）。 */
  | 'denied'
  /** 条件/参数不符合业务口径（可换口径重试）。 */
  | 'invalid_input'
  /** 执行端这次没办成（业务原因不明，但不是我方故障）。 */
  | 'executor_failed'
  /** 我方（宿主/协议/传输）的问题；不向用户解释内部原因。 */
  | 'host_fault'
  /** 结果未知：做过没做完无法确认。 */
  | 'unknown_result'
  /** 等太久被判超时/卡住。 */
  | 'timed_out';

/** 用户能做的动作（话术必须落到其中一个；`none` 只用于纯陈述，不允许出现在失败话术里）。 */
export type UserFacingAction =
  | 'confirm'
  | 'provide_input'
  | 'retry'
  | 'change_scope'
  | 'check_status'
  | 'park'
  | 'none';

export interface UserFacingFailure {
  readonly kind: UserFacingFailureKind;
  /** 用户可见的一句话（业务语言；不含内部术语；带「大概/需要你…」这类可执行暗示）。 */
  readonly text: string;
  /** 用户可执行的动作（渲染层可据此给按钮/选项；至少一个）。 */
  readonly actions: readonly UserFacingAction[];
}

/**
 * 失败种类的**业务语言名**（2026-11-19 唤醒切片）：宿主喂给模型的失败事实里要带
 * 「归类后的 business 种类」——种类本身是封闭枚举（`classifyFailure` 的出口），这里给它一个
 * 人话名，模型据此说人话；即使被原样复述也不会把内部形态带给用户（`failureMessageFor` 是
 * 完整话术，这里只是分类名——两者不重叠，不是第二套话术表）。
 */
export const USER_FACING_FAILURE_KIND_LABEL: Readonly<Record<UserFacingFailureKind, string>> = {
  needs_confirmation: '要用户点头才敢做（写操作）',
  needs_input: '还差用户一句话',
  not_found: '找不到要操作的对象',
  denied: '权限或范围不允许',
  invalid_input: '条件或写法不符合口径',
  executor_failed: '没办成（业务原因不明）',
  host_fault: '我这边出了故障',
  unknown_result: '做没做完说不清（不要重复做）',
  timed_out: '等太久先停了',
};

/**
 * 执行层错误码 → 失败种类。只做**码表**归类（不看文案语义）；表外码一律 `executor_failed`。
 * 码名取自执行层契约（dummy/17dz 已用的稳定码），未知码不猜语义。
 */
const CODE_KIND: Readonly<Record<string, UserFacingFailureKind>> = {
  // 权限 / 对象限制
  GATE_REFUSE: 'denied',
  FORBIDDEN: 'denied',
  DENIED: 'denied',
  // 对象不存在
  COLLECTION_NOT_FOUND: 'not_found',
  RECORD_NOT_FOUND: 'not_found',
  FILE_NOT_FOUND: 'not_found',
  NOT_FOUND: 'not_found',
  // 条件/口径不对（可换口径）
  WHERE_INVALID: 'invalid_input',
  QUERY_REQUIRED: 'invalid_input',
  INVALID_ARGUMENT: 'invalid_input',
  INVALID_ARGS: 'invalid_input',
  INVALID_RECORDS: 'invalid_input',
  CALL_REFUSE: 'invalid_input',
  // 需要用户补充 / 确认
  NEEDS_INPUT: 'needs_input',
  CONFIRMATION_REQUIRED: 'needs_confirmation',
  // 执行端业务失败
  COLLECTION_FAULT: 'executor_failed',
  EXECUTOR_FAILED: 'executor_failed',
  // 结果未知（宿主/传输侧事实：如单次调用被传输超时截断——没有回执，不知道对方做没做完）。
  // 不得读作「已确认失败」，更不得引导重试（写操作可能已经生效）。
  result_unknown: 'unknown_result',
  // 我方故障（协议/凭据传递/内部不变量）——绝不向用户解释细节
  EXECUTION_PROTOCOL_VIOLATION: 'host_fault',
  CONFIRMATION_NOT_FOUND: 'host_fault',
  PROPOSAL_TOKEN_UNTRUSTED: 'host_fault',
  PROPOSAL_UNKNOWN_FIELD: 'host_fault',
  PROPOSAL_REFUSE: 'host_fault',
};

/**
 * 归类：优先看执行层码；没有码时看 outcome 状态（failed/refused/result_unknown）。
 * 已知的「我方故障码」优先于其它归类——用户侧不能出现「凭据/令牌」这类解释。
 */
export function classifyFailure(input: {
  code?: string | undefined;
  status?: 'failed' | 'refused' | 'result_unknown' | undefined;
}): UserFacingFailureKind {
  if (input.code !== undefined && input.code !== '') {
    const mapped = CODE_KIND[input.code];
    if (mapped !== undefined) return mapped;
  }
  if (input.status === 'result_unknown') return 'unknown_result';
  return 'executor_failed';
}

/**
 * 生成用户话术 + 动作。上下文只收业务名（集合/对象），不收内部标识（taskId/operation/句柄）。
 * 每个种类都必须给出至少一个动作——给不出动作的失败不该打扰用户（由调用方决定是否根本不发）。
 */
export function failureMessageFor(
  kind: UserFacingFailureKind,
  context: { subject?: string; missing?: readonly string[]; summary?: string } = {},
): UserFacingFailure {
  const subject = context.subject !== undefined && context.subject.trim() !== '' ? `「${context.subject}」` : '这件事';
  switch (kind) {
    case 'needs_confirmation':
      return {
        kind,
        text: context.summary !== undefined && context.summary !== ''
          ? `要写入：${context.summary}。回「确认」，还是算了？`
          : '这一步要你点个头。回「确认」，还是算了？',
        actions: ['confirm', 'park'],
      };
    case 'needs_input': {
      const missing = (context.missing ?? []).filter((item) => item.trim() !== '');
      return {
        kind,
        text: missing.length > 0
          ? `还差：${missing.join('、')}。给我就接着办。`
          : '还差一句话，我这次没拿到具体缺什么——你按业务说一下条件就行。',
        actions: ['provide_input'],
      };
    }
    case 'not_found':
      return { kind, text: `没找到${subject}。给我个准确的名字，或者我按别的范围再找？`, actions: ['retry', 'provide_input'] };
    case 'denied':
      return { kind, text: `${subject}没权限。换个对象，还是请管理员开通？`, actions: ['park', 'change_scope'] };
    case 'invalid_input':
      return { kind, text: '这个内容不行（名称或值的写法有问题）。我换个写法再试？', actions: ['retry', 'provide_input'] };
    case 'executor_failed':
      return { kind, text: '没办成。再试一次，还是先放着？', actions: ['retry', 'park'] };
    case 'host_fault':
      // 内部原因（凭据/令牌/协议/字段）一律不在这里解释——用户帮不上忙，也不该读这些。
      return { kind, text: '是我这边没弄好。再试一次，还是记下来让人看？', actions: ['retry', 'park'] };
    case 'unknown_result':
      return { kind, text: '不确定做没做完，先别重复。我帮你查一下现在的状态？', actions: ['check_status', 'park'] };
    case 'timed_out':
      return { kind, text: '等太久了，我先停了。重新办一次，还是先放着？', actions: ['retry', 'park'] };
  }
}

/**
 * 提案过期后重新提案的用户可见句子（2026-11-19 owner 口径修正）：句柄过期就过期，直接重提，
 * 不做恢复/续期机制。上半句宿主陈述，下半句复用 `failureMessageFor('needs_confirmation')`
 * 这条唯一提案卡来源（含真实摘要 + 两个动作）。
 */
export const CONFIRMATION_EXPIRED_NOTICE = '那份提案过期了，我重新给你一份。';

/** 拼接「过期了，重新给你一份」+ 既有提案卡（下半句唯一来源 = failureMessageFor）。 */
export function confirmationExpiredMessage(summary?: string): string {
  const card = failureMessageFor(
    'needs_confirmation',
    summary === undefined || summary.trim() === '' ? {} : { summary },
  ).text;
  return `${CONFIRMATION_EXPIRED_NOTICE}${card}`;
}

/**
 * 内部标识命中检测——**评测度量与告警用，不做运行时改写**。
 *
 * 为什么不是"运行时词表过滤"（owner 2026-11-19 质疑过，对的）：换个说法就漏、还会把正文
 * 切坏，本质是把确定性问题换成概率问题。真正的收口在数据面——
 *   · 事实型消息（失败/完成）**唤醒模型说**（2026-11-19 唤醒切片）：宿主只喂事实、投递模型
 *     写的话；模型回合挂掉时才投宿主兜底一句（照旧由此处的话术表出）；
 *   · 模型可见面里根本不放执行层原文（原文只进日志与底账；失败事实只带业务名 + 归类后的
 *     业务种类 + 机械原因）；
 *   · 风格（短、像人）归 agent.md。
 * 本函数只给黑盒 eval 与线上审计用：扫"用户可见文本"里是否出现内部形态，命中率目标 0，
 * 回归即红。它**不参与**任何发送路径。
 */
const INTERNAL_TERM_PATTERNS: readonly RegExp[] = [
  /执行层|执行端/,
  /确认凭据|凭据|令牌|句柄/,
  /能力清单|\boperation\b|dispatchKey|\bdk_\S+/i,
  /异步执行|长轮询|协议违约/,
  /参数(?:名)?|必填参数|可选参数|字段/,
  /task_[0-9a-f-]{8,}|file_[0-9a-f]{8,}/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /(?:^|[\s：:，（(「『])\/[^/\s]+\//,
];

/** 命中内部术语则返回命中的片段（供日志），否则 undefined。 */
export function internalTermIn(text: string): string | undefined {
  for (const pattern of INTERNAL_TERM_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit !== null) return hit[0];
  }
  return undefined;
}
