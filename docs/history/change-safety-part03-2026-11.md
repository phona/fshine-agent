> 历史归档：内部链接不保证可用；如需追改，以 git 历史为准。

# docs/change-safety.md · 第 3 块

## 26. 公开迁移 · 历史重写波（2026-11-05，wave2-history-prep：HG1 先进场 + 带外重写落地 + 修复轮收口）

**范围**：起点 `3886993`（`migration/public-release` 合后 = 波次 1 合入点）。**下表只列产生工件的提交**；纯订正本节自己的 commit 不逐列（否则表格永远差一行，这类追尾没有信息量）。本棒完整动线：C1 落守卫（红着交回，F1）→ **带外重写**（mirror filter-repo + mailmap + 采用回本地 + force-push gitee）→ 守卫转绿（四类零命中 + 锚点命中）→ D-158 残留登记 → 修复轮（独立验收 13 项发现全部成立：4 高危逐项修、2 中危修、7 低危带逐条评估登记 D-159）→ 收口（ODB 卫生 + force-push 本分支 + 第二轮验收残留登记）。

**提交数分解（切割时点实测，补计划验收 [8] 的缺口）**：commit-map 旧侧 **380** 条（切割时点全 ref 提交数）→ `--prune-empty=auto` 剪掉 1 条只碰 `config/agent.yaml` 的 `a093c55` → 重写后 **379**；main **352 → 351**；merge **7 → 7**（五个分支全部经 ref-map 改写，`changed-refs` 在案）。此后本程序又新增 3 个提交（清理轮 `669c876` / `b4f4668` + 集成分支合入 merge 1 笔），现行 `git rev-list --count --all` = **382**、`main` = **351**、main merge = **7**。计划书验收 [8] 原文的「358（全 ref）→ 352（删 2 个陈旧 ref 后）→ 352 − N」是重写前的估算口径，与实际事件（380 → 379）不同，**以本节实测分解为准**，原数字作废。

| # | 提交 | 主题 | 文件 / 规模 |
|---|---|---|---|
| 1 | `546fcce` | test(history)：历史敏感面守卫先进场——四类零命中断言，**此刻红着交回** | 1 文件新增（`packages/agent/history-hygiene.test.ts`）+ `.gitignore` +4 条 + rule-landing §1 HG1 行 + debt-ledger D-157 |
| 2 | `205c8c5` | chore(history)：逐串扫描脚本（G1b）——表内每条在全历史里的命中计数 | 1 文件新增（`scripts/history-sensitive-scan.sh`） |
| 3 | `de20b45` | test(history)：HG1 的 F3 五项变异留档 + 浅克隆环境门 | 1 文件（守卫头注释表 + 一条常驻用例） |
| 4 | `e80a4aa` | docs(history)：C1 关账留档（本节）+ F2 计数 | 1 文件（`docs/change-safety.md`） |
| 5 | `24f3b08` | docs(debt)：D-158 gitee pull ref 残留登记——26 个 refs/pull/* 指向重写前提交，用户决定不删 PR | 2 文件（`docs/debt-ledger.md` + 本节补登） |
| 6 | `669c876` | test(history)：HG1 锚点换实际替换值 + 口径改重写后实测——防回归职责留档 | 1 文件（`packages/agent/history-hygiene.test.ts`，47 增 31 删） |
| 7 | 本提交 | docs(history)：§26 改述实际状态（重写已落地）+ 修复轮收口 | 1 文件（本节） |

（`fb3d429`/`a829d13`/`6504916`/`349d3b9` 四笔是本节自身的计数口径订正，按上行惯例不逐列；它们的 SHA 都在分支上，`git log 3886993..wave2-history-prep` 可查。）

**重写已由本程序带外完成（不是计划、不是待办）**：mirror 仓 `fshine-agent-rewrite`（bare，独立 ODB，与各 worktree 同级；路径字面不落文档——开发者主目录形态正是本守卫的靶子），`.git/filter-repo/{already_ran,ref-map,commit-map,changed-refs,first-changed-commits,suboptimal-issues}` 时间戳 2026-11-05 20:14 在案；配方 = `--replace-text` + `--replace-message` + `--mailmap` + `--invert-paths --path config/agent.yaml --path .runtime/` + `--prune-empty auto`。ref-map 记录五分支 old→new 对照在案。采用回本地 = fetch 强移分支（mirror 的重写 ODB 与 refs 整体接管本地），force-push gitee = 对 `origin`（`git@gitee.com:phona/fshine-agent.git`，私有仓）的 `git push --force`：主分支与其余分支已同步（`origin/main` 与本地 `main` 同指 `179ffe0`，`origin/migration/public-release` 同指 `3886993`），本分支的 force-push 在本提交之后执行（C8）。恢复路径 = `~/fshine-agent-program-backup/pre-cut.bundle` 与 `snapshot-now.bundle`（切割前 / 当时快照）。

**替换表不在库里（本棒最重要的一条纪律）**：`.sensitive-strings.replace.txt` 由迁移基线 §6 映射表 v2 生成（34 条，LHS 字节长度降序——`git filter-repo` 的 `apply_replace_text` 按文件序逐条 `str.replace`，短串在前会啃掉长串，如账套族前缀），`.gitignore` 同批收录（在册三条：`.sensitive-strings.replace.txt` / `.sensitive-strings.mailmap` / `.rewrite-rehearsal/`）。**表文件本身按定义含全部敏感串原文，是新的泄密面**：进库即把刚清完的历史又带回来，因此它只住本地、随重写完成即从磁盘清除（git 侧只交付"生成口径 + 扫描脚本 + 守卫"）。同理 `.sensitive-strings.mailmap`（含真实作者邮箱，把 QQ 邮箱元数据改写为 gitee noreply）与 `.rewrite-rehearsal/`（旧 SHA 与路径快照）也只住本地。另注：**filter-repo 的 `--replace-text` 文件不支持注释行**（实测读 `get_replace_text`：只 `rstrip` 换行后切 `==>`，`#` 开头的行会被当成待替换字面、替换成 `***REMOVED***`），所以表必须是纯数据行——生成口径因此写在本节而不是写进表文件。

### 四类实测计数（重写后实跑，作防回归的当前口径）

口径：`git log --all -p`（含提交信息与 diff 的增删两行），**测量时点 = `669c876`（本提交的 parent）、全 ref（11 个：5 heads + 6 个 `origin/*`；本地无 `refs/pull/*`，26 个残留只在 gitee 侧，见 D-158）**，输出 **12,079,080 字节 / 380 commit / 363 个去重文件**；`Author:` 元数据行 **380**、`Commit:` 行 **0**（`git log -p` 默认格式不输出 `Commit:` 行）。守卫判"净命中"（扣已登记替换值），下表两列都给，右列留 C1 期（重写前）同口径实测作对照。**计数随每个新提交 +1**（每条提交带一行 `Author:`）——本提交自身即 +1，引用前按当时 HEAD 复跑，别把某个数当历史存量的精确值。

| 类 | 靶子 | 形态原始命中 | 其中已登记替换值 | **净命中（判定值）** | C1 期净命中（重写前基线） |
|---|---|---|---|---|---|
| ① | 企微 UserID 带前缀形态 | 0 行 | 0 行 | **0 行** | 4 行 |
| ② | 内部绝对路径前缀形态 | 91 行 | 91 行 | **0 行** | 129 行 |
| ③ | 数字 QQ 邮箱形态 | 0 行 | 0 行 | **0 行** | 377 行 |
| ④ | 两路径涉史 commit | — | — | **0 commit** | 12 commit |

**正向锚点**（证明重写发生过、不是扫描变空）：Y1（波次 2 替换表给企微 UserID 的占位符）**20 行**、Y2（映射表 v2 B 组给内部绝对路径的虚构主目录前缀）**91 行**。Y1 比 `669c876` 上的锚点定义值（19 行）多 1 是守卫自身：旧版源码的 X1 拆法含该连续串，其删除行随 `669c876` 的 diff 进了历史——守卫头的自匹配校验因此要求 X1 拆法让路（见该文件 ANCHORS 注释），此后不再自增。

**② 的 91 行原始命中全部是替换值自身**（它们按设计就长得像敏感形态，扣减后 0）——C1 期发现的方案缺陷的修法在起作用：扣减只认登记表、且每条替换值都必须真的命中某个形态（登记表不许变成死配置，由自校验把守）。

**fresh clone 判据（G4，本提交前实跑）**：`git clone` 本地仓到临时目录后同口径复测——380 commit、四类净命中 0/0/0/0、锚点 20/91、`Author:` 行 380，与 worktree 内实测逐项一致（fresh clone 收齐 5 个分支的 remote-tracking ref，`--all` 覆盖面等价）。

**与预期的差（不凑数）**：四类全部低于 C1 期基线且触零，② 的替换值扣减、③ 的 mailmap 改写、④ 的 `--invert-paths` 移出分别对应用路径；无"比预期少清"的项——未拍板不在表内的串按 D-157 登记留在历史里（见「未做 / 已知项」），不是漏扫。

### 本棒发现的方案缺陷（均已修，留档）

**缺陷一（C1 期发现并已修）**：方案给守卫的两条形态（`wecom:<20+>` 与 `/home/<user>/`）**在重写后永远转不了绿**：波次 1 的替换值本身命中这两条形态（路径形占位符命中 ②、UserID 占位符命中 ①，实测历史里已有 24 行 / 2 行）。不处理的话，重写落地的瞬间 ①② 反而变红且再无出路——守卫把自己的出路堵死。修法不是放宽形态，而是**扣减只认一张登记表**（`REGISTERED_REPLACEMENTS`，拆段 + sha256，与禁词表同纪律），且每条替换值都必须真的命中某个形态（登记表不许变成死配置，由自校验把守）。净命中因此才是判定值，原始命中与扣减数在失败消息里都照报。

**缺陷二（修复轮发现，与缺陷一同构）**：C1 给守卫的两条**正向锚点**用的是重写前的占位符（执行层根目录形与账套族替换值），而替换表实际采用的是另一组值——两个锚点在重写后历史 0 命中，正锚点永远转不了绿，守卫把自己"证明重真发生过"的那条路也堵死了。修法不是删锚点，而是把锚点换成**实际替换值**（Y1 = UserID 占位符、`669c876` 上史 19 行；Y2 = 虚构主目录前缀、史 91 行），sha256 按拼接值重算；X1 的拆法同步让路，避免锚点连续串留在守卫源码里被自匹配校验抓住（`669c876`）。教训：**锚点与扣减表引用的必须是替换表的真实采用值，不是草案值**——两类表引用了同一批替换值，就该在同一处校验。

**缺陷三（修复轮发现，操作面）**：mirror 重写后 fetch 强移分支，wave2 worktree 里留下 7 个未复位的 rebase 前 staged 文件（把虚构平台名改回真实平台名——方向与脱敏相反，`git reset --hard HEAD` 丢弃）。上轮门禁 exit 1 与 1743|2 的脏数字都源自它们；复位后以干净态重测为准（本轮 unit 干净态数字见 F2）。教训：**强移分支后第一件事是复位工作区，再跑任何尺**；带外步骤交接时必须把"工作区可能非干净态"写进清单。

与缺陷二同源的机械把守：两条正向锚点（重写产物在历史里各 ≥1 次）的**字面也必须拆段持有**——守卫自己的提交会进 `git log --all -p`，锚点连续串一旦写进源码，锚点计数会被守卫自己顶起来、判别力当场归零（机制已验证：`grep -cF` 本文件 describe 标题 = 3）。这条由自校验机械把守，变异 ⑤ 实测；缺陷二的修法（X1 拆法让路）正是它的第一次实战。

### 纪律留档

**F1（表征先行）**：`546fcce` 把守卫写在一切重写之前，落盘即红（四类 4 / 129 / 377 / 12，锚点 0 / 0），提交信息即声明"红着交回"；红→绿翻转只由带外重写一步造成（修复轮的 `669c876` 只换锚点与口径，不动判定值）。suite 级归因实测（C1 期）：`npm run test -- --project unit` = **107 文件 / 1739 passed | 5 failed | 1 skipped**，失败文件只有 `packages/agent/history-hygiene.test.ts` 一个，其余 106 个文件全绿——红因不掺别的。
- **与 acceptance 第 6 条的张力（如实记）**：该条要求 C1 后 C2 前"失败输出必须且只能包含四类命中的计数"。实际失败输出里还有**两条正向锚点**（Y1/Y2 = 0）——这是方案 C1 明写要加的（"实测两串当前历史 0 命中，故只有重真发生过才绿"），属设计内的预期红，不是 ENOBUFS / ENOENT / 表文件缺失那类"其它原因"（这三种本棒都实测过不会出现：ENOBUFS 见变异 ③、守卫不读表故表缺失不影响、cwd 从 `__dirname` 解析故 ENOENT 不适用）。**严格按字面读，该条未满足**；按"红因必须可归因、不得掺基础设施故障"的意图读，已满足。取舍记账在此，不自行改写该条。

**F2（unit 基线冻结）**：波前基线 105 文件 / 1725 passed | 1 skipped；波次 1 终态 106 / 1737 | 1；C1 期（守卫红着）107 / 1740 passed | 5 failed | 1 skipped；**修复轮干净态终值（本轮实跑，`npm run test -- --project unit`）= 107 文件 / 1745 passed | 1 skipped**——只增不减，5 failed 全部随重写转绿（1740 + 5 = 1745）。上轮 1743|2 是 7 个未复位 staged 文件造成的脏数字（缺陷三），复位后不复现。

**F3（变异验证）**：五项实跑于 C1 期（重写前），留档在守卫文件头表格（该表开头已注明属重写前世界口径）。① 扫描目标收窄到守卫自己一个文件 → ①② 转绿（4→0、129→0），抓住收窄的是范围自校验（`patch 字节 23366（下限 2097152）`、`diff 覆盖去重文件 1（下限 100）`）；② 第四类两个路径改成不存在的 → ④ 转绿（12→0）而范围自校验仍绿，证明两者各管一段、互不替代；③ maxBuffer 改回 1MB → 六个依赖历史的用例全部 ENOBUFS 红（fail-closed，报"这是实现缺陷，不是历史干净"）；④ 强制 `SHALLOW=true` → 六个用例 skip + 环境门红，vitest exit=1（**同一次改动在环境门加上之前实测 exit=0**——vitest 对全 skip 的文件仍报 passed，环境门这条用例就是为堵这个真空绿补的）；⑤ 锚点连续串写进守卫源码 → 自匹配断言红。每项都"临时改 → 跑 → 确认对应断言翻转 → 立即还原 → 复核 `git diff` 干净"，不留变异代码。

**F4（一 commit 一件事）**：三提交分别为"防线 + 其登记与泄密面控制"、"逐串扫描工具"、"变异留档与环境门"（`546fcce`/`205c8c5`/`de20b45`）。`.gitignore` 与防线同提交而非与工具同提交，是因为替换表在本棒工作树里已存在，忽略规则必须先于任何可能的 `git add -A`。

**F5（红先 revert 不叠补丁）**：本棒没有"中间 commit 红着、靠后续 commit 补救"的实例——`546fcce` 的红是防线先于改动的设计状态，带外重写才是转绿那一步；F3 五项全部临时改后立即还原。修复轮同理：`669c876` 不借转绿之机动任何判定值，只把锚点与口径改到与事实一致。

**F7（文档同提交同步）**：rule-landing §1 的 HG1 行、debt-ledger 的 D-157 与防线同提交（`546fcce`）；本节与守卫头注释的 F3 表同帧。`docs-reality.test.ts` 未受影响（本棒不改任何 src）。

### 未做 / 已知项（不冒充已完成）

- **修复轮收尾两步在本提交之后执行**（C7/C8）：① 本地 ODB 卫生 `git reflog expire --expire=now --all && git gc --prune=now`——清掉重写留下的 36 个 unreachable commit（含敏感旧线），gc 前已确认本节引用的 SHA 全部可达（恢复路径 = `~/fshine-agent-program-backup/pre-cut.bundle` 与 `snapshot-now.bundle`）；② `git push --force origin wave2-history-prep`——主仓 origin 即 gitee，主分支与其余分支已随带外重写同步，本分支是最后一个。
- **`out/` 未进 `.gitignore`（实测的潜在事故面，已报未改）**：迁移基线 `out/migration-baseline.md` 与 `out/parts/*.md` 含全部敏感串原文，在主仓是**未跟踪且未被忽略**状态（`?? out/`）。本波清完历史后若有人在主仓 `git add -A`，会把整份敏感串清单提交进历史、且公开后不可收回。本棒只写自己的 worktree、未改主仓忽略规则，登记待 owner 定：把 `out/` 加进 `.gitignore`，或把基线文档移出版本库工作区。
- **openDecisions 未拍板的串按决定不在替换表内，其历史行数仍在**（D-157 登记的重写前实测：守卫条目 F15 那支差额读数 6 行、D-156 两支读数 79 / 129 行、§25 点名的通用测试人名与 mock seed 自造样本名三支 617 / 261 / 161 行、真实事故附件名 66 行；执行层平台名词一项重写后实测 3190 行，D-157 重写前登记 3550 行，差额主要为 `--invert-paths` 移出的 `.runtime/` 探针产物）。重写落地即把这些缺口固化成"公开库已知残留"——正是 D-157 预警的形状。闭环判据不变（D-157）：owner 拍板 → 表按"只增不减"补收 → 重跑 filter-repo → 逐串扫描退出码 0 且守卫绿。
- **守卫不进 CI 的 exhaustive 面**：HG1 形态类只覆盖带前缀 UserID（重写前实测 4/22 行，另 18 行是裸常量；重写后均为 0），G1b 逐串扫描**刻意不接 npm test**（表是 gitignored 本地文件、且已随重写完成从磁盘清除，接进去要么泄密、要么表缺失时整条跳过 = 真空绿）。CI 因此不是 exhaustive；本地 fresh clone（G4，本提交前已实跑一次，数字见上）才是真判据。`fetch-depth: 0` 归波次 4 的 ci.yml 门面重写。
- **浅克隆下 CI 会怎么走已实测并堵住**：见 F3 变异 ④ 与环境门用例。
- **`git filter-repo` 已由带外重写实际调用**（mirror 仓 `.git/filter-repo/` 证据组在案，2026-11-05 20:14）；C1 期"版本非空已实测、未调用"的记录随之作废。
- **gitee `refs/pull/*` 残留已登记 debt-ledger D-158**（2026-11-05 收口补登）：26 个 ref（`refs/pull/{1..13}/{head,MERGE}`）全部指向重写前提交；force-push 重写 main/分支不移除 pull ref，删 ref = 删 gitee 上 13 个 PR 记录（不可逆），用户决定不删、登记残留。gitee 是私有仓（残留仅对有仓访问权者可见），公开 GitHub 库永远只收干净历史；闭环判据 = gitee 仓库删除/归档，或用户改主意删 PR。
- **两处波次内文档残留（修复轮发现，登记未改）**：debt-ledger D-158「重写未做故该门尚未跑」一句已过时（fresh clone 判据本棒已跑，数字见上）；rule-landing §1 HG1 行的「实测 4/22 行」「C1→C2 之间的红」属重写前口径。两处都不影响判定，留待随波次 4 门面重写或 owner 指示再动。

## 27. 公开迁移 · 身份参数化波（2026-11-05/06，w1-identity-params：宿主身份面 profile 声明 + 中性缺省）

**目标**：把宿主侧全部执行层实例身份（委派工具名、称谓、profileId 缺省、网关名缺省、用户可见文案与 provenance 注释）改为「profile 声明 + 中性缺省」，公开仓身份面子集（packages/*/src + apps + CI 配置）17dz 归零；部署侧经 profile 声明保持实例行为连续。方案 = /tmp/pp-waves-b.json W1；分支 w1-identity-params（自集成分支 migration/public-release = 波次 2 后 HEAD 7ba775d 起）。

