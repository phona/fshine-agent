/**
 * Main Agent Profile 加载器（Track A 交付；三条装配路径的接线归 Track D）。
 *
 * `.agents/agents/<name>/agent.md` 是 Main Agent 的常驻角色定义：只含稳定角色指令，
 * 不含交互 SOP（归 Skills）、日期等动态上下文、平台/业务字段名或工具协议。
 * 本模块只做「读取 + 校验 + 返回正文」，不做注册表、覆盖链或热更新。
 *
 * 缺省路径按**仓库根**解析（由本模块位置上溯 packages/agent/src → 仓库根），与进程
 * cwd 无关。`options.path` 仅供测试与部署期调用方显式指定；接口不接受来自请求或
 * 模型的输入路径。
 *
 * Track D 接线（本轨不改 runtime）：
 *   - runtime.ts 的三条装配路径都要把静态角色文本换成本模块的 instructions：
 *     ① 正常回合（baseSystemPrompt 的拼装点）；② 确认后恢复（复用 baseSystemPrompt，
 *     再附加恢复可信约束）；③ 驱动输入。
 *   - 动态部分仍由 runtime 拼装：日期尾注、执行层称谓、业务 skill 与任务上下文。
 *   - 旧 system-prompt.ts 的静态文案由 D 删除；本模块失败时抛可定位错误（带路径与
 *     原因），绝不静默回退任何旧提示词。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AgentProfile {
  /** agent.md 正文：frontmatter 已剥离、首尾空白已裁剪。 */
  instructions: string;
  /** 实际读取的绝对路径（校验失败时错误信息里也带它）。 */
  sourcePath: string;
}

export interface LoadAgentProfileOptions {
  /** 仅测试/部署期调用方使用；缺省 = 仓库根 `.agents/agents/fshine-main/agent.md`。 */
  path?: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 缺省 Profile 位置：仓库根 `.agents/agents/fshine-main/agent.md`。 */
export const DEFAULT_AGENT_PROFILE_PATH = path.join(REPO_ROOT, '.agents', 'agents', 'fshine-main', 'agent.md');

export async function loadAgentProfile(options: LoadAgentProfileOptions = {}): Promise<AgentProfile> {
  const sourcePath = path.resolve(options.path ?? DEFAULT_AGENT_PROFILE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(sourcePath, 'utf8');
  } catch (error) {
    throw profileError(sourcePath, `无法读取（${describeReadError(error)}）`);
  }
  const { instructions, declaredName } = parseProfile(raw, sourcePath);
  // 文件位置即身份：agent.md 的上级文件夹名（如 .agents/agents/fshine-main/ → fshine-main）。
  const locatedName = path.basename(path.dirname(sourcePath));
  if (declaredName !== undefined && declaredName !== locatedName) {
    throw profileError(sourcePath, `frontmatter name "${declaredName}" 与文件位置不一致（应为 "${locatedName}"）`);
  }
  return { instructions, sourcePath };
}

function parseProfile(content: string, sourcePath: string): { instructions: string; declaredName?: string } {
  const normalized = content.replace(/^\uFEFF/, '');
  let body = normalized;
  let declaredName: string | undefined;
  if (normalized.startsWith('---\n') || normalized.startsWith('---\r\n')) {
    const lines = normalized.split(/\r?\n/);
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) throw profileError(sourcePath, 'frontmatter 未闭合');
    for (const line of lines.slice(1, end)) {
      const match = /^name\s*:\s*(.*)$/.exec(line);
      if (match) declaredName = stripQuotes(match[1]!.trim());
    }
    body = lines.slice(end + 1).join('\n');
  }
  const instructions = body.trim();
  if (instructions === '') throw profileError(sourcePath, '内容为空（正文不含有效指令）');
  return { instructions, declaredName };
}

function stripQuotes(value: string): string {
  // 只在首尾为同一对引号时剥一层（不解释任意 YAML）；用一次正则完成，避免针对引号字符的分支。
  return value.replace(/^(['"])(.*)\1$/, '$2').trim();
}

function describeReadError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : String(error);
}

function profileError(sourcePath: string, reason: string): Error {
  return new Error(`加载 Main Agent Profile 失败（${sourcePath}）：${reason}`);
}
