/**
 * 能力发现接缝（「关进笼子」，2026-11-13）：一次发现、一份快照、一个传输点。
 *
 * 为什么有这个文件：发现子命令（执行层清单）是执行层的**适配器绑定**——`docs/a2a-protocol.md`
 * 「文件交换」节与 `packages/contracts/src/a2a-protocol.ts:118/146` 已声明执行层可用任何传输
 * 实现（CLI / 网络）。但此前发现是散装的：`operation-labels.ts` 七个 loader 各自 spawn 同一个
 * 子命令一遍、无单一快照，generic 代码写死 CLI + `--json` + 拆信封。本模块把发现收进单一接缝：
 *
 *   · `CapabilityManifest`：一次发现输出的完整类型化投影（原始值，卫生在派生函数里做）；
 *   · `parseCapabilityManifest(stdout)`：纯函数（文档文本 → 快照；不可解析 / 无清单 → null）；
 *   · 八张派生表（label / args 规格 / flag 样式 / access 语义 / 语义表 / 协议角色 / serve 模式 /
 *     码级语义）与协议投影：全部由快照**纯函数**派生——唯一实现在本模块，`operation-labels.ts`
 *     的 `parse*` / `load*` 只是它的门面（测试在用，行为逐字段等价）；
 *   · `CapabilitySource`：传输接口。`CliCapabilitySource` 是 CLI 实现——本文件是
 *     `packages` / `apps` 生产代码里唯一出现发现子命令字面量、唯一 spawn 发现面的地方；
 *     `MemoryCapabilitySource` 是测试 / eval 注入实现。将来换传输（网络模式等）= 换这一个
 *     实现类，generic 代码一行不改。
 *
 * 快照语义：boot 期发现一次、进程生命周期内不变、失效 = 重启；不做刷新机制。
 * `load()` 自身**不缓存**（调用一次 = 发现一次，便于按调用计数钉测试）——缓存归调用方：
 * 生产装配在 boot 期构造一次、加载一次并把派生表注入各消费点（apps/server/assembly.ts）；
 * 驱动工厂在未注入时按平台根缓存一份（pi-coding-driver.ts）。两条路径都只发现一次。
 *
 * 类型为什么放在本包而不是 `contracts`：这份投影的字段（`est_seconds` / `serve`|`modes` /
 * `proposalSchema` / args 规格）是 CLI 适配器绑定的**文档形状**，不是协议语义；契约包只持有
 * 协议投影（`OperationDeclaration` / 协议 `CapabilityManifest`）。把 CLI 文档键焊进
 * `contracts` 等于把适配器细节升级成协议冻结面——与 `a2a-protocol.ts` 的边界注释相悖。
 * 协议投影由本模块的 `protocolManifestOf` 单向派生（快照 → 协议语义），方向也只有这一条。
 */
import { spawn } from 'node:child_process';
import { A2A_PROTOCOL_VERSION, type CapabilityManifest as ProtocolCapabilityManifest, type OperationDeclaration } from '@fshine/contracts';
import { hostDirectChildEnv } from './child-env';
import { gatewayExecPath, validateGatewayInvocation, type ErrorCodeSemantics, type SelectionRenderKind, type TerminalCodeSemantics } from './platform-contract';

// ── 派生表类型（快照的消费面；operation-labels.ts 原样再导出，调用方导入路径不变）────────

/** script → label 查找表。script 与操作名两种写法都收录（命令里两种都合法）。 */
export type OperationLabels = Map<string, string>;

/**
 * flag → 取值样式（平台 args 规格的 `style` 列，数据不是逻辑）：
 *   · name：名称类取值，进度帧里加书名号；
 *   · code：编号/时间类取值，原样；
 *   · none：布尔开关（无取值）——不进参数摘要。
 * 查不到样式（旧版平台 / 平台没给这个 flag 起样式）→ 不进摘要（安全缺省，
 * 与 label 缺失同族：没有规格就不渲染，绝不回退到宿主硬编码名单）。
 */
export type KeyArgStyle = 'name' | 'code';
export type KeyArgStyles = ReadonlyMap<string, KeyArgStyle>;

/**
 * 单个 operation 的 args 规格（发现文档的 `args` 列，平台机器可读面）。
 *   · positionalNames：位置参数名（按序）——平台**声明名**（accountSet/period/…），
 *     宿主据此机械取值，不猜第几个参数是什么；
 *   · flagStyles：flag → 取值样式（name/code；none 布尔开关不入表）。
 */
