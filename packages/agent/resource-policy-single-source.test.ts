/**
 * P5-T01 单一配置源守卫（静态检查；TDD：改造前红 → `runtime` 段 + host 死键删除后绿）。
 *
 * 为什么需要它：P5 的资源旋钮必须只有一个配置入口（`runtime` 段）。若某处继续解析
 * `host.platformQueueCapacity` 一类已删键、或某个生产模块自行解释限额字段，就会
 * 出现「写着不生效 / 双源漂移」的假配置——人工审查挡不住回潮，这里把它变成常驻测试。
 *
 * 判据（只用 AST 的标识符与字符串字面量事实；注释不计）：
 *  ① 已删 `host.*` 键与其 `FSHINE_*` 覆盖口在生产代码**零引用**；
 *  ② 资源旋钮名只允许出现在登记的所有者文件里（类型定义 / YAML 解析 / 策略缺省与消费，
 *     以及执行侧现行的回合时限入参）。所有者表双向闭合：条目必须真实命中，命中必须
 *     全部被登记覆盖——新增读者即红，迫使走「单一配置源」审查。
 *
 * 扫描范围 = packages/apps/scripts 下的生产 .ts（排除 *.test.ts 与 fixtures）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCAN_ROOTS = ['packages', 'apps', 'scripts'] as const;
const SKIP_DIRS = new Set(['node_modules', '.runtime', '.git', 'dist', 'out', 'tmp', 'fixtures']);

const CONTRACTS_CONFIG = 'packages/contracts/src/config.ts';
const CORE_CONFIG = 'packages/core/src/config.ts';
const RESOURCE_POLICY = 'packages/agent/src/resource-policy.ts';
const EXECUTION_RUNTIME = 'packages/agent/src/execution-runtime.ts';
const ASK_RUNTIME = 'scripts/ask-runtime.ts';
// R4 稳定性套件的假件 harness（2026-11-14 登记）：只**构造**测试场景的 RuntimeConfig 输入
// （backgroundConcurrency/queueCapacity 逐场景参数），不解析/解释旋钮、不读原始
// config.runtime.*；与 *.test.ts 同类（该扫描已排除 *.test.ts，harness 因命名未被排除）。
const STAB_SOAK = 'scripts/stab/soak-harness.ts';
const STAB_PRESSURE = 'scripts/stab/pressure-harness.ts';
const STAB_CHAOS = 'scripts/stab/chaos-harness.ts';

/** 分诊 #6 删除的 host.* 未消费键（生产代码零引用；旧 YAML 里的残留键由加载层忽略）。 */
const DELETED_HOST_KEYS = [
  'platformQueueCapacity',
  'shutdownDrainMs',
  'workerDispatchMode',
  'workerStepCap',
  'inboundDebounceMs',
  'piAgentDir',
] as const;

/** 对应 FSHINE_* 覆盖口（deploymentEnvOf 不再派生、无任何读取点）。 */
const DELETED_ENV_KEYS = [
  'FSHINE_PLATFORM_QUEUE_CAPACITY',
  'FSHINE_SHUTDOWN_DRAIN_MS',
  'FSHINE_WORKER_DISPATCH_MODE',
  'FSHINE_WORKER_STEP_CAP',
  'FSHINE_INBOUND_DEBOUNCE_MS',
  'FSHINE_PI_AGENT_DIR',
] as const;

/**
 * 资源旋钮的唯一所有者。
 *  - contracts/config.ts：类型面（RuntimeConfig/TaskBudgetConfig 定义）；
 *  - core/src/config.ts：YAML `runtime` 段的解析与 fail-fast 校验；
 *  - agent/src/resource-policy.ts：缺省值、并发/队列/预算/深度的解释与消费；
 *  - agent/src/execution-runtime.ts：回合时限的**执行侧入参**（现行缺省 300s/180s 与
 *    P5 缺省一致；集成接线时改由策略解析值注入，不得在此重读 `runtime` 配置）；
 *  - scripts/ask-runtime.ts（R4 集成登记，2026-11-14）：**装配点的解析值透传**——把
 *    `resolveRuntimeConfig` 的 mainTurnMs/workerTurnMs 注入执行侧消费点与后台 runner
 *    leaseMs；不自行解释旋钮、不读原始 `config.runtime.*`（单一配置源不破坏）。
 */
