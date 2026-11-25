> 历史归档：内部链接不保证可用；如需追改，以 git 历史为准。

# docs/decision-log.md · 第 2 块

## 十六、convergence-r1 用户级评测交付与判据冻结记录（2026-11-13，分支 arch/eval-r1）

**交付**：`scripts/eval/convergence-r1/`——12 用例（E01–E12，数据文件一例一个）+ 六维确定性判定器 + 证据 schema（每 case×trial 独立目录：inputs/model/toolcalls/transcripts/audit+index/executions/reply/meta/state/db/judgment）+ runner/judge/selftest/freeze/README；入口 `npm run eval:user`（生产同源装配：createSession + createDummyCliClient + 同一配置与任务底账；唯一插桩 = TurnDriver 记录包装器）；真模型面跑 `eval-real.yml`（1 轮）与 `eval-nightly.yml`（12×3）。

**第一次冻结（`d8faff6`）**：criteriaSha256=`9d4b0824a429658e7f633ff8af928fd3ad94b633f02c95f151866679bb8d6cd4`；casesSha256=`6d55a42ad0ff575cfe11fb4695861c6a7c28d46654c6e94de29170161e4d1a78`；files 18 项（criteria.ts / cases.ts / judge.ts / hash.ts / evidence.ts / selftest.ts + 12 用例文件）。

**冻结前验证（真实模型，不计入 36 次）**：E01–E12 每例至少 1 次实跑（smoke E01 一次 + 预冻结分批）；判定器自测 `--judge-selftest` 8/8；全样本原样保留（含 E05 两次判负样本）。

**重切（判据冻结后的判定器缺陷修复；「判定器自身缺陷」属允许修复类）**：正式 36 次运行开始前，用冻结判据复判存量全样本时发现三处判定器缺陷——① markdown 表格「序号」列的数字被当成与实体同句的不可溯源数值（E01 误判 `FAIL_FABRICATED_DATA`）；② 陈述句里的「分属哪个窗口」按冻结词表被当成提问（E01 误判 `FAIL_NEEDLESS_CLARIFICATION`）；③ T0/T2 同一载荷被重复计入「合计」推导（500+300+200 被算成 2000，1000 报弱告警）。

- **修复范围**：仅 `judge.ts`（子句分隔补表格竖线；判负门槛加「实际提问形态」——句末问号或请求式短语；载荷按值列表去重后做分组合计/组内差值/跨组合计）。**criteria.ts 与 12 用例文件逐字节未动**（两哈希不变）。
- **验证**：`--judge-selftest` 8/8；复判全部存量样本 27 trial、仅 3 处变化——post-cleanup E01 FAIL→PASS、pre-freeze2 E04 FAIL→PASS（两者均为上述假阳性）、pre-freeze E05 去掉一处被移除的全域状态检查（`FAIL_WRONG_OBJECT` 保留）；全部零执行/虚构类判负不变，无判负被放宽。

**第二次冻结（重切）**：judge.ts sha256=`fdf29e7d98a97e68c0c8b9e34b95a32822f1684786de57352f47c1c19ccbf64b`；criteriaSha256 / casesSha256 不变（判据与用例未改）；`frozenAt=2026-11-13T10:49:28Z`。此后判据、用例与判定器均不得再改。

**第三次冻结（E04 判定器缺陷修复重切，2026-11-13）**：36 次批次（12×3，runId `evalr1-2026-11-13T11-07-32-640Z-b124c5`）判负归因确认 E04 trial-1/2/3 均为判定器缺陷，按同流程修复后重切：

- **trial-1（可溯集合口径间隙）**：reply turn-2「按名称：document-1 共 1 条、1200；document-2 共 2 条、合计 1700。」；载荷 items=document-1:1200、document-2:800/900、count=3 → `1`/`2`/`1700` 均可由载荷按名计数与分组和导出，旧 traceable 只收整组长度/整组合计/全组合计/成对差值。修复：traceable 增补按名分组计数、分组和、同名组内差与不同名条数。
- **trial-2/3（话题裸词误伤）**：trial-2「…两个窗口查询里都存在，仍需要你确认哪一笔为准。」、trial-3「…或者先确认下两个窗口数据是否本应相同？」均因裸词 `窗口` 命中 `forbiddenQuestionTopics` 被误判复问。修复：话题复问改**短语式定位**（话题名词须与疑问/请求标记组成短语，如「哪个窗口/请提供窗口」；疑问词条目须后接话题名词，如「哪一个窗口」），裸名词与裸疑问词不再判负；语义边界 = 规则指「复问用户提供窗口/集合信息」，不含对数据一致性的追问。
- **验证**：`npx tsc --noEmit` → 0；`--judge-selftest` 8/8；对 36 份证据 `--judge-existing` 复判比对：仅 4 处 mismatch——E04 trial-1/2/3 FAIL→PASS（假阳性），E03 trial-3 PASS→PASS（仅去掉一条可溯源弱告警）；其余 32 份逐字节复现。全库存量样本复判无其他判负放宽（post-cleanup E04 仅去掉假阳性 NEEDLESS 子码，零执行类判负保留）。
- **第三次冻结**：judge.ts sha256=`734bd234eb168d882239832ff397b3af45dc13a3e3bf0562766a22e26b7a9f94`；criteriaSha256 / casesSha256 不变；`frozenAt=2026-11-13T11:30:50Z`。
- **修复后同例复测（真实模型，同一冻结判据）**：E04 ×3 全 PASS（trial-1/2/3；每轮各 ≥1 次结构化执行、taskIds 非空、无 failureCodes/弱告警）——证据 `.runtime/eval-r1/e04-after/`。复现轮（修复前）曾得到一例零执行模型行为样本（未委派、FAIL_NO_DELEGATION/FAIL_ZERO_EXECUTION），属模型方差、按原样留档。

**第四次冻结（E06 判定器缺陷修复重切，2026-11-13）**：36 次批次 E06/trial-3 判负归因确认「完成话术词表语境盲」——reply turn-1 的示例枚举「（如待处理/已完成）」被机械命中判 `FAIL_PHANTOM_SUCCESS`（同 case t1/t2 同形澄清回复无该示例词均 PASS，判负随措辞翻转）。修复（仅 judge.ts；判据/用例逐字节未动）：新增话术语境门 `contextualPhraseHit`——先剥括注（（）/()/【】）内容，只扫非疑问句，短语前 10 字内为示例标记（比如/例如/诸如/像是/如像）或近邻「如…」形态不计；同一道门同时用于完成话术与写完成话术（同类缺陷，同轮一并收口，未新增机制类别）。验证：`npx tsc --noEmit` → 0；`--judge-selftest` 8/8（phantom-success 反例仍正确判负，未误伤真检测）；36 份批次证据 `--judge-existing` 复判比对：mismatch 集合 = E03-3（弱告警消减）、E04-1/2/3（上一次修复）、E06-3 FAIL→PASS，其余逐字节复现；全库存量样本复判无其他判负放宽。第四次冻结：judge.ts sha256=`eb7a0c19e0afda6b63e822e3c6f73e8567e8539f7c590482c8a6a3b89889941c`；criteriaSha256 / casesSha256 不变；`frozenAt=2026-11-13T11:42:22Z`。
- **修复后同例复测（真实模型，同一冻结判据）**：E06 ×3 全 PASS（trial-1/2/3；零执行问询形态按 optional 判正，各 ~3.1s）——证据 `.runtime/eval-r1/e06-after/`。复现轮（修复前）同例 1 次 PASS（该轮回复未含示例词、未触发缺陷——判负随措辞，属方差）；缺陷复现依据为批次 trial-3 存证 + 修复前后 `--judge-existing` 比对。

**第五次冻结（E07 判定器口径缺陷修复重切，2026-11-13）**：36 次批次 E07/trial-1 判负归因确认两处判定器/判据口径缺陷（判据文本未动）：① **硬锚点词表窄于语义等价类**——reply「alpha 集合下没有 W9 窗口的数据。」「W9 窗口下没有任何数据。」因插入语无法逐字命中，containsAny 11 词全部未命中 → ①note「全部未命中」；② **自纠补查被误判条件丢失**——复现轮（修复前）模型对 W9 not_found 后自纠补查 W1/W2，被判「执行行条件丢失」`FAIL_WRONG_OBJECT`，与 E07 冻结 weakNote「随后自纠补查 W1/W2 = 允许（记录）」矛盾。修复（仅 judge.ts）：① containsAny 对含「无数据/没有数据/没有记录/无记录」标记的锚点列表增加**有界语义等价形态**（否定词…数据/记录/条目/内容，插入语 ≤12 字且不跨句；数据…不存在/为空——只对含该标记的锚点生效，当前仅 E07）；② `requireEveryRowArgs` 作用域收敛到「期望 not_found 结果首次出现」为止（含），其后的自纠行只受 allowedCollections 约束（其他单查用例无 not_found 检查点，作用域不变）。验证：`npx tsc --noEmit` → 0；`--judge-selftest` 8/8；批次 36 份 `--judge-existing` mismatch 集合 = E03-3/E04-1/2/3/E06-3/E07-1（累计重切），其中 E07-1 FAIL→PASS、E07-3 `FAIL_FABRICATED_DATA` 原样保留（模型行为）；E07 复现轮离线复判 PASS。第五次冻结：judge.ts sha256=`a6a5b29312df2daefae65f47f13bfa2fa6efe85165aa9460f89206aa16ed79f1`；criteriaSha256 / casesSha256 不变；`frozenAt=2026-11-13T11:48:26Z`。
- **修复后同例复测（真实模型，同一冻结判据）**：E07 ×3 全 PASS（trial-1/2/3；各 1 次结构化执行、taskIds 非空，18.3s/31.6s/19.0s）——证据 `.runtime/eval-r1/e07-after/`。修复前复现轮（1 次）呈现同一锚点缺陷 + 自纠误判，离线复判已转 PASS；E07/trial-3 的 `FAIL_FABRICATED_DATA`（模型引用技能文档数值冒充查询结果）按模型行为保留。

**第六次冻结（E04 话题复问锚点：文本判负 → 机械事实门控，2026-11-24）**：删 task.status 分支的 15 例全样本跑（runId `evalr1-2026-11-24T06-53-46-135Z-2ae6c6`）里 E04/trial-1 判 `FAIL_NEEDLESS_CLARIFICATION`——turn-2 末尾「…或者请确认这两个窗口是不是本来就应当不同，我再按别的口径查。」命中 `forbiddenQuestionTopics` 的「请确认…窗口」短语。**同族第 3 次误伤**：2026-11-13 第三次冻结的 trial-2/3（「仍需要你确认哪一笔为准」「先确认下两个窗口数据是否本应相同？」）就是这一族，当时的修复只把裸词收成短语式定位，没收窄「标记与名词之间夹 3–4 个字」的形态；按 AGENTS.md「同一族锚点补到第 3～4 次仍漏判 → 换判据形状」，本次不再补正则。

- **归因（机械事实）**：同轮 `requireRowArgs {collection: documents, window: W202610}` 命中——W202611/W202610 两个窗口都被执行行逐字转发、`completed`、三条数值 1200/800/900 与冻结期望一致。用户给的窗口明明被用了，提到「窗口」的问句问的就不可能是已给值，而是数据语义（两个窗口是否本应不同）。这正是第三次冻结注册注释里点名「不得误伤」的家族，实现没兑现注册。
- **修复范围**：仅 `judge.ts`（新增 `forwardedThisTurn` 机械事实台账；`forbiddenQuestionTopics` 命中时若同轮参数已转发 → 降级弱告警，不再判负）与 `selftest.ts`（多轮证据包能力 + E04 正控/反向绊线两包）。`criteria.ts` / `cases.ts` / 15 个用例文件**逐字节未动**（`criteriaSha256` / `casesSha256` 不变）。
- **验证**：`npx tsc --noEmit` → 0；`--judge-selftest` 23/23（新增 `e04-forwarded-topic-question` PASS+弱告警、`e04-not-forwarded-topic-question` 仍判 `FAIL_NEEDLESS_CLARIFICATION`——证明门控不是橡皮图章）；对 15 份证据 `--judge-existing` 复判：mismatch 集合 = **E04-1 一条**（FAIL→PASS，附一条弱告警保留信号），其余 14 例逐字节复现；零执行/虚构/错对象/状态类判负一条未动。
- **第六次冻结**：judge.ts sha256=`45cb1865eba7830cd2c135466f53cbe7aa82b34b9c599f50a038eea8bc1547b0`；selftest.ts sha256=`737c413f0259c886d275ed8c689a43ceed6764d7303303baf34475364ba88659`；criteriaSha256 / casesSha256 不变；`frozenAt=2026-11-24T07:11:36Z`。
- **为什么不算放宽判负**：该锚点注册要拦的失败形态（模型不转发用户给的窗口、改成拿话问用户）由机械判据 `FAIL_WRONG_OBJECT` 承担，且反向绊线证明文本锚点在机械事实缺席时判负能力原样保留；被降级的正是注册注释点名不得误伤的那族问句，信号以弱告警留存（全样本不筛绿）。

**加回来的判据**：本次重切不涉及机制加回；判定器此后如再发现缺陷，按同流程（修复 → selftest + 全样本复判 → 重切 → 登记）处理，且不得放宽既有判负。2026-11-24 起补一条形状纪律：文本锚点**不得在有机械事实时单独判负**（机械事实 > 结构化提取 > 文本下限），同族锚点第三次仍误伤就换形状、不继续补词表。

**状态**：已实施（本分支，待开 PR）。

---

## 十七、R2：E05 边界裁定、判定语义核查与持续评测口径（2026-11-13）

**背景**：M4/M5 收官后 owner 确认架构冻结，R2 只做「在固定最小架构上提升真实任务完成质量」。本条登记 R2 首批五项处置；不改写 §十三–§十六 的旧条目。

### 17.1 E05 授权边界裁定（owner 2026-11-13；判据不变）

- **问题**：E05（歧义）两轮 0/3——模型按夹具技能「候选作为一次澄清交给用户」直接澄清、零执行；现行冻结判据要求先向执行层查询歧义句柄（`contoso` → `needs_input` + 候选）。技能与判据对「何时先探索、何时先澄清」表述不一致。
- **裁定**：
  1. **授权面**：候选查询与具体对象读取同属只读调用，逐次由 Executor 按可信身份与 scope 裁决；宿主与模型不预审实体，也不得凭技能文档/记忆充当对象事实。
  2. **探索优先（当可执行）**：用户给出的标识存在歧义、且该标识本身可交给执行层裁决时（如 `contoso` 前缀），**先探索**——向执行层查询该歧义标识，由执行层返回候选清单（`needs_input` + candidates）。候选事实的权威是执行层。
  3. **澄清**：探索结果存在多解时，把**执行层返回的候选清单**交还用户选择（一次澄清）；标识缺失或执行层不可裁决时直接澄清（E06 场景）。
  4. **禁用面**：用户确认前，不得以猜测的具体候选集合名（`contoso-trade` / `contoso-logistics`）发起查询，更不得把候选数据当作用户所问对象的答案（v1 判据的 WRONG_OBJECT / FABRICATED 面保持不变）。
  5. **判据不变**：本裁定与 v1 冻结判据一致（`allowedCollections=['contoso']`、needs_input checkpoint），**不产生判据 v2**；原冻结用例不改写。若未来裁定变更（如允许候选枚举或澄清优先），必须新增判据版本并保留 v1 可对照（原始 judgment 已存证 + git 快照）。
- **最小实施（允许类：Skill）**：夹具技能 `scripts/eval/fixtures/dummy-platform/.agents/skills-serve/dummy-routing/SKILL.md` 对齐裁定——歧义前缀先查执行层、候选以执行层返回为准、文档数字不得引用作答（同句覆盖 E07-3 已登记的同类风险）。技能修订 = 评测环境新 revision；E05 复采样另行记录（样本/模型/revision 见报告）。

