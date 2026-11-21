/**
 * 单实例启动守卫：进程启动、连渠道**之前**取独占锁（`.runtime/server/instance.lock`）。
 *
 * 为什么需要（背景）：企微同一 bot 只允许一条 WS 长连接。误开两个进程时两端会抢
 * 连接/抢消息，造成重复处理与随机掉线；跨重启入站幂等只能兜"重复"，兜不住"抢连接"。
 * 这是纯机械守卫（确定性责任，B 类）：判据可复现、可测试，不依赖模型遵守提示词。
 *
 * 锁是什么：
 *   · 锁文件放状态目录（`path.dirname(dbPath)` 下，与 `.runtime/state.db` 同根，默认
 *     `<仓根>/.runtime/server/instance.lock`），内容 `{pid, startedAt, argv}`（JSON，原子写）；
 *   · 取锁失败（文件存在且其中 pid 仍存活且**命令行匹配**）→ 拒绝启动，调用方打印
 *     可操作中文说明后退出（exit code 非 0）；
 *   · 陈旧锁（pid 不存在 / 文件损坏 / **pid 存活但命令行不匹配**）→ 覆盖并记事件；
 *   · 正常退出（SIGINT/SIGTERM）与异常退出都尽量释放（`process.on('exit')` 删锁；
 *     异常退出下次启动按"陈旧锁"处理）。
 *
 * 判据：必须是"该 pid 是不是我们的进程"，**不能只看 kill(pid,0)** —— pid 会被系统
 * 复用，存活 ≠ 是我们的实例。默认探针 `cmdlineOf` 读 `/proc/<pid>/cmdline`（NUL 分隔），
 * 兜底用 `ps -o command=`；命令行带启动 marker（`apps/server/main.ts`）才认作"我们"。
 *
 * 边界：
 *   · 不引入依赖（只 node 内置）；不碰渠道适配 / server 业务逻辑；
 *   · 锁在**连渠道之前**取；任何后续步骤失败都交给 `process.on('exit')` 释放，
 *     下次启动按陈旧锁处理；
 *   · 本守卫只锁"同一状态目录"（同一 dbPath 部署点）。改端口或换部署点（不同 dbPath）
 *     即天然不冲突；误锁时话术里两条出路都给了。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 锁文件名。当前实现固定；改文件名等于制造第二把锁，禁止。 */
export const INSTANCE_LOCK_FILE = 'instance.lock';

/**
 * 启动命令行 marker：判据"这是不是我们的进程"基于命令行是否带它。
 * 取 `apps/server/main.ts` 的 basename 路径段作为匹配锚点（跨平台分隔符无关）。
 */
export const INSTANCE_LOCK_MARKER = 'apps/server/main.ts';

// 兼容性再导出一份（测试与将来调用方共用；防止裸 'main.ts' 被无关脚本误命中）。
export const DEFAULT_INSTANCE_LOCK_MARKER = INSTANCE_LOCK_MARKER;

export interface InstanceLockMeta {
  pid: number;
  startedAt: string;
  argv: string[];
}

export type InstanceLockResult =
  | { ok: true; created: boolean; lockPath: string }
  | { ok: false; reason: 'held'; holder: InstanceLockMeta; message: string; lockPath: string };

export interface InstanceGuardOptions {
  /** 状态目录（`path.dirname(dbPath)`）。取锁前 mkdir -p。 */
  stateDir: string;
  /** 候选命令行 marker；缺省 INSTANCE_LOCK_MARKER（测试可显式传）。 */
  marker?: string;
  /** 日志注入（测试用；缺省 = 结构化 JSON 一行到 stdout）。 */
  log?: (event: Record<string, unknown>) => void;
  /** 探针注入（测试用；缺省 = 读 /proc + ps 兜底）。 */
  cmdlineOf?: (pid: number) => string | undefined;
  /** 当前进程 pid（测试用；缺省 = process.pid）。 */
  selfPid?: number;
}

/** 读 /proc/<pid>/cmdline（NUL 分隔）；不存在/不可读返回 undefined。 */
function readProcCmdline(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').filter((part) => part.length > 0).join(' ');
  } catch {
    return undefined;
  }
}

/** ps 兜底（/proc 不可用的平台）。只取第一行；失败返回 undefined。 */
function readPsCommand(pid: number): string | undefined {
  try {
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n')[0]?.trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * 命令行探针：/proc 优先，ps 兜底。返回 undefined 表示"查不到命令行"。
 * 与 kill(pid,0) 分开：pid 存活 + 命令行查不到 = 无法证明是我们的实例 → 陈旧覆盖，
 * 绝不在判据不确定时拒绝启动把部署锁死。
 */
function cmdlineOfDefault(pid: number): string | undefined {
  return readProcCmdline(pid) ?? readPsCommand(pid);
}

/** 该 pid 是否存活（kill(pid,0) 语义；EPERM/EINVAL 都算存活，只是无权信号或信号值非法）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EINVAL';
  }
}

/** 解析锁文件内容；损坏（JSON 解析失败 / 缺字段）返回 undefined。 */
function parseLock(text: string): InstanceLockMeta | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<InstanceLockMeta>;
    if (typeof parsed.pid !== 'number' || parsed.pid <= 0) return undefined;
    if (typeof parsed.startedAt !== 'string') return undefined;
    if (!Array.isArray(parsed.argv)) return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt, argv: parsed.argv };
  } catch {
    return undefined;
  }
}

/** 命令行是否带 marker：匹配"我们的启动入口"而不误伤同名的家用脚本/其它 repo。 */
function cmdlineMatches(cmdline: string | undefined, marker: string): boolean {
  if (cmdline === undefined || marker.length === 0) return false;
  return cmdline.split(/\s+/).some((word) => word.includes(marker));
}

