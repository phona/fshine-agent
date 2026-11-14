/**
 * Dummy 夹具增项测试（业务 E2E 阶段 1，TDD 先红）：
 * ① 多集合种子：若干 collection、含历史 window、一个 locked collection（策略拒绝）；
 * ② 限流：每 state-dir 计数窗口，超限返回 failed 且 retryable:true 的结构化错误
 *    （ExecutionFailure{code,message,retryable}，经现有 CLI 退出码/RESULT 信封表达）；
 *    旋钮主入口 = <state-dir>/rate-limit-config.json（经 --state-dir 可达，宿主可复现），
 *    env DUMMY_RATE_LIMIT_MAX 保留为兼容入口（不再是唯一入口）；
 * ③ 部分成功可组合：同一 state-dir 内多次 execute，若干命中限流、若干成功。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const DUMMY = path.resolve(__dirname, '../fixtures/dummy-platform/bin/dummy');

let tmpRoots: string[] = [];
function freshStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'biz-e2e-dummy-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

/** 把限流旋钮落到 state 根（主入口）：{ max, windowSeconds? }。 */
function writeRateLimitConfig(stateDir: string, cfg: Record<string, number>): void {
  writeFileSync(path.join(stateDir, 'rate-limit-config.json'), JSON.stringify(cfg) + '\n');
}

/** 运行一次 dummy；返回 { status, envelope, stderr }（envelope 解自最后一行 RESULT）。 */
function runDummy(args: string[], env: NodeJS.ProcessEnv = {}, stateDir: string) {
  const r = spawnSync(DUMMY, ['--state-dir', stateDir, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  let envelope: Record<string, any> | null = null;
  const lines = (r.stdout ?? '').trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? '';
  if (last.startsWith('RESULT ')) envelope = JSON.parse(last.slice('RESULT '.length));
  return { status: r.status, envelope, stderr: r.stderr ?? '' };
}

describe('① 多集合种子', () => {
  it('种子含若干 collection，其中 documents 有历史 window（W202610 / W202611）', () => {
    const dir = freshStateDir();
    for (const [collection, window] of [['alpha', 'W1'], ['beta', 'W1'], ['documents', 'W202610'], ['documents', 'W202611']] as const) {
      const { status, envelope } = runDummy(['query', 'dummy.query', '--collection', collection, '--window', window], {}, dir);
      expect(status, `${collection}@${window}`).toBe(0);
      expect(envelope?.status).toBe('completed');
      expect(envelope?.data?.collection).toBe(collection);
    }
  });

  it('locked collection 的写路径 = 策略拒绝：prepare / commit 都被 COLLECTION_LOCKED 拒（exit 2，failed 信封）', () => {
    const dir = freshStateDir();
    const prepare = runDummy(['prepare', 'dummy.prepare', '--collection', 'locked-one'], {}, dir);
    expect(prepare.status).toBe(2);
    expect(prepare.envelope?.status).toBe('failed');
    expect(prepare.envelope?.error?.code).toBe('COLLECTION_LOCKED');
    const commit = runDummy(['commit', 'dummy.commit', '--collection', 'locked-one'], {}, dir);
    expect(commit.status).toBe(2);
    expect(commit.envelope?.status).toBe('failed');
    expect(commit.envelope?.error?.code).toBe('COLLECTION_LOCKED');
  });
});

describe('② 限流（每 state-dir 计数窗口）', () => {
  it('DUMMY_RATE_LIMIT_MAX 内的调用正常完成，超限调用返回 failed + retryable:true（exit 1，结构化错误）', () => {
    const dir = freshStateDir();
    const env = { DUMMY_RATE_LIMIT_MAX: '2', DUMMY_RATE_LIMIT_WINDOW_SECONDS: '3600' };
    const first = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], env, dir);
    expect(first.status).toBe(0);
    expect(first.envelope?.status).toBe('completed');
    const second = runDummy(['query', 'dummy.query', '--collection', 'beta', '--window', 'W1'], env, dir);
    expect(second.status).toBe(0);
    expect(second.envelope?.status).toBe('completed');
    const third = runDummy(['query', 'dummy.query', '--collection', 'documents', '--window', 'W202611'], env, dir);
    expect(third.status).toBe(1);
    expect(third.envelope?.status).toBe('failed');
    expect(third.envelope?.error?.code).toBe('RATE_LIMITED');
    expect(third.envelope?.error?.retryable).toBe(true);
    expect(typeof third.envelope?.error?.message).toBe('string');
  });

  it('不设 DUMMY_RATE_LIMIT_MAX 时不限流（缺省行为不变）', () => {
    const dir = freshStateDir();
    for (let i = 0; i < 5; i += 1) {
      const r = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], {}, dir);
      expect(r.status).toBe(0);
    }
  });

  it('限流是按 state-dir 计数的：另一个 state-dir 不受影响', () => {
    const dirA = freshStateDir();
    const dirB = freshStateDir();
    const env = { DUMMY_RATE_LIMIT_MAX: '1' };
    expect(runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], env, dirA).status).toBe(0);
    expect(runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], env, dirA).status).toBe(1);
    expect(runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], env, dirB).status).toBe(0);
  });
});

