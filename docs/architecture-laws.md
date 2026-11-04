# 架构宪章（architecture-laws）

状态：**机械强制的硬约束**。本文把架构从"文档里的愿望"变成可被 lint / 测试 / 走查机械执行的一组律法。每一条律法 = **陈述**（是什么）+ **机械守卫**（谁在盯、怎么盯）+ **当前违例**（带归属标签）+ **闭环判据**（怎样算清）。判据是承诺，不是描述——后续每一波（B/C/D0…）都引用这里的标签与措辞，所以**写清楚比写漂亮重要**。

v0-architecture.md 是目标架构的叙述；本文是它的可执行子集。二者冲突时，以本文的判据为准，并回头修 v0-architecture。

---

## 归属标签制度（先于一切违例清单存在）

白名单、台账、基线里的**每一条痕迹必须挂且仅挂一类标签**。标签先于清单：没有标签的命中既不许默默保留，也不许当作违例删掉。验收时逐条核对标签，见「执行纪律②」。

| 标签 | 定义 |
|---|---|
| **警职执法** | 守卫 / 解析器 / 校验器本身，其存在就是为了识别或阻挡被禁模式（如 plan 命令解析正则、防御性词表） |
| **防御排除** | 防御机制的字面量，删它 = 防御变聋（如记忆提取器的财务正则、`hasFinancialFigure`） |
| **平台下发** | 文本由执行层数据携带，宿主只是渲染（如 `label`、`correctForm`、候选名） |
| **遗留待清** | 已知该走但还没走的，挂账限期 |

判读规则：

- 一条痕迹命中"被禁模式"却属于上表四类之一 → **不是违例**，挂对应标签保留，并在台账记限期。
- 一条痕迹不属于任何一类 → **真违例**，进闭环判据，该波的 revert 不背它。
- 同一条痕迹不得挂两类（"仅挂一类"）；归类争议按"删了它会不会让某道防线变聋 / 变瞎"裁决——会，就是防御排除或警职执法；不会，就是平台下发或遗留待清。

---

## 七条律法

### L1 词汇边界

**陈述**：业务词汇只住执行层 + 夹具 + 文档；宿主 `src` 的**非防御性**出现为零。编排层不懂口径，所以它连说错话的词汇都不该持有。

**机械守卫**：`packages/agent/platform-leak-lint.test.ts` 的业务词预算。词表 15 词——`BUSINESS_WORD_RE = /应收|凭证|科目|账套|期间|目录|税号|财务|借贷|余额|往来|时间范围|记录|档案|摸底/g`（D-004/D-005 扩成；收词按**领域概念**而非最显而易见的词，附同义改写对照表：时间范围→期间、记录/档案→凭证、摸底→域操作——伪装形绕词表正是 D-005 的根因）。扫描范围 = `packages/agent/src` + `apps`（D-004：生产装配与落账执行器也属编排层，曾整目录在守卫之外）；`scripts/` 以显式常量 `BUSINESS_WORD_EXCLUDED_DIRS` 排除（D-005 附条"接受不修"的显式决策——验收夹具的领域词是测试数据，纳入只减不增预算会冻结 144 行；新增非夹具用途文件须并入）。命中项**按四标签分类断言**：非防御命中必须为 0，防御命中必须 100% 挂"防御排除"。

**当前违例**：

- **真违例（3 处，扩词后即被守卫抓到）——均已清（2026-10-16 对账核实，守卫 = `packages/agent/docs-reality.test.ts`）**：
  - ~~`packages/agent/src/runtime.ts:1539` — `'你是企业财务助手和面向用户的主 Agent。'`（**财务**）~~ **已清**：persona 现为「面向用户的主 Agent」（runtime.ts 的 `SYSTEM_PROMPT`），「财务助手」宿主 src 零命中。行号 1539 是拆分前旧文件的引用（现文件 1221 行）——行号引用禁令见执行纪律 4。D-001 已关。
  - ~~`packages/agent/src/error-codes.ts:158` — `text: '没有找到匹配“{query}”的对象。请确认准确名称（或编号/税号）后我再查。'`（**税号**；直角引号 `“”` 为原文）。Lane C 本波清。~~ **已关**（2026-09-27 Wave 2 Lane D）：模板退化为纯结构 `没有找到匹配“{query}”的对象。{hint}我再查。`，`{hint}` 由平台信封 `error.correctForm` 作为**平台下发**数据填充；宿主只存"信封没带时的兜底"（挂"遗留待清"）。见 debt-ledger D-002。
  - ~~`packages/agent/src/context.ts:360` — `` `- 条目：${proposal.summary.count} 条，借贷合计各 ${proposal.summary.credit} 元` ``（**借贷**），同时是 L4 违例~~ **已清**（2026-10-14 D 波 `3e5a36c` 写路径收敛为唯一形态）：legacy 摘要渲染与 `ChangeIntentRecord` 业务字段整体删除，全仓非测试零命中。D-003/D-030 已关。
