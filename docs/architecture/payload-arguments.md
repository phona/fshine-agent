# 执行层声明要求：结构化入参必须是 payload

> 状态：现行（owner 2026-11-19 拍板）。适用于所有接入 fshine-agent 的执行层（仓内 fixture 与真实执行层）。
> 最后核对：2026-11-19（以代码为准；下方指针已按当前树核过行号）。
> 上游：`AGENTS.md`（职责边界 / 跨层协议）、`docs/architecture/contract.md` §1、`packages/contracts/src/execution-contract.ts:50-67`。
> 落点实现：`packages/agent/src/payload-materializer.ts:92`（lint）、`packages/agent/src/execution-runtime.ts:435`（装信封/路径替换）、`packages/agent/src/task-file-bridge.ts:237`（物化到任务目录）、`packages/agent/src/dummy-cli-client.ts:309`（声明投影）。

## 1. 要求

**结构化入参一律声明 `payload` + `schema`**：数组、对象、多字段契约文件（批量记录、变更提案载荷等）。
标量参数（`name` / `code` / `count` 这类单值）不需要。

声明形态（`operation list --json` 里宿主实际看到的面）：

```json
{
  "name": "records",
  "required": false,
  "payload": { "schema": { "type": "array", "maxItems": 500, "items": { "type": "object", "required": ["name", "value"], "additionalProperties": false, "properties": { "name": { "type": "string", "minLength": 1 }, "value": { "type": "number" } } } } },
  "desc": "宿主会按此 schema lint 后物化成文件，并把路径交给执行层"
}
```

宿主据此执行唯一链路：**模型给结构化值 → 宿主 lint → 物化到任务目录 → 把路径替换进该参数 → 才提交执行层**；
执行层只读文件，不再接收内联数组 / JSON 字符串。声明缺失时宿主无法 lint，只能把值原样透传，
模型只能自己手拼 JSON 字符串——实测单个回合 34 次工具调用、大半是 `--records` 传成 JSON 字符串被拒。

宿主**不会**兜底：它判断不出某个字符串参数「其实是结构化数据」，按名字/描述关键词猜语义是判据红线。
这条只能由执行层在声明里自觉写明。

形状硬约束：`payload` 的顶层 schema 类型必须是 `array` 或 `object`；一条 `payload` 声明必须带 `schema`。
违反后果（都是确定性的）：lint 不通过（缺字段/类型不符/额外字段/超 `maxItems`）的调用**在发起执行之前**
被宿主拒绝（`payload_lint_rejected`），执行层零调用；模型收到可修复的业务话术。

既有先例：`dummy.prepare` / `dummy.commit` 的 `records`（payload 位置参数，schema 见
`scripts/eval/fixtures/platforms/dummy-platform/capabilities.json`）与 `dummy.proposal` 的 `payload`。
退役形态：`--records` 普通 flag 已删除（仍按 flag 传会被执行层确定性拒绝，不静默忽略）。
声明守卫：`scripts/payload-declaration-guard.test.ts`（白名单 + 协议型 operation 形状 + 退役 flag 三条）。

## 2. 真实执行层（17dz）待办

以下 4 个 operation 的批量入参目前仍是普通 `--batch` flag，描述写的是「契约文件是数组（批量录入）」——
**在对方声明改成 `payload` 之前，真实凭证写入仍然会让模型手写 JSON**：

| operation | 现状 | 待改 |
| --- | --- | --- |
| `voucher.fill --batch` | 普通 flag，契约文件数组由模型手写 | 声明 payload + 数组 schema（单次上限沿用执行层自己的） |
| `voucher.prepare --batch` | 同上 | 同上 |
| `voucher.commit --batch` | 同上 | 同上 |
| `voucher.proposal --batch` | 同上 | 同上（提案载荷，schema 归执行层） |

归属：17dz 仓库自持这些声明，本仓**不改对方仓库**；改好后 `operation list --json` 会自动进入宿主
lint/物化链路，无需本仓改代码。落点登记：`docs/architecture/contract.md` §1。
