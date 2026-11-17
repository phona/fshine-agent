# R4 · 稳定性加固预注册（2026-11-14）

> 授权：owner 2026-11-14（1+2）——预注册更大黑盒批次（E05/E06/后台 E2E 各 N=15）+ 浸泡/压力/混沌套件 + 手工测试手册。
> 基线：`arch/integration @ 885ac638f2353be41e651f1ea3eb9199d905017b`（启动时 HEAD 完整 SHA）；worktree `~/projects/fshine-agent-r4-stab`；分支 `arch/r4-stab`。
> 本文件**先于任何运行写死并提交**；提交后即为预注册记录，不得修改。任何修正只能走「作废对应批次/场景 → 追加新预注册记录（新 run 编号）→ 重跑」，不得事后调整阈值、样本量或断言。
> 纪律：纯测试与文档、零产品语义变更；发现的真实产品缺陷只登记、不在本 Run 修（测试基建自身缺陷可修，修后重跑记新 run，旧证据保留）；不改产品代码、冻结面（`scripts/eval/convergence-r1/criteria*`、cases、judge、runner、safety-gate、`criteria.lock`）与历史证据；不接真实平台；真实模型仅经 `.env`（gitignored，只读复制，不入证据、不提交）。

## 一、范围与硬边界

三块交付物（本 Run 授权范围）：

1. **黑盒批次**：E05、E06、后台 E2E，各 **N=15**（预注册、一次采样、不扩展、不重采样、不筛绿、全样本保留）。
2. **浸泡/压力/混沌套件**：全部使用假 executor / 假 sink / 假渠道 / 可注入时钟；场景与阈值见 §三/§四。
3. **手工测试手册**（后续交付物，见 §八；本预注册只登记其范围，不写正文）。

硬边界：不改 `packages/**`、`apps/**` 产品代码；不改既有测试判据（新套件只增不改）；不新增运行时依赖；套件只经公开装配面（`assembleSessionCore` / `createServer` / `createTaskRunner` / 通知 outbox）驱动，不 mock 产品逻辑本身。

统计口径：一切 k/N 一律附 **Wilson 95% CI**（`scripts/eval/exploration/stats.ts` 的 `wilson95`）；N=15 的 CI 宽度本身即限制（15/15 → [0.796, 1.0]，0/15 → [0, 0.204]），**不得把 15/15 读作 100%，不得读作稳定概率**。

## 二、黑盒批次（三批，各 N=15）

### 2.1 口径（运行前冻结，随报告登记）

- 模型：`step-3.7-flash`（与 P7b 帧同模型；以 `.env` 显式 `LLM_MODEL` + 运行后 `manifest.model.id` 双记录）。
- 执行层：仓内 dummy 夹具；渠道：假 sink（不实现、不连接真实 WeCom）；判定：冻结判据/用例零改动（runner `verifyLock` 必须通过；`criteriaSha256` / `casesSha256` 登记）。
- 统计：`stats.ts wilson95`；判定器版本 `convergence-r1.judge.1`（以运行时 manifest 为准登记）。
- 样本量：每场景 **恰好 15**；一次采样；失败样本不替换、不补跑、不筛绿。

### 2.2 B1/B2：E05×15、E06×15

逐字命令（在 worktree 根执行；`TMPDIR` 按本仓约定）：

```bash
TMPDIR=~/.tmp LLM_MODEL=step-3.7-flash npm run eval:user -- --case E05 --trials 15 --out-dir .runtime/stab/e05
TMPDIR=~/.tmp LLM_MODEL=step-3.7-flash npm run eval:user -- --case E06 --trials 15 --out-dir .runtime/stab/e06
```

逐 trial 证据 schema 与 P7b 同（`runs/E05/trial-1..15/`：inputs/model/toolcalls/transcripts/audit/executions/reply/meta/judgment）；判负逐条归因（模型面/机械面/infra）。

### 2.3 B3：后台 E2E×15（机械面）

