# 结构化事件观测字典（29 个）

> 核对基线：`23ae585`（`arch/doc-events`，2026-11-17）。本文**只读代码**整理，不改产品代码。
> 2026-11-17 观测面补口（`arch/obs-wiring`）新增 2 个事件（`file_ref_unavailable`、
> `task_output_sweep_skipped`）并扩展 `inbound_files_registered` 覆盖纯附件路径——见 §一 标注
> 「补口」的行；原有 27 个事件的名字与字段均未改名/删字段。
> 范围 = 仓内产品代码里以 `{ event: "<name>", ... }` 形式发出的 29 个结构化事件；`packages/channel-wecom/src/adapter.ts`
> 与 `apps/server` 的 `wecom_*` 系列（12 个，`grep` 核实）不在本清单内，另行登记。

## 口径

- **事件**：以一行 JSON 打到 stdout（或注入的 logger）且带 `event` 字段的对象；类型定义/类名不算。
- **消费方**：仓内**读取**该事件的地方（测试断言、评测脚本解析、指标/审计加工）。部署侧对 stdout 的采集/人工排查
  是普遍下游，**不**单独计为消费方（否则「发了没人用」恒为空）；仅当仓内有具体读取者才写文件名:行。
- **测试断言**：测试里按事件名（`line['event'] === '<name>'`）或按 runtime 回调对象断言。只断言用户话术/底账行、
  不读事件本身的，记为「否」。
- 行号均为上述基线下的行号；多发出点事件列全部关键点。补口新增行按补口后（`arch/obs-wiring`）行号标注。

## 一、宿主回合事件（`apps/server/server.ts`，15 个）

