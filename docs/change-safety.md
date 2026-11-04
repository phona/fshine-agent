# 改动防线与波次计划

状态：**执行中**。本文是三波改造（写路径保险箱 / runtime 拆分 / 业务 skill 清口径）的**防回归底座**：每一波验收前先过本文的防线，判据是机械的，不是"我会小心"。

架构目标见 [`v0-architecture.md`](v0-architecture.md)，律法见 [`architecture-laws.md`](architecture-laws.md)，债务状态见 [`debt-ledger.md`](debt-ledger.md)。冲突时以 architecture-laws 的闭环判据为准，并回头修 v0-architecture。

---

## 0. 模式铁律：只跑 mock，不碰真实平台

当前唯一可用模式是 mock（D-076：真平台登录页改版，真实模式下查询全是诚实失败）。因此：

**允许**：`npm test`、`npm run typecheck`、`npm run acceptance`、`npm run smoke:commit:mock`、`node --env-file=.env --import tsx scripts/probe-real-agent.ts`（真实 LLM + 真实 `bin/17dz` 计划门 + **mock 执行器**）、L7 打分链 `npm run eval` / `eval:probe` / `eval:acceptance` / `eval:score` / `eval:baseline`（前者两段与探针同法域；`eval:score`/`eval:baseline` 只读报告 + 调评委模型，不触平台）。

**禁止**：`EXECUTION_EXECUTOR=`（置空切真平台）、`scripts/smoke-real-platform.ts`、任何不带 `EXECUTION_EXECUTOR=mock` 的 `bin/17dz` 调用、`FSHINE_REAL_COMMIT=1`。`.env` 默认 `EXECUTION_EXECUTOR=mock` 且 `FSHINE_REAL_COMMIT` 未置位——双重保险丝都在，**不许摘**。

### mock 能证 / 不能证（验收边界的依据）

| mock 下为真，可当判据 | mock 证不到，不许写成"已验证" |
|---|---|
| G1/G2/G3 全部门禁（bash 允许表、plan 拦截、capability、commit 令牌验签、serve 矩阵） | 页面层真实行为：真实 `fill.js` 预填、多候选 `.first()`、`--start-no` NaN、upload-all 静默跳过（= S2–S10 七条 latent） |
| 审计落账、`RESULT` 信封、`plan evaluate` 裁决形状 | 登录态 / auth 族（`PLATFORM_AUTH_ERROR_CODES` 8 码 mock 下不产生；`platform-health` 只靠时钟注入单测验证） |
| 写链路四态：dry-run → 确认 → commit → 读回计数（mock 的 fill 路径实现了契约校验、账套/科目解析、辅助核算 needs_input、已结账拒绝、verify 计数） | 限流与耗时权重（mock 下 `plan evaluate` 的 seconds 与真实脚本耗时不符；预算档位标定要真平台数据） |
| 模型侧行为：探针 = 真实 LLM + mock 执行器 | 真实数据只读回归（按需跑，不进门） |

**由此产生的实现要求**：平台侧新命令必须走现有 executor 接缝（`runGate`/executor 抽象），让 `EXECUTION_EXECUTOR=mock` 自动覆盖；否则新路径在 mock 下是空的，会被迫去真平台验证——那正是要避免的。新命令配套的 mock fixtures 至少三个：已结账期、账套不存在、辅助核算缺名。

---

## 1. 通用防线（三波共用，每波都要过）

| # | 措施 | 机械判据 |
|---|---|---|
| F1 | **表征测试先行**：动代码前先把当前行为钉成 golden | golden 集在每波第一个 commit 落地且全绿；后续 commit 里 golden 一条不改 |
| F2 | **基线冻结**：`npm test` 全绿 + typecheck 0 错误为红线；用例数**只增不减** | 每 commit 一次；用例数不减才进下一步。**基线是随波次实测刷新的数字，不是常数**（原写死的 987 例 / 78 文件是 2026-09-29 的，C/D 波删了 legacy 落账执行器与其单测、又加了提案/写链路用例，早已漂移）。E 波实测：改造前 1228 例 / 90 文件，E1/E2/E3 后 1267 例 / 92 文件。L7 波后 1313。产物回传波（2026-10-19）改造前 1409 例 / 111 文件，改造后数字见 §8 |
| F3 | **变异验证**：新守卫必须"改错就红" | 把新判据改反 → 对应断言红；删守卫 → 对应测试红 |
| F4 | **变更集最小化 + 禁止混波**：一个 commit 一件事，三波不混 commit | `refactor(agent):` 的 diff 只能有 move；回归才能归因 |
| F5 | **红先 revert 不原地修** | 测试红就 revert 该 commit，不在新 commit 里叠补丁（宪章执行纪律 3） |
| F6 | **真实模型探针基线**：涉及提示词/申报/澄清的改动，改前存 json 基线、改后同参数复跑逐轮 diff | 判定标准预先写死（见各波） |
| F7 | **文档同步是验收项** | v0-architecture §10 / **architecture-laws「当前违例」节** / debt-ledger / rule-landing 同提交更新；关账与代码同一 commit，`packages/agent/docs-reality.test.ts` 双向对账（已关判据保持 + 防御排除在场，2026-10-16 落地） |

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

1. **宿主连箱子都不持，只持一张取物单**。提案 payload 由平台侧提案状态库持有（`.runtime/proposals.json`，`EXECUTION_PROPOSAL_STATE` 可覆盖），宿主的 `ChangeIntentRecord` 只剩 `{intentId, principalId, sessionId, taskId, proposalId, status, expiresAt, decidedAt, result}`——**没有 payload 字段，也没有任何业务字段**。原草图让宿主存不透明 payload，实测没必要：payload 全程不进宿主，取物单（proposalId）就够关联。
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

**A 波验收（全 mock）**：17dz 全量测试绿 + `lint:operations` 绿 + `test-proposal.js` 绿；`EXECUTION_EXECUTOR=mock` 下 `bin/17dz prepare voucher.proposal <file>` 与 `commit --proposal-id` 全链可跑（含三个 fixtures 的拒绝分支）；`operation list --json` 能带出 `protocol` 列且 `plan`/`confirm` 两列判据与新 operation 一致。**A 波不改 fshine 一行**，因此可独立回滚（revert 平台侧提交即可）。

**A 波明确不做**：不删宿主旧文本路径（B 波影子期还要用）、不跑真平台、不改 `voucher.fill.js` 的域逻辑、不为宿主开 schema CLI。

**A 波的一个标定选择（影响 B 波；2026-10-14 已被平台侧改动推翻，留档）**：`voucher.proposal` 原声明为 `access: scratch`（理由是它改的是本轮私有草稿，不是平台数据），因此 `confirm` 列为假、宿主 `isWriteAccess` 判它**不是写**。代价是 D-075 那道"计划里出现 write 类 operation 就前置合成写关闭话术"的机械兜底对提案步不触发——所以 **B 波的拦截点必须自己做 capability 复核**（宿主持有的授权，Generic，不依赖 operation 名），不成立时当场合成写关闭话术。这比靠计划扫描猜更准：宿主确切知道"正在创建提案"这一刻。

### A 波已落地（2026-10-12，17dz 侧，未 commit）

平台侧 7 项交付物全部完成，我独立复验：`npm test` ALL PASS（317）+ `lint:operations` 通过；mock 下实跑 `prepare voucher.proposal <file>` → `RESULT {proposalId, summaryText, status:completed}`，`commit voucher.commit --proposal-id <id>` → `{ok:true, verified:true, readBack:{before:1,after:2,delta:1}}`；三个 fixtures 独立复现（账套不存在 → `RESOLVE_INVALID`；辅助缺名 → `needs_input`；已结账期 create 通过、commit → `SAVE_REJECTED` exit 2 且提案保持 pending 可重试）；`operation list --json` 确实带出 `protocol` 列（`voucher.proposal → proposal.create`、`voucher.commit → proposal.commit`，其余 24 个为 null）。

`test-args-spec.js` 的"规格必须逐字等于脚本真实面"锁被改成三条更细的判据（规格 ⊆ 脚本面 ∪ 脚本之上被消费的 flag；非刻意子集仍逐字相等；两张显式偏离表 `ABOVE_SCRIPT_FLAGS` / `DELIBERATE_SUBSETS` 本身也是锁）——这是**细化不是放宽**：`--proposal-id` 由网关层摘掉、域脚本看不到，`voucher.proposal` 刻意不暴露不可达的 `--save`。

**给 B 波的契约提示（A 波实证的限制）**：
1. 协议角色 operation 必须按 **operation 名**寻址（`bin/17dz prepare voucher.proposal <file>`）。按脚本路径寻址（`prepare src/voucher/scripts/fill.js <payload>`）会解析成 `voucher.fill` 并报 `CONTRACT_INVALID`——形态错被说成数据错。平台无法在不嗅探文件内容的前提下区分（本仓禁止内容嗅探），已对 runner / `operation run` / 建造模式寻址加 protocol-keyed 形态守卫。**B 波的拦截判据因此认 operation 名 + protocol 列，不认脚本路径。**
2. `--batch` 的语义是"payload **文件**是提案数组"，一次创建多个提案（返回 `proposals[]`）。
3. **未做 period ↔ contracts 日期的一致性校验**（A 波范围外）："声明录 7 月、契约日期在 8 月"的 payload 会真的落账，然后读回按 payload.period 计数得增量 0 → `PROPOSAL_VERIFY_SHORT` + 提案转终态（防二次落账）。响亮失败而非静默错，但更便宜是在 create 挡掉。**列为 B 波切流的前置项**（或至少在开真平台写之前关掉）。
4. `docs/proposal.schema.json`（V1 文档冻结副本）保留未删——skills-serve README 不变量 3 与 `test-agent-pipeline` 消费它。运行时唯一权威是 `src/voucher/proposal.schema.json`，两者一致性有机械锁（漂移即红）；副本随 B/C 波宿主不再解析 payload 而退役。

**纪律事件（必须记住）**：A 波子任务排练验收时用 `env $ENV ./bin/17dz …` 传环境变量，**zsh 不做无引号变量的词分割**，导致一条命令没带上 `EXECUTION_EXECUTOR=mock`，真 `fill.js` 以 build 模式起来了一次（`invocations.jsonl` 留痕：`2026-10-12T01:54:59`，`serve:false`，无 mock 标志，exitCode 1，931ms）。现场取证：无残留进程；`.browser-profile`（Sep 29）、`.runtime/auth.json`（Oct 10）、`.runtime/screens/`（Sep 29）**均未被写过**；当天唯一一条非 mock 且未被拒的调用就是它，且以 exit 1 结束——没有任何平台状态变动。教训与纪律：**本机 shell 是 zsh，批量传 env 必须字面写进命令行**；"我们以为它无害地失败了"永远不能作为依赖。

### B 波（fshine，带开关与影子双跑）

**开关**：`FSHINE_PROPOSAL_VIA_GATEWAY` 默认**关** = 走今天的主本文本路径；开 = 走网关提案路径。影子期两条路都在：开开关时，旧文本路径仍然跑一遍但**只记录不一致**（`proposal_shadow_mismatch` 事件），不生效。

**判别只有一个**：意图记录带不带 `proposalId`。带 → 新路径（平台 create/commit）；不带 → 旧路径（`commit.ts`）。确认状态机只有一套（`matchConfirmation` 原样），两条执行后端按记录形状分流——C 波删旧路径时这个分支自然塌掉。

| # | 交付物 | 要点 |
|---|---|---|
| B1 | `packages/agent/src/proposal-runtime.ts`（新，≈150 行，镜像 plan-runtime） | `parseProposalCommand(command)`：网关首词 + `prepare` 模式 + operation 引用，**按 `protocol` 列判是不是提案创建**（A 波实证：按脚本路径寻址会解析成 `voucher.fill` 并报数据错，所以判据认 operation 名 + protocol 列，不认脚本路径）。`operation-labels.ts` 加 `protocol` 列的解析与加载（拿不到表 → 空 → 不拦截，与 label/args 规格同一失败语义）。纯函数 + 单测，不起 harness |
| B2 | `ChangeIntentRecord` 瘦身 + store 迁移 | 契约形状改为 `{intentId, principalId, sessionId, taskId?, proposalId, status, expiresAt, createdAt, decidedAt?, result?}`——**零业务字段、零 payload**。`change_intents` 加 `proposal_id` 列；旧行业（有 kind/account_set 的无 proposalId）**一律按过期处理**（W5：单测钉"旧行读回 → `confirm_stale`，不 commit"） |
| B3 | 拦截与提案流 | `pi-coding-driver.ts` `beforeToolCall` 在 plan 解析之后、gate 之前加一支：① **capability 复核**（宿主持有的授权，Generic——A 波当时的标定：`voucher.proposal` 是 `access: scratch`，D-075 的计划扫描兜底对提案步不触发，所以这一刀必须宿主自己下（**2026-10-14 更正**：17dz `a683df2`（D-090）已把 `voucher.proposal` 改成 `access: write`，`confirm` 列为真 ⇒ 计划里出现它时 `planWriteClosed` **会**触发——只读部署下提案步现在先被计划扫描兜住。这是更严的方向，且宿主 B3 的 capability 复核仍在，两层并存不冲突；验收 5.x 要跑写链路必须把主体 `capabilities` 开到含 `write`））；不成立 → 当场合成写关闭话术，`writeClosed` 语义与 D-075 一致。② 成立 → 宿主办调 `bin/17dz prepare voucher.proposal <file>`（serve 法域、剥 `EXECUTION_REQUIRE_PLAN`，修 D-081），解析 RESULT 信封：completed → 落 B2 的记录 + 生成确认码，用户可见文本 = **平台 `summaryText` 原样 + 通用确认行**（宿主的借贷合计渲染在新路径上一行不写）；`needs_input` → 按确定性线索交还 worker；failed → 交还错误码 |
| B4 | 新 commit 后端 + 三笔债 | `apps/server/proposal-commit.ts`（新，薄）：`bin/17dz commit voucher.commit --proposal-id <id>`，令牌 = HMAC over `{proposalId, expiresAt}`（不绑脚本名/业务字段）。`matchConfirmation` 按 `proposalId` 分流到新后端。**D-080**：confirm 分支按**确认时点**复核 capability（提案到确认之间能力被收回正是该缺口形状）；**D-081**：宿主直调显式剥 `EXECUTION_REQUIRE_PLAN`；**D-082**：committed 与 confirm_failed 两个分支都 upsert originating `platform_tasks` 的 outcome |
| B5 | 测试 | `proposal-runtime.test.ts`（B1，不起 harness）；`proposal-flow.test.ts`/e2e 写链路改走新路径（mock）：create→确认→commit→读回四态 + needs_input + 写关闭 + 影子不一致事件 + W5 旧行 fail-closed + W4 三态翻转（都是"现在红、修完绿"） |

**B 波明确不做**：不删旧文本路径与 `commit.ts` 遗留 runner（C 波）、不清 leak-lint 三条"遗留待清"（`context.ts: 借贷` 在新路径上不再产生，但旧路径仍在使用它，C 波一起清）、不碰真平台。

**B 波前置项（A 波实证）**：period ↔ 契约日期一致性校验未做（声明 7 月、契约 8 月会真落账后读回增量 0 → `PROPOSAL_VERIFY_SHORT` 响亮失败）。切流前要么平台在 create 挡掉，要么宿主侧加一道通用前置（不解释业务语义，只把平台返回的拒绝透传）。

### B 波第 1 批已落地（2026-10-12，fshine 侧，未 commit）：B1 + B2

**B1**：`packages/agent/src/proposal-runtime.ts`（新，纯函数）`parseProposalCommand(command, protocols)`；`operation-labels.ts` 加第四张只读消费表 `protocol` 列（`parseOperationProtocols` / `loadOperationProtocols`，失败语义与另外三个 loader 逐条一致：无 root / CLI 缺失 / 3s 超时 / 非零退出 / 坏 JSON → 空 Map = 不拦截）；`index.ts` 导出公共部分。判据 = 网关首词 + `prepare` 模式 + **operation 名**（不是脚本路径）+ protocol 列映到 `proposal.create`；payload 路径作为不透明字符串原样带回。15 条单测（不起 harness）钉住各形状。

**B2**：`ChangeIntentRecord` 瘦身为 `{intentId, principalId, sessionId, taskId?, proposalId?, confirmCodeHash, status, createdAt, expiresAt, decidedAt?, result?}`——零业务字段、零 payload；`ChangeIntentRepo` 六个方法形状一个没动（没有"只为业务字段而存在"的方法）。`change_intents` 加 `proposal_id` / `task_id` 两列（缺列即补的同一套前向迁移；`task_id` 是 B4 的 D-082  originating-task 回填要用的关联 id，故与 `proposal_id` 一起补，避免出现"契约有、存储悄悄丢"的字段）。旧五列（kind/account_set/period/payload/summary）不再读、不再写，列留着做历史；旧库 NOT NULL 无缺省，插入补空串兼容值（与 `principal_scopes.mcp_profile` 同一手法）。`rowToChangeIntent` 只映射新字段。`context.ts` 用私有 `LegacyChangeIntentRecord`（字段全可选）承载旧路径的旧字段，**不回填 contracts**。

**本批撞见的两条实证限制（下一批前必须裁决）**：

1. **B2 单独落地会把旧文本路径的落账能力一起切断**。契约零 payload + store 不再读写旧列 ⇒ 旧路径建的 intent 读回来没有冻结载荷 ⇒ 确认步按 W5 一律 `confirm_stale`（就地置 expired），不 commit、不盲写（这条 fail-closed 是刻意加的：否则 `commitRunner` 会拿到 `contracts: undefined` 并在 `stageContract` 抛 TypeError，用户既没有回复也没有留痕）。后果：**B2 与 B3 之间不存在"开关关着也能写"的窗口**——回滚开关（`FSHINE_PROPOSAL_VIA_GATEWAY` 关）在这段窗口里只能回到"能预览、不能落账"。要么 B2 与 B3 同批上线，要么显式接受该窗口。受影响的 e2e（`turn-loop-write-chain` B1/B4/B6、`turn-loop-long-session-invariants` S1 R9/R13 与 S2、`turn-loop-security` D3 入口③）已按新语义改写；`invariant-checker` 的 S2"宣称几张 vs 实际增几张"比对随之降级为只记录不断言（数据源随 payload 离开宿主），该断言改拿平台 commit 读回计数在 B5 重建；落账执行器自身的覆盖（prepare dry-run / commit+令牌 / 读回）仍在 `apps/server/commit.test.ts`，一条没少。D-080（确认时点 capability 复核）的缺口本身没修，只是随旧路径失去观测点——B4 新后端落地时翻回 W4 第一条的翻转断言。
2. **`operation run <operation>` 形态不在 B1 判据内**（只认 `prepare` 模式）。平台侧 A 波已对 runner / `operation run` / 建造模式寻址都加了 protocol-keyed 守卫，所以那条路**能**创建提案，而宿主不拦截 ⇒ 平台侧有提案、宿主侧无记录，用户拿不到确认码。B3 决定是否把判据扩到 `operation run`（`extractGateScript` 已能取到它的目标 token，扩它是一行；不扩则要在 skill/提示词层面禁掉该形态，而"靠约定"正是本仓不依赖的东西）。

**验收（本批，全 mock）**：`npx vitest run packages/agent/proposal-runtime.test.ts` 15 绿；`packages/core/store.test.ts` 67 绿（含新列往返 / 旧行读回不带 proposalId / 缺列即补 / 历史列不被污染四条）；`npm test` 88 文件 1198 用例全绿（基线 1179，净 +19）；`npm run typecheck` 0 错误；泄漏预算与架构形状（无 import 环、runtime.ts 行数预算）不变。

### B 波第 2 批已落地（2026-10-12，fshine 侧，未 commit）：B3 + W1/W2

**B3 拦截点**（`pi-coding-driver.ts` 的 `beforeToolCall`，计划解析之后、`gate()` 之前一支）：判据 = B1 的 `parseProposalCommand` + 开关。开关关着时整支不出现（`proposalViaGateway(options.env)`，默认关）；开着才解析命令。protocol 表与 label/argStyles/语义三张表同一手法按 root 缓存一次（`loadOperationProtocols`，拿不到表 = 空 = 不拦截），驱动侧与测试替身注入点同族（`operationProtocols`）。**payload 路径过一道通用文件边界检查**（安全，非业务）：`workspaceRelPath` 解析后必须落在本轮 scratchDir（`tmp/<requestId>`）内，否则 `PROPOSAL REFUSED` 且**不办调**——否则等于让 worker 指使平台读工作区任意文件、再把错误信息带回来看（`isInsideScratch` 从 serve-gate 导出，与 write 门同一把尺）。拦截后走 `options.onCreateProposal`（宿主经 `TurnDriverInput` 注入，与 `onNotice` 同族；驱动侧与 `onPendingPlan` 同族 latch 结局），三态处理：completed → 给 worker 确定性消息（**不含确认码**）+ 本回合以此终结；needs_input → 线索进 `needsClues`（平台信封的 `data.needs[].name`，零 worker 文本解析）；failed → 交还平台错误码；write_closed → 复用 `writeClosed` 透传。拦截与结果都落审计（`tool: 'proposal_create'`，allowed 恒 false → assembly 落 `GATE_BLOCKED`，与 `plan_submit` 同族：这条路径提前 return，不经 gate()）。

**B3 capability 复核**（`context.ts` 的 `createProposalViaGateway`）：`ctx.trusted.capabilities` 不含 `write` → 当场合成 `WRITE_NOT_ENABLED`（error-codes.ts 唯一来源）并返回 `write_closed`，**零平台调用**（A 波当时的标定：`access: scratch` ⇒ 计划扫描兜底不触发（**2026-10-14 已变**：`a683df2` 改成 `write`，只读部署下计划扫描会先兜住提案步），这一刀仍由宿主自己下）。同处保留旧路径的授权名单限制模式判据（host-held scope，payload 不透明不等于可以把允许名单受限主体的写面放大）。含 write → spawn `bin/17dz prepare <operation> <payloadPath>`（cwd = platformRoot，**env 显式剥 `EXECUTION_REQUIRE_PLAN`**，修 D-081；operation 名来自拦截时取到的目标 token，宿主不另持业务名单），`parseEnvelope` 分流：completed → 落新形状 `ChangeIntentRecord`（`proposalId` + `taskId` + 通用字段，零业务字段）+ 现有 `CODE_ALPHABET`/`hashCode` 机制原样 → 用户可见文本 = **平台 `summaryText` 原样**（控制字符/空白卫生 + 500 截断，与 correctFormOf 同族）+ 通用确认行（`confirmLineFor`，两条路同一把尺）；needs_input → 结构化线索；failed → 平台错误码。新 pending 记录经现有 `changeIntents` 仓库落库（改动小的那个选项），旧 pending 照样置 superseded。

