/**
 * 外部用例集（suite）加载接缝：让 convergence-r1 runner 的装配 / Dummy / T0–T3 证据 /
 * 判定器 / 隔离检查被独立套件复用，而不复制整套 harness。
 *
 * 纪律：
 *   · 本文件只在 runner 的 `--suite <dir>` 分支被消费；无 --suite 时 R1 行为与
 *     criteria.lock 校验逐字不变（runner.ts 默认上下文 = R1 常量）。
 *   · 套件目录必须落在 scripts/eval/exploration/ 之下且含 suite.ts，否则 fail-closed——
 *     不加载任意路径模块（本地开发工具的信任边界尽量小）。
 *   · suite.ts 只提供数据面（cases / lock / out / 可选解析与判据文档），不携带执行逻辑；
 *     判定仍由 convergence-r1/judge.ts 完成，套件不得自带判定分支绕过它。
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { UserCase } from '../convergence-r1/cases';

export type { UserCase } from '../convergence-r1/cases';

/** 仓根（scripts/eval/exploration/suite-contract.ts → 上三级）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** 套件唯一允许的根目录。 */
export const EXPLORATION_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'exploration');

/** 外部套件契约：runner 拿到的全部可配置面；其余一律沿用 R1 实现。 */
export interface EvalSuite {
  /** 套件 id（进 manifest/summary 与报告标题）。 */
  id: string;
  /** 用例数据（与 convergence-r1 UserCase 同构；纯数据，禁函数字段）。 */
  cases: readonly UserCase[];
  /** 套件自己的 criteria.lock 路径（必须落在 exploration 根之下）。 */
  lockPath: string;
  /** 未显式传 --out-dir 时的输出根。 */
  defaultOutDir: string;
  /** 可选：套件判据版本标签（缺省沿用 R1 CRITERIA_VERSION）。 */
  criteriaVersion?: string;
  /** 可选：`--case` 选择解析（缺省 genericResolveCaseIds）。 */
  resolveCaseIds?: (raw: string) => string[];
  /** 可选：冻结判据文档（缺省沿用 R1 buildCriteriaDocument；套件一般不覆盖）。 */
  criteriaDocument?: () => Record<string, unknown>;
}

function realPathOrError(target: string, what: string): string {
  try {
    return realpathSync(target);
  } catch {
    throw new Error(`${what}不存在或不可解析：${path.relative(REPO_ROOT, target) || target}`);
  }
}

/** 校验并加载 <dir>/suite.ts；任何形状问题 fail-closed 抛出。 */
export async function loadSuite(dir: string): Promise<EvalSuite> {
  const suiteDirReal = realPathOrError(path.resolve(dir), 'suite 目录');
  const explorationRootReal = realPathOrError(EXPLORATION_ROOT, 'exploration 根目录');
  const relative = path.relative(explorationRootReal, suiteDirReal);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`suite 目录必须在 ${path.relative(REPO_ROOT, EXPLORATION_ROOT)}/ 之下：${path.relative(REPO_ROOT, suiteDirReal) || '.'}`);
  }
  const suiteFile = path.join(suiteDirReal, 'suite.ts');
  if (!existsSync(suiteFile)) {
    throw new Error(`suite.ts 缺失：${path.relative(REPO_ROOT, suiteFile)}`);
  }
  const loaded = await import(pathToFileURL(suiteFile).href) as { suite?: unknown; default?: unknown };
  const candidate = loaded.suite ?? loaded.default;
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('suite.ts 必须导出 EvalSuite 对象（具名 suite 或 default）');
  }
  const suite = candidate as Partial<EvalSuite>;
  if (typeof suite.id !== 'string' || suite.id.trim() === ''
    || !Array.isArray(suite.cases)
    || typeof suite.lockPath !== 'string' || typeof suite.defaultOutDir !== 'string') {
    throw new Error('suite.ts 的 EvalSuite 形状不完整（需要 id/cases/lockPath/defaultOutDir）');
  }
  const lockReal = realPathOrError(path.dirname(suite.lockPath), 'suite lock 目录');
  const lockRelative = path.relative(explorationRootReal, lockReal);
  if (lockRelative === '' || lockRelative.startsWith('..') || path.isAbsolute(lockRelative)) {
    throw new Error(`suite lockPath 必须落在 ${path.relative(REPO_ROOT, EXPLORATION_ROOT)}/ 之下：${path.relative(REPO_ROOT, suite.lockPath)}`);
  }
  return suite as EvalSuite;
}

/** 通用 `--case` 解析：'all' / 逗号分隔 / 大小写不敏感匹配套件内 id。 */
export function genericResolveCaseIds(cases: readonly UserCase[], raw: string): string[] {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'all') return cases.map((caseDef) => caseDef.id);
  const known = cases.map((caseDef) => caseDef.id);
  return value.split(',').map((part) => {
    const token = part.trim();
    const hit = known.find((id) => id.toLowerCase() === token.toLowerCase());
    if (hit === undefined) throw new Error(`无法识别的用例 id：${token}（可用：${known.join('、')}）`);
    return hit;
  });
}
