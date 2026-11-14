# R4 P7b 完整验收报告（2026-11-14）

> 授权：owner 2026-11-14「P7b 完整验收——故障场景（确定性）+ 预注册黑盒批次」。
> 基线：`arch/integration @ 56309df11f983001f7cd0dad354e484e5037e3b0`；分支 `arch/r4-p7b`（worktree `fshine-agent-r4-p7b`）。
> 提交链：`47aa761`（故障套件先在红：3 failed | 7 passed）→ `5188ded`（实现转绿：受理侧幂等 + 池满拒绝落点 + 排队许可不直派发）→ 本 docs 提交。
> 证据根 `.runtime/p7b/`（gitignored）。
> 纪律声明：判据/用例/冻结面/历史证据零改动（E05/E06 判据哈希见 §三）；不接真实平台；黑盒预注册 N=9、一次采样、不扩展、不重采样、不筛绿、全部样本保留；k/N 一律附 Wilson 95% CI（`scripts/eval/exploration/stats.ts` 的 `wilson95`），**不得把 9/9 读作 100%，不得读作稳定概率**。

## 一、回归门（实跑，HEAD `5188ded`）

| 门 | 命令 | 读数 | 证据 |
|---|---|---|---|
| typecheck | `TMPDIR=/home/tao/.tmp npx tsc --noEmit` | exit 0 | `.runtime/p7b/final-report-tsc.txt` |
| 全量 unit（只增不减） | `TMPDIR=/home/tao/.tmp npm test` | **55 files / 594 tests 全绿**（基线 54/584 → +1 文件/+10 例；先红期 3 red 未删任何既有断言） | `.runtime/p7b/final-report-full.txt` |
| 故障套件 | `TMPDIR=/home/tao/.tmp npx vitest run scripts/p7b-fault-injection.test.ts` | **10/10 passed** | `.runtime/p7b/final-report-fault.txt` |

## 二、P7-T06 故障注入（确定性；假 driver / 假 sink / 假渠道 / 假 executor）

套件：`scripts/p7b-fault-injection.test.ts`（10 例）；断言口径：预期状态按 P2 状态机落库、不挂死（有限步收尾）、不重复副作用（driver/client/executor 调用计数）、通知不丢（意图 + `payload.reason` 原样）、前台可用。全 6 类 **passed**（10/10）。

| # | 故障类（套件行号） | 注入与预期机械事实 | 判定 | 证据 |
|---|---|---|---|---|
| ① | 模型超时（`:228`） | 假 driver 到截止返回空文本（真驱动契约同款）/ 抛 AbortError → `timed_out` + `reason=timeout`；无结果存档；通知 `timed_out`；driver 恰 1 次；前台可用 | passed | ①-1/①-2 两例绿（该 describe 全绿）；超时分支现行为由 P6 执行器承接（`execution-runtime.ts:531-541`） |
| ② | Worker 崩溃（`:333`） | 假 driver 先成功执行一次再抛错 → `failed` + `reason=failed_confirmed` + 原文；executions 保留 1 条；不重放（driver/client 各 1）；通知 `failed` | passed | ② 例绿 |
| ③ | 通知失败（`:393`） | 恒失败 sink / sink 抛异常 / 恢复后重投 → 任务结果不变、未送达可见（attempts/lastError/exhausted）、有界重试（退避注入时钟） | passed | ③-1/③-2/③-3 三例绿 |
| ④ | 重复消息（`:523`） | 假渠道同 messageId 并发重投（后台 + inline）→ 回执幂等重放、不新增任务、不重复执行、查重先于 Main 回合 | passed（先在红 → `5188ded` 转绿） | ④-1/④-2 绿；红期证据 `.runtime/p7b/red-2.txt`（`expected '已受理 #2。' to be '已受理 #1。'`） |
| ⑤ | 池满（`:606`） | `backgroundConcurrency=1 + queueCapacity=0` 满员再交办 → 受理工具结果 `accepted:false` + `reason=resource_limited`；任务终态 `failed`+`resource_limited`；无 queued 积压；运行中任务不受损；前台可用；通知 `resource_limited` | passed（先在红 → 转绿） | ⑤ 绿；红期证据 `.runtime/p7b/red-2.txt`（`accepted:true` 不符）；现状探针 `.runtime/p7b/probe-pool-full.txt`（修复前无界积压） |
| ⑥ | 重启三态（`:680`） | 重启后 queued 重领（编号不变、结果存档）；过期租约 `failed`+`result_unknown` 且零重放；completed 不重跑（executions 零新增）；通知不重复、`result_unknown` 以 `failed` 意图 + payload.reason 承载 | passed | ⑥ 绿（该断言与集成联合⑤同口径） |