describe('②b 限流经 state-dir 可驱动（主入口 = <state-dir>/rate-limit-config.json）', () => {
  it('只写 state-dir 配置、不设 env：第 3 次执行返回 RATE_LIMITED（宿主可复现，不依赖被白名单丢弃的 env）', () => {
    const dir = freshStateDir();
    writeRateLimitConfig(dir, { max: 2, windowSeconds: 3600 });
    const first = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], {}, dir);
    expect(first.status).toBe(0);
    const second = runDummy(['query', 'dummy.query', '--collection', 'beta', '--window', 'W1'], {}, dir);
    expect(second.status).toBe(0);
    const third = runDummy(['query', 'dummy.query', '--collection', 'documents', '--window', 'W202611'], {}, dir);
    expect(third.status).toBe(1);
    expect(third.envelope?.status).toBe('failed');
    expect(third.envelope?.error?.code).toBe('RATE_LIMITED');
    expect(third.envelope?.error?.retryable).toBe(true);
  });

  it('state-dir 配置与 env 并存时 state-dir 优先（可覆盖宽松 env）', () => {
    const dir = freshStateDir();
    writeRateLimitConfig(dir, { max: 1 });
    const env = { DUMMY_RATE_LIMIT_MAX: '10' };
    expect(runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], env, dir).status).toBe(0);
    const second = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], env, dir);
    expect(second.status).toBe(1);
    expect(second.envelope?.error?.code).toBe('RATE_LIMITED');
  });

  it('无 state-dir 配置也无 env：不限流（缺省行为不变）', () => {
    const dir = freshStateDir();
    for (let i = 0; i < 5; i += 1) {
      expect(runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], {}, dir).status).toBe(0);
    }
  });
});

describe('③ 部分成功可组合', () => {
  it('同一 state-dir 内多次 execute：若干成功、若干命中限流；审计行两类结果都留痕', () => {
    const dir = freshStateDir();
    const env = { DUMMY_RATE_LIMIT_MAX: '2' };
    const results = [
      runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], env, dir),
      runDummy(['query', 'dummy.query', '--collection', 'beta', '--window', 'W1'], env, dir),
      runDummy(['query', 'dummy.query', '--collection', 'documents', '--window', 'W202611'], env, dir),
    ];
    expect(results.map((r) => r.envelope?.status)).toEqual(['completed', 'completed', 'failed']);
    const auditLines = readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // 每次执行调用都有一行审计：成功的 exitCode=0，命中限流的 exitCode=1。
    expect(auditLines.filter((row) => row.exitCode === 0)).toHaveLength(2);
    expect(auditLines.filter((row) => row.exitCode === 1)).toHaveLength(1);
  });
});
