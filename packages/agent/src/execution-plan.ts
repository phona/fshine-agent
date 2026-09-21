/**
 * 任务执行方案（plan manifest）：serve worker 的执行面治理。
 *
 * 事故背景（2026-09 生产实录）：单轮用户问题引发 52 次 bash 调用——通配符枚举、
 * 读源码找路径、for 循环扫 9 个期间、sleep 重试——最终触发 17dz 反爬。
 * 本模块让 worker 在执行前提交结构化方案，由校验器定价（预计调用数/用时）并
 * 授予预算；执行中超预算或调用未申报脚本即被 G1 剪断。"失控"被转化为"回到对话"。
 *
 * 协议：worker 首条 bash 命令为 `bin/17dz plan` + 一行 JSON 方案（首选）或多行 YAML；
 * G1 拦截该命令（不下发平台），审批结果以拦截消息回给模型（正常流程，非错误）。
 */
import { spawnSync } from 'node:child_process';
import * as nodePath from 'node:path';

export const HARD_MAX_GATE_CALLS = 30;
export const MAX_PERIODS_WITHOUT_JUSTIFICATION = 3;
/** 预估平台调用超过此数 → 方案不自动批准，转用户确认（NEEDS_USER_CONFIRM） */
export const PLAN_CONFIRM_THRESHOLD = 10;

/** 每类操作的重量定价（秒）。优先用平台清单声明（est_seconds），缺省按 effects 类目。 */
export const OP_COST_SECONDS = { browserRead: 10, local: 1, write: 30 } as const;

/** 方案提交的标准一行式（JSON）。拒绝消息里回带，降低模型试错成本。 */
export const PLAN_EXAMPLE =
  'bin/17dz plan {"goal":"查询幻辰财税202607凭证","account_sets":["幻辰财税"],"periods":["202607"],"read":["query-saved"],"max_gate_calls":6,"completion":["list_reported"]}';

export interface ExecutionPlan {
  goal: string;
  accountSets: string[];
  periods: string[];
  /** 申报的只读操作（gate 可达面，引用平台注册操作名/短名，如 voucher.query-saved） */
  readOps: string[];
  /** worker 方案不允许申报任何写——落账只经服务端两步确认 */
  writeOps: string[];
  maxGateCalls: number;
  completion: string[];
  /** 回溯期数超限等原因说明（constraints.justification） */
  justification?: string;
  /** 用户已确认执行重量（重方案放行的唯一凭证；信任声明，审计留痕） */
  userConfirmed?: boolean;
}

export interface OpCatalogEntry { name: string; effects: string[]; /** 平台声明的典型耗时（秒）；缺省用本地类目价目 */ estSeconds?: number }
/** 操作短名 → 清单条目（经平台公共 CLI 派生） */
export type OpCatalog = Map<string, OpCatalogEntry>;

export interface PlanEstimate { calls: number; seconds: number }

export type PlanVerdict =
  | { ok: true; plan: ExecutionPlan; limit: number; estimate: PlanEstimate; notices: string[]; needsConfirm: boolean }
  | { ok: false; reasons: string[] };

// ── 解析 ──

const PLAN_COMMAND_RE = /^(?:(?:bash|sh)\s+)?bin\/17dz\s+plan\b\s*([\s\S]*)$/;

export function parsePlanCommand(command: string): ExecutionPlan | null {
  const m = command.trim().match(PLAN_COMMAND_RE);
  if (!m) return null;
  const body = (m[1] ?? '').trim();
  // 一行式 JSON（首选，模型最不易写错）
  if (body.startsWith('{')) {
    try {
      return planFromJson(JSON.parse(body) as Record<string, unknown>);
    } catch {
      return normalizePlan(new Map());
    }
  }
  return normalizePlan(body ? parseSimpleYaml(body) : new Map());
}

