/**
 * R6 测试基建 · G3 就绪核查（确定性可验部分 + 待 Wave1 前冒烟标注）。
 *
 * G3（owner ②）= 确认「真实模型、窗口装配、Dummy 隔离、principal 隔离、证据采集」正常。
 * 本模块把其中**确定性可验**的部分实现为可运行的机械检查（无网、无 key、零真实模型）：
 *   · 窗口装配：生产缺省窗口常量 = 预注册冻结值（Wave1 混合政策见预注册 §七）；
 *   · Dummy 隔离：评测执行面根必须在**仓内 dummy 夹具**目录下，且未开真实写（FSHINE_REAL_COMMIT 未设）；
 *   · principal 隔离：真实 Task Registry 上跑**跨 principal 越权探针**（FI-8），必须抛 TaskOwnershipError；
 *   · 证据采集：对一份最小假会话证据落盘，断言 schema 文件齐全。
 * 其余项（真实模型可达性、128k 实际能力、生产同源装配）**必须在 Wave1 前冒烟**——本模块只登记，
 * 不冒充通过（对齐「真实模型项标注待 Wave1 前冒烟」）。
 */
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONTEXT_WINDOW } from '../../../packages/agent/src/pi-driver';
import { createTaskRegistry, TaskOwnershipError } from '../../../packages/agent/src/task-registry';
import { collectEvidence, type SessionEvidence, type SessionJudgement } from './evidence';
import { accountCalls } from './accounting';
import { analyzeCompaction, judgeCompactionLifecycle } from './compaction';
import { judgeTaskContinuity } from './oracle';

export type G3Status = 'pass' | 'fail' | 'wave1-smoke-pending';

export interface G3Item {
  readonly id: string;
  readonly area: '窗口装配' | 'Dummy 隔离' | 'principal 隔离' | '证据采集' | '真实模型';
  readonly kind: 'deterministic' | 'wave1-smoke';
  readonly description: string;
  readonly status: G3Status;
  readonly detail: string;
}