**commit 表（10 项全落地）**：

| # | commit | 内容 | 验证 |
| --- | --- | --- | --- |
| C1 | `0ae2833` | 表征先行：execution-identity.test.ts golden 冻结（F1） | C1 前 7ba775d 重测 unit = 107 文件/1745+1（方案引用的 105/1725 是 44a84a6 值）；C1 后 108/1762+1 |
| C2 | `f980e14` | 称谓参数化：DEFAULT_EXECUTOR_LABEL '执行层子 Agent' 中性缺省 + profile.executorLabel | 108/1764+1；D-122 golden 转为「注入 '17dz 子 Agent' 逐字节相同」 |
| C3 | `fcfc006` | 工具名参数化：RUN_EXECUTION_TASK_TOOL 'run_task' + profile.toolName；Run17dzTaskArgs 别名退役（openDecisions #5 采推荐：W1 内清干净） | 108/1766+1；docs-reality tripwire 反向翻「全仓绝迹」 |
| C4 | `8b35a2d` | 工具描述与 schema 中性化：buildRunExecutionTaskDescription/Schema(executorLabel)（W1 唯一模型可见文案变更，F6 挂靠点） | 108/1768+1；golden 注入实例称谓逐字节断言落地 |
| C5 | `4e9e8bd` | profileId 缺省去实例名：resolveActiveProfileId 纯函数（单 profile 派生/多 profile fail-closed）；assembly/main 走 activeProfileId | 108/1772+1；assembly 剩 2 处 17dz 注释归 C8 |
| C6 | `a8be999` | 用户可见与运维文案去实例名（错误码 2 + 确认路由 2 + context 6 + plan CLI 4） | 108/1772+1（文案翻转不增用例） |
| C7a | `5bf014b` | 网关名穿线（行为零变化）：error-codes 惰性模板（GatewayText）+ plan-runtime 14 处 errorFor + pi-coding-driver 6 处，全链路 gateway 参数覆盖 | 108/1772+1；plan-teaching D-011 逐字节原样过 |
| C7b | `adfd16d` | GATEWAY_INVOCATION 退役：删常量，resolveGatewayText/gatewayExecPath fail-closed；spawn 全部 gatewayExecPathForProfile；wiring 链补 gateway（C5 推迟项落地）；测试夹具消红 20 文件 | 108/1772+1；architecture-laws L2 断点达成 |
| C8 | `e415b19` | provenance 注释移出源码（→debt-ledger）+ 示例中性化 + surface lint 守卫落地（变异自反内建） | 109/1775+1（守卫 3 用例） |
| C9 | （本提交） | change-safety §27 + debt-ledger W1 节 + 文档关账 | 见下 F7 |

**F1（golden 先行）**：C1 全绿落在 7ba775d；C2-C7b 每 commit 只翻转本 commit 拥有的 describe 块（各 commit message 带翻转清单），C1 冻结的其余断言至终态未动（execution-identity.test.ts 终态 25 例全绿）。

**F2（unit 基线冻结）**：基线 = C1 前重测 107 文件/1745+1（波次 2 后 HEAD 实测；44a84a6 的 105/1725 仅作参考）。逐 commit 单调：1762→1764→1766→1768→1772→1772→1772→1772→1775（+1 skipped 恒定），只增不减。终态 `npm run test -- --project unit` = 109 文件 / 1775 passed + 1 skipped（C9 前实测）；typecheck 每 commit exit 0。

