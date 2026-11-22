/**
 * 真模型写闭环验收脚本的绊线（`scripts/eval/real/write-loop.ts`）。
 *
 * 三道锁（全部不跑模型、不触网）：
 *   ① 纯函数单测：参数解析、判据评估（正例全绿 + 逐条反向破坏必红）、观察提取、
 *      执行层证据读取（audit.jsonl / confirmations.json）；
 *   ② 记录包装器语义：透传不改（结果原样返回、错误原样上抛）、工具调用与唤醒出口入账；
 *   ③ 子进程前置门：缺模型配置时**如实 exit 2 且不落回脚本模型**；--help 走帮助分支。
 *
 * 反向绊线（亲跑验证）：把 evaluateCriteria 里任一条判据的比较放宽（例如 C6 只比
 * status 不比 count），下面「逐条反向破坏」用例立刻红。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TurnDriver, TurnDriverInput } from '../../../packages/agent/src/driver-contract';
import {
  LedgerWatcher,
  chineseNumeral,
  countTokenHit,
  evaluateCriteria,
  evaluateObservations,
  parseWriteLoopArgs,
  readAuditRows,
  readConfirmationFacts,
  recordingDriver,
  type WriteLoopEvidence,
} from './write-loop';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = 'scripts/eval/real/write-loop.ts';

const PROPOSAL_SUMMARY = '将向集合「empty-one」的 W1 窗口新增记录：共 4 条：item-1=100、item-2=100、item-3=100、item-4=100；此操作不可撤销，需在 11月19日 19:30（北京时间）前确认。';

/** 全绿样例证据（改一处即对应一条判据红）。 */
function greenEvidence(): WriteLoopEvidence {
  return {
    turns: [
      { index: 1, userText: '写入 4 条', reply: '等你确认。', durationMs: 12_000 },
      { index: 2, userText: '确认', reply: '已提交。', durationMs: 3_000 },
    ],
    toolCalls: [
      { seq: 1, agent: 'main', turn: 1, tool: 'task_run', args: '{"task":"新增4条"}', ok: true, summary: 'waiting_user', elapsedMs: 8_100 },
      { seq: 2, agent: 'worker', turn: 1, tool: 'execute_operation', args: '{"operation":"dummy.prepare"}', ok: true, summary: 'needs_confirmation', elapsedMs: 120 },
      { seq: 3, agent: 'main', turn: 2, tool: 'task_confirm', args: '{}', ok: true, summary: 'started', elapsedMs: 60 },
      { seq: 4, agent: 'worker', turn: 2, tool: 'execute_operation', args: '{"operation":"dummy.commit"}', ok: true, summary: 'completed', elapsedMs: 200 },
    ],
    pushes: [{ at: 't', source: 'push_text', text: `要写入：${PROPOSAL_SUMMARY}。回「确认」我就提交，回「不」我就不动。` }],
    ledger: {
      taskId: 'task-1',
      taskCount: 1,
      factSequence: ['queued', 'running', 'waiting_user', 'running', 'completed'],
      snapshots: [],
      finalReported: true,
      finalExecutions: [
        { operation: 'dummy.prepare', status: 'failed' },
        { operation: 'dummy.prepare', status: 'needs_confirmation' },
        { operation: 'dummy.commit', status: 'refused' },
        { operation: 'dummy.commit', status: 'completed' },
        { operation: 'dummy.query', status: 'completed' },
      ],
      finalTasks: [
        {
          taskId: 'task-1',
          taskNo: 1,
          liveness: null,
          cancelled: false,
          reported: true,
          executions: [
            { operation: 'dummy.prepare', status: 'failed' },
            { operation: 'dummy.prepare', status: 'needs_confirmation' },
            { operation: 'dummy.commit', status: 'refused' },
            { operation: 'dummy.commit', status: 'completed' },
            { operation: 'dummy.query', status: 'completed' },
          ],
        },
      ],
      proposal: { summary: PROPOSAL_SUMMARY, handlePrefix: 'cf_123456789', operation: 'dummy.prepare' },
    },
    audit: [
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 1 },
      { mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 0 },
      { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0 },
    ],
    confirmations: { usedByCommit: true, usedAt: '2026-11-19T11:00:00.000Z', boundCollection: 'empty-one', boundWindow: 'W1', boundCount: 4 },
    readbackBefore: { status: 'completed', count: 0, items: [] },
    readbackAfter: {
      status: 'completed',
      collection: 'empty-one',
      window: 'W1',
      count: 4,
      sum: 400,
      items: [
        { id: 'rec-1', name: 'item-1', value: 100 },
        { id: 'rec-2', name: 'item-2', value: 100 },
        { id: 'rec-3', name: 'item-3', value: 100 },
        { id: 'rec-4', name: 'item-4', value: 100 },
      ],
    },
    wake: { outcome: 'woken', text: '你交代的那件事办好了：empty-one 的 W1 已新增 4 条记录。' },
    deliveryEvents: [],
  };
}

