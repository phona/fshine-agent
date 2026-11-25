/**
 * live 出站口的**内部形态闸**（2026-11-25 生产接入）：用户可见文本投递前过与 eval 批次
 * 同一把尺（`scanUserVisibleText`，见 `packages/agent/src/user-visible-scan.ts`）。
 *
 * 为什么接在生产：闸原本只挂在四个 eval 批次（wecom-sim / write-loop /
 * write-loop-scenarios / convergence-r1），`apps/server` 零接入；而 eval 和 live 是
 * **同一条链**，只是出口一个是 Mock 一个是企微——闸留在 eval 目录等于生产没有闸。
 * 2026-11-20 live 首验的 DSML 泄漏（模型把工具调用协议当正文写给用户）就发生在这条路上。
 *
 * 钉住的用户级行为（每条含反向绊线）：
 *   ① 完成正文带工具调用块标记（live 实测冻结的四条原文）→ 不投递、记 leak_blocked、不记 sent；
 *   ② 正文带内部词 / taskId 形状 → 同样不投递（同一把尺，不复制两份）；
 *   ③ 反向绊线（干净业务正文）→ 照常投递、记 sent——闸不是把所有消息都拦掉；
 *   ④ 失败兜底那句也过同一道闸（出口只有一个；兜底话术自己不带内部词，负例同样成立）；
 *   ⑤ 闸在投递端口**之前**：命中时假端口的 sendText 零调用（不是发出去了再记）。
 */
import { describe, expect, it } from 'vitest';
import type { DeliveryReceipt } from '@fshine/contracts';
import { deliverTaskFailure, deliverTaskResult, type TaskResultDeliveryPort } from './task-completion-delivery';
import { TOOL_BLOCK_MARKERS } from '../../packages/agent/src/user-visible-scan';

const SCOPE = {
  taskId: 'task_abcdef123456',
  principalId: 'wecom:user-a',
  sessionId: 'wecom:conv-a',
};

interface Sent { text: string }
interface Logged { event: string; [key: string]: unknown }

function harness(): {
  sent: Sent[];
  logged: Logged[];
  options: { delivery: TaskResultDeliveryPort; log: (line: Record<string, unknown>) => void };
} {
  const sent: Sent[] = [];
  const logged: Logged[] = [];
  return {
    sent,
    logged,
    options: {
      delivery: {
        deliveryMode: 'live',
        sendText: async (_route, text): Promise<DeliveryReceipt> => {
          sent.push({ text });
          return { parts: [{ kind: 'text', text }] } as unknown as DeliveryReceipt;
        },
      },
      log: (line) => logged.push(line as Logged),
    },
  };
}

function eventsOf(logged: Logged[], event: string): Logged[] {
  return logged.filter((line) => line.event === event);
}

describe('live 出站口内部形态闸（与 eval 批次同一把尺）', () => {
  it('① 完成正文带工具调用块标记 → 不投递、记 leak_blocked、不记 sent', async () => {
    const h = harness();
    const leaky = ['我查到了：', TOOL_BLOCK_MARKERS[0], 'tool_use', '参数 a 结束'].join('\n');
    const delivered = await deliverTaskResult({ ...SCOPE, resultText: leaky }, h.options);

    expect(delivered).toBe(false);
    expect(h.sent).toHaveLength(0); // ⑤ 闸在端口之前：命中时零投递
    expect(eventsOf(h.logged, 'task_result_delivery_sent')).toHaveLength(0);
    const blocked = eventsOf(h.logged, 'task_result_delivery_leak_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.markers).toEqual([TOOL_BLOCK_MARKERS[0]]);
    expect(blocked[0]?.deliveryMode).toBe('live');
    expect(blocked[0]?.taskId).toBe(SCOPE.taskId);
    expect(JSON.stringify(blocked[0])).not.toContain('我查到了');
  });

  it('①b 四条冻结标记逐条都拦得住（不是只拦第一条）', async () => {
    for (const marker of TOOL_BLOCK_MARKERS) {
      const h = harness();
      const delivered = await deliverTaskResult({ ...SCOPE, resultText: `正常开头。${marker}结尾` }, h.options);
      expect(delivered, `标记 ${marker} 未被闸拦下`).toBe(false);
      expect(h.sent).toHaveLength(0);
      expect(eventsOf(h.logged, 'task_result_delivery_leak_blocked')).toHaveLength(1);
    }
  });
});

describe('live 出站口内部形态闸：内部词 / taskId / 反向绊线 / 失败出口', () => {
  it('② 完成正文带内部词 → 不投递（同一把尺，不复制两份）', async () => {
    const h = harness();
    const delivered = await deliverTaskResult(
      { ...SCOPE, resultText: '这事得问执行层，我这边办不了。' },
      h.options,
    );
    expect(delivered).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(eventsOf(h.logged, 'task_result_delivery_leak_blocked')).toHaveLength(1);
  });

  it('②b 完成正文带 taskId 形状 → 不投递', async () => {
    const h = harness();
    const delivered = await deliverTaskResult(
      { ...SCOPE, resultText: '任务号 task_db2b3ca3 还在跑。' },
      h.options,
    );
    expect(delivered).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(eventsOf(h.logged, 'task_result_delivery_leak_blocked')).toHaveLength(1);
  });

  it('③ 反向绊线：干净业务正文照常投递、记 sent', async () => {
    const h = harness();
    const clean = '华远贸易 21000 元、明达物流 18000 元，合计 39000 元（共 12 行）。';
    const delivered = await deliverTaskResult({ ...SCOPE, resultText: clean }, h.options);

    expect(delivered).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toBe(clean);
    expect(eventsOf(h.logged, 'task_result_delivery_leak_blocked')).toHaveLength(0);
    expect(eventsOf(h.logged, 'task_result_delivery_sent')).toHaveLength(1);
  });

  it('④ 失败兜底那句也过同一道闸（出口只有一个；自身措辞不误触）', async () => {
    const h = harness();
    const delivered = await deliverTaskFailure({ ...SCOPE }, h.options);
    expect(delivered).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(eventsOf(h.logged, 'task_result_delivery_leak_blocked')).toHaveLength(0);
    expect(eventsOf(h.logged, 'task_result_delivery_sent')).toHaveLength(1);
  });

  it('④b 失败兜底带的业务名泄漏内部形态 → 一样拦（名字也走用户可见文本）', async () => {
    const h = harness();
    const delivered = await deliverTaskFailure(
      { ...SCOPE, resourceLimited: true, name: 'task_db2b3ca3 汇总' },
      h.options,
    );
    expect(delivered).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(eventsOf(h.logged, 'task_result_delivery_leak_blocked')).toHaveLength(1);
  });
});
