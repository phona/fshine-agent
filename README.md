# fshine-agent

基于 Pi 的企微财税助手。Main Agent 负责理解用户请求和组织对话；需要访问 17dz 实时数据时，通过 `run_17dz_task` 委派给一个位于 `17dz-platform` 工作目录的 Pi 子 Agent。子 Agent 使用 `17dz-platform` 的 Skills 和领域脚本执行任务，并以自然语言返回结果，Main Agent 决定直接回答、向用户追问，或继续同一个子任务。

```text
WeCom
  -> Main Pi Agent (fshine-agent)
  -> run_17dz_task
  -> Pi subagent (cwd = ../17dz-platform)
  -> domain Skills/scripts
  -> natural-language result
  -> Main Agent reply / follow-up / resume
```

## 目录

| 目录 | 内容 |
|---|---|
| `packages/agent` | Main Agent、`run_17dz_task` 委派工具和 Pi 子 Agent adapter |
| `packages/contracts` | 主流程、会话、任务和渠道接口 |
| `packages/core` | 配置加载与 SQLite 审计/任务存储 |
| `packages/channel-wecom` | 企微机器人 WebSocket 长连接与回复 |
| `apps/server` | 服务装配入口 |
| `docs` | 架构、功能规格、实施决策和手工验收说明 |

## 命令

```bash
npm install
npm run typecheck
npm test

npm start                         # 启动企微长连接服务
AGENT_CONFIG_PATH=xxx npm start  # 覆盖配置文件路径
npm run smoke:wecom              # 企微长连接冒烟测试
npm run smoke:commit:mock        # mock 保护下两步写链路冒烟（非 mock 拒跑）
```

## 引用消息与后台任务

企微原生引用会与本次正文一起交给 Planner，正文确认与引用内容分别处理。
`FSHINE_WORKER_DISPATCH_MODE` 默认 `inline`；设为 `background` 后，Worker 执行期间用户可以继续提问、查询或取消任务，结果和文件独立主动推送。同一会话的 Planner 回合仍串行，平台并发默认仍为 1。

首版尚未生产验收；不支持运行中 steer、暂停恢复或重启后自动重跑。配置和回滚见 [会话交互方案](docs/interactive-session-plan.md#9-首版实现对账2026-10-24)。

## mock 联调（平台侧 fake 保护）

`.env` 设 `EXECUTION_EXECUTOR=mock`（默认已设）后，幻账平台执行器被替换为 mock
应答器：不开浏览器、不触网，gate 矩阵/commit 令牌/审计照真生效，落账写进
mock 状态文件（默认 `<17dz-platform>/.runtime/mock-state.json`，删文件即重置）。
此模式下落账全链路默认放开（写的是假状态）；切回真平台后落账默认拒绝，
须显式 `FSHINE_REAL_COMMIT=1`。

```bash
npm run acceptance                 # mock 保护下全量验收（含 5.x 写链路、6.x 污染用例）
EXECUTION_EXECUTOR= npm run acceptance  # 临时切真平台只读回归（真环境变量优先于 .env）
```

本项目不包含 MCP 主链路；本地测试使用脚本化 Pi driver，不代表生产模型调用。

## 上线前必填

| 位置 | 内容 |
|---|---|
| `.env` | `WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`LLM_API_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` |
| `config/agent.yaml` | 配置企微 principal；在 `contextProfiles.17dz.root` 填写 `17dz-platform` 根目录，并确认 `skillRoots` 指向其 Skills 目录 |

`contextProfiles.17dz.root` 是受信的子 Agent 工作目录，不由用户输入或模型生成。子 Agent 的会话通过任务 ID 恢复，并绑定到发起它的企微用户和主 Agent 会话。
