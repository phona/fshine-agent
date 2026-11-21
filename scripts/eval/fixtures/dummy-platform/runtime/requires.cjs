'use strict';
/**
 * Declared required inputs on a collection binding (`scenario.json` → `requires`).
 *
 * A collection may declare that a call is only answerable when a named input is
 * carried. If it is missing, the read engine returns the declared `needs_input`
 * response (structured `missing` names, no payload, no state change) instead of a
 * deterministic answer. The caller retries the same task with the input supplied.
 *
 * A required name is satisfied when the call carries it, in any of the forms the
 * declaration surface already supports:
 *   · `--<name> <value>`            (a declared flag, e.g. requires: ["window"])
 *   · `--where <name>=<value>`      (the declared dimension filter)
 *   · `--window`/`--round` <value>  (the same filter's alias, when <name> is the
 *                                    collection's declared dimension name)
 *
 * This module knows only names and flag shapes; it never interprets a value.
 */

function hasValue(value) {
  return value !== undefined && value !== null && value !== '' && value !== true;
}

function flagValue(flags, name) {
  return hasValue(flags[name]) ? flags[name] : flags[`--${name}`];
}

/** `--where <name>=<value>` with a non-empty value on both sides. */
function whereCarries(where, name) {
  if (typeof where !== 'string') return false;
  const separator = where.indexOf('=');
  if (separator <= 0 || separator === where.length - 1) return false;
  return where.slice(0, separator) === name;
}

function missingRequiredInputs(collection, flags) {
  const required = Array.isArray(collection?.requires) ? collection.requires : [];
  if (required.length === 0) return [];
  const where = flagValue(flags, 'where');
  const dimensionName = collection?.dimension?.name;
  const windowAlias = flagValue(flags, 'window') ?? flagValue(flags, 'round');
  const missing = [];
  for (const requiredName of required) {
    if (hasValue(flagValue(flags, requiredName))) continue;
    if (whereCarries(where, requiredName)) continue;
    if (requiredName === dimensionName && hasValue(windowAlias)) continue;
    missing.push(requiredName);
  }
  return missing;
}

module.exports = { missingRequiredInputs };
