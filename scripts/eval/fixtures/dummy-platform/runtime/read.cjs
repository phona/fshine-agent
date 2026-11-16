'use strict';
/**
 * Declarative read engine. Given a declared read contract (args/requirements/
 * source/window/responses), a scenario (collections + faults) and the current
 * seeded state, it returns a mechanical outcome descriptor:
 *
 *   { exitCode, envelope: { status, data, error } | null, result?, refused?, stderr? }
 *
 * It knows only declared mechanics — argument validation, exact-or-unique
 * keyword resolution, declared fault matching, window membership and template
 * rendering. It carries no domain judgement.
 */
const { validateReadArgs } = require('./validate.cjs');
const { resolveCollection } = require('./resolve.cjs');
const { faultFor } = require('./faults.cjs');
const { renderTemplate, renderValue } = require('./template.cjs');
const { makeError } = require('./errors.cjs');

function isPresent(value) {
  return value !== undefined && value !== '';
}

/** CLI flags arrive bare (`collection`); the declaration names them `--collection`. */
function normalizeFlags(read, flags) {
  const out = { ...flags };
  for (const declaration of read.args ?? []) {
    const bare = declaration.name.replace(/^--/, '');
    if (out[declaration.name] === undefined && out[bare] !== undefined) out[declaration.name] = out[bare];
  }
  return out;
}

function pick(keys, flags) {
  for (const key of keys ?? []) {
    if (isPresent(flags[key])) return flags[key];
  }
  return null;
}

function renderError(catalog, declaration, values) {
  const message = typeof declaration.message === 'string'
    ? renderTemplate(declaration.message, values)
    : declaration.message;
  return makeError(catalog, declaration.code, message);
}

function buildResponse(read, name, values, catalog, overrides = {}) {
  const declaration = read.responses[name];
  if (!declaration) throw new Error(`read contract has no "${name}" response`);
  const errorDeclaration = overrides.error ?? declaration.error;
  const data = declaration.data === undefined ? null : renderValue(declaration.data, values);
  const result = declaration.result === undefined ? undefined : renderValue(declaration.result, values);
  return {
    exitCode: overrides.exitCode ?? declaration.exitCode,
    envelope: {
      status: declaration.status,
      data,
      error: errorDeclaration === undefined ? null : renderError(catalog, errorDeclaration, values),
    },
    ...(result === undefined ? {} : { result }),
    ...(overrides.refused === undefined ? {} : { refused: overrides.refused }),
    ...(overrides.stderr === undefined ? {} : { stderr: overrides.stderr }),
  };
}

function executeDeclaredRead(input) {
  const { read, collections, faults, catalog } = input;
  const flags = normalizeFlags(read, input.flags);
  const validation = validateReadArgs(read, flags, catalog);
  if (!validation.ok) {
    return { exitCode: 1, envelope: { status: 'failed', data: null, error: validation.error } };
  }

  const keyword = pick(read.source.keys, flags);
  const values = { 'source.keyword': keyword, 'source.candidates': [] };
  const resolved = resolveCollection(collections, keyword);

  if (resolved.kind === 'ambiguous') {
    values['source.candidates'] = resolved.candidates.map((name) => ({ name }));
    return buildResponse(read, 'ambiguous', values, catalog);
  }
  if (resolved.kind === 'none') {
    return buildResponse(read, 'not_found', values, catalog);
  }

  const canonical = resolved.name;
  const collection = resolved.collection;
  values['source.collection'] = canonical;

  const fault = faultFor(faults, canonical);
  if (fault !== null && fault.kind === 'restricted') {
    return {
      exitCode: fault.exitCode,
      envelope: null,
      refused: fault.refused,
      stderr: `${renderTemplate(fault.stderr, values)}\n`,
    };
  }
  if (fault !== null && fault.kind === 'read_fault') {
    return buildResponse(read, 'read_fault', values, catalog, { error: fault.error, exitCode: fault.exitCode });
  }

  const window = pick(read.window.keys, flags);
  values['window.value'] = window;
  values['window.available'] = collection.windows;
  if (window !== null && !collection.windows.includes(window)) {
    return buildResponse(read, 'window_no_data', values, catalog);
  }

  const items = collection.items;
  values.items = items;
  values.count = items.length;
  values.fields = [...new Set(items.flatMap((item) => Object.keys(item)))];
  return buildResponse(read, 'completed', values, catalog);
}

module.exports = { executeDeclaredRead };
