# R6 · 真实生产窗口长会话长稳 · Harness 设计（修订版 v2）

- 状态：**修订版 v2**，与 `docs/product/r6-longsession-prereg.md`（预注册修订版 v2）配套。本轮交付**测试基建（确定性、零真实模型）**：`scripts/eval/r6/**`。
- 归属：`arch/r6-harness`（worktree `~/projects/fshine-agent-r6-harness`，基线 `e2d12bd`）。领号：负载/观测设施用 **R6** 前缀，不新增 Runtime 机制。
- 一图概览：`负载生成器（多轮驱动 + 上下文推进器）→ 真实 Pi 驱动/装配（与生产同源；Wave1 接线）→ 事实 Oracle / 任务 Oracle(Task Registry) / Pi 原生压缩生命周期采集 → 冻结 rubric 判官 → 逐会话证据 schema → 三态处置`。**全链只采集事实，不在任何环节改变压缩触发/门控。**

## 一、角色与硬边界（观测绝不改触发/门控）

1. **只采集，不裁决压缩**：负载与观测代码**不得**读取压缩阈值、不得调用 `shouldCompact`/`compactionSettingsFor` 做分支、不得决定「现在该不该压」。只做两件事：(a) 向会话注入**新的真实内容**；(b) 从会话生命周期面**记录事实**。
2. **不得演变为第二套压缩决策机制**：禁止「发现零收益就跳过下一次」「达 N 次就停推」之类**改变触发行为**的判定。允许的只有**样本有效性门槛**（压缩计数不足 → 样本覆盖不足）与**硬停**；二者都不改变压缩触发逻辑。
3. **零产品代码改动**：不碰 `packages/**`、`apps/**`；不动 Worker 提示、任务账本、权限；不借测试名义增 Runtime 机制。测试基建**可以 import** 产品模块（只读消费），但**不改**产品源码。
4. **不伪造窗口**：窗口 = 该会话冻结值（40k 探索 / 128k 生产）。不得靠缩小窗口或压缩注入量冒充「128k 下压缩」。
5. **架构纪律**：不改 Worker 提示词；**不新增 fshine 自研压缩机制**；**不因评测失败擅自给 Pi 增加宿主侧压缩治理**；**Pi 迁移失败时如实报告，不用旧机制暗中兜底制造通过结果**。
6. **夹具隔离**：负载数据使用**独立于现有 dummy-platform seedState** 的专用夹具（新增集合/新 profile 或独立 state 根），避免改动 `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs` 既有种子面而影响既有判定。
7. `.runtime` gitignored、不得 `git add`；不改 `docs/decision-log.md`。

## 二、负载生成器（实现：`scripts/eval/r6/load-generator.ts`）

### 2.0 与既有基建的关系

| 既有 | 可复用 | 不可复用原因 |
|---|---|---|
| `scripts/ask-interactive.ts`（单进程单 Session 逐行 send） | 入口骨架：连续多轮真实驱动 | 面向交互/手工，无「≥3 次压缩」推进器与多 Session 并行 |
| `scripts/ask-replay.ts`（多会话共享装配 + 记录包装器） | 多 Session 装配骨架 | 模型面是确定性假计划（`createScriptedController`，`mainDriver` 直接返回 `plan.reply`），**不可用于质量结论** |
| `scripts/eval/p3/p3a-session.ts` / `p3s4-session.ts`（真实驱动 + 事件捕获 + budget 硬停） | 执行器骨架（驱动链、事件捕获、证据写盘形态） | 全部 `LLM_CONTEXT_WINDOW:'8192'`，且无「≥3 次压缩」保障、无语料体量 |

新 harness = 以 `p3a-session.ts` 的**驱动/事件/硬停**骨架为基，替换为：(a) 冻结窗口（40k/128k）；(b) 上下文推进器；(c) 多 Session 并行；(d) 事实/任务 Oracle；(e) 冻结 rubric 判官接线。

### 2.1 多轮自动驱动

- 每会话由一个**脚本人格**逐轮驱动 `session.send(turnText)`。
- 语料 = **自然多轮业务语料**，按轨道编排不同模板。**实现（本轮）**：`buildTrackPlan(track)` 为 LS1–LS5 生成确定性逐轮计划 `TurnSpec[]`：
  - LS1：3 建立轮 + **8 事实轮（F1–F8，携 `fact` 期望）**；
  - LS2：建立轮 + 6 任务轮（携 `expectTaskStatus`）；
  - LS3：建立轮 + 10 交互轮（NL1–NL10，携 `label`）；
  - LS4/LS5：建立轮（生命周期/长稳，事实轮不适用）。
