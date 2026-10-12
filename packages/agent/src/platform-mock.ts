/**
 * 平台 mock 控制面 + 宿主持有的写流程开关（对接 17dz-platform 的 executor 开关，commit 376ea0d）。
 *
 * DZ_EXECUTOR=mock：平台网关把执行器替换为 mock 应答器（不开浏览器、不触网），
 * gate 矩阵/commit 令牌/审计照真生效。本模块只集中读开关与兜底状态路径，
 * 业务代码一律经 isPlatformMock() 判断，不散落 env 字符串。
 *
 * 同住本模块的还有三个**宿主持有**的写流程闸（不是平台开关，但同样是"读一次 env、
 * 一处判定"的纪律）：isCommitEnabled（落账总闸）、proposalViaGateway（方案 1 B 波的
 * 提案创建路径迁移开关，默认关）与 proposalCommitWired（B 波 B4 的提案落账后端接线开关，
 * 默认关）。
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

/**
 * 写路径迁移开关（方案 1 · B 波 W2 一键回滚）：提案创建走不走网关。
 *
 * 默认**关**：关 = 宿主在 `beforeToolCall` 完全不拦截提案命令，worker 的网关调用原样落回
 * serve 门与平台，提案预览仍走今天的文本路径（`finalizeProposal`）。开 = 宿主拦下提案命令、
 * 自己办调平台 create，并把旧文本路径的建条目/置 superseded 一并关掉——否则旧路径会把新
 * 路径刚建的 pending 条目 superseded 掉（B 波第 1 批实证的第三点）。
 *
 * 为什么是宿主开关而不是平台开关：两条路的差别全在宿主持有什么（拦截点、意图条目、确认码），
 * 平台两侧都认。回滚 = 关这一个环境变量，不 revert commit。
 */
export const PROPOSAL_VIA_GATEWAY_ENV = 'FSHINE_PROPOSAL_VIA_GATEWAY';

/** 开关状态（显式传 env，测试因此不起进程级副作用）。只有 '1' 算开，其余一律关。 */
export function proposalViaGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROPOSAL_VIA_GATEWAY_ENV] === '1';
}

/**
 * 新提案落账后端的接线开关（方案 1 · B 波 B4）：`FSHINE_PROPOSAL_COMMIT`。
 *
 * 默认**关**：关 = 确认码只到达"确认收到但不写"（confirm_held），提案在平台侧保持 pending；
 * 开 = 服务端在用户确认后直调平台 commit 落账。与 `FSHINE_PROPOSAL_VIA_GATEWAY` 分工：那个
 * 管"提案怎么创建"，这个管"确认之后怎么落账"——两者独立，于是部署可以先切创建、后切落账，
 * 中途态的承诺（"确认不会写入任何数据"）由 proposalCommitEnabled 如实说出。
 *
 * 它**不**替代 FSHINE_REAL_COMMIT：真平台落账还要后者显式置位（isCommitEnabled），mock 之下
 * 才默认放行。两个开关串成"接线 ∧ 放行"，少一个都只到 confirm_held。
 */
export const PROPOSAL_COMMIT_ENV = 'FSHINE_PROPOSAL_COMMIT';

/** 接线状态（显式传 env）。只有 '1' 算接上，其余一律未接。 */
export function proposalCommitWired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROPOSAL_COMMIT_ENV] === '1';
}

/** mock 开启但状态路径未设时兜底；须在 worker/commit 子进程产生前调用。 */
export function ensureMockStatePath(platformRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isPlatformMock(env)) return null;
  if (!env[MOCK_STATE_ENV]) {
    env[MOCK_STATE_ENV] = path.join(platformRoot, '.runtime', 'mock-state.json');
  }
  return env[MOCK_STATE_ENV]!;
}
