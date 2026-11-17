'use strict';
/**
 * Declared read-fault lookup. A fault is a scenario-level declaration keyed by
 * collection name; the runtime only knows the declared kinds, never the domain.
 */

/** Declared kind → the state field it materialises on the seeded collection. */
const FAULT_STATE_FIELDS = Object.freeze({
  read_fault: 'readFault',
  restricted: 'restricted',
});

const FAULT_KINDS = Object.freeze(Object.keys(FAULT_STATE_FIELDS));

function faultKinds() {
  return [...FAULT_KINDS];
}

function faultFor(faults, collectionName) {
  if (!Array.isArray(faults)) return null;
  return faults.find((fault) => fault.collection === collectionName) ?? null;
}

module.exports = { FAULT_STATE_FIELDS, faultKinds, faultFor };
