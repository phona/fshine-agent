/** 确定性 JSON 与哈希工具（判据冻结与 judgmentSha256 用；不引入任何外部依赖）。 */
import { createHash } from 'node:crypto';

/** 稳定序列化：对象键递归排序；数组保持顺序。同输入 → 同字节。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) output[key] = normalize(record[key]);
    return output;
  }
  return value;
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
