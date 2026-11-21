> 历史归档：内部链接不保证可用；如需追改，以 git 历史为准。

# docs/decision-log.md · 第 6 块

## 九十五、Pi 原生替换 · 阶段四（真实模型 A/B/C）（2026-11-15，分支 `exp/pi-native-session-compaction`）状态：**实验分支·待裁决**

> 角色：**集成 / 台账登记**（本 run 唯一台账写者）。承接 §八十九–§九十四。阶段三已把产品驱动整体切到 Pi 原生并删净 fshine 自研压缩（含 D1）；**本阶段首次用真实模型跑三场景读数**，只新增评测夹具（`scripts/eval/pi-native/r5p4-real.ts`、`r5p4-bare.ts`，`git show --stat 1331b51` = 2 files / +698，**零产品码改动**）。模型固定 **`step-3.7-flash`**（命令显式 `LLM_MODEL=step-3.7-flash`，provider `openai-completions`），**未混入其他模型**。原始证据落 `.runtime/r5p4/`（`.gitignore:17` 忽略，未入库）。预注册见 `.runtime/r5p4/prereg.md`（真实调用前写下，跑后未改判据、未重采样）。

### 1. 工作区核验（本会话实跑）

- `git -C ~/projects/fshine-agent-exp-pi-session rev-parse --show-toplevel` = `.../fshine-agent-exp-pi-session`（**≠ 主仓** `.../fshine-agent`）；`rev-parse --abbrev-ref HEAD` = `exp/pi-native-session-compaction`；登记前 `git status --short` **空**；HEAD = `1331b51`。**通过。**

### 2. 模型 · 窗口 · 是否降窗（逐组登记）

| 样本 | 驱动形态 | 窗口 | 模型声明上限 | 降窗 | maxTokens | 压缩设置 |
|---|---|---|---|---|---|---|
| A 主样本 `.runtime/r5p4/A-bare` | bare `AgentHarness` 单会话 | **16384** | 262144（`GET /models`） | **是** | 2048 | reserve 4096 / keepRecent 4915 |
| B 主样本 `.runtime/r5p4/B-w24576` | product 装配链（background） | **24576** | 262144 | **是** | 2048 | 同上 |
| C 主样本 `.runtime/r5p4/C-bare` | bare `AgentHarness` 单会话 | **16384** | 262144 | **是** | 2048 | 同上 |

- 降窗用于**提前触发真实阈值压缩**（`piCompactionSettings`），16384/24576 均 **< 模型实际能力 262144**，不超模型能力；**provider 级真实溢出（>262144）未作主路径**（成本/时延不可行，见 §8 局限）。
- `provider-models.get.json` 实测 `max_input_tokens=262144`、`owned_by=stepai`；A/B/C 全部 `provider=openai-completions`、`model=step-3.7-flash`。
- **两种驱动形态并存**（如实登记，非产品码改动）：A/C 用 Pi 设计用法的单一长生命周期 `AgentHarness`+`MemorySessionRepo` 会话（可订阅原生 `compaction_start/end`）；B 用产品装配链 `assembleSessionCore` + `createPiTurnDriver`（每回合重建 harness 并重灌投影转录），因 `run_task/task_status/task_result/task_cancel` 任务底账只在该装配下存在。

### 3. 三主样本读数（预注册 N=3，每场景 1 个独立多轮会话）

| 样本 | 回合 | 模型调用（主/Worker） | 摘要调用 | 阈值压缩（start→completed） | 空回复 | `retry_scheduled` | 工具调用↔结果配对 | wall |
|---|---|---|---|---|---|---|---|---|
| A-bare | 16 | 49（流式 21 + 摘要 28） | 28 | **27 → 27 completed** | **0** | **0** | **5/5**（`execute_operation` 全 completed） | 243476 ms（4m03s） |
| B-w24576 | 10 | 18（main 16 / worker 2） | 0 | **0**（24576 下未触阈） | 0 | —（无错误事件） | **7/7**（run_task/execute_operation/task_status/task_result/task_cancel） | 32140 ms |
| C-bare | 13 | 42（流式 18 + 摘要 24） | 24 | **23 → 23 completed** | **0** | **0** | **5/5**（`execute_operation` 全 completed） | 240365 ms（4m00s） |

- A/C 压缩条目实测 `tokensBefore` 区间：A **13106–15731**、C **12908–15250**；保留尾段消息数 A **7–16**、C **6–18**（`turns.json` 去重后 27/23 条 `compaction` 投影）。压缩后会话均继续正常对话。
- B 主样本 `summaryCalls=0`、`compaction_starts=0`：**该窗口下未触及压缩阈值**，B 的「压缩后追问」未被真实压缩触及（见 §6、§8）。所有样本 `stoppedAtLimit=false`。

### 4. 五项判据（按预注册口径）

| # | 判据 | 本会话实测证据 | 结论 |
|---|---|---|---|
| ① | **压缩恢复**（真实溢出→恢复或有界失败） | A 27/27、C 23/23 `compaction_end status=completed`，压缩后继续多轮、0 空回复；A/C 分别有 2 次 / 7 次**摘要调用** `finish_reason=length`（输出触 2048 上限）但压缩仍 `completed`、会话未坏。provider 级真实溢出未触发。 | **主样本通过**（阈值压缩路径）；**真实 >262144 溢出未测** |
| ② | **工具续发有界**（工具结果致超窗后的续发） | 工具配对 A 5/5、B 7/7、C 5/5；样本内工具结果均较小（96–539 字符），**未构造出「工具结果直接致超窗」的独立用例**；观察到的 `length` 截断均为**摘要调用**（A 2/28、C 7/24），非工具续发，且无 `retry_scheduled`。 | **未直接触发**；同类有界行为成立（不无界） |
| ③ | **重复副作用**（重试不得重复执行任务） | B：`#1` 经 `run_task`→多次 `task_status`/`task_result`/`task_cancel` 后，Task Registry 仍**仅 1 条 execution**（`req_a636afc8…`）；`#2` 直接 `failed/resource_limited`、**0 条 execution**。A-bare/C-bare 各 5 次执行均一次一结果。A-8192 pilot `#1` 有 2 条 execution，来自同一 `run_task` 内 Worker 的 recent→W2 两步查询（仅 3 次 `run_task` 对应 3 个任务），**非模型重试重放**（参数未落证据，见 §8）。 | **未发现重复执行** |
| ④ | **失败上界** | 全部样本 `retryScheduled=0`；A/C 压缩次数有限（27/23，随回合推进而非循环）；product 降窗失败为**逐回合**空回复，事件内不自动重试（见 §7）。A/C 有背景回合每回合触发 **1–3 次**压缩（A 峰值 3、C 峰值 3），源于用户每轮投喂 ~5.9k 字背景块跨阈，**非零收益循环**。 | **未发现无界重试/零收益循环** |
| ⑤ | **真实 token·成本** | 见 §5；`usage.cost` 全部为 **0**（provider 未返回计价），**不编造成本**。 | **已记录** |

### 5. 真实 token · 耗时（逐会话）

| 样本 | calls | input | output | totalTokens（provider usage，含 cacheRead） | cacheRead | wall |
|---|---|---|---|---|---|---|
| A-bare | 49 | 151531 | 36736 | **329835** | 141568 | 243476 ms |
| B-w24576 | 18 | 19343 | 3717 | **144596** | 121536（=total−in−out，用量未单列） | 32140 ms |
| C-bare | 42 | 202292 | 34768 | **289668** | 52608 | 240365 ms |

- 逐次调用 token/耗时见各样本 `model-calls.jsonl`（A/C：`kind=streamSimple|completeSimple` + `usage`；B：`kind=stream` + `label=main|worker`）。
- 成本：provider `usage.cost` 全 0，本次**无法给出真实货币成本**；只能报告 token 与耗时。

### 6. 压缩后追问（早期信息 / 用户明示约束 / 任务事实）

- **A（27 次压缩后）**：第 7、14、15 回合均正确复述「项目代号 **蓝鲸-42** / **简体中文**」（用户明示约束跨 20+ 次压缩保持）；第 16 回合追问**最早背景 A1 的主题**时回答「在现有对话历史中**未记录 A1 的具体内容**……请提供 A1 内容」——早期细节丢失但**未编造**（诚实缺失）。
- **C（23 次压缩后）**：第 13 回合问第 1 段背景，回答「当前可访问的对话记录中仅包含第 4 至第 9 段（C4–C9）……**未找到第 1 段背景（C1）**」——同样诚实缺失、未编造。第 9–12 回合对内容相同的 C4–C9 反复概括（用户连续投喂同文），**属用户输入重复，不是压缩重复摘要**。
- **B（10 回合，窗口 24576，未发生压缩）**：第 8 回合正确回溯最早任务「**#1**」及其原文结果（recent 窗口无数据、无法统计条数）；第 10 回合正确列出 2 个任务及状态（#1 completed / #2 failed）；第 9 回合 `task_cancel` 返回 `outcome=terminal`，回复如实转述「状态 completed（终端状态）」，**未谎称已取消**。因**未触压缩**，B 的「压缩后追问」在本主样本中**未被验证**（见 §8）。

### 7. 稳定性：product 装配链在降窗下压缩后空回复（如实登记，未判硬失败）