/**
 * 取独占锁。
 *   ok=true  → 本进程持有锁（新建，或覆盖了陈旧锁 —— 记 `instance_guard_stale_overwritten`）；
 *   ok=false → 被另一存活且命令行匹配的实例占用，message 是可操作中文话术。
 *
 * 时序：读已有锁（若有）→ 判其 pid 存活 + 命令行匹配 → 覆盖陈旧或拒；写锁 =
 * mkdir -p + 临时文件 rename（同目录 rename 原子，读者不会读到半截 JSON）。
 *
 * 竞态说明：两个进程同时起时可能都读到"无锁 / 陈旧"→ 各自写，后写者覆盖先写者
 * （node 内置无 n 秒级原子的 CAS 文件锁，本仓也不引入依赖）。这一残差的兜底 =
 * 先写者仍在跑时 pid 存活且命令行匹配 → 后写者下次启动（或先写者异常退出后的任何
 * 读取方）会正确识别并拒/覆盖；残差窗口内的双写风险与"抢 WS 连接"相比可忽略，
 * 且拒绝启动的判据经反向绊线钉死（见 instance-guard.test.ts）：
 *   · 把判据改成只看 pid 存活 → 用例④红（复活的无辜 pid 会误拒）；
 *   · 去掉命令行校验 → 用例④红。
 */
export function acquireInstanceLock(options: InstanceGuardOptions): InstanceLockResult {
  const log = options.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
  const cmdlineOf = options.cmdlineOf ?? cmdlineOfDefault;
  const marker = options.marker ?? INSTANCE_LOCK_MARKER;
  const selfPid = options.selfPid ?? process.pid;
  const lockPath = path.join(options.stateDir, INSTANCE_LOCK_FILE);

  let existing: InstanceLockMeta | undefined;
  if (existsSync(lockPath)) {
    try {
      existing = parseLock(readFileSync(lockPath, 'utf8'));
    } catch {
      existing = undefined;
    }
  }

  if (existing !== undefined && existing.pid !== selfPid) {
    const alive = pidAlive(existing.pid);
    const matching = cmdlineMatches(cmdlineOf(existing.pid), marker);
    if (alive && matching) {
      log({ event: 'instance_guard_denied', pid: existing.pid, lockPath });
      return {
        ok: false,
        reason: 'held',
        holder: existing,
        lockPath,
        message:
          `启动被拒：已有另一个 fshine server 实例在运行（pid=${existing.pid}，` +
          `启动于 ${existing.startedAt}，命令行 ${existing.argv.join(' ')}）。` +
          `同一 bot 只允许一条 WS 连接，拒绝重复启动以免抢连接/抢消息。` +
          `处理办法：若它就是要保留的实例，退出本次启动即可；` +
          `若是残留实例，确认后执行 kill ${existing.pid} 结束它再重试，` +
          `或改端口 / 换部署点（不同 dbPath 状态目录）并存。锁文件：${lockPath}`,
      };
    }
    // pid 不存活（陈旧）→ 覆盖；pid 存活但命令行不匹配（pid 被复用成别的进程 /
    // 锁被异物写入）→ 同样覆盖：不能把无辜进程当成自己人，也不在判据不明时拒启。
    log({
      event: 'instance_guard_stale_overwritten',
      pid: existing.pid,
      alive,
      cmdlineMatched: matching,
      lockPath,
    });
  }

  mkdirSync(options.stateDir, { recursive: true });
  const meta: InstanceLockMeta = {
    pid: selfPid,
    startedAt: new Date().toISOString(),
    argv: [...process.argv],
  };
  const tmpPath = `${lockPath}.${selfPid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(meta), { encoding: 'utf8' });
  try {
    renameSync(tmpPath, lockPath);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* 清理残块失败无碍锁语义（陈旧锁下次覆盖） */
      }
    }
  }
  log({ event: 'instance_guard_acquired', pid: selfPid, lockPath });
  return { ok: true, created: existing === undefined, lockPath };
}

/**
 * 释放锁：**只删自己的锁**（锁内容 pid == 本进程 pid），避免误删继任者的锁。
 * 幂等：锁不存在或不是自己的 → 返回 false；删成功返回 true。
 * 供 `process.on('exit')`（正常与异常退出都走）调用；同步实现，exit 阶段安全。
 */
export function releaseInstanceLock(options: { stateDir: string; selfPid?: number }): boolean {
  const selfPid = options.selfPid ?? process.pid;
  const lockPath = path.join(options.stateDir, INSTANCE_LOCK_FILE);
  if (!existsSync(lockPath)) return false;
  let holder: InstanceLockMeta | undefined;
  try {
    holder = parseLock(readFileSync(lockPath, 'utf8'));
  } catch {
    holder = undefined;
  }
  if (holder === undefined || holder.pid !== selfPid) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 接线入口：main.ts 在**连渠道之前**调用本函数；持有锁才继续，否则打印话术并
 * `process.exit(1)`（exit 0 会骗过 systemd/CI 的健康检查，拒启必须显式非 0）。
 * 同时挂 `process.on('exit')` 释放钩子 —— SIGINT/SIGTERM 正常停机与异常退出都尽量
 * 释放；极端崩溃（SIGKILL/power loss）锁残留，下次启动按陈旧锁覆盖。
 *
 * @returns 持有锁时的清理函数（测试可直接调用；main.ts 也可忽略）——调用方在
 *   正常关闭路径里（如 `channel.stop()` 之后）调用它，使锁先行释放、缩短双实例窗口。
 */
export function guardSingleInstance(options: InstanceGuardOptions): () => void {
  const result = acquireInstanceLock(options);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  const release = (): void => {
    releaseInstanceLock({ stateDir: options.stateDir, selfPid: options.selfPid });
  };
  process.on('exit', release);
  return release;
}