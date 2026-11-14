# 环境变量清单（两仓执行与宿主接口，v1）

> 地位：本清单是 `docs/execution-layer-interface.md` 的附录，盘点口径见文末。
> 规则：新环境变量必须先登记在这里（生产者 / 消费者 / 默认值 / 缺失行为），
> 再进代码；`.env.example` 与示例配置里出现的变量必须对应一个真实读取点，
> 否则按孤儿引用删除。历史文档（change-safety、debt-ledger、rule-landing、
> architecture-laws、superpowers 规格）里的已退役名是 dated 记录，不计入现行接口，
> 也不为清零而改写历史——现行接口的退役守卫见“已退役、测试负向断言保留”一节。
>
> 前缀规则：执行层治理接口与夹具 per-run 隔离路径统一用 `EXECUTION_*`（唯一规范族，
> 2026-11-10 裁定见 `docs/env-naming-ruling-20261110.md`），宿主自用参数用 `FSHINE_*`；
> `DUMMY_*` / `STOCK_*` 只是夹具**调试入口**（手工跑时可用；B 类隔离路径与令牌面在
> 评测进程内不可见，见 §4；C 类按用例旋钮仍用夹具专名，见 §9）。上一轮的旧前缀已全量清零。
>
> 配置承载（issue #20 切片 C+D）：**部署配置与秘密的源是 `config/agent.yaml`**
> （gitignored；模板 `config/agent.example.yaml`）。同名环境变量只作**非空值覆盖口**：
> `node --env-file` 会把模板里的 `KEY=` 设成空串，空串不算覆盖。例外两类：
> ① `AGENT_CONFIG_PATH` 自指配置路径，永远只从 env 读；
> ② 隔离路径 / 夹具旋钮 / eval 工具面变量仍按各自机制留在 env（见 §1 后半、§4、§9）。
> `.env` / `.env.example` 的定位是“兼容旧部署的覆盖入口”，不再是唯一秘密源。

## 1. 宿主自用（fshine-agent 读；部署值源 = config/agent.yaml）

