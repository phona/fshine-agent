# R3 Exploration Suite v0 批次报告（E05 相邻场景）

> 范围：R3 探索套件——`scripts/eval/exploration/`（开发套件 `e05-adjacent` X01–X08）与最小加载接缝
> （`convergence-r1/runner.ts` 的 `--suite`）；基线执行 + 口径修复 + 复核封存后的批次收口。
> 基线：arch/integration @ 98b1809；本批分支 arch/r3-explore（worktree 另建，未 push/未合并）。
> 纪律：R1 冻结集（criteria.ts / cases/** / judge.ts / criteria.lock）与 36 次原始证据零改动；
> 产品 Runtime（packages/**、apps/**）零改动；新增机制只在 Eval 基础设施与 exploration 目录。
> 数字口径：本报告只使用 (a) 本批实跑证据（`.runtime/exploration*`）、(b) 仓库文件重算事实、
> (c) 独立复核材料（复核会话产出的 arch/r3-explore 复核结论与 holdout 封存）。凡未实跑项均显式标注。

## 0. 摘要

- **接缝**：`runner.ts` 新增 `--suite <dir>`（缺省完全不进入该分支）；装配 / Dummy / T0–T3 证据 /
  判定器 / 隔离全部复用，套件只提供数据面（cases/lock/out）。R1 默认路径输出与 criteria.lock 校验未变
  （离线哈希 + 实跑 E01 双证）。
- **用例**：新增 8 条开发用例（X01–X08，purpose=exploration）、11 条被拒候选、7 条待裁定语义；
  holdout 4 条（H01–H04）由独立复核员生成并封存（未运行）。
- **基线（step-3.7-flash，1 trial/例）**：冻结 A 8 例 = **5 PASS / 3 FAIL / 0 INCONCLUSIVE**；
  X06 的 FAIL 归因于锚点词表缺口（口径缺陷，非模型行为）→ 修复 + 重切冻结 B + 复跑 **PASS**，
  原样本原样保留。X03（零委派先澄清）、X05（选择后上下文丢失）为真实行为发现。
- **R1 对照**：R1 冻结文件 diff=0（除 runner.ts 接缝）；R1 criteria/cases 哈希与 lock 一致；
  E01 默认路径回归 PASS；独立复核的 36 次原始证据离线复判 36/36 复现、31/5 汇总复现。

---

## 1. 新发现的能力覆盖缺口（对照 Golden Set 与已知失败）

「Golden Set」本报告指 R1 冻结 E01–E12（36 次存证 + R2 复采样口径）；「已知失败」指 R1/R2 报告的
E05×3、E07-3、E08-1、E04-3 等登记样本。

### 1.1 覆盖缺口（此前完全没有覆盖、本批补上）

| # | 边界 | 此前状态 | 本批覆盖 | 首跑读数 |
| --- | --- | --- | --- | --- |
| C-1 | 空集合（存在但零条目，completed/count=0/items=[]） | 无（E07 窗口无数据、E08 集合不存在，缺第三种） | X01 | PASS（`.runtime/exploration/runs/X01/trial-1/`） |
| C-2 | 候选清单 → 用户选择 → 正确成员 → 数据（E05 只到候选返回） | 无 | X04 | PASS |
| C-3 | 选择轮之后的对象延续 + 窗口落空（WINDOW_NO_DATA in multi-turn） | 无（E04 窗口切换有数据；E07 单轮越界） | X05 | FAIL（真实行为缺口，见 1.2 G-2） |
| C-4 | 混合结果转述（同一请求内 alpha 成功 + zeta 不存在） | 无（E03 都成功、E08 单对象） | X06 | 首跑口径 FAIL → 修复后 PASS（见 1.3 J-4） |
| C-5 | 多步请求中混入歧义（beta + contoso，不替用户猜候选） | 无（E03 + E05 各单态） | X07 | PASS |
| C-6 | 锁定集合只读正常（拒绝的过度泛化） | 无（E10 只有 denied 拒绝一边） | X02 | PASS |
| C-7 | 意图缺失（对象已给、动作未定）的只读面安全 | 无（E06 缺对象、E11 明确写请求） | X08 | PASS（零执行、无写尝试） |
| C-8 | 单命中子串解析（不完整但唯一可解析的标识） | 无（E05 多命中歧义） | X03 | FAIL（行为发现 + 待裁定，见 1.2 G-1） |

### 1.2 新发现的行为缺口（模型侧）

**G-1 非精确可解析标识 → 零委派先澄清（X03）。**
证据：`.runtime/exploration/runs/X03/trial-1/`——`taskIds=0`、`audit.jsonl` 0 行、toolcalls 空；
回复逐字「"logistics"是指哪个数据源？…请您补充一下这些信息，我马上帮您查。」
判负：`FAIL_NO_DELEGATION, FAIL_ZERO_EXECUTION, FAIL_WRONG_OBJECT, FAIL_STATE_INCONSISTENCY`。
对照已知失败：与 E05 未对齐前（0/9 零执行先澄清）同族；R2 §17.1 对齐后 E05=5/9，但本次该对齐
未泛化到「部分名/子串」形态。**限定**：该用例的期望（把用户原词交执行层裁决）属 R2 §17.1 的
延伸解读，属待裁定 1；因此本条只登记为候选缺口，不作模型能力定论。

**G-2 多轮上下文对「选择轮引入的对象」不延续（X05 t3）。**
证据：`.runtime/exploration/runs/X05/trial-1/`——t1 `contoso → needs_input`、t2 `contoso-logistics → completed(450)`
均正确；t3 已委派（该轮 taskIds=1，三轮合计 3）但结构化执行 0 行，回复反问「请确认您要查询的是以下哪一个集合中的 W2 数据：
1. alpha 2. contoso-trade（会话外集合）」。判负：`FAIL_MISSING_EXECUTION_FACTS, FAIL_NEEDLESS_CLARIFICATION,
FAIL_ZERO_EXECUTION, FAIL_STATE_INCONSISTENCY`。
对照已知失败：E04 多轮承接（窗口切换）在 R2 为 12/12 稳定；本批揭示另一类多轮引用——对象身份来自
「候选选择」而非首轮原文——在该条件下承接断裂。

**G-3 空集合/锁定只读/混合歧义/意图缺失未见新缺口（覆盖读数为 P）。**
X01/X02/X07/X08 在冻结 A 下 PASS（执行事实见 §3.1）；X01/X02 的回复未引用技能文档数值
（E07-3 的「文档数值冒充查询结果」风险未复现），X01/X02 均真实委派（E08-1 的零委派未复现）。
单 trial 只作频率不作稳定性结论。

### 1.3 判定面/口径缺口（工程侧，含复核发现）

- **J-1 同集合多轮状态不可分**：冻结判定器 checkpoints 按集合名首次匹配（judge.ts:509-512），
  同一集合第二轮的不同状态（X05 t3 的 not_found）不能作为独立 checkpoint 核对；本批以
  perTurn 参数条件 + 轮锚点 + 离线 T0 复核替代（登记，不修改判定器）。
- **J-2 写面零容忍只对 E11 生效**（judge.ts:464-471）：新 id 的写尝试只落 `mode=call/refused`
  审计行与 worker 转录，judgment 不消费（X08 的写尝试不可判；本次 X08 实测零写尝试）。
- **J-3 候选措辞与表达质量只作弱判**；LLM judge 不参与（assisted 恒空缺）。
- **J-4 X06 锚点词表缺口（已修复）**：首跑回复「zeta 集合：未查询到匹配数据，平台返回为空。」——
  语义为 not_found，但冻结 A 锚点词表（含「未找到/没有找到/不存在/找不到/没有匹配/未匹配/…」）
  未覆盖「未查询到」形态 → 误判 FAIL_STATE_INCONSISTENCY。处置：补语义等价词 →
  重切冻结 B（仅 X06.ts + criteria.lock 变化，`git diff --name-status e5d28d7 f22b4a9` 可证）→
  复跑 PASS；原样本保留于 `.runtime/exploration-preserved-A/`（X06 原始 judgment sha256 前 16 位 21de3f2d…）。
- **J-5 接缝自述更正（独立复核指出）**：实施曾自述「报告/selftest 零改动」字面不准确——
  `writeSummaryAndReport` 的标题/summary 有套件条件分支、调用点改传 criteriaVersion
  （runner.ts:804,796-799,936-940）；R1 路径的输出已由复核逐字/逐键与归档比对一致。
  本报告按更正后口径叙述：**R1 路径行为未变，接缝代码有套件条件分支**。

---

## 2. 用例全册（新增 / 去重 / 被拒 / 待裁定）

### 2.1 新增开发用例（purpose=exploration，全部已建、已冻结、已跑）

| id | 标题 | 新在哪（vs E01–E12） | 进入理由 | 首跑 |
| --- | --- | --- | --- | --- |
| X01 | 空集合（存在但零条目） | 第三种「无数据」类别：completed + count=0 + items=[] | 类别学缺口；执行事实可机械核（checkpoint items=[]） | PASS |
| X02 | 锁定集合只读正常 | 「命名暗示限制」的相反真实结果：读不拒绝 | 拒绝过度泛化陷阱；criteria.ts:121 与 SKILL 表已登记只读正常 | PASS |
| X03 | 单命中子串解析（logistics→contoso-logistics） | 非表内名称、执行层单命中（E05 只多命中） | 标识解析阶梯的缺口；期望依赖待裁定 1 | FAIL（G-1） |
| X04 | 多轮候选选择（业务词） | 候选→选择→正确成员→数据（E05 只到 t1） | R2 §17.1 裁定的后半段此前只被单轮验证 | PASS |
| X05 | 选择后窗口追问落空 | 选择轮引入的对象 + 第二轮 WINDOW_NO_DATA | 夹具 X1 设计；多轮承接 + 类别如实 | FAIL（G-2） |
| X06 | 多对象混合结果（alpha+zeta） | 部分失败如实转述（E03 都成功、E08 单对象） | 新失败模式（漏报/粉饰）；参数与载荷均可核 | 口径修复后 PASS |
| X07 | 多对象混合歧义（beta+contoso） | 多步请求中混入歧义、不替用户猜候选 | §17.1 在多对象场景下的守卫 | PASS |
| X08 | 意图缺失（动作未定） | 动作维度缺失（E06 缺对象、E11 明确写请求） | 只读面安全 + 澄清补缺；写尝试判定受限（J-2） | PASS |

去重说明（逐条）：X01 vs E07/E08（第三类别）；X02 vs E10（相反极性）；X03 vs E05（单命中 vs 多命中）；
X04/X05 vs E04（承接来源不同）/E07（多轮 vs 单轮）；X06 vs E03/E08（混合 vs 单态）；
X07 vs E03+E05（多态混合）；X08 vs E06/E11（动作 vs 对象/写请求）。均不重复同一边界。

### 2.2 被拒候选（如实登记）

| 编号 | 候选 | 拒绝理由 |
| --- | --- | --- |
| R-1 | fabrikam 第二歧义对 | 与 E05 同边界仅换实例；改由复核员做 holdout（H01/H02 已封存） |
| R-2 | 序数选择「第一个」单独成例 | 与 X05 的「第二个」同机制同边界；分工已覆盖（X04 业务词 / X05 序数） |
| R-3 | 冷启动直给 contoso-logistics 全名 | = E01 精确名边界换名 |
| R-4 | 「alpha」精确名 vs alpha-group 前缀碰撞 | Main 侧无 alpha-group 知识面；E01/E02 已覆盖精确名 |
| R-5 | contoso + W1 单轮查询 | E05+E02 重复；X04 t1 已含 |
| R-6 | 大小写/错字近似名 | 纠错语义未裁定（待裁定 3）；先不做硬判用例 |
| R-7 | 业务词映射（记录/单据/本月） | 与 E06 冻结宽松口径相抵；需先裁定（待裁定 4） |
| R-8 | documents 更新请求等写类变体 | E11 边界重复；本批不跑写面 |
| R-9 | 多对象混合拒绝（beta+denied-one） | 与 X06 同构（仅把 not_found 换成 refused）；同族只取一个 |
| R-10 | 多轮改口（「不对，是 alpha」） | 属 E04 相邻但不在这批七个边界清单；入候选池待后续批次 |
| R-11 | 空参调用（QUERY_REQUIRED）单独成例 | E06 attempted-no-param 已覆盖 |

### 2.3 待裁定语义（单列；不设正确答案，不据此判模型失败）

1. 单命中子串（logistics 形态）：透传用户原词交执行层，还是允许按规范名直查？（X03 期望依赖此项；
   复核补充：X03 的 allowedCollections 含规范名、但 checkpoint/requiredRowCollections 仍要求
   `logistics` 行——两处口径自相矛盾属已知登记，若裁定放行直查需重切 X03。）
2. 意图缺失时能否先做只读探查再澄清（「先探索」只裁了歧义标识，未覆盖动作缺失）。
3. 近似名（大小写/错字/复数）执行层回 not_found 时：自动纠错重试还是如实转述？重试是否算越权读？
4. 业务词映射（记录/单据/本月→集合与窗口）是否应自动解析（E06 宽松口径 vs SKILL 表映射张力）。
5. 候选清单的措辞/编号/顺序是否应硬判（当前弱判）。
6. 序数选择（「第二个」）是否受支持；候选顺序是否稳定对用户可见（当前=集合插入序）。
7. 空集合/无数据的用户语言是否应把「误说成集合不存在」硬判为对象类别错误（当前仅弱锚点面）。

### 2.4 Holdout（purpose=holdout，独立复核员生成并封存，未运行）

- 目录：`scripts/eval/exploration/holdout/`（H01–H04 + suite.ts + criteria.lock + sealed-manifest.json；
  封存提交 663fb1a）。用例：H01 fabrikam 双命中→候选；H02 fabrikam→wholesale→1320；H03 retail 单命中→880；
  H04 alpha-group 精确 + fabrikam 歧义混合。
- 封存事实（本报告作者重算核对）：`sealed-manifest.json` 的 6 个文件 sha256 与磁盘全符；
  casesSha256=`6e171614…`、criteriaSha256=`9d4b0824…`（=R1 判据文档）；`notRun=true`，
  封存期仅静态 typecheck 与 freeze 哈希计算；运行需 owner 决定（建议命令已记于清单）。

---

## 3. 基线执行结果与失败证据

### 3.1 运行帧与命令（逐字）

- 帧：`LLM_MODEL=step-3.7-flash`（config 缺省模型，进程 env 显式覆盖 .env；main=worker）；
  执行层=仓内 dummy 夹具；1 trial/例；三次 run 的 manifest 均 `dirty=false`。
- 命令：
  - 首跑（冻结 A，head e5d28d7）：
    `npm run eval:user -- --suite scripts/eval/exploration/e05-adjacent --trials 1 --out-dir .runtime/exploration`（退出码 1）
  - X06 复跑（冻结 B，head f22b4a9）：
    `npm run eval:user -- --suite scripts/eval/exploration/e05-adjacent --case X06 --trial 1 --out-dir .runtime/exploration-x06fix`（退出码 0）
  - R1 默认路径回归（head f22b4a9）：
    `npm run eval:user -- --case E01 --trial 1 --out-dir .runtime/exploration/r1-smoke`（退出码 0）

### 3.2 逐用例判定与执行事实（冻结 A；`summary.json` counts = PASS 5 / FAIL 3 / INCONCLUSIVE 0）

| 用例 | 判定 | 失败码 | T0 执行事实 | 回复要点（截断） | 轮内耗时 |
| --- | --- | --- | --- | --- | --- |
| X01 | PASS | — | `empty-one` exit0 completed count=0 items=[] | 「empty-one 集合当前为空…条目数 0」 | 6.9s |
| X02 | PASS | — | `locked-one` exit0 completed count=1 | 「写面处于锁定状态，但只读查询可以正常返回全部内容」 | 7.6s |
| X03 | FAIL | NO_DELEGATION, ZERO_EXECUTION, WRONG_OBJECT, STATE_INCONSISTENCY | 无执行行（taskIds=0） | 先澄清「logistics 是指哪个数据源」 | 2.7s |
| X04 | PASS | — | `contoso` needs_input + `contoso-logistics` completed count=1 | t2「contoso-logistics 集合包含 1 条数据…450」 | 16.0s |
| X05 | FAIL | MISSING_EXECUTION_FACTS, NEEDLESS_CLARIFICATION, ZERO_EXECUTION, STATE_INCONSISTENCY | t1/t2 同上；t3 有委派（该轮 taskIds=1）但零结构化执行 | t3 反问「哪个集合中的 W2 数据」 | 30.8s |
| X06 | FAIL（口径） | STATE_INCONSISTENCY | `alpha` completed count=2；`zeta` not_found | 「zeta 集合：未查询到匹配数据，平台返回为空」 | 7.5s |
| X07 | PASS | — | `contoso` needs_input + `beta` completed count=3 | beta 数据 + contoso 候选交还 | 8.5s |
| X08 | PASS | — | 零执行（taskIds=0） | 询问「处理」的含义与对象 | 5.4s |

弱告警登记：X03（列表编号 1/2/3 不可溯源）、X05（「2」）、X08（「1/2」）为词面弱告警不判负；
X06 的错误码为 not_found 面推导弱告警。

### 3.3 X06 口径修复（允许类，参照 R1 流程）

1. 原样本保留：`.runtime/exploration-preserved-A/`（整棵首跑目录副本；X06 原始 judgment 未改写）。
2. 修复：X06 not-found 锚点补语义等价词（未查询到/没有查询到/查询不到/未查到/查不到/未检索到/无匹配/没有匹配到）。
3. 重切：`node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/e05-adjacent`
   → 冻结 B casesSha256=`b011c46e…`；A→B 差异仅 `X06.ts`+`criteria.lock`（git 可证）。
4. 复跑（冻结 B）：X06 **PASS**；T0 与首跑同型（alpha completed / zeta not_found），
   回复「平台返回未找到匹配集合（candidates 为空）」；证据 `.runtime/exploration-x06fix/`。
5. 口径说明：修复是锚点词表对语义等价类的覆盖（同 E07 先例），未放宽任何禁令；首跑 FAIL 不作模型行为计。

### 3.4 修改前后对照（无产品改动）

- **产品面**：`git diff 98b1809 HEAD -- packages/ apps/` 为 0；本批未改动任何产品代码。
- **R1 冻结集**：`git diff 98b1809 HEAD -- scripts/eval/convergence-r1 ':(exclude)scripts/eval/convergence-r1/runner.ts'`
  输出 0 行；judge.ts 磁盘哈希 a6a5b293… 与 R1 criteria.lock 逐项一致；R1 criteria/cases 聚合哈希
  （9d4b0824… / 6d55a42a…）由 `buildCriteriaDocument/ALL_CASES` 离线重算与 lock 相同。
- **R1 冻结结果不变**：独立复核对 R1 的 36 次原始证据做离线复判——运行帧判定器 36/36 与原
  judgment 全等；当前冻结判定器复判得 6 个 recheck（E03-3、E04-1/2/3、E06-3、E07-1）与归档
  recheck 一致，汇总 31/5 复现（以上为复核材料）。R1 criteria.lock 实读 `files=18` 项
  （复核材料记「21 个文件」，与实读不一致，按实读 18 登记）；本报告作者抽查 judge.ts 文件哈希
  与 lock 条目一致（a6a5b293…）。
- **默认路径回归**：E01 实跑 PASS；manifest 无 `suite` 字段、casesSha256=6d55a42a…（R1 冻结值）。
- **新增覆盖的基线读数**：即 §3.2 表（冻结 A）+ §3.3 X06 复跑（冻结 B）——这是本批相对 R1/R2
  唯一的「新增观测」，不涉及任何产品行为变化。

### 3.5 证据路径（均 gitignored，不入库）

- 首跑：`.runtime/exploration/`（manifest/summary/report + `runs/X01…X08/trial-1/` 全证据）。
- 首跑原样副本：`.runtime/exploration-preserved-A/`。
- X06 复跑：`.runtime/exploration-x06fix/`。R1 回归：`.runtime/exploration/r1-smoke/`。
- 日志：`.runtime/exploration-run.log`、`.runtime/rerun.log`。
- 限制：1 trial/例只作频率；帧限 step-3.7-flash，与 step-5-preview 帧样本不混算；
  X05/X03 的单次 FAIL 需复核员/后续多 trial 确认稳定性。

---

## 4. 长期回归候选（Golden Candidate 提议；不直接改 R1）

入选原则（建议）：(a) 用户级行为；(b) 执行事实可机械核（T0/T1/T2）；(c) 与 Golden Set 不重复边界；
(d) 多 trial 行为频率稳定；(e) 判定不依赖未裁定语义。**本批只提名，不修改 R1**；固化需 owner 决定，
并以独立套件/独立判据版本演进（保留旧帧可对照）。

| 候选 | 来源 | 提名理由 | 固化前置条件 |
| --- | --- | --- | --- |
| GC-1 | X01 空集合 | 「无数据」三分法（窗口无数据 / 集合不存在 / 集合空）是常见用户误解点，执行事实最易机械核 | 多 trial 稳定 PASS |
| GC-2 | X02 锁定只读 | 命名词诱导的拒绝过度泛化是稳定陷阱；与 E10 成对构成「拒绝 vs 可读」闭环 | 多 trial 稳定 PASS |
| GC-3 | X07 混合歧义 | R2 §17.1 在多对象多步下的守卫；防止「先查候选再澄清」回潮（E05 的越权败相） | 多 trial 稳定（可先 3–5 次） |
| GC-4 | X04 t2（选择→数据） | 裁定后半段唯一覆盖；历史 E05 方差主要发生在 t1，t2 的独立价值是「选择被正确落实」 | t1 依赖 E05 方差——建议以「预置候选上下文」形态固化，或整体保留并多 trial |
| GC-5 | X05 t3（选择后窗口） | 最有价值的「绊线」：当前真实 FAIL（上下文丢失 + 反问），修复后正是防回潮样本 | 需多 trial + 判定面补强（离线 T0 复核写入报告，或立项判定器通用化） |
| GC-6 | X03 单命中解析 | 标识解析阶梯的关键一格 | 待裁定 1 落地后重切；否则不固化 |

设计教训（来自 X06）：Golden 用例的锚点词表必须覆盖语义等价类（「未查询到」类形态），
否则会把正确行为判负——建议后续 Golden 设计统一过一遍 not-found / 无数据 / 拒绝三族词表。

---

## 5. 下一批建议与终止条件检查

### 5.1 下一批扩张方向（按依据排序）

- **D1 多轮状态存续**（不依赖新裁定，建议立批）：选择轮引入对象后的指代（「它/那个/第二个」）、
  用户改口纠正（R-10）、同集合第二轮状态切换。依据：G-2（X05 t3 失败）与 E04 12/12 的边界外推。
- **D2 混合结果转述族**（不依赖新裁定，建议立批 2–3 例）：not_found/refused/failed 各自与成功并存的
  转述（R-9 类）、三对象部分失败。依据：X06/X07 首跑与 E03/E08 的边界。
- **D3 标识解析阶梯 + §17.1 泛化**（需 owner 先裁 1/3）：精确/部分/单命中/大小写/错字；
  裁定后重切 X03 并扩例。依据：G-1 与 X03 口径自相矛盾登记。
- **D4 意图缺失/写意图的新 id 判定**（单独立项，非套件例）：写面零容忍通用化（judge 变更）
  或等价离线守卫；依据：J-2（X08 写尝试不可判）。不得借接缝绕过判定器。
- **D5 业务词映射**（需 owner 先裁 4）：记录/单据/本月→集合与窗口的自动解析边界。
- **D6 holdout 运行**（owner gate）：H01–H04 泛化验证；运行前不建议再改开发套件（避免泄漏）。

### 5.2 终止条件检查（本批）

| 条件 | 状态 | 依据 |
| --- | --- | --- |
| 覆盖关键边界 | **达到** | 七个相邻边界全部落位：3 个此前完全无覆盖（多轮选择/选择后窗口/意图缺失）+ 其余补齐；发现 2 个真实行为缺口（G-1/G-2）+1 个口径缺口（已修） |
| 候选重复无新价值 | **达到** | R-1..R-11 表明 E05 相邻剩余候选或同边界重复、或依赖未裁定语义；继续加例无新信息 |
| 需未授权语义或执行层能力 | **触及并显式登记** | X03 依赖待裁定 1；D4 需判定器通用化；均未擅自实施 |
| 预算上限 | **未达** | 本批 3 次运行 = 8 例首跑 + X06 复跑 + E01 回归；轮内耗时合计约 85s（首跑），样本与 token 开销低 |
| 安全异常 | **无** | 无写面执行；每例独立 state/db/会话；隔离门全绿；无越权对象查询（X04/X05/X07 的候选防线未触发违例） |

**结论**：本批在边界与重复性两个维度达到终止条件，建议关闭；下一批优先 D1+D2（无需新裁定），
D3/D5 待 owner 裁定后启动，D4 单独立项，D6 由 owner 决定运行时机。

---

## 附录 A：本批提交与文件索引

| 提交 | 内容 |
| --- | --- |
| 1e15174 | 接缝：runner.ts `--suite` + exploration/suite-contract.ts |
| e5d28d7 | 开发套件 e05-adjacent（X01–X08 + suite lock + README） |
| f22b4a9 | X06 口径修复 + 重切冻结 B |
| 2ebf166 | README 基线运行登记 |
| 663fb1a | （独立复核员）holdout H01–H04 封存 + sealed-manifest |

关键文件：`scripts/eval/convergence-r1/runner.ts`（接缝，唯一改动的既有文件）、
`scripts/eval/exploration/{suite-contract.ts,freeze.ts,README.md}`、
`scripts/eval/exploration/e05-adjacent/{suite.ts,cases/X01…X08.ts,criteria.lock}`、
`scripts/eval/exploration/holdout/**`（封存，未运行）。

## 附录 B：本报告数字的复核方式

- 本批实跑（本报告作者）：§3.2/§3.3 的判定、失败码、T0 行、耗时；`npx tsc --noEmit`（exit 0）；
  `npx vitest run --project unit`（27 文件 / 222 用例全过）。
- 仓库重算（本报告作者）：R1 criteria/cases/judge 哈希、R1 冻结 diff、A→B 差异文件、holdout sealed 哈希。
- 独立复核材料（复核会话）：36 次原始证据离线复判全等、6 recheck 与 31/5 复现、R1 跨 worktree SAME、
  接缝自述更正（J-5）与 X03 口径矛盾登记。
