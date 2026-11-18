/**
 * R6 MU · 群聊多用户交办（同一 conversationId 内 A/B 两位发言人）确定性 E2E。
 *
 * 业务盲区（MU-8 只覆盖「同一个人」的群/私隔离）：同一个群里 **不同用户**各自交办时，
 * 任务必须各归各人、互不可见；B 引用 A 发的附件必须按「不存在」同话术拒绝（不泄露存在性）；
 * 结果可以投递回群，但「谁能查」仍按发言人——同群不产生授权继承。
 *
 * 断言口径（沿用 MU 五要素：principalId / sessionId / taskId / 请求 / 实际投递对象）：
 *   · MU-11 同群 A/B 各自交办 → 两条任务分属 A/B；B 查 A 的编号（status/result/cancel）全拒绝；
 *   · MU-12 同群 B 引用 A 的附件 fileId → task_run 与 run_js 均拒绝，且话术与「不存在」逐字一致；
 *     A 用自己的 fileId 交办成功（正向对照）；B 的失败尝试零任务行；
 *   · MU-13 经真实渠道（WecomBotChannel + 记录型假 SDK，live 模式）把结果投回群，
 *     B 在同群查询 A 的任务仍被拒（投递回群 ≠ 授权继承）。
 *
 * 反向绊线：三个纯判定器喂「破坏形状」的观测，必须报红——证明断言不是恒真。
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@fshine/contracts';
import {
  judgeForeignFileReference,
  judgeGroupDeliveryIsolation,
  judgeGroupTaskIsolation,
  mu11,
  mu12,
  mu13,
  runAllGroupMuCases,
  type GroupQueryObservation,
} from './mu-group-cases';
import type { MuTaskSnapshot } from './mu-support';

/**
 * 资源旋钮只在 `*.test.ts` 内构造（同 mu.test.ts；`resource-policy-single-source` 守卫排除测试文件）。
 */
const MU_RUNTIME: RuntimeConfig = { mainConcurrency: 4, backgroundConcurrency: 4 };

function snapshot(partial: Partial<MuTaskSnapshot> & Pick<MuTaskSnapshot, 'taskId' | 'principalId' | 'sessionId' | 'request'>): MuTaskSnapshot {
  return {
    taskNo: 1,
    status: 'completed',
    reason: undefined,
    failureReason: undefined,
    resultText: undefined,
    requestIds: [],
    replyText: undefined,
    ...partial,
  };
}

describe('R6 MU · MU-11 同群不同用户各自交办（归属与查询按发言人）', () => {
  it('A/B 同 conversationId 交办：两任务各归各人、B 查 A 的编号全拒绝、A/B 查自己成功', async () => {
    const result = await mu11(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['sessionId']).toBe('wecom:group-mu11');
    expect(result.evidence['taskCount']).toBe(2);
    expect(result.evidence['bCrossAllRejected']).toBe(true);
    expect(result.evidence['bCrossLeaked']).toBe(false);
    expect(result.evidence['aOwnResolved']).toBe(true);
    expect(result.evidence['bOwnResolved']).toBe(true);
    expect(result.evidence['groupRepliesDelivered']).toBe(true);
    // 五要素齐备（两条任务各自的投递记录）。
    expect(result.records.length).toBeGreaterThanOrEqual(2);
    for (const record of result.records) {
      expect(typeof record.principalId).toBe('string');
      expect(record.sessionId).toBe('wecom:group-mu11');
      expect(typeof record.request).toBe('string');
      expect(typeof record.deliveredTo).toBe('string');
    }
  });
});

