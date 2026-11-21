# 未清债务

> 状态：现行。只列**未清**项；已关条目与 2026-09/10 波次关账记录在历史分片（`../history/debt-ledger*.md`）。
> 核对口径（2026-11-18）：逐条读分片里状态为「待办 / 登记 / 部分落地」的条目，用当前树核对它引用的代码路径。**不自行判定已清**——无现行代码指针、无 issue 号、且无结案记录的，一律 `待核`。
> 核对规模：分片共 72 条带编号未清项 + 4 条无编号登记；8 条仍有现行指针（§二），64 条指针已失效（§三）。

## 一、issue 追踪（有 issue 号）

| 编号 | 事项 | 证据 / 指针 | 状态 |
|---|---|---|---|
| #67 | 会话存储 retention / capacity（线性无界增长） | `../architecture/sessions.md:35-37` | 未清 |
| #68 | 跨重启消息级幂等 / 真续跑恢复 | `../../AGENTS.md:84`；`../../README.md:93` | 未清 |
| #69 | `executions` 时间列 | `../../AGENTS.md:84` | 未清 |
| #70 | tasks CLI 增强 | `../../AGENTS.md:84` | 未清 |
| #71 | P8 ops 扩展（原 R4 唯一未落地分片） | `../../AGENTS.md:84`；`index.md`（R4 行） | 未清 |
| #72 | 死代码重复实现 | `../../AGENTS.md:84` | 未清 |
| #73 | eval 候选池 | `../../AGENTS.md:84` | 未清 |
| #74 | B2 Silent Shadow 真实租户联调 | `../architecture/channels.md:3` | 未清 |

## 二、有现行指针、无 issue 号（逐条核对）

| 编号 | 事项 | 现行证据 | 状态 |
|---|---|---|---|
| D-204 | dummy 夹具两套 commit 令牌契约不一致 | `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:789-792` 注释自述「两者不一致已登记」（`:791`）；`verifyProposalToken` 见 `:723`，script 绑定校验见 `:1201`/`:1295`（旧行号 `:542-545`/`:479`/`:927`/`:1014` 系 11-19/20 文件增长漂移） | 待办（未统一） |
| D-156 | 两支真实读数（61,000 / 86,000）残留 | `docs/history/architecture-laws-2026-11_undated.md:242`「遗留待清」；**口径不明**：2026-11-20 核对按字面量实测（非 history 面 0 行、history 7 行、本表 1 行），复现不出原文「仅此一行命中」，原口径待考 | 待办（无 issue，口径存疑） |
| D-052 | `step-text.ts` 六个退役工具名死分支 | `packages/agent/src/step-text.ts` 仍在，但六个工具名在该文件域内 grep 零命中（全仓另有 `packages/agent/pi-driver.test.ts:18/:24` 的合成工具名 `search_references`，与死分支无关）；无结案记录 | 待核 |
| D-062 | `npm test` 在无凭据环境全红 | `package.json:9`（`vitest run`）；无结案记录 | 待核 |
| D-168 | 门①「产品面」口径未定义 | 现行树**实测 4 处命中**（`packages/agent/src/user-facing-failure.ts:78`、`packages/agent/payload-oneof.test.ts:2`、`:23`、`scripts/eval/real/smoke.ts:4`，均注释/文案级；2026-11-20 核对，原文写「零命中」已不成立） | 待核 |
| D-170 | exposure-lint 剩余核对与扩展 | `packages/agent/exposure-lint.test.ts` 已不存在（`ls` 实测）；无结案记录 | 待核 |
| D-190 | 门①测试夹具豁免口径分歧 | `docs/history/architecture-laws-2026-11_undated.md` 仍在；**口径限定**：该条原判据是「产品面（packages/apps 非测试文件）零 17dz 字面量」——按此口径现行树**非测试面 1 行**（`packages/agent/src/user-facing-failure.ts:78`，注释级）、测试/夹具面 3 行（`packages/agent/payload-oneof.test.ts:2`、`:23`、`scripts/eval/real/smoke.ts:4`），合计即 D-168 的 4 行实测清单；无结案记录 | 待核（口径见 D-168） |
| D-196 | 退役 `FSHINE_PLATFORM_ROOT` | 代码面（packages/apps/scripts/config/tests/.github/package.json）grep 零命中；docs 档案与本表自身有历史提及；无结案记录 | 待核 |

