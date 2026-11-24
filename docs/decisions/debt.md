# 未清债务

> 状态：现行。只列**未清**项；已关条目与 2026-09/10 波次关账记录在历史分片（`../history/debt-ledger*.md`）。
> 核对口径（2026-11-18）：逐条读分片里状态为「待办 / 登记 / 部分落地」的条目，用当前树核对它引用的代码路径。**不自行判定已清**——无现行代码指针、无 issue 号、且无结案记录的，一律 `待核`。
> 核对规模：分片共 72 条带编号未清项 + 4 条无编号登记；8 条仍有现行指针（§二），64 条指针已失效（§三）。
> 2026-11-24 debt 切片（HEAD `2645e46f`）对 §二 8 条逐条对现行树核实：3 条结案（D-052 / D-062 / D-196，凭据见各行）、5 条改写登记（D-204 / D-156 / D-168 / D-170 / D-190）。§二 全部 `file:LINE` 指针与各行「现状陈述」由 `scripts/debt-ledger-guard.test.ts` 机械看守（现状一变即红，逼台账同步复核）。

## 一、issue 追踪（有 issue 号）

| 编号 | 事项 | 证据 / 指针 | 状态 |
|---|---|---|---|
| #67 | 会话存储 retention / capacity（线性无界增长） | `../architecture/sessions.md:35-37` | 未清 |
| #68 | 跨重启消息级幂等 / 真续跑恢复 | `../../AGENTS.md:97`；`../../README.md:93` | 未清 |
| #69 | `executions` 时间列 | `packages/core/src/task-store.ts`（`executionTimeColumnsMissing` 前向加法迁移 + SCHEMA_BASE 两列 + 写读映射）；守卫 `packages/core/task-store-migration-execution-times.test.ts`（迁移/只读/不伪造）、`packages/agent/execution-time-columns.test.ts` 与 `packages/agent/runtime.test.ts` 与 `packages/agent/runtime-worker-run-js.test.ts`（三处真实执行边界落时刻）、`scripts/tasks.test.ts` + `scripts/ops.test.ts`（有/无时刻两态） | 已清（2026-11-24） |
| #70 | tasks CLI 增强（2026-11-24 已清） | `../../AGENTS.md:97`；`scripts/tasks.ts`（USAGE/`--force`/批量导出/交付件时间行） | 已清：`--force` 默认拒绝覆盖逐字不变、批量导出一个任务一个 `task-<编号>.md`、交付件多一行「生成时间」；判据见 `scripts/tasks.test.ts` |
| #71 | P8 ops 扩展（原 R4 唯一未落地分片） | `../../AGENTS.md:97`；`index.md`（R4 行） | 未清 |
| #72 | 死代码重复实现 | 收敛记录见 `index.md`（2026-11-24 行）；守卫 `packages/agent/dead-code-merge.test.ts` | 已清（2026-11-24：8 组全部择一；`scripts/eval/**` 下 6 份 `jsonSafe` 历史夹具副本与 `scripts/ask-replay.ts` 的异名同义 `messageOf` 另行登记，理由见守卫文件头） |
| #73 | eval 候选池 | `../../AGENTS.md:97` | 未清 |
| #74 | B2 Silent Shadow 真实租户联调 | `../architecture/channels.md:3` | 未清 |

## 一之补、Eval 判据已知方差（2026-11-24 登记，不修）

| 编号 | 是什么 | 后果 | 为何不修 | 现行证据 |
|---|---|---|---|---|
| V-1 | E15「运算必须给出处」的来源语义族锚点仍有漏判：集成分支 eval:user 14/15，唯一红是 E15 `FAIL_STATE_INCONSISTENCY`（①来源锚点全未命中）。模型答「共 2 条记录，金额合计 2000（明细：alpha-item-1 1200、alpha-item-2 800）」——数值对、执行层确实返回了 `sum: 2000`（`FAIL_UNSOURCED_AGGREGATE` 没判）、没心算也没冒充来源，只是**没写出处** | E15 会随模型措辞方差偶发红；不影响数据正确性判据 | 判据是 owner 2026-11-18 定口径的有意从严（「只给数字不给出处」即判负，宁可暴露缺口不接受心算）。把「明细：」算成出处 = 为凑绿放宽判据，AGENTS.md 判据红线禁止。已观察到信息丢失发生在 Main 转述层（Worker 汇报原文有「对方的返回是」，Main 的回复丢了），属模型行为，不是宿主缺陷 | `scripts/eval/convergence-r1/cases/E15.ts` 的 `hardAnchors[1]`（六族 regexAny）；eval 读数 `.runtime/eval-r1/` |

