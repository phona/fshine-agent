/**
 * 能力目录：单一来源 + 派生（判据档 docs/architecture/capability-boundary.md §2）。
 *
 * 柜台（Main）能向用户罗列的范围**只有一个事实源 = 执行层的 operation 声明**。本模块按
 * 执行层自述的 `capability` 分组，派生给 Main 的目录条目 = 业务名 + 只读/可写。
 *
 * 硬纪律：
 *   · 目录**完全派生**，没有任何手写业务名常量表（禁令 3）；空清单 → 空目录。
 *   · 只读/可写复用既有 access 判据（`access === 'read'` / `access === 'write'`，与
 *     dummy-cli-client 的 readOnlyOperationNames/writeOperationNames 同一把尺），**不重造
 *     第二套读写判据**。
 *   · 同域的 query/prepare/commit 共享一个 capability 值 → 合并为一个条目，read/write 取并集。
 *
 * 本模块不含任何业务语义：输入只取声明的窄结构（name/capability/access）。
 */

/** 派生的最小声明形状（契约 ExecutionOperationDeclaration 的窄投影；避免依赖适配器面）。 */
export interface CatalogDeclaration {
  readonly name: string;
  readonly capability?: string;
  readonly access?: string;
}

/** 派生给 Main 的一条能力目录条目：只有业务名与读/写，绝不含 operation 名或参数名。 */
export interface CapabilityEntry {
  /** 业务能力名（来自执行层 capability 声明）。 */
  readonly name: string;
  /** 该能力是否有只读办理动作（access === 'read'）。 */
  readonly read: boolean;
  /** 该能力是否有写入办理动作（access === 'write'）。 */
  readonly write: boolean;
}

/** 既有读写判据的同一把尺（与 dummy-cli-client 的派生函数逐字一致）：只读只看 read、写只看 write。 */
const isReadOnly = (access: string | undefined): boolean => access === 'read';
const isWrite = (access: string | undefined): boolean => access === 'write';

/**
 * 按 `capability` 分组派生能力目录。
 *
 *   · 未声明/空白 `capability` 的 operation 被跳过（退化为「未声明」，不伪造目录项）；
 *   · read/write 取同 capability 下所有声明 access 判据的并集。
 *   · 条目顺序 = 首次出现顺序（稳定、可复现）。
 */
export function deriveCapabilityCatalog(operations: readonly CatalogDeclaration[]): CapabilityEntry[] {
  const entries = new Map<string, { name: string; read: boolean; write: boolean }>();
  for (const operation of operations) {
    const capability = operation.capability;
    if (typeof capability !== 'string' || capability.trim() === '') continue;
    let entry = entries.get(capability);
    if (entry === undefined) {
      entry = { name: capability, read: false, write: false };
      entries.set(capability, entry);
    }
    if (isReadOnly(operation.access)) entry.read = true;
    if (isWrite(operation.access)) entry.write = true;
  }
  return [...entries.values()].map((entry) => ({ name: entry.name, read: entry.read, write: entry.write }));
}

/**
 * 把目录编译成一句**极短摘要**（常驻进 Main 的协议文本）。
 *
 * 只含业务名与读/写标记：只读 → `记录核对`；读写都有 → `记录办理（含写入）`；
 * 仅写入 → `长时导出（写入）`。目录为空 → 返回空串（调用方据此完全不追加）。
 */
export function renderCapabilitySummary(entries: readonly CapabilityEntry[]): string {
  if (entries.length === 0) return '';
  const parts = entries.map((entry) => {
    if (entry.read && entry.write) return `${entry.name}（含写入）`;
    if (entry.write) return `${entry.name}（写入）`;
    return entry.name;
  });
  return `可办：${parts.join('、')}`;
}
