/**
 * `scripts/cleanup-runs.ts`：run 目录保留期清理的**显式入口**（ops 面）。
 *
 * 钉住三件事：
 *   · 参数面：缺省 = 实际清理；`--dry-run` 才空跑；`--config=` 透传、未知/位置参数拒绝；
 *   · import 无副作用（`import.meta.main` 守卫）：被 import 时不执行任何清理；
 *   · 接线边界：server/ask 等产品启动路径不引用清理执行器（默认行为零变化，
 *     删除只能由运维显式触发）。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCleanupRunsArgs } from './cleanup-runs';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('cleanup-runs 参数解析', () => {
  it('缺省 = 实际清理（dryRun=false）', () => {
    expect(parseCleanupRunsArgs([])).toEqual({ dryRun: false });
  });

  it('--dry-run 开启空跑；--config=<path> 透传不报错', () => {
    expect(parseCleanupRunsArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(parseCleanupRunsArgs(['--dry-run', '--config=/tmp/agent.yaml'])).toEqual({ dryRun: true });
  });

  it('未知参数 / 位置参数 / 重复 --dry-run 一律拒绝（usageError）', () => {
    expect(parseCleanupRunsArgs(['--apply'])).toHaveProperty('usageError');
    expect(parseCleanupRunsArgs(['what'])).toHaveProperty('usageError');
    expect(parseCleanupRunsArgs(['--dry-run', '--dry-run'])).toHaveProperty('usageError');
  });
});

describe('cleanup-runs：import 无副作用', () => {
  it('import scripts/cleanup-runs.ts 不执行清理、不打任何输出', () => {
    const probe = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', "await import('./scripts/cleanup-runs.ts'); console.log('IMPORT-DONE');"],
      { cwd: REPO_ROOT, env: { ...process.env, AGENT_CONFIG_PATH: '' }, encoding: 'utf8' },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe('IMPORT-DONE\n');
    expect(probe.stderr).toBe('');
  });
});

describe('接线边界：产品启动路径不自动删除', () => {
  it('server / ask 装配不引用清理执行器（只有 scripts/cleanup-runs.ts 这个显式入口）', () => {
    const productionEntries = [
      'apps/server/main.ts',
      'apps/server/server.ts',
      'scripts/ask.ts',
      'scripts/ask-runtime.ts',
      'scripts/ops.ts',
    ];
    for (const relative of productionEntries) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(source, `${relative} 不得引用 run-dir-cleanup`).not.toContain('run-dir-cleanup');
    }
  });
});
