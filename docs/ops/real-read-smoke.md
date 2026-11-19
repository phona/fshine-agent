# 真实执行层只读冒烟（准备档 · 判据清单）

> 状态：现行（准备档；**未授权接入**——本档不连真实层、不落凭据、不碰真实数据；跑不跑由 owner 一句话决定）。
> 最后核对：2026-11-19（`path:line` 以现行代码为准）。
> 上游指针：`docs/product/real-read-readiness.md`（接入设计与安全评审）、`docs/architecture/contract.md`（契约语义面）、`scripts/eval/real/smoke.ts`（本档配套脚本）。

本档把「真实层要验什么、每一步的期望读数、什么算通过/不算、什么情况下必须中止、证据落到哪里」
写成可照抄的表。配套脚本 `scripts/eval/real/smoke.ts` 逐步打印与下表逐项对应的机械读数；
本档不替代脚本，也不预授任何真实连接行为（授权门见 `docs/product/real-read-readiness.md`）。

真实执行层 = **17dz**（兄弟仓 `17dz-platform`，不在本 worktree；网关 `bin/17dz`）。历史事实可考于
`docs/history/change-safety-part01-2026-09_2026-10_2026-11_undated.md`（`bin/17dz` 调用形态）与
`docs/decisions/debt.md` §八（长任务/幂等「17dz 未验」）。**operation 清单原记于已删文档；
以执行层 `operation list --json` 为准**——本档与脚本都不写死清单（脚本按执行层自报派生只读集合）。

## 0. 怎么一键跑

```sh
# 干跑（缺省）：只打印将要执行的步骤与判定，不发任何调用
node --import tsx scripts/eval/real/smoke.ts

# 真跑（owner 授权后）：先读执行层自报 operation 清单，确认 access=read 才只调只读 operation
node --import tsx scripts/eval/real/smoke.ts --run

# 指定只读 operation 与参数（缺省自动挑一个 access=read 的 op）
node --import tsx scripts/eval/real/smoke.ts --run --op=<只读op> --arg <k>=<v>
```

配置源复用仓内既有加载链（`explicitConfigFrom` + `loadConfig`）：显式 `--config=<path>` /
`AGENT_CONFIG_PATH` 优先；缺省物化仓内 dummy 夹具（`config/agent.fixture.yaml`）。**真跑真实层
必须显式指向部署配置**（其 `contextProfiles.<id>.root` 指向 17dz 仓、`gateway: bin/17dz`）。

## 1. 脚本用法与安全硬闸

| 参数 | 含义 |
| --- | --- |
| （缺省） | 干跑：只打印步骤与判定，零调用 |
| `--run` | 真跑：先 discovery，确认 `access=read` 后只调只读 operation |
| `--config=<path>` | 部署配置（复用既有加载链） |
| `--op=<name>` | 指定要探的只读 operation（缺省自动选一个 `access=read`） |
| `--arg <k>=<v>` | 传给该 operation 的参数（可重复） |
| `--out=<path>` | 证据落点（缺省 `.runtime/real-smoke/readings.json`） |

**安全硬闸（唯一的执行入口收口点）**：脚本对每一次即将发起的 operation 调用先查
执行层自报清单的 `access`，凡 `access != read`（含未声明 / 未登记）**当场抛出 SmokeAbort 并中止**
（exit 2），打印中止原因——不依赖模型或人记得。硬闸实现见 `scripts/eval/real/smoke.ts:135`。
脚本**不存在 `--allow-write`**：任何想让它调写操作的人都必须显式改代码，改了也仍被这道闸挡下。

**只读纪律**：脚本启动的第一件事就是 `operation list --json`（经装配同源的 `resolveExecutionFace`，
`scripts/ask-runtime.ts:502`，只读集合由执行层 `access=read` 派生）。执行子进程 env 走宿主既有
白名单（`packages/agent/src/worker-env.ts:27`，仅 PATH/HOME/TMPDIR），**不落任何真实凭据**；
所有打印经 server-paths 剥离绝对路径与内部标记，绝不打印环境变量值。

## 2. 逐步读数与判定（可照抄）

脚本每步打印同样结构：`[PASS|FAIL|SKIP] 标题` + `real_smoke_step` 机器行。对照下表逐条读。

