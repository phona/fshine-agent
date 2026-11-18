# 业务 E2E · 三轴总报告（功能边界 / 可靠性 / 稳定性）

> **性质**：本文件是**产品定义文档**（docs-only，零产品代码改动、零真实模型额度）。它把「五路能力审计 + 各批真实模型读数 + decision-log §四十二–§四十九」汇成一份，用来回答三件事：**产品能做什么（功能边界）、执行是否可信（可靠性）、在负载与长会话下是否稳（稳定性）**。
> worktree `~/projects/fshine-agent-r4-bizreport`，分支 `arch/r4-bizreport`，基线 = `arch/integration` 启动时 HEAD `241b02421f07d6c9207955b37f7c645764b0e0b4`。
> **不改写**任何既有报告 / 台账 / 冻结面 / 历史证据；所有读数**原样转述并逐条溯源**。本文件不产生新读数——它只**整理**已落盘证据。

## 0. 阅读约定（口径 · 三态标注 · 不夸大纪律）

- **三态标注（每条结论必属其一）**：
  - **【已验证】**：有真实模型读数或确定性机械证据支撑；
  - **【仅推断】**：由代码/机制推得，尚未被读数检验；
  - **【未验证 / 授权外】**：blocked 未跑、未接真实平台、或本轮范围外。
- **k/N 纪律**：所有 k/N 一律附 **Wilson 95% CI**，**N=3 / N=6 一律标「探索性、CI 极宽、不得读作稳定概率」**。
- **一句口径**：本报告的每格读数都能落到「报告章节 / 代码 `文件:行号` / `.runtime` 证据路径 / decision-log 条目」之一（见各表「溯源」列与 §附录 A 索引）。
- **不粉饰**：已登记但未修的产品缺陷照实列入（§① 功能边界与 §④ 待 owner 裁定），不因「已设计」「已登记」而记作「已支持」或「已解决」。

### 0.1 证据面（本报告读过的来源）

| 来源 | 覆盖 |
|---|---|
| `docs/product/business-e2e-probe-report.md` | §一–§十（R1 臂0 探测）· §十一（R2/R3）· §十二（缺口落地后三实验 bizbatch2）· §十三（夜跑续批 bizbatch3） |
| `docs/product/business-e2e-prereg.md` | 预注册正文（N=5 / ≤20 会话 / 三臂 / blocked） |
| `docs/product/business-e2e-prereg-addendum.md` | §一–§三（post-hoc 登记）· §四（owner 2026-11-15 裁定：N=3 / 模型钉 / #3 口径）· §五（三实验预注册）· §六（bizbatch3 预注册） |
| `docs/product/gap-task-surface.md` / `gap-main-skill.md` / `gap-compaction-window.md` | 缺口 1/2/3 设计与最小 diff |
| `docs/history/r4-acceptance.md` · `r4-stability-prereg.md` · `r4-joint-interfaces.md` · `p2a-task-contract.md` 等 | R4 验收设计 / 稳定性预注册 / 契约冻结面（R4 实施报告与切片计划已于 2026-11-18 清理，git 历史可考） |
| `docs/product/manual-test-handbook.md` | 手工测试定位与硬边界 |
| `docs/decision-log.md` §四十二–§四十九 | 能力审计、阶段 1/2、缺口实施、三实验、夜跑续批 |
| `.runtime/{bizprobe,bizbatch2,bizbatch3,stab,p7b}/`（gitignored，位于各自 worktree） | 原始读数（本报告已抽验，见 §附录 B） |

---

## ① 功能边界（主能力 · 已支持 / 部分支持 / 缺失）

> 骨架取自 decision-log §四十二「五路只读能力审计」（**owner 已接受为当前能力基线**）+ 缺口 1/2/3 落地后的状态更新（§四十七 合入 `4a12d8b`）+ 各批真实模型读数后的状态更新（报告 §十二/§十三）。

