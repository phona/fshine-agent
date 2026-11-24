# 文档索引

> 状态：现行，唯一入口。覆盖 `docs/` 下全部 50 篇 Markdown（2026-11-22 增补 task 重定义设计稿后清点；`docs/index.md` 自身不计，分组篇数之和须等于此数，由 `scripts/docs-guard.test.ts` 检查 1b 校验）；本页即入口，不重复列入分组。仓根另见 `../AGENTS.md`（进仓第一约束）与 `../README.md`（使用说明）。
> 分工：本页只回答「该读哪篇」；决定正文与索引在 `decisions/index.md`，未清债务在 `decisions/debt.md`，未决项在 GitHub issues #67–#74。
> 历史口径：`history/` 只收封存档案，不按现行规范读、内部链接不保证可用；删除与移档全量以 `git log --diff-filter=D -- docs/` 与 `git log --diff-filter=R -- docs/` 为准（本页不记流水数字）。

## 术语（读文档前先对齐这三组）

- **交办 / 任务**：同一件事的两个视角——用户"交办"，系统落成一条 `taskId`。**不用 `delegationId`（该名不存在）**。
- **受理回执 / 渠道回执**：前者是任务被受理时的回话（`architecture/tasks.md`），后者是文件到账时的「已收到 N 个文件」（`architecture/channels.md`）——两类不同事件，不要混用"回执"。
- **会话转录 / 会话日志**：同一对象的两种叫法，统一指 Pi 的 `SessionManager` 落盘事实（`architecture/sessions.md`）。

## architecture（现行架构与契约，10 篇）

宿主与执行层的职责边界，以及任务 / 会话 / 渠道 / 文件四条运行生命周期——判断「该谁做、边界在哪」先读这一组。

- `architecture/capability-boundary.md` — 能力边界判据档：Main（柜台）/Worker（后台）/用户/宿主四角色权界、单一来源能力目录、Worker→Main 结构化 outcome、结构化交办与三条禁令（多条机制标注未实现/待守卫）。
- `architecture/contract.md` — 宿主↔执行层契约语义面、禁止面与现行变更安全不变量（§6 为该位置的唯一提炼面）。
- `architecture/payload-arguments.md` — 执行层声明义务：结构化入参必须声明 `payload` + schema（宿主 lint → 物化文件 → 路径替换）；含 17dz 待改 4 个 operation。
- `architecture/tasks.md` — 任务底账只存事实、活/结束现推（不维护状态机）、取消请求与确认、`dispatchKey` 两层身份、等待与续跑。
- `architecture/sessions.md` — 会话转录与压缩：Pi 所有权、`.runtime/sessions`、压缩边界（retention 见 issue #67）。
- `architecture/channels.md` — 渠道三档（offline/shadow/live）、入站附件时序、silent 三档、出站六路。
- `architecture/files.md` — `fileId` 模型、`run_js`、per-run 目录、产物登记与保留期。
- `architecture/permissions.md` — 权限三层（渠道身份 / 宿主粗粒度求交 / 执行层实体授权）、角色三档（viewer/operator/admin）、细粒度未实现。
- `product/event-catalog.md` — 结构化事件字典（以 `23ae585` 为基线列 29 个；`attachment_nudge_*`、`task_result_delivery_*`、`recalc_*`、`run_dir_cleanup_startup*` 等新增事件以 `architecture/channels.md` 的事件表与代码为准）。
- `history/r4-joint-interfaces.md` — R4 联合接口约定 v1（P2/P5/P6/P4 冻结面，代码仍引用，已归档）。

## product（交互契约与能力页，2 篇）

- `product/capability.md` — 产品能力页：支持什么 / 预期行为 / 明确不做（owner 对接正式平台的一页纸；`scripts/product-capability-guard.test.ts` 守卫）。
- `product/interaction-contract.md` — 什么算"好用"：五条可验收尺子（不打扰 / 有预期 / 可查可接管 / 结论有据 / 分工透明）+ 每条现状。

## eval（评测口径与现行基线，6 篇）

怎么判、样本与预算怎么先写死、接下来还要跑什么——评测只看这一组，过程读数不回流成口径。

- `eval/README.md` — 三类入口、判据冻结纪律、预注册规则、读数与退出码（现行口径）。
- `eval/coverage-matrix.md` — 用户级自动化覆盖矩阵：按「用户能做什么」组织的覆盖图 + 场景 → 测试用例定位（`scripts/coverage-matrix-guard.test.ts` 守卫）。
- `product/business-coverage.md` — 业务级覆盖图（2026-11-19 起已被 `eval/coverage-matrix.md` 取代，仅留历史指针）。
- `history/r4-acceptance.md` — R4 验收用例设计（v1 预注册基线，测试按 P*-T* 编号引用，已归档）。
- `history/long-session-prereg.md` — R6 长会话压缩预注册（Wave1 已冻结、Wave2 待裁决；`scripts/eval/long-session/wave1-runner.ts:67` 运行时按其算 sha256，已归档）。
- `history/business-e2e-batch2-prereg.md` — P2 业务 E2E 预注册（七场景 21 样本 / 27 会话；尚未跑真实模型，仍是下一次运行的口径，已归档）。

