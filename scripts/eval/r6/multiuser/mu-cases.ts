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
 * 依赖状态（本基线 = arch/r6-mu6，含 B1 接线 ebdaf71）：
 *   · B1 会话持久化：**已合入**（`packages/agent/src/session-persistence.ts` 存在）→ MU-6 已接线
 *     （实现见同目录 `mu6-restart.ts`）；
 *   · B2 企微静默闸：模块存在但 MU-8 确定性用例未接线 → MU-8 BLOCKED。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '@fshine/contracts';
import {
  createMuServer, deliver, incoming, judgeMuCompactions, judgeMuTasks, makeCtx, makeTempDir, readTasks,
  MU_PRINCIPALS, MU_TAGS, MuFakeExecutor, MuPlans, MuRecordingSink, Rendezvous,
  principalIdOf, sessionIdOf,
  type MuCaseResult, type MuDeliveryRecord, type MuHardZero, type MuPlanTable, type MuTaskSnapshot,
} from './mu-support';
import { mu6Restart } from './mu6-restart';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const EVIDENCE_ROOT = path.join(REPO_ROOT, '.runtime', 'r6', 'multiuser');

// ─────────────────────────────────────────────────────────────────────────────
// 通用判定辅助
// ─────────────────────────────────────────────────────────────────────────────

function ownerOf(plans: MuPlanTable, text: string): string | null {
  const owner = plans.ownerOfText.get(text);
  return owner === undefined ? null : principalIdOf(owner);
}

/** 归属校验：任务行的 (principalId) 必须等于其请求原文的 owner；不等 = 串线/泄漏。 */
function scopeViolations(plans: MuPlanTable, tasks: readonly MuTaskSnapshot[]): string[] {
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
function crossoverHits(tasks: readonly MuTaskSnapshot[]): { hits: MuHardZero[]; verdict: string[] } {
  const verdict = judgeMuTasks(tasks);
  const hits: MuHardZero[] = [];
  if (verdict.codes.length > 0) hits.push('task_crossover');
  return { hits, verdict: verdict.codes as string[] };
}

function scoped(tasks: readonly MuTaskSnapshot[], userId: (typeof MU_PRINCIPALS)[number], conversationId: string): MuTaskSnapshot[] {
  return tasks.filter((task) => task.principalId === principalIdOf(userId) && task.sessionId === sessionIdOf(conversationId));
}

function makeRecords(
  caseId: string,
  entries: readonly { principalId: string; sessionId: string; taskId: string | null; request: string; deliveredTo: string; kind: MuDeliveryRecord['kind'] }[],
): MuDeliveryRecord[] {
  return entries.map((entry) => ({ caseId, ...entry }));
}

function finalize(
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

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
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
  const title = '异步通知错投（B 通道事实只注入 owner 会话）';
  const tmp = makeTempDir('mu7-');
  const plans = new MuPlans();
  const aSubmit = `${MU_TAGS['mu-alice']} 交办后台任务`;
  plans.delegate('mu-alice', aSubmit, { reply: '已受理，稍后通知你。', operation: 'dummy.query', args: { '--collection': 'TAG-ALICE' }, summary: '完成。' });
  plans.turn('mu-bob', `${MU_TAGS['mu-bob']} 日常对话`, { reply: '好的。' });
  plans.turn('mu-alice', `${MU_TAGS['mu-alice']} 下一步`, { reply: '收到。' });
  const ctx = makeCtx(plans.table(), null);
  const sink = new MuRecordingSink();
  const executor = new MuFakeExecutor([async () => ({ kind: 'completed', resultText: '账已清点：3 条。' })]);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'background', runtime: rt, taskExecutor: executor, notificationSink: sink });
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
    const hasFact = (text: string): boolean => text.includes('[任务事实]');
    const bobGotFact = bobTurn !== undefined && bobTurn.messages.some((message) => hasFact(String((message as { content?: unknown }).content ?? '')) && String((message as { content?: unknown }).content).includes(aSubmit));
    const aliceGotFact = aliceTurn !== undefined && aliceTurn.messages.some((message) => hasFact(String((message as { content?: unknown }).content ?? '')) && String((message as { content?: unknown }).content).includes(aSubmit));
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
// MU-8 企微群聊与私聊隔离（依赖 B2 静默闸 → 未合入 → BLOCKED）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu8(_rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-8';
  const title = '企微群聊与私聊隔离（依赖 B2 静默闸）';
  const b2Module = path.join(REPO_ROOT, 'packages', 'channel-wecom', 'src', 'silent-shadow-gate.ts');
  const satisfied = existsSync(b2Module);
  const evidence = {
    dependency: 'B2 企微静默闸（出站机械闸门）',
    satisfyingModule: 'packages/channel-wecom/src/silent-shadow-gate.ts',
    modulePresentOnBaseline: satisfied,
    upstreamBranch: 'arch/wecom-silent-shadow',
    upstreamMergedIntoBaseline: false,
    reason: satisfied ? 'B2 已合入' : 'B2 未合入：出站无机械静默闸，群聊/私聊出站隔离不可在无真实企微的前提下确定性验证；MU-8 的静默投递=0 判据不可满足。',
  };
  if (!satisfied) return blocked(id, title, 'BLOCKED：依赖 B2 未合入（无企微静默闸），群聊与私聊隔离不可确定性验证。', evidence);
  return blocked(id, title, 'BLOCKED：B2 存在但 MU-8 确定性用例未接线（本 run 不接真实企微）。', evidence);
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