| 补充样本（非 N=3 主样本） | 窗口 | 回合 | 空回复 | 现象 |
|---|---|---|---|---|
| `.runtime/r5p4/A`（product） | 24576 | 16 | **7**（第 10–16 回合） | 真实阈值压缩后出现 `Assistant request exceeded the context window`（`finish_reason=length`），该回合空回复 |
| `.runtime/r5p4/A-8192-pilot`（product） | 8192 | 10 | **6**（第 4、6–10 回合） | 同上 |
| `.runtime/r5p4/B`（product） | 8192 | 10 | **7**（第 4–10 回合） | 同上 |

- 三组均为 `pi_driver_empty_reply`，**`retryScheduled=0`**、`attempt=1`、`driverEvents` 中无自动重试；**事件内有界**。裸 `AgentHarness` 单会话在同等窗口（A 27 次、C 23 次压缩）**0 空回复**，差异定位在「每回合重建 harness + 重灌投影转录」的装配接法，**不是 Pi 压缩本身**。
- 按预注册硬失败清单（无界恢复 / 任务重复执行 / 越权 / 虚假完成或取消回执）**均未命中**，故**不判 `blocked`**；但该 product 降窗稳定性问题**阻断「稳定通过」结论**，登记待 owner 裁决（定位修复 vs 仅在正常大窗口下使用）。原始事件见各样本 `events.jsonl`/`summary.json`。

### 8. 局限（N=3 探索性，不外推）

- 预注册 **N=3、每场景 1 个会话**，只作探索性读数，**不作统计推断**；未重采样、未筛绿。
- **provider 级真实溢出（>262144）未测**；压缩均为阈值压缩（真实模型、真实摘要调用）。
- **B 主样本未触压缩**（24576、18 calls、0 summary），其「压缩后追问早期任务」未在真实压缩条件下验证；B/8192 补充样本触发了压缩但出现空回复。
- 判据 ②「工具结果直接导致超窗后的续发」**未构造独立用例**；A-8192 pilot `#1` 的 2 条 execution 参数未落证据，无法逐参数确认其非重放（现有证据仅显示同一 `run_task` 内两步查询）。
- 摘要调用达输出上限：A **2/28**、C **7/24** 次 `finish_reason=length`（输出 2048）——摘要可能被截断，压缩仍标 `completed`；本次未评估摘要截断对信息保真的影响。
- 成本不可得（`usage.cost=0`）；`maxTokens=2048` 在小窗下易与窗口冲突，8192 窗输出频繁触顶。
- 证据文件 `.runtime/r5p4/` 为 gitignored 原始材料，**未入库**；仓库内仅评测夹具（`scripts/eval/pi-native/r5p4-*.ts`）。

**指针**：`.runtime/r5p4/prereg.md`、`.runtime/r5p4/{A-bare,B-w24576,C-bare}/{turns,model-calls,summary,tasks,execs,events}.*`、补充 `.runtime/r5p4/{A,A-8192-pilot,B}/`、`scripts/eval/pi-native/r5p4-real.ts`、`scripts/eval/pi-native/r5p4-bare.ts`；关联 §八十九–§九十四。

**状态：实验分支·待裁决。**（真实模型三场景探索性读数已登记；product 装配链降窗压缩后空回复待定；待 owner 裁决。未改判据、未重采样、未改产品码。）

---

## 九十六、阶段三补丁 · 单长生命周期 Pi Session（§4.1）（2026-11-15，分支 `exp/pi-native-session-compaction`）状态：**实验分支·待裁决**

> 角色：**集成 / 台账登记**（本 run 唯一台账写者）。承接 §九十五：阶段四真实模型暴露 **product 装配链 `assembleSessionCore` + `createPiTurnDriver` 在降窗压缩后 `pi_driver_empty_reply`**（`Assistant request exceeded the context window`、`retryScheduled=0`），同窗口裸 `AgentHarness` 单会话 0 空。本补丁按任务书 §4.1「同一业务会话多轮交互复用同一个 Pi Session；不允许每回合重建丢失上下文的 Pi Session」做**最小改动**修复。提交 **`7e20fbd`**（`git show --stat` = 4 files / +454 −42），**未烧真实模型**（确定性夹具 + 假模型）。

### 1. 工作区核验（本会话实跑）

- `git -C ~/projects/fshine-agent-exp-pi-session rev-parse --show-toplevel` = `.../fshine-agent-exp-pi-session`（**≠ 主仓**）；`--abbrev-ref HEAD` = `exp/pi-native-session-compaction`；登记前 `git status --short` **空**；HEAD = `7e20fbd`。**通过。**

### 2. 根因（每回合重建会话）

- `packages/agent/src/pi-driver.ts`（改前）`run()` 体内每回合 `new MemorySessionRepo()` → `repo.create` → `AgentHarness.create(...)` → `harness.lane('main')`，`finally` 每回合 `harness.close(...)`；为在新空会话上续上下文，每回合把宿主投影转录（`projectTranscript` 产出的「摘要 + 保留尾段」）重新 `appendMessage` 灌一遍。
- 后果：Pi 的 session entries / usage·阈值估算 / 压缩条目 / 溢出恢复所依赖的会话状态**回合间不连续**；降窗压缩后下一回合是以「【此前会话摘要】+ 尾段」起头的新会话，叠加新请求即触超窗、`length` 恢复失败 → 空回复。**违反 §4.1。**

### 3. 改法（最小改动，不引第二套会话/压缩机制）

1. `packages/agent/src/pi-driver.ts`
   - 新增构造期开关 `PiTurnDriverOptions.reuseConversation?: boolean`（**缺省 false** = 每回合一次性，Worker/直测行为不变）。
   - 抽出 `openConversation()`；`reuseConversation` 时**本驱动实例首次 run 创建一次并持有**，后续 run 复用（会话生命周期随业务会话、不随回合）。
   - 事件 listener 随会话注册一次；`retry_scheduled` / `run_end` 归因改为 per-run 槽 `slot.current`（不随回合重复订阅、不只认首回合）。
   - 每回合 `harness.setTools()` + `lane.setActiveTools()` 换本回合工具闭包（`exec`/`onStep` 不钉死首回合）。
   - 投影转录改**增量追加**：记住上一回合交回的 `lastProjected`，后续回合只追加 `input.messages` 相对它的新增尾部（生产上即新注入事实 + 新用户消息）；不再重灌历史。宿主转录与 Pi 会话不再同源（异常路径）→ 重建会话并全量追加（正确性优先）。
   - `plannerMessagesToLlm` 补 `role=compactionSummary` → provider user 文本：复用会话时 Pi 原生摘要须进请求，否则压缩后摘要对模型不可见（改前该角色被投影器丢弃，靠宿主重灌摘要伪装可见）。
2. `scripts/ask-runtime.ts:475`：`assembleSessionCore` 缺省装配**仅 Main 驱动**传 `reuseConversation: true`（会话对象由 server 按 `(principal, session)` 缓存）；**Worker 驱动保持每回合一次性**（每委派任务独立会话，不跨任务串上下文）。

- **未新增第二套会话/压缩机制**；压缩触发/摘要/尾段/溢出恢复仍全部归 Pi；**A 口径不变**。

### 4. 验收（本会话实跑，零真实模型）

| 项 | 命令 | 结果 |
|---|---|---|
| ① typecheck | `npm run typecheck` | **0 错误** |
| ② 全量单测 | `npm test` | 84 文件 / 877 例：**876 通过，1 失败**（见下） |
| ③ 回归（本缺陷反向绊线） | `npx vitest run packages/agent/pi-native-long-lived-session.test.ts` | **3/3 通过** |
| ④ T1–T12 | `npx vitest run packages/agent/pi-native-compaction.test.ts` | **32/32 通过** |

- **② 的唯一失败为既有问题，与本次改动无关**：`scripts/p0-assembly-single-point.test.ts` 报 `scripts/eval/pi-native/r5p4-bare.ts` 第二装配点；`git show --stat 1331b51` 显示该夹具由**阶段四评测夹具提交**引入（`r5p4-bare.ts` +300），`git show --stat 7e20fbd` **不含** `r5p4-bare.ts`。**例数 877 未减**。
- **③ 新增 `packages/agent/pi-native-long-lived-session.test.ts`（3 条）**：①**机制绊线**——spy `MemorySessionRepo.prototype.create`，`reuseConversation` 下同一驱动连跑 5 回合**只创建 1 个 Session**；缺省（每回合一次性）基线 5 回合 = 5 个会话（该断言即反向绊线：实现回退成逐回合重建则 ① 先红，报 `expected 5 to be 1`）。②**行为回归**——假模型（provider 派发前按窗口执法，超出返回溢出错误）、`W=8192`、12 回合长历史 → **每回合回复非空**、任何请求 `over=0`、峰值 ≤ 窗口、发生 ≥2 次 Pi 原生压缩且压缩后宿主投影仍见 Pi 原生摘要。③**工具闭包**——两回合各触发一次工具调用，`exec`/`onStep` 分别为本回合闭包。
- **④ 业务边界不变量不退化**：tool 配对 / principal·session 隔离 / 不重复执行等沿用既有用例，均在 ② 全量套件内通过；Worker 每回合一次性语义由 ① 基线断言兜底。

### 5. 硬边界遵守

