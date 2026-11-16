/**
 * SimCase 薄机制 · trial 执行 + 样本级并发池 + 证据落盘（确定性位置，不挂墙钟注入）。
 *
 * 一个 trial = 「模拟用户 ↔ 被测系统」多轮对话：
 *   · 首条 `initialMessage` 也算一条用户消息，先过污染检测；
 *   · 每轮模拟用户只看**用户可见回复** + 自己的历史 + goal/persona/knowledge/behaviorRules；
 *   · 动作只有 say / wait / finish；预算 = maxUserTurns / maxWaitTurns / maxWallMs；
 *   · 终态分开记：satisfied / gave_up / budget_exhausted / contaminated / protocol_error；
 *     只有 satisfied **且** Oracle 判真值通过才 pass；gave_up / protocol_error 永不算通过；
 *   · 模拟用户输出无法解析成合法动作时，先做最多 `SIM_PROTOCOL_REPAIRS` 次修复重问
 *     （每次计入 `kind: simulator`，原始输出全部留证）；仍失败 → 终态 `protocol_error`；
 *   · 其它协议缺陷（prompt 泄漏 / oracle 未知 / 用例卫生）不冒充任何终态：
 *     记 `terminal: null` + `error`，保留全样本。
 *
 * 并发：样本级并发池（缺省 5，见 case.ts `SIM_DEFAULT_CONCURRENCY`），每 trial 独立目录
 * （sessionDir / state.db / evidence 目录），并发 ≥2 时断言目录不共享。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runBatch, type BatchReport } from '../business-e2e/batch';
import { sha256Hex } from '../convergence-r1/hash';
import type { CallKind, CallTokens } from '../r6/accounting';
import {
  accountSimCalls, emptySimAccounting,
  type SimAccounting, type SimCallKind, type SimCallRecord,
} from './accounting';
import {
  SIM_DEFAULT_CONCURRENCY, SIM_PROTOCOL_REPAIRS, expandSimTrials, parseSimAction, validateSimCase,
  type SimCase, type SimBudgetReason, type SimFinishKind, type SimItem, type SimTerminal,
} from './case';
import { detectContamination, normalizeForMatch, type ContaminationReport } from './contamination';
import { InjectionTracker, type InjectionDirective, type InjectionReport } from './injection';
import {
  buildSkillTelemetry, emptySkillTelemetry, unavailableSkillDiscovery,
  type SimSkillDiscovery, type SimSkillRead, type SimSkillTelemetry,
} from './skill-telemetry';
import {
  buildRepairPrompt, buildSimulatorPrompt, findCaseLeaks, findPromptLeaks, hasRepeatedUserIntent,
  type SimModel, type SimulatorView,
} from './simulator';
import { resolveOracle, type SimExecutionFact, type SimJudgeTools, type SimOracle, type SimOracleVerdict } from './oracle';

// ─────────────────────────────────────────────────────────────────────────────
// 被测系统会话面（真实 = 生产同源装配适配，见 ./ask-adapter；测试 = 确定性假件）
// ─────────────────────────────────────────────────────────────────────────────

/** 系统面逐次调用上报（缺省 = 该系统面不暴露，记账标注不可得，不编造）。 */
export interface SimSystemCall {
  readonly kind: CallKind;
  readonly tokens?: CallTokens;
  readonly tokensObserved?: boolean;
}

export interface SimSystemTurn {
  /** **用户可见**回复（模拟用户只能看到这个；内部字段不得塞进来）。 */
  readonly visibleReply: string;
  /** 本回合执行调用数（注入锚点计数 + 证据）。 */
  readonly toolCalls?: number;
  /** 本回合事件数。 */
  readonly events?: number;
  /** 本回合执行事实（给 Oracle 的机械投影）。 */
  readonly executions?: readonly SimExecutionFact[];
  /** 适配器是否真的应用了注入（不实现该锚点必须如实 false）。 */
  readonly injectionApplied?: boolean;
  readonly injectionReason?: string;
  /** 逐次模型调用上报；undefined = 不暴露。 */
  readonly calls?: readonly SimSystemCall[];
  /** 本回合 `read_skill` 读取遥测；undefined = 该回合未暴露/未发生读取（按已观测调用计）。 */
  readonly skillReads?: readonly SimSkillRead[];
}