下表是部署配置：yaml 键是源，env 是覆盖口。缺段 / 缺键 = 未配置，`loadConfig` 层
不拒启、各消费点按表中缺省兜底；但服务启动仍会校验必填凭据（Main 驱动装配时缺
`LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 即启动失败，企微凭据在渠道 `start`
时校验，见 §5）。

| 变量（env 覆盖口） | yaml 键（源） | 默认值 / 缺失行为 |
| --- | --- | --- |
| `FSHINE_ATTACHMENT_DIR` | `host.attachmentDir` | 缺省 = `<平台根>/tmp/attachments`（渠道适配器读取） |
| `APP_PORT` / `APP_PUBLIC_URL` / `APP_CALLBACK_PATH` | `channel.port` / `channel.publicUrl` / `channel.callbackPath` | 端口非法即启动失败；URL / 回调路径缺省为空 / 默认回调路径 |
| `DB_PATH` | `store.dbPath` | 缺省 = 仓库根 `data/agent.db`；相对路径按进程 cwd 解析 |

> **2026-11-14 P5（分诊 #6）退役批次**：`host.platformQueueCapacity` /
> `host.workerDispatchMode` / `host.shutdownDrainMs` / `host.inboundDebounceMs` /
> `host.piAgentDir` / `host.workerStepCap` 及其同名 `FSHINE_*` 覆盖口（含 M4 已无读者的
> step cap）**删除**——零生产读取点的「写着不生效」假配置；旧 YAML 里的残留键由加载层
> 忽略。资源旋钮的唯一入口改为 `runtime` 段（yaml 键、**无 env 覆盖口**）：非法值
> fail-fast、未知键拒绝，缺省由 `packages/agent/src/resource-policy.ts` 按「缺省=现行为」
> 补齐；登记见 `docs/decision-log.md` §三十二，静态守卫见
> `packages/agent/resource-policy-single-source.test.ts`。
> `runtime` 段另含 `dispatchMode: inline | background`（R4 集成接线，2026-11-14；缺省
> `inline` = 现行为：委派同步执行；`background` = 受理即回执、后台 TaskRunner 执行——
> 仅 server 渠道面承接，ask/redo 入口对 background 显式拒绝；模板见 `config/agent.example.yaml`）。

下表仍只从 env 读（不是部署配置）：

| 变量 | 生产者 / 消费者 | 默认值 / 缺失行为 |
| --- | --- | --- |
| `AGENT_CONFIG_PATH` | 部署 / `loadConfig` | 缺省 = `config/agent.yaml`；自指配置路径，永远不进 yaml |

旧验收脚本（`scripts/acceptance.ts` / `scripts/acceptance-22-supplement.ts`）及其私有旋钮
已于 2026-11-13 随旧域评测脚手架删除（Minimal M2 波次 1）；不再有走命令行的验收专属开关。

## 2. 共享接口（宿主写或继承，执行层读）

> 宿主按活跃计划逐次注入的 `EXECUTION_REQUIRE_PLAN` / `EXECUTION_PLAN_ID`
> 不是部署期环境变量，已移入 §9.3「逐次注入」。法域不在此列：2026-11-10 起
> 宿主声明面归零，不注入域标记。

| 变量 | 生产者 / 消费者 | 默认值 / 缺失行为 |
| --- | --- | --- |
| `EXECUTION_INVOCATION` | 旧的「网关铸造 / serve 门校验」描述已作废（2026-11-10） | 调用上下文随调用走（计划绑定与签名令牌）。宿主不铸造、不校验这道单独信封；执行层从调用形状自己判断是不是被编排驱动 |
| `EXECUTION_ALLOW_REAL` | 部署 / 执行层 实执行门 | 仅字面量 `1` 授权；缺失 = 触平台执行被拒 `REAL_EXECUTION_NOT_ALLOWED`，纯本地计算不受影响 |
| `EXECUTION_EXECUTOR` | 部署 / **执行层自己的**执行器切换（宿主不读） | `mock` = 替身应答器；未设 = 意图真平台，但仍须过 `EXECUTION_ALLOW_REAL` 门。2026-11-08 起宿主侧读取已删（`platform-mock.ts` 整模块退役）：编排层不判"这个部署允不允许写" |
| `EXECUTION_MOCK_STATE` | 部署 / 执行层 mock 状态文件 | 缺失时由**执行层平台**用自己的缺省（编排层不再兜底路径）；mock 下缺失文件即 `MOCK_STATE_MISSING`（exit 3）。**宿主不再注入**（2026-11-10 消费端边界裁定）；仓内夹具不读该键（状态根走测试专用 `--state-dir`，§4a）。真平台契约行保留——生产本就零注入 |
| `EXECUTION_PLAN_ACTIVATION_SECRET` | 部署 / 计划激活令牌（yaml `execution.planActivationSecret` 是源；本变量为非空覆盖口） | 缺省 = 装配进程内生成，重启失效 |
| `EXECUTION_GATE_SECRET` / `EXECUTION_COMMIT_TOKEN` | 装配进程内生成 / 提案提交令牌 | 不进进程 env，只经单次子进程 env 传递；缺失 = 提交拒绝 |
| `EXECUTION_PLAN_STATE` | 部署 / 执行层 计划账本 | 缺省 = `<平台根>/.runtime/plans.json`。**宿主不再按例注入**（探针/夹具改测试专用 `--state-dir`，§4a）；真平台契约行保留——生产本就零注入 |
| `EXECUTION_AUDIT_PATH` | 部署 / 调用审计 JSONL | 缺省 = 平台默认审计路径。**宿主不再按例注入**（探针从状态根派生审计文件，§4a）；真平台契约行保留——生产本就零注入 |
| `EXECUTION_RATE_LIMIT_STATE` | 部署 / 限流令牌桶状态 | 缺省 = `<平台根>/.runtime/rate-limit.json` |

## 3. 执行层治理（执行层 读，宿主只继承 / 按用例隔离）

| 变量族 | 作用 / 默认值 / 缺失行为 |
| --- | --- |
| `EXECUTION_RATE_LIMIT` | 限流 JSON 部分覆盖默认桶；`off` 整体旁路（仅排障）；缺省 = 执行层默认桶 |
| `EXECUTION_MEMORY_STATE` / `EXECUTION_BREAKER_STATE` / `EXECUTION_PROPOSAL_STATE` | 领域记忆 / 熔断账本 / 提案状态库文件路径；缺省各为 `.runtime/` 下默认文件；提案状态损坏 fail-closed，不静默复位。2026-11-10 起**宿主不再注入提案状态路径**（夹具从测试专用 `--state-dir` 根派生，§4a）；memory/breaker 规范名仍可作手工/调试覆盖口，生产零注入 |
| `EXECUTION_PROPOSAL_TTL_SECONDS` | 提案 TTL；缺省 30 分钟 |
| `EXECUTION_PLAN_AUTO/NOTIFY/CONFIRM/HARD_CALLS`、`_SECONDS`（8 个）+ `EXECUTION_PLAN_AUTO/NOTIFY/BUDGET/HARD_WEIGHT`（4 个） | 计划档位阈值；缺省 calls 2/10/20/50、seconds 60/180/600/1800、weight 6/18/60/180；注意权重线第三档真名是 `BUDGET`（`EXECUTION_PLAN_BUDGET_WEIGHT`），不是 `CONFIRM`——`CONFIRM` 只用于 calls/seconds 线，设 `EXECUTION_PLAN_CONFIRM_WEIGHT` 会静默无效 |
| `EXECUTION_PLAN_GRIND_GAP` / `EXECUTION_PLAN_MAX_NOTIFY` / `EXECUTION_PLAN_MAX_REPLANS` / `EXECUTION_PLAN_MAX_VARIANTS` | 计划研磨间隔与重提 / 重通知上限；**执行层策略参数，宿主不设**（值源在执行层配置层；2026-11 env 治理 v2 起 env 不再是通道）；缺省 30 / 3 / 8 / 3；契约行保留（真平台仍读这些参数），e2e 不再按用例覆盖 |
| `EXECUTION_DAILY_SOFT_CAP` / `EXECUTION_DAILY_HARD_CAP` / `EXECUTION_API_CALL_SOFT_CAP` / `EXECUTION_API_CALL_HARD_CAP` | 日调用与日 API 调用软硬上限；缺省 120 / 400 / 150 / 300 |
| `EXECUTION_BREAKER_FAIL_STREAK` / `EXECUTION_BREAKER_COOLDOWN_MS` / `EXECUTION_BREAKER_WINDOW_MS` / `EXECUTION_SOFT_SIGNAL_WINDOW_MS` / `EXECUTION_SOFT_SIGNAL_CRASH_WARN` | 熔断与软信号阈值；缺省 5 / 30 分钟 / 默认窗口 / 1 小时 / 2 |
| `EXECUTION_CACHE_DIR` / `EXECUTION_CACHE_TTL_HOURS` | 缓存目录 / TTL；缺省为 `.runtime/` 下默认目录与默认 TTL |
| `EXECUTION_RESULT_FILE` | 网关边车镜像：信封同步追加到的文件；网关 spawn 前设置，不设则不镜像 |
| `EXECUTION_PASS_FILE` | 登录凭据面：密码文件路径（缺省 `~/.config/执行层/password`）；**Agent 不读 `.env` 凭据**（见 执行层 AGENTS.md 登录红线），本行只作盘点，不作调用方 |
| `EXECUTION_BROWSER_KEEP_OPEN` | platform-session 置位时跳过浏览器关闭；仅 `1` 生效 |

兄弟执行层仓自有的 18 个环境变量中，原登记在本节的 13 个机器本地 / 凭据 / 浏览器路径面条目（`ENV_PATH` / `RUNTIME_DIR` / `BROWSER_PROFILE_DIR` / `BROWSER_CACHE_DIR` / `BROWSER_UA` / `BROWSER_HEADLESS` / `SCREEN_DIR` / `AUTH_STATE` / `TOKEN_CACHE_PATH` / `CHROME_PATH` / `EXECUTION_EXPORTS_DIR` / `EXECUTION_PHONE` / `EXECUTION_PASSWORD`）移出本清单，由兄弟仓文档维护；其余退役 / 历史名与非环境变量示例见 §6、§8 及文末盘点方法。本清单只留这一行指向，不复制其默认值与语义。

## 4. 通用夹具（fshine generic-mock，隔离语义）

> **2026-11-13 M4 状态（§4–§9 读取面盘点）**：`scripts/eval/generic-mock.ts`、
> `fixture-aux-state.ts`、`second-layer.ts`、`plan-policy.test.ts`、
> `generic-model-eval.py` 与 stock 夹具（§4b/§9.2）均已随 M2/M4 退役
> （decision-log §十三），下文凡以它们为「现用读者」的表述一律按历史盘点阅读。
> 现行产品面只余 `npm run ask` 的 dummy 夹具：§4 三个令牌面与 §4a `--state-dir`
> 测试面是仍存活的机制（凭据隔离白名单见 `packages/agent/src/worker-env.ts` +
> `worker-env.test.ts`；隔离门见 `scripts/eval/safety-gate.ts`）。

**命名族裁定（2026-11-10 续篇，issue #20 消费端边界收敛）**：`EXECUTION_*` 仍是跨层
令牌面与真平台状态契约的唯一规范族，`DUMMY_*` 降级为**调试入口**（手工跑夹具时可用）。
但**四个状态路径**（`EXECUTION_MOCK_STATE` / `EXECUTION_PLAN_STATE` /
`EXECUTION_PROPOSAL_STATE` / `EXECUTION_AUDIT_PATH`）已从夹具读取面**退役**：夹具不再读
任何 ambient 状态路径（含 `DUMMY_*` 调试回退），状态位置归执行层自己（生产本就零注入）。
per-run 隔离是 fshine 测试基础设施对自己 dummy 夹具的事务，走**测试专用**
`--state-dir <path>` flag（**dummy 测试面，非消费协议**，见 §4a），不经宿主消费协议。

| 规范名（唯一注入面） | 调试专名（手工跑） | 作用 / 缺省 |
| --- | --- | --- |
| `EXECUTION_GATE_SECRET` | `DUMMY_GATE_SECRET` | 提案提交令牌验签密钥；缺省空串 = 提案提交一律拒绝（fail-closed）；`dummy.commit` 直提路径仍是「有 secret 才验」的遗留契约（debt-ledger D-204 待统一） |
| `EXECUTION_COMMIT_TOKEN` | `DUMMY_COMMIT_TOKEN` | 提案提交令牌；缺省空串 |
| `EXECUTION_PLAN_ACTIVATION_SECRET` | `DUMMY_PLAN_ACTIVATION_SECRET` | 计划激活令牌密钥；缺省空串 |

### 4a. 状态根（测试专用 flag，非消费协议）

`--state-dir <path>` 只属于仓内 dummy/stock 夹具的测试面：宿主生产路径与跨层消费协议
都不携带它。夹具从该根派生全部状态文件（`dummy.cjs` / `stock.cjs` 的 `statePaths()` /
`auxPaths()`）：

| 派生文件 | 作用 |
| --- | --- |
| `<state-dir>/dummy-state.json`（stock：`stock-state.json`） | 主状态（集合/记录，或货架/物品） |
| `<state-dir>/plans.json` | 计划账本 |
| `<state-dir>/proposals.json` | 提案状态库 |
| `<state-dir>/audit.jsonl` | 调用审计 JSONL（含拒绝）；只在显式传该 flag 时写 |
| stock 另有 `<state-dir>/memory.json` / `breaker.json` / `cache.json` | 辅助组，缺省从同一根派生 |

未传 flag 时主状态缺省 `<夹具>/.runtime/<夹具>-state.json`，审计不写（null）——那是手工
调试形态，不是评测隔离机制。

| 变量（仅真平台契约，宿主不注入、夹具不读） | 说明 |
| --- | --- |
| `EXECUTION_MOCK_STATE` | 真平台部署契约行保留（§2）；夹具读取已退役 |
| `EXECUTION_PLAN_STATE` | 真平台部署契约行保留（§2）；夹具读取已退役 |
| `EXECUTION_PROPOSAL_STATE` | 真平台部署契约行保留（§3）；夹具读取已退役 |
| `EXECUTION_AUDIT_PATH` | 真平台部署契约行保留（§2）；夹具读取已退役 |

> 探针的传导桥（历史记录）：宿主 spawn 网关是固定 argv（没有附加参数通道），探针
> `isolatePlatformState` 无法直接把 flag 传进夹具；它改为把 per-case 根写进
> `FSHINE_EVAL_FIXTURE_STATE_DIR`，由夹具的 shell 入口（`bin/dummy`）翻译成
> `--state-dir`。2026-11-10 起该写入只发生在探针的 per-case 子进程里（父进程不改
> `process.env`）。该变量是 fshine 评测基础设施私有；宿主生产路径与真平台零读取。
>
> **2026-11-13 M4 指针校正（复核 findings；只改指针不改口径）**：上文所引探针
> `isolatePlatformState` / `acceptance` / `platform-leak-lint` 登记 /
> `packages/agent/src/child-env.ts`（键名放行白名单）/ 旧 `bin/stock` / `bin/generic`
> 入口 / `generic-model-eval` 在当前树均不存在（随 `0b97227` 或 M4 清扫退役）。现行实现
> 的边界断言 = `packages/agent/src/worker-env.ts` 的 worker env 精确键白名单
> （`PATH`/`HOME`/`TMPDIR`）+ `worker-env.test.ts`「测试桥键不进白名单」（2026-11-13
> 实跑通过）——桥键**不在**该白名单，worker 发起的夹具调用不经它传导（ask 路径经
> `--state-dir` argv，见 `packages/agent/src/dummy-cli-client.ts`）。桥的退役条件与时间
> 锚点见 debt-ledger D-209（含 2026-11-13 M4 指针校正与 owner 待裁定项）。

夹具令牌是**测试夹具值**，不是生产配置：dummy / stock 两族的令牌面
由评测代码注入**规范名**（`generic-mock.ts` / `second-layer.ts` / `second-layer.test.ts` /
`plan-policy.test.ts` / `generic-model-eval.py`），不进 `config/agent.yaml`；
`DUMMY_*` / `STOCK_*` 是夹具调试专名，评测进程不设。`EXECUTION_GATE_SECRET` /
`EXECUTION_COMMIT_TOKEN` 在宿主的**生产装配**里按安全设计进程内生成，故意不进任何
配置文件——`config/agent.example.yaml` 不为它们留键（进程级注入会让模型经 read/工具面
拿到密钥）；评测 harness 传给夹具的是固定测试值，不是部署密钥。
`EXECUTION_PLAN_ACTIVATION_SECRET` 的部署侧真实密钥源在 `config/agent.yaml` 的
`execution.planActivationSecret`。

按用例旋钮（`DUMMY_READBACK_SHORT` / `DUMMY_PROPOSAL_TTL_SECONDS` / `DUMMY_PLAN_*`
12 个阈值 / `DUMMY_PLAN_ID` / `DUMMY_REQUIRE_PLAN`）不属于部署 env 面，也**不受**
命名族裁定影响（C 类仍是夹具专名）；声明机制、缺省与现用 case 见 §9.1。

### 4b. stock 夹具（第二执行层证明夹具，`scripts/eval/fixtures/stock-platform/bin/stock.cjs`，隔离语义）

stock 夹具与 dummy 同族：只被 `scripts/eval/` 的第二执行层证明
（`second-layer.ts` / `second-layer.test.ts` / `plan-policy.test.ts` /
`generic-model-eval.py`）读取，`packages/` 与 `apps/` 生产代码对 `STOCK_*` 零读取。
空串按缺失处理（夹具 `env()` 把 `''` 当作未设）。命名族按 §4 的裁定：
`EXECUTION_*` 规范名优先，`STOCK_*` 是调试入口。**辅助组的六个 ambient 名
（`EXECUTION_MEMORY_STATE` / `EXECUTION_BREAKER_STATE` / `EXECUTION_CACHE_STATE` +
`STOCK_*` 调试专名）由直接运行的评测 harness 从子进程 env 删除**（`fixture-aux-state.ts`；
generic-mock / second-layer / generic-model-eval.py 同批；探针在
`ISOLATED_STATE_KEYS` 里同待遇 backup/restore）：`auxPaths()` 的 `env2` 优先读 ambient，
`--state-dir` 只保证缺省路径——继承 shell 值会让打开态熔断账本拒掉 query、memory/cache
跨用例共享或写到状态根外。dummy 不实现辅助组（零读取），故无 `DUMMY_*` 对应专名。
**状态根同 §4a**：四个状态路径（`EXECUTION_MOCK_STATE` / `EXECUTION_PLAN_STATE` /
`EXECUTION_PROPOSAL_STATE` / `EXECUTION_AUDIT_PATH`）的夹具读取已退役（含 `STOCK_*` 调试
回退），状态文件从测试专用 `--state-dir` 根派生。计数说明：按 `env()` / `env2()` 实际
读取点逐个核实为 **22 个**（四个状态路径退役后由 26 减 4）；本节只列**6 个 env2 配对**
（三个辅助组 + 三个令牌面），其余 16 个按用例旋钮（`STOCK_PLAN_ID` / `STOCK_REQUIRE_PLAN` /
`STOCK_READBACK_SHORT` / `STOCK_PROPOSAL_TTL_SECONDS` / `STOCK_PLAN_*` 12）见 §9.2，
**不受**命名族裁定影响（C 类仍是夹具专名）。四个状态路径的真平台契约行见 §4a。
若按字面 token 扫夹具目录会多出 `STOCK_*` 前缀提法与 `generic-model-eval.py` 的
`STOCK_BIN`（Python 本地路径变量，不是环境变量），两者均不计入。

| 规范名（唯一注入面） | 调试专名（手工跑） | 作用 / 缺省 |
| --- | --- | --- |
| `EXECUTION_MEMORY_STATE` | `STOCK_MEMORY_STATE` | 记忆辅助组状态；缺省 `<状态根>/memory.json`。**宿主不再注入**；辅助组缺省从状态根派生（`auxPaths()`） |
| `EXECUTION_BREAKER_STATE` | `STOCK_BREAKER_STATE` | 熔断辅助组状态；缺省 `<状态根>/breaker.json`。**宿主不再注入**；辅助组缺省从状态根派生（`auxPaths()`） |
| `EXECUTION_CACHE_STATE` | `STOCK_CACHE_STATE` | 缓存辅助组状态；缺省 `<状态根>/cache.json`。**宿主不再注入**；辅助组缺省从状态根派生（`auxPaths()`）。`EXECUTION_CACHE_STATE` 是夹具侧规范名；执行层的缓存目录 / TTL 是 §3 的 `EXECUTION_CACHE_DIR` / `EXECUTION_CACHE_TTL_HOURS`，不是同一事物 |
| `EXECUTION_GATE_SECRET` | `STOCK_GATE_SECRET` | 提案提交令牌验签密钥；缺省空串（空则不验令牌） |
| `EXECUTION_COMMIT_TOKEN` | `STOCK_COMMIT_TOKEN` | 提案提交令牌；缺省空串 |
| `EXECUTION_PLAN_ACTIVATION_SECRET` | `STOCK_PLAN_ACTIVATION_SECRET` | 计划激活令牌密钥；缺省空串 |

（§4c 跨仓校验开关已随 W4 移除：该校验移交执行层仓持有，其检出根目录变量随之出宿主——见 debt-ledger D-150/D-168。）

> 机械对账：`scripts/eval/env-doc-reconciliation.test.ts` 解析 §4/§4b 与 §9.1/§9.2/§9.3
> 的条目，与两夹具的 `env()` / `env2()` / `num()` 读取点做双向比对（含斜杠缩写展开与
> `env2` 规范名优先的结构断言）；改文档不改代码、或改代码不改文档，该守卫即红。

## 5. 外部服务商凭据（只盘点，不删、不改）

`LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_MAIN_MODEL` /
`LLM_THINKING_LEVEL` / `LLM_MAIN_THINKING_LEVEL` / `LLM_CONTEXT_WINDOW` /
`LLM_JUDGE_MODEL`（模型侧）、
`WECOM_BOT_ID` / `WECOM_BOT_SECRET`（渠道侧）。缺失时：模型侧无 LLM 即无法跑
真模型评价与生产对话（确定性测试不受影响）；渠道侧缺失即渠道拒绝启动。
`LLM_CONTEXT_WINDOW` 是 Main 模型的上下文窗口（token）能力声明：压缩阈值 =
contextWindow − 摘要预留，未声明时沿用驱动缺省 128k；显式值非法即启动失败
（窗口声明错误会让压缩在真实窗口之外才触发，是 T7 贴边空回复的源头）。

承载（issue #20 切片 C+D）：模型侧前 7 个键与渠道侧 2 个键的**源**是
`config/agent.yaml` 的 `llm.*` / `wecom.*`（gitignored；模板只留键名与获取方式，
不填真值）；同名环境变量只作非空值覆盖口。`LLM_JUDGE_MODEL` 例外：它只被 eval
评分脚本（`scripts/eval/score.ts --judge` 的 judge 链路）直读，不经过装配，属
**eval 工具面**，不随部署配置走——`config/agent.example.yaml` 不为它留键。

注意 eval 工具的读取面：`scripts/eval/judge.ts` / `score.ts` 直读 **process env**，
不加载 `config/agent.yaml`。LLM 连接只写在 yaml 的部署，跑 `eval:score:judge` /
`eval:baseline` 前需 export 同名 `LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
（或保留 `.env` 覆盖）；这是"eval 工具面不随部署配置走"的已知边界，不是宿主运行期
行为——生产装配经 effectiveEnv 正常读 yaml。

