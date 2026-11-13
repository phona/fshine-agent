# fshine-agent

[![CI](https://gitee.com/phona/fshine-agent/actions/workflow/ci.yml/badge.svg)](https://gitee.com/phona/fshine-agent/actions/workflow/ci.yml)

面向业务人员的编排层：把一条交办经**结构化执行契约**送到执行层，把执行结果如实带回用户。
宿主只保留不可转交的确定性责任（可信身份、任务归属、凭据隔离、如实交付）；执行方法的选择归模型，
业务口径与执行治理归执行层。

```text
渠道消息（企微）/ 命令行消息
  -> Main Agent（理解、委派、汇总）
  -> 委派任务（Worker + 本轮能力快照）
  -> Execution Contract（结构化请求）
  -> 执行层（root + gateway，由 profile 声明）
  -> 结构化结果 / Worker 汇报
  -> Main 回复（渠道或命令行）
```

## 目录

| 目录 | 内容 |
|---|---|
| `packages/agent` | 回合运行时、Pi 驱动、任务归属底账、技能装载与 dummy 执行层适配器 |
| `packages/contracts` | 执行契约（Execution Contract）与渠道/配置接口 |
| `packages/core` | 配置加载与任务底账 SQLite 引擎 |
| `packages/channel-wecom` | 企微机器人 WebSocket 长连接与回复 |
| `apps/server` | 服务入口（`main.ts`）与装配（`server.ts`） |
| `config` | 部署模板（`agent.example.yaml`）与仓内 dummy 面配置（`agent.fixture.yaml`） |
| `scripts` | `ask` 入口、eval 与仓库守卫脚本 |
| `tests` | 测试装置（vitest setup） |
| [`docs`](docs/index.md) | 文档索引（权威决定见 [decision-log](docs/decision-log.md)） |

## 命令

```bash
npm install
npm run ci                           # typecheck + unit（单 checkout 自足）
npm run typecheck                    # tsc --noEmit
npm run test                         # vitest（unit project）

npm run ask -- "帮我查一下 ..."        # 一条消息 → 回复 + 机械证据（真实模型 + 仓内 dummy 执行层）
npm start                            # 企微长连接 server（需 config/agent.yaml + 企微凭据）
```

## 运行（产品面）

### `npm run ask`：一条消息 → 回复 + 机械证据

真实模型 + 仓内 dummy 执行层（`scripts/eval/fixtures/dummy-platform`，真实子进程调用、不触网、不接真实 SaaS）：

```bash
# 凭据放 .env（LLM_API_KEY）；接口地址与模型名缺省取所加载配置的 llm.*
npm run ask -- "帮我查一下 documents 集合、窗口 W202611 的数据"
```

- 缺省加载 `config/agent.fixture.yaml`（仓内 dummy 面，只开放执行层自述为只读的 operation）；
  也可用 `--config=<path>` / `AGENT_CONFIG_PATH` 指向自己的配置（同 `npm start` 的显式入口）。
- 输出：回复 + 机械证据（taskId / requestId / operation / status + dummy 执行层审计行）。
- 任务底账落 SQLite（缺省 `.runtime/state.db`），进程结束后仍在；隔离门 fail-closed，
  profile.root 必须在仓内夹具目录之下。

### `npm start`：企微长连接 → 渠道回复

需要 `config/agent.yaml`（复制 `config/agent.example.yaml` 填写）与真实企微凭据（BotID / Secret）。
仓内未连真实企微验证；渠道回归用**假渠道**（`SdkClientLike` stub）+ 假执行客户端 + 假模型驱动跑
（`apps/server/server.test.ts`，零网络）。

## 测试与评测

- 测试入口：`npm run test`（vitest，unit project；含渠道假体、运行时拒绝路径、重启连续性、
  过渡命名收敛守卫）。
- 评测口径（M4 收口，见 [decision-log §十三](docs/decision-log.md)）：确定性门＝`npm run typecheck` +
  `npm run test`（含 Execution Contract 行为测试与安全不变量指定测试）；用户级评测＝`eval:user`
  （并行分支交付，合并后生效）。`eval:generic-mock` 与真实模型 eval 工作流已随 harness 退役，
  恢复须先有可运行且被测试钉住的 harness。
- 测试与评测只依赖仓内 dummy/假件；真实 SaaS / 真实企微渠道未验证，不作前置条件。

## 上线前必填

| 位置 | 内容 |
|---|---|
| `config/agent.yaml`（复制 `config/agent.example.yaml`；gitignored） | 企微 principal；`llm.*`（接口地址 / key / model）与 `wecom.*`（BotID / Secret）；按接入的执行层声明填写 `contextProfiles.<profileId>.root`、`gateway` 与 `skillRoots`；可选 `store.dbPath`（任务底账，缺省 `.runtime/state.db`） |
| `.env`（可选，兼容旧部署） | 同名环境变量非空值覆盖 `config/agent.yaml`；`AGENT_CONFIG_PATH` 仍只从 env 读 |

`contextProfiles.<profileId>.root` 是受信的执行层工作目录，不由用户输入或模型生成。
