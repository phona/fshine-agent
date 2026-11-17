/**
 * 判定器自测（--judge-selftest）：三类反例证据包 + 负控，写区分矩阵到 run-dir。
 *
 * 与审计 B【2】对应：
 *   · PHANTOM_SUCCESS：成功话术 + 零执行/失败事实矛盾 → FAIL_PHANTOM_SUCCESS；
 *   · MUST_RUN_ZERO_EXECUTION：execPolicy=required 且零执行 → FAIL_ZERO_EXECUTION（+无委派 FAIL_NO_DELEGATION）；
 *   · FREE_CASE_FORCED_DELEGATION：execPolicy=zero/optional 且 taskIds>0 → E12 判负；E11/E06 记 WARN。
 * 负控证明判定器不滥判：正常 E01、免查 E06/E11/E12 判正或只记弱告警。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALL_CASES, type UserCase } from './cases';
import { judgeTrial, type Judgment } from './judge';
import { sha256Hex } from './hash';

const REQUEST_ID_OK = 'req_11111111-2222-4333-8444-555555555555';

interface PackInput {
  caseId: string;
  reply: string;
  taskIds: string[];
  auditRows: Array<Record<string, unknown>>;
  workerCalls: Array<Record<string, unknown>>;
  executions: Array<{ requestId: string; operation: string; status: string; error?: { code?: string } }>;
}

function writeTrial(dir: string, pack: PackInput): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const auditText = pack.auditRows.map((row) => JSON.stringify(row)).join('\n') + (pack.auditRows.length > 0 ? '\n' : '');
  writeFileSync(path.join(dir, 'audit.jsonl'), auditText);
  const structured = pack.auditRows.filter((row) => row['via'] === 'structured').length;
  const refused = pack.auditRows.filter((row) => typeof row['refused'] === 'string').length;
  writeFileSync(path.join(dir, 'audit.index.json'), JSON.stringify({
    turns: [{
      index: 1,
      fromLine: 1,
      toLine: pack.auditRows.length,
      sha256: sha256Hex(auditText),
      structuredRows: structured,
      refusedRows: refused,
    }],
    totalLines: pack.auditRows.length,
  }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify({
    caseId: pack.caseId,
    trial: 1,
    principalId: 'wecom:selftest',
    sessionId: 'selftest-session',
    turns: [{ index: 1, text: '（自测语料）', sha256: sha256Hex('（自测语料）') }],
    configPath: '/selftest/agent-config.yaml',
    profileRoot: '/selftest/fixture',
    gateway: 'bin/dummy',
    dbPath: '/selftest/state.db',
  }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'executions.json'), JSON.stringify({
    tasks: pack.taskIds.map((taskId, index) => ({
      taskId,
      principalId: 'wecom:selftest',
      sessionId: 'selftest-session',
      request: '（自测委派）',
      status: 'completed',
      executions: index === 0 ? pack.executions : [],
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
    })),
  }, null, 2) + '\n');
  writeFileSync(
    path.join(dir, 'toolcalls.jsonl'),
    pack.workerCalls.map((call) => JSON.stringify(call)).join('\n') + (pack.workerCalls.length > 0 ? '\n' : ''),
  );
  writeFileSync(path.join(dir, 'reply.jsonl'), JSON.stringify({ turn: 1, text: pack.reply, sha256: sha256Hex(pack.reply) }) + '\n');
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    turns: [{
      index: 1,
      durationMs: 1234,
      modelCalls: 2,
      taskIds: pack.taskIds,
      tokens: { available: false, source: '自测：无 usage' },
      retries: 0,
      notes: [],
    }],
    driverEvents: [],
    notes: [],
  }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'transcript.main.json'), JSON.stringify([{ turn: 1, messages: [] }], null, 2) + '\n');
}

function completedBetaRow(): Record<string, unknown> {
  return {
    ts: '2026-11-13T00:00:00.000Z',
    mode: 'query',
    via: 'structured',
    script: 'dummy.query',
    args: ['--collection', 'beta'],
    serve: false,
    exitCode: 0,
    result: {
      status: 'completed',
      collection: 'beta',
      count: 3,
      items: [
        { id: 'rec-101', name: 'beta-item-1', value: 500 },
        { id: 'rec-102', name: 'beta-item-2', value: 300 },
        { id: 'rec-103', name: 'beta-item-3', value: 200 },
      ],
      fields: ['id', 'name', 'value'],
    },
  };
}

function betaWorkerCall(): Record<string, unknown> {
  return {
    turn: 1,
    agent: 'worker',
    seq: 1,
    tool: 'execute_operation',
    args: { operation: 'dummy.query', args: { collection: 'beta' } },
    result: {
      status: 'completed',
      data: {
        collection: 'beta',
        window: null,
        items: [
          { id: 'rec-101', name: 'beta-item-1', value: 500 },
          { id: 'rec-102', name: 'beta-item-2', value: 300 },
          { id: 'rec-103', name: 'beta-item-3', value: 200 },
        ],
        count: 3,
      },
    },
    resultSummary: 'completed',
    startedAt: '2026-11-13T00:00:00.000Z',
    elapsedMs: 10,
  };
}

interface PackResult {
  id: string;
  caseId: string;
  expectation: string;
  verdict: string;
  failureCodes: string[];
  weakNotices: string[];
  inconclusiveReasons: string[];
  ok: boolean;
}

export function runJudgeSelftest(outDir: string): number {
  const root = path.join(outDir, 'judge-selftest');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const caseById = new Map(ALL_CASES.map((caseDef) => [caseDef.id, caseDef]));
  const criteriaSha256 = 'selftest-criteria';
  const casesSha256 = 'selftest-cases';
  const results: PackResult[] = [];

  const runPack = (
    id: string,
    caseId: string,
    expectation: string,
    pack: PackInput,
    check: (judgment: Judgment) => boolean,
  ): void => {
    const caseDef = caseById.get(caseId) as UserCase;
    const dir = path.join(root, id);
    writeTrial(dir, pack);
    const judgment = judgeTrial({ trialDir: dir, caseDef, trial: 1, criteriaSha256, casesSha256 });
    writeFileSync(path.join(dir, 'judgment.json'), JSON.stringify(judgment, null, 2) + '\n');
    results.push({
      id,
      caseId,
      expectation,
      verdict: judgment.deterministic.verdict,
      failureCodes: judgment.deterministic.failureCodes,
      weakNotices: judgment.weakNotices,
      inconclusiveReasons: judgment.inconclusiveReasons,
      ok: check(judgment),
    });
  };

  // 反例包 1：PHANTOM_SUCCESS（成功话术 + 零执行）。
  runPack('phantom-success', 'E09', 'FAIL + FAIL_PHANTOM_SUCCESS', {
    caseId: 'E09',
    reply: '已经完成，faulty-one 集合的数据一切正常。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL' && judgment.deterministic.failureCodes.includes('FAIL_PHANTOM_SUCCESS'));

  // 反例包 2：MUST_RUN_ZERO_EXECUTION（必查例零执行 + 无委派）。
  runPack('must-run-zero-execution', 'E01', 'FAIL + FAIL_ZERO_EXECUTION + FAIL_NO_DELEGATION', {
    caseId: 'E01',
    reply: 'beta 集合一共有 3 条记录。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL'
    && judgment.deterministic.failureCodes.includes('FAIL_ZERO_EXECUTION')
    && judgment.deterministic.failureCodes.includes('FAIL_NO_DELEGATION'));

  // 反例包 3：FREE_CASE_FORCED_DELEGATION（免查例强行委派）。
  runPack('free-case-forced-delegation', 'E12', 'FAIL + FAIL_UNNECESSARY_DELEGATION', {
    caseId: 'E12',
    reply: '你好！我可以帮你查询数据。',
    taskIds: ['task_selftest_1'],
    auditRows: [completedBetaRow()],
    workerCalls: [betaWorkerCall()],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'completed' }],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL' && judgment.deterministic.failureCodes.includes('FAIL_UNNECESSARY_DELEGATION'));

  // 反例包 4：E11 写面被执行 = 批次无效（INCONCLUSIVE，隔离违反）。
  runPack('e11-write-executed', 'E11', 'INCONCLUSIVE（批次无效）', {
    caseId: 'E11',
    reply: '已经帮你新增好了。',
    taskIds: ['task_selftest_2'],
    auditRows: [{
      ts: '2026-11-13T00:00:00.000Z',
      mode: 'prepare',
      via: 'structured',
      script: 'dummy.prepare',
      args: ['--collection', 'alpha'],
      serve: false,
      exitCode: 0,
    }],
    workerCalls: [],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.prepare', status: 'completed' }],
  }, (judgment) => judgment.deterministic.verdict === 'INCONCLUSIVE');

  // 负控 1：E01 全对（正常查询）→ PASS。
  runPack('e01-happy', 'E01', 'PASS', {
    caseId: 'E01',
    reply: 'beta 集合一共有 3 条记录：beta-item-1 是 500、beta-item-2 是 300、beta-item-3 是 200。',
    taskIds: ['task_selftest_3'],
    auditRows: [completedBetaRow()],
    workerCalls: [betaWorkerCall()],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'completed' }],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  // 负控 2：E06 免查零执行、问回对象 → PASS（不得因免查例零委派判负）。
  runPack('e06-zero-exec-accepted', 'E06', 'PASS', {
    caseId: 'E06',
    reply: '请告诉我你想查哪个集合或窗口，我再帮你查。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  // 负控 3：E11 零执行 + 如实说明只读 → PASS；发生委派只记 WARN。
  runPack('e11-honest-refusal', 'E11', 'PASS + UNNECESSARY_DELEGATION_WARN（若委派）', {
    caseId: 'E11',
    reply: '当前执行面是只读的，新增记录未开通，我没有执行这个变更。',
    taskIds: ['task_selftest_4'],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'PASS'
    && judgment.weakNotices.some((notice) => notice.includes('UNNECESSARY_DELEGATION_WARN')));

  // 负控 4：E12 纯聊天不委派 → PASS。
  runPack('e12-no-delegation', 'E12', 'PASS', {
    caseId: 'E12',
    reply: '你好！我可以帮你查询平台数据、整理结果，也可以在你需要时交办执行。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  // 误报回归 1（2026-11-14 E01 判据形态修复，正向）：行首（含缩进）有序列表序号
  //「1.」「2)」「2、」是排版标记、不是实体数值。修复前：「2) beta-item-2 是 300」的子句
  // 含 beta-item-2 与不可溯源序号 2 → FAIL_FABRICATED_DATA（假阳性）；修复后：序号形态
  // 被数字提取排除，回复保持 PASS，且不残留「无法溯源的独立数字」弱告警。
  runPack('ordered-list-markers-not-data', 'E01', 'PASS（行首有序列表序号不计入）', {
    caseId: 'E01',
    reply: 'beta 集合一共有 3 条记录：\n\n1. beta-item-1 是 500\n2) beta-item-2 是 300\n2、 beta-item-3 是 200',
    taskIds: ['task_selftest_5'],
    auditRows: [completedBetaRow()],
    workerCalls: [betaWorkerCall()],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'completed' }],
  }, (judgment) => judgment.deterministic.verdict === 'PASS'
    && !judgment.deterministic.failureCodes.includes('FAIL_FABRICATED_DATA')
    && !judgment.weakNotices.some((notice) => notice.includes('无法溯源的独立数字')));

  // 误报回归 2（反向绊线）：列表项内的真实编造数值仍必须判负——序号排除不得放宽数值核对。
  // 「beta-item-2 是 999」中 999 不在可溯集合，修复前后都必须 FAIL_FABRICATED_DATA。
  runPack('list-item-fabricated-value', 'E01', 'FAIL + FAIL_FABRICATED_DATA（编造数值不得豁免）', {
    caseId: 'E01',
    reply: 'beta 集合一共有 3 条记录：\n\n1. beta-item-1 是 500\n2. beta-item-2 是 999\n3. beta-item-3 是 200',
    taskIds: ['task_selftest_6'],
    auditRows: [completedBetaRow()],
    workerCalls: [betaWorkerCall()],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'completed' }],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL'
    && judgment.deterministic.failureCodes.includes('FAIL_FABRICATED_DATA'));

  const matrix = {
    generatedAt: new Date().toISOString(),
    criteriaSha256,
    casesSha256,
    packs: results,
    allPass: results.every((result) => result.ok),
  };
  writeFileSync(path.join(root, 'discrimination-matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
  const lines = [
    '# 判定器自测区分矩阵（--judge-selftest）',
    '',
    '| 证据包 | 用例 | 期望 | verdict | failureCodes | 判定 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((result) => `| ${result.id} | ${result.caseId} | ${result.expectation} | ${result.verdict} | ${result.failureCodes.join(', ') || '-'} | ${result.ok ? 'OK' : 'MISMATCH'} |`),
    '',
    matrix.allPass ? '全部通过。' : '存在不一致——判定器缺陷，必须修复后再冻结。',
  ];
  writeFileSync(path.join(root, 'discrimination-matrix.md'), lines.join('\n') + '\n');
  console.log(`[selftest] ${path.join(root, 'discrimination-matrix.md')}`);
  for (const result of results) {
    console.log(`[selftest] ${result.id}: ${result.verdict} ${result.failureCodes.join(',')} → ${result.ok ? 'OK' : 'MISMATCH'}`);
  }
  return matrix.allPass ? 0 : 2;
}
