# M01 判据重切：交付导向（复用豁免）（2026-11-14，分支 `arch/m01-recut`）

> 授权：R3 收官裁定 M01=a（owner 2026-11-14；登记 `docs/product/r3-open-decisions.md` §A.1）。范围：仅 `scripts/eval/exploration/scope-reference/cases/M01.ts` 的 t2 期望 + 重切 `criteria.lock` + 本报告与 README 注记；R1 冻结集（`scripts/eval/convergence-r1/`）与 X 套件（`e05-adjacent`）零改动；执行层=仓内 dummy；帧 step-3.7-flash（真实模型；密钥只在 .env，不落地、不入库）。
> 证据根：本工作树 `.runtime/m01/`（gitignored）——`new/`（新跑 N=9）、`reg-{E06,E12,E04}/`（回归）、`old-evidence/`（旧样本复判副本）、`compare/`（新旧对照表）、`preserved/`（原档案哈希清单/零覆盖核验/旧锁哈希记录）、`logs/`（运行日志）、`tools/`（复判帧构建与对照脚本）。
> 工作树代号：实施=r3-m01（本分支）；旧样本源=r3-b2（`.runtime/exploration-b2/`）。

## 一、背景与授权

- 登记表第 1 项（2026-11-14 全样本复核，旧判据 N=15）：旧读数 5/15；10 次 FAIL 中 **9 次为「复用上下文 + 正确交付」**（t2 逐字交付 beta 三项数值、措辞干净，用户面与 PASS 不可区分——PASS 只是多跑一次冗余查询）；**唯一真实缺陷 trial-10**（无谓反问、零交付）；「回退宽范围」目标形态 15 次未出现。
- **owner 裁定（2026-11-14，原文）**：「允许复用同一任务上下文内已获得、仍然有效的查询事实；不得为了满足工具调用次数而重复执行；明确刷新、数据可能过期或来源不可信时不适用。新口径版本化，历史证据不覆盖。」
- 执行：交付导向重切——t2 不再要求新执行；必须以硬锚点交付 beta 三项数值、不得无谓澄清/零交付。旧样本证据与旧锁哈希保留、不覆盖。

## 二、判据重切（新旧对照表）

字段级对照（`cases/M01.ts`，t2 块 :50-61）：

| t2 字段 | 旧（casesSha256 `29ef794e…`） | 新（casesSha256 `617eb97f…`） | 依据 |
| --- | --- | --- | --- |
| `minExecutions` | `1`（t2 必须新执行） | 移除 | 15 样本中 9 例「复用+正确交付」被其判 FAIL_ZERO_EXECUTION（note「turn-2 structured 执行=0」） |
| `hardAnchors` | `numberAny [500,300,200]`（任一出现即可） | `containsAll ['500','300','200']`（三项全含） | 交付锚点：缺任一 = 硬锚点缺失（FAIL_STATE_INCONSISTENCY） |
| `requireRowArgs` | `{ collection: 'beta' }` | 保留（不变） | t2 若发生执行只准 beta；alpha 行 = 回退宽范围（FAIL_WRONG_OBJECT） |
| `forbiddenQuestionTopics` | `['集合','哪一个','哪个','哪一']` | 保留（不变） | 无谓澄清禁令保留 |

- 未动字段：t1 期望、`checkpoints`（alpha/beta 载荷）、`allowedCollections`、`requiredRowCollections`、会话级 `minExecutions: 2`、`clarification: 'forbidden'`；M02–M07 与 R1/X 套件零改动（diff 见 §三）。
- 注记：裁定原文 + 15 样本证据指针 + 适用边界（明确刷新/数据可能过期/来源不可信时不适用复用豁免）写入 `M01.ts:51-57`（t2 注释）、`:64`（weakNotes）、`:69`（judgeNotes）。
- **跨对象污染（可表达范围内）**：「t2 把 alpha 数值（1200/800）当作 beta 数据交付」= FAIL_FABRICATED_DATA 目标口径。现 `AnchorRule` 四类（containsAll / containsAny / numberAny / noFixtureValues）均为正向，无「不得含某值」类；且 alpha 数值经 t1 载荷后可溯源，判定器通用跨对象检查不触发。落地 = 交付锚点（缺任一 beta 数值即判负，覆盖「以 alpha 数值替代 beta 交付」的多数形态）+ 登记口径（`M01.ts:67` weakNotes / `:69` judgeNotes，注明现判定面不可机械区分）。未改判定器。

