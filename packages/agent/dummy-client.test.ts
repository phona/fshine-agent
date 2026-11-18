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
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (mode === 'capture') {
    fs.writeFileSync(require('node:path').join(__dirname, '..', 'captured-call.json'), JSON.stringify(call));
    process.stdout.write('RESULT {"status":"completed"}\\n');
    process.exit(0);
  }
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
      requestId: 'req_test_1', dispatchKey: 'dk_test_req_test_1',
      operation: 'dummy.query',
      args: { '--collection': 'documents', '--window': 'W202611' },
    });
    expect(outcome.status).toBe('completed');
    const data = (outcome as { data?: { collection?: string; count?: number } }).data;
    expect(data?.collection).toBe('documents');
    expect(data?.count).toBe(3);

    // 裸名（collection）按执行层声明规范化为 --collection，同样完成。
    const bare = await client.execute({
      requestId: 'req_test_2', dispatchKey: 'dk_test_req_test_2',
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
    // 结构化 call 的审计行保留调用方给的 args 形态（对象），不再拍平成 argv 数组。
    expect(last.args).toMatchObject({ '--collection': 'alpha', '--window': 'W1' });
  });

  it('拒绝与澄清：未登记 operation → refused；歧义 → needs_input（缺什么非空）', async () => {
    const client = clientWith({ PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] });
    const refused = await client.execute({ requestId: 'req_test_3', dispatchKey: 'dk_test_req_test_3', operation: 'dummy.nope', args: {} });
    expect(refused.status).toBe('refused');
    if (refused.status === 'refused') {
      expect(refused.error.code).toBe('CALL_REFUSE');
    }

    const ambiguous = await client.execute({ requestId: 'req_test_4', dispatchKey: 'dk_test_req_test_4', operation: 'dummy.query', args: { '--collection': 'contoso' } });
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
      requestId: 'req_test_5', dispatchKey: 'dk_test_req_test_5',
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
    const outcome = await client.execute({ requestId: 'req_nf', dispatchKey: 'dk_test_req_nf', operation: 'dummy.query', args: { '--collection': 'nope' } });
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.data).toMatchObject({ query: 'nope', candidates: [] });
    }
  });

  it('响应：failed 信封映射为 failed；error 原样透传（含 correctForm details）', async () => {
    const client = clientWith(baseEnv());
    // 缺必填参数 → QUERY_REQUIRED（failed 信封）。
    const missing = await client.execute({ requestId: 'req_fail_1', dispatchKey: 'dk_test_req_fail_1', operation: 'dummy.query', args: {} });
    expect(missing.status).toBe('failed');
    if (missing.status === 'failed') {
      expect(missing.error.code).toBe('QUERY_REQUIRED');
      expect(missing.error.message).toContain('--collection');
      expect(missing.error.details).toMatchObject({ correctForm: 'Provide --collection <name>.' });
    }

    // 锁定集合的写入准备 → COLLECTION_LOCKED（failed 信封 + 非零退出码，信封优先于退出码）。
    const locked = await client.execute({ requestId: 'req_fail_2', dispatchKey: 'dk_test_req_fail_2', operation: 'dummy.prepare', args: { '--collection': 'locked-one' } });
    expect(locked.status).toBe('failed');
    if (locked.status === 'failed') {
      expect(locked.error.code).toBe('COLLECTION_LOCKED');
      // 执行层把确定性错误标了 retryable:false —— 适配器必须原样透传（A2b「本回合不再撞」
      // 的唯一判据；丢掉这个字段守卫就形同不存在，E14 的 11 次重试风暴就是这么来的）。
      expect(locked.error.retryable).toBe(false);
    }
    // 参数形状错误（缺必填/JSON 不合法）由执行层显式声明可重试——同回合允许按正确形态再试；
    // 业务性失败（找不到集合等）仍不可重试。适配器只透传，不替执行层判断。
    if (missing.status === 'failed') {
      expect(missing.error.retryable).toBe(true);
    }
  });
});