## 6. 已退役、测试负向断言保留（不是现行接口，删了反而丢守卫）

- `FSHINE_MODE` / `FSHINE_INVOCATION` / `FSHINE_EXECUTOR` / `FSHINE_GATE_SECRET` /
  `FSHINE_COMMIT_TOKEN` / `FSHINE_MOCK_STATE`：执行层 旧名，兼容读取已删；
  `test-gate.js` / `test-auth.js` 故意注入旧名断言其**不**算法域，删测试即丢退役证明。
- `EXECUTION_REAL_COMMIT`：执行层 从不读取，只在 `test-all.js` 的泄漏剥离名单里
  出现（防止测试环境把它带进真写）。
- `FSHINE_REAL_COMMIT`：**已退役（2026-11-08 架构裁定）**——宿主侧的落账授权总闸连判据源
  （`platform-mock.ts` 的 `isCommitEnabled`）一起删除，"编排层不判这个部署允不允许写"。
  执行层要自己的写授权接口应由执行层自己声明并登记进第 2/3 节；代码树里仅剩解释其退役
  原因的注释引用（leak-lint 的 FSHINE_* 登记表以「遗留待清」挂着它，清空即删）。
- `FSHINE_PROPOSAL_VIA_GATEWAY` / `FSHINE_PROPOSAL_COMMIT`：fshine 写路径旧开关，
  已随 C 波退役；`docs-reality.test.ts` 断言其在生产代码中零复现，删断言即丢闭环守卫。
