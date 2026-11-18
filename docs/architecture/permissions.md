# 权限模型（谁是主体、谁能调什么）

> 状态：2026-11-19 已实现（粗粒度三档角色；细粒度实体授权仍挂债，见 `docs/decisions/debt.md` P-2）。
> 最后核对：2026-11-19。
> 上游：`AGENTS.md`（职责边界）；`docs/architecture/contract.md`、`docs/architecture/tasks.md`。

## 1. 三层，各判各的

| 层 | 判什么 | 谁执行 |
|---|---|---|
| 渠道 | **你是谁**：`principalId` 由渠道事实派生，不可伪造（1:1 用 `channel:<userid>`；群用 `channel:group:<convId>`） | 宿主 |
| 宿主 | **这个主体允许调哪些 operation**（纯机械求交，不含业务语义） | 宿主 |
| 执行层 | **实体授权**：哪些账套/记录可读可写、能不能写 | 执行层（细粒度当前未实现，debt P-2） |

宿主与执行层之间只耦合**通用 permissions**（粗粒度 `read` / `write`）；不耦合任何业务实体字段（旧 `accountSetScope` / `capabilities` 已从契约删除，加载层忽略旧键）。

## 2. 求交与拦截（已实现）

```
实际可用集合 = 执行层声明能力(access=read/write) ∩ 角色白名单 ∩ 部署总闸(runtime.allowWriteOperations)
```

- 求交唯一收口：`scripts/ask-runtime.ts:422`（`narrowFaceByPermissions`）；对缺省执行面与注入的
  `createExecutionFace` 同样生效，角色过滤不因替身注入而失效。
- 角色 → permissions：`packages/core/src/config.ts:360`（`permissionsOfRole`）；principal → 角色：
  `packages/core/src/config.ts:372`（`effectiveRoleOf`，未写 role = `viewer`）。
- 装配带角色：`scripts/ask-runtime.ts:823`（会话允许集）、`apps/server/server.ts:686`（server 会话装配）；
  server 的进程级后台 runner 按任务主体求交（`apps/server/server.ts:525`）。
- 未命中 → **发起前确定性拒绝**：零执行请求、零执行事实、任务停在 `unexecuted`。
- 拒绝话术：`packages/agent/src/execution-runtime.ts:341`（`OPERATION_NOT_PERMITTED_MESSAGE`）——
  只说「当前权限不支持这个操作」，**不暴露内部 operation 名**。
- 角色未定义 → **启动失败**（`packages/core/src/config.ts:332`）；`permissions` 只允许 `read`/`write`，
  未知值 / 空数组 / 重复一律 fail-fast（`packages/core/src/config.ts:294`）。
- 未写 `role` 的 principal → `viewer`（只读），启动日志记 `principal_role_defaulted`
  （`apps/server/server.ts:398`）；最小权限，不静默给写。
- 写面：部署总闸关闭时全员不可写；开启时角色还必须含 `write`。

## 3. 角色（初版三档）

| 角色 | 典型归属 | permissions |
|---|---|---|
| `viewer` | 外部人员、群主体、未写 role 的 principal | `read` |
| `operator` | 内部人员 | `read` + `write` |
| `admin` | 开发者 | 全部（本切片与 operator 无额外能力差异） |

`roles` 未配置 = 内置三档默认（`packages/contracts/src/config.ts` 的 `DEFAULT_ROLES`，开箱可用）；
显式配置即整表替换，不做逐角色合并（避免「自定义 viewer 却静默继承内置 operator」的双源）。
配置形状：顶层 `roles.<name>.permissions` + `principals.<id>.role`（样例见 `config/agent.example.yaml`）。

## 4. 不做的

- **细粒度（实体级）授权**：谁能看哪些账套/记录 → 归执行层研判，宿主只传身份事实；当前未实现（debt P-2）。
- **广义 RBAC 兜底**：不做条件表达式/ABAC/规则引擎；高风险动作的最终边界仍由执行层把实际调用限制在可信授权范围内。