- **不改** Worker 提示/任务账本/执行契约语义；**不放宽 A 验收口径**；**不引** Runtime 治理；**不重引入**自研压缩。改动仅：`packages/agent/src/pi-driver.ts`、`scripts/ask-runtime.ts`、新增 `packages/agent/pi-native-long-lived-session.test.ts`、新增 `docs/product/exp-pi-native-long-lived-session.md`（4 files）。`.runtime/` 未入库。

### 6. 局限（如实）

- 确定性夹具**无法复刻真实 provider 的 `finish_reason=length, output≈1`**；在假模型下「每回合重建」与「复用会话」的内容投影等价，故**行为**反向绊线由**机制**绊线（Session 创建次数）承担，**空回复归零仍需阶段四同类真实模型复跑确认（本次未跑真实模型）**。
- 复用会话在进程内持有 `MemorySessionRepo`（纯内存、无定时器），随驱动实例/业务会话释放；未新增显式 `close` 表面（`TurnDriver` 契约未变）；server sessions map 不驱逐成功会话（沿用既有，未新增清理）。
- 同一驱动实例的并发 `run()` 未加锁；生产按 `(principal, session)` 串行化回合、Worker 驱动一次性，当前无并发复用路径。

**指针**：`packages/agent/src/pi-driver.ts`、`scripts/ask-runtime.ts:475`、`packages/agent/pi-native-long-lived-session.test.ts`、`docs/product/exp-pi-native-long-lived-session.md`、提交 `7e20fbd`；关联 §八十九–§九十五。**未烧真实模型。**

**状态：实验分支·待裁决。**（product 装配链单长生命周期会话已改并过确定性验收；真实模型空回复归零待阶段四复跑确认；待 owner 裁决。）

---

## 九十七、U3 稳定逻辑操作身份 `dispatchKey` 合入（2026-11-16，分支 `arch/u3-merge`，基线 = `arch/integration` @ `1ab097d` + U3 `c89eafc`）状态：**已合入 integration 待推送**

### 1. 结论摘要

Pi 1.5.2 迁移 U3（恢复/重试后同一逻辑写操作被重复执行）以**宿主侧最小身份面**收口：新增一张操作账
（`operations`）与一个既有事件的可选转发（`TurnDriverInput.onRuntimeEvent`），没有新增 Planner/Router/
意图分类器/计划门/事件总线/第二套 Task Registry，也没有新任务状态。歧义一律**拒绝并交还待核对**，不猜绑定。

已合入 `arch/integration` 的内容：`c89eafc`（U3 实现 + 设计文档 + 三条守卫测试）；独立复审给出的两条缺口
（收尾判定顺序 bug、证据 md5 未登记）在本次合并中修复并加守护测试。

### 2. 两层身份（不混用）

| 层 | 标识 | 作用域 | 谁铸造 |
|---|---|---|---|
| 交办意图 | `delegationId`（复用既有 `taskId`） | 一次用户交办 / 一个任务行 | 宿主，受理时 |
| 业务操作 | `dispatchKey = dk_<scopeKey>:<opSeq>` | 交办内单次逻辑操作（`task:<taskId>`）或 Main 回合内单次 `task_run`（`turn:<sessionId>:<turnNo>`） | 宿主，**首次**认领时；此后只读 |

- `opSeq` 是作用域内自增号（MAX+1，永不复用），与 `taskNo` 同口径；`dispatchKey` 是 `(scopeKey, opSeq)` 的纯函数。
- 身份只在 R0 铸造；重试/恢复路径只 `bind`，不 `mint`（`dispatch-key-tripwire.test.ts` G2：账表两处派生键、无 `randomUUID`）。
- `ExecutionRequest.dispatchKey` 是唯一新增契约字段（必填字符串）；`requestId` 仍每次换号，只作追踪。

### 3. 原子认领与同 key 异 op 冲突

- `claimOperation` 的输入结构**不接受 args**（`OperationClaimInput` 无 `args` 字段，决策函数不读参数）——「按参数文本去重」没有代码路径（G1）；`operations` 表唯一约束只表达身份（`dispatch_key` 主键 + `(scope_key, op_seq)`），无内容列/哈希列（G3）。
- **先落库再调用**：调用执行层之前必有一行 `claimed`（进程死亡窗口里有记录）；并发/重入由 registry 侧原子完成（SQLite 在 `BEGIN IMMEDIATE` 写事务里）；进行中的重复请求返回 `in_progress`，不发起第二次执行。
- **同 key 异 operation → 确定性拒绝**：`DispatchConflictError`（`code=dispatch_conflict`），零副作用、账行不改。
- 同 key 同 operation 且已落定 → 原样回放 `outcome_json`，**零调用、零新执行行**（一行 = 一次真实执行）。

### 4. 重绑定规则 R0–R5（唯一充分证据 = 运行时自己宣布丢弃并重试）

| # | 输入事实 | 规则 |
|---|---|---|
| R0 | 无打开窗口 | 铸新 op、`INSERT claimed`、再调用。两笔合法相似/同参数操作都走这里 → 两个 key、各执行一次 |
| R1 | 窗口内恰有 1 条同名 op，已落定 | 绑定该行、回放结果，不发起第二次调用 |
| R2 | 窗口内恰有 1 条同名 op，但 `claimed/unknown` | R4 待核对（绝不重放未知结果） |
| R3 | 窗口内同名 ≥2 条 | R4 待核对（不赌顺序、不按位置猜） |
| R4 | 任何无法证明的情形 | 停止副作用；op 行 `unknown` + reason；交办 `running→failed + reason=result_unknown`；工具结果固定「待核对」话术 |
| R5 | 跨进程 / Pi 会话 resume | **不自动重绑**：旧交办租约过期即 `result_unknown`；用户重发 = 新交办（既有「重复同一句话是新授权」口径） |

硬禁令：① 重试不得另铸身份；② 不得按参数绑定；③ 歧义只由 R4 处理，不得为了消歧新增治理。

### 5. 重放窗口生命周期（`attempt`）

- 初值 1；只在两类原生事件推进：正常 assistant 响应结束（新响应边界）、recovery（`compaction_end.willRetry` / `auto_retry_start` / assistant `message_end` `stopReason='error'`）。
- **开**：只由 recovery 打开，窗口号 = 当前 `attempt`，随后 `attempt += 1`；同一次失败的多个事件在窗口未消费前幂等（只开一次）。
- **关**：被重试的响应结束先 disarm（窗口保留给它自己的工具调用），下一次 `assistant_end` 关闭；已消费后再 recovery 先关旧窗再开新窗。
- **清空**：关闭即删除 `window` 与相位，不留可被后续响应使用的绑定；`attempt` 只增不复用；窗口随 `send`/单次交办结束整体丢弃，不跨回合、不跨任务。
- 接线：驱动 `pi-driver.ts` 转发三个原生事件，runtime 在 **Main 回合 / inline Worker 回合 / 后台 TaskExecutor 回合**三处都接 `onRuntimeEvent`（G4 源码级守卫断言恰 3 处）。529 自动重试也算窗口信号（`c89eafc` 补）。

### 6. 结果未知 → 待核对（不新增状态）

- 调用中断/无回执 → op 行 `markOperationUnknown`（`unknown` + reason），不自动重试。
- 任务落 `failed + reason=result_unknown`（既有 `markResultUnknown` 与既有原因枚举）；用户可见固定话术「结果待核对…需要人工核对后再决定是否重办」。
- `dispatchKey` / `dk_` 是内部术语：通知文案黑名单已扩展（G5），用户只看到「已执行 / 失败 / 结果待核对」。
- **不是** Exactly Once：宿主只承诺「同一身份至多一次自动执行 + 结果未知可核对」；幂等键/状态查询/回读归执行层。

### 7. 本次合并的两条复审缺口修复

1. **待核对优先于取消（真 bug，`execution-runtime.ts` createTaskExecutor 收尾）**：原实现先判 `context.signal.aborted`（→`cancelled`）再判 `unresolved`，与紧邻注释相反。改为两条返回路径都先判 `unresolved`（→`result_unknown`）再判 abort；与 TaskRunner 落库路径一致（`cancelling + result_unknown` 先回 `running` 再落 `failed/result_unknown`）。
   守护测试 `packages/agent/result-unknown-cancel.test.ts`（3 例：执行端结局、TaskRunner 真实取消路径、无 unknown 的取消仍为 `cancelled` 反向绊线）。反向验证：把顺序改回 bug 版 → 前两例红（`expected 'cancelled' to be 'result_unknown'`）、第三例绿；恢复后 3 例全绿。
2. **证据完整性补登**：`docs/product/pi-152-dependency-patches.md` 增加两份不可变证据文件的 git pin（`c61e784`）与 md5（prepatch `346f5ed9…`、postpatch `cecdc56d…`），并写明 pin 为权威、md5 为同 pin 的便利校验。

### 8. 合并面与冲突

- 唯一冲突文件：`packages/agent/src/execution-runtime.ts`（`RuntimeOptions`）：integration 侧 B1 转录端口（`transcriptStore`/`onTranscriptError`）与 U3 侧 `readOnlyOperations` **两个独立字段都保留**。
- integration 侧独立修复全部保留：B1 转录所有权（打开现读→首回合种子、回合后只追加本回合新增、写失败 fail-open）、B1 持久化/恢复用例、B2 Silent Shadow 用例。
- U3 侧窗口与认领逻辑整块合入（`execution-runtime` / `pi-driver` / `task-registry*` / `task-store` / `task-runner` / 契约 / 通知黑名单）。
- 机械适配（仅类型面，不改任何断言）：integration 新增的 `ExecutionFace` 字面量补上 U3 变为必填的 `readOnlyOperations`（语义仍是只读 `dummy.query`）：`apps/server/server.test.ts` B2 用例、`apps/server/server-b1-persistence.test.ts` 六处、`scripts/eval/long-session/multiuser/mu-support.ts`。