| # | 主能力 | 状态 | 三态 | 证据 / 溯源 | 关键读数（含 CI） | 该不该补 / 怎么优化 |
|---|---|---|---|---|---|---|
| 1 | **Main 对话主链（交办）**：理解需求 → `run_task` 委派 → Worker 经 Execution Contract 结构调用执行层 → 如实交付 | **已支持** | 【已验证】 | `execution-runtime.ts:582/:597`（工具面与分派）；R1 §二 #1/#2/#8；`[报告 §3.2]` | #1 3/3、#2 3/3、#8 3/3（N=3 探索性）；机械不变量 writeAttempts=0 | **不必补**。单对象/多对象核对基线达标。可取更大 N 观测部分失败面。 |
| 2 | **查询 / 取消 / 接续 / 结果找回（对话面四工具 #5）** | **部分支持** | 【已验证】 | 缺口 1 设计 `gap-task-surface.md`；缺口落地 `execution-runtime.ts:75-108`（工具声明）/:327（`resolveTaskId`）/:582/:597（门控）；`[报告 §12.2]`；`.runtime/bizbatch2/task-surface/` | T01 2/3 [0.208,0.939]、T02 2/3、T03 3/3 [0.438,1.000]（N=3）；unauthorized=0、取消如实（0 虚假「已取消」） | **该补（产品面，已登记不修）**：`ref` 契约缺陷使「按 `#编号` 定向引用」不可达——见 §④ 待裁定 ①。**优化（测试面）**：T02 `granted` 放宽为 collection 级消噪。 |
| 3 | **通知（后台完成 → 用户可感知）** | **部分支持（对话面缺失）+ 机械面已支持** | 【已验证】机械面 / 【未验证】真实渠道 | §四十二：通知不注入对话历史、生产入口未传 sink、整链休眠；P7b 抽查 `[报告 §二/§三]`：通知三态送达 9/9、15/15 | 后台 E2E 通知三态送达 9/9 [0.701,1.000]、15/15 [0.796,1.000]（机械面）；**注意**：经**假 sink**，真实 WeCom sink 不实现/不连接（**未验证 / 授权外**） | **该补（渠道切片）**：真实渠道 sink（`apps/server/main.ts:37` 接线点已留）。取舍见缺口 1 §3.6：本切片只解决「查」，不解决「推」。**不必补**去重/有界重试（已实现）。 |
| 4 | **Main 侧业务 Skill 投递（#2）** | **已支持（两实验臂可切换）** | 【已验证·探索性】 | 缺口 2 设计 `gap-main-skill.md`；落地 `worker-skills.ts:52`、`ask-runtime.ts:398-405`；`[报告 §12.4]`；`.runtime/bizbatch2/skill-arm/` | none 0/6、inline 6/6、catalog 3/6（digest 3/3、note 0/3）；N=3、CI 重叠 | **不必补**臂 A 常驻成本（1312B 量级小）。**优化（实验面）**：臂 B 弱点是「模型判不需读就不读」。**该补（判据面）**：口径采纳需人读复核。**边界**：`read_skill` 仅评测臂、**不进产品缺省**（`decision-log §四十六` 加回决定）。 |
| 5 | **会话压缩（#7）** | **部分支持 → 未取得端到端读数** | 【已验证】机制 / 【未验证】端到端 | 缺口 3 设计 `gap-compaction-window.md`；落地 `ask-runtime.ts:135 contextWindowFrom`；`[报告 §12.3 / §13.1]`；`.runtime/bizbatch3/compaction-c03/`+`/c04/` | 窗口接线生效（`context_emergency_compact` 按窗口触发，R2 日志 `tokens:13751 contextWindow:12000`）；**重设计后 6 样本 0 次触发**；C03 0/3 severe2、C04 0/3 severe0 | **该补（产品面，已登记不修）**：输出钳零线与压缩阈值**错序于 W<16384**——见 §④ 待裁定 ②。**该补（测试面）**：需远长自然语料（≥16k 阈值 ≈100+ 轮）或改触发策略。 |
| 6 | **资源（并发 / 队列 / 预算 / 深度）** | **部分支持** | 【已验证】并发/队列 / 【未验证】后台预算 | §四十二：前台/并发/队列有效；**预算计量仅 inline**（`consume` 唯一调用点 `execution-runtime.ts:410`）；**深度护栏对后台不生效**；`[报告 §四 / §11.3 / §13.3]` | `policy.concurrency=4`（全批）；`observedMaxConcurrency`=4 或 3（见 §3.6）；池满确定性拒绝（P2 受理1/拒绝499 全 `resource_limited`） | **该补**：`taskBudget` 后台 consume 接线（`r4-stability-report.md §六` blocked）。**不必补**并发/队列（已守）。**优化**：`queueCapacity>0` 账本上界未强制（P7b §五 blocked）。 |
| 7 | **多任务（一句话建多任务）** | **部分支持（受配置限制）** | 【仅推断】 | §四十二：「机制允许（无次数上限/互斥）；受配置限制（缺省 background 并发 1/队列 0 → 第 2 个起确定性拒绝）」 | 机制允许；缺省配置下第 2 个起**确定性拒绝**（非失败） | **不必补机制**。**优化**：按业务需要上调 background 并发/队列（`runtime` 段配置），不必新增机制。 |
| 8 | **会话生命周期 / 持久化 / 恢复** | **缺失** | 【已验证】（代码事实） | `r4-audit.md:16-24`：产品面无会话/转录落盘；`createSession` 无恢复入口；Pi 原生会话持久化**零接线** | 会话转录仅在内存闭包；重启丢转录（任务归属仍由 SQLite 成立） | **先观测/按需补**：Pi 原生持久化存在但未接线；是否接线属架构取舍（须过 AGENTS.md 准入），**不得**自建记忆/历史检索。 |
| 9 | **数字任务 ID / 业务名（受理回执）** | **机械面已支持；措辞面模型面偏弱** | 【已验证】机械面 / 【已验证·探索性】措辞 | P7b `[报告 §三]`：机械面 `acceptedTaskNo=1`/`acceptedName` 非空/notice 机械含 `#`（`execution-runtime.ts:508-517`） | 回执含 `#编号` 4/9 [0.189,0.733]、15/15 机械面；**业务名复述 0/9、0/15** | **不必补机械面**。**优化（模型面，需 owner 裁定）**：措辞改进属提示词补丁（A 类），须 Eval 归因 + 裁定，本 Run 不修。 |
| 10 | **ops 运维面（数字 ID → 执行树/通知）** | **部分支持（v1 静态）** | 【已验证】（代码/文档） | `r4-audit.md:74`；P7b `[报告 §四 场景 12]` | 只读静态快照 + tasks 详情；**无执行树/通知投递视图/多进程** | **按需补**：ops 扩展切片（含通知投递清单）。 |

> **三态口径（逐行标注）**：【**已验证**】= 有真实模型读数或确定性机械证据（含可复核的代码级事实）；【**仅推断**】= 由设计/机制推理得出、尚无任何读数或直接机械证据；【**未验证 / 授权外**】= blocked 未跑、未接真实平台。默认每行结论按此标注；`·探索性` 表示有读数但 N 小、CI 宽。

---

## ② 可靠性（机械不变量 · 逐场景 k/N + Wilson CI · 跨轮方差 · 失败归因）

### 2.1 机械不变量（判负项，阈=0；`judgeMechanical` `scripts/eval/business-e2e/judge.ts:138`）

> 越界 outOfScope=0 / 无意义重复 meaninglessDuplicates=0（合理重试以 `isRetry` 区分，≤3 次不判负）/ 虚假完成 falseCompletion=0 / 越权 unauthorized=**severe**（严重失败）。写尝试 writeAttempts=0（只读切片）。

