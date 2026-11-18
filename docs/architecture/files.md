# 文件面：fileId、run_js、产物登记、保留期与回传

> 状态：现行。2026-11-18 核对（代码与本文冲突时以代码为准）；fileId 模型、`run_js`、per-run 目录、回程桥与 recalc 门均已实施；保留期只清 run 目录，`file_refs` 行与 `files/` 字节没有回收路径。
> 最后核对：2026-11-18（`path:line` 以现行代码为准；实施过程与被删来源在 git 历史）。
> 上游指针：`packages/agent/src/file-store.ts`（文件事实与字节落点）、`packages/agent/src/run-js-executor.ts`（受限执行）、`packages/agent/src/execution-runtime.ts`（工具面/清单/回程接线）、`packages/agent/src/task-file-bridge.ts`（执行层文件桥）。

**模型只认 fileId，真实路径由宿主派生；本地文件只有一个工具 `run_js`；产物登记看 `out/`；执行层回传只走「宿主分配路径 + 扫描」。**

## 1. fileId 模型：模型只见 id，路径由宿主派生

文件事实只有一张表 `file_refs`：`file_id / principal_id / session_id / name / sha256 / bytes / activated_at / created_at / task_id`，**没有 path 列**（`packages/core/src/task-store.ts:360-370`；表注释 `:193-195` 明说路径不可由 name 拼出）；全仓无第二张文件表。字节落点是派生值：`sessionDirOf` = `<workspace>/<principalHash16>/<sessionHash16>`（`packages/agent/src/file-store.ts:117`），`fileStoragePathOf` = `…/files/<fileId><safeExt>`（`:127`）；扩展名只取 `safeExtensionOf(name)`（`:109`），原名不参与拼路径；`fileId` 形状 `file_<32hex>`，本侧生成（`:326-328`），`runId` 拼路径前过形状守卫（`:114-122`）。

模型可见面只有 `fileId / name / bytes`（`TurnFileRef`，`packages/agent/src/execution-runtime.ts:630`）外加脚本内相对路径 `in/<fileId><safeExt>`：Main 清单 `renderFileManifest`（`:656`）、Worker 清单 `renderWorkerFileManifest`（`:722`）；清单与 `run_js` 参数不含宿主绝对路径。用户可见出口经 `stripServerPaths`（`:2102`；`packages/agent/src/server-paths.ts:34-40`），剥空且有文件 → 「文件已生成（见附件）」（`:631`、`:2107`）。

`run_js` 的 `inputs` 只收 fileId 数组（schema `packages/agent/src/execution-runtime.ts:227-240`）；scope/激活/TTL/字节的权威校验在 `fileStore.materializeInputs`（`packages/agent/src/file-store.ts:575-593`），越权/不存在/pending/过期/字节缺失收成同一句 `FILE_REF_UNAVAILABLE`（`:468-478`、`:585`），机械 reason 只进日志（防存在性 oracle）。入站附件先 pending（`activated_at IS NULL`），带文字的消息激活本会话 TTL 窗口内全部 pending（`:797-801`；接线 `apps/server/server.ts:477`、`:748`）。守卫：`packages/agent/file-store-layout.test.ts:36`（同输入同路径、name 不进路径）。

## 2. run_js：本地文件只有一个工具

没有 `read_file` / `write_file` / `list_dir` 家族；处理本地数据文件只有 `run_js`，且**只在装配方注入执行器时上工具面**（`packages/agent/src/execution-runtime.ts:2036`；Worker 面 `:1653`）。平台/SaaS 副作用另走 `execute_operation`（`:315`）。参数面只有 `code` + `inputs`，没有 `deliver`、没有 `timeoutMs`（schema `:227-240`；说明 `:207-212`）：产物写 `out/` 即本回合末交付，超时/上限是宿主常量（§3）。

本回合幂等：进程内 memo key = `turnNo + sha256(code) + sorted(inputs)`（`:1252-1253`），同键命中不重跑，跨重启不保证（注释 `:1229-1236`）。内存墙是可确定事实：OOM/信号退出 → 固定话术 `RUN_JS_MEMORY_EXIT_MESSAGE`（`:269`），判据 `runJsMemoryExitOf`（`:292-301`），出口处同一句覆盖模型自由文本（`:2106-2107`）。守卫：`packages/agent/runtime-run-js.test.ts:205`（未注入不注册、直调 fail-closed）、`:224`（产物进 `TurnResult.files`）、`apps/server/server-cap01-memory-wall.test.ts`。

## 3. per-run 目录：一次调用一个，不共享

