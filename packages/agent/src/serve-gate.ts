/**
 * G1：serve worker 原生工具门（fshine 侧，挂在 SDK Agent 的 beforeToolCall）。
 *
 * 三层门里本门最靠前，管 worker 的原生工具面：
 *   - bash 仅允许 serve.sh（首词规则，env 前缀天然被拒，法域声明无法剥离）
 *   - read/grep/find/ls 拒绝敏感路径（凭据、会话态、浏览器登录态）
 *   - 其余放行；工具集本就不含写类工具
 * 平台侧 G2（serve.sh 网关）与 G3（withPlatform 守卫）负责执行器层面的裁决。
 *
 * 已知残余：grep/find/ls 不带 path 参数时为仓库根全扫，可能遍历 .runtime/
 * 内容——同一登录态 worker 本就经执行器使用该会话，V0 接受并留痕。
 */

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

const SENSITIVE_PATH = [
  /(^|\/)\.env(\.[^/]*)?$/,           // .env / .env.local …
  /(^|\/)\.runtime(\/|$)/,            // 会话凭据、令牌缓存、审计
  /(^|\/)auth\.json$/,                // 平台会话 token
  /(^|\/)\.browser-profile(\/|$)/,    // 浏览器登录态
];
const PATH_ARGS = ['file_path', 'path'];

/** 首词规则：[bash|sh] [路径/]serve.sh；env 前缀（FOO=bar serve.sh）天然不匹配 */
export function isServeShInvocation(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === 'bash' || tokens[0] === 'sh') tokens.shift();
  const head = tokens[0];
  if (!head) return false;
  return head.split('/').pop() === 'serve.sh';
}

function sensitiveHit(value: string): string | null {
  for (const re of SENSITIVE_PATH) {
    if (re.test(value)) return value;
  }
  return null;
}

export function createServeGate(onEvent?: (event: ServeGateEvent) => void) {
  return (toolCall: ServeGateToolCall): ServeGateVerdict | undefined => {
    const name = toolCall.name;
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    let verdict: ServeGateVerdict | undefined;
    let detail = '';

    if (name === 'bash') {
      const command = String(args['command'] ?? '').trim();
      detail = command;
      if (!isServeShInvocation(command)) {
        verdict = { block: true, reason: '运行态 bash 仅允许调用 serve.sh（平台执行器网关）；知识检索用 read/grep 工具' };
      }
    } else {
      for (const key of PATH_ARGS) {
        const value = args[key];
        if (typeof value !== 'string') continue;
        detail = value;
        if (sensitiveHit(value)) {
          verdict = { block: true, reason: `运行态禁止读取敏感路径（${value}）` };
          break;
        }
      }
    }
    // 审计故障不得影响门裁决
    try {
      onEvent?.({ tool: name, allowed: !verdict, reason: verdict?.reason, detail: detail.slice(0, 200) });
    } catch {}
    return verdict;
  };
}