**W1/W2 开关与影子**：`FSHINE_PROPOSAL_VIA_GATEWAY` 默认关（`platform-mock.ts` 的 `proposalViaGateway()`，与 `isCommitEnabled` 同一处读 env；leak-lint 的 FSHINE_* 登记表已登记，C 波删旧路径时随开关退役）。关 = 宿主不注入回调 + 驱动不拦截。开 = 拦截生效，**并且** legacy `finalizeProposal` 的 `ci.create` + "把旧 pending 置 superseded" 一并关掉（B 波第 1 批实证的第三点：否则旧路径会把新路径刚建的 pending 记录 superseded 掉，用户手里的码随之失效）；此时 worker 终稿里仍带旧形态提案 JSON 的，只落 `proposal_shadow_mismatch` 事件，不生效、不解析、不落库。开关状态每回合留痕（`delegation_gateway_state` 日志一行 + 拦截处的 tool_calls 一行）。**与 W2 字面（"每回合进审计"）的一处偏差**：开关关着时本回合没有任何门事件可挂（没有门事件就没有 tool_calls 行），故"每回合"那一份由结构化日志承载（与 delegation_span/turn_span 同一族）；要把关着的状态也写进 tool_calls，得给 TrustedContext 加审计出口——那是契约面改动，超出本批范围，记为 B 波合成 commit 前的待决项。

**判据扩到 `operation run`**（B 波第 1 批遗留限制 2 的裁决：扩）：`parseProposalCommand` 现在认 `prepare <operation>` 与 `operation run <operation>` 两种寻址形态（平台对两条路都有 protocol-keyed 守卫，少认一条就多一个"平台有提案、宿主无条目"的缺口）。目标 token 仍由 `extractGateScript` 这唯一解读者取，payload 起始下标按形态算。

**runtime 侧接线**：`proposalCreated: {proposalId}` 从 driver → context → runtime 透传，runtime 用它把宿主持有的文本作为本轮回复（与 `writeClosed` 同族：`delegationFailed` 让出口校验放行——提案这一步可能零网关执行，而"提案已登记、等用户确认"是真实状态，被零执行门换成 `NO_EXECUTION_CLARIFICATION` 会让确认码永远到不了用户）。计划模式的零执行熔断同样豁免它（`noteZeroExecStep` 的 `proposalCreated`，与 `writeClosed` 同理由）。`matchConfirmation` 对带 `proposalId` 的条目加一道 fail-closed（B4 落地前的占位）：不落账，也不借"已过期"说谎——提案保持 pending，B4 接上后同一个码仍然有效。`runtime.ts` 行数预算 1203 → 1221（功能新增，已在守卫注释里记账）。

**用户可见文本的最终拼法**（e2e 实跑样例，第一行平台 `summaryText` 原样、第二行宿主通用确认行，中间一个换行；宿主不拼对象/时间/条目/借贷合计任何一行）：

```
待确认提案 prop_bf759dbf-1269-4b13-b3b9-ec5b5cdbf444：账套「幻辰财税」2026年09月，共 2 张凭证，借方合计 1,234.00，贷方合计 1,234.00。确认后由系统执行录入；有效期至 2026-10-12T05:18:44.479Z。
回复「确认 SKGVA4」完成确认流程（当前落账执行未启用——确认不会写入任何数据）；回复「取消 SKGVA4」作废。10 分钟内有效。
```

**已知缺口（留给 B4/B5）**：① `--batch`（一次创建多个提案）不转发——带了就在平台 schema 处响亮失败，不会静默建错；② 新路径的确认行在 `proposalCommitEnabled`（新选项，默认 false）为真时才承诺落账，B4 接线后由部署层置真；③ 计划模式里提案一步的步骤结局按机械事实记 'failed'（零执行），不影响用户看到的文本；④ 开关新名字未进 `.env.example`（本批只准改 §4 记录，`.env.example` 文档随 B 波合成 commit 补）；⑤ 影子期开关开着而 worker 仍贴旧形态提案 JSON 时，按 W1 只记录事件、不生效不落库——那一轮的用户回复因此是 worker 原文（含 JSON），文本卫生比旧路径差；这是"只记录"的字面语义，切流（W1 零差异）后随旧形态一起消失。

**验收（本批，全 mock）**：`npx vitest run packages/agent/proposal-runtime.test.ts` 17 绿（含 `operation run` 四条新形状）；`packages/agent/proposal-flow.test.ts`（新，16 绿，不起 driver harness：宿主半用捕获回调的替身 worker 驱动，驱动半用真 `createPiCodingWorkerSession` + 直接调 `beforeToolCall`）覆盖 capability 不含 write → 写关闭话术且零办调 / 含 write → 办调 + 信封三态 / payload 越界（scratchDir 外、绝对路径、`../`）→ 拒绝且零办调 / env 剥 `EXECUTION_REQUIRE_PLAN`（断言替身收到的 env）/ 开关关 → 不注入回调 / needs_input 线索 / 审计一行；`tests/e2e/turn-loop-write-chain.test.ts` 12 绿（新增 4 条：开关打开下 create → 用户文本含平台 summaryText 与确认码 + 条目只持取物单、确认步 fail-closed 零写入、能力不含 write 时平台零办调、影子不一致只记录不落库）；`npm test` 89 文件 1220 用例全绿（B1+B2 后 1198，净 +22）；`npm run typecheck` 0 错误；泄漏预算（新 env 名已登记、无新增未归属业务词）与架构形状（无 import 环）通过。**全 mock**：不碰真平台、不起探针。

### B 波第 3 批已落地（2026-10-12，fshine 侧，未 commit）：B4 + B5

**B4 薄 commit 后端**（`apps/server/proposal-commit.ts`，新）：`bin/17dz commit <operation> --proposal-id <提案号>`，cwd = platformRoot，serve 法域（`hostGatewayEnv` 显式声明 `EXECUTION_SERVE=1` 并剥 `EXECUTION_REQUIRE_PLAN`——修 D-081；该函数从 context.ts 导出，创建与落账两处宿主办调共认一把尺）。**operation 名不硬编码**：按 `protocol` 列从 `operation list --json` 解析出角色为 `proposal.commit` 的那个 operation（`PROPOSAL_COMMIT_PROTOCOL` 与 B1 的 `PROPOSAL_CREATE_PROTOCOL` 同住 proposal-runtime.ts）；表拿不到 → **fail-closed 拒绝 commit**，不回落硬编码网关名。令牌 = HMAC-SHA256 over `{proposalId, expiresAt}`（不绑脚本名/业务字段——L4：宿主不该知道自己在提交什么业务），密钥用 assembly 已在生成的那把 `newGateSecret()`，只经 env 传给该子进程。落账前先向平台取问一次提案状态（平台 designated 的"宿主持有 proposalId 后的唯一取问"）：令牌必须绑提案自己的有效期，而那个值只存在于平台侧；同一问把"已过期 / 已终结 / 读不到"在办调之前现形。解析 `RESULT` 信封 `{ok, verified, summaryText}` → `ProposalCommitResult`；读回计数（before/after/delta/required）搬进审计留痕。与 `commit.ts` 的 legacy runner 并存，由记录形状分流。

**`matchConfirmation` 分流**（`context.ts`，判别只有一个：`rec.proposalId` 在不在）：在 → 新后端；不在 → legacy 分支一字不动。新分支做三件事——① **D-080**：confirm 时按**确认时点**复核 `capabilities.includes('write')`（"提案后收回写权限"正是这个缺口的形状），不通过 → 确定性拒绝（error-codes.ts 唯一来源的 WRITE_NOT_ENABLED）+ 意图保持 pending + 零办调；② **D-082**：committed 与 confirm_failed 两个分支都 upsert originating `platform_tasks` 的 outcome（记录里已有 taskId），`invariant-checker` L1 的 `expectedOpenTasks` 例外随之撤掉、转成硬断言；③ `proposalCommitEnabled` 为假 → `confirm_held`（与 legacy 的 `commitEnabled` 同语义）。提案在平台侧已不可用（expired / not_pending / unreadable）单独一支：`confirm_stale` + 意图归档，不谎称执行失败。

**接线开关**：`FSHINE_PROPOSAL_COMMIT`（platform-mock.ts 的 `proposalCommitWired()`，默认关）= 落账后端是否接上；与 `isCommitEnabled()` 串成 `proposalCommitEnabled = 接线 ∧ 放行`（mock ⇒ 真；真平台 ⇒ 还需 `FSHINE_REAL_COMMIT=1`）。与任务书"assembly 按 isCommitEnabled() 派生"的一处偏差：多串了一个接线开关——理由是落账要与创建一样能分段部署（先切创建、后切落账），且 confirm_held 这一态在 mock 下必须可达可测（否则它只在真平台无 REAL_COMMIT 时出现，而真平台不许碰）。后端本体只在接线时注入。`.env.example` 补登两个开关（`FSHINE_PROPOSAL_VIA_GATEWAY`、`FSHINE_PROPOSAL_COMMIT`）。

**用户可见成功文本**（e2e 实跑样例：第一行平台 `summaryText` 原样、第二行宿主通用状态行；宿主不拼任何业务摘要）：

```
提案 prop_a8f1606d-3028-4123-801e-7ab56eda22b6 已执行：账套「幻辰财税」2026年09月 录入 2 张凭证（借方合计 1,234.00，贷方合计 1,234.00）；读回校验通过（凭证数增加 2）。
确认码已核销，落账已完成。
```

**B5 测试**：`apps/server/proposal-commit.test.ts`（新，12 绿：角色列寻址 / 空表拒绝落账且零办调 / 令牌只绑两字段且密钥只进子进程 env / 剥 EXECUTION_REQUIRE_PLAN + serve 法域 / 取问三态 / 信封成败解析）；`proposal-flow.test.ts` 24 绿（+8：确认时点收回 write / 开关关 / 后端未注入 / 成败 / 不可用两态 / legacy 分流）；`turn-loop-write-chain.test.ts` 16 绿（+4：完整链 create→确认→commit→读回→任务终态 done、D-081 进程带 mandate 全链仍绿、已结账期 confirm_failed + 任务终态 failed + 零增量、D-080 端到端）；`turn-loop-security.test.ts` D3 入口③ 翻转为写关闭话术（16 绿）；`turn-loop-long-session-invariants.test.ts` S1/S2 改写网关路径全链并撤 `expectedOpenTasks`（4 绿）；`npm test` 90 文件 **1244** 用例全绿（B3 后 1220，净 +24）；`npm run typecheck` 0 错误；`npm run smoke:commit:mock` 绿；`grep -rn "voucher\.\|借贷\|accountSet" apps/server/proposal-commit.ts` 空输出。

**W4 三态翻转的变异验证**（本地改错 → 对应断言红 → 已还原）：① D-080——把确认时点的 capability 复核注掉，security D3 ③ / write-chain D-080 / proposal-flow 三条同时红（回复变成平台落账摘要，即"收回写权限仍然写成功"）；② D-081——把 `hostGatewayEnv` 的剥离子注掉，proposal-commit 的 env 纪律断言红（`expected '1' to be undefined`）；平台审计另给出为什么要剥的实证：serve 法域 + `EXECUTION_REQUIRE_PLAN=1` 下宿主直调的只读读回被计划门拒（`query verify-saved … serve:true refused PLAN_REQUIRED`），legacy runner 继承进程 env 不剥，读回计数即取不到；③ D-082——把创建时终态与两个分支的回写一并注掉（= B4 前的形状），long-session S1 在 checker 的 L1 上红（`任务 task_… 无终态（platform_tasks.outcome 为空）——悬挂`）；只注回写则 proposal-flow 与已结账期 e2e 红。

**纪律事件（必须记住）**：为取 D-081 的"现在红"证据写了一个临时 vitest 直驱 legacy commit runner，**忘了设 `EXECUTION_EXECUTOR=mock`**——vitest 不加载 `.env`（e2e harness 的 beforeAll 显式设它，我绕过了 harness），于是真 `fill.js` 以 serve 模式起来了 **3 次**（平台审计：`06:15:11Z / 06:16:22Z / 06:19:03Z`，`mode:commit, script:src/voucher/scripts/fill.js, serve:true`，无 mock 标志，各 ~47-49s 后 exit 1）。取证：三次都停在登录态/定位器阶段（`discoverToken attempt 1 failed: locator.waitFor Timeout`），**没有任何落账**（exit 1 即失败，未到保存步）；`.runtime/screens/`（Sep 29）、`.browser-profile/`（Sep 18）未被写；`.runtime/auth.json` 在 06:14:37Z 被重写一次（真跑的鉴权刷新）。教训：**任何不起 harness 的平台调用都必须自己显式带 `EXECUTION_EXECUTOR=mock`**，临时测试文件用完即删（已删）；"它失败得看起来无害"永远不能作为依赖。D-081 的翻转证据最终由 unit 级 env 纪律断言（变异即红）+ 平台审计里那条 PLAN_REQUIRED 记录承担，不再需要直驱真平台。

### C 波（收口）

删文本兜底、清 leak-lint 三条"遗留待清"登记（`context.ts: 借贷`、`commit.ts: 账套/凭证`）、重写 `turn-loop-write-chain.test.ts`、关 D-030/031/032/080/081/082、更新 v0-architecture §10 写路径行。

**防线**：

| # | 措施 | 机械判据 |
|---|---|---|
| W1 | 影子双跑 | B 波起旧文本路径仍生效，新网关路径只记录不一致（`proposal_shadow_mismatch` 事件）；mock + e2e 各若干轮零差异才切流 |
| W2 | 一键回滚开关 | `FSHINE_PROPOSAL_VIA_GATEWAY` 默认关；关开关 = 回今天路径，不 revert commit；开关状态每回合进审计 |
| W3 | mock 全链是唯一波次验收 | `smoke:commit:mock` + `acceptance` 5.x 写链路 mock 下全绿；**不碰真平台** |
| W4 | 安全三态翻转（D-080/081/082） | ① 提案后收回 write → 确认码必被拒；② server 带 `EXECUTION_REQUIRE_PLAN=1` 跑 commit 全链绿；③ commit 后 `platform_tasks` 有终态（invariant-checker 例外撤掉转硬断言）。三条都是"现在红、修完绿" |
| W5 | 旧数据 fail-closed | 旧 shape 的 pending intent 一律按过期处理；单测钉"旧行读回 → `confirm_stale`，不 commit" |
| W6 | 门禁不倒退 | 新拦截分支补三态（无激活计划 / 越权实体 / 能力关闭）；变异：plan 豁免判据改错 → 对应实证翻红 |
| W7 | 密钥不变量 | 激活密钥 / commit 密钥不进 worker env（grep 断言 + 现有测试随迁） |
| W8 | L4 机械守卫 | `ChangeIntentRecord` 字段名白名单断言（出现业务名即红）+ leak-lint 删三条登记（只减不增防回流） |

#### C 波已落地（2026-10-13，fshine commit `95bdede`）

**删掉的（按文件）**：`apps/server/commit.ts`（legacy 落账执行器：宿主解提案、物化契约、按文件路径 dry-run/commit/读回）与其单测；`context.ts` 的 `ChangeProposal` / `LegacyChangeIntentRecord` / `extractChangeProposal` / `finalizeProposal` / `ProposalOutcome` / `truncate` / legacy 确认分支 / 派发点 / 影子留痕分支，以及选项 `prepareRunner` / `commitRunner` / `maxBatchCount` / `commitEnabled` 与随之死掉的 `PrepareRequest` / `CommitRequest` 四个注入点接口；`platform-contract.ts` 的四个 voucher 操作名与 `parsePrepareOutcome` / `parseVerifyCount` / `PrepareOutcome`（唯一消费者是 commit.ts）+ `index.ts` 对应导出；leak-lint 三条"遗留待清"登记。

**保留下来的（新路径在用）**：`options.changeIntents` / `intentTtlMs` / `proposalGatewayRunner` / `proposalCommitEnabled` / `proposalCommitRunner`、`COMMIT_FAILED_LINE`、`writeBackTaskOutcome`、`confirmLineFor`、`summaryTextOf`、`proposalNeedsOf`、`createProposalViaGateway`、`confirmProposalViaGateway`、`hostGatewayEnv`、`defaultProposalGatewayRunner`。

**四个坑的处理**：

- **R1（取消码标签）**：`legacyIntentLabel` 的唯一调用点在取消分支，那是新旧路径**共用**的代码。删掉它就要同时改这条共享文案，而现有测试只有 legacy 用例断言过它。选择**保留该函数**（改名 `intentLabel`，因为 C 波后它就是唯一路径的那一个）：业务字段不在宿主库往返，一律降级成中性「本次录入提案」，不把 undefined 渲染给用户、也不为"更具体"去解析 worker 文本。配套补了两条网关路径的取消覆盖（`turn-loop-write-chain` 攻击面组的「取消 pending」「取消已作废码」）。
- **R2（`newGateSecret` 搬家）**：它原住要删的 `commit.ts`，却被 `assembly.ts` 与 `ask.ts` 用。搬到 `packages/agent/src/context.ts` 并与 `hostGatewayEnv` 同住（两者都是"宿主持有的直调法域"这一族事实），经 `index.ts` 导出；`proposal-commit.ts` 的注释着落同步更新。搬家早于删文件，生产启动编译不错。
- **R3（过期话术两份）**：898 行那份逐字抄写只删 legacy 分支内那一份，`PROPOSAL_UNAVAILABLE_TEXT.expired`（新路径 `unavailable:'expired'` 分支的唯一来源）保留。
- **R4（冒烟脚本）**：选**改写指向新路径**（选项 ①），不保留 legacy runner 只为冒烟。理由：保留它等于把 L4 违例的整条文本写路径留在编排层，leak-lint 的 `commit.ts: 账套/凭证` 两条登记也随之关不掉。新脚本三步 = 平台提案创建（protocol 角色列寻址 + `hostGatewayEnv` + 只认 RESULT 信封，与 `createProposalViaGateway` 同一把尺）→ `createProposalCommitRunner` 落账 + 平台读回 → mock 状态凭证数断言；**mock 保险丝原样保留**（检测不到 `EXECUTION_EXECUTOR=mock` 直接拒跑）。W3 的门没有退场。

**测试**：`context-proposal.test.ts` 18 条 legacy 删至 1 条（执行面回账）；`turn-loop-write-chain.test.ts` 删 8 条 legacy 后**把 7 条攻击面/覆盖用例移植到网关路径**（错误码 / TTL 过期 / 跨 session / 跨 principal / 连提两案 superseded / 取消 pending / 取消已作废码）——这些钉的是宿主持有的通用确认状态机，与提案载荷无关，随旧路径一起删就是静默丢安全覆盖；最终 15 条。`turn-loop-security.test.ts` D2 与 D3② 改写为网关路径等价物；`turn-loop-plan-gate-boundaries.test.ts` A5② 改写 + 文件头同步；`proposal-flow.test.ts` 删 legacy 通路用例与 `setupConfirm` 的 `legacy` 选项。

**R1 的落地**：`legacyIntentLabel` 保留并改名 `intentLabel`（C 波后它就是唯一路径的那一个），配套补的取消覆盖是上面那两条「取消 pending」「取消已作废码」。

**W5 的上层钉子**：`proposal-flow.test.ts` 原有一条"不带 proposalId 的旧路径条目仍走 legacy 分支"的用例（B 波分流判据的另一半），随 legacy 分支删除。同文件补回等价物「W5：不带 proposalId 的旧行业 → 一律按过期处理，confirm_stale + 零办调」——旧库 pending 行的 fail-closed 不因此失去单测钉子（存储层那一半在 `packages/core/store.test.ts` 的"旧行读回不带 proposalId"）。

**两处与侦察图不同、需知情**：

1. **影子留痕分支与影子不一致用例互斥**：`extractChangeProposal` 删掉后"检测 worker 终稿里有没有旧形态提案 JSON"这件事本身不存在了（那正是宿主嗅探 worker 文本，L4 要禁的形状），所以 `proposal_shadow_mismatch` 事件无处可发。保留该用例、改断言为"C 波后宿主压根不解析 worker 文本：零条目、零码、零写入、用户看到 worker 原文"。
2. **`turn-loop-write-chain.test.ts` 的条数**：验收行写的"必须 16/16"是 B 波末的基线（16 条 = 8 legacy + 8 新路径）。删 8 条 legacy 后满配应是 8 条；补 7 条移植后实际 **15 条**。

**`acceptance` 5.x**：写链路 mock 全链仍走网关路径（assembly 的接线未变），本波未改 `scripts/acceptance.ts`（他人所有权）。

### D 波（开关退役，收敛）

C 波后两个 B 波灰度开关各只剩一种行为，按侦察图 R10"先删旧路径、留开关恒开，开关退役单独一批"执行退役：`platform-mock.ts` 删 `proposalViaGateway` / `proposalCommitWired` 两个函数与其 ENV 常量，`pi-coding-driver.ts` 删 `proposalViaGateway` 可选字段与两处注入（拦截恒开），`context.ts` 删 `gatewayProposals` 门与 `delegation_gateway_state` 结构化日志，`assembly.ts` / `ask.ts` 改 `proposalCommitEnabled = isCommitEnabled(env)`（后端恒接），`.env.example` 删两条登记，leak-lint 的 FSHINE_* 登记表只减不增（两条删除）。

**防线**：

