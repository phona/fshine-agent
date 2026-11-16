# Pi 1.5.2 迁移 · 阶段 E 代码最小性审计

- 对象：worktree `~/projects/fshine-agent-pi-upgrade`，分支 `arch/pi-upgrade`，HEAD `b8478c0`；基线 `badbf32`（只读审计，未改产品码、未提交）。
- 范围：`git -C ~/projects/fshine-agent-pi-upgrade diff badbf32..HEAD`（4 个提交：`9464065` 阶段 A、`0b363ed`/`9cf5919`/`b8478c0` 阶段 D 夹具与文档）。
- 性质：代码最小性审计，不是行为评测；不烧真实模型。

## 0. 本审计实际跑过的检查

| # | 命令（原样） | 结果 |
|---|---|---|
| 1 | `git -C ~/projects/fshine-agent-pi-upgrade diff badbf32..HEAD --stat` | 43 files, +4261 −1861 |
| 2 | `git diff --numstat badbf32..HEAD` / `--shortstat` | 逐文件读数见 §8；总计 +4261 −1861（净 +2400） |
| 3 | `export TMPDIR=/home/tao/.tmp && npx vitest run scripts/eval/pi152-stageC/stage-c.test.ts` | **15 tests passed**（阶段 C 判据读数见 §6） |
| 4 | `export TMPDIR=/home/tao/.tmp && npm run typecheck` | **33 errors，全部在未跟踪的 `scripts/eval/pi152-stageB/*`（16）与 `pi152-stageC/stage-c.test.ts`（17）**；已跟踪文件（含全部产品码与 HEAD 内容）0 错误 |
| 5 | `grep -rn "shouldCompact\|generateSummary\|serializeConversation\|estimateContextTokens\|isRetryableAssistantError\|trimToBudget\|degradeByDropping\|compactTranscriptWithPi\|CONTEXT_OVERFLOW" packages apps scripts` | 产品码 0 命中（仅 `pi-driver.ts:79` 注释提到 Pi 的 `shouldCompact`、`tripwire` 测试的反向名单、eval 的 `token-estimate.ts`） |
| 6 | `grep -rn "@earendil-works" packages/agent/src/*.ts` | 只有 `pi-driver.ts`（运行时）与 `driver-contract.ts`（仅 type） |
| 7 | `git diff --stat badbf32..HEAD -- packages/contracts packages/agent/src/task-registry*.ts packages/agent/src/task-runner.ts` | 空（执行契约与任务底账零改动） |
| 8 | `git merge-base arch/pi-upgrade arch/integration` = `84a22fa` | 0.85.1 路线对照基准（§9） |

> 说明：worktree 中 `scripts/eval/pi152-stageB/`、`pi152-stageC/`、`pi-runtime-experiment/` 为**未跟踪**文件（`git status --porcelain` 三项 `??`），因此不入 §8 的 badbf32..HEAD 统计；它们使当前 worktree 的 `npm run typecheck` 失败，但 HEAD 已跟踪树本身干净。

---

## 1. ① `pi-driver.ts` 现在还能删什么

### 1.1 已随阶段 A 删除（证据：`git diff badbf32..HEAD -- packages/agent/src/pi-driver.ts`，−365 行）

| 已删对象 | 基线行区间（badbf32） | 理由 |
|---|---|---|
| `AgentHarness` / lane / `projectTranscript(lane)` / `lastProjected` / `isPrefixExtension` / `plannerMessagesToLlm` | `218-233`、`558-582`、`107-125` | 1.5.2 中 `AgentHarness` 已不在 `pi-agent-core` 公开面；宿主自建「前缀对账 + 第二份转录」由 `AgentSession` 独占转录取代 |
| 每回合全量回灌 `toAppend` / `lane.appendMessage` / `lane.prompt` | `432-460` | 同上；改为 `session.prompt` 只交本轮输入 |
| `envScopedAuthContext` + `createProvider/createModels` 自建模型注册 | `184-258` | 改为公开 `ModelRuntime.create + registerProvider` |