describe('parseWriteLoopArgs', () => {
  it('缺省：无 out-dir、超时用缺省值', () => {
    expect(parseWriteLoopArgs([])).toEqual({ turnTimeoutMs: 240_000, settleTimeoutMs: 240_000 });
  });

  it('解析 --out-dir=（含空格形态）与超时旋钮', () => {
    expect(parseWriteLoopArgs(['--out-dir=/tmp/x', '--turn-timeout-ms=1000', '--settle-timeout-ms=2000']))
      .toMatchObject({ outDir: '/tmp/x', turnTimeoutMs: 1000, settleTimeoutMs: 2000 });
    expect(parseWriteLoopArgs(['--out-dir', '/tmp/y'])).toMatchObject({ outDir: '/tmp/y' });
  });

  it('拒绝未知参数、畸形超时值、缺值的 out-dir', () => {
    expect(parseWriteLoopArgs(['--bogus'])).toHaveProperty('usageError');
    expect(parseWriteLoopArgs(['--turn-timeout-ms=abc'])).toHaveProperty('usageError');
    expect(parseWriteLoopArgs(['--turn-timeout-ms=0'])).toHaveProperty('usageError');
    expect(parseWriteLoopArgs(['--out-dir'])).toHaveProperty('usageError');
  });

  it('--help 走帮助分支', () => {
    expect(parseWriteLoopArgs(['--help'])).toMatchObject({ help: true });
  });
});

