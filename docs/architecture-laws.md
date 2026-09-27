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

**机械守卫**：`packages/agent/platform-leak-lint.test.ts` 的业务词预算。词表现为 6 词——`BUSINESS_WORD_RE = /应收|凭证|科目|账套|期间|目录/g`（该文件第 84 行）——**本波扩到含 `税号`/`财务`/`借贷`**（今天 3 处真违例正是这三个词，因为它们此刻不在词表里所以漏网）。命中项**按四标签分类断言**：非防御命中必须为 0，防御命中必须 100% 挂"防御排除"。

**当前违例**：

- **真违例（3 处，扩词后即被守卫抓到，须清）**：
  - `packages/agent/src/runtime.ts:1539` — `'你是企业财务助手和面向用户的主 Agent。'`（**财务**）。Lane C 本波清。
  - `packages/agent/src/error-codes.ts:158` — `text: '没有找到匹配“{query}”的对象。请确认准确名称（或编号/税号）后我再查。'`（**税号**；直角引号 `“”` 为原文）。Lane C 本波清。
  - `packages/agent/src/context.ts:360` — `` `- 条目：${proposal.summary.count} 条，借贷合计各 ${proposal.summary.credit} 元` ``（**借贷**）。同时是 L4 违例，Wave 3 结构性了结。
- **防御排除（不得删、须挂标签）**：
  - `memory-candidate-extractor.ts` 五条财务正则——`PERIOD_RE`（第 21 行）、`ACCOUNT_SET_RE`（22）、`BALANCE_RE`（23）、`CURRENCY_AMOUNT_RE`（24）、`FINANCIAL_RESULT_RE`（25）。删任何一条 = 记忆提取器对财务事实变聋。
  - `hasFinancialFigure`（`runtime.ts:1260` 定义，用于 771/852/888/1277 的出口校验）。
  - Wave 2 之前的 `KEY_ARG_FLAGS`（`serve-gate.ts:72`，`['--query', '--period', '--subject-code']`）——读 `operations.json` 的 args 规格后退役，退役前挂"遗留待清"。

**闭环判据**：**非防御命中 = 0；防御项 100% 挂"防御排除"标签**（`hasFinancialFigure`、五条正则逐条在册）。

---

### L2 协议单一来源

**陈述**：跨仓协议事实（plan 形状 / 调用形式 / 网关名 / keyArgs / 错误 correctForm）由**平台机器可读地拥有**，宿主**消费不抄写**。散文不是编译器——同一事实抄几份，模型压力下就静默选一份信，漂移不报错。

**机械守卫**：`grep -rn "bin/17dz" packages/*/src apps/server --include='*.ts' | grep -v '\.test\.ts'` 计数**只减不增**；镜像表存在性检查（错误码表 / KEY_ARG_FLAGS 不得在宿主另立真相源）。

**当前违例**：

- **网关名 `bin/17dz`：33 行 / 8 文件**（基线，只减不增）。8 文件：`pi-coding-driver.ts`(3)、`context.ts`(3)、`error-codes.ts`(7)、`plan-runtime.ts`(7)、`operation-labels.ts`(1)、`serve-gate.ts`(8)、`apps/server/commit.ts`(3)、`apps/server/assembly.ts`(1)。目标退到 ≤1（配置派生）。
- **plan 形状散文副本**（跨仓逐字核实，真实位置如下）：
  - fshine `packages/agent/src/error-codes.ts` 计划门错误表——`CORRECT_PLAN_SHAPE`（第 54 行）+ 5 处 `correctForm`/`text`（62/66/72/80/84/190），同一形状字符串在错误表里重复。
  - fshine `packages/agent/src/context.ts:693` worker 系统提示词的教学句（`bin/17dz plan {"goal":"…","calls":[…]}…`）。
  - 17dz `.agents/skills/automation-orchestrator/SKILL.md:36` 草案教学（`` `{"calls":[{"operation":"voucher.query-saved","args":["账套名","YYYYMM"]}]}` ``）。
  - > **核实注记（执行纪律①的现场示例）**：方案初稿记「含 platform-contract.ts 注释里那处」，**跨仓 grep 证伪**——`platform-contract.ts`（唯一契约适配层）只持 RESULT **输出**信封与错误码 / 选择码集合（自第 5 行起），零 `plan`/`goal`/`calls`；计划**输入**形状的散文副本不在该文件。真实副本是上列三处。不跨仓核实，就会把"应该在哪儿"当成"实际在哪儿"写进宪章。
