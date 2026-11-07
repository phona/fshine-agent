/**
 * 统一配置路径解析：显式入参 > 仓根 config/agent.yaml（存在才用）> scripts/eval/eval.agent.yaml。
 *
 * 全仓脚本（probe / acceptance / score）统一走这个 helper，确保 loadConfig 与
 * createServerAssembly 读取的是同一份 YAML，消除「assembly 读 AGENT_CONFIG_PATH
 * / 探针硬编码缺省路径」两条路分流的 wart。
 *
 * eval 不走平台根路径/配置路径类环境变量，改用提交进仓的 eval 配置 + 本 helper 解析。
 * 改用提交进仓的 eval 配置 + 本 helper 解析。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CONFIG = path.join(REPO_ROOT, 'config', 'agent.yaml');
const EVAL_CONFIG = path.join(REPO_ROOT, 'scripts', 'eval', 'eval.agent.yaml');

/** 核心解析逻辑（可被测试直接调用，不依赖仓库实际文件布局）。 */
export function resolveConfigPathInternal(
  explicit: string | undefined,
  rootConfig: string,
  evalConfig: string,
): string {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim();
  }
  if (existsSync(rootConfig)) {
    return rootConfig;
  }
  if (existsSync(evalConfig)) {
    return evalConfig;
  }
  throw new Error(
    '找不到配置文件：未传入显式路径、config/agent.yaml 不存在、scripts/eval/eval.agent.yaml 也不存在',
  );
}

/** 仓库默认入口：用 REPO_ROOT 下的标准路径调用核心逻辑。 */
export function resolveConfigPath(explicit?: string): string {
  return resolveConfigPathInternal(explicit, ROOT_CONFIG, EVAL_CONFIG);
}
