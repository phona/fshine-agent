# P4 通知与交付：实施报告（2026-11-14）

> 分片依据：`docs/product/r4-slices.md` §三「P4 · 通知 outbox」与 `docs/product/r4-acceptance.md` §3「P4 通知 outbox」（P4-T01–T05 / P4-E01，v1 预注册基线）。
> 接口冻结：`docs/product/r4-joint-interfaces.md` §4（Notifications 接口）；v1.1 澄清登记在集成分支 `6e4be01` §9（`stateVersion = fact.stateVersion ?? fact.at`；`result_unknown` 以 `failed` 意图承载并于 `payload.reason` 如实携带；本轨按该口径实现，本分支基线尚未含此 docs 提交）。
> 分支/基线/提交：worktree `fshine-agent-r4-p4`，分支 `arch/r4-p4`；启动基线 `arch/integration` HEAD `9ae895d7b65305c6c62aba31e007672c86022622`（联合接口约定 v1）。提交链：`82577b46b9aeb604485b4a83206716efa3ce1191`（测试先行/红）→ `98f679b393acbe2918d08a6cd31ca9135bd90ec6`（最小实现）→ `0f9970e062b336963a0588c15400c05644fa8c4a`（补 v1.1 断言）。未 push、未合并（归 owner/集成 Run）。
> 证据根：`.runtime/p4/`（gitignored；索引见 `baseline.txt`）。
> 声明：本片只交付**独立模块 + 测试**；`execution-runtime`/`server`/`tasks`/`ops` 接线不在本片（契约 §6：共享文件唯一负责人，集成 Run 统一接线）。P4-E01（后台真实通知黑盒）**blocked-by-P6**，未执行、不计入 passed。

## 一、产品要求（为什么做 P4）

按项目定位（让业务人员愿意把日常交给 AI）：后台任务与等待用户的任务，其状态变化必须让用户**看见**（受理/开始/等待/恢复/完成/失败/取消/超时/资源限制）；但渠道投递会失败或延迟，**投递失败不得改变任务实际结果**。因此 P4 = 通知事实与投递解耦：

- 通知先落同库最小 outbox（持久化、可查、跨重启仍在）；
- 同一事实重复触发**不重复通知**（唯一键去重）；
- 投递失败**有界重试**（退避 + attempts 上限），超限停止但**未送达可见**（不静默丢）；
- 渠道无关接口（`NotificationSink`），测试用假发送器、集成注入 WeCom sink；
- payload **仅来自底账事实**（不编造百分比/进度/原因/内部路径）；业务语言由事实渲染；
- Main 只读可查（`listNotifications`/未送达集合），**不自动注入对话历史**（§4 冻结口径）。

不做（准入红线）：通用事件总线、发布订阅、第二套对话历史、独立消息系统、跨进程投递守护。

## 二、验收用例覆盖（P4-T01–T05 / E01）

| 用例 | 层级 | 覆盖方式（测试/证据） | 状态 |
|---|---|---|---|
| P4-T01 写点与去重 | 确定性 | `packages/agent/notifications.test.ts:135-184`：落库形状；同 `(task_id, kind, state_version)` 重复事实不新增不覆盖；`state_version` 缺省=at（同 at 去重、不同 at 各自成行）；不同 kind/task/显式版本各自成行；12 组状态转移→意图映射（`:98-133`） | 已实现/已测试（绿） |
| P4-T02 重试与失败可见 | 确定性 | `:239-322`：假 sink 成功写 `delivered_at`；连续失败→退避到点才重试→成功（attempts 递增）；sink 抛异常不逃逸、记 `last_error`；attempts 超上限停止（不再调 sink）且 `exhausted` 未送达可见；并发 `deliverPending` 串行化不重复送达（`:376-396`） | 已实现/已测试（绿） |
| P4-T03 终态不静默丢失 | 确定性 | `:323-350`：完成/失败/取消/超时/等待用户 5 类超限后**全部**在未送达集合可见（attempts/lastError/exhausted），通知事实保留；`:351-374` 投递失败不改同库 tasks 行、写点不调 sink | 已实现/已测试（绿） |
| P4-T04 事实性与语言 | 确定性（字段来源）+ 黑盒（语言） | 确定性：`:187-238` payload 精确白名单（可选缺省不伪造）、编造/未知字段被拒且不落库、非法枚举被拒、`result_unknown` 如实携带（v1.1）。黑盒语言：**blocked-by-P6**（需真实后台通知面，并入 E01 预注册执行） | 确定性部分已实现/已测试（绿）；黑盒部分 blocked |
| P4-T05 Main 可读历史 | 确定性（按裁定形态） | §4 裁定=**只读查询、不自动注入**：`notifications.ts:483-506` `createNotificationReader`（只读打开、缺库/缺表空集合）+ outbox `listNotifications`/`undelivered`；`:398-438` reader 与重启可见性测试 | 只读形态已实现/已测试（绿）；「下一回合可见」的 Main 读工具接线留集成 Run（不注入=冻结口径） |
| P4-E01 后台完成通知（黑盒） | 黑盒 | **blocked-by-P6**：需 P6 后台任务执行 + server 注入真实/假渠道 sink；预注册 N 在解除后执行 | 未实施（blocked，不计入 passed） |