- **防御排除（不得删、须挂标签）**：
  - `memory-candidate-extractor.ts` 五条财务正则——`PERIOD_RE`（第 21 行）、`ACCOUNT_SET_RE`（22）、`BALANCE_RE`（23）、`CURRENCY_AMOUNT_RE`（24）、`FINANCIAL_RESULT_RE`（25）。删任何一条 = 记忆提取器对财务事实变聋。
  - `hasFinancialFigure`（runtime.ts 定义，出口校验用；存在性由 `docs-reality.test.ts` 钉住——行号引用已按执行纪律 4 废止）。
  - ~~Wave 2 之前的 `KEY_ARG_FLAGS`（`serve-gate.ts:72`，`['--query', '--period', '--subject-code']`）——读 `operations.json` 的 args 规格后退役，退役前挂"遗留待清"。~~ **已退役**（2026-09-27 Wave 2 Lane D）：`describeKeyArgs` 改查平台 `operation list --json` 的 args 规格（flag→style 是平台数据），宿主零 flag 名单。见 debt-ledger D-012。

**闭环判据**：**非防御命中 = 0；防御项 100% 挂"防御排除"标签**（`hasFinancialFigure`、五条正则逐条在册）。

---

### L2 协议单一来源

**陈述**：跨仓协议事实（plan 形状 / 调用形式 / 网关名 / keyArgs / 错误 correctForm）由**平台机器可读地拥有**，宿主**消费不抄写**。散文不是编译器——同一事实抄几份，模型压力下就静默选一份信，漂移不报错。

**机械守卫**：`grep -rn "bin/17dz" packages/*/src apps/server --include='*.ts' | grep -v '\.test\.ts'` 计数**只减不增**；镜像表存在性检查（错误码表 / KEY_ARG_FLAGS 不得在宿主另立真相源）。

**当前违例**：