- `STEALTH_MODE` / `STEALTH_DELAY_SCALE`：只出现在 执行层 未实现特性的旧规格文档
  （`docs/superpowers/`）里，代码 0 读；规格文档是 dated 记录，不为清零改写，
  也不计入现行接口。

## 7. 本轮删除清单（删后全仓 grep 为 0，已验证）

| 删了什么 | 位置 | 为什么删 |
| --- | --- | --- |
| 跨仓账套白名单部署 env 注释句（原句称它是 执行层 服务端部署 env） | fshine `.env.example` 头部边界说明 | 两仓代码 0 读：执行层 没有任何读取点，fshine 也不设它，是 stale 引用。删后改为只说账套白名单看 `config/agent.yaml` 的 `accountSetIds`；被删名本身不在本文档出现，全仓 grep 亦为 0 |

> 盘点方法：`rg` 全仓扫 `process.env` / `env[...]` / 子进程 env 注入 /
> `.env.example` / 示例配置，再按“代码真读 / 测试真依赖 / 仅文档出现 / 仅历史记录”
> 四档归类；`EXECUTION_TASK_*`、`BROWSER_CRASH_PATTERN`、`BROWSER_BUSY` 一类是
> 代码常量名与日志词，不是环境变量，已排除，不计入本清单。

