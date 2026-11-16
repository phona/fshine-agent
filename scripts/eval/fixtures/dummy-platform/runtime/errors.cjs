'use strict';
/**
 * Error objects from the declared catalog. The catalog is pure data
 * (`errorCatalog` in capabilities.json); an unknown code still yields a valid
 * error object, it just carries no `correctForm` — same contract the gateway
 * has always had.
 */
function makeError(catalog, code, message) {
  if (typeof code !== 'string' || code === '') throw new Error('error code must be a non-empty string');
  if (typeof message !== 'string' || message === '') throw new Error(`error ${code} must have a message`);
  const error = { code, message };
  if (catalog !== null && typeof catalog === 'object' && typeof catalog[code] === 'string') {
    error.correctForm = catalog[code];
  }
  return error;
}

module.exports = { makeError };
