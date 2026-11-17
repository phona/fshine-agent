/**
 * R6 MU-6 · **重启恢复（多 principal，确定性）**——本文件是 MU-6 的落地实现（`../../multiuser/**` 追加）。
 *
 * 场景形状（对齐任务书与 `server-b1-persistence.test.ts` 的重启口径）：
 *   · ≥3 principal（`MU_PRINCIPALS`）各**一个独立会话**（会话 id 形如 `conv-<user>`）；
 *   · 每个 principal 首回合走**真实交互路径**交办一次后台任务（`task_run` → 后台 TaskRunner）；
 *   · **关闭 server**（`await server.close()` 释放底账 + B1 会话存储句柄）→ **同一 `dbPath` 重建 server**；
 *   · 每个 principal 再发一次普通回合（追问）；断言四类：
 *       ① **各自转录恢复**：第二回合上下文含**本人**首回合历史（用户原文 + assistant 回复）；
 *       ② **不跨 principal 串读**：第二回合上下文与任务行均不含他人语料标记；
 *       ③ **任务不重放**：重启后新 executor 一次都没被调（启动 pump 不重放已完成任务）；
 *       ④ **结果找回**：重启后经 Task Registry 取回首回合任务的**真实结果**（逐字存档）。
 *   任一命中即 FAIL；逐用例记录五要素 principalId/sessionId/taskId/request/deliveredTo。
 *
 * 复用，不建第二套：只 import 既有装配（`createMuServer` = 生产同源 `createServer` + B1 `TranscriptStore`
 * 接线）+ Task Registry 只读快照（`readTasks`）+ 既有计划表/采集面。**不**新增会话/压缩机制，
 * **不**以 `registry.get` 直调代替交互路径（判定读只读快照）。
 *
 * 零真实模型 / 零真实平台 / 零真实写：假渠道事实 + 假主驱动 + 假后台执行器（按请求原文派生确定性结果）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '@fshine/contracts';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../../../packages/agent/src/task-runner';
import {
  createMuServer, deliver, incoming, makeCtx, makeTempDir, readTasks,
  MU_PRINCIPALS, MU_TAGS, MuPlans, principalIdOf, sessionIdOf,
  type MuCaseResult, type MuDeliveryRecord, type MuHardZero, type MuTaskSnapshot,
} from './mu-support';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const EVIDENCE_ROOT = path.join(REPO_ROOT, '.runtime', 'r6', 'multiuser');

/** 首/次回合语料后缀与确定性结果前缀（结果按请求原文派生，不依赖并发调用顺序）。 */
const R1_SUFFIX = ' 重启前交办';
const R2_SUFFIX = ' 重启后追问';
const RESULT_PREFIX = 'RESULT:';

function tagOf(text: string): string | null {
  for (const tag of Object.values(MU_TAGS)) if (text.includes(tag)) return tag;
  return null;
}

/** 唯一语料标记（本 principal）；用于「不跨 principal 串读」检漏。 */
function ownTag(userId: (typeof MU_PRINCIPALS)[number]): string {
  return MU_TAGS[userId];
}
function foreignTags(userId: (typeof MU_PRINCIPALS)[number]): string[] {
  return MU_PRINCIPALS.filter((candidate) => candidate !== userId).map(ownTag);
}

/**
 * 按 `TaskExecutionInput.request` 派生确定性结果的假后台执行器：
 * `resultText = RESULT:<该请求所属 principal 的标记>`。`calls` 计数用作重放检测
 * （重启后新实例一旦被调即 > 0）。
 */
export class TagKeyedExecutor implements TaskExecutor {
  calls = 0;
  constructor(private readonly prefix: string) {}
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    this.calls += 1;
    const tag = tagOf(input.request) ?? 'UNKNOWN';
    return { kind: 'completed', resultText: `${this.prefix}${tag}` };
  }
}

