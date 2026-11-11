// [L4 集成] 任务生命周期可靠性（T10）：结果对账 + 停滞冻结 + 冻结后续跑。
/**
 * 离线全链 e2e：T10 四段里的段1/段2（段3/段4 由既有钉子 turn-loop-worker-timeout
 * 的 WT-1/WT-2 保护，本文件不复制也不修改它们）。
 *
 * 段1（声明 N，验到 N）：执行层计划声明写/上传 N 个对象；执行后宿主从执行层状态
 * **独立读**实际数，不足 N 即失败并留痕。语料 = 真实踩过的坑：命令走成 query 模式、
 * 写标志漏传不报错、空跑十分钟退出码仍 0、零落盘——worker 自述成功，执行层状态为零。
 *
 * 段2（停滞检测）：宿主独立读的结果指标在 T 时间内不变、worker 没报错也没到截止
 * → 判假死并冻结计划；不杀进程、不盲目重跑。检测只吃执行层状态读数，worker 自报
 * 的进度帧不参与判定（它不可能知道自己在假死）。
 *
 * 替身边界（与 harness 同哲学，只假模型与执行器）：
 *   · Main/worker 驱动是脚本化替身；runtime 回合契约、ContextTaskRunner、SQLite 底账、
 *     计划门全是生产代码；
 *   · 执行层结果面（TaskResultPort）由本文件的适配器实现：声明读自执行层的计划状态
 *     文件，观测读自执行层的持久化状态文件——两份都不是 worker 的返回文本；
 *   · worker 替身按脚本"真落盘 0 个或 N 个对象"，返回文本故意可以撒谎，用来证明宿主
 *     不拿它当判据。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ResultContractDeclaration,
  type TaskResultPort,
  type TaskResultScope,
} from '../../packages/agent/src/result-contract';
import { boot, mainDriver, type Boot } from './harness';

const PRINCIPAL = 'wecom:e2e_user';
const SESSION = 'wecom:e2e_user';

const WRITE_ASK = '把这两笔录入到幻辰财税';
const CONTINUE_ASK = '继续';

/** worker 自述（可以撒谎）：段1 的红就是"worker 这么说、执行层状态不是这样"。 */
const WORKER_CLAIM = '本轮已处理完成，共保存 2 个对象。';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 执行层结果面的测试适配器：两份事实都读执行层自己的状态文件。
 *   · plan.json  = 计划声明（claimsWrite / 指标 / 期望数），worker 开工时写入；
 *   · state.json = 持久化状态（objects 数组），只有"真落盘"才会增长。
 * worker 的返回文本不参与这里任何一步。
 */
function fileResultPort(rootRef: { value: string }): TaskResultPort {
  const dirOf = (scope: TaskResultScope): string => path.join(rootRef.value, 'tmp', scope.taskId);
  const readJson = (file: string): unknown => {
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  };
  return {
    declare: async (scope) => {
      const raw = readJson(path.join(dirOf(scope), 'plan.json')) as ResultContractDeclaration | null;
      return raw;
    },
    observe: async (scope) => {
      const state = readJson(path.join(dirOf(scope), 'state.json')) as { objects?: unknown[] } | null;
      return [{ metric: 'objects', actual: Array.isArray(state?.objects) ? state.objects.length : 0 }];
    },
  };
}

interface LivenessWorkerStep {
  /** 执行层计划声明；缺省 = 本步没有可对账的声明。 */
  declaration?: ResultContractDeclaration;
  /** 本步"真落盘"的对象数（追加进 state.json）；缺省 0 = 一个都没落。 */
  persisted?: number;
  /** 返回给宿主的自述文本（可以撒谎）。 */
  text: string;
  /** 假死时长：期间只发 worker 自报进度帧，指标不动，最后照常返回。 */
  stallMs?: number;
}

interface WorkerRunObservation {
  signalAbortedAtReturn: boolean;
  messages: Array<{ role: string; content: unknown }>;
  onStepFrames: number;
}

/**
 * 脚本化 worker 替身：按步"写计划声明 → 真落盘/不落盘 → 返回自述"。
 * stall 步复刻假死形状：worker 一直发 onStep（自报有进展），但执行层状态一动不动，
 * 直到 stallMs 之后才返回——宿主必须在这之前判假死。
 */
