# R4 集成接线实施报告（2026-11-14）

> 基线 `arch/integration @ 3b41945`（含 P2a `ecbf297` / P5 `771be96` / P6 `62afbea` / P4 `87fbd94` / P2b `48caffd`）；
> 分支 `arch/r4-integ`（worktree `fshine-agent-r4-integ`）；契约 `docs/product/r4-joint-interfaces.md` v1/v1.1/v1.2；
> 证据根 `.runtime/integ/`（gitignored：design / red-* / green-* / tripwire-* / smoke-*）。
> 声明：本报告登记**接线实施与确定性联动证据**；所有 smoke 为 N=1，一律标注 INSUFFICIENT_EVIDENCE，**不作稳定性结论**；
> 黑盒验收（各 E01）仍 blocked → P7b，不计入 passed。

## 一、产品要求（为什么做这次接线）

各轨独立开发（P5 资源策略 / P6 后台执行 / P4 通知 outbox）只交付模块与测试，**强制点/调度/投递/存档必须由集成方
唯一接线**（联合接口约定 §6）。本次接线目标：让「交办简单、真正省事、行为可预期、随时能接管」在 Runtime 层面成立——
Main 快速受理、后台受资源约束执行、等待可释放并接续、通知如实投递且与任务结果解耦、结果可找回；
且**缺省不改变现有行为**（inline 路径逐字不变）。

## 二、接线面清单（文件级）

| 文件 | 接线内容 |
|---|---|
| `packages/contracts/src/config.ts` | `RuntimeConfig.dispatchMode: 'inline' \| 'background'`（缺省 inline） |
| `packages/core/src/config.ts` | `parseRuntime` 收编 `dispatchMode`（非法值 fail-fast 点名；未知键照拒） |
| `packages/agent/src/execution-runtime.ts` | `send` 前台 acquire/release（拒绝=确定性 `ForegroundRejectionError`；队列>0 受控等待晋升）；inline 委派派生后台许可（共享父预算、深度+1、不占槽；拒绝落 `resource_limited`）；background 委派=`runner.submit→pump`（受理事实回 Main）；`createTaskExecutor`（单回合后台执行器：needs_input/零执行/超时/取消/完成机械判定） |
| `packages/agent/src/task-runner.ts` | 端口可选 `archiveReply`；settle 确认 `completed` 后逐字存档 resultText（P6 §七.3 集成裁定，不经 inline judge） |
| `scripts/ask-runtime.ts` | 装配核心注入 policy/runner/taskExecutor/sink/runnerOptions；`createBackgroundDispatch`（进程级 runner）与 `attachNotificationOutbox`（唯一事实→outbox 接线点）；`resolveExecutionFace`；ask/redo 对 background **显式拒绝**（登记边界） |
| `apps/server/server.ts` | 同会话 promise 链串行化（P5-T02）；background 启动建进程级 runner（首次 `pump()`=重启恢复）与 outbox（`deliverOnRecord`）；`deliverPending()`；`taskExecutor`/`notificationSink` 注入面 |
| `scripts/tasks.ts` | 详情只读「通知投递」段（`createNotificationReader`；无行不显示，历史行零变化） |
| `packages/agent/resource-policy-single-source.test.ts` | 守卫所有者表登记 `scripts/ask-runtime`（解析值透传，不重读配置） |
| `config/agent.example.yaml` / `docs/environment-variables.md` | `runtime.dispatchMode` 登记 |

**零改动**：`resource-policy.ts` / `notifications.ts` / `task-registry(-sqlite).ts` / `task-store.ts` / `judgeReportedTask` /
冻结判据 / 历史证据 / eval 面 / `pi-driver`。**不新增机制/依赖**；真实平台不接。

## 三、联动证据

### 3.1 联合测试（假 driver/executor/sink/渠道事实，零网络）

