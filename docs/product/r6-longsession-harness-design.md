# R6 · 真实生产窗口长稳 · Harness 设计（负载生成器 + Oracle + 证据）

- 状态：**设计草案（DRAFT）**，与 `docs/product/r6-longsession-prereg.md`（预注册）配套；本轮 docs-only，零产品代码、零真实模型、不跑测试。
- 归属：`arch/r6-prep`（worktree `~/projects/fshine-agent-r6-prep`，基线 `84a22fa`）。领号：负载/观测设施沿用 **R6** 前缀，不新增 Runtime 机制。
- 一图概览：`负载生成器（多轮驱动 + 上下文推进器）→ 真实 Pi 驱动/装配（与生产同源）→ 事实 Oracle / 任务 Oracle(Task Registry) / 压缩事件采集 → 冻结 rubric 判官 → 逐会话证据 schema`。**全链只采集事实，不在任何环节改变压缩触发/门控。**

## 一、角色与硬边界（观测绝不改触发/门控）

1. **只采集，不裁决压缩**：负载与观测代码**不得**读取压缩阈值、不得调用 `shouldCompact`/`compactionSettingsFor` 做分支、不得决定「现在该不该压」。它只做两件事：(a) 向会话注入**新的真实内容**；(b) 从既有 console 结构化事件/装配面**记录事实**。
2. **不得演变为第二套压缩决策机制**：禁止「发现零收益就跳过下一次」「达 N 次就停推」之类**改变触发行为**的判定。允许的只有：**样本有效性门槛**（压缩计数不足 → 该会话样本无效）与**硬停**（超 calls/tokens/墙钟 → 停止本会话）；二者都不改变 fshine/Pi 的压缩触发逻辑。
3. **零产品代码改动**：不碰 `packages/**`、`apps/**`；不动 Worker 提示、任务账本、权限；不借测试名义增 Runtime 机制。
4. **不伪造窗口**：窗口 = 该 Wave 冻结值（Wave2 128k）。不得靠缩小 `LLM_CONTEXT_WINDOW` 或压缩注入量冒充「128k 下压缩」。
5. **夹具隔离**：负载数据使用**独立于现有 dummy-platform seedState** 的专用夹具（新增集合/新 profile 或独立 state 根），避免改动 `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:245-300` 的既有种子面而影响既有判定/评测。
6. `.runtime` gitignored、不得 `git add`；不改 `docs/decision-log.md`。

## 二、负载生成器

### 2.0 与既有基建的关系

| 既有 | 可复用 | 不可复用原因 |
|---|---|---|
| `scripts/ask-interactive.ts`（单进程单 Session 逐行 send、跨回合同一底账 scope、`--trace`） | **入口骨架**：连续多轮真实驱动 | 面向交互/手工，无「≥3 次压缩」推进器与多 Session 并行 |
| `scripts/ask-replay.ts`（多会话共享装配 + 记录包装器 + trace，`:515-746`） | **多 Session 装配骨架** | 其模型面是确定性假计划（`:355-357` `scripted-fake`），**不可用于质量结论** |
| `scripts/eval/p3/p3a-session.ts` / `p3s4-session.ts`（真实驱动 + recordingDriver + 压缩事件捕获 + budget 硬停） | **执行器骨架**（驱动链、事件捕获、证据写盘形态） | 全部 `LLM_CONTEXT_WINDOW:'8192'`（`:109`/`:152`），且无「≥3 次压缩」保障、无语料体量 |

新 harness = 以 `p3a-session.ts` 的**驱动/事件/硬停**骨架为基，替换为：(a) 生产 128k 窗口；(b) 上下文推进器；(c) 多 Session 并行；(d) 事实/任务 Oracle；(e) 冻结 rubric 判官接线。

### 2.1 多轮自动驱动

- 每会话由一个**脚本人格**（scripted persona）逐轮驱动：`session.send(turnText)`（沿用 `ask-interactive.ts`/`p3a-session.ts` 同一 `send` 面）。
- 语料 = **自然多轮业务语料**（沿用/扩写 `p3s4-session.ts:65-113` 的 TURNS 风格），每轮有真实业务对象与接续关系；按轨道（LS1–LS5）编排不同语料模板。
- 逐轮记录：回复、`session.tasks()` 快照差分、`session.transcript()` 的 token 估算（`estimateContextTokens`，沿用 `p3a-session.ts:228`）、时长、本回合 modelCalls。
- 结束条件：轨道的用例集跑完 **且** 已达 ≥3 次有效压缩 **且** 完成压缩后的探针轮；否则继续推进（见 2.3）或直到硬停。

