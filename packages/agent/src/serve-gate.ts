/**
 * G1：serve worker 原生工具门（fshine 侧，挂在 SDK Agent 的 beforeToolCall）。
 *
 * 四层治理里本门负责 worker 的通用原生工具安全：
 *   - bash 仅允许网关调用（首词规则 + shell 元字符白名单：env 前缀、命令拼接、
 *     命令替换、重定向均被拒；法域声明无法剥离）
 *   - 平台计划命令只允许 host 管理；活跃计划由平台执行入口逐次校验，且"要不要计划"
 *     由平台语义表的 plan 列决定（纯本地计算免计划前置，见 planExempt）
 *   - read 限知识面（*.md、*.schema.json、.agents/、docs/、mappings/）——**内容层**裁决，
 *     白名单外的文件读不到内容；worker 工具面已无 grep/find，代码扫描失去入口。
 *   - ls **不**限知识面，只受 workspace 边界与敏感路径约束（理由见 LS_NOT_KNOWLEDGE_GATED）。
 *     路径经 workspaceRelPath 规范化后判定（platformRoot 即 worker cwd）：../ 穿越、
 *     绝对路径越界、符号链接逃逸一律拒，子串规则只作兜底
 * 平台侧 G2（网关）与 G3（serve-policy/withPlatform 守卫）负责执行器裁决。
 *
 * 已知残余：ls 不带 path 时仅见根目录名，信息量低，放行留痕。
 */

/**
 * LS_NOT_KNOWLEDGE_GATED —— 为什么 ls 不跟 read 一样限知识面。
 *
 * 知识与发现是两件事：read 决定**能不能读到内容**，ls 只决定**能不能列出名字**。
 * 把它们绑成同一条白名单，造出的是一个自相矛盾的组合——**允许读某个文件，却禁止发现
 * 它存在**：
 *
 *   knowledgePaths 含 `mappings/`，于是 worker 能 read
 *   `src/payroll/mappings/幻骥达-2026-05.json`；但 `ls src/payroll/mappings/` 被判
 *   知识面外（路径既不以 mappings/ 结尾、整体也不等于 mappings）而拒。它知道该用现成
 *   映射，却没法知道有哪些映射可用了。
 *
 *   2026-10-08 实测代价：同一个回合里 `ls src/payroll`、`ls src/payroll/mappings/`、
 *   `ls tmp/attachments` 连续 5 次 GATE_BLOCKED，worker 转而自己 dump 三遍上游文件、
 *   从原始数据重推仓里已写下的口径，10 分钟预算超时，产物没回到用户手上。
 *
 * 放行 ls 不扩大读取面：内容仍由 read 的知识面白名单把着，ls 只吐文件名与目录结构。
 * 真正要守住的是另外两条，且都已在本函数内先于 ls 判定：
 *   · workspace 边界（workspaceRelPath）——列不出平台工作区外的名字；
 *   · 敏感路径——`.env` / `.runtime/` / `auth.json` / `.browser-profile/` 既读不到也列不到。
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { messageTextFor } from './error-codes';
import { operationLabel, operationReferenceKey, type AccessSemantics, type KeyArgStyles, type OperationLabels, type OperationSemantics } from './operation-labels';
import { GATEWAY_INVOCATION } from './platform-contract';
import type { PlanCall } from './plan-runtime';

export interface ServeGateEvent {
  tool: string;
  allowed: boolean;
  reason?: string;
  /** 脱敏留痕：bash 命令或目标路径 */
  detail?: string;
  /** 请求级关联 id（审计串查 fshine ↔ 平台） */
  requestId?: string;
  /**
   * 平台操作的人类可读名（平台清单第 5 列，数据不是逻辑）：仅放行的平台调用
   * 且查得到 label 时才挂。没有它就没有进度帧——绝不用脚本名/操作名顶替。
   */
  label?: string;
  /** 参数摘要（已按声明式 flag 名单提取并格式化），渲染层直接拼接，不再解析命令。 */
  keyArgs?: string[];
}

export interface ServeGateVerdict {
  block?: boolean;
  reason?: string;
}

export interface ServeGateToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ServeGateOptions {
  onEvent?: (event: ServeGateEvent) => void;
  /** 平台根目录：用于经公共 CLI 派生能力清单（定价与脚本存在性校验）。缺省降级。 */
  platformRoot?: string;
  /** 知识面规则（read/ls 白名单），缺省内置。 */
  knowledgePaths?: readonly string[];
  /** 敏感路径规则，缺省内置。 */
  sensitivePaths?: readonly string[];
  /** Platform-backed plan active for this worker session. */
  planActive?: () => boolean;
  /** script → label 查找表（平台 CLI 派生，调用方持有并注入）。缺省即不挂 label。 */
  operationLabels?: OperationLabels;
  /** flag → 取值样式表（平台 args 规格 CLI 派生，调用方持有并注入）。缺省即不挂参数摘要。 */
  operationArgStyles?: KeyArgStyles;
  /**
   * operation → 平台 access 语义表（`operation list --json` 的 access 列 × 顶层
   * `accessSemantics` 表；driver 侧加载一次后注入，与计划拒绝分流同一来源，测试替身注入点）。
   *
   * 计划前置豁免的机械来源：宿主据此判定"这个调用要不要过计划门"（读 `plan` 列），
   * 不在自己仓里另立 operation 名单（L2）。
   *
   * fail-closed：缺省 / 空表 / 该 operation 不在表里 / `plan` 列取不到 → 一律照旧
   * 要求计划（宁多拦，不放松）。
   */
  operationSemantics?: OperationSemantics;
  /** 参数摘要提取器（测试替身注入点）；缺省用内置 describeKeyArgs（查平台 args 规格）。 */
  describeArgs?: (command: string) => string[];
  /**
   * 本轮请求的草稿目录（相对 platformRoot，如 `tmp/req_abc123`）。给了它，write 就**只**
   * 放行这一个目录——不是约定，是机械边界。
   *
   * 为什么必须是每请求一个：tmp/ 是共享草稿区，多个会话同时写 `tmp/contract.json` 会互相
   * 覆盖，而覆盖后的产物看不出是被谁污染的。宿主已有现成的随机源（requestId），用它派生
   * 一个子目录即可，不需要 worker 自己随机（它也没有随机手段）。
   * 缺省不设：只约束"必须在 tmp/ 下"（向后兼容与单测隔离）。
   */
  scratchDir?: string;
}