- **网关名 `bin/17dz`：已收敛至 1（配置缺省值）**——非测试 src 里只剩 `packages/agent/src/platform-contract.ts` 的 `GATEWAY_INVOCATION` 常量一处，其余全部由它派生（消息文本与提示词不再各抄一份）。历史窗口内曾 20→35 增长（+15，+75%，违反只减不增），增长源=错误码表与提示词的消息文本（`error-codes.ts` 0→7、`plan-runtime.ts` 1→7、`operation-labels.ts` 0→1、`context.ts` 2→3）——已由配置派生修复。
- **plan 草案形状的教学副本 6 处且自相矛盾（D-011）**——**已关**（2026-09-27 Wave 2 Lane D）。6 处收敛为 1 处：`error-codes.ts` 的 `planDraftExample()` 是唯一教学源（内容与平台 plan-schema.json 声明一致），表内 5 处与 `context.ts` worker 提示词 1 处全部由它派生；机械锁 = `plan-teaching.test.ts`（跨仓读平台 schema 断言形态合法 + 宿主解析器认同一形状 + 源文件零第二种形状字面量）。原闭环判据 `grep 'plan {"goal"'` → 0 已作废：Lane B 把 goal 收编为 schema 声明过的可选元数据，教学示例合法地含 goal。历史形状（D0 审计快照，保留备查）：fshine `error-codes.ts` 计划门错误表 5 处（`CORRECT_PLAN_SHAPE`/`PLAN_SUBCOMMAND_RESERVED`/`PLAN_JSON_NOT_OBJECT`/`PLAN_CALLS_NOT_ARRAY`/`PLAN_SHAPE_GATE_TEACHING`，其中 4 处教带 goal 形、1 处教无 goal 形）+ `context.ts` worker 系统提示词 1 处；17dz SKILL 那 1 处已由 Lane B④ 删除。矛盾要害即"同一张表两种形状 = 模型静默选一份信"。
- **错误码表镜像**：~~`error-codes.ts` 复刻平台正确形态文案（`AMBIGUOUS_SELECTION`/`NOT_FOUND_SELECTION` 一族）。~~ **已退化为渲染层**（2026-09-27 Wave 2 Lane D）：`NOT_FOUND_SELECTION` 只拼结构，措辞槽位优先取信封 `error.correctForm`；宿主表仅存"信封没带时的兜底"并挂"遗留待清"（D-002）。`AMBIGUOUS_SELECTION` 的用户可见事实已全部来自信封数据，平台给它的 correctForm 是解析方规则、不上屏。
- **KEY_ARG_FLAGS 镜像**：~~`serve-gate.ts:72`。~~ **已删**（2026-09-27 Wave 2 Lane D）：参数摘要改查平台 `operation list --json` 的 args 规格，无规格不发摘要（D-012）。
- **ask.ts 复刻装配层**：~~`scripts/ask.ts`（第 104–137 行）把 `apps/server/assembly.ts` 的 `planConfirmation` 装配照抄一遍。~~ **已消除**（2026-09-27 Wave 2 Lane D）：`apps/server/plan-confirmation-route.ts` 导出工厂 `createPlanConfirmationWiring({dbPath, platformRoot, planActivationSecret})`，assembly 与 ask.ts 共用；TTL 收敛为 `PLAN_CONFIRMATION_TTL_MS`（D-013）。

**闭环判据**：**宿主教学示例与平台声明逐字一致**（plan 草案形状的 6 处收敛为 1 处，从 17dz `src/execution/plan-schema.json` 派生，宿主只持指针/常量）；**解析器常量（`parsePlanCallsCommand` / 拦截正则，`plan-runtime.ts:272` 起）归属"警职执法"，挂标签保留**——平台看不到提交前的命令，替不了宿主解析；网关名 ≤1（配置派生）；错误码表 / KEY_ARG_FLAGS 镜像退化为渲染层（`correctForm` 优先取信封数据，镜像仅在无信封时存在且挂"遗留待清"）。

---

### L3 状态转换机械组装

**陈述**：用户可见的状态消息 = 宿主持**结构化事实**机械渲染；模型只答数据。模型对"状态转换"的发音权压到接近零——它泡在执行语言里，是执行语言与用户语言之间唯一的翻译器，压力下翻译退化，协议 JSON 就原样漏进最终回复。

**机械守卫**：探针的"执行语言指纹"断言（回复里出现脚本路径 / 原始错误码 / 门的规则引述即红）+ 回复模板零业务词；`server_path_leak` 测试覆盖普通回复、direct 收尾、转录与可检索 tool result。

**当前违例**：

- ~~**写确认摘要**：`context.ts` 的 `proposal_created` 分支由宿主渲染提案摘要~~ **已关**（2026-10-14 D 波 `3e5a36c`）：legacy 摘要渲染随写路径收敛整体删除；用户可见摘要 = 平台 `summaryText` 原样 + 宿主通用确认行（守卫 = `docs-reality.test.ts` 的 legacy 痕迹零命中判据）。
- ~~**F4 残留**：回合真有过执行时，出口校验被跳过，模型复读的协议 JSON 仍可能外发~~ **已关**（2026-09-27 Wave 2 Lane D）：`runtime.ts` 的复读检测（`looksLikeProtocolMaterial`，协议 JSON 首字段 recorded/step/next 的形状判据）**不依赖 execution**——有执行也拦，用宿主步骤事实/needs 线索替换，守夜事件 `execution_language_leak`（D-020；判据修订：未采纳"全量过 executionLanguageFingerprints 硬拦"，理由见台账）。
- ~~**D-109 终稿路径整理未覆盖 direct / 持久化出口**~~ **已关（D-113 补强）**：普通/direct 回复、保存的 assistant/toolResult 转录与可检索 tool result 共用 `server-paths.ts` 判据；SP1/SP3 与 tool-result 断言守住出口。

