/**
 * 平台定位与 mock 配置（按 tests/e2e/harness.ts 的现有约定，不另发明）：
 *
 * - 网关位置 = 配置 `contextProfiles.<active>.root` + `profile.gateway`
 *   （harness 的 gatewayExecPath 同一口径；本文件不 import fshine 代码，只复用约定）。
 * - 隔离运行 = harness 的 patchProfile root 同款：把平台仓 `git archive HEAD` 成一个
 *   快照目录，网关与 cwd 都落在快照上，真仓一行不动。
 * - mock 执行 = 平台 2026-11 起 EXECUTION_EXECUTOR 只读仓库根的 execution.config.json
 *   （`src/lib/local-config.js` 的优先级契约：overrides > execution.config.json > 代码默认；
 *   env 不再是配置通道）。所以这里写快照的 execution.config.json，而不是只设 env；
 *   同时仍把 EXECUTION_EXECUTOR=mock 放进子进程 env，保持与题面环境的字面一致。
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface PlatformProfile {
  profileId: string;
  root: string;
  gateway: string;
}

export interface PlatformHandle {
  /** 平台根（快照或真实 checkout），网关 cwd 与命令里的相对路径都以它为基。 */
  root: string;
  /** 相对网关调用形式，例如 bin/17dz。 */
  gateway: string;
  /** 网关绝对路径。 */
  cli: string;
  /** 本次运行独占的状态目录（计划账本 / mock 状态 / 审计等）。 */
  stateDir: string;
  /** 子进程基础 env：已剔除 LLM_* 等宿主秘密，带计划门开关与 mock 标记。 */
  baseEnv: NodeJS.ProcessEnv;
  profile: PlatformProfile;
  /** 删掉本 run 创建的快照（真实 checkout 不删）。 */
  dispose(): void;
}

interface ConfigDoc {
  contextProfiles?: Record<string, { root?: string; gateway?: string }>;
  activeProfile?: string;
}

function explicitConfigPath(argv: string[]): string | undefined {
  const flag = argv.find((arg) => arg.startsWith('--config='));
  if (flag) {
    const value = flag.slice('--config='.length).trim();
    if (value) return value;
  }
  const fromEnv = (process.env['AGENT_CONFIG_PATH'] ?? '').trim();
  return fromEnv || undefined;
}

/** harness 同款：显式入口 > config/agent.yaml > scripts/eval/eval.agent.yaml。 */
function resolveConfigPath(argv: string[]): string {
  const explicit = explicitConfigPath(argv);
  if (explicit) return path.resolve(explicit);
  const rootConfig = path.join(REPO_ROOT, 'config', 'agent.yaml');
  if (existsSync(rootConfig)) return rootConfig;
  const evalConfig = path.join(REPO_ROOT, 'scripts', 'eval', 'eval.agent.yaml');
  if (existsSync(evalConfig)) return evalConfig;
  throw new Error('找不到平台配置：需要 config/agent.yaml 或 AGENT_CONFIG_PATH 指向声明 contextProfiles 的 YAML');
}

export function resolveProfile(argv: string[] = process.argv): PlatformProfile {
  const configPath = resolveConfigPath(argv);
  const doc = parseYaml(readFileSync(configPath, 'utf8')) as ConfigDoc;
  const profiles = doc.contextProfiles ?? {};
  const ids = Object.keys(profiles);
  const profileId = (doc.activeProfile ?? '').trim() || (ids.length === 1 ? ids[0] : undefined);
  if (!profileId || !profiles[profileId]) {
    throw new Error(`配置 ${configPath} 里没有唯一可用的 contextProfiles 条目（需要单 profile 或 activeProfile）`);
  }
  const profile = profiles[profileId]!;
  if (typeof profile.gateway !== 'string' || !profile.gateway.trim()) {
    throw new Error(`contextProfiles.${profileId}.gateway 未声明`);
  }
  if (typeof profile.root !== 'string' || !profile.root.trim()) {
    throw new Error(`contextProfiles.${profileId}.root 未声明`);
  }
  return {
    profileId,
    root: path.resolve(REPO_ROOT, profile.root),
    gateway: profile.gateway,
  };
}

function sanitizedBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // 模型凭据不进工具/网关子进程：它只属于宿主进程的模型客户端。
    if (key.startsWith('LLM_')) continue;
    env[key] = value;
  }
  return env;
}

