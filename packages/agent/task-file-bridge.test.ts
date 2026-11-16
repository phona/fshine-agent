/**
 * 执行层文件桥（CAP-01 S2 ②③④；docs/product/cap01-main-direct-execution.md §6/§10-3）。
 *
 * 覆盖：
 *   · 出站（②，assemble 装饰器）：替换执行层**声明的目录参数**为任务暂存目录
 *     （--input-dir → <platformRoot>/tmp/task_<id>/in、--output-dir → …/out）；替换前把任务
 *     文件物化到 in/；**声明之外的一律不动**（不遍历 args 猜类型——路径形状的未声明参数
 *     原样透传）；未声明目录参数的调用零翻译、零物化（任务目录不创建）；裸名形态归一到
 *     声明形态；请求其余字段（requestId/dispatchKey/operation）原样；
 *   · 回程（③，登记调用点在 runtime 出口，桥只承担登记本体）：data.files 的 path 条目
 *     （任务目录内）与内联 base64 条目 → 登记事实替换原条目（path/base64 不再出现在替换
 *     列表）；任务目录外的 path / 非绝对 path → unavailable 标记（机械 reason）；无字节面
 *     的条目（纯 name 元数据、字符串等）**原样透传**（宿主只消费它声明的形状）；
 *   · 兜底（④，v8 §10-3）：sweepTaskOutputs 扫 <taskDir>/out/ 全量登记；重复扫描同 sha
 *     复用旧 fileId；目录不存在 → 空结果不抛。
 *
 * 内层客户端用脚本化假件（记录收到的请求）；不触网、不碰真实平台。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import { createFileStore, fileStoragePathOf, type FileScope, type FileStore } from './src/file-store';
import { createTaskExecutionBridge, type TaskExecutionBridge, type TaskExecutionBridgeOptions } from './src/task-file-bridge';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE: FileScope = { principalId: 'wecom:u-bridge', sessionId: 'cap01-bridge' };
const TASK_A = 'task_bridge';

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [{ name: 'demo.aggregate', label: 'aggregate', args: [] }],
};

interface InnerCall {
  args: Record<string, unknown>;
  operation: string;
  requestId: string;
  dispatchKey: string;
}

/** 脚本化内层客户端：记录每次 execute 收到的 args，按队列回放 outcome。 */
function fakeInner(outcomes: ExecutionOutcome[]): { client: ExecutionClient; calls: InnerCall[] } {
  const calls: InnerCall[] = [];
  return {
    calls,
    client: {
      async capabilities() {
        return MANIFEST;
      },
      async execute(request: ExecutionRequest) {
        calls.push({ args: { ...request.args }, operation: request.operation, requestId: request.requestId, dispatchKey: request.dispatchKey });
        const outcome = outcomes.shift();
        if (outcome === undefined) throw new Error('（测试）没有更多内层 outcome');
        return outcome;
      },
    },
  };
}

interface Fixture {
  root: string;
  workspaceRoot: string;
  taskDir: string;
  fileStore: FileStore;
  store: ReturnType<typeof openTaskStore>;
  bridge: TaskExecutionBridge;
  inner: { client: ExecutionClient; calls: InnerCall[] };
  close(): void;
}

function makeFixture(input: { dirParams?: { input?: string; output?: string }; outcomes?: ExecutionOutcome[] } = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-file-bridge-'));
  dirs.push(root);
  const platformRoot = path.join(root, 'platform');
  mkdirSync(platformRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot: path.join(root, 'workspace') });
  const inner = fakeInner(input.outcomes ?? [{ status: 'completed', data: {} }]);
  const options: TaskExecutionBridgeOptions = {
    platformRoot,
    fileStore,
    scope: SCOPE,
    inner: inner.client,
    maxOutputFileBytes: 4096,
    maxOutputCount: 3,
    ...(input.dirParams === undefined ? {} : { dirParams: input.dirParams }),
  };
  const factory = createTaskExecutionBridge(options);
  return {
    root,
    workspaceRoot: path.join(root, 'workspace'),
    taskDir: path.join(platformRoot, 'tmp', `task_${TASK_A}`),
    fileStore,
    store,
    bridge: factory(TASK_A),
    inner,
    close: () => store.close(),
  };
}

