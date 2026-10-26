/**
 * 出向密封（测试环境双向密封的一半）：抹掉运行者环境里泄漏进来的 LLM_、DZ_、FSHINE_
 * 前缀变量，让每个测试文件都从同一条干净基线起步——治本，不再依赖运行者手工 env -u。
 *
 * 为什么需要：开发机/CI 的 shell 常 export 了真实的 LLM_API_BASE_URL、LLM_API_KEY、
 * DZ_EXECUTOR、FSHINE_REAL_COMMIT（联调用）。裸 npm test（vitest run）不加载 .env，却
 * 继承 shell 环境，于是"测试结果"依赖运行者当时 export 了什么——真实端点可能被意外命中、
 * 真提交开关可能被悄悄打开、mock 执行器可能被切成真执行器。这里在 setupFiles 阶段统一
 * unset，测试若需要这些变量（如 e2e harness）在自己的 beforeAll 里显式设置，覆盖本条。
 *
 * 时序保证：vitest 的 setupFiles 在每个测试文件之前运行，早于该文件的 beforeAll——
 * 所以这里 unset 的是"环境泄漏"，harness 随后设的值不受影响。
 */
const LEAKED_ENV_KEYS: readonly string[] = [
  'LLM_API_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_THINKING_LEVEL',
  // 分层模型接缝(Main Agent 专用覆盖,装配层解析):同样按"运行者 shell 泄漏会改变装配
  // 产物"的理由纳入密封——测试要钉的"缺省回落 LLM_MODEL"不该依赖运行者没 export 它。
  'LLM_MAIN_MODEL',
  'LLM_MAIN_THINKING_LEVEL',
  'DZ_EXECUTOR',
  'FSHINE_REAL_COMMIT',
  // New deployment switches must not change the default inline/queue baseline of mock tests.
  'FSHINE_WORKER_DISPATCH_MODE',
  'FSHINE_PLATFORM_QUEUE_CAPACITY',
];

for (const key of LEAKED_ENV_KEYS) {
  delete process.env[key];
}
