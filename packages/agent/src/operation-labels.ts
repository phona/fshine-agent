/**
 * 平台操作的人类可读名（label）与参数规格（args spec）派生层。
 *
 * 进度帧里的业务措辞只有一个来源：平台公共 CLI 的 `operation list` 子命令
 * TSV 输出第 5 列。fshine 不维护业务词表，也不认识任何具体操作——label 是
 * 平台数据，经本模块读进来后只做查表。
 *
 * 输出契约（17dz 侧新增的第 5 列，已实测在线）：
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
 * 纯数据 + 显式传表：无单例、无进程级缓存，调用方持有 Map 并注入，
 * 测试因此可以直接塞替身表，不需要真平台。
 */
import { spawn } from 'node:child_process';
import { gatewayExecPath } from './platform-contract';

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
export function loadOperationLabels(platformRoot?: string): Promise<OperationLabels> {
  if (!platformRoot) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot);
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
 * 解析 `operation list --json` 的 args 规格：按 operation 收 positionalNames + flagStyles。
 * 键同时收注册名（voucher.query-saved）与 command 裸名（query-saved）——命令里两种
 * 写法都合法，规格查找因此两种都命中。
 */
export function parseOperationArgSpecs(stdout: string): OperationArgsSpecs {
  const specs: Map<string, OperationArgsSpec> = new Map();
  let operations: unknown;
  try { operations = JSON.parse(stdout); } catch { return specs; }
  if (!Array.isArray(operations)) return specs;
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
export function loadOperationArgStyles(platformRoot?: string): Promise<KeyArgStyles> {
  if (!platformRoot) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot);
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
export function loadOperationArgSpecs(platformRoot?: string): Promise<OperationArgsSpecs> {
  if (!platformRoot) return Promise.resolve(new Map());
  const cli = gatewayExecPath(platformRoot);
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
 * 命令里的 script 引用 → label。引用有三种合法写法（操作名/裸名/脚本路径），
 * 归一成同一个键后查表；表里没有就返回 undefined，调用方据此决定静默不发帧。
 */
export function operationLabel(labels: OperationLabels | undefined, script: string | null | undefined): string | undefined {
  if (!labels || labels.size === 0 || !script) return undefined;
  return labels.get(labelKey(script));
}

/** 引用归一：取末段 → 去脚本后缀 → 去域前缀（voucher.query-saved → query-saved）。 */
function labelKey(reference: string): string {
  const base = reference.split(/[/\\]/).pop() ?? reference;
  const bare = base.replace(/\.(?:js|py)$/i, '');
  const dot = bare.indexOf('.');
  return dot > 0 ? bare.slice(dot + 1) : bare;
}
