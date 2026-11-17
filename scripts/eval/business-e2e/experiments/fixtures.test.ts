/**
 * bizbatch2 · 中性测试 Skill 夹具自测（零模型）。
 *
 * 覆盖：SKILL.md frontmatter 合法可发现；catalog 拼 name/description 清单 +
 * 给登记表且**不含正文/路径**（泄露绊线）；空索引 → 提示零增长（缺省锚点）；
 * 清单按 name 升序（稳定排序）。
 *
 * Main 技能只有 catalog 一种形态（inline 已删除）：夹具目录经装配参数 `mainSkillsDir`
 * 传入，不写任何配置键。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSkillRegistry } from '../../../../packages/agent/src/skills';
import { loadMainSkillDelivery } from '../../../../packages/agent/src/worker-skills';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const MAIN_SKILL_ROOT = '.agents/skills-main';

describe('中性测试 Skill 夹具（scripts/eval/fixtures/dummy-platform/.agents/skills-main）', () => {
  it('两个 SKILL.md 可被发现（frontmatter name/description 合法）', async () => {
    const registry = createSkillRegistry({ rootDir: path.join(FIXTURE_ROOT, MAIN_SKILL_ROOT) });
    const found = await registry.discover();
    expect(found.map((s) => s.name).sort()).toEqual(['record-digest', 'value-note']);
    for (const skill of found) expect(skill.description.trim().length).toBeGreaterThan(0);
  });

  it('空索引（目录不存在）：提示零增长、无登记表、字节 = 0', async () => {
    const none = await loadMainSkillDelivery(path.join(FIXTURE_ROOT, '.agents', 'no-such-skills'));
    expect(none.promptBlock).toBe('');
    expect(none.catalog).toBe('');
    expect(none.catalogBytes).toBe(0);
    expect(none.registry).toBeUndefined();
  });

  it('catalog：提示只拼 name/description 摘要（不含正文/路径），并给出可按需读取的登记表', async () => {
    const catalog = await loadMainSkillDelivery(path.join(FIXTURE_ROOT, MAIN_SKILL_ROOT));
    expect(catalog.registry).toBeDefined();
    expect(catalog.promptBlock).toContain('record-digest');
    expect(catalog.promptBlock).toContain('value-note');
    // 泄露绊线：摘要清单不得含正文（正文标记只在 body 里），也不得含绝对路径。
    expect(catalog.promptBlock).not.toContain('核对摘要');
    expect(catalog.promptBlock).not.toContain('合计');
    expect(catalog.promptBlock).not.toContain(FIXTURE_ROOT);
    // 字节数与清单同源。
    expect(catalog.catalogBytes).toBe(Buffer.byteLength(catalog.catalog, 'utf8'));
    // 正文确实可按需读取。
    const body = await catalog.registry!.read('record-digest');
    expect(body.content).toContain('核对摘要');
  });

  it('catalog 清单按 name 升序（record-digest 在 value-note 之前）', async () => {
    const catalog = await loadMainSkillDelivery(path.join(FIXTURE_ROOT, MAIN_SKILL_ROOT));
    expect(catalog.promptBlock.indexOf('record-digest')).toBeLessThan(catalog.promptBlock.indexOf('value-note'));
  });
});