function scriptedLivenessWorker(
  steps: LivenessWorkerStep[],
  options: { rootRef: { value: string }; progressFrames?: number },
) {
  const runs: WorkerRunObservation[] = [];
  let cursor = 0;
  return {
    runs,
    driver: {
      run: async (input: {
        sessionId?: string;
        messages: Array<{ role: string; content: unknown }>;
        signal?: AbortSignal;
        onStep?: (text: string) => void;
      }) => {
        const taskId = input.sessionId ?? 'task_unknown';
        const dir = path.join(options.rootRef.value, 'tmp', taskId);
        mkdirSync(dir, { recursive: true });
        const step = steps[Math.min(cursor, steps.length - 1)]!;
        cursor += 1;
        if (step.declaration) {
          writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(step.declaration));
        }
        const stateFile = path.join(dir, 'state.json');
        if (step.persisted && step.persisted > 0) {
          const state = existsSync(stateFile)
            ? JSON.parse(readFileSync(stateFile, 'utf8')) as { objects?: unknown[] }
            : { objects: [] };
          const objects = Array.isArray(state.objects) ? state.objects : [];
          for (let index = 0; index < step.persisted; index += 1) objects.push({ id: `obj_${objects.length + 1}` });
          writeFileSync(stateFile, JSON.stringify({ objects }));
        }
        let onStepFrames = 0;
        if (step.stallMs && step.stallMs > 0) {
          const frames = options.progressFrames ?? 6;
          for (let index = 0; index < frames; index += 1) {
            input.onStep?.(`进度 ${index + 1}/${frames}`);
            onStepFrames += 1;
            await sleep(step.stallMs / frames);
          }
        }
        runs.push({
          signalAbortedAtReturn: input.signal?.aborted === true,
          messages: input.messages,
          onStepFrames,
        });
        return {
          text: step.text,
          execution: { planId: 'plan_liveness_e2e', version: 1, calls: 1 },
          messages: [...input.messages, { role: 'assistant', content: step.text, timestamp: Date.now() }],
        };
      },
    },
  };
}

/** 捕获宿主审计事件（JSON 行），与 turn-loop-worker-timeout 同手法。 */
function captureEvents(): { events: Array<Record<string, unknown>>; restore: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const original = console.info;
  console.info = (line: string) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed['event'] === 'string') events.push(parsed);
    } catch { /* 非 JSON 行 */ }
  };
  return { events, restore: () => { console.info = original; } };
}

async function platformTasksOf(booted: Boot) {
  return booted.assembly.store.platformTasks!.listBySession(PRINCIPAL, SESSION);
}

/** 停滞后继续：两个回合的 Main 替身；第二回合从底账取 taskId 填 continueTaskId。 */
function resumeAfterFreezeMainDriver(taskIdBox: { value: string }) {
  let turn = 0;
  return {
    run: async (input: {
      tools: unknown[];
      messages: unknown[];
      exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      turn += 1;
      if (input.tools.length === 0) return { text: '已整理完成。', messages: input.messages };
      const transcript: unknown[] = [...input.messages];
      const callId = `call_resume_${turn}`;
      const declaration: Record<string, unknown> = turn === 1
        ? { kind: 'delegate', request: WRITE_ASK }
        : { kind: 'delegate', request: `${WRITE_ASK}（续跑）`, continueTaskId: taskIdBox.value };
      transcript.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: callId, name: 'route_current_turn', arguments: declaration }],
        timestamp: Date.now(),
      } as never);
      try {
        const outcome = await input.exec('route_current_turn', declaration);
        transcript.push({
          role: 'toolResult',
          toolCallId: callId,
          toolName: 'route_current_turn',
          content: [{ type: 'text', text: JSON.stringify(outcome) }],
          timestamp: Date.now(),
        } as never);
        return { text: '主 Agent 自由文本：不应外发', messages: transcript };
      } catch (error) {
        transcript.push({
          role: 'toolResult',
          toolCallId: callId,
          toolName: 'route_current_turn',
          content: [{ type: 'text', text: (error as Error).message }],
          timestamp: Date.now(),
        } as never);
        return { text: (error as Error).message, messages: transcript };
      }
    },
  };
}

/**
 * 冻结计划：Main 替身在第一步假死失败后**继续申报第二步**（模拟模型不认终止语义、
 * 想接着拆解）。宿主必须拒绝派发第二步（worker 只跑一次），这就是"冻结计划"。
 */
