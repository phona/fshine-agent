# 执行层接口定义（fshine-agent 侧，v1）

> 地位：本文是 fshine-agent 与任何一个执行层之间的**唯一接口定义**。
> 业务实体、口径、校验、读回判定永远属于执行层，本文只定义两层之间
> 交换的形状、顺序与失败语义，不复制任何业务字段。
> 读法：每一节都写清**生产者 / 消费者 / 缺失时 / 版本变化**四项。
> 缺失时只允许两种处置：`fail-closed`（拒绝并留痕，绝不降级猜测）
> 或节内明文写出的降级；未写明的，一律按 fail-closed 处理。

## 0. 分层与命名归属

| 层 | 归属 | 例子 |
| --- | --- | --- |
| 编排层 fshine-agent | 通用机制：身份、上下文、任务、计划门、确认、续跑、审计、呈现 | 本仓 `packages/`、`apps/` |
| 执行层 | 业务实体与口径、能力声明、命令语法、提案结构、领域记忆、执行步骤、业务校验、保存与读回判定 | 财税实例：fictional-execution-layer；通用夹具：本仓 `scripts/eval/fixtures/dummy-platform/` |
| 通用夹具 | **不是**执行层实例，只是证明编排层可换执行层的测试替身 | 网关名 `bin/generic`、操作名 `dummy.*`，**不得**以任何执行层实例的名字命名 |

命名纪律：

- 通用层（夹具、文档、测试名、网关入口）出现执行层实例名即为越界。
  通用夹具的网关是 `bin/generic`（指向 `bin/dummy`），不是任何实例的网关名。
- 执行层实例自己的网关名只属于该实例：财税实例是 `bin/example-gateway`，
  只出现在该实例的 profile（`contextProfiles.<id>.gateway`）与该实例
  的文档里，不进入通用层代码、通用夹具与通用文档。
- 工具名同理（C3）：委派工具名是模型可见协议面，宿主缺省中性（`run_task`）；
  实例已发布的协议名（如财税集成 `run_<instance>_task`）由该实例 profile 的
  `toolName` 声明保持连续，不进入通用层代码、通用夹具与通用文档。

## 1. Profile / 网关声明（受信配置）

- **生产者**：部署管理员（配置文件 `config/agent.yaml` 的
  `contextProfiles.<id>`，见 `config/agent.example.yaml`）。
- **消费者**：宿主 spawn 路径与文本识别路径（§2）；称谓字段的消费者是
  Main Agent 系统提示词（`buildSystemPrompt`，经 `createTaxAgentRuntime`
  的 `executorLabel` 注入）。
- **字段**（三件套随 profile 走，缺一不可；称谓一件可选，缺省中性）：
  - `root`：执行层仓根绝对路径；worker 的 cwd 即 root。
  - `gateway`：相对 root 的网关调用形式，如财税实例 `bin/example-gateway`、
    通用夹具 `bin/generic`。模型绝不传入、绝不由模型文本派生。
  - `skillRoots`：相对 root 的运行态技能面（如 `.agents/skills-serve`）。
  - `executorLabel`（C2 新增，可选）：该执行层子 Agent 的称谓，进 Main
    Agent 系统提示词的委派句；如财税实例 `执行层子 Agent`。模型绝不传入。
- **校验**（加载时）：`gateway` 经 `validateGatewayInvocation`——相对
  路径、无父级 `..`、无绝对路径、无 shell 元字符，任一不满足即加载失败；
  `executorLabel` 非空、≤32 字符、无控制字符（模型可见文本，畸形值加载期挡下）。
- **缺失时**：spawn 路径 `gatewayExecPathForProfile` fail-closed 抛错，
  不回退任何缺省网关名；文本识别路径见 §2 的遗留过渡；`executorLabel`
  缺失 = 宿主中性缺省（`DEFAULT_EXECUTOR_LABEL`，不含任何实例名），
  实例称谓由该实例自己的 profile 声明，宿主不静默取实例名。
- **版本变化**：新增 profile 字段必须向后兼容（旧 profile 缺新字段时
  按节内缺失语义处理，不得静默取实例名作缺省）。

