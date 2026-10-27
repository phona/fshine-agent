/**
 * main.ts 的停机形状（D-132 a/c 的判据本体）。
 *
 * 为什么独立成模块：main.ts 顶层即执行 main()（建 data 文件夹、装配、连渠道），导入即
 * 起服务，无法在单测环境实例化；停机闸与排干上限因此抽到这里供 main.ts 接线与
 * main-shutdown.test.ts 表征（先例：assembly.ts 抽出供生产与离线 e2e 共用）。
 */

/**
 * 停机在飞闸（D-132a）：第二次信号并发再入的竞态收口。
 *
 * 事故形状：SIGINT 处理器直接 `void shutdown(signal)`，连按两次会并发跑两遍停机体——
 * 第二遍的 channel.stop()/close() 在第一遍仍在排干后台任务时就停渠道关库，排干中的
 * 终态投递半途而废。闸语义：**停机一旦开始即不可再入**（闭锁不复位）——生产停机体
 * 末尾是 process.exit(0)，不存在"停机完成后再停一次"；停机体抛错时同样不复位，把
 * "是否重试停机"留给进程监督者而不是第二个信号。迟到信号只打一行
 * shutdown_already_in_progress（可运维观测：信号确实到了，只是被闸挡下）。
 */
export interface ShutdownGuard {
  /** Runs the shutdown body at most once; later calls only log `shutdown_already_in_progress`. */
  run(signal: string, body: () => Promise<void>): Promise<void>;
}

export function createShutdownGuard(log: (line: string) => void = (line) => { console.log(line); }): ShutdownGuard {
  let shuttingDown = false;
  return {
    async run(signal, body) {
      if (shuttingDown) {
        log(JSON.stringify({ event: 'shutdown_already_in_progress', signal }));
        return;
      }
      shuttingDown = true;
      await body();
    },
  };
}

/** 停机排干上限的缺省（D-132c）：给在飞后台任务与终态事件投递 30s 落定窗口。 */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 30_000;

/**
 * 从 env 读停机排干上限（D-132c）。缺省/空白/非数字/负数一律回退默认——排干上限是
 * "最多等多久"的上界参数，模糊值宁可取保守默认也不取 0（0 = 不等待，会放大残留）。
 * 0 是显式合法值（部署者明确要求不等待）。
 */
export function shutdownDrainMsOf(env: Record<string, string | undefined>): number {
  const raw = Number.parseInt(env['FSHINE_SHUTDOWN_DRAIN_MS'] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SHUTDOWN_DRAIN_MS;
}