| # | 措施 | 机械判据 |
|---|---|---|
| X1 | 真平台闸门不削弱 | `isCommitEnabled` 仍是唯一出处且**单独**派生 `proposalCommitEnabled`；新增 `proposal-flow.test.ts` 的 `isCommitEnabled` 语义组（mock ⇒ 真 / 真平台缺 `FSHINE_REAL_COMMIT` ⇒ 假 / 显式置位 ⇒ 真），变异验证（把它临时改恒假）→ 该组 2 条 + `turn-loop-write-chain` 落账链 6 条翻红 |
| X2 | 不造第二份 env 判定 | 退役后无任何新 env 名字；`grep FSHINE_PROPOSAL` 在 packages/apps/scripts 下为 0（含注释——leak-lint 的"未登记即红"顺带把注释里的复活也抓住） |
| X3 | mock 保险丝不碰 | `smoke:commit:mock` 的 `EXECUTION_EXECUTOR=mock` 拒跑分支未动，`EXECUTION_EXECUTOR=mock npm run smoke:commit:mock` PASS |
| X4 | 默认部署行为有钉子 | `turn-loop-write-chain.test.ts` 全部用例**不再设任何 env**，"不设开关也走网关路径"由每条用例直接钉住 |

**行为差异（默认部署 `.env`：`EXECUTION_EXECUTOR=mock`、无两个开关、`capabilities:["read"]`）**：提案命令由"不拦（开关默认关）"变为**恒定拦下**；确认码由"只有开了 `FSHINE_PROPOSAL_COMMIT` 才落账"变为**恒定落账**（mock 下 `isCommitEnabled` 恒真）；真平台无 `FSHINE_REAL_COMMIT` 仍是确定性拒绝 + 零写入（唯一闸门未动）；真平台有 `FSHINE_REAL_COMMIT=1` 行为不变。**覆盖面的实质变化**：confirm_held（确认收到但不写）从此是**真平台专属态**，mock 下不可达——原先靠"关掉落账开关"在 mock 里造出这一态的 e2e 用例改写为"mock 之下落账恒放行"，fail-closed 的判据改由 `proposal-flow.test.ts` 的 `proposalCommitEnabled=false` 一支 + X1 的语义组共同钉住。

**`delegation_gateway_state` 的选择（整行删）**：该行唯一的 payload 是 `proposalGateway` 布尔，布尔退役后恒真，不再回答任何问题；它服务的取证问题（"这一回合走哪条路"）随之只有唯一答案，由代码结构承载而非每回合一个常量字段。仍要问的"这一回合有没有走到提案步"有更强的事实面：拦截处必有 `tool_calls` 一行（`tool: 'proposal_create'`，含拒绝原因），建成时有 `proposal_created` 事件与 `delegation_span` 的 `proposal_created` 结局。删除处在 `context.ts` 的接线注释里留了说明，避免后来者误以为漏删。

### 上线门（**不属于本次波次验收**，单独清单）

前置条件全满足才允许开真平台写：① D-076 登录页改版修好；② 写 latent 七项（S2/S3/S4/S5③/S7/S9/S10）在 17dz 关闭；③ `FSHINE_REAL_COMMIT` 显式置位并留审批记录；④ 一次真平台手工写留档（dry-run exit1→修→exit0→commit→读回计数 ≥ 提案张数，平台 audit 与宿主 `tool_calls` 两侧对得上）。

---

## 5. 执行顺序与回滚

**顺序**：方案 3 → 方案 2 → 方案 1。方案 3 半天可完；方案 2 穿插做，越早越便宜；方案 1 每波独立交付、独立回滚。

**回滚**：方案 3 = revert 一个 md；方案 2 = revert 一个 refactor commit（golden 保证行为不变，回滚无风险）；方案 1 = A 波 revert 平台命令、B/C 波 revert 对应 commit（B 波起那两个灰度开关已在 D 波退役，**不能再靠"关开关"回滚**——回滚目标只能是 revert commit）；D 波 revert 后两个开关恢复存在，真平台写始终由 `FSHINE_REAL_COMMIT` 把守，与这些开关无关。

**归因纪律**：任何一步测试红，先 revert 该 commit（F5），不在红上叠补丁。三波不混 commit（F4），否则回归无法归因到波次。

---

## 6. E 波 · 实体门标定修复 + 验收仪器 surfaced（2026-10-14）

**目标**：关掉台账 5 条待办债（D-085 / D-086 / D-087 / D-088 / D-091）。四者同源——2026-10-13 写路径真模型三轮实测里 worker 在计划门上反复撞墙、最终只对用户说"操作申请已用尽"，而真正的拒绝原因一直在审计库里记着，却没有出口带到人眼前。

**改动（五个 commit，一个 commit 一件事，不混波）**：

| # | commit | 内容 |
|---|---|---|
| E1 | fshine `7281daf` | **D-086**：实体门不再把宿主自己的拒绝理由当实体证据（按 `toolCallId` 身份排除） |
| E2 | fshine `2e2a699` | **D-085**：实体来源覆盖改为"本任务迄今全部平台证据"（删条数窗口、保头改保尾、双通道、信封叶值作附加来源） |
| E3 | fshine `3beb3b5` | **D-087**：验收报告 surfaced 计划门拒绝明细 |
| E4 | 17dz `963e088` | **D-091**：`voucher.validate` 声明与实现对齐（`read` → `scratch`） |
| E5 | fshine 本 commit | 台账 + 本节 + architecture-laws 三问重答 + v0-architecture 同步 |

**防线**：

| # | 措施 | 机械判据 |
|---|---|---|
| E1 | 表征测试先行 | 每条新测试先在基线 commit 上跑出**红**（D-086 的绕过在改前确实放行：第二次提交返回 `PLAN ACTIVE`），再落修复 |
| E2 | golden 一字不改 | `turn-contract.test.ts` 12 条既有断言、`pi-coding-driver.test.ts` `:572/608/649/700/736/769`、`pi-coding-driver-plan-audit.test.ts`、`context.test.ts` `:495/524`、`runtime.test.ts` `:1191` 与 SE1–SE5、`session-entities.test.ts` 14 条、`error-codes.test.ts`、三个 e2e 文件——全部未改且全绿 |
| E3 | 用例数只增不减 | 1228 → 1267（+39：E1 六条驱动级 + E2 十五条纯函数/四条 turn-contract/五条驱动级 + E3 九条），90 → 92 文件 |
| E4 | 变异验证 | 十项"改错必须红"全部实测通过（见下） |
| E5 | 门禁不削弱 | 实体门的 fail-closed 判据一字未动；新增"防幻觉功能不变"对抗用例（名字不在任何来源里照样被拒）；`isError` 过滤与文案前缀嗅探两条捷径各有单测钉住"不能用" |
| E6 | 无 import 环 | `turn-contract → platform-entities → platform-contract`、`platform-entities → session-entities`，单向；`architecture-shape.test.ts` 绿 |
| E7 | 业务词不进宿主 src | leak-lint 4/4（`platform-entities.ts` 注释里"目录"改成"名称检索"——词不承重，改措辞不加白名单） |
| E8 | 只跑 mock | 全程 `EXECUTION_EXECUTOR=mock` 字面；`FSHINE_REAL_COMMIT` 空、`EXECUTION_ALLOW_REAL` 缺席；D-091 的"非 mock 不误报"改由类级单测承担，**没有**跑任何非 mock 的 `bin/17dz` |

**十项变异验证（本地改错 → 对应断言红 → 已还原）**：
E1 四项——删 block 分支记账 / 删 catch 分支记账 / 身份判据换 `isError` / 身份判据换 `toolName`。
E2 六项——覆盖判据改回 `slice(-20)` / 保尾改保头 / haystack 删 `platformEntities` / 删账本 `record` / 删转录通道只留账本（7 条红）/ 保尾常数调大 10 倍。
E3 一项——删 SQL 的 `tool_name` 过滤。
E4 三项——17dz 侧把 `access` 改回 `read` → `test-gate.js` 2 条 + `test-real-execution-gate.js` 1 条全红，且 mock 下 `prepare` 复现 `OPERATION_NOT_MOCKED` exit 3。

### E 波的两个判断点（判据被改写的理由，留档）

1. **D-085 的闭环判据字面实现不了**。原字面是「haystack 覆盖从"最后 N 条"改为**本任务迄今全部 toolResult 的结构化实体集合**」。现场证伪：信封 `data` 的每个字符串叶都是它所在响应原文的子串（`RESULT` 在 stdout 末行、SDK bash 工具保尾弃头），所以"只收结构化叶值"是**可证的收窄**——会打破 golden `turn-contract.test.ts:235`（该用例用的就是非信封原文），并新拒「幻电设备」vs 平台返回「幻电设备有限公司」这类缩写/简称形状，方向与修假拒相反。**改为**：覆盖 = 本任务迄今全部 toolResult 原文（双通道）+ 信封 `data` 的结构化叶值作为**附加**第二来源（additive，只增覆盖），包含判据仍是逐字包含。理由与判据改写都记在台账 D-085 主条目里。
2. **D-091 的「非 mock 无 `EXECUTION_ALLOW_REAL` 也 exit 0」不真跑**。§0 禁止任何不带 `EXECUTION_EXECUTOR=mock` 的 `bin/17dz` 调用，所以该条由 `test-real-execution-gate.js` 的类级断言（从清单读 `voucher.validate` 的声明 → `touchesPlatformOf === false`）承担。另两条（mock 下 exit 0 有输出、`EXECUTION_REQUIRE_PLAN=1` 不索要 `EXECUTION_PLAN_ID`）实跑通过。

### E 波新发现的一条根因（台账原先没有）

SDK 默认开**自动压缩**（`DEFAULT_COMPACTION_SETTINGS`，阈值 = contextWindow − reserveTokens；本部署 128K ⇒ ≈111 616 token）。一到阈值 `agent.state.messages` 被换成 `[压缩摘要] + [保留尾段]`（`keepRecentTokens` ≈ 80KB），早期 tool_result 整条消失。**D-085 自己的证据（单请求 87 次 tool_call）正是会触发压缩的长任务形状**，所以"本任务迄今全部"靠读转录到不了——覆盖判据因此物化成两个通道：转录通道 + 宿主在 `afterToolCall` 上的账本通道（压缩免疫，且 SDK 不给被拦下的调用调它，结构上不含宿主拒绝文本）。

### 首轮真模型基线（D-088 的第一步，2026-10-14）

`npm run acceptance --only=5.1,5.1b,5.2,5.3,5.4`，`EXECUTION_EXECUTOR=mock`，报告 `data/acceptance-report-202610140425.md`。

**仪器本身达标**：报告首次带出「计划门裁决 / 计划门拒绝明细」两节——5.1 的 6 次裁决、5.3 的 4 次全部列明理由与 calls 摘要。换在 E3 之前，这两节的位置只有 worker 终稿那一句。这一条同时是 D-087 的闭环证据。

**首轮未达成 D-088 的字面判据**（无 `prop_*`、5.2 被跳过），原因有三层，按报告可直接归因：

1. **部署姿态**：本地 `config/agent.yaml` 的主体 `capabilities: ["read"]`，写未开放。5.1 的计划里出现 `voucher.proposal` 时被 D-075 的计划扫描兜住（`PLAN STOP 当前未开放写入权限`，detail 逐字列出该调用）→ worker 拿不到提案步 → 回复不含确认码 → 5.2/5.4 按既有逻辑跳过。**这不是本轮引入的缺陷**，但它是 D-090 的一个后果：17dz `a683df2` 把 `voucher.proposal` 从 `scratch` 改成 `write` 之后，计划扫描兜底**首次对提案步生效**（B 波记录的"对提案步不触发"已因此过时，本文上方已更正）。要跑 D-088 的字面判据，必须把该主体 `capabilities` 开到含 `write`。
2. **模型侧形状问题（两例，均可在报告节里直接读出）**：① worker 发了 `operation list` / `operation.list` 这个**不存在的 operation**，平台回 `PLAN_REFUSE UNKNOWN_OPERATION`，两次都以 `PLAN PAUSED` 收场；② 计划 JSON 形状不合法（`PLAN_JSON_PARSE: No number after minus sign in JSON at position 1`），5.3 里出现两次。
3. **D-085/D-086 的修复没有可观测的负面效应**：本轮的 10 次 declined 里没有一次是 `ENTITY_OUT_OF_SCOPE`——三类静默拒绝里最相关的那一族本轮零命中，与"窗口已删、假拒来源已除"的方向一致（样本仅一轮，不作为结论）。

**登记口径**：按 architecture-laws 的关账纪律，D-088 **不标已关**（字面判据是连续三轮，且本轮写链路未开放）。第 1 层是部署姿态选择，第 2 层是新观察到的模型侧失效，两条都记进台账待后续处置。

### D-088 复跑的第二/第三轮，与暴露的新缺陷 D-096（2026-10-14）

E 波代码落地后为跑 D-088 做了两轮补充复跑（都只跑 mock；`config/agent.yaml` 的本地主体临时开到 `capabilities: ["read","write"]`，`.env` 的 `EXECUTION_EXECUTOR=mock` 与空的 `FSHINE_REAL_COMMIT` 两道闸未动）：

| 轮次 | 报告 | 结果 |
|---|---|---|
| 首轮（写关闭） | `acceptance-report-202610140425.md` | 5.1 被 D-075 计划扫描兜住（`voucher.proposal` 因 D-090 改成 `write` 后首次对提案步生效），到不了提案步 |
| 第二轮（写开放） | `acceptance-report-202610140749.md` | **暴露 D-096**：两次 `PLAN STOP 当前未开放写入权限`，而 `plan_write_not_enabled` 事件零次、库里 capabilities 明明是 `["read","write"]`——假归因。已修（`4aeab16`） |
| 第三轮（D-096 修后） | `acceptance-report-202610140830.md` | 假归因已除（计划门裁决 8→2、declined 5→1），但 worker 没产出形状合法的计划（`PLAN_JSON_PARSE` + 把 CLI 子命令 `operation list` 塞进计划的 calls），终稿只剩"子任务执行失败" |

**D-096 的修法与边界**：只改"该说哪句话"，不动任何门禁判定。分流增补 `capabilities`（只有 `needsConfirm && !capabilities.includes('write')` 才说 `WRITE_NOT_ENABLED`），点名判据从 `plan === false` 改成平台真判据 `!(plan && !confirm)`（写类因此点得出名字）。缺省不传 `capabilities` 按只读判，与 `planWriteClosed` 的"空 capabilities 视为只读"同约定——**写关闭那条路的行为一字未变**（D-075 前置扫描在 evaluate 之前就拦下，平台门一次都不咨询，给出的仍是同一句话）。两条路在"没开放写"上收敛，在"已开放写"上分开：前者说权限，后者点名 + 让 worker 改成直接调用。

**由此得到的判据**：D-088 剩余的不是宿主/平台侧缺陷，而是模型在计划门交互上的真实方差（D-095：方案 JSON 形状、把 CLI 子命令当 operation）。清掉可修项之后要的是多轮复跑取稳定率，不是继续改代码。**仪器侧已达标**——三轮里每一轮的拒绝原因都能从报告直接读出，换在 E3 之前只有 worker 终稿那一句。

### 连续三轮复跑的结果（2026-10-14，mock，本地主体临时 `["read","write"]`）

| 轮 | 报告 | 5.1 提案 | 确认码 | 5.2 落账 | 计划门裁决（declined） | 判定 |
|---|---|---|---|---|---|---|
| ① | `acceptance-report-202610140902.md` | `prop_8ef3fd97-…` | `4R2V98` | 已执行，读回 +1 | 6（2） | **PASS** |
| ② | `acceptance-report-202610140911.md` | 无 | — | 跳过（5.2/5.4） | 4（1） | **FAIL** |
| ③ | `acceptance-report-202610140920.md` | `prop_38603366-…` | `RZE78N` | 已执行，读回 +1 | 5（2） | **PASS** |

**2/3，未达成 D-088 字面判据的"连续三轮"**，按关账纪律不标已关。但失败的归因是干净的：

- 三轮里计划门的拒绝**全部可行动**，没有一次 `ENTITY_OUT_OF_SCOPE`、没有一次假归因；D-096 的修复在轮②直接可见——宿主给出 `不该放进计划的是：voucher.proposal。请…改为直接调用`，worker 也照办把那个调用移出了计划。
- 轮② 的死因是 **D-097（新登记）**：worker 跑完全部只读核实后停在下一次交互，终稿写"确认后由系统执行录入"，而审计库里 `proposal_create` 行 **0 条**、`tmp/<requestId>/proposal.json` 从未落盘。这是 D-075 记录的 T7 事故形状，只是发生在写开放的配置下。
- **没有宿主/平台侧的代码可修**：三轮已把可修项全部清掉（D-084/085/086/089/090/096）。剩下的修法在 17dz 的 serve SKILL 文案（D-097），且需先裁决"是否动执行层 SKILL"。

**方法论收获**：E3 的仪器在这三轮里每次都直接给出归因。轮② 若没有「计划门拒绝明细」那一节，看到的只有 worker 终稿那句"确认后由系统执行录入"——一个看起来成功、实际什么都没发生的回复；而现在能一眼看出"宿主给过正确指令、worker 没执行、提案步零尝试"。

### 架构收敛性自查（2026-10-14）与 D-097 的修法定性

用户提问："整个架构开始收敛了吗？是修 bug 还是在堆砌机制。"用数字回答：

| 指标 | 改造前 | 现在 | 读法 |
|---|---|---|---|
| `decidePlanSubmission`（全仓最复杂函数）判定点 | 14 | **13** | 没涨——双通道/身份排除/附加来源都加上了，这个函数反而更简单 |
| E 波净增（生产 / 测试） | — | **+520 / +890** | 测试:生产 ≈ 1.7:1，不是堆了没锁的机制 |
| 四个 bug 的修法规模 | — | 2 个 JSON 字段 / 1 个漏传参数 / 1 个 Set + 1 层 wrapper / 删 2 个常数 | 全部外科手术，无一需要新抽象 |
| 写路径失败模式 | 5 个独立的宿主/平台缺陷 | 3 轮里 2 轮跑通全链，唯一失败是模型 workflow 缺口 | 确定性层已收敛到"剩下的是模型" |

**结论：确定性层已收敛；机制数还在涨；下一个待修项一度是错类别。**

支持"堆砌"的一面如实记账：实体门 haystack 现有 4 个来源 + 1 个附加投影、经 2 个通道交付、外加一个身份排除集合——每件都有据可查，合起来已远超"这个字符串用户或平台说过吗"的直觉；且一个波次登记了 4 条新债。

**最锋利的一点**：D-097 的修法是在 SKILL 里加一句话，而本项目律法写着"软控制不是控制，是请求"。按字面修 = 加一个软控制 = 堆砌机制，且散文无法机械验证。**定性结论：这不叫新机制，叫修正含混文本**——那句话本来就在 SKILL 里，改的是它的前提（17dz `6b7ea09`）。据此立的三条纪律：

1. **冻结实体门**：不再加来源、通道、上限。再出问题默认"登记 + 接受"，除非是安全洞。
2. **D-097 按"修正含混文本"修，不按"加控制"修**，且修完不算关闭模型方差问题。
3. **不为 D-097 建宿主侧守门**：那条不变量 + 重试循环会为抓一个 2/3 概率成功的模型行为新增一套机制，并在"worker 合理地先问用户"的回合误触；宿主不该靠嗅探 worker 文本来补（L4）。

**下一处该投的是 L7（可信度可量化，至今违例"未建"）**：本波的三轮复跑是手工提取 `prop_*`/确认码/落账三个指标的，而这正是 17dz architecture.md 自己写着"让机器报漂移，替代人工复盘"的事。再建一道门是堆机制；建一个可重复跑、能报漂移的打分器是收敛。**（已于 2026-10-16 L7 波兑现，见 §7 与 debt-ledger D-060 关账记录。）**

### D-097 修后连续三轮：3/3 通过，D-088 与 D-097 双双关账（2026-10-14）

17dz `6b7ea09`（prepare SKILL 第 3 步显式声明前提）之后复跑三轮，mock 执行器 + 写开放（本地 `config/agent.yaml` 主体临时 `["read","write"]`；`.env` 的 `EXECUTION_EXECUTOR=mock` 与空的 `FSHINE_REAL_COMMIT` 两道闸未动；命令行不传任何 `EXECUTION_EXECUTOR`）：

| 轮 | 报告 | 提案 | 确认码 | 落账 / 读回 | 承诺句 × `proposal_create` 行 | 判定 |
|---|---|---|---|---|---|---|
| ① | `acceptance-report-202610141202.md` | `prop_68c39c11-…` | `GK74HC` | 已执行，凭证数 +1 | 4 × 1 | **PASS** |
| ② | `acceptance-report-202610141209.md` | `prop_70535385-…` | `UF6HCA` | 已执行，凭证数 +1 | 7 × 1 | **PASS** |
| ③ | `acceptance-report-202610141217.md` | `prop_131f91fd-…` | `WFVSKC` | 已执行，凭证数 +1 | 4 × 1 | **PASS** |

- **D-088 已关**：字面判据"连续三轮 5.1 均产出 `prop_*` 且 5.2 能取到 6 位确认码完成落账"全部达成。
- **D-097 已关**：机械判据"终稿含该承诺句"与"审计库有 `proposal_create` 行"两条同时为真，三轮全部满足（反例曾是 4 × 0）。
- **边界留档**：三轮证的是"真模型 + mock 执行器"这一条腿。真平台仍由 §4 上线门四条把守（D-076 登录页改版、写 latent 七项、`FSHINE_REAL_COMMIT` 显式置位 + 审批记录、一次真平台手工写留档），本条不替代它。
- **对比基线**：改造前同一条用例三轮全失败（D-067 附条的"操作申请已用尽"、D-088 轮③ 反复 `PLAN_NOT_PLANNABLE` 后撞上限放弃）。本波修掉 D-084/085/086/089/090/096 六项后 3/3。
- **仪器侧**：三轮每一轮的拒绝原因都能从报告直接读出，且本轮首次能机械地判定 D-097 的判据（承诺句计数 × `proposal_create` 行计数），不需要人读终稿下判断。

**本波最终账**：关 7 条（D-085/086/087/088/091/094/097），新登记 4 条（D-093/095/096/097 中 D-096/097 已关，净新增 D-093/095/096 三条待办 + D-095 watch）。E 波结束。

## 7. F 波 · L7 打分器落地（2026-10-16）

