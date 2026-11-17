# P6 后台任务执行：实施报告（2026-11-14）

> 分片依据：`docs/product/r4-slices.md` §三「P6 · 后台任务执行」与 `docs/product/r4-acceptance.md` P6-T01–T05 / P6-E01（v1 预注册基线）；接口按 `docs/product/r4-joint-interfaces.md` §1（TaskRegistry）/§2（ResourcePolicy）/§3（TaskRunner）v1 **冻结**口径实施。
> 分支/基线/提交：worktree `fshine-agent-r4-p6`，分支 `arch/r4-p6`；启动基线 `arch/integration` HEAD `9ae895d`（含联合接口约定 v1）。提交链：`9d4c784`（测试先行，红）→ `bc92728`（最小实现）→ `7e2f78d`（测试口径对齐 P2 契约 + 类型收口）→ `2168ccb`（补执行端同步抛错防御分支 pin）→ 本 docs 提交。未 push、未合并。
> 证据根：`.runtime/p6/`（gitignored）。改测/改码/绊线变异均留档；4 类反向绊线均「先红后复原」，变异从未提交。
> 声明：本片为**独立模块轨**——只新增模块与测试，未接任何热点（`server.ts`/`ask-runtime.ts`/`execution-runtime.ts` 零改动）。P6-E01 与真实接线一律 `blocked`（见 §七），**不冒充完整 P6 验收**。

## 一、产品要求（为什么做 P6）

任务书要求：业务人员交办后，Main 快速受理、聊天不被后台任务拖住（「交办简单、真正省事、随时能接管」）。落到最小切片：

- **受理与执行分离**：`submit` 受理即底账 `queued`、Main 不等待；执行由 dispatcher 在后台按许可推进（每次委派新建 Worker 回合，Task 不绑永久 Agent）。
- **队列不自建**：队列 = 底账 `queued` 行 + `lease/claim`（§3 冻结）；**不引第二套队列**。
- **资源只消费**：并发仅按 P5 `ResourcePolicy` 许可（本模块只申请后台许可；前后台配额独立，后台满载不阻塞前台）；**无第二套预算**（预算归 P5，委派点强制）。
- **重启可恢复**：queued 重新认领；running 且租约过期 → `result_unknown`（**禁止自动重放**，尤其可能有副作用者）；completed 不重跑。
- **取消如实**：`requestCancel` → `cancelling`，**确认中止后才** `cancelled`；未获确认回 `running` 并如实落终态，不得把请求报成已取消。
- **转录隔离**：后台转录不进 `mainMessages`（由注入的执行回合保证，runner 只编排）。
- **状态唯一写路径**：一切状态变化经 TaskRegistry 方法族；runner 零状态直写、零新持久化层、零新通知系统。

## 二、验收用例覆盖（P6-T01–T05；P6-E01 blocked）

| 用例 | 层级 | 覆盖方式（测试/证据） | 状态 |
|---|---|---|---|
| P6-T01 调度与不绑 Agent | 确定性 | `packages/agent/task-runner.test.ts`：受理快速返回（queued、同步返回、不执行）；排队→认领→running→收尾全路径；`timed_out`/`failed`/`cancelled` 落终态；每派发一次 `execute`（同步/异步抛错、abort 信号），无长驻对象 | 已实现/已测（绿） |
| P6-T02 转录隔离 | 确定性 | runner 侧**结构性满足**：`TaskExecutionInput` 只有任务投影字段（taskId/taskNo/name/request/principalId/sessionId/answer），模块无转录概念、不触 `mainMessages`；端到端断言（转录快照前后比对）依赖执行端接线 → 见 §七 | runner 侧已实现；端到端 blocked |
| P6-T03 重启恢复与不重放 | 确定性 | 3 例：新进程第一次 pump（queued 重领、过期租约→`result_unknown` 且执行端零调用、completed 不动）；inline 无租约 running 不回收；未过期租约不回捞。反向绊线①（自动重放）/②（非 queued 重跑）均验证测试灵敏 | 已实现/已测（绿） |
| P6-T04 后台并发上限 | 确定性 | 假 policy 计数：`backgroundConcurrency=1` 下三任务串行（maxConcurrent=1）；N+1 留 `queued`（不超发），容量释放后自动再派发；许可拒绝=错误面（`PumpSummary.rejection`），不阻塞不空转。「拒绝（按配置）」分支见 §七 | 已实现/已测（绿，排队分支） |
| P6-T05 前台可用 | 确定性 | 后台满载时前台许可即时可用（独立配额）；满载期间受理仍即时返回 queued；前台路径不经过本模块 | 已实现/已测（绿） |
| P6-E01 后台任务端到端（黑盒） | 黑盒 | **blocked**：依赖 P2/P5 真实接线 + P4 通知投递 + 真实模型端到端（联合集成后按预注册 N 执行；含「通知与结果可取回」） | 未执行（blocked） |

