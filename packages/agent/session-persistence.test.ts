/**
 * B1 会话持久化 独立存储层测试（确定性、零真实模型、零网络）。
 *
 * 底层是 Pi 1.5.2 root 公开的 `SessionManager`；本层只验证自己承担的保证：
 *   ① 原子恢复：崩溃留下的半行/半建状态不留半态，恢复到最后一个完整提交；
 *   ② principal/session 隔离：同名 sessionId 也跨 principal 不通读（物理分目录）；
 *   ③ (principalId, sessionId) 唯一映射：同一对键只有一个会话文件，非法/冲突 id 显式报错；
 *   ④ 损坏显式报错：坏行/坏头**拒绝加载**，不静默回落、不静默重建；
 *   ⑤ 恢复不重放：打开会话不触发任何工具/执行（假执行层计数为 0），且本层无执行入口；
 *   ⑥ 不复制任务事实：落盘只有 Pi session entry，无任何任务台账字段。
 *
 * 每个用例用独立临时目录（真实文件系统），不依赖外部平台或模型。
 */
import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Usage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { afterEach, describe, expect, it } from 'vitest';

import type { DriverMessage } from './src/driver-contract';
import { createSession } from './src/execution-runtime';
import { SessionPersistence, type PersistedSession } from './src/session-persistence';

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = 1): AgentMessage {
  return { role: 'user', content: text, timestamp };
}

function assistant(text: string, timestamp = 2): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test-model',
    usage: ZERO_USAGE,
    stopReason: 'stop',
    timestamp,
  };
}

function assistantToolCall(id: string, name: string, timestamp = 3): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test-model',
    usage: ZERO_USAGE,
    stopReason: 'toolUse',
    timestamp,
  };
}

function toolResult(toolCallId: string, text: string, timestamp = 4): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'dummy.query',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  };
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

/** 假执行层：只计数，不产生副作用（用于证明打开会话不触发执行）。 */
class CountingExecutionClient implements ExecutionClient {
  executions = 0;

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(): Promise<ExecutionOutcome> {
    this.executions += 1;
    return { status: 'completed', data: {} };
  }
}

const roots: string[] = [];
const layers: SessionPersistence[] = [];
function newRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sessp-'));
  roots.push(root);
  return root;
}

function layerAt(root: string): SessionPersistence {
  const layer = new SessionPersistence({ rootDir: root, cwd: '/workspace' });
  layers.push(layer);
  return layer;
}

async function texts(session: PersistedSession): Promise<string[]> {
  const transcript = await session.readTranscript();
  return transcript.map((message) => {
    if (message.role === 'user') {
      return typeof message.content === 'string' ? message.content : '[user-content]';
    }
    if (message.role === 'assistant') {
      const first = message.content[0];
      return first !== undefined && first.type === 'text' ? first.text : `[assistant:${first?.type ?? 'empty'}]`;
    }
    return '[toolResult]';
  });
}

