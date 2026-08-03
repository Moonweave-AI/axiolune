'use strict';

const EXACT_VERSION_REFERENCE =
  'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const LOGICAL_REFERENCE =
  'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const FACT_VERSION = 'https://axiolune.ai/ontology/meta/data-binding/FactVersion';
const FACT_IDENTITY = 'https://axiolune.ai/ontology/meta/data-binding/FactIdentity';
const VERSION_OF = 'https://axiolune.ai/ontology/meta/data-binding/properties/versionOf';

const REFERENCE_MODES = new Map([
  [EXACT_VERSION_REFERENCE, 'exact'],
  [LOGICAL_REFERENCE, 'logical'],
]);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireIri(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value)) {
    throw new Error(`${label} must be an absolute IRI`);
  }
  return value;
}

function participantRolePredicate(associationIri, roleId) {
  return `${associationIri}/role/${roleId}`;
}

function referenceMode(constraintRef) {
  return REFERENCE_MODES.get(constraintRef) || null;
}

function singleReferenceBinding(candidates, expectedPath, label) {
  const matches = (candidates || []).filter((candidate) => (
    candidate && referenceMode(candidate.constraintRef)
  ));
  if (matches.length !== 1) {
    throw new Error(`${label} must have exactly one ExactVersionReference/LogicalReference binding; found ${matches.length}`);
  }
  if (matches[0].targetElement !== expectedPath) {
    throw new Error(`${label} binding targetElement must equal ${expectedPath}`);
  }
  return matches[0];
}

