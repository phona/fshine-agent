'use strict';
/**
 * Generic config loader / validator for the declarative fixture.
 *
 * Three layers are read as pure JSON data — nothing here executes configuration:
 *   platforms/<platformId>/capabilities.json   capability declarations
 *   scenarios/<scenarioId>/scenario.json       collection bindings + faults
 *   scenarios/<scenarioId>/datasets/*.json     items/windows per collection
 *
 * All validation is fail-closed: a malformed file, a declared fault kind the
 * runtime does not implement, or a template placeholder outside the closed
 * whitelist raises `ConfigError` instead of being ignored.
 */
const fs = require('node:fs');
const path = require('node:path');
const { placeholdersOf } = require('./template.cjs');
const { FAULT_STATE_FIELDS, faultKinds } = require('./faults.cjs');

/** Placeholders the read engine supplies; anything else in a template is an error. */
const ALLOWED_PLACEHOLDERS = Object.freeze([
  'source.keyword',
  'source.collection',
  'source.candidates',
  'window.value',
  'window.available',
  'items',
  'count',
  'fields',
  'where.reason',
  'arg.name',
  'arg.type',
]);

const PROTOCOLS = Object.freeze(['proposal.create', 'proposal.commit']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function fail(message) {
  throw new ConfigError(message);
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read config ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`config ${file} is not valid JSON: ${error.message}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectString(value, where) {
  if (typeof value !== 'string' || value === '') fail(`${where} must be a non-empty string`);
  return value;
}

function expectArray(value, where) {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

function checkTemplates(value, where) {
  for (const name of placeholdersOf(value)) {
    if (!ALLOWED_PLACEHOLDERS.includes(name)) fail(`${where}: undeclared template placeholder {{${name}}}`);
  }
}

function validateArgsShape(args, where) {
  if (!isObject(args)) fail(`${where}.args must be an object`);
  expectArray(args.positional ?? [], `${where}.args.positional`);
  expectArray(args.flags ?? [], `${where}.args.flags`);
  for (const flag of args.flags ?? []) {
    expectString(flag.flag, `${where}.args.flags[].flag`);
    if (typeof flag.required !== 'boolean') fail(`${where}.args.flags[${flag.flag}].required must be boolean`);
  }
  for (const positional of args.positional ?? []) {
    expectString(positional.name, `${where}.args.positional[].name`);
    if (typeof positional.required !== 'boolean') fail(`${where}.args.positional[${positional.name}].required must be boolean`);
  }
}

function validateOperations(operations, accessSemantics) {
  expectArray(operations, 'capabilities.operations');
  if (operations.length === 0) fail('capabilities.operations must not be empty');
  const seen = new Set();
  for (const operation of operations) {
    const where = `capabilities.operations[${operation && operation.name}]`;
    expectString(operation?.name, 'capabilities.operations[].name');
    if (seen.has(operation.name)) fail(`duplicate operation name ${operation.name}`);
    seen.add(operation.name);
    expectString(operation.access, `${where}.access`);
    if (!isObject(accessSemantics) || !isObject(accessSemantics[operation.access])) fail(`${where}.access "${operation.access}" is undeclared in accessSemantics`);
    validateArgsShape(operation.args ?? {}, where);
    if (!isObject(operation.serve)) fail(`${where}.serve must be an object`);
    for (const mode of ['query', 'prepare', 'commit']) {
      if (typeof operation.serve[mode] !== 'boolean') fail(`${where}.serve.${mode} must be boolean`);
    }
    if (operation.protocol !== null && operation.protocol !== undefined && !PROTOCOLS.includes(operation.protocol)) {
      fail(`${where}.protocol "${operation.protocol}" is undeclared`);
    }
  }
  return operations;
}

function validateReadDeclarations(reads, operations) {
  if (!isObject(reads)) fail('capabilities.reads must be an object');
  const byName = new Map(operations.map((operation) => [operation.name, operation]));
  for (const [name, read] of Object.entries(reads)) {
    const where = `capabilities.reads[${name}]`;
    const operation = byName.get(name);
    if (!operation) fail(`${where} names an unregistered operation`);
    if (operation.access !== 'read') fail(`${where} must name a read-only operation (access is "${operation.access}")`);
    for (const declaration of expectArray(read.args ?? [], `${where}.args`)) {
      expectString(declaration.name, `${where}.args[].name`);
      expectString(declaration.type, `${where}.args[${declaration.name}].type`);
      if (!['string', 'number', 'boolean'].includes(declaration.type)) fail(`${where}.args[${declaration.name}].type "${declaration.type}" is unsupported`);
    }
    for (const requirement of expectArray(read.requirements ?? [], `${where}.requirements`)) {
      const anyOf = requirement.anyOf ?? [];
      const allOf = requirement.allOf ?? [];
      if (!Array.isArray(anyOf) || !Array.isArray(allOf)) fail(`${where}.requirements[] groups must be arrays`);
      if (anyOf.length === 0 && allOf.length === 0) fail(`${where}.requirements[] needs anyOf or allOf`);
      for (const key of [...anyOf, ...allOf]) expectString(key, `${where}.requirements[] key`);
      if (!isObject(requirement.error)) fail(`${where}.requirements[].error must be an object`);
      expectString(requirement.error.code, `${where}.requirements[].error.code`);
      expectString(requirement.error.message, `${where}.requirements[].error.message`);
      checkTemplates(requirement.error, `${where}.requirements[].error`);
    }
    if (!isObject(read.invalidArg)) fail(`${where}.invalidArg must be an object`);
    expectString(read.invalidArg.code, `${where}.invalidArg.code`);
    expectString(read.invalidArg.message, `${where}.invalidArg.message`);
    checkTemplates(read.invalidArg, `${where}.invalidArg`);
    if (!isObject(read.source)) fail(`${where}.source must be an object`);
    const sourceKeys = expectArray(read.source.keys, `${where}.source.keys`);
    if (sourceKeys.length === 0) fail(`${where}.source.keys must not be empty`);
    for (const key of sourceKeys) expectString(key, `${where}.source.keys[]`);
    if (read.source.mode !== 'exact-or-unique-substring') fail(`${where}.source.mode "${read.source.mode}" is unsupported`);
    if (!isObject(read.window)) fail(`${where}.window must be an object`);
    for (const key of expectArray(read.window.keys ?? [], `${where}.window.keys`)) expectString(key, `${where}.window.keys[]`);
    if (!isObject(read.responses)) fail(`${where}.responses must be an object`);
    for (const [responseName, response] of Object.entries(read.responses)) {
      const at = `${where}.responses[${responseName}]`;
      if (!isObject(response)) fail(`${at} must be an object`);
      expectString(response.status, `${at}.status`);
      if (!Number.isInteger(response.exitCode) || response.exitCode < 0) fail(`${at}.exitCode must be a non-negative integer`);
      if (response.error !== undefined) {
        if (!isObject(response.error)) fail(`${at}.error must be an object`);
        expectString(response.error.code, `${at}.error.code`);
        expectString(response.error.message, `${at}.error.message`);
      }
      checkTemplates(response, at);
    }
    for (const requiredResponse of ['completed', 'ambiguous', 'not_found', 'window_no_data', 'read_fault']) {
      if (!isObject(read.responses[requiredResponse])) fail(`${where}.responses.${requiredResponse} is required`);
    }
  }
  return reads;
}

function loadPlatform(options) {
  const fixturesRoot = expectString(options?.fixturesRoot, 'fixturesRoot');
  const platformId = expectString(options?.platformId, 'platformId');
  const file = path.join(fixturesRoot, 'platforms', platformId, 'capabilities.json');
  const raw = readJson(file);
  if (!isObject(raw)) fail(`platform config ${file} must be an object`);
  if (raw.schemaVersion !== 1) fail(`platform config ${file}: unsupported schemaVersion ${raw.schemaVersion}`);
  const accessSemantics = raw.accessSemantics;
  if (!isObject(accessSemantics)) fail('capabilities.accessSemantics must be an object');
  const operations = validateOperations(raw.operations, accessSemantics);
  const reads = validateReadDeclarations(raw.reads ?? {}, operations);
  for (const [name, label] of Object.entries(raw.labels ?? {})) expectString(label, `capabilities.labels[${name}]`);
  const errorCatalog = raw.errorCatalog ?? {};
  if (!isObject(errorCatalog)) fail('capabilities.errorCatalog must be an object');
  const scenarioId = expectString(raw.scenario, 'capabilities.scenario');
  return { file, platformId, scenarioId, operations, labels: raw.labels ?? {}, accessSemantics, errorCatalog, reads };
}

function validateDataset(file) {
  const dataset = readJson(file);
  if (!isObject(dataset)) fail(`dataset ${file} must be an object`);
  expectArray(dataset.items, `dataset ${file}: items`);
  for (const item of dataset.items) {
    if (!isObject(item)) fail(`dataset ${file}: every item must be an object`);
  }
  for (const window of expectArray(dataset.windows, `dataset ${file}: windows`)) expectString(window, `dataset ${file}: window`);
  return dataset;
}

function loadScenario(options) {
  const fixturesRoot = expectString(options?.fixturesRoot, 'fixturesRoot');
  const scenarioId = expectString(options?.scenarioId, 'scenarioId');
  const dir = path.join(fixturesRoot, 'scenarios', scenarioId);
  const file = path.join(dir, 'scenario.json');
  const raw = readJson(file);
  if (!isObject(raw)) fail(`scenario ${file} must be an object`);
  if (raw.schemaVersion !== 1) fail(`scenario ${file}: unsupported schemaVersion ${raw.schemaVersion}`);
  if (raw.scenario !== scenarioId) fail(`scenario ${file}: scenario id "${raw.scenario}" does not match directory "${scenarioId}"`);
  const bindings = expectArray(raw.collections, `scenario ${file}: collections`);
  if (bindings.length === 0) fail(`scenario ${file}: collections must not be empty`);
  const faults = expectArray(raw.faults ?? [], `scenario ${file}: faults`);
  const faultCollections = new Set();
  for (const fault of faults) {
    if (!isObject(fault)) fail(`scenario ${file}: every fault must be an object`);
    expectString(fault.collection, `scenario ${file}: fault.collection`);
    if (faultCollections.has(fault.collection)) fail(`scenario ${file}: duplicate fault for ${fault.collection}`);
    faultCollections.add(fault.collection);
    if (!faultKinds().includes(fault.kind)) fail(`scenario ${file}: fault kind "${fault.kind}" is undeclared`);
    if (!Number.isInteger(fault.exitCode) || fault.exitCode < 0) fail(`scenario ${file}: fault(${fault.collection}).exitCode must be a non-negative integer`);
    if (fault.kind === 'read_fault') {
      if (!isObject(fault.error)) fail(`scenario ${file}: fault(${fault.collection}).error must be an object`);
      expectString(fault.error.code, `scenario ${file}: fault(${fault.collection}).error.code`);
      expectString(fault.error.message, `scenario ${file}: fault(${fault.collection}).error.message`);
      checkTemplates(fault.error, `scenario ${file}: fault(${fault.collection}).error`);
    }
    if (fault.kind === 'restricted') {
      expectString(fault.stderr, `scenario ${file}: fault(${fault.collection}).stderr`);
      checkTemplates(fault.stderr, `scenario ${file}: fault(${fault.collection}).stderr`);
      expectString(fault.refused, `scenario ${file}: fault(${fault.collection}).refused`);
    }
  }

  const collections = {};
  const names = new Set();
  for (const binding of bindings) {
    if (!isObject(binding)) fail(`scenario ${file}: every collection binding must be an object`);
    const name = expectString(binding.collection, `scenario ${file}: collection`);
    if (RESERVED.has(name)) fail(`scenario ${file}: collection name "${name}" is reserved`);
    if (names.has(name)) fail(`scenario ${file}: duplicate collection ${name}`);
    names.add(name);
    const datasetFile = path.join(dir, expectString(binding.dataset, `scenario ${file}: collection(${name}).dataset`));
    const dataset = validateDataset(datasetFile);
    if (binding.locked !== undefined && typeof binding.locked !== 'boolean') fail(`scenario ${file}: collection(${name}).locked must be boolean`);
    if (binding.records !== undefined && !isObject(binding.records)) fail(`scenario ${file}: collection(${name}).records must be an object`);
    for (const [window, count] of Object.entries(binding.records ?? {})) {
      if (!Number.isInteger(count) || count < 0) fail(`scenario ${file}: collection(${name}).records[${window}] must be a non-negative integer`);
    }
    // Optional single dimension: `{ name, values }`. It only declares a filterable
    // field; the runtime never interprets the name or the values (pure data).
    let dimension = null;
    if (binding.dimension !== undefined) {
      const at = `scenario ${file}: collection(${name}).dimension`;
      if (!isObject(binding.dimension)) fail(`${at} must be an object`);
      const dimensionName = expectString(binding.dimension.name, `${at}.name`);
      const dimensionValues = expectArray(binding.dimension.values, `${at}.values`);
      if (dimensionValues.length === 0) fail(`${at}.values must not be empty`);
      const declared = new Set();
      for (const value of dimensionValues) {
        expectString(value, `${at}.values[]`);
        if (declared.has(value)) fail(`${at}.values has duplicate "${value}"`);
        declared.add(value);
      }
      for (const item of dataset.items) {
        if (!Object.prototype.hasOwnProperty.call(item, dimensionName)) {
          fail(`dataset ${datasetFile}: every item must carry dimension field "${dimensionName}"`);
        }
        if (!declared.has(item[dimensionName])) {
          fail(`dataset ${datasetFile}: "${dimensionName}" value ${JSON.stringify(item[dimensionName])} is not declared in ${at}.values`);
        }
      }
      dimension = { name: dimensionName, values: [...dimensionValues] };
    }
    const collection = {
      items: dataset.items,
      windows: dataset.windows,
      locked: binding.locked === true,
      records: { ...(binding.records ?? {}) },
      ...(dimension === null ? {} : { dimension }),
    };
    for (const fault of faults) {
      if (fault.collection !== name) continue;
      const field = FAULT_STATE_FIELDS[fault.kind];
      if (field !== undefined) collection[field] = true;
    }
    collections[name] = collection;
  }
  for (const fault of faults) {
    if (!names.has(fault.collection)) fail(`scenario ${file}: fault names undeclared collection ${fault.collection}`);
  }
  return { id: scenarioId, file, dir, collections, faults };
}

/** Seed state is a deep copy so a handler mutating it can never poison a later call. */
function buildSeedState(scenario) {
  return { collections: JSON.parse(JSON.stringify(scenario.collections)) };
}

module.exports = {
  ALLOWED_PLACEHOLDERS,
  ConfigError,
  loadPlatform,
  loadScenario,
  buildSeedState,
};
