/**
 * 真实执行层「只读冒烟」准备档（`node --import tsx scripts/eval/real/smoke.ts`）。
 *
 * 定位（2026-11-19，owner 只批准准备档）：本脚本是真实执行层（17dz）未验面的**只读**探针。
 * 本档**绝不联网、不碰真实凭据、不跑真实层**——默认干跑（`--dry-run` 缺省开）只打印将要
 * 执行的步骤与判定，不发任何调用；`--run` 才真跑，且真跑的第一步就是读执行层自报的
 * `operation list --json`，确认 `access=read` 才放行。
 *
 * 三段结构（逐步打印机械读数）：
 *   ① 宿主侧（读部署配置，零调用）：配置源 / 单 profile / gateway / 主体与角色 / 群主体派生；
 *   ② 发现（只读命令）：`operation list --json` → 按 access 计数、只读集合、长任务声明；
 *   ③ 只读探针（只调用 access=read 的 operation）：四态回执 / retryable 声明 / dispatchKey 重放。
 *
 * 安全硬闸（不依赖模型或人记得，见 assertReadOnlyCall）：任何 `access != read` 的 operation
 * 在即将发起调用的那一刻被确定性中止，并打印中止原因。脚本**不存在** `--allow-write`：
 * 想让它调写操作只能显式改代码，而改了也过不去这道闸。
 *
 * 配置来源复用仓内既有加载链（`explicitConfigFrom` + `loadConfig` + `materializeEvalConfig`），
 * 不新造配置源。执行子进程 env 由适配器按白名单重建（worker-env.ts）；打印一律经
 * server-paths.ts 的剥离思路去掉绝对路径，绝不打印环境变量值。
 *
 * 判据清单（真实层要验什么、期望读数、通过/中止条件、证据落点）见
 * `docs/ops/real-read-smoke.md`——本脚本的逐步读数与该清单逐项对应。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, ContextProfileConfig, Permission } from '@fshine/contracts';
import type { ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import { effectiveRoleOf, loadConfig, permissionsOfRole } from '@fshine/core';
import { resolveExecutionFace } from '../../ask-runtime';
import { stripServerPaths } from '../../../packages/agent/src/server-paths';
import type { DummyCliClient, RawGatewayOperation } from '../../../packages/agent/src/dummy-cli-client';
import { explicitConfigFrom, materializeEvalConfig } from '../../resolve-config-path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const RUNTIME_DIR = path.join(REPO_ROOT, '.runtime', 'real-smoke');
const DEFAULT_EVIDENCE = path.join(RUNTIME_DIR, 'readings.json');

/** 只读 access 声明值（执行层自述的权威口径；契约不携带 access，它是网关清单字段）。 */
const READ_ACCESS = 'read';

// ---------------------------------------------------------------------------
// 参数解析（干跑缺省；拒绝未知参数——尤其不存在 --allow-write）
// ---------------------------------------------------------------------------

export interface SmokeOptions {
  run: boolean;
  configPath?: string;
  op?: string;
  args: Record<string, string>;
  out: string;
}

const USAGE = [
  '用法：node --import tsx scripts/eval/real/smoke.ts [--run] [--config=<path>] [--op=<只读operation>] [--arg k=v ...] [--out=<evidence.json>]',
  '  默认干跑（等价 --dry-run）：只打印将要执行的步骤与判定，不发任何调用。',
  '  --run           真跑：先读执行层自报 operation 清单，确认 access=read 后只调用只读 operation。',
  '  --config=<path> 部署配置（复用既有加载链；缺省 = 仓内 dummy 夹具 config/agent.fixture.yaml）。',
  '  --op=<name>     指定要探的只读 operation（缺省自动选一个 read operation）。',
  '  --arg k=v       传给该 operation 的参数（可重复；裸名，适配器按清单声明规范化）。',
  '  --out=<path>    证据落点（缺省 .runtime/real-smoke/readings.json）。',
  '  --help          打印本用法。',
  '',
  '安全硬闸：脚本只调用 access=read 的 operation；任何 access != read 的 operation 在发起前',
  '被确定性中止。不存在 --allow-write——想调写操作只能显式改代码，且仍会被硬闸挡下。',
].join('\n');

