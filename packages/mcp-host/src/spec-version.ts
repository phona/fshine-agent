/**
 * specVersion 校验(17dz-mcp-spec §5.1 / v0-implementation-decisions §4)。
 * 纯函数,可独立单测。
 */
import { isRecord } from './utils';

/** 0.6 is the deployed 17dz server contract. Keep 0.5 during the rollout so
 * existing read-only deployments remain usable; tools/list still supplies the
 * runtime schema and host policy remains the authorization boundary. */
export const SUPPORTED_SPEC_VERSIONS = ['0.5', '0.6'] as const;
export const EXPECTED_SPEC_VERSION = '0.6';

export class SpecVersionMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(
      `17dz MCP server 的 specVersion 不兼容:支持 ${SUPPORTED_SPEC_VERSIONS.join('/')}，实际 ${actual ?? '(缺失)'}。已拒绝使用该 server,请由运维升级或修正部署后重试。`,
    );
    this.name = 'SpecVersionMismatchError';
  }
}

export function checkServerSpecVersion(serverInfo: unknown): void {
  const actual =
    isRecord(serverInfo) && typeof serverInfo['specVersion'] === 'string'
      ? serverInfo['specVersion']
      : null;
  if (actual === null || !(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(actual)) {
    throw new SpecVersionMismatchError(EXPECTED_SPEC_VERSION, actual);
  }
}
