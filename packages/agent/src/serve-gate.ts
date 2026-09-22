/**
 * G1：serve worker 原生工具门（fshine 侧，挂在 SDK Agent 的 beforeToolCall）。
 *
 * 四层治理里本门最靠前，管 worker 的原生工具面与执行面预算：
 *   - 首条 bash 必须是 `bin/17dz plan` + YAML 执行方案；G1 拦截定价（不下发平台），
 *     审批结果经拦截消息回给模型（协议约定：这是正常流程，不是错误）
 *   - bash 仅允许 bin/17dz（首词规则 + shell 元字符白名单：env 前缀、命令拼接、
 *     命令替换、重定向均被拒；法域声明无法剥离）
 *   - 方案内记账：每次 gate 调用消耗预算，超限剪断；未申报脚本拒绝
 *   - read/ls 限知识面（*.md、*.schema.json、.agents/、docs/）——实现源码不可读；
 *     worker 工具面已无 grep/find，代码扫描失去入口。路径经 workspaceRelPath
 *     规范化后判定（platformRoot 即 worker cwd）：../ 穿越、绝对路径越界、
 *     符号链接逃逸一律拒，子串规则只作兜底
 * 平台侧 G2（bin/17dz 网关）与 G3（serve-policy/withPlatform 守卫）负责执行器裁决。
 *
 * 已知残余：ls 不带 path 时仅见根目录名，信息量低，放行留痕。
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  HARD_MAX_GATE_CALLS,
  PLAN_CONFIRM_THRESHOLD,
  PLAN_EXAMPLE,
  PlanBudget,
  loadOpCatalog,
  parsePlanCommand,
  validatePlan,
  type ExecutionPlan,
  type OpCatalog,
} from './execution-plan';

export interface ServeGateEvent {
  tool: string;
  allowed: boolean;
  reason?: string;
  /** 脱敏留痕：bash 命令或目标路径 */
  detail?: string;
  /** 请求级关联 id（审计串查 fshine ↔ 平台） */
  requestId?: string;
  /** bash 事件附带当前预算快照（供执行面回执） */
  budget?: { used: number; limit: number };
}

export interface ServeGateVerdict {
  block?: boolean;
  reason?: string;
}

export interface ServeGateToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ServeGateOptions {
  onEvent?: (event: ServeGateEvent) => void;
  /** 平台根目录：用于经公共 CLI 派生能力清单（定价与脚本存在性校验）。缺省降级。 */
  platformRoot?: string;
  /** 知识面规则（read/ls 白名单），缺省内置。 */
  knowledgePaths?: readonly string[];
  /** 敏感路径规则，缺省内置。 */
  sensitivePaths?: readonly string[];
}

const DEFAULT_SENSITIVE_PATHS = ['.env', '.runtime/', 'auth.json', '.browser-profile/'];
const DEFAULT_KNOWLEDGE_PATHS = ['.md', '.schema.json', '.agents/', 'docs/'];
const PATH_ARGS = ['file_path', 'path'];

function matchesAny(value: string, rules: readonly string[]): boolean {
  return rules.some((rule) => value.includes(rule) || value.endsWith(rule));
}

/** 知识面匹配：子串规则之外，目录本身恰是知识根（docs ↔ 规则 docs/）也放行 */
function knowledgeMatch(value: string, rules: readonly string[]): boolean {
  return matchesAny(value, rules) || rules.some((rule) => rule.endsWith('/') && rule.slice(0, -1) === value);
}

/**
 * 把 read/ls 的参数解析为工作区内相对路径；越界返回 null。
 * 词法层挡 ../ 与绝对路径穿越；再沿最近存在祖先做 realpath，挡符号链接逃逸
 * （如 docs -> /etc 时 docs/../ 词法上仍在内、内核解析却出界）。
 */
