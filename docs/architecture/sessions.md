# 会话转录与上下文压缩

> 状态：现行。Pi 1.5.2 `AgentSession` 适配已实施；B1 会话持久化已接 server 装配；retention 未实现（issue #67）。
> 最后核对：2026-11-18（本轮文档重组；文内 `path:line` 指向现行代码，行号以代码为准）。
> 口径：只写今天做决定 / 排障需要的边界；实施过程与实验读数在 `docs/decisions/index.md` 与 git 历史（历史档 `docs/history/decision-log-2026-11.md`）。
> 指针：`packages/agent/src/pi-driver.ts`（唯一 Pi 接缝）、`packages/agent/src/session-persistence.ts`（落盘）、`apps/server/server.ts:252-253`（装配）。

## 1. 所有权：Pi 独占转录 / 压缩 / agent loop

`AgentSession` + `SessionManager` 是会话转录、agent loop、压缩与原生重试的唯一所有者（头注 `packages/agent/src/pi-driver.ts:4-9`）；驱动负责装配 Pi 会话（`packages/agent/src/pi-driver.ts:432-457`）。业务会话（Main）以 `reuseConversation: true` 复用同一实例跨回合（`scripts/ask-runtime.ts:660`、`packages/agent/src/pi-driver.ts:402`），Worker 每回合一次性新建（`packages/agent/src/pi-driver.ts:439`、`scripts/ask-runtime.ts:660`）。

宿主每回合只交「本轮新增输入」：最后一条 user 作 `prompt`，其余仅在驱动尚无会话时作首回合种子（`packages/agent/src/pi-driver.ts:549-552`、`:440-443`；`packages/agent/src/execution-runtime.ts:1950-1955`）。会话已存在时宿主传什么都进不了 Pi 转录（`packages/agent/src/pi-driver.ts:440`）。

宿主侧没有可变转录本体：`Session.transcript()` 委托驱动读 Pi 会话（`packages/agent/src/execution-runtime.ts:2136`），驱动每次重新投影、不缓存（`packages/agent/src/pi-driver.ts:727-730`、`:758-780`）。`execution-runtime` 只留 `lastMainProjection`——每回合整体覆盖、只覆盖改写的只读派生值，从不追加累积（`:1421-1430`）。

驱动契约没有宿主压缩入口：`TurnDriver` 只有只读 `transcript?()`，无 `compact`（`packages/agent/src/driver-contract.ts:82-89`）。守卫：同会话 5 回合只建 1 个 Pi Session（`packages/agent/pi-native-long-lived-session.test.ts:126`）。

## 2. `.runtime/sessions/` 布局与恢复语义

装配层是唯一构造具体存储处：`sessionStoreDir` 缺省 `<dbPath 所在目录>/sessions`（`dbPath` 缺省 `.runtime/state.db`），`cwd` 固定为仓根——`(cwd,id)` 是 Pi 会话身份的一半，跨重启必须稳定（`apps/server/server.ts:252-253`、`ServerDeps.sessionStoreDir` 见 `:97`）。

物理布局（`packages/agent/src/session-persistence.ts:440`、`:144`、`:405-410`、`:91-96`）：

```
<sessionStoreDir>/principals/<sha256(principalId)>/<timestamp>_b1<hex(sessionId)>.jsonl
```

- 每 principal 一棵子树，同名 sessionId 跨 principal 物理隔离；业务 id 先经可逆 hex（前缀 `b1`）编成 Pi 允许的 id（`:87-96`）。
- `(principalId, sessionId)` 至多一个文件；多于一个显式报错，不静默挑一个（`:386-389`）。
- 打开前校验 header 与每行 JSON；坏 header / 坏行显式抛错，崩溃半行尾丢弃并修复（`:147-236`）；压缩摘要不能以 message entry 写入（`:121-128`）。

运行时端口只有 `readTranscript()` / `append()`（`packages/agent/src/execution-runtime.ts:410-413`）。打开→现读完整转录并记 `persistedCount`（`:1434-1439`）；回合后按 `persistedCount` 只追加本回合新增消息（`:2088-2097`）。读写均 fail-open：不阻塞打开、不回滚回合，错误经 `onTranscriptError` 落 `transcript_store_error`（`apps/server/server.ts:417-421`）。

恢复语义：重启后 `(principal, session)` 重新装配，磁盘转录作首回合种子灌入新 Pi 会话（`packages/agent/src/execution-runtime.ts:1434-1439` + `packages/agent/src/pi-driver.ts:440-443`）；任务侧仍走既有 `runner.pump()`，本层无执行 / 重放入口。`npm run ask` 单轮入口不注入 `transcriptStore`，不落盘会话（`scripts/ask-runtime.ts:29`、`:713-714`）。`delete()` 只在调用方显式调用时删，生产无调用者（`packages/agent/src/session-persistence.ts:351`）。