### 1.2 HEAD 中仍然残留、现在可删（严格死代码，约 40–45 行产品码）

| 位置（HEAD） | 内容 | 依据 | 可删行数 |
|---|---|---|---|
| `pi-driver.ts:351`、`481`、`566`、`643` | `Conversation.lastProjection` 字段及其三次写入 | `grep -rn lastProjection packages apps scripts` 只有这 4 处，**无任何读取点**；当前转录由 `transcript()` 读 `resolvedConversation.session` / `lastTurnProjection` | 4 |
| `pi-driver.ts:113-122` | `KIMI_THINKING_LEVEL_MAP` | 产品码无引用；唯一引用是 `pi-driver.test.ts:6-13` 自己的断言（测试为死导出续命）。1.5.2 的 `ModelRuntime.registerProvider` 已不再接收 `thinkingLevelMap` | 10（+测试 8） |
| `pi-driver.ts:273-284` + `447` | 手写 `PiAgentTool` 接口 + `toolDefinitions as ToolDefinition[]` 强转 | 根导出已有 `defineTool`（`dist/core/extensions/types.d.ts:554`，公开身份函数）。用手写接口 + `as` 绕开了编译期形状校验，等于把接缝风险留给运行期 | 12 |
| `pi-driver.ts:729-742`（其中 `734-740`） | `toSessionMessage` 的 `role==='custom'` 分支 | 生产种子来自 `projectSession()`（已把 custom 渲染成 user）或 `lastMainProjection`，`TurnDriverInput.messages` 里不会再出现 custom | 4-6 |
| `pi-driver.ts:179-185`、`387`、`407`、`414-424` | `sessionDir` / `resumeSessionFile` 选项与 resume/create 分支 | `grep -rn "sessionDir\|resumeSessionFile"`：产品装配（`ask-runtime.ts`、`server.ts`）**从不传**，只有阶段 C/D 夹具用。按 Minimal 纪律，未接线的未来 API 不应留在产品驱动 | ~12 |
| `pi-driver.ts:670-678` + `driver-contract.ts:55-62` | `sessionInfo()` + `PiSessionInspection` | 产品码 0 消费者；只有 `pi-agent-session.test.ts` 与 eval 用。属「测试/评测专用审计面」，要么搬进测试夹具，要么明确标为测试接缝 | 9 + 8 |
| `pi-driver.ts:680-687` + `driver-contract.ts:71-72` | `close()` | 产品码 0 调用者（`grep "driver.close\|\.close?.()"` 只命中测试与 eval）；`ask-runtime.ts:566-568`、`server.ts:274-278` 的 close 只关通知与底账。实例级 Main 会话的释放路径没接线 | 8 + 2 |

**建议总删除量**：产品码约 60–70 行（含 `sessionDir/resumeSessionFile/close/sessionInfo` 则 ~90 行），测试 8 行。删 `lastProjection`、`KIMI_THINKING_LEVEL_MAP`、`PiAgentTool` 三项是零风险纯清理；`sessionDir/resumeSessionFile/close/sessionInfo` 属「先接线再做阶段 C，否则删」的裁决项，不能长期悬空。

> 另一处与实现成本无关、但应与删除同批处理：`pi-driver.ts:397-398` 的缺省工作目录是 `fshine-pi-<pid>`（**进程级**，Main/Worker/多会话共用），而设计文档 `pi-152-adapter-design.md:104` 写的是「按会话隔离」。二者不一致，且共用 cwd 会让 Pi 的 `<cwd>` 段与配置文件发现面在会话间共享。

### 1.3 不建议删（有真实职责）