describe('evaluateCriteria：正例全绿 + 逐条反向破坏必红', () => {
  it('全绿样例（含一次失败重试与 Worker 事后读回）：九条判据全 pass', () => {
    const results = evaluateCriteria(greenEvidence());
    expect(results.map((result) => result.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10']);
    expect(results.filter((result) => result.status === 'fail')).toEqual([]);
  });

  it('C1：写前基线非空 → 红', () => {
    const evidence = greenEvidence();
    evidence.readbackBefore = { status: 'completed', count: 2, items: [] };
    expect(evaluateCriteria(evidence).find((result) => result.id === 'C1')?.status).toBe('fail');
  });

  it('C2：执行层审计里没有 prepare 行 → 红', () => {
    const evidence = greenEvidence();
    evidence.audit = [{ mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0 }];
    expect(evaluateCriteria(evidence).find((result) => result.id === 'C2')?.status).toBe('fail');
  });

  it('C3：没观测到 waiting_user 或摘要为空 → 红', () => {
    const missingStatus = greenEvidence();
    missingStatus.ledger.factSequence = ['queued', 'completed'];
    expect(evaluateCriteria(missingStatus).find((result) => result.id === 'C3')?.status).toBe('fail');
    const emptySummary = greenEvidence();
    emptySummary.ledger.proposal = { summary: '  ', handlePrefix: '', operation: 'dummy.prepare' };
    expect(evaluateCriteria(emptySummary).find((result) => result.id === 'C3')?.status).toBe('fail');
  });

  it('C4：模型没调 task_confirm（或没接续成功）→ 红', () => {
    const evidence = greenEvidence();
    evidence.toolCalls = evidence.toolCalls.filter((call) => call.tool !== 'task_confirm');
    expect(evaluateCriteria(evidence).find((result) => result.id === 'C4')?.status).toBe('fail');
    const notStarted = greenEvidence();
    notStarted.toolCalls = notStarted.toolCalls.map((call) => (call.tool === 'task_confirm' ? { ...call, summary: 'not_waiting' } : call));
    expect(evaluateCriteria(notStarted).find((result) => result.id === 'C4')?.status).toBe('fail');
  });

  it('C5：成功 commit 两次（重复写）→ 红；句柄未消耗 → 红；无成功 commit → 红', () => {
    const doubled = greenEvidence();
    doubled.ledger.finalExecutions = [
      { operation: 'dummy.prepare', status: 'needs_confirmation' },
      { operation: 'dummy.commit', status: 'completed' },
      { operation: 'dummy.commit', status: 'completed' },
    ];
    doubled.audit = [...doubled.audit, { mode: 'commit', script: 'dummy.commit', via: 'structured', exitCode: 0 }];
    expect(evaluateCriteria(doubled).find((result) => result.id === 'C5')?.status).toBe('fail');
    const unused = greenEvidence();
    unused.confirmations = { usedByCommit: false };
    expect(evaluateCriteria(unused).find((result) => result.id === 'C5')?.status).toBe('fail');
    const onlyRefused = greenEvidence();
    onlyRefused.ledger.finalExecutions = [
      { operation: 'dummy.prepare', status: 'needs_confirmation' },
      { operation: 'dummy.commit', status: 'refused' },
    ];
    onlyRefused.audit = onlyRefused.audit.filter((row) => row.exitCode !== 0);
    expect(evaluateCriteria(onlyRefused).find((result) => result.id === 'C5')?.status).toBe('fail');
  });

  it('C6：条数对但内容不对（名字/数值错）→ 红', () => {
    const wrongValue = greenEvidence();
    wrongValue.readbackAfter = {
      status: 'completed', count: 4, items: [
        { name: 'item-1', value: 100 }, { name: 'item-2', value: 100 },
        { name: 'item-3', value: 100 }, { name: 'item-4', value: 999 },
      ],
    };
    expect(evaluateCriteria(wrongValue).find((result) => result.id === 'C6')?.status).toBe('fail');
    const placeholder = greenEvidence();
    placeholder.readbackAfter = { status: 'completed', count: 4, items: [{ name: 'empty-one-record-aa-0', value: 0 }] };
    expect(evaluateCriteria(placeholder).find((result) => result.id === 'C6')?.status).toBe('fail');
  });

  it('C7：终态不是 completed、无成功 commit、成功 commit 出现在提案之前、或成功两次 → 红', () => {
    const failed = greenEvidence();
    failed.ledger.finalReported = false;
    expect(evaluateCriteria(failed).find((result) => result.id === 'C7')?.status).toBe('fail');
    const commitBeforeProposal = greenEvidence();
    commitBeforeProposal.ledger.finalExecutions = [
      { operation: 'dummy.commit', status: 'completed' },
      { operation: 'dummy.prepare', status: 'needs_confirmation' },
    ];
    expect(evaluateCriteria(commitBeforeProposal).find((result) => result.id === 'C7')?.status).toBe('fail');
    const noProposal = greenEvidence();
    noProposal.ledger.finalExecutions = [{ operation: 'dummy.commit', status: 'completed' }];
    expect(evaluateCriteria(noProposal).find((result) => result.id === 'C7')?.status).toBe('fail');
    const doubled = greenEvidence();
    doubled.ledger.finalExecutions = [
      { operation: 'dummy.prepare', status: 'needs_confirmation' },
      { operation: 'dummy.commit', status: 'completed' },
      { operation: 'dummy.commit', status: 'completed' },
    ];
    expect(evaluateCriteria(doubled).find((result) => result.id === 'C7')?.status).toBe('fail');
  });

  it('C9：状态序列缺 waiting_user 后的重新执行 → 红', () => {
    const jumped = greenEvidence();
    jumped.ledger.factSequence = ['running', 'waiting_user', 'completed'];
    expect(evaluateCriteria(jumped).find((result) => result.id === 'C9')?.status).toBe('fail');
  });

  it('C8：没有完成投递且非同回合转述 → 红', () => {
    const evidence = greenEvidence();
    evidence.pushes = [];
    evidence.deliveryEvents = [];
    expect(evaluateCriteria(evidence).find((result) => result.id === 'C8')?.status).toBe('fail');
  });
});

describe('C10：提案摘要关键字段进用户可见面（原 O1 观察升级为判据）', () => {
  it('全绿证据：摘要关键字段（集合名/窗口码/条数）都在用户可见文本里 → pass', () => {
    const result = evaluateCriteria(greenEvidence()).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('pass');
    expect(result?.detail).toContain('「empty-one」');
    expect(result?.detail).toContain('W1 窗口');
    expect(result?.detail).toContain('共 4 条');
  });

  it('关键字段缺失（用户可见文本被换成空话）→ fail', () => {
    const evidence = greenEvidence();
    evidence.pushes = [{ at: 't', source: 'push_text', text: '收到，我处理好了。' }];
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '好的。' }));
    const result = evaluateCriteria(evidence).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain('缺失=');
  });

  it('去括号形态：模型写「empty-one 集合」「「W1」窗口」也命中（2026-11-20 假红修复）→ pass', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：empty-one 集合的 W1 窗口共 4 条记录已新增。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：empty-one 集合的「W1」窗口已新增 4 条记录。' }];
    const result = evaluateCriteria(evidence).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('pass');
  });

  it('反向绊线（缺集合名）：完全没提 empty-one → 仍 fail', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：W1 窗口共 4 条记录已新增。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：W1 窗口已新增 4 条记录。' }];
    const result = evaluateCriteria(evidence).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain('「empty-one」');
  });

  it('反向绊线（缺窗口码）：提了集合与条数、没提 W1 窗口 → 仍 fail', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：empty-one 集合共 4 条记录已新增。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：empty-one 集合已新增 4 条记录。' }];
    const result = evaluateCriteria(evidence).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain('W1 窗口');
  });

  it('反向绊线（数值不放宽）：条数写成 40 条 ≠ 摘要的共 4 条 → 仍 fail', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：empty-one 集合的 W1 窗口共 40 条记录。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：empty-one 集合的 W1 窗口共 40 条记录。' }];
    const result = evaluateCriteria(evidence).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain('共 4 条');
  });

  it('第四次同形假红：措辞改成「新增 4 条记录」（集合/窗口保留）→ pass', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：empty-one 集合的 W1 窗口新增 4 条记录。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：empty-one 集合的 W1 窗口新增 4 条记录。' }];
    expect(evaluateCriteria(evidence).find((entry) => entry.id === 'C10')?.status).toBe('pass');
  });

  it('第四次同形假红：中文数字「四条记录」也算命中 → pass', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：empty-one 集合的 W1 窗口写了四条记录。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：empty-one 集合的 W1 窗口写了四条记录。' }];
    expect(evaluateCriteria(evidence).find((entry) => entry.id === 'C10')?.status).toBe('pass');
  });

  it('反向绊线（完全不提条数）：集合/窗口都在、条数省略 → 仍 fail', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：empty-one 集合的 W1 窗口记录已处理。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：empty-one 集合的 W1 窗口记录已处理。' }];
    const result = evaluateCriteria(evidence).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('fail');
    expect(result?.detail).toContain('共 4 条');
  });

  it('反向绊线（14 条 ≠ 4 条）：只有 14 → 仍 fail', () => {
    const evidence = greenEvidence();
    evidence.turns = evidence.turns.map((turn) => ({ ...turn, reply: '已办妥：empty-one 集合的 W1 窗口共 14 条记录。' }));
    evidence.pushes = [{ at: 't', source: 'push_text', text: '办好了：empty-one 集合的 W1 窗口共 14 条记录。' }];
    expect(evaluateCriteria(evidence).find((entry) => entry.id === 'C10')?.status).toBe('fail');
  });

  it('countTokenHit 边界：4 不命中 40/14/140，命中独立 4 与四条', () => {
    const field = '共 4 条';
    expect(countTokenHit(field, ['共 40 条'])).toBe(false);
    expect(countTokenHit(field, ['共 14 条'])).toBe(false);
    expect(countTokenHit(field, ['共 140 条'])).toBe(false);
    expect(countTokenHit(field, ['新增 4 条记录'])).toBe(true);
    expect(countTokenHit(field, ['写了四条记录'])).toBe(true);
  });

  it('chineseNumeral：1～19 与整十的字面写法（机械转换，不涉语义）', () => {
    expect(chineseNumeral(1)).toBe('一');
    expect(chineseNumeral(4)).toBe('四');
    expect(chineseNumeral(10)).toBe('十');
    expect(chineseNumeral(14)).toBe('十四');
    expect(chineseNumeral(20)).toBe('二十');
    expect(chineseNumeral(40)).toBe('四十');
  });

  it('无摘要 → inconclusive（pass，不判红，detail 说明）', () => {
    const evidence = greenEvidence();
    evidence.ledger.proposal = undefined;
    const result = evaluateCriteria(evidence).find((entry) => entry.id === 'C10');
    expect(result?.status).toBe('pass');
    expect(result?.detail).toContain('inconclusive');
  });

  it('反向绊线：把判据改成恒真（忽略关键字段）→ 关键字段缺失仍 pass', () => {
    // 这里用「恒真等价」证据注入模拟：把摘要关键字段清空即等价于判据恒真（无字段可查）。
    const evidence = greenEvidence();
    evidence.ledger.proposal = { summary: '无关键字段的摘要', handlePrefix: 'cf_x', operation: 'dummy.prepare' };
    // 无关键字段 → summaryKeyFields 返回 [] → 判据走「无摘要」分支 pass（恒真行为）。
    expect(evaluateCriteria(evidence).find((entry) => entry.id === 'C10')?.status).toBe('pass');
  });
});

