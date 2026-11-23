# 真模型写闭环验收（`npm run eval:write-loop`）

> 状态：现行（上线前必过闸；对**仓内 dummy 执行层**跑**真模型**，零真实平台）。
> 最后核对：2026-11-19（脚本与本文同批；`path:line` 以现行代码为准）。
> 上游指针：`scripts/eval/real/write-loop.ts`（入口与判据实现）、`docs/architecture/contract.md`（契约语义面）、`docs/ops/real-read-smoke.md`（只读冒烟准备档；兄弟入口）。

本文只讲：怎么跑、判什么、产出什么证据、已知不覆盖什么。判据实现是纯函数
（`scripts/eval/real/write-loop.ts` 的 `evaluateCriteria` / `evaluateObservations`），
单测见 `scripts/eval/real/write-loop.test.ts`（正例全绿 + 逐条反向破坏必红）。

## 1. 定位

验的不是「单元测试绿」，而是**用真模型走完一次写入、并且它真的写进去了**：

```
用户交办（写一句业务话）
  → 模型（Main）task_run 委派 → Worker 向执行层发 dummy.prepare
  → 执行层返回 needs_confirmation 提案（带摘要；句柄留在宿主的会话小表里）
  → 用户回「确认」→ 模型（Main）task_confirm → runner.confirm 接续任务
  → Worker 发 dummy.commit（句柄由宿主随请求透传）→ 执行层落盘 + 自己读回验证
  → 任务写结束事实（有汇报）→ 宿主**唤醒原会话的模型**，由它把话带给用户（投递端口 sendText）
  → 本脚本经结构化契约读回该集合（记录条数与逐条内容）
```

装配面是 **server 面**（`apps/server/server.ts` 的 `createServer`：后台派发、完成唤醒、
主动投递端口、run_js 都在这里；`npm run ask` / `eval:user` 没有这些），模型是 env 里的
**真实端点**，执行层是仓内 `scripts/eval/fixtures/dummy-platform`。**脚本没有脚本模型回落**：
缺 key / 端点不通一律如实失败（exit 2），不许拿假模型冒充真模型。

## 2. 怎么跑

```sh
# 本地真跑（模型端点写在 .env 或 shell env；三者缺一即 exit 2）
LLM_API_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... npm run eval:write-loop

# 等价直跑（可用本机 env 文件，密钥不进命令行）
node --env-file-if-exists=.env.local --import tsx scripts/eval/real/write-loop.ts

# 旋钮
npm run eval:write-loop -- --out-dir <dir>        # 证据落点（缺省 .runtime/real-write-loop/<时间戳>/）
npm run eval:write-loop -- --turn-timeout-ms N    # 单回合上限（缺省 240000）
npm run eval:write-loop -- --settle-timeout-ms N  # 等后台落定上限（缺省 240000）
```

退出码：`0` = 九条判据全过；`1` = 有判据红（附逐条 detail）；`2` = 前置未过
（缺模型配置 / 主体无写权限 / 隔离门未过 / 写前基线不干净 / 执行层审计通道不可用）。

前置门（S0，全部机械）：单一 profile + gateway；主体 `wecom:fixture-writer` 开通且角色
含 write；`runtime.allowWriteOperations=true`（只写进**本次物化配置副本**，不动仓内夹具）；
profile.root 的**真实路径**在 `scripts/eval/fixtures/` 之下且 gateway 存在
（复用 `scripts/eval/safety-gate.ts` 的 `assessEvalIsolation` 事实）。

## 3. 判据清单（全部机械事实）

判据实现：`scripts/eval/real/write-loop.ts` 的 `evaluateCriteria`。`mechanical` = 底账 /
执行层审计 / 结构化读回的直接事实；`structured` = 工具调用记录（记录包装器，透传不改语义）的
结构化提取。**没有一条判模型措辞**。

