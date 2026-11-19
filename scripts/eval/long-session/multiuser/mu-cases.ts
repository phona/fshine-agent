/**
 * R6 MU · MU-1～MU-10 多用户场景（确定性、零真实模型、零真实企微、零真实写）。
 *
 * 每条用例：
 *   · 走**生产同源装配**「真实交互路径」（`createServer().handler`；≥3 principal / 多 Session /
 *     同进程并发 / 会合栅见证真交错）——不是直接 `registry.get` 代替交互；
 *   · 硬零断言：跨 principal 泄漏 / 越权执行 / 通知错投 / 任务串线（`../oracle` 机械判据）；
 *   · 逐用例记录五要素：principalId / sessionId / taskId / 请求 / 实际投递对象；
 *   · MU-8（B2 未接线）**标 BLOCKED**（给理由与证据，不伪报 PASS）。
 *
 * 依赖状态（MU 复跑基线 = 已合入 B1 接线 ebdaf71 + B2 闸/opt-in）：
 *   · B1 会话持久化：**已合入并接线** → MU-6 已接线为重启恢复用例（`mu6-restart.ts`）；
 *   · B2 企微静默闸：**已合入**（`silent-shadow-gate.ts`）→ MU-8 已接线为确定性两段用例（会话/任务层 + 投递层）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '@fshine/contracts';
import {
  createMuServer, deliver, groupPrincipalIdOf, incoming, judgeMuCompactions, judgeMuTasks, makeCtx, makeTempDir, readTasks,
  MU_PRINCIPALS, MU_TAGS, MuFakeExecutor, MuPlans, MuRecordingSink, Rendezvous,
  principalIdOf, sessionIdOf, settle, startSilentWecomChannel, wecomTextFrame,
  type MuCaseResult, type MuDeliveryRecord, type MuHardZero, type MuPlanTable, type MuTaskSnapshot,
} from './mu-support';
import { mu6Restart } from './mu6-restart';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const EVIDENCE_ROOT = path.join(REPO_ROOT, '.runtime', 'long-session', 'multiuser');

// ─────────────────────────────────────────────────────────────────────────────
// 通用判定辅助
// ─────────────────────────────────────────────────────────────────────────────

function ownerOf(plans: MuPlanTable, text: string): string | null {
  // 应然主体（群聊回合 = 群主体）；未登记 principal 的老用例仍按 `wecom:<owner>`（逐字节旧行为）。
  const principal = plans.principalOfText.get(text);
  if (principal !== undefined) return principal;
  const owner = plans.ownerOfText.get(text);
  return owner === undefined ? null : principalIdOf(owner);
}

/** 归属校验：任务行的 (principalId) 必须等于其请求原文的 owner；不等 = 串线/泄漏。 */
export function scopeViolations(plans: MuPlanTable, tasks: readonly MuTaskSnapshot[]): string[] {
  const bad: string[] = [];
  for (const task of tasks) {
    const owner = ownerOf(plans, task.request);
    if (owner === null) { bad.push(`task ${task.taskId} 的请求未登记 owner：${JSON.stringify(task.request)}`); continue; }
    if (task.principalId !== owner) {
      bad.push(`task ${task.taskId} 归属 ${task.principalId} ≠ 请求 owner ${owner}（跨 principal 泄漏/任务串线）`);
    }
  }
  return bad;
}

/** 转录隔离：任一回合的主转录不得出现**他人**语料标记。 */
function transcriptViolations(plans: MuPlanTable, records: readonly { principalId: string; messages: readonly unknown[] }[]): string[] {
  const bad: string[] = [];
  for (const record of records) {
    const ownTags = new Set(Object.values(MU_TAGS).filter((tag) => {
      const userId = MU_PRINCIPALS.find((candidate) => principalIdOf(candidate) === record.principalId);
      return userId !== undefined && MU_TAGS[userId] === tag;
    }));
    for (const message of record.messages) {
      const content = (message as { content?: unknown }).content;
      if (typeof content !== 'string') continue;
      for (const tag of Object.values(MU_TAGS)) {
        if (!ownTags.has(tag) && content.includes(tag)) bad.push(`${record.principalId} 的转录出现他人标记 ${tag}`);
      }
    }
  }
  return bad;
}

/** 机械任务 Oracle（`../oracle` H3/H4/H5/E-G）→ 串线硬零。 */
export function crossoverHits(tasks: readonly MuTaskSnapshot[]): { hits: MuHardZero[]; verdict: string[] } {
  const verdict = judgeMuTasks(tasks);
  const hits: MuHardZero[] = [];
  if (verdict.codes.length > 0) hits.push('task_crossover');
  return { hits, verdict: verdict.codes as string[] };
}

function scoped(tasks: readonly MuTaskSnapshot[], userId: (typeof MU_PRINCIPALS)[number], conversationId: string): MuTaskSnapshot[] {
  return tasks.filter((task) => task.principalId === principalIdOf(userId) && task.sessionId === sessionIdOf(conversationId));
}

export function makeRecords(
  caseId: string,
  entries: readonly { principalId: string; sessionId: string; taskId: string | null; request: string; deliveredTo: string; kind: MuDeliveryRecord['kind'] }[],
): MuDeliveryRecord[] {
  return entries.map((entry) => ({ caseId, ...entry }));
}

export function finalize(
  id: string,
  title: string,
  hardZeroHits: readonly MuHardZero[],
  records: readonly MuDeliveryRecord[],
  notes: string,
  evidence: Record<string, unknown>,
): MuCaseResult {
  const status = hardZeroHits.length > 0 ? 'FAIL' : 'PASS';
  const result: MuCaseResult = { id, title, status, hardZeroHits, records, notes, evidence };
  mkdirSync(path.join(EVIDENCE_ROOT, id), { recursive: true });
  writeFileSync(path.join(EVIDENCE_ROOT, id, 'evidence.json'), JSON.stringify(result, null, 2));
  return result;
}