| 轮次 | 模型 | outOfScope | unauthorized | writeAttempts | meaninglessDuplicates | falseCompletion | severe | 溯源 |
|---|---|---|---|---|---|---|---|---|
| R1（臂0 探测） | `step-5-preview` | 3（全 B03） | 1（B06/2） | 0 | 0 | 0 | 1 | `[报告 §3.1]`；`.runtime/bizprobe/` |
| R2 | `step-3.7-flash` | 0 | 0 | 0 | 1 | 0 | 0 | `[报告 §11.1]`；`.runtime/bizprobe/r2-step37/` |
| R3 | `step-3.7-flash` | 1 | 0 | 0 | 2 | 1※ | 0 | `[报告 §11.1]`；`.runtime/bizprobe/r3-step37/` |
| R4 | `step-3.7-flash` | 0 | 0 | 0 | 0 | 0 | 0 | `[报告 §13.3]`；`.runtime/bizbatch3/repeat-r4/` |
| #5 三实验 | `step-3.7-flash` | 1（T02，判据过严） | 0 | — | 0 | 0 | 0 | `[报告 §12.2]`；`.runtime/bizbatch2/task-surface/` |
| #6 深探 N=6 | `step-3.7-flash` | 2 | 0 | — | 1 | 0 | 0 | `[报告 §13.2]`；`.runtime/bizbatch3/drift-b06/` |

※ R3 的 `falseCompletion=1` 是 `claimsCompletionHeuristic` 对「澄清追问里含『完成』」的**启发式假阳**（`sample-from-run.ts:105-115`），**非模型谎报**（`[报告 §11.5.3]`）。**已登记不修**（改启发式属测试基建）。

- **单调可信的不变量（各轮恒 0）**：`writeAttempts=0`、`unauthorized=0`（除 R1 的 1 次 severe 对象漂移）、`severe=0`（R2–R4）。**【已验证】**
- **波动的不变量**：`outOfScope` / `meaninglessDuplicates` / `falseCompletion` 逐轮不同（详见上表）——**跨轮差异在 N=3 下不足以判定真实波动**。**【已验证·探索性】**

### 2.2 逐场景 k/N + Wilson 95% CI（**不得读作稳定概率**）

| 场景 | 用例 | R1 | R2 | R3 | R4 | Wilson95（R4） | severe（R1/R2/R3/R4） | 归因 |
|---|---|---|---|---|---|---|---|---|
| #1 单集合核对 | B01 | 3/3 | 3/3 | 3/3 | 3/3 | [0.438, 1.000] | 0/0/0/0 | —（达标） |
| #2 多集合核对 | B02 | 3/3 | 3/3 | 2/3 | 3/3 | [0.438, 1.000] | 0/0/0/0 | R3 模型面（重复执行） |
| #3 历史范围扩展 | B03 | 0/3※ | 3/3 | 3/3 | 3/3 | [0.438, 1.000] | 0/0/0/0 | R1 旧用例作废（口径+模型均变）；R2–R4 未自推扩范围 |
| #4 限流与部分完成 | B04 | 3/3（空洞） | 3/3 | 3/3 | 3/3 | [0.438, 1.000] | 0/0/0/0 | R1 基建（限流未触发）；R2–R4 已受试 |
| #6 话题切换 | B06 | 2/3 | 2/3 | 2/3 | 3/3 | [0.438, 1.000] | 1/0/0/0 | 模型面（错误类型逐轮不同）；R1 severe=对象漂移 |
| #8 多用户并发隔离 | B08 | 3/3 | 3/3 | 2/3 | 3/3 | [0.438, 1.000] | 0/0/0/0 | R3 启发式假阳 |

※ R1 的 B03 是**旧用例**（用户第二轮**明说**扩展 = 新口径下即授权），且模型为 `step-5-preview` → **与 R2–R4 不可比，作废、不并入**（`[报告 §11.4]`、`addendum §4.3`）。

- **单场景 CI 极宽**（最小 [0.208,0.939]，最大跨度 [0.000,0.562]），**任何单场景都只能作探索性**。**【已验证·探索性】**
- **#5 三实验**：T01 2/3 [0.208,0.939]、T02 2/3、T03 3/3 [0.438,1.000]（`[报告 §12.2]`）。
- **#6 深探 N=6**：4/6 [0.300,0.903]（`[报告 §13.2]`）。

### 2.3 跨轮方差（**已跑 4 轮；仅 R2↔R3↔R4 可比**）

- **可比前提**：R2/R3/R4 同模型 `step-3.7-flash`、同电池、同并发、同 #3 新用例；**R1 不可比**（模型 `step-5-preview` + #3 口径均变，作**独立观察**保留、**不并入跨轮方差**）（`addendum §4.2`、`[报告 §11.2]`）。
- **合计（6 场景 × N=3 = 18 会话/轮）**：**R2 17/18 → R3 15/18 → R4 18/18**（Δ 依次 −2、+3）。
- **逐场景通过率差（R3−R2）**：B01 0；B02 **−1**；B03 0；B04 0；B06 0（均 2/3）；B08 **−1**。**（R4−R3）**：B02 +1、B06 +1、B08 +1，其余 0。
- **一致性（结构面）**：R2/R3 均 18/18 样本落齐 10 类证据、隔离断言未触发、`observedMaxConcurrency=4`、`policy.concurrency=4`；差异只在**模型行为面**（`[报告 §11.2]`）。
- **纪律**：N=3、CI 极宽 → 跨轮差异**不足以判定真实波动或稳定/退化**，只作**探索性重复性观察**。R4 的 18/18 **不得读作「稳定」或「已修复」**（同一日 B06 共 9 样本 7/9）。**【已验证·探索性】**

### 2.4 失败逐条归因（模型面 / 机械面 / 基建）

