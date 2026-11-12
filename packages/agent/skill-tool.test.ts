import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolUserError } from './src/driver';
import { SKILL_CONTENT_LIMIT_BYTES } from './src/skills';
import { createReadSkillTool } from './src/skill-tool';

async function skillRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-skill-tool-'));
  await mkdir(path.join(root, 'alpha'));
  await mkdir(path.join(root, 'beta'));
  await writeFile(path.join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha guidance\n---\n\n# Alpha\n正文甲。\n');
  await writeFile(path.join(root, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta guidance\n---\n\n# Beta\n正文乙。\n');
  return root;
}

describe('read_skill 工具桥（按需读取已发现技能）', () => {
  it('returns the full body of a discovered skill', async () => {
    const root = await skillRoot();
    const tool = createReadSkillTool({ rootDir: root });
    const result = await tool.execute('call-1', { name: 'alpha' });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('# Alpha') }]);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('name: alpha') });
    expect(result.details).toEqual({ name: 'alpha' });
  });

  it('rejects an unknown name with an actionable ToolUserError that lists available names', async () => {
    const root = await skillRoot();
    const tool = createReadSkillTool({ rootDir: root });
    const error = await tool.execute('call-2', { name: 'missing' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolUserError);
    const message = (error as Error).message;
    expect(message).toContain('missing');
    expect(message).toContain('alpha');
    expect(message).toContain('beta');
  });

  it('rejects path-shaped names without reading anything outside the discovered list', async () => {
    const root = await skillRoot();
    const tool = createReadSkillTool({ rootDir: root });
    await expect(tool.execute('call-3', { name: '../alpha' })).rejects.toBeInstanceOf(ToolUserError);
    await expect(tool.execute('call-4', { name: 'alpha/SKILL.md' })).rejects.toBeInstanceOf(ToolUserError);
  });

  it('surfaces a failed read as an observable error, never as empty success', async () => {
    const root = await skillRoot();
    await mkdir(path.join(root, 'big'));
    await writeFile(path.join(root, 'big', 'SKILL.md'), `---\nname: big\ndescription: Oversized\n---\n${'x'.repeat(SKILL_CONTENT_LIMIT_BYTES + 1)}`);
    const tool = createReadSkillTool({ rootDir: root });
    await expect(tool.execute('call-5', { name: 'big' })).rejects.toThrow('读取失败');
  });
});
