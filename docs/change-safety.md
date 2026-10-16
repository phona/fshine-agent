# 改动防线与波次计划

状态：**执行中**。本文是三波改造（写路径保险箱 / runtime 拆分 / 业务 skill 清口径）的**防回归底座**：每一波验收前先过本文的防线，判据是机械的，不是"我会小心"。

架构目标见 [`v0-architecture.md`](v0-architecture.md)，律法见 [`architecture-laws.md`](architecture-laws.md)，债务状态见 [`debt-ledger.md`](debt-ledger.md)。冲突时以 architecture-laws 的闭环判据为准，并回头修 v0-architecture。

---

## 0. 模式铁律：只跑 mock，不碰真实平台

当前唯一可用模式是 mock（D-076：真平台登录页改版，真实模式下查询全是诚实失败）。因此：

**允许**：`npm test`、`npm run typecheck`、`npm run acceptance`、`npm run smoke:commit:mock`、`node --env-file=.env --import tsx scripts/probe-real-agent.ts`（真实 LLM + 真实 `bin/17dz` 计划门 + **mock 执行器**）、L7 打分链 `npm run eval` / `eval:probe` / `eval:acceptance` / `eval:score` / `eval:baseline`（前者两段与探针同法域；`eval:score`/`eval:baseline` 只读报告 + 调评委模型，不触平台）。

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
| F2 | **基线冻结**：`npm test` 全绿 + typecheck 0 错误为红线；用例数**只增不减** | 每 commit 一次；用例数不减才进下一步。**基线是随波次实测刷新的数字，不是常数**（原写死的 987 例 / 78 文件是 2026-09-29 的，C/D 波删了 legacy 落账执行器与其单测、又加了提案/写链路用例，早已漂移）。E 波实测：改造前 1228 例 / 90 文件，E1/E2/E3 后 1267 例 / 92 文件 |
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

**A 波的一个标定选择（影响 B 波；2026-10-14 已被平台侧改动推翻，留档）**：`voucher.proposal` 原声明为 `access: scratch`（理由是它改的是本轮私有草稿，不是平台数据），因此 `confirm` 列为假、宿主 `isWriteAccess` 判它**不是写**。代价是 D-075 那道"计划里出现 write 类 operation 就前置合成写关闭话术"的机械兜底对提案步不触发——所以 **B 波的拦截点必须自己做 capability 复核**（宿主持有的授权，Generic，不依赖 operation 名），不成立时当场合成写关闭话术。这比靠计划扫描猜更准：宿主确切知道"正在创建提案"这一刻。

### A 波已落地（2026-10-12，17dz 侧，未 commit）

平台侧 7 项交付物全部完成，我独立复验：`npm test` ALL PASS（317）+ `lint:operations` 通过；mock 下实跑 `prepare voucher.proposal <file>` → `RESULT {proposalId, summaryText, status:completed}`，`commit voucher.commit --proposal-id <id>` → `{ok:true, verified:true, readBack:{before:1,after:2,delta:1}}`；三个 fixtures 独立复现（账套不存在 → `RESOLVE_INVALID`；辅助缺名 → `needs_input`；已结账期 create 通过、commit → `SAVE_REJECTED` exit 2 且提案保持 pending 可重试）；`operation list --json` 确实带出 `protocol` 列（`voucher.proposal → proposal.create`、`voucher.commit → proposal.commit`，其余 24 个为 null）。

`test-args-spec.js` 的"规格必须逐字等于脚本真实面"锁被改成三条更细的判据（规格 ⊆ 脚本面 ∪ 脚本之上被消费的 flag；非刻意子集仍逐字相等；两张显式偏离表 `ABOVE_SCRIPT_FLAGS` / `DELIBERATE_SUBSETS` 本身也是锁）——这是**细化不是放宽**：`--proposal-id` 由网关层摘掉、域脚本看不到，`voucher.proposal` 刻意不暴露不可达的 `--save`。

