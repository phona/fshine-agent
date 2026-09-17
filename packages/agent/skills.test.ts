import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSkillRegistry, parseFrontmatter } from './src/skills';

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-skills-'));
  await mkdir(path.join(root, 'finance', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'finance', 'nested', 'SKILL.md'), [
    '---',
    'name: finance',
    'description: Finance guidance',
    '---',
    '',
    '# Finance',
  ].join('\n'));
  return root;
}

describe('FileSkillRegistry', () => {
  it('discovers SKILL.md recursively and reads by frontmatter name', async () => {
    const root = await fixture();
    const registry = new FileSkillRegistry({ rootDir: root });
    await writeFile(path.join(root, 'ignored.md'), 'not a skill');

    await expect(registry.discover()).resolves.toEqual([{
      name: 'finance',
      description: 'Finance guidance',
      path: path.join(root, 'finance', 'nested', 'SKILL.md'),
    }]);
    await expect(registry.read('finance')).resolves.toMatchObject({ name: 'finance', content: expect.stringContaining('# Finance') });
  });

  it('does not permit path traversal or undeclared skill names', async () => {
    const root = await fixture();
    const registry = new FileSkillRegistry({ rootDir: root });
    await expect(registry.read('../finance')).rejects.toThrow('技能名称无效');
    await expect(registry.read('missing')).rejects.toThrow('未找到技能');
  });

  it('requires both name and description frontmatter', () => {
    expect(parseFrontmatter('# no frontmatter')).toBeUndefined();
    expect(parseFrontmatter('---\nname: finance\n---\n# body')).toBeUndefined();
    expect(parseFrontmatter('---\nname: finance\ndescription: "Finance"\n---\n# body')).toEqual({
      name: 'finance',
      description: 'Finance',
    });
  });
});
