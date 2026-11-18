/**
 * 会话文件定位层测试（确定性、零真实模型、零网络）。
 *
 * 本层只承担**确定性**责任（转录归 Pi）：`(principalId, sessionId)` → 唯一文件位置 + 落盘校验。
 * 验证：
 *   ① 原子恢复：崩溃留下的半行/半建状态不留半态，恢复到最后一个完整提交；
 *   ② principal/session 隔离：同名 sessionId 也跨 principal 不通读（物理分目录）；
 *   ③ (principalId, sessionId) 唯一映射：同一对键只有一个会话文件，非法/冲突 id 显式报错；
 *   ④ 损坏显式报错：坏行/坏头**拒绝加载**，不静默回落、不静默重建；
 *   ⑤ 恢复不重放：解析是纯读（不触工具/执行/模型），本层无执行/写入入口；
 *   ⑥ 不复制任务事实：落盘只有 Pi session entry，无任何任务台账字段。
 *
 * 落盘内容的写入方是 Pi 自己（`SessionManager`，本文件用 root 公开 API 生产同形文件）；
 * 「宿主回合后不搬运消息」「摘要跨重启存活」由 `pi-native-session-persistence.test.ts` 守卫。
 */
import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionPersistence, type MainSessionLocation } from './src/session-persistence';

const CWD = '/workspace';
type SessionMessage = Parameters<SessionManager['appendMessage']>[0];

const user = (text: string): SessionMessage => ({ role: 'user', content: text, timestamp: 1 }) as unknown as SessionMessage;
const assistant = (text: string): SessionMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 2,
  }) as unknown as SessionMessage;

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sessp-'));
  roots.push(root);
  return root;
}

function layerAt(root: string): SessionPersistence {
  return new SessionPersistence({ rootDir: root });
}

/** 生产同源写入方：Pi 自己的 `SessionManager`（新建用解析出的 id，恢复用解析出的文件）。 */
function piSession(location: MainSessionLocation): SessionManager {
  return location.resumeSessionFile === undefined
    ? SessionManager.create(CWD, location.sessionDir, { id: location.piSessionId })
    : SessionManager.open(location.resumeSessionFile, location.sessionDir, CWD);
}

