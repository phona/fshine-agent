/**
 * R5 通知文案渲染（纯函数；零数据库/渠道依赖）。
 *
 * 规则（owner 授权文案层）：
 *   · 9 类 kind 折叠成 4 类用户语言：开始办了 / 需要你一句话 / 办完了·没办成 / 已按你说的停了；
 *     2026-11-19 唤醒切片起：**失败与「用户说停」由唤醒出口让模型说**，这里的对应文案只作
 *     「模型回合挂掉」的降级兜底（见 server 的 wakeStateChangeText 与 chat sink 的 wakeCancelled）；
 *   · reason 人话映射且失败分级：result_unknown 必须说「不确定做没做完，需要再确认」（严禁读作成功）；
 *   · 内部术语黑名单机械断言：渲染器拼装的文本不得含 task_status/resource_limited/requestId/
 *     uuid/request_N/绝对路径/W 窗口码（name 与写确认 summary 都是执行层/用户原话，按规则原样
 *     保留，不在断言范围）；
 *   · 每条输出必含 name（缺省机械回落「未命名任务」）。
 */
import type { NotificationKind, NotificationPayload, NotificationReason } from './notifications';

/** 黑名单违规（渲染器拼装了内部术语）：拒绝输出。 */
export class NotificationLanguageError extends Error {
  constructor(term: string) {
    super(`通知文案含内部术语「${term}」：渲染器不得输出内部形态。`);
    this.name = 'NotificationLanguageError';
  }
}

const BLACKLIST: readonly RegExp[] = [
  /task_status/i,
  /resource_limited/i,
  /requestId/i,
  /request_\d+/i,
  // U3：逻辑操作身份是内部术语，通知文案不得泄露（键形如 dk_<scope>:<seq>）。
  /dispatchKey/i,
  /\bdk_\S+/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /(?:^|[\s：:，（(「『])\/[^/\s]+\//,
  /\bW\d+\b/,
  // 任务编号属工单腔（用户可见面不得出现内部形态）：`#N` 形状与「编号 N」模板产物一律拒绝。
  /#\d+/,
  /编号\s*\d+/,
];

/** 机械断言：文本不得含内部术语（黑名单见上）。 */
export function assertUserLanguage(text: string): void {
  for (const pattern of BLACKLIST) {
    const hit = pattern.exec(text);
    if (hit !== null) throw new NotificationLanguageError(hit[0]);
  }
}

const NAME_PLACEHOLDER = '\u0000name\u0000';

/** reason → 用户语言（失败分级；result_unknown 不读作成功）。 */
const REASON_TEXT: Record<NotificationReason, string> = {
  result_unknown: '不确定做没做完，需要再确认',
  resource_limited: '系统太忙，这个没接',
  timeout: '跑太久先停了',
  cancelled_by_user: '已按你说的停了',
  failed_confirmed: '没办成',
};

/** name 用户原话占位替换后的模板先行黑名单断言，再回填 name。 */
function assemble(template: string, name: string): string {
  assertUserLanguage(template);
  return template.split(NAME_PLACEHOLDER).join(name);
}

/** 一条通知 → 用户语言字符串（kind 9→4 折叠；输入仅 payload 白名单字段）。 */
export function renderNotification(input: { kind: NotificationKind; payload: NotificationPayload }): string {
  const name = input.payload.name !== undefined && input.payload.name.trim() !== ''
    ? input.payload.name
    : '未命名任务';
  const reason = input.payload.reason;
  const missing = input.payload.missing ?? [];
  switch (input.kind) {
    case 'accepted':
    case 'started':
    case 'resumed':
      return assemble(`开始办了：${NAME_PLACEHOLDER}。`, name);
    case 'waiting_user': {
      // 写确认：执行层已冻结一次待确认操作，用户要决定的是「做不做」——先把将写入什么
      // （执行层原话摘要）说清，再给两个能做的动作。无摘要 = 缺信息类等待，照旧说缺什么。
      const summary = input.payload.summary;
      if (summary !== undefined && summary.trim() !== '') {
        return assemble(`要写入：${summary}。回「确认」我就提交，回「不」我就不动。`, name);
      }
      return assemble(
        `需要你一句话：${NAME_PLACEHOLDER}——还缺：${missing.length > 0 ? missing.join('、') : '未说明'}。`,
        name,
      );
    }
    case 'completed':
      return assemble(`办完了：${NAME_PLACEHOLDER}。`, name);
    case 'failed':
      return assemble(`${REASON_TEXT[reason ?? 'failed_confirmed']}：${NAME_PLACEHOLDER}。`, name);
    case 'timed_out':
      return assemble(`${REASON_TEXT.timeout}：${NAME_PLACEHOLDER}。`, name);
    case 'resource_limited':
      return resourceLimitedText(name);
    case 'cancelled':
      return assemble(`${REASON_TEXT.cancelled_by_user}：${NAME_PLACEHOLDER}。`, name);
  }
}

/**
 * 资源受限（池满/队列满的确定性拒绝）的既有用户文案——渲染器是唯一来源；失败降级出口
 * 对「reason=resource_limited 的失败」复用同一句（2026-11-19 只读审计 #18：此前那类失败
 * 在模型沉默时拿到的是「没办成。再试一次，还是先放着？」——不是这件事的实话）。
 * 尾句 = 既有动作句（「再试一次，还是先放着？」的等一会儿版：资源受限的实话是等一下，
 * 不是立刻重试）——owner 的归宿规则要求「一句话 + 一个动作」，资源类失败落在「告诉用户」档。
 */
export function resourceLimitedText(name?: string): string {
  const subject = name !== undefined && name.trim() !== '' ? name : '未命名任务';
  return assemble(`${REASON_TEXT.resource_limited}：${NAME_PLACEHOLDER}。等一会儿再试一次，还是先放着？`, subject);
}
