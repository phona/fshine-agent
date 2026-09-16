# V0 实施决策记录

状态:P0 已定,实现以本文为准。边界红线见 `v0-architecture.md`,功能口径见 `v0-functional-spec.md`,协议真相见 `17dz-mcp-spec.md` v0.5。

## 1. 技术栈与仓库形态

- Node ≥ 24 + TypeScript(strict,`noUncheckedIndexedAccess` 开启),ESM。
- 单 npm 项目 + 路径别名(`@fshine/<pkg>`),不做 workspaces;`vitest` 跑全部测试,`tsx` 直接运行 TS。依赖统一声明在根 `package.json`,由主 agent 一次安装,**subagent 不得自行 npm install**。
- 目录所有权(subagent / 后续开发只写自己目录):

| 目录 | 内容 | owner |
|---|---|---|
| `packages/contracts` | 信封/错误码/tool 类型、host↔runtime、仓库、渠道接口、配置类型 | P0 冻结 |
| `packages/mcp-fake` | Fake17dzMcpServer + 契约测试 | W1-A |
| `packages/core` | 配置加载 + SQLite 审计存储 | W1-B |
| `packages/channel-wecom` | 企微智能机器人 WebSocket 长连接(收消息 + respond 回复) | W1-C |
| `packages/mcp-host` | stdio host、scope 预检、信封解析、重试 | W2-D |
| `packages/agent` | Agent runtime(Pi adapter)+ 会话澄清状态 | W2-E |
| `apps/` | 装配入口(main) | 集成阶段(主 agent) |

## 2. 配置命名

统一用架构文档的 **`mcpProfile`**(`config/agent.yaml` 的 `mcpProfiles`)。functional-spec §6 示例中的 `mcpServer: 17dz-read` 以此为准废弃。

## 3. 企微接入模式(V0:智能机器人 · WebSocket 长连接)

- 采用企业微信「智能机器人」的**长连接 API 模式**(官方文档:智能机器人长连接 developer.work.weixin.qq.com/document/path/101463)。URL 回调与长连接互斥,V0 只做长连接;自建应用回调模式整体 deferred。
- 凭证:`WECOM_BOT_ID` + `WECOM_BOT_SECRET`(长连接专用 Secret)。**无公网 IP/域名要求,无消息加解密**,不存在 Token/EncodingAESKey。
- **传输实现用 `ws` 库**(与官方 aibot-node-sdk 一致),经 `NodeWebSocketImpl` 注入 adapter:Node 24 内置 undici WebSocket 对 openws 网关握手即失败(2026-09 实测);另实测服务端对关闭握手会回非标帧(opcode 3),仅影响 stop 后的日志,不影响运行期收发。
- 订阅/回复响应的 `errcode` 在**帧顶层**(官方真机);adapter 同时兼容 `body.errcode`(测试夹具形状)。
- 连接:`wss://openws.work.weixin.qq.com`,订阅 `aibot_subscribe`,30s 心跳(`ping`);单机器人仅允许一条连接,断线指数退避重连(1s 起、30s 封顶);`disconnected_event`(被新连接踢掉)触发重连。
- 收发:`aibot_msg_callback` 收消息(仅 text),回复走 `aibot_respond_msg` 并**透传回调的 req_id**;**回复必须是 stream 类型**(单帧 `finish:true` + 完整内容,支持 markdown)——respond 通道不接受 `msgtype:text`(真机 errcode 40008,官方 SDK 亦无 replyText 方法);群聊消息剥离 @机器人 前缀;其余事件回调 V0 忽略。
- **阶段进度帧**:埋点事实渲染(runtime `onStep` + host 重试钩子),拒绝模型自由叙述(时序盲区 + intent 幻觉);`action.progress` 允许模型提供 ≤60 字意图短语(只许说即将做什么,严禁报结果)。adapter 节流(≥3 秒、单回合 ≤4 帧,含 ack 共 ≤6 帧)后推 `finish=false` 帧,最终 `finish=true` 整体替换全部过程内容;限频 30 条/分钟安全。
- **会话历史有界重放**(OpenClaw 转录+压缩思路的轻量版):会话状态携带 `history`(仅用户消息 + 最终回复;最多 10 条 / 12k 字符,单条截 2k),每轮注入模型上下文,支持追问与指代;工具结果不重放。system 提示声明"历史仅供参考,以最新消息为当前任务"。跨轮意图还原(澄清选候选、翻页)仍走结构化状态。
- 限制:每会话 30 条/分钟(V0 不排队,失败记单行日志);文本回复 ≤2048 字节(UTF-8 安全截断)。
- **userid 明文前提**:`from.userid` 在机器人创建者为超级管理员时才是明文,否则是加密 userid,V0 的 principal(`wecom:<userid>`)无法映射。创建/配置机器人必须用超管身份;转明文的自建应用对接 deferred。
- 流式回复、模板卡片、主动推送(`aibot_send_msg`)、welcome 消息:全部 deferred。
- 75 秒渠道预算保留为体验上限(长连接回复窗口实际是 24 小时),由 host 侧控制,不在渠道层。