E 波末尾"下一处该投的是 L7"的兑现：Tier-1 打分器建成（D-060 关账，L7 转为不变量）。**它不是门，是仪器**——不进主流程、不拦任何生产路径；它回答的问题是"漂了没有、漂在哪"。

### 落了什么

| 件 | 位置 | 说明 |
|---|---|---|
| 四维归维表 | `scripts/eval/dims.ts` | 探针 note → 有据/实体保真/失败诚实/呈现卫生，单一来源；原句表征锁（`dims.test.ts`）钉住每条规则 |
| 写链三指标 | `scripts/eval/write-chain.ts` | 提案尝试（`serve_gate:proposal_create` 行）/ 落账+读回（`change_intents`）/ 确认码——§E 波末尾手工提取的三个指标自此机械提取 |
| 语料库 | `scripts/eval/corpus.jsonl` | 存量事故→用例的版本化映射：围栏→写链全链、驼峰→Y2、抽象泄漏→A3/A4、2048→D1（观察面）、复读→A2/A4、实体串台→A2 |
| 评委 | `scripts/eval/judge-prompt.md` + `judge.ts` | 四维 0/1/2 + 引文证据；只吃转录（与机械分量互不锚定）；版本 = 内容 sha256 |
| 打分器 | `scripts/eval/score.ts` + `baseline.json` | 四类阈值（dims 上限 / judge 下限−容差 / 写链布尔面 / okMode）；记分台 `.runtime/scores.jsonl`；回归 exit 1 |

### 怎么用

```bash
npm run eval            # 全链：探针基线集（真模型+mock）→ 写链 → 评委 → 比基线，回归 exit 1
npm run eval:score      # 只对现有报告评分（不重跑真模型）
npm run eval:baseline   # 基线重定（唯一入口；strict 用例 ok 翻转会拒绝烤入）
```

判定口径：**机械分量只增才算劣化**（A2 等观察项用 cap 表达"不劣化"档）；评委分量 ≥ 基线−容差 1；写链逐项对照布尔面。记分台每行带 corpusVersion / judgePromptVersion / judgeModel 三元组——**三元组一变分数即不可比，必须重定基线**（模型升级、换独立评委、改评委提示词都是"变"）。

### 波次防线与实测记录

- **基线冻结**：npm test 1313 全绿（波前 1270，+43）；typecheck 范围不含 scripts/（D-084 残留 b 照旧，未混波）。
- **三轮实测**（`.runtime/eval-baseline-run1/2/3.log`，真模型 + mock 执行器）：基线 v3（探针 7 例 + 写链 1 组），轮③ 8/8 全绿。机械分量稳定用例三轮逐位一致；写链布尔面三轮全同（D-088 链条 3/3）；评委同转录复跑一致，一例 ±2 超容差分差如实登记（B1 卫生 0→2）——机械层是可复现骨干，评委层是粗门限 + 轨迹。
- **标定两次**（F3 变异验证由 dims.test.ts 原句锁 + score.test.ts 判定锁承担）：① B1 尺子失准（全数字串口径把选项序号/期间码算进签名；总调用数漏掉"复述谎称实查"）——改金额口径 + 每轮真查；② `okExpected` 语义错误（要求缺点必须出现 = 惩罚改进）——改 `okMode`（strict/free）；另修基线键命名空间错位与 free 案评委基线规则（取含缺陷转录实测下限）。
- **模型侧观察项**（登记不修，不劣化档入基线）：A2 范围渗入（§6 既有）、A2 执行语言泄漏一次（D-098 修尺后探针首次机械命中）、Y2 佐证数字无所属、Y2 澄清缺问句。**呈现卫生是当前模型最不稳的维**（三轮 4 次/21 用例轮）——scores.jsonl 轨迹显示频率上升即是漂移信号。
- **新登记**：D-104（探针无后台持久化排干，不影响分数，探针库不干净）。

F 波结束。

---

## 8. 产物回传波 · 任务工作区纳入宿主编收集范围（2026-10-19）

**目标**：修 D-106——worker 唯一可写位置（`tmp/task_<taskId>/`）不在宿主回传收集范围内，交付物写在哪儿都传不给用户。单波单主题：宿主收集范围 + 执行层交付约定 + 台账。

### 落了什么

| 位置 | 改动 |
|---|---|
| `apps/server/handler.ts` | `collectProducedFiles` 增第三参 `workspaceDirs`（本会话任务工作区白名单，按 principal×会话从 `platform_tasks.listBySession` 取，只认 `tmp/task_<uuid>` 形态）；`withFileReplies` 透传；`processMessage` 两个出口经 `sessionWorkspaceDirs` 取白名单后回传；新增守夜事件 `produced_files_collected` / `platform_tasks_list_failed`。其余判据（mtime ≥ 本轮委派开始、OFFICE_EXT、≤20MB、≤3 份、真实路径去重、解引用后仍在场内）一字未动 |
| `17dz-platform/src/payroll/MECHANISMS.md` | 执行器节：输出目录显式传（工作区或 `tmp/` 顶层均可，两个位置宿主办回传时都扫），删「缺省＝当前目录」旧惯例；新增「交付」节：用户可见回复不写服务器路径 |
| `docs/debt-ledger.md` | D-106（已关） |

### 波次防线与实测记录

- **F1 表征先行**：`handler.test.ts` 文件回传组原有 7 条判据（老文件不收 / attachments 不收 / 非办公扩展名不收 / 超 20MB 不收 / 最多 3 个 / 真实路径去重 / 链接不出界）一条未改；只把「任务工作区不收」一条按新语义拆成「未登记不收」+「本会话在册收」两条，改造中 golden 无漂移。
- **F2 基线冻结**：改造前 `npm test` **1409 全绿 / 111 文件** + typecheck 0 错误（2026-10-19 16:41 实测冻结）；改造后 **1416 全绿 / 111 文件**（+7：5 条收集用例 + 3 条端到端），typecheck 0 错误，`npm run test:e2e` **142 全绿**无回归。
- **F3 变异验证**：① 收集器删掉白名单判断（工作区一律跳过，回到旧规则）→ 恰 4 条新用例红（未登记不收 / 本会话收 / 工作区内老文件不收 / 端到端在册回传）；② 调用点把白名单传成空数组 → 恰 1 条端到端红，另两条（缺库退化、别会话工作区）不受影响。两次变异均已回滚并复跑复绿。
- **F4 最小化**：一个主题三项（宿主收集 / 执行层文档 / 台账），无夹带；17dz 侧只动 `src/payroll/MECHANISMS.md` 文档，零代码。
- **过程记录（F5 精神的实践）**：第一轮全量曾红在 `platform-leak-lint`——新注释把业务词「目录」「记录」带进宿主 src。处置是改注释措辞（「输出位置」「任务由委派时落库」），**不开白名单**：那不是合法业务词命中，是编排层 prose 该避开的词。
- **F7 文档同步**：debt-ledger D-106 + 本 §8 + F2 基线行（1409/111 → 本波后 1416/111）同批落地。

产物回传波结束。

---

## 9. 文件收据波 · 附件消息不再各占一个气泡（2026-10-19）

**目标**：修「N 个文件 + 1 条指令 → N+1 个机器人气泡且互相穿插」。单波单主题：气泡的归属与收据措辞的唯一权威位置。

**根因（不是文案问题，是接口问题）**：企微流式回复按**入站消息的 `req_id`** 走——SDK 的 `reply()` 只转发 `frame.headers.req_id`，`streamId` 是每次入站派发新生成的 UUID。于是**一条用户消息就是一个气泡**，跨消息合并在接口层不存在（已核 `node_modules/@wecom/aibot-node-sdk/dist/index.cjs.js:1006` 的 `reply()` 与 README：只有欢迎语/模板卡片有明确的 5s 回复窗，`846608` 是流式更新超时）。用户发 3 个 Excel + 1 条指令，会话里就是 3 条「已收到 X」加指令回合那一串帧，且文件回执与回合帧按各自流的状态交错上屏。

**修法**：不为文件起气泡，把气泡花在回合上。
- 附件-only 消息**零帧**——连秒回 ack 都不发。「收到,正在处理…」对一条只暂存、不处理的消息是假承诺，且正常路径下没有终帧来改写它，用户会看到一条永远转圈的「正在处理」。不起流就没有 spinner，所以空回复不再依赖「必须非空才收尾」这条隐式契约。
- 收据改由两处承载，**共用同一句措辞**：① 带指令的回合首帧（宿主规则二的披露帧，`已收到 N 个文件：…`）；② 只发文件、迟迟没有指令时，渠道在 2s 并窗到点补一条（同句 + 「，等待你的指令」）。带正文的消息一到达就取消并窗——那一回合的首帧会带同样的收据，两条说同一件事才是冗余。
- 附件回合**不再发受理帧**（披露帧本身就是「回合开跑了」的证据，且信息量更大）；心跳的锚点从「受理帧」改为「受理点」（帧流量计数），盲段照样被盖上。

**归属判据（AGENTS.md）**：通知送达与进度反馈是 fshine 通用机制，不属于执行层，故改动落在 `apps/server` + `packages/channel-wecom` + `packages/contracts`，无业务 `if` 分支。措辞的唯一权威位置放 `packages/contracts/src/channel.ts` 的 `formatFileReceipt`（宿主与渠道共用，`@fshine/contracts` 本就是两边的依赖）——同一句「你发了哪些文件」在两个地方各写一份，迟早漂移成一桩「同一个事实两种说法」的交互债。

### 落了什么

| 位置 | 改动 |
|---|---|
| `packages/contracts/src/channel.ts` | 新增 `FILE_RECEIPT_NAME_LIMIT`（3）与 `formatFileReceipt(filenames)`：去重后「已收到 N 个文件：a、b、c 等」。权威措辞，宿主回合首帧与渠道孤儿收据共用 |
| `apps/server/handler.ts` | `describeDeliveredFiles` 改为委托 `formatFileReceipt`（删 `DELIVERY_NOTICE_NAME_LIMIT`）；附件-only 正常路径返回空串（仍要张嘴的只有暂存超限、指令跑完后才到文件两种）；披露帧上屏后置 `receiptAnnounced`，受理帧据此跳过；`framesEmitted` 计数覆盖 progress/notice/披露三条来路，心跳锚点改为帧流量 |
| `packages/channel-wecom/src/adapter.ts` | 附件-only 消息不发 ack（不起流）；`PendingReceipt` 按会话累积文件名、通道挂到最后到达的那条、2s 并窗；带正文的消息到达即撤；`stop()` 一并撤（不把定时器留给进程收尾）；孤儿收据走 degrade（首帧被拒收时降级成新消息，否则流永远开着）；导出 `RECEIPT_COALESCE_MS` 让这个调参值有测试守着 |
| `packages/channel-wecom/src/index.ts` | 导出 `RECEIPT_COALESCE_MS` |
| `apps/server/handler.test.ts` | 5 条既有断言按新语义改写（附件-only 正常路径零回复）+ 5 条新增（附件回合首帧即收据 / 心跳不丢 / 心跳不添噪 / 披露走 notice 的通道归属 / notice 帧计流量）+ harness 增 notice 通道与 runtime 注帧 |
| `packages/channel-wecom/adapter.test.ts` | 新增 8 条（附件-only 零帧 / 孤儿收据 / 并窗合成一条 / 带正文取消 / 例外路径不等窗 / 收据首帧拒收降级 / stop 撤定时器 / 并窗长度）；`FakeSdkClient` 增 `failNextReply` |
| `tests/e2e/turn-loop-attachments.test.ts` | AT-1/AT-2 期望改为孤儿收据文案；披露断言随措辞更新；新增 AT-4 突发形态（2 文件 + 1 指令连发：文件消息零帧、收据只出现一次、不带等待后缀） |
| `tests/e2e/harness.ts` | 附件落盘目录加随机后缀（见下「顺带修的竞态」） |
| `docs/debt-ledger.md` | D-107（已关） |

### 波次防线与实测记录

- **F1 表征先行**：附件链路的既有判据（暂存/FIFO/迟到文件/会话隔离/超限告知/下载失败降级/落点自检/防穿越）一条未改，只把 5 条钉旧文案的断言按新语义改写；每一条改写的理由都写在原处（为什么不再回气泡）。
- **F2 基线冻结**：改造前 `npm test` **1416 全绿 / 111 文件** + typecheck 0 错误（2026-10-19 17:16 实测冻结，即 §8 产物回传波的收口数字）；改造后 **1430 全绿 / 111 文件**（+14：handler 5、adapter 8、e2e 1），typecheck 0 错误，`npm run test:e2e` **143 全绿**无回归。
- **F3 变异验证**（九条 adapter 侧 + 五条 handler 侧，逐条确认对应用例转红后回滚复绿）：① 附件-only 也发秒回 ack → 4 条收据用例红；② 带正文的消息不撤并窗 → 「取消挂起收据」红；③ 不并窗（每条文件各起一窗）→ 「并窗合成一条」红；④ `stop()` 不清定时器 → 「stop 撤收据」红（用 `vi.getTimerCount()` 才看得见，第一版断言只验「停机后不发帧」，而那半条被 `this.client = null` 挡住，变异**不红**——补了定时器计数才真守住）；⑤ 并窗改为覆盖而非累积 → 「合成一条」红；⑥ 通道不换成最新那条 → 「挂在最后到达的那条」红（顺带删掉 `PendingReceipt.reqId`：它与 `frame.headers.req_id` 是同一事实两个落点，删掉后少一条守不住的线）；⑦ 去掉「，等待你的指令」后缀 → 2 条红；⑧ 收据不走 degrade → 「首帧拒收降级」红（补了 `failNextReply` 才可观察）；⑨ 并窗改 20ms → 「并窗长度」红。handler 侧：① 附件回合仍发受理帧 → 4 条红；② 心跳锚点不随帧推进 → 2 条红；③ notice 帧不计流量 → 「notice 帧算流量」红；④ 不记披露已上屏 → 4 条红；⑤ 附件-only 又回气泡 → 6 条红。
- **F4 最小化**：一个主题，`packages/contracts` 加一个纯函数、宿主改收据与帧计数、渠道改气泡归属，无夹带；未碰任何执行层文件。
- **顺带修的竞态（e2e harness，非本波主题但被本波放大）**：附件落盘目录名只用每文件份的 `counter`，两个并行文件各自的第一号 boot 会落进同一目录，先 `close()` 的把后者的附件删掉。此前不可见——`sendFile` 几毫秒就返回，断言紧跟着落盘跑；并窗让 `sendFile` 等满 2s，窗口足以让别的文件 boot+close 一轮，症状是「落盘成功的附件 `existsSync` 为假」这种指代不清的失败（全量跑时 AT-1 偶发红）。修法是目录名加随机后缀，`close()` 的清理语义不变。
- **F7 文档同步**：debt-ledger D-107 + 本 §9 + F2 基线行（1416/111 → 本波后 1430/111）同批落地。

### 未验的一项（mock 证不了，登记不闭环）

「文件消息一条回复都不回」在真企微里的客户端表现（无气泡、无 spinner）**只能真机验**：mock 的 `replyStream` 是个数组，既不会转圈也不会拒收。已写入 `docs/manual-test-wecom.md` 的待验清单（发 2 个文件不发指令 → 2s 后一条合并收据；再发指令 → 只有回合气泡带收据，文件消息下无残留 spinner）。并窗长度 2s 的上界依据（短于渠道被动回复时限）同样只有真机能验。

文件收据波结束。

---

## 10. 乱序到达波 · 附件 burst 稳才派单 + 迟到文件静默并窗（2026-10-19）

**目标**：修「企微不保证同批消息按发送顺序投递」在附件链路上的两个后果——回合可能在文件没到齐时就开跑（**正确性**），迟到文件各占一个气泡还说一句可能为假的话（**交互**）。单波单主题：入站等待的判据 + 迟到文件的回话归属。

**触发（用户观察，2026-10-19）**：「企业微信很奇怪，是乱序发送的，哪怕是在同一批消息里发送出去的」。同一份会话记录里就能读出越界：3 个文件 + 1 条指令，第 1、2 个文件的回执在 16:10:48，指令回合的「仍在处理中」在 16:10:50，第 3 个文件的回据在 16:10:51——跨度 3 秒，且第三个文件落在回合开跑之后。

**根因**：唯一的重排手段是 `handler.ts` 的防抖固定睡眠（`DEFAULT_INBOUND_DEBOUNCE_MS = 2000`），三个限制叠起来——固定 2 秒、只作用于**带正文**的消息、只在前一条 2 秒内到达时才等。它只覆盖「指令之后 2 秒内到达」这一段，而且治不了「文件落在指令之后」：那时防抖早就睡完了，`restoreAttachments` 也拍完了快照，**那一轮是拿着不完整的文件集算完的**。`seenTextTurn` 那几句「上一条指令已经处理完了」则是在 runtime 之前就置位的，回合还在飞时它就是假的。

**修法**：
- **R1 burst 稳定器**：等的判据从「睡了多久」换成**静默**——一个窗口内没有新到达才算 burst 结束（`waitForBurstSettle`），最多 4 个窗口（`MAX_BURST_SETTLE_WINDOWS`，默认 8s）。安静的 burst 仍然只等一个窗口（与旧行为同延迟），冷启动的「首条零防抖」不变（`burstInProgress` 门挡着稳定器）。
- **R2 迟到文件静默**：附件-only 分支不再回文本，`seenTextTurn` 一并删除（它已经无所依存）。文件照原样进暂存池，收据与下一步由渠道并窗（「已收到 N 个文件：…，等待你的指令」）与下一条指令的回合首帧承担——收据因此永远只有一句措辞（`contracts.formatFileReceipt`），没有第二份。

**为什么不让 AI 汇报收据**（用户问过，留档）：① 它是**首帧**，全部价值就在于不等模型——`announceDeliveredFiles` 跑在所有 `runtime.handleTurn` 之前，模型还没被调用回执已经上屏；② 文件名与个数是**传输事实**，本仓在别处已把「模型自报字段」当不可信输入（确认门：模型无法用自报字段通过确认），让 AI 复述等于多开一个幻觉面（`工资表2026-8月(1).xlsx` 会被说成 `工资表2026-8月.xlsx`）；③ **归属**——通知送达是 fshine 通用机制（AGENTS.md），AI/runtime 是执行层落地处，把通用渠道文案交给它，下次接新执行层这句得重新长出来。AI 的汇报本来就在：同一个 `req_id` 的同一个气泡里，收据那行是骨架，AI 的进度帧与终稿是血肉。迟到文件当时没有 AI 在场（附件-only 分支不调 LLM），它的汇报发生在**下一条指令**——探针实证那一轮的首帧会把这批文件念出来。

### 落了什么

| 位置 | 改动 |
|---|---|
| `apps/server/handler.ts` | 新增 `MAX_BURST_SETTLE_WINDOWS`(4) 与 `waitForBurstSettle`（静默判据 + 触顶）；防抖调用点从固定睡眠改为稳定器；附件-only 分支删掉迟到文件的话术与 `seenTextTurn`（声明、置位、判读三处）；`inboundDebounceMs` 文档注释同步 |
| `apps/server/handler.test.ts` | 1 条改写（迟到文件不再回气泡，补「下一条指令带上」兜底断言）+ 3 条新增（稳定器跨固定窗仍赶上 / 上界 4 个窗口 / 静默满一个窗口就收工）+ 1 条加强（附件-only 不等防抖补上「burst 已开」情形，见下 F3） |

### 波次防线与实测记录

- **F1 表征先行**：附件链路既有判据（暂存 / FIFO / 迟到文件 / 会话隔离 / 超限告知 / 跨重启恢复 / 交付边界四场景 / 防抖配置来源）一条未改；只把「迟到文件回复必须明确要求补发指令」一条按新语义改写，理由写在原处（乱序之下那不是异常，且旧话术在回合在飞时为假）。
- **F2 基线冻结**：改造前 `npm test` **1430 全绿 / 111 文件** + typecheck 0 错误（2026-10-19 17:16 冻结，即 §9 文件收据波的收口数字）；改造后 **1433 全绿 / 111 文件**（+3），typecheck 0 错误，`npm run test:e2e` **143 全绿**无回归（e2e harness 的 `FSHINE_INBOUND_DEBOUNCE_MS=0` 让稳定器在端到端里不介入，故端到端条数不变）。
- **F3 变异验证**（五条，逐条确认对应用例转红后回滚复绿）：① 判据退回固定睡眠 → 「稳定器跨固定窗仍赶上」红；② 去掉等待上界（`while (true)`）→ 「上界 4 个窗口」红；③ 附件-only 也参与等待 → 「附件-only 不参与防抖」红；④ 迟到文件又回一条气泡 → 「迟到的文件」红；⑤ 新到达的附件不进池子 → 同一条的「下一条指令带上」红。**③第一版不红**：那条用例只发冷启动第一条，`burstInProgress` 为假，等不改判据都是空的——补上「burst 已开时再发一个附件也要立刻返回」的第二段才真变红。这不是放宽，是把一条名义上存在、实际无判据力的断言补成有判据力。
- **F4 最小化**：一个主题，改动全在 `apps/server`（宿主侧入站判据）；未碰渠道适配器、契约、执行层任何一行。R1 与 R2 同波是因为它们修同一个根因的两面（等不到 → 静默并窗），拆开会让中间态同时带着「固定窗」和「迟到文件各回一条」两个已知缺陷。
- **F7 文档同步**：debt-ledger D-108 + 本 §10 + F2 基线行（1430/111 → 本波后 1433/111）+ manual-test-wecom §8.5 同批落地。

### 残余三项（登记，不阻塞关闭）

1. **冷启动且指令先到时不等待**。指令是会话第一条消息时 `burstInProgress` 为假，稳定器不介入，之后到达的文件全部走 R2 的迟到路径。修它要给冷启动的正文消息也加等待，代价是每次对话首句多等一个窗口——与 2026-10-16「首条零防抖」那波直接冲突（那一波的动机正是冷启动不白等 2s）。用户实测的通话记录里文件先于指令到达，本条未命中；真被命中再议。
2. **稳定器是采样判据，不是完备判据**。文件恰好在一次静默检查之后到达仍会漏（漏不了一整个窗口之后的等待，最多一个窗口宽度）。漏掉的由 R2 兜底：进池子、渠道并窗补一条、下一条指令带上。
3. **残余重复披露**。文件在稳定器等待期间到达时，渠道并窗（2s）可能先补一条收据，随后回合首帧再把同一批文件名说一遍。这一条**在旧行为里就以相反顺序存在**（回合收据先、孤儿收据后），本波没有新增，只是顺序可能反过来；要彻底消除得让渠道知道宿主的等待状态（跨层新协议面），为一个纯外观收益不值。

