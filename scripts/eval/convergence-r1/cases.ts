/**
 * 用户级收敛评测（convergence-r1）用例类型与汇总。
 *
 * 判据总则（冻结）：
 *   T0 = 执行层审计（执行真值）；T1 = 任务底账 executions；T2 = 工具调用/参数（驱动包装器观测）；
 *   T3 = 回复文本。T3 的事实宣称必须被 T0/T1 支撑；T3 与 T0/T1 矛盾 = 判负；
 *   T0 缺失而 T3 宣称成功 = 虚构成功；必需证据缺失 = INCONCLUSIVE，不得判正。
 *   LLM Judge 只进 assisted 段（表达质量），不参与裁决、不翻转 verdict。
 *
 * 本文件只承载用例数据；判定规则在 judge.ts，冻结词表/映射在 criteria.ts。
 */
export interface ItemFact {
  name: string;
  value: number;
}

/** 单条执行期望（对 T0 行 / T2 outcome 的检查点）。 */
export interface ResultCheckpoint {
  /** 期望查询对象（规范名/检索名）。 */
  collection: string;
  /** 期望 T0 行 result.status（not_found/needs_input/completed）。 */
  status: 'completed' | 'needs_input' | 'not_found';
  count?: number;
  items?: readonly ItemFact[];
  /** needs_input 候选（来自 T2 outcome.data.candidates；T0 result 不落候选）。 */
  candidates?: readonly string[];
  /** not_found 可用窗口（来自 T2 outcome.data.availableWindows）。 */
  availableWindows?: readonly string[];
  /** 期望错误码（T1 error.code / T2 outcome.error.code；not_found 面由夹具语义推导，见 judge.ts）。 */
  errorCode?: string;
}

/** 回复锚点（硬锚点缺失 → ① 判负，码见 judge.ts 的锚点映射说明）。 */
export type AnchorRule =
  | { kind: 'containsAll'; values: readonly string[] }
  | { kind: 'containsAny'; values: readonly string[] }
  | { kind: 'numberAny'; numbers: readonly number[] }
  | { kind: 'noFixtureValues' };

/** 逐轮期望（多轮用例；turn 从 1 计）。 */
export interface TurnExpectation {
  turn: number;
  minExecutions?: number;
  /** 该轮每条执行行都必须满足的参数条件（规范化后的裸键等值）。 */
  requireRowArgs?: Readonly<Record<string, string>>;
  /** 该轮提问句子命中这些话题词 = 无谓追问。 */
  forbiddenQuestionTopics?: readonly string[];
  hardAnchors?: readonly AnchorRule[];
}

export interface CaseExpected {
  minExecutions?: number;
  /** 硬性上界（E11/E12：0）。 */
  maxExecutions?: number;
  /** 每条执行行都必须满足的参数条件。 */
  requireEveryRowArgs?: Readonly<Record<string, string>>;
  /** 每个集合至少一条执行行（多步覆盖）。 */
  requiredRowCollections?: readonly string[];
  /** 允许被查询的对象；执行行命中其他对象 = 错对象。 */
  allowedCollections: readonly string[];
  checkpoints?: readonly ResultCheckpoint[];
  /** 全部 T1 execution 的期望状态。 */
  expectedT1Status?: 'completed' | 'needs_input' | 'failed' | 'refused';
  /** 期望 T1 错误码（failed/refused 面）。 */
  expectedErrorCode?: string;
}

export interface UserCase {
  id: string;
  title: string;
  /** 用户输入语料（设计稿；冻结后 sha256 记入 manifest/criteria.lock）。 */
  turns: readonly string[];
  execPolicy: 'required' | 'optional' | 'zero';
  delegation: 'required' | 'allowed' | 'unnecessary';
  /** 用户干预（⑤）：expected=必要澄清；forbidden=不得无谓追问；allowed=不判。 */
  clarification: 'expected' | 'forbidden' | 'allowed';
  expected: CaseExpected;
  hardAnchors: readonly AnchorRule[];
  /** 弱判/登记说明（不判负）。 */
  weakNotes: readonly string[];
  perTurn?: readonly TurnExpectation[];
  judgeNotes?: string;
}

import { E01 } from './cases/E01';
import { E02 } from './cases/E02';
import { E03 } from './cases/E03';
import { E04 } from './cases/E04';
import { E05 } from './cases/E05';
import { E06 } from './cases/E06';
import { E07 } from './cases/E07';
import { E08 } from './cases/E08';
import { E09 } from './cases/E09';
import { E10 } from './cases/E10';
import { E11 } from './cases/E11';
import { E12 } from './cases/E12';

export const ALL_CASES: readonly UserCase[] = [E01, E02, E03, E04, E05, E06, E07, E08, E09, E10, E11, E12];

/** 规范化用例 id：接受 C01/E01/e01 形态；'all' 返回全部。 */
export function normalizeCaseId(raw: string): string[] {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'all') return ALL_CASES.map((c) => c.id);
  return value.split(',').map((part) => {
    const token = part.trim().toUpperCase();
    const match = /^([CE])(\d{1,2})$/.exec(token);
    if (!match) throw new Error(`无法识别的用例 id：${part.trim()}（用 E01–E12 或 all）`);
    return `E${match[2]!.padStart(2, '0')}`;
  });
}