afterEach(async () => {
  for (const layer of layers) await layer.close().catch(() => undefined);
  layers.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('B1 会话持久化（独立存储层；底层 Pi SessionManager）', () => {
  describe('① 原子恢复（崩溃安全，不留半态）', () => {
    it('readTranscript 每次现读并返回独立副本，层内不留可变转录缓存（Pi Session 是唯一所有者）', async () => {
      const layer = layerAt(newRoot());
      const session = await layer.openOrCreate('p', 'c');
      await session.append(user('a'));

      const first = await session.readTranscript();
      first.length = 0; // 篡改读回的数组
      const second = await session.readTranscript();
      expect(second).not.toBe(first);
      expect(await texts(session)).toEqual(['a']); // 存储不受返回值篡改影响
    });

    it('崩溃留下的半行被丢弃，恢复到最后一个完整提交，且文件被修复为完整状态', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('alice', 'sess');
      await session.append(user('m1'));
      await session.append(user('m2'));
      await session.append(user('m3'));
      await layer.close();

      // 模拟追加中途崩溃：去掉换行并把最后一行截半（= 不完整的 torn 半行）。
      const raw = readFileSync(session.filePath, 'utf8');
      writeFileSync(session.filePath, raw.slice(0, raw.length - 12));

      const restarted = layerAt(root);
      const reopened = await restarted.openOrCreate('alice', 'sess');
      expect(await texts(reopened)).toEqual(['m1', 'm2']); // 未完成的最后一条被丢弃

      // 修复后文件以换行收尾（本层把 torn 尾行截断到最后一个完整行），可继续追加且不重放旧内容。
      expect(readFileSync(session.filePath, 'utf8').endsWith('\n')).toBe(true);
      await reopened.append(user('m4'));
      expect(await texts(reopened)).toEqual(['m1', 'm2', 'm4']);
    });

    it('崩溃停在「已建文件、尚未写入任何 entry」之间也能恢复（不重建、不半态）', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('alice', 'sess');
      await session.append(user('m1'));
      await layer.close();

      // 只保留 header 行：模拟 header 已落盘、首条 entry 尚未写入的中间态。
      const headerLine = readFileSync(session.filePath, 'utf8').split('\n')[0];
      writeFileSync(session.filePath, `${headerLine ?? ''}\n`);

      const restarted = layerAt(root);
      const reopened = await restarted.openOrCreate('alice', 'sess');
      expect(await reopened.readTranscript()).toEqual([]);
      await reopened.append(user('fresh'));
      expect(await texts(reopened)).toEqual(['fresh']);
    });

    it('建仓只落一个 .jsonl 文件、不残留临时文件', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('alice', 'sess');
      await session.append(user('m1'));

      const dir = path.dirname(session.filePath);
      expect(existsSync(`${session.filePath}.tmp`)).toBe(false);
      const files = readdirSync(dir);
      expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
      expect(files.filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    });
  });

  describe('② principal/session 隔离（不跨 principal 串读）', () => {
    it('同名 sessionId 在不同 principal 下物理隔离、互不可见', async () => {
      const layer = layerAt(newRoot());
      const alice = await layer.openOrCreate('alice', 'shared-id');
      await alice.append(user('alice-msg'));

      const bob = await layer.openOrCreate('bob', 'shared-id');
      expect(await bob.readTranscript()).toEqual([]); // 同 id、不同 principal → 空
      expect(bob.filePath).not.toBe(alice.filePath);

      await bob.append(user('bob-msg'));
      expect(await texts(alice)).toEqual(['alice-msg']); // alice 不受影响
      expect(await texts(bob)).toEqual(['bob-msg']);

      // 两个 principal 的 list 各自只看自己的子树。
      expect((await layer.list('alice')).map((m) => m.id)).toEqual(['shared-id']);
      expect((await layer.list('bob')).map((m) => m.id)).toEqual(['shared-id']);
    });

    it('同一 principal 下不同 sessionId 互不串读', async () => {
      const layer = layerAt(newRoot());
      const s1 = await layer.openOrCreate('alice', 's1');
      await s1.append(user('one'));
      const s2 = await layer.openOrCreate('alice', 's2');
      expect(await s2.readTranscript()).toEqual([]);
      expect(await texts(s1)).toEqual(['one']);
    });
  });

  describe('③ (principalId, sessionId) 唯一映射（同一对键只有一个会话；非法/冲突 id 显式报错）', () => {
    it('同一对键重复打开返回同一句柄与同一文件（不新建第二份）', async () => {
      const layer = layerAt(newRoot());
      const first = await layer.openOrCreate('alice', 's');
      await first.append(user('a'));

      const second = await layer.openOrCreate('alice', 's');
      expect(second).toBe(first);
      expect(second.filePath).toBe(first.filePath);
      expect((await layer.list('alice')).filter((m) => m.id === 's')).toHaveLength(1);
    });

    it('进程重启后同一对键仍解析到同一文件（不新建第二份）', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const first = await layer.openOrCreate('alice', 's');
      await first.append(user('a'));
      const filePath = first.filePath;
      await layer.close();

      const restarted = layerAt(root);
      const reopened = await restarted.openOrCreate('alice', 's');
      expect(reopened.filePath).toBe(filePath);
      expect(readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
      expect(await texts(reopened)).toEqual(['a']);
    });

    it('同一 id 出现两份会话文件 → 显式冲突报错（不静默挑一个）', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('alice', 'dup');
      await session.append(user('a'));
      await layer.close();

      const duplicate = path.join(path.dirname(session.filePath), '2000-01-01T00-00-00-000Z_dup.jsonl');
      copyFileSync(session.filePath, duplicate);

      const restarted = layerAt(root);
      await expect(restarted.openOrCreate('alice', 'dup')).rejects.toThrow(
        /Conflicting session files for \(alice, dup\)/,
      );
    });

    it('业务 id 含 Pi 不允许的字符（如 wecom:conv-1）仍按对键唯一映射，list 回原 id', async () => {
      const layer = layerAt(newRoot());
      const session = await layer.openOrCreate('alice', 'wecom:conv-1');
      await session.append(user('hi'));

      expect(await texts(session)).toEqual(['hi']);
      expect((await layer.list('alice')).map((m) => m.id)).toEqual(['wecom:conv-1']);
      expect(await texts(await layer.openOrCreate('alice', 'wecom:conv-1'))).toEqual(['hi']);
    });

    it('非法 session id → 显式报错（不落盘、不改名重试）', async () => {
      const layer = layerAt(newRoot());
      await expect(layer.openOrCreate('alice', '')).rejects.toThrow(/must be non-empty/);
      await expect(layer.openOrCreate('alice', 'bad\u0000id')).rejects.toThrow(/must not contain NUL/);
      expect(await layer.list('alice')).toEqual([]);
    });
  });

  describe('④ 损坏显式报错（不作静默回落掩盖）', () => {
    it('完整行但非法 JSON → 拒绝加载并指明行号', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('p', 'c');
      await session.append(user('a'));
      await session.append(user('b'));
      await session.append(user('c'));
      await layer.close();

      const lines = readFileSync(session.filePath, 'utf8').split('\n');
      lines[1] = '{ this is not json'; // 第 2 行（首个事务）整行损坏，仍以换行收尾
      writeFileSync(session.filePath, lines.join('\n'));

      const restarted = layerAt(root);
      await expect(restarted.openOrCreate('p', 'c')).rejects.toThrow(/Invalid JSONL storage .*line 2/);
    });

    it('非法 header → 拒绝加载', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('p', 'c');
      await session.append(user('a'));
      await layer.close();

      const lines = readFileSync(session.filePath, 'utf8').split('\n');
      lines[0] = '{"nope":true}';
      writeFileSync(session.filePath, lines.join('\n'));

      const restarted = layerAt(root);
      await expect(restarted.openOrCreate('p', 'c')).rejects.toThrow(/invalid header/);
    });

    it('空文件（丢 header）→ 拒绝加载', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('p', 'c');
      await session.append(user('a'));
      await layer.close();

      writeFileSync(session.filePath, '');
      const restarted = layerAt(root);
      await expect(restarted.openOrCreate('p', 'c')).rejects.toThrow(/missing header/);
    });
  });

  describe('⑤ 恢复不重放（打开会话不触发工具/执行；本层无执行入口）', () => {
    it('恢复含 toolCall/toolResult 的转录逐字返回，恢复过程零写入，续写从存储 tip 接续', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('p', 'c');
      const stored: AgentMessage[] = [
        user('do the thing'),
        assistantToolCall('tc1', 'dummy.query'),
        toolResult('tc1', 'ok'),
      ];
      for (const message of stored) await session.append(message);
      await layer.close();

      const before = readFileSync(session.filePath, 'utf8');

      const restarted = layerAt(root);
      const reopened = await restarted.openOrCreate('p', 'c');
      const restored = await reopened.readTranscript();
      expect(restored).toEqual(stored); // 逐字，含 toolCall/toolResult

      // 恢复是纯读：文件字节完全不变（未重放、未追加、未重写）。
      expect(readFileSync(session.filePath, 'utf8')).toBe(before);

      // 续写从存储 tip 接续（新条目挂在上一个 tip 之后），而不是重放旧回合。
      await reopened.append(user('next'));
      expect((await reopened.readTranscript()).length).toBe(stored.length + 1);

      // 本层不暴露任何执行/重放入口（任务重放无处发生）。
      for (const name of ['run', 'execute', 'resume', 'replay', 'start']) {
        expect((reopened as unknown as Record<string, unknown>)[name]).toBeUndefined();
        expect((restarted as unknown as Record<string, unknown>)[name]).toBeUndefined();
      }
    });

    it('用存储句柄装配 runtime：打开/载入不触发假执行层，也不触发模型驱动回合', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('p', 'c');
      await session.append(user('do the thing'));
      await session.append(assistantToolCall('tc1', 'dummy.query'));
      await session.append(toolResult('tc1', 'ok'));
      await layer.close();

      const client = new CountingExecutionClient();
      const driverRuns: DriverMessage[][] = [];
      const restarted = layerAt(root);
      const store = await restarted.openOrCreate('p', 'c');
      const runtime = await createSession({
        principalId: 'p',
        sessionId: 'c',
        client,
        allowedOperations: ['dummy.query'],
        mainDriver: {
          async run(input) {
            driverRuns.push([...input.messages]);
            return { text: '', messages: [...input.messages] };
          },
        },
        workerDriver: {
          async run() {
            throw new Error('（测试）worker 不应被调用');
          },
        },
        mainSystemPrompt: '你是测试主 Agent。',
        transcriptStore: store,
        onTranscriptError: () => undefined,
      });

      // 打开 + 载入转录：零执行、零模型回合。
      expect(client.executions).toBe(0);
      expect(driverRuns).toHaveLength(0);
      // 载入的转录就是存储里的三条（toolCall/toolResult 未被重放成执行）。
      expect(runtime.transcript().map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'toolResult',
      ]);
    });
  });

  describe('增长特性（复用 Pi 单条 entry 追加日志 = 线性；非被否证的每回合全量快照 O(n²)）', () => {
    it('追加 N 条后再追加 N 条：文件近似线性增长，且旧字节前缀不变（追加式，无整文件重写）', async () => {
      const layer = layerAt(newRoot());
      const session = await layer.openOrCreate('p', 'c');
      const body = 'x'.repeat(200);
      const N = 40;

      for (let i = 0; i < N; i += 1) await session.append(user(`${body}-${i}`));
      const size1 = statSync(session.filePath).size;
      const prefix = readFileSync(session.filePath);

      for (let i = 0; i < N; i += 1) await session.append(user(`${body}-${N + i}`));
      const size2 = statSync(session.filePath).size;

      // 线性：追加数翻倍 → 文件大小约翻倍（全量快照累计会是 ~4x）。
      expect(size2 / size1).toBeLessThan(2.5);
      expect(size2 / size1).toBeGreaterThan(1.5);

      // 追加式：已提交的旧字节在前缀处逐字节不变（没有任何「每回合重写全文」）。
      const after = readFileSync(session.filePath);
      expect(after.subarray(0, prefix.length).equals(prefix)).toBe(true);
    });
  });

  describe('⑥ 不复制任务事实（任务真相仍在既有 SQLite 账本）', () => {
    it('落盘仅含 Pi session header + message entry，无任何任务台账字段', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('p', 'c');
      await session.append(user('hello'));
      await session.append(assistant('world'));
      await layer.close();

      const raw = readFileSync(session.filePath, 'utf8');

      // 任务台账字段（task-store 的列名/原因/表名）一个都不许出现。
      const taskLedgerTokens = [
        'lease_owner',
        'lease_until',
        'pending_question',
        'waiting_since',
        'task_no',
        'reply_text',
        'result_unknown',
        'task_sequences',
        'executions',
      ];
      for (const token of taskLedgerTokens) {
        expect(raw).not.toContain(token);
      }

      // 1.5.2 落盘形状：首行 Pi session header，其余每行一条 Pi message entry。
      const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const header = lines[0]!;
      expect(header['type']).toBe('session');
      // Pi 1.5.2 只接受 [A-Za-z0-9._-] 的会话 id（B1 把业务 id 可逆映射进来）。
      expect(header['id']).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
      expect(typeof header['cwd']).toBe('string');

      const entries = lines.slice(1);
      expect(entries).toHaveLength(2); // 用户 + 助手各一条
      for (const entry of entries) {        expect(entry['type']).toBe('message'); // 只落 Pi message entry，非任务事实
        expect(typeof entry['id']).toBe('string');
        expect(typeof entry['timestamp']).toBe('string');
        const message = entry['message'] as Record<string, unknown>;
        expect(['user', 'assistant', 'toolResult', 'system']).toContain(message['role']);
        // 除 Pi entry 自身字段外不夹带任何宿主字段（任务事实无从落盘）。
        for (const key of Object.keys(entry)) {
          expect(['type', 'id', 'parentId', 'timestamp', 'message']).toContain(key);
        }
      }
    });
  });
});
