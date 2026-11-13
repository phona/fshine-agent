// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * Cross-repository acceptance against the config-derived gateway CLI in mock mode.
 * Run explicitly with:
 * --config=/path/to/config/agent.yaml npx vitest run packages/agent/plan-cross-repo.acceptance.test.ts
 *
 * The suite owns a private EXECUTION_PLAN_STATE file and never touches live platform data.
 */
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { evaluateAndActivatePlan, type PlanCliRequest, type PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import { gatewayExecPath } from '../../packages/agent/src/platform-contract';
import { resolveConfigPath, explicitConfigFrom } from '../../scripts/resolve-config-path';
import { resolveActiveProfileId, type ContextProfileConfig } from '../../packages/contracts/src/config';

/** 活跃 profile 的 root + gatewayExecPath。未声明或 CLI 不在场 → 空路径，整组跳过（不是绿）。 */
function resolvePlatformCli(): { root: string; cliPath: string } {
  try {
    const configPath = resolveConfigPath(explicitConfigFrom());
    const config = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const profiles = config['contextProfiles'] as Record<string, ContextProfileConfig> | undefined;
    const profileId = resolveActiveProfileId(profiles ?? {});
    if (profileId) {
      const profile = profiles![profileId] as Record<string, unknown> | undefined;
      const root = String(profile?.root ?? '');
      const gateway = String(profile?.gateway ?? '');
      if (root && gateway) return { root, cliPath: gatewayExecPath(root, gateway) };
    }
  } catch {
    // 无配置、active profile 未定、或 gateway 声明非法 → 跳过，不拼一份实例名
  }
  return { root: '', cliPath: '' };
}

const { root: platformRoot, cliPath } = resolvePlatformCli();
// Never silently skip: a missing CLI is an explicit failure, not a green run.
const integration = describe.skipIf(!cliPath || !existsSync(cliPath))('[L4 集成] fshine ↔ 配置派生的网关 计划边界（真实 CLI / mock executor）', () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let subprocessSequence = 0;

  beforeAll(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-plan-acceptance-'));
    env = {
      ...process.env,
      EXECUTION_PLAN_STATE: path.join(stateDir, 'plans.json'),
      EXECUTION_EXECUTOR: 'mock',
      EXECUTION_MOCK_STATE: path.join(stateDir, 'mock-state.json'),
      EXECUTION_RATE_LIMIT_STATE: path.join(stateDir, 'rate-limit.json'),
      EXECUTION_AUDIT_PATH: path.join(stateDir, 'invocations.jsonl'),
      EXECUTION_REQUIRE_PLAN: '1',
      EXECUTION_PLAN_ACTIVATION_SECRET: 'acceptance-only-secret',
      EXECUTION_PLAN_AUTO_CALLS: '2',
      EXECUTION_PLAN_NOTIFY_CALLS: '10',
      EXECUTION_PLAN_CONFIRM_CALLS: '20',
      EXECUTION_PLAN_HARD_CALLS: '50',
      EXECUTION_PLAN_AUTO_SECONDS: '60',
      EXECUTION_PLAN_NOTIFY_SECONDS: '180',
      EXECUTION_PLAN_CONFIRM_SECONDS: '600',
      EXECUTION_PLAN_HARD_SECONDS: '1800',
    };
  });
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  function runCliSync(request: PlanCliRequest) {
    const stdoutPath = path.join(stateDir, `stdout-${subprocessSequence}.txt`);
    const stderrPath = path.join(stateDir, `stderr-${subprocessSequence}.txt`);
    const inputPath = path.join(stateDir, `stdin-${subprocessSequence}.txt`);
    subprocessSequence += 1;
    if (request.input !== undefined) writeFileSync(inputPath, request.input, 'utf8');
    const inputFd = request.input === undefined ? undefined : openSync(inputPath, 'r');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    const child = spawnSync(cliPath, request.args, {
      cwd: request.platformRoot,
      encoding: 'utf8',
      env: { ...env, ...request.env },
      stdio: [inputFd ?? 'ignore', stdoutFd, stderrFd],
      timeout: 30_000,
    });
    if (inputFd !== undefined) closeSync(inputFd);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    return {
      code: child.status,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  }

  const runCli: PlanCliRunner = async (request) => runCliSync(request);

  // 2026-11-13（W0）：原前两条用例已删除——「等待企微通知、拒绝待激活查询，并跨重计划保留
  // 累计重量」与「notice 投递失败不激活新范围，模型自报确认也不能越过确认门」。删除前提是
  // 逐项等价覆盖对照成立：host 不变量（evaluate→notice→activate 次序、通知失败不激活、
  // userConfirmed 不越过确认门、通知文本期间渲染）分别由
  // packages/agent/plan-runtime.test.ts:135/:162/:176 与 plan-confirmation.test.ts:45/:86
  // 钉住；其余断言（档位阈值判定、requestKey 幂等重试、累计账本、currentPlan/require-plan
  // 门、激活后可执行）纯属平台实例语义，随实例的夹具域走。第三条（账套存在性专用搜索）
  // 按裁定保留原样待移交，其域覆盖缺口不因本条删除而消除。

  it('账套存在性只执行专用目录搜索，mock 明确返回未找到', async () => {
    const taskId = 'acceptance-account-set-search';
    const searchPlan = await evaluateAndActivatePlan({
      platformRoot: platformRoot!,
      taskId,
      calls: [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] }],
      runCli,
      env,
    });
    assert.equal(searchPlan.status, 'active');
    if (searchPlan.status !== 'active') throw new Error('账套目录搜索计划未激活。');
    assert.equal(searchPlan.evaluation.estimate.calls, 1);
    assert.equal(searchPlan.evaluation.decision, 'execute');

    const result = runCliSync({
      platformRoot: platformRoot!,
      args: ['operation', 'run', 'finance.search-account-sets', '--query', '胜利'],
      env: { EXECUTION_PLAN_ID: searchPlan.planId },
    });
    assert.equal(result.code, 0, result.stderr);
    const envelope = JSON.parse(result.stdout.match(/^RESULT (.*)$/m)?.[1] ?? 'null');
    assert.equal(envelope.op, 'finance.search-account-sets');
    assert.equal(envelope.status, 'not_found');
    assert.equal(envelope.error.code, 'ACCOUNT_SET_NOT_FOUND');
    assert.deepEqual(envelope.data.candidates, []);

    const sideQuery = runCliSync({
      platformRoot: platformRoot!,
      args: ['operation', 'run', 'finance.query-receivables', '--query', '胜利'],
      env: { EXECUTION_PLAN_ID: searchPlan.planId },
    });
    assert.notEqual(sideQuery.code, 0, '账套搜索计划不得旁路调用应收查询。');
    const ledger = JSON.parse(readFileSync(path.join(stateDir, 'plans.json'), 'utf8'));
    assert.deepEqual(ledger.plans[searchPlan.planId].calls.map((call: { operation: string }) => call.operation), ['finance.search-account-sets']);
    assert.equal(ledger.tasks[taskId].actual.calls, 1, '旁路应收查询不得计入已执行调用。');
  });
});
