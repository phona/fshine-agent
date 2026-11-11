# 执行层准入清单（fshine-agent 侧，v1）

> 地位：本文是任何一个执行层接进 fshine-agent 之前必须交齐的清单。
> 它是 `docs/execution-layer-interface.md` 的准入面：接口定义写清
> “形状、顺序与失败语义”，本文写清“一个新执行层要证明自己接通了，
> 必须交出什么证据”。缺一项就不算接通，缺一项的执行层不得声称
> “已接入 fshine”，只能说“正在对接”。
>
> 归属：清单里的每一项都属于执行层，不属于 fshine。
> fshine 只消费清单，不替执行层补清单；补清单的代价（写网关、
> 写 schema、写 mock、写 skill）永远在执行层那一边。
>
> 命名：新执行层不得复用任何已有执行层实例的网关名、操作名、
> 环境名前缀。通用夹具（dummy / stock）也不是实例，不得以实例名
> 命名；实例名只属于该实例自己的 profile。

## 准入表（缺一不可）

| # | 项 | 交出什么 | 验收方式（确定性，不靠模型说好） |
| --- | --- | --- | --- |
| A1 | Profile / 网关声明 | profile 三件套：`root`（执行层仓根绝对路径）、`gateway`（相对 root 的网关调用形式，如 `bin/stock`）、`skillRoots`（相对 root 的运行态技能面）。模型绝不传入。 | 加载校验通过：相对路径、无 `..`、无绝对路径、无 shell 元字符；缺失时 spawn 路径 fail-closed，不回退旧网关名。 |
| A2 | Operation list | 网关 `<gateway> operation list --json`，每条 operation 含 `name`、`domain`、`command`、`access`、`script`、`effects`、`executor`、`est_seconds`、`weight`、`args`、`serve`（mode×access 矩阵）、`protocol`（无则 null）、`label`。 | 宿主四张派生表（label / args 规格 / access 语义 / protocol 角色）全部由此清单机械派生，不靠第二份名单；清单拿不到即 fail-closed。 |
| A3 | Plan schema | 执行层 `plan --schema`，PlanDraft 唯一来源；`calls` 必填，顶层未声明字段响亮拒绝，绝不静默忽略。 | 宿主用该 schema 的形状提交计划；未知字段、非只读调用、未知 operation 均被执行层以退出码 2 拒绝。 |
| A4 | Plan evaluate（含 weight） | `<gateway> plan evaluate --task-id <id> --stdin`，输出 `planId`、`version`、`decision`（execute / notify / `confirm` / stop）、`reasonCode`、`status`，且 `estimate: { calls, seconds, weight }` 中 **weight 必填**（各 call 权重之和）。 | 宿主通用策略与平台 decision 更严为准叠加；weight 缺失、非有限数、为负时宿主 fail-closed，不降级为仅 calls/seconds 裁档。 |
| A5 | Proposal schema 下发 | `operation list` 的 `proposalSchema` 列，只在 `protocol === 'proposal.create'` 的那一行带出，其余行一律 null。 | 宿主只做“非空普通对象”形状卫生检查后原样透传给隔离复核，不读、不校验、不缓存业务字段；schema 缺失/非法时提案创建直接失败，不降级为只比摘要。 |
| A6 | Proposal 创建 / 提交 / 读回 | 干跑创建（TTL，缺省 30 分钟）→ 用户确认（HMAC 提案/提交令牌，服务器签发）→ 提交前读回、提交后读回；读回不足记 `committed_unverified`，绝不说成成功。 | 端到端证明：创建 pending → 提交 verified → 读回 delta = required → 二次提交被拒且计数不变；读回不足时状态为 committed、verified=false、宿主分类为 committed_unverified。 |
| A7 | RESULT 信封 | stdout 末行 `RESULT {v:1, op, status, data, error}`，`status` ∈ completed / failed / needs_input / not_found；`not_found` 是确定性无数据，绝不洗成零值。 | 每个命令的末行信封可解析且 v=1；无信封/非法信封时宿主视为网关失败，fail-closed。 |
| A8 | 退出码与错误码家族 | 退出码 0/1/2/3（0 成功、1 失败、2 用法错误、3 网关/提案拒绝）；错误码只判族不判文案（平台不可用族、选择类、终局快路径、输入类等，互不混用）。 | 宿主判据是码与信封，不嗅探消息文本；新增码只在唯一适配层加码。 |
| A9 | 实执行门（法域声明面已归零） | 历史：曾要求 `EXECUTION_SERVE=1` + `EXECUTION_INVOCATION`（宿主/服务器声明 serve 法域并签发 HMAC，缺一则 serve 调用被拒）。`FSHINE_REAL_COMMIT=1`（宿主真写授权）**已于 2026-11-08 退役**：写能不能真落地归执行层。**2026-11-10 起宿主对执行层的法域声明面归零**：不写域 env、不在命令上加法域 flag。编排驱动的信号是随调用走的协议材料（计划绑定与签名令牌），法域判定归执行层自己从调用形状推；「网关铸造/校验 serve 令牌」的旧描述作废。仍由执行层持有的门是 `EXECUTION_ALLOW_REAL=1`（触平台实执行授权，缺它 = 触平台执行被拒，纯本地计算不受影响）。 | 宿主侧不再验收「serve 令牌在不在」。实执行门缺了由执行层拒绝，不以“本地测试”或“模型已确认”为由放行；mock 之下实执行门不可达。执行层若仍把域 env / `--mode` 当准入，缺声明会由它自己响亮拒绝，宿主不补。 |
| A10 | 自己的 mock | 执行层自己的测试替身：状态文件按案隔离，删除即重置；未 mock 的脚本响亮失败（`OPERATION_NOT_MOCKED`，exit 3），缺状态响亮失败（`MOCK_STATE_MISSING`，exit 3），绝不静默走真平台。 | 通用 mock 与执行层自有 mock 互不冒充证据：通用 mock 测编排协议，执行层 mock 测该实例集成。 |
| A11 | 自己的记忆 | 领域记忆的读写规程与内容边界：记忆按什么键读写、缺失时返回什么、写记忆是否需要确认、记忆不得覆盖宿主计划/确认/审计。 | 记忆 set/get/list 有确定性命令与状态文件；缺失键返回 not_found，不编造值；记忆文件删除即重置。 |
| A12 | 自己的熔断 / 缓存 | 熔断状态机（closed / open / reset 的转换条件与拒绝形态）与缓存读写（命中/未命中/清除的确定性语义），二者状态文件与业务状态文件分离。 | 熔断打开时调用被拒且错误码明确；缓存命中与未命中可区分；清除后未命中；状态删除即重置。 |
| A13 | 自己的 skill 路由示例 | 运行态技能面（如 `.agents/skills-serve/<name>/SKILL.md` 或夹具内的 skills-serve 目录）：只给 worker 选路示例（走哪条路、拆不拆步、缺了问什么），不复写宿主计划/确认/审计流程，不代替能力清单、schema 与网关门禁。 | skill 里出现的能力名、参数名与 operation list 一致；skill 说错了、worker 没看，网关门仍按清单与 schema 拦。 |
| A14 | 状态隔离 | 业务状态、计划状态、提案状态、审计、记忆、熔断、缓存各自有状态文件；每案（每测试、每任务）用独立状态目录，删除即重置，跨案不得串台。 | 两案并行：一案提交后计数只动该案，另一案仍为种子值；审计行按案分开。 |

