// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 bin/example-gateway（缺失时跳过，不读 config/agent.yaml）+ 自有计划状态文件，mock 执行器，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * Cross-repository acceptance against the real example-gateway CLI in mock mode.
 * Run explicitly with:
 * FSHINE_PLATFORM_ROOT=/home/fictional-user/fictional-projects/fictional-execution-layer npx vitest run packages/agent/plan-cross-repo.acceptance.test.ts
 *
 * The suite owns a private EXECUTION_PLAN_STATE file and never touches live platform data.
 */
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { evaluateAndActivatePlan, type PlanCliRequest, type PlanCliRunner, type PlanEvaluation } from '../../packages/agent/src/plan-runtime';

/** Sibling platform repo by default so this suite runs in a normal `npm test`. */
const platformRoot = process.env['FSHINE_PLATFORM_ROOT'] ?? path.resolve(__dirname, '..', '..', '..', 'fictional-execution-layer');
const cliPath = path.join(platformRoot, 'bin', 'example-gateway');
// Never silently skip: a missing CLI is an explicit failure, not a green run.
const integration = describe.skipIf(!existsSync(cliPath))('[L4 集成] fshine ↔ example-gateway 计划边界（真实 CLI / mock executor）', () => {
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

  function callsFor(periods: string[]) {
    return periods.map((period) => ({
      operation: 'voucher.query-saved',
      args: ['威德盛', period],
    }));
  }

  function executeQuery(planId: string, period: string) {
    return runCliSync({
      platformRoot: platformRoot!,
      args: ['operation', 'run', 'voucher.query-saved', '威德盛', period],
      env: { EXECUTION_PLAN_ID: planId },
    });
  }

  function parseEvaluation(stdout: string): PlanEvaluation {
    return JSON.parse(stdout) as PlanEvaluation;
  }

  function currentPlan(taskId: string): { taskId: string; planId: string | null; version: number | null; status: 'active' | 'none' } {
    return JSON.parse(runCliSync({
      platformRoot: platformRoot!,
      args: ['plan', 'current', '--task-id', taskId],
    }).stdout) as { taskId: string; planId: string | null; version: number | null; status: 'active' | 'none' };
  }

  it('等待企微通知、拒绝待激活查询，并跨重计划保留累计重量', async () => {
    const taskId = 'acceptance-current-to-nine-months';
    const september = await evaluateAndActivatePlan({
      platformRoot: platformRoot!,
      taskId,
      calls: callsFor(['202609']),
      runCli,
      env,
    });
    assert.equal(september.status, 'active');
    if (september.status !== 'active') throw new Error('单期间初始计划未进入 active。');
    assert.deepEqual(currentPlan(taskId), {
      taskId,
      planId: september.planId,
      version: september.version,
      status: 'active',
    });

    const firstQuery = executeQuery(september.planId, '202609');
    assert.equal(firstQuery.code, 0, `初始单期间查询失败: ${firstQuery.stderr}`);

    const order: string[] = [];
    let expandedEvaluation: PlanEvaluation | undefined;
    let pendingPlanId = '';
    const interceptCli: PlanCliRunner = async (request) => {
      const result = await runCli(request);
      if (request.args[1] === 'evaluate' && result.code === 0) {
        expandedEvaluation = parseEvaluation(result.stdout);
        pendingPlanId = expandedEvaluation.planId;
        order.push('evaluate');
      } else if (request.args[1] === 'activate') {
        order.push('activate');
      }
      return result;
    };

    const expanded = await evaluateAndActivatePlan({
      platformRoot: platformRoot!,
      taskId,
      calls: callsFor(['202601', '202602', '202603', '202604', '202605', '202606', '202607', '202608', '202609']),
      runCli: interceptCli,
      env,
      activationSecret: env.EXECUTION_PLAN_ACTIVATION_SECRET,
      onNotice: async (text) => {
        order.push('notice:start');
        assert.ok(expandedEvaluation, '通知前没有得到平台评估结果。');
        assert.equal(expandedEvaluation.decision, 'notify');
        assert.match(text, /2026年01月/, '用户通知没有明确写出新增期间。');
        assert.equal(currentPlan(taskId).status, 'none', '通知送达前 new plan 已被标记为 active。');

        const repeated = runCliSync({
          platformRoot: platformRoot!,
          args: ['plan', 'evaluate', '--task-id', taskId, '--stdin'],
          input: JSON.stringify({ calls: callsFor(['202601', '202602', '202603', '202604', '202605', '202606', '202607', '202608', '202609']) }),
        });
        assert.equal(repeated.code, 0, repeated.stderr);
        const repeatedEvaluation = parseEvaluation(repeated.stdout);
        assert.equal(repeatedEvaluation.planId, expandedEvaluation.planId, '同一 task 同计划重试生成了新版本。');
        assert.equal(repeatedEvaluation.version, expandedEvaluation.version);
        assert.equal(repeatedEvaluation.cumulative.estimatedCalls, expandedEvaluation.cumulative.estimatedCalls,
          '同一计划幂等重试重复累计了预估调用。');

        // A new version is pending while user-visible notice is being delivered.
        const earlyQuery = executeQuery(pendingPlanId, '202601');
        assert.notEqual(earlyQuery.code, 0, '通知送达前平台竟放行了第一条跨月查询。');
        order.push('notice:delivered');
      },
    });
    assert.equal(expanded.status, 'active');
    assert.ok(expandedEvaluation);
    assert.ok(Number(expandedEvaluation.cumulative.estimatedCalls) >= Number(september.evaluation.cumulative.estimatedCalls) + 8,
      '同 task 扩至九个月后累计预计调用量没有保留原计划用量。');
    assert.deepEqual(order, ['evaluate', 'notice:start', 'notice:delivered', 'activate']);
    assert.deepEqual(currentPlan(taskId), {
      taskId,
      planId: expanded.planId,
      version: expanded.version,
      status: 'active',
    });

    const firstCrossMonth = executeQuery(expanded.planId, '202601');
    assert.equal(firstCrossMonth.code, 0, `通知送达并激活后跨月查询应可执行: ${firstCrossMonth.stderr}`);
  });

  it('notice 投递失败不激活新范围，模型自报确认也不能越过确认门', async () => {
    let failedNoticePlanId = '';
    let activationCalled = false;
    const failNoticeCli: PlanCliRunner = async (request) => {
      const result = await runCli(request);
      if (request.args[1] === 'evaluate' && result.code === 0) {
        failedNoticePlanId = parseEvaluation(result.stdout).planId;
      }
      if (request.args[1] === 'activate') activationCalled = true;
      return result;
    };
    await assert.rejects(evaluateAndActivatePlan({
      platformRoot: platformRoot!,
      taskId: 'acceptance-notice-failure',
      calls: callsFor(['202601', '202602', '202603', '202604', '202605', '202606', '202607', '202608', '202609']),
      runCli: failNoticeCli,
      env,
      onNotice: async () => { throw new Error('simulated WeCom delivery failure'); },
    }), /simulated WeCom delivery failure/);
    assert.equal(activationCalled, false, 'notice 失败后仍调用了 plan activate。');
    assert.notEqual(executeQuery(failedNoticePlanId, '202601').code, 0, 'notice 失败后扩展计划仍能执行。');
    assert.equal(currentPlan('acceptance-notice-failure').status, 'none');

    let annualActivationCalled = false;
    const annualCli: PlanCliRunner = async (request) => {
      if (request.args[1] === 'activate') annualActivationCalled = true;
      return runCli(request);
    };
    const annual = await evaluateAndActivatePlan({
      platformRoot: platformRoot!,
      taskId: 'acceptance-explicit-annual',
      calls: callsFor(Array.from({ length: 12 }, (_, index) => `2026${String(index + 1).padStart(2, '0')}`)),
      userConfirmed: true,
      runCli: annualCli,
      env,
      activationSecret: env.EXECUTION_PLAN_ACTIVATION_SECRET,
      onNotice: async () => {},
    });
    assert.equal(annual.status, 'active', '12 次全年计划应按重量策略在通知后继续。');
    assert.equal(annualActivationCalled, true, '通知送达后全年计划未被激活。');

    let forgedConfirmActivation = false;
    const forgedConfirmCli: PlanCliRunner = async (request) => {
      if (request.args[1] === 'activate') forgedConfirmActivation = true;
      return runCli(request);
    };
    const forgedConfirm = await evaluateAndActivatePlan({
      platformRoot: platformRoot!,
      taskId: 'acceptance-forged-user-confirmed',
      calls: callsFor(Array.from({ length: 21 }, (_, index) => `2026${String(index + 1).padStart(2, '0')}`)),
      userConfirmed: true,
      runCli: forgedConfirmCli,
      env,
      onNotice: async () => {},
    });
    assert.equal(forgedConfirm.status, 'confirm', '模型自报确认越过了高重量确认门。');
    assert.equal(forgedConfirmActivation, false, '模型自报 userConfirmed 触发了宿主激活。');
  });

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