乱序到达波结束。

---

## 11. 重复请求波 · 同文重发不再被判成对话 + 编排层不外泄服务器路径（2026-10-20）

**目标**：修「用户把同一条指令重发一遍，bot 回一段完整报告却不带文件」——**零执行、零产物**，还把几小时前的结论重新排版给他。单波单主题：申报层的重复请求复核 + 出口层的路径不外泄（两个缺陷同一次实测暴露，共用同一段转录）。

**触发（用户观察，2026-10-19 23:30）**：「怎么还是没有发文件出来给我」。同一指令在本会话发了三遍（16:06 带 1 个文件 / 16:10 带 3 个文件 / 23:30），16:10 那一遍真委派、两个交付物真落盘（16:20:30、16:21:13），23:30 那一遍回的是一段完整报告（12 人、应发合计 123,456.78、实发合计 120,000.00）+ 服务器路径，**没有任何附件**。

**根因（两个，都不在 D-106 的回传机制里——那一次它行为完全正确）**：

1. **申报层**。23:30 那一轮模型申报 `kind: conversation`：无 `delegation_span`、无平台执行，`collectProducedFiles` 按 `mtime ≥ 本轮委派开始` 正确地什么都没收到（23:30 之后 `17dz-platform/tmp` 下零办公文件被改动；两个交付物 7 小时前的 mtime 正是被这条判据挡住的）。转录里模型的 thinking 原话是「The user has re-asked the same question. The Sub Agent previously returned…」——**它明确认出是重复请求，还是选了对话枝**：历史答复在它眼里成了本轮授权的替代品。
2. **出口层**。终稿里的 `tmp/task_d42fffce-…/` 出自**编排模型**（它读转录里的历史结论，把上一轮的路径一起排版出来），而「用户可见回复不写服务器路径」只写在执行层 skill 里（D-106 配套），管不到这一侧。

**修法**：

- **R1 重复请求复核**（`packages/agent/src/repeat-request.ts`，新增）：从转录机械判定「这条同文请求本会话已经委派执行过」——逐轮配对 user 消息 ↔ `route_current_turn` 调用 ↔ 回执；先剥掉宿主追加的附件路径后缀、折叠空白（后缀是宿主注入的，不属于「用户说了什么」，不剥就永远判不出同文——本次三遍里两遍带附件且文件数不同）；回执是 `{"recorded":"conversation"}` 或该轮根本没申报 → 不算执行过。命中则**退回重填**（与 `reviewRouteDeclaration` 同一族：不消耗用户轮次），并只在 `route_current_turn` 的工具说明里补一句「同文照样按新请求判 kind，申报 conversation 会被退回重填」。
  **只退一次后放行**：这道尺是增强不是门——拦住不放，用户连历史结论都看不到，比给一段可能过期的答复更糟；模型已经拿到事实仍坚持对话枝时，宿主没有领域语义可以替它判断，只能放行 + 留痕（`repeat_request_declaration_bounced`）。
- **R2 服务器路径不外发**（`packages/agent/src/reply-exit.ts` + `server-paths.ts`，新增）：终稿出口删掉路径 token、保留其余内容。判据只有**形状**（`/` + POSIX 顶层路径名；`tmp/` 开头——后者是**宿主自己的**暂存命名，`sweepScratchDirs` 只扫这一种，不是执行层的业务字段），两条都锚在宿主持有的名字上，不把任何执行层目录约定搬进通用 runtime。**删路径而不是整段拦掉**：金额与结论来自 7 小时前那次真跑，整段替换会把有用内容一起扔掉；该丢的只是用户没法用的那一截。位置在 turn-exit 之后、落库与上屏之前——转录、Conversation Log、turn_span 三处看到的都是用户真正收到的那一版。

**归属判据（AGENTS.md）**：通知送达、用户可见状态反馈是 fshine 通用机制，两道尺都判「形状」不判内容，零业务 `if` 分支——`repeat-request.ts` 全文不知道任何业务词汇，`server-paths.ts` 只认 POSIX 顶层路径名与宿主自己的 `tmp/` 命名。执行层那条「回复不写服务器路径」的约定原地不动（它管 worker 自己的回复），宿主这道尺盖编排模型——两层各有提示与确定性复核，不构成两份相互冲突的要求。

### 落了什么

| 位置 | 改动 |
|---|---|
| `packages/agent/src/repeat-request.ts` | **新文件**。`normalizeUserRequest`（剥附件后缀 + 折叠空白）、`findRepeatedDelegatedRequest`（逐轮配对，返回 `{request, priorDelegations}` 或 null）、`ATTACHMENT_PATHS_MARKER`（宿主追加后缀的标记，单一来源） |
| `packages/agent/src/server-paths.ts` | **新文件**。`SERVER_PATH_PATTERN`（两条形状判据，全局）、`stripServerPaths`（删路径 + 清空括号对 + 收空白；零命中原文原样返回） |
| `packages/agent/src/reply-exit.ts` | **新文件**。`sanitizeUserVisibleReply`（纯函数：删路径 + 零执行金额只留痕，带回 `TurnExitEvent[]`）。**一并收走原本散在 runtime.ts 出口处的数值溯源探查**——两支作用点相同（都是本回合出口、落库与上屏之前），合成一个纯函数后 runtime 只提供事实与打日志（与 `turn-exit.ts` 同一分工） |
| `packages/agent/src/turn-contract.ts` | `ROUTE_CURRENT_TURN_TOOL.description` 补一句同文判 kind；新增导出的 `REPEATED_REQUEST_RETRY`（退回时的重填指引，把事实说全：同文、已执行过、该改成什么） |
| `packages/agent/src/runtime.ts` | 申报分支加重复请求复核（含"只退一次"计数）；出口处改调 `sanitizeUserVisibleReply`。**净 −3 行**（1293 → 1290）：判据全部住新模块，同时把两块既有 I/O 包装抽出去付账（见下） |
| `packages/agent/src/session-entities.ts` | `collectSessionEntitiesSafely`（原 runtime.ts 内的安全包装）：判据本体保持「抛错向上传播」，降级与留痕是**调用策略**，住到判据旁边 |
| `packages/agent/src/platform-health.ts` | 新增 `cooldownBlock`：一次读取同时拿用户可见文本与日志载荷。分三次读（isCoolingDown / 两个 getter）会在「刚好到期」的边界上各说各话——日志说还在冷却、回复说还剩 0 分钟 |
| `packages/agent/src/index.ts` | 三个新模块的公开出口 |
| `apps/server/handler.ts` | `withAttachmentPaths` 改用 `ATTACHMENT_PATHS_MARKER` 常量（后缀标记不再有第二份字面量） |
| `packages/agent/architecture-shape.test.ts` | `RUNTIME_LINE_BUDGET` 1293 → 1290（每批抽取后把常数改小） |
| 测试 | 新文件 3 个（`repeat-request.test.ts` 12 条 / `server-paths.test.ts` 8 条 / `reply-exit.test.ts` 8 条）+ `runtime.test.ts` 5 条集成 |

### 波次防线与实测记录

- **F1 表征先行**：附件后缀标记、`collectProducedFiles` 的 mtime 判据、`conversation_unsourced_amounts` 的字段集（`count` + `needsRounds` 一条没少）、平台冷却两个调用点的日志字段一字未改；既有 90 条 runtime 用例零改写。
- **F2 基线冻结**：改造前 `npm test` **1433 全绿 / 111 文件** + typecheck 0 错误（2026-10-19 17:16 冻结，即 §10 收口数字）；改造后 **1466 全绿 / 114 文件**（+33），typecheck 0 错误，`npm run test:e2e` **143 全绿**无回归。
- **F3 变异验证**（六条，逐条确认对应用例转红后回滚复绿）：① 删掉重复请求复核的退回 → RR1/RR2 红；② 对话枝回执识别不出来（`isConversationReceipt` 恒真）→ 5 条红；③ 不剥宿主追加的附件后缀 → 2 条红；④ 出口不删路径 → 3 条红；⑤ 相对路径支失效（`tmp/` 那条判据坏掉）→ 4 条红；⑥ 去掉「只退一次」的有界性 → RR2 红。
- **F4 最小化**：一个主题，改动全在 `packages/agent` + `apps/server` 的一个常量引用；未碰渠道适配器、契约、执行层任何一行。R1 与 R2 同波是因为它们修同一段转录的两个面（重复请求让历史结论外发，外发时又把路径带出来），拆开会让中间态同时带着两个已知缺陷。两块既有 I/O 包装的抽取是 `architecture-shape.test.ts` 的行数棘轮要求（判据本体不在 runtime，接线 +3 行就得从别处抽回来），不是顺手重构。
- **F5 红先 revert**：无（全程绿）。
- **F6 真实模型探针基线**：`route_current_turn` 的工具说明变了（提示词级），改前改后同参数复跑 `--only A1,B1,A5`（A1 = 同一实时问题重问、B1 = 同一查询连发 5 次、A5 = 闲聊不委派——正是本波判据的三个面）。见下。
- **F7 文档同步**：debt-ledger D-109 + 本 §11 + F2 基线行（1433/111 → 本波后 1466/114）+ manual-test-wecom §8.6 同批落地。

### F6 探针结果（真实 LLM + mock 执行器，`--only A1,B1,A5`）

**判定标准预先写死**：A1 必须重新查询（平台调用 > 0 且每轮都真调）、B1 连发 5 次每次都真查（口径一致）、A5 闲聊零调用；且**不新增** `repeat_request_declaration_bounced`（模型本就走 delegate，退回机制不该被触发）。

| 用例 | 改前（说明里没有那句同文判据） | 改后（带那句） | 判定 |
|---|---|---|---|
| A1 同一实时问题重问 | 343.3s / 3 次调用 / 全 delegate | 396.1s / 5 次调用 / 全 delegate | 不劣化 |
| A5 闲聊不委派 | 9.4s / 0 次调用 / conversation | 15.6s / 0 次调用 / conversation | 不劣化 |
| B1 同一查询连发 5 次 | 446.0s / 7 次调用 / 5 轮全 delegate | 549.5s / 10 次调用 / 5 轮全 delegate | 不劣化 |

**三段日志实证**（明细 `.runtime/probe-fshine-probe-tILSIE.json` = 改前，`fQCtXA.json` + `inKAS5.json` = 改后）：

- **零退回**：改前改后都没有 `repeat_request_declaration_bounced`。模型在重问上本来就选 delegate，宿主这道尺是**兜底**不是主路径——这正是「只退一次后放行」的理由：它不该是常态，真被触发说明模型那一轮看走了眼。
- **闲聊仍然走对话枝**：A5「现在几月份了？」改后照旧申报 `conversation`（0 次调用），且因为早前没有同文的委派痕迹，判据不成立、没有退回——R1 不会把闲聊逼去执行。
- **改后第一次 B1 撞了探针的 10 分钟回复等待上限**（其中一轮 >600s，探针记 `⚠ 等待回复超时`），单独重跑 B1 得 549.5s / 10 次调用全绿。这是**延迟抖动不是行为变化**：超时那一轮的 `turn_declaration` 仍是 delegate、口径与前四轮一致；探针的 `PROBE_REPLY_WAIT_MS` 是探针自己的等待上限，与宿主无关（同一次运行里 A1 的 396.1s 也已接近该量级）。如实登记，不当成通过项也不当成回归项。

**结论**：提示词级改动在三个面上都没有行为漂移——重问照旧真查、闲聊照旧不委派、退回机制零触发。

### 残余五项（登记，不阻塞关闭）

1. **模型被退回后仍坚持对话枝时放行**，用户拿到的仍是历史结论。行为已在 RR2 钉住，日志留痕（`repeat_request_declaration_bounced` + `turn_declaration kind=conversation`）；要更进一步就得让宿主替模型判断「这轮该不该执行」，那是领域语义，归执行层。
2. **路径判据是形状匹配，未登记形态漏网**：`~/…`、相对 `./…`、Windows 盘符、以及不以上表顶层路径名开头的绝对路径。漏报的路径仍在原地，用户至少看到内容——比误删结论字符好（误伤面见 `server-paths.test.ts` 的五类反例）。
3. **平台冷却有两个调用点、两种读法**：委派路径这一批换成了 `cooldownBlock`（一次读取），恢复路径（`ctx.resumeTaskId` 分支）仍是三次读。行为不变、未 touched（F4），但同一件事两种 idiom；下回碰恢复路径时一并换。
4. **真机复跑待用户确认**：重复请求现在真的重新委派并回传文件、终稿不出现路径——已写入 `docs/manual-test-wecom.md` §8.6（mock 的 Main Agent 是脚本化驱动，证不了「真实模型选哪一枝」）。
5. **探针的回复等待上限（600s）低于真实慢轮**：B1 改后首跑有一轮超过它被记 `⚠ 等待回复超时`（重跑即绿）。上限是探针自己的参数（`PROBE_REPLY_WAIT_MS`），与宿主无关，但**长任务轮的探针断言现在会被它截断**——D-105 一类"探针环境自身缺陷"又多一条，登记在此，不阻塞本波关闭。

重复请求波结束。

---

## 12. 收据复读波 · 附件收据只属于"文件刚到"那一轮（2026-10-20）

**目标**：修「用户发过文件之后，不管再发什么，bot 都在说"已收到 N 个文件：…"」——与附件无关的后续回合复读旧清单。

**触发（用户观察，2026-10-20 贴出的真实企微会话）**：用户先发 3 个 Excel + 一条指令，之后又问了一句与附件无关的话「发一下 幻骥达2026年08月个税申报.xlsx 给我」，那一回合的气泡里又冒出「已收到 3 个文件：工资表2026-8月(1).xlsx、幻骥达26年8月社保实际缴费金额模版（幻企赢导入.xls、2026年8月工资（幻骥达）(1).xlsx」。用户原话：「怎么不管怎么样都会显示说收到附件？」

**根因**：收据帧（规则二披露）挂在「本轮交付集非空」上，而规则一在「没有新附件」时**沿用上次委派的交付集**（纠正/重试流：「社保填错了，重做」时文件当然还是上轮那些）。交付集因此每轮都非空，收据就每轮都播——第 9 波把收据从"每个文件消息一条"并到"回合首帧一条"之后，剩下的这条复读路径才浮到面上。

**修法（一个判据，不动交付）**：`selectDeliveredAttachments` 的结果从「文件数组」改成「文件数组 + `fresh` 布尔」——`fresh` = 本轮真有新到达（含与正文同条到达的；账本失记的全量未消费算新，重启降级那条披露必须还在）。`announceDeliveredFiles` 只在 `fresh` 时出声。**交付行为一个字节不改**：worker 照旧拿到沿用那批文件，只是不再复读。`fresh` 与交付集同源同函数返回，不存在第二份判据。

**归属判据（AGENTS.md）**：通知送达与用户可见状态反馈是 fshine 通用机制；判据是"本轮有没有新输入"，零业务词汇、零执行层字段。

### 落了什么

| 位置 | 改动 |
|---|---|
| `apps/server/handler.ts` | `selectDeliveredAttachments` 返回 `DeliveredSelection {files, fresh}`；`restoreAttachments` 返回 `RestoredAttachments {delivered, fresh}`；`announceDeliveredFiles` 加 `if (!attachmentsAreNew) return`。净 +约 20 行（含注释） |
| `apps/server/handler.test.ts` | 3 条新增：沿用旧交付集的回合不复读收据（用户原话形状，交付仍带 3 个文件）/ 纠正/重试流不二次上屏 / 新文件到达的回合照常披露且只列新到的那几个 |
| `tests/e2e/turn-loop-attachments.test.ts` | AT-5 新增：全链复现（2 文件 + 指令 → 收据一次；再发一句与附件无关的话 → 零收据、受理帧照旧、两个文件名仍在请求文本里、outcome 是 replied） |
| `docs/test-hardening.md` | T3 行 3 → 4 例 |

### 波次防线与实测记录

- **F1 表征先行**：先写 3 条红测试复现用户形状（两条当场红：`沿用旧交付集…` 与 `纠正/重试流…`），再动代码；既有 90 条 handler 用例零改写。
- **F2 基线冻结**：改造前 `npm test` **1466 全绿 / 114 文件** + typecheck 0 错误（2026-10-20 冻结，即 §11 收口数字）；改造后 **1470 全绿 / 114 文件**（+4，全为新增用例），typecheck 0 错误，`tests/e2e` 5 条附件用例全绿。过程中 `pi-coding-driver.test.ts` 有一条在满负荷并行下红过一次、单跑与复跑均绿——并行抖动，非本波引入（该文件在 `packages/agent`，本波未碰）。
- **F3 变异验证**（三条，逐条确认转红后回滚复绿）：① 去掉 `if (!attachmentsAreNew) return` → 2 条 handler 单测 + AT-5 红；② 把 `fresh: false` 改成 `true`（沿用分支冒充新到达）→ 同 2 条红；③ AT-5 单独对变异 ① 复红一次。
- **F4 最小化**：只动 `apps/server/handler.ts` 一个生产文件 + 两个测试文件 + 两份文档；未碰渠道适配器、契约、`packages/agent`。
- **F5 红先 revert**：无（全程绿）。
- **F6 探针**：不涉及提示词/申报/澄清，无需探针。
- **F7 文档同步**：debt-ledger D-110 + 本 §12 + test-hardening T3 行同批落地。

### 未验的一项（mock 证不了，登记不闭环）

真企微客户端上「后续回合不再复读收据」的观感（以及那一回合的受理帧「开始处理你的请求」是否与用户预期一致）只能真机验——e2e 钉住的是帧序列，不是用户的眼睛。已由用户原始会话记录构成触发证据，复跑确认随下次真实使用发生。

收据复读波结束。

---

## 13. 进度帧路径波 · 「正在…」帧不再带服务器路径（2026-10-20）

**目标**：修「重启之后还是看到 `tmp/task_<uuid>`」——§11 的出口尺只盖终稿，这一波盖**进度帧**。

**触发（用户观察，2026-10-20，重启后第一条真实委派）**：企微里弹出
`正在盘点薪酬数据源 + 契约草稿 「tmp/task_f695557e-f9b1-4」…`。用户原话：「怎么还有这种东西」。

**根因（不是 §11 的尺失效，是另一条出口）**：`sanitizeUserVisibleReply` 挂在**终稿**出口上，而这条文本出自
**进度帧**通道——worker 每放行一次平台调用，宿主按平台声明的 label + 参数摘要合成一帧
（`serveGateStepText` → `operationStepText`，`createServeGateAuditSink` 推给渠道）。参数摘要
（`describeKeyArgs`）按平台 args 规格摘 flag 取值，而平台把一堆**路径型** flag 声明成了 `name` 样式
（`--out-dir` / `--contract` / `--cache` / `--out` / `--decisions`，payroll 与 voucher 两个域都有）；
这一次的取值正是宿主自己的任务工作区 `tmp/task_<uuid>`，于是被渲染成帧。终稿那道尺从头到尾没被调用
——它是另一个出口，两个出口都要过尺，这正是 §11 残留项里"只盖了一个出口"的兑现。

**修法（一个判据，三个出口）**：判据仍只有 `server-paths.ts` 那一份形状，新增**探针** `hasServerPath`
（与 `stripServerPaths` 同源派生、去掉 `g` 免得 `.test()` 带 lastIndex 状态），在三个出口各自引用它：

| 出口 | 处理 | 为什么是这种处理 |
|---|---|---|
| 参数摘要（`describeKeyArgs`） | 路径型取值**不进摘要** | 摘要是帧的原料，源头不放，帧就干净；被拦的只是这一个取值，同一命令里的其他取值照旧进摘要——帧照发，用户仍知道在干什么 |
| 平台操作帧（`serveGateStepText`） | 帧里探到路径 → **整帧不发**（返回 null） | 与"没有 label 就不发帧"同一族安全缺省；label 是平台数据，这一侧守住平台侧与未来摘要来源 |
| 模型自填短语（`clampProgressPhrase`） | 探到路径 → **整条短语丢弃**，回落默认帧 | 与协议材料同一族：短语是模型写的一句话，"删掉路径留着话"只会给用户剩一句主语残缺的话 |

**归属判据（AGENTS.md）**：用户可见状态反馈是 fshine 通用机制；`tmp/task_<uuid>` 是**宿主自己的**暂存命名
（`sweepScratchDirs` 只扫这一种），判据因此住在 fshine 且不碰任何执行层字段——平台那边只是被消费的
args 规格数据（样式表），不是新协议面。

**为什么不放渠道适配器**：适配器是传输，把内容判据塞进去会让"发什么"取决于"走哪个渠道"；放在三个
合成点则任何渠道、任何未来出口都过同一把尺（与终稿出口同一思路）。

### 落了什么

| 位置 | 改动 |
|---|---|
| `packages/agent/src/server-paths.ts` | 新增 `hasServerPath`（探针，非全局正则）+ 注释说明"删 / 探"两个出口为什么共用一份形状 |
| `packages/agent/src/serve-gate.ts` | `describeKeyArgs` 跳过路径型取值（+ 函数注释写清取舍） |
| `packages/agent/src/pi-coding-driver.ts` | `serveGateStepText` 探到路径返回 null（+ 注释） |
| `packages/agent/src/step-text.ts` | `clampProgressPhrase` 加路径判据（+ 注释） |
| `packages/agent/src/index.ts` | 导出 `hasServerPath` |
| `packages/agent/server-paths.test.ts` | 3 条新增：探针命中/不误伤 + **与 `stripServerPaths` 的一致性**（两个出口同一把尺，任一侧改形状即红）+ 无状态（反复调用不串） |
| `packages/agent/serve-gate.test.ts` | 1 条新增：路径型 flag（三种写法 + 截断后的半截路径）不进摘要，同命令其他取值照旧 |
| `packages/agent/step-text.test.ts` | 1 条新增：带路径的短语整条丢弃并回落默认帧；其中三条是**不带 `task_`** 的路径形状（既有协议特征只拦 `task_`，补的是这个缺口） |
| `packages/agent/pi-coding-driver.test.ts` | 2 条新增：帧里探到路径不发帧；**真实事故复现**（`--out-dir tmp/task_<uuid>` → 帧只剩 label，审计 detail 仍带完整命令） |

