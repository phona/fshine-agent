import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 两类 project（unit / e2e）共享的测试面配置。
 *
 * 注意：vitest 3 的 projects **不继承**根级 test 选项（实测：setupFiles 放根下，
 * 两个 project 都收不到），共享项必须逐项展开进每个 project——这里收敛成单一
 * 来源，避免两处漂移。
 */
const ALIAS = [
  {
    find: /^@fshine\/([\w-]+)$/,
    replacement: fileURLToPath(new URL('./packages', import.meta.url)) + '/$1/src/index.ts',
  },
] as const;

const SHARED = {
  // 出向密封：每个测试文件前 unset 运行者环境泄漏的 LLM_*/DZ_EXECUTOR/FSHINE_REAL_COMMIT，
  // 使 `npm test` 在任意 shell 环境下确定性一致（治本，不依赖手工 env -u）。
  setupFiles: ['tests/vitest.setup.ts'],
  environment: 'node' as const,
  pool: 'forks' as const,
  // e2e 全链用例要真 spawn CLI 进程（mock 网关/计划 CLI），单例 0.8-2.6s 是正常速度；
  // 共享机器高负载时劣化 3-4 倍（实测 7.9s），默认 5s 超时会把负载抖动变成假失败
  // （2026-09-27 复现：计划门确认路径两例在 load 10+ 时间歇性红，低负载三连全绿）。
  testTimeout: 30_000,
  // 收尾预算：afterAll/afterEach（rmSync 临时目录、关 SQLite、关装配）超时即爆，
  // 不让一个坏钩子把整个 worker 吊死（事故夜 27 分钟不退出的直接放大器）。
  teardownTimeout: 10_000,
  // beforeAll/afterEach 的单钩子预算：e2e beforeAll 要 spawn 平台 CLI 派生 label 表
  // （正常 1-3s），20s 足够覆盖高负载劣化又不至于无限等。
  hookTimeout: 20_000,
} as const;

/**
 * 2026-10-10 测试资源边界整改（事故复盘：全量跑后 6 个 tinypool worker 成孤儿，
 * 各 0.6-1.2GB 忙循环 27 分钟不退出，整机内存+swap 濒临耗尽）：
 *
 * 1) 显式 pool: 'forks'。⚠️ 这里原写"每 project 显式 maxWorkers … unit 3 / e2e 2"
 *    **没有生效**：vitest 3.2.7 不读 project 内的 maxWorkers（实测单跑 unit 仍 7 个
 *    worker），且依据数据有误——e2e 单 worker 实测峰值 284MB，不是 1.2GB（那是主
 *    进程 + 全部 worker 合计被当成了单 worker），所以"7×1.2GB 打到 swap"不成立。
 *    实际做到的是：孤儿链入口被移除（不再有外层 timeout）+ 坏钩子有兜底超时 +
 *    harness 台账兜底关 assembly。并发边界待重新设计，见提交信息。
 * 2) teardownTimeout / hookTimeout 显式值：收尾阶段不再无限等，配合 testTimeout
 *    让任何单点劣化在 vitest 内部爆雷，而不是拖到外层墙钟预算（删掉对外层
 *    `timeout` 兜底的依赖——timeout 只杀直接子进程，主进程一死 worker 就成孤儿
 *    自旋，2026-10-10 已实验复现：SIGKILL 主进程 → 4 个 worker PPid=1、R 状态、
 *    各 1.2GB、100% CPU 永转）。
 * 3) projects 串行执行（实测确认）：unit 与 e2e 先后跑，不是同时开两套池。
 *    ⚠️ 但别由此推出"峰值 = max(两类)"——那依赖下面每个 project 的 maxWorkers
 *    生效，而它不生效（见下方两处 ⚠️）。当前实际跑的是默认 7 并发，实测全量
 *    峰值 1869MB / 56s / 953 全绿 / 退出后 0 残留，四项都达标；并发边界是
 *    还没做的事，不是已经做到的事。
 */
export default defineConfig({
  test: {
    projects: [
      {
        // alias 同样不继承（实测：根级 resolve.alias 对 project 不可见，
        // e2e harness 的 @fshine/* 导入直接解析失败），逐 project 展开。
        resolve: { alias: ALIAS },
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
          ...SHARED,
          // ⚠️ 这一行**当前不生效**，留着但别信：vitest 3.2.7 不读 project 内的
          // maxWorkers（实测单跑 --project unit 仍开 7 个 worker；根级 maxWorkers
          // 才生效，但它对 unit/e2e 一视同仁，做不到分类给）。unit/e2e 并发分开
          // 需要拆成两条 vitest run 命令或 workspace 配置——待重新设计，见提交信息。
          // 原先这里写的"单 worker 峰值 ~0.4GB、取 3 并发"依据不实：实测单 worker
          // 峰值约 250-284MB，且并发根本没被限制住。
          maxWorkers: 3,
        },
      },
      {
        resolve: { alias: ALIAS },
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          ...SHARED,
          // ⚠️ 同上：这一行也不生效，依据数据同样不实。原先写的"单 worker 峰值实测
          // 1.16-1.23GB、只开 2 并发"——实测 e2e 单 worker 峰值只有 284MB（那个
          // 1.2GB 是主进程 + 全部 worker 的合计被当成了单 worker），所以"7×1.2GB
          // 会打到 swap"这个推论不成立：全量实测峰值 1869MB，离 4GB 目标很宽。
          maxWorkers: 2,
        },
      },
    ],
  },
});
