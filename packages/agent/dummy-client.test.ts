/**
 * 适配器级测试：ExecutionClient 语义 ↔ 仓内 dummy 网关 CLI 的翻译（只跑 mock，不触网）。
 *
 * 覆盖：
 *   · 能力快照 = `operation list --json` 投影（契约版本、args 声明含 style→type、label）；
 *   · 结构化请求走 `call --file`，args 键按执行层声明规范化（裸名 → 声明形态）；
 *   · 结果四态映射：completed / needs_input（缺什么结构化）/ refused（未登记 operation）/
 *     failed；not_found 信封是执行完成（确定性答案，宿主不改写语义）；
 *   · 失败映射：清单非 JSON / exit≠0 / 超时 fail-closed；调用超时 / 未知状态 / 无信封
 *     按机械 code 分流（stub 网关，零网络）；
 *   · 拒绝路径：继承 env 里的 EXECUTION_REQUIRE_PLAN=1 **不会**被适配器传给子进程
 *     （白名单在 spawn 面生效）——对照组直接 spawn 同一网关则被 plan 门拒。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXECUTION_CONTRACT_VERSION } from '@fshine/contracts/execution-contract';
import { createDummyCliClient, readOnlyOperationNames } from './src/dummy-cli-client';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

let stateDir: string;
const stubRoots: string[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'dummy-client-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  for (const dir of stubRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] };
}

function clientWith(env: NodeJS.ProcessEnv) {
  return createDummyCliClient({ root: FIXTURE_ROOT, gateway: 'bin/dummy', stateDir, env });
}

/**
 * 生成最小 stub 网关（只实现 `operation list --json` 与 `call --file` 两个入口），
 * 覆盖 fixture 无法稳定制造的失败面：清单非 JSON / exit≠0 / 超时；调用超时 / 未知状态 /
 * 无信封；needs_input 的声明缺参分支。行为由嵌入脚本的 mode 决定（env 白名单只放行
 * PATH/HOME/TMPDIR，不能靠环境变量改道）。
 */
