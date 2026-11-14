/**
 * 任务状态单写路径守卫（源码级；r4-joint-interfaces.md §1「唯一写路径」）。
 *
 * 判据：
 *   ① 任务表（tasks）唯一的底层写入点是 packages/core/src/task-store.ts；
 *      其余生产模块（包装层、装配、脚本、入口）不得出现任何 `UPDATE tasks` 直写 SQL；
 *   ② task-store 内写 `status` 的 `UPDATE tasks` 语句恰有一条——所有状态变化经
 *      TaskRegistry 方法族落到同一语句（原子持久化 + 事实钩子）；
 *   ③ TaskRegistry 层（内存/SQLite 实现）不含裸 SQL（UPDATE/INSERT），
 *      只经 store 方法写入。
 *
 * 扫描范围 = `git ls-files` 的生产代码（.ts/.tsx，排除 *.test.ts 自身与 node_modules）；
 * 注释剥离后匹配（注释允许讨论命名，不算直写）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRITER_FILE = 'packages/core/src/task-store.ts';
const PRODUCTION_FILE = /^(packages|apps|scripts|tests)\/.*\.(ts|tsx)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;
const REGISTRY_FILES = ['packages/agent/src/task-registry.ts', 'packages/agent/src/task-registry-sqlite.ts'] as const;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');
}

/** 剥离块注释与行注释（避免注释里的 SQL 术语参与判据；不处理字符串内容是刻意的）。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

describe('任务状态单写路径守卫（源码级）', () => {
  it('task-store 之外零 `UPDATE tasks`（任何模块禁止直接写任务表）', () => {
    const hits: string[] = [];
    for (const file of trackedFiles()) {
      if (!PRODUCTION_FILE.test(file) || TEST_FILE.test(file) || file === WRITER_FILE) continue;
      const text = stripComments(read(file));
      for (const match of text.matchAll(/UPDATE\s+tasks\b/gi)) {
        hits.push(`${file}@${match.index ?? 0}`);
      }
    }
    console.log(JSON.stringify({ event: 'task_write_path_guard', hits: hits.length }));
    expect(hits, `task-store 之外出现任务表直写：\n${hits.join('\n')}`).toEqual([]);
  });

  it('task-store 内「UPDATE tasks … SET … status」恰一条（单一语句写状态）', () => {
    const text = stripComments(read(WRITER_FILE));
    const statements = [...text.matchAll(/UPDATE\s+tasks\b([\s\S]{0,400})/gi)];
    const statusWriters = statements.filter((match) => /status\s*=/i.test(match[1] ?? ''));
    console.log(JSON.stringify({
      event: 'task_write_path_statements',
      total: statements.length,
      statusWriters: statusWriters.length,
    }));
    expect(statusWriters).toHaveLength(1);
  });

  it('TaskRegistry 实现层不含裸 SQL（只经 store 方法写入）', () => {
    for (const file of REGISTRY_FILES) {
      const text = stripComments(read(file));
      expect(text.match(/UPDATE\s+tasks\b/gi) ?? [], `${file} 出现任务表直写`).toEqual([]);
      expect(text.match(/\bINSERT\s+INTO\b/gi) ?? [], `${file} 出现裸 INSERT`).toEqual([]);
    }
  });
});
