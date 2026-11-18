/**
 * workspace 目录布局派生（CAP-01 S1 测试补齐；docs/architecture/files.md §2/§3）。
 *
 * S0 落了派生函数（file-store.ts），但确定性此前没有测试锁住。本文件只锁派生面（纯字符串
 * 运算，不触盘写）：
 *   ① 确定性：同输入 → 同路径；哈希 = 身份 sha256 前 16 hex 的纯函数——file_refs 不存
 *      path，字节落点每次重开都按同一公式重推，公式漂移 = 存量字节全体失联，所以按公式锁；
 *      路径形状 = <root>/<principalHash>/<sessionHash>/{files,runs/<runId>}；用户可见 name
 *      不进路径（路径不可由 name 拼出）。
 *   ② 不重叠：换 session / 换 principal / 换 fileId / 换 runId → 落点互异；run 目录严格落在
 *      本会话目录之下（前缀含分隔符，防前缀字符串碰撞）。
 *   ③ runId 形状守卫：'../' / 子路径 / 空串 / 超长确定性拒绝——派生路径不可被 runId 推出
 *      会话目录。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileStoragePathOf,
  principalHashOf,
  runDirOf,
  safeExtensionOf,
  sessionDirOf,
  sessionHashOf,
} from './src/file-store';

/** 派生函数不触盘：根路径只是参与字符串拼接的输入，任意值皆可。 */
const ROOT = path.join('probe-root', 'workspace');
const SCOPE_A = { principalId: 'wecom:u1', sessionId: 'sess-a' };

function expectedHash(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
}

describe('workspace 目录布局派生（CAP-01）', () => {
  it('① 派生路径确定性：同输入同路径；哈希 = 身份 sha256 前 16 hex；形状固定、name 不进路径', () => {
    const sessionDir = sessionDirOf(ROOT, SCOPE_A);
    expect(sessionDir).toBe(path.join(ROOT, expectedHash('wecom:u1'), expectedHash('sess-a')));
    // 重复求值一致；跨进程确定性由「哈希是身份的纯函数」保证（上一行已按公式锁）。
    expect(sessionDirOf(ROOT, SCOPE_A)).toBe(sessionDir);
    expect(principalHashOf('wecom:u1')).toBe(expectedHash('wecom:u1'));
    expect(sessionHashOf('sess-a')).toBe(expectedHash('sess-a'));

    expect(runDirOf(ROOT, SCOPE_A, 'run_abc')).toBe(path.join(sessionDir, 'runs', 'run_abc'));
    expect(runDirOf(ROOT, SCOPE_A, 'run_abc')).toBe(runDirOf(ROOT, SCOPE_A, 'run_abc'));

    // 存储落点：…/files/<fileId><安全扩展名>；用户可见 name 只活在 file_refs 行里。
    const storage = fileStoragePathOf(ROOT, SCOPE_A, 'file_abc', '数据.xlsx');
    expect(storage).toBe(path.join(sessionDir, 'files', 'file_abc.xlsx'));
    expect(storage).not.toContain('数据');
    expect(fileStoragePathOf(ROOT, SCOPE_A, 'file_abc', '数据.xlsx')).toBe(storage);
    // name 里的路径注入在结构上不可能：扩展名之外全部丢弃，'..' 不会成为路径段。
    expect(fileStoragePathOf(ROOT, SCOPE_A, 'file_abc', '../../.env')).toBe(path.join(sessionDir, 'files', 'file_abc'));
    expect(safeExtensionOf('数据.xlsx')).toBe('.xlsx');
    expect(safeExtensionOf('noext')).toBe('');
  });

  it('② 不同会话路径不重叠：换 session / 换 principal 落点互异；run 严格在本会话目录之下', () => {
    const sessB = { principalId: 'wecom:u1', sessionId: 'sess-b' };
    const principalB = { principalId: 'wecom:u2', sessionId: 'sess-a' };

    expect(sessionDirOf(ROOT, SCOPE_A)).not.toBe(sessionDirOf(ROOT, sessB));
    expect(sessionDirOf(ROOT, SCOPE_A)).not.toBe(sessionDirOf(ROOT, principalB));
    // 同名文件在不同 scope 落点不同（字节互不覆盖）。
    expect(fileStoragePathOf(ROOT, SCOPE_A, 'file_1', '数据.xlsx')).not.toBe(
      fileStoragePathOf(ROOT, sessB, 'file_1', '数据.xlsx'),
    );
    expect(fileStoragePathOf(ROOT, SCOPE_A, 'file_1', '数据.xlsx')).not.toBe(
      fileStoragePathOf(ROOT, principalB, 'file_1', '数据.xlsx'),
    );
    // 同名 run 在两会话互异；同会话不同 runId 互异。
    expect(runDirOf(ROOT, SCOPE_A, 'run_1')).not.toBe(runDirOf(ROOT, sessB, 'run_1'));
    expect(runDirOf(ROOT, SCOPE_A, 'run_1')).not.toBe(runDirOf(ROOT, SCOPE_A, 'run_2'));

    // 前缀关系带分隔符（防前缀字符串碰撞）：run 在本会话之下、不在他会话之下。
    expect(runDirOf(ROOT, SCOPE_A, 'run_1').startsWith(sessionDirOf(ROOT, SCOPE_A) + path.sep)).toBe(true);
    expect(runDirOf(ROOT, sessB, 'run_1').startsWith(sessionDirOf(ROOT, SCOPE_A) + path.sep)).toBe(false);
  });

  it('③ runId 形状守卫：越界形状确定性拒绝（派生路径不可被 runId 推出会话目录）', () => {
    for (const bad of ['../escape', 'a/b', '带空格 id', '', 'x'.repeat(65)]) {
      expect(() => runDirOf(ROOT, SCOPE_A, bad)).toThrowError(/runId 形状非法/);
    }
    expect(() => runDirOf(ROOT, SCOPE_A, 'run-ok_9')).not.toThrowError();
  });
});
