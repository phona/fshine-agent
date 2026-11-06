/**
 * 平台操作的人类可读名（label）、参数规格（args spec）、访问语义（access semantics）与
 * 协议角色（protocol）派生层。
 *
 * 进度帧里的业务措辞只有一个来源：平台公共 CLI 的 `operation list` 子命令
 * TSV 输出第 5 列。fshine 不维护业务词表，也不认识任何具体操作——label 是
 * 平台数据，经本模块读进来后只做查表。
 *
 * 输出契约（平台侧新增的第 5 列，已实测在线）：
 *   name <TAB> script <TAB> access <TAB> executor <TAB> label
 * 第 5 列缺失或为空（旧版平台 / 平台没给这个操作起名）→ 该操作不进表 → 没有帧。
 * 这正是安全缺省：没有人类可读名就不发帧，绝不回退显示脚本名或操作名。
 *
 * 参数规格同理（L2：flag→样式由平台机器可读地拥有）：同一子命令的 `--json`
 * 输出带 `args` 规格（位置参数名 + 合法 flag + 必填性 + 取值样式）。平台刻意把
 * 规格只放 --json（TSV 维持 5 列纪律，人读列数一动 `operation list | awk`
 * 一类下游全断），所以这里分两次 spawn 同一子命令：TSV 取 label、JSON 取规格。
 * 两份都是**只读消费**——宿主不镜像 flag 名单，平台加了 flag 这边自动看得见。
 *
 * access 语义同理（本模块的第三份只读消费）：`--json` 的顶层 `accessSemantics`
 * 表声明每个 access 取值的 plan/confirm/mock 三列，宿主据此判"这个调用要不要
 * 用户确认"（= 是不是写）。语义只活在平台的那张表里，宿主一个字节都不猜——
 * 拿不到表就什么都不算写（fail-closed，与 label/规格缺失同族的安全缺省）。
 *
 * protocol 角色同理（本模块的第四份只读消费）：`--json` 每行的 `protocol` 列声明
 * 该 operation 在写流程里的角色（创建提案 / 提交提案），宿主据此识别网关调用的协议
 * 角色，不认业务 operation 名、不认脚本路径。空表 = 不识别（同族安全缺省）。
 *
 * 纯数据 + 显式传表：无单例、无进程级缓存，调用方持有 Map 并注入，
 * 测试因此可以直接塞替身表，不需要真平台。
 */
import { spawn } from 'node:child_process';
import { gatewayExecPath, validateGatewayInvocation } from './platform-contract';

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

/** CLI 派生超时：平台起不来时不能拖住 worker 的第一条命令。 */
const LABEL_CLI_TIMEOUT_MS = 3_000;
/** label 长度上限：进度帧是短句，不是长文。 */
const LABEL_MAX_CHARS = 40;
/** 控制字符/换行一律剥掉：label 要能安全进一行进度帧。 */
function sanitizeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX_CHARS);
}

/**
 * 解析 `operation list` 的 TSV 输出：取第 1/2/5 列（name/script/label），
 * 只收 label 非空的条目。行数不足 5 列（旧版平台）整行跳过。
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

/**
 * 经公共 CLI 派生 label 表（cwd=platformRoot）。
 *
 * 任何失败——platformRoot 未配、CLI 不存在/不可执行、超时、非零退出、
 * spawn 抛错——都返回空 Map：派生是增强，不是前提。
 */
export function loadOperationLabels(platformRoot?: string, gateway?: string): Promise<OperationLabels> {
  if (!platformRoot) return Promise.resolve(new Map());
  // C7b：gateway 未声明/非法 = 派生增强不可用，降级空表（与 platformRoot 未配同判据），
  // 绝不回退遗留网关名。声明了 gateway 的部署行为不变。
  if (!validateGatewayInvocation(gateway)) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot, gateway);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (labels: OperationLabels): void => {
      if (settled) return;
      settled = true;
      resolve(labels);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ['operation', 'list'], {
        cwd: platformRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle(new Map());
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Map());
    }, LABEL_CLI_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle(new Map()); });
    child.once('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? parseOperationLabels(Buffer.concat(stdout).toString('utf8')) : new Map());
    });
  });
}

