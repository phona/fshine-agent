/**
 * 平台健康信号（Lane 2「治标补法」）：宿主侧的连续 AUTH 类失败感知 + 冷却 + 健康消息。
 *
 * 为什么需要它（2026-09-29 真实模式实测，平台登录失效）：agent 行为已有边界——一次
 * 调用失败 + 平台自动重登录一次 + 停止，回复诚实（"平台登录凭据已过期，系统自动重登录
 * 失败……不会给出任何估算或编造金额"）。缺口有两个：① 用户连发多轮时会**轮轮重试**
 * （每轮都真调一次平台：一次浏览器自动化 + 一个限流 token + 用户 10-60s 等待，而结论
 * 早就确定）；② 归因靠平台登录层转述（登录页改版被说成"账号密码校验未通过"，用户被
 * 导向"查密码"而真解是"更新登录自动化"）。本模块补宿主侧感知：同一会话连续 AUTH 类
 * 平台失败达阈值 → 进入冷却；冷却期内新回合不再发起平台调用（宿主前置拦截，省足迹也省
 * 用户等待），终稿由宿主合成（PLATFORM_UNAVAILABLE，措辞唯一来源在 error-codes.ts）。
 *
 * 失败判据是**码级**的（platform-contract 的 PLATFORM_AUTH_ERROR_CODES + 委派层挂码），
 * 绝不对 worker 自由文本做模糊匹配——那是猜，不是事实（与 needs/澄清的派生同纪律）。
 *
 * 与既有机制的分工（正交，不重复不替代）：
 *   · 平台网关限流（DZ_RATE_LIMIT 令牌桶）治"调用太频"——本模块治"平台根本不可用"；
 *   · 计划门/纠错环的 MAX_* 收敛（MAX_PLAN_ZERO_EXEC_STEPS / MAX_DECLINED_PLANS_PER_TASK /
 *     MAX_NEEDS_ROUNDS）治"模型在同一回合/同一任务里空转"——本模块治"跨回合的逐轮重试
 *     式重查"：一个在回合内，一个跨回合；
 *   · 委派并发闸（FSHINE_PLATFORM_CONCURRENCY）治"共享登录态浏览器的互斥"——本模块不
 *     改变并发语义，只决定"这一回合还发不发起调用"。
 *
 * 有界性：每轮冷却都要求用户先发一句话，且冷却时长本身有界（默认 10 分钟）——不存在
 * 无等待的重试循环；冷却结束后的探测性调用若再失败，只是再进一轮等长冷却。全回路的
 * 最终兜底仍是既有 MAX_* 系列与本模块的时长上限，不会互相拆台。
 */
import { platformUnavailableTextFor } from './error-codes';

/**
 * 时钟注入（与 context-model 的 ContextModelClock 同族）：冷却判定只认 `now()`，
 * 测试推时钟即可验证"冷却中 / 已到期"，不需要真等 10 分钟。
 */
export interface PlatformHealthClock {
  now(): number;
}

const defaultClock: PlatformHealthClock = { now: () => Date.now() };

/**
 * 连续 AUTH 类平台失败达此数 → 会话进入冷却。默认 2：单次失败可能是瞬时抖动
 * （平台 runWithAuth 本就地重登录自愈过），第二次才值得暂停——阈值固定不设 env，
 * 要调（测试/特例部署）经 runtime 依赖注入。
 */
export const DEFAULT_PLATFORM_AUTH_FAILURE_THRESHOLD = 2;

/**
 * 冷却时长默认 10 分钟：与委派意图 TTL（context.ts 的 10 分钟）同量级——足够平台侧
 * 完成一次登录修复，又不让用户长时间干等。部署侧可用 FSHINE_PLATFORM_COOLDOWN_MS 覆盖
 * （assembly.ts 接线，.env.example 有文档）。
 */
export const DEFAULT_PLATFORM_COOLDOWN_MS = 10 * 60_000;

const MS_PER_MINUTE = 60_000;

/**
 * 委派层 auth 失败的挂码（context.ts 的失败分类经 toolUserErrorFor 挂在这个码上）。
 * 这是 fshine 侧消息码、不是平台码——平台码判据在 platform-contract 的
 * isPlatformAuthError（AUTH_* 四档 + NEEDS_LOGIN），信封路径由结果字段 authFailure 上交。
 */
const DELEGATION_AUTH_FAILURE_CODE = 'DELEGATION_AUTH_FAILURE';

interface SessionHealth {
  /** 连续 AUTH 类平台失败次数（被任何"平台健康已恢复"的回合清零）。 */
  consecutiveAuthFailures: number;
  /** 冷却到期时刻（clock.now() 基准）；0 = 不在冷却。 */
  cooldownUntil: number;
}

export interface PlatformHealthSnapshot {
  consecutiveAuthFailures: number;
  coolingDown: boolean;
  cooldownRemainingMs: number;
}

export interface PlatformHealthTrackerOptions {
  threshold?: number;
  cooldownMs?: number;
  clock?: PlatformHealthClock;
}