| 步骤 | 动作 | 期望读数 | 通过判据（＝通过） | 不算数 | 证据字段 |
| --- | --- | --- | --- | --- | --- |
| S0 配置与身份 | 读部署配置（宿主侧，零调用） | 恰好 1 个 profile 且声明 gateway | 单 profile + gateway 存在 | 多 profile / 缺 gateway | `config` |
| S1 群主体 | 读配置派生群主体与角色（宿主侧） | 主体 id、角色、权限 | 群主体按 `<渠道>:group:<会话id>` 规则 | 无 enabled principal | `group-principal` |
| S2 discovery | `operation list --json`（只读命令） | 总数 + read/write/scratch/未声明计数 + 只读集合 | 清单可解析、access 计数稳定 | 清单不可解析 / 非零退出 | `discovery` |
| S3 只读前置门 | 从自报清单派生只读集合 | 只读集合条数 | 非空 | 空 → 中止（fail-closed） | `readonly-gate` |
| S4 只读调用探针 | 调一个 `access=read` op | 四态回执；失败带 `code`；`retryable` 声明 | 收到确定性回执且失败带 code | 回执非结构化 / 无 code | `read-probe` |
| S5 dispatchKey 重放 | 同 key 重放同一只读调用 ×2 | 两次回执；是否稳定 | 两次一致（读路径稳定） | 差异（登记人工判） | `dispatchkey-replay` |
| S6 声明面 | 只读清单的长任务/确认/写面自述 | `long_running` 列表、wait/abort 面、写 op、confirmation op | 自述可读 | 自述缺失（登记） | `declarations` |

## 3. 六项判据（owner 点名）

### 3.1 retryable 语义

- **怎么验**：`--run` 的 S4 调一个只读 op，打印失败回执里的 `error.retryable`；对照契约缺省
  （`packages/contracts/src/execution-contract.ts:131`：**未声明 = 不可重试**）与宿主确定性失败守卫
  （`retryable !== true` 即锁住该 (operation, 对象)、本回合不再撞）。
- **通过判据**：失败回执带结构化 `code`；若出现 `retryable`，其值必须是布尔，且 `true` 只用于瞬时
  故障（超时 / 网关暂不可用 / 被中断）；参数错、对象不存在等确定性失败应为 `false` 或**不声明**。
- **失败时说明什么**：① 回执只有自由文本无 `code` → 四态映射不齐，宿主无法机械分流、不得嗅探文案；
  ② 确定性失败却回 `retryable:true` → 会诱发宿主重试风暴，须执行层修声明；③ 回执缺 `retryable`
  且宿主未锁 → 守卫失效（对照 `docs/decisions/debt.md` §八）。

### 3.2 确认句柄

- **怎么验**：**只读阶段只验「是否声明支持」**——S6 从清单读：是否存在 `access=write` 的 op、
  是否声明 `confirmation` 参数、是否有提案协议（`protocol`）。不执行任何写。
- **通过判据**：清单能读出写面与确认面声明。真实写回环（prepare 返回 handle → 宿主原样透传 →
  下一回合 commit 带上 → **读回核对计数**）留待写切片、owner 授权后另验（同一次 `execute`，
  不是第二套协议；句柄绑定/有效期/一次性/防重放全归执行层）。
- **失败时说明什么**：① 清单无写 op / 无 confirmation 声明 → 该层不支持确认句柄，写切片只能后置
  或改形态；② 返回 `needs_confirmation` 却无 `handle`/`summary` → 协议违约，适配器按 failed 机械
  分流、宿主 fail-closed（见 `packages/agent/src/dummy-cli-client.ts` 的 `confirmationOf`）；
  ③ 用户「还原话」被当成确认 → 越界（宿主不判断用户是不是在确认）。

### 3.3 写上限与原子性

- **怎么验**：**只读阶段只记录执行层自述**——S6 打印写 op 名与其声明参数（单次写入上限、
  整批原子语义等）。不执行写。
- **通过判据**：自述可读，且与写切片口径一致（单次写入条数上限、整批原子失败 = 一条不写、
  部分写必须逐条给出真实状态 `completed.items`）。
- **失败时说明什么**：① 自述缺失 → 写上限/原子性未知，写切片须先补声明再动；② 自述与实际不符
  （只有写切片才会暴露）→ 登记为执行层缺陷；③ 把「部分完成」当整批成功 → 宿主/模型违约。

### 3.4 dispatchKey 幂等

- **怎么验**：S5 用**同一个 dispatchKey** 重放同一只读调用两次，比较回执。只读调用无写副作用。
- **通过判据**：两次回执一致（读路径稳定）；宿主侧 dispatchKey 在首次创建逻辑操作时生成并绑定
  （同一逻辑操作重试/重规划读回同值）。
- **失败时说明什么**：① 两次不一致 → 登记后人工判（可能是查询数据的自然变化，**不是**写副作用）；
  ② 真实「同 key 不重复执行**写**」是**执行层职责**，本次只读阶段验不到，登记于 `docs/decisions/debt.md`
  §八（L-4：执行层未实现，配套 per-operation `idempotent` 声明与一致性探针待写切片）。

### 3.5 abort / 长任务

- **怎么验**：S6 从清单读 `long_running` 声明，并报告客户端 `wait`/`abort` 面是否实现。
  真实长任务（接受 `accepted` → wait 长轮询 → abort 中止）留待写切片/授权后另验。