function snapshotPlatform(sourceRoot: string, workdir: string): string {
  const snap = mkdtempSync(path.join(workdir, 'platform-'));
  const tarPath = path.join(workdir, `platform-${path.basename(snap)}.tar`);
  const archive = spawnSync('git', ['-C', sourceRoot, 'archive', '--format=tar', '-o', tarPath, 'HEAD'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (archive.status !== 0) {
    throw new Error(`git archive 平台快照失败：${(archive.stderr || archive.error?.message || '').trim()}`);
  }
  const extract = spawnSync('tar', ['-xf', tarPath, '-C', snap], { encoding: 'utf8', timeout: 60_000 });
  if (extract.status !== 0) {
    throw new Error(`解包平台快照失败：${(extract.stderr || extract.error?.message || '').trim()}`);
  }
  rmSync(tarPath, { force: true });
  const modules = path.join(sourceRoot, 'node_modules');
  if (existsSync(modules)) {
    symlinkSync(modules, path.join(snap, 'node_modules'), 'dir');
  }
  return snap;
}

function writeMockExecutionConfig(root: string, stateDir: string): void {
  const config = {
    EXECUTION_EXECUTOR: 'mock',
    EXECUTION_MOCK_STATE: path.join(stateDir, 'mock.json'),
    EXECUTION_PLAN_STATE: path.join(stateDir, 'plans.json'),
    EXECUTION_RATE_LIMIT_STATE: path.join(stateDir, 'rate-limit.json'),
    EXECUTION_AUDIT_PATH: path.join(stateDir, 'audit.jsonl'),
    EXECUTION_PROPOSAL_STATE: path.join(stateDir, 'proposals.json'),
    EXECUTION_MEMORY_STATE: path.join(stateDir, 'memory.json'),
    EXECUTION_BREAKER_STATE: path.join(stateDir, 'breaker.json'),
    EXECUTION_RATE_LIMIT: 'off',
    RUNTIME_DIR: path.join(stateDir, 'runtime'),
    EXECUTION_CACHE_DIR: path.join(stateDir, 'cache'),
    EXECUTION_EXPORTS_DIR: path.join(stateDir, 'imports'),
  };
  writeFileSync(path.join(root, 'execution.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function assertMockConfig(root: string): void {
  const configPath = path.join(root, 'execution.config.json');
  if (!existsSync(configPath)) {
    throw new Error(`平台根 ${root} 没有 execution.config.json：拒绝在非 mock 配置上跑（设 PURE_PI_PLATFORM_SRC 让 harness 建快照并写 mock 配置）`);
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`平台 execution.config.json 解析失败：${(error as Error).message}`);
  }
  if (doc['EXECUTION_EXECUTOR'] !== 'mock') {
    throw new Error(`平台 execution.config.json 的 EXECUTION_EXECUTOR=${String(doc['EXECUTION_EXECUTOR'])}，本 spike 只跑 mock`);
  }
}

/**
 * 平台 2026-11 契约：EXECUTION_EXECUTOR 只认 execution.config.json。
 * 这里显式读出来给报告用，避免"设了 env 就以为 mock 生效"的假绿。
 */
export function readExecutorMode(root: string): string | null {
  try {
    const doc = JSON.parse(readFileSync(path.join(root, 'execution.config.json'), 'utf8')) as Record<string, unknown>;
    return typeof doc['EXECUTION_EXECUTOR'] === 'string' ? doc['EXECUTION_EXECUTOR'] : null;
  } catch {
    return null;
  }
}

export interface PrepareOptions {
  workdir: string;
  /** 平台源 checkout；给了就 git archive 成快照（真仓零改动）。 */
  platformSrc?: string;
  argv?: string[];
}

export function preparePlatform(options: PrepareOptions): PlatformHandle {
  const profile = resolveProfile(options.argv ?? process.argv);
  const stateDir = mkdtempSync(path.join(options.workdir, 'state-'));
  mkdirSync(stateDir, { recursive: true });
  let root = profile.root;
  let owned = false;
  if (options.platformSrc) {
    root = snapshotPlatform(options.platformSrc, options.workdir);
    owned = true;
    writeMockExecutionConfig(root, stateDir);
  } else {
    assertMockConfig(root);
  }
  const cli = path.join(root, ...profile.gateway.split('/'));
  if (!existsSync(cli)) {
    throw new Error(`网关不存在：${cli}（profile.root + profile.gateway 派生；快照里没有 bin/17dz？）`);
  }
  const baseEnv: NodeJS.ProcessEnv = {
    ...sanitizedBaseEnv(),
    EXECUTION_EXECUTOR: 'mock',
    EXECUTION_REQUIRE_PLAN: '1',
    EXECUTION_MOCK_STATE: path.join(stateDir, 'mock.json'),
  };
  const handle: PlatformHandle = {
    root,
    gateway: profile.gateway,
    cli,
    stateDir,
    baseEnv,
    profile,
    dispose: () => {
      if (owned) rmSync(root, { recursive: true, force: true });
    },
  };
  return handle;
}

export interface GatewayResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 宿主侧网关调用（只用于健康检查/计划激活这类平台协议动作，不用于模型取数）。 */
export function runGateway(
  platform: PlatformHandle,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): GatewayResult {
  const child = spawnSync(platform.cli, args, {
    cwd: platform.root,
    input: options.input,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...platform.baseEnv, ...options.env },
  });
  if (child.error) throw child.error;
  return { code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

export function checkGateway(platform: PlatformHandle): { operations: number } {
  const listed = runGateway(platform, ['operation', 'list', '--json']);
  if (listed.code !== 0) {
    throw new Error(`operation list 失败（exit ${listed.code}）：${listed.stderr.trim() || listed.stdout.trim()}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(listed.stdout);
  } catch {
    throw new Error(`operation list 输出不是 JSON：${listed.stdout.slice(0, 200)}`);
  }
  const ops = Array.isArray(doc) ? doc : (doc as { operations?: unknown[] }).operations;
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('operation list 为空');
  return { operations: ops.length };
}

/**
 * 计划激活令牌与平台 `plan.activate` 的 HMAC 形状（平台 src/execution/plan.js:571-594）。
 * 这是宿主职责：secret 只在这次 spawn 的 env 里，不进模型的 shell 环境。
 */
export function activatePlan(
  platform: PlatformHandle,
  planId: string,
  evidence: 'notification-delivered' | 'user-confirmed',
  secret: string,
): { planId: string; version?: number; status?: string } {
  const expires = Date.now() + 60_000;
  const body = Buffer.from(JSON.stringify({ planId, evidence, expires }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
  const token = `${body}.${signature}`;
  const result = runGateway(platform, ['plan', 'activate', '--stdin'], {
    input: JSON.stringify({ planId, evidence, token }),
    env: { EXECUTION_PLAN_ACTIVATION_SECRET: secret },
  });
  if (result.code !== 0) {
    throw new Error(`plan activate 失败（exit ${result.code}）：${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout) as { planId: string; version?: number; status?: string };
}