- harness：`.runtime/stab/background-e2e.ts`（证据域文件，gitignored；版本串 **`stab-background-e2e-v1`**），与 P7b `p7b-background-e2e-v1` **同构**：`assembleSessionCore`（background + 真实 Pi driver + 仓内 dummy 执行面 + RecordingSink），每样本独立 config 副本 / db / state / session，`run-1..15/` 目录 + `samples.jsonl` + `summary.json`。
- 交办语料与 v1 相同（一条请求，逐字复用）：`帮我查一下 documents 集合在 W202611 窗口的数据。`
- 路径：交办 → Main 快速受理 → 后台 TaskRunner（真实 Worker 回合经 dummy）→ `completed` + `resultText` 存档 → 通知三态经假 sink 投递 → `tasks` CLI（真实入口）找回。
- 机械面指标（每项 k/N + CI）：delegated、completed、resultText 可找回（详情 + CLI 逐字包含）、通知三态送达（`accepted/started/completed` 全 `deliveredAt` 且假 sink 实收三类）、mechanicalPass（上述合取）。
- 措辞面观察（只登记、不设门槛）：回执含 `#数字编号`、复述业务名（机械名逐字包含）、含「已受理」。
- 运行命令（harness 完成后逐字执行并登记）：

```bash
TMPDIR=~/.tmp LLM_MODEL=step-3.7-flash node --env-file-if-exists=.env --import tsx .runtime/stab/background-e2e.ts
```

### 2.4 黑盒报告纪律

- 报告只呈现读数：k/N + Wilson 95% CI + 失败分布 + 逐条归因 + 限制；**只读数，不作达标/稳定/可靠结论**。
- INCONCLUSIVE 不计入 k；无 history 帧对照（未预注册等效界）时不产出 IMPROVED/REGRESSED 类结论。
- 措辞面 k/N 同样附 CI，但不设「全过」门槛，不与机械面混计。
- 报告产物：`docs/product/r4-stability-report.md`（后续 ask 产出）；证据索引指向 `.runtime/stab/{e05,e06,background-e2e}/`。

## 三、浸泡/压力/混沌套件（假件；确定性）

### 3.1 文件与红绿约定

| 套件 | 测试文件（提交物） | harness（先红时缺失） | 场景 |
| --- | --- | --- | --- |
| 浸泡 | `scripts/stab/soak.test.ts` | `scripts/stab/soak-harness.ts` | S1、S2 |
| 压力 | `scripts/stab/pressure.test.ts` | `scripts/stab/pressure-harness.ts` | P1、P2、P3 |
| 混沌 | `scripts/stab/chaos.test.ts` | `scripts/stab/chaos-harness.ts` | C1–C4 |

TDD 轨迹：**先在红**（测试先行提交，harness 缺失 → 3 文件 collection 失败）→ 最小实现 harness 转绿 → 反向绊线（≥3 类）→ 全量 `npm test` 绿。

假件清单（全部无网络、无真实模型、无真实平台）：假 executor（可控回合时长/结果/取消观察/调用计数）、假 sink（成功/`delivered:false`/抛错注入 + 实收记录）、假渠道（`server.handler` 同 messageId 重投）、可注入时钟（租约/退避推进）、真实装配链（`assembleSessionCore` / `createServer`，产品逻辑零 mock）。

套件命令（红期与绿期同一入口）：

```bash
TMPDIR=~/.tmp npx vitest run scripts/stab/soak.test.ts scripts/stab/pressure.test.ts scripts/stab/chaos.test.ts
```

### 3.2 场景（参数逐字冻结）

**S1 持续顺畅（浸泡）**：`cycles=10 × perCycle=50`（500 交办）；`concurrency=4`；`queueCapacity=64`；每 cycle 交办后 `whenIdle` 排空再进入下一 cycle；假 sink 恒成功。断言：提交=500、受理=500、拒绝=0；全部 `completed`；§4 全部不变量。

**S2 浸泡 × 通知间歇失败**：S1 参数 + 每 3 次 sink.send 失败 1 次（有界重试 + 注入时钟推进；尝试上限 5）。断言：任务结果不变（全部 `completed`）；恢复后 §4-I4 未送达=0；同一通知成功投递 ≤1 次。

**P1 积压 500（受控排队）**：`backlog=500`；`concurrency=2`；`queueCapacity=512`；一次性提交后 `whenIdle`。断言：提交=受理=500、拒绝=0；全部 `completed`；§4 全部不变量。**只读数（非门槛）**：policy 队列深度峰值、底账 queued 峰值（`queueCapacity>0` 上界未强制为已登记 blocked，见 §九，不据此判负）。

**P2 池满持续（确定性拒绝）**：`backlog=500`；`concurrency=1`；`queueCapacity=0`；首任务挂起（hold）至提交结束。断言：受理=1、拒绝=499；拒绝任务终态 `failed` + `reason=resource_limited`（`terminalReasonCounts.resource_limited=499`）；首任务放行后 `completed`（运行中不受损）；提交期间前台回合可用（`foregroundRoundTrips>0`）；无 queued 残留；§4-I1/I2/I4/I5。

