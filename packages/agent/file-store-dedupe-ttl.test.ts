/**
 * 入站内容去重 + 文件引用 TTL 配置化 + 清单收到时间（2026-11-18 owner，B 方案 1/2/3）。
 *
 * 覆盖：
 *   ① 同 scope 同内容两次接收（第一次已激活）→ **同一 fileId**、只有一行、磁盘只有一份字节；
 *      第二次的 name 生效（含扩展名变化时字节位置随 name 的安全扩展名改名）；
 *      复用刷新 activated_at（重发不会更快过期）；
 *   ② 同 scope 同名不同内容 → 两个 fileId（不覆盖）；
 *   ③ 跨 principal / 跨 session（以及任务副本行）同内容 → 不复用；
 *   ④ 既有行已过期 / 字节已被回收 → 不复用，新 fileId；
 *   ⑤ TTL 配置：fileRefTtlDays=7 生效（6 天前可读、8 天前不可读）；最小 1；未配置 = 7 天；
 *   ⑥ 清单每行带「YYYY-MM-DD HH:mm 收到」，字段顺序与 fileId 形态不变。
 *
 * 库用 :memory:，workspace 与源文件都用临时目录；不触网、不碰真实平台。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import {
  createFileStore,
  fileStoragePathOf,
  FILE_REF_TTL_MS,
  sessionDirOf,
  type FileScope,
  type FileStore,
} from './src/file-store';
import { fileRefTtlMsOf, resolveRuntimeConfig } from './src/resource-policy';
import { renderFileManifest, renderWorkerFileManifest } from './src/execution-runtime';

const DAY_MS = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE: FileScope = { principalId: 'wecom:u-dedupe', sessionId: 'cap01-dedupe' };

interface Fixture {
  root: string;
  workspaceRoot: string;
  staging: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
}

function makeFixture(ttlMs?: number): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'file-store-dedupe-'));
  dirs.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const staging = path.join(root, 'staging');
  mkdirSync(staging, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot, ...(ttlMs === undefined ? {} : { ttlMs }) });
  return { root, workspaceRoot, staging, store, fileStore };
}

/** 把内容写成渠道落盘源文件，返回源路径。 */
function stage(fixture: Fixture, name: string, content: string | Buffer): string {
  const sourcePath = path.join(fixture.staging, `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  writeFileSync(sourcePath, content);
  return sourcePath;
}

/** 某个 scope 的 files/ 目录里的落盘文件名（去重「不重复落盘」的可观察面）。 */
function storedFileNames(workspaceRoot: string, scope: FileScope): string[] {
  const filesDir = path.join(sessionDirOf(workspaceRoot, scope), 'files');
  return existsSync(filesDir) ? readdirSync(filesDir).sort() : [];
}

describe('① 入站同内容去重：复用 fileId、不重复落盘、name 取本次', () => {
  it('同 scope 同内容（首次已激活）→ 同一 fileId、一行、一份字节；第二次 name 生效', () => {
    const fx = makeFixture();
    const source = stage(fx, '明细.csv', 'a,b\n1,2\n');
    const first = fx.fileStore.registerInboundFile({ scope: SCOPE, name: '明细.csv', sourcePath: source });
    // 业务流程：带文字的消息激活 pending（激活时刻故意拨早 60s，便于验证复用会刷新 TTL 起点）。
    const activatedAt = Date.now() - 60_000;
    expect(fx.fileStore.activatePendingInputs({ scope: SCOPE, now: activatedAt })).toBe(1);

    const second = fx.fileStore.registerInboundFile({ scope: SCOPE, name: '明细-二次.txt', sourcePath: source });

    expect(second.fileId).toBe(first.fileId);
    const rows = fx.store.listFileRefs(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('明细-二次.txt');
    // 复用刷新 activated_at（重发不会更快过期）。
    expect(rows[0]!.activatedAt).toBeGreaterThan(activatedAt);
    // 只有一份字节，且位置随新 name 的安全扩展名（.csv → .txt）改名。
    expect(storedFileNames(fx.workspaceRoot, SCOPE)).toEqual([`${first.fileId}.txt`]);
    expect(existsSync(fileStoragePathOf(fx.workspaceRoot, SCOPE, first.fileId, '明细.csv'))).toBe(false);
    // 清单只出现一份（name = 本次）。
    expect(fx.fileStore.listActiveFiles({ scope: SCOPE, now: Date.now() })).toEqual([
      expect.objectContaining({ fileId: first.fileId, name: '明细-二次.txt' }),
    ]);
    fx.store.close();
  });

  it('复用刷新 TTL 起点：6 天前的行被重发后重新变成「刚收到」', () => {
    const fx = makeFixture();
    const content = Buffer.from('same-bytes');
    const source = stage(fx, '旧.csv', content);
    const old = fx.fileStore.putFile({
      scope: SCOPE,
      name: '旧.csv',
      bytes: content,
      activatedAt: Date.now() - 6 * DAY_MS,
    });
    const before = fx.store.listFileRefs(SCOPE)[0]!.activatedAt!;

    const received = fx.fileStore.registerInboundFile({ scope: SCOPE, name: '旧.csv', sourcePath: source });

    expect(received.fileId).toBe(old.fileId);
    expect(fx.store.listFileRefs(SCOPE)[0]!.activatedAt).toBeGreaterThan(before);
    expect(fx.store.listFileRefs(SCOPE)[0]!.activatedAt).toBeGreaterThan(Date.now() - 5_000);
    fx.store.close();
  });
});

describe('② 同名不同内容：不复用、不覆盖', () => {
  it('同 scope 同名两次不同内容 → 两个 fileId、两行、两份字节', () => {
    const fx = makeFixture();
    const first = fx.fileStore.registerInboundFile({
      scope: SCOPE,
      name: '报告.xlsx',
      sourcePath: stage(fx, '报告.xlsx', 'v1'),
    });
    fx.fileStore.activatePendingInputs({ scope: SCOPE, now: Date.now() });
    const second = fx.fileStore.registerInboundFile({
      scope: SCOPE,
      name: '报告.xlsx',
      sourcePath: stage(fx, '报告.xlsx', 'v2'),
    });

    expect(second.fileId).not.toBe(first.fileId);
    expect(fx.store.listFileRefs(SCOPE)).toHaveLength(2);
    expect(storedFileNames(fx.workspaceRoot, SCOPE)).toEqual([`${first.fileId}.xlsx`, `${second.fileId}.xlsx`].sort());
    // 第一行内容未被覆盖（sha 不同、可读字节仍是 v1）。
    const firstRow = fx.store.listFileRefs(SCOPE).find((row) => row.fileId === first.fileId)!;
    expect(firstRow.sha256).not.toBe(second.sha256);
    expect(readFileSync(fileStoragePathOf(fx.workspaceRoot, SCOPE, first.fileId, firstRow.name), 'utf8')).toBe('v1');
    fx.store.close();
  });
});

describe('③ 跨 scope 绝不复用（防越权与存在性泄露）', () => {
  it('不同 principal / 不同 session / 任务副本行都不参与入站复用', () => {
    const fx = makeFixture();
    const content = 'cross-scope';
    const source = stage(fx, '共享.csv', content);
    const base = fx.fileStore.registerInboundFile({ scope: SCOPE, name: '共享.csv', sourcePath: source });
    fx.fileStore.activatePendingInputs({ scope: SCOPE, now: Date.now() });

    const otherPrincipal = fx.fileStore.registerInboundFile({
      scope: { principalId: 'wecom:u-other', sessionId: SCOPE.sessionId },
      name: '共享.csv',
      sourcePath: source,
    });
    const otherSession = fx.fileStore.registerInboundFile({
      scope: { principalId: SCOPE.principalId, sessionId: 'autre-session' },
      name: '共享.csv',
      sourcePath: source,
    });
    expect(otherPrincipal.fileId).not.toBe(base.fileId);
    expect(otherSession.fileId).not.toBe(base.fileId);

    // 任务副本（同 scope、同 sha，但 task_id 绑定）不能被当作可复用行。
    const [copy] = fx.fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [base.fileId], taskId: 'task_x' });
    const again = fx.fileStore.registerInboundFile({ scope: SCOPE, name: '共享.csv', sourcePath: source });
    expect(again.fileId).toBe(base.fileId);
    expect(again.fileId).not.toBe(copy!.fileId);
    expect(fx.store.listFileRefs(SCOPE)).toHaveLength(2); // 原件 + 任务副本，没有新增第三行
    fx.store.close();
  });
});

describe('④ 不可读的行不复用（过期 / 字节已回收 → 新 fileId）', () => {
  it('既有同内容行仍 pending（未激活）→ 不复用、不激活、两行', () => {
    const fx = makeFixture();
    const source = stage(fx, '待激活.csv', 'pending-dedupe');
    // 第一次登记 = pending（等带文字的消息激活）；此后再收到同内容，不能把 pending 行当可复用。
    const first = fx.fileStore.registerInboundFile({ scope: SCOPE, name: '待激活.csv', sourcePath: source });

    const second = fx.fileStore.registerInboundFile({ scope: SCOPE, name: '待激活.csv', sourcePath: source });

    expect(second.fileId).not.toBe(first.fileId);
    const rows = fx.store.listFileRefs(SCOPE);
    expect(rows).toHaveLength(2);
    // 登记不替用户激活：两行都仍是 pending（激活只由带文字的消息触发）。
    expect(rows.every((row) => row.activatedAt === undefined)).toBe(true);
    expect(rows.map((row) => row.fileId).sort()).toEqual([first.fileId, second.fileId].sort());
    expect(storedFileNames(fx.workspaceRoot, SCOPE)).toHaveLength(2);
    fx.store.close();
  });

  it('既有行已过期 → 新 fileId', () => {
    const fx = makeFixture();
    const content = Buffer.from('expired-content');
    const expired = fx.fileStore.putFile({
      scope: SCOPE,
      name: '旧.csv',
      bytes: content,
      activatedAt: Date.now() - 8 * DAY_MS,
    });
    const received = fx.fileStore.registerInboundFile({
      scope: SCOPE,
      name: '旧.csv',
      sourcePath: stage(fx, '旧.csv', content),
    });

    expect(received.fileId).not.toBe(expired.fileId);
    expect(fx.store.listFileRefs(SCOPE)).toHaveLength(2);
    fx.store.close();
  });

  it('行未过期但字节已被回收（文件不存在）→ 不复用，新 fileId', () => {
    const fx = makeFixture();
    const content = Buffer.from('bytes-gone');
    const live = fx.fileStore.putFile({
      scope: SCOPE,
      name: '在表但无字节.csv',
      bytes: content,
      activatedAt: Date.now() - 1_000,
    });
    rmSync(fileStoragePathOf(fx.workspaceRoot, SCOPE, live.fileId, '在表但无字节.csv'));

    const received = fx.fileStore.registerInboundFile({
      scope: SCOPE,
      name: '在表但无字节.csv',
      sourcePath: stage(fx, '在表但无字节.csv', content),
    });

    expect(received.fileId).not.toBe(live.fileId);
    expect(fx.store.listFileRefs(SCOPE)).toHaveLength(2);
    // 新 fileId 的字节真实落盘（不是把坏引用交出去）。
    expect(existsSync(fileStoragePathOf(fx.workspaceRoot, SCOPE, received.fileId, received.name))).toBe(true);
    fx.store.close();
  });
});

describe('⑤ TTL 配置：fileRefTtlDays（缺省 7、最小 1）', () => {
  it('fileRefTtlDays=7 生效：6 天前的行可读、8 天前的行不可读', () => {
    const fx = makeFixture(fileRefTtlMsOf(resolveRuntimeConfig({ fileRefTtlDays: 7 })));
    const now = Date.now();
    fx.fileStore.putFile({ scope: SCOPE, name: '六天.csv', bytes: Buffer.from('6'), activatedAt: now - 6 * DAY_MS });
    fx.fileStore.putFile({ scope: SCOPE, name: '八天.csv', bytes: Buffer.from('8'), activatedAt: now - 8 * DAY_MS });

    const active = fx.fileStore.listActiveFiles({ scope: SCOPE, now });
    expect(active.map((file) => file.name)).toEqual(['六天.csv']);
    fx.store.close();
  });

  it('未配置时缺省 7 天（原写死 24h 已被替换）', () => {
    expect(resolveRuntimeConfig().fileRefTtlDays).toBe(7);
    expect(fileRefTtlMsOf(resolveRuntimeConfig())).toBe(7 * DAY_MS);
    expect(FILE_REF_TTL_MS).toBe(7 * DAY_MS);

    const fx = makeFixture(fileRefTtlMsOf(resolveRuntimeConfig()));
    const now = Date.now();
    fx.fileStore.putFile({ scope: SCOPE, name: '六天.csv', bytes: Buffer.from('6'), activatedAt: now - 6 * DAY_MS });
    fx.fileStore.putFile({ scope: SCOPE, name: '八天.csv', bytes: Buffer.from('8'), activatedAt: now - 8 * DAY_MS });
    expect(fx.fileStore.listActiveFiles({ scope: SCOPE, now }).map((file) => file.name)).toEqual(['六天.csv']);
    fx.store.close();
  });

  it('最小 1：0 / 负数 / 小数 fail-fast；显式 1 天如约生效', () => {
    expect(() => resolveRuntimeConfig({ fileRefTtlDays: 0 })).toThrow(/fileRefTtlDays/);
    expect(() => resolveRuntimeConfig({ fileRefTtlDays: -1 })).toThrow(/fileRefTtlDays/);
    expect(() => resolveRuntimeConfig({ fileRefTtlDays: 1.5 })).toThrow(/fileRefTtlDays/);
    expect(resolveRuntimeConfig({ fileRefTtlDays: 1 }).fileRefTtlDays).toBe(1);

    const fx = makeFixture(fileRefTtlMsOf(resolveRuntimeConfig({ fileRefTtlDays: 1 })));
    const now = Date.now();
    fx.fileStore.putFile({ scope: SCOPE, name: '十二小时.csv', bytes: Buffer.from('h'), activatedAt: now - 12 * 60 * 60 * 1000 });
    fx.fileStore.putFile({ scope: SCOPE, name: '两天.csv', bytes: Buffer.from('d'), activatedAt: now - 2 * DAY_MS });
    expect(fx.fileStore.listActiveFiles({ scope: SCOPE, now }).map((file) => file.name)).toEqual(['十二小时.csv']);
    fx.store.close();
  });
});

describe('⑥ 清单行带收到时间（格式稳定，字段顺序与 fileId 形态不变）', () => {
  const createdAt = new Date(2026, 0, 2, 3, 4).getTime(); // 本地 2026-01-02 03:04

  /** 与渲染侧同一本地时区格式（YYYY-MM-DD HH:mm），用于钉住取的是哪个时间点。 */
  function localText(epochMs: number): string {
    const date = new Date(epochMs);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  it('Main 清单行：既有字段原样 + 行尾「YYYY-MM-DD HH:mm 收到」', () => {
    const manifest = renderFileManifest([
      { fileId: 'file_a8259b01', name: '明细.xlsx', bytes: 20480, createdAt },
    ]);
    expect(manifest).toContain(
      '- 明细.xlsx（fileId: file_a8259b01，20480 字节；脚本内路径：in/file_a8259b01.xlsx；2026-01-02 03:04 收到）',
    );
    // 月份/日期/小时/分钟两位补零（格式稳定）。
    expect(manifest).toMatch(/；\d{4}-\d{2}-\d{2} \d{2}:\d{2} 收到）/);
  });

  it('Worker 任务清单同一行公式；无 createdAt 的交付面引用不渲染时间', () => {
    const manifest = renderWorkerFileManifest([
      { fileId: 'file_copy04ab', name: '清单.csv', bytes: 3, createdAt },
    ]);
    expect(manifest).toContain(
      '- 清单.csv（fileId: file_copy04ab，3 字节；脚本内路径：in/file_copy04ab.csv；2026-01-02 03:04 收到）',
    );
    expect(renderFileManifest([{ fileId: 'file_noext01', name: '说明', bytes: 1 }])).not.toContain('收到');
  });

  it('清单时间 = 登记时刻（createdAt），不是激活时刻（activatedAt）', () => {
    const fx = makeFixture();
    // 纯附件场景：收到即登记（createdAt≈now），随后才被文字消息激活（这里故意拨早 3 天，
    // 模拟「激活时刻 ≠ 真收到时刻」）。清单必须显示登记时刻。
    const activatedAt = Date.now() - 3 * DAY_MS;
    fx.fileStore.putFile({ scope: SCOPE, name: '纯附件.csv', bytes: Buffer.from('p'), activatedAt });

    const [listed] = fx.fileStore.listActiveFiles({ scope: SCOPE, now: Date.now() });
    expect(listed!.activatedAt).toBe(activatedAt);
    expect(listed!.createdAt).toBeGreaterThan(activatedAt);

    const manifest = renderFileManifest([listed!]);
    expect(manifest).toContain(`；${localText(listed!.createdAt)} 收到`);
    expect(manifest).not.toContain(`；${localText(activatedAt)} 收到`);
    fx.store.close();
  });
});
