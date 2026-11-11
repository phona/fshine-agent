/**
 * T10 段2：停滞检测（progress-based，2026-11-11 前零机制）。
 *
 * 事故形状：worker 没报错、没到截止，但结果指标长时间一动不动——它在假死。今天没有
 * 任何机制能看见这件事：墙钟预算只处理"跑到截止"，熔断器数的是**失败**，而假死
 * 不产生失败，所以熔断对假死结构上是瞎的（两类各走各的路，本模块不产出 failure
 * 分类，也不往熔断器里塞任何东西）。
 *
 * 判据的唯一输入是**宿主独立读**的执行层结果指标（执行层状态；调用方经
 * TaskResultPort.observe 取到）。worker 自报的进度（onStep / 文本）一律不进本模块
 * ——worker 不可能知道自己在假死，它的"我还在跑"不构成证据。空转的模型会一直
 * 说自己有进展；指标不动就是不动。
 *
 * 输出只有判定与留痕字段：**不杀进程、不重跑**。冻结与续跑是调用方的事（任务生命
 * 周期：冻结 → 同一 taskId 从持久化断点续跑），本模块不做任何副作用。
 *
 * 纯函数 + 定时器分离：`evaluateStagnation` 可用纯数据钉住语义，`startStallMonitor`
 * 只负责按间隔采样并在判定成立时回调一次。
 */
import type { ResultObservation } from './result-contract';

/** 一次宿主独立读：采样时刻（毫秒）与该指标的实际值。 */
export interface StallSample {
  at: number;
  value: number;
}

export type StallReason =
  | 'stalled'
  | 'progress'
  | 'insufficient_samples'
  | 'deadline_reached'
  | 'aborted'
  | 'stopped';

export interface StallVerdict {
  stalled: boolean;
  /** 被观测的指标名（执行层词汇；未采到任何值时为空串）。 */
  metric: string;
  lastValue: number | null;
  /** 当前等值运行段（末尾连续相同值）已持续的时长；判定不成立时也如实给出。 */
  unchangedForMs: number;
  /** 本次观测到的采样数（null 读回不计入）。 */
  samples: number;
  reason: StallReason;
}

/**
 * 纯判定：末尾连续相同的值持续 >= unchangedForMs 即 stalled。
 *
 * 为什么看"末尾等值段"而不是"最早与最新两次采样"：指标可以中途变化又回来，只有
 * **连续不变**才是停滞；中途变过就说明进程还在产生新结果，窗口从最后一次变化重新起算。
 */
export function evaluateStagnation(input: {
  samples: readonly StallSample[];
  now: number;
  unchangedForMs: number;
}): StallVerdict {
  const { samples, now, unchangedForMs } = input;
  if (samples.length === 0) {
    return { stalled: false, metric: '', lastValue: null, unchangedForMs: 0, samples: 0, reason: 'insufficient_samples' };
  }
  const last = samples[samples.length - 1]!;
  let runStart = samples.length - 1;
  while (runStart > 0 && samples[runStart - 1]!.value === last.value) runStart -= 1;
  const heldFor = Math.max(0, now - samples[runStart]!.at);
  if (samples.length < 2) {
    return { stalled: false, metric: '', lastValue: last.value, unchangedForMs: heldFor, samples: samples.length, reason: 'insufficient_samples' };
  }
  const stalled = heldFor >= unchangedForMs;
  return {
    stalled,
    metric: '',
    lastValue: last.value,
    unchangedForMs: heldFor,
    samples: samples.length,
    reason: stalled ? 'stalled' : 'progress',
  };
}

export interface StallMonitorOptions {
  /** 宿主独立读执行层状态。抛错/返回 null = 这次读不到（跳过采样，不编造值）。 */
  observe: () => Promise<readonly ResultObservation[] | null>;
  /** 观测哪个指标；缺省 = 每次取执行层返回的第一项。 */
  metric?: string;
  /** 采样间隔（毫秒）。生产应显著小于 unchangedForMs，测试用毫秒级替身。 */
  sampleIntervalMs: number;
  /** 结果指标连续不变多久判假死（毫秒）。 */
  unchangedForMs: number;
  /** 时钟替身（测试可注入）；缺省 Date.now。 */
  now?: () => number;
  /** worker 截止时刻：到点即停——到截止的收尾归既有 timeout 分类，本检测不越权。 */
  deadline?: number;
  /** 中止信号：取消优先于停滞，aborted 后不再判假死。 */
  signal?: AbortSignal;
  /** 判定成立时回调一次（留痕/冻结由调用方做）。 */
  onStall?: (verdict: StallVerdict) => void | Promise<void>;
}