export interface OperationArgsSpec {
  positionalNames: readonly string[];
  flagStyles: ReadonlyMap<string, KeyArgStyle>;
}

/** operation 注册名（也收 command 裸名）→ args 规格。 */
export type OperationArgsSpecs = ReadonlyMap<string, OperationArgsSpec>;

/**
 * 平台 access 语义（顶层 `accessSemantics` 表的一行，数据不是逻辑）：
 *   · plan    要不要过计划门（进计划、被记账）；
 *   · confirm 要不要用户确认（确认码 + commit token）——**是不是写**的唯一判据。
 *
 * 两列缺一项/不是布尔一律按 false（宁缺勿猜：判据不成立时绝不放大权限）。
 */
export interface AccessSemantics {
  plan: boolean;
  confirm: boolean;
}

/** operation 注册名（也收 command 裸名）→ 平台声明的 access 语义。 */
export type OperationSemantics = ReadonlyMap<string, AccessSemantics>;

/** access 取值 → 平台声明的语义（`accessSemantics` 顶层表原样）。 */
export type AccessSemanticsTable = ReadonlyMap<string, AccessSemantics>;

/** operation 注册名（也收 command 裸名）→ 平台声明的协议角色（proposal.create 等）。 */
export type OperationProtocols = ReadonlyMap<string, string>;

/**
 * 提案创建角色的协议列取值：平台声明的角色名，属协议常量（非模型输入嗅探），
 * 故以具名常量出现一次，比较处不再写字面量。schema 派生只认这个常量命名的行，
 * 不另持业务 operation 名单。
 */
export const PROPOSAL_CREATE_PROTOCOL = 'proposal.create';

/**
 * 发现子命令的阅读形（本文件是它在生产代码里的唯一定义处）：
 * serve-gate 的元数据组识别、错误码教学文本与 worker 提示词都引用本常量，
 * 不各自写字面量——换传输形态时这些引用随接缝一处改动自动跟上。
 */
export const CAPABILITY_DISCOVERY_COMMAND = 'operation list';

/** 发现子命令的机器面阅读形（消息提示用；与 argv 由同一阅读形派生，不维护第二份字面量）。 */
export const CAPABILITY_DISCOVERY_TEXT = `${CAPABILITY_DISCOVERY_COMMAND} --json`;

/** 发现调用的 argv（唯一构造处；由阅读形机械派生）。 */
const CAPABILITY_DISCOVERY_ARGS: readonly string[] = [...CAPABILITY_DISCOVERY_COMMAND.split(' '), '--json'];

// ── 快照类型（一次发现输出的完整类型化投影；原始值保真，卫生在派生层）──────────────────

/** 单行 args 规格的完整投影（比派生表多带全部 flag 名——协议投影的 argsSchema 要它）。 */
export interface CapabilityOperationArgs {
  readonly positionalNames: readonly string[];
  readonly flagStyles: ReadonlyMap<string, KeyArgStyle>;
  /** 全部 flag 名（含 style:none 的开关）——协议投影 argsSchema 用，派生表不用。 */
  readonly flagNames: readonly string[];
}

/** 单行 operation 的完整投影（缺列一律 null / 空，不猜不补）。 */
export interface CapabilityOperation {
  readonly name: string | null;
  readonly domain: string | null;
  readonly command: string | null;
  readonly access: string | null;
  readonly script: string | null;
  readonly effects: readonly string[];
  readonly executor: string | null;
  readonly estSeconds: number | null;
  readonly weight: number | null;
  /** args 列缺席（falsy）→ null（该行不进规格表，与旧解析同判据）。 */
  readonly args: CapabilityOperationArgs | null;
  /** serve 矩阵中值为 true 的键（`serve` 优先、`modes` 兼容旧键；两键都不猜内容）。 */
  readonly serve: readonly string[];
  /** 协议角色列原值（未过卫生）——schema 行匹配沿用旧实现的原始比较。 */
  readonly protocol: string | null;
  /** 人类可读 label 原值（未过卫生；空串按缺列处理）。 */
  readonly label: string | null;
  /** 提案 schema 列原值（只作形状卫生，不读业务字段）。 */
  readonly proposalSchema: unknown;
}

/**
 * 能力快照：一次发现输出的**完整类型化投影**。
 *
 * 权威是执行层当次声明的实时结果，宿主不复制、不另立名单（L2 单一来源）——本类型不引入
 * 任何文件读取路径，快照里没有的能力视为不存在。
 */
