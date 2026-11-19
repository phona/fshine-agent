/**
 * 用户可见失败话术（`user-facing-failure.ts`）的判据。
 *
 * owner 2026-11-19：「这些东西告诉给用户，他啥都干不了，跟他说，他还不愿意看，也不知道怎么办」
 * → 用户侧只允许「业务语言说清发生了什么 + 一个他能做的动作」；执行层原文与内部术语进日志。
 *
 * 本套件钉三件事：
 *   ① 归类只看码/状态（不看文案语义），我方故障码必须落 `host_fault`（不解释内部）；
 *   ② 每种失败话术都带至少一个用户可执行的动作，且**全部话术都不含内部术语**；
 *   ③ 内部术语闸能命中内部形态、且不误伤业务句子。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  failureMessageFor,
  internalTermIn,
  type UserFacingFailureKind,
} from './src/user-facing-failure';
import type { ExecutionClient, ExecutionOutcome, CapabilityManifest } from '@fshine/contracts/execution-contract';
import { createSession, EXECUTE_OPERATION_TOOL, TASK_RUN_TOOL, renderWorkerDelegation, WORKER_SNAPSHOT_COST_NOTE } from './src/execution-runtime';
import type { DriverMessage, TurnDriver } from './src/driver-contract';

const ALL_KINDS: readonly UserFacingFailureKind[] = [
  'needs_confirmation',
  'needs_input',
  'not_found',
  'denied',
  'invalid_input',
  'executor_failed',
  'host_fault',
  'unknown_result',
  'timed_out',
];

/** 脚本化执行层：每次 execute 返回预设 outcome（连续调用可多步）。 */
class ScriptedClient implements ExecutionClient {
  constructor(private readonly outcomes: readonly ExecutionOutcome[]) {}
  private index = 0;

  async capabilities(): Promise<CapabilityManifest> {
    return {
      contractVersion: 2,
      operations: [
        { name: 'dummy.query', label: 'query', args: [] },
        { name: 'dummy.commit', label: 'commit', args: [{ name: '--collection', required: true }] },
      ],
    };
  }

  async execute(): Promise<ExecutionOutcome> {
    const outcome = this.outcomes[this.index];
    this.index += 1;
    if (outcome === undefined) throw new Error('（测试）执行层没有更多步骤');
    return outcome;
  }
}

/**
 * 经真实 createSession 链路取模型（Worker）可见投影：Main 委派一个只读任务，Worker
 * 调 execute_operation，其工具结果（toModelVisibleOutcome 的产物）被捕获返回。
 * 与 production 同源装配（task_run → Worker → execute_operation → 工具结果）。
 */
async function workerVisibleOutcomeOf(outcome: ExecutionOutcome): Promise<Record<string, unknown>> {
  let captured: unknown;
  const workerDriver: TurnDriver = {
    async run(input) {
      captured = await input.exec(EXECUTE_OPERATION_TOOL, { operation: 'dummy.query', args: {} });
      return { text: '按执行层回执汇报。', messages: [] as unknown as DriverMessage[] };
    },
  };
  const mainDriver: TurnDriver = {
    async run(input) {
      await input.exec(TASK_RUN_TOOL, { task: '查一下 alpha' });
      return { text: '已转述。', messages: [] as unknown as DriverMessage[] };
    },
  };
  const session = await createSession({
    principalId: 'wecom:test-user',
    sessionId: 'sess_visible_failure',
    client: new ScriptedClient([outcome]),
    allowedOperations: ['dummy.query'],
    readOnlyOperations: ['dummy.query'],
    mainDriver,
    workerDriver,
    mainSystemPrompt: '（测试）Main 系统提示',
  });
  await session.send('查一下 alpha');
  if (captured === undefined) throw new Error('（测试）Worker 工具结果未捕获');
  return captured as Record<string, unknown>;
}