**给 B 波的契约提示（A 波实证的限制）**：
1. 协议角色 operation 必须按 **operation 名**寻址（`bin/17dz prepare voucher.proposal <file>`）。按脚本路径寻址（`prepare src/voucher/scripts/fill.js <payload>`）会解析成 `voucher.fill` 并报 `CONTRACT_INVALID`——形态错被说成数据错。平台无法在不嗅探文件内容的前提下区分（本仓禁止内容嗅探），已对 runner / `operation run` / 建造模式寻址加 protocol-keyed 形态守卫。**B 波的拦截判据因此认 operation 名 + protocol 列，不认脚本路径。**
2. `--batch` 的语义是"payload **文件**是提案数组"，一次创建多个提案（返回 `proposals[]`）。
3. **未做 period ↔ contracts 日期的一致性校验**（A 波范围外）："声明录 7 月、契约日期在 8 月"的 payload 会真的落账，然后读回按 payload.period 计数得增量 0 → `PROPOSAL_VERIFY_SHORT` + 提案转终态（防二次落账）。响亮失败而非静默错，但更便宜是在 create 挡掉。**列为 B 波切流的前置项**（或至少在开真平台写之前关掉）。
4. `docs/proposal.schema.json`（V1 文档冻结副本）保留未删——skills-serve README 不变量 3 与 `test-agent-pipeline` 消费它。运行时唯一权威是 `src/voucher/proposal.schema.json`，两者一致性有机械锁（漂移即红）；副本随 B/C 波宿主不再解析 payload 而退役。

**纪律事件（必须记住）**：A 波子任务排练验收时用 `env $ENV ./bin/17dz …` 传环境变量，**zsh 不做无引号变量的词分割**，导致一条命令没带上 `DZ_EXECUTOR=mock`，真 `fill.js` 以 build 模式起来了一次（`invocations.jsonl` 留痕：`2026-10-12T01:54:59`，`serve:false`，无 mock 标志，exitCode 1，931ms）。现场取证：无残留进程；`.browser-profile`（Sep 29）、`.runtime/auth.json`（Oct 10）、`.runtime/screens/`（Sep 29）**均未被写过**；当天唯一一条非 mock 且未被拒的调用就是它，且以 exit 1 结束——没有任何平台状态变动。教训与纪律：**本机 shell 是 zsh，批量传 env 必须字面写进命令行**；"我们以为它无害地失败了"永远不能作为依赖。

### B 波（fshine，带开关与影子双跑）

**开关**：`FSHINE_PROPOSAL_VIA_GATEWAY` 默认**关** = 走今天的主本文本路径；开 = 走网关提案路径。影子期两条路都在：开开关时，旧文本路径仍然跑一遍但**只记录不一致**（`proposal_shadow_mismatch` 事件），不生效。

**判别只有一个**：意图记录带不带 `proposalId`。带 → 新路径（平台 create/commit）；不带 → 旧路径（`commit.ts`）。确认状态机只有一套（`matchConfirmation` 原样），两条执行后端按记录形状分流——C 波删旧路径时这个分支自然塌掉。

| # | 交付物 | 要点 |
|---|---|---|
| B1 | `packages/agent/src/proposal-runtime.ts`（新，≈150 行，镜像 plan-runtime） | `parseProposalCommand(command)`：网关首词 + `prepare` 模式 + operation 引用，**按 `protocol` 列判是不是提案创建**（A 波实证：按脚本路径寻址会解析成 `voucher.fill` 并报数据错，所以判据认 operation 名 + protocol 列，不认脚本路径）。`operation-labels.ts` 加 `protocol` 列的解析与加载（拿不到表 → 空 → 不拦截，与 label/args 规格同一失败语义）。纯函数 + 单测，不起 harness |
| B2 | `ChangeIntentRecord` 瘦身 + store 迁移 | 契约形状改为 `{intentId, principalId, sessionId, taskId?, proposalId, status, expiresAt, createdAt, decidedAt?, result?}`——**零业务字段、零 payload**。`change_intents` 加 `proposal_id` 列；旧行业（有 kind/account_set 的无 proposalId）**一律按过期处理**（W5：单测钉"旧行读回 → `confirm_stale`，不 commit"） |
| B3 | 拦截与提案流 | `pi-coding-driver.ts` `beforeToolCall` 在 plan 解析之后、gate 之前加一支：① **capability 复核**（宿主持有的授权，Generic——A 波当时的标定：`voucher.proposal` 是 `access: scratch`，D-075 的计划扫描兜底对提案步不触发，所以这一刀必须宿主自己下（**2026-10-14 更正**：17dz `a683df2`（D-090）已把 `voucher.proposal` 改成 `access: write`，`confirm` 列为真 ⇒ 计划里出现它时 `planWriteClosed` **会**触发——只读部署下提案步现在先被计划扫描兜住。这是更严的方向，且宿主 B3 的 capability 复核仍在，两层并存不冲突；验收 5.x 要跑写链路必须把主体 `capabilities` 开到含 `write`））；不成立 → 当场合成写关闭话术，`writeClosed` 语义与 D-075 一致。② 成立 → 宿主办调 `bin/17dz prepare voucher.proposal <file>`（serve 法域、剥 `DZ_REQUIRE_PLAN`，修 D-081），解析 RESULT 信封：completed → 落 B2 的记录 + 生成确认码，用户可见文本 = **平台 `summaryText` 原样 + 通用确认行**（宿主的借贷合计渲染在新路径上一行不写）；`needs_input` → 按确定性线索交还 worker；failed → 交还错误码 |
| B4 | 新 commit 后端 + 三笔债 | `apps/server/proposal-commit.ts`（新，薄）：`bin/17dz commit voucher.commit --proposal-id <id>`，令牌 = HMAC over `{proposalId, expiresAt}`（不绑脚本名/业务字段）。`matchConfirmation` 按 `proposalId` 分流到新后端。**D-080**：confirm 分支按**确认时点**复核 capability（提案到确认之间能力被收回正是该缺口形状）；**D-081**：宿主直调显式剥 `DZ_REQUIRE_PLAN`；**D-082**：committed 与 confirm_failed 两个分支都 upsert originating `platform_tasks` 的 outcome |
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

