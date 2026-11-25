# 交付交接单（冻结基线快照）

> 状态：现行（交接快照；数字以第三节冻结基线为准，其后仅文档变更不改结论）。
> 最后核对：2026-11-20。
> 上游指针：`docs/decisions/index.md`（决定与状态）、`docs/decisions/debt.md`（未清债务与接受不修项）、`docs/product/capability.md`（用户级能力台账）、`docs/architecture/capability-boundary.md`（能力边界判据档）。

## 一、这一版是什么

Pi Agent（Main）+ 最小宿主 + Execution Contract + Channel Adapter 的产品面：用户用业务语言交办，Main 有承诺权与汇报权但**无执行权**，Worker 按清单拿 `op_*` 工具执行但不直接对用户说话，宿主只做身份/时机/事实/凭据/投递与记账。写事务由执行层裁决（确认是显式动作），状态变化一律唤醒 Main 由它带话给用户。

## 二、这一版交付了什么（八刀，均带守卫）

1. **四项 P0 修复**：底账投影按末次决定性结果、提示词条款冲突、P4 守卫假绿洞、W-43 节拍竞态。
2. **能力边界判据档**：`docs/architecture/capability-boundary.md`（四角色权界、单一来源能力目录、结构化交办、三条禁令；未实现处逐条标注）。
3. **泄漏扫描通用断言**：内部词/任务编号单一词表 + AST 静态守卫（注释/删除/改名即红），接入写闭环、场景集、eval:user 三个用户级批次，命中即机械失败。
4. **Worker 动态工具**：每个 operation 一个 `op_*` 工具、参数用业务字段名；`hostOnly` 机制参数（`--apply`/`--confirmation`/`--count` 等）不进模型面；宿主负责句柄注入与计数自算。
5. **能力目录**：`capability?: string` 派生目录（禁止手写清单）、Main 一句摘要 + 只读 `capabilities()`；做没做成由 Main 读执行行与 worker 汇报判断并转述——宿主不产 outcome 词（旧 `classifyOutcome` 五态分类器已随 S1 删除，`task-outcome.ts` 仅剩失败话术）。
6. **确认回合 = 已确认提案**：确认续跑的任务内容切成提案载荷原文，旧交办 prose 让位；执行层绑定校验保证旧值不可覆盖。
7. **机制参数封死**：`op_*` 工具参数结构化校验，未知字段/`--` 前缀键确定性拒绝且执行层零调用；夹具改走内部 exec 路由。
8. **E11 判据机械化**：删掉 20 词拒绝词表，换成「**写面执行行零 completed** + 无成功宣称」+ 非空下限（2026-11-24 起口径；原「结构化 outcome ∈ {unsupported, blocked}」已随删 status 移除——outcome 分类器已删）。

## 三、冻结基线与门（怎么复核）

