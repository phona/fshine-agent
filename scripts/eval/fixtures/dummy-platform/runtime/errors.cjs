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

function makeError(catalog, code, message) {
  if (typeof code !== 'string' || code === '') throw new Error('error code must be a non-empty string');
  if (typeof message !== 'string' || message === '') throw new Error(`error ${code} must have a message`);
  const error = { code, message };
  if (DETERMINISTIC_CODES.has(code)) error.retryable = false;
  if (catalog !== null && typeof catalog === 'object' && typeof catalog[code] === 'string') {
    error.correctForm = catalog[code];
  }
  return error;
}

module.exports = { makeError };
