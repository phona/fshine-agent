export {
  ATTACHMENT_WAIT_TIMEOUT_MS,
  WecomBotChannel,
  WecomChannelDeliveryError,
  RECEIPT_COALESCE_MS,
} from './adapter';
export type { WecomBotChannelOptions, SdkClientLike } from './adapter';
export { MAX_REPLY_BYTES, REPLY_TRUNCATED_MARK, stripMentionPrefix, truncateReply, truncateUtf8 } from './text';
export { MAX_QUOTED_TEXT_BYTES } from './quote';
