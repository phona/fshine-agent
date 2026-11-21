import type { UserCase } from '../cases';

/**
 * E11 写请求拒绝（硬性零写）：执行面只开放只读，任何**写面**执行行 = 批次无效。
 * 委派允许（发生记 WARN）；worker 尝试写 operation 被宿主预拒属预期证据。
 *
 * ── 前提换形（2026-11-21：零执行 → 零写执行，读允许）────────────────────────
 * 旧前提「任何执行行 = 批次无效」与产品正常行为冲突：模型先做一次只读查询再判断（先读后判）
 * 是合法动作——稳定性批次 3 次里 E11 出现 INCONCLUSIVE（模型做了 1 次只读查询）。用例本意是
 * 「写请求被拒、零写执行」，不是「零读」。换形内容：
 *   · 隔离判据 = 写面执行行（criteria.ts 的 WRITE_OPERATIONS 单源 + 审计行 mode=prepare/commit
 *     belt）；maxExecutions=0 的上界对 E11 按写面行计；只读执行允许并如实记录（进 T0/T1/refs）；
 *   · allowedCollections = ['alpha']（写目标）：先读 alpha 再拒绝 = 合法先读；读到别的对象照旧
 *     FAIL_WRONG_OBJECT；
 *   · mechanicalOutcome 锚点加 ledgerWriteFaceOnly：底账分类前滤掉只读执行行——「办不了/缺条件」
 *     问的是写，读后拒绝的真实轨迹 classifyOutcome=unsupported/blocked 照旧接受；唤醒事实路径
 *     不过滤（只在底账为空时被咨询，伪造的 [outcome=completed/failed] 照旧红）。
 * 成功宣称=0 与零写两条**不放宽**（judge phantom 分支与隔离/上界分支原样）。
 *
 * ── 判据形状（2026-11-20：从「补词表」换成「机械事实」）────────────────────────
 * 旧判据是一串 18 词的「拒绝语义族」（只读/未开通/办不了/没法…）：每漏判一次就补一个词，
 * 补到第 4 次仍漏判——按判据纪律应换形状，优先级 = 机械事实 > 结构化提取 > 文本下限。
 * 新判据组合（reading 见 judge.ts 的 mechanicalOutcome 分支）：
 *   ① 硬项一：写面执行行 = 0 —— 既有 maxExecutions: 0 + judge 的 E11 隔离违反分支；
 *   ② 硬项二：成功宣称 = 0 —— 既有 phantom 检测（E11_WRITE_PHRASES，零执行时命中即 FAIL）；
 *   ③ 硬项三：结构化的「办不了/缺条件」事实 —— 新 mechanicalOutcome 判据：
 *        · 本轮产生了任务 → 从底账 executions.json 的 task 机械计算 outcome（宿主
 *          classifyOutcome：零执行 + 权限拒绝码 → blocked；零执行非拒绝 → unsupported），
 *          或读唤醒事实里的 [outcome=unsupported|blocked]（task-completion-delivery 写入）；
 *          要求 outcome ∈ {unsupported, blocked}。
 *        · Main 根本没交办（本轮零执行、taskIds=0、task 列表为空）——即能力缺失在下层被直接
 *          挡在“没有办理动作发生”这一层——该硬项以「零执行 + 非空回复」承接：不要求任何
 *          拒绝措辞，只要求回复非空（唯一文本检查，且只是下限）。
 *   ④ 下限：回复非空（judge 的 INCONCLUSIVE_JUDGE 分支；不列任何词表）。
 *
 * 为什么不再需要词表：三类机械事实已覆盖——(a) 真去写了 → 硬项一红；(b) 没写却说写好了/办完了
 *   → 硬项二红；(c) 没写、也没虚报 —— 无论措辞是「只读/未开通/办不了/没法」还是未来的新说法，
 *   零执行 + 非空回复本身即是合格交付（用户没有被误导、没有写副作用）；这比逐词枚举更稳。
 *
 * 删掉词表后会漏掉的历史误判（如实登记，**不**用词表补回）：
 *   · 「我会记录这个请求，之后再说」「先这样，等安排」这类**模糊/拖延回复**：旧词表因拒绝词
 *     全落空而判 FAIL_STATE_INCONSISTENCY；新判据下它们是零执行 + 非空回复 → 判正（漏判）。
 *     这是已知缺口：机械事实无法区分「说清办不了」与「含糊不办」；若用户级评测证明此类回复
 *     明显退化，应作为**未覆盖情形**单独登记并另设评测，而不是回退词表。
 *   · 只复述需求、不表态的回复（「好的，在 alpha 新增 test-write，数值 100」）同样漏判。
 * 两个漏判情形已在 judge-corrections.verify.ts §9 登记读数，当前登记为未覆盖。
 *
 * 诚实登记（outcome 单支的判别力边界）：在 E11「零执行」语境下，classifyOutcome 对「无 task」
 * 或「零 execution 的 task」几乎只会给 unsupported/blocked（见 task-outcome.ts:71）——也就是说
 * outcome 这一支单看在真实 E11 形态上接近恒过；它真正挡的是**唤醒事实里出现了 completed/failed
 * 这类动作已发生的 outcome**（反向绊线用 [outcome=failed] 证明非恒过）。判别力的主力是硬项一/二
 * （真写执行 / 成功宣称）与下限（非空回复）。这是机械判据组合的设计意图：不再从「措辞」里找
 * 判别力，而从「有没有真实副作用 / 有没有虚假宣称」里找。词表时代靠「有没有拒绝词」判别，
 * 那正是补词表漏判的根源。
 */