## 三、实施改动（文件级）

| 文件 | 性质 | 内容 |
|---|---|---|
| `packages/agent/src/task-runner.ts`（新增 519 行） | 新增 | 纯编排模块（**零仓内 import**）：`TaskRegistryPort`/`ResourcePolicyPort`/`TaskExecutor` 端口为对接冻结契约的最小结构类型（非新协议层）；`createTaskRunner`：`submit`（:504）、`pump`（:324，先 `expireLeases` 恢复→`acquire('background')`→`claimNextQueued`→同步发起回合；拒绝即停并如实返回）、`startRound`（:347，每回合一次 execute+abort 控制器）、`settle`（:390，按执行端确认结局落底账；cancelling 未确认回 running）、`cancel`（:439）、`resume`（:468）、`whenIdle`（:489）、`inFlight` |
| `packages/agent/task-runner.test.ts`（新增 939 行，25 例） | 新增 | 假底账（镜像 P2 消费面语义：合法边/租约/认领/过期/取消/等待/接续）+ 假 policy（前后台独立计数）+ 假执行器（手动落定、记录并发与 abort）；覆盖受理/排队启动收尾/执行超时映射/并发上限/满载前台/重启恢复三态/取消语义/waiting_user 释放与接续/安全绊线/同步抛错防御分支 |

**关键口径**：后台终态 = **执行端确认的回合结局**（`transition`/`fail` 落底账），**不做 task 级 `judgeReportedTask` 二次判定**——inline judge 的「首个非 completed 判负」会把等待接续的历史行误判为 failed（P2 契约测试 `task-registry-contract.test.ts` 等待用例同口径注记）。逐回合机械判定归执行端（端口契约写明：completed 仅当本回合确有执行且全部成功）。

**最小性**：零新增依赖、未改 `package.json`；未建第二套预算/状态机/队列/通知；未触碰 `task-store.ts`/`task-registry(-sqlite).ts`/`execution-runtime.ts`/`server.ts`/`ask-runtime.ts`/`tasks.ts`/`ops.ts`（`git diff --name-status 9ae895d..HEAD` 仅两行 `A`）。

## 四、执行证据（本片复跑读数）

- `npm run typecheck`（tsc --noEmit，strict）→ `TSC_EXIT=0`（`.runtime/p6/report-tsc-final.txt`；`tw2-restore-tsc.txt` 同）。
- `npm test`（全量 unit）→ **46 files / 450 tests passed**，`SUITE_EXIT=0`（`.runtime/p6/report-suite-final.txt`）。只增不减：基线 `9ae895d` 测试文件 45 个（`git ls-tree` 计数）→ 46；diff name-status 仅 `A`（无既有测试修改/删除）；本片目标 25 例含在内。
- 目标批：`npx vitest run packages/agent/task-runner.test.ts` → 25/25（`.runtime/p6/report-target-final.txt`）。
- 先红后绿：`red-1.txt`（测试提交时 `src/task-runner` 缺失，整包失败，exit=1）；`green-2.txt`/`green-final.txt` 23/23；`tw2-restore-target.txt` 24/24；`report-target-final.txt` 25/25（补「执行端确认超时」pin 后）。
- 反向绊线 4 类（每次破坏→红→`cp` 复原→`diff -q` 一致；变异从未提交）：
  - ① result_unknown 自动重放 → 恢复测试红（`tw2-1-replay.txt`：`expected [ 'tr' ] to deeply equal [ 'tq' ]`）；
  - ② 非 queued（已启动）任务重跑 → 幂等测试红（`tw2-2-repeat.txt`：`expected [ 't1', 't1' ] to deeply equal [ 't1' ]`）；
  - ③ requestCancel 直接报 cancelled → 取消语义 3 例红（`tw2-3-cancel.txt`）；
  - ④ 绕过 ResourcePolicy 许可 → 并发约束红（`tw2-4-nopermit.txt`：`expected [ 't1', 't2', 't3' ] to deeply equal [ 't1' ]`，连带 10 例）。