- `shouldNudgeFinalReply` / `FINAL_REPLY_NUDGE`（`48-55`、`626-641`）：A 类模型行为补丁，**基线已存在**（badbf32 同行），不是本次新增；删除需用户级 Eval 消融，本轮不动。
- `toAgentTool` 的 `progress` 参数（`295-307`）：F6 进度帧的既有接缝，保持。
- `synthesizeAssistant` / `toPiMessage`（`689-691`、`771-791`）：服务端确定性回复要带完整 assistant 内部形状，eval/服务端仍在消费；保留。

---

## 2. ② 是否还有 fshine 管理的压缩 / 历史裁剪 / 重试

### 2.1 无：压缩执行、历史裁剪、模型重试

- 反向绊线 `packages/agent/pi-native-tripwire.test.ts:30-46` 直接扫 `src/pi-driver.ts` 源码，禁止 16 个符号回潮：`compactTranscriptWithPi`、`compactionSettingsFor`、`splitForCompaction`、`summarizeWithinWindow`、`trimToBudget`、`degradeByDropping`、`invariantReserveTokens`、`invariantLimitTokens`、`fixedRequestOverheadTokens`、`CONTEXT_WINDOW_FLOOR_TOKENS`、`MIN_OUTPUT_BUDGET_TOKENS`、`CONTEXT_REQUEST_FRAMING_TOKENS`、`isContextOverflowError`、`pi_driver_pre_request_compacted`、`pi_driver_context_overflow_recovered`、`context_emergency_compact`。
- 产品码 grep（检查 5）0 命中；宿主无「请求前压缩门 / 上下文预算门 / 压缩重试器 / 摘要裁决器 / 历史裁剪」。
- 重试：`MAIN_MODEL_RETRY_SETTINGS`（`pi-driver.ts:38`）只是 Pi `SettingsManager.inMemory({retry})` 的**入参**（`409-412`），执行归 Pi；`auto_retry_start` 仅计数+日志（`453-464`）。基线已有（badbf32 为 `MAIN_MODEL_RETRY_POLICY`，`git diff` 可见只改类型名）。
- 历史：`pi-driver.ts:507` 的 `slice(0, -1)` 只是「最后一条 user = 本轮输入」的切分，不是裁剪。

### 2.2 有：fshine 仍在决定压缩阈值（点名）

| 位置 | 事实 | 定性 |
|---|---|---|
| `pi-driver.ts:97-111` `piCompactionSettings` | 小窗口时用 `contextWindow*0.25` / `*0.3` 计算 `reserveTokens`/`keepRecentTokens`，再作为绝对 `CompactionSettings` 传给 Pi（`410`） | **不是压缩执行，但是阈值决策**：0.25/0.3 是 fshine 自造系数，不在 Pi 公开面。128k 生产窗口下恰好等于 Pi 默认（16384/20000），行为等价；小窗口（阶段 D：24576/32768）完全由这组系数决定 |
| `scripts/ask-runtime.ts:160-170` `compactionSettingsFrom` | 读 `LLM_COMPACTION_RESERVE_TOKENS` / `LLM_COMPACTION_KEEP_RECENT_TOKENS` 注入绝对阈值 | 纯透传；但它是「宿主可设压缩阈值」的开关。`packages/core/src/config.ts:464` 目前只写 `LLM_CONTEXT_WINDOW`，**生产不会自动写这两个变量**（已 grep 确认） |
| `scripts/eval/pi152-stageD/harness.ts:561,574` | 阶段 D 的 Main/Worker 都用 `piCompactionSettings(settings.contextWindow)` | 阶段 D 「Pi 原生压缩」结论的阈值输入来自 fshine 系数，不是 Pi 默认——报告里必须这样读 |
| `scripts/eval/pi-native/safe-config.ts:96-118` | `summaryBudgetTokens = min(floor(0.8×reserve), maxTokens)`、压缩后请求不等式、`SUMMARY_FLOOR_TOKENS` | **兼容治理残留**：该公式来自 0.85.1 `compaction.js:380`；1.5.2 的 `createSummarizationOptions` 已不传 `maxTokens`（设计文档 §6 自认）。文件头却仍宣称「纯配置推导，无任何压缩治理逻辑」 |
| `scripts/eval/pi-native/safe-config.test.ts:53,69,81` | 仍硬断言 `summaryBudget = 6553 / 3276 / 2048` | 测试在强制一个 1.5.2 已不存在的压缩预算不变式——**这就是「为实现成本保留旧治理」的实例，应删或改断言为「1.5.2 无摘要预算」**（设计文档 §7 说已改，实际只改了公式守卫读新路径，预算断言仍在） |