## 2. 文本识别：网关名从 profile 来（不再从常量来）

- **生产者**：profile 的 `gateway`（§1）。
- **消费者**：
  - serve-gate 首词规则：bash 首 token 是否为网关可执行文件
    （可带路径前缀），`ServeGateOptions.gateway` 注入；
  - plan 令牌定位：`parsePlanCallsCommand(command, gateway?)`，
    网关名后紧跟完整 `plan` 令牌才算计划提交；
  - 错误文案 correctForm：`planDraftExample(gateway)` /
    `planFileExample(gateway)`，网关名由调用方传入。
- **构造**：`gatewayTextPatterns(gateway)`（`platform-contract.ts`）
  对网关名做正则转义后派生首词与 plan 正则；网关名本身不允许含
  正则或 shell 元字符（§1 校验已挡），转义只是纵深。
- **缺失时（C7b 起 fail-closed）**：未注入 gateway 即抛错（`resolveGatewayText`
  / `gatewayExecPath` 统一拒绝，理由中性、指引部署补声明），宿主不再持有任何
  实例网关名缺省——`GATEWAY_INVOCATION` 常量已退役。§2 的穿线（驱动层把
  profile.gateway 透传 serve-gate、plan 解析、诊断渲染与全部 spawn 路径）
  是它的前置，已于 C7a 落地。

## 3. Operation list（能力清单，唯一权威）

- **生产者**：执行层网关 `<gateway> operation list --json`。
- **消费者**：宿主的 label / args 规格 / access 语义 / protocol 角色
  四张派生表（`operation-labels.ts`），以及计划门与 serve 门。
- **形状**（每条 operation）：`name`（注册名，调用唯一依据）、
  `domain`、`command`、`access`（read / scratch / write 等）、
  `script`（执行层内部路径，宿主不直接执行，只作审计引用）、
  `effects`、`executor`、`est_seconds`、`weight`、`args`（位置参数与
  flag 的声明名与样式）、`serve`（mode×access 矩阵）、`protocol`
  （如 `proposal.create` / `proposal.commit`，无则 null）、`label`。
- **缺失时**：清单拿不到 / 某 operation 不在表里 / `plan` 列取不到 →
  fail-closed：一律要求计划、不挂 label、不做参数摘要、不拦截提案，
  执行层门禁照旧兜底。宿主绝不另立 operation 名单。
- **版本变化**：新增 operation 只加行；改名即新 operation，旧名调用
  应得 `not_found` 族错误，不得静默别名。

## 4. Plan schema 与 plan evaluate（计划门）

- **生产者**：执行层 `plan --schema`（PlanDraft 唯一来源）与
  `<gateway> plan evaluate --task-id <id> --stdin`。
- **消费者**：宿主 `evaluateAndActivatePlan`（`plan-runtime.ts`）。
- **输入**：`{ calls: [{ operation, args }] }`，`operation` 必须是
  §3 注册名，`args` 为 JSON 可序列化值数组；顶层未声明字段
  执行层以确定性错误响亮拒绝，绝不静默忽略。
- **输出（PlanEvaluation）**：
  - `planId`、`version`、`decision`（`execute` / `notify` / `confirm` /
    `stop`）、`reasonCode`、`status`；
  - `estimate: { calls, seconds, weight }` —— **weight 必填**：
    本张计划声明的总权重（各 call 权重之和），执行层在评估时
    已算出即下发；本接口把它立为契约，不改档位语义、不改执行端门
    （执行层可另行声明更严硬上限并在调用处复核）；
  - `delta`（新增 calls 摘要）、`cumulative`（任务累计）、
    `budget`（可选回执：已用 / 容量 / 剩余，仅作呈现）、
    `summary` / `noticeText` / `scopeSummary`（执行层提供的安全
    用户可见范围摘要，宿主只做长度与控制字符卫生，不改写业务措辞）。
