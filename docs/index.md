# 文档索引

> 2026-11-18 全量清理后重写（上一版只覆盖 25/114 且多处过时，已废弃；各轮清理的处置记录原在 `cleanup-2026-11-16.md`，该台账亦已随清理删除，git 历史可考）。
>
> 口径（2026-11-18 owner 裁定）：**真删为主，不留归档目录**——已收官/被取代/前提已死的一次性记录一律删除（git 历史可考）；未决项不留在仓库文档里，一律开 GitHub issue；decision-log 等冻结面里的旧路径指针不回改，考古入口 = `git log --diff-filter=D`。

## ① 权威与纪律（现行）

- `AGENTS.md`——进仓第一约束（哲学 / 职责边界 / 删除纪律 / 现状指针）
- `docs/decision-log.md`——权威裁定与状态台账（只增不删）
- `docs/methodology.md`——作业纪律与判据编号

## ② 现行设计出处（已实施子系统的设计/登记档）

- `patches/README.md`——Pi 1.5.2 最小依赖补丁登记（diff / 缺陷来源 / 删除条件 / 证据 pin；补丁在生效）

## ③ 活的联调 / 评测 / 运维面

- `docs/product/wecom-live-dummy-cases.md`——企微×dummy 联调用例档（39 条 P0/P1）
- `docs/product/business-coverage.md`——业务级用例覆盖图（持续更新）
- `docs/product/event-catalog.md`——结构化事件字典
- `docs/product/p2-business-e2e-prereg.md`——P2 业务 E2E 预注册（待真实模型执行）
- `docs/product/r6-longsession-prereg.md`——R6 长会话预注册（wave1-runner 运行时读取取证）
- `docs/product/r4-joint-interfaces.md`、`r4-acceptance.md`、`r4-stability-prereg.md`、`p2a-task-contract.md`——R4 契约冻结面与预注册（测试逐条引用）
- `docs/product/business-e2e-prereg.md`、`business-e2e-prereg-addendum.md`——业务 E2E 预注册
- `docs/product/business-e2e-final-report.md`——三轴总报告（产品定义文档）
- `docs/product/manual-test-handbook.md`——手工测试手册
- `docs/product/real-read-readiness.md`——真实只读接入准备档
- `docs/environment-variables.md`——环境变量清单
- **未决项**：仓库不再保留待办/待裁定文档；未决项一律在 GitHub issues（当前结转 #67–#74）。

## ④ 历史参考（定位为档案；不按现行规范读）

- `docs/architecture-laws.md`、`docs/debt-ledger.md`、`docs/change-safety.md`——历史判据 / 台账 / 防线档（PR review prompt 与 ci.sh 注释仍引用，删除待 owner 单独裁定）
- `docs/product/evidence/`——补丁证据 json（git pin 锚点；登记表见 `patches/README.md`）

## ⑤ 已删除（2026-11-18 清理，五轮共 93 篇；另 1 篇移出 docs）

- 第一轮 71 篇：0.85.1 压缩/实验簇（pi-compaction×5、exp-pi-native×4、pi-152-stage-b/c/d/d2、minimality-audit）、main-skill-face-design、R4 切片报告 22 篇、R5 收官 9 篇、R6 收官 5 篇、已实施/被取代设计 7 篇、退役工具旧档 11 篇、R5 清理 meta 2 篇。
- 第二轮 10 篇历史原位档：v0-architecture、v0-functional-spec、artifacts、r4-slice-plan、roadmap、rule-landing、business-skill、a2a-protocol、execution-layer-interface、e2e-ownership（AGENTS.md / ci.sh / 代码注释 / 活文档引用已同步改）。
- 第三轮 1 篇：`docs/product/r4-slices.md`（R4 分片计划；P0–P7b 全落地，唯一未落地的 P8 已转 issue #71）。
- 第四轮 4 篇已实施设计稿：cap01-main-direct-execution、pi-152-adapter-design、pi-152-dispatch-key-design、exp-pi-native-config-headroom（引用它们的 11 处代码注释已同步改为「已删，git 历史可考」或指向实现文件）。
- 第五轮 7 篇（未决项全部转 issue，仓库不再留待办文档）：r3-open-decisions（→ #69/#70/#71/#73）、b1-session-persistence-impl + b1-wiring（→ #67）、b2-silent-shadow-gate（→ #74）、idempotency-cross-restart（→ #68，复现探针保留在 scripts/probes/）、dead-code-audit（→ #72）、cleanup-2026-11-16（清理元台账，已收口）。
- 另有 1 篇**移出 docs**：pi-152-dependency-patches → `patches/README.md`（补丁登记紧附补丁本体，登记规则要求「记 diff / 版本 / 来源 / 删除条件」）。
- 内容考古用 `git log --diff-filter=D -- docs/`。