**结论**：压缩的触发/摘要/尾段/溢出恢复、历史裁剪、模型重试**没有** fshine 逻辑；**但压缩阈值参数仍由 fshine 计算/注入**，且 `safe-config` 仍保留 0.85.1 的摘要预算治理。前者是 Pi 绝对配置契约的必要适配（可以保留，但要作为显式配置记录、不能藏在缺省公式里），后者应在合并前清理。

---

## 3. ③ 新增适配层是否只承担系统集成责任

`pi-driver.ts`（857 行）逐段归类：

| 段（HEAD 行） | 职责 | 是否系统集成 |
|---|---|---|
| `17-35` imports | 只 root 公开导出（`createAgentSession`/`createExtensionRuntime`/`DEFAULT_COMPACTION_SETTINGS`/`ModelRuntime`/`SessionManager`/`SettingsManager` + 类型） | ✓ 不 deep-import、不改 Pi 源码 |
| `199-242` `createPiModelRuntime` | provider 注册、env 凭据、隔离 authPath、能力声明 | ✓ 集成（凭据隔离是 B 类） |
| `250-264` `createFshineResourceLoader` | 用装配层 systemPrompt 替换 Pi 默认 preamble；扩展/Skills/AGENTS/提示模板/主题全空 | ✓ 安全边界，不是第二套技能机制 |
| `286-335` `toAgentTool` + `424-450` customTools/白名单 | DiscoveredTool → ToolDefinition，`tools:[...]` 显式白名单 | ✓ 工具面集成（`progress` 参数为既有语义） |
| `400-485` `buildConversation` | 建/恢复 Session、`SettingsManager.inMemory`、事件订阅 | ✓ 生命周期 + 配置 |
| `497-662` `run` | 交本轮 prompt、事实注入、abort/deadline、日志、nudge、投影 | ✓（nudge 为既有 A 类） |
| `696-727` `projectSession` | Pi 转录 → 宿主只读投影（compactionSummary/custom 渲染） | ⚠ 渲染约定，只读、无状态 |
| `796-857` provider 工具名规范化 | 名称合法性/冲突 | ✓ 既有接缝 |

**判定：是，适配层不是第二套 runtime。** 依据：无 agent loop（`run` 只调一次 `session.prompt` + 一次 nudge）、无压缩/裁剪/重试引擎、无转录存储（`SessionManager` 是唯一所有者）、无工具调度器（Pi 原生 function calling）。唯一要盯的是 §2.2 的阈值决策与 `projectSession` 的渲染逻辑——两者都应保持为「配置/展示」，不再长大。

---

## 4. ④ 是否引入第二套会话所有权

**否（产品码内）。**

- 转录唯一所有者：`SessionManager` + `AgentSession`，只在 `pi-driver.ts` 出现（`grep SessionManager packages/agent/src` 仅此文件）。`session.messages` 是公开 getter（`dist/core/agent-session.d.ts:482`）。
- 宿主侧只剩一个**只读回落快照**：`execution-runtime.ts:422-429`
  ```
  let lastMainProjection: readonly DriverMessage[] = [];
  const mainTranscript = () => options.mainDriver.transcript?.() ?? lastMainProjection;
  ```
  每回合整体覆盖（`:654`），从不追加/改写；有 `transcript()` 的真驱动下根本不读它。`Session.transcript()` 直接委托驱动（`:672`）。
