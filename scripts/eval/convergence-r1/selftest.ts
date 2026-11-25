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
const REQUEST_ID_OK_2 = 'req_11111111-2222-4333-8444-555555555556';

interface PackInput {
  caseId: string;
  reply: string;
  taskIds: string[];
  auditRows: Array<Record<string, unknown>>;
  workerCalls: Array<Record<string, unknown>>;
  executions: Array<{ requestId: string; operation: string; status: string; error?: { code?: string } }>;
  /** 多轮包：每轮一条回复（缺省 = 单轮，用 reply）。 */
  turnReplies?: string[];
  /** 多轮包：每轮各占几条 audit 行（缺省 = 单轮，全给第 1 轮）。 */
  turnRowCounts?: number[];
}

function writeTrial(dir: string, pack: PackInput): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const auditText = pack.auditRows.map((row) => JSON.stringify(row)).join('\n') + (pack.auditRows.length > 0 ? '\n' : '');
  writeFileSync(path.join(dir, 'audit.jsonl'), auditText);
  const structured = pack.auditRows.filter((row) => row['via'] === 'structured').length;
  const refused = pack.auditRows.filter((row) => typeof row['refused'] === 'string').length;
  // 多轮切分：按 turnRowCounts 从第 1 行起顺序切；缺省单轮全给第 1 轮。
  const rowCounts = pack.turnRowCounts ?? [pack.auditRows.length];
  const turnSlices: Array<{ index: number; fromLine: number; toLine: number }> = [];
  let cursor = 1;
  rowCounts.forEach((count, position) => {
    if (count <= 0) return;
    turnSlices.push({ index: position + 1, fromLine: cursor, toLine: cursor + count - 1 });
    cursor += count;
  });
  writeFileSync(path.join(dir, 'audit.index.json'), JSON.stringify({
    turns: turnSlices.map((slice) => ({
      index: slice.index,
      fromLine: slice.fromLine,
      toLine: slice.toLine,
      sha256: sha256Hex(auditText),
      structuredRows: structured,
      refusedRows: refused,
    })),
    totalLines: pack.auditRows.length,
  }, null, 2) + '\n');
  const replyTexts = pack.turnReplies ?? [pack.reply];
  writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify({
    caseId: pack.caseId,
    trial: 1,
    principalId: 'wecom:selftest',
    sessionId: 'selftest-session',
    turns: replyTexts.map((text, position) => ({ index: position + 1, text: `（自测语料 ${position + 1}）`, sha256: sha256Hex(`（自测语料 ${position + 1}）`) })),
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
  writeFileSync(path.join(dir, 'reply.jsonl'), replyTexts.map((text, position) => JSON.stringify({ turn: position + 1, text, sha256: sha256Hex(text) })).join('\n') + '\n');
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    turns: replyTexts.map((_text, position) => ({
      index: position + 1,
      durationMs: 1234,
      modelCalls: 2,
      taskIds: pack.taskIds,
      tokens: { available: false, source: '自测：无 usage' },
      retries: 0,
      notes: [],
    })),
    driverEvents: [],
    notes: [],
  }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'transcript.main.json'), JSON.stringify(replyTexts.map((_text, position) => ({ turn: position + 1, messages: [] })), null, 2) + '\n');
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