- **错误码表镜像**：`error-codes.ts` 复刻平台正确形态文案（`AMBIGUOUS_SELECTION`/`NOT_FOUND_SELECTION` 一族）。
- **KEY_ARG_FLAGS 镜像**：`serve-gate.ts:72`。
- **ask.ts 复刻装配层**：`scripts/ask.ts`（第 104–137 行）把 `apps/server/assembly.ts` 的 `planConfirmation` 装配照抄一遍。

**闭环判据**：**示例 / 教学描述 0 份**；**解析器常量（`parsePlanCallsCommand` / 拦截正则，`plan-runtime.ts:272` 起）归属"警职执法"，挂标签保留**——平台看不到提交前的命令，替不了宿主解析；网关名 ≤1（配置派生）；错误码表 / KEY_ARG_FLAGS 镜像退化为渲染层（`correctForm` 优先取信封数据，镜像仅在无信封时存在且挂"遗留待清"）。

---

### L3 状态转换机械组装

**陈述**：用户可见的状态消息 = 宿主持**结构化事实**机械渲染；模型只答数据。模型对"状态转换"的发音权压到接近零——它泡在执行语言里，是执行语言与用户语言之间唯一的翻译器，压力下翻译退化，协议 JSON 就原样漏进最终回复。

**机械守卫**：探针的"执行语言指纹"断言（回复里出现脚本路径 / 原始错误码 / 门的规则引述即红）+ 回复模板零业务词。

**当前违例**：

- **写确认摘要**：`context.ts` 的 `proposal_created` 分支（第 355–362 行）由宿主渲染提案摘要——随 L4 一并迁到执行层产出的不透明 payload。
- **F4 残留**：回合真有过执行时，出口校验被跳过，模型复读的协议 JSON 仍可能外发（`rule-landing.md:326`：「fshine F4 残留（回合真有过执行时出口校验跳过，模型复读仍可能外发——待单独一刀）」）。

**闭环判据**：全部状态类回复走**码表 + 信封数据**（模型不发音）；F4 补齐出口校验。

---

### L4 写路径保险箱

**陈述**：写提案的 schema / 域校验 / 确认摘要 / commit 读回**全归 17dz**；fshine 只持**不透明 payload** + 一套**通用确认状态机**（确认码 / 有效期 / principal / 计划版本绑定）。业务字段一旦住进编排层，加新业务域时这一层就要改——正是分层要消灭的东西。

**机械守卫**：走查测试「新增一条 payroll 写路径，fshine 侧改动 = 0」。

**当前违例**：

- **`ChangeIntentRecord`**（`packages/contracts/src/store.ts`）：`kind: 'voucher.batch'`（第 238 行）、`accountSet`（239）、`period`（240）、`summary: { count; debit; credit }`（243）——业务字段住了编排层。
- **`context.ts` 渲染借贷合计**（第 360 行）：写确认摘要由编排层拼装（同 L1 / L3 违例）。

**闭环判据**：走查通过 + 写 e2e 改写全绿 + **§17 写路径 latent 七项在新结构里有守卫**——`rule-landing.md:326` 列的 S2（fill.js 批量契约只用 `contracts[0].accountSet`→凭证落错账套）、S3（gen-from-journal 账户下拉子串 + `.first()` 多候选不歧义）、S4（`--direction`/`--date-mode` 无枚举白名单，空转报"无符合条件" + exit 0）、S5③（fill `--start-no` NaN 静默丢起始号）、S7（upload-all 未找到凭证静默跳过仍 exit 0）、S9（voucher.js fuzzyFind 子串 + stripCity 静默采纳简称）、S10（parse-tianren-bills creditRules 未命中静默回落 1122）。

---

### L5 失败二分流 + 有界

**陈述**：失败只有两类——**模型可修**（结构化错误，带正确形态自愈）或**用户对齐**（needs，缺什么问什么）。无第三类。全回路有界：任何重试 / 循环 / 空转都有上限。

**机械守卫**：B 审计清单（每条失败路径归这两类之一）+ 熔断上限测试。

