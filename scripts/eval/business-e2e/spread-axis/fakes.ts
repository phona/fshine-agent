/**
 * D 轴确定性假件（smoke / 自测用；零模型、零网络）。
 *
 * 注入面 = `createDsExecutor` 的 createDrivers/createExecutionFace 覆盖（与既有
 * experiments 自测同法）：装配/证据/分级代码路径逐字不变，只换驱动与执行面。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../../../packages/agent/src/driver-contract';
import { createDsExecutor, type DsExecutor } from './executor';
import type { DsCase } from './cases';

export const FAKE_ENV = { LLM_API_KEY: 'test-placeholder', LLM_MODEL: 'test-model', LLM_API_BASE_URL: 'http://127.0.0.1:9' };

export function fakeManifest(): CapabilityManifest {
  return {
    contractVersion: 1,
    operations: [
      { name: 'dummy.query', label: 'query', args: [{ name: '--collection', required: true }, { name: '--window', required: false }] },
    ],
  };
}

export class FakeClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> { return fakeManifest(); }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const callArgs = request.args as { collection?: unknown; '--collection'?: unknown } | undefined;
    const collection = callArgs?.collection ?? callArgs?.['--collection'];
    if (collection === 'contoso') {
      // 歧义集合 → needs_input（任务应落 waiting_user，可被确定性取消）。
      return {
        status: 'needs_input',
        missing: [{ name: 'collection', description: 'contoso 命中多个集合，需要选定一个' }],
        data: { candidates: [{ name: 'contoso-trade' }, { name: 'contoso-logistics' }] },
        error: { code: 'COLLECTION_AMBIGUOUS', message: 'ambiguous' },
      };
    }
    if (collection === 'faulty-one') {
      // 读取故障（不可重试；smoke 覆盖 D4 失败面）。
      return { status: 'failed', error: { code: 'COLLECTION_FAULT', message: 'cannot be read in its current state' } };
    }
    return { status: 'completed', data: { collection: String(collection ?? 'fake'), window: null, items: [], count: 0 } };
  }
}

export function fakeExecutionFace(): { client: ExecutionClient; allowedOperations: readonly string[]; readOnlyOperations: readonly string[] } {
  return { client: new FakeClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] };
}

function textMessage(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'llm', model: 'fake', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2 }, stopReason: 'stop', timestamp: Date.now() } as unknown as AgentMessage;
}

/** 脚本化 Main/Worker（smoke 用：DS-1 两对象核对；DS-2 故障+口语窗口；DS-3 受理/取消/列状态）。 */
export function createSmokeExecutor(caseDef: DsCase): DsExecutor {
  const workerQueries =
    caseDef.id === 'DS-3' ? ['alpha W1', 'beta W1', 'contoso']
      : caseDef.id === 'DS-2' ? ['alpha W1', 'faulty-one W1', 'documents']
        : ['alpha W1', 'beta W1'];
  let workerSeq = 0;
  const workerDriver: TurnDriver = {
    async run(input) {
      const target = workerQueries[Math.min(workerSeq, workerQueries.length - 1)]!;
      workerSeq += 1;
      const [collection, window] = target.includes(' ') ? target.split(' ') : [target, undefined];
      // 夹具走内部 exec 路由（execute_operation 兼容入口），不借 op_* 工具面透传参数包装。
      try {
        await input.exec('execute_operation', { operation: 'dummy.query', args: { collection, ...(window === undefined ? {} : { window }) } });
      } catch { /* smoke 假件：错误由 reply 面表达 */ }
      return { text: '查询完成', messages: [...input.messages, textMessage('查询完成')] };
    },
  };
  let turn = 0;
  // 2026-11-20：数字 ref 退役——DS-3 分步用真实 taskId（从 task_run 回执里取）。
  const ds3TaskIds: string[] = [];
  const captureTaskId = (result: unknown): void => {
    const taskId = (result as { taskId?: unknown } | undefined)?.taskId;
    if (typeof taskId === 'string') ds3TaskIds.push(taskId);
  };
  const at = (index: number): Record<string, unknown> => ({ ref: ds3TaskIds[index] ?? '' });
  const mainDriver: TurnDriver = {
    async run(input) {
      turn += 1;
      const exec = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        try { return await input.exec(tool, args); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
      };
      if (caseDef.id === 'DS-3') {
        if (turn === 1) {
          captureTaskId(await exec('task_run', { task: '核对 alpha W1' }));
          captureTaskId(await exec('task_run', { task: '核对 beta W1' }));
          captureTaskId(await exec('task_run', { task: '整理 contoso 的窗口' }));
        } else if (turn === 2) {
          await exec('task_status', {});
          await exec('task_cancel', at(2)); // 第三个任务（contoso waiting）→ 取消
          await exec('task_result', at(0));
          await exec('task_result', at(1));
        } else {
          await exec('task_status', {});
        }
        return { text: '已按你说的办了。', messages: [...input.messages, textMessage('已按你说的办了。')] };
      }
      if (caseDef.id === 'DS-2') {
        if (turn === 1) {
          await exec('task_run', { task: '核对 alpha W1' });
          await exec('task_run', { task: '核对 faulty-one W1' });
        } else if (turn === 2) {
          await exec('task_run', { task: '看 documents 上个月' });
        }
        return { text: '已按你说的办了。', messages: [...input.messages, textMessage('已按你说的办了。')] };
      }
      if (turn === 1) await exec('task_run', { task: '核对 alpha W1' });
      if (turn === 2) await exec('task_run', { task: '核对 beta W1' });
      return { text: '核对结论已整理。', messages: [...input.messages, textMessage('核对结论已整理。')] };
    },
  };
  return createDsExecutor({
    createDrivers: () => ({ mainDriver, workerDriver }),
    createExecutionFace: async () => fakeExecutionFace(),
    env: FAKE_ENV,
  });
}