export function workspaceRelPath(root: string, value: string): string | null {
  if (value.includes('\0')) return null;
  const abs = path.resolve(root, value);
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  let probe = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      const full = suffix.length ? path.join(real, ...suffix) : real;
      const realRel = path.relative(root, full);
      if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) return null;
      return realRel;
    } catch (e) {
      // 目标不存在：符号链接无从指向真实文件，词法检查已够；其余错误（权限/循环）拒绝
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/** 首词规则：[bash|sh] [路径/]bin/17dz；env 前缀（FOO=bar bin/17dz）天然不匹配 */
export function isServeCliInvocation(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === 'bash' || tokens[0] === 'sh') tokens.shift();
  const head = tokens[0];
  if (!head) return false;
  return /(^|\/)bin\/17dz$/.test(head);
}

// 命令拼接/替换/重定向/管道：worker bash 经 shell 执行，放行这些字符等于放行任意命令
const SHELL_METACHAR_RE = /[;&|<>`$()\n\r]/;

/** 命令含 shell 元字符（; & | < > ` $ ( ) 或换行）→ true。bin/17dz 的合法参数（账套名、期间、脚本路径、flag）不含这些字符 */
export function hasShellMetachars(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}

/** 从网关调用中提取脚本参数（bin/17dz <mode> <script> …），非查询型返回 null */
export function extractGateScript(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === 'bash' || tokens[0] === 'sh') tokens.shift();
  if (tokens[1] === 'operation' && tokens[2] === 'run') return tokens[3] ?? null;
  if (['query', 'prepare', 'commit'].includes(tokens[1] ?? '')) return tokens[2] ?? null;
  return null;
}

