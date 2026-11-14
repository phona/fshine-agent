/**
 * Worker 域技能装载（Skill 优先：领域程序性知识放技能，不进宿主提示词补丁）。
 *
 * 装配方共用：ask / server 都从 profile 声明的 skillRoots 读取
 * SKILL.md 正文（相对 profile.root 解析），交给回合运行时嵌入委派提示。
 * 读取失败向上抛（技能面坏了不静默降级成"没有技能"）。
 */
import path from 'node:path';
import {
  createSkillRegistry,
  listSkills,
  READ_SKILL_TOOL,
  renderSkillCatalog,
  type SkillMetadata,
  type SkillRegistry,
  type SkillSummary,
} from './skills';
import type { WorkerSkill } from './execution-runtime';

export async function loadWorkerSkills(root: string, skillRoots: readonly string[]): Promise<WorkerSkill[]> {
  const loaded: WorkerSkill[] = [];
  for (const relative of skillRoots) {
    const registry = createSkillRegistry({ rootDir: path.join(root, relative) });
    for (const metadata of await registry.discover()) {
      const skill = await registry.read(metadata.name);
      loaded.push({ name: skill.name, content: skill.content });
    }
  }
  return loaded;
}

/** Main 侧技能投递臂（缺口 2 实验面；缺省 = 不投递，见 loadMainSkillDelivery）。 */
export type MainSkillMode = 'inline' | 'catalog';

/** Main 技能投递产物：提示块 + （臂 B 的）Main 工具面登记表。 */
export interface MainSkillDelivery {
  /** 追加到 mainSystemPrompt 的块；空串 = 零增长（缺省 / 技能根为空时提示逐字节不变）。 */
  promptBlock: string;
  /** 臂 B 的 Main 技能登记表（交 createSession 暴露 read_skill）；臂 A / 缺省 = undefined。 */
  registry?: SkillRegistry;
}

/**
 * Main 侧业务技能投递（缺口 2，实验臂，缺省不投递）：
 *   · 技能根为空 → `{ promptBlock: '' }`：mainSystemPrompt 逐字节不变（金样锚点）；
 *   · mode='inline'（臂 A）：复用 loadWorkerSkills 读 SKILL.md 正文，按 Worker 同款形状拼进提示；
 *   · mode='catalog'（臂 B）：提示只拼 name+description 摘要清单（复用 listSkills + renderSkillCatalog，
 *     空表 → 空串），并把登记表交给 Main 工具面按需 read_skill 读正文（32KiB 上限由 registry 既有钳制）。
 * Main 技能根（mainSkillRoots）与 Worker skillRoots、执行层 .agents/skills-serve 是**不同事实源，不合并**。
 * 读取失败向上抛（技能面坏了不静默降级，与 loadWorkerSkills 同纪律）。
 */
export async function loadMainSkillDelivery(
  root: string,
  mainSkillRoots: readonly string[],
  mode: MainSkillMode,
): Promise<MainSkillDelivery> {
  if (mainSkillRoots.length === 0) return { promptBlock: '' };
  if (mode === 'catalog') {
    const registry = createMultiRootSkillRegistry(root, mainSkillRoots);
    const summaries: readonly SkillSummary[] = (await registry.discover())
      .map(({ name, description }) => ({ name, description }));
    const catalog = renderSkillCatalog(summaries);
    return { promptBlock: catalog === '' ? '' : `\n\n${catalog}`, registry };
  }
  const skills = await loadWorkerSkills(root, mainSkillRoots);
  const promptBlock = skills.length === 0
    ? ''
    : `\n\n${skills.map((skill) => `【技能：${skill.name}】\n${skill.content}`).join('\n\n')}`;
  return { promptBlock };
}

/**
 * 多个技能根合成一个登记表（薄适配 FileSkillRegistry；不新增发现/读取逻辑）——
 * 臂 B 的 read_skill 只按登记表 name 匹配，不做文件名拼接（路径逃逸防护在 skills.ts 既有实现内）。
 */
function createMultiRootSkillRegistry(root: string, skillRoots: readonly string[]): SkillRegistry {
  const registries = skillRoots.map((relative) => createSkillRegistry({ rootDir: path.join(root, relative) }));
  return {
    async discover(): Promise<readonly SkillMetadata[]> {
      const merged: SkillMetadata[] = [];
      const seen = new Set<string>();
      for (const registry of registries) {
        for (const metadata of await registry.discover()) {
          if (seen.has(metadata.name)) throw new Error(`技能名称重复:${metadata.name}`);
          seen.add(metadata.name);
          merged.push(metadata);
        }
      }
      return merged.sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(name: string) {
      for (const registry of registries) {
        const discovered = await registry.discover();
        if (discovered.some((metadata) => metadata.name === name)) return registry.read(name);
      }
      throw new Error(`未找到技能:${name}`);
    },
  };
}
