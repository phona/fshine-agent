# 阶段 C 预注册：原生 SessionManager 能否替代 B1（写于首次实跑之前）

- worktree：`~/projects/fshine-agent-pi-upgrade`（分支 `arch/pi-upgrade`，Pi 三包 1.5.2）
- 性质：确定性实验，零真实模型、零网络。只用 `@earendil-works/pi-coding-agent` root 公开导出。
- 本轮**只验证，不删除 B1**（B1 源在 `arch/integration` 的 `packages/agent/src/session-persistence.ts`，
  本 worktree 不包含它；本轮不 checkout、不删除、不修改）。
- 失败样本全留：任何 FAIL 如实登记，不为了让结论变绿而放宽判据或改实验。

## 判据（8 项，逐条 PASS/FAIL；PASS 需实跑证据）

| # | 检查 | PASS 判据（预先写死） |
| --- | --- | --- |
| ① | `(principalId, sessionId)` 唯一映射 | 仅用 SessionManager 公开 API，同一键在重启/重复打开后**恰好一个**落盘会话文件且读回同一转录；不需要宿主另存映射，且同名键不会产生第二个文件。 |
| ② | 同一会话单写者约束 | 两个独立 SessionManager 句柄打开同一会话并各自追加时，要么被拒绝/报错，要么不丢任何已追加条目且读回一致。 |
| ③ | 不同用户相同 sessionId 隔离 | 不借助宿主额外路径分区（同一 sessionDir），principal A 与 B 用同一 sessionId 时互相读不到对方转录。 |
| ④ | 进程重启与异常退出恢复 | 新进程 `open` 后读回全部已完成条目；SIGKILL 后最后一个完整提交之前的条目全部可读，且可继续追加。 |
| ⑤ | 已压缩历史重启后正确继续 | 压缩发生后（会话文件含 compaction 条目）重启并继续：模型请求上下文含压缩摘要 + 压缩后保留的尾段，新回合正常完成。 |
| ⑥ | 历史 Session 格式兼容性 | 旧 B1（pi-agent-core 0.85.1 JsonlSessionRepo）落盘记录可被新 SessionManager 直接完整读回。 |
| ⑦ | 损坏/不可恢复会话明确报错 | 任何损坏形态（坏 header / 坏正文行 / 缺 header / 空文件 / 截断尾）都显式报错，**不得**静默跳过条目或静默重建会话。 |
| ⑧ | 恢复后不重新执行已完成的业务工具 | 重启/重开会话后，假执行层计数**不增加**（打开即恢复也不触发工具执行）；新回合若无工具调用，计数仍不变。 |

## 预判（写死，跑完对照；不据此改判据）

- ① FAIL：`create(cwd, dir, {id})` 文件名含时间戳，重复 create 同 id 会产生第二个文件；`findById`
  只返回首个匹配（readdir 序）。需要宿主自持「键 → 文件路径」映射且对 id 做哈希（渠道 sessionId 含 `:` 会被 `assertValidSessionId` 拒）。
- ② FAIL（无原生执法）：两个句柄各自持有 leaf，交叉追加形成两个子节点，重开后按行序只认最后一个 leaf，另一分支静默丢失。
  与 B1 一样依赖宿主串行（`apps/server/server.ts` 的 `enqueueSessionTurn`）。
- ③ FAIL（无原生维度）：同一 sessionDir 下同 id 即同一文件；需宿主按 principal 分区目录（B1 内建该分区）。
- ④ PASS（预期）：逐条同步追加，SIGKILL 前的完整行可读。
- ⑤ PASS（预期）：compaction 是普通 entry，`buildSessionContext` 负责压缩感知投影。
- ⑥ FAIL（预期，不假设可读）：旧 B1 是 v4 提交日志（header `kind:"header"`/`storageVersion`），
  新 SessionManager 是 v3 逐条 entry；直接 open 预期显式报错，`findById` 预期查不到 → 存在静默新建空会话的风险面。
- ⑦ 部分 FAIL（预期）：坏 header/缺 header 显式报错；**正文坏行被 `parseSessionEntryLine` 静默跳过**；
  空文件被静默补 header。B1 对「完整行但非法 JSON」显式报错，此处是退化。
- ⑧ PASS（预期）：SessionManager 打开只读 entry-log，无工具执行路径；用假执行层计数验证。

## 命令（预注册）

```
cd ~/projects/fshine-agent-pi-upgrade && export TMPDIR=~/.tmp \
  && npx vitest run scripts/eval/pi152-stageC/stage-c.test.ts
```

旧格式产物由一次性脚本用主仓 `node_modules` 内 **0.85.1 公开子路径**
（`@earendil-works/pi-agent-core/harness/session`）只读生成到本次临时目录，
不修改主仓、不复制 Pi 源码、不进产品依赖。
