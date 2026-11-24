/**
 * R6 MU · 群聊多用户交办（同一 conversationId 内 A/B 两位发言人）确定性 E2E。
 *
 * **语义已被取代（owner 2026-11-18：群 = 独立主体）**。旧模型要求「principal 按发言人分、
 * session 按群分」，同群 A/B 互不可见；新模型 `principalId = wecom:group:<conversationId>`：
 * 同群所有人共用一个主体（共享记忆/文件/任务），发言人只作审计。因此本文件的断言按新模型
 * 重写——不是放宽，而是把安全边界从「同群不同人隔离」移到「跨群隔离」与「群资产归属」：
 *   · MU-11 同群 A/B 交办 → 两条任务同属群主体；同群互查必须**成功**（共享）；B 的回合转录
 *     里看得到 A 的原话；**另一个群**的 C 查同一编号必须被拒且无内容泄漏；
 *   · MU-12 A 在群里发附件 → 同群 B 能引用它交办（群文件 = 群资产）；另一个群的 C 引用同一
 *     fileId → `输入文件不可用` 且与不存在 fileId 逐字同话术、清单不可见、零任务行；
 *   · MU-13 经真实渠道（WecomBotChannel + 记录型假 SDK，live 模式）把结果投回本群；同群可查、
 *     异群被拒；出站不投到任何私聊/他处。
 *
 * 反向绊线：三个纯判定器喂「泄漏/越权/错投/共享失效」的观测，必须报红。
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@fshine/contracts';
import {
  judgeGroupDeliverySharing,
  judgeGroupFileSharing,
  judgeGroupSharedPrincipal,
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
    started: true,
    ended: true,
    reported: true,
    waiting: false,
    mayBeRunning: false,
    lastExecutionStatus: undefined,
    reason: undefined,
    failureReason: undefined,
    resultText: undefined,
    requestIds: [],
    replyText: undefined,
    ...partial,
  };
}

describe('R6 MU · MU-11 同群共用群主体（互查成功）+ 跨群不串', () => {
  it('同群 A/B 交办归同一群主体、互查成功、转录共享；异群查同一编号全拒绝', async () => {
    const result = await mu11(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['groupPrincipalId']).toBe('wecom:group:group-mu11');
    expect(result.evidence['sessionId']).toBe('wecom:group-mu11');
    expect(result.evidence['taskCount']).toBe(2);
    // 同群共享：两条任务同一 principal、同一 session；互查都必须成功。
    expect(result.evidence['principals']).toEqual(['wecom:group:group-mu11']);
    expect(result.evidence['sessionIds']).toEqual(['wecom:group-mu11']);
    expect(result.evidence['sameGroupResolved']).toBe(true);
    expect(result.evidence['sameGroupMemoryShared']).toBe(true);
    // 跨群隔离：另一个（已开通的）群查同一编号必须被拒且无内容泄漏。
    expect(result.evidence['otherGroupAllRejected']).toBe(true);
    expect(result.evidence['otherGroupLeaked']).toBe(false);
    expect(result.evidence['ownerMismatches']).toEqual([]);
    // 五要素齐备（五个回合各自的投递记录）。
    expect(result.records.length).toBeGreaterThanOrEqual(5);
    for (const record of result.records) {
      expect(typeof record.principalId).toBe('string');
      expect(typeof record.request).toBe('string');
      expect(typeof record.deliveredTo).toBe('string');
    }
  });
});

describe('R6 MU · MU-12 群文件 = 群资产（同群可共享；异群同话术拒绝）', () => {
  it('同群 B 能用 A 的 fileId 交办；异群 C 引用同 fileId 与不存在同话术、清单不可见、零任务行', async () => {
    const result = await mu12(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['aFileId']).toMatch(/^file_[0-9a-f]{32}$/);
    // 同群共享：B 的清单里有 A 的文件，交办成功，任务归群主体。
    expect(result.evidence['bManifestSawShared']).toBe(true);
    expect(result.evidence['bSharedUsable']).toBe(true);
    expect(result.evidence['groupTaskOwnedByGroup']).toBe(true);
    expect(result.evidence['groupTaskPrincipal']).toBe('wecom:group:group-mu12');
    // 异群：存在性与不存在同一话术（逐字），且拒绝里不带 fileId/文件名。
    expect(result.evidence['cForeignTaskRunError']).toBe(result.evidence['cNonexistentTaskRunError']);
    expect(result.evidence['cForeignTaskRunError']).toContain('输入文件不可用');
    expect(result.evidence['cLeakedMarkers']).toEqual([]);
    expect(result.evidence['cManifestSawForeign']).toBe(false);
    // C 的失败尝试不落任务行；全批只有 1 条群任务。
    expect(result.evidence['cTaskCountBefore']).toBe(result.evidence['cTaskCountAfter']);
    expect(result.evidence['taskCount']).toBe(1);
  });
});

describe('R6 MU · MU-13 结果投回本群；同群可查、异群不可查（真实渠道路径）', () => {
  it('A 的结果经渠道投回本群；同群 B 查到 A 的任务、异群 C 被拒；出站不投私聊/他处', async () => {
    const result = await mu13(MU_RUNTIME);
    expect(result.status).toBe('PASS');
    expect(result.hardZeroHits).toEqual([]);
    expect(result.evidence['groupChatId']).toBe('group-mu13');
    expect(result.evidence['aReplyDeliveredToGroup']).toBe(true);
    expect(result.evidence['foreignTargets']).toEqual([]);
    expect(result.evidence['outboundChatIds']).toEqual(expect.arrayContaining(['group-mu13']));
    expect(result.evidence['bQueryResolved']).toBe(true);
    expect(result.evidence['cQueryRejected']).toBe(true);
    expect(result.evidence['cQueryLeaked']).toBe(false);
    expect(result.evidence['aTaskPrincipal']).toBe('wecom:group:group-mu13');
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
 * 反向绊线（≥3 组/每判定器）：把「泄漏/越权/错投/共享失效」的观测喂给用例实际使用的判定器，
 * 必须报红。若判定器被改弱成恒真/恒绿，这一组会立刻失败。
 */