export function createServeGate(options: ServeGateOptions = {}) {
  const { onEvent, platformRoot } = options;
  const sensitivePaths = options.sensitivePaths ?? DEFAULT_SENSITIVE_PATHS;
  const knowledgePaths = options.knowledgePaths ?? DEFAULT_KNOWLEDGE_PATHS;
  // 每任务新建 gate 实例 → 方案/预算状态天然按任务隔离
  let catalog: OpCatalog | null = null;
  let budget: PlanBudget | null = null;
  let rePlans = 0;
  let awaitingConfirm = false;

  const knowledgeBlock = (value: string): ServeGateVerdict => ({
    block: true,
    reason: `运行态仅可读知识面（*.md、*.schema.json、.agents/、docs/），不可读实现源码或运行产物（${value}）。需要平台能力时走 bin/17dz 网关`,
  });

  function handlePlanSubmission(plan: ExecutionPlan): string {
    const verdict = validatePlan(plan, catalog ?? new Map());
    if (!verdict.ok) {
      return [
        'PLAN DECLINED',
        ...verdict.reasons.map((r) => `- ${r}`),
        `标准格式（单行 JSON，原样重提即可）：${PLAN_EXAMPLE}`,
      ].join('\n');
    }
    if (verdict.needsConfirm) {
      // 重方案不自动批准：转用户确认。不建预算——方案待确认期间一切 bash 拒绝。
      awaitingConfirm = true;
      const minutes = Math.round((verdict.estimate.seconds / 60) * 10) / 10;
      return [
        'PLAN NEEDS_USER_CONFIRM',
        `预估平台调用 ${verdict.estimate.calls} 次 ≈ ${minutes} 分钟，超过自动审批阈值 ${PLAN_CONFIRM_THRESHOLD}。`,
        '结束回合向用户转达执行重量并请求确认（可同时给出缩小方案的可选项）；',
        '用户同意后重报本方案并附 "user_confirmed": true（justification 注明用户已确认）即可执行；',
        '或缩小 resources（减少期间/账套）至阈值内自动执行。',
      ].join('\n');
    }
    if (budget) rePlans += 1;
    if (rePlans > 2) {
      return `PLAN DECLINED 方案已重报 ${rePlans} 次——任务超出单轮合理执行面。直接向用户说明已查明/未查明的内容，并请求拆分或换口径。`;
    }
    awaitingConfirm = false;
    budget = new PlanBudget(verdict);
    const minutes = Math.round((verdict.estimate.seconds / 60) * 10) / 10;
    return [
      `PLAN APPROVED（方案即预算：超限或调用未申报脚本会被拒）`,
      ...(verdict.plan.userConfirmed ? ['按用户已确认的执行重量放行（留痕）。'] : []),
      `预算 ${budget.limit}/${HARD_MAX_GATE_CALLS} 次 gate 调用；预估平台调用 ${verdict.estimate.calls} 次 ≈ ${minutes} 分钟`,
      ...verdict.notices.map((n) => `注意: ${n}`),
      `完成后对照 completion 逐项收尾：${verdict.plan.completion.join('、') || '（未声明）'}`,
    ].join('\n');
  }

  return (toolCall: ServeGateToolCall): ServeGateVerdict | undefined => {
    const name = toolCall.name;
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    let verdict: ServeGateVerdict | undefined;
    let detail = '';

    if (name === 'bash') {
      const command = String(args['command'] ?? '').trim();
      detail = command;
      const planCommand = parsePlanCommand(command);
      if (planCommand) {
        // 方案提交永不直达平台；审批消息借拦截通道回给模型
        if (catalog === null && platformRoot) catalog = loadOpCatalog(platformRoot);
        verdict = { block: true, reason: handlePlanSubmission(planCommand) };
      } else if (!isServeCliInvocation(command)) {
        verdict = { block: true, reason: '运行态 bash 仅允许调用 bin/17dz（平台执行器网关）；知识检索用 read 工具' };
      } else if (hasShellMetachars(command)) {
        verdict = { block: true, reason: '命令含 shell 元字符（; & | < > ` $ ( ) 或换行），禁止命令拼接/替换/重定向。多次查询请分多次 bin/17dz 调用' };
      } else if (!budget) {
        verdict = awaitingConfirm
          ? { block: true, reason: '方案待用户确认（PLAN NEEDS_USER_CONFIRM）：先结束回合向用户转达执行重量并请求确认；用户同意后重报方案附 "user_confirmed": true' }
          : { block: true, reason: '尚未提交执行方案。首条命令须为 bin/17dz plan + JSON 方案（协议见系统提示词）' };
      } else {
        const scriptArg = extractGateScript(command);
        if (scriptArg && budget.coversScript(scriptArg) === false) {
          verdict = {
            block: true,
            reason: `脚本 ${scriptArg} 不在方案 authority 内（已申报: ${[...budget.declared].map((s) => s + '.js').join(', ')}）。缩小任务或重报 bin/17dz plan`,
          };
        } else {
          const usedNow = budget.consume();
          if (budget.exhausted) {
            verdict = {
              block: true,
              reason: `执行预算已用尽（${usedNow}/${budget.limit}）。先收尾：汇总已有信息作答；确需扩大执行面，重报 bin/17dz plan 并在 goal/justification 说明理由`,
            };
          }
        }
      }
    } else {
      for (const key of PATH_ARGS) {
        const raw = args[key];
        if (typeof raw !== 'string') continue;
        detail = raw;
        // 解析后判定：穿越/越界/符号链接逃逸在此被拒；platformRoot 缺省时退回子串兜底
        let value = raw;
        if (platformRoot) {
          const rel = workspaceRelPath(platformRoot, raw);
          if (rel === null) {
            verdict = { block: true, reason: `运行态禁止读取工作区外路径（${raw}）` };
            break;
          }
          value = rel;
        }
        if (matchesAny(value, sensitivePaths)) {
          verdict = { block: true, reason: `运行态禁止读取敏感路径（${raw}）` };
          break;
        }
        if (name === 'read' || (name === 'ls' && key === 'path')) {
          // read 全面限知识面；ls 仅在有 path 时约束（无 path 仅见根目录名）
          if (!knowledgeMatch(value, knowledgePaths)) {
            verdict = knowledgeBlock(raw);
            break;
          }
        }
      }
    }
    // 审计故障不得影响门裁决
    try {
      onEvent?.({
        tool: name,
        allowed: !verdict,
        reason: verdict?.reason,
        detail: detail.slice(0, 200),
        ...(name === 'bash' && budget ? { budget: { used: budget.used, limit: budget.limit } } : {}),
      });
    } catch {}
    return verdict;
  };
}
