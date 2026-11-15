# Pi 原生 Session / 压缩替换实验 · 阶段二「最小可运行原型」

> worktree：`~/projects/fshine-agent-exp-pi-session`（分支 `exp/pi-native-session-compaction`）。
> 版本口径：只读锁版本 `@earendil-works/pi-agent-core@0.85.1`（与 worktree `package-lock.json` 一致）。
> **零真实模型**：全程用假 stream fn 驱动；无任何真实 Provider/网络调用。

## 这个 spike 证明什么

只用 Pi 的**公开入口**装配 `AgentHarness` + `Session` + 假 stream fn，并证明：

1. **装配可行**——`AgentHarness.create` + `MemorySessionRepo`/`JsonlSessionRepo` + 假 `Models` 能真实跑通完整生命周期。
2. **压缩由 Pi 触发并执行**——所有 `compaction_start`/`compaction_end` 事件与 `type=compaction` entry 均由 `AgentHarness`/lane 路径产生；**本原型未引入任何 fshine 自研压缩触发**。原型里唯一的压缩相关输入是公开的 `AgentHarnessOptions.compaction`（`CompactionSettings`）与 `AgentHarnessOptions.retry`（`RetryPolicy`）。

## 使用的公开入口（仅此四处）

| 入口 | 来源 | 用途 |
|---|---|---|
| `AgentHarness` | `@earendil-works/pi-agent-core`（root `.`） | harness 构造 + 驱动 lane |
| `setDefaultStreamFn` | `@earendil-works/pi-agent-core`（root `.`） | 安装假流作为公开缺省 stream fn（无真实 provider） |
| `MemorySessionRepo` / `JsonlSessionRepo` | `@earendil-works/pi-agent-core/harness/session` | 会话仓储（内存 / 落盘） |
| `BACKGROUND_CONTEXT` | `@earendil-works/pi-agent-core/harness/context` | 运行上下文 |
| `NodeExecutionEnv` | `@earendil-works/pi-agent-core/harness/env/nodejs` | 供 `JsonlSessionRepo` 的 `fileSystem` |
| `createAssistantMessageEventStream` | `@earendil-works/pi-ai/utils/event-stream` | 构造与 Pi 同构的假流（provider 侧装配件） |

**未 import 任何 `dist/**` 内部符号、未复制 Pi 源码。**

## 如何复跑

前提：worktree 本身无 `node_modules`。先将主仓的 `node_modules` 链接进 worktree（`node_modules/` 已被 `.gitignore`，不入库）：

```sh
ln -sfn /home/tao/projects/fshine-agent/node_modules \
        /home/tao/projects/fshine-agent-exp-pi-session/node_modules
cd /home/tao/projects/fshine-agent-exp-pi-session
node scripts/eval/pi-native/driver.mjs
```

退出码 `0` = 全部断言通过；`1` = 有失败。完整原始输出已随本目录 `OUTPUT.txt`。

## 场景与判据（S1–S6 + S7 附加）

| # | 场景 | 判据 | 结果 |
|---|---|---|---|
| S1 | 跨回合转录连续性：同一 session 两次 `lane.prompt` | 第二回合 provider 上下文含第一回合 user+assistant；entry 链 `parentId` 连续；tip 前移 | PASS |
| S2 | threshold 自动压缩（`reserveTokens` 调小强制触发） | `compaction_start reason=threshold` → `type=compaction` entry（含 `summary`+`retainedTail`）→ `compaction_end status=completed` | PASS |
| S3 | Overflow Recovery（首答 context-overflow，次答正常） | `compaction_start reason=overflow` → 压缩 → 自动续跑 → `run_end completed` | PASS |
| S4 | 有界失败 | (a) 反复 overflow：**只**恢复一次 → `run_end failed`，assistant 调用恒为 2、无 `retry_scheduled` 死循环；(b) 空会话 `lane.compact` → `NothingToCompact`、**零** provider 调用 | PASS |
| S5 | 工具调用/结果完整配对 | 压缩后 `retainedTail` 中 toolCall 与其 toolResult 同侧；全会话 toolCall/result 一一配对 | PASS |
| S6 | 摘要失败有界 | 摘要 provider 报错 → `retry_scheduled` 至 `maxAttempts`(=3) → `compaction_end status=failed`，**不无界重试** | PASS |
| S7（附加） | 持久化入口 | `JsonlSessionRepo` 落盘后重开同一 session，转录保留 | PASS |

## 关键原始输出（节选自 `OUTPUT.txt`）

### S1 跨回合连续性