/** JSON 字段：扁平键为主，兼容 camelCase 与 authority/constraints 嵌套 */
function planFromJson(o: Record<string, unknown>): ExecutionPlan {
  const auth = (o['authority'] ?? {}) as Record<string, unknown>;
  const cons = (o['constraints'] ?? {}) as Record<string, unknown>;
  const res = (o['resources'] ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : [];
  const num = Number(cons['max_gate_calls'] ?? cons['maxGateCalls'] ?? o['max_gate_calls'] ?? o['maxGateCalls'] ?? 0);
  return {
    goal: String(o['goal'] ?? '').trim(),
    accountSets: arr(res['account_sets'] ?? res['accountSets'] ?? o['account_sets'] ?? o['accountSets']),
    periods: arr(res['periods'] ?? o['periods']),
    readOps: arr(auth['read'] ?? o['read']),
    writeOps: arr(auth['write'] ?? o['write']),
    maxGateCalls: Number.isFinite(num) ? num : 0,
    completion: arr(o['completion']),
    justification: typeof cons['justification'] === 'string' ? cons['justification'] : o['justification'] ? String(o['justification']) : undefined,
    userConfirmed: o['user_confirmed'] === true || o['userConfirmed'] === true
      || o['user_confirmed'] === 'true' || o['userConfirmed'] === 'true',
  };
}

/** 极简 YAML 子集：key: value / key: [a, b] / key:\n  - item。不支持嵌套映射。 */
function parseSimpleYaml(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const listItem = line.match(/^-\s+(.+)$/);
    if (listItem && current) { out.get(current)!.push(stripQuotes(listItem[1]!)); continue; }
    const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (kv) {
      current = kv[1]!;
      const value = kv[2]!.trim();
      if (value) {
        out.set(current, value.startsWith('[')
          ? value.replace(/^\[|\]$/g, '').split(',').map((s) => stripQuotes(s.trim())).filter(Boolean)
          : [stripQuotes(value)]);
      } else out.set(current, []);
    }
  }
  return out;
}