## 4. 预算与重试

- 单次工具调用尝试预算 60s(`requestTimeoutMs`);`PROFILE_BUSY`/`TIMEOUT` 退避按契约 `retryAfterMs`,退避不占尝试预算(17dz spec §11.6),但**渠道总预算 75s 是硬约束**——实现为:一次完整尝试 + 仅当首次快速失败(如 PROFILE_BUSY 秒回)时的一次短重试;重试耗尽前先看渠道预算。
- LLM/回合预算:模型单次调用超时 120s(kimi-for-coding 实测思考可超 45s,曾致偶发"查询失败"),回合预算 150s——进度帧让等待可感知后,黑盒式 75s 硬限已放宽;超时最终帧仍会收场。
- 并发:V0 host 不排队,并发调用直接下发,`PROFILE_BUSY` 按契约退避(面向接口,不对 17dz 内部实现做假设)。
- 连接:`initialize` 后校验 `serverInfo.specVersion === '0.5'`,不符拒绝使用该 server 并报运维;每次(重)连接后必须重新 `tools/list`。

## 5. 会话与澄清

- session key = `wecomUserId + conversationId`,由 host 推导 sessionId 存 `conversation_session`。
- 澄清候选账套列表存 `conversation_session.state`,TTL 5 分钟(`sessionTtlMs`);过期后重新走搜索,不复活旧候选。
- 数据回复必须带账套名、期间(如使用)、来源(`meta.source`)、取回时间(`meta.retrievedAt`)(验收 #10)。

## 6. 工作方式

- subagent brief 必须自包含:指定阅读文档章节、目录所有权、可依赖的 contracts 类型、完成门。
- 契约测试(client 视角,mcp-fake 产出)同时是 mcp-host 的验收套件。
- git:主 agent `git init`;**任何 agent 不自动 commit**,由用户决定提交时机。
- 拿不到真实凭据时用测试双胞胎开发(如企微 API 基址可注入 stub),真实联调放 P5/P6 收尾。

## 7. V1 写路径前置:idempotencyKey 与 confirmed 的权责切分(2026-09-16 议定)

协议里"确认能力"全部属于上层;17dz 只提供两个机械行为:**默认干跑**(confirmed 缺省 false,零副作用)与**按 key 去重**(台账 = (tool, key, 规范化契约))。

| 职责 | 归属 |
|---|---|
| key 的生成与留存(host 生成 UUID、绑定业务任务,LLM 永不经手) | **host** |
| 确认流程(dry-run 预览 → 用户点头 → 确认记录) | **host**(17dz 从不接触人) |
| 幂等台账(同 key 重放返回快照,绝不重执行;绑定点状态机) | 17dz |
| confirmed 默认闸(默认 false) | 17dz |

台账必须在 17dz 侧:副作用发生地才知道"到底写没写进去"(retryable/bound 绑定点语义);重试跨进程,只有执行方去重才能让同 key 重试安全(同 Stripe 幂等 key 形状)。key 必须调用方生成:只有调用方能区分"重试"与"两笔合法的相同凭证"。

**V1 host 待办清单(写路径开工时的必答题)**:

1. 生成:每个写任务一个 UUID,从 requestId/任务派生,生成即落库;
2. 留存:`任务 ↔ key ↔ 契约` 映射进审计库;batchKey 与 `${batchKey}:${index}` 对应由 host 维护;
3. 复用纪律:超时/续跑必须同 key;恢复前先 `get_submission_status` 探结果;`unknown / may_have_succeeded` 禁止换新 key;
4. 确认链:key → dry-run 预览 → 用户确认记录,三者绑定落库(承载于企微会话);
5. 硬闸:`confirmed=true` 而无对应用户确认记录 → 发往 server 前直接拒绝;confirmed 不作为模型可自由支配的参数(schema 只暴露 false,由 host 按确认记录注入);
6. 契约测试:Fake server 补写语义(幂等状态机、dry-run 零占用、batch 子键),host 闸门行为同步加测。

**V0 已落地的只读硬闸**:McpHost 增加 `allowedTools` 白名单(缺省只读五件套),`tools/list` 声明名单外工具即拒绝连接并标记 profile 不可用——"V0 无写路径"从配置约束升级为代码强制,误配 write server 也无法生效。