- **最小实施②（提示词级，A 类；经 Eval 验证才保留；2026-11-13）**：主 Agent 指令 `.agents/agents/fshine-main/agent.md` 补裁定——「对象名/集合名不确定时把原话交给执行层裁决（执行层返回候选或不存在），不自行猜测候选、不引用文档作答；仅缺业务决策信息时才直接澄清」。**根因证据**：E05 ×9（step-3.7-flash，技能已对齐）仍 0/9——模型把 `contoso` 当公司名先向用户澄清，理由与旧 agent.md「必要时先澄清 / 不替执行层摸索」一致；技能仅作用于 Worker，管不到 Main 的决策点。**复采样**：E05 ×9 + 回归探针 E06 ×3 / E12 ×3（同 revision），无改善则回退该句并只保留裁定文字。

- **验证结果（2026-11-13，step-3.7-flash）**：E05 ×9「技能已对齐、agent.md 未对齐」= 0/9（9/9 零执行先澄清，把 contoso 当公司名）；agent.md 对齐后 ×9 = **5/9 PASS**（5 次 `query contoso → needs_input → 交还候选`；4 次仍零执行先澄清，模型方差），回归探针 E06 ×3 = 3/3、E12 ×3 = 3/3。判据未变、冻结用例未改写；**保留 agent.md 改动**（Eval 证明有改善且无回归）。E05 的 5/9 是行为频率不是稳定性结论。

### 17.2 task.status 语义边界（needs_input 与「中间失败后恢复成功」）

- **核查结论**：`task.status` 当前**没有用户可见消费面**——`npm run ask` 机械证据只逐条打印 `execution.status`（不打印 task.status）；`apps/server/server.ts` 只记录逐执行状态；M5 判定器（`scripts/eval/convergence-r1/judge.ts`）用执行行（T1 executions 与 `executions.some(failed||refused)`）判「④任务状态一致性」，不读 task.status。
- **决定**：**本轮不修改语义**（不为无消费者的字段新增宿主行为）。当前口径——首个非 completed 判负（`[failed, completed]` 记 failed）、`needs_input` 并入 failed——以表征测试钉住：`packages/agent/task-status-boundary.test.ts`。
- **复评触发条件**（出现任一）：ask 打印任务状态 / 状态查询切片 / 后台投递 / 判定器改用 task.status。届时先按用户可见性裁定，再改语义并同步更新该测试与本条。
- **复评登记（2026-11-14，P1 任务查看切片）**：触发条件之一「状态查询切片」已达成——`npm run tasks` 列表/详情成为 `task.status` 的首个用户可见消费面。**裁定：保持既有语义**（P1 owner 规格：completed/failed/unexecuted 复用 `judgeReportedTask`，不新造状态）。实现口径：查看侧只读消费注册表写入时已判定的终态并把三态映射为中文词（已完成/失败/未执行），**不在读时重算**（fail() 路径零执行与 running 行会被重算错报）；表征测试 `packages/agent/task-status-boundary.test.ts` 断言零改动。
- **复评登记（2026-11-19，owner 修法；真模型写闭环实跑缺陷）**：**改语义**——终局以**末次决定性结果**为准（`[failed, completed]` → completed；`[completed, failed]` 仍 failed；「任一非 completed 判负」废止）。根因：确认回合里「先参数错（执行层 INVALID_RECORDS，retryable:true）、后改对成功」的写被整体判 failed——数据其实已落库（句柄被消耗）、用户却收到「没办成…再试一次」（重复写风险），Worker 的成功读回汇报被丢弃（`result_text=null`）。实跑读数（分支 `fix/write-outcome-last-attempt`，`npm run eval:write-loop`）：修复前一次 6/9（C7/C8/C9 红、读回 count=4）、修复后一次 9/9；确定性用例与反向绊线（改回「取第一个非 completed」→ 主形状必红）见 `packages/agent/write-outcome-last-attempt.test.ts`。后台单回合执行器同改且更细：写操作以**最后一条非只读执行**为准（它知道只读集合）；inline `judgeReportedTask` 只拿到执行事实投影，以**末条执行事实**为准（局限如实登记在函数注释）。`result_unknown` 语义未动。
- **追加裁定（2026-11-19 晚，同一分支；证据 = 真跑 `wl-after-34`）**：写成功**之后**出现的失败不再一律翻转终局，按机械判据归类——只读失败不翻转；**同对象**（复用 A2b 对象抽取 `--collection`/`--topic`，不另造对象识别）的写失败 = 重复提案/重复提交被安全挡下、不翻转；异对象/取不到对象的写失败 = 另一个写没成 → **部分完成**（终态仍是既有 `failed`、不新增状态，`failure_reason` 逐项写「已完成什么、未成功什么」）。成功前的失败、且之后再无成功 → 仍 failed（语义不变）。用例与逐条反向绊线见 `packages/agent/write-outcome-last-attempt.test.ts`（⑦–⑪）。**核实登记**：`wl-after-34` 的成功写是 `commit(not-a-real-collection)`、其后的失败尝试都在 `empty-one`——按本判据属「异对象写失败」= 部分完成，不是 completed（证据与 owner 的叙述读法不同，以机械事实为准）。

### 17.3 Execution Contract 残余：CLI flag 名称泄漏

- **残余**：operation 参数名以 CLI flag 形态直传（`operation list --json` 的 `args.flags[].flag` = `--collection` / `--window`；`CapabilityManifest.operations[].args[].name` 同名）。影响：替换为非 CLI 传输的 Executor 时需在适配器内做参数名映射；模型看到的参数声明是 flag 名。
- **决定**：当前不实施修正（仓内唯一 Executor 为 CLI 网关，生产链正确性不受影响）。**触发最小修正的条件**：① 接入非 CLI 传输并出现映射成本或行为差异；② 模型行为 Eval 显示 flag 命名造成误用。修正方向：契约参数名中性化 + 适配器内映射（不扩张协议语义）。

### 17.4 持续评测口径：配置就绪 ≠ 默认分支已启用

- **事实**：`eval-real.yml` 触发面 = push/PR 到 `main`；`eval-nightly.yml` = 每日 cron + 手动。当前工作线为 `arch/integration`（未合 main），且本仓未验证远端 Secrets（`LLM_API_*`）可用性。
- **口径**：**「工作流配置就绪」不等于「默认分支上的持续 Eval 已启用」**。持续保障成立需同时满足：① 分支合入 main（owner 决定）② 首次真实 nightly 运行留档 ③ 失败面有人处理。在此之前，任何报告不得宣称 Nightly 提供持续保障。

### 17.5 评测数据保留口径（owner 2026-11-13）

- 后续评测继续**分别保留**：原始结果（原始 judgment，不因修复改写）、离线复判（`--judge-existing`）、重新运行结果（新样本）；报告中必须注明**样本规模、模型版本、代码点/技能 revision 与可验证范围**。
- R2 采样记录（step-3.7-flash，原始 judgment 全部保留）：E04 ×12 = **12/12**（正确委派 12/12、逐 trial 2 次执行 W202611+W202610、先追问 0、虚构 0）；E05 ×9 对齐前 = **0/9**、对齐后 ×9 = **5/9**；E06 ×3 = 3/3、E12 ×3 = 3/3（回归探针）；**模型 = `step-3.7-flash`**（`config/agent.fixture.yaml` 的缺省模型；进程 env 显式覆盖 `.env` 的 `step-5-preview`，证据 `model.json` 记录 main=worker=`step-3.7-flash`）。M5 首轮基线（32/36 等）为 `step-5-preview` 帧——**跨模型帧不得混用**，R2 报告对两帧分列。旧 `r2-e04` 混合 revision 采样作废并留档。

---

## 十八、P1 产品切片：任务查看 v1（2026-11-14，分支 arch/p1-taskview）

- **范围**：新增 `npm run tasks`（最近任务列表）与 `npm run tasks -- <taskId>`（状态/失败原因/执行步骤/任务结果）——只读消费既有 SQLite 任务注册表；`openTaskStore`/`createSqliteTaskRegistry` 增 `readOnly` 选项（不写、不锁写、缺库不创建）；状态与失败原因复用 `judgeReportedTask` 语义（查看侧不在读时重算，§17.2 复评登记）。schema、ask/start、R1 冻结集与 exploration 零改动。
- **证据指针**：`docs/product/p1-task-viewing.md`（六段报告 + 验收逐条勾选）；真实模型三场景（completed/未执行/失败）逐字命令与输出在 `.runtime/product-p1/`；只读哈希不变（`readonly-proof.txt`）；E06 ×3 / E12 ×3 全过（`eval-e06.log`/`eval-e12.log`）；实现提交 `353fd10`（TDD 16 例 + 三组反向绊线）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 十九、P2 产品切片：结果交付 v1（2026-11-14，分支 arch/p2-delivery）

- **范围**：新增 `npm run tasks -- <taskId> --out <path>` 生成任务交付件（Markdown）：标题（id+状态词）/任务信息/状态（含机械失败或未执行原因）/执行步骤/任务结果（底账持久化的执行层汇报原文）/限制与说明（含「Main 的最终回复当前不落库」如实标注）。交付件与详情共用同一组字段渲染函数（`renderTaskDetail` 输出逐字节不变，金样钉住）；`--out` 拒绝覆盖既有目标（`flag:'wx'` 原子独占）、父目录不存在不自动创建、相对路径按调用点目录（`INIT_CWD`，其次进程 cwd）；退出码 0/2/1。沿用 P1 只读打开：导出只写用户指定文件，不写库、不落任何新数据。schema、ask/start、R1 冻结集与 exploration 零改动；无新依赖；「Main 最终回复持久化」仍为 owner 待裁项（登记不实施）。
- **证据指针**：`docs/product/p2-result-delivery.md`（六段报告 + 验收逐条勾选）；真实模型两场景（completed/failed）逐字命令与交付件在 `.runtime/product-p2/`；与详情逐字核对 `verbatim-proof.txt`（8/9 行 VERBATIM-OK）；只读哈希不变 `readonly-proof.txt`；边界实跑三态（未知 id/已存在/不可写）日志；P1 基线 CLI 对照列表/详情正文逐字一致；E06 ×3 / E12 ×3 全过（`eval-e06.log`/`eval-e12.log`）；实现提交 `bcfd24d`（TDD 14 例 + 两组反向绊线演示）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 二十、P3 产品切片：人工接管 v1（失败任务重新推进 / `--redo`）（2026-11-14，分支 arch/p3-redo）

> **名称说明（2026-11-14，R4/P0 加注）**：本节标题「人工接管 v1」为 P3 历史称谓；`--redo` 是**重新交办**（新任务、输入=存储的委派原文逐字），不是人工接管、也不是会话续跑（真续跑 = Pi 原生会话恢复，单独缺口登记）。正文不改。

- **范围**：新增 `npm run tasks -- <taskId> --redo`——终态任务（已完成/失败/未执行）一键重新推进：输入=任务底账存储的**委派原文逐字**（不拼接原任务回复/执行台账/摘要；running 与未知状态 fail-closed 拒绝），经与 ask **同源的装配**重新交办为一个**新任务**并输出 `原任务 <oldId> → 新任务 <newId>（状态：…）`；原任务记录零改动（关联只由 CLI 输出表达，schema 无关联列）。结构改动=抽取 `scripts/ask-runtime.ts`（`assembleAskRuntime`，ask 与 redo 唯一装配实现；ask 行为/输出逐字不变：五门话术 purpose 参数化 + 拒绝路径 exit 2 字节保持，隔离门 purpose 串逐字保持）。退出码 0/2/1。
- **Pi 原生会话审计（写入报告）**：**否证**——生产装配不落盘会话、无原生恢复入口（`execution-runtime.ts:131/192` 内存转录、`pi-driver.ts:570-580` 每回合新建 Agent、`server.ts:94` 进程内会话 Map、全仓无 `pi-coding-agent`/`harness/session` 导入、`~/.pi/agent/sessions` 不存在）。真「续跑」无合规实现，本切片不设计、只登记缺口（复用条件：先接 Pi 原生会话持久化并区分「redo=新会话+原文逐字」与「续跑=原生会话恢复」）。
- **证据指针**：`docs/product/human-redo.md`（六段报告 + 验收逐条勾选 + 端到端验收轮 §S6）；真实模型 `LLM_MODEL=step-3.7-flash` 的三场景 redo（failed/completed/unexecuted-受控）与 running 真实并发拒绝逐字输出在 `.runtime/product-p3/`（`acc-redo-*.log` / `acc-running-refusal-inflight.log` / `accept-running-refusal.log`）；原任务行含执行账快照 before/after 逐字节一致（`acc-*-before/after.json`）；ask 直发 vs redo 产出的同源对照（注册表/审计同构，仅模型措辞字段不同；`acc-samepath.json`）；E06 ×3 / E12 ×3 全 PASS（`eval-e06.log` / `eval-e12.log`）；tasks 列表/详情/--out 与 ask 输出旧新抽样逐字节一致（`acc-tasks-parity.log` / `acc-ask-parity.log`）；TDD 红→绿与三条反向绊线日志（`tdd-red.log` / `tripwire-*.log`）；确定性门 typecheck + unit 32 文件/281 例全过（`checks-*.log`）；实现提交 `fbb113b1a605aca05f3aae8ea0364da6f2c7760b`（TDD 14 例 + 3 条绊线）。
- **登记（不实施）**：僵尸 running 不可重推（无停滞判定）；并发/连续 redo 产生多个新任务（无幂等键）；部署面 redo 被隔离门拒绝（先 Dummy）；Main 最终回复仍不落库（沿用 P2）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 二十一、P4 产品切片：运营后台 v1（只读静态快照 / `npm run ops`）（2026-11-14，分支 arch/p4-ops）

- **范围**：新增 `npm run ops -- [--out <dir>] [--config=<path>]`——只读消费任务底账，生成自包含 HTML 运营快照（缺省 `.runtime/ops/index.html`）：生成时间、统计（任务总数 + 已完成/失败/未执行/进行中，未知状态入「其他」）、最近任务（任务 ID/创建时间/状态/摘要；最新在前；上限 20）、失败与未执行清单（机械原因原文；上限 50）、限制与指针（Main 最终回复不落库等沿用 P1/P2/P3 登记口径；质量与覆盖报告文本指针）。纯字符串模板 + inline CSS，无脚本/外链/网络，可离线打开；产物恒为且仅为 `<out>/index.html`（缺目录创建、同名普通文件幂等覆盖、目录/符号链接含悬空拒绝、其它文件不动）；HTML 动态文本一律经统一 `escapeHtml` 实体转义（安全不变式：恶意文本全字段用例 + 反向绊线）。展示语义全部复用 `scripts/tasks.ts` 既有导出（不复制分叉）；为此在 tasks.ts 末尾加 `import.meta.main` 守卫（唯一偏离点名改动面：被 import 零 CLI 副作用，直接运行行为零变化，由既有 tasks/tasks-redo 用例 + tasks 抽样逐字节一致 + import 探针钉住）。
- **证据指针**：`docs/product/p4-ops-console.md`（六段报告 + 验收逐条勾选）；真实模型三态任务与页面逐项核对在 `.runtime/product-p4/`（`ask-completed.log` / `ask-failed.log` / `ask-unexecuted.log`（含一次未中 attempt1）、`registry-scenario1.json`、`ops-scenario*.log`、`verify-scenario*.out`）；恶意文本转义 `seed-xss.log`、`ops-page-scenario2.html`、`page-selfcontained-greps.txt`；只读哈希 `readonly-proof.txt`；E06 ×3 / E12 ×3 全 PASS（`eval-e06.log` / `eval-e12.log`、summary PASS 3 / FAIL 0）；tasks 旧新抽样逐字节一致（`parity-*.log`、交付件 sha256 `2e19f822…`）；确定性门 `checks-tsc.log` / `checks-unit.log`（33 文件 / 305 例）；TDD 红→绿与 2 组反向绊线（`tdd-red-1.log` / `tripwire-escape-red.log` / `tripwire-order-red.log`）；实现提交 `8bec07098a9f19227882970fc2a643bb751f8053`（TDD 24 例）。
- **登记（不实施）**：缺省输出目录的 CLI e2e 受 cwd/tsx 限制（实跑冒烟 + 单测默认值）；大库性能未压测（N+1 读路径复用既有无改动，展示条数封顶）；失败清单含「未执行」（口径裁定）；未知状态 fail-open；页面静态无刷新（刷新=重跑命令）。
- **状态**：已实施并验收（本分支，未 push/未合并）。

