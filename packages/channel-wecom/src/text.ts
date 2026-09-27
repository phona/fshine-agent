/**
 * 企微流式回复单条消息的字节上限。
 * 来源：@wecom/aibot-node-sdk README——replyStream 的 content"最长 20480 字节"。
 * 历史事故：W1 曾把它写成 2048（少一个零，十倍保守），导致所有超过约 600 汉字的
 * 回复被无声截断在句子中间——用户拿到半句话，而探针的 toContain 前缀断言照过。
 * 改这个值之前先核对 SDK README，不要再凭感觉抄。
 */
export const MAX_REPLY_BYTES = 20480;

/** 截断标记：真超上限时告诉用户"还有内容没显示完"，而不是无声砍断。 */
export const REPLY_TRUNCATED_MARK = '……（内容过长已截断，可以让我分次或精简回答）';

/** UTF-8 安全截断:多字节字符不截半,截断结果不会出现 U+FFFD */
export function truncateUtf8(text: string, maxBytes: number = MAX_REPLY_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * 用户可见回复的截断：超上限时截断并追加明确标记（调用方据此记守夜事件）。
 * 与 truncateUtf8 的区别只在"被截断时看得见"——无声硬切是传输层的答非所问。
 */
export function truncateReply(text: string, maxBytes: number = MAX_REPLY_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const markBytes = Buffer.byteLength(REPLY_TRUNCATED_MARK, 'utf8');
  return { text: truncateUtf8(text, Math.max(0, maxBytes - markBytes)) + REPLY_TRUNCATED_MARK, truncated: true };
}

const MENTION_PREFIX_RE = /^@[^ \u3000]*(?:[ \u3000]+|$)/;

/** 群聊消息:剥离开头 @机器人 段(从 @ 到第一个半角/全角空格) */
export function stripMentionPrefix(content: string): string {
  const match = MENTION_PREFIX_RE.exec(content);
  const matched = match?.[0];
  if (!match || matched === undefined) return content;
  return content.slice(matched.length).trim();
}