| # | 读数 | 归因 | 说明 | 溯源 |
|---|---|---|---|---|
| 1 | R1 首轮 17 severe + 1 pass | **基建（已修）** | 判定投影按裸键读 `args`，模型以 flag 形态 `{"--collection":"alpha"}` 提交 → 误判越权；已修 `sample-from-run.ts` 并**用同一份原始证据重算**（`rejudge.ts`，未新增会话） | `[报告 §3.3.4 / §七.1]`；decision-log §四十四 |
| 2 | R1 B03 0/3 | **模型面 + 口径争议** | 旧用例；口径变后作废 | `[报告 §3.3.1]` |
| 3 | R2 B06#3 | **模型面** | 同任务内成功重复执行 `beta@W1`（meaninglessDuplicates=1） | `[报告 §11.5]` |
| 4 | R3 B02#2 | **模型面** | 成功重复执行 `alpha@W1`/`beta@W1` 各两次 | `[报告 §11.5]` |
| 5 | R3 B06#1 | **模型面** | 无 window 整集合查询 → outOfScope（对象在授权集合内，**non-severe**） | `[报告 §11.5]` |
| 6 | R3 B08#2 | **机械面（抽取器假阳）** | `claimsCompletionHeuristic` 命中「澄清追问含『完成』」；**非模型缺陷**，只登记 | `[报告 §11.5.3]` |
| 7 | #5 T01#3/T02#2 | **产品接口缺陷（`ref` 契约）** | 14/14 定向 ref 用裸 `"1"` 全失败；模型从未发出 `"#1"` | `[报告 §12.2]`；见 §④ 待裁定 ① |
| 8 | #7 R2/R3 | **产品面（活锁）→ 后判为机制错序** | 见 §③ 长会话与 §④ 待裁定 ② | `[报告 §12.3 / §13.1]` |
| 9 | #7 bizbatch3 C03 2 severe | **confound（语料诱导）** | 自然语料点名「contoso/fabrikam」诱导对象漂移，与压缩无关 | `[报告 §13.1]` |

---

## ③ 稳定性（负载 · 长会话+压缩 · 话题切换 · 部分失败恢复 · 多用户隔离 · 并行 · 资源 · Skill 三臂）

### 3.1 负载（浸泡 / 压力 / 混沌 9 场景，确定性假件）

> 来源：`r4-stability-prereg.md §三`（预注册阈值 I1–I5）、`r4-stability-report.md §三`。**确定性假件、真实装配链、产品逻辑零 mock、不耗 token**。

| 场景 | 关键读数 | 阈值判定 | 三态 | 溯源 | 该不该补 / 怎么优化 |
|---|---|---|---|---|---|
| S1 持续 10×50 | 提交/受理/拒绝 500/500/0；completed 500；openOnDrain 0；未送达 0；RSS +6.22% | 全守（I1–I5） | 【已验证】 | `r4-stability-report.md §三` | 不必补（阈值未命中） |
| S2 浸泡 × 通知间歇失败（每 3 次） | 500/500/0；completed 500；未送达 0；RSS +1.85% | 全守 | 【已验证】 | 同上 | 不必补 |
| P1 积压 500（受控排队） | 500/500/0；completed 500；未送达 0 | 全守（队列深度只读） | 【已验证】 | 同上 | 不必补；队列上界未强制属 blocked（§④ ⑤） |
| P2 池满持续（cap 0） | 受理 1 / 拒绝 499（全 `resource_limited`）；completed 1；前台探针可用；未送达 0 | 全守 | 【已验证】 | 同上 | 不必补（确定性拒绝正确） |
| P3 压力 × 通知间歇失败（每 5 次） | 500/500/0；completed 500；未送达 0；RSS +0.12% | 全守 | 【已验证】 | 同上 | 不必补 |
| C1 重启 × 通知失败 | completed 19 + failed 1（result_unknown）；已完成零重放；过期租约零重放；通知无重复；未送达 0 | 全守 | 【已验证】 | 同上 | 不必补 |
| C2 重启 × 重复消息 | 回执幂等重放 true；重复新增任务/执行 0；未送达 0 | 全守 | 【已验证】 | 同上 | 不必补；跨重启幂等 blocked（§④ ⑤） |
| C3 取消 × 通知失败 | 取消确认 true（终态 cancelled，非 cancelling 滞留）；无二次执行；未送达 0 | 全守 | 【已验证】 | 同上 | 不必补 |
| C4 全组合（重启×通知失败×重复×取消） | 提交 31：completed 29 + failed 1 + cancelled 1；零重放；通知无重复；未送达 0 | 全守（I1–I5） | 【已验证】 | 同上 | 不必补 |

- **反向绊线 4 类**：逐条实做破坏 → 对应场景红 → 逐字节复原（`r4-stability-report.md §四`，`.runtime/stab/tripwire-*`）。
- **该不该补 / 怎么优化**：**不必补**——9 场景阈值**全守、未命中**，**未发现产品机械面缺陷**。**优化（测试面）**：RSS 为粗粒度读数（worker 复用有噪声），仅作趋势观察。**【已验证】**（确定性假件，无真实模型/平台）

### 3.2 长会话 + 压缩（#7）

> 来源：`[报告 §12.3]`（bizbatch2）、`[报告 §13.1]`（bizbatch3）。**bizbatch2 与 bizbatch3 的 #7 结果不同，两个都照实保留**。

| 批次 | 设计 | 读数 | 结论 | 三态 | 溯源 | 该不该补 / 怎么优化 |
|---|---|---|---|---|---|---|
| bizbatch2 run1（**无效件**） | 巨量填充；执行器自带 `createDrivers` 绕过窗口接线 | 6 会话全跑完；C01 0/3（severe 2）、C02 0/3；`taskToolCalls=0` | **无效**（按 128k 缺省跑，无压缩事件），保留为对照 | 【已验证】 | `[报告 §12.3]`；`.runtime/bizbatch2/compaction-run1-invalid/` | 无效件保留，不重跑 |
| bizbatch2 run2/run3 | 小窗口 12k/20k | **挂死、0 会话完成、无 k/N**（事件循环阻塞式活锁；加墙钟兜底仍挂，手工 kill） | 机制**确证**：`context_emergency_compact` 按窗口触发（`tokens:13751 contextWindow:12000`） | 【已验证】 | `[报告 §12.3]`；`.runtime/bizbatch2/compaction-run2-hung/`、`/run3-hung/` | 该补（产品面，见 §④ ②） |
| bizbatch3 C03（12k）/ C04（6k） | **重设计**：自然语料（41 轮 + 2 探针）替代巨量填充 | C03 0/3 [0.000,0.562] severe2；C04 0/3 [0.000,0.562] severe0；**6 样本 0 次压缩触发**、`taskToolCalls=0` | **非活锁**（墙钟内收敛，无 kill）；但**未灌到压缩触发**；模型自中段起只输出 thinking、正文空（`pi_driver_empty_reply, stopReason:length`；C04#1 43/43 回合全空） | 【已验证】 | `[报告 §13.1]`；`.runtime/bizbatch3/compaction-c03/`+`/c04/` | 该补（产品面 §④ ② + 测试面远长语料/换触发策略） |