describe('evaluateObservations：只记录不判红', () => {
  it('O1：woken 且投递文本 == 唤醒正文 → 判为模型的话；wake 非 woken → 记录宿主兜底', () => {
    const modelSpoke = greenEvidence();
    modelSpoke.pushes = [{ at: 't', source: 'push_text', text: modelSpoke.wake!.text! }];
    expect(evaluateObservations(modelSpoke).find((entry) => entry.id === 'O1')?.detail).toContain('模型的话');
    const fallback = greenEvidence();
    fallback.wake = { outcome: 'failed' };
    fallback.pushes = [{ at: 't', source: 'push_text', text: '「新增4条」办好了：4 条已新增。' }];
    expect(evaluateObservations(fallback).find((entry) => entry.id === 'O1')?.detail).toContain('宿主兜底');
  });

  it('O2：固定短语表命中记录（不判红）', () => {
    const evidence = greenEvidence();
    evidence.turns[1]!.reply = '收到，正在处理';
    expect(evaluateObservations(evidence).find((entry) => entry.id === 'O2')?.detail).toContain('收到，正在处理');
    expect(evaluateObservations(greenEvidence()).find((entry) => entry.id === 'O2')?.detail).toContain('未命中');
  });
});

describe('执行层证据读取', () => {
  it('readAuditRows：逐行解析、坏行记 unparsable、空文件给空数组', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'write-loop-audit-'));
    try {
      expect(readAuditRows(dir)).toEqual([]);
      writeFileSync(path.join(dir, 'audit.jsonl'), [
        JSON.stringify({ mode: 'prepare', via: 'structured', script: 'dummy.prepare', exitCode: 0, args: { '--collection': 'empty-one' } }),
        'not-json',
        JSON.stringify({ mode: 'commit', via: 'structured', script: 'dummy.commit', exitCode: 0 }),
        '',
      ].join('\n'));
      const rows = readAuditRows(dir);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ mode: 'prepare', script: 'dummy.prepare', via: 'structured', exitCode: 0 });
      expect(rows[1]).toMatchObject({ mode: 'unparsable' });
      expect(rows[2]).toMatchObject({ mode: 'commit', script: 'dummy.commit' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readConfirmationFacts：命中绑定目标集合的句柄；未消耗 → usedByCommit=false', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'write-loop-conf-'));
    try {
      expect(readConfirmationFacts(dir, 'empty-one')).toEqual({ usedByCommit: false });
      writeFileSync(path.join(dir, 'confirmations.json'), JSON.stringify({
        confirmations: {
          cf_a: { collection: 'alpha', window: 'W1', count: 2, usedAt: null, usedBy: null },
          cf_b: { collection: 'empty-one', window: 'W1', count: 4, usedAt: '2026-11-19T11:00:00.000Z', usedBy: 'dummy.commit' },
        },
      }));
      const facts = readConfirmationFacts(dir, 'empty-one');
      expect(facts).toMatchObject({ usedByCommit: true, boundCollection: 'empty-one', boundWindow: 'W1', boundCount: 4 });
      const unused = readConfirmationFacts(dir, 'alpha');
      expect(unused.usedByCommit).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordingDriver：透传不改 + 入账', () => {
  const inputOf = (exec: TurnDriverInput['exec']): TurnDriverInput => ({
    systemPrompt: 's',
    tools: [],
    messages: [],
    onStep: () => {},
    exec,
    deadline: Date.now() + 1_000,
  });

  it('结果原样返回、工具调用入账；错误原样上抛并入账', async () => {
    const sink = { currentTurn: 7, toolCalls: [], pushes: [], seq: 0 } as Parameters<typeof recordingDriver>[2];
    const inner: TurnDriver = {
      async run(input) {
        const first = await input.exec('task_run', { task: 'x' });
        try {
          await input.exec('task_confirm', {});
        } catch {
          // 预期抛错：包装器必须原样上抛（这里吞掉是为了让 run 收尾）。
        }
        return { text: 'ok', messages: [...input.messages, `first=${JSON.stringify(first)}` as never] };
      },
      async wake() {
        return { outcome: 'woken', text: '办好了' };
      },
    };
    const calls: Array<{ tool: string }> = [];
    const driver = recordingDriver(inner, 'main', sink);
    const result = await driver.run(inputOf(async (tool) => {
      calls.push({ tool });
      if (tool === 'task_confirm') throw new Error('boom');
      return { status: 'completed' };
    }));
    expect(result.text).toBe('ok');
    expect(calls.map((call) => call.tool)).toEqual(['task_run', 'task_confirm']);
    expect(sink.toolCalls).toHaveLength(2);
    expect(sink.toolCalls[0]).toMatchObject({ agent: 'main', turn: 7, tool: 'task_run', ok: true, summary: 'completed' });
    expect(sink.toolCalls[1]).toMatchObject({ tool: 'task_confirm', ok: false, summary: 'boom' });
    // 唤醒出口透传并记录。
    expect(driver.wake).toBeDefined();
    expect(await driver.wake!('fact')).toEqual({ outcome: 'woken', text: '办好了' });
    expect(sink.wake).toEqual({ outcome: 'woken', text: '办好了' });
  });

  it('内层没有 wake 时不伪造唤醒能力（调用方按 unavailable 处置）', () => {
    const sink = { currentTurn: 1, toolCalls: [], pushes: [], seq: 0 } as Parameters<typeof recordingDriver>[2];
    const inner: TurnDriver = { async run() { return { text: '', messages: [] }; } };
    const driver = recordingDriver(inner, 'worker', sink);
    expect(driver.wake).toBeUndefined();
    expect(sink.wake).toBeUndefined();
  });
});

describe('LedgerWatcher：去重采样与状态序列', () => {
  it('同一签名不重复记；状态变化逐条入序列', async () => {
    // S1 事实模型：watcher 只记机械事实（liveness + cancelled/reported + 末条执行行原值），
    // 不合成任务级状态词。
    const phases = ['unstarted', 'unstarted', 'running', 'running', 'done'] as const;
    let index = 0;
    const recordOf = (phase: (typeof phases)[number]): Record<string, unknown> => ({
      taskId: 't-1',
      executions: phase === 'done'
        ? [{ requestId: 'r1', operation: 'dummy.query', status: 'completed' }]
        : [],
      ...(phase === 'running' ? { runningSince: '2026-11-22T00:00:00.000Z', leaseUntil: '2999-01-01T00:00:00.000Z' } : {}),
    });
    const fake = {
      list: () => [recordOf(phases[Math.min(index, phases.length - 1)]!)],
    } as unknown as ConstructorParameters<typeof LedgerWatcher>[0];
    index = 0;
    const watcher = new LedgerWatcher(fake, { principalId: 'p', sessionId: 's' });
    for (index = 0; index < phases.length; index += 1) watcher.sample();
    expect(watcher.snapshots.map((snapshot) => snapshot.liveness)).toEqual([null, 'running', null]);
    expect(watcher.sequenceOf('t-1')).toEqual([
      'liveness=null cancelled=false reported=false exec=null',
      'liveness=running cancelled=false reported=false exec=null',
      'liveness=null cancelled=false reported=false exec=completed',
    ]);
    expect(watcher.taskIds()).toEqual(['t-1']);
  });

  it('提案出现与句柄前缀入账（句柄不落全量）', () => {
    const fake = {
      list: () => [{
        taskId: 't-2',
        status: 'waiting_user',
        executions: [{ operation: 'dummy.prepare', status: 'needs_confirmation' }],
        pendingQuestion: { missing: [], confirmation: { handle: 'cf_abcdefghijklmnop', summary: '将向集合「empty-one」…', operation: 'dummy.prepare' } },
      }],
    } as unknown as ConstructorParameters<typeof LedgerWatcher>[0];
    const watcher = new LedgerWatcher(fake, { principalId: 'p', sessionId: 's' });
    watcher.sample();
    const snapshot = watcher.snapshots[0]!;
    expect(snapshot.liveness).toBe('waiting_user');
    expect(snapshot.proposal).toEqual({ summary: '将向集合「empty-one」…', handlePrefix: 'cf_abcdefghi', operation: 'dummy.prepare' });
    expect(JSON.stringify(snapshot)).not.toContain('cf_abcdefghijklmnop');
  });
});

// ---------------------------------------------------------------------------
// 子进程：前置门（不跑模型）
// ---------------------------------------------------------------------------

function runScript(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  // 显式清空 LLM_*：前置门必须如实拒绝，不许落回任何脚本模型。
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    TMPDIR: process.env['TMPDIR'] ?? os.tmpdir(),
  };
  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('子进程前置门', () => {
  it('--help：exit 0 并打印用法', () => {
    const run = runScript(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('写闭环');
  });

  it('缺模型配置：exit 2、点名缺什么，且不写任何证据（不退回脚本模型）', () => {
    const run = runScript([]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('缺少真实模型配置');
    expect(run.stderr).toContain('LLM_API_KEY');
  });

  it('前置门拒绝不留自动运行目录（空目录即噪音；有证据的一律保留）', () => {
    const autoRoot = path.join(REPO_ROOT, '.runtime', 'real-write-loop');
    const before = existsSync(autoRoot) ? readdirSync(autoRoot).sort() : [];
    const run = runScript([]);
    expect(run.status).toBe(2);
    const after = existsSync(autoRoot) ? readdirSync(autoRoot).sort() : [];
    expect(after).toEqual(before);
  });
});
