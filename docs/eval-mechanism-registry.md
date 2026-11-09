# eval 机制登记表（harness 仪器清单）

本表把 harness 里**现有每个机制**登一行：防什么故障形态、拆了会怎样（可观测变化）、成本。
判据（2026-11-08 切片 C 落地时立）：**答不出前两列的机制砍掉或标注待验证**——登记不是背书，
是把"拆掉之前先知道会失去什么"变成可核对的文字。

位置一律用符号名 + 文件，不用行号（行号对插行免疫性为零，`docs/architecture-laws.md` §4 纪律）。

## 总表

| # | 机制 | 位置 | 防什么故障形态 | 拆了会怎样（可观测变化） | 成本 |
|---|---|---|---|---|---|
| 1 | 正则 lint（7 个纯文本 note 生成器） | `scripts/probe-real-agent.ts`：`execLanguageLeakNotes` / `clarificationShapeNotes` / `recallFramingNote` / `selectionNote` / `accountDrift` / `explorationDomainNote` / `platformSourceNote`；归维表 `scripts/eval/dims.ts` | 回复**形态**故障：执行语言指纹上屏（脚本路径/错误码/JSON/operation 名/内部控制词）、歧义只列候选不问或只问不列、not_found 不给结论、复述旧结果缺框定语、澄清后选错对象、把用户没问的 collection 当成本轮结果、把非平台知识挂平台来源 | 这七类形态从"每次跑都报"变成"只在大面积回归时被人眼发现"：探针报告里对应 note 归零，`dims.ts` 四维计数整体下滑（假绿），`dims.test.ts` 的 30 条原句表征锁同时红（note 文案失配）——红的是锁不是机制，机制本身无声消失 | 每轮回复多扫 7 组正则；7 组词表的双语化维护（漏一种语言形态 = 该语言下假阴性，实测已补 EN_PLEASANTRY / 内部控制词英文形 / 问句英文形三处） |
| 2 | 溯源性 + 算术（`amountNote` + `amount-criteria`） | `scripts/probe-real-agent.ts:amountNote`（内部即 `amountViolations`）；纯核 `scripts/eval/amount-criteria.ts`（`extractAmounts` / `classifyErrorStateAmounts` / `isVerifiedTotal` / `isVerifiedArithmetic` / `MISSING_CALIBERS`）；表征锁 `scripts/eval/amount-criteria.test.ts`（77 例） | 数字**没有来源**或**算不出来**：零执行轮次出现金额、跨线程串台、召回不一致、把平台没有的口径（payable/bank/debt）当答案口径、部分和冒充总额、差额复用同一加数、编造基准 | 全部金额类缺陷只剩第 1 层形态尺 + 第 4 层期望值：B1 的 2000 型"每轮各自有据但轮间不一致"、Y2 的 payable 口径、C2 的跨线程串台都会漏（期望值层只覆盖声明了期望的用例，未声明用例裸奔）；`amount-criteria.test.ts` 77 例里 40+ 条 blocking 反例同时红 | 每轮回复跑一遍金额提取 + 逐分句实体绑定 + 两级算术验证；判据本身的校准成本高（2026-09-29 起五次标定，词表与豁免边界都留了决策记录） |
| 3 | 审计行为核对（执行层审计行） | `scripts/probe-real-agent.ts` 的 `turn.calls` / `turn.refusedCalls`（取数口 `scripts/eval/evidence.ts:readExecutionAuditLog`，`EXECUTION_AUDIT_PATH`）；`errorStateNotes` 的同参风暴分组、`writeAttemptNotes` 的已执行写调用、Z1 的总量红线 | 行为面故障：声称查了其实零调用（复述谎称实查）、同参重试风暴拉爆平台、写未确认就落账、被门拒的调用被当成已执行 | "真查了吗"从此不可判：B1 的"5 轮只产生 N 次调用"、每轮零调用 note、风暴/越门写三条硬尺全消失，只剩模型自述；报告里 `platformCalls` 数字还在但没有任何判定消费它 | 每轮多读一次审计文件 + 窗口切片；被拒行单列 `refusedCalls` 后"调用了"与"被拒+原因"要分开维护（换源决策记录在 evidence.ts 头） |
| 4 | **期望值层（新，切片 C）** | `scripts/eval/expectations.ts`（四类断言 + 三个过程不变量 + 判据词表自检）；声明在 `scripts/eval/cases.yaml:expectations`；接线 `scripts/eval/score.ts:evaluateProbeCase` / `evaluateWriteChainCase`；回归锁 `scripts/eval/expectations.test.ts`（21 例） | "数字有据但**对不上这个用例的期望**"：同查询连发轮间口径不一致（B1 第 1/5 轮多报 2000）、错误轮把平台没有的口径答出数（Y2 payable=1000）、旧 collection 渗入（A2 第二轮带 alpha）、召回某线程时报出别的线程的值、总结轮塌缩或出现外来金额、确认前落账、同参风暴、大额行张冠李戴 | 回到"基线上限 1 一律放过"的状态：上述三条已发生缺陷重新变成只留 note 的通过项（`expectations.test.ts` 里三条 `现状（无期望值层）……放过` 断言会红——那正是本层存在的理由）；`score.ts` 的 `CaseVerdict.checks` 少一组 `期望·*` | 每个用例要在 yaml 里写期望值（本次只给审计过的 11 条写全，11 条占位不猜）；期望值与判据是两份数据，改判据要同步核期望；**不进任何 prompt**（纪律见 expectations.ts 头）；调用数族在取数面不载 calls 时不出判定（无证据不造零——2026-11-08 修过把缺席当零导致的永久假红）；判据词表自检（`expectationSelfCheck`）由测试钉住，词表清空即红 |
| 5 | **状态阶梯（新，切片 D）** | `scripts/eval/evidence.ts:classifyExecutionCall` / `messageLadderRung` / `aggregateMetrics` / `collectHostFacts` / `collectIntentFacts`；报告 `scripts/eval/report.ts`（JSON + JSONL 两份面）；探针接线 `scripts/probe-real-agent.ts:boot` 的 `send` 与 `main`；回归锁 `scripts/eval/evidence.test.ts`（17 例） | "调用到底成没成"被模型自述代言：平台说 completed 但宿主没读回、handler 返了一句诚实的失败被当成调用成功、审计行缺失被当成零调用 | 每条调用退化成"有/无审计行"的布尔：`verified`（写后读回）与 `delivered`（用户可见）两档消失，无证据时按"成功"计；统一报告 `.runtime/eval-report-*.json/jsonl` 与最小聚合指标（通过率/干预/安全违规/耗时/Token）不再产出，跨 run 只能比对探针报告的 notes 文本 | 每轮多查一次宿主库（requestId → tool_calls / task_runs）与一次 change_intents 只读旁路；报告体量随调用数线性增长（一行一次调用） |
| 6 | LLM 评委 | `scripts/eval/judge.ts` + `judge-prompt.md`（版本 = 内容 sha256 前 8 位）；接线 `scripts/eval/score.ts --judge` | 机械尺覆盖不到的**翻译质量**：把失败说成别的原因、补救不可行动、复述缺框定语的语感问题、呈现冗长 | 四维里"读起来可不可信"这一面没有独立证据（机械分量管有据/实体/诚实/卫生的形态，不管措辞质量）；`scores.jsonl` 的评委轨迹消失，基线里 24 个评委维检查整体缺席 | 每用例一次 LLM 调用（temperature 0）；**方差**——同一转录两次评委一致（A2 卫生两轮都给 0 已实证），但换模型即换基线（三元组纪律）；评委只看转录不读审计/机械分量，与机械分量互不锚定（这是设计也是成本：它抓不到机械面缺陷） |
| 7 | 五个静态守卫 | `packages/agent/exposure-lint.test.ts`（现行树四类敏感串零命中 + 假绿自校验）、`history-hygiene.test.ts`（HG1，全 ref 历史四类 + 锚点）、`platform-leak-lint.test.ts`（编排层业务词预算）、`docs-reality.test.ts`（文档主张 ↔ 代码现实对账）、`architecture-shape.test.ts`（import 环 + runtime.ts 行数棘轮） | 非 eval 面的结构/泄露/文档漂移：真实客户名/读数/UserID/内部路径进树或进历史、编排层复制业务词、文档宣称的机制已不存在、模块间循环 import、runtime.ts 无限膨胀 | 各自的面从"每次 push 都查"退化成"靠 review 发现"：exposure-lint 拆了 = 脱敏波的成果没有防复发判据（新 commit 带真实客户名静默合入）；HG1 拆了 = 历史面失守；platform-leak-lint 拆了 = 编排层重新长出生义词；docs-reality 拆了 = 文档可以宣称不存在的东西；architecture-shape 拆了 = 环与行数回潮无感 | 33 个用例合计约 1.5s（实测 5 文件 33 passed / 1.46s）；HG1 要全量历史（浅克隆显式 skip，CI 配 `fetch-depth: 0`）；exposure-lint 的禁词表拆段持有 + sha256 自校验，收词只增不减 |
| 8 | CI 三门（+ 一个计数器） | `scripts/ci.sh`：`npm run typecheck` → `npm run test -- --project unit` → `npm run eval:generic-mock` → `node --import tsx scripts/eval/count-a2a-fallback.ts --threshold 20` | 确定性回归：类型错误、单测失败、generic-mock 协议/基线回退；计数器防 a2a fallback 静默增殖 | 每次 push 只剩 GitHub 的默认检查：类型/单测/protocol 三层里任意一层回潮都要等 nightly 或人工；`count-a2a-fallback` 拆了 = 兜底路径用量超过 20 无信号（D-150 登记的已知边界也不再可见） | 全量约 1–2 分钟（unit 全量 78 文件 / 987 用例量级）；真实模型 eval **刻意不在 CI**（成本 + 密钥 + 评委方差三条理由见 ci.sh 头注释），那一面走 `.github/workflows/eval-real.yml` 与手动 |
| 9 | generic-mock（确定性 eval） | `scripts/eval/generic-mock.ts` + `generic-mock-baseline.json` + `GENERIC_MOCK_NOTES.md`；24 用例 / 85 检查（实测 `npm run eval:generic-mock`：24 cases pass, 0 skipped） | 执行层**协议面**与宿主纯决策：envelope v1 形状、exit code、not_found / needs_input / WINDOW_NO_DATA 信封、提案 pending→commit→读回→二次 commit 拒绝不双计、计划门预算分档、越权/未登记形态拒绝、状态隔离、step cap 边界、handover 往返、tampered summary 门、committed_unverified 分类 | 协议面的确定性回归全没了：夹具改一处信封字段，探针/验收要跑真模型才看得见（贵且慢）；generic-mock 基线里 85 个 `pass` 记录变成无主，`g-*` 用例与探针的溢价对照（`mockOverlap` 字段的依据）失去锚点 | 每次约数秒（spawn 夹具 CLI）；无模型无评委，所以**证明不了模型行为**（GENERIC_MOCK_NOTES.md 明写：scripted reviewer 拦住 tamper 不证明真模型拦得住） |

