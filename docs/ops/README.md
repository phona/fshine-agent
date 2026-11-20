# 运维手册（ops）

> 状态：现行。本页只留「今天要做决定或排障」的内容；流程史与发布记录不在此页（git 历史可考）。
> 最后核对：2026-11-18（`path:line` 以现行代码为准）。
> 上游指针：`package.json:10`（`start`）、`apps/server/main.ts:31`（启动装配唯一入口）、`packages/core/src/config.ts:432`（`loadConfig`）、`docs/environment-variables.md`（变量盘点口径）。

## 1. 启动与单实例纪律

服务入口只有一条：`npm start`（`package.json:10`）→ `apps/server/main.ts:31`；`npm run ask`（`:11`）与 `tasks`/`ops`/`cleanup:runs`（`:12-14`）共用同一套配置解析。启动顺序固定（`apps/server/main.ts:31-109`）：定位配置 → `loadConfig` → 派生部署 env → 单 profile 校验 → 定 dbPath → **单实例守卫**（`apps/server/instance-guard.ts:255`，连渠道前取锁，被占即拒启）→ 建渠道 → 建 server → 可选保留期清扫 → 起渠道 → 打 `server_started`。

拒启一律 fail-fast、不静默降级：找不到部署配置（`apps/server/main.ts:34-39`，不回落仓内 fixture）；`contextProfiles` 不是恰好 1 个（`apps/server/server.ts:185-192`）；profile 缺 `gateway`（`:205-207`）；`gateway` 是绝对路径或含 shell 元字符（`packages/core/src/config.ts:393-394`）；缺 LLM 三件套（`packages/agent/src/pi-driver.ts:208-215`）；缺 `WECOM_BOT_ID`/`WECOM_BOT_SECRET`（`packages/channel-wecom/src/adapter.ts:295-297`）；30 秒内未认证（`:315`）；以及**单实例守卫拒启**（`apps/server/instance-guard.ts:153` 取锁判据、`:180` 拒启话术）。「连没连、发不发」只认启动日志 `server_started`（`apps/server/channel-mode.ts:66-81`），不要用配置文件文本推断线上状态。停机：SIGINT/SIGTERM → `channel.stop()` + `server.close()`（`apps/server/main.ts:100-109`）。

**单实例纪律（有机械守卫）**：`apps/server/main.ts:53` 在连渠道**之前**取独占锁 `<dbPath 所在目录>/server/instance.lock`（默认 `<仓根>/.runtime/server/instance.lock`；`apps/server/instance-guard.ts:40` 锁文件名、`:153` 取锁、`:227` 释放），内容 `{pid, startedAt, argv}`。判据是「该 pid 是不是我们的进程」——**不仅看 pid 存活**（kill 语义，`:108`），还校验命令行匹配启动入口 `apps/server/main.ts`（读 `/proc/<pid>/cmdline`、ps 兜底，`:75`、`:85`；匹配判据 `:132`），pid 被系统复用也不会误伤无辜进程。取锁失败即拒启，exit 非 0，话术（`:180`）：

```
启动被拒：已有另一个 fshine server 实例在运行（pid=<pid>，启动于 <时间>，命令行 <argv>）。
同一 bot 只允许一条 WS 连接，拒绝重复启动以免抢连接/抢消息。
处理办法：若它就是要保留的实例，退出本次启动即可；若是残留实例，确认后执行
kill <pid> 结束它再重试，或改端口 / 换部署点（不同 dbPath 状态目录）并存。锁文件：<路径>
```

陈旧锁（pid 不存在 / 文件损坏 / pid 存活但命令行不匹配）→ 覆盖并记 `instance_guard_stale_overwritten` 事件（`:191`）；正常退出（SIGINT/SIGTERM）与异常退出都经 `process.on('exit')` 释放（`:264`），极端崩溃（SIGKILL）残留的锁下次启动按陈旧覆盖。两个实例还共享同一 `.runtime/state.db`（`apps/server/main.ts:43-45`）与 `.runtime/sessions/`（`apps/server/server.ts:499`），双写并发行为**仓库内未定义、未测**——守卫是撞车前的第一道闸，撞车后的数据一致性仍是部署侧责任。回归锁：`apps/server/instance-guard.test.ts`（五条主用例 + 反向绊线：判据改成只看 pid 存活 / 去掉命令行校验即红）。部署复证：`npm run ci` 退出 0 且末行 `CI deterministic gates: PASS`（`scripts/ci.sh:24-32`，= typecheck + unit）。

## 2. 三档 `channel.mode`

