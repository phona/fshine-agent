# 隔离环境变量命名族裁定（2026-11-10，issue #20 切片 E）

> **2026-11-10 续篇（消费端边界收敛）**：本裁定第 2 条「B 类保留在 env」对**四个状态
> 路径**（`EXECUTION_MOCK_STATE` / `EXECUTION_PLAN_STATE` / `EXECUTION_PROPOSAL_STATE` /
> `EXECUTION_AUDIT_PATH`）**已被后续仲裁推翻**：状态位置归执行层自己（生产本就零注入），
> 仓内夹具的状态根改由测试专用 `--state-dir` flag 传入（探针经
> `FSHINE_EVAL_FIXTURE_STATE_DIR` 桥），夹具对这些名字的 `env2` 读取（含调试回退）已删。
> 本文其余部分（令牌面命名族、专名降级、C 类旋钮归属）仍生效；现行对账见
> `docs/environment-variables.md` §4/§4a/§4b。

状态：**生效**。本裁定推翻 `docs/environment-variables.md` §4 于 2026-11-05 写下的
「夹具专名不是重复别名，保留双名，不作合并」裁定。§4/§4b 已按本文重写；历史文本
留在这条 git 历史里，不回改（执行纪律 4：文档主张与代码现实对账）。

归属：issue #20 切片 E（B 类 per-run 隔离路径命名族统一）。影响面 = 夹具的
per-run 隔离路径与夹具令牌面（`docs/environment-variables.md` §4/§4b 的 7 + 10 条），
**不动** C 类 per-case 旋钮的承载（§9；它们不是隔离机制，也不是跨层接口）。

闭环框架：`docs/architecture-laws.md` 的 **L2（协议单一来源）** 与
**「控制的标定审查」三问**；对账纪律见执行纪律 4。

---

## 1. 被推翻的裁定（原文与它当时的前提）

2026-11-05 的 §4 原文主张：

> 夹具的 `DUMMY_*` 名不是 `EXECUTION_*` 的重复别名，而是**隔离语义**：夹具状态文件
> 与真实执行层状态文件同名会串——夹具用自己的名，宿主注入的 `EXECUTION_*` 名作回退
> 接受（`env2(DUMMY_*, EXECUTION_*)`），即夹具在宿主环境下也能被 host 注入的状态路径
> 驱动。合并成单一前缀会丢掉这层隔离，故保留双名，不作合并。

它当时的前提有三条，逐条在 2026-11-08 ~ 2026-11-10 的实测里失守：

1. **「名字不同 = 隔离」**：真实隔离机制是 **per-case 状态目录**（探针
   `isolatePlatformState` 每个用例注入一份新路径），不是名字不同。名字不同只改变
   缺省落点，不提供任何隔离。
2. **「专名优先是安全的」**：`env2(专名, 通用名)` 专名优先 + 评测进程继承 shell
   ambient = 任一 `DUMMY_*` 都能盖过 per-case 注入。issue #20 的实证：探针的
   `isolatePlatformState` 只覆盖四个 `EXECUTION_*`，而 `generic-mock.ts` 恰好在设
   `DUMMY_AUDIT_PATH`——若 shell ambient 有同名键，22 条用例静默共用一个状态/审计
   文件。切片 A 的 delete 堵住了这四个键，但**击穿面是顺序，不是漏列的那几个键**：
   只要专名仍优先，下一个新增或遗漏的 ambient 专名就再次静默改道。
3. **「双名的剩余价值」**：去掉「隔离语义」这个误判后，双名并存的剩余价值只剩一条
   ——「夹具在宿主只设 `EXECUTION_*` 的环境下也能被驱动」。这条价值由**规范名优先**
   完整保留，不需要专名优先。

再加一条架构理由（L2）：跨仓接口事实只许一个权威命名。`EXECUTION_*` / `DUMMY_*` /
`STOCK_*` / `FSHINE_*` 四族并行里，后两族夹具专名是同一接口的第二、第三套拼写，
正是 L2 说的「同一事实抄几份，压力下静默选一份信」。

## 2. 定案

1. **`EXECUTION_*` 是唯一规范族**。所有 B 类 per-run 隔离路径与夹具令牌面都有规范名；
   夹具的查找顺序统一为 `env2(规范名, 专名, 缺省)`——**规范名优先**。
2. **`DUMMY_*` / `STOCK_*` 降级为调试入口**：手工跑夹具（不经评测进程）时可用；
   夹具源码保留这些读取点，不删。它们在规范名之后生效。
3. **评测进程内不设 B 类专名**：探针、generic-mock、second-layer、plan-policy、
   generic-model-eval 对隔离路径与令牌面只注入规范名；探针启动时 delete ambient
   专名（切片 A 建立，切片 E 扩到令牌面）。C 类 per-case 旋钮仍用夹具专名（§9），
   不在此列。