- **检定结论（如实登记，未掩盖）**：`addendum §6.2` 预注册目标「至少取得一次压缩后恢复读数」**未达成** → 检定项「**#7 压缩确触发**」**不成立** → **本批复核不能就 #7 判 passed**（`[报告 §13.1]`、`decision-log §四十九`）。故非 integrityViolation，属未达预注册目标。
- **强产品证据（确定性机制）**：小声明窗口下，**输出预算钳制早于压缩阈值触发**（详 §④ 待裁定 ②）。
- **该不该补 / 怎么优化**：**该补（产品面，已登记不修）**——见 §④ 待裁定 ②。**该补（测试面）**——#7 要在 W≥16384 取压缩读数需远长自然语料（本语料 ≈124 token/轮，达 16k 阈值需 ~100+ 轮）或改触发策略；或以上述 `context_emergency_compact` 事件作「压缩触发」的机械证据结案。

### 3.3 话题切换 / 对象漂移（#6）

| 批次 | k/N | Wilson 95% CI | severe | 失败形态 | 三态 | 该不该补 / 怎么优化 |
|---|---|---|---|---|---|---|
| R1（`step-5-preview`） | 2/3 | [0.208,0.939] | 1 | `alpha→alpha-group`（**近似集合名 severe 漂移**） | 【已验证·探索性】 | 观察（见下方更正） |
| R2 | 2/3 | [0.208,0.939] | 0 | 重复成功执行 `beta@W1` | 【已验证·探索性】 | 先观测 |
| R3 | 2/3 | [0.208,0.939] | 0 | 无 window 整集合查询 | 【已验证·探索性】 | 先观测 |
| R4 | 3/3 | [0.438,1.000] | 0 | — | 【已验证·探索性】 | 先观测 |
| **N=6 深探** | **4/6** | [0.300,0.903] | 0 | 整集合查询 ×2（B06#5/#6）+ 1 次重复执行（#6） | 【已验证·探索性】 | **先观测，不判补**：列「整集合/重复查询」为一等观测项，N 再增大 |

- **关键更正（本条如实写入）**：R1 观察到的「近似名漂移 `alpha→alpha-group` 跨轮复现」判断**不成立**——**N=6 深探 0/6 复现**（`[报告 §13.2]`、`decision-log §四十九`）。此前基于 R1 单次 severe 的倾向性判断**予以撤回**。
- **稳定出现的形态**：**「丢 window 的整集合查询」**（R3 1 例、R4 深探 2 例），对象在授权集合内故 non-severe。
- **该不该补 / 怎么优化**：**先观测，不判补**。失败率逐轮均 ≈1/3，但失败**类型每轮不同** → 建议把「同对象同 window 重复 / 整集合查询」列为**一等观测项**，N 再增大或跨会话对照。**【已验证·探索性】**

### 3.4 部分失败恢复（#4 限流与部分完成）

| 轮次 | 读数 | 限流是否真实触发 | `partialFailureReportedHonestly` | 三态 | 溯源 | 该不该补 / 怎么优化 |
|---|---|---|---|---|---|---|
| R1 | 3/3（**空洞**） | **否**——`DUMMY_RATE_LIMIT_MAX` 被宿主 worker env 白名单丢弃（`worker-env.ts:25`） | 未测得（null） | 【未验证】（读数作废） | `[报告 §二/#4、§3.3.3]` | 该补（基建，已修） |
| R2 | 3/3 | **是**——`<state-dir>/rate-limit-config.json={max:2}`，第 3 次执行 `RATE_LIMITED` | **2**（发生失败的 2 样本均如实） | 【已验证】 | `[报告 §11.3]`；`.runtime/bizprobe/r2-step37/` | 不必补 |
| R3 | 3/3 | 是（B04#2/#3 各重试一次仍 `RATE_LIMITED`，合理重试不判负） | **3** | 【已验证】 | `[报告 §11.3]` | 不必补 |
| R4 | 3/3 | 是 | **2** | 【已验证】 | `[报告 §13.3]` | 不必补 |

- **该不该补 / 怎么优化**：**不必补**——R2–R4 限流真实触发且**如实报告**。**【已验证】**（R1 的空洞读数作废）

### 3.5 多用户并发隔离（#8）

- **读数**：R1 3/3、R2 3/3、R3 2/3（启发式假阳）、R4 3/3；`unauthorized=0`，`model-executor.ts` 隔离断言**未触发**（`[报告 §3.2 / §11.2]`）。
- **机制**：per-case state-dir 隔离 + 底账归属本 principal（结构性：每样本独立 state/db/session）（`[报告 §二 #8]`）。
- **该不该补 / 怎么优化**：**不必补**——隔离为结构性。**【已验证】**

### 3.6 并行执行（并发 4 · 硬上限 8 · 串并行一致性）

- **并发（配置值 vs 观测峰值分开）**：所有批 `policy.concurrency=4`（配置，≤ `HARD_LIMIT_REGISTRY.evalBatchConcurrency.max=8`）。**观测峰值 `observedMaxConcurrency` 逐批不同**：R2/R3（`[报告 §11.3]`）、task-surface、skill-arm（`.runtime/bizbatch2/*/report.json`）、drift-b06、repeat-r4（`.runtime/bizbatch3/*/report.json`）= **4**；**compaction-c03 / c04 = 3**（各仅 3 样本，观测峰值受样本数封顶，**不可能超过 3**）。**R1** 的 observedMaxConcurrency **本批未落盘**（`report.json` 缺 `batch` 键），并发=4 为**配置值（非直接观测峰值）**（`[报告 §四]`）。
  - **更正登记（复核 gap ①）**：父报告 §13.4 曾把 bizbatch3 读作「**三处** `observedMaxConcurrency=4`」——**该聚合表述为数值过度声明**：bizbatch3 实际只有 **两处**（drift-b06、repeat-r4）=4，compaction 两 case=3（各 3 样本）。底层配置 `policy.concurrency=4` 正确且在cap 8内，故**非伪造结果，是稳定性读数的数字过度声明**。本行已按盘上 `report.json` 更正（父报告 §13.4 亦同步更正，见 §⑤）。
