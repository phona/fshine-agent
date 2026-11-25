/**
 * AttachmentNudge 的组件级确定性测试（补充 server 级用例不便构造的时序）：
 *   · 附件登记是异步的——登记完成前用户已说话（活动令牌过期）→ 不补排追问；
 *   · 令牌仍有效 → 30s 到点发一次、系统注记入队一次。
 *
 * 时钟/调度器全部注入，零真实 sleep。
 */
import { describe, expect, it } from 'vitest';
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import { AttachmentNudge, type NudgeClock } from './attachment-nudge';
import type { AttachmentFactInput } from './attachment-facts';

class ManualClock implements NudgeClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run: () => void | Promise<void> }>();

  now = (): number => this.current;

  schedule = (run: () => void | Promise<void>, delayMs: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + delayMs, run });
    return id;
  };

  cancel = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      let due: [number, { at: number; run: () => void | Promise<void> }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      await due[1].run();
    }
    this.current = target;
  }
}

const ROUTE: ChannelRoute = { channel: 'wecom', conversationId: 'conv-a' };

function file(fileId = 'file_1', name = '名册.xlsx'): AttachmentFactInput {
  return { fileId, name, bytes: 6861, receivedAt: new Date(2026, 10, 17, 20, 41).toISOString() };
}

function makeNudge(clock: ManualClock): { nudge: AttachmentNudge; texts: string[]; notes: string[] } {
  const texts: string[] = [];
  const notes: string[] = [];
  const nudge = new AttachmentNudge({
    afterMs: 30_000,
    clock,
    delivery: {
      deliveryMode: 'live',
      async sendText(_route, text): Promise<DeliveryReceipt> {
        texts.push(text);
        return { route: ROUTE, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
      },
    },
    enqueueSystemNote: (principalId, sessionId, note) => notes.push(`${principalId}/${sessionId}:${note}`),
    log: () => {},
  });
  return { nudge, texts, notes };
}

describe('AttachmentNudge：活动令牌与发送', () => {
  it('登记完成前用户已说话（令牌过期）→ 不排追问、不发', async () => {
    const clock = new ManualClock();
    const { nudge, texts, notes } = makeNudge(clock);

    const activity = nudge.onInboundMessage({ principalId: 'p', sessionId: 's', attachmentOnly: true });
    // 下载/落盘期间用户发了一条文字消息：活动令牌已前进。
    nudge.onInboundMessage({ principalId: 'p', sessionId: 's', attachmentOnly: false });
    nudge.onAttachments({ principalId: 'p', sessionId: 's', chatType: 'single', route: ROUTE, files: [file()], activity });

    await clock.advance(60_000);
    expect(texts).toHaveLength(0);
    expect(notes).toHaveLength(0);
    nudge.close();
  });

  it('令牌有效 → 30s 到点发一次，系统注记入队一次（同 fileId 只算一个文件）', async () => {
    const clock = new ManualClock();
    const { nudge, texts, notes } = makeNudge(clock);

    const activity = nudge.onInboundMessage({ principalId: 'p', sessionId: 's', attachmentOnly: true });
    nudge.onAttachments({
      principalId: 'p',
      sessionId: 's',
      chatType: 'single',
      route: ROUTE,
      files: [file(), file()],
      activity,
    });

    await clock.advance(29_999);
    expect(texts).toHaveLength(0);
    await clock.advance(1);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('刚才这 1 个文件');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('[系统主动提示]');
    nudge.close();
  });
});
