# CAP-01 · 落地记录（合并归档）

> 本文件把 CAP-01 从设计到落地的全部提交、读数、失败与遗留项放在一处，便于对照。
> 设计稿正文在 [`cap01-main-direct-execution.md`](cap01-main-direct-execution.md)（v8）。
> 记录原则：**只写脚本直跑或独立复核得到的读数**；实施员自述不作为通过依据。
> 命名说明：本记录如实保留当时的工具名 `run_task`；该工具其后改名为 `task_run`（工具族
> 统一为 `task_run`/`task_status`/`task_result`/`task_cancel`/`task_resume`），历史读数不改写。

## 1. 提交链

| 阶段 | 提交 | 内容 |
|---|---|---|
| 设计 | `4d6fbff` `b90d36c` | v8 设计稿 + owner 裁决（网络残余可接受/基础防护即可/交付只留事件/`run_js` 对业务用户开放） |
| S0 | `39d7265` `e0fb64c` | `exceljs` 依赖、`file_refs` 8 列表、run 目录布局、`run-js-executor`（Node 24 `--permission`、进程组 kill、流式截断、copy-on-register） |
| S1 | `4612faf` `b2b4b69` `e47fed0` | 入站查重先于附件分支、Main 接 `run_js`、清单注入、交付走主动投递 B、功能单测补齐 |
| S2 | `2e8403b` `7c0e0b5` | `file_refs.task_id`、`run_task.inputFiles`、Task 副本、Worker 接 `run_js`、执行层目录桥、回程登记 |
| 验收脚本 | `66d999d` `8f083aa` `ab3369d` `2fbea27` `a7fd508` `0801822` `9b6baf3` `a5891e2` | 真模型功能面、生命周期、格式矩阵、产物错误面、攻击加厚、故障注入、对抗与幂等、资源 |
| 修复轮 | `0d5bbd7` `1f77f66` `654d539` | 交付事件不得翻转结果；`run_js` 声明可用模块只有 `exceljs`；`run_task` 声明 `inputFiles`；清单给出脚本内路径；R7 f3 判据随修复更新 |
| 合并 1 | `3d76b93` | 上述全部合入 `arch/integration` |
| 收尾 | `6e988a0` `853106e` → 合并 `f1c20fd` | `queueCapacity` 0→16；入站附件 20MB；子进程堆 1024MB；内存墙话术与结构化事件；文档漂移修正 |

## 2. 门读数（脚本直跑）

| 节点 | tsc | 全量 vitest |
|---|---|---|
| S0 | 0 | 132 文件 / 1464 过 / 1 跳过 / 0 失败 |
| S1 | 0 | 137 文件 / 1498 过 / 1 跳过 |
| S2 | 0 | 143 文件 / 1548 过 / 1 跳过 |
| 修复后 | 0 | 145 文件 / 1563 过 / 1 跳过 |
| 收尾（20MB） | 0 | 1574 过 / 1 跳过 |

## 3. 真模型读数（`step-3.7-flash`）

- **S1 直做稳定性 N=6：6/6 全过**（用户结果与「不建 Task」两个口径分开计，均为 6/6）。修复前同样场景 3 次试验仅 1 次通过。
- **S3（委派 Worker）**：2 次通过、1 次红（Main 未带 `inputFiles`）。**未做 N 次**，结论不确定。
- 单回合耗时约 28 秒（8 次模型调用 + 7 次 `run_js`），其中脚本合计 2–3 秒。

## 4. 暴露并修掉的真实缺陷

| # | 缺陷 | 触发方式 |
|---|---|---|
| 1 | 交付成功但 `file_delivery` 事件写失败 → 用户被告知「未送达」→ 重试导致重复交付 | R7 故障注入 |
| 2 | `run_js` 未声明可用模块 → 模型写 `require("xlsx")`（未安装）→ 首调失败 → 转去委派并建 Task | R2 真模型 |
| 3 | `run_task` 未声明 `inputFiles` → 模型不带文件 → Worker 无输入 → 任务 `unexecuted` | R2 真模型 |
| 4 | `in/` 物化路径未告知 → 模型猜 `in/<fileId>` 无扩展名 → 6 次调用浪费 2 次 | R2 真模型 |
| 5 | `task_status`/`task_result` 被 `taskRunner` 门控 → 缺省装配下模型无任务查询工具 | owner 提问触发 |