**当前违例**：**无**。今日已闭环，转为**不变量**。既有熔断：`MAX_PLAN_ZERO_EXEC_STEPS = 3`（`runtime.ts:91`，连续拆解步既无执行痕迹也无 needs 交还即停）、`MAX_NEEDS_ROUNDS = 3`（`runtime.ts:80`）、`DECLINED_PLAN_LIMIT`（`pi-coding-driver.ts:494`，计划被连续拒绝即收敛）。

**闭环判据**：任何新失败路径进审计清单；新增无界回路即红。

---

### L6 零沉积

**陈述**：死代码 / 彩蛋 / 化石 / 空壳 / 陈旧日志不进主干。沉积不会报错，只会让后来人对着空目录和假数据猜意图。

**机械守卫**：新增 lint——**`packages/*` 的 `src` 为空 / 无实质源码即红**（注意：`mcp-fake`/`mcp-host` 的 `src` 目录**存在但是空的**，"无 src 目录"的措辞抓不到，已现场验证）+ 彩蛋 / 假数据模式扫描。

**当前违例**：

- `packages/mcp-fake`、`packages/mcp-host`：`src/` 空、全仓零引用。
- `apps/server/reply.ts` 假数据彩蛋（第 9–16 行）：命中 `/发图|测试图片|图片/` 即返回硬编码 `renderBarChartPng([1200, 1850, 990, 2400, 1750, 3000, 1500, 2200])` + "幻晟 202607 凭证金额分布(模拟数据 · 图片通道演示)"。
- `step-text.ts` 6 个退役工具名死分支：`search_account_sets`/`get_current_accounting_period`/`list_vouchers`/`inspect_account_set`/`search_references`/`get_login_status`（现挂在 leak-lint 的字面量 if 白名单，`platform-leak-lint.test.ts:221-226`，属"遗留待清"）。
- 17dz 仓根 465KB 会话日志：`codex-session-01a0bd75-38f6-79f3-91ed-617ba8fe5ce9.md`（465137 字节，**已被 git 跟踪**）。
- `.env.real` 残留（fshine 仓根，1635 字节，已被 `.gitignore`——本地沉积、非主干，但有泄露面）。
- fshine `.agents/skills/finance` 死技能（`name: finance`；运行态 `skillRoots` 指向 `.agents/skills-serve`、`businessSkillPath` 指向 `docs/business-skill.md`，零引用）。

**闭环判据**：清单清空（每一项要么删、要么有守卫 + 标签 + 限期）。

---

### L7 可信度可量化

**陈述**：可信度靠 eval 基线跑漂移，不靠审计轮次。人工复盘替代不了机器报漂移——17dz `docs/architecture.md:74` 自己写着 `### 已知短板（用「建评测」解决，勿用「加抽象」解决）`，第 75 行「端到端 eval 缺失……让**机器**报漂移，替代人工复盘」。

**机械守卫**：Tier-1 打分器（评委提示词 + 语料库版本化进仓库，跑分可复现）。

**当前违例**：**未建**。

**闭环判据**：基线分可复现、回归有阈值、**评委提示词与语料库版本化进仓库**、**今日全部事故各一条用例**。

---

## 执行纪律

1. **违例清单和基线数字来自一次双仓核实（6 真 1 半；证伪撤回经过见 `debt-ledger.md` 首条）。** 半真项：`FSHINE_*` 在 fshine `src` 已被 lint 禁绝，残留是 17dz `dz-env` 过渡期双读。证伪项：初核曾把 17dz `docs/architecture.md:74` 的「勿用「加抽象」解决」判为编造，跨仓复核已撤回——失误原因二选一或兼具：只 grep 了本仓、检索串丢了直角引号「」（搜 "勿用加抽象" 永远命中不了 "勿用「加抽象」解决"）。**因此：新增违例必须跨仓核实、检索保留原文标点。** L2 的 platform-contract.ts 注记就是本纪律的现场执行。
2. **判据若写得比机制真相更干净，执行者会把防御机制当违例删掉。** 所以标签制度先于清单、验收时逐条核对标签——一条命中该挂"防御排除"还是"警职执法"，删了它会不会让某道防线变聋 / 变瞎，是唯一裁决问题。
3. **每波只 revert 该波 commit，宪章与台账保留。** 债务状态是快照不是负担；宪章跨波有效，不随单波回退消失。