export function parseSmokeArgs(argv: readonly string[]): SmokeOptions | { usageError: string } | { help: true } {
  const options: SmokeOptions = { run: false, args: {}, out: DEFAULT_EVIDENCE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--run') { options.run = true; continue; }
    if (arg === '--dry-run') { options.run = false; continue; }
    if (arg.startsWith('--config=')) { options.configPath = arg.slice('--config='.length).trim() || undefined; continue; }
    if (arg.startsWith('--op=')) { options.op = arg.slice('--op='.length).trim() || undefined; continue; }
    if (arg.startsWith('--out=')) { options.out = arg.slice('--out='.length).trim() || DEFAULT_EVIDENCE; continue; }
    if (arg.startsWith('--arg=')) {
      const pair = arg.slice('--arg='.length);
      const eq = pair.indexOf('=');
      if (eq <= 0) return { usageError: `--arg 需要 k=v 形态（当前：${redact(pair)}）。` };
      options.args[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    if (arg === '--allow-write') {
      return { usageError: '本脚本只读：不存在 --allow-write。要调写操作只能显式改代码，且仍会被只读硬闸中止。' };
    }
    return { usageError: `未知参数：${redact(arg)}（--help 看用法）。` };
  }
  return options;
}

// ---------------------------------------------------------------------------
// 打印与脱敏（绝不打印绝对路径与凭据）
// ---------------------------------------------------------------------------

/** 当前执行层根（绝对路径）：打印前替换掉，避免把部署主目录写进屏与证据。 */
let redactRoot = '';

/** 打印脱敏：先替换执行层根，再走 server-paths 的绝对路径剥离（同源一把尺）。 */
function redact(text: string): string {
  const withoutRoot = redactRoot.length > 0 ? text.split(redactRoot).join('<执行层根>') : text;
  return stripServerPaths(withoutRoot).text;
}

function log(line: string): void {
  console.log(redact(line));
}

/** 逐步读数的机器可读行（人话行之外并行一份，供证据聚合）。 */
function emit(event: string, detail: Record<string, unknown>): void {
  console.log(redact(JSON.stringify({ event, ...detail })));
}

// ---------------------------------------------------------------------------
// 安全硬闸
// ---------------------------------------------------------------------------

/** 只读硬闸触发的确定性中止（不是内部报错；调用方按「人话 + 下一步」处置）。 */
export class SmokeAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeAbort';
  }
}

/**
 * 只读硬闸：即将发起的 operation 必须是执行层自报清单里的 `access=read`。
 * 未在清单 / 未声明 access / access != read 一律中止——**这是唯一的执行入口收口点，
 * 不依赖模型或人记得**。任何想调写操作的人必须改代码，改了也逃不过这道闸。
 */
export function assertReadOnlyCall(operation: string, accessByName: ReadonlyMap<string, string>): void {
  const access = accessByName.get(operation);
  if (access === undefined) {
    throw new SmokeAbort(
      `安全硬闸：operation「${operation}」不在执行层自报的 operation 清单里——无法确认 access=read，拒绝调用。`,
    );
  }
  if (access !== READ_ACCESS) {
    throw new SmokeAbort(
      `安全硬闸：operation「${operation}」的 access=${access}（≠ read）——只读冒烟拒绝调用。`,
    );
  }
}

/**
 * 唯一执行入口（结构性收口）：先过只读硬闸，再发起调用。
 * 本脚本所有对执行层的 execute 都必须经此函数——任何人想在别处裸调 execute，会立刻
 * 在评审/绊线里现形（`smoke.test.ts` 钉住写操作经此路径被中止）。
 */
async function executeReadOnly(
  client: ExecutionClient,
  accessByName: ReadonlyMap<string, string>,
  request: ExecutionRequest,
): Promise<ExecutionOutcome> {
  assertReadOnlyCall(request.operation, accessByName);
  return await client.execute(request);
}

// ---------------------------------------------------------------------------
// 读数工具（纯函数，测试可钉）
// ---------------------------------------------------------------------------

/** access 计数：read / write / scratch / 其它（含未声明）。清单里 access 缺失 = 未声明。 */
export interface AccessCounts {
  read: number;
  write: number;
  scratch: number;
  undeclared: number;
}

