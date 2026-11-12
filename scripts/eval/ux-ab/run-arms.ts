/**
 * UX A/B 两臂运行入口（AB-Eval 规格 §1/§2；Track D 交付）。
 *
 * ⚠️ 本入口**不在 Track D 运行**：第一轮 20 run 的启动按规格 §3 由主线先报数、批准后跑。
 *
 * 两臂（**同版本**外科式切换，只切提示词来源与技能装载方式，其余全同）：
 *   · control（legacy 臂）：roleInstructions = 1555df6 冻结的 `buildSystemPrompt(DEFAULT_EXECUTOR_LABEL)`
 *     原文 + 冻结的 `docs/business-skill.md` 副本（含旧拼装小标题，复刻旧 runtime 的拼装顺序与
 *     8000 字符截断）；skillsMode=off（无技能元数据曝光、无 read_skill）。
 *   · profile（实验臂）：生产路径——agent.md 常驻角色 + 技能元数据曝光 + read_skill 按需读取。
 *
 * 注入经 createServerAssembly 的程序化 seam（roleInstructionsOverride / skillsMode），
 * **不是配置项**；生产路径永不使用这两个入参（唯一来源仍是 agent.md）。
 *
 * 用法（worker 走 mock 执行器，不触真实平台；模型与端点由 env 指定）：
 *   node --env-file-if-exists=.env --import tsx scripts/eval/ux-ab/run-arms.ts \
 *     --arm=control --cases=scripts/eval/ux-ab/ux-cases.jsonl [--out=.runtime/ux-ab]
 *
 * 语料格式（JSONL，一行一场景；1–3 轮）：
 *   {"id":"UX-01","turns":["第一轮消息","第二轮消息"]}
 * 语料本体（`ux-cases.md`，任务书第八节 10 场景）由 Track B 产出；本入口不内置语料、
 * 也不生成替身语料——文件缺失 / 行不合法即报错退出（不静默降级）。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerAssembly, type ServerAssemblyOverrides } from '../../../apps/server/assembly';
// 与探针/验收同一条配置解析：相对拼法的 eval 配置要物化成绝对路径副本再交给 assembly
// （否则 contextProfiles.<id>.root 的仓内相对路径会在 loadConfig 处直接报"必须是绝对路径"）。
import { resolveConfigPath } from '../../resolve-config-path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * 旧 runtime 的拼装小标题（1555df6 `packages/agent/src/system-prompt.ts:12` 冻结）。
 * 控制臂只此一处复刻旧文本；该常量随旧文件删除，不进生产代码。
 */
const LEGACY_BUSINESS_SKILL_HEADING = '【业务编排知识：程序性知识，只用于长任务拆解与信息补齐；"怎么做才对"归执行层，不由这里规定】';
/** 旧装配的注入上限（1555df6 `apps/server/business-skill.ts` MAX_BUSINESS_SKILL_CHARS）。 */
const LEGACY_BUSINESS_SKILL_MAX_CHARS = 8000;

interface UxCase {
  id: string;
  turns: string[];
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** 控制臂的角色指令：冻结原文 + 冻结 skill 副本，按旧 runtime 的拼装顺序拼好。 */
function controlRoleInstructions(): string {
  const legacyPrompt = readFileSync(path.join(HERE, 'control', 'legacy-system-prompt.txt'), 'utf8');
  const legacySkill = readFileSync(path.join(HERE, 'control', 'legacy-business-skill.md'), 'utf8')
    .trim()
    .slice(0, LEGACY_BUSINESS_SKILL_MAX_CHARS);
  return `${legacyPrompt}\n\n${LEGACY_BUSINESS_SKILL_HEADING}\n${legacySkill}`;
}

function loadCases(file: string): UxCase[] {
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`语料为空：${file}`);
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`语料第 ${index + 1} 行不是合法 JSON：${file}`);
    }
    const candidate = parsed as { id?: unknown; turns?: unknown };
    if (typeof candidate.id !== 'string' || candidate.id.trim() === ''
      || !Array.isArray(candidate.turns) || candidate.turns.length === 0
      || candidate.turns.some((turn) => typeof turn !== 'string' || turn.trim() === '')) {
      throw new Error(`语料第 ${index + 1} 行不合法（需要 {id, turns:[非空字符串…]}）：${file}`);
    }
    return { id: candidate.id, turns: candidate.turns as string[] };
  });
}

/**
 * 四臂：
 *   · control —— 历史基线：1555df6 冻结的旧提示词 + 旧静态编排文档，技能装载 off。
 *   · profile —— 第一轮用的实验臂（agent.md + 技能面 on）。
 *   · b0 / b1 —— 第二轮配对实验：**同一份 agent.md**，只切技能装载（b0 off / b1 on）。
 *     除技能曝光与读取能力外其余全同（同模型、同语料、同 mock、同执行配置）。
 */
function overridesFor(arm: 'control' | 'profile' | 'b0' | 'b1'): Partial<ServerAssemblyOverrides> {
  if (arm === 'b0') return { skillsMode: 'off' };
  if (arm === 'b1' || arm === 'profile') return {}; // 生产口径：agent.md + 技能面 on（缺省）
  return { roleInstructionsOverride: controlRoleInstructions(), skillsMode: 'off' };
}

