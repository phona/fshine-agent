/**
 * B1 会话持久化 → 回合生命周期接线（端口层；确定性、零真实模型、零网络）。
 *
 * 覆盖 createSession 的转录端口语义（execution-runtime.ts `TranscriptStore`）：
 *   ① 打开→载入：注入存储时现读完整转录并作为首回合历史；只把**本回合新增**消息增量追加；
 *   ② 写失败 fail-open：append 失败**不回滚回合**（回复照常返回），错误经 onTranscriptError 上报；
 *   ③ 读失败 fail-open：readTranscript 失败不阻塞会话打开（退化为空转录），错误上报；
 *   ④ 缺省 undefined = 逐字节现行为（转录仅内存）。
 *
 * 端口实现用假件（不触真实文件系统）；真实存储层的行为由 session-persistence.test.ts 覆盖。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import { createSession, type TranscriptStore } from './src/execution-runtime';

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  }
}

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（测试）worker 不应被调用');
  },
};

function messageText(message: DriverMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const first = content[0] as { text?: unknown } | undefined;
    if (first !== undefined && typeof first.text === 'string') return first.text;
  }
  return '';
}

/** 假驱动：记录每回合输入转录，返回给定回复并回填一条 assistant 消息（含本回合全部消息）。 */
function plainDriver(reply: string, records: DriverMessage[][]): TurnDriver {
  return {
    async run(input) {
      records.push([...input.messages]);
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

class FakeStore implements TranscriptStore {
  readonly appended: DriverMessage[] = [];
  reads = 0;
  private readonly initial: DriverMessage[];
  private readonly failRead: boolean;
  private readonly failAppendAt: number | undefined;

  constructor(
    initial: DriverMessage[] = [],
    options: { failRead?: boolean; failAppendAt?: number } = {},
  ) {
    this.initial = initial;
    this.failRead = options.failRead === true;
    this.failAppendAt = options.failAppendAt;
  }

  async readTranscript(): Promise<readonly DriverMessage[]> {
    this.reads += 1;
    if (this.failRead) throw new Error('（测试）readTranscript 失败');
    return [...this.initial];
  }

  async append(message: DriverMessage): Promise<void> {
    if (this.failAppendAt !== undefined && this.appended.length >= this.failAppendAt) {
      throw new Error('（测试）append 失败');
    }
    this.appended.push(message);
  }
}

const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 1 }) as unknown as AgentMessage;

async function sessionWith(store: TranscriptStore | undefined, records: DriverMessage[][], errors: unknown[]) {
  return await createSession({
    principalId: 'p',
    sessionId: 's',
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: plainDriver('新回复', records),
    workerDriver: workerNeverCalled,
    mainSystemPrompt: '你是测试主 Agent。',
    ...(store === undefined ? {} : { transcriptStore: store }),
    onTranscriptError: (error) => errors.push(error),
  });
}

describe('B1 转录端口接线（createSession）', () => {
  it('① 打开→载入首回合历史；只增量追加本回合新增消息（不重复落存储）', async () => {
    const store = new FakeStore([user('历史一'), { role: 'assistant', content: '历史回复' } as never]);
    const records: DriverMessage[][] = [];
    const session = await sessionWith(store, records, []);

    const result = await session.send('本轮输入');
    expect(result.reply).toBe('新回复');

    // 首回合 driver 看到载入的历史（现读存储）。
    expect(records[0]!.map(messageText)).toContain('历史一');
    expect(records[0]!.map(messageText)).toContain('本轮输入');
    // 仅本回合新增消息被追加（历史的 2 条不重复落）。
    expect(store.appended.map(messageText)).toEqual(['本轮输入', '新回复']);
    expect(store.reads).toBe(1);
  });

  it('② 写失败 fail-open：回合不因 append 失败而回滚，错误上报', async () => {
    const store = new FakeStore([], { failAppendAt: 0 });
    const records: DriverMessage[][] = [];
    const errors: unknown[] = [];
    const session = await sessionWith(store, records, errors);

    const result = await session.send('你好');
    expect(result.reply).toBe('新回复'); // 回合正常返回，未回滚
    expect(store.appended).toEqual([]); // 第一条即失败，未落任何消息
    expect(errors).toHaveLength(1);
  });

  it('③ 读失败 fail-open：不阻塞会话打开，退化为空转录并可继续持久化本回合', async () => {
    const store = new FakeStore([], { failRead: true });
    const records: DriverMessage[][] = [];
    const errors: unknown[] = [];
    const session = await sessionWith(store, records, errors);

    const result = await session.send('首句');
    expect(result.reply).toBe('新回复');
    expect(errors).toHaveLength(1); // 读失败上报
    expect(store.appended.map(messageText)).toEqual(['首句', '新回复']);
  });

  it('④ 缺省 undefined = 现行为：无存储时不读不写，转录仍跨回合增长', async () => {
    const records: DriverMessage[][] = [];
    const session = await sessionWith(undefined, records, []);
    await session.send('第一句');
    await session.send('第二句');
    expect(records[1]!.map(messageText)).toContain('第一句'); // 内存转录跨回合保留
  });
});
