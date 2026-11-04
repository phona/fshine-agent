import { describe, expect, it } from 'vitest';
import { gatewayExecPath, gatewayExecPathForProfile, validateGatewayInvocation } from './platform-contract';

describe('profile 声明的网关名', () => {
  it('profile.gateway 派生 spawn 路径', () => {
    expect(gatewayExecPathForProfile('/opt/platform', { gateway: 'bin/dummy' })).toBe('/opt/platform/bin/dummy');
    expect(gatewayExecPath('/opt/platform', 'bin/dummy')).toBe('/opt/platform/bin/dummy');
  });
  it('未声明 gateway 时 fail-closed，不回退旧值', () => {
    expect(() => gatewayExecPathForProfile('/opt/platform', {})).toThrowError(/gateway/);
    expect(() => gatewayExecPathForProfile('/opt/platform', { gateway: '../escape' })).toThrowError(/gateway/);
    expect(() => gatewayExecPathForProfile('/opt/platform', { gateway: '/abs/bin' })).toThrowError(/gateway/);
  });
  it('validateGatewayInvocation 拒绝 shell 元字符', () => {
    expect(validateGatewayInvocation('bin/17dz')).toBe(true);
    expect(validateGatewayInvocation('bin/17dz; rm')).toBe(false);
    expect(validateGatewayInvocation('')).toBe(false);
  });
});
