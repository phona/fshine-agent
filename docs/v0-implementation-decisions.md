# V0 实施决策记录

状态：当前实现基线。架构边界见 [`v0-architecture.md`](v0-architecture.md)，用户行为见 [`v0-functional-spec.md`](v0-functional-spec.md)。

## 1. 技术栈与仓库形态

- Node 24+、TypeScript strict、ESM；单 npm 项目，不使用 workspaces。
- Main Agent 使用 `pi-agent-core` 的轻量 driver。
- 17dz 子 Agent 使用官方 `pi-coding-agent` 的 headless `AgentSession`，由 adapter 固定 cwd、Skills、模型和生命周期。
- 依赖统一声明在根 `package.json`，子 Agent 不在运行时安装依赖。
- SQLite 通过 repository 接口保存 principal、会话、任务和审计数据。

## 2. 目录职责

| 目录 | 职责 |
|---|---|
| `packages/agent` | Main Agent、Pi driver、`run_17dz_task` 和子 Agent adapter |
| `packages/contracts` | Agent、task、session、channel 和配置类型 |
| `packages/core` | 配置加载与 SQLite store |
| `packages/channel-wecom` | 企微智能机器人 WebSocket 长连接 |
| `apps/server` | 生产装配和进程生命周期 |
| `docs` | 设计和验收基线 |

## 3. 委派接口

主 Agent 只暴露一个 17dz 委派工具：

```ts
run_17dz_task({
  request: "查询幻辰账套 2026 年 8 月的应收账款余额",
  taskId?: "继续同一任务时填写"
})
```

工具结果只包含 `taskId` 和子 Agent 的自然语言 `text`。不定义额外的 `completed`、`needs_input`、`preview` 或 `blocked` 协议，也不使用中文正则猜测状态。Main Agent 自己决定是否回答用户、转达问题或继续调用工具。

任务存储负责 transcript、绑定和恢复：任务只能由创建它的 principal 和主会话恢复；用户补充信息时复用 task ID，新请求创建新任务。

## 4. 子 Agent 配置

```yaml
contextProfiles:
  17dz:
    root: /path/to/17dz-platform
    skillRoots: [".agents/skills"]
    workerTimeoutMs: 600000
```

`root` 和 `skillRoots` 是可信部署配置。运行时解析 root 的 realpath，确保每个 skill root 位于 root 内；禁止由请求参数或模型覆盖。子 Agent 使用任务 ID恢复 transcript，并在结束、取消或异常时 dispose session。

## 5. 企微接入

- 使用企业微信智能机器人 WebSocket 长连接模式；凭证只从 `.env` 读取。
- 收到文本后构造统一消息，交给 Main Agent；最终回复通过 stream 帧发送。
- 群聊消息剥离机器人 @ 前缀；事件回调以外的消息类型按 channel 能力处理。
- 进度消息只能描述当前动作，不得把模型自由生成的进度当作事实或结果。
- 单会话消息串行处理；回复长度和渠道预算遵循 channel 配置。

## 6. 预算、取消和审计

- Main Agent 和子 Agent 都有明确的回合 deadline；子 Agent timeout 不得无限延长主请求。
- 外层 `AbortSignal` 必须传入子 Agent，并调用底层 `agent.abort()`。
- 任务记录至少包含 task ID、principal、父会话、Pi transcript 和时间；日志不得记录 API key、密码、内部提示词或未授权数据。
- 对领域脚本的登录失效、网络失败、空结果和超时，保留安全错误信息供 Main Agent 组织回复。

## 7. 领域安全边界

领域脚本是实时财税数据和副作用的边界。它必须执行账套范围、只读/写能力、用户确认、幂等和凭据保护；Main Agent 的提示词和自然语言结果不能替代这些硬约束。

V0 只验收只读查询。任何未来写路径都必须先实现领域侧的 dry-run、确认记录和幂等语义，并单独验收，不通过增加 Main Agent 文本状态分类来实现。

## 8. 测试与工作方式

- `npm run typecheck` 和 `npm test` 是本地完成门。
- 子 Agent 的 cwd、Skill 发现、task 恢复、取消和自然语言透传必须有自动化测试。
- 脚本化 Pi driver 只用于单元测试；真实平台回归从 AI 消息入口开始，企微只做通道抽样。
- 不维护第二套平台协议；平台行为由 `17dz-platform` 的 Skills 和领域脚本定义。