function executeWith(bridge: TaskExecutionBridge, args: Record<string, unknown>): Promise<ExecutionOutcome> {
  return bridge.client.execute({ requestId: 'req_1', dispatchKey: 'dk_1', operation: 'demo.aggregate', args });
}

describe('出站：声明目录参数替换 + 任务文件物化（②）', () => {
  it('声明参数替换为任务暂存目录；任务文件物化到 in/；未声明参数（含路径形状）原样', async () => {
    const fx = makeFixture({ dirParams: { input: '--input-dir', output: '--output-dir' } });
    try {
      const mainFile = fx.fileStore.putFile({ scope: SCOPE, name: '名册.csv', bytes: Buffer.from('id,name\n1,甲\n'), activatedAt: Date.now() });
      const [copy] = fx.fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [mainFile.fileId], taskId: TASK_A });

      await executeWith(fx.bridge, {
        '--input-dir': '占位',
        '--output-dir': '占位',
        '--collection': 'documents',
        '--file': '/未声明/路径/保持原样',
      });

      expect(fx.inner.calls).toHaveLength(1);
      const sent = fx.inner.calls[0]!.args;
      expect(sent['--input-dir']).toBe(path.join(fx.taskDir, 'in'));
      expect(sent['--output-dir']).toBe(path.join(fx.taskDir, 'out'));
      expect(sent['--collection']).toBe('documents');
      // 未声明参数（哪怕形状像路径）原样——宿主不遍历 args 猜类型。
      expect(sent['--file']).toBe('/未声明/路径/保持原样');

      // 任务文件已物化（副本 fileId 命名 + 安全扩展名），字节与交办副本一致。
      const materialized = readFileSync(path.join(fx.taskDir, 'in', `${copy!.fileId}.csv`));
      expect(materialized.toString()).toBe('id,name\n1,甲\n');
    } finally {
      fx.close();
    }
  });

  it('裸名形态归一到声明形态（宿主替换值、删除裸名键）', async () => {
    const fx = makeFixture({ dirParams: { input: '--input-dir' } });
    try {
      await executeWith(fx.bridge, { 'input-dir': '占位', '--collection': 'documents' });
      const sent = fx.inner.calls[0]!.args;
      expect(sent['--input-dir']).toBe(path.join(fx.taskDir, 'in'));
      expect(Object.prototype.hasOwnProperty.call(sent, 'input-dir')).toBe(false);
      expect(sent['--collection']).toBe('documents');
    } finally {
      fx.close();
    }
  });

  it('未声明目录参数（dirParams 留空）→ args 原样、任务目录不创建（零翻译）', async () => {
    const fx = makeFixture({});
    try {
      await executeWith(fx.bridge, { '--input-dir': '模型给的值', '--collection': 'documents' });
      const sent = fx.inner.calls[0]!.args;
      expect(sent['--input-dir']).toBe('模型给的值');
      // 零翻译零物化：任务暂存目录根本不存在。
      expect(existsSync(fx.taskDir)).toBe(false);
    } finally {
      fx.close();
    }
  });

  it('声明了目录参数但本次调用未携带 → 不替换、不物化（宿主不替执行层发明读取位置）', async () => {
    const fx = makeFixture({ dirParams: { input: '--input-dir' } });
    try {
      await executeWith(fx.bridge, { '--collection': 'documents' });
      const sent = fx.inner.calls[0]!.args;
      expect(sent).toEqual({ '--collection': 'documents' });
      expect(existsSync(fx.taskDir)).toBe(false);
    } finally {
      fx.close();
    }
  });

  it('requestId/dispatchKey/operation 原样透传（宿主只动声明目录参数的值）', async () => {
    const fx = makeFixture({ dirParams: { input: '--input-dir' } });
    try {
      await fx.bridge.client.execute({ requestId: 'req_xyz', dispatchKey: 'dk_xyz', operation: 'demo.aggregate', args: { '--input-dir': 'x' } });
      expect(fx.inner.calls[0]!.operation).toBe('demo.aggregate');
      expect(fx.inner.calls[0]!.requestId).toBe('req_xyz');
      expect(fx.inner.calls[0]!.dispatchKey).toBe('dk_xyz');
    } finally {
      fx.close();
    }
  });
});

