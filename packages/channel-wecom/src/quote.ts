import { MAX_QUOTED_TEXT_BYTES, type IncomingMessageReference } from '@fshine/contracts';
import { truncateUtf8 } from './text';

export { MAX_QUOTED_TEXT_BYTES } from '@fshine/contracts';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function textContent(value: unknown): string | undefined {
  const content = asRecord(value)?.['content'];
  return typeof content === 'string' ? content : undefined;
}

function boundedReference(
  kind: IncomingMessageReference['kind'],
  text: string | undefined,
): IncomingMessageReference {
  if (text === undefined) return { kind };
  if (Buffer.byteLength(text, 'utf8') <= MAX_QUOTED_TEXT_BYTES) return { kind, text };
  return {
    kind,
    text: truncateUtf8(text, MAX_QUOTED_TEXT_BYTES),
    truncated: true,
  };
}

/**
 * Normalize the optional native WeCom quote without retaining its raw payload.
 * QuoteContent in the installed SDK has no source message id; in particular, the
 * outer message's msgid is never a substitute for the quoted message's identity.
 */
export function extractMessageReference(value: unknown): IncomingMessageReference | undefined {
  const quote = asRecord(value);
  if (!quote) return undefined;
  const kind = quote['msgtype'];
  if (kind === 'text') {
    return boundedReference('text', textContent(quote['text']));
  }
  if (kind === 'mixed') {
    const mixed = asRecord(quote['mixed']);
    const items = mixed?.['msg_item'];
    if (!Array.isArray(items)) return { kind: 'mixed' };
    const text = items
      .map((item) => {
        const record = asRecord(item);
        return record?.['msgtype'] === 'text' ? textContent(record['text']) ?? '' : '';
      })
      .filter((part) => part !== '')
      .join('\n');
    return boundedReference('mixed', text === '' ? undefined : text);
  }
  if (kind === 'image' || kind === 'voice' || kind === 'file') {
    // Referenced media is context by type only. Do not copy URL, aeskey, or media bytes.
    return { kind };
  }
  return undefined;
}