## 三、指针失效、无结案记录 → 待核（64 条）

以下条目引用的文件在当前树均已不存在；**没有结案记录，不等于已清**。

- 旧宿主 Runtime / 写路径 / 业务词表（15 条）：D-001、D-003、D-004、D-005、D-010、D-016、D-017、D-030、D-031、D-032、D-050、D-051、D-066、D-067、D-083 附条 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:102` 起、`../history/debt-ledger-part02-2026-09_2026-10.md:217`。
- 兄弟仓 `17dz-platform`（8 条，不在本 worktree）：D-015、D-053、D-056、D-057、D-061、D-064、D-173、D-193 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:335` 起、`../history/debt-ledger-part03-2026-10_2026-11.md:729`。
- 旧评测 / 守卫 / 发布 / 迁移面（41 条）：D-147、D-148、D-152、D-153、D-154、D-157、D-159–D-167、D-169、D-171、D-172、D-174、D-175、D-178、D-181–D-188、D-192、D-194、D-195、D-197、D-198、D-199、D-201、D-202、D-203、D-205、D-206、D-209 — `../history/debt-ledger-part03-2026-10_2026-11.md:243` 起、`../history/debt-ledger-part04-2026-11.md:333`。
- 无编号登记（4 条）：已知短板、其余 6 真 1 半的证据链、architecture-laws「当前违例」对账、F3 未留档项 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:50`、`:75`；`../history/debt-ledger-part03-2026-10_2026-11.md:223`、`:314`。

## 四、现行文档已登记的缺口（非台账拆分来源）

| 事项 | 证据 / 指针 | 状态 |
|---|---|---|
| `eval:cap01` 的 r6 面已改指 `lifecycle.ts`（2026-11-18 同步） | `scripts/eval/cap01/run-all.ts:40`；`../eval/README.md:12` | 已清 |
| `eval:cap01` R2 S1 场景已退役（原「Main 直做写 out/ 并由宿主投递」；交付物只从 Worker 出，Main 的 run_js 只能写 scratch/） | `scripts/eval/cap01/r2-functional.ts` 文件头；`packages/agent/src/run-js-executor.ts`（RunJsWritableDirs）；等价覆盖 = 同文件 S3（Worker 产物回 Main + 逐格 + 登记 + 行数据不出 Main） | 已退役（2026-11-19） |
| 判据锁只校验 criteria/cases 聚合值、不校验 `files` 表 | `../eval/README.md:24`；`scripts/eval/convergence-r1/runner.ts:220-230` | 未清 |
| 服务单实例 | 已清（2026-11-19 起有机械守卫）：启动取独占锁、存活实例在则 exit(1)、陈旧锁可覆盖；取锁先于连接渠道 | `apps/server/main.ts:53`（`guardSingleInstance`）；`apps/server/instance-guard.ts`；守卫 `apps/server/instance-guard.test.ts`（5 条）；`../ops/README.md:13` | 已清（2026-11-20 核对：原文「无进程锁/仅靠操作纪律」已不成立；本行留档，下次清理删除） |
| `DB_PATH` 文档缺省与实际代码不一致（文档 `data/agent.db`，代码 `.runtime/state.db`） | `../ops/README.md:34`；`../environment-variables.md:33`；`apps/server/main.ts:44-46` | 未清（文档待改） |

## 五、明确「接受不修 / 登记不修」（非待办，勿重开）

D-005 附条（`scripts/` 144 处接受不修）、D-006（验收替身数据）、D-040（auth 正则过渡债，限期）、D-054（`.env.real` 仓库侧已关）、D-149（提案 schema 死循环登记不修）、D-158（gitee refs 残留登记不修）— 原文见 `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md`、`../history/debt-ledger-part03-2026-10_2026-11.md`。

## 六、文件去重边界（2026-11-18 实测登记，本次不修）

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| F-1 | 纯附件重发（尚未激活的 pending 行）不去重：同内容连发两次 → 两行两个 fileId | **已清**（fee86cee，2026-11-18：pending→pending 复用同一 fileId）。现行证据：`packages/agent/src/file-store.ts:557`（`findReusableInboundRow` 不再跳过 pending）、`:973-977`（复用分支：pending 刷 name/created_at 且保持 pending）；守卫 `packages/agent/file-store-dedupe-ttl.test.ts`、`packages/agent/file-store-inbound.test.ts`（①/② pending 语义） | 已清（2026-11-20 核对） |
| F-2 | 入站复用没有「来源」判据，理论上会吞同字节的 Main 产物行（`putFile` 造的、如 recalc 的 `*.values.csv`）：行名会被改成入站文件名 | `packages/agent/src/file-store.ts:557-563`（`findReusableInboundRow` 只排除 `taskId !== undefined` 的行）；`putFile` 的 Main 行 `:714-738`；复用改名/TTL 刷新 `:598-629`（`reuseInboundRow`） | 修法需给 `file_refs` 加 origin 列并覆盖所有写路径（putFile / registerFromFd / 任务副本 / 回程），是 schema 迁移；当前同字节碰撞概率低但真实存在，登记到下次 schema 变更一起做 |
| F-3 | 同一消息内两个同内容不同名附件塌成同一 fileId、只留最后一个名字，而 `apps/server/attachment-facts.ts:87` 按 fileId 只留第一条事实 → 注入模型的名字与清单名不一致 | `packages/agent/src/file-store.ts:557-576`（入站复用 `findReusableInboundRow`，不区分消息内批次）；`apps/server/attachment-facts.ts:87` | 需要批次身份（`file_refs` 无 `message_id`）或改事实队列按 (fileId,name) 去重；后者仍会让清单只有一个名字、与模型看到的两条事实不一致。正确修法是同消息批次内复用检测 + 名字冲突裁定，需产品裁定，本次只登记 |

## 七、权限模型（2026-11-18 owner 裁定：解耦 + 只做粗粒度）

**裁定**：`accountSetScope` 这类**业务实体字段不与执行层耦合**（执行层不一定是财税平台）；fshine 与执行层之间只耦合**通用 permissions**（粗粒度：read / write）。粗粒度由 fshine 在发起前拦截；**细粒度（实体级）研判归执行层，暂不做**。

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| P-1 | ~~`principals.capabilities` / `principals.accountSetScope` 解析后**无任何消费点**（配置写了不生效）~~ **已解决（2026-11-19 RBAC 切片）** | 两字段已从 `PrincipalConfig` 删除；加载层忽略旧键（`packages/core/src/config.ts:339-340`）。角色表 `roles` + `principals.<id>.role` 取代：`packages/core/src/config.ts:296`（`parseRoles`）、`scripts/ask-runtime.ts:452`（求交口径）、`:533`（`resolveExecutionFace` 收口）、`apps/server/server.ts:1135`（`allowedPermissions: permissionsOfRole(...)`；旧行号 `:686` 系 RBAC 切片后随文件增长漂移） | —（角色白名单已接线并拦截） |
| P-2 | **细粒度（实体级）授权未实现**：谁能看哪些账套/哪些记录，未做任何透传或校验 | 无 acting-principal 透传；执行层调用只带 operation+args | 归执行层研判；真实 17dz 是否有"按主体授权"概念未验。仍挂债，等真实层冒烟与业务确认后再做 |
| P-3 | ~~写面是**全局开关**（`runtime.allowWriteOperations`），非按人~~ **已解决（2026-11-19 RBAC 切片）** | 全局开关降级为**部署总闸**：角色含 `write` 且总闸打开才并入写集合（`scripts/ask-runtime.ts:533` 收口；`apps/server/server.ts:1133-1134` 按主体角色取权限）；viewer 即使总闸打开也写不了；总闸关闭时 operator 也写不了（`scripts/rbac-roles.test.ts` ⑥） | —（按人部分由角色白名单承接，总闸语义保留） |

## 八、长任务异步协议（L-1 已落地 2026-11-19；L-2～L-4 仍挂债）

**背景**：执行层可能出现 30 分钟级的长任务（浏览器自动化）。固定总时长上限会把正常业务按卡死处理；挂长 RPC 又会长期占用后台槽。

**结论**：owner 2026-11-18 先定「设计保留、暂不实施」，当日深夜改判「契约扩展还是要做，实现上只用考虑命令行」→ L-1 已按 CLI/适配层抽象落地。**真实 17dz 未验**（只跑通 dummy CLI）。

| 编号 | 事项 | 设计要点 | 状态 / 为什么现在不做 |
|---|---|---|---|
| L-1 | 契约第六态 `accepted(operationId, pollAfterMs)` + `wait(operationId, timeoutMs)` + `abort(operationId)` | 只对声明 `long_running: true` 的 operation 生效，普通操作逐字节不变；Worker `accepted` 后回合结束、让出槽位；宿主用**长轮询**（出站、穿 NAT）实现"完成即唤醒"；`operationId` 落底账，重启续等；用户可停 | **已落地（契约 v4）**：runner 等待推进（瞬时故障指数退避封顶 60s）、续跑注记三态、续跑回程文件与大日志（`deliverable:false`）、`completed.items` 逐条结果；装配接线见 `scripts/ask-runtime.ts` 的 `longTaskPortOf`。只剩真实执行层验证 |
| L-2 | 续租/心跳替代总时长上限 | `workerTurnMs` 从"总时长"降级为"静默阈值"（无任何事件 N 秒才判卡死） | 未做：长任务已让出槽位，但**执行中**回合的静默阈值仍缺证据 |
| L-3 | 实体级并发写（长写期间的第二个写请求） | 由执行层用锁/排队返回确定性 `locked/busy`；宿主只转述并给用户"等/停"选择；宿主不排队等实体锁、不盲杀中间态 | 属执行层能力，未验；宿主侧无对应实体知识 |
| L-4 | `dispatchKey` 双边职责 | 宿主负责"不重复发起"（已实现），执行层负责"不重复执行"（未实现）；配套 per-operation `idempotent` 声明（缺省 false）与一致性探针（同 key 连发两次记录数不变） | 执行层未实现；dummy 里零引用 |

## 九、交互状态反馈（2026-11-19，owner 记为债）

**背景**：owner 希望给用户消息一个「已接收」的**轻反馈**（类似贴个表情 / reaction），让用户知道 Agent 收到了、正在办。

**事实**：企业微信 AI 机器人 SDK **没有 reaction / emoji 接口**——可用的只有 `replyStream` / `replyTemplateCard` / `updateTemplateCard` 等；因此**无法对用户消息「贴表情」**表示已接收。

| 编号 | 事项 | 设计要点 | 状态 / 为什么现在不做 |
|---|---|---|---|
| X-1 | 「已接收」轻反馈（贴表情 / reaction） | SDK 无 reaction 接口；可选替代 = **模板卡片原地更新**（⏳ → ✅，同一条卡片从「办理中」更新为「完成」），但需 live 验证该卡片类型对我们的机器人是否开放 | **当前不做**：短活缺省 **8 秒**就出结果，「收到」与「结果」几乎同时到；长活有 **10 分钟兜底**（超时如实告知）+ **运维告警**，已覆盖「接收感」。真实诉求未验证前不新增机制（新增机制准入：给不出「更省心/更省时间」的证据就不做） |

## 十、独立复核登记（2026-11-20，明确不修）

> 来自 9 点攻击独立复核：三处模型可见残留（agent.md / renderWorkerSystemPrompt 工作目录块 / 空汇报 reason）已由源头改写 + 守卫扩面修复；下列两项按复核建议**只登记、不修**，等真模型测量或专门切片再定。

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| R-1 | `wakeCancelled` 不在会话链上的 run/wake 竞态：任务取消时若该会话此刻没有在跑的回合（`turnActive=false`），`wakeCancelled` 直接起一次唤醒；若紧接着用户回合/另一状态变化又起 wake，两个 wake 可能并发。复核实测 **1 次可复现** driver 报错、用户回合空 | `apps/server/notification-chat-sink.ts:216-235`（`wakeCancelled` 出口）；`apps/server/server.ts:1303`（`wakeAndDeliverStateChange` 本体，出口逐步接它）；`turnActive` 判据见 `server.ts:1075` | 属竞态收口，不是本次去内部词切片；复现率与用户级影响待专门测。修法要给唤醒加会话级串行/去重（新机制，需过准入），本轮不引入 |
| R-2 | `WAKE_TURN_MS = 60s` 与 Main `mainThinkingLevel=high` 的张力：high 档长思考的唤醒回合可能 60s 内出不来 → 超时 abort → 模型那句丢失、走兜底渲染文案（用户看到的是模板话而非模型话） | `packages/agent/src/execution-runtime.ts:1071`（`WAKE_TURN_MS = 60_000`）、`:3324-3358`（wake/coldWake 截止）；`packages/contracts/src/config.ts:121`、`packages/core/src/config.ts:96`（`mainThinkingLevel` 配置）；兜底见 `notification-chat-sink.ts:216-235` | 是否真发生取决于真模型在 high 档的唤醒耗时，**当前无真模型测量**。不擅自放宽截止或降档——等 `eval:user` 真模型读数再定，避免为假设问题改超时语义 |

## 十一、长连接可靠性：离线/断连窗口的用户消息不可恢复（owner 2026-11-20 要求登记）

**事项**：企微 AI 机器人长连接（WebSocket）模式下，服务停服或断连期间用户发出的消息**平台不补投、产品无补拉**，窗口内消息永久丢失。

**实测读数（逐字）**：

- 停服 `12:02:15Z` → 重连 `12:03:43Z`（Authenticated），期间用户发 **2 条**；
- 重连后 `inbound_messages` 仍 **31 条（零新增）**、日志 `aibot_msg_callback` 帧 **0**、会话文件**零写入**；
- 结论：平台不补投、产品无补拉——断连窗口的消息没有任何恢复路径。
- 原始日志（机器本地 scratch，非仓内）：停服前 `~/.tmp/fshine-live.log`、重连后 `~/.tmp/fshine-live-2.log`（含 `WebSocket connection manually closed` → `Authenticated` → `server_started` 时间线）。

**官方口径**：`developer.work.weixin.qq.com/document/60904` 把「可靠性高（无状态）」判给 **Webhook**；长连接标注「需要心跳保活、断线重连」。官方社区另有「连接正常时也偶发丢」案例。

**缓解（已落地 2026-11-21）**：`systemd Restart=always`（停机窗口压到秒级）、WS 心跳 15s、`message_still_processing` 接进程内告警（规则 `message_stuck`）。窗口内消息仍会丢——这是长连接模式的固有代价。

**销账条件**：切 **Webhook**（平台最多 3 次重试）+ 既有 `messageId` 幂等底账接重投。两项都落地并实测窗口内零丢失后才可关账。

**状态**：未清（本次只登记，不修）。
