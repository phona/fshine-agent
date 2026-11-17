# docs 清理候选清单（R5 文档审计 · 只读汇总）

> **性质**：本文件是 R5「docs 瘦身」轨的**只读审计汇总产出**。它**只分类、只登记候选、只给建议处置**——**不删除、不移动、不改写任何现有文档或代码**。实际清理须待 owner 指令（产品修复与 E2E 结束后另开清理 PR）。
> **新增边界**：本文件是**唯一新增文件**；同一审计在其它轨产出的候选件（如 `docs/r5-docsaudit-candidates.md`，在平行分支 `arch/r5-docsaudit`）与本文件同源，本文件即「唯一新增候选清单」的合入位置。
> **基线**：分支 `arch/r5-cleanup-candidates`，起点 = `arch/integration` 启动时 HEAD `8d29e77`（工作区起点与其它 R5 轨一致）。
> **判定纪律**：任何「已过期 / 已被取代」的判断都在**当前代码**里验证过（每行依据给 `文件:行号` 或代码事实）；**不因文档创建较早就判过期**。
> **E4 冻结面**：decision-log 历史裁决、已预注册实验、已落盘 Eval、历史验收报告、仍作 issue/PR/测试依据的设计记录、AGENTS 冻结面——**一律不因「看起来过期」删除或重写**。
> **E3 不做框架**：不新建元数据系统、自动同步机制或强制检查框架；导航只做指向、不复制维护。

---

## 〇、口径与统计速览

**分类口径（owner E1 表）**

| 类 | 含义 |
|---|---|
| **A 当前有效** | 仍是对应问题的现行权威 / 现行接口 / 现行入口。 |
| **B 历史证据** | 带日期的记录/档案，记录当期事实即正确，但不再代表现状；**不得因「看起来过期」删除**（E4）。 |
| **C 已被取代** | 主题内容已被后继机制/文档取代，且原文仍以现行时态自述。 |
| **D 临时产物** | 草稿 / 脚手架。 |
| **E 相互矛盾** | 与其他权威文档（decision-log / 现行代码）直接冲突且未加注记。 |

**建议处置口径**

| 处置 | 含义 |
|---|---|
| **保留** | 维持现状、无需动作。 |
| **更新** | 处置方向已明确（补失效注记 / 更正 / 重定向），但**须 owner 授权后方可执行**。 |
| **归档** | 建议移入归档目录（本轮无此建议，见 §三说明）。 |
| **删除** | 本轮**无**（E4 保护历史证据；独立证据见 §五）。 |
| **待裁决** | 处置方向本身**无法确认**（是否归档/保留），一律列此类、待 owner 裁定，不擅删。 |

**统计速览（全量 70 篇 = `docs/**` 68 篇 + 根 `AGENTS.md`/`README.md`；口径见 §五）**

| 保留 | 更新 | 删除 | 归档 | 待裁决 | 合计 |
|---|---|---|---|---|---|
| **63** | **3** | **0** | **0** | **4** | **70** |

---

## 一、文档清理清单表（全量 70 篇）

「依据」列给**代表性**来源（代码优先 `文件:行号`）。「风险」= 误处置（误删/误改）的后果。

### A. 当前有效（23）→ 建议处置：保留

