# 权限模型（谁是主体、谁能调什么）

> 状态：2026-11-18 初版（三档角色；细粒度实体授权未实现，见 `docs/decisions/debt.md` P-2）。
> 最后核对：2026-11-18。
> 上游：`AGENTS.md`（职责边界）：`AGENTS.md:30`、`docs/architecture/contract.md`、`docs/architecture/tasks.md`。

## 1. 三层，各判各的

| 层 | 判什么 | 谁执行 |
|---|---|---|
| 渠道 | **你是谁**：`principalId` 由渠道事实派生，不可伪造（1:1 用 `channel:<userid>`；群用 `channel:group:<convId>`） | 宿主 |
| 宿主 | **这个主体允许调哪些 operation**（纯机械求交，不含业务语义） | 宿主 |
| 执行层 | **实体授权**：哪些账套/记录可读可写、能不能写 | 执行层（当前未实现） |

宿主与执行层之间只耦合**通用 permissions**（粗粒度 `read` / `write`）；不耦合任何业务实体字段（旧 `accountSetScope` 已删，执行层不一定是财税平台）。

## 2. 求交与拦截

```
实际可用集合 = 执行层声明能力(access=read/write) ∩ 角色白名单 ∩ 部署总闸(runtime.allowWriteOperations)
```

- 未命中 → **发起前确定性拒绝**，话术不暴露内部 operation 名；
- 角色未定义 → **启动失败**（不静默降级）；
- 写面：部署总闸关闭时全员不可写；开启时还要角色含 `write`。

## 3. 角色（初版三档）

| 角色 | 典型归属 | permissions |
|---|---|---|
| `viewer` | 外部人员、群主体 | `read` |
| `operator` | 内部人员 | `read` + `write` |
| `admin` | 开发者 | 全部（含后续运维操作） |

配置形状（`principals.<id>.role`）与角色表解析在 `packages/core/src/config.ts:335`（`parsePrincipals`）；允许集合派生在 `scripts/ask-runtime.ts:382`（部署总闸并入写集合）与 `packages/agent/src/execution-runtime.ts:1355`（能力快照）。

## 4. 不做的

- **细粒度（实体级）授权**：谁能看哪些账套/记录 → 归执行层研判，宿主只传身份事实；当前未实现（debt P-2）。
- **广义 RBAC 兜底**：不做条件表达式/ABAC/规则引擎；高风险动作的最终边界仍由执行层把实际调用限制在可信授权范围内。