function writeStubGateway(rootDir: string, mode: string): void {
  const operations = [
    { name: 'stub.slow', access: 'read', args: { flags: [{ flag: '--collection', required: false, style: 'name' }] } },
    { name: 'stub.weird', access: 'read', args: { flags: [] } },
    { name: 'stub.noenvelope', access: 'read', args: { flags: [] } },
    { name: 'stub.needs', access: 'read', args: { flags: [{ flag: '--collection', required: true, style: 'name' }] } },
  ];
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args[0] === 'operation' && args[1] === 'list') {
  if (mode === 'list-nonjson') { process.stdout.write('not-json\\n'); process.exit(0); }
  if (mode === 'list-exit2') { process.stderr.write('list boom\\n'); process.exit(2); }
  if (mode === 'list-slow') { setTimeout(() => process.stdout.write('{"operations":[]}'), 5000); }
  else {
    process.stdout.write(JSON.stringify(${JSON.stringify({ operations })}));
    process.exit(0);
  }
} else if (args[0] === 'call') {
  const file = args[args.indexOf('--file') + 1];
  const call = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (call.operation === 'stub.slow') { setTimeout(() => process.stdout.write('RESULT {"status":"completed"}'), 5000); }
  else if (call.operation === 'stub.weird') { process.stdout.write('RESULT {"status":"banana"}\\n'); process.exit(0); }
  else if (call.operation === 'stub.noenvelope') { process.stdout.write('no envelope\\n'); process.exit(7); }
  else if (call.operation === 'stub.needs') { process.stdout.write('RESULT {"status":"needs_input","error":{"code":"COLLECTION_AMBIGUOUS","message":"More than one collection matches"}}\\n'); process.exit(0); }
  else { process.exit(9); }
} else {
  process.exit(9);
}
`;
  mkdirSync(path.join(rootDir, 'bin'), { recursive: true });
  const stub = path.join(rootDir, 'bin', 'stub');
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
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
    // 声明投影：执行层 style 原样投影为 type（展示面，不参与业务判断）。
    expect(collection?.type).toBe('name');
    const windowArg = query?.args.find((entry) => entry.name === '--window');
    expect(windowArg?.required).toBe(false);
    expect(windowArg?.type).toBe('code');
    // 位置参数投影在 flags 之前（payload 是 dummy.proposal 的必填位置参数）。
    const proposal = manifest.operations.find((entry) => entry.name === 'dummy.proposal');
    expect(proposal?.args[0]).toMatchObject({ name: 'payload', required: true });
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

  it('响应：not_found 信封映射为 completed（确定性答案，宿主不改写语义）', async () => {
    const client = clientWith(baseEnv());
    const outcome = await client.execute({ requestId: 'req_nf', operation: 'dummy.query', args: { '--collection': 'nope' } });
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.data).toMatchObject({ query: 'nope', candidates: [] });
    }
  });

  it('响应：failed 信封映射为 failed；error 原样透传（含 correctForm details）', async () => {
    const client = clientWith(baseEnv());
    // 缺必填参数 → QUERY_REQUIRED（failed 信封）。
    const missing = await client.execute({ requestId: 'req_fail_1', operation: 'dummy.query', args: {} });
    expect(missing.status).toBe('failed');
    if (missing.status === 'failed') {
      expect(missing.error.code).toBe('QUERY_REQUIRED');
      expect(missing.error.message).toContain('--collection');
      expect(missing.error.details).toMatchObject({ correctForm: 'Provide --collection <name>.' });
    }

    // 锁定集合的写入准备 → COLLECTION_LOCKED（failed 信封 + 非零退出码，信封优先于退出码）。
    const locked = await client.execute({ requestId: 'req_fail_2', operation: 'dummy.prepare', args: { '--collection': 'locked-one' } });
    expect(locked.status).toBe('failed');
    if (locked.status === 'failed') {
      expect(locked.error.code).toBe('COLLECTION_LOCKED');
    }
  });
});

describe('dummy 适配器的失败映射（stub 网关，零网络）', () => {
  function stubClient(mode: string, timeoutMs?: number) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dummy-stub-'));
    stubRoots.push(root);
    writeStubGateway(root, mode);
    return createDummyCliClient({
      root,
      gateway: 'bin/stub',
      stateDir,
      env: baseEnv(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  it('能力清单读取失败（非 JSON / exit≠0 / 超时）→ fail-closed 抛错', async () => {
    await expect(stubClient('list-nonjson').listOperations()).rejects.toThrow('不是可解析的 JSON');
    await expect(stubClient('list-exit2').listOperations()).rejects.toThrow('读取失败（exit 2）');
    await expect(stubClient('list-slow', 300).listOperations()).rejects.toThrow('读取超时');
  });

  it('调用超时 / 未知状态 / 无信封 → failed 机械分流；needs_input 缺参走声明分支', async () => {
    const client = stubClient('normal', 300);

    const slow = await client.execute({ requestId: 'req_slow', operation: 'stub.slow', args: {} });
    expect(slow).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_TIMEOUT', retryable: true } });

    const weird = await client.execute({ requestId: 'req_weird', operation: 'stub.weird', args: {} });
    expect(weird).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_UNKNOWN_STATUS' } });

    const noEnvelope = await client.execute({ requestId: 'req_noenv', operation: 'stub.noenvelope', args: {} });
    expect(noEnvelope).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_NO_RESULT' } });

    const needs = await client.execute({ requestId: 'req_needs', operation: 'stub.needs', args: {} });
    expect(needs.status).toBe('needs_input');
    if (needs.status === 'needs_input') {
      expect(needs.missing).toEqual([
        { name: '--collection', description: '执行层声明该输入必填：--collection' },
      ]);
    }
  });
});