- **宿主档位叠加（更严为准）**：
  宿主用通用策略 `decideBudgetTier({ calls, seconds, weight })`
  （`budget-policy.ts`——通用预算协议缺省档位线的单一真相源，
  缺省阈值 calls 2/10/20/50、seconds 60/180/600/1800、weight
  6/18/60/180，`grantLevel` 作乘数扩容）算出宿主档，与执行层
  `decision` 取更严一档；同档时宿主档优先保留原 reasonCode 措辞。
  执行层档始终保留作防线，宿主档只做叠加，绝不绕过执行层档；
  双门并行期宿主档只收紧不放宽。
- **缺失时**：`estimate.weight` 缺失、非有限数、为负 → fail-closed：
  `evaluateAndActivatePlan` 抛错，不激活、不降级为仅 calls/seconds
  裁档。`decision` 非四档之一、stdout 非合法 JSON → 同样抛错；
  仅 exit 3 且 stdout 能解析出合法 `decision` 时视为结构化 stop 裁决。
- **版本变化**：`estimate` 新增字段向后兼容；`weight` 一旦立约即
  不得再去掉，去掉即视为契约违约（宿主 fail-closed 可发现）。

## 5. Proposal schema 下发接口（平台下发、宿主消费，第 2 包已落地）

- **生产者**：执行层，经 `operation list --json` 的 `proposalSchema` 列
  下发，且只在 `protocol === 'proposal.create'` 的那一行带出：
  财税实例带 `src/voucher/proposal.schema.json` 的内容（`proposal.js`
  导出的 `proposalSchema`，单一来源仍是该 schema 文件）；
  通用夹具带 `dummy.cjs` 内嵌的 proposal schema
  （`additionalProperties: false`，上限 50 条）。
  其他 operation 的本列一律为 null，宿主不读。
- **消费者**：宿主提案创建拦截与复核（`proposal-runtime.ts`、
  `proposal-review.ts`、`operation-labels.ts` 的
  `loadProposalSchema` / `parseProposalSchema`）。
  宿主只消费四样东西，**不复制、不解析业务字段**：
  ① 哪个 operation 扮演 `proposal.create` / `proposal.commit`
  （§3 `protocol` 列）；② payload 是不透明文件（宿主持有
  proposalId + 通用确认元数据，不解析、不校验、不重渲染业务内容）；
  ③ 提案状态查询的返回形状（`proposalId`、`status`、
  `createdAt`、`expiresAt`、`expired`）；
  ④ proposal.create 行的 `proposalSchema` 原值：宿主只做“是不是
  非空普通对象”这一形状卫生检查（非对象 / 数组 / null 即非法），
  然后原样透传给隔离复核回合，**不读、不校验、不缓存任何业务字段**。
  复核的 schema 槽因此不再是 null——第 2 包起，schema 位传真实下发值。
- **缺失时（fail-closed，不降级）**：`protocol` 列缺失 → 不拦截
  （fail-closed 到“这不是提案调用”，门与平台继续裁决）；
  但一旦进入提案创建路径，schema 缺失 / 非法（清单拿不到、行里
  没有 `proposalSchema`、值不是非空普通对象）→ 提案创建直接失败，
  不发确认码，事件记 `proposal_review_schema_missing`，**绝不降级
  为“只比摘要与信封”**。机械复核（`mechanicalReview`）同样把
  schema 缺失 / 非法判为不一致，与摘要为空、dry-run 未完成同族。
- **版本变化**：schema 演进由执行层版本号或 schema 内容本身驱动；
  宿主不缓存业务字段，执行层改 schema 不需要宿主改代码。

## 6. Proposal 创建 / 提交 / 读回

- **生产者**：执行层网关（serve 法域）与宿主确认链（host 法域）。
- **顺序**（缺一不可）：
  1. 干跑创建（dry-run create）：执行层生成 proposal，TTL 30 分钟
     （执行层可配，缺省 30 分钟），返回 `proposalId` + 通用摘要；
     宿主只存不透明 proposalId 与通用确认状态。
  2. 用户确认：宿主持有确认状态，确认码与提案绑定（HMAC 提案 /
     提交令牌，服务器签发，见 §7）。
  3. 提交：执行层按令牌提交，提交前读回、提交后读回；读回不足
     （`PROPOSAL_VERIFY_SHORT` 或读回差额）→ 宿主记
     `committed_unverified`（“已落账、读回不足、需人工核对”，
     任务结果记 failed、意图记 committed 以防二次提交），
     绝不把读回不足说成成功。