`scripts/r4-integ-joint.test.ts`（15 例）+ `apps/server/server-r4-background.test.ts`（2 例）：
`TMPDIR=/home/tao/.tmp npx vitest run scripts/r4-integ-joint.test.ts apps/server/server-r4-background.test.ts`
→ **2 files / 17 passed**（`.runtime/integ/green-target-head2.txt`）。7 焦点逐条：

1. **受理快速返回**：executor 挂起时 `send` 已返回；`run_task` 返回 `{taskNo,name,status:'queued',accepted,notice}`；受理后 pump 使行 running。
2. **并发受 policy 限制**：`backgroundConcurrency=1` → 1 运行 + 2 queued，逐次放行，`maxActive=1`。
3. **waiting_user 释放并同 Task 接续**：`pendingQuestion` 落库、后台许可归零；`resume` 同 taskId/taskNo。
4. **通知生成/去重/投递**：accepted/started/completed 三行；同 `(taskId,kind,stateVersion)` 重复 record 不新增；reader 未送达→已送达。
5. **重启恢复**：新 runner `pump()` → queued 重领、过期租约 `failed+result_unknown`（执行端零调用）、completed 不重跑。
6. **取消请求≠已取消**：`cancelling` → 确认才 `cancelled`；未确认回滚 running 并如实收尾。
7. **多用户归属不绕过**：越权 get/cancel/resume/transition 同一 `TaskOwnershipError`。
   附加：⑧ resultText 经 `archiveReply` 取回；⑨ dispatchMode 配置面；⑩ tasks 通知展示；⑪ server 同会话串行化；
   ⑫ background 渠道回合端到端（受理→完成→结果→假 sink 投递）；⑬ ask 入口拒绝 background；⑭/⑮/⑯/⑰ 见绊线轮与 §3.3。

### 3.2 反向绊线（9 类；破坏不提交、逐条还原）

轮一（`.runtime/integ/tripwire-1..5-*.txt`）：串行化直通→⑪红；不挂通知 outbox→④红；不调 archiveReply→③⑧红；
前台 acquire 直返→⑭红；委派不派生许可→⑮红。
轮二（`tripwire-round2.md` / `tripwire-A..E-*.txt`）：投递失败写 tasks 行→⑯红（+P4 解耦 5 例）；取消直接 confirm→⑥红（+P6 3 例）；
unknown 自动重放→⑤红（`[task_running,task_queued] ≠ [task_queued]`）；前台误用后台配额→⑰⑭红；直写 `UPDATE tasks`→单写路径守卫红。
每轮还原后 `diff -q` 逐字节一致；全仓 TRIPWIRE 残留 0。

### 3.3 真实 Pi 黑盒 smoke（`LLM_MODEL=step-3.7-flash` + 仓内 dummy；均 N=1，**INSUFFICIENT_EVIDENCE**）

| 项 | 命令 | 读数 |
|---|---|---|
| E06×1 | `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E06 --trial 1 --out-dir .runtime/integ/smoke-e06` | **PASS**，exit=0（`smoke-e06.txt`；model.json：step-3.7-flash） |
| E12×1 | 同命令 `--case E12` | **PASS**，exit=0；五维（完成/真实性/数据/状态一致/干预）全 pass（`smoke-e12.txt`） |
| 后台 E2E×1 | `LLM_MODEL=step-3.7-flash node --env-file-if-exists=.env --import tsx .runtime/integ/background-smoke.ts` | exit=0（`smoke-background.txt`）：交办 → Main 回执含 **#1**（措辞「已收到…任务已提交给执行层」；tool result 机械携带 taskNo/name/status）→ 行 running → 后台完成 `completed` → `replyText`=执行层汇报原文 → 通知 accepted/started/completed 经假 sink **全部送达** → **tasks CLI 真实入口**（`scripts/tasks.ts #1 --config=…`）找回最终回复 + 「通知投递：已受理/已开始/已完成：已送达」 |