const DEFAULT_SENSITIVE_PATHS = ['.env', '.runtime/', 'auth.json', '.browser-profile/'];
const DEFAULT_KNOWLEDGE_PATHS = ['.md', '.schema.json', '.agents/', 'docs/'];
const PATH_ARGS = ['file_path', 'path'];
/** write 工具的入参键（与 SDK writeSchema 对齐：{path, content}）。 */
const WRITE_PATH_ARG = 'path';
const WRITE_CONTENT_ARG = 'content';
/**
 * write 的落点白名单：只准 `<platformRoot>/tmp/`。
 *
 * 为什么是 tmp/ 而不是整个工作区：worker 与 coding agent 的差别是"权限更窄"，不是"不能
 * 写"。它需要写的是**中间产物**（契约、mapping、为某张表临时写的抽取脚本）——草稿，不是
 * 系统。tmp/ 已入 .gitignore，且平台自己的执行器也往那儿写 fallback 产物
 * （transform.py 的 `tmp/整理好的…（自动）.xlsx`），不是新开先例。
 * 放整个工作区就等于给了改执行层的权限，那正是必须守住的线。
 */
const WRITE_ROOT_SEGMENT = 'tmp';
/** 单次写入体积上限：草稿产物够用，同时防止有人拿它当磁盘占满工具。 */
const MAX_WRITE_BYTES = 256 * 1024;

/**
 * 单个取值截断：参数摘要不许把进度帧撑成长文。
 * 导出是为了让计划提交的审计摘要（describePlanCalls）用同一把尺——截断预算只有一份，
 * 不存在"进度帧截 24、审计截 40"的两本账。
 */
export const KEY_ARG_MAX_CHARS = 24;

/** 审计 detail 的长度上限：与 createServeGate 落账时同一把尺（命令原文也按它截断）。 */
export const AUDIT_DETAIL_MAX_CHARS = 200;

/** rel 是否落在本轮草稿目录内（`tmp/<id>` 或其子目录；`tmp/<id>x` 不算）。 */
function isInsideScratch(rel: string, scratchDir: string): boolean {
  const prefix = scratchDir.endsWith(path.sep) ? scratchDir : `${scratchDir}${path.sep}`;
  return rel === scratchDir.replace(/\/$/, '') || rel.startsWith(prefix);
}

function matchesAny(value: string, rules: readonly string[]): boolean {
  return rules.some((rule) => value.includes(rule) || value.endsWith(rule));
}

/**
 * 敏感路径匹配：matchesAny 之外，`<dir>/` 形式的规则也要挡住**目录本身**。
 *
 * 为什么单列：matchesAny 用 includes/endsWith，`.runtime/` 匹配不到 `.runtime`
 * （值没有结尾斜杠）。原先这个缺口被知识面顺带堵着——`ls .runtime` 因不在知识面而被拒，
 * 看不出敏感检查自己的问题。ls 放行后缺口直接露出来：列 `.runtime` 就能看到平台审计
 * 文件名。规则以 `/` 结尾即表达"这是一个目录"，目录自身与目录内一视同仁。
 */
function sensitiveMatch(value: string, rules: readonly string[]): boolean {
  if (matchesAny(value, rules)) return true;
  return rules.some((rule) => rule.endsWith('/') && (value === rule.slice(0, -1) || value.startsWith(rule)));
}

/** 知识面匹配：子串规则之外，目录本身恰是知识根（docs ↔ 规则 docs/）也放行 */
function knowledgeMatch(value: string, rules: readonly string[]): boolean {
  return matchesAny(value, rules) || rules.some((rule) => rule.endsWith('/') && rule.slice(0, -1) === value);
}

/**
 * 把 read/ls 的参数解析为工作区内相对路径；越界返回 null。
 * 词法层挡 ../ 与绝对路径穿越；再沿最近存在祖先做 realpath，挡符号链接逃逸
 * （如 docs -> /etc 时 docs/../ 词法上仍在内、内核解析却出界）。
 */
