/**
 * 平台操作的人类可读名（label）、参数规格（args spec）、访问语义（access semantics）与
 * 协议角色（protocol）派生层的**门面**。
 *
 * 发现与解析的唯一实现已收进 capability-source.ts（「关进笼子」：一次发现、一份快照、
 * 一个接缝）。本模块只保留两类东西：
 *
 *   · `parse*`：旧入口的纯函数门面（测试在用；行为逐字段等价）——stdout 文本过接缝的
 *     `parseCapabilityManifest` 成快照，再由快照的派生函数出表；TSV 第 5 列的解析器
 *     是独立的历史入口（label 的旧载体），原样保留；
 *   · `load*`：CLI 派生门面（测试 / 脚本在用）——每次调用 = 一次发现（走接缝的唯一
 *     spawn 点），失败语义与旧实现一致：一律降级空表 / null，绝不 reject。
 *
 * 生产装配不再逐表派生：apps/server/assembly.ts 在 boot 期经 `CapabilitySource` 加载
 * **一次**快照，七张派生表全部由它纯函数派生后注入（换传输只改接缝一处；grep 绊线见
 * capability-source.test.ts）。
 *
 * 输出契约（执行层清单的 label 载体）：JSON 文档每行的 `label` 列（旧版 TSV 第 5 列
 * 与之同值，等价性由 capability-source.test.ts 的冻结金样钉住）。缺失或为空
 * （旧版执行层 / 没给这个操作起名）→ 该操作不进表 → 没有帧。这正是安全缺省：没有人类
 * 可读名就不发帧，绝不回退显示脚本名或操作名。
 */
import type { CapabilityManifest } from '@fshine/contracts';
import {
  argSpecsOf,
  argStylesOf,
  labelsOf,
  loadCapabilityManifestSnapshot,
  operationProtocolsOf,
  operationSemanticsOf,
  parseAccessSemanticsTable,
  parseCapabilityManifest as parseCapabilitySnapshot,
  proposalSchemaOf,
  protocolManifestOf,
  sanitizeLabel,
  PROPOSAL_CREATE_PROTOCOL,
  type AccessSemantics,
  type AccessSemanticsTable,
  type KeyArgStyle,
  type KeyArgStyles,
  type OperationArgsSpec,
  type OperationArgsSpecs,
  type OperationLabels,
  type OperationProtocols,
  type OperationSemantics,
} from './capability-source';

export type {
  AccessSemantics,
  AccessSemanticsTable,
  KeyArgStyle,
  KeyArgStyles,
  OperationArgsSpec,
  OperationArgsSpecs,
  OperationLabels,
  OperationProtocols,
  OperationSemantics,
};
// 协议投影类型（contracts）：历史上从本模块再导出，调用方导入路径不变。
export type { CapabilityManifest };
export { PROPOSAL_CREATE_PROTOCOL };

// ── TSV 载体（label 的历史入口；测试在用）────────────────────────────────────────

/**
 * 解析 TSV 清单输出的第 1/2/5 列（name/command/label），只收 label 非空的条目。
 * 行数不足 5 列（旧版执行层）整行跳过。宿主发现面已改走 JSON 快照，本解析器保留为
 * label 旧载体的对照尺（等价性金样用它交叉核对）。
 */
export function parseOperationLabels(stdout: string): OperationLabels {
  const labels: OperationLabels = new Map();
  for (const line of stdout.split('\n')) {
    const columns = line.split('\t');
    if (columns.length < 5) continue;
    const label = sanitizeLabel(columns[4] ?? '');
    if (!label) continue;
    for (const key of [columns[1], columns[0]]) {
      const normalized = (key ?? '').trim();
      if (normalized) labels.set(normalized, label);
    }
  }
  return labels;
}

// ── 纯函数门面：stdout → 快照 → 表（唯一实现在 capability-source.ts）─────────────────