### 波次防线与实测记录

- **F1 表征先行**：先写 7 条红测试（`hasServerPath` 不存在 → server-paths 3 条当场红；其余 4 条按修法逐条红），再动代码。既有用例零改写。
- **F2 基线冻结**：改造前 `npm test` **1470 全绿 / 114 文件** + typecheck 0 错误（即 §12 收口数字）；改造后 **1477 全绿 / 114 文件**（+7，全为新增用例），typecheck 0 错误，`npm run test:e2e` **35 文件 / 144 全绿**。两个总数都已在**纯净树**上复测（`git worktree` 检出对应提交单跑，见下"计数抖动真因"）。
- **F3 变异验证**（四条，逐条确认转红后回滚复绿）：① 删掉 `describeKeyArgs` 的路径跳过 → 2 条红（serve-gate 单测 + 真实事故复现）；② 删掉 `serveGateStepText` 的帧守卫 → 1 条红；③ 删掉 `clampProgressPhrase` 的路径判据 → 1 条红；④ 把 `hasServerPath` 改成恒假 → 6 条红（四个文件全红）。
- **F4 最小化**：只动 `packages/agent` 的 4 个生产文件 + 1 个导出 + 4 个测试文件 + 3 份文档；未碰 runtime、渠道适配器、契约、handler、e2e harness。
- **F5 红先 revert**：不适用（新增判据，无既有行为被推翻；唯一行为变化是"路径不再出现在帧里"）。
- **F6 探针**：**不需要**——本波不改任何提示词/工具说明/申报契约（`turn-contract.ts` 一字未动），帧文本由宿主确定性合成，不是模型生成。
- **F7 文档同步**：debt-ledger D-111 + 本 §13 + manual-test-wecom §8.7 同批落地。

### 计数抖动真因（2026-10-20 复盘：原"已知抖动"归因错误，已纠正）

本节原记录："同一棵树连跑 `npm test`，本机测得 1466 / 1476 / 1477 三个数，计数在本机有 ±10 抖动，
疑点在满负荷下的收集阶段。"**这个归因是错的**，现纠正为：

vitest 的用例总数是**被收集文件内容的纯函数**——已核本仓没有从目录内容动态生成 `it()` 的测试
（几处 `readdirSync` 都在断言体里，不产用例）。一棵没有变化的树不可能跑出三个不同的总数：某个
文件没被收集到会是**文件级失败**（红），不会静悄悄少几条还三次全绿。所以"同树连跑三个数"这个
观察本身就是反证——那三次跑之间，树变了。

证据是文件 mtime：连跑窗口内 `tests/e2e/turn-loop-attachments.test.ts` 等被改过，那批改动（渠道
身份参数化 + 收据去掉"等待你的指令"后缀）与本波无关，且来自**本会话之外的进程**（本会话实录里
最后一次写文件是 2026-10-19 23:58，而这批 mtime 集中在 2026-10-20 18:44–19:11）。其中一次运行
读到旧断言（期望带后缀）而适配器已不发后缀 → 红；后几次读到新断言 → 绿。所谓"flake"与"计数抖动"
是同一件事：都不是本仓行为不稳定，是**被测树在被并发改写**。

纠正后的口径：

- F2 的"只增不减"按**新增用例逐条可数**核（本波构造上确定 7 条），不按单次总计数核。
- 总计数只在**纯净树**上有意义：`git worktree` 检出 §12 收口与 §13 收口分别单跑，1470 / 1477 与
  本章记账逐字一致。复测要先避开三个坑：① worktree 里 `PLATFORM_ROOT` 按 `__dirname` 相对解析，
  落在 /tmp 会指向不存在的 /tmp/17dz-platform，要显式设 `FSHINE_PLATFORM_ROOT`；② `config/agent.yaml`
  被 gitignore，不带过去会有 30+ 个 e2e 文件集体 ENOENT（计数仍有效，但不是绿）；③ 两个 worktree
  不能共用一个 `node_modules` 的 vite 缓存，先跑高版本再跑低版本会报 "Does not provide an export"。
- 纪律（进 methodology）：测计数前先确认工作树没有并发写入；脏树上的"抖动"先查 mtime，别先怀疑机器。

### 未验的一项（mock 证不了，登记不闭环）

真企微客户端上"这一帧不再出现、且后面没有出现空帧或掉帧"只能真机确认——e2e 与单测钉的是帧的**文本**
与**有无**，不是用户在客户端看到的气泡流。已写入 `docs/manual-test-wecom.md` §8.7。

另有一个出口本波**有意**没上尺：计划通知（`formatPlanMessage` → `sanitizeSummary`）。已核平台
`buildNotice`（17dz `src/execution/plan.js`）只拼账套名/期间/客户/科目编号，现无路径；判据与方法都已
就位，留作下一个出口真出现时同批补，不预支防御（登记在 debt-ledger D-111 未验项 ③）。

进度帧路径波结束。

---

## 14. 交互缝波 · 收据文案 + 终稿点名 + 三条演进缝 + handler 行数棘轮（2026-10-20）

**目标**：把前几轮讨论定下的「留缝，不搭桥」清单落地——PoC/MVP 阶段允许先写简单的，不允许做把演进选项焊死的选择。单波单主题：用户可见交互的两处修正（D1/D2）+ 三条缝（契约去渠道化 / 到达钟可注入 / 附件 locality 成断言）+ 一根机械护栏。

**为什么是这一波**（讨论结论的落地，不是新发现）：第二个客户端（web/小程序）已明确在路线上。它的输入模型是 composer 式（文件与文字同一条请求），企微消息模型特有的机器——`attachmentOnly`、burst 稳定器、孤儿收据并窗、ack/4 帧硬顶/心跳——在它上面根本不该存在。所以本波不动那些机器（它们留在企微 adapter），只做三件让接入变成「加一个 renderer」而不是「从宿主挖假设」的准备，外加两处今天就能让用户读得更舒服的改动。

**归属判据（AGENTS.md）**：通知送达与用户可见状态反馈是 fshine 通用机制 → D1/D2 落在宿主与 adapter，措辞仍只有 contracts 一个权威位置；身份与授权归 fshine → principal 前缀从消息的 `channel` 取，适配器报「哪个渠道 + 渠道里的谁」，宿主不认渠道名。判据全部是形状与来源，零业务 `if` 分支。

### 落了什么

| 位置 | 改动 |
|---|---|
| `packages/channel-wecom/src/adapter.ts` | **D1**：孤儿收据不再带「，等待你的指令」后缀（删 `RECEIPT_WAITING_SUFFIX`）。气泡本身就是回应，那句把「存个档」误设成待办 |
| `apps/server/handler.ts` | **D2**：`withFileReplies` 挂了回传文件时，在终稿尾部追加一行确定性文字「本轮回传：\<文件名\>」。企微里 file 是独立消息、可能先于终稿到达，用户看到一个不知道是什么的 xlsx；这一行与收据同族（传输事实，不过模型的手），不走出口校验、不进模型上下文。**只点名真的挂上去的那一个**（契约的 `file` 是单数，说 3 个发 1 个就是假陈述） |
| `packages/contracts/src/channel.ts` | **缝 a**：`IncomingChannelMessage` 加 `channel?: string`（缺省 `wecom`）；`IncomingAttachment` 注释显式化 adapter 的义务——把渠道文件落到宿主可见的本地位置，契约只出现本地绝对路径，不是 URL/存储 key/素材 id。**字段名 `wecomUserId` 故意不改**（65 处零行为 churn，PoC 单渠道；接入时同批改） |
| `packages/channel-wecom/src/adapter.ts` | 消息构造处显式 `channel: 'wecom'`——前缀在源头给出，比让宿主猜诚实 |
| `apps/server/handler.ts` | **缝 a 落地**：`DEFAULT_CHANNEL` + `principalIdOf()`；`processMessage` 的 principalId/sessionId 由 channel 拼；`loadRecentAttachments` 改收 principalId（不再自己拼前缀）；队列失败日志同源 |
| `packages/core/src/config.ts` | **缝 a 落地**：`principalScopeRecords` 的 `wecom:` 写死解析改成取键的首段（无冒号的键整体当 userid，存量配置不破） |
| `apps/server/handler.ts` | **缝 b**：模块级 `let arrivalClock` → `ArrivalClock` 接口 + `createArrivalClock()`；宿主持有一把（`deps.arrivalClock` 可注入），判据只认识 `next()`。多实例部署时换共享单调源即可，不必动规则一。**不上 Redis** |
| `apps/server/handler-shape.test.ts` | **护栏（新文件）**：`HANDLER_LINE_BUDGET = 1013` 只减不增。handler.ts 是唯一没拆过也没有机械护栏的大文件，附件机器是它长到 1013 行的主要原因；棘轮把「再往里加一段」从零成本决定变成显式决定 |
| `tests/e2e/turn-loop-attachments.test.ts` | **缝 c**：AT-1 显式钉住 locality 契约（本地绝对路径、非 URL、无签名参数）；D1 的断言与注释同步改写 |
| `docs/test-hardening.md` | T3 行 4 → 5 例（AT-5 自 D-110 波就在，上波计数漏登，本波顺手修正） |
| `docs/manual-test-wecom.md` | §8.8 三条真机验项（收据无后缀读起来是否反而不知要发指令 / 终稿点名与文件消息的邻接感 / 无关回合不复读没有换形态回来） |

### 波次防线与实测记录

- **F1 表征先行**：D1 是断言改写（三条 adapter + 两条 e2e），每条改写理由写在原处；D2 先加红测试（终稿为空时只留点名那一行）再改 `withFileReplies`；三条缝各自先有钉子后有实现。
- **F2 基线冻结**：改造前 `npm test` **1477 全绿 / 114 文件** + typecheck 0 错误（2026-10-20 冻结，即 §13 收口数字）；改造后 **1484 全绿 / 115 文件**（+7：D2 一条、钟三条、渠道前缀两条、shape 一条），typecheck 0 错误，`npm run test:e2e` **35 文件 / 144 全绿**无回归。
- **F3 变异验证**（六条，逐条确认转红后回滚复绿）：① 往 handler.ts 加 5 行 → 行数棘轮红；② 去掉终稿点名 → 2 条 D2 用例红；③ 钟退回 `Date.now()`（不严格递增）→ 2 条钟用例红；④ `createMessageHandler` 不认注入的钟 → 注入用例红；⑤ principalId 前缀写死 `wecom:` → 渠道前缀用例红；⑥ config 的键解析写死 `wecom:` → config 用例红。
- **F4 最小化**：一个主题。改动落在 contracts / channel-wecom / core(config) / apps/server，未碰 `packages/agent` 任何一行，未碰执行层。D1/D2 与三条缝同波，是因为它们同属「为第二个客户端留缝」这一件事的两面（交互修正 + 结构缝），拆开会让中间态同时带着已知缺陷又没有护栏。
- **F5 红先 revert**：无（全程绿）。
- **F6 探针**：不涉及提示词/申报/澄清，无需探针。
- **F7 文档同步**：debt-ledger D-112 + 本 §14 + test-hardening T3 行 + manual-test-wecom §8.8 同批落地。

### 明确不做（防过度设计，登记在案）

1. **不外置附件状态**：`sessionAttachments` / `sessionDelegations` / `sessionQueues` / `lastArrivalAt` 四个 Map 保持进程内。多实例时是换实现不是改语义——但降级行为（重启后按全部未消费）已有测试钉住，接入前先补多实例语义的表征。
2. **不做渠道能力声明协议**（`canAnchorReply` / `frameBudget` / `passiveReplyWindowMs`）：等第二个客户端真来了再做，现在做就是猜测性抽象。
3. **不把企微帧策略泛化成宿主配置**：`RECEIPT_COALESCE_MS` 留在 adapter，不挪进通用 env 当旋钮。
4. **不动实体门**：清单化（引用形态）等出现「模型回显路径真出问题」的实证再动；它现在是纯函数 + 5 个 source，形状健康。
5. **不改 `wecomUserId` 字段名**：65 处零行为 churn，与第二个客户端同批做。

### 未验项（mock 证不了，登记不闭环）

真企微客户端上三件事只能真机确认：① 收据去掉后缀后用户是否反而不知要发指令（文案判断，已写入 manual-test §8.8）；② 终稿点名那一行与文件消息的邻接读感；③ 无关回合不复读没有以别的形态回来。e2e 钉住的是帧序列，不是用户的眼睛。

交互缝波结束。

## 15. D-108/D-109 跨层回归补强（2026-10-20）

**目标**：补上上一波单层测试没有覆盖的三个接缝：企微附件下载与 handler 排队、Main Agent direct 出口与转录持久化、重复请求判据与 route toolResult 的宿主元数据。第二渠道身份隔离仍按 D-112 作为第二渠道接入前阻断门，本波不迁移授权主键或外置会话态。

### 覆盖与修复

| 接缝 | 回归判据 | 修复 |
|---|---|---|
| file 事件已到、`downloadFile()` 尚未完成时正文随后到达 | adapter 集成替身先发 file、延迟 resolve 下载，再发正文；ACK 即时出现，handler 不得在附件暂存前运行；final 与 ACK 共用 req_id/streamId | adapter 按会话跟踪附件处理至 handler 暂存和收据入队；正文在总上界 8s 内等齐，不足时不进 worker，回“附件尚未准备好，请稍后重试” |
| 附件收据与正文收据竞态 | 附件已暂存、正文同时到达时只出现一条收据；持续分批到达不能续长 8s 总上界；停机唤醒等待 | handler 暂存完成后再撤附件收据；使用绝对 deadline 与 stop interrupt |
| 服务器路径经过 direct、转录和可检索 tool result | SP1/SP3 检查普通/direct 回复和 assistant transcript；toolResult 夹路径时 Conversation Log 不保存该路径 | direct 与普通出口统一用 `server-paths.ts`；保存 transcript 和提取可检索 toolResult 前整理 assistant/toolResult 内容，保留原始 user 消息 |
| route 回执误把拦截当 delegate | `{"error":...}` 与 details 标记 `precondition` 不计数；`recorded: delegate` 与 details 标记 `delegate` 计数；用户可见 ToolUserError 文案不变 | ToolUserError 的 `delegationCompleted` 写入 `toolResult.details.routeReceipt`；新转录优先按标记判定。旧转录缺标记时保留既有文本兼容路径（边界见 D-113） |

附件 E2E 夹具的每 boot 输入目录改为 `tmp/attachments/e2e-<boot>-<uuid>`，仍保持独立清理，同时落在 `collectProducedFiles` 的保留输入区内，避免把测试输入误当作本轮产物回传。

### 波次防线与实测记录

- **F1 表征先行**：adapter 延迟下载、重复收据、8s 总上界与停机用例，SP3 direct 路径、transcript/toolResult 路径断言，以及 precondition/委派回执区分用例先复红，再修实现。
- **F2 基线冻结**：§14 收口基线为 **1484 / 115 文件**；改后 `npm test` **1494 全绿 / 115 文件**（+10），`npm run typecheck` 0 错误。全量 mock E2E 需 spawn sibling 17dz CLI；默认沙箱下该只读子进程报 EPERM，本次在显式 `EXECUTION_EXECUTOR=mock` 且无真实提交开关的受审执行中完成全量测试。
- **F3 变异验证**（均已还原）：① adapter 不等待附件处理 → 延迟下载回归红；② 把收据撤销移回等待之前 → 重复收据回归红；③ 按批重置等待 deadline → 8s 总上界回归红；④ direct 路径清理失效 → SP3 红；⑤ 将 `precondition` marker 当作 delegate → 重复请求回归红；⑥ transcript/toolResult 清理恒等返回 → SP1 transcript 与可检索 tool_result 两条断言红。
- **F4 最小化**：改动限于 agent 出口/转录与 route 收据、WeCom adapter 的在途附件处理、现有测试夹具与对应文档；没有增加业务判断分支或接入第二渠道。
- **F5 红先 revert**：无既有行为回退；正常 ACK、附件池语义与用户原始消息保持不变。
- **F6 探针**：不改提示词或申报工具说明，无需真实模型探针。
- **F7 文档同步**：D-113 + 本 §15 + architecture-laws L3 + D-112 渠道隔离接入门同批更新。

**仍登记的边界**：D-112 渠道身份未在授权存储和 handler 内存态隔离；旧转录没有 `routeReceipt` details 时，为兼容既有成功委派继续使用旧文本判据，无法机械区分旧版前置拦截文本。第二渠道接入前必须完成身份主键迁移与隔离表征；旧转录歧义作为部署过渡边界，不写成已修复。

D-108/D-109 回归补强结束。

## 16. 会话级产物库与引用迁移波 · R1–R4 根治（2026-10-20，W0–W7）

**目标**：修 D-114（产物无会话级生命线：交付即蒸发、指针住散文）。设计全文 `docs/artifacts.md`，根因登记 `debt-ledger.md` D-114。单波单主题的七连波：W0 表征 → W1 会话身份 → W2 产物库 → W3 多文件契约 → W4 重发路由 → W5 GC/淘汰 → W6 群语义 → W7 文档。

**基线（W0 冻结，2026-10-20）**：`npm test` 1494 全绿 / 115 文件 + typecheck 0 错误。

| 波 | 改动（位置） | 用例数 | 变异验证（F3） |
|---|---|---|---|
| W0 | 3 条表征先行（`handler.test.ts`：群 per-user session 现状 / 两份交付物只回传第 1 个 / 重发无宿主动路） | 1494 → **1497** | —（golden 由后续波翻转） |
| W1 | session = 聊天窗口：`handler.ts` sessionKey 改单取 conversationId；principal 降为消息级；测试 9 处更新（渠道前缀 / 群共享 / 附件信封键 / e2e 父会话 id） | 1497 | 改回复合键 → **9 红** |
| W2 | 产物库核心：contracts `SessionArtifactRecord/Repo` + `AuditStore.sessionArtifacts`；`core/store.ts` `session_artifacts` 表；新模块 `apps/server/artifact-store.ts`（ingest/manifest/ref 改写/收口）；handler 接入（manifest 注入输入、finishWithFiles 透传 artifactRefs）；assembly 注入 dataRoot。产物机器自 handler 抽取（1104 → 839 行，棘轮 1017 内） | 1497 → **1511**（+11 单测 +3 e2e） | ref 恒 '1' → 1 红；insert 跳过 → 4 红；清单恒空 → 1 红 |
| W3 | 契约 `files[]`：`RichChannelReply.file` → `files`；adapter 逐条发送（每文件独立 try/catch）；withFileReplies 全量挂载 + 点名列全；G2 表征翻转为“两份都发” | 1511 | 只挂第 1 个 → **2 红** |
| W4 | 重发路由：turn-contract `resend` 申报枝（schema/review/描述）；runtime 记账零委派 + `AgentReply.artifactRefs`；handler 三态确定回答（不存在/已淘汰/字节不在）；`server-paths.ts` `stripForeignScratchPaths` + 委派信封接入；收尾指令去路径。runtime 棘轮 1290 → 1298（功能新增留理由） | 1511 → **1525**（+3 申报 +6 路径 +3 handler +2 e2e） | 路由不记账 → 2 红；解析恒无 → 2 红；守卫空操作 → 3 红 |
| W5 | GC/淘汰：`scratch-cleanup.ts` 双年龄策略（终态 grace 1h + 抛弃 TTL 24h + 判据注入）；`main.ts` 终态快照 sweep；`evictOverCapArtifacts`（50 个/512MB 双闸、最旧优先、新批保护、显式 evicted） | 1525 → **1536**（+5 清理 +6 淘汰） | grace 失效 → 1 红；fresh 守卫删 → 1 红（结构性场景） |
| W6 | 群语义：队列键修正——arrivalKey（发送者×会话）管 burst 防抖、queueKey（会话）管回合串行（W1 改了会话键没改队列键，群里两人回合曾并发写共享状态）；e2e 补 A 交付/B 同群指代重发 | 1536 → **1538**（+1 串行 +1 群重发） | 队列键改回复合 → **1 红** |
| W7 | 文档：`docs/artifacts.md` 设计账、debt-ledger D-114、本节 | 1538 | docs-reality 对账 |

**验收**：F1 表征先行且每波 golden 随该波翻转更新；F2 用例数只增不减（1494 → 1538，+44 全可逐条数，115 → 117 文件）+ typecheck 0 错误 + `tests/e2e` 全绿；F3 七波变异全红后回滚复绿（汇总表 `docs/artifacts.md` §7）；F4 每波一个主题（W2 的 handler 抽取是行数棘轮逼出的同波动作，改动集限于产物机器搬迁）；F5 无红 state 叠补丁——两处 flaky（mtime 同毫秒竞态）以拨到确定过去修复而非放宽断言，两次变异迭代暴露的测试缺口（淘汰 fresh 守卫不可达、resend 路由无覆盖）以加强测试解决而非删断言；F6 见下；F7 文档同提交（artifacts.md / D-114 / 本节），`docs-reality.test.ts` 对账通过。

**F6 探针（W4 改了 `route_current_turn` 工具描述——提示词级）**：改后同参数复跑 `--only A1,A2,A4,A5`（real LLM + mock 执行器）：A1 ✓ 93.2s/7 调用（重问真的重查）、A2 ⚠ 214.5s/4 调用（第二轮带旧账套"幻辰"——与 2026-10-11 冻结基线同形状的既有模型侧观察项，未劣化）、A4 ✓ 35.9s/1、A5 ✓ 3.3s/0。**登记观察**：A1 平台调用 7 vs 冻结基线 4——明细显示两轮各 4+3 次，多出的调用是 worker 两轮都重新提交计划（“期间范围无法可靠识别”的重报形态），属 worker 侧不确定性；A1 的 ✓ 判据（重查而非复述旧答案）成立。隔夜基线 + 其间 D-109/D-113 波 + 模型不确定性使归因不可立，记为观察不记为回归；真机上"重发请求走 resend 枝、零委派、文件从库里回传"已由 e2e（turn-loop-resend R1/R2/R3）钉住，待用户复跑确认。