**P3 压力 × 通知间歇失败**：P1 参数 + 每 5 次 sink.send 失败 1 次。断言：拒绝=0；全部 `completed`；恢复后未送达=0；§4-I1/I2/I3/I5。

**C1 重启 × 通知失败**：`tasks=20`；`concurrency=1`；`queueCapacity=32`。phase-1：sink 恒失败（有界重试停止），部分任务完成、部分 queued/running 后关停；phase-2：同库新进程（`now` 越过租约）+ 健康 sink：pump → 收尾 → 注入时钟推进投递。断言：`restartCount=1`；completed 任务 `executions` 零新增（`replayedCompletedTasks` 空）；过期租约 `failed`+`result_unknown` 且零重放（`leaseExpiredReplays=0`）；queued 重领；通知不重复（`duplicateNotificationRows=0`）且恢复后未送达=0；§4-I1/I2/I3。

**C2 重启 × 重复消息**：`tasks=20`；同 process 内假渠道同 messageId 并发重投 → 回执幂等重放；随后重启。断言：`receiptReplayIdentical=true`；`tasksCreatedByDuplicate=0`；`executionsByDuplicate=0`；重启后 `replayedCompletedTasks` 空；§4-I1/I2/I3/I4。（跨重启 messageId 查重为已登记 blocked，见 §九，不作门槛。）

**C3 取消 × 通知失败**：`tasks=20`；运行中任务 `cancel`（执行端观察 abort signal 后返回 `cancelled`/抛 AbortError）；sink 失败。断言：`cancelledConfirmed=true`；终态 `cancelled`（非 `cancelling` 滞留）；该任务无第二次执行；`cancelled` 通知恢复后送达、未送达=0；§4-I1/I2。

**C4 全组合（重启×通知失败×重复×取消）**：`tasks=30`。顺序：提交 → 部分完成 → 取消一个运行中任务并**确认取消后**再重启（避免与已登记「cancelling 孤儿恢复」缺陷纠缠）→ 重复消息重投 → sink 间歇失败 → 重启 → 恢复投递。断言：§4 全部不变量 + `receiptReplayIdentical=true` + `tasksCreatedByDuplicate=0` + `executionsByDuplicate=0` + `cancelledConfirmed=true` + `replayedCompletedTasks` 空 + `leaseExpiredReplays=0` + `duplicateNotificationRows=0`。

### 3.3 反向绊线（绿阶段要求，≥3 类）

逐条实做破坏 → 对应场景红 → 逐字节复原；证据 `.runtime/stab/tripwire-*.{patch,txt}`，全仓 `TRIPWIRE` 残留=0：

1. 破坏重复消息查重（`server.ts` 幂等分支）→ C2 红；
2. 破坏取消确认（请求直接 `confirmCancelled` 或确认前宣称 cancelled）→ C3 红；
3. 破坏通知去重/有界重试 → S2/P3 红；
4. 破坏租约过期不重放（过期改回 queued）→ C1 红。

## 四、共同不变量与阈值（逐字判定）

| 编号 | 不变量 | 判定（机械读数） |
| --- | --- | --- |
| I1 | 无重复副作用 | 每任务 executor 调用数 = 1（取消回合不产生第二次执行）；通知行按 `(task_id, kind, state_version)` 无重复；同一通知 sink 成功投递 ≤1 次；重复消息新增任务/执行 = 0 |
| I2 | 无挂死 | harness 内部有界等待（单场景收尾预算 45s）内 `whenIdle` 返回；报告 `hung=false`；结束时无在飞回合 |
| I3 | 队列归零 | 排空后 `queued/running/waiting_user/cancelling` 残留 = 0；policy `snapshot().background.active = 0` |
| I4 | 通知未送达 = 0 | 最终 `deliverPending`（含注入时钟推进越过退避）后 `undelivered = 0` 且全部行有 `deliveredAt` |
| I5 | RSS 增长 < 10% | 预热后基线（中位数 3 次采样）→ 场景结束（中位数 3 次采样）：`(end − base) / base < 0.10`；同进程粗粒度观察 |

阈值违反 = 该场景 red 读数：留档、归因、登记；**不修产品**（产品缺陷登记；测试基建缺陷修复后重跑记新 run）。RSS 为粗粒度观察（worker 复用可能有噪声），以预热 + 中位数缓解；超出即红，不做「稳定」结论。

## 五、停止规则

