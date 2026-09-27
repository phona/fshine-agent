import { describe, expect, it } from 'vitest';
import { MAX_REPLY_BYTES, REPLY_TRUNCATED_MARK, stripMentionPrefix, truncateReply, truncateUtf8 } from './src/index';

describe('truncateUtf8', () => {
  it('不超过上限的文本原样返回', () => {
    const text = '你好,世界 hello';
    expect(truncateUtf8(text)).toBe(text);
  });

  it('超长中文截断后字节数 <= 上限且不出现半个字符(U+FFFD)', () => {
    const text = '查'.repeat(30000);
    const out = truncateUtf8(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    expect(out).not.toContain('\uFFFD');
    expect(out.length).toBe(Math.floor(MAX_REPLY_BYTES / 3));
    expect(Buffer.byteLength(out, 'utf8')).toBe(Math.floor(MAX_REPLY_BYTES / 3) * 3);
  });

  it('4 字节 emoji 不被截半', () => {
    const text = '💰'.repeat(10000);
    const out = truncateUtf8(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    expect(out).not.toContain('\uFFFD');
    expect(out.length).toBe(Math.floor(MAX_REPLY_BYTES / 4) * 2); // emoji 为代理对,length 数 UTF-16 单元
  });

  it('边界:截断点落在多字节字符起始字节上时整个字符被排除', () => {
    const text = 'a'.repeat(MAX_REPLY_BYTES - 1) + '中';
    const out = truncateUtf8(text);
    expect(Buffer.byteLength(out, 'utf8')).toBe(MAX_REPLY_BYTES - 1);
    expect(out).not.toContain('\uFFFD');
    expect(out).toBe('a'.repeat(MAX_REPLY_BYTES - 1));
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

describe('truncateReply', () => {
  it('不超限时原文返回且标记未截断', () => {
    const r = truncateReply('短回复');
    expect(r.text).toBe('短回复');
    expect(r.truncated).toBe(false);
  });

  it('超限时截断并带明确标记,且总字节不超上限', () => {
    const r = truncateReply('查'.repeat(30000));
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith(REPLY_TRUNCATED_MARK)).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    expect(r.text).not.toContain('\uFFFD');
  });
});