export interface PlatformHealthTracker {
  /** 冷却是否生效中（阈值已达且未到期）。冷却期内宿主不得发起平台调用。 */
  isCoolingDown(key: string): boolean;
  /** 冷却剩余毫秒（不在冷却 = 0）。 */
  cooldownRemainingMs(key: string): number;
  /** 当前连续失败计数（日志与测试用）。 */
  consecutiveAuthFailures(key: string): number;
  /** 冷却期用户可见文本：码表措辞 + 剩余分钟数（宿主时钟数据，见 error-codes.ts）。 */
  cooldownReply(key: string): string;
  /**
   * 冷却期拦截（宿主在 platformTask.run 之前调一次）：不在冷却返回 null；在冷却返回
   * **一次读取**同时取到的用户可见文本与日志载荷。
   *
   * 为什么要一个调用拿两样：日志里的 `consecutiveAuthFailures` 与 `cooldownRemainingMs`
   * 和回复里的剩余分钟数必须是同一时刻的事实。分三次读（isCoolingDown / 各自 getter）会
   * 在"刚好到期"的边界上各说各话——日志说还在冷却、回复说还剩 0 分钟。
   */
  cooldownBlock(key: string): { reply: string; event: Record<string, unknown> } | null;
  /** 一次 AUTH 类平台失败：计数 +1；达阈值即（重）进入冷却。返回记账后状态（日志用）。 */
  recordAuthFailure(key: string): PlatformHealthSnapshot;
  /** 平台健康已恢复（有执行痕迹的非 AUTH 回合）：计数清零、冷却解除。 */
  recordResolved(key: string): void;
}

/**
 * 委派失败的 auth 类码级判据（计数入口之一）：ToolUserError 挂码为
 * DELEGATION_AUTH_FAILURE 时成立。与信封路径（结果字段 authFailure）并列不合并——
 * 一个是"驱动抛出时委派层的分类"，一个是"驱动从平台信封派生的事实"，两条都机械。
 */
export function isAuthDelegationFailure(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === DELEGATION_AUTH_FAILURE_CODE;
}

export function createPlatformHealthTracker(options: PlatformHealthTrackerOptions = {}): PlatformHealthTracker {
  const threshold = options.threshold ?? DEFAULT_PLATFORM_AUTH_FAILURE_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? DEFAULT_PLATFORM_COOLDOWN_MS;
  const clock = options.clock ?? defaultClock;
  const sessions = new Map<string, SessionHealth>();

  // 读路径不建条目：没失败过的会话不占地图（地图只随"真失败过的会话"增长，且恢复即删）。
  const peek = (key: string): SessionHealth | undefined => sessions.get(key);
  const stateOf = (key: string): SessionHealth => {
    const existing = sessions.get(key);
    if (existing) return existing;
    const fresh: SessionHealth = { consecutiveAuthFailures: 0, cooldownUntil: 0 };
    sessions.set(key, fresh);
    return fresh;
  };
  const snapshotOf = (state: SessionHealth): PlatformHealthSnapshot => {
    const cooldownRemainingMs = Math.max(0, state.cooldownUntil - clock.now());
    return {
      consecutiveAuthFailures: state.consecutiveAuthFailures,
      coolingDown: cooldownRemainingMs > 0,
      cooldownRemainingMs,
    };
  };

  return {
    isCoolingDown: (key) => (peek(key)?.cooldownUntil ?? 0) > clock.now(),
    cooldownRemainingMs: (key) => Math.max(0, (peek(key)?.cooldownUntil ?? 0) - clock.now()),
    consecutiveAuthFailures: (key) => peek(key)?.consecutiveAuthFailures ?? 0,
    cooldownReply: (key) => platformUnavailableTextFor(
      Math.ceil(Math.max(0, (peek(key)?.cooldownUntil ?? 0) - clock.now()) / MS_PER_MINUTE),
    ),
    cooldownBlock: (key) => {
      const state = peek(key);
      const remainingMs = Math.max(0, (state?.cooldownUntil ?? 0) - clock.now());
      if (remainingMs <= 0) return null;
      return {
        reply: platformUnavailableTextFor(Math.ceil(remainingMs / MS_PER_MINUTE)),
        event: {
          consecutiveAuthFailures: state?.consecutiveAuthFailures ?? 0,
          cooldownRemainingMs: remainingMs,
        },
      };
    },
    recordAuthFailure: (key) => {
      const state = stateOf(key);
      state.consecutiveAuthFailures += 1;
      // 达阈值即（重）进入冷却：每次失败都把冷却窗口整体后移——探测失败后的新一轮冷却
      // 从"这次失败"起算，不是从上一轮冷却的残尾起算（否则窗口会被持续失败越拖越短）。
      if (state.consecutiveAuthFailures >= threshold) state.cooldownUntil = clock.now() + cooldownMs;
      return snapshotOf(state);
    },
    recordResolved: (key) => {
      // 健康已恢复：清零即删除条目——地图不随会话数增长，也不留"曾经坏过"的幽灵计数。
      sessions.delete(key);
    },
  };
}
