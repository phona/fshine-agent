/**
 * 适配器级测试：ExecutionClient 语义 ↔ 仓内 dummy 网关 CLI 的翻译（只跑 mock，不触网）。
 *
 * 覆盖：
 *   · 能力快照 = `operation list --json` 投影（契约版本、args 声明、label）；
 *   · 结构化请求走 `call --file`，args 键按执行层声明规范化（裸名 → 声明形态）；
 *   · 结果五态映射：completed / needs_input（缺什么结构化）/ refused（未登记 operation）；
 *   · 拒绝路径：继承 env 里的 EXECUTION_REQUIRE_PLAN=1 **不会**被适配器传给子进程
 *     （白名单在 spawn 面生效）——对照组直接 spawn 同一网关则被 plan 门拒。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXECUTION_CONTRACT_VERSION } from '@fshine/contracts/execution-contract';
import { createDummyCliClient, readOnlyOperationNames } from './src/dummy-cli-client';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'dummy-client-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function clientWith(env: NodeJS.ProcessEnv) {
  return createDummyCliClient({ root: FIXTURE_ROOT, gateway: 'bin/dummy', stateDir, env });
}

describe('dummy 执行层适配器（Execution Contract 传输面）', () => {
  it('能力快照与只读作用域派生', async () => {
    const client = clientWith({ PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] });
    const operations = await client.listOperations();
    expect(operations.some((entry) => entry.name === 'dummy.query')).toBe(true);

    const readOnly = readOnlyOperationNames(operations);
    expect(readOnly).toContain('dummy.query');
    expect(readOnly).not.toContain('dummy.commit');

    const manifest = await client.capabilities();
    expect(manifest.contractVersion).toBe(EXECUTION_CONTRACT_VERSION);
    const query = manifest.operations.find((entry) => entry.name === 'dummy.query');
    expect(query?.label).toBeTruthy();
    const collection = query?.args.find((entry) => entry.name === '--collection');
    expect(collection?.required).toBe(true);
    const commit = manifest.operations.find((entry) => entry.name === 'dummy.commit');
    expect(commit).toBeTruthy();
  });

  it('结构化执行：call --file 返回 completed 与审计行；裸参数名按声明规范化', async () => {
    const client = clientWith({
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      TMPDIR: process.env['TMPDIR'],
      LLM_API_KEY: 'sentinel-llm-key',
      WECOM_CORP_SECRET: 'sentinel-wecom',
      AGENT_CONFIG_PATH: 'sentinel-config.yaml',
    });
    const outcome = await client.execute({
      requestId: 'req_test_1',
      operation: 'dummy.query',
      args: { '--collection': 'documents', '--window': 'W202611' },
    });
    expect(outcome.status).toBe('completed');
    const data = (outcome as { data?: { collection?: string; count?: number } }).data;
    expect(data?.collection).toBe('documents');
    expect(data?.count).toBe(3);

    // 裸名（collection）按执行层声明规范化为 --collection，同样完成。
    const bare = await client.execute({
      requestId: 'req_test_2',
      operation: 'dummy.query',
      args: { collection: 'alpha', window: 'W1' },
    });
    expect(bare.status).toBe('completed');
    expect((bare as { data?: { count?: number } }).data?.count).toBe(2);

    const rows = readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    const last = rows[rows.length - 1]!;
    expect(last.mode).toBe('query');
    expect(last.via).toBe('structured');
    expect(last.script).toBe('dummy.query');
    expect(last.exitCode).toBe(0);
    expect(last.args).toContain('--collection');
  });

  it('拒绝与澄清：未登记 operation → refused；歧义 → needs_input（缺什么非空）', async () => {
    const client = clientWith({ PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] });
    const refused = await client.execute({ requestId: 'req_test_3', operation: 'dummy.nope', args: {} });
    expect(refused.status).toBe('refused');
    if (refused.status === 'refused') {
      expect(refused.error.code).toBe('CALL_REFUSE');
    }

    const ambiguous = await client.execute({ requestId: 'req_test_4', operation: 'dummy.query', args: { '--collection': 'contoso' } });
    expect(ambiguous.status).toBe('needs_input');
    if (ambiguous.status === 'needs_input') {
      expect(ambiguous.missing.length).toBeGreaterThan(0);
      expect(ambiguous.missing[0]!.description).toContain('matches');
    }

    expect(await client.cancel('req_test_1')).toBe('not_found');
  });

  it('白名单在 spawn 面生效：继承 env 的计划旋钮不达子进程（对照组直接 spawn 被拒）', async () => {
    const client = clientWith({
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      TMPDIR: process.env['TMPDIR'],
      EXECUTION_REQUIRE_PLAN: '1',
    });
    // 适配器路径：EXECUTION_REQUIRE_PLAN 被白名单丢掉，读调用照常完成。
    const outcome = await client.execute({
      requestId: 'req_test_5',
      operation: 'dummy.query',
      args: { '--collection': 'alpha' },
    });
    expect(outcome.status).toBe('completed');

    // 对照组：同一份继承 env 不经白名单直接 spawn → dummy 计划门拒绝（PLAN_REQUIRED）。
    const controlDir = mkdtempSync(path.join(os.tmpdir(), 'dummy-control-'));
    const controlState = mkdtempSync(path.join(os.tmpdir(), 'dummy-control-state-'));
    try {
      const callFile = path.join(controlDir, 'call.json');
      writeFileSync(callFile, JSON.stringify({ operation: 'dummy.query', args: { '--collection': 'alpha' } }));
      const control = spawnSync(path.join(FIXTURE_ROOT, 'bin', 'dummy'), ['call', '--file', callFile, '--state-dir', controlState], {
        cwd: FIXTURE_ROOT,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'],
          HOME: process.env['HOME'],
          TMPDIR: process.env['TMPDIR'],
          EXECUTION_REQUIRE_PLAN: '1',
        },
      });
      expect(control.status).toBe(3);
      expect(control.stderr).toContain('GATE_REFUSE');
      const controlRows = readFileSync(path.join(controlState, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(controlRows.some((row) => row.refused === 'PLAN_REQUIRED')).toBe(true);
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
      rmSync(controlState, { recursive: true, force: true });
    }
  });
});
