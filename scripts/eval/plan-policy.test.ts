/**
 * 四档预算表的机械链证明（issue #20 切片 B，不调 LLM、不碰真平台）。
 *
 * 链的形状：cases.yaml 的 `fixture.planPolicy` → cases.ts 解析/校验 →
 * `fixtureEnvOf()` 拍平成 `STOCK_PLAN_*` env → stock 夹具 `planPolicy()` 读取 →
 * `planDecision()` 判 `HARD_LIMIT`。夹具源码零改动；本测试只用临时 cases.yaml
 * 与 spawn，证明声明真的能到达夹具并改变判定。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PLAN_POLICY_ENV_KEYS,
  PLAN_POLICY_LINES,
  PLAN_POLICY_TIERS,
  fixtureEnvOf,
  loadCases,
} from './cases';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(evalDir, 'fixtures', 'stock-platform');
const stockBin = path.join(fixtureRoot, 'bin', 'stock');

/** stock 夹具 planPolicy() 全部读取点（12 个）。 */
const STOCK_PLAN_KEYS = PLAN_POLICY_TIERS.flatMap((tier) =>
  PLAN_POLICY_LINES.map((line) => PLAN_POLICY_ENV_KEYS[tier][line]));

function writeCasesFile(dir: string): string {
  const file = path.join(dir, 'cases.yaml');
  writeFileSync(file, `version: 1
cases:
  - id: T1
    group: test
    kind: probe
    inBaseline: false
    incidents: [test]
    intent: test
    businessGoal: test
    fixture:
      name: stock-platform
      isolation: per-case-state-dir
      env: {}
      planPolicy:
        auto: { calls: 2, seconds: 60, weight: 6 }
        notify: { calls: 10, seconds: 180, weight: 18 }
        confirm: { calls: 20, seconds: 600, weight: 60 }
        hard: { calls: 1, seconds: 1800, weight: 180 }
    allowedSideEffects:
      writableCollections: []
      writes: []
    messages:
      - text: hi
    expectations: null
    expect: test
`);
  return file;
}

function evaluatePlan(env: NodeJS.ProcessEnv, taskId: string, calls: number) {
  const r = spawnSync(stockBin, ['plan', 'evaluate', '--task-id', taskId, '--stdin'], {
    encoding: 'utf8',
    cwd: fixtureRoot,
    env,
    input: JSON.stringify({
      calls: Array.from({ length: calls }, () => ({ operation: 'stock.query', args: ['--shelf', 'north'] })),
    }),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('cases.yaml 的四档预算表真的驱动 stock 夹具（无模型）', () => {
  it('hard.calls=1：同参 2 次调用的计划被 HARD_LIMIT 拒；不声明时仍 execute', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'plan-policy-'));
    try {
      const spec = loadCases(writeCasesFile(dir))[0]!;
      const declared = fixtureEnvOf(spec.fixture);
      expect(Object.keys(declared).sort()).toEqual([...STOCK_PLAN_KEYS].sort());
      expect(declared['STOCK_PLAN_HARD_CALLS']).toBe('1');

      const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        EXECUTION_MOCK_STATE: path.join(dir, 'state.json'),
        EXECUTION_PLAN_STATE: path.join(dir, 'plans.json'),
        EXECUTION_PROPOSAL_STATE: path.join(dir, 'proposals.json'),
        EXECUTION_AUDIT_PATH: path.join(dir, 'audit.jsonl'),
      };
      // 对照组不能带 ambient 阈值：四档表是唯一旋钮来源。
      for (const key of STOCK_PLAN_KEYS) delete baseEnv[key];

      const control = evaluatePlan(baseEnv, 'control', 2);
      expect(control.status).toBe(0);
      expect(JSON.parse(control.stdout)).toMatchObject({ decision: 'execute', status: 'active' });

      const stopped = evaluatePlan({ ...baseEnv, ...declared }, 'declared', 2);
      expect(stopped.status).toBe(0);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        decision: 'stop',
        status: 'stopped',
        reasonCode: 'HARD_LIMIT',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