- **缺失时**：令牌缺失 / 变形 / 过期 / 与提案不匹配 →
  `PROPOSAL_TOKEN_UNTRUSTED`，提交拒绝；提案过期 →
  `PROPOSAL_EXPIRED`，须重建；提案状态损坏 →
  `PROPOSAL_STATE_CORRUPT`，拒绝并留痕。任一情形宿主都不代为重建。
- **版本变化**：令牌算法与 TTL 由执行层声明；宿主只校验“令牌由
  执行层签发且未过期”，不解析令牌业务内容。

## 7. RESULT 信封、退出码、错误码家族

- **生产者**：执行层网关（stdout 末行）。
- **形状**：`RESULT {v:1, op, status, data, error}`，`status` ∈
  `completed` / `failed` / `needs_input` / `not_found`。
  `not_found` 是确定性无数据，**绝不洗成零值**。
- **退出码**：0 = 结构化成功（含 stop 裁决以外的完成态）；
  1 = 失败；2 = 用法错误；3 = 网关 / 提案拒绝（未注册、serve 矩阵、
  令牌、过期、状态损坏等）。宿主判据是码与信封，不嗅探消息文本。
- **错误码家族**（宿主只判族，不判文案）：
  - 平台不可用族：`AUTH_*`、登录态、`NEEDS_LOGIN`、
    `PLATFORM_TIMEOUT` 等 → 宿主不在编排层做冷却/前置拦截，也不合成
    PLATFORM_UNAVAILABLE 终稿；失败按既有失败链路如实上行。并发容忍与
    健康/退避由**执行层自己**的限流与熔断实现（见
    `docs/execution-layer-admission.md` A12），宿主准入闸只保留
    `maxQueue` 待办深度背压；
  - 选择类：`ACCOUNT_SET_AMBIGUOUS` / `ACCOUNT_SET_NOT_FOUND`
    等 → 宿主机械组装澄清问题，模型不为状态转换发音；
  - 终局快路径：`PERIOD_NO_DATA`、`ASSISTANT_NOT_FOUND` /
    `ASSISTANT_AMBIGUOUS` → 早停终结，须带齐渲染数据否则不挂；
  - 输入类、数据三态、兜底码各有其族，互不混用。
  平台新增码时只在唯一适配层（`platform-contract.ts`）加码，
  不在编排层各处分身。
- **缺失时**：无信封 / 信封非法 → 宿主视为网关失败，fail-closed，
  不把自由文本当数据答案。

## 8. 调用上下文与实执行门

- **生产者**：宿主在每次编排调用上带上协议材料（计划绑定与签名令牌）。
  不是模型。宿主不声明执行法域：不写域 env，不在命令模板上加法域 flag。
- **字段**：
  - 计划绑定（`EXECUTION_PLAN_ID`）与签名令牌随该次调用走。执行层从这些
    材料在不在，自己判断这次是不是被编排驱动；
  - `EXECUTION_ALLOW_REAL=1`：执行层实执行授权（缺它 = 触平台执行被拒，
    `REAL_EXECUTION_NOT_ALLOWED`，纯本地计算不受影响）；
  - ~~`FSHINE_REAL_COMMIT=1`：宿主真写落账授权~~ **该门 2026-11-08 退役**：
    写能不能真落地归执行层，宿主不再持有写授权位；落账授权/拒绝由执行层自己的
    commit 门给出，宿主只如实转述（见 `docs/debt-ledger.md` 的 D-075/D-197 重登记节）。
- **正交性**：实执行授权与「这次调用带不带协议材料」互相独立。mock 之下
  实执行门不可达。宿主侧不再叠一道 serve 令牌门。
- **缺失时**：
  - 旧描述作废：不再有「宿主置 `EXECUTION_SERVE=1` + 网关铸造并校验
    `EXECUTION_INVOCATION`，缺合法令牌则 serve 调用一律拒绝」。调用上下文
    随调用走，没有单独的 serve 令牌信封要由宿主或网关铸造；
  - 执行层若自己的实现仍把域 env 或 `--mode` 当准入，缺了由执行层响亮拒绝，
    宿主不补这道声明；
  - `EXECUTION_ALLOW_REAL` 未设为字面量 `1`：触平台执行被拒
    `REAL_EXECUTION_NOT_ALLOWED`，纯本地计算（scratch / mock）不受影响；
  - 一律 fail-closed，不以“本地测试”或“模型已确认”为由放行。