| 路径 | 分类 | 处置 | 依据 | 风险 |
|---|---|---|---|---|
| `AGENTS.md` | A | 保留 | 进仓第一约束（哲学 / 职责边界 / 删除纪律 + 现状指针）；被 `.github/prompts/pr-review.md:27` 引用 | 低 |
| `README.md` | A | 保留 | 仓库门面与命令清单，与 `package.json` scripts 一致（`typecheck`/`test`/`ask`/`eval:user`） | 低 |
| `docs/index.md` | A | 保留 | 文档阅读入口；但只收录 22/70 篇（见 §四④ 与 finding F3） | 中（索引不完整，易漏读） |
| `docs/decision-log.md` | A | 保留 | 权威裁定与状态台账，自述「不删除旧条目」(:5)、维护规则(:1324)；被 `AGENTS.md`、`README.md`、`.github/workflows/eval-nightly.yml:7` 引用 | 低（E4 冻结面） |
| `docs/v0-architecture.md` | A | 保留 | 目标架构规格；文首含 2026-11-13 M4 注；正文 :155 与 :51-52 仍以现时态列宿主预算/计划门（见 §四①） | 中 |
| `docs/environment-variables.md` | A | 保留 | 现行环境变量清单；被 `config/agent.example.yaml:54` 引用 | 低 |
| `docs/methodology.md` | A | 保留 | 作业纪律与判据编号 | 低 |
| `docs/push-runbook.md` | A | 保留 | 公开推送 / 门禁 / 回滚操作入口（公开翻转未执行，待 owner） | 低 |
| `docs/product/r4-joint-interfaces.md` | A | 保留 | R4 联合接口 v1 冻结面；被 `packages/agent/src/task-registry.ts:14`、`task-runner.test.ts:2` 等逐条引用 | 低（契约语义面） |
| `docs/product/r4-acceptance.md` | A | 保留 | v1 预注册验收基线；被契约测试引用 | 低 |
| `docs/product/r4-stability-prereg.md` | A | 保留 | 预注册稳定性判据；被 `scripts/stab/{chaos,pressure,soak}.test.ts:4` 引用 | 低（预注册，E4） |
| `docs/product/r3-open-decisions.md` | A | 保留 | 待裁定登记（14 项）；被 `AGENTS.md:71`、`scripts/p0-redo-doc-scan.test.ts:6` 引用 | 低 |
| `docs/product/r4-slices.md` | A | 保留 | R4 最小架构与分片计划（P0–P8 现行依据） | 低 |
| `docs/product/p2a-task-contract.md` | A | 保留 | Task Registry 契约冻结记录 | 低 |
| `docs/product/gap-task-surface.md` | A | 保留 | 缺口 1 设计（现行依据件） | 低 |
| `docs/product/gap-main-skill.md` | A | 保留 | 缺口 2 设计（批准细化、未实施） | 低 |
| `docs/product/gap-compaction-window.md` | A | 保留 | 缺口 3 设计（已实施，接线依据） | 低 |
| `docs/product/manual-test-handbook.md` | A | 保留 | R4 手工测试手册（现行） | 低 |
| `docs/product/real-read-readiness.md` | A | 保留 | 真实只读接入准备档（未授权接入；现行就绪件） | 低 |
| `docs/product/real-shadow-runbook.md` | A | 保留 | 真实接入 shadow 演练 runbook | 低 |
| `docs/product/business-e2e-final-report.md` | A | 保留 | 三轴总报告（产品定义文档，`docs/decision-log.md:1299` §五十） | 低 |
| `docs/product/business-e2e-prereg.md` | A | 保留 | 阶段 2 预注册（先写死；`git log --numstat` total_deletions=0，E4） | 低（预注册，E4） |
| `docs/product/business-e2e-prereg-addendum.md` | A | 保留 | 预注册修订请求附录（供 owner 裁定；total_deletions=0，E4） | 低（预注册，E4） |

### B. 历史证据（44）→ 建议处置：保留（其中 4 篇无入站引用者 → 待裁决）

普通 B 类（40 篇，建议保留）——多数文首含 2026-11-12/11-13 状态或 M4 注，指向现行口径（`decision-log.md` §十三 / `AGENTS.md` 现状）：