export function workspaceRelPath(root: string, value: string): string | null {
  if (value.includes('\0')) return null;
  const abs = path.resolve(root, value);
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  let probe = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      const full = suffix.length ? path.join(real, ...suffix) : real;
      const realRel = path.relative(root, full);
      if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) return null;
      return realRel;
    } catch (e) {
      // 目标不存在：符号链接无从指向真实文件，词法检查已够；其余错误（权限/循环）拒绝
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * 首词规则（警职执法）：识别"这条 bash 是不是一次平台网关调用"——首 token 须为网关
 * 可执行文件（可带路径前缀）。模式从配置值 GATEWAY_INVOCATION 构造，不硬编码网关名
 * （平台改网关名只改 platform-contract.ts 那一处）。env 前缀（FOO=bar …）天然不匹配。
 */
const SERVE_CLI_INVOCATION_RE = new RegExp(`(^|/)${GATEWAY_INVOCATION}$`);
/**
 * 网关 plan 提交识别（警职执法）：命中即走"教学式拒绝"分支（真形状见 error-codes 的
 * PLAN_SHAPE_GATE_TEACHING），而非 merely block。模式同样从配置值 GATEWAY_INVOCATION
 * 构造——与 plan-runtime 的 locatePlanSubmission 共用同一网关名来源，不存在第二份抄写。
 */
const SERVE_CLI_PLAN_RE = new RegExp(`(?:^|\\s)(?:[^\\s]+/)?${GATEWAY_INVOCATION}\\s+plan(?:\\s|$)`);
export function isServeCliInvocation(command: string): boolean {
  const head = splitCommandTokens(command)[0];
  if (!head) return false;
  return SERVE_CLI_INVOCATION_RE.test(head);
}

// 命令拼接/替换/重定向/管道：worker bash 经 shell 执行，放行这些字符等于放行任意命令
const SHELL_METACHAR_RE = /[;&|<>`$()\n\r]/;

/** 命令含 shell 元字符（; & | < > ` $ ( ) 或换行）→ true。网关调用的合法参数（名称、编号/时间、脚本路径、flag）不含这些字符 */
export function hasShellMetachars(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}

/**
 * 命令分词（剥离 bash/sh 前缀）：脚本提取与参数摘要共用同一套词法——
 * 解析只此一份，不存在第二套命令解析。
 */
export function splitCommandTokens(command: string): string[] {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === 'bash' || tokens[0] === 'sh') tokens.shift();
  return tokens;
}

/**
 * 计划前置豁免的**元数据**子命令白名单——显式枚举，绝不开成"任意子命令豁免"。
 *
 * 为什么需要豁免：本门的 `planActive` 前置要求"先有计划才准调网关"，而平台自己定义里
 * 能力面与计划形状都是元数据命令（`operation list` / `plan --schema`）——它们在平台 CLI
 * 里 return 在 plan 评估、限流、mode×access 矩阵之前，不触平台会话、不耗令牌、不执行
 * 任何东西（与 `bin/17dz memory` 同族）。豁免它们解的是一个死锁：**写计划要先知道
 * operation 名，知道 operation 名要先有计划。**
 *
 * 不豁免的后果已实测：worker 的能力视野只剩 serve skill 里手写的"可用脚本"表
 * （2026-10-07 排查时它只有 5 行，而平台 registry 有 25 个 operation）——工资域
 * `payroll.*` 在册却从未被任何 serve 调用触达（`.runtime/invocations.jsonl` 里 payroll
 * 出现 0 次），于是 worker 如实报告"平台没有这个能力"。
 *
 * 为什么是白名单而不是放行整个 `operation` / `plan` 组：`operation run <name>` 是**真
 * 执行**（要计划、要记账），`plan evaluate` 是**提交方案**（由宿主代提，worker 直达走
 * PLAN_SHAPE_GATE_TEACHING）。这两类一放，计划门就等于拆了。
 *
 * 平台新增元数据出口时往这里加一条；加之前先确认它确实不触平台会话。
 */
const SERVE_METADATA_COMMANDS: ReadonlySet<string> = new Set([
  'operation list',
  'plan --schema',
  'plan schema',
]);

/**
 * local 执行的根：**本轮 scratchDir**（宿主自己的概念），以及辅助技能面暴露的技能脚本。
 *
 * 为什么从平台目录名换成宿主的 scratchDir：原先凭平台目录名 `tmp/` 放行，于是
 * `bin/17dz local tmp/req_别人的/x.py` 能跑——跨会话执行面（别人的请求目录里躺着别人
 * 的脚本，跑它读到的是别人的产物）。而 `scratchDir`（`tmp/req_<requestId>`）是宿主按
 * requestId 派生的，凭它判既堵洞又不新增平台知识：宿主本来就知道自己给 worker 开了哪个
 * 草稿目录（write 门用的就是同一个值）。
 *
 * 不变量：**local 的放行面不宽于 write 的放行面**——worker 只能跑自己写得进去的脚本。
 * 因此 scratchDir 缺省时退回 write 的根（`WRITE_ROOT_SEGMENT`），与 write 分支同一句
 * "缺省只约束必须在 tmp/ 下"（向后兼容与单测隔离）；生产路径上 context 总是带
 * scratchDir，洞在真实部署里不存在。
 *
 * 为什么放宽到第二个前缀：serve worker 读不了二进制附件，平台也没有"任意格式 → 文本"的
 * 能力；而抄一份技能脚本到 tmp/ 再跑会丢配置——脚本按约定从自己真身旁边的配置文件读
 * 凭据，抄走之后路径变了，必然失败。所以平台侧（网关）放行"原地跑"辅助技能面的脚本，
 * 宿主这里只要还认得出"这是一次本地执行"。
 *
 * 为什么只是**前缀**判断：具体哪个技能可跑由平台裁决（软链即选择性暴露，实体目录与
 * 建造本尊路径都不放行，判据见平台 serve 法域守卫）。宿主不持平台路径名单——镜像即
 * 分叉：名单写在这儿，平台改了暴露面而宿主没同步，就变成"宿主放行、平台拒绝"的错位。
 * 因此这里只判"本地执行、不需要计划"，平台侧 fail-closed 把最后一道。
 */
const LOCAL_SKILLS_SERVE_ROOT = '.agents/skills-serve';

/** local 执行的根名单：本轮 scratchDir（缺省退回 write 的根）+ 辅助技能面。 */
function localRoots(scratchDir?: string): readonly string[] {
  return scratchDir ? [scratchDir, LOCAL_SKILLS_SERVE_ROOT] : [WRITE_ROOT_SEGMENT, LOCAL_SKILLS_SERVE_ROOT];
}

/**
 * local 执行：`bin/17dz local <本地脚本>` —— 跑 worker 自己写的解析代码，或平台辅助技能面
 * 暴露的技能脚本。
 *
 * 为什么也要免计划前置：它是纯本地计算（不触平台会话、不耗令牌、不写平台数据），
 * 为它提一条计划纯属仪式；而且 worker 常常要"先写脚本、再跑、看输出、再改"，
 * 每跑一次都走一遍计划门会把回合拖垮。
 *
 * 边界不在本文件——在平台侧：网关只放行本地根目录下的脚本（宿主 write 门已把 worker 的
 * 可写位置钉死在 `tmp/<requestId>/`），且子进程 env 被剥掉凭据类变量。本文件只负责
 * "这条命令属于本地执行、不需要计划"，不判断脚本内容、也不判断它在平台上是否真放行。
 *
 * `scratchDir` 必须从调用方透进来：判据是"这个脚本落点是不是本轮草稿目录"，而草稿目录
 * 是每请求一个的运行时事实，模块级常量答不出来（D-083 之后 local 从"tmp/ 下都行"收成
 * "只有本轮那一个目录行"，堵的就是跨会话执行面）。
 */
/**
 * local 模式的调用目标（不论是否在放行根内）：`bin/17dz local <路径>` → 该路径;
 * 不是 local 模式 / 没有目标 → null。
 *
 * 与 isLocalScratchRun 的分工：后者答"放不放行"，前者只答"这是不是一次 local 调用"。
 * 必须有后者之外的这一问，否则 local 打到放行根之外时会落穿到通用网关分支被放行
 * （判据见 createServeGate 里 SERVE_LOCAL_OUTSIDE_SCRATCH 那支的注释）。
 */
function localModeTarget(command: string): string | null {
  const tokens = splitCommandTokens(command);
  if (!tokens[0] || !SERVE_CLI_INVOCATION_RE.test(tokens[0])) return null;
  if (tokens[1] !== 'local') return null;
  return tokens[2] ?? null;
}

function isLocalScratchRun(command: string, scratchDir?: string): boolean {
  const tokens = splitCommandTokens(command);
  if (!tokens[0] || !SERVE_CLI_INVOCATION_RE.test(tokens[0])) return false;
  if (tokens[1] !== 'local') return false;
  const target = tokens[2];
  if (!target) return false;
  // 只认本地根下的相对路径；带 ../ 或绝对路径的一律不当本地执行（交给后面的通用分支拒）
  return localRoots(scratchDir).some((root) => target === root || target.startsWith(`${root}/`));
}

/**
 * 命令 → 命中的元数据子命令名；不是元数据返回 null。
 *
 * 先校验首 token 确是网关（复用 SERVE_CLI_INVOCATION_RE，网关名单仍只有
 * platform-contract 那一处），再认子命令——否则一条普通命令里拼上 `operation list`
 * 字样就能绕过计划前置。
 */
export function serveMetadataCommand(command: string): string | null {
  const tokens = splitCommandTokens(command);
  if (!tokens[0] || !SERVE_CLI_INVOCATION_RE.test(tokens[0])) return null;
  const head = tokens[1];
  const sub = tokens[2];
  if (!head || !sub) return null;
  // `plan schema` 与 `plan --schema` 是同一个出口的两种写法（平台 CLI 都认），归一成
  // 同一个白名单键——否则白名单要记两条，读的人还以为有两个命令。
  const candidate = head === 'plan' && sub === 'schema' ? 'plan --schema' : `${head} ${sub}`;
  return SERVE_METADATA_COMMANDS.has(candidate) ? candidate : null;
}

/** 从网关调用中提取脚本参数（网关 <mode> <script> …），非查询型返回 null */
export function extractGateScript(command: string): string | null {
  const tokens = splitCommandTokens(command);
  if (tokens[1] === 'operation' && tokens[2] === 'run') return tokens[3] ?? null;
  if (['query', 'prepare', 'commit'].includes(tokens[1] ?? '')) return tokens[2] ?? null;
  return null;
}

/**
 * 参数摘要（默认声明式实现）：按**平台 args 规格**（operation-labels 的
 * parseOperationArgStyles 从 `operation list --json` 派生）扫一遍命令——规格里
 * 的 flag 才摘，样式（name 加书名号 / code 原样）也从规格读，宿主不持任何
 * flag 名单（镜像即分叉：平台加了 flag 而宿主名单没同步就退化成渲染层，D-012）。
 *
 * 安全缺省与 label 同族：没有规格 / 规格里查不到这个 flag → 不进摘要，绝不回退
 * 到硬编码名单或"把所有 --flag 都摘上"。flag 不带值（布尔开关，样式 none 本来
 * 就不入表）或后随另一个 flag 时跳过；`--flag 值` 与 `--flag=值` 两种写法都认。
 */
export function describeKeyArgs(command: string, styles?: KeyArgStyles): string[] {
  const tokens = splitCommandTokens(command);
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    // 两种写法都认：--flag 值 / --flag=值（worker 两种都用过）。
    let flag = token;
    let value: string | undefined;
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=');
      flag = token.slice(0, eq);
      value = token.slice(eq + 1);
    } else {
      value = tokens[i + 1];
      if (!value || value.startsWith('--')) value = undefined;
      else i += 1;
    }
    const style = styles?.get(flag);
    if (!style || !value) continue;
    // 值可能自带引号（worker 传参把引号嵌进了值里）：剥掉再套书名号，避免 「"X"」。
    const text = value.replace(/^["']+|["']+$/g, '').slice(0, KEY_ARG_MAX_CHARS);
    if (!text) continue;
    args.push(style === 'name' ? `「${text}」` : text);
  }
  return args;
}

/**
 * 计划提交的审计摘要：operation 名 + args 摘要（**绝不做计划 JSON 全文**）。
 *
 * 为什么单独一个摘要器而不是把命令原文当 detail：计划提交是单行 JSON，一份方案可以很
 * 长（多个 calls、每个 call 带完整参数），全文进审计会把 tool_calls 撑爆，排查时反而
 * 找不到重点。而"worker 提交了什么方案"必须可查——审计缺口曾让计划内容在 tool_calls
 * 里完全没痕迹。口径与 describeKeyArgs 同一套：按平台数据机械摘取、单值截断
 * （KEY_ARG_MAX_CHARS）、整体有上限（AUDIT_DETAIL_MAX_CHARS），不解析、不解释。
 */
export function describePlanCalls(calls: readonly PlanCall[]): string {
  const summary = calls
    .map((call) => {
      const args = call.args
        .map((value) => (typeof value === 'string' ? value : String(value)))
        .map((value) => value.slice(0, KEY_ARG_MAX_CHARS))
        .join(' ');
      return args ? `${call.operation} ${args}` : call.operation;
    })
    .join(' ; ');
  return summary.slice(0, AUDIT_DETAIL_MAX_CHARS);
}

/**
 * 写入类工具（write / edit）的**共用**边界判据——一份，不是两份。
 *
 * 为什么必须抽出来：SDK 的 edit 入参键是 `path`，与 read/ls 相同。若不给 edit 单开一个
 * 分支，它就会落进下面那个处理 read/ls 的 else 分支——那里只有知识面与敏感路径检查，
 * **没有任何写入约束**。于是同一个门出现两个相反答案：
 *
 *     write src/payroll/contract.js  → 拦
 *     edit  src/payroll/contract.js  → 放   ← 洞（2026-10-08 实证）
 *
 * 且后果不止"漏一个边界"：edit 同样能改平台侧的内部清单、乃至改这个门自己的源码
 * （serve-gate.ts 本身不在 tmp/ 下）。两份逐字相同的判据必然分叉——补一条边界只补一处、
 * 改一句措辞只改一处，另一处静默腐烂，而分叉的那一侧就是攻击面。因此判据只此一份，
 * 两条分支都调它；能按工具区分的只有拒绝理由里的措辞（写入/修改）。
 *
 * 四条边界，顺序固定（先定位、再身份、再体积）：
 *   ① platformRoot 缺省即拒——没有根就无从判断"在不在 tmp 下"，宁可不放；
 *   ② workspaceRelPath 归一化后越界即拒（../ 穿越、绝对路径越界、符号链接逃逸），
 *      与 read/ls 用同一个规范化函数，不引入第二套路径判据；
 *   ③ 敏感路径即拒（.env / .runtime/ / auth.json / .browser-profile/）；
 *   ④ 不在 tmp/ 下即拒；配了 scratchDir 则只放行本轮那一个子目录；
 *   ⑤ 体积上限（一次能加进来的字节数）。
 * 返回 undefined = 放行。
 *
 * 措辞按 tool 区分（写入/修改）：判据只有一份，但拒绝理由要说清模型刚才想干什么——
 * 它传的是 edits 而回答里说"写入"，模型会以为门没认出它的工具。措辞差异只在这一处，
 * 不影响任何一条判据本身。
 */
function decideFileWrite(
  tool: 'write' | 'edit',
  target: string,
  addedBytes: number,
  ctx: { platformRoot?: string; sensitivePaths: readonly string[]; scratchDir?: string },
): ServeGateVerdict | undefined {
  // 措辞只此一处随 tool 变：write 是整份写入，edit 是精确文本替换。
  const verb = tool === 'edit' ? '修改' : '写入';
  // 没有根无从判断落点，先拒（放在 workspaceRelPath 之前：没有根也没有判据可用）
  if (!ctx.platformRoot) {
    return { block: true, reason: messageTextFor('SERVE_WRITE_NO_PLATFORM_ROOT') };
  }
  const rel = workspaceRelPath(ctx.platformRoot, target);
  if (rel === null) {
    return { block: true, reason: messageTextFor('SERVE_WRITE_OUTSIDE_WORKSPACE', { verb, target }) };
  }
  if (sensitiveMatch(rel, ctx.sensitivePaths)) {
    return { block: true, reason: messageTextFor('SERVE_WRITE_SENSITIVE_PATH', { verb, target }) };
  }
  if (!rel.startsWith(`${WRITE_ROOT_SEGMENT}${path.sep}`)) {
    return {
      block: true,
      reason: messageTextFor('SERVE_WRITE_OUTSIDE_DRAFT_ROOT', { verb, rel }),
    };
  }
  if (ctx.scratchDir && !isInsideScratch(rel, ctx.scratchDir)) {
    // 本轮只准写自己的那个子目录。
    return {
      block: true,
      reason: messageTextFor('SERVE_WRITE_OUTSIDE_REQUEST_SCRATCH', { verb, scratchDir: ctx.scratchDir, rel }),
    };
  }
  if (addedBytes > MAX_WRITE_BYTES) {
    return {
      block: true,
      reason: messageTextFor('SERVE_WRITE_TOO_LARGE', { verb, limitKB: Math.floor(MAX_WRITE_BYTES / 1024), bytes: addedBytes }),
    };
  }
  return undefined;
}

/**
 * 平台脚本路径 → { 域, 文件名（已去 .js/.py 后缀） }；不是该形态返回 null。
 *
 * 形态判据只认平台自己文档化的那一种路径形状（域 + 脚本名 → `src/<域>/scripts/<名>`），
 * 且**不列任何具体域名**——域从路径里读，宿主不持域名表（L2：另立一份名单即分叉）。
 */
function scriptPathParts(reference: string): { domain: string; file: string } | null {
  const m = /(?:^|\/)src\/([^/]+)\/scripts\/([^/]+)$/.exec(reference);
  if (!m) return null;
  return { domain: m[1]!, file: m[2]!.replace(/\.(?:js|py)$/i, '') };
}

/**
 * 命令 → 平台声明的 access 语义（计划前置豁免的判据来源）。undefined = 判据不成立。
 *
 * 解析梯子，全部机械、无一步是宿主判断；任一环不命中即停，绝不猜：
 *   ① 引用原样——`operation run <注册名>` 与已规范化的引用直接就是表键；
 *   ② 路径形态 `src/<域>/scripts/<文件>` → **域内**唯一匹配：文件名等于该域某个
 *      operation 的 command，或以 `<command>-` 开头（脚本文件名比 command 多一段描述
 *      后缀，如 `validate-contract` ↔ command `validate`）。多个命中即歧义 → 不成立；
 *   ③ 其余引用（裸脚本名）→ 与 operationLabel 同一把归一尺（末段、去脚本后缀、去域前缀）。
 *
 * 为什么②必须限定在域内：平台侧同一份脚本名可以登记在多个域，而两个域的语义完全
 * 不同（一个纯本地、一个只读平台数据）。跨域猜就会把"要计划"的调用判成"不要计划"——
 * 那是放松方向，绝不允许；宁可判据不成立而多拦一道。
 */
function planSemanticsOf(command: string, semantics: OperationSemantics | undefined): AccessSemantics | undefined {
  if (!semantics || semantics.size === 0) return undefined;
  const reference = extractGateScript(command);
  if (!reference) return undefined;
  const direct = semantics.get(reference);
  if (direct) return direct;
  const parts = scriptPathParts(reference);
  if (parts) {
    const prefix = `${parts.domain}.`;
    const commands = [...semantics.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    const exact = commands.filter((cmd) => cmd === parts.file);
    if (exact.length === 1) return semantics.get(`${prefix}${exact[0]}`);
    // 脚本名比 command 长：只认"command + 连字符 + 描述后缀"这一种，且必须唯一。
    const extended = commands.filter((cmd) => parts.file.startsWith(`${cmd}-`));
    if (extended.length === 1) return semantics.get(`${prefix}${extended[0]}`);
    return undefined;
  }
  return semantics.get(operationReferenceKey(reference));
}

/**
 * 这次平台调用**要不要过计划门**——判据只有一列：平台语义表的 `plan`。
 *
 * 为什么宿主不再单方面要求"一切平台调用必须有激活计划"：计划门提供三样价值——预算
 * 硬闸（调用数/秒数/通知与重划上限）、范围摘要给人签字、写操作确认门——而对平台自己
 * 声明 `plan:false` 的 operation（纯本地计算：不触平台会话、不耗令牌、不写平台数据）
 * **三样全部不成立**：几秒的本地处理没有预算可言、不碰任何平台实体没有范围可摘要、
 * 不写平台数据无须人认账。宿主此前给 `bin/17dz local <脚本>` 免了计划，却给同样是纯
 * 本地计算的 `bin/17dz query <平台脚本>` 不免——判据看的是调用形态，不是调用性质。
 *
 * 更关键的是平台侧本来就不要求：对 `plan:false` 的 operation，平台 `planEligible` 为假、
 * `reserveInvocation` 根本不调。这道要求是宿主单方面加的，于是出现自相矛盾——宿主在
 * 计划拒绝分流处说"该调用不需要计划、也不要放进计划，直接调用即可"，转身在本书门前
 * 说"尚无宿主激活的平台计划"。同一份平台语义表两处读，矛盾自此消失。
 *
 * fail-closed 方向（宁多拦，不放松）：语义表缺失 / 空表 / 该 operation 不在表里 /
 * `plan` 列取不到 → **不免**，照旧拒 `SERVE_PLAN_NOT_ACTIVE`。放行的调用仍受本门其余
 * 判据约束（首词规则、shell 元字符、local 根、敏感路径一行未改），平台侧矩阵/令牌/
 * 限流/计划校验也一行未改——这里只回答"要不要计划"这一个问题。
 */
function planExempt(command: string, semantics: OperationSemantics | undefined): boolean {
  return planSemanticsOf(command, semantics)?.plan === false;
}

export function createServeGate(options: ServeGateOptions = {}) {
  const { onEvent, platformRoot } = options;
  const sensitivePaths = options.sensitivePaths ?? DEFAULT_SENSITIVE_PATHS;
  const knowledgePaths = options.knowledgePaths ?? DEFAULT_KNOWLEDGE_PATHS;
  const describeArgs = options.describeArgs ?? ((command) => describeKeyArgs(command, options.operationArgStyles));

  const knowledgeBlock = (value: string): ServeGateVerdict => ({
    block: true,
    // 知识面名单（*.md、*.schema.json、.agents/、docs/）是宿主实现细节，不进给 worker 的
    // 消息——它随部署配置变，抄进来就是第二份真相（见 error-codes 的 SERVE_READ_NOT_KNOWLEDGE）。
    reason: messageTextFor('SERVE_READ_NOT_KNOWLEDGE', { target: value }),
  });

  return (toolCall: ServeGateToolCall): ServeGateVerdict | undefined => {
    const name = toolCall.name;
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    let verdict: ServeGateVerdict | undefined;
    let detail = '';
    // 放行的平台调用才有人类可读投影：label 与参数摘要都来自平台数据（清单第 5 列 /
    // args 规格），查不到 label 就不挂——调用方没有帧可发，静默降级。
    let progress: { label: string; keyArgs: string[] } | undefined;

    if (name === 'bash') {
      const command = String(args['command'] ?? '').trim();
      detail = command;
      // 元数据查询先行（且必须排在 SERVE_CLI_PLAN_RE 教学分支之前）：
      // `plan --schema` 字面上含 `plan`，会被那条正则判成"worker 在提交方案"而吃到
      // PLAN_SHAPE_GATE_TEACHING——可它恰恰是平台给宿主的机器可读出口，不是方案提交。
      // 元数据分支不判 planActive（理由见 SERVE_METADATA_COMMANDS 注释），但仍校验
      // shell 元字符，且照常落 onEvent 审计——"宿主放行了什么"必须可复盘。
      const metadata = serveMetadataCommand(command);
      if (metadata) {
        if (hasShellMetachars(command)) {
          verdict = { block: true, reason: messageTextFor('SERVE_BASH_METACHAR_METADATA') };
        }
        // 否则放行：verdict 保持 undefined。detail 已记命令原文，审计由此留痕。
      } else if (isLocalScratchRun(command, options.scratchDir)) {
        // 本地执行：不需要计划（纯本地计算，见 isLocalScratchRun 注释）。shell 元字符仍要
        // 拦——local 的参数是路径/flag，不该有拼接替换。留痕照旧（detail = 命令原文）。
        if (hasShellMetachars(command)) {
          verdict = { block: true, reason: messageTextFor('SERVE_BASH_METACHAR_LOCAL') };
        }
      } else if (localModeTarget(command) !== null) {
        // local 模式但目标不在本轮 scratchDir / 辅助技能面：**必须在这里拦死，不能落穿**。
        //
        // 为什么单独一支：isLocalScratchRun 为假时，命令形状仍是合法的网关调用
        // （`bin/17dz local <路径>`），于是会一路落到文件末尾的通用分支——那儿只问
        // "是不是网关调用 + 有没有活动计划"，两个都真就放行。实证（2026-10-09 验收）：
        // planActive=true 时 `bin/17dz local tmp/req_别人的/x.py`、`local tmp/散脚本.py`、
        // `local src/…/transform.py`、带 ../ 的穿越路径**全部放行**——而它们恰恰是
        // "local 根收紧"要堵的跨会话执行面。只在无计划时被拒（ SERVE_PLAN_NOT_ACTIVE ）
        // 是假象：有条件拒绝等于没拒绝。
        //
        // 判据与 isLocalScratchRun 同源（同一个 localRoots），不立第二份名单。
        verdict = { block: true, reason: messageTextFor('SERVE_LOCAL_OUTSIDE_SCRATCH') };
      } else if (SERVE_CLI_PLAN_RE.test(command)) {
        // 教学而非 merely 拒绝：真实平台实测里旧消息（"只能提交 JSON calls 方案"）
        // 没说怎么提交，worker 被拒后理解成"把 JSON 打印出来"，步步空转。因此这里直接
        // 给出唯一合法形式——bash 工具里的单行原始命令，并点名三种常见错误包装。
        // 措辞收口在 error-codes.ts（PLAN_SHAPE_GATE_TEACHING）：领域无关（业务词预算见
        // platform-leak-lint），也不出现平台脚本文件名。
        verdict = {
          block: true,
          reason: messageTextFor('PLAN_SHAPE_GATE_TEACHING'),
        };
      } else if (!isServeCliInvocation(command)) {
        verdict = { block: true, reason: messageTextFor('SERVE_BASH_NOT_GATEWAY') };
      } else if (hasShellMetachars(command)) {
        verdict = { block: true, reason: messageTextFor('SERVE_BASH_METACHAR_QUERY') };
      } else if (!options.planActive?.() && !planExempt(command, options.operationSemantics)) {
        // 计划前置：先问"这个调用要不要计划"（平台语义表 plan 列），再问"有没有计划"。
        // plan=false 的调用走到这里即放行（不设 verdict），继续受平台侧裁决；plan=true
        // 或判据不成立（查不到）才照旧要求宿主激活的计划——理由见 planExempt 注释。
        verdict = { block: true, reason: messageTextFor('SERVE_PLAN_NOT_ACTIVE') };
      } else {
        const label = operationLabel(options.operationLabels, extractGateScript(command));
        if (label) progress = { label, keyArgs: describeArgs(command) };
      }
    } else if (name === 'write') {
      // ── write：只准写 tmp/ ────────────────────────────────────────────────
      // 判据本体在 decideFileWrite（与 edit 共用一份）：四条边界，缺一不可——
      // ① platformRoot 缺省即拒（没有根就无从判断"在不在 tmp 下"，宁可不放）；
      // ② 路径必须解析进 <platformRoot>/tmp/（workspaceRelPath 挡 ../ 穿越、绝对路径
      //    越界与符号链接逃逸——和 read/ls 用同一个规范化函数，不引入第二套路径判据）；
      // ③ 不得踩敏感路径（.env/.runtime//auth.json/.browser-profile/）；
      // ④ content 有体积上限。
      const target = args[WRITE_PATH_ARG];
      if (typeof target !== 'string' || target.trim() === '') {
        verdict = { block: true, reason: messageTextFor('SERVE_WRITE_PATH_MISSING') };
      } else {
        const content = args[WRITE_CONTENT_ARG];
        const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0;
        verdict = decideFileWrite('write', target, bytes, { platformRoot, sensitivePaths, scratchDir: options.scratchDir });
        // 放行：verdict 保持 undefined；detail 已记路径，审计由此留痕
        if (!verdict) detail = `${target}`;
      }
    } else if (name === 'edit') {
      // ── edit：与 write 同一组边界（decideFileWrite）─────────────────────────
      // 为什么不单独处理就是洞（2026-10-08 实证）：edit 的入参键是 `path`，与 read/ls
      // 相同。不单开这个分支，它就落进下面那个 else——那里只有 read/ls 的知识面与敏感
      // 路径检查，**没有任何写入约束**。实测同一个目标两种答案：
      //   write src/payroll/contract.js → 拦；edit src/payroll/contract.js → 放。
      // 而 edit 是精确文本替换，改一行就能动执行层、配置、乃至这个门自己的源码
      // （serve-gate.ts 本身不在 tmp/ 下）——比整份 write 更隐蔽，因为它看起来"只改了一处"。
      // 边界只有一份（decideFileWrite），不存在"write 收紧而 edit 忘了"的分叉。
      const target = args['path'];
      const edits = args['edits'];
      if (typeof target !== 'string' || target.trim() === '') {
        verdict = { block: true, reason: messageTextFor('SERVE_EDIT_PATH_MISSING') };
      } else if (!Array.isArray(edits) || edits.length === 0) {
        verdict = { block: true, reason: messageTextFor('SERVE_EDIT_EDITS_MISSING') };
      } else {
        // 体积按 edits[].newText 累计：那是一次能加进来的上限。形状不对的条目
        // 让 addedBytes 变 Infinity，由体积判据拒掉——不为它单开一条错误路径。
        let added = 0;
        for (const e of edits) {
          const rec = e as { oldText?: unknown; newText?: unknown } | null;
          if (!rec || typeof rec !== 'object' || typeof rec.oldText !== 'string' || typeof rec.newText !== 'string') {
            added = Number.POSITIVE_INFINITY;
            break;
          }
          added += Buffer.byteLength(rec.newText, 'utf8');
        }
        verdict = decideFileWrite('edit', target, added, { platformRoot, sensitivePaths, scratchDir: options.scratchDir });
        if (!verdict) detail = `${target}`;   // 放行：detail 已记路径，审计由此留痕
      }
    } else {
      for (const key of PATH_ARGS) {
        const raw = args[key];
        if (typeof raw !== 'string') continue;
        detail = raw;
        // 解析后判定：穿越/越界/符号链接逃逸在此被拒；platformRoot 缺省时退回子串兜底
        let value = raw;
        if (platformRoot) {
          const rel = workspaceRelPath(platformRoot, raw);
          if (rel === null) {
            verdict = { block: true, reason: messageTextFor('SERVE_READ_OUTSIDE_WORKSPACE', { target: raw }) };
            break;
          }
          value = rel;
        }
        if (sensitiveMatch(value, sensitivePaths)) {
          verdict = { block: true, reason: messageTextFor('SERVE_READ_SENSITIVE_PATH', { target: raw }) };
          break;
        }
        if (name === 'read') {
          // read：内容层，限知识面。ls 不参与——它只列名字，详见 LS_NOT_KNOWLEDGE_GATED。
          if (!knowledgeMatch(value, knowledgePaths)) {
            verdict = knowledgeBlock(raw);
            break;
          }
        }
      }
    }
    // 审计故障不得影响门裁决
    try {
      onEvent?.({
        tool: name,
        allowed: !verdict,
        reason: verdict?.reason,
        detail: detail.slice(0, AUDIT_DETAIL_MAX_CHARS),
        // 只增补字段：既有消费者（审计留痕）读的那几个字段一字未动
        ...(progress ? { label: progress.label, keyArgs: progress.keyArgs } : {}),
      });
    } catch {}
    return verdict;
  };
}