**F3（六项变异，2026-11-06 实跑，临时改→红→还原→复绿）**：
① DEFAULT_EXECUTOR_LABEL 改回 '17dz 子 Agent' → system-prompt D-122 中性断言红 + surface lint 红（2 failed）；还原后 6/6 绿。
② core/config.ts toolName 校验删（`if (false)`）→ config.test.ts '拒绝非法形状（C3）' 红；还原 21/21 绿。
③ resolveActiveProfileId 多 profile 改返回首键（`>= 1`）→ golden C5 纯函数断言 + runner 多 profile fail-closed 断言红（2 failed）；还原 25/25 绿。
④ resolveGatewayText 恢复 'bin/17dz' 回退 → surface lint 红（回退字面量进 src 即被抓；serve-gate/plan-runtime 测试因 C7b 后全部显式注入不再依赖回退而不红——捕获面已转移到身份守卫，属预期防御层级，如实记录）；还原 32/32 绿。
⑤ plan-runtime PLAN_SHAPE_PREFIX 的 errorFor 抽掉 gateway 实参 → plan-shape-fuzz 4 例 + plan-runtime 围栏断言红（渲染回落 fail-closed 抛错，断言拿不到文本）；还原 89/89 绿。
⑥ surface lint 路径集删 apps + 注入 apps/server/main.ts 一处 17dz → 不红（3 passed，漏洞实证）；还原路径集后同注入 → 红（1 failed）；还原注入 → 3/3 绿。两半自反闭环。

**F6（探针一致性——条件项，未授权未跑）**：C2/C3/C4 触及模型可见面（系统提示词称谓、工具名、工具描述）。按 §18 先例未获真实 LLM 授权不跑探针，以字节同一性断言替代并留档：① 系统提示词注入 '17dz 子 Agent' 与参数化前逐字节相同（D-122 frozen base64，C2）；② 工具描述/schema 注入 '17dz 子 Agent' 逐字节（golden C4 注入断言）；③ 工具名注入 run_17dz_task = 改前发布名（golden C3）。**待办**：授权后 `node --env-file=.env --import tsx scripts/probe-real-agent.ts --only A1,A2,A4,A5,B1`（mock 执行器）复跑逐轮 diff，判定标准按方案 f6-probe-parity 预写值。

**F7（文档同提交）**：C2 §1/§10/§12（executorLabel 字段）、C3 §0/§10/§12（toolName + 别名退役）、C7b architecture-laws L2 终态 + execution-layer-interface §2/§10/§12（退役终态）、C9 本节 + debt-ledger W1 节 + v0-architecture §10 身份两行 + rule-landing 现状行。docs-reality 双向对账无机械强制的风险照方案 risk#7 如实成立（本波文档同步为纯人工纪律，surface 守卫的窄断言补强未做，登记 debt-ledger）。

**验收对账（W1 验收清单逐项）**：
- 每 commit unit 全绿 + 只增不减 + typecheck 0：见 F2 表 ✓
- surface lint 绿 + 波前树红形态：守卫 3/3 绿（e415b19）；波前树红形态 = 零排除时对 7ba775d 同 scope 计红——方案口径 160 行（src 非测试 77 + src 测试 66 + apps 非测试 11 + apps 测试 3 + ci.yml 1 + ci.sh 2）未在本棒重放（守卫是在清理同 commit 落地，波前红输出未留档），**以变异⑥（删 apps 路径注入不红 / 完整路径注入即红）+ 排除非空转断言实证守卫有效性**，波前 160 行数字沿方案口径登记——此偏差如实声明。
- 验收 grep（迁移门① W1 子集）：`git grep -il 17dz -- packages/agent/src packages/core/src packages/contracts/src packages/channel-wecom/src apps .github scripts/ci.sh ':!packages/agent/src/budget-policy.test.ts' ':!packages/agent/src/budget-policy-cross-repo.test.ts'` 终态输出 = `packages/agent/src/budget-policy.ts` + `scripts/ci.sh` 两行——**均为挂 `identity-defer: W4` 签的 CROSS_REPO_17DZ_ROOT 行（budget-policy.ts:19、scripts/ci.sh:12；:18 是 C8 同 commit 改注释致 +1 前的旧行号）**。与验收「输出为空」的差异：守卫判据（w1-identity-surface-lint）认行内签排除、验收 grep 是无签感知的裸命令，两者对挂签行的判定不一致是方案内部张力（C8 changes 要求挂签、验收要求为空），按守卫判据执行并如实上报 run owner 裁决（debt-ledger D-162）。**裁决已落（D-162，2026-11-06）：两条挂签行正确保留，门禁按签排除，不是放水**——复核口径 = ①验收 grep 的签排除后零命中（修复轮实测：两文件命中行全部带签，`grep -v "identity-defer: W4"` 后零 17dz 残留）+ ②身份守卫 3/3 绿（execution-identity-surface 修复轮实跑 3 passed）；裸 grep 的 2 行命中即 W4 待办本身，W4 清签后两口径自然一致。Run17dzTaskArgs 未走「W5 退化分支」——C3 已退役，3 行残留不存在。
- platform-leak-lint + docs-reality 绿 ✓（常驻守卫不退场；platform-leak-lint 的业务词表在本波捕获了 C8 一次措辞失误（「记录」），守卫有效）。
- e2e 失败集合对比：见本节末实测行。
- 全程 mock（D-076）：本波零真实平台调用；探针未跑（见 F6）。

**e2e 实测（C9 期复跑 `npx vitest run --project e2e`，非绿门槛、集合对比判据）**：终态 = **28 文件失败 / 106 用例失败**（vitest exit 1）。与波前基线（C1 期 26 文件/93 用例）的偏差如实归因三层：① 本 worktree 初跑 37 文件/148+ 系 fresh 环境缺 gitignored `config/agent.yaml`（C1 期已知坑，从主仓复制后消失）；② C7b fail-closed 波及 e2e harness——`config/agent.yaml` 的 profile 缺 `gateway` 声明 + `tests/e2e/harness.ts` 的 4 处 `load*` 派生未传 gateway，合计推到 37 文件/156 用例；两者已随 C9 修复（agent.yaml 补三项声明——方案 draftsForApproval #5 推荐项，gitignored 不进提交；harness 加 `GATEWAY = 'bin/17dz'` 常量注入 4 处 load*，本 commit）降到 28/106；③ 剩余 28/106 的主因是 **sibling 侧外生变更** `584b580`（2026-10-28「FSHINE_* 旧名退役执行：删六个读取回退、serve() 收窄为 DZ_SERVE=1」）——harness env 仍传 `EXECUTION_MOCK_STATE`/`EXECUTION_PLAN_ACTIVATION_SECRET` 等旧名，平台侧 fail-closed 拒绝（实测签名：`MOCK_STATE_MISSING: 需 DZ_MOCK_STATE…`、`PLAN_ACTIVATION_UNTRUSTED` ×33、`未声明有效的 profile.gateway` ×38[含非 suite 级残余]）。该对齐方案明裁「单独立项不混入 W1」（risk #3/#8、openDecisions #9、debt-ledger D-163）。**结论**：失败集合 28 ≠ 波前 26、用例 106 > 93，集合对比判据不满足；偏差主体归 sibling 外生 env 退役 + 本地部署配置初补，非 W1 代码改动的行为回归（C7b 波及部分已在本波消红），本波不据此宣称 e2e 判据通过，也不宣称「非 fshine 代码缺陷」的强断言——归因证据链如上，W1 期间 sibling 未再变更（584b580 时间戳 2026-10-28 早于 C1 基线 2026-11-05 22:55），C1 期 26/93 与当前 28/106 的环境差异在于本 worktree 初建（agent.yaml 补齐路径）与 shell env（`DZ_EXECUTOR` 在主仓 .env 为空值注释态，e2e 不自动加载 .env；第四轮带 `DZ_EXECUTOR=mock` 验证过 REAL_EXECUTION_NOT_ALLOWED 签名消失、被 MOCK_STATE_MISSING 取代）。归入 D-163 的根因归因报告。

**风险条目兑现**：C7b churn 按清单拆解成立（C7a/C7b 分离提交；C7b 红面 20 文件/210 用例一轮机械消红未叠补丁未 revert——红出现在工作区而非已提交 commit，F5 的「红先 revert」对象不存在的场景，如实记录）；中性缺省值拍板项（draftsForApproval #1/#2）采推荐值 run_task/「执行层子 Agent」落地，改值面 = 单常量 + 两断言，待 run owner 确认（debt-ledger D-161）。

**第三方验收修复轮（2026-11-06，独立验收 1 高 1 中 5 低逐项处置）**：
- 【高危·真回归，已修】C7b 的 fail-closed 守卫漏了 loader 调用点穿线——`pi-coding-driver.ts` 的 5 个派生缓存 wrapper 与 `createPiCodingWorkerSession` 的 4 处 `loadOperation*(cwd)`、`assembly.ts` 的 workerDriver 构建与 `loadOperationArgSpecs(platformRoot)` 都没把 profile 声明的 `gateway` 传下去，波前靠 `gatewayExecPath` 的 `GATEWAY_INVOCATION='bin/17dz'` 缺省回退 spawn；C7b 删回退后这些调用点全部 `validateGatewayInvocation(undefined)=false` → 静默降级空表。生产后果比测试红更宽：label/args 样式/args 规格/语义/协议五张表全空 = 零进度帧、零参数摘要、写关闭前置判定失效。测试可见面 = `turn-loop-progress-frames.test.ts` 3 红（帧「正在读取余额…」丢参数摘要「「幻辰财税」·202606」——label 由测试注入替身幸存、argStyles 走 loader 降级，恰好把回归切剩一面暴露）。修法 = 让派生依赖 profile 声明而非实例名缺省：driver 与 assembly 全部调用点穿线 `options.gateway`/`activeProfile?.gateway`（声明注入，非硬编码）；`turn-loop-progress-frames.test.ts` 的 workerDriver 按 17dz 集成测试部署方口径显式声明 `gateway: 'bin/17dz'`（与 harness.ts GATEWAY 同源）。复跑 `npx vitest run tests/e2e/turn-loop-delegation-failure.test.ts tests/e2e/turn-loop-progress-frames.test.ts` = 2 文件/5 用例全绿；typecheck 0。
- 【高危·断言随翻，已修】`turn-loop-delegation-failure.test.ts`「F7 补」仍断言 C6 改前旧文案 `'17dz 子任务执行失败，请稍后再试。'`——随 acceptance #8 子条款同翻为生产现行中性文案 `'子任务执行失败，请稍后再试。'`（error-codes.ts `DELEGATION_EXECUTOR_FAILURE`），头注释同步。
- 【中危·裁决写实】D-162 验收对账段落 owner 裁决：两条 `identity-defer: W4` 挂签行正确保留、门禁按签排除不是放水；复核口径 = 签排除后零命中 + 身份守卫 3/3 绿（修复轮双口径实跑通过），见上文验收 grep 行与 D-162。
- 【低危·订正】D-162/D-165 引用的 `budget-policy.ts:18` 订正为 `:19`（C8 同 commit 改注释致 +1）；D-167②「波前树已不存在可检出的红状态」不实——修复轮对 7ba775d 实跑重放：零排除 173 处 / 守卫排除形态 156 处（173 − 两个预算测试文件 17 处），方案口径 160 与两实测均不符，详见 D-167 订正。
- 【低危·登记不改】e2e 用例文件的 size 估计 27 vs 实际 37（方案材料口径，本波文档已有 37 实测，不改）；真实 LLM 探针未跑（F6 条件项，字节同一性断言已绿，D-167① 维持待授权）。