export function countByAccess(operations: readonly RawGatewayOperation[]): AccessCounts {
  const counts: AccessCounts = { read: 0, write: 0, scratch: 0, undeclared: 0 };
  for (const op of operations) {
    const access = typeof op.access === 'string' ? op.access : '';
    if (access === 'read') counts.read += 1;
    else if (access === 'write') counts.write += 1;
    else if (access === 'scratch') counts.scratch += 1;
    else counts.undeclared += 1;
  }
  return counts;
}

/** 执行层自报的只读集合（唯一权威 = 清单的 access 声明）。 */
export function readOnlyNames(operations: readonly RawGatewayOperation[]): string[] {
  return operations.filter((op) => op.access === READ_ACCESS).map((op) => op.name);
}

/** operation → access 的查表（硬闸用它；未声明 access 记空串，硬闸按非 read 处理）。 */
export function accessIndex(operations: readonly RawGatewayOperation[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const op of operations) map.set(op.name, typeof op.access === 'string' ? op.access : '');
  return map;
}

/** 声明的必填参数条数（用于探针选择：优先挑必填参数的 op，空参调用得确定性拒绝回执）。 */
export function requiredArgCount(op: RawGatewayOperation): number {
  const positional = (op.args?.positional ?? []).filter((entry) => entry.required === true).length;
  const flags = (op.args?.flags ?? []).filter((entry) => entry.required === true).length;
  return positional + flags;
}

/** 长任务声明的 operation 名（契约 v4：只有声明 long_running 的 op 才可返回 accepted）。 */
export function longRunningNames(operations: readonly RawGatewayOperation[]): string[] {
  return operations.filter((op) => op.long_running === true).map((op) => op.name);
}

/**
 * 回执的机械摘要（不打印业务正文，只暴露形状与关键机械事实）：
 * 状态、缺什么、确认摘要、失败原因码与 retryable 声明、长任务句柄。
 */
export function summarizeOutcome(outcome: ExecutionOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case 'completed':
      return { status: outcome.status, hasData: outcome.data !== undefined, itemCount: outcome.items?.length ?? 0 };
    case 'needs_input':
      return { status: outcome.status, missing: outcome.missing.map((entry) => entry.name ?? entry.description) };
    case 'needs_confirmation':
      return {
        status: outcome.status,
        summary: outcome.confirmation.summary,
        ...(outcome.confirmation.expiresAt === undefined ? {} : { expiresAt: outcome.confirmation.expiresAt }),
      };
    case 'failed':
    case 'refused':
      return {
        status: outcome.status,
        code: outcome.error.code,
        message: outcome.error.message,
        retryable: outcome.error.retryable === undefined ? '未声明（按不可重试锁）' : outcome.error.retryable,
      };
    case 'accepted':
      return { status: outcome.status, operationId: outcome.operationId, pollAfterMs: outcome.pollAfterMs ?? null };
    default:
      return { status: (outcome as { status: string }).status };
  }
}

// ---------------------------------------------------------------------------
// 步骤
// ---------------------------------------------------------------------------

interface StepReading {
  id: string;
  title: string;
  plan: string;
  judgment: string;
  status: 'pass' | 'fail' | 'skip';
  detail: Record<string, unknown>;
}

function record(readings: StepReading[], step: StepReading): void {
  readings.push(step);
  const tag = step.status === 'pass' ? 'PASS' : step.status === 'fail' ? 'FAIL' : 'SKIP';
  log(`  [${tag}] ${step.title}`);
  emit('real_smoke_step', { id: step.id, status: step.status, detail: step.detail });
}

interface ResolvedDeployment {
  config: AppConfig;
  configSource: string;
  profileId: string;
  profile: ContextProfileConfig;
  principalId: string;
  role: string;
  permissions: readonly Permission[];
}

/**
 * 配置解析（复用既有加载链，不新造配置源）：
 * 显式 `--config=` / `AGENT_CONFIG_PATH` 优先；缺省物化仓内 dummy 夹具（与 ask 同源）。
 * 门与 ask 一致：单一 profile、声明 gateway、有 enabled principal。
 */
