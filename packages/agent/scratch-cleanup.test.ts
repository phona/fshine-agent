import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isScratchDirName, newScratchDirName, sweepScratchDirs } from './src/scratch-cleanup';

const root = mkdtempSync(path.join(tmpdir(), 'scratch-sweep-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const mk = (name: string, ageMs: number) => {
  const full = path.join(root, 'tmp', name);
  mkdirSync(full, { recursive: true });
  writeFileSync(path.join(full, 'artifact.json'), '{}');
  const past = new Date(Date.now() - ageMs);
  // mtime 直接设（utimesSync 不引入额外 import 的情况下用 writeFileSync 后再调）
  const { utimesSync } = require('node:fs');
  utimesSync(full, past, past);
  return full;
};

describe('isScratchDirName', () => {
  it('只认 task_<uuid>（⑨：工作区按任务切，续跑共享）', () => {
    expect(isScratchDirName(newScratchDirName())).toBe(true);
    expect(isScratchDirName('task_018f0d2a-1111-2222-3333-444455556666')).toBe(true);
    // 旧命名 req_ 不再认领（迁移期遗留目录需手动清理，不可误删平台产物）
    expect(isScratchDirName('req_018f0d2a-1111-2222-3333-444455556666')).toBe(false);
  });
  it('平台自己的产物一律不算(宁可漏删不可误删)', () => {
    for (const n of ['excels', 'contract-2026-07.json', '整理好的2026年07月工资表.xlsx',
                     'req_short', 'reqx_018f0d2a-1111-2222-3333-444455556666', 'REQ_018f0d2a-1111-2222-3333-444455556666',
                     'req_018f0d2a111122223333444455556666', 'probe-out']) {
      expect(isScratchDirName(n), n).toBe(false);
    }
  });
});

describe('sweepScratchDirs', () => {
  it('只删超龄的 req_ 目录;平台产物与未超龄的原样不动', () => {
    const old = mk(newScratchDirName(), 48 * 3600 * 1000);
    const fresh = mk(newScratchDirName(), 60 * 1000);
    const platformDir = mk('excels', 48 * 3600 * 1000);
    const platformFile = path.join(root, 'tmp', 'contract-2026-07.json');
    writeFileSync(platformFile, '{}');

    const r = sweepScratchDirs(root, Date.now(), 24 * 3600 * 1000);
    expect(r.removed).toEqual([path.basename(old)]);
    expect(r.kept).toEqual([path.basename(fresh)]);
    expect(r.errors).toEqual([]);
    const { existsSync } = require('node:fs');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(platformDir)).toBe(true);
    expect(existsSync(platformFile)).toBe(true);
  });

  it('tmp/ 下同名的散文件不删(只删目录)', () => {
    const name = newScratchDirName();
    const file = path.join(root, 'tmp', name);
    writeFileSync(file, 'not a dir');
    const r = sweepScratchDirs(root, Date.now(), 24 * 3600 * 1000);
    expect(r.removed).toEqual([]);
    const { existsSync } = require('node:fs');
    expect(existsSync(file)).toBe(true);
  });

  it('ttlMs<=0 全清(排障用),但仍只清自己的命名', () => {
    const { readdirSync } = require('node:fs');
    // 前几个用例可能留下了未超龄的 req_ 目录；ttl<=0 时它们也该被清。
    // 所以先快照"当前所有 req_ 目录"，预期 = 快照 ∪ 本次新建，避免用例间顺序耦合。
    const { statSync } = require('node:fs');
    const before = readdirSync(path.join(root, 'tmp'))
      .filter((n: string) => isScratchDirName(n) && statSync(path.join(root, 'tmp', n)).isDirectory());
    const a = mk(newScratchDirName(), 0);
    const b = mk(newScratchDirName(), 0);
    mk('excels', 0);
    const r = sweepScratchDirs(root, Date.now(), 0);
    expect(r.removed.sort()).toEqual([...before, path.basename(a), path.basename(b)].sort());
    const { existsSync } = require('node:fs');
    expect(existsSync(path.join(root, 'tmp', 'excels'))).toBe(true);
  });

  it('tmp/ 不存在时安静返回', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'scratch-empty-'));
    expect(sweepScratchDirs(empty, Date.now(), 1000)).toEqual({ removed: [], kept: [], errors: [] });
    rmSync(empty, { recursive: true, force: true });
  });
});

// ── W5 终态判据策略（双年龄：终态短 grace + 抛弃长 TTL）────────────────────────
describe('sweepScratchDirs 策略形态（W5）', () => {
  const GRACE = 60 * 60 * 1000;           // 终态 grace：1h
  const ABANDONED = 24 * 60 * 60 * 1000;  // 抛弃兜底：24h

  const policy = (isTerminal: (taskId: string) => boolean) => ({
    terminalGraceMs: GRACE,
    abandonedTtlMs: ABANDONED,
    isTerminal,
  });

  it('终态且过了 grace：删（交付物已在会话库，scratch 只是中间产物）', () => {
    const name = newScratchDirName();
    mk(name, 2 * 60 * 60 * 1000);         // 2h > grace
    const r = sweepScratchDirs(root, Date.now(), policy((taskId) => taskId === name));
    expect(r.removed).toContain(name);
  });

  it('终态但在 grace 内：留（排障与重试窗口）', () => {
    const name = newScratchDirName();
    mk(name, 30 * 60 * 1000);             // 30min < grace
    const r = sweepScratchDirs(root, Date.now(), policy(() => true));
    expect(r.removed).not.toContain(name);
    expect(r.kept).toContain(name);
  });

  it('非终态但闲置超 abandoned TTL：删（抛弃兜底，防无限堆积）', () => {
    const name = newScratchDirName();
    mk(name, 25 * 60 * 60 * 1000);        // 25h > abandoned
    const r = sweepScratchDirs(root, Date.now(), policy(() => false));
    expect(r.removed).toContain(name);
  });

  it('非终态且闲置不久：留（在飞任务，续跑还要用）', () => {
    const name = newScratchDirName();
    mk(name, 2 * 60 * 60 * 1000);         // 2h：终态会删，非终态不删
    const r = sweepScratchDirs(root, Date.now(), policy(() => false));
    expect(r.removed).not.toContain(name);
    expect(r.kept).toContain(name);
  });

  it('持久运行记录 pin 的工作区即使超 abandoned TTL 也保留', () => {
    const name = newScratchDirName();
    mk(name, 48 * 60 * 60 * 1000);
    const r = sweepScratchDirs(root, Date.now(), {
      ...policy(() => false),
      isPinned: (taskId) => taskId === name,
    });
    expect(r.removed).not.toContain(name);
    expect(r.kept).toContain(name);
  });

  it('判据抛错 = 不确定 = 非终态：留（宁可漏删，不可误删）', () => {
    const name = newScratchDirName();
    mk(name, 2 * 60 * 60 * 1000);         // 终态会被删的年龄，但判据炸了
    const r = sweepScratchDirs(root, Date.now(), policy(() => { throw new Error('台账读不到'); }));
    expect(r.removed).not.toContain(name);
    expect(r.kept).toContain(name);
  });
});