## 5. 已知遗留（未修，如实登记）

| 项 | 位置/读数 |
|---|---|
| ~~`message_done` 日志写失败会翻转回合结果~~ | **已修**（`be56225`）：写失败只降级为观测事件 `message_done_log_write_failed`，`return result.reply` 始终执行 |
| ~~并发：`mainConcurrency=1` 全局串行~~ | **已改**：缺省前台并发 4、排队 16（`bcdf316`）；8 档另有实测（§11） |
| ~~磁盘只增不减~~ | **已补**：`runtime.fileRetentionDays` 缺省 30 天 + 显式执行器 `npm run cleanup:runs`（`b250d3f`）；只删 run 目录、不碰 `file_refs` |
| ~~Main 交付箱同 sha 不去重~~ | **已修**（`c89e689`）：投递层按 `(sha256, 文件名)` 去重，同名不同字节照常各发 |
| ~~权限模型 symlink 盲区~~ | **已收窄**（`1d0bc3b`）：spawn 前 `lstat` 六个布局目录、软链即拒跑；产物收集按 realpath 包含校验 |
| 网络未阻断 | 脚本可 `fetch` 外传 runDir / node_modules / 注入输入 |
| 内存 | 2GB Buffer 脚本 RSS 2116MB（`--max-old-space-size` 对 Buffer 无效）；10 万行 xlsx 峰值 396MB |
| 幂等只在进程内 | 跨重启不保证；渠道重投 = 新回合 = 再执行 |
| R7 f4 抖动 | burst 子进程未捕获 `SQLITE_BUSY`；f4 单独重跑 7/7 过 |
| ~~后台队列不受 16 约束~~ | **已补**（`9c21af9`）：底账 queued 行 < `queueCapacity` 才受理，满即确定性拒绝 |

## 6. 未验证

- 真实企业微信（`media_id` 上传、32MB、8 秒超时、附件目录断言）**一次没跑过**；
- 真实执行层（`operation list`、限流、`retry-after`、结果映射）——全为仓内 dummy；
- 多用户/群聊 MU-1～MU-10；S3 长跑与浸泡；
- 用户级黑盒 `npm run eval:user` 在合并后树上的基线（本轮已发起，结果另附）。

## 7. 本轮复核结论的两处失效（如实记录）

1. 收尾轮（20MB）复核员判 `未通过`，但其自列五条检查全过、门亦绿，且其 `gaps` 文本无法取回——本轮按独立复跑接受代码，**不把该复核视为通过证据**。
2. 验收轮五面并行写入导致 `tsc` 在落盘中途报 162 条错误（全在他人未完成文件），属并行写入的瞬时状态，非产品缺陷；最终落定仅 1 条（验收脚本自身类型错，已修）。

## 8. 判据口径变更（2026-11-17）

**变更项**：R2 S3 ④ `s3-no-row-data-in-params-or-transcript` 的扫描面。检查名不变。

**旧口径（收窄前）**：扫 Main + Worker 全部工具调用参数/结果与全部驱动回合输入/转录。S3 的设计路径是 Worker 经 `run_js` 读行数据（脚本读文件、模型只拿文件路径与执行结果），Worker 面读取行数据时就会出现销售额原值——**这是设计行为，不是泄漏**。旧口径把它计入命中，5 次 S3 的端到端读数因此为 **0/5**（每一次都被该检查判红，与用户可见结果是否正确无关）。

**新口径（收窄后）**：设计口径是**行数据不进 Main 上下文**，故只扫 Main 面——

- `call.agent === 'main'` 的工具调用参数与结果；
- `run.agent === 'main'` 的驱动输入（systemPrompt/messages/injections）与输出转录。

Worker 面命中数不丢弃，写进该检查的 detail 作信息（形如「worker 面命中 N 处，按设计不计入」），供人看、不判红。**Main 面覆盖下限 `>= 4` 保留**：Main 面过少 = 证据面缺失，检查判红，不许收窄成空扫描假绿。同一入口（`scripts/eval/cap01/r2-functional.ts --scenario s3`）在合并后的 integration 上
并行重跑 5 次（各自 `--out-dir`，模型 `workbuddy/deepseek-v4.1-flash`）：**S3 端到端 2/5**
（run1、run5 通过；run2/3/4 红在同一检查）。

