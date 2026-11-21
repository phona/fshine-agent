/**
 * RBAC·进程级共享 runner 的执行器缓存键（2026-11-19）。
 *
 * 缺陷面：共享 runner 跨主体复用时按「权限档位」缓存执行器；若档位只有 ro/rw 两档，
 * 自定义角色（`roles:` 段可以声明任意 read/write 子集，例如只有 write）会与读写角色
 * 共用同一个执行器——后者的只读面被前者的缓存吞掉，用户级表现是「有权限却调不了」。
 *
 * 判据：缓存键必须是权限集合本身，且不同集合确实派生出不同的允许集合（不同面不得共用
 * 缓存项）。反向绊线：把 `permissionsKey` 改回按 `includes('write')` 的布尔档位 → 本用例红。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { permissionsKey, resolveExecutionFace } from './ask-runtime';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

describe('RBAC·执行器缓存键 = 权限集合', () => {
  it('只有 write 与 read+write 不得共用键；集合顺序不影响键', () => {
    expect(permissionsKey(['write'])).not.toBe(permissionsKey(['read', 'write']));
    expect(permissionsKey(['read'])).not.toBe(permissionsKey(['read', 'write']));
    expect(permissionsKey(['read', 'write'])).toBe(permissionsKey(['write', 'read']));
    expect(permissionsKey([])).toBe('none');
  });

  it('不同键确实对应不同的允许集合（只有 write 的角色拿不到读面）', async () => {
    const faceOf = (permissions: ('read' | 'write')[]) => resolveExecutionFace({
      profile: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
      stateDir: path.join(process.env['TMPDIR'] || '/tmp', 'rbac-key-face'),
      emptyOperationsMessage: '（测试）空允许集合',
      allowWriteOperations: true,
      allowedPermissions: permissions,
    });
    const writeOnly = await faceOf(['write']);
    const readWrite = await faceOf(['read', 'write']);
    expect(writeOnly.allowedOperations.length).toBeGreaterThan(0);
    expect(writeOnly.allowedOperations).not.toContain(readWrite.readOnlyOperations[0]);
    expect(readWrite.allowedOperations).toEqual([...readWrite.readOnlyOperations, ...writeOnly.allowedOperations]);
  });
});