4. **不变的事实**：B 类保留在 env（隔离机制本身，不进 `config/agent.yaml`）；
   C 类 per-case 旋钮的声明机制、缺省与现用 case 不变（§9）；夹具协议与判定语义不变。
5. **补齐的规范名**（stock 无回退专名的对应规范名，以及 dummy 的提案路径）：
   - `STOCK_STATE` → `EXECUTION_MOCK_STATE`
   - `STOCK_PROPOSAL_STATE` → `EXECUTION_PROPOSAL_STATE`
   - `STOCK_MEMORY_STATE` → `EXECUTION_MEMORY_STATE`
   - `STOCK_BREAKER_STATE` → `EXECUTION_BREAKER_STATE`
   - `STOCK_CACHE_STATE` → `EXECUTION_CACHE_STATE`
   - `DUMMY_PROPOSAL_STATE` → `EXECUTION_PROPOSAL_STATE`
   五条 stock 映射里 `EXECUTION_MOCK_STATE` 已在 §2 登记，`EXECUTION_PROPOSAL_STATE` /
   `EXECUTION_MEMORY_STATE` / `EXECUTION_BREAKER_STATE` 已在 §3 登记；
   `EXECUTION_CACHE_STATE` 是夹具缓存辅助组新登记的规范名（执行层的缓存目录 / TTL 是
   §3 的 `EXECUTION_CACHE_DIR` / `EXECUTION_CACHE_TTL_HOURS`，与状态文件不是同一事物）。

## 3. 旧读点 → 新读点对照

| 读点 | 旧行为 | 新行为 |
| --- | --- | --- |
| `dummy.cjs` `statePaths()` 主状态 | `env2(DUMMY_STATE, EXECUTION_MOCK_STATE)` | `env2(EXECUTION_MOCK_STATE, DUMMY_STATE)` |
| `dummy.cjs` 计划账本 | `env2(DUMMY_PLAN_STATE, EXECUTION_PLAN_STATE)` | `env2(EXECUTION_PLAN_STATE, DUMMY_PLAN_STATE)` |
| `dummy.cjs` 提案状态库 | `env(DUMMY_PROPOSAL_STATE)`（无规范名） | `env2(EXECUTION_PROPOSAL_STATE, DUMMY_PROPOSAL_STATE)` |
| `dummy.cjs` 审计 | `env2(DUMMY_AUDIT_PATH, EXECUTION_AUDIT_PATH)` | `env2(EXECUTION_AUDIT_PATH, DUMMY_AUDIT_PATH)` |
| `dummy.cjs` 令牌三键 | `env2(DUMMY_*, EXECUTION_*)` | `env2(EXECUTION_*, DUMMY_*)` |
| `dummy.cjs` 计划绑定两键 | `env2(DUMMY_*, EXECUTION_*)` | `env2(EXECUTION_*, DUMMY_*)` |
| `stock.cjs` 主状态 | `env(STOCK_STATE)`（无回退） | `env2(EXECUTION_MOCK_STATE, STOCK_STATE)` |
| `stock.cjs` 计划 / 审计 | `env2(STOCK_*, EXECUTION_*)` | `env2(EXECUTION_*, STOCK_*)` |
| `stock.cjs` 提案 / 记忆 / 熔断 / 缓存 | `env(STOCK_*)`（无回退） | `env2(EXECUTION_*, STOCK_*)` |
| `stock.cjs` 令牌三键 / 计划绑定两键 | `env2(STOCK_*, EXECUTION_*)` | `env2(EXECUTION_*, STOCK_*)` |
| `generic-mock.ts` `Ctx` | 注入 `DUMMY_*` 状态/令牌 | 注入 `EXECUTION_*` 状态/令牌 |
| `second-layer.ts` / `.test.ts` | 注入 `STOCK_*` 状态/令牌 | 注入 `EXECUTION_*` 状态/令牌 |
| `plan-policy.test.ts` / `generic-mock.test.ts` | 注入 `STOCK_*` / `DUMMY_*` 状态 | 注入 `EXECUTION_*` 状态 |
| `generic-model-eval.py` | 注入 `STOCK_*` 状态 | 注入 `EXECUTION_*` 状态 |
| 探针 `isolatePlatformState` | 四个 `EXECUTION_*` + delete 四个 `DUMMY_*` 状态专名 | 追加 `EXECUTION_PROPOSAL_STATE` 注入；ambient 专名清场扩到 §4 的全部七个（四个状态 + 三个令牌面）；定位待确认提案改读规范名 |

