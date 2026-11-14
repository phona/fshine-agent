# 真实只读接入准备档（设计与安全评审材料）

> **硬声明（准备材料 ≠ 已授权接入）**：本档仅为设计与安全评审材料，不代表已授权接入，也不构成任何安全结论。owner（2026-11-14）只批准准备档：**不允许实际连接、读取凭据、触碰真实数据**；实际接入须 owner 另行授权（授权门见 `docs/product/r3-open-decisions.md`；裁定登记见 `docs/decision-log.md` §二十三）。
>
> 目标平台未定：本档不虚构平台细节；一切平台相关事项以 §6「未知项与待补清单」为准（平台名、只读面、凭据托管方、限流与审计要求）。
>
> 本档不含任何真实平台密钥形态、内网地址或实例名。

- 分支/基线：`arch/readiness-prep`（基线 `arch/integration` @ `e07796a`；未 push、未合并）。
- 角色：实施方落盘，**待独立复核**（实施/复核分离；复核重点 = 无越权承诺、清单覆盖硬边界、未知项如实标注）。

## 1. 接入设计（宿主侧接缝与绑定）

### 1.1 唯一接缝：ExecutionClient

- 语义面 = `packages/contracts/src/execution-contract.ts:99-103`（`capabilities()` / `execute()`）：能力快照 L53-56、结构化请求 L59-63、四态结果 L92-96；契约模块零 import、零传输实现（L4-6）。
- 通用运行时只依赖接口（`packages/agent/src/execution-runtime.ts:96-97` 依赖注入）。**真实只读适配器 = 新增一个 `ExecutionClient` 实现 + 装配接线，运行时零改动**；运行时不得 import 适配器（静态守卫 `packages/agent/import-boundary.test.ts:174`）。
- 接线点三处（同构：建客户端 + 派生只读允许集合）：`scripts/ask-runtime.ts:118-123`、`apps/server/server.ts:83-91`、评测 runner `scripts/eval/convergence-r1/runner.ts:382-402`。

### 1.2 能力发现快照

- 每个会话取一次快照、进程内复用、不落盘、不另立名单（契约 L8-9；`execution-runtime.ts:176`；适配器缓存 `packages/agent/src/dummy-cli-client.ts:88、123-144`）。
- 只读集合由装配方从执行层自述的 access 声明派生（现适配器 `dummy-cli-client.ts:66-69`，注明「不是契约语义」）；集合必须非空且 ⊆ 快照，否则构造即失败（`execution-runtime.ts:172-181`）。
- Worker 只看到允许子集（`execution-runtime.ts:183-186`）；工具面最小（Main 1 个、Worker 1 个，同文件 L294-308）。
- **待定**：真实平台的能力发现形态与只读性声明（access/effects 等价物）；若平台不能自述，需 operator 声明或适配器映射规则——且不得成为宿主侧的第二执行名单。

### 1.3 结构化请求

- `requestId` 由宿主生成（`execution-runtime.ts:207-209`；契约 L10-12）：模型不能提供可信身份；去重与副作用安全重试归执行层。
- `args` 对宿主不透明，宿主不做业务校验（契约 L36-41、L58）。
- 已知残余：参数名现携带 CLI flag 形态；非 CLI 传输需适配器内映射或参数名中性化（`docs/decision-log.md` §17.3）。

### 1.4 错误/拒绝映射（needs_input / refused / failed 语义面）

- 四态互斥：`completed | needs_input | failed | refused`；refused=执行层策略拒绝，failed=执行失败，不得混用；`needs_input` 必须携带非空 `missing`（契约 L13-16、L66、L72-75、L92-96）。
- 机械分流、不嗅探文案：适配器按退出码/信封映射（`dummy-cli-client.ts:268-326`）；宿主不解析 `error.message`（`docs/decision-log.md` §十二）。
- 准入要求：真实适配器须给出「传输错误 → 四态」机械映射表，并以失败注入/拒绝路径测试锁定（对照回归锁 `packages/agent/dummy-client.test.ts:154、211-220、240-260`）。

### 1.5 运行约束

- 超时：Main 300s / Worker 180s（`execution-runtime.ts:138-141`）；单次适配器调用缺省 60s（`dummy-cli-client.ts:86`）。
- 单一 profile；gateway 必须是相对调用形式、root 必须绝对（`scripts/ask-runtime.ts:93-97`、`apps/server/server.ts:56-63`、`packages/core/src/config.ts:259-261、274-283`）。

## 2. 凭据与鉴权边界

**设计约束（宿主侧）**

- **凭据归执行层持有，宿主不落平台密钥**：宿主配置面（principals / contextProfiles / llm / wecom）没有平台凭据键；宿主自有秘密仅模型与渠道接入（`packages/core/src/config.ts:107-144`），由驱动/装配内部持有。
- **执行子进程 env = 精确白名单** PATH/HOME/TMPDIR（`packages/agent/src/worker-env.ts:25-35`；唯一消费 `dummy-cli-client.ts:103`；回归锁 `packages/agent/worker-env.test.ts:15/45`）。真实适配器若走子进程必须复用该白名单；若走宿主内 SDK/网络通道，须给出等价「凭据不进入模型可见面与 worker 可读面」机制并评审。
- **本地开发仅 .env**：本机秘密只住仓根 `.env`（gitignored；本地部署配置 `config/agent.yaml` 同样 gitignored）；提交物零密钥。运行入口 `--env-file-if-exists=.env` 只服务本机（`package.json:10-11`）。
- **最小权限与轮换要求**：本阶段只读——凭据仅具备只读范围；可轮换、可吊销、失败可回滚；不得落入 worker 可读路径。
- **前置硬条件**：`docs/decision-log.md` §七 登记的文件层可达缺口（`.env`/config 对 worker 同 OS 用户可读）闭环前，真实凭据不得落在 worker 可读路径。