function stripQuotes(s: string): string { return s.replace(/^["']|["']$/g, '').trim(); }

function normalizePlan(fields: Map<string, string[]>): ExecutionPlan {
  const list = (k: string) => fields.get(k) ?? [];
  const num = fields.get('max_gate_calls')?.[0];
  return {
    goal: fields.get('goal')?.[0] ?? '',
    accountSets: list('account_sets'),
    periods: list('periods'),
    readOps: list('read'),
    writeOps: list('write'),
    maxGateCalls: num && /^\d+$/.test(num) ? Number(num) : 0,
    completion: list('completion'),
    justification: fields.get('justification')?.[0],
    userConfirmed: fields.get('user_confirmed')?.[0] === 'true',
  };
}

// ── 清单 ──

/** 经公共 CLI（bin/17dz operation list --json）获取能力清单；不可用返回空表（降级不阻塞审批）。 */
export function loadOpCatalog(platformRoot: string): OpCatalog {
  try {
    const r = spawnSync(process.execPath, [nodePath.join(platformRoot, 'bin', '17dz'), 'operation', 'list', '--json'], {
      cwd: platformRoot, encoding: 'utf8', timeout: 20_000,
    });
    if (r.status !== 0 || !r.stdout) return new Map();
    return parseCatalogFromCli(r.stdout);
  } catch {
    return new Map();
  }
}

/** 解析 CLI JSON 输出；键 = 归一化操作短名。 */
export function parseCatalogFromCli(json: string): OpCatalog {
  const catalog: OpCatalog = new Map();
  const ops = JSON.parse(json) as Array<{ name?: string; effects?: string[]; est_seconds?: number }>;
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op.name) continue;
    catalog.set(basename(op.name), {
      name: op.name,
      effects: Array.isArray(op.effects) && op.effects.length ? op.effects : ['read'],
      estSeconds: typeof op.est_seconds === 'number' && op.est_seconds > 0 ? op.est_seconds : undefined,
    });
  }
  return catalog;
}

// ── 校验 + 定价 ──

export function validatePlan(plan: ExecutionPlan, catalog: OpCatalog): PlanVerdict {
  const reasons: string[] = [];
  if (!plan.goal.trim()) reasons.push('缺少 goal：一句话说明本任务要回答什么');
  if (plan.readOps.length === 0) reasons.push('authority.read 为空：至少申报一个要用的查询脚本');
  if (plan.writeOps.length > 0) reasons.push('worker 方案不允许申报 write——落账只经服务端两步确认，write 必须为空');
  if (!plan.maxGateCalls || plan.maxGateCalls < 1) reasons.push('constraints.max_gate_calls 缺失或非法（1-' + HARD_MAX_GATE_CALLS + '）');

  const unknown = plan.readOps.filter((op) => catalog.size > 0 && !catalog.has(basename(op)));
  if (unknown.length) reasons.push(`authority.read 含未登记脚本: ${unknown.join(', ')}（以平台清单为准）`);

  if (plan.periods.length > MAX_PERIODS_WITHOUT_JUSTIFICATION && !plan.justification?.trim()) {
    reasons.push(`期间数 ${plan.periods.length} > ${MAX_PERIODS_WITHOUT_JUSTIFICATION}，须在 constraints.justification 说明为何需要跨期回溯`);
  }
  if (reasons.length) return { ok: false, reasons };

  const limit = Math.min(plan.maxGateCalls, HARD_MAX_GATE_CALLS);
  const estimate = estimateWeight(plan, catalog);
  const notices: string[] = [];
  if (plan.maxGateCalls > HARD_MAX_GATE_CALLS) notices.push(`自报预算 ${plan.maxGateCalls} 超硬上限，已截到 ${HARD_MAX_GATE_CALLS}`);
  if (estimate.calls > limit) notices.push(`预估调用 ${estimate.calls} 次已超预算 ${limit}——执行中会提前被剪断，建议缩小 resources`);
  // 重方案不自动批准：预估超过阈值且用户未确认 → 转用户确认
  const needsConfirm = estimate.calls > PLAN_CONFIRM_THRESHOLD && !plan.userConfirmed;
  return { ok: true, plan, limit, estimate, notices, needsConfirm };
}

export function estimateWeight(plan: ExecutionPlan, catalog: OpCatalog): PlanEstimate {
  const multiplicity = Math.max(1, plan.accountSets.length || 1) * Math.max(1, plan.periods.length || 1);
  let calls = 0;
  let seconds = 0;
  for (const op of plan.readOps) {
    const entry = catalog.get(basename(op));
    const effects = entry?.effects ?? ['read'];
    const perCall = entry?.estSeconds
      ?? (effects.includes('write') ? OP_COST_SECONDS.write
        : effects.includes('local') ? OP_COST_SECONDS.local
        : OP_COST_SECONDS.browserRead);
    const n = effects.includes('local') ? 1 : multiplicity;
    calls += n;
    seconds += n * perCall;
  }
  return { calls, seconds };
}

export function basename(op: string): string {
  const file = op.split('/').pop()!.replace(/\.(js|py)$/, '');
  // 归一多种写法到同一键：操作名（domain.short）、脚本文件名（含/不含扩展名）、脚本路径
  return file.includes('.') ? file.split('.').pop()! : file;
}

// ── 预算台账（每任务一份，随 G1 实例存续）──

export class PlanBudget {
  readonly declared: Set<string>;
  readonly plan: ExecutionPlan;
  readonly limit: number;
  used = 0;

  constructor(verdict: Extract<PlanVerdict, { ok: true }>) {
    this.plan = verdict.plan;
    this.limit = verdict.limit;
    this.declared = new Set(verdict.plan.readOps.map(basename));
  }

  /** 执行的脚本是否在方案 authority 内；返回 null 表示无法判定（放行并只计预算）。 */
  coversScript(scriptArg: string): boolean | null {
    if (this.declared.size === 0) return null;
    const name = basename(scriptArg);
    return this.declared.has(name);
  }

  consume(): number { return ++this.used; }
  get exhausted(): boolean { return this.used > this.limit; }
}
