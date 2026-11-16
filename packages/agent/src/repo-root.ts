/**
 * 仓库根定位（标记法，不依赖 process.cwd）。
 *
 * 为什么需要：Main 技能面固定从「仓库根的 `.agents/skills`」发现。宿主可能以任意 cwd
 * 启动（`npm run ask`、server、测试、构建产物），**cwd 不是可信定位依据**——它随调用者
 * 变化，`process.cwd()` 解析出的技能目录可能指向错误的位置。
 *
 * 判据：自本模块位置向上逐层找「同目录既有 `package.json`、又有 `.agents/` 目录」的目录；
 * 最多向上 6 层。星源码布局（`packages/agent/src`）与构建产物布局（`dist/packages/agent/src`
 * 或等价打包层级）都落在该深度内。找不到即 fail-closed——给出起始目录、已查层级与判据，
 * 不做「猜测某个祖先」「回落到 cwd」之类的静默兜底。
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 向上查找层数上限（含起始目录；缺省 6）。 */
export const REPO_ROOT_MAX_DEPTH = 6;

export interface ResolveRepoRootOptions {
  /**
   * 起始目录（绝对路径；缺省 = 本模块所在目录）。
   * 只供测试/构建布局校验使用；生产调用一律不传。
   */
  from?: string;
  /** 向上查找层数上限（缺省 REPO_ROOT_MAX_DEPTH）；测试可传更小值验证失败路径。 */
  maxDepth?: number;
}

/** 模块自身所在目录（构建产物布局下仍是产物文件所在目录，不是 cwd）。 */
export function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 标记判据：同目录既有 `package.json`（文件）又有 `.agents/`（目录）。 */
function hasRepoMarkers(directory: string): boolean {
  return isFile(path.join(directory, 'package.json')) && isDirectory(path.join(directory, '.agents'));
}

/**
 * 自模块位置向上定位仓库根（标记法）。
 *
 * @throws 找不到时抛错（含起始目录、层数上限与已查目录链），调用方不得据此降级。
 */
export function resolveRepoRoot(options: ResolveRepoRootOptions = {}): string {
  const maxDepth = options.maxDepth ?? REPO_ROOT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`仓库根定位参数非法：maxDepth=${String(options.maxDepth)}`);
  }
  const start = path.resolve(options.from ?? moduleDir());
  const searched: string[] = [];
  let current = start;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    searched.push(current);
    if (hasRepoMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `仓库根定位失败：自 ${start} 向上查找 ${maxDepth} 层未找到同时包含 package.json 与 .agents/ 的目录`
    + `（已查：${searched.join(' → ')}）。请确认从仓库内运行，或该构建产物位于仓库层级之内。`,
  );
}
