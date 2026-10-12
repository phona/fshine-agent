/**
 * 提案流程的协议角色词汇表（方案 1 · B 波，镜像 plan-runtime 的解析纪律）。
 *
 * 判别只有一个：一条 worker bash 命令是不是"创建提案"的网关调用。判据全部来自平台
 * 自己的机器可读面——`operation list --json` 的 `protocol` 列（A 波新增）——宿主不认
 * 脚本路径、不认业务 operation 名、不解析 payload 内容。
 *
 * 为什么必须按 operation 名 + protocol 列判（A 波实证的限制）：按脚本路径寻址
 * （`prepare <平台执行脚本的相对路径> <payload>`）在平台侧会解析成另一个 operation
 * 并报契约错——形态错被说成数据错，而平台无法在不嗅探文件内容的前提下区分（本仓禁止
 * 内容嗅探）。因此按脚本路径寻址的一律**不拦截**：落回 serve 门，由平台拒绝。
 *
 * 寻址形态认两种（A 波已对 runner / `operation run` / 建造模式寻址都加了 protocol-keyed
 * 守卫，所以两条路都**能**创建提案）：`prepare <operation>` 与 `operation run <operation>`。
 * 少认任何一条，平台侧就多一个"有提案、宿主无条目、用户拿不到确认码"的缺口。
 *
 * 空表 = 不拦截：拿不到 protocol 列（CLI 派生失败 / 旧版平台 / 平台还没下发这一列）时
 * fail-closed 到"这不是提案调用"，由门与平台继续裁决——派生是增强，不是前提（与
 * label / 规格 / 语义三张表同一失败语义）。
 *
 * 纯函数 + 显式传表：无单例、无进程级缓存，调用方持有表并注入，测试因此可以直接塞
 * 替身表，不起 harness。
 */
import { extractGateScript, isServeCliInvocation, splitCommandTokens } from './serve-gate';
import type { OperationProtocols } from './operation-labels';

/**
 * 跨层协议角色名：平台 `protocol` 列声明"这个 operation 在写流程里扮演什么角色"。
 * 宿主只认角色，不认业务 operation 名（AGENTS.md 跨层协议条款：fshine 识别通用的
 * operation / 协议角色，具体网关名与业务字段只住执行层适配边界）。
 */
export const PROPOSAL_CREATE_PROTOCOL = 'proposal.create';

/**
 * 落账侧的协议角色（B4 的 commit 后端按它寻址 operation）：平台 `protocol` 列声明哪个
 * operation 扮演"提交提案"。与 PROPOSAL_CREATE_PROTOCOL 同族——宿主只认角色，不认业务
 * operation 名；commit 后端因此不必在代码里写任何网关名（换执行层时一行不改）。
 */
export const PROPOSAL_COMMIT_PROTOCOL = 'proposal.commit';

/** 网关模式名：创建提案经 `prepare` 模式进入（A 波决定复用已注册 operation，不新开 CLI 组）。 */
const PROPOSAL_CREATE_MODE = 'prepare';
/** 第二种寻址形态的 mode 词（`operation run <operation>`）：平台 runner 的同一张 protocol 守卫。 */
const OPERATION_RUN_MODE = 'operation';
const OPERATION_RUN_SUBCOMMAND = 'run';

/** 脚本路径寻址的形状：含路径分隔符，或以脚本后缀结尾（平台会把它解析成别的 operation）。 */
const SCRIPT_PATH_RE = /[/\\]|\.(?:js|py)$/i;

export interface ProposalCreateCall {
  /** 平台注册名（按名寻址；脚本路径寻址进不来，见文件头）。 */
  operation: string;
  /** payload 文件路径：**不透明字符串**。宿主不读它、不解析它、不改写它。 */
  payloadPath: string;
}

/**
 * 这条命令是不是"创建提案"的网关调用；是则带回 operation 与 payload 路径。
 *
 * 判据（缺一即 null，落回 serve 门与平台继续裁决）：
 *   ① 首词是网关（isServeCliInvocation：env 前缀天然不匹配，bash/sh 与路径前缀已归一）；
 *   ② 第二个 token 是 `prepare` 模式，或 `operation run` 这一族（两种寻址形态平台侧都有
 *      protocol-keyed 守卫，见文件头）；
 *   ③ 目标是 **operation 名**（不是脚本路径），且在 protocol 表里映到 `proposal.create`
 *      这个角色；
 *   ④ operation 之后取得到一个 payload 位置参数。
 *
 * 与 parsePlanCallsCommand 的分别：那条对"有 plan 令牌但形状不符"响亮抛错（教学式
 * 拒绝是自愈通道）；本函数对一切不确定形状一律返回 null——提案创建还没有自己的形状
 * 教学，且不拦截的方向是安全的（门与平台照旧裁决）。
 */
export function parseProposalCommand(
  command: string,
  protocols: OperationProtocols | undefined,
): ProposalCreateCall | null {
  if (!protocols || protocols.size === 0) return null;
  if (!isServeCliInvocation(command)) return null;
  const tokens = splitCommandTokens(command);
  const form = proposalCreateForm(tokens);
  if (!form) return null;
  // extractGateScript 是"网关 <mode> <目标>"这一词法的唯一解读者（含 operation run 的
  // 特殊形态）：目标 token 由它取，这里不写第二套命令解析。
  const reference = extractGateScript(command);
  if (!reference || SCRIPT_PATH_RE.test(reference)) return null;
  if (protocols.get(reference) !== PROPOSAL_CREATE_PROTOCOL) return null;
  const payloadPath = payloadPathAfter(tokens, form.payloadIndex);
  return payloadPath ? { operation: reference, payloadPath } : null;
}

/** 创建提案的寻址形态：返回 payload 位置参数的起始下标（该 token 之前的内容）。 */
function proposalCreateForm(tokens: readonly string[]): { payloadIndex: number } | null {
  if (tokens[1] === PROPOSAL_CREATE_MODE) return { payloadIndex: 3 };
  if (tokens[1] === OPERATION_RUN_MODE && tokens[2] === OPERATION_RUN_SUBCOMMAND) return { payloadIndex: 4 };
  return null;
}

/**
 * operation 之后的第一个非 flag token = payload 位置参数。
 *
 * 为什么要跳过 flag 串：平台的 payload 位置参数之前可能带开关（如"一次创建多个提案"
 * 的 `--batch`），而取值型 flag 与位置参数的先后顺序由模型决定。跳过只影响"取哪一个
 * token"，不解释它的含义——取到的字符串原样上交，由平台按自己的 args 规格消费。
 */
function payloadPathAfter(tokens: readonly string[], from: number): string | null {
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.startsWith('--')) continue;
    return token;
  }
  return null;
}
