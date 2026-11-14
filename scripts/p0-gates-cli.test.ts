/**
 * P0-T01 五门话术字节金样（CLI 级：`scripts/ask.ts` 与 `scripts/tasks.ts --redo` 两入口）。
 *
 * 钉住的契约（P0「装配同源」的零行为变化面）：
 *   · 五个装配前置门 → exit 2，stderr 与金样**逐字节**一致（含结尾换行），stdout 为空；
 *   · ask 侧话术 purpose='ask'、redo 侧 purpose='重新推进'（同一装配模板，两入口各自置词）；
 *   · 子进程用入口脚本本身（与 npm 脚本同一文件），但显式控制 env 且不加载 .env——
 *     `node --env-file-if-exists=.env` 在缺 .env 时会向 stderr 打一行固定噪声，
 *     会破坏字节金样；env 的显式空值本身已压过 .env（Node 规则：既有 env 优先）。
 *   · 门 4（无 enabled principal）在 redo 入口**结构性绕过**：redo 身份取存储事实
 *     （`task.principalId` 显式传入，不再回落配置的第一个 enabled principal，见
 *     scripts/ask-runtime.ts:101-105）。本文件用「配置无 enabled principal + 空只读集合夹具」
 *     证明 redo 不误报门 4、继续走到门 5（同一话术字节）；门 4 的字节金样由 ask 入口钉住。
 *     该行为是 P3 既有语义，P0 只钉不改。
 *
 * 现状（实现前）除 redo 门 4 绕过说明外应全绿 = 回归钉；破坏任一字节即红。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PARENT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures');
const TASK_ID = 'task_p0_gate';

const dirs: string[] = [];
function tempDir(prefix = 'p0-gates-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 宿主侧泄漏键：逐键剔除，子进程基线只留进程基础环境（与 vitest.setup 同口径 + 本用例追加）。 */
const HOST_LEAK_KEYS = [
  'LLM_API_KEY', 'LLM_API_BASE_URL', 'LLM_MODEL', 'LLM_MAIN_MODEL',
  'LLM_THINKING_LEVEL', 'LLM_MAIN_THINKING_LEVEL', 'LLM_CONTEXT_WINDOW',
  'AGENT_CONFIG_PATH', 'DB_PATH', 'INIT_CWD',
  'FSHINE_WORKER_DISPATCH_MODE', 'FSHINE_PLATFORM_QUEUE_CAPACITY',
];

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of HOST_LEAK_KEYS) delete env[key];
  env['TMPDIR'] ??= os.tmpdir();
  return env;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runEntry(entry: 'ask' | 'tasks', args: readonly string[], env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', `scripts/${entry}.ts`, ...args],
    { cwd: REPO_ROOT, env, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** 门拒绝断言：exit 2 + stdout 空 + stderr 逐字节等于金样 + 换行。 */
function expectRefusal(result: CliResult, golden: string): void {
  expect(result.status, `stderr=${result.stderr}`).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`${golden}\n`);
}

function writeConfig(dir: string, name: string, lines: readonly string[]): string {
  const file = path.join(dir, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** 终态任务（底账为真 SQLite），供 redo 入口进入装配链。 */
function seedTerminalTask(dbPath: string): void {
  const registry = createSqliteTaskRegistry(dbPath);
  try {
    registry.begin({
      taskId: TASK_ID,
      principalId: 'wecom:fixture-user',
      sessionId: 'p0-gates-session',
      request: '帮我查一下 beta 集合、窗口 W1 的数据',
    });
    registry.complete(TASK_ID, '已完成。');
  } finally {
    registry.close();
  }
}

function redoEnv(dbPath: string, key?: string): NodeJS.ProcessEnv {
  const env = baseEnv();
  env['DB_PATH'] = dbPath;
  if (key === undefined) delete env['LLM_API_KEY'];
  else env['LLM_API_KEY'] = key;
  return env;
}

const GOLDEN = {
  missingKeyAsk: '未检测到 LLM_API_KEY——ask 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。',
  missingKeyRedo: '未检测到 LLM_API_KEY——重新推进 需要真实模型（密钥只在 .env，或配置 llm.apiKey）。',
  multiProfileAsk: 'ask 需要单一 contextProfile（当前 2 个）——最小切片不做多 profile 选择。',
  multiProfileRedo: '重新推进 需要单一 contextProfile（当前 2 个）——最小切片不做多 profile 选择。',
  missingGateway: 'profile 缺少 gateway——最小切片需要执行层挂载声明。',
  noPrincipal: '配置里没有 enabled principal——最小切片需要可信身份来源（fail-closed，不回落写死值）。',
  emptyOps: '执行层没有声明任何只读 operation——最小切片拒绝以空允许集合运行。',
} as const;

/** 两 profile 配置（门 2：多 profile）。root 不会被触达，仅需 loadConfig 可加载。 */
function multiProfileConfig(dir: string): string {
  return writeConfig(dir, 'two-profiles.yaml', [
    'principals: {}',
    'contextProfiles:',
    '  a:',
    '    root: /tmp/p0-a',
    '    gateway: bin/dummy',
    '    skillRoots: [".agents/skills-serve"]',
    '  b:',
    '    root: /tmp/p0-b',
    '    gateway: bin/dummy',
    '    skillRoots: [".agents/skills-serve"]',
  ]);
}

/** 缺 gateway 配置（门 3）。 */
function noGatewayConfig(dir: string): string {
  return writeConfig(dir, 'no-gateway.yaml', [
    'principals: {}',
    'contextProfiles:',
    '  a:',
    '    root: /tmp/p0-a',
    '    skillRoots: [".agents/skills-serve"]',
  ]);
}

/** 无 enabled principal 配置（门 4）。 */
function noPrincipalConfig(dir: string): string {
  return writeConfig(dir, 'no-principal.yaml', [
    'principals: {}',
    'contextProfiles:',
    '  a:',
    '    root: /tmp/p0-a',
    '    gateway: bin/dummy',
    '    skillRoots: [".agents/skills-serve"]',
  ]);
}

/**
 * 空只读集合夹具（门 5）：root 必须在仓内夹具目录之下（隔离门 fail-closed），
 * 网关只声明一个 write operation → 只读允许集合为空。
 * principal 段可关掉（门 4 的 redo 绕过用例复用本夹具且不配 principal）。
 */
function emptyOpsFixtureConfig(dir: string, options: { principal: boolean }): string {
  const fixtureRoot = mkdtempSync(path.join(FIXTURE_PARENT, 'p0-gates-'));
  dirs.push(fixtureRoot);
  mkdirSync(path.join(fixtureRoot, 'bin'), { recursive: true });
  const gateway = path.join(fixtureRoot, 'bin', 'gateway');
  writeFileSync(gateway, [
    '#!/usr/bin/env node',
    'process.stdout.write(JSON.stringify({ operations: [{ name: "write-only", access: "write" }] }) + "\\n");',
    '',
  ].join('\n'));
  chmodSync(gateway, 0o755);
  return writeConfig(dir, options.principal ? 'empty-ops.yaml' : 'empty-ops-no-principal.yaml', [
    ...(options.principal ? ['principals:', '  "test:user":', '    enabled: true'] : ['principals: {}']),
    'contextProfiles:',
    '  t:',
    `    root: ${fixtureRoot}`,
    '    gateway: bin/gateway',
    '    skillRoots: [".agents/skills-serve"]',
  ]);
}

describe('P0-T01 五门话术字节金样（ask 与 tasks --redo 两入口）', () => {
  it('门 1 缺 LLM_API_KEY：ask / redo 各自 purpose 逐字节', () => {
    const ask = runEntry('ask', ['你好'], baseEnv());
    expectRefusal(ask, GOLDEN.missingKeyAsk);

    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath);
    const redo = runEntry('tasks', [TASK_ID, '--redo'], redoEnv(dbPath));
    expectRefusal(redo, GOLDEN.missingKeyRedo);
  });

  it('门 2 多 profile：ask / redo 各自 purpose 逐字节', () => {
    const dir = tempDir();
    const config = multiProfileConfig(dir);
    const askEnv = baseEnv();
    askEnv['LLM_API_KEY'] = 'test-key';
    const ask = runEntry('ask', ['你好', `--config=${config}`], askEnv);
    expectRefusal(ask, GOLDEN.multiProfileAsk);

    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath);
    const redo = runEntry('tasks', [TASK_ID, '--redo', `--config=${config}`], redoEnv(dbPath, 'test-key'));
    expectRefusal(redo, GOLDEN.multiProfileRedo);
  });

  it('门 3 缺 gateway：ask / redo 同一话术逐字节', () => {
    const dir = tempDir();
    const config = noGatewayConfig(dir);
    const askEnv = baseEnv();
    askEnv['LLM_API_KEY'] = 'test-key';
    const ask = runEntry('ask', ['你好', `--config=${config}`], askEnv);
    expectRefusal(ask, GOLDEN.missingGateway);

    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath);
    const redo = runEntry('tasks', [TASK_ID, '--redo', `--config=${config}`], redoEnv(dbPath, 'test-key'));
    expectRefusal(redo, GOLDEN.missingGateway);
  });

  it('门 4 无 enabled principal：ask 逐字节；redo 身份取存储事实（结构性绕过门 4，不误报）', () => {
    const dir = tempDir();
    const config = noPrincipalConfig(dir);
    const askEnv = baseEnv();
    askEnv['LLM_API_KEY'] = 'test-key';
    const ask = runEntry('ask', ['你好', `--config=${config}`], askEnv);
    expectRefusal(ask, GOLDEN.noPrincipal);

    // redo：任务存储的 principal 是可信事实（P3 语义）。配置无 enabled principal 时
    // 不再回落配置，门 4 不触发——继续走到门 5（空只读集合），话术逐字节。
    const bypassDir = tempDir();
    const bypassDb = path.join(bypassDir, 'state.db');
    seedTerminalTask(bypassDb);
    const bypassConfig = emptyOpsFixtureConfig(bypassDir, { principal: false });
    const redo = runEntry('tasks', [TASK_ID, '--redo', `--config=${bypassConfig}`], redoEnv(bypassDb, 'test-key'));
    expectRefusal(redo, GOLDEN.emptyOps);
  });

  it('门 5 执行层零只读 operation：ask / redo 同一话术逐字节', () => {
    const dir = tempDir();
    const config = emptyOpsFixtureConfig(dir, { principal: true });
    const askEnv = baseEnv();
    askEnv['LLM_API_KEY'] = 'test-key';
    const ask = runEntry('ask', ['你好', `--config=${config}`], askEnv);
    expectRefusal(ask, GOLDEN.emptyOps);

    const dbPath = path.join(dir, 'state.db');
    seedTerminalTask(dbPath);
    const redo = runEntry('tasks', [TASK_ID, '--redo', `--config=${config}`], redoEnv(dbPath, 'test-key'));
    expectRefusal(redo, GOLDEN.emptyOps);
  });
});