**实现面（`5188ded`）**：`apps/server/server.ts:216-232`（(principal,session,messageId) 幂等、回执重放、有界 FIFO 1024、失败不缓存）；`packages/agent/src/execution-runtime.ts:303-324` + `:333-347`（受理前按 policy 事实拒绝 → `failed`+`resource_limited`，镜像 inline ⑮）；`packages/agent/src/task-runner.ts:351-356`（排队许可不直派发，修复 `queueCapacity>0` 绕过并发上限——探针 `.runtime/p7b/probe-queue-capacity.txt` 修复前 `maxActive=2`）。

**反向绊线（4 类；破坏不提交、逐条恢复；总表 `.runtime/p7b/tripwire-summary.md`）**：

| # | 破坏 | 红跑读数 | 证据 |
|---|---|---|---|
| ① | 通知失败直写任务行（`notifications.ts:431` 分支） | 故障套件 `3 failed \| 7 passed`；③-1 `expected 'failed' to be 'completed'` | `tripwire-1.patch` / `tripwire-1-run.txt` |
| ② | 过期租约改回 queued（`task-registry-sqlite.ts:268-280`） | `1 failed \| 9 passed`；⑥ `expected [] to deeply equal [ 'task_running' ]` | `tripwire-2.*` |
| ③ | 关掉 messageId 查重（`server.ts:219`） | `2 failed \| 8 passed`；④-1/④-2 `expected '已受理 #2。' to be '已受理 #1。'` | `tripwire-3.*` |
| ④ | 取消请求直接 `confirmCancelled`（`task-runner.ts:482` 分支） | 联合+task-runner `4 failed \| 36 passed`；`{outcome:'cancelled'}` ≠ `{outcome:'requested'}` 等 | `tripwire-4.*` |

恢复核验：`git checkout --` 逐文件恢复后 `tsc 0`（`tripwire-restore-tsc.txt`）、全量 `594/594`（`tripwire-restore-full.txt`）、故障套件 `10/10`（`tripwire-restore-fault.txt`）；`grep -rn "TRIPWIRE" packages apps scripts` = 0；`git diff HEAD`/`git status` 空。

## 三、黑盒批次（真实模型 + 集成 Runtime + 仓内 dummy；预注册 N=9）

**口径版本 v1**：模型 `step-3.7-flash`（manifest.model.id；baseUrlHost api.stepfun.com，keyPresent true）；git HEAD `5188ded`（dirty=false）；`criteriaSha256=9d4b0824…`、`casesSha256=6d55a42a…`（E05/E06 一致，runner `verifyLock` 通过、判据零改动）；judgeVersion `convergence-r1.judge.1`；统计 `stats.ts wilson95`。N=9/场景，一次采样，全部样本保留（失败不替换）。

| 批次 | k/N | Wilson 95% CI | 失败分布 | 归因 |
|---|---|---|---|---|
| E05×9（歧义/必要澄清） | **4/9** | [0.189, 0.733] | FAIL_NO_DELEGATION ×5、FAIL_ZERO_EXECUTION ×5、FAIL_WRONG_OBJECT ×5（trial 2/3/4/5/9 同一形态） | **模型面**：5 个 FAIL 的 `toolcalls.jsonl` 均为 0 行——Main 自行反问「contoso 是什么/要哪类数据」而未调用 run_task（零执行）；4 个 PASS 的 toolcalls=2（委派→执行层 `needs_input` 两候选→转述请用户选择）。同一装配/执行面 4/9 通过，无产品机械面异常 |
| E06×9（缺参数/必要澄清） | **9/9** | [0.701, 1.0]（不得读作 100%） | — | 通过 |
| 后台 E2E×9（机械面） | **9/9** | [0.701, 1.0] | — | 见下 |

**后台 E2E×9**（`.runtime/p7b/background-e2e/`；harness `p7b-background-e2e-v1`，与集成 smoke 同构：交办 → Main 快速受理 → 后台 TaskRunner（真实 Worker 回合经 dummy）→ `completed` + `resultText` 存档 → 通知三态经假 sink 投递 → `tasks` CLI（真实入口）找回；每样本独立 db/state/session/config）：

- delegated 9/9、completed 9/9、resultText 可找回 9/9（`renderTaskDetail` 与 `tasks` CLI 均含存档原文，CLI 同时含 `#1`、`通知投递`、`已完成：已送达`）、通知三态送达 9/9（kinds=accepted/started/completed，全部 `deliveredAt`，假 sink 实收三类）、mechanicalPass 9/9。
- 逐样本状态链：受理后 `running`（8/9；样本 8 读取时已完成=completed——dummy 快，非缺陷）→ 终态 `completed`；executions 均 `dummy.query=completed`。
- **措辞观察**（受理回执，模型面，仅观察不作门槛；机械受理事实恒在——每样本 `acceptedTaskNo=1`、`acceptedName` 非空、notice 机械含 `#`，`execution-runtime.ts:362`）：