/**
 * 单个 operation 的 args 规格（`operation list --json` 的 `args` 列，平台机器可读面）。
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

/** 收位置参数名（按序，只收非空字符串）。 */
function collectPositionalNames(positional: unknown): string[] {
  if (!Array.isArray(positional)) return [];
  return positional
    .map((item) => (item as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/**
 * `operation list --json` 的顶层文档 → operations 数组。
 *
 * 平台从"裸数组"演进到"对象信封"（新增顶层 `accessSemantics` 表）时，只认数组的
 * 解析器会**整份返回空表**——那正是必须宽容的形状：信封是平台契约演进，不是脏输入。
 * 因此两种顶层形状都收：数组原样、`{operations:[…]}` 取数组；其余（非 JSON /
 * 对象里没有 operations 数组）返回 null = 与旧版同一套安全缺省（空表）。
 */
function operationsArrayOf(stdout: string): unknown[] | null {
  let document: unknown;
  try { document = JSON.parse(stdout); } catch { return null; }
  if (Array.isArray(document)) return document;
  const operations = (document as { operations?: unknown } | null)?.operations;
  return Array.isArray(operations) ? operations : null;
}

/**
 * 解析 `operation list --json` 的 args 规格：按 operation 收 positionalNames + flagStyles。
 * 键同时收注册名（voucher.query-saved）与 command 裸名（query-saved）——命令里两种
 * 写法都合法，规格查找因此两种都命中。
 */
export function parseOperationArgSpecs(stdout: string): OperationArgsSpecs {
  const specs: Map<string, OperationArgsSpec> = new Map();
  const operations = operationsArrayOf(stdout);
  if (!operations) return specs;
  for (const operation of operations) {
    const name = (operation as { name?: unknown } | null)?.name;
    const command = (operation as { command?: unknown } | null)?.command;
    const args = (operation as { args?: unknown } | null)?.args as { positional?: unknown; flags?: unknown } | null | undefined;
    if (!args) continue;
    const spec: OperationArgsSpec = { positionalNames: collectPositionalNames(args.positional), flagStyles: collectFlagStyles(args.flags) };
    for (const key of [name, command]) {
      if (typeof key === 'string' && key && !specs.has(key)) specs.set(key, spec);
    }
  }
  return specs;
}

/**
 * 从整份规格派生全局 flag→样式表（参数摘要的消费面，D-012）。
 *
 * 同一 flag 在多个 operation 里样式一致（平台规格纪律）；万一不一致，先登记者生效——
 * 取"先"而不是"后"是为了让表只依赖输入顺序确定，不靠"最后一个覆盖"的隐式规则。
 */
export function parseOperationArgStyles(stdout: string): KeyArgStyles {
  const styles = new Map<string, KeyArgStyle>();
  for (const spec of parseOperationArgSpecs(stdout).values()) {
    for (const [flag, style] of spec.flagStyles) {
      if (!styles.has(flag)) styles.set(flag, style);
    }
  }
  return styles;
}

/**
 * 经公共 CLI 派生 flag 样式表（cwd=platformRoot，`operation list --json`）。
 *
 * 失败语义与 loadOperationLabels 完全一致：platformRoot 未配、CLI 不存在/
 * 不可执行、超时、非零退出、输出不是 JSON——一律返回空 Map。派生是增强，
 * 不是前提；没有规格就不发参数摘要，绝不用宿主硬编码名单顶替。
 */
export function loadOperationArgStyles(platformRoot?: string, gateway?: string): Promise<KeyArgStyles> {
  if (!platformRoot) return Promise.resolve(new Map());
  // C7b：gateway 未声明/非法 = 派生增强不可用，降级空表（与 platformRoot 未配同判据），
  // 绝不回退遗留网关名。声明了 gateway 的部署行为不变。
  if (!validateGatewayInvocation(gateway)) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot, gateway);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (styles: KeyArgStyles): void => {
      if (settled) return;
      settled = true;
      resolve(styles);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ['operation', 'list', '--json'], {
        cwd: platformRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle(new Map());
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Map());
    }, LABEL_CLI_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle(new Map()); });
    child.once('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? parseOperationArgStyles(Buffer.concat(stdout).toString('utf8')) : new Map());
    });
  });
}

/**
 * 经公共 CLI 派生整份 args 规格（cwd=platformRoot，`operation list --json`）。
 *
 * 失败语义与 loadOperationLabels / loadOperationArgStyles 完全一致：platformRoot 未配、
 * CLI 不存在/不可执行、超时、非零退出、输出不是 JSON——一律返回空 Map。派生是增强，
 * 不是前提；没有规格就不提取结构化事实（宁缺勿猜），绝不用宿主硬编码位置猜。
 */