## 8. 2026-11-04 历史旧名全清复核（第 2 包后续裁定：不要留着污染仓库）

- 复核方法：两仓工作树全量 grep 旧前缀（改名前的前缀，本文档不写其
  字面量以免复核说明本身成为命中，含 tracked、untracked、ignored
  的 `.runtime/`、`data/`、`tmp/`，排除 `.git/`、`node_modules/`、`.pi/`），
  结果为 0 处，无需再改任何文件；本节是复核记录，不是又一次改名。
- **口径范围（2026-11-05 补注；2026-11-06 随 W4 更新）**：上述"0 处"指**旧 env 名**
  （部署开关面）。纯编排波内曾新引入两处含旧前缀子串的名字，原不在该口径内，
  特此注明免后人按字面复核时误判：跨仓校验脚本里的 `DZ_ENV`（JS 标识符，映射表
  键名）与原 §4c 的跨仓检出根目录变量。两处已随 W4 一并出宿主——跨仓校验移交
  执行层仓（脚本连同映射表与该变量同批移除，见 §4c 处的注记），本节口径回归
  "只指旧 env 名"。执行层 工作树本身实测仍为 0 处。
- 唯一例外是 git 历史：改名前的提交里自然还有旧名，重写历史会破坏
  现有分支与 PR 基线，故不重写；“工作树污染”的度量是工作树 grep，
  不是历史 grep。
