import { describe, expect, it } from 'vitest';
import { MAX_REPLY_BYTES, stripMentionPrefix, truncateUtf8 } from './src/index';

describe('truncateUtf8', () => {
  it('不超过 2048 字节的文本原样返回', () => {
    const text = '你好,世界 hello';
    expect(truncateUtf8(text)).toBe(text);
  });

  it('超长中文截断后字节数 <= 2048 且不出现半个字符(U+FFFD)', () => {
    const text = '查'.repeat(1000);
    const out = truncateUtf8(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    expect(out).not.toContain('\uFFFD');
    expect(out.length).toBe(682);
    expect(Buffer.byteLength(out, 'utf8')).toBe(682 * 3);
  });

  it('4 字节 emoji 不被截半', () => {
    const text = '💰'.repeat(600);
    const out = truncateUtf8(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    expect(out).not.toContain('\uFFFD');
    expect(out.length).toBe(1024);
  });

  it('边界:截断点落在多字节字符起始字节上时整个字符被排除', () => {
    const text = 'a'.repeat(2047) + '中';
    const out = truncateUtf8(text);
    expect(Buffer.byteLength(out, 'utf8')).toBe(2047);
    expect(out).not.toContain('\uFFFD');
    expect(out).toBe('a'.repeat(2047));
  });

  it('支持自定义最大字节数', () => {
    expect(truncateUtf8('中文', 6)).toBe('中文');
    expect(truncateUtf8('中文', 4)).toBe('中');
    expect(truncateUtf8('中文', 3)).toBe('中');
    expect(truncateUtf8('中文', 2)).toBe('');
  });
});

describe('stripMentionPrefix', () => {
  it('剥离 @机器人 加半角空格前缀', () => {
    expect(stripMentionPrefix('@财报助手 帮我查6月账套')).toBe('帮我查6月账套');
  });

  it('剥离 @机器人 加全角空格前缀', () => {
    expect(stripMentionPrefix('@财报助手　查一下7月流水')).toBe('查一下7月流水');
  });

  it('多个空格一并剥离', () => {
    expect(stripMentionPrefix('@财报助手   查一下')).toBe('查一下');
  });

  it('只有 @机器人 时结果为空串', () => {
    expect(stripMentionPrefix('@财报助手')).toBe('');
  });

  it('不以 @ 开头时原样返回', () => {
    expect(stripMentionPrefix('帮我查账')).toBe('帮我查账');
  });
});
