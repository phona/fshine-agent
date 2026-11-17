/**
 * scope-reference 套件（R3 Batch 2 · 多轮查询的作用域与指代决策）：M01–M07 行为矩阵定稿用例。
 *
 * 边界：只使用 dummy 夹具现有集合/窗口/行为（alpha / beta / documents）；
 * 不新增执行层能力、业务规则或期望数据（用例事实由 dummy 现有行为支持）。
 * 运行：npm run eval:user -- --suite scripts/eval/exploration/scope-reference
 * 冻结：node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/scope-reference
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, type EvalSuite } from '../suite-contract';
import { M01 } from './cases/M01';
import { M02 } from './cases/M02';
import { M03 } from './cases/M03';
import { M04 } from './cases/M04';
import { M05 } from './cases/M05';
import { M06 } from './cases/M06';
import { M07 } from './cases/M07';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const suite: EvalSuite = {
  id: 'scope-reference',
  cases: [M01, M02, M03, M04, M05, M06, M07],
  lockPath: path.join(HERE, 'criteria.lock'),
  defaultOutDir: path.join(REPO_ROOT, '.runtime', 'scope-reference'),
};