const KNOB_OWNERS: Readonly<Record<string, readonly string[]>> = {
  mainConcurrency: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY],
  backgroundConcurrency: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY, STAB_SOAK, STAB_PRESSURE, STAB_CHAOS],
  queueCapacity: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY, STAB_SOAK, STAB_PRESSURE, STAB_CHAOS],
  mainTurnMs: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY, EXECUTION_RUNTIME, ASK_RUNTIME],
  workerTurnMs: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY, EXECUTION_RUNTIME, ASK_RUNTIME],
  maxDelegationDepth: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY],
  taskBudget: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY],
  waitUserTimeoutMs: [CONTRACTS_CONFIG, CORE_CONFIG, RESOURCE_POLICY],
};

interface SourceFacts {
  identifiers: Set<string>;
  stringLiterals: string[];
}

const factsCache = new Map<string, SourceFacts>();

function factsOf(relative: string): SourceFacts {
  const cached = factsCache.get(relative);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile(
    relative,
    readFileSync(path.join(REPO_ROOT, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const identifiers = new Set<string>();
  const stringLiterals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isStringLiteralLike(node)) stringLiterals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const facts: SourceFacts = { identifiers, stringLiterals };
  factsCache.set(relative, facts);
  return facts;
}

function productionFiles(): string[] {
  const files: string[] = [];
  const walk = (relativeDir: string): void => {
    const absolute = path.join(REPO_ROOT, relativeDir);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(relative);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      if (statSync(path.join(REPO_ROOT, relative)).isFile()) files.push(relative);
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return files.sort();
}

describe('P5-T01 单一配置源守卫：host 死键零引用 + 资源旋钮唯一解释点', () => {
  it('已删 host.* 键与 FSHINE_* 覆盖口在生产代码零引用', () => {
    const hits: string[] = [];
    for (const file of productionFiles()) {
      const facts = factsOf(file);
      for (const key of DELETED_HOST_KEYS) {
        if (facts.identifiers.has(key) || facts.stringLiterals.some((literal) => literal.includes(key))) {
          hits.push(`${file} -> ${key}`);
        }
      }
      for (const env of DELETED_ENV_KEYS) {
        if (facts.identifiers.has(env) || facts.stringLiterals.some((literal) => literal.includes(env))) {
          hits.push(`${file} -> ${env}`);
        }
      }
    }
    console.log(JSON.stringify({ event: 'p5_deleted_host_keys', files: productionFiles().length, hits: hits.length }));
    expect(hits, `已删 host 键仍被生产代码引用（双源/假配置回潮）：\n${hits.join('\n')}`).toEqual([]);
  });

  it('资源旋钮只允许登记的所有者文件解释（所有者表双向闭合）', () => {
    const byKnob = new Map<string, string[]>();
    for (const knob of Object.keys(KNOB_OWNERS)) {
      const files = productionFiles().filter((file) => {
        const facts = factsOf(file);
        return facts.identifiers.has(knob) || facts.stringLiterals.some((literal) => literal.includes(knob));
      });
      byKnob.set(knob, files);
    }
    console.log(JSON.stringify({
      event: 'p5_runtime_knob_owners',
      hits: Object.fromEntries(byKnob),
    }));

    for (const [knob, files] of byKnob) {
      const allowed = new Set(KNOB_OWNERS[knob]!);
      const unexpected = files.filter((file) => !allowed.has(file));
      expect(unexpected, `旋钮 ${knob} 出现未登记的读者（第二配置源）：${unexpected.join(', ')}`).toEqual([]);
      for (const owner of allowed) {
        expect(files, `所有者表陈旧：${owner} 未命中旋钮 ${knob}（新增读者必须登记，删除读者同步收表）`).toContain(owner);
      }
    }
  });
});