### 2.2 每会话 ≥3 次真实压缩：达成路径（定量）

**算术（128k 冻结臂）**：
- `DEFAULT_CONTEXT_WINDOW = 128000`（`pi-driver.ts:77`）；
- 缺省压缩设置 `reserveTokens=16384 / keepRecentTokens=20000`（`pi-driver.ts:347-361` 缺省臂沿用 Pi 常数，`compactionSettingsFor` 对 W≥36384 不缩放）；
- 回合前压缩阈值 ≈ `W − reserveTokens = 111616`；压缩产物目标 `target = W − reserveTokens = 111616`（`pi-driver.ts:766`）；有效压缩后稳态 ≈ 保留段（~20000）+ 当前回合；
- ⇒ **两次有效压缩之间需净增 ≈ 9 万 token**；**3 次需 ≈ 275k token ≈ 1.1M 字符**真实转录。

**注入手段（真实内容，非伪造 token）**：
1. **真实大载荷查询**：对专用大集合发起真实 `dummy.query`，单次返回数千条记录（真实工具结果 + 真实模型回合），单轮可产生数万 token 增量。专用集合规模按 §2.2 预算表设计（如每集合 ≥3000 条记录）。
2. **多对象/多期间累积**：按 LS1 的 7 类事实源轮次累积（alpha/beta/alpha-group 多对象 × W1/W2/多期间/W202610-11）——每轮是真实业务交互，不是无意义填充。
3. **上下文推进器（Context Pump）**：若跑完用例集仍未达 ≥3 次有效压缩，则**继续注入新的真实内容轮**（新对象/新窗口/结果展开），直至达 3 次有效压缩或触硬停。推进器**只加内容**，不读阈值、不做压缩判断。

**逐轮 token 曲线（预期形态，Wave1 实测校准）**：

| 阶段 | 转录 token（估） | 事件 |
|---|---|---|
| 起 | ~5k | — |
| 大载荷轮累积 | → 111k+ | 越过阈值 → **压缩#1**（`context_compact_trimmed` + `context_compacted`，tokensAfter ↓） |
| 再累积 | → 111k+ | **压缩#2** |
| 再累积 | → 111k+ | **压缩#3** → 会话达门槛 |
| 压缩后探针 | ≈ 保留段 + 当前回合 | 按轨道用例追问（LS1 事实 / LS2 任务 / LS3 交互） |

> 曲线斜率与集合规模由 Wave1 实测校准；**若发现 128k 下即使大载荷也难触发**，属 Wave1 的**可行性发现**，登记并回报 owner（不得改判据掩盖）。

### 2.3 多 Session 并行 + 长稳 ≥2h

- **同进程并行多 Session**：至少 2 个 Session 在同一 Node 进程内并行（沿用 `ask-replay.ts` 的多会话共享装配形态），用于验证「无跨 Session 转录污染」（H7）。
- **长稳轨（LS5）**：总挂钟 ≥2h，期间并行 Session 持续交互；周期性（如每 10 min）采样 RSS/CPU 作为粗粒度读数（对齐 `r4-stability-prereg.md` §四-I5 的预热 + 中位数 3 次采样法）。
- 并行度、时长、Session 数在预注册中冻结；本次设计给形态，具体值待 Wave1 校准 + owner 冻结。

### 2.4 硬停（先验拒绝）

沿用 `scripts/eval/p3/enforce.ts` 的 `createBudgetLedger` + `createEnforcingDriver`（`P3BudgetHardStopError`）：每个真实模型调用前先验校验 `calls/tokens/wall`，超限即抛、落 `hardlimits.json`。硬停值见预注册 §6.1。**硬停是本会话的停止线，不是全局额度闸**。

## 三、事实 Oracle（逐题唯一答案 / 明确不可答）

**目的**：把「事实保留」从模型自述中解耦，用**确定性真值**判定，且与业务夹具同源（真值来自 dummy 夹具的 seed 数据，非另写一份）。

