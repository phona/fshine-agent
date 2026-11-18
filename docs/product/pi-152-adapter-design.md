# Pi 1.5.2 Adapter 设计（阶段 A：最小 AgentSession 接入）

> 分支 `arch/pi-upgrade`（worktree `~/projects/fshine-agent-pi-upgrade`），Pi 三包固定 1.5.2。
> 本文是动手前的设计：**先定转录所有权，再改代码**。只依赖 `@earendil-works/pi-coding-agent`
> root 公开导出（`createAgentSession` / `AgentSession` / `SessionManager` / `SettingsManager` /
> `ModelRuntime` / `defineTool` / `ResourceLoader` 类型），不 deep-import、不改 Pi 源码、不引 pi-durable。
>
> **状态（2026-11-18 注）**：本设计已按稿实施并合入 main（`pi-driver.ts` 为唯一 Pi 接缝）；「动手前」自述已失效，正文按设计原貌保留。

## 1. 边界图

```
Channel / ask ──► execution-runtime（宿主最小面：身份 · 确认事件 · 任务归属 · 凭据隔离 · 如实交付）
                        │  每回合只交「本轮新增输入」；不持有可变对话历史
                        │  Session.transcript() = mainDriver.transcript()（只读派生）
                        ▼
                  TurnDriver（pi-driver.ts 适配器，唯一 Pi 接缝）
                        │  createAgentSession({ modelRuntime, model, sessionManager, settingsManager,
                        │                       resourceLoader, customTools, tools:[白名单] })
                        ▼
        pi-coding-agent 1.5.2 AgentSession ── 独占：agent loop · 转录(SessionManager) · 压缩 · 原生重试
                        │  ModelRuntime.registerProvider('llm', { api:'openai-completions', ... })
                        ▼
                  step-3.7-flash（LLM_API_BASE_URL / LLM_API_KEY 来自 .env）

  工具面：customTools = input.tools（DiscoveredTool 白名单）→ 只有 run_task / task_status /
          task_result / task_cancel / task_resume / read_skill 中「装配条件成立」的那些；
          Pi 内置 read/bash/edit/write 一律不激活（`tools` 白名单，不是 `noTools`）。
```

## 2. A4 旧接口审计：完整 `AgentMessage[]` 与 Pi 的每一次交接（迁移前）

| 位置（迁移前） | 方向 | 事实 |
|---|---|---|
| `packages/agent/src/pi-driver.ts:432-449` | 宿主 → Pi | 每回合把 `input.messages`（全量历史）切出 `toAppend`，逐条 `lane.appendMessage(...)` 灌进 Pi 转录 |
| `pi-driver.ts:453` | 宿主 → Pi | `lane.prompt([last])` 把「最后一条 user」作为本轮输入 |
| `pi-driver.ts:460, 517` | Pi → 宿主 | `projectTranscript(lane)` 读 lane 全部 entries，压成宿主 `AgentMessage[]` |
| `pi-driver.ts:529` | 宿主缓存 | `lastProjected = messages`（宿主侧第二份转录，用于下回合算增量） |
| `pi-driver.ts:436-448` + `218-230` | 宿主比较 | `isPrefixExtension(lastProjected, input.messages)`：宿主自行判断「Pi 转录是否仍是宿主转录的前缀」 |
| `pi-driver.ts:336` + `107-124` | Pi 投影补丁 | `toProviderMessages: plannerMessagesToLlm`：把宿主 custom/compactionSummary 投影成 provider 消息 |
| `packages/agent/src/driver-contract.ts:25` | 宿主 → 驱动 | `TurnDriverInput.messages: DriverMessage[]`（「完整转录」） |
| `driver-contract.ts:40` | 驱动 → 宿主 | `TurnDriverResult.messages: DriverMessage[]`（「更新后的完整转录，由调用方持久化」） |
| `packages/agent/src/execution-runtime.ts:422` | 宿主持有 | `let mainMessages: DriverMessage[] = []`（**宿主可变转录本体**） |
| `execution-runtime.ts:610, 612` | 宿主追加 | facts 注入与用户文本 push 进 `mainMessages` |
| `execution-runtime.ts:620` | 宿主 → 驱动 | `messages: mainMessages` 全量回灌 |
| `execution-runtime.ts:647` | 驱动 → 宿主 | `mainMessages = [...mainResult.messages]` 用驱动返回值整体替换 |
| `execution-runtime.ts:665` | 宿主出口 | `transcript: () => [...mainMessages]` |
| `packages/agent/src/session-persistence.ts` | — | **本 worktree 不存在此文件**（持久化设计见 `docs/product/r5-session-persistence-design.md`，阶段 C 才接线）；A1 的 dispose/重开/异常退出用 `SessionManager` 直接验证 |

**审计结论**

1. 旧驱动在「Pi 已持有转录」之外，又让宿主持有并每回合重建一份 `mainMessages`，两者靠
   `lastProjected` + `isPrefixExtension` 手工对账——这就是第二份可变转录，必须删。