- **命名**：执行层治理接口统一用 `EXECUTION_*` 前缀，宿主自用参数用
  `FSHINE_*` 前缀（写授权类开关不再有宿主侧代表——归执行层自己声明），
  通用夹具只认执行层接口名作别名；旧前缀已全量清零，不留别名 shim。

## 9. Mock 契约（归属与隔离）

| Mock | 归属 | 测什么 | 不测什么 |
| --- | --- | --- | --- |
| 通用 mock（本仓 `scripts/eval/fixtures/dummy-platform/`） | fshine 的测试夹具 | 编排协议：operation list、plan、proposal、信封、退出码、每案状态隔离 | 任何执行层实例的业务语义与真实平台兼容性 |
| 执行层自有 mock（如 执行层的 `EXECUTION_EXECUTOR=mock`） | 执行层自己的测试替身 | 该执行层的集成：网关门、令牌、审计仍走，平台脚本被替身替换 | 编排层的通用性（它只证明这一个实例） |

- **隔离**：通用 mock 的状态文件（state / plans / proposals / audit）
  按案隔离，删除即重置；执行层 mock 的状态文件与种子只属于该执行层，
  不得被通用层引用。两者不得互相冒充对方的证据。
- **缺失时**：通用 mock 缺失 → generic-mock 评价直接失败，不回退
  到执行层实例；执行层 mock 缺失 → 该执行层集成测试响亮失败
  （`MOCK_STATE_MISSING` / `OPERATION_NOT_MOCKED`，exit 3），不静默走真平台。

## 10. 遗留过渡与断点（本轮收尾后仍剩下的）

| 遗留项 | 位置 | 断点（何时删） |
| --- | --- | --- |
| ~~`GATEWAY_INVOCATION` 缺省~~（**已退役**，C7b） | 无——常量已删；`resolveGatewayText`/`gatewayExecPath` fail-closed（未声明有效 gateway 即抛中性错），渲染面（C7a 穿线）与 spawn 面（`gatewayExecPathForProfile`）全部经显式注入 | 无断点：实例网关名唯一来源 = 部署的 `contextProfiles.<id>.gateway` 声明 |
| spawn 路径的旧回退 | `plan-runtime.ts` 默认 runner、`context.ts` 默认提案 runner：未声明 gateway 时回退旧值 | profile 必填 gateway 的配置校验落地后删除回退，改为 fail-closed |
| `run_<instance>_task` 工具名实例值 | 财税部署的 `contextProfiles.<id>.toolName` 声明（C3 起）；宿主侧 `RUN_EXECUTION_TASK_TOOL` 已为中性缺省 `run_task`，`extractDelegationToolResultEvents` 经 `runner.tool.name` 注入认名 | 无断点：工具名经 profile 声明注入，宿主不持实例缺省；`该任务参数过渡别名` 过渡别名已随 C3 退役（docs-reality tripwire 盯绝迹） |
| `执行层子 Agent` 称谓实例值 | 财税部署的 `contextProfiles.<id>.executorLabel` 声明（C2 起）；宿主侧 `DEFAULT_EXECUTOR_LABEL` 已为中性缺省，不含实例名 | 无断点：称谓经 profile 声明注入（`buildSystemPrompt`），宿主不持实例缺省；注入实例称谓时提示词与参数化前逐字节相同（D-122 golden） |
| 协议形状解析中的实例痕迹 | `plan-runtime.ts` 的 PlanDraft `{calls}` 形状解析（协议形状，非业务逻辑）、`error-codes.ts` 中个别实例操作名示例 | 仅当实例协议本身演进时随协议改，不为改名而改名 |
| 宿主侧的业务词兜底 | `error-codes.ts` 的 `{hint}` 兜底字符串（平台全域携带 correctForm 后即删，见该文件注释） | 平台全域携带 correctForm 后删除 |

