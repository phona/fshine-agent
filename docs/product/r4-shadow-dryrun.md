# R4 Shadow 演练报告（Dummy 路线 · 双源对照 dry-run）

> 授权：owner 2026-11-14「通过 Dummy 完成第 4 点」——**只做 Dummy 路线的 shadow 演练与就绪材料**。
> **本 Run 不连接真实企微/真实执行层、不读凭据、不触真实数据**；真实连接需 owner 另行授权（Runbook §1 授权门）。
> 基线：`arch/integration @ 885ac638f2353be41e651f1ea3eb9199d905017b`；分支 `arch/r4-shadow`；worktree `fshine-agent-r4-shadow`。
> 提交链：`845cba3`（双源测试先行·先在红）→ `35ea254`（harness 实现转绿）→ 本 docs 提交。
> 证据根 `.runtime/shadow/`（gitignored）。依据：`docs/product/real-read-readiness.md`；runbook：`docs/product/real-shadow-runbook.md`。

## 1. 演练范围

- **做**：Dummy 路线双源对照 harness（测试层）+ 接真 Runbook + 本报告；四态（completed / needs_input / failed / refused）
  的宿主链路语义等价、只读哈希、fail-closed、回退开关、证据复跑与反向绊线。
- **不做**：真实适配器/真实连接/真实渠道；不改产品语义、冻结判据与历史证据；不新增依赖。
- **双源定义**：源 A = 仓内 dummy fixture + 生产适配器（真实 spawn / `--state-dir` / `audit.jsonl`）；
  源 B = 测试用进程内 `fake-real ExecutionClient`（可配四态/错误信封/能力快照形状）。
  **double 仅测试夹具层级**（`scripts/shadow/fixtures/execution-sources.ts`，只被 harness/测试消费）——不是平台模拟框架。

## 2. 门禁读数（本 Run 实跑；确定性，非采样）

| 门 | 命令 | 读数 | 证据 |
|---|---|---|---|
| typecheck | `TMPDIR=/home/tao/.tmp npx tsc --noEmit` | exit 0 | `gates-tsc.txt` |
| 全量 unit（只增不减） | `TMPDIR=/home/tao/.tmp npx vitest run` | **56 files / 606 tests passed**，exit 0 | `gates-full.txt` |
| 双源目标套件 | `TMPDIR=/home/tao/.tmp npx vitest run scripts/shadow/double-source.test.ts` | **12/12 passed**，exit 0 | `gates-target.txt` |

基线对照：先红期全量为 `1 failed（仅新文件）| 55 passed；594 tests passed`（`red-full.txt`）；本次 `+1 文件 / +12 例`，
零删除（`git diff 885ac63..HEAD --stat -- '*.test.ts'` 仅新增 365 行）。
先红证据：目标套件 `Cannot find module './double-source-harness'`（`red-target.txt`）；tsc `TS2307` + 级联 `TS7006`（`red-tsc.txt`）。

## 3. 双源对照复跑读数（四态，证据持久化）

命令（一次性 scratch，gitignored）：`TMPDIR=/home/tao/.tmp node --import tsx .runtime/shadow/rerun-four-states.ts`
→ 逐场景写 `.runtime/shadow/evidence/<label>/{summary,dummy,fake-real}.json`；输出 `rerun-four-states.txt`，exit 0。

| 场景 | digest(sha256 前 16) | 语义等价 | 只读稳定(A/B) | 终态（两源同形） | 通知意图 | 机械事实 |
|---|---|---|---|---|---|---|
| success | `07236fc9354b1aee` | true（diffs=[]） | true / true | completed；存档 `已完成：dummy.query。` | accepted→started→completed 全 delivered | A: executions=1/audit=1/calls=0/spawn=true；B: executions=1/audit=0/calls=1/spawn=false |
| needs_input | `dd424a11aefb6040` | true（diffs=[]） | true / true | waiting_user；pendingMissing=`More than one collection matches "contoso"` | accepted→started→waiting_user 全 delivered | 同上 |
| failed | `d83caa49dc90b9d0` | true（diffs=[]） | true / true | failed；failureReason=`执行层未成功：dummy.query 返回 failed：Collection faulty-one cannot be read in its current state` | accepted→started→failed 全 delivered | 同上 |
| refused | `a1eefdaa69977c15` | true（diffs=[]） | true / true | failed；failureReason=`执行层未成功：dummy.query 返回 refused：GATE_REFUSE collection denied-one is restricted for the current caller` | accepted→started→failed 全 delivered | 同上 |

- **只读面派生**：两源允许集合一致 = `['ballot.query','dummy.query']`（`readOnlyOperationNames` 单一规则；写操作被排除）。
- **证据复跑**：目标套件两次 `runShadowComparison` digest 相同（测试 ⑤ 断言）；`summary.realConnection=false`。
- 判读纪律：以上为**确定性读数**，不构成稳定性/概率结论，不推广到真实平台。

## 4. 反向绊线读数（破坏不提交、逐字节恢复）

轮一（前次 ask）：单源冒充（跳过 provenance）→ 2 failed；只读漂移屏蔽 → 1 failed；failed→completed → 3 failed
（`tripwire-1-forged-source.txt` / `tripwire-2-readonly-drift.txt` / `tripwire-3-failopen.txt`）。

轮二（本 ask，按指定形态复跑）：

