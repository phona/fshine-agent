/**
 * 真实只读冒烟脚本的绊线（`scripts/eval/real/smoke.ts`）。
 *
 * 两道锁：
 *   ① 纯函数单测：参数解析（缺省干跑、拒绝 --allow-write）、只读硬闸（写/未声明/未登记一律
 *      抛 SmokeAbort）、只读集合派生、回执摘要（retryable 缺省语义）。
 *   ② 子进程集成：对仓内 dummy 夹具真跑——写 operation 被硬闸中止（exit 2、打印中止原因）、
 *      只读 operation 走通（exit 0）、干跑不发起调用（exit 0）。
 *
 * 反向绊线（亲跑验证）：把 smoke.ts 里 selectProbeOperation / assertReadOnlyCall 的
 * `access !== READ_ACCESS` 判断去掉，下面的硬闸用例与集成用例立刻红。
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawGatewayOperation } from '../../../packages/agent/src/dummy-cli-client';
import {
  SmokeAbort,
  accessIndex,
  assertReadOnlyCall,
  countByAccess,
  longRunningNames,
  parseSmokeArgs,
  readOnlyNames,
  requiredArgCount,
  summarizeOutcome,
} from './smoke';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SMOKE = 'scripts/eval/real/smoke.ts';

function op(name: string, access?: string, extra: Partial<RawGatewayOperation> = {}): RawGatewayOperation {
  return { name, ...(access === undefined ? {} : { access }), ...extra };
}

describe('parseSmokeArgs：缺省干跑 + 只读纪律', () => {
  it('缺省 = 干跑（run=false），无参数、无 op', () => {
    const parsed = parseSmokeArgs([]);
    expect(parsed).toMatchObject({ run: false, args: {} });
  });

  it('--run 打开真跑；--dry-run 显式回落', () => {
    expect(parseSmokeArgs(['--run'])).toMatchObject({ run: true });
    expect(parseSmokeArgs(['--run', '--dry-run'])).toMatchObject({ run: false });
  });

  it('解析 --op= / --arg=k=v / --config= / --out=', () => {
    const parsed = parseSmokeArgs(['--op=dummy.query', '--arg=collection=alpha', '--config=/x.yaml', '--out=/tmp/e.json']);
    expect(parsed).toMatchObject({
      op: 'dummy.query',
      args: { collection: 'alpha' },
      configPath: '/x.yaml',
      out: '/tmp/e.json',
    });
  });

  it('拒绝 --allow-write（本脚本不存在写开关）', () => {
    const parsed = parseSmokeArgs(['--allow-write']);
    expect(parsed).toHaveProperty('usageError');
    expect((parsed as { usageError: string }).usageError).toContain('只读');
  });

  it('拒绝未知参数与畸形 --arg', () => {
    expect(parseSmokeArgs(['--bogus'])).toHaveProperty('usageError');
    expect(parseSmokeArgs(['--arg=novalue'])).toHaveProperty('usageError');
  });

  it('--help 走帮助分支', () => {
    expect(parseSmokeArgs(['--help'])).toMatchObject({ help: true });
  });
});

describe('assertReadOnlyCall：只读硬闸（确定性中止，不依赖模型/人记得）', () => {
  const index = accessIndex([op('a', 'read'), op('b', 'write'), op('c', 'scratch'), op('d')]);

  it('access=read 放行（不抛）', () => {
    expect(() => assertReadOnlyCall('a', index)).not.toThrow();
  });

  it('access=write / scratch / 未声明 / 未登记 一律 SmokeAbort', () => {
    for (const name of ['b', 'c', 'd', 'not-registered']) {
      expect(() => assertReadOnlyCall(name, index), name).toThrow(SmokeAbort);
    }
  });

  it('中止原因点名 access 值（人话可判）', () => {
    try {
      assertReadOnlyCall('b', index);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(SmokeAbort);
      expect((error as Error).message).toContain('access=write');
    }
  });
});

describe('读数工具', () => {
  const ops = [op('r1', 'read'), op('w1', 'write'), op('s1', 'scratch'), op('u1'), op('lr', 'write', { long_running: true })];

  it('countByAccess 把未声明归到 undeclared', () => {
    expect(countByAccess(ops)).toEqual({ read: 1, write: 2, scratch: 1, undeclared: 1 });
  });

  it('readOnlyNames 只收 access=read', () => {
    expect(readOnlyNames(ops)).toEqual(['r1']);
  });

  it('accessIndex 给未声明 access 记空串（硬闸按非 read 处理）', () => {
    expect(accessIndex(ops).get('u1')).toBe('');
    expect(accessIndex(ops).get('r1')).toBe('read');
  });

  it('longRunningNames 只收 long_running=true', () => {
    expect(longRunningNames(ops)).toEqual(['lr']);
  });

  it('requiredArgCount 数必填的位置参数与 flag', () => {
    const withArgs = op('q', 'read', {
      args: { positional: [{ name: 'p', required: true }], flags: [{ flag: '--c', required: true }, { flag: '--w', required: false }] },
    });
    expect(requiredArgCount(withArgs)).toBe(2);
    expect(requiredArgCount(op('plain', 'read'))).toBe(0);
  });
});

describe('summarizeOutcome：retryable 缺省语义', () => {
  it('失败未声明 retryable → 标「未声明（按不可重试锁）」', () => {
    const summary = summarizeOutcome({ status: 'failed', error: { code: 'X', message: 'm' } });
    expect(summary).toMatchObject({ status: 'failed', code: 'X', retryable: '未声明（按不可重试锁）' });
  });

  it('失败显式 retryable=true 原样透传', () => {
    expect(summarizeOutcome({ status: 'refused', error: { code: 'Y', message: 'm', retryable: true } }))
      .toMatchObject({ status: 'refused', retryable: true });
  });

  it('needs_input 暴露 missing；completed 暴露 hasData', () => {
    expect(summarizeOutcome({ status: 'needs_input', missing: [{ name: 'collection', description: 'd' }] }))
      .toMatchObject({ status: 'needs_input', missing: ['collection'] });
    expect(summarizeOutcome({ status: 'completed', data: { a: 1 } })).toMatchObject({ status: 'completed', hasData: true });
  });
});

// ---------------------------------------------------------------------------
// 子进程集成：对仓内 dummy 夹具真跑（不触真实层）
// ---------------------------------------------------------------------------

function runSmoke(args: readonly string[], outPath: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: os.tmpdir() };
  const result = spawnSync(process.execPath, ['--import', 'tsx', SMOKE, ...args, `--out=${outPath}`], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 25_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const evidencePath = (name: string): string => path.join(os.tmpdir(), `real-smoke-test-${name}-${process.pid}.json`);

describe('子进程集成：硬闸与只读走通（仓内 dummy）', () => {
  it('干跑：exit 0 且打印「干跑结束」（不发任何调用）', () => {
    const run = runSmoke([], evidencePath('dry'));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('干跑结束');
  });

  it('写 operation 被硬闸中止：exit 2 且打印中止原因', () => {
    const run = runSmoke(['--run', '--op=dummy.commit'], evidencePath('write'));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('安全硬闸');
    expect(run.stderr).toContain('access=write');
  });

  it('只读 operation 走通：exit 0 且只读集合非空', () => {
    const run = runSmoke(['--run', '--op=dummy.query', '--arg=collection=alpha'], evidencePath('read'));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('只读集合');
  });
});
