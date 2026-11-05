import { describe, expect, it } from 'vitest';
import { messageFor, planDraftExample, planFileExample } from './error-codes';
import { parsePlanCallsCommand } from './plan-runtime';
import { gatewayTextPatterns } from './platform-contract';
import { isServeCliInvocation, serveMetadataCommand } from './serve-gate';

/**
 * 接口文档 §2：文本识别从 profile.gateway 派生。
 * 注入 bin/generic 时，bin/17dz 不再被认作网关；反之亦然。
 * 未注入时走遗留缺省（旧行为一字不差），这是 §10 的过渡，不是新缺省。
 */
describe('文本识别接线到 profile.gateway', () => {
  it('gatewayTextPatterns 只认注入的网关名', () => {
    const generic = gatewayTextPatterns('bin/generic');
    expect(generic.invocation.test('bin/generic')).toBe(true);
    expect(generic.invocation.test('bin/17dz')).toBe(false);
    expect(generic.plan.test('bin/generic plan')).toBe(true);
    expect(generic.plan.test('bin/17dz plan')).toBe(false);
  });

  it('serve-gate 首词与元数据识别跟随注入网关', () => {
    expect(isServeCliInvocation('bin/generic query x', 'bin/generic')).toBe(true);
    expect(isServeCliInvocation('bin/17dz query x', 'bin/generic')).toBe(false);
    expect(serveMetadataCommand('bin/generic operation list', 'bin/generic')).toBe('operation list');
    expect(serveMetadataCommand('bin/17dz operation list', 'bin/generic')).toBeNull();
  });

  it('plan 令牌定位跟随注入网关', () => {
    const parsed = parsePlanCallsCommand('bin/generic plan {"calls":[{"operation":"dummy.query","args":[]}]}', 'bin/generic');
    expect(parsed).toEqual({ kind: 'inline', calls: [{ operation: 'dummy.query', args: [] }] });
    expect(parsePlanCallsCommand('bin/17dz plan {"calls":[{"operation":"dummy.query","args":[]}]}', 'bin/generic')).toBeNull();
  });

  it('错误文案 correctForm 跟随注入网关；未注入时 fail-closed（C7b 退役回退）', () => {
    expect(planDraftExample('bin/generic')).toBe('bin/generic plan {"goal":"…","calls":[{"operation":"…","args":[…]}]}');
    expect(planFileExample('bin/generic')).toBe('bin/generic plan --file <本轮工作区内的计划文件路径>');
    expect(() => planDraftExample()).toThrow('未声明有效的 profile.gateway');
    const generic = messageFor('PLAN_SHAPE_PREFIX', '```json', undefined, 'bin/generic');
    expect(generic).toContain('bin/generic plan');
    expect(generic).not.toContain('bin/17dz');
    expect(() => messageFor('PLAN_SHAPE_PREFIX', '```json')).toThrow('未声明有效的 profile.gateway');
  });
});
