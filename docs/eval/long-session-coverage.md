# 长会话评测 · 轨道覆盖与判据台账（LS1–LS6）

- 状态：2026-11-18 补全（eval/long-session-ls6）。本文件**只描述测试面**：哪条轨测什么、
  判据来自哪个模块、已知盲区在哪、怎么跑。质量结论仍只由真实模型会话产生
  （`docs/eval/long-session-prereg.md` §〇.1），本文件不承载任何「通过/稳定」结论。
- 代码位置：`scripts/eval/long-session/`。语料与逐轮期望 = `load-generator.ts`；
  判定 = `oracle.ts`（事实/任务）、`compaction.ts`（压缩生命周期）、`harness.ts`
  （`judgeTurnExpectations`，轮期望）；证据/三态 = `evidence.ts`；真实会话适配 = `real-session.ts`；
  批执行 = `wave1-runner.ts` + `wave1-support.ts`。

## 一、六轨覆盖

| 轨 | 场景 | 轮次构成 | 主判据 | 判据来源 |
|---|---|---|---|---|
| **LS1** | 长期事实保留（压缩后追问） | 3 建立轮 + F1–F8 事实轮（8） | 事实 Oracle 全对才通过（会话级聚合） | `oracle.ts` `judgeFactAnswer` / `judgeSessionFacts`（`FACT_TRUTH`） |
| **LS2** | 业务任务连续性（五态/编号/结果） | 3 建立轮 + 6 任务轮 | Task Registry 快照：H3 重复执行 / H4 虚假完成 / H5 取消假回执 / E-G 编号混淆 | `oracle.ts` `judgeTaskContinuity` |
| **LS3** | 自然语言连续交互 | 3 建立轮 + NL1–NL10 | 事实 Oracle（NL2/3/4/5/7/9/10）+ 任务状态（NL9）+ 不得新建任务（NL8）；NL1/NL6 仍由硬零/事实链路兜底 | `load-generator.ts` `ls3Turns` + `harness.ts` `judgeTurnExpectations` |
| **LS4** | Pi 原生压缩生命周期 | 3 建立轮 + 压缩后复查探针 | CMP1–CMP9 / H6（零收益循环、单回合调用越界）；压缩后事实复述 | `compaction.ts` + `oracle.ts` |
| **LS5** | 长稳/多会话并行 | 3 建立轮 + 推进轮 + 稳态轮（6） | H7 跨会话污染 + 资源读数 + 压缩生命周期 | `wave1-runner.ts`（H7 标记扫描/资源采样） |
| **LS6** | 自然交互扰动（交错/改口径/真间隔/反悔/自我更正/三档取消） | 13 轮：N1-A..N6-C | 任务账本行数与状态、`execute_operation` 审计行、事实 Oracle、回复负向检查、取消诚实性 | `load-generator.ts` `ls6Turns` + `harness.ts` `judgeTurnExpectations` |

### LS6 逐轮判据（新增）

| 场景 | 轮 | 机械判据 |
|---|---|---|
| N1 真交错 | N1-A / N1-B | `expectNewTask`：两轮各出现新 `taskId`；两轮 `deferIdle`（`sendNoWait`，受理即返回）——B 在 A 仍在执行时插入 |
| | N1-C | 先 `waitIdle` 收尾，再判 `expectNoNewTask` + `expectTaskStatusIn{oldest: completed}` + 事实 alpha 2 条/2000（对象不串台） |
| N2 改口径后回头 | N2-A | `expectExecutionObjects:['beta']`（执行审计行对象=beta；background 派发下该轮回复天然是「已受理」，**不以回复事实判定**） |
| | N2-B | `expectNoExecution` + `expectNoNewTask` + 事实 beta 3 条/1000 + `replyExcludes:['2000']`（不再报 alpha 结论） |
| N3 真间隔暂停 | N3-A | `expectNoNewTask` + `expectNoExecution` + `expectPrevTasksUnchanged` |
| | N3-B | `gapMs: 1500`（harness 真 `setTimeout`）+ 上述三条（状态保持、不重复执行） |
| N4 反悔重做 | N4 | `expectNewTask`（taskId 与旧的不同）+ `expectPrevTasksUnchanged`（旧任务仍 completed） |
| N5 自我更正 | N5-A | `expectNoNewTask`（用户的事实断言不触发建任务） |
| | N5-B | 事实 alpha 2 条/2000 + `replyExcludes:['3条','三条']`（不得沿用 3 条） |
| N6 三档取消 | N6-Q1 | `expectNewTask` + `deferIdle`（受理即返回，任务留在飞）；Q1 取大载荷 `r6-load-a`，保证在飞窗口稳定存在 |
| | N6-Q2 | `deferIdle` + `settleBeforeJudge`：在飞时发出取消，落定后判 `expectInflightCancel`（目标任务必须真 `cancelled`；若取消到达时已完成，回执目标须是同一任务且回复不得声称已取消） |
| | N6-C | `expectPrevTasksUnchanged` + `expectTaskStatusIn{oldest: completed}` + `expectCancelHonest`（`cancelTarget: 'oldest'`，已完成任务拒绝取消、状态不变、不得声称取消） |

