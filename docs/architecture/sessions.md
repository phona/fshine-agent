# 会话转录与上下文压缩

> 状态：现行。Pi 1.5.2 `AgentSession` 适配与 B1 会话持久化已接 server 装配；retention 未实现（issue #67）。
> 最后核对：2026-11-18（`path:line` 以现行代码为准；实施过程与实验读数在 `docs/history/decision-log-part*.md`）。
> 上游指针：`packages/agent/src/pi-driver.ts`（唯一 Pi 接缝）、`packages/agent/src/session-persistence.ts`（落盘）、`apps/server/server.ts:252-253`（装配）、`docs/decisions/index.md`。

## 1. 所有权：Pi 独占转录 / 压缩 / agent loop

`AgentSession` + `SessionManager` 是会话转录、agent loop、压缩与原生重试的唯一所有者（头注 `packages/agent/src/pi-driver.ts:4-9`），驱动只负责装配 Pi 会话（`:432-457`）。业务会话（Main）以 `reuseConversation: true` 复用同一实例跨回合（`scripts/ask-runtime.ts:660`、`packages/agent/src/pi-driver.ts:402`），Worker 每回合一次性新建（`:439`）。

宿主每回合只交「本轮新增输入」：最后一条 user 作 `prompt`，其余仅在驱动尚无会话时作首回合种子（`packages/agent/src/pi-driver.ts:549-552`、`:440-443`）。会话已存在时宿主传什么都进不了 Pi 转录（`:440`）。宿主侧没有可变转录本体：`Session.transcript()` 委托驱动每次重新投影、不缓存（`packages/agent/src/execution-runtime.ts:2142`；`packages/agent/src/pi-driver.ts:727-730`），只留每回合整体覆盖的只读派生值 `lastMainProjection`（`:1421-1430`）。驱动契约没有宿主压缩入口：`TurnDriver` 只有只读 `transcript?()`，无 `compact`（`packages/agent/src/driver-contract.ts:82-89`；守卫 `packages/agent/pi-native-long-lived-session.test.ts:126`）。

## 2. `.runtime/sessions/` 布局与恢复语义

`sessionStoreDir` 缺省 `<dbPath 所在目录>/sessions`（`dbPath` 缺省 `.runtime/state.db`），`cwd` 固定为仓根——`(cwd,id)` 是 Pi 会话身份的一半，跨重启必须稳定（`apps/server/server.ts:252-253`、`:97`）。布局 `<sessionStoreDir>/principals/<sha256(principalId)>/<timestamp>_b1<hex(sessionId)>.jsonl`（`packages/agent/src/session-persistence.ts:440`、`:144`、`:405-410`、`:91-96`）：每 principal 一棵子树，同名 sessionId 跨 principal 物理隔离；业务 id 先经可逆 hex（前缀 `b1`）编成 Pi 允许的 id。

- `(principalId, sessionId)` 至多一个文件，多于一个显式报错，不静默挑一个（`:386-389`）；打开前校验 header 与每行 JSON，坏 header/坏行显式抛错，崩溃半行尾丢弃并修复（`:147-236`）；压缩摘要不能以 message entry 写入（`:121-128`）。
- 运行时端口只有 `readTranscript()` / `append()`（`packages/agent/src/execution-runtime.ts:410-413`）：打开时现读完整转录并记 `persistedCount`（`:1434-1439`），回合后只追加本回合新增（`:2095`）。读写均 fail-open：不阻塞打开、不回滚回合，错误经 `onTranscriptError` 落 `transcript_store_error`（`apps/server/server.ts:417-421`）。
- 恢复：重启后 `(principal, session)` 重新装配，磁盘转录作首回合种子灌入新 Pi 会话（`packages/agent/src/execution-runtime.ts:1434-1439`；`packages/agent/src/pi-driver.ts:440-443`）；任务侧仍走 `runner.pump()`，本层无执行/重放入口。`npm run ask` 单轮入口不注入 `transcriptStore`，不落盘（`scripts/ask-runtime.ts:29`、`:713-714`）；`delete()` 生产无调用者（`packages/agent/src/session-persistence.ts:351`）。
- 守卫：重启恢复/不重放/用户隔离 `apps/server/server-b1-persistence.test.ts:129`、`:177`、`:252`；端口增量与 fail-open `packages/agent/session-persistence-wiring.test.ts:105-145`；原子恢复/隔离/损坏/线性增长 `packages/agent/session-persistence.test.ts:147`、`:203`、`:293`、`:419`。

