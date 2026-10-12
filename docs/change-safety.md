# 改动防线与波次计划

状态：**执行中**。本文是三波改造（写路径保险箱 / runtime 拆分 / 业务 skill 清口径）的**防回归底座**：每一波验收前先过本文的防线，判据是机械的，不是"我会小心"。

架构目标见 [`v0-architecture.md`](v0-architecture.md)，律法见 [`architecture-laws.md`](architecture-laws.md)，债务状态见 [`debt-ledger.md`](debt-ledger.md)。冲突时以 architecture-laws 的闭环判据为准，并回头修 v0-architecture。

---

## 0. 模式铁律：只跑 mock，不碰真实平台

当前唯一可用模式是 mock（D-076：真平台登录页改版，真实模式下查询全是诚实失败）。因此：

**允许**：`npm test`、`npm run typecheck`、`npm run acceptance`、`npm run smoke:commit:mock`、`node --env-file=.env --import tsx scripts/probe-real-agent.ts`（真实 LLM + 真实 `bin/17dz` 计划门 + **mock 执行器**）。

**禁止**：`DZ_EXECUTOR=`（置空切真平台）、`scripts/smoke-real-platform.ts`、任何不带 `DZ_EXECUTOR=mock` 的 `bin/17dz` 调用、`FSHINE_REAL_COMMIT=1`。`.env` 默认 `DZ_EXECUTOR=mock` 且 `FSHINE_REAL_COMMIT` 未置位——双重保险丝都在，**不许摘**。

### mock 能证 / 不能证（验收边界的依据）

| mock 下为真，可当判据 | mock 证不到，不许写成"已验证" |
|---|---|
| G1/G2/G3 全部门禁（bash 允许表、plan 拦截、capability、commit 令牌验签、serve 矩阵） | 页面层真实行为：真实 `fill.js` 预填、多候选 `.first()`、`--start-no` NaN、upload-all 静默跳过（= S2–S10 七条 latent） |
| 审计落账、`RESULT` 信封、`plan evaluate` 裁决形状 | 登录态 / auth 族（`PLATFORM_AUTH_ERROR_CODES` 8 码 mock 下不产生；`platform-health` 只靠时钟注入单测验证） |
| 写链路四态：dry-run → 确认 → commit → 读回计数（mock 的 fill 路径实现了契约校验、账套/科目解析、辅助核算 needs_input、已结账拒绝、verify 计数） | 限流与耗时权重（mock 下 `plan evaluate` 的 seconds 与真实脚本耗时不符；预算档位标定要真平台数据） |
| 模型侧行为：探针 = 真实 LLM + mock 执行器 | 真实数据只读回归（按需跑，不进门） |

**由此产生的实现要求**：平台侧新命令必须走现有 executor 接缝（`runGate`/executor 抽象），让 `DZ_EXECUTOR=mock` 自动覆盖；否则新路径在 mock 下是空的，会被迫去真平台验证——那正是要避免的。新命令配套的 mock fixtures 至少三个：已结账期、账套不存在、辅助核算缺名。

---

## 1. 通用防线（三波共用，每波都要过）

| # | 措施 | 机械判据 |
|---|---|---|
| F1 | **表征测试先行**：动代码前先把当前行为钉成 golden | golden 集在每波第一个 commit 落地且全绿；后续 commit 里 golden 一条不改 |
| F2 | **基线冻结**：`npm test` 987 例 / 78 文件 + typecheck 0 错误为红线 | 每 commit 一次；用例数不减才进下一步 |
| F3 | **变异验证**：新守卫必须"改错就红" | 把新判据改反 → 对应断言红；删守卫 → 对应测试红 |
| F4 | **变更集最小化 + 禁止混波**：一个 commit 一件事，三波不混 commit | `refactor(agent):` 的 diff 只能有 move；回归才能归因 |
| F5 | **红先 revert 不原地修** | 测试红就 revert 该 commit，不在新 commit 里叠补丁（宪章执行纪律 3） |
| F6 | **真实模型探针基线**：涉及提示词/申报/澄清的改动，改前存 json 基线、改后同参数复跑逐轮 diff | 判定标准预先写死（见各波） |
| F7 | **文档同步是验收项** | v0-architecture §10 / debt-ledger / rule-landing 同提交更新 |

---

## 2. 方案 3 · 业务 skill 清执行口径（先行，最小的一波）

**目标**：`docs/business-skill.md` 只留路由与编排纪律；执行默认值归执行层。

**改动**（fshine 侧；17dz SKILL 的那一行另议，见下）：

| 位置 | 处置 |
|---|---|
| 「每类必需信息」整节（"科目（默认应收）、期间（默认当前）"那张表） | **删整节**。`17dz-query/SKILL.md`「未指定期间时只查平台当前期间」+ `prepare/SKILL.md`「未指定时取平台当前期间」已有；"缺什么问什么"由 needs 环（C21/C22）+ 执行层澄清规则机械承担 |
| 「名称类请求仍须先搜平台」条 | **改写为编排层自己的指代消解纪律**（实体只从当前消息/检索证据取，不得用会话早前确立的实体代替用户新给的名称）；执行的"先搜平台"归执行层 |
| 「范围无法溯源」条（"如按当前期间查"） | **删执行细节，留路由骨架**：不反复拆解 → 无前缀单步委派交给执行层定可执行口径 → 汇总如实说明实际范围 |
| 路由表、判据、其余路由原则、呈现纪律 | **保留**（跨步骤拆解与编排层自身呈现规则） |

**17dz 侧一行（需单独确认后落）**：`17dz-query/SKILL.md`「账套解析与实体溯源」节补一句 worker 侧硬规则——用户给出名称类请求时，即使本会话早前用过某账套，仍必须先经目录搜索确认规范名；会话已确立实体只用于用户只给参数（期间/范围/科目）的续问。这是 D-072 的修法落在 worker 读得到的地方。**fshine 侧的改写不依赖它**（编排层纪律已在），所以两边可不同提交。

**防线**：