1. **黑盒批次**：一旦开始，不因中途读数（无论好坏）提前停止；跑满 N=15。运行前 infra 门失败（缺 key、`verifyLock` 不符）→ 批次不开始、不消耗样本；运行中崩溃/中断 → 已产出样本保留、本批作废并登记，**不补跑、不重采样**；重跑必须作为新批次（新预注册记录 + 新 run-dir）。**禁止重采样至绿。**
2. **套件（浸泡/压力/混沌）**：单场景看门狗 15 分钟（挂钟）无收尾 → 判挂死（I2）并终止、保留证据；任一阈值违反 → 该 run 留红，不重跑刷绿；修复仅限测试基建，修后**整场景重跑并记新 run**（run-2…），旧证据保留；同因连续 2 次失败（跨 run）→ 停该套件并登记 blocker。
3. **环境性失败与产品性失败分开登记**（OOM / tmp 满 / 机器负载 vs 产品缺陷）；环境噪声读数不作任何达标结论。
4. 全程：不修改产品代码、冻结面与历史证据；发现真实产品缺陷只登记（写入报告与缺陷登记表，修复归后续 Run）。

## 六、证据布局（`.runtime/stab/`，gitignored；只增不改）

```
.runtime/stab/
  baseline.txt                      # worktree / 分支 / 基线 SHA / 时间 / node 版本
  red-*.txt                         # 先红证据（套件 collection 失败、tsc、全量）
  e05/  e06/                        # eval:user 批次（runs/E05|E06/trial-1..15/）
  background-e2e/                   # B3：run-1..15/ + samples.jsonl + summary.json
  background-e2e.ts                 # B3 harness（版本 stab-background-e2e-v1）
  suites/run-<n>/                   # 套件各 run 报告与原始输出
  green-*.txt  tripwire-*.{patch,txt}   # 绿期与绊线证据
```

## 七、判定与报告纪律

- 黑盒：只读数（k/N + Wilson 95% CI + 归因 + 限制），**不作达标/稳定结论**；N=15 的 15/15 不得读作 100%（CI 下界 0.796）。
- 套件：阈值逐字判定（I1–I5），红即红；反向绊线必须实做。
- 一切报告保留失败与 blocked；不得以「未跑」冒充「通过」；INCONCLUSIVE 不计正。
- 与 P7b 帧的关系：E05/E06 可为同口径新批次（N=15），措辞观察与机械面分开呈现；不与 N=9 帧做统计优越性结论。

## 八、手工测试手册（后续交付物登记）

- 交付物：`docs/product/r4-stability-manual.md`（文件名暂定；后续 ask 产出）。
- 预注册范围：环境准备（`.env`/配置/dummy 执行层）、可手工执行的清单（启动、交办、进展通知、结果找回、取消、重启恢复、故障注入开关、看门狗与清理）、每步预期与记录格式、判定口径（手工证据**不替代**自动化门、不产达标结论）、禁止项（真实平台、真实凭据、写操作）。
- 手册正文不在本预注册内；其判定口径不得与 §四/§七 冲突。

## 九、blocked 登记（只读数、不作本次门槛）

| blocked 项 | 事实（P7b 登记口径） | 本 Run 处置 |
| --- | --- | --- |
| `queueCapacity>0` 底账队列上界未强制 | policy 排队许可与底账 queued 行未合一（触冻结 §2 接口须 owner 批准） | P1 只读数（深度观察），不据此判负 |
| messageId 幂等跨重启不保持 | 进程内有界 FIFO（1024）；跨重启/多实例不保持 | C2 只在单进程内评查重；跨重启重复按观察登记 |
| cancelling 孤儿恢复 | P6 §七遗留 | C4 取消确认后再重启，绕开该缺陷；出现即登记 |
| waiting_user 无租约接续 / queued、waiting_user 超时计时触发 | P6 §七遗留 | 不在套件门槛内；出现即登记 |
| `taskBudget` 运行时 consume 未接线 | 集成报告 §四.3 | 预算场景不设门槛 |
| 真实 WeCom sink / 多进程/多实例 / ops 通知清单 | P4/P7b blocked | 不接、不测；如实登记 |

## 十、预注册冻结声明

本文件提交后，§二/§三 的场景、阈值、样本量与断言即为冻结记录；运行后新增的一切数字只能写入报告（`docs/product/r4-stability-report.md`）与 `.runtime/stab/` 证据，不得回填本文件。若发现本预注册自身缺陷（如场景不可实现、断言与登记 blocked 冲突），处置为：保留原文 → 追加「修正记录」小节（新日期）→ 作废对应批次/场景并重跑新编号；不得静默修改。