### 9. 硬门读数（2026-11-16，worktree `~/projects/fshine-agent-u3`，`TMPDIR=~/.tmp`）

| 门 | 命令 | 退出码 | 读数 |
|---|---|---|---|
| 类型 | `npm run typecheck` | **0** | 无输出 |
| 全量测试 | `npx vitest run` | **0** | **109 文件 / 1103 passed + 1 skipped（1104 例）**；基线 `1ab097d` = 103 文件 / 1057 例，例数 +46、零失败 |
| 补丁绊线 | `packages/agent/pi-152-patch-applied-tripwire.test.ts`（全量内） | **0** | 5 passed；`grep -c MIN_DERIVED_MAX_TOKENS node_modules/@earendil-works/pi-ai/dist/api/simple-options.js` = **2** |
| dispatchKey 门 | `npx vitest run packages/agent/dispatch-key-registry.test.ts packages/agent/dispatch-key-tripwire.test.ts` | **0** | 2 文件 / **31 passed**（registry 25 + tripwire 6） |

唯一 skipped 是既有的「旧 B1 记录格式」用例（linked worktree 缺 `pi-agent-core@0.85.x`），非本次引入。

### 10. 残余风险（三条，如实登记）

1. **事件接线是保证的前提**：若某条恢复路径不产生/不转发上述原生事件，重绑定保证就不成立（L1）。当前由 G4 源码级守卫盯住三处接线；新增执行面必须一并接线。
2. **模型拆单/改写 operation 名**（L3/L6）：同一业务意图被拆成两次调用 → 两个 key、各执行一次，可能重复写入一次。这是**明确接受的失败形态**，兜底在执行层（幂等键/状态查询/回读）；文档不得写成「不会重复」。
3. **跨进程/Pi 会话 resume 不自动重绑**（L4）：旧交办租约过期即 `result_unknown`，用户重发视为新交办；将来接上 resume 需补 R5 用例。

**指针**：`docs/product/pi-152-dispatch-key-design.md`、`packages/agent/src/task-registry.ts`（`claimOperation`/`decideOperationClaim`/`DispatchConflictError`）、`packages/core/src/task-store.ts`（`operations` 表）、`packages/agent/src/execution-runtime.ts`（`newAttemptWindow`/`noteRuntimeEvent`/`claimAndRunOperation`）、`packages/agent/src/driver-contract.ts`（`RuntimeTurnEvent`）、`packages/agent/dispatch-key-{identity,registry,tripwire}.test.ts`、`packages/agent/result-unknown-cancel.test.ts`；提交 `c89eafc`、`aaf8a3e`、`e59310a`、`c570f1f`。

**状态：已合入 integration 待推送。**（`arch/u3-merge` 已推送即完成；未合 main、未动 tag、未 force；真实 SaaS 未接触。）

## 九十八、P2 业务端到端验收 · 七场景落成与确定性自检（2026-11-16，分支 `arch/p2-e2e`，基线 = `arch/integration` 启动时 HEAD `1ab097d`）状态：**实现完成·确定性自检通过·待真实模型执行**

> 授权与边界：owner 授权在独立 worktree 落成预注册 `docs/eval/business-e2e-batch2-prereg.md` 的七类场景，**本轮零真实模型**（provider 并发额度让给其他线）、零真实平台/写，不 push main。新增代码全部在 `scripts/eval/p2/**`（eval 胶水）；产品码 `packages/**`、`apps/**` 零改动。

- **交付物（新增 5 文件 / 改动 4 文件）**：新增 `scripts/eval/p2/{p2-types,p2-harness,p2-oracle,p2-scenarios}.ts` + `{p2-oracle,p2-scenarios}.test.ts`；改动（均为复用接缝/登记，非语义扩张）：`scripts/eval/business-e2e/shared-instance.ts`（导出 `recordingDriver` 供复用）、`scripts/eval/long-session/evidence.ts`（`Track` 并集追加 `'P2'` 标签，**判定语义零变化**，有守卫用例）、`scripts/eval/long-session/multiuser/mu-support.ts`（导出 MU 计划驱动、`createMuServer` 增 `createDrivers` 透传、`MuTaskSnapshot` 补 `failureReason/resultText` 只读投影）、`packages/agent/resource-policy-single-source.test.ts`（按该守卫既有「新增读者必须登记」路径登记 P2 场景文件的 RuntimeConfig 构造）。
- **复用（未建第二套框架）**：生产同源 `createServer`（与 `npm start` 同链）+ 真实 Pi 驱动 × 脚本化 provider（`testing/scripted-model-runtime`）+ 仓内 dummy 执行层（经装配链唯一入口 `resolveExecutionFace`，不旁路）；逐轮管线 `r6/harness.ts:runHarnessSession`；Oracle `r6/oracle.ts`（事实/H3/H4/H5/E-G）、`r6/compaction.ts`（H6）、`business-e2e/judge.ts:judgeMechanical`（越权/重复/虚假完成）；记账 `r6/accounting.ts`；证据 `r6/evidence.ts:collectEvidence`；多用户/重启 `r6/multiuser/mu-support.ts`；统计 `r6/oracle:FACT_TRUTH` 真值。
- **七场景（S7 拆三子例，共 9 个 case）**：S1 交办（inline；事实 `alpha 2/2000` + 真实 taskNo；硬零 H4/E-G/false_completion/unauthorized）；S2 异步中继续对话（background + 执行面完成闸；硬零 H4/E-G/cross_principal_leak）；S3 查进度与结果（background；逐字存档 + deliveredTo）；S4 修改·取消·再交办（background 单槽排队 + 队列取消；硬零 H5/H3/H4）；S5 重启恢复（同 dbPath 关停重建 + 新执行面零调用；硬零 重放/跨读/旧回合冒充）；S6 三用户并发（会合栅；硬零 cross_principal_leak/task_crossover/unauthorized_execution/notification_misdelivery/fake_concurrency）；S7a `faulty-one` 真实 `COLLECTION_FAULT`；S7b `workerTurnMs=5000` + 不返回执行 gate + deadline 契约 Worker 驱动 → `timed_out`；S7c 四集合一次核完（H6.a/H6.b + 重试有界）。
- **确定性自检读数**：`npm run typecheck` = **0 错**；`npx vitest run` = **105 文件 / 1099 通过 + 1 skipped（1100）**（基线 103 文件 / 1057 通过 + 1 skipped，例数 +42 未减）。反向绊线 11 条全部按预期转红：真值篡改（E-A）/ 伪造零执行（H4 → product_fault）/ 受理话术冒充结果（`result_verbatim_from_archive` + E-A）/ 谎称已取消（H5）/ 旧回合冒充（`retrieval_verbatim` + `no_old_turn_substitution`）/ 编造数值（`no_fabricated_numbers`）/ 谎报超时（`reply_reports_timeout_honestly`）/ 注入 task_crossover 与 H6.a（硬零不可抵消）/ 未触发超时 → `insufficient_coverage`（不折算产品负）/ S2 冲突自证。
- **并发隔离与记账证据**：同场景两批并行各得 3 任务、taskId 不相交、证据目录不同；执行事实按 principal 归属逐条核对；证据落盘含逐回合回复、任务快照/终态、执行轨迹、`model-calls.jsonl`（逐次 `kind`：main/summary/retry/overflow_recovery）与样本全量 `callAccounting`。
- **预注册自身矛盾（已登记，不改口径）**：§一 S2 强制 `dispatchMode='background'`，而 background 的 `run_task` 只回受理回执（`execution-runtime.ts:591`），Main 同回合拿不到 beta 数据；§一 S2 Oracle 却要求 T2 回复含 `beta 3/1000`。**合规产品在强制装配下不可满足该事实判据**。本实现按字面保留判据并把样本标 `preregBlocked`（不作为产品通过/失败结论），等 owner 裁定：把 beta 事实判据下移到结果取回轮，或允许 beta 走 inline 子路径。
- **确定性跑不了、须真实模型确认的清单**：① 真实模型是否能遵守 S1/S3/S4 的工具与如实转述纪律（S4 取消 intent 的措辞与顺序）；② S2 的真实模型 T2 行为（进一步验证上述冲突）；③ S3/S7c 的「结果逐字从存档转述」在真实模型下的稳定性（确定性侧由夹具合成回复，不可替代）；④ S6 真实模型的并发交错与通知措辞（本确定性跑用 MU 计划驱动，零模型调用）；⑤ S7b 真实 Pi 驱动对「执行面不返回」的截止行为（本侧用预注册允许的 deadline-honoring 脚本化 Worker 驱动）；⑥ 压缩/摘要/重试/溢出恢复四类调用在真实压缩压力下的分离计量（本侧只覆盖分类器与 main 路径）。
- **其他如实登记**：S6 的确定性跑以 MU 计划驱动（零模型调用）验证隔离/归属/会合栅，不为模型面读数；通知投递为共享 sink + 任务 owner 映射核对（真实渠道投递归后续切片）；`.runtime/**` 一律 gitignored、未 `git add`。