export function loadOperationArgSpecs(platformRoot?: string, gateway?: string): Promise<OperationArgsSpecs> {
  if (!platformRoot) return Promise.resolve(new Map());
  // C7b：gateway 未声明/非法 = 派生增强不可用，降级空表（与 platformRoot 未配同判据），
  // 绝不回退遗留网关名。声明了 gateway 的部署行为不变。
  if (!validateGatewayInvocation(gateway)) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot, gateway);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (specs: OperationArgsSpecs): void => {
      if (settled) return;
      settled = true;
      resolve(specs);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ['operation', 'list', '--json'], {
        cwd: platformRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle(new Map());
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Map());
    }, LABEL_CLI_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle(new Map()); });
    child.once('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? parseOperationArgSpecs(Buffer.concat(stdout).toString('utf8')) : new Map());
    });
  });
}

/**
 * 平台 access 语义（`operation list --json` 顶层 `accessSemantics` 表的一行，数据不是逻辑）：
 *   · plan    要不要过计划门（进计划、被记账）；
 *   · confirm 要不要用户确认（确认码 + commit token）——**是不是写**的唯一判据；
 *   · mock    联调时执行器替身换不换掉。
 *
 * 为什么宿主不再自己认 access 取值：语义只活在平台的这张表里。宿主曾用
 * `access.startsWith('write')` 判写家族——平台加一个同族取值（如批量写）就静默
 * 算写，而"要不要用户确认"这件事只有平台说了算。现在判据只有一列：confirm。
 * 三列缺一项/不是布尔一律按 false（宁缺勿猜：判据不成立时绝不放大权限）。
 */
export interface AccessSemantics {
  plan: boolean;
  confirm: boolean;
  mock: boolean;
}

/** operation 注册名（也收 command 裸名）→ 平台声明的 access 语义。 */
export type OperationSemantics = ReadonlyMap<string, AccessSemantics>;

/** access 取值 → 平台声明的语义（`accessSemantics` 顶层表原样）。 */
export type AccessSemanticsTable = ReadonlyMap<string, AccessSemantics>;

/**
 * 顶层 `accessSemantics` 表 → access → 语义。
 *
 * 键是平台的 access 取值（宿主不列举、不校验取值集合——词汇表由平台自己持有）；
 * 值是对象且三列各自按布尔收取（缺列/非布尔 → false）。缺表（旧版平台 / 平台还没
 * 下发这张表）→ 空表 = 判据不成立（宁缺勿猜）：查不到语义的 operation 绝不触发
 * 写类判定，由平台门禁按既有路径拒绝。
 */
export function parseAccessSemantics(stdout: string): AccessSemanticsTable {
  const table: Map<string, AccessSemantics> = new Map();
  let document: unknown;
  try { document = JSON.parse(stdout); } catch { return table; }
  const raw = Array.isArray(document) ? undefined : (document as { accessSemantics?: unknown } | null)?.accessSemantics;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return table;
  for (const [access, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!access || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    table.set(access, { plan: row.plan === true, confirm: row.confirm === true, mock: row.mock === true });
  }
  return table;
}

/**
 * 解析 `operation list --json` 的语义表：按 operation 收**平台声明的语义对象**。
 *
 * 两个平台数据面的机械连接，没有一步是宿主判断：
 *   ① operation 的 `access` 列（连接键，平台清单权威字段）；
 *   ② 顶层 `accessSemantics` 表（access → plan/confirm/mock）。
 * 键同时收注册名（voucher.prepare）与 command 裸名（prepare）——与规格表同口径。
 * access 缺失 / 语义表里查不到该 access（旧版平台、平台未登记）→ 该 operation
 * 不进表：它不参与写类判定（宁缺勿猜），平台门禁与提案路径的既有拒绝照旧兜底。
 */
export function parseOperationSemantics(stdout: string): OperationSemantics {
  const semantics: Map<string, AccessSemantics> = new Map();
  const operations = operationsArrayOf(stdout);
  const table = parseAccessSemantics(stdout);
  if (!operations || table.size === 0) return semantics;
  for (const operation of operations) {
    const name = (operation as { name?: unknown } | null)?.name;
    const command = (operation as { command?: unknown } | null)?.command;
    const access = (operation as { access?: unknown } | null)?.access;
    if (typeof access !== 'string' || !access) continue;
    const entry = table.get(access);
    if (!entry) continue;
    for (const key of [name, command]) {
      if (typeof key === 'string' && key && !semantics.has(key)) semantics.set(key, entry);
    }
  }
  return semantics;
}

/**
 * 经公共 CLI 派生 operation → 语义表（cwd=platformRoot，`operation list --json`）。
 *
 * 失败语义与 loadOperationLabels / loadOperationArgStyles 完全一致：platformRoot 未配、
 * CLI 不存在/不可执行、超时、非零退出、输出不是 JSON、平台还没下发 accessSemantics
 * ——一律返回空 Map。派生是增强，不是前提；没有语义表就不做写类判定（平台门禁照旧
 * 兜底），绝不用宿主硬编码 operation 名单或 access 词表顶替（那违反 L2：宿主另立
 * 一份名单/词表即分叉）。
 */
export function loadOperationSemantics(platformRoot?: string, gateway?: string): Promise<OperationSemantics> {
  if (!platformRoot) return Promise.resolve(new Map());
  // C7b：gateway 未声明/非法 = 派生增强不可用，降级空表（与 platformRoot 未配同判据），
  // 绝不回退遗留网关名。声明了 gateway 的部署行为不变。
  if (!validateGatewayInvocation(gateway)) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot, gateway);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (semantics: OperationSemantics): void => {
      if (settled) return;
      settled = true;
      resolve(semantics);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ['operation', 'list', '--json'], {
        cwd: platformRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle(new Map());
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Map());
    }, LABEL_CLI_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle(new Map()); });
    child.once('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? parseOperationSemantics(Buffer.concat(stdout).toString('utf8')) : new Map());
    });
  });
}

