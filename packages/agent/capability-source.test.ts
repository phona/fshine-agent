/**
 * 能力发现接缝（「关进笼子」）的回归测试：一次发现、一份快照、一个接缝。
 *
 * 四条证据（每条都是真实执行，不造假）：
 *   ① 等价性：快照派生表与**冻结的旧 loader 实测输出**逐字段一致（金样由改动前的七个
 *      loader 对仓内 dummy 平台的真实输出生成，见 capability-golden.json 的 provenance）；
 *      label 另做"JSON 的 label = 旧 TSV 第 5 列"的逐 operation 对照（真 spawn 两次）。
 *   ② spawn 计数：CliCapabilitySource 一次 load = 恰好一次发现调用（计数 runner 钉住）；
 *      反向绊线：故意加载两次 → 计数变 2（load 不做内部缓存，boot 期只许调用一次）。
 *   ③ MemoryCapabilitySource 路径（测试 / eval 注入）下核心流程零 spawn：会话创建 +
 *      全部派生表都从记忆快照来，可观测的网关（假可执行文件）一次都没被调用。
 *   ④ grep 绊线：发现子命令字面量在 packages/apps 的生产代码里只出现在接缝模块
 *      （测试 / 夹具 / 文档注释除外）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import {
  argSpecsOf,
  argStylesOf,
  capabilityManifestOf,
  CliCapabilitySource,
  labelsOf,
  MemoryCapabilitySource,
  operationProtocolsOf,
  operationSemanticsOf,
  proposalSchemaOf,
  protocolManifestOf,
  type CapabilityCliCall,
} from './src/capability-source';
import { parseOperationLabels, serveModesOf } from './src/operation-labels';
import { createPiCodingWorkerSession } from './src/pi-coding-driver';
import golden from './capability-golden.json';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DUMMY_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const DUMMY_GATEWAY = 'bin/dummy';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fakeModelRuntime(): Promise<{ runtime: ModelRuntime; model: Model<any> }> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('test', {
    name: 'Test',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    models: [{
      id: 'worker-test',
      name: 'worker-test',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    }],
  });
  const model = runtime.getModel('test', 'worker-test');
  if (!model) throw new Error('test model was not registered');
  return { runtime, model };
}

/** 真 spawn 一次 dummy 网关（旧 TSV 载体），返回 stdout。 */
function runDummyTsv(): string {
  const result = spawnSync(path.join(DUMMY_ROOT, 'bin', 'dummy'), ['operation', 'list'], {
    cwd: DUMMY_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`dummy TSV 调用失败（exit ${result.status}）：${result.stderr}`);
  return result.stdout;
}

/** 规格表条目 → 可比较的纯数据形态（与金样同形）。 */
function specPairs(manifest: Parameters<typeof argSpecsOf>[0]): Array<[string, { positionalNames: readonly string[]; flagStyles: Array<[string, string]> }]> {
  return [...argSpecsOf(manifest).entries()].map(([key, spec]) => [
    key,
    { positionalNames: [...spec.positionalNames], flagStyles: [...spec.flagStyles.entries()] as Array<[string, string]> },
  ]);
}

describe('发现接缝 · 等价性（快照派生表 vs 冻结的旧 loader 实测输出）', () => {
  it('七张表 + 协议清单 + 提案 schema 与金样逐字段一致（仓内 dummy 真 CLI）', async () => {
    const snapshot = await new CliCapabilitySource({ platformRoot: DUMMY_ROOT, gateway: DUMMY_GATEWAY }).load();
    // 真发现：不是降级快照（金样是旧代码对同一 CLI 的真实输出）。
    expect(snapshot.discovered).toBe(true);
    const protocolManifest = protocolManifestOf(snapshot);

    expect([...labelsOf(snapshot).entries()]).toEqual(golden.labels);
    expect([...argStylesOf(snapshot).entries()]).toEqual(golden.argStyles);
    expect(specPairs(snapshot)).toEqual(golden.argSpecs);
    expect([...operationSemanticsOf(snapshot).entries()]).toEqual(golden.semantics);
    expect([...operationProtocolsOf(snapshot).entries()]).toEqual(golden.protocols);
    expect(proposalSchemaOf(snapshot)).toEqual(golden.proposalSchema);
    expect(protocolManifest).toEqual(golden.capabilityManifest);
    expect([...serveModesOf(protocolManifest)]).toEqual(golden.serveModes);
  });

  it('label：JSON 的 label 与旧 TSV 第 5 列逐 operation 对照（同一 CLI 的两个数据面）', async () => {
    const tsv = runDummyTsv();
    const snapshot = await new CliCapabilitySource({ platformRoot: DUMMY_ROOT, gateway: DUMMY_GATEWAY }).load();
    const tsvLabelByOperation = new Map<string, string>();
    for (const line of tsv.split('\n')) {
      const columns = line.split('\t');
      if (columns.length >= 5 && columns[0]) tsvLabelByOperation.set(columns[0], columns[4] ?? '');
    }
    // 逐 operation：新载体的 label 与旧载体第 5 列同值（空列 ↔ null 等价）。
    expect(snapshot.operations.length).toBeGreaterThan(0);
    for (const operation of snapshot.operations) {
      expect(operation.name, '金样锁定的是命名 operation，不出现无名行').not.toBeNull();
      expect(operation.label ?? '').toBe(tsvLabelByOperation.get(operation.name!) ?? '');
    }
    // 表级：JSON 快照派生表 = TSV 解析表（旧解析器仍在本仓，作为对照尺）。
    expect(labelsOf(snapshot)).toEqual(parseOperationLabels(tsv));
  });
});

describe('发现接缝 · spawn 计数（计数 runner 钉住）', () => {
  it('一次 load = 恰好一次发现调用；参数 / cwd / env 与旧 loader 同尺', async () => {
    const calls: CapabilityCliCall[] = [];
    const before = process.env['LLM_API_KEY'];
    process.env['LLM_API_KEY'] = 'sentinel-discovery-key-DO-NOT-LEAK';
    try {
      const source = new CliCapabilitySource({
        platformRoot: DUMMY_ROOT,
        gateway: DUMMY_GATEWAY,
        runner: async (call) => {
          calls.push(call);
          return { code: 0, stdout: JSON.stringify({ operations: [{ name: 'dummy.query', command: 'query', label: 'query records' }] }) };
        },
      });
      const snapshot = await source.load();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(['operation', 'list', '--json']);
      expect(calls[0]!.cwd).toBe(DUMMY_ROOT);
      // 宿主机密族不进执行层子进程 env（收口函数在接缝一处）。
      expect(calls[0]!.env['LLM_API_KEY']).toBeUndefined();
      expect(snapshot.discovered).toBe(true);
      expect(labelsOf(snapshot).get('dummy.query')).toBe('query records');
    } finally {
      if (before === undefined) delete process.env['LLM_API_KEY'];
      else process.env['LLM_API_KEY'] = before;
    }
  });

  it('反向绊线：故意加载两次 → 计数变 2（load 无内部缓存；boot 期只许调用一次）', async () => {
    let calls = 0;
    const source = new CliCapabilitySource({
      platformRoot: DUMMY_ROOT,
      gateway: DUMMY_GATEWAY,
      runner: async () => {
        calls += 1;
        return { code: 0, stdout: JSON.stringify({ operations: [] }) };
      },
    });
    await source.load();
    expect(calls).toBe(1);
    await source.load();
    expect(calls).toBe(2);
  });

  it('同一 flag 跨行样式冲突时先登记者生效（金样里无冲突，规则由本用例单独钉住）', () => {
    const manifest = capabilityManifestOf([
      { name: 'a.one', command: 'one', args: { flags: [{ flag: '--target', style: 'name' }, { flag: '--only', style: 'name' }] } },
      { name: 'b.two', command: 'two', args: { flags: [{ flag: '--target', style: 'code' }] } },
    ]);
    expect([...argStylesOf(manifest).entries()]).toEqual([['--target', 'name'], ['--only', 'name']]);
    expect([...argSpecsOf(manifest).entries()].map(([key]) => key)).toEqual(['a.one', 'one', 'b.two', 'two']);
    // 键序沿用旧解析：注册名在前、command 裸名在后（查表面顺序稳定，不靠隐式覆盖规则）。
    expect([...labelsOf(capabilityManifestOf([
      { name: 'a.one', command: 'one', label: '一号' },
      { name: 'b.two', command: 'two', label: '二号' },
    ])).keys()]).toEqual(['one', 'a.one', 'two', 'b.two']);
  });

  it('失败语义与旧 loader 一致：未配根 / 未声明网关 / 非零退出 / 非 JSON 一律降级，不 reject', async () => {
    const cases = await Promise.all([
      new CliCapabilitySource({}).load(),
      new CliCapabilitySource({ platformRoot: DUMMY_ROOT }).load(),
      new CliCapabilitySource({
        platformRoot: DUMMY_ROOT,
        gateway: DUMMY_GATEWAY,
        runner: async () => ({ code: 3, stdout: 'boom' }),
      }).load(),
      new CliCapabilitySource({
        platformRoot: DUMMY_ROOT,
        gateway: DUMMY_GATEWAY,
        runner: async () => ({ code: 0, stdout: 'not json' }),
      }).load(),
    ]);
    for (const snapshot of cases) {
      expect(snapshot.discovered).toBe(false);
      expect(snapshot.operations).toHaveLength(0);
      expect(labelsOf(snapshot).size).toBe(0);
      expect(proposalSchemaOf(snapshot)).toBeNull();
      expect(protocolManifestOf(snapshot).operations).toHaveLength(0);
    }
  });
});

describe('发现接缝 · MemoryCapabilitySource 路径零 spawn', () => {
  it('未注入派生表的会话：经发现源自派生恰好一次，可观测网关零调用', async () => {
    const root = tmpRoot('cap-source-memory-');
    const logPath = path.join(root, 'gateway.log');
    mkdirSync(path.join(root, 'bin'), { recursive: true });
    // 可观测网关：被 spawn 就会留一行。memory 路径下一次都不该出现。
    writeFileSync(path.join(root, 'bin', 'observable-gateway'), [
      '#!/bin/sh',
      `echo "$@" >> "${logPath}"`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    const modelConfig = await fakeModelRuntime();
    const memory = new MemoryCapabilitySource(capabilityManifestOf([
      {
        name: 'dummy.query', command: 'query', access: 'read', label: 'query records', serve: ['query'],
        args: { flags: [{ flag: '--collection', style: 'name' }] },
      },
    ], { read: { plan: true, confirm: false } }));
    let loads = 0;
    const counting: {
      load(): Promise<Awaited<ReturnType<MemoryCapabilitySource['load']>>>;
    } = {
      load: async () => {
        loads += 1;
        return memory.load();
      },
    };

    const worker = await createPiCodingWorkerSession({
      cwd: root,
      agentDir: path.join(root, '.fshine-agent'),
      gateway: 'bin/observable-gateway',
      skillRoots: [],
      systemPrompt: 'memory capability source',
      modelConfig,
      capabilitySource: counting,
    });

    // 自派生恰好一次（单一快照：六张表 + 协议清单全部由它派生）。
    expect(loads).toBe(1);
    // 零 spawn：可观测网关一次都没被调用。
    expect(existsSync(logPath)).toBe(false);
    worker.session.dispose();
  });
});

// ── grep 绊线：发现子命令字面量只在接缝模块（生产代码）──────────────────────────

/**
 * 用 TypeScript 解析器取**代码里的字符串字面量**（注释 / 正则天然不算）：
 *   · 含 "operation list" 的字符串/无插值模板（消息与识别文本不得各自写字面量）；
 *   · 相邻 argv 对（'operation','list'）的数组字面量。
 * 命中即"发现子命令字面量逃出接缝"，唯一豁免 = capability-source.ts（该子命令的
 * 唯一定义处；serve-gate 的元数据识别与错误码/提示文本都引用它的常量）。
 */
function discoveryLiteralFiles(file: string): boolean {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let hit = false;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes('operation list')) {
      hit = true;
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const texts = node.elements.map((element) => (ts.isStringLiteral(element) ? element.text : null));
      for (let index = 0; index < texts.length - 1; index += 1) {
        if (texts[index] === 'operation' && texts[index + 1] === 'list') { hit = true; return; }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hit;
}

function* walkProductionSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'data') continue;
      yield* walkProductionSources(full);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    yield full;
  }
}

describe('发现接缝 · grep 绊线：发现子命令字面量只在接缝模块', () => {
  it('packages/apps 生产代码（.ts，非测试）里只有 capability-source.ts 持有该字面量', () => {
    const offenders: string[] = [];
    for (const dir of [path.join(REPO_ROOT, 'packages'), path.join(REPO_ROOT, 'apps')]) {
      for (const file of walkProductionSources(dir)) {
        if (discoveryLiteralFiles(file)) offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders.sort()).toEqual(['packages/agent/src/capability-source.ts']);
  });
});