| 事件 | 发出点（文件:行） | 触发条件 | 消费方（文件:行） | 测试断言 | 备注 |
|---|---|---|---|---|---|
| `file_delivery` | `apps/server/server.ts:395`（`status=delivery_unavailable`）、`:400`（`suppressed`）、`:432`（`delivery_failed`）、`:445`（`sent`） | 回合产出文件后走投递：无投递端口 / 端口非 live / `sendToConversation` 抛错 / 投递成功，各记一条 | 测试：`apps/server/server-cap01-delivery.test.ts:195-205`、`:253-257`、`:297-299`、`:346-352`；`apps/server/channel-mode.test.ts:443-458`。评测：`scripts/eval/cap01/r2c-artifacts.ts:793-798`、`scripts/eval/cap01/r2-functional.ts:726-732`、`scripts/eval/cap01/r7-faults.ts:677-678`、`:746`、`:813` | 是 | 一个事件名承载 4 种 `status`；`files` 是 `(sha256,文件名)` 去重后的**实际**份数（去重项不另发事件）。`server.ts:133` 注释把 status 值 `delivery_unavailable` 写成了「事件」，措辞易误读。 |
| `file_delivery_log_write_failed` | `apps/server/server.ts:449` | 投递已成功、写 `file_delivery status=sent` 时 logger 抛错（R7-F3 降级） | 测试：`apps/server/server-cap01-delivery.test.ts:228-230` | 是 | 降级事件本身也写不进时 `:455-457` 静默吞掉（无第二观测面，设计如此）；仓内无评测解析此事件（`r7-faults.ts:785,883` 只是报告文案）。 |
| `file_ref_unavailable` | `apps/server/server.ts:294`（装配注入）← `packages/agent/src/execution-runtime.ts:471`（回调定义）；调用点 `:984`（Main `run_js`）、`:1083`（Worker `run_js`）、`:1346`（`task_run.inputFiles`） | `run_js.inputs` / `task_run.inputFiles` 引用的 fileId 不可用：`missing_or_foreign` / `pending` / `expired` / `bytes_missing`（同码同话术） | 测试：`apps/server/server-obs-wiring.test.ts`（事件名 + reason 原值）；runtime 回调层既有断言 `packages/agent/runtime-run-js.test.ts`（断言回调收到 reason，不是事件）。其余仅 stdout | 是 | **补口**：此前装配层从未注入 `onFileRefUnavailable`，「文件不可用」的机械 reason 不进任何日志。`reason` 形如 `missing_or_foreign:<fileId>` / `pending:<fileId>` / `expired:<fileId>`；只进日志，用户/模型只见统一话术（防存在性 oracle）。 |
| `inbound_attachment_too_large` | `apps/server/server.ts:494` | 任一附件 `bytes > 20MB`（`INBOUND_MAX_FILE_BYTES`，`packages/agent/src/file-store.ts:318`）→ 整条消息拒绝、零登记、零模型回合 | 测试：`apps/server/server-cap01-attachment-limit.test.ts:150`（helper）、`:190-201` | 是 | 判据是 `>`（恰好 20MB 放行）；事件带 `name/bytes/limitBytes`，话术不含机械事实。 |
| `inbound_files_registered` | `apps/server/server.ts:535`（文字+附件）、`:527`（纯附件补发，**补口**） | **任一**入站消息完成附件登记：文字+附件（非 `attachmentOnly`）或纯附件（`attachmentOnly`，与 `message_attachment_only` 并存） | 评测：`scripts/eval/cap01/r2-functional.ts:773`、`scripts/eval/cap01/r2c-artifacts.ts:599`、`scripts/eval/cap01/r3-core.ts:765`、`scripts/eval/cap01/r6-lifecycle.ts:335`、`:708`；测试：`apps/server/server-obs-wiring.test.ts`（纯附件路径） | 是（补口用例按事件名断言；`apps/server/server-cap01-inbound.test.ts:207-210` 只断言底账行） | **补口前只覆盖文字+附件**；现纯附件路径先发 `message_attachment_only`、再补发本事件（名字与字段不变，历史口径不断档）。按 fileId 集合消费的聚合方若同时读两个事件需按 fileId 去重（仓内当前无按长度消费两者的用例）。日志写失败未隔离（`:534-541`，logger 抛错会拒绝本回合）。 |
| `main_skills_loaded` | `apps/server/server.ts:201` | server 启动装载 Main 技能目录后（空索引也发） | 仅 stdout；仓内无读取者 | 否 | 设计用途是「启动证据面」（注释 `:200`）；见「发了没人用」。 |
| `message_attachment_only` | `apps/server/server.ts:511` | `attachmentOnly === true` 的纯附件消息登记完成（不调模型、不建 Task、空回执） | 测试：`apps/server/server-cap01-inbound.test.ts:172`、`apps/server/server-cap01-attachment-limit.test.ts:167`、`:201`。评测：`scripts/eval/cap01/r3-core.ts:906` | 是 | 与 `inbound_files_registered` 互补（见上）；日志写失败未隔离（`:510-517`）。 |
| `message_done` | `apps/server/server.ts:596` | 回合成功收口（回复定型）后 | 测试：`apps/server/server.test.ts:213-217`、`:281`、`:413`；`apps/server/channel-mode.test.ts:458-459`；`apps/server/server-cap01-delivery.test.ts:201-205`、`:224`、`:352`。评测：`scripts/eval/cap01/r2-functional.ts:637`、`scripts/eval/cap01/r2c-artifacts.ts:722`、`:794`、`:963`、`scripts/eval/cap01/r6-lifecycle.ts:881`、`scripts/eval/cap01/r7-faults.ts:678`、`:874`、`scripts/eval/p2/p2-harness.ts:486`、`scripts/eval/business-e2e/shared-instance.ts:456` | 是 | 只有成功路径；**失败回合没有对应事件**（见「该发没发」1）。带 `taskIds/executions/fileDelivery/fileManifestBytes`。 |
| `message_done_log_write_failed` | `apps/server/server.ts:612` | 写 `message_done` 时 logger 抛错（结果不翻转） | 测试：`apps/server/server.test.ts:276-281` | 是 | 双失败静默（`:618-620`）；评测里只在报告文案提到（`scripts/eval/cap01/r7-faults.ts:785`、`:883`），不解析。 |
| `message_duplicate_replayed` | `apps/server/server.ts:479` | 同 `(principalId, sessionId, messageId)` 重投命中回执缓存 | 测试：`apps/server/server-cap01-inbound.test.ts:171`。评测：`scripts/eval/cap01/r3-core.ts:907`、`scripts/eval/cap01/r7-faults.ts:865` | 是 | 查重先于附件/超限分支（`server.ts:472-481`）；缓存有界 1024（`:70`）。 |
| `message_refused` | `apps/server/server.ts:469` | principal 未配置或 `enabled !== true` | 测试：`apps/server/server.test.ts:321-322`、`:354`。文档：`docs/decision-log.md:2712` | 是 | `reason` 目前唯一值 `principal_not_enabled`；日志写失败未隔离（拒绝路径会变成 handler 异常）。 |
| `pending_files_activated` | `apps/server/server.ts:546` | 有文字的消息激活本会话 TTL 内 pending 文件（`activated > 0` 才发） | 测试：`apps/server/server-cap01-inbound.test.ts:223`、`:257-258` | 是 | 与 `inbound_files_registered` 同一回合常先后各一条（登记→激活），**不是重复**；`activated` 只计 TTL 内行。 |
| `task_file_bridge_skip` | `apps/server/server.ts:295`（回调）← `packages/agent/src/task-file-bridge.ts:146`；调用点 `:221`（`count_limit`）、`:227`（`missing_name`）、`:253`（登记拒收 `reason`）、`:270`（`scan_failed`） | 执行层文件桥拒收单项产物或整轮扫描失败 | 仅 stdout；仓内无读取者 | 否 | `reason` 拼进文件名（`:221`、`:253`）；任务收尾扫描的逐项 `skipped` 走 `task_output_sweep_skipped`（补口），整轮扫描失败仍走本回调的 `scan_failed:…`。见「发了没人用」。 |
| `task_output_sweep_skipped` | `apps/server/server.ts:302`（装配注入）← `packages/agent/src/execution-runtime.ts:493`（回调定义）/`:1500`（delegate `finally` 发出） | 任务收尾 `sweepTaskOutputs()` 成功返回但 `skipped` 非空（`symlink` / `size_limit` / `count_limit` / `outside_run_dir` 等） | 测试：`apps/server/server-obs-wiring.test.ts`（数量 + reason 分布）。其余仅 stdout | 是 | **补口**：此前只取 `swept.files`，拒收明细被丢弃。事件带 `taskId`、`skipped`（总数）、`reasons`（reason→数量）；只进日志，不进用户话术。 |
| `transcript_store_error` | `apps/server/server.ts:302` ← `packages/agent/src/execution-runtime.ts:1115`（读失败）、`:1580`（写失败） | 会话转录读取或回合后增量追加失败（fail-open，不阻塞回合） | 文档：`docs/decision-log.md`（B1 接线档 b1-wiring.md 2026-11-18 已删）；仓内无代码读取者 | 否（`packages/agent/session-persistence-wiring.test.ts:100` 断言的是 runtime 回调收到 error，不是事件） | 不区分读/写（无 phase 字段），排障信息只有 `message`。见「发了没人用」。 |

