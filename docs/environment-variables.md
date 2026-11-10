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
| `FSHINE_PLATFORM_QUEUE_CAPACITY` | `host.platformQueueCapacity` | 缺省 / 非法 = 100；宿主同时在办的平台作业上限（宿主待办深度，不限制平台并发；0 按 1 处理） |
| `FSHINE_WORKER_DISPATCH_MODE` | `host.workerDispatchMode` | 缺省 `inline`；`background` 才启用后台委派 |
| `FSHINE_SHUTDOWN_DRAIN_MS` | `host.shutdownDrainMs` | 缺省 / 非法 = 30000 |
| `FSHINE_INBOUND_DEBOUNCE_MS` | `host.inboundDebounceMs` | 缺省 = 2000（0 = 关闭） |
| `FSHINE_ATTACHMENT_DIR` | `host.attachmentDir` | 缺省 = `<平台根>/tmp/attachments` |
| `FSHINE_PI_AGENT_DIR` | `host.piAgentDir` | 缺省 = `<cwd>/data/pi-agent` |
| `FSHINE_WORKER_STEP_CAP` | `host.workerStepCap` | 缺省 / 非法 = 50，第 51 次放行送 wind-down |
| `APP_PORT` / `APP_PUBLIC_URL` / `APP_CALLBACK_PATH` | `channel.port` / `channel.publicUrl` / `channel.callbackPath` | 端口非法即启动失败；URL / 回调路径缺省为空 / 默认回调路径 |
| `BUSINESS_SKILL_PATH` | `businessSkillPath` | 优先级：本变量 > yaml `businessSkillPath` > 默认 skill 文件 |

下表仍只从 env 读（不是部署配置）：

| 变量 | 生产者 / 消费者 | 默认值 / 缺失行为 |
| --- | --- | --- |
| `AGENT_CONFIG_PATH` | 部署 / `loadConfig`、business-skill 解析 | 缺省 = `config/agent.yaml`；自指配置路径，永远不进 yaml |
| `DB_PATH` | 部署 / 服务与 daily-summary 的库路径 | 缺省 = `data/agent.db` |
| `ACCEPTANCE_DB_PATH` | 仅 acceptance-22 补充脚本 | 缺省 = `data/acceptance-202609181621.db` |
| `EXECUTION_MOCK_STATE_KEEP` | 操作者 export / 仅 acceptance 脚本读取（`process.env`） | 缺省 = mock 运行后删状态文件；置位则保留；仓内没有自动注入点 |

## 2. 共享接口（宿主写或继承，执行层读）

> 宿主按执行法域 / 活跃计划逐次注入的 `EXECUTION_SERVE` / `EXECUTION_REQUIRE_PLAN` /
> `EXECUTION_PLAN_ID` 不是部署期环境变量，已移入 §9.3「逐次注入」。

| 变量 | 生产者 / 消费者 | 默认值 / 缺失行为 |
| --- | --- | --- |
| `EXECUTION_INVOCATION` | 网关铸造 / serve 门校验 | 缺失 / 非法 = serve 调用一律拒绝 |
| `EXECUTION_ALLOW_REAL` | 部署 / 执行层 实执行门 | 仅字面量 `1` 授权；缺失 = 触平台执行被拒 `REAL_EXECUTION_NOT_ALLOWED`，纯本地计算不受影响 |
| `EXECUTION_EXECUTOR` | 部署 / **执行层自己的**执行器切换（宿主不读） | `mock` = 替身应答器；未设 = 意图真平台，但仍须过 `EXECUTION_ALLOW_REAL` 门。2026-11-08 起宿主侧读取已删（`platform-mock.ts` 整模块退役）：编排层不判"这个部署允不允许写" |
| `EXECUTION_MOCK_STATE` | 部署 / 执行层 mock 状态文件 | 缺失时由**执行层平台**用自己的缺省（编排层不再兜底路径）；mock 下缺失文件即 `MOCK_STATE_MISSING`（exit 3）。宿主脚本只重置显式声明过的这一个 |
| `EXECUTION_PLAN_ACTIVATION_SECRET` | 部署 / 计划激活令牌（yaml `execution.planActivationSecret` 是源；本变量为非空覆盖口） | 缺省 = 装配进程内生成，重启失效 |
| `EXECUTION_GATE_SECRET` / `EXECUTION_COMMIT_TOKEN` | 装配进程内生成 / 提案提交令牌 | 不进进程 env，只经单次子进程 env 传递；缺失 = 提交拒绝 |
| `EXECUTION_PLAN_STATE` | 部署 / 执行层 计划账本 | 缺省 = `<平台根>/.runtime/plans.json`（探针 / 冒烟脚本按用例隔离覆盖） |
| `EXECUTION_AUDIT_PATH` | 部署 / 调用审计 JSONL | 缺省 = 平台默认审计路径；探针按用例隔离覆盖 |
| `EXECUTION_RATE_LIMIT_STATE` | 部署 / 限流令牌桶状态 | 缺省 = `<平台根>/.runtime/rate-limit.json` |

