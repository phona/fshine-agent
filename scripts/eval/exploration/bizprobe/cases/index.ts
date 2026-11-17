/**
 * 业务 E2E 探测基线（阶段 2）场景用例集——6 类可跑场景（预注册 §二 #1/#2/#3/#4/#6/#8）。
 *
 * 每用例独立 config/db/state/session（由 `../../../business-e2e/assembly` 的每样本工作目录落实）；
 * 输入语料、授权范围、三类期望（机械/行为/UX）、证据类、失败判据都在各用例文件写死。
 * 中性名词（record / collection / window）；只用仓内 dummy 夹具既有种子。
 * #5 对话面只跑零额度契约探针、#7 会话压缩与臂 A/B 本批不跑（blocked-by 缺口 1/3/2）。
 */
import type { BizCase } from '../../../business-e2e/scenarios';
import { B01 } from './B01';
import { B02 } from './B02';
import { B03 } from './B03';
import { B04 } from './B04';
import { B06 } from './B06';
import { B08 } from './B08';

/** 本批可跑场景用例集（#1/#2/#3/#4/#6/#8，各 N=3 → 18 样本）。 */
export const bizCases: readonly BizCase[] = [B01, B02, B03, B04, B06, B08];

export { B01, B02, B03, B04, B06, B08 };
