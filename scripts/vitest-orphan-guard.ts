/**
 * vitest worker 生命周期兜底 —— 本仓自持，不依赖上游修 vitest/tinypool。
 *
 * 背景（2026-10-10 14:12 事故复盘，见 vitest.config.ts 同段注释）：外层包装只杀
 * vitest 主进程时，tinypool worker 没有父亡检测 —— `tinypool/dist/entry/process.js`
 * 全文只挂一个 `process.on("message")`，无 disconnect / SIGTERM / SIGINT / exit；
 * `vitest/dist/workers/forks.js` 43 行只有一个 process.exit 重赋值 hack。父进程一死，
 * IPC channel 关了但没有任何代码在听，worker 被 init 收养后无限自旋。实测复现：
 * SIGKILL 主进程 30s 后 4 个 worker PPid=1、R 状态、各 1.16-1.23GB、100% CPU 永转。
 *
 * 上游为什么指望不上：
 *   - disconnect 兜底要 vitest 或 tinypool 改代码，且只治"事件循环还活着"的空闲孤儿；
 *   - PDEATHSIG（PR_SET_PDEATHSIG）才是唯一能治同步忙循环孤儿的解，但 Node 不暴露
 *     prctl，只能 native binding；`systemd-run --scope -p MemoryMax=…` 能靠内核兜底
 *     不跑死整机，但治不了 CPU 自旋（并发边界与实测数字见 vitest.config.ts 注释）。
 *   两者都不在本仓控制内。
 *
 * 本文件覆盖我们控制的三条路径：
 *   ① 主进程收到 SIGTERM/SIGINT/SIGHUP（外层包装、Ctrl-C、CI 取消）→ 先把自己的
 *     worker 全部 SIGKILL 再退出。这正是 10-10 那个原始触发器：不再依赖包装器杀对
 *     目标，主进程自己带走全家。
 *   ② 主进程任何退出路径（含异常退出）→ exit 钩子清扫自己的残留 worker。
 *   ③ 每次跑测试（含本次退出时）→ 清扫上次主进程猝死留下的孤儿（PPid=1）。这是在
 *     没有 supervisor 的前提下，唯一能把"27 分钟"压到"到下次跑测试为止"的手段。
 *
 * 安全边界（共享机器，误杀代价高于漏杀）：
 *   - 自己的 worker：只杀 PPid === 本进程 pid 的，天然杀不到别的进程。
 *   - 历史孤儿：必须同时满足「进程标题是 node (vitest N) 或环境含 VITEST_WORKER_ID」
 *     「cwd 归属本仓」「PPid === 1」三个条件。活着的 worker 其 PPid 是它的主进程，
 *     不可能为 1，所以并发跑同一仓库的另一套 vitest 不会被误伤。
 *   - 全程只发 SIGKILL 给已判定目标，不碰信号组、不按名字模糊匹配。
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');

/** 只在真的杀掉东西时输出，正常跑零噪音。 */
const log = (reason: string, victims: readonly { pid: number; rssKb: number }[]): void => {
  if (victims.length === 0) return;
  const detail = victims.map((v) => `pid=${v.pid} rss=${(v.rssKb / 1024).toFixed(2)}MB`).join(' ');
  console.error(`[orphan-guard] ${reason}: SIGKILL ${victims.length} 个 worker（${detail}）`);
};

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const listPids = (): number[] => {
  try {
    return readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return [];
  }
};

const ppidOf = (pid: number): number | null => {
  const m = /^PPid:\s+(\d+)$/m.exec(readText(`/proc/${pid}/status`) ?? '');
  return m?.[1] === undefined ? null : Number(m[1]);
};

const rssKbOf = (pid: number): number => {
  const m = /^VmRSS:\s+(\d+) kB$/m.exec(readText(`/proc/${pid}/status`) ?? '');
  return m?.[1] === undefined ? 0 : Number(m[1]);
};

/**
 * 识别"本仓的 vitest worker 进程"。两条独立信号命中其一即可：
 *   - 进程标题形如 `node (vitest 3)`（tinypool fork 出的 worker 会被改标题）
 *   - 环境里有 VITEST_WORKER_ID（vitest 给 worker 注入）
 * 再叠加 cwd 必须归属本仓，避免共享机器上把同机其他租户的进程算进来。
 */
