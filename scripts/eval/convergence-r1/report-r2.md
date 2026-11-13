# fshine-agent「Eval 收敛 · R2」交付报告（2026-11-13）

> 范围：owner R2 五项处置（E05 边界裁定、E04 重复采样、task.status 语义核查、CLI flag 残余登记、持续评测口径）。
> 架构冻结不变；本轮无宿主行为机制新增，唯一提示词级改动经 Eval 前后对照验证。
> 模型帧：**step-3.7-flash**（进程 env 显式覆盖 `.env` 的 step-5-preview；`model.json` 记录 main=worker）。M5 首轮基线为 step-5-preview 帧——**跨帧不混算**。

## 结论摘要

- **E05**：裁定「探索优先（执行层裁决歧义）」→ 最小实施（Worker 技能 + 主 Agent 指令）→ **行为频率 0/9 → 5/9**（同模型、同判据、同 revision 之外仅 agent.md 变化）；4/9 仍先澄清属模型方差。
- **E04**：×12 全采样 = **12/12 PASS**（正确委派 12/12；逐 trial 两次执行 W202611 + W202610；先追问 0；虚构 0）。多轮上下文承接在本模型帧稳定。
- **task.status**：核查=无用户可见消费面 → **不修改**；8 条表征测试钉住当前口径（`packages/agent/task-status-boundary.test.ts`），复评触发条件在册。
- **CLI flag 残余**：已登记（`--collection`/`--window` 直入契约参数名；不影响当前生产；修正触发条件与方向在册）。
- **持续评测**：口径已修（配置就绪 ≠ 默认分支已启用；需合入 main + 首次 nightly 留档 + 失败面有人处理）。

## 1. E05 授权边界裁定与验证（decision-log §17.1）

**裁定**：候选查询与具体对象读取同属只读调用，逐次由 Executor 按可信身份与 scope 裁决；**当用户标识存在歧义且可交给执行层裁决时，先探索**（查询该歧义句柄，执行层返回 `needs_input` + 候选）；把**执行层返回的候选**交还用户选择；标识缺失/不可裁决时才直接澄清；用户确认前不得猜测具体候选集合查询，不得把候选数据当答案。

**根因链（两段）**：
1. Worker 技能原文让「把候选作为一次澄清交给用户」→ 与判据（先查执行层）矛盾；技能仅作用于 Worker。
2. 主 Agent 指令（`.agents/agents/fshine-main/agent.md`）原文「必要时先用业务语言向用户澄清」「不替执行层摸索参数或步骤」→ 决策点在 Main，模型 0/9 零执行先澄清（把 `contoso` 当公司名）。

**实施与前后对照**（同模型 step-3.7-flash、同冻结判据 v1）：

| 阶段 | 变更 | E05 ×9 |
|---|---|---|
| before | 技能已对齐（d74e6ee），agent.md 未对齐 | 0/9（9/9 零执行先澄清） |
| after | agent.md 对齐（da5eecb）：对象名不确定→交执行层裁决 | **5/9 PASS**（5 次 `query contoso → needs_input → 交还候选`；4 次仍先澄清=方差） |

回归探针：E06 ×3 = 3/3（缺参数澄清不受影响）、E12 ×3 = 3/3（纯聊天不强制委派）。
**判据不变**：v1 冻结判据与该裁定一致，不产生 v2，冻结用例未改写；若未来放宽（允许候选枚举/澄清优先）须新增判据版本并保留 v1 可对照（原始 judgment 已存证）。

## 2. E04 重复采样（decision-log §17.5）

- 样本：×12（`r2-e04-flash37`），step-3.7-flash，判据 v1。
- 判定：**12/12 PASS**；失败码 0。
- 行为频率（逐 trial 执行事实）：正确委派 12/12；每 trial 2 次结构化执行（`documents/W202611` + `documents/W202610`，第二轮指代承接正确）；先追问 0；虚构 0。
- 说明：本帧未见「先追问/不委派」样本，E04 在此模型上稳定；不因单轮失败新增 Runtime 门禁（本轮无该类改动）。

## 3. task.status 语义边界（§17.2）

- 核查：`task.status` 无用户可见消费面（ask 打印逐执行状态；server 只记 executions；M5 判定器用执行行判 ④）。
- 决定：**不修改**（不为无消费者字段新增宿主行为）；8 条表征测试钉住当前口径（`[failed, completed]`→failed、`needs_input`→failed、零执行→unexecuted 等）。
- 复评触发：ask 打印任务状态 / 状态查询切片 / 后台投递 / 判定器改用 task.status。

## 4. Execution Contract CLI flag 残余（§17.3）

- 残余：`operation list --json` 的 `args.flags[].flag`（`--collection`/`--window`）直入 `CapabilityManifest.operations[].args[].name`。
- 决定：不实施；触发条件=①非 CLI 传输接入出现映射成本/行为差异 ②Eval 显示 flag 命名造成模型误用。修正方向=契约参数名中性化 + 适配器内映射。

## 5. 持续评测口径（§17.4）

- 事实：`eval-real.yml` = `main` push/PR；`eval-nightly.yml` = 每日 cron + 手动；工作线未合 main、远端 Secrets 未验证。
- 口径：「配置就绪」≠「默认分支持续 Eval 已启用」；持续保障需三条（合入 main / 首次真实 nightly 留档 / 失败面有人处理）。README 已同步。

## 样本、模型与可验证范围

- 样本（全部保留原始 judgment）：E04 ×12、E05 ×9（before）+ ×9（after）、E06 ×3、E12 ×3 = 36 次新运行；模型 step-3.7-flash（main=worker），仓内 dummy 夹具，不触真实 SaaS/企微。
- 代码点：R2 提交 d74e6ee（技能+边界测试+§十七）、718dd9f（README）、91d17fe（模型口径）、da5eecb（agent.md）；判据 `criteria.lock` 未动。
- 可验证范围：E05 的 5/9 是**行为频率**不是稳定性结论；E04 12/12 只覆盖多轮承接地单场景；跨模型（step-5-preview）帧不混算。
- 未做（按任务书）：全仓架构审计、宿主行为补丁、协议扩张。

## 提交与留档索引

- 运行证据：`.runtime/eval-r1/r2-{e04,e05,e05b,e06,e12}-flash37/`；作废样本：`r2-*-step5-preview-partial/`（混合 revision，不参与统计）。
- 判据与判定器：`scripts/eval/convergence-r1/`（v1 冻结不变）。
