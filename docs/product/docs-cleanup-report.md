# R5 docs 清理实施记录（2026-11-15）

> **性质**：本文件是 R5「docs 瘦身」轨清理 PR 的**唯一实施记录**（处置清单来源：`docs/product/docs-cleanup-candidates.md` §3.2/§3.1）。基线分支 `arch/r5-docsclean`（起点 = `arch/integration` HEAD `b24cd75`）。
> **纪律**：删除 **0** 篇（只读审计结论沿用：无一篇可确定安全删除）；不改产品代码（`packages/`、`apps/` 零改动）；不改写 `docs/decision-log.md`（集成 Agent 单点写）；历史读数/实验条件/原始结论一律未动，只允许补「历史/已被取代」注记。

---

## 一、本次处置清单

### 1. C×2 + E×1（补「已被取代」注记 / 消解矛盾）

| # | 文件 | 动作 | 依据（本 worktree 当前代码复核） |
|---|---|---|---|
| C1 | `docs/artifacts.md` | 文首补「历史设计账，契约面已被取代」注记；W0–W7 正文不动；`docs/index.md:44` 条目同步加「**历史**」标注 | `packages/contracts/src/execution-contract.ts:66` 仅四态；`grep -icE 'artifact\|cancel'` 于该文件 = **0**；`docs/decision-log.md:683` 明写「四态，无 cancel/artifacts」 |
| C2 | `docs/product/r4-slice-plan.md` | 文首原引言升级为正式「状态：已被取代」横幅，指向唯一现行依据 `docs/product/r4-slices.md`；正文不动 | 原文首 :3 仅一句引言、无状态横幅；`docs/product/s4-stats-four-state.md` 等仍引其 S4 口径 |
| E1 | `docs/v0-functional-spec.md` | 文首补状态注记（§4.1 申报/计划门为已删机制的历史描述；现行口径 = `AGENTS.md` 现状节 + decision-log §十一/§十三）；原「状态：当前实现基线」改为「历史功能规格」并注明原自述 | 本轮 `grep -rn 'validatePlanEntities' packages apps scripts config` **零命中**；`execution-contract.ts:25`「计划门与预算梯子归执行层，不在这里开第二份裁决面」；AGENTS.md「禁止新增 Planner」「写确认回环 ≠ 宿主计划门」 |

### 2. 待裁决 4 → 定论：保留原位（不删、不归档），本轮零改动

| 文件 | 定论 | 依据（本轮验证） |
|---|---|---|
| `docs/eval-baseline-refresh-20261107.md` | 保留原位 | B 类历史证据（E4 禁删）；文首已有 2026-11-13 M4 注（历史核查记录、按 2026-11-07 时点阅读），注记已在册；全仓 `grep` 零入站引用；是否归档属目录组织偏好，无代码/引用面必要性，默认不动 |
| `docs/eval-harness-measurement-20261107.md` | 保留原位 | 同上；文首已有 M4 注「按历史档案阅读，不要按本文触发已删入口」 |
| `docs/interaction-skills/result-assistance.md` | 保留原位 | 文末已有「档案注记（decision-log 八，2026-11-12）：保留为参考材料」；且 `docs/decision-log.md:528,536` 的历史实验记录仍引用本文件（ablation 台账的实验材料，属 E4 面），非零引用 |
| `docs/interaction-skills/task-collaboration.md` | 保留原位 | 同上（decision-log :528/:536 同一实验引用） |

**理由**：审计给出的备选只有「归档 / 保留」；归档须 owner 另行授权目录组织决定，且四篇注记均已齐备、无误导风险，故本轮按默认纪律保留原位，登记在此供 owner 复核。

### 3. 唯一权威来源索引

复用 `docs/index.md` 作唯一入口，只做指向：④ 组新增两条指向本报告与候选清单；候选清单 §二 的「唯一权威来源」六行表仍是主题级权威指向（不复制进 index）。未新建第二份索引框架（E3）。

### 4. Phase 3 报告登记处

`docs/index.md` 新增「⑤ R5 Phase 3 报告登记处（预留）」节：`docs/product/r5-phase3-*.md` 落盘后在该节登记；当前未落盘。

### 5. 计数不一致修正（A 类 21 vs 23）

