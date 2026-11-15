/**
 * 阶段 D 假执行层：仓内 dummy 平台（既有资产） + 一个可计数的非幂等 `create_record`
 * + 可选 window 故障注入。
 *
 * 不触网、不碰真实平台；所有副作用只落在本样本 `.runtime/pi152-stageD/.../state`。
 * 这里只做执行层语义（completed/failed），不做宿主治理。
 */
import path from 'node:path';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createDummyCliClient, type DummyCliClient } from '../../../packages/agent/src/dummy-cli-client';

export const CREATE_RECORD_OPERATION = 'create_record';

export interface ExecCallLog {
  at: number;
  operation: string;
  args: Record<string, unknown>;
  status: ExecutionOutcome['status'];
  requestId: string;
  duplicateOf?: string;
  note?: string;
}

export interface StageDClientOptions {
  profileRoot: string;
  gateway: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  /** 该 window 的查询确定性失败（故障注入）；其余正常。 */
  faultWindow?: string;
}

export interface StageDClient extends ExecutionClient {
  calls(): readonly ExecCallLog[];
  /** 非幂等 create_record 的同一 id 执行次数。 */
  createCounts(): Readonly<Record<string, number>>;
}

function sameArgs(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createStageDClient(options: StageDClientOptions): StageDClient {
  const dummy: DummyCliClient = createDummyCliClient({
    root: options.profileRoot,
    gateway: options.gateway,
    stateDir: options.stateDir,
    env: options.env,
  });
  const log: ExecCallLog[] = [];
  const createCounts = new Map<string, number>();
  let sequence = 0;

  async function capabilities(): Promise<CapabilityManifest> {
    const manifest = await dummy.capabilities();
    const already = manifest.operations.some((operation) => operation.name === CREATE_RECORD_OPERATION);
    if (already) return manifest;
    return {
      contractVersion: manifest.contractVersion,
      operations: [
        ...manifest.operations,
        {
          name: CREATE_RECORD_OPERATION,
          label: '登记记录（非幂等）',
          args: [
            { name: '--id', required: true },
            { name: '--summary', required: false },
          ],
        },
      ],
    };
  }

  async function execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const args = request.args as Record<string, unknown>;
    const at = Date.now();
    if (request.operation === CREATE_RECORD_OPERATION) {
      const id = String(args['id'] ?? args['--id'] ?? '');
      const previous = log.find((call) => call.operation === request.operation && sameArgs(call.args, args));
      sequence += 1;
      const count = (createCounts.get(id) ?? 0) + 1;
      createCounts.set(id, count);
      const outcome: ExecutionOutcome = {
        status: 'completed',
        data: { id, seq: sequence, createCount: count, registeredAt: new Date(at).toISOString() },
      };
      log.push({
        at, operation: request.operation, args, status: outcome.status, requestId: request.requestId,
        ...(previous === undefined ? {} : { duplicateOf: previous.requestId }),
        note: '非幂等登记：同一 id 每次调用都会新增记录（不自动去重）',
      });
      return outcome;
    }

    const window = typeof args['window'] === 'string' ? args['window'] : undefined;
    if (options.faultWindow !== undefined && window === options.faultWindow) {
      const outcome: ExecutionOutcome = {
        status: 'failed',
        error: {
          code: 'INJECTED_FAULT',
          message: `执行层故障注入：window=${window} 的查询被确定性拒绝（本样本只验证隔离，不重试、不自动重放）`,
        },
      };
      log.push({ at, operation: request.operation, args, status: outcome.status, requestId: request.requestId, note: 'fault-injection' });
      return outcome;
    }

    const outcome = await dummy.execute(request);
    log.push({ at, operation: request.operation, args, status: outcome.status, requestId: request.requestId });
    return outcome;
  }

  return {
    capabilities,
    execute,
    calls: () => log,
    createCounts: () => Object.fromEntries(createCounts),
  };
}

/** 样本状态根（每个 principal 一个独立目录，避免 dummy 状态串台）。 */
export function stateDirFor(root: string, key: string): string {
  return path.join(root, 'state', key);
}