## 28. 公开迁移 · W2+W3 波（2026-11-05，w2w3-error-doc：错误码镜像层退役 + 提示词与文档对账）

**范围**：起点 = 波次 2 后 HEAD `7ba775d`（`migration/public-release`），W2-A 表征 golden 已落在起点（`f234457`）。**W1 并行未合入本分支**：`error-codes.ts:352/353` 两行用户可见文案（`DELEGATION_EXECUTOR_FAILURE`/`DELEGATION_CANCELLED`）与 error-codes.test.ts:41 golden 的网关名遗留缺省属 W1 身份参数化，本波不碰——W2-B 后该文件 17dz 计数 7→2，剩余恰为 W1 的两行。六个 commit 一件一事：

| # | 提交 | 主题 | 门内实测 |
|---|---|---|---|
| 1 | `f234457` | W2-A 表征 golden 两条逐字钉住退役前文本（零生产代码改动） | unit 107 文件 / 1745→1747 passed + 1 skipped |
| 2 | `049b2eb` | W2-B 镜像层退役：correctForm 只教结构、信封数据优先、兜底只留结构 + 三把全表锁 + D-002 追记 + L2 更新 | unit 1750；plan-teaching 3 例对锁绿（`plan {"` 计数 = 1） |
| 3 | `d7b8a28` | W3-A worker 提示词静态文本零执行层名渲染级机械锁（`workerSystemPrompt` 纯测试缝导出） | unit 1751；docs-reality 9 例 |
| 4 | `7e77798` | W3-B §10 逐行对账修正（5 行）+ rule-landing §3.1/§3.2 刷新 + AGENTS.md 事实修正 + turn-contract 注释 + 2 条文档级 tripwire | unit 1752；docs-reality 10 例 |
| 5 | `a366a2b` | W3-C business-skill 两处执行层指称中性化（提示词注入面收尾） | business-skill 守卫 10 例绿 |
| 6 | 本提交 | C6 波次记录（本节）+ debt-ledger 迁移清册五条（D-168–D-172） | docs-only，零代码改动 |

**F1（表征先行）**：W2-A 把 `PLAN_CALL_ARGS_NOT_ARRAY`（correctForm 含业务命令示例）与 `ENTITY_OUT_OF_SCOPE`（correctForm 含平台 operation 名）的现行渲染文本逐字钉住（逐字串以首跑实际输出粘贴）；W2-B 有意翻转两条并在测试注释注明翻转点与理由（F1「golden 一条不改」的合法例外 = 波次内有意行为变更），退役前钉子原文 `git show f234457` 可取。

**F2（基线冻结）**：unit 用例数曲线（实测，只增不减）：1745（波前）→ 1747（W2-A，+2）→ 1750（W2-B，+3 三把锁）→ 1751（W3-A，+1）→ 1752（W3-B，+1 tripwire）→ 1752（W3-C，无新测试）；文件数恒 107；skipped 恒 1（budget-policy-cross-repo.test.ts 的 CROSS_REPO_17DZ_ROOT skipIf）。终态 `npm run ci` exit 0（typecheck + unit 107/1752+1 + generic-mock 21 cases pass, 0 skipped）。

**F3（变异留档，五项本地实测「改错→红→还原→复绿」）**：
① `ENTITY_OUT_OF_SCOPE.correctForm` 加回 operation 名 → 锁①红（`AssertionError: ENTITY_OUT_OF_SCOPE 含平台 operation 名 finance.search-account-sets`）→ `git checkout` 还原 → 复绿 27 passed；
② `PLAN_CALL_ARGS_NOT_ARRAY.correctForm` 加回 `--query` 示例 → 锁②红（`not to contain '--'`）→ 还原 → 复绿；
③ `clarificationTextFor` 删信封优先分支（`data.correctForm?.trim() || entry.hintFallback || ''` → `entry.hintFallback || ''`）→ 既有「信封带平台 correctForm 时优先渲染它」用例红（渲染出宿主兜底句而非平台措辞）→ 还原 → 复绿 27 passed；
④ `error-codes.ts` 尾增第二处 `plan {"` 草案形状字面量 → `plan-teaching.test.ts` 计数断言红（1 failed | 2 passed）→ 还原 → 复绿 30 passed；
⑤ workerSystemPrompt 静态文本注入一处 17dz（身份句）→ docs-reality 渲染级锁红（`not to match /17dz/i`）→ 逆文本替换还原（W3-A 未提交态，git checkout 会连带丢测试缝）→ 复绿 9 passed。
收尾 `git status` 干净。

**F4**：六个 commit 逐件一件事（见上表）。**F5**：本波无 revert 事件——每 commit 落地前红先证据均在当次会话内转绿，无叠补丁。

**F6（诚实登记：未跑）**：真实模型探针未跑（需用户授权 + token 花费；§18/§19/§24 同款先例），不写成已跑。预设判据：① W2-B 后 `ENTITY_OUT_OF_SCOPE` 正路径仍引导「先名称检索」（既有单测「名称检索/平台响应/同样有效」断言钉住）+ 探针复跑实体门拒绝场景时 worker 仍走「先名称检索再重提」路径、不新增空转轮次（验收 = 不劣化，观察项登记）；② W3-C 后 business-skill 守卫组绿 + 路由表唯一权威声明语义不变（静态部分已满足：权威声明句逐字保留，只去实例名）。

**F7（文档同提交）**：W2-B 伴随 debt-ledger D-002 追记 + architecture-laws L2「错误码表镜像」终态；W3-B 伴随 v0-architecture §10/§4、rule-landing §3.1/§3.2、AGENTS.md 事实修正、turn-contract.ts 注释、docs-reality 2 条 tripwire；本提交伴随 debt-ledger D-168–D-172。

**§10 十二行逐行核对结论**：7 行属实（写路径 / 执行凭证 / Subagent 报错回路 / 主动回溯 / 执行层记忆 / 多任务回溯绑定 / 业务 skill 主体——末行补 2026-11-04 中性化注记）+ 5 行修正（申报契约三枝四字段〔resend 枝 2026-10-20〕、领域判别收窄至 worker 提示词、长任务拆解目标列去「仍 3 字段」、通用预算策略补 2026-11-04 宿主叠加档、提示词面积按实测重写）。

**门① 存量基线（本波终态实测 2026-11-05，`git grep -c -i 17dz` 逐文件；波前读数同会话实测）**：README.md 7→7、config/agent.example.yaml 5→5、docs/v0-architecture.md 9→5（本波 −4，≤6 达标）、docs/architecture-laws.md 10→10（本波零增减；方案基线 9 为旧时点读数）、docs/rule-landing.md 32→30（本波 −2，历史叙述段保留）、docs/environment-variables.md 18→18、scripts/ci.sh 2→2、.github/workflows/ci.yml 1→1、package.json 1→1、packages/agent/src/error-codes.ts 7→2（本波 −5，剩余归 W1）、packages/agent/src/context.ts 16→16、docs/business-skill.md 2→0（本波清零）。src 测试夹具与 scripts/ 验收夹具口径未定，归 D-168。

**L3 出口校验（用户可见文本零劣化）**：error-codes.test.ts 既有用户可见话术逐字断言（NO_EXECUTION_CLARIFICATION / ACTIVATED_PLAN_NOT_EXECUTED / RESUMED_* / FALLBACK_* / DELEGATION_* / 选择类澄清两模板 / 终局快路径 / PLATFORM_UNAVAILABLE / WRITE_NOT_ENABLED / PLAN_NOT_PLANNABLE 共 20+ 条 toBe）一条未改；W2-B 只改 worker 面向的 correctForm 诊断。`reply-exit`（22）/`runtime`（102）/`platform-health`（20）逐文件实测全绿 144 例。**低频偶发登记（如实）**：三文件**并行组合**跑 12 次中 1 次偶发 1 failed（失败详情未被捕获，非 AssertionError 抓取形态），逐文件与同组合复跑 11/12 全绿；波前树（`f234457`）同组合对照 6/6 全绿。判为低频环境 flaky（并发资源竞争形态）而非本波确定性回归——本波生产代码改动（两条 correctForm + 注释 + 一个 export 缝）与该组用例涉及的 resume/auth/cooldown 链路无交集；后续若复现，先抓失败用例名再归因，登记为观察项不冒充已归因。

**e2e 侧文本耦合静态核对（本波不修 e2e 环境红）**：`tests/e2e/turn-loop-security.test.ts:236` 为 `startsWith('ENTITY_OUT_OF_SCOPE: 期望')` 前缀断言——前缀不受 correctForm 改动影响；`scripts/plan-reject-report.test.ts:65` 夹具止于「或向用户澄清」（新 correctForm 开头逐字包含）且实测 9 passed。e2e 项目整体在本机为环境预存红（基线归 W1/W4 波冻结），本波不拿 e2e 全绿自证、也不在本波修。

**全程 mock（D-076）**：本波无任何非 mock 的执行路径、无 `EXECUTION_EXECUTOR` 置空、无 `FSHINE_REAL_COMMIT`；npm run ci 三段（typecheck + unit + generic-mock）均为 mock 面。

---

## 29. 公开迁移 · 预算策略上收波（2026-11-06，w4-budget-strategy：通用预算协议单一源 + 跨仓校验移交执行层）

**目标形状**：通用预算策略上收为宿主持有的协议级单一真相源——12 个阈值缺省（calls 2/10/20/50、seconds 60/180/600/1800、weight 6/18/60/180）不再是「逐字对齐执行层」的第二份，其归属表述为通用预算协议缺省档位线、单一真相源在宿主 `budget-policy.ts`；执行层经声明面（operation 清单 est_seconds/weight/effects）给估时、可声明更严硬上限并由执行端门在实际调用处复核；双门并行期宿主档只收紧不放宽（`stricterTier`）；跨仓预算一致性校验从 fshine 搬到执行层仓（方向修正：执行层核对自己对通用协议的一致，宿主不知道执行层）。平台计划门原样保留至迁移完成，本波零门禁删除、零运行时行为变化。

**commit 表**：

| commit | 主题 | F2 记账（unit） |
|---|---|---|
| 8a18d0b | C1 表征先行：双门叠加语义 23 例 + 两个现状不对称性钉子 + dummy 第三副本守卫（预热落地，本棒变基到集成头 5624075 后复验全绿；未改任何生产代码） | 110 文件 / 1798+1 skip |
| 769ce54 | C2 协议缺省单一源（零行为变化）+ G2 守卫 + W1 守卫自设指令的覆盖收紧 | 110 文件 / 1799+1 skip（+1=G2） |
| （17dz 仓）4f0e2ec | C3 一致性校验落执行层：rename-immune 解析 + 七态夹具 + 真实解析路径 + architecture.md 方向声明 | （跨仓，不在 unit 口径） |
| aef5814 | C4 跨仓校验退出宿主：脚本/测试/npm 入口/CI scope 改写/env 文档 + D-150 落定、D-151/D-162/D-165 关账、D-168 新登 | 109 文件 / 1788+0 skip（-9-1skip-1 文件，被删测试） |
| （本 commit） | C5 标定三问逐道重答 + D-169 新登 + rule-landing/v0-architecture 同步 + 本节 | 见 F2 表 |

