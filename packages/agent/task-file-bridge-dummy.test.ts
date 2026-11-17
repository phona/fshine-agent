/**
 * 业务级用例：**入站附件交给执行层**（2026-11-17 补）。
 *
 * 之前只有「目录参数」翻译，且用假执行客户端验证；真 dummy 的 `dummy.scratch --input`
 * 这类**单文件参数**宿主填不进去，附件实际上永远到不了执行层。
 *
 * 本用例用**真 dummy 夹具**跑完整一轮：
 *   附件（任务绑定的文件行）→ 宿主物化到 tmp/task_<id>/in/ → 单文件参数被替换成物化路径
 *   → dummy 读到附件内容（返回 lines/chars）→ dummy 把结果写进宿主分配的 out/ 路径
 *   → 兜底扫描把该文件登记成任务产物（进入交付面）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import { createFileStore } from './src/file-store';
import { createDummyCliClient } from './src/dummy-cli-client';
import { createTaskExecutionBridge } from './src/task-file-bridge';

const FIXTURE_ROOT = path.resolve(__dirname, '../../scripts/eval/fixtures/dummy-platform');
const SCOPE = { principalId: 'wecom:u-bridge', sessionId: 'bridge-dummy' };
const TASK = 'task_bridgedummy';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-dummy-'));
  dirs.push(dir);
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'dummy-state.json'), `${JSON.stringify({ collections: {} })}\n`);
  const workspaceRoot = path.join(dir, 'workspace');
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  const client = createDummyCliClient({
    root: FIXTURE_ROOT,
    gateway: 'bin/dummy',
    stateDir,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
  });
  return { dir, store, fileStore, client };
}

describe('业务面：附件 → 执行层（真 dummy 夹具）', () => {
  it('单文件参数：执行层读到的是附件字节；写出的文件被登记成任务产物', async () => {
    const { dir, store, fileStore, client } = makeFixture();
    // 交办副本（任务绑定的文件行）——等价于用户把附件交给这个任务。
    const attachment = fileStore.registerTaskFile({
      scope: SCOPE,
      taskId: TASK,
      name: '名册.csv',
      bytes: Buffer.from('a\nb\nc\n'),
      maxFileBytes: 4096,
    });

    const bridge = createTaskExecutionBridge({
      platformRoot: dir,
      fileStore,
      scope: SCOPE,
      inner: client,
      fileParams: { input: '--input', output: '--output' },
    })(TASK);

    const outcome = await bridge.client.execute({
      requestId: 'req_bridge_1',
      dispatchKey: 'bridge:1',
      operation: 'dummy.scratch',
      // 模型看不到真实路径：这里给占位值，宿主按声明替换成物化路径。
      args: { '--input': '(host-fills)', '--output': '(host-fills)' },
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('执行层未返回 completed');
    const data = outcome.data as { input: string; output: string; lines: number; chars: number };
    // 执行层真的读到了附件：3 行、6 字节（'a\nb\nc\n'）。
    expect(data.lines).toBe(3);
    expect(data.chars).toBe(6);
    // 路径由宿主分配，且落在任务暂存目录内（不把用户/宿主的真实路径透给模型）。
    expect(data.input).toContain(path.join('tmp', `task_${TASK}`, 'in'));
    expect(data.output).toContain(path.join('tmp', `task_${TASK}`, 'out'));
    expect(readFileSync(data.input, 'utf8')).toBe('a\nb\nc\n');

    // 执行层写出的文件被兜底扫描登记成任务产物 → 进入交付面。
    const swept = bridge.sweepTaskOutputs();
    expect(swept.files.map((file) => file.name)).toContain('exec-output.json');
    const rows = store.listFileRefs(SCOPE).filter((row) => row.taskId === TASK);
    expect(rows.some((row) => row.name === 'exec-output.json')).toBe(true);
    // 交办副本原样保留（不被产物覆盖）。
    expect(rows.some((row) => row.fileId === attachment.fileId)).toBe(true);
    store.close();
  }, 60_000);

  it('任务文件不是恰好一个时 fail-closed：不替调用方挑文件', async () => {
    const { dir, store, fileStore, client } = makeFixture();
    for (const name of ['甲.csv', '乙.csv']) {
      fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK, name, bytes: Buffer.from(name), maxFileBytes: 4096 });
    }
    const bridge = createTaskExecutionBridge({
      platformRoot: dir,
      fileStore,
      scope: SCOPE,
      inner: client,
      fileParams: { input: '--input' },
    })(TASK);

    await expect(
      bridge.client.execute({
        requestId: 'req_bridge_2',
        dispatchKey: 'bridge:2',
        operation: 'dummy.scratch',
        args: { '--input': '(host-fills)' },
      }),
    ).rejects.toThrow(/恰好 1 个任务文件/);
    store.close();
  }, 60_000);
});