## 3. 执行层治理（执行层 读，宿主只继承 / 按用例隔离）

| 变量族 | 作用 / 默认值 / 缺失行为 |
| --- | --- |
| `EXECUTION_RATE_LIMIT` | 限流 JSON 部分覆盖默认桶；`off` 整体旁路（仅排障）；缺省 = 执行层默认桶 |
| `EXECUTION_MEMORY_STATE` / `EXECUTION_BREAKER_STATE` / `EXECUTION_PROPOSAL_STATE` | 领域记忆 / 熔断账本 / 提案状态库文件路径；缺省各为 `.runtime/` 下默认文件；提案状态损坏 fail-closed，不静默复位 |
| `EXECUTION_PROPOSAL_TTL_SECONDS` | 提案 TTL；缺省 30 分钟 |
| `EXECUTION_PLAN_AUTO/NOTIFY/CONFIRM/HARD_CALLS`、`_SECONDS`（8 个）+ `EXECUTION_PLAN_AUTO/NOTIFY/BUDGET/HARD_WEIGHT`（4 个） | 计划档位阈值；缺省 calls 2/10/20/50、seconds 60/180/600/1800、weight 6/18/60/180；注意权重线第三档真名是 `BUDGET`（`EXECUTION_PLAN_BUDGET_WEIGHT`），不是 `CONFIRM`——`CONFIRM` 只用于 calls/seconds 线，设 `EXECUTION_PLAN_CONFIRM_WEIGHT` 会静默无效 |
| `EXECUTION_PLAN_GRIND_GAP` / `EXECUTION_PLAN_MAX_NOTIFY` / `EXECUTION_PLAN_MAX_REPLANS` / `EXECUTION_PLAN_MAX_VARIANTS` | 计划研磨间隔与重提 / 重通知上限；执行层从 `process.env` 读作可配默认；缺省 30 / 3 / 8 / 3；e2e 计划 harness 会按用例覆盖 `EXECUTION_PLAN_MAX_NOTIFY`（2 / 6） |
| `EXECUTION_DAILY_SOFT_CAP` / `EXECUTION_DAILY_HARD_CAP` / `EXECUTION_API_CALL_SOFT_CAP` / `EXECUTION_API_CALL_HARD_CAP` | 日调用与日 API 调用软硬上限；缺省 120 / 400 / 150 / 300 |
| `EXECUTION_BREAKER_FAIL_STREAK` / `EXECUTION_BREAKER_COOLDOWN_MS` / `EXECUTION_BREAKER_WINDOW_MS` / `EXECUTION_SOFT_SIGNAL_WINDOW_MS` / `EXECUTION_SOFT_SIGNAL_CRASH_WARN` | 熔断与软信号阈值；缺省 5 / 30 分钟 / 默认窗口 / 1 小时 / 2 |
| `EXECUTION_CACHE_DIR` / `EXECUTION_CACHE_TTL_HOURS` | 缓存目录 / TTL；缺省为 `.runtime/` 下默认目录与默认 TTL |
| `EXECUTION_RESULT_FILE` | 网关边车镜像：信封同步追加到的文件；网关 spawn 前设置，不设则不镜像 |
| `EXECUTION_PASS_FILE` | 登录凭据面：密码文件路径（缺省 `~/.config/执行层/password`）；**Agent 不读 `.env` 凭据**（见 执行层 AGENTS.md 登录红线），本行只作盘点，不作调用方 |
| `EXECUTION_BROWSER_KEEP_OPEN` | platform-session 置位时跳过浏览器关闭；仅 `1` 生效 |

