/**
 * 基于 ws 库的 WebSocket 实现,适配 WecomBotChannel 需要的接口形状。
 * 不用 Node 24 全局 WebSocket(undici):实测对 openws 网关握手即失败(2026-09),
 * 官方 aibot-node-sdk 同样基于 ws 库。
 */
import WebSocket from 'ws';

export class NodeWebSocketImpl {
  private readonly ws: WebSocket;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('open', () => this.onopen?.());
    this.ws.on('message', (data) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      this.onmessage?.({ data: buf.toString('utf8') });
    });
    this.ws.on('close', () => this.onclose?.());
    this.ws.on('error', (error: Error) => this.onerror?.(error));
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}