## 三层 + 第四层的分工（为什么期望值层不能省）

前三层回答的是三个不同的问题，**互相不能替代**：

| 层 | 回答的问题 | 判据 | 已发生的漏网例 |
|---|---|---|---|
| ① 正则 lint | 回复的**形态**对不对（指纹/问句/结论/框定/漂移） | 词表 + 正则 | A2 的 alpha 渗入抓到了，但基线 cap 1 让它过 |
| ② 溯源性 + 算术 | 数字**有没有来源**、算不算得出来 | 会话真实结果 + 算术验证 | B1 的 2000：每轮各自有据，②层全绿 |
| ③ 审计行为核对 | **有没有真委派**、有没有风暴/越门 | 执行层审计行 | 抓不到"委派对了但报错了数" |
| ④ 期望值层（新） | 报的数**对不对得上这个用例的期望** | `cases.yaml:expectations` | —— 本层要抓的正是上面三行的漏网例 |

三条已发生缺陷的完整证据链在 `scripts/eval/expectations.test.ts`：每条都同时断言
「旧三层放过（基线 cap 1 + okMode free）」与「新层硬失败」，并附干净形态不红的正控制。

## 审计结论核对记录（审计结果不是事实，逐条核过）

| 审计说法 | 核对结果 | 证据 |
|---|---|---|
| exposure-lint 的自校验拆不掉 | **成立** | 守卫头注释 F3 变异表 ④a/④b：stub `git ls-files` 返空、`git rm --cached` 真删锚点文件，两次都是范围自校验红而四类断言仍全绿——抓住假绿的是自校验；本次实跑 `npx vitest run --project unit packages/agent/exposure-lint.test.ts` → 7 passed |
| HG1 只看可达历史（悬空 commit 是覆盖洞） | **成立，且守卫自己没写这条边界** | 机制实测：临时仓里用 `git commit-tree` 造一个无 ref 引用的 commit，`git log --all -p \| grep -c <串>` = 0、`git rev-list --all \| grep -c` = 0（`--all` = 全部 ref，悬空 commit 不在内）；`history-hygiene.test.ts` 的扫描口是 `git log --all -p` 与 `git rev-list --count --all`，文件头未把"只看可达历史"写成已知边界 |
| 评委 21/28 个维检查有真实门限而 7 个恒过 | **数字对不上，按实测改写** | 从 `scripts/eval/baseline.json` 逐项算（容差 1，阈值 = 基线 − 容差）：6 个 probe 用例 × 4 维 = **24** 个评委维检查，其中**20** 个阈值 ≥1（真实门限）、**4** 个恒过（A2/A4/B1 的 presentationHygiene 基线 0 → 阈值 −1；A3 的 presentationHygiene 基线 1 → 阈值 0）。审计的 21/28/7 与文件不符，本表以实测为准 |
| 探针 CASES 实际只有 A1–A4、无 A5 | **已不成立（2026-11-09 十八审 minor 同步）** | A5 已恢复：`cases.yaml` 现 25 条（24 probe + 1 acceptance）含 A5，且 `inBaseline: true`、`baseline.json` 有 `probe-A5` 项。`loadProbeCases` 对 yaml/判定体双向核对，多一条少一条都抛错 |
| generic-mock 与探针 A1–A5 1:1 同名 | **成立（2026-11-09 同步）** | `generic-mock.ts` 的 `g-a1-requery` / `g-a2-cross-contamination` / `g-a3-ambiguity-mechanical` / `g-a4-not-found-zero-leak` / `g-a5-idle-zero-calls` / `g-b1-stability` / `g-y2-error-honesty` 七个用例**都有**探针对应轮（A5 已恢复），1:1 说法与文件相符 |

