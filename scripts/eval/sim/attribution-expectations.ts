/**
 * SimCase · 归因判据声明（Harness 侧，不进模拟用户 prompt、不参与 Oracle 判定）。
 *
 * 为什么需要这份声明：归因模块只解释、不改判；如果用例不声明「期望发生什么」，
 * `delegationFidelity` / `dataAcquired` / `businessComputed` 只能记 `null`（未观测）。
 * 旧复核看到的「真实跑批里大半项恒为未观测」就是这种情形——**缺的是声明字段，不是证据**。
 * 这里按用例的业务目标把可机械核对的期望写死（同批 SIM 用例共用一份读切片夹具）：
 *
 *   · 读场景（SIM-01..08）：目标都是取数，期望至少一次 `dummy.query`，必须取到数据，
 *     最终回复必须出现可核对的数值；
 *   · 写场景（SIM-09/10）：期望一次 `dummy.commit`；它们不在 ask 读切片的真实跑批里
 *     （`./write-system` 假系统专用），声明只为复用归因时口径一致。
 *
 * `methodMarkers` 故意不声明：**读取技能后「业务方法是否体现」没有机械真值**——技能正文
 * sha256/字节数只能证明读了哪份，不能证明方法被用上。归因会把它标成「不可观测」并给出
 * 原因，而不是留空或记假。要判它，必须在具体实验里另行声明可核对的业务方法标记。
 */
import type { SimAttributionExpectations } from './attribution';

/** 读切片用例：取数 → 计算 → 交付。 */
const READ_CASE: SimAttributionExpectations = Object.freeze({
  expectedOperations: ['dummy.query'],
  requiresData: true,
  requiresComputation: true,
});

/** 写场景用例：入账（不在 ask 读切片跑批）。 */
const WRITE_CASE: SimAttributionExpectations = Object.freeze({
  expectedOperations: ['dummy.commit'],
  requiresData: false,
  requiresComputation: true,
});

/**
 * caseId → 归因判据。未登记的用例仍可归因，但缺省项会带「不可观测」原因进入证据，
 * 不得由归因模块凭猜补判。
 */
export const SIM_ATTRIBUTION_EXPECTATIONS: ReadonlyMap<string, SimAttributionExpectations> =
  new Map([
    ['SIM-01', READ_CASE],
    ['SIM-02', READ_CASE],
    ['SIM-03', READ_CASE],
    ['SIM-04', READ_CASE],
    ['SIM-05', READ_CASE],
    ['SIM-06', READ_CASE],
    ['SIM-07', READ_CASE],
    ['SIM-08', READ_CASE],
    ['SIM-09', WRITE_CASE],
    ['SIM-10', WRITE_CASE],
  ]);