| # | 措施 | 机械判据 |
|---|---|---|
| S1 | 探针基线冻结 | 改前跑 `--only A1,A2,A4,A5,F1` 存 json；改后同参数复跑。写死判定：A1 调用数不增（2 次）、A4 只搜目录（1 次）、A5 零调用、A2 不渗入旧账套、F1 三轮都走澄清且零编造 |
| S2 | 只删不加 | 这一波禁止往 business-skill 加新规则，否则无法归因是删的效应还是加的效应 |
| S3 | 秒级回滚 | skill 是文件加载：回滚 = revert 一个 md 或关掉 `businessSkillPath`，零代码路径 |
| S4 | 执行默认词表守卫 | 新 `apps/server/business-skill.test.ts`：`默认应收\|默认当前\|默认科目\|可缺省` 在 `docs/business-skill.md` 命中即红（变异：把删掉的行加回去 → 红） |
| S5 | needs 环承接证明 | e2e 1.5/1.6 不劣化；F1 探针澄清路径仍由执行层线索驱动 |

**验收**：F1–F5 全过 + 987 绿 + 探针对基线无劣化 + rule-landing C29 / v0-architecture §10「业务 skill」行同步。

### 已冻结的探针基线（2026-10-11，mock，`--only A1,A2,A4,A5,F1`）

| 用例 | 基线结果 | 判定 |
|---|---|---|
| A1 重问必重查 | ✓ 115.7s / 平台调用 4 | 必须保持 ✓，调用数不增 |
| A2 新话题不沿用旧实体 | ⚠ 246.9s / 平台调用 5 — 第二轮回复带上旧账套"幻辰"（范围渗入） | **既有模型侧观察项**（`rule-landing.md` §6 已登记）。验收标准 = 不劣化，不要求转绿 |
| A4 只搜目录 | ✓ 29.1s / 平台调用 1 | 必须保持 ✓ |
| A5 闲聊零调用 | ✓ 9.0s / 平台调用 0 | 必须保持 ✓，必须零调用 |
| F1 探索型 | ⚠ 982.6s / 平台调用 30 — 第 4 轮「幻辰财税，本月」未含真实结果 | **既有模型侧观察项**（相对期间，`rule-landing.md` §9 已登记）。验收标准 = 不劣化 |

汇总基线：**3/5 无异常**，明细 `.runtime/probe-fshine-probe-*.json`。判定口径：A1/A4/A5 保持 ✓ 且调用数不增即通过；A2/F1 两条 ⚠ 是已知模型侧失效，**转绿或维持都算通过，新增 ⚠ 或 A1/A4/A5 转 ⚠ 即打回**。

改后复跑同一 `--only` 子集，逐项对照上表；两份探针日志与 json 明细留档（`.runtime/baseline-plan3.log` / `.runtime/post-plan3.log`）。

---

## 3. 方案 2 · 拆 `handleTurn`（纯重构，零行为变化）

**目标**：`runtime.ts` 1969 行 → ~500 行，只留「装配 → 申报 → 委派 → 出口 → 持久化」骨架。

| 步 | 新模块 | 搬移内容（当前锚点） | 约行数 |
|---|---|---|---|
| 1 | `plan-facts.ts` | `appendPlanFact`(:760)、`planStepSummary`(:1750)、`renderPlanStepOutcomeLines`(:1765)、`renderPlanCircuitBreak`(:1785)、`renderPlanStepsRelayFallback`(:1807) | 150 |
| 2 | `turn-relay.ts` | `renderNeedsToolResult`(:1705)、`renderNeedsUserText`(:1717)、`renderPlanStepToolResult`(:1730)、`renderWriteClosureReply`(:1832)、`composeClarificationReply`(:1681)、`usefulWorkerNote`(:1670) | 150 |
| 3 | `turn-state.ts` | `turn` 对象(:653-682) + 计数器语义（needs 单步全局/计划模式按步 :1043-1048；零执行步 :984-985 的 `writeClosed`/`pendingPlan` 豁免） | 120 |
| 4 | `plan-binding.ts` | `resolvePlanId`(:710)、`fitsPlanShape`(:707)、`askPlanDisambiguation`(:754)、`matchPlanDisambiguationReply`(:1847)、`renderDisambiguationQuestion`(:1875) | 180 |
| 5 | `turn-exit.ts` | 出口校验两块（执行痕迹门 :1172-1219 + 协议复读门 :1230-1242） | 120 |
| 6 | `turn-context.ts` | 证据/台账/Context State/记忆头部件装配(:539-641)、`stripHistoryNotes`(:1886)、`selectRecentTurns`(:1899) | 200 |
| 7 | `turn-persistence.ts` | `persistAssistantAndContext`(:1417)、`extract17dzToolResultEvents`(:1439)、`appendUserEvent`(:1405)、`ensureHistoryBackfill`(:1545)、Context State 队列(:1485-1543) | 250 |

**防线**：

| # | 措施 | 机械判据 |
|---|---|---|
| R1 | golden 先行 | 每个待搬移函数先建 golden 测试（替身输入 → 现有输出文本），在第一个 commit 落地；搬移 commit 里 golden 一条不改 |
| R2 | 行数下降曲线 | 每 commit 记录 `wc -l runtime.ts`，只准降；上升的 commit 打回 |
| R3 | 耦合降低可证伪 | 抽出模块的单测**不起 driver harness**——新测试只 import 被测模块 + 纯数据；出现 `createTaxAgentRuntime` 即没抽干净 |
| R4 | diff 只能有 move | refactor commit 禁止夹带逻辑修改；逻辑修正单独开 commit 并登台账 |
| R5 | 变异证明测试有效 | 每模块至少一条"改错判据即红"（如 `MAX_NEEDS_ROUNDS` 按步/全局语义改错 → reducer 单测红） |
| R6 | 防再长回去 | 落地 `packages/agent/architecture-shape.test.ts`：`runtime.ts` ≤ 600 行（只减不增） |

**每步验收**：代码逐字搬移 + 987 绿 + 用例数不减 + 行数下降。七步可分批提交（建议 1-2 / 3-4 / 5-6-7 三批），批与批之间我验收。

### 方案 2 收口结果（2026-10-12，全部批次验收通过）

