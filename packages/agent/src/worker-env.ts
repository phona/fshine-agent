/**
 * 执行子进程 env（B 类：凭据隔离，最小形状）。
 *
 * 语义：任何由最小切片发起的执行层子进程，env 都是**按真实消费逐键重建**的结果——
 * 宿主敏感凭据族（LLM_* 模型接入、WECOM_* 渠道接入）与宿主内部指针
 * （AGENT_CONFIG_PATH / DB_PATH）结构上进不了子进程。
 *
 * 白名单按本切片的真实消费收敛（逐键登记，不做前缀放行）：
 *   · PATH   —— 网关是 shell 入口，按名调 node；
 *   · HOME   —— 网关脚本按 $HOME 展开（临时/缓存路径）；
 *   · TMPDIR —— 子进程临时文件落点。
 * 测试桥键**不进白名单**：适配器用显式
 * `--state-dir` argv 传状态根（dummy-cli-client.ts 的调用点），不靠环境变量改道。
 *
 * 为什么不能只做"继承后删几个键"：白名单是 fail-closed 的（未登记键默认不进），
 * 删键式收口对新出现的宿主机密族默认放行。这里的消费方 = dummy 执行层适配器的
 * spawn（唯一的执行层子进程面）；没有计划门，因此不注入 EXECUTION_REQUIRE_PLAN /
 * EXECUTION_PLAN_ID，也不注入任何凭据类键。
 *
 * 拒绝路径（回归锁，见 worker-env.test.ts）：sentinel 的 LLM/WECOM 前缀族、
 * 宿主内部指针、测试专用桥键与计划旋钮都不出现在重建结果里。
 */

/** 执行层子进程 env 白名单：按真实消费逐键收敛（未登记键一律不进）。 */
export const EXECUTION_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'TMPDIR'];

/** 按上面的白名单重建子进程 env（`undefined` 值不落键）。 */
export function workerSubprocessEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || !EXECUTION_ENV_KEYS.includes(key)) continue;
    env[key] = value;
  }
  return env;
}
