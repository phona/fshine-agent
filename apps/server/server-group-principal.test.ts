/**
 * 群 = 独立主体（owner 2026-11-18）· server 级确定性验证（假渠道事实 + 假执行面 + 假主驱动；零网络）。
 *
 * 身份派生（`apps/server/server.ts` handler）：
 *   · 1:1  → `principalId = <channel>:<userid>`（不变）
 *   · 群聊 → `principalId = <channel>:group:<conversationId>`（同群所有人共用一个主体）
 *   · session 两侧一致 = `<channel>:<conversationId>`（同群所有人同一份 Pi 会话）
 *   发言人不是 principal：只以 `speakerId` 进日志事件（审计），不进任务行。
 *
 * 用例：
 *   ① 同群两个不同 userid 发言 → 同一 principal/同一会话；第二次发言的回合看得到第一句（共享记忆）；
 *   ② 两个不同的群 → principal/session 不同、转录互不可见（跨群不串）；
 *   ③ 未开通的群 → 与未开通个人同一条拒绝路径（终帧话术），不起回合、不建会话；
 *   ④ 1:1 行为逐字节不变（principal = session = `<channel>:<userid>`；不同人各自成会话）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import type { MainSessionLocation } from '../../packages/agent/src/session-persistence';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-group-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * 开通名单：两个人（1:1）+ 两个群主体（显式开通）。第三个群**不**开通——用于拒绝路径。
 * 群主体是普通 key（`wecom:group:<群id>`），配置无需改解析。
 */
function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
      'wecom:user-b': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
      'wecom:group:group-1': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
      'wecom:group:group-2': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
}

function incoming(
  userId: string,
  conversationId: string,
  messageId: string,
  text: string,
  chatType: 'single' | 'group',
): IncomingChannelMessage {
  return {
    wecomUserId: userId,
    channel: 'wecom',
    conversationId,
    messageId,
    chatType,
    text,
    receivedAt: new Date().toISOString(),
  };
}

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

interface TurnRecord {
  readonly location: MainSessionLocation;
  readonly text: string;
  readonly messages: readonly DriverMessage[];
}

/**
 * Pi 会话替身主驱动（同 `server-b1-persistence.test.ts` 的范式）：只用 Pi 公开
 * `SessionManager` 落盘/读回（零模型），历史归会话文件；每回合记录会话位置与输入转录。
 * 同一 (principal, session) 复用同一驱动实例 = 同一份会话文件。
 */
function piBackedDrivers(records: TurnRecord[], replyFor: (text: string) => string) {
  return (_env: NodeJS.ProcessEnv, location?: MainSessionLocation) => {
    if (location === undefined) throw new Error('（测试）装配必须给出会话位置');
    const mainDriver = piBackedDriver(location, replyFor, records);
    return { mainDriver, workerDriver: workerNeverCalled };
  };
}

function piBackedDriver(
  location: MainSessionLocation,
  replyFor: (text: string) => string,
  records: TurnRecord[],
): TurnDriver {
  let manager: SessionManager | undefined;
  const session = (): SessionManager => {
    manager ??= location.resumeSessionFile === undefined
      ? SessionManager.create(path.resolve(__dirname), location.sessionDir, { id: location.piSessionId })
      : SessionManager.open(location.resumeSessionFile, location.sessionDir, path.resolve(__dirname));
    return manager;
  };
  const projection = (): readonly DriverMessage[] => session()
    .getBranch()
    .filter((entry): entry is Extract<typeof entry, { type: 'message' }> => entry.type === 'message')
    .map((entry) => entry.message as unknown as DriverMessage);
  const append = (role: 'user' | 'assistant', content: string): void => {
    session().appendMessage({
      role, content, timestamp: Date.now(),
    } as unknown as Parameters<SessionManager['appendMessage']>[0]);
  };
  return {
    async run(input) {
      records.push({ location, text: messageText(input.messages[input.messages.length - 1]!), messages: [...input.messages] });
      const text = messageText(input.messages[input.messages.length - 1]!);
      append('user', text);
      const reply = replyFor(text);
      append('assistant', reply);
      return { text: reply, messages: [...projection()] };
    },
    transcript: () => projection(),
  };
}