function compileReferenceBindingIndex(document, sourceLabel = '<module>', typeSystem = undefined) {
  if (typeSystem !== undefined
      && (!typeSystem
        || typeof typeSystem !== 'object'
        || typeof typeSystem.isAbstractType !== 'function'
        || typeof typeSystem.isTypeCompatible !== 'function')) {
    throw new Error(
      `${sourceLabel} typeSystem must provide isAbstractType() and isTypeCompatible()`,
    );
  }
  const domain = requireObject(document?.domain, `${sourceLabel}.domain`);
  const objectTypes = requireObject(
    domain.objectTypes || {},
    `${sourceLabel}.domain.objectTypes`,
  );
  const associations = requireObject(
    domain.associationTypes || {},
    `${sourceLabel}.domain.associationTypes`,
  );
  const typeDefinitions = new Map();
  for (const [kind, definitions] of [
    ['objectTypes', objectTypes],
    ['associationTypes', associations],
  ]) {
    for (const [key, definition] of Object.entries(definitions)) {
      requireObject(definition, `${sourceLabel}.domain.${kind}.${key}`);
      const typeIri = requireIri(definition.iri, `${sourceLabel}.domain.${kind}.${key}.iri`);
      if (typeDefinitions.has(typeIri)) {
        throw new Error(`${sourceLabel} contains duplicate type IRI ${typeIri}`);
      }
      typeDefinitions.set(typeIri, definition);
    }
  }
  const superTypeClosures = new Map();
  function superTypeClosure(typeIri, active = new Set()) {
    if (superTypeClosures.has(typeIri)) return superTypeClosures.get(typeIri);
    if (active.has(typeIri)) {
      throw new Error(`${sourceLabel} contains cyclic type inheritance at ${typeIri}`);
    }
    active.add(typeIri);
    const closure = new Set();
    for (const superType of typeDefinitions.get(typeIri)?.superTypes || []) {
      requireIri(superType, `${typeIri}.superTypes[]`);
      closure.add(superType);
      for (const ancestor of superTypeClosure(superType, active)) closure.add(ancestor);
    }
    active.delete(typeIri);
    superTypeClosures.set(typeIri, closure);
    return closure;
  }
  for (const typeIri of typeDefinitions.keys()) superTypeClosure(typeIri);
  const domainBindings = Array.isArray(domain.constraintBindings)
    ? domain.constraintBindings
    : (() => { throw new Error(`${sourceLabel}.domain.constraintBindings must be an array`); })();
  const relationUses = Array.isArray(domain.relationUses)
    ? domain.relationUses
    : (() => { throw new Error(`${sourceLabel}.domain.relationUses must be an array`); })();
  const rows = [];
  const claimedDomainBindings = new Set();

  for (const [associationKey, association] of Object.entries(associations)) {
    requireObject(association, `${sourceLabel}.domain.associationTypes.${associationKey}`);
    const associationIri = requireIri(
      association.iri,
      `${sourceLabel}.domain.associationTypes.${associationKey}.iri`,
    );
    if (!Array.isArray(association.participantRoles)) {
      throw new Error(`${associationIri}.participantRoles must be an array`);
    }
    for (const role of association.participantRoles) {
      requireObject(role, `${associationIri}.participantRoles[]`);
      if (typeof role.id !== 'string' || role.id.length === 0) {
        throw new Error(`${associationIri}.participantRoles[].id must be a non-empty string`);
      }
      const path = participantRolePredicate(associationIri, role.id);
      const candidates = domainBindings.filter((binding) => binding?.targetElement === path);
      const binding = singleReferenceBinding(candidates, path, path);
      claimedDomainBindings.add(binding);
      rows.push(Object.freeze({
        sourceKind: 'participantRole',
        subjectType: associationIri,
        path,
        expectedType: requireIri(role.range, `${path}.range`),
        constraintRef: binding.constraintRef,
        mode: referenceMode(binding.constraintRef),
      }));
    }
  }

  for (const [index, relationUse] of relationUses.entries()) {
    requireObject(relationUse, `${sourceLabel}.domain.relationUses[${index}]`);
    const path = requireIri(
      relationUse.relation,
      `${sourceLabel}.domain.relationUses[${index}].relation`,
    );
    const binding = singleReferenceBinding(
      relationUse.constraints,
      path,
      `${relationUse.subjectType}.relationUses.${path}`,
    );
    rows.push(Object.freeze({
      sourceKind: 'relationUse',
      subjectType: requireIri(
        relationUse.subjectType,
        `${sourceLabel}.domain.relationUses[${index}].subjectType`,
      ),
      path,
      expectedType: requireIri(
        relationUse.objectType,
        `${sourceLabel}.domain.relationUses[${index}].objectType`,
      ),
      constraintRef: binding.constraintRef,
      mode: referenceMode(binding.constraintRef),
    }));
  }

  const orphanDomainBindings = domainBindings.filter((binding) => (
    binding && referenceMode(binding.constraintRef) && !claimedDomainBindings.has(binding)
  ));
  if (orphanDomainBindings.length > 0) {
    throw new Error(
      `${sourceLabel}.domain.constraintBindings contains ${orphanDomainBindings.length} orphan reference-mode binding(s): ${orphanDomainBindings.map((binding) => binding.targetElement).join(', ')}`,
    );
  }

  const byKey = new Map();
  const byPath = new Map();
  for (const row of rows) {
    const key = `${row.subjectType}\0${row.path}`;
    if (byKey.has(key)) {
      throw new Error(`${sourceLabel} contains duplicate reference binding for ${row.subjectType} ${row.path}`);
    }
    byKey.set(key, row);
    if (!byPath.has(row.path)) byPath.set(row.path, []);
    byPath.get(row.path).push(row);
  }

  return Object.freeze({
    sourceLabel,
    rows: Object.freeze(rows),
    hasPath(path) {
      return byPath.has(path);
    },
    isAbstractType(typeIri) {
      requireIri(typeIri, 'reference type');
      return typeSystem
        ? typeSystem.isAbstractType(typeIri)
        : typeDefinitions.get(typeIri)?.abstract === true;
    },
    isTypeCompatible(concreteType, expectedType) {
      requireIri(concreteType, 'reference concreteType');
      requireIri(expectedType, 'reference expectedType');
      if (typeSystem) return typeSystem.isTypeCompatible(concreteType, expectedType);
      return concreteType === expectedType
        || (superTypeClosures.get(concreteType) || new Set()).has(expectedType);
    },
    resolve(subjectType, path, expectedType) {
      requireIri(subjectType, 'reference subjectType');
      requireIri(path, 'reference path');
      const row = byKey.get(`${subjectType}\0${path}`);
      if (!row) {
        const owners = (byPath.get(path) || []).map((candidate) => candidate.subjectType);
        const detail = owners.length > 0
          ? `; path is bound for ${owners.join(', ')}`
          : '';
        throw new Error(`no reference-mode binding for ${subjectType} ${path}${detail}`);
      }
      if (expectedType !== undefined && row.expectedType !== expectedType) {
        throw new Error(
          `${subjectType} ${path} expected range is ${row.expectedType}, not ${expectedType}`,
        );
      }
      return row;
    },
  });
}

function defaultLogicalIdentityIri(exactIri) {
  requireIri(exactIri, 'exact reference node');
  return `${exactIri}/logical-identity`;
}