| # | 破坏 | 红跑读数 | 证据 |
|---|---|---|---|
| ① | 删源 B 断言（`compareChains` 源 B provenance 四项） | 1 failed / 11 passed：绊线①单源冒充 | `tripwire-a-forged-b.txt` |
| ② | 只读哈希漂移断言失效（`verifyReadOnlyStable` 去 before!==after 判违例） | 1 failed / 11 passed：绊线② | `tripwire-b-readonly-drift.txt` |
| ③ | 错误信封当成功（`materializeOutcome` failed/refused→completed） | 4 failed / 8 passed：②failed、②refused、④错误信封透传、绊线③ | `tripwire-c-error-as-success.txt` |

恢复核验：两实现文件 `cp` 备份回写 + `diff -q` 逐字节一致（BYTE-IDENTICAL）；`grep -rn TRIPWIRE scripts/shadow/` = 0；
`git status`/`git diff` 空；恢复后三绿（12/12、tsc 0、56/606，`tripwire-restore-{target,tsc,full}.txt`）。
汇总：`tripwire-summary-r2.md`。

## 5. 未能验证项（需真实连接或脱敏样本；本 Run 不验证）

| 项 | 为什么未验证 | 解除条件 |
|---|---|---|
| 真实能力快照形状（access/effects 等价物、只读性声明形态） | 平台未定；当前只验证夹具自述面与契约投影同形 | owner 指定平台 + 平台自述或 operator 声明映射评审（readiness §6） |
| 真实传输错误 → 四态机械映射表（退出码/信封/超时/限流） | 需真实适配器与真实传输；double 只证明契约处理面 | 真实适配器切片（readiness §5 步骤 1 的真实面）+ 失败注入 |
| 真实错误码/信封字段语义（code 取值、correctForm/details、retryable 口径） | 无真实脱敏样本；不得虚构 | 脱敏样本归档后逐字段核对 |
| 权限与越权真实行为（平台侧拒绝路径、只读凭据实际范围） | 需真实连接；不得触碰真实权限面 | 受限真实只读（readiness §5 步骤 3，owner 逐项授权） |
| 延迟/超时/限流/预算真实读数 | 同上；本地双源无网络与平台限流 | shadow 只读（步骤 2）采集 + 平台要求补齐 |
| 凭据托管/轮换/吊销实操 | 托管方未指定；decision-log §七文件层缺口前置未闭环 | owner 指定托管方 + 缺口闭环（readiness §2） |
| 真实审计渠道/留存/复核入口 | 平台要求待补 | 平台审计要求确认（readiness §6） |
| 真实渠道投递（WeCom sink 送达/语言） | 适配器不实现、不连接 | 渠道适配器切片（新授权） |
| 写入面「真关闭」核验 | 当前按执行层声明只读；声明本身未对真实平台核验 | 真实平台写面声明核验 + 越权拒绝路径实测 |
| 真实数据形状/脱敏样本 | 不触真实数据 | owner 指定样本与脱敏口径 |

## 6. blocked 审计（不计入 passed）

| blocked 项 | 事实 | 解除条件 |
|---|---|---|
| 真实连接（本 Run） | 明确不连接（授权边界）；runbook §1 仅评审材料 | owner 逐项授权（readiness §5 步骤 3 门） |
| 真实错误码/延迟/权限不可验证 | 无真实连接、无脱敏样本（§5 表） | 真实适配器 + 样本 + 授权 |
| 双源等价的适用边界 | 只证明「宿主链路对契约四态的处理语义」；**不能**证明真实执行层会产生这些四态（fake-real 是 double，非平台） | 真实执行层接入后按 runbook §3 同断言复验 |
| inline 路径等价未在本 harness 断言 | harness 断言面 = background 派发链路；inline 由既有金样覆盖 | 如需 inline 对照，另行登记切片（不在本轮） |
| P7b/集成报告既有 blocked 项 | 真实 WeCom sink、`taskBudget` consume、`queueCapacity>0` 上界、messageId 幂等窗口、多进程/多实例——本次 shadow 未新增解除 | 各归属切片（见 `docs/product/r4-integration.md` §四、`r4-p7b-acceptance.md` §五） |

## 7. 限制

- 确定性测试（无模型、无采样）：不得读作完成率/概率结论；四场景为构造场景，不推广到其他语料/平台。
- 源 B 行为按契约合规配置；真实执行层不一定合规——这正是 §5/§6 的分界。
- 证据为 gitignored 本地读数：删除/重跑即新读数，须重新标注口径（不得冒充本次）。

## 8. 回退

- 源开关：`parseShadowSourceName` 缺省 `dummy`；未知源（含 `real`）fail-closed。
- 配置级：`runtime.dispatchMode: inline` 回现行同步路径（runner/outbox 不创建）。
- 提交级：`git revert 35ea254`（实现）与 `git revert 845cba3`（测试）互不依赖；本 docs 提交可单独 revert。
- 证据级：`.runtime/shadow/` 整体 gitignored，可删除/重跑。

## 9. 证据索引（`.runtime/shadow/`，gitignored）

- 先红：`red-target.txt`、`red-tsc.txt`、`red-full.txt`、`red-commit.txt`。
- 绿色门禁：`gates-tsc.txt`、`gates-full.txt`、`gates-target.txt`、`green-summary.md`、`green-commit.txt`。
- 双源复跑：`rerun-four-states.ts`（scratch）、`rerun-four-states.txt`、`evidence/<label>/{summary,dummy,fake-real}.json`（success/needs_input/failed/refused）。
- 绊线：轮一 `tripwire-1..3-*.txt`；轮二 `tripwire-{a,b,c}-*.txt`、`tripwire-restore-{target,tsc,full}.txt`、`tripwire-summary-r2.md`。
- 设计与基线：`design.md`、`baseline.txt`。