**读数来历**：两次读数来自同一 S3 场景与同一 Oracle，差异仅在泄漏扫描面。旧口径 0/5 是「Worker 正常读数据被判成泄漏」的机械结果；新口径 **2/5** 是同一 S3 场景只按 Main 面判泄漏后的结果（5 次样本中 2 次 Main 面零泄漏；早期估的 3/5 是错记，实测 2/5）。

**旧读数保留不改写**：§3 的 S3 早期读数（2 次通过、1 次红，Main 未带 `inputFiles`）是旧工具名与旧口径时期的记录，原样保留；本节只追加口径变更后的读数与依据。

**本仓可重复验证**（零真实模型）：`scripts/eval/cap01/row-data-scan.test.ts` 覆盖「Worker 面命中不判红」「Main 面工具参数/转录命中仍判红」「只有 Worker 面时覆盖不足判红」；脚本化 S3 直跑 detail 实测为「已扫 4 个 Main 面（工具参数/结果 + 驱动输入/转录），24 个销售额原值零命中；worker 面命中 0 处，按设计不计入」。


## 9. 评测收口读数（2026-11-17）

被测模型除 R6 外均为 `workbuddy/deepseek-v4.1-flash`（本地端点）；R6 见 §10。判据未改，除 §8 记载的口径收窄。

| 面 | 读数 | 口径/来源 |
|---|---|---|
| S1 稳定性 N=6 | **6/6** | 6 次并行、各自 out-dir；`.runtime/eval-cap01-r2/s1n6-run1..6` |
| S2 交付失败面 N=5 | **5/5** | 四条断言全绿；`.runtime/eval-cap01-r2/s2n5-run1..5` |
| S3 端到端 N=5 | **2/5** | 新口径（只判 Main 面）；run2/3/4 是 Main 自己 `run_js` 读行数据 |
| R8 并发 4 档 | maxActive=4、queued=1、峰值 RSS 812MB | 脚本化，零模型 |
| R8 并发 8 档 | maxActive=8、queued=1、峰值 RSS 794MB | `--main-concurrency 8` |
| 全量门 | tsc=0；1595 passed / 1 skipped | `arch/integration` @ `4ba05c6` |

**S3 的 2/5 是模型行为，不是宿主缺陷**：三次红都是 `tool-result(main#N:run_js)` 与
`driver-run-transcript(main)` 命中销售额原值——Main 没有委派，而是自己跑 `run_js` 把明细
读进了自己的上下文。宿主此时没有强制手段阻止（`run_js` 对 Main 开放是 CAP-01 的设计），
所以「行数据不进 Main 上下文」目前是**模型自觉**，不是**宿主不变量**。

## 10. R6 Wave1 重跑（workbuddy/deepseek-v4.1-flash，并发 9）

`run6`：15 个会话全部跑完、**0 次重试/0 次服务端错误**（并发无关污染）。

| 指标 | 历史 step-3.7-flash | 本批 workbuddy |
|---|---|---|
| disposition | — | **13 `product_fault` / 2 `valid`** |
| 单回合模型调用超 4 次（H6.b 硬零） | 未报该形态 | **12/15 会话** |
| 空回复 | 6 次 | **60 个回合（8 会话）/ 61 条驱动事件** |
| 触 3M token 硬停 | — | **9/15 会话**（3.01–3.90M） |
| 跨 principal 隔离（H1） | 干净 | **干净**（1 次按预期拒绝、0 泄漏事实） |

结论：**该模型不适合作为 R6 类长会话的产品模型**——单回合调用数与空回复率都显著高于 step
基线；宿主侧的跨 principal 隔离不受影响。历史 step 基线的原始 artifact 在仓内未找到，
上表两列只并列、不混算。

## 11. owner 裁定落地（2026-11-17，按建议值执行）

