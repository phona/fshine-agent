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
