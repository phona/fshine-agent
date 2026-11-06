# 落地路线

架构目标见 [`v0-architecture.md`](v0-architecture.md)，差距清单在它 §10。本文只回答一件事：**按什么顺序改、每步怎么验、什么时候能停。**

## 总原则

- **每个 Phase 独立可交付、可随时停。** 任何一步做完，系统都是可运行、可测试、可回滚的状态。
- **先删后建。** 能靠代码保证的先从提示词里删掉，再加新能力——否则新能力会建在漂移的基线上。
- **验证成本前置。** Phase 0 先把测试和探针提速，后面每一步都受益。
- **红线**：任何 Phase 结束后，`npm test` 全绿 + typecheck 0 错误。涉及申报/指代的 Phase 额外跑真实模型探针。

---

## 阶段总览

```text
Phase 0 测试并行化        （不动架构，纯提速）
   └─> Phase 1 提示词去冗余   （只删，不改行为）
        └─> Phase 2 主动回溯   （宿主申报前注入证据）
             └─> Phase 3 领域判别下沉（解耦的关键一步）
                  └─> Phase 4 申报契约瘦身（8 字段 → 3 字段）
                       ├─> Phase 5 Subagent 报错回路
                       └─> Phase 6 长任务拆解 + 业务 skill + 任务计划状态
                            └─> Phase 7 执行层记忆（可选）
```

预估：Phase 0–4 约 7 天，Phase 5–6 约 5 天，Phase 7 约 2 天。

---

## Phase 0 — 测试并行化

**状态：已完成**（commit `4643c7b`）。共享替身抽到 `tests/e2e/harness.ts`，13 个用例原样拆进 `turn-loop-routing / -execution / -plan-gate / -confirmation` 四个文件并行执行；探针加 `--quick`（只跑 A1/A2/A4/A5 + B1）。36 文件 / 287 用例全绿，typecheck 0 错误。

**目标（实测口径）**：`npm test` 6.8s → ~5.2s；探针日常迭代从 25 分钟降到约 3 分钟。

**原定 ≤3s 未达成，是结构性下限而非拆分不到位**（已实测否决 5 文件拆分、E2E-first 调度、`--silent`/forks 池/12 workers/编译缓存，均无实质收益）：

- 每次运行固定开销 ~1.4s：vitest 启动 + 每个 worker 导入真实 assembly（express 导入 464ms，冷启 1.57s）
- 最慢单用例「2.7 高重量等确认」1.85s：1 次 boot + 24 次真实 CLI spawn（每次 50ms）

两者相加已 ~3.2s。压到 3s 内只能动 Phase 0 禁止的两件事（削减用例真实执行数 / 生产代码懒加载），经确认**不做**——Phase 0 保持行为零变化。后续若要做，单列性能任务。

**验收（按实际达成记录）**：三次计时 ~5.2s；用例数 287 不减少；typecheck 0 错误；`describe`/`it` 名带手工用例编号；`docs/manual-test-wecom.md` §8.2 映射表已同步四个文件名。

---

## Phase 1 — 提示词去冗余

**状态：已完成**（见 `docs/rule-landing.md`）。产出物即该清单：代码断言 C1–C17、SKILL 事实 S1–S8、两个提示词的逐条落点表，作为唯一事实源索引随代码走。

**结果**：`SYSTEM_PROMPT` 18 条/1491 字符 → 11 条/908；`workerSystemPrompt` 16 条/1545 字符 → 10 条/885；合计 3036→1793（**−40.9%**）。删掉的条目全部有代码断言或 SKILL 落点；剩余场景枚举合成一条原则（只执行宿主批准的计划内的调用；能力不足/不确定/被拒时如实说明并停止，不换口径试探，不代替用户做选择——全项目唯一一份在 workerSystemPrompt，Main Agent 侧对应"口径不可履行选 clarify"）。指代规则（SYSTEM_PROMPT 173 字符）按计划留给 Phase 2。

