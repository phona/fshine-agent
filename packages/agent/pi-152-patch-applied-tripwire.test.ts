/**
 * 常驻绊线：Pi 1.5.2 依赖补丁必须处于「已打上」状态。
 *
 * 背景：U1/U2 修复以 `patches/` 里的 patch-package 补丁交付，node_modules 不在版本库里。
 * 一旦有人 `patch-package --reverse`、漏跑 `postinstall`、或 `npm ci` 后没打补丁，
 * 行为会静默回到上游缺陷（输出被夹到 1 token / 空摘要入库）。
 *
 * 本文件只断言「补丁存在且生效」，不重复 U1/U2 的完整行为用例
 * （那些在 pi-152-u1-output-floor.test.ts / pi-152-u2-empty-summary.test.ts）：
 *   ① `clampMaxTokensToContext` 实现里带 `derivedFloor` 参数（源码字符串）；
 *   ② 未显式指定 maxTokens、room 极小时返回值 ≥ 1024；显式 maxTokens=10 时不被抬高；
 *   ③ `SessionManager.appendCompaction` 实现里带空摘要拒绝（源码字符串）；
 *   ④ `appendCompaction('')` 实际抛错。
 *
 * 补丁被 reverse 或漏打时本文件必须红；补丁就位时必须绿。
 */
import { describe, expect, it } from 'vitest';
import { buildBaseOptions, clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

const API = 'openai-completions' as Api;
const CHARS_PER_TOKEN = 3.5;

function modelWith(maxTokens: number, contextWindow = 16_384): Model<Api> {
  return {
    id: 'tripwire-model',
    name: 'tripwire-model',
    provider: 'llm',
    api: API,
    baseUrl: 'https://example.invalid',
    contextWindow,
    maxTokens,
  } as unknown as Model<Api>;
}

/** 估算为 `tokens` 的上下文：pi-ai 口径 ceil(chars / 3.5)。 */
function contextWith(tokens: number): never {
  const chars = Math.ceil(tokens * CHARS_PER_TOKEN);
  return { systemPrompt: '', messages: [{ role: 'user', content: 'x'.repeat(chars), timestamp: 1 }] } as never;
}

describe('Pi 1.5.2 补丁已生效（常驻绊线）', () => {
  it('U1：clampMaxTokensToContext 源码含 derivedFloor 下限语义', () => {
    expect(clampMaxTokensToContext.toString()).toContain('derivedFloor');
  });

  it('U1：未显式 maxTokens 且 room 极小时 cap ≥ 1024（上游会落到 1）', () => {
    // 窗口 16384 / margin 4096：input=14000 ⇒ room<0
    expect(buildBaseOptions(modelWith(2048), contextWith(14_000), undefined, 'k').maxTokens)
      .toBeGreaterThanOrEqual(1024);
  });

  it('U1：显式 maxTokens=10 不被下限抬高（≤10）', () => {
    expect(buildBaseOptions(modelWith(2048), contextWith(14_000), { maxTokens: 10 }, 'k').maxTokens)
      .toBeLessThanOrEqual(10);
  });

  it('U2：SessionManager.appendCompaction 源码含空摘要拒绝', () => {
    expect(SessionManager.prototype.appendCompaction.toString())
      .toContain('Refusing to append a compaction entry');
  });

  it('U2：appendCompaction("") 实际抛错，不落检查点', () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: 'user', content: '项目代号是「蓝鲸-42」，请记住。', timestamp: 1 } as never);
    const firstKeptEntryId = manager.getEntries()[0]!.id!;

    expect(() => manager.appendCompaction('', firstKeptEntryId, 100, undefined, false, undefined))
      .toThrow(/empty summary/i);
    expect(manager.getEntries().filter((entry) => entry.type === 'compaction')).toHaveLength(0);
  });
});
