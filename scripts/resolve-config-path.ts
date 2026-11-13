/**
 * 配置路径辅助（显式入口解析 + eval 配置物化；两个函数各自独立）。
 *
 * 入口侧显式来源：--config=<path> 命令行优先，其次 AGENT_CONFIG_PATH 环境变量
 * （explicitConfigFrom）。缺省配置的选择归各入口：`npm run ask` 用仓内 dummy 夹具配置
 * （config/agent.fixture.yaml）；server 由部署方提供显式路径（apps/server/main.ts）。
 *
 * 本模块不再持「仓根 config/agent.yaml 存在才用 > scripts/eval/eval.agent.yaml 回退」的
 * 隐式链：旧 eval 回退配置与 resolveConfigPath* 入口已随 M4 死代码清扫退役
 * （2026-11-13，见 docs/decision-log.md §十三；0 生产调用，唯一调用者是其自身测试）。
 *
 * eval 配置物化：contextProfiles.*.root 的相对路径 → 相对仓根解析成绝对路径
 * （loadConfig 强制 root 绝对）；提交进仓的 YAML 因此不含开发者主目录、不依赖环境变量。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

/**
 * 把提交进仓的 eval 配置物化成 loadConfig 可直接加载的副本：
 * contextProfiles.*.root 的相对路径 → 相对仓根解析成的绝对路径，落 outPath（默认
 * .runtime/eval-agent-config.yaml，原子替换）。显式路径与本地部署配置不物化——
 * 它们的 root 本就是部署态绝对路径。
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