**验收（按实际达成记录）**：
- 合计字符数 −40.9%（要求 ≥40%）✓
- 清单每条规则有代码/SKILL 落点；提示词无清单外新规则 ✓
- `npm test` 287 全绿、typecheck 0 错误 ✓
- 探针 `--quick` 与改前基线对比无回归 ✓（A2/A4/A5 调用数与基线一致；A1 改后首跑复现一次 `executor_error` 环境抖动，`--only A1` 重跑 2 次调用两轮均真实查询；B1 的 ⚠ 与基线同性质——5 轮数据全为 0，是探针把回复措辞里的数字也抽来比对导致的误报）

两个原提示词文本断言用例（`context.test.ts`）已改为断言代码落点（C6/C7/C8），其中 account_search 计划限制此前只有提示词层覆盖、无代码层测试，本次补上。

### 已确认可删的（代码里有对应保证）

| 提示词条目 | 代码保证 |
|---|---|
| 只问账套存在性 → 只能调 `search-account-sets` | `validatePlanAgainstTurnDeclaration` account_search 分支 |
| 余额任务不能夹带凭证查询 | balance 分支 |
| 不能查申报范围外的账套 / 期间 | `inScope` + periods 检查 |
| 计划必须只读 | 平台 `PLAN_OPERATION_NOT_READ_ONLY` |
| 实际调用必须匹配激活计划 | 平台 `PLAN_CALL_MISMATCH` |
| 超重 → 通知/确认/停止/试探上限 | 平台 `decision()` + 两个计数器 |
| 写操作必须服务端确认后执行 | commit token + serve-policy |
| worker bash 只能 `bin/17dz`、禁元字符、无计划拒绝 | `serve-gate.ts` |
| 不读 `.runtime/` / `.env` / auth | serve-gate `sensitivePaths` |
| 申报必须带证据 / 自相矛盾退回 / 零执行不外发 | 三个确定性校验 |

---

## Phase 2 — 主动回溯

**状态：已完成**。指代解析不可靠的机械根因已找到并修复：默认 `state_recent` 模式下，`selectRecentTurns` 的"完整轮次"判定只认带文本的最终 assistant 消息，而 platform_query/clarify 轮次是被 toolResult 确定性终结的——**整个查询轮次被踢出最近轮次窗口**，模型看不到上一轮查过什么，`previousTurnText` 扫的也是同一个被截断的窗口，referenced 申报必然被拒（历史成功率 3/5、5/5、0/5 的波动也由此解释：上一轮是闲聊轮就灵，是查询轮就废；`route_reference_hint` 扫的是同一个窗口，所以同样不稳）。

**改动**：
- `selectRecentTurns`：完整轮次判定增加"或被 toolResult 终结"——查询轮次重新可见（`runtime.ts`，回归测试在 `runtime.test.ts`）
- 新增 `reference-evidence.ts`：申报前宿主检测指代线索，从 Conversation Log 注入证据（≤5 条 tool_result + ≤3 条关键词命中，带 eventId，超限截断并记日志）；铁律：证据只支撑指代消解、不扩大实体范围，本轮范围仍由 C1/C2 逐字校验
- **删除**：`route_reference_hint` 整套、`looksLikeReference`、`SYSTEM_PROMPT` 里 173 字符的指代规则（10 条/734 字符）

**验收（按实际达成记录）**：
- 单测 7 例：有线索注入/无线征不注入/带 eventId/limit 生效/超限截断/去重/关键词提取；另有 referenced 回归测试（上一轮是查询轮时必须被接受）✓
- 探针 `--only C1` 连续两轮：第一轮 referenced 申报接受 4/5（T3/T9/T13/T19 通过，T4 模型申报字段不规范被拒后澄清，fail-closed 正确）；第二轮 5/5 账套解析正确（T3 走 referenced 干净通过，T6/T11/T19 用正确上下文作答）✓
- `npm test` 295 全绿、typecheck 0 错误 ✓
- **已知模型侧失效（非宿主问题，记录待观察）**：第二轮 T4 模型以 conversation 申报复述了上一轮结果格式而未重新委派——出口校验只覆盖 platform_query 申报，提示词层规则（不得把上一轮答复当作本轮结果）已被模型违反；按已否决方向不往提示词加规则，由 A1 类探针持续观察