- 业务会话身份仍归宿主：`apps/server/server.ts:146-175` 的 `Map<principalId\0sessionId, Promise<Session>>` + `enqueueSessionTurn`（`:186-187`）只是 B 类「归属 + 串行」，不持有对话内容。
- Worker 每回合一个一次性会话（`ask-runtime.ts:506` 的 worker 未传 `reuseConversation`；驱动 `:660` dispose），与基线一致。
- 遗留瑕疵（不构成第二所有权，但应清理）：`execution-runtime.ts:618` 每回合仍然 `[...mainTranscript(), userMessage(text)]` 造一份全量数组再交给驱动；驱动在会话已存在时忽略除最后一条外的所有内容（`:507` 的 seed 只在新建会话时 append）。这是无用的 O(n) 拷贝，不是权威副本。
- 生产**没有**落盘/恢复接线：`sessionDir`/`resumeSessionFile` 无产品调用者（§1.2），所以重启后 Main 会话丢失——这不是「第二所有权」，而是「持久化尚未接入」（见 §6）。

---

## 5. ⑤ 是否改变 Worker 业务语义

**未改变。** 证据：

- `git diff badbf32..HEAD -- packages/contracts packages/agent/src/task-registry*.ts packages/agent/src/task-runner.ts` → **空**；Execution Contract、任务底账、执行器语义零改动。
- `execution-runtime.ts` 本次只有 25 行变更，全部在 Main `send()` 的 `mainMessages → turnMessages/injections`（`:616-623`）；Worker 两条路径未变：前台 `:581-592`、后台 `:808-820`，仍是「一个 user 消息 = 一次委派 + `execute_operation` 唯一工具 + 宿主生成 requestId + 同一 deadline/signal」。
- `renderWorkerSystemPrompt` / `WORKER_SYSTEM_PROMPT` / `renderWorkerDelegation` 无 diff；`ToolUserError` 的 terminate 语义在 `toAgentTool:322-331` 原样保留。
- Worker 的工具结果仍原样 JSON 进转录（`:317-321`），任务成功/失败仍由 fshine SQLite 底账判定（`:596-601` 前台、`:827-831` 后台），**没有**用 Pi Session 推断任务结果。

唯一可观察差异在 Main：事实注入从「push 进宿主数组」改为 Pi 原生 custom message（`pi-driver.ts:569-575`，`triggerTurn:false`），投影后仍是 user 消息，宿主 `transcript()` 可见——语义等价，且少了一份宿主历史。

---

## 6. ⑥ B1：能删还是暂时保留

阶段 C 预注册（`scripts/eval/pi152-stageC/PREREG.md:9-20`）8 项判据；本次**实跑**预注册命令 `npx vitest run scripts/eval/pi152-stageC/stage-c.test.ts` → 15/15 通过，逐项读数（测试打印）：

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| ① | (principalId,sessionId) 唯一映射 | 原生命名含时间戳，重复 create 产生第二个文件 | **FAIL** |
| ② | 单写者 | 两句柄交叉追加不报错，重开后另一分支静默丢失（`STAGE-C-② onDiskMessageEntries:3 / ["u1","u3-from-B"]`） | **FAIL**（B1 同样靠宿主串行，但 B1 至少显式） |
| ③ | 跨 principal 隔离 | 同 sessionDir 同 id：B 读到 A 的转录（`bobSees:["alice 的私密内容"]`） | **FAIL**（B1 内建 principal 分区） |
| ④ | 重启/异常退出 | SIGKILL 后完整条目可读、可续写 | **PASS** |
| ⑤ | 压缩后重启继续 | 恢复请求含摘要 + 保留尾段 | **PASS** |
| ⑥ | 旧 B1 格式兼容 | 旧 v4 提交日志 `not a valid pi session`；按 id 查不到 → 直接新建空会话（`filesAfterNaive:2`） | **FAIL**（存在静默新建风险） |
| ⑦ | 损坏明确报错 | 坏正文行被静默跳过；0 字节文件静默补 header | **部分 FAIL** |
| ⑧ | 恢复后不重执行工具 | 假执行层计数 1→1 | **PASS** |