| # | 判据 | 判据来源 | 通过条件 |
| --- | --- | --- | --- |
| C1 | 写前基线读回 `empty-one`/`W1` = 0 条 | 结构化 `dummy.query`（只读权限的读回面） | status=completed 且 count=0 |
| C2 | 执行层确实收到 `dummy.prepare` 并成功返回提案 | 执行层自己的 `audit.jsonl` | 至少一条 `via=structured` 的 prepare 行 `exit=0`（失败重试如实列在 detail） |
| C3 | 底账出现等待事实（pendingQuestion）与待确认提案 | 任务底账（只读第二连接，250ms 轮询） | 观测到等待事实（pendingQuestion）且 `confirmation.summary` 非空、句柄非空 |
| C4 | 「确认」回合调用 `task_confirm` 并接续任务 | 工具调用记录 | 存在 `task_confirm` 且结果 `outcome=started` |
| C5 | **写入恰好一次**且句柄被消耗 | 底账执行事实 + 执行层审计 + `confirmations.json` | commit 成功（completed）恰好 1 条、审计成功行恰好 1 条（exit=0）、`usedAt` 非空（`usedBy=dummy.commit`） |
| C6 | 写后读回 4 条且逐条 name/value 与请求一致 | 结构化 `dummy.query` | count=4 且 items 依次为 `item-1..item-4`、value 均 100 |
| C7 | 底账有汇报存档（finalReported=true）；成功 prepare 先于唯一一次成功 commit | 任务底账执行事实 | finalReported=true、存在 `dummy.prepare:needs_confirmation`、唯一的 `dummy.commit:completed` 在其之后 |
| C8 | 完成消息出现在用户可见面 | 投递端口记录 + `task_result_delivery_*` 事件 | 有非空 `push_text`，或本回合回复 + `relayed_in_turn` 抑制事实 |
| C9 | 底账事实序列按序包含 `progressing → waiting → progressing → reported` | 任务底账轮询 | 按序子序列成立（允许额外中间态） |

判据写的是机械事实，不给模型留解释空间；**不**要求执行事实恰好两条——模型的重试、
无句柄 commit 被拒（`CONFIRMATION_REQUIRED`）、Worker 事后读回都是合法事实，如实写进
detail，不当违约。写有没有重复由 C5（成功恰好一次）+ C6（读回不是 8 条）共同钉住。

## 4. 三条观察（只记录，不判红）

`evaluateObservations` 的三条，进证据但不参与退出码：

1. **提案消息里有没有执行层摘要**：已知字符串存在性——提案消息（主动投递或回合回复）
   是否包含执行层给的摘要（全文命中 + 前 40 字命中分开记）。
2. **完成那条消息是谁的话**：唤醒出口（`WakeResult`）与投递文本比对——`woken` 且两者一致
   即「模型的话」；非 `woken` 或出现宿主兜底句（`…办好了：`）即判宿主兜底路径。
3. **冗余过程话术**：固定短语表（`收到，正在处理` / `正在处理` / `请稍等` / `稍等一下` /
   `马上处理` / `这就去办`）在用户可见文本里的命中记录。**这只是已知子串命中记录，不是
   质量判据**；复核以证据里的原文为准。

## 5. 产出与证据落点

一次运行 stdout 三段，末尾落 `.runtime/real-write-loop/<时间戳>/evidence.json`（gitignored，
不含密钥；路径经脱敏替换为 `<repo>`/`<run>`/`<state>`/`<fixture>`）：

- `[任务底账]`：会话内任务数与停下事实（每个任务的执行事实序列，保序）；
- `[工具调用]`：Main/Worker 每次工具调用（工具名、参数摘要、结果摘要、耗时）——
  记录包装器（`recordingDriver`）透传不改语义，与 convergence-r1 同一形状；
- `[执行层收到的请求]`：执行层自己的 `audit.jsonl` 逐行（mode/script/via/exitCode/refused/args）；
- `[用户可见面]`：各回合回复 + 主动投递文本（原文，不截断判读）；
- `[读回]`：写前/写后结构化读回（count/sum/items）；
- `[唤醒出口]`：唤醒 `WakeResult`（outcome + 正文）；
- `[判据]`：C1–C9 逐条 PASS/FAIL + detail；`[观察]`：O1–O3；
- 机器行：`real_write_loop_precondition` / `real_write_loop_baseline` / `real_write_loop_turn` /
  `real_write_loop_audit` / `real_write_loop_readback` / `real_write_loop_criterion` /
  `real_write_loop_observation`（可直接 grep）。

