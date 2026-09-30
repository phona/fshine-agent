/**
 * 服务端落账执行器（apps/server/commit.ts）单测。
 *
 * createCommitRunner/createPrepareRunner 的网关调用不经任何模型，直 spawn 平台网关
 * （runGate 内部 execFile node <platformRoot>/bin/17dz）。这里用一个"假网关"顶替：
 * 临时 platformRoot 下放一个按 FAKE_GATEWAY_QUEUE 指向的响应队列逐次应答的 bin/17dz
 * 脚本——prepare/commit/verify 三种调用的应答完全由测试编排， thereby 钉住：
 *   · 读回校验判据（after-before ≥ 提案张数，恰好等于即放行）；
 *   · commit 非零退出即 failed 且不再读回；
 *   · prepare 必须 dry-run（信封声明已保存也算失败）；
 *   · 解析只认 RESULT 信封（platform-contract 的 parseVerifyCount/parsePrepareOutcome）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePrepareOutcome, parseVerifyCount } from '@fshine/agent';
import { createCommitRunner, createPrepareRunner, newGateSecret } from './commit';

/** 假网关：node 脚本，逐次弹出 FAKE_GATEWAY_QUEUE 队列里的响应（{code, stdout, stderr}）。 */
const FAKE_GATEWAY = `
'use strict';
const fs = require('node:fs');
const queuePath = process.env.FAKE_GATEWAY_QUEUE;
if (!queuePath) { console.error('FAKE_GATEWAY_QUEUE missing'); process.exit(3); }
const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const next = queue.shift();
fs.writeFileSync(queuePath, JSON.stringify(queue));
if (!next) { console.error('fake gateway queue exhausted'); process.exit(3); }
if (next.stdout) process.stdout.write(next.stdout.endsWith('\\n') ? next.stdout : next.stdout + '\\n');
if (next.stderr) process.stderr.write(next.stderr.endsWith('\\n') ? next.stderr : next.stderr + '\\n');
process.exit(typeof next.code === 'number' ? next.code : 0);
`;

interface FakeResponse { code?: number; stdout?: string; stderr?: string }

let root: string | undefined;
let queueFile: string | undefined;

/** 建假平台根（bin/17dz = 假网关）并写入响应队列；返回 platformRoot。 */
function makePlatformRoot(responses: FakeResponse[]): string {
  root = mkdtempSync(path.join(tmpdir(), 'fshine-commit-test-'));
  mkdirSync(path.join(root, 'bin'));
  // 假网关是 CJS（require）：Node ≥22 对无扩展名文件按最近的 package.json 定模块类型，
  // 临时根缺省会被当 ESM——显式钉成 commonjs（与真平台根一致）。
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(path.join(root, 'bin', '17dz'), FAKE_GATEWAY);
  queueFile = path.join(root, 'queue.json');
  writeFileSync(queueFile, JSON.stringify(responses));
  process.env['FAKE_GATEWAY_QUEUE'] = queueFile;
  return root;
}

function remainingResponses(): FakeResponse[] {
  return JSON.parse(readFileSync(queueFile!, 'utf8')) as FakeResponse[];
}

/** RESULT 单行 JSON 信封（schema v1），与平台 emit 出口同一形状。 */
function resultEnvelope(op: string, data: Record<string, unknown> | null, status = 'completed'): string {
  return `RESULT ${JSON.stringify({ v: 1, op, status, data, error: null })}`;
}

const CONTRACTS = [{ accountSet: '幻辰财税' }, { accountSet: '幻辰财税' }, { accountSet: '幻辰财税' }];
const REQUEST = { intentId: 'intent_b5', accountSet: '幻辰财税', period: '202609', contracts: CONTRACTS };

afterEach(() => {
  delete process.env['FAKE_GATEWAY_QUEUE'];
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  queueFile = undefined;
});