**B3 capability 复核**（`context.ts` 的 `createProposalViaGateway`）：`ctx.trusted.capabilities` 不含 `write` → 当场合成 `WRITE_NOT_ENABLED`（error-codes.ts 唯一来源）并返回 `write_closed`，**零平台调用**（A 波当时的标定：`access: scratch` ⇒ 计划扫描兜底不触发（**2026-10-14 已变**：`a683df2` 改成 `write`，只读部署下计划扫描会先兜住提案步），这一刀仍由宿主自己下）。同处保留旧路径的授权名单限制模式判据（host-held scope，payload 不透明不等于可以把允许名单受限主体的写面放大）。含 write → spawn `bin/17dz prepare <operation> <payloadPath>`（cwd = platformRoot，**env 显式剥 `DZ_REQUIRE_PLAN`**，修 D-081；operation 名来自拦截时取到的目标 token，宿主不另持业务名单），`parseEnvelope` 分流：completed → 落新形状 `ChangeIntentRecord`（`proposalId` + `taskId` + 通用字段，零业务字段）+ 现有 `CODE_ALPHABET`/`hashCode` 机制原样 → 用户可见文本 = **平台 `summaryText` 原样**（控制字符/空白卫生 + 500 截断，与 correctFormOf 同族）+ 通用确认行（`confirmLineFor`，两条路同一把尺）；needs_input → 结构化线索；failed → 平台错误码。新 pending 记录经现有 `changeIntents` 仓库落库（改动小的那个选项），旧 pending 照样置 superseded。

**W1/W2 开关与影子**：`FSHINE_PROPOSAL_VIA_GATEWAY` 默认关（`platform-mock.ts` 的 `proposalViaGateway()`，与 `isCommitEnabled` 同一处读 env；leak-lint 的 FSHINE_* 登记表已登记，C 波删旧路径时随开关退役）。关 = 宿主不注入回调 + 驱动不拦截。开 = 拦截生效，**并且** legacy `finalizeProposal` 的 `ci.create` + "把旧 pending 置 superseded" 一并关掉（B 波第 1 批实证的第三点：否则旧路径会把新路径刚建的 pending 记录 superseded 掉，用户手里的码随之失效）；此时 worker 终稿里仍带旧形态提案 JSON 的，只落 `proposal_shadow_mismatch` 事件，不生效、不解析、不落库。开关状态每回合留痕（`delegation_gateway_state` 日志一行 + 拦截处的 tool_calls 一行）。**与 W2 字面（"每回合进审计"）的一处偏差**：开关关着时本回合没有任何门事件可挂（没有门事件就没有 tool_calls 行），故"每回合"那一份由结构化日志承载（与 delegation_span/turn_span 同一族）；要把关着的状态也写进 tool_calls，得给 TrustedContext 加审计出口——那是契约面改动，超出本批范围，记为 B 波合成 commit 前的待决项。

**判据扩到 `operation run`**（B 波第 1 批遗留限制 2 的裁决：扩）：`parseProposalCommand` 现在认 `prepare <operation>` 与 `operation run <operation>` 两种寻址形态（平台对两条路都有 protocol-keyed 守卫，少认一条就多一个"平台有提案、宿主无条目"的缺口）。目标 token 仍由 `extractGateScript` 这唯一解读者取，payload 起始下标按形态算。

