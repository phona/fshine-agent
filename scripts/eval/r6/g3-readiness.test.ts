/**
 * R6 测试基建 · 确定性自证：G3 就绪核查（可确定性部分）。
 * 真实模型项断言为「待 Wave1 前冒烟」，不冒充通过。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runG3Checks, checkPrincipalIsolation, wave1SmokeItems, type G3Inputs } from './g3-readiness';
import { DEFAULT_CONTEXT_WINDOW } from '../../../packages/agent/src/pi-driver';

const repoRoot = process.cwd();
const inputs: G3Inputs = {
  repoRoot,
  platformRoot: path.join(repoRoot, 'scripts', 'eval', 'fixtures', 'dummy-platform'),
  expectedContextWindow: DEFAULT_CONTEXT_WINDOW,
  env: {},
};

describe('G3 就绪核查（确定性）', () => {
  it('确定性四项（窗口/dummy/principal/证据）全部 pass', () => {
    const { items, deterministicAllPass } = runG3Checks(inputs);
    const det = items.filter((i) => i.kind === 'deterministic');
    expect(det).toHaveLength(4);
    for (const item of det) expect(item.status, `${item.id}: ${item.detail}`).toBe('pass');
    expect(deterministicAllPass).toBe(true);
  });

  it('principal 隔离探针：越权取任务抛 TaskOwnershipError', () => {
    const item = checkPrincipalIsolation();
    expect(item.status).toBe('pass');
    expect(item.detail).toContain('TaskOwnershipError');
  });

  it('dummy 隔离：真实平台根（夹具之外）应当 fail', () => {
    const bad = runG3Checks({ ...inputs, platformRoot: '/tmp/real-platform' });
    const d = bad.items.find((i) => i.id === 'G3-D')!;
    expect(d.status).toBe('fail');
  });

  it('真实模型项标注待 Wave1 前冒烟，不冒充通过', () => {
    const smoke = wave1SmokeItems();
    expect(smoke.length).toBeGreaterThan(0);
    expect(smoke.every((i) => i.status === 'wave1-smoke-pending')).toBe(true);
  });
});
