# 未清债务

> 状态：现行。只列**未清**项；已关条目与 2026-09/10 波次关账记录在历史分片（`../history/debt-ledger*.md`）。
> 核对口径（2026-11-18）：逐条读分片里状态为「待办 / 登记 / 部分落地」的条目，用当前树核对它引用的代码路径。**不自行判定已清**——无现行代码指针、无 issue 号、且无结案记录的，一律 `待核`。
> 核对规模：分片共 72 条带编号未清项 + 4 条无编号登记；8 条仍有现行指针（§二），64 条指针已失效（§三）。

## 一、issue 追踪（有 issue 号）

| 编号 | 事项 | 证据 / 指针 | 状态 |
|---|---|---|---|
| #67 | 会话存储 retention / capacity（线性无界增长） | `../architecture/sessions.md:3`、`:53` | 未清 |
| #68 | 跨重启消息级幂等 / 真续跑恢复 | `../../AGENTS.md:71`；`../../README.md:93` | 未清 |
| #69 | `executions` 时间列 | `../../AGENTS.md:71` | 未清 |
| #70 | tasks CLI 增强 | `../../AGENTS.md:71` | 未清 |
| #71 | P8 ops 扩展（原 R4 唯一未落地分片） | `../../AGENTS.md:71`；`index.md`（R4 行） | 未清 |
| #72 | 死代码重复实现 | `../../AGENTS.md:71` | 未清 |
| #73 | eval 候选池 | `../../AGENTS.md:71` | 未清 |
| #74 | B2 Silent Shadow 真实租户联调 | `../architecture/channels.md:3` | 未清 |

## 二、有现行指针、无 issue 号（逐条核对）

| 编号 | 事项 | 现行证据 | 状态 |
|---|---|---|---|
| D-204 | dummy 夹具两套 commit 令牌契约不一致 | `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:542-545` 注释自述「两者不一致已登记」；`verifyProposalToken` 见 `:479`，script 绑定校验见 `:927`/`:1014` | 待办（未统一） |
| D-156 | 两支真实读数（61,000 / 86,000）残留 | `docs/architecture-laws.md:240`「遗留待清」；现行树 grep 仅此一行命中 | 待办（无 issue） |
| D-052 | `step-text.ts` 六个退役工具名死分支 | `packages/agent/src/step-text.ts` 仍在，但六个工具名 grep 零命中；无结案记录 | 待核 |
| D-062 | `npm test` 在无凭据环境全红 | `package.json:9`（`vitest run`）；无结案记录 | 待核 |
| D-168 | 门①「产品面」口径未定义 | 现行树 `grep -rn '17dz' packages apps scripts --include='*.ts'` 零命中；无结案记录 | 待核 |
| D-170 | exposure-lint 剩余核对与扩展 | `packages/agent/exposure-lint.test.ts` 已不存在（`ls` 实测）；无结案记录 | 待核 |
| D-190 | 门①测试夹具豁免口径分歧 | `docs/architecture-laws.md` 仍在，但 17dz 字面量零命中；无结案记录 | 待核 |
| D-196 | 退役 `FSHINE_PLATFORM_ROOT` | `grep -rn 'FSHINE_PLATFORM_ROOT'` 零命中；无结案记录 | 待核 |

## 三、指针失效、无结案记录 → 待核（64 条）

以下条目引用的文件在当前树均已不存在；**没有结案记录，不等于已清**。

- 旧宿主 Runtime / 写路径 / 业务词表（15 条）：D-001、D-003、D-004、D-005、D-010、D-016、D-017、D-030、D-031、D-032、D-050、D-051、D-066、D-067、D-083 附条 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:102` 起、`../history/debt-ledger-part02-2026-09_2026-10.md:217`。
- 兄弟仓 `17dz-platform`（8 条，不在本 worktree）：D-015、D-053、D-056、D-057、D-061、D-064、D-173、D-193 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:335` 起、`../history/debt-ledger-part03-2026-10_2026-11.md:729`。
- 旧评测 / 守卫 / 发布 / 迁移面（41 条）：D-147、D-148、D-152、D-153、D-154、D-157、D-159–D-167、D-169、D-171、D-172、D-174、D-175、D-178、D-181–D-188、D-192、D-194、D-195、D-197、D-198、D-199、D-201、D-202、D-203、D-205、D-206、D-209 — `../history/debt-ledger-part03-2026-10_2026-11.md:243` 起、`../history/debt-ledger-part04-2026-11.md:333`。
- 无编号登记（4 条）：已知短板、其余 6 真 1 半的证据链、architecture-laws「当前违例」对账、F3 未留档项 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:50`、`:75`；`../history/debt-ledger-part03-2026-10_2026-11.md:223`、`:314`。

## 四、现行文档已登记的缺口（非台账拆分来源）

| 事项 | 证据 / 指针 | 状态 |
|---|---|---|
| `eval:cap01` 的 r6 面指向不存在的 `r6-lifecycle.ts`（实为 `lifecycle.ts`） | `../eval/README.md:17`；`scripts/eval/cap01/run-all.ts:40`；`test -f` 实测 MISSING | 未清 |
| 判据锁只校验 criteria/cases 聚合值、不校验 `files` 表 | `../eval/README.md:26`；`scripts/eval/convergence-r1/runner.ts:220-230` | 未清 |
| 服务无进程锁 / 单实例仅靠操作纪律；双实例共享 `.runtime/state.db` 行为未定义 | `../ops/README.md:14` | 未清 |
| `DB_PATH` 文档缺省与实际代码不一致（文档 `data/agent.db`，代码 `.runtime/state.db`） | `../ops/README.md:39`；`../environment-variables.md:33`；`apps/server/main.ts:42-44` | 未清（文档待改） |

## 五、明确「接受不修 / 登记不修」（非待办，勿重开）

D-005 附条（`scripts/` 144 处接受不修）、D-006（验收替身数据）、D-040（auth 正则过渡债，限期）、D-054（`.env.real` 仓库侧已关）、D-149（提案 schema 死循环登记不修）、D-158（gitee refs 残留登记不修）— 原文见 `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md`、`../history/debt-ledger-part03-2026-10_2026-11.md`。