行数曲线：1969 → 1789（批 1）→ 1735（2a）→ 1685（2b）→ 1521（3a）→ **1203（3b 终值）**。
测试 987 → **1179 全绿**（+192，全部为不起 driver harness 的直测用例）；typecheck 0 错误；`architecture-shape.test.ts`（无环 + 行数预算 1203）机械守着。

**行为保真的最强证据：`SYSTEM_PROMPT` 与 `workerSystemPrompt` 与重构前逐字节相同**（awk 抽取 + diff 终态复查）；抽中函数与 git HEAD 原版字节级一致（归一化 `export` 前缀与 deps 窄类型后逐个 diff）。

过程中由验收方抓到并修正的两处保真度问题（都记在本节各批实施细则里）：① `usefulWorkerNote` 搬进 turn-relay 造成 `runtime ↔ turn-relay` 值 import 环（它是 runtime 私有判据，连 `composeClarificationReply` 一起搬回；共用原语 `stripFootprint` 下沉 `text-hygiene.ts`）；② factId 序号计数器被收窄成"每回合"（原实现是每 runtime 实例，跨回合同计划同一步会撞 factId 且错误被 catch 吞掉）——改为工厂在 `createTaxAgentRuntime` 建一次、每次调用从 `ctx` 取主体。

**改后探针对基线**（同参数 `--only A1,A2,A4,A5,F1`，mock）：

| 用例 | 基线 | 方案 2 后 | 判定 |
|---|---|---|---|
| A1 | ✓ 4 次调用 | ✓ 3 次 | 通过 |
| A4 | ✓ 1 次 | ✓ 1 次 | 通过 |
| A5 | ✓ 0 次 | ✓ 0 次 | 通过 |
| A2 | ⚠ 旧账套渗入（既有观察项） | ⚠ 同一形态 | 不劣化 |
| F1 | ⚠ 相对期间未落地（既有观察项） | **✓ 9 次调用** | 转绿（模型侧随机性，不据此前 Claims） |
| 汇总 | 3/5 | **4/5** | 无新增回归 |

### 分批 1（步 1-2）实施细则

R1 对模块私有函数的具体落地方式（步 1 起，后续各步同法）：

1. **先导出**：把待搬移函数在 `runtime.ts` 加 `export`（纯导出，零行为变化）。
2. **再 golden**：新建 `<模块>.test.ts`，从 `../src/runtime` import 这些函数，用现有替身输入钉住当前输出（`plan-facts` 的四个纯函数 + `turn-relay` 的渲染器都是确定性文本，golden 很便宜）。
3. **后搬移**：逐字搬进 `packages/agent/src/<模块>.ts`（含其 import 与注释），`runtime.ts` 改为从新模块 import；golden 测试的 import 改成新模块路径，**断言一条不改**。
4. **收尾**：`npm test` 全绿 + 用例数不减 + `wc -l runtime.ts` 下降，记进行数曲线。

步 1 的特殊处理：`appendPlanFact` 是 `handleTurn` 内的闭包（捕获 `deps` / `ctx` / `planFactSeq`），搬移时改成工厂 `createPlanFactWriter({taskPlans})` 返回同名函数。其余四个（`planStepSummary` / `renderPlanStepOutcomeLines` / `renderPlanCircuitBreak` / `renderPlanStepsRelayFallback`）是模块级纯函数，逐字搬。`planStepNextHint` 归步 2，不混进步 1。

**修正（行为保真度优先于"调用点一字不改"）**：分批 1 最初的写法（工厂绑死四个字段、调用点一字不改）在两次返工后被更具体的保真度要求取代，两处都是机械加参/搬回，不是逻辑修改：

| 位置 | 原写法 | 修正后 | 为什么必须改 |
|---|---|---|---|
| `createPlanFactWriter` | 工厂绑死 `{taskPlans, principalId, sessionId, requestId}`，建在 `handleTurn` 内（= 每回合） | 工厂只收 `{taskPlans}`，建在 `createTaxAgentRuntime` 内、`return {` 之前（= 每 runtime 实例）；三个记账字段改为每次调用从 `ctx` 现取 | `planFactSeq` 计数器原在 `createTaxAgentRuntime` 内、`handleTurn` 外，是**每 runtime 实例**递增。工厂建进 `handleTurn` 会把它降级成每回合重置：同一计划同一步同一状态在两个回合各追加一次时 factId 相同，撞存储 UNIQUE——而 append 失败只记日志不阻塞回合，步骤事实会静默丢失 |
| `usefulWorkerNote`（连同 `composeClarificationReply`） | 搬进 `turn-relay.ts` | 搬回 `runtime.ts` 文本卫生区 | 它是 runtime 私有判据（判据本体 `stripFootprint` / `hasFinancialFigure` / `executionLanguageFingerprints` 都在 runtime 一侧），而 `composeClarificationReply` 直接调用它 → `runtime.ts ↔ turn-relay.ts` 循环 import。组装逻辑跟着判据走，不复制第二份 |

`appendPlanFact` 的三个调用点因此从 `appendPlanFact(step, planId, status, extra?)` 变为 `appendPlanFact(ctx, step, planId, status, extra?)`（只加第一个参数，其余不动）。`turn-relay.ts` 仍需要的文本原语 `stripFootprint` 下沉到新模块 `text-hygiene.ts`，两个使用方（runtime / turn-relay）认同一份，依赖方向单向、不成环。golden 用例随函数迁往 `runtime.test.ts`，断言一条不改；`plan-facts.test.ts` 改为传最小 `ctx` 替身，并新增一条"记账字段每次从 ctx 现取"的回归。

### 分批 2a（步 3）实施细则

**搬移内容**：`turn` 状态对象（原 `runtime.ts` 内联类型 + 初值）+ 四条计数器/累积规则 → 新模块 `turn-state.ts`（176 行）。控制流（if / throw / return 的结构）一行不动，只把内联计算换成同名规则调用。

