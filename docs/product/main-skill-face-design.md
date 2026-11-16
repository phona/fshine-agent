# Main 技能面设计（2026-11-16，设计稿·未实施）

> 状态：**设计稿，未实施**。任何配置/代码改动等本设计被批准、且对照实验给出数据后再做。
> 触发：SIM-01 观测到「Main 写委派文本时丢掉用户要求（条数+合计）」。

## 1. 问题陈述

**观测事实**（`.runtime/sim-triage/repro.md`、`.runtime/sim4`、`.runtime/sim5`）：

- sim4 SIM-01#1：首轮委派文本写「查找并确认系统中是否存在名为 alpha 的集合…返回相关候选信息」——**用户要的「合计」在委派里消失**；而执行层那一次就返回了 items 1200/800，合计本可算出。
- sim5 SIM-01#2：委派文本写「返回所有匹配到的候选名称…**不需要统计数字，只需要列出候选名称**」，并把两次**精确命中**的查询（alpha 2 条、alpha-group 1 条）包装成「候选」反问用户。
- **间歇性**：sim6 批次同用例 **3/3 全过**；现场新采 2 条也全过。不是必现。

**现状事实**：

| 事实 | 位置 |
| --- | --- |
| `mainSkillRoots` / `mainSkillMode`（`inline`\|`catalog`）是**生产特性**，有类型与校验 | `packages/core/src/config.ts:307-365` |
| 缺省 `undefined` 时行为**逐字节不变** | `packages/agent/main-skill.test.ts:6` |
| 生产配置**未启用**（`contextProfiles.17dz` 只有 `skillRoots`） | `config/agent.yaml` |
| 仓库根**没有**生产 Main 技能目录（`.agents/` 只有 `agents`） | — |
| `fixtures/dummy-platform/.agents/skills-main/{record-digest,value-note}` 是**为实验造的中性夹具** | `docs/decision-log.md:1253`、`scripts/eval/business-e2e/experiments/fixtures.test.ts:15-17` |
| worker 的技能面是另一处：`skills-serve/dummy-routing`（`skillRoots` 指向） | `config/agent.fixture.yaml` |

**历史证据**：此前一轮因「技能 0/39 命中」把交互技能移出发现路径。本次要检验的是**特定口径技能在特定场景是否有效**，不是「技能普遍有效」。

## 2. 设计目标与不变量

1. **一份内容、两处引用**：生产与测试指向**同一目录**，不允许复制出第二套技能面。
2. **测试默认同源**：SIM / P2 的默认装配 = 生产装配。生产未开技能，测试也不开。
3. **不新增机制**：不新增 Planner / Router / 意图分类器；不靠提示词堆叠补模型行为（A 类，默认删除）。
4. **Main 的 `agent.md` 保持最小**：业务方法走技能，不走提示词。
5. **失败可见**：技能缺失导致的退化必须体现为**测试失败**，不能被夹具掩盖。

## 3. 方案对比

| 方案 | 内容 | 代价 | 风险 |
| --- | --- | --- | --- |
| **S1** 生产技能面 | 建 `.agents/skills-main`，生产 profile 启用，`catalog` 模式 | 长期维护内容 | 可能无效（历史 0/39） |
| **S2** 不建技能面 | 回到「委派保真」找根因 | 按纪律不许用提示词补；若无非提示词手段，只剩「登记为已知缺陷」 | 缺陷留存 |
| **S3** 先实验后决定（**推荐**） | 基线＝生产同源；单开对照实验量化技能是否有效；有效才落 S1 | 多一轮实验 | 无重大风险 |

## 4. 实验设计（S3）

- **基线臂**：`mainSkillRoots` 缺省（＝生产现状）。
- **实验臂**：`mainSkillRoots: [".agents/skills-main"]` + `mainSkillMode: catalog`。
- **场景**：SIM-01（主判据：首轮交付条数+合计）；SIM-03（纠错）、SIM-05（失败转述）作**迁移检查**，防止别处退化。
- **样本**：每臂每场景 3 trials ⇒ 18 会话；并发 5；**预注册先落盘**；失败样本全留。
- **判据**：
  - 主判据 `pass^k` 提升，**且**硬零（虚假完成 / 重复执行 / 串户 / 旧回合冒充）不退化 ⇒ 判「有效」；
  - 否则判「无效」，不得以「看起来合理」代替。
- **必须记录**：catalog 模式下 Main 是否真的 `read_skill`。没读 ⇒ 结论是「投递方式无效」，与「内容无效」后续动作完全不同。

## 5. 有效则生产化清单

1. **内容归位**：`skills-main` 从 fixture 迁到 `.agents/skills-main`（生产根）；fixture 改为**引用同一目录**（路径解析需确认相对根）。
2. **生产配置**：`contextProfiles.17dz` 加 `mainSkillRoots` + `mainSkillMode: catalog`。
3. **测试同源**：SIM / P2 夹具 profile 指向同一目录，不复制内容。
4. **边界**：`read_skill` 路径解析不得出 root；技能为只读文档，不授予任何执行能力；不引入工具/凭据。
5. **回归**：全量单测 + P2 七场景 + SIM 全场景（含硬零）。

## 6. 无效则处置

1. **删除** fixture 内 `skills-main`，SIM 基线固定为生产同源；
2. 把 SIM-01 的间歇失败登记为**已知产品缺陷**（进风险清单，不冒充通过）；
3. 根因方向回到「Main 把用户要求改写成委派文本」这一步，需要单独消融（提示 / 模型偏差 / 候选澄清策略），不继续加技能。

## 7. 风险与未决

- **历史 0/39** 说明此前技能对行为无影响；本实验若也无效，倾向「技能不是这个病的药」。
- **catalog vs inline**：catalog 需 Main 主动读；若 catalog 无效而 inline 有效，问题在投递方式。
- **不等于根治**：即便有效，也只证明「特定场景下更常算合计」，不证明委派保真被根治。
- **未决**：实验在哪条分支跑（建议独立 worktree，不合 integration）；实验失败后 fixture 技能是否立即删除。

## 8. 与现有纪律的对账

- `AGENTS.md`「Skills First」：业务知识与方法优先走 Skills → 支持 S1 的**方向**，但方向不等于证据。
- `AGENTS.md`「新增机制准入」：本设计**不新增机制**（`mainSkillRoots` 已存在），只涉及是否启用与内容归属。
- 「一份内容两处引用」：直接对应「禁止停用代码却长期保留两套实现」。