| 观察 | k/N | Wilson 95% CI |
|---|---|---|
| 回执含 `#编号` | 4/9 | [0.189, 0.733] |
| 回执复述业务名（逐字包含机械名） | 0/9 | [0, 0.299] |
| 回执含「已受理」 | 5/9 | [0.267, 0.811] |

与集成 smoke N=1 的措辞观察同构（未逐字出现「已受理」、业务名未完整复述）——属黑盒模型措辞面，如实登记；不构成本轮任何「稳定/达标」结论。

证据：`.runtime/p7b/{e05,e06}/`（manifest/summary/report + `runs/<case>/trial-1..9/` 逐 trial inputs/model/toolcalls/transcripts/audit/executions/reply/meta/judgment）、`.runtime/p7b/background-e2e/`（`run-1..9/sample.json` + `samples.jsonl` + `summary.json`）、聚合 `.runtime/p7b/batch-summary.json`（`aggregate-batch.ts` 产出）。

## 四、§八 12 场景对照表

> 判定口径：确定性用例=全过即 passed；黑盒=按预注册 k/N + CI（本报告不把任何 CI 读作稳定）；blocked=依赖未就绪/未接线，注明解除条件。

| §8 场景 | 落地证据 | 判定 | 依赖与解除条件 |
|---|---|---|---|
| 1 快速受理给数字 ID 与业务名 | 机械面：联合①、后台 E2E 9/9（taskNo/name/notice）；措辞面：后台 E2E #ID 4/9、业务名 0/9 | **failed（黑盒措辞面）**；机械面 passed | 模型转述形态改进需另行 Eval 归因（提示词补丁属 A 类，须证据+owner 裁定）；复测=同口径新批次 |
| 2 多 Worker 受并发限制 | 联合②（并发 1、maxActive=1、排队许可不直派发）、故障⑤（满员确定性拒绝）、`task-runner.test.ts` 25 例 | passed（确定性）；blocked 子项：`queueCapacity>0` 账本队列上界未强制 | 解除=policy 侧裁决面扩展（冻结 §2 接口变更须 owner 批准） |
| 3 持续发消息 Main 不假死 | 联合⑪（同会话串行）、⑰（后台满载前台可用）、故障⑤ 前台断言；后台 E2E 9/9 交办回合即时返回、执行归后台 | passed | 无 |
| 4 阶段进展通知 | 联合④（生成/去重/投递、未送达→已送达）、故障①②③⑤ 通知断言；后台 E2E 三态送达 9/9 | passed（写入/去重/投递/终态不丢）；通知语言质量黑盒未评 | 语言面随真实渠道 blocked |
| 5 挂起等待并释放资源 | 联合③（waiting_user 释放后台许可、同 Task 接续、taskNo 不变）；E05 链：4 个委派样本均正确转述 `needs_input` 候选 | 确定性 passed；黑盒 failed（E05 k=4/9，5 例未委派） | 黑盒解除=模型委派行为改善后重测 |
| 6 代词/省略回复接续 | 联合③（同一 Task 续跑机械断言；无规则式消解器）；`P7-E01` 3 回合 smoke（P7a，N=3 INSUFFICIENT_EVIDENCE） | 确定性 passed；黑盒多轮本轮未跑 → blocked | 解除=按预注册跑交互 smoke（可在收尾批次） |
| 7 完成后主动交付摘要且结果可找回 | 联合⑧（archiveReply 逐字）；后台 E2E resultText 9/9（detail+CLI 找回）、三态通知 9/9 送达 | passed（机械面）；摘要措辞质量未评 | 无 |
| 8 异常业务语言 + Request ID 追溯 | P4 通知字段白名单/事实性（P4 测试）、executions requestId 落库、故障③ 通知失败与结果解耦 | passed（确定性追溯面）；语言黑盒 blocked | 解除=真实渠道适配器切片（WeCom sink 不实现、不连接） |
| 9 多用户不越权 | 联合⑦（读/取消/接续/转换同一 `TaskOwnershipError`）、P3 既有 | passed | 无 |
| 10 故障注入（模型超时/Worker 崩溃/重启/通知失败/重复消息/池满） | 本套件 10/10 + 4 类反向绊线（§二）；故障⑥=R-D、故障⑤=R-E 的池满分支 | passed | R-E 其余分支（预算耗尽、队列容量>0）见 blocked 审计 |
| 11 后台满载前台与确定性查询可用 | 联合⑰（后台 1/1 时前台即时回合）；故障⑤ 前台断言；policy 前后台账本独立 | passed | 无 |
| 12 ops 从数字 ID 追溯执行树/错误/资源 | tasks 详情 `#no`/名称/执行行/失败原因 + 通知投递段（联合⑩）；ops 只读快照（P8 已合入面） | 部分 passed；blocked：ops 通知投递清单、执行树完整面、多进程 | 解除=ops 扩展切片（含通知清单） |