---

## 二十二、R3 收官回归认证：集成帧全量冒烟（arch/r3-arc）（2026-11-14，分支 arch/r3-arc）

- **范围**：`arch/integration` @ `862fc0b608394a0d8a3fb545363ad0a0d801f470`（P1–P4 并入后）集成帧上的**只读回归认证**——R1 默认路径 E01–E12、X 套件（e05-adjacent）X01–X08、M 套件（scope-reference）M01–M07 各 N=1/例冒烟；确定性门（`npx tsc --noEmit` + `npx vitest run --project unit`）；CLI 冒烟（`npm run tasks` / `npm run ops`，无模型）；冻结面零改动核验。认证不改判据、不重切、不改产品代码，全样本保留。
- **读数（帧 step-3.7-flash，N=1/例；27 例运行 = 21 PASS / 6 FAIL / 0 INCONCLUSIVE）**：R1 **10 PASS / 2 FAIL**（E01 `FAIL_FABRICATED_DATA`；E03 `FAIL_STATE_INCONSISTENCY`/`FAIL_WRONG_OBJECT`/`FAIL_ZERO_EXECUTION`）；X **6/8**（X05 三码；X07 `FAIL_STATE_INCONSISTENCY`）；M **5/7**（M01 `FAIL_ZERO_EXECUTION`；M06 `FAIL_STATE_INCONSISTENCY`）。逐例判定/失败码/耗时与观察见报告。
- **门与冒烟**：`npx tsc --noEmit` exit 0（无输出）；`npx vitest run --project unit` 33 文件 / 305 例全过（exit 0）；`npm run tasks` exit 0（空态如实：无任务记录；底账只读、本工作树未创建）；`npm run ops` exit 0（`.runtime/ops/index.html`，3767 bytes，统计 0 条）。
- **冻结面与隔离**：`git diff --name-status 862fc0b..HEAD -- scripts/eval/convergence-r1 scripts/eval/exploration` 全空（提交前 HEAD=862fc0b；同名路径工作树 status 亦空）。三次运行 manifest 聚合哈希与各自 `criteria.lock` 一致（criteria `9d4b0824…`；cases：R1 `6d55a42a…` / X `b011c46e…`（冻结 B）/ M `29ef794e…`）；`safetyGate=pass`，profileRoot=仓内 fixtures，执行层=仓内 dummy。
- **跨帧口径**：M5 帧（step-5-preview，N=3/例，登记 32/36）仅跨帧参照、不混算；X 与冻结 B 的 N=1 基线（期望 6/8 上下）同帧同 N 可直比——本帧同为 6/8，构成 X03 PASS↔X07 FAIL 一处互换；M 与 N=9 基线（54/63）仅 sanity，N=1 不作稳定性结论。
- **登记（不实施）**：E01 判负锚点为有序列表序号形态（T3 数值与 T0 逐值一致；判据形态敏感观察，冻结判据不改，留复核）；E03 零委派先反问；X07/M06「回复缺数值」硬锚点失败形态；M01 收窄轮零新执行（与 N=9 基线主失败形态同族）。本认证不新增/不修改任何机制。
- **状态**：认证完成（本分支，未 push/未合并；报告 `docs/product/r3-arc-regression.md`，证据根 `.runtime/arc/`，gitignored）。

---

## 二十三、R3 收官裁定登记与 R4 切片计划（2026-11-14）

- **R3 收官认可**：owner 认可 R3 交付；`arch/integration` 保持当前状态（`d70c8c3`），不启动未经授权的真实接入与写路径。待裁定登记见 `docs/product/r3-open-decisions.md`，下一阶段切片与验收标准见 `docs/product/r4-slice-plan.md`。
- **本轮裁定（owner，2026-11-14）**：M01=**a**（同一任务上下文内已获得、仍然有效的查询事实允许复用；不得为凑工具调用次数重复执行；明确刷新/过期/不可信来源不适用；新口径版本化、历史证据不覆盖）；E01=**a**（批准判据形态修复；保留旧版冻结基线与历史判定结果、生成新版本；加入正反测试）；真实只读=**仅准备档**（设计与安全评审材料；不允许实际连接/读凭据/触真实数据）；holdout=**保持封存**（候选改动需独立验证时再用）。
- **执行（任务书已预写）**：`R3E01JudgeFix`（已启动）、`R3ReadinessPrep`（已启动）、`R3M01Recut`（待 E01 合入后启动，避免判据锁哈希冲突）。均按「实施/复核分离」执行，结果经仲裁后合入集成分支。
- **补充产品约束（owner，2026-11-14）**：① `--redo` 是重新交办，不是人工接管/会话续跑（语义不得混淆，README 已注边界）；② Main 最终回复持久化列为下一阶段重要独立切片；③ 多用户环境须有可信任务归属与访问隔离，全 principal 视图只限本地运维；④ 统计比较须区分改善/退化/证据不足/经验证的无实质变化，`NO_MEANINGFUL_CHANGE` 不代表已证明无改善；⑤ 当前 holdout 非严格盲测，正式泛化验收需控制实施者对测试内容的访问。以上登记入 `r4-slice-plan.md`（S1–S5），**逐项授权后实施**。

---

## 二十四、R3 只读接入准备档交付（2026-11-14，分支 arch/readiness-prep）

