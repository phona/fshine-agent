/**
 * 登记面交付角色（方案 A，2026-11-18）· putFile 缺省不可交付 + 用户产物入口可交付。
 *
 * 判据是**角色**不是文件名：宿主内部写出的字节（putFile 未声明）默认 `deliverable=false`，
 * 用户产物入口（入站登记 / out/ 扫描 / 任务回程登记）返回 `deliverable=true`。
 * 防退化：把 putFile 缺省改回 true → 本文件必红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import { createFileStore, type FileStore } from './src/file-store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:deliverable-u', sessionId: 'deliverable-sess' };

interface Harness {
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
  fixtureRoot: string;
}

function makeHarness(): Harness {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'file-store-deliverable-'));
  dirs.push(fixtureRoot);
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot: path.join(fixtureRoot, 'workspace') });
  return { store, fileStore, fixtureRoot };
}

describe('登记面交付角色（方案 A）', () => {
  it('④ putFile 不传 deliverable → false（宿主内部字节默认不是交付物）；显式 true 才是', () => {
    const h = makeHarness();
    const internal = h.fileStore.putFile({
      scope: SCOPE,
      name: '明细.values.csv',
      bytes: Buffer.from('sheet,ref,value\n'),
      activatedAt: Date.now(),
    });
    expect(internal.deliverable).toBe(false);
    // 读回路（file_refs 行）与返回形状一致。
    expect(h.store.getFileRef(internal.fileId, SCOPE, { side: 'main' })!.deliverable).toBe(false);

    const explicit = h.fileStore.putFile({
      scope: SCOPE,
      name: '汇总.xlsx',
      bytes: Buffer.from('xlsx'),
      activatedAt: Date.now(),
      deliverable: true,
    });
    expect(explicit.deliverable).toBe(true);
    h.store.close();
  });

  it('用户产物入口一律可交付：入站登记 / out/ 扫描 / 任务回程登记', () => {
    const h = makeHarness();
    // 入站附件（pending 行）：用户自己的文件 → 可交付。
    const inboundPath = path.join(h.fixtureRoot, 'inbound.xlsx');
    require('node:fs').writeFileSync(inboundPath, 'inbound-bytes');
    const inbound = h.fileStore.registerInboundFile({ scope: SCOPE, name: '用户表.xlsx', sourcePath: inboundPath });
    expect(inbound.deliverable).toBe(true);

    // 任务回程（内联字节）：用户产物 → 可交付。
    const returned = h.fileStore.registerTaskFile({
      scope: SCOPE,
      taskId: 'task_a',
      name: '结果.csv',
      bytes: Buffer.from('a,b\n1,2\n'),
      maxFileBytes: 1024,
    });
    expect(returned.deliverable).toBe(true);

    // out/ 扫描（Main 交付箱）：用户产物 → 可交付。
    const runDir = path.join(h.fixtureRoot, 'workspace', 'runs', 'run_deliverable');
    require('node:fs').mkdirSync(path.join(runDir, 'out'), { recursive: true });
    require('node:fs').writeFileSync(path.join(runDir, 'out', '汇总.txt'), 'summary');
    const scanned = h.fileStore.registerOutputsFromOut({
      runDir,
      scope: SCOPE,
      limits: { maxFileBytes: 1024, maxCount: 10 },
    });
    expect(scanned.outputs).toHaveLength(1);
    expect(scanned.outputs[0]!.deliverable).toBe(true);
    h.store.close();
  });
});