## 五、blocked 审计（不计入 passed）

| blocked 项 | 事实与证据 | 解除条件 |
|---|---|---|
| 真实 WeCom sink 投递（P4-E01 送达/语言黑盒部分） | 适配器不实现、不连接；通知面一律假 sink | 渠道适配器切片（新授权） |
| `taskBudget` 运行时 consume（R-E 预算耗尽） | 准入检查已接线，生产回合不累计用量（集成报告 §四.3） | 预算计量点接线（P5 边界） |
| `queueCapacity>0` 的账本队列上界（R-E「队列满」分支） | 满员时任务受理为 queued 且上界不受 queueCapacity 约束（policy 排队许可与底账队列未合一） | policy 侧裁决面扩展（触碰冻结 §2 接口 → owner 批准） |
| messageId 幂等窗口 | 进程内有界 FIFO（1024）；跨重启/多实例不保持 | 持久幂等键（新 schema/机制 → owner 决定） |
| `waiting_user` 接续（resume）排队许可直派发滞留 | 无生产调用方、无测试覆盖，维持登记（同族缺陷已修 pump 路径） | 接续接线 + 测试 |
| P6 §七 其余遗留 | cancelling 孤儿恢复、waiting_user 无租约接续、queued/waiting_user 超时计时触发 | 后续切片（P5/P2 边界） |
| P7-E01 交互式 3 回合 smoke | 本轮未跑；P7a 的 N=3 仅 INSUFFICIENT_EVIDENCE | 预注册 smoke 批次 |
| ops 通知投递清单 / 多进程/多实例 | 集成报告 §四.5；单实例登记 | ops 切片 / 多实例立项 |

## 六、限制（N=9 表述）

- N=9 为**预注册小样本**：k/N 附 Wilson 95% CI；**9/9（E06、后台 E2E 机械面）≠ 100%**，CI 下界 0.701；E05 4/9 的 CI [0.189, 0.733] 跨 0.5，不能据此区分「约五成」与更高/更低——需更大 N 或消融归因模型行为波动，**禁止重采样至绿**。
- 措辞观察为单语料（一条交办请求）、单模型（step-3.7-flash）、单窗口（无 thinking level）；不推广到其他模型/语料。
- 本轮未与历史帧对照（未预注册等效界）→ 不产出 IMPROVED/REGRESSED/NO_SUBSTANTIAL_CHANGE 结论。
- harness v1 只落受理回执的三个布尔形态（含/不含 #编号、业务名、「已受理」），未持久化回执原文；按纪律不回填、不重跑。
- 后台 E2E 的「业务名复述」用机械名逐字包含判定（截断 40 字符+省略号），模型改写即记 false——保守观测。

## 七、回退

- **提交级**：`git revert 5188ded`（实现）→ 受理侧幂等/拒绝落点/排队许可守卫撤销，故障套件回到先在红状态（`47aa761` 保留历史）；docs 提交可单独 revert。互不依赖。
- **行为级**：缺省 `runtime.dispatchMode=inline` 路径零变化（本片只在 server 渠道面与 background 委派路径新增行为）；无 schema 迁移（dedup 为进程内、拒绝落点只写既有任务行）；回退后既有单测/金样仍全绿（本片未改冻结判据与 inline 路径）。
- **证据级**：`.runtime/p7b/` 整体 gitignored，可删除/重跑；重跑即新批次，须重新标注口径（不得冒充本次 N=9）。

## 八、证据索引（`.runtime/p7b/`，gitignored）

- 回归：`final-report-tsc.txt`、`final-report-full.txt`、`final-report-fault.txt`。
- 先红/转绿：`red-1.txt`、`red-2.txt`、`red-full.txt`、`green-target-*.txt`、`green-full-*.txt`、`green-tsc.txt`。
- 绊线：`tripwire-1..4.patch`、`tripwire-1..4-run.txt`、`tripwire-restore-*.txt`、`tripwire-summary.md`。
- 探针：`probe-pool-full.{ts,txt}`、`probe-queue-capacity.{ts,txt}`。
- 黑盒：`e05/`、`e06/`（manifest/summary/report + 逐 trial run-dir）、`background-e2e/`（run-1..9/sample.json、samples.jsonl、summary.json）、`background-e2e.ts`、`aggregate-batch.ts`、`batch-summary.json`、`batch-aggregate.out.txt`、`e05-run.log`、`e06-run.log`、`background-e2e-run.log`。
- 设计：`design.md`（故障矩阵/黑盒 harness 设计/转绿记录）。
