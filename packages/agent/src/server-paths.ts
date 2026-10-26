/**
 * 服务器路径不外发（2026-10-19 真机实测）。
 *
 * 事故形状：模型把 `tmp/task_d42fffce-…/` 与 `/home/fictional-user/fictional-projects/fictional-execution-layer/tmp/
 * attachments/…xlsx` 直接写进终稿。用户在企微里，服务器路径对他没有任何可行动性——
 * **拿到路径等于什么都没拿到**，而这正是那次"文件发了但又没发"的直接观感。
 *
 * 为什么这道尺必须住在宿主：执行层 skill 早有"用户可见回复不写服务器路径"的约定
 * （D-106 配套改动），但那条只约束 worker 自己的回复。这次同族泄漏出自**编排模型**——
 * 它读转录里的历史结论，把上一轮的路径一起排版了出来。宿主这道尺才盖得住两种来源。
 *
 * 判据只有**形状**，不嗅探内容（与执行语言指纹同一族方法论）：
 *   · 绝对路径：`/` + POSIX 顶层路径名（home/root/tmp/var/opt/srv/usr/etc/mnt/media/Users）；
 *   · 工作区相对路径：`tmp/` 开头——`tmp/task_<uuid>` 是**宿主自己的**暂存命名
 *     （`sweepScratchDirs` 只扫这一种，见 apps/server/main.ts），不是执行层的业务字段。
 * 两条都锚在宿主持有的名字上，所以不用把任何执行层的存放约定搬进通用 runtime。
 * 误伤面：正常中文回复里出现 `/home`、`/tmp`、`tmp/` 这类字面的概率为零——宁可漏报
 * （漏了的路径仍在原地，用户至少看到内容），不可误删用户结论里的字符。
 *
 * 为什么是**删路径**而不是整段拦掉：终稿里的金额与结论来自 7 小时前那次真跑，
 * 整段替换会把有用内容一起扔掉（与 `conversation_unsourced_amounts` 同族判断——
 * 那道尺也只留痕不拦截）。该丢的只是用户没法用的那一截。
 */
/**
 * 路径 token 的字符类：路径分隔符、点、连字符、数字字母、反引号，以及纯 ASCII 文件名里
 * 会用到的圆括号。**不含全角括号**——`（均在 tmp/…）` 这种写法里，全角右括号是句读不是
 * 文件名的一部分，吃进去会把后面那句的括号啃掉，留下 `（：` 这种残壳。中日韩文件名在
 * 字符类边界处自然收住（见下方"文件名保留"的测试）。
 */
const PATH_CHARS = `${String.raw`A-Za-z0-9._\-/()`}\``;

/**
 * 路径 token 的形状（全局）。绝对路径支要求 `/` + POSIX 顶层路径名，因此 `https://…` 的
 * `//` 不会命中（首段不是顶层路径名）；相对支锚在宿主自己的 `tmp/` 暂存命名上。开头的
 * 反引号可选——模型爱把路径写成行内代码，leading backtick 一起吃进去才不会剩一半。
 */
export const SERVER_PATH_PATTERN = new RegExp(
  // `\x60` 是反引号：不能写成 `\``——String.raw 会连反斜杠一起保留，`\`` 在正则里是非法转义。
  String.raw`\x60?(?:/(?:home|root|tmp|var|opt|srv|usr|etc|mnt|media|Users)\b[${PATH_CHARS}]*|\btmp/[${PATH_CHARS}]*)`,
  'gu',
);

/**
 * 删掉路径后剩下的空括号对。字符类放宽到连接词（均/在/于/位）——`（均在 ）` 这种形状
 * 里括号包的就只剩连接词，信息全在路径上，整对消失；`（1）`、`（A）` 不在类里，照旧保留。
 */
const EMPTY_PAREN_PATTERN = /[（(][\s均在位于]*[）)]/gu;