describe('dummy：结构化参数直接传数组（模型不手拼 JSON）', () => {
  it('--records 传对象数组 → 执行层收到合法记录并出提案（审计里仍是数组，不是 [object Object]）', async () => {
    const client = clientWith(baseEnv());
    const records = [
      { name: 'alpha-item-3', value: 'hello' },
      { name: 'alpha-item-4', value: 'world' },
      { name: 'alpha-item-5', value: 500 },
    ];
    const outcome = await client.execute({
      requestId: 'req_array_records',
      dispatchKey: 'dk_test_req_array_records',
      operation: 'dummy.prepare',
      args: { '--collection': 'alpha', '--window': 'W1', '--records': records },
    });
    expect(outcome.status).toBe('needs_confirmation');
    if (outcome.status === 'needs_confirmation') {
      expect(outcome.confirmation.summary).toContain('alpha-item-3=hello');
      expect(outcome.confirmation.summary).toContain('alpha-item-4=world');
      expect(outcome.confirmation.summary).toContain('alpha-item-5=500');
      expect(outcome.confirmation.summary).toContain('共 3 条');
    }
    // 执行层拿到的就是结构化数组：审计行（执行层自己的账）里 records 原样保留。
    const rows = readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const last = rows[rows.length - 1]! as { args?: Record<string, unknown> };
    expect(last.args?.['--records']).toEqual(records);
    expect(JSON.stringify(last.args)).not.toContain('[object Object]');
  });

  it('坏的第 3 条 → 失败并指到「第 3 条」，零提案零写入', async () => {
    const client = clientWith(baseEnv());
    const outcome = await client.execute({
      requestId: 'req_bad_item_index',
      dispatchKey: 'dk_test_req_bad_item_index',
      operation: 'dummy.prepare',
      args: {
        '--collection': 'alpha',
        '--window': 'W1',
        '--records': [
          { name: 'alpha-item-3', value: 100 },
          { name: 'alpha-item-4', value: 200 },
          { name: 'alpha-item-5' },
        ],
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('INVALID_RECORDS');
      expect(outcome.error.retryable).toBe(true);
      expect(outcome.error.message).toContain('第 3 条');
      expect(outcome.error.message).toContain('value');
    }
    // 零提案：没有发放任何确认句柄。
    expect(existsSync(path.join(stateDir, 'confirmations.json'))).toBe(false);
    // 零写入：alpha 仍是种子里的 2 条。
    const after = await client.execute({
      requestId: 'req_after_bad_item',
      dispatchKey: 'dk_test_req_after_bad_item',
      operation: 'dummy.query',
      args: { '--collection': 'alpha', '--window': 'W1' },
    });
    expect(after.status).toBe('completed');
    expect((after as { data?: { count?: number } }).data?.count).toBe(2);
  });

  it('200 条一次性提案：摘要写「共 200 条」，commit 后读回 delta=200', async () => {
    const client = clientWith(baseEnv());
    const records = Array.from({ length: 200 }, (_, index) => ({ name: `bulk-item-${index + 1}`, value: index + 1 }));
    const prepared = await client.execute({
      requestId: 'req_records_200',
      dispatchKey: 'dk_test_req_records_200',
      operation: 'dummy.prepare',
      args: { '--collection': 'alpha', '--window': 'W1', '--records': records },
    });
    expect(prepared.status).toBe('needs_confirmation');
    if (prepared.status !== 'needs_confirmation') throw new Error('未出提案');
    expect(prepared.confirmation.summary).toContain('共 200 条');
    // 摘要不把所有 200 条都贴出来（只列前 10 条 + 其余条数）。
    expect(prepared.confirmation.summary).toContain('其余 190 条略');

    const committed = await client.execute({
      requestId: 'req_records_200_commit',
      dispatchKey: 'dk_test_req_records_200_commit',
      operation: 'dummy.commit',
      args: { '--collection': 'alpha', '--window': 'W1', '--records': records },
      confirmation: { handle: prepared.confirmation.handle },
    });
    expect(committed.status).toBe('completed');
    expect((committed as { data?: { readBack?: { delta?: number }; added?: number } }).data?.readBack?.delta).toBe(200);
    expect((committed as { data?: { added?: number } }).data?.added).toBe(200);

    const after = await client.execute({
      requestId: 'req_records_200_query',
      dispatchKey: 'dk_test_req_records_200_query',
      operation: 'dummy.query',
      args: { '--collection': 'alpha', '--window': 'W1' },
    });
    expect((after as { data?: { count?: number } }).data?.count).toBe(202);
  });

  it('第 137 条不合法 → 一条都不写（before/after 相同），错误指到「第 137 条」', async () => {
    const client = clientWith(baseEnv());
    const records = Array.from({ length: 200 }, (_, index) => ({ name: `bulk-item-${index + 1}`, value: index + 1 }));
    // 第 137 条（1-based）缺 value。
    delete (records[136] as { value?: number }).value;
    const outcome = await client.execute({
      requestId: 'req_records_bad_137',
      dispatchKey: 'dk_test_req_records_bad_137',
      operation: 'dummy.prepare',
      args: { '--collection': 'alpha', '--window': 'W1', '--records': records },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('INVALID_RECORDS');
      expect(outcome.error.message).toContain('第 137 条');
      expect(outcome.error.message).toContain('value');
    }
    // 零提案（没有句柄）且零写入（仍是种子里的 2 条）——原子性由执行层保证。
    expect(existsSync(path.join(stateDir, 'confirmations.json'))).toBe(false);
    const after = await client.execute({
      requestId: 'req_records_bad_137_query',
      dispatchKey: 'dk_test_req_records_bad_137_query',
      operation: 'dummy.query',
      args: { '--collection': 'alpha', '--window': 'W1' },
    });
    expect((after as { data?: { count?: number } }).data?.count).toBe(2);
  });

  it('超过执行层单次写入上限（500）→ 明确报上限，不教分批', async () => {
    const client = clientWith(baseEnv());
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ name: `limit-item-${index + 1}`, value: index + 1 }));
    const refused = await client.execute({
      requestId: 'req_records_501',
      dispatchKey: 'dk_test_req_records_501',
      operation: 'dummy.prepare',
      args: { '--collection': 'alpha', '--window': 'W1', '--records': tooMany },
    });
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') {
      expect(refused.error.code).toBe('INVALID_RECORDS');
      expect(refused.error.message).toContain('超过执行层单次写入上限 500 条');
      expect(refused.error.message).not.toContain('分批');
    }
    expect(existsSync(path.join(stateDir, 'confirmations.json'))).toBe(false);
  });
});

