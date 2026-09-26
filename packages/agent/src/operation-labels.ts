/**
 * 平台操作的人类可读名（label）派生层。
 *
 * 进度帧里的业务措辞只有一个来源：平台公共 CLI `bin/17dz operation list` 的
 * TSV 输出第 5 列。fshine 不维护业务词表，也不认识任何具体操作——label 是
 * 平台数据，经本模块读进来后只做查表。
 *
 * 输出契约（17dz 侧新增的第 5 列，已实测在线）：
 *   name <TAB> script <TAB> access <TAB> executor <TAB> label
 * 第 5 列缺失或为空（旧版平台 / 平台没给这个操作起名）→ 该操作不进表 → 没有帧。
 * 这正是安全缺省：没有人类可读名就不发帧，绝不回退显示脚本名或操作名。
 *
 * 纯数据 + 显式传表：无单例、无进程级缓存，调用方持有 Map 并注入，
 * 测试因此可以直接塞替身表，不需要真平台。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

/** script → label 查找表。script 与操作名两种写法都收录（命令里两种都合法）。 */
export type OperationLabels = Map<string, string>;

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
  const cli = path.join(platformRoot, 'bin', '17dz');
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
