# pure-pi spike：只用 pi-agent-core 的智能体

目的：验证「系统提示词 + 平台协议」本身能把一个通用模型带到哪一步。不经过 fshine 的
runtime / driver / 编排层，不 import 任何 `@fshine/*`。

## 形态

```
run.ts          CLI：建平台快照 -> 装配 Agent -> 逐轮喂用例 -> 落 JSON
prompt.ts       系统提示词（协议纪律 / 业务背景 / 输出纪律）
cases.ts        C1/C2/A2/D2 + SELF 的轮次脚本
tools.ts        pi 原生工具装配 + 平台计划门的宿主放行签名
compaction.ts   pi 原生压缩（shouldCompact / generateSummary / estimateTokens）
platform.ts     平台定位、快照、mock execution.config.json、计划激活
```

### 用了 pi 的什么

- `@earendil-works/pi-agent-core` 的 `Agent`（唯一的会话主体）。
- `createBashTool` / `createReadTool` / `createWriteTool` / `createEditTool` +
  `NodeExecutionEnv`（pi 自带的 shell/文件能力，命令原样执行，没有 fshine 的工具描述）。
- 原生压缩：`shouldCompact`、`generateSummary`、`estimateContextTokens`、`estimateTokens`。
- `@earendil-works/pi-ai` 的 `createModels` / `createProvider` / `openAICompletionsApi`
  接 OpenAI 兼容端点（模型连接方式与 pi 生态一致，不经过 fshine 驱动）。

### 明确没有用 fshine 的什么

- 没有 import 任何 `@fshine/*`，也没有调用 `packages/agent/src/*`。
- 没有 `search_history` / `get_messages`，没有 execution-facts / context-state /
  long-memory 注入。
- 没有 compaction sidecar（摘要是裸的 pi 摘要消息）。
- 没有 reply-exit 清洗 / 执行语言指纹。
- 没有 fshine 的计划门拦截、预算梯子、计划命令解析：计划是否放行完全由平台
  `bin/17dz plan evaluate` 的 `decision` 决定。

## 平台与 mock

- 网关位置：`config/agent.yaml`（或 `AGENT_CONFIG_PATH`）里 active profile 的
  `root` + `gateway`，与 `tests/e2e/harness.ts` 的 `gatewayExecPath` 同一口径。
  该文件是 gitignored 的部署配置；本仓提交的 `scripts/eval/eval.agent.yaml` 是
  dummy 夹具，只作兜底。
- 隔离：给了 `PURE_PI_PLATFORM_SRC` 就用 `git archive HEAD` 建快照，网关、cwd、
  状态文件都在快照/临时目录里，真平台仓零改动。
- mock：平台 2026-11 起 `EXECUTION_EXECUTOR` 只读仓库根的 `execution.config.json`
  （`packages/...` 见平台 `src/lib/local-config.js` 的优先级契约），env 不再是配置
  通道。harness 在快照里写这份配置（`EXECUTION_EXECUTOR=mock` + 独立状态路径），
  同时仍在子进程 env 里保留 `EXECUTION_EXECUTOR=mock` 以对齐题面环境。
  **只设 env 不会让平台进 mock**——这是本 spike 踩到的第一个口径差。

### 计划门的宿主职责（最小面）

平台 `plan.activate` 需要宿主持有的 HMAC 密钥：

- `decision=notify`：平台已记录规模，harness 以 `notification-delivered` 放行。
- `decision=confirm`：harness 记住 pending plan；只有下一条用户消息被标记为确认
  （D2 的 `确认继续`）时，才以 `user-confirmed` 放行。
- `decision=execute`：平台直接 active，无需宿主动作。
- `decision=stop`：不放行，模型自己看到退出码 3 与 JSON。

宿主只读平台 decision 并做协议要求的签名；档位判定、阈值、账本全在平台。

## 运行

```bash
export TMPDIR=...                       # 运行目录
export LLM_API_KEY_FILE=...             # 密钥文件，只读进进程 env，不落盘
export LLM_API_BASE_URL=...             # OpenAI 兼容端点
export LLM_MODEL=...
export PURE_PI_PLATFORM_SRC=...         # 平台 checkout（用于建快照）
export PURE_PI_WORKDIR=...              # 可选：产物目录
export PURE_PI_CONTEXT_WINDOW=32000     # 可选：压缩阈值用的上下文窗口
export PURE_PI_COMPACT_RESERVE_TOKENS=8000
export PURE_PI_COMPACT_KEEP_RECENT_TOKENS=8000
export PURE_PI_TURN_TIMEOUT_MS=180000
node --import tsx scripts/spike-pure-pi/run.ts --case=SELF
node --import tsx scripts/spike-pure-pi/run.ts --case=A2,C1,C2,D2
```

`--case=SELF` 是单轮自检：一次 operation list、一次 plan evaluate（execute/active）、
一次 query（completed + 真实余额）、一条用户可读回复。

产物是一个 JSON：每个用例的每轮 `user` / `reply` 原文、工具调用（截断）、计划
observation、宿主放行记录、压缩事件。默认写到 `PURE_PI_WORKDIR`。

## 用例来源

`cases.ts` 的轮次结构与 incidents 来自仓史里 17dz 真平台版探针
（`git show 7654e2a^:scripts/probe-real-agent.ts` 的 C1/C2/A2/D2）。HEAD 的
`scripts/eval/cases.yaml` 同名条目已端口到 dummy 域（collection/window/record），
与 17dz 网关对不上，故不直接采用；账套名按 17dz mock 种子做同形改名
（幻辰财税→黔隆财税、幻辰实业有限公司→黔隆实业有限公司），线程数、歧义关系、
期间不变。D2 的扇出规模由平台自己的预算线判到 confirm（12 次查询），没有改门限。

## 已知边界

- 压缩在每个用户回合开始前用 pi 的 `estimateContextTokens` + `shouldCompact` 判断，
  超阈值才调 `generateSummary`。阈值 = `PURE_PI_CONTEXT_WINDOW`（默认 32000）减去
  `reserveTokens`（默认 8000）。窗口故意低于常见模型窗口，是为了在长用例里真的压一次。
- 压缩后留下的助手消息仍带着压缩前那次调用的 provider usage。pi 的
  `estimateContextTokens` 优先信 usage，于是会把已经缩短的转录仍判成超阈值、每一轮都再压一次。
  harness 在写回尾巴时丢掉 usage（usage 不进模型正文），下一轮按字符估算。
- 宿主在 `notify` 档直接放行，用户看不到独立的通知帧；通知文案由模型转述。
- `confirm` 档的「确认继续」只在脚本本体的最后一轮追加一次。
- 快照不带平台的 untracked `.runtime`/`tmp`，mock 状态从种子重新开始。
