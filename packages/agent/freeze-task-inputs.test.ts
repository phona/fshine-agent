import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeTaskInputs, requestWithFrozenInputs, type FrozenTaskInput } from './src/freeze-task-inputs';

const roots: string[] = [];
function fixture() {
  const platformRoot = mkdtempSync(path.join(tmpdir(), 'fshine-frozen-input-'));
  roots.push(platformRoot);
  const source = path.join(platformRoot, 'tmp', 'attachments', 'data.xlsx');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, 'ORIGINAL');
  return { platformRoot, source, workspaceDir: `tmp/task_${randomUUID()}` };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('task input materialization', () => {
  it('freezes exact trusted inputs before queueing; later uploads cannot change the run input', async () => {
    const f = fixture();
    const files = [{ filename: 'data.xlsx', path: f.source, bytes: 8 }];
    const frozen = await materializeTaskInputs({ ...f, runId: 'run_a', files });
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ sourcePath: f.source, filename: 'data.xlsx', size: 8, sha256: createHash('sha256').update('ORIGINAL').digest('hex') });
    expect(frozen[0]!.path).toContain(path.join(f.workspaceDir, '.inputs', 'run_a'));
    writeFileSync(f.source, 'REPLACED');
    expect(readFileSync(frozen[0]!.path, 'utf8')).toBe('ORIGINAL');
  });

  it('same-run repeated materialization verifies existing bytes instead of replacing the frozen copy', async () => {
    const f = fixture();
    const input = { ...f, runId: 'run_idempotent', files: [{ filename: 'data.xlsx', path: f.source, bytes: 8 }] };
    const first = await materializeTaskInputs(input);
    expect(await materializeTaskInputs(input)).toEqual(first);
    writeFileSync(f.source, 'CHANGED!');
    await expect(materializeTaskInputs(input)).rejects.toThrow(/改变|不同|一致/);
    expect(readFileSync(first[0]!.path, 'utf8')).toBe('ORIGINAL');
  });

  it('rejects a source escaping the trusted platform root or a workspace escape', async () => {
    const f = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), 'fshine-outside-input-'));
    roots.push(outside);
    writeFileSync(path.join(outside, 'outside.xlsx'), 'ORIGINAL');
    await expect(materializeTaskInputs({ ...f, runId: 'run_a', files: [{ filename: 'outside.xlsx', path: path.join(outside, 'outside.xlsx'), bytes: 8 }] })).rejects.toThrow();
    await expect(materializeTaskInputs({ ...f, workspaceDir: '../escape', runId: 'run_a', files: [] })).rejects.toThrow();
  });

  it('refuses symlink staging directories and sanitizes filenames into the run input folder', async () => {
    const f = fixture();
    const workspace = path.join(f.platformRoot, f.workspaceDir);
    mkdirSync(workspace, { recursive: true });
    symlinkSync(path.dirname(f.source), path.join(workspace, '.inputs'));
    await expect(materializeTaskInputs({ ...f, runId: 'run_a', files: [{ filename: '../data.xlsx', path: f.source, bytes: 8 }] })).rejects.toThrow();
    rmSync(path.join(workspace, '.inputs'));
    const [file] = await materializeTaskInputs({ ...f, runId: 'run_b', files: [{ filename: '../data.xlsx', path: f.source, bytes: 8 }] });
    expect(path.relative(workspace, file!.path)).not.toContain('..');
    expect(file!.filename).toBe('data.xlsx');
  });

  it('refuses inputs over the write-gate byte cap before reading them (D-130)', async () => {
    const f = fixture();
    const huge = path.join(f.platformRoot, 'tmp', 'attachments', 'huge.xlsx');
    writeFileSync(huge, '');
    truncateSync(huge, 256 * 1024 + 1);
    // fail-closed：读取前拒绝（stat 判体积），错误信息带可行动指引。
    await expect(materializeTaskInputs({
      ...f,
      runId: 'run_big',
      files: [{ filename: 'huge.xlsx', path: huge, bytes: 256 * 1024 + 1 }],
    })).rejects.toThrow(/262145 字节 > 262144 字节.*重新上传|超过单文件上限/);
  });
});

describe('requestWithFrozenInputs 路径替换（D-130 表征）', () => {
  const frozen: FrozenTaskInput[] = [{
    sourcePath: '/srv/platform/tmp/attachments/data.xlsx',
    path: '/srv/platform/tmp/task_t1/.inputs/run_1/1_data.xlsx',
    filename: 'data.xlsx',
    size: 8,
    sha256: 'ab'.repeat(32),
  }];

  function bodyOf(output: string): string {
    return output.split('\n【本次任务输入清单')[0]!;
  }

  it('replaces the exact host-selected literal spelling with the frozen path', () => {
    const output = requestWithFrozenInputs('读取 /srv/platform/tmp/attachments/data.xlsx 汇总', frozen);
    expect(bodyOf(output)).toBe('读取 /srv/platform/tmp/task_t1/.inputs/run_1/1_data.xlsx 汇总');
  });

  it('does NOT replace relative or ./-prefixed spellings — known gap, pinned as-is', () => {
    // 钉现状（D-130 第二半）：替换只认宿主选定字面量的精确拼法；相对名与 ./ 前缀形态
    // 不在替换面内。这是已登记的缝——未经登记不擅自扩大替换面（扩大 = 重新解释模型
    // 输入的路径语义，归执行层/后续波次决策）。
    const relative = requestWithFrozenInputs('读取 data.xlsx 汇总', frozen);
    expect(bodyOf(relative)).toBe('读取 data.xlsx 汇总');
    const dotSlash = requestWithFrozenInputs('读取 ./tmp/attachments/data.xlsx 汇总', frozen);
    expect(bodyOf(dotSlash)).toBe('读取 ./tmp/attachments/data.xlsx 汇总');
  });

  it('appends the authoritative read-only input list after the rewritten request', () => {
    const output = requestWithFrozenInputs('读取 /srv/platform/tmp/attachments/data.xlsx 汇总', frozen);
    expect(output).toContain('【本次任务输入清单；路径由宿主固定】');
    expect(output).toContain(JSON.stringify([{ path: frozen[0]!.path, filename: 'data.xlsx', size: 8, sha256: 'ab'.repeat(32) }]));
    expect(output).not.toContain(frozen[0]!.sourcePath);
  });

  it('returns the request untouched when there is nothing to freeze', () => {
    expect(requestWithFrozenInputs('普通请求', [])).toBe('普通请求');
  });
});