- 逐轮记录：回复、`session.tasks()` 快照差分、转录体量、时长、本回合模型调用数。
- 结束条件：轨道的用例集跑完 **且** 已达 ≥3 次有效压缩 **且** 完成压缩后的探针轮；否则继续推进（见 2.2）或直到硬停。

### 2.2 每会话 ≥3 次真实压缩：达成路径（定量）

**算术（128k 冻结臂）**：
- 缺省窗口 `DEFAULT_CONTEXT_WINDOW = 128000`（`packages/agent/src/pi-driver.ts:77`）；
- 缺省压缩设置 `reserveTokens=16384 / keepRecentTokens=20000`；
- 回合前压缩阈值 ≈ `W − reserveTokens`；有效压缩后稳态 ≈ 保留段 + 当前回合；
- ⇒ **两次有效压缩之间需净增 ≈ 9 万 token**；**3 次需 ≈ 275k token ≈ 1.1M 字符**真实转录。

**注入手段（真实内容，非伪造 token）**：
1. **真实大载荷查询**：对专用大集合发起真实查询，单次返回数千条记录（真实工具结果 + 真实模型回合），单轮可产生数万 token 增量。
2. **多对象/多期间累积**：按 LS1 的 7 类事实源轮次累积（多对象 × W1/W2/多期间）。
3. **上下文推进器（Context Pump）**：**实现** `buildPumpTurns(startIndex, count)`——跑完用例集仍未达 ≥3 次有效压缩时，**继续注入新的真实内容轮**（换对象/窗口的真实查询），直至达 3 次或触硬停。推进器**只加内容**，不读阈值、不做压缩判断。

**逐轮 token 曲线（预期形态，Wave1 实测校准）**：起 ~5k → 大载荷累积越过阈值 → 压缩#1 → #2 → #3 → 压缩后探针。曲线斜率与集合规模由 Wave1 实测校准；若 128k 下难触发，属 Wave1 **可行性发现**，登记并回报（不得改判据掩盖）。

### 2.3 多 Session 并行 + 长稳 ≥2h

- **同进程并行多 Session**：至少 2 个 Session 在同一 Node 进程内并行，用于验证「无跨 Session 转录污染」（H7）。
- **长稳轨（LS5）**：总挂钟 ≥2h，周期性（如每 10 min）采样 RSS/CPU 作为粗粒度读数。
- 并行度、时长、Session 数在预注册中冻结；具体值待 Wave1 校准 + owner 冻结。

### 2.4 硬停（先验拒绝）

沿用 `scripts/eval/p3/enforce.ts` 的 `createBudgetLedger` + `createEnforcingDriver`（`P3BudgetHardStopError`）：每个真实模型调用前先验校验 `calls/tokens/wall`，超限即抛、落 `hardlimits.json`。硬停值见预注册 §6.1 / §十三。**硬停是本会话的停止线，不是全局额度闸**。

### 2.5 大载荷压力与业务交互分开归因（实现：`TurnSpec.kind`）

- 逐轮 `kind ∈ {establish, fact, task, interaction, pump, probe}`；证据 schema 保留 `kind`。
- **人工大载荷压力**（`pump`）与**普通业务多轮交互**（`fact`/`task`/`interaction`）**分开归因、分别报告**；**不得**把载荷压力结果外推成日常业务可靠性。

## 三、事实 Oracle（实现：`scripts/eval/r6/oracle.ts`）

**目的**：把「事实保留」从模型自述中解耦，用**确定性真值**判定，且与业务夹具同源。