**双门判据一致性的证据形态**：机械侧 = ① 17dz 仓七态夹具（含不对称块注释钉子，G7-⑥ 变异实测红→还原→复绿）+ 真实两仓比对（fshine W4 检出 ↔ 17dz origin/main de41ae3：新校验脚本 exit 0「12/12 一致」；被删旧脚本从 aef5814^ 取原文对同检出补跑同证 exit 0——G4 删除前留档本应在 C4 前实跑，此处如实记为删除后从父提交补跑的等效证据）；② fshine 仓 G1 dummy 守卫（dummy.cjs planPolicy 12 值逐键 + planDecision 算子骨架锁，受测参考实例与协议缺省分叉必须红）；③ G2 守卫（budget-policy 两文件零 17dz/plan.js/跨仓脚本字样，变异自证）。书面侧 = G1 每条用例注释的「执行层 decision() 同形实现」逐支对应（>= vs >、scale 三线同乘、rank 取严、previous 只改措辞）。**对真执行层的逐支逻辑 conformance 无机械校验**——登记 D-169 附带项，共享判别向量或执行层侧形状断言留 W5。

**切换条件（平台门退役条件，本波不执行）**：双门判据一致（上三机械侧全绿）+ e2e 失败集合不增 + 探针 parity（需 LLM 授权）+ 执行层 CI 真实 12 键 parity 接线绿灯（D-168，限期波次 5）。capacityScale/grantLevel 协议字段设计留 W5（D-169；W4 不拿 budget 回执的呈现字段当控制输入）。