## ops（运行、变量、联调与手工走查，9 篇）

今天怎么启动、变量从哪来、出事看哪里、真实面走到哪一步——排障与联调入口。

- `ops/handover.md` — 交付交接单：冻结基线、八刀交付物、门与复核方法、未覆盖面、必须先知道的风险（长连接离线丢消息实测）与上线前建议。
- `ops/README.md` — 启动与单实例纪律、`channel.mode` 三档、变量入口、排障 runbook。
- `ops/alerts.md` — 运营告警（四条规则与阈值、双出口、去重、原始文本可回溯不变量、真跑前置）。
- `ops/real-read-smoke.md` — 真实执行层只读冒烟判据清单（准备档；配套 `scripts/eval/real/smoke.ts`，默认干跑）。
- `ops/real-write-loop.md` — 真模型写闭环验收（`npm run eval:write-loop`；判据清单、真跑记录与已登记缺陷）。
- `ops/live-replay.md` — live 真库快照回归重放（只读快照副本、两模式、N1–N4/P1–P4 断言、快照更新）。
- `environment-variables.md` — 环境变量完整清单、默认值与缺失行为。
- `product/real-read-readiness.md` — 真实只读接入准备档（硬声明：准备材料 ≠ 已授权接入）。
- `product/wecom-live-dummy-cases.md` — 企微 × dummy 联调用例（W-01 起，自动/人工分工，含手工只判措辞/可用性与体验、手工证据不替代自动化门两条纪律）。

## decisions（决定、债务与作业纪律，2 篇）

「决定了什么、还欠什么、按什么纪律做事」——先查索引，再按指针进历史分片。

- `decisions/index.md` — 决定索引（每条一行：日期 / 主题 / 结论 / 历史分片指针）；§ 号沿用原 `decision-log` 编号，代码里指向旧文件的注释按本表考古。
- `decisions/debt.md` — 未清债务：issue 追踪、现行指针、待核旧账。

## design（设计稿，1 篇）

- `design/task-redefinition.md` — task 重定义（S1 起 task 无 `status`；保留 worker 汇报 + 宿主守护事实；落地切片 S0–S4 见文内）。

## history（历史档案，20 篇）

冻结的流水与判据档案，只作考古与引用锚点，不按现行规范读；引用时以分片行号为准，文内 worktree / 分支名按当时口径。

- `history/architecture-laws-2026-11_undated.md` — 律法与历史判据档案（2026-11-13 M4 注：多数守卫引用已退役；2026-11-19 移入 history）。
- `history/methodology-2026-11_undated.md` — 作业纪律与判据编号（2026-11-19 移入 history；现行纪律见 `../AGENTS.md` 与 `decisions/index.md`）。
- `history/decision-log-part01-2026-11_undated.md` — 第 1 块（读法、§零–§十五）。
- `history/decision-log-part02-2026-11.md` — 第 2 块（§十六–§四十九）。
- `history/decision-log-part03-2026-11.md` — 第 3 块（§五十–§七十一）。
- `history/decision-log-part04-2026-11.md` — 第 4 块（§七十二–§八十四）。
- `history/decision-log-part05-2026-11.md` — 第 5 块（§八十五–§九十四）。
- `history/decision-log-part06-2026-11_undated.md` — 第 6 块（§九十五–§一百、维护规则）。
- `history/change-safety-part01-2026-09_2026-10_2026-11_undated.md` — 防线档第 1 块（§0 模式铁律 / §1 通用防线 + 2026-09–10 波次）。
- `history/change-safety-part02-2026-10_2026-11_undated.md` — 防线档第 2 块。
- `history/change-safety-part03-2026-11.md` — 防线档第 3 块。
- `history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md` — 台账第 1 块。
- `history/debt-ledger-part02-2026-09_2026-10.md` — 台账第 2 块。
- `history/debt-ledger-part03-2026-10_2026-11.md` — 台账第 3 块（D-150 等已关条目在此）。
- `history/debt-ledger-part04-2026-11.md` — 台账第 4 块（未清项见 `decisions/debt.md`）。
- `history/long-session-coverage.md` — 长会话轨 LS1–LS6 的覆盖、判据来源、盲区与跑法（2026-11-19 移入 history）。
- `history/r4-stability-prereg.md` — R4 稳定性预注册（2026-11-14 冻结；`scripts/stab/*` 的 §三/§四 出处）。
- `history/business-e2e-prereg.md` — 业务 E2E 阶段 2 预注册（已收官）。
- `history/business-e2e-prereg-addendum.md` — 上述预注册的事后修订附录（owner 裁定：N=3 / 每轮 18 会话 / 总上限 150）。
- `history/business-e2e-final-report.md` — 业务 E2E 三轴总报告（功能边界 / 可靠性 / 稳定性，已收官）。