function blocked(id: string, title: string, notes: string, evidence: Record<string, unknown>): MuCaseResult {
  const result: MuCaseResult = { id, title, status: 'BLOCKED', hardZeroHits: [], records: [], notes, evidence };
  mkdirSync(path.join(EVIDENCE_ROOT, id), { recursive: true });
  writeFileSync(path.join(EVIDENCE_ROOT, id, 'evidence.json'), JSON.stringify(result, null, 2));
  return result;
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-1 不同 principal 同时交办
// ─────────────────────────────────────────────────────────────────────────────

export async function mu1(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-1';
  const title = '不同 principal 同时交办（同进程并发、真交错）';
  const tmp = makeTempDir('mu1-');
  const rendezvous = new Rendezvous(3);
  const plans = new MuPlans();
  for (const userId of MU_PRINCIPALS) {
    const text = `${MU_TAGS[userId]} 交办：清点本用户账套`;
    plans.delegate(userId, text, { reply: `${MU_TAGS[userId]} 已办。`, operation: 'dummy.query', args: { '--collection': MU_TAGS[userId] }, summary: `${MU_TAGS[userId]} 清点完成。`, rendezvous: true });
  }
  const ctx = makeCtx(plans.table(), rendezvous);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  try {
    const replies = await Promise.all(MU_PRINCIPALS.map((userId, index) => deliver(handle.server.handler, incoming(userId, `conv-${userId}`, `m-${index}`, `${MU_TAGS[userId]} 交办：清点本用户账套`))));
    const tasks = readTasks(handle.dbPath);
    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);
    const leakHits: MuHardZero[] = scope.length > 0 ? ['cross_principal_leak'] : [];
    const hardZeroHits = [...new Set([...crossover.hits, ...leakHits])];
    const records = makeRecords(id, tasks.map((task) => ({
      principalId: task.principalId, sessionId: task.sessionId, taskId: task.taskId, request: task.request,
      deliveredTo: task.sessionId, kind: 'reply' as const,
    })));
    // 真交错见证：3 个 enter 都发生在任一 exit 之前（会合栅；串行假并发会超时）。
    const enters = ctx.trace.filter((event) => event.phase === 'enter').length;
    const exits = ctx.trace.filter((event) => event.phase === 'exit').length;
    const firstExit = ctx.trace.findIndex((event) => event.phase === 'exit');
    const lastEnter = ctx.trace.map((event) => event.phase).lastIndexOf('enter');
    const interleaved = firstExit > -1 && lastEnter > -1 && firstExit > lastEnter;
    if (!interleaved) hardZeroHits.push('fake_concurrency');
    if (rendezvous.timedOut || enters !== 3 || exits !== 3) hardZeroHits.push('fake_concurrency');
    return finalize(id, title, [...new Set(hardZeroHits)], records, notes1(replies, tasks, rendezvous, interleaved), {
      principals: MU_PRINCIPALS.map(principalIdOf), taskCount: tasks.length,
      rendezvousTimedOut: rendezvous.timedOut, rendezvousArrived: rendezvous.arrivedCount,
      trace: ctx.trace, scopeViolations: scope, crossoverCodes: crossover.verdict, replies,
    });
  } finally { handle.close(); tmp.cleanup(); }
}

