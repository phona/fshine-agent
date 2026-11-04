/**
 * 跨仓预算阈值校验脚本的测试（debt/second-truth，主题 3a）。
 *
 * 测三件事，缺一不可——只测“脚本存在”等于没测：
 * ① 夹具一致时脚本 exit 0；② 17dz 侧改一个阈值时脚本 exit 1 且点名该键；
 * ③ 17dz 侧缺一个阈值时脚本非 0（解析不到即 fail，不静默通过）。
 * 真实两仓比对是环境相关的（需要一个 17dz 检出）：CROSS_REPO_17DZ_ROOT
 * 指向检出时跑真比对、必须 exit 0；未指向时该用例 skip，并在用例名里写明
 * skip 原因——默认 `npm test` 的绿灯不包含真跨仓比对，这一点不许含糊。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const script = path.join(repoRoot, 'scripts/cross-repo/check-budget-thresholds.mjs');

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function fixtureRoots(dzBudgetWeight = 60, dzOmitHardWeight = false) {
  directory = mkdtempSync(path.join(tmpdir(), 'fshine-budget-cross-'));
  const fshineRoot = path.join(directory, 'fshine');
  const dzRoot = path.join(directory, 'dz');
  mkdirSync(path.join(fshineRoot, 'packages/agent/src'), { recursive: true });
  mkdirSync(path.join(dzRoot, 'src/execution'), { recursive: true });
  writeFileSync(path.join(fshineRoot, 'packages/agent/src/budget-policy.ts'),
    'export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = {\n'
    + '  autoCalls: 2,\n  notifyCalls: 10,\n  confirmCalls: 20,\n  hardCalls: 50,\n'
    + '  autoSeconds: 60,\n  notifySeconds: 180,\n  confirmSeconds: 600,\n  hardSeconds: 1800,\n'
    + '  autoWeight: 6,\n  notifyWeight: 18,\n  budgetWeight: 60,\n  hardWeight: 180,\n};\n');
  const dzLines = [
    'autoCalls: configured(env, \'EXECUTION_PLAN_AUTO_CALLS\', 2),',
    'notifyCalls: configured(env, \'EXECUTION_PLAN_NOTIFY_CALLS\', 10),',
    'confirmCalls: configured(env, \'EXECUTION_PLAN_CONFIRM_CALLS\', 20),',
    'hardCalls: configured(env, \'EXECUTION_PLAN_HARD_CALLS\', 50),',
    'autoSeconds: configured(env, \'EXECUTION_PLAN_AUTO_SECONDS\', 60),',
    'notifySeconds: configured(env, \'EXECUTION_PLAN_NOTIFY_SECONDS\', 180),',
    'confirmSeconds: configured(env, \'EXECUTION_PLAN_CONFIRM_SECONDS\', 600),',
    'hardSeconds: configured(env, \'EXECUTION_PLAN_HARD_SECONDS\', 1800),',
    'autoWeight: configured(env, \'EXECUTION_PLAN_AUTO_WEIGHT\', 6),',
    'notifyWeight: configured(env, \'EXECUTION_PLAN_NOTIFY_WEIGHT\', 18),',
    `budgetWeight: configured(env, 'EXECUTION_PLAN_BUDGET_WEIGHT', ${dzBudgetWeight}),`,
  ];
  if (!dzOmitHardWeight) dzLines.push('hardWeight: configured(env, \'EXECUTION_PLAN_HARD_WEIGHT\', 180),');
  writeFileSync(path.join(dzRoot, 'src/execution/plan.js'), `function policy(env) {\n  return {\n    ${dzLines.join('\n    ')}\n  };\n}\n`);
  return { fshineRoot, dzRoot };
}

function run(fshineRoot: string, dzRoot: string) {
  try {
    const stdout = execFileSync(process.execPath, [script, dzRoot, '--fshine-root', fshineRoot], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: err.status ?? -1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
    };
  }
}

describe('跨仓预算阈值校验脚本', () => {
  it('夹具一致：exit 0 且报 12/12 一致', () => {
    const { fshineRoot, dzRoot } = fixtureRoots();
    const r = run(fshineRoot, dzRoot);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('12/12 一致');
  });

  it('17dz 侧改一个阈值：exit 1 且点名该键（变异验证：校验不是恒绿）', () => {
    const { fshineRoot, dzRoot } = fixtureRoots(61);
    const r = run(fshineRoot, dzRoot);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain('budgetWeight');
  });

  it('17dz 侧缺一个阈值：非 0（解析不到即 fail，不静默通过）', () => {
    const { fshineRoot, dzRoot } = fixtureRoots(60, true);
    const r = run(fshineRoot, dzRoot);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('hardWeight');
  });

  it.skipIf(!process.env.CROSS_REPO_17DZ_ROOT || !existsSync(process.env.CROSS_REPO_17DZ_ROOT))(
    '真实两仓比对（仅 CROSS_REPO_17DZ_ROOT 指向 17dz 检出时跑；未指向时 skip，不计入默认绿灯）',
    () => {
      const dzRoot = process.env.CROSS_REPO_17DZ_ROOT as string;
      const r = run(repoRoot, dzRoot);
      expect(r.code, r.stdout + r.stderr).toBe(0);
    },
  );
});