async function makeServer(input: {
  replyFor?: (text: string) => string;
  records?: TurnRecord[];
  logs?: Array<Record<string, unknown>>;
}) {
  const dir = tempDir();
  const records = input.records ?? [];
  const logs = input.logs ?? [];
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath: path.join(dir, 'state.db'),
    createDrivers: piBackedDrivers(records, input.replyFor ?? ((text) => `（回复：${text}）`)),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    logger: (line) => logs.push(line),
  });
  return { dir, server, records, logs };
}

describe('群 = 独立主体 · ① 同群两个发言人落在同一主体与同一会话（共享记忆）', () => {
  it('A 先说、B 后说：同一 principal/同一 session，B 的回合看得到 A 的原话', async () => {
    const records: TurnRecord[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const handle = await makeServer({
      records,
      logs,
      replyFor: (text) => (text.includes('预算') ? '记下了：预算 3000。' : '你刚才说的是预算 3000。'),
    });
    try {
      const first = await handle.server.handler(incoming('user-a', 'group-1', 'm-1', '本群预算 3000', 'group'));
      const second = await handle.server.handler(incoming('user-b', 'group-1', 'm-2', '我刚才说了什么？', 'group'));

      expect(first).toBe('记下了：预算 3000。');
      expect(second).toContain('预算 3000');

      // 同一份 Pi 会话（同一 sessionDir + 同一 piSessionId）。
      expect(records).toHaveLength(2);
      expect(records[1]!.location.sessionDir).toBe(records[0]!.location.sessionDir);
      expect(records[1]!.location.piSessionId).toBe(records[0]!.location.piSessionId);
      // 共享记忆：第二个发言人的回合转录里有第一个发言人的原话。
      expect(records[1]!.messages.map(messageText).join('\n')).toContain('本群预算 3000');

      // 主体是群，不是人；发言人只作审计（speakerId）。
      const done = logs.filter((line) => line['event'] === 'message_done');
      expect(done).toHaveLength(2);
      expect(done[0]!['principalId']).toBe('wecom:group:group-1');
      expect(done[1]!['principalId']).toBe('wecom:group:group-1');
      expect(done[0]!['sessionId']).toBe('wecom:group-1');
      expect(done[1]!['sessionId']).toBe(done[0]!['sessionId']);
      expect(done[0]!['speakerId']).toBe('user-a');
      expect(done[1]!['speakerId']).toBe('user-b');
    } finally {
      handle.server.close();
    }
  });
});

describe('群 = 独立主体 · ② 不同群是不同主体（互不可见）', () => {
  it('group-1 与 group-2 的 principal/session 不同，转录互不串', async () => {
    const records: TurnRecord[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const handle = await makeServer({ records, logs, replyFor: (text) => `收到：${text}` });
    try {
      await handle.server.handler(incoming('user-a', 'group-1', 'g1-1', '一组暗号 ALPHA', 'group'));
      await handle.server.handler(incoming('user-b', 'group-2', 'g2-1', '二组暗号 BETA', 'group'));
      await handle.server.handler(incoming('user-b', 'group-1', 'g1-2', '一组再问一句', 'group'));

      const done = logs.filter((line) => line['event'] === 'message_done');
      expect(done[0]!['principalId']).toBe('wecom:group:group-1');
      expect(done[1]!['principalId']).toBe('wecom:group:group-2');
      expect(done[2]!['principalId']).toBe('wecom:group:group-1');
      expect(done[1]!['sessionId']).not.toBe(done[0]!['sessionId']);

      // 两群落在不同会话文件（不同 sessionDir 或不同 piSessionId）。
      expect(records[1]!.location.piSessionId).not.toBe(records[0]!.location.piSessionId);
      // 跨群不串：二组的转录没有一组的暗号；一组第三回合看不到二组的暗号。
      expect(records[1]!.messages.map(messageText).join('\n')).not.toContain('ALPHA');
      expect(records[2]!.messages.map(messageText).join('\n')).not.toContain('BETA');
      expect(records[2]!.messages.map(messageText).join('\n')).toContain('ALPHA');
    } finally {
      handle.server.close();
    }
  });
});

describe('群 = 独立主体 · ③ 未开通的群沿用既有拒绝路径', () => {
  it('未开通群主体：终帧话术与未开通个人同形，不起回合、不建会话', async () => {
    const records: TurnRecord[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const handle = await makeServer({ records, logs });
    try {
      const groupReply = await handle.server.handler(incoming('user-a', 'group-3', 'u-1', '未开通群里的请求', 'group'));
      const personReply = await handle.server.handler(incoming('user-c', 'user-c', 'u-2', '未开通个人的请求', 'single'));

      expect(groupReply).toBe('该账号（wecom:group:group-3）未开通使用权限，请联系管理员开通。');
      expect(personReply).toBe('该账号（wecom:user-c）未开通使用权限，请联系管理员开通。');
      // 同一拒绝路径：refused 事件带群主体 + speakerId；零回合、零会话、零 message_done。
      const refused = logs.filter((line) => line['event'] === 'message_refused');
      expect(refused).toHaveLength(2);
      expect(refused[0]!['principalId']).toBe('wecom:group:group-3');
      expect(refused[0]!['speakerId']).toBe('user-a');
      expect(refused[1]!['principalId']).toBe('wecom:user-c');
      expect(records).toHaveLength(0);
      expect(logs.some((line) => line['event'] === 'message_done')).toBe(false);
    } finally {
      handle.server.close();
    }
  });
});

describe('群 = 独立主体 · ④ 1:1 行为逐字节不变（回归）', () => {
  it('1:1：principal = <channel>:<userid>、session = <channel>:<conversationId>，不同人各自成会话', async () => {
    const records: TurnRecord[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const handle = await makeServer({ records, logs, replyFor: (text) => `收到：${text}` });
    try {
      await handle.server.handler(incoming('user-a', 'user-a', 'p-1', '甲的第一句', 'single'));
      await handle.server.handler(incoming('user-a', 'user-a', 'p-2', '甲的第二句', 'single'));
      await handle.server.handler(incoming('user-b', 'user-b', 'p-3', '乙的第一句', 'single'));

      const done = logs.filter((line) => line['event'] === 'message_done');
      // 逐字节：principal/session 与旧模型完全一致（人 = `wecom:<userid>`；1:1 conversationId = userid）。
      expect(done[0]!['principalId']).toBe('wecom:user-a');
      expect(done[0]!['sessionId']).toBe('wecom:user-a');
      expect(done[1]!['principalId']).toBe('wecom:user-a');
      expect(done[1]!['sessionId']).toBe('wecom:user-a');
      expect(done[2]!['principalId']).toBe('wecom:user-b');
      expect(done[2]!['sessionId']).toBe('wecom:user-b');
      // 发言人审计字段在 1:1 也是同一个人（不改语义）。
      expect(done[0]!['speakerId']).toBe('user-a');

      // 同一人两回合同会话（含自己上句）；不同人不同会话（互不可见）。
      expect(records[1]!.location.piSessionId).toBe(records[0]!.location.piSessionId);
      expect(records[1]!.messages.map(messageText).join('\n')).toContain('甲的第一句');
      expect(records[2]!.location.piSessionId).not.toBe(records[0]!.location.piSessionId);
      expect(records[2]!.messages.map(messageText).join('\n')).not.toContain('甲的第一句');
      // 1:1 绝不落到群主体命名空间。
      expect(done.some((line) => String(line['principalId']).includes(':group:'))).toBe(false);
    } finally {
      handle.server.close();
    }
  });
});