/**
 * 只判"有没有"的探针：与 SERVER_PATH_PATTERN 同一形状（同源派生，不可能分叉），
 * 去掉 `g` 免得 `.test()` 带着 lastIndex 状态——同一个正则对象反复 test 会漏判。
 *
 * 为什么需要探针而不是复用 SERVER_PATH_PATTERN：有些出口不该"删"，该"整条作废"
 * （进度帧带上路径 → 这一帧不发）。删是把文本改干净，探针是让调用方自己决定
 * 丢整条还是丢一段。两个出口共用一把尺，见 server-paths.test.ts 的一致性用例。
 */
const SERVER_PATH_PROBE = new RegExp(SERVER_PATH_PATTERN.source, 'u');

/** 文本里是否带服务器路径（不修改文本）。纯函数，无状态，可反复调用。 */
export function hasServerPath(text: string): boolean {
  return SERVER_PATH_PROBE.test(text);
}

export interface ServerPathStripResult {
  /** 处理后的文本。 */
  text: string;
  /** 删掉的路径 token 数（0 = 没命中，原文原样返回）。 */
  removed: number;
}

/**
 * 从用户可见文本里删掉服务器路径。纯函数：不抛异常、不打日志、不碰存储。
 *
 * 命中为零时原文原样返回（同一引用），调用方可以靠 `removed === 0` 跳过后续整理与
 * 事件打点——绝大多数回复走这条快路。
 */
export function stripServerPaths(text: string): ServerPathStripResult {
  let removed = 0;
  const stripped = text.replace(SERVER_PATH_PATTERN, () => {
    removed += 1;
    return '';
  });
  if (removed === 0) return { text, removed: 0 };
  const tidied = stripped
    .replace(EMPTY_PAREN_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n');
  return { text: tidied, removed };
}

/**
 * 任务工作区路径的形状（全局）：`tmp/task_<uuid>`，前缀可选（`/` 或
 * `/home/fictional-user/fictional-projects/fictional-execution-layer/` 这类绝对前缀都要拦——2026-10-20 事故里
 * 模型把路径写错过三种形态：相对、`/tmp/` 绝对、完整绝对）。后缀沿用 PATH_CHARS，
 * 中日韩文件名在字符类边界处自然收住（剥掉路径前缀即断绝可用性，残留的文件名
 * 片段不成路径）。
 */
const SCRATCH_PATH_PATTERN = new RegExp(
  String.raw`(?:[\w.~-]*\/)*tmp/task_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[${PATH_CHARS}]*`,
  'gu',
);

/**
 * 剥掉委派范围里指向**别的**任务工作区的路径（W4，2026-10-20 事故的直接修法）。
 *
 * 事故形状：用户说"把上轮那个表再发一次"，模型凭记忆把路径写进委派范围——位置错
 * （`/tmp` 而非平台 tmp/）、UUID 错（编造的变体，真实 id 在历史里明明白白出现过
 * 两次）。worker 拿着假路径 ls 失败后把 tmp/ 下逐个任务工作区翻了一遍，交还文本
 * "委派中给出的原文件路径已不存在……"原样上了用户的屏。重发路由（resend 申报枝）
 * 消灭了这个需求的大半，
 * 但非重发的续跑请求仍可能引用旧工作区路径——这里做外科手术式剥离。
 *
 * 放过两类：**本任务自己的工作区**（`scratchDir` 形如 `tmp/task_<uuid>`，含其下
 * 文件——worker 写得动的位置）与 **附件输入路径**（`tmp/attachments/`，worker 的
 * 合法读取对象，本模式根本不匹配它）。剥掉的路径对 worker 本就不可能有用（不是
 * 它写得动的位置），留着只会诱发 hunt。
 *
 * 判据全在宿主持有的名字上（task id 形态、本任务 scratchDir），零业务知识。
 */
export function stripForeignScratchPaths(text: string, scratchDir: string): { text: string; stripped: number } {
  const ownTaskId = scratchDir.replace(/^\.?\//u, '').split('/')[1] ?? '';
  let stripped = 0;
  const out = text.replace(SCRATCH_PATH_PATTERN, (match) => {
    if (ownTaskId !== '' && match.includes(ownTaskId)) return match;   // 本任务自己的工作区（含其下文件）
    stripped += 1;
    return '（非本任务工作区路径，已由宿主剥离）';
  });
  return { text: out, stripped };
}