措辞观察（如实登记，不作结论）：R-A 期望受理回复含「#编号 + 业务名」；本轮 N=1 回复含 `#1` 与查询对象，
但未逐字出现「已受理」，业务名（机械回落全文）未完整复述——属模型措辞面（黑盒），留 P7b 预注册批次判定；
机械面（tool result 的 taskNo/name/status/notice）已在联合测试 ① 钉住。

### 3.4 回归（本会话实跑）

- `TMPDIR=/home/tao/.tmp npx tsc --noEmit` → exit=0（`.runtime/integ/final-tsc.txt`）。
- `TMPDIR=/home/tao/.tmp npm test` → **54 files / 584 passed**，exit=0（`.runtime/integ/final-suite.txt`）；
  基线 567（只增不减：+17 联合例；`git diff 3b41945..HEAD -- '*.test.ts'` 删除 it/describe 命中 0）。
- inline 金样逐字：ask-runtime/ask-interactive/ask-replay/p0-gates-cli/p0-assembly-single-point/p0-runner-lock/
  tasks/ops/p7a-*/reply-archive/runtime/task-registry-contract 等全绿（全量 54 文件）。

## 四、blocked 审计

**本 run 解除（确定性接线完成，证据 §3.1/3.2）：**

- P5：execution-runtime 前台强制点 + 子许可派生（共享预算/深度）接线；server 同会话串行化（P5-T02 用例本体）；P5-T01 端到端配置加载（解析/fail-fast/未知键）。
- P6：P2/P5 真实接线（registry/policy/executor 端口对接）与受理入口（server）；结果文本写入口径（§七.3 裁定=settle→archiveReply）。
- P4：`onTaskFact→outbox` 接线、server sink 注入面、tasks 只读展示；投递失败与任务结果解耦（⑯）。
- P2：取消/等待/超时/unknown 的 execution-runtime 侧接线（确定性面；黑盒仍 blocked）。

**仍 blocked → P7b（不计入 passed）：**

1. P5-E01 / P6-E01 / P4-E01 / P2-E01 黑盒（预注册 N + 真实模型批次）；P4-T04 语言黑盒部分。
2. P7-T06 故障注入（模型超时/Worker 崩溃/重启/通知失败/重复消息/池满）与真实渠道投递（WeCom sink 适配器不实现、不连接）。
3. `taskBudget` 运行时 consume（ms/calls/token 计量点）：准入时耗尽检查已接线，生产回合不累计用量（R-E 预算耗尽场景）。
4. P6 §七 遗留：cancelling 孤儿恢复、waiting_user 接续无租约、queued/waiting_user 超时计时触发、queueCapacity=0 拒绝落点（维持 P6 现状）。
5. ops 页面通知投递清单（本轮只接 tasks 详情）；多进程/多实例登记不做。

## 五、默认行为保持与回退

- **默认保持**：`runtime.dispatchMode` 缺省 `inline`；inline 路径 acquire/release 顺序调用零差异；新受理/后台/通知路径仅在
  `background` 且注入件存在时启用；ask/redo 对 background 显式拒绝。登记后果（不变）：缺省 `mainConcurrency=1` 下跨会话
  前台并发超过 1 走 P5-T03 确定性拒绝（adapter 既有 FALLBACK_REPLY），需要并行/排队由部署显式配 `mainConcurrency`/`queueCapacity`。
- **回退方式**：① 配置级——`runtime.dispatchMode: inline`（或移除 runtime 段）即回现行路径，runner/outbox 不创建；
  ② 提交级——revert 本片提交（`198587c`/`deeb57b`/`8eaa7de`/`1153d1f`/`6e894c4`/`8b325c2` + 本 docs 提交）；
  无 schema 迁移（notifications 表由 P4 模块 `CREATE TABLE IF NOT EXISTS` 自建、v3 迁移归 P2a），回退后既有单测/金样仍全绿。