2. 迁移后 **`AgentSession` 独占转录**：
   - 删 `mainMessages`、`lastProjected`、`isPrefixExtension`、`projectTranscript(lane)`
     （改为 `projectTranscript(session)`：读 `session.messages` 的**只读投影**，把
     `role=compactionSummary` 渲染成宿主可读的「【此前会话摘要】」user 消息、过滤 `system`）。
   - 删 `plannerMessagesToLlm`（宿主 custom message 通道已无生产者；Pi 原生投影负责 provider 消息）。
   - 删「每回合全量回灌历史」：`TurnDriverInput.messages` 语义收紧为**本回合输入快照**
     （最后一条 user = 本轮输入；其余仅在驱动尚无会话时作为首回合种子）。会话已存在时宿主
     传什么都**不进入** Pi 转录。
   - `TurnDriverResult.messages` 改为**同一只读投影的快照**（不是宿主累积的数组）。
   - 新增 `TurnDriver.transcript?(): readonly DriverMessage[]`：宿主 `Session.transcript()`
     直接委托驱动读 Pi 会话；`execution-runtime` 只保留 `lastMainProjection`（每回合由结果
     覆盖的只读派生值，供没有 `transcript()` 的测试替身使用），**不再追加/改写**。
3. 会话内用于「事实注入」的 user 消息仍由宿主产生（R5 B 通道既有语义），但它是**本回合输入**，
   不是宿主历史副本。

## 3. A1 会话生命周期

- `reuseConversation: true`（Main 装配）＝ **实例级会话**：首次 `run` 建一次 `AgentSession`，
  之后同实例复用（压缩/转录/重试状态都在 Pi 里）；`close()` 释放。
- 缺省/false（Worker 每次委派）＝ **回合级会话**：每 `run` 建一个 `SessionManager.inMemory()`，
  结束 `dispose()`；不与 Main 共享任何转录。
- `sessionDir` 显式给出 → `SessionManager.create(cwd, sessionDir)` 落盘；`resumeSessionFile`
  → `SessionManager.open(file, sessionDir, cwd)` 继续同一 Session（**会话身份由装配层给出，
  后期归阶段 C**）。
- 异常退出：SessionManager 每追加一条 entry 即落盘（probe 实测 prompt 进行中文件已存在），
  进程被 SIGKILL 后 `SessionManager.open` 可恢复并继续。A1 用子进程 SIGKILL 实测。
- 系统提示/工具变化：会话创建时快照；后续 `run` 若 `systemPrompt` 与快照不同，丢弃并按新提示
  重建（可归因日志 `pi_driver_prompt_changed_session_rebuild`；生产 Main 提示恒定，不触发）。

## 4. A2 工具面（白名单 + 装配条件）

- `customTools` = 本回合 `input.tools` 映射的 `ToolDefinition`（`defineTool`）。
- 激活集合用 `tools: [name...]` **显式白名单**。probe 实测：`noTools:'all'` 会把 `customTools`
  一起关掉（`getActiveToolNames()` 为空），所以不能用它当隔离手段。
- 暴露与否服从原装配条件（由 `execution-runtime` 构造 `input.tools` 时决定）：
  `run_task` 恒有；`task_status/task_result/task_cancel/task_resume` 仅当注入 `taskRunner`；
  `read_skill` 仅当注入 `mainSkillRegistry`。驱动不自行增删。
- 内置工具：白名单外，模型若发起 `bash` 调用，Pi 返回 `toolResult{ isError:true, "Tool bash not found" }`
  且 `exec` 不被调用（probe 实测）。A2 用「`getActiveToolNames()` + 一次真实触发尝试」双证。

## 5. A3 系统提示词与 Skills（受控 ResourceLoader）

驱动内实现最小 `ResourceLoader`（公开接口，非 Pi 源码副本）：

| 方法 | 返回 | 目的 |
|---|---|---|
| `getSystemPrompt()` | `input.systemPrompt`（fshine 装配的 Main/Worker 提示，含既有 Skill 目录块） | 作为 Pi 的 `customPrompt`（**替换**默认 coding-assistant preamble） |
| `getSkills()` | `[]` | 不启用 Pi 的 read/bash 技能读取通道（我们不暴露 read/bash） |
| `getAgentsFiles()` | `[]` | 不加载任何项目文件 / AGENTS.md |
| `getExtensions()/getPrompts()/getThemes()` | 空 | 不加载扩展、提示模板、主题 → 无文件系统/终端/MCP 自动授权 |
| `getAppendSystemPrompt()` | `[]` | 不加宿主提示词补丁 |

- `cwd` = 独立空工作目录（缺省 `os.tmpdir()` 下按会话隔离），**不是仓库根、不是用户主目录**；
  Pi 只会在提示里渲染 `<cwd>` 一行，不据此发现项目文件。
