import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 测试面配置（现为单 project：unit；原 e2e project 已随旧套件于 2026-11-13 删除）。
 *
 * 注意：vitest 3 的 projects **不继承**根级 test 选项（实测：setupFiles 放根下，
 * project 内收不到），共享项必须逐项展开进 project——这里收敛成单一来源，避免漂移。
 *
 * ⚠️ 但有两个例外，**根级设置是生效的**（实测，别被上面这句话误导成"根级都没用"）：
 *   1) `maxWorkers` —— 根级生效，project 内不生效（见下方并发边界段）。
 *   2) `globalSetup` —— 根级生效，且 projects 结构下只在主进程触发一次
 *      （实测：2 个 project，globalSetup 记录到 1 次，pid 为主 vitest 进程）。
 *      注意它和 setupFiles 的继承行为不一样，别"顺手"把它也逐 project 展开——
 *      展开后会装两遍守卫（幂等，但日志会重复）。
 */
const ALIAS = [
  // Execution Contract 的子路径入口：与 @fshine/contracts barrel 分开，避免与旧 a2a 契约的
  // 同名类型（CapabilityManifest）在桶导出处冲突（旧 a2a 文件本体保持不动）。
  {
    find: '@fshine/contracts/execution-contract',
    replacement: fileURLToPath(new URL('./packages/contracts/src/execution-contract.ts', import.meta.url)),
  },
  {
    find: /^@fshine\/([\w-]+)$/,
    replacement: fileURLToPath(new URL('./packages', import.meta.url)) + '/$1/src/index.ts',
  },
] as const;

const SHARED = {
  // 出向密封：每个测试文件前 unset 运行者环境泄漏的 LLM_*/EXECUTION_EXECUTOR/FSHINE_REAL_COMMIT，
  // 使 `npm test` 在任意 shell 环境下确定性一致（治本，不依赖手工 env -u）。
  setupFiles: ['tests/vitest.setup.ts'],
  environment: 'node' as const,
  pool: 'forks' as const,
  // 原 e2e 全链用例要真 spawn CLI 进程（mock 网关/计划 CLI；套件已删除，值保留），
  // 单例 0.8-2.6s 是正常速度；共享机器高负载时劣化 3-4 倍（实测 7.9s），默认 5s
  // 超时会把负载抖动变成假失败（2026-09-27 复现：计划门确认路径两例在 load 10+
  // 时间歇性红，低负载三连全绿）。
  testTimeout: 30_000,
  // 收尾预算：afterAll/afterEach（rmSync 临时目录、关 SQLite、关装配）超时即爆，
  // 不让一个坏钩子把整个 worker 吊死（事故夜 27 分钟不退出的直接放大器）。
  teardownTimeout: 10_000,
  // beforeAll/afterEach 的单钩子预算：原 e2e beforeAll 要 spawn 平台 CLI 派生 label 表
  // （正常 1-3s；套件已删除，值保留），20s 足够覆盖高负载劣化又不至于无限等。
  hookTimeout: 20_000,
} as const;

export default defineConfig({
  test: {
    /**
     * worker 生命周期兜底（2026-10-11 落地，本仓自持，不依赖上游）。
     *
     * 事故形状：主进程猝死 → tinypool worker 无父亡检测 → 孤儿无限自旋。上游两条路
     * 都指望不上——disconnect 兜底要 vitest/tinypool 改代码且只治"事件循环还活着"的
     * 空闲孤儿；PDEATHSIG 才是唯一能治同步忙循环孤儿的解，但 Node 不暴露 prctl。
     * 守卫脚本覆盖我们控制的三条路径：主进程收到可捕获信号时先带走全家再退出、
     * 任何退出路径清扫自己的残留 worker、每次跑测试清扫上次猝死留下的 PPid=1 孤儿。
     * 详见 scripts/vitest-orphan-guard.ts 顶部注释与安全边界。
     */
    globalSetup: ['scripts/vitest-orphan-guard.ts'],

    /**
     * 并发边界 —— **这是全文件唯一生效的 worker 上限**，2026-10-11 实测。
     *
     * 原设计是"unit 3 / e2e 2 分类给"，**没有实现**：vitest 3.2.7 不读 project 内的
     * maxWorkers（实测单跑 --project unit 仍开 7 个 worker），根级 maxWorkers 才对
     * 各 project 一视同仁。要分类得拆成两条 vitest run 命令或 workspace 配置，
     * 仍未做——project 里那行已删，不再留"写着但不生效"的假配置。
     *
     * 为什么取 3（实测，全量 78 文件 / 987 测试 / exit=0）：
     *   并发        全量墙钟    峰值 RSS(worker 合计)    孤儿最坏内存
     *   7（默认）    54.95s      1869MB                  7×~1.2GB ≈ 8.4GB（打穿整机）
     *   3（本次）    63.58s       765MB                  3×~1.2GB ≈ 3.6GB（可承受）
     * 即 +16% 墙钟换 −59% 内存。机器可用内存约 5.4GB（共享机，实测），7 并发的孤儿
     * 最坏值直接超过可用量——10-10 那次（6 孤儿 / 27 分钟 / 内存+swap 濒临耗尽）
     * 就是这么来的；3 并发下同样的事故只掉到 3.6GB，不惊动别的租户。
     *
     * ⚠️ 拼写陷阱（2026-10-11 实测，别改错）：顶层 `maxForks` 在 vitest 3.2.7 是
     * **死别名**，根级和 project 内都不生效、且不报错不警告：
     *   project 内 maxForks: 2 → 实测仍 7 worker
     *   根级     maxForks: 2 → 实测仍 7 worker
     *   根级     maxWorkers: 2 → 实测 2 worker ✅
     *   根级     poolOptions.forks.maxForks: 2 → 实测 2 worker ✅
     * 原因在源码解析链（vitest/dist/chunks/coverage.DfSpMS-b.js:2612，forks 池路径）：
     *   `poolOptions.maxForks ?? vitest.config.maxWorkers ?? threadsCount`
     * 兜底读的是 config.maxWorkers，**从来没有 config.maxForks**。所以要么写根级
     * maxWorkers，要么写 poolOptions.forks.maxForks，且必须放根级。
     */
    maxWorkers: 3,

    projects: [
      {
        // alias 同样不继承（实测：根级 resolve.alias 对 project 不可见，
        // e2e harness 的 @fshine/* 导入直接解析失败），逐 project 展开。
        resolve: { alias: ALIAS },
        test: {
          name: 'unit',
          // `scripts/**` 是 D-087 补的：验收夹具与运维脚本自此进测试覆盖面。此前这里只有
          // packages/apps，而 leak-lint 反而扫 scripts/——两边覆盖不对称（D-084 残留 b
          // 的一半；tsconfig 的 include 仍不含 scripts/，那另一半不混在本波里）。
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'],
          ...SHARED,
        },
      },
    ],
  },
});
