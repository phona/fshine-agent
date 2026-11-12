/**
 * G1：serve worker 原生工具门（fshine 侧，挂在 SDK Agent 的 beforeToolCall）。
 *
 * 四层治理里本门负责 worker 的通用原生工具安全：
 *   - bash 仅允许网关调用（首词规则 + shell 元字符白名单：env 前缀、命令拼接、
 *     命令替换、重定向均被拒；法域声明无法剥离）
 *   - 平台计划命令只允许 host 管理；活跃计划由平台执行入口逐次校验，且计划前置按平台
 *     语义表**三级判据**执行（scratch 免计划、read 要激活计划、write 要被激活计划的
 *     某一步覆盖，见 planGateTier）
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
import { operationLabel, operationReferenceKey, type AccessSemantics, type KeyArgStyle, type KeyArgStyles, type OperationArgsSpecs, type OperationLabels, type OperationSemantics } from './operation-labels';
import { gatewayTextPatterns, resolveGatewayText } from './platform-contract';
import { hasServerPath } from './server-paths';
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
  /**
   * 这次调用的形态族（仅 bash；宿主按命令词法机械分类，见 gateInvocationKind）。
   *
   * 为什么必须随事件出来：执行面回执数的是"所有被放行的 bash"，local 与元数据查询
   * 一并计入——只凭它分不出"真调过平台执行器"与"整轮只在本地跑脚本"，而后者正是
   * 要披露的偏离（A1）。放行的与拦截的都挂：被拦的形态同样是"它想怎么调"的证据。
   */
  invocation?: GateInvocationKind;
  /**
   * 这次网关调用在计划门前**已解析的档位**（仅走到计划门裁决的 bash 调用；分级函数与
   * 计划前置同一份，见 tierOfEntry）。
   *
   * 为什么不复用 detail：detail 是审计展示面，落账前已截到 AUDIT_DETAIL_MAX_CHARS；
   * 而控制面（读类探测计数）要的是门实际裁决时用的那个完整的 operation 语义。两者共用
   * 一个字段，长绝对脚本路径会让计数看到残缺引用、查不到语义表（2026-11-10 复审 major：
   * 计划门放行、计数漏计，持续读取不触发收尾提示）。档位是解析结果的小枚举，不随引用
   * 变长，天然满足"控制字段不撑审计"；它也只是控制面数据——assembly 落 tool_calls 时
   * 只取 detail/reason，本字段不落库。
   */
  operationTier?: PlanGateTier;
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
  /**
   * operation → args 规格（positionalNames / flagStyles）。计划覆盖判据据此知道哪些位置
   * 参数是目标（2026-11-09 五审 blocking：只看 flag 会让以位置参数声明目标的执行层失去
   * 写授权范围保护）。缺省 = 无法证明位置范围，计划步带位置参数即不覆盖。
   */
  operationArgsSpecs?: OperationArgsSpecs;
  onEvent?: (event: ServeGateEvent) => void;
  /** 平台根目录：用于经公共 CLI 派生能力清单（定价与脚本存在性校验）。缺省降级。 */
  platformRoot?: string;
  /**
   * profile 声明的网关调用形式（接口文档 §2）：首词规则与 plan 提交
   * 识别据此派生。未注入或非法时 fail-closed（resolveGatewayText 抛错，见
   * platform-contract.ts）；生产路径应由驱动层注入 profile.gateway。
   */
  gateway?: string;
  /** 知识面规则（read/ls 白名单），缺省内置。 */
  knowledgePaths?: readonly string[];
  /** 敏感路径规则，缺省内置。 */
  sensitivePaths?: readonly string[];
  /** Platform-backed plan active for this worker session. */
  planActive?: () => boolean;
  /**
   * **激活计划的 calls**（宿主注入，写类调用的覆盖判据）。
   *
   * 为什么单开一路而不塞进 planActive：两者答的是两个问题——planActive 答"有没有计划"，
   * 本项答"这份计划覆不覆盖这次调用"。写类必须两问都为真才放行（否则"计划里全是读、
   * 写照样调通"：数据落地而用户从未确认）；读类只问前一问。
   *
   * 数据来自宿主自己：驱动层在计划激活时把**本会话提交的那份 calls** 存进 activePlan
   * （`plan.evaluation.delta.calls` 与宿主解析出的 parsed.calls 同源），不去读平台的
   * plans.json，也不扫 worker 文本。返回 null = 宿主拿不到计划内容（典型：恢复的会话，
   * 平台 `plan current` 只回 planId/version）→ 写类一律拒（fail-closed：不知道覆盖
   * 什么就不写，直到本会话重新激活一份计划）。缺省不接 → 同样一律拒。
   */
  activePlanCalls?: () => readonly PlanCall[] | null;
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
  /**
   * **执行模式词汇**（平台 `operation list --json` 每行 serve 矩阵的键并集，宿主经
   * operation-labels 的 `serveModesOf` 派生后注入）。
   *
   * 判据：`<网关> <mode> <脚本>` 算不算执行形态，只认这词汇——宿主不维护第二份 mode
   * 名单（L2），平台加/改 mode 时只改自己的清单，门与 T5 对账同步看得见。缺省 =
   * 调用方没有平台数据（旧版平台 / CLI 不可用 / 单测替身），退回契约兜底词汇
   * （SERVE_MODES_FALLBACK）。
   *
   * 兜底**不是放行面**：词汇外的网关形态一律 fail-closed（SERVE_INVOCATION_FORM_UNKNOWN，
   * 见 createServeGate 的 bash 分支），所以兜底最多把历史三个 mode 送进计划门，绝不
   * 放出任何未登记调用。
   */
  serveModes?: readonly string[];
  /** 参数摘要提取器（测试替身注入点）；缺省用内置 describeKeyArgs（查平台 args 规格）。 */
  describeArgs?: (command: string) => string[];
  /**
   * 本回合的工作区（相对 platformRoot，如 `tmp/task_<taskId>`，宿主按任务注入）。给了它，
   * write 就**只**放行这一个目录——不是约定，是机械边界。
   *
   * 为什么必须是每任务一个：tmp/ 是共享区，多个会话同时写 `tmp/contract.json` 会互相
   * 覆盖，而覆盖后的产物看不出是被谁污染的。宿主已有现成的随机源（taskId），用它派生
   * 一个子目录即可，不需要 worker 自己随机（它也没有随机手段）；同任务续跑共享同一
   * 工作区（变更项 ⑨）。
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
export const MAX_WRITE_BYTES = 256 * 1024;

/**
 * 单个取值截断：参数摘要不许把进度帧撑成长文。
 * 导出是为了让计划提交的审计摘要（describePlanCalls）用同一把尺——截断预算只有一份，
 * 不存在"进度帧截 24、审计截 40"的两本账。
 */
export const KEY_ARG_MAX_CHARS = 24;

/** 审计 detail 的长度上限：与 createServeGate 落账时同一把尺（命令原文也按它截断）。 */
export const AUDIT_DETAIL_MAX_CHARS = 200;

/**
 * rel 是否落在本轮草稿目录内（`tmp/<id>` 或其子目录；`tmp/<id>x` 不算）。
 *
 * 导出只为一把尺子量所有"这文件是不是本轮私产"的判定：write/edit 门用它，提案创建拦截的
 * payload 路径边界检查也用它（B 波 B3）。判据只有一份——在调用方各写一遍就会出现
 * "write 认子目录、提案只认顶层"这类分叉。
 */