/**
 * 平台协议角色列（`operation list --json` 的 `protocol`，A 波新增）：operation 在写流程里
 * 扮演什么角色（创建提案 / 提交提案）。宿主据此识别网关调用的**协议角色**，不认业务
 * operation 名、也不认脚本路径（AGENTS.md 跨层协议条款）。
 *
 * 与 label / 规格 / 语义三张表同族：只读消费平台数据，缺列 / 空值 / 非字符串一律不进表。
 * 空表 = 判据不成立（宁缺勿猜）：识别层据此不拦截，由 serve 门与平台继续裁决——绝不用
 * 宿主硬编码 operation 名单顶替（那正是 L2 禁止的第二份名单）。
 */
export type OperationProtocols = ReadonlyMap<string, string>;

/** 角色名的卫生：剥控制字符、折叠空白、截断（角色名是短标识，不是长文）。 */
function sanitizeProtocol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return text || undefined;
}

/**
 * 解析 `operation list --json` 的 protocol 列：operation → 角色名。
 *
 * 顶层形状宽容与 parseOperationArgSpecs 同一判据（裸数组 / `{operations:[…]}` 都收，
 * 其余返回空表 = 与旧版同一套安全缺省）。键同时收注册名（voucher.proposal）与 command
 * 裸名（proposal）——命令里两种写法都合法，与规格表、语义表同口径。
 */
export function parseOperationProtocols(stdout: string): OperationProtocols {
  const protocols: Map<string, string> = new Map();
  const operations = operationsArrayOf(stdout);
  if (!operations) return protocols;
  for (const operation of operations) {
    const name = (operation as { name?: unknown } | null)?.name;
    const command = (operation as { command?: unknown } | null)?.command;
    const protocol = sanitizeProtocol((operation as { protocol?: unknown } | null)?.protocol);
    if (!protocol) continue;
    for (const key of [name, command]) {
      if (typeof key === 'string' && key && !protocols.has(key)) protocols.set(key, protocol);
    }
  }
  return protocols;
}

/**
 * 经公共 CLI 派生 protocol 角色表（cwd=platformRoot，`operation list --json`）。
 *
 * 失败语义与 loadOperationLabels / loadOperationArgStyles / loadOperationSemantics 完全
 * 一致：platformRoot 未配、CLI 不存在/不可执行、3s 超时、非零退出、输出不是 JSON、
 * 平台还没下发这一列——一律返回空 Map。派生是增强，不是前提；没有角色表就不识别提案
 * 创建调用（fail-closed 到"不拦截"），门与平台照旧兜底。
 */