**闭环判据**：全部状态类回复走**码表 + 信封数据**（模型不发音）；F4 补齐出口校验（已达成：复读检测不依赖 execution，`runtime.test.ts` F4.1–F4.4 钉住）。

---

### L4 写路径保险箱

**陈述**：写提案的 schema / 域校验 / 确认摘要 / commit 读回**全归 17dz**；fshine 只持**不透明 payload** + 一套**通用确认状态机**（确认码 / 有效期 / principal / 计划版本绑定）。业务字段一旦住进编排层，加新业务域时这一层就要改——正是分层要消灭的东西。

**机械守卫**：走查测试「新增一条 payroll 写路径，fshine 侧改动 = 0」＋ `docs-reality.test.ts` 的 legacy 痕迹零命中判据（借贷合计 / `voucher.batch` / `finalizeProposal` / 退役开关）。

**当前违例**：**编排层侧已清**（2026-10-14 D 波 `3e5a36c`「写路径收敛为唯一形态」：`FSHINE_PROPOSAL_VIA_GATEWAY` / `FSHINE_PROPOSAL_COMMIT` 退役，`finalizeProposal` / `ChangeIntentRecord` 业务字段 / 借贷合计渲染整体删除；2026-10-16 对账核实全仓非测试零命中）：

- ~~`ChangeIntentRecord`（`packages/contracts/src/store.ts`）持 `voucher.batch` / `accountSet` / `period` / `summary` 业务字段~~ 已删。
- ~~`context.ts` 渲染借贷合计（第 360 行）~~ 已删（同 L1 / L3）。

**L4 整体保持开放**：闭环判据的 §17 写路径 latent 七项（D-031，17dz 侧执行器的数据正确性债）仍未闭环——编排层侧不再有违例，不等于写路径可以开放。

**闭环判据**：走查通过 + 写 e2e 改写全绿 + **§17 写路径 latent 七项在新结构里有守卫**——`rule-landing.md:326` 列的 S2（fill.js 批量契约只用 `contracts[0].accountSet`→凭证落错账套）、S3（gen-from-journal 账户下拉子串 + `.first()` 多候选不歧义）、S4（`--direction`/`--date-mode` 无枚举白名单，空转报"无符合条件" + exit 0）、S5③（fill `--start-no` NaN 静默丢起始号）、S7（upload-all 未找到凭证静默跳过仍 exit 0）、S9（voucher.js fuzzyFind 子串 + stripCity 静默采纳简称）、S10（parse-tianren-bills creditRules 未命中静默回落 1122）。

---

### L5 失败二分流 + 有界

**陈述**：失败只有两类——**模型可修**（结构化错误，带正确形态自愈）或**用户对齐**（needs，缺什么问什么）。无第三类。全回路有界：任何重试 / 循环 / 空转都有上限。

**机械守卫**：B 审计清单（每条失败路径归这两类之一）+ 熔断上限测试。

**当前违例**：**无**。今日已闭环，转为**不变量**。既有熔断：`MAX_PLAN_ZERO_EXEC_STEPS = 3`（`turn-state.ts`，连续拆解步既无执行痕迹也无 needs 交还即停；`writeClosed` 与停在确认门的步骤不计入）、`MAX_NEEDS_ROUNDS = 3`（`turn-state.ts`，单步按全局计、计划模式按步计）、`DECLINED_PLAN_LIMIT`（`pi-coding-driver.ts`，**自上次计划成功激活以来连续未激活的提交次数**达上限即收敛——D-099 语义修正：原注释与消息都写"连续拒绝"，实现却对每一跳通过形状解析与写关闭检查的提交自增、成功后不归零，数的是提交次数；现在唯一归零点在 `PLAN ACTIVE` 那一支，消息也照实说「连续 N 次提交方案均未激活」。残余代价：从不激活但连提 6 次以上的 worker 仍会被挡，那是熔断器的设计行为）。另有**非熔断的收尾提示**：步数帽 `DEFAULT_WORKER_STEP_CAP = 50`（`worker-step-cap.ts`，第 51 次放行送一次收尾 steer，之后不再重复；超帽不拒单，真正的硬上限仍是 wall-clock 预算与计划权重帽——标定见本节标定表新增行与 debt-ledger D-147）。

