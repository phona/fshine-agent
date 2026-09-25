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

**目标**：编排层不再做领域判别。这是解耦真正发生的一步。

**改动**：
- `workerSystemPrompt` 的业务条目 → 17dz 的 `SKILL.md`（大部分已在那，去重即可）
- `SYSTEM_PROMPT` 的业务条目 → 删（编排层不需要知道）
- `validatePlanAgainstTaskIntent` 的 balance/voucher/account_search 领域分支 → 换成架构文档 §2 第 9 条的**领域无关包含校验**：
  > 计划里每个实体（账号 / 期间 / 关键词）必须能在「当前消息 / 检索证据 / 本轮平台响应」里逐字找到。
  
  「本轮平台响应」一项很关键：执行层调目录查询拿到唯一候选，那个候选就是合法解析出来的，宿主不需要懂业务。

**验收**：
- `grep -ri "应收\|凭证\|科目\|账套\|期间" packages/agent/src/` 只命中契约枚举与日志字段，不命中任何规则文案
- 17dz `test-plan/test-consistency/test-operations` 全绿
- 探针 `--quick` 无回归；跨仓 mock E2E 全绿

**风险**：包含校验比原来的精确范围弱。缓解：靠上面那条约束 + 「本轮平台响应」补足；漏网时执行层自己的 SKILL 规则和平台参数校验仍在前线。

---

## Phase 4 — 申报契约瘦身

**目标**：8 字段 → 3 字段，编排层零业务知识。

**改动**：
- `route_current_turn` 只保留 `kind`（conversation / delegate）、`request`、`continueTaskId`
- 删 `taskType` / `accountQueries` / `customerQueries` / `periods` / `accountResolution` / `searchQuery` / `referenceQuote`
- 范围守卫完全靠 Phase 3 的包含校验
- `turn-contract.ts` 大幅瘦身；相关单测全部重写

**验收**：
- `turn-contract.ts` 与 `ROUTE_CURRENT_TURN_TOOL.description` 里无任何业务词
- schema 属性数 = 3
- `npm test` 全绿；探针 `--quick` 无回归；`--only C1` 指代不劣化

**这是全线风险最高的一步**——契约一改，前面所有调试基线都变。所以它排在第 4，前面三步先把能删的删掉、把该给的证据给上，再动本体。

---

## Phase 5 — Subagent 报错回路

**目标**：执行不了就回报"缺什么"，Main Agent 补齐后重派，不再整轮失败。

**改动**：
- 子 Agent 的失败回报带上结构化线索：缺哪个信息 / 为什么做不了 / 建议用户提供什么
- Main Agent 收到后：能自己补的补（从 Log 取实体），不能补的问用户，然后用 `continueTaskId` 重派
- 宿主出口校验不变

**验收**：e2e 覆盖「缺期间 → 问用户 → 用户补上 → 续跑原任务」全链；不再出现"本轮没有产生任何平台查询"这种把原因丢掉的兜底。

---

## Phase 6 — 长任务拆解

**目标**：Main Agent 做业务拆解与派单，Subagent 只做单步执行。

**改动**：
- 新增**任务计划状态**存储（append-only 事实 + 可重建投影，与 Log/Context State 同一套机制，不新造存储形态）
- 业务 skill 落地（架构文档 §5 草案，约 400 字，只含程序性知识）
- Main Agent 拆解 → 逐步派单 → 汇总；任一步失败不阻塞其他步骤
- 计划门支持"N/M 步"的上报，让用户的通知带全局观，闸口能做全局预算

**验收**：e2e 覆盖「核对 3 个账套」全链；其中一个账套失败时其他两个照常完成并在汇总里如实报告；用户收到的通知含"第 N/M 步"。

---

## Phase 7 — 执行层记忆（可选）

**目标**：17dz 持久化自己的领域记忆（客户录入格式差异、录汇票规则等），跨任务生效。

**边界**：归执行层自己存储和使用，编排层不存、不转发、不理解。

**验收**：跨任务说"跟上次一样"时，执行层能取到自己的口径记忆，不需要编排层转手。

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

---

## 明确不做

- 通用多 Agent registry、跨域结果聚合（等真有第二个域再做）
- 业务 skill 从 operation 清单自动派生（先手写，等第二个域出现再看）
- 长期记忆定时生产调度、`MEMORY.md` 落盘、store schema 版本管理
- `DZ_PLAN_*` 阈值精调（等真实执行数据积累）