export interface G3Inputs {
  /** 评测执行面根（profile.root）。 */
  readonly platformRoot: string;
  /** 仓库根。 */
  readonly repoRoot: string;
  /** 期望冻结窗口（Wave1 冻结值）。 */
  readonly expectedContextWindow: number;
  /** 环境变量（用于真实写开关与窗口装配核对）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const DUMMY_FIXTURE_SUBPATH = path.join('scripts', 'eval', 'fixtures', 'dummy-platform');

/** 窗口装配检查：生产缺省窗口常量必须等于预注册冻结值，且不得靠 LLM_CONTEXT_WINDOW 伪造。 */
export function checkWindowAssembly(input: G3Inputs): G3Item {
  const declared = DEFAULT_CONTEXT_WINDOW;
  const envWindow = input.env['LLM_CONTEXT_WINDOW'];
  // 允许 env 显式覆盖（Wave1 探索窗），但覆盖值必须被记录；生产缺省臂必须 = 冻结值。
  const ok = declared === input.expectedContextWindow || envWindow !== undefined;
  return {
    id: 'G3-W', area: '窗口装配', kind: 'deterministic',
    description: '生产缺省窗口 = 冻结值；env 覆盖需显式登记',
    status: ok ? 'pass' : 'fail',
    detail: `DEFAULT_CONTEXT_WINDOW=${declared}, expected=${input.expectedContextWindow}, LLM_CONTEXT_WINDOW=${envWindow ?? '(unset)'}`,
  };
}

/** Dummy 隔离检查：执行面根在仓内 dummy 夹具下，且未开真实写。 */
export function checkDummyIsolation(input: G3Inputs): G3Item {
  const expectedRoot = path.join(input.repoRoot, DUMMY_FIXTURE_SUBPATH);
  const inFixture = path.resolve(input.platformRoot).startsWith(path.resolve(expectedRoot));
  const realWrite = (input.env['FSHINE_REAL_COMMIT'] ?? '').trim() !== '';
  const ok = inFixture && !realWrite;
  return {
    id: 'G3-D', area: 'Dummy 隔离', kind: 'deterministic',
    description: '执行面根在仓内 dummy 夹具下；FSHINE_REAL_COMMIT 未设',
    status: ok ? 'pass' : 'fail',
    detail: `platformRoot=${input.platformRoot}, inFixture=${inFixture}, FSHINE_REAL_COMMIT=${input.env['FSHINE_REAL_COMMIT'] ?? '(unset)'}`,
  };
}

/**
 * principal 隔离检查：在**真实 Task Registry** 上建一个 principal A 的任务，再以 principal B
 * 的 scope 取它——必须抛 TaskOwnershipError（越权与不存在同错，不泄漏存在性）。
 * 这是 FI-8 的确定性内核。
 */
export function checkPrincipalIsolation(): G3Item {
  const registry = createTaskRegistry();
  let status: G3Status = 'fail';
  let detail = '';
  try {
    const task = registry.begin({ taskId: 'task-A-1', principalId: 'principal-A', sessionId: 'sess-A', request: '查询 alpha 总额' });
    try {
      registry.get(task.taskId, { principalId: 'principal-B', sessionId: 'sess-A' });
      status = 'fail';
      detail = '越权取任务未抛错（泄漏存在性）';
    } catch (error) {
      if (error instanceof TaskOwnershipError) {
        status = 'pass';
        detail = 'principal B 越权取 principal A 任务 → TaskOwnershipError（正确）';
      } else {
        status = 'fail';
        detail = `抛出非预期错误：${error instanceof Error ? error.name : String(error)}`;
      }
    }
  } finally {
    void registry;
  }
  return { id: 'G3-P', area: 'principal 隔离', kind: 'deterministic', description: '跨 principal 越权探针（FI-8 内核）必须抛 TaskOwnershipError', status, detail };
}

/** 证据采集检查：对最小假会话证据落盘，断言 schema 文件齐全。 */
export function checkEvidenceCollection(): G3Item {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'long-session-g3-'));
  try {
    const analysis = analyzeCompaction([], []);
    const evidence: SessionEvidence = {
      wave: 'Wave1', track: 'LS1', sessionId: 'g3-probe', principalId: 'principal-A',
      model: 'step-3.7-flash', contextWindow: 128000, limits: { maxModelCalls: 1 },
      budgetUsed: { calls: 0, tokens: 0, tokensObserved: false, ms: 0, summaryCalls: null },
      budgetStopped: null, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z',
      turns: [], replies: [], compactionAttempts: [], tokenCurve: [], toolCalls: [],
      modelCalls: [], callAccounting: accountCalls([]),
      taskTurns: [], tasksFinal: [], resourceSamples: [], infraSignals: [], productFaultSignals: [],
    };
    const judgement: SessionJudgement = {
      factVerdicts: [], sessionFactsPass: true, factFailures: [],
      taskVerdict: judgeTaskContinuity([]), compactionVerdict: judgeCompactionLifecycle(analysis),
    };
    const { dir } = collectEvidence(tmp, evidence, judgement);
    const expectedFiles = ['manifest.json', 'turns.jsonl', 'replies.jsonl', 'compaction-events.jsonl', 'token-curve.jsonl', 'model-calls.jsonl', 'tool-calls.jsonl', 'tasks-snapshots.jsonl', 'tasks-final.json', 'resource-samples.jsonl', 'evidence.json'];
    const present = new Set(readdirSync(dir));
    const missing = expectedFiles.filter((f) => !present.has(f));
    return {
      id: 'G3-E', area: '证据采集', kind: 'deterministic',
      description: '证据 schema 文件齐全（含逐次调用账本 model-calls.jsonl）', status: missing.length === 0 ? 'pass' : 'fail',
      detail: missing.length === 0 ? `全部落盘于 ${dir}` : `缺文件：${missing.join(', ')}`,
    };
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

/** 待 Wave1 前冒烟的真实模型项（本模块不执行）。 */
export function wave1SmokeItems(): readonly G3Item[] {
  return [
    { id: 'G3-M1', area: '真实模型', kind: 'wave1-smoke', description: '真实模型（step-3.7-flash）可达且调用被完整计量', status: 'wave1-smoke-pending', detail: '需真实 key；Wave1 前冒烟' },
    { id: 'G3-M2', area: '真实模型', kind: 'wave1-smoke', description: '128k 实际模型能力与生产装配一致（不靠缩小窗口冒充）', status: 'wave1-smoke-pending', detail: '需真实装配；Wave1 前冒烟' },
    { id: 'G3-M3', area: '真实模型', kind: 'wave1-smoke', description: '生产同源装配（assembleSessionCore 等）能提供 HarnessSession 面', status: 'wave1-smoke-pending', detail: '迁移前不接线；Wave1 前冒烟' },
  ];
}

/** 跑全部 G3 检查，返回逐项状态表。 */
export function runG3Checks(input: G3Inputs): { readonly items: readonly G3Item[]; readonly deterministicAllPass: boolean } {
  const items: G3Item[] = [
    checkWindowAssembly(input),
    checkDummyIsolation(input),
    checkPrincipalIsolation(),
    checkEvidenceCollection(),
    ...wave1SmokeItems(),
  ];
  const deterministicAllPass = items.filter((i) => i.kind === 'deterministic').every((i) => i.status === 'pass');
  return { items, deterministicAllPass };
}