/** 转录消息的文本投影（Pi 消息 content 可为字符串或内容块数组）。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }
  return '';
}

function messagesText(messages: readonly unknown[]): string {
  return messages.map(textOf).join('\n');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function writeEvidence(result: MuCaseResult): MuCaseResult {
  mkdirSync(path.join(EVIDENCE_ROOT, result.id), { recursive: true });
  writeFileSync(path.join(EVIDENCE_ROOT, result.id, 'evidence.json'), JSON.stringify(result, null, 2));
  return result;
}

export async function mu6Restart(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-6';
  const title = '重启恢复（≥3 principal 同 dbPath 关停重建：转录恢复 / 不跨读 / 任务不重放 / 结果找回）';
  const tmp = makeTempDir('mu6-');
  const plans = new MuPlans();
  for (const userId of MU_PRINCIPALS) {
    // 首回合 = 交办（后台任务）；次回合 = 普通追问（无副作用）。
    plans.delegate(userId, `${ownTag(userId)}${R1_SUFFIX}`, {
      reply: `${ownTag(userId)} 已受理，稍后通知你。`,
      operation: 'dummy.query',
      args: { '--collection': ownTag(userId) },
      summary: `${ownTag(userId)} 完成。`,
    });
    plans.turn(userId, `${ownTag(userId)}${R2_SUFFIX}`, { reply: `${ownTag(userId)} 收到。` });
  }
  const ctx = makeCtx(plans.table());
  const exec1 = new TagKeyedExecutor(RESULT_PREFIX);

  // ── 第一个 server：三 principal 并发交办 → 等全部完成 → 关停 ───────────────────
  const server1 = await createMuServer({ dir: tmp.dir, ctx, mode: 'background', runtime: rt, taskExecutor: exec1 });
  let tasksBeforeRestart: MuTaskSnapshot[] = [];
  try {
    const replies1 = await Promise.all(
      MU_PRINCIPALS.map((userId, index) =>
        deliver(server1.server.handler, incoming(userId, `conv-${userId}`, `r1-${index}`, `${ownTag(userId)}${R1_SUFFIX}`)),
      ),
    );
    void replies1;
    await waitUntil(() =>
      readTasks(server1.dbPath).filter((task) => task.status === 'completed').length >= MU_PRINCIPALS.length,
    );
    tasksBeforeRestart = readTasks(server1.dbPath);
  } finally {
    // 同 dbPath 重建前必须释放底账与 B1 会话存储句柄（否则同文件二次打开读到陈旧内存态）。
    await server1.server.close();
  }

  // ── 第二个 server：同一 dbPath / dir 重建（= 进程重启）；新 executor 即重放检测器 ──
  const exec2 = new TagKeyedExecutor(RESULT_PREFIX);
  const server2 = await createMuServer({ dir: tmp.dir, ctx, mode: 'background', runtime: rt, taskExecutor: exec2 });
  const hardZeroHits: MuHardZero[] = [];
  try {
    // 让启动 pump 跑完：若重放已完成任务，exec2.calls 会 > 0。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replayCallsAfterPump = exec2.calls;

    const replies2 = new Map<string, string>();
    for (const [index, userId] of MU_PRINCIPALS.entries()) {
      replies2.set(userId, await deliver(server2.server.handler, incoming(userId, `conv-${userId}`, `r2-${index}`, `${ownTag(userId)}${R2_SUFFIX}`)));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replayCallsAfterTurn = exec2.calls;

    const tasksAfterRestart = readTasks(server2.dbPath);

    // ① 各自转录恢复：第二回合上下文含本人首回合用户原文与 assistant 回复。
    const restored: Record<string, boolean> = {};
    for (const userId of MU_PRINCIPALS) {
      const r2Text = `${ownTag(userId)}${R2_SUFFIX}`;
      const record = ctx.mainRecords.find((candidate) => candidate.principalId === principalIdOf(userId) && candidate.userText === r2Text);
      const seen = record === undefined ? '' : messagesText(record.messages);
      restored[userId] = record !== undefined
        && seen.includes(`${ownTag(userId)}${R1_SUFFIX}`)
        && seen.includes(`${ownTag(userId)} 已受理，稍后通知你。`);
      if (!restored[userId]) hardZeroHits.push('cross_principal_leak');
    }

    // ② 不跨 principal 串读：第二回合上下文不得含他人语料标记。
    const transcriptViolations: string[] = [];
    for (const userId of MU_PRINCIPALS) {
      const r2Text = `${ownTag(userId)}${R2_SUFFIX}`;
      const record = ctx.mainRecords.find((candidate) => candidate.principalId === principalIdOf(userId) && candidate.userText === r2Text);
      if (record === undefined) continue;
      const seen = messagesText(record.messages);
      for (const foreign of foreignTags(userId)) {
        if (seen.includes(foreign)) transcriptViolations.push(`${principalIdOf(userId)} 第二回合上下文出现他人标记 ${foreign}`);
      }
    }
    if (transcriptViolations.length > 0) hardZeroHits.push('cross_principal_leak');

    // ②(任务侧) 不跨 principal 串读：每 principal 恰一任务，请求标记与 principal 匹配。
    const taskViolations: string[] = [];
    for (const userId of MU_PRINCIPALS) {
      const scoped = tasksAfterRestart.filter(
        (task) => task.principalId === principalIdOf(userId) && task.sessionId === sessionIdOf(`conv-${userId}`),
      );
      if (scoped.length !== 1) { taskViolations.push(`${principalIdOf(userId)} 任务数=${scoped.length}（应 1）`); continue; }
      const task = scoped[0]!;
      if (tagOf(task.request) !== ownTag(userId)) taskViolations.push(`任务 ${task.taskId} 请求标记 ≠ 本人标记`);
      for (const foreign of foreignTags(userId)) {
        if (task.request.includes(foreign)) taskViolations.push(`任务 ${task.taskId} 请求含他人标记 ${foreign}`);
      }
    }
    if (taskViolations.length > 0) { hardZeroHits.push('task_crossover'); hardZeroHits.push('cross_principal_leak'); }

    // ③ 任务不重放：重启后（pump + 追问回合）新 executor 从未被调。
    const noReplay = replayCallsAfterPump === 0 && replayCallsAfterTurn === 0;
    if (!noReplay) hardZeroHits.push('task_crossover');

    // ④ 结果找回：重启后经 Task Registry 取回首回合任务的真实结果（逐字）。
    const resultRetrieval: Record<string, { taskId: string; status: string; replyText: string | null; ok: boolean }> = {};
    for (const userId of MU_PRINCIPALS) {
      const task = tasksAfterRestart.find(
        (candidate) => candidate.principalId === principalIdOf(userId) && candidate.sessionId === sessionIdOf(`conv-${userId}`),
      );
      const expected = `${RESULT_PREFIX}${ownTag(userId)}`;
      const ok = task !== undefined && task.status === 'completed' && task.replyText === expected;
      resultRetrieval[userId] = {
        taskId: task?.taskId ?? '',
        status: task?.status ?? 'missing',
        replyText: task?.replyText ?? null,
        ok,
      };
      if (!ok) hardZeroHits.push('task_crossover');
    }

    // ── 五要素记录（principalId / sessionId / taskId / request / deliveredTo）──────────
    const records: MuDeliveryRecord[] = [
      ...tasksAfterRestart.map((task) => ({
        caseId: id,
        principalId: task.principalId,
        sessionId: task.sessionId,
        taskId: task.taskId,
        request: task.request,
        deliveredTo: task.sessionId,
        kind: 'reply' as const,
      })),
      ...MU_PRINCIPALS.map((userId) => ({
        caseId: id,
        principalId: principalIdOf(userId),
        sessionId: sessionIdOf(`conv-${userId}`),
        taskId: null,
        request: `${ownTag(userId)}${R2_SUFFIX}`,
        deliveredTo: sessionIdOf(`conv-${userId}`),
        kind: 'reply' as const,
      })),
    ];

    const hardZero = [...new Set(hardZeroHits)];
    return writeEvidence({
      id,
      title,
      status: hardZero.length > 0 ? 'FAIL' : 'PASS',
      hardZeroHits: hardZero,
      records,
      notes:
        `3 principal 各一会话同 dbPath 关停重建；转录恢复=${Object.values(restored).every(Boolean)}；`
        + `串读违规=${transcriptViolations.length + taskViolations.length}；重放调用=${replayCallsAfterTurn}（应 0）；`
        + `结果找回=${Object.values(resultRetrieval).every((r) => r.ok)}。`,
      evidence: {
        dbPath: path.basename(server2.dbPath),
        mode: 'background',
        principals: MU_PRINCIPALS.map(principalIdOf),
        restored,
        transcriptViolations,
        taskViolations,
        replayCallsAfterPump,
        replayCallsAfterTurn,
        noReplay,
        resultRetrieval,
        taskCountBeforeRestart: tasksBeforeRestart.length,
        taskCountAfterRestart: tasksAfterRestart.length,
        replies2: Object.fromEntries(replies2),
        tasksAfterRestart: tasksAfterRestart.map((task) => ({
          taskId: task.taskId, principalId: task.principalId, sessionId: task.sessionId,
          request: task.request, status: task.status, replyText: task.replyText,
        })),
      },
    });
  } finally {
    await server2.server.close();
    tmp.cleanup();
  }
}
