/**
 * 纯附件事实注入 + 30 秒主动追问（目标 A/B）的 server 级确定性验证。
 *
 * 时钟/定时器全部注入（ManualClock），不真 sleep；假渠道、假执行面、假驱动、零网络。
 *
 * 覆盖（逐条对应 ask）：
 *   1. 纯附件登记 → 下一回合注入一次机械事实（含时间、不含路径）；同 fileId 不重复注入
 *      （单元级：attachment-facts.test.ts）；
 *   2. 30 秒无消息 → 发一次追问（文件名 + 2~4 个业务选项），并把同一份选项作为
 *      `[系统主动提示]` 系统注记注入下一回合（模型可见 / 用户不可见 / 不触发回合）；
 *   3. 5 秒后用户说话 → 不发；
 *   4. 群聊 → 不发；
 *   5. 连发 3 个文件 → 只发一条，提到 3 个文件；
 *   6. 10 分钟冷却内第二次 → 不发；
 *   7. attachmentNudgeAfterMs=0 → 永不发（无定时器/无事件/无注记）；
 *   8. 用户话术与注入文本不出现路径、不出现行数据（grep 断言）；
 *   9. 写类选项只在 allowWriteOperations=true 时列出；
 *   + 非 live 投递 → suppressed 事件、绝不记 sent、零真实投递。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, IncomingChannelMessage, RuntimeConfig } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createServer, type FileDeliveryPort } from './server';
import type { NudgeClock } from './attachment-nudge';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const NUDGE_AFTER_MS = 30_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-nudge-'));
  tempDirs.push(dir);
  return dir;
}

/** 注入时钟/调度器：advance() 只推进注入时间并执行到期回调（回调可 await）。 */
class ManualClock implements NudgeClock {
  private current = Date.UTC(2026, 10, 17, 12, 0, 0);
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

  pending(): number {
    return this.timers.size;
  }

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

function testConfig(runtime: RuntimeConfig): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime,
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

/** 捕获每回合 injections；回复固定文本（附件-only 路径不会创建驱动）。 */
function captureDriver(injections: string[][]): TurnDriver {
  return {
    async run(input) {
      injections.push([...(input.injections ?? [])]);
      return { text: '好的，收到。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

function livePort(): { port: FileDeliveryPort; texts: string[]; fileCalls: number } {
  const texts: string[] = [];
  const state = { fileCalls: 0 };
  return {
    texts,
    get fileCalls() {
      return state.fileCalls;
    },
    port: {
      deliveryMode: 'live',
      async sendToConversation(route, files) {
        state.fileCalls += 1;
        return {
          route,
          parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })),
        };
      },
      async sendText(route, text) {
        texts.push(text);
        return { route, parts: [{ kind: 'text' as const, index: 0, status: 'sent' as const }] };
      },
    },
  };
}

function silentPort(): FileDeliveryPort & { texts: string[] } {
  const texts: string[] = [];
  const port = {
    deliveryMode: 'silent' as const,
    texts,
    async sendToConversation() {
      throw new Error('（测试）silent 部署不应发起真实投递');
    },
    async sendText() {
      throw new Error('（测试）silent 部署不应发起真实投递');
    },
  };
  return port;
}

function attachmentMessage(input: {
  dir: string;
  messageId: string;
  filename: string;
  bytes?: Buffer;
  chatType?: 'single' | 'group';
  conversationId?: string;
}): IncomingChannelMessage {
  const attachmentDir = path.join(input.dir, 'attachments');
  mkdirSync(attachmentDir, { recursive: true });
  const filePath = path.join(attachmentDir, `${input.messageId}-${input.filename}`);
  const bytes = input.bytes ?? Buffer.alloc(6861, 0x61);
  writeFileSync(filePath, bytes);
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: input.conversationId ?? 'conv-a',
    messageId: input.messageId,
    chatType: input.chatType ?? 'single',
    text: `[附件:${input.filename}]`,
    attachments: [{ filename: input.filename, path: filePath, bytes: bytes.length }],
    attachmentOnly: true,
    receivedAt: new Date(Date.UTC(2026, 10, 17, 12, 41, 0)).toISOString(),
  };
}

function textMessage(messageId: string, text: string, conversationId = 'conv-a'): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId,
    messageId,
    chatType: 'single',
    text,
    receivedAt: new Date(Date.UTC(2026, 10, 17, 12, 42, 0)).toISOString(),
  };
}