**未关/留缝（详见 `docs/artifacts.md` §6）**：D5 委派 setup 按 ref 物化未做（driver↔库接缝跨层；当前以外来路径剥离 + 留痕替代）；`worker_messages` 保留策略未验证（溯源投影源寿命）；R4 长会话摘要纪律未收敛；`artifact_ref` 事件槽位仍未启用（独立表的理由写在列声明处）。

会话级产物库与引用迁移波结束。

---

## 17. 计划提交空转治理波 · `--file` 通道 + 形状失败收敛 + 元数据自救（2026-10-23，C1–C4）

**目标**：治 2026-10-23 实测的计划提交空转。`req_368b68b3`（「列一下清单看一下先」）367s / 656,960 tokens，其中 4 分 11 秒是 11 次 `plan_submit` 连续 `PLAN_JSON_PARSE`；`req_17790072`（查李华欠款）同形态 188.8s / 241k tokens。平台侧行为干净（当日 6 次平台调用、零循环），问题全在"模型写不对裸 JSON 而机制不兜底"。三个改动：C2 `--file` 提交通道（主修，治结构）、C3 形状失败计入收敛计数（兜底，治无界）、C4 `plan --schema` 元数据自救复活（小的通道修复）。设计论证与归档取证见 `debt-ledger.md` 对应补充记录。

**根因（三重，全部有审计出处）**：① 宿主解析的是**原始命令字符串**（`plan-runtime.ts` payload = `plan` 令牌之后的命令原文），模型本能的 shell 引号（`'{…}'` / `"{\…}"`）与命令尾巴（`2>&1` / `; echo`）原样进 `JSON.parse`；② 熔断器 `MAX_DECLINED_PLANS_PER_TASK=5` 只在 `decidePlanSubmission`（解析成功之后）自增，形状失败在 `parsePlanCallsCommand` 抛出点提前返回、**从不计数**——11 连撞因此完全绕过熔断；③ `bin/17dz plan --schema`（执行层 SKILL 教的自救出口）被 driver 的计划解析当坏 JSON 拒掉，serve-gate 里为它写的元数据白名单（`SERVE_METADATA_COMMANDS`）因 driver 先行拦截而不可达——文档教的是个死命令。

**基线（C1 冻结，2026-10-23 11:00）**：`npm test` 1545 全绿 / 118 文件 + typecheck 0 错误。

| 波 | 改动（位置） | 用例数 | 变异验证（F3） |
|---|---|---|---|
| C1 | 4 条表征 golden 先行（`plan-shape-fuzz.test.ts` 3 条：`--file`/`--schema`/`schema` 当前按坏 JSON 拒；`pi-coding-driver-plan-audit.test.ts` 1 条：20 连形状失败不触发收敛） | 端点未单独实测（与 C2 合并见下；"1549"是枚举推算，不当实测引用） | —（golden 由后续波翻转） |
| C2 | `--file` 通道：`plan-runtime.ts` 分发器（`PlanSubmission` 联合类型 + `PLAN_FILE_FLAG_RE` 行尾硬边界 + `parsePlanCallsPayload` 纯校验抽出，inline/file 两条通道共用一份判据）；`pi-coding-driver.ts` `resolvePlanSubmission`（边界 = 提案 payload 同一把尺 `workspaceRelPath`+`isInsideScratch`、缺 scratchDir fail-closed；体积 = 导出复用 `MAX_WRITE_BYTES` 256KB；内容 = 同一份 payload 校验）；`error-codes.ts` 双形态教学（`planFileExample()` + `CORRECT_PLAN_SHAPE` 两形态并列 + 反模式"不要加引号/不要跟 2>&1"）+ 3 个新码（`PLAN_FILE_FLAG_INVALID`/`PLAN_FILE_OUT_OF_WORKSPACE`/`PLAN_FILE_TOO_LARGE`）；`index.ts` 导出。审计 detail 带工作区相对路径 | 1545 → **1563**（+18，含 C1 的 4 条与 C1 golden 改写，C1/C2 之间未单独测） | 边界尺改永不拒 → **4 红**（越界 / 缺 scratchDir / `..` 穿越 / 符号链接） |
| C3 | 形状失败计入收敛：`decideToolCall` catch 处自增同一 `declinedPlans`，超限返回既有 `PLAN STOP`+`DECLINED_PLAN_LIMIT` 终局（措辞纪律不变：提交次数不伪装成拒绝次数，D-099）；归零点仍只有 ACTIVE | 1563 → **1564** | 注掉 catch 自增 → **5 红**（单测 4：纯形状/文件通道/混合/终局后递增 + e2e A4b） |
| C4 | 元数据自救：分发器对旗标形态 payload（`--` 开头 + `schema` 别名）返回 null——不当计划提交、不计收敛，落 serve-gate 既有裁决（元数据白名单放行到平台 CLI 逐字打印 plan-schema.json；未知旗标落门的计划教学分支，C2 起已教双形态） | 1564 → **1566** | 停掉旗标放行 → **8 红**（fuzz 3 条 null + 单测 2：schema 不计收敛/带尾巴元数据 + e2e A6/A6b/A6c） |

**验收**：F1 表征先行且四条 golden 随 C2/C3/C4 各自翻转（fuzz 3 条 + audit 1 条；翻转点在各波测试注释注明）；F2 用例数只增不减（1545 → **1582**，+37 全可逐条数：本波 C1–C4 共 21 条 + review 补强 16 条（R1/R2 的 14 条 + Round 2 的 2 条判别用例），118 文件不变）+ typecheck 0 错误 + `tests/e2e` 全绿（含新增 A4b 形状连击收敛、A6/A6b/A6c 元数据通道三条）；F3 四个变异全红后回滚复绿——C2 边界尺 4 红 / C3 计数 5 红 / C4 旗标放行 8 红 / R1 isFile 守卫 1 红，均为**单测 + e2e 全量范围**重跑取数（波次表原记的 2/1/3 红是单测范围的旧覆盖面，Round 1 对账时修正），回滚后全量 1582 复绿、无 MUTATION 残迹（grep 实证）；F4 每波一个主题（C2 的解析/驱动/教学必须同 commit——`plan-teaching.test.ts` 的 D-011 锁要求教学与解析不互相打架）；F5 无红 state 叠补丁——两处测试失败都以改设计而非改断言收场：① `error-codes.ts` 注释里为描述 D-011 锁把锁的字面量本身写进注释，锁计数 1→2 红，改注释措辞（不在注释复述被锁的模式）；② 泄漏 lint 字面量 if 预算抓住第一版 C2 的 `!== '--schema'` carve-out（针对具体输入值的字面量比较 = 症状嗅探），未申请白名单而是把未知旗标分支整体移出 C2——C4 的"旗标返回 null 交门裁决"结构让它从数据判据自然长出来，专用码也不再需要；F6 见下；F7 文档同提交（本节 + debt-ledger 补充记录 + `plan-teaching.test.ts` 头注释修正）。

**与设计文档的三处偏差（都有据，非静默发散）**：① `PLAN_SHAPE_UNKNOWN_FLAG` 专用码**未建**——未知旗标落门的 `PLAN_SHAPE_GATE_TEACHING`（已教双形态），driver 侧设码只会把同一判决复制第二份；② 文件读上限**复用** serve-gate 导出的 `MAX_WRITE_BYTES`（256KB）而非新常数——bash（python3 落盘）绕得过 write 工具那侧上限，宿主读需要自己的界，但数字只有一份；③ 新增第三个码 `PLAN_FILE_TOO_LARGE`（方案原列两码）——体积越界与路径越权是不同的失败模式，合并即谎报。

**F6 探针（未跑，待用户确认）**：本波**未改静态提示词**——worker 提示词经 `planCommandForm` 注入的取值 = `planDraftExample()`，逐字节未动（`planDraftExample` 本身不变，新增的是并列的 `planFileExample`）；改的是运行时诊断（PLAN DECLINED 理由 / 门教学话术）。冻结基线可用 §16 W4 的 A1/A2/A4/A5（A1 7 调用/93.2s、A2 ⚠ 4 调用/214.5s、A4 1 调用、A5 0 调用）。真实 LLM 复跑需用户确认（花费真实 token）；建议判据 = A1/A4/A5 不劣化 + **新增观测量**：每轮 plan 形状拒绝数（今天形态 11 → 预期 ≤2，最坏 6 熔断）。

**Round 1 review 补强（2026-10-23 下午，R1–R2；五个独立审查员并行）**：五视角审查（文件通道安全 / 计数器语义 / 回归保真 / 测试充分性 / 文档对账）后落地两批修复。**R1 三处代码修复**：① `--file` 分发守卫补 tab 形态——守卫/取值正则/码表措辞三处曾各说各话（守卫只认空格、正则 `\s+`、码表写"空格"），tab 发射会静默落 null 变成"非计划命令"（文件通道对一种常见模型形态静默失效），统一为 `[=\s]` 归一；② `reportPlanSubmission` detail 补 `AUDIT_DETAIL_MAX_CHARS` 截断（提案路径早就有，计划上报是唯一没挂尺子的出口）；③ 读文件前 `isFile()` 守卫——FIFO 的 size 为 0 但 `readFileSync` 会无限期阻塞，而 `beforeToolCall` 没有超时（对照 `defaultCliRunner` 的 30s SIGTERM），挂住的是宿主这一跳；读后 `Buffer.byteLength` 复核收 stat→read 的 TOCTOU 实际窗口。**R2 补 13 条判别性用例**（1566 → 1579；连同 R1 的 tab 分发用例共 +14，合计 1566 → 1580；Round 2 复审又补 2 条判别用例（`parsePlanCallsPayload` 的 user_confirmed 提取点、审计 detail 截断尺子——各自由 Round 2 变异实证判别力）至 1582）：`PLAN_FILE_TOO_LARGE` 零覆盖、`..` 穿越归一与符号链接逃逸（原有越界用例被任何朴素 `startsWith` 实现同样拒掉、不判别——这两条才判"真尺子"在不在）、工作区内绝对路径（worker 从 write 回执拿到的自然发射形态；一次"拒绝对路径"的加固就会把主通道变成死路）、文件坏内容 6 连撞收敛（文件通道版 C3）、混合 3 形状+3 越权计数且终局串逐字一致、终局后第 7/8/9 次 N 递增稳定、`--schema` 连提不计收敛、跨通道归零（4 败→文件激活→再 5 败）、子目录/目录当文件/`user_confirmed` 走确认门/带尾巴元数据放行。**三处既有行为经审查确认但登记不随波改**（各有权威注释）：写关闭路径不计入计数（与"熔断对该类失效"同形，但被 `writeClosed` latch 部分兜底且属既有语义，改它需要自己的波次）；计数器作用域是每次委派而非每任务（常量名与码表文案说 PER_TASK，任务级上界实为乘法——声明处补注释说明）；保留子命令（`plan current`/`status` 只读查询）计入提交数（措辞在该历史上虚增、概率低；排除它 lint 并不拦——错误码是标识符形判据、lint 明确背书数据判据，但排除会把这类拒绝重新变成无界空转，正是 C3 抗的向量，故登记不排除）。审查员环境无 `run_command`，全部定量结论由本会话实测复核；其中一处**测试设计算术错**（"5 败后接合法提交"——那次提交自己就是第 6 跳、撞 cap 到不了激活）以改测试收场，产品行为经复核无误。**Round 2 复审（三视角：测试判别性对抗验证 / 登记不修理由复核 / 完备性批判）**：结论无必须处理项；其指出的 5 条弱判别测试已加固（各补能杀死对应存活变异的断言）、2 条新判别用例已补（`parsePlanCallsPayload` 的 user_confirmed 提取点、审计 detail 截断尺子——原先均无主）、计数器作用域注释已落代码；对 R2 新测试补做三个变异实证判别力（原始串前缀替边界 → 3 红 / 终局后重置计数器 → 1 红 / 停体积双闸 → 1 红，回滚后复绿）；一处登记理由经复核更正（保留子命令计数的原"字面量 if 预算"理由不成立——错误码是标识符形判据、lint 明确背书数据判据——改为"概率低 + 排除会重开 C3 抗空转向量"）。

**未关/留缝（登记，不阻塞）**：① **17dz-platform SKILL.md 跨仓更新未落**（方案 gate：单独确认后落）——`17dz-query/SKILL.md` 的"计划草案形状"节应改教"write 计划 JSON 到本轮工作区 → 本地 lint → `bin/17dz plan --file` 提交"工作流；`plan --schema` 自救指令 C4 后已真实可用，保留；② **`voucher.assistant-map` 能力与 SKILL.md 矛盾未修**——2026-10-23 09:31 那轮据此给过用户错误结论（"平台没有列举客户档案的能力"，实测 assistant-map 一次拉回 99 客户 + 759 供应商），修法同属跨仓 SKILL.md，与①同批；③ F6 探针待确认；④ 长期：结构化调用协议（`docs/a2a-protocol.md`）取代裸命令行 JSON 后，本类失败整体消失，`--file` 通道是它的踏脚石。

计划提交空转治理波结束。


## 18. 原生引用与后台会话首版（2026-10-24）

范围与设计见 [interactive-session-plan.md](interactive-session-plan.md)，实际范围以该文 §9 为准。按用户要求并行 Luna/max 实施；保留实施前的脏工作树，不以 `HEAD` 代替本轮基线。未部署、未重启、未调用真实业务平台或真实企微。

| 防线 | 本轮记录 |
|---|---|
| F1 基线 | 实施前工作树归档 `/tmp/fshine-interactive-worktree-start.tar.gz`；冻结解包在 `/tmp/fshine-interactive-baseline-tree`。真实 CLI 仅 mock：`EXECUTION_EXECUTOR=mock FSHINE_PLATFORM_ROOT=/home/fictional-user/fictional-projects/fictional-execution-layer npx vitest run --maxWorkers 2`，**1582/1582，118 文件**；typecheck 通过。日志 `/tmp/fshine-interactive-baseline-frozen-valid.log`。沙箱内 Node spawn 的 EPERM 试跑不算产品失败或有效基线 |
| F2 先红后绿 | 分波冻结 quote 契约/历史/正文确认、后台受理出口、任务 run 持久化与 CAS、共享 gate 排队取消、输入物化、宿主确认、主动交付及多步原范围续跑。根补 `pi-driver` 后台回执与自定义消息 LLM 投影、输入快照、提案 task 范围、待确认取消、真实 assembly 交叉提问 e2e。复审要求补压缩 sidecar 与预算确认后台续跑 |
| F3 变异 | 独立目录 `/tmp/fshine-interactive-mutation`，不改共享源码：移除引用 fingerprint → **2 红**；移除 grant 后启动前 abort 复核 → **1 红**；移除完成事件重复消费守卫 → **1 红**。恢复后三组 **32/32 通过**。日志分别为 `/tmp/fshine-interactive-mutation-{quote,gate,event}.log` 和 `-restored.log`；变异源码不带回工作树 |
| F4 改动边界 | 仅通用渠道/上下文/任务/确认/产物交付机制；执行层业务规则不迁入主流程。新 schema 是兼容添加。`runtime.ts` 沿用 **1298 行**预算，不上调；大型函数抽入专用模块并保持依赖无环 |
| F5 回归 | 第一次完整 mock：**1682 通过、4 失败 / 127 文件**，失败为新增通用状态/环境变量/词归属登记及防御函数迁移的静态守卫；不得靠缩小扫描放行。修复登记与防御函数迁移守卫后，最终完整 mock **1706/1706、129 文件全部通过**（相对冻结基线 +124 项、+11 文件）。日志 `/tmp/fshine-interactive-final-full.log`；`npm run typecheck` exit 0（`/tmp/fshine-interactive-final-typecheck.log`）；`git diff --check` 通过 |
| F6 真实模型 | 自动审批拒绝：探针读取真实 `.env` 并向模型服务发送提示词、有调用费用，未得到明确外发授权。没有换命令绕过。改前/改后真实模型对照与真实企微验收仍待授权，不宣称已完成 |
| F7 回滚 | 默认 `FSHINE_WORKER_DISPATCH_MODE=inline`；显式 `background` 开启。关闭只影响新委派；既有后台任务仍要完成/取消并 drain 后才能回退代码。保留 task_runs/引用/产物关联列，不删历史。重启只标 interrupted，不自动重跑 |

验证命令不读取 `.env`：`EXECUTION_EXECUTOR=mock npx vitest run --maxWorkers 2`、`npm run typecheck`、`git diff --check`。真实 CLI 测试允许创建本地 mock 子进程与 localhost 服务，不启用真实执行器。

最终交叉会话 e2e 六条全部通过，包含原生引用、Worker 阻塞期间下一问、文字与多个文件主动交付、排队取消、A/B 交错时 A 原范围续步、真实预算确认路径后台续跑。取消门补齐授权失效屏障与最后一次状态读取期间的竞态；任务最新 run 按注册顺序判定，不按随机 ID 或旧交付更新时间。压缩 sidecar 有界保留引用出处和去重计数（边界见方案 §9）。源码已冻结；未提交、未部署或重启服务。

## 19. Review 修复波（2026-10-25）

对未提交工作树（§16 产物库波与 §18 原生引用/后台会话波叠合）做六切片并行深度 review（runtime/turn 生命周期、context 周边、agent 新模块、apps/server、contracts/core/wecom、e2e/文档），按发现分片修复、逐项验收。部分修复（7 个红灯防线的对账、文档状态翻转、server 侧 result_handling_state 与投递清扫/重试的主体实现）由并行工作先落地，本波补齐缺口并验收终态；账目按终态事实记，不按作者。未部署、未重启、未调用真实业务平台或真实企微。

| 防线 | 本轮记录 |
|---|---|
| F1 基线 | review 时点实测：`npx vitest run` 1684 用例 / 127 文件 **7 红**（architecture-shape 棘轮 1342>1298、runtime.test 两条新断言、docs-reality 锚点、platform-leak-lint 三条登记缺口），typecheck 0——红项全部为防线测试未随两波对账，非生产代码正确性缺陷 |
| F2 先红后绿 | 8 项 P1 修复全部新表征先行，红形态即缺陷本身：外来路径剥离主拷贝（红=worker 委派块任务正文仍含 `tmp/task_…`）/ 确认闸等待上界 10s（红=确认挂闸至测试超时）/ 同 taskId 并发提交同步预留（红=双提交双 run 双 Worker）/ 后台零执行熔断（红=连续零执行照旧派发第 4 步）/ 后台受理回执落转录（红=同文重发的退回重填不发生）/ `result_handling_state` 列迁移（含旧库回填用例）/ 投递清扫 + 有界重试（红=崩溃残留永久 pending 且被永久 pin）/ 重发读回 sha256+size 复验（红=坏哈希照发） |
| F3 变异 | 未另设变异目录：先红后绿的红形态即等价变异证据（各修复报告附红绿命令记录）。防线侧：platform-leak-lint 词条登记（含理由）、docs-reality 锚点随迁、两处行数棘轮全部回绿且理由在档 |
| F4 改动边界 | 全部为通用机制（路径剥离、并发闸等待上界、任务预留原子性、熔断持久化、转录续写、投递状态列、清扫与重试），无执行层分支引入；`result_handling_state` 是通用投递语义列，契约声明后 metadata 注释同步降为 mirror。serve-gate 授信期门零改动零绕过（六切片逐条核对政策四条：放行仅审计 / 元字符软放行 / 非 local 网关计划前置 fail-closed / 放行 bash 留执行痕迹） |
| F5 回归 | 终态实测：`npx vitest run` **1725/1725、129 文件全绿**（review 起点 1684/7红 → 对账与修复后 +41 用例）；`npm run typecheck` exit 0。棘轮：runtime.ts 1298 → 1311（后台受理回执落转录 +13，理由在 architecture-shape.test.ts 文件头登记）；handler.ts 1017 → 907（压掉 110 行余量——"留余量等于没压"） |
| F6 真实模型 | 未跑（与 §18 F6 同因，待授权）。本波不改系统提示词与工具说明文本；转录续写与委派剥离是宿主机械行为，模型侧观感待真实渠道验收 |
| F7 回滚 | 修复为行为修正，无新增开关；后台模式开关与回退口径沿用 §18 F7。新列 `result_handling_state` 保留（向后兼容迁移，旧库重开不炸、回填幂等） |

review 遗留 P2 共 21 条逐条核实后登记为 D-115–D-135（见 debt-ledger.md 2026-10-25 补充记录）；§16 的过程数字（handler 1104→839）为波内中间态、当前树 907，已在账内标注。

## 20. P2 清偿波（2026-10-26）

对 §19 登记的 21 条 P2（D-115–D-135）按"可机械收口 vs 需设计决策"分批清偿：两波 subagent（apps/server 生产 6 项、packages/agent 5 项）+ subagent 用量受限后协调方亲落地 core/contracts 3 项与测试质量 2 项；部分表征测试由并行会话先行写红（D-123 四条、D-129/D-135a 两处）。**关账 16 条、留账 5 条**（D-115/D-117/D-119/D-120/D-132，需设计决策）。未部署、未重启、未调用真实业务平台或真实企微。

