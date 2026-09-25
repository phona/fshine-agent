# fshine-agent 架构

状态：当前实现基线（回合契约 + 单个 17dz 子 Agent + 平台计划重量反馈）

## 1. 目标

提供一条简单、可恢复的企微财税查询链路，并保证三件事：

1. **真实性**：任何财务结论必须来自本轮真实执行（激活计划 + 至少一次平台调用），不能来自历史重放。
2. **边界**：账套/期间只能来自当前消息，或当前消息明确指代且上下文能唯一解析；旧任务范围不能自动继承。
3. **重量感知**：执行面扩大时用户先看到，超过更高门槛先等确认，反复试探有上限。

```text
企微
  -> Main Pi Agent（fshine-agent）
     ├─ route_current_turn 申报本轮动作（conversation / clarify / platform_query）
     │    · clarify        -> 宿主直接追问，不调用平台
     │    · platform_query -> 宿主用当前消息直接委派子 Agent，结果经 terminate 成为本轮回复
     │    · conversation   -> Main Agent 正常回答
     └─ history tools（search_history / get_messages）按需回溯
        -> Pi 子 Agent（cwd = 17dz-platform）
        -> 17dz-platform Skills / 领域脚本
```

**语义判断归 Main Agent，宿主负责强制。** 不为分流引入第二个模型：那既多一次模型调用，也让上下文更少的模型替上下文更多的模型做判断。宿主做三件确定性的事——校验申报的证据（fail-closed 到澄清）、记录执行凭证、在出口拒绝"申报了实时查询却零执行"的回复。

当前只需要一个领域子 Agent，不引入通用的 subagent registry、复杂结果协议或多 Agent 聚合层。将来增加独立领域时，再抽象注册和路由。

## 2. 组件边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| 企微 channel | 收发消息、用户和会话标识、进度/最终回复 | 领域查询、浏览器自动化 |
| Main Agent | 每回合先申报本轮动作；处理普通对话、组织自然语言回复 | 跳过申报直接回答；把历史财务结论当成本轮结果 |
| 宿主回合校验 | 校验申报的证据、记录执行凭证、出口拒绝零执行的实时查询回复 | 替模型做语义判断 |
| `run_17dz_task` | 校验请求、创建/恢复任务、绑定主会话和用户、调用子 Agent | 解析子 Agent 自然语言并猜流程状态 |
| Pi 子 Agent | 在受信 `17dz-platform` cwd 中加载 Skills，执行领域脚本，返回自然语言 | 替 Main Agent 决定如何向用户回复 |
| `17dz-platform` | 领域脚本、平台适配、登录态和财税数据获取 | 企微会话和 Main Agent 对话编排 |
| SQLite store | principal、会话、子任务和审计记录 | 财务数据源、模型决策 |

计划重量与领域参数由 `17dz-platform` 的纯 CLI 评估和执行门负责。fshine 只保存会话、转发结构化计划、等待企微通知/确认，并把宿主激活凭据交给 CLI；worker 不持有激活密钥。

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
2. Main Agent 先调用 `route_current_turn` 申报本轮动作。账套/期间/搜索词必须逐字来自当前消息，或由当前消息明确指代且上下文能唯一解析；证据不成立就失败关闭为澄清。重复提出的实时数据请求必须判为新查询，不能复用旧助手回答。
3. 闲聊由 Main Agent 回答；账套、客户余额、凭证等实时数据由宿主用当前消息直接委派 `run_17dz_task`；缺少或无法唯一确定账套时，宿主先澄清，不调用平台。
4. 委派工具创建一个只属于当前用户和主会话的新任务。仅显式引用旧任务时才恢复 task ID。
5. 子 Agent 在 `17dz-platform` 中按相关 Skill 执行领域脚本。结果必须来自本轮脚本，不得从源码或历史结果猜测；预算计划由 17dz CLI 评估并逐次绑定。
6. 子 Agent 返回自然语言结果；host 直接采用受信执行结果或进行受限整理，不把旧的 pending 计划重新当成本轮任务。
7. store 记录请求、意图、子 Agent 转录和最终回复；企微发送最终回复。

## 5. 权限与安全

- principal 由可信的企微用户 ID 解析，模型不得改变用户身份或授权配置。
- 任务恢复必须同时匹配 `principalId` 和主会话 ID，不能跨用户或跨会话接管任务。
- 工作目录和 Skills 路径只来自部署配置，并通过路径边界校验。
- credentials 不通过用户消息或模型参数传递；由 `17dz-platform` 的受控运行环境管理。
- Main Agent 不直接执行 `17dz-platform` 命令；命令和脚本选择由子 Agent 的平台 Skills 约束。
- 领域脚本仍必须自行执行账套范围、只读/写权限、用户确认和幂等等业务硬约束；自然语言提示不是安全边界。
- 只读计划通过 `plan evaluate` 计算预计调用数、耗时和范围变化；实际调用绑定激活计划并由平台累计计量，重计划不重置累计用量。
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

当前不做：MCP server/host、Fake MCP 全链路、通用多 Agent registry、跨领域结果聚合、调度和浏览器人工接管。Conversation Log、短期 Context State、按需历史检索和带来源的长期 Memory Records 已接入 fshine；长期整理在后台低频运行，财务任务范围不作为长期授权记忆。