- 业务 Skills 的投递保持现状：装配层把 Skill 目录/正文拼进 `systemPrompt`（Main 的既有
  `renderSkillCatalog` / Worker 的 `renderWorkerDelegation`），驱动不新增第二套技能机制。
  记录 Pi 行为：`skills` 段只在声明了 `read`/`bash` 阅读器时渲染——我们**故意不声明**，因此
  不依赖该段，也不改变 Main/Worker 职责。
- 不修改 Worker 核心提示词与 Execution Contract 业务语义。

## 6. 压缩 / 重试 / 错误归因（全部归 Pi）

- `SettingsManager.inMemory({ compaction: options.compactionSettings ?? piCompactionSettings(window), retry })`：
  只传绝对配置（Pi 配置适配，沿用既有 `piCompactionSettings` 纯函数），触发/摘要/尾段/溢出恢复归 Pi。
- 事件映射（只读观测）：`auto_retry_start` → `pi_driver_retry_scheduled`（计数/日志）；
  `message_end`（assistant, `stopReason=error`）→ `pi_driver_model_error`；
  投影末条错误 assistant → `pi_driver_failed_assistant`；空正文 → `pi_driver_empty_reply`；
  thinking-only → 沿用一次收尾催问 `pi_driver_final_text_nudge[_empty]`（既有行为，不是压缩治理）。
- 不新增预请求压缩门 / 上下文预算门 / 压缩重试器 / 摘要裁决器 / 历史裁剪。
- **1.5.2 观察（登记）**：摘要请求不再携带输出上限——`createSummarizationOptions` 已无
  `maxTokens`（旧 0.85.1 的 `min(floor(0.8×reserveTokens), model.maxTokens)` 被移除）。
  因此 `scripts/eval/pi-native/safe-config.ts` 的 `summaryBudgetTokens` 只保留为**历史推导记录**；
  公式守卫改为断言新事实（不再有摘要预算），不再据此断言 1.5.2 的摘要行为。

## 7. 删除与退役登记（本阶段）

| 对象 | 处理 | 理由 |
|---|---|---|
| `plannerMessagesToLlm` + 其单测用例 | 删 | 宿主 custom message 通道已无生产者；provider 消息投影归 Pi |
| `AgentHarness` / `MemorySessionRepo` / `BACKGROUND_CONTEXT` 路径 | 删 | 1.5.2 不再从 `pi-agent-core` 导出（只存在于 coding-agent 内部） |
| `mainMessages` / `lastProjected` / `isPrefixExtension` | 删 | 第二份可变转录 / 宿主自建增量对账 |
| `packages/agent/pi-native-long-lived-session.test.ts` 的 repo 计数断言 | 改写 | 改为数 `SessionManager.create + inMemory`（公开 API），等价断言「实例级 1 个 / 回合级 N 个」 |
| `scripts/eval/pi-native/r5p4-bare.ts`、`r5p4fix-real.ts` | 删 | 绑定已删除的 `pi-agent-core@0.85 AgentHarness` 导出；其失败输入已由 `scripts/eval/pi-runtime-experiment/replay.mjs`（badbf32）在 1.5.2 AgentSession 上重放，证据在 `.runtime/pi-runtime-experiment/` 与 `docs/product/exp-pi-native-*.md` |
| `scripts/eval/pi-native/safe-config.test.ts` | 改写 | 公式守卫改读 1.5.2 `pi-coding-agent/dist/core/compaction/compaction.js`；配置接线断言经 `SettingsManager.inMemory` 观测（公开 API）；**「评测脚本静态使用安全常量」用例随被删脚本退役**（减少 1 例，登记） |
| `pi-driver.test.ts` 的 custom-message 投影用例 | 删 | 同 `plannerMessagesToLlm`（机制已删；减少 1 例，登记） |

## 8. 验证读数（本次执行）

| 检查 | 命令 | 结果 |
|---|---|---|
| typecheck | `cd ~/projects/fshine-agent-pi-upgrade && export TMPDIR=~/.tmp && npm run typecheck` | exit 0（迁移前 24 个 TS 错误） |
| 全量单测 | `npx vitest run` | 86 文件 / 898 例全绿（迁移前基线：636 例 / 597 通过 / 39 失败；多数失败是旧 API import 导致整文件 collect 失败） |
| 真实模型接线（不联网） | 读取主仓 `.env`（worktree 无 `.env`）→ `createPiModelRuntime` | `step-3.7-flash` / `openai-completions` / 128k / 32k / auth configured；**未发起任何真实模型请求** |
| A1 异常退出 | A 验收测试子进程 SIGKILL | 恢复同一 Session 并继续（`pi-agent-session.test.ts`） |

## 9. 阶段 A 验收口径

- 真实 fshine 工具契约（`DiscoveredTool`）下：≥2 轮业务对话 + 1 次 Dummy 工具委派；
- 无私有 Pi Runtime 逻辑（无自建 loop、无自建压缩、无转录复制）；
- `npm run typecheck` = 0；`npx vitest run` 例数不减（退役用例按 §7 登记）；
- A1 另有：dispose 重开、子进程 SIGKILL 恢复两条确定性验证。