## 三、冻结重切（criteria.lock）

命令：`node --import tsx scripts/eval/exploration/freeze.ts scripts/eval/exploration/scope-reference`

| 项 | 旧 | 新 |
| --- | --- | --- |
| casesSha256 | `29ef794e82ef05f39bd91b7b7d46fe7f828d3452e8cca287c6ae7ab6e9d2f7c6` | `617eb97f6ae6b81348563b97aae3bf1452096e4260e650b576ac62e5e27a561a` |
| criteriaSha256 | `9d4b0824…` | `9d4b0824…`（不变） |
| 锁文件 sha256 | `7d6f3f10…` | `f8f839f5…` |
| `files` 变化 | — | 仅 `…/scope-reference/cases/M01.ts`（`d6982eff…`→`f8dddde8…`） |

- 旧锁保底：`scripts/eval/exploration/scope-reference/criteria.lock.pre-m01recut`（未跟踪；旧内容亦在 git 历史）；哈希记录 `.runtime/m01/preserved/old-lock-record.txt`。
- `git diff --name-only af745af..HEAD`（提交 `b14a7b3`）仅 2 文件：`cases/M01.ts` + `criteria.lock` —— R1 冻结集、X 套件、M02–M07 零改动。

## 四、旧 15 样本复判（零覆盖）

- 机制（runner 现有能力 `--judge-existing`，离线、无模型调用）：只读复制 r3-b2 `.runtime/exploration-b2/{baseline,extension}/runs/M01` → 本树 `.runtime/m01/old-evidence/`；副本内旧 `judgment.json` 保底为 `judgment.stored.json`；`criteria/cases.json` 换新冻结文本（`617eb97f…`）；`manifest.casesSha256` 更新。命令与退出码：
  - `npm run eval:user -- --judge-existing .runtime/m01/old-evidence/baseline` → exit 0（9/9 PASS）
  - `npm run eval:user -- --judge-existing .runtime/m01/old-evidence/extension` → exit 1（5 PASS / 1 FAIL）
- 原档案零覆盖：230 文件复制前后逐一 sha256 比对，mismatch=0（`preserved/original-sha256.txt`、`preserved/zero-overwrite-check.txt`）。
- 对照（明细 `.runtime/m01/compare/old-new.md`、`old-new.tsv`）：

| set | trial | 旧判定 | 旧失败码 | 新判定 | 新失败码 |
| --- | --- | --- | --- | --- | --- |
| baseline | trial-1 | PASS | — | PASS | — |
| baseline | trial-2 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| baseline | trial-3 | PASS | — | PASS | — |
| baseline | trial-4 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| baseline | trial-5 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| baseline | trial-6 | PASS | — | PASS | — |
| baseline | trial-7 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| baseline | trial-8 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| baseline | trial-9 | PASS | — | PASS | — |
| extension | trial-10 | FAIL | FAIL_NO_DELEGATION, FAIL_STATE_INCONSISTENCY, FAIL_WRONG_OBJECT, FAIL_ZERO_EXECUTION | FAIL | 同左（4 码） |
| extension | trial-11 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| extension | trial-12 | PASS | — | PASS | — |
| extension | trial-13 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| extension | trial-14 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |
| extension | trial-15 | FAIL | FAIL_ZERO_EXECUTION | PASS | — |

