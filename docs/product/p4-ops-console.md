# P4 切片报告：运营后台 v1（`npm run ops` 只读静态快照）

> 范围（一句话）：运营人员**不跑细命令**即可掌握系统运行状况——一条命令生成一张本地自包含 HTML 页面：统计（任务总数、按状态计数）、最近任务表（最新在前，上限 20）、失败与未执行清单（机械原因原文）、如实限制标注与指针、生成时间；纯读底账、静态生成、可离线打开。
> 分支/提交：`arch/p4-ops`（基线 `arch/integration` @ `0bb08448ea553705285188a10e2d7292bc98c13e`）；实现提交 `8bec07098a9f19227882970fc2a643bb751f8053`（未 push、未合并）；本报告与 decision-log §二十一 登记见本次 docs 提交。
> 运行面：真实模型 `LLM_MODEL=step-3.7-flash` + 仓内 dummy 执行层（不触真实平台、不触网）。恶意文本任务为机械夹具（不经模型；更全注入向量由单测覆盖）。
> 证据根：`.runtime/product-p4/`（gitignored；各条证据指针相对仓根）。

## 一、目标

- 用户任务：运营人员不跑细命令，用一条命令（`npm run ops`）得到一张本地页面，掌握任务运行状况（多少任务、都是什么状态、哪些失败、为什么失败）。
- 硬约束：纯读 + 静态生成（只读消费既有 SQLite，沿用 P1 只读打开；不改 schema 与写语义；不新增依赖——无框架/CDN/网络，inline CSS，可离线打开）；HTML 动态文本一律实体转义（安全不变式，须有恶意文本用例与绊线）；R1 冻结集与 exploration 零改动；执行层只用仓内 dummy。

## 二、结果

**命令面**：`npm run ops -- [--out <dir>] [--config=<path>]`；缺省输出 `<仓根>/.runtime/ops/index.html`；显式相对目录按调用点目录（INIT_CWD→cwd），绝对路径原样；退出码 0 成功 / 2 用法与路径前置 / 1 读库与 IO。stdout 三行：快照路径、统计行（`任务：共 N 条（已完成 a / 失败 b / 未执行 c / 进行中 d）`）、底账行（复用 tasks 的只读行口径）。

**页面结构**：生成时间（本机时区）与底账只读行 → 统计（任务总数 + 已完成/失败/未执行/进行中，未知存储状态进「其他」）→ 最近任务（任务 ID/创建时间/状态/摘要；最新在前；上限 20）→ 失败与未执行清单（任务 ID/创建时间/机械原因原文；上限 50，截断标注「共 M 条」）→ 限制与指针（Main 最终回复不落库、执行步骤无时间戳、全 principal 视图、running 无自愈、WAL 旁路、质量与覆盖报告文本指针等，沿用 P1/P2/P3 已登记口径）。inline CSS、无脚本、无外链、CSP meta、可离线打开。

**--out 语义（仅覆盖自身产物）**：产物恒为且仅为 `<dir>/index.html`；目录缺失自动创建；同名普通文件幂等覆盖；目录占位 / index.html 为目录或符号链接（含悬空）→ exit 2 拒绝且不跟随、目标不动；目录内其它文件不读不删不动。

**转义方案（安全不变式）**：统一 `escapeHtml`（`&`→`&amp;`、`<`→`&lt;`、`>`→`&gt;`、`"`→`&quot;`、`'`→`&#39;`，`&` 最先）；一切动态文本进模板前必经此函数；动态值不进属性上下文、无内联事件、全页无 script。实现阶段反向绊线（先红后恢复复绿）：去掉摘要字段转义 → 恶意用例红；翻转排序比较器 → 排序/清单用例红。

**复用（不复制分叉）**：时间格式 / 摘要 / 状态词 / 原因行 / 底账行全部 import 自 `scripts/tasks.ts` 既有导出；最近任务序与 `npm run tasks` 列表口径由对账测试钉住；为此在 tasks.ts 末尾加 `import.meta.main` 守卫（唯一超出点名改动面的偏离，见 §四）。

**验收标准逐条（勾选 + 证据指针）**

