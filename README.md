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
npm run tasks                        # 最近任务列表（只读；缺省读 .runtime/state.db）
npm run tasks -- <taskId>            # 单任务详情：状态 / 原因 / 执行步骤 / 任务结果
npm run tasks -- <taskId> --out <path>  # 导出任务交付件（Markdown；拒绝覆盖既有文件）
npm start                            # 企微长连接 server（需 config/agent.yaml + 企微凭据）
npm run eval:user -- --trials 1      # 用户级黑盒评测（12 用例，真实模型 + 仓内 dummy 夹具）
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

### `npm run tasks`：查看交办过的任务（只读）

不读日志、不跑模型、不触网：直接从任务底账（SQLite）读最近任务与单任务详情。

```bash
npm run tasks                 # 最近任务列表：时间 / 状态 / 摘要 / id（最多 20 条）
npm run tasks -- <taskId>     # 单任务详情：状态 / 失败原因 / 执行步骤 / 任务结果
npm run tasks -- <taskId> --out <path>   # 导出任务交付件（Markdown；可保存/转发）
```

- 状态与失败原因与底账写入时的 `judgeReportedTask` 同语义（已完成 / 失败 / 未执行；
  进行中 = 尚未收尾），查看侧不重算、不新造状态。
- 只读：以 SQLite readonly 打开既有库（不写、不锁写）；库不存在时给空态且不创建文件；
  导出只写用户指定的那一个文件（不写库、不建目录）。
- 导出（P2）：交付件与详情同源逐行一致（任务信息 / 状态 / 执行步骤 / 任务结果 / 限制说明）；
  目标已存在拒绝覆盖（原文件不动）、父目录不存在不自动创建；相对路径按敲命令的目录解析
  （npm 的 INIT_CWD）。退出码：0 成功 / 2 用法与前置错误 / 1 环境与 IO 失败。
- 缺省读 `.runtime/state.db`；`--config=<path>` / `AGENT_CONFIG_PATH` 与 `npm run ask` 同源，
  非空 `DB_PATH` 环境变量同 ask 一样覆盖底账路径。
- 执行步骤按落账顺序列出（底账未存每步时间戳）；「任务结果」为底账持久化的执行层汇报原文
  （Main 给用户的最终回复当前不落库）。

### `npm start`：企微长连接 → 渠道回复

需要 `config/agent.yaml`（复制 `config/agent.example.yaml` 填写）与真实企微凭据（BotID / Secret）。
仓内未连真实企微验证；渠道回归用**假渠道**（`SdkClientLike` stub）+ 假执行客户端 + 假模型驱动跑
（`apps/server/server.test.ts`，零网络）。

## 测试与评测

- 测试入口：`npm run test`（vitest，unit project；含渠道假体、运行时拒绝路径、重启连续性、
  过渡命名收敛守卫）。
- 评测入口：`npm run eval:user`（用户级黑盒评测，12 用例；真实模型 + 仓内 dummy 夹具，与
  `npm run ask` 同源装配；逐样本证据与判据见 `scripts/eval/convergence-r1/README.md`）。
  真实模型 workflow 面：`eval-real.yml`（per-push 1 轮，advisory）与 `eval-nightly.yml`（12×3）——
  **配置就绪 ≠ 持续运行已启用**：两者分别触发于 `main` 的 push/PR 与每日 cron；当前工作线未合入
  `main`、远端 Secrets（`LLM_API_*`）未经本仓验证，故在合入并留档首次真实运行之前，不构成持续保障
  （口径见 `docs/decision-log.md` §十七.4）。
- 测试与评测只依赖仓内 dummy/假件；真实 SaaS / 真实企微渠道未验证，不作前置条件。

## 上线前必填

| 位置 | 内容 |
|---|---|
| `config/agent.yaml`（复制 `config/agent.example.yaml`；gitignored） | 企微 principal；`llm.*`（接口地址 / key / model）与 `wecom.*`（BotID / Secret）；按接入的执行层声明填写 `contextProfiles.<profileId>.root`、`gateway` 与 `skillRoots`；可选 `store.dbPath`（任务底账，缺省 `.runtime/state.db`） |
| `.env`（可选，兼容旧部署） | 同名环境变量非空值覆盖 `config/agent.yaml`；`AGENT_CONFIG_PATH` 仍只从 env 读 |

`contextProfiles.<profileId>.root` 是受信的执行层工作目录，不由用户输入或模型生成。