- 本节不扩大到 `FSHINE_*` 旧名：`test-gate.js` / `test-auth.js` 里注入
  `FSHINE_MODE` 断言其不算法域，是退役证明守卫，按“守卫必须保持有效、
  不是删掉凑数”的规则保留；`STEALTH_*` 旧规格名见 §6，同样是 dated
  记录而非现行接口。旧前缀与这两族旧名是不同族，不得混为一谈。

## 9. per-case 夹具旋钮与逐次注入键（cases.yaml / 测试声明；不是部署默认）

§9.1 / §9.2 收的是**按用例调参**的夹具旋钮，不进部署配置；§9.3 收宿主按计划 /
法域逐次注入的执行契约键。承载机制（issue #20 切片 B）只做**声明注入**：

- B 类令牌面按 §4/§4b 的规范名优先查找（`env2(EXECUTION_*, 专名, 缺省)`，2026-11-10
  命名族裁定）；四个状态路径的 env 读取已于 2026-11-10 续篇退役（夹具走测试专用
  `--state-dir`，§4a）。本节的 C 类旋钮仍是夹具专名，查找顺序不变。本切片**不清理
  ambient C 类同名键**：未在 `fixture.env` / `fixture.planPolicy` 声明的键，评测进程仍会
  继承 shell 里的值。探针的 ambient 清场只覆盖 §4 的三个令牌面调试专名；状态根由
  `FSHINE_EVAL_FIXTURE_STATE_DIR` 测试桥按用例覆盖（§4a），四个状态路径的规范名不再注入。
  因此评测进程**不得 export** 本节变量（历史实测：`DUMMY_READBACK_SHORT=1 npm run eval:generic-mock`
  会让 smoke-prepare-commit / g-state-isolation / g-ballot-second-domain 三例红；
  `STOCK_PLAN_HARD_CALLS=1` 会让 second-layer 计划门用例从 confirm 变 stop；两 harness
  均已退役，禁令按历史记录阅读）。