**真值来源（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs` seedState 语义快照；专用负载夹具在此基础上扩规模，语义一致）**：

> **口径校正**：`doQuery` 在 completed 时返回**集合级 `items` 全量与 `count = items.length`**，**不按窗口过滤 items**；`window` 只用于存在性校验（不在则 `WINDOW_NO_DATA`）。故 Oracle 真值以 **`items` 全量**为准，窗口仅作合法性维度。

| 集合 | 条数 | 总额 | 合法窗口 | 备注 |
|---|---|---|---|---|
| alpha | 2 | 2000 | W1、W2 | —— |
| beta | 3 | 1000 | W1 | —— |
| alpha-group | 1 | 700 | W1 | —— |
| documents | 3 | 2900 | W202610、W202611 | 同名异值：document-2 出现两次（800/900） |
| contoso-trade | 2 | 2100 | W1、W2 | —— |
| contoso-logistics | 1 | 450 | W1 | —— |
| bankflow-oct | 4 | 27200 | 2025-10 | 负值 −3600 + 同名单值重复记账 |
| empty-one | 0 | 0 | W1 | 唯一答案=「空」 |
| locked-one | 1 | 900 | W1 | `locked` 只挡写 |

> 真值表以代码为准：`scripts/eval/r6/oracle.ts` `FACT_TRUTH`（含逐条 `items`）；歧义对 `AMBIGUOUS_PREFIX`（contoso→trade/logistics；fabrikam→retail/wholesale）。

**Oracle 判定三类（`judgeFactAnswer`）**：
1. **唯一可答**（`exact`）：答案必须精确匹配（数值/条数）；容差 = 0（禁四舍五入漂移）。
2. **明确不可答**（`unanswerable`）：对**从未查询的窗口/对象**提问 → 唯一正确答案 = 「需先查询/无法确认」；编造数值 = E-A 判负（先剥离窗口/期间编码形状，避免复述窗口名被误判）。
3. **应澄清（歧义）**（`clarify`）：`contoso`/`fabrikam` 类 → 唯一正确答案 = 提出澄清并给候选；不澄清硬答 = E-F 判负。
4. **会话内约定事实**（`session_value`）：被纠正数字 / 被撤销结论 / 未完成事项 / 用户约束，真值 = 该会话内最后一次用户确认/纠正后的字面值（由脚本人格显式记录为 `expected`）。

- **会话聚合**：`judgeSessionFacts` 全对才判该会话 T1 通过（不拆独立样本）。
- **措辞面的模糊判定交判官层**（§六）：机械 Oracle 对不确定措辞返回 `E-INCONCLUSIVE`（不冒充产品失败）。
- **真值独立性**：Oracle 只读夹具种子与已发生的真实工具结果，不看模型回复；被纠正/被撤销类由会话内 `expected` 提供。

## 四、任务 Oracle = Task Registry（实现：`scripts/eval/r6/oracle.ts` `judgeTaskContinuity`）

- **唯一 Oracle**：`packages/agent/src/task-registry.ts` 的 `TaskRegistry`（SQLite 实现 `createSqliteTaskRegistry`；Wave1 由真实 registry 投影成 `TaskView[]` 后喂入）。任务状态/原因/执行清单/编号/归属由**确定性底账**表达，不嗅探模型文本（`judgeReportedTask`，`:137-156`）。
- **判定项**：
  - 存在性与归属：`get(taskId, {principalId, sessionId})`，越权 → `TaskOwnershipError`（`:440-449`，越权与不存在同错）；
  - 状态与原因：`status ∈ TASK_STATUSES`（`:42-52`）、`reason ∈ TASK_REASONS`（`:57-63`）；
  - 五态映射：completed / running / cancelled（`confirmCancelled` 后）/ failed / waiting_user；`statesCovered` 断言五态覆盖；
  - 执行事实：`requestId` **归属唯一**（H3：同一 requestId 归属多个 taskId = 重复执行）；`completed` 却零执行（H4 虚假完成）；编号不混淆（同 taskNo 不同 taskId = E-G）。
- **硬零子集**：H3（重复执行）、H4（虚假完成）、H5（取消虚假回执，回复声称已取消却未调 `task_cancel`）由本 Oracle 判定为 0。
- **不判**：会话持久化/重启恢复——属独立验收（R6 不评）。

## 五、证据 schema（实现：`scripts/eval/r6/evidence.ts`；逐会话可复核原始留档）

**根**：`.runtime/r6/<wave>/<lsN>/<sessionId>/`（gitignored）。每会话一个目录，全部为**原始留档**。

| 文件 | 内容 | 关键字段 |
|---|---|---|
| `manifest.json` | 会话元数据 | `sessionId`、`principalId`、`model`、`contextWindow`（=该会话冻结值）、`wave`、`track`、`limits`、`budgetUsed`、`budgetStopped`、`startedAt/endedAt` |
| `turns.jsonl` | 逐轮输入 | `index`、`text`、`expected`（Oracle 约定事实，若有） |
| `replies.jsonl` | 逐轮回复 | `index`、`text`、`replyChars`、`durationMs` |
| `compaction-events.jsonl` | **压缩尝试**（Pi 原生生命周期面） | `turn`、`kind`（`threshold`/`overflow`/`post_turn`/`unknown`）、`before`、`after`、`summaryChunks`（原生暴露时） |
| `token-curve.jsonl` | 逐回合上下文事实 | `turn`、`transcriptTokens`、`transcriptMessages`、`modelCalls`、`producedReply` |
| `tool-calls.jsonl` | 工具调用事实 | `turn`、`agent`、`seq`、`tool`、`args`、`resultSummary`、`elapsedMs` |
| `tasks-snapshots.jsonl` | Task Registry 逐轮快照 | `turn`、`tasks`、`reply`、`cancelCalled` |
| `tasks-final.json` | 会话末 Task Registry 全量 | `session.tasks()` 快照 |
| `resource-samples.jsonl` | 长稳资源读数（LS5） | `ts`、`rssBytes`、`cpuPct` |
| `evidence.json` | 汇总清单 | 引用上述文件 + `effectiveCompactions` + `disposition` + `hardZeroHits` + `factFailures` + `evidenceGaps` |

- **逐会话可复核**：每个结论（T1–T5 / 硬零 / UX）都能回溯到原始文件的具体行；**压缩尝试保留 before/after**（判「有效压缩」与「零收益」）；**摘要调用单独留档**（原生暴露时），闭合 R5「摘要调用疑似绕过 budget hook」。
- **三态处置写入**：`evidence.json` 记 `disposition`（`valid`/`insufficient_coverage`/`environment_interrupted`/`product_fault`）；**产品故障样本保留判负，不作废**（见 §十一）。

## 六、判官接线（rubric 冻结、判官与实施分离）

- **适用范围**：事实 Oracle（§三）与任务 Oracle（§四）为**机械判定**，不经判官；判官只用于**无法机械判定**的 UX 项（U1 空答、U2 泄漏、U3 事实措辞、U4 无谓澄清、U5/U6 及 LS3 中「是否如实回执」的措辞面）。
- **rubric 冻结**：判官 rubric 在 Wave2 运行前随预注册一并冻结；运行后不得改 rubric。
- **判官与实施分离**：判官由**不参与负载/产品实现**的角色执行（镜像 R3 holdout 盲测纪律）；实施者不得边跑边调 rubric。
- **可复判**：判官输入 = 会话原始留档（§五）；机械重判可复用 `scripts/eval/business-e2e/spread-judge/`（零模型）形态；判官版本号与 rubric 哈希登记进 `manifest.json`。
- **判官不得覆盖硬零**：硬零项由机械事实判定，判官**无权**把硬零判为非失败。

## 七、故障注入的执行形态（对齐预注册 §十 FI-1..FI-8）

| # | 注入实现形态（**Pi 原生边界**；设计，未实施） |
|---|---|
| FI-1 | 在 **Pi 摘要生成边界**（`generateSummaryWithUsage` 调用器）外包一层**可注入失败**的调用器（仅 harness 侧包装，不改产品）；稀疏按轮失败 |
| FI-2 | 摘要产物置近空（harness 侧在摘要结果回填前替换） |
| FI-3 | 注入 provider 溢出错误（触发 Pi 原生 overflow 缩减，`isContextOverflowError` 分支可达） |
| FI-4 | dummy `faulty-one`（`readFault`）——已有夹具，直接使用 |
| FI-5 | dummy `denied-one`（`restricted`）→ GATE_REFUSE |
| FI-6 | 取消后延迟注入执行结果（可控执行层延迟） |
| FI-7 | 同进程 ≥2 Session 并发 + 可注入时钟（租约推进） |
| FI-8 | **同进程注入第二 principal**：装配面追加一个 principal B 的 scope；以 B 的 scope 对 A 的任务做 `registry.get(taskA, {principalId: B, sessionId})` 越权探针，并机械扫描 B 会话留档是否含 A 的任务事实。**不改各会话单 principal 语料** |

- 全部假件/注入旋钮，**零真实平台、零真实凭据**；注入**不改产品代码**（wrapper/旋钮在 harness 侧）。
- **FI-1..FI-3 不绑定 fshine 私有函数/常量**（原 `splitForCompaction`/`MAIN_MODEL_RETRY_DELAYS_MS` 等随 Pi 迁移删除）。

## 八、复用既有基建与「必须新建」缺口（本轮状态）

**复用**：`p3a-session.ts`/`p3s4-session.ts` 的驱动链与事件捕获、`enforce.ts` 的硬停、`ask-runtime.ts` 的生产同源装配、`stats.ts` 的 `wilson95`/`newcombe95`。

**R6 缺口 · 本轮已落地（测试基建，零模型）**：
1. **负载生成器**（`load-generator.ts`：逐轨确定性语料 + 上下文推进器）；
2. **事实 Oracle**（`oracle.ts`：`judgeFactAnswer`/`judgeSessionFacts` + `FACT_TRUTH`）；
3. **任务 Oracle 适配**（`oracle.ts`：`judgeTaskContinuity`；五态/H3/H4/H5/E-G）；
4. **Pi 原生压缩生命周期判据**（`compaction.ts`：`analyzeCompaction`/`judgeCompactionLifecycle`）；
5. **证据 schema 采集器 + 三态处置**（`evidence.ts`：`collectEvidence`/`classifySample`）；
6. **会话执行管线 + HarnessSession 接口**（`harness.ts`：`runHarnessSession`；真实生产会话由 **Wave1 接线**的适配器提供同一接口）；
7. **假会话（确定性测试）**（`fake-session.ts`）；
8. **G3 就绪核查**（`g3-readiness.ts`：窗口/Dummy/principal/证据确定性检查 + 真实模型项待冒烟标注）。

**仍待 Wave1（真实模型，不在本轮）**：128k 负载生成器的**大载荷专用夹具扩规模**、多 Session 并行 **≥2h**、真实生产同源装配适配器接线、判官接线 + rubric 冻结、真实模型/128k 装配冒烟（G3-M1/M2/M3）。

## 九、旧实现基线对照的执行形态

> 触发条件：**仅当发生压缩管线迁移**时启用；**迁移前的 SHA 由 owner/集成指定**（本设计不臆造 SHA）。

- **独立 worktree**：对照臂在**迁移前 SHA** 的独立 worktree 运行。
- **同条件**：同模型/同提示词/同用例/同数据/同工具/同判据/同窗口/同 Oracle。
- **主分析单位 = 会话**：先按会话聚合，再对会话层做 k/N + Wilson 95% CI，做**非劣效**比较（差异区间，预注册 §四）。
- **不得跨臂外推**：两臂并发重叠、token 口径不同须在登记口径中说明。
- **未迁移时的处置**：若无迁移，「旧实现对照」退化为**同实现重复批次**（稳定性/噪声评估），**不产出 IMPROVED/REGRESSED 结论**。

## 十、边界与提交纪律（复述）

- 本文件与预注册均为设计文档；观测/负载代码一律**只采集事实、不改触发/门控**；不借测试名义增 Runtime 机制；不动 Worker 提示/任务账本/权限；不接真实平台；会话持久化问题不混入；`.runtime` 不得 git add；不改 `docs/decision-log.md`；不 push/不合并/不碰 main/tag。
- 提交身份 `Tao <34084876+phona@users.noreply.github.com>`；commit message 禁绝对路径；`TMPDIR=~/.tmp`。

## 十一、测试基建说明与运行方式（本轮交付）

**模块（`scripts/eval/r6/`）**：`oracle.ts`、`compaction.ts`、`load-generator.ts`、`evidence.ts`、`harness.ts`、`g3-readiness.ts`、`fake-session.ts`（测试支持）。

**确定性测试（假模型，零网、零 key）**：

```
npm test -- scripts/eval/r6        # 或在仓根：npx vitest run scripts/eval/r6
```

覆盖：事实 Oracle（exact/unanswerable/clarify/session_value + 会话聚合）、任务 Oracle（H3/H4/H5/E-G/五态）、压缩生命周期（有效数/零收益连串/H6.a/H6.b/覆盖不足/证据缺口）、负载生成器（逐轨计划/推进器确定性）、三态处置优先序与证据 schema、端到端管线（假会话）、G3 确定性四项。

**三态处置（`classifySample`，优先序冻结）**：`product_fault`（硬零或产品故障信号；**保留判负，不作废**）> `environment_interrupted`（环境信号；登记待重跑）> `insufficient_coverage`（有效压缩不足；留档）> `valid`。**产品故障不被环境信号吞掉**（防幸存者偏差）。

**G3**：确定性四项（窗口装配 / Dummy 隔离 / principal 隔离（FI-8 内核，真实 `TaskRegistry` 上跑）/ 证据采集）已实现并自验；真实模型项（G3-M1/M2/M3）标注 **待 Wave1 前冒烟**，不冒充通过。

**边界重申**：以上全部为**测试基建自证**，不是产品质量/稳定结论——质量结论只由真实模型产生（预注册 §〇.1）。
