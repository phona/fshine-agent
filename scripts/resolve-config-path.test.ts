import { describe, expect, it } from 'vitest';
import { resolveConfigPathInternal } from './resolve-config-path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