- `scripts/eval/cases.yaml` 的 `fixture.env`：逐用例平铺标量，`loadProbeCases`
  包装器在用例前后注入/还原（`scripts/probe-real-agent.ts`）。
- `scripts/eval/cases.yaml` 的 `fixture.planPolicy`：**仅 `stock-platform` 夹具**，
  四档 `auto` / `notify` / `confirm` / `hard` × 三线 `calls` / `seconds` / `weight`。
  解析层校验档位/线名封闭、值为正整数；注入时由 `scripts/eval/cases.ts` 的
  `PLAN_POLICY_ENV_KEYS` 拍平成 `STOCK_PLAN_*` env 键。未声明的档/线**不注入**，
  由夹具自己的缺省补足（缺省只保留一份，在夹具源码里）；夹具读取点
  `stock.cjs planPolicy()` 不动。
- 确定性 harness（`scripts/eval/generic-mock.ts`、`scripts/eval/second-layer.test.ts`，
  均已随 M4 退役）把旋钮声明在各自用例的 env 构造里，不在用例体里按单次调用临时塞 env；
  它们同样先摊开 `process.env`，所以上面的 ambient 禁令同样适用（按历史纪律保留）。

### 9.1 dummy 夹具（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs`，16 个）

| 变量 | 缺省 / 行为 | 声明处 / 现用 case |
| --- | --- | --- |
| `DUMMY_PLAN_ID` | 空串；规范名 `EXECUTION_PLAN_ID` 优先（专名是调试入口）；`DUMMY_REQUIRE_PLAN=1` 时 serve 执行缺失即拒 | `fixture.env`；目前无 case 声明 |
| `DUMMY_REQUIRE_PLAN` | 仅字面量 `1` 开计划绑定；规范名 `EXECUTION_REQUIRE_PLAN` 优先（专名是调试入口） | `fixture.env`；目前无 case 声明 |
| `DUMMY_READBACK_SHORT` | 仅字面量 `1`：提交只落部分记录，模拟读回不足 | `fixture.env`；`scripts/eval/generic-mock.ts` 的 `g-readback-short` 按用例声明 `1` |
| `DUMMY_PROPOSAL_TTL_SECONDS` | 仅正整数秒有效；缺省 30 分钟 | `fixture.env`；目前无 case 声明 |
| `DUMMY_PLAN_AUTO/NOTIFY/CONFIRM/HARD_CALLS` | 仅有限正数有效；缺省 2 / 10 / 20 / 50 | `fixture.env`；探针 D2 声明 `DUMMY_PLAN_CONFIRM_CALLS=6` |
| `DUMMY_PLAN_AUTO/NOTIFY/CONFIRM/HARD_SECONDS` | 仅有限正数有效；缺省 60 / 180 / 600 / 1800 | `fixture.env`；目前无 case 声明 |
| `DUMMY_PLAN_AUTO/NOTIFY/BUDGET/HARD_WEIGHT` | 仅有限正数有效；缺省 6 / 18 / 60 / 180；权重线第三档真名是 `BUDGET`，不是 `CONFIRM` | `fixture.env`；目前无 case 声明 |

