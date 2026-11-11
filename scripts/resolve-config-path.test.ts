import { describe, expect, it } from 'vitest';
import { loadConfig } from '@fshine/core';
import { explicitConfigFrom, materializeEvalConfig, resolveConfigPath, resolveConfigPathInternal } from './resolve-config-path';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveConfigPath', () => {
  function makeFiles(
    rootConfigExists: boolean,
    evalConfigExists: boolean,
  ): { rootConfig: string; evalConfig: string; cleanup: () => void } {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'resolve-config-path-test-'));
    const rootConfig = path.join(tmpRoot, 'agent.yaml');
    const evalConfig = path.join(tmpRoot, 'eval.agent.yaml');
    if (rootConfigExists) writeFileSync(rootConfig, '');
    if (evalConfigExists) writeFileSync(evalConfig, '');
    return {
      rootConfig,
      evalConfig,
      cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }),
    };
  }

  it('分支 1：显式入参优先（trim 后直接返回）', () => {
    const { cleanup } = makeFiles(false, false);
    try {
      expect(resolveConfigPathInternal('/custom/path.yaml', '/nonexistent/a', '/nonexistent/b'))
        .toBe('/custom/path.yaml');
    } finally {
      cleanup();
    }
  });

  it('分支 1：显式入参为空白串时视为未传入', () => {
    const { rootConfig, evalConfig, cleanup } = makeFiles(true, true);
    try {
      const result = resolveConfigPathInternal('  ', rootConfig, evalConfig);
      expect(result).not.toBe('  ');
      expect(result).toBe(rootConfig);
    } finally {
      cleanup();
    }
  });

  it('分支 2：无显式入参、根配置存在 → 返回根配置', () => {
    const { rootConfig, evalConfig, cleanup } = makeFiles(true, true);
    try {
      expect(resolveConfigPathInternal(undefined, rootConfig, evalConfig)).toBe(rootConfig);
    } finally {
      cleanup();
    }
  });

  it('分支 3：无显式入参、根配置不存在、eval 配置存在 → 返回 eval 配置', () => {
    const { rootConfig, evalConfig, cleanup } = makeFiles(false, true);
    try {
      expect(resolveConfigPathInternal(undefined, rootConfig, evalConfig)).toBe(evalConfig);
    } finally {
      cleanup();
    }
  });

  it('三步都不存在时抛错', () => {
    const { cleanup } = makeFiles(false, false);
    try {
      expect(() => resolveConfigPathInternal(undefined, '/nonexistent/a', '/nonexistent/b'))
        .toThrow('找不到配置文件');
    } finally {
      cleanup();
    }
  });

  it('优先序：显式 > 根配置 > eval 配置', () => {
    const { rootConfig, evalConfig, cleanup } = makeFiles(true, true);
    try {
      expect(resolveConfigPathInternal('/explicit', rootConfig, evalConfig)).toBe('/explicit');
      expect(resolveConfigPathInternal(undefined, rootConfig, evalConfig)).toBe(rootConfig);
    } finally {
      cleanup();
    }
  });
});

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

describe('resolveConfigPath 仓库默认入口', () => {
  it('回退到仓内 eval 配置时物化（返回的路径可被 loadConfig 加载）', () => {
    // 前置：仓内 config/agent.yaml 是 gitignored 的本地文件——本机存在时本用例跳过
    // （CI / fresh clone 无该文件，正是回退分支的战场）。
    const localConfig = path.join(REPO_ROOT, 'config', 'agent.yaml');
    if (existsSync(localConfig)) return;
    const resolved = resolveConfigPath();
    expect(resolved).toContain('.runtime');
    const loaded = loadConfig({ env: {}, yamlPath: resolved });
    expect(Object.keys(loaded.contextProfiles).length).toBeGreaterThan(0);
  });

  it('显式传入仓内 eval 配置时也物化——不认路径怎么拼', () => {
    // 回归钉：resolveConfigPath 原来用 `resolved === EVAL_CONFIG` 原始字符串比较，
    // 而 EVAL_CONFIG 是绝对路径。用相对路径显式指向同一条 eval 配置时不物化，
    // root 留在相对路径，下游 harness 的 spawn(cli, { cwd: platformRoot }) 把相对
    // 路径再解析一次 → ENOENT，报出来却是误导人的 "operation list child error"。
    // 本机 e2e 因此全红过（35 个文件收集阶段即挂）。
    const spellings = [
      path.join('scripts', 'eval', 'eval.agent.yaml'),
      path.join(REPO_ROOT, 'scripts', 'eval', 'eval.agent.yaml'),
      `./${path.join('scripts', 'eval', 'eval.agent.yaml')}`,
    ];
    for (const spelling of spellings) {
      const resolved = resolveConfigPath(spelling);
      expect(resolved, `拼法 ${spelling} 未物化`).toContain('.runtime');
      const loaded = loadConfig({ env: {}, yamlPath: resolved });
      for (const profile of Object.values(loaded.contextProfiles)) {
        expect(path.isAbsolute(profile.root), `拼法 ${spelling} 的 root 不是绝对路径`).toBe(true);
      }
    }
  });
});