function notes1(replies: readonly string[], tasks: readonly MuTaskSnapshot[], rendezvous: Rendezvous, interleaved: boolean): string {
  return `3 principal 并发交办；会合栅到达 ${rendezvous.arrivedCount}/3（timedOut=${rendezvous.timedOut}）；真交错=${interleaved}；任务数=${tasks.length}；回复数=${replies.length}。`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-2 相同 sessionId（跨 principal 同名会话）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu2(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-2';
  const title = '相同 sessionId 跨 principal 同名会话（不得并会话）';
  const tmp = makeTempDir('mu2-');
  const rendezvous = new Rendezvous(2);
  const files = ['mu-alice', 'mu-bob'] as const;
  const plans = new MuPlans();
  for (const userId of files) {
    const text = `${MU_TAGS[userId]} 同名会话交办`;
    plans.delegate(userId, text, { reply: `${MU_TAGS[userId]} 已办。`, operation: 'dummy.query', args: { '--collection': MU_TAGS[userId] }, summary: `${MU_TAGS[userId]} 完成。`, rendezvous: true });
  }
  const ctx = makeCtx(plans.table(), rendezvous);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  try {
    await Promise.all(files.map((userId, index) => deliver(handle.server.handler, incoming(userId, 'conv-shared', `s-${index}`, `${MU_TAGS[userId]} 同名会话交办`))));
    const tasks = readTasks(handle.dbPath);
    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);
    const hardZeroHits: MuHardZero[] = [];
    if (scope.length > 0 || crossover.hits.length > 0) hardZeroHits.push('cross_principal_leak');
    if (crossover.hits.length > 0) hardZeroHits.push('task_crossover');
    // 会话未合并：同 sessionId 下两任务分属不同 principal，且互相不可见。
    const aliceList = scoped(tasks, 'mu-alice', 'conv-shared');
    const bobList = scoped(tasks, 'mu-bob', 'conv-shared');
    const merged = !(aliceList.length === 1 && bobList.length === 1 && aliceList[0]!.taskId !== bobList[0]!.taskId);
    if (merged) hardZeroHits.push('cross_principal_leak');
    const records = makeRecords(id, tasks.map((task) => ({
      principalId: task.principalId, sessionId: task.sessionId, taskId: task.taskId, request: task.request,
      deliveredTo: task.sessionId, kind: 'reply' as const,
    })));
    return finalize(id, title, [...new Set(hardZeroHits)], records,
      `同 sessionId=wecom:conv-shared 下 alice 任务数=${aliceList.length}、bob 任务数=${bobList.length}（应为各 1 且 taskId 不同）；会话未合并=${!merged}。`,
      {
        sessionId: 'wecom:conv-shared', taskCount: tasks.length,
        aliceTasks: aliceList.map((task) => task.taskId), bobTasks: bobList.map((task) => task.taskId),
        scopeViolations: scope, crossoverCodes: crossover.verdict,
      });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-3 同用户多会话
// ─────────────────────────────────────────────────────────────────────────────

export async function mu3(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-3';
  const title = '同用户多会话（会话间不互相泄漏任务）';
  const tmp = makeTempDir('mu3-');
  const rendezvous = new Rendezvous(2);
  const plans = new MuPlans();
  plans.delegate('mu-alice', `${MU_TAGS['mu-alice']} 会话甲交办`, { reply: '会话甲已办。', operation: 'dummy.query', args: { '--collection': 'TAG-ALICE' }, summary: '甲完成。', rendezvous: true });
  plans.delegate('mu-alice', `${MU_TAGS['mu-alice']} 会话乙交办`, { reply: '会话乙已办。', operation: 'dummy.query', args: { '--collection': 'TAG-ALICE' }, summary: '乙完成。', rendezvous: true });
  const ctx = makeCtx(plans.table(), rendezvous);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  try {
    await Promise.all([
      deliver(handle.server.handler, incoming('mu-alice', 'conv-jia', 'j-1', `${MU_TAGS['mu-alice']} 会话甲交办`)),
      deliver(handle.server.handler, incoming('mu-alice', 'conv-yi', 'y-1', `${MU_TAGS['mu-alice']} 会话乙交办`)),
    ]);
    const tasks = readTasks(handle.dbPath);
    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);
    const jia = scoped(tasks, 'mu-alice', 'conv-jia');
    const yi = scoped(tasks, 'mu-alice', 'conv-yi');
    const distinct = jia.length === 1 && yi.length === 1 && jia[0]!.sessionId === sessionIdOf('conv-jia') && yi[0]!.sessionId === sessionIdOf('conv-yi') && jia[0]!.taskId !== yi[0]!.taskId;
    const hardZeroHits: MuHardZero[] = [];
    if (scope.length > 0 || crossover.hits.length > 0) hardZeroHits.push('cross_principal_leak');
    if (!distinct) hardZeroHits.push('task_crossover');
    const records = makeRecords(id, tasks.map((task) => ({
      principalId: task.principalId, sessionId: task.sessionId, taskId: task.taskId, request: task.request,
      deliveredTo: task.sessionId, kind: 'reply' as const,
    })));
    return finalize(id, title, [...new Set(hardZeroHits)], records,
      `同 principal 两会话各 1 任务、sessionId 不同、taskId 不同（${distinct}）；会话间互不可见。`,
      { jiaTasks: jia.map((task) => task.taskId), yiTasks: yi.map((task) => task.taskId), scopeViolations: scope, crossoverCodes: crossover.verdict });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-4 交错并发（多轮，会合栅逐轮见证）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu4(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-4';
  const title = '交错并发（3 principal × 2 轮，逐轮真交错、转录不互污）';
  const tmp = makeTempDir('mu4-');
  const plans = new MuPlans();
  for (const userId of MU_PRINCIPALS) {
    const round1 = `${MU_TAGS[userId]} 第一轮交办`;
    const round2 = `${MU_TAGS[userId]} 第二轮追问`;
    plans.delegate(userId, round1, { reply: `${MU_TAGS[userId]} 第一轮已办。`, operation: 'dummy.query', args: { '--collection': MU_TAGS[userId] }, summary: '第一轮完成。', rendezvous: true });
    plans.delegate(userId, round2, { reply: `${MU_TAGS[userId]} 第二轮已办。`, operation: 'dummy.query', args: { '--collection': MU_TAGS[userId] }, summary: '第二轮完成。', rendezvous: true });
  }
  const ctx = makeCtx(plans.table(), new Rendezvous(3));
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  try {
    const round1 = await Promise.all(MU_PRINCIPALS.map((userId, index) => deliver(handle.server.handler, incoming(userId, `conv-${userId}`, `r1-${index}`, `${MU_TAGS[userId]} 第一轮交办`))));
    ctx.rendezvous = new Rendezvous(3);
    const round2 = await Promise.all(MU_PRINCIPALS.map((userId, index) => deliver(handle.server.handler, incoming(userId, `conv-${userId}`, `r2-${index}`, `${MU_TAGS[userId]} 第二轮追问`))));
    const tasks = readTasks(handle.dbPath);
    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);
    const transcript = transcriptViolations(plans.table(), ctx.mainRecords);
    const hardZeroHits: MuHardZero[] = [];
    if (scope.length > 0 || transcript.length > 0) hardZeroHits.push('cross_principal_leak');
    if (crossover.hits.length > 0) hardZeroHits.push('task_crossover');
    const records = makeRecords(id, tasks.map((task) => ({
      principalId: task.principalId, sessionId: task.sessionId, taskId: task.taskId, request: task.request,
      deliveredTo: task.sessionId, kind: 'reply' as const,
    })));
    return finalize(id, title, [...new Set(hardZeroHits)], records,
      `3 principal × 2 轮交错；任务数=${tasks.length}；转录互污违规=${transcript.length}。`,
      { taskCount: tasks.length, repliesRound1: round1, repliesRound2: round2, scopeViolations: scope, transcriptViolations: transcript, crossoverCodes: crossover.verdict, mainRecords: ctx.mainRecords.map((record) => ({ principalId: record.principalId, userText: record.userText })) });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-5 跨用户越权（真实交互路径：B 会话经任务工具访问 A 的任务 → 确定性拒绝）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu5(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-5';
  const title = '跨用户越权（B 经任务工具取 A 的 #1 → 非本会话，拒绝）';
  const tmp = makeTempDir('mu5-');
  const plans = new MuPlans();
  const aSubmit = `${MU_TAGS['mu-alice']} 交办查账`;
  plans.delegate('mu-alice', aSubmit, { reply: '已受理，稍后通知你。', operation: 'dummy.query', args: { '--collection': 'TAG-ALICE' }, summary: '完成。' });
  plans.turn('mu-alice', `${MU_TAGS['mu-alice']} 查自己任务 #1`, { calls: [{ tool: 'task_status', args: { ref: '#1' } }], reply: '这是我自己的任务。' });
  plans.turn('mu-bob', `${MU_TAGS['mu-bob']} 试图查看 #1`, {
    calls: [
      { tool: 'task_status', args: { ref: '#1' } },
      { tool: 'task_result', args: { ref: '#1' } },
      { tool: 'task_cancel', args: { ref: '#1' } },
    ],
    reply: '我无法访问。',
  });
  const ctx = makeCtx(plans.table(), null);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'background', runtime: rt, taskExecutor: new MuFakeExecutor([async () => ({ kind: 'completed', resultText: '完成。' })]) });
  try {
    await deliver(handle.server.handler, incoming('mu-alice', 'conv-a5', 'a-1', aSubmit));
    const aliceTask = readTasks(handle.dbPath).find((task) => task.principalId === principalIdOf('mu-alice'));
    const aliceTaskNo = aliceTask?.taskNo ?? 1;
    // control：alice 查自己 #1 成功
    await deliver(handle.server.handler, incoming('mu-alice', 'conv-a5', 'a-2', `${MU_TAGS['mu-alice']} 查自己任务 #1`));
    // attack：bob 经任务工具访问 #1（经真实交互路径）
    await deliver(handle.server.handler, incoming('mu-bob', 'conv-b5', 'b-1', `${MU_TAGS['mu-bob']} 试图查看 #1`));

    const aliceControl = ctx.mainRecords.find((record) => record.userText === `${MU_TAGS['mu-alice']} 查自己任务 #1`);
    const bobAttack = ctx.mainRecords.find((record) => record.userText === `${MU_TAGS['mu-bob']} 试图查看 #1`);
    if (aliceControl === undefined || bobAttack === undefined) throw new Error('MU-5 未采集到预期回合');
    const aliceControlCall = aliceControl.calls[0];
    const bobCalls = bobAttack.calls;
    const bobAllRejected = bobCalls.length === 3 && bobCalls.every((call) => call.error !== null && call.error.includes('任务不存在或不属于当前会话'));
    const bobLeaked = bobCalls.some((call) => {
      const serialized = JSON.stringify({ result: call.result, error: call.error });
      return serialized.includes(aSubmit) || serialized.includes('TAG-ALICE');
    });
    const hardZeroHits: MuHardZero[] = [];
    if (bobLeaked || !bobAllRejected) hardZeroHits.push('unauthorized_execution');
    if (aliceControlCall === undefined || aliceControlCall.error !== null) hardZeroHits.push('unauthorized_execution');
    const records = makeRecords(id, [
      ...(aliceTask === undefined ? [] : [{ principalId: aliceTask.principalId, sessionId: aliceTask.sessionId, taskId: aliceTask.taskId, request: aliceTask.request, deliveredTo: sessionIdOf('conv-a5'), kind: 'reply' as const }]),
      { principalId: principalIdOf('mu-bob'), sessionId: sessionIdOf('conv-b5'), taskId: null, request: `${MU_TAGS['mu-bob']} 试图查看 #1`, deliveredTo: sessionIdOf('conv-b5'), kind: 'reply' },
    ]);
    return finalize(id, title, [...new Set(hardZeroHits)], records,
      `bob 三次越权调用全部确定性拒绝=${bobAllRejected}；bob 未见 alice 内容=${!bobLeaked}；alice 查自己 #1 成功=${aliceControlCall !== undefined && aliceControlCall.error === null}（taskNo=#${aliceTaskNo}）。`,
      {
        aliceTask: aliceTask === undefined ? null : { taskId: aliceTask.taskId, principalId: aliceTask.principalId, sessionId: aliceTask.sessionId, taskNo: aliceTask.taskNo },
        bobCalls: bobCalls.map((call) => ({ tool: call.tool, args: call.args, error: call.error })),
        aliceControl: aliceControlCall === undefined ? null : { tool: aliceControlCall.tool, args: aliceControlCall.args, error: aliceControlCall.error },
        mode: 'background',
      });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-6 重启恢复（B1 会话持久化已合入基线 → 真实确定性用例）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * B1 会话持久化已合入基线（`packages/agent/src/session-persistence.ts` 存在），MU-6 的
 * 重启恢复语义可确定性验证。用例实现落在同目录 `mu6-restart.ts`（生产同源装配 + 同 dbPath
 * 关停重建），此处只做转接，保持单一实现（不预造第二套会话机制、不直调 registry 代替交互）。
 */
export async function mu6(rt: RuntimeConfig): Promise<MuCaseResult> {
  const b1Module = path.join(REPO_ROOT, 'packages', 'agent', 'src', 'session-persistence.ts');
  if (!existsSync(b1Module)) {
    return blocked('MU-6', '重启恢复（依赖 B1 会话持久化）', 'BLOCKED：依赖 B1 未合入（无会话持久化模块），无法验证重启恢复。', {
      dependency: 'B1 会话持久化', satisfyingModule: 'packages/agent/src/session-persistence.ts', modulePresentOnBaseline: false,
    });
  }
  return mu6Restart(rt);
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-7 异步通知错投（background：事实只注入 owner 会话）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu7(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-7';
  const title = '异步通知错投（完成事实只注入 owner 会话）';
  const tmp = makeTempDir('mu7-');
  const plans = new MuPlans();
  const aSubmit = `${MU_TAGS['mu-alice']} 交办后台任务`;
  plans.delegate('mu-alice', aSubmit, { reply: '已受理，稍后通知你。', operation: 'dummy.query', args: { '--collection': 'TAG-ALICE' }, summary: '完成。' });
  plans.turn('mu-bob', `${MU_TAGS['mu-bob']} 日常对话`, { reply: '好的。' });
  plans.turn('mu-alice', `${MU_TAGS['mu-alice']} 下一步`, { reply: '收到。' });
  const ctx = makeCtx(plans.table(), null);
  const sink = new MuRecordingSink();
  const executor = new MuFakeExecutor([async () => ({ kind: 'completed', resultText: '账已清点：3 条。' })]);
  // 2026-11-19 复核 F3 迁移：completed 从 B 通道移除后，完成事实只在**慢活**路径上由唤醒
  // （降级）注入——快活路径的结果已在同回合交给模型，不再重复注入。本用例要的正是慢活路径
  // 的两面性：owner 下一回合拿到自己的完成事实、非 owner 拿不到。故本用例关掉 task_run 短
  // 等待窗口（0 = 受理即返回，结果不在同回合交给模型）；其余旋钮原样用调用方传入的 rt。
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'background', runtime: { ...rt, taskRunWaitMs: 0 }, taskExecutor: executor, notificationSink: sink });
  try {
    await deliver(handle.server.handler, incoming('mu-alice', 'conv-a7', 'a-1', aSubmit));
    const aliceTask = readTasks(handle.dbPath).find((task) => task.principalId === principalIdOf('mu-alice'));
    const taskId = aliceTask?.taskId ?? '';
    await waitUntil(() => readTasks(handle.dbPath).some((task) => task.taskId === taskId && task.status === 'completed'));
    await handle.server.deliverPending();
    // bob 回合先来：不得拿到 alice 的事实。
    await deliver(handle.server.handler, incoming('mu-bob', 'conv-b7', 'b-1', `${MU_TAGS['mu-bob']} 日常对话`));
    // alice 回合：应拿到自己的事实注入。
    await deliver(handle.server.handler, incoming('mu-alice', 'conv-a7', 'a-2', `${MU_TAGS['mu-alice']} 下一步`));

    const bobTurn = ctx.mainRecords.find((record) => record.userText === `${MU_TAGS['mu-bob']} 日常对话`);
    const aliceTurn = ctx.mainRecords.find((record) => record.userText === `${MU_TAGS['mu-alice']} 下一步`);
    // 事实注入在 1.5.2 走 Pi 原生 custom message（`TurnDriverInput.injections`），
    // 与普通 messages 并列；两处任一命中都算该回合拿到了事实。
    // 2026-11-19 复核 F3：completed 从 B 通道（`[任务事实]`）移除——完成由唤醒路径负责；
    // 本夹具的假主驱动没有唤醒能力 → 降级事实经既有 systemNotes 注入（`[任务完成]` 形状）。
    // 本用例判的是**事实只到 owner 会话**（跨 principal 不泄漏），两种事实形状任一命中都算。
    const factShapes = ['[任务事实]', '[任务完成]'];
    const turnCarriesFact = (turn: typeof aliceTurn): boolean => turn !== undefined
      && [
        ...turn.messages.map((message) => String((message as { content?: unknown }).content ?? '')),
        ...turn.injections,
      ].some((text) => factShapes.some((prefix) => text.includes(prefix)) && text.includes(aSubmit));
    const bobGotFact = turnCarriesFact(bobTurn);
    const aliceGotFact = turnCarriesFact(aliceTurn);
    const sinkAllAlice = sink.sent.length > 0 && sink.sent.every((notification) => notification.taskId === taskId);
    const hardZeroHits: MuHardZero[] = [];
    if (bobGotFact) hardZeroHits.push('notification_misdelivery');
    if (!aliceGotFact) hardZeroHits.push('notification_misdelivery');
    if (!sinkAllAlice) hardZeroHits.push('notification_misdelivery');
    const records = makeRecords(id, [
      ...(aliceTask === undefined ? [] : [{ principalId: aliceTask.principalId, sessionId: aliceTask.sessionId, taskId: aliceTask.taskId, request: aliceTask.request, deliveredTo: sessionIdOf('conv-a7'), kind: 'fact_injection' as const }]),
      { principalId: principalIdOf('mu-bob'), sessionId: sessionIdOf('conv-b7'), taskId: null, request: `${MU_TAGS['mu-bob']} 日常对话`, deliveredTo: sessionIdOf('conv-b7'), kind: 'reply' },
      ...sink.sent.map((notification) => ({ principalId: principalIdOf('mu-alice'), sessionId: sessionIdOf('conv-a7'), taskId: notification.taskId, request: aSubmit, deliveredTo: sessionIdOf('conv-a7'), kind: 'notification' as const })),
    ]);
    return finalize(id, title, [...new Set(hardZeroHits)], records,
      `bob 拿到 alice 事实=${bobGotFact}（应 false）；alice 拿到自己事实=${aliceGotFact}（应 true）；sink 通知全属 alice 任务=${sinkAllAlice}（${sink.sent.length} 条）。`,
      { taskId, sinkKinds: sink.sent.map((notification) => notification.kind), bobGotFact, aliceGotFact, sinkAllAlice });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-8 企微群聊与私聊隔离（依赖 B2 静默闸 → 已合入 → 确定性两段用例）
// ─────────────────────────────────────────────────────────────────────────────

/** 会话级标记（区别于 MU_TAGS）：同 principal 的私聊/群聊各用一枚，用于识别语料归属。 */
const MU8_PRIV_TAG = 'PRIV-TAG';
const MU8_GROUP_TAG = 'GROUP-TAG';

/** 任务引用确定性拒绝文案（与 `TaskOwnershipError` / MU-5 同源，不泄漏存在性）。 */
export const TASK_NOT_IN_SESSION = '任务不存在或不属于当前会话';

/** 从 task_status 结果里取 taskId（命中本会话 #1 时非空）。 */
function callTaskId(call: { result: unknown } | undefined): string | null {
  const id = (call?.result as { taskId?: unknown } | undefined)?.taskId;
  return typeof id === 'string' ? id : null;
}

/** 某批回合的主转录里是否出现给定标记（用于检"不继承他人/他会话历史"）。 */
function recordsHaveTag(records: readonly { userText: string; messages: readonly unknown[] }[], tag: string): boolean {
  return records.some((record) => record.messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' && content.includes(tag);
  }));
}

interface Mu8Layer { readonly hits: MuHardZero[]; readonly records: MuDeliveryRecord[]; readonly evidence: Record<string, unknown>; readonly notes: string; }

/**
 * 第一段·会话/任务层：走 `createMuServer` 真实交互路径。**群 = 独立主体**（owner 2026-11-18）：
 * 私聊 principal = `wecom:mu-alice`（sessionId=wecom:mu-alice），群聊 principal =
 * `wecom:group:group-g1`（sessionId=wecom:group-g1）。断言：群**不继承**私聊的任务/授权/历史
 * （群首查 #1 → 确定性拒绝），群 #1 只解析到群自己的任务，私聊 #1 不对群可见且无内容泄漏。
 */
async function mu8SessionLayer(rt: RuntimeConfig): Promise<Mu8Layer> {
  const hits: MuHardZero[] = [];
  const tmp = makeTempDir('mu8-session-');
  const plans = new MuPlans();
  const privDelegate = `${MU8_PRIV_TAG} 私聊交办查账`;
  const privQuery = `${MU8_PRIV_TAG} 查自己任务 #1`;
  const groupQueryFirst = `${MU8_GROUP_TAG} 查任务 #1`;
  const groupDelegate = `${MU8_GROUP_TAG} 群聊交办查账`;
  const groupQuerySecond = `${MU8_GROUP_TAG} 查群任务 #2`;
  plans.delegate('mu-alice', privDelegate, { reply: '私聊已受理。', operation: 'dummy.query', args: { '--collection': 'MU8-PRIV' }, summary: '私聊完成。' });
  plans.turn('mu-alice', privQuery, { calls: [{ tool: 'task_status', args: { ref: '#1' } }], reply: '这是私聊自己的任务。' });
  // 群 = 独立主体（owner 2026-11-18）：群回合的应然主体是 `wecom:group:group-g1`，不是发言人。
  plans.turn('mu-alice', groupQueryFirst, { calls: [{ tool: 'task_status', args: { ref: '#1' } }], reply: '群里没有这个任务。', principal: groupPrincipalIdOf('group-g1') });
  plans.delegate('mu-alice', groupDelegate, { reply: '群聊已受理。', operation: 'dummy.query', args: { '--collection': 'MU8-GROUP' }, summary: '群聊完成。', principal: groupPrincipalIdOf('group-g1') });
  plans.turn('mu-alice', groupQuerySecond, { calls: [{ tool: 'task_status', args: { ref: '#2' } }], reply: '这是群聊自己的任务。', principal: groupPrincipalIdOf('group-g1') });

  const ctx = makeCtx(plans.table(), null);
  // background 派发：任务工具（task_status 等）在 Main 工具面可用（与 MU-5 同源）。
  // 不注入假执行器——用默认后台执行器跑假 Worker 驱动，使 execute_operation 记入 ExecutionRecord
  // （否则 completed 零执行会触发机械判据 H4 虚假完成，非本用例要测的东西）。
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'background', runtime: rt });
  let evidence: Record<string, unknown> = {};
  const records: MuDeliveryRecord[] = [];
  try {
    // 顺序：私聊交办（建私聊 #1）→ 私聊查 #1（命中自己的）→ 群聊查 #1（群内尚无任务，
    // 应确定性拒绝且不得看见私聊历史）→ 群聊交办（建群 #1）→ 群聊查 #1（命中群自己的）。
    await deliver(handle.server.handler, incoming('mu-alice', 'mu-alice', 'p-1', privDelegate, 'single'));
    await deliver(handle.server.handler, incoming('mu-alice', 'mu-alice', 'p-2', privQuery, 'single'));
    await deliver(handle.server.handler, incoming('mu-alice', 'group-g1', 'g-1', groupQueryFirst, 'group'));
    const groupDelegateReply = await deliver(handle.server.handler, incoming('mu-alice', 'group-g1', 'g-2', groupDelegate, 'group'));
    const groupQueryReply = await deliver(handle.server.handler, incoming('mu-alice', 'group-g1', 'g-3', groupQuerySecond, 'group'));

    const tasks = readTasks(handle.dbPath);
    const privTask = tasks.find((task) => task.principalId === principalIdOf('mu-alice') && task.sessionId === sessionIdOf('mu-alice'));
    const groupTask = tasks.find((task) => task.principalId === groupPrincipalIdOf('group-g1') && task.sessionId === sessionIdOf('group-g1'));

    // ① 主体不同（人 vs 群）+ Session 不同 + 任务各归其主体（群任务不落个人名下）。
    const sessionsDistinct = privTask !== undefined && groupTask !== undefined
      && privTask.sessionId === sessionIdOf('mu-alice') && groupTask.sessionId === sessionIdOf('group-g1')
      && privTask.sessionId !== groupTask.sessionId && privTask.taskId !== groupTask.taskId
      && privTask.principalId === principalIdOf('mu-alice')
      && groupTask.principalId === groupPrincipalIdOf('group-g1')
      && privTask.principalId !== groupTask.principalId;

    // ② 转录隔离：群回合主转录不含私聊标记（不继承群外历史）；私聊回合不含群标记。
    const groupRecords = ctx.mainRecords.filter((record) => record.userText.includes(MU8_GROUP_TAG));
    const privRecords = ctx.mainRecords.filter((record) => record.userText.includes(MU8_PRIV_TAG));
    const inheritedPrivateHistory = recordsHaveTag(groupRecords, MU8_PRIV_TAG);
    const leakedIntoPrivate = recordsHaveTag(privRecords, MU8_GROUP_TAG);

    // ③ 任务引用解析：群首查确定性拒绝且无内容泄漏；群二查命中群自己的 #1；私聊查命中私聊自己的 #1。
    const privQueryRec = ctx.mainRecords.find((record) => record.userText === privQuery);
    const groupFirstRec = ctx.mainRecords.find((record) => record.userText === groupQueryFirst);
    const groupSecondRec = ctx.mainRecords.find((record) => record.userText === groupQuerySecond);
    const privCall = privQueryRec?.calls[0];
    const groupFirstCall = groupFirstRec?.calls[0];
    const groupSecondCall = groupSecondRec?.calls[0];
    const groupFirstRejected = groupFirstCall !== undefined && groupFirstCall.error !== null && groupFirstCall.error.includes(TASK_NOT_IN_SESSION);
    const groupFirstLeaked = groupFirstCall !== undefined
      && (JSON.stringify({ result: groupFirstCall.result, error: groupFirstCall.error }).includes(MU8_PRIV_TAG)
        || JSON.stringify({ result: groupFirstCall.result, error: groupFirstCall.error }).includes(privDelegate));
    const privOwnResolved = privCall !== undefined && privCall.error === null && callTaskId(privCall) === (privTask?.taskId ?? null);
    const groupOwnResolved = groupSecondCall !== undefined && groupSecondCall.error === null && callTaskId(groupSecondCall) === (groupTask?.taskId ?? null);

    // ④ 归属/串线机械 Oracle（跨全批任务，H3/H4/H5/E-G）。
    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);

    // 硬零映射：继承历史=跨会话泄漏；越权取私聊任务/内容=越权执行；任务或投递串线=任务串线。
    if (!sessionsDistinct || inheritedPrivateHistory || leakedIntoPrivate) hits.push('cross_principal_leak');
    if (!groupFirstRejected || groupFirstLeaked || !groupOwnResolved) hits.push('unauthorized_execution');
    if (!privOwnResolved) hits.push('task_crossover');
    if (scope.length > 0) hits.push('cross_principal_leak');
    if (crossover.hits.length > 0) hits.push('task_crossover');

    if (privTask !== undefined) records.push({ caseId: 'MU-8', principalId: privTask.principalId, sessionId: privTask.sessionId, taskId: privTask.taskId, request: privTask.request, deliveredTo: sessionIdOf('mu-alice'), kind: 'reply' });
    if (groupTask !== undefined) records.push({ caseId: 'MU-8', principalId: groupTask.principalId, sessionId: groupTask.sessionId, taskId: groupTask.taskId, request: groupTask.request, deliveredTo: sessionIdOf('group-g1'), kind: 'reply' });
    records.push(
      { caseId: 'MU-8', principalId: principalIdOf('mu-alice'), sessionId: sessionIdOf('mu-alice'), taskId: null, request: privQuery, deliveredTo: sessionIdOf('mu-alice'), kind: 'reply' },
      { caseId: 'MU-8', principalId: principalIdOf('mu-alice'), sessionId: sessionIdOf('group-g1'), taskId: null, request: groupQueryFirst, deliveredTo: sessionIdOf('group-g1'), kind: 'reply' },
      { caseId: 'MU-8', principalId: principalIdOf('mu-alice'), sessionId: sessionIdOf('group-g1'), taskId: null, request: groupQuerySecond, deliveredTo: sessionIdOf('group-g1'), kind: 'reply' },
    );

    evidence = {
      principalId: principalIdOf('mu-alice'),
      privSessionId: sessionIdOf('mu-alice'), groupSessionId: sessionIdOf('group-g1'),
      privTaskId: privTask?.taskId ?? null, groupTaskId: groupTask?.taskId ?? null,
      sessionsDistinct, inheritedPrivateHistory, leakedIntoPrivate,
      groupFirstRejected, groupFirstLeaked, privOwnResolved, groupOwnResolved,
      privCalls: privQueryRec?.calls.map((call) => ({ tool: call.tool, args: call.args, error: call.error })),
      groupFirstCalls: groupFirstRec?.calls.map((call) => ({ tool: call.tool, args: call.args, error: call.error })),
      groupSecondCalls: groupSecondRec?.calls.map((call) => ({ tool: call.tool, args: call.args, error: call.error })),
      scopeViolations: scope, crossoverCodes: crossover.verdict,
      groupDelegateReply, groupQueryReply,
      allTasks: tasks.map((task) => ({ taskId: task.taskId, taskNo: task.taskNo, sessionId: task.sessionId, status: task.status, request: task.request, requestIds: task.requestIds })),
      groupTurnTexts: groupRecords.map((record) => record.userText),
      privTurnTexts: privRecords.map((record) => record.userText),
    };
  } finally { handle.close(); tmp.cleanup(); }

  return {
    hits, records, evidence,
    notes: `会话层：群 = 独立主体（人/群主体不同 + 会话不同 + 各归其主体）=${String(evidence['sessionsDistinct'])}；群回合继承私聊历史=${String(evidence['inheritedPrivateHistory'])}（应 false）；群首查 #1 确定性拒绝=${String(evidence['groupFirstRejected'])}、泄漏=${String(evidence['groupFirstLeaked'])}（应 true/false）；私/群 #1 各命中己方=${String(evidence['privOwnResolved'])}/${String(evidence['groupOwnResolved'])}。`,
  };
}