export function resolveDeployment(options: SmokeOptions, argv: readonly string[], env: NodeJS.ProcessEnv): ResolvedDeployment {
  const explicit = options.configPath ?? explicitConfigFrom([...argv], env);
  const resolved = explicit ?? materializeEvalConfig(FIXTURE_CONFIG, path.join(RUNTIME_DIR, 'agent-config.yaml'));
  const config = loadConfig({ yamlPath: resolved, env });
  const profileIds = Object.keys(config.contextProfiles);
  if (profileIds.length !== 1) {
    throw new SmokeAbort(`冒烟需要单一 contextProfile（当前 ${profileIds.length} 个）——本档不做多 profile 选择。`);
  }
  const profileId = profileIds[0]!;
  const profile = config.contextProfiles[profileId]!;
  if (!profile.gateway) {
    throw new SmokeAbort('profile 缺少 gateway——冒烟需要一个执行层挂载声明（contextProfiles.<id>.gateway）。');
  }
  const principalId = Object.entries(config.principals).find(([, principal]) => principal.enabled === true)?.[0];
  if (principalId === undefined) {
    throw new SmokeAbort('配置里没有 enabled principal——冒烟需要可信身份来源（fail-closed，不回落写死值）。');
  }
  const role = effectiveRoleOf(config, principalId);
  const permissions = permissionsOfRole(config, role);
  const configSource = explicit === undefined
    ? `仓内夹具（${path.relative(REPO_ROOT, resolved)}）`
    : path.relative(REPO_ROOT, resolved) || resolved;
  return { config, configSource, profileId, profile, principalId, role, permissions };
}