const isRepoVitestWorker = (pid: number): boolean => {
  const argv = readText(`/proc/${pid}/cmdline`)?.split('\0').filter((s) => s.length > 0);
  if (argv === undefined || argv.length === 0 || !argv[0]?.includes('node')) return false;
  const byTitle = argv.join(' ').includes('(vitest ');
  const environ = readText(`/proc/${pid}/environ`);
  const byEnv = environ !== null && /(?:^|\0)VITEST_WORKER_ID=/.test(environ);
  if (!byTitle && !byEnv) return false;
  try {
    return readlinkSync(`/proc/${pid}/cwd`) === REPO_ROOT;
  } catch {
    return false;
  }
};

/** 先按 PPid 过滤（最便宜的判别器），再做昂贵的 worker 身份判定。 */
const findVitestWorkers = (parentPid: number): number[] =>
  listPids().filter((pid) => ppidOf(pid) === parentPid && isRepoVitestWorker(pid));

const killWorkers = (pids: readonly number[], reason: string): void => {
  const victims: { pid: number; rssKb: number }[] = [];
  for (const pid of pids) {
    const rssKb = rssKbOf(pid);
    try {
      process.kill(pid, 'SIGKILL');
      victims.push({ pid, rssKb });
    } catch {
      // 进程已自行退出，无需处理
    }
  }
  log(reason, victims);
};

let swept = false;

const sweep = (reason: string): void => {
  if (swept) return;
  swept = true;
  // ① 自己的残留 worker（vitest 收尾漏掉或没跑到）
  killWorkers(findVitestWorkers(process.pid), `${reason}: 本进程残留 worker`);
  // ③ 上次主进程猝死留下的孤儿。只有 PPid===1 才是真孤儿，活着的 worker 不会被误伤
  killWorkers(findVitestWorkers(1), `${reason}: 历史孤儿 worker`);
};

const SIGNAL_EXIT: Record<string, number> = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };

export default function setup(): void {
  // globalSetup 实测只在主进程触发一次（projects 结构下根级 globalSetup 跑 1 次），
  // 这里再挡一道：万一将来被搬到 setupFiles（每个测试文件都跑），也不要在 worker 里装。
  if (process.env['VITEST_WORKER_ID'] !== undefined) return;

  /**
   * ② 主路径：任何退出路径都清扫。含自然结束、异常退出、以及 vitest 自己的信号处理。
   *
   * 为什么挂在 'exit' 上而不是只挂信号：vitest 对 SIGTERM/SIGINT 的处理器
   * （vitest/dist/chunks/cli-api.DVe0nWUx.js:5621 的 onExit）只做终端光标恢复后直接
   * `process.exit()`，**完全不收 worker 池**——这就是 10-10 事故的直接原因。它调用
   * process.exit() 会触发 'exit' 事件，所以在这里收尸能盖住这条路径。
   * 注意 SIGKILL 主进程不走这里（无 JS 可跑），那种只能靠 ③ 在下次跑测试时收。
   */
  process.on('exit', () => { sweep('exit'); });

  /**
   * ① 信号路径：必须用 prependListener 抢到 vitest 自己的 once('SIGTERM') **前面**。
   *
   * 用普通 on() 是错的，2026-10-11 实测踩过：vitest 在 CLI 启动阶段就注册了
   * `process.once("SIGTERM", onExit)`（同文件 5622 行），globalSetup 跑在它之后，
   * 普通 on() 只能排到后队——SIGTERM 到来时 vitest 的处理器先执行并 process.exit()，
   * 进程当场结束，我们的监听器一次都没跑。实测结果：守卫零日志、3 个 worker 照常成
   * 孤儿，和不装守卫完全一样。
   *
   * 抢到前排后先带走全家，再自己退出。这里必须显式 process.exit()：注册了信号
   * 监听器后 node 就不再应用"信号默认处置即终止"，若此处不退出而 vitest 将来又不再
   * 注册自己的处理器，主进程会被信号挂住不退。
   */
  for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
    process.prependListener(signal as NodeJS.Signals, () => {
      sweep(`signal:${signal}`);
      process.exit(code);
    });
  }
}
