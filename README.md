# fshine-agent

Tax Agent V0:企微员工通过机器人只读查询有权限的账套数据(经 17dz read MCP)。

- 设计文档:`docs/`(架构 / 功能规格 / MCP 契约 / 实施决策)
- 部署参数:复制 `.env.example` 填 `​.env`(秘密);账套授权与 MCP 进程配置在 `config/agent.yaml`

## 目录

| 目录 | 内容 |
|---|---|
| `packages/contracts` | 信封、错误码、tool、host↔runtime、仓库、渠道接口(P0 冻结) |
| `packages/mcp-fake` | Fake17dzMcpServer + 契约测试 |
| `packages/core` | 配置加载 + SQLite 审计存储 |
| `packages/channel-wecom` | 企微回调验签 + 主动推送 |
| `packages/mcp-host` | stdio host:生命周期、scope 预检、信封解析、重试 |
| `packages/agent` | Agent runtime(Pi adapter)+ 会话澄清状态 |
| `apps/` | 装配入口(集成阶段) |

## 命令

```bash
npm install          # 依赖统一在根声明
npm run typecheck
npm test             # vitest run

npm start            # 启动服务(企微长连接;需先填 .env 与 config/agent.yaml)
D17Z_USE_FAKE=1 npm start            # 17dz 未就绪时,接 Fake server 全链路演示
AGENT_CONFIG_PATH=xxx npm start      # 覆盖配置文件路径(默认 config/agent.yaml)
npm run smoke:wecom  # 企微长连接冒烟:连接→订阅成功→断开
```

## 上线前必填

| 位置 | 内容 |
|---|---|
| `.env` | `WECOM_BOT_ID` / `WECOM_BOT_SECRET` / `LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` |
| `config/agent.yaml` | principal 键换成真实 `wecom:<你的企微 UserID>`,`accountSetIds` 填真实授权账套;接真 17dz 时填 `mcpProfiles.read-default.cwd` |