**闭环判据**：任何新失败路径进审计清单；新增无界回路即红。

---

### L6 零沉积

**陈述**：死代码 / 彩蛋 / 化石 / 空壳 / 陈旧日志不进主干。沉积不会报错，只会让后来人对着空目录和假数据猜意图。

**机械守卫**：新增 lint——**`packages/*` 的 `src` 为空 / 无实质源码即红**（注意：`mcp-fake`/`mcp-host` 的 `src` 目录**存在但是空的**，"无 src 目录"的措辞抓不到，已现场验证）+ 彩蛋 / 假数据模式扫描。

**当前违例**：

- ~~`packages/mcp-fake`、`packages/mcp-host`：`src/` 空、全仓零引用。~~ **已清**（目录整体删除；2026-10-16 对账核实，守卫 = `docs-reality.test.ts`）。D-050 已关。
- ~~`apps/server/reply.ts` 假数据彩蛋（第 9–16 行）：命中 `/发图|测试图片|图片/` 即返回硬编码 `renderBarChartPng([1200, 1850, 990, 2400, 1750, 3000, 1500, 2200])` + "幻晟 202607 凭证金额分布(模拟数据 · 图片通道演示)"。~~ **已清**（文件整体删除，`renderBarChartPng`/"模拟数据" 全仓非测试零命中；2026-10-16 对账核实，守卫 = `docs-reality.test.ts`）。D-051 已关。
- `step-text.ts` 6 个退役工具名死分支：`search_account_sets`/`get_current_accounting_period`/`list_vouchers`/`inspect_account_set`/`search_references`/`get_login_status`（现挂在 leak-lint 的字面量 if 白名单，`platform-leak-lint.test.ts:221-226`，属"遗留待清"）。
- 17dz 仓根 465KB 会话日志：`codex-session-01a0bd75-38f6-79f3-91ed-617ba8fe5ce9.md`（465137 字节，**已被 git 跟踪**）。
- `.env.real` 残留（fshine 仓根，1635 字节，已被 `.gitignore`——本地沉积、非主干，但有泄露面；**D-054：接受不修，仓库侧已关**——与台账同步，见 debt-ledger 2026-11-04 补充记录）。
- ~~fshine `.agents/skills/finance` 死技能（`name: finance`；运行态 `skillRoots` 指向 `.agents/skills-serve`、`businessSkillPath` 指向 `docs/business-skill.md`，零引用）。~~ 技能本体已删（Wave 1 `4362cef`）；**会复活它的配置模板引用已清**（2026-09-27 Wave 2 Lane D：`config/agent.example.yaml` 的 skillRoots 改指 `.agents/skills-serve` + `config.test.ts` 机械锁，D-055）。

**闭环判据**：清单清空（每一项要么删、要么有守卫 + 标签 + 限期）。

---

### L7 可信度可量化

**陈述**：可信度靠 eval 基线跑漂移，不靠审计轮次。人工复盘替代不了机器报漂移——17dz `docs/architecture.md:74` 自己写着 `### 已知短板（用「建评测」解决，勿用「加抽象」解决）`，第 75 行「端到端 eval 缺失……让**机器**报漂移，替代人工复盘」。

**机械守卫**：Tier-1 打分器已建（2026-10-16，D-060 关账）。`npm run eval` 一条命令：探针基线集（真模型 + mock 执行器：A1/A2/A3/A4/A5/B1/Y2）→ acceptance 写链（5.1→5.2 全链）→ LLM 评委 → 对 `scripts/eval/baseline.json` 逐项比对，回归 exit 1，输入缺失/语料-基线失配/旧格式报告 exit 2。语料库 `scripts/eval/corpus.jsonl`（存量事故→用例的版本化映射）与评委提示词 `scripts/eval/judge-prompt.md`（版本 = 内容 sha256 前八位，改一字即换版）进仓库；记分台 `.runtime/scores.jsonl` 每轮追加——探针写机械四维分量、打分器写评委分量与判定，行带 corpusVersion / judgePromptVersion / judgeModel 三元组，三元组一变分数即不可比、须重定基线。基线重定唯一入口 `scripts/eval/score.ts --write-baseline`（既有 strict 用例 ok 翻转即拒绝烤入）；标定批（尺子校准）随 commit 手改 + 台账留痕。

