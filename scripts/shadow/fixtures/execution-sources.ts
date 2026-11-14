/**
 * Shadow 双源对照 · 执行源夹具（测试夹具层；**不是产品代码、不是平台模拟框架**）。
 *
 * 位置说明（为什么在 fixtures/ 目录）：
 *   P0 单一装配点守卫（scripts/p0-assembly-single-point.test.ts）要求装配链符号
 *   （createSession / createDummyCliClient / readOnlyOperationNames）在生产 .ts 中只出现
 *   在唯一装配模块 scripts/ask-runtime.ts；守卫按目录排除 `fixtures`。本文件是**测试夹具**
 *   （只被 scripts/shadow/double-source.test.ts 经由 harness 使用），放在 fixtures 目录下
 *   既让守卫保持原判（不误把夹具当第二份生产装配），也不改守卫/冻结判据。
 *
 * 双源：
 *   · `dummy`    = 仓内 dummy fixture（scripts/eval/fixtures/dummy-platform/bin/dummy.cjs）
 *                  + 生产适配器 dummy-cli-client.ts：真实 spawn / --state-dir / audit.jsonl；
 *   · `fake-real`= 进程内 ExecutionClient 测试替身：可配四态（completed/failed/needs_input/refused）、
 *                  错误信封 {code,message,retryable?,details?}、能力快照形状；零子进程、零网络、零凭据。
 *
 * 边界（硬性）：double 仅测试夹具层级——不模拟平台实现、不模拟网络/限流/凭据，不进入产品路径；
 * 不连接真实企微/真实执行层。真实连接需 owner 授权。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_CONTRACT_VERSION,
  type CapabilityManifest,
  type ExecutionArgDeclaration,
  type ExecutionClient,
  type ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import { createDummyCliClient, readOnlyOperationNames, type RawGatewayOperation } from '../../../packages/agent/src/dummy-cli-client';

export type { RawGatewayOperation };

/** 仓根（本文件 = scripts/shadow/fixtures/execution-sources.ts）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 缺省夹具根：仓内 dummy-platform。 */
export const DEFAULT_FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

/** 缺省环境：与生产 worker 白名单同形（PATH/HOME/TMPDIR），不借宿主环境改道。 */
export function defaultEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] };
}

/** 稳定的规范化 JSON（对象键排序；用于 digest/等价比较，与时间戳/随机 id 无关）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/** 内容摘要（sha256 of canonical JSON）。 */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * 只读数据面指纹（源 A）：交付数据文件（state/plans/proposals）逐字节 sha256；
 * 缺失 = 'absent'。audit.jsonl 是调用证据不是数据面，不进指纹（但读路径必须以 audit 行
 * 证明真的执行过——见 ShadowFace.mechanical）。
 */
const DATA_SURFACE_FILES = ['dummy-state.json', 'plans.json', 'proposals.json'] as const;
export function dataSurfaceFingerprint(dir: string): string {
  const entries: Record<string, string> = {};
  for (const name of DATA_SURFACE_FILES) {
    const file = path.join(dir, name);
    entries[name] = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent';
  }
  return canonicalDigest(entries);
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
}

// ---------------------------------------------------------------------------
// 源开关
// ---------------------------------------------------------------------------

export type ShadowSourceName = 'dummy' | 'fake-real';
export type ShadowSourceKind = 'repo-dummy-fixture' | 'test-fake-real';

/**
 * 源开关解析（回退开关）：缺省/空 = `dummy`（现状基线，最小惊讶）；
 * 只承认 dummy | fake-real；未知值（含 `real`）fail-closed 抛错——真实连接不在本 harness 内。
 */
export function parseShadowSourceName(value?: string): ShadowSourceName {
  const raw = (value ?? '').trim();
  if (raw === '' || raw === 'dummy') return 'dummy';
  if (raw === 'fake-real') return 'fake-real';
  throw new Error(`未知的 SHADOW 执行源「${raw}」：本 harness 只支持 dummy | fake-real（真实连接需 owner 授权，不在本 harness 内）。`);
}