export interface CapabilityManifest {
  /** 逐 operation 投影（原顺序、一行不丢；各派生表自己按需过滤）。 */
  readonly operations: readonly CapabilityOperation[];
  /** 顶层 access 语义表（access 取值 → plan/confirm）。 */
  readonly accessSemantics: AccessSemanticsTable;
  /**
   * 顶层 `errorSemantics` 表（P4：码级语义声明——选择类澄清 / 终局快路径两族的码、
   * 宿主结构句与信封取值字段名）。语义与旧 loader 逐条等价：
   *   · null = 整表缺席 / 非法（未声明）→ 调用方回退宿主默认适配表；
   *   · 在场（即使空对象）= 该执行层已声明：两族都按声明（空 = 明确声明"无此族码"）；
   *   · 表内单条目非法（结构句不在宿主词汇表 / 必填字段名缺失）→ 只丢该条目（宁缺勿猜）。
   */
  readonly errorSemantics: ErrorCodeSemantics | null;
  /** 这次发现是否真的从执行层拿到（false = 未配 / CLI 失败 / 输出不可解析的降级态）。 */
  readonly discovered: boolean;
}

// ── 解析（纯函数）──────────────────────────────────────────────────────────────

/** 文档顶层 → operations 数组：裸数组 / `{operations:[…]}` 都收（信封是契约演进形状）。 */
function operationsArrayOf(document: unknown): unknown[] | null {
  if (Array.isArray(document)) return document;
  const operations = (document as { operations?: unknown } | null)?.operations;
  return Array.isArray(operations) ? operations : null;
}

/** 非空字符串或 null（旧解析的 `typeof x === 'string' && x` 判据）。 */
function nonEmptyStringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 收 flag 样式（name/code 两种有取值的；none 布尔开关没有取值可摘）。 */
function collectFlagStyles(flags: unknown): Map<string, KeyArgStyle> {
  const styles = new Map<string, KeyArgStyle>();
  if (!Array.isArray(flags)) return styles;
  for (const flag of flags) {
    const name = (flag as { flag?: unknown } | null)?.flag;
    const style = (flag as { style?: unknown } | null)?.style;
    if (typeof name !== 'string' || !name.startsWith('--')) continue;
    if (style !== 'name' && style !== 'code') continue;
    if (!styles.has(name)) styles.set(name, style);
  }
  return styles;
}

