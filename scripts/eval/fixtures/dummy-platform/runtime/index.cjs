'use strict';
/**
 * Generic declarative-fixture runtime (no domain knowledge).
 * Layer: dummy-platform/runtime — loaders, validation, keyword resolution,
 * closed-whitelist templates, declared faults and error objects.
 */
const { ALLOWED_PLACEHOLDERS, ConfigError, loadPlatform, loadScenario, buildSeedState } = require('./loader.cjs');
const { executeDeclaredRead } = require('./read.cjs');
const { renderTemplate, renderValue } = require('./template.cjs');
const { makeError } = require('./errors.cjs');
const { resolveCollection } = require('./resolve.cjs');
const { faultFor, faultKinds, FAULT_STATE_FIELDS } = require('./faults.cjs');
const { validateReadArgs } = require('./validate.cjs');

module.exports = {
  ALLOWED_PLACEHOLDERS,
  ConfigError,
  loadPlatform,
  loadScenario,
  buildSeedState,
  executeDeclaredRead,
  renderTemplate,
  renderValue,
  makeError,
  resolveCollection,
  faultFor,
  faultKinds,
  FAULT_STATE_FIELDS,
  validateReadArgs,
};
