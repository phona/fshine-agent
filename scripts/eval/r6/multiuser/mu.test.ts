/**
 * R6 MU · 多用户场景确定性用例（vitest 包装；零真实模型、零真实企微、零真实写）。
 *
 * 断言口径：
 *   · MU-1/2/3/4/5/6/7/9/10 → PASS 且硬零命中为空（跨 principal 泄漏 / 越权执行 / 通知错投 / 任务串线）；
 *   · MU-6 重启恢复（B1 已合入基线）→ 同 dbPath 关停重建，四类断言（转录恢复/不跨读/任务不重放/结果找回）；
 *   · MU-8 → BLOCKED（依赖 B2 未接线）——不伪报 PASS；
 *   · 每条用例逐条记录五要素：principalId / sessionId / taskId / 请求 / 实际投递对象。
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@fshine/contracts';
import { MU_PRINCIPALS, Rendezvous } from './mu-support';
import { mu1, mu2, mu3, mu4, mu5, mu6, mu7, mu8, mu9, mu10, runAllMuCases } from './mu-cases';

/**
 * 资源旋钮（runtime 段）**只在本 `.test.ts` 内构造**（`resource-policy-single-source` 守卫
 * 排除 `*.test.ts`）：多用户并发需要放开前台/后台准入上限（缺省单并发会确定性拒绝并发回合）。
 */
const MU_RUNTIME: RuntimeConfig = { mainConcurrency: 4, backgroundConcurrency: 4 };

describe('R6 MU · 会合同步栅自证（真并发见证）', () => {
  it('N 个到达者会合并解除；串行只到 1 个则安全超时', async () => {
    const gate = new Rendezvous(3, 200);
    const started = [1, 2, 3].map(() => gate.arrive());
    await Promise.all(started);
    expect(gate.arrivedCount).toBe(3);
    expect(gate.timedOut).toBe(false);

    const serial = new Rendezvous(3, 60);
    await serial.arrive(); // 只有 1 个到达者
    expect(serial.timedOut).toBe(true);
    expect(serial.arrivedCount).toBe(1);
  });
});

describe('R6 MU · MU-1 不同 principal 同时交办', () => {
  it('≥3 principal 并发交办：真交错、各自任务归属正确、无跨 principal 泄漏', async () => {
    const result = await mu1(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['taskCount']).toBe(MU_PRINCIPALS.length);
    expect(result.evidence['rendezvousTimedOut']).toBe(false);
    expect(result.records).toHaveLength(MU_PRINCIPALS.length);
  });
});

describe('R6 MU · MU-2 相同 sessionId 跨 principal', () => {
  it('同 sessionId 不合并会话：两 principal 各自成账、互不可见', async () => {
    const result = await mu2(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['aliceTasks']).toHaveLength(1);
    expect(result.evidence['bobTasks']).toHaveLength(1);
  });
});

describe('R6 MU · MU-3 同用户多会话', () => {
  it('同 principal 多会话各自成账、会话间不泄漏', async () => {
    const result = await mu3(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['jiaTasks']).toHaveLength(1);
    expect(result.evidence['yiTasks']).toHaveLength(1);
  });
});

describe('R6 MU · MU-4 交错并发', () => {
  it('3 principal × 2 轮交错：任务归属正确、转录不互污', async () => {
    const result = await mu4(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['taskCount']).toBe(MU_PRINCIPALS.length * 2);
    expect(result.evidence['transcriptViolations']).toEqual([]);
  });
});

describe('R6 MU · MU-5 跨用户越权', () => {
  it('B 经任务工具访问 A 的 #1 → 确定性拒绝、不泄露内容', async () => {
    const result = await mu5(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
  });
});

describe('R6 MU · MU-6 重启恢复（B1 已合入）', () => {
  it('≥3 principal 同 dbPath 关停重建：转录恢复 / 不跨读 / 任务不重放 / 结果找回', async () => {
    const result = await mu6(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    // ① 各自转录恢复
    const restored = result.evidence['restored'] as Record<string, boolean>;
    expect(Object.values(restored)).toHaveLength(MU_PRINCIPALS.length);
    expect(Object.values(restored).every(Boolean)).toBe(true);
    // ② 不跨 principal 串读
    expect(result.evidence['transcriptViolations']).toEqual([]);
    expect(result.evidence['taskViolations']).toEqual([]);
    // ③ 任务不重放
    expect(result.evidence['noReplay']).toBe(true);
    expect(result.evidence['replayCallsAfterTurn']).toBe(0);
    // ④ 结果找回
    const retrieval = result.evidence['resultRetrieval'] as Record<string, { ok: boolean }>;
    expect(Object.values(retrieval)).toHaveLength(MU_PRINCIPALS.length);
    expect(Object.values(retrieval).every((entry) => entry.ok)).toBe(true);
    expect(result.records.length).toBeGreaterThanOrEqual(MU_PRINCIPALS.length);
  });
});

describe('R6 MU · MU-7 异步通知错投', () => {
  it('事实只注入 owner 会话：B 拿不到 A 的任务事实', async () => {
    const result = await mu7(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['aliceGotFact']).toBe(true);
    expect(result.evidence['bobGotFact']).toBe(false);
  });
});

describe('R6 MU · MU-8 群聊与私聊隔离（依赖 B2）', () => {
  it('B2 未合入 → BLOCKED（不伪报 PASS）', async () => {
    const result = await mu8(MU_RUNTIME);
    expect(result.status).toBe('BLOCKED');
    expect(result.status).not.toBe('PASS');
  });
});

describe('R6 MU · MU-9 并发压缩', () => {
  it('多会话同进程并发压缩：转录不互污、无 H6 硬零、覆盖充分', async () => {
    const result = await mu9(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['contaminated']).toEqual([]);
    expect(result.evidence['compactionCount']).toBe(MU_PRINCIPALS.length * 3);
  });
});

describe('R6 MU · MU-10 单用户故障隔离', () => {
  it('A 执行失败不改 B/C：故障隔离成立、无串线', async () => {
    const result = await mu10(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    const alice = result.evidence['alice'] as { status?: string } | null;
    const bob = result.evidence['bob'] as { status?: string } | null;
    const carol = result.evidence['carol'] as { status?: string } | null;
    expect(alice?.status).toBe('failed');
    expect(bob?.status).toBe('completed');
    expect(carol?.status).toBe('completed');
  });
});

describe('R6 MU · 汇总（五要素完整）', () => {
  it('全部用例：10 条、每条五要素齐备、非依赖项无硬零', async () => {
    const results = await runAllMuCases(MU_RUNTIME);
    expect(results).toHaveLength(10);
    for (const result of results) {
      for (const record of result.records) {
        expect(typeof record.principalId).toBe('string');
        expect(typeof record.sessionId).toBe('string');
        expect(record.taskId === null || typeof record.taskId === 'string').toBe(true);
        expect(typeof record.request).toBe('string');
        expect(typeof record.deliveredTo).toBe('string');
      }
    }
    const blocked = results.filter((result) => result.status === 'BLOCKED').map((result) => result.id);
    expect(blocked.sort()).toEqual(['MU-8']);
    const failed = results.filter((result) => result.status === 'FAIL');
    expect(failed).toEqual([]);
  });
});
