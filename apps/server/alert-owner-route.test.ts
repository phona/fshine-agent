/**
 * ops 告警 owner 路由推导（2026-11-21 live P1）· 确定性单测。
 *
 * live 根因：main.ts 曾按 `Object.entries(config.principals)` 的**配置顺序**取第一个
 * enabled 单聊主体当 owner 路由——本部署清单第一位是评测夹具主体 `wecom:e2e_user`
 * （不是真实 chatid），告警推送（aibot_send_msg）恒 93006 invalid chatid，告警永远
 * 送不到人（.runtime/server/wecom-live.log 与 live-3 日志中 7 次 93006 全部是
 * alert_push_failed；同 chatid 的任务唤醒推送全部成功）。
 *
 * 钉住的语义：owner 路由是**部署事实**，只认显式配置（yaml `alerts.ownerPrincipalId`）；
 * 配置缺失 = 只落盘不推（不猜 chatId）；配置了但主体不存在/未启用/群主体/非企微 = fail-fast
 * （拼错的旋钮不允许被默认值吞掉，与 runtime 段同一口径）。
 */
import { describe, expect, it } from 'vitest';
import { resolveAlertOwnerRoute } from './alert-owner-route';

const principals = {
  'wecom:real-user': { enabled: true },
  'wecom:e2e_user': { enabled: true },
  'wecom:disabled-user': { enabled: false },
  'wecom:group:ops-w': { enabled: true },
  'feishu:someone': { enabled: true },
};

describe('resolveAlertOwnerRoute：owner 路由只认显式配置，不猜', () => {
  it('配置了真实单聊主体 → 路由 = 该主体的会话（conversationId = userid）', () => {
    const route = resolveAlertOwnerRoute({
      alerts: { ownerPrincipalId: 'wecom:real-user' },
      principals,
    });
    expect(route).toEqual({ channel: 'wecom', conversationId: 'real-user' });
  });

  it('未配置（缺段/缺键/空串）→ undefined：告警只落盘不推，绝不从主体清单顺序猜', () => {
    expect(resolveAlertOwnerRoute({ principals })).toBeUndefined();
    expect(resolveAlertOwnerRoute({ alerts: {}, principals })).toBeUndefined();
    expect(resolveAlertOwnerRoute({ alerts: { ownerPrincipalId: '' }, principals })).toBeUndefined();
    expect(resolveAlertOwnerRoute({ alerts: { ownerPrincipalId: '   ' }, principals })).toBeUndefined();
  });

  it('主体不存在 → throw（配置错误 fail-fast，不静默不推送）', () => {
    expect(() => resolveAlertOwnerRoute({
      alerts: { ownerPrincipalId: 'wecom:no-such-user' },
      principals,
    })).toThrow(/no-such-user/);
  });

  it('主体未启用 → throw', () => {
    expect(() => resolveAlertOwnerRoute({
      alerts: { ownerPrincipalId: 'wecom:disabled-user' },
      principals,
    })).toThrow(/disabled-user/);
  });

  it('群主体 → throw（告警文本含任务事实，不进群；群不是 ops owner 通道）', () => {
    expect(() => resolveAlertOwnerRoute({
      alerts: { ownerPrincipalId: 'wecom:group:ops-w' },
      principals,
    })).toThrow(/group/);
  });

  it('非企微主体 → throw（告警推送面是企微单聊，路由渠道推不出去）', () => {
    expect(() => resolveAlertOwnerRoute({
      alerts: { ownerPrincipalId: 'feishu:someone' },
      principals,
    })).toThrow(/feishu/);
  });
});