describe('R6 MU · 群聊多用户反向绊线（故意破坏必须红）', () => {
  const groupPrincipal = 'wecom:group:group-x';
  const aTask = snapshot({ taskId: 'task_a', principalId: groupPrincipal, sessionId: 'wecom:group-x', request: 'A 交办', taskNo: 1 });
  const bTask = snapshot({ taskId: 'task_b', principalId: groupPrincipal, sessionId: 'wecom:group-x', request: 'B 交办', taskNo: 2 });
  const ownQuery = (taskId: string, ref: string): GroupQueryObservation => ({ tool: 'task_status', ref, error: null, result: { taskId } });
  const rejected: GroupQueryObservation = { tool: 'task_status', ref: '#1', error: '任务不存在或不属于当前会话。', result: null };

  const sharedHealthy = {
    tasks: [aTask, bTask],
    groupPrincipalId: groupPrincipal,
    aTaskId: 'task_a',
    bTaskId: 'task_b',
    bQueriesOfATask: [ownQuery('task_a', '#1')],
    aQueriesOfBTask: [ownQuery('task_b', '#2')],
    otherGroupQueries: [rejected],
    forbiddenMarkers: ['A 交办', 'TAG-A'],
    sameGroupMemoryShared: true,
  };

  it('绊线1a：同群共享失效（B 查不到 A 的任务）→ unauthorized_execution', () => {
    const verdict = judgeGroupSharedPrincipal({
      ...sharedHealthy,
      bQueriesOfATask: [{ tool: 'task_status', ref: '#1', error: '任务不存在或不属于当前会话。', result: null }],
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线1b：同群转录不共享（第二个发言人看不到前一句）→ unauthorized_execution', () => {
    const verdict = judgeGroupSharedPrincipal({ ...sharedHealthy, sameGroupMemoryShared: false });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线1c：异群 C 竟然查到 A 的任务（跨群越权）→ unauthorized_execution', () => {
    const verdict = judgeGroupSharedPrincipal({
      ...sharedHealthy,
      otherGroupQueries: [ownQuery('task_a', '#1')],
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线1d：异群拒绝结果带出 A 的请求原文（内容泄漏）→ cross_principal_leak', () => {
    const verdict = judgeGroupSharedPrincipal({
      ...sharedHealthy,
      otherGroupQueries: [{ tool: 'task_status', ref: '#1', error: null, result: { taskId: 'task_a', request: 'A 交办' } }],
    });
    expect(verdict.hits).toContain('cross_principal_leak');
  });

  it('绊线1e：任务归属退回按发言人（B 的任务落到个人主体）→ cross_principal_leak', () => {
    const perSpeaker = snapshot({ taskId: 'task_b', principalId: 'wecom:mu-bob', sessionId: 'wecom:group-x', request: 'B 交办', taskNo: 2 });
    const verdict = judgeGroupSharedPrincipal({ ...sharedHealthy, tasks: [aTask, perSpeaker] });
    expect(verdict.hits).toContain('cross_principal_leak');
  });

  const goodShared = { tool: 'task_run', error: null, result: { taskId: 'task_b' } };
  const goodForeign = { tool: 'task_run', error: '输入文件不可用：引用的文件不存在、未激活或已过期；请只用文件清单里给出的 fileId 引用输入文件。', result: null };
  const goodNonexistent = { ...goodForeign };
  const fileHealthy = {
    groupPrincipalId: groupPrincipal,
    aFileId: 'file_0123456789abcdef0123456789abcdef',
    aFileName: 'a-list.xlsx',
    bSharedTaskRun: goodShared,
    bManifestSawShared: true,
    cForeignTaskRun: goodForeign,
    cNonexistentTaskRun: goodNonexistent,
    cTaskCountBefore: 1,
    cTaskCountAfter: 1,
    cManifestSawForeign: false,
    groupTaskPrincipal: groupPrincipal,
    groupTaskCount: 1,
  };

  it('绊线2a：异群 C 引用别群 fileId 竟然成功（越权执行）→ unauthorized_execution', () => {
    const verdict = judgeGroupFileSharing({
      ...fileHealthy,
      cForeignTaskRun: { tool: 'task_run', error: null, result: { taskId: 'task_c' } },
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线2b：异群外语 fileId 与不存在 fileId 话术不同（存在性 oracle）→ unauthorized_execution', () => {
    const verdict = judgeGroupFileSharing({
      ...fileHealthy,
      cForeignTaskRun: { tool: 'task_run', error: '文件不属于你。', result: null },
    });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线2c：异群清单里出现别群文件（跨群文件可见）→ cross_principal_leak', () => {
    const verdict = judgeGroupFileSharing({ ...fileHealthy, cManifestSawForeign: true });
    expect(verdict.hits).toContain('cross_principal_leak');
  });

  it('绊线2d：异群失败引用留下任务行（部分执行）→ task_crossover', () => {
    const verdict = judgeGroupFileSharing({ ...fileHealthy, cTaskCountAfter: 2 });
    expect(verdict.hits).toContain('task_crossover');
  });

  it('绊线2e：同群共享失效（B 清单看不到群文件 / 交办被拒）→ unauthorized_execution', () => {
    const verdict = judgeGroupFileSharing({ ...fileHealthy, bManifestSawShared: false });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线2f：群任务落到个人主体（群资产私有化）→ task_crossover', () => {
    const verdict = judgeGroupFileSharing({ ...fileHealthy, groupTaskPrincipal: 'wecom:mu-bob' });
    expect(verdict.hits).toContain('task_crossover');
  });

  const deliveryHealthy = {
    groupChatId: 'group-x',
    allowedChatIds: ['group-x', 'group-y'],
    outbound: [{ chatid: 'group-x', content: 'A 已完成：3 条。' }, { chatid: 'group-y', content: '别的群没有这个任务。' }],
    aReply: '3 条',
    bQuery: ownQuery('task_a', '#1'),
    cQuery: rejected,
    cQueryReply: '别的群没有这个任务。',
    aTaskId: 'task_a',
    forbiddenMarkers: ['A 交办'],
  };

  it('绊线3a：A 的结果被投到私聊（错投）→ notification_misdelivery', () => {
    const verdict = judgeGroupDeliverySharing({
      ...deliveryHealthy,
      outbound: [{ chatid: 'mu-alice', content: 'A 已完成：3 条。' }],
    });
    expect(verdict.hits).toContain('notification_misdelivery');
  });

  it('绊线3b：结果没投回本群 → notification_misdelivery', () => {
    const verdict = judgeGroupDeliverySharing({
      ...deliveryHealthy,
      outbound: [{ chatid: 'group-y', content: '别的群没有这个任务。' }],
    });
    expect(verdict.hits).toContain('notification_misdelivery');
  });

  it('绊线3c：同群 B 查不到本群任务（共享失效）→ unauthorized_execution', () => {
    const verdict = judgeGroupDeliverySharing({ ...deliveryHealthy, bQuery: rejected });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线3d：异群 C 查到了别群任务（跨群越权）→ unauthorized_execution', () => {
    const verdict = judgeGroupDeliverySharing({ ...deliveryHealthy, cQuery: ownQuery('task_a', '#1') });
    expect(verdict.hits).toContain('unauthorized_execution');
  });

  it('绊线3e：异群拒绝话术带出别群请求原文（泄漏）→ cross_principal_leak', () => {
    const verdict = judgeGroupDeliverySharing({ ...deliveryHealthy, cQueryReply: '别的群没有这个任务（A 交办）。' });
    expect(verdict.hits).toContain('cross_principal_leak');
  });
});