| 路径 | 分类 | 处置 | 依据（代表性引用） | 风险 |
|---|---|---|---|---|
| `docs/architecture-laws.md` | B | 保留 | 头 2026-11-13 M4 注：18 守卫中 15 已退役；文首自述「律法与历史判据档案」 | 中（:63/:290-298 正文行仍现时态，见 §四②） |
| `docs/a2a-protocol.md` | B | 保留 | 头失效注记（M4）：契约类型 `a2a-protocol.ts` 已删 | 低 |
| `docs/execution-layer-interface.md` | B | 保留 | 头 2026-11-13 M4 注：历史接口蓝图 | 低 |
| `docs/execution-layer-admission.md` | B | 保留 | 头 2026-11-13 M4 注：历史准入清单 | 低 |
| `docs/v0-implementation-decisions.md` | B | 保留 | 文首「状态总注（2026-11-12）」 | 低 |
| `docs/debt-ledger.md` | B | 保留 | 头 2026-11-13 M4 注：历史台账；被 `.github/prompts/pr-review.md:27,46`、`scripts/ci.sh:23` 引用 | 低 |
| `docs/change-safety.md` | B | 保留 | 头 M4 注 + 状态总注；被 `.github/prompts/pr-review.md:36`、`scripts/ci.sh` 引用 | 低 |
| `docs/env-naming-ruling-20261110.md` | B | 保留 | 裁定正文保留；续篇推翻第 2 条 + M4 注 | 低 |
| `docs/rule-landing.md` | B | 保留 | 「状态总注（2026-11-12）」+ M4 注 | 低 |
| `docs/eval-mechanism-registry.md` | B | 保留 | M2/M4 状态：所列机制多已退役，按删除前记录保留 | 低 |
| `docs/manual-test-wecom.md` | B | 保留 | 头 2026-11-13 M2 注：`tests/e2e` 已删 | 低 |
| `docs/test-hardening.md` | B | 保留 | 头注明「覆盖的 `tests/e2e` 套件已整体删除，保留落地记录」 | 低 |
| `docs/e2e-ownership.md` | B | 保留 | 头 2026-11-13 M2 注；被 `scripts/ci.sh:18` 引用 | 低 |
| `docs/perf-baseline.md` | B | 保留 | 自述「工具已归档」；`package.json` 无 `perf:suite/perf:report`、`scripts/` 无 perf 文件 → 所述入口不可运行 | 低 |
| `docs/roadmap.md` | B | 保留 | 头「状态总注（2026-11-12）」 | 低 |
| `docs/interactive-session-plan.md` | B | 保留 | 头「状态总注（2026-11-12）」 | 低 |
| `docs/business-skill.md` | B | 保留 | 头「迁移状态（2026-11-12，Track D）」；仅被 `packages/agent/src/skills.ts:34` 当体积示例引用 | 低 |
| `docs/product/business-e2e-probe-report.md` | B | 保留 | 臂 0 探测当期读数报告 | 低 |
| `docs/product/e01-judge-fix.md` | B | 保留 | E01 判据修复当期记录 | 低 |
| `docs/product/m01-recut.md` | B | 保留 | M01 判据重切当期记录 | 低 |
| `docs/product/p0-assembly.md` | B | 保留 | 实施报告（当期交付记录） | 低 |
| `docs/product/p1-ledger.md` | B | 保留 | 实施报告 | 低 |
| `docs/product/p1-task-viewing.md` | B | 保留 | 切片报告 | 低 |
| `docs/product/p2b-display.md` | B | 保留 | 实施报告与 P2 验收状态表 | 低 |
| `docs/product/p2-result-delivery.md` | B | 保留 | 切片报告 | 低 |
| `docs/product/p3-human-redo.md` | B | 保留 | 切片报告（含 2026-11-14 命名加注） | 低 |
| `docs/product/p4-notifications.md` | B | 保留 | 实施报告 | 低 |
| `docs/product/p4-ops-console.md` | B | 保留 | 切片报告 | 低 |
| `docs/product/p5-resource-policy.md` | B | 保留 | 实施报告 | 低 |
| `docs/product/p6-task-runner.md` | B | 保留 | 实施报告 | 低 |
| `docs/product/p7a-ask-first.md` | B | 保留 | 实施报告 | 低 |
| `docs/product/r3-arc-regression.md` | B | 保留 | R3 收官回归认证报告 | 低 |
| `docs/product/r4-audit.md` | B | 保留 | R4 第一阶段现状审计报告 | 低 |
| `docs/product/r4-budget-consume.md` | B | 保留 | 实施报告（taskBudget 运行时计量） | 低 |
| `docs/product/r4-decisions-triage.md` | B | 保留 | 决策分诊记录 | 低 |
| `docs/product/r4-integration.md` | B | 保留 | 集成接线实施报告 | 低 |
| `docs/product/r4-p7b-acceptance.md` | B | 保留 | P7b 完整验收报告 | 低 |
| `docs/product/r4-shadow-dryrun.md` | B | 保留 | Shadow 演练报告 | 低 |
| `docs/product/r4-stability-report.md` | B | 保留 | 稳定性加固报告（配对预注册） | 低 |
| `docs/product/s4-stats-four-state.md` | B | 保留 | stats v2 四态口径切片记录 | 低 |