守卫：重启恢复 / 任务不重放 / 结果找回 / 用户隔离（`apps/server/server-b1-persistence.test.ts:129`、`:177`、`:252`）；端口增量与 fail-open（`packages/agent/session-persistence-wiring.test.ts:105-145`）；原子恢复 / 隔离 / 损坏 / 不重放 / 线性增长（`packages/agent/session-persistence.test.ts:147`、`:203`、`:293`、`:339`、`:419`）。

## 3. 压缩的现行边界

触发、执行（摘要）、尾段保留、溢出恢复全部归 Pi（`packages/agent/src/pi-driver.ts:4-9`、`:429`、`:473-478`）。fshine 只做一件事：把绝对 `CompactionSettings` 交给 Pi；小窗口装不下 Pi 缺省时按比例缩放——这是配置适配，不是压缩决策（`:80-115`、`:101`）。

宿主不读阈值、不估算 token、不判定压缩：生产驱动无 `shouldCompact` / 上下文预算门调用，只订阅 `compaction_end` 转述事实（`packages/agent/src/pi-driver.ts:429`、`:473-478`）。反向绊线钉住已删自研符号不得回潮（`packages/agent/pi-native-tripwire.test.ts:31-49`、`:156`）。

恢复有界：T5 / T6 / T7 分别覆盖超预算有界收束、摘要失败原生有界、溢出恢复完成（`packages/agent/pi-native-compaction.test.ts:270`、`:284`、`:300`）。

1.5.2 依赖补丁 U2：空摘要不得作为压缩检查点入库（上游只拒 `error` / `length`，空正文被当成功会丢历史）。补丁与删除条件见 `patches/README.md:221`，守卫 `packages/agent/pi-152-u2-empty-summary.test.ts:217`。

⚠️ 落盘的是只读投影，不是 Pi 原生 compaction entry：`projectSession()` 把 `compactionSummary` 渲染成「【此前会话摘要】」user 消息（`packages/agent/src/pi-driver.ts:765-768`、`:782-789`），持久化层只接受普通 message、摘要类显式拒写（`packages/agent/src/session-persistence.ts:121-128`）。故重启后种子历史是「摘要文本 + 当时投影」，不是 Pi 的压缩状态；且投影变短时 `persistedCount` 不追加（`packages/agent/src/execution-runtime.ts:2089`）。「压缩 × 持久化」无用例覆盖，落盘完整性**未验证**——不当作已解。

## 4. 被撤销的旧机制

自研压缩编排（请求前 force 臂 / 回合内 emergency 触发 / 溢出恢复臂 / `compactTranscriptWithPi` / `TurnDriver.compact`）、旧「每回合重建 Agent + 宿主全量回灌转录」、旧 R5「每回合追加完整转录快照」三类旧机制均已删除；逐项裁定与删除记录见 `docs/decisions/index.md`（历史档 `docs/history/decision-log-2026-11.md` §六十九、§九十六）。

## 5. 未解决项：线性无界增长（GitHub issue #67）

**是什么**：Pi 的会话日志只增不减——compaction 只把摘要再追加为一条 entry，不删除旧 message；压缩缩小的是模型上下文，不是日志文件大小（`packages/agent/src/session-persistence.ts:19-22`）。单会话文件随消息数线性增长（守卫判据 `packages/agent/session-persistence.test.ts:419`）。

**代码现状**：`SessionPersistenceOptions` 只有 `rootDir` / `cwd`（`packages/agent/src/session-persistence.ts:47-52`）；主体没有 retention / rotate / prune / cap；`delete()` 只在显式调用时删、生产无调用者（`:351`）。装配只传 `sessionStoreDir` 与 `cwd`（`apps/server/server.ts:252-253`），`ServerDeps` 无保留期 / 容量字段（`:97`）。既有 `fileRetentionDays` / 启动清扫只覆盖 run 目录，与 sessions 目录不重叠（见 `docs/architecture/files.md` §5）。

**为什么还没做**：保留策略（按天 / 按大小 / 按会话数）与容量上限属装配层策略，取哪条、配置键放哪都还没裁定，所以没有实现，也不假装已解。补齐判据见 issue #67：明确策略并登记 `docs/environment-variables.md`；清理不动活跃会话、不破坏 crash-tail 修复；清理失败不阻塞回合；容量触顶行为有确定性用例。

**今天的影响**：长期运行的部署需要外部磁盘监控 / 清理；单次 Dummy E2E 与验收规模不受影响。
