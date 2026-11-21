/**
 * ops/usage-report：模型调用用量与延迟报表（仓内只读脚本，手动 / 离线诊断入口，不进产品运行时）。
 *
 * 数据源 = `<dbPath 同目录>/usage.jsonl`（落盘见 packages/agent/src/model-usage.ts 的
 * createModelUsageSink；dbPath 解析与 ask/tasks/alerts 同源，--file 可显式覆盖）。
 * 聚合 = 纯函数 aggregateModelUsage（按 (principalId, day) 分组；百分比用最近秩法），
 * 本脚本只做参数解析、读文件与渲染——判定不在脚本里，便于单测与复用。
 *
 * 用法：
 *   npm run usage                                  # 缺省全量
 *   npm run usage -- --since 7d                    # 最近 7 天（Nd 或 ISO 时刻）
 *   npm run usage -- --principal wecom:xxx --agent main
 *   npm run usage -- --file /path/to/usage.jsonl
 *
 * 空数据（文件不存在 / 零行 / 过滤后零组）打印「无数据」exit 0——新部署没有记录是常态，
 * 不是错误。坏行跳过并记结构化事件（stderr），不中断报表。
 * 边界：只读，绝不写 usage.jsonl / state.db / alerts.jsonl。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateModelUsage,
  parseUsageLine,
  usageFilePathOf,
  type UsageDayGroup,
  type UsageReportFilter,
} from '../../packages/agent/src/model-usage';
import { explicitConfigFrom } from '../resolve-config-path';
import { resolveTaskDbPath } from '../tasks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = '用法：npm run usage [-- --since 7d|<ISO>] [--principal <id>] [--agent main|worker] '
  + '[--file <path>] [--config=<path>]\n'
  + '  缺省读 <dbPath 同目录>/usage.jsonl；空数据打印「无数据」exit 0；只读。';

export interface UsageReportArgs {
  /** epoch 毫秒；--since 7d / Nd / ISO 换算后得到（相对值以传入 now 为基准）。 */
  sinceMs?: number;
  principalId?: string;
  agent?: 'main' | 'worker';
  /** 显式 usage.jsonl 路径（缺省 = <dbPath 同目录>/usage.jsonl）。 */
  filePath?: string;
  configPath?: string;
}

/** `--since 7d` / `Nd` / ISO 时刻 → epoch 毫秒；其余返回 undefined（无效值返回 usageError）。 */
function parseSinceMs(raw: string, now: number): number | undefined | { usageError: string } {
  const text = raw.trim();
  const relative = /^(\d+)d$/.exec(text);
  if (relative !== null) return now - Number(relative[1]) * 86_400_000;
  if (text === '') return undefined;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return { usageError: `--since 只接受 Nd（如 7d）或 ISO 时刻（当前：${text}）。` };
  return parsed;
}

export function parseUsageReportArgs(
  argv: readonly string[],
  now: number = Date.now(),
): UsageReportArgs | { usageError: string } {
  const args: UsageReportArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const takeValue = (flag: string): string | { usageError: string } => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1).trim();
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) return { usageError: `${flag} 缺少值。` };
      index += 1;
      return next.trim();
    };
    if (arg === '--since' || arg.startsWith('--since=')) {
      const raw = arg.startsWith('--since=') ? arg.slice('--since='.length).trim() : (() => {
        const next = argv[index + 1];
        if (next === undefined) return { usageError: '--since 缺少值。' };
        index += 1;
        return next;
      })();
      if (typeof raw !== 'string') return raw;
      const sinceMs = parseSinceMs(raw, now);
      if (typeof sinceMs === 'number' || sinceMs === undefined) args.sinceMs = sinceMs;
      else return sinceMs;
      continue;
    }
    if (arg === '--principal' || arg.startsWith('--principal=')) {
      const value = takeValue('--principal');
      if (typeof value !== 'string') return value;
      if (value === '') return { usageError: '--principal 不能为空。' };
      args.principalId = value;
      continue;
    }
    if (arg === '--agent' || arg.startsWith('--agent=')) {
      const value = takeValue('--agent');
      if (typeof value !== 'string') return value;
      if (value !== 'main' && value !== 'worker') {
        return { usageError: `--agent 只接受 main|worker（当前：${value}）。` };
      }
      args.agent = value;
      continue;
    }
    if (arg === '--file' || arg.startsWith('--file=')) {
      const value = takeValue('--file');
      if (typeof value !== 'string') return value;
      if (value === '') return { usageError: '--file 不能为空。' };
      args.filePath = value;
      continue;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length).trim();
      if (value === '') return { usageError: '--config 缺少路径。' };
      args.configPath = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') continue;
    return { usageError: `未知参数：${arg}` };
  }
  return args;
}