零入站引用的 B 类（4 篇，→ 待裁决，见 §三）——`grep` 除自引外无任何外部入站引用（命令见 §六）：

| 路径 | 分类 | 处置 | 依据 | 风险 |
|---|---|---|---|---|
| `docs/eval-baseline-refresh-20261107.md` | B | 待裁决（归档候选） | 零入站引用；所述工具已退役；E4 不删 | 低 |
| `docs/eval-harness-measurement-20261107.md` | B | 待裁决（归档候选） | 零入站引用；对象 `generic-model-eval.py` 已退役 | 低 |
| `docs/interaction-skills/result-assistance.md` | B | 待裁决（归档候选） | 零入站引用；文末「档案注记（decision-log 八）」 | 低 |
| `docs/interaction-skills/task-collaboration.md` | B | 待裁决（归档候选） | 零入站引用；文末「档案注记（decision-log 八）」 | 低 |

### C. 已被取代（2）→ 建议处置：更新

| 路径 | 分类 | 处置 | 依据 | 风险 |
|---|---|---|---|---|
| `docs/artifacts.md` | C | 更新 | 自述「状态：**已落地**」(:3)，但契约面无 `artifacts`/`cancel`：`packages/contracts/src/execution-contract.ts:66` 只有四态、`grep -iE 'artifact\|cancel' packages/contracts/src` 零命中；`docs/decision-log.md:683` 明写「四态，无 cancel/artifacts」；且 `docs/index.md:44` 仍把它列为「产物清单」 | **高**（把已删能力读成现行产物能力） |
| `docs/product/r4-slice-plan.md` | C | 更新 | 自述「已被 R4 统一任务书重映射」(:3)，但 `docs/product/s4-stats-four-state.md` 等仍引其 S4 口径，且无统一失效横幅 | 中 |

### D. 临时产物（0）

`git ls-files 'docs/**/*.md'` 共 68 篇，全部为正式文档，无草稿/脚手架类。临时产物（`.runtime/`、`tmp/`、`out/`）为 gitignored/untracked，**不在 `docs/**` 盘点范围**。

### E. 相互矛盾（1）→ 建议处置：更新

| 路径 | 分类 | 处置 | 依据 | 风险 |
|---|---|---|---|---|
| `docs/v0-functional-spec.md` | E | 更新 | 自述「状态：**当前实现基线**」(:3)，但正文 :47「Main Agent **申报**本轮需要委派」与 :50「**计划门**按重量决定…」均为已删机制（`AGENTS.md`「禁止新增 Planner/意图分类器」「写确认回环 ≠ 宿主计划门」；宿主计划门/预算梯子已归执行层，见 `execution-contract.ts:25`）；全文**无 M4/失效注记**；`docs/index.md:10` 仍把它列为「终局规格 → 功能规格与能力表」 | **高**（与现行代码/AGENTS 直接冲突且无注记） |

---

## 二、当前文档导航与唯一权威来源索引

> **原则（E3）**：只做**指向**，不复制内容、不新建索引框架。以下每格给「唯一权威来源」；同一问题只认一处，避免第二份真相。