**原 Phase 2 计划**（保留备查）：

**改动**：
- 申报**之前**，宿主检测指代/回溯线索（这个 / 那个 / 它 / 刚才 / 上次 / 我之前说过），从 Conversation Log 检索并注入 context 头部，带来源 eventId，与 Context State 并列
- 硬上限：最近 3–5 条 tool_result + 关键词命中 ≤3 条，超了截断并记日志
- **删除**：`route_reference_hint` 整套、`SYSTEM_PROMPT` 里 173 字符的指代规则

**关键约束（必须遵守，否则会打出洞）**：
> 检索证据只允许支撑**指代消解**，不允许**扩大实体范围**。即：消息里出现的实体才是候选；检索证据的作用是"把消息里的指代词对应到哪个实体"，不是"允许计划里出现历史上出现过的实体"。

不设这条约束，Phase 3 的包含校验会被检索证据打穿——历史里提过幻东，计划就能查幻东。

**验收**：
- 单测：有线索时注入、无线征时不注入、内容带 eventId、limit 生效、超出截断
- 探针 `--only C1` 连续两轮指代成功率 ≥4/5
- 上下文不膨胀（注入条数有上限且有日志）

---

## Phase 3 — 领域判别下沉

**状态：已完成**（由两个并行 subagent 实施：fshine 编排层改造 + 17dz SKILL 去重补全，主代理验收）。编排层不再做领域判别——这是解耦真正发生的一步。

**改动（实际落地）**：
- `validatePlanAgainstTurnDeclaration` 的 balance/voucher/account_search 三分支 → 领域无关的 `validatePlanEntities(calls, sources)`（`turn-contract.ts`）：每个 call 的 args 里所有字符串（`-` 开头 flag 除外）必须能在「① 当前用户消息 ② 本轮注入的指代消解证据 ③ 本任务迄今的平台响应」并集里逐字找到。来源全部由宿主持有、经 `platformTask.run → TurnDriverInput.entitySources` 注入，**不从申报契约字段推导**（活过 Phase 4）；平台响应在驱动拦截点从会话 tool_result 汇总，"目录查询拿唯一候选 → 按候选名查"天然放行
- 两个提示词的业务条目改为领域无关表述（能力边界与确认码转达协议保留、不再点名业务动作）；`ROUTE_CURRENT_TURN_TOOL.description` 移除领域判别教学（taskType 业务含义、名称/科目/客户区分、业务示例），8 字段一个没删（Phase 4 才瘦身）
- 17dz `skills-serve` 两个 SKILL.md 成为 worker 领域规则唯一事实源：补"查询口径（操作与问题类型匹配只由 SKILL+平台门禁保证）""实体参数溯源（三来源逐字，口癖名靠平台候选对齐）"；高危写边界补进 prepare 技能
- 规则落点同步登记：`docs/rule-landing.md` C6–C9 改指新校验、新增 C20；进度/压缩提示词、`NO_EXECUTION_CLARIFICATION` 等领域措辞一并中和

**验收（按实际达成记录）**：
- `grep -ri "应收\|凭证\|科目\|账套\|期间" packages/agent/src/` 规则文案**清零**；剩余 4 处均为执行机制字面量（长期记忆防泄漏过滤正则、上下文矛盾词表），理由见 `rule-landing.md` §5 ✓
- 17dz 全量测试 **ALL PASS**（20/20 套件，含 consistency/operations/plan/skills-serve-canary；干净环境下复跑确认）+ `lint:operations` 通过 ✓
- 探针 `--quick` 无回归 ✓：A1 2 次调用（重问必重查）、A4 1 次（只搜目录）、A5 0 次（闲聊不委派）与基线一致；A2 变 2 次是设计内的松动——worker 先用目录查询解析用户给的"猫一杯"（not_found）再追问，旧账套零渗入；B1 的 ⚠ 与基线同性质（探针把回复措辞里的数字也抽来比，5 轮数据全为 0）
- 跨仓 mock E2E（`plan-awareness`/`local-fake`）全绿；`npm test` 301 全绿、typecheck 0 错误 ✓

