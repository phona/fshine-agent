/**
 * F 组·写确认回环（W-22～W-25）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 机械判据（用户可见结果；模型响应脚本化、执行层真实）：
 *   W-22  写请求 → 用户可见**提案**（集合/窗口/条数/不可撤销/有效期），零写入
 *         （dummy 审计无 commit 成功行、alpha W1 仍 2 条）；
 *   W-23  回 `确认` → 执行层 commit 成功并可读回（alpha W1 = 4 条）；
 *   W-24  再回一次 `确认` → **只执行一次**（仍 4 条），第二次被执行层确定性拒绝；
 *   W-25  `allowWriteOperations: false` 装配下同一请求 → 明确拒绝、零写入、不宣称成功。
 *
 * 句柄纪律：needs_confirmation 的 handle 是宿主持有的确认凭据（不进模型转录）；模型在
 * 下一回合的 commit 调用只给集合/窗口/条数，宿主把 handle 原样透传给执行层。脚本因此
 * 不需要、也拿不到 handle——这正是断言面（模型不能伪造/转交句柄）。
 *
 * 数字/状态全部来自执行层真实返回（dummy 子进程的 RESULT 信封、audit.jsonl、query 读回）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  lastToolResultJsonOf,
  lastToolResultOf,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  type WecomSimFixture,
} from './harness';

const DUMMY_CLI = path.resolve(__dirname, '..', 'fixtures', 'dummy-platform', 'bin', 'dummy.cjs');

interface AuditRow {
  mode?: string;
  script?: string;
  exitCode?: number;
  refused?: string;
}

/** 执行层审计（audit.jsonl）：证据的唯一来源；不存在 = 还没有任何执行调用。 */
function auditRows(sim: WecomSimFixture): AuditRow[] {
  const auditPath = path.join(sim.execStateDir, 'audit.jsonl');
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditRow);
}

/** commit 成功行数（exitCode=0 且无 refused）——「写了没有」的机械读数。 */
function commitSuccessCount(sim: WecomSimFixture): number {
  return auditRows(sim).filter((row) => row.script === 'dummy.commit' && row.refused === undefined && row.exitCode === 0).length;
}

/** 直接向执行层读回（与用户可见数字同一来源；只读查询，不驱动模型）。 */
function queryDummy(sim: WecomSimFixture, collection: string, window: string): { count: number } {
  const run = spawnSync(
    process.execPath,
    [DUMMY_CLI, 'query', 'dummy.query', '--collection', collection, '--window', window, '--state-dir', sim.execStateDir],
    { encoding: 'utf8' },
  );
  const line = run.stdout.split('\n').filter((candidate) => candidate.startsWith('RESULT ')).pop();
  if (line === undefined) throw new Error(`dummy query 没有 RESULT 信封（exit ${String(run.status)}）：${run.stderr.slice(0, 200)}`);
  const envelope = JSON.parse(line.slice('RESULT '.length)) as { status?: string; data?: { count?: number } };
  if (envelope.status !== 'completed') throw new Error(`dummy query 未 completed：${line.slice(0, 200)}`);
  return { count: envelope.data?.count ?? 0 };
}

/** 执行层真实 needs_confirmation → 用户可读提案（集合/窗口/条数/不可撤销/有效期）。 */
function describeProposal(outcome: Record<string, unknown>): string {
  if (outcome['status'] !== 'needs_confirmation') throw new Error(`预期 needs_confirmation，实际：${JSON.stringify(outcome)}`);
  const data = (outcome['data'] ?? {}) as { collection?: string; window?: string; count?: number; expiresAt?: string };
  const expiresAt = typeof outcome['expiresAt'] === 'string' ? outcome['expiresAt'] : (data.expiresAt ?? '');
  return `提案：给 ${data.collection ?? ''} 集合 ${data.window ?? ''} 追加 ${String(data.count ?? '?')} 条记录（此操作不可撤销）；`
    + `有效期至 ${expiresAt}。确认无误请回复「确认」，我再提交执行。`;
}