**门① 剩余产品面交接清单（锁定口径实测，2026-11-06 本波终态；命令 `git grep -c -i 17dz` 逐文件，排除 debt-ledger/change-safety 两档案例外）**：
- **在册面已清零**：packages/agent/src、packages/core/src、packages/contracts/src、packages/channel-wecom/src、apps、.github（W1 清 identity 面；W2 清 error-codes 面——以 W2+W3 终态为准；W4 清预算面）。本波终态实测：以上路径非测试 .ts 零命中。
- **docs 规格与说明（归 W3/W2+W3 与波次 4）**：rule-landing 33、environment-variables 16、roadmap 13、v0-functional-spec 11、e2e-ownership 11、execution-layer-interface 11（本波 §4 已清其预算段）、architecture-laws 10、manual-test-wecom 9、v0-architecture 6（本波 §10 预算行改写后 9→6）、v0-implementation-decisions 6、business-skill 2、execution-layer-admission 1、test-hardening 1。
- **scripts 验收/探针夹具（归波次 4，口径待拍板）**：acceptance.ts 4、ask.ts 4、probe-real-agent.ts 5、smoke-real-platform.ts 4、acceptance-22-supplement.ts 2、long-session-acceptance.ts 2、mock-commit-smoke.ts 2、plan-reject-report.test.ts 1、eval/corpus.jsonl 1、eval/GENERIC_MOCK_NOTES.md 1。
- **模板与元数据（归 W1/W3/波次 4）**：config/agent.example.yaml 8、README.md 7、.env.example 3。
- **包根测试夹具（册外待拍板——锁定 glob 是 packages/*/src，包根 *.test.ts 不在册；若扩口径则量大增，见 W4 方案 risk#2/openDecisions#6）**：serve-gate.test.ts 248、pi-coding-driver.test.ts 56、execution-identity.test.ts 37（W1 golden，故意钉实例值）、core/config.test.ts 32、context.test.ts 29、plan-runtime.test.ts 27、proposal-runtime.test.ts 26、pi-coding-driver-plan-audit.test.ts 31、proposal-flow.test.ts 13、operation-labels.test.ts 9、plan-teaching.test.ts 8、pi-coding-driver-executor-bypass.test.ts 15、其余零星。
- **守卫自引字面量（结构性，不算命中）**：execution-identity-surface.test.ts 5、docs-reality.test.ts 8（G2 守卫的禁令断言本身）、platform-leak-lint.test.ts 6（allowlist 标签制度）。
- 合计 785 行（含册外与守卫自引）；在册面（src+apps+scripts+config 模板+README+.github+docs）待清约 145 行。

**e2e 红基线冻结（G6；本波实测口径，取代方案冻结的 26/93）**：环境前置已满足——`FSHINE_PLATFORM_ROOT=<17dz origin/main 检出>`（本波在 17dz-platform 仓建的 origin/main 检出 worktree，含 C3 增量；未动用户主检出；具体路径属部署环境细节不入文档——exposure-lint 内部绝对路径禁词对全部被跟踪文件生效，本行首稿即被它抓出改写）+ `EXECUTION_EXECUTOR=mock` + 本 worktree gitignored config/agent.yaml 补 W1 三项声明（gateway/executorLabel/toolName，root 指向同一检出）。命令 `FSHINE_PLATFORM_ROOT=<…> EXECUTION_EXECUTOR=mock npx vitest run --project e2e`：**22 文件失败 / 86 用例失败**（38 文件/159 用例）。与方案冻结基线 26/93、W1 终态 28/106 的差异归因：① 后两者测于陈旧平台检出（DZ_* 旧名 vs harness 的 EXECUTION_* 新名）——origin/main 平台下 MOCK_STATE_MISSING/PLAN_ACTIVATION_UNTRUSTED 签名消失；② W1 修复轮后 harness 需 profile.gateway 声明（本波 agent.yaml 已补）。**A/B 同环境对照（新增侧必须为空的判据形态）**：在波起点 commit 8a18d0b（pre-C2）建临时基线 worktree、同一 node_modules、同一 config、同一 env 复跑同命令 → 22 文件/86 用例，FAIL 文件集合与本波终态逐一相同（diff 空）——C1-C4 零 e2e 新增失败，22/86 为继承环境债。逐文件计数：turn-loop-write-chain 15、turn-loop-security 11、turn-loop-plan-gate-boundaries 10、input-shape-variants 8、turn-loop-error-fast-path 5、turn-loop-long-session-invariants 4、turn-loop-concurrent 4、turn-loop-pingpong 4、turn-loop-plan-gate 2、turn-loop-clarification 2、turn-loop-interleaved 3、turn-loop-needs 2、turn-loop-phone-incident 2、turn-loop-disambiguation 2、turn-loop-plan-steps 2、turn-loop-recall-facts 2、turn-loop-session-entities 2、turn-loop-activated-plan 1、turn-loop-execution 1、turn-loop-resume 1、turn-loop-write-closure 1、harness-fidelity 2。签名分布：AssertionError 71（mock 实体门应答/夹具期望，主体）、「未声明有效的 profile.gateway」35（e2e 假 worker 路径的 C7b fail-closed 形态，harness 侧 env 对齐遗留）、PLAN_REFUSE 1。e2e 不作本波绿灯门槛；失败集合不增判据由 A/B 对照满足，根因归因与 harness env 对齐仍归 D-163。

**dummy 第三副本定位声明**：`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs` 是 generic-mock（npm run ci 一道门）的受测通用执行层参考实例，不是真执行层仓；其与协议缺省的一致性由仓内断言钉住（G1 dummy 守卫：planPolicy 12 缺省逐键 + planDecision 算子骨架），不进 C3 跨仓 parity（跨仓只覆盖真执行层仓）。绕过守卫把它当「可漂移的夹具细节」或反向把它扩进跨仓比对都不合法。

**F1/F3 实测记录**：G1 表征 23 例在变基后集成头复验全绿；G2 变异（budget-policy.ts 注入 17dz → docs-reality 守卫红 1 failed → 还原复绿 9 passed）；G7-⑥ 变异（17dz 仓剥离器删块注释分支 → 七态 ④ 红 2 fail → 还原复绿 27 pass）；G7-①（budgetWeight `>=` 改 `>` → G1 恰等边界例红 1 failed：confirm 漏成 notify，两方向都是事故面 → 还原复绿 23 passed）；G7-②（scale 从 weight 四线删掉 → grantLevel 扩容例红 1 failed → 还原复绿）；G7-③（叠加判据「宿主 rank 严格更高才覆盖」改成「平台档优先」（`>` 反转为 `<=`）→ plan-budget-dual-gate + plan-budget-overlay 双红 6 failed（不放宽防线失效实证）→ 还原复绿 34 passed）；G7-⑤（budget-policy.ts notifyWeight 18→19 → G1 边界例 + G3 dummy 第三副本守卫双红 2 failed → 还原复绿 23 passed）。六项均「本地改错→对应断言红→还原→复绿」，变异后 `git status` 干净。

**F7（文档同提交）**：C2 execution-layer-interface §4 + docs-reality 守卫同提交；C3 architecture.md 方向声明同提交（17dz 仓）；C4 ci.sh scope 注/env 文档/rule-landing 守卫描述/D-150/D-151/D-162/D-165/D-168 同提交；C5 architecture-laws「预算门标定」表 + rule-landing C12/§10 + v0-architecture §10 + D-169 + 本节同提交。

**F2 表（逐 commit 实测，冻结基线 105 文件/1725+1 skip）**：变基后起点 110/1798+1（W1 增量+23）→ C2 后 110/1799+1 → C4 后 109/1788+0（-9-1skip-1 文件，被删 budget-policy-cross-repo.test.ts；仍 ≥1725）→ C5 后见本 commit 实测行。每 commit `npm run test -- --project unit` 全绿 + `npm run typecheck` exit 0。

**F6**：本波零提示词/零门语义行为变化（C2 数字与比较符一字不动；C4 删的是从未进 CI 的开发面脚本）→ 不取新探针基线；判据=冻结基线 §16 W4（A1/A4/A5）不劣化，需真实 LLM 授权后补跑（未授权不跑，D-076 全程 mock）。

## 30. 公开迁移 · 结构化调用协议波（2026-11-06，w5-structured-protocol：W5 方案记录 C0——裁定 + 双仓改动列表 + 配对表 + 退役判据）

**本节性质**：W5 的**波次方案记录**（本波第一个 commit 落档），不是执行关账——逐 commit 的执行证据随各 commit 落地，关账由方案 C12 同步更新本节。方案全文在 `pp-waves-c.json`（waveId=W5）与汇总员分节 `out/parts/19-21-w5`；编号沿用方案 C1–C11（C12 关账合并进本节更新），与 §16 历史波次的 W0–W7 命名空间不冲突（方案 Q8 的建议：编号顺延不硬编码，本节即 §30）。

**目标形状**：按 `docs/a2a-protocol.md` 用结构化调用协议替代现行 env 级接线（`EXECUTION_EXECUTOR` / `EXECUTION_ALLOW_REAL` / `FSHINE_REAL_COMMIT` 一族与网关 spawn 路径），phased cutover（旧路径作 fallback 直到新路径被证明）+ 失败分类全覆盖测试矩阵收口；L4 判据机械化为「新增一个第二业务写域、端到端证明 + fshine 生产 diff=0」；§17 latent 按「声明可守 / 读回计数可守 / 执行层内部不可守」三类分流，不可守子集登记归属与限期，不宣称七项整体闭环。**公开库即终局架构，不带中间态**——fallback 是迁移期形态，其退役判据见下，归宿由波次 4（门面按终局写）收口。

### 四项裁定（owner 2026-11-06；前两项解设计门 Q1/Q2/Q3，Q4 解跨仓排期）

1. **Q1 调用载体**：网关 CLI 结构化子命令 `<gateway> call --file <json>`。worker 侧 typed 调用工具经 driver 的 beforeToolCall 拦截后走同一出口；参数 schema 由执行层自有声明派生，宿主不解析不校验业务参数。**2026-11-10 改判**：该 CLI 是执行层的适配器绑定，不是协议要求——协议不关心实现，执行层可用任何传输（CLI/网络），协议只要求能力语义。
2. **Q2/Q3 三道门与 mock 选择器归属**：三道门（serve 令牌 / 实执行授权 / 真写授权）与 mock 选择器**整体归执行层**——成为执行层部署配置里的普通声明参数，fail-closed 逐门保留；编排层只持通用确认事实（谁确认、绑哪个计划版本、有效期）；`EXECUTION_*` / `FSHINE_REAL_COMMIT` 等 env 级开关从宿主退役（退役前各执法点拒绝形态与错误码逐字不变）。**2026-11-08 已执行**：宿主侧读 `EXECUTION_EXECUTOR` / `FSHINE_REAL_COMMIT` 的模块（`platform-mock.ts`）、启动模式报告（`runtime-mode.ts`）、以及由它们派生的写执法位（`writeEnabled` / `proposalCommitEnabled`）与写关闭合成话术全部删除；serve 令牌门与实执行门的执法点不变（那两门的 env 由执行层自己读）。
3. **Q4 跨仓形态**：17dz-platform 同批实现，走 PR 给 owner。17dz 侧改动列表（P1–P6）见下；fshine 侧用 mock 接缝证明宿主行为，真实配对用 17dz 集成写 e2e 证明（前置 = 兄弟仓检出，标注「具备前置后跑」）。

### fshine 侧改动列表（C1–C11）

| # | 主题 | 要点 | 状态（2026-11-06 本波第 1 棒实测） |
|---|---|---|---|
| C1 | 表征 golden 先行 | `packages/agent/a2a-cutover-golden.test.ts`：现行 env 级接线、委派块、失败分类、spawn 面逐条钉住；翻转点注明 C5/C7 | 本波第 2 commit |
| C2 | 契约词汇补全（零行为变化） | `packages/contracts/src/a2a-protocol.ts` 增 OperationDeclaration / CapabilityManifest / StructuredCall；清单是能力语义的宿主侧投影（不缓存、不复制、不另立名单，L2）。`<gateway> operation list --json` 是适配器绑定，不是协议要求（2026-11-10 改判：执行层可用任何传输，协议只要求能力语义）。词汇纯度断言落 `packages/agent/a2a-vocabulary.test.ts` | 本波第 3 commit |
| C3 | 五路链抽纯函数 | `classifyDelegationFailure` 逐字搬移 context.ts 失败链，结构化判据入参（不是 reason 串）；行为零变化，golden 第⑤项保持绿 | 已完成：`delegation-failure.ts` 落地 + context.ts 接线 + golden ⑤绿 |
| C4 | 失败分类收口 + 全覆盖矩阵 | 五类（NEEDS_INPUT / CAPABILITY_UNAVAILABLE / PLATFORM_ERROR / RESOURCE_EXHAUSTED / HARD_REJECTED）宿主送达义务对齐 + `failure-delivery.test.ts` 全矩阵；措辞仍取 error-codes.ts / resource-exhausted.ts 单一来源 | 已完成：`failure-delivery.ts` 覆盖五类 + error-codes.ts 补 CAPABILITY_UNAVAILABLE/HARD_REJECTED 条目 + context.ts 内联话术接线 deliverFailure |
| C5 | 委派块按 DelegationBlock 落地 | entities/inputs 进载荷（数据源已存在：entitySources + materializeInputs，不改 ContextTaskRunArgs 签名）；golden 第④项显式翻转（翻转点一）；三处依赖【委派】载荷的 e2e 断言同 commit 更新 | 已完成：`context.ts` 委派块结构化 + golden ④翻转 + turn-loop-routing/clarification/worker-timeout e2e 断言随翻 |
| C6 | 结构化调用通道【Q1/Q2/Q3】 | WORKER_TOOLS 增加结构化调用工具 + 宿主按 CapabilityManifest 机械复核 + 既有 executor 接缝 spawn（EXECUTION_EXECUTOR=mock 自动覆盖，D-076 不变）；worker 发起走 createPlanScopedWorkerEnv（计划门不绕开）、宿主办调走 hostGatewayEnv（D-081 岔路的法域选择由回归测试钉住） | 已完成：structured_call 工具注册 + beforeToolCall 验证 + spawn 接缝保留 |
| C7 | spawn 路径切 gatewayExecPathForProfile（翻转点二） | 10 个 spawn 消费点全部经 profile 驱动函数、缺声明 fail-closed；修 platform-contract.ts 失真注释；GATEWAY_INVOCATION 文本识别回退（resolveGatewayText / gatewayTextPatterns）随本批退役（小裁示 3） | 主体已由 W1 C7b 达成（见下「现状对账」）；剩余 = 注释修正 + mock-commit-smoke 缺陷修复 |
| C8 | 三道门部分落地：platform-mock/assembly/5 脚本显式传参 | 执法点（platform-mock.ts + assembly.ts + 5 脚本）已改显式携带；serve 令牌门与真写门执法点（hostGatewayEnv/createPlanScopedWorkerEnv，context.ts/plan-runtime.ts）仍以 env 继承形态存在，未动；任一缺失仍 fail-closed | 部分完成：平台侧 env 缺省移除 + 调用方显式传参；serve/真写门执法点未动 |
| C9 | phased cutover【Q5】 | profile 级协议选择：缺省新路径；新路径不可用回落旧 bash 路径，事件 a2a_fallback 进审计，回落不许静默；退役判据见下（口径切开：17dz 旧路径 e2e 标为 fallback 覆盖，其回落事件不计入退役计数） | 已完成：新路径默认 + fallback 事件落 .runtime/a2a-cutover.jsonl + 审计 |
| C10 | L4 闭环 | 第二非财税写域夹具（命名见小裁示 1）+ 端到端驱动（generic-mock 用例）+ fshine 生产 diff=0 + §17 latent 三类分流守卫 | 已完成：ballot-platform 6 操作进 dummy.cjs + generic-mock.ts 新增 g-ballot-second-domain 用例 + baseline 23 例全绿 + generic-mock.test.ts 断言更新 + D-031 三类分流登记 + D-178 登记 |
| C11 | 关账核对（drafts 待批收缩后） | 原方案「退役 Run17dzTaskArgs + 委派工具协议面中性化」已被 W1 提前完成（见现状对账）；本 commit 只做关账核对——docs-reality.test.ts:125-131 承诺指向的落点确认 + §30 之外不新增改动（小裁示 4：不硬改名） | 已完成：docs-reality 11 测试全绿 + Run17dzTaskArgs 全仓绝迹确认 + DelegationBlock 协议中性确认 |
| C12 | 关账 | 本节（§30）更新 + debt-ledger D-076/D-031 三类分流留档 + 判断项（C9 fallback、C8 显式 env、mock-commit-smoke gateway 修复）收口 | 本 commit |

### 17dz-platform 侧改动列表（P1–P6，owner 2026-11-06 改动列表评审；与 fshine 侧同批，走 PR 给 owner）

- **P1** `bin/17dz` + 网关分发：新增 `call --file <json>` 结构化子命令（当时 Q1 裁定的载体在执行侧的落地；**2026-11-10 改判**：此 CLI 是适配器绑定，不是协议要求）。参数 schema 由执行层自有声明，宿主不解析不校验业务参数。配对 C6。
- **P2** `src/lib/envelope.js`：五类失败分类词汇（cancelled/timeout/model_transient/auth/executor_error → 协议五类）进信封 emit 出口统一收口，与 fshine C4 的映射表逐条对齐。配对 C5。
- **P3** 各域 `operations.json` 与 `operation list --json` 输出：补 a2a 词汇投影字段——est_seconds/weight/effects/access 已有，补协议版本与失败类声明；CapabilityManifest 在宿主是能力语义的消费投影（L2：不缓存、不复制、不另立名单）。`operation list --json` 是适配器绑定，不是协议要求（2026-11-10）。配对 C5。
- **P4** `src/lib/real-execution.js` + 执行层部署配置：**三门成为执行层自己的普通参数**——real-execution 授权、commit 授权、executor 模式（mock/real）全部落成执行层配置里的声明参数；fail-closed 逐门保留，标定三问（硬/软、标定依据、误拦什么 + 自愈路径）在执行侧重新回答并留档。配对 C8（宿主侧三个 env 读取点同批退役）。
- **P5** `scripts/cross-repo/`：通用预算协议 parity 校验器——已在 17dz 本地分支 `w4-budget-protocol`（commit 4f0e2ec，含 rename-immune 解析 + 七态夹具 + 真实解析路径测试），**尚未 push、尚未合入 origin/main**；下一步 = push 该分支 + 开 PR 给 owner，这是同批协作的第一块砖（跨仓改动需 owner 认可的在途形态）。
- **P6** `test/`：call 子命令的契约测试 + 失败分类映射的双向对账测试（fshine C4 映射表 ↔ 17dz P2 实现）+ 七态夹具扩展。

### 跨仓配对表（必须成对验证）

| fshine | 17dz | 验证形态 |
|---|---|---|
| C5 委派块 DelegationBlock 落地 | P2 信封失败分类收口 + P3 operations.json 投影字段 | fshine 单测 + mock 接缝；真实配对走 17dz 集成写 e2e（需兄弟仓检出前置，标注「具备前置后跑」） |
| C6 结构化调用通道 | P1 `call --file` 子命令 | 同上 |
| C8 三道门执法点 | P4 三门落执行层配置参数 | 同上 |
| C10 第二写域夹具 | 第二写域的 stock 网关实例 | generic-mock + 单仓通用 e2e（不依赖兄弟仓）；stock 真网关配对走集成 e2e |

### fallback 退役判据（C9 的机械条件）

`a2a_fallback` 事件**连续 20 跑次为 0**（阈值可配）+ 覆盖域 = 17dz 全操作族 + 第二写域 + 证据落 `.runtime/a2a-cutover.jsonl`（每行带协议版本 / 域 / corpusVersion 三元组）+ 评审接受人 = owner。退役前 fallback 分支与 a2a_fallback 事件在册（packages/agent 内存在性断言，docs-reality 同款形态）；`tests/e2e/turn-loop-write-chain.test.ts` 头部标注 fallback 覆盖用例——该文件不产生 fallback 行（不走 structured_call），并非计数器口径显式排除；计数器本身无域过滤，对 `.runtime/a2a-cutover.jsonl` 全局数 `fallback === true` 行。**机械计数器**：`scripts/eval/count-a2a-fallback.ts` 读取 `.runtime/a2a-cutover.jsonl` 并输出 fallback 行数；CI 或本地跑满 20 次后该脚本输出 0 即满足计数条件。**归档/轮转**：若工作区曾产生 fallback 行，可用 `--archive-to <path>` 将 fallback 行归档并保留非 fallback 行，使计数器可重新从 0 累计；归档文件追加写入，不覆盖历史。**三域新路径全绿**判据需要 17dz 兄弟仓前置（兄弟仓提供 stock 网关 + 全操作族覆盖），本仓确定性门内单独不可达，需与 17dz w5-tail 配对验证。

### 四个小裁示（owner 待确认，已带推荐；不堵 C0–C2，C9/C11 开工前需定）

1. **Q9 第二写域名**：推荐 `ballot-platform`（非财税域、与 payroll.*/stock.*/dummy.* 零重叠，避免撞 leak-lint 的 FORBIDDEN 指纹与 L4 判据原文的 payroll 举例）；备选 booking-platform。
   - **执行状态**：已采纳 ballot 命名，落点 = dummy-platform/bin/dummy.cjs 内 6 个 ballot 操作（与 dummy 共享状态机，未建独立 fixtures/ballot-platform/ 目录）；命名理由段已补 execution-layer-admission.md「ballot 第二写域证据」节 + D-178 登记。待 owner 确认共享状态机方案是否可接受。
2. **Q10 entities 投影规则**：推荐 DelegationBlock.entities 取四来源（当前消息 / Log / 平台响应 / 会话已确立实体）**全量并集**——执行层复核从宽，宿主不替它做步骤级裁剪；inputs 只带 FrozenTaskInput 的引用清单不带内容。
   - **执行状态**：偏离采纳——实现只取 platformEntities + sessionEntities（结构化字段），文本来源（currentMessage / quotedEvidence / referenceEvidence / platformResponses）全部排除；context.ts:1204-1207 已补偏离登记注释，理由 = 文本来源体积大且含噪声，结构化实体值已足够 worker 做范围判定。待 owner 确认。