export function loadOperationProtocols(platformRoot?: string, gateway?: string): Promise<OperationProtocols> {
  if (!platformRoot) return Promise.resolve(new Map());
  // C7b：gateway 未声明/非法 = 派生增强不可用，降级空表（与 platformRoot 未配同判据），
  // 绝不回退遗留网关名。声明了 gateway 的部署行为不变。
  if (!validateGatewayInvocation(gateway)) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot, gateway);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (protocols: OperationProtocols): void => {
      if (settled) return;
      settled = true;
      resolve(protocols);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ['operation', 'list', '--json'], {
        cwd: platformRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle(new Map());
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(new Map());
    }, LABEL_CLI_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle(new Map()); });
    child.once('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? parseOperationProtocols(Buffer.concat(stdout).toString('utf8')) : new Map());
    });
  });
}

/**
 * 提案创建角色的协议列取值：平台声明的角色名，属协议常量（非模型输入嗅探），
 * 故以具名常量出现一次，比较处不再写字面量。parseProposalSchema 只认这个
 * 常量命名的行，不另持业务 operation 名单。
 */
export const PROPOSAL_CREATE_PROTOCOL = 'proposal.create';

/**
 * 提案 schema 下发（接口文档 §5，第 2 包）：operation list 里携带提案创建
 * 协议角色的那一行的 proposalSchema 列。宿主只做“是不是非空普通对象”
 * 这一形状卫生检查，然后原样透传给隔离复核，不读、不校验、不缓存任何
 * 业务字段。缺列 / 非对象 / 数组一律返回 null = schema 未下发，调用方按
 * fail-closed 处理（提案创建直接失败，不降级）。
 */
export function parseProposalSchema(stdout: string): unknown | null {
  const operations = operationsArrayOf(stdout);
  if (!operations) return null;
  for (const operation of operations) {
    const protocol = (operation as { protocol?: unknown } | null)?.protocol;
    if (protocol !== PROPOSAL_CREATE_PROTOCOL) continue;
    const schema = (operation as { proposalSchema?: unknown } | null)?.proposalSchema;
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema;
    return null;
  }
  return null;
}

/**
 * 经公共 CLI 取问提案 schema（cwd=platformRoot，`operation list --json`）。
 * 失败语义与 loadOperationProtocols 完全一致，只是返回值不同：
 * 平台未配、CLI 失败、超时、非 JSON、行里无 schema——一律返回 null，
 * 调用方（提案创建路径）按 fail-closed 处理，绝不以 null schema 继续复核。
 */
export function loadProposalSchema(platformRoot?: string, gateway?: string): Promise<unknown | null> {
  if (!platformRoot) return Promise.resolve(null);
  // C7b：gateway 未声明/非法 = 派生增强不可用，降级空表（与 platformRoot 未配同判据），
  // 绝不回退遗留网关名。声明了 gateway 的部署行为不变。
  if (!validateGatewayInvocation(gateway)) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot, gateway);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (schema: unknown | null): void => {
      if (settled) return;
      settled = true;
      resolve(schema);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ['operation', 'list', '--json'], {
        cwd: platformRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(null);
    }, LABEL_CLI_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle(null); });
    child.once('close', (code) => {
      clearTimeout(timer);
      settle(code === 0 ? parseProposalSchema(Buffer.concat(stdout).toString('utf8')) : null);
    });
  });
}

/**
 * 该 operation 是否属写类——判据只有一列：平台声明的 `confirm`（要不要用户确认）。
 *
 * 为什么"要不要用户确认"就是"是不是写"：平台对每个 access 取值声明三列语义，其中
 * confirm 正是"这个调用要确认码 + commit token"的那一列——要用户确认的调用就是有
 * 平台写副作用的调用。宿主不再前缀匹配 access 字符串（加个同族取值就静默算写），
 * 也不再列举平台的 access 词表（L2：词汇表由平台自己持有）。
 *
 * 拿不到语义（缺表 / 该 operation 未登记 / 平台还没下发这张表）→ false：fail-closed
 * 到什么都不算写，与 label/规格缺失同纪律——不触发布防，交给平台门禁既有路径。
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

// ── C6 结构化调用通道：能力清单派生 ───────────────────────────────────────────

import { A2A_PROTOCOL_VERSION, type CapabilityManifest, type OperationDeclaration } from '@fshine/contracts';

export type { CapabilityManifest };

/**
 * `operation list --json` 顶层文档 → CapabilityManifest。
 *
 * 能力清单只作 `<gateway> operation list --json` 的消费投影（生命周期第②阶段「发现」）：
 * 权威是执行器的实时输出，宿主不缓存、不复制、不另立名单（L2 单一来源）——本类型
 * 不引入任何文件读取路径，清单没有的能力视为不存在。
 *
 * 派生规则（与 label/规格/语义/协议四张表同族安全缺省）：
 *   · 解析失败 / 非 JSON / 没有 operations 数组 → 空 manifest；
 *   · 单行缺字段 → 该行不进清单（不猜、不补）；
 *   · requiresPlan 从 accessSemantics 的 plan 列机械推导；
 *   · serveMatrix 从 serve 对象提取值为 true 的键；
 *   · est_seconds 字段不存在时按 null 处理。
 */