| 防线 | 本轮记录 |
|---|---|
| F1 基线 | §19 终态 1725/1725、129 文件 + typecheck 0（本轮起点；除先行红 4 条 D-123 表征） |
| F2 先红后绿 | D-123（先行红 4：fail-loud×2 + 排序×2 → 绿）；D-125（强化断言 + 变异：去分类→2 红→恢复绿）；D-135b（新反向钉 + 变异：喂引用文本→2 红→恢复绿）；D-116（上限置 MAX_SAFE_INTEGER 复现旧行为→3 红）；D-131（瞬断/持续失败/确定性错误三态）；D-133（互斥串行，改前事件插队红）；D-126/D-134（background×缺能力装配红→绿，inline 两态放行钉住）；其余各项均有新表征（详见 debt-ledger 各条收口摘要） |
| F3 变异 | 本波三处显式变异记录（D-125/D-135b/D-116，见 F2）；D-124 跨进程 TOCTOU 无单进程确定性表征——UPDATE 租约条件为结构性闭合，机械锁=租约语义两态钉（注入时钟：有效租约 busy 抛/过期可取消），如实记录不冒充 |
| F4 改动边界 | 全部为通用机制（fail-loud 契约错误、CAS 语义、装配校验、上限与截断、收据单一权威）；渠道语义留在 server 层（D-131 经 onBackgroundNotice 回调内包重试，task-manager 零改动）；无执行层分支引入；serve-gate 零触碰 |
| F5 回归 | 终态实测：`npx vitest run` **1759/1759、130 文件全绿**（较 §19 +34，全为新增/强化用例）；`npm run typecheck` exit 0。棘轮零动：runtime.ts 1311、handler.ts 907（D-133 增 4 行靠注释压缩抵扣） |
| F6 真实模型 | 未跑（待授权，与 §18/§19 同因）。D-122 为结构参数化且 golden 钉逐字节不变（2650B），提示词文本零变更 |
| F7 回滚 | 行为修正无新开关；新增错误类（SessionArtifactRefConflictError/TaskRunActiveConflictError）为兼容添加，旧调用方接住 Error 的行为不变；insert 由覆盖转 fail-loud 是语义收紧——调用方（artifact-store）经核实不存在自然冲突路径，串行队列纪律不变 |

留账 5 条的收敛方向已写入 debt-ledger（D-115 inline 物化、D-117 不变量先定义、D-119 messageId 身份、D-120 随 a2a 协议批次、D-132 drain 重排）。

## 22. 出口卫生收口波（2026-10-26，D-136/D-138）

Z1 扇出探针与 F6 重场景批暴露的出口卫生两项同批收口。根因同源：执行语言指纹尺（execution-language.ts）此前只用于 worker 附注准入与探针事后扫描，**从未接过用户终稿出口**。修法：reply-exit 出口第三支（删除式，与"删路径不删结论"同纪律）——判据只收零争议形态（EXECUTION_LANGUAGE_SCRUB_PATTERNS）：工具调用协议标签（`<tool_call>`/`<function=…>`/`</parameter>` 族）与全大写错误码；JSON 片段/operation 名/内部控制词仍由指纹表守（探针可见），不进删除集（误删风险大于收益）。**宿主码表词白名单**（HOST_ERROR_CODE_NAMES，Object.keys(TABLE) 机械生成）：TASK_FORBIDDEN 族出现在宿主自己的确定性话术里，码上屏是既有产品行为（8.2 等用例钉住），删除只针对平台/worker 侧泄漏。整段协议（剩余非 ASCII 可读字符 <4）替换为格式异常兜底话术，不给用户只有残渣的气泡。direct 出口（宿主合成文本）不接删除支——留观察。

| 防线 | 本轮记录 |
|---|---|
| F1 基线 | §21 终态 1772/1772、131 文件 + typecheck 0 |
| F2 先红后绿 | reply-exit 四条新用例红 3（删除/兜底/错误码）→ 实现 → 绿 14；变异：短路删除支 → 3 红 → 恢复绿。既有用例回归暴露三形态：8.2 宿主码误伤（白名单修复后回绿，无需改用例）、D4④ 基线用例随收口**有意翻转**（★缺口标记移除，narration 期望改删除后形态）、D5 注入变体断言翻转（AUTH_EXPIRED 不再上屏、叙述其余保留，冷却判据断言不变） |
| F3 变异 | 上述短路变异；白名单判别力由"宿主码表词保留"用例钉住（TASK_FORBIDDEN 全文不变） |
| F4 改动边界 | 纯出口文本整理，零业务字段；白名单机械生成无第二份手抄；error-codes.ts 追加导出不改表 |
| F5 回归 | 全量 **1777/1777、131 文件**全绿（+5：reply-exit 4 新 + 宿主码保留 1）；typecheck 0；棘轮零动 |
| F6 真实模型 | Y1 复验（mock 执行器）：**"回复泄漏执行语言（错误码）"警告消失**——收口前改后两跑都报、收口后不报；本轮剩余 ⚠ 为与基线同族的行为波动项（第3轮期间未体现）。Z1 的 XML 形态为偶发模型畸形，删除支已有单测钉死形态判据 |
| F7 回滚 | 删除支零状态、纯函数；回退 = 移除 scrubExecutionLanguageReply 调用一行；兜底话术与删除事件（execution_language_scrubbed）均留痕可观测 |

## 23. 出口收敛波：续跑终稿过尺（2026-11-01，D-144）

2026-10-31 复跑实测：`confirmed_plan_resumed` 回合的整理模型把 `route_current_turn` 申报写成正文（该轮 `tools:[]` 无申报通道），续跑分支在 runtime.ts 提前 `return { text }`——出口两把尺全在其后，只服务正常路径（runtime.test.ts 注释早自认「一条都没继承」）。且 §22 第三支对它失明：申报参数本身是中文，删标签后剩余 56 汉字 ≥4，「整段协议」兜底不触发——**第三形态：终段=申报且参数携带自然语言**。修法：①protocol-material 新增 `isWholeReplyRouteDeclaration`（窄判据：XML 形须标签与参数块之外一无所有；JSON 形 `"kind"` 首键+整段解析成申报键——正文引用小段 JSON 的正常回复天然不命中）；②reply-exit 接整段替换支（**先于删除支**判定，删标签会毁掉形状），fallback 优先调用方给的真实执行产物（resume 处=stripFootprint(worker 文本)），缺省格式异常兜底；③resume 分支与确认直达出口（matchConfirmation direct）全部接 `sanitizeUserVisibleReply`/`sanitizeDirectExitReply`——出口从「走廊工位」收敛为「每条 return 必经的门」；被改写时转录只留用户真正收到的那一版，warn 事件 `route_declaration_reply_replaced` 留痕。

| 防线 | 本轮记录 |
|---|---|
| F1 基线 | 真·main 基线（两仓净、含未跟踪文件）：1783 通过 / **4 既有失败**（2.7 取代路径、8.1 乒乓、A2×2 档位边界——归因 b424b26 预算容量模型改档位语义后 fshine 断言未同步，立项 D-145；非本波引入） |
| F2 先红后绿 | reply-exit 新 3 用例（泄漏 XML 原文含中文参数/JSON 形/不误伤混合形态）红→绿；runtime resume 块注入泄漏文本 → 断言终稿干净且等于 worker 回落 |
| F3 变异 | 短路整段判据 → 新用例红（subagent 汇报红绿证据）；「标签混在自然语言里」用例钉住窄判据不误伤（D-138 第一形态仍走删除支） |
| F4 改动边界 | 纯出口文本整理零业务字段；判据纯形状不嗅内容；`looksLikeProtocolMaterial` 同步受益（正常路径协议复读门补 XML 形） |
| F5 回归 | 全量 1783 通过 / 4 失败（与真·main 基线**集合完全一致**——零新增失败）；typecheck 0。⚠ 归因过程踩坑记录：`git stash` 不带 `-u` 时新脚本残留盘上触发「孤儿脚本」lint 失败，曾误读为 143 失败——e2e 基线实验必须含未跟踪文件 |
| F6 真实模型 | 端到端验收另行执行（多步扇出续跑过第 3 步） |
| F7 回滚 | 判据与接线零状态、纯函数；回退=移除两处接尺调用；替换事件留痕可观测 |

## 21. 停机加固与受理幂等波（2026-10-26 第二波）

对 §20 留账中 3 条机械项收口：D-132（并行实施、协调方逐处复核）、D-119/D-120（subagent 因用量限额不可用，协调方亲落地，纪律不变——红先行、mock-only、变异验证）。**关 3 条，留 D-115/D-117 待用户拍板**。未部署、未重启、未调用真实业务平台或真实企微。

| 防线 | 本轮记录 |
|---|---|
| F1 基线 | §20 终态 1759/1759、130 文件 + typecheck 0（本轮起点） |
| F2 先红后绿 | D-132 四组用例（迟到提交拒绝/末道闸收卷/闸幂等/drain 解析）；D-119 四条单测（变异短路查重 → 4 红 → 恢复绿）+ 1 条 e2e（同 msgid 重投 → worker 恰一次、run 恰一条、二次重放 run 终稿；harness 增 messageId 覆盖缝，缺省随机不变）；D-120 反方向守卫（变异回引旧名 → 红 1 → 恢复绿） |
| F3 变异 | 三处显式变异记录（见 F2）；D-132 的停机竞态在单进程内不可确定性表征跨进程交错——末道闸/在飞闸以窗口语义用例钉住（迟到提交/二次信号），如实记录 |
| F4 改动边界 | D-119 幂等键 = 渠道层已验签回调的 msgid（信任边界写在判据处）；dispatchKey 语义不动（多形态身份）；D-120 纯类型层零运行时变化，旧名 deprecated 别名过渡。无执行层分支引入；serve-gate 零触碰 |
| F5 回归 | 终态实测：typecheck 0；全量 `npx vitest run` **1772/1772、131 文件全绿**（较 §20 +13，全为新增用例）。棘轮：handler 907 → 956（D-119 功能新增，理由登记于 handler-shape 文件头）；runtime 1311 未动 |
| F6 真实模型 | **两批已跑（2026-10-26，用户授权，mock 执行器全程平台零外发）**。①quick 批：A1/A2/A4/A5 绿；B1 ⚠ 判为断言不适配 not_found 形态（mock 对 202609 无数据，模型五轮诚实不编造），断言已按 Y2 先例适配（换幻辰财税 202606=61,000 有数据组合）并以真模型复验 1/1 无异常。②重场景批（G1,G2,X1,X2,Y1,Y2）：**3/6 无异常（G2/X2/Y2 绿）**；G1/X1/Y1 ⚠ 经**改前基线对照判定全部为既有行为、非四波回归**——基线 = 3b97f51 worktree（config/agent.yaml 为 gitignore 文件需补入），同版脚本（diff 仅 B1 适配，对照批不含 B1）跑同场景：G1 基线出现逐字相同的"计划未恢复"警告（且基线 26 次平台调用/285 万 token vs 改后 18 次/180 万——改后反而收敛）；X1 基线同族警告清单逐项对应（步骤通知/澄清候选/D-072 静默代解析，历史高频波动区）；Y1 基线同样泄漏错误码形态（Stage 3 事故家族老缝，轮次不同）+ 另多一条期间未体现。两批日志 /tmp/f6-probe-quick.log、/tmp/f6-probe-heavy.log、/tmp/f6-probe-baseline.log，明细 .runtime/probe-fshine-probe-{4YFCub,7GM9Oy}.json。次生事件登记不阻塞：context 语义抽取辅助模型偶发空响应/超时（有降级路径）、收尾关库后迟到日志写入（良性时序）。Y1 的错误码泄漏老缝与 G1 计划恢复波动建议另行立项（模型行为调优，非编排层缺陷）。真实企微渠道验收仍待渠道侧授权 |
| F7 回滚 | D-119 查重先于副作用、未命中路径零变化（既有 130 handler 用例全绿作证）；D-132 闸默认生效、drainMs 缺省值即旧行为上限放宽；D-120 旧名别名保兼容 |

## 24. 纯编排波（2026-11-04，pure-orchestration-p1：P1 + P2 + 收尾修复）

**范围**：`origin/main`（`33c1a31`，2026-11-01）→ `91bf841`（2026-11-04）的 35 个提交。本节是事后补档（F4 主题债，debt/process-debt 分支），不是波次当时的逐 commit 验收记录——当时的逐项证据以各提交信息与 `scripts/eval/GENERIC_MOCK_NOTES.md` 为准，本节只补当时缺失的三样：每子项的验收与回滚开关、F3 变异留档、新硬控制的标定登记入口（详见 debt-ledger 2026-11-04 补充记录 D-146–D-149）。未部署、未重启、未调用真实业务平台或真实企微（本补档只改文档/台账）。

| 子项 | 改动（提交） | 验收（波次内已有证据） | 回滚开关 / 回滚代价 |
|---|---|---|---|
| P1 网关 profile 化 | 网关调用形式由 `profile.gateway` 派生（`321e528`、`0bad668` 接口文档 v1、`17d5670` mock 网关改名、`27cc43` 文本识别随 profile、`807d359`/`3662826` e2e 归属） | 通用 dummy 网关 + stock 第二执行层 e2e（`1d371e4`，9 例）+ 通用模型基线 v1（`3acfb05`，3 轮机械 21/21） | **开关**：profile 不声明 `gateway` 时走遗留缺省（`resolveGatewayText` 回退 `bin/17dz`，接口文档 §10 过渡）。**代码回滚** = revert P1 提交；代价是回到"网关名散写"状态，不影响已落盘数据 |
| P1 预算叠加 | 计划评估接预算 overlay，weight fail-closed、宿主档只收紧不放宽（`0f4bc22`，`plan-budget-overlay.test.ts` 6 例） | 新 6 例 + `plan-runtime` 29 例（提交信息内实测） | **无运行时开关**；回滚 = revert `0f4bc22`。代价：weight 缺失/非法时不再 fail-closed，回到"丢弃 weight 字段"状态 |
| P2 步数帽 | 自由 worker 步数帽默认 50，第 51 次放行送一次收尾 steer（`4332660`、`703ebf6` 生产跟踪器、`91bf841` 计数分区修复） | 通用 mock 21/21（`4332660`）+ `gate-call-counts.test.ts` 4 例（`91bf841` 提交信息：unit 104 文件 / 1706 例 + `eval:generic-mock` 21/21） | **旋钮**：`stepCap` 选项 / `FSHINE_WORKER_STEP_CAP` 环境变量可调大（非法值回退 50，不崩溃）。**代码回滚** = revert `703ebf6` + `91bf841`；代价是回到旧计数缺陷（executor 调用双计、收尾 local 调用丢计数，可能静默压住 `platformExecutorBypassed` 披露） |
| P2 提案复核 fail-closed | 未注入复核驱动 / schema 未下发 / 复核不一致 → 一律不发确认码、不落意图（`92f7ed8`、`de9a462`、`5b30525`） | 生产接线测试（`production-wiring.test.ts` §5/§11）+ 通用 mock 21/21 | **无运行时开关**；回滚 = revert `92f7ed8`。代价是**重开旧洞**：复核可被 `proposal_review_skipped` 跳过继续（见 D-148）。生产回滚前须先接受该代价，不得以"先回滚再说"处理 |
| P2 交接分级恢复 | 交接读回按码分级（ok / missing / corrupt 族 / version / schema），损坏族丢弃重建、仅"损坏 + 转录也缺失"才 blocked（`dff16ee`，接口文档 §13） | `phase2.test.ts` 交接组 + `production-wiring.test.ts` 续跑组（损坏/版本/形状/双缺失四态） | **无运行时开关**；回滚 = revert `dff16ee`。代价：读失败一律塌成 null，损坏 + 无转录时不再 blocked（可能在无确定依据下继续） |
| P2 其余新守卫 | 工具定义移除守卫、committed_unverified 终态、预算 overlay（见 F3 表） | 各守卫单测（`phase2.test.ts` / `plan-budget-overlay.test.ts`） | 各守卫均为纯函数/确定性判据，无开关；回滚 = revert 对应提交，代价见各守卫行 |
| canary | **本仓无 canary 改动**：`33c1a31..91bf841` 的提交信息与 diff 中 `canary` 命中为 0（仅 `docs/roadmap.md` 与 debt-ledger 里 17dz skills-serve canary 的历史记述）。17dz 仓 PR #3 的 canary 修复不在 fshine 树内 | —（无 fshine 侧验收可写） | **fshine 回滚不覆盖 17dz canary**：revert fshine 纯编排分支不改变 17dz 侧 canary 状态；17dz canary 的回滚须在 17dz 仓另行处理。本节不把 17dz canary 写成 fshine 已修项 |

**F1/F2 基线**：波次起点为 §23 后的 main（D-145 清偿后全量 1795 例 / 132 文件，见 debt-ledger D-145）；波次内 `91bf841` 提交信息实测 unit 104 文件 / 1706 例——与 1795 的差额是统计口径（提交信息只计 unit 文件，不含 e2e）与波次内 e2e 归属调整所致，**本补档不把两个口径拼成一条曲线**。本补档分支的终态 gate 见 PR 描述（`npm run typecheck`、`npm run test` unit 全量、`npm run eval:generic-mock`）。

**F3 变异留档（2026-11-04 补档批次，变异均已还原，工作树复核干净）**：变异方法 = 临时改源码、跑对应单测文件、确认红、立即 `git checkout` 还原，不留变异代码。

| # | 新守卫 | 变异 | 结果 | 留档位置 |
|---|---|---|---|---|
| G1 | 步数帽阈值：50 不触发、51 触发（`worker-step-cap.ts` `stepCapDecision`） | `>` 改 `>=` | `phase2.test.ts` **2 红**（50 默认值 / 51 触发两条）→ 还原复绿 | 本节 + D-147 |
| G2 | 收尾 steer 只送一次（`createStepCapWindDown`） | 删 `sent = true` | `production-wiring.test.ts` **1 红**（50→0 / 51→1 / 52→仍 1）→ 还原复绿 | 本节 + D-147 |
| G3 | 门调用分区计数：每放行恰计一类，分区和 = gateCalls（`recordAllowedBashCall`，`91bf841`） | local 计 1 改 0 | `gate-call-counts.test.ts` **4 红**（全文件）→ 还原复绿 | 本节 |
| G4 | 工具定义移除守卫（`decideToolDefinitionGuard`） | `!tools && !exec` 改 `!tools && exec` | `phase2.test.ts` **2 红** → 还原复绿 | 本节 |
| G5 | 提案机械复核：schema 缺失/非法即不一致（`mechanicalReview`） | schema 检查改 `if (false)` | `production-wiring.test.ts` **1 红** → 还原复绿 | 本节 + D-148/D-149 |
| G6 | 提案 schema 取问：仅认 `proposal.create` 行的非空普通对象（`parseProposalSchema`） | 去掉 `!Array.isArray` | `production-wiring.test.ts` **1 红** → 还原复绿 | 本节 + D-148 |
| G7 | 交接版本校验（`parseHandover`） | 版本不等改 `if (false)` | `phase2.test.ts` **1 红** → 还原复绿 | 本节 |
| G8 | 交接分级恢复：损坏 + 转录在场 → 重建不 blocked（`resolveHandoverRecovery`） | `transcriptAvailable` 改 `if (false)` | `phase2.test.ts` **1 红** → 还原复绿 | 本节 |
| G9 | 预算 weight fail-closed（`plan-runtime.ts`） | weight 合法性检查改 `if (false)` | `plan-budget-overlay.test.ts` **2 红**（缺失 / 非法两条）→ 还原复绿 | 本节 |
| G10 | 网关文本识别随 profile（`gatewayTextPatterns`） | 注入网关名改硬编码旧名 | `gateway-text-recognition.test.ts` **2 红** → 还原复绿 | 本节 |
| G11 | 交接去重：同一调用不重复计数（`mergeExecutedCalls`） | 去重条件改 `if (true)` | `phase2.test.ts` **1 红** → 还原复绿 | 本节 |
| G12 | committed_unverified：`PROPOSAL_VERIFY_SHORT` 即未核实终态（`isCommittedUnverified`） | 该码分支改 `if (false)` | `phase2.test.ts` **1 红** → 还原复绿 | 本节 |
| G13 | 提案复核驱动必注入（`context.ts` 创建路径） | `!proposalReviewTurn` 改 `if (false)` | `production-wiring.test.ts` **1 红**（未注入驱动仍失败那条）→ 还原复绿 | 本节 + D-148 |
| G14 | 预算叠加只收紧不放宽（`plan-runtime.ts` 更严为准） | 更严判断改恒真（恒取宿主档） | `plan-budget-overlay.test.ts` **1 红**（平台 confirm + 宿主 execute 仍 confirm 那条）→ 还原复绿 | 本节 |

**未留档（登记，不冒充已验证）**：① gatedWorker 光标不重跑最后一段（`tests/e2e/harness-cursor.test.ts`）：测试存在，但本补档未对其做单进程变异（e2e harness 接缝，变异成本与 flaky 风险另计），F3 留档缺口登记在 debt-ledger 2026-11-04 补充记录。② profile.gateway 的 spawn 路径 fail-closed（`gateway-profile.test.ts`「未声明 gateway 不回退旧值」）：测试存在，本补档未做变异，同上登记。③ F6 真实模型探针：本波的通用模型评估（`3acfb05` 机械 21/21、`2eaf927` stock 域真模型）是波次内证据，不是 §1 F6 意义上的"改前/改后同参数探针复跑"，不得写成 F6 已过。

**F7 文档同步**：本节 + debt-ledger 2026-11-04 补充记录（D-146–D-149）+ architecture-laws L5 不变量与标定表补行（步数帽、提案复核）同分支提交；`docs-reality.test.ts` 未因本补档改动而新增断言——本补档只补文档，不改代码主张，故不触发双向对账新增项。

## 补充（第三轮评审合入前钉子，超出 §24 声明范围——不是 §24 内）

§24 的声明范围是 `origin/main`（`33c1a31`）→ `91bf841` 的 35 个提交。本补充节的守卫落地在 `91bf841` 之后（`5426a85` decision fail-closed、`29b78f0` driver stepCap 用例、本分支），故**不属于 §24 的 G1–G14 表**，不得把本节写成“§24 已覆盖”。变异方法与 §24 同款：临时改源码、跑对应单测文件、确认红、立即还原，不留变异代码。

| # | 新守卫 | 变异 | 结果 |
|---|---|---|---|
| G15 | decision fail-closed 两道防线（`plan-runtime.ts`：exit 0 预验 + `planDecisionRank`） | ① `planDecisionRank` 改回 `?? 0` | `plan-budget-overlay.test.ts` 直测 1 红 → 还原复绿 |
| G15 | 同上 | ② 删 exit 0 预验（rankOf 仍在） | 公开路径测试凭“exit 0 预验”文案标记 1 红 → 还原复绿（单拆任一道时另一道仍抛错，故两道各凭直测/文案分别钉住，不能凭“公开路径仍抛错”证明单道无用；两道同时拆掉时未知档位会落进 active 返回，见测试文件内的书面说明） |
