/**
 * `scripts/cleanup-runs.ts`：run 目录保留期清理的**显式入口**（ops 面）。
 *
 * 钉住三件事：
 *   · 参数面：缺省 = 实际清理；`--dry-run` 才空跑；`--config=` 透传、未知/位置参数拒绝；
 *   · import 无副作用（`import.meta.main` 守卫）：被 import 时不执行任何清理；
 *   · 接线边界：清理执行器的产品接线只有 server 启动开关（`runtime.fileRetentionSweepOnStart`，
 *     缺省 false）——main 经 startup-sweep 间接引用，ask/ops 等入口零引用；
 *     server 未开启开关时默认行为零变化，删除只能由运维显式触发。
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

describe('接线边界：清理执行器只经 server 启动开关接入', () => {
  it('server / ask 装配链不直接引用执行器；唯一的产品接线模块是 startup-sweep', () => {
    const productionEntries = [
      'apps/server/main.ts',
      'apps/server/server.ts',
      'scripts/ask.ts',
      'scripts/ask-runtime.ts',
      'scripts/ops.ts',
    ];
    for (const relative of productionEntries) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(source, `${relative} 不得直接引用 run-dir-cleanup`).not.toContain('run-dir-cleanup');
      expect(source, `${relative} 不得直接引用 file-ref-cleanup`).not.toContain('file-ref-cleanup');
    }
    const startupSweep = readFileSync(path.join(REPO_ROOT, 'apps/server/startup-sweep.ts'), 'utf8');
    expect(startupSweep, 'server 启动开关必须复用同一清理执行器').toContain(
      "packages/agent/src/run-dir-cleanup",
    );
    expect(startupSweep, 'server 启动开关同一轮回收过期文件字节').toContain(
      "packages/agent/src/file-ref-cleanup",
    );
  });

  it('cleanup-runs 显式入口同时接线过期文件引用字节回收（同一入口，不是第二套清理器）', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'scripts/cleanup-runs.ts'), 'utf8');
    expect(source).toContain("packages/agent/src/file-ref-cleanup");
    expect(source).toContain('file_ref_cleanup_summary');
    expect(source, '底账只读打开（不建库、不写库、不删行）').toContain('readOnly: true');
  });

  it('main 在启动装配完成后、开始接消息（startChannelForMode）之前调用启动清扫', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'apps/server/main.ts'), 'utf8');
    const sweepAt = source.indexOf('sweepExpiredRunDirsOnStart(');
    const startChannelAt = source.indexOf('await startChannelForMode(');
    expect(sweepAt, 'main.ts 必须调用启动清扫').toBeGreaterThan(-1);
    expect(startChannelAt, 'main.ts 必须仍启动渠道').toBeGreaterThan(-1);
    expect(sweepAt, '启动清扫必须在渠道开始接消息之前').toBeLessThan(startChannelAt);
  });
});