> LS6 是**时间线轨**：`scriptFor('LS6')` 的 `plan` 就是这 13 轮完整序列（不是「3 个建立轮 +
> 压缩后探针」），压缩后复查轮另取 N2-B / N4 / N5-B。否则交错/改口径/暂停/反悔/更正/取消所需的
> 上下文根本不存在（2026-11-18 冒烟前发现并修正，`wave1-support.test.ts` 已钉住）。

## 二、轮期望的判定口径（`harness.ts` `judgeTurnExpectations`）

全部只看会话面机械事实，不看模型自述；判负复用既有失败码（预注册 §2.3），不新造语义重复码：

| 检查 | 事实来源 | 判负码 | 说明 |
|---|---|---|---|
| `fact`（任何 kind） | 回复文本 vs `FACT_TRUTH` | E-A / E-B / E-F / E-INCONCLUSIVE | 与事实轮同一套 `judgeFactAnswer`，interaction 轮不再豁免 |
| `expectNoNewTask` / `expectNewTask` | `tasks()` 轮前后快照（行数 + taskId 差集） | E-D | 控制意图失败 |
| `expectNoExecution` / `expectExecutionObjects` | 该轮 `execute_operation` 审计行（`executionsLastTurn`） | E-D；未暴露 → E-INCONCLUSIVE | 对象记号取参数里的字符串叶子（`--collection=beta` → `beta`） |
| `expectPrevTasksUnchanged` | 轮前已存在任务的 status / requestIds | E-G | 任务连续性（旧任务不被改写） |
| `expectTaskStatusIn` | 账本 `oldest`/`latest` 任务状态 | E-G | 取 `taskNo` 排序，缺省按 registry 返回顺序 |
| `replyExcludes` | 回复文本 | E-B | 纯数字片段按「出现该数值」判（`2000` 不误伤 `20000`），其余按去空白子串判 |
| `expectCancelHonest` | 回复 + 指定任务（`cancelTarget`，缺省 latest）状态 | E-D | 声称已取消必须真取消；已完成只许如实说。声称识别带否定词门（`没能`/`无法`/`不是取消成功` 不算声称）；若回复明确说「取消不了 / 早已办完」也算如实（诚实回执可能同时提到另一个任务已取消） |
| `expectInflightCancel` | 轮前最新任务状态（必须 queued/running/cancelling）+ 落定后该任务状态 + 本轮 `task_cancel` 回执 | E-D；轮前已 completed 或取消面未暴露 → E-INCONCLUSIVE | 在飞取消必须真落到 `cancelled`；若落成 completed，只有「回执目标是同一任务 + outcome=terminal + 回复未声称已取消」才算如实迟到，否则判负（含指错任务） |

`gapMs` 由 harness 在 send 之前用**真 `setTimeout`** 等待（`HarnessRunInput.sleep` 仅作测试注入缝），
等待时长写进 `TurnRecord.gapMs` 留证。

`deferIdle` 轮由 harness 调用 `session.sendNoWait(text)`（background 派发下受理即返回），
任务保持 queued/running；下一个非延迟轮发送前（以及计划结束前）统一 `waitIdle()` 收尾。
`settleBeforeJudge` 只随 `deferIdle` 使用：本轮发送后先 `waitIdle` 再判定，用于「发出取消时任务
还在飞，但按落定后的状态判诚实性」。缺少 `sendNoWait`/`waitIdle` 的会话面会**确定性拒绝**
（抛错），不静默退化成阻塞 send 假装交错。

## 三、批执行与证据

- 每会话证据落 `.runtime/long-session/wave1/<track>/<sessionId>/`（`summary.json` 在
  `.runtime/long-session/`）。逐轮期望判负写进 `evidence.json` 的
  `turnExpectationsPass` / `turnExpectationChecks` / `turnExpectationCodes` / `turnExpectationFailures`。
- 三态处置（`classifySample`）**未改动**：轮期望属**行为判据**（预注册 §2.2 第二层），
  判负落在 verdict/证据通道，不冒充 H1–H7 硬零，也不改变 `product_fault` 判定。
