# R3 收官：产品面状态与待裁定登记（2026-11-14）

> Dummy 产品弧（P1–P4 + Harness + 收官认证）已全部合入并推送至 `arch/integration` @ `0e51b62`；`main` 未动、tag 未动。
> 本文件是弧终止包：① 现产品面一览；② 待 owner 裁定 14 项（问题/选项/建议/证据指针）；③ 下一档授权门与启动条件。
> 裁决后按项执行并更新本文件；**未裁定项保持登记，不自主推进**。

## 一、现产品面（命令与证据）

| 能力 | 命令 | 证据指针 |
|---|---|---|
| 交办（一问一答） | `npm run ask -- "<消息>"` | M5 报告（`scripts/eval/convergence-r1/report-round1.md`） |
| 渠道服务 | `npm start` | decision-log §十二 |
| 任务列表 / 详情 | `npm run tasks` / `npm run tasks -- <id>` | `docs/product/p1-task-viewing.md`、§十八 |
| 结果交付件导出 | `npm run tasks -- <id> --out <path>` | `docs/product/p2-result-delivery.md`、§十九 |
| 重新推进（redo） | `npm run tasks -- <id> --redo` | `docs/product/p3-human-redo.md`、§二十 |
| 运营快照（只读静态页） | `npm run ops [--out <dir>]` | `docs/product/p4-ops-console.md`、§二十一 |
| 评测（Harness） | `npm run eval:user`（R1/X/M 套件）；`scripts/eval/exploration/stats.ts`（compare/report） | Batch 2 报告、`quality-report-v1.md`、§二十二 |

收官认证读数（集成帧、N=1 冒烟）：**27 例 = 21 PASS / 6 FAIL / 0 INCONCLUSIVE**；门全绿；冻结面零改动（`docs/product/r3-arc-regression.md`）。

## 二、待裁定登记（14 项）

### A. 行为口径

1. **M01 口径**——「收窄轮复用上下文不再执行」的判定。
   - 选项：a) 复用可接受 → 走冻结流程重切用例（保留原样本）；b) 必须重新执行 → 按预注册立项最小假设实验；c) 挂起。
   - 建议：**a**（省冗余查询、对用户更优；「回退宽范围」目标形态 15 次未出现）。证据：`report-r3-batch2.md` 附录 B、认证 §四。
2. **E01 判据形态**——有序列表序号「2.」被当不可溯源数值 → 误报 `FAIL_FABRICATED_DATA`。
   - 选项：a) 走判据修复流程（数字提取排除有序列表标记；保留原样本、重切 `criteria.lock`、重判归档；不改判据语义面，参照 M5 先例）；b) 维持冻结仅登记；c) 暂缓。
   - 建议：**a**。证据：认证 §二（`judge.ts:774-784`、`:65-79`）。

### B. 数据与展示（P1/P2 登记项）

3. **Main 最终回复持久化**（交付件/详情目前缺「用户可见最终回复」）——涉 schema/写语义。
   - 建议：与「写路径/确认环」一并裁定（同属写语义演进），届时作为独立小切片设计（含迁移与只读兼容）。
4. **执行步骤时间戳**（`executions` 表无时间列）——建议：同上，一并裁定。
5. **「未执行」口径**（纯聊天不产生任务）——建议：接受现行（与冻结语义一致；证据 P1 §五.3）。
6. **`--principal` 过滤**（当前列表为全 principal 视图）——建议：暂不做（单用户 Dummy；多用户部署前再定）。
7. **`--force` 覆盖选项**（导出默认拒绝覆盖）——建议：不加（拒绝覆盖更安全；需要时手动删除）。
8. **交付件生成时间行 / 批量导出**——建议：均不加（保持纯函数可 diff、单任务单文件；需要时再切）。

### C. P4 登记项

9. **`scripts/tasks.ts` 的 `import.meta.main` 守卫**（供 ops 复用渲染函数）——建议：接受（最小、被 import 时零 CLI 副作用）。
10. **失败清单含「未执行」**——建议：保持（信息完整）。
11. **质量报告文本指针目标**（`quality-report-v1.md` + `npm run eval:user`）——建议：现行。
12. **页面标题/文案**（「fshine-agent 运营快照」）——建议：现行；如你定稿请给出文案。

### D. Eval 资产

13. **holdout H01–H04 运行时机**——建议：保持封存至候选改动/终验（纪律：「候选改动后才用」）；若想现在取泛化读数亦可（一次性，结果归探索、不作稳定性结论）。
    - 授权后启动命令（留存证据、不调优）：`LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/holdout`
14. **候选池并入下一 eval 批次**（候选悬置指代等，见探索报告 R-10/§5）——建议：若开新 eval 批次则并入。

## 三、下一档授权门与启动条件

| 门 | 内容 | 启动条件 |
|---|---|---|
| 真实只读接入 | 接入设计与凭据/鉴权边界 + 安全评审材料（先不触真实平台）→ 评审通过 → 实际接入 | owner 批 |
| 写路径 / 确认环 | WS 族用例、`confirm` 语义、执行层授权边界 | owner 语义裁定 |
| 发布 | — | owner |
| 各待裁定项 | 见第二节逐项建议 | 对应裁定 |

## 附录：本文件来源

- 切片报告：`docs/product/p1-task-viewing.md`、`p2-result-delivery.md`、`p3-human-redo.md`、`p4-ops-console.md`
- 批次报告：`scripts/eval/exploration/report-r3-exploration.md`、`report-r3-batch2.md`、`quality-report-v1.md`；`docs/product/r3-arc-regression.md`
- decision-log：§十八–§二十二