**判定：B1 暂时保留，不能整体删除。** Pi `SessionManager` 只赢下 ④⑤⑧（存储/扩展/不重放），输掉 ①②③⑥⑦，而这些正是 B1 承担的 B 类确定性责任（可信身份分区、键→文件唯一、损坏不静默、旧格式不静默重建）。

对齐阶段 C 的建议：
1. 短期：不删 B1；本分支不合入 `arch/integration` 前，driver 的 `sessionDir/resumeSessionFile` 保持不接线（或直接删，避免悬空 API）。
2. 合并时：**把 B1 的存储引擎换成 SessionManager**，只保留一个薄包装（`hash(principalId,sessionId)` 文件名 + principal 目录分区 + 严格 `parseSessionEntries` 校验 + 旧格式迁移入口），目标 ≤100 行；不要出现两套落盘实现（删除纪律）。
3. 迁移旧 B1 记录：一次性迁移脚本，不能依赖「按 id 查不到就新建」。

---

## 7. ⑦ 当前公开 API 是否足以稳定升级

**够用，但有三类缺口；没有越界依赖。** `npm run typecheck` 已跟踪树 0 错误，全部导入来自 `@earendil-works/pi-coding-agent` root（无 deep-import、无 Pi 源码改动、无 pi-durable）。

已消费的公开 API：`createAgentSession`、`AgentSession`、`SessionManager`（`create/open/inMemory/appendMessage`）、`SettingsManager.inMemory`、`ModelRuntime.create/registerProvider/getModel`、`DEFAULT_COMPACTION_SETTINGS`、`createExtensionRuntime`、`defineTool`（未用，见下）、类型 `AgentSessionEvent/CompactionSettings/ResourceLoader/ToolDefinition`。

缺口（按风险排序）：

| 缺口 | 证据 | 影响 |
|---|---|---|
| 1. `CompactionSummaryMessage` / `CustomMessage` 类型**未从 root 导出** | root `index.d.ts:12` 只导出 `convertToLlm`；类型在 `dist/core/messages.d.ts:26-58`（`declare module` 增强） | 驱动只能 `as unknown as { role, summary, content }` 读转录（`pi-driver.ts:699-713`、`733`）。升级时字段改名不会被编译期发现 → 建议改用公开 `convertToLlm`（root 导出）或 `buildSessionProjection`（`dist/core/session-manager.d.ts:207`）做投影 |
| 2. `SessionManager` 无「键 → 唯一文件」与 principal 维度 | 阶段 C ①②③ 实测 FAIL | 必须宿主自持映射+分区（B1 保留）。这是 API 缺能力，不是 adapter 缺陷 |
| 3. 损坏/旧格式的严格性 | 阶段 C ⑥⑦ 实测 FAIL（静默跳过坏行、静默补 header、查不到 id 静默新建） | 宿主必须自己做严格校验（B1 保留） |
| 4. `ModelRuntime.create` / `createAgentSession` 均为 async | `createPiModelRuntime:217`、`buildConversation:438`；`DriverFactory` 被迫改为可返回 Promise（`ask-runtime.ts:131`） | 装配层签名被 Pi 的异步初始化渗透一次；已用 `await` 收口，可接受 |
| 5. `noTools:'all'` 会连 `customTools` 一起关 | 设计文档 §4（probe 实测） | 工具隔离只能靠 `tools:[白名单]`；已采用 |
| 6. `defineTool` 未使用 | `pi-driver.ts:447` 的 `as ToolDefinition[]` | 建议改用 `defineTool` 换取编译期校验，顺带删 `PiAgentTool`（§1.2） |

