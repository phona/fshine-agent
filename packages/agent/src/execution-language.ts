import { HOST_ERROR_CODE_NAMES } from './error-codes';
import { PLATFORM_OPERATIONS } from './platform-contract';

const OPERATION_NAME_WHITELIST: ReadonlySet<string> = new Set<string>();
const REGISTERED_OPERATION_ALTERNATION = Object.values(PLATFORM_OPERATIONS)
  .flatMap((name) => [...new Set([name, name.slice(name.indexOf('.') + 1)])])
  .map((token) => String.raw`\b${token.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\b`)
  .join('|');

/** Generic fingerprints for internal execution language that must not appear in user replies. */
export const EXECUTION_LANGUAGE_FINGERPRINTS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  whitelist?: ReadonlySet<string>;
}> = [
  { label: '脚本路径', pattern: /src\/[^\s）)，,，；;]*\.js/ },
  { label: '错误码', pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/ },
  { label: 'JSON 片段', pattern: /candidates\s*:|[{}]/ },
  {
    label: 'operation 名',
    pattern: new RegExp([
      String.raw`\b(?=(?:[a-z0-9-]*\.)+[a-z0-9-]*-)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\b`,
      REGISTERED_OPERATION_ALTERNATION,
    ].join('|')),
    whitelist: OPERATION_NAME_WHITELIST,
  },
  { label: '内部控制词', pattern: /额度|配额|熔断|计划门|拒绝上限|重试上限/ },
];

/** Return labels for internal execution-language shapes found in text. */
export function executionLanguageFingerprints(text: string): string[] {
  const hits: string[] = [];
  for (const { label, pattern, whitelist } of EXECUTION_LANGUAGE_FINGERPRINTS) {
    if (!whitelist) {
      if (pattern.test(text)) hits.push(label);
      continue;
    }
    const tokens = text.match(new RegExp(pattern.source, 'g')) ?? [];
    if (tokens.some((token) => !whitelist.has(token))) hits.push(label);
  }
  return hits;
}

/**
 * 终稿出口的**删除式**执行语言判据（D-136/D-138，2026-10-26 立项）：与上方指纹表
 * 同源但作用不同——指纹表是"发现即告警"（探针/附注准入用），这里只收"对用户完全
 * 无用、删除零信息损失"的两种形态，由 reply-exit 的出口整理消费：
 *   · 工具调用协议标记（D-138，Z1 实测：模型把工具调用写成正文，318 字符 XML 原样
 *     上屏）——`<tool_call>`/`<function=…>`/`</parameter>` 族标签；
 *   · 全大写错误码（D-136，F6 双向实测：PERIOD_NO_DATA 族偶发上屏）——只收全大写
 *     snake 形态，小写 snake（account_set 等）可能是正常叙述词，不删。
 * JSON 片段/operation 名/内部控制词不进删除集：误删风险大于收益，仍由指纹表守
 * （探针可见），出口删除只做零争议形态。
 */
export const EXECUTION_LANGUAGE_SCRUB_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
  /** 命中白名单的 token 保留（宿主自己的码表词不是泄漏）。 */
  whitelist?: ReadonlySet<string>;
}> = [
  { label: '工具调用协议', pattern: /<\/?(?:tool_call|tool_result|function|parameter)[^>]*>/g },
  {
    label: '错误码',
    pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    // 宿主码表词（TASK_FORBIDDEN 族）保留——它们出现在宿主自己的确定性话术里，
    // 码上屏是既有产品行为（用户可引用码报告问题）；删除只针对平台/worker 侧码。
    whitelist: HOST_ERROR_CODE_NAMES,
  },
];
