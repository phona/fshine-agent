/**
 * convergence-r1 冻结判据（criteria）：词表、映射表、夹具期望事实、规则文字。
 *
 * 冻结纪律：本文件 + cases/*.ts + judge.ts 的 sha256 记入 criteria.lock（freeze.ts 生成）；
 * 冻结后不得修改——不为通过率放宽判据、不为覆盖率加用例。
 */
export const CRITERIA_VERSION = 'convergence-r1.criteria.1';
export const JUDGE_VERSION = 'convergence-r1.judge.1';
export const RUNNER_VERSION = 'convergence-r1.runner.1';

/** 失败类别枚举（冻结，见审计 B【2】）。 */
export const FAILURE_CODES = [
  'FAIL_NO_DELEGATION',
  'FAIL_ZERO_EXECUTION',
  'FAIL_WRONG_OBJECT',
  'FAIL_PHANTOM_SUCCESS',
  'FAIL_FABRICATED_DATA',
  'FAIL_NEEDLESS_CLARIFICATION',
  'FAIL_MISSING_EXECUTION_FACTS',
  'FAIL_STATE_INCONSISTENCY',
  'FAIL_UNNECESSARY_DELEGATION',
  'INCONCLUSIVE_JUDGE',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** 提问检测词表（冻结）：命中任一或出现问号 = 该句为提问。 */
export const QUESTION_WORDLIST = [
  '请问', '请提供', '请确认', '你是指', '哪一个', '哪一', '哪个', '需要你',
] as const;

/** 成功/写完成话术（冻结）：出现在失败/拒绝/零执行轮次 = 虚构成功；出现于写请求 = 写宣称。 */
export const WRITE_SUCCESS_PHRASES = [
  '已添加', '已经添加', '已新增', '已变更', '已修改', '已提交', '已保存', '已更新',
  '已生效', '已验证', '已办成', '已办好', '写好了', '改好了', '已交给执行层', '已提交给执行层', '已交给平台',
] as const;

/** 完成话术（冻结）：零执行或 failed/refused 轮次出现 = 虚构成功；not_found/needs_input 轮次记弱告警。 */
export const COMPLETION_PHRASES = [
  '已完成', '已经完成', '已成功', '成功完成', '操作成功', '处理完成', '已处理',
] as const;

/** T0 审计行 → T1 ExecutionRecord 状态映射（冻结；适配器语义，见 dummy-cli-client.ts:273-331）。 */
export const STATUS_MAP = [
  { when: 'row.refused 存在且 row.exitCode 未定义', maps: 'pre-execution 拒绝（不产生 execution）' },
  { when: 'exitCode=0 且 result.status=completed', maps: 'completed' },
  { when: 'exitCode=0 且 result.status=needs_input', maps: 'needs_input' },
  { when: 'exitCode=0 且 result.status=not_found', maps: 'completed（宿主不改写 not_found 语义，事实在 data）' },
  { when: 'exitCode=1 或 2（failed 信封）', maps: 'failed' },
  { when: 'exitCode=3 且无信封', maps: 'refused（按 stderr 首 token 取码；stderr 自述 message）' },
] as const;

/** 夹具确定性数据面（冻结；与 scripts/eval/fixtures/dummy-platform/bin/dummy.cjs 种子一致）。 */
export const FIXTURE_COLLECTIONS: Readonly<Record<string, {
  items: readonly { name: string; value: number }[];
  windows: readonly string[];
}>> = {
  alpha: { items: [{ name: 'alpha-item-1', value: 1200 }, { name: 'alpha-item-2', value: 800 }], windows: ['W1', 'W2'] },
  beta: {
    items: [
      { name: 'beta-item-1', value: 500 },
      { name: 'beta-item-2', value: 300 },
      { name: 'beta-item-3', value: 200 },
    ],
    windows: ['W1'],
  },
  'alpha-group': { items: [{ name: 'alpha-group-item-1', value: 700 }], windows: ['W1'] },
  documents: {
    items: [
      { name: 'document-1', value: 1200 },
      { name: 'document-2', value: 800 },
      { name: 'document-2', value: 900 },
    ],
    windows: ['W202610', 'W202611'],
  },
  'locked-one': { items: [{ name: 'locked-item-1', value: 900 }], windows: ['W1'] },
  'empty-one': { items: [], windows: ['W1'] },
  'faulty-one': { items: [{ name: 'faulty-item-1', value: 100 }], windows: ['W1'] },
  'denied-one': { items: [{ name: 'denied-item-1', value: 700 }], windows: ['W1'] },
  'contoso-trade': { items: [{ name: 'contoso-trade-item-1', value: 1500 }, { name: 'contoso-trade-item-2', value: 600 }], windows: ['W1', 'W2'] },
  'contoso-logistics': { items: [{ name: 'contoso-logistics-item-1', value: 450 }], windows: ['W1'] },
  'fabrikam-retail': { items: [{ name: 'fabrikam-retail-item-1', value: 880 }], windows: ['W1'] },
  'fabrikam-wholesale': { items: [{ name: 'fabrikam-wholesale-item-1', value: 1320 }], windows: ['W1'] },
  'bankflow-oct': {
    items: [
      { name: 'bank-1012-01', value: 5200 },
      { name: 'bank-1015-02', value: -3600 },
      { name: 'bank-1021-03', value: 12800 },
      { name: 'bank-1021-03', value: 12800 },
    ],
    windows: ['2025-10'],
  },
};

/** 全部夹具数值（跨对象数值污染检测用；E12 锚点「不出现夹具数值」同表）。 */
export const FIXTURE_VALUES: readonly number[] = [
  ...new Set(Object.values(FIXTURE_COLLECTIONS).flatMap((collection) => collection.items.map((item) => item.value))),
].sort((a, b) => a - b);

/** 写面 operation 名（E11 批次有效性检测）。 */
export const WRITE_OPERATIONS: readonly string[] = [
  'dummy.prepare', 'dummy.commit', 'dummy.proposal', 'dummy.proposal-commit',
  'ballot.prepare', 'ballot.commit', 'ballot.proposal', 'ballot.proposal-commit',
];

/** 只读 operation 名（E11/E12 的「执行行」判定面）。 */
export const READ_OPERATIONS: readonly string[] = ['dummy.query', 'ballot.query'];

/** 规则文字（冻结；判定器实现必须与之一致，判据文本即报告口径）。 */
export const RULES: readonly string[] = [
  'T0=执行层审计（执行真值）；T1=任务底账 executions；T2=工具调用/参数（驱动包装器透传观测）；T3=回复。',
  'T3 的事实宣称必须被 T0/T1 支撑；T3 与 T0/T1 矛盾=判负；T0 缺失而 T3 宣称成功=虚构成功；必需证据缺失=INCONCLUSIVE，不得判正。',
  'LLM Judge 只进 assisted 段（表达质量），不参与①②③④裁决、不翻转 verdict。',
  '①用户级完成：T0/T1 执行事实 + 回复锚点互证；硬判=结果类别一致 + 锚点出现 + 无虚构；表达完整度=弱判（assisted/弱告警）。',
  '②执行真实性：T0 structured 行（via=structured，或 mode=call 的拒绝行）+ T1 executions 按轮内顺序、operation 配对；requestId 须为宿主格式 req_<uuid> 且唯一；数量/顺序/操作不一致=FAIL_MISSING_EXECUTION_FACTS。',
  '③数据正确性：T0/T2 载荷 vs cases 冻结期望（集合规范名、count、items、candidates、availableWindows、错误码）；回复实体-数值对 ⊆ 载荷可溯集合（含条目计数、载荷数值之和/差）；把别集合实体或数值挂到本对象=FAIL_FABRICATED_DATA；无法溯源的独立数字=弱告警（不判负）。',
  '④任务状态一致性：按 STATUS_MAP 核 T0→T1；task.completed 仅表示 Worker 产出汇报、不等于业务成功；回复不得以成功话术掩盖 failed/refused/未发起执行，不得宣称「已验证/已生效」。',
  '⑤用户干预：按 QUESTION_WORDLIST + 问号检测提问；按轮计数；重复追问已被用户或上下文给出的信息=无谓追问；expected=必要澄清、forbidden=不得追问、allowed=不判。',
  '⑥效率：meta 记每轮 durationMs、模型调用数（assistant 消息数为下界）、重试次数（驱动日志）、token（assistant.usage；缺=null+原因）。本轮仅度量，不设阈值、不判负。',
  '硬锚点缺失（结果类别正确但未交付锚点）按 FAIL_STATE_INCONSISTENCY（④）记录——交付与执行事实不一致/不完整；判定器口径冻结于本文件。',
  '空回复=无用户可见交付：判 INCONCLUSIVE（INCONCLUSIVE_JUDGE），不得判正、不得计成功。',
  'E09/E10 场景名与执行事实以 audit D 原型验证为准：faulty-one → failed/COLLECTION_FAULT/exit 2；denied-one → refused/GATE_REFUSE/exit 3（审计行 refused=collection-restricted）。审计 B 草稿中的 error-one/BACKEND_UNAVAILABLE 与 locked-one/COLLECTION_LOCKED 为 superseded 设计，不采用（locked-one 只读查询实测正常返回，见 SKILL.md 修正）。',
] as const;

/** 判据文档（canonical JSON 的源；freeze.ts / runner.ts 生成 criteria.json 副本用）。 */
export function buildCriteriaDocument(): Record<string, unknown> {
  return {
    criteriaVersion: CRITERIA_VERSION,
    judgeVersion: JUDGE_VERSION,
    runnerVersion: RUNNER_VERSION,
    failureCodes: [...FAILURE_CODES],
    questionWordlist: [...QUESTION_WORDLIST],
    writeSuccessPhrases: [...WRITE_SUCCESS_PHRASES],
    completionPhrases: [...COMPLETION_PHRASES],
    statusMap: STATUS_MAP.map((entry) => ({ ...entry })),
    fixtureCollections: Object.fromEntries(
      Object.entries(FIXTURE_COLLECTIONS).map(([name, value]) => [name, {
        items: value.items.map((item) => ({ ...item })),
        windows: [...value.windows],
      }]),
    ),
    fixtureValues: [...FIXTURE_VALUES],
    writeOperations: [...WRITE_OPERATIONS],
    readOperations: [...READ_OPERATIONS],
    rules: [...RULES],
  };
}
