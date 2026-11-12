/**
 * 子进程环境收口（V0 安全收口 #2；2026-11-12 建，2026-11-13 复核修订为逐键决策）。
 *
 * 背景：宿主进程 env（`--env-file .env` / 部署 shell）里带着与业务执行无关的宿主敏感
 * 凭据族（`LLM_*` 模型接入、`WECOM_*` 渠道接入）。收口前 worker bash 子进程与宿主直调
 * 网关子进程都原样继承全量 env（sentinel `printenv` 红先证实证，见
 * `packages/agent/child-env-closure.test.ts`）。三个出口按责任分开，各用各的尺：
 *
 *   (i)  Worker 模型调用凭据——由可信驱动内部持有，不进任何子进程 env。
 *        `pi-coding-driver.ts` 的 createCodingModel 从驱动 options.env 读 `LLM_*`
 *        并注册进 ModelRuntime provider；凭据只存在于宿主进程内存。本文件保证它到达
 *        不了任何子进程（worker 白名单不含；宿主直调剥离族含）。
 *   (ii) Worker shell / 工具可见 env——**精确键白名单**（见下），逐键给出消费方依据与
 *        「缺了会坏」实跑验证（child-env-closure.test.ts 的逐键对照用例）。
 *        禁整体前缀放行：`NODE_*` / `FSHINE_*` / `EXECUTION_*` 都逐键核对过；
 *        未登记键（含未来新增的宿主机密族）默认不进（fail-closed）。
 *   (iii) 宿主直调网关 env——进程 env + 调用方覆盖后，剥宿主敏感凭据族
 *        （`LLM_*` / `WECOM_*`）与宿主内部指针（AGENT_CONFIG_PATH / DB_PATH，执行层
 *        零读取）。其余键继承：这条路径的消费者是执行层自己的 CLI，其声明的
 *        EXECUTION_* 与 DZ_* 治理面归执行层；做成逐键正面白名单需要两仓契约先登记
 *        （残余登记在 docs/decision-log.md 七节）。
 *
 * 不在这里做的事：不做 bash 字符串拦截、不把 `.env` / `config/` 移出 worker 可达路径
 * ——那是进程 / 文件系统层的残余，登记在案，不假闭合（docs/decision-log.md 七节）。
 */

/** 宿主敏感凭据族（前缀匹配）：宿主直调网关子进程不继承。 */
export const HOST_SENSITIVE_ENV_PREFIXES: readonly string[] = ['LLM_', 'WECOM_'];

/** 宿主内部指针键（精确匹配，执行层零读取）：宿主直调网关子进程不继承。 */
export const HOST_INTERNAL_ENV_KEYS: readonly string[] = ['AGENT_CONFIG_PATH', 'DB_PATH'];

export function isHostSensitiveEnvKey(key: string): boolean {
  return HOST_SENSITIVE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** 宿主直调出口要剥的键（敏感族 ∪ 宿主内部指针）。 */
export function isHostDirectStrippedKey(key: string): boolean {
  return isHostSensitiveEnvKey(key) || HOST_INTERNAL_ENV_KEYS.includes(key);
}

/** 剥掉宿主敏感族与宿主内部指针（返回副本，不改入参；`undefined` 值不落键）。 */
export function stripHostSensitiveEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || isHostDirectStrippedKey(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * 宿主直调网关子进程 env：进程 env + 调用方覆盖，再剥（见上）。
 * 注意合并方向——先 `{ ...process.env, ...overrides }` 再剥，避免"调用方剥了、
 * 合并基底又把键带回来"的回流（旧写法 `{ ...process.env, ...env }` 正是该形态）。
 */
export function hostDirectChildEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return stripHostSensitiveEnv({ ...process.env, ...overrides });
}

/**
 * 仓内夹具 per-case 状态根桥的键名（测试专用变量，非两仓契约；登记见
 * platform-leak-lint 的 FSHINE_* 登记表与 probe-real-agent.test.ts 的 D-209 白名单）。
 *
 * 集中在此一处：worker 白名单需要保留它，否则 worker 发起的仓内夹具调用会丢 per-case
 * 状态根、回落到夹具自己的 `.runtime`（跨用例串状态）。消费方经本常量引用，不各自写
 * 字面量。
 */
export const WORKER_FIXTURE_STATE_DIR_KEY = 'FSHINE_EVAL_FIXTURE_STATE_DIR';

/**
 * worker 子进程白名单：**精确键**（禁整体前缀放行）。逐键依据（消费方 + 「缺了会坏」
 * 实跑验证，对照用例在 child-env-closure.test.ts）：
 *
 *   · PATH   —— SDK bash 工具用宿主 env 构造 spawn env（pi-coding-agent 的
 *               dist/utils/shell.js:getShellEnv 会补 SDK 自带的 bin 路径前缀）；仓内夹具 shell
 *               入口按名调 `node`（scripts/eval/fixtures/dummy-platform/bin/dummy）。
 *               缺了：命令查找失败（对照：`sh -c 'node -v'` → command not found）。
 *   · HOME   —— 仓内夹具把它转发给子进程（dummy.cjs 的 local runner spawn env
 *               `{ PATH, HOME }`）；脚本按 `$HOME` 展开。缺了：`cd "$HOME"` 报
 *               "null directory"、`git config` 报 `$HOME not set`（对照用例实跑）。
 *   · TMPDIR —— SDK 长输出快照用 `os.tmpdir()`（pi-coding-agent 的
 *               dist/core/tools/output-accumulator.js）。缺了：快照旁路声明的落点、
 *               静默落系统 /tmp（对照用例实跑：路径随键去留变化；/tmp 不可写时才硬失败，
 *               本环境不可复现，如实登记）。
 *   · WORKER_FIXTURE_STATE_DIR_KEY —— 见上。
 *
 * 未登记键一律不进，逐族结论（2026-11-13 核对）：
 *   · NODE_*（NODE_ENV / NODE_OPTIONS / NODE_EXTRA_CA_CERTS / NODE_PATH…）：V0 路径
 *     无消费方；运行器旋钮归部署，需要时按单键登记 + 消费验证再加回。
 *   · 其余 FSHINE_*：宿主自用参数（assembly / handler / driver 在宿主进程读），
 *     worker 子进程零读取。
 *   · 其余 EXECUTION_*：执行层治理面；worker 路径只逐次注入下面两键，其余（阈值 /
 *     限流 / 状态路径 / 令牌面）不经 worker env 下发——令牌面按设计只随宿主直调单次
 *     子进程传递（见 docs/environment-variables.md §2）。
 *   · LANG / LC_*：node 子进程固定 UTF-8；python3 在 C/POSIX locale 下自开 UTF-8 模式
 *     （对照用例实跑中文输出无差异）。缺了不坏，故不进。
 *   · PI_*：SDK 会话元数据；随 `exposeSessionEnvironment: false` 一起关闭
 *     （pi-coding-driver.ts），提示词不再宣传它，环境与提示词一致。
 */
export const WORKER_ENV_ALLOWED_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  WORKER_FIXTURE_STATE_DIR_KEY,
];

export function isWorkerEnvKeyAllowed(key: string): boolean {
  return WORKER_ENV_ALLOWED_KEYS.includes(key);
}

/** worker 子进程逐次注入键（白名单过滤之后写入，不来自继承）。 */
export const WORKER_ENV_INJECTED_KEYS: readonly string[] = ['EXECUTION_REQUIRE_PLAN', 'EXECUTION_PLAN_ID'];