| 抽出物 | 形状 | 原锚点 |
|---|---|---|
| `TurnState` + `createTurnState(planChoice?)` | 15 个成员与初值逐一照搬（含全部字段注释）；`preferredPlanId` 仍由消歧选定的 `planChoice?.planId ?? null` 给出 | `const turn: {…} = {…}` |
| `noteNeedsRound(state, stepIndex)` | needs 轮次计数：单步模式（null）按全局计、计划模式按步计（换步重置为 1），达 `MAX_NEEDS_ROUNDS`(3) 返回 true | 委派分支 needs 段 |
| `noteZeroExecStep(state, {failed, writeClosed?, pendingPlan?})` | `planZeroExecSteps` 失败 +1 / 合法一步归零；达 `MAX_PLAN_ZERO_EXEC_STEPS`(3) 且非 `writeClosed` 返回 true；`pendingPlan` 不计不熔 | 同上，熔断记账段 |
| `notePlanStepOutcome(state, label, outcome)` | 追加进 `planStepOutcomes` | 同上 |
| `stepOutcomeOf(delegated)` | needs/clarification → `needs`、有 execution → `done`、两者皆无 → `failed` | 同上，outcome 推导 |
| `accumulateDelegation(state, step, delegated)` | `execution`/`pendingPlan`/`activatedPlan`/`clarification` 累积（计划模式 OR 累积、单步覆盖）+ `planSteps` 计数 | 同上，跨步累积段 |

两个阈值常量（`MAX_NEEDS_ROUNDS` / `MAX_PLAN_ZERO_EXEC_STEPS`）随规则一起搬走并从 `runtime.ts` 删除；`declared` / `intent` / `delegationFailed` / `clarificationReply` / `lastNeeds` / `preferredPlanId` 这些一行赋值的标志**不抽**（抽它们只有 churn），但类型定义随 `TurnState` 一起搬走，`runtime.ts` 里因此少三条 import（`SubagentNeeds` / `PendingPlanConfirmation` / 私有别名 `TurnExecution`）。

**两处如实记录的差异**（都与"逐字等价"核对过，行为不变）：

| 位置 | 现状 | 本批写法 | 为什么等价 |
|---|---|---|---|
| `planSteps` 计数时机 | 在 `resolvePlanId` 之后、`appendPlanFact('started')` 之前（派发前 +1） | 随 `accumulateDelegation` 在委派返回后 +1 | 派发前到返回间只有抛错路径（消歧提问 / 委派失败 / 平台健康冷却），而这些路径全都先置 `turn.delegationFailed = true`；`planSteps` 的全部读者（`planModeTurn` 及其三处日志）都在 `!turn.delegationFailed` 的门内，取值不影响任何输出 |
| 计划事实 `status` 与步骤 `outcome` | 两处各自写同一段三元推导 | `outcome` 改调 `stepOutcomeOf`，`status` 保持原样 | 判据字面相同；`status` 属计划事实关注点（步 1 的模块），不在本批范围，留给后续统一 |

**R6 落地（本批新建 `packages/agent/architecture-shape.test.ts`）**：两条机械断言——① `packages/agent/src/*.ts` 的相对 import 建图后检测环（失败消息带环路径，如 `runtime.ts → turn-relay.ts → runtime.ts`；只收**值** import，`import type` 被 transpiler 整条擦除、不产生运行期模块边）；② `runtime.ts` 行数 ≤ `RUNTIME_LINE_BUDGET`（只减不增，每批抽取后把常数改成真实行数，不留余量）。

**行数曲线**：1969（批次 1 前）→ 1789（批次 1 后）→ **1735**（本批后，预算常数即此值）。

**本批发现（既有、非本批引入）**：`driver.ts →(import type) plan-runtime.ts → error-codes.ts → driver.ts` 是一条**纯类型环**（编译期成立、运行期不存在，`import type` 被擦除）。因此 R6 的图只收值 import；该环不阻塞，也不必建豁免名单——若要清掉，正确解法是把 `error-codes.ts` 对 `ToolUserError` 的依赖或 `driver.ts` 的 `PendingPlanConfirmation` 类型依赖下沉，属独立小改。

**验收**：`turn-state.test.ts` 22 例 + `architecture-shape.test.ts` 2 例全绿（前者不起 driver harness，R3）；`npm test` 1065 例全绿（基线 1041，+24）；`npm run typecheck` 0 错误。变异验证（F3/R5）：把 `noteNeedsRound` 改成全局计 → 3 例红；去掉 `writeClosed` 豁免 → 1 例红；加一条 `turn-relay → runtime` 值 import → 环断言红并打印路径；`runtime.ts` 加两行 → 预算断言红。

### 分批 2b（步 4）实施细则

**搬移内容**：计划绑定（C31）的判定与消歧文案 → 新模块 `plan-binding.ts`（143 行）。分层纪律：**纯判定与渲染进模块，抛异常 / 写 turn / 打日志 / I/O 留 runtime.ts**。

| 抽出物 | 形状 | 原锚点 |
|---|---|---|
| `resolvePlanBinding(input, step)` | C31 优先级 ②③④ + 出题条件。入参 `{openPlans, preferredPlanId?, taskId?, planIdForTask, requestId}`（候选由调用方加载、反查由调用方注入），返回 `{planId, resumed}` 或 `{disambiguate}`。**纯函数**：不抛、不写 turn、不打日志、不直接碰存储 | `resolvePlanId` 的判定段 |
| `fitsPlanShape(plan, step)` | 总步数一致且申报步号 > 已留存步号 | 原闭包内箭头函数 |
| `matchPlanDisambiguationReply(deps, ctx, msg)` | 整函数搬（只依赖 conversationLog 事件 + taskPlans.openPlans，无 turn 写入；含自己的降级日志）。`deps` 形状从 `Pick<TaxAgentRuntimeDeps, …>` 收窄成模块内的 `PlanDisambiguationRepos`（引 runtime 的类型就成环） | 模块级函数 |
| `planChoiceLabel` / `renderDisambiguationQuestion` / `PLAN_DISAMBIGUATION_PREFIX` | 逐字搬；`candidates` 形参类型放宽为 `readonly TaskPlanSummary[]`（只影响类型，不影响输出） | 模块级函数 + 常量 |