/** 执行层真实 commit 返回 → 如实话术（completed / 确定性拒绝两态）。 */
function describeCommit(outcome: Record<string, unknown>): string {
  if (outcome['status'] === 'completed') {
    const data = (outcome['data'] ?? {}) as { collection?: string; window?: string; count?: number; total?: number };
    return `已写入 ${data.collection ?? ''} 集合 ${data.window ?? ''}：新增 ${String(data.count ?? '?')} 条，读回共 ${String(data.total ?? '?')} 条。`;
  }
  const error = (outcome['error'] ?? {}) as { code?: string; message?: string };
  return `这次没有写入：执行层确定性拒绝（${error.code ?? '拒绝'}），集合没有变化。`;
}

describe('F 组·写确认回环（W-22～W-25）', () => {
  it('W-22 写请求先给提案、零写入；W-23 确认后写入并读回 4 条；W-24 再确认确定性拒绝', async () => {
    const sim = await startWecomSim({ label: 'w22-24', allowWriteOperations: true });
    try {
      // ── W-22：提案，不直接写 ──────────────────────────────────────────────
      sim.book.mainTurn('给 alpha 集合 W1 追加 2 条记录', [
        toolCallAssistant('task_run', { task: '给 alpha 集合 W1 追加 2 条记录' }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (summary === '') throw new Error('Main 脚本没有拿到 task_run 的真实摘要。');
          return textAssistant(summary);
        },
      ]);
      sim.book.workerTask('给 alpha 集合 W1 追加 2 条记录', [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.prepare',
          args: { '--collection': 'alpha', '--window': 'W1', '--count': '2' },
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到 dummy.prepare 的真实返回。');
          return textAssistant(describeProposal(outcome));
        },
      ]);
      const w22 = sim.sendText('给 alpha 集合 W1 追加 2 条记录');
      await sim.waitFor('W-22 提案终帧', () => sim.finalBubbles().length === 1);

      const proposal = sim.finalBubbles()[0]!.content;
      expect(proposal).toContain('提案');
      expect(proposal).toContain('alpha');
      expect(proposal).toContain('W1');
      expect(proposal).toContain('2 条');
      expect(proposal).toContain('不可撤销');
      expect(proposal).toContain('有效期');
      // 提案请求用户表态，不宣称已写入。
      expect(proposal).toContain('确认');
      expect(proposal).not.toContain('已写入');
      // 零写入：审计无 commit 成功行，alpha W1 仍 2 条。
      expect(commitSuccessCount(sim)).toBe(0);
      expect(queryDummy(sim, 'alpha', 'W1').count).toBe(2);
      // 执行事实：prepare 真实返回 needs_confirmation（不是本地推断）。
      expect(sim.doneOf(w22)!.executions).toHaveLength(1);
      expect(sim.doneOf(w22)!.executions[0]).toMatchObject({ operation: 'dummy.prepare', status: 'needs_confirmation' });

      // ── W-23：确认 → commit 成功、读回 4 条 ───────────────────────────────
      // W-23 与 W-24 的用户原话都是「确认」：脚本表同一键一次登记两次回合的四步
      //（task_run → 转述 × 2），不覆盖前一轮，也不改产品行为。
      sim.book.mainTurn('确认', [
        toolCallAssistant('task_run', { task: '确认给 alpha 集合 W1 追加 2 条记录' }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (summary === '') throw new Error('Main 脚本没有拿到 task_run 的真实摘要。');
          return textAssistant(summary);
        },
        toolCallAssistant('task_run', { task: '再次确认给 alpha 集合 W1 追加 2 条记录' }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (summary === '') throw new Error('Main 脚本没有拿到第二次 task_run 的真实摘要。');
          return textAssistant(summary);
        },
      ]);
      sim.book.workerTask('确认给 alpha 集合 W1 追加 2 条记录', [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.commit',
          args: { '--collection': 'alpha', '--window': 'W1', '--count': '2' },
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到 dummy.commit 的真实返回。');
          return textAssistant(describeCommit(outcome));
        },
      ]);
      const w23 = sim.sendText('确认');
      await sim.waitFor('W-23 写入终帧', () => sim.finalBubbles().length === 2);

      const confirmed = sim.finalBubbles()[1]!.content;
      expect(confirmed).toContain('已写入');
      expect(confirmed).toContain('alpha');
      expect(confirmed).toContain('4 条');
      expect(commitSuccessCount(sim)).toBe(1);
      expect(queryDummy(sim, 'alpha', 'W1').count).toBe(4);
      const w23Done = sim.doneOf(w23)!;
      expect(w23Done.executions).toHaveLength(1);
      expect(w23Done.executions[0]).toMatchObject({ operation: 'dummy.commit', status: 'completed' });

      // ── W-24：再回一次确认 → 只执行一次（仍 4 条），第二次确定性拒绝 ──────────
      sim.book.workerTask('再次确认给 alpha 集合 W1 追加 2 条记录', [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.commit',
          args: { '--collection': 'alpha', '--window': 'W1', '--count': '2' },
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到第二次 commit 的真实返回。');
          return textAssistant(describeCommit(outcome));
        },
      ]);
      const w24 = sim.sendText('确认');
      await sim.waitFor('W-24 拒绝终帧', () => sim.finalBubbles().length === 3);

      const rejected = sim.finalBubbles()[2]!.content;
      expect(rejected).toContain('没有写入');
      expect(rejected).not.toContain('已写入');
      // 只执行一次：commit 成功行仍为 1，读回仍 4 条（不是 6 条）。
      expect(commitSuccessCount(sim)).toBe(1);
      expect(queryDummy(sim, 'alpha', 'W1').count).toBe(4);
      // 第二次是执行层确定性拒绝（不是宿主本地判断）。
      const w24Done = sim.doneOf(w24)!;
      expect(w24Done.executions).toHaveLength(1);
      expect(w24Done.executions[0]).toMatchObject({ operation: 'dummy.commit', status: 'refused' });
      expect(auditRows(sim).some((row) => row.refused === 'CONFIRMATION_USED' || row.refused === 'CONFIRMATION_REQUIRED')).toBe(true);
    } finally {
      await sim.close();
    }
  }, 120_000);

  it('W-25 只读装配下同一写请求：明确拒绝、零写入、不宣称成功', async () => {
    const sim = await startWecomSim({ label: 'w25' });
    try {
      sim.book.mainTurn('给 alpha 集合 W1 追加 1 条记录', [
        toolCallAssistant('task_run', { task: '给 alpha 集合 W1 追加 1 条记录' }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (summary === '') throw new Error('Main 脚本没有拿到 task_run 的真实摘要。');
          return textAssistant(summary);
        },
      ]);
      sim.book.workerTask('给 alpha 集合 W1 追加 1 条记录', [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.prepare',
          args: { '--collection': 'alpha', '--window': 'W1', '--count': '1' },
        }),
        (call) => {
          // 宿主允许集合边界的真实拒绝（写操作不在只读允许集、未发起执行）。
          const result = lastToolResultOf(call.messages);
          expect(result?.isError).toBe(true);
          expect(result?.text).toContain('不在本轮允许集合内');
          return textAssistant('当前没有写权限：写操作没有开放，这次没有执行，alpha 集合没有变化。');
        },
      ]);
      const messageId = sim.sendText('给 alpha 集合 W1 追加 1 条记录');
      await sim.waitFor('W-25 拒绝终帧', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      expect(reply).toContain('没有写权限');
      expect(reply).toContain('没有执行');
      expect(reply).not.toContain('已写入');
      expect(reply).not.toContain('成功');
      // 零写入：无执行事实、审计无写面行、alpha 仍 2 条。
      expect(sim.doneOf(messageId)!.executions).toHaveLength(0);
      expect([
        ...auditRows(sim).filter((row) => row.script === 'dummy.prepare'),
        ...auditRows(sim).filter((row) => row.script === 'dummy.commit'),
      ]).toHaveLength(0);
      expect(queryDummy(sim, 'alpha', 'W1').count).toBe(2);
    } finally {
      await sim.close();
    }
  }, 90_000);
});