- `wave1-support.ts`：`WAVE1_TRACKS` 已含 `LS6`；LS6 压缩后复查轮取 N2-B / N4 / N5-B。

### 2026-11-18 首轮真实冒烟读数（LS6，3 会话；只登记，不作结论）

运行：`long-session-2026-11-18T04-31-20`（本机 workbuddy/deepseek-v4.1-flash，40k/40k/128k）。

| 会话 | disposition | effectiveCompactions | 轮期望 | 事实 Oracle |
|---|---|---|---|---|
| ls6-0 (40k) | `valid` | 5 | 29 检查，1 红（N5-B probe `replyExcludes` 命中「3条」） | 全对 |
| ls6-1 (40k) | `valid` | 7 | 29 检查，3 红（N5-B/N2-B/N5-B probe 的 `replyExcludes`） | 全对 |
| ls6-2 (128k) | `insufficient_coverage` | 0（tokens 硬停 3,189,618 / 3,000,000） | 23 检查，1 红（N5-B「3条」） | **2×E-A：alpha 合计答成 1600** |

- N1–N6 的场景判据（含 N6-Q2 在飞取消、N1 交错账本、N4 新 taskId、N3 状态保持）在三个会话的
  **基础轮**均判正；N6-Q2 在三个会话里都落到 `cancelled`（任务 5/17/28）。
- 所有 `replyExcludes` 红都是**负向词表过宽**：回复把 beta 的「3 条」或已退役 alpha 的「2000」
  如实对照式提及，不是延续错误结论（详见 §五.2）。
- 128k 会话的 2×E-A 是**真实算错**（1200+800 报成 1600，并在后续轮加固），不是口径问题。
- 批级硬零：H1/H3/H4/H5/H6/H7 均 0；`silentEmptyReply` 17 次，全部落在推进轮（turn 17–33），
  不在 LS6 交互轮——单独登记，不并入本轨判据。

## 四、怎么跑

```bash
# 确定性门（全量）：必须绿
export TMPDIR=/home/tao/.tmp
npx tsc --noEmit
npx vitest run

# 单轨真实模型（本机 workbuddy 端点；--model 覆盖缺省 step 基线）
node --env-file=.env --import tsx scripts/eval/long-session/wave1-runner.ts \
  --track=LS6 --smoke-window=40000 --concurrency=1 --model=workbuddy/deepseek-v4.1-flash

# 装配冒烟（LS4/40k，4 个推进轮；只验装配，不当质量结论）
node --env-file=.env --import tsx scripts/eval/long-session/wave1-runner.ts \
  --smoke --concurrency=1 --smoke-window=40000 --model=workbuddy/deepseek-v4.1-flash
```

注意：不带 `--smoke` 时 `--track=LS6` 按预注册形状跑 **3 个会话**（2×40k + 1×128k）；
`--smoke` 固定跑 LS4（单会话、更小上限），两者都不得当质量结论。
本机 workbuddy 端点必须显式 `--model=workbuddy/deepseek-v4.1-flash`：runner 的缺省
`--model` 是 `step-3.7-flash`，会覆盖 `.env` 的 `LLM_MODEL`，把 step 模型名发到本机端点。

## 五、已知盲区（如实登记）

1. **措辞面不判**：事实 Oracle 是数值/关键词机械比对；「答非所问但数字对」「该澄清却硬答」
   的语义部分只交判官层（本文件不覆盖），`E-INCONCLUSIVE` 不冒充结论。
2. **`replyExcludes` 是保守子串/数值检查**：用户先说了错值、模型如实复述「不是 3 条」这类
   诚实更正也会被判负；更常见的是**跨对象撞词**——N5-B 的负向词 `3条` 会命中回复里 beta 的
   合法「3 条」，N2-B 的 `2000` 会命中「alpha 已退役（2 条 / 2000）」的如实说明。2026-11-18
   冒烟中 5 条 `replyExcludes` 红全部属于这一类，复核时以回复原文为准，不据此判产品缺陷；
   要根治需把负向检查做成「对象作用域」，本轮未做（不放宽既有断言）。
3. **`expectExecutionObjects` 只判「必须含」**：不禁止同轮出现多余对象（例如改口径后又顺带
   查了 alpha）。要禁止需另加期望（本轮未做）。