兄弟执行层仓自有的 18 个环境变量中，原登记在本节的 13 个机器本地 / 凭据 / 浏览器路径面条目（`ENV_PATH` / `RUNTIME_DIR` / `BROWSER_PROFILE_DIR` / `BROWSER_CACHE_DIR` / `BROWSER_UA` / `BROWSER_HEADLESS` / `SCREEN_DIR` / `AUTH_STATE` / `TOKEN_CACHE_PATH` / `CHROME_PATH` / `EXECUTION_EXPORTS_DIR` / `EXECUTION_PHONE` / `EXECUTION_PASSWORD`）移出本清单，由兄弟仓文档维护；其余退役 / 历史名与非环境变量示例见 §6、§8 及文末盘点方法。本清单只留这一行指向，不复制其默认值与语义。

## 4. 通用夹具（fshine generic-mock，隔离语义）

**命名族裁定（2026-11-10，issue #20 切片 E；全文 `docs/env-naming-ruling-20261110.md`）**：
`EXECUTION_*` 是**唯一规范族**，`DUMMY_*` 降级为**调试入口**（手工跑夹具时可用）。
夹具按 `env2(EXECUTION_*, DUMMY_*, 缺省)` 查找——规范名优先、专名第二顺位。
评测进程只注入规范名（`generic-mock.ts` 的 `Ctx`），探针启动时 delete ambient 专名
（切片 A 建立，切片 E 扩到令牌面）。2026-11-05「保留双名」的旧裁定已推翻：隔离的真实机制是 per-case 目录，
不是名字不同；专名优先会让任何 ambient 专名（含漏列的新键）静默改道 per-case 隔离。

| 规范名（唯一注入面） | 调试专名（手工跑） | 作用 / 缺省 |
| --- | --- | --- |
| `EXECUTION_MOCK_STATE` | `DUMMY_STATE` | 隔离路径：夹具集合与记录状态文件；缺省 `<夹具>/.runtime/dummy-state.json`；其所在目录即其余状态文件的缺省目录 |
| `EXECUTION_PLAN_STATE` | `DUMMY_PLAN_STATE` | 计划账本；缺省 `<主状态文件所在目录>/plans.json` |
| `EXECUTION_PROPOSAL_STATE` | `DUMMY_PROPOSAL_STATE` | 提案状态库；缺省 `<主状态文件所在目录>/proposals.json` |
| `EXECUTION_AUDIT_PATH` | `DUMMY_AUDIT_PATH` | 审计 JSONL（含拒绝）；缺省 null（不写审计文件） |
| `EXECUTION_GATE_SECRET` | `DUMMY_GATE_SECRET` | 提案提交令牌验签密钥；缺省空串 = 提案提交一律拒绝（fail-closed）；`dummy.commit` 直提路径仍是「有 secret 才验」的遗留契约（debt-ledger D-204 待统一） |
| `EXECUTION_COMMIT_TOKEN` | `DUMMY_COMMIT_TOKEN` | 提案提交令牌；缺省空串 |
| `EXECUTION_PLAN_ACTIVATION_SECRET` | `DUMMY_PLAN_ACTIVATION_SECRET` | 计划激活令牌密钥；缺省空串 |