## 二、有现行指针、无 issue 号（逐条核对）

> 2026-11-24 debt 切片（HEAD `2645e46f`）逐条对现行树核实：3 条结案（本行留档，下次清理删除）、5 条改写登记。结案的写清凭什么结；不能结的写清实测现状与为什么还不能结——口径存疑的写明存疑什么，不自行拍板。

| 编号 | 事项 | 现行证据 | 状态 |
|---|---|---|---|
| D-204 | dummy 夹具两套 commit 令牌契约不一致 | 2026-11-24 复核：两套契约仍在，与 2026-11-20 登记指针逐条对上——proposal-commit 路径 `verifyProposalToken`（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:723-735`）验 HMAC + `{proposalId, expiresAt}`、**不读 script**；其令牌门 fail-closed（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:789-792`），注释自述「两者不一致已登记 debt-ledger，本轮不合并」；`dummy.commit` 直提两处（结构化 call `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1191-1204`、bash 直提 `scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1283-1297`）是 `if (secret)` 有门才验，且内联校验多一项 `p.script === op.name`（`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1201`/`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:1295`）。同一 secret 签出的令牌两路径期望形状不同（script 绑定有无）+ 门控方向不同（fail-closed vs 有 secret 才验），维护者容易签错 | 待办（未统一；`scripts/debt-ledger-guard.test.ts` D-204 例钉住现状，任一侧被统一即红） |
| D-156 | 两支真实读数（61,000 / 86,000）残留 | 2026-11-24 复核（pattern `61,000`/`86,000`/`61000`/`86000`，全树 grep）：**非档案面零命中**（packages/apps/scripts/config/tests/.github/patches/docs 现行文档/README/AGENTS/package.json）；档案面 9 行——`docs/history/architecture-laws-2026-11_undated.md:242`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:580`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:712`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:154`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:155`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:256`、`docs/history/debt-ledger-part02-2026-09_2026-10.md:258`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:354`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:356`；本表自身 1 行（D-156 行）。**口径存疑（未拍板，不自行结案）**：原判据「全树机械替换为虚构值 + exposure-lint D 类收词后零命中」——收词对象 exposure-lint 已随 Reset 删除（见 D-170 行），判据形状失效；「全树」是否含 history 档案原文未定义（2026-11-20 登记即写「复现不出仅此一行命中，原口径待考」）；按「过程史不重写」惯例档案 9 行不动。防复发由后继守卫接管：`scripts/debt-ledger-guard.test.ts` D-156 例钉住「非档案面零命中 + 档案 9 行」 | 登记（现行面已清、档案面口径存疑；无 issue） |
| D-052 | `packages/agent/src/step-text.ts` 六个退役工具名死分支 | 2026-11-24 结案核实：① 死分支已不在——该文件无 `switch (toolName)`，六个退役工具名（`search_account_sets`/`get_current_accounting_period`/`list_vouchers`/`inspect_account_set`/`search_references`/`get_login_status`）文件内 grep 零命中，`defaultStepText` 已退化为通用模板（`packages/agent/src/step-text.ts:51-53`）；② 测试改钉新行为——`packages/agent/step-text.test.ts:17-20`「非内部工具回退到通用工具名模板（直接平台工具已退役，不再有具名帧）」；③ 白名单 6 条随载体 `packages/agent/platform-leak-lint.test.ts` 一并不在树内（`ls` 实测），`rememberAccountSets` 全仓零命中；④ 关账记录早在 Wave 1（2026-11-20 重建写「无结案记录」系漏查）：`docs/history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:898`「step-text 死簇连专属死代码（names/rememberAccountSets）整簇删，同步删 lint 白名单 6 条」 | 已清（2026-11-24 对现行树核实；守卫 = `scripts/debt-ledger-guard.test.ts` D-052 例 + 既有 `packages/agent/step-text.test.ts`；本行留档，下次清理删除） |
| D-062 | `npm test` 在无凭据环境全红 | 2026-11-24 结案核实：① 原复现命令 `env -u WECOM_BOT_ID -u WECOM_BOT_SECRET npx vitest run`（原文口径）实测 exit 0——279 测试文件全过、2790 例过 / 2 跳 / 3 todo；原文「17 文件 52 例全红」的失败形态不存在；② 红的根因（e2e harness 启动真实 `WecomBotChannel`，硬性要求企微凭据）随旧 e2e 套件删除——`vitest.config.ts:5`、`scripts/ci.sh:18`，`tests/e2e/harness.ts` 已删除；③ 现行触及企微凭据的用例全部自供假值（`packages/channel-wecom/adapter.test.ts:20`、`apps/server/server.test.ts:190` 等），无用例从 `process.env` 读企微凭据（守卫）；④ Wave 1 关账记录：`docs/history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:895`「正常/无凭据两环境均 60 文件 572 例全绿」（2026-11-20 重建写「无结案记录」系漏查）。附注（如实）：真实渠道联调不在确定性门内，登记在 issue #74；这是覆盖面的真实状态，非本次新造口径 | 已清（2026-11-24 实测；守卫 = `scripts/debt-ledger-guard.test.ts` D-062 例；本行留档，下次清理删除） |
| D-168 | 门①「产品面」口径未定义 | 2026-11-24 复核：packages/apps 非测试文件 17dz **零命中**——2026-11-20 登记的最后一处（`packages/agent/src/user-facing-failure.ts` 注释级）已随当日两次重构（`f0fa7104` 宿主不再判失败种类、`5435604b` 业务侵入行为全删）移除；测试/夹具面 3 行：`packages/agent/payload-oneof.test.ts:2`、`packages/agent/payload-oneof.test.ts:23`（17dz voucher schema 形状夹具）、`scripts/eval/real/smoke.ts:4`（真实执行层只读冒烟准备档，owner 2026-11-19 只批准准备档）。**口径存疑（未拍板，不自行裁定）**：原判据要 owner 拍板「产品面」是否含测试夹具与 scripts/，并在 `change-safety.md` / `architecture-laws.md` 落地正式条目——两份文档已随 Minimal Reset 删除（现行树不存在），platform-leak-lint 的豁免惯例同批不在树内（见 D-170 行），拍板载体没了；`scripts/eval/real/smoke.ts` 这类 scripts/ 非测试文件按职责必须点名真实执行层，算不算「产品面」未见 owner 裁定 | 登记（口径存疑：scripts/ 非测试探针的归属未拍板；无 issue） |
| D-170 | exposure-lint 剩余核对与扩展 | 2026-11-24 复核：核对对象已不在树内——`packages/agent/exposure-lint.test.ts` 不存在（`ls` 实测），同批不在树内的还有 `packages/agent/platform-leak-lint.test.ts`、身份面守卫 `packages/agent/execution-identity-surface.test.ts` 与 HG1 `packages/agent/history-hygiene.test.ts`：前三者删于 Reset 可达性删除 `0b972273`（HG1 更早不在树内，R1 审计把它列为已删对象），删除记录与「恢复最小闭集守卫或改 D-209 闭环判据属 owner 待裁定」在 `docs/history/decision-log-part01-2026-11_undated.md:716`；M4 复核轮清掉注释里对 exposure-lint 的陈旧指向（`docs/history/decision-log-part01-2026-11_undated.md:708`、R1 `docs/history/decision-log-part01-2026-11_undated.md:774`）。原残留两项因此失效：①「三道守卫逐一道具核对在 CI 内运行」的对象（exposure-lint / 身份面守卫 / HG1）四散俱删；门④所属迁移波次随 Minimal Rewrite 收口；②「波次 4 按需扩展类别」同批作废 | 登记（主体随 Reset 删除并有决策记录；残留 = D-209 的 owner 待裁定，见 §三） |
| D-190 | 门①测试夹具豁免口径分歧 | 2026-11-24 复核（口径同 D-168）：产品面（packages/apps 非测试文件）17dz **零命中**（最后一处随 `f0fa7104`/`5435604b` 删除）；测试/夹具面 3 行即 D-168 清单（`packages/agent/payload-oneof.test.ts:2`、`packages/agent/payload-oneof.test.ts:23`、`scripts/eval/real/smoke.ts:4`）。原判据「owner 拍板后在 `change-safety.md` 或 `architecture-laws.md` 落地正式条目，且 `platform-leak-lint.test.ts` 的豁免范围与该条目一致」——两份文档与该测试文件均已不在树内（见 D-170 行），裁定载体不存在；未见到 owner 拍板记录 | 登记（口径存疑：拍板载体已删、裁定未见；无 issue） |
| D-196 | 退役 `FSHINE_PLATFORM_ROOT` | 2026-11-24 结案核实：① `grep -rn FSHINE_PLATFORM_ROOT` 全树（除 git 历史）实测 9 命中，全在档案面——本表 D-196 行自身 1 行 + `docs/history/` 8 行（`docs/history/change-safety-part02-2026-10_2026-11_undated.md:339`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:495`、`docs/history/change-safety-part02-2026-10_2026-11_undated.md:708`、`docs/history/change-safety-part03-2026-11.md:206`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:339`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:762`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:765`、`docs/history/debt-ledger-part03-2026-10_2026-11.md:767`）；代码面（packages/apps/scripts/config/tests/.github/patches/README/AGENTS/package.json 及任何非 docs 文件）零命中，符合原判据④「空或仅剩档案登记」；② 判据①③：全量 `vitest run` 与 `tsc --noEmit` 2026-11-24 全绿；③ 判据②⑤的对象 `tests/e2e/harness.ts` 已删除（随 Minimal Reset；`vitest.config.ts:5`、`scripts/ci.sh:18`），统一配置解析继任者在 `scripts/resolve-config-path.ts:25`（`explicitConfigFrom`：`--config` > `AGENT_CONFIG_PATH` > 各入口缺省；隐式回退链已随 M4 退役） | 已清（2026-11-24 对现行树核实；②⑤ 因对象删除而 moot，继任配置机制有指针；守卫 = `scripts/debt-ledger-guard.test.ts` D-196 例；本行留档，下次清理删除） |

## 三、指针失效、无结案记录 → 待核（64 条）

以下条目引用的文件在当前树均已不存在；**没有结案记录，不等于已清**。

- 旧宿主 Runtime / 写路径 / 业务词表（15 条）：D-001、D-003、D-004、D-005、D-010、D-016、D-017、D-030、D-031、D-032、D-050、D-051、D-066、D-067、D-083 附条 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:102` 起、`../history/debt-ledger-part02-2026-09_2026-10.md:217`。
- 兄弟仓 `17dz-platform`（8 条，不在本 worktree）：D-015、D-053、D-056、D-057、D-061、D-064、D-173、D-193 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:335` 起、`../history/debt-ledger-part03-2026-10_2026-11.md:729`。
- 旧评测 / 守卫 / 发布 / 迁移面（41 条）：D-147、D-148、D-152、D-153、D-154、D-157、D-159–D-167、D-169、D-171、D-172、D-174、D-175、D-178、D-181–D-188、D-192、D-194、D-195、D-197、D-198、D-199、D-201、D-202、D-203、D-205、D-206、D-209 — `../history/debt-ledger-part03-2026-10_2026-11.md:243` 起、`../history/debt-ledger-part04-2026-11.md:333`。
- 无编号登记（4 条）：已知短板、其余 6 真 1 半的证据链、architecture-laws「当前违例」对账、F3 未留档项 — `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md:50`、`:75`；`../history/debt-ledger-part03-2026-10_2026-11.md:223`、`:314`。

## 四、现行文档已登记的缺口（非台账拆分来源）

| 事项 | 证据 / 指针 | 状态 |
|---|---|---|
| `eval:cap01` 的 r6 面已改指 `lifecycle.ts`（2026-11-18 同步） | `scripts/eval/cap01/run-all.ts:40`；`../eval/README.md:12` | 已清 |
| `eval:cap01` R2 S1 场景已退役（原「Main 直做写 out/ 并由宿主投递」；交付物只从 Worker 出，Main 的 run_js 只能写 scratch/） | `scripts/eval/cap01/r2-functional.ts` 文件头；`packages/agent/src/run-js-executor.ts`（RunJsWritableDirs）；等价覆盖 = 同文件 S3（Worker 产物回 Main + 逐格 + 登记 + 行数据不出 Main） | 已退役（2026-11-19） |
| 判据锁只校验 criteria/cases 聚合值、不校验 `files` 表 | `../eval/README.md:24`；`scripts/eval/convergence-r1/runner.ts:220-230` | 未清 |
| 服务单实例 | 已清（2026-11-19 起有机械守卫）：启动取独占锁、存活实例在则 exit(1)、陈旧锁可覆盖；取锁先于连接渠道 | `apps/server/main.ts:53`（`guardSingleInstance`）；`apps/server/instance-guard.ts`；守卫 `apps/server/instance-guard.test.ts`（5 条）；`../ops/README.md:13` | 已清（2026-11-20 核对：原文「无进程锁/仅靠操作纪律」已不成立；本行留档，下次清理删除） |
| `DB_PATH` 文档缺省与实际代码不一致（文档 `data/agent.db`，代码 `.runtime/state.db`） | `../ops/README.md:34`；`../environment-variables.md:33`；`apps/server/main.ts:44-46` | 未清（文档待改） |

## 五、明确「接受不修 / 登记不修」（非待办，勿重开）

D-005 附条（`scripts/` 144 处接受不修）、D-006（验收替身数据）、D-040（auth 正则过渡债，限期）、D-054（`.env.real` 仓库侧已关）、D-149（提案 schema 死循环登记不修）、D-158（gitee refs 残留登记不修）— 原文见 `../history/debt-ledger-part01-2026-09_2026-10_2026-11_undated.md`、`../history/debt-ledger-part03-2026-10_2026-11.md`。

## 六、文件去重边界（2026-11-18 实测登记，本次不修）

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| F-1 | 纯附件重发（尚未激活的 pending 行）不去重：同内容连发两次 → 两行两个 fileId | **已清**（fee86cee，2026-11-18：pending→pending 复用同一 fileId）。现行证据：`packages/agent/src/file-store.ts:557`（`findReusableInboundRow` 不再跳过 pending）、`:973-977`（复用分支：pending 刷 name/created_at 且保持 pending）；守卫 `packages/agent/file-store-dedupe-ttl.test.ts`、`packages/agent/file-store-inbound.test.ts`（①/② pending 语义） | 已清（2026-11-20 核对） |
| F-2 | 入站复用没有「来源」判据，理论上会吞同字节的 Main 产物行（`putFile` 造的、如 recalc 的 `*.values.csv`）：行名会被改成入站文件名 | `packages/agent/src/file-store.ts:557-563`（`findReusableInboundRow` 只排除 `taskId !== undefined` 的行）；`putFile` 的 Main 行 `:714-738`；复用改名/TTL 刷新 `:598-629`（`reuseInboundRow`） | 修法需给 `file_refs` 加 origin 列并覆盖所有写路径（putFile / registerFromFd / 任务副本 / 回程），是 schema 迁移；当前同字节碰撞概率低但真实存在，登记到下次 schema 变更一起做 |
| F-3 | 同一消息内两个同内容不同名附件塌成同一 fileId、只留最后一个名字，而 `apps/server/attachment-facts.ts:87` 按 fileId 只留第一条事实 → 注入模型的名字与清单名不一致 | `packages/agent/src/file-store.ts:557-576`（入站复用 `findReusableInboundRow`，不区分消息内批次）；`apps/server/attachment-facts.ts:87` | 需要批次身份（`file_refs` 无 `message_id`）或改事实队列按 (fileId,name) 去重；后者仍会让清单只有一个名字、与模型看到的两条事实不一致。正确修法是同消息批次内复用检测 + 名字冲突裁定，需产品裁定，本次只登记 |

## 七、权限模型（2026-11-18 owner 裁定：解耦 + 只做粗粒度）

**裁定**：`accountSetScope` 这类**业务实体字段不与执行层耦合**（执行层不一定是财税平台）；fshine 与执行层之间只耦合**通用 permissions**（粗粒度：read / write）。粗粒度由 fshine 在发起前拦截；**细粒度（实体级）研判归执行层，暂不做**。

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| P-1 | ~~`principals.capabilities` / `principals.accountSetScope` 解析后**无任何消费点**（配置写了不生效）~~ **已解决（2026-11-19 RBAC 切片）** | 两字段已从 `PrincipalConfig` 删除；加载层忽略旧键（`packages/core/src/config.ts:339-340`）。角色表 `roles` + `principals.<id>.role` 取代：`packages/core/src/config.ts:296`（`parseRoles`）、`scripts/ask-runtime.ts:452`（求交口径）、`:533`（`resolveExecutionFace` 收口）、`apps/server/server.ts:1135`（`allowedPermissions: permissionsOfRole(...)`；旧行号 `:686` 系 RBAC 切片后随文件增长漂移） | —（角色白名单已接线并拦截） |
| P-2 | **细粒度（实体级）授权未实现**：谁能看哪些账套/哪些记录，未做任何透传或校验 | 无 acting-principal 透传；执行层调用只带 operation+args | 归执行层研判；真实 17dz 是否有"按主体授权"概念未验。仍挂债，等真实层冒烟与业务确认后再做 |
| P-3 | ~~写面是**全局开关**（`runtime.allowWriteOperations`），非按人~~ **已解决（2026-11-19 RBAC 切片）** | 全局开关降级为**部署总闸**：角色含 `write` 且总闸打开才并入写集合（`scripts/ask-runtime.ts:533` 收口；`apps/server/server.ts:1133-1134` 按主体角色取权限）；viewer 即使总闸打开也写不了；总闸关闭时 operator 也写不了（`scripts/rbac-roles.test.ts` ⑥） | —（按人部分由角色白名单承接，总闸语义保留） |

## 八、长任务异步协议（L-1 已落地 2026-11-19；L-2～L-4 仍挂债）

**背景**：执行层可能出现 30 分钟级的长任务（浏览器自动化）。固定总时长上限会把正常业务按卡死处理；挂长 RPC 又会长期占用后台槽。

**结论**：owner 2026-11-18 先定「设计保留、暂不实施」，当日深夜改判「契约扩展还是要做，实现上只用考虑命令行」→ L-1 已按 CLI/适配层抽象落地。**真实 17dz 未验**（只跑通 dummy CLI）。

| 编号 | 事项 | 设计要点 | 状态 / 为什么现在不做 |
|---|---|---|---|
| L-1 | 契约第六态 `accepted(operationId, pollAfterMs)` + `wait(operationId, timeoutMs)` + `abort(operationId)` | 只对声明 `long_running: true` 的 operation 生效，普通操作逐字节不变；Worker `accepted` 后回合结束、让出槽位；宿主用**长轮询**（出站、穿 NAT）实现"完成即唤醒"；`operationId` 落底账，重启续等；用户可停 | **已落地（契约 v4）**：runner 等待推进（瞬时故障指数退避封顶 60s）、续跑注记三态、续跑回程文件与大日志（`deliverable:false`）、`completed.items` 逐条结果；装配接线见 `scripts/ask-runtime.ts` 的 `longTaskPortOf`。只剩真实执行层验证 |
| L-2 | 续租/心跳替代总时长上限 | `workerTurnMs` 从"总时长"降级为"静默阈值"（无任何事件 N 秒才判卡死） | 未做：长任务已让出槽位，但**执行中**回合的静默阈值仍缺证据 |
| L-3 | 实体级并发写（长写期间的第二个写请求） | 由执行层用锁/排队返回确定性 `locked/busy`；宿主只转述并给用户"等/停"选择；宿主不排队等实体锁、不盲杀中间态 | 属执行层能力，未验；宿主侧无对应实体知识 |
| L-4 | `dispatchKey` 双边职责 | 宿主负责"不重复发起"（已实现），执行层负责"不重复执行"（未实现）；配套 per-operation `idempotent` 声明（缺省 false）与一致性探针（同 key 连发两次记录数不变） | 执行层未实现；dummy 里零引用 |

## 九、交互状态反馈（2026-11-19，owner 记为债）

**背景**：owner 希望给用户消息一个「已接收」的**轻反馈**（类似贴个表情 / reaction），让用户知道 Agent 收到了、正在办。

**事实**：企业微信 AI 机器人 SDK **没有 reaction / emoji 接口**——可用的只有 `replyStream` / `replyTemplateCard` / `updateTemplateCard` 等；因此**无法对用户消息「贴表情」**表示已接收。

| 编号 | 事项 | 设计要点 | 状态 / 为什么现在不做 |
|---|---|---|---|
| X-1 | 「已接收」轻反馈（贴表情 / reaction） | SDK 无 reaction 接口；可选替代 = **模板卡片原地更新**（⏳ → ✅，同一条卡片从「办理中」更新为「完成」），但需 live 验证该卡片类型对我们的机器人是否开放 | **当前不做**：短活缺省 **8 秒**就出结果，「收到」与「结果」几乎同时到；长活有 **10 分钟兜底**（超时如实告知）+ **运维告警**，已覆盖「接收感」。真实诉求未验证前不新增机制（新增机制准入：给不出「更省心/更省时间」的证据就不做） |

## 十、独立复核登记（2026-11-20，明确不修）

> 来自 9 点攻击独立复核：三处模型可见残留（agent.md / renderWorkerSystemPrompt 工作目录块 / 空汇报 reason）已由源头改写 + 守卫扩面修复；下列两项按复核建议**只登记、不修**，等真模型测量或专门切片再定。

| 编号 | 事项 | 现行证据 | 为什么现在不做 |
|---|---|---|---|
| R-1 | `wakeCancelled` 不在会话链上的 run/wake 竞态：任务取消时若该会话此刻没有在跑的回合（`turnActive=false`），`wakeCancelled` 直接起一次唤醒；若紧接着用户回合/另一状态变化又起 wake，两个 wake 可能并发。复核实测 **1 次可复现** driver 报错、用户回合空 | `apps/server/notification-chat-sink.ts:216-235`（`wakeCancelled` 出口）；`apps/server/server.ts:1303`（`wakeAndDeliverStateChange` 本体，出口逐步接它）；`turnActive` 判据见 `server.ts:1075` | 属竞态收口，不是本次去内部词切片；复现率与用户级影响待专门测。修法要给唤醒加会话级串行/去重（新机制，需过准入），本轮不引入 |
| R-2 | `WAKE_TURN_MS = 60s` 与 Main `mainThinkingLevel=high` 的张力：high 档长思考的唤醒回合可能 60s 内出不来 → 超时 abort → 模型那句丢失、走兜底渲染文案（用户看到的是模板话而非模型话） | `packages/agent/src/execution-runtime.ts:1071`（`WAKE_TURN_MS = 60_000`）、`:3324-3358`（wake/coldWake 截止）；`packages/contracts/src/config.ts:121`、`packages/core/src/config.ts:96`（`mainThinkingLevel` 配置）；兜底见 `notification-chat-sink.ts:216-235` | 是否真发生取决于真模型在 high 档的唤醒耗时，**当前无真模型测量**。不擅自放宽截止或降档——等 `eval:user` 真模型读数再定，避免为假设问题改超时语义 |

## 十一、S1 收尾复核登记（2026-11-23，明确不修）

> 来自「删 status 概念」收尾复核。以下条目都已在现行代码核对（M2/M3/m1/m2 来自独立复核；M4/M5/m3 来自 2026-11-23 grok 复审——与迁移事务 blocking 同轮，该 blocking 已修）；只登记、不修——修法要么是新增机制（需过新增机制准入），要么是用户可见词面变更（需 owner 裁定），要么会把确定性判据换成语义判断（违反判据红线）。

| 编号 | 是什么 | 后果 | 为何暂不修 | 现行证据 |
|---|---|---|---|---|
| M2 | （2026-11-24 已解决）有机械失败事实的回合即使带 worker 汇报，`settle` 也不 `archiveReply`，只写结束事实 | 结论机已删：汇报**原样存档**（宿主不判它是不是「对失败的说明」）。用户可见面由两条守着——① 模型醒着：Main 读账本执行事实自己判；② 模型沉默：兜底按末次失败事实不说「办好了」。若以后要区分「汇报=结果」与「汇报=失败说明」，需要独立的语义/列，属新增机制 | — | `packages/agent/src/task-runner.ts`（settle 原样存档）；`packages/agent/src/execution-runtime.ts`（`lastFailureFactOf` 三条机械规则） |
| M7 | （2026-11-24 新登记，owner 裁「登记不修」）执行行 status 是 `failed`/`refused` 但 `error.code` 与 `error.message` 皆空时，`lastFailureFactOf` 剥成 `{}`，回合终局不带 `errorCode`/`failureReason`；宿主兜底三者皆无 + 汇报非空 → 走 completion 话术 | 契约层**已堵住**：`ExecutionFailure { code: string; message: string }` 双双必填，`failed`/`refused` 必须带 `error`（`packages/contracts/src/execution-contract.ts:184-189,225-226`）——类型正确的执行层产不出空码。只剩「适配器返回类型合法但值为空串」一种运行期可能；仓内 dummy 防御性补 `EXECUTION_UNKNOWN_ERROR`，17dz 真层返回真码（CW000043/GATE_REFUSE 类）。**今天无可复现路径**，按「给不出最小复现失败就不新增/不改」登记 | 修法一行（判据从「code/message 非空」换成「status 属于 failed/refused 就算有失败事实」），但 necessity 无法证明；触发条件 = 17dz 实测吐出空码，那天再修 | `packages/agent/src/execution-runtime.ts`（`lastFailureFactOf` 三条机械规则）；`packages/agent/src/dummy-cli-client.ts:396-399`（防御性补值） |
| M6 | （2026-11-24 新登记）宿主「回合成败结论机」已整台删除，连带两处用户可见退化：① 同对象/异对象/无标签的成败配对判定没了；② 兜底失去「已完成 X，未成功 Y」那句 | 一成一败 + 模型沉默时，用户听到的是通用一句「没办成。要重发，还是先核对？」（不再逐项听「哪件成哪件没成」；句子刻意不给「再试一次」——结论机删了，宿主不知道那笔是不是写、落没落，诱导重试可能双写）；同对象先失败后成功同样走这句（owner 2026-11-24 明确接受：宁可啰嗦不可骗人，也不可为洗绿留身份判定） | 恢复逐项话术需要**执行层**声明 partial/items（契约 `ExecutionItemResult` 已有形状），宿主不重建对象账本；对象身份同理应由执行层声明（2026-11-24 O-9 已删 `OBJECT_ARG_KEYS` 字段名刮擦，锁键改为 (operation, 参数稳定摘要 `argsDigestOf`)——宿主不再懂业务对象名） | `packages/agent/adversarial-worker.test.ts` ⑯–㉓（新口径：末条失败业务写的原始码，无 partial 字段） |
| M3 | E11 的 `noWriteExecuted` 锚点只要求「写面执行行没有一条 completed」；有任务时零写命中，无任务时零执行 + 非空回复也命中 | 锚点接近恒过：不区分「零执行是权限拒绝/执行失败」还是「模型随便回了一句没办事」，E11 通过不能证明用户被告知了办不了 | 要区分拒绝/失败必须判断回复语义，而 AGENTS 判据红线禁止用关键词/正则表达语义判断；确定性事实层没有「模型是否说清办不了」的信号，只能交给用户级黑盒 eval。不为凑绿补词表/改判据 | `scripts/eval/convergence-r1/judge.ts:792-827`；已登记口径 `../ops/handover.md:31`、`scripts/eval/convergence-r1/cases/E11.ts:15-41` |
| m1 | （2026-11-23 已解决）`noteRoundFailed` 无条件 emit；`result_unknown` 先 `markDied` 再 `noteRoundFailed` 双发 | 零状态：同任务至多一条结束事实（`task_ends`，只有 `task_id + at`，无 kind）；`died`/`round_failed` 这两个结束种类已随「删光状态机」轮删除，双发问题不存在 | — | `packages/core/src/task-store.ts`（`task_ends` 一次性）/ `packages/agent/src/task-runner.ts`（result_unknown 收尾只写一条结束事实） |
| m2 | （2026-11-23 已解决）CLI 的 `taskFactLabelsOf` 不读 `roundFailedAt`；已停但无汇报的任务落到兜底标签「无汇报」 | CLI 标签读原始事实（`endedAt` + 汇报 + 提问 + 租约）：已停无汇报显示「无汇报收尾」，未启动显示「排队中」，无结束事实且不再可能活着显示「结果未知」 | — | `scripts/tasks.ts`（`taskFactLabelsOf` 读 `endedAt`/汇报/提问原始事实） |
| M4 | （2026-11-23 已解决）`statusView` 透出四个终态时刻但不带 `roundFailedAt` | `statusView` 只透出原始事实（`started` / `reported` / `waiting` / `liveWorker` / `endedAt`，无种类）；`termination` 与结束种类已删除 | — | `packages/agent/src/execution-runtime.ts`（`statusView`） |
| M5 | （2026-11-23 部分解决）`docs/architecture/tasks.md` 行号与已删符号对不上代码 | §1/§4/§5/§7 已按零状态重写（终态列 / `cancel_requested_at` / `round_failed_at` 口径替换为原始事实：结束事实只留时刻）；其余行号仍可能随代码漂移 | 文档全面逐行核对属独立文档任务；本轮只改零状态相关段 | `docs/architecture/tasks.md` §1/§4/§5/§7 |
| m3 | （2026-11-23 已解决）`statusView` 的 `claimed` 注释写「已认领未落定」，实际是 `executions.length`（含已落定） | 注释按实际口径改写：`claimed` = 执行行总数（含已落定）、`resulted` = 已落定（status≠accepted）、`claimed-resulted` = 在途 accepted 数 | — | `packages/agent/src/execution-runtime.ts`（`statusView`） |

## 十二、长连接可靠性：离线/断连窗口的用户消息不可恢复（owner 2026-11-20 要求登记）

**事项**：企微 AI 机器人长连接（WebSocket）模式下，服务停服或断连期间用户发出的消息**平台不补投、产品无补拉**，窗口内消息永久丢失。

**实测读数（逐字）**：

- 停服 `12:02:15Z` → 重连 `12:03:43Z`（Authenticated），期间用户发 **2 条**；
- 重连后 `inbound_messages` 仍 **31 条（零新增）**、日志 `aibot_msg_callback` 帧 **0**、会话文件**零写入**；
- 结论：平台不补投、产品无补拉——断连窗口的消息没有任何恢复路径。
- 原始日志（机器本地 scratch，非仓内）：停服前 `~/.tmp/fshine-live.log`、重连后 `~/.tmp/fshine-live-2.log`（含 `WebSocket connection manually closed` → `Authenticated` → `server_started` 时间线）。

**官方口径**：`developer.work.weixin.qq.com/document/60904` 把「可靠性高（无状态）」判给 **Webhook**；长连接标注「需要心跳保活、断线重连」。官方社区另有「连接正常时也偶发丢」案例。

**缓解（已落地 2026-11-21）**：`systemd Restart=always`（停机窗口压到秒级）、WS 心跳 15s、`message_still_processing` 接进程内告警（规则 `message_stuck`）。窗口内消息仍会丢——这是长连接模式的固有代价。

**销账条件**：切 **Webhook**（平台最多 3 次重试）+ 既有 `messageId` 幂等底账接重投。两项都落地并实测窗口内零丢失后才可关账。

**状态**：未清（本次只登记，不修）。
