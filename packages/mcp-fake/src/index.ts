/** W1-A:Fake17dzMcpServer(spec docs/17dz-mcp-spec.md v0.5 的契约替身)。 */
export { createFakeServerTransport, PROTOCOL_VERSION, SERVER_NAME, WRITE_SERVER_NAME, SERVER_VERSION, SPEC_VERSION } from './server';
export type { FakeServerOptions, FakeServerTransport } from './server';
export { TOOL_DEFINITIONS, toolDefinitionFor } from './schemas';
export type { ToolDefinition, JsonSchema } from './schemas';
export { ACCOUNT_SETS, CURRENT_PERIOD, voucherTotalFor } from './registry';