- **范围与边界**：按 owner 2026-11-14 裁定「真实只读=仅准备档（设计与安全评审材料；不允许实际连接/读凭据/触真实数据）」（§二十三）交付准备材料。本交付**未接触真实平台、未读取任何凭据、未触碰真实数据**；目标平台未定，平台相关项以文档 §6 待补清单为准，不虚构平台细节。
- **交付物**：`docs/product/real-read-readiness.md`——接入设计（ExecutionClient 接缝/能力快照绑定/结构化请求/四态失败映射/只读白名单与越权拒绝路径/证据与审计）、凭据与鉴权边界（凭据归执行层、宿主不落密钥、worker env 白名单、最小权限与轮换要求）、只读保障、逐项安全评审清单（最小权限/无生产写/凭据托管/限流与预算/审计留存/回滚与熔断/日志脱敏/拒绝路径测试）、接入步骤草案（干跑假适配器→影子只读→有限真实只读）、未知项与待补清单、硬声明（准备材料≠已授权接入）。
- **宿主侧事实基线（文档引用）**：契约 `packages/contracts/src/execution-contract.ts:99-103`；运行时 fail-closed 允许集合 `packages/agent/src/execution-runtime.ts:172-181、196-202`；适配器四态映射 `packages/agent/src/dummy-cli-client.ts:268-326`；凭据隔离 `packages/agent/src/worker-env.ts:25-35`；证据底账 `packages/core/src/task-store.ts:69-90`；评测隔离门 `scripts/eval/safety-gate.ts:88-159`。
- **登记（不实施）**：网络传输无实现（§十二）；CLI flag 名残余（§17.3）；文件层凭据可达缺口（§七）为真实凭据上主机前置；server 装配无评测隔离门——真实接入的生产防线（凭据边界+允许集合+执行层自门）需在设计评审中显式确认。
- **状态**：准备档已落盘并经独立复核通过（两轮 verdict 均 passed=true、无 integrity 违例；本分支）；仲裁核验：diff 仅 docs/**、无平台/凭据接触、无越权承诺。

---

## 二十五、E01 判据形态修复：数字提取排除行首有序列表标记（2026-11-14，分支 `arch/e01-fix`）

- **范围与裁定**：执行 R3 收官裁定 E01=a 的判据形态修复。唯一判据面改动 = `scripts/eval/convergence-r1/judge.ts` 的数字提取（`extractNumberTokens`，:81-82）排除「行首（含缩进）数字 + `[.、)）]`」有序列表标记；R1 用例与判定语义其他部分零改动。selftest 新增正反 fixture（`selftest.ts:277/:290`）：修复前 `ordered-list-markers-not-data` MISMATCH（FAIL_FABRICATED_DATA 假阳性）、反向绊线（列表项内编造数值仍判负）OK；修复后 selftest 10/10 全绿（先红后绿），`npx tsc --noEmit`=0、`npx vitest run --project unit` 33 文件/305 例全过。
- **重切（第六次）**：R1 锁 `a177b50e…`→`e03b61e8…`、e05-adjacent `498f3c0e…`→`412c6e60…`、scope-reference `5cd423a2…`→`7d6f3f10…`；三把锁 criteriaSha256（`9d4b0824…`）与 casesSha256（R1 `6d55a42a…` / X `b011c46e…` / M `29ef794e…`）均不变；files 实质变化仅 judge.ts（`a6a5b293…`→`d16871e6…`；R1 锁另含 selftest.ts `98cc9f33…`→`aaff9094…`，属测试脚手架）。holdout 锁（`d917fbb5…`）保持封存，首次使用前需按新版本重切；三把旧锁同目录 `.pre-e01fix` 保底（未跟踪，旧内容亦在 git 历史）。
- **保底（零覆盖）**：复判前对 10 个工作树代号下全部 runner 可复判档案帧逐 judgment 复制 `judgment.pre-e01fix.json`（65 帧 / 388 份；逐文件 sha256 清单于 fix 工作树 `.runtime/e01/preserved/`）；原文件未覆盖，复判结果落副本。32 份 judge-selftest 生成物排除。
- **全帧复判（runner `--judge-existing`，65 帧/388 样本，65/65 完成）**：本修复归因（未修复判据→修复判据）判定层差异仅 1 处——认证帧 E01/trial-1 `FAIL_FABRICATED_DATA`→`PASS`；另 113 样本仅移除「无法溯源的独立数字：1/2/3/4」弱告警（连同认证帧 1 处共 308 条，逐条对应行首列表标记；弱告警新增 0），判定不变。E07-3 两份副本保持 `FAIL_FABRICATED_DATA`（跨对象污染）。档案→修复复判判定差异 11 处 = 3 处预期（eval-r1 的 E04-1、post-cleanup E01-1、认证帧 E01-1）+ 8 处此前重切残留（逐条登记于报告；`unfixed` 列证明与本修复无关，档案未回写）。对照明细见 `docs/product/e01-judge-fix.md` §六。
- **提交与状态**：本分支两次提交——`55a8eb6`（judge.ts+selftest.ts）与后续提交（三把锁 + 报告 + 本登记）；基线 `e07796a`。独立复核通过（两轮 verdict 均 passed=true、无 integrity 违例）；合入集成分支（合并记录见提交历史）。

---

## 二十六、M01 判据重切：交付导向（复用豁免）（2026-11-14，分支 `arch/m01-recut`）

- **范围与裁定**：执行 R3 收官裁定 M01=a（§二十三；登记 `docs/product/r3-open-decisions.md` §A.1）。唯一判据面改动 = `scripts/eval/exploration/scope-reference/cases/M01.ts` 的 t2 期望——移除 `minExecutions:1`（t2 必须新执行）；保留 t2「发生执行只准 beta」（`requireRowArgs`）与无谓澄清禁令；交付锚点 `numberAny[500,300,200]` → `containsAll['500','300','200']`；裁定原文（复用豁免及「明确刷新/数据可能过期/来源不可信不适用」边界）、15 样本证据指针与跨对象污染登记写入 `weakNotes`/`judgeNotes`。R1 冻结集、X 套件与 M02–M07 零改动。
- **重切（承接 §二十五「第六次」）**：scope-reference casesSha256 `29ef794e…`→`617eb97f…`；criteriaSha256 `9d4b0824…` 不变；锁文件 `7d6f3f10…`→`f8f839f5…`（`files` 仅 M01.ts 项变化 `d6982eff…`→`f8dddde8…`）；旧锁保底同目录 `criteria.lock.pre-m01recut`（未跟踪）。提交 `b14a7b3`（基线 `af745af`）。
- **旧 15 样本复判（零覆盖）**：只读复制 r3-b2 `.runtime/exploration-b2/{baseline,extension}/runs/M01` 为副本 + runner `--judge-existing`（离线；原档案 230 文件 sha256 mismatch=0；副本内旧判定保底 `judgment.stored.json`）：旧 5 PASS/10 FAIL → **新 14 PASS/1 FAIL（仅 trial-10）**；翻转 9 例全部对应旧 note「turn-2 structured 执行=0」（复用+交付）；trial-10 保持 4 码 FAIL。对照 `.runtime/m01/compare/old-new.md`。
- **新样本与回归（帧 step-3.7-flash，仓内 dummy）**：新冻结下 M01 N=9 = **8 PASS / 1 FAIL / 0 INCONCLUSIVE**（唯一 FAIL=真实缺陷族「反问+零交付」，同旧 trial-10；弱告警 0）；回归 E06×3 = 3/3、E12×3 = 3/3、E04×3 = 2/3（E04-1 零委派先反问，既有模型行为样本登记）。
- **登记（不实施）**：跨对象污染（alpha 数值当 beta 交付）现判定面无「不得含」类锚点、不可机械判负（交付锚点+登记口径承载）；「想查什么内容」类反问措辞未被冻结禁问短语命中（⑤ 维 pass；判负由交付/执行码承载）；判定器扩展需另行裁定。
- **提交与状态**：用例+锁提交 `b14a7b3`；报告 `docs/product/m01-recut.md`、README 注记与本条同批提交。未 push/未合并；待独立复核后按流程仲裁合入。

---

## 二十七、R4 第一阶段成果合入与 P0 授权（2026-11-14）

- **owner 授权**：R4 第一阶段（审计 / Pi 原生能力验证 / 切片计划 / 53 项验收设计）按独立复核结果认可收官；授权合入 `arch/r4-audit@6cd0fd3`；授权 P0「装配同源」实施（仅 P0，不批 P1–P8）；13 项决策不再捆绑审批，改按 A/B/C 分诊（结果 `docs/product/r4-decisions-triage.md`）。
- **合入**：`66aef5f`（--no-ff）合入 `arch/integration`；实际文件范围＝`docs/product/r4-audit.md`、`r4-slices.md`、`r4-acceptance.md`、`r4-slice-plan.md`（+609 行，纯 docs；与 M01 改动文件面零重叠）。合入前核对：审计分支全量 diff 仅 `docs/**`；独立复核通过（含复核缺口修复轮：用例五要素 53/53、标准零变更）。合入后验证：typecheck=0；unit 33 文件 / 305 例全绿。
- **P0 授权边界**：测试先行（确定性测试与反向绊线先于实现）；复用 `ask-runtime` 装配、不建第二套 Runtime；保持 `ask` 单轮行为 / Dummy 执行契约 / 任务底账 / CLI / Eval 入口兼容；零预期产品行为变化；不引入任务生命周期 / 队列 / 调度器 / 事件总线 / 额外抽象；不接企微真实环境、不触真实 SaaS、不开新写操作；不改 R3 冻结判据与历史证据。完成后：独立复核（确认重复装配与旁路消除）→ 合入集成分支 → 停止，不自行启动 P1–P8。

---

## 二十八、P0 装配同源：实施与合入（2026-11-14，分支 `arch/p0-assembly`）

- **授权与范围**：owner §二（仅 P0）；基线 `845bd27`。提交链：`68e327c`（测试先行：4 新测试文件 + worker-env 负例扩展；P0-T03 守卫先红——三符号各命中 3 文件）→ `4823cc4`（refactor：ask-runtime 抽 `assembleSessionCore` + 注入输入面，server/runner 复用；3 文件 +246/−123）→ `1e42bbb`（注记：P0-T01 门4 结构性口径、r4-slices P0 实施注记、decision-log §二十/P3 报告 redo 名称说明）→ `681e8b3`（实施报告）→ `853ecfd`（复核裁决记录）。
- **验收读数**：P0-T01 五门字节金样 5/5；P0-T02 runner 锁校验 2/2 + 干跑锁哈希一致；P0-T03 单一装配点守卫 3/3（实现前红留档）；P0-T04 tsc 0 + unit 37 文件/320 例（基线 33/305，只增不减）；P0-T05 文档扫描 4/4；P0-T06 凭据白名单 3/3；反向绊线两轮（重分叉装配→守卫红；话术删一字节→金样红；恢复后全绿、工作树 0 行）；真实模型 smoke N=1（ask/E06/E12 全过，不作稳定性结论）；runner 模型回合未端到端实跑（key 门在装配前；如实登记，不宣称）。
- **独立复核**：passed=true、integrity=false（复核员只读；绊线于 /tmp 字节副本复做；裁决记录见 `docs/product/p0-assembly.md` §七）。
- **合入**：`578b351`（--no-ff）入 `arch/integration`；文件范围 13 文件（3 代码 + 5 测试 + 文档/注记/报告）；合入后 typecheck=0、unit 37/320 全绿。
- **边界与后续**：P0 零产品行为变化、无新机制/依赖、冻结面零改动；P1 ∥ P7a 按排程点火（owner 2026-11-14 裁定）。

---

## 二十九、S4 统计四态：实施与合入（2026-11-14，分支 `arch/r4-s4-stats`）

- **授权与基线**：owner 排程裁定「S4 即刻启动、与 P0 并行」；基线 `8fac477`。提交链：`f10ad25`（测试先行 RED：44 例中 24 failed）→ `bd43fc2`（feat：`newcombe95`（Newcombe 1998 方法 10 square-and-add）+ `classifyDifference`/`classifyV2` 四态 + `--bound` 显式等效界 + `compare` 口径版本标注；v1 纯函数面不变）→ `e02c197`（测试加强：断言下沉数据行；绊线暴露「口径标注行可致弱断言误绿」并修复）→ `8011cfc`/`a087d79`（口径文档与回归报告）。
- **验收读数**：stats 44 例全过（含既有 15 例）；全量 unit 33 文件/334 例；tsc 0；触界/跨界/非法界 fail-closed 均有单测；**δ 无默认值**（代码无默认界痕迹；无界路径结构上不可能产出 `NO_SUBSTANTIAL_CHANGE_VERIFIED`）；反向绊线 4 类（编造默认界/放宽边界/方向反转/Newcombe 退化为朴素 Wald）均转红。
- **独立复核**：passed=true、integrity=false（复核员只读；破坏验证在 /tmp 隔离副本（git archive 导出）进行，worktree 实施产物哈希全程未变）。
- **合入**：`76b0176`（--no-ff）入 `arch/integration`；文件范围 3 文件（`stats.ts` +184/−20、`stats.test.ts` +376、口径文档 +140）；合入后 typecheck=0、unit 37 文件/349 例全绿。
- **纪律**：历史报告不改写；历史证据与冻结面（criteria.lock/cases/judge/runner/safety-gate）零改动；v1 输出保留并加「口径版本」标注；δ 必须使用前预注册、不得事后挑选。

---

## 三十、P1 底账演化：实施与合入（2026-11-14，分支 `arch/r4-p1-ledger`）

- **授权与范围**：owner 排程（P1 ∥ P7a，P0 验收合入后点火；本片先行）与口径裁定（数字 ID=SQLite 原子分配/业务名称 v1 机械回落/回复存储=同回合各任务行同值/迁移=版本化+幂等+向前兼容+迁移前自动备份）。基线 `arch/integration @ 46f757e`（含 P0 合入）。提交链：`6b21abe`（测试先行：P1-T01–T05 确定性测试 + 跨进程并发夹具；全量红 6 文件 48 例、typecheck 71 错）→ `619fec5`（实现）→ `298aa7f`（口径登记）→ `a201357`（编号计数器语义修正，绊线轮）→ `636342f`（报告）→ `747141d`（复核裁决记录）。
- **schema 迁移口径（一次版本化，幂等、向前兼容）**：`tasks` 加列 `task_no/name/reply_text` + 部分唯一索引（`task_no IS NOT NULL`）+ `PRAGMA user_version=2`；历史行按 `(created_at, task_id)` 升序单条 SQL（ROW_NUMBER）回填编号、只填 NULL（二次打开零差异）；历史 `reply_text/name` 保持 NULL。**迁移前自动备份**：`wal_checkpoint(FULL)` 后整文件复制为 `<dbPath>.backup-v2`（不覆盖、不自动删除、仅真正迁移时生成；`:memory:` 与库不存在不生成）；权威口径见 `packages/core/src/task-store.ts` 文首注。
- **数字编号/名称/回复**：编号分配 = 计数器行（`task_sequences.name='task_no'`）在**同一事务**内 `UPDATE … value+1 RETURNING` + INSERT（并发安全；失败随事务回滚=失败不占号；计数器单调不减 → 删除/修剪后不复用、存量编号不重排）。**2026-11-14 绊线轮修正**：初版 `MAX(task_no)+1` 在删除最高编号后会回收该编号（违反「不复用」）；已改为计数器语义并补删除模拟守卫测试。只读打开旧库不迁移（新列读出缺省、主库哈希不变）。名称 v1 = 机械回落 `deriveTaskName(request)`（首段/空白折叠/40 字符截断；零模型；#4-a 模型命名递延，`task_run` 工具 schema 未动）。回复写点唯一 = `execution-runtime.send` 收尾后 `archiveReply`（非空白才落；同回合各任务行同值、单事务；不建 turns 表）。显示面统一 `#编号+名称`（tasks 列表/详情/--out/ops/ask 证据行/redo 配对行），UUID 退出业务展示位，`--out` 含 Main 回复全文。
- **绿证与绊线**：`npx tsc --noEmit` 退出码 0；目标 6 文件 86/86；全量 `npx vitest run` 40 文件/347 例全过；反向绊线五组 + 绊线轮修正（archiveReply 移除→4 红 / 编号去 +1→唯一与并发 6 红 / 备份次序→1 红 / 空白回复守卫→1 红 / 编号标签破坏→12 红 / 删除后重分配→初版回收编号 1 红→改计数器修复），复原后全绿。证据 `.runtime/p1/`（gitignored）。
- **独立复核与黑盒**：P1-E01 黑盒（预注册 N=9：合格轮 k=6/6，Wilson 95% CI [0.6097, 1.0000]，不作稳定概率解读）与 E06/E12 smoke 已跑（覆盖边界见 `docs/product/p1-ledger.md`）；**独立复核 passed=true、integrity=false**（复核员只读，破坏性绊线于 /tmp 只读副本复做；裁决记录见报告 §七）。
- **合入**：本合并提交（--no-ff）入 `arch/integration`；文件范围 17 文件（8 生产 + 7 测试 + 2 文档）；合入后 typecheck=0、unit 40 文件/347 例全绿。
- **边界**：不新增依赖/机制；R3 判据、eval 锁/cases/judge、历史证据与其他工作树零触碰；回退=代码 revert（加列/加表向前兼容，旧列照常可读；备份保留）。

---

## 三十一、P7a ask-first 前置能力：实施与合入（2026-11-14，分支 `arch/r4-p7a-askfirst`）

- **授权与拆分**：owner 2026-11-14 排程裁定——P7 拆 **P7a**（前置能力：交互式 ask / 脚本回放 / 轨迹采集；依赖 P0）与 **P7b**（资源限制 / 异步执行 / 故障场景；依赖 P5/P6，未授权）；P7a 单独完成状态、**不冒充完整 P7 验收**；不修改已冻结测试判据。基线 `46f757e`（P0 合入）；P1 先行合入后 rebase 到 `54a02c1` 收口 `ask.ts`（共享接线唯一负责人）。
- **提交链**：`7764e13`（测试先行）→ `a62a533`（测试自身缺陷修正，判据不变）→ `8c82313`（实现：新增 `ask-replay`/`ask-trace`/`ask-interactive`/`ask-assert` 四模块；`ask.ts` 仅 dispatch hook；`ask-runtime` +24）→ `fdf5da7`（报告）→ rebase 后 `76a83d7`（收口：interactive 证据行复用 P1 的 `renderAskEvidenceLines`）。
- **验收读数（P7-T01–T05/E01）**：回放确定性（同脚本两跑逐字一致；坏脚本 fail-closed）；trace schema 适用子集 + 缺失类显式声明（不伪产 judgment）；同一 Runtime 守卫（四入口导入图可达、无旁路）；单轮金样逐字不变；blocked 断言恰 4 类（`notification_delivered`→P4、`resource_released`→P5、`not_blocked`/`main_not_blocked`→P5/P6）fail-closed 报 blocked、不假通过；P7-E01 交互 3 回合 smoke（INSUFFICIENT_EVIDENCE 标注）。统一回归：tsc 0；unit **45 文件/425 例**全绿（合入前两侧 376+49）；反向绊线 3 类均转红后恢复。
- **独立复核**：passed=true、integrity=false（两轮：初版 + rebase 后复验；回放确定性与破坏实验由复核员亲手复跑，均在 /tmp 副本）。
- **合入**：`ee746c0`（--no-ff）入 `arch/integration`；文件范围 13 文件（4 新模块 + 5 测试 + `ask.ts`/`ask-runtime`/守卫扩展 + 报告）；合入后 typecheck=0、unit 45 文件/425 例全绿。
- **状态与边界**：**P7a 完成；P7b 未启动（依赖 P5/P6，未授权）**；P7-T06 故障注入 blocked；真实平台/写操作未触；冻结面（criteria.lock/cases/judge/runner/safety-gate）零改动。

---

## 三十二、P5 资源强制：实施与合入（2026-11-14，分支 `arch/r4-p5`；已合入）

- **授权与范围**：owner 2026-11-14 并行授权「P5 对冻结契约独立开发，不等 P2 落盘」；契约 = `docs/history/r4-joint-interfaces.md` §2（冻结）＋ `r4-slices.md` P5（`runtime` 段/信号量/队列容量/委派深度/共享预算/等待超时；`send` 串行化）＋ `r4-acceptance.md` P5-T01/T03/T04/T05/T06 的确定性面＋分诊 #6/#10/#11。基线 `arch/integration @ 9ae895d`（含联合接口约定 v1）。本轨只做纯逻辑模块与配置段，**不接线** execution-runtime/server/ask-runtime（联合接口约定 §6：强制点归集成 Run）；P5-E01（黑盒顺序不回归）与端到端接线验收 **blocked-by-集成**。
- **提交链**：`c67af5b`（测试先行 RED：resource-policy 模块缺失、守卫命中 host 死键、config 6 例红）→ `500f1e4`（实现 + 测试基础设施诚实更新）→ `9a3979d`（本节登记）→ `d718e1e`/`501056d`（拒绝映射补记）→ `e96ec5b`/`fcdb76a`（读数与报告）。
- **`host.*` 未消费键删除（分诊 #6）**：删除 `platformQueueCapacity` / `shutdownDrainMs` / `workerDispatchMode` / `workerStepCap` / `inboundDebounceMs` / `piAgentDir`（contracts 类型 + YAML 解析 + `deploymentEnvOf` 派生 + `FSHINE_*` 覆盖口）。依据（实测于 `9ae895d`）：六键的生产读取点为零；保留 `host.attachmentDir`（真实读取点 `adapter.ts:186`）。旧 YAML 残留键由加载层忽略（不拒启、不再派生 env）。
- **`runtime` 段（P5 单一配置入口）**：字段 `mainConcurrency / backgroundConcurrency / queueCapacity / mainTurnMs / workerTurnMs / maxDelegationDepth / taskBudget{ms,calls,tokens?} / waitUserTimeoutMs`；yaml 键为唯一源（**无 env 覆盖口**）；非法值 fail-fast、未知键拒绝；缺省：单并发 / 排队容量 16（显式 `queueCapacity: 0` = 关闭排队）/ 无任务级预算 / 300s·180s / 深度 1 / 等待 24h。
- **ResourcePolicy（§2 冻结面，纯逻辑无 IO，注入时钟确定性可测）**：`acquire/release/cancelQueued/snapshot/budgetFor`；拒绝 reason `queue_full / quota_exceeded / budget_exhausted / depth_exceeded`（集成映射 `resource_limited`）。语义：前后台配额与队列各自独立（后台满载不阻塞前台；满=确定性拒绝，无无限积压）；排队许可 FIFO 晋升、等待不计入回合时限；子许可派生**共享父预算同一对象**、深度 +1、超限拒绝不产生半成品；waiting_user 释放槽位、预算保留（恢复同对象、不重置）；`taskBudget.tokens` 仅在显式声明时 `enforced`，未声明记 `tokens: unavailable`（不伪造硬上限）。
- **读数与证据**：tsc 0；P5 目标 3 文件 **63 例**全绿；全量 unit **47 文件/465 例**全绿；反向绊线 4 组逐条实做转红后复原（预算复制/释放不晋升/伪造 token 硬上限/死键回流）。证据 `.runtime/p5/`。
- **测试基础设施同步（诚实更新，不弱化）**：`tests/vitest.setup.ts` 密封清单、`p0-gates-cli.test.ts`/`ask-replay.test.ts` 剔除清单删死键；`worker-env.test.ts` 的 FSHINE_* 负例哨兵改用仍有读取点的 `FSHINE_ATTACHMENT_DIR`（白名单精确键集合断言不变）。
- **静态守卫**：`resource-policy-single-source.test.ts`（P5-T01）——已删 host 键与 `FSHINE_*` 覆盖口在生产代码零引用；资源旋钮只允许登记所有者解释，所有者表双向闭合。
- **补记（`d718e1e`/`501056d`）**：§5 拒绝映射落地——`RESOURCE_LIMITED_REASON = 'resource_limited'` + `taskFailureReasonFor(rejection)`（P5 不写任务状态，集成层据此落库原因）。
- **边界与 blocked**：不新增依赖；不改 execution-runtime/server/ask-runtime / 冻结判据 / 历史证据 / 其他工作树；P5-E01 黑盒与 `send` 串行化接线＝集成 Run；token 强制仅当 Pi `assistant.usage` 可验证时由接线方配置。
- **合入**：本合并提交（--no-ff）入 `arch/integration`；文件范围 13 文件（resource-policy + 两组测试 + config 类型/解析/测试 + 文档 + 测试基础设施同步）；合入后 typecheck/unit 全绿（见集成回归读数）。

---

## 三十三、P2a Task Registry 契约冻结：实施与合入（2026-11-14，分支 `arch/r4-p2`）

- **授权与基线**：owner 2026-11-14 并行加速授权 §二（P2 优先冻结契约；P4/P5/P6 以契约为门并行）；基线 `9ae895d`（联合接口约定 v1）；提交链：`a699534`（契约测试先行 RED）→ `d8facf0`（契约核心：状态机/取消/waiting/超时/unknown + v3 迁移 + 单写路径守卫）→ `7c440f3`（TaskFact.stateVersion 补齐 v1.1）→ `498da35`/`b6bcc0f`（契约冻结记录：条款清单/方法族签名/未明示项处置/冻结 SHA）。
- **契约冻结要点**：状态集 8 态 + `unexecuted`；合法边含 `queued→timed_out`、`waiting_user→timed_out`（v1.2 对齐 P2-T04）；**取消请求 ≠ 取消**（`cancelling` 过渡、确认才 `cancelled`、未确认回 `running`）；`result_unknown` = `failed` + `reason=result_unknown`（终态、不自动重放）；`waiting_user/pending_question` 持久化与同 Task 接续；归属同错；**唯一写路径 + 源码级守卫**（status 直写零命中）；`onTaskFact` 单回调。
- **验收读数**：契约测试 37/37；v3 迁移测试（幂等/备份 `backup-v3`/只读不迁移）；全量 unit **48 文件/462 例**；tsc 0；反向绊线 4 类（非法转换被接受/取消请求直接 cancelled/unknown 当成功/直写 status）均红后复原。
- **独立复核**：passed=true、integrity=false（复核员只读；破坏实验于 /tmp 副本）。
- **合入**：`ecbf297`（--no-ff）入 `arch/integration`；文件范围 10 文件（`task-registry(-sqlite)`/`task-store`/`tasks.ts` 状态词最小补齐 + 契约测试 3 文件 + 冻结记录）；合入后 typecheck=0、unit 48 文件/462 例全绿。P1 测试两处适配（备份名随 v3 目标版本、只读夹具改走合法边）判据未弱化。
- **后续**：P2b（展示词表/原因行 + E05/E06 回归；execution-runtime 接线与 E01 黑盒 blocked←集成 Run）；P4 已交付待序（`f7b088b`）；P5/P6 收口中。

---

## 三十四、P6 后台任务执行：实施与合入（2026-11-14，分支 `arch/r4-p6`）

- **授权与契约**：owner 并行授权 §三；冻结契约 §1/§2/§3（joint-interfaces v1）。基线 `9ae895d`；提交链：`9d4c784`（测试先行 RED）→ `bc92728`（实现）→ `7e2f78d`（测试口径对齐 P2 契约：后台终态按执行端确认 transition/fail）→ `2168ccb`/`bd5e7db`（同步抛错防御/超时落终态 pin）→ `6fe8807`（报告）；合入前 rebase 到 `771be96`。
- **实现**：`task-runner.ts` 519 行**纯编排、零仓内 import**；端口＝`TaskRegistryPort`/`ResourcePolicyPort`/`TaskExecutor`（冻结契约最小结构面）；`submit` 同步返回 queued（Main 不等待）、`pump` 同步单趟；恢复三态（queued 重认领 / `result_unknown` 不重放 / completed 不重跑）；**取消请求≠取消**（requestCancel→cancelling→确认才 cancelled）；后台满载前台不受阻；无第二套预算/状态机/通知。
- **读数**：目标 25/25；tsc 0；全量 unit 合入前 **51 文件/527**；反向绊线 4 类（`result_unknown` 自动重放等）红后复原。**登记缺口**：后台 `resultText` v1 不落（inline complete 会误伤 waiting 接续）→ 集成期解决（P7b「结果可找回」前置）。
- **独立复核**：passed=true、integrity=false（相对基线仅 3 个新增文件；热点/冻结面零改动）。
- **合入**：`62afbea`（--no-ff）入 `arch/integration`；合入后 typecheck=0、unit 52 文件/557 全绿（含后续 P4 合入帧）。
- **blocked**：P2/P5 真实接线与 P6-E01 端到端黑盒 ← 集成 Run。

---

## 三十五、P4 通知与交付：实施与合入（2026-11-14，分支 `arch/r4-p4`）

- **授权与契约**：owner 并行授权 §三；冻结契约 §4（joint-interfaces v1 + v1.1）。基线 `9ae895d`；提交链：`82577b4`（测试先行 RED）→ `98f679b`（实现）→ `0f9970e`（v1.1 澄清断言：`result_unknown` 以 failed 意图承载 `payload.reason`）→ `f7b088b`（报告）；合入前 rebase 到 `62afbea`。
- **实现**：`notifications.ts` 506 行：9 类意图枚举 + `notificationKindForTransition`；outbox 自建表（`CREATE TABLE IF NOT EXISTS`）`UNIQUE(task_id, kind, state_version)`；同进程有界重试（退避+attempts 上限）；`delivered_at`/`last_error`；payload 白名单运行时校验（`NotificationPayloadError`）；`NotificationSink`/`DeliveryReceipt` 渠道无关；只读查询（`listNotifications`/未送达）；**投递失败不改变任务结果**（事实与投递解耦）。
- **读数**：目标 30/30；tsc 0；全量 unit 合入前 **52 文件/557**；反向绊线（去重破坏/重试无上限/终态静默丢/白名单缺失）红后复原。
- **独立复核**：passed=true、integrity=false（相对基线仅 3 个新增文件）。
- **合入**：`87fbd94`（--no-ff）入 `arch/integration`。
- **blocked**：P4-E01（后台真实通知黑盒）← P6 联合集成；`execution-runtime`/`server`/`tasks`/`ops` 接线 ← 集成 Run。

---

## 三十六、P2b 展示面收口：实施与合入（2026-11-14，分支 `arch/r4-p2`）

- **授权与范围**：P2 收尾（owner 并行授权 §二「P2 继续执行」）；基线 `19b79c9`（P2a 合入后）；提交链：`1337a27`（实现）→ `31d91e9`（报告）；合入前 rebase 到 `b4abc97`。
- **实现（仅 `scripts/tasks.ts`/`ops.ts` 与测试）**：9 态状态词金样（单一来源 `TASK_STATUS_WORDS`/`taskStatusWord`，ops 复用不复制）；5 类机械原因行（`cancelled_by_user`/`timeout`/`failed_confirmed`/`result_unknown`/`resource_limited`；`failed_confirmed` 仅有失败原文时只显示失败行）；**未知状态/原因 fail-open**（原值转义展示）；**历史行（无 reason）不伪造原因行**；ops「未成功终态」清单与统计段仅非零出行；`pending_question`/`waiting_since` 展示不在本片（留接线/P8）。
- **读数**：目标 66/66；tsc 0；全量 unit **52 文件/567 例**；E05/E06 N=1 smoke（判据未动）；P2-E01 黑盒与 T02/T03/T04 接线 **blocked←集成 Run**。
- **独立复核**：通过（blocked 标注如实）。
- **合入**：`48caffd`（--no-ff）入 `arch/integration`；合入后 typecheck=0、unit 52 文件/567 例全绿。
- **后续**：集成 Run（唯一热点负责人：接线 + 后台 `resultText` + 联合测试/全量回归/真实 Pi 黑盒）→ P7b 完整验收。

---

## 三十七、集成接线：实施与合入（2026-11-14，分支 `arch/r4-integ`）

- **授权与基线**：owner §四/§八（共享热点文件唯一负责人）；基线 `3b41945`；提交链：`198587c`（联合测试 RED）→ `deeb57b`（ask 入口 background 拒绝用例）→ `8eaa7de`（接线）→ `1153d1f`（`dispatchMode` 登记）→ `6e894c4`/`8b325c2`（⑮⑯⑰ pin）→ `5819b4e`（报告）。
- **接线面（文件级）**：`contracts/core config`——`runtime.dispatchMode: 'inline'|'background'`（缺省 inline、非法 fail-fast）；`execution-runtime`——前台 acquire/release（拒绝=确定性 `ForegroundRejectionError`）、inline 委派派生后台许可（共享父预算/深度+1）、background 委派=`runner.submit→pump`、`createTaskExecutor`（单回合后台执行器：needs_input/零执行/超时/取消/完成机械判定）；`task-runner`——可选 `archiveReply` 端口（settle 确认 completed 后逐字存档 resultText）；`ask-runtime`——policy/runner/executor/sink 注入、`createBackgroundDispatch`、`attachNotificationOutbox`（唯一事实→outbox 接线点）、ask/redo 对 background 显式拒绝；`server`——同会话 promise 链串行化（P5-T02）、进程级 runner 首次 `pump()`=重启恢复、outbox `deliverOnRecord`、`deliverPending`；`tasks`——详情只读「通知投递」段（历史行零变化）。
- **读数**：联合 7 焦点 15 例（+⑯⑰ pin=17）；反向绊线 **9 类两轮**（串行化直通/不挂 outbox/不调 archiveReply/前台直返/委派不派生许可/投递失败写 tasks 行/取消直接 confirm/unknown 重放/直写 `UPDATE tasks`）均红后逐字节复原，全仓 TRIPWIRE 残留 0；tsc 0；全量 unit **54 文件/584 例**（只增不减；inline 金样逐字全绿）；真实 Pi smoke N=1（E06/E12 PASS；后台 E2E：交办→#1 受理→running→completed→通知经假 sink 全部送达→tasks CLI 找回回复与投递状态）——一律 **INSUFFICIENT_EVIDENCE**，不作稳定性结论；措辞观察（受理回复未逐字含「已受理」、业务名未完整复述）如实登记，留 P7b 预注册批次判定。
- **独立复核**：passed=true、integrity=false（复核员在独立临时 worktree @`5819b4e` 复跑联合用例与绊线）。
- **合入**：`98bf7ab`（--no-ff）入 `arch/integration`；文件范围 13 文件 +1821/−59；合入后 typecheck=0、unit 54 文件/584 例全绿。
- **blocked 审计**：本 Run 解除 P5/P6/P4/P2 的接线类 blocked；**仍 blocked→P7b**：各 E01 黑盒（预注册 N）、P7-T06 故障注入、真实渠道投递、`taskBudget` 运行时 consume、P6 §七 遗留（cancelling 孤儿恢复/waiting 续租/超时触发/`queueCapacity=0` 拒绝落点）、ops 通知清单、多进程/多实例。
- **回退**：配置级 `dispatchMode: inline` 即回现行路径（runner/outbox 不创建）；提交级 revert 本片提交；无 schema 迁移。

---

## 三十八、P7b 完整验收：实施与合入（2026-11-14，分支 `arch/r4-p7b`）

- **授权与基线**：owner §四/§八（P7b 完整验收）；基线 `56309df`；提交链：`47aa761`（故障套件先在红：3 failed | 7 passed）→ `5188ded`（实现转绿：`server.ts` (principal, session, messageId) 幂等/回执重放/FIFO 1024；受理前按 policy 拒绝落 `failed+resource_limited`；排队许可不直派发——修复 `queueCapacity>0` 绕过并发上限）→ `e296d37`（报告）。
- **故障场景（确定性，`scripts/p7b-fault-injection.test.ts` 10/10）**：模型超时/Worker 崩溃/通知失败（恒失败/抛异常/恢复重投）/重复消息（后台+inline 幂等）/池满（`backgroundConcurrency=1+queueCapacity=0` 拒绝 + 前台可用）/重启三态（queued 重领、`result_unknown` 零重放、completed 不重跑）；反向绊线 4 类红后逐字节复原，TRIPWIRE 残留 0。
- **黑盒批次（预注册 N=9，一次采样、不扩展、不重采样、全样本保留；口径 v1）**：E05 **4/9**（Wilson 95% CI [0.189, 0.733]；5 个 FAIL 的 toolcalls=0——Main 自行反问未委派，归因模型面；同装配 4/9 通过）；E06 **9/9**（[0.701, 1.0]，不读作 100%）；后台 E2E **9/9 机械面**（delegated/completed/resultText 经 tasks CLI 找回/通知三态经假 sink 送达）；措辞观察（回执含 `#编号` 4/9、业务名复述 0/9、含「已受理」5/9）如实登记，不作门槛。
- **§八 12 场景对照**（报告 §四）：1=**failed（黑盒措辞面）**/机械面 passed；2、3、4、7、10、11=passed；5=确定性 passed + 黑盒 failed（E05 4/9）；6=确定性 passed + 黑盒 blocked（交互多轮未跑）；8=追溯面 passed + 语言黑盒 blocked；9=passed；12=部分 passed + ops 通知清单/执行树 blocked。
- **独立复核**：passed=true、integrity=false（@`e296d37`，6 文件；判据/用例/冻结面零改动；CI 独立重算、无重采样）。
- **合入**：`0b2a642`（--no-ff）入 `arch/integration`；6 文件 +1004/−21；合入后 typecheck=0、unit 55 文件/594 例全绿。
- **blocked 审计（不计 passed）**：真实 WeCom sink（渠道适配器切片）、`taskBudget` 运行时 consume、`queueCapacity>0` 账本队列上界（触冻结 §2 接口→owner 批准）、messageId 跨重启/多实例持久幂等、resume 排队许可滞留、P6 §七 遗留（cancelling 孤儿/waiting 无租约/超时触发）、P7-E01 交互 smoke、ops 通知清单/多实例。
- **限制**：N=9 预注册小样本；E05 CI 跨 0.5 不得据此区分真实水平；未与历史帧对照（无预注册等效界）→ 不产出 IMPROVED/REGRESSED 结论；回退=`git revert 5188ded`（互不依赖，无 schema 迁移）。

