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
```

本项目不包含 MCP 主链路；本地测试使用脚本化 Pi driver，不代表生产模型调用。

## 上线前必填

| 位置 | 内容 |
|---|---|
| `.env` | `WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`LLM_API_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` |
| `config/agent.yaml` | 配置企微 principal；在 `contextProfiles.17dz.root` 填写 `17dz-platform` 根目录，并确认 `skillRoots` 指向其 Skills 目录 |

`contextProfiles.17dz.root` 是受信的子 Agent 工作目录，不由用户输入或模型生成。子 Agent 的会话通过任务 ID 恢复，并绑定到发起它的企微用户和主 Agent 会话。