另：`ModelRuntime.create({ authPath: path.join(tmpdir(), 'fshine-pi-auth-<pid>.json') })`（`pi-driver.ts:217-222`）会把认证存储指向**可预测的临时路径**，且 Main/Worker 共享同一路径。是否真的写入凭据、临时文件权限如何，本次**未验证**；合并前应确认（凭据隔离是 B 类）。

---

## 8. LOC 与模块依赖

### 8.1 精确 LOC（`git diff --numstat badbf32..HEAD`）

| 类别 | 文件数 | + | − | 净 |
|---|---|---|---|---|
| 产品源码（`packages/agent/src/{pi-driver,execution-runtime,driver-contract}.ts` + `apps/server/server.ts` + `scripts/ask-runtime.ts`） | 5 | 531 | 381 | **+150** |
| 测试与夹具（17 个 `*.test.ts` + `fixtures/pi-session-crash.ts` + `testing/scripted-model-runtime.ts`） | 17 | 940 | 516 | +424 |
| 评测脚本（含阶段 D 2513 行、`token-estimate.ts` 34、`r5p4fix-real.ts`/`r5p4-bare.ts` 删除 880） | 20 | 2638 | 964 | +1674 |
| 文档（`pi-152-adapter-design.md`） | 1 | 152 | 0 | +152 |
| **合计** | **43** | **4261** | **1861** | **+2400** |

产品源码逐文件：

| 文件 | + | − | 净 | HEAD 行数 |
|---|---|---|---|---|
| `packages/agent/src/pi-driver.ts` | 469 | 365 | +104 | 857 |
| `packages/agent/src/driver-contract.ts` | 35 | 2 | +33 | 99 |
| `packages/agent/src/execution-runtime.ts` | 16 | 9 | +7 | 862 |
| `scripts/ask-runtime.ts` | 9 | 4 | +5 | 660 |
| `apps/server/server.ts` | 2 | 1 | +1 | 280 |

纯产品净增只有 +150 行；再扣掉 §1.2 可删的 ~60–90 行，本次迁移的产品面净增可压到 **+60–90 行**。

### 8.2 模块依赖（谁 import 谁，产品面）

```
pi-coding-agent (root) ──► pi-driver.ts ──► driver-contract.ts (ToolUserError/TurnDriver)
pi-agent-core (type) ────► driver-contract.ts   △ Pi 耦合只在这两个文件
pi-ai (type) ────────────► pi-driver.ts
@fshine/contracts (type) ─► pi-driver.ts / driver-contract.ts / execution-runtime.ts
                              │
driver-contract.ts ◄──────────┤ (type only)
execution-runtime.ts ─────────┘  (task-registry / resource-policy / task-runner / skills)
        ▲
        │
ask-runtime.ts ──► pi-driver.ts (createPiTurnDriver/parseContextWindow)
        ▲              └─ 未 import session-persistence（本 worktree 不存在）
        │
apps/server/server.ts ──► ask-runtime.ts (assembleSessionCore/DriverFactory)
                       └─► driver-contract.ts (type) / execution-runtime.ts (Session type)
```

- 依赖方向单向，无环；Pi 包只进 `pi-driver.ts`（运行时）与 `driver-contract.ts`（类型），符合「Pi First」。
- 无 Planner/Router/事件总线/第二套 Task Registry。

### 8.3 与 0.85.1 路线的代码量对照（基准 = 分叉点 `84a22fa`，即 `arch/integration` 的 0.85.1 驱动）

| 模块 | 0.85.1（84a22fa） | 1.5.2（HEAD b8478c0） | 差 |
|---|---|---|---|
| `pi-driver.ts` | 1256 | 857 | **−399（−31.8%）** |
| `execution-runtime.ts` | 855 | 862 | +7 |
| `driver-contract.ts` | 68 | 99 | +31 |
| `session-persistence.ts`（B1） | 0（integration 上 281） | 0（本 worktree 无） | — |
| 产品核心合计 | **2179** | **1818** | **−361（−16.6%）** |