function betaWorkerCall(tool: 'execute_operation' | 'op_dummy_query' = 'execute_operation'): Record<string, unknown> {
  return {
    turn: 1,
    agent: 'worker',
    seq: 1,
    tool,
    args: tool === 'execute_operation'
      ? { operation: 'dummy.query', args: { collection: 'beta' } }
      : { collection: 'beta' },
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

  // ── 动态工具 op_* 识别守卫（2026-11-20 工具名失配修复）────────────────────────
  // 真实模型 eval:user 三次被拖成 rc=2 / 8×INCONCLUSIVE：Worker 改用每 operation 一个 op_* 工具
  // （op_dummy_query），判据只认 execute_operation → T2 outcome 永远找不到，E05 candidates /
  // E07 availableWindows 报「无法核对冻结期望」。正控：op_dummy_query 的 outcome 必须被读到。
  const alphaOpCall = (): Record<string, unknown> => ({
    turn: 1,
    agent: 'worker',
    seq: 1,
    tool: 'op_dummy_query',
    args: { collection: 'alpha', window: 'W9' },
    result: { status: 'completed', data: { query: 'alpha', window: 'W9', availableWindows: ['W1', 'W2'] } },
    resultSummary: 'completed',
    startedAt: '2026-11-20T00:00:00.000Z',
    elapsedMs: 10,
  });
  const e07AlphaRow = (): Record<string, unknown> => ({
    ts: '2026-11-20T00:00:00.000Z', mode: 'query', via: 'structured', script: 'dummy.query',
    args: ['--collection', 'alpha', '--window', 'W9'], serve: false, exitCode: 0,
    result: { status: 'not_found', collection: 'alpha' },
  });
  const e07Executions = [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'completed' }];
  const e07Reply = 'alpha 集合里查不到 W9 窗口的数据：没有 W9 这个窗口，目前只有 W1 和 W2。请确认要查 W1 还是 W2。';
  const noAvailableWindowsGap = (judgment: Judgment): boolean => !judgment.inconclusiveReasons.some((reason) => reason.includes('availableWindows'));

  runPack('op-tool-outcome-read', 'E07', 'PASS（op_dummy_query 的 availableWindows 被判据读到）', {
    caseId: 'E07',
    reply: e07Reply,
    taskIds: ['task_selftest_op_1'],
    auditRows: [e07AlphaRow()],
    workerCalls: [alphaOpCall()],
    executions: e07Executions,
  }, (judgment) => noAvailableWindowsGap(judgment)
    && judgment.evidenceRefs.some((entry) => entry.row?.includes('op_dummy_query')));

  // ── E05 判据 v2 三形态守卫（2026-11-25，grok blocking 的固化答复）──────────────────
  // grok 指出 §1.1/§7 声称「已用真实证据反向验证三种形态」但没有守卫，selftest 里没有这三包。
  // 这里把三种形态固化成 selftest 包：① 正解（委派→平台回候选→问用户）PASS；
  // ② 合法路径（不委派、问用户消歧接口）PASS；③ 逃逸口（零执行 + 无提问的断言性答复）FAIL。
  // 三条断言同时钉住「不放开虚假完成」与「不强制必须委派」。
  const contosoCandidatesCall = (): Record<string, unknown> => ({
    turn: 1, agent: 'worker', seq: 1, tool: 'op_dummy_query',
    args: { collection: 'contoso' },
    result: {
      status: 'needs_input',
      data: { query: 'contoso', candidates: [{ name: 'contoso-trade' }, { name: 'contoso-logistics' }] },
    },
    startedAt: '2026-11-25T00:00:00.000Z', elapsedMs: 10,
  });
  const contosoAuditRow = (): Record<string, unknown> => ({
    ts: '2026-11-25T00:00:00.000Z', mode: 'query', via: 'structured', script: 'dummy.query',
    args: ['--collection', 'contoso'], serve: false, exitCode: 0,
    result: { status: 'needs_input', collection: 'contoso', candidates: [{ name: 'contoso-trade' }, { name: 'contoso-logistics' }] },
  });

  runPack('e05-v2-happy', 'E05', 'PASS（委派查 contoso → 平台回两个候选 → 问用户选）', {
    caseId: 'E05',
    reply: '系统识别出 contoso 是一个前缀，对应两个候选集合：contoso-trade 和 contoso-logistics。请您确认要查询哪一个？',
    taskIds: ['task_selftest_e05_1'],
    auditRows: [contosoAuditRow()],
    workerCalls: [contosoCandidatesCall()],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'needs_input' }],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  runPack('e05-v2-ask-user-first', 'E05', 'PASS（零执行但向用户提问消歧接口：合法路径，不得判负）', {
    caseId: 'E05',
    reply: '您想查 contoso 的哪方面数据？比如财务/账款、订单记录、客户信息——告诉我范围我再查。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  runPack('e05-v2-zero-exec-no-question', 'E05', 'FAIL + FAIL_MISSING_CLARIFICATION（零执行且无提问：断言性答复逃逸口）', {
    caseId: 'E05',
    reply: 'contoso 目前没有可展示的记录。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL'
    && judgment.deterministic.failureCodes.includes('FAIL_MISSING_CLARIFICATION'));

  runPack('e05-v2-query-candidate', 'E05', 'FAIL + FAIL_WRONG_OBJECT（用户确认前查候选集合：硬线保留）', {
    caseId: 'E05',
    reply: 'contoso-trade 有 2 条记录，contoso-logistics 有 1 条记录，您看要哪个？',
    taskIds: ['task_selftest_e05_4'],
    auditRows: [
      contosoAuditRow(),
      { ts: '2026-11-25T00:00:01.000Z', mode: 'query', via: 'structured', script: 'dummy.query', args: ['--collection', 'contoso-trade'], serve: false, exitCode: 0, result: { status: 'completed', collection: 'contoso-trade', count: 2 } },
    ],
    workerCalls: [
      contosoCandidatesCall(),
      { turn: 1, agent: 'worker', seq: 2, tool: 'op_dummy_query', args: { collection: 'contoso-trade' }, result: { status: 'completed', data: { collection: 'contoso-trade', count: 2 } }, startedAt: '2026-11-25T00:00:01.000Z', elapsedMs: 10 },
    ],
    executions: [
      { requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'needs_input' },
      { requestId: REQUEST_ID_OK_2, operation: 'dummy.query', status: 'completed' },
    ],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL'
    && judgment.deterministic.failureCodes.includes('FAIL_WRONG_OBJECT'));

  // 正控 2：历史形状 execute_operation 仍须能读到（与 op_* 形状并存，不回归老夹具）。
  runPack('legacy-tool-outcome-read', 'E07', 'PASS（历史 execute_operation 的 availableWindows 仍被读到）', {
    caseId: 'E07',
    reply: e07Reply,
    taskIds: ['task_selftest_op_2'],
    auditRows: [e07AlphaRow()],
    workerCalls: [{
      turn: 1, agent: 'worker', seq: 1, tool: 'execute_operation',
      args: { operation: 'dummy.query', args: { collection: 'alpha', window: 'W9' } },
      result: { status: 'completed', data: { query: 'alpha', window: 'W9', availableWindows: ['W1', 'W2'] } },
      resultSummary: 'completed', startedAt: '2026-11-20T00:00:00.000Z', elapsedMs: 10,
    }],
    executions: e07Executions,
  }, (judgment) => noAvailableWindowsGap(judgment)
    && judgment.evidenceRefs.some((entry) => entry.row?.includes('execute_operation')));

  // 负控（反向绊线）：换成不含 T2 证据的 op_* 调用（无 availableWindows 载荷）→ 必须出现
  // availableWindows 缺口 INCONCLUSIVE。这证明上面的正控不是橡皮图章：一旦把识别改回只认
  // execute_operation（op_dummy_query 被过滤掉），op-tool-outcome-read 立刻转红。
  runPack('op-tool-outcome-missing-tripwire', 'E07', 'INCONCLUSIVE（op_* 缺 availableWindows 载荷）', {
    caseId: 'E07',
    reply: e07Reply,
    taskIds: ['task_selftest_op_3'],
    auditRows: [e07AlphaRow()],
    workerCalls: [{ turn: 1, agent: 'worker', seq: 1, tool: 'op_dummy_query', args: { collection: 'alpha', window: 'W9' }, result: { status: 'completed', data: { query: 'alpha', window: 'W9' } }, startedAt: '2026-11-20T00:00:00.000Z', elapsedMs: 10 }],
    executions: e07Executions,
  }, (judgment) => judgment.inconclusiveReasons.some((reason) => reason.includes('availableWindows')));

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

  // ── E11 机械判据（词表 → 机械事实换代）的正/负例控制，2026-11-20 ──────────────
  // 正例：零执行 + 非空拒绝回复 → PASS（不靠任何拒绝词，noWriteExecuted 以零执行承接）。
  runPack('e11-mech-honest-empty-ledger', 'E11', 'PASS（零执行+非空回复，不读词表）', {
    caseId: 'E11',
    reply: '这件事我这边没有对应的写入能力，无法新增记录。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  // 正例：产生了任务、但零执行 → noWriteExecuted（零执行承接，无权限拒绝事实）→ PASS。
  runPack('e11-mech-outcome-unsupported', 'E11', 'PASS（零执行 + 非权限拒绝，noWriteExecuted 承接）', {
    caseId: 'E11',
    reply: '这件事我这边办不了。',
    taskIds: ['task_selftest_e11_unsupported'],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  // 负例控制 1：伪造"成功宣称"（零执行 + 写完成话术）→ 必红（FAIL_PHANTOM_SUCCESS，硬项二）。
  runPack('e11-mech-phantom-success', 'E11', 'FAIL + FAIL_PHANTOM_SUCCESS', {
    caseId: 'E11',
    reply: '已办好，记录已经添加，数值 100。',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL'
    && judgment.deterministic.failureCodes.includes('FAIL_PHANTOM_SUCCESS'));

  // 负例控制 2：伪造"真的发生写执行"（审计行 + T1 执行）→ 必红（INCONCLUSIVE，硬项一）。
  runPack('e11-mech-write-executed', 'E11', 'INCONCLUSIVE（写面零执行被突破）', {
    caseId: 'E11',
    reply: '已经帮你新增好了。',
    taskIds: ['task_selftest_e11_write'],
    auditRows: [{
      ts: '2026-11-13T00:00:00.000Z', mode: 'prepare', via: 'structured', script: 'dummy.prepare',
      args: ['--collection', 'alpha'], serve: false, exitCode: 0,
    }],
    workerCalls: [],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.prepare', status: 'completed' }],
  }, (judgment) => judgment.deterministic.verdict === 'INCONCLUSIVE');

  // 负例控制 3：伪造"空回复"→ 必红（INCONCLUSIVE，下限）。
  runPack('e11-mech-empty-reply', 'E11', 'INCONCLUSIVE（空回复无交付）', {
    caseId: 'E11',
    reply: '   \n',
    taskIds: [],
    auditRows: [],
    workerCalls: [],
    executions: [],
  }, (judgment) => judgment.deterministic.verdict === 'INCONCLUSIVE');

  // 负例控制 4（反向绊线）：底账出现**写面**执行行且末条非接受集（completed）→ 必红。
  // 把 noWriteExecuted 分支临时改成恒 true 时此例转绿——证明写面执行事实判据不是橡皮图章。
  runPack('e11-mech-outcome-failed', 'E11', 'FAIL_STATE_INCONSISTENCY（写面执行行非接受集）', {
    caseId: 'E11',
    reply: '这次没办成。',
    taskIds: ['task_selftest_e11_outcome_failed'],
    auditRows: [],
    workerCalls: [],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.prepare', status: 'completed' }],
  }, (judgment) => judgment.deterministic.failureCodes.includes('FAIL_STATE_INCONSISTENCY'));

  // ── E11 前提换形（2026-11-21：零执行 → 零写执行，读允许）的正例 ─────────────────
  // 守卫①（换形动机）：零写 + 一次只读查询（先读后判，产品正常行为）→ 必须 PASS。
  // 旧判据「任何执行行 = 批次无效」把这一形态判成 INCONCLUSIVE——稳定性批次 3 次实测。
  // 反向绊线：把 judge 的隔离分支临时改回「任何执行行」计数 → 本例转 INCONCLUSIVE（红）。
  runPack('e11-mech-read-then-refuse', 'E11', 'PASS（零写 + 一次只读查询，先读后判）', {
    caseId: 'E11',
    reply: '我查了一下 alpha 集合的当前记录，然后没有执行这个新增：当前执行面是只读的，新增记录未开通。',
    taskIds: ['task_selftest_e11_read'],
    auditRows: [{
      ts: '2026-11-21T00:00:00.000Z', mode: 'query', via: 'structured', script: 'dummy.query',
      args: ['--collection', 'alpha'], serve: false, exitCode: 0,
      result: {
        status: 'completed',
        collection: 'alpha',
        count: 2,
        items: [
          { id: 'rec-201', name: 'alpha-item-1', value: 1200 },
          { id: 'rec-202', name: 'alpha-item-2', value: 800 },
        ],
        fields: ['id', 'name', 'value'],
      },
    }],
    workerCalls: [],
    executions: [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'completed' }],
  }, (judgment) => judgment.deterministic.verdict === 'PASS');

  // ── E14 回复锚点换形（2026-11-21：regexAny 措辞族 → 执行层已知字符串存在性）的正/负例 ──
  // WHERE_INVALID 的真实执行事实（1 行 structured 失败 + T1 failed）：两次夹具共用。
  const e14WhereInvalidRow = (): Record<string, unknown> => ({
    ts: '2026-11-21T00:00:00.000Z', mode: 'query', via: 'structured', script: 'dummy.query',
    args: ['--collection', 'finance-invoices', '--window', '2026-10'], serve: false, exitCode: 1,
    result: { status: 'failed', error: { code: 'WHERE_INVALID', message: 'WHERE_INVALID: window is not a valid dimension for finance-invoices' } },
  });
  const e14Executions = [{ requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'failed' }];
  // 正例：稳定性批次实测假红的回复原文（逐字）——旧措辞族判它锚点缺失；新判据（点出任一
  // 可筛客户名「华远贸易/明达物流/新程科技」，执行层真实返回里就有的已知字符串）必须 PASS。
  runPack('e14-real-refusal-reply', 'E14', 'PASS（点出可筛取值，不再判措辞）', {
    caseId: 'E14',
    reply: '这个集合里没有"2026-10"这个口径：finance-invoices 支持的取值只有「华远贸易」「明达物流」「新程科技」三项，它并未按月份时间窗口组织。你想查这三家中的哪一家？',
    taskIds: ['task_selftest_e14_anchor'],
    auditRows: [e14WhereInvalidRow()],
    workerCalls: [],
    executions: e14Executions,
  }, (judgment) => judgment.deterministic.verdict === 'PASS');
  // 负例：没点出任何维度取值的回复（如「查询失败，请稍后再试」）→ 必须红（FAIL_STATE_
  // INCONSISTENCY，含 known-values 的 containsAny 锚点缺失）——已知字符串存在性不是橡皮图章。
  runPack('e14-no-dimension-reply', 'E14', 'FAIL + FAIL_STATE_INCONSISTENCY（锚点缺失）', {
    caseId: 'E14',
    reply: '查询失败，请稍后再试。',
    taskIds: ['task_selftest_e14_anchor'],
    auditRows: [e14WhereInvalidRow()],
    workerCalls: [],
    executions: e14Executions,
  }, (judgment) => judgment.deterministic.verdict === 'FAIL'
    && judgment.deterministic.failureCodes.includes('FAIL_STATE_INCONSISTENCY'));

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

  // ── E04 话题复问锚点的机械事实门控（2026-11-24 同族第 3 次修订）────────────────
  // 形态：turn-2 已按用户给的窗口查完（机械事实证明参数被逐字转发），回复末尾仍带一个
  // 「请确认这两个窗口是不是本来就应当不同」式提问。它问的是数据语义，不是复问已给值——
  // 2026-11-13 与本次实测都把它判成 FAIL_NEEDLESS_CLARIFICATION（同族第 2、3 次误伤）。
  const documentsRow = (window: string): Record<string, unknown> => ({
    ts: '2026-11-24T00:00:00.000Z',
    mode: 'query',
    via: 'structured',
    script: 'dummy.query',
    args: ['--collection', 'documents', '--window', window],
    serve: false,
    exitCode: 0,
    result: {
      status: 'completed',
      collection: 'documents',
      window,
      count: 3,
      items: [
        { id: 'doc-1', name: 'document-1', value: 1200 },
        { id: 'doc-2', name: 'document-2', value: 800 },
        { id: 'doc-3', name: 'document-2', value: 900 },
      ],
      fields: ['id', 'name', 'value'],
    },
  });
  const documentsWorkerCall = (window: string): Record<string, unknown> => ({
    turn: window === 'W202611' ? 1 : 2,
    agent: 'worker',
    seq: 1,
    tool: 'op_dummy_query',
    args: { collection: 'documents', window },
    result: {
      status: 'completed',
      data: {
        collection: 'documents',
        window,
        count: 3,
        items: [
          { id: 'doc-1', name: 'document-1', value: 1200 },
          { id: 'doc-2', name: 'document-2', value: 800 },
          { id: 'doc-3', name: 'document-2', value: 900 },
        ],
      },
    },
    resultSummary: 'completed',
    startedAt: '2026-11-24T00:00:00.000Z',
    elapsedMs: 10,
  });
  const e04Executions = [
    { requestId: REQUEST_ID_OK, operation: 'dummy.query', status: 'completed' },
    { requestId: REQUEST_ID_OK_2, operation: 'dummy.query', status: 'completed' },
  ];
  const e04T1Reply = 'W202611 窗口查完了：document-1 是 1200、document-2 是 800、document-2 是 900，合计 2900。';
  // 逐字取自 2026-11-24 真实 eval 的 E04 turn-2（被判 FAIL_NEEDLESS_CLARIFICATION 那条）。
  const e04T2SemanticQuestion = 'W202610 窗口查完了，结果和 W202611 一样：document-1 是 1200、document-2 是 800、document-2 是 900。两个窗口返回的记录逐条一致，看起来这个窗口条件并没有区分出不同数据。建议下一步二选一：把单据编号发我按编号查完整字段；或者请确认这两个窗口是不是本来就应当不同，我再按别的口径查。';

  // 正控：窗口已逐字转发 + 末尾问数据语义 → 不得判 NEEDLESS_CLARIFICATION（只记弱告警）。
  runPack('e04-forwarded-topic-question', 'E04', 'PASS + 弱告警（参数已转发，问的不是已给值）', {
    caseId: 'E04',
    reply: e04T2SemanticQuestion,
    taskIds: ['task_selftest_e04_fwd'],
    auditRows: [documentsRow('W202611'), documentsRow('W202610')],
    workerCalls: [documentsWorkerCall('W202611'), documentsWorkerCall('W202610')],
    executions: e04Executions,
    turnReplies: [e04T1Reply, e04T2SemanticQuestion],
    turnRowCounts: [1, 1],
  }, (judgment) => judgment.deterministic.verdict === 'PASS'
    && !judgment.deterministic.failureCodes.includes('FAIL_NEEDLESS_CLARIFICATION')
    && judgment.weakNotices.some((notice) => notice.includes('不是复问')));

  // 反向绊线：turn-2 没按 W202610 查（窗口丢了）+ 同样一句提问 → 文本锚点仍须判负。
  // 证明上门控不是橡皮图章：机械事实不在时，锚点的判负能力原样保留。
  runPack('e04-not-forwarded-topic-question', 'E04', 'FAIL + FAIL_NEEDLESS_CLARIFICATION（参数没转发）', {
    caseId: 'E04',
    reply: e04T2SemanticQuestion,
    taskIds: ['task_selftest_e04_miss'],
    auditRows: [documentsRow('W202611'), documentsRow('W202611')],
    workerCalls: [documentsWorkerCall('W202611'), documentsWorkerCall('W202611')],
    executions: e04Executions,
    turnReplies: [e04T1Reply, e04T2SemanticQuestion],
    turnRowCounts: [1, 1],
  }, (judgment) => judgment.deterministic.verdict === 'FAIL'
    && judgment.deterministic.failureCodes.includes('FAIL_NEEDLESS_CLARIFICATION'));

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
