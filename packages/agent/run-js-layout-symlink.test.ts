/**
 * run_js 运行目录**树内**软链收窄（2026-11-17 补）。
 *
 * 背景：布局项本身校验（`out`/`in`/... 是真目录）挡不住「树内条目是软链」——
 * `--allow-fs-read=<runDir>` 放行整个 run 目录，树内软链会被跟随。实测（修复前）：
 * `in/evil.txt → /etc/passwd` 可被脚本 `readFileSync` 读到 1275 字节。
 *
 * 判据：run 目录树下不允许存在任何软链；发现即拒跑（脚本零执行、零产物、零 file_refs）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import { createFileStore, type FileStore } from './src/file-store';
import {
  createRunJsExecutor,
  RUN_JS_LAYOUT_UNSAFE_MESSAGE,
  RunJsLayoutUnsafeError,
} from './src/run-js-executor';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const SCOPE = { principalId: 'wecom:u-symlink', sessionId: 'symlink-nested' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 预植钩子：在宿主建目录之后、物化之前把软链写进 run 目录树。 */
function plantingFileStore(fileStore: FileStore, plant: (runDir: string) => void): FileStore {
  return {
    ...fileStore,
    materializeInputs(input) {
      mkdirSync(input.runDir, { recursive: true });
      plant(input.runDir);
      return fileStore.materializeInputs(input);
    },
  };
}

function makeFixture(plant: (runDir: string) => void) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'run-js-symlink-'));
  dirs.push(fixtureRoot);
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  const executor = createRunJsExecutor({
    fileStore: plantingFileStore(fileStore, plant),
    nodeModulesDir: NODE_MODULES,
  });
  return { fixtureRoot, store, fileStore, executor };
}

/** 读 in/evil.txt：读得到就是漏洞，读不到就是 BLOCKED。 */
const READ_EVIL = [
  "const fs = require('fs');",
  "let out = 'BLOCKED';",
  "try { const b = fs.readFileSync('in/evil.txt', 'utf8'); out = 'READ_OK:' + b.length; } catch (e) { out = 'BLOCKED:' + e.code; }",
  'console.log(out);',
].join('\n');

describe('run_js 树内软链收窄', () => {
  it('in/evil.txt → /etc/passwd（文件级软链）：整轮拒跑，脚本零执行', async () => {
    const { store, executor } = makeFixture((runDir) => {
      mkdirSync(path.join(runDir, 'in'), { recursive: true });
      writeFileSync(path.join(runDir, 'in', 'real.txt'), 'real', 'utf8');
      symlinkSync('/etc/passwd', path.join(runDir, 'in', 'evil.txt'));
    });

    await expect(
      executor.runJs({ code: READ_EVIL, inputs: [], scope: SCOPE }),
    ).rejects.toBeInstanceOf(RunJsLayoutUnsafeError);
    expect(store.listFileRefs(SCOPE)).toEqual([]);
    await expect(
      executor.runJs({ code: READ_EVIL, inputs: [], scope: SCOPE }),
    ).rejects.toThrow(RUN_JS_LAYOUT_UNSAFE_MESSAGE);
  }, 60_000);

  it('嵌套目录里的软链（in/sub/x → /etc/passwd）同样拒跑', async () => {
    const { store, executor } = makeFixture((runDir) => {
      mkdirSync(path.join(runDir, 'in', 'sub'), { recursive: true });
      symlinkSync('/etc/passwd', path.join(runDir, 'in', 'sub', 'x'));
    });
    await expect(
      executor.runJs({ code: 'console.log(1);', inputs: [], scope: SCOPE }),
    ).rejects.toBeInstanceOf(RunJsLayoutUnsafeError);
    expect(store.listFileRefs(SCOPE)).toEqual([]);
  }, 60_000);

  it('回归：正常 run 目录（无软链）照常执行并产出', async () => {
    const { executor } = makeFixture((runDir) => {
      mkdirSync(path.join(runDir, 'in'), { recursive: true });
      writeFileSync(path.join(runDir, 'in', 'real.txt'), 'real', 'utf8');
    });
    const result = await executor.runJs({
      code: [
        "const fs = require('fs');",
        "fs.writeFileSync('out/结果.txt', fs.readFileSync('in/real.txt', 'utf8') + '-ok');",
        "console.log('done');",
      ].join('\n'),
      inputs: [],
      scope: SCOPE,
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.name).toBe('结果.txt');
  }, 60_000);
});