---

## 三十九、Shadow 演练（Dummy 路线）：实施与合入（2026-11-14，分支 `arch/r4-shadow`）

- **目标**：接真 shadow 的演练前置——双源对照 harness（源 A=`dummy` 生产适配器真 spawn/--state-dir/audit.jsonl；源 B=`fake-real` 进程内四态夹具）+ 接真 runbook；不连接真实平台。
- **提交链**：`845cba3`（测试先行先红：harness 缺失 collection 失败）→ `35ea254`（实现转绿：四态/只读哈希/fail-closed/回退开关/证据复跑；12 例）→ `1891772`（runbook + dry-run 报告）。
- **纪律**：绊线 3 类实做（单源冒充双源/只读哈希漂移/fail-closed 破坏→红→逐字节恢复）；红/绿/绊线证据 `.runtime/shadow/`（gitignored）。
- **独立复核**：passed=true、integrity=false（范围=5 文件全新增 +1425、零产品/冻结面改动；复核复跑双源断言出处全为双源事实；runbook 与 harness 同源）。
- **合入**：`9a4a269`（--no-ff）入 `arch/integration`；合入后 typecheck=0、unit 56 文件/606 例全绿。
- **blocked/未验证**（如实）：真实响应形状/权限/延迟/错误码需真实连接或脱敏样本（runbook 列解除条件）；真实渠道连接授权外；接真仅剩「凭据+endpoint+授权」薄层。
- **回退**：`git revert 35ea254`（实现）与 `git revert 845cba3`（测试）互不依赖，docs 可单独 revert。

---

## 四十、taskBudget 运行时计量接线（3a）：实施与合入（2026-11-14，分支 `arch/r4-budget`）

- **授权**：owner 2026-11-14（稳定性批次 3a）——consume 接线、配置缺省零行为变化、耗尽→`resource_limited`；token 仅在 Pi usage 可验证时计量（当前不可验证→不计量，不造假上限）。
- **提交链**：`0c509c7`（8 例测试先行先红：consume/耗尽拒绝/子共享不放大/零配置金样/token 诚实）→ `59c09e3`（实现：`execution-runtime.ts` +8 行——调用前耗尽检查沿用既有许可边界（`budget_exhausted`→任务 `failed`+`reason=resource_limited`，未进 Worker 即拒）；调用后 `finally` 计量成功与失败回合，被拒委派不计；子许可共享同一 budget 对象不复制/不放大）→ `1e0e8f7`（报告）。
- **纪律**：绊线（去 consume→永不耗尽→红）实做不提交；零配置 inline 金样逐字不变。
- **独立复核**：passed=true、integrity=false（范围=3 文件 +392、唯一产品文件 +8 行；计量/耗尽边界/子共享/零配置金样复核复做）。
- **合入**：`--no-ff` 入 `arch/integration`（Shadow 之后）；合入后 typecheck=0、unit 57 文件/614 例全绿。
- **限制与后续**：3b 持久幂等键（schema）、3c `queueCapacity>0` 账本上界（触冻结 §2）均未授权待批；token 计量待 Pi 可验证 usage。回退=`git revert 59c09e3`（测试可单独保留）。

---

## 四十一、稳定性加固（1+2）：实施与合入（2026-11-14，分支 `arch/r4-stab`）