> 本文档是接口定义，不是实现报告。实现是否符合本文，以
> `docs/execution-layer-interface.md` 为准绳逐项核对，见收尾报告。
> 环境变量的完整清单（生产者 / 消费者 / 默认值 / 缺失行为、删除清单）见
> 附录 `docs/environment-variables.md`。执行层自有的机器本地 / 凭据 /
> 浏览器路径面变量归执行层仓文档，附录只留一行指向。

## 11. 生产装配接线（第 2 包，2026-11-04）

- **复核驱动注入**：生产装配（`apps/server/assembly.ts`）必须向
  `createContextTaskRunner` 注入 `proposalReviewTurn`，实现为
  `reviewProposalWithDriver(contextModelDriver, input)`——隔离回合、
  无工具、超时与字节上限见 `proposal-review.ts`。
  未注入不再是“记一条 `proposal_review_skipped` 日志就继续”：
  `createProposalViaGateway` 在复核位缺失时直接失败，事件记
  `proposal_review_required`，不发确认码。`proposal_review_skipped`
  事件自此删除，任何代码不得再发它。
- **schema 取问**：装配同时注入 `proposalSchemaLoader`
  （即 `loadProposalSchema`，按 profile 的 root 与 gateway spawn
  `operation list --json`）；`createProposalViaGateway` 未注入时
  用同一默认加载器，不存在“无加载器即跳过 schema”的路径。
- **步数帽端到端**：步数帽不在决策函数里才成立，它在真实 worker
  驱动会话（`pi-coding-driver.ts` 的 `onAllowedBash`）里计数：
  第 51 次放行时送一次 wind-down steer，且只送一次；证据见
  `packages/agent/src/production-wiring.test.ts` 的脚本化 worker
  会话证明（51 次放行 → steer 恰好 1 次，50 次 → 0 次）。
- **交接文件端到端**：续跑时宿主在委派前先读
  `<platformRoot>/tmp/<taskId>/handover.json`（`context.ts` 的
  prepare 阶段），去重合并按精确键（operation + args），已记的调用
  不二次计数；文件缺失 = 交接不可用（事件 `task_handover_missing`，
  仍可凭转录续跑，不凭空编一个）。损坏的分级恢复见 §13（2026-11-04
  裁定后，取代本条旧的“不硬阻塞、须另行裁定”表述）。证据见同一测试
  文件的续跑证明。

## 12. B4 审计结论（第 1 包收尾核查，2026-11-04）

- 计划解析是协议形状，不是业务逻辑：`plan-runtime.ts` 的
  `PlanCall { operation, args }` 只校验 JSON 形状（calls 为数组、
  每项为对象、args 为数组、可序列化），不持 operation 允许名单、
  不解释任何业务字段。操作名合法性由执行层 `plan evaluate`
  与 §3 清单裁决，宿主不复核业务。
- 凭证专用写路径已不存在：C 波删除的 legacy 落账执行器
  （`apps/server/commit.ts`）无残留代码路径；现写路径只有
  §6 的提案创建 / 提交 / 读回通用协议。
- 残留的业务词 token 均为注释、示例或历史说明，不是逻辑：
  `operation-labels.ts` 的归一示例（域前缀剥离的举例）、
  `plan-runtime.ts` / `serve-gate.ts` 注释里的实测记录、
  `platform-contract.ts` 关于已删 legacy 执行器的历史注。
  为改名而改名会破坏历史记录的可读性，故保留，见 §10 表。
- `run_<instance>_task` 工具名实例值不再是宿主常量（C3）：宿主缺省中性
  （`RUN_EXECUTION_TASK_TOOL` = `run_task`），财税部署经 profile 的
  `toolName` 声明保持已发布工具协议连续；`该任务参数过渡别名` 过渡别名
  同批退役（tripwire 盯绝迹，§0、§10）。
- `执行层子 Agent` 称谓不再是宿主常量（C2）：宿主缺省中性
  （`DEFAULT_EXECUTOR_LABEL`），财税部署经 profile 的 `executorLabel`
  声明保持已发布行为逐字节一致（D-122 golden 钉死注入值与改前相等）。

