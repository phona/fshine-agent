# 文档索引

本文档仓库的阅读入口。四组文档的权威性与阅读前提不同，入门前先看标注。

## ① 终局规格

以下文档描述 fshine-agent 的终局架构与功能规格；`v0-architecture.md` 因含架构迁移史叙述仍有执行层实例痕迹（5 处，Tier B 在册、带闭环判据与限期），不代表终局规范已被中性化，阅读时把实例叙述当作"改造史档案"。

- `docs/v0-architecture.md`——架构总览与分层判据
- `docs/v0-functional-spec.md`——功能规格与能力表

## ② 协议与准入

以下文档定义执行层接入的协议形状、准入条件与架构律法。**注意**：其中 `execution-layer-interface`、`execution-layer-admission`、`architecture-laws` 三篇仍含执行层实例历史叙述（相关行在产品面痕迹登记表在册，Tier B，带闭环判据与限期），不代表它们已被中性化或适合直接公开引用；阅读时请把实例叙述当作"改造史档案"而非"终局规范"。

- `docs/execution-layer-interface.md`——执行层接口文档（含 §10 遗留过渡表与实例叙述）
- `docs/execution-layer-admission.md`——执行层准入清单（A1–A14）
- `docs/architecture-laws.md`——架构律法与闭环判据（含守卫命令原文与基线记录）

## ③ 改造史档案

以下文档记录迁移过程中的裁定、债务、风险与波次记录，包含执行层实例叙述。属档案例外，不要求中性化；阅读前提是已了解终局规格。

- `docs/debt-ledger.md`——债务登记台账（D-153 起，每条含归属标签 + 闭环判据 + 限期）
- `docs/change-safety.md`——波次记录与防线表（§25 起含 F3 变异留档）
- `docs/env-naming-ruling-20261110.md`——隔离环境变量命名族裁定（2026-11-10，`EXECUTION_*` 唯一规范族；含失效条件与闭环判据）
- `AGENTS.md`——项目约定与横切纪律（迁移期适配现状、授信期门语义、长期目标）
- `git` 历史——全量 commit 记录（含已落地波次的完整改动链）

## ④ 运行与验收

以下文档面向运行、调试、验收与排障，混合了终局机制与改造史叙述，阅读时请以终局规格为准。

- `docs/e2e-ownership.md`——e2e 测试所有权与前置条件
- `docs/manual-test-wecom.md`——企微手工测试指南（渠道机制与 harness，业务用例已移出）
- `docs/test-hardening.md`——测试加固与基线记录
- `docs/environment-variables.md`——环境变量说明（含执行层治理变量与通用旋钮）
- `docs/perf-baseline.md`——性能基线
- `docs/methodology.md`——方法论与验收纪律
- `docs/rule-landing.md`——规则落点索引
- `docs/eval-mechanism-registry.md`——eval harness 机制登记表（每个机制防什么、拆了会怎样、成本；含审计结论逐条核对记录）
- `docs/roadmap.md`——路线图
- `docs/artifacts.md`——产物清单
- `docs/interactive-session-plan.md`——会话交互方案
- `docs/v0-implementation-decisions.md`——V0 实施决策记录
- `docs/business-skill.md`——业务 skill（已中性化，执行默认值与业务路由例子已移出）