C 类旋钮（`DUMMY_PLAN_*` / `STOCK_PLAN_*` / `*_READBACK_SHORT` /
`*_PROPOSAL_TTL_SECONDS` / `*_PLAN_ID` / `*_REQUIRE_PLAN` 的按用例声明面）不在本表：
它们仍由 `fixture.env` / `fixture.planPolicy` 按用例声明（§9）。其中
`*_PLAN_ID` / `*_REQUIRE_PLAN` 的夹具读取是 `env2`，随本裁定一并改为规范名优先。

## 4. 失效条件（出现下列任一条时重开本裁定）

1. **隔离机制改变**：如果 per-case 隔离从「每例一份目录」改成「同一文件 + 键前缀
   命名空间」，那么「名字不同提供隔离」重新成立——但那要先改隔离机制本身，
   不是在夹具里恢复专名优先。
2. **同一进程同时驱动多个夹具且规范名必须指向不同文件**：单一规范族无法表达时，
   先设计按执行层的命名空间（例如 `EXECUTION_<LAYER>_*`），不得用专名优先兜底。
3. **规范名语义被真实执行层改写**：例如 `EXECUTION_MOCK_STATE` 不再是状态文件路径，
   规范名与夹具的对应关系失效——此时重新裁定该键的归属，不能一边沿用名字一边改语义。
4. **ambient 规范名被实证击穿 per-case 隔离**：这说明注入侧没覆盖全（探针漏了某个
   规范名），修注入侧；**不得**以「专名优先」当补丁。
5. **手工调试成为常规路径且必须与评测同进程**：专名会被规范名遮蔽。此时提供显式
   调试开关（例如 `EXECUTION_FIXTURE_DEBUG=1` 才读专名），不反转优先级。

## 5. 闭环判据与登记（architecture-laws）

- **L2（协议单一来源）判据**：夹具的每一处 B 类隔离读取都有且只有一个规范名；
  `DUMMY_*` / `STOCK_*` 只作为第二顺位调试入口存在。机检：夹具源码的
  `env2` 第一参数必须是 `EXECUTION_*`；评测注入点（探针 + eval 脚本 + 两条链的
  harness）不得把 B 类专名作为第一选择写入子进程 env。
- **控制的标定审查三问**（`architecture-laws.md` 的《控制的标定审查》节）：
  1. **硬还是软**：硬。夹具 `env2` 顺序反转是代码级优先级，不受模型或调用方影响；
     探针的 ambient delete 是代码级清场。
  2. **标定依据**：issue #20 的实证击穿面（ambient `DUMMY_AUDIT_PATH` +
     `generic-mock.ts` 正在设它），以及切片 A 的回归锁
     （`scripts/probe-real-agent.test.ts` 的 ambient 击穿组）。不是「加了更安全」，
     是「不加会静默共用状态文件」。
  3. **误拦什么正当行为、自愈路径**：误拦 = 手工跑夹具时若同时 export 了规范名和
     专名，专名被忽略。自愈 = 手工调试只 export 专名（此时规范名缺省，专名生效），
     或用失效条件 5 的显式调试开关；评测进程由 `cases.yaml` 的 per-case 声明驱动，
     不需要碰专名。
- **执行纪律 4（文档-代码对账）**：本裁定、`docs/environment-variables.md` §4/§4b、
  夹具与注入侧同 commit 更新；条目数按夹具 `env()` / `env2()` 实际读取点逐个核对。
- **机械证据**（本切片实测，命令见 commit 正文）：
  - `scripts/eval/env-doc-reconciliation.test.ts`：§4/§4b/§9.1/§9.2/§9.3 条目与两夹具
    `env()` / `env2()` / `num()` 读取点双向对账（issue #20 验收 4 的可执行对象；
    变异验证：改一条 §4 条目即红，恢复即绿）。
  - `node --import tsx scripts/eval/second-layer.ts`（stock 链）
  - `npm run eval:generic-mock`（dummy 26 例）
  - `npx vitest run scripts/eval/generic-mock.test.ts scripts/eval/second-layer.test.ts scripts/probe-real-agent.test.ts scripts/eval/plan-policy.test.ts`
  - 探针 ambient 回归锁：预置四个状态路径 + 三个令牌面的 ambient 专名 →
    `isolatePlatformState` 后专名全部消失、规范名落到 per-case 目录、
    `restorePlatformState` 原样恢复。
  - 手工顺序核验（不入仓）：同时设规范名与专名跑夹具，落点只出现规范名文件；
    只设专名时调试入口仍生效（dummy 用审计路径、stock 用主状态文件；令牌面用
    dummy 的 prepare→commit 验证规范名优先与专名回退两种情况都可用）。