`DUMMY_PLAN_ID` / `DUMMY_REQUIRE_PLAN` 与 §4 的隔离键同族：夹具按 `env2` 先读规范名
`EXECUTION_*`、再读专名（`dummy.cjs` 的 serve / call 两处分支都走同一个 `env2`）。

### 9.2 stock 夹具（`scripts/eval/fixtures/stock-platform/bin/stock.cjs`，16 个）

| 变量 | 缺省 / 行为 | 声明处 / 现用 case |
| --- | --- | --- |
| `STOCK_PLAN_ID` | 空串；规范名 `EXECUTION_PLAN_ID` 优先（专名是调试入口）；`STOCK_REQUIRE_PLAN=1` 时 serve 执行缺失即拒 | `fixture.env`；目前无 case 声明 |
| `STOCK_REQUIRE_PLAN` | 仅字面量 `1` 开计划绑定；规范名 `EXECUTION_REQUIRE_PLAN` 优先（专名是调试入口） | `fixture.env`；目前无 case 声明 |
| `STOCK_READBACK_SHORT` | 仅字面量 `1`：提交只落部分记录 | `fixture.env`；`scripts/eval/second-layer.test.ts` 的 readback-short 用例按用例声明 `1` |
| `STOCK_PROPOSAL_TTL_SECONDS` | 仅正整数秒有效；缺省 30 分钟 | `fixture.env`；目前无 case 声明 |
| `STOCK_PLAN_AUTO/NOTIFY/CONFIRM/HARD_CALLS` | 仅有限正数有效；缺省 2 / 10 / 20 / 50 | `fixture.planPolicy` 的 `calls` 线；目前无 case 声明 |
| `STOCK_PLAN_AUTO/NOTIFY/CONFIRM/HARD_SECONDS` | 仅有限正数有效；缺省 60 / 180 / 600 / 1800 | `fixture.planPolicy` 的 `seconds` 线；目前无 case 声明 |
| `STOCK_PLAN_AUTO/NOTIFY/BUDGET/HARD_WEIGHT` | 仅有限正数有效；缺省 6 / 18 / 60 / 180 | `fixture.planPolicy` 的 `weight` 线；目前无 case 声明 |

> 辅助组状态路径（`EXECUTION_MEMORY_STATE` / `EXECUTION_BREAKER_STATE` / `EXECUTION_CACHE_STATE`）
> 不在本表：它们不是按用例旋钮，宿主/评测不再按 run 注入；缺省从主状态文件所在目录派生
> （`auxPaths()`，见 §4b）。

四档表在 YAML 里的档位键固定为 `auto` / `notify` / `confirm` / `hard`，每档下面是
`calls` / `seconds` / `weight` 三条线；只声明需要的档/线，其余走夹具缺省。
`confirm.weight` 拍平成 `STOCK_PLAN_BUDGET_WEIGHT`（夹具权重线第三档的真名），
不是 `STOCK_PLAN_CONFIRM_WEIGHT`。`fixture.env` 与 `fixture.planPolicy` 重复声明
同一个 `STOCK_PLAN_*` 键会让解析失败（一个旋钮只允许一个声明处）。

机械证明：`scripts/eval/plan-policy.test.ts` 经临时 `cases.yaml` 声明一张四档表
（`hard.calls=1`），把 `fixtureEnvOf()` 拍平结果注入 stock 夹具，2 次调用的计划被
`HARD_LIMIT` 拒；同参计划在不注入该表时仍是 `execute`（对照组）。

### 9.3 宿主逐次注入的执行契约键（不是部署默认）

| 变量 | 缺省 / 行为 | 谁在注入 |
| --- | --- | --- |
| `EXECUTION_PLAN_ID` | 执行层若要求计划绑定而缺失，由执行层拒绝；宿主每回合按激活计划重写，测试注入的伪造值被剥离 | 宿主 `createPlanScopedWorkerEnv` / e2e harness，按计划逐次注入 |
| `EXECUTION_REQUIRE_PLAN` | 仅字面量 `1` 强制计划绑定；宿主直调时显式剥离 | 宿主 worker 路径逐次注入 |

这两个键由宿主按计划逐次注入：worker 路径置 `EXECUTION_REQUIRE_PLAN=1` 并按
激活计划写 `EXECUTION_PLAN_ID`；宿主直调路径显式剥离 `EXECUTION_REQUIRE_PLAN`。
宿主不注入法域标记（2026-11-10 声明面归零）：编排驱动的信号是随调用走的协议材料
（计划绑定与签名令牌），法域判定归执行层。计划绑定键上，宿主路径的 ambient
同名值会被重写或剥离。