3. **Q11 网关文本识别回退退役时机**：`resolveGatewayText`/`gatewayTextPatterns` 的文本识别侧穿透验证随 C7 同批退役（推荐）；不留给 W1 补。
   - **执行状态**：已达成（W1 C7b）。`gatewayTextPatterns` 函数仍导出并由 serve-gate.ts / plan-runtime.ts 消费（文本识别正则派生用），但 `GATEWAY_INVOCATION` 常量与文本识别回退语义已退役；`resolveGatewayText` 退为 fail-closed 校验器（platform-contract.ts），serve-gate.ts / plan-runtime.ts / error-codes.ts 的「未注入时走遗留缺省」注释已由 ee60b8a 修正为 fail-closed 表述。C7 翻转点二已落地。
4. **C11 范围**：只做关账核对（docs-reality 承诺指向 + 本节之外不新增改动），**不硬改名**——W1 已完成工具名参数化（RUN_EXECUTION_TASK_TOOL='run_task' + profile.toolName）与 Run17dzTaskArgs 别名退役，迁移门①（产品面 17dz=0）已达成，硬改名只剩断对外协议的成本。
   - **执行状态**：已达成（C11）。docs-reality.test.ts:125-131 Run17dzTaskArgs 绝迹断言绿；DelegationBlock 协议中性确认；本节未新增改动。

### 现状对账（2026-11-06 本波第 1 棒实测，影响方案若干条目的表述）

- **W1 已合入集成分支**（`3ad9a82` merge(w1)，在 W2+W3/W4 之下）：`RUN_EXECUTION_TASK_TOOL='run_task'`（context.ts:61）、`DEFAULT_EXECUTOR_LABEL='执行层子 Agent'`（system-prompt.ts:29）、Run17dzTaskArgs deprecated 别名已退役（context.ts 无命中）——小裁示 4 的「W1 已完成」前提坐实。
- **W1 C7b 已达成 spawn 面 fail-closed 主体**：platform-contract.ts 不再持有 `GATEWAY_INVOCATION` 常量（注释区 :25-33）；`gatewayExecPathForProfile` 生产调用方 = 5（context.ts:585、plan-runtime.ts:126、pi-coding-driver.ts:1453、apps/server/proposal-commit.ts:60、scripts/mock-commit-smoke.ts:57）；`gatewayExecPath` 调用方 = 7（operation-labels.ts:88/223/268/389/476/547/698，mock-commit-smoke.ts 使用 gatewayExecPathForProfile 故为 0）——合计 12 个 spawn 消费点，与方案计数一致，但全部已是「未声明/非法即抛」，方案原文「静默落到 bin/17dz」的现状表述作废。golden 第⑥项按现行真实行为钉（fail-closed 已达成），C7 的翻转点相应改为「注释修正 + mock-commit-smoke 缺陷修复」。
- **mock-commit-smoke.ts:57 既存缺陷**（登记，属 C7 收尾范围）：`gatewayExecPath(platformRoot)` 单参数调用缺 gateway，运行时报 `gatewayNotDeclaredError`（本会话 `node --import tsx` 实测）；根 tsconfig include 不含 scripts/ 故 typecheck 不拦。修法随 C7（补 gateway 入参或改 profile 驱动）。
- **F2 基线记账**：本波起点实测 `npm run test -- --project unit` → **109 文件 / 1795 passed / 0 skipped**（W4 冻结点 105/1725+1 skip；只增不减满足——skipped 归零为前序波次修复所致，如实记录不追认为缺口）。

无混波——全部 W5 范围、§30 表逐条对账、归因清晰；extra commits 正是主 body 落地不完整/红的修复件。验收⑫字面「一一对应」不成立，但实质属性（全部 W5 范围、归因清晰）成立。

### 验收⑬口径校正

基线 `migration/public-release` 的 `packages/agent/src` + `apps/server` 非测试 17dz 命中实测已为 0（W1 清场），本波维持 0，「82→下降」叙事属 W1 而非本波（不构成回归）。本条验收因基线已在 0 地板上，字面『相对基线下降』不可达，按『0→0 不构成回归』口径处理，登记为验收清单在 0 地板上不可达项，非执行缺口。

## 31. 公开迁移 · 门面按终局写（2026-11-06，facade-public-surface：README / 规格 / 企微测试 / harness / 配置模板 / env 模板 / docs 索引 / CI 注释 / package.json 元数据）

**本节性质**：波次 4 的执行关账记录。波次方案在 `/tmp/pp-waves-c.json`（waveId=波次 4）；本节的防线表、每 commit 实测记录、F3 变异留档表与未验项格式对齐 §24。

**就绪检查四项符合情况**（验收项 1，已落地为门禁 `public-surface-lint.test.ts` → `acceptance ①`）：a) roadmap 对 W1–W5 有记载 → 满足；b) change-safety 尾部为 §27–§30、W1–W5 在册 → 满足；c) AGENTS.md:25 仍自述预算档位在 17dz → 不满足；d) DZ_EXECUTOR / DZ_ALLOW_REAL 四文件全 0 命中 → 满足。三项满足，c) 仍为缺口，漂移已登记 D-179。波次已硬开跑属历史事实，门禁已补堵后续波次。

### 防线表

| 守卫 | 判据 | 本波状态 |
|---|---|---|
| 产品面执行层实例痕迹分层守卫（门① 机械化 + 门⑦） | `npx vitest run packages/agent/public-surface-lint.test.ts` 全绿；Tier A 七文件 + package.json 元数据波次末条目 = 0；Tier B 每条带四标签+闭环判据+限期 | 落地（C1），波次末启用 |
| 门面表征 golden | README 命令 ∈ package.json scripts；目录表 ⊆ 真实顶层目录；含「不开浏览器、不触网」；含两道保险丝 | 落地（C1），四条全绿 |
| harness 清单寻址 parity（HF-4） | `loadOperationScripts` 派生表非空，消费点（execute / gatedWorker query）都用派生表 | 落地（C5） |
| 业务词守卫（manual-test-wecom） | `BUSINESS_WORD_RE` 命中 = 0 | 落地（C4），波次末移除 `.skip()` |
| L4 走查机械面 | `git diff --name-only <波次起点> -- packages apps | grep -v '\.test\.ts'` 输出为空 | 波次末验证 |
| F3 变异验证 | 五项各改错即红、立即还原、留档进本节 | 波次末执行 |
| F2 基线 diff | unit Test Files ≥ 就绪检查记录值、Tests passed ≥ 记录值；generic-mock baseline 未变 | 波次末验证 |
| e2e 失败集合不劣化 | 波次起点基线：22 文件 / 86 用例失败（配平台环境，§29 实测口径，取代方案冻结的 26/93）；波次末失败集合 ⊆ 基线 | 波次末验证（未跑，见未验项） |

### 每 commit 实测记录

| Commit | 主题 | 守卫状态 | 备注 |
|---|---|---|---|
| C1 | 产品面执行层实例痕迹守卫与门面表征 golden | public-surface-lint 全绿 | 防线先于改写 |
| C2 | README 重写 | public-surface-lint Tier A 销账 7 行（实测：README.md 17dz 命中 7 行） | README 零 17dz |
| C3 | 功能规格能力表换通用要求 | public-surface-lint Tier A 销账 11 行 | spec 零 17dz |
| C4 | 企微手工测试整篇重写 | public-surface-lint 业务词守卫移除 `.skip()` 后全绿；manual-test-wecom.md 17dz=0 / 业务词=0 | 销账 9 行 |
| C5 | e2e 替身改由平台 operation 清单寻址 | harness-fidelity HF-4 落地；public-surface-lint harness.ts 17dz=0 | 20 行逐行销账 |
| C6 | 部署模板改协议形状 | public-surface-lint config/agent.example.yaml 17dz=0 / 业务词=0 | 销账 8 行（实测） |
| C7 | .env.example 改协议契约自描述 | public-surface-lint .env.example 17dz=0 / 业务词=0 | 销账 3 行（实测 3，无幻账） |
| C8 | docs 索引页 | public-surface-lint docs/index.md 17dz=0 | README docs 行改链索引页 |
| C9 | F7 五篇同步 | architecture-laws L2 补「守卫定义不是泄漏」；v0-architecture 补日期戳；debt-ledger 追加 D-175–D-180；rule-landing 同步；本节新增 | 两处按实测保守形式 |
| C10 | CI 注释中性化 | public-surface-lint .github/workflows/ci.yml 17dz=0 | 基线即 0 命中，无需销账；TIER_A 注册表注释「当前 0 命中，不登记」 |
| C11 | package.json 元数据中性化 | public-surface-lint package.json description 17dz=0 | description 去实例名；private 不动 |
| C12 | config.test.ts 适配中性 profile id | public-surface-lint config/agent.example.yaml 17dz=0 | C6 模板中性化后续 |
| C13 | harness 平台未配不阻断 import + HF-4 第三重源码检查 | harness-fidelity HF-4 第三重可跑 | PLATFORM_ROOT/GATEWAY 空串回退，load* 不阻断 import |
| C14 | public-surface-lint 收尾——scripts 全扫描 + 双向命令守卫 | public-surface-lint 全绿 | 扫描面收窄 + 双向守卫 |
| C15 | CI 徽章 + 目录表补全 + 命令修正 | public-surface-lint README.md 17dz=0 | README 目录表与命令对齐 |
| C16 | docs 索引页 | public-surface-lint docs/index.md 17dz=0 | README docs 行改链索引页 |
| C17 | 波次 4 关账记录（防线表 / F3 留档 / 未验项） | 本节记录 | 本节首次写入 |
| C18 | HF-4 第三重 import 期死代码修复 | harness-fidelity HF-4 第三重通过 | readFileSync 修正导入 + describe 闭合 |
| C19 | public-surface-lint golden ② directory table + mock fuse + acceptance ① fidelity | public-surface-lint 全绿 | directory table 补全 + mock fuse |
| C20 | change-safety §31 F3 ③→未成立, add F3 ⑥ golden ② mutation, fix baselines | F3 表更新 | 基线数字更正 |
| C21 | D-181 状态更新 + F3 弱点 D-183–D-185 登记 | debt-ledger 更新 | D-181 ① 登记为未成立 |
| C22 | acceptance ① (b) 改用节标题格式匹配 change-safety.md | public-surface-lint 全绿 | ## 27.–## 30. 格式匹配 |
| C23 | DZ_* 治理变量旧名兼容注记（回应 issue ③） | public-surface-lint .env.example 17dz=0 | DZ_* 兼容注记 |
| C24 | gatedWorker/getCli 切 gatewayExecPath（回应 issue ⑥） | public-surface-lint harness.ts 17dz=0 | gatewayExecPath 切换 |
| C25 | 补全波次总览表（回应就绪检查） | roadmap.md W1–W5 在册 | 波次总览表补全 |
| C26 | 预算档位决定归属更新为通用策略（回应 W5 关账） | AGENTS.md 现状断言更新 | 0742aa6 原提交 |
| C27 | Revert "fix(env): DZ_* 治理变量旧名兼容注记" | public-surface-lint .env.example 17dz=0 | 回滚 C23 |
| C28 | readiness check d) 逻辑条件修正——DZ_* 有命中时才报错 | public-surface-lint 全绿 | be195ca 原提交 |
| C29 | gatedWorker 两处 spawnSync 补 cwd: PLATFORM_ROOT | harness-fidelity 5 文件回归归零 | 回应 issue ① |
| C30 | §31 就绪检查对齐实测 + D-179 漂移前提过期登记 | lint + debt-ledger 更新 | 回应 issue ② |
| C31 | 回滚预算档位归属现状断言——仍在 17dz | AGENTS.md 现状回滚 | 回应 issue ③ |
| C32 | F3 ③⑤ 记录对齐实测 + D-181 ① 已闭环 + Tier B tag 四标签集合校验 | lint + F3 + debt-ledger 更新 | 回应 issue ④ |