function twoStepAfterFreezeMainDriver() {
  let cursor = 0;
  return {
    run: async (input: {
      tools: unknown[];
      messages: unknown[];
      exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      if (input.tools.length === 0) return { text: '已整理完成。', messages: input.messages };
      const transcript: unknown[] = [...input.messages];
      let lastError = '';
      for (let step = 1; step <= 2; step += 1) {
        const declaration = { kind: 'delegate', request: `第${step}/2步：录入幻辰财税` };
        const callId = `call_step_${cursor}`;
        cursor += 1;
        transcript.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: callId, name: 'route_current_turn', arguments: declaration }],
          timestamp: Date.now(),
        } as never);
        try {
          const outcome = await input.exec('route_current_turn', declaration);
          transcript.push({
            role: 'toolResult',
            toolCallId: callId,
            toolName: 'route_current_turn',
            content: [{ type: 'text', text: JSON.stringify(outcome) }],
            timestamp: Date.now(),
          } as never);
        } catch (error) {
          lastError = (error as Error).message;
          transcript.push({
            role: 'toolResult',
            toolCallId: callId,
            toolName: 'route_current_turn',
            content: [{ type: 'text', text: lastError }],
            timestamp: Date.now(),
          } as never);
        }
      }
      return { text: lastError, messages: transcript };
    },
  };
}

const STAGNATION: { sampleIntervalMs: number; unchangedForMs: number; metric: string } = {
  sampleIntervalMs: 15,
  unchangedForMs: 60,
  metric: 'objects',
};

describe('[L4 集成] T10 段1：计划声明 N，宿主独立验到 N（结果对账）', () => {
  it('TL1-1 声明写 2、执行层状态零落盘（query 模式空跑）→ 判失败并留痕，worker 自述不上屏', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 0,
        text: WORKER_CLAIM,
      },
    ], { rootRef });
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: mainDriver([{ kind: 'delegate', request: WRITE_ASK }]),
        worker: worker.driver as never,
        taskResults: fileResultPort(rootRef),
      });
      rootRef.value = booted.assembly.platformRoot!;

      const reply = await booted.send(WRITE_ASK);

      // ① 用户看到的是宿主按两份事实合成的话术：声明 2、独立读回 0，不是 worker 的自述
      expect(reply).toContain('结果未核实');
      expect(reply).toContain('声明 2 个');
      expect(reply).toContain('实际 0 个');
      expect(reply).not.toContain(WORKER_CLAIM);
      expect(reply).not.toContain('已处理完成');

      // ② 留痕：结构化对账事件带声明值/读回值/差额
      const shortfall = audit.events.find((event) => event['event'] === 'result_contract_shortfall');
      expect(shortfall).toBeDefined();
      expect(shortfall!['verdict']).toBe('shortfall');
      expect(shortfall!['reason']).toBe('below_declared');
      expect(shortfall!['shortfalls']).toEqual([
        { metric: 'objects', expected: 2, actual: 0, missing: 2 },
      ]);
      const span = audit.events.find((event) => event['event'] === 'delegation_span');
      expect(span?.['outcome']).toBe('result_shortfall');

      // ③ 任务条目：failed（不记为完成），worker 转录照常保留（可续跑）
      const records = await platformTasksOf(booted);
      expect(records).toHaveLength(1);
      expect(records[0]!.outcome).toBe('failed');
      expect(JSON.stringify(records[0]!.workerMessages)).toContain(WORKER_CLAIM);
    } finally {
      audit.restore();
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });

  it('TL1-2 声明 2、执行层状态真落盘 2 → 通过，worker 结果照常上屏（不误杀）', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 2,
        text: '已完成：两笔都已录入。',
      },
    ], { rootRef });
    let booted: Boot | null = null;
    try {
      booted = await boot({ main: mainDriver([{ kind: 'delegate', request: WRITE_ASK }]), worker: worker.driver as never, taskResults: fileResultPort(rootRef) });
      rootRef.value = booted.assembly.platformRoot!;
      const reply = await booted.send(WRITE_ASK);
      expect(reply).toContain('已完成：两笔都已录入。');
      const records = await platformTasksOf(booted);
      expect(records).toHaveLength(1);
      expect(records[0]!.outcome).toBe('done');
    } finally {
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });

  it('TL1-3 判据不是 worker 的话：worker 自述"零落盘"但执行层状态有 2 个 → 通过', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 2,
        text: '我不确定是否保存成功。',
      },
    ], { rootRef });
    let booted: Boot | null = null;
    try {
      booted = await boot({ main: mainDriver([{ kind: 'delegate', request: WRITE_ASK }]), worker: worker.driver as never, taskResults: fileResultPort(rootRef) });
      rootRef.value = booted.assembly.platformRoot!;
      const reply = await booted.send(WRITE_ASK);
      expect(reply).toContain('我不确定是否保存成功。');
    } finally {
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });

  it('TL1-4 声称写却声明不出可读指标 → 计划形状缺陷，判失败并留痕（不许用 worker 的话凑）', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [] },
        persisted: 0,
        text: WORKER_CLAIM,
      },
    ], { rootRef });
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({ main: mainDriver([{ kind: 'delegate', request: WRITE_ASK }]), worker: worker.driver as never, taskResults: fileResultPort(rootRef) });
      rootRef.value = booted.assembly.platformRoot!;
      const reply = await booted.send(WRITE_ASK);
      expect(reply).toContain('结果无法核实');
      expect(reply).not.toContain(WORKER_CLAIM);
      const defect = audit.events.find((event) => event['event'] === 'result_contract_shortfall');
      expect(defect?.['verdict']).toBe('shape_defect');
      expect(defect!['reason']).toBe('no_readable_metric');
      const records = await platformTasksOf(booted);
      expect(records[0]!.outcome).toBe('failed');
    } finally {
      audit.restore();
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });

  it('TL1-5 只读步（计划未声称写）不参与对账，零落盘也不误杀', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      { declaration: { claimsWrite: false, metrics: [] }, persisted: 0, text: '查询完成：余额为 0。' },
    ], { rootRef });
    let booted: Boot | null = null;
    try {
      booted = await boot({ main: mainDriver([{ kind: 'delegate', request: '查一下余额' }]), worker: worker.driver as never, taskResults: fileResultPort(rootRef) });
      rootRef.value = booted.assembly.platformRoot!;
      const reply = await booted.send('查一下余额');
      expect(reply).toContain('查询完成：余额为 0。');
    } finally {
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });
});

