export const MAX_REPLY_BYTES = 2048;

/** UTF-8 安全截断:多字节字符不截半,截断结果不会出现 U+FFFD */
export function truncateUtf8(text: string, maxBytes: number = MAX_REPLY_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

const MENTION_PREFIX_RE = /^@[^ \u3000]*(?:[ \u3000]+|$)/;

/** 群聊消息:剥离开头 @机器人 段(从 @ 到第一个半角/全角空格) */
export function stripMentionPrefix(content: string): string {
  const match = MENTION_PREFIX_RE.exec(content);
  const matched = match?.[0];
  if (!match || matched === undefined) return content;
  return content.slice(matched.length).trim();
}