**待定**：凭据托管方（种类/位置/获取方式/轮换）——见 §6。

## 3. 只读保障

- **写面关闭声明**：本阶段只开放查询（只读）；写/确认/取消/产物为后续切片（契约 L19-26）；Main 协议义务明示「本轮执行面只开放查询（只读）操作」（`execution-runtime.ts:66-71`）。
- **只读白名单**：由执行层自述 access=read 派生；空集合拒启（`scripts/ask-runtime.ts:120-123`；`apps/server/server.ts:86-89`）。
- **越权拒绝路径**：集合外 operation 在发起执行前确定性拒绝、不依赖模型遵守提示词（`execution-runtime.ts:196-202`）；回归锁 `packages/agent/runtime.test.ts:227/248/257`。
- **审计**：已发起的调用逐条记入任务底账 executions（`execution-runtime.ts:210-216`；`packages/core/src/task-store.ts:69-90`）；执行层侧拒绝由执行层自审（夹具审计含拒绝行、写失败 fail-closed：`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs:320-324`）；宿主不伪造审计。宿主在发起前拒收的越权尝试不产生 execution 行——即「未发起执行」的机械证据面。
- 说明：评测隔离门（`scripts/eval/safety-gate.ts:88-159`，只允许仓内夹具被驱动）只保护评测路径；真实接入的防线 = 凭据边界 + 允许集合 + 执行层自门（见 §4）。

## 4. 安全评审清单（逐项可勾）

说明：✅=宿主侧机制已在现行代码定义；⏳=需目标平台确定后补齐评审证据。评审通过前不得进入 §5 任一步骤。

- [ ] **最小权限**——凭据只读、宿主与 worker 均无平台密钥。✅ 宿主侧现状（白名单 + 无平台凭据键）；⏳ 真实凭据范围与托管方（§6）。
- [ ] **无生产写**——只读面关闭写，越权拒绝路径在册。✅ `execution-runtime.ts:196-202` + `runtime.test.ts:227`；⏳ 真实平台写面声明核验。
- [ ] **凭据托管**——凭据归执行层、宿主不落密钥；轮换/吊销/回滚路径。⏳（托管方待 owner 指定；前置：§七 文件层缺口）。
- [ ] **限流与预算**——限流与调用预算归执行层，宿主如实转述拒绝。⏳ 平台要求待补（桶/上限/退避/并发）。
- [ ] **审计留存**——证据来源、留存期限、复核入口。✅ 宿主 executions 底账 + 执行层审计（夹具面）；⏳ 真实平台审计渠道与留存要求。
- [ ] **回滚与熔断**——执行层回滚/熔断职责与宿主侧停机/如实交付策略。⏳ 待平台确定。
- [ ] **日志脱敏**——日志与用户可见文本不含秘密与内部路径。✅ 现行机制（`packages/agent/src/server-paths.ts` 等）；⏳ 真实平台字段脱敏要求。
- [ ] **拒绝路径测试**——每类拒绝（集合外/执行层拒绝/失败/缺输入）有机械测试。✅ 现行回归锁；⏳ 真实适配器失败注入用例。

## 5. 接入步骤草案（评审通过后；本档不执行）

1. **干跑假适配器**（仓内、零平台）：新增适配器骨架 + stub 网关，锁接口一致性/四态映射/白名单拒绝路径。出口判据：契约与拒绝路径测试全绿。
2. **影子只读（无用户流量）**：受控环境对目标平台只读面影子调用（不接渠道、不产用户可见结果），核对能力快照/只读派生/审计证据可得性。出口判据：快照与只读面核对一致、审计可读回、零写尝试。
3. **有限真实只读（owner 授权后）**：接真实用户流量，范围只读；限流与审计联调、失败如实交付。出口判据：owner 逐项授权 + §4 清单全勾 + 独立复核通过。

门间纪律：未过前一步判据不得进入下一步；发现写面/凭据面异常立即停止并回登记。

## 6. 未知项与待补清单（owner 指定目标平台前不虚构）

| 未知项 | 待补内容 | 影响面 |
| --- | --- | --- |
| 目标平台（名称/形态） | 平台类型、环境（沙箱/生产）、接入形态（CLI/API/SDK） | 适配器形态、传输与测试方式 |
| 只读面 | operation 清单、只读性声明（access/effects 等价物）、快照时效 | 能力快照与白名单派生规则 |
| 凭据托管方 | 凭据种类、托管位置、获取方式、轮换/吊销 | §2 凭据边界与评审项 |
| 限流与审计要求 | 桶/上限/退避、审计形态/留存/复核入口 | §3 审计联动与评审项 |

## 7. 指针

- 契约与运行时：`packages/contracts/src/execution-contract.ts`、`packages/agent/src/execution-runtime.ts`、适配器对照 `packages/agent/src/dummy-cli-client.ts`。
- 权威决定：`docs/decision-log.md` §十二（交付边界与清单）、§十七（§17.1 授权边界、§17.3 CLI flag 残余）、§二十三（真实只读 = 仅准备档）。
- 授权门与切片：`docs/product/r3-open-decisions.md`、`docs/product/r4-slice-plan.md`。
- 历史裁定：`docs/env-naming-ruling-20261110.md`（消费端边界）、`docs/environment-variables.md` §4a。