describe('dummy：参数形状错误声明可重试（同回合允许按正确形态再试）', () => {
  it('INVALID_RECORDS → retryable:true，且 message 自带正确形态（模型一读就能改对）', async () => {
    const client = clientWith(baseEnv());
    const bad = await client.execute({
      requestId: 'req_bad_records',
      dispatchKey: 'dk_test_req_bad_records',
      operation: 'dummy.prepare',
      args: { '--collection': 'alpha', '--window': 'W1', '--records': 'alpha-item-3=hello' },
    });
    expect(bad.status).toBe('failed');
    if (bad.status === 'failed') {
      expect(bad.error.code).toBe('INVALID_RECORDS');
      expect(bad.error.retryable).toBe(true);
      expect(bad.error.message).toContain('--records');
      expect(bad.error.message).toContain('name');
      expect(bad.error.message).toContain('结构化数组');
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

  it('真实子进程收到的 call.json 请求体携带 dispatchKey（不是只看内存对象）', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'dummy-capture-'));
    stubRoots.push(root);
    writeStubGateway(root, 'capture');
    const client = createDummyCliClient({ root, gateway: 'bin/stub', stateDir, env: baseEnv() });

    const outcome = await client.execute({
      requestId: 'req_capture',
      dispatchKey: 'dk_task:t_capture:7',
      operation: 'stub.needs',
      args: { '--collection': 'alpha' },
    });
    expect(outcome.status).toBe('completed');

    const captured = JSON.parse(readFileSync(path.join(root, 'captured-call.json'), 'utf8')) as {
      operation?: unknown;
      dispatchKey?: unknown;
      args?: unknown;
    };
    expect(captured.operation).toBe('stub.needs');
    expect(captured.dispatchKey).toBe('dk_task:t_capture:7');
    expect(captured.args).toMatchObject({ '--collection': 'alpha' });
  });

  it('宿主取消信号：杀网关子进程并抛 AbortError（不再等慢调用自然结束）', async () => {
    const client = stubClient('normal');
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 100);
    await expect(
      client.execute(
        { requestId: 'req_cancel', dispatchKey: 'dk_test_req_cancel', operation: 'stub.slow', args: {} },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // 慢调用自然结束要 5s；取消路径必须在网关子进程被杀后立即返回。
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('调用超时 / 未知状态 / 无信封 → failed 机械分流；needs_input 缺参走声明分支', async () => {
    const client = stubClient('normal', 300);

    const slow = await client.execute({ requestId: 'req_slow', dispatchKey: 'dk_test_req_slow', operation: 'stub.slow', args: {} });
    expect(slow).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_TIMEOUT', retryable: true } });

    const weird = await client.execute({ requestId: 'req_weird', dispatchKey: 'dk_test_req_weird', operation: 'stub.weird', args: {} });
    expect(weird).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_UNKNOWN_STATUS' } });

    const noEnvelope = await client.execute({ requestId: 'req_noenv', dispatchKey: 'dk_test_req_noenv', operation: 'stub.noenvelope', args: {} });
    expect(noEnvelope).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_NO_RESULT' } });

    const needs = await client.execute({ requestId: 'req_needs', dispatchKey: 'dk_test_req_needs', operation: 'stub.needs', args: {} });
    expect(needs.status).toBe('needs_input');
    if (needs.status === 'needs_input') {
      expect(needs.missing).toEqual([
        { name: '--collection', description: '执行层声明该输入必填：--collection' },
      ]);
    }
  });
});