夹具令牌是**测试夹具值**，不是生产配置：dummy / stock 两族的隔离路径与令牌面
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
`EXECUTION_*` 规范名优先，`STOCK_*` 是调试入口；评测进程只注入规范名。
计数说明：按 `env()` / `env2()` 实际读取点逐个核实为 **26 个**；本节只列
**10 个隔离路径与令牌面**（7 个状态路径 + 3 个令牌），**10 条全部有规范名**
（其中 5 条此前已有回退，5 条按本裁定补齐）。其余 16 个按用例旋钮
（`STOCK_PLAN_ID` / `STOCK_REQUIRE_PLAN` / `STOCK_READBACK_SHORT` /
`STOCK_PROPOSAL_TTL_SECONDS` / `STOCK_PLAN_*` 12）见 §9.2，**不受**命名族裁定影响
（C 类仍是夹具专名）。若按字面 token 扫夹具目录会多出 `STOCK_*` 前缀提法与
`generic-model-eval.py` 的 `STOCK_BIN`（Python 本地路径变量，不是环境变量），
两者均不计入。夹具 README 此前称「各状态文件均接受 `EXECUTION_*` 别名」并不准确；
本裁定后该说法成立且升级为「规范名优先」，README 已同步。

| 规范名（唯一注入面） | 调试专名（手工跑） | 作用 / 缺省 |
| --- | --- | --- |
| `EXECUTION_MOCK_STATE` | `STOCK_STATE` | 货架与物品状态文件；缺省 `<夹具>/.runtime/stock-state.json`；其所在目录即其余状态文件的缺省目录 |
| `EXECUTION_PLAN_STATE` | `STOCK_PLAN_STATE` | 计划账本；缺省 `<主状态文件所在目录>/plans.json` |
| `EXECUTION_PROPOSAL_STATE` | `STOCK_PROPOSAL_STATE` | 提案状态库；缺省 `<主状态文件所在目录>/proposals.json` |
| `EXECUTION_AUDIT_PATH` | `STOCK_AUDIT_PATH` | 审计 JSONL（含拒绝）；缺省 null（不写审计文件） |
| `EXECUTION_MEMORY_STATE` | `STOCK_MEMORY_STATE` | 记忆辅助组状态；缺省 `<主状态文件所在目录>/memory.json` |
| `EXECUTION_BREAKER_STATE` | `STOCK_BREAKER_STATE` | 熔断辅助组状态；缺省 `<主状态文件所在目录>/breaker.json` |
| `EXECUTION_CACHE_STATE` | `STOCK_CACHE_STATE` | 缓存辅助组状态；缺省 `<主状态文件所在目录>/cache.json`。`EXECUTION_CACHE_STATE` 是夹具侧规范名；执行层的缓存目录 / TTL 是 §3 的 `EXECUTION_CACHE_DIR` / `EXECUTION_CACHE_TTL_HOURS`，不是同一事物 |
| `EXECUTION_GATE_SECRET` | `STOCK_GATE_SECRET` | 提案提交令牌验签密钥；缺省空串（空则不验令牌） |
| `EXECUTION_COMMIT_TOKEN` | `STOCK_COMMIT_TOKEN` | 提案提交令牌；缺省空串 |
| `EXECUTION_PLAN_ACTIVATION_SECRET` | `STOCK_PLAN_ACTIVATION_SECRET` | 计划激活令牌密钥；缺省空串 |

（§4c 跨仓校验开关已随 W4 移除：该校验移交执行层仓持有，其检出根目录变量随之出宿主——见 debt-ledger D-150/D-168。）

> 机械对账：`scripts/eval/env-doc-reconciliation.test.ts` 解析 §4/§4b 与 §9.1/§9.2/§9.3
> 的条目，与两夹具的 `env()` / `env2()` / `num()` 读取点做双向比对（含斜杠缩写展开与
> `env2` 规范名优先的结构断言）；改文档不改代码、或改代码不改文档，该守卫即红。