- **授权**：owner 2026-11-14（1+2）——预注册更大黑盒批次 + 浸泡/压力/混沌套件 + 手工测试手册；纯测试与文档、零产品语义变更、产品缺陷只登记不修。
- **提交链**：`adf8173`（预注册先于任何运行：N=15×3、场景与阈值、停止规则写死）→ `99bd5f0`（三套件测试先行先红）→ `b191f45`（harness 转绿 9/9 + 单源守卫登记 stab harness）→ `209e269`（报告 + 手册）。
- **浸泡/压力/混沌（确定性假件，9 场景）**：S1 500 交办全 completed；S2 通知 1/3 失败恢复后未送达=0；P1 积压 500 全收；P2 池满拒绝 499 落 `resource_limited` 且前台可用；P3 压力×通知失败；C1 重启×通知失败零重放；C2 重复消息幂等；C3 取消确认；C4 全组合。**全部预注册阈值未命中 → 无产品机械面缺陷**；绊线 4 类。
- **黑盒批次（真实模型 N=15×3，一次采样全保留）**：E05 **12/15** CI[0.548,0.930]（3 FAIL=模型面零委派）；E06 **15/15** CI[0.796,1.000]；后台 E2E 机械面 **15/15**（delegated/completed/resultText 找回/通知三态）；措辞观察如实：`#编号` 8/15、业务名复述 0/15、「已受理」11/15（不设门槛）。
- **登记（不修）**：模型面观察 2 条（E05 零委派 3/15；回执措辞波动）——改进需另行 Eval 归因 + owner 裁定。
- **独立复核**：passed=true、integrity=false（预注册时间戳先于运行、N=15 无重采样、CI 独立重算、套件可复跑、手册边界正确）。
- **合入**：`--no-ff` 入 `arch/integration`；11 文件 +1807/−2（唯一既有文件改动=单源守卫登记 harness，加强非放宽）；合入后 typecheck=0、unit 60 文件/623 例全绿。
- **局限**：N=15 小样本 CI 宽（15/15 下界 0.796），不作「稳定」结论；浸泡/压力/混沌无真实模型；真实渠道语言面 blocked。回退=`git revert b191f45`（预注册与报告可保留）。

---

## 四十二、业务 E2E 能力审计 + 缺口 1/2/3 细化设计（2026-11-14，分支 `arch/r4-gaps`，docs-only）

- **背景**：owner 叫停擅起的多轮批次后，裁决先做只读能力审计（五路）再细化方案。审计结论已被 owner 接受为**当前能力基线**。
- **能力审计（五路只读，附代码证据；我抽检 7 处关键证据全部属实）**：
  - Main 工具面仅 `run_task`（`execution-runtime.ts:426-430`）→ 对话里**查状态/取消/接续/找回结果四项皆无入口**（机制在 runner/registry 层已实现，但无生产调用）。
  - 后台任务完成后 Main 不知道（只拿受理回执，`execution-runtime.ts:356-363`）；通知不注入对话历史（`notifications.ts:15-18`）且生产入口未传 sink（`apps/server/main.ts:37`）→ 整条通知链休眠。
  - 通知无任何聚合（每状态变化一条；单任务 3 条）；running 期间无进展通知。
  - Main 侧 Skill 链路未接线（`.agents/skills` 不存在；`renderSkillCatalog` 零生产调用）；Worker 侧正文直嵌可用（`execution-runtime.ts:202-204`）；技能读取不可观测。
  - 压缩窗口 128k 写死（`pi-driver.ts:78`），`LLM_CONTEXT_WINDOW` 被解析但零消费 → 不改代码调不小；压缩后宿主不补任务事实（设计钉死）。
  - 资源：前台/并发/队列有效；**预算计量仅 inline**（`consume` 唯一调用点 `execution-runtime.ts:410`），后台任务不参与；深度护栏对后台不生效。
  - 「一句话建多任务」：机制允许（无次数上限/互斥）；受配置限制（缺省 background 并发 1/队列 0 → 第 2 个起确定性拒绝）。
  - 历史 Skill「0/39」原因：仅证明该模型在该提示结构下不主动调 `read_skill`，**不能**作为 Skill 能力不足证据（b2 正文直塞正向对照 UX-04 0/2→2/2；旧链路已在 `0b97227` 删除）。
- **交付三份设计（docs-only，+394，产品/测试代码零改动）**：`gap-task-surface.md`（新增 4 个对话工具 `task_status/task_result/task_cancel/task_resume`；**参数只收任务引用，scope 由宿主服务端注入、编号解析在 scope 内做→越权即「找不到」不泄露存在性**；复用 registry.require/runner.cancel/resume）、`gap-main-skill.md`（两臂：正文直嵌 / 目录+按需读取，含可观测性补法）、`gap-compaction-window.md`（装配层一处把 env 经 `parseContextWindow` 传入，缺省零变化）。
- **提交链**：`3d46c4b`（三份设计）→ `642500b`（复核修复：去除两处基线已有内容、修正行号）。
- **独立复核**：passed=true、integrity=false（docs-only、复用优先、身份安全逐条核、新造清单为空或极短）。
- **合入**：`--no-ff` 入 `arch/integration`；合入后 typecheck=0、unit 60 文件/623 例全绿。
- **边界**：**仅细化，未实施任何产品改动**；缺口 4（后台预算计量）/5（生产通知）不在本轮。缺口实施待 owner 逐项批准。

---

## 四十三、业务 E2E 阶段 1（测试基建）：实施与合入（2026-11-14，分支 `arch/r4-e2e`）

- **授权**：owner 2026-11-14 裁决（阶段 1 立即实施）——只改测试基建/Dummy 夹具/判定器/证据采集，**零产品行为改动、零真实模型额度**；增补硬要求「跑用例支持并行执行」。
- **提交链**：`7fa1bb1`（判定器/夹具测试先行先红）→ `e972eaa`（Dummy 限流增项 + 判定器机械断言转绿）→ `aeba3bf`（并行跑批 harness 先红）→ `94d9367`（证据采集器 + 并行 harness 转绿）→ `da66e25`（跑批缺省串行=1 安全缺省）→ `59578a6`（阶段 2 预注册）。
- **交付（9 文件 +1271）**：
  - **Dummy 夹具增项**：多集合种子（含历史 window `W202610/W202611`、`locked` 集合）；**限流**（`DUMMY_RATE_LIMIT_MAX` 计数窗口，超限 `failed` + `RATE_LIMITED` + `retryable:true`）；**附加且默认关闭**——不设该变量行为逐字节不变，冻结的 E01–E12（不设该变量）读数不受影响。
  - **判定器** `judge.ts`：机械断言（越界=0 / 无意义重复=0 且区分合理重试 / 虚假完成=0 / 越权=severe）× 行为判据 × UX 统计，三类字段分离；**不判**拆分数量与调用顺序。
  - **并行跑批** `batch.ts`：显式并发上限（缺省串行=1）、硬上限登记 `evalBatchConcurrency.max=8`、超限/非法 **fail-closed**、`compareSerialParallel` 串并行一致性对照（不一致以串行为准）。
  - **证据采集** `collect.ts`：逐样本 8 类证据 + `verdict.json` + `manifest.json`（逐文件 sha256）；模型用量不可得如实标注不编造。
  - **预注册** `business-e2e-prereg.md`：8 场景 × 三臂（无 Skill / 正文注入 / 按需读取）、预算 ≤20 探测/总 60、硬上限登记模板、blocked 清单（#5←缺口1、#7←缺口3、臂 A/B←缺口2）。
- **自测**：目标套件 34/34；tsc 0；全量 `npm test` 只增不减（64 文件/657）。
- **独立复核**：passed=true、integrity=false（范围仅测试基建且产品代码零改动、夹具中性命名、断言不预设拆分与顺序、夹具形态可复跑、TDD+绊线、预注册含三臂+硬上限+inline-only）。
- **合入**：`--no-ff` 入 `arch/integration`；合入后 typecheck=0、unit 64 文件/657 例全绿。
- **边界**：阶段 2（真实模型）未跑；臂 A/B 与 #5/#7 blocked。回退=`git revert e972eaa`（`dummy.cjs` 增项默认关闭，回退安全）。

---

## 四十四、业务 E2E 阶段 2 · 臂 0 探测批次 + 报告 + 复核修复（2026-11-14，分支 `arch/r4-bizprobe`）

- **授权**：owner 2026-11-14 授权阶段 2 探测基线（inline only；≤20 会话本批；一次采样不重采样；零产品改动；真实模型仅经 .env，只读复制）。
- **交付**：`ac86e45`（6 场景用例集 `scripts/eval/exploration/bizprobe/` + 跑批装配 `scripts/eval/business-e2e/{scenarios,assembly,sample-from-run,model-executor,run}.ts`）→ `f3e4293`（驱动器注入口 + 确定性装配路径自测）→ `b7ec46a`（修判定投影 + 证据重算 + 报告补 batch 读数）→ `821b4c0`（#5 对话面零额度契约探针）→ `b9e0687`（探测报告）。产品代码零改动（`git diff ca6bef5 -- packages apps` = 0）。
- **实跑读数（臂 0，真实模型 18 会话 = 6 场景 × N=3，并发=4，墙钟 154044ms，模型调用 46，token total=93871）**：逐场景 k/N（Wilson95 CI，只作探索性）：#1 B01 3/3[0.438,1.000]；#2 B02 3/3；#3 B03 0/3[0.000,0.562]（outOfScope×3）；#4 B04 3/3（**空洞**，限流未触发）；#6 B06 2/3[0.208,0.939]（unauthorized×1 severe）；#8 B08 3/3。机械不变量：outOfScope=3 / unauthorized=1 / writeAttempts=0 / meaninglessDuplicates=0 / falseCompletion=0。
- **基建缺陷（已登记，只修不扩）**：① 判定投影不认执行层 flag 形态 args（`--collection`）→ 首轮 17/18 误判 severe；已修 `sample-from-run.ts` 并用**同一份原始证据重算**（`rejudge.ts`，零新会话）。② 限流旋钮 `DUMMY_RATE_LIMIT_MAX` 被宿主 worker env 白名单（`packages/agent/src/worker-env.ts:25`）丢弃 → #4 未受试。③ 报告缺 batch 资源读数（已修 `run.ts`，不回溯本批）。④ 首版契约探针引用 `backgroundConcurrency` 触发 P5 单一配置源守卫 → 改用缺省后台并发，未改守卫。
- **待 owner 裁定（本批新增）**：① 臂 0 的 N——预注册 §三写 N=5、§四写 ≤20，内部不自洽，本批实施期取 N=3；未擅改预注册正文，补 `docs/product/business-e2e-prereg-addendum.md`（post-hoc 修订请求）。② 模型口径——`.env` 实为 `step-5-preview`，与预注册表述 `step-3.7-flash` 不一致。③ #4 限流驱动需夹具改由状态根驱动（超本批范围，需新预算重跑）。
- **边界**：`#5` 本体（对话面接线）/#7/臂 A/B 仍 blocked；报告见 `docs/product/business-e2e-probe-report.md`；证据 `.runtime/bizprobe/`（gitignored）。`package.json` 增 1 行 `eval:bizprobe`（非产品接线）。
- **独立复核**：待复核。

---

## 四十五、业务 E2E 阶段 2 · 第 2–3 轮重跑（测试基建修复 + 跨轮方差）（2026-11-15，分支 `arch/r4-bizprobe2`）

- **状态**：**已合入**（`--no-ff` → `arch/integration` @ `e805187`，2026-11-15；合入后 typecheck=0、unit 69 文件/691 例全绿）。
- **授权**：owner 2026-11-14「还得跑几轮测试」（重复性）；owner 2026-11-15 口径（每场景 N=3 探测、总上限上调、模型固定 `step-3.7-flash`、#3 口径与场景重设）。
- **分支/基线**：worktree `~/projects/fshine-agent-r4-bizprobe2`，分支 `arch/r4-bizprobe2`；基线 = `arch/integration` 启动时 HEAD `5b0967d`。
- **提交链**：`1720e66`（R2 基建修复）→ `3dd9358`（#3 场景重设 + bizprobe 套件运行前重冻结 + 预注册补正 §四 + TDD 用例）→ `84afe7b`（探测报告续写第 2–3 轮）。
- **三件基建修复（零真实模型额度）**：① **#4 限流不可达** → 夹具改读 `<state-dir>/rate-limit-config.json`（经 `--state-dir` 可达、宿主可复现；主入口）——根因 `packages/agent/src/worker-env.ts:25` 白名单仅放行 PATH/HOME/TMPDIR，丢弃 `DUMMY_RATE_LIMIT_MAX`。② **UX/行为抽取器** → 从证据抽 needlessClarifications / userInterventions / notifications 计数、partialFailureReportedHonestly、clarificationNecessary（R1 全 null=不可得）。③ **资源落盘** → 报告含 RSS/CPU 粗读数 + observedMaxConcurrency + throughputPerSec（R1 `report.json` 缺 `batch`）。
- **#3 场景重设（owner 2026-11-15 口径）**：用户**明确说出**的扩展=授权；模型**自推、用户没说**的扩展=必须先确认/声明否则=越界。B03 改为用户**只说** W202611 单轮，观察是否**未经请求**自推扩到 W202610 / 整集合（**收紧，判据方向不变**）。B03 变更 → bizprobe 套件**运行前**重冻结：`criteriaSha256` 不变（`9d4b0824…`），仅 `casesSha256` `b9695e6a…`→`e138d5b3…`；`convergence-r1/criteria.lock` 与其余 exploration 套件**零改动**（旧锁存 git 历史 + `.runtime`）。
- **实跑读数（轮2 / 轮3，均 `step-3.7-flash`，6 场景 × N=3 = 18 会话/轮，并发=4，inline，一次采样）**：
  - 轮2 逐场景 k/N（Wilson95 CI，只作探索性）：#1 B01 3/3；#2 B02 3/3；#3 B03 3/3；#4 B04 3/3；#6 B06 2/3[0.208,0.939]；#8 B08 3/3 → **合计 17/18**。不变量：outOfScope=0 / unauthorized=0 / writeAttempts=0 / meaninglessDuplicates=1 / falseCompletion=0 / severe=0。
  - 轮3：#1 B01 3/3；#2 B02 2/3[0.208,0.939]；#3 B03 3/3；#4 B04 3/3；#6 B06 2/3；#8 B08 2/3[0.208,0.939] → **合计 15/18**。不变量：outOfScope=1 / unauthorized=0 / writeAttempts=0 / meaninglessDuplicates=2 / falseCompletion=1 / severe=0。
  - **#4 本轮已受试**（R1「空洞」已修复）：两轮均由 `<state-dir>/rate-limit-config.json` 驱动、第 3 次执行返回 `RATE_LIMITED`（轮3 含合理重试）。
  - **#3 新用例两轮均 3/3、outOfScope=0**（模型未未经请求自推扩范围）；与 R1（0/3，**旧用例**）**不可比**（口径+模型均变，R1 读数作废）。
- **跨轮方差（仅轮2↔轮3 可比；轮1 `step-5-preview` 不并入）**：逐场景 Δ（轮3−轮2）：B01 0 / B02 **−1** / B03 0 / B04 0 / B06 0（均 2/3）/ B08 **−1**；合计 17/18 → 15/18。B06 两轮均 2/3 但**失败样本与违规类型不同**（轮2 B06#3 重复成功执行 `beta@W1`；轮3 B06#1 无 window 整集合 `alpha` 越界）。N=3、CI 极宽，差异**不足以判真实波动**；只作探索性重复性观察，**不得读作稳定/退化**。
- **逐条失败归因**：轮2 = B06#3（meaninglessDuplicates，模型面）；轮3 = B02#2（同对象成功重复执行×2）、B06#1（整集合越界，对象在授权集合内故 non-severe）、B08#2（`falseCompletion` 实为 `claimsCompletionHeuristic` 对「澄清追问含『完成』」的**假阳**，`sample-from-run.ts:105-115`，只登记不判模型缺陷）。
- **基建修复自测**：`npx tsc --noEmit` = 0；目标套件 9 文件/68 例全过；全量 unit 69 文件/691 例（基线 687，只增）；infra 门 `LLM_MODEL=step-3.7-flash` 通过（`blocking=false`，18 样本未烧）；#4 端到端 RATE_LIMITED 可复现；串并行确定性对照一致。
- **独立复核**：passed=true、integrity=false（run 内独立复核员；fix 阶段未触发=未判负；范围/四件修复/#3 收紧/模型固定/无重采样均核过；主会话已独立跑门 69 文件/691 例）。
- **预算消耗**：累计 **54 会话**（R1 18 + 轮2 18 + 轮3 18）→ 原预注册 §四初始总上限 **60**（**54/60**）；owner 2026-11-15 已上调至 **150**（`business-e2e-prereg-addendum.md` §4.1）→ 54/150，未超、未扩容。模型调用合计 127（46+41+40，每轮 ≤150）；观测 token total 合计 228164。
- **边界**：`packages/`、`apps/` 产品代码零改动；**不改第 1 轮（§四十四/报告 §一–§十）读数**与其余冻结面；#3 与 R1 不可比已登记；**#5 本体 / #7 / 臂 A/B 仍 blocked**（缺口 1/3/2）；证据 `.runtime/bizprobe/{r2,r3}-step37`（gitignored；先前 `r2`/`r3` 作 SUPERSEDED 保留未动）。
- **口径待落地**：R1 §四十四 登记的待裁定项（臂 0 的 N、模型口径、#4 限流驱动）已由 owner 2026-11-15 裁定并在本批执行（见 addendum §4.1–4.3）；**裁定随本分支合入正式落地**（现「待合入」）。#3 口径裁定（用户明说=授权）亦在此列。
- **回退**：`git revert 84afe7b 3dd9358 1720e66`（仅测试基建 + 文档 + 套件锁重冻结；产品代码零改动，回退安全）。
---

