/**
 * 业务 E2E 探测基线（阶段 2）套件装配——消费 `suite-contract.ts` 的 `loadSuite` 接缝。
 *
 * 只提供数据面（cases / lock / out）：用例形状为 `BizCase`（`UserCase` 超集），
 * 判定仍归 `scripts/eval/business-e2e/judge.ts`（套件不自带判定分支）。
 * 目录必须落在 `scripts/eval/exploration/` 之下（loadSuite fail-closed）。
 *
 * 运行装配（消费 batch/collect/judge + 驱动器）见 `scripts/eval/business-e2e/run.ts`。
 * 冻结：node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/bizprobe
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalSuite } from '../suite-contract';
import { bizCases } from './cases';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

export const suite: EvalSuite = {
  id: 'bizprobe',
  cases: bizCases,
  lockPath: path.join(HERE, 'criteria.lock'),
  defaultOutDir: path.join(REPO_ROOT, '.runtime', 'bizprobe'),
};
