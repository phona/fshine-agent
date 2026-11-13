/**
 * 统一配置路径解析：显式入口（--config=<path> 命令行 / AGENT_CONFIG_PATH 环境变量）>
 * 仓根 config/agent.yaml（存在才用）> scripts/eval/eval.agent.yaml。
 *
 * 全仓脚本（ask / demo / demo:minimal）统一走这个 helper，确保 loadConfig 与
 * createServerAssembly 读取的是同一份 YAML，消除「assembly 读 AGENT_CONFIG_PATH
 * / 脚本硬编码缺省路径」两条路分流的 wart。
 *
 * eval 回退配置的 root 是仓内相对路径——加载前由本 helper patch 成绝对路径并物化到
 * .runtime 副本（loadConfig 强制 root 绝对，packages/core/src/config.ts:125；
 * patch 模式与旧 e2e harness 的 patchProfile 同源，harness 随 M2 波次 1（2026-11-13）删除）。提交进仓的
 * YAML 因此不含开发者主目录（exposure-lint / history-hygiene 守卫拦绝对路径）、
 * 不依赖任何环境变量（CI / fresh clone 零配置可加载）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CONFIG = path.join(REPO_ROOT, 'config', 'agent.yaml');
const EVAL_CONFIG = path.join(REPO_ROOT, 'scripts', 'eval', 'eval.agent.yaml');
const RUNTIME_DIR = path.join(REPO_ROOT, '.runtime');
const EVAL_MATERIALIZED = path.join(RUNTIME_DIR, 'eval-agent-config.yaml');

/** 入口侧显式配置来源：--config=<path> 命令行优先，其次 AGENT_CONFIG_PATH 环境变量。 */
export function explicitConfigFrom(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const flag = argv.find((a) => a.startsWith('--config='));
  if (flag !== undefined) {
    const value = flag.slice('--config='.length).trim();
    if (value !== '') return value;
  }
  const fromEnv = (env['AGENT_CONFIG_PATH'] ?? '').trim();
  return fromEnv === '' ? undefined : fromEnv;
}

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

/**
 * 把提交进仓的 eval 配置物化成 loadConfig 可直接加载的副本：
 * contextProfiles.*.root 的相对路径 → 相对仓根解析成的绝对路径，落 outPath（默认
 * .runtime/eval-agent-config.yaml，原子替换）。显式路径与本地 config/agent.yaml
 * 两条分支不物化——它们的 root 本就是部署态绝对路径。
 */
export function materializeEvalConfig(
  evalConfig: string,
  outPath: string = EVAL_MATERIALIZED,
): string {
  const config = parseYaml(readFileSync(evalConfig, 'utf8')) as Record<string, unknown>;
  const profiles = config['contextProfiles'] as Record<string, Record<string, unknown>> | undefined;
  if (profiles) {
    for (const [id, profile] of Object.entries(profiles)) {
      const raw = String(profile['root'] ?? '').trim();
      if (raw === '') throw new Error(`eval 配置 contextProfiles.${id}.root 为空`);
      if (!path.isAbsolute(raw)) {
        profile['root'] = path.resolve(REPO_ROOT, raw);
      }
    }
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(tmp, stringifyYaml(config));
  renameSync(tmp, outPath);
  return outPath;
}

/** 仓库默认入口：标准路径解析 + eval 回退时物化绝对路径副本。 */
export function resolveConfigPath(explicit?: string): string {
  const resolved = resolveConfigPathInternal(explicit, ROOT_CONFIG, EVAL_CONFIG);
  // 判据是「解析后指向的不是别处，正是仓内那条 eval 配置」，不是字符串相等——EVAL_CONFIG
  // 是绝对路径，调用方用相对路径（./scripts/eval/eval.agent.yaml）显式指向同一条配置时，
  // 原始字符串比较会漏判而不物化，root 留在相对路径，下游 spawn({ cwd }) 二次解析即 ENOENT。
  return path.resolve(resolved) === EVAL_CONFIG ? materializeEvalConfig(resolved) : resolved;
}
