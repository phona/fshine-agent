/**
 * B1 会话持久化 独立存储层测试（确定性、零真实模型、零网络）。
 *
 * 复用 Pi 公开持久化（`JsonlSessionRepo` + Pi `NodeExecutionEnv` 文件系统），只验证本层
 * 需要保证的五类不变量：
 *   ① 原子恢复：崩溃留下的半行/半建状态不留半态，恢复到最后一个完整提交；
 *   ② principal/session 隔离：同名 sessionId 也跨 principal 不通读；
 *   ③ 损坏显式报错：坏行/坏头**拒绝加载**，不静默回落；
 *   ④ 不重放任务：恢复是纯读（文件字节不变、无新写入），且本层无任何执行入口；
 *   ⑤ 不复制任务事实：落盘只有 Pi session entry，无任何任务台账字段。
 *
 * 每个用例用独立临时目录（真实文件系统），不依赖外部平台或模型。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Usage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';

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

const roots: string[] = [];
const layers: SessionPersistence[] = [];

function newRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sessp-'));
  roots.push(root);
  return root;
}

function layerAt(root: string): SessionPersistence {
  const layer = new SessionPersistence({ rootDir: root, cwd: '/workspace', now: () => 1_000_000 });
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

describe('B1 会话持久化（独立存储层；复用 Pi JsonlSessionRepo）', () => {
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

      // 修复后文件以换行收尾（Pi 已原子重写为完整状态），可继续追加且不重放旧内容。
      expect(readFileSync(session.filePath, 'utf8').endsWith('\n')).toBe(true);
      await reopened.append(user('m4'));
      expect(await texts(reopened)).toEqual(['m1', 'm2', 'm4']);
    });

    it('崩溃停在「已建文件、未建 branch」之间也能恢复（幂等补齐，无半态）', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const session = await layer.openOrCreate('alice', 'sess');
      await session.append(user('m1'));
      await layer.close();

      // 只保留 header 行：模拟文件已建、branch tip 尚未写入的中间态。
      const headerLine = readFileSync(session.filePath, 'utf8').split('\n')[0];
      writeFileSync(session.filePath, `${headerLine ?? ''}\n`);

      const restarted = layerAt(root);
      const reopened = await restarted.openOrCreate('alice', 'sess');
      expect(await reopened.readTranscript()).toEqual([]);
      await reopened.append(user('fresh'));
      expect(await texts(reopened)).toEqual(['fresh']);
    });

    it('原子建仓：create 走临时文件 + rename，落盘后不残留 .tmp', async () => {
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

  describe('③ 损坏显式报错（不作静默回落掩盖）', () => {
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

  describe('④ 不重放任务（恢复是纯读，且无执行入口）', () => {
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

  describe('⑤ 不复制任务事实（任务真相仍在既有 SQLite 账本）', () => {
    it('落盘仅含 Pi session entry，无任何任务台账字段', async () => {
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

      const lines = raw.trim().split('\n');
      const header = JSON.parse(lines[0] ?? '{}') as { kind?: string };
      expect(header.kind).toBe('header');

      for (const line of lines.slice(1)) {
        const parsed = JSON.parse(line);
        const writes = Array.isArray(parsed) ? parsed : [parsed];
        for (const write of writes as Array<Record<string, unknown>>) {
          expect(['entry', 'value', 'list', 'usage']).toContain(write.kind);
          if (write.kind === 'entry') {
            expect(write.type).toBe('message'); // 只落 Pi message entry，非任务事实
          }
        }
      }
    });
  });
});