export interface StallMonitorHandle {
  /** 停止采样并返回最终判定（幂等；重复调用拿到同一份）。 */
  stop(): Promise<StallVerdict>;
  /** 已经做出的判定（未采样/未停止时为 null）。 */
  readonly verdict: StallVerdict | null;
}

/**
 * 假死冻结的用户可见终稿。措辞纪律：
 *   · 说"暂停"与"可续跑"，绝不说"已完成/成功"；
 *   · 不出现执行层实现细节（脚本名/写标志/错误码）；
 *   · 不承诺进程已被杀掉——检测只冻结后续步骤，正在跑的那一次不中断。
 */
export function renderStalledReply(verdict: StallVerdict): string {
  const held = Math.max(0, Math.round(verdict.unchangedForMs / 1000));
  const window = held >= 1 ? `约 ${held} 秒` : '本次采样窗口内';
  return [
    `[任务已暂停] 本任务在${window}没有可核实的结果进展，已暂停后续步骤；正在运行的那一次执行没有被终止。`,
    '已发生的工作痕迹已保留，可回复“继续”从断点续跑。',
  ].join('\n');
}

const NO_SAMPLES: StallVerdict = {
  stalled: false,
  metric: '',
  lastValue: null,
  unchangedForMs: 0,
  samples: 0,
  reason: 'stopped',
};

/**
 * 按间隔采样并判停滞。只调用 observe（宿主独立读），不接受任何 worker 进度输入。
 * 定时器 unref：监视器不阻止进程退出。
 */
export function startStallMonitor(options: StallMonitorOptions): StallMonitorHandle {
  const now = options.now ?? Date.now;
  const samples: StallSample[] = [];
  let metric = options.metric ?? '';
  let stopped = false;
  let final: StallVerdict | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: ((verdict: StallVerdict) => void) | undefined;
  const done = new Promise<StallVerdict>((resolve) => { resolveDone = resolve; });

  const finish = (verdict: StallVerdict): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    final = verdict;
    resolveDone?.(verdict);
  };

  const finishWithReason = (reason: 'deadline_reached' | 'aborted' | 'stopped'): void => {
    const last = samples[samples.length - 1];
    finish({
      stalled: false,
      metric,
      lastValue: last ? last.value : null,
      unchangedForMs: last ? Math.max(0, now() - (samples[samples.length - 1]?.at ?? now())) : 0,
      samples: samples.length,
      reason,
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (options.signal?.aborted) return finishWithReason('aborted');
    if (options.deadline !== undefined && now() >= options.deadline) return finishWithReason('deadline_reached');
    let picked: ResultObservation | undefined;
    try {
      const observations = await options.observe();
      if (observations && observations.length > 0) {
        picked = metric ? observations.find((item) => item.metric === metric) : observations[0];
        if (!picked && !metric) picked = observations[0];
      }
    } catch {
      // 读不到不是假死证据：跳过本次采样，下一次再试。宿主读故障不得伪装成停滞。
      picked = undefined;
    }
    if (stopped) return;
    if (picked) {
      metric = picked.metric;
      samples.push({ at: now(), value: picked.actual });
    }
    const verdict = evaluateStagnation({ samples, now: now(), unchangedForMs: options.unchangedForMs });
    verdict.metric = metric;
    final = verdict;
    if (verdict.stalled) {
      await options.onStall?.(verdict);
      finish(verdict);
      return;
    }
    timer = setTimeout(() => { void tick(); }, options.sampleIntervalMs);
    timer.unref?.();
  };

  timer = setTimeout(() => { void tick(); }, options.sampleIntervalMs);
  timer.unref?.();

  return {
    get verdict() { return final; },
    stop: async (): Promise<StallVerdict> => {
      if (final) return final;
      finishWithReason('stopped');
      return final ?? NO_SAMPLES;
    },
  };
}