**当前违例**：**无**（转为不变量）。已知边界（登记不修，非违例）：

- 默认基线集 = 探针 7 例 + 写链 1 组；D1（2048 面）/Y1（纠错串台）在语料登记、`inBaseline=false`——进基线须补 baseline 项并跑一轮取值。
- 评委与被评模型同源（LLM_MODEL）；独立评委走 LLM_JUDGE_MODEL，切换须重定基线。
- 评委 0 分下限不设硬门（±1 容差在 0-2 量表上的诚实局限），漂移靠 scores.jsonl 轨迹暴露；同一转录评委复跑观测到一例 ±2 分差（B1 卫生 0→2）——**机械层是可复现骨干，评委层是粗门限 + 轨迹**。
- 机械与评委两分量独立：A4 三轮里评委两轮给卫生 0（「平台返回/无候选」技术报告口吻）而机械指纹不报——独立证据正是设计意图。

**闭环判据**（已达成，2026-10-16）：基线分可复现（三轮实测：机械分量稳定用例逐位一致、写链布尔面三轮全同；同转录评委复跑一致，一例超容差分差如实登记在 D-060）；回归有阈值（dims 上限 / judge 下限−容差 / 写链布尔面 / okMode 四类）；**评委提示词与语料库版本化进仓库**；**存量事故各一条用例**（围栏→写链全链、驼峰→Y2 科目回落族、抽象泄漏→A3/A4、2048→D1 观察面、复读→A2/A4、实体串台→A2）。

---

## 控制的标定审查

**陈述**：每一道控制（门 / 限 / 帽 / 校验）都不是"加了就更安全"。控制是**带标定的防御**——标定错了，防御就会拦正当行为、放危险行为，或者两者同时发生。因此每道控制在立项与每次复审时必须回答三个问题：

1. **硬还是软？** 硬 = 代码级强制（确定性拒绝，模型绕不过）；软 = 提示词/约定约束（依赖模型配合）。软控制不是控制，是**请求**——它可以作为硬门建成前的过渡，但必须登记激活条件与闭环判据（见 D-066）。
2. **标定依据是什么？** 哪次事故、哪个数据证明它该拦这个范围？答不出的控制 = 未经质疑的假设（2048 帽的教训：一个从没被核对的常数会在仓库里腐烂十年）。
3. **它误拦什么正当行为、被拦方的自愈路径是什么？** 每道硬门都要写明"合法但会被拦的形状"，以及被拦的一方（worker / 模型 / 用户）靠什么恢复到正轨——没有自愈路径的硬门会把死锁当安全。

**答不出的控制登记为待办**（debt-ledger），不许以"先加上再说"的状态留在主干。

**机械守卫**：无（本条是走查维度）。但三个问题的答案必须落在代码注释与台账里——每道控制的注释要写"为什么拦这个范围"，correctForm / 拒绝消息要写"被拦方怎么自愈"（L5 的自愈通道正是第三问的落地）。

**2026-09-27 当天现形的三只案例**（实例，供后续控制对标）：