export function isInsideScratch(rel: string, scratchDir: string): boolean {
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
 * 文本识别正则的来源：createServeGate 按注入的 gateway 派生
 * （gatewayTextPatterns），未注入时 fail-closed 抛错；与 plan-runtime 的
 * locatePlanSubmission 共用同一网关名来源，不存在第二份抄写。
 * 模块级常量不再持有网关名——正则随 gate 实例走 profile。
 */
function servePatterns(gateway?: string): { invocation: RegExp; plan: RegExp } {
  return gatewayTextPatterns(resolveGatewayText(gateway));
}
/**
 * 首词规则（警职执法）：识别"这条 bash 是不是一次平台网关调用"——首 token 须为网关
 * 可执行文件（可带路径前缀）。模式从注入的 gateway 派生（gatewayTextPatterns），
 * 未注入时 fail-closed 抛错（接口文档 §2/§10）。env 前缀天然不匹配。
 */
export function isServeCliInvocation(command: string, gateway?: string): boolean {
  const head = splitCommandTokens(command)[0];
  if (!head) return false;
  return servePatterns(gateway).invocation.test(head);
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
/**
 * 命令 → token 表（**认 shell 引号与转义**：单引号内字面、双引号内可转义、反斜杠转义）。
 *
 * 2026-11-09 八审 major：旧写法 `trim().split(/\s+/)` 是纯空白分词，`--collection "alpha"`
 * 会产出 token `"alpha"`（带引号），与计划里的 `alpha` 比对不上——**语义相同的合法写调用被
 * 误拒**；名称含空格时更被拆成多个参数。覆盖判据要与"实际 shell 看到的参数"一致，分词器就
 * 必须和 shell 一致，否则判据比的是另一回事。
 */
/**
 * 只剥** Bash 词法空白**（空格/制表符/换行），不动 Unicode 空白与控制字符。
 *
 * 2026-11-09 十六审 blocking：`String.trim()` 用的是 Unicode 空白定义，会把尾部的
 * U+00A0、U+3000、\r 一起剥掉——而 Bash 把它们保留在参数里。计划批准 `--target alpha`
 * 时，实际传入 `alpha\u00a0`（另一个目标）会被判成覆盖。判据必须与 Bash 看到的一致，
 * 预处理就不能比 Bash 多删字符。
 */
function trimShellWhitespace(command: string): string {
  let start = 0;
  let end = command.length;
  const isSep = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n';
  while (start < end && isSep(command[start]!)) start += 1;
  while (end > start && isSep(command[end - 1]!)) end -= 1;
  return command.slice(start, end);
}

export function splitCommandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  const src = trimShellWhitespace(command);
  // 双引号内**只有** $ ` " \ 换行 五个字符前的反斜杠是转义序列，其余位置反斜杠
  // **字面保留**（POSIX/Bash 语义）。旧写法在双引号内无条件吞反斜杠：`"\alpha"` 被解析成
  // alpha，而 Bash 实际传入 `\alpha`——计划批准 --collection alpha 时，覆盖判据会放行
  // 实际指向别名的写调用（十审 blocking：分词与 Bash 语义不一致 = 判据比的是另一回事）。
  const escapableInDoubleQuote = new Set(['$', '`', '"', '\\', '\n']);
  for (let index = 0; index < src.length; index += 1) {
    const ch = src[index]!;
    if (quote === null && ch === '\\') {
      const next = src[index + 1];
      if (next === undefined) { current += ch; started = true; continue; }   // 行尾孤立反斜杠：字面
      // 反斜杠 + 换行 = 续行，**两者都删掉**（Bash 语义，十三审 minor）。旧写法只跳过反斜杠
      // 本身、把换行留在参数里——于是 `--target al\<换行>pha` 解析成 "al\npha"，与计划里的
      // alpha 比对不上，合法写调用被误判成未覆盖。
      if (next === '\n') { started = true; index += 1; continue; }
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      const next = src[index + 1];
      if (next !== undefined && escapableInDoubleQuote.has(next)) {
        current += next === '\n' ? '' : next;
        started = true;
        index += 1;
        continue;
      }
      current += ch;   // 不可转义：反斜杠字面保留
      started = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    // 只认 Bash 真正当分隔符的空白：**空格 / 制表符 / 换行**三种。
    // **不**用 /\s/，也不要把回车/换页/垂直制表符算进来——Bash 把它们保留在参数里
    // （十五审 blocking：`--target alpha\rbeta` 若被拆成 alpha + beta，计划只声明
    // --target alpha 时判覆盖并忽略多出的位置参数，放行实际指向别名的写调用）。
    // 同理 Unicode 空白（U+00A0、U+3000…）也不是分隔符（十四审 blocking）。
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  if (tokens[0] === 'bash' || tokens[0] === 'sh') tokens.shift();
  return tokens;
}


/**
 * 计划前置豁免的**元数据**子命令白名单——显式枚举，绝不开成"任意子命令豁免"。
 *
 * 为什么需要豁免：本门的 `planActive` 前置要求"先有计划才准调网关"，而平台自己定义里
 * 能力面与计划形状都是元数据命令（`operation list` / `plan --schema`）——它们在平台 CLI
 * 里 return 在 plan 评估、限流、mode×access 矩阵之前，不触平台会话、不耗令牌、不执行
 * 任何东西（与 `bin/<gateway> memory` 同族）。豁免它们解的是一个死锁：**写计划要先知道
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
 * 宿主认得的**非执行器 CLI 组**（只用于形态识别，与计划门豁免是两件事）。
 *
 * 为什么必须单列：`operation list` / `plan --schema` 经 SERVE_METADATA_COMMANDS 免计划前置，
 * 而 `memory`（领域记忆读写）今天**不免**——它仍要宿主激活的计划才准调，这个现状一字不改。
 * 但两者都必须是"认得的平台形态"：认不出就会被形态分支以 SERVE_INVOCATION_FORM_UNKNOWN 拒掉，
 * 而 memory 是平台技能文档写明给 serve worker 用的出口（记忆读写只经它），拒它等于把一条
 * 合法能力关掉——那不是本次要堵的东西（本次堵的是"猜一个形状"）。
 *
 * 与 SERVE_METADATA_COMMANDS 的分工：那个答"要不要计划前置"，这个答"是不是平台的调用形态"。
 * 平台新增出口时两处各按自己的判据决定加不加——加进这里只是"认得其形态"，加进那里才是
 * "免计划前置"。两个集合因此**不要求一致**，也不该为了省事合并（合并要么放松计划门，
 * 要么把 memory 关掉）。
 */
const SERVE_NON_EXECUTOR_GROUPS: ReadonlySet<string> = new Set(['memory']);

/**
 * local 执行的根：**本轮 scratchDir**（宿主自己的概念），以及辅助技能面暴露的技能脚本。
 *
 * 为什么从平台目录名换成宿主的 scratchDir：原先凭平台目录名 `tmp/` 放行，于是
 * `bin/<gateway> local tmp/别人的/x.py` 能跑——跨会话执行面（别人的工作区里躺着别人
 * 的脚本，跑它读到的是别人的产物）。而 `scratchDir`（`tmp/task_<taskId>`）是宿主按
 * 任务派生的，凭它判既堵洞又不新增平台知识：宿主本来就知道自己给 worker 开了哪个
 * 工作区（write 门用的就是同一个值）。
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
 * local 执行：`bin/<gateway> local <本地脚本>` —— 跑 worker 自己写的解析代码，或平台辅助技能面
 * 暴露的技能脚本。
 *
 * 为什么也要免计划前置：它是纯本地计算（不触平台会话、不耗令牌、不写平台数据），
 * 为它提一条计划纯属仪式；而且 worker 常常要"先写脚本、再跑、看输出、再改"，
 * 每跑一次都走一遍计划门会把回合拖垮。
 *
 * 边界不在本文件——在平台侧：网关只放行本地根目录下的脚本（宿主 write 门已把 worker 的
 * 可写位置钉死在 `tmp/task_<taskId>/`），且子进程 env 被剥掉凭据类变量。本文件只负责
 * "这条命令属于本地执行、不需要计划"，不判断脚本内容、也不判断它在平台上是否真放行。
 *
 * `scratchDir` 必须从调用方透进来：判据是"这个脚本落点是不是本轮草稿目录"，而草稿目录
 * 是每请求一个的运行时事实，模块级常量答不出来（D-083 之后 local 从"tmp/ 下都行"收成
 * "只有本轮那一个目录行"，堵的就是跨会话执行面）。
 */
/**
 * 网关口词的第二个 token 是不是 `local` —— **模式认得出来，不要求带目标**。
 *
 * 为什么单开这一问（等价于原 localModeTarget 的"是不是 local 调用"那一半）：local
 * 打到放行根之外时命令形状仍是合法网关调用，会在通用网关分支里被当"非 local 网关调用"
 * 送进计划前置（越界的执行面拦截归执行层网关原生执法）；而 local 模式**免计划前置**
 * （理由见 isLocalScratchRun 注释）。缺目标由执行层按用法错误拒（平台 CLI 的 local 分支
 * 没有目标即 exit 2，不执行任何东西），宿主不把认得出来的形态当成"猜形状"拦死。
 */
function isLocalMode(command: string, gateway?: string): boolean {
  const tokens = splitCommandTokens(command);
  if (!tokens[0] || !servePatterns(gateway).invocation.test(tokens[0])) return false;
  return tokens[1] === 'local';
}

function isLocalScratchRun(command: string, scratchDir?: string, platformRoot?: string, gateway?: string): boolean {
  const tokens = splitCommandTokens(command);
  if (!tokens[0] || !servePatterns(gateway).invocation.test(tokens[0])) return false;
  if (tokens[1] !== 'local') return false;
  const target = tokens[2];
  if (!target) return false;
  // 相对路径按前缀判；绝对路径解析后判包含——write 回执给 worker 的是绝对路径，
  // 一刀切拒绝对路径等于门否认自己的回执（2026-10-18 实测：worker 的吸收脚本
  // 两度被拒后按经济性纪律放弃，吸收循环就此断线）。../ 与工作区外目录解析后
  // 仍然拒，边界语义不变。
  const inRoot = (target: string, root: string): boolean => {
    const t = platformRoot ? path.resolve(platformRoot, target) : path.normalize(target);
    const r = platformRoot ? path.resolve(platformRoot, root) : path.normalize(root);
    return t === r || t.startsWith(`${r}${path.sep}`);
  };
  return localRoots(scratchDir).some((root) => inRoot(target, root));
}

/**
 * 命令 → 命中的元数据子命令名；不是元数据返回 null。
 *
 * 先校验首 token 确是网关（servePatterns 按注入 gateway 派生），再认子命令——否则一条普通命令里拼上 `operation list`
 * 字样就能绕过计划前置。
 */
export function serveMetadataCommand(command: string, gateway?: string): string | null {
  const tokens = splitCommandTokens(command);
  if (!tokens[0] || !servePatterns(gateway).invocation.test(tokens[0])) return null;
  const head = tokens[1];
  const sub = tokens[2];
  if (!head || !sub) return null;
  // `plan schema` 与 `plan --schema` 是同一个出口的两种写法（平台 CLI 都认），归一成
  // 同一个白名单键——否则白名单要记两条，读的人还以为有两个命令。
  const candidate = head === 'plan' && sub === 'schema' ? 'plan --schema' : `${head} ${sub}`;
  return SERVE_METADATA_COMMANDS.has(candidate) ? candidate : null;
}

/**
 * 执行模式词汇的**契约兜底**（仅在调用方没有注入平台 serve 矩阵时使用）。
 *
 * 权威在平台清单的 serve 矩阵（operation-labels 的 serveModesOf）：注入了 serveModes
 * 时本常量不参与识别。它存在的理由只有一个——旧版平台 / CLI 不可用 / 单测替身拿不到
 * 平台数据时，门仍要能认出历史形态并**送进计划门**（而不是把一条有据可查的历史 mode
 * 当成"猜形状"拦死）。它不扩大放行面：词汇外的形态一律 SERVE_INVOCATION_FORM_UNKNOWN
 * fail-closed，见 createServeGate 的 bash 分支。
 */
const SERVE_MODES_FALLBACK: readonly string[] = ['query', 'prepare', 'commit'];

/**
 * 从网关调用中提取脚本参数（`<网关> <mode> <脚本>`），不是执行形态返回 null。
 *
 * mode 词汇来自平台 serve 矩阵（`serveModes` 注入；缺省退回契约兜底词汇，见
 * SERVE_MODES_FALLBACK 注释）——宿主不在这里维护第二份 mode 名单。`operation run`
 * 是按注册名寻址的 CLI 出口（平台清单不声明它），单独认。
 */
export function extractGateScript(command: string, serveModes?: readonly string[]): string | null {
  const tokens = splitCommandTokens(command);
  if (tokens[1] === 'operation' && tokens[2] === 'run') return tokens[3] ?? null;
  const head = tokens[1];
  if (head === undefined) return null;
  if (!(serveModes ?? SERVE_MODES_FALLBACK).includes(head)) return null;
  return tokens[2] ?? null;
}

/**
 * 一次网关调用的**形态族**（宿主按命令词法机械分类，不猜内容）：
 *   · `executor`  —— 经计划门放行的平台执行调用（query / prepare / commit / operation run）；
 *   · `local`     —— 本地执行（纯本地计算，不触平台会话，见 isLocalScratchRun）；
 *   · `auxiliary` —— 平台的辅助出口（能力面/计划形状元数据、领域记忆）：不执行任何业务
 *                    操作，因此**不计入**"本轮有没有调过平台执行器"；
 *   · `null`      —— 三种都认不出来：缺 mode、缺脚本路径、或用了未注册的形式。
 *
 * 为什么必须有这一问：执行面回执（`execution.calls`）数的是**所有**被放行的 bash，
 * local 与辅助出口一并计数——于是"整轮只有 local 调用"在足迹里与"真调过平台执行器"
 * 完全同形，**绕开平台执行器因此不可观测**（A1 实测：一次"成功"的委派，平台审计里
 * validate / transform 一次没经网关，而足迹只写着 1 次网关调用）。分类因此必须存在，
 * 且只能从命令自己的词法得出。
 *
 * 不引入第二套命令解析：各族由既有的唯一判据判定（serveMetadataCommand / isLocalMode /
 * extractGateScript / SERVE_NON_EXECUTOR_GROUPS），这里只把它们的结论汇成一个族名——平台
 * 改了模式面，改那几处即可，不存在"族名表"要同步的第五份名单。
 */
export type GateInvocationKind = 'executor' | 'local' | 'auxiliary';

export function gateInvocationKind(command: string, gateway?: string, serveModes?: readonly string[]): GateInvocationKind | null {
  if (serveMetadataCommand(command, gateway)) return 'auxiliary';
  if (isLocalMode(command, gateway)) return 'local';
  if (extractGateScript(command, serveModes) !== null) return 'executor';
  const tokens = splitCommandTokens(command);
  if (tokens[1] && SERVE_NON_EXECUTOR_GROUPS.has(tokens[1])) return 'auxiliary';
  return null;
}

/**
 * 命令**位**上的网关令牌（`cd X && bin/<gateway> …` 里的 `bin/<gateway>`）；没有返回 null。
 *
 * 命令位 = 第一个 token，以及每个命令分隔符（`;` `&` `|`）之后的 token。分隔符既可
 * 独立成 token（`&& bin/<gateway>`），也可粘在两侧任一个 token 上（`X; bin/<gateway>`、
 * `X&&bin/<gateway>`）——三种写法都是同一条命令链，判据必须一视同仁。
 *
 * 为什么必须限"命令位"而不是"命令里出现过"：`ls -la bin/<gateway>`、`cat bin/<gateway>`
 * 只是引用文件名，不是调用；把它们判成"借道命令链调网关"是假拒——判据一旦会假红，
 * 人就学会忽略它。env 前缀（`FOO=1 bin/<gateway> …`）同样不是命令位（既有首词规则口径）。
 */
function gatewayCommandPosition(command: string, gateway?: string): string | null {
  const tokens = splitCommandTokens(command);
  const pattern = servePatterns(gateway).invocation;
  const SEPARATOR_RE = /^[;&|]+$/;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = tokens[index - 1];
    let atCommandPosition = index === 0
      || (previous !== undefined && SEPARATOR_RE.test(previous))
      || (previous !== undefined && /[;&|]$/.test(previous));
    // 分隔符可粘在 token 内部（`X&&bin/<gateway>`、`bin/<gateway>;rm`）：逐段判定，
    // 分隔符之后的每一段都是新的命令位——与加空格的写法同判。
    for (const segment of token.split(/[;&|]+/)) {
      if (!segment) continue;
      if (atCommandPosition && pattern.test(segment)) return segment;
      atCommandPosition = true;
    }
  }
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
 *
 * 服务器路径同样不进摘要（2026-10-20 真机实测）：摘要的**唯一去处是用户可见进度帧**，
 * 而平台把一堆路径型 flag 声明成了 name 样式（--out-dir / --contract / --cache /
 * --out / --decisions、payroll 与 voucher 各域的位置参数），取值又常是宿主自己的任务
 * 工作区 `tmp/task_<uuid>`。路径对渠道那头的用户零可行动性——拿到路径等于什么都没拿到。
 * 判据用宿主那把 `hasServerPath`（server-paths.ts），不在这里另立一份形状；被拦的只是
 * 这个取值，同一命令里的其他取值照旧进摘要（帧仍在，只是不再带路径）。
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
    // 路径型取值不上用户的屏幕（判据见函数注释）：宁缺勿滥——摘要少一项只是帧里
    // 少个参数，路径上屏是让用户拿到一个他根本用不了的东西。
    if (hasServerPath(text)) continue;
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
 * 命令 → 平台声明的 access 语义**连同它在表里的键**（undefined = 判据不成立）。
 *
 * 为什么连键一起返回：拒绝理由要点名"哪个 operation 不在计划里"，而点名只能用表里的
 * 注册名（`voucher.fill`），不能拿命令里的脚本路径顶替——消息纪律明写脚本名/路径不进
 * 消息（同 SERVE_INVOCATION_FORM_UNKNOWN）。梯子因此只有一份，键与语义同源产出。
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
function planSemanticsEntryOf(
  command: string,
  semantics: OperationSemantics | undefined,
  serveModes?: readonly string[],
): { key: string; access: AccessSemantics } | undefined {
  return planSemanticsEntryForReference(extractGateScript(command, serveModes) ?? '', semantics);
}

/**
 * 按**已取到的 operation 引用**查语义表（命令字符串的解析在外层）。
 *
 * 2026-11-09 拆出来：结构化调用（structured_call）手里本来就是注册名，没有命令串可解析。
 * 它必须与 bash 走同一份覆盖判据（PR #21 四审 blocking：structured_call 分支原先只查
 * requiresPlan 的存在性，激活一份纯读计划后写 operation 照样进网关）——复用同一个查表函数
 * 是"只有一份真相"的前提，否则迟早漂移。
 *
 * 2026-11-10 导出：读类探测帽（pi-coding-driver 的 isDeclaredReadOperation）也走这把梯子。
 * 它原先自己拿 operationReferenceKey 把脚本路径压成裸 command 再查表——裸键可能属于另一个
 * 域（两个域都注册 `query`、一个读一个写），或表里根本没有（`query-detail.js` ↔ 命令
 * `query`），于是计划门放行的读类调用不被计数。域感知解析只此一份，任何按引用查语义表的
 * 调用方都必须从这里进来。
 */
export function planSemanticsEntryForReference(
  reference: string,
  semantics: OperationSemantics | undefined,
): { key: string; access: AccessSemantics } | undefined {
  if (!reference) return undefined;
  if (!semantics || semantics.size === 0) return undefined;
  const direct = semantics.get(reference);
  if (direct) return { key: reference, access: direct };
  const parts = scriptPathParts(reference);
  if (parts) {
    const prefix = `${parts.domain}.`;
    const commands = [...semantics.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    const exact = commands.filter((cmd) => cmd === parts.file);
    if (exact.length === 1) {
      const key = `${prefix}${exact[0]}`;
      const access = semantics.get(key);
      return access ? { key, access } : undefined;
    }
    // 脚本名比 command 长：只认"command + 连字符 + 描述后缀"这一种，且必须唯一。
    const extended = commands.filter((cmd) => parts.file.startsWith(`${cmd}-`));
    if (extended.length === 1) {
      const key = `${prefix}${extended[0]}`;
      const access = semantics.get(key);
      return access ? { key, access } : undefined;
    }
    return undefined;
  }
  const bare = operationReferenceKey(reference);
  const access = semantics.get(bare);
  return access ? { key: bare, access } : undefined;
}

/**
 * 这次平台调用在计划门前的**分级**——判据只有一份：平台 access 语义表的两列
 * （`options.operationSemantics`，`operation list --json` 的 access 列 × 顶层
 * accessSemantics 表；宿主不认 access 词表、不另立 operation 名单，L2）：
 *
 *   · `scratch` —— `plan` 列 false：平台声明纯本地计算（不触平台会话、不耗令牌、
 *     不写平台数据）。**免计划前置**，口径与旧的 planExempt 一字不差（同一列、同一个
 *     解析函数），既有的 local / 元数据豁免一行未动。
 *   · `read`    —— `plan` 列 true 且 `confirm` 列 false：只读平台数据。**要有激活计划，
 *     但不强求覆盖**——计划里写查 alpha，worker 看了结果想查 beta，这是正当探索，
 *     拦死它等于让计划门反过来制造空转。
 *   · `write`   —— `confirm` 列 true：**是不是写的唯一判据**（operation-labels.ts 的
 *     AccessSemantics 注释：confirm = 要不要用户确认）。必须被**激活计划的某一步覆盖**
 *     才放行：operation 名匹配，且该步声明的关键参数（collection / window / 编号…）
 *     与这次调用一致。
 *   · `unknown` —— 语义表缺失 / 空表 / 该 operation 不在表里：判据不成立 → 按 2026-10-09
 *     起的既有防线只要求激活计划（未知 op 可能写平台数据，宁拦勿猜）。
 *
 * 为什么写要覆盖而读不要：计划门的三样价值里，"范围摘要给人签字"与"写操作确认门"只对
 * 写成立。旧判据 `activePlan !== null` 只查存在性，于是"计划里全是读、写照样调通"——
 * 数据落地而用户从未确认（本次修的根因）。读不锁死是因为探索性查询本就该有出口，
 * 而读不落数据、不需要人认账。
 *
 * scratch 那一级为什么免前置（原 planExempt 的判据，一字未改）：宿主不再单方面要求
 * "一切平台调用必须有激活计划"——对平台自己声明 `plan:false` 的 operation（纯本地计算：
 * 不触平台会话、不耗令牌、不写平台数据），计划门的三样价值全部不成立，而平台侧本来就不
 * 要求（`planEligible` 为假、`reserveInvocation` 根本不调）。宿主此前给
 * `bin/<gateway> local <脚本>` 免了计划，却给同样是纯本地计算的 `bin/<gateway> query
 * <平台脚本>` 不免——判据看的是调用性质，不是调用形态。fail-closed 方向不变：语义表
 * 缺失 / 空表 / operation 不在表里 → 不免，照旧拒 `SERVE_PLAN_NOT_ACTIVE`。
 */
export type PlanGateTier = 'scratch' | 'read' | 'write' | 'unknown';

/**
 * 语义表条目 → 计划门档位（**bash 与 structured_call 共用的唯一分级**）。
 *
 * 2026-11-09 九审 blocking：旧写法先看 `plan === false` 判 scratch，于是
 * `{plan:false, confirm:true}` 被归成免计划——而 confirm 列正是"这个操作要用户确认"。
 * 该组合可由现有解析器产出（operation-labels.test.ts 的 partial 用例明确解析成这个值：
 * plan 缺省 ⇒ false、confirm:true 保留），即"不需要计划但要确认"的矛盾声明。
 * **confirm:true 优先**：要用户确认的操作一律按写类办（必须有激活计划且被某一步覆盖）。
 * 放行的方向是"多拦一次"，不是"少拦一次"——免计划档是整个门里最松的那一档。
 *
 * 2026-11-10 导出：读类探测帽按同一个档位判"是不是读类"（isDeclaredReadOperation），
 * 不再在驱动侧另写一份 `plan && !confirm`——档位只有一个来源，计划门改判据时探测帽同步。
 */
export function tierOfEntry(entry: { key: string; access: AccessSemantics } | undefined): { tier: PlanGateTier; key?: string } {
  if (!entry) return { tier: 'unknown' };
  if (entry.access.confirm === true) return { tier: 'write', key: entry.key };
  if (entry.access.plan === false) return { tier: 'scratch', key: entry.key };
  return { tier: 'read', key: entry.key };
}

function planGateTier(command: string, semantics: OperationSemantics | undefined, serveModes?: readonly string[]): { tier: PlanGateTier; key?: string } {
  return tierOfEntry(planSemanticsEntryOf(command, semantics, serveModes));
}

/**
 * 引用里的域名：注册名 `<域>.<名>`，或平台脚本路径 `src/<域>/scripts/<名>`；
 * 两种都取不到 → undefined（裸脚本名 / 裸 command 名不带域）。
 *
 * 为什么需要它：归一键（operationReferenceKey）会把 `dummy.query` 与 `ballot.query`
 * 归成同一个 `query`，而它们在不同域里是不同的 operation。跨域猜中就是把别的域的写
 * 判成"计划里那一步"——那是放松方向，绝不允许（与 planSemanticsEntryOf 的域内判据同向）。
 */
function operationDomain(reference: string): string | undefined {
  const parts = scriptPathParts(reference);
  if (parts) return parts.domain;
  const bare = reference.replace(/\.(?:js|py)$/i, '');
  const dot = bare.indexOf('.');
  return dot > 0 ? bare.slice(0, dot) : undefined;
}

/** 计划步骤的 operation 与命令引用是否指向同一个 operation（域名都对得上才认）。 */
function sameOperation(planOperation: string, reference: string): boolean {
  if (planOperation === reference) return true;
  const wantedKey = operationReferenceKey(planOperation);
  const gotKey = operationReferenceKey(reference);
  const wanted = operationDomain(planOperation);
  const got = operationDomain(reference);
  if (wantedKey === gotKey) return !wanted || !got || wanted === got;
  // 域前缀文件名形态：`probe.query` ↔ `probe-query.js`（脚本名 = 域-命令）。裸引用拿不到
  // 域（`operationDomain` 只认 `域.命令` 与 `src/<域>/scripts/...`），所以用计划步骤的域
  // 还原出文件基名再比；反方向同理。域名必须对得上，不是无域前缀的宽松匹配。
  if (wanted && gotKey === `${wanted}-${wantedKey}`) return !got || got === wanted;
  if (got && wantedKey === `${got}-${gotKey}`) return !wanted || wanted === got;
  // 描述后缀文件名形态：`dummy.query` ↔ `query-detail.js`（脚本名比 command 多一段描述
  // 后缀，平台语义表 planSemanticsEntryForReference 的 extended 匹配同一条口径）。域名
  // 拿得到时必须一致；裸引用没有域可比，仍按同域命令名唯一匹配的既有语义处理。
  if (wanted && gotKey.startsWith(`${wantedKey}-`)) return !got || got === wanted;
  if (got && wantedKey.startsWith(`${gotKey}-`)) return !wanted || wanted === got;
  return false;
}

/**
 * token 串 → flag 取值表（`--flag 值` / `--flag=值` / 布尔开关 `--flag` 三种写法都认）。
 *
 * 位置参数**不入表**：它们多是 payload 路径与名称，而"这次写落在哪个对象上"由关键 flag
 * 回答（collection / window / 编号）；payload 本体对宿主是不透明的（提案读回归执行层），
 * 逐字比路径只会造出假拒——同一份 payload 换个工作区名就"不在计划里"了。
 */
/**
 * token 串 → flag 取值表（`--flag 值` / `--flag=值` / 布尔开关 `--flag` 三种写法都认）。
 *
 * 布尔开关的判定同样依据执行层 flagStyles（2026-11-09 十八审 major）：**不读规格时**
 * 无法区分 `--dry-run alpha` 里的 alpha 是开关的取值还是紧跟的位置参数——旧写法把它当
 * 取值，于是计划侧得到 `dry-run='alpha'`、结构化侧得到 `dry-run=''`，两侧不一致，
 * 合法的写调用被拒。给了规格就按规格判（布尔 none 不入表），拿不到时保守地当作**带值**
 * （与 positionalsOf 同一立场：宁可少放行，也不制造两侧分叉）。
 *
 * 位置参数**不入表**：它们多是 payload 路径与名称，而"这次写落在哪个对象上"由关键 flag
 * 回答（collection / window / 编号）；payload 本体对宿主是不透明的（提案读回归执行层），
 * 逐字比路径只会造出假拒——同一份 payload 换个工作区名就"不在计划里"了。
 */
function keyArgsOf(tokens: readonly string[], flagStyles?: ReadonlyMap<string, KeyArgStyle>): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      args.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    // 布尔开关（规格明确说不带值）⇒ 不吞下一项，占位为 ''（两侧同为开关才匹配）
    if (flagStyles && !flagStyles.has(token)) {
      args.set(token, '');
      continue;
    }
    const value = tokens[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      args.set(token, value);
      index += 1;
    } else {
      args.set(token, '');   // 布尔开关：无取值，占位为''（两侧同为开关才匹配）
    }
  }
  return args;
}

/**
 * token 串 → 位置参数表（flag 及其取值都不算）。
 *
 * 2026-11-09 五审 blocking：覆盖判据原先只看 flag，位置参数整批丢弃——于是一份
 * `args: ['alpha','W1']` 的计划步与一次 `args: ['beta','W2']` 的调用，只要 operation 同名
 * 就判"已覆盖"。对以位置参数声明目标的执行层，写授权范围检查等于不存在。
 * 现在位置参数也进判据；哪些位置参数是"目标"由执行层的 args 声明（positionalNames）说，
 * 宿主不猜。声明缺失而计划步又带了位置参数 ⇒ 无法证明范围一致 ⇒ 不覆盖（fail-closed，
 * 不把"没解析出 flag"当成"授权任意目标"）。
 */
/**
 * 该 operation 声明了哪些位置参数（执行层 args 声明的 positionalNames）。
 *
 * 拿不到（表未加载 / 平台没下发 / operation 不在表里）返回 undefined——调用方据此走
 * fail-closed：计划步带了位置参数而这里说不出哪些是目标，就不判定覆盖。
 */
function positionalNamesFor(reference: string | null, specs: OperationArgsSpecs | undefined): readonly string[] | undefined {
  if (!reference || !specs || specs.size === 0) return undefined;
  const direct = specs.get(reference);
  if (direct) return direct.positionalNames;
  const parts = scriptPathParts(reference);
  if (!parts) return undefined;
  const prefix = `${parts.domain}.`;
  for (const [name, spec] of specs) {
    if (name.startsWith(prefix) && name.slice(prefix.length) === parts.file) return spec.positionalNames;
  }
  return undefined;
}

/**
 * token 串 → 位置参数表。
 *
 * 三处判据都与 Bash 实际所见一致：
 *   ① 只有**真的是 flag**（以 -- 开头）才可能连取值一起跳过；空串是空的位置参数，
 *      是合法的通用接口形态（前置位留空 + 后续位带目标）——旧写法把它当 flag 会把后面
 *      的目标一起吞掉（十二审 blocking）；
 *   ② **布尔开关不吞下一项**（十七审 major）：`--dry-run --target alpha` 里的
 *      --dry-run 是开关、--target 才是带值 flag，旧写法无条件跳下一项会把 --target
 *      当成 --dry-run 的取值，于是 alpha 被误提成位置参数；
 *   ③ 开关/带值由执行层的 flagStyles 判定（只收 name/code 两种有取值的，布尔 none 不
 *      入表）——拿不到规格时不猜：保守地当作**带值**（宁可少提位置参数，也不把开关后面
 *      的 flag 吞掉）。
 */
/**
 * 该 operation 声明了哪些 flag 是**带值**的（布尔开关不在表里）。拿不到返回 undefined，
 * 调用方按"保守当作带值"处理——宁可少提位置参数，也不把开关后面的 flag 吞掉。
 */
function flagStylesFor(reference: string | null, specs: OperationArgsSpecs | undefined): ReadonlyMap<string, KeyArgStyle> | undefined {
  if (!reference || !specs || specs.size === 0) return undefined;
  const direct = specs.get(reference);
  if (direct) return direct.flagStyles;
  const parts = scriptPathParts(reference);
  if (!parts) return undefined;
  const prefix = `${parts.domain}.`;
  for (const [name, spec] of specs) {
    if (name.startsWith(prefix) && name.slice(prefix.length) === parts.file) return spec.flagStyles;
  }
  return undefined;
}

function positionalsOf(tokens: readonly string[], flagStyles?: ReadonlyMap<string, KeyArgStyle>): string[] {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token.startsWith('--')) {
      if (token.includes('=')) continue;                // --flag=值：单个 token
      if (flagStyles && !flagStyles.has(token)) continue;   // 布尔开关：不吞下一项
      index += 1;                                        // 带值 flag：跳过取值
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * 激活计划的某一步是否覆盖这次网关调用（写类的前置判据）。
 *
 * 两条判据，都是机械的：
 *   ① operation 名匹配（sameOperation：注册名 / 裸名 / 脚本路径三种引用同源）；
 *   ② 关键参数一致——**该步声明过的每个 flag，这次调用必须同值**（计划 ⊆ 调用）。
 *
 * 为什么是"计划 ⊆ 调用"而不是全等：计划写 `--collection alpha`、worker 补上
 * `--window W1` 再调，是同一件事的更精确写法，全等会把这种正当调用误判成不覆盖。
 * 反方向不放松：计划声明了 `--window W1` 而这次调用没带，目标就不一定是那一个——
 * 拒，让 worker 改对或重提计划。
 */
function coversPlanStep(
  step: PlanCall,
  reference: string,
  gotKeyArgs: ReadonlyMap<string, string>,
  gotPositionals: ReadonlyArray<string | undefined>,
  positionalNames: readonly string[] | undefined,
  flagStyles?: ReadonlyMap<string, KeyArgStyle>,
): boolean {
  if (!sameOperation(step.operation, reference)) return false;
  const stepTokens = step.args.map((value) => (typeof value === 'string' ? value : String(value)));
  const wanted = keyArgsOf(stepTokens, flagStyles);
  for (const [flag, value] of wanted) {
    if (gotKeyArgs.get(flag) !== value) return false;
  }
  // 位置参数：执行层声明了才有判据（declared positional names）；声明缺失而计划步又带了
  // 位置参数 ⇒ 无法证明范围一致 ⇒ 不覆盖。空声明 + 空位置参数 = 该步只按 operation 约束。
  // 计划步与调用侧用**同一套** flagStyles 提位置参数（十七审 major）：只有一侧区分布尔
  // 开关，计划写 `--dry-run --target alpha` 而结构化调用只给这两个 flag 时，两侧提出的
  // 位置参数不一致，合法调用会被判未覆盖。
  const wantedPositionals = positionalsOf(stepTokens, flagStyles);
  if (wantedPositionals.length === 0) return true;
  if (positionalNames === undefined || positionalNames.length === 0) return false;
  for (let index = 0; index < wantedPositionals.length; index += 1) {
    // 缺失（undefined）与不同值都判不覆盖：范围说不清就不放行。
    if (gotPositionals[index] === undefined || gotPositionals[index] !== wantedPositionals[index]) return false;
  }
  return true;
}

/**
 * 计划前置的三级判据（本门对非 local 网关调用的唯一裁决入口）。
 *
 * 顺序固定：先分级，再问"有没有激活计划"，最后才对写类问"覆不覆盖"——读类与未登记形态
 * 到第二步就返回，不会被第三步误伤。
 *
 * 档位随裁决一起交回调用方（而不是在事件里按 detail 反解析一遍）：门只解析一次，事件
 * 携带的就是裁决用的那一份——控制计数与门裁决不可能看到两个不同的 operation。
 */
function planGateVerdict(
  command: string,
  ctx: {
    planActive?: () => boolean;
    operationSemantics?: OperationSemantics;
    /** 激活计划的 calls（宿主注入）。undefined = 调用方没接这一路 → 写类一律拒（fail-closed）。 */
    activePlanCalls?: () => readonly PlanCall[] | null;
    /** operation → args 规格（位置参数声明，覆盖判据用）。 */
    operationArgsSpecs?: OperationArgsSpecs;
    /** 执行模式词汇（平台 serve 矩阵；缺省 = 退回契约兜底，见 SERVE_MODES_FALLBACK）。 */
    serveModes?: readonly string[];
  },
): { verdict: ServeGateVerdict | undefined; tier: PlanGateTier } {
  const { tier, key } = planGateTier(command, ctx.operationSemantics, ctx.serveModes);
  const reference = extractGateScript(command, ctx.serveModes);
  const tokens = splitCommandTokens(command);
  // 命令里的位置参数要去掉"网关词 + 子命令 + operation 引用"这三段，剩下的才是目标参数
  // （`bin/<gw> prepare dummy.proposal tmp/task_x/payload.json` → ['tmp/task_x/payload.json']）。
  const headLength = reference === null ? 0 : tokens.indexOf(reference) + 1;
  const specs = ctx.operationArgsSpecs;
  const flagStyles = flagStylesFor(reference, specs);
  const verdict = planCoverageVerdict(tier, key, reference, keyArgsOf(tokens, flagStyles), positionalsOf(tokens.slice(headLength), flagStyles), positionalNamesFor(reference, specs), ctx);
  return { verdict, tier };
}

/**
 * 计划覆盖判据的**唯一实现**（bash 与 structured_call 两条路都走它）。
 *
 * 为什么提成这一个函数：2026-11-09 四审 blocking——`structured_call` 分支原先只查
 * `requiresPlan` 的存在性，于是一份纯读计划激活后，清单里已登记的写 operation 仍能经
 * structured_call 进网关，完全绕过 bash 侧新加的覆盖检查。把判据收成一处，两条路不可能
 * 再漂移；在任一路旁另写一份，就等于给"计划里全是读、写照样调通"留后门。
 *
 * tier / key 由调用方按自己的取 reference 方式算好（bash 解命令串，结构化直接用注册名），
 * gotKeyArgs 是关键参数表（口径同 keyArgsOf：只比 flag，位置参数不入表）。
 */
function planCoverageVerdict(
  tier: PlanGateTier,
  key: string | undefined,
  reference: string | null,
  gotKeyArgs: ReadonlyMap<string, string>,
  gotPositionals: ReadonlyArray<string | undefined>,
  positionalNames: readonly string[] | undefined,
  ctx: {
    planActive?: () => boolean;
    operationSemantics?: OperationSemantics;
    /** 激活计划的 calls（宿主注入）。undefined = 调用方没接这一路 → 写类一律拒（fail-closed）。 */
    activePlanCalls?: () => readonly PlanCall[] | null;
    /** operation → args 规格（位置参数声明）。缺省 = 无法证明位置范围，计划步带位置参数即不覆盖。 */
    operationArgsSpecs?: OperationArgsSpecs;
  },
): ServeGateVerdict | undefined {
  // scratch：平台自己声明不要计划（纯本地计算），免前置——与旧的 planExempt 同一列同一判据
  if (tier === 'scratch') return undefined;
  if (!ctx.planActive?.()) return { block: true, reason: messageTextFor('SERVE_PLAN_NOT_ACTIVE') };
  // 读与未登记形态：只要有激活计划（探索性查询不锁死；未知 op 按既有防线只要求有计划）
  if (tier !== 'write') return undefined;
  const steps = ctx.activePlanCalls?.();
  if (reference && steps?.some((step) => coversPlanStep(step, reference, gotKeyArgs, gotPositionals, positionalNames, ctx.operationArgsSpecs ? flagStylesFor(reference, ctx.operationArgsSpecs) : undefined))) return undefined;
  // 措辞收口在 error-codes.ts（SERVE_PLAN_NOT_ACTIVE 一字不差地复用），这里只追加**数据**：
  // 被拒的是哪个 operation——没有它，worker 不知道该把哪个调用补进计划，只能整份重提。
  // 点名用语义表里的注册名（`voucher.fill`），不拿命令里的脚本路径顶替（消息纪律：脚本名/
  // 路径不进消息）。不新开错误码：本次补的是"覆盖"这一维，不是新的失败模式族（驱动层的
  // 计划分支同样用「表内消息 + 追加数据」的写法，如 `PLAN ACTIVE（id vN）：…`）。
  return {
    block: true,
    reason: `${messageTextFor('SERVE_PLAN_NOT_ACTIVE')}未被已激活计划覆盖的 operation：${key ?? reference ?? '(未解析)'}。`,
  };
}

/**
 * 一次网关调用相对**已声明计划**的分类（T5 执行前对账，2026-11-11）。
 *
 * 与计划覆盖判据**同一份实现**（coversPlanStep）——只回答分类，不做裁决：
 *   · `not_plan_gated`——不是网关调用形态（本地/元数据/非网关命令）：别的门管，这里不看；
 *   · `covered`——被某条已声明计划步覆盖（operation 同名 + 计划步声明过的参数同值）；
 *   · `expansion`——对不上任何一步（计划没声明的对象/operation）：驱动层**第一跳即拒**。
 *
 * 为什么裁决在驱动层而不是门里：read 档的档位线是既有断言钉住的产品行为
 * （serve-gate.test.ts「② 激活计划只有读 → 另一个读（不同 collection）放行：探索性查询
 * 不锁死」；实现即下方 planCoverageVerdict 的 `tier !== 'write'` 早退）。计划门本身
 * 一字不动；驱动层在门放行之后加一道与声明逐条对账的硬门，只拒"对不上声明"的调用。
 */
export function planDeclarationCovers(
  command: string,
  calls: readonly PlanCall[],
  options: { operationArgsSpecs?: OperationArgsSpecs; serveModes?: readonly string[] } = {},
): 'covered' | 'expansion' | 'not_plan_gated' {
  // 与门同一份 mode 词汇（serveModes）：平台声明新 mode 时，门与对账同时看得见；
  // 缺省退回契约兜底词汇（仍由调用方决定注入平台 serve 矩阵）。
  const reference = extractGateScript(command, options.serveModes);
  if (reference === null) return 'not_plan_gated';
  const specs = options.operationArgsSpecs;
  const tokens = splitCommandTokens(command);
  const headLength = tokens.indexOf(reference) + 1;
  const flagStyles = flagStylesFor(reference, specs);
  const gotKeyArgs = keyArgsOf(tokens, flagStyles);
  const gotPositionals = positionalsOf(tokens.slice(headLength), flagStyles);
  const positionalNames = positionalNamesFor(reference, specs);
  const covered = calls.some((step) => {
    if (coversPlanStep(step, reference, gotKeyArgs, gotPositionals, positionalNames, flagStyles)) return true;
    // args 规格没下发时 `coversPlanStep` 对"计划步带位置参数"一律判不覆盖（写类 fail-closed
    // 的正确方向）。T5 的对账不能因此把**逐项同值**的读调用全判成扩张（测试与旧版平台
    // 都可能没有规格）：仅在规格缺失时，按原 token 逐项比较计划步与调用的位置参数；
    // 一旦拿到规格，仍走 `coversPlanStep` 的同一判据，不另开放松路径。
    if (positionalNames !== undefined) return false;
    if (!sameOperation(step.operation, reference)) return false;
    const stepTokens = step.args.map((value) => (typeof value === 'string' ? value : String(value)));
    const wantedFlags = keyArgsOf(stepTokens, flagStyles);
    for (const [flag, value] of wantedFlags) if (gotKeyArgs.get(flag) !== value) return false;
    const wantedPositionals = positionalsOf(stepTokens, flagStyles);
    return wantedPositionals.length > 0
      && wantedPositionals.length === gotPositionals.length
      && wantedPositionals.every((value, index) => gotPositionals[index] === value);
  });
  return covered ? 'covered' : 'expansion';
}

/**
 * 结构化调用（structured_call）的计划前置判据——与 bash 同一份实现。
 *
 * 入参就是结构化调用自己的形状：operation 注册名 + args 对象。args 规范化成 flag 表后
 * 直接进 planCoverageVerdict，不合成命令串再解析（合成串会让两条路的措辞/边界慢慢分叉）。
 * 提案创建仍走宿主既有拦截路由，不经过这里。
 */
/**
 * 结构化 args → 覆盖判据的输入（bash 的 keyArgsOf/positionalsOf 的结构化等价物）。
 * 与计划覆盖判据共用 `coversPlanStep`，本函数只做形状归一，不做裁决。
 */
function structuredCallKeyArgs(
  operation: string,
  args: Record<string, unknown>,
  specs: OperationArgsSpecs | undefined,
): {
  gotKeyArgs: Map<string, string>;
  positionals: Array<string | undefined>;
  positionalNames: readonly string[];
  flagStyles: ReadonlyMap<string, KeyArgStyle> | undefined;
} {
  // args 对象 → flag 表。键名归一成 `--flag`：清单 argsSchema 用的是带横杠形（`--account`），
  // 但也有的部署声明不带横杠，两种都按"剥掉再补一个 --"归一，否则同一件事两种写法会判成
  // 不同参数（那是放松方向的漏洞）。布尔值当无取值开关，其余 String()——与 keyArgsOf 对
  // `--flag 值` / `--flag` 的判定同形；数组/对象不猜（结构化 args 已被清单校验只能是标量）。
  const got = new Map<string, string>();
  const names = positionalNamesFor(operation, specs) ?? [];
  // 位置参数**按声明顺序**逐项取值（2026-11-09 六审 blocking）：旧写法按
  // Object.entries(args) 的插入顺序 push，于是调用方换个 JSON 键序就能让
  // `{period:'alpha', account:'W1'}` 与计划 `['alpha','W1']` 对上——参数名与目标实际已经
  // 互换，覆盖检查却放行。对象键序是调用方的自由，绝不许它决定写授权范围。
  // 缺失的位置留 undefined（与"少给一个位置参数"同形，判据侧按不覆盖处理）。
  const positionals: Array<string | undefined> = names.map((declared) => {
    const hit = Object.keys(args).find((key) => key === declared || key === `--${declared}`);
    if (hit === undefined) return undefined;
    const value = args[hit];
    if (value === undefined || value === null) return undefined;
    return typeof value === 'boolean' ? '' : String(value);
  });
  // 其余键按 flag 处理（清单 argsSchema 常用带横杠形，也有的部署不带，两种都归一——
  // 不归一就是放松方向的漏洞）。布尔值当无取值开关，其余 String()。
  const declaredNames = new Set(names.flatMap((declared) => [declared, `--${declared}`]));
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    // 布尔 **false 整个不入表**（2026-11-09 八审 blocking）：夹具对 `value === false` 的键
    // 直接跳过、连 token 都不产出（dummy.cjs 的 args 扁平化）。旧写法把 true/false 都归一成
    // ''，于是计划声明了裸开关、调用传 false 也能匹配上——而实际执行里那个开关根本不存在，
    // 执行层靠开关约束的副作用（如 --dry-run）被静默移除却通过了覆盖检查。
    // 省略 = 与执行端实际参数一致；计划若要求该开关在场，少一个键自然判不覆盖。
    if (value === false) continue;
    if (declaredNames.has(name)) continue;
    got.set(name.startsWith('--') ? name : `--${name}`, typeof value === 'boolean' ? '' : String(value));
  }
  return {
    gotKeyArgs: got,
    positionals,
    positionalNames: names,
    flagStyles: specs ? flagStylesFor(operation, specs) : undefined,
  };
}

export function structuredPlanGateVerdict(
  operation: string,
  args: Record<string, unknown>,
  ctx: {
    planActive?: () => boolean;
    operationSemantics?: OperationSemantics;
    activePlanCalls?: () => readonly PlanCall[] | null;
    /** operation → args 规格（位置参数声明，覆盖判据用）。 */
    operationArgsSpecs?: OperationArgsSpecs;
  },
): ServeGateVerdict | undefined {
  const entry = planSemanticsEntryForReference(operation, ctx.operationSemantics);
  // 语义表里没有这个 operation（未登记/空表）→ 按既有防线当 unknown：只要求有激活计划。
  const { tier } = tierOfEntry(entry);
  const { gotKeyArgs, positionals, positionalNames } = structuredCallKeyArgs(operation, args, ctx.operationArgsSpecs);
  return planCoverageVerdict(
    tier,
    entry?.key,
    operation,
    gotKeyArgs,
    positionals,
    positionalNames.length > 0 ? positionalNames : undefined,
    ctx,
  );
}

/**
 * 结构化调用相对**已声明计划**的分类（T5 执行前对账，2026-11-11）。
 *
 * 与 bash 的 `planDeclarationCovers` 同一份覆盖实现（`coversPlanStep`），只回答分类：
 *   · `not_plan_gated`——scratch（平台声明 plan=false）：别的门管，这里不看；
 *   · `covered`——被某条已声明计划步覆盖（operation 同名 + 计划步声明过的参数同值）；
 *   · `expansion`——对不上任何一步：驱动层**第一跳即拒**。
 *
 * 为什么结构化通道也要这一道：bash 与 structured_call 是两条执行入口，只堵 bash 等于
 * 给"纯读计划 + structured_call 查另一个对象"留后门（2026-11-09 四审 blocking 同一形状）。
 */
export function planDeclarationCoversStructured(
  operation: string,
  args: Record<string, unknown>,
  calls: readonly PlanCall[],
  options: { operationArgsSpecs?: OperationArgsSpecs; operationSemantics?: OperationSemantics } = {},
): 'covered' | 'expansion' | 'not_plan_gated' {
  const entry = planSemanticsEntryForReference(operation, options.operationSemantics);
  if (tierOfEntry(entry).tier === 'scratch') return 'not_plan_gated';
  const { gotKeyArgs, positionals, positionalNames, flagStyles } = structuredCallKeyArgs(operation, args, options.operationArgsSpecs);
  const covered = calls.some((step) => coversPlanStep(
    step,
    operation,
    gotKeyArgs,
    positionals,
    positionalNames.length > 0 ? positionalNames : undefined,
    flagStyles,
  ));
  return covered ? 'covered' : 'expansion';
}

export function createServeGate(options: ServeGateOptions = {}) {
  const { onEvent, platformRoot } = options;
  const gateway = options.gateway;
  const patterns = servePatterns(gateway);
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
    // 形态族（仅 bash）：放行的与拦截的都随审计事件出来，供执行面把"所有被放行的 bash"
    // 拆成本地执行 / 平台执行 / 元数据三族——绕开平台执行器要可观测，缺它就只有总数。
    let invocation: GateInvocationKind | null = null;
    // 计划门解析出的档位（仅走到计划门裁决的网关调用）：随事件出去给控制面计数，
    // 与给审计展示的截断 detail 分开（见 ServeGateEvent.operationTier）。
    let operationTier: PlanGateTier | undefined;
    // 放行的平台调用才有人类可读投影：label 与参数摘要都来自平台数据（清单第 5 列 /
    // args 规格），查不到 label 就不挂——调用方没有帧可发，静默降级。
    let progress: { label: string; keyArgs: string[] } | undefined;

    if (name === 'bash') {
      // 预 trim 同样只剥 Bash 词法空白（十六审 blocking）：用 String.trim() 会把尾部的
      // Unicode 空白/回车删掉，之后所有判据都比 Bash 少看见一些字符。
      const command = trimShellWhitespace(String(args['command'] ?? ''));
      detail = command;
      invocation = gateInvocationKind(command, gateway, options.serveModes);
      // 元数据查询先行（且必须排在 plan 教学分支之前）：
      // `plan --schema` 字面上含 `plan`，会被那条正则判成"worker 在提交方案"而吃到
      // PLAN_SHAPE_GATE_TEACHING——可它恰恰是平台给宿主的机器可读出口，不是方案提交。
      // 元数据分支不判 planActive（理由见 SERVE_METADATA_COMMANDS 注释），但仍校验
      // shell 元字符，且照常落 onEvent 审计——"宿主放行了什么"必须可复盘。
      const metadata = serveMetadataCommand(command, gateway);
      const isGateway = isServeCliInvocation(command, gateway);
      if (metadata) {
        // 元数据查询放行（detail 已记命令原文，审计由此留痕）。
      } else if (isLocalScratchRun(command, options.scratchDir, platformRoot, gateway)) {
        // 本地执行：不需要计划（纯本地计算，见 isLocalScratchRun 注释）。留痕照旧
        // （detail = 命令原文）。
      } else if (patterns.plan.test(command)) {
        // 教学而非 merely 拒绝：真实平台实测里旧消息（"只能提交 JSON calls 方案"）
        // 没说怎么提交，worker 被拒后理解成"把 JSON 打印出来"，步步空转。因此这里直接
        // 给出唯一合法形式——bash 工具里的单行原始命令，并点名三种常见错误包装。
        // 措辞收口在 error-codes.ts（PLAN_SHAPE_GATE_TEACHING）：领域无关（业务词预算见
        // platform-leak-lint），也不出现平台脚本文件名。
        verdict = {
          block: true,
          reason: messageTextFor('PLAN_SHAPE_GATE_TEACHING', undefined, gateway),
        };
      } else if (isGateway && !isLocalMode(command, gateway)) {
        // 计划前置（宿主保留的执法）：非 local 的网关调用 fail-closed——已登记 operation
        // 按语义表分级（scratch plan=false 直调、read 要激活计划、write 要被激活计划的
        // 某一步覆盖）；**形态解析不出的网关调用直接拒**（2026-11-12，宁拦勿猜）：
        // 门答不出"这是哪个 operation"就答不出该不该计划、挂哪条 label，驱动层 T5 对账
        // 同样不成立（extractGateScript 取不到引用 = not_plan_gated）——放行等于没有任何
        // 一步证明它不在执行面内。B3 实证：`call --file <json>` 经夹具真的执行了未声明
        // 对象的查询，宿主只留了一行 status=ok、无 reason 的审计。
        //
        // 这是 6025764（授信期）退役四支中的"未登记形态"一支的收回：AGENTS.md 现行政策
        // 写的是"未登记形态放行仅审计"，与本分支的 fail-closed 相反——本轮按注释与
        // AGENTS.md 的 fail-closed 那条走，矛盾已上报用户裁定（见回报），不在此处自行改政策。
        if (invocation === null) {
          verdict = { block: true, reason: messageTextFor('SERVE_INVOCATION_FORM_UNKNOWN') };
        } else {
          const decision = planGateVerdict(command, options);
          verdict = decision.verdict;
          operationTier = decision.tier;
          if (!verdict) {
            const label = operationLabel(options.operationLabels, extractGateScript(command, options.serveModes));
            if (label) progress = { label, keyArgs: describeArgs(command) };
          }
        }
      } else if (!isGateway && gatewayCommandPosition(command, gateway) !== null) {
        // 命令链里夹带网关调用（`cd X && bin/<gw> …`、`X; bin/<gw> …`）：首词不是网关，
        // 整条链没有形态分类、没有计划前置、T5 对账也取不到引用（extractGateScript 只看
        // 第二 token）——放行等于没有任何一步证明它不在执行面内（B3 第二条被测线，同一
        // 次跑里经夹具执行了越范围查询）。fail-closed，理由指向"平台调用必须单独成一条命令"。
        verdict = { block: true, reason: messageTextFor('SERVE_BASH_CHAINED_GATEWAY') };
      } else {
        // local（区内直调；区外由执行层网关自校验根）与非网关命令 → 放行，审计照记
      }
      // 元字符软放行（2026-10-18）：硬拦曾把附件名里的 ASCII 括号当注入拦死（(1) 是
      // 常见文件名后缀），worker 的合法路径参数两度被拒。安全机制随沙箱阶段重建；
      // 此刻放行 + 审计 detail 带软标记，可复盘可计量。
      if (!verdict && hasShellMetachars(command)) {
        detail = `${detail}（含元字符，软放行）`;
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
        ...(invocation ? { invocation } : {}),
        // 控制面档位：不截断、不进审计展示（detail 仍是上面那条 200 字上限的字符串）。
        ...(operationTier ? { operationTier } : {}),
      });
    } catch {}
    return verdict;
  };
}