| 主题 | 唯一权威来源（只指向） | 备注 |
|---|---|---|
| **架构 / 职责边界** | `AGENTS.md`（定位 / 职责边界 / 删除纪律）→ `docs/v0-architecture.md`（目标架构叙述）→ `docs/decision-log.md`（裁定与状态的**权威**） | `docs/architecture-laws.md` 是可执行判据档案，但多数守卫已退役（文首 M4 注），按历史读 |
| **当前能力与不支持项** | `README.md`（产品面命令）→ `docs/product/r3-open-decisions.md`（§一 现产品面 + 14 项待裁定）→ `docs/product/business-e2e-final-report.md`（功能边界轴） | 不支持项以 `README.md`「未验证」段 + `r3-open-decisions.md` 为准；`docs/decision-log.md:683` 为契约面口径 |
| **关键契约与扩展方式** | `packages/contracts/src/execution-contract.ts`（语义面：CapabilityManifest / ExecutionRequest / ExecutionOutcome 四态 / ExecutionClient）→ `docs/product/r4-joint-interfaces.md`（联合接口 v1 冻结面）→ `docs/environment-variables.md`（配置/环境变量清单） | 扩展方式＝执行层声明 operation；业务字段/命令归执行层（`AGENTS.md`「改动归属」） |
| **开发 / 运行 / 测试** | `README.md`（命令：`npm run ci`/`typecheck`/`test`/`ask`/`tasks`/`ops`/`start`/`eval:user`）→ `docs/methodology.md`（作业纪律）→ `docs/push-runbook.md`（推送/门禁/回滚） | 评测入口与判据见 `scripts/eval/convergence-r1/README.md`（README 指到） |
| **未解决问题 / issue** | `docs/product/r3-open-decisions.md`（R3 收官待裁定 14 项 + 授权门 + 启动条件）→ `docs/decision-log.md`（逐条登记） | **未裁定项不自主推进**（`AGENTS.md` 指针原文） |
| **历史决策与评测证据入口** | `docs/decision-log.md`（全部裁定史）→ 预注册/证据：`docs/product/business-e2e-prereg*.md`、`docs/product/r4-stability-prereg.md`、`docs/product/r4-acceptance.md` → 机制登记 `docs/eval-mechanism-registry.md` | 评测证据当日报表入口（如 `eval-*-20261107`）已退役，仅作档案 |

**目录级指向**：

- `docs/**` 全量清单与分类 → 本文件 §一（唯一汇总）。
- 文档阅读入口（分组权威性标注）→ `docs/index.md`（注意其收录不全，见 §四④）。
- 平行审计快照 → `docs/r5-docsaudit-candidates.md`（若已合入；同源）。

---

## 三、待裁决清单（需 owner 裁定 / 授权；一律不擅删、不擅动）

### 3.1 处置方向本身无法确认（→「待裁决」4 项）

| 路径 | 建议备选 | 为何待裁决 |
|---|---|---|
| `docs/eval-baseline-refresh-20261107.md` | 归档 / 保留 | 零入站引用、所述工具已退役，但属 B 类历史证据（E4 禁删）；是否移入归档目录须 owner 定 |
| `docs/eval-harness-measurement-20261107.md` | 归档 / 保留 | 同上（对象 `generic-model-eval.py` 已退役） |
| `docs/interaction-skills/result-assistance.md` | 归档 / 保留 | 零入站引用；文末「档案注记」已声明不作生产能力，但归档与否未定 |
| `docs/interaction-skills/task-collaboration.md` | 归档 / 保留 | 同上 |

### 3.2 处置方向已明确，但执行须 owner 授权（→「更新」3 项）

| 路径 | 建议动作 | 为何须授权 |
|---|---|---|
| `docs/artifacts.md` | 补失效注记（指向 `execution-contract.ts` 四态 + `decision-log.md:683`）/ 或重定向 | 改写既有文档须 owner 指令；不擅动 |
| `docs/product/r4-slice-plan.md` | 补统一失效横幅（指向 `r4-slices.md`） | 同上 |
| `docs/v0-functional-spec.md` | 补失效/状态注记并更正 :47/:50 的现时态表述 | 同上（并含历史验收面，须谨慎） |

### 3.3 历史证据保护（本轮已核，**不列入待删**）