/**
 * 第二段·投递层：走 `WecomBotChannel` + 记录型假 SDK（复用 adapter.silent-shadow.test.ts 的
 * DeliveryRecorder 范式），以**显式 silent** 包住 `server.handler`。发一条群 frame
 * （chatid=group-g1, chattype=group, from.userid=mu-alice）与一条私 frame（chattype=single）。
 * 断言：实际用户可见投递 = 0（`recorder.userVisibleCalls===0`）+ 抑制证据可观测 + 群/私两会话分属。
 */
async function mu8DeliveryLayer(rt: RuntimeConfig): Promise<Mu8Layer> {
  const hits: MuHardZero[] = [];
  const tmp = makeTempDir('mu8-delivery-');
  const plans = new MuPlans();
  const privText = `${MU8_PRIV_TAG} 私聊交办查账`;
  const groupText = `${MU8_GROUP_TAG} 群聊交办查账`;
  plans.delegate('mu-alice', privText, { reply: '私聊已受理。', operation: 'dummy.query', args: { '--collection': 'MU8-PRIV' }, summary: '私聊完成。' });
  plans.delegate('mu-alice', groupText, { reply: '群聊已受理。', operation: 'dummy.query', args: { '--collection': 'MU8-GROUP' }, summary: '群聊完成。', principal: groupPrincipalIdOf('group-g1') });
  const ctx = makeCtx(plans.table(), null);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  let evidence: Record<string, unknown> = {};
  const records: MuDeliveryRecord[] = [];
  try {
    const started = await startSilentWecomChannel(handle.server.handler, tmp.dir);
    try {
      started.sdk.emit('message.text', wecomTextFrame('cb-mu8-group', { msgid: 'mu8-g1', from: 'mu-alice', content: groupText, chattype: 'group', chatid: 'group-g1' }));
      started.sdk.emit('message.text', wecomTextFrame('cb-mu8-priv', { msgid: 'mu8-p1', from: 'mu-alice', content: privText, chattype: 'single' }));
      // 静默闸下每条消息产出 1 条用户可见尝试（终帧；2026-11-19 起不再有受理帧 ack）；
      // 等两条消息的抑制尝试都落定。
      await waitUntil(() => started.channel.shadowEvidence().userVisibleSuppressed >= 2, 5000);
      await settle();

      const shadow = started.channel.shadowEvidence();
      const realDeliveries = started.sdk.userVisibleCalls;
      const tasks = readTasks(handle.dbPath);
      const privTask = tasks.find((task) => task.sessionId === sessionIdOf('mu-alice'));
      const groupTask = tasks.find((task) => task.sessionId === sessionIdOf('group-g1'));
      const suppressedOk = shadow.mode === 'silent' && shadow.userVisibleSuppressed >= 2;
      const scopedDistinct = privTask !== undefined && groupTask !== undefined
        && privTask.sessionId !== groupTask.sessionId && privTask.taskId !== groupTask.taskId
        && privTask.principalId !== groupTask.principalId;

      // 判据：真实平台零用户可见投递（若闸门被摘/翻 live，recorder 会记到 ack/终帧 → 红）。
      if (realDeliveries !== 0) hits.push('cross_principal_leak');
      // 抑制证据缺失 = 闸门未生效（fail-closed，无法证明零投递）。
      if (!suppressedOk) hits.push('cross_principal_leak');
      // 群/私投递目标串台（两会话两任务未分属各自 session）。
      if (!scopedDistinct) hits.push('task_crossover');

      if (privTask !== undefined) records.push({ caseId: 'MU-8', principalId: privTask.principalId, sessionId: privTask.sessionId, taskId: privTask.taskId, request: privTask.request, deliveredTo: sessionIdOf('mu-alice'), kind: 'reply' });
      if (groupTask !== undefined) records.push({ caseId: 'MU-8', principalId: groupTask.principalId, sessionId: groupTask.sessionId, taskId: groupTask.taskId, request: groupTask.request, deliveredTo: sessionIdOf('group-g1'), kind: 'reply' });

      evidence = {
        deliveryMode: shadow.mode,
        userVisibleSuppressed: shadow.userVisibleSuppressed,
        suppressedKinds: shadow.events.map((event) => event.kind),
        realUserVisibleCalls: realDeliveries,
        scopedDistinct,
        privSessionId: privTask?.sessionId ?? null, groupSessionId: groupTask?.sessionId ?? null,
        privTaskId: privTask?.taskId ?? null, groupTaskId: groupTask?.taskId ?? null,
      };
    } finally { await started.stop(); }
  } finally { handle.close(); tmp.cleanup(); }

  return {
    hits, records, evidence,
    notes: `投递层：silent 闸下实际用户可见投递=${String(evidence['realUserVisibleCalls'])}（应 0），被抑制尝试=${String(evidence['userVisibleSuppressed'])}（应 ≥2，每条消息一条终帧），群/私分属各自 session=${String(evidence['scopedDistinct'])}。`,
  };
}

