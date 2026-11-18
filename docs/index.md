# 文档索引

> 2026-11-18 全量清理后重写（上一版只覆盖 25/114 且多处过时，已废弃；本轮处置记录见 `docs/product/cleanup-2026-11-16.md` 的执行状态注）。
>
> 口径（2026-11-18 owner 裁定）：**真删为主，不留归档目录**——已收官/被取代/前提已死的一次性记录一律删除（git 历史可考）；decision-log 等冻结面里的旧路径指针不回改，考古入口 = `git log --diff-filter=D`。

## ① 权威与纪律（现行）

- `AGENTS.md`——进仓第一约束（哲学 / 职责边界 / 删除纪律 / 现状指针）
- `docs/decision-log.md`——权威裁定与状态台账（只增不删）
- `docs/methodology.md`——作业纪律与判据编号

## ② 现行设计出处（已实施子系统的设计/登记档）

- `docs/product/cap01-main-direct-execution.md`——CAP-01 run_js / 文件桥设计（已实施并合入）
- `docs/product/pi-152-adapter-design.md`——Pi 1.5.2 适配器 / 转录所有权设计（已实施）
- `docs/product/pi-152-dependency-patches.md`——Pi 最小依赖补丁登记表（补丁在生效）
- `docs/product/pi-152-dispatch-key-design.md`——dispatchKey 设计（已实施；`task-registry.ts` 引其 §5.3）
- `docs/product/b1-session-persistence-impl.md`、`b1-wiring.md`——B1 会话持久化实施与接线（retention / capacity 待裁）
- `docs/product/b2-silent-shadow-gate.md`——B2 企微静默闸（默认交付语义待裁 + 联调手册）
- `docs/product/idempotency-cross-restart.md`——跨重启幂等缺口设计（未实施，待裁决）

## ③ 活的联调 / 评测 / 运维面

- `docs/product/wecom-live-dummy-cases.md`——企微×dummy 联调用例档（39 条 P0/P1）
- `docs/product/business-coverage.md`——业务级用例覆盖图（持续更新）
- `docs/product/event-catalog.md`——结构化事件字典
- `docs/product/r3-open-decisions.md`——待裁定登记（未决项以本文件为准）
- `docs/product/p2-business-e2e-prereg.md`——P2 业务 E2E 预注册（待真实模型执行）
- `docs/product/r6-longsession-prereg.md`——R6 长会话预注册（wave1-runner 运行时读取取证）
- `docs/product/r4-joint-interfaces.md`、`r4-acceptance.md`、`r4-stability-prereg.md`、`r4-slices.md`、`p2a-task-contract.md`——R4 契约冻结面与预注册（测试逐条引用）
- `docs/product/business-e2e-prereg.md`、`business-e2e-prereg-addendum.md`——业务 E2E 预注册
- `docs/product/business-e2e-final-report.md`——三轴总报告（产品定义文档）
- `docs/product/manual-test-handbook.md`——手工测试手册
- `docs/product/real-read-readiness.md`——真实只读接入准备档
- `docs/product/dead-code-audit.md`、`cleanup-2026-11-16.md`——待办清单（未销项在册）
- `docs/environment-variables.md`——环境变量清单

## ④ 历史参考（定位为档案，文首有注记；不按现行规范读）

- `docs/v0-architecture.md`——架构总览（§8 宿主预算/计划门表述为已删机制的历史叙述）
- `docs/v0-functional-spec.md`、`docs/artifacts.md`、`docs/product/r4-slice-plan.md`——已被取代，失效注记在册
- `docs/architecture-laws.md`、`docs/a2a-protocol.md`、`docs/execution-layer-interface.md`——历史判据 / 协议档案（AGENTS.md 指针）
- `docs/debt-ledger.md`、`docs/change-safety.md`、`docs/e2e-ownership.md`——历史台账（ci.sh / PR review prompt 引用）
- `docs/rule-landing.md`、`docs/business-skill.md`、`docs/roadmap.md`
- `docs/product/exp-pi-native-config-headroom.md`——压缩配置安全值推导出处（ask-runtime.ts 注释引用）
- `docs/product/evidence/`——补丁证据 json（git pin 锚点）

## ⑤ 已删除（2026-11-18 清理）

删除 71 篇：0.85.1 压缩/实验簇（pi-compaction×5、exp-pi-native×4、pi-152-stage-b/c/d/d2、minimality-audit）、main-skill-face-design、R4 切片报告 22 篇、R5 收官 9 篇、R6 收官 5 篇、已实施/被取代设计 7 篇、退役工具旧档 11 篇、R5 清理 meta 2 篇、push-runbook 等。处置依据与取代者映射见 `docs/product/cleanup-2026-11-16.md`；内容考古用 `git log --diff-filter=D -- docs/`。
