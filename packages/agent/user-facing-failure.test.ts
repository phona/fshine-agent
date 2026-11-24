/**
 * 用户可见失败话术（`user-facing-failure.ts`）的判据。
 *
 * owner 2026-11-19：「这些东西告诉给用户，他啥都干不了，跟他说，他还不愿意看，也不知道怎么办」
 * → 用户侧只允许「业务语言说清发生了什么 + 一个他能做的动作」；执行层原文与内部术语进日志。
 *
 * 本套件钉三件事：
 *   ① 兜底选档只认宿主自己的码（2026-11-24 删码表后）：执行层业务码一律通用档，不复制码义；
 *   ② 每种失败话术都带至少一个用户可执行的动作，且**全部话术都不含内部术语**；
 *   ③ 内部术语闸能命中内部形态、且不误伤业务句子。
 */
import { describe, expect, it } from 'vitest';
import {
  failureMessageFor,
  fallbackFailureKindOf,
  internalTermIn,
  type UserFacingFailureKind,
} from './src/user-facing-failure';
import type { ExecutionClient, ExecutionOutcome, CapabilityManifest } from '@fshine/contracts/execution-contract';
import { createSession, EXECUTE_OPERATION_TOOL, TASK_RUN_TOOL, renderWorkerDelegation } from './src/execution-runtime';
import type { DriverMessage, TurnDriver } from './src/driver-contract';