## 第二执行层证明的判据（第 4 包用这条）

一个新执行层算“证明了 fshine 可换执行层”，当且仅当同时满足：

1. 上表 A1–A14 全部交齐，且每一项都有确定性验收（命令 + 退出码 +
   信封/状态），不是文档宣称。
2. fshine 的 `packages/` 与 `apps/` 生产代码改动为 0：
   用 `git diff --name-only <基线> -- packages apps` 证明为空；
   只允许改夹具域、测试/评价脚本、配置（profile 声明）与文档。
   测试文件本身不计入生产代码，但生产代码的测试覆盖不得因此下降。
3. 通用机制在该域上走一遍：计划门（execute / confirm / stop 至少
   覆盖 execute 与 confirm）、确认、提案 dry-run、读回、审计、
   步数帽（纯函数边界或驱动跟踪器）、交接文件往返，至少给出一个
   端到端证明（脚本化 worker 会话即可，不需真模型）。
4. 归属分清：新域网关名、操作名、环境名前缀、种子数据、skill
   与已有实例（财税实例 `bin/example-gateway`、通用 `bin/generic`）均不重叠；
   工作树 grep 旧前缀（已清零的前缀）保持 0；财税语义不得出现
   在新域的任何文件里。

## 本仓的第二个证明域（第 4 包）

- 域：库存（stock），夹具位置 `scripts/eval/fixtures/stock-platform/`，
  网关 `bin/stock`，操作名 `stock.*`，种子货架 north / south /
  north-wing / locked-shelf / empty-shelf，批次 B1 / B2。
- 它是测试夹具，不是生产域，不进 `packages/` / `apps/`；
  它的作用是证明第 2 条——换一个域，fshine 不用改代码。
- 它的记忆、熔断、缓存是最小确定性实现（见该夹具的 README），
  不是生产级实现；生产级实现仍由真实执行层自己交（A11–A12）。

## ballot 第二写域证据（第 4 包补充）

- 命名理由：ballot 操作集（ballot.query / ballot.prepare / ballot.proposal / ballot.proposal-commit）复用了 dummy-platform 夹具（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs`）的 6 个操作，未在 `scripts/eval/fixtures/` 下建立独立 `ballot-platform/` 目录。
- 登记原因：小裁示 1 推荐独立夹具目录，但 ballot 操作与 dummy 共享状态机与操作注册表，拆分会导致两份 mock 状态维护成本；命名空间 `ballot.*` 已与 dummy 内其他操作隔离，不冲突。
- 共享状态机影响：ballot 与 dummy 共享 collections 状态文件（`dummy-state.json`），因此「第二写域」的域隔离证明力仅限于操作命名空间隔离（ballot.* 前缀），不包含状态文件隔离。若后续需要强域隔离证明，需拆分独立状态文件。
- 证据位置：`scripts/eval/generic-mock.ts` 用例 `g-ballot-second-domain`（读路径 ballot.query + 写路径 ballot.prepare → ballot.proposal → ballot.proposal-commit）为主；`tests/e2e/turn-loop-ballot.test.ts` 因 ballot.* 仅存在于 dummy.cjs、不在配置派生的网关上，结构性无法独立运行，已跳过，不计入通用闭环。