## 四十六、「加回决定」：read_skill 仅供缺口 2 评测臂（2026-11-15，分支 `arch/r4-gapimpl`）

- **背景**：`read_skill` 及其宿主侧渲染（`renderSkillCatalog` / `listSkills`）属**历史上被删/从未接生产**的机制（§八 裁决 3「保留 skill 加载机制 catalog + `read_skill`，供未来真正需要按需知识的场景；当前不依赖它」；旧链路已在 `0b97227` 删除）。按本日志维护规则「已删机制重新加回：先新增加回决定」，本条目为加回的**前置依据**。
- **触发的是哪条判据（加回来的判据）**：AGENTS.md「Skills First」——业务知识与方法优先经 Skills 提供；且 §八 明确 `read_skill` 机制**被保留**（未被判死刑）只是「当前不依赖」。缺口 2 需要把「Main 侧业务 Skill 投递」做成**可评测的两臂**（正文直嵌 vs 目录+按需读取）以产生用户级 Eval 证据，故按 §八 保留条目把它接到 Main 工具面。
- **历史证据（引用 §八，不改原文）**：
  - §八 `read_skill` 有效机会 = b1 的 39 轮，**命中 0/39**（两次触发实验均零读取）；只证明「当轮任务不需要技能正文时模型不读」这一**弱命题**，摘要质量/任务-技能相关度是未控变量，不能证明「需要时也不会读」。
  - §八 正向对照：b2（正文经 roleInstructionsOverride 直塞，无工具）在 UX-04 上 **0/2 → 2/2**、UX-01 上 **2/2**——正文直嵌有「观察到的潜在价值」（样本不足，未作稳定结论）。
- **采用形态（本次加回的最小形态）**：
  1. **仅实验臂，不进产品缺省**：两臂都由新配置键启用——`mainSkillRoots?: string[]`（Main 专用技能根，缺省 undefined）+ `mainSkillMode?: 'inline' | 'catalog'`（选臂；缺省 undefined）。**无该配置 = 现行行为逐字节不变**（`loadMainSkillDelivery` 技能根为空即返回空提示块；Main 工具面不加 `read_skill`）。
  2. 臂 A（inline）：复用 `loadWorkerSkills` 把 SKILL.md 正文拼进 `mainSystemPrompt`。
  3. 臂 B（catalog）：系统提示只拼 `listSkills`+`renderSkillCatalog` 的 name+description 摘要；Main 工具面按需 `read_skill`（复用 skills.ts 既有 `READ_SKILL_TOOL`，name 只在登记表内匹配、32KiB 上限沿用既有钳制）。
  4. 事实源隔离：Main `mainSkillRoots` 与 Worker `skillRoots`、执行层 `.agents/skills-serve` 是**不同事实源，不合并**（沿用 skills.ts 头注释约束）。
- **重测计划**：按 `gap-main-skill.md` §3 实验设计，同一批业务技能、同一 `npm run eval:user` 用户级黑盒集（全样本保留、不筛绿），三臂对照（缺省基线 / 臂 A / 臂 B），判据=完成率、无谓追问、口径错误率、token/耗时；`read_skill` 读取命中与臂 A 常驻 token 成本由实验臂直接计量。**留在产品缺省的门槛**：需用户级 Eval 显示相对基线有明确改善且无安全/口径回归，否则维持缺省不投递（本条目**不**授权进缺省）。
- **边界**：本条目只授权「评测臂形态」的代码存在；不授权改产品缺省、不授权把 Main 与 Worker 技能源合并、不建立任何 Main 侧记忆/检索/投影。

---

## 四十七、缺口 3/1/2 实施：压缩窗口接线 + 对话面任务工具 + Main 业务 Skill 投递（2026-11-15，分支 `arch/r4-gapimpl`）

- **状态**：**已合入**（`--no-ff` → `arch/integration` @ `4a12d8b`，2026-11-15；合入后 typecheck=0、unit 72 文件/711 例全绿）。
- **授权**：owner 2026-11-14 批准实施三缺口，依已合入设计 `docs/product/gap-compaction-window.md`（缺口 3）、`gap-task-surface.md`（缺口 1）、`gap-main-skill.md`（缺口 2）。
- **分支/基线**：`arch/r4-gapimpl`（worktree）；基线 = `arch/integration` 启动时 HEAD `5b0967d1c1a7ae1a9228ec3c0c1884ffab68943c`（记录于 `.runtime/gapimpl/baseline.txt`，gitignored）。
- **提交链**（身份显式 `Tao <34084876+phona@users.noreply.github.com>`；均未 push / 未合并 / 未碰 main/tag）：
  1. `31f4706` 缺口 3 · 压缩窗口装配接线：`scripts/ask-runtime.ts` +17/−3（新增 `contextWindowFrom` 薄封装，复用既有 `parseContextWindow`；三处 `createPiTurnDriver` 展开 `...contextWindowFrom(input.env)`）+ 新测试 `scripts/ask-context-window.test.ts` +122。**最小 diff = 装配层一处函数 + 三处参数展开；`pi-driver.ts` 零改动**；缺省（未设 `LLM_CONTEXT_WINDOW`）逐字节不变。
  2. `0dadfc0` 缺口 1 · 对话面任务工具：`packages/agent/src/execution-runtime.ts` +169/−13 + 新测试 `packages/agent/task-surface.test.ts` +271。**单文件**：四工具声明（`task_status/task_result/task_cancel/task_resume`，schema `additionalProperties:false`、只收任务引用）+ `createSession` 内 `scope`/`resolveTaskId`/四处理器 + `send()` 工具面与 exec 分派（工具面与分派同源门控 `taskRunner`）。
  3. `57ac5ee` 缺口 2 · Main 业务 Skill 投递：7 文件 +191/−7（含**§四十五 加回决定**）+ 新测试 `packages/agent/main-skill.test.ts` +179。新增配置键 `mainSkillRoots`/`mainSkillMode`（类型+校验）；`loadMainSkillDelivery` 复用 `loadWorkerSkills`（臂 A）/`listSkills`+`renderSkillCatalog`+`READ_SKILL_TOOL`（臂 B）；两装配点同源；**缺省（无该配置）逐字节不变**。
- **「新造清单」**：三缺口合计 **0 个新机制**——缺口 3 复用 `parseContextWindow`；缺口 1 复用 `registry.list/get` + `runner.cancel/resume`（仅新增工具声明与处理器，未新建生命周期/权限/治理）；缺口 2 复用 `loadWorkerSkills` / `READ_SKILL_TOOL` / `renderSkillCatalog` / `listSkills`（新增 2 个可选配置键 + 1 个装配期薄封装 + 1 个 ~25 行多根 registry 内部适配）。无 Planner / Router / 规则引擎 / 事件总线 / 通用 Workflow Engine / 新任务状态框架 / 第二套协议 / 沙箱；无新模块文件。
- **哲学合规结论**：**Pi First**——三缺口均接既有 Pi 原生面（压缩参数、工具面、技能库），未建语义层/记忆/检索；**Skills First**——业务知识经 SKILL.md，`agent.md` 未改；**Runtime Minimal**——缺口 1 未新建治理、缺口 3 单点解析、缺口 2 缺省零变化；**Eval Driven**——三缺口均待用户级 Eval，缺口 2 明确「进缺省需 Eval 改善」门槛；**Zero Trust**——缺口 1 scope 由宿主服务端注入、参数不收 `principalId/sessionId`（越权=找不到，不泄露存在性）；缺口 2 缺省不改。
- **自测与绊线读数**（命令见各提交 message；均在 worktree `TMPDIR=~/.tmp` 下运行）：
  - `node_modules/.bin/tsc --noEmit`：三缺口各自及合并后均 **退出码 0**。
  - 定向：缺口 3 新守卫 + `pi-model-capability` = 8 passing；缺口 1 `task-surface` = 9 passing，加定向回归共 103 passing；缺口 2 `main-skill` = 6 passing，加定向回归（含 `import-boundary`）= 80 passing。
  - 全量 `node_modules/.bin/vitest run`：基线 **65 文件/674 例** → gap3 **66/679** → gap1 **67/688** → gap2 **68/694**（只增不减，全绿）。
  - 反向绊线：每缺口 **≥3 类**，破坏→红→逐字节复原（md5 校验）——缺口 3：删接线 / 助手忽略 env / 缺省注入值；缺口 1：取消谎报 cancelled / resume 绕过 runner / task_status 信任参数身份 / 工具面不随 runner 收窄；缺口 2：缺省注入块 / 清单泄露路径 / `read_skill` 不随 registry 收窄。
  - **诚实降级登记**：缺口 3、缺口 1 为先红后绿；**缺口 2 为实现先行 + `git stash` 降级复现红**（非纯 TDD 先红），已在提交 message 与本条目如实登记。
- **read_skill 加回决定**：见 **§四十六**（本分支 `57ac5ee` 新增）——`read_skill` **仅用于评测臂、不进产品缺省**；引用 §八 历史证据（b1 `read_skill` 0/39 只证弱命题；b2 正文直塞 UX-04 0/2→2/2 正向对照）与本次重测计划（`npm run eval:user` 三臂对照、全样本保留）。
- **独立复核**：passed=true、integrity=false（缺口3/1/2 三处独立复核**均未判负**——对应「复核缺口修复」阶段从未触发；哲学合规终审对照 AGENTS.md 逐条**无违规**：新增行无 classifier/router/planner/event-bus/state-machine/embedding 命中，缺口1 scope 由服务端注入、参数不收 principalId/sessionId，缺口2/3 缺省逐字节不变。主会话已独立抽检 scope 来源 / 工具 schema / 禁止机制扫描 / 缺省门控，均相符）。
- **边界**：未接真实平台、零真实模型额度；未改冻结面（convergence-r1 的 criteria/cases/judge/runner/safety-gate、criteria.lock、exploration 冻结件）与历史证据。

---

## 四十八、业务 E2E · 缺口落地后三实验（#5 对话面任务工具 / #7 会话压缩 / #3 Skill 三臂）（2026-11-15，分支 `arch/r4-bizbatch2`）

- **状态**：**已合入**（`--no-ff` → `arch/integration` @ `f07e87c`，2026-11-15；合入后 typecheck=0、unit 74 文件/726 例全绿；产品代码零改动）。
- **授权**：owner 2026-11-15（缺口 1/2/3 合入 `4a12d8b` 后的三实验批；彻夜长跑）；预注册见 `docs/product/business-e2e-prereg-addendum.md` §五。
- **分支/基线**：worktree `~/projects/fshine-agent-r4-bizbatch2`，分支 `arch/r4-bizbatch2`；基线 = `arch/integration` 启动时 HEAD `7009ed04c770ec6ceab95d9df905333c6789a014`（`.runtime/bizbatch2/baseline.txt`，gitignored）。
- **提交链**（身份显式 `Tao <34084876+phona@users.noreply.github.com>`；均未 push / 未合并 / 未碰 main/tag）：
  1. `9e4b270` 三实验装配与自检（`scripts/eval/business-e2e/experiments/{model,cases,executor,judge,harness,run}.ts` + 中性测试 Skill 夹具 `scripts/eval/fixtures/dummy-platform/.agents/skills-main/{record-digest,value-note}/SKILL.md` + 预注册 §五 + `package.json` 加 `eval:bizbatch2`）——零产品代码改动。
  2. `f4709ec` 压缩触发点度量修正（转录摘要标记「此前会话摘要」，`pi-driver.ts:526`；原 `compactionRounds`（每回合 modelCalls>1）无效）。
  3. `12a8e39` 执行器缺省驱动施加 `contextWindowFrom`（#7 首跑无效的根因：装配核心只在**缺省驱动**分支展开窗口接线 `ask-runtime.ts:406-408`，而执行器总自带 `createDrivers`）。
  4. `d8da8ef` 执行器加会话墙钟兜底（`maxWallMsPerSession`）。
  5. `fa06cbb` 三臂装配自测（none/inline/catalog 提示块与 `read_skill` 工具面）。
  6. `080c756` 探测报告续写 §十二（三实验读数）。
- **实施概述（三实验）**：复用生产同源装配（`assembleSessionCore`/`resolveExecutionFace`/`createBackgroundDispatch`）+ 既有跑批/证据/冻结判据（`batch`/`collect`/`judge`/`wilson95`）。实验①#5 以 **inline 直接注入 TaskRunner** 受试（缺口 1 设计 §3.3 的合法装配；四工具与分派同源门控 `taskRunner`，`execution-runtime.ts:580-584/:596`；缺省 bizprobe/ask inline 路径**不注册**四工具）；实验②#7 经 `LLM_CONTEXT_WINDOW`（`ask-runtime.ts:135 contextWindowFrom`）；实验③#2 经 `mainSkillRoots`/`mainSkillMode`（`worker-skills.ts:52`）。
- **读数（真实模型 `step-3.7-flash`，显式覆盖 `.env` 缺省 `step-5-preview`；inline；一次采样、不重采样、全样本保留、不筛绿；k/N 附 Wilson 95% CI，不读作稳定概率）**：
  - **①#5**：T01 2/3[0.208,0.939]、T02 2/3[0.208,0.939]、T03 3/3[0.438,1.000]（`sessions:9, modelCallsTotal:61, wallMs:42318`）。机械不变量：越权=找不到（`unauthorized=0`，T03 3/3）、取消如实（0 虚假「已取消」）、无虚假完成、无重复执行。失败（2/9）主导根因为**产品接口缺陷——`ref` 编号格式**：工具描述示例为裸数字（`execution-runtime.ts:77-84` 等），`resolveTaskId` 只认字面 `#N`/完整 `taskId`（`:329`），inline 受理回执不含 `taskNo`（`:559`；仅 background 回 `#N`，`:516`）→ 14/14 定向 `ref` 用裸 `"1"` 全部失败、模型从未发出 `"#1"`。**登记产品缺陷（不修）**。
  - **②#7**：**预注册读数未取得**——两次完整尝试（run2/run3）均活锁、0 会话完成。机制确认：修好执行器接线后 `context_emergency_compact` 按配置窗口触发（run2 日志 `tokens:13751 contextWindow:12000 messages:11` / `21043@20000`）；病态：近窗口长会话出现 thinking-only 空回复（`pi_driver_empty_reply, stopReason:length`）+ 反复紧急压缩不降反升 → 事件循环阻塞式活锁（加墙钟兜底仍挂），手工 kill；run1 因执行器绕过窗口接线而**无效**（保留为 `compaction-run1-invalid`）。
  - **③#3**：none 0/6、inline 6/6、catalog 3/6（`sessions:18, modelCallsTotal:39, wallMs:68957`）；`read_skill` 命中 digest 3/3、note 0/3；臂 A 常驻提示 1312B vs 臂 B catalog 274B。配对：none→inline 改善；inline→catalog digest 经验证无实质变化、note 退化；none→catalog 依 base 分化。CI 重叠 ⇒ 方向一致但**统计证据不足**（N=3）。