0.85.1 驱动里被删掉的宿主压缩机器：`summaryInputAllowance`→`compactTranscriptWithPi` 整段（84a22fa `260-796`，**537 行**），另有 `IDLE/OVERALL` 超时（`27-28`）、`CONTEXT_OVERFLOW_PATTERNS`（`36-56`）、`isRetryableAssistantError` 重试器（`21`）。1.5.2 用约 300 行会话生命周期 + ResourceLoader + 工具桥替换，净省 361 行。

**若与 integration 合并并保留 B1（+281 存储 +49 runtime +34 server +7 ask-runtime ≈ +371），1.5.2 产品核心 ≈ 2189 行，与 0.85.1 的 2179 行基本持平。** 也就是说：本轮迁移的收益不是「代码更少」，而是「宿主不再拥有压缩/裁剪/重试/转录」（职责更小）；行数会被 B1 薄包装吃掉。任何以「省实现成本」为由继续加兼容层的做法都没有余量支撑。

---

## 9. 予以点名的「兼容治理 / 悬空实现」

1. `scripts/eval/pi-native/safe-config.ts:91-118` + `safe-config.test.ts:53,69,81`：仍以 0.85.1 摘要预算公式做硬断言（`summaryBudget=6553` 等），而 1.5.2 已无摘要 `maxTokens`。**属于为实现成本保留旧治理，应删断言或改为「无预算」事实断言。**
2. `pi-driver.ts:179-185`、`387`、`407`、`414-424`：`sessionDir/resumeSessionFile` 无生产调用者，是「未来阶段」API 悬空在产品驱动里。
3. `pi-driver.ts:680-687`、`driver-contract.ts:71-72`：`close()` 无生产调用者；实例级会话释放未接线。
4. `pi-driver.ts:351/481/566/643`：`lastProjection` 只写不读。
5. `pi-driver.ts:113-122`：`KIMI_THINKING_LEVEL_MAP` 由自己的测试续命。
6. `scripts/eval/pi152-stageD/harness.ts:561,574`：阶段 D 的压缩阈值来自 fshine 系数（0.25/0.3），报告若把结论写成「纯 Pi 原生压缩」需加注。
7. `apps/server/server.ts:146-175`：会话只存在进程内；重启即失忆，且没有接线到 driver 的落盘口。这是已知缺口（阶段 C），不要用「Pi 会压缩/重试」掩盖。

## 10. 结论

- **可以删**：至少 `lastProjection`、`KIMI_THINKING_LEVEL_MAP`、`PiAgentTool`+强转、`toSessionMessage` custom 分支（约 30–40 行产品码）；`sessionDir/resumeSessionFile/close/sessionInfo` 要么接线（阶段 C）要么删。
- **没有** fshine 管理的压缩执行/历史裁剪/模型重试；**仍有** fshine 计算的压缩阈值（小窗口 0.25/0.3）与 `LLM_COMPACTION_*` 注入口，以及 eval 侧 0.85.1 摘要预算残留。
- 适配层是集成层，不是第二 runtime；转录所有权唯一（Pi），宿主只剩只读快照与业务会话键。
- Worker 语义零改动（契约/底账/提示词 diff 为空）。
- B1 暂时保留：SessionManager 只覆盖 ④⑤⑧，①②③⑥⑦ 仍需 B1；合并时应把 B1 降为薄包装，而不是两套并存。
- 公开 API 够用；缺口集中在「消息类型未从 root 导出」与「SessionManager 无唯一键/principal 维度/严格损坏处理」，前者可用 `convertToLlm`/`buildSessionProjection` + `defineTool` 收敛，后者由 B1 承担。
- LOC：产品源码 +531/−381（净 +150）；全量 +4261/−1861（净 +2400，其中 2513 行是阶段 D 评测夹具）。对 0.85.1 路线，产品核心 −361 行（−16.6%），合并 B1 后基本持平。
