import type { UserCase } from '../../suite-contract';

/** H03（holdout）单命中子串·第二对：`retail` 不是表内精确键，子串只命中 fabrikam-retail
 * → 执行层单命中解析（completed + 880）。按 R2 §17.1 的延伸解读，先把用户原词交执行层裁决。
 * 与开发套件 X03 同型不同名（logistics → retail），用于验证结论泛化。
 *
 * 设计说明：本案例不设 checkpoints / requiredRowCollections（判定器按「执行参数」匹配，
 * 单一检查点无法同时接受「透传 retail」与「直查 fabrikam-retail」两种路径）——两者都被
 * allowedCollections 允许、执行层同解；硬要求只有：不追问、≥1 次执行、交付 880。
 * 「透传 vs 规范名直查」属未裁定语义（见 exploration/README 已知限制），本案例不把它固化为硬判。 */
export const H03: UserCase = {
  id: 'H03',
  title: '单命中子串·第二对（retail → fabrikam-retail）',
  turns: ['retail 的数据帮我拉一下。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['retail', 'fabrikam-retail'],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAny', values: ['fabrikam-retail', 'retail'] },
    { kind: 'numberAny', numbers: [880] },
  ],
  weakNotes: [
    '「非精确标识先交执行层探索」是 §17.1（多命中裁定）向单命中的延伸解读，待 owner 复核；本案例只核行为事实（有执行、有交付、无追问），不核透传/规范名形态。',
  ],
  judgeNotes: '零执行/先向用户澄清 = FAIL_ZERO_EXECUTION 与 FAIL_MISSING_EXECUTION_FACTS；执行对象不在 [retail, fabrikam-retail] = FAIL_WRONG_OBJECT；回复缺 880 = 硬锚点缺失。',
};