interface Fixture {
  dir: string;
  clock: ManualClock;
  logs: Array<Record<string, unknown>>;
  injections: string[][];
  server: Awaited<ReturnType<typeof createServer>>;
  port: FileDeliveryPort;
  texts: string[];
}

async function makeFixture(input: {
  runtime?: RuntimeConfig;
  port?: FileDeliveryPort;
} = {}): Promise<Fixture> {
  const dir = tempDir();
  const clock = new ManualClock();
  const logs: Array<Record<string, unknown>> = [];
  const injections: string[][] = [];
  const live = livePort();
  const port = input.port ?? live.port;
  const texts = input.port === undefined ? live.texts : (input.port as FileDeliveryPort & { texts?: string[] }).texts ?? [];
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(input.runtime ?? { attachmentNudgeAfterMs: NUDGE_AFTER_MS }),
    dbPath: path.join(dir, 'state.db'),
    createDrivers: () => ({ mainDriver: captureDriver(injections), workerDriver: workerNeverCalled }),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    fileDelivery: port,
    attachmentNudgeClock: clock,
    logger: (line) => logs.push(line),
  });
  return { dir, clock, logs, injections, server, port, texts };
}

function optionsOf(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => /^\d+\.\s/.test(line));
}

afterEach(() => {
  // server.close() 由各用例 finally 关闭；这里只清临时目录。
});

describe('目标 A：纯附件机械事实进入下一回合（注入一次、含时间、不含路径）', () => {
  it('① 登记 → 下一回合 injections 含事实；再下一回合不再注入', async () => {
    const fx = await makeFixture();
    try {
      await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: 'm-file-1', filename: '名册.xlsx' }));
      await fx.server.handler(textMessage('m-text-1', '看看这个文件'));

      expect(fx.injections).toHaveLength(1);
      const fact = fx.injections[0]!.find((text) => text.startsWith('[收到附件]'));
      expect(fact).toBeDefined();
      expect(fact).toContain('名册.xlsx');
      expect(fact).toContain('fileId=file_');
      expect(fact).toContain('6,861 字节');
      expect(fact).toMatch(/· \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(fact).not.toContain(fx.dir);
      expect(fact).not.toContain(path.join(fx.dir, 'attachments'));

      await fx.server.handler(textMessage('m-text-2', '继续'));
      expect(fx.injections).toHaveLength(2);
      expect(fx.injections[1]!.some((text) => text.startsWith('[收到附件]'))).toBe(false);
    } finally {
      await fx.server.close();
    }
  });

  it('用户话术（handler 回执）不出现 fileId（fileId 只在模型上下文）', async () => {
    const fx = await makeFixture();
    try {
      const reply = await fx.server.handler(
        attachmentMessage({ dir: fx.dir, messageId: 'm-file-1', filename: '名册.xlsx' }),
      );
      expect(reply).toBe('');
      const textReply = await fx.server.handler(textMessage('m-text-1', '看看这个文件'));
      expect(textReply).not.toContain('fileId');
      expect(textReply).not.toContain('file_');
    } finally {
      await fx.server.close();
    }
  });
});