## 二、Pi 驱动事件（`packages/agent/src/pi-driver.ts`，9 个）

> **共性**：9 个事件都用 `console.warn/console.error` 直写（不经 `ServerDeps.logger` / 评测注入的 `logger`）。
> 按 `event` 名断言或采集它们的地方必须劫持 `console`（测试与评测确实这么做）。这也意味着宿主日志注入点
> 看不到这些事件；生产只能从进程 stdout 看。

| 事件 | 发出点（文件:行） | 触发条件 | 消费方（文件:行） | 测试断言 | 备注 |
|---|---|---|---|---|---|
| `pi_driver_retry_scheduled` | `packages/agent/src/pi-driver.ts:478` | Pi 原生 `auto_retry_start`（瞬时错误自动重试） | 测试：`packages/agent/pi-native-tripwire.test.ts:157-184`（**反向**：必然超窗场景不得出现）。文档：`docs/decision-log.md:3494` | 是（仅反向断言） | 字段 `attempt/maxAttempts/delayMs/errorMessage` 来自原生事件；自动重试会丢弃上一次 assistant 尝试（同步转述 `recovery`）。**正向重试路径无测试钉住**。 |
| `pi_driver_model_error` | `packages/agent/src/pi-driver.ts:640` | 本回合出现 `runFailure`（`stopReason=error` 或 `aborted`） | 测试：`packages/agent/pi-driver-error-attribution.test.ts:100-105`。评测：`scripts/eval/convergence-r1/runner.ts:445`（计数）；名称集合 `scripts/eval/business-e2e/experiments/executor.ts:75`、`scripts/eval/p3/p3a-session.ts:79` | 是 | **名不副实两处**：①取消（`aborted`）也记 `model_error`（`pi-driver.ts:488-491`）；②`attempt` 硬编码为 1（`:641`），`docs/decision-log.md:2408` 以 `attempt>3` 作判据时该字段不可用（真实重试次数在 `retryScheduled`）。 |
| `pi_driver_failed_assistant` | `packages/agent/src/pi-driver.ts:651` | 转录末条 assistant 的 `stopReason` 为 `error` 或 `aborted` | 测试：`packages/agent/pi-driver-error-attribution.test.ts:107-109`、`:135-137`。评测名称集合：`scripts/eval/business-e2e/experiments/executor.ts:76`、`scripts/eval/p3/p3a-session.ts:80` | 是 | 与 `pi_driver_model_error` 同一失败常成对出现（测试注释 `pi-driver-error-attribution.test.ts:111-113` 明示双层归因）；**aborted 也叫 failed**。 |
| `pi_driver_empty_reply` | `packages/agent/src/pi-driver.ts:665` | 本回合最终无正文（含 thinking-only、催问前为空） | 测试：`packages/agent/pi-driver-error-attribution.test.ts:111-113`、`:158-163`、`:221-226`。评测名称集合：`scripts/eval/business-e2e/experiments/executor.ts:75`、`scripts/eval/p3/p3a-session.ts:79` | 是 | 在催问**之前**发：thinking-only 被催出正文时也会先有一条，不等于最终失败；`stopReason/contentBlocks` 用于区分形状。 |
| `pi_driver_final_text_nudge` | `packages/agent/src/pi-driver.ts:678` | 只思考没正文、未到 deadline、未 abort → 催一次最终文本 | 测试：`packages/agent/pi-driver-error-attribution.test.ts:165-167`、`:195-197`；`packages/agent/pi-driver-nudge.test.ts:71`。评测名称集合：`executor.ts:76`、`p3a-session.ts:80` | 是 | 催问是真实 user 消息进 Pi 转录（`:675-676`），不是隐藏改写；一轮一次。 |
| `pi_driver_final_text_nudge_empty` | `packages/agent/src/pi-driver.ts:690` | 催问后仍无正文 | 测试：`packages/agent/pi-driver-error-attribution.test.ts:199-201`、`:228-230` | 是 | 与 `empty_reply` 成对（第二次归因）。 |
| `pi_driver_final_text_nudge_failed` | `packages/agent/src/pi-driver.ts:683` | 催问 `session.prompt` 抛错 | 无 | 否 | 只有 `errorType`，**没有 message**（同组其他事件都带 errorMessage），可诊断性最弱。见「发了没人用」。 |
| `pi_driver_prompt_changed_session_rebuild` | `packages/agent/src/pi-driver.ts:588` | 复用会话时 system prompt 变化 → 丢弃旧会话并按新配置重建 | 仅文档（适配设计文档 2026-11-18 删除，git 历史可考）；仓内无代码读取者 | 否 | **裸事件、零字段**（不知哪段 prompt 变了）；工具名变化也会重建但完全静默（`:585-601` 只有 prompt 变化才记）。见「发了没人用」。 |
| `pi_driver_error` | `packages/agent/src/pi-driver.ts:699` | `driver.run` 抛出未预期异常（非 stopReason 失败形状） | 评测名称集合：`scripts/eval/business-e2e/experiments/executor.ts:75`、`scripts/eval/p3/p3a-session.ts:79`、`scripts/eval/p3/p3c-session.ts:68`；文档：`docs/decision-log.md:2000` | 否（无单测按事件名；p3c 的 verdict 也只判 `model_error`） | 随后丢弃复用会话（`:704`）、返回空文本；宿主侧再判回合失败。 |