- 分支 `arch/integration`，收尾提交 `1b230ef8`（2026-11-21；此前的 `e0f105e0` 是交接快照，其后为可靠性/对话面整备）。
- 确定性门（S1 删 status 前的冻结基线）：`npm run typecheck` exit 0；`npm test` → 269 文件 / 2736 passed（1 skipped / 3 todo）；`node --import tsx scripts/eval/wecom-sim/run.ts` → 48/51、失败 0（3 条 SKIP 有登记理由）；文档守卫 30 passed（docs-guard / product-capability / coverage-matrix）。
- **S1 删 status 后基线变动（2026-11-24，本 PR 对账；读数为每次提交前实跑）**：**净增 2 个测试文件**——退役 6 个只锁旧终局机的表征测试（`task-outcome.test.ts`、`task-status-boundary.test.ts`、`write-outcome-last-attempt.test.ts`、`task-store-migration-v3.test.ts`、`last-decisive-failure-code.test.ts`、`task-outcome-reason.ts` 及其用例），新增 8 个结构性守卫（`task-lifecycle-enum-guard`、`task-liveness-only`、`task-liveness-zero-state`、`task-liveness`、`termination-events`、`task-store-zero-state`、`task-store-migration-v6`、`alert-persistence` 等）。**退役表征测试由结构性守卫取代，不是覆盖率倒退**——判据见 `docs/architecture/tasks.md` §1。各提交实跑读数（以当次 PR 正文为准）：`f0fa7104` = tsc 0 / 277 files / 2783 passed / 0 failed。**权威读数以合并前最后一次实跑为准，PR 正文里过期数字不算。**
- 真模型稳定性读数（冻结 `5105b795`，独立复核逐份核过产物）：写闭环 **5/5 全绿**（C1–C10）；场景集 **24/24、24/24、22/24、24/24、20/24**；`eval:user` **14/15、15/15、13/15+1 INCONCLUSIVE**。9 处红经逐条拆解：模型旅程方差为主，另含 1 条 taskId 泄漏与 2 个判据形状问题（已修，见下）。
- 判据换形后的确认批次（`1b230ef8`/`99af8382`，代码面零差异）：`eval:user` **15/15 ×2**（零 FAIL/INCONCLUSIVE，failureCodeHistogram 空）、场景集 **24/24 ×2**、写闭环 **C1–C10 ×1**；泄漏 0、对话形态 0。**E11** 两次均 PASS（只读 1 次 + 零写 + 如实拒绝；`UNNECESSARY_DELEGATION_WARN` 按用例定义为 WARN 不判负）、**E14** 两次均 PASS（回复点出执行层维度取值）。
- **S1 删 status 分支的 eval:user 读数（2026-11-24，runId `evalr1-2026-11-24T06-53-46-135Z-2ae6c6`）**：14 PASS / 1 FAIL，唯一红 = **E04 `FAIL_NEEDLESS_CLARIFICATION`（判定器缺陷，不是产品退化）**——turn-2 末尾「请确认这两个窗口是不是本来就应当不同」命中 `forbiddenQuestionTopics` 短语，而同轮 `requireRowArgs {collection: documents, window: W202610}` 命中（两个窗口都逐字转发、completed、数值与冻结期望一致），说明问的是数据语义不是复问已给值。这已是该锚点同族第 3 次误伤（2026-11-13 第三次冻结修过一次），按 AGENTS.md「同族第 3～4 次换判据形状」改为**机械事实门控**（参数已转发 → 降级弱告警），机械判负 `FAIL_WRONG_OBJECT` 未动。离线复判 15 份证据：mismatch 集合 = E04-1 一条（FAIL→PASS + 一条弱告警），其余 14 例逐字节复现 → **15/15**。登记见 `docs/history/decision-log-part02-2026-11.md` §十六第六次冻结。
- 泄漏扫描（单一入口 `packages/agent/src/user-visible-scan.ts`；2026-11-25 从 `scripts/eval/shared/` 搬进 `packages/`——**eval 和 live 是同一条链，只是出口一个是 Mock 一个是企微**，闸放在 eval 目录下生产零接入）：内部词表 + `#N` 编号形态 + **taskId 形态 `task_[A-Za-z0-9-]{8,}`**（2026-11-21 加，源自 live 实测「任务号 task_db2b3ca3」）+ live 实测冻结的四条工具块标记；接进四个用户级批次、wecom-sim 与 **live 出站口**（`apps/server/task-completion-delivery.ts` 的 `deliverText`：命中即不投递、记 `task_result_delivery_leak_blocked`）。**只接了后台推送这一条出口**——回合内正常回复（`packages/channel-wecom/src/adapter.ts` 的 handler 回复）、宿主渲染的通知/附件追问/owner 告警都不扫，2026-11-20 那次 DSML 泄漏正是回合内路径；有意不接与理由见 `../decisions/debt.md` R-12，别把这条读成「生产已全接」。另外生产只拦 **leak 档**（内部词/taskId/工具块标记），style 档（`#N` / `编号 N`）归 eval 记违规——业务编号是用户要用的内容，拦它等于丢整段话。
- 判据换形（2026-11-21）：**E11** 的隔离判据从「任何执行行」改为「**零写面执行**」（只读允许——产品会先读后判）；**E14** 的措辞族换成**执行层已知字符串存在性**（华远贸易/明达物流/新程科技 任一）。两处都保留了对象身份/重试上限/零写/无成功宣称等机械硬判。
- **PR 审查流水线（grok，2026-11-21）**：`.github/workflows/grok-pr-review.yml`（on pull_request；Grok Build CLI 只读审查，链路 build-prompt → grok → extract-review → render-review，机制从 bontop-design-log 整机移植；有 blocking 才 REQUEST_CHANGES，永不 APPROVE）。依赖 secret `GROK_AUTH_JSON`（OAuth 登录，非 API key；2026-11-21 已设置并在 PR #75 上实测发出过审查；令牌刷新行为与恢复步骤见 `.github/grok/README.md`——实测 refresh token 可重复使用，CI 自动刷新不会立即作废 secret 副本）。**2026-11-24 第二次凭据失效**：CI 1 秒内 `Not signed in` exit 1（不是模型/分块问题）；本地 `~/.grok/auth.json` 仍有效但**直连 x.ai 不通、必须挂代理** `http://192.168.100.1:7890` 才能自证，修法 = `gh secret set GROK_AUTH_JSON < ~/.grok/auth.json`（stdin、不 echo）。
- **PR #76 第九轮 grok（2026-11-24，review `6035662899`，COMMENTED）**：**0 blocking**——「S1 的可执行迁移与『排队行继续可认领、等待形状保留、有失败码时沉默兜底不说办好了』这条主路径，和设计文档、v6 测试一致」。剩 3 major + 3 minor + 1 nit：① 空码失败（= debt M7，owner 裁不修）；② **提案之后执行层拒绝、模型沉默时用户只看到提案摘要**（`selfConfirmBlockedRoundOf` 删容忍码的直接后果，测试已冻成 waiting_user——用户可能对已被拒绝的写回「确认」，但执行层会再拒一次、不会双写；要不要在沉默兜底里带上「这次写被执行层拒绝了」这条机械事实待 owner 裁）；③ auto 模式（owner 裁保持）；④ 残留提问当等待（**已修** `34614967`）；⑤ 迁移文件头注仍写排队行写成已停（**已修**，函数头注上一轮已改、文件头注漏了）；⑥ `executor_failed` 话术「没办成。要重发，还是先核对？」在部分落地时仍诱导重发（待 owner 裁——用户可见词面变更）；⑦ confirm 的 JSDoc 还写过期即零执行（**已修**，我删过期预判时漏的注释）。
- **PR #76 第八轮 grok（2026-11-24，review `6035329392`，REQUEST_CHANGES）**：1 blocking + 3 major + 1 minor + 1 nit。**已修 blocking**：business-e2e 采集两份逐字相同的「事件 → 事实增量」表在终局事件改名（cancelled/timed_out/resource_limited → user_stop/deadline_reached/capacity_blocked）后都没跟上，未知事件走 `?? {}` 回落 `ended:false`，取消/到点/容量拒绝被采集成「还没结束」，d6 活跃峰值虚高——而 d6 单测自己手写 `ended:true`、不经过这条映射，门禁可以全绿。修法 = 收成一份 `scripts/eval/business-e2e/task-facts-collect.ts`（按 `TaskEventKind` **穷尽**声明，底账再改事件名编译期就红）+ 行为绊线 `task-facts-collect.test.ts`（走真 `createSqliteTaskRegistry` 的 markCancelled/markTimedOut/noteResourceRefused → onTaskFact → 投影，不手写 ended；反向破坏实测转红）。**留给人看的 3 major / 1 minor / 1 nit**（按 AGENTS.md 铁律不自动修）：① 设计文档 `docs/design/task-redefinition.md` §7 与迁移实现相反（**本 PR 自己造成的文档偏离，已随手改齐**：排队行继续排队、等待形状不清）；② `lastFailureFactOf` 在 failed/refused 但 code 与 message 皆空时剥成 `{}`，宿主兜底会走到 completion 话术——**owner 2026-11-24 裁「登记不修」**（debt M7）：契约 `ExecutionFailure` 的 code/message 双双必填，类型层已堵住，今天无可复现路径；触发条件 = 17dz 实测吐空码；③ `--permission-mode auto` + auth.json 在 `$HOME` + prompt 含不可信 PR 正文——**owner 2026-11-24 裁定「就用 auto，不改」**：威胁模型算下来是零增量（fork PR 被 guard 挡死、secret 不恢复；有推送权限的人本来就能改 workflow 读走 secret，README 已承认），收窄 auto 买不到东西还可能打回 11-23 的管道读修复；④ `taskFactReadingOf` 用 `pendingQuestion !== undefined` 当 waiting、不看结束事实——**已修**（抽成 `apps/server/task-fact-reading.ts` 纯函数，`waiting` 改调 `@fshine/core` 的 `taskWaitingOf`；绊线 `task-fact-reading.test.ts` 走合成底账行，反向破坏实测转红）；⑤ task-runner 注释写已删除的 `cancelled` 事件名（**本 PR 改名造成的，已改**）。
- **换形的已知覆盖缺口（如实登记，2026-11-21 独立审查 major）**：E11 的「用户得知办不了」只剩**非空下限**，不做语义断言（只复述需求/拖延也会 PASS）；对话形态 ③ 对**有归属**推送不做措辞判定（话题相关性归用户级 eval）。两者都是为避免措辞族假红而收紧的边界，不是"门禁已全覆盖"。
- **卡在 processing 的重投消息（2026-11-21 独立审查 blocking 修复）**：不重复执行；宿主回的如实兜底是「这条消息上次没办完（我这边中途中断过），我不会重复执行它，结果未知——麻烦你重发一次。」（原文案「还在办、办完会发你」在上一进程已死的条件下是假话，已删）。
- 独立复核做法（可复制）：① 复跑四门；② 亲手破坏三个最强守卫（Main 工具面精确集合 / 机制参数拒绝 / 内部词 AST 守卫）必须红、恢复必须绿；③ 故意放宽一条守卫 + 注入回归，看是否被**其它**测试抓住；④ 逐条把文档里的「对现状的陈述与指针」对代码核（`docs-guard` 只校验行号存在与不越界，不校验指对没有）。
- 对话形态门（2026-11-21 起，**已实现为共享断言层** `scripts/eval/shared/conversation-shape.ts`，接进 wecom-sim / 写闭环 / 场景集 / eval:user 四个面）：每条用户消息 ≤1 条回合回复；同一事实 ≤1 次（回合内已交付的终态不再重复唤醒）；非线程推送必须自含话题（降级回复由宿主加原话引用行；**无归属**推送按原话片段/任务名判——有归属的推送不判措辞，宁漏勿误，见模块头「已知边界」）；不错挂（回复不挂到别的消息/别的话题上）。判定用宿主记账里的 `(taskId, factEvent)` 归属（factEvent = 唤醒出口的原始事件名，不是任务级结果词），不靠措辞。首批守卫 = live 两缺陷与其常跑化：缺陷 A（回合内终态抑制 `1a719936`）、缺陷 B（降级引用行 `e0bad29e`）、要求 C（wecom-sim M 组 L1 常跑用例 `ca2dee09`）、断言层（`cd1276ff`）。
- **可观测性门（2026-11-21，模型调用用量与延迟，owner 批准的最小方案：不建新表、不碰模型面）**：每条 assistant 消息（正常与 error/aborted 都算）落一条用量记录到 `<dbPath 同目录>/usage.jsonl`（Main/inline Worker 与后台 Worker 同一文件；采集=`packages/agent/src/pi-driver.ts` 的 `onModelUsage`，落盘=`packages/agent/src/model-usage.ts`，写失败只记 `model_usage_write_failed` 不影响回合；行里只有计量字段，无正文/工具参数/prompt）。复核：①usage.jsonl 存在且每回合至少一条（跑一轮 `npm run ask` 后见新行）；②报表可跑：`npm run usage -- --since 7d`（按 (principalId, day) 分组，含 p50/p95 耗时与首字延迟、输出 tokens/s；空数据「无数据」exit 0）。**告警阈值待基线，不拍脑袋定**——先用报表攒基线，再决定是否进告警规则。