- **通过判据**：声明了 `long_running` 的 op 才允许返回 `accepted`；该 op 的 `wait`/`abort` 面均在。
- **失败时说明什么**：① 未声明 `long_running` 却返回 `accepted` → 协议违约，宿主 fail-closed；
  ② 声明 `long_running` 但无 `wait` → 装配错误，宿主收 `accepted` 后 fail-closed（不留无人推进的
  running 任务）；③ `abort` 回 `aborted:false` → 停不下来，宿主如实转述、**不得宣称已取消**。

### 3.6 群主体

- **怎么验**：**宿主侧，与执行层无关**。规则 = principal `<渠道>:group:<会话id>`
  （`apps/server/server.ts:882`；群 = 独立主体，个人数据不进群）。人工一步：
  **用群会话问一句（只读问题）→ 查底账** `npm run tasks -- "#<编号>"`，核对 principal 前缀为 `group`。
- **通过判据**：群会话任务在底账以 `<渠道>:group:<会话id>` 立账；群与个人是两条互不继承的记录；
  角色受宿主侧白名单约束（未写 role = viewer = 只读）。
- **失败时说明什么**：① 底账 principal 是个人 id → 群消息被并进个人主体（隔离失败，先疑这里）；
  ② 群主体未开通 → 消息被拒、事件 `message_refused`；③ 群能借用个人权限 → 越界（群须单独授权）。

## 4. 必须中止的情况（硬停清单，命中任一即停）

| # | 条件 | 机械信号 | 处置 |
| --- | --- | --- | --- |
| 1 | 清单拿不到 / `operation list --json` 非零退出 | discovery 抛错 | 停；核对 `profile.root` / `gateway` / 执行层可达性（fetch 手动跑一次看报错） |
| 2 | 只读集合为空 | `readonly-fail-closed` | 停；不得以空允许集合运行 |
| 3 | 任何 `access != read` 的 op 要被执行 | `SmokeAbort`（exit 2） | 停；打印中止原因即停，不得改口径放行 |
| 4 | gateway 无法启动 | discovery 抛错 | 停；检查 `gateway` 是否为相对 root 的调用形式 |
| 5 | 观察到任何写副作用 | 人工/审计观察 | 立即停并上报（超出本档只读授权边界） |

判读纪律：确定性读数不得读作稳定性结论；只在同口径（同脚本/同配置/同清单）下比较；不筛绿。

## 5. 证据落到哪里

- **脚本证据**：`.runtime/real-smoke/readings.json`（gitignored；每步读数 + 只读集合，脱敏、不含
  绝对路径与凭据）。stdout 另打 `real_smoke_*` 机器行，可直接 pipe 进分析。
- **执行层证据**：真实调用落在**执行层自己的审计**（真实 17dz 以 `operation list --json` 为准；
  仓内夹具在 `<state-dir>/audit.jsonl`）。宿主不伪造审计。

## 6. 真跑一次需要什么条件（给 owner 的授权决定清单）

- **配置**：显式部署配置（`--config=<path>` / `AGENT_CONFIG_PATH`），其 profile `root` 指向 17dz 仓、
  `gateway: bin/17dz`。
- **凭据**：**宿主不持平台凭据**（执行子进程 env 走白名单，`packages/agent/src/worker-env.ts:27`）；
  只读凭据由执行层自己持有、可轮换/吊销。
- **网络**：执行层进程触达平台（宿主只 spawn 本地网关，不直接联网）。
- **时间**：能力清单发现 + 若干只读调用，量级秒级；真实读若含浏览器自动化可能更久（建长任务口径）。
- **授权**：owner 逐项授权（平台 / 范围 / 凭据 / 数据边界）；`docs/product/real-read-readiness.md`
  §4 评审清单全勾、独立复核通过后再跑。
- **执行门传递（须先确认）**：宿主执行子进程 env 是白名单（仅 PATH/HOME/TMPDIR），
  `EXECUTION_ALLOW_REAL` 等**执行层自己的**门不会被宿主透传——真跑前须确认执行层读门的来源
  （其自身配置文件）或授权放行，否则执行层会以 `REAL_EXECUTION_NOT_ALLOWED` 拒绝（这本身是安全默认）。

## 7. 指针

- 脚本与硬闸：`scripts/eval/real/smoke.ts:135`（`assertReadOnlyCall` 只读硬闸）、
  `scripts/ask-runtime.ts:502`（`resolveExecutionFace`：只读集合由 `access=read` 派生）、
  `packages/agent/src/dummy-cli-client.ts:82`（`readOnlyOperationNames`：清单 `access` 的消费口径）。
- 契约与生效语义：`packages/contracts/src/execution-contract.ts:131`（retryable 缺省 = 不可重试）；
  `docs/architecture/contract.md`（契约语义面）。
- 宿主侧边界：`packages/agent/src/worker-env.ts:27`（子进程 env 白名单）、
  `apps/server/server.ts:882`（群主体派生）、`docs/architecture/permissions.md`（权限三层）。
- 准备档与授权门：`docs/product/real-read-readiness.md`、`docs/decisions/debt.md` §八（长任务/幂等 17dz 未验）。