/** 捕获宿主埋点 JSON 行（与 tests/e2e 的 captureHostEvents 同形；只在评测进程内生效）。 */
function captureHostEvents() {
  const lines: Array<Record<string, unknown>> = [];
  const sink = (line: unknown): void => {
    if (typeof line !== 'string') return;
    try { lines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* 非 JSON 忽略 */ }
  };
  const originals = { info: console.info, warn: console.warn, error: console.error };
  console.info = sink;
  console.warn = sink;
  console.error = sink;
  return {
    lines,
    of: (event: string): Array<Record<string, unknown>> => lines.filter((entry) => entry['event'] === event),
    forRequest: (requestId: string): Array<Record<string, unknown>> => lines.filter((entry) => entry['requestId'] === requestId),
    restore: (): void => { console.info = originals.info; console.warn = originals.warn; console.error = originals.error; },
  };
}

/** 一轮的机械指标：耗时/结局/用量（turn_span 已带 usage 字段，见 runtime.ts:1133）。 */
interface TurnMetrics {
  /** 本轮模型的 token 用量（turn_span 的 usageSpanFields；缺失即"没采到"，不补零）。 */
  usage?: Record<string, number>;
  /** 轮次耗时（turn_span.durationMs）。 */
  durationMs?: number;
  /** 轮次结局（turn_span.outcome）。 */
  outcome?: unknown;
  /** 本轮读过的技能名（main_skill_read）。 */
  skillsRead: string[];
  /** 技能读取失败/发现失败事件（可观测性，不吞）。 */
  skillErrors: Array<Record<string, unknown>>;
}

function metricsFor(events: Array<Record<string, unknown>>): TurnMetrics {
  const span = events.find((entry) => entry['event'] === 'turn_span');
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(span ?? {})) {
    if (typeof value === 'number' && key !== 'durationMs') usage[key] = value;
  }
  return {
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(typeof span?.['durationMs'] === 'number' ? { durationMs: span['durationMs'] as number } : {}),
    ...(span ? { outcome: span['outcome'] } : {}),
    skillsRead: events.filter((entry) => entry['event'] === 'main_skill_read').map((entry) => String(entry['name'])),
    skillErrors: events.filter((entry) => entry['event'] === 'skill_read_failed' || entry['event'] === 'skill_discovery_failed'),
  };
}

async function runArm(arm: 'control' | 'profile' | 'b0' | 'b1', cases: UxCase[], outPath: string): Promise<void> {
  const configPath = resolveConfigPath(process.env['AGENT_CONFIG_PATH']);
  const assembly = await createServerAssembly({
    env: { ...process.env, AGENT_CONFIG_PATH: configPath },
    ...overridesFor(arm),
  });
  try {
    for (const testCase of cases) {
      const sessionId = `ux-ab-${arm}-${testCase.id}`;
      const turns: Array<{ text: string; reply: string; notices: string[]; pendingPlans: string[]; metrics: TurnMetrics }> = [];
      for (const [index, message] of testCase.turns.entries()) {
        const requestId = `${sessionId}-t${index + 1}`;
        const capture = captureHostEvents();
        const notices: string[] = [];
        const pendingPlans: string[] = [];
        const started = Date.now();
        let reply;
        try {
          reply = await assembly.runtime.handleTurn({
            requestId,
            principalId: argValue('principal') ?? 'wecom:ux-ab',
            sessionId,
            // 计划门的两个宿主出口：生产由 handler 注入（onNotice = channel 通知；
            // onPlanPending = planConfirmation.savePending）。直连 runtime 不传时 confirm/notify
            // 档会抛「未配置…」并把部署内部措辞带进用户回复（2026-11-12 两轮实测：这是构造
            // 缺陷，不是被测行为）。评测里只记录：通知原文进产物；pending 记一条 id 供核对。
            onNotice: async (text: string) => { notices.push(text); },
            onPlanPending: async (pending) => { pendingPlans.push(String((pending as { planId?: unknown }).planId ?? 'unknown')); },
          }, message);
        } finally {
          capture.restore();
        }
        const metrics = metricsFor(capture.forRequest(requestId));
        turns.push({
          text: message,
          reply: reply.text,
          notices,
          pendingPlans,
          metrics: { ...metrics, durationMs: metrics.durationMs ?? Date.now() - started },
        });
      }
      const totals = turns.reduce<{ durationMs: number; skillsRead: string[]; usage: Record<string, number> }>(
        (acc, turn) => {
          acc.durationMs += turn.metrics.durationMs ?? 0;
          acc.skillsRead.push(...turn.metrics.skillsRead);
          for (const [key, value] of Object.entries(turn.metrics.usage ?? {})) acc.usage[key] = (acc.usage[key] ?? 0) + value;
          return acc;
        },
        { durationMs: 0, skillsRead: [], usage: {} },
      );
      appendFileSync(outPath, `${JSON.stringify({ arm, id: testCase.id, turns, totals })}\n`);
      console.log(`[${arm}] ${testCase.id}：${testCase.turns.length} 轮完成，技能读取 ${totals.skillsRead.length} 次`);
    }
  } finally {
    await assembly.close();
  }
}

async function main(): Promise<void> {
  const arm = argValue('arm');
  if (arm !== 'control' && arm !== 'profile' && arm !== 'b0' && arm !== 'b1') {
    console.error('用法：--arm=control|profile|b0|b1 --cases=<ux-cases.jsonl> [--out=.runtime/ux-ab] [--principal=wecom:<id>]');
    process.exitCode = 2;
    return;
  }
  const casesFile = argValue('cases') ?? path.join(HERE, 'ux-cases.jsonl');
  const outDir = argValue('out') ?? path.join(REPO_ROOT, '.runtime', 'ux-ab');
  const cases = loadCases(casesFile);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${arm}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  await runArm(arm, cases, outPath);
  console.log(`运行记录：${outPath}`);
}

await main();
