/**
 * 评测 harness 自己的安全门（issue #10 验收标准「Mock/真实环境防线显式且 fail-closed」）。
 *
 * 与宿主"不再持写门"不矛盾：宿主管不了也不该管生产写（那是执行层 commit 门的事，
 * 2026-11-08 架构裁定），但**评测**要管住自己别打到真平台——评测知道自己在评测，它
 * 有资格也比生产服务更严格。三条硬判据，缺任何一条即拒绝跑危险用例（抛
 * EvalIsolationRefused，调用方转 exit 2），绝不静默落到真实平台：
 *   ① 隔离 mock ——活跃 contextProfile 的 root 必须在仓内夹具目录
 *     （scripts/eval/fixtures/）之下；指向任何真实执行层 checkout 即拒。
 *   ② 缺 fixture ——夹具目录或声明的 gateway 可执行文件不存在即拒（委派必然 spawn
 *     不到，跑了只会产出 INCONCLUSIVE 假跑）。
 *   ③ 执行层状态无法验证 ——EXECUTION_AUDIT_PATH 未设（执行层证据无处落）或审计
 *     通道写不进/读不回即拒。没有证据来源的危险用例跑完也无法判定，等于拿真实平台
 *     冒险换一份不可信报告。
 *
 * 判据刻意只认**配置与文件系统事实**（root 路径、gateway 声明、审计通道读写探针），
 * 不认任何"我觉得是 mock"的约定字符串；每条拒绝都列出缺什么、怎么补（可行动反馈）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓根（scripts/eval/safety-gate.ts → 上两级）。 */
export const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
/** 仓内执行层夹具目录：评测唯一允许的活跃 profile root 位置。 */
export const EVAL_FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures');

/** 评测隔离事实（assess 的输出；problems 非空 = 不允许跑危险用例）。 */
export interface EvalIsolationFacts {
  /** 活跃 profile 的执行层 root（未配置 = undefined）。 */
  platformRoot?: string;
  /** profile 声明的网关调用形式（相对 root）。 */
  gateway?: string;
  /** root 在仓内夹具目录之下。 */
  fixtureWithinRepo: boolean;
  /** 夹具目录存在。 */
  fixturePresent: boolean;
  /** gateway 可执行文件存在。 */
  gatewayPresent: boolean;
  /** EXECUTION_AUDIT_PATH 已设。 */
  auditPathSet: boolean;
  /** 审计通道写进一行并读得回（执行层状态可验证的机械探针）。 */
  auditUsable: boolean;
  /** 全部不满足项（人可读、可行动；空 = 放行）。 */
  problems: string[];
}

export class EvalIsolationRefused extends Error {
  constructor(problems: readonly string[]) {
    super([
      '评测安全门拒绝跑危险用例（fail-closed，不静默落真实平台）：',
      ...problems.map((problem) => `  · ${problem}`),
      '补齐上面每一项再跑；不要为过门放宽判据——评测的隔离前提比跑通更重要。',
    ].join('\n'));
    this.name = 'EvalIsolationRefused';
  }
}

/**
 * 评估评测隔离事实。输入 = 已加载配置里的活跃 profile 两项 + 进程 env；只读文件系统
 * 做存在性判断，唯一的写动作是审计通道探针（写入临时文件后立即删除）。
 */
export function assessEvalIsolation(input: {
  env: NodeJS.ProcessEnv;
  platformRoot?: string;
  gateway?: string;
}): EvalIsolationFacts {
  const problems: string[] = [];
  const { env } = input;
  const platformRoot = input.platformRoot ? path.resolve(input.platformRoot) : undefined;
  const gateway = input.gateway;

  const fixtureWithinRepo = platformRoot !== undefined
    && path.relative(EVAL_FIXTURE_ROOT, platformRoot) !== ''
    && !path.relative(EVAL_FIXTURE_ROOT, platformRoot).startsWith('..');
  const fixturePresent = platformRoot !== undefined && existsSync(platformRoot);
  const gatewayPath = platformRoot !== undefined && gateway
    ? path.join(platformRoot, gateway)
    : undefined;
  const gatewayPresent = gatewayPath !== undefined && existsSync(gatewayPath);

  // ① 隔离 mock：root 必须在仓内夹具目录之下。root 未配同样拒——"没有平台根"对评测
  // 不是安全态，是跑不出证据的假跑。
  if (platformRoot === undefined) {
    problems.push('活跃 contextProfile 没有声明 root——未指定隔离 mock（评测脚本走 scripts/eval/eval.agent.yaml，或显式 --config= 指向夹具配置）');
  } else if (!fixtureWithinRepo) {
    problems.push(`活跃 profile.root（${platformRoot}）不在仓内夹具目录 ${EVAL_FIXTURE_ROOT} 之下——评测不允许把消息打到真实执行层`);
  }
  // ② 缺 fixture：目录与 gateway 可执行文件都要真实存在。
  if (platformRoot !== undefined && !fixturePresent) {
    problems.push(`夹具目录不存在：${platformRoot}`);
  }
  if (platformRoot !== undefined && (!gateway || !gatewayPresent)) {
    problems.push(`夹具 profile 未声明 gateway 或网关文件缺失（gateway=${gateway ?? '(未声明)'}${gatewayPath ? `，路径 ${gatewayPath}` : ''}）——委派 spawn 不到执行层`);
  }
  // ③ 执行层状态无法验证：审计路径未设，或写/读探针失败。
  const auditPath = env['EXECUTION_AUDIT_PATH'];
  const auditPathSet = typeof auditPath === 'string' && auditPath.trim() !== '';
  let auditUsable = false;
  if (auditPathSet) {
    auditUsable = auditProbe(auditPath!);
    if (!auditUsable) problems.push(`执行层审计通道不可用（写进一行读不回）：${auditPath}——执行层状态无法验证`);
  } else {
    problems.push('EXECUTION_AUDIT_PATH 未设——执行层证据无处落，跑完只能得到 INCONCLUSIVE');
  }

  return {
    ...(platformRoot !== undefined ? { platformRoot } : {}),
    ...(gateway ? { gateway } : {}),
    fixtureWithinRepo,
    fixturePresent,
    gatewayPresent,
    auditPathSet,
    auditUsable,
    problems,
  };
}

/** 审计通道探针：同目录写一行标记文件并读回，随即删除。任何一步失败 = 不可用。 */
function auditProbe(auditPath: string): boolean {
  const marker = `${auditPath}.eval-gate-probe`;
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, 'probe\n', { flag: 'w' });
    const readable = readFileSync(marker, 'utf8') === 'probe\n';
    unlinkSync(marker);
    return readable;
  } catch {
    try { rmSync(marker, { force: true }); } catch { /* 探针自身清理失败不影响判定 */ }
    return false;
  }
}

/**
 * fail-closed 放行门：problems 非空即抛 EvalIsolationRefused（拒绝跑危险用例）。
 * purpose 进错误头，报错能对上"谁在要求隔离"。
 */
export function assertEvalIsolation(facts: EvalIsolationFacts, purpose: string): void {
  if (facts.problems.length > 0) {
    throw new EvalIsolationRefused([`—— ${purpose} ——`, ...facts.problems]);
  }
}