- [x] A1 一条命令出页面（缺省目录）：`npm run ops` exit 0，stdout 三行 —— `ops-scenario1.log`、`ops-scenario2.log`。
- [x] A2 页面头：生成时间（本机时区）+ 底账只读行 —— `verify-scenario1.out` 摘录。
- [x] A3 统计与注册表逐项一致（总数/四态/恒等式）—— `verify-scenario1.out`、`verify-scenario2.out`（FAILED=0）。
- [x] A4 最近任务：最新在前、列=id/时间/状态/摘要、上限 20、同刻 taskId 降序 —— 对账脚本序列 PASS + 单测。
- [x] A5 失败与未执行清单：收录 failed+unexecuted、机械原因与底账 `taskReasonLine` 逐字一致、最新在前、截断标注 —— 对账脚本 PASS + 单测。
- [x] A6 只读：两轮生成前后主库 sha256 不变（`1e18f373…`、`8eb0a755…`）；缺库空态不创建库 —— `readonly-proof.txt` + 单测。
- [x] A7 空态两型（0 条任务库 / 缺库）：统计全 0、空态文案、缺库横幅明示「未创建」—— 单测（验收轮复跑）+ 实现轮冒烟（`.runtime/p4/`）。
- [x] A8 恶意文本转义实测（机械夹具）：页面单元格为转义实体、无活动标签；原始载荷 0 次出现 —— `ops-page-scenario2.html`、`page-selfcontained-greps.txt`、`seed-xss.log`；更全向量（`img src=x onerror` / `onmouseover` / `svg` / 属性引号破坏）见 `scripts/ops.test.ts` 恶意全字段用例。
- [x] A9 自包含离线：12 项禁用 token grep 全 0 + inline `<style>` 在场 —— `page-selfcontained-greps.txt`。
- [x] A10 `--out <dir>`：自定义目录生成 `<dir>/index.html`；重复生成幂等覆盖且旁路文件不动 —— 单测 + 实现轮冒烟。
- [x] A11 覆盖边界拒绝：目录占位 / index.html 为目录或符号链接（含悬空）/ `--out` 指向普通文件 —— exit 2 且目标不动 —— 单测 + e2e。
- [x] A12 幂等/确定性：同输入同字节（注入时钟单测）；实跑同路径二次生成 exit 0 且页面反映当前库（3 条→4 条）—— `ops-scenario2.log`。
- [x] A13 用法面：未知参数/缺值/位置参数 exit 2；`--config`/`DB_PATH` 与 tasks 同源解析 —— 单测 + e2e。
- [x] A14 门与冻结：`npx tsc --noEmit` exit 0；`npx vitest run --project unit` 33 文件/305 例全过（验收轮复跑）；冻结面零改动 —— `checks-tsc.log`、`checks-unit.log`。
- [x] A15 用户级演示（真实模型）：beta→已完成、faulty-one→失败、零执行探针→未执行，页面事实与注册表逐项核对全 PASS —— §三 S1。

## 三、验证证据

### S1 三态任务与页面核对（真实模型 step-3.7-flash）

- completed（逐字命令）：`LLM_MODEL=step-3.7-flash npm run ask -- "帮我查一下 beta 集合的数据。"` → `taskId=task_a95f895a-9ae9-4fc5-a8cd-31a471c9d4ae`、`委派=是`、`结构化执行=1 次（完成 1）`。证据：`ask-completed.log`。
- failed（逐字命令）：`LLM_MODEL=step-3.7-flash npm run ask -- "帮我查一下 faulty-one 集合的数据。"` → `taskId=task_6454e9ea-bd3d-488f-bf72-7f185d463d0d`、`结构化执行=1 次（完成 0）`、`COLLECTION_FAULT`。证据：`ask-failed.log`。
- unexecuted（零执行探针；如实登记一次未中）：首次 `LLM_MODEL=step-3.7-flash npm run ask -- "执行层现在能帮我查哪些数据？"` → `委派=否`、无任务记录（`ask-unexecuted-attempt1.log`）；复跑同句 → `委派=是`、`taskId=task_851d86ab-943b-44a9-8509-9ed486285123`、`结构化执行=0 次` → 未执行任务；ask exit 1 为其自身「无结构化执行」门（P1 同口径，如实记录、不掩盖）。证据：`ask-unexecuted.log`。
- 注册表事实（只读导出）：3 条 = completed 1 / failed 1 / unexecuted 1；失败原因 = `judgeReportedTask` 合成文本。证据：`registry-scenario1.json`。
- 页面与注册表逐项核对：统计（3; 1/1/1/0）、最近任务 id 序列（最新在前）、每行四列、失败清单选择器与原因逐字、自包含 grep —— 全 PASS（FAILED=0）。证据：`verify-scenario1.out`。
- 页面摘录（关键行）：
  - `生成时间：2026-11-14 02:25（本机时区）`；`任务底账：.runtime/state.db（只读）`。
  - 统计：`任务总数 3 / 已完成 1 / 失败 1 / 未执行 1 / 进行中 0`。
  - 最近任务行（failed）：`<tr><td>task_6454e9ea-…</td><td>2026-11-14 02:24</td><td>失败</td><td>查询 faulty-one 集合的数据内容…</td></tr>`。
  - 失败清单：`失败原因：执行层未成功：dummy.query 返回 failed：Collection faulty-one cannot be read in its current state`；`未执行原因：未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。`

### S2 恶意文本转义（机械夹具）

- 夹具（逐字载荷）：`"><script>alert(1)</script><iframe>'&` → `task_p4_xss`（completed，1 次 dummy 执行；不经模型）。证据：`seed-xss.log`。
- 重新生成：`npm run ops` → `任务：共 4 条（已完成 2 / 失败 1 / 未执行 1 / 进行中 0）`，exit 0；对账 FAILED=0。证据：`ops-scenario2.log`、`verify-scenario2.out`。
- 转义核验：页面该行 = `<tr><td>task_p4_xss</td>…<td>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;iframe&gt;&#39;&amp;</td></tr>`；原始载荷出现 0 次、转义实体出现 1 次。证据：`ops-page-scenario2.html`、`page-selfcontained-greps.txt`。
- 整页无活动面：`<script` / `<img` / `<iframe` / `<link` / `onerror=` / `onload=` / `javascript:` 全 0。