**runtime 侧接线**：`proposalCreated: {proposalId}` 从 driver → context → runtime 透传，runtime 用它把宿主持有的文本作为本轮回复（与 `writeClosed` 同族：`delegationFailed` 让出口校验放行——提案这一步可能零网关执行，而"提案已登记、等用户确认"是真实状态，被零执行门换成 `NO_EXECUTION_CLARIFICATION` 会让确认码永远到不了用户）。计划模式的零执行熔断同样豁免它（`noteZeroExecStep` 的 `proposalCreated`，与 `writeClosed` 同理由）。`matchConfirmation` 对带 `proposalId` 的条目加一道 fail-closed（B4 落地前的占位）：不落账，也不借"已过期"说谎——提案保持 pending，B4 接上后同一个码仍然有效。`runtime.ts` 行数预算 1203 → 1221（功能新增，已在守卫注释里记账）。

**用户可见文本的最终拼法**（e2e 实跑样例，第一行平台 `summaryText` 原样、第二行宿主通用确认行，中间一个换行；宿主不拼对象/时间/条目/借贷合计任何一行）：

```
待确认提案 prop_bf759dbf-1269-4b13-b3b9-ec5b5cdbf444：账套「幻辰财税」2026年09月，共 2 张凭证，借方合计 1,234.00，贷方合计 1,234.00。确认后由系统执行录入；有效期至 2026-10-12T05:18:44.479Z。
回复「确认 SKGVA4」完成确认流程（当前落账执行未启用——确认不会写入任何数据）；回复「取消 SKGVA4」作废。10 分钟内有效。
```

**已知缺口（留给 B4/B5）**：① `--batch`（一次创建多个提案）不转发——带了就在平台 schema 处响亮失败，不会静默建错；② 新路径的确认行在 `proposalCommitEnabled`（新选项，默认 false）为真时才承诺落账，B4 接线后由部署层置真；③ 计划模式里提案一步的步骤结局按机械事实记 'failed'（零执行），不影响用户看到的文本；④ 开关新名字未进 `.env.example`（本批只准改 §4 记录，`.env.example` 文档随 B 波合成 commit 补）；⑤ 影子期开关开着而 worker 仍贴旧形态提案 JSON 时，按 W1 只记录事件、不生效不落库——那一轮的用户回复因此是 worker 原文（含 JSON），文本卫生比旧路径差；这是"只记录"的字面语义，切流（W1 零差异）后随旧形态一起消失。

**验收（本批，全 mock）**：`npx vitest run packages/agent/proposal-runtime.test.ts` 17 绿（含 `operation run` 四条新形状）；`packages/agent/proposal-flow.test.ts`（新，16 绿，不起 driver harness：宿主半用捕获回调的替身 worker 驱动，驱动半用真 `createPiCodingWorkerSession` + 直接调 `beforeToolCall`）覆盖 capability 不含 write → 写关闭话术且零办调 / 含 write → 办调 + 信封三态 / payload 越界（scratchDir 外、绝对路径、`../`）→ 拒绝且零办调 / env 剥 `DZ_REQUIRE_PLAN`（断言替身收到的 env）/ 开关关 → 不注入回调 / needs_input 线索 / 审计一行；`tests/e2e/turn-loop-write-chain.test.ts` 12 绿（新增 4 条：开关打开下 create → 用户文本含平台 summaryText 与确认码 + 条目只持取物单、确认步 fail-closed 零写入、能力不含 write 时平台零办调、影子不一致只记录不落库）；`npm test` 89 文件 1220 用例全绿（B1+B2 后 1198，净 +22）；`npm run typecheck` 0 错误；泄漏预算（新 env 名已登记、无新增未归属业务词）与架构形状（无 import 环）通过。**全 mock**：不碰真平台、不起探针。

### B 波第 3 批已落地（2026-10-12，fshine 侧，未 commit）：B4 + B5

**B4 薄 commit 后端**（`apps/server/proposal-commit.ts`，新）：`bin/17dz commit <operation> --proposal-id <提案号>`，cwd = platformRoot，serve 法域（`hostGatewayEnv` 显式声明 `DZ_SERVE=1` 并剥 `DZ_REQUIRE_PLAN`——修 D-081；该函数从 context.ts 导出，创建与落账两处宿主办调共认一把尺）。**operation 名不硬编码**：按 `protocol` 列从 `operation list --json` 解析出角色为 `proposal.commit` 的那个 operation（`PROPOSAL_COMMIT_PROTOCOL` 与 B1 的 `PROPOSAL_CREATE_PROTOCOL` 同住 proposal-runtime.ts）；表拿不到 → **fail-closed 拒绝 commit**，不回落硬编码网关名。令牌 = HMAC-SHA256 over `{proposalId, expiresAt}`（不绑脚本名/业务字段——L4：宿主不该知道自己在提交什么业务），密钥用 assembly 已在生成的那把 `newGateSecret()`，只经 env 传给该子进程。落账前先向平台取问一次提案状态（平台 designated 的"宿主持有 proposalId 后的唯一取问"）：令牌必须绑提案自己的有效期，而那个值只存在于平台侧；同一问把"已过期 / 已终结 / 读不到"在办调之前现形。解析 `RESULT` 信封 `{ok, verified, summaryText}` → `ProposalCommitResult`；读回计数（before/after/delta/required）搬进审计留痕。与 `commit.ts` 的 legacy runner 并存，由记录形状分流。

