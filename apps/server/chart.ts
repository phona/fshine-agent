/**
 * 依赖零生的 PNG 柱状图渲染:RGBA 画布 → 手工 PNG 编码(zlib deflate + CRC32)。
 * 仅覆盖演示/截图展示所需的极小子集(矩形、纯色),不做文字渲染(说明文字走消息正文)。
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function renderBarChartPng(values: number[], width = 640, height = 320): Buffer {
  const px = Buffer.alloc(width * height * 4, 0xff);
  const rect = (x: number, y: number, w: number, h: number, r: number, g: number, b: number): void => {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const px2 = (y + dy) * width + (x + dx);
        if (y + dy < 0 || y + dy >= height || x + dx < 0 || x + dx >= width) continue;
        const off = px2 * 4;
        px[off] = r;
        px[off + 1] = g;
        px[off + 2] = b;
        px[off + 3] = 0xff;
      }
    }
  };

  const left = 48;
  const right = width - 16;
  const top = 28;
  const bottom = height - 28;

  for (let q = 1; q <= 3; q += 1) {
    const y = Math.round(bottom - ((bottom - top) * q) / 4);
    rect(left, y, right - left, 1, 224, 224, 224);
  }
  rect(left, top, 2, bottom - top, 90, 90, 90);
  rect(left, bottom, right - left, 2, 90, 90, 90);

  const max = Math.max(...values, 1);
  const slot = (right - left) / values.length;
  const barWidth = Math.min(Math.round(slot * 0.55), 48);
  values.forEach((value, index) => {
    const barHeight = Math.max(2, Math.round(((bottom - top - 10) * value) / max));
    const x = Math.round(left + slot * index + (slot - barWidth) / 2);
    rect(x, bottom - barHeight, barWidth, barHeight, 36, 98, 214);
  });

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    px.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