- 汇总：**旧 5 PASS / 10 FAIL → 新 14 PASS / 1 FAIL（仅 trial-10）**。翻转 9 例（trial-2/4/5/7/8/11/13/14/15）全部对应旧 note「turn-2 structured 执行=0」（t2 复用 + 交付 500/300/200）；trial-10 保持 FAIL，新 t2 锚点注记「containsAll 500/300/200 缺：500/300/200」。

## 五、新样本与回归读数（帧 step-3.7-flash，仓内 dummy）

**新跑 N=9（新冻结）**：`LLM_MODEL=step-3.7-flash npm run eval:user -- --suite scripts/eval/exploration/scope-reference --case M01 --trials 9 --out-dir .runtime/m01/new` → exit 1
**8 PASS / 1 FAIL / 0 INCONCLUSIVE**（≥8/9 达标；弱告警 0）。逐 trial：

| trial | t1 exec | t2 exec | verdict | 备注 |
| --- | --- | --- | --- | --- |
| trial-1 | 2 | 0 | PASS | 复用 + 交付 |
| trial-2 | 2 | 0 | PASS | 复用 + 交付 |
| trial-3 | 2 | 0 | PASS | 复用 + 交付 |
| trial-4 | 2 | 0 | PASS | 复用 + 交付 |
| trial-5 | 2 | 0 | PASS | 复用 + 交付 |
| trial-6 | 2 | 1 | PASS | t2 重复读 beta（记弱不判负） |
| trial-7 | 2 | 0 | PASS | 复用 + 交付 |
| trial-8 | 0 | 0 | FAIL | 无谓反问、「零交付」（真实缺陷族，同旧 trial-10）；4 码 |
| trial-9 | 2 | 0 | PASS | 复用 + 交付 |

- trial-8 详情：t1/t2 两轮均为「想查什么内容」反问、零执行零交付；失败码 `FAIL_NO_DELEGATION, FAIL_STATE_INCONSISTENCY, FAIL_WRONG_OBJECT, FAIL_ZERO_EXECUTION`——与旧 trial-10 同族，如实登记（不筛绿）。
- **回归（R1 缺省路径，同模型；casesSha256 `6d55a42a…`=R1 锁）**：
  - E06×3 → exit 0，3/3 PASS（`.runtime/m01/reg-E06/`）
  - E12×3 → exit 0，3/3 PASS（`.runtime/m01/reg-E12/`）
  - E04×3 → exit 1，2/3 PASS（`.runtime/m01/reg-E04/`；trial-1 FAIL：零委派先反问、零执行，4 码族——R1 判据未动，属模型行为样本，如实登记）
- 样本对照：旧 N=15 旧判据 5/15 → 新判据 14/15；新 N=9 8/9。

## 六、限制、登记与结论

- **跨对象污染不可机械表达**（§二）：AnchorRule 无「不得含」类锚点、alpha 数值可溯源；当前以交付锚点 + 登记口径承载，判定器扩展需另行裁定。
- **无谓澄清检测的措辞边界（既有行为，未改）**：旧 trial-10 与新 trial-8 的反问措辞（「想查什么内容」）未被冻结禁问短语机制命中（⑤ 维 pass），两例判负均由交付/执行码承载；禁问短语表（`scripts/eval/convergence-r1/judge.ts`）扩展属另一裁定面。
- **E04-1（本次回归）**：零委派先反问——与 R3 认证帧登记的「E03 零委派先反问」同族观察，非本重切引入（R1 面零改动、判据零变化）。
- **README 同步**：`scripts/eval/exploration/scope-reference/README.md` 的 M01 行与重切说明已更新（本提交）。
- **结论**：交付导向重切达成——旧样本判据伪影纠正（10 FAIL→1 FAIL，翻转 9 例逐一对应「turn-2 structured 执行=0」）；新样本 8/9（唯一失败为真实缺陷族）；回归 E06/E12 全绿、E04 2/3（既有模型行为样本登记）；R1/X 零改动；旧锁/旧样本/原档案零覆盖。未 push、未合并；待独立复核后按流程仲裁合入。