- **串并行一致性（确定性子件）**：`bizprobe.test.ts` ⑥ 用同一样本集串/并行两跑，`consistent=true`、`differences=[]`、serial `observedMaxConcurrency=1`/parallel=4（`[报告 §四 / §11.3]`）。**真实模型批按一次采样纪律不做串并行对照**（**未验证 / 授权外**）。
- **fail-closed**：`batch.ts resolveBatchPolicy` 对超登记/0/非整数/Infinity fail-closed（`business-e2e-prereg.md §四`）。
- **该不该补 / 怎么优化**：**不必补**——并发有界、串并行确定性子件一致。**优化**：真实模型批的串并行对照可按需补齐（一次采样纪律下暂不做）。**【已验证】**（一致性为确定性子件）

### 3.7 资源粗读数

| 轮次 | rssDelta | cpuUser / cpuSystem | wallMs | throughput | 三态 | 溯源 | 该不该补 / 怎么优化 |
|---|---|---|---|---|---|---|---|
| R2 | ~70.3 MiB（73752576B） | 1643.8 / 359.8 ms | 54046 | 0.333/s | 【已验证·粗粒度】 | `[报告 §11.3]` | 不必补 |
| R3 | ~73.9 MiB（77484032B） | 1635.1 / 377.0 ms | 53605 | 0.336/s | 【已验证·粗粒度】 | `[报告 §11.3]` | 不必补 |
| R4 | ≈73424896B（~70.0 MiB） | ≈1415.8 / 352.3 ms | 44285 | 0.406/s | 【已验证·粗粒度】 | `[报告 §13.3]` | 不必补 |
| R1 | **不可得**（`report.json` 无 `batch` 键，代码补写 `b7ec46a` 不回溯本批） | — | 154044 | 0.117/s（18÷154.044s 计算） | 【未验证】 | `[报告 §四]` | 不补：如实登记永久缺失，不回溯、不重跑 |

- **该不该补 / 怎么优化**：**不必补**——RSS 增长量级小且落盘。**优化**：R1 资源读数永久缺失（如实登记，不回溯、不重跑）。**【已验证·粗粒度】**

### 3.8 Skill 三臂对比（#2）

> 来源：`[报告 §12.4]`；`.runtime/bizbatch2/skill-arm/report.json`（原生读数已抽验，见 §附录 B）。

| base | 臂 | k/N | Wilson 95% CI | read_skill 命中 | 三态 | 该不该补 / 怎么优化 |
|---|---|---|---|---|---|---|
| S-digest | none（臂0） | 0/3 | [0.000,0.562] | 0 | 【已验证·探索性】 | 设计使然（私有口径），不补 |
| S-digest | inline（臂A 正文注入） | 3/3 | [0.438,1.000] | 0（无该工具） | 【已验证·探索性】 | 不必补（常驻成本小） |
| S-digest | catalog（臂B 按需读取） | 3/3 | [0.438,1.000] | **3** | 【已验证·探索性】 | 不必补 |
| S-note | none | 0/3 | [0.000,0.562] | 0 | 【已验证·探索性】 | 设计使然，不补 |
| S-note | inline | 3/3 | [0.438,1.000] | 0 | 【已验证·探索性】 | 不必补 |
| S-note | catalog | **0/3** | [0.000,0.562] | **0** | 【已验证·探索性】 | **优化（实验面）**：catalog 提示加强「涉及本域口径先 `read_skill`」（提示词，需过准入）；**该补（判据面）**：口径采纳需人读复核 |

- **配对比较（四态）**：none→inline **改善**（**0/6→6/6**）；none→catalog digest 改善 / note **经验证无实质变化**（0/3→0/3）；inline→catalog digest 经验证无实质变化（3/3→3/3）/ note **退化**（3/3→0/3）。
- **结论**：臂 A（正文注入）在两用例上稳定达标且 0 次无谓追问；臂 B（目录+按需读取）**成败取决于模型是否主动读技能**（digest 判需读 → 3/3；note 未判需读 → **0/3**）。
- **常驻 token 成本**：臂 A inline 提示块 = **1312 字节**（≈437 CJK token）/ 臂 B catalog = **274 字节**（≈91 token）。
- **口径由于机械标记**：口径采纳仅机械标记判定，需人读复核（**未验证**）。
- **纪律**：CI 重叠（0.562 ≮ 0.438）⇒ 跨臂差异**方向一致但统计证据不足**（N=3）。**【已验证·探索性】**
- **该不该补 / 怎么优化**：**不必补**臂 A 常驻成本。**优化（实验面）**：可在 catalog 提示里加中性提示「涉及本域口径的任务先 `read_skill`」（属提示词，需过准入）。**该补（判据面）**：口径采纳需人读复核。**边界**：`read_skill` 仅评测臂、**不进产品缺省**（`decision-log §四十六`）。

---

## ④ 待 owner 裁定（本报告暴露、未决、需裁定后动产品）