**已知行为变化（包含校验"更弱"的另一面：对派生值更严）**：
- 派生期间值不再放行："1 到 9 月"推不出 202601–202608（不在三个来源里）。实测 D1：worker 目录解析账套后查当前期间，并**如实说明平台只支持单期间查询、提议逐月查**——优雅降级而非胡编。逐月查询需用户明确给出期间（或未来平台提供期间枚举 operation，使其成为合法"平台响应"来源）。这是 §2 第 9 条"逐字找到"的既定语义，未改设计
- 操作与任务类型的匹配（存在性只搜索、余额只查余额接口）不再由宿主强制，归执行层 SKILL + 平台门禁；SKILL 已把这组规则写成硬规则

**风险（原记录，实际验证）**：包含校验比原来的精确范围弱——已按预期发生并被执行层前线接住（A4/A2 实测）；search→query 候选名放行有驱动级单测覆盖。

---

## Phase 4 — 申报契约瘦身

**状态：已完成**（三个并行 subagent 实施：契约核心 / 宿主装配 / 全部测试重写，主代理验收）。8 字段 → 3 字段，编排层零业务知识。

**改动（实际落地）**：
- `route_current_turn` 只保留 `kind`（conversation / delegate）、`request`、`continueTaskId`；删 `taskType`/`accountQueries`/`customerQueries`/`periods`/`accountResolution`/`searchQuery`/`referenceQuote`；`clarify` 种类取消（澄清=conversation，模型文本即回复）
- 删除 `validateTurnDeclarationEvidence`/`previousTurnText`/`applyRouteDeclaration`；申报层只剩结构校验（delegate 的 request 非空）；范围守卫完全靠 Phase 3 的包含校验
- 委派 request 用加工后的 `intent.request`（指代解析成实体，实体只从当前消息或宿主注入的检索证据取）；原始消息只留在 `entitySources.currentMessage`
- `turn-contract.ts` 与工具描述重写，零业务词；工具描述新增 request 加工教学（架构 §4 的加工表）
- 相关单测与 13 个 e2e 用例全部重写；schema 属性数=3 有断言；`manual-test-wecom.md` §8.2 映射同步

**验收（按实际达成记录）**：
- `turn-contract.ts` 与 `ROUTE_CURRENT_TURN_TOOL.description` 无任何业务词 ✓；schema 属性数 = 3 ✓
- `npm test` 306 全绿、typecheck 0 错误 ✓；旧契约字段全仓零残留 ✓
- 探针 `--only C1`：指代轮次经新的 request 加工路径正确解析（T3「这个账套 202608 呢？」→ 查到新兴五金 202608 真实数据），不劣化 ✓；T19 一轮零执行（voucher 期间家族的老摩擦，Phase 2 同场景也失败过）、T17 一轮模型泄漏协议文案——均为模型侧波动
- 探针 `--quick`：A1/A4/A5 与基线一致（A1 重问重查、A4 只搜目录、A5 闲聊零调用）；B1 五轮全真查（⚠ 为探针把措辞数字抽来比对的误报，数据全一致）

**已知模型侧失效（Phase 4 的结构性取舍，记录待观察）**：A2「新话题不得沿用上一轮实体」失去了申报层的结构性防线（C1 随契约删除），偶发复现——模型把上一轮账套加工进 request，C20 挡不住（worker 目录搜索响应会让该实体成为合法来源）。已处置：工具描述补一行原则句（用户另起新话题不得顺带沿用上一轮实体）；实测降概率但不根除（两次 A2 一次渗入、一次 worker 直接以客户名查询被平台拒并如实追问）。审计证据与后续方向见 `docs/rule-landing.md` §6。同类：申报 conversation 复述上一轮数据结论无代码兜底。