## 三、`run_js` 执行面事件（2 个）

| 事件 | 发出点（文件:行） | 触发条件 | 消费方（文件:行） | 测试断言 | 备注 |
|---|---|---|---|---|---|
| `run_js_memory_exit` | 宿主日志：`apps/server/server.ts:288`；构造：`packages/agent/src/execution-runtime.ts:907`（判据 `:258-267`；调用 `:969` main、`:1089` worker） | run_js 子进程非宿主主动杀（无 `killReason`）且 `exitSignal` 非空或 stderr 命中 OOM 文案 | 测试：`apps/server/server-cap01-memory-wall.test.ts:158-200` | 是 | `bytes` 是**输入总字节**（脚本+物化输入），不是内存峰值；memo 命中不重复上报（`:903`）；仓内无评测消费。 |
| `run_js_layout_unsafe` | 宿主日志：`apps/server/server.ts:291`；runtime 上报：`packages/agent/src/execution-runtime.ts:963`（main）/`:1061`（worker）；抛错点：`packages/agent/src/run-js-executor.ts:184`、`:201`、`:213`、`:216`（检查点 `:316`、`:330`、`:335`） | run 目录六项或树内出现 symlink/非目录，或扫描条目/深度超限 → 拒跑、零产物 | 测试：`packages/agent/runtime-run-js.test.ts:310-320`、`packages/agent/runtime-worker-run-js.test.ts:537-545`（断言回调对象）；executor 单测 `packages/agent/run-js-executor.test.ts:594-596`、`packages/agent/run-js-layout-symlink.test.ts:75-89` | 是（runtime 回调层；server 的 `event` 字面量未被断言） | main/worker 共用一个事件名，靠 `side`/`taskId` 区分；仓内无评测消费。 |