## 6. 已知不覆盖（如实登记）

- **真实执行层写入**：本入口对着仓内 dummy 夹具；真实层（17dz）写入未验（其只读面见
  `docs/ops/real-read-smoke.md`）。
- **默认只读姿态**：入口把 `runtime.allowWriteOperations=true` 写进自己的配置副本；
  「缺省关闭时写请求被拒」由 `scripts/write-confirm-loop.test.ts` /
  `scripts/host-write-confirmation.test.ts` 覆盖，不在本入口。
- **取消 / 超时 / 产物 / 长任务 / 附件**：本闭环只有 prepare → 确认 → commit → 读回这条主链。
- **并发与多主体**：单主体、单会话、串行两回合；跨主体/并发不覆盖。
- **渠道面**：投递端口是假渠道（记录型），不覆盖企微真实投递、附件堆叠、进度帧。
- **幂等**：写路径的 dispatchKey 重放（同 key 不重复写）是执行层职责，本入口不验。
- **模型行为分布**：单次运行 = 一次验收，不是稳定性/通过率结论。模型可能失败
  （见 §7 的第 4 次运行），失败即红——**不重试凑绿**。
- **措辞质量**：不做任何关键词/正则式的「说得好不好」判定（仓规红线）；只有 §4 的
  三条已声明观察。

## 7. 真跑记录（2026-11-19，workbuddy/deepseek-v4.1-flash @ `192.168.100.1:3425/v1`）

> **旧 schema 标注**：本节 run 的 `status` / `reason` / `failure_reason` / `终局=` 是
> 2026-11-19 当时的字段；该 schema 已于 2026-11-23 删除，现行底账无 status/终态列，
> 收尾只追加 `task_ends(task_id + at)`（不分类）。原文保留作历史证据，不再代表现行口径。

同一入口连跑 5 次，逐次如实登记（**含红**，不筛绿）。每次的证据包在
`.runtime/real-write-loop/<时间戳>/evidence.json`（gitignored）。

| 次 | 写入是否真落库（读回 count/内容） | 判据（当时版本） | 关键读数 |
| --- | --- | --- | --- |
| 1 | ✅ 4 条、name/value 全对 | 7/8 红 C7 | 首轮 prepare 首次失败（`--records` 传 JSON 字符串）→ 改结构化成功；唤醒出口 `unavailable`（当时 harness 的 Main 驱动漏了 `reuseConversation`，已修） |
| 2 | ✅ 4 条、name/value 全对 | 7/9 红 C5/C7 | 唤醒 = **模型的话**（投递文本与唤醒正文逐字相同）；观察到 Worker 首轮**未经确认**发 commit，被执行层 `CONFIRMATION_REQUIRED` 确定性拒绝（零写入）——确认闸在工作。C5/C7 红是**判据实现**问题（按审计行数计、把被拒 commit 当违约）→ 已修订为「成功恰好一次 / 成功 prepare 先于成功 commit」 |
| 3 | ❌ 0 条（零写入） | 2/9 红 | 模型三次把 `--records` 写成字符串（JSON 串 / `k=v,k=v` / `k:v;k:v`），全被 `INVALID_RECORDS` 拒；轮末最后一条非只读执行是失败 → 旧 schema 下任务落 failed、提案没交给用户；用户「确认」时模型重开任务 #2，仍未落成 |
| 4 | ✅ 4 条、name/value 全对 | 6/9 红 C7/C8/C9 | **缺陷复现 #1**：确认回合内先两次 commit 失败（`--records` 字符串）、后一次 commit 成功（写落库、句柄消耗），旧 schema 下任务仍被判 `failed`；用户被告知「这次没能办成……」并被问「要我按原样再试一次吗？」 |
| 5 | ✅ 4 条、name/value 全对 | 6/9 红 C7/C8/C9 | **缺陷复现 #2**（最终判据运行）：确认回合 `commit(INVALID_RECORDS) → commit(completed)`，任务 #1 记 `failed / failed_confirmed`、`result_text=null`；回合回复说「已经办好了…4 条都在」，随后又推了一条「这个内容不行（名称或值的写法有问题）。我换个写法再试？」——同一件事两句相反的话 |

