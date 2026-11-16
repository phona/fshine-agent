'use strict';
/**
 * Collection keyword resolution. This is a declared lookup mode, not a domain
 * rule: exact key first, then a unique substring hit, then an ambiguous set.
 */

function resolveCollection(collections, keyword) {
  if (typeof keyword !== 'string' || keyword === '') return { kind: 'none' };
  if (Object.prototype.hasOwnProperty.call(collections, keyword)) {
    return { kind: 'exact', name: keyword, collection: collections[keyword] };
  }
  const matches = Object.keys(collections).filter((name) => name.includes(keyword));
  if (matches.length === 1) return { kind: 'unique', name: matches[0], collection: collections[matches[0]] };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'none' };
}

module.exports = { resolveCollection };
