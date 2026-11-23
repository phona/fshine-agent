# live 真库快照回归重放（`live-replay`）

> owner 原话：「copy 我现在用的数据库，拿去测试，这样就容易暴露问题，而不是丢在无菌环境里测试」。
> 本入口用**在线快照**（底账 + Pi 会话转录）在真装配上按真机原话重放，替代无菌夹具；
> 判据分负面（格式/泄漏）与正面（机械事实）两级，FAIL 如实报告，不为绿改判据。

## 它做什么

- 装配：`scripts/eval/real/live-replay.ts` 复用 `apps/server/server.ts` 的 `createServer`
  + 真 Pi 驱动（`packages/agent/src/pi-driver.ts`）+ 假渠道捕获（`sendText`/投递 sink），
  执行层 = 仓内 dummy 夹具。**模型端点是唯一外部依赖**。
- 素材：快照目录（缺省 `<TMPDIR>/fixtures/live-snap`，即 `state.db` + `sessions/`）。
  **只读素材**：每次运行都 `cpSync` 到临时目录，**绝不改快照本身**；快照不进仓。
- 脚本：按 owner 真机原话顺序发 14 条消息（冻结在 `REPLAY_TURNS`，改一字单测即红）。

### 两种模式

| 模式 | principal / session | 转录 | 隔离什么 |
|---|---|---|---|
| A `--mode a` | 快照真实 id | resume 快照 Pi 会话 | 「用户第二天继续用」，模型看得到自己之前对话 |
| B `--mode b` | 同 principal / 新 session | 无（新会话） | 只留「底账旧数据行」通道，隔离转录影响 |

## 怎么跑

```sh
export TMPDIR=~/.tmp
cd ~/projects/fshine-agent-replay
node --env-file-if-exists=<仓库>/.env.local \
  --import tsx scripts/eval/real/live-replay.ts --mode a   # 模式 A
node --env-file-if-exists=<仓库>/.env.local \
  --import tsx scripts/eval/real/live-replay.ts --mode b   # 模式 B
```

- 模型端点/密钥由 `--env-file-if-exists=<env文件>` 提供（`LLM_API_BASE_URL` / `LLM_API_KEY` /
  `LLM_MODEL`），脚本**不打印、不落盘密钥**；缺配置 `exit 2`，不退回脚本模型。
- 可选：`--snapshot <dir>`、`--out-dir <dir>`、`--turn-timeout-ms N`、`--settle-ms N`；
  `--help` 看完整用法。缺省证据落 `.runtime/real-live-replay/<模式>-<时间戳>/evidence.json`（gitignored）。
- 门：`npx tsc --noEmit`、`npx vitest run scripts/eval/real/live-replay.test.ts`、
  `npx vitest run`（全量）。

## 断言什么（证据分级）

用户可见面 = 14 回合回复 + 主动推送；负面命中**逐条打印命中位置与原文片段**（定位谁说的）。

**负面（格式/泄漏类，允许，冻结形状/原文不是语义判据）**

- **N1** 不含工具调用标记形状：`<｜｜DSML` / `<｜tool` / `<invoke` / `parameter name=`。
- **N2** 不含内部词：执行层 / 执行端 / 确认凭据 / dispatchKey / 长时运行 / 能力快照 / 宿主运行时。
- **N3** 不含任务编号形状 `#\d+`。
- **N4** 不含已记录的真实坏话术原文：`已交办，正在办理中` / `平台把新查询挡下了` /
  `中间有过一次` / `执行层确认摘要原文`。

**正面（机械事实）**

- **P1** 写入真落地：读回 empty-one W1 = `a=1/b=9/c=3` 三条（**不是 b=2**）。
- **P2** 说停真停：longtask 任务追加结束事实 + `user_stop` 触发事件 + 执行层 `abort` 审计行（不存「取消」种类）。
- **P3** 不存在的表：回复不出现任何数字条数（不许把不存在说成「0 条」）。
- **P4** 零假成功：每条「写入成功」陈述都必须有对应读回（写后 count > 写前 count）。
  「已提交 / 提交成功」是提交动作、**不算写入成功**；「不能确认是否已写入」这类如实免责
  语境里的「已写入」也不算（冻结样本，见 `WRITE_UNCONFIRMED_DISCLAIMERS`，不自动放宽）。

判据是纯函数 `evaluateAssertions`（在 `live-replay.test.ts` 里有正例全绿 + 逐条反向破坏绊线）；
任何 FAIL 都如实打印并 `exit 1`——**判据不因当前代码红而放宽**。

## 快照怎么更新（只读生产库！）

在**生产机**上用 SQLite 在线备份，别直接拷正在写的 db 文件：

```sh
# 只读打开生产库；.backup 在线快照，不锁业务、不写生产库
sqlite3 '<生产库路径>/state.db' ".backup '~/.tmp/fixtures/live-snap/state.db.new'"
# 校验后原子替换
sqlite3 ~/.tmp/fixtures/live-snap/state.db.new "PRAGMA integrity_check;"
mv ~/.tmp/fixtures/live-snap/state.db.new ~/.tmp/fixtures/live-snap/state.db
# 连同会话转录一起更新（模式 A 要用）
cp -a '<生产库路径>/sessions/.' ~/.tmp/fixtures/live-snap/sessions/
```

注意：

- 快照落在 `~/.tmp`（gitignore 之外、不进仓），`<TMPDIR>/fixtures/live-snap` 是缺省读取点。
- 快照 principal 必须在物化配置里 `enabled + operator`（脚本自动补写本次副本的 `principals`
  段，不改快照）。
- 更新后先跑两种模式各一次，确认 raw 输出与断言对照再入库；**任何 FAIL 如实登记**。
