/**
 * 真实长连接冒烟测试:连接 → 订阅成功 → 挂 6 秒 → 正常断开。
 * 用法:npm run smoke:wecom(等同 node --env-file-if-exists=.env --import tsx scripts/smoke-wecom.ts)
 * 配置与生产同源:config/agent.yaml 是源、非空 env 覆盖(AGENT_CONFIG_PATH 可改路径)。
 * 生效环境的合并复用 @fshine/core 的 effectiveDeploymentEnv(唯一实现),不在此另写
 * 优先级——否则新部署只填 yaml 时,冒烟会报缺凭据而生产可用。
 * 注意:该机器人同时只允许一条连接,冒烟会踢掉已有连接。
 */
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import { WecomBotChannel } from '@fshine/channel-wecom';

const env = process.env;
// 与 apps/server/assembly.ts 同一加载入口与合并实现(AGENT_CONFIG_PATH 语义一致)。
const config = loadConfig({ env, yamlPath: env['AGENT_CONFIG_PATH'] || undefined });
const channel = new WecomBotChannel({ env: effectiveDeploymentEnv(config, env) });
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
