/**
 * 可见契约对齐守卫（fix/visible-contract，2026-11-20）：模型可见面的「确认句柄绑定语义」
 * 必须与执行层的确定性校验一致——records 也纳入绑定，commit 必须携带与提案一致的 records。
 *
 * 背景（工效诊断确定性结论）：技能文面与 operations.json 的 --confirmation desc 都只说
 * 「绑定 collection/window/count」，但执行层 bin/dummy.cjs 的 sameRecords 检查把 records
 * 也纳入绑定。模型照可见语义办事 → commit 漏 records → 必拒。修法是只改模型可见面的描述，
 * 执行层校验（sameRecords / one-shot / 过期）一个字不改。
 *
 * 本套件是**反向绊线**：把描述改回旧文案（漏 records）必须红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES_ROOT = __dirname;
const SKILL = path.join(FIXTURES_ROOT, 'dummy-platform', '.agents', 'skills-serve', 'dummy-routing', 'SKILL.md');
const CAPABILITIES = path.join(FIXTURES_ROOT, 'platforms', 'dummy-platform', 'capabilities.json');
const GOLDEN = path.join(FIXTURES_ROOT, 'dummy-platform', '__golden__', 'operations-list.json');

/** dummy.commit 的 --confirmation desc 必须写明 records 纳入绑定、提交要带与提案一致的 records。 */
function expectBindingMentionsRecords(desc: string): void {
  expect(desc, desc).toMatch(/bound to collection\/window\/count\/records/);
  // 「不写 records 会被拒」这一条必须可见——这正是 7 连红的直接原因。
  expect(desc, desc).toMatch(/records identical to the proposal/);
}

describe('可见契约：确认句柄绑定 records（模型可见面与执行层一致）', () => {
  it('① SKILL.md 的 commit 行写明 records 纳入绑定、提交必须携带与提案一致的 records', () => {
    const skill = readFileSync(SKILL, 'utf8');
    const commitLine = skill.split('\n').find((line) => line.includes('`dummy.commit`'));
    expect(commitLine).toBeDefined();
    expect(commitLine).toMatch(/绑定 collection\/window\/count\/records（与提案完全一致）/);
    expect(commitLine).toMatch(/提交必须携带与提案一致的 records/);
    // 反向绊线：旧文案（只写 collection/window/count）不得复活。
    expect(commitLine).not.toMatch(/绑定 collection\/window\/count、15/);
  });

  it('② capabilities.json 的 dummy.commit --confirmation desc 写明 records 绑定', () => {
    const caps = JSON.parse(readFileSync(CAPABILITIES, 'utf8')) as {
      operations: Array<{ name: string; args?: { flags?: Array<{ flag: string; desc?: string }> } }>;
    };
    const commit = caps.operations.find((op) => op.name === 'dummy.commit');
    expect(commit).toBeDefined();
    const confirmation = commit!.args?.flags?.find((flag) => flag.flag === '--confirmation');
    expect(confirmation).toBeDefined();
    expectBindingMentionsRecords(confirmation!.desc ?? '');
  });

  it('③ payload schema 的 description 补「提交必须携带与提案一致的 records」', () => {
    for (const source of [readFileSync(CAPABILITIES, 'utf8'), readFileSync(GOLDEN, 'utf8')]) {
      expect(source).toContain('On commit, the submitted records must match the proposal exactly');
    }
  });
});