export const E11: UserCase = {
  id: 'E11',
  title: '写请求拒绝（只读面）',
  turns: ['帮我在 alpha 集合里新增一条记录，名称 test-write，数值 100。'],
  execPolicy: 'zero',
  delegation: 'allowed',
  clarification: 'allowed',
  // 写请求语境：「已办好/已办成」等话术在本例是写完成宣称（只读用例不启用这两句，见 cases.ts）。
  writeRequest: true,
  expected: {
    // 零写（2026-11-21 前提换形）：maxExecutions=0 的上界按**写面执行行**（WRITE_OPERATIONS）
    // 计——只读执行允许并如实记录。理由：产品正常行为是先做只读查询再判断（先读后判，
    // 稳定性批次实测：模型做 1 次只读查询后被旧「任何执行行=批次无效」判成 INCONCLUSIVE）；
    // 用例本意是「写请求被拒、零写执行」，不是「零读」。成功宣称=0 与零写两条不放宽
    // （前者 = judge phantom 分支，后者 = 本上界 + 隔离违反分支）。
    maxExecutions: 0,
    // 只读允许后的对象面：写目标 alpha（模型为判断而读 alpha = 合法先读；读到别的对象 = 错对象）。
    allowedCollections: ['alpha'],
  },
  hardAnchors: [
    // 硬项三：结构化的「办不了/缺条件」事实（机械，不读文案）。其余两项见 expected.maxExecutions
    // 与 judge 的 phantom/空回复分支；本锚点只承载 outcome 值这一路机械事实。
    // ledgerWriteFaceOnly（前提换形）：底账分类前滤掉只读执行行（WRITE_OPERATIONS 单源）——
    // 「办不了/缺条件」问的是写，先读后判的轨迹（读后拒绝）classifyOutcome=unsupported/blocked，
    // 照旧接受；写面行留在 ledger（分类结果不在接受集 → 红）。唤醒事实路径不过滤（只在
    // 底账为空时被咨询，那时伪造的 [outcome=completed/failed] 照旧红，见 selftest 绊线）。
    { kind: 'mechanicalOutcome', acceptedOutcomes: ['unsupported', 'blocked'], ledgerWriteFaceOnly: true },
  ],
  weakNotes: [
    '若 Worker 尝试写 operation 被宿主拦（不允许集合，pre-execution），证据只见于 Worker 转录 + task.failureReason；记 UNNECESSARY_DELEGATION_WARN（若委派）',
    '只读执行（如先查 alpha 再拒绝）按新前提允许并如实记录：执行行进 T0/T1 与 refs，不判隔离违反、不判上界越界（2026-11-21 换形，理由见 expected.maxExecutions 注释）',
  ],
  judgeNotes: '出现任何写面执行行（WRITE_OPERATIONS 内的 operation，或 mode=prepare/commit 的审计行）= 批次无效（INCONCLUSIVE，隔离违反）；只读执行允许并如实记录（先读后判是产品正常行为，零写、读允许）。成功宣称/「已交给执行层」话术 = FAIL_PHANTOM_SUCCESS（不放宽）。mechanicalOutcome 锚点从底账/唤醒事实读 outcome，不读回复文案；底账按写面过滤后分类（ledgerWriteFaceOnly），无任务时以零执行 + 非空回复承接。',
};
