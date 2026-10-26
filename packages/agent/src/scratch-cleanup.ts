/**
 * 工作区清理（`tmp/task_<taskId>/`）。
 *
 * 为什么需要：worker 的 write 被机械边界限制在 `tmp/task_<taskId>/`，每个子任务一个
 * （同任务的续跑共享同一个工作区）。不清理就会无限堆积——而它里面的东西（提案 payload、
 * mapping、临时脚本）都是可再生产物，没有长期价值。
 *
 * 三条纪律，缺一不可：
 *   ① **只删 `tmp/task_<uuid>` 形态的位置**。tmp/ 同时是平台自己的产物区（探针输出、
 *      交互式跑出来的 contract.json、`tmp/excels/` …），绝不能碰。命名不匹配的一律不删。
 *      宁可漏删，不可误删。
 *   ② **只删位置，不删文件**。同 ①：tmp/ 下的散文件是平台的。
 *   ③ **终态即删，不按一刀切年龄删**（W5 起，原"按年龄删"升级）。worker 会话可以跨轮
 *      续跑（taskId 续用同一个工作区），所以删的判据不是"回合结束"而是**任务终态**：
 *      交付物已在回合末复制进会话产物库（apps/server/artifact-store.ts），续跑要旧产物
 *      时宿主从库里物化，不再依赖 scratch 还在。终态任务（done/failed）过一个短 grace
 *      （排障与重试窗口）即删；在飞的与刚终态的一律保留。判据由调用方注入
 *      （`isTerminal`），本模块不认识任务台账——零业务知识。
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** 我们的工作区名形态：`task_<uuid>`（宿主 taskId = `task_${randomUUID()}`）。 */
const SCRATCH_DIR_RE = /^task_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ScratchSweepResult {
  /** 已删除的位置名 */
  removed: string[];
  /** 因未超 TTL 而保留的位置名 */
  kept: string[];
  /** 删除失败的原因（不中断扫描：一个位置删不掉不该挡住其余） */
  errors: Array<{ name: string; error: string }>;
}

/** 供测试与调用方复用同一判据（TSV/日志里要能解释"为什么这个没被删"）。 */
export function isScratchDirName(name: string): boolean {
  return SCRATCH_DIR_RE.test(name);
}

/**
 * W5 的双年龄清理策略（终态即删 + 抛弃兜底）。
 *
 * - `terminalGraceMs`：终态任务的保留时长。交付物已在回合末复制进会话产物库
 *   （apps/server/artifact-store.ts），续跑要旧产物时宿主从库里物化，scratch 不再
 *   不可替代；终态后只留一段排障与重试窗口。
 * - `abandonedTtlMs`：非终态任务的闲置保留时长（抛弃兜底——从没拿到结局的任务，
 *   如崩溃的委派；没有它这批位置会无限堆积）。
 * - `isTerminal`：终态判据，参数是位置名（即 taskId）。抛错或返回 false 都按非终态。
 */
export interface ScratchSweepPolicy {
  terminalGraceMs: number;
  abandonedTtlMs: number;
  isTerminal: (taskId: string) => boolean;
  /** Durable run/delivery protection; pinned workspaces survive both TTLs. */
  isPinned?: (taskId: string) => boolean;
}

/** 列出一批草稿位置名（判据快照用：调用方要先知道有哪些任务才能查台账）。 */
export function listScratchDirNames(root: string): string[] {
  try {
    return (readdirSync(path.join(root, 'tmp')) as string[]).filter(isScratchDirName);
  } catch {
    return [];
  }
}

/**
 * 扫一遍 `<root>/tmp/`，删掉超龄的草稿位置。
 *
 * 两种形态：
 * - `sweepScratchDirs(root, now, ttlMs)`：纯年龄删（排障/旧调用方；ttlMs ≤ 0 = 全清）。
 * - `sweepScratchDirs(root, now, policy)`：终态判据删（W5 起的生产形态）——终态且
 *   闲置超 `terminalGraceMs` 才删；非终态闲置超 `abandonedTtlMs` 才删（抛弃兜底）。
 */
export function sweepScratchDirs(root: string, nowMs: number, ttlOrPolicy: number | ScratchSweepPolicy): ScratchSweepResult {
  const tmp = path.join(root, 'tmp');
  const result: ScratchSweepResult = { removed: [], kept: [], errors: [] };
  let entries: string[];
  try {
    entries = readdirSync(tmp, { withFileTypes: false }) as string[];
  } catch {
    return result; // tmp/ 不存在 = 没有草稿可清，不是错误
  }
  const wipeAll = typeof ttlOrPolicy === 'number' && ttlOrPolicy <= 0; // 排障档：全清
  for (const name of entries) {
    if (!isScratchDirName(name)) continue; // ① 只认自己的命名
    const full = path.join(tmp, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
      if (!stat.isDirectory()) continue; // ② 只删位置
    } catch {
      continue; // 扫描过程中目标已消失：当作没发生过
    }
    if (!wipeAll) {
      const idleMs = nowMs - stat.mtimeMs;
      if (typeof ttlOrPolicy === 'number') {
        if (idleMs < ttlOrPolicy) { result.kept.push(name); continue; } // 旧形态：未超龄
      } else {
        if (pinnedFor(ttlOrPolicy, name)) { result.kept.push(name); continue; }
        // W5 策略形态：终态走短 grace（交付物已在会话库），非终态走长 TTL（抛弃兜底）。
        const ttl = terminalFor(ttlOrPolicy, name) ? ttlOrPolicy.terminalGraceMs : ttlOrPolicy.abandonedTtlMs;
        if (idleMs < ttl) { result.kept.push(name); continue; }
      }
    }
    try {
      rmSync(full, { recursive: true, force: true });
      result.removed.push(name);
    } catch (error) {
      result.errors.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** 终态判据的安全调用：抛错 = 不确定 = 非终态（保留不删，宁可漏删）。 */
function terminalFor(policy: ScratchSweepPolicy, taskId: string): boolean {
  try {
    return policy.isTerminal(taskId);
  } catch {
    return false;
  }
}

/** Pinned means an active run or undelivered result still depends on this workspace. */
function pinnedFor(policy: ScratchSweepPolicy, taskId: string): boolean {
  if (!policy.isPinned) return false;
  try {
    return policy.isPinned(taskId);
  } catch {
    return true;
  }
}

/** 生成一个工作区名（与宿主 taskId 同形；测试与工具用）。 */
export function newScratchDirName(): string {
  return `task_${randomUUID()}`;
}
