/**
 * G1：serve worker 原生工具门（fshine 侧，挂在 SDK Agent 的 beforeToolCall）。
 *
 * 四层治理里本门负责 worker 的通用原生工具安全：
 *   - bash 仅允许 bin/17dz（首词规则 + shell 元字符白名单：env 前缀、命令拼接、
 *     命令替换、重定向均被拒；法域声明无法剥离）
 *   - 平台计划命令只允许 host 管理；活跃计划由平台执行入口逐次校验
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

export interface ServeGateEvent {
  tool: string;
  allowed: boolean;
  reason?: string;
  /** 脱敏留痕：bash 命令或目标路径 */
  detail?: string;
  /** 请求级关联 id（审计串查 fshine ↔ 平台） */
  requestId?: string;
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
  /** Platform-backed plan active for this worker session. */
  planActive?: () => boolean;
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

  const knowledgeBlock = (value: string): ServeGateVerdict => ({
    block: true,
    reason: `运行态仅可读知识面（*.md、*.schema.json、.agents/、docs/），不可读实现源码或运行产物（${value}）。需要平台能力时走 bin/17dz 网关`,
  });

  return (toolCall: ServeGateToolCall): ServeGateVerdict | undefined => {
    const name = toolCall.name;
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    let verdict: ServeGateVerdict | undefined;
    let detail = '';

    if (name === 'bash') {
      const command = String(args['command'] ?? '').trim();
      detail = command;
      if (/(?:^|\s)(?:[^\s]+\/)?bin\/17dz\s+plan(?:\s|$)/.test(command)) {
        verdict = { block: true, reason: '计划管理命令由宿主控制；worker 只能提交 JSON calls 方案，由宿主调用计划 CLI。' };
      } else if (!isServeCliInvocation(command)) {
        verdict = { block: true, reason: '运行态 bash 仅允许调用 bin/17dz（平台执行器网关）；知识检索用 read 工具' };
      } else if (hasShellMetachars(command)) {
        verdict = { block: true, reason: '命令含 shell 元字符（; & | < > ` $ ( ) 或换行），禁止命令拼接/替换/重定向。多次查询请分多次 bin/17dz 调用' };
      } else if (!options.planActive?.()) {
        verdict = { block: true, reason: '尚无宿主激活的平台计划；先提交 JSON calls 方案等待宿主评估。' };
      } else {
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
      });
    } catch {}
    return verdict;
  };
}
