# fshine-agent 架构

状态：当前实现基线（Main Agent + 单个 17dz 子 Agent）

## 1. 目标

提供一条简单、可恢复的企微财税查询链路：Main Pi Agent 负责理解请求和对话编排；需要真实 17dz 数据时，调用唯一的 `run_17dz_task` 工具，把完整任务交给 17dz 子 Agent。

```text
企微
  -> Main Pi Agent（fshine-agent）
  -> run_17dz_task(request, taskId?)
  -> Pi 子 Agent（cwd = 17dz-platform）
  -> 17dz-platform Skills / 领域脚本
  -> 自然语言结果
  -> Main Agent 决定回答、追问或继续委派
```

当前只需要一个领域子 Agent，不引入通用的 subagent registry、复杂结果协议或多 Agent 聚合层。将来增加独立领域时，再抽象注册和路由。

## 2. 组件边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| 企微 channel | 收发消息、用户和会话标识、进度/最终回复 | 领域查询、浏览器自动化 |
| Main Agent | 理解用户意图、决定是否委派、组织最终自然语言回复 | 直接读取 17dz 工作区、猜测实时数据 |
| `run_17dz_task` | 校验请求、创建/恢复任务、绑定主会话和用户、调用子 Agent | 解析子 Agent 自然语言并猜流程状态 |
| Pi 子 Agent | 在受信 `17dz-platform` cwd 中加载 Skills，执行领域脚本，返回自然语言 | 替 Main Agent 决定如何向用户回复 |
| `17dz-platform` | 领域脚本、平台适配、登录态和财税数据获取 | 企微会话和 Main Agent 对话编排 |
| SQLite store | principal、会话、子任务和审计记录 | 财务数据源、模型决策 |

## 3. 子 Agent 运行边界

`contextProfiles.17dz.root` 是部署配置提供的受信绝对路径，例如 `/home/fictional-user/fictional-projects/fictional-execution-layer`。它不来自用户输入，也不允许由模型修改。`skillRoots` 必须是该 root 内的相对路径，并在启动任务前通过 realpath 校验。

子 Agent 使用官方 `pi-coding-agent` 的 headless `AgentSession`，由 adapter 设置：

- `cwd`：配置的 `17dz-platform` 根目录；
- Skills：配置的 `skillRoots`；
- session：使用任务 ID 恢复上下文；
- deadline / abort：由 Main Agent 请求和 worker timeout 统一控制。

子 Agent 返回给工具调用方的是自然语言文本。Main Agent 不通过正则或自定义状态 JSON 解析它：如果子 Agent 需要信息，Main Agent 可以把问题转达给用户；用户补充后，携带原任务 ID 再调用 `run_17dz_task`。

## 4. 请求流程

1. 企微 channel 接收消息，得到不可变的用户 ID、会话 ID 和消息 ID。
2. Main Agent 判断是否需要实时 17dz 数据。需要时必须调用 `run_17dz_task`，不能凭历史对话猜账套、科目或余额。
3. 委派工具验证 request，解析受信 context profile，并创建或恢复一个只属于当前用户和主会话的任务。
4. 子 Agent 在 `17dz-platform` 中按相关 Skill 执行领域脚本。实时结果必须来自脚本，不得从源码或上下文猜测。
5. 子 Agent 返回自然语言结果。Main Agent 选择直接回答、向用户追问，或用同一 task ID 继续任务。
6. store 记录请求、子 Agent 转录和最终回复；企微发送最终回复。

## 5. 权限与安全

- principal 由可信的企微用户 ID 解析，模型不得改变用户身份或授权配置。
- 任务恢复必须同时匹配 `principalId` 和主会话 ID，不能跨用户或跨会话接管任务。
- 工作目录和 Skills 路径只来自部署配置，并通过路径边界校验。
- credentials 不通过用户消息或模型参数传递；由 `17dz-platform` 的受控运行环境管理。
- Main Agent 不直接执行 `17dz-platform` 命令；命令和脚本选择由子 Agent 的平台 Skills 约束。
- 领域脚本仍必须自行执行账套范围、只读/写权限、用户确认和幂等等业务硬约束；自然语言提示不是安全边界。
- 审计记录不得写入 API key、密码、未授权账套数据或完整敏感页面内容。

## 6. 任务和会话

```text
conversation_session
  sessionId, principalId, channelConversationId, updatedAt

platform_task
  taskId, parentSessionId, principalId,
  workerMessages, createdAt, updatedAt
```

`taskId` 是跨轮继续子 Agent 的 opaque handle。新任务不复用旧 task ID；不存在的任务不能恢复，且每次恢复都重新校验 principal 和父会话。

## 7. 时间和失败处理

- 企微回复保持同步体验，但 worker timeout 必须是明确配置项。
- 外层 `AbortSignal` 取消时，子 Agent 必须停止当前回合并释放 session 资源。
- 子 Agent 空回复、模型错误、脚本失败或超时都作为工具错误返回；Main Agent 负责给用户一条安全、自然语言的降级说明。
- 不把子 Agent 的内部堆栈、绝对路径、凭据或原始页面内容发送给用户。

## 8. 明确不做

当前不做：MCP server/host、Fake MCP 全链路、通用多 Agent registry、跨领域结果聚合、写凭证工作流、审批、调度、浏览器人工接管和长期记忆。