- `docs/decision-log.md` 历史条目（53 个 `## ` 章）——完好；自述「不删除旧条目」(:5)，维护规则「不得因 PR 已合删除条目」(:1324)。`git log --numstat` 显示 109 行删除，均为**状态字段更新**（非删条目），与维护规则一致。
- 已预注册实验 `business-e2e-prereg.md` / `business-e2e-prereg-addendum.md` / `r4-stability-prereg.md` —— `git log --numstat` total_deletions **= 0**。
- 其它 E4 面（已落盘 Eval、历史验收报告、仍作测试依据的设计记录）在 §一 均按 B 类保留登记。

> **归档建议（本轮不执行）**：若 owner 同意 3.1 的 4 项归档，建议**统一移入 `docs/archive/`**（单目录），不新建元数据面。当前无 `docs/archive/` 目录（`ls docs` 无 archive）。

---

## 四、代码与文档事实不一致事项（E6 交付第 6 项）

> 每项均已**在当前代码里验证**；引用给出 `文件:行号` 或可复现命令。

1. **`docs/v0-architecture.md` §8 把宿主预算/计划门画成现行职责** —— 正文 `:155`「通用闸口 | 预算 / 通知 / 确认 / 执行凭证」与 `:51-52`「计划门预算梯子 execute/notify/confirm/stop」以现时态列出；但 `packages/contracts/src/execution-contract.ts:25` 明写「**计划门与预算梯子归执行层，不在这里开第二份裁决面**」，且 `grep -E 'decideBudgetTier|evaluateAndActivatePlan|plan-submit|PLAN_CALL_MISMATCH|SCOPE_EXPANSION' packages apps`（非测试）**零命中**。文首 M4 注只覆盖 `committed-unverified.ts` 等模块，未覆盖 §8 的预算/计划门表述。

2. **`docs/architecture-laws.md` 正文行仍以在场守卫口径书写** —— `:63`（T5，引 `pi-coding-driver.ts` 的 `DEFAULT_READ_PROBE_CAP`）与 `:290-298`（实体门 `validatePlanEntities` / `turn-contract.ts`）以现行守卫口径书写；但 `grep -rn 'validatePlanEntities' packages apps scripts config` **零命中**，且这两处所指文件不在当前树。文首 2026-11-13 M4 注已声明「18 守卫中 15 已退役」，故注记在册，但**正文行本身未逐行加注**（不算删除理由，属「注记不全」）。

3. **`docs/artifacts.md` 自述能力面与契约不一致** —— `:3` 自述「状态：**已落地**」；但 `packages/contracts/src/execution-contract.ts` 无 `artifacts`/`cancel`（`grep -iE 'artifact|cancel' packages/contracts/src` 零命中），`:66` 只有四态；`docs/decision-log.md:683` 明写「四态，无 cancel/artifacts」。（= §一 C 类）

4. **`docs/v0-functional-spec.md` 正文与 AGENTS/现行代码冲突** —— `:3` 自述「当前实现基线」，但 `:47`/`:50` 写已删的「申报」「计划门」机制；`AGENTS.md` 明确「禁止新增 Planner / 意图分类器」并「写确认回环 ≠ 宿主计划门」。全文无失效注记。（= §一 E 类）

5. **`docs/index.md` 分组标注与实际状态不一致** —— `:10` 把 `v0-functional-spec.md` 列入「① 终局规格」，`:44` 把 `artifacts.md` 列入「④ 运行与验收 → 产物清单」，两处均**未带失效/历史警示**，与两文实际状态（E / C）不符；且索引仅收录 22/70 篇（`grep -oE '`docs/[A-Za-z0-9._/-]+\.md`' docs/index.md | sort -u | wc -l` = 22）。

6. **前向引用未落地** —— `docs/product/r4-stability-prereg.md:150` 引 `docs/product/r4-stability-manual.md`，该文件**不存在**（`[ -e ]` 判定 MISSING），实际产出为 `docs/product/manual-test-handbook.md`。其余「悬空」引用（`docs/architecture.md`、`docs/lifecycle-roadmap.md`）经判定为**跨仓引用**（另一平台仓），非本仓文档缺陷。

