# e2e 归属清单：通用 vs L4 集成

> 术语说明：这里的“L4 集成”指 eval 分层里的 L4（fshine + 执行层一起跑的集成），
> 不是 `docs/architecture-laws.md` 里的 L4（写路径保险箱）。两者同名不同义，
> 本文件一律写“L4 集成”，不单写“L4”。

## 判定规则（宁可标成 L4，也不要把 L4 标成通用）

- **通用**：单仓就能跑，不依赖兄弟仓、不依赖 `config/agent.yaml`、不依赖财税语义、
  不依赖财税 mock、不依赖真模型。断言面只涉及编排机制本身。
- **L4 集成**：必须 fshine + 17dz 一起才能跑。只要满足任一条件即判 L4 集成，
  不论该用例的断言本身是不是通用机制：
  - import `tests/e2e/harness.ts`（该模块在加载时就派生兄弟仓的 operation 表、
    并在 beforeAll 要求 `bin/17dz` 存在）；
  - 或直接 spawn 兄弟仓 `bin/17dz`（如 `plan-awareness`）；
  - 或断言面涉及财税语义、财税 mock 状态、平台账本、平台审计。
- L4 集成的证据不得冒充通用证据：通用闭环（CI）只认 typecheck + unit +
  generic-mock，L4 集成全绿只能证明“fshine + 17dz 这一对实例能跑”，
  不能证明“换一个执行层后仍成立”。

## CI 口径（与 `scripts/ci.sh`、`.github/workflows/ci.yml` 一致）

CI（本地 `npm run ci` 与 GitHub Actions）只跑三条确定性门：

1. `npm run typecheck`
2. `npm run test -- --project unit`
3. `npm run eval:generic-mock`（通用网关 `bin/generic`，协议基线 v2）

CI **不跑** `tests/e2e`，也不跑真模型 eval（`npm run eval`）：

- e2e 需要兄弟仓 + gitignored 的 `config/agent.yaml`，单 checkout 跑不起来；
- 真模型 eval 需要 LLM 凭据且评委分数有方差，属于 Tier B（合入前手动跑、
  或定时跑），不是每次推送的门。
- 本文件标完后，CI 口径不变：没有任何财税 e2e 被偷偷加回 CI。

## 前置条件（按归属分）

### 通用测试的前置条件

- 本仓 checkout + `npm ci` 即可；不需要兄弟仓、不需要 `config/agent.yaml`、
  不需要 LLM、不需要财税 mock、不需要浏览器。

### L4 集成测试的前置条件（全部都要）

- 兄弟仓在 `FSHINE_PLATFORM_ROOT`（缺省为本仓上一级的 `17dz-platform`），
  且其中已跑过 `npm ci`（否则 `bin/17dz plan evaluate` 会因缺 `ajv` 等依赖而失败，
  这是环境缺陷，不是代码缺陷）；
- 本仓 gitignored 的 `config/agent.yaml` 存在（部署配置，永不提交），
  harness 的 `boot()` 会读它并按用例打补丁；
- 执行层 mock：harness 在 beforeAll 钉死 `EXECUTION_EXECUTOR=mock`、
  `EXECUTION_SERVE=1`，并给每个用例独一份平台状态文件
  （`EXECUTION_PLAN_STATE` / `EXECUTION_RATE_LIMIT_STATE` /
  `EXECUTION_MOCK_STATE` / `EXECUTION_AUDIT_PATH` /
  `EXECUTION_PROPOSAL_STATE`），不开浏览器、不触网、不碰真平台；
- 模型：不需要真模型。Main 与 worker 都是脚本化驱动回放；
  harness 注入的 `LLM_API_BASE_URL` 指向不可达地址、`LLM_MODEL` 记为 unused，
  企微凭据是确定性假值（注入的假 SDK 从不真连企微）；
- 真写：`FSHINE_REAL_COMMIT` 不设、`EXECUTION_ALLOW_REAL` 不设；
  写链路用例跑的是 mock 下的提案创建/确认/读回，不是真落账。

### 已知限制：`plan-teaching.test.ts` 的跨仓读与 dummy 回落（#31/#32 定判，2026-11-04）

- **定判 1——main 侧红是环境伪影，不是代码回归。** main 版该测试无回落，
  直接 `readFileSync(<PLATFORM_ROOT>/src/execution/plan-schema.json)`；
  单仓检出或 `/tmp` 工作树下兄弟仓不在 `../17dz-platform` 时，第 1 用例必以
  `ENOENT: no such file or directory, open '…/17dz-platform/src/execution/plan-schema.json'`
  失败，其余 2 用例仍过（实测：1 failed | 2 passed）。兄弟仓在场时 main 版 3/3 过。
  另注意变量名已改：main 只认旧名 `DZ_PLATFORM_ROOT`，单设新名
  `FSHINE_PLATFORM_ROOT` 救不了 main（实测仍 ENOENT）。
- **定判 2——p1 版 dummy 回落成立，但口径只到协议顶层形状。** p1 版兄弟仓不在场时
  回落到仓内 `scripts/eval/fixtures/dummy-platform/bin/dummy plan --schema`，无兄弟仓布局下
  实测 3/3 过；dummy 与真实 schema 在本测试断言的顶层字段上一致
  （`required: ["calls"]`、`additionalProperties: false`、
  `properties: calls / goal / requestId`）。因此 dummy 绿只证明“教学形态符合协议顶层形状”，
  不证明教学与财税 schema 的描述、逐调用校验一致；真 schema 核验仍需兄弟仓在场的那一跑
  （p1 版指 `FSHINE_PLATFORM_ROOT` 向真实兄弟仓时实测亦 3/3 过）。