## 5. 外部服务商凭据（只盘点，不删、不改）

`LLM_API_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_MAIN_MODEL` /
`LLM_THINKING_LEVEL` / `LLM_MAIN_THINKING_LEVEL` / `LLM_JUDGE_MODEL`（模型侧）、
`WECOM_BOT_ID` / `WECOM_BOT_SECRET`（渠道侧）。缺失时：模型侧无 LLM 即无法跑
真模型评价与生产对话（确定性测试不受影响）；渠道侧缺失即渠道拒绝启动。

承载（issue #20 切片 C+D）：模型侧前 6 个键与渠道侧 2 个键的**源**是
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

- 夹具仍从 `process.env` 读取。B 类隔离路径与令牌面按 §4/§4b 的规范名优先查找
  （`env2(EXECUTION_*, 专名, 缺省)`，2026-11-10 命名族裁定）；本节的 C 类旋钮仍是
  夹具专名，查找顺序不变。本切片**不清理 ambient C 类同名键**：未在 `fixture.env` /
  `fixture.planPolicy` 声明的键，评测进程仍会继承 shell 里的值。探针的 ambient 清场
  覆盖 §4 的七个夹具调试专名（四个状态路径 + 三个令牌面），并按用例注入五个规范名
  （含 `EXECUTION_PROPOSAL_STATE`），但不覆盖本节 C 类旋钮。因此评测进程**不得 export**
  本节变量（实测：`DUMMY_READBACK_SHORT=1 npm run eval:generic-mock` 会让
  smoke-prepare-commit / g-state-isolation / g-ballot-second-domain 三例红；
  `STOCK_PLAN_HARD_CALLS=1` 会让 second-layer 计划门用例从 confirm 变 stop）。
- `scripts/eval/cases.yaml` 的 `fixture.env`：逐用例平铺标量，`loadProbeCases`
  包装器在用例前后注入/还原（`scripts/probe-real-agent.ts`）。
- `scripts/eval/cases.yaml` 的 `fixture.planPolicy`：**仅 `stock-platform` 夹具**，
  四档 `auto` / `notify` / `confirm` / `hard` × 三线 `calls` / `seconds` / `weight`。
  解析层校验档位/线名封闭、值为正整数；注入时由 `scripts/eval/cases.ts` 的
  `PLAN_POLICY_ENV_KEYS` 拍平成 `STOCK_PLAN_*` env 键。未声明的档/线**不注入**，
  由夹具自己的缺省补足（缺省只保留一份，在夹具源码里）；夹具读取点
  `stock.cjs planPolicy()` 不动。
- 确定性 harness（`scripts/eval/generic-mock.ts`、`scripts/eval/second-layer.test.ts`）
  把旋钮声明在各自用例的 env 构造里，不在用例体里按单次调用临时塞 env；它们同样
  先摊开 `process.env`，所以上面的 ambient 禁令同样适用。

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
| `EXECUTION_PLAN_ID` | serve 执行缺失 = 拒绝；宿主每回合按激活计划重写，测试注入的伪造值被剥离 | 宿主 `createPlanScopedWorkerEnv` / e2e harness，按计划逐次注入 |
| `EXECUTION_REQUIRE_PLAN` | 仅字面量 `1` 强制计划绑定；宿主直调时显式剥离 | 宿主 worker 路径逐次注入 |
| `EXECUTION_SERVE` | 仅字面量 `1` 进 serve 法域；否则走建造法域规则 | 宿主装配 / acceptance 脚本按执行法域逐次注入 |

这三个键由宿主按计划 / 法域逐次注入：worker 路径置 `EXECUTION_REQUIRE_PLAN=1` 并按
激活计划写 `EXECUTION_PLAN_ID`；宿主直调路径显式剥离 `EXECUTION_REQUIRE_PLAN`；
serve 路径显式置 `EXECUTION_SERVE=1`。宿主路径上 ambient 的同名值会被重写或剥离。
