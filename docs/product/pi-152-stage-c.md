# Pi 1.5.2 · 阶段 C：原生 SessionManager 能否替代 B1

- 性质：确定性实验，零真实模型、零网络；只用 `@earendil-works/pi-coding-agent` root 公开导出。
- 预注册：`scripts/eval/pi152-stageC/PREREG.md`（8 项判据写于首次实跑之前；失败样本全留，不放宽判据）。
- 命令（预注册，原样）：`export TMPDIR=~/.tmp && npx vitest run scripts/eval/pi152-stageC/stage-c.test.ts`
- 本轮结果：`Test Files 1 passed (1)`、`Tests 15 passed (15)`（8 项检查由 15 个用例承载；用例通过只代表实验执行成功，判据按读数逐条判定）。
- 原始证据：`.runtime/`（不提交）+ 测试内 `console.log` 的 `STAGE-C-*` 读数；本文逐条复述。

## 1. 八项判据逐条判定

| # | 检查 | 实测读数 | 判定 |
| --- | --- | --- | --- |
| ① | `(principalId, sessionId)` 唯一映射：同一键在重启/重复打开后恰好一个落盘文件，不需要宿主另存映射 | 同 id 两次 `create` → `files=2`；`findById` 只返回其中一个（`2026-11-15T20-12-47-073Z_sess-alpha.jsonl`），`resolvedTextCount=1`。渠道 sessionId 含 `:` 被 `Session id must be …` 拒绝，需宿主哈希 id | **FAIL** |
| ② | 同一会话单写者：两句柄交叉追加时要么拒绝，要么不丢条目且读回一致 | 两句柄交叉追加不报错；磁盘 3 条 message entry；重开后上下文 `["u1","u3-from-B"]`，A 的 `u2-from-A` 静默丢失 | **FAIL** |
| ③ | 不同用户相同 sessionId 隔离：同一 sessionDir 下 A/B 互相读不到 | 同一 sessionDir、同 id：`sameFile=true`，B 读到 A 的转录 `bobSees=["alice 的私密内容"]` | **FAIL** |
| ④ | 进程重启与异常退出恢复：SIGKILL 后完整提交可读、可续写 | 子进程 `SIGKILL`；角色 `["system","user","assistant","toolResult","assistant"]`；`beforeCount=7`，追加后 `afterCount=8`；截断尾的半行被丢弃 | **PASS** |
| ⑤ | 已压缩历史重启后正确继续：请求含摘要 + 保留尾段，新回合完成 | `compactionEntries=1`；`requestHasSummary=true`、`requestHasTail=true`；`resumedText="重启后继续成功。"` | **PASS** |
| ⑥ | 旧 B1（0.85.1 v4 提交日志）可直接完整读回 | 旧 header `kind="header"`、`storageVersion=1`；直接 `open` 抛 `not a valid pi session`；`findById` 落空（`byIdBeforeNaive=null`）；朴素路径 `create` 同 id 后新旧文件并存（`filesAfterNaive=2`），新会话上下文只有 `["重启后的新问题"]` | **FAIL**（存在静默新建空会话风险） |
| ⑦ | 损坏/不可恢复会话必须显式报错，不得静默跳过或静默重建 | 坏 header、缺 header → 显式抛 `not a valid pi session`（子用例通过）。合法 header + 坏正文行 → 不报错，坏行断开 parent 链，上下文只剩 `["第三条"]`；0 字节文件 → 静默补 header 重建为空会话（`entries=0`） | **FAIL**（部分用例显式报错，两种形态静默） |
| ⑧ | 恢复后不重执行已完成的业务工具 | SIGKILL 后 `countAfterCrash=1`、`countAfterOpen=1`；新进程继续一回合 `execCalls=0`、`countAfterTurn=1`，请求上下文含已完成 toolResult | **PASS** |

## 2. 对 B1 的替代判定

**判定：B1 必须改——不是可删，也不是原样保留。**

三条理由：

1. **不能删**：Pi `SessionManager` 只赢下 ④⑤⑧（存储/压缩感知投影/不重放工具），输掉 ① ② ③ ⑥ ⑦。这五项正是 B1 承担的 B 类确定性责任——可信身份分区、键→文件唯一映射、损坏不静默、旧格式不静默重建；Pi 1.5.2 公开 API 没有对应能力（`SessionManager` 无 principal 维度、无唯一键、坏行静默跳过、0 字节静默补 header）。
2. **不能原样保留**：原样保留 B1 意味着宿主同时维护两套落盘实现（B1 提交日志 + Pi 逐条 entry 日志），违反仓库删除纪律「删除优先于迁移，禁止停用代码却长期保留两套实现」，且两套格式在重启/迁移时必须对账，增加而不是减少风险。
3. **必须改（唯一可行方向）**：把 B1 的存储引擎替换为 `SessionManager`，B1 降为薄包装——宿主自持 `hash(principalId, sessionId)` 键→文件路径映射、按 principal 分区目录、严格 entry 校验（坏行/缺 header/旧格式显式报错或显式迁移）、旧 v4 记录一次性迁移入口；目标 ≤100 行。这样落盘实现只剩一套，① ② ③ ⑥ ⑦ 由薄包装补齐，④⑤⑧ 用 Pi 原生能力。

补充：② 的单写者约束此前也依赖宿主 `enqueueSessionTurn` 串行；薄包装不得把它当成 Pi 原生保证。

## 3. 证据边界

- 本实验不修改 Pi 源码、不 deep-import `dist`、不复制 Pi 源码；旧 B1 格式产物由一次性脚本用主仓 0.85.1 包的公开子路径只读生成到临时目录。
- 阶段 C 只做确定性判定，不评估真实模型行为；真实模型 E2E 见 `docs/product/pi-152-stage-d.md`。
- 用例通过数（15/15）不等于 8 项判据 PASS：①②③⑥⑦ 均有用例在断言「现状是 FAIL」。