| 控制 | 硬/软 | 标定依据 | 误拦什么正当行为 → 自愈路径 |
|---|---|---|---|
| **2048 帽**（`MAX_REPLY_BYTES`，channel-wecom `text.ts`） | 硬（无声截断） | **无从考据**——常数是抄来的，平台 SDK README 写明 20480，从未有人核过 | 误拦：超过约 600 汉字的正常回复被**无声**截断，用户拿不到完整答案；自愈路径：无（没有截断标记、没有日志）——这正是它烂掉的原因。已修：20480 + 截断标记 + 守夜事件（D-021/D-022 已关） |
| **实体门标定**（`validatePlanEntities`，turn-contract.ts） | 硬（fail-closed） | 真事故：flash 模型幻觉过账套名——门禁的逐字溯源正是那次事故的修法，功能必须保留 | 误拦：连续会话里"用户上一轮亲自查过的对象，本轮只补一个范围编码"（消息里没有对象名 → 三个来源全空 → 判死，用户被要求重新报名字）；自愈路径：修复前**没有**（死局）。已修：第四来源 `sessionEntities`（执行过的 calls 快照 + 澄清选定的候选，只收用户亲自操作/确认过的）+ correctForm 正路径（先名称检索让平台响应携带规范名再提交）。**这是标定修复不是放宽**：进 haystack 的每条都有用户来源与确立轮次可审计（D-068 已关） |
| **账套读授权软限制**（accountSetScope 名单模式，context.ts `workerSystemPrompt`） | **软**（仅提示词一句"不得查询或操作名单外对象"；写路径同场景是硬门——capability + 名单非空即拒） | Stage 1–3 单用户全量授权下"够用"——从未按多用户标定过 | 当前不误拦（软控制的危险方向是**漏拦**）：多用户激活后名单外读操作没有任何代码级拦截。激活条件 = Stage 4 多用户；闭环 = 读路径硬门（D-066 待办） |
| **步数帽 50**（`worker-step-cap.ts`，第 51 次放行送收尾 steer） | **硬触发、软后果**（触发是代码级确定性；后果只是提示，不拒单、不停轮） | **无事故/数据标定**——50 是可配置的默认值（`stepCap` 选项 / `FSHINE_WORKER_STEP_CAP`，非法值回退 50），复用 90% 预算收尾同款提示；按本节纪律，答不出数据依据的控制应登记为待标定（见 D-147），不得写成经实测标定 | 误拦：合法长任务（>50 次廉价调用）会被提前催收尾，可能交付未完成；自愈路径：提示不拒单，worker 可继续，续跑靠交接文件；操作方可调大 cap。反向缺口：忽略提示的 worker 不会被拦，帽不是硬上限 |
| **提案复核 fail-closed**（`context.ts` 创建路径，`92f7ed8`） | **硬**（无驱动 / 无 schema / 不一致 → 不发确认码、不落意图，fail-closed） | P2 前状态的洞：`proposal_review_skipped` 分支允许无复核继续（生产装配当时未接线、schema 取问接口缺失）；`92f7ed8` 以装配注入 + schema 取问关掉该洞 | 误拦：平台未下发 schema 或驱动未注入时，合法提案也被拦，且文案只说请重新发起录入（确定性死循环，见 D-149）；自愈路径：**目前缺失**——无同提案重试、无可行动信息；workaround 是运营先核查 `operation list --json` 的 `proposal.create` 行是否带 `proposalSchema`，确认平台已修复后再重发，否则每次重发都会新建一个被遗弃的平台提案 |

**纪律**：新控制进主干前把三问的答案写进它的注释；老控制每次被事故触及时重答三问——重答发现标定与现状不符的，按"标定修复"处理（收窄或修正出处范围），不拆控制本身（用户已明确否决"拆安全机制"式修法）。

---

### 实体门标定复审（2026-10-14，D-085 / D-086）

同一条律法要求"老控制每次被事故触及时重答三问"。2026-10-13 写路径真模型三轮实测触发了实体门，复审结论如下——两个方向各有一个实证，且都不是"该不该有这道门"的问题。

