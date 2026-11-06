/**
 * 启动模式的一行可观测日志（2026-10-21 真平台切换事故的 observability 补丁）。
 *
 * 事故形状：重启切真平台后，从进程外判断"现在跑的是什么模式"需要法医式核查——
 * `/proc/PID/environ` 只反映 execve 时刻的环境，看不到 node `--env-file` 启动后写进
 * `process.env` 的键；而 `.env` 文件又会**静默败给**启动 shell 里已 export 的同名变量
 * （node --env-file 不覆盖已有变量）。结果是"改了配置但不知道生没生效"，模式成了
 * 不可观测事实。修法：启动时把**生效模式**打成一日志行，一眼可查。
 *
 * 安全边界：只读三个模式键（执行器 / 运维授权 / 写授权），**绝不全量打印 env**——
 * `.env` 里有 LLM 密钥，全量落日志等于把密钥写盘。三个键都是开关量（'mock' / '1' /
 * 空），不含敏感信息。
 *
 * 判据复用不重抄：执行器判定用 `@fshine/agent` 的 `isPlatformMock`（与业务代码同一把尺）；
 * `EXECUTION_ALLOW_REAL` 的权威在执行层平台仓 `src/lib/real-execution.js`（fail-closed 门，
 * 2026-10-12 加），这里只为日志读它。
 */
import { isPlatformMock, MOCK_EXECUTOR_ENV, REAL_COMMIT_ENV } from '@fshine/agent';

/**
 * 真平台运维授权（平台仓 `src/lib/real-execution.js` 的 fail-closed 门）：
 * 非 mock 且触平台的执行必须显式 `EXECUTION_ALLOW_REAL=1`，否则 REAL_EXECUTION_NOT_ALLOWED。
 * 只认字面量 '1'（'true'/'yes'/'0' 都不算——模糊真值是 fail-open 的入口）。
 */
export const ALLOW_REAL_ENV = 'EXECUTION_ALLOW_REAL'; // 旧名 DZ_ALLOW_REAL（兼容保留）

export interface RuntimeModeSummary {
  /** mock = 应答器替身（不触平台）；real = 真平台执行器（EXECUTION_EXECUTOR 空/未设/怪值） */
  executor: 'mock' | 'real';
  /** EXECUTION_EXECUTOR 原值：空串 = 置空/未设；怪值（如 'Mock'）原样露出便于诊断 */
  executorRaw: string;
  /** EXECUTION_ALLOW_REAL === '1'：触平台执行的运维授权（real 之下缺它 = 执行被门拒绝） */
  realExecutionAllowed: boolean;
  /** FSHINE_REAL_COMMIT === '1'：真平台写落账授权（缺它 = 确认码到 confirm_held，不写） */
  realCommitAuthorized: boolean;
  /** 人类可读的一句话结论（日志的主要消费者是人） */
  note: string;
}

/** 从环境解析生效模式。纯函数：同一个 env 进，同一句结论出（测试可穷尽）。 */
export function runtimeModeOf(env: NodeJS.ProcessEnv): RuntimeModeSummary {
  const executorRaw = env[MOCK_EXECUTOR_ENV] ?? '';
  const executor = isPlatformMock(env) ? 'mock' : 'real';
  const realExecutionAllowed = env[ALLOW_REAL_ENV] === '1';
  const realCommitAuthorized = env[REAL_COMMIT_ENV] === '1';
  return { executor, executorRaw, realExecutionAllowed, realCommitAuthorized, note: noteOf(executor, realExecutionAllowed, realCommitAuthorized) };
}

function noteOf(
  executor: 'mock' | 'real',
  realExecutionAllowed: boolean,
  realCommitAuthorized: boolean,
): string {
  if (executor === 'mock') {
    return 'executor=mock：平台查询由 mock 应答器应答，不触真平台（授权/写闸在 mock 下无意义）';
  }
  if (!realExecutionAllowed) {
    return 'executor=real 但 EXECUTION_ALLOW_REAL≠1：触平台执行将被拒绝（REAL_EXECUTION_NOT_ALLOWED），纯本地计算不受影响';
  }
  return realCommitAuthorized
    ? 'executor=real 且 EXECUTION_ALLOW_REAL=1：触平台执行已授权；FSHINE_REAL_COMMIT=1：真平台写落账已授权'
    : 'executor=real 且 EXECUTION_ALLOW_REAL=1：触平台执行已授权；真平台写落账未授权（FSHINE_REAL_COMMIT≠1，确认码将到达 confirm_held）';
}
