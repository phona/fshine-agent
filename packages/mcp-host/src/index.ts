/** W2-D 实现:MCP stdio host(生命周期、scope 预检、信封解析、重试)。 */
export { MCP_PROTOCOL_VERSION, McpConnection, McpTransportError } from './connection';
export type { McpConnectionOptions, McpTransportErrorKind } from './connection';
export { parseEnvelope } from './envelope-parse';
export type { EnvelopeParseResult } from './envelope-parse';
export { DEFAULT_CHANNEL_BUDGET_MS, McpHost } from './host';
export type { McpHostAudit, McpHostOptions, McpToolCallEndEvent, McpToolCallStartEvent } from './host';
export { checkServerSpecVersion, EXPECTED_SPEC_VERSION, SpecVersionMismatchError } from './spec-version';
export { trimForRuntime } from './trim';