**留在 `runtime.ts` 的副作用（分层落点）**：`loadOpenPlans` 对 `deps.taskPlans.openPlans` 的调用与 `task_plan_load_failed` 降级；`planIdForTask` 的注入闭包（`deps.taskPlans` 判空 + `task_plan_task_lookup_failed` 容错，失败返回 null）；`resolvePlanId` 里的 `if ('disambiguate' in binding) { turn.delegationFailed = true; console.info('task_plan_disambiguation_asked'); throw new ToolUserError(renderDisambiguationQuestion(...)) }`（同一个 if + 同一个 throw，原 `askPlanDisambiguation` 因此不再单独存在）；`task_plan_resumed` / `task_plan_started` 归属日志（`resumed` 由判定结果带回，调用方只为写日志读它）。

**两处如实记录的差异**（都与"逐字等价"核对过，行为不变）：

| 位置 | 现状 | 本批写法 | 为什么等价 |
|---|---|---|---|
| 优先级 ①（同回合已定） | `resolvePlanId` 第一行 `if (turn.planId) return turn.planId;`，在任何加载/判定之前短路 | **仍是调用点的第一行**，不进 `resolvePlanBinding` | 它是调用方对本回合早前决策的记忆，不是判定的一支。若并进 ③（`preferredPlanId`）会让形状不一致的后续步骤被重判成"新开计划"，且让每一步都重打归属日志——而 e2e 用 `toEqual` 钉住了每个回合的归属事件序列（`['task_plan_started','task_plan_resumed']` 等） |
| 判定结果带回 `resumed` | 闭包内 `resumed` 变量同时驱动 planId 与日志事件名 | `{planId, resumed}` 由纯函数返回，调用方只把它读进日志 | 判据本体仍在模块内一处；调用方若自己用 `openPlans.some(p => p.planId === binding.planId)` 反推就是第二份判定，那才该避免 |

**测试**：新建 `packages/agent/plan-binding.test.ts`（26 例，R3：不起 driver harness，只 import 被测模块 + 纯数据 + 内存假 repo）。直测 C31 五条优先级（① 经一个标注清楚的最小调用点镜像）、出题条件、`fitsPlanShape` 三条判据、消歧问题与标签的文本、`matchPlanDisambiguationReply` 的"紧跟问题 / 中间插过回合即失效 / 非纯编号 / 越界 / 候选变化 / 存储未注入 / 存储抛错"。既有 P6.11–P6.15 与 e2e 9.1/9.2（以及 7.x 的归属事件序列）一条未改，全绿。

**行数曲线**：1969（批次 1 前）→ 1789（批次 1 后）→ 1735（分批 2a 后）→ **1685**（本批后，预算常数即此值）。

**验收**：`plan-binding.test.ts` 26 例全绿；`npm test` 1091 例全绿（基线 1065，+26）；`npm run typecheck` 0 错误；`grep "from './runtime'" packages/agent/src/plan-binding.ts` 零命中（无环）；`wc -l packages/agent/src/runtime.ts` 1685。

### 分批 3a（步 5-6）实施细则

**搬移内容**：出口校验两块 → `turn-exit.ts`（216 行）；每回合上下文档装配 → `turn-context.ts`（206 行）。分层纪律同前：**纯判定/装配进模块，I/O、日志、抛异常、写 turn 留 runtime.ts**。

| 新模块 | 抽出物 | 原锚点 |
|---|---|---|
| `turn-exit.ts` | `decideTurnExit(input)` + `TurnExitInput` / `TurnExitEvent` / `TurnExitDecision` | 出口校验两块（执行痕迹门 + 协议复读门，handleTurn 尾部） |
| `turn-context.ts` | `assembleTurnContext(input)` + `stripHistoryNotes` / `selectRecentTurns` / `isFinalAssistantMessage` / `assistantContentText` / `renderContextState` + `RECENT_TURN_HISTORY_NOTE` / `INJECTED_NOTE_PREFIXES` | 头部件装配、`stripHistoryNotes`、`selectRecentTurns` |

**与任务描述的差异（都已按现状实现，逐条报回）**：

| # | 任务描述的签名 | 本批写法 | 为什么必须改 |
|---|---|---|---|
| 1 | `TurnExitDecision` 只有 `ok` / `relay` | 多一个 `direct`（`{text, outcome, events}`） | 现状里 activatedPlan 与"干净说明附注 / NO_EXECUTION_CLARIFICATION"两支是 `finishDirectReply` 的**提前返回**（还带 turn_span 的 outcome），不是 needsRelay 赋值。只留 relay 会丢掉"这段文本就是回复 + 用哪个 outcome 记账" |
| 2 | `relay` 带单个 `event` + `detail` | 带 `events: TurnExitEvent[]`（含 level） | 边界形状："① 转达出的文本是空串"时 `!needsRelay` 仍为真，② 照样截住——今天**两段门各自打点**（info 后 warn），单事件无法表达 |
| 3 | 入参只有 turn/result 事实 | 追加注入 `hasFinancialFigure` / `usefulWorkerNote`，`protocolReplay` 由调用方算好传入 | 两把尺的本体在 runtime.ts 一侧（`usefulWorkerNote` 还要读执行语言指纹表与三个兜底文案常量），`looksLikeProtocolMaterial` 同理；引回来就成环。按 plan-binding 的 `planIdForTask` 同族方式注入，判据仍只有一处定义 |
| 4 | `assembleTurnContext({...}) => AgentMessage[]` 隐含水一篇用户消息 | 用户消息的 `push` **留在 runtime.ts**（compact 之后） | 现状里 push 在 `compactSafe` 之后；装进装配函数会让 transcript 模式的压缩把用户消息一起压掉 |
| 5 | （未提） | `assembleTurnContext` **就地装进入参 base 并返回同一数组** | transcript 模式现状是 `context = loaded`（同一引用），头部材料与用户消息都落在 `loaded` 上，`finishDirectReply` 因此带着它们。复制一份会静默改掉这个别名语义（那条路径今天会重复保存用户消息，是既有形状，不是本批要修的） |