## 四、明确未覆盖（不许当已验）

| 面 | 现状 |
| --- | --- |
| 真实执行层 17dz | 确认句柄未实现 → **真实写不可用**；只读接入=准备档、未授权；`capability` 未声明（走退化路径，行为同今日） |
| 真机企微 live | 只有假 SDK + dummy 的渠道级 sim；真网络时序、气泡观感、真实文件上传下载未验（debt #74） |
| 其它模型 | 全部证据只覆盖 `workbuddy/deepseek-v4.1-flash`（Main=high / Worker=medium）；换模型即新基线 |
| CI nightly | 配置就绪但当前工作线未合 `main`，首次真实运行未留档（见 `README.md` 测试与评测一节） |

## 五、必须先知道的风险

1. **长连接断连窗口的消息会丢**（已实测）：停服 `12:02:15Z` → 重连 `12:03:43Z` 期间用户发 2 条，重连后底账零新增、`aibot_msg_callback` 帧 0 → 平台不补投、产品无补拉。缓解已落地：`systemd Restart=always`（窗口秒级）、心跳 15s、`message_still_processing` 接进程内告警（规则 `message_stuck`）；销账条件=切 Webhook（平台最多 3 次重试）+ 既有 messageId 幂等底账接重投。详见 `docs/decisions/debt.md` §十二。
2. **宿主不再判「汇报可不可信」**（2026-11-24 删结论机）：worker 的汇报原文一律原样存档，含它自称的「办好了」。纠正靠两条——① 模型醒着：Main 读账本执行事实自己判；② 模型沉默：兜底只按机械失败事实说「没办成 / 结果未知」，不复述汇报里的成功宣称。见 `docs/decisions/debt.md` §十一 M2。
3. 其它未清债务见 `docs/decisions/debt.md`（含 §五「接受不修 / 登记不修」）。

