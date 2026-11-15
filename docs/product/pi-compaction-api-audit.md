# Pi 压缩能力 · 公开 API 审计（r5-piopt 汇总员定稿）

> 角色：本 worktree = 并行调研的**唯一仲裁节点**。本文对 Pi 压缩相关的能力图谱、模块归属、**公开 API 与内部 API 的边界**、锁版本口径做统一定稿。
> 证据纪律：全部结论以**项目 lockfile 实际锁定的 Pi 版本**为准；每行给 `文件:函数:行号`；导出面以 `package.json` `exports` 与 `dist/index.d.ts` 复核，不以“函数存在”推断公开可用。

## 0. 版本基线（已亲验）

- worktree 核验（本会话）：`pwd`/`git rev-parse --show-toplevel` = `/home/tao/projects/fshine-agent-r5-piopt`；`git rev-parse --abbrev-ref HEAD` = `arch/r5-piopt`；`git worktree list` 显示 `fshine-agent-r5-piopt  e9ede79 [arch/r5-piopt]`。toplevel == worktree、分支正确，非主仓。
- **锁版本**（`package-lock.json`）：`@earendil-works/pi-agent-core` = **0.85.1**（`package-lock.json:959-975`，resolved tarball 0.85.1）；`@earendil-works/pi-ai` = **0.85.1**（`package-lock.json:992-1013`）。`package.json:11-12` 声明 `^0.85.1`。
- 本 worktree 已安装 `node_modules/@earendil-works/*`，实测 `pi-agent-core` 版本 = **0.85.1**（`node -e "require(...).version"` → `0.85.1`），与 lockfile 一致。跨全部 worktree 扫描仅存在 0.85.1 单一版本，**无版本混谈风险**。
- 下列行号均为 0.85.1 分发物 `dist/**`（构建自 `src/**`，行号可通过 `.map` 对应）。

## 1. 导出面：什么算“公开 API”

`node_modules/@earendil-works/pi-agent-core/package.json` 的 `exports` 只暴露 8 个入口：

```
.  ./node  ./harness/context  ./harness/env/nodejs
./harness/runtime/reducer  ./harness/session  ./harness/session/testing  ./package.json
```

**关键判定规则**：一个符号只有在①被根入口 `.`（`dist/index.d.ts`）re-export，**或**②位于上列 exports 子路径内，才可能被消费者 `import`。`compaction.js` 内部 `export` 了 17 个符号，但**只有 16 个**被根入口 re-export（`dist/index.d.ts:8`）；`./harness/compaction/compaction.js` 这个深路径**不在 exports map 内**，因此未被 re-export 的符号**对消费者不可达 = 内部 API**。

### 1.1 公开 API（根 `.` re-export，可直接 `import`）

`dist/index.d.ts:8` 一行 re-export 的压缩面：

| 符号 | 类型/函数 | 定义处 |
|---|---|---|
| `compact` | 函数（编排：preparation → 摘要） | `compaction.js:496` |
| `prepareCompaction` | 函数（session Entry[] → preparation） | `compaction.js:413` |
| `shouldCompact` | 函数（阈值判定） | `compaction.js:144-148` |
| `estimateContextTokens` | 函数（usage + 尾段估算） | `compaction.js:117` |
| `estimateTokens` | 函数（chars/4 启发） | `compaction.js:166-204` |
| `calculateContextTokens` | 函数（provider usage） | `compaction.js:81-84` |
| `getLastAssistantUsage` | 函数 | `compaction.js:97` |
| `findCutPoint` | 函数（Entry[] 切点） | `compaction.js:253` |
| `findTurnStartIndex` | 函数 | `compaction.js:237` |
| `generateSummary` | 函数（生成/续写摘要） | `compaction.js:369-411` |
| `generateSummaryWithUsage` | 函数（同上 + usage） | `compaction.js:374` |
| `serializeConversation` | 函数 | 经 `compaction.js` re-export |
| `DEFAULT_COMPACTION_SETTINGS` | 常量 | `compaction.js:75-79` |
| `CompactionSettings` / `CompactionPreparation` / `CompactResult` | 类型 | `compaction.d.ts:38-48 / 88-107 / 20-33` |
| `CompactionError` / `CompactionErrorCode` | 错误类型 | 经 `dist/index.d.ts:20` |

`dist/index.d.ts:7` 另 re-export 分支摘要面：`generateBranchSummary, prepareBranchEntries, collectEntriesForBranchSummary, ...`（`harness/compaction/branch-summarization.ts`）——与压缩正文无关，本审计只登记。

### 1.2 内部 API（`compaction.js` 内 `export` 但根入口**未** re-export；深路径不可达）

