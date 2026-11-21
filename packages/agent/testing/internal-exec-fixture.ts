/**
 * 夹具专用「内部 exec 路由」工具注入（owner 2026-11-20「机制参数碰不到」）。
 *
 * 生产 Worker 工具面只有 op_* 工具（只收声明过的业务字段），没有 execute_operation；
 * 脚本夹具要注入机制旋钮（`--count` / `--seconds` / `--delay-ms` / 未声明参数）时，经
 * `toolCallAssistant('execute_operation', { operation, args })` 发内部工具调用，走运行时的
 * execute_operation 兼容入口——不经 op_* 工具面，因此不受结构化字段校验限制（这是
 * **夹具侧**特权，真模型拿不到那个工具）。
 *
 * Pi 只派发声明过的工具名（实测未声明名到不了 exec 闭包），所以脚本驱动的 `run` 必须用
 * `withInternalExecTool` 包一层，把本工具定义追加到本回合工具面；不改产品工具面。
 */
import type { DiscoveredTool } from '@fshine/contracts';
import type { TurnDriver, TurnDriverInput } from '../src/driver-contract';
import {
  EXECUTE_OPERATION_TOOL,
  EXECUTE_OPERATION_TOOL_DESCRIPTION,
  EXECUTE_OPERATION_TOOL_SCHEMA,
} from '../src/execution-runtime';

/** 内部兼容工具定义（仅夹具注入；生产 Worker 工具面无此名）。 */
export const INTERNAL_EXEC_TOOL: DiscoveredTool = {
  name: EXECUTE_OPERATION_TOOL,
  description: EXECUTE_OPERATION_TOOL_DESCRIPTION,
  inputSchema: EXECUTE_OPERATION_TOOL_SCHEMA,
};

/** 包一层 TurnDriver，把内部 exec 路由工具追加到脚本夹具的每回合工具面。 */
export function withInternalExecTool(driver: TurnDriver): TurnDriver {
  return {
    ...driver,
    run: (input: TurnDriverInput) => driver.run({
      ...input,
      tools: [...input.tools, INTERNAL_EXEC_TOOL],
    }),
  };
}
