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
const { missingRequiredInputs } = require('./requires.cjs');
const { sleepSync } = require('./timing.cjs');

function isPresent(value) {
  return value !== undefined && value !== '';
}

/** The single filter flag is `--where`; parsing below accepts nothing else. */
function readWhere(flags) {
  for (const key of ['--where', 'where']) {
    if (isPresent(flags[key])) return flags[key];
  }
  return null;
}

function declaredValues(dimension) {
  return dimension.values.map((value) => `"${value}"`).join(', ');
}

function complete(read, items, values, catalog) {
  values.items = items;
  values.count = items.length;
  values.fields = [...new Set(items.flatMap((item) => Object.keys(item)))];
  return buildResponse(read, 'completed', values, catalog);
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
      // Structured "what is missing" names travel at the envelope top level (needs_input
      // only); the contract's adapter projects them, the host never re-derives them.
      ...(overrides.missing === undefined ? {} : { missing: overrides.missing }),
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

  // Declared required inputs come first: an incomplete request is not answered (and
  // never judged by a fault). The response carries the structured names, not prose.
  const missing = missingRequiredInputs(collection, flags);
  if (missing.length > 0) {
    values['needs.missing'] = missing;
    return buildResponse(read, 'missing_input', values, catalog, { missing });
  }

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
  if (fault !== null && fault.kind === 'slow_fault') {
    // Really takes the declared time, then fails with the existing structured envelope.
    sleepSync(fault.delayMs);
    return buildResponse(read, 'read_fault', values, catalog, { error: fault.error, exitCode: fault.exitCode });
  }

  const dimension = collection.dimension ?? null;
  const window = pick(read.window.keys, flags);
  const where = readWhere(flags);
  values['window.value'] = window;
  values['window.available'] = collection.windows;
  values['where.reason'] = '';

  if (dimension === null) {
    // No declared dimension: keep the historical window-membership semantics exactly.
    if (where !== null) {
      values['where.reason'] = 'collection declares no dimension; --where is not supported for it';
      return buildResponse(read, 'invalid_where', values, catalog);
    }
    if (window !== null && !collection.windows.includes(window)) {
      return buildResponse(read, 'window_no_data', values, catalog);
    }
    return complete(read, collection.items, values, catalog);
  }

  // Declared dimension: `--where <name>=<value>` is the filter; `--window` stays as
  // an alias mapped onto the same dimension. One pair only — no expressions.
  let filterValue = null;
  if (where !== null && window !== null) {
    values['where.reason'] = 'provide only one of --where or --window';
    return buildResponse(read, 'invalid_where', values, catalog);
  }
  if (where !== null) {
    if (typeof where !== 'string') {
      values['where.reason'] = 'expected --where <dimension>=<value>';
      return buildResponse(read, 'invalid_where', values, catalog);
    }
    const separator = where.indexOf('=');
    if (separator <= 0 || separator === where.length - 1) {
      values['where.reason'] = 'expected a single <dimension>=<value> pair';
      return buildResponse(read, 'invalid_where', values, catalog);
    }
    const filterName = where.slice(0, separator);
    const candidate = where.slice(separator + 1);
    if (filterName !== dimension.name) {
      values['where.reason'] = `unknown dimension "${filterName}" (declared dimension is "${dimension.name}")`;
      return buildResponse(read, 'invalid_where', values, catalog);
    }
    if (!dimension.values.includes(candidate)) {
      values['where.reason'] = `value "${candidate}" is not one of ${declaredValues(dimension)}`;
      return buildResponse(read, 'invalid_where', values, catalog);
    }
    filterValue = candidate;
  } else if (window !== null) {
    if (typeof window !== 'string' || !dimension.values.includes(window)) {
      values['where.reason'] = `value "${String(window)}" is not one of ${declaredValues(dimension)}`;
      return buildResponse(read, 'invalid_where', values, catalog);
    }
    filterValue = window;
  }

  const items = filterValue === null
    ? collection.items
    : collection.items.filter((item) => item[dimension.name] === filterValue);
  return complete(read, items, values, catalog);
}

module.exports = { executeDeclaredRead };