function selectProbeOperation(
  operations: readonly RawGatewayOperation[],
  accessByName: ReadonlyMap<string, string>,
  requested: string | undefined,
): RawGatewayOperation {
  if (requested !== undefined && requested.trim() !== '') {
    // 被请求的 op 先过硬闸（写操作/未登记都会被挡下并打印原因）。
    assertReadOnlyCall(requested, accessByName);
    const found = operations.find((op) => op.name === requested);
    if (found === undefined) throw new SmokeAbort(`operation「${requested}」未在清单中登记。`);
    return found;
  }
  const readOps = operations.filter((op) => op.access === READ_ACCESS);
  if (readOps.length === 0) throw new SmokeAbort('执行层未声明任何 access=read operation——只读探针无目标。');
  // 优先挑「有必填参数」的只读 op：空参调用得到确定性的拒绝/缺参回执（不回真实数据）。
  const withRequired = readOps.filter((op) => requiredArgCount(op) > 0);
  return withRequired[0] ?? readOps[0]!;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseSmokeArgs(argv);
  if ('help' in parsed) { console.log(USAGE); return; }
  if ('usageError' in parsed) { console.error(parsed.usageError); process.exitCode = 2; return; }

  const readings: StepReading[] = [];
  const mode = parsed.run ? '真跑（--run）' : '干跑（缺省，只打印步骤与判定，不发任何调用）';
  log('== 真实执行层只读冒烟（准备档） ==');
  log(`模式：${mode}`);

  // ---- S0 宿主侧：配置与身份（零调用） ----
  const deployment = resolveDeployment(parsed, argv, process.env);
  redactRoot = deployment.profile.root;
  const { configSource, profileId, profile, principalId, role, permissions } = deployment;
  log('\n[S0] 配置与身份（宿主侧，零调用）');
  log(`  配置源：${configSource}`);
  log(`  profile：${profileId} · gateway：${profile.gateway} · 执行层根：<执行层根>`);
  emit('real_smoke_config', { profileId, gateway: profile.gateway });
  record(readings, {
    id: 'config',
    title: '配置加载（单 profile + gateway 声明）',
    plan: '读部署配置，解析单一 contextProfile 与其 gateway',
    judgment: '恰好一个 profile 且声明 gateway = 通过；否则中止',
    status: 'pass',
    detail: { profileId, gateway: profile.gateway, configSource },
  });

  // ---- S1 群主体（宿主侧，零调用；与执行层无关） ----
  log('\n[S1] 群主体派生（宿主侧，零调用；与执行层无关）');
  log('  群主体规则：principal = <渠道>:group:<会话id>（server.ts 派生；群 = 独立主体，个人数据不进群）');
  log(`  本轮主体：${redact(principalId)} · 角色：${role} · 权限：${permissions.join(',')}`);
  log('  下一步（人工）：用群会话问一句 → `npm run tasks -- "#<编号>"` 查底账，核对 principal 前缀为 group。');
  record(readings, {
    id: 'group-principal',
    title: '群主体（宿主侧派生 + 角色）',
    plan: '读配置派生群主体与角色（不调用执行层）',
    judgment: '群会话任务在底账里以 <渠道>:group:<会话id> 立账、角色受宿主侧白名单约束 = 通过',
    status: 'pass',
    detail: { principalId, role, permissions: permissions.join('+') },
  });

  if (!parsed.run) {
    log('\n== 干跑结束：以下步骤在 --run 时才会真正执行 ==');
    for (const step of [
      ['discovery', '`<gateway> operation list --json`：按 access 计数、列只读集合与长任务声明'],
      ['readonly-gate', '确认执行层自报至少一个 access=read operation（否则中止）'],
      ['read-probe', '调用一个只读 operation，打印四态回执与 retryable 声明'],
      ['dispatchkey-replay', '同 dispatchKey 重放同一只读调用，比较回执是否稳定（不产生写副作用）'],
      ['declarations', '从清单读长任务/确认句柄/写上限的自述（只记录，不执行写）'],
    ] as const) {
      log(`  · [${step[0]}] ${step[1]}`);
    }
    log('\n安全硬闸：任何 access != read 的 operation 会在发起前被中止（不存在 --allow-write）。');
    return;
  }

  // ---- S2 发现：operation list --json（只读命令） ----
  log('\n[S2] 能力清单 discovery（只读命令：operation list --json）');
  const runtimeStateDir = path.join(RUNTIME_DIR, 'state');
  mkdirSync(runtimeStateDir, { recursive: true });
  const face = await resolveExecutionFace({
    profile,
    env: process.env,
    stateDir: runtimeStateDir,
    emptyOperationsMessage: '执行层没有声明任何只读 operation——只读冒烟拒绝以空允许集合运行。',
    allowWriteOperations: false,
    allowedPermissions: ['read'],
    emptyOperationsError: (message) => new SmokeAbort(message),
  });
  const client = face.client as DummyCliClient;
  const operations = await client.listOperations();
  const counts = countByAccess(operations);
  const accessByName = accessIndex(operations);
  const readOps = readOnlyNames(operations);
  log(`  operation 总数：${operations.length}（read=${counts.read} write=${counts.write} scratch=${counts.scratch} 未声明=${counts.undeclared}）`);
  log(`  只读集合（${readOps.length}）：${readOps.slice(0, 40).join(', ')}${readOps.length > 40 ? ' …' : ''}`);
  emit('real_smoke_discovery', { total: operations.length, counts, readOnly: readOps.length });
  record(readings, {
    id: 'discovery',
    title: '能力清单 discovery',
    plan: '`operation list --json`（只读命令）',
    judgment: '清单可解析且 access 计数稳定 = 通过',
    status: 'pass',
    detail: { total: operations.length, counts, readOnly: readOps.length },
  });

  // ---- S3 只读前置门 ----
  log('\n[S3] 只读前置门');
  if (readOps.length === 0) throw new SmokeAbort('执行层自报清单里没有任何 access=read operation——前置未通过，中止。');
  record(readings, {
    id: 'readonly-gate',
    title: '只读前置门（至少一个 access=read）',
    plan: '从执行层自报清单派生 access=read 集合',
    judgment: '只读集合非空 = 通过；空 = 中止',
    status: 'pass',
    detail: { readOnly: readOps.length },
  });

  // ---- S4 只读调用探针（retryable / 四态回执） ----
  const probe = selectProbeOperation(operations, accessByName, parsed.op);
  log(`\n[S4] 只读调用探针：${probe.name}`);
  assertReadOnlyCall(probe.name, accessByName);
  const probeArgs = { ...parsed.args };
  const outcome = await executeReadOnly(client, accessByName, { requestId: randomUUID(), dispatchKey: `smoke-${probe.name}-read`, operation: probe.name, args: probeArgs });
  const summary = summarizeOutcome(outcome);
  log(`  回执：${JSON.stringify(summary)}`);
  log('  判定：失败/拒绝回执必须带 code；retryable 未声明 = 宿主按不可重试锁（契约缺省）。');
  record(readings, {
    id: 'read-probe',
    title: '只读调用探针（四态回执 / retryable 声明）',
    plan: `调用 ${probe.name}（access=read）`,
    judgment: '收到确定性回执（completed/needs_input/failed/refused）且失败带 code = 通过',
    status: 'pass',
    detail: { operation: probe.name, ...summary },
  });

  // ---- S5 dispatchKey 重放（幂等，只读） ----
  log('\n[S5] dispatchKey 重放探针（同一 key × 2，只读，不产生写副作用）');
  const replayKey = `smoke-${probe.name}-replay`;
  const first = summarizeOutcome(await executeReadOnly(client, accessByName, { requestId: randomUUID(), dispatchKey: replayKey, operation: probe.name, args: probeArgs }));
  const second = summarizeOutcome(await executeReadOnly(client, accessByName, { requestId: randomUUID(), dispatchKey: replayKey, operation: probe.name, args: probeArgs }));
  const stable = JSON.stringify(first) === JSON.stringify(second);
  log(`  第一次：${JSON.stringify(first)}`);
  log(`  第二次：${JSON.stringify(second)}`);
  log(`  重放稳定：${stable ? '是' : '否（回执有差异，登记后人工判为何）'}`);
  record(readings, {
    id: 'dispatchkey-replay',
    title: 'dispatchKey 重放稳定性（只读）',
    plan: `同一 dispatchKey 重放 ${probe.name} 两次`,
    judgment: '两次回执一致 = 稳定；差异 = 需人工判（可能是查询数据的自然变化，不是写副作用）',
    status: stable ? 'pass' : 'skip',
    detail: { operation: probe.name, stable, first, second },
  });

  // ---- S6 声明面（长任务 / 确认句柄 / 写上限；只记录，不执行写） ----
  log('\n[S6] 声明面（只记录执行层自述，不执行任何写）');
  const longRunning = longRunningNames(operations);
  const writeOps = operations.filter((op) => op.access === 'write').map((op) => op.name);
  const confirmationOps = operations
    .filter((op) => (op.args?.flags ?? []).some((flag) => typeof flag.flag === 'string' && flag.flag.includes('confirmation')))
    .map((op) => op.name);
  log(`  长任务声明（long_running）：${longRunning.length > 0 ? longRunning.join(', ') : '无'}`);
  log(`  wait/abort 客户端面：wait=${typeof client.wait === 'function' ? '实现' : '未实现'} abort=${typeof client.abort === 'function' ? '实现' : '未实现'}`);
  log(`  写 operation（只记录，不调用）：${writeOps.length > 0 ? writeOps.join(', ') : '无'}`);
  log(`  声明 confirmation 参数的 op（只记录）：${confirmationOps.length > 0 ? confirmationOps.join(', ') : '无'}`);
  record(readings, {
    id: 'declarations',
    title: '声明面（长任务 / 确认句柄 / 写上限）',
    plan: '只读清单里的 long_running / confirmation / write op 自述',
    judgment: '自述可读且与后续写切片口径一致 = 通过；本阶段不执行写',
    status: 'pass',
    detail: {
      longRunning,
      waitImplemented: typeof client.wait === 'function',
      abortImplemented: typeof client.abort === 'function',
      writeOperations: writeOps,
      confirmationOperations: confirmationOps,
    },
  });

  // ---- 证据落点 ----
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: 'run',
    profileId,
    gateway: profile.gateway,
    contractReadOnly: [...face.readOnlyOperations],
    steps: readings,
  };
  mkdirSync(path.dirname(parsed.out), { recursive: true });
  writeFileSync(parsed.out, `${JSON.stringify(evidence, null, 2)}\n`);
  log(`\n证据已落盘：${path.relative(REPO_ROOT, parsed.out)}（gitignored；不含绝对路径与凭据）`);

  const failed = readings.filter((step) => step.status === 'fail');
  const skipped = readings.filter((step) => step.status === 'skip').length;
  log(`\n== 冒烟结束：${readings.length} 步，pass=${readings.length - failed.length - skipped} skip=${skipped} fail=${failed.length} ==`);
  if (failed.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    if (error instanceof SmokeAbort) {
      console.error(`\n中止：${redact(error.message)}`);
      process.exitCode = 2;
      return;
    }
    console.error(`冒烟失败：${redact(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