- **本定判不改生产逻辑、不放松门禁。** 不得把 dummy 绿读成“已对真实财税 schema 验过”。

例外：`plan-awareness.test.ts` 用 `describe.skipIf(!existsSync(cliPath))`，
兄弟仓 CLI 不存在时**跳过而不是失败**——跳过不是绿证据，跑它必须先确认
CLI 在场。

## 统计（按文件首行 `it(` 计数，测试文件共 38 个、用例共 145 个）

- 通用：1 个文件、3 个用例（`local-fake.test.ts`）。
- L4 集成：37 个文件、142 个用例。
- 辅助文件（不计用例）：`harness.ts`（L4 集成基础设施）、
  `invariant-checker.ts`（L4 集成判据层，读平台账本/审计/mock 状态）。

## 逐文件归属

| 文件 | 归属 | 依赖 | 断言面（按 describe） |
|---|---|---|---|
| `harness-cursor.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | harness 光标保真（断言本身是通用机制，但跑法是 L4，故判 L4） |
| `harness-fidelity.test.ts` | L4 集成 | 经 harness：兄弟仓派生表 + 真 spawn 一次平台 CLI（mock） | harness 保真度绊线 HF-1/HF-2/HF-3 |
| `input-shape-variants.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 输入形状变体不改变确定性判定 |
| `local-fake.test.ts` | 通用 | 无：本仓 cwd 作 profile root，`docs/` 作 skillRoots 占位，脚本化驱动 | 本地 runner：委派透传、transcript 恢复、profile 越权拒绝。注：文件内 profile 键名 `17dz` 是遗留键名，不是兄弟仓依赖，改名是后续清理项，不改变本判据 |
| `plan-awareness.test.ts` | L4 集成 | 直接 spawn 兄弟仓 `bin/17dz`（mock executor），自有计划状态文件；CLI 缺失时跳过 | fshine ↔ 17dz 计划边界：通知/确认门、累计重量、账套存在性专用搜索 |
| `turn-loop-activated-plan.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 批准了但没执行的收尾 |
| `turn-loop-attachments.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 附件/文件消息的真实渠道路径 |
| `turn-loop-clarification.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 结构化歧义 → 宿主机械组装澄清 |
| `turn-loop-concurrent.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 并发会话里的多步计划中断/恢复/跳过/确认门 |
| `turn-loop-confirmation.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 跨轮确认语义 |
| `turn-loop-delegation-failure.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 委派失败的用户话术 |
| `turn-loop-disambiguation.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 多任务回溯歧义的编号消歧 |
| `turn-loop-error-fast-path.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 错误态快路径 v2 |
| `turn-loop-execution.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 执行凭证与查询范围 |
| `turn-loop-first-frame.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 受理即帧 |
| `turn-loop-interactive.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置；后台续跑有真实等待 | interactive 会话生产接线 |
| `turn-loop-interleaved.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 多任务交织与探索型会话 |
| `turn-loop-long-memory.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 长期记忆确立、注入与 principal 级延续 |
| `turn-loop-long-session-invariants.test.ts` | L4 集成 | 经 harness + invariant-checker：兄弟仓 + 财税 mock + 配置 + 平台账本/审计 | 长会话不变量 S1–S4 |
| `turn-loop-needs.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | Subagent 报错回路 |
| `turn-loop-phone-incident.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 手机事故对话回归 |
| `turn-loop-pingpong.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 多任务乒乓路由与探索线程延续 |
| `turn-loop-plan-gate-boundaries.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 计划门档位边界、累计账本、被拒计划收敛、plan --schema 元数据自救 |
| `turn-loop-plan-gate.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 计划门（通知与确认） |
| `turn-loop-plan-replay.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 计划模式复读的外发兜底 |
| `turn-loop-plan-steps.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 长任务拆解（计划模式） |
| `turn-loop-platform-health.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 平台健康信号（Lane 2 冷却） |
| `turn-loop-progress-frames.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 委派回合的进度帧 |
| `turn-loop-recall-facts.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 召回事实注入、结构化召回条目 |
| `turn-loop-resend.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | W4 重发路由 |
| `turn-loop-resource-exhausted.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 资源耗尽终稿 |
| `turn-loop-resume.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 计划恢复路径 |
| `turn-loop-routing.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 申报路由与安全边界 |
| `turn-loop-security.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 实体越权 × 注入、写开放声明、污染塑形、平台不可用冷却 |
| `turn-loop-session-entities.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 会话实体（实体门禁第四来源） |
| `turn-loop-worker-timeout.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | worker 执行超时 |
| `turn-loop-write-chain.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 + 提案/落账读回 | 网关提案路径：提案创建、完整落账链、确认码攻击面 |
| `turn-loop-write-closure.test.ts` | L4 集成 | 经 harness：兄弟仓 + 财税 mock + 配置 | 写关闭 disclosure（D-075） |

## 网关与环境名归属

- 通用测试与通用 eval 走通用网关 `bin/generic`（`scripts/eval/fixtures/dummy-platform`）。
- L4 集成测试走财税实例网关 `bin/17dz`（兄弟仓），该名只属于该实例 profile，
  不属于通用层。
- 环境名一律 `EXECUTION_*`（执行层治理）/`FSHINE_*`（宿主自有）；
  工作树 grep 旧前缀保持 0（历史提交里的旧名不重写，度量以工作树为准）。
