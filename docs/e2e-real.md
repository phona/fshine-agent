# 真实 E2E 验收手册

同一套真实用例支持两种入口：

* AI 入口：直接向 fshine-agent 消息处理链发送消息数据。
* 人工入口：通过企业微信向机器人发送同样的消息。

两种入口都必须经过 handler、runtime、MCP Host 和真实 17dz MCP。AI 不得绕过 Agent 直接调用 17dz 页面或数据库。

## 安全边界

默认只执行读查询、凭证校验和 Workflow 预览，不执行真实业务写入。

禁止调用：

    submit_voucher
    submit_voucher_batch
    workflow.confirm

写任务只允许停在 needs_input 或 ready_for_confirmation。

## 前置条件

1. 17dz 已登录，当前账号能看到测试账套。
2. config/agent.yaml 使用真实用户身份，账套范围为 all 或包含目标账套。
3. read-default 的 cwd 指向真实 17dz-platform。
4. 启动 fshine-agent：

    npm start

5. 启动日志应包含 Authentication successful、server_started 和 fakeMcp:false。

## AI 入口消息格式

AI 入口调用与企微相同的 createMessageHandler，只替换消息来源：

    {
      "wecomUserId": "真实用户 ID",
      "conversationId": "real-e2e-20260917",
      "messageId": "e2e-msg-001",
      "chatType": "single",
      "text": "幻辰的应收账款还有多少",
      "receivedAt": "2026-09-17T00:00:00.000Z"
    }

每条消息使用新的 messageId；同一场景的追问复用 conversationId。

AI 运行器需要记录 requestId、tool_calls、参数、状态、错误和最终回复。

## 人工入口

在企业微信单聊机器人中按场景顺序发送消息。等待上一条最终回复后再发下一条，不发送确认提交类消息。

## 场景 A：账套、期间和余额

发送：

    帮我查一下幻辰的应收账款还有多少

期望工具链：

    search_account_sets
    get_current_accounting_period
    get_subject_balance(subjectCode=1122)

期望结果：

    账套：幻州市幻辰机械设备有限公司（as_003）
    期间：202608
    科目：1122 应收账款
    期末余额：686985.49
    来源：科目余额表 / 17dz

不得用凭证净发生额代替期末余额。

再发送：

    幻东机械在幻辰账套还欠多少？

必须调用 get_auxiliary_balance，期末辅助余额应为 686985.49。

## 场景 B：凭证发生额和分页

发送：

    幻辰 2026 年 8 月应收账款发生了哪些变化？

此时允许调用凭证或明细事件工具，但回复必须明确是发生额，不是期末余额。

再发送：

    列出幻辰 2026 年 8 月的凭证

如果返回 nextCursor，再发送：

    下一页

断言 cursor 原样传递、没有重复页面、账套和期间保持一致。

## 场景 C：知识资源

AI 入口读取以下已授权资源：

    17dz://domains/voucher/mechanisms
    17dz://domains/voucher/templates
    17dz://domains/voucher/contract-schema

禁止读取 auth.json、selectors.js、执行源码和未声明路径。

## 场景 D：凭证校验，不提交

发送：

    帮我准备一张幻辰 8 月 31 日收到 100 元汇票抵应收的凭证，先校验和预览，不要提交。

期望状态为 validate 成功或 ready_for_confirmation；不得产生凭证号、docId 或保存动作。

再发送一条借贷不平的测试请求：

    准备一张借方 100、贷方 80 的测试凭证，只做校验，不要提交。

期望返回 CONTRACT_INVALID 或等价的借贷不平错误。

## 场景 E：NEEDS 和恢复

准备会触发辅助档案歧义的输入，发送：

    准备这批汇票，但先不要提交。

期望返回 needs_input、needId、code 和面向会计的 question。

补充答案后应进入 ready_for_confirmation，不得自动进入 succeeded，不得调用 workflow.confirm。

## 重启恢复

Workflow 到 ready_for_confirmation 后：

1. 停止 fshine-agent 或 17dz MCP 进程。
2. 用相同配置重新启动。
3. 调用 workflow.status(taskId)。

必须保留 taskId、status、revision、needs、preview、input 和幂等关系。

## 结果判定

通过条件：

* 余额问题调用余额工具；
* 发生额问题调用事件工具；
* 数据回复带账套、期间、范围和来源；
* Resource 只读且受 allowlist 保护；
* Workflow 能返回 NEEDS、预览并恢复；
* 没有 submit 或 confirm；
* requestId 能追到全部工具调用。

失败条件：

* 用凭证净发生额回答期末余额；
* 用历史上下文猜账套或期间；
* 没有当前调用却声称已重新核实；
* Resource 越过 allowlist；
* 未确认就执行 Workflow；
* 重启后任务丢失或幂等失效。

## 本地和真实 E2E 的边界

    npm run test:e2e
    本地、进程内 Fake MCP、无网络、无真实写入

    人工企业微信验收
    真实企微、真实 Agent、真实 MCP，只做读、校验和预览

两种入口使用同一组业务断言，区别只有消息来源。
