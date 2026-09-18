# fshine-agent 功能规格

状态：当前实现基线

架构：[`v0-architecture.md`](v0-architecture.md)

## 1. 用户与价值

用户是使用企微机器人的内部员工。Main Agent 负责对话；涉及 17dz 实时财税数据时，委派 `run_17dz_task` 给 `17dz-platform` 子 Agent。子 Agent 的自然语言结果由 Main Agent 理解后回复用户。

## 2. 范围内能力

| 能力 | 用户行为 |
|---|---|
| 账套查询 | 按名称或描述查找账套；结果不唯一时向用户澄清 |
| 当前期间 | 返回授权账套的当前会计期间 |
| 凭证查询 | 按账套和期间查询、汇总凭证，支持用户继续追问或翻页 |
| 账套/科目查询 | 查询科目、辅助核算和账套上下文 |
| 登录态感知 | 上游登录失效时，说明需要运维处理，不编造查询结果 |
| 多轮任务 | 用 `taskId` 继续同一个子 Agent 任务，用自然语言处理补充信息 |

## 3. 范围外能力

```text
创建、编辑、删除、提交或审批凭证
发票、申报、付款等税务写操作
面向外部客户的渠道
完整 RBAC、审批流、长任务调度和浏览器人工接管
知识库/RAG、自动学习和主动巡检
通用多 Agent 编排和跨领域结果聚合
```

## 4. 核心流程

### 4.1 查询凭证

```text
员工：“查一下幻晟本期的凭证。”
  -> Main Agent 判断需要实时数据
  -> run_17dz_task(request="查一下幻晟本期的凭证")
  -> 17dz 子 Agent 读取相关 Skill 并执行领域脚本
  -> 返回自然语言结果
  -> Main Agent 回复账套、期间和凭证摘要
```

Main Agent 不得凭历史上下文猜账套 ID、期间、凭证或金额。结果不完整时必须如实说明，并可把用户的“下一页/继续”作为同一任务的补充请求。

### 4.2 账套不唯一

子 Agent 或 Main Agent 发现多个候选时，向用户列出可见候选并请求选择；不得猜测。用户选择后，Main Agent 携带同一 `taskId` 继续任务。

### 4.3 需要补充信息

子 Agent 可以直接返回自然语言问题。Main Agent 决定原样转达、补充上下文后重试，或结束当前对话。代码不通过关键字正则推断 `needs_input`、`preview` 或 `blocked` 等状态。

### 4.4 无权限或上游不可用

```text
用户请求未授权账套
  -> 领域脚本/平台能力拒绝
  -> Main Agent 说明无权访问，不泄露其他账套信息

17dz 登录失效或脚本失败
  -> 子 Agent 如实返回失败原因
  -> Main Agent 给出简洁降级说明
```

## 5. 功能规则

- 每个企微请求都有 `requestId`；每个委派任务都有绑定当前主会话和 principal 的 `taskId`。
- 涉及实时 17dz 数据时必须调用 `run_17dz_task`，不得用模型记忆或历史回答代替查询。
- `run_17dz_task` 的 `request` 是自然语言任务；继续任务时传入之前返回的 `taskId`，新任务不复用旧 ID。
- 子 Agent 返回自然语言。Main Agent 负责决定回答、追问或再次委派，代码不包装领域流程状态。
- 数据回复应说明使用的账套、期间和数据范围；不确定或未取得的信息必须明确标注。
- 用户可见错误不得包含堆栈、绝对路径、凭据、内部提示词或其他未授权数据。
- 所有子 Agent 会话和任务都必须在超时、取消或完成后释放运行资源。

## 6. 必要配置

```yaml
principals:
  wecom:<user-id>:
    accountSetScope: all
    enabled: true

contextProfiles:
  17dz:
    root: /path/to/17dz-platform
    skillRoots: [".agents/skills"]
    workerTimeoutMs: 600000
```

`root` 必须是部署时确定的 `17dz-platform` 目录；`skillRoots` 只能指向 root 内的相对路径。模型和用户不能通过消息覆盖这些配置。

会话键为 `wecomUserId + conversationId`。服务目前以同步回复为主，具体渠道和子 Agent 超时以运行配置为准。

## 7. 验收标准

1. 启用的用户可以通过企微查询授权账套并得到真实结果。
2. 涉及实时数据的请求都会调用 `run_17dz_task`，而不是编造答案。
3. 子 Agent 在正确的 `17dz-platform` cwd 加载 Skills；不会使用用户提供的任意 cwd。
4. 多候选账套会请求澄清，不会猜测。
5. 用户补充信息后可以使用原 task ID 继续，且其他用户不能接管该任务。
6. 子 Agent 的追问会被 Main Agent 以自然语言转达，普通成功结果也直接转成自然语言回答。
7. 登录失效、脚本错误、空结果、超时和取消都有安全降级行为。
8. 只读场景不会调用写操作；写操作如未来启用，必须由领域脚本实施确认和幂等硬闸。
9. 审计能从企微消息关联到主会话、taskId 和最终回复，不泄露秘密。

## 8. 交付顺序

```text
1. Main Agent 与 Pi driver
2. run_17dz_task 及任务持久化/会话恢复
3. 17dz-platform cwd 与 Skills 路径校验
4. 领域脚本真实查询与子 Agent 提示
5. 企微 channel 联调
6. AI 入口与企微抽样验收
```
