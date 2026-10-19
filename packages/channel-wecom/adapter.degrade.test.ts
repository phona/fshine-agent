/**
 * 终帧拒收降级（"失败必达"路径 2）的直测：流式终帧被企微拒收（2026-10 事故：
 * errcode 846608"stream message update expired (>10 minutes)"——流式回复超过 10 分钟
 * 更新窗口，终帧被拒后用户端永远停在旧进度帧，整轮静默）时，改用 sendMessage 主动
 * 消息通道把终稿作为**全新消息**送达。
 *
 * 钉四件事：
 *   ① 终帧 ack 拒收 → sendMessage 被调用一次，content = 已截断的终稿全文，chatid 与
 *     会话一致（单聊 = userid）；
 *   ② 幂等/防重：同一回复只降级一次（终帧再失败不重复发）；
 *   ③ 中间进度帧拒收不降级（降级是给"答案"的，不是给中间帧的）；
 *   ④ 降级自身失败：只记守夜日志（wecom_reply_degrade_fail，含完整终稿文本），不外溢。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReplyHandler } from '@fshine/contracts';
import { WecomBotChannel } from './src/adapter';
import type { SdkClientLike } from './src/adapter';

const ENV = { WECOM_BOT_ID: 'bot-001', WECOM_BOT_SECRET: 'secret-abc' };

/** SDK 替身：replyStream 可按帧编程拒收（模拟 ack errcode 846608），sendMessage 记录调用。 */
class DegradeSdkClient implements SdkClientLike {
  readonly sentMessages: Array<{ chatid: string; content: string }> = [];
  /** replyStream 拒收判据：finish 与 content 同时匹配才 reject（模拟企微 ack 错误）。 */
  rejectFinalContent: string | null = null;
  rejectError = new Error('Reply ack error: errcode=846608, errmsg=stream message update expired (>10 minutes)');
  sendFailNext = false;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  connect(): unknown { return this; }
  disconnect(): void { /* no-op */ }

  async replyStream(_frame: unknown, _streamId: string, content: string, finish: boolean): Promise<unknown> {
    if (finish && this.rejectFinalContent !== null && content === this.rejectFinalContent) {
      throw this.rejectError;
    }
    return {};
  }

  async sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown> {
    this.sentMessages.push({ chatid, content: body.markdown.content });
    if (this.sendFailNext) throw new Error('send boom');
    return {};
  }

  async uploadMedia(): Promise<{ media_id: string }> { return { media_id: 'm1' }; }
  async replyMedia(): Promise<unknown> { return {}; }
  async downloadFile(): Promise<{ buffer: Buffer; filename?: string }> { return { buffer: Buffer.from('x') }; }
}

async function startChannel(client: DegradeSdkClient, handler: ReplyHandler) {
  const channel = new WecomBotChannel({ env: ENV, clientFactory: () => client, platformRoot: '/tmp' });
  const starting = channel.start(handler);
  client.emit('authenticated');
  await starting;
  return channel;
}

function textFrame(content: string): Record<string, unknown> {
  return {
    headers: { req_id: 'req-degrade' },
    body: {
      msgid: `msg-${Math.random().toString(36).slice(2, 8)}`,
      aibotid: 'bot-001',
      chattype: 'single',
      from: { userid: 'zhangsan' },
      msgtype: 'text',
      text: { content },
    },
  };
}

/** 发一条消息并等 handler 完成；finalToReject = 要拒收的终稿内容（替身按内容匹配拒收）。 */
async function dispatchText(
  client: DegradeSdkClient,
  channel: WecomBotChannel,
  content: string,
  handled: Promise<void>,
  finalToReject: string,
): Promise<DegradeSdkClient> {
  client.rejectFinalContent = finalToReject;
  client.emit('message.text', textFrame(content));
  await handled;
  // reply 的失败处理挂在 promise 链上（void 调用），多让一个微任务轮把降级跑完。
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return client;
}

