# R5 垃圾核查台账（代码面）

> 生成：R5 垃圾核查汇总员，基线 = arch/integration @860129e（worktree arch/r5-junk）。
> 口径：`packages/*/src/*.ts` + `apps/server/*.ts` 共 30 个生产文件、8389 行的全部命名导出逐个统计引用（脚本自动扫描 + 非正常项人工 `grep -rnw` 复核），分类为生产引用 / 仅测试 / 仅 eval / 零引用 / 文件内自用。历史证据（decision-log、预注册、落盘 Eval）、AGENTS.md 冻结面、`scripts/eval/convergence-r1` 冻结件一律未动、不判垃圾。
> **本文不执行任何删除**：所有「删除」建议均待 owner 批准后另开改动执行。

## 一、总台账

| # | 路径:行号 | 类别 | 证据 | 建议 | 风险 |
|---|---|---|---|---|---|
| 1 | `packages/agent/src/skills.ts:136` | 死代码（零引用导出）| `grep -rnw discoverSkills` 全仓 .ts 仅命中定义行（docs 命中 debt-ledger.md:612、gap-main-skill.md:25，均为历史描述）；是 FileSkillRegistry.discover() 的便利包装，与被 worker-skills.ts:11 消费的 listSkills 不同，无任何消费者 | 删除（待 owner 批）| 低：纯包装，不影响 registry/listSkills 路径 |
| 2 | `packages/agent/src/skills.ts:167` | 死代码（零引用导出）| `grep -rnw readSkill` 全仓 .ts 仅命中定义行；同为 FileSkillRegistry.read() 便利包装；execution-runtime.ts:41 只 import READ_SKILL_TOOL 与 SkillRegistry | 删除（待 owner 批）| 低 |
| 3 | `packages/contracts/src/config.ts:102` | 死代码（零引用导出，C5 历史遗留）| `grep -rnw resolveActiveProfileId` 全仓 .ts 零命中，仅 4 处历史文档提及 | 删除（待 owner 批）| 低 |
| 4 | `package.json:37`（express ^4.21.2）| 未使用依赖 | 生产/测试/脚本 0 处 import（`grep -rn --include='*.ts' "from ['\"]express"` 零命中）；tsconfig types 不含；npm scripts 与 ci.sh 不引用 | 删除（待 owner 批）| 低 |
| 5 | `package.json:25`（@types/express ^4.17.21）| 未使用依赖 | 同 #4，0 引用且 types 数组不含 | 随 express 一并删（待 owner 批）| 低 |
| 6 | `package.json:34`（@earendil-works/pi-coding-agent ^0.85.1）| 未使用依赖 | 全仓 0 处 import；pi-agent-core 的 dependencies（chord/pi-ai/pi-telemetry/diff/ignore/typebox/yaml）不含它且方向相反（pi-coding-agent 依赖 pi-agent-core）；pi-agent-core 与 pi-ai 的 dist 无 'pi-coding-agent' 字符串（无动态加载）。注：docs/a2a-protocol.md:110-115 历史冻结面声称「本仓正用 pi-coding-agent」，与现状不符——只登记，不改历史文档 | 删除（待裁决：owner 若以历史文档陈述为准需先改文档）| 低-中（历史文档提及）|
| 7 | `packages/agent/src/task-registry.ts:434-635`（createTaskRegistry 内存版）| 两套实现（判保留）| 唯一生产引用点 = execution-runtime.ts:334 的 `options.taskRegistry ?? createTaskRegistry()` 缺省回退；所有生产入口均注入 SQLite 版（scripts/ask-runtime.ts:387-390、apps/server/server.ts:96+151、scripts/stab/fakes.ts:259）。非完整重复：SQLite 版复用 reduceTaskState/judgeReportedTask 等共享核心；有历史裁决 + 契约同测；内存版消费者 = 测试（main-skill.test.ts:90 显式；worker-prompt.test.ts、budget-metering.test.ts 隐式走缺省回退）。**不触「停用却保留两套实现」禁令** | 保留；其中「生产不可达的内存缺省回退」（execution-runtime.ts:334）可待裁决收紧（如缺省改抛错/强制注入）| 中：缺省回退属便利缺省，动它需先改 2 个隐式依赖的测试 |
| 8 | `packages/agent/src/step-text.ts:46-48` | 陈旧注释（与实现不符）| 注释称工具面含 task_control、resend_artifact：`grep -rn -E 'task_control|resend_artifact' --include='*.ts' packages apps scripts | grep -v test` 唯一命中即该注释本身；实际工具面 = run_task（execution-runtime.ts:52,664）+ task_status/task_result/task_cancel/task_resume（:75,87,99,113）+ read_skill（:628,687）。点名两个不存在的工具、漏掉四个真实工具 | 改写为现行工具面（文字修正，待 owner 批）| 低（纯注释，但为新读者第一入口，误导性强）|
| 9 | `packages/agent/src/server-paths.ts:109-110` | 陈旧注释（引用已删机制）| 注释称「重发路由（resend 申报枝）消灭了这个需求的大半」——申报层已整体删除（docs/v0-architecture.md:56 状态更新）；生产 `grep resend` 仅剩本处与 step-text.ts:47 两处注释 | 保留（机制逻辑本身仍有效），注释措辞可随 #8 一并修（待 owner 批）| 低 |