**测试**：新建 `turn-exit.test.ts`（24 例）与 `turn-context.test.ts`（17 例），均不起 driver harness（R3）。前者钉两段门各自的条件组合——含今天只能靠 F4.1–F4.4 与 e2e 间接覆盖的"有执行但协议复读"（D-020 形状）与"① 转达空串时 ② 补位"边界；后者钉注入顺序（全材料在场 + 六种缺席组合）、`stripHistoryNotes` 剥离、`selectRecentTurns` 的"完整轮次或被 toolResult 终结"判定（C19）与孤儿 toolResult 过滤。`turn-exit.test.ts` 为用真实尺子而 import `hasFinancialFigure` / `usefulWorkerNote`（导入判据 ≠ 起 harness）。

**泄漏 lint**：随函数/常量搬过来的注释与注令文案各带一处"财务"命中，按分批 1 先例登记两条「防御排除」（`turn-exit.ts: 财务` = activatedPlan 附注准入判据；`turn-context.ts: 财务` = 防串轮注令 + Context State 措辞），并进 `DEFENSIVE_EXCLUSION_KEYS`。

**行数曲线**：1969（批次 1 前）→ 1789（批次 1 后）→ 1735（分批 2a 后）→ 1685（分批 2b 后）→ **1521**（本批后，预算常数即此值）。

**验收**：`turn-exit.test.ts` 24 例 + `turn-context.test.ts` 17 例全绿；`npm test` 1132 例全绿（基线 1091，+41）；`npm run typecheck` 0 错误；`grep "from './runtime'" packages/agent/src/turn-exit.ts packages/agent/src/turn-context.ts` 零命中（无环）；`wc -l packages/agent/src/runtime.ts` 1521。变异验证（F3/R5）：去掉第二段门的 `!delegationFailed` → 1 例红（`delegationFailed … 两段门都放行`）；调换"检索证据/执行台账"的注入顺序 → 1 例红（全材料在场的顺序断言）；去掉第一段门的 `!execution` → 既有 runtime.test.ts + plan-mode.test.ts 12 例红（证明搬移后既有 F4/P6 仍守着门）。

### 分批 3b（步 7）实施细则

**搬移内容**：持久化 / 事件落账 / 上下文状态维护 → 新模块 `turn-persistence.ts`（374 行）。分层纪律同前：**落账与降级进模块，控制流与实例状态留 runtime.ts**。

| 抽出物 | 形状 | 原锚点 |
|---|---|---|
| `loadMemoryProjection(deps, principalId)` | 长期记忆投影取数与降级 | 模块级函数 |
| `scheduleMemoryConsolidation(deps, ctx, userMessage, queues)` + `EXPLICIT_MEMORY_CUE` | 记忆归并排队（队列由调用方传入） | 模块级函数 + 常量 |
| `appendClarificationIssued` / `appendClarificationResolved` | 澄清事件落账 | 模块级函数 |
| `appendUserEvent` | 用户消息事件 | 模块级函数 |
| `persistAssistantAndContext` | assistant 事件 + tool_result 事件 + 排 Context State 更新 | 模块级函数 |
| `extract17dzToolResultEvents` | 工具结果事件抽取（三种路径 + 脱敏 + 20_000 截断） | 模块级函数 |
| `ensureHistoryBackfill` + `transcriptEvents` + `messageText` | 历史转录一次性导入 | 模块级函数 |
| `enqueueContextStateUpdate` / `updateContextState` + `isContextState` | Context State 增量更新 | 模块级函数 |
| `redactInternalIds` / `redactSensitiveText` | 脱敏尺（runtime 的调用点也认同一份） | 模块级函数 |

**依赖收窄**：签名从 `deps: TaxAgentRuntimeDeps` 改为模块内自定义的 `TurnPersistenceDeps`（与 `plan-binding.ts` 的 `PlanDisambiguationRepos` 同族——引 runtime 的类型就成环），只声明 `conversationLog` / `contextStates` / `memoryRecords` / `memoryCandidateExtractor` / `memoryBatchSize` / `contextModelDriver` 六个用到的字段。runtime 直接把整个 deps 传进来（形状是真子集，无需适配）。

**留在 `createTaxAgentRuntime` 的每实例状态**：`contextUpdateQueues` / `memoryUpdateQueues` / `initializedContextSessions` 三份 Map/Set（实例状态不是持久化逻辑），作为 `queues` 参数传进被搬走的函数。

**日志落点**：留在函数内（改动更小的那种）。这些函数的职责本就包含自己的降级日志；改成"返回事件、调用方打日志"只会把降级判断拆成两处，且要把 11 个事件名逐个透传出模块。

**两处如实记录的差异**（都与"逐字等价"核对过，行为不变）：

| # | 任务描述的签名 | 本批写法 | 为什么必须改 |
|---|---|---|---|
| 1 | 截断长度提为命名常量 | 保留字面量 `.slice(0, 20_000)` | 现状没有这个常量；提常量是纯 churn，且"逐字等价"要求落库形状一条不改 |
| 2 | `isContextState` 随持久化函数搬走 | 从 `turn-persistence.ts` **导出**，runtime 的 `previousContextState` 读取块（handleTurn 内联）import 它 | 该读取块是 handleTurn 的控制流（读失败要打 `context_state_load_failed` 并继续回合），不在本批搬移清单里；导出共认一份判据比在 runtime 里复制第二份好 |

**测试**：新建 `turn-persistence.test.ts`（47 例，R3：不起 driver harness，只 import 被测模块 + 纯数据 + 内存假 repo）。直测 `extract17dzToolResultEvents` 的三种路径（run_17dz_task 信封 / needs 交还 / 计划步交还）与 `recorded:'conversation'` 跳过、脱敏（task_/plan_ 占位符、Bearer、键值密钥）、20_000 截断、eventId 组成（toolCallId 与下标两种）、createdAt 取数；`redactInternalIds` / `redactSensitiveText`；`ensureHistoryBackfill` 的成功（导入 + 归约 + upsert）、已初始化短路、Log 已有事件不重复导入、缺 `contextStates` / 缺 `conversationLog` 两个缺省、append 与 list 抛错双降级；`persistAssistantAndContext` 的落账顺序、存储抛错不阻塞、`contextStates` 缺席不排队、队列自动清理、更新自身失败不影响已落事件；`appendUserEvent` 与两条澄清事件的事件形状；`loadMemoryProjection` 四条；`scheduleMemoryConsolidation` 五条（批阈值 / 显式线索 / cursor 冲突 / 抛错不外溢 / 缺依赖空操作）；`isContextState` 四条。