| 裁定 | 落地 | 证据 |
|---|---|---|
| S3 端到端 2/5 接受为**模型能力包络**，不建宿主强制 | 不改代码；§8 口径保持（只判 Main 面） | §9 表：run2/3/4 是 Main 自己 `run_js` 读行数据 |
| 空回复催问条件**扩展**到「回合以工具结果/用户消息收尾」 | `packages/agent/src/pi-driver.ts` `shouldNudgeFinalReply`：assistant+stop 之外，末条是 `toolResult`/`user` 且无正文也催一次；`pi-driver-model-errors.test.ts` 用例同步（原「toolResult 不催」改为「催」） | R6 实测 61 次空回复里 59 次末条是 tool result/用户消息，旧条件一次都没催 |
| 磁盘保留期 **30 天** | `DEFAULT_RUNTIME_CONFIG.fileRetentionDays` 0 → 30；契约注释与判定层文档同步；`file-retention-policy.test.ts` 增加「29 天 keep / 超期 eligible」用例 | 判定层仍无执行器：`fileRetentionDecision` 纯逻辑、不删文件 |
| `mainConcurrency` **保持 4** | 不改默认值 | R6 的 9 个真实并发会话在同一进程内峰值 **632MB**（中位 457MB，CPU 均值 14%/峰值 25%）；但产品模型是 step-3.7-flash，其账号**并发上限 8**——8 个 Main 回合叠 Worker 会直接撞上限（实测 6 会话就出现过 `current: 9, limit: 8`）。4 = 上限的一半，留出 Worker 与重试余量 |

**并发上限**是当前真正约束用户等待的外部条件：`step_plan` 账号限制 8 并发，宿主开再多也只是把排队从进程内换到供应商侧。要再提并发，得先解决供应商配额。

## 12. 上线前补漏（2026-11-17，四条已合入 `f25dc49`）

| 分支 | 提交 | 改了什么 | 合后门 |
|---|---|---|---|
| `fix-diskexec` | `b250d3f` | run 目录保留期执行器：只处理仓内 `runs/run_<32hex>` 布局；逐层 `lstat` 不解软链（链接整目录跳过）；删除前复核 + 根内包含判定（带分隔符前缀防前缀碰撞）；dryRun 零删除；**不碰 `file_refs`**；入口是显式 `npm run cleanup:runs`，**不接 server 启动路径** | 1615 绿 |
| `fix-bqueue` | `9c21af9` | 后台受理上界：底账 queued 行 < `queueCapacity` 才受理，满即确定性拒绝（不改成阻塞排队） | 1619 绿 |
| `fix-chanmode` | `4dc42d5` | 渠道装配三档：`offline`（缺省，**不建立 WS 连接**）/ `shadow`（连但出站全 suppressed）/ `live`（现状）；档位来自 `channel.mode`，值域 fail-fast | 1632 绿 |
| `fix-symlink` | `1d0bc3b` | `run_js` 收窄：spawn 前对 `runDir`/`in`/`out`/`scratch`/`home`/`tmp` 逐个 `lstat`，软链或非目录 → fail closed（`run_js_layout_unsafe`，不执行）；产物收集跳过软链并做 realpath 包含校验 | 1640 绿 |

**守卫抓到的两个真问题**（都是新代码里的过渡词标识符，改的是数据不是守卫）：
`legacyDir`（`run-dir-cleanup.test.ts`）→ `oldDir`；`legacyLiteralLive` / `legacy`（`channel-mode.test.ts`）→ `previousAssembly` / `beforeChange`。

**合后复跑**：`npm run eval:cap01` 七面 **7/7**（`.runtime/eval-cap01-all/2026-11-17T05-41-11-641Z/`）；全量单测 1640 passed / 1 skipped；tsc=0。

### 12.1 复核员提示的第二个缺口（已复现并修复）

复核员对 `fix-symlink` 判 `safetyGap=有`，指向「树内条目软链」。我独立复现：

- 预植 `in/evil.txt → /etc/passwd`（布局项 `in/`、`out/` 等**都是真目录**，原校验通过），
  脚本 `readFileSync('in/evil.txt')` → **`READ_OK:1275`**，即 `--allow-fs-read=<runDir>`
  放行整个 run 目录，树内软链被跟随。
- 修复：布局项校验之后再扫整棵树（`readdirSync(withFileTypes)`，深度 ≤8、条目 ≤2000，
  超限同样拒跑），发现任何软链即 `RunJsLayoutUnsafeError{item:'nested',kind:'symlink'}`。
- **口径随之变化**：原用例「`out/x.xlsx` 软链 → 跳过收集、其余照常交付」被更强的
  **整轮 fail closed** 取代——因为「跳过收集」只挡交付，挡不住脚本把外部文件读进
  stdout/转录。原用例已改写为断言 fail closed（不是删用例、不是放宽）。
