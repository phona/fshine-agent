/**
 * M1 执行子进程 env（B 类：凭据隔离，最小形状）。
 *
 * 语义：任何由最小切片发起的执行层子进程，env 都是**精确键白名单重建**的结果——
 * 宿主敏感凭据族（LLM_* 模型接入、WECOM_* 渠道接入）与宿主内部指针
 * （AGENT_CONFIG_PATH / DB_PATH）结构上进不了子进程。白名单本体与逐键依据复用
 * child-env.ts 的 WORKER_ENV_ALLOWED_KEYS（同一事实源，不另立第二份名单）。
 *
 * 为什么 M1 不能只做"继承后删几个键"：白名单是 fail-closed 的（未登记键默认不进），
 * 删键式收口对新出现的宿主机密族默认放行。这里的消费方 = dummy 执行层适配器的 spawn
 * （M1 唯一的执行层子进程面）；M1 没有计划门，因此不注入 EXECUTION_REQUIRE_PLAN /
 * EXECUTION_PLAN_ID，也不注入任何凭据类键。
 *
 * 拒绝路径（回归锁，见 minimal-dummy-client.test.ts）：sentinel 的 LLM 与 WECOM 前缀族、
 * 非白名单键不出现在重建结果里；把 EXECUTION_REQUIRE_PLAN 放进继承 env，适配器调用仍
 * 照常完成（子进程没继承到计划旋钮），证明白名单真的作用在 spawn 面上。
 */
import { isWorkerEnvKeyAllowed } from '../child-env';

/** 按 worker 白名单重建子进程 env（`undefined` 值不落键）。 */
export function workerSubprocessEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || !isWorkerEnvKeyAllowed(key)) continue;
    env[key] = value;
  }
  return env;
}