## 四、运维 / 进程事件（3 个）

| 事件 | 发出点（文件:行） | 触发条件 | 消费方（文件:行） | 测试断言 | 备注 |
|---|---|---|---|---|---|
| `run_dir_cleanup` | 唯一构造：`packages/agent/src/run-dir-cleanup.ts:131`；调用点 `:150`、`:155`、`:158`、`:159`、`:166`、`:167`、`:172`、`:174`、`:175`、`:180`、`:182`、`:190`、`:206`、`:211`、`:216`、`:254`、`:258`、`:262`、`:291` | 显式 `npm run cleanup:runs` 扫描 workspace：每个候选 run 目录一条（`kept`/`deleted`/`would_delete`/`skipped_*`/`delete_failed`） | `scripts/cleanup-runs.ts:124` 逐行输出 JSON；测试 `packages/agent/run-dir-cleanup.test.ts:89-100`、`:125`、`:144`、`:183`、`:263-264` | 部分（断言 `action/path`，**不断言** `event` 字面量） | 9 种 `action`；`kept` 也逐目录打（量大）；`path` 是绝对路径（只进 ops 日志，不进用户话术）。 |
| `server_started` | 打印：`apps/server/main.ts:70-76`；构造：`apps/server/channel-mode.ts:74` | 渠道启动流程结束后（offline 不 `start` 也发） | 测试：`apps/server/channel-mode.test.ts:193-204`（断言构造对象相等） | 是（只测构造器；main.ts 实际打印点无测试） | 带 `channelMode` 与 `deliveryMode`；打印在 `start` 之后——`start` 抛错则没有本事件（见「该发没发」8）。 |
| `server_shutdown` | `apps/server/main.ts:82` | 进程收到首个 SIGINT/SIGTERM | 仅 stdout；仓内无读取者 | 否 | 在 `channel.stop()` / `server.close()` **之前**打印；两者失败无事件（见「该发没发」9）。见「发了没人用」。 |

## 五、发了没人用

判定：全仓（排除 `node_modules`/`.git`/`.runtime`/`out`）按事件名 `grep -rl`，只命中**发出点**（及文档），
既无测试断言、也无评测/指标/日志解析器读取。部署侧对 stdout 的人工排查按口径**不**计为消费方。
命令：`for e in <27 names>; do grep -rl ... "$e" .; done`（逐名输出文件清单，本节结论即该输出）。

