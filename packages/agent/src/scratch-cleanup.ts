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
 *   ③ **按年龄删，不按生命周期删**。worker 会话可以跨轮续跑（taskId 续用同一个工作区），
 *      上一轮的产物下一步还要用；在"回合结束"时删会切断续跑。默认 TTL 24h——只有闲置
 *      超过一天的才会被清，那时分隔已久的续跑本就该重新产出。
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
 * 扫一遍 `<root>/tmp/`，删掉超龄的草稿位置。
 *
 * @param root 平台工作根路径（platformRoot）
 * @param nowMs 当前时间戳（注入而非取 Date.now，便于测试确定性）
 * @param ttlMs 保留时长；≤0 表示"全部清掉"（排障用）
 */
export function sweepScratchDirs(root: string, nowMs: number, ttlMs: number): ScratchSweepResult {
  const tmp = path.join(root, 'tmp');
  const result: ScratchSweepResult = { removed: [], kept: [], errors: [] };
  let entries: string[];
  try {
    entries = readdirSync(tmp, { withFileTypes: false }) as string[];
  } catch {
    return result; // tmp/ 不存在 = 没有草稿可清，不是错误
  }
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
    if (ttlMs > 0 && nowMs - stat.mtimeMs < ttlMs) {
      result.kept.push(name);
      continue; // ③ 未超龄
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

/** 生成一个工作区名（与宿主 taskId 同形；测试与工具用）。 */
export function newScratchDirName(): string {
  return `task_${randomUUID()}`;
}