## 六、上线前建议（按收益排序）

1. **进程守护（安装件已入仓；本机按 owner 决定不装）**：`scripts/ops/fshine-systemd.sh`（`print` / `install` / `uninstall`，幂等、用户级单元、`Restart=always`，开机自启需 `loginctl enable-linger`）。装到任意部署机上即可把停机窗口压到秒级；本机（`fshine-agent-int`）现状=未安装、手动 `npm start`。
2. ~~心跳 30s → 15s~~ **已落地**（`52eaa0b2`，随 `fix/reliability-small` 并入）：适配器以 `heartbeatInterval=15000` 建 WSClient。
3. ~~`message_still_processing` 接进行内告警~~ **已落地（2026-11-21）**：进程内告警新增规则 `message_stuck`（含 messageId 与 principal/session，不含消息正文；冷却去重与双出口沿用既有）。
4. 若要「消息不丢」作为硬指标：评估 **Webhook 模式**（平台自带最多 3 次重试，我方幂等底账可接住重投），需公网回调地址 + 签名校验 + AES 解密。

## 七、接手第一小时

```
export TMPDIR=~/.tmp          # 本机约定：不设会踩 /tmp 容量
npm run ci                            # = typecheck + unit 单 project
npm start                             # 起渠道服务（单实例锁：apps/server/main.ts:53）
node --import tsx scripts/eval/wecom-sim/run.ts   # 渠道级不变量，约 2 分钟
npm run eval:user                     # 真模型用户级黑盒（需 .env 里的 LLM 配置）
```
排障从 `docs/ops/README.md` 起；告警看 `docs/ops/alerts.md`；写闭环与 live 重放见 `docs/ops/real-write-loop.md`、`docs/ops/live-replay.md`。
