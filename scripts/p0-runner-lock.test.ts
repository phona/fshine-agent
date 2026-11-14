/**
 * P0-T02 runner 默认路径与 criteria.lock 校验不变（确定性；不跑模型、不触网）。
 *
 * 两个判据：
 *  ① 默认路径（不带 --suite）：`scripts/eval/convergence-r1/runner.ts --case E01 --trials 1`
 *     的冻结校验必须通过——criteria.lock 校验不报不一致、manifest 的 criteria/cases
 *     哈希与冻结锁一致、criteria/cases 冻结副本哈希与 manifest 一致。为不依赖真实模型，
 *     子进程显式清空 LLM_API_KEY：runner 在试点进入模型前按既有归类报 infra
 *     （exit 2 / INCONCLUSIVE），本用例只验证锁校验路径，不宣称任何模型行为。
 *  ② 冻结面 tripwire：criteria.lock 登记的每个判据/用例/判定器文件，当前工作树逐字节
 *     sha256 与锁一致——P0 若误改 R3 冻结面即红。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(REPO_ROOT, 'scripts', 'eval', 'convergence-r1', 'criteria.lock');
const RUNNER = 'scripts/eval/convergence-r1/runner.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 子进程环境：剔除宿主 LLM 泄漏（缺省即无 key——runner 走 infra 路径，不发模型请求）。 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['LLM_API_KEY', 'LLM_API_BASE_URL', 'LLM_MODEL', 'LLM_MAIN_MODEL', 'LLM_THINKING_LEVEL', 'LLM_MAIN_THINKING_LEVEL']) {
    delete env[key];
  }
  env['TMPDIR'] ??= os.tmpdir();
  return env;
}

interface Lock {
  criteriaSha256: string;
  casesSha256: string;
  files: Record<string, string>;
}

function readLock(): Lock {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock;
}

describe('P0-T02 runner 默认路径与 criteria.lock 校验不变', () => {
  it('默认路径 lock 校验通过；manifest 的 criteria/cases 哈希与冻结锁一致（无模型请求）', () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'p0-runner-lock-'));
    dirs.push(outDir);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', RUNNER, '--case', 'E01', '--trials', '1', '--out-dir', outDir],
      { cwd: REPO_ROOT, env: cleanEnv(), encoding: 'utf8' },
    );
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    // 锁校验路径：不得出现冻结不一致 / fail-closed 拒绝运行。
    expect(stderr, stderr).not.toContain('criteria.lock 不一致');
    expect(stderr, stderr).not.toContain('拒绝运行（fail-closed）');
    expect(stderr).not.toContain('[freeze]');
    expect(stdout).toContain('[run] E01 trial-1');
    // 无 key 的既有归类：infra exit 2 + INCONCLUSIVE（非模型行为结论）。
    expect(result.status, stderr).toBe(2);
    expect(stderr).toContain('未检测到 LLM_API_KEY');

    const lock = readLock();
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as {
      runMode: string;
      criteriaSha256: string;
      casesSha256: string;
      suite?: unknown;
    };
    expect(manifest.runMode).toBe('run');
    expect(manifest.suite).toBeUndefined();
    expect(manifest.criteriaSha256).toBe(lock.criteriaSha256);
    expect(manifest.casesSha256).toBe(lock.casesSha256);

    // 冻结副本（criteria/cases.json）逐字节 = manifest 哈希 = 锁值。
    expect(sha256Hex(readFileSync(path.join(outDir, 'criteria', 'criteria.json')))).toBe(lock.criteriaSha256);
    expect(sha256Hex(readFileSync(path.join(outDir, 'criteria', 'cases.json')))).toBe(lock.casesSha256);

    const summary = JSON.parse(readFileSync(path.join(outDir, 'summary.json'), 'utf8')) as {
      counts: { PASS: number; FAIL: number; INCONCLUSIVE: number };
      criteriaSha256: string;
      casesSha256: string;
    };
    expect(summary.criteriaSha256).toBe(lock.criteriaSha256);
    expect(summary.casesSha256).toBe(lock.casesSha256);
    expect(summary.counts).toEqual({ PASS: 0, FAIL: 0, INCONCLUSIVE: 1 });
  });

  it('冻结面 tripwire：criteria.lock 登记文件逐字节 sha256 未动', () => {
    const lock = readLock();
    const entries = Object.entries(lock.files);
    expect(entries.length).toBeGreaterThan(0);
    const mismatches: string[] = [];
    for (const [file, expected] of entries) {
      const actual = sha256Hex(readFileSync(path.join(REPO_ROOT, file)));
      if (actual !== expected) mismatches.push(`${file}（锁 ${expected}，实际 ${actual}）`);
    }
    expect(mismatches, `冻结面被改动：\n${mismatches.join('\n')}`).toEqual([]);
  });
});