## 审计留账（切片 C 审计结果点名、本轮**没有**修的洞）

登记理由：审计结论不是事实，但也不因为"没修"就消失。每条写明现状与归属，切片 E 接手时从这里开始核。

| 审计点名 | 现状（本轮落地后） | 为什么没修 / 归属 |
|---|---|---|
| X1 第 1 轮 `tasks [A,B,C,D]` 的 C 槽位实际查 contoso-trade，而 `threads.C = contoso-logistics` | 标签原样保留（语料保真）；tasks 当前无消费方（判定体不建 scriptOf、期望值层只读 threads/recalls），所以不红 | 改字母表是语料语义决策，属切片 E；已记 debt-ledger D-201 |
| X1 第 7 轮写尝试轮 `tasks []` | 原样保留。空标签按约定只用于"闲聊/汇总/目标未明的探索轮"（probe-real-agent.ts 的约定注释），写尝试轮不属三类 | 同上；该轮金额判定已由判定体对 WRITE 轮 continue 跳过，暂无假红 |
| Y2 第 3 轮 `tasks [B]` 按 C1/E1/H1 旧字母表（B=beta）标注，C2 表里 B=contoso-trade | 原样保留。今天不红（Y2 判定体取 `m.clarify ?? []`，tasks 一个字不读） | 同一字母在两套表之间漂移：Y2 补 threads/recalls 前必须先核，否则允许池按 contoso-trade 真值取 |
| C2 30 条 tasks 只靠私有字母表可解读，仓库没有机器可读的 线程→collection 表 | `realAmounts` 只做字母相交：任何一轮标错，受影响的是**别的轮**的允许池（跨线程隔离断言静默换池） | 机器可读线程表属语料基础设施，切片 E |
| A2 判定体 `turns[1].reply.includes('alpha')` 是裸子串 | alpha-group / alphabetical 会假红；大小写、全角不管 | 判定核心（note 生成器/判定体）本轮按纪律不改；精确版已在期望值层（`mentioned()` 的 `alpha(?!-)`） |
| D1「无数据的 window 要诚实收边，不是编一个数」没有机械判据 | `beta W2 编一个 500` 抓不到——500 本就在 requireValues 里，出现了反而算过 | 审计结论：该面在现有判据形状下不可判（没有 forbidValues 于 window 维度）；记录而不造判据 |
| X1 索引型期望值与运行形态脱钩 | 第 4 轮未走澄清形态（clarified=false）时轮序平移：`writeAttemptZeroExecutedWrites: 6` 会查到总结轮（通常零写 → 假过），`summary.turn: 7` 越界 → 收敛断言整条消失（D-071） | 需要"按形态重排轮次"的取数层改造，属切片 E；acceptance 侧的同类错位本轮已修（稀疏落位） |
| 「条数 N」判据是数字出现正则 | 回复里任何独立的 N 即算报出条数（"2 个候选""第 2 步"都能过），条数语义不可判 | 需要结构化取数（记录条数 vs 文本数字），超出正则层能力 |
| write-chain-51 的 5.4「复用码被拒且不双计」没有机械判据 | expectations 只声明 index 0/2/3；`npm run eval:acceptance` 固定 `--only=5.1,5.1b,5.2,5.3`，默认链里 5.4 根本不跑；generic-mock 也没有 PROPOSAL_NOT_PENDING 用例 | 需 acceptance 默认链扩到 5.4 + 夹具拒绝面进 generic-mock，两处都超出本轮 |
| 确认码提取是中文死正则 `/确认\s*([A-Z0-9]{6})/` | 5.1 回复若用英文（"please confirm A1B2C3"）或不用"确认"二字，5.2/5.4 直接走跳过分支，整条写链断且记为跳过而非失败 | 与 write-chain.ts / acceptance.ts 同一把尺，改它=改写链取数口径，属单独议题 |
| `sameValueSetAs` 只比金额数值集合，不比 item 身份/顺序 | 两轮都报 1200 但 item 名张冠李戴，判不出 | 需要 item 级取数，超出文本层 |
| X1 跨线程隔离在期望值层是空的 | `recalls` 只有一条 `{turn:2, thread:A, requireValues:[1200,800], forbidThreads:[]}`，`isolationChecks` 对空 forbidThreads 直接 continue——"召回 A 不得带进 B/C/D 的值"在 X1 上没有活的判据（C2 有，X1 没有） | 审计结论：X1 的隔离断言本身就是空转。补 forbidThreads 前必须先核 D-201 的标签问题，否则按错池隔离 |

