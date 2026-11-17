import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSkillRegistry, SKILL_CONTENT_LIMIT_BYTES, listSkills, parseFrontmatter } from './src/skills';

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

  it('rejects duplicate frontmatter names instead of silently letting one shadow the other', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-skills-dup-'));
    for (const dir of ['first', 'second']) {
      await mkdir(path.join(root, dir));
      await writeFile(path.join(root, dir, 'SKILL.md'), [
        '---',
        'name: finance',
        `description: ${dir}`,
        '---',
        '',
        `# ${dir}`,
      ].join('\n'));
    }
    const registry = new FileSkillRegistry({ rootDir: root });
    await expect(registry.discover()).rejects.toThrow('技能名称重复');
    await expect(registry.read('finance')).rejects.toThrow('技能名称重复');
  });

  it('listSkills exposes only name and description (no path, no body)', async () => {
    const root = await fixture();
    await expect(listSkills(root)).resolves.toEqual([{ name: 'finance', description: 'Finance guidance' }]);
  });

  it('keeps the default root at .agents/skills and never merges .agents/skills-serve', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'fshine-skills-root-'));
    const previous = process.cwd();
    process.chdir(base);
    try {
      await mkdir(path.join(base, '.agents', 'skills', 'main-skill'), { recursive: true });
      await mkdir(path.join(base, '.agents', 'skills-serve', 'worker-skill'), { recursive: true });
      await writeFile(path.join(base, '.agents', 'skills', 'main-skill', 'SKILL.md'), '---\nname: main-skill\ndescription: Main side\n---\n');
      await writeFile(path.join(base, '.agents', 'skills-serve', 'worker-skill', 'SKILL.md'), '---\nname: worker-skill\ndescription: Worker side\n---\n');
      const registry = new FileSkillRegistry();
      expect(registry.rootDir).toBe(path.join(base, '.agents', 'skills'));
      await expect(registry.discover()).resolves.toMatchObject([{ name: 'main-skill' }]);
      await expect(registry.read('worker-skill')).rejects.toThrow('未找到技能');
    } finally {
      process.chdir(previous);
    }
  });

  it('skips symlinked entries so a skill cannot escape the discovery root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-skills-link-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'fshine-skills-outside-'));
    await mkdir(path.join(outside, 'escape'));
    await writeFile(path.join(outside, 'escape', 'SKILL.md'), '---\nname: escape\ndescription: Outside\n---\n');
    await symlink(path.join(outside, 'escape'), path.join(root, 'linked'));
    const registry = new FileSkillRegistry({ rootDir: root });
    await expect(registry.discover()).resolves.toEqual([]);
    await expect(registry.read('escape')).rejects.toThrow('未找到技能');
  });

  it('rejects a single skill body beyond the size cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-skills-big-'));
    await mkdir(path.join(root, 'big'));
    await writeFile(path.join(root, 'big', 'SKILL.md'), [
      '---',
      'name: big',
      'description: Oversized',
      '---',
      '',
      'x'.repeat(SKILL_CONTENT_LIMIT_BYTES + 1),
    ].join('\n'));
    const registry = new FileSkillRegistry({ rootDir: root });
    await expect(registry.discover()).resolves.toHaveLength(1);
    await expect(registry.read('big')).rejects.toThrow('超出上限');
  });
});
