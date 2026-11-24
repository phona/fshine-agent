# task 重定义

## 1. 结论

task 没有 status。task = 身份（taskId）+ 归属（principal/session）+ 交办（delegation）+ 两份信息：**worker 汇报**（语义）+ **宿主守护事实**（机械）。

## 2. 要删的

- `task.status` 字段（`TaskRecord.status`）——它其实是「做了啥的 summary mark」，不是「任务状态」，这名字会诱导把 task 写成有状态字段的形态。
- 六处「算 status」的函数：
  - `lastWritable`（execution-runtime.ts:4495，后台终局）
  - `judgeReportedTask`（task-registry.ts:197，inline 终局）
  - `failureViewOfTask`（execution-runtime.ts:2099，失败投影）
  - `statusView`（execution-runtime.ts:2124，task_status 投影）
  - `classifyOutcome`（task-outcome.ts:71，五态分类）
  - `lastDecisiveFailureCode`（server.ts:568，唤醒失败码）

## 3. 保留的两件真东西

| 东西 | 是什么 | 谁消费 |
|---|---|---|
| worker 汇报（messages / replyText） | 语义：worker 说的话 + 工具结果 | 用户（进度条）、Main（带话） |
| 宿主事实 | 机械：归属 + 启动/结束时刻 + 汇报/提问 + 活 worker 事实（布尔谓词，不产状态词）+ claimed→resulted（dispatchKey 幂等账） | 宿主（不重复写 + 现推活/结束 + 投递） |

守护事实两个用途：① 不重复写（宿主读幂等）；② 回答进度查询（用户一句「怎么样了」，Main 读守护事实现答，不惊动 worker）。

## 4. worker 汇报契约（主动汇报，不黑盒）

分两类：里程碑报（每完成一个对象报一句，小任务逐笔、大任务攒着）+ 兜底报（>10min 无进展报一句「还在办」）。完整契约四段 + 一兜底：开始（「我来办」）/ 进展（逐笔）/ 需要你（确认·补信息，立刻问）/ 结束（报结果）/ 兜底（>10min）。频率硬约束（对话形态不变量）：一条事实只说一次，不重复、不倒挂。**注意边界**：这个汇报是「话」（语义），不写进机械 checkpoint——机械账是宿主在 op_* 路径上记的。

## 5. 三个硬骨头（落地时定）

- **P1 原子性**：外部写 vs 账本记不能原子 → claimed/resulted 两段式；已有 `OperationRow`（claimed/settled）一半，对齐即可。
- **P3 对象身份**：账本怎么知道「哪一笔」——**待 owner 裁定**：A 执行层声明绑定身份（扩契约）/ B 接受现状登记限制 / C 改写冻结用例。
- **P4 续办边界**：结构化交办可机械续、开放意图只能 Main 重规划 → **登记不实现**。

## 6. 落地切片

S0 本文档；S1 删 status + 收敛六处；S2 P3 对象身份；S3 worker 汇报契约进 prompt；S4 P1 对齐 + P4 登记。

## 7. 不维护任务状态机（owner 2026-11-23，定稿）

没有任何「状态」需要存储，也没有任何任务级生命周期枚举。任务行只存事实：`running_since`（这一轮何时启动）、`result_text` / `reply_text`（worker/Main 汇报）、`pending_question + waiting_since`（提问）、租约与提醒时刻、`executions`（每笔执行 status = 执行层契约事实）。原来六个可变终态列（`died_at` / `cancelled_at` / `timed_out_at` / `resource_limited_at` / `round_failed_at` / `cancel_requested_at`）**全部删除**，也不再新增任何终态列（含 `completed_at`）。

**结束事实只留时刻、不分类**：这一轮停下时写一条 `task_ends` 事实（`task_id + at`；同任务至多一条、不可变、重启后仍在）。**没有 kind**——cancelled / timed_out / resource_limited / 租约过期 / 无汇报收尾都不再持久化种类；怎么结束由消费方读原始事实（汇报 / 执行行 / 活 worker）就地算。

**活/结束由布尔事实现推**（`packages/core/src/task-progress.ts`，不落列、不返回状态词）：

- 排队：`running_since` 空 + 无汇报 + 无提问；
- 仍在推进：已启动 + 无结束事实 + 无汇报/提问；
- 可能还在跑（跨进程读者）：仍在推进 + 租约未过期或 accepted 在途；
- 在跑（本进程）：仍在推进 + runner 的 inFlight / waiters / controllers 里有活 worker；
- 等用户：`pending_question`；
- 结束：结束事实在场、或汇报存档在场、或已启动且不再可能还活着（无汇报 = 结果未知）。

**「标签」就地算**：CLI/ops/投递/唤醒各自读原始事实（开始/结束时刻、汇报、提问、租约/活 worker、执行行）算自己的词；**不共享任何「怎么结束」类型/函数/字段**。守卫按形状判：`packages/agent/task-lifecycle-enum-guard.test.ts`（代码：事实 → 多值任务级生命周期的函数/枚举；文档：不许把 task 描述成有状态机/存活三值的句子；反向绊线均实跑）。

**迁移**：旧库可写打开时重建 tasks 表（丢 status/reason/failure_reason 与六个终态列）；只把**升级前已停下**的旧行当已结束（旧终态列 / 旧 status 属已停集合 / 已有汇报 → 一条结束事实，`at` 取原时刻，种类丢弃，等待形状清掉）；仍在等待（`pending_question`）、排队或在跑（旧 status=queued/running/cancelling）的行**不写**结束事实——提问保留、`running_since` 回填防重认领，交给续跑 / 重启对账 / 取消路径。只读打开旧库时，v4 的「停了没」从旧 status 读（只合成停下时刻，不还原种类）。v6 的 `task_events`（带 kind）迁到 `task_ends`（只留 at）。历史汇报与执行事实原样保留；迁移包在单个事务里。