## 3. 压缩的现行边界

触发、摘要、尾段保留、溢出恢复全部归 Pi（`packages/agent/src/pi-driver.ts:4-9`、`:429`、`:473-478`）。fshine 只把绝对 `CompactionSettings` 交给 Pi，小窗口装不下 Pi 缺省时按比例缩放——是配置适配，不是压缩决策（`:80-115`、`:101`）。宿主不读阈值、不估算 token、不判定压缩，只订阅 `compaction_end` 转述事实（`:429`、`:473-478`）；反向绊线钉住已删自研符号不得回潮（`packages/agent/pi-native-tripwire.test.ts:31-49`、`:156`）。恢复有界由 T5/T6/T7 覆盖（`packages/agent/pi-native-compaction.test.ts:270`、`:284`、`:300`）；1.5.2 补丁 U2：空摘要不得作为压缩检查点入库（删除条件 `patches/README.md:221`；守卫 `packages/agent/pi-152-u2-empty-summary.test.ts:217`）。

⚠️ 落盘的是只读投影，不是 Pi 原生 compaction entry：`projectSession()` 把 `compactionSummary` 渲染成「【此前会话摘要】」user 消息（`packages/agent/src/pi-driver.ts:765-768`、`:782-789`），持久化层只接受普通 message、摘要类显式拒写（`packages/agent/src/session-persistence.ts:121-128`）。故重启后种子历史是「摘要文本 + 当时投影」，不是 Pi 的压缩状态；投影变短时 `persistedCount` 不追加（`packages/agent/src/execution-runtime.ts:2095`）。「压缩 × 持久化」无用例覆盖，落盘完整性**未验证**。

## 4. 被撤销的旧机制

自研压缩编排（force/emergency/溢出恢复臂、`compactTranscriptWithPi`、`TurnDriver.compact`）、旧「每回合重建 Agent + 宿主全量回灌」、旧 R5「每回合追加完整转录快照」均已删除；逐项裁定见 `docs/decisions/index.md`（历史档 §六十九、§九十六）。

## 5. 未解决项：线性无界增长（GitHub issue #67）

Pi 会话日志只增不减——compaction 只把摘要再追加一条 entry，不删旧 message；压缩缩小的是模型上下文，不是日志文件大小（`packages/agent/src/session-persistence.ts:19-22`），单会话文件随消息数线性增长（守卫 `packages/agent/session-persistence.test.ts:419`）。`SessionPersistenceOptions` 只有 `rootDir`/`cwd`（`:47-52`），主体没有 retention/rotate/prune/cap；装配只传 `sessionStoreDir` 与 `cwd`，`ServerDeps` 无保留期/容量字段（`apps/server/server.ts:252-253`、`:97`）。保留策略与容量上限属装配层策略、取哪条未裁定，所以不实现也不假装已解；长期部署需外部磁盘监控，单次 Dummy E2E 不受影响。`fileRetentionDays`/启动清扫只覆盖 run 目录，与 sessions 不重叠（见 `docs/architecture/files.md` §5）。

## 6. 转录的权威边界（重启后最容易搞错的一条）

- **转录只作上下文**：恢复进 Pi 的转录不得成为授权、实体、执行范围的来源（`docs/history/decision-log-part04-2026-11.md:55`）。
- **会话存储不承载任务事实**：只存转录，无任务状态/原因/租约/编号字段，不 import `task-registry`/`task-store`；守卫 `packages/agent/session-persistence.test.ts:453`——任务真相唯一在 `.runtime/state.db`。

## 7. 压缩超窗的接受上界（owner 2026-11-15 明文接受）

允许「可能发出一次必然超窗的请求」，但有界：**每事件至多 1 次 over-window 外发、总发出有界、`retry_scheduled=0`**（`docs/history/decision-log-part05-2026-11.md:682`；绊线 `packages/agent/pi-native-tripwire.test.ts:156-183`）。读作「已接受的残余成本」，不是「待修缺陷」。