---

## 五、统计

**分类分布（合计 70 = `docs/**` 68 篇 + 根 2 篇）**

| A 当前有效 | B 历史证据 | C 已被取代 | D 临时产物 | E 相互矛盾 |
|---|---|---|---|---|
| **23** | **44** | **2** | **0** | **1** |

**建议处置分布（合计 70）**

| 保留 | 更新 | 删除 | 归档 | 待裁决 |
|---|---|---|---|---|
| **63** | **3** | **0** | **0** | **4** |

- **保留 63** = A 类 23 + B 类中有入站引用的 40。
- **更新 3** = C 类 2（`artifacts.md`、`r4-slice-plan.md`）+ E 类 1（`v0-functional-spec.md`）。
- **删除 0** = 无任何文档可确定安全删除：历史证据受 E4 保护，C 类主题虽被取代但仍有引用/历史价值，建议加注而非删。
- **归档 0** = 本轮不执行移动；4 篇零入站引用者列为「待裁决（归档候选）」。
- **待裁决 4** = B 类中零入站引用的 2 篇 eval 报告 + 2 篇 interaction-skills（处置方向未定）。

**核对**：23 + 44 + 2 + 0 + 1 = 70；63 + 3 + 0 + 0 + 4 = 70。✓

---

## 六、方法与边界

### 本轮实际运行的命令（只读）

- 文件盘点：`find docs -name '*.md' | wc -l` → **68**；`git ls-files | wc -l` → **312**；根文档 `ls *.md` → `AGENTS.md`、`README.md`。
- 契约事实：`cat packages/contracts/src/execution-contract.ts`；`grep -iE 'artifact|cancel' packages/contracts/src`（零命中）；`grep -n 'ExecutionStatus =' packages/contracts/src/execution-contract.ts` → `:66`。
- 已删机制核验：`grep -rn 'validatePlanEntities' packages apps scripts config`（零命中）；`grep -E 'decideBudgetTier|evaluateAndActivatePlan|plan-submit|PLAN_CALL_MISMATCH|SCOPE_EXPANSION' packages apps`（非测试，零命中）。
- 孤儿引用：对 `eval-baseline-refresh-20261107`、`eval-harness-measurement-20261107`、`interaction-skills/result-assistance`、`interaction-skills/task-collaboration` 做 `grep -rn`（除自引外零入站）。
- 索引覆盖：`grep -oE '`docs/[A-Za-z0-9._/-]+\.md`' docs/index.md | sort -u | wc -l` → **22**。
- 悬空引用：`[ -e docs/product/r4-stability-manual.md ]`（MISSING）、`[ -e docs/architecture.md ]`（MISSING）、`[ -e docs/lifecycle-roadmap.md ]`（MISSING）。
- 历史保护：`git log --numstat -- docs/product/business-e2e-prereg.md` 等 → total_deletions=0；`sed -n '5p;1324p' docs/decision-log.md`（「不删除旧条目」）。
- 代码引用的活文档：`sed -n '14p' packages/agent/src/task-registry.ts`、`sed -n '2p' packages/agent/task-runner.test.ts`、`scripts/stab/{chaos,pressure,soak}.test.ts:4`、`scripts/ci.sh:18,23`、`config/agent.example.yaml:54`、`scripts/p0-redo-doc-scan.test.ts:6`、`packages/agent/src/skills.ts:34`。

### 本轮边界（未做）

- **未删除、未移动、未改写任何现有文档或代码**（含 decision-log 历史条文、已预注册实验、已落盘 Eval、历史验收报告、AGENTS 冻结面、仍作 issue/PR/测试依据的设计记录）。
- **未新建元数据系统 / 自动同步 / 强制检查框架**（不做 front-matter 治理、不做链接校验器）。
- **未执行任何提交之外的动作**：本文件为唯一新增文件，清理动作留待 owner 在产品修复与 E2E 结束后另开清理 PR。
