# 决定索引

> 状态：现行。只列**今天仍会被代码或文档引用**的决定，每条一行：日期 / 主题 / 结论 / 指针。
> 同一主题的多轮记录已合并为一行并标「多轮」；未列入的条目是一次性实施记录或已被后继取代，正文都在历史分片（`../history/decision-log-part*.md`，全量快照 `../history/decision-log-2026-11.md`），本页不改写正文。
> § 号沿用原 `docs/decision-log.md` 编号（该文件已拆档、不在当前树）——代码与旧文档里指向 `docs/decision-log.md` §N 的注释，按本表指针考古。
> 未决项不在本页：GitHub issues #67–#74（逐项见 `debt.md`）。

| 日期 | 主题 | 结论 | 指针 |
|---|---|---|---|
| 2026-11-13 | Minimal Rewrite 收口（§九–§十二，多轮） | 旧 Runtime hub、demo 与试跑脚手架按可达性删除；产品面收敛为 `npm run ask` 与 `npm start` 两条路径；旧机制不恢复，恢复须先写「加回决定」 | `../history/decision-log-part01-2026-11_undated.md:563–606` |
| 2026-11-13 | M4 死代码清扫与契约收口（§十三） | 删 19 个跟踪文件 3,386 行；完成状态按 `completed`/`failed`/`unexecuted` 判定；契约收为四态（无 cancel/artifacts）；确定性门 = typecheck + unit | `../history/decision-log-part01-2026-11_undated.md:642` |
| 2026-11-13 | Eval 入口收口（§十四） | 真模型 workflow 改挂 `npm run eval:user`；eval-measure 退役；不重建评测平台 | `../history/decision-log-part01-2026-11_undated.md:736` |
| 2026-11-13 | R1 旧协议与旧治理清理（§十五） | 删旧 a2a 协议、contracts 未用面、generic-mock 评测簇；覆盖面由用户级 eval 承接；桥键闭集守卫缺口如实登记 | `../history/decision-log-part01-2026-11_undated.md:762` |
| 2026-11-13 | convergence-r1 判据冻结（§十六） | 12 用例 + 六维判定器；`criteriaSha256`/`casesSha256` 冻结后不得改；判定器缺陷按「修复→全样本复判→重切」流程处理 | `../history/decision-log-part02-2026-11.md:5` |
| 2026-11-13 | R2：E05 边界与 task.status（§十七） | 歧义标识先交执行层裁决（`needs_input` + candidates），不猜候选；判据 v1 不变；task.status 语义边界登记 | `../history/decision-log-part02-2026-11.md:40` |
| 2026-11-14 | R3 收官裁定与只读准备档（§二十二–§二十四，多轮） | M01=a（复用同任务内有效事实）、E01=a（修判据形态）、真实只读仅准备档、holdout 封存；E01/M01 按裁定落实 | `../history/decision-log-part02-2026-11.md:120–150` |
| 2026-11-14 | P1–P4 产品切片（§十八–§二十一，多轮） | 任务查看 / 结果交付 / `--redo` 重新交办 / 只读 ops 快照落地；`--redo` 是重新交办，不是人工接管或会话续跑 | `../history/decision-log-part02-2026-11.md:83–119` |
| 2026-11-14 | R4 切片 P0–P7b（§二十七–§四十一，多轮） | 装配同源、S4 统计四态、Task Registry 契约冻结、后台任务、通知与完整验收全部落地；唯一未落地的 P8 转 issue #71 | `../history/decision-log-part02-2026-11.md:172–341` |
| 2026-11-14 | P5 资源强制（§三十二） | `runtime` 段为唯一配置源；`ResourcePolicy` 纯逻辑（并发/队列/深度/共享预算/等待）；host 六个未消费键删除 | `../history/decision-log-part02-2026-11.md:223` |
| 2026-11-14–15 | 业务 E2E 三轴（§四十二–§五十，多轮） | 五路能力审计 + 阶段 1/2 + 缺口 1/2/3 实施 + 三实验 + 夜跑续批；读数全部探索性，不作稳定性结论 | `../history/decision-log-part02-2026-11.md:344`、`../history/decision-log-part03-2026-11.md:5` |
| 2026-11-15 | R5 P0 修复（§五十四） | 任务引用接受 `#N`/裸数字、inline 回执补 `taskNo`；压缩不变式 INV（请求前复核）、后台回合预算计量；已合入 | `../history/decision-log-part03-2026-11.md:72` |
| 2026-11-15 | 压缩机制归属与 Pi 原生替换（§六十九、§七十七、§八十九–§九十六，多轮） | D1 请求前 INV 复核保留（反向绊线证明 `transformContext` 单独拦不住）、D2/D3 收敛；最终采单长生命周期 Pi Session + Pi 原生压缩，自研压缩编排删除 | `../history/decision-log-part03-2026-11.md:658`、`../history/decision-log-part05-2026-11.md:304`、`../history/decision-log-part06-2026-11_undated.md:90` |
| 2026-11-15 | R6 长会话预注册（§七十八） | 五轨（LS1–LS5）各 N=15、真实 128k、每会话 ≥3 次压缩；Wilson 95% CI 落会话层；失败分类 E-A–E-K 冻结 | `../history/decision-log-part04-2026-11.md:270` |
| 2026-11-15 | B1 会话持久化 + B2 Silent Shadow（§八十–§八十七，多轮） | B1 持久化接入真实会话生命周期；B2 出站整体包裹、缺省静默、opt-in 放行；真实租户联调待 issue #74 | `../history/decision-log-part04-2026-11.md:439`、`../history/decision-log-part05-2026-11.md:5` |
| 2026-11-15–16 | P2 业务 E2E：预注册与落成（§八十八、§九十八，多轮） | 七场景 21 样本 / 27 会话预注册（N=3、单会话硬停）；9 个 case 落成、确定性自检通过，待真实模型执行 | `../history/decision-log-part05-2026-11.md:231`、`../history/decision-log-part06-2026-11_undated.md:236` |
| 2026-11-16 | U3 稳定逻辑操作身份 `dispatchKey`（§九十七） | 新增 `operations` 账 + 两层身份（`delegationId` / `dispatchKey`）；同 key 异 op 确定性拒绝；重试不另铸身份；结果未知 → `result_unknown` 待核对 | `../history/decision-log-part06-2026-11_undated.md:145` |
| 2026-11-17 | CAP-01 收口（§九十九） | S3 端到端 2/5 接受为模型能力包络；run 目录保留 30 天；并发 4；渠道三档；软链 fail-closed；跨会话能力不做 | `../history/decision-log-part06-2026-11_undated.md:255` |
| 2026-11-17–18 | recalc_xlsx 集成（§一百） | `recalc_xlsx` 仅 Main 宿主工具；LibreOffice 26.8.3 仅 PATH 可见时上工具面、缺失 fail-closed；投递门报告驱动、只按 sha256 绑定；一条重编码残余登记 | `../history/decision-log-part06-2026-11_undated.md:305` |
| 2026-11-18 | 文档清理与未决项转 issue | 五轮删除 93 篇 + 1 篇移出 docs；未决项转 GitHub #67–#74；仓库不再保留待办/待裁定文档 | `../index.md`、`../../AGENTS.md:71` |