function createReferenceIdentityMaterializer(options) {
  const bindingIndex = options?.bindingIndex;
  if (!bindingIndex || typeof bindingIndex.resolve !== 'function') {
    throw new Error('bindingIndex with resolve() is required');
  }
  for (const callback of ['emitIriTriple', 'emitType', 'typesOf', 'iriObjects']) {
    if (typeof options[callback] !== 'function') {
      throw new Error(`${callback} callback is required`);
    }
  }
  const logicalIdentityIri = options.logicalIdentityIri || defaultLogicalIdentityIri;
  const states = new Map();

  function existingTypes(node) {
    return new Set(options.typesOf(node));
  }

  function existingVersionTargets(node) {
    return [...new Set(options.iriObjects(node, VERSION_OF))];
  }

  function registerLogical(node, expectedType) {
    requireIri(node, 'logical reference node');
    const companion = `${expectedType}/LogicalIdentity`;
    const state = states.get(node);
    if (state && (state.mode !== 'logical' || state.expectedType !== expectedType)) {
      throw new Error(
        `${node} cannot be materialized as logical ${expectedType}; it is already ${state.mode} ${state.expectedType}`,
      );
    }
    const types = existingTypes(node);
    const incompatibleTypes = [...types].filter((typeIri) => (
      typeIri !== FACT_IDENTITY && typeIri !== companion
    ));
    if (incompatibleTypes.length > 0) {
      throw new Error(
        `${node} logical reference must not carry FactVersion or authored/non-identity RDF types: ${incompatibleTypes.join(', ')}`,
      );
    }
    const versionTargets = existingVersionTargets(node);
    if (versionTargets.length > 0) {
      throw new Error(`${node} logical reference must not carry versionOf`);
    }
    states.set(node, Object.freeze({ mode: 'logical', expectedType }));
    options.emitType(node, companion);
    options.emitType(node, FACT_IDENTITY);
    return node;
  }

  function registerExact(node, expectedType, requestedLogicalIdentity, concreteType = expectedType) {
    requireIri(node, 'exact reference node');
    requireIri(expectedType, 'exact reference expected type');
    requireIri(concreteType, 'exact reference concrete type');
    if (bindingIndex.isAbstractType?.(concreteType)
        || (typeof bindingIndex.isTypeCompatible === 'function'
          && !bindingIndex.isTypeCompatible(concreteType, expectedType))) {
      throw new Error(
        `${node} exact reference range ${expectedType} requires a concrete compatible type; received ${concreteType}`,
      );
    }
    const identity = requestedLogicalIdentity || logicalIdentityIri(node, concreteType);
    requireIri(identity, 'exact reference logical identity');
    if (identity === node) {
      throw new Error(`${node} exact reference cannot version itself`);
    }
    const state = states.get(node);
    if (state && (state.mode !== 'exact'
        || state.concreteType !== concreteType
        || state.logicalIdentity !== identity)) {
      throw new Error(
        `${node} cannot be materialized as exact ${expectedType}; it is already ${state.mode} ${state.expectedType}`,
      );
    }
    const types = existingTypes(node);
    if (types.has(FACT_IDENTITY)
        || [...types].some((typeIri) => typeIri.endsWith('/LogicalIdentity'))) {
      throw new Error(`${node} exact reference must not carry FactIdentity or a logical-identity companion type`);
    }
    const versionTargets = existingVersionTargets(node);
    if (versionTargets.length > 1
        || (versionTargets.length === 1 && versionTargets[0] !== identity)) {
      throw new Error(`${node} exact reference must have exactly one versionOf target ${identity}`);
    }
    const expectedTypes = state?.expectedTypes || new Set();
    expectedTypes.add(expectedType);
    states.set(node, {
      mode: 'exact',
      expectedType,
      expectedTypes,
      concreteType,
      logicalIdentity: identity,
    });
    options.emitType(node, expectedType);
    options.emitType(node, concreteType);
    options.emitType(node, FACT_VERSION);
    options.emitIriTriple(node, VERSION_OF, identity);
    registerLogical(identity, concreteType);
    return identity;
  }

  return Object.freeze({
    logicalIdentityFor: logicalIdentityIri,
    emit({ subject, subjectType, path, value, expectedType, concreteType, logicalIdentity }) {
      requireIri(subject, 'reference subject');
      requireIri(value, 'reference value');
      const binding = bindingIndex.resolve(subjectType, path, expectedType);
      options.emitIriTriple(subject, path, value);
      if (binding.mode === 'exact') {
        registerExact(value, binding.expectedType, logicalIdentity, concreteType || binding.expectedType);
      } else if (binding.mode === 'logical') {
        if (logicalIdentity !== undefined) {
          throw new Error(`${subjectType} ${path} logical reference cannot declare logicalIdentity`);
        }
        registerLogical(value, binding.expectedType);
      } else {
        throw new Error(`${subjectType} ${path} has unsupported reference mode ${binding.mode}`);
      }
      return binding;
    },
    materializeExactNode({ node, expectedType, concreteType, logicalIdentity }) {
      return registerExact(node, expectedType, logicalIdentity, concreteType || expectedType);
    },
    materializeLogicalNode({ node, expectedType }) {
      return registerLogical(node, expectedType);
    },
    stateOf(node) {
      return states.get(node) || null;
    },
  });
}

module.exports = {
  EXACT_VERSION_REFERENCE,
  FACT_IDENTITY,
  FACT_VERSION,
  LOGICAL_REFERENCE,
  VERSION_OF,
  compileReferenceBindingIndex,
  createReferenceIdentityMaterializer,
  defaultLogicalIdentityIri,
  participantRolePredicate,
  referenceMode,
};