export async function mu8(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-8';
  const title = '群聊与私聊隔离（群 = 独立主体：群不继承私聊任务/授权/历史；群/私投递不串）';
  const session = await mu8SessionLayer(rt);
  const delivery = await mu8DeliveryLayer(rt);
  const hardZeroHits = [...new Set([...session.hits, ...delivery.hits])];
  return finalize(id, title, hardZeroHits, [...session.records, ...delivery.records],
    `${session.notes} ${delivery.notes}`,
    { sessionLayer: session.evidence, deliveryLayer: delivery.evidence });
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-9 并发压缩（3 会话逐轮并发压缩，上下文不互污）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu9(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-9';
  const title = '并发压缩（多会话同进程并发压缩，转录不互污、无 H6）';
  const tmp = makeTempDir('mu9-');
  const plans = new MuPlans();
  for (const userId of MU_PRINCIPALS) {
    for (let round = 1; round <= 3; round += 1) {
      const text = `${MU_TAGS[userId]} 压缩轮 ${round}`;
      plans.delegate(userId, text, {
        reply: `${MU_TAGS[userId]} 轮 ${round} 完成。`, operation: 'dummy.query', args: { '--collection': MU_TAGS[userId] },
        summary: `${MU_TAGS[userId]} 轮 ${round} 完成。`, rendezvous: true, compact: { before: 100_000 + round * 1_000, after: 20_000 },
      });
    }
  }
  const ctx = makeCtx(plans.table(), new Rendezvous(3));
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  try {
    for (let round = 1; round <= 3; round += 1) {
      ctx.rendezvous = new Rendezvous(3);
      await Promise.all(MU_PRINCIPALS.map((userId, index) => deliver(handle.server.handler, incoming(userId, `conv-${userId}`, `c-${round}-${index}`, `${MU_TAGS[userId]} 压缩轮 ${round}`))));
    }
    const tasks = readTasks(handle.dbPath);
    const verdict = judgeMuCompactions(ctx.compactions);
    const contaminated = ctx.compactions.filter((record) => record.sawTags.length > 1);
    const perPrincipal = Object.fromEntries(MU_PRINCIPALS.map((userId) => [principalIdOf(userId), ctx.compactions.filter((record) => record.principalId === principalIdOf(userId)).length]));
    const hardZeroHits: MuHardZero[] = [];
    if (contaminated.length > 0) hardZeroHits.push('cross_principal_leak');
    if (verdict.hardZeroHits.length > 0) hardZeroHits.push('task_crossover');
    const records = makeRecords(id, tasks.map((task) => ({
      principalId: task.principalId, sessionId: task.sessionId, taskId: task.taskId, request: task.request,
      deliveredTo: task.sessionId, kind: 'reply' as const,
    })));
    return finalize(id, title, [...new Set(hardZeroHits)], records,
      `压缩尝试=${ctx.compactions.length}；每 principal=${JSON.stringify(perPrincipal)}；互污=${contaminated.length}；H6=${verdict.hardZeroHits.join(',') || '无'}；覆盖充分=${verdict.coverageSufficient}。`,
      { compactionCount: ctx.compactions.length, perPrincipal, contaminated, compactionVerdict: verdict, taskCount: tasks.length });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-10 单用户故障隔离（A 执行失败不影响 B/C）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu10(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-10';
  const title = '单用户故障隔离（A 执行失败，B/C 不受影响）';
  const tmp = makeTempDir('mu10-');
  const rendezvous = new Rendezvous(3);
  const plans = new MuPlans();
  plans.delegate('mu-alice', `${MU_TAGS['mu-alice']} 交办（将失败）`, { reply: '这次没办成。', operation: 'dummy.query', args: { '--collection': 'alpha-fault' }, summary: '执行层未成功。', rendezvous: true });
  plans.delegate('mu-bob', `${MU_TAGS['mu-bob']} 交办`, { reply: `${MU_TAGS['mu-bob']} 已办。`, operation: 'dummy.query', args: { '--collection': 'TAG-BOB' }, summary: '完成。', rendezvous: true });
  plans.delegate('mu-carol', `${MU_TAGS['mu-carol']} 交办`, { reply: `${MU_TAGS['mu-carol']} 已办。`, operation: 'dummy.query', args: { '--collection': 'TAG-CAROL' }, summary: '完成。', rendezvous: true });
  const ctx = makeCtx(plans.table(), rendezvous);
  const failFor = new Map<string, string>([['alpha-fault', '（MU 假故障）执行层失败']]);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt, failFor });
  try {
    await Promise.all(MU_PRINCIPALS.map((userId, index) => deliver(handle.server.handler, incoming(userId, `conv-${userId}`, `f-${index}`, `${MU_TAGS[userId]} 交办${userId === 'mu-alice' ? '（将失败）' : ''}`))));
    const tasks = readTasks(handle.dbPath);
    const alice = tasks.find((task) => task.principalId === principalIdOf('mu-alice'));
    const bob = tasks.find((task) => task.principalId === principalIdOf('mu-bob'));
    const carol = tasks.find((task) => task.principalId === principalIdOf('mu-carol'));
    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);
    const aliceFailed = alice?.status === 'failed';
    const othersOk = bob?.status === 'completed' && carol?.status === 'completed';
    const hardZeroHits: MuHardZero[] = [];
    if (!aliceFailed) hardZeroHits.push('unauthorized_execution');
    if (!othersOk) hardZeroHits.push('cross_principal_leak');
    if (scope.length > 0 || crossover.hits.length > 0) hardZeroHits.push('task_crossover');
    const records = makeRecords(id, tasks.map((task) => ({
      principalId: task.principalId, sessionId: task.sessionId, taskId: task.taskId, request: task.request,
      deliveredTo: task.sessionId, kind: 'reply' as const,
    })));
    return finalize(id, title, [...new Set(hardZeroHits)], records,
      `alice 状态=${alice?.status}（应 failed）；bob=${bob?.status}、carol=${carol?.status}（应 completed）；隔离成立=${aliceFailed && othersOk}。`,
      {
        alice: alice === undefined ? null : { status: alice.status, reason: alice.reason, requestIds: alice.requestIds },
        bob: bob === undefined ? null : { status: bob.status }, carol: carol === undefined ? null : { status: carol.status },
        scopeViolations: scope, crossoverCodes: crossover.verdict,
      });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 全量运行
// ─────────────────────────────────────────────────────────────────────────────

export async function runAllMuCases(rt: RuntimeConfig): Promise<MuCaseResult[]> {
  const results: MuCaseResult[] = [];
  for (const runner of [mu1, mu2, mu3, mu4, mu5, mu6, mu7, mu8, mu9, mu10]) {
    results.push(await runner(rt));
  }
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  writeFileSync(path.join(EVIDENCE_ROOT, 'summary.json'), JSON.stringify(results.map((result) => ({
    id: result.id, title: result.title, status: result.status, hardZeroHits: result.hardZeroHits, notes: result.notes,
  })), null, 2));
  return results;
}