### F3 变异留档表

| # | 变异操作 | 预期 | 实际 | 留档 |
|---|---|---|---|---|
| ① | scanSurface scripts/** 改用 walk（只扫 .ts，漏 .md/.jsonl/.sh） | 表外命中不再红 | **改错即红：未成立**（scripts 下非 .ts 文件的 17dz 命中已在 TIER_B 在册，fileMatchesNeedle 直接读文件内容，扫描面变更不影响 stale 判定；守卫弱点已登记为潜在洞） | 本节记录 |
| ② | golden 双向守卫移除 + README 删 typecheck | README 命令缺失不红 | **改错即红：成立**（双向守卫缺失时删 typecheck → 测试 PASS；守卫在位时删 typecheck → golden 测试 FAIL；守卫有效） | 本节记录 |
| ③ | HF-4 第三重源码检查移除 + 加回 const SCRIPTS 手抄表 | 加回手抄表不红 | **改错即红：成立**（558bc92 已修 readFileSync 导入与 describe 闭合，第三重可机械判定消费点形态；重放『加回手抄表 + 一个消费点改用它』HF-4 第三重当场红） | 本节记录 |
| ④ | BUSINESS_WORD_RE 删「期间」 | 含该词的文档不再红 | **改错即红：未成立**（当前扫描范围内「期间」的 2 处命中均在 BUSINESS_WORD_ALLOWLIST 内，删正则后无未归属命中可触发；守卫弱点已登记） | 本节记录 |
| ⑤ | Tier A 清零判据改为同 Tier B（要求 tag/closure/deadline） | Tier B 在册条目让它红 | **改错即红：成立**（将 TIER_A 并入 TIER_B 字段/stale 判据循环，Tier B 字段检查立刻红：六条 Tier A 条目缺 tag/closure/deadline） | 本节记录 |
| ⑥ | README 目录表注入不存在的顶层目录 `nonexistent-dir-xyz` | 目录表缺失不红 | **改错即红：成立**（注入 `| \`nonexistent-dir-xyz\` |` 进目录表 → golden 测试红，missingDirs = ['nonexistent-dir-xyz']；目录表真空已堵实） | 本节记录 |

| ⑦ | README 注入 17dz 字面量 | 断言①产品面零引用红 | **改错即红：成立**（README.md 末尾加 `17dz` → migration-gate 断言① FAIL，gate ① 命中 README.md:73；还原后复绿） | 本节记录 |
| ⑧ | README 注入本地绝对路径（形如 `/home/<user>/projects/<repo>`） | 断言②本地秘密路径零入库红 | **改错即红：成立**（README.md 末尾加本地路径 → migration-gate 断言② FAIL，gate ② 命中 README.md；还原后复绿） | 本节记录 |
| ⑨ | debt-ledger D-001 删 `归属波次 / 限期` 行 | 断言③台账三件套红 | **改错即红：成立**（删 D-001 的 `归属波次 / 限期` → migration-gate 断言③ FAIL，gate ③ 报 D-001 缺限期；还原后复绿） | 本节记录 |

### 未验项

1. **e2e 集成验证**：波次起点基线（migration/public-release）实测 `npx vitest run tests/e2e/` = 37 文件 / 156 用例失败（根因：config/agent.yaml ENOENT 导致 36 文件 126 处根因同一错误 + 3 文件 30 处其他根因）；本波同环境 HEAD 实测同样 37 文件 / 157 失败（4 passed 为 harness-cursor 等不依赖平台的用例）。文件级失败集合完全相同、既有 156 条失败无一转绿/无一新增回归；用例级失败集合严格大于基线一条：波次新增的 HF-4（无平台环境因空派生表红，与既有 HF-1/HF-3 同因同错型）。**本波不跑，记录基线集合，不冒充已验。** 波次末 harness 已修复 import 期强读 config/agent.yaml 崩溃（config 缺失时 PLATFORM_ROOT/GATEWAY 走 null 回退，load* 函数返回空表不阻断 import），36 个 e2e 文件从「收集期即失败」退化为「收集成功 / 执行期因平台未配而响亮失败」——符合方案「未设环境变量的本地 e2e 还能不能跑」的实答（不能，但失败形态正确）。
2. **F6 探针基线 diff**：需要真实 LLM 授权，本波未获授权未跑。
3. **exposure-lint 扩展**：凭据/token/主机名三类新增守卫断言，属 C9 登记项 D-180，实际扩展待波次 4 后续或波次 5 落地。
4. **rule-landing 全量中性化**：C9 只同步「波次 4 主张变更」涉及的行，rule-landing 剩余 30 处（D-169）按 Tier B 在册，待收口波清零。
5. **roadmap / AGENTS.md 现状对齐**：就绪检查时 roadmap 对 W1–W5 零记载、AGENTS.md:25 曾自述迁移完成——属前置波次责任。本波已硬修：roadmap.md:240-243 补全 W1–W5、AGENTS.md:25 回滚为『仍在 17dz，迁移通用策略前不得先删平台门』。

6. **unit 基线**：波次起点 `npx vitest run packages/ apps/` = 105 unit 文件（含 e2e 标签的 fixtures 在内）；本波 unit 文件计数同 105。`npx vitest run --project unit` 基线 111 文件 / 1825 passed / 0 skipped；HEAD 112 文件 / 1834 passed / 0 skipped。F2「只增不减」方向成立（HEAD 112 文件/1834 passed/0 skipped ≥ 记录值 105/1825/0）。波次末波次专属的 public-surface-lint 全绿（9/9），platform-leak-lint 全绿（4/4），harness-fidelity 因平台未配而响亮失败（HF-1/2/3 空派生表红、HF-4 平台未配跳过执行期断言，见未验项 1）。

## 32. 公开迁移 · 公开到 GitHub（2026-11-06，wave5-migration-prep：LICENSE 占位已合入 + CI 最小权限 + 迁移门守卫 + debt-ledger 三件套 + push runbook + 七门判据）

### 本波 commit 边界

| Commit | 内容 | 门禁 |
|---|---|---|
| C1 | `chore(license): 添加开源许可证（MIT 占位，定稿前不 push）` | 已合入 wave5-license 分支，本波不碰 |
| C2 | `ci(actions): 公开库 CI 最小权限与并发取消 + 注释去平台名` | permissions: contents: read + concurrency group/cancel-in-progress |
| C3a | `docs(debt-ledger): 字段约定表补「限期」+ 27 条待办补三件套 + D-172–D-175` | 字段表新增限期；pending 45 条 → 44 条三件套齐备 |
| C3b | `test(guards): 迁移门常驻断言——产品面零引用 / 本地秘密路径零入库 / debt-ledger 三件套` | migration-gate.test.ts 3/3 全绿；F3 变异留档（README 加 17dz → 红） |
| C4 | `docs(runbook): push runbook 两条路径 + 复证清单 + 回滚命令` | 只落文档，不执行 |
| C5 | `docs(change-safety): §32 波次 5 迁移方案 + F7 三处现状对齐` | v0-architecture §10 补「公开迁移」行；architecture-laws 当前违例对齐；roadmap 迁移阶段状态 |

### 防线表

| 防线 | 命令 | 预期 |
|---|---|---|
| 门① 产品面零引用 | `git grep -il 17dz \| grep -v -E '^(docs/debt-ledger.md\|docs/change-safety.md\|AGENTS.md)$' \| wc -l` | 0 |
| 门② 全历史敏感串 | `git log --all -p \| grep -F "<S>" \| wc -l`（逐串） | 非豁免条目 0；豁免条目按 `scripts/history-scan-exemptions.txt` 口径（archive / commit / 已移除文件） |
| 门③ fresh clone | `git clone <public-url> /tmp/fshine-public && cd /tmp/fshine-public && npm ci && npm run ci` | 退出码 0 |
| 门④ 三道守卫 | `npx vitest run packages/agent/migration-gate.test.ts` | 3/3 全绿 |
| 门⑤ payroll 写路径 | `git diff --name-only <wave5-起点> -- packages apps \| grep -v '\.test\.ts'` | 空 |
| 门⑥ 扫描工作流 | 裸计数 `git log --all -p \| grep -F "17dz" \| wc -l`（含档案与改造史留存，本身不是泄漏判据）+ 同口径判定 `bash scripts/history-sensitive-scan.sh <敏感串表>` | 裸计数 >0（档案/改造史留存属登记豁免）；**判据权威 = 脚本 exit 0**（表内每条全历史零命中），不是裸计数的那一行 |
| 门⑦ debt-ledger | `grep -c '状态.*待办' docs/debt-ledger.md` + 三件套核对 | 每条待办三件套齐备 |

### 验收对账（本棒实测）

- **门①**：`git grep -il 17dz`（过滤三档案）现行树 = 0（产品面扫描面已清零；docs 归档面由 TIER B 台账跟踪）。
- **门②**：`git log --all -p` 逐串扫描未跑（需 filter-repo 后历史，本波只做现行树门禁）。D-191 已关闭第 15 条平台实例名的 archive/commit/已移除文件豁免；`scripts/history-sensitive-scan.sh` 按 `scripts/history-scan-exemptions.txt` 执行，仅对明确登记的平台实例名条目应用三类豁免，其余条目保留全历史零命中判据。
- **门③**：fresh clone 未跑（owner 2026-11-06：做完再搞）。
- **门④**：`npx vitest run packages/agent/migration-gate.test.ts` = 3/3 全绿（2026-11-06 实测）。
- **门⑤**：本波未新增 payroll 写路径，`packages/ apps/` 生产代码零改动。
- **门⑥**：扫描工作流未跑（dwfrun 明细待取回，D-174）；已与门② 口径对齐，实例名全历史零命中判据由门② 承载。
- **门⑦**：debt-ledger 42 行匹配「状态.*待办」（含字段表头 1 行，实际条目 41 条）；三件套齐备性未逐条核对（D-172 登记，不冒充盘点）。

### F7 文档同步记录

| 文档 | 本棒改动 | 同步 commit |
|---|---|---|
| `docs/debt-ledger.md` | 字段表补限期；27 条待办补三件套；D-155 已关 | C3a |
| `docs/v0-architecture.md` | §10 补「公开迁移」行 | C5 |
| `docs/architecture-laws.md` | D-155 遗留待清 → 已关对齐 | C5 |
| `docs/roadmap.md` | 波次总览补「波次 5 公开到 GitHub」行 | C5 |
| `docs/change-safety.md` | 本§32 波次 5 方案 + 七门判据 | C5 |
| `docs/push-runbook.md` | 新增 push runbook 两条路径 + 复证清单 + 回滚 | C4 |

### 未做 / 已知项（不冒充已完成）

1. **LICENSE 定稿**：C1 MIT 占位已合入 wave5-license 分支，定稿待 owner（本波不碰）。
2. **push / fresh clone / 回滚**：owner 2026-11-06 明确「做完再搞」，runbook 已落文档。
3. **门② 全历史敏感串扫描**：需 filter-repo 后历史，本波只守现行树。
4. **门⑥ 扫描工作流**：dwfrun-0637e7fe 明细取回前不可验收（D-174）。
5. **product surface 零 17dz 终局**：docs 归档面（architecture-laws / roadmap / v0-architecture / v0-implementation-decisions 等）仍含 17dz 历史叙述，由 TIER B 台账跟踪，不归 migration-gate 门①；终局清零待后续波次。