**`matchConfirmation` 分流**（`context.ts`，判别只有一个：`rec.proposalId` 在不在）：在 → 新后端；不在 → legacy 分支一字不动。新分支做三件事——① **D-080**：confirm 时按**确认时点**复核 `capabilities.includes('write')`（"提案后收回写权限"正是这个缺口的形状），不通过 → 确定性拒绝（error-codes.ts 唯一来源的 WRITE_NOT_ENABLED）+ 意图保持 pending + 零办调；② **D-082**：committed 与 confirm_failed 两个分支都 upsert originating `platform_tasks` 的 outcome（记录里已有 taskId），`invariant-checker` L1 的 `expectedOpenTasks` 例外随之撤掉、转成硬断言；③ `proposalCommitEnabled` 为假 → `confirm_held`（与 legacy 的 `commitEnabled` 同语义）。提案在平台侧已不可用（expired / not_pending / unreadable）单独一支：`confirm_stale` + 意图归档，不谎称执行失败。

**接线开关**：`FSHINE_PROPOSAL_COMMIT`（platform-mock.ts 的 `proposalCommitWired()`，默认关）= 落账后端是否接上；与 `isCommitEnabled()` 串成 `proposalCommitEnabled = 接线 ∧ 放行`（mock ⇒ 真；真平台 ⇒ 还需 `FSHINE_REAL_COMMIT=1`）。与任务书"assembly 按 isCommitEnabled() 派生"的一处偏差：多串了一个接线开关——理由是落账要与创建一样能分段部署（先切创建、后切落账），且 confirm_held 这一态在 mock 下必须可达可测（否则它只在真平台无 REAL_COMMIT 时出现，而真平台不许碰）。后端本体只在接线时注入。`.env.example` 补登两个开关（`FSHINE_PROPOSAL_VIA_GATEWAY`、`FSHINE_PROPOSAL_COMMIT`）。

**用户可见成功文本**（e2e 实跑样例：第一行平台 `summaryText` 原样、第二行宿主通用状态行；宿主不拼任何业务摘要）：

```
提案 prop_a8f1606d-3028-4123-801e-7ab56eda22b6 已执行：账套「幻辰财税」2026年09月 录入 2 张凭证（借方合计 1,234.00，贷方合计 1,234.00）；读回校验通过（凭证数增加 2）。
确认码已核销，落账已完成。
```

**B5 测试**：`apps/server/proposal-commit.test.ts`（新，12 绿：角色列寻址 / 空表拒绝落账且零办调 / 令牌只绑两字段且密钥只进子进程 env / 剥 DZ_REQUIRE_PLAN + serve 法域 / 取问三态 / 信封成败解析）；`proposal-flow.test.ts` 24 绿（+8：确认时点收回 write / 开关关 / 后端未注入 / 成败 / 不可用两态 / legacy 分流）；`turn-loop-write-chain.test.ts` 16 绿（+4：完整链 create→确认→commit→读回→任务终态 done、D-081 进程带 mandate 全链仍绿、已结账期 confirm_failed + 任务终态 failed + 零增量、D-080 端到端）；`turn-loop-security.test.ts` D3 入口③ 翻转为写关闭话术（16 绿）；`turn-loop-long-session-invariants.test.ts` S1/S2 改写网关路径全链并撤 `expectedOpenTasks`（4 绿）；`npm test` 90 文件 **1244** 用例全绿（B3 后 1220，净 +24）；`npm run typecheck` 0 错误；`npm run smoke:commit:mock` 绿；`grep -rn "voucher\.\|借贷\|accountSet" apps/server/proposal-commit.ts` 空输出。

