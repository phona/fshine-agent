'use strict';
/**
 * Error objects from the declared catalog. The catalog is pure data
 * (`errorCatalog` in capabilities.json); an unknown code still yields a valid
 * error object, it just carries no `correctForm` — same contract the gateway
 * has always had.
 */
/** 确定性错误码：重试同一请求不会有任何新信息，执行层明确标 retryable:false。 */
const DETERMINISTIC_CODES = new Set([
  'WHERE_INVALID', 'COLLECTION_NOT_FOUND', 'COLLECTION_LOCKED', 'CALL_REFUSE',
  'GATE_REFUSE', 'DELAY_OUT_OF_RANGE', 'COLLECTION_FAULT_NOT_RETRYABLE',
]);

/**
 * **参数形状错误**：错的是这次请求的写法（JSON 不合法、缺必填参数、未声明参数），
 * 不是「这个对象不可用」——执行层显式声明 retryable:true，允许宿主在**同一回合里**
 * 让模型按执行层给出的正确形态再试一次（2026-11-18 live 实测：模型把 --records 写成
 * `name=value` 被拒后，默认不可重试会直接锁死，用户得再开口才能纠正）。
 */
const RETRYABLE_ARG_CODES = new Set(['INVALID_RECORDS', 'QUERY_REQUIRED', 'CALL_REFUSE']);

function makeError(catalog, code, message) {
  if (typeof code !== 'string' || code === '') throw new Error('error code must be a non-empty string');
  if (typeof message !== 'string' || message === '') throw new Error(`error ${code} must have a message`);
  const error = { code, message };
  if (DETERMINISTIC_CODES.has(code)) error.retryable = false;
  if (RETRYABLE_ARG_CODES.has(code)) error.retryable = true;
  if (catalog !== null && typeof catalog === 'object' && typeof catalog[code] === 'string') {
    error.correctForm = catalog[code];
  }
  return error;
}

module.exports = { makeError };