// ---------------------------------------------------------------------------
// 源 B：测试替身 ExecutionClient（可配四态 + 错误信封 + 能力快照形状）
// ---------------------------------------------------------------------------

export interface FakeRealOutcome {
  status: 'completed' | 'needs_input' | 'failed' | 'refused';
  data?: unknown;
  missing?: readonly { name?: string; description: string }[];
  error?: { code: string; message: string; retryable?: boolean; details?: unknown };
}

export interface FakeRealConfig {
  /** 能力快照/清单形状（access 声明同形于夹具自述；缺省 = 与源 A 只读面同形的 `FAKE_REAL_READ_OPERATIONS`）。 */
  operations?: readonly RawGatewayOperation[];
  /** operation → 四态结果脚本（错误信封原样进契约层，不由宿主改写）。 */
  outcomes?: Readonly<Record<string, FakeRealOutcome>>;
  /** 只读数据面（读路径不得改变它；指纹 = canonicalDigest(store)）。 */
  store?: unknown;
}

export interface FakeRealCall {
  requestId: string;
  operation: string;
  args: Readonly<Record<string, unknown>>;
}

export interface FakeRealExecutionClient extends ExecutionClient {
  readonly kind: 'test-fake-real';
  readonly calls: readonly FakeRealCall[];
  storeDigest(): string;
}

/**
 * 缺省能力快照形状：与源 A 夹具只读面同形的两个 read operation（+ 一个 write 作派生过滤器
 * 证据）。只读面派生走生产的 readOnlyOperationNames 同一函数（单一规则）。
 */
export const FAKE_REAL_READ_OPERATIONS: readonly RawGatewayOperation[] = [
  {
    name: 'dummy.query',
    label: 'query records',
    access: 'read',
    args: {
      flags: [
        { flag: '--collection', required: true, style: 'name' },
        { flag: '--window', required: false, style: 'code' },
      ],
    },
  },
  {
    name: 'ballot.query',
    label: 'query ballots',
    access: 'read',
    args: {
      flags: [
        { flag: '--topic', required: true, style: 'name' },
        { flag: '--round', required: false, style: 'code' },
      ],
    },
  },
  {
    name: 'dummy.commit',
    label: 'commit records',
    access: 'write',
    args: { flags: [{ flag: '--collection', required: true, style: 'name' }] },
  },
];

/** 参数声明投影：位置参数在前、flag 在后（与生产适配器的投影规则同形）。 */
function declaredArgsOf(operation: RawGatewayOperation): ExecutionArgDeclaration[] {
  const positional = (operation.args?.positional ?? [])
    .filter((entry) => typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => ({ name: entry.name as string, required: entry.required === true }));
  const flags = (operation.args?.flags ?? [])
    .filter((entry) => typeof entry.flag === 'string' && entry.flag !== '')
    .map((entry) => ({
      name: entry.flag as string,
      required: entry.required === true,
      ...(typeof entry.style === 'string' && entry.style !== '' ? { type: entry.style } : {}),
    }));
  return [...positional, ...flags];
}

function materializeOutcome(script: FakeRealOutcome): ExecutionOutcome {
  switch (script.status) {
    case 'completed':
      return script.data === undefined ? { status: 'completed' } : { status: 'completed', data: script.data };
    case 'needs_input':
      return {
        status: 'needs_input',
        missing: script.missing ?? [{ description: script.error?.message ?? '执行层要求补充输入。' }],
        ...(script.data === undefined ? {} : { data: script.data }),
        ...(script.error === undefined ? {} : { error: script.error }),
      };
    case 'failed':
      return {
        status: 'failed',
        error: script.error ?? { code: 'EXECUTION_UNKNOWN_ERROR', message: '（shadow double）未配置错误信封。' },
      };
    case 'refused':
      return {
        status: 'refused',
        error: script.error ?? { code: 'EXECUTION_REFUSED', message: '（shadow double）未配置错误信封。' },
      };
  }
}