export function parseCapabilityManifest(stdout: string): CapabilityManifest | null {
  let document: unknown;
  try { document = JSON.parse(stdout); } catch { return null; }
  const operations = operationsArrayOf(stdout);
  if (!operations) return null;

  const accessTable = parseAccessSemantics(stdout);
  const declarations: OperationDeclaration[] = [];
  for (const op of operations) {
    const name = (op as { name?: unknown } | null)?.name;
    const command = (op as { command?: unknown } | null)?.command;
    const access = (op as { access?: unknown } | null)?.access;
    const effects = (op as { effects?: unknown } | null)?.effects;
    const estSeconds = (op as { est_seconds?: unknown } | null)?.est_seconds;
    const label = (op as { label?: unknown } | null)?.label;
    const serve = (op as { serve?: unknown } | null)?.serve;
    const args = (op as { args?: unknown } | null)?.args as { positional?: unknown; flags?: unknown } | null | undefined;

    if (typeof name !== 'string' || !name) continue;
    const key = name;

    const requiresPlan = typeof access === 'string' && accessTable.has(access)
      ? (accessTable.get(access)!.plan)
      : true;

    const effectList = Array.isArray(effects)
      ? effects.filter((e): e is string => typeof e === 'string')
      : [];

    const serveKeys = serve && typeof serve === 'object' && !Array.isArray(serve)
      ? Object.entries(serve as Record<string, unknown>)
          .filter(([, v]) => v === true)
          .map(([k]) => k)
      : [];

    // 从平台 args 规格派生声明式 argsSchema：positional 名 + flag 名（含 -- 前缀）。
    // 缺失规格（旧版平台 / 平台未给该 operation 起名）→ 空表 = 不做参数级复核（安全缺省）。
    const argsSchema: string[] = [];
    if (args) {
      const positionalNames = Array.isArray(args.positional)
        ? args.positional
            .map((item) => (item as { name?: unknown } | null)?.name)
            .filter((n): n is string => typeof n === 'string' && n.length > 0)
        : [];
      const flagNames = Array.isArray(args.flags)
        ? args.flags
            .map((flag) => (flag as { flag?: unknown } | null)?.flag)
            .filter((f): f is string => typeof f === 'string' && f.length > 0)
        : [];
      argsSchema.push(...positionalNames, ...flagNames);
    }

    declarations.push({
      operation: key,
      requiresPlan,
      effects: effectList,
      estSeconds: typeof estSeconds === 'number' ? estSeconds : null,
      label: typeof label === 'string' && label ? label : null,
      serveMatrix: serveKeys,
      argsSchema: argsSchema.length > 0 ? argsSchema : undefined,
    });
  }

  return {
    version: A2A_PROTOCOL_VERSION,
    operations: declarations,
  };
}

/**
 * 经公共 CLI 派生能力清单（cwd=platformRoot，`operation list --json`）。
 *
 * 失败语义与 loadOperationLabels / loadOperationArgStyles 完全一致：platformRoot 未配、
 * CLI 不存在/不可执行、超时、非零退出、输出不是 JSON——一律返回 null。
 * 派生是增强，不是前提；拿不到清单 = 没有能力 = structured_call 一律 fail-closed。
 */
export function loadCapabilityManifest(platformRoot?: string, gateway?: string): Promise<CapabilityManifest | null> {
  if (!platformRoot) return Promise.resolve(null);
  if (!validateGatewayInvocation(gateway)) return Promise.resolve(null);
  const cli = gatewayExecPath(platformRoot, gateway);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (manifest: CapabilityManifest | null): void => {
      if (settled) return;
      settled = true;
      resolve(manifest);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ['operation', 'list', '--json'], {
        cwd: platformRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      settle(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(null);
    }, LABEL_CLI_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => { clearTimeout(timer); settle(null); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(null);
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8');
      settle(parseCapabilityManifest(text));
    });
  });
}