describe('[L4 集成] T10 段2：停滞检测（宿主独立读的指标不动 → 假死冻结）', () => {
  it('TL2-1 指标不变、worker 没报错也没到截止 → 判假死并冻结；不杀进程、不重跑、留部分转录', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 1,
        text: WORKER_CLAIM,
        stallMs: 400,
      },
    ], { rootRef, progressFrames: 8 });
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: mainDriver([{ kind: 'delegate', request: WRITE_ASK }]),
        worker: worker.driver as never,
        taskResults: fileResultPort(rootRef),
        stagnation: STAGNATION,
      });
      rootRef.value = booted.assembly.platformRoot!;
      const reply = await booted.send(WRITE_ASK);

      // ① 判假死：审计事件带指标、最后值、不变时长；worker 自报的进度帧不改变判定
      const stalled = audit.events.find((event) => event['event'] === 'task_stalled');
      expect(stalled).toBeDefined();
      expect(stalled!['metric']).toBe('objects');
      expect(stalled!['lastValue']).toBe(1);
      expect(Number(stalled!['unchangedForMs'])).toBeGreaterThanOrEqual(STAGNATION.unchangedForMs);

      // ② 冻结而不是杀进程：worker 自己发过进度帧、跑到自然结束，signal 未被中止
      expect(worker.runs).toHaveLength(1);
      expect(worker.runs[0]!.onStepFrames).toBe(8);
      expect(worker.runs[0]!.signalAbortedAtReturn).toBe(false);
      const span = audit.events.find((event) => event['event'] === 'delegation_span');
      expect(span?.['outcome']).toBe('stalled');

      // ③ 用户看到的是暂停话术（不是 worker 的成功自述，也不是空回复兜底）
      expect(reply).toContain('任务已暂停');
      expect(reply).toContain('继续');
      expect(reply).not.toContain(WORKER_CLAIM);
      expect(reply).not.toContain('查询失败');

      // ④ 留部分转录：任务条目标 needs（可续跑），workerMessages 带断点内容
      const records = await platformTasksOf(booted);
      expect(records).toHaveLength(1);
      expect(records[0]!.outcome).toBe('needs');
      expect(JSON.stringify(records[0]!.workerMessages)).toContain(WORKER_CLAIM);

      // ⑤ 不盲目重跑：worker 只被调用一次（冻结期间没有第二次派发）
      expect(worker.runs).toHaveLength(1);
    } finally {
      audit.restore();
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });

  it('TL2-2 指标一路推进 → 不判假死，worker 结果照常上屏', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 2,
        stallMs: 150,
        text: '已完成：两笔都已录入。',
      },
    ], { rootRef, progressFrames: 3 });
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      // 指标在停滞前就达到声明值：不触发停滞判定
      booted = await boot({
        main: mainDriver([{ kind: 'delegate', request: WRITE_ASK }]),
        worker: worker.driver as never,
        taskResults: fileResultPort(rootRef),
        stagnation: { ...STAGNATION, unchangedForMs: 500 },
      });
      rootRef.value = booted.assembly.platformRoot!;
      const reply = await booted.send(WRITE_ASK);
      expect(reply).toContain('已完成：两笔都已录入。');
      expect(audit.events.find((event) => event['event'] === 'task_stalled')).toBeUndefined();
    } finally {
      audit.restore();
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });

  it('TL2-3 冻结计划：第一步假死后，同一回合再申报第二步也不会派发 worker', async () => {
    const rootRef = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 1,
        text: WORKER_CLAIM,
        stallMs: 400,
      },
    ], { rootRef, progressFrames: 6 });
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: twoStepAfterFreezeMainDriver(),
        worker: worker.driver as never,
        taskResults: fileResultPort(rootRef),
        stagnation: STAGNATION,
      });
      rootRef.value = booted.assembly.platformRoot!;
      const reply = await booted.send(WRITE_ASK);

      // 计划被冻结：第二步没有派发，worker 只跑了一次
      expect(worker.runs).toHaveLength(1);
      expect(audit.events.find((event) => event['event'] === 'task_plan_frozen_refused')).toBeDefined();
      expect(reply).toContain('任务已暂停');
    } finally {
      audit.restore();
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });
});