## 待验证 / 未覆盖（登记，不装作已覆盖）

- **期望值层的覆盖面**：期望值现已覆盖 15 个用例（A1/A2/A3/A4/A5/B1/B2/C2/D1/D2/F1/X1/Y1/Y2 + write-chain-51；2026-11-09 切片 E 补入 B2/F1/Y1）；未覆盖的 10 个（Q5b/Q13b/C1/E1/G1/G2/H1/H2/X2/Z1）仍是占位条目，`expectations: null`——它们在第四层上裸奔，靠前三层护（Q5b/Q13b 另卡 tax-summary 能力未落地、机械断言在 dummy 夹具上执行不了，与其余八条的「未审计」不同，见各自 blocker）。
- **acceptance 侧期望值只覆盖文本面**：`evaluateWriteChainCase` 从验收报告的 `records` 取回复文本，`calls`/`execution` 审计面 acceptance 报告不载，因此调用数族（`minExecutedCalls` / `requeryPerTurn` / `chitchatZeroCalls`）与依赖审计行的过程不变量（门禁时序/无风暴/写尝试零写）在 acceptance 侧都不出检查——没有证据不出判定（不造零也不造成功）。2026-11-08 修过一个反向缺陷：调用数族原先把"calls 缺席"当零，一份全合规的 write-chain-51 只因「期望·调用数(第1轮)」永远红（实测 + `expectations.test.ts` 的变异锁钉住）。「5.1 真调用了平台」在 acceptance 侧由 write-chain 三指标（提案尝试 ≥1）承载。
- **acceptance 侧 turns 按 yaml 下标稀疏落位**：中间某条记录缺席（`--only` 子集、该轮没跑起来）时，后续轮次不再向前错位——错位会让「第 N 轮」的期望值判到另一轮回复上，是比缺判更坏的假信号（D-097 实测报告只有 5.1/5.2 两条记录时踩过）。缺席轮本身不出判定（短用例缺轮会红「没有回复」）。
- **yaml ↔ 判定体的负路径没有单测**：`loadProbeCases` 的双向 fail-fast（yaml 有 id 无判定体 / 判定体有 id 无 yaml）本次只跑了正路径（`--only A1` 走到安全门拒绝），没有用例钉"故意不匹配就抛错"。
- **探针报告新增字段没有兼容旧报告的守卫**：`score.ts` 的旧格式守卫只查 `dims` 缺缺失。`calls` 缺列已被期望值层按"无证据"处理（不出判定，不再造零假红）；`execution` 缺列仍按"空审计窗口"处理——门禁时序/无风暴/大额行归属可能假阴性。下一轮补一条格式断言（旧报告显式拒绝，而不是逐字段猜）。
- **`npm run typecheck` 已覆盖 `scripts/`**（2026-11-09 七审 minor 同步）：`tsconfig.json` 的 include 现已含 `scripts/**`（eval 域移植那轮补的），脚本面的类型错误走同一条 `npm run typecheck`，不再需要临时 tsconfig。本条原先是「不覆盖 scripts/」的现状描述，随 include 变更一并更正——留着旧描述会让后续维护者继续用临时配置去核，白做一遍。