4. **「排队中取消」仍不可达，但在飞取消已可达且判据更硬**：`sendNoWait`（`deferIdle`）让 Q1
   受理即返回，Q2 在任务 queued/running 时发出，`settleBeforeJudge` 等取消落定后再判
   `expectInflightCancel`。Q1 用大载荷 `r6-load-a`，避免小查询在取消到达前完成（那是时序
   竞态）。若 Q2 发出前任务已 completed（没有在飞窗口）或取消面未暴露 → `E-INCONCLUSIVE`；
   落定后未 `cancelled` 时：回执目标是同一任务、outcome=terminal 且回复如实说「已经办完、
   取消不了」→ 判正（取消到达得太晚，产品行为正确）；其余（含取消指错任务、声称已取消但
   没取消）→ `E-D`。排队档（queued 且尚未被 runner 取走）仍没有稳定观测窗口，如实登记为
   不可达。**「开始任务」轮的回复天然是「已受理」**（不含结果），所以 N2-A 只判执行对象、
   不判回复事实。
5. **`expectTaskStatus`（旧注释字段）仍不参与机械判定**：只有新增的 `expectTaskStatusIn` 参与；
   旧字段保留为语料意图标注，避免给 LS2 既有轮引入新的假红。
6. **N1 的「在飞」是发送层真交错，但仍受执行时长影响**：N1-A/N1-B 用 `sendNoWait`，B 的发送
   不等 A 收尾；若 A 在 1.5s 受理窗口内已完成，B 到达时 A 已不在执行——这是被测系统的真实时序，
   不人为延长。判据落在「账本两条任务 + A 最终 completed + 结论对象不串」；真实冒烟需核对
   driver-events 的 A/B 执行区间是否重叠。
7. **N5-A 的 `expectNoNewTask` 偏严**：用户补充一个（错误）事实后，助手若选择“再核一次”就会
   建新任务并判负。2026-11-18 的 3 个会话里均未触发（助手都先澄清/记账），保留观察；这是
   判据口径问题（不是产品缺陷），是否保留待 owner 裁定。
8. **probe 轮只取关键轮**：LS6 压缩后复查取 N2-B/N4/N5-B；N1/N3/N6 不在压缩后复查范围内。
9. **样本量**：Wave1 形状是每轨 3 会话，任何读数都不构成可靠性结论（预注册 §2.1）。
10. **`waiting_user` 到期边界用例不可达（2026-11-18 owner 追问后登记，未伪造）**：目标用例是
    「`runtime.waitUserTimeoutMs=2000` → 执行层 `needs_input` 落 `waiting_user` → 等 3000ms 必须
    `timed_out`」。当前两处都不具备：
    - **超时无消费者**：`waitUserTimeoutMs` 只在 `packages/agent/src/resource-policy.ts:153/186/310`
      定义与校验；状态机允许 `waiting_user→timed_out`（`packages/agent/src/task-registry.ts:249`），
      但全仓只有 `task-runner.ts:486` 调 `registry.timeout(taskId,'execution')`，**没有任何定时器
      调 `timeout(...,'waiting_user')`**（P5-T06 登记为 blocked-by-P2，见
      `docs/architecture/contract.md` §P5-T06）。
    - **夹具造不出 `needs_input` → 已支持（2026-11-18）**：集合绑定现在可以声明
      `requires: ["window"]`（现行例子：`scripts/eval/fixtures/scenarios/dummy-finance/scenario.json`
      的 `receivables-open`）。调用未带该输入时 `dummy.query` 返回 `status:"needs_input"` +
      结构化 `missing:["window"]`（`scripts/eval/fixtures/dummy-platform/runtime/requires.cjs`），
      不写任何数据；补齐后同一次调用正常完成。触发方式（可直接照抄）：
      `bin/dummy query dummy.query --collection receivables-open` → `needs_input`；
      `bin/dummy query dummy.query --collection receivables-open --window 2026-10` → `completed`。
      维度集合的形态同样支持（场景里配 `requires:["customer"]`，`--where customer=<值>`
      或 `--window <值>` 别名都可补齐）。既有「候选歧义」响应（`ambiguous`）保持不变，
      两条路互不复用。真实装配链冒烟见 `scripts/eval/smoke/slow-faults.test.ts`。
    因此本轮**仍不新增 N7 轮次**：夹具侧已经具备，缺的只剩「`waiting_user` 到期没有消费者」
    这一产品侧能力（上一条）；待 P2/P5 接线超时计时后再补该用例。
11. **N3 的真空档为何是 1500ms 而非 30s**：产品里 30s 没有任何会到期的状态（`waitUserTimeoutMs`
    缺省 24h、worker lease 600s、附件追问 30s 与本场景无关），真等 30s 测不到额外东西、只拖慢
    每次会话与冒烟；N3 的目标只是「回合之间真的断开、状态保持」，故按 owner 修正用 1500ms。
