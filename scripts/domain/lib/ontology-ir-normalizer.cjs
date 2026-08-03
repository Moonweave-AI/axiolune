'use strict';

const { canonicalJcs } = require('./strict-source-locator.cjs');

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function hasPathSuffix(pathSegments, suffix) {
  if (pathSegments.length < suffix.length) return false;
  return suffix.every((segment, index) => (
    pathSegments[pathSegments.length - suffix.length + index] === segment
  ));
}

function scalarKey(value) {
  if (typeof value !== 'string') throw new Error('set member must be a string');
  return value;
}

function fieldKey(field) {
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value[field] !== 'string' || value[field].length === 0) {
      throw new Error(`set member must contain non-empty string ${field}`);
    }
    return value[field];
  };
}

function tupleKey(fields) {
  return (value) => fields.map((field) => fieldKey(field)(value)).join('\0');
}

function canonicalOrFieldKey(field) {
  return (value) => (
    value && typeof value === 'object' && !Array.isArray(value)
      && typeof value[field] === 'string' && value[field].length > 0
      ? value[field]
      : canonicalJcs(value)
  );
}

function constraintUseKey(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.constraintRef === 'string') {
    return `${value.constraintRef}\0${String(value.targetElement || '')}`;
  }
  return canonicalJcs(value);
}

// RFC-001 section 5.1 makes every authoring list set-semantic unless its
// schema explicitly declares an ordered sequence.  Keep this table narrow and
// field-specific: the unique key is part of the normalized-IR contract, not a
// blanket recursive array sort.
const SET_ARRAY_RULES = Object.freeze([
  { id: 'selected-import-symbols', suffix: ['module', 'imports', '[]', 'importedSymbols'], key: fieldKey('symbolIri') },
  { id: 'module-imports', suffix: ['module', 'imports'], key: fieldKey('moduleIri') },
  { id: 'module-exports', suffix: ['module', 'exports'], key: scalarKey },
  { id: 'supertypes', suffix: ['superTypes'], key: scalarKey },
  { id: 'attribute-uses', suffix: ['attributeUses'], key: fieldKey('attribute') },
  { id: 'pattern-bindings', suffix: ['patternBindings'], key: fieldKey('pattern') },
  { id: 'participant-roles', suffix: ['participantRoles'], key: fieldKey('id') },
  { id: 'projected-relations', suffix: ['projectedRelations'], key: scalarKey },
  { id: 'relation-characteristics', suffix: ['characteristics'], key: scalarKey },
  { id: 'external-alignments', suffix: ['alignments'], key: canonicalJcs },
  { id: 'enum-values', suffix: ['enumValues'], key: canonicalJcs },
  { id: 'code-or-enum-values', suffix: ['values'], key: canonicalOrFieldKey('iri') },
  { id: 'relation-uses', suffix: ['domain', 'relationUses'], key: tupleKey(['relation', 'subjectType', 'objectType']) },
  { id: 'constraint-bindings', suffix: ['domain', 'constraintBindings'], key: tupleKey(['constraintRef', 'targetElement']) },
  { id: 'contextual-constraints', suffix: ['constraints'], key: constraintUseKey },
  { id: 'constraint-dependencies', suffix: ['dependencies'], key: scalarKey },
  { id: 'constraint-parameters', suffix: ['parameters'], key: canonicalOrFieldKey('name') },
  { id: 'pattern-applies-to', suffix: ['appliesTo'], key: scalarKey },
  { id: 'pattern-injected-attributes', suffix: ['injectedAttributes'], key: fieldKey('attribute') },
  { id: 'pattern-added-constraints', suffix: ['constraintsAdded'], key: constraintUseKey },
  { id: 'projection-properties', suffix: ['properties'], key: canonicalOrFieldKey('predicateIri') },
  { id: 'builtin-types', suffix: ['builtinTypes'], key: fieldKey('id') },
  { id: 'pattern-definitions', suffix: ['patterns'], key: canonicalOrFieldKey('iri') },
  { id: 'change-links', suffix: ['relatedChanges'], key: scalarKey },
  { id: 'governance-change-history', suffix: ['changeHistory'], key: scalarKey },
]);

const ORDERED_ARRAY_RULES = Object.freeze([
  { id: 'logical-identity-components', suffix: ['logicalComponents'] },
  { id: 'version-identity-components', suffix: ['versionComponents'] },
  { id: 'identity-derivation-inputs', suffix: ['inputSemanticValues'] },
]);