describe('回程：data.files 登记与剥除（③）', () => {
  it('path 条目（任务目录内）与内联 base64 条目 → 登记事实替换（path/base64 不再出现）', async () => {
    const fx = makeFixture({ dirParams: { output: '--output-dir' } });
    try {
      const outDir = path.join(fx.taskDir, 'out');
      mkdirSync(outDir, { recursive: true });
      const productBytes = Buffer.from('汇总,v1\n合计,42\n');
      writeFileSync(path.join(outDir, '汇总.xlsx'), productBytes);
      const inlineBytes = Buffer.from('明细,v2\n行,8\n');

      const result = await fx.bridge.registerReturnedFiles([
        { name: '汇总.xlsx', path: path.join(outDir, '汇总.xlsx') },
        { name: '明细.csv', content: inlineBytes.toString('base64') },
      ]);

      expect(result.files).toHaveLength(2);
      expect(result.entries).toHaveLength(2);
      for (const fact of result.entries) {
        expect(Object.keys(fact as Record<string, unknown>).sort()).toEqual(['bytes', 'fileId', 'name']);
      }
      const joined = JSON.stringify(result.entries);
      expect(joined).not.toContain('base64');
      expect(joined).not.toContain(path.join(fx.taskDir, 'out'));
      // 登记事实与源字节一致、task_id 绑定本任务。
      expect(result.files[0]!.bytes).toBe(productBytes.length);
      expect(readFileSync(fileStoragePathOf(fx.workspaceRoot, SCOPE, result.files[0]!.fileId, result.files[0]!.name))).toEqual(productBytes);
      const row = fx.store.getFileRef(result.files[1]!.fileId, SCOPE, { side: 'worker', taskId: TASK_A })!;
      expect(row.taskId).toBe(TASK_A);
      expect(row.bytes).toBe(inlineBytes.length);
    } finally {
      fx.close();
    }
  });

  it('任务目录外的 path / 相对 path → unavailable 标记（机械 reason）；无字节面条目原样透传', async () => {
    const fx = makeFixture({});
    try {
      const outside = path.join(fx.root, 'outside.csv');
      writeFileSync(outside, Buffer.from('outside'));
      const result = await fx.bridge.registerReturnedFiles([
        { name: '外面.csv', path: outside },
        { path: 'relative.csv' },
        'plain-string-entry',
        { name: '只是元数据.csv' },
        { name: '坏类型.csv', path: 123 },
      ]);

      expect(result.entries).toHaveLength(5);
      expect(result.files).toHaveLength(0);
      const [outsideMarked, relativeMarked, plain, meta, badType] = result.entries as Array<Record<string, unknown>>;
      expect(outsideMarked).toEqual({ name: '外面.csv', unavailable: 'path_outside_task_dir' });
      expect(relativeMarked).toEqual({ name: null, unavailable: 'path_not_absolute' });
      // 无字节面/非对象条目是执行层自己的数据：原样透传，宿主不改写。
      expect(plain).toBe('plain-string-entry');
      expect(meta).toEqual({ name: '只是元数据.csv' });
      expect(badType).toEqual({ name: '坏类型.csv', path: 123 });
      // 拒收零副作用：无行登记。
      expect(fx.store.listFileRefs(SCOPE)).toHaveLength(0);
    } finally {
      fx.close();
    }
  });

  it('同 sha256 两次返回（一次 path、一次 base64）→ 复用同一 fileId（ask ⑤ 经桥面）', async () => {
    const fx = makeFixture({});
    try {
      const bytes = Buffer.from('同一份产物');
      const taskDir = fx.taskDir;
      mkdirSync(taskDir, { recursive: true });
      const onDisk = path.join(taskDir, 'product.bin');
      writeFileSync(onDisk, bytes);

      const first = await fx.bridge.registerReturnedFiles([{ name: 'product.bin', path: onDisk }]);
      const second = await fx.bridge.registerReturnedFiles([{ name: 'product-again.bin', content: bytes.toString('base64') }]);
      expect(second.files[0]!.fileId).toBe(first.files[0]!.fileId);
      expect(fx.store.listFileRefs(SCOPE).filter((row) => row.taskId === TASK_A)).toHaveLength(1);
    } finally {
      fx.close();
    }
  });

  it('超份数（count_limit）与超大小（size_limit）→ unavailable 标记；计数只按有字节面的条目', async () => {
    const fx = makeFixture({});
    try {
      mkdirSync(fx.taskDir, { recursive: true });
      const entries = [
        'ignored-string', // 不占份数（无字节面）
        { name: 'a.csv', content: Buffer.alloc(8, 1).toString('base64') },
        { name: 'b.csv', content: Buffer.alloc(8, 2).toString('base64') },
        { name: 'c.csv', content: Buffer.alloc(8, 3).toString('base64') },
        { name: 'd.csv', content: Buffer.alloc(8, 4).toString('base64') }, // 第 4 份 → count_limit
        { name: 'e.csv', content: Buffer.alloc(64, 5).toString('base64') }, // 超过 maxOutputFileBytes=4096？否——8 份内；用于 size 对照另测
      ];
      const result = await fx.bridge.registerReturnedFiles(entries);
      expect(result.files).toHaveLength(3);
      expect(result.entries[4]).toEqual({ name: 'd.csv', unavailable: 'count_limit' });
      // 第 5 份同样被份数上限拒收（超大小对照在独立用例）。
      expect(result.entries[5]).toEqual({ name: 'e.csv', unavailable: 'count_limit' });
    } finally {
      fx.close();
    }
  });

  it('超大小（size_limit）：内联字节超上限 → unavailable，不登记', async () => {
    const fx = makeFixture({});
    try {
      const result = await fx.bridge.registerReturnedFiles([
        { name: 'big.bin', content: Buffer.alloc(8192, 9).toString('base64') },
      ]);
      expect(result.files).toHaveLength(0);
      expect(result.entries[0]).toEqual({ name: 'big.bin', unavailable: 'size_limit' });
      expect(fx.store.listFileRefs(SCOPE)).toHaveLength(0);
    } finally {
      fx.close();
    }
  });
});

