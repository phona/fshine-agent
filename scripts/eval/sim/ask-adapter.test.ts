/**
 * 被测系统适配器单测：复用生产同源装配的 fail-closed 门（无密钥先验拒绝，不烧样本）。
 * 不触网、不调真实模型。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAskRuntimeSystem } from './ask-adapter';

const TMP_DIRS: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sim-adapter-'));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ask 装配适配器', () => {
  it('无 LLM_API_KEY → 先验拒绝（不伪装跑通）', async () => {
    await expect(
      createAskRuntimeSystem({ runtimeDir: tmpRoot(), sessionId: 'sim-session-1', env: {} }),
    ).rejects.toThrow(/LLM_API_KEY/);
  });
});