**W4 三态翻转的变异验证**（本地改错 → 对应断言红 → 已还原）：① D-080——把确认时点的 capability 复核注掉，security D3 ③ / write-chain D-080 / proposal-flow 三条同时红（回复变成平台落账摘要，即"收回写权限仍然写成功"）；② D-081——把 `hostGatewayEnv` 的剥离子注掉，proposal-commit 的 env 纪律断言红（`expected '1' to be undefined`）；平台审计另给出为什么要剥的实证：serve 法域 + `DZ_REQUIRE_PLAN=1` 下宿主直调的只读读回被计划门拒（`query verify-saved … serve:true refused PLAN_REQUIRED`），legacy runner 继承进程 env 不剥，读回计数即取不到；③ D-082——把创建时终态与两个分支的回写一并注掉（= B4 前的形状），long-session S1 在 checker 的 L1 上红（`任务 task_… 无终态（platform_tasks.outcome 为空）——悬挂`）；只注回写则 proposal-flow 与已结账期 e2e 红。

**纪律事件（必须记住）**：为取 D-081 的"现在红"证据写了一个临时 vitest 直驱 legacy commit runner，**忘了设 `DZ_EXECUTOR=mock`**——vitest 不加载 `.env`（e2e harness 的 beforeAll 显式设它，我绕过了 harness），于是真 `fill.js` 以 serve 模式起来了 **3 次**（平台审计：`06:15:11Z / 06:16:22Z / 06:19:03Z`，`mode:commit, script:src/voucher/scripts/fill.js, serve:true`，无 mock 标志，各 ~47-49s 后 exit 1）。取证：三次都停在登录态/定位器阶段（`discoverToken attempt 1 failed: locator.waitFor Timeout`），**没有任何落账**（exit 1 即失败，未到保存步）；`.runtime/screens/`（Sep 29）、`.browser-profile/`（Sep 18）未被写；`.runtime/auth.json` 在 06:14:37Z 被重写一次（真跑的鉴权刷新）。教训：**任何不起 harness 的平台调用都必须自己显式带 `DZ_EXECUTOR=mock`**，临时测试文件用完即删（已删）；"它失败得看起来无害"永远不能作为依赖。D-081 的翻转证据最终由 unit 级 env 纪律断言（变异即红）+ 平台审计里那条 PLAN_REQUIRED 记录承担，不再需要直驱真平台。

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

#### C 波已落地（2026-10-13，fshine commit `95bdede`）

**删掉的（按文件）**：`apps/server/commit.ts`（legacy 落账执行器：宿主解提案、物化契约、按文件路径 dry-run/commit/读回）与其单测；`context.ts` 的 `ChangeProposal` / `LegacyChangeIntentRecord` / `extractChangeProposal` / `finalizeProposal` / `ProposalOutcome` / `truncate` / legacy 确认分支 / 派发点 / 影子留痕分支，以及选项 `prepareRunner` / `commitRunner` / `maxBatchCount` / `commitEnabled` 与随之死掉的 `PrepareRequest` / `CommitRequest` 四个注入点接口；`platform-contract.ts` 的四个 voucher 操作名与 `parsePrepareOutcome` / `parseVerifyCount` / `PrepareOutcome`（唯一消费者是 commit.ts）+ `index.ts` 对应导出；leak-lint 三条"遗留待清"登记。

**保留下来的（新路径在用）**：`options.changeIntents` / `intentTtlMs` / `proposalGatewayRunner` / `proposalCommitEnabled` / `proposalCommitRunner`、`COMMIT_FAILED_LINE`、`writeBackTaskOutcome`、`confirmLineFor`、`summaryTextOf`、`proposalNeedsOf`、`createProposalViaGateway`、`confirmProposalViaGateway`、`hostGatewayEnv`、`defaultProposalGatewayRunner`。

**四个坑的处理**：