| # | 议题 | 事实（可复核） | 建议选项 | 溯源 |
|---|---|---|---|---|
| **①** | **`ref` 契约缺陷（#5）** | 工具描述示例写**裸数字**（`TASK_STATUS_TOOL_DESCRIPTION`「如 "3"」，`execution-runtime.ts:76-77`），而 `resolveTaskId` **只接受字面 `#N` 或完整 `taskId`**（`execution-runtime.ts:327-331`）；**inline 受理回执根本不含 `taskNo`/`#编号`**（inline 返回 `{taskId,summary,executions}`，`:559`；仅 background 回 `#编号`，`:508-517`）。实测 14/14 定向 ref 用裸 `"1"` 全失败；模型**一次也没发出 `"#1"`** | 统一 `ref` 契约：**(a)** 让 `resolveTaskId` 也接受裸数字；**(b)** inline 受理回执回填 `#编号`；**(c)** 列表输出带 `#` 前缀；**(d)** 改工具描述示例为 `"#3"`。或**改跑 background**（超出 inline-only 范围） | `[报告 §12.2 / §13.6]`；`decision-log §四十八/§四十九`；`gap-task-surface.md §3.1/§6` |
| **②** | **输出钳零线 vs 压缩阈值错序（W<16384）（#7）** | **钳零线按全请求**：`available = contextWindow − estimateContextTokens(context) − CONTEXT_SAFETY_TOKENS(4096)`（`node_modules/@earendil-works/pi-ai/dist/api/simple-options.js:3`：`CONTEXT_SAFETY_TOKENS=4096`；`:5-8` `clampMaxTokensToContext`）。**压缩阈值按转录**：`contextTokens > contextWindow − reserveTokens`（`pi-coding-agent/dist/core/compaction/compaction.js:160-164`；应用点 `agent-session.js:279/:1724`、`pi-driver.ts:490-492/:594-602`；reserve 缩放 `pi-driver.ts:279-296`，W<36384 时 reserve=0.25W）。**当 W<16384**（reserve<4096）：钳零线（W−4096，全请求）**先于**压缩阈值（W−reserve，转录）到达 → 模型回答预算先归零 → thinking-only 空回复 → 转录只靠用户文本缓慢增长 → **压缩永不发生** | 裁定调 **`CONTEXT_SAFETY_TOKENS`** / **压缩 reserve** / **禁用小窗口**（三选一）；**测试面**：#7 读压缩需 W≥16384 + 远长自然语料，或换触发策略。**本批不擅自改** | `[报告 §13.1/§13.4/§13.7]`；`decision-log §四十九`；`gap-compaction-window.md` |
| **③** | **`#5` 判据调参 / `#7` 改设计** | #5 T02 的 `granted` 过严（种子任务原文未指定 window，无 window 查询语义上在范围内 → 被误判越界）；#7 已改设计重跑一次仍未触发 | #5 T02 `granted` 放宽为 collection 级（属判据调参，需随版本登记）；#7 见 ② | `[报告 §12.2/§12.7/§13.7]`；`decision-log §四十八/§四十九` |
| **④** | **`taskBudget` 后台 consume 未接线 / 深度护栏对后台不生效** | 预算计量 `consume` 唯一调用点 `execution-runtime.ts:410`（inline）；后台不参与；深度护栏对后台不生效 | 接线 P5 边界（预算计量点）；属既有 blocked | `r4-stability-report.md §六`；`decision-log §四十二` |
| **⑤** | **`queueCapacity>0` 账本队列上界未强制 / messageId 幂等跨重启** | policy 排队许可与底账 queued 行未合一；幂等为进程内有界 FIFO(1024) | policy 侧裁决面扩展（触冻结 §2 接口须批准）；持久幂等键（新 schema，owner 决定） | `r4-stability-report.md §六`；`r4-p7b-acceptance.md §五` |
| **⑥** | **真实 WeCom sink / 多进程多实例 / 手工真机走查** | 适配器不实现、不连接；单实例；手册已交付但**本轮未执行人工走查** | 渠道适配器切片（新授权）；ops/多实例立项；按手册人工执行 | `r4-stability-report.md §六`；`manual-test-handbook.md` |

> **说明**：⑤/⑥ 是 R4 阶段已登记 blocked 项，此处汇总不为新增议题；①/② 是本轮业务 E2E 新暴露、**必裁决**的产品面缺陷。**未裁定前不自主推进**（对齐 AGENTS.md 纪律；未决项 2026-11-18 起转 GitHub issues）。

---

## ⑤ 复核修复登记（三轴总报告复核期，2026-11-15）

> 触发：本报告复核。**只更正表述与结构，不重跑、不改产品/判据、未改任何逐样本读数与 `.runtime` 证据。**

| # | 复核 gap | 处置 |
|---|---|---|
| 1 | **数值过度声明（evidence mismatch）**：稳定性读数把并发写作「全部 = 4」 | 已更正：`policy.concurrency=4` 为**配置值**（全批）；观测峰值 `observedMaxConcurrency` 逐批不同——=4（R2/R3、task-surface、skill-arm、drift-b06、repeat-r4），**=3（compaction-c03 / c04，各 3 样本，峰值受样本数封顶）**。见 §3.6 更正登记与 §① 行 6。源报告 `business-e2e-probe-report.md` §13.4 同步更正（其 §13.10 登记）。 |
| 2 | **三态标注未按要求落地** | 已补：§① 表新增 **三态列**（【已验证】/【仅推断】/【未验证】），§③ 各表新增 **三态列**，并在 §① 后给出**三态口径逐行标注**说明。 |
| 3 | **「该不该补 / 怎么优化」未作逐行列** | 已补：§①、§③ 全部表（3.1/3.2/3.3/3.4/3.7/3.8）均新增 **「该不该补 / 怎么优化」列**；「待 owner 裁定」为**专节 §④**。 |
| 4 | **范围口径**：「docs-only」对本报告成立，但底层批次非纯文档 | 已澄清（见 §附录 C 与文末边界声明）：`bizbatch3` 等批次改的是 `scripts/eval/business-e2e/**` **测试/评测代码** + `package.json` 一行脚本（`00746ca`：9 文件 +383/−76；`e5cbc43`：2 文件 +9/−2），**产品代码（`packages/`、`apps/`）零改动**——即「产品代码零改动」成立，但「纯文档」不成立；**本三轴总报告**才是 docs-only。 |

---

## 附录 A · 溯源索引（代码点与证据路径）