describe('R6 MU · MU-12 同群引用他人附件（不泄露存在性）', () => {
  it('B 用 A 的 fileId：task_run/run_js 同话术拒绝、B 零任务行、A 用自己的 fileId 成功', async () => {
    const result = await mu12(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['aFileId']).toMatch(/^file_[0-9a-f]{32}$/);
    // 存在性与不存在同一话术（逐字）：不产生存在性 oracle。
    expect(result.evidence['bForeignTaskRunError']).toBe(result.evidence['bNonexistentTaskRunError']);
    expect(result.evidence['bForeignRunJsError']).toBe(result.evidence['bNonexistentTaskRunError']);
    expect(result.evidence['bForeignTaskRunError']).toContain('输入文件不可用');
    // B 的清单里根本看不到 A 的文件；B 的失败尝试不落任务行。
    expect(result.evidence['bManifestSawForeign']).toBe(false);
    expect(result.evidence['bTaskCountBefore']).toBe(0);
    expect(result.evidence['bTaskCountAfter']).toBe(0);
    // 正向对照：A 用自己的 fileId 交办成功（否则「全拒绝也算绿」）。
    expect(result.evidence['aOwnFileTaskCreated']).toBe(true);
    expect(result.evidence['taskCount']).toBe(1);
    expect(result.evidence['aTaskPrincipal']).toBe('wecom:mu-alice');
  });
});

describe('R6 MU · MU-13 结果投递回群 ≠ 授权继承（真实渠道路径）', () => {
  it('A 的结果经渠道投回群；B 在同群查 A 的任务仍被拒、B 的 scope 无 A 任务', async () => {
    const result = await mu13(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['groupChatId']).toBe('group-mu13');
    expect(result.evidence['allOutboundToGroup']).toBe(true);
    expect(result.evidence['aReplyDeliveredToGroup']).toBe(true);
    expect(result.evidence['bQueryRejected']).toBe(true);
    expect(result.evidence['bQueryLeaked']).toBe(false);
    expect(result.evidence['bScopeTaskCount']).toBe(0);
  });
});

describe('R6 MU · 群聊多用户汇总（五要素完整）', () => {
  it('全部 3 条用例：PASS、无 BLOCKED、五要素齐备', async () => {
    const results = await runAllGroupMuCases(MU_RUNTIME);
    expect(results).toHaveLength(3);
    expect(results.map((result) => result.id)).toEqual(['MU-11', 'MU-12', 'MU-13']);
    expect(results.filter((result) => result.status !== 'PASS')).toEqual([]);
    for (const result of results) {
      for (const record of result.records) {
        expect(typeof record.principalId).toBe('string');
        expect(typeof record.sessionId).toBe('string');
        expect(record.taskId === null || typeof record.taskId === 'string').toBe(true);
        expect(typeof record.request).toBe('string');
        expect(typeof record.deliveredTo).toBe('string');
      }
    }
  });
});

/**
 * 反向绊线（≥3 组）：把「泄漏/越权/错投」的观测喂给用例实际使用的判定器，必须报红。
 * 若判定器被改弱成恒真/恒绿，这一组会立刻失败。
 */
