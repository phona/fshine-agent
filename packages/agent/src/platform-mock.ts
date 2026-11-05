/**
 * 平台 mock 控制面 + 宿主持有的落账总闸（对接执行层平台的 executor 开关；对接出处见 debt-ledger）。
 *
 * EXECUTION_EXECUTOR=mock：平台网关把执行器替换为 mock 应答器（不开浏览器、不触网），
 * gate 矩阵/commit 令牌/审计照真生效。本模块只集中读开关与兜底状态路径，
 * 业务代码一律经 isPlatformMock() 判断，不散落 env 字符串。
 *
 * 同住本模块的还有一道**宿主持有**的写流程闸（不是平台开关，但同样是"读一次 env、
 * 一处判定"的纪律）：isCommitEnabled（落账总闸）。B 波另有两个写流程开关（一个管提案
 * 创建走不走网关、一个管落账后端接不接），C 波删掉遗留文本写路径后各只剩一种行为，已
 * 随之退役：宿主**恒定**拦下 worker 的提案命令、落账后端**恒接**，"走哪条路"不再是部署
 * 变量，唯一还分真假的只有 isCommitEnabled（mock 全放开 / 真平台须 FSHINE_REAL_COMMIT=1）。
 *
 * 为什么退役而不是留两个恒开的开关：那两个开关的全部历史价值是影子期的一键回滚
 * （回滚目标 = 遗留文本写路径，已整文件删除）。留下来的两种"关"形态都是静默半成品——
 * 不拦截 = 平台建了提案而用户拿不到确认入口；不接线 = 用户以为确认即录入而实际不写。
 * 恒开的开关只会让读者以为还存在另一条路。
 *
 * EXECUTION_MOCK_STATE：平台侧必填（缺失 exit 3）。服务端在 boot 时兜底到
 * <平台根>/.runtime/mock-state.json（该目录已 gitignore）；env 已显式设置则不覆盖。
 * 重置 mock 状态 = 删掉那个文件（下次调用自动从 seed.json 重新播种）。
 */
import path from 'node:path';

export const MOCK_EXECUTOR_ENV = 'EXECUTION_EXECUTOR';
export const MOCK_STATE_ENV = 'EXECUTION_MOCK_STATE';
export const REAL_COMMIT_ENV = 'FSHINE_REAL_COMMIT';

export function isPlatformMock(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MOCK_EXECUTOR_ENV] === 'mock';
}

/**
 * 落账总闸（派生规则，取代旧演练开关——那个开关名已退役，不再引用）：
 *   - mock 之下写的是假状态，落账全链路默认放开（这正是 mock 联调的价值）；
 *   - 真平台之下默认拒绝 commit，须显式 FSHINE_REAL_COMMIT=1 才放行真写。
 *
 * 真平台落账的**唯一**闸门：B 波那个"落账后端接不接"的开关退役后，确认步的
 * proposalCommitEnabled 由本函数单独派生，没有再串第二级。缺 FSHINE_REAL_COMMIT 时
 * 确认码拿到的是确定性拒绝（confirm_held），一次写入都不发生。
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