## 14. 执行层准入清单与第二执行层证明（第 4 包，2026-11-04）

- 准入清单见 [execution-layer-admission.md](execution-layer-admission.md)：
  一个执行层接进 fshine 必须交齐 A1–A14（profile/网关、operation list、
  plan schema、plan evaluate 含 weight、proposal schema 下发、提案创建/
  提交/读回、RESULT 信封、退出码与错误码家族、serve 令牌与实执行门、
  自己的 mock、自己的记忆、自己的熔断/缓存、自己的 skill 路由示例、
  状态隔离），缺一项就不算接通。
- 第二证明域是库存（stock），夹具位置
  `scripts/eval/fixtures/stock-platform/`，网关 `bin/stock`，操作名
  `stock.*`，不是生产域，不进 `packages/` / `apps/`；证明判据是
  fshine 生产代码改动为 0（`git diff --name-only <基线> -- packages apps`
  为空），只改夹具域、测试/评价脚本、配置与文档。
- 本节与准入清单有冲突时，以准入清单的 A1–A14 为准，本文 §§1–13
  的形状定义不变。

## 13. 交接损坏的 Main 分级恢复（第 2 包后续裁定，2026-11-04）

> e2e 归属（通用 vs L4 集成）不在本文件展开，见 [e2e-ownership.md](e2e-ownership.md)：
> CI 只认 typecheck + unit + generic-mock，`tests/e2e` 全部按 L4 集成与通用
> 分开标，L4 集成证据不得冒充通用证据。

原则：交接损坏由 Main 兜底，不要什么都让人介入；只有确实恢复不了、
推进不了的东西才进入人工介入。异常码就是决策依据（`task-handover.ts`
的 `HandoverReadCode`，`context.ts` 的 `resolveHandoverRecovery`）。

| 异常码 | 含义 | Main 恢复分支 | 事件 |
| --- | --- | --- | --- |
| `handover_ok` | 文件可用 | 按交接续跑（原有去重合并） | `task_handover_resumed` |
| `handover_missing` | 文件不存在（从未写成，不是损坏的证据） | 只凭转录续跑；新请求本身就是下一步 | `task_handover_missing` + `task_handover_recovered`（level `transcript_only`） |
| `handover_corrupt_json` | 存在但 JSON 解析失败 | 丢弃文件内容（不做部分解析）、只凭转录重建；转录在场就继续 | `task_handover_corrupt` + `task_handover_recovered`（level `transcript_rebuilt`） |
| `handover_version_mismatch` | JSON 合法但 version 不是当前版本 | 同上；不做版本迁移、不猜字段 | 同上 |
| `handover_schema_invalid` | JSON 合法、版本对，但必填字段/调用形状不对（文件存在但读失败也归入此类） | 同上 | 同上 |

重建的依据与边界（必须如实说清，不夸大）：

- 转录在场 = 任务条目的 workerMessages、结果原文、已执行调用清单
  任一非空。转录消息本身已随续跑进入 worker 上下文，旧的已执行调用
  因此仍可见；交接文件丢弃后，去重合并的范围重置为本轮起——旧调用
  不再由交接文件保证不二次计数，这是丢弃的真实代价，文档不掩盖它。
- 已确认意图与结果不依赖交接文件：意图住在 changeIntents 库、结果
  住在任务条目，交接丢失不影响确认码路径；损坏恢复绝不因此重发
  确认码、绝不重复提交。
- 人工介入的唯一条件：交接损坏族 + 转录也无法重建（转录消息、结果
  原文、已执行调用记录全空）。此时 Main 不调 worker、不写新交接、
  不发确认码、不重复提交，只返回结构化 needs（缺：转录消息、任务
  结果原文、已执行调用清单、下一步的确定依据、待确认提案状态），
  任务条目原样不动供人工核对。事件 `task_handover_blocked`。
- 缺失（missing）不适用 blocked：从未写成的交接没有“丢失的状态”
  可言，新请求即下一步；只有“写过又坏了”且转录也无时才 blocked。
  这是 missing 与损坏族在恢复链里的实质区别，不是口头区分。
