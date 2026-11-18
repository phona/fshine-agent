# 会话转录与上下文压缩

> 状态：现行。Pi 原生会话直接落盘（Main 用磁盘那份 Pi 会话，宿主搬运层已退役）；压缩后死历史 gzip 归档已实施，整体 retention 仍未实现（issue #67）。
> 最后核对：2026-11-18（`path:line` 以现行代码为准；实施过程与实验读数在 `docs/history/decision-log-part*.md`）。
> 上游指针：`packages/agent/src/pi-driver.ts`（唯一 Pi 接缝）、`packages/agent/src/session-persistence.ts`（位置解析 + 落盘校验）、`apps/server/server.ts:259`/`:421`（装配）、`docs/decisions/index.md`。

## 1. 所有权：Pi 独占转录 / 压缩 / agent loop

`AgentSession` + `SessionManager` 是会话转录、agent loop、压缩、落盘与重启恢复的唯一所有者（头注 `packages/agent/src/pi-driver.ts:4-9`），驱动只负责装配 Pi 会话（`:478-521`）。业务会话（Main）以 `reuseConversation: true` 复用同一实例跨回合（`scripts/ask-runtime.ts:762`、`packages/agent/src/pi-driver.ts:409`），Worker 每回合一次性新建（`scripts/ask-runtime.ts:513-514`）。

宿主每回合只交「本轮新增输入」：最后一条 user 作 `prompt`，历史一律由驱动向 Pi 会话索取（`packages/agent/src/execution-runtime.ts:2258`、`packages/agent/src/pi-driver.ts:609-613`）。宿主侧没有可变转录本体，也**没有搬运层**：旧 `TranscriptStore` / `persistedCount` / `readTranscript-as-seed` / 回合后 append 全删，`SessionPersistence` 退化为「路径解析 + 坏文件校验」（`packages/agent/src/session-persistence.ts:1-20`、`:438-458`）；`Session.transcript()` 委托驱动每次重新投影、不缓存（`packages/agent/src/execution-runtime.ts:1650-1652`；`packages/agent/src/pi-driver.ts:785-789`），只留每回合整体覆盖的只读派生值 `lastMainProjection`（`:2375`），回合结束后**不 append 任何消息**（`:2376-2377`）。驱动契约没有宿主压缩入口：`TurnDriver` 只有只读 `transcript?()`，无 `compact`（`packages/agent/src/driver-contract.ts:88`；守卫 `packages/agent/pi-native-long-lived-session.test.ts:126`）。

## 2. 会话布局与恢复语义（Pi 原生 resume）

`sessionStoreDir` 缺省 `<dbPath 所在目录>/sessions`（`dbPath` 缺省 `.runtime/state.db`）。布局 `<sessionStoreDir>/principals/<sha256(principalId)>/<timestamp>_b1<hex(sessionId)>.jsonl`（`packages/agent/src/session-persistence.ts:90-91`、`:117-119`、`:520-522`）：每 principal 一棵子树，同名 sessionId 跨 principal 物理隔离；业务 id 先经可逆 hex（前缀 `b1`）编成 Pi 允许的 id。

- 装配层 `SessionPersistence.resolve(principal, session)` 只解析**位置**（`:438-458`）：已有文件 → `resumeSessionFile`（先校验）；没有 → 只给 `sessionDir` + `piSessionId`（Pi 首条消息才落盘，不预建空文件）。`(principalId, sessionId)` 至多一个文件，多于一个显式报错，不静默挑一个（`:442-447`）；坏 header/坏行显式抛错，崩溃半行尾丢弃并修复（`:163-212`）。
- 驱动侧（`packages/agent/src/pi-driver.ts:186-196`、`:444-458`）：`sessionDir` + `sessionId` 新建 / `resumeSessionFile` 原生 resume（历史与**压缩摘要**都在 Pi entry-log 里，加载时由 Pi 的 `buildContextEntries` 按 compaction 投影）。装配映射见 `scripts/ask-runtime.ts:204-213`；server 解析点 `apps/server/server.ts:647`。
- 恢复：重启后 `(principal, session)` 重新解析 → 同一文件 → Pi 原生 resume，**不重放全部原始消息**（摘要 + 保留尾段）；会话重建（提示/工具集变化、异常丢弃）回到同一份文件（`packages/agent/src/pi-driver.ts:413`、`:444-458`）。`pi-driver` 仍收一次性 `seed` 入参，只灌**新建的内存/首回合**会话，恢复会话不重灌（`:459-462`）。任务侧仍走 `runner.pump()`，本层无执行/重放入口。
- `npm run ask` / eval / Worker 无渠道入口不注入 `mainSession` → 进程内内存会话，不落盘（`scripts/ask-runtime.ts:297`、`:204-213`、`:513-514`）；`SessionPersistence` 没有 `append`/`readTranscript`/`delete`/`close`（写入归 Pi）。
- 守卫：摘要存活/重启不重放/principal 隔离 `packages/agent/pi-native-session-persistence.test.ts:224`、`:240`、`:251`；位置解析/原子恢复/隔离/损坏/增长 `packages/agent/session-persistence.test.ts`（§①②③④⑤ / 增长特性）；归档切分/失败注入 `packages/agent/session-archive.test.ts:231`、`:431`；server 级重启与隔离 `apps/server/server-b1-persistence.test.ts:179`、`:312`。

