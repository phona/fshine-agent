/**
 * 纯附件机械事实（目标 A）的确定性单元测试。
 *
 * 事实只允许包含：文件名 / fileId / 字节数 / 时间。**不得包含路径、行数据、sha256**。
 * 同一 fileId 重复登记只注入一次；注入（take）后出队；不同会话互不串扰。
 * take 带回执（2026-11-19 注入核销）：本回合没产出用户可见内容时 requeue 原样放回。
 */
import { describe, expect, it } from 'vitest';
import { createAttachmentFactQueue, createScopedNoteQueue, renderAttachmentFact, type AttachmentFactInput } from './attachment-facts';

function fact(overrides: Partial<AttachmentFactInput> = {}): AttachmentFactInput {
  return {
    fileId: 'file_abc123',
    name: '名册.xlsx',
    bytes: 6861,
    receivedAt: new Date(2026, 10, 17, 20, 41, 0).toISOString(),
    ...overrides,
  };
}

describe('renderAttachmentFact：机械事实（无路径、无行数据）', () => {
  it('格式 = [收到附件] 名 · fileId=… · 千分位字节 · YYYY-MM-DD HH:mm', () => {
    expect(renderAttachmentFact(fact())).toBe('[收到附件] 名册.xlsx · fileId=file_abc123 · 6,861 字节 · 2026-11-17 20:41');
  });

  it('文件名里的路径分隔符/上级序列被净化（不产生路径面）', () => {
    const rendered = renderAttachmentFact(fact({ name: '../../etc/名册.xlsx' }));
    expect(rendered).not.toContain('../');
    expect(rendered).not.toMatch(/[\\/]/);
    expect(rendered).toContain('名册.xlsx');
    expect(rendered.startsWith('[收到附件] ')).toBe(true);
  });
});

describe('createAttachmentFactQueue：按 (principal, session) 排队，同 fileId 只注入一次', () => {
  it('同一 fileId 重复登记 → 只渲染一行；take 后出队（第二次为空）', () => {
    const queue = createAttachmentFactQueue();
    queue.enqueue({ principalId: 'p', sessionId: 's', files: [fact(), fact()] });
    const taken = queue.take('p', 's');
    expect(taken?.text.match(/\[收到附件\]/g)).toHaveLength(1);
    expect(taken?.text).toContain('fileId=file_abc123');
    expect(queue.take('p', 's')).toBeUndefined();
  });

  it('多个不同 fileId 按登记序各一行；会话隔离', () => {
    const queue = createAttachmentFactQueue();
    queue.enqueue({
      principalId: 'p',
      sessionId: 's',
      files: [fact({ fileId: 'file_1', name: 'a.xlsx' }), fact({ fileId: 'file_2', name: 'b.xlsx' })],
    });
    queue.enqueue({ principalId: 'p', sessionId: 'other', files: [fact({ fileId: 'file_3', name: 'c.xlsx' })] });

    const mine = queue.take('p', 's');
    expect(mine?.text.split('\n')).toHaveLength(2);
    expect(mine?.text).toContain('a.xlsx');
    expect(mine?.text).toContain('b.xlsx');
    expect(queue.take('p', 's')).toBeUndefined();
    expect(queue.take('p', 'other')?.text).toContain('c.xlsx');
  });

  it('clear() 清空所有排队事实（停机不把事实带进下一次装配）', () => {
    const queue = createAttachmentFactQueue();
    queue.enqueue({ principalId: 'p', sessionId: 's', files: [fact()] });
    queue.clear();
    expect(queue.take('p', 's')).toBeUndefined();
  });

  it('回执：本回合没说出声 → requeue 原样放回（同一 fileId 再注入一次）', () => {
    const queue = createAttachmentFactQueue();
    queue.enqueue({
      principalId: 'p',
      sessionId: 's',
      files: [fact({ fileId: 'file_1', name: 'a.xlsx' }), fact({ fileId: 'file_2', name: 'b.xlsx' })],
    });
    const taken = queue.take('p', 's');
    expect(taken).toBeDefined();
    taken!.requeue?.();
    const again = queue.take('p', 's');
    expect(again?.text).toBe(taken!.text);
    // 退回不是复制：再 take 一次就拿不到了（每份事实只注入一次）。
    expect(queue.take('p', 's')).toBeUndefined();
  });
});

describe('createScopedNoteQueue：单槽注记 + 注入回执', () => {
  it('take 出队；requeue 放回同一条（没说出声不核销）', () => {
    const queue = createScopedNoteQueue();
    queue.enqueue('p', 's', '这件事比预计久了，要我停下来还是继续等？');
    const taken = queue.take('p', 's');
    expect(taken?.text).toContain('比预计久了');
    expect(queue.take('p', 's')).toBeUndefined();
    taken!.requeue?.();
    expect(queue.take('p', 's')?.text).toBe(taken!.text);
  });
});