**行为代价**：宿主不再预校验账套，worker 每轮自行目录解析——单次查询从 1 次平台调用变为「搜目录+查询」2 次（B1 实测 5 轮 8–9 次调用）；派生期间值（"1 到 9 月"）仍被 C20 挡下、worker 如实说明并提议逐月查（Phase 3 已记录）。

**这是全线风险最高的一步**——契约一改，前面所有调试基线都变。它排在第 4，前面三步先把能删的删掉、把该给的证据给上，再动本体。

---

## Phase 5 — Subagent 报错回路

**状态：已完成**。架构 §3 的纠错环落地：执行不了就回报"缺什么"，Main Agent 补齐后重派，不再整轮失败。

**改动（实际落地）**：
- 结构化线索 `SubagentNeeds{missing, reason, suggestion?}` 挂在**委派结果**上（申报契约仍是 3 字段，零新增）。两个确定性来源：脚本化替身直接产出；真实 worker 由驱动从「平台 RESULT 信封错误码 + 宿主计划拦截原因原文」派生——**禁止对 worker 自由文本模糊匹配**（C21）
- 宿主回路：needs 出现时**不 terminate 整轮**，线索作为工具结果交还 Main Agent（含 taskId 与重派提示），任务记录保持可续；Main Agent 自己补齐（实体只从当前消息/检索证据/本轮平台响应取）就带 continueTaskId 重派，补不齐就转达用户；单回合最多 3 轮（C22）
- 出口校验：needs 回路中转达"缺什么"是合法回复（不再走"本轮没有产生任何平台查询"兜底）；**回路不是执行痕迹**，数字结论仍须本轮执行（C23）
- e2e 新增 `turn-loop-needs.test.ts` 3 例（全链/自补充分支/回路不是凭证）

**验收（按实际达成记录）**：
- e2e 覆盖「缺期间 → 问用户 → 用户补上 → 续跑原任务」全链 ✓（5.1，含同一 taskId 续跑与账本调用数断言）
- 不再出现"本轮没有产生任何平台查询"这种把原因丢掉的兜底 ✓
- `npm test` 319 全绿、typecheck 0 错误；业务词 grep 零新增 ✓
- **真实模型验证（探针 C1）**：T12「把新兴五金的凭证也列一下」（缺期间）→ 纠错环转达"凭证清单必须指定期间才能查，请提供 YYYYMM"→ T13 用户补上后续跑出真实凭证清单；T7（猫一杯）从 Phase 4 的"渗入旧账套"变为"卡在账套缺失上，需要你补一个信息"；Phase 4 零执行的 T19 本次正常执行。needs 均由确定性平台错误派生（日志 `delegation_needs`/`needs_loop_relayed`）✓

---

## Phase 6 — 长任务拆解

**状态：已完成**。架构 §3 的规划者/执行者分工落地：Main Agent 拆解 → 逐步派单 → 汇总，Subagent 只做单步执行。规则落点见 `docs/rule-landing.md` C24–C30。