| 事件 | 依据（全仓仅命中） |
|---|---|
| `main_skills_loaded` | `apps/server/server.ts:201`（发出）；无测试、无评测、无文档读取。`catalogBytes` 目前只是启动时打给人看。 |
| `task_file_bridge_skip` | `apps/server/server.ts:295`（发出）+ `packages/agent/src/task-file-bridge.ts`（触发源）；无测试、无评测。 |
| `transcript_store_error` | `apps/server/server.ts:302`（发出）+ 两篇文档；无代码读取者。底层 fail-open 行为有测试（`packages/agent/session-persistence-wiring.test.ts:100`），但**事件本身**无人消费。 |
| `pi_driver_final_text_nudge_failed` | 仅 `packages/agent/src/pi-driver.ts:683`。催问失败路径无测试注入。 |
| `pi_driver_prompt_changed_session_rebuild` | 仅 `packages/agent/src/pi-driver.ts:588`（原设计文档引用 2026-11-18 随文档删除失效）；无测试、无评测。生产 Main 提示恒定（设计上不触发），但一旦触发也无人接收。 |
| `server_shutdown` | 仅 `apps/server/main.ts:82`；无测试、无评测。 |

> 边界说明：`pi_driver_error` 虽无单测按名断言，但被 3 个评测脚本的名称集合采集（见上表），故**不**列入本节；
> `run_dir_cleanup` 有 CLI 输出与测试断言（action/path），也不列入。

## 六、该发没发

以下为阅读代码时发现的「有失败/异常路径，但没有留结构化事件」的位置（按严重度排序）。
2026-11-17 观测面补口（`arch/obs-wiring`）已修复第 2、6 项（见 §一 `file_ref_unavailable` /
`task_output_sweep_skipped`）；其余项未改代码。

1. **回合失败没有宿主事件** — `apps/server/server.ts:581-583`（空回复抛错）与 `:624-628`（handler 失败拒绝分支）
   都不写结构化事件。唯一间接证据是渠道适配器的 `wecom_handler_error`（`packages/channel-wecom/src/adapter.ts:642-646`）；
   假渠道/直调 `handler` 的路径连这条也没有。`message_done` 只覆盖成功。
2. ~~**文件引用被拒的机械 reason 全丢**~~ **【已补口 2026-11-17】** — `packages/agent/src/execution-runtime.ts:471`
   定义可选回调 `onFileRefUnavailable`，调用点 `:984`、`:1083`、`:1346`，注释写明「只进日志」；此前装配层
   `apps/server/server.ts`（以及 `scripts/ask-runtime.ts`）**都没有注入它**，生产里越权/过期/不存在的 fileId
   被拒时既无话术差异（防 oracle 合理），也无任何日志事实。现 `scripts/ask-runtime.ts` 的 `SessionAssemblyInput`
   透传该回调（`:262`、`:648`），server 注入并发出 `file_ref_unavailable`（`server.ts:294`）。
3. **入站附件登记失败无事件** — `apps/server/server.ts:358` 的 `registerInboundFile` 抛错（源不可读、
   `O_NOFOLLOW` 命中、超 file-store 兜底上限）会拒绝整条消息；事件面只有成功后的
   `inbound_files_registered`/`message_attachment_only`（`:510`、`:535`），失败没有对应事件。
4. **交付字节读取失败无事件** — `apps/server/server.ts:413` 的 `readFileSync` 在投递 `try` 之外；文件区缺失/
   不可读会直接拒绝回合，`file_delivery` 事件只覆盖 `sendToConversation` 的成败（`:421-440`），失败无文件归因。
5. **会话建立/转录打开失败无事件** — `apps/server/server.ts:259`（`openOrCreate`）与 `:262-307`（装配）；
   失败只经 `:312` 的 `pending.catch(() => sessions.delete(key))` 静默清缓存，无结构化事件。
6. ~~**任务收尾 out/ 兜底扫描的逐项拒收被丢弃**~~ **【已补口 2026-11-17】** — `packages/agent/src/task-file-bridge.ts:259-267`
   的 `sweepTaskOutputs()` 返回 `{ files, skipped }`，此前 `packages/agent/src/execution-runtime.ts:1455-1457` 只消费
   `swept.files`；只有整轮扫描抛错才走 `task-file-bridge.ts:270` 的 `task_file_bridge_skip`。现 runtime 把
   `skipped` 汇总成 `task_output_sweep_skipped`（`taskId` + 数量 + reason 分布，`execution-runtime.ts:1500`），
   server 装配注入（`server.ts:302`）。整轮扫描失败仍走 `scan_failed:…`，两者不重复。