**指针**：`docs/eval/business-e2e-batch2-prereg.md`、`scripts/eval/p2/p2-scenarios.ts`（七场景定义与跑法）、`scripts/eval/p2/p2-oracle.ts`（`classifyP2Sample` 接缝与硬零合成）、`scripts/eval/p2/p2-harness.ts`（装配/记账/证据）、`scripts/eval/p2/p2-scenarios.test.ts`（确定性自检 + 反向绊线）。**未烧真实模型。**

**状态：实现完成·确定性自检通过·待真实模型执行。**

---

## 九十九、CAP-01 收口裁定：S3 能力包络 / 保留期与清理 / 并发 4 / 催问扩展 / 渠道三档 / 软链 fail-closed / fileParams / 跨会话不做（2026-11-17，分支 `arch/integration` @ `23ae585`）状态：**已裁定·主面已合入 integration；Codex 第 4 批两项修复在分支待合**

**日期**：2026-11-17（裁定日）。**对象**：CAP-01 收口的九项裁定与落地。**边界**：本条目只追加，不改历史条目；判据口径与读数明细仍以 `docs/product/cap01-record.md` §8–§12.1 为准，本节负责把「裁定了什么、依据在哪、落在哪个提交、影响谁、还差什么」集中成可检索条目。

### 1. 裁定总表

| # | 裁定 | 依据 | 落地提交 | 影响面 | 未覆盖 |
|---|---|---|---|---|---|
| 1 | S3 端到端 **2/5** 接受为**模型能力包络**，不建宿主强制；判据只判 Main 面；旧口径 0/5 保留 | `docs/product/cap01-record.md:79-88,105,110-113,135`；`scripts/eval/cap01/row-data-scan.ts:2-10,46,83-91`；`scripts/eval/cap01/r2-functional.ts:861-863` | `844fb3c`（判据收窄）、`267cfd0`（读数更正）；裁定记录于 `7806428`（cap01-record §11） | 评测口径变化，产品行为零改动；Main 面泄漏仍是模型自觉，不是宿主不变量 | `cap01-record.md:90` 仍留早期「新口径 3/5」字样，与同节 `:86-88` 及 §9 `:105` 的 2/5 不一致（历史条目，不改） |
| 2 | 磁盘保留期缺省 **30 天**；显式执行器 `npm run cleanup:runs`；只删 run 目录、不碰 `file_refs`；`--dry-run` 零删除 | `packages/agent/src/resource-policy.ts:148,170,201-211`；`package.json:14`；`scripts/cleanup-runs.ts:12-18`；`packages/agent/src/run-dir-cleanup.ts:8,11,17-18,25-26,143-167,238-305`；`packages/agent/run-dir-cleanup.test.ts:132-156,295-308`；`scripts/cleanup-runs.test.ts:19-33,48-66` | `7806428`（30 天）、`b250d3f`（执行器）、`ce08070`（合并）、`05b1926`（记录） | 缺省从「永不清理」变为「超 30 天具备清理资格」；删除只由 ops 显式触发，server/ask 启动路径不接；`file_refs` 行不删，孤儿行一致性留后续 | 执行器与底账行的一致性未做；启动自动清扫未纳入本轮（integration 未接；分支 `fcd949a` 缺省关、未合入） |
| 3 | `mainConcurrency` **保持 4** | `docs/product/cap01-record.md:138`（R6 9 个真实并发会话同进程峰值 **632MB**、中位 457MB；产品模型 step-3.7-flash 账号并发上限 **8**，实测 6 会话已见 `current: 9, limit: 8`）；`packages/agent/src/resource-policy.ts:160`；`scripts/eval/cap01/r8-concurrency.ts:55-57`；4/8 档读数 `cap01-record.md:106-107` | `bcdf316`（缺省 1→4）、`2651618`（合并）、`4ba05c6`（R8 4/8 档对比） | 前台并发 4、排队 16；再提并发先解决供应商配额 | 632MB 原始 artifact 未随文档入库；本条只引用 `cap01-record.md:138` 的记录值 |
| 4 | 空回复催问条件扩到「回合以工具结果/用户消息收尾」 | `packages/agent/src/pi-driver.ts:50-56,677`；`packages/agent/pi-driver-model-errors.test.ts:41-46`；`7806428` 提交正文（R6 61 次空回复中 59 次此形状，旧条件一次未催） | `7806428` | 该形状每回合最多催一次；有正文/error/aborted 不催；正常回复不被改写 | `packages/agent/pi-driver-model-errors.test.ts:20` 头注释仍写「toolResult 终结不催」，与用例相反（历史注释漂移） |
| 5 | 部署档位 `channel.mode = offline / shadow / live`，缺省 **offline** | `packages/contracts/src/config.ts:202-213`；`apps/server/channel-mode.ts:2-12,30-37,49-58`；`apps/server/main.ts:44-68`；`packages/core/src/config.ts:229-245`；`config/agent.example.yaml:42-45`；`apps/server/channel-mode.test.ts:164-231` | `4dc42d5`、`6181985` | 缺省 `npm start` 不建 WS 连接、出站 silent；`shadow` 连但出站全抑制；`live` 保持改动前语义；档位只认 yaml，无 env 覆盖 | 真实企微未跑（`cap01-record.md` §6）；`offline` 的复核 `safetyGap` 未能复现（`cap01-record.md:171-175`） |
| 6 | `run_js` 树内软链整轮 fail-closed（含 `in/evil.txt → /etc/passwd` 实测） | `packages/agent/run-js-layout-symlink.test.ts:6,57-90`（修复前 `READ_OK:1275`）；`packages/agent/src/run-js-executor.ts:152-220`（整树扫描，深度 ≤8、条目 ≤2000）；`packages/agent/src/run-js-layout.ts:8-13,27`；`cap01-record.md:156-169` | `1d0bc3b`（布局项 lstat + 产物 realpath）、`85a3b5b`（树内扫描）、`f25dc49`（合并） | 发现任何软链即拒跑（不建 run.cjs、不 spawn、零产物）；原「out 软链跳过收集」改为更强的 fail-closed | 网络外传仍未阻断；硬链/其他逃逸面不在本条 |
| 7 | 附件交给执行层：`fileParams` 单文件参数；输入恰好一个文件，输出由宿主分配 `out/` 路径 | `packages/agent/src/task-file-bridge.ts:65-71,144-145,183-203`；`packages/agent/task-file-bridge-dummy.test.ts:48-104,106-124`；`scripts/ask-runtime.ts:269-271,554-555`；`docs/product/business-coverage.md:108` | `fab9e86`（桥 + ask 装配 + 真 dummy 端到端）；server 默认装配接线 `af01a20`（分支 `arch/fix-fileparamswire`，**未合入** `23ae585`） | ask 装配可按声明启用；默认 server 需 `contextProfiles.*.fileParams`（`af01a20` 才接）；未声明 = 零翻译 | server 接线未合入；真实执行层未验（dummy only）；目录参数仍无部署键 |
| 8 | **跨会话续办：不做**（owner 裁定） | `docs/product/business-coverage.md:111`；任务 scope `packages/agent/src/execution-runtime.ts:786`；`packages/agent/src/task-registry.ts:545,633`（principalId 与 sessionId 都必须一致）；`packages/core/src/task-store.ts:260` | `23ae585`（只改文档） | 保持 `(principalId, sessionId)` 隔离；不新增跨会话授权面；MU-3/MU-8 语义不动 | 无（明确不做；无代码改动） |
| 9 | Codex PR 复核缺陷按四轮/四批修复（PR #62） | 见 §2 逐条；PR #62 | `d2efdb1`（路径归一化）、`b58a1ce`（取消信号贯穿）、`1e98382`（预取消拒跑 + 残留路径 + eval-real 3 轮）、`7458c76`（Worker run_js 进执行事实 + 产物复用键含文件名）；`fb3bb4b`（超时进执行事实，分支待合）、`af01a20`（fileParams 接线，分支待合） | 前三批已合入 integration；第 4 批未合入：HEAD `execution-runtime.ts:1070` 仍是旧条件，`apps/server/server.ts:293-296` 的桥装配仍未传 `fileParams` | PR #62 仍 OPEN；超时假绿与默认 server 附件接线在 integration 尚未修复；修复后未复审 |

### 2. Codex PR 复核四轮（缺陷与修法明细）

PR #62（`CAP-01 收口：文件处理与交付能力 + 并发/保留期/部署档位/软链收窄`）的 Codex 复核按**四轮新发现**归档；后两轮复审重复同一超时阻断项，不另计轮次。

