/**
 * 技能装载：Worker 域正文 + Main 域 catalog（Skill 优先：领域程序性知识放技能，不进宿主提示词补丁）。
 *
 * · Worker：ask / server 从 profile 声明的 skillRoots 读取 SKILL.md 正文（相对 profile.root
 *   解析），交给回合运行时嵌入委派提示；
 * · Main：固定从 `<repo>/.agents/skills` 发现，提示只接 name+description 清单，正文经 read_skill
 *   按需读取（无 inline 投递、无模式开关、无配置键）。
 * 读取失败向上抛（技能面坏了不静默降级成"没有技能"）。
 */
import path from 'node:path';
import { resolveRepoRoot } from './repo-root';
import {
  createSkillRegistry,
  renderSkillCatalog,
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

/**
 * Main 技能目录相对仓库根的固定位置——**唯一机制**：Main 技能只从 `<repo>/.agents/skills`
 * 发现；没有 inline 投递、没有模式开关、没有配置键，也不接受 profile 声明。
 */
export const MAIN_SKILLS_RELATIVE_DIR = path.join('.agents', 'skills');

/**
 * 生产 Main 技能目录：`<repo>/.agents/skills`。
 *
 * 仓库根用标记法自模块位置向上定位（`repo-root.ts`），**不用 `process.cwd()`**——宿主
 * 可能以任意目录启动，cwd 不是可信定位依据。定位失败即抛错（fail-closed）。
 */
export function defaultMainSkillsDir(): string {
  return path.join(resolveRepoRoot(), MAIN_SKILLS_RELATIVE_DIR);
}

/** Main 技能投递产物：catalog 提示块 + 证据用字节数 + 按需读取登记表。 */
export interface MainSkillDelivery {
  /** 追加到 mainSystemPrompt 的块；空串 = 零增长（空/缺失技能目录时提示逐字节不变）。 */
  promptBlock: string;
  /** catalog 原文（name+description 清单，不含正文、不含路径）；空索引 = 空串。 */
  catalog: string;
  /** catalog 的 UTF-8 字节数（进证据/日志；空索引 = 0）。 */
  catalogBytes: number;
  /** `read_skill` 的 Main 工具面登记表；catalog 为空时不给出（read_skill 不注册）。 */
  registry?: SkillRegistry;
}

/** name 升序的稳定排序（按 code unit 比较；与 locale 无关，跨环境一致）。 */
function compareSkillNames(a: SkillSummary, b: SkillSummary): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/**
 * Main 技能投递（catalog + 按需读取，唯一形态）：
 *   · 提示只接 name+description 清单（`renderSkillCatalog`）；正文不进提示；
 *   · 可读字节数与清单同源（`catalogBytes`），供证据/日志记录，不另算一遍；
 *   · catalog 非空才给出 `read_skill` 登记表——空索引时 Main 工具面不加任何工具；
 *   · 重名由 `FileSkillRegistry.discover` 既有校验 fail-closed；
 *   · 读取只允许 `<mainSkillsDir>` 内（`skills.ts` 的 realpath 包含校验 + 名称禁 `/`）；
 *   · 读取失败向上抛（技能面坏了不静默降级，与 loadWorkerSkills 同纪律）。
 *
 * `mainSkillsDir` 只允许由装配参数给出（生产缺省见 `defaultMainSkillsDir`），不读配置键。
 */
export async function loadMainSkillDelivery(mainSkillsDir: string): Promise<MainSkillDelivery> {
  // 相对路径会按进程 cwd 解析——cwd 不是可信定位依据，一律拒绝（fail-closed）。
  if (!path.isAbsolute(mainSkillsDir)) {
    throw new Error(`Main 技能目录必须是绝对路径（不接受按 cwd 解析的相对路径）：${mainSkillsDir}`);
  }
  const registry = createSkillRegistry({ rootDir: path.resolve(mainSkillsDir) });
  const summaries: readonly SkillSummary[] = (await registry.discover())
    .map(({ name, description }) => ({ name, description }))
    .sort(compareSkillNames);
  const catalog = renderSkillCatalog(summaries);
  if (catalog === '') return { promptBlock: '', catalog: '', catalogBytes: 0 };
  return {
    promptBlock: `\n\n${catalog}`,
    catalog,
    catalogBytes: Buffer.byteLength(catalog, 'utf8'),
    registry,
  };
}