**行数曲线**：1969（批次 1 前）→ 1789（批次 1 后）→ 1735（分批 2a 后）→ 1685（分批 2b 后）→ 1521（分批 3a 后）→ **1203**（本批后，预算常数即此值；方案 2 到此结束）。

**验收**：`turn-persistence.test.ts` 47 例全绿；`npm test` 1179 例全绿（基线 1132，+47）；`npm run typecheck` 0 错误；`grep "from './runtime'" packages/agent/src/turn-persistence.ts` 零命中（无环）；`wc -l packages/agent/src/runtime.ts` 1203。变异验证（F3/R5）：删掉 `redactInternalIds` 的 `plan_` 规则 → 2 例红；截断长度 20_000 → 20_050 → 1 例红；`ensureHistoryBackfill` 的失败降级 `return false` 改 `return true` → 2 例红；往 turn-persistence 加一条 `import … from './runtime'` 的值 import → 环断言红并打印 `runtime.ts → turn-persistence.ts → runtime.ts`。**方案 2 剩余函数清单**：`createTaxAgentRuntime`（含 `handleTurn` / `runMainAgent` / `finishDirectReply` 三个闭包）、`SYSTEM_PROMPT`、`TaxAgentRuntimeDeps` 与五个文本判据（`executionLanguageFingerprints` / `looksLikeProtocolMaterial` / `hasFinancialFigure` / `usefulWorkerNote` / `composeClarificationReply`）。

---

## 4. 方案 1 · 写路径保险箱（最后，两仓协同）

**目标**：写提案在编排层是**不透明 payload**；schema / 域校验 / 确认摘要 / dry-run / commit / 读回全归执行层。走查判据：新增 payroll 写路径，fshine 侧改动 = 0。

**核心思路**：提案也走网关（复用已验证的 plan 路径形态）——worker 用 `write` 把提案写进 `tmp/<requestId>/proposal.json`，再 `bin/17dz proposal create --file <path>`；宿主在 `beforeToolCall` 像拦 plan 一样拦住，调平台校验 + dry-run，拿回**不透明提案引用 + 平台渲染的摘要文本**。宿主持的只有确认码/有效期/主体绑定 + 授权复核。

### A 波（17dz-platform，additive，可独立回滚）

**设计决定（对照真实接缝后定，两处都比原草图省）**：

1. **宿主连箱子都不持，只持一张取物单**。提案 payload 由平台侧提案状态库持有（`.runtime/proposals.json`，`DZ_PROPOSAL_STATE` 可覆盖），宿主的 `ChangeIntentRecord` 只剩 `{intentId, principalId, sessionId, taskId, proposalId, status, expiresAt, decidedAt, result}`——**没有 payload 字段，也没有任何业务字段**。原草图让宿主存不透明 payload，实测没必要：payload 全程不进宿主，取物单（proposalId）就够关联。
2. **不新开 CLI 组，复用已注册 operation + 一个机器可读的 `protocol` 角色列**。`operation list --json` 已能带出 args 规格与 access 语义表；给它加一列 `protocol`（`proposal.create` / `proposal.commit`），宿主适配层（`platform-contract.ts`，泄漏 lint 白名单内）按角色识别，**不抄任何业务 operation 名**。这样 serve-gate 不需要新的 invocation 族，`planExempt`（读 `plan` 列）与 `isWriteAccess`（读 `confirm` 列）两套现成机制原样工作。
3. **payload 形状不进 `src/execution/`，归域**：`src/voucher/proposal.schema.json`。它天然在 serve 门的知识面上（`*.schema.json`），worker 直接 `read` 即可，**不需要为宿主开 `proposal --schema` CLI 出口**——宿主根本不解析 payload，没有消费方。（原草图的 `proposal --schema` 因此删除。）

**交付物**：

| # | 文件 / 位置 | 内容 |
|---|---|---|
| 1 | `src/voucher/proposal.schema.json` | 提案 payload 唯一形状声明（Ajv draft-07，`additionalProperties:false`）。收录现有 worker 输出字段（`type`/`domain`/`accountSet`/`period`/`contracts`/`summary`），把宿主今天的 `maxBatchCount=50` 搬成 `maxItems:50`。description 写清"为什么平台必须认领它"（同 plan-schema 的写法） |
| 2 | `src/voucher/operations.json` | 新增 `voucher.proposal`：`command: proposal`、`executor: compat-script`、`access: scratch`、`effects: [local]`、`plan: false`、`protocol: "proposal.create"`、位置参数 `contractFile`；`voucher.commit` 增补 `protocol: "proposal.commit"` 与 flag `--proposal-id`（从提案状态库取 payload，替代文件路径） |
| 3 | `src/execution/proposal.js` | 提案状态库（`'wx'` 独占锁 + 原子 rename，损坏 **fail-closed** `PROPOSAL_STATE_CORRUPT`，不复位——与 `plan.js`/`memory.js` 同一套失败模型）+ `create()`（按 schema 校验 → 经 **executor 接缝**跑域 dry-run → 落状态 → 返回 `{proposalId, summaryText, correctForm?}`）+ `commit()`（验宿主令牌 → 复校 payload → 经 executor 接缝 `--save` → 读回校验 → `{ok, verified, summaryText}`） |
| 4 | `src/execution/gateway.js` | `prepare` 模式路由 `voucher.proposal`；`commit` 模式接受 `--proposal-id`。**新命令是现有 operation 的薄编排，不重写任何域逻辑**（dry-run = 现 `voucher.prepare` 路径、保存 = 现 `voucher.commit`、读回 = 现 `voucher.verify-saved`） |
| 5 | `src/execution/mocks/respond.js` | `proposal.create` / `proposal.commit` 两个 handler + **三个新 fixtures**：已结账期（commit 被拒）、账套不存在（`RESOLVE_INVALID`）、辅助核算缺名（`needs_input`）。fixtures 必须覆盖宿主新代码的三条失败分支 |
| 6 | `.agents/skills-serve/17dz-bookkeeping-prepare/SKILL.md` | 「提案输出格式」节改写：`write` 落 `tmp/<requestId>/proposal.json`（形状以 `src/voucher/proposal.schema.json` 为准，worker 可 read）→ `bin/17dz prepare voucher.proposal <文件>`；旧"最终消息贴 JSON"形态标 **deprecated，留一版**（B 波影子双跑期两条路都要能走） |
| 7 | `test/test-proposal.js` | 往返 / schema 拒绝（≥17 条坏输入，含 `maxItems` 超限与未知顶层字段）/ 状态隔离 / 损坏 fail-closed / 3 进程跨进程全链 / serve 法域可读 / mock e2e 三 fixtures；挂进 `test-all.js` |