```
r1.ok=true  r2.ok=true
entry chain (ascending):
  seq=4  id=01a1defd parent=null       type=message role=user
  seq=14 id=01a1defd parent=01a1defd   type=message role=assistant
  seq=23 id=01a1defd parent=01a1defd   type=message role=user
  seq=33 id=01a1defd parent=01a1defd   type=message role=assistant
provider context on 2nd prompt saw round1 user text: true
provider context on 2nd prompt saw round1 assistant text: true
  [PASS] entry chain parentId contiguous
  [PASS] tip advanced after round2
```

第二回合 provider 实际收到的 `messages`（假 provider 侧记录）：

```
["user:[{\"type\":\"text\",\"text\":\"hello round1\"}]",
 "assistant:[{\"type\":\"text\",\"text\":\"first-answer\"}]",
 "user:[{\"type\":\"text\",\"text\":\"hello round2\"}]"]
```

### S2 threshold 压缩（硬证据：Pi 侧事件 + Pi 写入的 compaction entry）

```
compaction_start = {"reason":"threshold"}
compaction_end   = {"status":"completed","reason":"threshold","entryId":"01a1defd"}
compaction entry = {
  "type": "compaction",
  "tokensBefore": 5000,
  "fromHook": false,
  "summary": "PI-GENERATED-SUMMARY",
  "retainedTailRoles": ["user","assistant"]
}
completeSimple (summary) calls = 1
  [PASS] compaction_start reason=threshold
  [PASS] compaction_end status=completed
  [PASS] a type=compaction entry was written
  [PASS] summary text came from the summary provider via Pi pipeline
  [PASS] retainedTail keeps the recent turn (starts at a user message)
```

（`reserveTokens=100` + 假模型 `contextWindow=1000` + 第二回合假 usage `totalTokens=5000` → `shouldCompact` 在 checkpoint 判定为真。原型未调用任何压缩 API；`compaction_start` 由 Pi 的 `runCheckpoint` 发出，entry 由 Pi 的 structural 管线写入。）

### S3 Overflow Recovery

```
compaction_start reason = overflow
compaction_end = {"status":"completed","reason":"overflow"}
run_end = [{"status":"completed"}]
assistant stream calls = 2       # 1 次 overflow + 1 次恢复后正常
```

（假 provider 首答 `stopReason:"error"` + `errorMessage:"prompt is too long: ..."` 命中 Pi 原生 `isContextOverflow`。）

### S4 有界失败

```
-- S4a persistent overflow --
compaction_start reasons = ["overflow"]        # 仅一次恢复
compaction_end = [{"status":"completed","reason":"overflow"}]
run_end = [{"status":"failed","error":"assistant_error"}]
retry_scheduled count = 0
assistant stream calls = 2                      # 有界，无死循环

-- S4b nothing to compact --
lane.compact error = {"_tag":"NothingToCompact","message":"Lane \"main\" has nothing to compact"}
provider calls = 0
```

### S5 工具配对

```
compaction_end = {"status":"completed","reason":"threshold"}
assistant toolCall entry seq=33 ids=["tc-echo-1"]
toolResult entry seq=43 toolCallId=tc-echo-1 toolName=echo
compaction retainedTail roles = ["user","assistant","toolResult","assistant"]
retainedTail toolCall ids = ["tc-echo-1"]
retainedTail toolResult ids = ["tc-echo-1"]
session: toolCalls=["tc-echo-1"] toolResults=["tc-echo-1"]
  [PASS] retainedTail keeps toolCall AND its toolResult together
```

### S6 摘要失败有界

```
retry_scheduled = [{"attempt":2,"maxAttempts":3},{"attempt":3,"maxAttempts":3}]
compaction_end = [{"status":"failed","reason":"threshold","error":"summarization_failed"}]
run_end = [{"status":"completed"},{"status":"failed","error":"summarization_failed"}]
summary completeSimple calls = 3               # = maxAttempts，有界
```

## 说明与边界

- **假 `Models`**：harness 内部对 provider 的调用点是 `lane.models.streamSimple` / `lane.models.completeSimple` / `lane.models.getModel`（见分发物 `dist/harness/runtime/drive/generation.js:134`、`structural.js:629`、`lane.js:1280`）。本 spike 用一个仅实现这三个方法的对象顶上 `Models`，其余方法为 `n/a` 桩；`setDefaultStreamFn` 亦安装假流作为公开缺省（无真实 provider 可达）。
- 本 spike 为**证伪/证实**用途，非产品码；**未改动 `packages/**`**、未升级 Pi、未动 lockfile。
- 随机 `id`/时间戳导致输出不可逐字复现，但断言稳定通过（多次运行均 `ALL CHECKS PASSED`）。
