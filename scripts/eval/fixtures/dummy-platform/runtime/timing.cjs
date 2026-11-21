'use strict';
/**
 * Declared wall-clock delay for the dummy execution layer (test fixture only).
 *
 * The fixture must be able to model a call that really takes time: a long read, a
 * long read that ends in a failure, or a long call that then asks for input. The
 * delay is a declared, bounded integer number of milliseconds and it really sleeps
 * (Atomics.wait on a throwaway shared cell) — no timers, no fake clock, nothing the
 * caller has to trust.
 *
 * This module knows only numbers. It carries no domain meaning and no protocol:
 * callers decide when to sleep; this file only parses and blocks.
 */

/** Upper bound for any single declared delay (kept below the host's 60s call budget). */
const MAX_DELAY_MS = 60_000;

/**
 * Parse a declared delay value. Absent = 0 (no delay). Anything else must be a
 * non-negative decimal integer within MAX_DELAY_MS; out-of-range / malformed values
 * are refused deterministically instead of being clamped.
 */
function parseDelayMs(raw) {
  if (raw === undefined || raw === null) return { ok: true, ms: 0 };
  if (typeof raw === 'boolean') {
    return { ok: false, code: 'DELAY_INVALID', message: '--delay-ms requires an integer number of milliseconds' };
  }
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    return { ok: false, code: 'DELAY_INVALID', message: `--delay-ms requires an integer number of milliseconds, got "${text}"` };
  }
  const ms = Number(text);
  if (!Number.isSafeInteger(ms) || ms > MAX_DELAY_MS) {
    return {
      ok: false,
      code: 'DELAY_OUT_OF_RANGE',
      message: `--delay-ms must be an integer between 0 and ${MAX_DELAY_MS} milliseconds, got ${text}`,
    };
  }
  return { ok: true, ms };
}

/** Block the current thread for `ms` milliseconds (no-op for non-positive values). */
function sleepSync(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.trunc(ms));
}

module.exports = { MAX_DELAY_MS, parseDelayMs, sleepSync };