/** 建测试替身 ExecutionClient（进程内；capabilities 不产生 calls，execute 追加调用记录）。 */
export function createFakeRealClient(config: FakeRealConfig = {}): FakeRealExecutionClient {
  const operations = config.operations ?? FAKE_REAL_READ_OPERATIONS;
  const outcomes = config.outcomes ?? {};
  const store = config.store ?? { seeded: 'shadow-double-store' };
  const calls: FakeRealCall[] = [];
  return {
    kind: 'test-fake-real',
    calls,
    storeDigest: () => canonicalDigest(store),
    async capabilities(): Promise<CapabilityManifest> {
      return {
        contractVersion: EXECUTION_CONTRACT_VERSION,
        operations: operations.map((operation) => ({
          name: operation.name,
          ...(typeof operation.label === 'string' && operation.label !== '' ? { label: operation.label } : {}),
          args: declaredArgsOf(operation),
        })),
      };
    },
    async execute(request) {
      calls.push({ requestId: request.requestId, operation: request.operation, args: { ...request.args } });
      const script = outcomes[request.operation];
      if (script === undefined) return { status: 'completed' as const };
      return materializeOutcome(script);
    },
  };
}

// ---------------------------------------------------------------------------
// 执行源（A/B 统一面）
// ---------------------------------------------------------------------------

export interface ShadowFace {
  client: ExecutionClient;
  /** 只读允许集合（read access 派生；排序后便于跨源对照）。 */
  allowedOperations: readonly string[];
  /** 只读数据面指纹（读路径前后必须相等）。 */
  dataFingerprint(): string;
  /** 机械证据读数：A=真实 spawn + 执行层审计行；B=进程内调用记录（防单源冒充）。 */
  mechanical(stateDir: string): { spawnedGateway: boolean; auditLines: number; calls: number };
}

export interface ShadowSource {
  readonly name: ShadowSourceName;
  readonly kind: ShadowSourceKind;
  createFace(stateDir: string): Promise<ShadowFace>;
}

export interface ShadowSourceOptions {
  fixtureRoot?: string;
  env?: NodeJS.ProcessEnv;
  fakeReal?: FakeRealConfig;
}

/** 按源开关建执行源；未知名在此前由 parseShadowSourceName fail-closed。 */
export function createShadowSource(name: ShadowSourceName, options: ShadowSourceOptions = {}): ShadowSource {
  const fixtureRoot = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  const env = options.env ?? defaultEnv();
  if (name === 'dummy') {
    return {
      name,
      kind: 'repo-dummy-fixture',
      async createFace(stateDir: string): Promise<ShadowFace> {
        const client = createDummyCliClient({ root: fixtureRoot, gateway: 'bin/dummy', stateDir, env });
        const operations = await client.listOperations();
        return {
          client,
          allowedOperations: [...readOnlyOperationNames(operations)].sort(),
          dataFingerprint: () => dataSurfaceFingerprint(stateDir),
          mechanical: () => ({
            spawnedGateway: true,
            auditLines: countLines(path.join(stateDir, 'audit.jsonl')),
            calls: 0,
          }),
        };
      },
    };
  }
  return {
    name,
    kind: 'test-fake-real',
    async createFace(): Promise<ShadowFace> {
      const client = createFakeRealClient(options.fakeReal);
      const operations = options.fakeReal?.operations ?? FAKE_REAL_READ_OPERATIONS;
      return {
        client,
        allowedOperations: [...readOnlyOperationNames(operations)].sort(),
        dataFingerprint: () => client.storeDigest(),
        mechanical: () => ({ spawnedGateway: false, auditLines: 0, calls: client.calls.length }),
      };
    },
  };
}