**改动（实际落地）**：
- **计划模式协议**（`packages/agent/src/plan-steps.ts`）：delegate 的 request 以「第N/M步：」开头即多步拆解的一步，宿主用正则机械解析（零业务匹配）。**无前缀 = 单步，行为与 Phase 5 之前逐字相同**（结果 terminate 成本轮回复）；有前缀 = 该步结果不 terminate，作为工具结果交还 Main Agent（复用 Phase 5 的"交还"机制），由它继续下一步或申报 conversation 汇总。非法前缀（第 0 步 / 共 0 步 / N>M / 只有前缀）按单步处理。**申报契约仍 3 字段，一个都没加**
- **步骤 2..M 经 continueTaskId 在同一 17dz 子任务内续跑**：平台累计账本因此跨步累积——闸口看到的是全局重量（架构 §8"重计划不重置累计用量"的落地）
- **任一步失败不阻塞**（含 needs / 零执行的错误结果）：宿主照常派后续步骤，汇总如实报告失败步；纠错环上限在计划模式下**按步计**（同一步反复重报才收口，收口方式是"跳过这一步"而非终止整轮）
- **任务计划状态**（消费并行 stream 的 `TaskPlanRepo`）：每步委派前 append `started`，结果回来后按步补 `done`/`failed`/`needs`，taskId 写该步最后一条事实；planId 由宿主在第一步生成（`plan_${requestId}`），跨回合经 `latestOpenPlan` 找回（步号接得上且总步数一致）。deps 可选，缺省 = 不落计划状态、功能降级不报错
- **通知带「第 N/M 步」**：步骤标签经委派参数 `stepLabel` 透传到 `context.ts` 的 onNotice 交付处，前缀插在「计划通知：」标记之后（渠道与 e2e 替身仍按该标记识别通知帧）
- **业务 skill 落地**（架构 §5）：新增 `docs/business-skill.md`（草案原文 + 一条派单协议），`config/agent.yaml` 增可选 `businessSkillPath`，`apps/server/business-skill.ts` 启动时读文件（存在才读）注入 runtime deps，每回合追加进系统提示词；文件缺失 = 跳过
- e2e 新增 `turn-loop-plan-steps.test.ts` 2 例；单测新增 `plan-steps.test.ts`（5 例）+ `plan-mode.test.ts`（10 例），`turn-contract.test.ts` / `context.test.ts` 各增补

**验收（按实际达成记录）**：
- e2e 6.1「核对 3 个账套」全链：三次委派、后两步 taskId 与第一步相同、汇总含三个账套结果且**如实包含第 2 步的失败**（平台 not_found）、`sdk.noticeTexts()` 含"第 1/3 步"、账本调用数跨步累积（3+1+1）✓
- e2e 6.2 任一步失败不阻塞：第 2 步回报 needs → Main Agent 不卡住，继续第 3 步并在汇总如实报告缺信息 ✓
- `npm test` 372 全绿（+20）、typecheck 0 错误；业务词 grep 仍 4 处、零新增 ✓
- **真实模型验证（完成）**：D1/D2 已复跑通过（`--only D1,D2` 2/2 ✓）——D1 的 worker 在 1、2 月后被包含校验连续拒绝，收敛上限（PLAN STOP）触发，worker 如实报告"只取到 1、2 月、3–9 月未查询、原因与建议"，通知正常；D2 按 skill 的"M 未知先枚举候选"走目录搜索并明确结论"平台没有列出全部账套的接口"、向用户索要关键词。最终 `--quick` 与基线同构：A1 重查/A4 只搜目录/A5 零调用 ✓，A2 为已记录模型侧观察项（新话题沿用上一轮实体，worker 如实带出来源行），B1 的 ⚠ 为探针把"0"与"0.00"措辞差异当口径不一致的已知误报（五轮数据实际一致）
- **模型已切换**：`LLM_*` 现指向 StepFun step_plan 网关的 `step-5-preview`（上述探针均在新模型下完成；新模型单轮明显慢于 Kimi，B1 五轮 ~9 分钟）

---

## Phase 7 — 执行层记忆

**状态：已完成**。17dz 持久化自己的领域记忆，跨任务生效；编排层零改动。
**改动（实际落地，17dz 仓）**：
- 新增 `bin/17dz memory <get|put|list|delete>`（与 plan 组同风格：单行 JSON、MEMORY_REFUSE 走 stderr exit 3），存储为平台状态目录 JSON（`EXECUTION_MEMORY_STATE` 可覆盖，默认 `.runtime/memory.json`），scope 白名单 global/customer/accountSet（后两者必须带平台规范名 id），key kebab-case、value ≤2000 字符，机器强制
- 跨进程安全复刻 plan.js 失败模型：'wx' 独占锁 + 原子 rename；状态损坏 **fail-closed**（MEMORY_STATE_CORRUPT，不静默重置）
- SKILL（serve 两个）新增「领域记忆」节：何时读（计划激活后涉及该客户/账套时、用户说"跟上次一样"时）、何时写（用户当场确认后）、键约定、铁边界（只存领域口径，不存用户偏好/稳定事实；不得要求主 Agent 转述或代存）
- 边界保证：fshine 零改动；`bin/17dz memory` 天然过 fshine bash 门（首词规则）；memory 不进 operations 清单/矩阵/限流/计划绑定——取数路径上没有任何编排层组件参与

