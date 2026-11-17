/**
 * Track A 验收：Main Agent Profile 最小加载器（`src/agent-profile.ts`）。
 *
 * 契约（任务书）：
 * - 缺省路径 = 仓库根 `.agents/agents/fshine-main/agent.md`，与进程 cwd 无关；
 * - 文件缺失 / 不可读 / 内容为空 / frontmatter 有 name 但与文件位置不一致 → 抛可定位错误
 *   （错误信息带路径与原因），绝不静默回退任何旧提示词；
 * - 正常文件 → 返回正文（frontmatter 已剥离）与 sourcePath。
 *
 * 本文件只测加载器语义；三条装配路径的接线（runtime）属 Track D，不在此测。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentProfile } from './src/agent-profile';

/** 旧 buildSystemPrompt(DEFAULT_EXECUTOR_LABEL) 的长度（Track 0 实测 1088 字符）——迁移是收敛，不是搬家。 */
const OLD_PROMPT_CHARS = 1088;

describe('loadAgentProfile：Main Agent Profile 最小加载器', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  const scratch = (): string => {
    directory = mkdtempSync(path.join(tmpdir(), 'fshine-agent-profile-'));
    return directory;
  };
  const writeProfile = (agentName: string, content: string): string => {
    const file = path.join(scratch(), agentName, 'agent.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    return file;
  };
  const captureError = async (promise: Promise<unknown>): Promise<Error> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error('预期抛出错误，但没有抛出（加载器对无效 Profile 静默成功）。');
  };

  it('正常文件：返回正文（frontmatter 剥离、首尾空白裁剪）与 sourcePath', async () => {
    const file = writeProfile('some-agent', '---\nname: some-agent\n---\n\n# 角色\n\n你是面向业务人员的主 Agent。\n');
    await expect(loadAgentProfile({ path: file })).resolves.toEqual({
      instructions: '# 角色\n\n你是面向业务人员的主 Agent。',
      sourcePath: file,
    });
  });

  it('无 frontmatter 的文件同样加载：正文原样返回', async () => {
    const file = writeProfile('plain-agent', '\n只做交互与协作，不做执行。\n\n');
    await expect(loadAgentProfile({ path: file })).resolves.toEqual({
      instructions: '只做交互与协作，不做执行。',
      sourcePath: file,
    });
  });

  it('缺文件：抛可定位错误（带路径与原因 ENOENT）', async () => {
    const missing = path.join(scratch(), 'missing-agent', 'agent.md');
    const error = await captureError(loadAgentProfile({ path: missing }));
    expect(error.message).toContain(missing);
    expect(error.message).toContain('ENOENT');
  });

  it('空文件：抛可定位错误（带路径与「内容为空」原因）', async () => {
    const file = writeProfile('empty-agent', '   \n\n');
    const error = await captureError(loadAgentProfile({ path: file }));
    expect(error.message).toContain(file);
    expect(error.message).toContain('内容为空');
  });

  it('frontmatter name 与文件位置不一致：抛可定位错误（两个名字都在）', async () => {
    const file = writeProfile('located-name', '---\nname: other-name\n---\n正文。\n');
    const error = await captureError(loadAgentProfile({ path: file }));
    expect(error.message).toContain(file);
    expect(error.message).toContain('other-name');
    expect(error.message).toContain('located-name');
  });

  it('缺省路径：就是仓库根 .agents/agents/fshine-main/agent.md，且体量不超过旧 buildSystemPrompt', async () => {
    const profile = await loadAgentProfile();
    expect(profile.sourcePath).toBe(path.resolve(__dirname, '..', '..', '.agents', 'agents', 'fshine-main', 'agent.md'));
    expect(profile.instructions.length).toBeGreaterThan(0);
    expect(profile.instructions.length).toBeLessThanOrEqual(OLD_PROMPT_CHARS);
  });
});