- **本 worktree 复核结论：A = 23 成立**。23 项见 `docs-cleanup-candidates.md` §一 A 表；其代码锚点本轮逐条抽查命中：`packages/agent/src/task-registry.ts:14`（r4-joint-interfaces）、`packages/agent/task-runner.test.ts:2`（同）、`scripts/stab/chaos.test.ts:4`（r4-stability-prereg）、`scripts/ci.sh:18,23`（e2e-ownership / debt-ledger）、`config/agent.example.yaml:54`（environment-variables）、`scripts/p0-redo-doc-scan.test.ts:6`（r3-open-decisions）、`packages/agent/src/skills.ts:34`（business-skill）。
- **对账口径**：全量盘 = `git ls-files -- docs | grep '\.md$'` = 70（本分支时点，较审计基线 68 多出 `docs/product/r5-phase2-prereg.md` 与 `docs/product/docs-cleanup-candidates.md`）+ 根 `AGENTS.md`/`README.md`。
- **差异登记**：另一路审计（分支 `arch/r5-docsaudit`）的 A=21 文件 `docs/r5-docsaudit-candidates.md` **未合入本 worktree**（`[ -e ]` 判定 MISSING），其 21 项口径无法在本仓核对；以本仓逐项复核 23 为准，差异 2 篇的具体归属待主会话对账后由该分支自行登记。**不**据推测改写任何一方计数。

---

## 二、统计（本次实施后）

| 项 | 数 |
|---|---|
| 补注记/消解矛盾（C×2 + E×1） | 3 篇修改 |
| 待裁决定论（保留原位、零改动） | 4 篇 |
| 删除 | **0** |
| 归档/移动 | **0** |
| 新增文件 | 1（本报告） |
| 产品代码改动 | **0**（`git status` 下 `packages/`、`apps/` 无变更） |
| decision-log 改动 | **0** |

## 三、引用完整性核对（本轮运行）

- `grep -icE 'artifact|cancel' packages/contracts/src/execution-contract.ts` → `0`。
- `grep -rn 'validatePlanEntities' packages apps scripts config` → 零命中。
- 待裁决 4 篇入站引用 grep → 仅 `docs/decision-log.md:528,536`（历史实验台账）引 interaction-skills 两篇；两篇 eval 报告零入站。
- C1/C2/E1 指向目标存在：`packages/contracts/src/execution-contract.ts`、`docs/product/r4-slices.md`、`docs/decision-log.md` 均在当前树。
- 本轮未新增任何悬空引用（新增文本只引用上述已核存在文件与既有行号）。

## 四、历史保护核对（E4）

- `docs/decision-log.md`：未打开写权限、零改动（`git status` 确认）。
- 预注册（`business-e2e-prereg*.md`、`r4-stability-prereg.md`、`r5-phase2-prereg.md`）：零改动。
- 已落盘 Eval 报告 / 历史验收报告：零改动。
- C1/C2/E1 三篇只补文首状态注记，正文、历史读数、验收数字一律未动（diff 仅文首块）。
- AGENTS.md 冻结面：零改动。

## 五、代码与文档不一致事项（登记，未另行改文）

以下为审计 §四登记、本轮复核仍成立但**不在本次授权范围**内改写的项，保留原样供后续 PR：

1. `docs/v0-architecture.md` §8（:51-52、:155）宿主预算/计划门现时态表述——文首 M4 注未覆盖 §8；本轮未获该文件处置授权，仅登记。
2. `docs/architecture-laws.md` :63、:290-298 在场守卫口径正文行——文首 M4 注在册，属「注记不全」，非删除理由。
3. `docs/product/r4-stability-prereg.md:150` 前向引用 `r4-stability-manual.md` 不存在（实际产出为 `manual-test-handbook.md`）——预注册文件（E4），不改。

## 六、验证（本轮实际运行）

- `npm run typecheck`：通过（`tsc --noEmit` 0 错误）。
- `npm test`（vitest 全量 802 用例）：**1 failed | 801 passed**。失败用例＝D 轴 `background DS-3：三任务（含 waiting→cancelled）…`（断言 `grade.indicators.d3.taskStatuses['cancelled']).toBe(1)`）。经 `git stash` 后在**干净基线 `b24cd75` 重跑同一用例仍失败**（1 failed | 801 skipped 选择运行）→ **基线既有红，非本次 docs 改动引入**（本次零产品代码改动，docs 无代码路径）。该红登记在此，不在本清理 PR 修复范围。
- doc 相关守卫（`p0-redo-doc-scan`、`transition-naming` 等包含于全量 unit）：随上述运行通过（除上述基线既有 D 轴红外无其它失败）。
- 测试面只增不减：未删除/弱化任何测试。