**验收（按实际达成记录）**：
- 17dz 全量 **21/21 套件全绿**（新增 test-memory.js：往返/覆盖写/scope 三维隔离/17 条坏输入/状态隔离/损坏 fail-closed/serve 法域读取/4 进程跨进程全链路）+ `lint:operations` 通过 ✓
- 跨任务说"跟上次一样"时执行层自取：3 独立进程共享 EXECUTION_MEMORY_STATE 的 put→get→list 复现实测通过 ✓
- 已知限制（已记录）：worker 在计划激活前读不了记忆（fshine 门禁要求先有激活计划）——SKILL 将读记忆定在计划激活后；记忆无审计/无版本迁移（对齐 roadmap「明确不做」）

---

## 验证协议

| 阶段 | 必跑 | 涉及申报/指代时加跑 |
|---|---|---|
| 每个 Phase 结束 | `npm run typecheck` + `npm test` | — |
| Phase 1 | 探针 `--quick`（对比业务层有无回归） | — |
| Phase 2 / 4 | — | 探针 `--only C1` 两轮 |
| Phase 3 / 5 / 6 | 17dz `test-plan` / `test-consistency` / `test-operations` | 探针 `--quick` |
| 里程碑（Phase 4、6 完成） | 探针全量 | — |

**探针本身的能力**：`scripts/probe-real-agent.ts`，真实 LLM + 真 `bin/17dz` + mock 执行器，`--only` 选用例、`--quick` 快速子集。

**覆盖增强（roadmap 之外，验收补强）**：多任务交织与探索型会话两类场景——e2e `turn-loop-interleaved.test.ts` 4 例 + 探针 E1/F1（`--only E1,F1`，不进 quick）。真实模型首测发现与处置记录于 `rule-landing.md` §9：探索型达到设计意图（澄清/不编造）；交织场景抓到 4 类模型/worker 侧失效（零执行轮次编造数据、请求加工 mangling、召回退化、worker 调用形式错误），宿主契约全部正确履职；相应地补了 `conversation_unsourced_amounts` 只记录不拦截的探查器与 17dz SKILL 的相对期间硬规则。

**从 StepCode 环境跑探针的坑**：harness 进程自带 `LLM_*` 环境变量（指向它自己用的模型），Node `--env-file` 不覆盖已存在变量——直接跑会静默用 harness 的配置而不是 `.env`。正确姿势：`env -u LLM_API_BASE_URL -u LLM_API_KEY -u LLM_MODEL -u LLM_THINKING_LEVEL node --env-file=.env --import tsx scripts/probe-real-agent.ts …`。

---

## 波次总览

| 波次 | 主题 | 状态 |
|---|---|---|
| W1 | 身份参数化（profile 声明 + 中性缺省） | 已完成 |
| W2+W3 | 错误码镜像层退役 + 提示词与文档对账 | 已完成 |
| W4 | 预算策略上收（通用预算协议单一源） | 已完成 |
| W5 | 结构化调用协议（a2a cutover） | 方案记录（§30） |

## 明确不做

- 通用多 Agent registry、跨域结果聚合（等真有第二个域再做）
- 业务 skill 从 operation 清单自动派生（先手写，等第二个域出现再看）
- 长期记忆定时生产调度、`MEMORY.md` 落盘、store schema 版本管理
- `EXECUTION_PLAN_*` 阈值精调（等真实执行数据积累）
