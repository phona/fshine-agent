'use strict';
/**
 * Argument validation driven by the declared read contract: per-argument types
 * and requirements (anyOf / allOf groups). One implementation for every
 * declarative read operation — handlers no longer write their own checks.
 */
const { renderTemplate } = require('./template.cjs');
const { makeError } = require('./errors.cjs');

function typeOk(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  throw new Error(`unsupported declared arg type "${type}"`);
}

function declaredError(catalog, declaration, values) {
  const message = typeof declaration.message === 'string'
    ? renderTemplate(declaration.message, values)
    : declaration.message;
  return makeError(catalog, declaration.code, message);
}

function isPresent(value) {
  return value !== undefined && value !== '';
}

function validateReadArgs(read, flags, catalog) {
  for (const declaration of read.args ?? []) {
    const value = flags[declaration.name];
    if (value === undefined) continue;
    if (!typeOk(value, declaration.type)) {
      return { ok: false, error: declaredError(catalog, read.invalidArg, { 'arg.name': declaration.name, 'arg.type': declaration.type }) };
    }
  }
  for (const requirement of read.requirements ?? []) {
    const anyOf = requirement.anyOf ?? [];
    const allOf = requirement.allOf ?? [];
    const satisfied = (anyOf.length > 0 && anyOf.some((key) => isPresent(flags[key])))
      || (allOf.length > 0 && allOf.every((key) => isPresent(flags[key])));
    if (!satisfied) return { ok: false, error: declaredError(catalog, requirement.error, {}) };
  }
  return { ok: true };
}

module.exports = { validateReadArgs };