| 控制 | 硬/软 | 标定依据 | 误拦/漏拦什么正当行为 → 自愈路径 |
|---|---|---|---|
| **实体门标定复审**（`validatePlanEntities`，`turn-contract.ts`） | **硬**（fail-closed，代码级确定性拒绝，模型绕不过） | **误拦方向**：42 个历史验收库里单请求 tool_call 数 9/11/13/21/26/26/32/34/37/39/40/47/**87**，而 haystack 只取"最后 20 条"平台响应——早期响应里确立的实体静默滑出判定材料；单条又按**保头**截 20 000 字符，而真正作用在转录上的是 SDK bash 工具的保尾弃头、`RESULT` 信封在末行，读头只得到中段。终局：假拒 → 重试 → `DECLINED_PLAN_LIMIT` → worker 放弃（D-085）。**漏拦方向**：门自己的拒绝理由逐字带 offending token，经 SDK 变成 tool_result 回灌 haystack，"先故意提一个越权实体、拿到拒绝理由、再原样提一次"就能过（D-086，改前驱动级实证：第二次提交确实放行） | **误拦（已修）**：长任务里"早期平台响应里确立的实体"，以及被 SDK 自动压缩摘出转录的实体。自愈路径 = 覆盖判据改为"本任务迄今全部"（转录通道 ∪ 宿主账本通道），条数窗口与保头截断一并删除；账本通道专治自动压缩把早期 tool_result 整条删掉。**漏拦（已修）**：曾把"宿主写的拒绝理由"当成"平台返回过的证据"。自愈路径不变——理由仍逐字到 worker 眼前（它本来就是 worker 的工具输出），只是不再算实体证据；worker 改不动时 `needsClues` 把理由交给主 Agent 走 `ENTITY_OUT_OF_SCOPE.correctForm` 的正路径（先做一次名称检索让名称进平台响应）。**这是标定修复不是放宽**：两个方向各自独立——收窄的那一项只按 `toolCallId` 身份排除宿主自己拦下的调用，平台 CLI exit 3 的真错误信封仍是证据（`isError` 过滤被单测钉住"不能用"）；放宽的那一项只把覆盖从"最后 20 条"改成"本任务迄今全部"，逐字包含判据一字未动 |

**复审留下的两个已知面（登记不修，见台账 D-093）**：① 实体门只拦 `plan_submit`，所以一个 token 只要先经**直连网关调用**到达平台（平台的响应/错误信封回显它），或出现在 `ls` 的文件名清单里，就已经在 haystack 里了——随后的计划提交就能带上它。这一条**先于本波存在**，且堵它要么给 `ls` 加判据（输出是文件名清单，判据写不出来），要么把来源校验扩展到每次只读网关调用（那是"门该管多大范围"的设计问题，不是标定误差）。另：e2e 的实体门副本（`harness.ts:442-452`）只喂 `platformOutputs`，从来没有 20 条窗口、也从来不见宿主拦截文本，所以这两笔债它**结构上抓不到**——补法是把副本指向生产收集器，独立一件事。

---

## 执行纪律

1. **违例清单和基线数字来自一次双仓核实（6 真 1 半；证伪撤回经过见 `debt-ledger.md` 首条）。** 半真项：`FSHINE_*` 在 fshine `src` 已被 lint 禁绝，残留是 17dz `execution-env` 过渡期双读。证伪项：初核曾把 17dz `docs/architecture.md:74` 的「勿用「加抽象」解决」判为编造，跨仓复核已撤回——失误原因二选一或兼具：只 grep 了本仓、检索串丢了直角引号「」（搜 "勿用加抽象" 永远命中不了 "勿用「加抽象」解决"）。**因此：新增违例必须跨仓核实、检索保留原文标点。** L2 的 platform-contract.ts 注记就是本纪律的现场执行。
2. **判据若写得比机制真相更干净，执行者会把防御机制当违例删掉。** 所以标签制度先于清单、验收时逐条核对标签——一条命中该挂"防御排除"还是"警职执法"，删了它会不会让某道防线变聋 / 变瞎，是唯一裁决问题。
3. **每波只 revert 该波 commit，宪章与台账保留。** 债务状态是快照不是负担；宪章跨波有效，不随单波回退消失。
4. **文档主张与代码现实对账（守卫 = `packages/agent/docs-reality.test.ts`，2026-10-16 落地）。** 律法与台账里的可判主张只许三种形态：能 grep 的谓词、能被测试钉住的断言、明文标注"软提示不保证"的叙述——此外无第四种。**引用禁用行号、用符号名**：行号对插行免疫性为零，本次对账实证四起（工具面头注释两度未跟、`runtime.ts:1539` 指向拆分前文件、`runtime.ts:1260` 实为 1169、`context.ts:360` 指向已删违例）。**波次关账与律法"当前违例"节同 commit 更新**；守卫双向——当前违例消失而账未关即红（逼关账），已关判据翻红即闭环失效。存量散文引用的清理另登记台账 D-104。