/** 整份 args 规格（位置参数声明名 + flag 样式）。 */
export function parseOperationArgSpecs(stdout: string): OperationArgsSpecs {
  const manifest = parseCapabilitySnapshot(stdout);
  return manifest ? argSpecsOf(manifest) : new Map();
}

/** 全局 flag→样式表（参数摘要的消费面）。 */
export function parseOperationArgStyles(stdout: string): KeyArgStyles {
  const manifest = parseCapabilitySnapshot(stdout);
  return manifest ? argStylesOf(manifest) : new Map();
}

/**
 * 顶层 access 语义表（access 取值 → plan/confirm）。语义表是顶层独立数据面：
 * 文档没有清单数组（过渡期形状）也照读——沿用旧实现口径。
 */
export function parseAccessSemantics(stdout: string): AccessSemanticsTable {
  return parseAccessSemanticsTable(stdout);
}

/** operation（注册名 + command 裸名）→ 平台声明的 access 语义。 */
export function parseOperationSemantics(stdout: string): OperationSemantics {
  const manifest = parseCapabilitySnapshot(stdout);
  return manifest ? operationSemanticsOf(manifest) : new Map();
}

/** operation → 协议角色（proposal.create 等）。 */
export function parseOperationProtocols(stdout: string): OperationProtocols {
  const manifest = parseCapabilitySnapshot(stdout);
  return manifest ? operationProtocolsOf(manifest) : new Map();
}

/**
 * 提案创建行的 proposalSchema 列。缺列 / 非对象 / 数组一律返回 null = schema 未下发，
 * 调用方按 fail-closed 处理（提案创建直接失败，不降级）。
 */
export function parseProposalSchema(stdout: string): unknown | null {
  const manifest = parseCapabilitySnapshot(stdout);
  return manifest ? proposalSchemaOf(manifest) : null;
}

/**
 * 清单文档 → 协议投影（contracts 的 CapabilityManifest：能力语义）。
 *
 * 派生规则（与各表同族安全缺省）：解析失败 / 非 JSON / 没有 operations 数组 → null；
 * 单行缺声明名 → 该行不进清单（不猜、不补）；requiresPlan 从 access 语义表的 plan 列
 * 机械推导；serveMatrix 从 serve（或兼容键 modes）对象提取值为 true 的键；
 * est_seconds 字段不存在时按 null 处理。
 */
export function parseCapabilityManifest(stdout: string): CapabilityManifest | null {
  const manifest = parseCapabilitySnapshot(stdout);
  return manifest ? protocolManifestOf(manifest) : null;
}

/**
 * 执行模式词汇：协议清单每行 serve 矩阵值为 true 的键的并集。
 *
 * 为什么由平台数据派生：宿主不得另立第二份 mode 名单（L2）。serve-gate 的形态识别与
 * 驱动层对账都拿这份词汇判"某个 mode 属不属于执行形态"——平台加/改自己的 mode 时宿主
 * 自动看得见，不需要改门里的字面量。清单缺失 / 没声明任何 serve 键 → 空集 = 判据不成立：
 * 调用方按缺省处理（serve-gate 退回契约兜底词汇），词汇外的形态一律 fail-closed。
 */
export function serveModesOf(manifest: CapabilityManifest | null | undefined): ReadonlySet<string> {
  const modes = new Set<string>();
  for (const declaration of manifest?.operations ?? []) {
    for (const mode of declaration.serveMatrix ?? []) {
      if (mode) modes.add(mode);
    }
  }
  return modes;
}

// ── CLI 门面（每次调用 = 一次发现；失败一律降级）──────────────────────────────────

/** 经执行层发现面派生 label 表；任何失败 → 空表（派生是增强，不是前提）。 */
export function loadOperationLabels(platformRoot?: string, gateway?: string): Promise<OperationLabels> {
  return loadCapabilityManifestSnapshot(platformRoot, gateway).then((manifest) => labelsOf(manifest));
}