const HEADERS = [
  '主体', '日期', '调用', 'input', 'output', 'cacheRead', 'reasoning', 'total',
  '平均耗时ms', 'p50耗时ms', 'p95耗时ms', 'p50首字ms', 'p95首字ms', '输出tokens/s',
] as const;
const CELL_WIDTHS = [18, 11, 6, 9, 9, 10, 10, 9, 11, 11, 11, 10, 10, 12] as const;

/** 组 → 渲染行（等宽表格；null 计量渲染 n/a）。只在这里装饰，判定都在聚合纯函数。 */
export function renderUsageReport(groups: readonly UsageDayGroup[]): string {
  if (groups.length === 0) return '无数据';
  const pad = (text: string, width: number): string => text.padEnd(width);
  const rows = [HEADERS.map((header, index) => pad(header, CELL_WIDTHS[index]!)).join('')];
  for (const group of groups) {
    const cells = [
      group.principalId === '' ? '(无主体)' : group.principalId,
      group.day,
      String(group.calls),
      String(group.inputTokens),
      String(group.outputTokens),
      String(group.cacheReadTokens),
      String(group.reasoningTokens),
      String(group.totalTokens),
      String(group.avgDurationMs),
      String(group.p50DurationMs),
      String(group.p95DurationMs),
      group.p50TtftMs === null ? 'n/a' : String(group.p50TtftMs),
      group.p95TtftMs === null ? 'n/a' : String(group.p95TtftMs),
      group.outputTokensPerSecond === null ? 'n/a' : String(group.outputTokensPerSecond),
    ];
    rows.push(cells.map((text, index) => pad(text, CELL_WIDTHS[index]!)).join('').trimEnd());
  }
  return rows.join('\n');
}

async function main(): Promise<number> {
  const parsed = parseUsageReportArgs(process.argv.slice(2));
  if ('usageError' in parsed) {
    console.error(parsed.usageError);
    console.error(USAGE);
    return 2;
  }

  // 数据源：--file 显式覆盖；缺省 = <dbPath 同目录>/usage.jsonl（dbPath 与 ask/tasks/alerts 同源）。
  let filePath: string;
  if (parsed.filePath !== undefined) {
    filePath = path.resolve(parsed.filePath);
  } else {
    const configExplicit = parsed.configPath ?? explicitConfigFrom(process.argv, process.env);
    const { dbPath } = resolveTaskDbPath({
      argv: configExplicit !== undefined ? [`--config=${configExplicit}`] : [],
      env: process.env,
      repoRoot: REPO_ROOT,
      cwd: process.cwd(),
    });
    filePath = usageFilePathOf(dbPath);
  }

  let groups: UsageDayGroup[] = [];
  let skipped = 0;
  if (existsSync(filePath)) {
    const parsedLines = [];
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const row = parseUsageLine(line);
      if (row === undefined) skipped += 1;
      else parsedLines.push(row);
    }
    groups = aggregateModelUsage(parsedLines, {
      ...(parsed.sinceMs !== undefined ? { sinceMs: parsed.sinceMs } : {}),
      ...(parsed.principalId !== undefined ? { principalId: parsed.principalId } : {}),
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
    } satisfies UsageReportFilter);
  } else {
    console.error(JSON.stringify({ event: 'usage_report_no_file', path: filePath }));
  }
  if (skipped > 0) {
    console.error(JSON.stringify({ event: 'usage_report_skipped_lines', path: filePath, count: skipped }));
  }
  console.log(renderUsageReport(groups));
  return 0;
}

if (import.meta.main) {
  await main()
    .then((code) => { if (code !== 0) process.exit(code); })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