| 轮次 | 缺陷（复核判定） | 修法 | 提交 / 状态 |
|---|---|---|---|
| 1 | 新增文档写入开发者主目录绝对路径（blocking） | 文档中的开发者主目录绝对路径统一改为 `~`；验收聚合脚本的 TMPDIR 缺省改用 `os.tmpdir()` | `d2efdb1` 已合入 |
| 2 | `run_js` 取消信号未贯穿；预先取消的信号不会终止脚本 | main/worker 两处 `runJs` 把 Pi 回合 `AbortSignal` 传到执行器；调用前已 aborted → 直接 `killReason=abort`（不建目录、不物化、不写 run.cjs、不 spawn、零产物） | `b58a1ce`、`1e98382` 已合入 |
| 3 | Worker 的 `run_js` 未进执行事实（查询成功 + 脚本失败仍判 completed）；任务产物复用键只看 sha256（同字节不同名丢文件名） | Worker `run_js` 按退出码 `noteExecution`；复用键改为 `(scope, taskId, sha256, name)` | `7458c76` 已合入 |
| 4 | 脚本超时仍不写失败执行事实（查询成功 + 脚本超时假绿）；`fileParams` 未接入默认服务装配 | 超时 `killReason=timeout` 写 `run_js_timeout` 失败事实（`abort` 仍不写）；`contextProfiles.*.fileParams` 解析/校验并透传到 `taskExecutionBridge`，新增 `createServer` 端到端用例 | `fb3bb4b`、`af01a20` 已合入 `9d98b70`（复核员对 `fb3bb4b` 曾判「假修」，主会话用反向绊线复核：撤掉修复 → `expected 'completed' to be 'failed'` 立即红，判定为复核员误判） |
| 5 | eval-real 评论截尾（E01–E05 不可见）；eval-real 出现「通过转失败」（E08 `FAIL_STATE_INCONSISTENCY`） | 评论改由 `summary.json` 生成完整逐样本表（轨 `arch/q-evalreport`）；「通过转失败」需在当前 head 上逐例复验，不接受「模型波动」解释 | **未关闭**（`arch/q-evalreport` 未提交；当前 head 逐例复验待跑） |

### 3. 未覆盖与已知漂移

- **Codex 第 4 批已合入**：`fb3bb4b`（超时写失败执行事实）与 `af01a20`（`fileParams` 接线）均在 `9d98b70`。
- **Codex 第 5 轮未关闭**：① `eval-real` 评论仍截尾（E01–E05 不可见）——修复轨 `arch/q-evalreport` 未提交；② `eval-real` 出现「通过转失败」（run `44040983108` 绑 `c33b927`，E08 trial-3 `FAIL_STATE_INCONSISTENCY`，同用例前一 run 为 PASS），需在当前 head 的逐例复验里核对，不能以「模型波动」结案。
- **启动自动清扫已合入（缺省关）**：`fcd949a`（`runtime.fileRetentionSweepOnStart`）在 `9d98b70` 内，缺省 `false` = 零行为变化。
- **历史条目/注释漂移（只登记，不改历史条目）**：
  - `docs/product/cap01-record.md:90` 仍写「新口径 3/5」，与同节 `:86-88` 及 §9 `:105` 的 2/5 不一致；按 2/5 裁定，该句是早期读数残留。
  - `docs/product/cap01-record.md:137` 的「判定层仍无执行器」是 §11 当时状态；§12 的 `b250d3f` 已补显式执行器。
  - `packages/contracts/src/config.ts:145` 仍写「文件保留期 0 = 不清理」、`:166-167` 仍写「实际删除执行器不在当前切片」；与缺省 30 天 + 执行器已落地不一致。
  - `packages/core/src/config.ts:186` 仍写「0 = 不清理（缺省…）」；缺省值实际由 `packages/agent/src/resource-policy.ts:170` 提供为 30。
  - `config/agent.example.yaml:62,75` 仍写「文件保留期 0(不清理)」「>0 仅提供判定」；示例未随 30 天缺省与执行器更新。
  - `packages/agent/pi-driver-model-errors.test.ts:20` 头注释仍写「toolResult 终结不催」，与 `:41-46` 的用例相反。
- **真实环境未验**：真实企业微信、真实执行层（`operation list`/限流/retry-after/结果映射）仍未跑（`docs/product/cap01-record.md` §6）；`fileParams` 的 server 接线即使合入，也只在仓内 dummy 上验过。

### 4. 指针

**指针**：`docs/product/cap01-record.md` §8（S3 口径）、§9（收口读数）、§10（R6 重跑）、§11（owner 裁定）、§12/§12.1（上线前补漏）；`docs/product/business-coverage.md` §八（盲区）；`packages/agent/src/resource-policy.ts`（保留期/并发缺省）、`packages/agent/src/run-dir-cleanup.ts` 与 `scripts/cleanup-runs.ts`（清理执行器）、`packages/agent/src/pi-driver.ts`（催问）、`apps/server/channel-mode.ts`（档位）、`packages/agent/src/run-js-executor.ts`/`run-js-layout.ts`（软链）、`packages/agent/src/task-file-bridge.ts`（fileParams）、`packages/agent/src/execution-runtime.ts`/`task-registry.ts`（任务 scope）；提交 `844fb3c`、`267cfd0`、`7806428`、`b250d3f`、`ce08070`、`bcdf316`、`4ba05c6`、`4dc42d5`、`6181985`、`1d0bc3b`、`85a3b5b`、`f25dc49`、`fab9e86`、`23ae585`、`d2efdb1`、`b58a1ce`、`1e98382`、`7458c76`；待合 `fb3bb4b`、`af01a20`。

**状态：CAP-01 主面与两批补漏、Codex 第 1–4 轮修复均已合入 integration @ `9d98b70`；Codex 第 5 轮（eval-real 完整逐样本表 + E08 通过转失败复验）未关闭，PR #62 仍 OPEN。**

## 一百、recalc_xlsx 集成 · 决定登记与准入证据指针（2026-11-17，分支 `arch/recalc-xlsx`，基线 = `arch/integration` @ `5428723`）状态：**已实现·待最终独立复核**（与本节末状态行一致）

> 授权与边界：owner 2026-11-17 认可方案 v2 + R1–R7 裁定，指定「编排 workflow，拉 worktree，丢给 deepseek-v4.1-flash@high 执行」。本节只做决定登记与准入证据指针，不代表实现已通过；产品改动限定在钉死产出（`docs/decision-log.md`、`packages/agent/src/recalc-xlsx-executor.ts`、`packages/agent/recalc-xlsx.test.ts`、`packages/agent/recalc-delivery-gate.test.ts`、`.agents/skills/table-verification/SKILL.md`）。不 push、不合并、不动 main/tag。

- **owner 边界裁定 R1–R7（不得重新讨论）**：① LibreOffice 仅部署时安装，用户机器零依赖；② 表格公式/模型工程归 Main 文档工程面；③ 执行层交付无公式表格（数据非活模型）；④ 带公式产物由 Main 侧验收（数据级 oracle / 公式级 LO 两档）；⑤ 不为 Excel 派生执行层；⑥ `recalc_xlsx` 是宿主 agent 工具（Option 1，与 `run_js` 并列）；⑦ skill 只验不建/改，CSV 纯数据导出是工具契约显式部分。

- **Q1–Q4 收口（按推荐）**：① LibreOffice 固定 **26.8.3**，仅部署时安装、PATH 可见才上工具面，缺失即 **fail-closed 不上工具**；② Worker 面不上 `recalc_xlsx`（仅 Main 宿主面）；③ LO 开销进 **R4 资源账**（结构化事件）；④ 实施顺序（owner 认可的**计划顺序**）**④ decision-log → ② recalc_xlsx 工具（TDD）→ ① table-verification skill → ③ 投递门**；**实际提交顺序为 ④（`ba0bf8d`）→ ②（`70d03ff`）→ ③（`88a41d0`）→ ①（`9988ddc`）**，① 与 ③ 实操对调（内容齐全、功能无碍；独立复核登记，不重写 owner 计划）。确定性门在 commit 后由脚本跑；全量 `npm test` 本机有 vitest-worker 超时抖动，失败如实上报不掩盖。

- **四项产出与顺序**：计划顺序 ④ `docs/decision-log.md`（§一百，本节）→ ② `packages/agent/src/recalc-xlsx-executor.ts` + `packages/agent/recalc-xlsx.test.ts`（TDD）→ ① `.agents/skills/table-verification/SKILL.md`（只验不建/改）→ ③ `packages/agent/recalc-delivery-gate.test.ts`（投递门）；**实际提交顺序 ④→②→③→①**（见上条事实注记）。新增 skill 若需更新测试金样，单独在 deviations 说明。

- **新增机制准入五条 · 逐项证据指针**（按 AGENTS.md「新增机制准入」）：
  1. **最小可复现失败**：汇总表共享公式与静态值混排时，读回走缓存导致值陈旧——`recalc_xlsx` 必须强制重新计算后读回，否则交付陈旧值。该失败场景在 `packages/agent/recalc-xlsx.test.ts` 以最小用例钉住（实现步 ② 产出）。
  2. **Pi 原生 / Skill 方案尝试结果**：仓内已有 dummy 执行层 + `exceljs` 数据级断言（`scripts/eval/cap01/r2b-formats.ts` 的 `cellText/gridOfXlsx/compareGrids` 数据级 oracle、`packages/agent/run-js-executor.test.ts` 经 `run_js` 数据级比对）已覆盖「无公式数据」；**缺的是公式级读回门**——Pi 原生 `run_js` 无法强制 LO 重算读回，故以宿主工具补齐，不另建框架。（指针用符号名，不写易漂移的行号。）
  3. **为什么执行层不能承担**：公式/模型工程归 Main 文档工程面（裁定 ②），执行层只交无公式数据（裁定 ③）；`recalc_xlsx` 重算是 Main 侧文档工程责任，执行层不承担，故不上 Worker 面（Q1②）。
  4. **最小改动方案**：复用 `run_js` 装配与 `fileStore` 纪律（`packages/agent/src/run-js-executor.ts`、`packages/agent/src/file-store.ts`、`packages/agent/src/execution-runtime.ts`），作为与 `run_js` 并列的宿主 agent 工具（裁定 ⑥），不新增第二套协议/框架。
  5. **Eval（增加前后）· 已补（2026-11-17 独立复核后）**：`scripts/eval/recalc/formula-level.ts`（+ `.test.ts`）给出两档可复现读数——**增加前（数据级臂）**：只读缓存值、拿缓存与缓存比，投毒缓存 999 被当真值 → `pass/delivered=true`（陈旧不可见）；**增加后（公式级臂，真 soffice 26.8.3）**：强制重算读回 → 缓存 999 ≠ 计算值 5 → `valueDiffs` 命中、`fail/delivered=false`（投递闸拦下）。跑法 `node --import tsx scripts/eval/recalc/formula-level.ts`，证据 `.runtime/eval-recalc/<时间>/readings.json`（gitignored）。实测读数：`before cached=999 verdict=pass delivered=true`；`after engine=soffice 26.8.3 cached=999 computed=5 verdict=fail delivered=false`；`pass=true`。