布局 `<root>/<principalHash16>/<sessionHash16>/runs/<runId>/{in,out,scratch,home,tmp}`，`runId = run_<32hex>`（`packages/agent/src/run-js-executor.ts:8`、`:277-282`）。子进程权限由宿主 argv 决定，不靠提示词：`--permission` + `--allow-fs-read=<runDir>` + `--allow-fs-read=<node_modules>` + `--allow-fs-write=<out>` / `<scratch>`（`:355-366`）；`HOME`/`TMPDIR` 指向 run 下空目录，env 走白名单重建（`:371-376`）。布局校验三道（`:316`、`:330`、`:335`）；**树内任意条目是软链就整轮拒跑**（`:197-221`；判据与威胁模型 `packages/agent/src/run-js-layout.ts:5-18`）。拒跑语义：不建目录、不物化、不写 `run.cjs`、不 spawn、零产物、零 `file_refs`（`:284-300`；`RunJsLayoutUnsafeError` `packages/agent/src/run-js-layout.ts:43-48`）。上限写死：超时 120s、stdout/stderr 各 64KiB、单产物 50MB、单次 20 份、V8 堆 1024MB（`packages/agent/src/run-js-executor.ts:60-68`）；超时/中止 `kill(-pid, SIGKILL)` 杀整进程组（`:144-150`）。守卫：`packages/agent/run-js-layout-symlink.test.ts:66`、`:82`、`:93`。

## 4. 产物登记：`out/` 就是交付箱

无论 exitCode 都扫 `out/`（`packages/agent/src/run-js-executor.ts:418` → `fileStore.registerOutputsFromOut`），超时/失败前写下的产物照样登记交付（`scripts/eval/cap01/r2c-artifacts.ts:94`）。走查规则：symlink 不收不递归；候选 realpath 必须仍在 runDir 真实路径内；候选按 relPath 全排序（`packages/agent/src/file-store.ts:356-393`），因此 `count_limit` 截尾可复现。fd 级复检：`O_NOFOLLOW` 打开、必须普通文件、`nlink === 1`、uid 属本进程、size ≤ 上限（`:659-686`）；拒收记机械 reason（`:172-179`）。

登记 = copy-on-register：同一 fd 流式读 → sha256 + 落到新 fileId 存储位；超限删半成品、不登记半份（`:402-431`）。Main 面每次登记新 fileId（`:686-694`）；任务面按 **(sha256, name)** 在任务产物池去重、复用旧 fileId（`:484-488`、`:718-727`——只按 sha 复用会把同字节不同名文件并成一份）。登记事实 `{fileId,name,bytes}` 进 `TurnResult.files`（`packages/agent/src/execution-runtime.ts:630`）；字节由投递面按 fileId 到派生位现读（`apps/server/server.ts:532`），runtime 不持路径。守卫：`packages/agent/run-js-executor.test.ts:126`、`:302`、`:365`；`packages/agent/runtime-worker-run-js.test.ts:391`。

## 5. 保留期：可读性 TTL 与磁盘保留是两层

**可读性 TTL = 24h**：`activated_at` 既可读起点也是 TTL 起点，过期即 `FILE_REF_UNAVAILABLE`；写死 `FILE_REF_TTL_MS`（`packages/agent/src/file-store.ts:310`、`:476`），不是配置键。**磁盘保留期缺省 30 天**：`runtime.fileRetentionDays`（`packages/agent/src/resource-policy.ts:155`、`:189`），`fileRetentionDecision` 只做纯判定，`0` = 永不清理（`:239-251`）。执行器只删自己形状的 run 目录 `runs/run_<32hex>`，逐层 `lstat` 不解软链，删除前复核 + 根内包含判定；**不删 `file_refs` 行、不碰 `files/` 登记字节**（`packages/agent/src/run-dir-cleanup.ts:10-22`、`:39`）。

入口只有两个：显式 `npm run cleanup:runs`（`package.json:14`；`scripts/cleanup-runs.ts`），或 server 启动时 `runtime.fileRetentionSweepOnStart=true`（缺省 false，`packages/agent/src/resource-policy.ts:191`；接线 `apps/server/main.ts:74`）。**现行行为（别读成有 GC）**：`file_refs` API 只有 `insertFileRef`/`listFileRefs`/`activatePendingFileRefs`（`packages/core/src/task-store.ts:283-301`），全仓无 `DELETE FROM file_refs`——过期只剥夺可读性，行与 `files/` 字节不回收，30 天到期删的只是 run 目录。守卫：`packages/agent/file-retention-policy.test.ts:48`、`scripts/cleanup-runs.test.ts:24`。

