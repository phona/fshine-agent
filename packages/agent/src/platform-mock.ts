/**
 * 平台 mock 控制面（对接 17dz-platform 的 executor 开关，commit 376ea0d）。
 *
 * DZ_EXECUTOR=mock：平台网关把执行器替换为 mock 应答器（不开浏览器、不触网），
 * gate 矩阵/commit 令牌/审计照真生效。本模块只集中读开关与兜底状态路径，
 * 业务代码一律经 isPlatformMock() 判断，不散落 env 字符串。
 *
 * DZ_MOCK_STATE：平台侧必填（缺失 exit 3）。服务端在 boot 时兜底到
 * <平台根>/.runtime/mock-state.json（该目录已 gitignore）；env 已显式设置则不覆盖。
 * 重置 mock 状态 = 删掉该文件（下次调用自动从 seed.json 重新播种）。
 */
import path from 'node:path';

export const MOCK_EXECUTOR_ENV = 'DZ_EXECUTOR';
export const MOCK_STATE_ENV = 'DZ_MOCK_STATE';
export const REAL_COMMIT_ENV = 'FSHINE_REAL_COMMIT';

export function isPlatformMock(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MOCK_EXECUTOR_ENV] === 'mock';
}

/**
 * 落账总闸（派生规则，取代旧演练开关——那个开关名已退役，不再引用）：
 *   - mock 之下写的是假状态，落账全链路默认放开（这正是 mock 联调的价值）；
 *   - 真平台之下默认拒绝 commit，须显式 FSHINE_REAL_COMMIT=1 才放行真写。
 */
export function isCommitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPlatformMock(env) || env[REAL_COMMIT_ENV] === '1';
}

/** mock 开启但状态路径未设时兜底；须在 worker/commit 子进程产生前调用。 */
export function ensureMockStatePath(platformRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isPlatformMock(env)) return null;
  if (!env[MOCK_STATE_ENV]) {
    env[MOCK_STATE_ENV] = path.join(platformRoot, '.runtime', 'mock-state.json');
  }
  return env[MOCK_STATE_ENV]!;
}
