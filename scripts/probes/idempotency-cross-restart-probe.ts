/**
 * 只读探针：跨重启重投是否被当成新回合再执行一次。
 *
 * 缺口与闭环判据登记：GitHub issue #68（原设计档 idempotency-cross-restart.md 2026-11-18 已删，git 历史可考）。
 *
 * 不触网、不碰真实模型、不碰真实平台、不改产品代码：
 *   · 用 server 的真实装配（createServer）与真实 handler 去重路径；
 *   · 注入脚本化 TurnDriver（每回合调用一次 run_js）与计数 RunJsExecutor（外部副作用替身）；
 *   · 同一进程重复投递同一 messageId = 正例（去重命中，零新执行）；
 *   · close 后同 dbPath 重建 server + 同 messageId 重投 = 反例（去重缓存已丢，整回合重跑）。
 *
 * 运行：TMPDIR="${TMPDIR:-$HOME/.tmp}" node --import tsx scripts/probes/idempotency-cross-restart-probe.ts
 * 证据只写临时目录，退出时删除；仓库工作区零写入。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { IncomingChannelMessage } from '@fshine/contracts';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import type { RunJsExecutor, RunJsInput, RunJsOutput } from '../../packages/agent/src/run-js-executor';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import { createServer } from '../../apps/server/server';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SAME_MESSAGE_ID = 'probe-msg-same-identity';
const SAME_TEXT = '把这份对账单整理后提交（同一条请求）';

interface EffectRecord {
  /** 第几次真实执行（跨两个“进程”共享的副作用计数器）。 */
  n: number;
  runId: string;
  code: string;
}

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:probe-user': { enabled: true },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
  };
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'probe.noop', label: 'probe noop', args: [] }],
};

const inertClient: ExecutionClient = {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  },
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  },
};

/** 计数执行器：每次真实 run_js 都进共享 effects（模拟外部副作用记录）。 */
function countingExecutor(effects: EffectRecord[]): RunJsExecutor {
  return {
    async runJs(input: RunJsInput): Promise<RunJsOutput> {
      const n = effects.length + 1;
      const runId = `run_probe_${n}`;
      effects.push({ n, runId, code: input.code });
      return {
        exitCode: 0,
        exitSignal: null,
        stdout: `effect-${n}`,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        outputs: [],
        audit: {
          runId,
          runDir: `/tmp/${runId}`,
          scriptSha256: 'probe',
          inputFileIds: [],
          materializedInputs: [],
          inputBytes: Buffer.byteLength(input.code, 'utf8'),
          outputs: [],
          skippedOutputs: [],
          exitCode: 0,
          exitSignal: null,
          durationMs: 1,
        },
      };
    },
  };
}

/** 脚本化 Main 驱动：每回合恰好调用一次 run_js（同 code），然后收尾。 */
function runJsDriver(): TurnDriver {
  return {
    async run(input) {
      await input.exec('run_js', { code: 'console.log("same-request-effect")' }, input.signal);
      return { text: '已处理。', messages: input.messages };
    },
  };
}

function incoming(messageId: string): IncomingChannelMessage {
  return {
    wecomUserId: 'probe-user',
    conversationId: 'probe-chat',
    messageId,
    text: SAME_TEXT,
    receivedAt: new Date().toISOString(),
  };
}

async function startServer(dbPath: string, stateDir: string, effects: EffectRecord[], logs: Array<Record<string, unknown>>) {
  return createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath,
    stateDir,
    createDrivers: async () => ({ mainDriver: runJsDriver(), workerDriver: runJsDriver() }),
    createExecutionFace: async () => ({
      client: inertClient,
      allowedOperations: ['probe.noop'],
      readOnlyOperations: ['probe.noop'],
    }),
    createRunJsExecutor: () => countingExecutor(effects),
    logger: (line) => logs.push(line),
  });
}

/**
 * 第二探针：持久化 outcome 存在，但重投没有「原来的身份」就够不着它。
 *   · 关库重开后，带 replayWindow 认领 → replayed（证明映射确实持久）；
 *   · 关库重开后，不带任何窗口/显式 dispatchKey（= 新回合的常态）→ minted 新身份（证明够不着）。
 */
