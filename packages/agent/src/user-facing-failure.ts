/**
 * 用户可见的失败话术（唯一来源）。
 *
 * 判据（owner 2026-11-19）：「这些东西告诉给用户，他啥都干不了，跟他说，他还不愿意看，也不知道
 * 怎么办」——所以用户侧只允许出现两件事：**发生了什么（业务语言）+ 他能做的事（一个动作）**。
 * 执行层原文、协议细节、内部术语（凭据/令牌/句柄/参数/能力清单/异步/接口/字段）只进日志与
 * 底账，**不进模型可见投影，更不进用户文本**。
 *
 * 分层（2026-11-24 删码表后）：
 *   · `failureMessageFor`：**宿主自己可判定**的档位 + 上下文 → 一句用户话术 + 一个动作 id；
 *   · 宿主侧故障（我们自己的协议/传输问题）单独一类，话术**不解释内部原因**。
 *
 * 不做（2026-11-24 owner 裁定，原 `classifyFailure` + `CODE_KIND` 已删）：不把执行层错误码
 * 归类成业务种类——「这是权限问题/对象不存在/口径不对」是执行层的语义，宿主复制一份码表就是
 * 越界。执行层的失败事实（code + 清洗后 message）原样进模型面，由模型说人话；用户面兜底只留
 * 通用一句 + 宿主自认的几个档位（结果未知 / 我方故障 / 零执行原因 / 提案卡 / 缺信息 / 参数形状）。
 */

/**
 * 兜底话术档位（2026-11-24 起只收**宿主自己能判定**的）：
 *   · needs_confirmation / needs_input：提案卡与缺什么（内容来自执行层 needs_* 事实，宿主只套句）；
 *   · invalid_input：宿主自己的 payload lint 拒绝（契约明文派给宿主）；
 *   · denied / unsupported：零执行机械原因（发起前被宿主拒 / 没有对应能力）；
 *   · unknown_result：宿主自己推导的「结果未知」状态；
 *   · host_fault：宿主自己的协议/传输码；
 *   · executor_failed：通用一句（执行层业务失败的兜底，不区分权限/对象/口径）。
 * 「对象不存在 / 口径不对 / 等太久」这类**执行层业务语义档位已删**——要区分就得复制执行层码表。
 */
export type UserFacingFailureKind =
  | 'needs_confirmation'
  | 'needs_input'
  | 'denied'
  | 'invalid_input'
  | 'executor_failed'
  | 'host_fault'
  | 'unknown_result';

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
 * 宿主**自认**的码（不是执行层业务语义表）：这三个码是宿主自己的协议/传输事实——
 * `result_unknown` 由宿主推导，`EXECUTION_PROTOCOL_VIOLATION` 由宿主自己写，
 * `CONFIRMATION_NOT_FOUND` 是执行层在说「你给的句柄我不认」（宿主侧协议问题）。
 * 其余码（执行层的业务失败）一律收敛通用档——不复制执行层码义，2026-11-24 owner 裁定。
 */
const HOST_OWNED_FAILURE_CODES: Readonly<Record<string, UserFacingFailureKind>> = {
  result_unknown: 'unknown_result',
  EXECUTION_PROTOCOL_VIOLATION: 'host_fault',
  CONFIRMATION_NOT_FOUND: 'host_fault',
};

/** 兜底选档：只认宿主自己的码；执行层业务失败一律通用「没办成」。 */
export function fallbackFailureKindOf(code: string | undefined): UserFacingFailureKind {
  if (code !== undefined && code !== '') {
    const own = HOST_OWNED_FAILURE_CODES[code];
    if (own !== undefined) return own;
  }
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
    case 'denied':
      return { kind, text: `${subject}没权限。换个对象，还是请管理员开通？`, actions: ['park', 'change_scope'] };
    case 'invalid_input':
      return { kind, text: '这个内容不行（名称或值的写法有问题）。我换个写法再试？', actions: ['retry', 'provide_input'] };
    case 'executor_failed':
      // 不写「再试一次」：结论机已删，宿主不知道这一笔是不是写、落没落——诱导重试可能双写。
      // 动作给中性的「重发 / 先核对」，由用户定。
      return { kind, text: '没办成。要重发，还是先核对？', actions: ['retry', 'park'] };
    case 'host_fault':
      // 内部原因（凭据/令牌/协议/字段）一律不在这里解释——用户帮不上忙，也不该读这些。
      return { kind, text: '是我这边没弄好。再试一次，还是记下来让人看？', actions: ['retry', 'park'] };
    case 'unknown_result':
      return { kind, text: '不确定做没做完，先别重复。我帮你查一下现在的状态？', actions: ['check_status', 'park'] };
  }
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