describe('createCommitRunner（读回校验）', () => {
  it('after-before 小于提案张数：判 failed，失败输出带 VERIFY 基线且契约按 intentId 留痕', async () => {
    const platformRoot = makePlatformRoot([
      { code: 0, stdout: resultEnvelope('voucher.verify-saved', { count: 3 }) }, // commit 前基线
      { code: 0, stdout: resultEnvelope('voucher.fill', { mode: 'saved', count: 3, saved: [] }) }, // --save
      { code: 0, stdout: resultEnvelope('voucher.verify-saved', { count: 5 }) }, // after：差 2 < 提案 3 张
    ]);
    const runner = createCommitRunner({ platformRoot, gateSecret: newGateSecret() });

    const result = await runner({ ...REQUEST, intentId: 'intent_b5_short' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('读回校验未通过：期内凭证数变化与提案不符');
    expect(result.output).toContain('VERIFY before=3 after=5 expected>=3');
    // 失败的落账也留有可经 intentId 关联的物化契约（审计路径 data/intents/<intentId>/）
    expect(existsSync(path.join(platformRoot, 'data', 'intents', 'intent_b5_short', 'contract.json'))).toBe(true);
  });

  it('after-before 恰好等于提案张数：判 ok', async () => {
    makePlatformRoot([
      { code: 0, stdout: resultEnvelope('voucher.verify-saved', { count: 0 }) },
      { code: 0, stdout: resultEnvelope('voucher.fill', { mode: 'saved', count: 2, saved: [] }) },
      { code: 0, stdout: resultEnvelope('voucher.verify-saved', { count: 2 }) },
    ]);
    const twoContracts = CONTRACTS.slice(0, 2);
    const runner = createCommitRunner({ platformRoot: root!, gateSecret: newGateSecret() });

    const result = await runner({ ...REQUEST, contracts: twoContracts });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('VERIFY before=0 after=2 expected>=2');
  });

  it('commit 非零退出：判 failed（exit 码进话术），且不再发起读回', async () => {
    makePlatformRoot([
      { code: 0, stdout: resultEnvelope('voucher.verify-saved', { count: 0 }) },
      { code: 2, stderr: 'SAVE_REJECTED 此会计期已结账' },
      { code: 0, stdout: resultEnvelope('voucher.verify-saved', { count: 99 }) }, // 不该被消费
    ]);
    const runner = createCommitRunner({ platformRoot: root!, gateSecret: newGateSecret() });

    const result = await runner(REQUEST);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('落账命令失败（exit 2）');
    // after 读回没有发生：队列剩最后一条响应原样未动
    expect(remainingResponses()).toHaveLength(1);
  });

  it('读回信封缺失/坏掉（count 为 null）：判 failed 而不是当作零增量放行', async () => {
    makePlatformRoot([
      { code: 0, stdout: resultEnvelope('voucher.verify-saved', { count: 0 }) },
      { code: 0, stdout: resultEnvelope('voucher.fill', { mode: 'saved', count: 2, saved: [] }) },
      { code: 0, stdout: 'garbage output, no envelope' }, // after：解析不出 count
    ]);
    const runner = createCommitRunner({ platformRoot: root!, gateSecret: newGateSecret() });

    const result = await runner({ ...REQUEST, contracts: CONTRACTS.slice(0, 2) });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('after=未知');
  });
});

describe('createPrepareRunner（dry-run 预检）', () => {
  it('prepare 返回 completed + dry-run：判 ok', async () => {
    makePlatformRoot([
      { code: 0, stdout: resultEnvelope('voucher.fill', { mode: 'dry-run', count: 1, saved: [] }) },
    ]);
    const runner = createPrepareRunner({ platformRoot: root!, gateSecret: newGateSecret() });

    const result = await runner({ ...REQUEST, contracts: CONTRACTS.slice(0, 1) });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('prepare 非 dry-run（信封声明已保存）：判失败——预检绝不允许真写', async () => {
    makePlatformRoot([
      { code: 0, stdout: resultEnvelope('voucher.fill', { mode: 'saved', count: 1, saved: ['记-0001'] }) },
    ]);
    const runner = createPrepareRunner({ platformRoot: root!, gateSecret: newGateSecret() });

    const result = await runner({ ...REQUEST, contracts: CONTRACTS.slice(0, 1) });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('信封解析（只认 RESULT 信封）', () => {
  it('parseVerifyCount：非信封输出、坏 JSON、错 operation、count 非数字一律 null', () => {
    expect(parseVerifyCount('voucher.verify-saved completed count=3')).toBeNull();
    expect(parseVerifyCount('RESULT {broken json')).toBeNull();
    expect(parseVerifyCount(resultEnvelope('voucher.fill', { count: 3 }))).toBeNull();
    expect(parseVerifyCount(resultEnvelope('voucher.verify-saved', { count: '3' }))).toBeNull();
    expect(parseVerifyCount(resultEnvelope('voucher.verify-saved', { count: 3 }))).toBe(3);
  });

  it('parsePrepareOutcome：非信封输出与坏 JSON 判失败；mode 非 dry-run 时 dryRun=false', () => {
    expect(parsePrepareOutcome('fill dry-run count=1')).toEqual({ ok: false, dryRun: false });
    expect(parsePrepareOutcome('RESULT {broken json')).toEqual({ ok: false, dryRun: false });
    expect(parsePrepareOutcome(resultEnvelope('voucher.fill', { mode: 'saved' }))).toEqual({ ok: true, dryRun: false });
    expect(parsePrepareOutcome(resultEnvelope('voucher.fill', { mode: 'dry-run' }))).toEqual({ ok: true, dryRun: true });
    expect(parsePrepareOutcome(resultEnvelope('voucher.fill', null, 'failed'))).toEqual({ ok: false, dryRun: false });
  });
});
