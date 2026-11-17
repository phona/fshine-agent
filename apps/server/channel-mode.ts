/**
 * 渠道装配档位（offline / shadow / live）——部署配置 `channel.mode` 的唯一消费点。
 *
 *   · offline（缺省）：**不调用 channel.start**（不建立 WS 长连接、不认证），出站视为
 *     silent——宿主侧文件投递记 suppressed，不触达任何真实平台；
 *   · shadow：建立长连接（入站照收、回合照跑），但渠道出站模式显式声明为 silent——
 *     六类用户可见发送路径全部由 Silent Shadow 闸门抑制并留证据；
 *   · live：真实投递（改动前的生产语义，逐字不变）。
 *
 * 档位只来自 yaml（`AppConfig.channel.mode`），没有 FSHINE_* 环境变量覆盖口；缺省值
 * 只有 `DEFAULT_CHANNEL_MODE` 一处。真实渠道的 deliveryMode 始终**显式**传入：
 * offline/shadow 传 'silent'（不会因环境开关被放行），live 传 'live'。
 */
import {
  DEFAULT_CHANNEL_MODE,
  type AppConfig,
  type ChannelMode,
  type ReplyHandler,
} from '@fshine/contracts';

/** 渠道适配器实际采用的出站模式（与 Silent Shadow 闸门的有效模式同域）。 */
export type ChannelDeliveryMode = 'live' | 'silent';

/** 渠道装配的最小生命周期面（真实适配器与测试替身都满足）。 */
export interface ChannelLifecycle {
  readonly deliveryMode: ChannelDeliveryMode;
  start(handler: ReplyHandler): Promise<void>;
}

/** AppConfig → 生效档位：缺键 = DEFAULT_CHANNEL_MODE（offline）。 */
export function channelModeOf(config: AppConfig): ChannelMode {
  return config.channel.mode ?? DEFAULT_CHANNEL_MODE;
}

/** 档位 → 渠道出站模式：只有 live 放行真实投递；offline/shadow 一律 silent。 */
export function deliveryModeFor(mode: ChannelMode): ChannelDeliveryMode {
  return mode === 'live' ? 'live' : 'silent';
}

/** 按档位创建渠道：构造期即把出站模式显式钉死（不依赖适配器缺省或环境开关）。 */
export function createChannelForMode<T extends ChannelLifecycle>(
  mode: ChannelMode,
  create: (deliveryMode: ChannelDeliveryMode) => T,
): T {
  return create(deliveryModeFor(mode));
}

/**
 * 按档位启动渠道：offline **不调用 start**（也就不建连接）；shadow/live 建立连接。
 * 返回是否真的启动，供启动日志与调用方核对。
 */
export async function startChannelForMode(
  mode: ChannelMode,
  channel: ChannelLifecycle,
  handler: ReplyHandler,
): Promise<{ started: boolean }> {
  if (mode === 'offline') return { started: false };
  await channel.start(handler);
  return { started: true };
}

/**
 * `server_started` 启动日志事实（main.ts 的唯一构造点；测试直接钉住字段）。
 * `channelMode` 与渠道实际出站 `deliveryMode` 同时出现：部署侧一眼看出「连没连、发不发」。
 */
export function serverStartedEvent(input: {
  configPath: string;
  profileId: string;
  dbPath: string;
  channelMode: ChannelMode;
  deliveryMode: ChannelDeliveryMode;
}): Record<string, unknown> {
  return {
    event: 'server_started',
    configPath: input.configPath,
    profileId: input.profileId,
    dbPath: input.dbPath,
    channelMode: input.channelMode,
    deliveryMode: input.deliveryMode,
  };
}