describe('[L4 集成] T10 段3：冻结后续跑（同一 taskId 从持久化断点继续）', () => {
  it('TL3-1 假死冻结后下一回合带 continueTaskId：不新开任务、不从零重付，终态 done', async () => {
    const rootRef = { value: '' };
    const taskIdBox = { value: '' };
    const worker = scriptedLivenessWorker([
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 1,
        text: '（部分转录）已录入 1 笔，另 1 笔待处理。',
        stallMs: 400,
      },
      {
        declaration: { claimsWrite: true, metrics: [{ metric: 'objects', expected: 2 }] },
        persisted: 1,
        text: '两笔都已录入完成。',
      },
    ], { rootRef, progressFrames: 6 });
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: resumeAfterFreezeMainDriver(taskIdBox),
        worker: worker.driver as never,
        taskResults: fileResultPort(rootRef),
        stagnation: STAGNATION,
      });
      rootRef.value = booted.assembly.platformRoot!;

      const first = await booted.send(WRITE_ASK);
      expect(first).toContain('任务已暂停');
      const frozenRecords = await platformTasksOf(booted);
      expect(frozenRecords).toHaveLength(1);
      expect(frozenRecords[0]!.outcome).toBe('needs');
      taskIdBox.value = frozenRecords[0]!.taskId;

      const second = await booted.send(CONTINUE_ASK);
      expect(second).toContain('两笔都已录入完成。');

      // ① 同一 taskId 续跑：底账仍只有一条，终态从 needs 推到 done
      const records = await platformTasksOf(booted);
      expect(records).toHaveLength(1);
      expect(records[0]!.taskId).toBe(taskIdBox.value);
      expect(records[0]!.outcome).toBe('done');

      // ② 不从零重付：第二个 worker 收到的转录里有第一回合的请求与部分转录
      const resumed = worker.runs[1];
      expect(resumed).toBeDefined();
      expect(JSON.stringify(resumed!.messages)).toContain(WRITE_ASK);
      expect(JSON.stringify(resumed!.messages)).toContain('（部分转录）已录入 1 笔，另 1 笔待处理。');
    } finally {
      if (booted) await booted.assembly.close();
      if (rootRef.value) rmSync(path.join(rootRef.value, 'tmp'), { recursive: true, force: true });
    }
  });
});