- **LO 版本与资源账 · 已实现（2026-11-17 独立复核补）**：LibreOffice 固定 **26.8.3**，部署期安装、PATH 可见才注册工具，缺失 fail-closed。LO 重算开销计入 R4 资源账：每次 `recalc_xlsx` 调用后把引擎耗时（`RecalcXlsxResult.durationMs`，缺省执行器必填）经 `foregroundPermit.budget.consume({calls:1, ms:engineMs})` 入前台预算，并经 `onRecalcCost` 结构化事件（`recalc_cost`：engineMs/status/principalId/sessionId，只进日志不进话术）上报——接线在 `execution-runtime.ts` 的 recalc exec 分发处、`scripts/ask-runtime.ts` 透传、`apps/server/server.ts` 日志钩；无 policy 时零预算对象也不报错。非 `onRuntimeEvent`（那是 Pi 回合窗口信号，不是资源账）：本切片用专用 cost 事件，明确、可查、不静默消耗预算。
- **版本校验口径（Gap7 备查）**：可用性判定用 `version.startsWith('26.8.3')`（`RECALC_XLSX_REQUIRED_VERSION`），真实 `26.8.3.1` 属有意纳入；副作用是 `26.8.30`/`26.8.3rc` 也会通过前缀匹配。当前部署版本锁定 26.8.3.x，记录备查、不在本轮改判据（不扩范围）。

- **③ 投递前机械闸 · 挂点补记（2026-11-17 实施裁定，时序决定不算扩范围）**：recalc 实算报告写在**独立 runDir**（`<sessionDir>/runs/<recalcRunId>/out/.recalc-report.json`），且 `recalc_xlsx` 与 `run_js` 先后调用、各自 runDir——`run-js-executor.ts:416-423` 扫 out/ 处看不到后产出的报告。故**最终判定放在 `apps/server/server.ts` 的 `deliverTurnFiles` 读字节处**（闸门逻辑在 `packages/agent/src/recalc-xlsx-executor.ts`：`xlsxHasFormulas`/`collectRecalcReports`/`decideRecalcDelivery`/`applyRecalcDeliveryGate`），run-js 侧不做标注（本切片无需）。判定：待投递项含公式 xlsx 必须有按**文件名 + sha256 绑定**的 `status=pass` 报告；缺失/fail/不匹配一律不投递，出 `recalc_delivery_gated` 结构化事件（带 items: name/sha256/reason）；无公式表格与纯数据 CSV 逐字节放行。**混合批次（部分被拦、部分照投，Gap5 补）**：全拦时给 `recalc_gated` + 未投递话术；部分拦时照投通过项但必须附「部分表格未通过公式实算校验、未予发送；其余已发送」话术（`RECALC_DELIVERY_PARTIAL_NOTE`），不让用户误以为全部送达——如实交付 B 类责任。**缺省行为**：部署有 26.8.3 时 server 自动构造执行器 → 闸门默认启用；「缺省未注入不改变交付行为」由显式 `createRecalcXlsxExecutor: () => undefined` 关闭路径保证（既有交付测试即走此路径，逐字节不变）。**不把 exceljs 引入 file-store.ts**（`packages/agent/import-boundary.test.ts` 的 file-store/exceljs 静态断言钉住——独立复核 gap1 补：原守卫缺失，现以 import 边 + 静态文本双断言钉死）。

**指针**：本节；`packages/agent/src/recalc-xlsx-executor.ts`（② 工具 + ③ 闸逻辑 + Gap1 耗时）、`packages/agent/recalc-xlsx.test.ts`（② 23 用例）、`packages/agent/recalc-delivery-gate.test.ts`（③ 17 用例，含独立复核 gap4 正向链路）、`scripts/eval/recalc/formula-level.ts`（准入⑤ Eval，前后读数）、`apps/server/server.ts`（②③ 接线 + Gap5 混合批次话术 + recalc_cost 日志）、`scripts/ask-runtime.ts`（② 注入透传 + Gap1 事件透传）；`.agents/skills/table-verification/SKILL.md`（① 已产出）。**资源账事件指针用符号名**（行号会漂移）：`execution-runtime.ts` 的 `recalc exec` 分发处（`onRecalcCost?.(...)` 与 `foregroundPermit?.budget.consume(...)`）、`onRecalcCost` 端口、`RecalcCostEvent` 类型——非早期自报的 `:226/:437/:633`（那些是错误指针，已废弃）。
**独立复核 7 项 gaps 修复（2026-11-17）**：① LO 开销入 R4 账（`durationMs`+`recalc_cost` 事件+预算 consume）；② 状态陈旧（本节指针更新为①已产出）；③ 证据指针错误（改符号名引用）；④ 公式级 Eval 前后读数补齐；⑤ 混合批次部分未投递用户话术+测试；⑥ 反向绊线由复核独立执行（见交付 evidence）；⑦ 版本前缀校验记录备查（不改判据）。状态：**①②③④ 已实现·7 项 gaps 已修复·待最终独立复核**。

**独立复核第二轮 6 项 gaps 修复（2026-11-17）**：
- **gap1（实质·守卫缺失）**：原声明「不把 exceljs 引入 file-store.ts（import-boundary 守卫钉住）」不成立——`import-boundary.test.ts` 原文仅 1 个 it，无任何 file-store/exceljs 断言。已补独立静态断言（import 边 `importsOf(file-store.ts)` 无 `exceljs` + 静态文本 `/exceljs/i` 双保险），并同步本条与 `recalc-delivery-gate.test.ts` 头注释的措辞指向真实守卫位置。绊线实测：临时往 `file-store.ts` 塞 `import ExcelJS from 'exceljs'` → 该断言红（1 failed|1 passed），复原后 2 passed。不变式本就成立（靠无人加），此补是把它钉成回归防线，非改判据。
- **gap2（记录与历史不一致）**：owner 认可的 ④②①③ 是**计划顺序**（不重写、不重新讨论），在本节 Q1④ 与「四项产出」两处显式标为计划顺序，并追加实际提交顺序事实注记 ④（`ba0bf8d`）→②（`70d03ff`）→③（`88a41d0`）→①（`9988ddc`），①与③实操对调、内容齐全功能无碍。
- **gap3（状态行陈旧）**：标题状态由「实现中·待独立复核」统一为「已实现·待最终独立复核」，与本节末状态行一致。
- **gap4（server 正向链路缺覆盖）**：`recalc-delivery-gate.test.ts` 补 server 级正向集成用例——预置与投递字节 name+sha256 双匹配的 pass 报告（`sessionDir/runs/<recalcRunId>/out/.recalc-report.json`），验含公式 xlsx 经 `server.handler` 真实投递、逐字节一致、零 gated 事件。该用例锁住「报告绑定 recalc 输入字节、投递 run_js 注册产物须同一文件才匹配」的端到端假设。绊线实测：报告 sha 改错 → 该用例红（1 failed|16 passed），复原 17 passed。
- **gap5（版本前缀宽松·已披露）**：维持原裁定不改判据（`startsWith('26.8.3')` 有意纳入 26.8.3.1，副作用放进 26.8.30/26.8.3rc），复核无异议。
- **gap6（历史红态不可独立复现）**：复核员只读、不得改文件，故实施员自报的「现场反向绊线红态」无法从当前树/git 独立复现，标 unconfirmed 属预期（破坏态不入库）。本轮已把 gap1/gap4 两条新断言各自做了「注入破坏→转红→复原绿」的现场可复核绊线；源码内既有绊线式断言（Worker 面无 recalc、描述无流程话术、enabled=false 逐字节不变、report mismatch fail-closed）保持。
状态：**6 项 gaps 全部处理（gap1/2/3/4 实修 + 绑定的现场绊线，gap5 登记无异议不改判据，gap6 登记为只读不可复现的预期限制）·待最终独立复核**。

