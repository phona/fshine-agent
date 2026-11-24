/**
 * R5 通知文案渲染（纯函数；先红后绿）。
 *
 * 覆盖：
 *   ① 9 类 kind 折叠成 4 类用户语言（开始办了 / 需要你一句话 / 办完了·没办成 / 已按你说的停了）；
 *   ② reason 人话映射且失败分级：result_unknown 必须说「不确定做没做完，需要再确认」，
 *     严禁读作成功；resource_limited / timeout 各自的人话；
 *   ③ 内部术语黑名单机械断言：task_status / resource_limited / requestId / uuid / 绝对路径 / W 窗口码；
 *   ④ 每条输出必含 name（用户原话；缺省机械回落）。
 * 零数据库依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  NotificationLanguageError,
  assertUserLanguage,
  renderNotification,
} from './src/notification-render';
import { NOTIFICATION_KINDS, type NotificationKind, type NotificationPayload } from './src/notifications';

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return { at: '2026-11-15T08:00:00.000Z', taskNo: 1, name: '查十一月的发票', ...overrides };
}

describe('R5 文案渲染：9 类折叠成 4 类用户语言', () => {
  it('accepted/started/resumed → 开始办了（每条含 name）', () => {
    for (const kind of ['accepted', 'started', 'resumed'] as const) {
      const text = renderNotification({ kind, payload: payload() });
      expect(text).toContain('开始办了');
      expect(text).toContain('查十一月的发票');
      expect(text).not.toContain('办完了');
      expect(text).not.toContain('需要你一句话');
    }
  });

  it('waiting_user → 需要你一句话（缺什么来自 payload.missing）', () => {
    const text = renderNotification({
      kind: 'waiting_user',
      payload: payload({ missing: ['开票日期', '金额'] }),
    });
    expect(text).toContain('需要你一句话');
    expect(text).toContain('开票日期、金额');
    expect(text).toContain('查十一月的发票');
  });

  it('没有 completed/failed 结论类（2026-11-23 删状态机轮）：7 类只剩事件/通知意图', () => {
    expect(NOTIFICATION_KINDS).not.toContain('completed');
    expect(NOTIFICATION_KINDS).not.toContain('failed');
  });

  it('timed_out → 跑太久先停了', () => {
    const text = renderNotification({ kind: 'deadline_reached', payload: payload({ reason: 'deadline_reached' }) });
    expect(text).toContain('跑太久先停了');
  });

  it('resource_limited → 系统太忙，这个没接', () => {
    const text = renderNotification({ kind: 'capacity_blocked', payload: payload({ reason: 'capacity_blocked' }) });
    expect(text).toContain('系统太忙，这个没接');
  });

  it('cancelled → 已按你说的停了', () => {
    const text = renderNotification({ kind: 'user_stop', payload: payload({ reason: 'user_stop' }) });
    expect(text).toContain('已按你说的停了');
  });

  it('全部 7 类 kind 都可渲染（折叠无遗漏）', () => {
    for (const kind of NOTIFICATION_KINDS as readonly NotificationKind[]) {
      expect(renderNotification({ kind, payload: payload() }).trim()).not.toBe('');
    }
  });
});

describe('R5 文案渲染：黑名单机械断言', () => {
  it('内部术语/uuid/绝对路径/W 窗口码一律拒绝', () => {
    for (const banned of [
      'task_status 查询失败',
      'resource_limited 重试',
      'requestId=req_1',
      'task_3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      '读 /home/deploy/state.db 失败',
      '窗口 W202611 超时',
    ]) {
      expect(() => assertUserLanguage(banned)).toThrow(NotificationLanguageError);
    }
  });

  it('渲染器自身产出的 7 类文案全部通过黑名单断言（name 是用户原话，断言只针对渲染器拼装部分）', () => {
    for (const kind of NOTIFICATION_KINDS as readonly NotificationKind[]) {
      const text = renderNotification({ kind, payload: payload({ reason: 'result_unknown', missing: ['开票日期'] }) });
      // 用户原话之外的拼接文本不得触发黑名单。
      expect(() => assertUserLanguage(text.replace('查十一月的发票', '任务'))).not.toThrow();
    }
  });
});

describe('R5 文案渲染：name 必含', () => {
  it('缺省机械回落「未命名任务」', () => {
    const text = renderNotification({ kind: 'started', payload: { at: '2026-11-15T08:00:00.000Z' } });
    expect(text).toContain('未命名任务');
  });
});

/**
 * 任务编号收口（2026-11-20）：taskNo 是内部底账形态，用户可见面不得出现工单腔的
 * `#N` / 「编号 N」模板产物。内部 payload 仍保留 taskNo（对账用），只是渲染不得带出。
 * 反向绊线：把 BLACKLIST 的任务编号两条删掉，本例与通用扫描（internal-terms.test）即红。
 */
describe('任务编号不进用户可见文本（taskNo=7）', () => {
  const TASK_NO_SHAPE = /#\d+|编号\s*#?\d+/;

  it('7 类文案 × taskNo=7：输出既无 #7 也无「编号 7」模板产物', () => {
    for (const kind of NOTIFICATION_KINDS as readonly NotificationKind[]) {
      const text = renderNotification({
        kind,
        payload: payload({ taskNo: 7, reason: 'result_unknown', missing: ['窗口'] }),
      });
      expect(text, `kind=${kind} 不得含工单编号：${text}`).not.toMatch(TASK_NO_SHAPE);
      expect(text).not.toContain('7'); // 精确断言：name/摘要里本就没有 7，模板也未拼入编号。
    }
  });

  it('即使 name 混进编号措辞，渲染器的黑名单断言也拒绝（源头挡，不靠调用方）', () => {
    // name 本是执行层/用户原话，但「#7 / 编号 7」是工单腔——断言拼装文本时一并拒绝。
    for (const bad of ['#7 的发票', '编号 7 的发票']) {
      expect(() => assertUserLanguage(`办完了：${bad}。`)).toThrow(NotificationLanguageError);
    }
  });
});