以下符号**存在且被 harness 内部使用，但消费者 import 不到**，**不得当作稳定公开 API**：

| 内部符号 | 定义处 | 未公开证据 |
|---|---|---|
| `generateSummaryWithRequest` | `compaction.js:378` | 不在 `dist/index.d.ts:8` |
| `compactWithRequest` | `compaction.js:500` | 不在 `dist/index.d.ts:8`（仅被内部 `structural.js:3` import） |
| `createSummaryRequestOptions` | `compaction.js:60` | 不在 `dist/index.d.ts:8` |
| `completeSimpleWithRetries` | `compaction.js:69` | 不在 `dist/index.d.ts:8` |
| `SUMMARIZATION_SYSTEM_PROMPT` | `compaction.js:295` | 不在 `dist/index.d.ts:8` |
| `SummaryRequest` / `SummaryGenerationOptions` / `CompactGenerationOptions` / `ContextUsageEstimate` / `CutPointResult` / `CompactionDetails` | `compaction.d.ts` | 不在 `dist/index.d.ts:8` |

复核命令：`node -e "console.log(Object.keys(require('./node_modules/@earendil-works/pi-agent-core/package.json').exports))"` → 输出不含 `./harness/compaction/*`；`grep generateSummaryWithRequest dist/index.d.ts` → 无命中。

## 2. 模块归属（能力图谱）

| 能力 | 归属模块（0.85.1） | 公开/内部 | 是否在 fshine 的 Agent 路径上 |
|---|---|---|---|
| 压缩原子件（阈值/切点/摘要/计量） | `harness/compaction/compaction.*` | 公开（根 `.` re-export） | **是**——fshine 直接复用 |
| `transformContext` 钩子调用点 | `agent-loop.js:179-180` | 内部（`Agent` 配置面） | **是**——每请求触发（含首条） |
| harness 压缩阈值/溢出管线 | `harness/runtime/drive/structural.js`（`prepareCompactionThreshold:837`、`prepareOverflowCompaction:872`，`overflowRecoveryUsed` 每代一次门控 `:873`） | **内部**（不在 exports map，仅 Session/serve 路径可达） | **否** |
| 分支摘要 | `harness/compaction/branch-summarization.*` | 公开（根 `.`） | 否 |
| fshine 压缩编排 | `packages/agent/src/pi-driver.ts` | 项目自有 | **是**（唯一生产调用点 `createPiTurnDriver`） |

**两套并存的真相**：Pi 有两条压缩路径——①harness 的 Session/serve 溢出管线（`structural.js`，同步恢复、每代一次门控），②`Agent` 循环里由调用方填的 `transformContext` 钩子（`agent-loop.js:179-180`）。fshine 的 `createPiTurnDriver` 走 ②，**harness 的 ① 管线不在其路径上**（`pi-driver.ts:688-712` 用 `new Agent(...)` + 自填 `transformContext`）。

## 3. fshine 已复用的公开 API（现状盘点）

`packages/agent/src/pi-driver.ts:6` 从**根入口** import：

```
Agent, type AgentTool, DEFAULT_COMPACTION_SETTINGS, estimateContextTokens,
estimateTokens, generateSummary, serializeConversation, shouldCompact,
type AgentMessage, type CompactionSettings
```

即：fshine **已在“原子件层面”复用 Pi 公开 API**（阈值判定 `shouldCompact`、计量 `estimateContextTokens/estimateTokens`、摘要生成 `generateSummary`、序列化 `serializeConversation`、默认常量 `DEFAULT_COMPACTION_SETTINGS`）。自研的是**编排**：`compactionSettingsFor` 小窗缩放（`:324-344`）、`splitForCompaction`（`:384-410`）、`summarizeWithinWindow` 有界分片（`:441-478`）、`trimToBudget`（`:481-491`）、`degradeByDropping`（`:498-515`）、`compactTranscriptWithPi`（`:532-618`）。

**结论（供 options 使用）**：Pi **有稳定公开 API**，但公开的是**原子件**；`compact`/`prepareCompaction` 虽公开，其输入是 **session `Entry[]`**（`compaction.d.ts:413` 的 `pathEntries: Entry[]`），不是 fshine 持有的 `AgentMessage[]` 转录。**“复用原子件”已在做；“复用整套编排”需要先引入 Pi 的 Session/Entry 模型**——这是 options 的核心分叉点。

## 4. 未验证项

- 本文只核**导出面与签名**，未在真实装配下 import 每一个符号逐一编译（PoC 仅 import 了 `estimateContextTokens/shouldCompact` 与类型，见 `pi-compaction-poc.md`）。
- `structural.js` 的 overflow 管线行号为只读静态阅读所得，**未运行**该 Session/serve 路径。