档位只认 yaml `channel.mode`，**没有 `FSHINE_*` 环境变量覆盖口**；取值只认 `offline`/`shadow`/`live`，空串、大小写偏差、尾随空格、YAML null 一律启动即失败（`packages/core/src/config.ts:251`、`:261-268`）；缺键 = 未配置 → 缺省 `offline`（`packages/contracts/src/config.ts:253`）。`offline` 不 `start`（`apps/server/channel-mode.ts:57`），出站全 suppressed；`shadow` 连、入站照收、回合照跑，六类用户可见发送全抑制并留 `wecom_silent_shadow_suppressed`；`live` 真实投递。

生效链只有一条：`channelModeOf` → `deliveryModeFor` → `createChannelForMode` 在构造期把出站模式显式钉死（`apps/server/channel-mode.ts:31-46`）；适配器另有的 `FSHINE_WECOM_DELIVERY` 只在显式选项缺失时才生效，显式非法值 fail-safe 到 silent（`packages/channel-wecom/src/silent-shadow-gate.ts:49-57`）。「shadow 收不到回复」不是故障，是设计组合（`apps/server/channel-mode.ts:66-81`）。回归锁：`apps/server/channel-mode.test.ts:241-253`。

## 3. 环境变量：yaml 是源，env 只是非空覆盖口

优先级：**非空同名 env > `config/agent.yaml` > 代码缺省**；空串不算覆盖（`node --env-file` 会把模板里的 `KEY=` 设成空串）（`packages/core/src/config.ts:1-8`、`config/agent.example.yaml:5-7`）。解析点唯一 `loadConfig`（`packages/core/src/config.ts:432`）；yaml→env 派生 `deploymentEnvOf`（`:511`）、合并 `effectiveDeploymentEnv`（`:544`），不要在别处再写一份优先级逻辑。配置定位：`--config=<path>` > `AGENT_CONFIG_PATH` > 仓根 `config/agent.yaml`（`scripts/resolve-config-path.ts:25-40`）；server 找不到即拒启（`apps/server/main.ts:33-38`）。

运维日常真正会动的少数几项：`AGENT_CONFIG_PATH`、`DB_PATH`、`FSHINE_ATTACHMENT_DIR`、`LLM_API_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`、`WECOM_BOT_ID`/`WECOM_BOT_SECRET`、`EXECUTION_ALLOW_REAL`（仅字面量 `1` 授权；宿主只继承不判，`docs/environment-variables.md:80`）。完整清单与默认值见 `docs/environment-variables.md`。⚠️ 该文 `:33` 写 `DB_PATH` 缺省 = 仓库根 `data/agent.db`，现行代码缺省是 `<仓根>/.runtime/state.db`（`apps/server/main.ts:44-46`、`scripts/tasks.ts:129`），以代码为准。

## 4. 进程守护与无人值守

**本机 live 部署已由 systemd user unit 守护**（2026-11-21 落地；unit 在 `~/.config/systemd/user/fshine-live.service`，不在仓库内，因为它是部署形态不是产品代码）：`WorkingDirectory=/home/tao/projects/fshine-agent-int`、`Environment=TMPDIR=/home/tao/.tmp`、`ExecStart=bash -lc 'exec npm start'`、`Restart=always`、`RestartSec=3`、日志 append 到 `/home/tao/.tmp/fshine-live-systemd.log`、`systemctl --user enable --now fshine-live.service` 已开机自启。

- **重启演练已验**：`systemctl --user restart fshine-live` → 20 秒内 `Authenticated` + `server_started`，单实例锁正确释放并重取（`instance_guard_acquired` 两条）。
- **它解决的是「进程不在=消息丢」**：实测停服 `12:02:15Z` → 重连 `12:03:43Z` 期间用户发的 2 条消息，重连后底账零新增、`aibot_msg_callback` 帧 0（平台不补投）——见 `docs/decisions/debt.md` §十一。有了 `Restart=always`，崩溃/重启的窗口从「小时级」压到「秒级」；窗口内仍可能丢，这是长连接模式的固有代价（销账条件=切 Webhook）。
- **心跳 15s（已落地 `52eaa0b2`）**：适配器把官方 SDK 的 `heartbeatInterval` 从 30s 收紧到 15s（社区对「连接看似正常也偶发丢」的缓解；企微约 90s 无心跳断开）。连接层仍由 SDK 管（认证/重连/退避），宿主不重试、不告警（既有纪律）。
- **仓内无人值守动作**只有 run 目录保留期清扫，且缺省关闭：`runtime.fileRetentionSweepOnStart`（缺省 `false`）在启动装配完成、渠道接消息前扫一次、无定时器（`apps/server/startup-sweep.ts:1-14`、`apps/server/main.ts:74-77`）；周期清理要部署侧自己调度 `npm run cleanup:runs`（`--dry-run` 只报不删，`scripts/cleanup-runs.ts:1-20`）。通知落盘逐条 append、无轮询无清扫，写失败只记未送达（`apps/server/notification-file-sink.ts:1-6`）。其余常驻面都是请求驱动——「服务在跑却什么都不发生」通常不是守护问题，按 §5 查档位与连接。