7. **run_js 产物拒收项无事件** — `packages/agent/src/run-js-executor.ts:444` 把拒收项放进 `audit.skippedOutputs`；
   运行时工具结果 `packages/agent/src/execution-runtime.ts:883-901` 不含 `audit`，也没有事件。run 时被拒的产物
   （软链/超限/句柄异常）只存在于内存 `RunJsOutput.audit`，回合结束即丢（评测直接调执行器时才能读到：
   `scripts/eval/cap01/r2b-formats.ts:1225`）。
8. **启动失败只有纯文本** — `apps/server/main.ts:91-94` 的 `main().catch` 只 `console.error('启动失败：', message)`，
   没有 `server_started` 的失败对应事件；配置缺失/渠道认证失败/装配抛错在日志里是自由文本。
9. **关停清理失败无事件** — `apps/server/main.ts:83-84` 的 `channel.stop()` / `server.close()` 在 `shutdown`
   内没有 `try/catch`，也没有事件；失败会变成 unhandled rejection（`server_shutdown` 已在 `:82` 先打印，
   但无法表示「关停失败」）。
10. **通知投递失败只落库** — `packages/agent/src/notifications.ts:434-441` 把 sink 失败写进 outbox 行的
    `last_error`；`apps/server/server.ts:246-248` 的 `drainNotifications` 丢弃 `deliverPending()` 的结果，无事件/指标。
11. **（次要）driver 中止失败静默** — `packages/agent/src/pi-driver.ts:563`
    `active.session.abort().catch(() => undefined)`：abort 抛错无事件，可能留下仍在跑的回合。
12. **（条件性）转录错误回调未注入即静默** — `packages/agent/src/execution-runtime.ts:420` 的回调是可选的；
    `scripts/ask-runtime.ts:632` 只在调用方传入时转注。当前 server 注入了（见上表），但 `ask` 路径若注入
   `transcriptStore` 而不注入回调（`scripts/ask-runtime.ts:247,631`），读/写失败无任何记录。

### 观测面自身失败的盲区（补充）

- **第二观测面也失败**：`apps/server/server.ts:455-457`（`file_delivery_log_write_failed` 写不出）与
  `:618-620`（`message_done_log_write_failed` 写不出）除吞掉外无动作——设计如此，但意味着 logger 持续故障时
  上述「降级事件」并不存在。
- **其他事件的日志写失败未隔离**：`message_refused`（`:469`）、`message_duplicate_replayed`（`:479`）、
  `message_attachment_only`（`:510-517`）、`inbound_files_registered`（`:534-541`）、
  `inbound_attachment_too_large`（`:493-502`）的 `log()` 都在业务分支内；logger 抛错会把这些路径变成 handler
  异常（R7-F3 只加固了 `message_done` 与 `file_delivery sent`）。

## 七、待核 / 边界

- `server_started`、`main_skills_loaded`、`server_shutdown`、`task_file_bridge_skip` 的 stdout 是否被**仓外**
  部署日志采集/告警消费，仓内不可判定 → 「消费方：仓内无」仅就本仓而言。
- `run_dir_cleanup` 的 `event` 字面量没有被任何测试断言（只有 `action/path`），若未来改名字面量，现有测试不会红
  → 属测试盲区，不算「没人用」（CLI 输出与测试都消费事件对象）。
- `packages/channel-wecom/src/adapter.ts` 的 `wecom_*` 事件（`wecom_dispatch_fail`、`wecom_handler_error`、
  `wecom_reply_fail` 等）是另一组结构化事件，不在本次 27 个范围内，未逐项核对。
- `pi_driver_*` 的采集方普遍在事件名集合里保留了已删除的 `pi_driver_context_overflow_recovered`
  （`scripts/eval/business-e2e/experiments/executor.ts:76`、`scripts/eval/p3/p3a-session.ts:80` 等；该名字在
  `packages/agent/pi-native-tripwire.test.ts:44-45` 被列为**禁止回潮**符号）。同集合里的 `context_*`
  （`context_compacted` 等）在现行 `packages/agent/src/pi-driver.ts` 也已零命中。不是本清单事件，但说明评测侧
  名称集合已有陈旧项。