- **R1（取消码标签）**：`legacyIntentLabel` 的唯一调用点在取消分支，那是新旧路径**共用**的代码。删掉它就要同时改这条共享文案，而现有测试只有 legacy 用例断言过它。选择**保留该函数**（改名 `intentLabel`，因为 C 波后它就是唯一路径的那一个）：业务字段不在宿主库往返，一律降级成中性「本次录入提案」，不把 undefined 渲染给用户、也不为"更具体"去解析 worker 文本。配套补了两条网关路径的取消覆盖（`turn-loop-write-chain` 攻击面组的「取消 pending」「取消已作废码」）。
- **R2（`newGateSecret` 搬家）**：它原住要删的 `commit.ts`，却被 `assembly.ts` 与 `ask.ts` 用。搬到 `packages/agent/src/context.ts` 并与 `hostGatewayEnv` 同住（两者都是"宿主持有的直调法域"这一族事实），经 `index.ts` 导出；`proposal-commit.ts` 的注释着落同步更新。搬家早于删文件，生产启动编译不错。
- **R3（过期话术两份）**：898 行那份逐字抄写只删 legacy 分支内那一份，`PROPOSAL_UNAVAILABLE_TEXT.expired`（新路径 `unavailable:'expired'` 分支的唯一来源）保留。
- **R4（冒烟脚本）**：选**改写指向新路径**（选项 ①），不保留 legacy runner 只为冒烟。理由：保留它等于把 L4 违例的整条文本写路径留在编排层，leak-lint 的 `commit.ts: 账套/凭证` 两条登记也随之关不掉。新脚本三步 = 平台提案创建（protocol 角色列寻址 + `hostGatewayEnv` + 只认 RESULT 信封，与 `createProposalViaGateway` 同一把尺）→ `createProposalCommitRunner` 落账 + 平台读回 → mock 状态凭证数断言；**mock 保险丝原样保留**（检测不到 `DZ_EXECUTOR=mock` 直接拒跑）。W3 的门没有退场。

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
| X3 | mock 保险丝不碰 | `smoke:commit:mock` 的 `DZ_EXECUTOR=mock` 拒跑分支未动，`DZ_EXECUTOR=mock npm run smoke:commit:mock` PASS |
| X4 | 默认部署行为有钉子 | `turn-loop-write-chain.test.ts` 全部用例**不再设任何 env**，"不设开关也走网关路径"由每条用例直接钉住 |

**行为差异（默认部署 `.env`：`DZ_EXECUTOR=mock`、无两个开关、`capabilities:["read"]`）**：提案命令由"不拦（开关默认关）"变为**恒定拦下**；确认码由"只有开了 `FSHINE_PROPOSAL_COMMIT` 才落账"变为**恒定落账**（mock 下 `isCommitEnabled` 恒真）；真平台无 `FSHINE_REAL_COMMIT` 仍是确定性拒绝 + 零写入（唯一闸门未动）；真平台有 `FSHINE_REAL_COMMIT=1` 行为不变。**覆盖面的实质变化**：confirm_held（确认收到但不写）从此是**真平台专属态**，mock 下不可达——原先靠"关掉落账开关"在 mock 里造出这一态的 e2e 用例改写为"mock 之下落账恒放行"，fail-closed 的判据改由 `proposal-flow.test.ts` 的 `proposalCommitEnabled=false` 一支 + X1 的语义组共同钉住。

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
| E8 | 只跑 mock | 全程 `DZ_EXECUTOR=mock` 字面；`FSHINE_REAL_COMMIT` 空、`DZ_ALLOW_REAL` 缺席；D-091 的"非 mock 不误报"改由类级单测承担，**没有**跑任何非 mock 的 `bin/17dz` |

**十项变异验证（本地改错 → 对应断言红 → 已还原）**：
E1 四项——删 block 分支记账 / 删 catch 分支记账 / 身份判据换 `isError` / 身份判据换 `toolName`。
E2 六项——覆盖判据改回 `slice(-20)` / 保尾改保头 / haystack 删 `platformEntities` / 删账本 `record` / 删转录通道只留账本（7 条红）/ 保尾常数调大 10 倍。
E3 一项——删 SQL 的 `tool_name` 过滤。
E4 三项——17dz 侧把 `access` 改回 `read` → `test-gate.js` 2 条 + `test-real-execution-gate.js` 1 条全红，且 mock 下 `prepare` 复现 `OPERATION_NOT_MOCKED` exit 3。

### E 波的两个判断点（判据被改写的理由，留档）

1. **D-085 的闭环判据字面实现不了**。原字面是「haystack 覆盖从"最后 N 条"改为**本任务迄今全部 toolResult 的结构化实体集合**」。现场证伪：信封 `data` 的每个字符串叶都是它所在响应原文的子串（`RESULT` 在 stdout 末行、SDK bash 工具保尾弃头），所以"只收结构化叶值"是**可证的收窄**——会打破 golden `turn-contract.test.ts:235`（该用例用的就是非信封原文），并新拒「幻电设备」vs 平台返回「幻电设备有限公司」这类缩写/简称形状，方向与修假拒相反。**改为**：覆盖 = 本任务迄今全部 toolResult 原文（双通道）+ 信封 `data` 的结构化叶值作为**附加**第二来源（additive，只增覆盖），包含判据仍是逐字包含。理由与判据改写都记在台账 D-085 主条目里。
2. **D-091 的「非 mock 无 `DZ_ALLOW_REAL` 也 exit 0」不真跑**。§0 禁止任何不带 `DZ_EXECUTOR=mock` 的 `bin/17dz` 调用，所以该条由 `test-real-execution-gate.js` 的类级断言（从清单读 `voucher.validate` 的声明 → `touchesPlatformOf === false`）承担。另两条（mock 下 exit 0 有输出、`DZ_REQUIRE_PLAN=1` 不索要 `DZ_PLAN_ID`）实跑通过。

