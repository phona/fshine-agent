/**
 * 编排层业务 skill 的加载链（架构 §5 / roadmap Phase 6）。
 *
 * 配置 → 文件 → runtime deps.businessSkill，只此一条路径：
 *   config/agent.yaml 的可选项 `businessSkillPath`（默认 docs/business-skill.md）
 *   → 存在才读，读到的静态程序性知识由 runtime 每回合追加进系统提示词。
 * 文件缺失 / 读失败 / 配置不可读 = 跳过，不影响启动（功能降级不报错）。
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 业务 skill 的默认位置（可用配置项或环境变量覆盖）。 */
export const DEFAULT_BUSINESS_SKILL_PATH = 'docs/business-skill.md';
/** 注入提示词的业务 skill 上限：它是静态程序性知识，不该把上下文挤爆。 */
export const MAX_BUSINESS_SKILL_CHARS = 8000;

/**
 * 解析业务 skill 路径：环境变量 > config/agent.yaml 的 `businessSkillPath` > 默认值。
 *
 * 直接读 YAML 原文而不是走 `loadConfig`：AppConfig 的类型契约在 @fshine/contracts，
 * 该字段尚未进入契约；读原文对本 Phase 自含，契约补齐后行为不变（同一个键、同一份默认值）。
 */
export function resolveBusinessSkillPath(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['BUSINESS_SKILL_PATH']?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const yamlPath = env['AGENT_CONFIG_PATH'] ?? path.join(repoRoot, 'config', 'agent.yaml');
  try {
    const raw = parseYaml(readFileSync(yamlPath, 'utf8')) as unknown;
    const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { config?: unknown }).config : undefined;
    const configured = root && typeof root === 'object' && !Array.isArray(root)
      ? (root as { businessSkillPath?: unknown }).businessSkillPath
      : undefined;
    if (typeof configured === 'string' && configured.trim()) return path.resolve(repoRoot, configured.trim());
  } catch { /* 配置文件不可读：走默认路径，启动不因此失败 */ }
  return path.join(repoRoot, DEFAULT_BUSINESS_SKILL_PATH);
}

/** 读业务 skill 文本；文件缺失/读失败 = text 为 undefined（降级，不报错）。 */
export async function loadBusinessSkill(env: NodeJS.ProcessEnv): Promise<{ path: string; text?: string }> {
  const skillPath = resolveBusinessSkillPath(env);
  try {
    const text = (await readFile(skillPath, 'utf8')).trim();
    return text ? { path: skillPath, text: text.slice(0, MAX_BUSINESS_SKILL_CHARS) } : { path: skillPath };
  } catch {
    return { path: skillPath };
  }
}
