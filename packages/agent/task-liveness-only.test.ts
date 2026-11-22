/**
 * 绊线：task 没有 outcome/状态词投影，只留 liveness（宿主守护状态）与账本事实。
 *
 * 设计见 docs/design/task-redefinition.md：task = 账本事实 + liveness + worker 汇报。
 * 本文件是「删投影」的守卫：
 *   ① 源码里不得再有 outcome/状态词投影函数与类型（taskStateWordOf / taskStatusOf /
 *      taskFactKeyOf / taskStatusWord / taskFailureOutcomeOf / failureKindFor /
 *      failureFallbackTextFor / taskFailureFactText / outcomeFromTask / normalizeTask …）；
 *   ② task_status 投影只能返回 liveness + 账本事实 + replyText，键名不得出现 status/state/outcome；
 *   ③ 反向绊线：把上述形状重新放回源码扫描器必须报红（证明守卫不是永绿）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import { createSession } from './src/execution-runtime';
import { createTaskRegistry, type TaskRegistry, type TaskScope } from './src/task-registry';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 不得再出现的 outcome/状态词投影标识（删减清单）。 */
const FORBIDDEN_PROJECTIONS = [
  'taskStateWordOf',
  'TaskStateWord',
  'taskFactKeyOf',
  'taskStatusWord',
  'taskStatusOf',
  'taskReasonOf',
  'taskFailureReasonOf',
  'outcomeFromTask',
  'mapExecStatus',
  'taskFailureOutcomeOf',
  'failureKindFor',
  'failureFallbackTextFor',
  'taskFailureFactText',
  'taskStateValueOf',
  'factStateOf',
  'normalizeTask',
];

/** 状态词投影所在的历史测试模块必须删除。 */
const DELETED_MODULES = ['packages/agent/testing/task-fact-view.ts'];

/** 扫描范围（产品面 + 消费方 + 测试/评测）。 */
const SCAN_DIRS = ['apps', 'packages', 'scripts'];

/** 递归列 .ts/.tsx（不用 shell；确定性）。 */
function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      out.push(...listTs(full));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 扫描器（纯函数，供反向绊线自证）：返回命中 forbidden 标识的文件与标识。
 * 大小写敏感、整词匹配，避免误伤注释外的普通词。
 */
export function findForbiddenProjections(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    for (const name of FORBIDDEN_PROJECTIONS) {
      const pattern = new RegExp(`\\b${name}\\b`, 'u');
      if (pattern.test(text)) hits.push({ file, hit: name });
    }
  }
  return hits;
}

describe('删投影：只留 liveness + 账本事实', () => {
  it('① 源码不再出现 outcome/状态词投影标识；旧测试投影模块已删除', () => {
    const sources = new Map<string, string>();
    for (const dir of SCAN_DIRS) {
      for (const file of listTs(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file);
        // 本守卫自身与删除后的设计文档描述不算投影实现，但本文件也含这些词——排除自身。
        if (rel === 'packages/agent/task-liveness-only.test.ts') continue;
        sources.set(rel, readFileSync(file, 'utf8'));
      }
    }
    expect(findForbiddenProjections(sources)).toEqual([]);
    for (const modulePath of DELETED_MODULES) {
      expect(existsSync(path.join(ROOT, modulePath))).toBe(false);
    }
  });

  it('② task-registry 只导出 liveness 三值，没有状态词/状态枚举', () => {
    const source = readFileSync(path.join(ROOT, 'packages/agent/src/task-registry.ts'), 'utf8');
    expect(source).toContain("export type TaskLiveness = 'running' | 'died' | 'waiting_user';");
    expect(source).not.toMatch(/export type TaskStateWord/u);
    expect(source).not.toMatch(/export (type|enum) Task(State|Status)\b/u);
  });

  it('③ task_status 投影只返回 liveness + 账本事实 + replyText（无 status/state/outcome 键）', async () => {
    const scope: TaskScope = { principalId: 'wecom:liveness', sessionId: 'conv-liveness' };
    const registry = createTaskRegistry();
    registry.begin({ taskId: 'task_liveness', principalId: scope.principalId, sessionId: scope.sessionId, request: '查一下窗口 W202611' });
    registry.waitForUser('task_liveness', { missing: ['窗口编号'] });

    let captured: Record<string, unknown> | undefined;
    const mainDriver: TurnDriver = {
      async run(input) {
        captured = await input.exec('task_status', { ref: 'task_liveness' }) as Record<string, unknown>;
        return { text: '（测试回合）', messages: [] };
      },
    };
    const client: ExecutionClient = {
      async capabilities(): Promise<CapabilityManifest> {
        return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] };
      },
      async execute(): Promise<ExecutionOutcome> {
        return { status: 'completed', data: {} };
      },
    };
    const session = await createSession({
      principalId: scope.principalId,
      sessionId: scope.sessionId,
      client,
      allowedOperations: ['dummy.query'],
      mainDriver,
      workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } },
      mainSystemPrompt: '（测试）Main 系统提示',
      taskRegistry: registry,
    });
    await session.send('看看那个任务');

    expect(captured).toBeDefined();
    const keys = Object.keys(captured!);
    expect(keys.filter((key) => /^(status|state|outcome|stateWord|factKey)$/u.test(key))).toEqual([]);
    // liveness 只允许三值（有则必为其中之一）。
    const liveness = captured!['liveness'];
    if (liveness !== undefined) expect(['running', 'died', 'waiting_user']).toContain(liveness);
    // 等待事实直读：pendingQuestion 原样在（不投影成状态词）。
    expect(captured!['pendingQuestion']).toBeDefined();
    expect(captured!['claimed']).toBe(0);
    expect(captured!['resulted']).toBe(0);
  });

  it('④ 反向绊线：重新放回状态词投影，扫描器必须报红', () => {
    const sources = new Map<string, string>([
      ['packages/agent/src/task-registry.ts', "export function taskStateWordOf(task: unknown) { return 'failed'; }"],
      ['scripts/tasks.ts', "const word = taskStatusWord(task); // 'reported'"],
      ['apps/server/server.ts', 'export function taskFailureOutcomeOf(input: unknown) { return "failed"; }'],
    ]);
    const hits = findForbiddenProjections(sources);
    expect(hits.map((hit) => hit.hit).sort()).toEqual(
      ['taskFailureOutcomeOf', 'taskStateWordOf', 'taskStatusWord'].sort(),
    );
  });
});
