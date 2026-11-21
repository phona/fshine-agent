/**
 * 单实例启动守卫（apps/server/instance-guard.ts）的用例：纯函数 + 真实文件系统 +
 * 真实子进程（模拟"另一个存活实例"），不起真 server、不接渠道。
 *
 * 五条主用例：
 *   ① 无锁时取锁成功，锁文件内容含本进程 pid；
 *   ② 锁被另一个**存活且命令行匹配**的 pid 占用 → 取锁失败并给出可操作提示（含 kill）；
 *   ③ 锁里 pid 不存在（陈旧）→ 覆盖成功；
 *   ④ pid 存在但**命令行不匹配**（模拟 pid 被系统复用）→ 视为陈旧，覆盖成功（不把
 *      无辜进程当自己人）；
 *   ⑤ 释放后锁没了。
 *
 * 反向绊线（第 ④ 条同时打两条）：
 *   · 把判据改成只看 pid 存活 → ④ 红（alive 的无关进程不再被判陈旧）；
 *   · 去掉命令行校验同理 → ④ 红。
 *
 * 判据走默认探针（/proc/<pid>/cmdline，ps 兜底），不 mock：
 *   · ② 用真实子进程 argv 里带上启动 marker，等价于 `node --import tsx apps/server/main.ts`；
 *   · ④ 用真实子进程但 argv 不含 marker，模拟"pid 复用给了别的进程"。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INSTANCE_LOCK_MARKER,
  acquireInstanceLock,
  releaseInstanceLock,
} from './instance-guard';

const KEEPALIVE_JS = 'setInterval(() => {}, 1000);';

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

/** 等子进程退出；已退出的立即返回（防 'exit' 事件先于监听触发导致挂死）。 */
async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

afterEach(async () => {
  const pending = children.splice(0).map((child) => {
    child.kill('SIGKILL');
    return waitExit(child);
  });
  await Promise.all(pending);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'instance-guard-'));
  tempDirs.push(dir);
  return dir;
}

/** 起一个命令行**含 marker**的子进程：等价于第二个 `apps/server/main.ts` 实例的 argv 形态。 */
function spawnMarkerChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', KEEPALIVE_JS, DEFAULT_INSTANCE_LOCK_MARKER], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

/** 起一个命令行**不含 marker**的子进程：模拟 pid 被复用到别的进程（如 `node -e ...`）。 */
function spawnForeignChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', KEEPALIVE_JS], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** 手工伪造一份"被他人持有"的锁文件（内容 = 另一个实例写出来的形态）。 */
function writeHolderLock(lockPath: string, pid: number, argv: string[]): void {
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString(), argv }), {
    encoding: 'utf8',
  });
}

/** 取一个确定已死、kill(pid,0) 必报 ESRCH 的 pid（回收后不再复用即成立）。 */
async function deadPid(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid as number;
    children.push(child);
    await once(child, 'exit');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) return pid;
  }
  throw new Error('无法取得一个确定已死的 pid（疑似 pid 被即时复用，重试仍失败）');
}

describe('instance-guard：单实例启动锁', () => {
  it('① 无锁时取锁成功，锁文件内容含本进程 pid 与登记字段', () => {
    const stateDir = tempDir();
    const lockPath = path.join(stateDir, 'instance.lock');

    const result = acquireInstanceLock({ stateDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.lockPath).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    const meta = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid: number;
      startedAt: string;
      argv: string[];
    };
    expect(meta.pid).toBe(process.pid);
    expect(meta.startedAt.length).toBeGreaterThan(0);
    expect(Array.isArray(meta.argv)).toBe(true);
  });

  it('② 锁被另一个存活且命令行匹配的 pid 占用 → 取锁失败，话术可操作（含 kill pid）', async () => {
    const stateDir = tempDir();
    const lockPath = path.join(stateDir, 'instance.lock');
    const holder = spawnMarkerChild(); // 存活 + cmdline 含 apps/server/main.ts
    const holderPid = holder.pid as number;
    writeHolderLock(lockPath, holderPid, [process.execPath, 'apps/server/main.ts']);

    const result = acquireInstanceLock({ stateDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('held');
    expect(result.holder?.pid).toBe(holderPid);
    // 可操作话术：谁在跑（pid + 命令行 + 启动时间）、怎么处理（kill <pid>）、锁文件在哪。
    expect(result.message).toContain(`pid=${holderPid}`);
    expect(result.message).toContain(`kill ${holderPid}`);
    expect(result.message).toContain(lockPath);
    // 失败时不得动别人的锁文件。
    expect(existsSync(lockPath)).toBe(true);
    const meta = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(meta.pid).toBe(holderPid);
  });

  it('③ 锁里 pid 不存在（陈旧）→ 覆盖成功，且记陈旧事件', async () => {
    const stateDir = tempDir();
    const lockPath = path.join(stateDir, 'instance.lock');
    const stalePid = await deadPid();
    writeHolderLock(lockPath, stalePid, [process.execPath, 'apps/server/main.ts']);
    const log = vi.fn();

    const result = acquireInstanceLock({ stateDir, log });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false); // 覆盖了已有（陈旧）锁，不是新建
    const meta = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(meta.pid).toBe(process.pid); // 陈旧锁被本进程接管
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'instance_guard_stale_overwritten' }),
    );
  });

  it('④ pid 存在但命令行不匹配（模拟 pid 复用）→ 视为陈旧，覆盖成功', async () => {
    const stateDir = tempDir();
    const lockPath = path.join(stateDir, 'instance.lock');
    // 存活进程，但它的 cmdline 不含启动 marker —— 最像"pid 被系统复用到别的进程"。
    const foreign = spawnForeignChild();
    const foreignPid = foreign.pid as number;
    writeHolderLock(lockPath, foreignPid, [process.execPath, 'app/not-fshine.js']);
    const log = vi.fn();

    const result = acquireInstanceLock({ stateDir, log });

    expect(result.ok).toBe(true); // 不把无辜进程当自己人 → 陈旧覆盖
    if (!result.ok) return;
    const meta = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(meta.pid).toBe(process.pid);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'instance_guard_stale_overwritten' }),
    );
  });

  it('⑤ 释放后锁没了；重复释放返回 false 且不报错', () => {
    const stateDir = tempDir();
    const lockPath = path.join(stateDir, 'instance.lock');

    const acquired = acquireInstanceLock({ stateDir });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(existsSync(lockPath)).toBe(true);

    expect(releaseInstanceLock({ stateDir })).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(releaseInstanceLock({ stateDir })).toBe(false); // 已无锁，幂等返回 false
  });
});