- 新增长期守卫：`packages/agent/run-js-layout-symlink.test.ts`（文件级软链、嵌套软链、
  正常目录回归三例）。

另一条 `fix-chanmode` 的 `safetyGap` 我逐条核查后**未能复现**：`offline` 下
`startChannelForMode` 直接返回且不调用 `channel.start`（`apps/server/channel-mode.ts:52-57`），
`main.ts` 自身不起 HTTP 监听（`channel.start` 是唯一连接入口），出站由适配器
`SilentShadowGate`（`packages/channel-wecom/src/adapter.ts:220`）统一收口。复核员当时判红的
另一半原因是全量测试红，而那是新用例里的过渡词标识符（已改名）。

## 13. 决策索引（2026-11-17）

> 本表只做索引，不重复裁定正文；逐项依据、影响面与未覆盖见 `docs/decision-log.md` §九十九。

| # | 条目 | 一句话裁定 | 本记录对应读数/证据 | decision-log |
|---|---|---|---|---|
| 1 | S3 端到端 2/5 | 接受为模型能力包络；判据只判 Main 面；旧 0/5 保留 | §8（口径）、§9（读数）、§11（裁定） | §九十九 表 #1 |
| 2 | 磁盘保留期与清理 | 缺省 30 天；`npm run cleanup:runs` 只删 run 目录、不碰 `file_refs`、`--dry-run` 零删除 | §11、§12（`b250d3f`） | §九十九 表 #2 |
| 3 | `mainConcurrency` | 保持 4；9 并发峰值 632MB、供应商并发上限 8 | §11 | §九十九 表 #3 |
| 4 | 空回复催问 | 扩到「工具结果/用户消息收尾」 | §11；`7806428` | §九十九 表 #4 |
| 5 | 渠道档位 | `offline` / `shadow` / `live`，缺省 `offline` | §12（`4dc42d5`） | §九十九 表 #5 |
| 6 | `run_js` 树内软链 | 整轮 fail-closed（含 `in/evil.txt → /etc/passwd` 实测） | §12、§12.1（`85a3b5b`） | §九十九 表 #6 |
| 7 | 附件交给执行层 | `fileParams` 单文件参数；输入恰好一个，输出宿主分配 `out/` | `docs/product/business-coverage.md:108`；`fab9e86` | §九十九 表 #7 |
| 8 | 跨会话续办 | 不做；保持 `(principalId, sessionId)` 隔离 | `docs/product/business-coverage.md:111`；`23ae585` | §九十九 表 #8 |
| 9 | Codex PR 复核 | 四轮缺陷：路径/取消/执行事实/超时+接线；第 4 批待合 | §12/§12.1；`d2efdb1`…`af01a20` | §九十九 §2 |

## 14. eval-real 判据改为「通过率门」（2026-11-17）

单个 trial 的通过/失败会随模型抖动：同一 head 上 E05/E08 实测过 PASS↔FAIL 往返。用「任一
单样本翻转 = 机械回归」当判据，任何概率性用例都会永久红，读数失去意义。

**预注册判据**（写在 `scripts/eval/eval-gate.mjs` 顶部，改它就是改判据，需单独提交）：

- PR：每例 **5 轮**，要求每例通过率 ≥ **0.5**（≥3/5）；任一样本率低于门槛 → job 失败。
- 完整性硬校验：**预期集合由调用方独立传入**（`--expect-cases E01..E12 --expect-trials 5`），不信摘要自述——漏跑后同步缩小声明也会被拒（实测：只含 E05 的摘要 + 完整预期 → `缺少用例` 拒绝）。
- 硬失败码：任何一次出现 `FAIL_PHANTOM_SUCCESS`（虚假成功）→ 直接失败，不允许被其它通过样本抵消。
- push 到 main：1 轮，只作信息面，不设门槛。

**判据定标依据**（当前 head `bba9a8e` 实测，N=5）：E05 = **4/5**（0.80）、E08 = **5/5**（1.00）。
E05（4/5）、E08（5/5）。门槛取 0.5（≥3/5）：高于最弱用例在 5 轮下的抖动下界，又低于真回归的塌陷区。