describe('用户可见失败话术', () => {
  it('① 归类只看码/状态：权限、不存在、口径、补充、执行端失败各归各位', () => {
    expect(classifyFailure({ code: 'GATE_REFUSE' })).toBe('denied');
    expect(classifyFailure({ code: 'COLLECTION_NOT_FOUND' })).toBe('not_found');
    expect(classifyFailure({ code: 'WHERE_INVALID' })).toBe('invalid_input');
    expect(classifyFailure({ code: 'QUERY_REQUIRED' })).toBe('invalid_input');
    expect(classifyFailure({ code: 'CONFIRMATION_REQUIRED' })).toBe('needs_confirmation');
    expect(classifyFailure({ code: 'COLLECTION_FAULT' })).toBe('executor_failed');
    expect(classifyFailure({ code: 'SOMETHING_NEW' })).toBe('executor_failed');
    expect(classifyFailure({ status: 'result_unknown' })).toBe('unknown_result');
    // 单次调用被传输超时截断（无回执）带的就是这个码：码分支同样归 unknown_result
    // ——绝不能落 executor_failed（那会给出「再试一次」的暗示，而写操作可能已经生效）。
    expect(classifyFailure({ code: 'result_unknown', status: 'failed' })).toBe('unknown_result');
  });

  it('② 我方故障码一律 host_fault：协议违约、句柄丢失、令牌不匹配都不向用户解释', () => {
    for (const code of ['EXECUTION_PROTOCOL_VIOLATION', 'CONFIRMATION_NOT_FOUND', 'PROPOSAL_TOKEN_UNTRUSTED', 'PROPOSAL_REFUSE']) {
      expect(classifyFailure({ code }), code).toBe('host_fault');
    }
    const message = failureMessageFor('host_fault');
    expect(message.text).toContain('没弄好');
    expect(message.text.length).toBeLessThanOrEqual(30);
    expect(message.actions.length).toBeGreaterThan(0);
  });

  it('③ 每种失败都带可执行动作，且话术里没有任何内部术语（逐条过闸）', () => {
    for (const kind of ALL_KINDS) {
      const message = failureMessageFor(kind, {
        subject: 'alpha 集合',
        missing: ['窗口编号'],
        summary: '向 alpha 集合 W1 新增 2 条记录',
      });
      expect(message.actions.length, `${kind} 没有可执行动作`).toBeGreaterThan(0);
      expect(message.actions).not.toContain('none');
      expect(message.text.length).toBeGreaterThan(0);
      // 关键不变量：话术本身绝不能命中内部术语闸。
      expect(internalTermIn(message.text), `${kind} 话术含内部术语：${message.text}`).toBeUndefined();
      // 简短（owner：「像真人回复」）：一句话说完；含摘要/缺失项的两种允许带上业务内容。
      if (kind !== 'needs_confirmation' && kind !== 'needs_input') {
        expect(message.text.length, `${kind} 话术太长：${message.text}`).toBeLessThanOrEqual(40);
      }
      // 简短（owner：「像真人回复」）：一句话说完；含摘要/缺失项的两种允许带上业务内容。
      if (kind !== 'needs_confirmation' && kind !== 'needs_input') {
        expect(message.text.length, `${kind} 话术太长：${message.text}`).toBeLessThanOrEqual(40);
      }
    }
  });

  it('④ 话术落到业务语言：给出对象/缺什么/摘要，不编内部细节', () => {
    expect(failureMessageFor('not_found', { subject: 'contract-archive 集合' }).text).toContain('contract-archive 集合');
    expect(failureMessageFor('needs_input', { missing: ['窗口编号', '客户名称'] }).text).toContain('窗口编号、客户名称');
    expect(failureMessageFor('needs_confirmation', { summary: '向 alpha 集合 W1 新增 2 条记录' }).text)
      .toContain('向 alpha 集合 W1 新增 2 条记录');
    // 缺信息但拿不到明细时不编：如实说"具体缺什么没拿到"。
    expect(failureMessageFor('needs_input').text).toContain('没拿到');
    expect(failureMessageFor('unknown_result').text).toContain('不确定做没做完');
  });

  it('⑤ 内部术语闸：命中内部形态，不误伤业务句子', () => {
    const shouldHit = [
      '执行层这次没返回句柄',
      '提交时缺少确认凭据',
      '令牌不匹配或已过期',
      '能力清单里标记为长时间运行操作',
      '这个 operation 不在允许集合',
      '任务 task_71d08976-4b7e-4041-8976-6aeac6eeecef 失败',
      '报错文件 /home/tao/projects/x/y.ts',
    ];
    for (const text of shouldHit) expect(internalTermIn(text), text).toBeDefined();

    const shouldMiss = [
      'alpha 集合 W1 共 2 条记录，合计 2000。',
      '没找到 contract-archive 集合。要我换个范围再找一次？',
      '要写入：向 alpha 集合 W1 新增 2 条记录。回「确认」我就提交。',
      '这次没办成，是我这边的问题。要我重试一次，还是先记下来让人来看？',
    ];
    for (const text of shouldMiss) expect(internalTermIn(text), text).toBeUndefined();
  });

  it('⑥ failed/refused 的模型可见投影：不含执行层原文与技术码，含 kind+note', async () => {
    // 2026-11-19 抽象泄露 fix：执行层 error.message/code 曾经逐字进模型可见投影——
    // 用户收到「执行层/执行端/确认凭据/令牌/能力清单/必填参数/异步」这类内部词。
    // 收口后模型（Worker 工具结果）只见 {status, kind, note}；原文与码只进日志
    // （execution_failure_classified）。
    const failed = await workerVisibleOutcomeOf({
      status: 'failed',
      error: { code: 'COLLECTION_FAULT', message: 'gateway crashed with exit 2 (internal executor fault)', retryable: false },
    });
    expect(failed).toEqual({ status: 'failed', kind: 'executor_failed', note: '没办成。再试一次，还是先放着？' });
    const projected = JSON.stringify(failed);
    expect(projected).not.toContain('COLLECTION_FAULT');
    expect(projected).not.toContain('gateway crashed');
    // 「执行层/执行端」这类中文内部词不得出现（kind 的 executor_failed 是封闭枚举名，
    // 不是执行层自由文本；断言钉的是原文泄露面）。
    expect(projected).not.toContain('执行层');
    expect(projected).not.toContain('执行端');
    expect(projected).not.toContain('retryable');

    // refused（门拒）同样归类成 denied 话术，不暴露原始码与「凭据/句柄」字样。
    const refused = await workerVisibleOutcomeOf({
      status: 'refused',
      error: { code: 'GATE_REFUSE', message: 'missing confirmation credential --confirmation <handle>', retryable: false },
    });
    expect(refused).toEqual({ status: 'refused', kind: 'denied', note: '这件事没权限。换个对象，还是请管理员开通？' });
    const refusedProjected = JSON.stringify(refused);
    expect(refusedProjected).not.toContain('GATE_REFUSE');
    expect(refusedProjected).not.toContain('confirmation');
    expect(refusedProjected).not.toContain('handle');

    // 未知码收敛成 executor_failed，不把原文给模型。
    const unknown = await workerVisibleOutcomeOf({
      status: 'failed',
      error: { code: 'SOMETHING_NEW_INTERNAL', message: 'internal stack overflow at adapter boundary' },
    });
    expect(unknown).toEqual({ status: 'failed', kind: 'executor_failed', note: '没办成。再试一次，还是先放着？' });
    // needs_confirmation 只给机械摘要与 data（sanity：写确认路径不受影响）。
    const needsConfirm = await workerVisibleOutcomeOf({
      status: 'needs_confirmation',
      confirmation: { handle: 'cf_secret', summary: '将向 alpha W1 新增 2 条；不可撤销', expiresAt: '2026-11-19T12:00:00Z' },
      data: { collection: 'alpha' },
    });
    expect(JSON.stringify(needsConfirm)).not.toContain('cf_secret');
    expect(needsConfirm).toMatchObject({ status: 'needs_confirmation', summary: '将向 alpha W1 新增 2 条；不可撤销' });
    // completed 保持原样（逐字节不变）。
    const completed = await workerVisibleOutcomeOf({ status: 'completed', data: { count: 3 } });
    expect(completed).toEqual({ status: 'completed', data: { count: 3 } });
  });

  it('⑦ Worker 委派文本不含内部度量（weight/est_seconds/估时字样）', () => {
    // 2026-11-19 抽象泄露 fix：委派里的能力快照曾带 weight/est_seconds——模型据此向用户
    // 承诺「单次估时约半小时」这类内部数字。收口后委派只保留调用所需（name/label/args/
    // long_running）；长任务标记保留（它影响行为：可能返回 accepted）。
    const manifest = {
      contractVersion: 3,
      operations: [
        { name: 'dummy.query', label: 'query records', args: [], weight: 2, estimatedSeconds: 10 },
        { name: 'dummy.commit', label: 'commit records', args: [{ name: '--collection', required: true }], weight: 20, estimatedSeconds: 10 },
        { name: 'dummy.longtask', label: 'long', args: [], estimatedSeconds: 1800, long_running: true },
      ],
    } as Parameters<typeof renderWorkerDelegation>[0]['manifest'];
    const text = renderWorkerDelegation({ task: '查一下 alpha', manifest });
    expect(text).not.toContain('"weight"');
    expect(text).not.toContain('"estimatedSeconds"');
    expect(text).not.toContain('1800');
    expect(text).not.toContain('估时');
    expect(text).not.toContain('重量');
    // 中性事实不再宣称「每个 operation 标注单次估时与重量」。
    expect(WORKER_SNAPSHOT_COST_NOTE).not.toContain('估时');
    expect(WORKER_SNAPSHOT_COST_NOTE).not.toContain('重量');
    // 调用所需仍在：operation 名、参数签名、long_running（影响行为）。
    expect(text).toContain('"dummy.commit"');
    expect(text).toContain('"long_running": true');
    expect(text).toContain('--collection');
  });
});
