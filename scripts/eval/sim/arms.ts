/**
 * SimCase · A/B 两臂（Main 技能面）跑批接线。
 *
 * 机制边界（对齐 AGENTS.md 与任务书）：
 *   · **不新建跑批器**：每个臂就是一次 `./run` 的 `runSimSuite`（批次/并发池/逐 trial
 *     独立目录/五类终态/Oracle 判定全部复用，零改动）；
 *   · **两臂只差技能**：同配置副本、同用例对象、同模拟用户模型、同 Oracle 注册表、
 *     同预算（用例自带 limits）、同并发；差异只在装配参数 `mainSkillsDir`：
 *     A 臂指向一个**空目录**（catalog 为空，`read_skill` 不注册），
 *     B 臂指向仓库 `.agents/skills`（catalog 含 `finance-business-basics`）。
 *
 *     S0 已删除 `mainSkillRoots` / `mainSkillMode` 配置键（未知键被静默忽略）。旧装置
 *     用这两个键做 A/B 会得到「两臂完全等价」的假结论——本模块不再读写任何配置技能键，
 *     差异只能来自装配参数。
 *   · **不得放宽判定**：`pass` 仍只由 `./oracle` 决定，本模块只加 `arm` 标签与装配探针；
 *   · 装配探针（`probeArmAssembly`）在跑任何样本前走**生产同源** `assembleSessionCore`，
 *     机械核对「A 空 catalog / 无 read_skill」「B 有 finance-business-basics / 有 read_skill」
 *     且两臂系统提示除技能块外逐字一致。`assertArmSurface` 是防静默假绿的硬门：
 *     把 B 臂也指向空目录时它必须抛错（自测里有反向绊线）。
 *
 * 批次策略：**分两批**（每臂一次 `runSimSuite`，串行）。理由见 `run-arms.ts` 报告头：
 * 同批混跑必须改 `./run` 的样本展开与汇总口径（把 arm 塞进终态/Oracle 机制），
 * 与「复用现有批次机制、不放宽判定」相冲突；分两批则两臂各自复用同一套批次读数，
 * 每批并发仍 ≤5，输入对象完全相同，差异只有装配参数。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { ContextProfileConfig } from '@fshine/contracts';
import {
  defaultMainSkillsDir, loadMainSkillDelivery, type MainSkillDelivery,
} from '../../../packages/agent/src/worker-skills';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import { assembleSessionCore } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { createAskRuntimeSystem, type AskRuntimeSystem } from './ask-adapter';
import type { SimCase } from './case';
import type { SimOracle } from './oracle';
import {
  runSimSuite, type SimSuiteInput, type SimSuiteResult, type SimTrialDeps, type SimTrialResult,
} from './run';
import type { SimModel } from './simulator';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

/** 两臂标识（报告与结果里原样出现；不得用于任何判定）。 */
export type SimArm = 'A' | 'B';

export const SIM_ARM_IDS: readonly SimArm[] = Object.freeze(['A', 'B']);

/** B 臂必须在 catalog 里看到的仓库技能（S3 落位；断言它存在才算 B 臂真的装上了技能）。 */
export const REQUIRED_B_SKILL = 'finance-business-basics';

/** A 臂空技能目录的目录名（挂在该臂探针/运行目录下；不存在任何 SKILL.md）。 */
export const EMPTY_SKILLS_DIRNAME = 'empty-main-skills';

/** 一臂的 Main 技能面声明（其余配置/输入两臂完全一致）。 */
export interface SimArmSpec {
  readonly arm: SimArm;
  /** 人读说明（进报告）。 */
  readonly label: string;
  /** 装配参数来源：`empty` = 运行时新建空目录；`repo` = 仓库 `.agents/skills`。 */
  readonly mainSkillsDirKind: 'empty' | 'repo';
}

/**
 * 臂定义。差异只有 `mainSkillsDirKind`——**不是配置键**：配置副本两臂逐字相同。
 */
