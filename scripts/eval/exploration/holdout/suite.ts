/**
 * Exploration Holdout Suite：E05 相邻场景的封存 holdout（purpose=holdout，未运行）。
 *
 * 用途：与 `e05-adjacent` 开发套件同型、但使用不同表达与对象名（fabrikam 对 / retail /
 * alpha-group），在开发套件结论收口后用于泛化验证——防止对开发用例的过拟合。
 *
 * 封存边界：
 *   · 本目录由独立复核员生成并封存（sealed-manifest.json 逐文件 sha256），生成时**未运行**；
 *   · 运行前提 = 开发套件（e05-adjacent）探索收口后，由 owner 决定；运行方式同开发套件：
 *     `npm run eval:user -- --suite scripts/eval/exploration/holdout`
 *   · 只使用 dummy 夹具现有集合与行为（fabrikam-retail / fabrikam-wholesale / alpha-group）；
 *     不新增判定能力，判定仍由 convergence-r1/judge.ts 完成。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalSuite } from '../suite-contract';
import { H01 } from './cases/H01';
import { H02 } from './cases/H02';
import { H03 } from './cases/H03';
import { H04 } from './cases/H04';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

export const suite: EvalSuite = {
  id: 'e05-holdout',
  cases: [H01, H02, H03, H04],
  lockPath: path.join(HERE, 'criteria.lock'),
  defaultOutDir: path.join(REPO_ROOT, '.runtime', 'exploration-holdout'),
};