### 只读证明

`.runtime/product-p4/readonly-proof.txt`：场景 1 生成前后 `1e18f373…` 不变；场景 2 生成前后 `8eb0a755…` 不变。旁路口径沿用 P1（WAL 库只读打开可出现 `-shm` 旁路；本轮 `-wal` 0 字节；不删除旁路以免干扰活跃写者）。

### 自包含 grep

`page-selfcontained-greps.txt`：`<script`/`<img`/`<iframe`/`<link`/`http://`/`https://`/`url(`/`@import`/`src=`/`onerror=`/`onload=`/`javascript:` 全 0 + inline `<style>` 在场。

### 回归（同模型 step-3.7-flash）

- `LLM_MODEL=step-3.7-flash npm run eval:user -- --case E06 --trials 3 --out-dir .runtime/product-p4/regression-e06` → 3/3 PASS、exit 0（summary counts：PASS 3 / FAIL 0）。证据：`eval-e06.log`、`regression-e06/summary.json`；模型身份 `regression-e06/runs/E06/trial-1/model.json`（main=worker=step-3.7-flash）。
- E12 ×3 同法 → 3/3 PASS、exit 0（PASS 3 / FAIL 0）。证据：`eval-e12.log`、`regression-e12/summary.json`。
- tasks 抽样不变（旧树 `arch/integration` @ `0bb0844` vs 新树，同一 DB 副本、同一输出路径）：列表 / 详情（failed）/ 详情（恶意夹具）/ `--out` stdout 全 IDENTICAL；交付件 sha256 `2e19f822…` 一致。证据：`parity-list-*.log`、`parity-detail-*.log`、`parity-out-*.log`、`parity-deliverable.md`。

### 确定性门（本报告提交前复跑）

- `npx tsc --noEmit` → exit 0（`checks-tsc.log`）。
- `npx vitest run --project unit` → Test Files 33 passed / Tests 305 passed（含 P4 新增 24 例与 2 组反向绊线；`checks-unit.log`）。

### 冻结面

- 实现提交 diff：`README.md`、`package.json`、`scripts/tasks.ts`（守卫）、`scripts/ops.ts`、`scripts/ops.test.ts`；无 `scripts/eval/convergence-r1/**`、`scripts/eval/exploration/**`、`packages/agent/task-status-boundary.test.ts`。

## 四、保留内容

- **未改动**：SQLite schema（tasks/executions 两表原样）、写语义、`scripts/ask.ts`、`apps/server/**`、R1 冻结集与 exploration；无新依赖。
- **新增最小面**：`scripts/ops.ts`（生成器 + CLI 参数）+ `scripts/ops.test.ts`（24 例）；`package.json` 增 `ops` script；README 一行用法。
- **偏离登记（唯一）**：`scripts/tasks.ts` 末尾加 `import.meta.main` 守卫（4 行）：原先 `await main()` 无条件执行，任何 import 都会触发 CLI 主体（打印任务列表/用法并可能置 exitCode），无法复用其导出函数；守卫使「被 import 零副作用、直接运行行为不变」。行为中立性由 tasks/tasks-redo 既有用例全绿 + 本报告 tasks 抽样逐字节一致 + `scripts/ops.test.ts` 的 import 探针钉住。

## 五、剩余问题

1. 缺省输出目录（`.runtime/ops/`）的 CLI 覆盖为「实跑冒烟 + 单测默认值」，未做 spawn 级 e2e（同 P2 §五.3 的 cwd/tsx 限制，不为测试改运行条件）。
2. 大库性能未压测：读路径复用既有 `registry.list()`（每任务再查 executions 的 N+1），展示条数封顶（20/50）但计数全量；如需大库优化属后续切片。
3. 「失败清单」含「未执行」（设计裁定：两态均带机械原因）；未知存储状态 fail-open 显示「未知状态（原值）」并计「其他」。
4. running 实时形态与损坏库路径仅单测覆盖（未做实时 e2e）。
5. 页面无 JS、无自动刷新、无过滤交互（静态快照设计；刷新=重跑命令）。
6. 验收恶意载荷为「grep 干净版」（不含 `src=`/`onerror=` 子串）；更全注入向量由单测恶意全字段用例覆盖。

## 六、需要你决定

1. `scripts/tasks.ts` 的 import 守卫是否接受？若不接受，替代只有抽共享模块（改动面更大）或复制语义（被禁）。
2. 「失败与未执行清单」是否保持包含「未执行」？
3. 质量报告文本指针目标（当前 `scripts/eval/exploration/quality-report-v1.md` + `npm run eval:user`）是否合意？
4. 页面标题与文案（当前「fshine-agent 运营快照」）是否定稿。
