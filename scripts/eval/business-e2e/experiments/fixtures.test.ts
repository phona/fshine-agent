/**
 * bizbatch2 · 中性测试 Skill 夹具自测（零模型）。
 *
 * 覆盖：SKILL.md frontmatter 合法可发现；臂 A（inline）拼正文、臂 B（catalog）拼摘要清单 +
 * 给登记表且**不含正文**（泄露绊线）；技能根为空 → 提示零增长（缺省锚点）。
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

  it('臂 A：正文拼进提示块；缺省（空根）：提示零增长', async () => {
    const none = await loadMainSkillDelivery(FIXTURE_ROOT, [], 'inline');
    expect(none.promptBlock).toBe('');
    expect(none.registry).toBeUndefined();

    const inline = await loadMainSkillDelivery(FIXTURE_ROOT, [MAIN_SKILL_ROOT], 'inline');
    expect(inline.promptBlock).toContain('【技能：record-digest】');
    expect(inline.promptBlock).toContain('核对摘要'); // 正文里的口径标记
    expect(Buffer.byteLength(inline.promptBlock, 'utf8')).toBeGreaterThan(100);
    expect(inline.registry).toBeUndefined();
  });

  it('臂 B：提示只拼 name/description 摘要（不含正文），并给出可按需读取的登记表', async () => {
    const catalog = await loadMainSkillDelivery(FIXTURE_ROOT, [MAIN_SKILL_ROOT], 'catalog');
    expect(catalog.registry).toBeDefined();
    expect(catalog.promptBlock).toContain('record-digest');
    expect(catalog.promptBlock).toContain('value-note');
    // 泄露绊线：摘要清单不得含正文（正文标记只在 body 里）。
    expect(catalog.promptBlock).not.toContain('核对摘要');
    expect(catalog.promptBlock).not.toContain('合计');
    // 正文确实可按需读取。
    const body = await catalog.registry!.read('record-digest');
    expect(body.content).toContain('核对摘要');
  });
});
