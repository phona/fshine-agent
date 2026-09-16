/**
 * specVersion 校验(17dz-mcp-spec §5.1 / v0-implementation-decisions §4)。
 * 纯函数,可独立单测。
 */
import { isRecord } from './utils';

export const EXPECTED_SPEC_VERSION = '0.5';

export class SpecVersionMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(
      `17dz MCP server 的 specVersion 不匹配:期望 ${expected},实际 ${actual ?? '(缺失)'}。已拒绝使用该 server,请由运维升级或修正部署后重试。`,
    );
    this.name = 'SpecVersionMismatchError';
  }
}

export function checkServerSpecVersion(serverInfo: unknown): void {
  const actual =
    isRecord(serverInfo) && typeof serverInfo['specVersion'] === 'string'
      ? serverInfo['specVersion']
      : null;
  if (actual !== EXPECTED_SPEC_VERSION) {
    throw new SpecVersionMismatchError(EXPECTED_SPEC_VERSION, actual);
  }
}