/** 读回 Pi 会话里模型可见的 message 文本（Pi entry-log 投影，非本层的副本）。 */
function transcriptTexts(filePath: string, sessionDir: string): string[] {
  const manager = SessionManager.open(filePath, sessionDir, CWD);
  return manager
    .getBranch()
    .filter((entry): entry is Extract<typeof entry, { type: 'message' }> => entry.type === 'message')
    .map((entry) => {
      const message = entry.message as { role?: string; content?: unknown };
      if (typeof message.content === 'string') return message.content;
      const first = Array.isArray(message.content) ? message.content[0] as { text?: unknown } | undefined : undefined;
      return typeof first?.text === 'string' ? first.text : `[${message.role ?? 'unknown'}]`;
    });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('会话文件定位（Pi 原生会话；本层只解析位置 + 校验）', () => {
  describe('① 原子恢复（崩溃安全，不留半态）', () => {
    it('崩溃留下的半行被丢弃，恢复到最后一个完整提交，且文件被修复为完整状态', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('alice', 'sess');
      const manager = piSession(location);
      manager.appendMessage(user('m1'));
      manager.appendMessage(user('m2'));
      manager.appendMessage(user('m3'));
      const filePath = manager.getSessionFile()!;

      // 模拟追加中途崩溃：去掉换行并把最后一行截半（= 不完整的 torn 半行）。
      const raw = readFileSync(filePath, 'utf8');
      writeFileSync(filePath, raw.slice(0, raw.length - 12));

      const reopened = layerAt(root).resolve('alice', 'sess');
      expect(reopened.resumeSessionFile).toBe(filePath);
      expect(transcriptTexts(filePath, reopened.sessionDir)).toEqual(['m1', 'm2']); // 未完成的最后一条被丢弃

      // 修复后文件以换行收尾（torn 尾行被截断到最后一个完整行），可继续追加且不重放旧内容。
      expect(readFileSync(filePath, 'utf8').endsWith('\n')).toBe(true);
      piSession(reopened).appendMessage(user('m4'));
      expect(transcriptTexts(filePath, reopened.sessionDir)).toEqual(['m1', 'm2', 'm4']);
    });

    it('崩溃停在「已建文件、尚未写入任何 message」之间也能恢复（不重建、不半态）', async () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('alice', 'sess');
      const manager = piSession(location);
      manager.appendMessage(user('m1'));
      const filePath = manager.getSessionFile()!;

      // 只保留 header 行：模拟 header 已落盘、首条 message entry 尚未写入的中间态。
      const headerLine = readFileSync(filePath, 'utf8').split('\n')[0];
      writeFileSync(filePath, `${headerLine ?? ''}\n`);

      const reopened = layerAt(root).resolve('alice', 'sess');
      expect(reopened.resumeSessionFile).toBe(filePath);
      expect(transcriptTexts(filePath, reopened.sessionDir)).toEqual([]);
      piSession(reopened).appendMessage(user('fresh'));
      expect(transcriptTexts(filePath, reopened.sessionDir)).toEqual(['fresh']);
    });

    it('解析只建 principal 子树、不预建文件；写入后只落一个 .jsonl、不残留临时文件', () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('alice', 'sess');
      expect(location.resumeSessionFile, '未写入前没有会话文件（Pi 首条消息才落盘）').toBeUndefined();
      expect(existsSync(location.sessionDir), 'principal 子树必须已建').toBe(true);

      const manager = piSession(location);
      manager.appendMessage(user('m1'));
      const filePath = manager.getSessionFile()!;
      const dir = path.dirname(filePath);
      expect(existsSync(`${filePath}.tmp`)).toBe(false);
      const files = readdirSync(dir);
      expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
      expect(files.filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    });
  });

  describe('② principal/session 隔离（不跨 principal 串读）', () => {
    it('同名 sessionId 在不同 principal 下物理隔离、互不可见', () => {
      const layer = layerAt(newRoot());
      const alice = layer.resolve('alice', 'shared-id');
      const aliceManager = piSession(alice);
      aliceManager.appendMessage(user('alice-msg'));
      const aliceFile = aliceManager.getSessionFile()!;

      const bob = layer.resolve('bob', 'shared-id');
      expect(bob.sessionDir).not.toBe(alice.sessionDir);
      expect(bob.resumeSessionFile, '同 id、不同 principal → 看不到 alice 的文件').toBeUndefined();

      const bobManager = piSession(bob);
      bobManager.appendMessage(user('bob-msg'));
      const bobFile = bobManager.getSessionFile()!;
      expect(bobFile).not.toBe(aliceFile);
      expect(transcriptTexts(aliceFile, alice.sessionDir)).toEqual(['alice-msg']); // alice 不受影响
      expect(transcriptTexts(bobFile, bob.sessionDir)).toEqual(['bob-msg']);

      // 两个 principal 的 list 各自只看自己的子树。
      expect(layer.list('alice').map((m) => m.id)).toEqual(['shared-id']);
      expect(layer.list('bob').map((m) => m.id)).toEqual(['shared-id']);
    });

    it('同一 principal 下不同 sessionId 互不串读', () => {
      const layer = layerAt(newRoot());
      const s1 = layer.resolve('alice', 's1');
      piSession(s1).appendMessage(user('one'));
      const s2 = layer.resolve('alice', 's2');
      expect(s2.piSessionId).not.toBe(s1.piSessionId);
      expect(s2.resumeSessionFile).toBeUndefined();
      expect(transcriptTexts(layer.resolve('alice', 's1').resumeSessionFile!, s1.sessionDir)).toEqual(['one']);
    });
  });

  describe('③ (principalId, sessionId) 唯一映射（同一对键只有一个会话；非法/冲突 id 显式报错）', () => {
    it('同一对键重复解析返回同一位置（不新建第二份）', () => {
      const layer = layerAt(newRoot());
      const first = layer.resolve('alice', 's');
      const manager = piSession(first);
      manager.appendMessage(user('a'));
      const filePath = manager.getSessionFile()!;

      const second = layer.resolve('alice', 's');
      expect(second.piSessionId).toBe(first.piSessionId);
      expect(second.resumeSessionFile).toBe(filePath);
      expect(layer.list('alice').filter((m) => m.id === 's')).toHaveLength(1);
    });

    it('进程重启后同一对键仍解析到同一文件（不新建第二份）', () => {
      const root = newRoot();
      const first = layerAt(root).resolve('alice', 's');
      const manager = piSession(first);
      manager.appendMessage(user('a'));
      const filePath = manager.getSessionFile()!;

      const reopened = layerAt(root).resolve('alice', 's');
      expect(reopened.resumeSessionFile).toBe(filePath);
      expect(readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
      expect(transcriptTexts(filePath, reopened.sessionDir)).toEqual(['a']);
    });

    it('同一 id 出现两份会话文件 → 显式冲突报错（不静默挑一个）', () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('alice', 'dup');
      const manager = piSession(location);
      manager.appendMessage(user('a'));
      const filePath = manager.getSessionFile()!;

      const duplicate = path.join(path.dirname(filePath), '2000-01-01T00-00-00-000Z_dup.jsonl');
      copyFileSync(filePath, duplicate);

      expect(() => layerAt(root).resolve('alice', 'dup')).toThrow(
        /Conflicting session files for \(alice, dup\)/,
      );
    });

    it('业务 id 含 Pi 不允许的字符（如 wecom:conv-1）仍按对键唯一映射，list 回原 id', () => {
      const layer = layerAt(newRoot());
      const location = layer.resolve('alice', 'wecom:conv-1');
      // 可逆映射：Pi 会话 id 合法（不含 ':'），且 list 能解回业务 id。
      expect(location.piSessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
      const manager = piSession(location);
      manager.appendMessage(user('hi'));
      expect(transcriptTexts(manager.getSessionFile()!, location.sessionDir)).toEqual(['hi']);
      expect(layer.list('alice').map((m) => m.id)).toEqual(['wecom:conv-1']);
    });

    it('非法 session id → 显式报错（不落盘、不改名重试）', () => {
      const layer = layerAt(newRoot());
      expect(() => layer.resolve('alice', '')).toThrow(/must be non-empty/);
      expect(() => layer.resolve('alice', 'bad\u0000id')).toThrow(/must not contain NUL/);
      expect(layer.list('alice')).toEqual([]);
    });
  });

  describe('④ 损坏显式报错（不作静默回落掩盖）', () => {
    it('完整行但非法 JSON → 拒绝加载并指明行号', () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('p', 'c');
      const manager = piSession(location);
      manager.appendMessage(user('a'));
      manager.appendMessage(user('b'));
      manager.appendMessage(user('c'));
      const filePath = manager.getSessionFile()!;

      const lines = readFileSync(filePath, 'utf8').split('\n');
      lines[1] = '{ this is not json'; // 第 2 行（首个事务）整行损坏，仍以换行收尾
      writeFileSync(filePath, lines.join('\n'));

      expect(() => layerAt(root).resolve('p', 'c')).toThrow(/Invalid JSONL storage .*line 2/);
    });

    it('非法 header → 拒绝加载', () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('p', 'c');
      const manager = piSession(location);
      manager.appendMessage(user('a'));
      const filePath = manager.getSessionFile()!;

      const lines = readFileSync(filePath, 'utf8').split('\n');
      lines[0] = '{"nope":true}';
      writeFileSync(filePath, lines.join('\n'));

      expect(() => layerAt(root).resolve('p', 'c')).toThrow(/invalid header/);
    });

    it('空文件（丢 header）→ 拒绝加载', () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('p', 'c');
      const manager = piSession(location);
      manager.appendMessage(user('a'));
      const filePath = manager.getSessionFile()!;

      writeFileSync(filePath, '');
      expect(() => layerAt(root).resolve('p', 'c')).toThrow(/missing header/);
    });

    it('半行（无换行收尾）不是损坏：显式截断修复，不静默清空', () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('p', 'c');
      const manager = piSession(location);
      manager.appendMessage(user('a'));
      const filePath = manager.getSessionFile()!;
      const before = readFileSync(filePath, 'utf8');
      writeFileSync(filePath, `${before}{"type":"message","id":"torn`);

      const repaired = layerAt(root).resolve('p', 'c');
      expect(repaired.resumeSessionFile).toBe(filePath);
      expect(transcriptTexts(filePath, repaired.sessionDir), '完整提交必须保留').toEqual(['a']);
      expect(readFileSync(filePath, 'utf8')).toBe(before);
    });
  });

  describe('⑤ 恢复不重放（解析不触工具/执行/模型；本层无执行/写入入口）', () => {
    it('解析是纯读：文件字节完全不变，且本层不暴露任何执行/写入入口', () => {
      const root = newRoot();
      const layer = layerAt(root);
      const location = layer.resolve('p', 'c');
      const manager = piSession(location);
      manager.appendMessage(user('do the thing'));
      manager.appendMessage(assistant('ok'));
      const filePath = manager.getSessionFile()!;
      const before = readFileSync(filePath, 'utf8');

      const reopened = layerAt(root).resolve('p', 'c');
      expect(reopened.resumeSessionFile).toBe(filePath);
      // 纯读：未重放、未追加、未重写。
      expect(readFileSync(filePath, 'utf8')).toBe(before);
      // 恢复后的上下文就是 Pi 的投影（恢复过程不触发任何执行/回合）。
      expect(transcriptTexts(filePath, reopened.sessionDir)).toEqual(['do the thing', 'ok']);

      // 本层不暴露任何执行/重放/搬运入口（任务重放与转录搬运无处发生）。
      for (const name of ['run', 'execute', 'resume', 'replay', 'start', 'append', 'readTranscript']) {
        expect((reopened as unknown as Record<string, unknown>)[name]).toBeUndefined();
        expect((layerAt(root) as unknown as Record<string, unknown>)[name]).toBeUndefined();
      }
    });
  });

  describe('增长特性（Pi 单条 entry 追加日志 = 线性；非每回合全量快照 O(n²)）', () => {
    it('追加 N 条后再追加 N 条：文件近似线性增长，且旧字节前缀不变（追加式，无整文件重写）', () => {
      const layer = layerAt(newRoot());
      const location = layer.resolve('p', 'c');
      const manager = piSession(location);
      const body = 'x'.repeat(200);
      const N = 40;

      for (let i = 0; i < N; i += 1) manager.appendMessage(user(`${body}-${i}`));
      const filePath = manager.getSessionFile()!;
      const size1 = statSync(filePath).size;
      const prefix = readFileSync(filePath);

      for (let i = 0; i < N; i += 1) manager.appendMessage(user(`${body}-${N + i}`));
      const size2 = statSync(filePath).size;

      // 线性：追加数翻倍 → 文件大小约翻倍（全量快照累计会是 ~4x）。
      expect(size2 / size1).toBeLessThan(2.5);
      expect(size2 / size1).toBeGreaterThan(1.5);

      // 追加式：已提交的旧字节在前缀处逐字节不变（没有任何「每回合重写全文」）。
      expect(readFileSync(filePath).subarray(0, prefix.length).equals(prefix)).toBe(true);
    });
  });

  describe('⑥ 不复制任务事实（任务真相仍在既有 SQLite 账本）', () => {
    it('落盘仅含 Pi session header + message entry，无任何任务台账字段', () => {
      const layer = layerAt(newRoot());
      const location = layer.resolve('p', 'c');
      const manager = piSession(location);
      manager.appendMessage(user('hello'));
      manager.appendMessage(assistant('world'));
      const filePath = manager.getSessionFile()!;

      const raw = readFileSync(filePath, 'utf8');

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

      // 1.5.2 落盘形状：首行 Pi session header，其余每行一条 Pi entry。
      const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const header = lines[0]!;
      expect(header['type']).toBe('session');
      // Pi 1.5.2 只接受 [A-Za-z0-9._-] 的会话 id（业务 id 可逆映射进来）。
      expect(header['id']).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
      expect(typeof header['cwd']).toBe('string');

      const entries = lines.slice(1);
      expect(entries).toHaveLength(2); // 用户 + 助手各一条
      for (const entry of entries) {
        expect(entry['type']).toBe('message'); // 只落 Pi message entry，非任务事实
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
