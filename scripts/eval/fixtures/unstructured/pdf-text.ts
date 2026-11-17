/**
 * 最小 PDF 结构校验 + 文本提取器（只服务本仓文本型夹具，不是通用 PDF 库）。
 *
 * 覆盖：PDF 1.x 头、startxref/xref 偏移、trailer、Catalog/Pages/Page、未压缩内容流、
 * BT/ET 文本块里的 Tj / TJ / ' / " 算子与 PDF 字面字符串转义。
 *
 * 明确不支持（遇到即报错，不静默猜）：压缩内容流（/Filter）、加密、对象流、CID 字体。
 * 本机与 CI 都没有 pdftotext/poppler（2026-11-17 实测 `which pdftotext` = not found），
 * 仓内也没有 PDF 解析依赖（AGENTS.md 禁止为夹具新增解析库）——这里的断言证明的是
 * 「文本以标准文本算子存在于内容流」，不是渲染级解析。
 */

export interface PdfStructure {
  pageCount: number;
  objectCount: number;
  rootType: 'Catalog';
  contentObjectIds: number[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PDF 结构不合法：${message}`);
}

/** 取对象体（`N 0 obj` 与 `endobj` 之间）；对象号必须存在且唯一。 */
function objectBody(raw: string, id: number): string {
  const pattern = new RegExp(`(?:^|\\n)${id} 0 obj\\n([\\s\\S]*?)\\nendobj\\n`, 'g');
  const match = pattern.exec(raw);
  assert(match !== null, `对象 ${id} 缺失`);
  return match[1]!;
}

/** 校验 xref/trailer/页树，返回页数与内容流对象号。 */
export function validatePdfStructure(pdf: Buffer): PdfStructure {
  const raw = pdf.toString('latin1');
  assert(raw.startsWith('%PDF-1.'), '缺少 %PDF-1.x 头');

  const tail = /startxref\n(\d+)\n%%EOF\n?$/.exec(raw);
  assert(tail !== null, '缺少 startxref/%%EOF');
  const xrefOffset = Number(tail[1]);
  assert(Number.isSafeInteger(xrefOffset) && raw.startsWith('xref', xrefOffset), `startxref=${xrefOffset} 未指向 xref`);

  const section = raw.slice(xrefOffset);
  const head = /^xref\n(\d+) (\d+)\n/.exec(section);
  assert(head !== null, 'xref 头缺失');
  const firstId = Number(head[1]);
  const entryCount = Number(head[2]);
  assert(firstId === 0, `xref 起始对象号 ${firstId} ≠ 0`);

  const entriesStart = xrefOffset + head[0].length;
  const entries: Array<{ offset: number; kind: 'n' | 'f' }> = [];
  for (let index = 0; index < entryCount; index += 1) {
    const line = raw.slice(entriesStart + index * 20, entriesStart + (index + 1) * 20);
    const entry = /^(\d{10}) (\d{5}) ([nf]) \n$/.exec(line);
    assert(entry !== null, `第 ${index} 条 xref 条目形状不合法`);
    entries.push({ offset: Number(entry[1]), kind: entry[3] as 'n' | 'f' });
  }

  const trailerStart = entriesStart + entryCount * 20;
  const trailerMatch = /^trailer\n<<([\s\S]*?)>>\nstartxref\n/.exec(raw.slice(trailerStart));
  assert(trailerMatch !== null, 'trailer 缺失');
  const trailer = trailerMatch[1]!;
  const size = /\/Size\s+(\d+)/.exec(trailer);
  assert(size !== null && Number(size[1]) === entryCount, `trailer /Size 与 xref 条目数不一致`);
  const root = /\/Root\s+(\d+) 0 R/.exec(trailer);
  assert(root !== null, 'trailer 缺少 /Root');

  for (let id = 0; id < entryCount; id += 1) {
    const entry = entries[id]!;
    if (entry.kind === 'f') continue;
    assert(raw.startsWith(`${id} 0 obj`, entry.offset), `xref 偏移 ${entry.offset} 未指向对象 ${id}`);
  }
  const objectCount = entries.filter((entry) => entry.kind === 'n').length;

  const rootId = Number(root[1]);
  const rootBody = objectBody(raw, rootId);
  assert(/\/Type\s*\/Catalog\b/.test(rootBody), `Root 对象 ${rootId} 不是 /Catalog`);
  assert(!/\/Subtype\s*\/Image\b/.test(raw), '夹具不应包含图片对象（文本型断言）');

  const pagesBody = [...raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g)]
    .filter((match) => /\/Type\s*\/Pages\b/.test(match[2]!));
  assert(pagesBody.length >= 1, '页树 /Pages 缺失');
  const countMatches = pagesBody.map((match) => /\/Count\s+(\d+)/.exec(match[2]!)).filter((match) => match !== null);
  assert(countMatches.length === pagesBody.length, '页树缺少 /Count');
  const declaredPages = countMatches.reduce((sum, match) => sum + Number(match![1]), 0);

  const pageObjects = [...raw.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g)]
    .filter((match) => /\/Type\s*\/Page\b/.test(match[2]!));
  assert(declaredPages === pageObjects.length, `/Count=${declaredPages} 与实际 Page 对象 ${pageObjects.length} 不一致`);

  const contentObjectIds: number[] = [];
  for (const page of pageObjects) {
    const contents = /\/Contents\s+(\d+) 0 R/.exec(page[2]!);
    assert(contents !== null, `Page 对象 ${page[1]} 缺少 /Contents`);
    contentObjectIds.push(Number(contents[1]));
  }

  return { pageCount: pageObjects.length, objectCount, rootType: 'Catalog', contentObjectIds };
}

/** 取未压缩内容流里的文本行（按文本显示算子逐条输出）。 */
export function extractPdfTextLines(pdf: Buffer): string[] {
  const structure = validatePdfStructure(pdf);
  const raw = pdf.toString('latin1');
  const lines: string[] = [];
  for (const id of structure.contentObjectIds) {
    const body = objectBody(raw, id);
    const streamIndex = body.indexOf('stream\n');
    assert(streamIndex >= 0, `内容对象 ${id} 缺少 stream`);
    const dictionary = body.slice(0, streamIndex);
    assert(!/\/Filter\s/.test(dictionary), `内容对象 ${id} 使用了压缩流（本提取器不支持）`);
    const length = /\/Length\s+(\d+)/.exec(dictionary);
    assert(length !== null, `内容对象 ${id} 缺少 /Length`);
    const dataStart = streamIndex + 'stream\n'.length;
    const dataEnd = dataStart + Number(length[1]);
    const data = body.slice(dataStart, dataEnd);
    assert(body.startsWith('endstream', dataEnd), `内容对象 ${id} 的流长度与 /Length 不一致`);
    lines.push(...textOfContentStream(data));
  }
  return lines;
}

type PdfOperand = string | number | Array<string | number>;

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';
}

function isDelimiter(ch: string): boolean {
  return ch === '(' || ch === ')' || ch === '<' || ch === '>' || ch === '[' || ch === ']'
    || ch === '{' || ch === '}' || ch === '/' || ch === '%';
}

/** 读 PDF 字面字符串 `( ... )`，处理转义与嵌套括号。 */
function readLiteralString(input: string, start: number): { value: string; next: number } {
  let index = start + 1;
  let depth = 1;
  let value = '';
  while (index < input.length) {
    const ch = input[index]!;
    if (ch === '\\') {
      index += 1;
      const escaped = input[index];
      if (escaped === undefined) break;
      index += 1;
      switch (escaped) {
        case 'n': value += '\n'; break;
        case 'r': value += '\r'; break;
        case 't': value += '\t'; break;
        case 'b': value += '\b'; break;
        case 'f': value += '\f'; break;
        case '(': value += '('; break;
        case ')': value += ')'; break;
        case '\\': value += '\\'; break;
        case '\r':
          if (input[index] === '\n') index += 1;
          break;
        case '\n': break;
        default: {
          if (/[0-7]/.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && input[index] !== undefined && /[0-7]/.test(input[index]!)) {
              octal += input[index];
              index += 1;
            }
            value += String.fromCharCode(Number.parseInt(octal, 8));
          } else {
            value += escaped;
          }
        }
      }
      continue;
    }
    if (ch === '(') {
      depth += 1;
      value += ch;
      index += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) return { value, next: index };
      value += ch;
      continue;
    }
    value += ch;
    index += 1;
  }
  throw new Error('PDF 结构不合法：字面字符串未闭合');
}

function decodePdfBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // PDF 的 UTF-16BE 文本串：去掉 BOM 后按 16 位大端解码。
    const body = bytes.subarray(2, 2 + ((bytes.length - 2) & ~1));
    const littleEndian = Buffer.from(body);
    littleEndian.swap16();
    return littleEndian.toString('utf16le');
  }
  return bytes.toString('latin1');
}

function readHexString(input: string, start: number): { value: string; next: number } {
  const end = input.indexOf('>', start + 1);
  if (end === -1) throw new Error('PDF 结构不合法：十六进制字符串未闭合');
  let hex = input.slice(start + 1, end).replaceAll(/\s+/g, '');
  if (hex.length % 2 === 1) hex += '0';
  return { value: decodePdfBytes(Buffer.from(hex, 'hex')), next: end + 1 };
}

function skipDictionary(input: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < input.length) {
    if (input[index] === '(') {
      index = readLiteralString(input, index).next;
      continue;
    }
    if (input[index] === '<' && input[index + 1] === '<') {
      depth += 1;
      index += 2;
      continue;
    }
    if (input[index] === '>' && input[index + 1] === '>') {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  throw new Error('PDF 结构不合法：字典未闭合');
}

function readArray(input: string, start: number): { value: Array<string | number>; next: number } {
  const values: Array<string | number> = [];
  let index = start + 1;
  while (index < input.length) {
    while (index < input.length && isWhitespace(input[index]!)) index += 1;
    if (input[index] === ']') return { value: values, next: index + 1 };
    const ch = input[index]!;
    if (ch === '(') {
      const literal = readLiteralString(input, index);
      values.push(literal.value);
      index = literal.next;
      continue;
    }
    if (ch === '<' && input[index + 1] === '<') {
      index = skipDictionary(input, index);
      continue;
    }
    if (ch === '<') {
      const hex = readHexString(input, index);
      values.push(hex.value);
      index = hex.next;
      continue;
    }
    let end = index;
    while (end < input.length && !isWhitespace(input[end]!) && !isDelimiter(input[end]!)) end += 1;
    const token = input.slice(index, end);
    if (token !== '' && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) values.push(Number(token));
    index = end === index ? index + 1 : end;
  }
  throw new Error('PDF 结构不合法：数组未闭合');
}

function lastString(operands: readonly PdfOperand[]): string | undefined {
  const last = operands[operands.length - 1];
  return typeof last === 'string' ? last : undefined;
}

function lastArray(operands: readonly PdfOperand[]): Array<string | number> | undefined {
  const last = operands[operands.length - 1];
  return Array.isArray(last) ? last : undefined;
}

/** 内容流解释：只收集文本显示算子的字符串（定位算子只用来分隔，不改变文本值）。 */
function textOfContentStream(content: string): string[] {
  const lines: string[] = [];
  let operands: PdfOperand[] = [];
  let inText = false;
  let index = 0;
  while (index < content.length) {
    const ch = content[index]!;
    if (isWhitespace(ch)) {
      index += 1;
      continue;
    }
    if (ch === '%') {
      while (index < content.length && content[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '(') {
      const literal = readLiteralString(content, index);
      operands.push(literal.value);
      index = literal.next;
      continue;
    }
    if (ch === '[') {
      const array = readArray(content, index);
      operands.push(array.value);
      index = array.next;
      continue;
    }
    if (ch === '<') {
      if (content[index + 1] === '<') {
        index = skipDictionary(content, index);
        continue;
      }
      const hex = readHexString(content, index);
      operands.push(hex.value);
      index = hex.next;
      continue;
    }
    if (ch === '/') {
      let end = index + 1;
      while (end < content.length && !isWhitespace(content[end]!) && !isDelimiter(content[end]!)) end += 1;
      operands.push(content.slice(index, end));
      index = end;
      continue;
    }
    if (isDelimiter(ch)) {
      index += 1;
      continue;
    }

    let end = index;
    while (end < content.length && !isWhitespace(content[end]!) && !isDelimiter(content[end]!)) end += 1;
    const token = content.slice(index, end);
    index = end;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      operands.push(Number(token));
      continue;
    }

    if (token === 'BT') {
      inText = true;
    } else if (token === 'ET') {
      inText = false;
    } else if (inText && (token === 'Tj' || token === "'" || token === '"')) {
      const shown = lastString(operands);
      if (shown !== undefined) lines.push(shown);
    } else if (inText && token === 'TJ') {
      const array = lastArray(operands);
      if (array !== undefined) {
        lines.push(array.filter((item): item is string => typeof item === 'string').join(''));
      }
    }
    operands = [];
  }
  return lines;
}
