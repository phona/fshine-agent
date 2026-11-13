import { describe, expect, it } from 'vitest';
import { loadConfig } from '@fshine/core';
import { explicitConfigFrom, materializeEvalConfig } from './resolve-config-path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('explicitConfigFrom', () => {
  it('--config= 命令行优先于 AGENT_CONFIG_PATH 环境变量', () => {
    expect(explicitConfigFrom(['node', 'x.ts', '--config=/from/cli.yaml'], { AGENT_CONFIG_PATH: '/from/env.yaml' }))
      .toBe('/from/cli.yaml');
  });

  it('无命令行参数时取 AGENT_CONFIG_PATH', () => {
    expect(explicitConfigFrom(['node', 'x.ts'], { AGENT_CONFIG_PATH: '/from/env.yaml' }))
      .toBe('/from/env.yaml');
  });

  it('两者都没有 / 空白 → undefined', () => {
    expect(explicitConfigFrom(['node', 'x.ts'], {})).toBeUndefined();
    expect(explicitConfigFrom(['node', 'x.ts'], { AGENT_CONFIG_PATH: '   ' })).toBeUndefined();
    expect(explicitConfigFrom(['node', 'x.ts', '--config=   '], { AGENT_CONFIG_PATH: '/from/env.yaml' }))
      .toBe('/from/env.yaml');
  });
});

describe('materializeEvalConfig', () => {
  function writeEvalConfig(dir: string): string {
    const p = path.join(dir, 'eval.agent.yaml');
    writeFileSync(p, [
      'principals:',
      '  "wecom:eval-fixture-user":',
      '    accountSetScope: all',
      '    enabled: true',
      'contextProfiles:',
      '  stock:',
      '    root: scripts/eval/fixtures/stock-platform',
      '    gateway: bin/stock',
      '    skillRoots: ["./skills-serve"]',
      '',
    ].join('\n'));
    return p;
  }

  it('相对 root 物化成仓根绝对路径，且 loadConfig 真能加载产物', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'materialize-eval-test-'));
    try {
      const out = path.join(tmp, 'out.yaml');
      const returned = materializeEvalConfig(writeEvalConfig(tmp), out);
      expect(returned).toBe(out);
      const text = readFileSync(out, 'utf8');
      const expectedRoot = path.resolve(REPO_ROOT, 'scripts/eval/fixtures/stock-platform');
      expect(text).toContain(`root: ${expectedRoot}`);
      // blocking 判据的实处：物化产物过得了 loadConfig 的绝对路径校验（config.ts:125）。
      const loaded = loadConfig({ env: {}, yamlPath: out });
      expect(loaded.contextProfiles['stock']?.root).toBe(expectedRoot);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('绝对路径 root 原样保留', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'materialize-eval-test-'));
    try {
      const src = path.join(tmp, 'eval.agent.yaml');
      writeFileSync(src, [
        'principals:',
        '  "wecom:eval-fixture-user":',
        '    accountSetScope: all',
        '    enabled: true',
        'contextProfiles:',
        '  stock:',
        '    root: /abs/stock-platform',
        '    gateway: bin/stock',
        '    skillRoots: ["./skills-serve"]',
        '',
      ].join('\n'));
      const out = path.join(tmp, 'out.yaml');
      materializeEvalConfig(src, out);
      expect(readFileSync(out, 'utf8')).toContain('root: /abs/stock-platform');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