## 6. 执行层回传文件：唯一通道是「宿主分配路径 + 扫描」

- **出站**：桥只替换装配方**声明**的目录参数（`--input-dir` 等）或单文件参数，把任务文件物化到 `<platformRoot>/tmp/task_<id>/in/`；未声明即零翻译、零物化（`packages/agent/src/task-file-bridge.ts:9-25`、`:165-209`）。不遍历 args 猜类型：不引入 `kind:"file"`、不新增契约字段；`type` 只作展示（`packages/contracts/src/execution-contract.ts:47`），桥只按声明的参数名替换（`packages/agent/src/task-file-bridge.ts:12-15`）。
- 单文件输入必须**恰好 1 个**任务文件，多或少都 fail-closed（`:184-192`）；单文件输出由宿主分配 `out/exec-output.json`（`:199-203`）。
- **回程**：`data.files[...]` 在 **runtime 出口**经 `registerReturnedFiles` 登记成新 fileId，`path`/内联 base64 替换掉后才进转录与落定（`packages/agent/src/task-file-bridge.ts:214-260`；调用点 `packages/agent/src/execution-runtime.ts:1326`），**不在适配器登记**（`:1307-1314`）。回程 path 必须是任务暂存目录内的绝对路径，父目录软链按实际打开 fd 判定（`packages/agent/src/file-store.ts:741-762`）。
- **兜底扫描**：任务收尾（completed/failed/unexecuted 一律）扫 `<taskDir>/out/` 全量登记，与回程同池（sha256 + name）去重——执行层写了产物但没带回 `data.files` 时不丢（`packages/agent/src/task-file-bridge.ts:262-275`；`packages/agent/src/execution-runtime.ts:1898`）。
- 守卫：`packages/agent/task-file-bridge.test.ts:155`、`:194`、`:227`、`:256`、`:312`。

## 7. 表格/公式验收归 Main（不是执行层）

执行层交付的是**无公式数据**；公式工程只归 Main 的 `recalc_xlsx`（固化在 `packages/agent/recalc-delivery-gate.test.ts:5-11`），因此它只上 Main 工具面、仅引擎可用时上（`packages/agent/src/execution-runtime.ts:243-247`、`:1976-1978`），Worker 面（`:1854`）永不注入。投递门**完全报告驱动、不解析 xlsx**：有报告（sha 匹配）→ `pass` 放行 / `fail` 拦截；无报告 → 放行（`packages/agent/src/recalc-xlsx-executor.ts:815-838`）。报告只从 runDir **根**的 `.recalc-report.json` 读（宿主独占；`out/` 下同名文件不认）：写入 `:468-469`，读取 `:781-784`；重算失败也落 fail 报告（`:523-547`）。绑定**只按 sha256**，name 只是展示字段（`:823`）；⚠️ 注释 `:810-812` 与 `packages/agent/recalc-delivery-gate.test.ts:7` 仍写「name + sha256 双匹配」，以 `:823` 与用例 `:75` 为准。识别不出公式形态 → `unsupported_formula`，不盖 pass 章、不导出，交用户确认（`:63`、`:382-383`）。挂点 `applyRecalcDeliveryGate`（`apps/server/server.ts:542-546`）；未注入执行器 = 门不启用、逐字节原样返回（`packages/agent/src/recalc-xlsx-executor.ts:845-847`）。

- **已知残余（登记不修）**：待投递文件若在宿主内被无害重编码（LO/exceljs 读写、压缩级别/时间戳变化），字节 sha 失配 → 按 `no_report` 放行；重编码后的字节视为执行层新产物（`docs/history/decision-log-part06-2026-11_undated.md:355`）。
- 混合批次部分被拦：回复必须附「部分表格未通过校验，其余已发送」（`apps/server/server.ts:165`、`:607` 的 `RECALC_DELIVERY_PARTIAL_NOTE`）；引擎开销计入资源账 `budget.consume({calls:1,ms})` + `recalc_cost` 事件（只进日志，`packages/agent/src/execution-runtime.ts:2072`、`apps/server/server.ts:398`）。
- 守卫：`packages/agent/recalc-delivery-gate.test.ts:56`、`:75`、`:159`、`:194`；`packages/agent/recalc-xlsx.test.ts:830`。

## 8. Worker 系统提示的来源约束

Worker 的「可信工作目录」**只能取装配层 `profile.root`**，禁止取模型输出或用户消息；系统提示只是纵深防御，不是安全边界（`docs/history/decision-log-part03-2026-11.md:292`；实现 `packages/agent/src/execution-runtime.ts:382-395`，装配 `scripts/ask-runtime.ts:461`）。
