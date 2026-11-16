/**
 * SimCase 薄机制 · 七项机制自检（确定性假件；**零真实模型**）。
 *
 * 目的：证明「机制本身可靠」，不是证明业务能力。被测系统、模拟用户、判官全部用脚本化
 * 假件，不读 LLM_API_KEY、不触网、不写产品码。
 *
 * 用法（仓库根）：
 *   TMPDIR=/tmp/sim-eval-tmp node --import tsx scripts/eval/sim/selftest.ts
 * 退出码 0 = 七项全过；1 = 至少一项失败（逐项打印失败原因，不筛绿）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSimSuite, runSimTrial, writeSimTrialEvidence, type SimSystemCall } from './run';
import type { SimCase } from './case';
import { createReplyOracle, resolveOracle, type SimOracle } from './oracle';
import {
  EndlessSimulator, ReactivePersonaSimulator, ScriptedSimulator, ScriptedSystem,
  finishCompletion, sayCompletion,
} from './fakes';
import { SIM_CASE_ORACLES, SIM_CASES } from './cases';

interface CheckOutcome {
  readonly id: number;
  readonly name: string;
  readonly ok: boolean;
  readonly evidence: readonly string[];
}

type Check = (outRoot: string) => Promise<CheckOutcome>;

const MAIN_CALL: SimSystemCall = { kind: 'main', tokens: { input: 10, output: 5, total: 15 }, tokensObserved: true };
const SUMMARY_CALL: SimSystemCall = { kind: 'summary', tokens: { input: 40, output: 10, total: 50 }, tokensObserved: true };
const OK_ORACLE: SimOracle = createReplyOracle({ id: 'reply:ok', required: ['合计'], truthPatterns: ['2000'] });

function simCase(overrides: Partial<SimCase> = {}): SimCase {
  return {
    id: 'SELF',
    goal: '核对 alpha 集合的合计',
    persona: '谨慎的业务员',
    knowledge: ['alpha 集合我有权限'],
    initialMessage: '帮我看一下 alpha 的合计',
    behaviorRules: ['一次只问一件事'],
    forbiddenKnowledge: ['内部工单号 INC-7788'],
    allowedActions: ['say', 'wait', 'finish'],
    terminal: { satisfied: '拿到合计金额', gaveUp: '系统反复答非所问' },
    fixtureId: 'dummy-fixture-alpha',
    oracleId: 'reply:ok',
    limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
    ...overrides,
  };
}

function summarise(id: number, name: string, ok: boolean, evidence: string[]): CheckOutcome {
  return { id, name, ok, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 污染检测真的会拦
// ─────────────────────────────────────────────────────────────────────────────
const check1: Check = async (outRoot) => {
  const system = new ScriptedSystem([{ visibleReply: 'alpha 共 2 条，合计 2000。' }]);
  const simulator = new ScriptedSimulator([sayCompletion('我记得合计是 2000 吧？')]);
  const result = await runSimTrial(simCase(), 1, {
    outRoot, createSystem: () => system, simulator, oracle: OK_ORACLE,
  });
  const dir = writeSimTrialEvidence(result);
  const ok = result.terminal === 'contaminated' && result.pass === false && result.oracle === null
    && JSON.stringify(result.contamination?.hits) === JSON.stringify([{ source: 'truth', pattern: '2000' }])
    && system.sends.length === 1;
  return summarise(1, '污染检测：模拟用户说出真值 → contaminated，不通过', ok, [
    `terminal=${String(result.terminal)} pass=${result.pass} oracle=${result.oracle === null ? 'null' : 'judged'}`,
    `hits=${JSON.stringify(result.contamination?.hits)}`,
    `original=${JSON.stringify(result.contamination?.original)}`,
    `系统实收消息数=${system.sends.length}（说真值那条未发送）`,
    `证据=${path.relative(outRoot, dir)}/trial.json`,
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 2) gave_up 不算通过（同一正确回复下与 satisfied 对照）
// ─────────────────────────────────────────────────────────────────────────────
const check2: Check = async (outRoot) => {
  const reply = 'alpha 共 2 条，合计 2000。';
  const control = await runSimTrial(simCase({ id: 'SELF-SAT' }), 1, {
    outRoot, createSystem: () => new ScriptedSystem([{ visibleReply: reply }]),
    simulator: new ScriptedSimulator([finishCompletion('satisfied', '拿到合计')]), oracle: OK_ORACLE,
  });
  const gaveUp = await runSimTrial(simCase({ id: 'SELF-GIVEUP' }), 1, {
    outRoot, createSystem: () => new ScriptedSystem([{ visibleReply: reply }]),
    simulator: new ScriptedSimulator([finishCompletion('gave_up', '反复答非所问')]), oracle: OK_ORACLE,
  });
  writeSimTrialEvidence(control);
  const dir = writeSimTrialEvidence(gaveUp);
  const ok = control.pass === true && gaveUp.terminal === 'gave_up' && gaveUp.pass === false && gaveUp.oracle === null;
  return summarise(2, 'gave_up 不算通过：同一正确回复，satisfied 过、gave_up 不过', ok, [
    `对照 satisfied：terminal=${String(control.terminal)} pass=${control.pass} oraclePass=${String(control.oracle?.verdict.pass)}`,
    `实测 gave_up：terminal=${String(gaveUp.terminal)} pass=${gaveUp.pass} oracle=${gaveUp.oracle === null ? 'null（未判）' : 'judged'}`,
    `证据=${path.relative(outRoot, dir)}/trial.json`,
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 3) 预算真的会停（无限追问）
// ─────────────────────────────────────────────────────────────────────────────
const check3: Check = async (outRoot) => {
  const system = new ScriptedSystem([{ visibleReply: '请再说明一下' }], { fallback: { visibleReply: '请再说明一下' } });
  const simulator = new EndlessSimulator();
  const limit = 4;
  const result = await runSimTrial(
    simCase({ id: 'SELF-ENDLESS', limits: { maxUserTurns: limit, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 } }), 1,
    { outRoot, createSystem: () => system, simulator, oracle: OK_ORACLE },
  );
  const dir = writeSimTrialEvidence(result);
  const ok = result.terminal === 'budget_exhausted' && result.exhaustedBy === 'user_turns' && result.pass === false
    && system.sends.length === limit && simulator.prompts.length === limit - 1;
  return summarise(3, '预算真的会停：无限追问到 maxUserTurns 停（budget_exhausted）', ok, [
    `maxUserTurns=${limit} terminal=${String(result.terminal)} exhaustedBy=${String(result.exhaustedBy)} pass=${result.pass}`,
    `模拟用户被询问次数=${simulator.prompts.length}（= maxUserTurns-1，之后不再询问）`,
    `系统实收消息数=${system.sends.length}（= maxUserTurns，第 ${limit + 1} 条从未产生）`,
    `证据=${path.relative(outRoot, dir)}/trial.json`,
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 4) 注入锚点真的命中（确定性计数，不挂墙钟）
// ─────────────────────────────────────────────────────────────────────────────
function anchorLog(system: ScriptedSystem): string[] {
  return system.injections.map((injection, index) =>
    `turn ${index + 1}: injection=${injection === null ? 'null' : JSON.stringify(injection)} applied=${system.applied[index] === true}`);
}

const check4: Check = async (outRoot) => {
  const turnSystem = new ScriptedSystem(
    [{ visibleReply: 'alpha 共 2 条，合计 2000。' }],
    { honorInjection: true, fallback: { visibleReply: 'alpha 共 2 条，合计 2000。' } },
  );
  const byTurn = await runSimTrial(
    simCase({ id: 'SELF-INJ-TURN', injection: { anchor: 'systemTurn', at: 2, kind: 'pre_turn_fault' } }), 1,
    {
      outRoot,
      createSystem: () => turnSystem,
      simulator: new ScriptedSimulator([sayCompletion('再核对一次'), finishCompletion('satisfied', '完成')]),
      oracle: OK_ORACLE,
    },
  );
  const byCall = await runSimTrial(
    simCase({ id: 'SELF-INJ-CALL', injection: { anchor: 'toolCall', at: 3, kind: 'exec_call_failure' } }), 1,
    {
      outRoot,
      createSystem: () => new ScriptedSystem(
        [{ visibleReply: 'alpha 共 2 条，合计 2000。', toolCalls: 1 }],
        { honorInjection: true, fallback: { visibleReply: 'alpha 共 2 条，合计 2000。', toolCalls: 1 } },
      ),
      simulator: new ScriptedSimulator([
        sayCompletion('补一句'), sayCompletion('再补一句'), finishCompletion('satisfied', '完成'),
      ]),
      oracle: OK_ORACLE,
    },
  );
  const notHonored = await runSimTrial(
    simCase({ id: 'SELF-INJ-NOOP', injection: { anchor: 'systemTurn', at: 2, kind: 'pre_turn_fault' } }), 1,
    {
      outRoot,
      createSystem: () => new ScriptedSystem(
        [{ visibleReply: 'alpha 共 2 条，合计 2000。' }],
        { fallback: { visibleReply: 'alpha 共 2 条，合计 2000。' } },
      ),
      simulator: new ScriptedSimulator([sayCompletion('再核对一次'), finishCompletion('satisfied', '完成')]),
      oracle: OK_ORACLE,
    },
  );
  writeSimTrialEvidence(byTurn);
  writeSimTrialEvidence(byCall);
  writeSimTrialEvidence(notHonored);
  const t = byTurn.injection;
  const c = byCall.injection;
  const n = notHonored.injection;
  const ok = t?.planned === true && t.applied === true && t.appliedTurn === 2 && t.reason === 'applied'
    && c?.applied === true && c.appliedTurn === 3
    && n?.applied === false && n.reason === 'fake 未应用注入';
  return summarise(4, '注入锚点真的命中：systemTurn@2 / toolCall@3 按计数触发，未实现如实记否', ok, [
    'systemTurn@2 每回合注入日志：',
    ...anchorLog(turnSystem).map((line) => `  ${line}`),
    `systemTurn@2 report=${JSON.stringify(t)}`,
    `toolCall@3  report=${JSON.stringify(c)}`,
    `适配器未实现 report=${JSON.stringify(n)}（不伪造命中）`,
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 5) 并发隔离（并发 5 · 5 条假会话）
// ─────────────────────────────────────────────────────────────────────────────
const check5: Check = async (outRoot) => {
  const systems: string[] = [];
  const result = await runSimSuite({
    cases: Array.from({ length: 5 }, (_, index) => simCase({
      id: `SELF-ISO-${index + 1}`,
      limits: { maxUserTurns: 4, maxWaitTurns: 1, maxWallMs: 60_000, trials: 1 },
    })),
    outRoot,
    concurrency: 5,
    createSystem: async (paths) => {
      writeFileSync(path.join(paths.sessionDir, 'marker.txt'), paths.root, 'utf8');
      writeFileSync(paths.stateDbPath, paths.root, 'utf8');
      systems.push(paths.root);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const turn = { visibleReply: 'alpha 共 2 条，合计 2000', calls: [MAIN_CALL] };
      return new ScriptedSystem([turn], { fallback: turn });
    },
    simulator: { async complete() { return finishCompletion('satisfied', '完成'); } },
    oracles: [OK_ORACLE],
  });

  const isolationOk = result.summary.isolation.uniqueSessionDirs && result.summary.isolation.uniqueStateDbPaths
    && result.summary.isolation.uniqueEvidenceDirs && result.summary.isolation.dirsCreated
    && result.summary.isolation.shared.length === 0;
  const markersOk = result.trials.every((trial) =>
    readFileSync(path.join(trial.paths.sessionDir, 'marker.txt'), 'utf8') === trial.paths.root
    && readFileSync(trial.paths.stateDbPath, 'utf8') === trial.paths.root);
  const ok = result.trials.length === 5 && result.batch.observedMaxConcurrency === 5
    && isolationOk && markersOk && new Set(systems).size === 5;
  const lines = result.trials
    .slice()
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .map((trial) => `  ${trial.caseId}#${trial.trial}: session=${path.relative(outRoot, trial.paths.sessionDir)}`
      + ` stateDb=${path.relative(outRoot, trial.paths.stateDbPath)} evidence=${path.relative(outRoot, trial.paths.evidenceDir)}`
      + ` marker=${readFileSync(path.join(trial.paths.sessionDir, 'marker.txt'), 'utf8') === trial.paths.root ? 'own' : 'MISMATCH'}`);
  return summarise(5, '并发隔离：concurrency=5 跑 5 条假会话，目录/DB 不共享', ok, [
    `outRoot=${outRoot}`,
    `batch.concurrency=${result.batch.policy.concurrency} observedMaxConcurrency=${result.batch.observedMaxConcurrency}`,
    `isolation=${JSON.stringify(result.summary.isolation)}`,
    ...lines,
    `unique sessionDir/stateDb/evidence = ${new Set(result.trials.map((t) => t.paths.sessionDir)).size}`
      + `/${new Set(result.trials.map((t) => t.paths.stateDbPath)).size}`
      + `/${new Set(result.trials.map((t) => t.paths.evidenceDir)).size}`,
    `counts: trials=${result.summary.n} passed=${result.summary.passed} simulatorCalls=${result.summary.accounting.byKind.simulator.calls} mainCalls=${result.summary.accounting.byKind.main.calls}`,
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 6) 记账分离（simulator / judge / 被测系统）
// ─────────────────────────────────────────────────────────────────────────────
const check6: Check = async (outRoot) => {
  const judgeOracle: SimOracle = {
    id: 'judge:selftest',
    truthPatterns: [],
    async judge(_ctx, tools) {
      const output = await tools.complete('请核对最终回复');
      return { pass: output.text.includes('通过'), detail: {} };
    },
  };
  const result = await runSimTrial(simCase({ id: 'SELF-ACC' }), 1, {
    outRoot,
    createSystem: () => new ScriptedSystem([{ visibleReply: 'alpha 共 2 条，合计 2000。', calls: [MAIN_CALL, SUMMARY_CALL] }]),
    simulator: new ScriptedSimulator([finishCompletion('satisfied', '完成')]),
    judge: { async complete() { return { text: '通过', tokens: { input: 7, output: 3, total: 10 }, tokensObserved: true }; } },
    oracle: judgeOracle,
  });
  const dir = writeSimTrialEvidence(result);
  const usage = result.accounting;
  const kinds = ['simulator', 'judge', 'main', 'summary'] as const;
  const ok = usage.byKind.simulator.calls === 1 && usage.byKind.judge.calls === 1
    && usage.byKind.main.calls === 1 && usage.byKind.summary.calls === 1
    && usage.byKind.simulator.tokens === 120 && usage.byKind.judge.tokens === 10
    && usage.byKind.main.tokens === 15 && usage.byKind.summary.tokens === 50
    && usage.byKind.simulator.tokens + usage.byKind.judge.tokens + usage.byKind.main.tokens + usage.byKind.summary.tokens === usage.tokens;
  return summarise(6, '记账分离：simulator / judge / 被测系统 main·summary 分开统计', ok, [
    ...kinds.map((kind) => `  kind=${kind.padEnd(9)} calls=${usage.byKind[kind].calls} tokens=${usage.byKind[kind].tokens}`),
    `total calls=${usage.calls} tokens=${usage.tokens} tokensObserved=${usage.tokensObserved}`,
    `unobservedKinds=${JSON.stringify(usage.unobservedKinds)}`,
    `证据=${path.relative(outRoot, dir)}/accounting.json`,
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 7) 轨迹会分叉（同一用例，两个 persona/behavior）
// ─────────────────────────────────────────────────────────────────────────────
const check7: Check = async (outRoot) => {
  const base = SIM_CASES.find((caseDef) => caseDef.id === 'SIM-01');
  if (base === undefined) throw new Error('SIM-01 用例缺失');
  const thorough: SimCase = {
    ...base, id: 'SELF-DIV-A',
    persona: '严谨的项目助理，拿到结果会再要一次确认前后一致，说话简短。',
    behaviorRules: ['拿到结果后再要一次同一份结果，确认两次一致才收尾', '不自己报数字'],
  };
  const impatient: SimCase = {
    ...base, id: 'SELF-DIV-B',
    persona: '急躁的项目助理，看到结果就走，不额外确认，说话简短。',
    behaviorRules: ['一次拿到结果就收尾，不再追问、不再确认', '不自己报数字'],
  };
  const patient: SimCase = {
    ...base, id: 'SELF-DIV-C',
    persona: '耐心的项目助理，结果出来之前愿意先等一会儿，不被催着走。',
    behaviorRules: ['结果出来之前先等一会儿，再决定要不要再要一次', '不自己报数字'],
  };
  const turns = [
    { visibleReply: 'alpha 共 2 条，合计 2000。需要我再发一次吗？', toolCalls: 1, executions: [{ operation: 'dummy.query', status: 'completed' }] },
    { visibleReply: '刚才那份结果：alpha 共 2 条，合计 2000。', toolCalls: 0, executions: [] },
  ];
  const runOne = async (caseDef: SimCase, style: 'thorough' | 'impatient' | 'patient') => {
    const simulator = new ReactivePersonaSimulator(style);
    const system = new ScriptedSystem(turns);
    const result = await runSimTrial(caseDef, 1, {
      outRoot, createSystem: () => system, simulator, oracle: resolveOracle(caseDef.oracleId, SIM_CASE_ORACLES),
    });
    writeSimTrialEvidence(result);
    return { result, simulator, system };
  };
  const runs = [
    { label: '严谨版', caseDef: thorough, run: await runOne(thorough, 'thorough') },
    { label: '急躁版', caseDef: impatient, run: await runOne(impatient, 'impatient') },
    { label: '耐心版', caseDef: patient, run: await runOne(patient, 'patient') },
  ] as const;

  const skeleton = (user: string, caseDef: SimCase): string => {
    const remove = new Set([caseDef.persona, ...caseDef.behaviorRules.map((rule) => `- ${rule}`)]);
    return user.split('\n').filter((line) => !remove.has(line.trim())).join('\n');
  };
  const skeletons = runs.map(({ caseDef, run }) => {
    const prompt = run.simulator.prompts[0];
    return prompt === undefined ? '' : skeleton(prompt.user, caseDef);
  });
  const promptSameBesidesPersona = skeletons.every((item) => item !== '' && item === skeletons[0]);
  const signatures = runs.map(({ run }) => JSON.stringify({
    actions: run.result.messages.map((message) => message.action),
    sends: run.system.sends,
  }));
  const distinct = new Set(signatures).size;
  const [thoroughRun, impatientRun, patientRun] = runs;
  // 反向绊线：急躁版只走到第一步（首轮答完就 finish），terminal 仍是 satisfied（用户满意），
  // 但 Oracle 必须判 false——不允许「同一条回复同时满足 initial 与 recall」的假绿。
  const separated = thoroughRun.run.result.pass === true
    && patientRun.run.result.pass === true
    && impatientRun.run.result.terminal === 'satisfied'
    && impatientRun.run.result.pass === false
    && impatientRun.run.result.oracle?.verdict.pass === false;

  const trace = (label: string, run: typeof runs[number]['run']): string[] => [
    `  ${label}: terminal=${String(run.result.terminal)} pass=${run.result.pass} 消息=${run.result.messages.map((m) => m.action).join('→')}`
      + ` 系统收话=${run.system.sends.length} 模拟用户调用=${run.simulator.prompts.length}`,
    ...run.result.messages.map((message, index) =>
      `    [${index + 1}] ${message.action}${message.text === undefined ? '' : `: ${message.text}`}`),
  ];
  const ok = distinct === 3 && promptSameBesidesPersona && separated;
  return summarise(7, '轨迹会分叉 + 未达第二步不算通过（用户满意 ≠ Oracle 通过）', ok, [
    ...runs.flatMap(({ label, run }) => trace(label, run)),
    `首轮 prompt 去掉人设/行为规则后三份逐字相同=${promptSameBesidesPersona}（Harness 未注入路径）`,
    `不同轨迹数=${distinct}/3`,
    `严谨/耐心 走到第二步 Oracle 判真=${thoroughRun.run.result.pass}/${patientRun.run.result.pass}；`
      + `急躁版 terminal=satisfied 但 Oracle 判负=${impatientRun.run.result.terminal === 'satisfied' && impatientRun.run.result.pass === false}`
      + `（second_ask_made=${String((impatientRun.run.result.oracle?.verdict.detail['checks'] as Record<string, unknown> | undefined)?.['second_ask_made'])}）`,
  ]);
};

// ─────────────────────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────────────────────
const CHECKS: readonly Check[] = [check1, check2, check3, check4, check5, check6, check7];

const outRoot = mkdtempSync(path.join(tmpdir(), 'sim-selftest-'));
const outcomes: CheckOutcome[] = [];
for (const check of CHECKS) {
  try {
    outcomes.push(await check(outRoot));
  } catch (error) {
    outcomes.push(summarise(outcomes.length + 1, 'check 抛错', false, [String(error)]));
  }
}

for (const outcome of outcomes) {
  console.log(`[${outcome.ok ? 'PASS' : 'FAIL'}] ${outcome.id}) ${outcome.name}`);
  for (const line of outcome.evidence) console.log(line);
  console.log('');
}

const passed = outcomes.filter((outcome) => outcome.ok).length;
console.log(`SELFTEST ${passed}/${outcomes.length} PASS · outRoot=${outRoot}`);
if (passed !== outcomes.length) process.exitCode = 1;
