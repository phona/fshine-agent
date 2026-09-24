import type { ReplyHandler } from '@fshine/contracts';
import { renderBarChartPng } from './chart';

const DEMO_IMAGE_PATTERN = /发图|测试图片|图片/;

/** 生产入口包装：演示图片短路，其余消息原样保留渠道回调。 */
export function createServerReplyHandler(sharedHandler: ReplyHandler): ReplyHandler {
  return async (message, progress, notice) => {
    if (DEMO_IMAGE_PATTERN.test(message.text)) {
      return {
        text: '幻晟 202607 凭证金额分布(模拟数据 · 图片通道演示)',
        image: {
          data: renderBarChartPng([1200, 1850, 990, 2400, 1750, 3000, 1500, 2200]),
          filename: 'voucher-202607.png',
        },
      };
    }
    return sharedHandler(message, progress, notice);
  };
}