describe('兜底：sweepTaskOutputs 扫任务 out/（④，v8 §10-3）', () => {
  it('out/ 里的文件全量登记（task 绑定）；重复扫描复用同一 fileId；out/ 不存在 → 空结果', async () => {
    const fx = makeFixture({});
    try {
      // out/ 不存在：空结果不抛（无执行层写入的任务照常收尾）。
      const empty = fx.bridge.sweepTaskOutputs();
      expect(empty.files).toHaveLength(0);

      mkdirSync(path.join(fx.taskDir, 'out'), { recursive: true });
      writeFileSync(path.join(fx.taskDir, 'out', '漏登记.csv'), Buffer.from('兜底产物'));
      const swept = fx.bridge.sweepTaskOutputs();
      expect(swept.files).toHaveLength(1);
      expect(swept.files[0]!.name).toBe('漏登记.csv');

      const again = fx.bridge.sweepTaskOutputs();
      expect(again.files[0]!.fileId).toBe(swept.files[0]!.fileId);
      expect(fx.store.listFileRefs(SCOPE).filter((row) => row.taskId === TASK_A)).toHaveLength(1);
    } finally {
      fx.close();
    }
  });

  it('回程已登记的 path 产物与兜底扫描同池去重：同字节只落盘一份', async () => {
    const fx = makeFixture({});
    try {
      mkdirSync(path.join(fx.taskDir, 'out'), { recursive: true });
      const product = path.join(fx.taskDir, 'out', 'product.csv');
      writeFileSync(product, Buffer.from('same-product'));
      const backhaul = await fx.bridge.registerReturnedFiles([{ name: 'product.csv', path: product }]);
      const swept = fx.bridge.sweepTaskOutputs();
      expect(swept.files[0]!.fileId).toBe(backhaul.files[0]!.fileId);
      expect(fx.store.listFileRefs(SCOPE)).toHaveLength(1);
    } finally {
      fx.close();
    }
  });
});