## 5. 排障 runbook

**5.1 静默连接**：先读 `server_started`（`apps/server/channel-mode.ts:66-81`）——`offline` = 压根没建连接（`:57`），用户发什么都石沉大海；`shadow` = 连上但出站全抑制；只有 `live` 真投递。别用 `FSHINE_WECOM_DELIVERY=live` 在 shadow 上放行：显式档位压过环境开关（`packages/channel-wecom/src/silent-shadow-gate.ts:49-57`）。连接（订阅/心跳/指数退避重连）由官方 SDK 管理，宿主只管认证与错误（`packages/channel-wecom/src/adapter.ts:3`）：启动期等 `authenticated` 最多 30 秒（`:315`、`:330`），错误即启动失败（`:331`），**连接层不重试、不告警**。只有某个人不回：看 `message_refused`（`apps/server/server.ts:616-620`）。查任务事实用 `npm run tasks -- "#<编号>"`（`package.json:12`）或 `npm run ops`（`:13`），不要靠对话复述。任务终态后可用 `npm run tasks -- <id> --redo` 重新交办（= 新任务、委派原文逐字、经与 `ask` 同源的生产装配；不是人工接管、也不是会话续跑）。

**5.2 双实例（忽好忽坏）**：先看有没有拒启话术（§1 单实例纪律）——第二个实例现在**起不来**：启动即被锁拒（exit 非 0）。若历史上有两个实例同时跑过，残留进程不会自己让路，杀干净再起：`kill <pid>`（pid 在锁文件 `<dbPath 所在目录>/server/instance.lock` 里，或 `ps` 找 `apps/server/main.ts`；`ps -p <pid> -o command=` 核命令行）。真撞上了：同一 bot 的第二条 WS 连接会把第一条踢掉，表现为间歇失效（`docs/product/wecom-live-dummy-cases.md:30`）；两实例同时写同一 `.runtime/state.db` 与 `sessions/`（`apps/server/main.ts:43-45`、`apps/server/server.ts:499`），出现「编号跳号/回复接错会话」先怀疑这里。

**5.3 换执行层（或改配置）要清哪些**：**必须一起清** `.runtime/sessions/`（默认 `<dbPath 所在目录>/sessions`，`apps/server/server.ts:99`、`:499`）**与** `.runtime/state.db`（`apps/server/main.ts:43-45`）；只清 DB 不清转录，模型会复述旧执行层的结论（`docs/product/wecom-live-dummy-cases.md:35`）。清理前先备份。dummy 状态根 `.runtime/server/state`（`apps/server/server.ts:495`；审计 `scripts/ask-runtime.ts:605`）只服务 dummy 夹具；单实例锁 `<dbPath 所在目录>/server/instance.lock` 是平级邻居，删状态目录时别留着它（下次启动按陈旧覆盖，但留着会带出误导性 pid）。能力快照每会话取一次、进程内复用、不落盘（`packages/agent/src/execution-runtime.ts:1055-1065`），所以**换执行层必须重启进程**，没有热切换；允许集合不在快照里即 fail-closed（`:1057-1059`）。

## 6. 人工走查只测交互

功能与不变量由自动化兜（`npm test`、`scripts/eval/wecom-sim/run.ts`、`npm run eval:cap01`），人工只测**观感与措辞**、**真网络时序**、**真实文件上传下载**（`docs/product/wecom-live-dummy-cases.md` §0）；不要重测自动化已兜的部分——手工只判措辞/可用性与体验，**手工证据不替代自动化门**。结论只写「通过 / 不通过 / 存疑（附原文）」，**不写「稳定」「100%」「已达标」**。真实只读接入**未获授权**：不得借走查连真实执行层或真实数据（`docs/product/real-read-readiness.md:3`）。

## 7. 禁令与操作纪律

**在「三道边界」闭环前，不得宣称可安全连接真实生产 SaaS**（裁定原文 `docs/history/decision-log-part01-2026-11_undated.md:493`）；真实只读接入需 owner 单独批准。**`.runtime/` 永不 `git add`**：底账、会话、证据、看门狗日志都在里面，属运行产物。