describe('R6 MU · 群聊多用户反向绊线（故意破坏必须红）', () => {
  const aTask = snapshot({ taskId: 'task_a', principalId: 'wecom:mu-alice', sessionId: 'wecom:group-x', request: 'A 交办', taskNo: 1 });
  const bTask = snapshot({ taskId: 'task_b', principalId: 'wecom:mu-bob', sessionId: 'wecom:group-x', request: 'B 交办', taskNo: 2 });
  const owners = new Map<string, string>([['A 交办', 'wecom:mu-alice'], ['B 交办', 'wecom:mu-bob']]);
  const ownQuery = (taskId: string, ref: string): GroupQueryObservation => ({ tool: 'task_status', ref, error: null, result: { taskId } });
  const rejected: GroupQueryObservation = { tool: 'task_status', ref: '#1', error: '任务不存在或不属于当前会话。', result: null };

  const healthy = {
    tasks: [aTask, bTask],
    expectedOwnerByRequest: owners,
    aTaskId: 'task_a',
    bTaskId: 'task_b',
    bQueriesOfATask: [rejected],
    aOwnQueries: [ownQuery('task_a', '#1')],
    bOwnQueries: [ownQuery('task_b', '#2')],
    forbiddenMarkers: ['A 交办', 'TAG-A'],
  };

  it('绊线1a：B 查到 A 的任务（越权成功）→ unauthorized_execution', () => {
    const verdict = judgeGroupTaskIsolation({
      ...healthy,
      bQueriesOfATask: [{ tool: 'task_status', ref: '#1', error: null, result: { taskId: 'task_a' } }],
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线1b：B 的拒绝结果带出 A 的请求原文（存在性/内容泄漏）→ cross_principal_leak', () => {
    const verdict = judgeGroupTaskIsolation({
      ...healthy,
      bQueriesOfATask: [{ tool: 'task_status', ref: '#1', error: null, result: { taskId: 'task_a', request: 'A 交办' } }],
    });
    expect(verdict.hits).toContain('cross_principal_leak');
  });

  it('绊线1c：任务归属被写错（B 的任务落到 A 名下）→ cross_principal_leak', () => {
    const swapped = snapshot({ taskId: 'task_b', principalId: 'wecom:mu-alice', sessionId: 'wecom:group-x', request: 'B 交办', taskNo: 2 });
    const verdict = judgeGroupTaskIsolation({ ...healthy, tasks: [aTask, swapped] });
    expect(verdict.hits).toContain('cross_principal_leak');
  });

  const goodForeign = { tool: 'task_run', error: '输入文件不可用：引用的文件不存在、未激活或已过期；请只用文件清单里给出的 fileId 引用输入文件。', result: null };
  const goodNonexistent = { ...goodForeign };
  const goodOwn = { tool: 'task_run', error: null, result: { taskId: 'task_a' } };
  const fileHealthy = {
    aFileId: 'file_0123456789abcdef0123456789abcdef',
    aFileName: 'a-list.xlsx',
    bForeignTaskRun: goodForeign,
    bForeignRunJs: goodForeign,
    bNonexistentTaskRun: goodNonexistent,
    aOwnTaskRun: goodOwn,
    bTaskCountBefore: 0,
    bTaskCountAfter: 0,
    aTaskCountAfter: 1,
    bManifestSawForeign: false,
  };

  it('绊线2a：B 引用 A 的 fileId 竟然成功（越权执行）→ unauthorized_execution', () => {
    const verdict = judgeForeignFileReference({
      ...fileHealthy,
      bForeignTaskRun: { tool: 'task_run', error: null, result: { taskId: 'task_b' } },
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线2b：外语 fileId 与不存在 fileId 话术不同（存在性 oracle）→ unauthorized_execution', () => {
    const verdict = judgeForeignFileReference({
      ...fileHealthy,
      bForeignTaskRun: { tool: 'task_run', error: '文件不属于你。', result: null },
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线2c：B 的清单里出现 A 的 fileId（跨用户文件可见）→ cross_principal_leak', () => {
    const verdict = judgeForeignFileReference({ ...fileHealthy, bManifestSawForeign: true });
    expect(verdict.hits).toContain('cross_principal_leak');
  });

  it('绊线2d：B 的失败引用留下任务行（部分执行）→ task_crossover', () => {
    const verdict = judgeForeignFileReference({ ...fileHealthy, bTaskCountAfter: 1 });
    expect(verdict.hits).toContain('task_crossover');
  });

  const deliveryHealthy = {
    groupChatId: 'group-x',
    outbound: [{ chatid: 'group-x', content: 'A 已完成：3 条。' }],
    aReply: '3 条',
    bQuery: rejected,
    bQueryReply: '没有这个任务。',
    aTaskId: 'task_a',
    bScopeTasks: [] as readonly MuTaskSnapshot[],
    forbiddenMarkers: ['A 交办'],
  };

  it('绊线3a：A 的结果被投到私聊/他处（错投）→ notification_misdelivery', () => {
    const verdict = judgeGroupDeliveryIsolation({
      ...deliveryHealthy,
      outbound: [{ chatid: 'mu-alice', content: 'A 已完成：3 条。' }],
    });
    expect(verdict.hits).toContain('notification_misdelivery');
  });

  it('绊线3b：同群 B 查 A 的任务竟然成功（投递回群=授权继承）→ unauthorized_execution', () => {
    const verdict = judgeGroupDeliveryIsolation({
      ...deliveryHealthy,
      bQuery: { tool: 'task_status', ref: '#1', error: null, result: { taskId: 'task_a' } },
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线3c：B 的 scope 列表里出现 A 的任务（跨用户读取）→ cross_principal_leak', () => {
    const verdict = judgeGroupDeliveryIsolation({
      ...deliveryHealthy,
      bScopeTasks: [aTask],
    });
    expect(verdict.hits).toContain('cross_principal_leak');
  });
});