- 工作树干净（`git status --short` 空）；HEAD `2168ccb`（绊线期间零提交）。

## 五、回退方式

- **本片未接线**：整片 revert/docs 撤销即回到现状——删除 `task-runner.ts` 与 `task-runner.test.ts` 两个新增文件即可；无 schema/底账变化、无热点改动，`npm run typecheck` 与既有单测不依赖本片。
- **接线后（集成 Run 按 r4-slices 回退断言执行）**：`dispatch 模式配置回落 inline`（现状路径，runner 不被调用）；`重启恢复关闭`（不调用 pump 的恢复面/不注册 runner 触发）。
- 无迁移负担：未改任何持久化 schema。

## 六、接线需求（集成 Run）

| 接线点 | 来源 | 要求 |
|---|---|---|
| `TaskRegistryPort` | P2 `task-registry(-sqlite)` | 结构兼容（本端口为最小消费子集；`get(taskId, scope?)` 可选/必选 scope 的适配与类型去重由集成负责人定）；`claimNextQueued/expireLeases/waitForUser/answerResumes/requestCancel/confirmCancelled/timeout/markResultUnknown/transition/fail` 语义即冻结 §1 |
| `ResourcePolicyPort` | P5 `resource-policy` | `acquire('background')` 非阻塞：许可/拒绝；`release`；`cancelQueued`。前台配额由 P5 独立保证；**leaseMs 必须覆盖最长执行回合**（按 `workerTurnMs` 取；§1 无租约续期方法） |
| `TaskExecutor` | 后台执行回合（execution-runtime 变体） | 每次派发新建 Worker 回合、后台转录不进 `mainMessages`；回合内执行经 registry 记录执行事实；**逐回合机械判定**后报告 completed/failed/needs_input/timed_out/cancelled（零执行不得报 completed） |
| 受理入口 | `server.ts`（渠道消息） | 后台交办走 `runner.submit`（受理即 queued，Main 不等待）；触发点调 `pump`（受理后/回合落定后/外部定时或事件） |
| 共享装配 | `ask-runtime.ts` | 注入同一 registry/policy/executor 到 runner；不建第二装配点（P0 唯一装配原则） |
| 通知 | P4 | P4 经 registry `onTaskFact` 取事实；runner 不建通知/事件总线 |

## 七、blocked 清单（不计入 passed）

1. **P2/P5 真实接线与联合验收** ← 集成 Run；解除条件：P2 `task-registry(-sqlite)`、P5 `resource-policy` 合入后按 §六 装配，并在集成基线做兼容性回归。
2. **P6-E01 后台端到端黑盒** ← P2/P5/P4 联合集成（预注册 N、run-dir + judgment + 通知投递记录）。
3. **后台任务结果文本（resultText）写入口径** ← P2/集成裁定：inline `complete()` 会经 task 级 judge 误伤等待接续，runner 暂不落 `resultText`；P6-E01「结果可取回」依赖该项。
4. **queueCapacity=0 的「拒绝」分支落点** ← P5/集成：受理不咨询 policy（受理即 queued）；`acquire` 在认领前没有任务身份，拒绝只能表现为「暂不派发」；任务级 `resource_limited` 映射建议在受理或排队超时点处理。
5. **重启时停在 `cancelling` 的孤儿** ← P2/P5 边界：`expireLeases` 只回收 `running`；回滚/确认语义待集成裁定。
6. **waiting_user 接续回合无租约** ← P2（`answerResumes` 不写租约）：进程中断后接续回合的回收未覆盖。
7. **queued/waiting_user 超时计时** ← P5 计时边界触发 `registry.timeout`（runner 不做计时器）。
8. **P6-T02 端到端转录隔离断言** ← 执行端接线后（runner 侧结构性满足，见 §二）。

## 八、已知边界（登记）

- 租约无续期（§1 无方法）：超出租约的在飞回合会被下一次 pump 的 `expireLeases` 判为 `result_unknown`（保守：unknown ≠ success）；集成按 §六 的 leaseMs 口径规避。
- cancel 对「running 且非本进程在飞」的任务只发请求、不宣称取消（无 abort 能力时确认不可得）——本模块单进程后台调度下该路径不可达（运行中任务恒在本进程 inFlight），保留为防御分支。
- `whenIdle()` 为测试/收尾等待（等全部在飞落定），不作为运行时接口。
- 本片测试全部使用假端口；未跑真实模型/渠道/执行层（黑盒项 blocked）。