## 3. 压缩的现行边界

触发、摘要、尾段保留、溢出恢复全部归 Pi（`packages/agent/src/pi-driver.ts:4-9`、`:431`、`:475-480`）。fshine 只把绝对 `CompactionSettings` 交给 Pi，小窗口装不下 Pi 缺省时按比例缩放——是配置适配，不是压缩决策（`:80-115`、`:101`）。宿主不读阈值、不估算 token、不判定压缩，只订阅 `compaction_end` 转述事实（`:431`、`:475-480`）；反向绊线钉住已删自研符号不得回潮（`packages/agent/pi-native-tripwire.test.ts:31-49`、`:156`）。恢复有界由 T5/T6/T7 覆盖（`packages/agent/pi-native-compaction.test.ts:270`、`:284`、`:300`）；1.5.2 补丁 U2：空摘要不得作为压缩检查点入库（删除条件 `patches/README.md:221`；守卫 `packages/agent/pi-152-u2-empty-summary.test.ts:217`）。

压缩状态与转录同源：`compaction` entry 由 Pi 写进会话文件（`_appendEntry`），重启后 `buildContextEntries` 以「摘要 + `firstKeptEntryId` 之后的尾段」重建上下文——**摘要跨重启存活**、被摘要覆盖的早期消息不再进请求（读取面 `projectSession()` 把 `compactionSummary` 渲染成「【此前会话摘要】」user 消息，`packages/agent/src/pi-driver.ts:772-775`、`:789-796`）。守卫 `packages/agent/pi-native-session-persistence.test.ts:224`（首条模型可见消息 = 压缩摘要；上下文 < 全量 1/3）、`:240`（消息数不随历史线性增长）。

**压缩后归档（issue #67 已交付部分）**：活跃文件被重写为「header + 保留段 + 压缩条目」，`firstKeptEntryId` 之前的死历史逐字节 gzip 到 `<sessionDir>/archive/<文件名>.<序号>.jsonl.gz`；先写归档、再临时文件 + rename 替换活跃文件，任何一步失败原文件逐字节不变（`packages/agent/src/session-persistence.ts:264-281`、`:335-347`、`:383-407`）。调用点在 Pi 的 `compaction_end`，成功/失败各落 `session_archive_written` / `session_archive_failed`，归档失败不阻断会话（`packages/agent/src/pi-driver.ts:492-528`）。

## 4. 被撤销的旧机制

自研压缩编排（force/emergency/溢出恢复臂、`compactTranscriptWithPi`、`TurnDriver.compact`）、旧「每回合重建 Agent + 宿主全量回灌」、旧 R5「每回合追加完整转录快照」、宿主转录搬运（`TranscriptStore` / `persistedCount` / `readTranscript-as-seed`）均已删除；逐项裁定见 `docs/decisions/index.md`（历史档 §六十九、§九十六）。

## 5. 未解决项：活跃段与归档保留（GitHub issue #67）

Pi 会话日志在两次压缩之间只增不减——compaction 只追加摘要 entry，不删旧 message；归档只把压缩后已死的段移出活跃文件，不删除 `.gz`，也没有保留期/容量上限（`packages/agent/src/session-persistence.ts:1-20`、`:264-281`），活跃段仍随消息数线性增长（守卫 `packages/agent/session-persistence.test.ts`「增长特性」）。`SessionPersistenceOptions` 只有 `rootDir`（`:44-48`），主体没有 retention/rotate/prune/cap；装配只传 `sessionStoreDir`，`ServerDeps` 无保留期/容量字段（`apps/server/server.ts:256-259`、`:97`）。保留策略与容量上限属装配层策略、取哪条未裁定，所以不实现也不假装已解；长期部署需外部磁盘监控。`fileRetentionDays`/启动清扫只覆盖 run 目录，与 sessions 不重叠（见 `docs/architecture/files.md` §5）。

## 6. 转录的权威边界（重启后最容易搞错的一条）

- **转录只作上下文**：恢复进 Pi 的转录不得成为授权、实体、执行范围的来源（`docs/history/decision-log-part04-2026-11.md:55`）。
- **会话存储不承载任务事实**：只存转录，无任务状态/原因/租约/编号字段，不 import `task-registry`/`task-store`；守卫 `packages/agent/session-persistence.test.ts`「⑥ 不复制任务事实」——任务真相唯一在 `.runtime/state.db`。

## 7. 压缩超窗的接受上界（owner 2026-11-15 明文接受）

允许「可能发出一次必然超窗的请求」，但有界：**每事件至多 1 次 over-window 外发、总发出有界、`retry_scheduled=0`**（`docs/history/decision-log-part05-2026-11.md:682`；绊线 `packages/agent/pi-native-tripwire.test.ts:156-183`）。读作「已接受的残余成本」，不是「待修缺陷」。
