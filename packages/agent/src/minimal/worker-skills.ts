/**
 * Worker 域技能装载（Skill 优先：领域程序性知识放技能，不进宿主提示词补丁）。
 *
 * 装配方共用：demo:minimal / ask / server 都从 profile 声明的 skillRoots 读取
 * SKILL.md 正文（相对 profile.root 解析），交给 Minimal runtime 嵌入委派提示。
 * 读取失败向上抛（技能面坏了不静默降级成"没有技能"）。
 */
import path from 'node:path';
import { createSkillRegistry } from '../skills';
import type { MinimalWorkerSkill } from './execution-runtime';

export async function loadWorkerSkills(root: string, skillRoots: readonly string[]): Promise<MinimalWorkerSkill[]> {
  const loaded: MinimalWorkerSkill[] = [];
  for (const relative of skillRoots) {
    const registry = createSkillRegistry({ rootDir: path.join(root, relative) });
    for (const metadata of await registry.discover()) {
      const skill = await registry.read(metadata.name);
      loaded.push({ name: skill.name, content: skill.content });
    }
  }
  return loaded;
}