/** 经执行层发现面派生 flag 样式表；任何失败 → 空表（与 label 派生同一套失败语义）。 */
export function loadOperationArgStyles(platformRoot?: string, gateway?: string): Promise<KeyArgStyles> {
  return loadCapabilityManifestSnapshot(platformRoot, gateway).then((manifest) => argStylesOf(manifest));
}

/** 经执行层发现面派生整份 args 规格；任何失败 → 空表（宁缺勿猜，绝不用硬编码位置猜）。 */
export function loadOperationArgSpecs(platformRoot?: string, gateway?: string): Promise<OperationArgsSpecs> {
  return loadCapabilityManifestSnapshot(platformRoot, gateway).then((manifest) => argSpecsOf(manifest));
}

/**
 * 经执行层发现面派生 operation → 语义表；任何失败 / 平台还没下发 accessSemantics
 * → 空表：没有语义表就不做写类判定（平台门禁照旧兜底），绝不用宿主硬编码
 * operation 名单或 access 词表顶替（那违反 L2：宿主另立一份名单/词表即分叉）。
 */
export function loadOperationSemantics(platformRoot?: string, gateway?: string): Promise<OperationSemantics> {
  return loadCapabilityManifestSnapshot(platformRoot, gateway).then((manifest) => operationSemanticsOf(manifest));
}

/** 经执行层发现面派生 protocol 角色表；任何失败 → 空表（不识别提案创建调用，门与平台照旧兜底）。 */
export function loadOperationProtocols(platformRoot?: string, gateway?: string): Promise<OperationProtocols> {
  return loadCapabilityManifestSnapshot(platformRoot, gateway).then((manifest) => operationProtocolsOf(manifest));
}

/**
 * 经执行层发现面取问提案 schema。失败语义与 loadOperationProtocols 一致，只是返回值不同：
 * 平台未配、CLI 失败、超时、非 JSON、行里无 schema——一律返回 null，调用方（提案创建
 * 路径）按 fail-closed 处理，绝不以 null schema 继续复核。
 */
export function loadProposalSchema(platformRoot?: string, gateway?: string): Promise<unknown | null> {
  return loadCapabilityManifestSnapshot(platformRoot, gateway).then((manifest) => proposalSchemaOf(manifest));
}

// ── 查表工具（纯函数，调用方持表注入）──────────────────────────────────────────────

/**
 * 该 operation 是否属写类——判据只有一列：平台声明的 `confirm`（要不要用户确认）。
 *
 * 拿不到语义（缺表 / 该 operation 未登记）→ false：fail-closed 到什么都不算写，
 * 与 label/规格缺失同纪律——不触发布防，交给平台门禁既有路径。
 */
export function isWriteAccess(semantics: AccessSemantics | undefined): boolean {
  return semantics?.confirm === true;
}

/**
 * 命令里的 script 引用 → label。引用有三种合法写法（操作名/裸名/脚本路径），
 * 归一成同一个键后查表；表里没有就返回 undefined，调用方据此决定静默不发帧。
 */
export function operationLabel(labels: OperationLabels | undefined, script: string | null | undefined): string | undefined {
  if (!labels || labels.size === 0 || !script) return undefined;
  return labels.get(operationReferenceKey(script));
}

/**
 * 引用归一：取末段 → 去脚本后缀 → 去域前缀（voucher.query-saved → query-saved）。
 *
 * 导出只为一把尺子量所有查表面：label、args 规格、access 语义三张表的键都是
 * "注册名 + command 裸名"，而命令里引用一个 operation 有注册名 / 裸名 / 脚本路径
 * 三种合法写法。归一只此一份——在调用方各写一遍就是第二套命令解析，必然分叉。
 */
export function operationReferenceKey(reference: string): string {
  const base = reference.split(/[/\\]/).pop() ?? reference;
  const bare = base.replace(/\.(?:js|py)$/i, '');
  const dot = bare.indexOf('.');
  return dot > 0 ? bare.slice(dot + 1) : bare;
}