**A 波验收（全 mock）**：17dz 全量测试绿 + `lint:operations` 绿 + `test-proposal.js` 绿；`DZ_EXECUTOR=mock` 下 `bin/17dz prepare voucher.proposal <file>` 与 `commit --proposal-id` 全链可跑（含三个 fixtures 的拒绝分支）；`operation list --json` 能带出 `protocol` 列且 `plan`/`confirm` 两列判据与新 operation 一致。**A 波不改 fshine 一行**，因此可独立回滚（revert 平台侧提交即可）。

**A 波明确不做**：不删宿主旧文本路径（B 波影子期还要用）、不跑真平台、不改 `voucher.fill.js` 的域逻辑、不为宿主开 schema CLI。

**A 波的一个标定选择（影响 B 波）**：`voucher.proposal` 声明为 `access: scratch`（它改的是本轮私有草稿，不是平台数据），因此 `confirm` 列为假、宿主 `isWriteAccess` 判它**不是写**。代价是 D-075 那道"计划里出现 write 类 operation 就前置合成写关闭话术"的机械兜底对提案步不触发——所以 **B 波的拦截点必须自己做 capability 复核**（宿主持有的授权，Generic，不依赖 operation 名），不成立时当场合成写关闭话术。这比靠计划扫描猜更准：宿主确切知道"正在创建提案"这一刻。

### B 波（fshine）

新 `packages/agent/src/proposal-runtime.ts`（≈150 行，镜像 plan-runtime）+ `pi-coding-driver.ts` `beforeToolCall` 加一支 + `ChangeIntentRecord` 瘦成 `{intentId, principalId, sessionId, taskId, proposalId, payloadRef, status, expiresAt, decidedAt, result}` + 删 `ChangeProposal` 接口与业务校验(`context.ts:234-282`) + 删宿主拼的确认摘要(`context.ts:405-414`) + `commit.ts` 瘦成薄执行器（删 staging/before-after，令牌改 HMAC over `{proposalId, expiresAt}`）。

### C 波（收口）

删文本兜底、清 leak-lint 三条"遗留待清"登记（`context.ts: 借贷`、`commit.ts: 账套/凭证`）、重写 `turn-loop-write-chain.test.ts`、关 D-030/031/032/080/081/082、更新 v0-architecture §10 写路径行。

**防线**：

| # | 措施 | 机械判据 |
|---|---|---|
| W1 | 影子双跑 | B 波起旧文本路径仍生效，新网关路径只记录不一致（`proposal_shadow_mismatch` 事件）；mock + e2e 各若干轮零差异才切流 |
| W2 | 一键回滚开关 | `FSHINE_PROPOSAL_VIA_GATEWAY` 默认关；关开关 = 回今天路径，不 revert commit；开关状态每回合进审计 |
| W3 | mock 全链是唯一波次验收 | `smoke:commit:mock` + `acceptance` 5.x 写链路 mock 下全绿；**不碰真平台** |
| W4 | 安全三态翻转（D-080/081/082） | ① 提案后收回 write → 确认码必被拒；② server 带 `DZ_REQUIRE_PLAN=1` 跑 commit 全链绿；③ commit 后 `platform_tasks` 有终态（invariant-checker 例外撤掉转硬断言）。三条都是"现在红、修完绿" |
| W5 | 旧数据 fail-closed | 旧 shape 的 pending intent 一律按过期处理；单测钉"旧行读回 → `confirm_stale`，不 commit" |
| W6 | 门禁不倒退 | 新拦截分支补三态（无激活计划 / 越权实体 / 能力关闭）；变异：plan 豁免判据改错 → 对应实证翻红 |
| W7 | 密钥不变量 | 激活密钥 / commit 密钥不进 worker env（grep 断言 + 现有测试随迁） |
| W8 | L4 机械守卫 | `ChangeIntentRecord` 字段名白名单断言（出现业务名即红）+ leak-lint 删三条登记（只减不增防回流） |

### 上线门（**不属于本次波次验收**，单独清单）

前置条件全满足才允许开真平台写：① D-076 登录页改版修好；② 写 latent 七项（S2/S3/S4/S5③/S7/S9/S10）在 17dz 关闭；③ `FSHINE_REAL_COMMIT` 显式置位并留审批记录；④ 一次真平台手工写留档（dry-run exit1→修→exit0→commit→读回计数 ≥ 提案张数，平台 audit 与宿主 `tool_calls` 两侧对得上）。

---

## 5. 执行顺序与回滚

**顺序**：方案 3 → 方案 2 → 方案 1。方案 3 半天可完；方案 2 穿插做，越早越便宜；方案 1 每波独立交付、独立回滚。

**回滚**：方案 3 = revert 一个 md；方案 2 = revert 一个 refactor commit（golden 保证行为不变，回滚无风险）；方案 1 = A 波 revert 平台命令、B 波关 `FSHINE_PROPOSAL_VIA_GATEWAY` 开关、C 波随 B 波。

**归因纪律**：任何一步测试红，先 revert 该 commit（F5），不在红上叠补丁。三波不混 commit（F4），否则回归无法归因到波次。
