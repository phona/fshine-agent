/**
 * 运营告警规则单测（纯函数）。
 *
 * 覆盖：四条规则各一条命中 + 一条不命中（含「刚好到阈值不告、超一秒才告」的边界）；冷却去重；
 * **证据含原文**（告警项 raw 字段含被命中的内部原文——钉住「能回溯原始文本」这条不变量）；
 * retry_storm 的 `(operation, 错误码)` 计数**只认失败类结局**（2026-11-19 真部署假阳性修复）。
 *
 * 反向绊线（已实测会红，随后还原；见 decision 记录/交付报告）：
 *   ① 把 hostFaultCandidates 的 raw 截断或丢弃 → 「证据含原文」用例红；
 *   ② 去掉 evaluateAlerts 里的冷却判断 → 「冷却内去重」用例红；
 *   ③ 去掉 retryStormCandidates 的 `isFailureExecution` 状态过滤 → 「同任务 3 次 completed query 不告警」用例红。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COOLDOWN_MS,
  RETRY_STORM_OP_ERROR,
  RETRY_STORM_TASK_FACTS,
  TASK_RUNNING_STUCK_MS,
  USER_WAITING_STUCK_MS,
  evaluateAlerts,
  type AlertFact,
} from './src/alert-rules';

const NOW = new Date('2026-11-19T12:00:00.000Z');

function fact(partial: Partial<AlertFact> & Pick<AlertFact, 'event' | 'raw'>): AlertFact {
  return { source: 'log', at: NOW.toISOString(), ...partial };
}

/** 时刻 = now - 时长。 */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('host_fault_reported', () => {
  it('命中：协议违约事件（我方故障）', () => {
    const result = evaluateAlerts(
      [
        fact({
          event: 'execution_accepted_undeclared',
          taskId: 't1',
          raw: '{"event":"execution_accepted_undeclared","taskId":"t1","operation":"commit"}',
          evidenceRef: 'event:execution_accepted_undeclared',
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts.map((a) => a.rule)).toEqual(['host_fault_reported']);
    expect(result.alerts[0]!.severity).toBe('critical');
  });

  it('命中：确认句柄丢失错误码', () => {
    const result = evaluateAlerts(
      [
        fact({
          event: 'execution',
          taskId: 't2',
          raw: '由此确认句柄 CONFIRMATION_NOT_FOUND',
          detail: { errorCode: 'CONFIRMATION_NOT_FOUND', operation: 'commit' },
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts.some((a) => a.rule === 'host_fault_reported')).toBe(true);
  });

  it('不命中：普通执行事实（无我方故障标记）', () => {
    const result = evaluateAlerts(
      [
        fact({
          event: 'execution',
          taskId: 't3',
          raw: '{"event":"execution","status":"completed"}',
          detail: { operation: 'read', errorCode: 'NOT_FOUND' },
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts).toEqual([]);
  });
});

describe('retry_storm', () => {
  it('命中：同一任务执行事实达到阈值', () => {
    const facts: AlertFact[] = Array.from({ length: RETRY_STORM_TASK_FACTS }, (_, i) => fact({
      event: 'execution',
      taskId: 't9',
      raw: `{"event":"execution","taskId":"t9","seq":${i}}`,
      detail: { operation: 'query', errorCode: `E${i}` },
    }));
    const result = evaluateAlerts(facts, { now: NOW });
    expect(result.alerts.some((a) => a.rule === 'retry_storm' && a.subject === 'task:t9')).toBe(true);
  });

  it('命中：同一 (operation, 错误码) 在同一任务重复达到阈值（失败类结局）', () => {
    const facts: AlertFact[] = Array.from({ length: RETRY_STORM_OP_ERROR }, (_, i) => fact({
      event: 'execution',
      taskId: 't10',
      raw: `{"event":"execution","taskId":"t10","seq":${i}}`,
      detail: { operation: 'commit', errorCode: 'CONFIRMATION_NOT_FOUND', status: 'refused' },
    }));
    const result = evaluateAlerts(facts, { now: NOW });
    expect(result.alerts.some((a) => a.rule === 'retry_storm' && a.subject === 'task:t10')).toBe(true);
  });

  // 2026-11-19 真部署假阳性修复：同任务同 operation 的**合法重复**（成功/待确认/受理）不算错误重复。
  it('不命中：同任务 3 次 completed 的 query（同一 operation、无错误码）→ 不告警', () => {
    const facts: AlertFact[] = Array.from({ length: RETRY_STORM_OP_ERROR }, (_, i) => fact({
      event: 'execution',
      taskId: 't12',
      raw: `{"event":"execution","taskId":"t12","operation":"dummy.query","status":"completed","seq":${i}}`,
      detail: { operation: 'dummy.query', status: 'completed' },
    }));
    const result = evaluateAlerts(facts, { now: NOW });
    expect(result.alerts.filter((a) => a.rule === 'retry_storm')).toEqual([]);
  });

  it('不命中：同任务 3 次 needs_confirmation 的 prepare（合法提案重复）→ 不告警', () => {
    const facts: AlertFact[] = Array.from({ length: RETRY_STORM_OP_ERROR }, (_, i) => fact({
      event: 'execution',
      taskId: 't13',
      raw: `{"event":"execution","taskId":"t13","operation":"dummy.prepare","status":"needs_confirmation","seq":${i}}`,
      detail: { operation: 'dummy.prepare', status: 'needs_confirmation' },
    }));
    const result = evaluateAlerts(facts, { now: NOW });
    expect(result.alerts.filter((a) => a.rule === 'retry_storm')).toEqual([]);
  });

  it('命中：同任务 3 次 failed 且同码 → 告警', () => {
    const facts: AlertFact[] = Array.from({ length: RETRY_STORM_OP_ERROR }, (_, i) => fact({
      event: 'execution',
      taskId: 't14',
      raw: `{"event":"execution","taskId":"t14","operation":"dummy.commit","status":"failed","error":{"code":"GATE_REFUSE"},"seq":${i}}`,
      detail: { operation: 'dummy.commit', errorCode: 'GATE_REFUSE', status: 'failed' },
    }));
    const result = evaluateAlerts(facts, { now: NOW });
    expect(result.alerts.some((a) => a.rule === 'retry_storm' && a.subject === 'task:t14')).toBe(true);
  });

  it('不命中：同一任务执行事实未达阈值', () => {
    const facts: AlertFact[] = Array.from({ length: RETRY_STORM_TASK_FACTS - 1 }, (_, i) => fact({
      event: 'execution',
      taskId: 't11',
      raw: `{"event":"execution","taskId":"t11","seq":${i}}`,
      detail: { operation: 'query', errorCode: `E${i}` },
    }));
    const result = evaluateAlerts(facts, { now: NOW });
    expect(result.alerts.filter((a) => a.rule === 'retry_storm')).toEqual([]);
  });
});

describe('task_stuck', () => {
  it('边界：running 刚好 10 分钟不告', () => {
    const result = evaluateAlerts(
      [fact({ event: 'task_state', taskId: 't20', at: ago(TASK_RUNNING_STUCK_MS), raw: '{"status":"running"}}', detail: { taskStatus: 'running' } })],
      { now: NOW },
    );
    expect(result.alerts).toEqual([]);
  });

  it('边界：running 10 分 1 秒告', () => {
    const result = evaluateAlerts(
      [fact({ event: 'task_state', taskId: 't21', at: ago(TASK_RUNNING_STUCK_MS + 1000), raw: '{"status":"running"}}', detail: { taskStatus: 'running' } })],
      { now: NOW },
    );
    expect(result.alerts.some((a) => a.rule === 'task_stuck' && a.subject === 'task:t21')).toBe(true);
  });

  it('边界：waiting_user 刚好 30 分钟不告，超过 1 秒告', () => {
    const onEdge = evaluateAlerts(
      [fact({ event: 'task_state', taskId: 't22', at: ago(USER_WAITING_STUCK_MS), raw: '{"status":"waiting_user"}}', detail: { taskStatus: 'waiting_user' } })],
      { now: NOW },
    );
    expect(onEdge.alerts).toEqual([]);
    const overEdge = evaluateAlerts(
      [fact({ event: 'task_state', taskId: 't23', at: ago(USER_WAITING_STUCK_MS + 1000), raw: '{"status":"waiting_user"}}', detail: { taskStatus: 'waiting_user' } })],
      { now: NOW },
    );
    expect(overEdge.alerts.some((a) => a.rule === 'task_stuck' && a.subject === 'task:t23')).toBe(true);
  });

  it('不命中：running 5 分钟', () => {
    const result = evaluateAlerts(
      [fact({ event: 'task_state', taskId: 't24', at: ago(5 * 60 * 1000), raw: '{"status":"running"}}', detail: { taskStatus: 'running' } })],
      { now: NOW },
    );
    expect(result.alerts).toEqual([]);
  });
});

describe('delivery_failed', () => {
  it('命中：file_delivery 状态非 sent', () => {
    const result = evaluateAlerts(
      [
        fact({
          event: 'file_delivery',
          sessionId: 's1',
          raw: '{"event":"file_delivery","sessionId":"s1","status":"delivery_failed","message":"boom"}',
          detail: { deliveryStatus: 'delivery_failed' },
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts.map((a) => a.rule)).toEqual(['delivery_failed']);
    expect(result.alerts[0]!.subject).toBe('session:s1');
  });

  it('命中：task_result_delivery_failed 事件', () => {
    const result = evaluateAlerts(
      [fact({ event: 'task_result_delivery_failed', taskId: 't30', sessionId: 's2', raw: '{"event":"task_result_delivery_failed"}' })],
      { now: NOW },
    );
    expect(result.alerts.some((a) => a.rule === 'delivery_failed')).toBe(true);
  });

  it('不命中：file_delivery 状态 sent', () => {
    const result = evaluateAlerts(
      [
        fact({
          event: 'file_delivery',
          sessionId: 's3',
          raw: '{"event":"file_delivery","status":"sent"}',
          detail: { deliveryStatus: 'sent' },
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts).toEqual([]);
  });

  it('命中：通知投递终局 exhausted（失败到 attempts 上限 = 用户最终没收到）', () => {
    // 2026-11-19 第 3 档接线：outbox 的终局事件（server 装配落 notification_delivery_terminal）
    // 必须进告警面——否则「兜不住、用户也做不了什么」这一类断了归宿。
    const result = evaluateAlerts(
      [
        fact({
          event: 'notification_delivery_terminal',
          taskId: 't31',
          sessionId: 's4',
          raw: '{"event":"notification_delivery_terminal","taskId":"t31","result":"exhausted","attempts":5,"reason":"渠道不可用"}',
          detail: { deliveryResult: 'exhausted' },
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts.map((a) => a.rule)).toEqual(['delivery_failed']);
    expect(result.alerts[0]!.severity).toBe('critical');
  });

  it('不命中：通知投递终局 skipped（没有东西可发/永不可能送达——告警只会成噪音）', () => {
    const result = evaluateAlerts(
      [
        fact({
          event: 'notification_delivery_terminal',
          taskId: 't32',
          raw: '{"event":"notification_delivery_terminal","taskId":"t32","result":"skipped","reason":"SKIPPED:delivery_unavailable"}',
          detail: { deliveryResult: 'skipped' },
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts).toEqual([]);
  });

  it('命中：长活提醒投递 failed；不命中：sent', () => {
    const failed = evaluateAlerts(
      [
        fact({
          event: 'task_long_running_notice',
          taskId: 't33',
          sessionId: 's5',
          raw: '{"event":"task_long_running_notice","taskId":"t33","stage":"overdue","result":"failed","attempt":2}',
          detail: { deliveryResult: 'failed' },
        }),
      ],
      { now: NOW },
    );
    expect(failed.alerts.map((a) => a.rule)).toEqual(['delivery_failed']);

    const sent = evaluateAlerts(
      [
        fact({
          event: 'task_long_running_notice',
          taskId: 't34',
          raw: '{"event":"task_long_running_notice","taskId":"t34","result":"sent","attempt":1}',
          detail: { deliveryResult: 'sent' },
        }),
      ],
      { now: NOW },
    );
    expect(sent.alerts).toEqual([]);
  });
});

describe('冷却去重', () => {
  const faultFact = fact({
    event: 'execution_accepted_undeclared',
    taskId: 'tCooldown',
    raw: '{"event":"execution_accepted_undeclared","taskId":"tCooldown"}',
  });

  it('同一 (rule, subject) 冷却窗口内只出一次', () => {
    const first = evaluateAlerts([faultFact], { now: NOW });
    expect(first.alerts).toHaveLength(1);

    // 冷却窗口内（+1 分钟）再判：不重复出。
    const within = evaluateAlerts([faultFact], {
      now: new Date(NOW.getTime() + 60_000),
      cooldownState: first.cooldownState,
    });
    expect(within.alerts).toEqual([]);

    // 过了冷却窗口（+ 30 分钟 + 1 秒）：可再出。
    const after = evaluateAlerts([faultFact], {
      now: new Date(NOW.getTime() + DEFAULT_COOLDOWN_MS + 1000),
      cooldownState: within.cooldownState,
    });
    expect(after.alerts).toHaveLength(1);
  });

  it('不同 subject 互不影响', () => {
    const other = fact({
      event: 'execution_accepted_undeclared',
      taskId: 'tOther',
      raw: '{"event":"execution_accepted_undeclared","taskId":"tOther"}',
    });
    const first = evaluateAlerts([faultFact], { now: NOW });
    const second = evaluateAlerts([other], {
      now: new Date(NOW.getTime() + 60_000),
      cooldownState: first.cooldownState,
    });
    expect(second.alerts).toHaveLength(1);
    expect(second.alerts[0]!.subject).toBe('task:tOther');
  });
});

describe('证据含原文（能回溯原始文本）', () => {
  it('告警项 raw 字段包含被命中的内部原文，且不截断', () => {
    const original = '{"event":"execution","status":"refused","error":{"code":"CONFIRMATION_NOT_FOUND","message":"确认句柄丢失：handle=abc 已被消费"}}';
    const result = evaluateAlerts(
      [
        fact({
          event: 'execution',
          taskId: 'tRaw',
          raw: original,
          evidenceRef: 'task:tRaw',
          detail: { errorCode: 'CONFIRMATION_NOT_FOUND', operation: 'commit' },
        }),
      ],
      { now: NOW },
    );
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    // 原始内部文本原样出现在证据里。
    expect(alert.raw).toContain('CONFIRMATION_NOT_FOUND');
    expect(alert.raw).toContain('确认句柄丢失：handle=abc 已被消费');
    // 不截断：整条原文逐字保留。
    expect(alert.raw).toBe(original);
    // 回溯键可用。
    expect(alert.evidenceRef).toBe('task:tRaw');
  });
});