结论（如实）：**写入主链本身验成**——5 次里 4 次执行层真的落库，且结构化读回 4 条
name/value 与请求逐字一致（C1–C6 在 run 4/5 全过，run 5 唯一一次成功 commit、句柄
`usedAt` 非空）。**但整次验收是红的（run 4/5：C7/C8/C9）**，红的根因是下面这条产品缺陷；
run 3 则是模型自身没完成（把 `--records` 编码错三次），同样如实记红、不重试凑绿。

### 7.1 缺陷（2026-11-19 真跑发现；2026-11-19 晚已修，见本条末「修后读数」）

**标题**：确认回合里「先失败、后成功的写」被整体判 `failed`——写已落库却告知用户失败、
并引导重试（重复写风险）。

- **复现**（真模型两次、形状相同）：用户交办写入 → 首轮拿到提案（`waiting_user`）→ 用户
  「确认」→ Worker 在同一回合内先发一次参数不匹配的 `dummy.commit`（失败），再发一次正确
  `dummy.commit`（成功、句柄消耗、数据落库）→ **旧 schema 的任务底账 `status=failed`，
  `reason=failed_confirmed`，`failure_reason` 引用的是那次失败的 commit**，
  `result_text=null`（Worker 的读回汇报没有存档、更没有交付）。
- **机械证据**（run 5，`.runtime/real-write-loop/2026-11-19T11-49-31-138Z/`）：
  `executions` 序列 = `prepare:needs_confirmation → commit:failed(INVALID_RECORDS) →
  commit:completed → query:completed`；旧 schema `tasks.status=failed`；结构化读回 `count=4`、
  items 与请求一致；执行层 `confirmations.json` 该句柄 `usedAt` 非空。
- **根因位置**（不改，只登记）：后台单回合执行器的回合结局判定——
  `packages/agent/src/execution-runtime.ts:3757`（`lastWritable` 只对 `needs_confirmation`
  生效）、`:3778`（`realFailure` 一旦不是「容忍码」就放弃提案路径）、
  `:3806`（`const unsuccessful = recorded.find(entry => entry.outcome.status !== 'completed')`
  → 只要有**任何**未完成执行就判 failed，**不看之后是否又成功**）。
  同步/inline 路径同形状：`packages/agent/src/task-registry.ts:168`（`judgeReportedTask`：
  任一非 completed → failed）。
- **后果**：① 用户被如实交付的反面——成功被说成失败；② 失败话术含「再试一次」导向 →
  用户照做会**再写一遍**（本 run 读回已 4 条）；③ Worker 自己的读回汇报被丢弃
  （`result_text=null`），同一回合里模型自证的核对结果进不了用户可见面。
- **为什么没当场修**：验收纪律（不改产品行为迁就验收）。修法方向留给 owner 决定，例如
  把「回合结局」按**最后一条非只读执行**判定（与 `needs_confirmation` 同一把尺），
  或对已成功落库的写操作单独保守判定。