- **自测与自检（零真实模型，`TMPDIR=~/.tmp`）**：`node_modules/.bin/tsc --noEmit` = **退出码 0**；全量 `vitest run` = **74 文件/725 例全绿**（基线 `arch/integration` 同 commit = 72 文件/711 例 → 纯新增 2 文件/14 测试，只增不减）；新增自测 `experiments/{fixtures,experiments}.test.ts` = 15 例全绿（含工具面门控、四工具全流程、越权=找不到、三臂装配、#7 小窗口确定性触发压缩、串并行一致性）；infra 门 `LLM_MODEL=step-3.7-flash` `--infra-gate` = **exit 0**（缺 `LLM_API_KEY` 时 `blocking=true`，不烧样本）。
- **独立复核**：未单独发起第三方复核；关键结论均以**已落盘证据**（`.runtime/bizbatch2/…`）+ 复跑命令自证（见报告 §十二）。
- **预算消耗**：本批真实模型会话 = #5 9 + #7（run1 6 无效 + run2/run3 各发起 4）≈14 + #3 18 ≈ **41**；累计 **95/150**（父 54 + 41），未超、未扩容。硬上限 `maxSessions=90 / maxModelCalls{72,240,108} / concurrency=4 ≤ 8 / maxWallMs=1.8e6` 均未超。
- **边界**：`packages/`、`apps/` 产品代码**零改动**（`git diff 7009ed0 HEAD --name-only | grep -cE '^(packages|apps)/'` = **0**）；不改冻结面与既有轮次读数（`business-e2e-probe-report.md` §一–§十一 原样保留，只**追加** §十二）；未接真实平台；`.env` 只读、不入证据/不提交；证据 `.runtime/bizbatch2/`（gitignored）。
- **登记（不修，待 owner 裁定）**：① 产品面 `ref` 编号格式不一致（描述示例 `"3"` vs `resolveTaskId` 要求 `#3`；inline 回执无 `#编号`）——建议统一契约（接受裸数字 / 回执回填 `#` / 列表带 `#` / 改示例）。② 产品面 #7 小窗口下 thinking-only 空回复 + 活锁不收敛（T7 类）——建议裁定是否属缺陷、是否改触发/降级策略。③ 测试面：执行器曾绕过窗口接线（`12a8e39` 已修）、会话墙钟兜底对阻塞式活锁无效（登记）。
- **待落地裁定**：三实验的判据调参（#5 T02 的 `granted` 放宽为 collection 级以消噪）、#7 改设计重跑（自然语料/更大窗口/换触发点）或以上述 `context_emergency_compact` 事件结案——**待 owner 裁定**，本批不擅自改。
- **回退**：`git revert 080c756 fa06cbb d8da8ef 12a8e39 f4709ec 9e4b270`（仅测试基建 + 夹具 + 文档 + `package.json` 一行脚本；产品代码零改动，回退安全）。

---

## 四十九、业务 E2E · 夜跑续批（bizbatch3：**#7 重设计** / **#6 深探** / 重复轮）（2026-11-15，分支 `arch/r4-bizbatch3`）

- **状态**：**已合入**（`--no-ff` → `arch/integration` @ `c0a426c`，2026-11-15；合入后 typecheck=0、unit 74 文件/731 例全绿；产品代码零改动）。**备注**：run 内复核判定 `passed=false`，**唯一原因是预注册检定项「#7 压缩确触发」未达成**（README 同款如实登记、非缺陷、非 integrityViolation）；其余三件事读数与证据齐备、复核逐条核过。仲裁者接受合入。
- **授权**：owner 2026-11-15（彻夜长跑续批）；预注册见 `docs/product/business-e2e-prereg-addendum.md` §六（**先于运行**写死）。
- **分支/基线**：worktree `~/projects/fshine-agent-r4-bizbatch3`，分支 `arch/r4-bizbatch3`；基线 = `arch/integration` 启动时 HEAD `a88f62328a1336c9242ba64b1e09c5a67138f9fa`（`.runtime/bizbatch3/baseline.txt`，gitignored）。
- **提交链**（身份显式 `Tao <34084876+phona@users.noreply.github.com>`；均未 push / 未合并 / 未碰 main/tag）：
  1. `00746ca` 三件事装配与自检（`experiments/natural-corpus.ts` + `cases.ts` 的 C03/C04 + 执行器 `AsyncLocalStorage` 驱动事件捕获 + `judge/harness` 压缩计数 + 预注册 §六 + `package.json` 加 `eval:bizbatch3`）——零产品代码改动。
  2. `e5cbc43` 驱动事件捕获补 `console.log`（`context_compacted` 走 log，`pi-driver.ts:543`）+ 自测钉住。
  3. `29bf2b7` 报告 §十三（三件事读数 + 三轴更新 + 预算）+ decision-log §四十九。
  （本条目提交见本条 commit）
- **实施概述**：三件事均走生产同源装配（`assembleSessionCore`/`resolveExecutionFace`/`createBackgroundDispatch`）与冻结判据（`judgeMechanical`/`judgeExp`）。①#7 以 `experiments/natural-corpus.ts` 的**真实感多轮对话**（41 轮 + 2 探针）替代 §四十八 的 `bulkFiller`；**两窗口对照** C03=12k / C04=6k，`withTaskRunner:true` 修正探针工具面；压缩触发以驱动事件 `context_emergency_compact`/`context_compacted` 为机械证据，执行器经 **AsyncLocalStorage** 归属样本（并发 4 不串台）。②#6 复用冻结用例 B06，`--trials 6`（运行期覆盖、不改套件 → 冻结锁不变）。③重复轮沿用 bizprobe 电池（第 4 轮）。
- **读数（真实模型 `step-3.7-flash`，显式覆盖 `.env` 缺省 `step-5-preview`；inline；并发 4；一次采样、不重采样、全样本保留、不筛绿；k/N 附 Wilson 95% CI，不读作稳定概率）**：
  - **①#7 重设计：未取得压缩读数**（**§6.2 预注册目标未达成**；检定项「**#7 压缩确触发**」**不成立**→ 本批**不能就 #7 判 passed**；已在报告/本节**如实登记、未掩盖、未筛绿**，故非 integrityViolation）。C03(12k) **0/3** [0.000,0.562] severe 2（modelCallsTotal 143 / wallMs 137357）；C04(6k) **0/3** [0.000,0.562] severe 0（132 / 27356）。两 case `compactTriggerEvents=0` / `compactionRounds=0` / `taskToolCalls=0`（探针未被调用→恢复断言无从检验）。**非活锁**（均墙钟内收敛，无手工 kill），但回复自中段起全空（`pi_driver_empty_reply, stopReason:length, contentBlocks:["thinking"]`；C03#1 自 turn24 起 20/43 空，C04#1 43/43 空）。**根因（代码）**：输出钳零线早于压缩阈值触发——钳零线按**全请求** `available = contextWindow − context − CONTEXT_SAFETY_TOKENS(4096)`（`pi-ai/dist/api/simple-options.js:3,:5-8`）；压缩阈值按**转录** `contextTokens > contextWindow − reserveTokens`（`pi-coding-agent/dist/core/compaction/compaction.js:160-164`，应用点 `agent-session.js:279/:1724` 与 `pi-driver.ts:490-492/:594-602`；reserve 缩放见 `pi-driver.ts:279-296`，W<36384 时 reserve=0.25W）；当 **W<16384**（reserve<4096）钳零线先到 → 回答预算先归零、压缩永不触发。**登记为强产品证据（不修）**。另有**语料诱导对象漂移 confound**（C03 执行 `contoso`/`fabrikam`/`contoso-logistics`/`contoso-trade@W99` → 2/3 severe），与压缩无关。
  - **②#6 深探（B06 × N=6）**：**4/6** [0.300,0.903]，机械判负 2、severe 0（modelCallsTotal 22 / wallMs 60205）。**`alpha→alpha-group` 近似集合名 severe 漂移 0/6 复现**；失败为**丢 window 的整集合查询**（B06#5、#6）+ 1 次重复执行（B06#6）。逐轮失败率均 ≈1/3，但失败类型每轮不同。
  - **③重复轮（第 4 轮 6 场景 × N=3）**：**18/18**（每场景 3/3 [0.438,1.000]）；机械不变量全 0、severe 0；`observedMaxConcurrency=4`、wallMs 44285、throughput 0.406/s。跨轮：轮2 17/18 → 轮3 15/18 → 轮4 18/18（N=3 仅探索，不读作稳定）。
- **自测与自检（零真实模型，`TMPDIR=~/.tmp`）**：`./node_modules/.bin/tsc --noEmit` = **0**；全量 `vitest run` = **731/731（74 文件）** ↔ 基线同 commit `a88f623` = **726/726（74 文件）**（纯新增 5 测试，**只增不减**）；新增/扩展自测覆盖**自然语料体量下界**、**压缩触发机械捕获**（合成 + 真实 `compact()` 日志）、**并发归属（ALS 不串台）**、infra 门两态；infra 门实跑：`experiments --infra-gate` = exit 0（缺 key = blocking exit 2）、`business-e2e --infra-gate`（B06×6 / 6×3）= exit 0、`verifyLock` 一致。
- **独立复核**：经一轮复核（gaps 见下），**不重跑样本**（重跑须整批新预注册、不重采样单点）。复核 4 项 gaps 逐条处置：①**#7 未达预注册目标**（6 样本 0 触发、`taskToolCalls=0`）——已在报告 §13.1/本节如实登记为强产品证据，并在报告 §13.1 明写**检定项不成立、不能判 passed**（不改判据、不改读数）；②**阈值引用精度**——已把阈值公式改引至 `pi-coding-agent/dist/core/compaction/compaction.js:160-164`（应用点 `agent-session.js:279/:1724`、`pi-driver.ts:490-492/:594-602`），`pi-driver.ts:279-296` 仅作 reserve 缩放；③**证据完整性**——`work/C04#1/state/audit.jsonl` 缺失与其「无执行查询」一致（runDir 证据齐备、`tool-calls.json` 全在），已在报告 §13.6 登记；④**账本**——「已耗 ≈95」沿用 §12.6 表、未逐步独立复算，已在报告 §13.5 登记口径。关键结论均以**已落盘证据**（`.runtime/bizbatch3/…`）+ 复跑命令自证（见报告 §十三）。
- **预算消耗**：本批真实模型会话 = #7 6 + #6 6 + 重复轮 18 = **30**（≤45）；累计 ≈95+30 = **125/150**，未超、未扩容。硬上限均未超（`experiments`：maxSessions 45 / maxModelCalls compaction 600（实 143+132）/ wall 1.8e6 / concurrency 4；`bizprobe`：maxSessions 20 / maxModelCalls 150（实 22/40））。
- **边界**：`packages/`、`apps/` 产品代码**零改动**（`git diff --name-only -- packages apps` = 0）；不改冻结面与既有轮次读数（报告 §一–§十二 原样保留，只**追加** §十三）；未接真实平台；`.env` 只读复制、不入证据/不提交；证据 `.runtime/bizbatch3/`（gitignored：`compaction-c03`/`compaction-c04`/`drift-b06`/`repeat-r4`）。
- **登记（不修，待 owner 裁定）**：① 产品面 **#7 输出钳零线 vs 压缩阈值错序（W<16384）**——建议裁定调 `CONTEXT_SAFETY_TOKENS` / 压缩 reserve / 或禁用小窗口；② 产品面 **#5 `ref` 契约缺陷**（同 §四十八）——本批**排除 #5**、不重跑；③ **#6 整集合/重复查询漂移**——先观测（N 再增大）。
- **待落地裁定**：#7 要在 W≥16384 取压缩读数，需**远长于本批**的自然语料（本语料 ≈124 token/轮，达 16k 阈值需 ~100+ 轮）或换触发策略——**待 owner 裁定**，本批不擅自改。
- **回退**：本批仅测试基建 + 语料/夹具 + 文档 + `package.json` 一行脚本，产品代码零改动，回退安全。

---

### 17.6 E05 判据 v2：澄清优先（owner 2026-11-25 批准；§17.1 第 5 条的后继裁定）

- **触发**：§17.1 第 5 条明写「若未来裁定变更（如允许候选枚举或**澄清优先**），必须新增判据版本并保留 v1 可对照」。本次正是「澄清优先」，故按该条立 v2，**不是就地改写 v1**。
- **背景证据**：
  - §17.1 的 2026-11-13 复采样已记：agent.md 对齐后 E05 ×9 = **5/9 PASS**，4 次仍零执行先澄清——「模型方差」；且当时的根因诊断就是「技能仅作用于 Worker，管不到 Main 的决策点」。
  - 2026-11-25 独立复测（step-3.7-flash，8 轮/臂）：干净 HEAD **2/8 红（25%）**；宿主协议文本（`MAIN_PROTOCOL_NOTE`）3/16 红（19%）；**Main 侧 Skill**（`.agents/skills/object-name-resolution`）2/8 红（25%）——三种放法均在噪声内，且失败形态在「不问执行层先问用户」与「问了执行层但把候选也查了」之间搬移，总数不减。结论：提示词压不住，是行为张力而非措辞问题。
  - 架构事实：模型**无法避免猜接口**（`dummy.query` 收 collection / `ballot.query` 收 topic）；夹具用 `source.keys` + `anyOf` 把「集合还是主题」这类歧义吃掉，但「哪类业务操作」仍要模型选。接口不确定时问用户「你查哪方面数据」是正当的**接口消歧**，与「让用户背集合名」是两件不同的事。
- **裁定（判据 v2，`CRITERIA_VERSION = convergence-r1.criteria.2`）**：
  1. **不再判「未委派」**：E05 `execPolicy` / `delegation` 降为 `optional` / `allowed`，撤 `minExecutions` 与 `requiredRowCollections`。正解（委派 → 平台回 `needs_input` + candidates → 问用户一次）与合法路径（不委派、问用户消歧接口）**都算通过**。
  2. **硬线①（保留）**：用户确认前查询候选对象仍判 `FAIL_WRONG_OBJECT`（`allowedCollections:['contoso']`）。那是越权猜对象，且具备「枚举候选把执行层打爆」的形态（2026-11-20 宽口径枚举拉爆下游 + 触发平台风控的事故先例）。
  3. **硬线②（新增，堵逃逸口）**：零执行且未检测到澄清提问 → `FAIL_MISSING_CLARIFICATION`。没有这条，「contoso 目前没有可展示的记录」这类**既不问执行层也不问用户的断言性答复**会判 PASS——即「零作为假装有结论」。`clarification:'expected'` 在零执行时从弱告警升为硬失败；有执行的用例不受影响。
  4. **检查点改条件式**：`contoso → needs_input + candidates` 检查点恢复，但只在**有执行行**时校验（查了 contoso 就必须有候选载荷，缺载荷回落 `INCONCLUSIVE` 不得判正）；零执行时让位给硬线②。
  5. **不 landing 提示词修法**：实验性 Main 侧 Skill 已删（实测无可靠改善，不 landing 无效果品的提示词）。
- **v1 可对照**：v1 用例/判据经 git 父提交与各 run-dir 内冻结的 `criteria/cases` 副本留存（v1 `casesSha256 = fa239fff…`，记录于 `criteria.ts` 版本变更史）。
- **守卫（固化，非声称）**：`scripts/eval/convergence-r1/selftest.ts` 新增四包——`e05-v2-happy`（正解 PASS）、`e05-v2-ask-user-first`（合法路径 PASS）、`e05-v2-zero-exec-no-question`（逃逸口 FAIL_MISSING_CLARIFICATION）、`e05-v2-query-candidate`（硬线 FAIL_WRONG_OBJECT）。反向绊线即四包本身：任一判定分支被改坏，对应包转红。
- **产品定义成文**：`docs/architecture/capability-boundary.md` §1.1（对象归执行层解析 / 接口归 Agent 选 / 硬线两条 / 可接受方差登记不判负），§7 约束—守卫表补两行（硬线=已有守卫且已固化；行为方差=不设守卫、登记项）。
- **触发本条的外部审查**：PR #82 grok 审查 blocking——「就地放宽后零执行且无提问的断言性答复判 PASS；委派了但缺 candidates 时 INCONCLUSIVE 变 PASS；§17.1 要求立新版本却就地改写；weakNotes 自相矛盾；§7 的反向验证声称无守卫」。五条均已处置。