未列项 = 无发现。零引用导出共 3 个（#1-3），无其他精确死代码；大量 SELFONLY/TESTONLY 项为类型导出或测试缝，**不判死**。其余依赖（pi-agent-core 19 处、pi-ai 11 处、@wecom/aibot-node-sdk 等）全部有真实引用，未列。

## 二、统计

- 类别计数：死代码（零引用导出）3；未使用依赖 3；两套实现（判保留）1；陈旧注释 2；未消费配置键 0（本轮未发现新增，#3 为 C5 已登记遗留的代码面残留）。
- 建议分布：删除 5（#1-5，均待 owner 批）；删除待裁决 1（#6）；保留（含可选收紧待裁决）2（#7、#9）；文字修正待批 1（#8）。
- 执行删除数：**0**（本文档为唯一产出，不改任何代码与既有文档）。

## 三、删除纪律

本文只出台账，**不执行删除**。任何删除/注释修正均需 owner 批准后按仓库 TDD/绊线纪律另行实施；`docs/decision-log.md` 由集成 Agent 单点写，本文未触碰。

## 四、与 docs-cleanup-candidates.md 的关系

文档面清理已由 `docs/product/docs-cleanup-candidates.md` 另行登记（R5 docs 清理路），本文**只覆盖代码面**（生产 .ts 导出、package.json 依赖、代码内注释），两者不重叠：#6/#8/#9 涉及的 docs/a2a-protocol.md、历史文档陈述只登记不符，不进入文档清理建议。

## 五、复核命令清单（独立复核可复跑）

```bash
cd <repo>
# 零引用导出（#1-3）：应仅命中定义行
grep -rnw --include='*.ts' -E 'discoverSkills|readSkill|resolveActiveProfileId' packages apps scripts
# 不存在的工具名（#8）：生产命中应仅 step-text.ts:47 注释
grep -rn -E 'task_control|resend_artifact' --include='*.ts' packages apps scripts | grep -v '\.test\.ts'
# express / pi-coding-agent 引用（#4-6）：应零命中
grep -rn --include='*.ts' -E "from ['\"]express|require\(['\"]express" packages apps scripts
grep -rn --include='*.ts' 'pi-coding-agent' packages apps scripts
grep -n -E 'express|pi-coding-agent' package.json
# 内存版 registry 生产引用点（#7）
grep -n 'createTaskRegistry()' packages/agent/src/execution-runtime.ts
# 依赖方向佐证（#6）：pi-agent-core 的 dependencies 不含 pi-coding-agent
node -e "const p=require('@earendil-works/pi-agent-core/package.json');console.log(Object.keys(p.dependencies))"
```