## 三、实施（文件与语义）

| 文件 | 性质 | 内容 |
|---|---|---|
| `packages/agent/src/notifications.ts`（新增 506 行） | 新增模块（纯逻辑 + SQLite） | 九类意图 `NOTIFICATION_KINDS`（`:28`）+ 冻结原因集 `NOTIFICATION_REASONS`；`notificationKindForTransition(from,to,reason)`（`:239`，cancelling/unexecuted 无意图，`result_unknown`→`failed`）；payload 白名单 + 运行时逐键校验（未知字段抛 `NotificationPayloadError`，`:97`，不落库）；`NotificationSink.send(notification)→DeliveryReceipt`（`:127`）；outbox：`CREATE TABLE IF NOT EXISTS notifications`（`:204`，列集精确等于 §4 九列 + `UNIQUE(task_id,kind,state_version)` `:215`）、`record` 去重（`INSERT OR IGNORE`，`:443-458`）、`deliverPending` 串行化有界重试（`:399-441`：attempts 上限 `:405`、累计指数退避由 `created_at`+attempts 机械推出 `:336/:414`、`delivered_at`/`last_error` 落库）、只读 `listNotifications`/`undelivered` 与 `createNotificationReader`（`:483`） |
| `packages/agent/notifications.test.ts`（新增 449 行 / 30 例） | 新增测试（先红） | 覆盖 T01–T05 确定性面：去重、payload 白名单、假 sink 成功/失败/异常、退避与上限、终态不丢、解耦断言、并发串行化、只读查询与重启幂等 |

**最小性**：无新依赖（`better-sqlite3` 已在根 `package.json`）；无事件总线/定时器/线程（grep 确认无 `setTimeout/setInterval/worker_threads/EventEmitter/emit`）；重试由集成侧调用 `deliverPending()` 驱动，模块只持有确定性语义；未触碰任何热点/共享文件（产品代码 `git diff --stat 9ae895d..HEAD` 仅上述 2 个新增文件，955 插入、零删除；本报告为追加的 docs 文件）。

## 四、执行证据（本次复跑读数；日志均在 `.runtime/p4/`）

**RED（先红）**：`TMPDIR=/home/tao/.tmp node_modules/.bin/vitest run packages/agent/notifications.test.ts` → `Cannot find module './src/notifications' imported from ... notifications.test.ts:21`，`Test Files 1 failed`，exit=1（`red-notifications.log`）。

**反向绊线（≥2 类；破坏不提交、随即 `git checkout` 还原）**：

- ① 去掉唯一键（删除 `notifications.ts:215` 的 `UNIQUE`）→ **3 failed / 27 passed**，exit=1；红：重复事实不新增、state_version 缺省去重、重启去重（`tripwire-r2-1-no-unique.log`）。
- ② 重试无上限（`notifications.ts:405` 改 `>= maxAttempts + 1000`）→ **2 failed / 28 passed**，exit=1；红：attempts 超上限即停止、终态超限可见（`tripwire-r2-2-no-cap.log`）。
- ③ 终态通知静默丢弃（失败分支超限时 `DELETE FROM notifications`，`notifications.ts:429-437`）→ **2 failed / 28 passed**，exit=1；红：终态不静默丢（断言 `expected [] to deeply equal [ 'cancelled', 'completed', …(3) ]` @ `notifications.test.ts:339`）与上限停止（`tripwire-r2-3-silent-drop.log`）。
- 早期另一类绊线（payload 白名单拒绝移除）→ 1 failed / 28 passed，exit=1（`tripwire-3-no-whitelist.log`）。
- 每次还原后目标测试复跑全绿（`green-restored.log` / `verify-r2-target.log`）。

**确定性门（最终代码，工作树 clean）**：