export interface SimSystemUnderTest {
  send(text: string, ctx: { readonly injection: InjectionDirective | null }): Promise<SimSystemTurn>;
  /**
   * 可选：本 trial 的技能 catalog 发现读数（创建后一次；只读观测，不参与判定）。
   * 不实现 = 该系统面不暴露技能发现（证据记 available=false）。
   */
  skillDiscovery?(): SimSkillDiscovery | Promise<SimSkillDiscovery>;
}

// ─────────────────────────────────────────────────────────────────────────────
// trial 目录（每 trial 独立：session / state.db / evidence）
// ─────────────────────────────────────────────────────────────────────────────

export interface SimTrialPaths {
  readonly root: string;
  readonly sessionDir: string;
  readonly stateDbPath: string;
  readonly evidenceDir: string;
}

export function simTrialPaths(outRoot: string, caseId: string, trial: number): SimTrialPaths {
  const root = path.join(outRoot, caseId, String(trial));
  return {
    root,
    sessionDir: path.join(root, 'session'),
    stateDbPath: path.join(root, 'state.db'),
    evidenceDir: path.join(root, 'evidence'),
  };
}

export function ensureTrialPaths(paths: SimTrialPaths): void {
  mkdirSync(paths.sessionDir, { recursive: true });
  mkdirSync(paths.evidenceDir, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// trial 执行
// ─────────────────────────────────────────────────────────────────────────────

export interface SimMessageRecord {
  /** 用户消息序号（wait 不推进序号，沿用下一条待发序号）。 */
  readonly turn: number;
  readonly action: 'say' | 'wait' | 'finish';
  readonly text?: string;
  readonly reason?: string;
  readonly finishKind?: SimFinishKind;
  readonly contamination?: ContaminationReport;
}

export interface SimTrialDeps {
  readonly outRoot: string;
  /** 每 trial 独立装配（sessionDir/stateDbPath 来自 paths）。 */
  readonly createSystem: (paths: SimTrialPaths, caseDef: SimCase) => SimSystemUnderTest | Promise<SimSystemUnderTest>;
  readonly simulator: SimModel;
  /** 判官模型（只有模型 Oracle 需要；确定性 Oracle 不产生 judge 调用）。 */
  readonly judge?: SimModel;
  readonly oracle: SimOracle;
  /** 注入墙钟（**只用于 maxWallMs 预算**，不作注入锚点）。 */
  readonly now?: () => number;
  /**
   * 协议修复重问次数上限（缺省 `SIM_PROTOCOL_REPAIRS`=2）。
   * 只为反向绊线/消融保留可关闭开关；真实跑批不得把它调成 0。
   */
  readonly maxProtocolRepairs?: number;
}

/** 一次 trial 内协议修复的全量留证（恢复成功也保留，便于复核修复成本）。 */
export interface SimProtocolLog {
  /** 已执行的修复重问次数（不含首答）。 */
  readonly repairs: number;
  /** 首答 + 每次修复重问的原始输出（逐条留证）。 */
  readonly rawOutputs: readonly string[];
  /** 每次解析失败的错误描述（与 rawOutputs 同序，长度 = rawOutputs.length）。 */
  readonly errors: readonly string[];
}

export interface SimTrialResult {
  readonly caseId: string;
  readonly trial: number;
  /** 五类终态；`null` = Harness/协议缺陷（不冒充终态，永不 pass）。 */
  readonly terminal: SimTerminal | null;
  readonly pass: boolean;
  readonly exhaustedBy: SimBudgetReason | null;
  readonly messages: readonly SimMessageRecord[];
  readonly replies: readonly string[];
  /** 跨回合汇总的机械执行事实（给 Oracle + 严重失败机械检查）。 */
  readonly executions: readonly SimExecutionFact[];
  /** 第一条污染报告（原文 + 命中项）；null = 全程未污染。 */
  readonly contamination: ContaminationReport | null;
  readonly injection: InjectionReport | null;
  readonly oracle: { readonly id: string; readonly verdict: SimOracleVerdict } | null;
  /** 逐次调用记录（simulator / judge / 系统四类）；套装合计时重新编号合并。 */
  readonly calls: readonly SimCallRecord[];
  readonly accounting: SimAccounting;
  /** 系统面是否暴露逐次调用（false = 只记不可得，不编造 main/summary…）。 */
  readonly systemAccountingAvailable: boolean;
  /** 技能链路遥测（发现 / 读取 / 隔离）；只解释，不参与 pass。 */
  readonly skills: SimSkillTelemetry;
  readonly paths: SimTrialPaths;
  /** 协议修复留证；undefined = 全程首答即合法（没有发生过解析失败）。 */
  readonly protocol?: SimProtocolLog;
  readonly error?: string;
}

function tokensOf(spec: SimSystemCall): CallTokens {
  return spec.tokens ?? { input: 0, output: 0, total: 0 };
}

/** 跑一个 trial。返回全量证据；不抛异常（协议/装配缺陷记 error + terminal null）。 */
export async function runSimTrial(caseDef: SimCase, trial: number, deps: SimTrialDeps): Promise<SimTrialResult> {
  const paths = simTrialPaths(deps.outRoot, caseDef.id, trial);
  ensureTrialPaths(paths);
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const messages: SimMessageRecord[] = [];
  const replies: string[] = [];
  const records: SimCallRecord[] = [];
  const executions: SimExecutionFact[] = [];
  let seq = 0;
  let systemAccountingAvailable = true;
  /** 协议修复留证（首次解析失败时建立；恢复成功也保留，跨回合累计）。 */
  const protocolRawOutputs: string[] = [];
  const protocolErrors: string[] = [];
  let protocolRepairs = 0;
  let protocolLog: SimProtocolLog | null = null;

  const recordCall = (kind: SimCallKind, turn: number, tokens?: CallTokens, observed?: boolean, durationMs = 0): void => {
    seq += 1;
    records.push({
      seq,
      kind,
      turn,
      tokens: tokens ?? { input: 0, output: 0, total: 0 },
      tokensObserved: observed ?? false,
      durationMs,
    });
  };

  const skillReads: SimSkillRead[] = [];
  let skillDiscovery: SimSkillDiscovery | undefined;

  const build = (input: {
    terminal: SimTerminal | null;
    pass: boolean;
    exhaustedBy: SimBudgetReason | null;
    contamination: ContaminationReport | null;
    injection: InjectionReport | null;
    oracle: SimTrialResult['oracle'];
    error?: string;
  }): SimTrialResult => ({
    caseId: caseDef.id,
    trial,
    terminal: input.terminal,
    pass: input.pass,
    exhaustedBy: input.exhaustedBy,
    messages,
    replies,
    executions,
    contamination: input.contamination,
    injection: input.injection,
    oracle: input.oracle,
    calls: records,
    accounting: accountSimCalls(records),
    systemAccountingAvailable,
    skills: buildSkillTelemetry(skillDiscovery, skillReads),
    paths,
    ...(protocolLog === null ? {} : { protocol: protocolLog }),
    ...(input.error === undefined ? {} : { error: input.error }),
  });

  // 用例卫生（先验、零模型）：真值不得出现在喂给模拟用户的字段里。
  const leaks = findCaseLeaks(caseDef, deps.oracle.truthPatterns, normalizeForMatch);
  if (leaks.length > 0) {
    return build({
      terminal: null,
      pass: false,
      exhaustedBy: null,
      contamination: null,
      injection: null,
      oracle: null,
      error: `用例卫生失败：真值出现在模拟用户可见字段（${leaks.join(', ')}）`,
    });
  }
  const validation = validateSimCase(caseDef);
  if (!validation.ok) {
    return build({
      terminal: null,
      pass: false,
      exhaustedBy: null,
      contamination: null,
      injection: null,
      oracle: null,
      error: `SimCase 无效：${validation.errors.join('; ')}`,
    });
  }

  const system = await deps.createSystem(paths, caseDef);
  if (system.skillDiscovery !== undefined) {
    try {
      skillDiscovery = await system.skillDiscovery();
    } catch (error) {
      // 遥测失败不改判定：如实记录「发现失败」，trial 照常跑。
      skillDiscovery = unavailableSkillDiscovery(
        `技能发现失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const tracker = new InjectionTracker(caseDef.injection);
  const counts = { systemTurn: 0, toolCall: 0, event: 0 };
  const contaminationCheck = (message: string): ContaminationReport =>
    detectContamination(message, {
      forbiddenKnowledge: caseDef.forbiddenKnowledge,
      truthPatterns: deps.oracle.truthPatterns,
    });

  const sendToSystem = async (turn: number, text: string): Promise<string> => {
    const injection = tracker.beforeTurn(counts);
    const turnResult = await system.send(text, { injection });
    counts.systemTurn += 1;
    counts.toolCall += turnResult.toolCalls ?? 0;
    counts.event += turnResult.events ?? 0;
    // 机械标注触发该执行的用户消息序号（1 起）：Oracle 只用它划「找回之后」的时间边界。
    for (const execution of turnResult.executions ?? []) executions.push({ ...execution, turn });
    // 技能读取遥测（只记录，不参与任何判定）。
    for (const read of turnResult.skillReads ?? []) skillReads.push(read);
    if (turnResult.calls === undefined) {
      systemAccountingAvailable = false;
    } else {
      for (const call of turnResult.calls) recordCall(call.kind, turn, call.tokens, call.tokensObserved);
    }
    tracker.settle({
      turn: counts.systemTurn,
      counts,
      applied: turnResult.injectionApplied === true,
      ...(turnResult.injectionReason === undefined ? {} : { reason: turnResult.injectionReason }),
    });
    replies.push(turnResult.visibleReply);
    return turnResult.visibleReply;
  };

  // ① 首条消息：也算用户消息，先过污染检测（命中即作废，不发给系统）。
  const initialReport = contaminationCheck(caseDef.initialMessage);
  messages.push({
    turn: 1,
    action: 'say',
    text: caseDef.initialMessage,
    contamination: initialReport,
  });
  if (initialReport.contaminated) {
    return build({
      terminal: 'contaminated', pass: false, exhaustedBy: null, contamination: initialReport,
      injection: tracker.report(), oracle: null,
    });
  }
  let userTurns = 1;
  let waitTurns = 0;
  let lastReply = await sendToSystem(1, caseDef.initialMessage);

  /** 收尾（satisfied / repeat_guard 共用同一 Oracle 判定；pass 只由 Oracle 决定）。 */
  const finishWithOracle = async (): Promise<SimTrialResult> => {
    const judgeTools: SimJudgeTools = {
      complete: async (judgePrompt) => {
        if (deps.judge === undefined) throw new Error('该 Oracle 需要判官模型，但 deps.judge 未提供');
        const judgeStarted = now();
        const output = await deps.judge.complete({ system: '你是独立判官，只依据给出的判据核对系统回复。', user: judgePrompt });
        recordCall('judge', userTurns + 1, output.tokens, output.tokensObserved, now() - judgeStarted);
        return output;
      },
    };
    const verdict = await deps.oracle.judge(
      {
        finalReply: replies[replies.length - 1] ?? '',
        replies: [...replies],
        userMessages: messages.filter((m) => m.action === 'say').map((m) => m.text ?? ''),
        executions: [...executions],
      },
      judgeTools,
    );
    return build({
      terminal: 'satisfied',
      // 只有 satisfied **且** Oracle 判真值通过才算该 trial 通过。
      pass: verdict.pass === true,
      exhaustedBy: null,
      contamination: null,
      injection: tracker.report(),
      oracle: { id: deps.oracle.id, verdict },
    });
  };

  // ② 对话循环：预算先验（每轮询问模拟用户之前检查），不允许无限追问/等待。
  for (;;) {
    if (now() - startedAt >= caseDef.limits.maxWallMs) {
      return build({
        terminal: 'budget_exhausted', pass: false, exhaustedBy: 'wall_ms', contamination: null,
        injection: tracker.report(), oracle: null,
      });
    }

    // 硬守卫（bounded）：最近 3 条用户消息都在重复此前已问过的意图，且上一轮系统回复非空
    // → 终止循环（reason=repeat_guard）。它**只终止**，pass 仍由下面的 Oracle 判定。
    const saidSoFar = messages.filter((m) => m.action === 'say').map((m) => m.text ?? '');
    if (caseDef.allowedActions.includes('finish') && lastReply.trim() !== '' && hasRepeatedUserIntent(saidSoFar)) {
      messages.push({ turn: userTurns + 1, action: 'finish', finishKind: 'satisfied', reason: 'repeat_guard' });
      return finishWithOracle();
    }

    if (userTurns >= caseDef.limits.maxUserTurns) {
      return build({
        terminal: 'budget_exhausted', pass: false, exhaustedBy: 'user_turns', contamination: null,
        injection: tracker.report(), oracle: null,
      });
    }

    const view: SimulatorView = {
      goal: caseDef.goal,
      persona: caseDef.persona,
      knowledge: caseDef.knowledge,
      behaviorRules: caseDef.behaviorRules,
      terminal: caseDef.terminal,
      allowedActions: caseDef.allowedActions,
      userMessages: messages.filter((m) => m.action === 'say').map((m) => m.text ?? ''),
      lastSystemReply: lastReply,
      userTurn: userTurns + 1,
    };
    const prompt = buildSimulatorPrompt(view);
    // 泄漏守卫：fixtureId/oracleId/禁知/真值不得进模拟用户 prompt（fail-closed）。
    const promptLeaks = findPromptLeaks(prompt, caseDef, deps.oracle.truthPatterns, normalizeForMatch);
    if (promptLeaks.length > 0) {
      return build({
        terminal: null, pass: false, exhaustedBy: null, contamination: null,
        injection: tracker.report(), oracle: null,
        error: `模拟用户 prompt 泄漏（${promptLeaks.join(', ')}）——拒绝发送`,
      });
    }

    const completionStarted = now();
    const completion = await deps.simulator.complete(prompt);
    recordCall('simulator', userTurns + 1, completion.tokens, completion.tokensObserved, now() - completionStarted);

    // 动作解析：首答不合法时最多修复重问 N 次（每次单独计入 simulator 账，原始输出全留证）。
    const rawOutputs: string[] = [completion.text];
    const parseErrors: string[] = [];
    let parsed = parseSimAction(completion.text, caseDef.allowedActions);
    if (!parsed.ok) {
      parseErrors.push(parsed.error);
      const maxRepairs = deps.maxProtocolRepairs ?? SIM_PROTOCOL_REPAIRS;
      for (let attempt = 1; attempt <= maxRepairs && !parsed.ok; attempt += 1) {
        const repairPrompt = buildRepairPrompt(prompt, parsed.error, attempt, maxRepairs);
        const repairStarted = now();
        const repair = await deps.simulator.complete(repairPrompt);
        recordCall('simulator', userTurns + 1, repair.tokens, repair.tokensObserved, now() - repairStarted);
        rawOutputs.push(repair.text);
        parsed = parseSimAction(repair.text, caseDef.allowedActions);
        if (!parsed.ok) parseErrors.push(parsed.error);
      }
      protocolRepairs += rawOutputs.length - 1;
      protocolRawOutputs.push(...rawOutputs);
      protocolErrors.push(...parseErrors);
      protocolLog = {
        repairs: protocolRepairs,
        rawOutputs: [...protocolRawOutputs],
        errors: [...protocolErrors],
      };
    }
    if (!parsed.ok) {
      // 协议终态：不是 gave_up、不是 satisfied，永不算通过；有效样本 = 总数 − protocol_error。
      return build({
        terminal: 'protocol_error', pass: false, exhaustedBy: null, contamination: null,
        injection: tracker.report(), oracle: null,
        error: `模拟用户动作协议错误：修复重问 ${rawOutputs.length - 1} 次后仍失败（${parseErrors.join('；')}）`,
      });
    }
    const action = parsed.action;

    if (action.kind === 'finish') {
      messages.push({ turn: userTurns + 1, action: 'finish', finishKind: action.finishKind, reason: action.reason });
      if (action.finishKind === 'gave_up') {
        // gave_up 分开记，且**永远不算通过**（即使 Oracle 会判真）。
        return build({
          terminal: 'gave_up', pass: false, exhaustedBy: null, contamination: null,
          injection: tracker.report(), oracle: null,
        });
      }
      return finishWithOracle();
    }

    if (action.kind === 'wait') {
      waitTurns += 1;
      messages.push({ turn: userTurns + 1, action: 'wait', reason: action.reason });
      if (waitTurns > caseDef.limits.maxWaitTurns) {
        return build({
          terminal: 'budget_exhausted', pass: false, exhaustedBy: 'wait_turns', contamination: null,
          injection: tracker.report(), oracle: null,
        });
      }
      // wait 不推进用户回合、不触发系统调用：下一轮再决定（预算封顶，不会无限等）。
      continue;
    }

    // say：先污染检测（命中即作废，不发给系统），再消耗用户回合。
    const report = contaminationCheck(action.text);
    messages.push({ turn: userTurns + 1, action: 'say', text: action.text, contamination: report });
    if (report.contaminated) {
      return build({
        terminal: 'contaminated', pass: false, exhaustedBy: null, contamination: report,
        injection: tracker.report(), oracle: null,
      });
    }
    userTurns += 1;
    lastReply = await sendToSystem(userTurns, action.text);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 证据落盘（原文 + manifest sha256，可复核）
// ─────────────────────────────────────────────────────────────────────────────

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function jsonl(rows: readonly unknown[]): string {
  return rows.length === 0 ? '' : rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** 落一个 trial 的证据；返回 evidenceDir。manifest 不含自身（自指哈希不可满足）。 */
export function writeSimTrialEvidence(result: SimTrialResult): string {
  const dir = result.paths.evidenceDir;
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, string]> = [
    ['trial.json', pretty({ ...result, paths: undefined })],
    ['messages.jsonl', jsonl(result.messages)],
    ['replies.jsonl', jsonl(result.replies.map((text, index) => ({ index: index + 1, text })))],
    ['accounting.json', pretty(result.accounting)],
    ['injection.json', pretty(result.injection)],
    ['oracle.json', pretty(result.oracle)],
    ['skills.json', pretty(result.skills)],
  ];
  for (const [name, content] of files) writeFileSync(path.join(dir, name), content, 'utf8');
  const manifest = {
    caseId: result.caseId,
    trial: result.trial,
    terminal: result.terminal,
    pass: result.pass,
    files: files.map(([name, content]) => ({ name, sha256: sha256Hex(content) })),
  };
  writeFileSync(path.join(dir, 'manifest.json'), pretty(manifest), 'utf8');
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// 样本级并发池（缺省 5）+ 每 trial 目录隔离断言
// ─────────────────────────────────────────────────────────────────────────────

export interface SimIsolationReport {
  readonly concurrency: number;
  readonly trials: number;
  readonly uniqueSessionDirs: boolean;
  readonly uniqueStateDbPaths: boolean;
  readonly uniqueEvidenceDirs: boolean;
  readonly dirsCreated: boolean;
  /** 共享（重复）的路径；空数组 = 隔离成立。 */
  readonly shared: readonly string[];
}

/** 并发 ≥2 时目录必须互不共享：任何重复路径都是基建缺陷（fail-closed）。 */
export function assertTrialIsolation(trials: readonly SimTrialResult[], concurrency: number): SimIsolationReport {
  const duplicates = (paths: readonly string[]): string[] => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const item of paths) {
      if (seen.has(item)) dup.add(item);
      seen.add(item);
    }
    return [...dup];
  };
  const sessionDirs = trials.map((t) => t.paths.sessionDir);
  const stateDbs = trials.map((t) => t.paths.stateDbPath);
  const evidenceDirs = trials.map((t) => t.paths.evidenceDir);
  const shared = [
    ...duplicates(sessionDirs),
    ...duplicates(stateDbs),
    ...duplicates(evidenceDirs),
  ];
  const report: SimIsolationReport = {
    concurrency,
    trials: trials.length,
    uniqueSessionDirs: duplicates(sessionDirs).length === 0,
    uniqueStateDbPaths: duplicates(stateDbs).length === 0,
    uniqueEvidenceDirs: duplicates(evidenceDirs).length === 0,
    dirsCreated: trials.every((t) => existsSync(t.paths.sessionDir) && existsSync(t.paths.evidenceDir)),
    shared,
  };
  if (shared.length > 0) throw new Error(`trial 目录共享（并发 ${concurrency}）：${shared.join(', ')}`);
  return report;
}

export interface SimSuiteInput {
  readonly cases: readonly SimCase[];
  readonly outRoot: string;
  /** 样本级并发池并发度（缺省 5；上限由 batch.ts 硬上限登记熔断）。 */
  readonly concurrency?: number;
  readonly createSystem: SimTrialDeps['createSystem'];
  readonly simulator: SimModel;
  readonly judge?: SimModel;
  readonly now?: () => number;
  /** 协议修复重问上限（缺省 2；仅为反向绊线提供关闭开关）。 */
  readonly maxProtocolRepairs?: number;
  /** 套件局部 Oracle 注册（追加在内建注册表之上）。 */
  readonly oracles?: readonly SimOracle[];
}

export interface SimSuiteSummary {
  readonly n: number;
  readonly passed: number;
  readonly errored: number;
  /** 协议终态单列：模拟用户修复重问后仍无法给出合法动作。 */
  readonly protocolErrors: number;
  /** 有效样本数 = n − protocolErrors（报告必须显式标注该口径）。 */
  readonly effectiveSamples: number;
  readonly byTerminal: Readonly<Record<SimTerminal, number>>;
  readonly accounting: SimAccounting;
  readonly isolation: SimIsolationReport;
}

export interface SimSuiteResult {
  readonly trials: readonly SimTrialResult[];
  readonly summary: SimSuiteSummary;
  readonly batch: BatchReport;
}

/** 先验：全部用例形状有效、oracle 可解析、无真值泄漏——任一失败即拒绝跑批（不烧样本）。 */
function preflight(cases: readonly SimCase[], extraOracles: readonly SimOracle[]): Map<string, SimOracle> {
  const byId = new Map<string, SimOracle>();
  const problems: string[] = [];
  for (const caseDef of cases) {
    const validation = validateSimCase(caseDef);
    if (!validation.ok) {
      problems.push(`[${caseDef.id}] ${validation.errors.join('; ')}`);
      continue;
    }
    let oracle: SimOracle;
    try {
      oracle = resolveOracle(caseDef.oracleId, extraOracles);
    } catch (error) {
      problems.push(`[${caseDef.id}] ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const leaks = findCaseLeaks(caseDef, oracle.truthPatterns, normalizeForMatch);
    if (leaks.length > 0) problems.push(`[${caseDef.id}] 真值出现在模拟用户可见字段：${leaks.join(', ')}`);
    byId.set(caseDef.id, oracle);
  }
  if (problems.length > 0) throw new Error(`SimCase 预检失败（未跑任何样本）：\n${problems.join('\n')}`);
  return byId;
}

/** 跑一套 SimCase：case × trials 展开，样本级并发池，逐 trial 独立目录与证据。 */
export async function runSimSuite(input: SimSuiteInput): Promise<SimSuiteResult> {
  const oraclesById = preflight(input.cases, input.oracles ?? []);
  const items = expandSimTrials(input.cases);
  const caseById = new Map(input.cases.map((caseDef) => [caseDef.id, caseDef]));
  const concurrency = input.concurrency ?? SIM_DEFAULT_CONCURRENCY;

  const batch = await runBatch<SimItem>(
    items,
    async (item) => {
      const caseDef = caseById.get(item.caseId);
      const oracle = oraclesById.get(item.caseId);
      if (caseDef === undefined || oracle === undefined) throw new Error(`未知用例：${item.caseId}`);
      const result = await runSimTrial(caseDef, item.trial, {
        outRoot: input.outRoot,
        createSystem: input.createSystem,
        simulator: input.simulator,
        oracle,
        ...(input.judge === undefined ? {} : { judge: input.judge }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.maxProtocolRepairs === undefined ? {} : { maxProtocolRepairs: input.maxProtocolRepairs }),
      });
      writeSimTrialEvidence(result);
      return result;
    },
    { concurrency },
  );

  const trials: SimTrialResult[] = [];
  batch.outcomes.forEach((outcome, index) => {
    if (outcome.ok) {
      trials.push(outcome.output as SimTrialResult);
      return;
    }
    // 执行抛错：保留全样本（不筛绿），terminal null + error，绝不冒充任何终态。
    const item = items[index];
    if (item === undefined) return;
    const paths = simTrialPaths(input.outRoot, item.caseId, item.trial);
    ensureTrialPaths(paths);
    const errored: SimTrialResult = {
      caseId: item.caseId,
      trial: item.trial,
      terminal: null,
      pass: false,
      exhaustedBy: null,
      messages: [],
      replies: [],
      executions: [],
      contamination: null,
      injection: null,
      oracle: null,
      calls: [],
      accounting: emptySimAccounting(),
      systemAccountingAvailable: false,
      skills: emptySkillTelemetry(),
      paths,
      error: outcome.error ?? 'trial 未产出结果',
    };
    writeSimTrialEvidence(errored);
    trials.push(errored);
  });

  const byTerminal: Record<SimTerminal, number> = {
    satisfied: 0, gave_up: 0, budget_exhausted: 0, contaminated: 0, protocol_error: 0,
  };
  for (const trial of trials) if (trial.terminal !== null) byTerminal[trial.terminal] += 1;
  const isolation = assertTrialIsolation(trials, concurrency);
  // 合计记账 = 跨 trial 重新编号后全量重算（不把各 trial 的聚合读数简单相加）。
  const merged: SimCallRecord[] = [];
  for (const trial of trials) {
    for (const record of trial.calls) merged.push({ ...record, seq: merged.length + 1 });
  }

  const protocolErrors = byTerminal.protocol_error;
  const summary: SimSuiteSummary = {
    n: trials.length,
    passed: trials.filter((trial) => trial.pass).length,
    errored: trials.filter((trial) => trial.terminal === null).length,
    protocolErrors,
    // 有效样本 = 总数 − protocol_error；协议失败不洗成 pass、也不计入其它终态。
    effectiveSamples: trials.length - protocolErrors,
    byTerminal,
    accounting: accountSimCalls(merged),
    isolation,
  };
  return { trials, summary, batch };
}