**真值来源（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:245-300` seedState；专用负载夹具在此基础上扩规模，语义一致）**：

> **口径校正（重要）**：`doQuery`（`dummy.cjs:451-455`）在 completed 时返回的是**集合级 `items` 全量与 `count = items.length`**，并**不按窗口过滤 items**；`window` 只用于「该窗口是否在 `col.windows` 内」的存在性校验（不在则 `WINDOW_NO_DATA` → not_found）。state 里的 `records`（逐窗口计数）**不经 query 返回**。故 Oracle 真值以 **`items` 全量**为准，窗口仅作合法性维度。

| 集合 | 返回条数（=`items.length`） | items（名称 = 金额；唯一真值） | 合法窗口 | 备注 |
|---|---|---|---|---|
| alpha | 2 | alpha-item-1=1200、alpha-item-2=800（和 **2000**） | W1、W2 | rec-001/002；两窗口 query 返回同 items |
| beta | 3 | beta-item-1=500、beta-item-2=300、beta-item-3=200（和 **1000**） | W1 | rec-101/102/103 |
| alpha-group | 1 | alpha-group-item-1=**700** | W1 | rec-201 |
| documents | 3 | document-1=1200、**第二条 document-2=800**、document-2=900（同名异值，异常事实） | W202610、W202611 | doc-001/002/003 |
| contoso-trade | 2 | contoso-trade-item-1=1500、item-2=600（和 **2100**） | W1、W2 | rec-401/402 |
| contoso-logistics | 1 | contoso-logistics-item-1=**450** | W1 | rec-501 |
| bankflow-oct | 4 | 含**负值 −3600**、同名同值重复 bank-1021-03=12800×2（异常事实） | 2025-10 | rec-801..804 |
| empty-one | 0 | **无数据** | W1 | 唯一答案=「空」 |
| locked-one | 1 | locked-item-1=900（query 可读；写被拒） | W1 | `locked:true` 只挡写 |
| contoso（子串） | — | **歧义**（trade/logistics 命中两个） | — | 唯一答案=「需澄清（歧义）」 |
| fabrikam（子串） | — | **歧义**（retail=880 / wholesale=1320） | — | 同上 |

**Oracle 判定三类**：

1. **唯一可答**：题目对应上表某格 → 答案必须**精确匹配**（数值/条数/对象名）；近似金额题给容差 = 0（禁四舍五入漂移）。
2. **明确不可答**：对**从未查询的窗口/对象**提问，或窗口不在 `availableWindows` → 唯一正确答案 = 「需先查询/无法确认」；**编造数值 = E-A 判负**。
3. **应澄清（歧义）**：`contoso`/`fabrikam` 类 → 唯一正确答案 = 提出澄清并给候选；**不澄清硬答 = E-F/E-E 判负**。

- **真值独立性**：Oracle 真值**只**来自夹具种子 + 已发生的真实工具结果（tool-calls 的 `resultSummary`），不看模型回复；判定为**机械比对**（数值解析 + 对象名解析），无明显歧义时不引入判官。
- **被纠正数字 / 被撤销结论 / 未完成事项 / 用户约束**（F4–F7）：这些是**会话内约定事实**，真值 = 该会话内最后一次用户确认/纠正后的值（由脚本人格显式记录为 `expected`），压缩后追问答必须匹配该 `expected`。
- **与业务夹具分离的边界**：Oracle 是**只读消费者**（读种子与工具结果），不写夹具、不注入业务事实（对齐 R5 四轴对「夹具冒充真实模型」的纪律）。

## 四、任务 Oracle = Task Registry

- **唯一 Oracle**：`packages/agent/src/task-registry.ts` 的 `TaskRegistry`（SQLite 实现 `createSqliteTaskRegistry`，沿用 `p3a-session.ts:210`）。任务的状态/原因/执行清单/编号/归属由**确定性底账**表达，不嗅探模型文本（`judgeReportedTask`，`:137-156`）。
- **判定项**：
  - 存在性与归属：`get(taskId, {principalId, sessionId})`，越权 → `TaskOwnershipError`（`:440-449`，越权与不存在同错，不泄漏存在性）；
  - 状态与原因：`status ∈ TASK_STATUSES`（`:42-52`）、`reason ∈ TASK_REASONS`（`:56-63`）与目标状态一致（`mechanicalReason`，`:272-289`）；
  - 五态映射：completed / running（执行中）/ cancelled（`confirmCancelled` 后）/ failed / waiting_user（待确认）；
  - 取消语义：`requestCancel`（≠取消）→ `confirmCancelled`（`:586-595`）才算取消；`cancelling→running` 回滚边（`:232-242`）用于「中止未获确认不得宣称取消」；
  - 执行事实：`executions` 的 `requestId` 唯一（H3 重复执行=0）、`complete` 走 `judgeReportedTask`（H4 虚假完成=0，零执行→unexecuted）；
  - 编号不混淆：`taskNo` 唯一不复用（`begin` 自增，`:516-535`），与对象/结果三者交叉核对。
- **硬零子集**：H3（重复执行）、H4（虚假完成）由本 Oracle 直接判定为 0。
- **不判**：会话持久化/重启恢复（`markResultUnknown`/`expireLeases`）——属独立验收（R6 不评，对齐预注册 §〇.10）。

## 五、证据 schema（逐会话可复核原始留档）

**根**：`.runtime/r6/<wave>/<lsN>/<sessionId>/`（gitignored）。每会话一个目录，全部为**原始留档**（未归一到只读摘要即写盘，判官/Oracle 只读消费）。

| 文件 | 内容 | 关键字段 |
|---|---|---|
| `manifest.json` | 会话元数据 | `sessionId`、`principalId`、`model`（须 =`step-3.7-flash`）、`contextWindow`（须 = 该 Wave 冻结值）、`limits`、`budgetUsed`、`budgetStopped`、`startedAt/endedAt` |
| `turns.jsonl` | 逐轮输入 | `index`、`text`、`expected`（Oracle 约定事实，若有） |
| `replies.jsonl` | 逐轮回复 | `index`、`text`、`replyChars`、`durationMs` |
| `compaction-events.jsonl` | **压缩事件**（来自 console 结构化事件，`p3s4-session.ts:115-120` 同源集 + 逐回合标注） | `turn`、`event`（`context_emergency_compact`/`context_compacted`/`context_compact_trimmed`/`context_compact_degraded`/`context_compact_failed`/`context_compact_no_cut`）、`tokensBefore`、`tokensAfter`、`removedMessages`、`keptMessages`、`summaryChunks`、`summaryElapsedMs` |
| `token-curve.jsonl` | 逐回合上下文 token | `turn`、`transcriptTokens`、`transcriptMessages`、`hasSummaryMarker` |
| `tool-calls.jsonl` | 工具调用事实 | `turn`、`agent`、`seq`、`tool`、`args`、`resultSummary`、`elapsedMs`（沿用 `p3s4-session.ts:122-125,180-208`） |
| `tasks-snapshots.jsonl` | Task Registry 逐轮快照差分 | `ts`、`taskId`、`taskNo`、`to`(status)、`turn`（沿用 `p3s4-session.ts:284-290`） |
| `tasks-final.json` | 会话末 Task Registry 全量 | `session.tasks()` 快照 |
| `resource-samples.jsonl` | 长稳资源读数（LS5） | `ts`、`rssBytes`、`cpuPct` |
| `evidence.json` | 汇总清单 | 引用上述各文件 + `budgetEvents` + `compactions`（有效压缩计数） |

- **逐会话可复核**：每个结论（T1–T5 / 硬零 / UX）都能回溯到上述原始文件的具体行；**压缩事件保留 `tokensBefore/After`**（判定「有效压缩」与「零收益」）、**摘要调用单独留档**（`summaryChunks`/`summaryElapsedMs`，闭合 R5「摘要调用疑似绕过 budget hook」，`docs/decision-log.md` §七十一 ②）。
- **压缩事件不得只留摘要**：保留原始 console JSON（对齐观测「只采集事实」）。
- **有效性门槛写入**：`evidence.json` 记 `effectiveCompactions`，<3 由 harness 标 `sampleInvalid: true`（不判产品失败，预注册 §6.3）。

## 六、判官接线（rubric 冻结、判官与实施分离）

- **适用范围**：事实 Oracle（§三）与任务 Oracle（§四）为**机械判定**，不经判官；判官只用于**无法机械判定**的 UX 项（U1 空答、U2 泄漏、U3 事实措辞、U4 无谓澄清、U5/U6 以及 LS3 中「是否如实回执」的措辞面）。
- **rubric 冻结**：判官 rubric（各 UX 指标的打分口径、边界例）在 Wave2 运行前**随预注册一并冻结**；运行后不得改 rubric（对齐 `r4-stability-prereg.md` §十）。
- **判官与实施分离**：判官由**不参与负载/产品实现**的角色执行（镜像 R3 `r3-open-decisions.md` §四.5「控制实施者对测试内容的访问」与 holdout 盲测纪律）；实施者不得边跑边调 rubric。
- **可复判**：判官输入 = 会话原始留档（§五）；机械重判可复用 `scripts/eval/business-e2e/spread-judge/`（零模型）形态；判官版本号与 rubric 哈希登记进 `manifest.json`。
- **判官不得覆盖硬零**：硬零项（§五）由机械事实判定，判官**无权**把硬零判为非失败（§〇.5：硬性安全失败不得被平均分抵消）。

## 七、故障注入的执行形态（对齐预注册 §十 FI-1..FI-7）

| # | 注入实现形态（设计，未实施） |
|---|---|
| FI-1 | 在 Pi `generateSummary` 调用路径外包一层**可注入失败**的调用器（仅 harness 侧包装，不改产品）；稀疏按轮失败 |
| FI-2 | 摘要产物置近空（harness 侧在摘要结果回填前替换，或走既有近空产物的 W=8192 复现几何） |
| FI-3 | 注入 provider 溢出错误（`isContextOverflowError` 分支可达） |
| FI-4 | dummy `faulty-one`（`readFault`，`dummy.cjs:271`）——已有夹具，直接使用 |
| FI-5 | dummy `denied-one`（`restricted`，`dummy.cjs:272`）→ GATE_REFUSE |
| FI-6 | 取消后延迟注入执行结果（可控执行层延迟） |
| FI-7 | 同进程 ≥2 Session 并发 + 可注入时钟（租约推进） |

- 全部假件/注入旋钮，**零真实平台、零真实凭据**；注入**不改产品代码**（wrapper/旋钮在 harness 侧）。
- 每项断言「应出现的有界行为」（预注册 §十），并采集对应机械事件。

## 八、复用既有基建与「必须新建」缺口

**复用**：`p3a-session.ts`/`p3s4-session.ts` 的驱动链与事件捕获、`enforce.ts` 的硬停、`assembleSessionCore`/`resolveExecutionFace`/`createBackgroundDispatch`（`ask-runtime.ts`）的生产同源装配、`stats.ts` 的 `wilson95`、`ask-interactive.ts` 的连续交互入口、`ask-replay.ts` 的多会话装配骨架。

**必须新建（R6 缺口）**：
1. **128k 负载生成器**（上下文推进器 + 专用大载荷夹具 + 多 Session 并行 + 长稳 ≥2h）；
2. **每会话 ≥3 次真实压缩的机械保障**（有效性门槛 + 推进器；只采集、不改门控）；
3. **事实 Oracle 模块**（逐题唯一答案/不可答/应澄清三类）；
4. **任务 Oracle 适配**（Task Registry → 五态/H3/H4 判定）；
5. **证据 schema 落盘**（§五）；
6. **判官接线 + rubric 冻结**（§六）；
7. **旧实现对照执行形态**（§九）。

## 九、旧实现基线对照的执行形态

> 触发条件：**仅当发生压缩管线迁移**（如采纳 Pi 原生 Session 复用，见 `docs/product/pi-compaction-decision.md`、`docs/decision-log.md` §七十五 RECOMMENDED_OPTION=A 条件式）时启用；**迁移前的 SHA 由 owner/集成指定**（本设计不臆造 SHA）。

- **独立 worktree**：对照臂在**迁移前 SHA** 的独立 worktree 运行（不新建分支名外的机制）。
- **同条件**：**同模型**（`step-3.7-flash`）、**同提示词**、**同用例**、**同数据**、**同工具**、**同判据**、**同窗口**（128k）、**同 Oracle**。
- **主分析单位 = 会话**：两臂各跑预注册规定的 N 会话；**先按会话聚合**，再对会话层做 k/N + Wilson 95% CI，做**非劣效**比较（§四界值）。
- **不得跨臂外推**：两臂的运行期若并发重叠、token 口径不同，须在登记口径中说明（对齐 `docs/decision-log.md:635` 的跨臂口径纪律）。
- **未迁移时的处置**：若无迁移，则「旧实现对照」退化为**同实现重复批次**（用于稳定性/噪声评估），此时**不产出 IMPROVED/REGRESSED 结论**（无非劣效对照臂）。

## 十、边界与提交纪律（复述）

- 本文件与预注册均为 **docs-only**；观测/负载代码一律**只采集事实、不改触发/门控**；不借测试名义增 Runtime 机制；不动 Worker 提示/任务账本/权限；不接真实平台；会话持久化问题不混入；`.runtime` 不得 git add；不改 `docs/decision-log.md`；不 push/不合并/不碰 main/tag。
- 提交身份 `Tao <34084876+phona@users.noreply.github.com>`；commit message 禁 `/home/` 绝对路径；`TMPDIR=/home/tao/.tmp`。