function probeRegistryReachability(dir: string): Record<string, unknown> {
  const dbPath = path.join(dir, 'operations.db');
  const scopeKey = 'turn:wecom:probe-chat:1';
  const first = createSqliteTaskRegistry(dbPath);
  const minted = first.claimOperation({ scopeKey, operation: 'task_run', attempt: 1 });
  if (minted.kind !== 'minted') throw new Error('probe: first claim not minted');
  first.settleOperation(minted.dispatchKey, { status: 'completed', data: { taskId: 'task_probe_1' } });
  first.close();

  const withWindow = createSqliteTaskRegistry(dbPath);
  const replayed = withWindow.claimOperation({ scopeKey, operation: 'task_run', attempt: 1, replayWindow: 1 });
  withWindow.close();

  const withoutIdentity = createSqliteTaskRegistry(dbPath);
  const freshTurn = withoutIdentity.claimOperation({ scopeKey, operation: 'task_run', attempt: 1 });
  withoutIdentity.close();

  return {
    originalDispatchKey: minted.dispatchKey,
    outcomePersistedAcrossReopen: replayed.kind === 'replayed',
    replayWithWindow: replayed.kind,
    replayedDispatchKey: replayed.kind === 'replayed' ? replayed.dispatchKey : null,
    newTurnWithoutWindow: freshTurn.kind,
    newTurnDispatchKey: freshTurn.kind === 'minted' ? freshTurn.dispatchKey : null,
    conclusion:
      replayed.kind === 'replayed' && freshTurn.kind === 'minted'
        ? 'outcome 持久存在且可按原身份读回；新回合没有原身份 → 铸造新 key（重投够不着旧结果）'
        : '未复现：检查 registry 注入面',
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'idem-restart-probe-'));
  const dbPath = path.join(dir, 'state.db');
  const stateDir = path.join(dir, 'state');
  const effects: EffectRecord[] = [];
  const logs: Array<Record<string, unknown>> = [];
  try {
    // ── 进程 A ────────────────────────────────────────────────────────────────
    const serverA = await startServer(dbPath, stateDir, effects, logs);
    const firstReply = await serverA.handler(incoming(SAME_MESSAGE_ID));
    const afterFirst = effects.length;

    // 同进程同 messageId 重投：去重缓存命中，零新执行（正例）。
    const duplicateReply = await serverA.handler(incoming(SAME_MESSAGE_ID));
    const afterInProcessDuplicate = effects.length;

    const messageDoneBeforeRestart = logs.filter((line) => line['event'] === 'message_done').length;
    await serverA.close();

    // ── 进程 B（同 dbPath 重建 = 进程内“重启”）───────────────────────────────
    const serverB = await startServer(dbPath, stateDir, effects, logs);
    const afterRestartReply = await serverB.handler(incoming(SAME_MESSAGE_ID));
    const afterRestart = effects.length;
    await serverB.close();
    const messageDoneAfterRestart = logs.filter((line) => line['event'] === 'message_done').length;

    const replayed = logs.filter((line) => line['event'] === 'message_duplicate_replayed').length;
    const scenarioB = probeRegistryReachability(dir);
    console.log(JSON.stringify({
      probe: 'idempotency-cross-restart',
      scenarioA_messageRedelivery: {
        sameMessageId: SAME_MESSAGE_ID,
        sameTurnInProcess: {
          firstReply,
          duplicateReply,
          effectsAfterFirst: afterFirst,
          effectsAfterDuplicate: afterInProcessDuplicate,
          newEffectsFromDuplicate: afterInProcessDuplicate - afterFirst,
          duplicateReplayedEvents: replayed,
        },
        afterRestart: {
          reply: afterRestartReply,
          messageDoneEventsBeforeRestart: messageDoneBeforeRestart,
          messageDoneEventsAfterRestart: messageDoneAfterRestart,
          effectsBeforeRestart: afterInProcessDuplicate,
          effectsAfterRestartRedelivery: afterRestart,
          newEffectsFromRestartRedelivery: afterRestart - afterInProcessDuplicate,
          runIds: effects.map((effect) => effect.runId),
        },
        conclusion:
          afterInProcessDuplicate === afterFirst && afterRestart > afterInProcessDuplicate
            ? '重启后同一 messageId 重投：进程内去重缓存已丢，整回合再次执行（反例成立）'
            : '未复现：检查注入面',
      },
      scenarioB_persistedOutcomeReachability: scenarioB,
    }, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