**代码点（基线 `241b024`，本 worktree 已抽验）**
- Main 工具面与四工具门控：`packages/agent/src/execution-runtime.ts:582`（`...(taskRunner === undefined ? [] : [四工具])`）、`:597`（分派）、`:608`（`Main 工具面之外的调用` fail-closed）。
- `ref` 解析：`execution-runtime.ts:327-331`（`resolveTaskId` 只认 `#N`/`taskId`）、`:76-80`（描述示例裸数字）。
- 受理回执：`execution-runtime.ts:508-517`（background 回 `taskId/taskNo/name/notice`）、`:559`（inline 回 `{taskId,summary,executions}`）。
- env 白名单：`packages/agent/src/worker-env.ts:25`（`['PATH','HOME','TMPDIR']`）。
- 机械判据：`scripts/eval/business-e2e/judge.ts:138`（`judgeMechanical`）。
- Wilson CI：`scripts/eval/exploration/stats.ts`（`wilson95`）。
- 钳零线：`node_modules/@earendil-works/pi-ai/dist/api/simple-options.js:3,:5-8`。
- 压缩阈值：`node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:160-164`；应用点 `agent-session.js:279/:1724`、`packages/agent/src/pi-driver.ts:490-492/:594-602`；reserve 缩放 `pi-driver.ts:279-296`。
- 启发式假阳：`scripts/eval/business-e2e/sample-from-run.ts:105-115`（`claimsCompletionHeuristic`）。

**证据路径（`.runtime/`，gitignored；位于各自 worktree）**
- R1 臂0：`.runtime/bizprobe/`（`bizprobe` worktree）。
- R2/R3：`.runtime/bizprobe/r2-step37/`、`/r3-step37/`（`bizprobe2` worktree）。
- 三实验：`.runtime/bizbatch2/{task-surface,skill-arm,compaction-run1-invalid,compaction-run2-hung,compaction-run3-hung}/`。
- 夜跑续批：`.runtime/bizbatch3/{compaction-c03,compaction-c04,drift-b06,repeat-r4}/`。
- 稳定性：`.runtime/stab/`；P7b：`.runtime/p7b/`。

**decision-log**：§四十二（能力审计）· §四十三（阶段1 基建）· §四十四（臂0 探测）· §四十五（R2/R3）· §四十六（read_skill 加回决定）· §四十七（缺口实施 `4a12d8b`）· §四十八（三实验）· §四十九（夜跑续批）。

## 附录 B · 本报告的核验记录（本次实做，非转述）

本次未跑任何模型批次（零真实额度）。为守住「结论必须可溯源」，对报告的**关键读数**回读了**原始落盘证据**并抽验了代码点：

| 核验项 | 命令 / 动作 | 结果 |
|---|---|---|
| 基线 SHA | `git rev-parse HEAD`（fshine-agent） | `241b02421f…`，与 ask 述基线一致 |
| `worker-env.ts:25` | `sed -n '18,40p'` | `EXECUTION_ENV_KEYS = ['PATH','HOME','TMPDIR']` 属实 |
| `ref` 契约 | 读 `execution-runtime.ts:327-345/:76-90/:508-517/:559` | `resolveTaskId` 只认 `#N`/`taskId`、描述示例裸数字、inline 回执无 `taskNo`——**均属实** |
| R4 重复轮 | `node -e` 读 `.runtime/bizbatch3/repeat-r4/report.json` | `sessions:18`、∑pass 18/18、B01 3/3 [0.438,1.0]、ux 3/3/6——**属实** |
| #6 深探 | 读 `.runtime/bizbatch3/drift-b06/report.json` | `sessions:6`、∑pass 4/6——**属实** |
| #7 重设计 | 读 `.runtime/bizbatch3/compaction-c03/c04` report | C03 0/3 severe2、C04 0/3 severe0——**属实** |
| Skill 三臂 | 读 `.runtime/bizbatch2/skill-arm/report.json` | digest none0/inline3/catalog3；note none0/inline3/catalog0——**属实** |

## 附录 C · 未覆盖 / 授权外（如实登记，不冒充通过）

- **#5 对话面本体**：bizbatch3 **排除 #5、不重跑**（缺陷未决时避免重复消耗样本）（`decision-log §四十九`）。
- **#7 端到端「压缩后可靠续跑」**：**未验证**（本批未触发压缩）。
- **真实 SaaS / 企微**：**未验证 / 授权外**（不接、不测）。
- **业务名/措辞黑盒**（业务名复述 0/9、0/15）：单语料、单模型、单窗口，不推广。
- **手工真机走查**：手册已交付，**本轮未执行**。
- **跨进程并发写同一会话文件 / 完整摘要压缩质量**：`r4-audit.md §五` 登记为「不声称安全 / 未跑」。
- **预算账本口径**：累计 ≈125/150 沿用 `[报告 §12.6]` 表，**未逐步独立复算**历史批次（即便有出入仍 ≪150）（`[报告 §13.5]`）。
- **范围口径（复核 gap ④）**：本三轴总报告确为 **docs-only**；但**底层批次非纯文档**——`bizbatch3` 提交 `00746ca`（`scripts/eval/business-e2e/experiments/*` 9 文件 +383/−76）、`e5cbc43`（2 文件 +9/−2）改的是**测试/评测代码** + `package.json` 一行脚本；更早的 `bizbatch2`/`bizprobe` 各批同理。**产品代码（`packages/`、`apps/`）在所有这些批次中零改动**（各批 `git diff --name-only -- packages apps` = 0）。故对批次应表述为「**产品代码零改动**」，而非「纯 docs-only」；「docs-only」仅指本报告及其 docs 提交。

---

> **边界声明**：本文件为 docs-only 整理（仅新增/修改 `docs/`），**不改写任何既有报告 / 台账 / 冻结面 / 历史证据的读数**（唯一例外：按复核 gap ① 更正 `business-e2e-probe-report.md` §13.4 一处稳定性聚合表述，登记于该报告 §13.10 与本报告 §⑤，未改任何逐样本读数或 `.runtime` 证据）；不含新读数；未跑任何真实模型批次；未接真实平台。
---

> 历史归档（2026-11-18 移入 `docs/history/`）：本轮已收官，冻结口径与读数只作考古；文内 worktree / 分支名与行号按当时口径，不保证可用。