function arraySemanticRule(pathSegments) {
  const ordered = ORDERED_ARRAY_RULES.find((rule) => hasPathSuffix(pathSegments, rule.suffix));
  if (ordered) return { ...ordered, kind: 'ordered' };
  const set = SET_ARRAY_RULES.find((rule) => hasPathSuffix(pathSegments, rule.suffix));
  return set ? { ...set, kind: 'set' } : null;
}

function isSetSemanticArray(pathSegments) {
  return arraySemanticRule(pathSegments)?.kind === 'set';
}

function isOrderedSemanticArray(pathSegments) {
  return arraySemanticRule(pathSegments)?.kind === 'ordered';
}

function normalizeOntologyIr(value, pathSegments = []) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const normalized = value.map((child) => (
      normalizeOntologyIr(child, [...pathSegments, '[]'])
    ));
    const rule = arraySemanticRule(pathSegments);
    if (rule?.kind === 'set') {
      const keyed = normalized.map((entry, index) => {
        let key;
        try {
          key = rule.key(entry);
        } catch (cause) {
          throw new Error(
            `${pathSegments.join('.') || '$'}[${index}] violates ${rule.id}: ${cause.message}`,
          );
        }
        return { entry, key: String(key) };
      });
      const keys = new Set();
      for (const row of keyed) {
        if (keys.has(row.key)) {
          throw new Error(
            `${pathSegments.join('.') || '$'} contains duplicate ${rule.id} key ${row.key}`,
          );
        }
        keys.add(row.key);
      }
      keyed.sort((left, right) => compareUtf8(left.key, right.key));
      return keyed.map((row) => row.entry);
    }
    return normalized;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      normalizeOntologyIr(child, [...pathSegments, key]),
    ]));
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return String(value);
  return value;
}

function selectedImportSymbolIris(imported) {
  if (imported?.importedSymbols === undefined) return [];
  if (!Array.isArray(imported.importedSymbols)) {
    throw new Error('importedSymbols must be an array of SymbolImportSpec records');
  }
  const iris = imported.importedSymbols.map((spec, index) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)
        || typeof spec.symbolIri !== 'string') {
      throw new Error(`importedSymbols[${index}] is not a SymbolImportSpec`);
    }
    return spec.symbolIri;
  });
  if (new Set(iris).size !== iris.length) {
    throw new Error('importedSymbols contains duplicate symbolIri values');
  }
  return iris.sort(compareUtf8);
}

function ontologyImportTuple(row, index = null) {
  const at = index === null ? 'ontology import row' : `ontology imports[${index}]`;
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.importerModuleIri !== 'string'
      || typeof row.importedModuleIri !== 'string') {
    throw new Error(`${at} must contain string importerModuleIri/importedModuleIri`);
  }
  return [row.importerModuleIri, row.importedModuleIri];
}

function compareOntologyImportRows(left, right) {
  const leftTuple = ontologyImportTuple(left);
  const rightTuple = ontologyImportTuple(right);
  return compareUtf8(leftTuple[0], rightTuple[0])
    || compareUtf8(leftTuple[1], rightTuple[1]);
}

function assertOntologyImportRowsSortedUnique(rows) {
  if (!Array.isArray(rows)) throw new Error('ontology imports must be an array');
  let previous = null;
  rows.forEach((row, index) => {
    ontologyImportTuple(row, index);
    if (previous !== null && compareOntologyImportRows(previous, row) >= 0) {
      throw new Error(
        'ontology imports must be strictly '
        + '(importerModuleIri, importedModuleIri)-sorted and unique',
      );
    }
    previous = row;
  });
  return rows;
}

function sortUniqueOntologyImportRows(rows) {
  if (!Array.isArray(rows)) throw new Error('ontology imports must be an array');
  const sorted = [...rows].sort(compareOntologyImportRows);
  assertOntologyImportRowsSortedUnique(sorted);
  return sorted;
}

module.exports = {
  assertOntologyImportRowsSortedUnique,
  compareOntologyImportRows,
  compareUtf8,
  arraySemanticRule,
  isSetSemanticArray,
  isOrderedSemanticArray,
  normalizeOntologyIr,
  selectedImportSymbolIris,
  sortUniqueOntologyImportRows,
};