describe('目标 B：30 秒主动追问', () => {
  it('② 30 秒无消息 → 发一次追问（文件名 + 2~4 个选项），并把同一份选项注入下一回合系统注记', async () => {
    const fx = await makeFixture();
    try {
      await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: 'm-file-1', filename: '名册.xlsx' }));
      expect(fx.clock.pending()).toBe(1);

      await fx.clock.advance(NUDGE_AFTER_MS - 1);
      expect(fx.texts).toHaveLength(0);

      await fx.clock.advance(1);
      expect(fx.texts).toHaveLength(1);
      const nudge = fx.texts[0]!;
      expect(nudge).toContain('名册.xlsx');
      const options = optionsOf(nudge);
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.length).toBeLessThanOrEqual(4);
      expect(fx.logs.filter((line) => line['event'] === 'attachment_nudge_sent')).toHaveLength(1);

      // 用户回数字：下一回合的系统注记必须带着同一份选项（模型可见、用户不可见、不触发回合）。
      const reply = await fx.server.handler(textMessage('m-text-1', '1'));
      expect(reply).toBe('好的，收到。'); // 注记不触发单独回合：仍只有用户消息这一个回合
      const note = fx.injections[0]!.find((text) => text.startsWith('[系统主动提示]'));
      expect(note).toBeDefined();
      for (const option of options) expect(note).toContain(option);
      expect(note).toContain('系统主动提示');

      // 注记只注入一次。
      await fx.server.handler(textMessage('m-text-2', '2'));
      expect(fx.injections[1]!.some((text) => text.startsWith('[系统主动提示]'))).toBe(false);
    } finally {
      await fx.server.close();
    }
  });

  it('③ 附件后 5 秒用户就说话 → 不发追问', async () => {
    const fx = await makeFixture();
    try {
      await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: 'm-file-1', filename: '名册.xlsx' }));
      await fx.clock.advance(5_000);
      await fx.server.handler(textMessage('m-text-1', '先做汇总'));
      await fx.clock.advance(60_000);

      expect(fx.texts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);
    } finally {
      await fx.server.close();
    }
  });

  it('④ 群聊 → 不发追问', async () => {
    const fx = await makeFixture();
    try {
      await fx.server.handler(attachmentMessage({
        dir: fx.dir,
        messageId: 'm-file-1',
        filename: '名册.xlsx',
        chatType: 'group',
        conversationId: 'group-1',
      }));
      await fx.clock.advance(60_000);

      expect(fx.clock.pending()).toBe(0);
      expect(fx.texts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);
    } finally {
      await fx.server.close();
    }
  });

  it('⑤ 连发 3 个文件 → 只发一条追问且提到 3 个文件', async () => {
    const fx = await makeFixture();
    try {
      for (const [index, name] of ['名册.xlsx', '工资表.xlsx', '说明.docx'].entries()) {
        await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: `m-file-${index + 1}`, filename: name }));
      }
      expect(fx.clock.pending()).toBe(1);
      await fx.clock.advance(NUDGE_AFTER_MS);

      expect(fx.texts).toHaveLength(1);
      expect(fx.texts[0]).toContain('3 个文件');
      expect(fx.texts[0]).toContain('名册.xlsx');
      const options = optionsOf(fx.texts[0]!);
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.length).toBeLessThanOrEqual(4);
      expect(fx.logs.filter((line) => line['event'] === 'attachment_nudge_sent')).toHaveLength(1);
    } finally {
      await fx.server.close();
    }
  });

  it('⑥ 冷却期（10 分钟内第二次）→ 不发', async () => {
    const fx = await makeFixture();
    try {
      await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: 'm-file-1', filename: 'a.xlsx' }));
      await fx.clock.advance(NUDGE_AFTER_MS);
      expect(fx.texts).toHaveLength(1);

      // 第一次追问过去 1 分钟，再来一个文件：仍在 10 分钟冷却内。
      await fx.clock.advance(60_000);
      await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: 'm-file-2', filename: 'b.xlsx' }));
      await fx.clock.advance(NUDGE_AFTER_MS);

      expect(fx.texts).toHaveLength(1);
      expect(fx.logs.filter((line) => line['event'] === 'attachment_nudge_sent')).toHaveLength(1);
    } finally {
      await fx.server.close();
    }
  });

  it('⑦ attachmentNudgeAfterMs=0 → 永不发，零定时器/零事件/零注记', async () => {
    const fx = await makeFixture({ runtime: { attachmentNudgeAfterMs: 0 } });
    try {
      await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: 'm-file-1', filename: '名册.xlsx' }));
      expect(fx.clock.pending()).toBe(0);
      await fx.clock.advance(10 * 60 * 1000);

      expect(fx.texts).toHaveLength(0);
      expect(fx.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);
      expect(fx.logs.some((line) => line['event'] === 'attachment_nudge_suppressed')).toBe(false);

      await fx.server.handler(textMessage('m-text-1', '1'));
      expect(fx.injections[0]!.some((text) => text.startsWith('[系统主动提示]'))).toBe(false);
    } finally {
      await fx.server.close();
    }
  });

  it('⑧ 用户话术与注入文本不出现路径、不出现行数据', async () => {
    const fx = await makeFixture();
    try {
      const rowData = 'row-data-secret-9f3a';
      const attachment = attachmentMessage({
        dir: fx.dir,
        messageId: 'm-file-1',
        filename: '含行数据.xlsx',
        bytes: Buffer.from(`姓名,金额\n${rowData},100`),
      });
      const attachmentPath = attachment.attachments![0]!.path;
      const reply1 = await fx.server.handler(attachment);
      await fx.clock.advance(NUDGE_AFTER_MS);
      const reply2 = await fx.server.handler(textMessage('m-text-1', '1'));

      const surfaces = [reply1, reply2, ...fx.texts, ...fx.injections.flat()];
      for (const surface of surfaces) {
        expect(surface).not.toContain(fx.dir);
        expect(surface).not.toContain(attachmentPath);
        expect(surface).not.toContain(rowData);
        expect(surface).not.toContain('attachments');
      }
    } finally {
      await fx.server.close();
    }
  });

  it('⑨ 写类选项仅在 allowWriteOperations=true 时列出', async () => {
    const readOnly = await makeFixture({ runtime: { attachmentNudgeAfterMs: NUDGE_AFTER_MS, allowWriteOperations: false } });
    try {
      await readOnly.server.handler(attachmentMessage({ dir: readOnly.dir, messageId: 'm-file-1', filename: '名册.xlsx' }));
      await readOnly.clock.advance(NUDGE_AFTER_MS);
      expect(readOnly.texts).toHaveLength(1);
      expect(readOnly.texts[0]).not.toMatch(/生成|新建|改写/);
    } finally {
      await readOnly.server.close();
    }

    const writable = await makeFixture({ runtime: { attachmentNudgeAfterMs: NUDGE_AFTER_MS, allowWriteOperations: true } });
    try {
      await writable.server.handler(attachmentMessage({ dir: writable.dir, messageId: 'm-file-1', filename: '名册.xlsx' }));
      await writable.clock.advance(NUDGE_AFTER_MS);
      expect(writable.texts).toHaveLength(1);
      expect(writable.texts[0]).toMatch(/生成/);
    } finally {
      await writable.server.close();
    }
  });

  it('补充：非 live 投递 → suppressed 事件、绝不记 sent、零真实投递、无系统注记', async () => {
    const port = silentPort();
    const fx = await makeFixture({ port });
    try {
      await fx.server.handler(attachmentMessage({ dir: fx.dir, messageId: 'm-file-1', filename: '名册.xlsx' }));
      await fx.clock.advance(NUDGE_AFTER_MS);

      expect(port.texts).toHaveLength(0);
      const suppressed = fx.logs.filter((line) => line['event'] === 'attachment_nudge_suppressed');
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0]!['deliveryMode']).toBe('silent');
      expect(fx.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);

      await fx.server.handler(textMessage('m-text-1', '1'));
      expect(fx.injections[0]!.some((text) => text.startsWith('[系统主动提示]'))).toBe(false);
    } finally {
      await fx.server.close();
    }
  });
});
