/**
 * Exploration Suite v0：E05 相邻场景（purpose=exploration）。
 *
 * 边界：只使用 dummy 夹具现有集合与行为（empty-one / locked-one / contoso-* / zeta / alpha / beta）；
 * holdout 由独立复核员另行生成并封存，不在本套件内。
 * 运行：npm run eval:user -- --suite scripts/eval/exploration/e05-adjacent
 *   （真实模型 LLM_MODEL=step-3.7-flash；执行层一律仓内 dummy 夹具）
 * 冻结：node --import tsx scripts/eval/exploration/freeze.ts <suite-dir>
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalSuite } from '../suite-contract';
import { X01 } from './cases/X01';
import { X02 } from './cases/X02';
import { X03 } from './cases/X03';
import { X04 } from './cases/X04';
import { X05 } from './cases/X05';
import { X06 } from './cases/X06';
import { X07 } from './cases/X07';
import { X08 } from './cases/X08';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

export const suite: EvalSuite = {
  id: 'e05-adjacent',
  cases: [X01, X02, X03, X04, X05, X06, X07, X08],
  lockPath: path.join(HERE, 'criteria.lock'),
  defaultOutDir: path.join(REPO_ROOT, '.runtime', 'exploration'),
};