export const SIM_ARMS: Readonly<Record<SimArm, SimArmSpec>> = Object.freeze({
  A: {
    arm: 'A',
    label: 'Main 无技能（mainSkillsDir 指向空目录：catalog 为空，read_skill 不注册）',
    mainSkillsDirKind: 'empty',
  },
  B: {
    arm: 'B',
    label: 'Main 技能目录（仓库 .agents/skills：catalog 含 finance-business-basics，read_skill 可读）',
    mainSkillsDirKind: 'repo',
  },
});

/**
 * 某臂的 `mainSkillsDir` 装配参数（绝对路径；`loadMainSkillDelivery` 拒绝相对路径）。
 *
 * A 臂在 `workRoot` 下建一个空目录（每次都新建，绝不复用可能被写入的旧目录）；
 * B 臂用生产默认目录发现（标记法定位仓库根 → `<repo>/.agents/skills`）。
 */
export function armMainSkillsDir(arm: SimArm, workRoot: string): string {
  const spec = SIM_ARMS[arm];
  if (spec.mainSkillsDirKind === 'empty') {
    const dir = path.join(workRoot, EMPTY_SKILLS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return defaultMainSkillsDir();
}

// ─────────────────────────────────────────────────────────────────────────────
// 每臂配置物化（两臂逐字相同；技能差异不在这里）
// ─────────────────────────────────────────────────────────────────────────────

export interface SimArmConfig {
  readonly arm: SimArm;
  readonly configPath: string;
  readonly profile: ContextProfileConfig;
}

/**
 * 物化某臂的配置副本：按既有 `materializeEvalConfig` 把相对 root 解析成绝对路径。
 *
 * **不改任何技能相关字段**：S0 之后 Main 技能只由装配参数 `mainSkillsDir` 决定，
 * 配置里写 `mainSkillRoots` / `mainSkillMode` 只会被静默忽略（旧装置的死因）。
 */
export function materializeArmConfig(arm: SimArm, outPath: string): SimArmConfig {
  materializeEvalConfig(FIXTURE_CONFIG, outPath);
  const doc = parseYaml(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
  const profiles = doc['contextProfiles'];
  if (profiles === null || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error(`臂 ${arm} 的夹具配置缺少 contextProfiles`);
  }
  const keys = Object.keys(profiles as Record<string, unknown>);
  if (keys.length !== 1) throw new Error(`臂 ${arm} 需要单一 contextProfile（当前 ${keys.length} 个）`);
  // 逐字重写一次（稳定 YAML），不做字段增删；留作审计副本。
  writeFileSync(outPath, stringifyYaml(doc), 'utf8');

  const config = loadConfig({ yamlPath: outPath });
  const loadedProfile = config.contextProfiles[keys[0]!];
  if (loadedProfile === undefined) throw new Error(`臂 ${arm} 配置加载后找不到 profile ${keys[0]}`);
  return { arm, configPath: outPath, profile: loadedProfile };
}

/** 臂的 Main 技能投递读数（装配期事实；用于报告与「只差技能」核对）。 */
export interface SimArmDelivery {
  /** 装配参数原样（绝对路径）。 */
  readonly mainSkillsDir: string;
  /** 追加到 Main 系统提示的技能块；空串 = 零增长。 */
  readonly promptBlock: string;
  readonly promptBlockBytes: number;
  /** catalog 原文（name+description 清单）。 */
  readonly catalog: string;
  readonly catalogBytes: number;
  readonly catalogSkillNames: readonly string[];
  readonly registryRegistered: boolean;
}

/** 按装配参数读取生产同源的 Main 技能投递（只读；不触模）。 */
export async function armDelivery(mainSkillsDir: string): Promise<SimArmDelivery> {
  const delivery: MainSkillDelivery = await loadMainSkillDelivery(mainSkillsDir);
  const catalogSkillNames = delivery.registry === undefined
    ? []
    : (await delivery.registry.discover()).map((metadata) => metadata.name).sort();
  return {
    mainSkillsDir,
    promptBlock: delivery.promptBlock,
    promptBlockBytes: Buffer.byteLength(delivery.promptBlock, 'utf8'),
    catalog: delivery.catalog,
    catalogBytes: delivery.catalogBytes,
    catalogSkillNames,
    registryRegistered: delivery.registry !== undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配探针：生产同源装配 → 系统提示 + 主工具面（零模型调用）
// ─────────────────────────────────────────────────────────────────────────────

export interface SimArmProbe {
  readonly arm: SimArm;
  readonly configPath: string;
  readonly systemPrompt: string;
  /** Main 工具面（`TurnDriverInput.tools` 的名字，按装配顺序）。 */
  readonly tools: readonly string[];
  readonly readSkillToolRegistered: boolean;
  readonly delivery: SimArmDelivery;
}

export interface ProbeArmOptions {
  /** 覆盖该臂的 `mainSkillsDir`（自测的反向绊线用：把 B 也指向空目录）。 */
  readonly mainSkillsDir?: string;
}

/**
 * 在**不调用任何模型**的前提下走真实装配链（`scripts/ask-runtime.ts` 的
 * `assembleSessionCore`：同样的 `loadConfig` → `loadMainSkillDelivery` → `createSession`），
 * 用一个只记录 `systemPrompt/tools` 的驱动发一条探针消息，返回 Main 实际看到的面。
 *
 * 这是 A/B 两臂「装配参数差异真的生效」的机械证据：不是靠读配置文件猜，而是看装配产物。
 */
export async function probeArmAssembly(
  arm: SimArm,
  workDir: string,
  env: NodeJS.ProcessEnv,
  options: ProbeArmOptions = {},
): Promise<SimArmProbe> {
  mkdirSync(workDir, { recursive: true });
  const mainSkillsDir = options.mainSkillsDir ?? armMainSkillsDir(arm, workDir);
  const prepared = materializeArmConfig(arm, path.join(workDir, `arm-${arm}.yaml`));
  const config = loadConfig({ yamlPath: prepared.configPath, env });
  const effectiveEnv = effectiveDeploymentEnv(config, env);

  const capture: { systemPrompt?: string; tools?: readonly string[] } = {};
  const probeDriver: TurnDriver = {
    async run(input) {
      capture.systemPrompt = input.systemPrompt;
      capture.tools = input.tools.map((tool) => tool.name);
      return { text: '收到。', messages: [] };
    },
    transcript: () => [],
  };

  const assembled = await assembleSessionCore({
    env: effectiveEnv,
    profile: prepared.profile,
    principalId: 'wecom:fixture-user',
    sessionId: `sim-arm-probe-${arm}`,
    dbPath: path.join(workDir, 'probe.db'),
    stateDir: path.join(workDir, 'probe-state'),
    emptyOperationsMessage: '执行层没有声明任何只读 operation——A/B 探针拒绝以空允许集合装配。',
    mainSkillsDir,
    createDrivers: () => ({ mainDriver: probeDriver, workerDriver: probeDriver }),
  });
  try {
    await assembled.session.send('探针：只回一句确认，不要调用任何工具。');
  } finally {
    assembled.close();
  }
  if (capture.systemPrompt === undefined || capture.tools === undefined) {
    throw new Error(`臂 ${arm} 装配探针未观察到 Main 回合（驱动未被调用）`);
  }
  const delivery = await armDelivery(mainSkillsDir);
  const tools = capture.tools;
  return {
    arm,
    configPath: prepared.configPath,
    systemPrompt: capture.systemPrompt,
    tools,
    readSkillToolRegistered: tools.includes('read_skill'),
    delivery,
  };
}

/** 臂面期望：A 必须为空，B 必须含指定技能（由硬门与反向绊线共用）。 */
export interface ArmSurfaceExpectation {
  /** B 臂必须出现在 catalog 的技能名（A 臂忽略）。 */
  readonly requiredNames?: readonly string[];
}

/**
 * **防静默假绿的关键断言**（`probeArmPair` 与反向绊线共用）：
 *   · A：catalog 为空、无 `read_skill` 工具、技能块 0 字节、系统提示无技能标记；
 *   · B：catalog 含必需技能、`read_skill` 已注册、技能块非空且含该 name。
 * 任一不满足即抛（不烧样本）。把 B 指向空目录时这里必须抛——自测的反向绊线证明它有效。
 */
export function assertArmSurface(
  probe: SimArmProbe,
  expectation: ArmSurfaceExpectation = {},
): void {
  const problems: string[] = [];
  const { delivery } = probe;
  if (probe.arm === 'A') {
    if (delivery.catalogBytes !== 0) problems.push(`A 臂 catalog 非空（${delivery.catalogBytes}B，应为 0）：${delivery.catalog}`);
    if (delivery.catalogSkillNames.length !== 0) problems.push(`A 臂 catalog 技能非空：${delivery.catalogSkillNames.join('、')}`);
    if (delivery.promptBlockBytes !== 0) problems.push(`A 臂技能块非空（${delivery.promptBlockBytes}B，应为 0）`);
    if (delivery.registryRegistered) problems.push('A 臂登记了 Main 技能表（read_skill 不应注册）');
    if (probe.readSkillToolRegistered) problems.push('A 臂工具面含 read_skill（不应注册）');
    if (probe.tools.includes('read_skill')) problems.push('A 臂工具面含 read_skill（重复核对）');
    if (probe.systemPrompt.includes('【可用技能')) problems.push('A 臂系统提示含技能块标记「【可用技能」');
    if (problems.length > 0) {
      throw new Error(`A 臂技能面断言失败（mainSkillsDir=${delivery.mainSkillsDir}）：\n${problems.join('\n')}`);
    }
    return;
  }

  const required = expectation.requiredNames ?? [REQUIRED_B_SKILL];
  for (const name of required) {
    if (!delivery.catalogSkillNames.includes(name)) {
      problems.push(`B 臂 catalog 缺技能 ${name}（当前：${delivery.catalogSkillNames.join('、') || '（空）'}）`);
    }
    if (!delivery.promptBlock.includes(name)) problems.push(`B 臂技能块不含 name ${name}（${delivery.promptBlockBytes}B）`);
  }
  if (delivery.catalogBytes === 0) problems.push('B 臂 catalog 为空（应有技能清单）');
  if (delivery.promptBlockBytes === 0) problems.push('B 臂技能块为空（应为非空）');
  if (!delivery.registryRegistered) problems.push('B 臂未登记 Main 技能表（read_skill 应可读）');
  if (!probe.readSkillToolRegistered) problems.push('B 臂工具面缺 read_skill');
  if (problems.length > 0) {
    throw new Error(`B 臂技能面断言失败（mainSkillsDir=${delivery.mainSkillsDir}）：\n${problems.join('\n')}`);
  }
}

/**
 * 两臂装配核对（跑任何样本前的硬门）：
 *   · 调 `assertArmSurface`（A 空 / B 有指定技能）；
 *   · 除技能外逐字一致：把 B 的技能块从系统提示里去掉后必须等于 A，工具面只差 read_skill。
 */
export function assertArmPairDiffersOnlyBySkills(a: SimArmProbe, b: SimArmProbe): void {
  const problems: string[] = [];
  if (a.arm !== 'A' || b.arm !== 'B') problems.push(`臂标签错误：A=${a.arm} B=${b.arm}`);
  try {
    assertArmSurface(a);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  try {
    assertArmSurface(b, { requiredNames: [REQUIRED_B_SKILL] });
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  // 只差技能：B 去掉技能块 == A；工具面只差 read_skill。
  const bWithoutSkills = b.systemPrompt.replace(b.delivery.promptBlock, '');
  if (bWithoutSkills !== a.systemPrompt) problems.push('两臂系统提示除技能块外不一致（基线被改动）');
  const toolsA = [...a.tools].sort();
  const toolsB = [...b.tools].sort();
  const expectedB = [...toolsA, 'read_skill'].sort();
  if (JSON.stringify(toolsB) !== JSON.stringify(expectedB)) {
    problems.push(`两臂工具面不只差 read_skill：A=[${toolsA.join(',')}] B=[${toolsB.join(',')}]`);
  }
  if (problems.length > 0) throw new Error(`A/B 两臂装配核对失败（未跑任何样本）：\n${problems.join('\n')}`);
}

/** 便捷封装：物化 → 探针 → 核对（真实跑批与自测共用）。 */
export async function probeArmPair(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<{ a: SimArmProbe; b: SimArmProbe }> {
  const a = await probeArmAssembly('A', path.join(root, 'arm-A'), env);
  const b = await probeArmAssembly('B', path.join(root, 'arm-B'), env);
  assertArmPairDiffersOnlyBySkills(a, b);
  return { a, b };
}

// ─────────────────────────────────────────────────────────────────────────────
// 生产同源系统装配（真实跑批用）
// ─────────────────────────────────────────────────────────────────────────────

export interface SimArmAskRuntimeInput {
  readonly arm: SimArm;
  /** 该 trial 独立运行目录（配置副本 / sessionDir / state.db 都落这里）。 */
  readonly runtimeDir: string;
  readonly sessionId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly principalId?: string;
  /** 覆盖该臂的技能目录（缺省按臂物化；跑批必须与装配探针同值）。 */
  readonly mainSkillsDir?: string;
}

/**
 * 每 trial 一个被测系统：配置副本两臂相同，`mainSkillsDir` 由本臂决定，其余走
 * `createAskRuntimeSystem`（生产同源 `assembleAskRuntime`）。trial 目录互不共享由
 * `./run` 的隔离断言守。
 */
export async function createArmAskRuntimeSystem(input: SimArmAskRuntimeInput): Promise<AskRuntimeSystem> {
  mkdirSync(input.runtimeDir, { recursive: true });
  const prepared = materializeArmConfig(input.arm, path.join(input.runtimeDir, 'agent-config.yaml'));
  const mainSkillsDir = input.mainSkillsDir ?? armMainSkillsDir(input.arm, input.runtimeDir);
  return createAskRuntimeSystem({
    runtimeDir: input.runtimeDir,
    sessionId: input.sessionId,
    env: input.env,
    argv: [`--config=${prepared.configPath}`],
    ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
    mainSkillsDir,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 单臂跑批：复用 runSimSuite（不新建跑批器）
// ─────────────────────────────────────────────────────────────────────────────

/** trial 结果 + 臂标签（`pass` 原样来自 `./run` 的 Oracle 判定）。 */
export interface SimArmTrialResult extends SimTrialResult {
  readonly arm: SimArm;
}

export interface RunSimArmSuiteInput {
  readonly arm: SimArm;
  readonly outRoot: string;
  readonly cases: readonly SimCase[];
  /** 样本级并发池（缺省 5，同 `./run`）；两臂必须传同值。 */
  readonly concurrency?: number;
  readonly oracles?: readonly SimOracle[];
  readonly simulator: SimModel;
  readonly judge?: SimModel;
  readonly now?: () => number;
  readonly maxProtocolRepairs?: number;
  /** 自测注入假系统；缺省 = 本臂配置 + 生产同源装配。 */
  readonly createSystem?: SimTrialDeps['createSystem'];
  /** 装配探针工作目录（缺省 `<outRoot>/.arm-probe`）。 */
  readonly probeWorkDir?: string;
  /** 装配环境（缺省 process.env）。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 已由调用方探针核对时的复用（避免重复装配）；缺省现探。 */
  readonly probe?: SimArmProbe;
}

export interface SimArmSuiteResult {
  readonly arm: SimArm;
  readonly spec: SimArmSpec;
  readonly outRoot: string;
  readonly probe: SimArmProbe;
  readonly trials: readonly SimArmTrialResult[];
  readonly summary: SimSuiteResult['summary'];
  readonly batch: SimSuiteResult['batch'];
}

/** 每 trial 独立 sessionId（与 run-real 同款：case + trial 目录尾段）。 */
function trialSessionId(arm: SimArm, caseDef: SimCase, root: string): string {
  return `sim-${arm}-${caseDef.id}-${root.split(path.sep).slice(-2).join('-')}`;
}

export async function runSimArmSuite(input: RunSimArmSuiteInput): Promise<SimArmSuiteResult> {
  const env = input.env ?? process.env;
  const probe = input.probe ?? await probeArmAssembly(
    input.arm,
    input.probeWorkDir ?? path.join(input.outRoot, '.arm-probe'),
    env,
  );
  if (probe.arm !== input.arm) throw new Error(`装配探针臂标签不符：${probe.arm} != ${input.arm}`);
  // 未由调用方核对时，单臂也要过自己的面断言（防「探针跑了但没检查」）。
  assertArmSurface(probe);

  const mainSkillsDir = probe.delivery.mainSkillsDir;
  const suiteInput: SimSuiteInput = {
    cases: input.cases,
    outRoot: input.outRoot,
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    oracles: input.oracles ?? [],
    simulator: input.simulator,
    createSystem: input.createSystem ?? (async (paths, caseDef) => createArmAskRuntimeSystem({
      arm: input.arm,
      runtimeDir: paths.root,
      sessionId: trialSessionId(input.arm, caseDef, paths.root),
      env,
      mainSkillsDir,
    })),
    ...(input.judge === undefined ? {} : { judge: input.judge }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.maxProtocolRepairs === undefined ? {} : { maxProtocolRepairs: input.maxProtocolRepairs }),
  };
  const suite = await runSimSuite(suiteInput);

  const trials: SimArmTrialResult[] = suite.trials.map((trial) => ({ ...trial, arm: input.arm }));
  // 证据落盘后补臂标签：写 trial 根目录（不重写 evidence/manifest，避免破哈希）。
  for (const trial of trials) {
    writeFileSync(
      path.join(trial.paths.root, 'arm.json'),
      JSON.stringify({
        arm: input.arm,
        spec: SIM_ARMS[input.arm],
        mainSkillsDir,
        oracleId: trial.oracle?.id ?? null,
      }, null, 2) + '\n',
      'utf8',
    );
  }
  writeFileSync(
    path.join(input.outRoot, 'arm-probe.json'),
    JSON.stringify({
      arm: input.arm,
      spec: SIM_ARMS[input.arm],
      configPath: probe.configPath,
      tools: probe.tools,
      readSkillToolRegistered: probe.readSkillToolRegistered,
      delivery: {
        mainSkillsDir: probe.delivery.mainSkillsDir,
        promptBlock: probe.delivery.promptBlock,
        promptBlockBytes: probe.delivery.promptBlockBytes,
        catalog: probe.delivery.catalog,
        catalogBytes: probe.delivery.catalogBytes,
        catalogSkillNames: probe.delivery.catalogSkillNames,
        registryRegistered: probe.delivery.registryRegistered,
      },
      systemPrompt: probe.systemPrompt,
    }, null, 2) + '\n',
    'utf8',
  );
  return {
    arm: input.arm,
    spec: SIM_ARMS[input.arm],
    outRoot: input.outRoot,
    probe,
    trials,
    summary: suite.summary,
    batch: suite.batch,
  };
}
