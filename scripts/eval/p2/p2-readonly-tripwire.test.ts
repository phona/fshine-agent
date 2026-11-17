/**
 * P2 执行面「只读集合」守护（U3 合并适配的反向绊线）。
 *
 * 背景：U3 让 `ExecutionFace` 必填 `readOnlyOperations`——只读集合必须由执行层
 * `access=read` 显式派生，独立于允许集合。P2 胶水若把 `allowedOperations` 直接
 * 塞进 `readOnlyOperations`，写操作就会被当成只读：重试时直接回放（该执行的不执行），
 * 或反过来二次执行（该回放的又执行一次）。本文件钉住三件事：
 *   1) `createDummyP2Client` 从唯一装配入口（`resolveExecutionFace`）带出只读集合，
 *      写操作（dummy.commit / dummy.prepare / dummy.proposal / dummy.proposal-commit /
 *      ballot.commit）一个都不在其中；
 *   2) `startP2Server` 把只读集合独立于允许集合传给 server：允许集合里额外授权写操作时，
 *      handle 上的只读集合不变、且不等于允许集合；
 *   3) 源码级：p2 胶水里**不允许**出现 `readOnlyOperations: <x>.allowedOperations`，
 *      每个带 `allowedOperations` 的样本装配点必须同步带 `readOnlyOperations`。
 *
 * 反向绊线（亲跑验证）：把 `p2-harness.ts` 的
 * `readOnlyOperations: spec.readOnlyOperations` 改成 `spec.allowedOperations`，
 * 用例 2 / 3 立即红；还原后绿。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { P2ScriptBook, createDummyP2Client, startP2Server } from './p2-harness';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 仓内 dummy 执行层里 access 非 read 的操作（只读集合绝不能含它们）。 */
const WRITE_OPERATIONS = [
  'dummy.commit',
  'dummy.prepare',
  'dummy.proposal',
  'dummy.proposal-commit',
  'ballot.commit',
] as const;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p2-readonly-'));
  tempDirs.push(dir);
  return dir;
}

function source(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** 去掉注释，避免注释里的反例文本被当成真实赋值。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('P2 只读集合守护（U3）', () => {
  it('createDummyP2Client：只读集合来自 access=read 派生，写操作不在其中', async () => {
    const { readOnlyOperations, allowedOperations } = await createDummyP2Client({ dir: tempDir() });
    // 读取类 operation 在（证明集合不是空的/被裁掉）。
    expect(readOnlyOperations).toContain('dummy.query');
    // 写操作一个都不在只读集合里。
    for (const operation of WRITE_OPERATIONS) {
      expect(readOnlyOperations).not.toContain(operation);
    }
    // 独立字段，不是 allowedOperations 的别名（引用不同）。
    expect(readOnlyOperations).not.toBe(allowedOperations);
  });

  it('startP2Server：允许集合另有写授权时，只读集合不变且不等于允许集合', async () => {
    const dir = tempDir();
    const { client, readOnlyOperations } = await createDummyP2Client({ dir });
    const allowedOperations = [...readOnlyOperations, 'dummy.commit'];
    // 允许集合含写操作、只读集合不含：这正是 U3 要区分的两面。
    expect(allowedOperations).toContain('dummy.commit');
    const handle = await startP2Server({
      dir,
      principals: [{ userId: 'p2-readonly', conversationId: 'conv-p2-readonly' }],
      mode: 'inline',
      book: new P2ScriptBook(),
      client,
      allowedOperations,
      readOnlyOperations,
    });
    try {
      expect(handle.readOnlyOperations).toEqual([...readOnlyOperations]);
      expect(handle.readOnlyOperations).not.toContain('dummy.commit');
      expect(handle.readOnlyOperations).not.toEqual(allowedOperations);
    } finally {
      await handle.close();
    }
  });

  it('源码级：p2 胶水不得用 allowedOperations 冒充 readOnlyOperations', () => {
    const harness = stripComments(source('scripts/eval/p2/p2-harness.ts'));
    const scenarios = stripComments(source('scripts/eval/p2/p2-scenarios.ts'));
    // 两处胶水都禁止「只读 := 允许」。
    for (const text of [harness, scenarios]) {
      expect(text).not.toMatch(/readOnlyOperations:\s*[\w.]+\.allowedOperations/);
    }
    // 真值从装配入口的 face 出来，并沿 spec / sample input 贯穿到 server：
    // 两处 `face.readOnlyOperations` = dummy 客户端产出面 + server handle 回读面。
    expect(harness.match(/readOnlyOperations:\s*face\.readOnlyOperations/g)?.length).toBe(2);
    expect(harness).toMatch(/readOnlyOperations:\s*spec\.readOnlyOperations/);
    expect(harness).toMatch(/readOnlyOperations:\s*input\.readOnlyOperations/);
    // 每个带 allowedOperations 的样本装配点都必须同步带 readOnlyOperations。
    const callSites = scenarios.split('\n').filter((line) => line.includes('allowedOperations:'));
    expect(callSites.length).toBeGreaterThan(0);
    for (const line of callSites) {
      expect(line).toMatch(/readOnlyOperations:/);
    }
  });
});