**Codex 对 PR #63 独立复审 6 finding 及修复（2026-11-17，owner 已确认 6 条成立）**：逐条 TDD（按 Codex 复现写红→最小实现转绿→反向绊线红→复原）；既有测试未删、断言未弱。
- **P1-1（B 类·伪造报告绕过投递门）**：原报告写 `<runDir>/out/.recalc-report.json`，而 run_js 子进程对 `out/` 有写权限（run-js-executor.ts 的 `--allow-fs-write=<runDir>/out`），模型可在 out/ 伪造 `name/sha256/status:pass` 报告放行未重算的陈旧缓存。正解（最小可信边界，不依赖提示词）：报告改宿主独占的 **`<runDir>/.recalc-report.json`（runDir 根，run_js 无写权限）**；`collectRecalcReports(workspaceRoot, scope)` 只读该根位置，`out/` 同名文件一律不认。绊线：collector 读回 out/ → 伪造报告用例红（1 failed|16 passed）。**注：上文第二轮 gap4 记录中的 `out/.recalc-report.json` 路径已被本条改到 runDir 根，旧文字按维护规则不改、以此条为准。**
- **P1-2（sheet 局部验证放行整本）**：原 `selectedSheets` 按 `input.sheet` 过滤，选一个干净 sheet 即授权整本 pass、不存在的 sheet 空检查直接 pass。正解：验证/比对恒遍历**全本**（status/report 的 errorCells/valueDiffs 覆盖所有 sheet，report 保留全量），`sheet` 只收窄 **CSV 展示**与**返回 valueDiffs 呈现**（均按 sheet 过滤），不缩验证范围。绊线：验证范围改回选中 sheet → 别本陈旧用例红（1 failed|25 passed）。
- **P1-3（共享公式从属格漏比对）**：ExcelJS 共享公式从属格读回是 `{sharedFormula:'<master>', result}`（无 `formula` 属性），原 `isFormula` 只认 `formula`，anchor 正确但 follower 999→2 仍 pass。正解：`formula` 与 `sharedFormula` 两种表示都算公式格。绊线：去掉 sharedFormula 分支 → follower 陈旧用例红（1 failed|23 passed）。
  - **门控侧残留绕过补修（独立复验发现，2026-11-17）**：首轮 P1-3 只补了执行器比对点（executor `:339`），投递门公式识别 `xlsxHasFormulas`（`:580`）仍只判 `'formula' in v`——用 ExcelJS 真产共享公式工作簿并剥离 master 的 `<f>` 文本（保留 `t=shared ref si`），读回 A2={result:5,ref,shareType:'shared'}（无 formula）、A3={result:999,sharedFormula:'A2'}，`xlsxHasFormulas(stripped)=false` → `no_formulas` → 无报告即放行，投毒缓存 999 原样投递。正解：`:580` 同改 `'formula' in v || 'sharedFormula' in v`，与执行器同一正解根除同一 bug 类。复验员原始复现脚本 `npx tsx /tmp/recalc-independent-repro/probe-shared-bypass2.ts` 修复后读数：`stripped.xlsx → hasFormulas=true, deliver(no reports)=false, reason=report_missing`（修复前为 false/true/no_formulas）。红测（JSZip 剥离 master `<f>` 文本的自包含用例）→ 绿 → 绊线（改回只认 formula）红（1 failed|17 passed）。**P1-3 执行器侧与投递门侧两处均已关闭。**
- **P2-4（CSV 产物未进交付链）**：原 CSV 留执行器私有 runDir/out/，未登记 fileStore、未进 turnFiles，server 投不出。正解：执行器 export=csv 时用 `fileStore.putFile` 登记 CSV（产出即交付箱）并随 `RecalcXlsxResult.outputs` 交回；execution-runtime 的 recalc_xlsx handler 把 outputs push 进 turnFiles（与 run_js 同纪律，不改 Worker 面）。绊线 A：handler 不收口 outputs → turnFiles 用例红；绊线 B：执行器不登记 → outputs 用例红（各 1 failed）。
- **P2-5（容差遮分级差异）**：原相对容差 `1e-9` 在 1 亿量级容 ~0.1 元，100000000 vs 100000000.05 误判 pass。正解：容差 = `min(半分 0.005, 浮点尾数噪声 1e-9×量级)`——浮点噪声只吸收 ULP 级尾差，绝对上限锁死半分（金额精确到分）。绊线：去掉半分封顶 → 分级差异用例红（1 failed|24 passed）；原浮点噪声用例仍绿。
- **P2-6（eval 没量闸门决策）**：原 before `delivered=true` 硬编码、after 取 executor.status，闸门改 allow-all 仍绿。正解：before 走 **disabled 闸**（enabled=false = 机制前 allow-all）、after 走 **enabled 闸**（enabled=true + collect 报告），两臂 delivered/reason 均从 `applyRecalcDeliveryGate` 结果取；evidenceDir 的 `readings.json` 留 delivered/reason。allow-all 绊线：after 闸改 enabled=false → 真引擎 eval `pass=false`、after delivered=true、测试 2 failed。真引擎读数：`before delivered=true` / `after engine=soffice 26.8.3 cached=999 computed=5 verdict=fail delivered=false reason=report_fail`。
状态：**Codex 6 finding 全部按最小可信边界/口径实修并各自通过红→绿→绊线；受影响测试集 5 文件 57 例全绿；待最终独立复核**。

 **投递闸判定基础纠偏 + 四轮独立复审（2026-11-18，owner 裁定「按最初职责边界」）**：
 - **判定基础反转（根因收敛）**：原投递门试图「扫描任意 xlsx 内容猜它含不含公式」，exceljs 的 CellValue 形态空间开放（shared/array/falsy/前导字节…），连审八轮每轮补一种形态=打地鼠。owner 纠偏回最初裁定——执行层交付无公式数据、公式工程只归 Main 的 `recalc_xlsx`。正解：投递门**完全报告驱动、不解析任何 xlsx 内容**：有 name+sha256 双匹配的实算报告按 pass/fail 判定，**无报告放行**（执行层数据的边界内信任）；builder 自检（认不出公式形态就拒盖章）归执行器内部 `scanWorkbookFormulas`。按内容扫描的函数与过时用例删除（本步净删约 190 行）。此后四轮独立复审再无「特殊 xlsx 形态绕过」类发现——打地鼠已停。
 - **报告生命周期收敛（Codex R9/R10）**：重算失败（timeout/engine_failed/too_large/sheet 不存/corrupt/unsupported_formula）也落 fail 报告，门才能拦住已排队文件；同 sha 多份报告按 `createdAt` 取最新，防旧 pass 覆盖新 fail；金额容差加「分位取整须相等」，防 1e8 量级 0.004 vs 0.006 吞掉一分差。
 - **资源安全（Codex R11 + 四轮 subagent）**：recalc 调用前预检 `taskBudget.exhausted()`，防同回合无限重算绕过预算；解压上限从「信任 CD 声明尺寸」（R6 声明尺寸/R11 前导字节/R12 CD 伪造，同族第 3 例不收敛）改为**结构性修法**——JSZip `loadAsync` + `entry.nodeStream` 实际流式解压计数，累计 >128MB 立即 destroy 中断，不依赖任何可伪造元数据（jszip 3.10.2 转正式依赖）。四轮复审实测：400MB bomb、CD 声明伪造 512、堆上限 160MB 下 451ms 被拒、峰值堆 21.8MB。
 - **身份绑定（R13）**：投递门从 name+sha 双绑定改为**只按 sha256**——name 是可变展示字段（run_js 拷贝/改名会变），双绑定让已知 fail 报告被改文件名绕过；eval 补第三臂 `after_renamed_still_blocked`（真 soffice 三臂 pass=true）。
 - **四轮独立复审（仿 `.github/prompts/pr-review.md`，全新上下文逐轮带 prior findings）**：第 1–3 轮挖出并复现上述 blocking/major/minor，第 4 轮确认全部修复成立。终态 HEAD `f718cfd`：typecheck=0、全量 1712 例绿、流式解压/改名/eval 三臂正反向绊线齐全、真实 soffice 26.8.3 eval pass=true。
 - **已登记残余（owner 裁定不再修，避免把内容扫描请回来）**：报告绑定 recalc **输入字节的精确 sha**；待投递文件若在宿主内被「无害重编码」（exceljs load→write、LO 读写、改压缩级别/时间戳，单元格缓存值不变但 zip 字节 sha 变），sha 失配 → `no_report` 放行。四轮复审第 4 轮复现（src sha `3b195710…` → 重编码 `784d26c6…`，缓存 999 保留，同份 fail 报告判定 `deliver:true`）。该残余属「报告绑定键与投递对象可脱钩」族（与改名绕过同族，输入空间无限）；任何修法（内容指纹/逻辑内容哈希）都会把已删除的「解析任意 xlsx 内容」重新引入宿主、重开打地鼠，与 owner 职责边界裁定冲突。按边界接受：重编码后的字节视为执行层新产物、无报告放行，如实登记为已知限制。若未来要收口，须由 owner 新裁定「身份随文件而非字节」（报告绑宿主 fileId），不在本切片自主推进。
 - 状态：**实现与四轮独立复审完成；带一条已登记残余；未合入/未推送（由 owner 决定）**。

---

## 维护规则

- 新增删除/保留决定：追加条目，不改旧条目；编号延续（二、三节内）。
- PR 合并后：把对应条目的状态从 `在 PR` 改为 `已合入`，补 merge commit 与日期；**不得**因为「PR 已合」就删除条目。
- 已删机制重新加回：先在本日志新增一条「加回决定」，写清触发的是哪条「加回来的判据」、采用了什么形态；没有这一条，不得直接加代码。
- 未决转已决：保留原未决文字，追加「结论」与日期，避免读者以为它从未未决。
