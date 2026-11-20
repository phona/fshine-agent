/**
 * ops 告警 owner 路由推导（2026-11-21 live P1 的路由推导单点）。
 *
 * live 根因：main.ts 曾按 `Object.entries(config.principals)` 的**配置顺序**取第一个
 * enabled 单聊主体当告警 owner 路由——本部署清单第一位是评测夹具主体 `wecom:e2e_user`
 * （不是真实 chatid），告警推送（aibot_send_msg）恒 93006 invalid chatid，告警永远送
 * 不到人（wecom-live.log / live-3 中 7 次 93006 全部是 alert_push_failed；同 chatid 的
 * 任务唤醒推送全部成功）。配置顺序不是部署事实，是巧合。
 *
 * 单点口径：owner 路由只认显式配置（yaml `alerts.ownerPrincipalId`，指向 principals
 * 里的**单聊企微主体**）；未配置 = 只落盘不推（不猜 chatId——告警通道静默缺失由
 * ops/alerts 落盘面兜住，拼错主体宁可启动失败）；配置了但不合法 = fail-fast。
 * 告警文本含任务事实（subject/raw），群主体不是 ops 通道，一律拒绝。
 */
import type { ChannelRoute } from '@fshine/contracts';

export interface AlertOwnerRouteInput {
  /** yaml `alerts` 段（loadConfig 解析；缺段 = undefined）。 */
  alerts?: { ownerPrincipalId?: string };
  /** 主体清单（AppConfig.principals）：键 = principalId，值含 enabled 档位。 */
  principals: Record<string, { enabled?: boolean } | undefined>;
}

/**
 * 推导告警推送路由：配置了合法的单聊企微主体 → `{ channel:'wecom', conversationId }`；
 * 未配置 → undefined（只落盘不推）；配置了但不合法（不存在/未启用/群主体/非企微）→
 * throw（配置错误必须在装配时炸出来，不允许静默降级成「告警永远没人收到」）。
 */
export function resolveAlertOwnerRoute(input: AlertOwnerRouteInput): ChannelRoute | undefined {
  const ownerPrincipalId = input.alerts?.ownerPrincipalId?.trim();
  if (ownerPrincipalId === undefined || ownerPrincipalId === '') return undefined;
  const principal = input.principals[ownerPrincipalId];
  if (principal === undefined) {
    throw new Error(`alerts.ownerPrincipalId 指向不存在的主体「${ownerPrincipalId}」（principals 里没有这一键）。`);
  }
  if (principal.enabled !== true) {
    throw new Error(`alerts.ownerPrincipalId 指向的主体「${ownerPrincipalId}」未启用（enabled !== true）。`);
  }
  if (!ownerPrincipalId.startsWith('wecom:') || ownerPrincipalId.startsWith('wecom:group:')) {
    throw new Error(
      `alerts.ownerPrincipalId 必须是企微**单聊**主体（wecom:<userid>），得到「${ownerPrincipalId}」`
      + '（告警文本含任务事实，不进群；非企微主体没有可用的告警推送面）。',
    );
  }
  // principalId = `wecom:<userid>`（单聊主体的会话键；服务端 inbound 以同一形状构造）。
  const conversationId = ownerPrincipalId.slice('wecom:'.length);
  return { channel: 'wecom', conversationId };
}