describe('终帧拒收降级（sendMessage 全新消息通道）', () => {
  it('终帧 ack 拒收（errcode 846608）：sendMessage 被调用一次，终稿全文送达同一会话', async () => {
    const client = new DegradeSdkClient();
    const FINAL = '[资源超时] 已完成部分已交付。';
    let handlerDone: (value: Promise<void>) => void = () => {};
    const handled = new Promise<void>((resolve) => { handlerDone = resolve; });
    const channel = await startChannel(client, async () => {
      try {
        return { text: FINAL };
      } finally {
        handlerDone(Promise.resolve());
      }
    });
    try {
      await dispatchText(client, channel, '做幻骥达工资表', handled, FINAL);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]).toEqual({ chatid: 'zhangsan', content: FINAL });
    } finally {
      await channel.stop();
    }
  });

  it('防重 latch 按消息派发：同一次回复只降级一次，下一条消息的降级不受影响', async () => {
    const client = new DegradeSdkClient();
    let handlerCount = 0;
    const handledPromises: Array<(value: Promise<void>) => void> = [];
    const channel = await startChannel(client, async () => {
      try {
        handlerCount += 1;
        return { text: `终稿-${handlerCount}` };
      } finally {
        handledPromises[handlerCount - 1]?.(Promise.resolve());
      }
    });
    try {
      // 每条消息的终稿内容不同，替身按指定内容拒收——两条消息各拒各的终帧。
      await dispatchText(client, channel, '第一条消息', new Promise<void>((r) => { handledPromises[0] = r; }), '终稿-1');
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]).toEqual({ chatid: 'zhangsan', content: '终稿-1' });

      await dispatchText(client, channel, '第二条消息', new Promise<void>((r) => { handledPromises[1] = r; }), '终稿-2');
      expect(client.sentMessages).toHaveLength(2);
      expect(client.sentMessages[1]).toEqual({ chatid: 'zhangsan', content: '终稿-2' });
      expect(handlerCount).toBe(2);
    } finally {
      await channel.stop();
    }
  });

  it('中间进度帧拒收不降级：只有 finish=true 的帧失败才走 sendMessage', async () => {
    const client = new DegradeSdkClient();
    const PROGRESS = '正在处理你的请求';
    let handlerDone: (value: Promise<void>) => void = () => {};
    const handled = new Promise<void>((resolve) => { handlerDone = resolve; });
    const channel = await startChannel(client, async (_message, progress) => {
      try {
        progress!(PROGRESS);
        return { text: '正常终稿' };
      } finally {
        handlerDone(Promise.resolve());
      }
    });
    try {
      // 只拒收进度帧（终帧照常成功）：进度帧失败走 wecom_reply_fail 原路径，不降级。
      client.replyStream = async (_f: unknown, _s: string, content: string, finish: boolean) => {
        if (!finish && content === PROGRESS) throw new Error('Reply ack error: errcode=846608, errmsg=expired');
        return {};
      };
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await dispatchText(client, channel, '做幻骥达工资表', handled, '正常终稿');
        const logged = errSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(logged).toContain('wecom_reply_fail');
        expect(logged).toContain('"finish":false');
      } finally {
        errSpy.mockRestore();
      }
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      await channel.stop();
    }
  });

  it('降级自身失败：守夜日志含完整终稿文本，不外溢、不发第二条', async () => {
    const client = new DegradeSdkClient();
    const FINAL = '降级也会失败的终稿';
    let handlerDone: (value: Promise<void>) => void = () => {};
    const handled = new Promise<void>((resolve) => { handlerDone = resolve; });
    const channel = await startChannel(client, async () => {
      try {
        return { text: FINAL };
      } finally {
        handlerDone(Promise.resolve());
      }
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      client.sendFailNext = true;
      await dispatchText(client, channel, '做幻骥达工资表', handled, FINAL);

      const logged = errSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(logged).toContain('wecom_reply_degrade_fail');
      expect(logged).toContain(FINAL);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
      await channel.stop();
    }
  });
});