/** 收全部 flag 名（任何非空字符串，含 style:none——协议投影 argsSchema 的口径）。 */
function collectFlagNames(flags: unknown): string[] {
  if (!Array.isArray(flags)) return [];
  return flags
    .map((flag) => (flag as { flag?: unknown } | null)?.flag)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** 收位置参数名（按序，只收非空字符串）。 */
function collectPositionalNames(positional: unknown): string[] {
  if (!Array.isArray(positional)) return [];
  return positional
    .map((item) => (item as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** 单行 args 列 → 投影（args 列 falsy 时由调用方落 null，与旧解析的 `if (!args) continue` 同判据）。 */
function operationArgsOf(raw: unknown): CapabilityOperationArgs | null {
  if (!raw) return null;
  const args = raw as { positional?: unknown; flags?: unknown };
  return {
    positionalNames: collectPositionalNames(args.positional),
    flagStyles: collectFlagStyles(args.flags),
    flagNames: collectFlagNames(args.flags),
  };
}

/**
 * serve 矩阵：`serve` 键优先、缺失时读兼容键 `modes`（2026-11-12 跨仓实测的形状漂移），
 * 取值为 true 的键（原序）。两键并存时只读 `serve`，不静默合并（没有平台契约文档前不引入
 * 合并语义——两键内容不同属平台异常，不猜）。
 */
function serveMatrixOf(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, value]) => value === true)
    .map(([mode]) => mode);
}

/** 单行 operation 原始对象 → 投影（缺字段一律 null / 空，不猜、不补）。 */
function operationOf(raw: unknown): CapabilityOperation {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const serve = row['serve'] ?? row['modes'];
  const estSeconds = row['est_seconds'];
  const weight = row['weight'];
  return {
    name: nonEmptyStringOf(row['name']),
    domain: nonEmptyStringOf(row['domain']),
    command: nonEmptyStringOf(row['command']),
    access: nonEmptyStringOf(row['access']),
    script: nonEmptyStringOf(row['script']),
    effects: Array.isArray(row['effects'])
      ? row['effects'].filter((effect): effect is string => typeof effect === 'string')
      : [],
    executor: nonEmptyStringOf(row['executor']),
    estSeconds: typeof estSeconds === 'number' ? estSeconds : null,
    weight: typeof weight === 'number' ? weight : null,
    args: operationArgsOf(row['args']),
    serve: serveMatrixOf(serve),
    protocol: typeof row['protocol'] === 'string' ? row['protocol'] : null,
    label: nonEmptyStringOf(row['label']),
    proposalSchema: row['proposalSchema'],
  };
}

/** 顶层 `accessSemantics` 表 → access → 语义（缺列 / 非布尔一律 false，宁缺勿猜）。 */
function accessSemanticsTableOf(document: unknown): AccessSemanticsTable {
  const table: Map<string, AccessSemantics> = new Map();
  const raw = Array.isArray(document) ? undefined : (document as { accessSemantics?: unknown } | null)?.accessSemantics;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return table;
  for (const [access, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!access || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    table.set(access, { plan: row['plan'] === true, confirm: row['confirm'] === true });
  }
  return table;
}

// ── 码级语义（`operation list --json` 顶层 `errorSemantics`；P4 声明面并入快照）──────────
//
// 与 accessSemantics 同一文档、同一 family 的执行层声明面：执行层声明"我的哪些错误码
// 属于选择类澄清族 / 终局快路径族、各用宿主哪条结构句、渲染数据在信封 data 的哪些字段
// 里"。解析语义与 P4 的 loadErrorCodeSemantics/parseErrorCodeSemantics 逐条等价
// （operation-labels 的门面经本模块派生；锁见 error-code-semantics.test.ts 与
// capability-source.test.ts 的等价用例）：
//   · 表缺席 / 非法 → null：调用方回退宿主默认适配表（未声明执行层的现行为逐字节不变）；
//   · 表在场（即使为空对象）→ 该执行层已声明：两族都按声明（空 = 明确声明"无此族码"）；
//   · 表内单条目：结构句名不在宿主词汇表内 / 必填字段名缺失 → 该条目不进表（宁缺勿猜）。

/** 选择类结构句名（宿主封闭词汇表；具名常量，比较处不写字面量——与 PROPOSAL_CREATE_PROTOCOL 同规）。 */
const SELECTION_RENDER_CANDIDATES = 'candidates' as const;
const SELECTION_RENDER_CONFIRM_NAME_WITH_HINT = 'confirm-name-with-hint' as const;
/** 终局结构句名（同上）。 */
const TERMINAL_RENDER_SCOPE_NO_DATA = 'scope-no-data' as const;
const TERMINAL_RENDER_CONFIRM_NAME = 'confirm-name' as const;

const SELECTION_RENDER_KINDS: ReadonlySet<string> = new Set<SelectionRenderKind>([
  SELECTION_RENDER_CANDIDATES,
  SELECTION_RENDER_CONFIRM_NAME_WITH_HINT,
]);

/** 选择类结构句名判定（宿主封闭词汇表，声明只引用不扩展）。 */
function selectionRenderKindOf(value: unknown): SelectionRenderKind | undefined {
  return typeof value === 'string' && SELECTION_RENDER_KINDS.has(value) ? (value as SelectionRenderKind) : undefined;
}

/** 声明里的信封字段名：非空字符串才收（空/非字符串 = 该条目不生效，不猜字段）。 */
function fieldNameOf(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length > 0 ? name : undefined;
}

/** 终局码声明条目：按 render 形状机械校验所需字段名；缺任一必填字段 = 条目不进表。 */
function terminalSemanticsOf(entry: unknown): TerminalCodeSemantics | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const row = entry as { render?: unknown; query?: unknown; scope?: unknown; available?: unknown };
  const render = typeof row.render === 'string' ? row.render : '';
  const query = fieldNameOf(row.query);
  if (render === TERMINAL_RENDER_SCOPE_NO_DATA) {
    const scope = fieldNameOf(row.scope);
    const available = fieldNameOf(row.available);
    if (!query || !scope || !available) return undefined;
    return { render: TERMINAL_RENDER_SCOPE_NO_DATA, query, scope, available };
  }
  if (render === TERMINAL_RENDER_CONFIRM_NAME) {
    if (!query) return undefined;
    return { render: TERMINAL_RENDER_CONFIRM_NAME, query };
  }
  return undefined;
}

/**
 * 顶层 `errorSemantics` 表 → 码级语义（纯函数）。
 *
 * 返回 null = 整张表缺席 / 顶层非法 → 调用方按"未声明"处理（回退宿主默认适配表）。
 * 返回表 = 执行层已声明；空表 = 声明"两族均无码"。单条目非法只丢该条目，不影响整表。
 */
function errorSemanticsTableOf(document: unknown): ErrorCodeSemantics | null {
  const raw = Array.isArray(document) ? undefined : (document as { errorSemantics?: unknown } | null)?.errorSemantics;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const table = raw as { selection?: unknown; terminal?: unknown };
  const selection = new Map<string, SelectionRenderKind>();
  if (table.selection && typeof table.selection === 'object' && !Array.isArray(table.selection)) {
    for (const [code, entry] of Object.entries(table.selection as Record<string, unknown>)) {
      const render = selectionRenderKindOf((entry as { render?: unknown } | null)?.render);
      if (code && render) selection.set(code, render);
    }
  }
  const terminal = new Map<string, TerminalCodeSemantics>();
  if (table.terminal && typeof table.terminal === 'object' && !Array.isArray(table.terminal)) {
    for (const [code, entry] of Object.entries(table.terminal as Record<string, unknown>)) {
      const declared = terminalSemanticsOf(entry);
      if (code && declared) terminal.set(code, declared);
    }
  }
  return { selection, terminal };
}

/**
 * 一次发现输出的文档文本 → 能力快照（纯函数）。
 *
 * 宽容形状与旧解析同一判据：解析失败 / 顶层不是数组也不是 `{operations:[…]}` → null
 * （与旧版同一套安全缺省 = 空表）；单行缺字段 → 该字段落 null / 空（不猜、不补）。
 */
export function parseCapabilityManifest(stdout: string): CapabilityManifest | null {
  let document: unknown;
  try { document = JSON.parse(stdout); } catch { return null; }
  const operations = operationsArrayOf(document);
  if (!operations) return null;
  return {
    operations: operations.map(operationOf),
    accessSemantics: accessSemanticsTableOf(document),
    errorSemantics: errorSemanticsTableOf(document),
    discovered: true,
  };
}

/**
 * 文档文本 → 顶层 access 语义表（纯函数；**不要求** operations 数组在场）。
 *
 * 旧 `parseAccessSemantics` 就是这个口径：语义表是顶层独立数据面，即使文档没有清单
 * 数组（过渡期形状）也照读；解析失败 / 表缺失 / 非对象一律空表（安全缺省）。
 */
export function parseAccessSemanticsTable(stdout: string): AccessSemanticsTable {
  let document: unknown;
  try { document = JSON.parse(stdout); } catch { return new Map(); }
  return accessSemanticsTableOf(document);
}

/** 降级快照：未配 / CLI 失败 / 输出不可解析（discovered=false，各派生表随之空）。 */
export function failedCapabilityManifest(): CapabilityManifest {
  return { operations: [], accessSemantics: new Map(), errorSemantics: null, discovered: false };
}

/** 空快照（测试 / eval 注入用；discovered=true = 真的发现过、结果确实是空清单）。 */
export function emptyCapabilityManifest(): CapabilityManifest {
  return { operations: [], accessSemantics: new Map(), errorSemantics: null, discovered: true };
}

// ── 七张派生表 + 协议投影（纯函数；本模块是唯一实现）──────────────────────────────────

/** label 卫生：剥控制字符 / 换行、折叠空白、截断（进度帧是短句，不是长文）。 */
export function sanitizeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** 角色名卫生：剥控制字符、折叠空白、截断（角色名是短标识，不是长文）。 */
export function sanitizeProtocol(value: string): string | undefined {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return text || undefined;
}

/** 快照 → 查表键：注册名与 command 裸名两种写法都收录（命令里两种都合法）。 */
function keysOf(operation: CapabilityOperation): Array<string | null> {
  return [operation.name, operation.command];
}

/**
 * 快照 → label 表（进度帧业务措辞的唯一来源）。
 *
 * label 缺失 / 空（旧版执行层没给这一列）→ 该行不进表 → 没有帧。这正是安全缺省：
 * 没有人类可读名就不发帧，绝不回退显示脚本名或操作名。键序与旧 TSV 解析同口径
 * （command 在前、name 在后，后写覆盖先写）。
 */
export function labelsOf(manifest: CapabilityManifest): OperationLabels {
  const labels: OperationLabels = new Map();
  for (const operation of manifest.operations) {
    const label = sanitizeLabel(operation.label ?? '');
    if (!label) continue;
    for (const key of [operation.command, operation.name]) {
      if (key) labels.set(key, label);
    }
  }
  return labels;
}

/**
 * 快照 → 整份 args 规格。键同时收注册名与 command 裸名（命令里两种写法都合法）；
 * args 列缺席的行不进表（该行没有可机械取值的声明面）。
 */
export function argSpecsOf(manifest: CapabilityManifest): OperationArgsSpecs {
  const specs: Map<string, OperationArgsSpec> = new Map();
  for (const operation of manifest.operations) {
    if (!operation.args) continue;
    // 表的口径只有两列（位置参数名 + flag 样式）：投影对象比快照行窄（不带 flagNames），
    // 与旧解析构造新对象的形状逐一相同；同一行的两个键共享同一个对象。
    const spec: OperationArgsSpec = {
      positionalNames: operation.args.positionalNames,
      flagStyles: operation.args.flagStyles,
    };
    for (const key of keysOf(operation)) {
      if (key && !specs.has(key)) specs.set(key, spec);
    }
  }
  return specs;
}

/**
 * 快照 → 全局 flag→样式表（参数摘要的消费面）。
 *
 * 同一 flag 在多个 operation 里样式一致（执行层规格纪律）；万一不一致，先登记者生效——
 * 取"先"而不是"后"是为了让表只依赖输入顺序确定，不靠"最后一个覆盖"的隐式规则。
 */
export function argStylesOf(manifest: CapabilityManifest): KeyArgStyles {
  const styles = new Map<string, KeyArgStyle>();
  for (const spec of argSpecsOf(manifest).values()) {
    for (const [flag, style] of spec.flagStyles) {
      if (!styles.has(flag)) styles.set(flag, style);
    }
  }
  return styles;
}

/** 快照 → 顶层 access 语义表（access 取值 → plan/confirm 原样投影）。 */
export function accessSemanticsOf(manifest: CapabilityManifest): AccessSemanticsTable {
  return manifest.accessSemantics;
}

/**
 * 快照 → 执行层声明的码级语义表（`errorSemantics` 的宿主投影；P4 声明面并入快照）。
 *
 * 返回 null = 该执行层**未声明**（表缺席 / 非法 / 该次发现降级）→ 调用方回退宿主默认
 * 适配表（DEFAULT_ERROR_CODE_SEMANTICS，既有已适配实例现行为逐字节不变）；返回表 =
 * 已声明（空表 = 明确声明"两族均无码"，绝不混入默认表）。
 *
 * 等价说明：dummy 夹具（e2e 的未声明执行层）两侧都是 null 路径——P4 的
 * loadErrorCodeSemantics 失败/缺席语义与本派生在全输入上逐条一致（锁见
 * error-code-semantics.test.ts 的 parse/load 用例 + capability-source.test.ts 的等价用例）。
 * 唯一形状差异：顶层没有清单数组、只有 errorSemantics 的文档在本模块是整体解析失败
 * （快照为 null）——发现子命令的真实输出恒有清单数组，该形状不在声明面里。
 */
export function errorSemanticsOf(manifest: CapabilityManifest): ErrorCodeSemantics | null {
  return manifest.errorSemantics;
}

/**
 * 快照 → operation → 语义表。两个数据面的机械连接，没有一步是宿主判断：
 *   ① operation 的 access 列（连接键）；② 顶层 access 语义表。
 * access 缺失 / 语义表里查不到该 access → 该行不进表（宁缺勿猜）。
 */
export function operationSemanticsOf(manifest: CapabilityManifest): OperationSemantics {
  const semantics: Map<string, AccessSemantics> = new Map();
  if (manifest.accessSemantics.size === 0) return semantics;
  for (const operation of manifest.operations) {
    if (!operation.access) continue;
    const entry = manifest.accessSemantics.get(operation.access);
    if (!entry) continue;
    for (const key of keysOf(operation)) {
      if (key && !semantics.has(key)) semantics.set(key, entry);
    }
  }
  return semantics;
}

/** 快照 → operation → 协议角色表（角色名过卫生；缺列 / 空值不进表）。 */
export function operationProtocolsOf(manifest: CapabilityManifest): OperationProtocols {
  const protocols: Map<string, string> = new Map();
  for (const operation of manifest.operations) {
    const protocol = operation.protocol === null ? undefined : sanitizeProtocol(operation.protocol);
    if (!protocol) continue;
    for (const key of keysOf(operation)) {
      if (key && !protocols.has(key)) protocols.set(key, protocol);
    }
  }
  return protocols;
}

/**
 * 快照 → 提案 schema（形状卫生，不读业务字段）。
 *
 * 只认第一个声明提案创建角色的行（原始比较，与旧实现同判据）：schema 不是非空普通对象
 * → null = schema 未下发，调用方按 fail-closed 处理（提案创建直接失败，不降级）。
 */
export function proposalSchemaOf(manifest: CapabilityManifest): unknown | null {
  for (const operation of manifest.operations) {
    if (operation.protocol !== PROPOSAL_CREATE_PROTOCOL) continue;
    const schema = operation.proposalSchema;
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema;
    return null;
  }
  return null;
}

/**
 * 快照 → 协议投影（contracts 的 `CapabilityManifest`：能力语义，不带动适配器字段）。
 *
 *   · requiresPlan 从 access 语义表的 plan 列机械推导（查不到 → true：宁严勿松）；
 *   · estSeconds / label / effects / serve 矩阵原样投影（开放词表，宿主不解释）；
 *   · 缺声明名的行不进清单（协议投影要求 operation 注册名）。
 */
export function protocolManifestOf(manifest: CapabilityManifest): ProtocolCapabilityManifest {
  const declarations: OperationDeclaration[] = [];
  for (const operation of manifest.operations) {
    if (!operation.name) continue;
    const semantics = operation.access ? manifest.accessSemantics.get(operation.access) : undefined;
    const argsSchema: string[] = operation.args
      ? [...operation.args.positionalNames, ...operation.args.flagNames]
      : [];
    declarations.push({
      operation: operation.name,
      requiresPlan: semantics ? semantics.plan : true,
      effects: operation.effects,
      estSeconds: operation.estSeconds,
      label: operation.label,
      serveMatrix: operation.serve,
      argsSchema: argsSchema.length > 0 ? argsSchema : undefined,
    });
  }
  return { version: A2A_PROTOCOL_VERSION, operations: declarations };
}

// ── 测试 / eval 注入：手搓快照（不必造执行层 CLI）────────────────────────────────────

/** 内存快照的单行输入（只写关心的字段，其余取中性缺省）。 */
export interface CapabilityOperationInit {
  readonly name: string;
  readonly domain?: string;
  readonly command?: string;
  readonly access?: string;
  readonly script?: string;
  readonly effects?: readonly string[];
  readonly executor?: string;
  readonly estSeconds?: number | null;
  readonly weight?: number | null;
  readonly args?: {
    readonly positionalNames?: readonly string[];
    readonly flags?: readonly { readonly flag: string; readonly style?: string }[];
  };
  readonly serve?: readonly string[];
  readonly protocol?: string;
  readonly label?: string;
  readonly proposalSchema?: unknown;
}

/** 内存快照的 access 语义输入（只写关心的列，缺列按 false）。 */
export type AccessSemanticsInit = Readonly<Record<string, { readonly plan?: unknown; readonly confirm?: unknown }>>;

/**
 * 手搓快照：测试 / eval 注入用（与解析产物同形，discovered=true）。
 *
 * errorSemantics 与解析口径同判据：缺省 = 未声明（null → 调用方回退默认适配表）；
 * 显式传入（即使空表）= 已声明。注入的是**已解析**的码级语义（与注入 accessSemantics
 * 同族——手搓快照不重演解析面，解析面由 parse 用例单独钉）。
 */
export function capabilityManifestOf(
  operations: readonly CapabilityOperationInit[],
  accessSemantics: AccessSemanticsInit = {},
  errorSemantics: ErrorCodeSemantics | null = null,
): CapabilityManifest {
  const table: Map<string, AccessSemantics> = new Map();
  for (const [access, value] of Object.entries(accessSemantics)) {
    if (!access || !value) continue;
    table.set(access, { plan: value.plan === true, confirm: value.confirm === true });
  }
  return {
    operations: operations.map((operation) => ({
      name: operation.name,
      domain: operation.domain ?? null,
      command: operation.command ?? null,
      access: operation.access ?? null,
      script: operation.script ?? null,
      effects: operation.effects ?? [],
      executor: operation.executor ?? null,
      estSeconds: operation.estSeconds ?? null,
      weight: operation.weight ?? null,
      args: operation.args
        ? {
            positionalNames: operation.args.positionalNames ?? [],
            flagStyles: collectFlagStyles(operation.args.flags),
            flagNames: collectFlagNames(operation.args.flags),
          }
        : null,
      serve: operation.serve ?? [],
      protocol: operation.protocol ?? null,
      label: operation.label ?? null,
      proposalSchema: operation.proposalSchema ?? null,
    })),
    accessSemantics: table,
    errorSemantics,
    discovered: true,
  };
}

// ── 传输接口与两个实现 ──────────────────────────────────────────────────────────

/**
 * 能力发现源（传输接缝）：generic 代码只依赖本接口。
 * 约定：`load()` 不做缓存——一次调用 = 一次发现；失败也必须 resolve（降级快照），
 * 派生是增强不是前提，绝不 reject。
 */
export interface CapabilitySource {
  load(): Promise<CapabilityManifest>;
}

/** 一次发现调用的参数（runner 注入点：审计 / 计数 / 替身都经这里）。 */
export interface CapabilityCliCall {
  readonly platformRoot: string;
  readonly gateway?: string;
  /** 解析出的网关可执行路径（gatewayExecPath；未声明网关时根本不会走到 runner）。 */
  readonly cli: string;
  /** 发现子命令的 argv（本模块是唯一构造处）。 */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

/** 发现调用执行器：缺省真 spawn；测试可注入计数 / 替身 runner。 */
export type CapabilityCliRunner = (call: CapabilityCliCall) => Promise<{ readonly code: number | null; readonly stdout: string }>;

/** CLI 派生超时：执行层起不来时不能拖住 worker 的第一条命令（沿用旧 loader 的 3s）。 */
export const CAPABILITY_CLI_TIMEOUT_MS = 3_000;

/** 缺省 runner：spawn 网关一次、收 stdout、超时 kill（退出码 / 错误语义与旧 loader 一致）。 */
function defaultCapabilityCliRunner(call: CapabilityCliCall): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { code: number | null; stdout: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(call.cli, [...call.args], {
        cwd: call.cwd,
        // 宿主机密族与宿主内部指针不进执行层子进程（与旧 loader 同尺）。
        env: call.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle({ code: null, stdout: '' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle({ code: null, stdout: '' });
    }, call.timeoutMs);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle({ code: null, stdout: '' }); });
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      settle({ code, stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });
}

export interface CliCapabilitySourceOptions {
  /** 平台根（缺省 = 未配：直接降级，不 spawn）。 */
  platformRoot?: string;
  /** Profile 声明的网关调用形式；未声明 / 非法 = 降级空表（绝不回退遗留网关名）。 */
  gateway?: string;
  /** 测试注入点：缺省真 spawn。 */
  runner?: CapabilityCliRunner;
  /** 缺省 CAPABILITY_CLI_TIMEOUT_MS。 */
  timeoutMs?: number;
}

/**
 * CLI 传输实现：一次 `load()` = 一次 spawn 发现子命令 + 解析一次。
 *
 * 失败语义（沿用旧 loader）：platformRoot 未配、网关未声明/非法、CLI 不存在/不可执行、
 * 超时、非零退出、输出不是 JSON、没有清单数组——一律 resolve `discovered=false` 的降级
 * 快照；派生是增强，不是前提。
 */
export class CliCapabilitySource implements CapabilitySource {
  constructor(private readonly options: CliCapabilitySourceOptions) {}

  async load(): Promise<CapabilityManifest> {
    const { platformRoot, gateway } = this.options;
    if (!platformRoot) return failedCapabilityManifest();
    if (!validateGatewayInvocation(gateway)) return failedCapabilityManifest();
    const cli = gatewayExecPath(platformRoot, gateway);
    const runner = this.options.runner ?? defaultCapabilityCliRunner;
    const result = await runner({
      platformRoot,
      gateway,
      cli,
      args: [...CAPABILITY_DISCOVERY_ARGS],
      cwd: platformRoot,
      env: hostDirectChildEnv(),
      timeoutMs: this.options.timeoutMs ?? CAPABILITY_CLI_TIMEOUT_MS,
    });
    if (result.code !== 0) return failedCapabilityManifest();
    return parseCapabilityManifest(result.stdout) ?? failedCapabilityManifest();
  }
}

/**
 * 记忆实现（测试 / eval 注入）：装载后进程内不变。
 * 与 CLI 实现同语义：load 一定 resolve；失败态（discovered=false）由调用方自己造。
 */
export class MemoryCapabilitySource implements CapabilitySource {
  constructor(private readonly manifest: CapabilityManifest) {}

  async load(): Promise<CapabilityManifest> {
    return this.manifest;
  }
}

/** 一次性发现（CLI 源 + 单次 load）：`load*` 门面与跨根回退共用同一实现。 */
export function loadCapabilityManifestSnapshot(platformRoot?: string, gateway?: string): Promise<CapabilityManifest> {
  return new CliCapabilitySource({
    ...(platformRoot ? { platformRoot } : {}),
    ...(gateway ? { gateway } : {}),
  }).load();
}
