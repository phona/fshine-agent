import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSkillRegistry, isInside, SKILL_CONTENT_LIMIT_BYTES, listSkills, parseFrontmatter, stripQuotes } from './src/skills';

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

/**
 * issue #72：`stripQuotes` / `isInside` 合并成 `./src/skills` 的唯一导出后的行为钉子。
 *
 * `stripQuotes` 合并前有两份私有副本：`agent-profile.ts`（正则）与本文件（首尾判断）。
 * 两者在**可达输入域**上逐字一致；差异只在两类输入上，而两类都进不来（见下方用例注释）。
 */
describe('stripQuotes：合并后唯一实现的行为钉子', () => {
  /** 合并前的「首尾判断」实现（issue #72 删掉的那份副本），仅用于证明可达域一致。 */
  function manualStrip(value: string): string {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      return value.slice(1, -1).trim();
    }
    return value;
  }

  it('可达输入域（无首尾空白的 frontmatter 值）上与旧实现逐字一致', () => {
    // frontmatter 按行解析，两个调用点（parseFrontmatter / parseProfile）都先 trim 再调，
    // 所以值不可能带首尾空白、也不可能含换行——这里把这类输入全列一遍。
    const reachable = [
      'plain', '"quoted"', "'quoted'", '""', "''", '"a', "a'", 'a"b',
      '"', "'", '', '"  inner  "', '""""', "''''", '"a""', 'name:ish', '- dash',
      '2000', 'true',
    ];
    for (const value of reachable) expect(stripQuotes(value)).toBe(manualStrip(value));
  });

  it('剥一对首尾引号后仍 trim 内层空白（与旧实现同一口径）', () => {
    expect(stripQuotes('"  Finance  "')).toBe('Finance');
    expect(stripQuotes("'  Finance  '")).toBe('Finance');
  });

  it('首尾不是同一对引号时原样返回（不解释任意 YAML）', () => {
    expect(stripQuotes('"unclosed')).toBe('"unclosed');
    expect(stripQuotes('"')).toBe('"');
    expect(stripQuotes("mixed'\"")).toBe("mixed'\"");
  });

  it('两类进不来的输入被显式钉住：首尾空白与内含换行（合并后方差在此，勿当回归修）', () => {
    // ① 值自带首尾空白：正则版无条件 trim，旧首尾判断版不 trim。
    expect(stripQuotes('  "padded"  ')).toBe('"padded"');
    expect(manualStrip('  "padded"  ')).toBe('  "padded"  ');
    // ② 值内含换行：正则版 `.` 不匹配换行 → 原样返回；旧首尾判断版会剥掉引号。
    expect(stripQuotes('"line1\nline2"')).toBe('"line1\nline2"');
    expect(manualStrip('"line1\nline2"')).toBe('line1\nline2');
    // 两个调用点都先 trim：frontmatter 侧这条差异不可观测。
    expect(parseFrontmatter('---\nname:  "finance"  \ndescription: d\n---\n# b')).toEqual({ name: 'finance', description: 'd' });
  });
});

describe('isInside：合并后唯一实现的行为钉子', () => {
  it('严格包含：根自身、父目录逃逸、前缀碰撞都不算根内', () => {
    const root = path.resolve('/workspace/root');
    expect(isInside(root, path.resolve('/workspace/root/a/b'))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, path.resolve('/workspace'))).toBe(false);
    // 前缀碰撞：`root-other` 与 `root` 只差后缀，不算根内。
    expect(isInside(root, path.resolve('/workspace/root-other/x'))).toBe(false);
    expect(isInside(path.resolve('/a/b'), path.resolve('/c/d'))).toBe(false);
  });
});