const ALL_KINDS: readonly UserFacingFailureKind[] = [
  'needs_confirmation',
  'needs_input',
  'denied',
  'invalid_input',
  'executor_failed',
  'host_fault',
  'unknown_result',
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
  it('① 兜底选档只认宿主自己的码：结果未知/协议违约/句柄丢失各归各位，执行层业务码一律通用档', () => {
    // 2026-11-24 owner 裁定「宿主不判失败种类」：原 classifyFailure + CODE_KIND（20+ 执行层
    // 错误码 → 业务种类的码表副本）整份删除——「这是权限问题/对象不存在/口径不对」是执行层
    // 的语义，宿主复制一份码表就是越界。新口径：只认宿主自己的协议/传输事实码，其余一律
    // 收敛通用档（executor_failed），由模型照着原始失败事实说人话。
    // 单次调用被传输超时截断（无回执）带的就是 result_unknown：码分支必须归 unknown_result
    // ——绝不能落 executor_failed（写操作可能已经生效，不能说「没办成」诱导用户重发）。
    expect(fallbackFailureKindOf('result_unknown')).toBe('unknown_result');
    expect(fallbackFailureKindOf('EXECUTION_PROTOCOL_VIOLATION')).toBe('host_fault');
    expect(fallbackFailureKindOf('CONFIRMATION_NOT_FOUND')).toBe('host_fault');
    // 曾经的 denied/not_found/invalid_input/needs_confirmation 分档依据（执行层业务码）一律通用档。
    for (const code of ['GATE_REFUSE', 'COLLECTION_NOT_FOUND', 'WHERE_INVALID', 'QUERY_REQUIRED', 'CONFIRMATION_REQUIRED', 'COLLECTION_FAULT', 'SOMETHING_NEW']) {
      expect(fallbackFailureKindOf(code), code).toBe('executor_failed');
    }
    // 无码（执行层没给码）同样通用档——不猜。
    expect(fallbackFailureKindOf(undefined)).toBe('executor_failed');
    expect(fallbackFailureKindOf('')).toBe('executor_failed');
  });

  it('② 我方故障码一律 host_fault：协议违约、句柄丢失都不向用户解释', () => {
    for (const code of ['EXECUTION_PROTOCOL_VIOLATION', 'CONFIRMATION_NOT_FOUND']) {
      expect(fallbackFailureKindOf(code), code).toBe('host_fault');
    }
    const message = failureMessageFor('host_fault');
    expect(message.text).toContain('没弄好');
    expect(message.text.length).toBeLessThanOrEqual(30);
    expect(message.actions.length).toBeGreaterThan(0);
    // 2026-11-24 收窄（如实登记）：曾经的「我方故障码」PROPOSAL_TOKEN_UNTRUSTED /
    // PROPOSAL_REFUSE 不再是宿主自认码（宿主不复制执行层码义）→ 落通用档；用户面同样
    // 不解释内部原因（通用句也没有），且不得出现「再试一次」（结论机已删，宿主不知道
    // 那笔是不是写、落没落）。
    for (const code of ['PROPOSAL_TOKEN_UNTRUSTED', 'PROPOSAL_REFUSE']) {
      expect(fallbackFailureKindOf(code), code).toBe('executor_failed');
    }
    const generic = failureMessageFor('executor_failed');
    expect(generic.text).not.toContain('再试一次');
    expect(internalTermIn(generic.text)).toBeUndefined();
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
    expect(failureMessageFor('denied', { subject: 'contract-archive 集合' }).text).toContain('contract-archive 集合');
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
      '报错文件 /home/dev/projects/x/y.ts',
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

  it('⑥ failed 的模型可见投影：失败事实原样进模型面（code + 机械清洗后 message），needs_confirmation 仍不含句柄', async () => {
    // 2026-11-24 owner 裁定（原形状的反转，如实登记）：failed/refused **原样进模型面**——
    // `{status, error:{code, message, retryable?}}`，message 只过 cleanExecutorDiagnostic 机械
    // 清洗（剥前置技术码 token / 服务器路径 / 机构自称「执行层→对方」，不判语义）。原「改写成
    // {status, kind, note}」是设计错误（kind 来自 classifyFailure 的码表副本、note 是替模型
    // 决定该知道什么），整份删除。人话归模型说；用户面的内部词泄漏由 internalTermIn 机械闸守
    // （模型面的用户级不变量见 wecom-sim W-04/W-10/W-11/W-12 与 I-4）。
    const failed = await workerVisibleOutcomeOf({
      status: 'failed',
      error: { code: 'COLLECTION_FAULT', message: 'gateway crashed with exit 2 (internal executor fault)', retryable: false },
    });
    expect(failed).toEqual({
      status: 'failed',
      error: { code: 'COLLECTION_FAULT', message: 'gateway crashed with exit 2 (internal executor fault)', retryable: false },
    });
    // 未知码同样原样给模型（不再收敛成 kind；宿主不判「这是什么失败」）。
    const unknown = await workerVisibleOutcomeOf({
      status: 'failed',
      error: { code: 'SOMETHING_NEW_INTERNAL', message: 'internal stack overflow at adapter boundary' },
    });
    expect(unknown).toEqual({
      status: 'failed',
      error: { code: 'SOMETHING_NEW_INTERNAL', message: 'internal stack overflow at adapter boundary' },
    });
    // 机械清洗仍然生效：机构自称（执行层/执行端）在进模型面前被换成「对方」——替换，不判语义。
    const institutional = await workerVisibleOutcomeOf({
      status: 'failed',
      error: { code: 'GATEWAY_FAULT', message: '执行层内部错误：连接被重置' },
    });
    expect(institutional).toEqual({ status: 'failed', error: { code: 'GATEWAY_FAULT', message: '对方内部错误：连接被重置' } });
    // needs_confirmation 只给机械摘要与 data（sanity：写确认路径不受影响；句柄仍不进模型面）。
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

  it('⑥b refused 的模型可见投影：与 failed 同形（code + 清洗后 message），三条机械清理不变', async () => {
    // 行为变化登记（如实）：2026-11-19 起 refused note 固定为通用 deny 话术；2026-11-20 起
    // 「带差什么诊断的拒绝码」note = 清理后的业务诊断原文；2026-11-24 起整份 kind/note 形状
    // 删除——refused 与 failed 同形给事实。**技术码现在随事实一起进模型面**（原「码不下放」
    // 断言随之反转）；三条机械清理（前置码 token / 路径 / 机构自称）与诊断原文的如实转述不变。
    const binding = await workerVisibleOutcomeOf({
      status: 'refused',
      error: {
        code: 'CONFIRMATION_BINDING_MISMATCH',
        // 真实形状：适配器把整行 stderr 塞进 message（含前置码 token）；再加机构自称/路径。
        message: 'CONFIRMATION_BINDING_MISMATCH 执行层拒绝：prepared collection=alpha window=W1 count=3 records=3; got collection=alpha window=W1 count=3 records=0 (see /home/dev/.tmp/diag/x.json)',
        retryable: false,
      },
    });
    expect(binding).toMatchObject({ status: 'refused', error: { code: 'CONFIRMATION_BINDING_MISMATCH', retryable: false } });
    const message = (binding['error'] as { message?: string }).message ?? '';
    // 差什么：prepared/got 对比、records 结构名如实给模型（模型据此下一轮改对参数）。
    expect(message).toContain('prepared collection=alpha');
    expect(message).toContain('got collection=alpha');
    expect(message).toContain('records=3');
    expect(message).toContain('records=0');
    // 三条机械清理：前置码 token 去掉、机构自称换成「对方」、服务器路径剥掉。
    expect(message).not.toMatch(/^CONFIRMATION_/);
    expect(message).not.toContain('执行层');
    expect(message).not.toContain('执行端');
    expect(message).not.toContain('/home/dev/.tmp');

    // 门拒（GATE_REFUSE）：与 failed 同形给事实（code + 清洗后 message）——英文原文与结构名
    // 随事实给模型、由模型说人话；用户面的不变量由 wecom-sim W-11 钉住（「没权限」且无内部码）。
    const denied = await workerVisibleOutcomeOf({
      status: 'refused',
      error: { code: 'GATE_REFUSE', message: 'GATE_REFUSE missing confirmation credential --confirmation <handle>', retryable: false },
    });
    expect(denied).toEqual({
      status: 'refused',
      error: { code: 'GATE_REFUSE', message: 'missing confirmation credential --confirmation <handle>', retryable: false },
    });

    // failed 与 refused 同形（不再有「failed 永不携带诊断原文」的差别——宿主不挑事实）。
    const failedBinding = await workerVisibleOutcomeOf({
      status: 'failed',
      error: { code: 'CONFIRMATION_BINDING_MISMATCH', message: 'CONFIRMATION_BINDING_MISMATCH prepared a got b' },
    });
    expect(failedBinding).toEqual({
      status: 'failed',
      error: { code: 'CONFIRMATION_BINDING_MISMATCH', message: 'prepared a got b' },
    });
  });

  it('⑦ Worker 委派文本不含内部度量与机制细节（weight/est_seconds/估时/long_running 字样）', () => {
    // 2026-11-20 再收口：委派里曾带 weight/est_seconds/long_running——模型据此向用户承诺
    // 「单次估时约半小时」或复述内部机制。收口后委派只保留调用所需（name/label/参数名/
    // required/payload.schema）；long_running 的 accepted/wait 机制由宿主机械裁决，不进模型面。
    const manifest = {
      contractVersion: 3,
      operations: [
        { name: 'dummy.query', label: 'query records', args: [], weight: 2, estimatedSeconds: 10 },
        { name: 'dummy.commit', label: 'commit records', args: [{ name: '--collection', required: true, type: 'name' }], weight: 20, estimatedSeconds: 10 },
        { name: 'dummy.longtask', label: 'long', args: [], estimatedSeconds: 1800, long_running: true },
      ],
    } as Parameters<typeof renderWorkerDelegation>[0]['manifest'];
    const text = renderWorkerDelegation({ task: '查一下 alpha', manifest });
    expect(text).not.toContain('"weight"');
    expect(text).not.toContain('"estimatedSeconds"');
    expect(text).not.toContain('1800');
    expect(text).not.toContain('估时');
    expect(text).not.toContain('重量');
    expect(text).not.toContain('"long_running"');
    expect(text).not.toContain('"type"');
    // 2026-11-24（O-6）：清单标题下那句成本陈述（「一次任务发起 N 次执行…控制执行次数」）
    // 整句删除——模型只拿选操作/填参数所需，执行次数归宿主资源边界。复活即红。
    expect(text).not.toContain('一次任务发起 N 次执行');
    expect(text).not.toContain('控制执行次数');
    // 调用所需仍在：operation 名、业务参数名（去 `--` 前缀）、required、输入形状。
    expect(text).toContain('"dummy.commit"');
    expect(text).toContain('"collection"');
    expect(text).not.toContain('"--collection"');
    expect(text).toContain('"required": true');
  });
});