### E 波新发现的一条根因（台账原先没有）

SDK 默认开**自动压缩**（`DEFAULT_COMPACTION_SETTINGS`，阈值 = contextWindow − reserveTokens；本部署 128K ⇒ ≈111 616 token）。一到阈值 `agent.state.messages` 被换成 `[压缩摘要] + [保留尾段]`（`keepRecentTokens` ≈ 80KB），早期 tool_result 整条消失。**D-085 自己的证据（单请求 87 次 tool_call）正是会触发压缩的长任务形状**，所以"本任务迄今全部"靠读转录到不了——覆盖判据因此物化成两个通道：转录通道 + 宿主在 `afterToolCall` 上的账本通道（压缩免疫，且 SDK 不给被拦下的调用调它，结构上不含宿主拒绝文本）。

### 首轮真模型基线（D-088 的第一步，2026-10-14）

`npm run acceptance --only=5.1,5.1b,5.2,5.3,5.4`，`DZ_EXECUTOR=mock`，报告 `data/acceptance-report-202610140425.md`。

**仪器本身达标**：报告首次带出「计划门裁决 / 计划门拒绝明细」两节——5.1 的 6 次裁决、5.3 的 4 次全部列明理由与 calls 摘要。换在 E3 之前，这两节的位置只有 worker 终稿那一句。这一条同时是 D-087 的闭环证据。

**首轮未达成 D-088 的字面判据**（无 `prop_*`、5.2 被跳过），原因有三层，按报告可直接归因：

1. **部署姿态**：本地 `config/agent.yaml` 的主体 `capabilities: ["read"]`，写未开放。5.1 的计划里出现 `voucher.proposal` 时被 D-075 的计划扫描兜住（`PLAN STOP 当前未开放写入权限`，detail 逐字列出该调用）→ worker 拿不到提案步 → 回复不含确认码 → 5.2/5.4 按既有逻辑跳过。**这不是本轮引入的缺陷**，但它是 D-090 的一个后果：17dz `a683df2` 把 `voucher.proposal` 从 `scratch` 改成 `write` 之后，计划扫描兜底**首次对提案步生效**（B 波记录的"对提案步不触发"已因此过时，本文上方已更正）。要跑 D-088 的字面判据，必须把该主体 `capabilities` 开到含 `write`。
2. **模型侧形状问题（两例，均可在报告节里直接读出）**：① worker 发了 `operation list` / `operation.list` 这个**不存在的 operation**，平台回 `PLAN_REFUSE UNKNOWN_OPERATION`，两次都以 `PLAN PAUSED` 收场；② 计划 JSON 形状不合法（`PLAN_JSON_PARSE: No number after minus sign in JSON at position 1`），5.3 里出现两次。
3. **D-085/D-086 的修复没有可观测的负面效应**：本轮的 10 次 declined 里没有一次是 `ENTITY_OUT_OF_SCOPE`——三类静默拒绝里最相关的那一族本轮零命中，与"窗口已删、假拒来源已除"的方向一致（样本仅一轮，不作为结论）。

**登记口径**：按 architecture-laws 的关账纪律，D-088 **不标已关**（字面判据是连续三轮，且本轮写链路未开放）。第 1 层是部署姿态选择，第 2 层是新观察到的模型侧失效，两条都记进台账待后续处置。

### D-088 复跑的第二/第三轮，与暴露的新缺陷 D-096（2026-10-14）

E 波代码落地后为跑 D-088 做了两轮补充复跑（都只跑 mock；`config/agent.yaml` 的本地主体临时开到 `capabilities: ["read","write"]`，`.env` 的 `DZ_EXECUTOR=mock` 与空的 `FSHINE_REAL_COMMIT` 两道闸未动）：

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

17dz `6b7ea09`（prepare SKILL 第 3 步显式声明前提）之后复跑三轮，mock 执行器 + 写开放（本地 `config/agent.yaml` 主体临时 `["read","write"]`；`.env` 的 `DZ_EXECUTOR=mock` 与空的 `FSHINE_REAL_COMMIT` 两道闸未动；命令行不传任何 `DZ_EXECUTOR`）：

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