- `npm run typecheck` → `TSC_EXIT=0`（`verify-report-typecheck.log`）。
- `npm test`（全量 unit）→ `Test Files 46 passed (46)`；`Tests 455 passed (455)`；`VITEST_EXIT=0`（`verify-report-unit-full.log`）。**只增不减**：本片贡献 1 文件/30 例；其余 45 文件/425 例（=全量 46/455 减本片贡献，同一次运行输出）全过；产品代码 diff 未改/删任何既有文件。
- 目标批次：`... vitest run packages/agent/notifications.test.ts` → `Tests 30 passed (30)`（`verify-r2-target.log`）。

## 五、回退方式

- 整片回退 = revert 本片 3 个提交（或删 2 个新增文件）：无 schema 迁移（outbox 由本模块自建新表）、无热点文件改动、**零接线**，回退后产品行为不变。
- 回退断言（验收 v1 口径）：「投递开关关闭仅落库展示、去重/重试不变」——当前未接线阶段天然成立：模块无任何 `deliverPending` 调用点（record-only）。集成接线时以投递开关（默认关）只调 `record`、不调 `deliverPending` 即可复现；去重/重试语义只影响 outbox 自身，不改变任务结果。
- P4-E01 blocked 项不因回退新增风险（从未执行）。

## 六、blocked 清单与解除条件

| blocked 项 | 依赖 | 解除条件 |
|---|---|---|
| P4-E01 后台完成通知（黑盒，预注册 N） | P6 后台任务执行 | P6 合入集成且后台任务可产生真实状态变化；server 注入渠道 sink（真实企微或假渠道按预注册口径）后执行 |
| P4-T04 黑盒语言部分 | 同上（真实通知面） | 随 E01 一并预注册执行（确定性字段来源部分已绿） |
| `execution-runtime`/`server`/`ask-runtime` 接线 | 集成 Run（契约 §6/§8 顺序 P2→P5→P6→P4） | P2/P5/P6 合入后由集成负责人统一接线（本模块接口已冻结就绪） |
| tasks/ops 未送达展示接线 | 集成 Run | 同上；用 `createNotificationReader` 只读查询（不注入对话历史） |
| 跨进程投递/多实例 | 明确不做（契约 §7 单实例登记） | 若未来需要，另立切片（lease/单写服务），不在本轮授权 |

## 七、接线需求（集成 Run）

1. **execution-runtime 事实钩子 → outbox**：接 P2 的 `onTaskFact(fact)`（契约 §1，`TaskFact={taskId,taskNo,name,from,to,reason?,at,stateVersion?}`）→ `notificationKindForTransition(fact.from, fact.to, fact.reason)` → 有 kind 时 `outbox.record({ taskId, kind, stateVersion: fact.stateVersion ?? fact.at, at: fact.at, taskNo, name, reason, requestIds? })`。无 kind（cancelling/unexecuted 等过渡态）不写。**禁止**在接线处自造 kind/字段（白名单会拒）。
2. **server sink**：实现 `NotificationSink` 包装现有 `adapter.sendToConversation`；推送文案用 `payload` 事实渲染（业务语言），Request ID 仅追溯；投递失败只影响 outbox 投递列。投递开关默认关（先只落库）。
3. **tasks/ops 查询**：`createNotificationReader(dbPath, { maxAttempts })`（只读、缺库/缺表空集合）列出 `undelivered()`（含 attempts/lastError/exhausted）与 `delivered_at`；不自动注入对话历史（§4）。
4. **投递触发**：由集成调用 `outbox.deliverPending()`（回合收尾或定时；模块内无定时器）；同进程有界重试，attempts 上限与退避可配置。
5. **配置**：`maxAttempts`/退避 由 `runtime` 段（P5 单一配置入口）承接后在装配处注入；reader 需传同值以保证 `exhausted` 口径一致。

## 八、已知边界（登记）

1. `state_version` 缺省 = 事实时间 `at`（v1.1 澄清；同一事实重复触发稳定去重）；集成可显式传注册表计数器获得更精确版本。
2. 退避时点由 `created_at` + 累计退避机械推出（**不新增冻结列**）；若未来需要「按上次尝试墙钟」精确退避，须版本化扩列。
3. `result_unknown` 无第十类意图（枚举冻结为 9 类），以 `failed` 承载 + `payload.reason` 如实携带（v1.1）。
4. 投递重试为**同进程**语义（调用方驱动）；无跨进程/重启自动重投（单实例登记）。
5. 业务文案渲染不在本模块（sink/展示层用 payload 事实渲染）；本模块保证字段来源与语言材料，不产自由文本。
