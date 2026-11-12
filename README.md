# fshine-agent

[![CI](https://gitee.com/phona/fshine-agent/actions/workflow/ci.yml/badge.svg)](https://gitee.com/phona/fshine-agent/actions/workflow/ci.yml)

通用编排层：负责可信身份、渠道与会话、上下文、委派、预算与计划门、确认、审计、进度与结果呈现。执行层经声明面接入，通用层代码零改动。

```text
WeCom
  -> Main Agent (编排层)
  -> 委派工具（声明面接入）
  -> 执行层子 Agent（工作目录由 profile.root 声明）
  -> 执行层 Skills / 领域脚本
  -> 结构化结果 / 自然语言回复
  -> Main Agent reply / follow-up / resume
```

## 目录

| 目录 | 内容 |
|---|---|
| `packages/agent` | Main Agent、委派工具和执行层子 Agent adapter |
| `packages/contracts` | 主流程、会话、任务和渠道接口 |
| `packages/core` | 配置加载与 SQLite 审计/任务存储 |
| `packages/channel-wecom` | 企微机器人 WebSocket 长连接与回复 |
| `apps/server` | 服务装配入口 |
| `config` | 部署配置模板 |
| `scripts` | 验收、探针与 eval 脚本 |
| `tests` | 单测与 e2e 夹具 |
| [`docs`](docs/index.md) | 文档索引 |
| [`docs/execution-layer-interface.md`](docs/execution-layer-interface.md) | 执行层声明面接口规格 |
| [`docs/execution-layer-admission.md`](docs/execution-layer-admission.md) | 执行层接入准入门槛 |

## 命令

```bash
npm install
npm run ci                           # typecheck + unit + generic-mock（单 checkout 自足）
npm run typecheck
npm run test

npm start                            # 启动企微长连接服务
AGENT_CONFIG_PATH=xxx npm start     # 覆盖配置文件路径
npm run smoke:wecom                  # 企微长连接冒烟测试
npm run smoke:commit:mock            # mock 保护下两步写链路冒烟（非 mock 拒跑）
```

## 引用消息与后台任务

企微原生引用会与本次正文一起交给 Planner，正文确认与引用内容分别处理。
`FSHINE_WORKER_DISPATCH_MODE` 默认 `inline`；设为 `background` 后，Worker 执行期间用户可以继续提问、查询或取消任务，结果和文件独立主动推送。同一会话的 Planner 回合仍串行；**平台并发不由宿主限制**——并发容忍与健康/退避归执行层自己的限流与熔断（宿主准入闸只做 `maxQueue` 待办深度背压，见 [执行层准入清单](docs/execution-layer-admission.md)）。

首版尚未生产验收；不支持运行中 steer、暂停恢复或重启后自动重跑。配置和回滚见 [会话交互方案](docs/interactive-session-plan.md#9-首版实现对账2026-10-24)。

## mock 联调（历史存档：执行层已删除 mock executor）

> 2026-11-13 裁定：`EXECUTION_EXECUTOR=mock` 已随执行层删除——不再使用、不恢复、不替代。本节只作历史存档，不是当前可用路径；V0 本地试用见下一节 `npm run demo`（仓内 dummy 平台）。

`.env` 设 `EXECUTION_EXECUTOR=mock`（默认已设；**执行层治理变量权威名以该执行层声明为准**，现行平台已改回 `EXECUTION_*` 前缀，旧 `DZ_*` 别名已移除）后，执行层网关把执行器替换为 mock 应答器：不开浏览器、不触网，gate 矩阵 / commit 令牌 / 审计照真生效，落账写进 mock 状态文件（默认 `<profile.root>/.runtime/mock-state.json`，删文件即重置）。该开关由**执行层自己读取**：编排层不读它，也不据此判"这个部署允不允许写"——写能不能真落地（含真平台落账的授权 / dryrun 提示）由执行层自己的门裁决并给出拒绝或 warning，宿主只如实转述。

```bash
npm run acceptance                  # mock 保护下全量验收（含写链路、污染用例）
EXECUTION_EXECUTOR=mock npm run acceptance  # mock 模式（真执行层变量优先于 .env，设为 mock 显式覆盖）
```

本项目不包含 MCP 主链路；本地测试使用脚本化 Pi driver，不代表生产模型调用。

## V0 本地试用（本地测试平台）

在干净 checkout 上复制一条完整的本地试用路径：**真实 Main + 真实 Worker + 仓内 dummy 测试平台**（不触网、不接真实 SaaS），跑四轮冻结业务对话（核对本月单据 → 上月对比 → 指代复核 → 交付），全过程留痕。默认连跑 **3 次独立试用**（各自从干净的库与夹具状态起跑，同一份语料），全部结果都保留、不挑成功的展示。

```bash
npm install
# LLM：复制 .env.example 为 .env 并填 LLM_API_KEY（接口地址与模型名缺省取 config/agent.demo.yaml）
npm run demo
# 只跑 1 次：npm run demo -- --trials=1
```

每次运行重置 `.runtime/demo/`，产物（每次试用一套）：

| 文件 | 内容 |
|---|---|
| `.runtime/demo/trials/trial-N/transcript.md` | 四轮原文（用户语料 / 计划通知 / 回复）+ 机械证据（requestId / taskId / 平台调用 / dummy 审计行） |
| `.runtime/demo/trials/trial-N/turns.jsonl` | 逐轮结构化记录（委派事件、taskId、平台调用、审计行、阶梯、耗时） |
| `.runtime/demo/trials/trial-N/state/audit.jsonl` | 执行层（dummy 夹具）原始审计行——每次调用的执行事实 |
| `.runtime/demo/trials/trial-N/demo.db` | 该次试用的会话库（与其它试用互不影响） |

说明：

- 本路径的执行层是仓内 dummy 夹具（`scripts/eval/fixtures/dummy-platform`），每次平台调用都是**真实子进程**（`bin/dummy`）；跑的是本地测试数据，**真实 SaaS / 真实业务平台未接入**。
- 本路径不设置也不依赖任何 mock executor / `EXECUTION_EXECUTOR` 变量；执行层由 `config/agent.demo.yaml` 的 profile（root + gateway）选择，并有 fail-closed 隔离门兜底。
- `npm start`（企微长连接服务）需要真实企微凭据（BotID / Secret）与真实执行层；本次未验证。

## 上线前必填

| 位置 | 内容 |
|---|---|
| `config/agent.yaml`（复制 `config/agent.example.yaml`；gitignored） | 企微 principal；`llm.*`（接口地址 / key / model）与 `wecom.*`（BotID / Secret）；按接入的执行层声明填写 `contextProfiles.<profileId>.root`、`gateway` 与 `skillRoots`；可选 `host.*` 宿主运行参数 |
| `.env`（可选，兼容旧部署） | 同名环境变量非空值覆盖 `config/agent.yaml`；`AGENT_CONFIG_PATH` 与 eval 工具面变量（`LLM_JUDGE_MODEL`）仍只从 env 读 |

`contextProfiles.<profileId>.root` 是受信的执行层工作目录，不由用户输入或模型生成。执行层子 Agent 的会话通过任务 ID 恢复，并绑定到发起它的企微用户和 Main Agent 会话。
