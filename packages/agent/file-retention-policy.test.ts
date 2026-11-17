/**
 * run 目录 / 任务产物保留期（`runtime.fileRetentionDays`）的判定面。
 *
 * TDD：先红（旋钮与判定函数尚不存在）→ 最小实现转绿 → 反向绊线（把缺省改成非 0 /
 * 让判定忽略配置，必须重新红）。
 *
 * 本切片只做「旋钮存在 + 纯判定」：缺省 0 = 不清理（零行为变化）；`> 0` 时策略只返回
 * `eligible_for_cleanup`，**不执行任何删除**——清理执行器归后续批次。因此这里的用例
 * 既断言判定结果，也断言调用判定后文件仍在（判定无 IO 副作用）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_RETENTION_DAY_MS,
  createResourcePolicy,
  fileRetentionDecision,
  resolveRuntimeConfig,
} from './src/resource-policy';

/** 固定钟：判定只接受调用方给的时间，不依赖真实时钟。 */
const NOW = 1_800_000_000_000;

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'fshine-file-retention-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** 造一个带产物的 run 目录，mtime 设为 ageDays 天前（模拟「久未使用」）。 */
function makeRunDir(runId: string, ageDays: number): string {
  const runDir = path.join(workspace, 'runs', runId);
  const outFile = path.join(runDir, 'out', '产物.txt');
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, 'artifact');
  const stamp = new Date(NOW - ageDays * FILE_RETENTION_DAY_MS);
  utimesSync(outFile, stamp, stamp);
  utimesSync(runDir, stamp, stamp);
  return runDir;
}

describe('runtime.fileRetentionDays：缺省 30 天（2026-11-17 owner 定）', () => {
  it('缺省解析值 = 30；超过 30 天的 run 目录判 eligible_for_cleanup，但判定本身不删文件', () => {
    const resolved = resolveRuntimeConfig();
    expect(resolved.fileRetentionDays).toBe(30);

    const runDir = makeRunDir('run_default', 3650);
    const decision = fileRetentionDecision(resolved, {
      createdAtMs: NOW - 3650 * FILE_RETENTION_DAY_MS,
      nowMs: NOW,
    });
    expect(decision).toMatchObject({ verdict: 'eligible_for_cleanup', retentionDays: 30 });
    // 判定纯逻辑：没有执行器、判定不产生副作用，文件仍在（清理执行器在后续切片）。
    expect(existsSync(path.join(runDir, 'out', '产物.txt'))).toBe(true);
  });

  it('缺省 30 天内的目录判 keep（不到期不清理）', () => {
    const resolved = resolveRuntimeConfig();
    expect(
      fileRetentionDecision(resolved, { createdAtMs: NOW - 29 * FILE_RETENTION_DAY_MS, nowMs: NOW }).verdict,
    ).toBe('keep');
  });

  it('显式 fileRetentionDays: 0 与缺省同义（显式值不被缺省吞掉）', () => {
    const resolved = resolveRuntimeConfig({ fileRetentionDays: 0 });
    expect(resolved.fileRetentionDays).toBe(0);
    expect(
      fileRetentionDecision(resolved, { createdAtMs: NOW - 10_000 * FILE_RETENTION_DAY_MS, nowMs: NOW }).verdict,
    ).toBe('keep');
  });
});

describe('runtime.fileRetentionDays > 0：只返回「应清理」判定，不立刻删', () => {
  it('超过保留期 → eligible_for_cleanup；判定后文件仍在', () => {
    const resolved = resolveRuntimeConfig({ fileRetentionDays: 30 });
    const createdAtMs = NOW - 31 * FILE_RETENTION_DAY_MS;
    const runDir = makeRunDir('run_old', 31);

    const decision = fileRetentionDecision(resolved, { createdAtMs, nowMs: NOW });
    expect(decision).toMatchObject({
      verdict: 'eligible_for_cleanup',
      retentionDays: 30,
      cutoffAt: NOW - 30 * FILE_RETENTION_DAY_MS,
      ageMs: 31 * FILE_RETENTION_DAY_MS,
    });
    // 本切片只判定不删除：执行器接线前，文件原样保留。
    expect(existsSync(path.join(runDir, 'out', '产物.txt'))).toBe(true);
  });

  it('未超过保留期 / 恰好到截止点 → keep（严格超过才具备清理资格）', () => {
    const resolved = resolveRuntimeConfig({ fileRetentionDays: 30 });
    expect(
      fileRetentionDecision(resolved, { createdAtMs: NOW - 29 * FILE_RETENTION_DAY_MS, nowMs: NOW }).verdict,
    ).toBe('keep');
    expect(
      fileRetentionDecision(resolved, { createdAtMs: NOW - 30 * FILE_RETENTION_DAY_MS, nowMs: NOW }).verdict,
    ).toBe('keep');
  });
});

describe('非法值 fail-fast（不静默回落）', () => {
  it('负数 / 非整数点名 runtime.fileRetentionDays', () => {
    expect(() => resolveRuntimeConfig({ fileRetentionDays: -1 })).toThrowError(/runtime\.fileRetentionDays/);
    expect(() => resolveRuntimeConfig({ fileRetentionDays: 1.5 })).toThrowError(/runtime\.fileRetentionDays/);
  });

  it('createResourcePolicy 快照暴露解析后的保留期（单一来源）', () => {
    expect(createResourcePolicy({ fileRetentionDays: 7 }).snapshot().config.fileRetentionDays).toBe(7);
  });
});
