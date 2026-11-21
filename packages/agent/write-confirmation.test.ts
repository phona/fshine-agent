/**
 * 写确认回环：契约增量 + 仓内 dummy 执行层（真夹具）行为。
 *
 * 业务形态：执行层预演（prepare）→ 用户确认 → 执行层提交（commit）→ 读回验证。
 * 本文件只覆盖**契约与执行层**，不接宿主装配：
 *   · 契约：ExecutionOutcome 的 needs_confirmation + ExecutionRequest.confirmation；
 *   · 适配器：confirmation 原样透传、needs_confirmation 信封映射（含畸形信封 fail-closed）；
 *   · dummy 夹具：prepare 持久化提案并返回句柄/摘要；commit 校验句柄（不存在/过期/已用/
 *     绑定不一致/并发）后原子标记已用并执行；query 能读回新增记录；读回不一致如实失败。
 *
 * 边界：操作授权、句柄绑定、有效期、防重放与业务校验都在执行层（夹具）内完成；
 * 宿主只透传句柄与用户原话，不判断「用户是不是在确认」。
 *
 * 「另一个 (principal,session)」在本切片以**独立执行状态根**建模：句柄只在其创建的状态根
 * 内存在，换根即「不存在」；宿主侧的会话级句柄表由下一片（装配接线）覆盖。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createDummyCliClient } from './src/dummy-cli-client';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] };
}

function clientFor(stateDir: string) {
  return createDummyCliClient({ root: FIXTURE_ROOT, gateway: 'bin/dummy', stateDir, env: baseEnv() });
}

let sequence = 0;
function request(
  operation: string,
  args: Record<string, unknown>,
  confirmation?: { handle: string; userText?: string },
): ExecutionRequest {
  sequence += 1;
  return {
    requestId: `req_wc_${sequence}`,
    dispatchKey: `dk_test_wc_${sequence}`,
    operation,
    args,
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}

interface QueryData {
  collection: string;
  window: string | null;
  items: Array<{ id: string; name: string; value: number }>;
  count: number;
}

async function query(
  client: ReturnType<typeof clientFor>,
  collection = 'alpha',
  window = 'W1',
): Promise<QueryData> {
  const outcome = await client.execute(request('dummy.query', { '--collection': collection, '--window': window }));
  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') throw new Error(`query 未完成：${outcome.status}`);
  return outcome.data as QueryData;
}

function confirmationOf(outcome: ExecutionOutcome): { handle: string; summary: string; expiresAt?: string } {
  expect(outcome.status).toBe('needs_confirmation');
  if (outcome.status !== 'needs_confirmation') throw new Error(`prepare 未返回 needs_confirmation：${outcome.status}`);
  return outcome.confirmation;
}

const PREPARE_ARGS = { '--collection': 'alpha', '--window': 'W1', '--count': 2 } as const;
const COMMIT_ARGS = { '--collection': 'alpha', '--window': 'W1', '--count': 2 } as const;

describe('写确认回环（真 dummy 夹具，业务级）', () => {
  it('正常：prepare 只出提案不写；用户确认后 commit 成功，query 读回新增记录', async () => {
    const client = clientFor(tempDir('wc-normal-'));
    expect((await query(client)).count).toBe(2);

    const prepared = await client.execute(request('dummy.prepare', PREPARE_ARGS));
    const confirmation = confirmationOf(prepared);
    // 句柄对宿主不透明；摘要必须是人可读的机械事实：对象 / 窗口 / 影响条数 / 不可撤销。
    expect(confirmation.handle).toMatch(/^cf_/);
    expect(confirmation.summary).toContain('alpha');
    expect(confirmation.summary).toContain('W1');
    expect(confirmation.summary).toContain('2');
    // 摘要由执行层拥有、宿主原样转述；本仓 dummy 交付的是中文人话（不得是英文模板/原始 ISO）
    expect(confirmation.summary).toContain('不可撤销');
    expect(confirmation.summary).not.toMatch(/cannot be undone/i);
    expect(confirmation.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(confirmation.expiresAt).toBeDefined();
    const ttlMs = new Date(confirmation.expiresAt as string).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(14 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000 + 5_000);

    // 预演不是写：用户确认之前数据原样。
    expect((await query(client)).count).toBe(2);

    const committed = await client.execute(request(
      'dummy.commit',
      COMMIT_ARGS,
      { handle: confirmation.handle, userText: '确认，写入这两条' },
    ));
    expect(committed.status).toBe('completed');
    if (committed.status !== 'completed') throw new Error(`commit 未完成：${committed.status}`);
    expect(committed.data).toMatchObject({
      ok: true,
      verified: true,
      collection: 'alpha',
      window: 'W1',
      count: 2,
      added: 2,
      readBack: { before: 2, after: 4, delta: 2, required: 2 },
    });

    const after = await query(client);
    expect(after.count).toBe(4);
    expect(after.items).toHaveLength(4);
    expect(after.items.slice(2).map((item) => item.id)).toHaveLength(2);
  });

  it('不确认：零写入；旁路调用不烧句柄，未知句柄确定性拒绝', async () => {
    const client = clientFor(tempDir('wc-noconfirm-'));
    const prepared = await client.execute(request('dummy.prepare', PREPARE_ARGS));
    const { handle } = confirmationOf(prepared);

    // 用户改说了别的：宿主不会发起 commit，数据保持原样。
    expect((await query(client)).count).toBe(2);

    // 拿一个不存在的句柄提交：确定性拒绝，零写入。
    const unknown = await client.execute(request(
      'dummy.commit',
      COMMIT_ARGS,
      { handle: 'cf_not-a-real-handle' },
    ));
    expect(unknown).toMatchObject({ status: 'refused', error: { code: 'CONFIRMATION_NOT_FOUND' } });
    expect((await query(client)).count).toBe(2);

    // 旁路调用没有消费原提案：之后真正确认仍然有效。
    const committed = await client.execute(request('dummy.commit', COMMIT_ARGS, { handle }));
    expect(committed.status).toBe('completed');
    expect((await query(client)).count).toBe(4);
  });

  it('重复确认：同一句柄只执行一次（第二次确定性拒绝，账本只有一次写入）', async () => {
    const client = clientFor(tempDir('wc-duplicate-'));
    const prepared = await client.execute(request('dummy.prepare', PREPARE_ARGS));
    const { handle } = confirmationOf(prepared);

    const first = await client.execute(request('dummy.commit', COMMIT_ARGS, { handle }));
    expect(first.status).toBe('completed');

    const second = await client.execute(request('dummy.commit', COMMIT_ARGS, { handle }));
    expect(second).toMatchObject({ status: 'refused', error: { code: 'CONFIRMATION_USED' } });

    expect((await query(client)).count).toBe(4);
  });

  it('并发确认：同一句柄并发提交只成功一次（原子标记已用）', async () => {
    const client = clientFor(tempDir('wc-concurrent-'));
    const prepared = await client.execute(request('dummy.prepare', PREPARE_ARGS));
    const { handle } = confirmationOf(prepared);

    const outcomes = await Promise.all([
      client.execute(request('dummy.commit', COMMIT_ARGS, { handle })),
      client.execute(request('dummy.commit', COMMIT_ARGS, { handle })),
    ]);
    const completed = outcomes.filter((outcome) => outcome.status === 'completed');
    const refused = outcomes.filter((outcome) => outcome.status === 'refused');
    expect(completed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status: 'refused', error: { code: expect.stringMatching(/^CONFIRMATION_(USED|IN_PROGRESS)$/) } });

    expect((await query(client)).count).toBe(4);
  });

  it('越权：另一个会话（独立执行状态根）拿同一句柄 → 拒绝，话术与「不存在」完全一致', async () => {
    const sessionA = clientFor(tempDir('wc-session-a-'));
    const sessionB = clientFor(tempDir('wc-session-b-'));

    const prepared = await sessionA.execute(request('dummy.prepare', PREPARE_ARGS));
    const { handle } = confirmationOf(prepared);

    const stolen = await sessionB.execute(request('dummy.commit', COMMIT_ARGS, { handle }));
    const unknown = await sessionB.execute(request(
      'dummy.commit',
      COMMIT_ARGS,
      { handle: 'cf_does-not-exist' },
    ));
    expect(stolen.status).toBe('refused');
    expect(unknown.status).toBe('refused');
    if (stolen.status !== 'refused' || unknown.status !== 'refused') throw new Error('越权/不存在未拒绝');
    // 话术完全一致：不泄漏该句柄在别处存在。
    expect(stolen.error).toEqual(unknown.error);
    expect(stolen.error.code).toBe('CONFIRMATION_NOT_FOUND');

    // 两个会话的数据都没有被写。
    expect((await query(sessionA)).count).toBe(2);
    expect((await query(sessionB)).count).toBe(2);
  });

  it('过期：构造过期提案 → 拒绝并明确告知过期，零写入', async () => {
    const stateDir = tempDir('wc-expired-');
    // 夹具测试面：ttlSeconds <= 0 生成一个「已过期」提案（默认 900 秒 = 15 分钟）。
    writeFileSync(path.join(stateDir, 'confirmation-config.json'), JSON.stringify({ ttlSeconds: -1 }));
    const client = clientFor(stateDir);

    const prepared = await client.execute(request('dummy.prepare', PREPARE_ARGS));
    const confirmation = confirmationOf(prepared);
    expect(new Date(confirmation.expiresAt as string).getTime()).toBeLessThanOrEqual(Date.now());

    const committed = await client.execute(request(
      'dummy.commit',
      COMMIT_ARGS,
      { handle: confirmation.handle },
    ));
    expect(committed).toMatchObject({ status: 'refused', error: { code: 'CONFIRMATION_EXPIRED' } });
    if (committed.status === 'refused') expect(committed.error.message).toContain('expired');
    expect((await query(client)).count).toBe(2);
  });

  it('缺句柄：commit 没有 confirmation → 确定性拒绝，零写入（执行层自己的门）', async () => {
    const client = clientFor(tempDir('wc-missing-handle-'));
    const committed = await client.execute(request('dummy.commit', COMMIT_ARGS));
    expect(committed).toMatchObject({ status: 'refused', error: { code: 'CONFIRMATION_REQUIRED' } });
    expect((await query(client)).count).toBe(2);
  });

  it('绑定不一致：commit 的 collection/window/count 与提案不符 → 拒绝，零写入且句柄不被烧掉', async () => {
    const client = clientFor(tempDir('wc-binding-'));
    const prepared = await client.execute(request('dummy.prepare', PREPARE_ARGS));
    const { handle } = confirmationOf(prepared);

    const mismatch = await client.execute(request(
      'dummy.commit',
      { '--collection': 'alpha', '--window': 'W1', '--count': 3 },
      { handle },
    ));
    expect(mismatch).toMatchObject({ status: 'refused', error: { code: 'CONFIRMATION_BINDING_MISMATCH' } });
    expect((await query(client)).count).toBe(2);

    // 绑定失败不消耗句柄：按提案原参数仍可提交。
    const committed = await client.execute(request('dummy.commit', COMMIT_ARGS, { handle }));
    expect(committed.status).toBe('completed');
    expect((await query(client)).count).toBe(4);
  });

  it('读回不一致：执行层如实返回 failed/verified:false，不谎报成功', async () => {
    const stateDir = tempDir('wc-short-');
    writeFileSync(path.join(stateDir, 'confirmation-config.json'), JSON.stringify({ readbackShort: true }));
    const client = clientFor(stateDir);

    const prepared = await client.execute(request('dummy.prepare', PREPARE_ARGS));
    const { handle } = confirmationOf(prepared);

    const committed = await client.execute(request('dummy.commit', COMMIT_ARGS, { handle }));
    expect(committed.status).toBe('failed');
    if (committed.status !== 'failed') throw new Error(`读回不一致仍返回 ${committed.status}`);
    expect(committed.error.code).toBe('CONFIRMATION_READBACK_SHORT');
    expect(committed.error.message).toMatch(/readback short/i);
    expect((await query(client)).count).toBe(3);
  });
});

describe('契约适配：confirmation 透传与 needs_confirmation 信封映射', () => {
  function writeStubGateway(rootDir: string, mode: 'completed' | 'needs-confirmation' | 'needs-bad'): void {
    const operations = [
      {
        name: 'stub.commit',
        access: 'write',
        args: {
          flags: [
            { flag: '--collection', required: true, style: 'name' },
            { flag: '--confirmation', required: false, style: 'code' },
          ],
        },
      },
    ];
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args[0] === 'operation' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(${JSON.stringify({ operations })}));
  process.exit(0);
}
if (args[0] === 'call') {
  const file = args[args.indexOf('--file') + 1];
  const call = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(path.join(__dirname, '..', 'captured-call.json'), JSON.stringify(call));
  if (mode === 'needs-confirmation') {
    process.stdout.write('RESULT {"status":"needs_confirmation","confirmation":{"handle":"cf_stub","summary":"alpha W1 2 records; cannot be undone","expiresAt":"2026-11-17T12:00:00.000Z"},"data":{"collection":"alpha"}}\\n');
    process.exit(0);
  }
  if (mode === 'needs-bad') {
    process.stdout.write('RESULT {"status":"needs_confirmation","data":null}\\n');
    process.exit(0);
  }
  process.stdout.write('RESULT {"status":"completed"}\\n');
  process.exit(0);
}
process.exit(9);
`;
    mkdirSync(path.join(rootDir, 'bin'), { recursive: true });
    const stub = path.join(rootDir, 'bin', 'stub');
    writeFileSync(stub, script);
    chmodSync(stub, 0o755);
  }

  function stubClient(mode: 'completed' | 'needs-confirmation' | 'needs-bad') {
    const root = tempDir('wc-stub-');
    writeStubGateway(root, mode);
    return {
      root,
      client: createDummyCliClient({
        root,
        gateway: 'bin/stub',
        stateDir: path.join(root, 'state'),
        env: baseEnv(),
      }),
    };
  }

  it('宿主侧的 confirmation（句柄 + 用户原话）原样到达执行层调用体', async () => {
    const { root, client } = stubClient('completed');
    const outcome = await client.execute(request(
      'stub.commit',
      { '--collection': 'alpha' },
      { handle: 'cf_stub', userText: '确认，写吧' },
    ));
    expect(outcome.status).toBe('completed');
    const captured = JSON.parse(readFileSync(path.join(root, 'captured-call.json'), 'utf8')) as {
      operation?: unknown;
      confirmation?: unknown;
    };
    expect(captured.operation).toBe('stub.commit');
    expect(captured.confirmation).toEqual({ handle: 'cf_stub', userText: '确认，写吧' });
  });

  it('needs_confirmation 信封 → 契约 needs_confirmation（句柄/摘要/有效期原样）', async () => {
    const { client } = stubClient('needs-confirmation');
    const outcome = await client.execute(request('stub.commit', { '--collection': 'alpha' }));
    expect(outcome).toMatchObject({
      status: 'needs_confirmation',
      confirmation: {
        handle: 'cf_stub',
        summary: 'alpha W1 2 records; cannot be undone',
        expiresAt: '2026-11-17T12:00:00.000Z',
      },
      data: { collection: 'alpha' },
    });
  });

  it('畸形 needs_confirmation（缺句柄/摘要）→ failed 机械分流，不当成可确认', async () => {
    const { client } = stubClient('needs-bad');
    const outcome = await client.execute(request('stub.commit', { '--collection': 'alpha' }));
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_BAD_CONFIRMATION' } });
  });
});
