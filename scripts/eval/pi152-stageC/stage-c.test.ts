/**
 * 阶段 C：原生 SessionManager 能否替代 B1（确定性；零真实模型、零网络）。
 *
 * 判据见同目录 PREREG.md（写于首次实跑之前）。本文件只用：
 *   · `@earendil-works/pi-coding-agent` root 公开导出（SessionManager）；
 *   · 本 worktree 产品驱动（createPiTurnDriver）+ 脚本化 ModelRuntime 夹具；
 *   · 主仓 0.85.1 公开子路径只读生成的旧 B1 格式产物（一次性，临时目录内）。
 * 不删除、不修改 B1；不 deep-import dist；不复制 Pi 源码。
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createPiTurnDriver, piCompactionSettings } from '../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../packages/agent/testing/scripted-model-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CRASH_FIXTURE = path.join(__dirname, 'fixtures', 'stage-c-crash.ts');
const RESUME_FIXTURE = path.join(__dirname, 'fixtures', 'stage-c-resume-turn.ts');
const OLD_RECORD_FIXTURE = path.join(__dirname, 'fixtures', 'old-b1-record.mjs');
const OLD_PI_PACKAGE = '/home/tao/projects/fshine-agent/node_modules/@earendil-works/pi-agent-core';
const SUMMARY_MARKER = '【此前会话摘要】';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const user = (text: string, ts = 1): Message => ({ role: 'user', content: text, timestamp: ts } as unknown as Message);
function asst(content: unknown[], stopReason = 'stop', usageTotal = 15): Message {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: {
      input: usageTotal, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: usageTotal,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason, timestamp: Date.now(),
  } as unknown as Message;
}
const textReply = (text: string): Message => asst([{ type: 'text', text }]);
const messagesOf = (cm: SessionManager): AgentMessage[] => cm.buildSessionContext().messages;
const textOf = (m: AgentMessage): string => {
  const content = (m as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b as { text?: string }).text ?? '').join('');
  }
  return '';
};
const textsOf = (ms: readonly AgentMessage[]): string[] => ms.map(textOf).filter((t) => t.length > 0);
const sessionFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));

function spawnFixture(script: string, args: string[]): { signal?: string; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: process.env.TMPDIR || tmpdir() },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { stdout };
  } catch (error) {
    const e = error as { signal?: string; stdout?: string };
    return { signal: e.signal, stdout: e.stdout ?? '' };
  }
}

// ───────────────────────────────────────────── ① (principalId, sessionId) 唯一映射
describe('① 唯一映射', () => {
  it('同 id 重复 create 产生第二个文件；findById 只返回其中一个（原生命名含时间戳）', () => {
    const ws = tempDir('c1-ws');
    const dir = tempDir('c1-dir');
    const first = SessionManager.create(ws, dir, { id: 'sess-alpha' });
    first.appendMessage(user('alice 的第一条'));
    const firstFile = first.getSessionFile();
    expect(firstFile).toBeTruthy();

    const duplicate = SessionManager.create(ws, dir, { id: 'sess-alpha' });
    duplicate.appendMessage(user('重复 create 的第二条'));

    const files = sessionFiles(dir);
    expect(files.length, '同一 id 被落成两个文件').toBe(2);
    const resolved = SessionManager.findById(ws, 'sess-alpha', dir);
    expect(resolved, 'findById 能找到（但不唯一）').toBeTruthy();
    const resolvedText = textsOf(messagesOf(SessionManager.open(resolved!, dir)));
    expect(resolvedText.length, '返回的是其中一份转录').toBe(1);
    console.log('STAGE-C-①', JSON.stringify({ files: files.length, findById: path.basename(resolved!), resolvedTextCount: resolvedText.length }));
  });

  it('宿主自持「键 → 文件路径」+ 哈希 id 时可达唯一（非原生能力）', () => {
    const ws = tempDir('c1b-ws');
    const dir = tempDir('c1b-dir');
    const key = 'alice\u0000wecom:conv1';
    const id = `s_${Buffer.from(key).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
    // 渠道 sessionId 原文不能直接当 Pi id：
    expect(() => SessionManager.create(ws, dir, { id: 'wecom:conv1' })).toThrow(/Session id must be/);

    const first = SessionManager.create(ws, dir, { id });
    first.appendMessage(user('第一条'));
    const file = first.getSessionFile()!;
    // 重启：先 findById，命中就 open，不 create。
    const hit = SessionManager.findById(ws, id, dir);
    expect(hit).toBe(file);
    SessionManager.open(hit!, dir).appendMessage(user('第二条'));
    const reopened = SessionManager.open(file, dir);
    expect(textsOf(messagesOf(reopened))).toEqual(['第一条', '第二条']);
    expect(sessionFiles(dir).length).toBe(1);
  });
});

// ───────────────────────────────────────────── ② 同一会话单写者
describe('② 单写者', () => {
  it('两个独立句柄交叉追加：不报错，重开后另一分支静默丢失', () => {
    const ws = tempDir('c2-ws');
    const dir = tempDir('c2-dir');
    const seed = SessionManager.create(ws, dir, { id: 'sess-w' });
    seed.appendMessage(user('u1'));
    const file = seed.getSessionFile()!;

    const a = SessionManager.open(file, dir);
    const b = SessionManager.open(file, dir);
    a.appendMessage(user('u2-from-A'));
    b.appendMessage(user('u3-from-B'));

    const reopened = SessionManager.open(file, dir);
    const onDisk = reopened.getEntries().filter((e) => e.type === 'message');
    const context = textsOf(messagesOf(reopened));
    expect(onDisk.length, '磁盘上有 3 条 message entry').toBe(3);
    expect(context, '上下文只含 u1 与最后写入的 u3').toEqual(['u1', 'u3-from-B']);
    expect(context, 'A 的写入被静默丢弃').not.toContain('u2-from-A');
    console.log('STAGE-C-②', JSON.stringify({ onDiskMessageEntries: onDisk.length, contextTexts: context }));
  });
});

// ───────────────────────────────────────────── ③ 跨 principal 隔离
describe('③ 跨 principal 隔离', () => {
  it('同一 sessionDir 下同 sessionId：B 读到 A 的转录（无原生 principal 维度）', () => {
    const ws = tempDir('c3-ws');
    const dir = tempDir('c3-dir');
    const alice = SessionManager.create(ws, dir, { id: 'conv-shared' });
    alice.appendMessage(user('alice 的私密内容'));

    const bobHit = SessionManager.findById(ws, 'conv-shared', dir);
    expect(bobHit, 'B 的 findById 命中 A 的文件').toBe(alice.getSessionFile());
    const bobView = textsOf(messagesOf(SessionManager.open(bobHit!, dir)));
    expect(bobView).toEqual(['alice 的私密内容']);
    console.log('STAGE-C-③', JSON.stringify({ sameFile: bobHit === alice.getSessionFile(), bobSees: bobView }));
  });

  it('宿主按 principal 分区目录后互相不可见（需宿主承担，B1 内建）', () => {
    const ws = tempDir('c3b-ws');
    const root = tempDir('c3b-root');
    const aliceDir = path.join(root, 'alice');
    const bobDir = path.join(root, 'bob');
    const alice = SessionManager.create(ws, aliceDir, { id: 'conv-shared' });
    alice.appendMessage(user('alice 的私密内容'));

    expect(SessionManager.findById(ws, 'conv-shared', bobDir)).toBeUndefined();
    const bob = SessionManager.create(ws, bobDir, { id: 'conv-shared' });
    expect(textsOf(messagesOf(bob))).toEqual([]);
  });
});

// ───────────────────────────────────────────── ④ 重启 / 异常退出恢复
describe('④ 重启与异常退出', () => {
  it('SIGKILL 后：完整提交全部可读、可继续追加；半行尾被丢弃', () => {
    const sessionDir = tempDir('c4-dir');
    const counterFile = path.join(tempDir('c4-counter'), 'count.txt');
    const markerFile = path.join(tempDir('c4-marker'), 'marker.json');
    const { signal } = spawnFixture(CRASH_FIXTURE, [sessionDir, counterFile, markerFile]);
    expect(signal, '子进程必须 SIGKILL').toBe('SIGKILL');

    const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as { sessionFile: string };
    expect(marker.sessionFile).toBeTruthy();
    expect(readFileSync(counterFile, 'utf8').trim().split('\n').length, '崩溃前工具执行 1 次').toBe(1);

    const recovered = SessionManager.open(marker.sessionFile);
    const roles = recovered.getEntries().filter((e) => e.type === 'message').map((e) => (e as { message: { role?: string } }).message.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('toolResult');
    const beforeCount = recovered.getEntryCount();

    recovered.appendMessage(user('崩溃后追加的一条'));
    const again = SessionManager.open(marker.sessionFile);
    expect(again.getEntryCount()).toBe(beforeCount + 1);
    expect(textsOf(messagesOf(again))).toContain('崩溃后追加的一条');
    console.log('STAGE-C-④', JSON.stringify({ roles, beforeCount, afterCount: again.getEntryCount() }));
  });

  it('截断尾（半行）不阻塞恢复：完整提交保留，半行跳过', () => {
    const ws = tempDir('c4b-ws');
    const dir = tempDir('c4b-dir');
    const m = SessionManager.create(ws, dir, { id: 'sess-half' });
    m.appendMessage(user('完整一条'));
    m.appendMessage(user('将被截断的半行'));
    const file = m.getSessionFile()!;
    const size = statSync(file).size;
    truncateSync(file, size - 12);

    const reopened = SessionManager.open(file, dir);
    expect(textsOf(messagesOf(reopened))).toEqual(['完整一条']);
    reopened.appendMessage(user('恢复后新增'));
    expect(textsOf(messagesOf(SessionManager.open(file, dir)))).toEqual(['完整一条', '恢复后新增']);
  });
});

// ───────────────────────────────────────────── ⑤ 已压缩历史重启后继续
describe('⑤ 压缩后重启继续', () => {
  const W = 8_192;
  const seedHistory = (lastUser = '继续。'): AgentMessage[] => {
    const keepRecent = piCompactionSettings(W).keepRecentTokens;
    const targetChars = Math.ceil(keepRecent * 4 * 2.5);
    const perMessageChars = Math.ceil(targetChars / 16);
    const filler = '背景'.repeat(Math.ceil(perMessageChars / 2));
    const out: AgentMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      out.push(user(`历史问题 ${i}：${filler}`, i * 2 + 1));
      out.push(asst([{ type: 'text', text: '此前答复' }], 'stop', 100));
    }
    out.push(user(lastUser, 100));
    return out;
  };
  const replyOverThreshold = (text: string): AgentMessage => {
    const reserve = piCompactionSettings(W).reserveTokens;
    return asst([{ type: 'text', text }], 'stop', W - reserve + 1_000);
  };
  const hasSummary = (ms: readonly AgentMessage[]): boolean => textsOf(ms).some((t) => t.includes(SUMMARY_MARKER));

  it('压缩发生 → 新进程恢复 → 请求含摘要与保留尾段 → 新回合完成', async () => {
    const sessionDir = tempDir('c5-dir');
    const scripted = await createScriptedModelRuntime({
      contextWindow: W,
      script: (index, context) => {
        const body = JSON.stringify(context.messages);
        if (body.includes('<conversation>') || body.includes('# Conversation')) {
          return asst([{ type: 'text', text: '摘要：此前对话要点，游标 W1。' }]);
        }
        return index === 0 ? replyOverThreshold('压缩后的答复。') : textReply('好的。');
      },
    });
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: scripted.runtime,
      reuseConversation: true,
      sessionDir,
    });
    const turn1 = await driver.run({
      systemPrompt: '你是 fshine 业务助手：把业务请求转成任务，按事实如实回复。',
      tools: [],
      messages: seedHistory(),
      onStep: () => {},
      exec: async () => undefined,
      deadline: Date.now() + 60_000,
    });
    expect(hasSummary(turn1.messages), '第一回合必须由 Pi 原生压缩出摘要').toBe(true);
    const sessionFile = driver.sessionInfo?.()?.sessionFile;
    expect(sessionFile).toBeTruthy();
    driver.close?.();

    const compactionEntries = SessionManager.open(sessionFile!).getEntries().filter((e) => e.type === 'compaction');
    expect(compactionEntries.length, '会话文件含 compaction 条目').toBeGreaterThanOrEqual(1);

    const outFile = path.join(tempDir('c5-out'), 'out.json');
    const { signal } = spawnFixture(RESUME_FIXTURE, [sessionFile!, outFile, '重启后的追问：代号是什么？']);
    expect(signal, '恢复子进程正常退出').toBeUndefined();
    const out = JSON.parse(readFileSync(outFile, 'utf8')) as { text: string; requestMessages: unknown[]; sessionFile: string };
    expect(out.text).toBe('重启后继续成功。');
    const request = JSON.stringify(out.requestMessages);
    expect(request, '恢复后的请求必须带压缩摘要').toContain('摘要：此前对话要点');
    expect(request, '恢复后的请求必须带压缩后保留的尾段').toContain('继续。');
    expect(request).toContain('重启后的追问');
    console.log('STAGE-C-⑤', JSON.stringify({
      compactionEntries: compactionEntries.length,
      requestHasSummary: request.includes('摘要：此前对话要点'),
      requestHasTail: request.includes('继续。'),
      resumedText: out.text,
    }));
  });
});

// ───────────────────────────────────────────── ⑥ 旧 B1 格式兼容性
describe('⑥ 旧 B1 记录格式', () => {
  it('旧 B1（0.85.1 v4 提交日志）不能被新 SessionManager 直接读；按 id 查找落空→静默新建空会话', () => {
    const stage = tempDir('c6-stage');
    // 一次性旧格式产物：临时目录内放 0.85.1 包的 node_modules 符号链接，走其公开子路径。
    mkdirSync(path.join(stage, 'node_modules', '@earendil-works'), { recursive: true });
    symlinkSync(OLD_PI_PACKAGE, path.join(stage, 'node_modules', '@earendil-works', 'pi-agent-core'), 'dir');
    copyFileSync(OLD_RECORD_FIXTURE, path.join(stage, 'old-b1-record.mjs'));
    const oldRoot = path.join(stage, 'old-root');
    const outFile = path.join(stage, 'old.json');
    const { signal, stdout } = spawnFixture(path.join(stage, 'old-b1-record.mjs'), [oldRoot, 'b1-sess', outFile]);
    expect(signal, `旧格式生成器失败：${stdout}`).toBeUndefined();
    const old = JSON.parse(readFileSync(outFile, 'utf8')) as { file: string; messageCount: number };
    expect(old.messageCount, '旧记录确实写入 2 条 message').toBe(2);
    expect(statSync(old.file).size).toBeGreaterThan(0);

    const firstLine = JSON.parse(readFileSync(old.file, 'utf8').split('\n')[0]!) as Record<string, unknown>;
    expect(firstLine.kind, '旧 B1 header 是 v4 提交日志 header').toBe('header');
    expect(typeof firstLine.storageVersion).toBe('number');

    // 直接 open：显式拒绝（不是静默读空）。
    expect(() => SessionManager.open(old.file)).toThrow(/not a valid pi session/);
    // 按 id 查找：旧文件不可发现。
    const byIdBefore = SessionManager.findById('/tmp/fshine-ws', 'b1-sess', path.dirname(old.file));
    expect(byIdBefore).toBeUndefined();
    // 朴素宿主路径（findById 落空 → create 同 id）：静默新建空会话，旧转录留在盘上但不可见。
    const naive = SessionManager.create('/tmp/fshine-ws', path.dirname(old.file), { id: 'b1-sess' });
    naive.appendMessage(user('重启后的新问题'));
    expect(textsOf(messagesOf(naive))).toEqual(['重启后的新问题']);
    expect(sessionFiles(path.dirname(old.file)).length, '同 id 下新旧两个文件并存').toBe(2);
    console.log('STAGE-C-⑥', JSON.stringify({
      oldHeaderKind: firstLine.kind,
      storageVersion: firstLine.storageVersion,
      byIdBeforeNaive: byIdBefore ?? null,
      openThrows: 'not a valid pi session',
      filesAfterNaive: sessionFiles(path.dirname(old.file)).length,
      naiveContext: textsOf(messagesOf(naive)),
    }));
  });
});

// ───────────────────────────────────────────── ⑦ 损坏会话显式报错
describe('⑦ 损坏/不可恢复', () => {
  it('完全非法文件 → 显式报错', () => {
    const file = path.join(tempDir('c7a'), 'garbage.jsonl');
    writeFileSync(file, 'this is not a session\n', 'utf8');
    expect(() => SessionManager.open(file)).toThrow(/not a valid pi session/);
  });

  it('合法 header + 坏正文行 → 静默跳过该条（不报错）', () => {
    const ws = tempDir('c7b-ws');
    const dir = tempDir('c7b-dir');
    const m = SessionManager.create(ws, dir, { id: 'sess-corrupt' });
    m.appendMessage(user('第一条'));
    m.appendMessage(user('第二条'));
    m.appendMessage(user('第三条'));
    const file = m.getSessionFile()!;
    const lines = readFileSync(file, 'utf8').split('\n');
    // 第 3 行 = 第二条 message entry，替换成坏 JSON。
    expect(JSON.parse(lines[2]!).type).toBe('message');
    lines[2] = '{"type":"message","broken":';
    writeFileSync(file, lines.join('\n'), 'utf8');

    const reopened = SessionManager.open(file, dir);
    // 实测：不报错；坏行断开 parent 链，buildSessionContext 只沿 leaf 路径回溯，
    // 结果只剩最后一个无父节点（'第三条'），前两条一起消失。
    const corruptContext = textsOf(messagesOf(reopened));
    expect(corruptContext, '损坏行被静默丢弃，前序条目一并不可见').toEqual(['第三条']);
    console.log('STAGE-C-⑦', JSON.stringify({ corruptOpensWithoutError: true, corruptContext }));
  });

  it('缺 header（只有 message 行）→ 显式报错', () => {
    const file = path.join(tempDir('c7c'), 'no-header.jsonl');
    writeFileSync(file, [
      JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: new Date().toISOString(), message: user('没有 header') }),
    ].join('\n') + '\n', 'utf8');
    expect(() => SessionManager.open(file)).toThrow(/not a valid pi session/);
  });

  it('0 字节文件 → 静默补 header 重建为空会话（无报错）', () => {
    const file = path.join(tempDir('c7d'), 'empty.jsonl');
    writeFileSync(file, '', 'utf8');
    const m = SessionManager.open(file);
    expect(m.getEntries().length).toBe(0);
    const header = m.getHeader();
    expect(header?.type).toBe('session');
    expect(statSync(file).size).toBeGreaterThan(0);
    console.log('STAGE-C-⑦d', JSON.stringify({ emptyFileHeader: header?.type, entries: m.getEntries().length }));
  });
});

// ───────────────────────────────────────────── ⑧ 恢复不重执行业务工具
describe('⑧ 恢复不重执行已完成的工具', () => {
  it('SIGKILL 后重开：假执行层计数不变（打开即恢复也不触发执行）', () => {
    const sessionDir = tempDir('c8-dir');
    const counterFile = path.join(tempDir('c8-counter'), 'count.txt');
    const markerFile = path.join(tempDir('c8-marker'), 'marker.json');
    const { signal } = spawnFixture(CRASH_FIXTURE, [sessionDir, counterFile, markerFile]);
    expect(signal).toBe('SIGKILL');
    const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as { sessionFile: string; reply: string };
    const count = (): number => readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).length;
    expect(count(), '崩溃前业务工具执行 1 次').toBe(1);

    // 直接 open 不执行任何工具。
    const opened = SessionManager.open(marker.sessionFile);
    expect(count(), 'SessionManager.open 后计数不变').toBe(1);
    const context = JSON.stringify(messagesOf(opened));
    expect(context).toContain('已受理 #1');
    console.log('STAGE-C-⑧', JSON.stringify({ countAfterCrash: 1, countAfterOpen: count() }));
  });

  it('新进程继续一回合（模型不调工具）：计数仍为 1，且上下文含已完成工具结果', async () => {
    const sessionDir = tempDir('c8b-dir');
    const counterFile = path.join(tempDir('c8b-counter'), 'count.txt');
    const markerFile = path.join(tempDir('c8b-marker'), 'marker.json');
    const { signal } = spawnFixture(CRASH_FIXTURE, [sessionDir, counterFile, markerFile]);
    expect(signal).toBe('SIGKILL');
    const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as { sessionFile: string };
    const count = (): number => readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean).length;

    const scripted = await createScriptedModelRuntime({ contextWindow: 40_000, script: () => textReply('收到，继续处理。') });
    let execCalls = 0;
    const driver = createPiTurnDriver({
      env: { LLM_MODEL: 'test-model' },
      modelRuntime: scripted.runtime,
      reuseConversation: true,
      resumeSessionFile: marker.sessionFile,
    });
    expect(count(), '恢复驱动创建后计数不变').toBe(1);
    const result = await driver.run({
      systemPrompt: '你是 fshine 业务助手：把业务请求转成任务，按事实如实回复。',
      tools: [],
      messages: [user('继续')],
      onStep: () => {},
      exec: async () => { execCalls += 1; return undefined; },
      deadline: Date.now() + 60_000,
    });
    expect(result.text).toBe('收到，继续处理。');
    expect(execCalls, '新回合没有工具调用').toBe(0);
    expect(count(), '恢复后新回合不重执行历史工具').toBe(1);
    const request = JSON.stringify(scripted.requests()[0]?.messages ?? []);
    expect(request).toContain('请查询 W1 账套');
    expect(request).toContain('已受理 #1');
    driver.close?.();
    console.log('STAGE-C-⑧b', JSON.stringify({ execCalls, countAfterTurn: count(), requestHasToolResult: request.includes('已受理 #1') }));
  });
});
