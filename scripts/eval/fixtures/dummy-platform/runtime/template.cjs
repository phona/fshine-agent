'use strict';
/**
 * Generic template renderer for declarative read responses.
 *
 * Configuration is pure data: a template is a string whose only dynamic parts are
 * `{{placeholder}}` tokens. The set of placeholders is a closed whitelist supplied
 * as the `values` map of each render call — an unknown token is a configuration
 * error and throws. Nothing here evaluates JavaScript or resolves expressions.
 *
 * A template that is exactly one placeholder yields the raw value (arrays/objects/
 * null keep their type); any other template interpolates with String(value).
 */

const TOKEN = /\{\{([A-Za-z0-9_.]+)\}\}/g;
const WHOLE = /^\{\{([A-Za-z0-9_.]+)\}\}$/;

function lookup(values, name) {
  if (!Object.prototype.hasOwnProperty.call(values, name)) {
    throw new Error(`undeclared template placeholder {{${name}}}`);
  }
  return values[name];
}

function renderTemplate(template, values) {
  if (typeof template !== 'string') throw new Error('template must be a string');
  const whole = WHOLE.exec(template);
  if (whole) return lookup(values, whole[1]);
  return template.replace(TOKEN, (_match, name) => String(lookup(values, name)));
}

/** Render every string leaf of a declared JSON value; keys and types are preserved. */
function renderValue(value, values) {
  if (typeof value === 'string') return renderTemplate(value, values);
  if (Array.isArray(value)) return value.map((entry) => renderValue(entry, values));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = renderValue(entry, values);
    return out;
  }
  return value;
}

/** Placeholder names used anywhere in a string (for load-time config validation). */
function placeholdersOf(value, into = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOKEN)) into.push(match[1]);
  } else if (Array.isArray(value)) {
    for (const entry of value) placeholdersOf(entry, into);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) placeholdersOf(entry, into);
  }
  return into;
}

module.exports = { renderTemplate, renderValue, placeholdersOf };