- **修后读数（2026-11-19 晚，分支 `fix/write-outcome-last-attempt`）**：终局改为**末次决定性
  结果为准**（写操作取最后一条非只读执行；前序失败仍逐条留在 `executions` 里）。同一入口
  实跑：修复前一次 6/9（C7/C8/C9 红，旧 schema `终局=failed`，读回 `count=4`；用户看到「这次没有写成功…
  要我再试一次吗？」）；修复后一次 **9/9**（同一形状：确认回合 `commit:failed → commit:completed
  → query:completed`，旧 schema `终局=completed`，读回 `count=4`，用户看到「已办好…读回核对结果」）。
  确定性用例（含反向绊线与 A2b 锁不挡「参数改对后的合法重试」）：
  `packages/agent/write-outcome-last-attempt.test.ts`；裁定登记：decision-log §17.2 的
  2026-11-19 复评登记。**注意**：本入口仍受模型行为方差支配——单次运行不是通过率结论，
  主模型仍可能在首轮把 `--records` 写成字符串（执行层声明 `retryable:true`，允许同回合改对再试）。
- **追加口径（2026-11-19 晚，同类危害的「成功后」形态）**：写成功之后的失败按机械判据归类——
  只读失败不翻转；同对象（A2b 对象抽取）的写失败 = 重复尝试被安全挡下、不翻转；异对象/
  取不到对象的写失败 = 另一个写没成 → **部分完成**（旧 schema 的终态仍 `failed`，`failure_reason` 逐项
  写「已完成什么、未成功什么」）。用例 ⑦–⑪ 与逐条反向绊线同在一个测试文件。

### 7.2 判据修订说明（透明登记，不含放宽实质不变量）

- run 1 红 C7：初版 C7 要求执行事实**恰好**两条（prepare → commit）。判定为**判据过严**
  ——把模型的重试与 Worker 事后读回当违约。改为现行 C5/C7（成功写入恰好一次 + 成功
  prepare 先于成功 commit）。
- run 2 红 C5/C7：C5 按执行层审计**行数**计 commit（同一次被拒 commit 会落两行
  start/result），C7 把「被拒的 commit」当违约。改为按**成功**行计数、被拒次数如实进
  detail，C7 只要求「成功 prepare 先于成功 commit」。
- 两次修订都**不**放宽「写只发生一次」这条实质不变量（C5 + C6 读回条数双保险）；原始红
  已记在上表。

### 7.3 观察（记录，不当判据）

- O1（提案消息含执行层摘要）：run 1/2/4/5 = 摘要全文命中；run 3 = 无提案可比对。
- O2（完成那条消息是谁的话）：run 2 = **模型的话**（`wake=woken`，投递文本与唤醒回合
  正文逐字相同）；run 4/5 = 未观测到唤醒出口（旧 schema 下任务被判 failed，走失败投递而非完成唤醒）；
  run 3 = 未观测到。
- O3（冗余过程话术）：5 次均未命中固定短语表。
- 非缺陷但值得知道（同一批真跑观测）：主模型在确认回合会连续 `task_result` / `task_status`
  轮询等结果（run 1 有 4 次、run 2 有 8 次），run 5 里主模型甚至另开一个「只做查询核对、
  不要写入」的新任务去自证——多花的模型回合不改变机械事实，但都是可观测的成本。

## 8. 指针

- 入口与判据：`scripts/eval/real/write-loop.ts`（`evaluateCriteria` / `evaluateObservations` /
  `recordingDriver` / `LedgerWatcher` / `readAuditRows` / `readConfirmationFacts`）。
- 绊线：`scripts/eval/real/write-loop.test.ts`（25 例；含「缺模型配置 exit 2，不落回脚本模型」）。
- 装配面：`apps/server/server.ts`（`createServer`）、`scripts/ask-runtime.ts`
  （`assembleSessionCore` / `resolveExecutionFace` / `mainSessionOptions`）。
- 写确认语义：`packages/agent/src/execution-runtime.ts`（`task_confirm` 工具、确认路径透传、
  回合结局判定）、`packages/agent/src/task-runner.ts`（`confirm()`）。
- 完成唤醒：`apps/server/task-completion-delivery.ts`（事实文本与兜底）、
  `packages/agent/src/pi-driver.ts`（`wake`）。
- 夹具：`scripts/eval/fixtures/dummy-platform`（prepare/commit 摘要与读回实现）。
- 兄弟入口：`docs/ops/real-read-smoke.md`（只读冒烟准备档）。
