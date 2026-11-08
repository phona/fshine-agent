/**
 * 真实长连接冒烟测试:连接 → 订阅成功 → 挂 6 秒 → 正常断开。
 * 用法:node --env-file=.env --import tsx scripts/smoke-wecom.ts
 * 注意:该机器人同时只允许一条连接,冒烟会踢掉已有连接。
 */
import { WecomBotChannel } from '@fshine/channel-wecom';

const channel = new WecomBotChannel({ env: process.env });
const timeout = setTimeout(() => {
  console.error('SMOKE_FAIL: 30 秒内未完成订阅');
  process.exit(1);
}, 30000);

try {
  await channel.start(async (msg) => {
    console.log('冒烟期间收到消息(不处理):', msg.wecomUserId, JSON.stringify(msg.text.slice(0, 20)));
    return '机器人正在初始化,请稍后再试';
  });
  console.log('SMOKE_OK: 长连接已建立且订阅成功(aibot_subscribe errcode=0),凭证有效');
  await new Promise((r) => setTimeout(r, 6000));
  await channel.stop();
  clearTimeout(timeout);
  console.log('SMOKE_DONE: 已正常断开');
  process.exit(0);
} catch (e) {
  clearTimeout(timeout);
  console.error('SMOKE_FAIL:', e instanceof Error ? e.message : e);
  process.exit(1);
}
