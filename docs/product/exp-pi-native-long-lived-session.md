# 长生命周期 Pi 会话（产品装配链）· 根因 / 改法 / 证据 / 局限

日期：2026-11-15　分支：`exp/pi-native-session-compaction`　阶段：三补丁

## 1. 缺陷（阶段四真实模型证据）

`docs/decision-log.md` §九十五（真实模型三场景，step-3.7-flash，降窗 16384/24576/8192）：

- 裸 `AgentHarness` 单会话（A/C）在同等窗口经历 27/23 次阈值压缩，**0 空回复**；
- 产品装配链 `assembleSessionCore` + `createPiTurnDriver` 的补充样本在降窗压缩后出现
  `pi_driver_empty_reply`（`Assistant request exceeded the context window`，`retryScheduled=0`）。

## 2. 根因

产品驱动的 `run()` 在**每次调用内部**新建并关闭 Pi 会话：

- `pi-driver.ts`（改前）`run()` 体内 `new MemorySessionRepo()` → `repo.create` →
  `AgentHarness.create(...)` → `harness.lane('main')`；`finally` 每回合 `harness.close(...)`；
- 为在新空会话上续上下文，每回合把宿主投影转录（`projectTranscript` 产出的
  「摘要 + 保留尾段」，`pi-driver.ts` 的投影逻辑）重新 `appendMessage` 灌一遍。

后果：Pi 的整条生命周期（session entries、usage/阈值估算、压缩条目、溢出恢复所依赖的
会话状态）在回合间不连续。降窗压缩后，下一回合只是一个以「【此前会话摘要】+尾段」
起头的新会话，再叠加新请求即触发超窗/`length` 恢复失败 → 空回复。这违反任务书 §4.1
「同一业务会话的多轮交互复用同一个 Pi Session；不允许每回合重新创建一个丢失上下文的
Pi Session」。

## 3. 改法（最小改动，不引第二套会话/压缩机制）

1. `packages/agent/src/pi-driver.ts`
   - 新增构造期开关 `PiTurnDriverOptions.reuseConversation?: boolean`（缺省 false =
     每回合一次性，Worker/直测行为不变）。
   - 把建会话逻辑抽成 `openConversation()`；`reuseConversation` 时**本驱动实例首次 run
     创建一次**并存入闭包，后续 run 复用（会话生命周期随业务会话、不随回合）。
   - 事件 listener 随会话注册一次；`retry_scheduled`/`run_end` 归因改成每回合可变的
     `slot.current`，避免只认首回合、也避免随回合重复订阅。
   - 每回合用 `harness.setTools()` + `lane.setActiveTools()` 换成本回合工具闭包
     （`exec`/`onStep` 不钉死首回合）。
   - 投影转录改为**增量追加**：记住上一回合交回的投影 `lastProjected`，后续回合只追加
     `input.messages` 相对它的新增尾部（生产上即 `taskFactProvider` 新注入的事实 + 新
     用户消息）；压缩后的 Pi 原生 entry（compaction 条目 + 保留尾段）留在同一 session 里。
     若宿主转录与 Pi 会话不再同源（异常路径），重建会话并全量追加（正确性优先）。
   - `plannerMessagesToLlm` 补上 `role=compactionSummary` → provider user 文本：复用会话时
     Pi 原生摘要必须进请求，否则压缩后的摘要对模型不可见（改前该角色被投影器丢弃，靠
     宿主重灌摘要伪装可见）。
2. `scripts/ask-runtime.ts`
   - `assembleSessionCore` 的缺省装配只给 **Main** 驱动传 `reuseConversation: true`
     （会话对象由 server 按 `(principal, session)` 缓存、CLI 交互会话一个）。
   - Worker 驱动保持每回合一次性：每个委派任务是独立会话，不得跨任务串上下文。

未新增任何第二套会话/压缩机制；压缩触发/摘要/尾段/溢出恢复仍全部归 Pi；A 口径不变。

## 4. 证据（确定性、零真实模型）

新增 `packages/agent/pi-native-long-lived-session.test.ts`（3 条）：

1. **机制绊线（本缺陷反向绊线）**：spy `MemorySessionRepo.prototype.create`；同一驱动
   `reuseConversation: true` 连跑 5 回合 → 只创建 **1** 个 Session。把实现临时改回
   每回合重建（`reuseConversation` 强制 false）后该用例**变红**（`expected 5 to be 1`），
   恢复后转绿。缺省（每回合一次性）语义 5 回合 = 5 个会话（基线，Worker/直测不变）。
2. **行为回归**：假模型（provider 派发前按窗口执法，超出返回溢出错误）、W=8192、12 回合
   长历史 → 每回合回复非空、任何请求不超窗、发生 ≥2 次 Pi 原生压缩，且压缩后宿主投影
   仍能看到 Pi 原生摘要。
3. **工具闭包**：两回合各触发一次工具调用，`exec`/`onStep` 分别为本回合闭包
   （复用 harness 时不钉死首回合）。

回归：

- `npm run typecheck` → 0 错误；
- `npx vitest run` 全量 84 文件 / 877 例：876 通过，1 失败为**既有**问题
  （`scripts/p0-assembly-single-point.test.ts` 报 `scripts/eval/pi-native/r5p4-bare.ts`
  第二装配点）。用 `git stash` 暂存本次改动后在同一基线复跑，该用例同样失败
  （该分支 `1331b51` 引入的 eval 夹具触发的既有红），与本次改动无关。
- T1–T12（`packages/agent/pi-native-compaction.test.ts`，32 例）仍全绿；tool 配对/隔离/
  不重复执行等业务边界不变量沿用既有用例（全量套件内通过）。

## 5. 局限（如实）

- 确定性夹具无法复刻真实 provider 的 `finish_reason=length, output≈1` 行为；在确定性
  假模型下「每回合重建」与「复用会话」的**内容投影**是等价的（都按 Pi 估算器压缩），
  所以本缺陷的**行为**反向绊线由上面的**机制**绊线（Session 创建次数）承担，而不是靠
  假模型复现空回复。真实模型上的空回复归零仍需阶段四同类真实模型复跑确认（本次未跑真实模型）。
- 复用会话在进程内持有 `MemorySessionRepo`（纯内存、无定时器），随驱动实例/业务会话
  释放；本次没有新增显式 `close` 表面（`TurnDriver` 契约未变）。会话驱逐路径（server
  的 sessions map 当前不驱逐成功会话）不新增清理逻辑。
- 同一驱动实例的并发 `run()` 未加锁；生产按 `(principal, session)` 串行化回合、Worker
  驱动一次性，故当前无并发复用路径。后续若出现并发复用需求需另行裁决。
