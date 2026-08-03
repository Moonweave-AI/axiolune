#!/usr/bin/env node
'use strict';

/**
 * One-way authoring migration from the rejected flat v0.2 dialect to the
 * RFC-001 v0.3 typed-container dialect.
 *
 * Default mode is read-only and prints the planned classifier counts. Pass
 * --write to replace module.yaml files. The migration is deliberately strict:
 * an unclassified element or an unknown legacy extension aborts the entire
 * run before the first write.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  IDENTIFIER_PROFILES,
} = require('./lib/foundation-identifier-contract.cjs');

const ROOT = path.join(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const WRITE = process.argv.includes('--write');

const CONTAINERS = [
  'objectTypes',
  'associationTypes',
  'relationTypes',
  'attributeTypes',
  'identifierTypes',
  'codeLists',
  'constraints',
];

const DOMAIN_KEYS = new Set([...CONTAINERS, 'relationUses', 'constraintBindings']);
const TEMPORAL_FACT = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCED_FACT = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const MONEY = 'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount';
const QUANTITY = 'https://axiolune.ai/ontology/meta/core/values/QuantityValue';
const LEGACY_MONEY = 'https://axiolune.ai/ontology/finance/foundation/MonetaryAmount';
const LEGACY_QUANTITY = 'https://axiolune.ai/ontology/finance/foundation/QuantityValue';
const LOGICAL_REFERENCE = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const EXACT_VERSION_REFERENCE = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

/*
 * This table is intentionally empty until the file-level reference review has
 * proved that one locked artifact contains the complete effective value set.
 * A broad project/FIBO bundle is not automatically the authority for every
 * local enumeration.  The migration therefore emits an explicit unresolved
 * IRI, which the strict validator rejects, instead of laundering partial
 * implementation evidence into an apparently closed source claim.
 */
const EXACT_CODE_LIST_EVIDENCE = {};

const ALLOWED = {
  objectTypes: new Set([
    'iri', 'namespace', 'localName', 'label', 'definition',
    'superTypes', 'attributeUses', 'patternBindings', 'relationUses', 'alignments', 'governance', 'note',
  ]),
  associationTypes: new Set([
    'iri', 'namespace', 'localName', 'label', 'definition',
    'participantRoles', 'attributeUses', 'patternBindings', 'projectedRelations', 'alignments', 'note',
  ]),
  relationTypes: new Set([
    'iri', 'namespace', 'localName', 'label', 'definition',
    'domain', 'range', 'inverseOf', 'characteristics', 'alignments', 'note',
  ]),
  attributeTypes: new Set([
    'iri', 'namespace', 'localName', 'label', 'definition', 'valueType',
    'owlProjectionOverride', 'defaultCardinality', 'enumValues', 'pattern', 'unit',
    'alignments', 'codeListReference', 'note',
  ]),
  identifierTypes: new Set([
    'iri', 'namespace', 'localName', 'label', 'definition',
    'pattern', 'checkAlgorithm', 'length', 'alignments', 'note',
  ]),
  codeLists: new Set([
    'iri', 'namespace', 'localName', 'label', 'definition',
    'vocabulary', 'version', 'maintainer', 'sourceEvidenceRef',
    'values', 'alignments', 'note',
  ]),
};

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classify(element) {
  const candidates = [];
  if (Array.isArray(element.participantRoles)) candidates.push('associationTypes');
  if (Object.prototype.hasOwnProperty.call(element, 'valueType')) candidates.push('attributeTypes');
  if (Array.isArray(element.values)) candidates.push('codeLists');
  if (
    (Object.prototype.hasOwnProperty.call(element, 'domain')
      || Object.prototype.hasOwnProperty.call(element, 'range'))
    && !Array.isArray(element.participantRoles)
    && !Object.prototype.hasOwnProperty.call(element, 'valueType')
  ) candidates.push('relationTypes');
  if (
    Object.prototype.hasOwnProperty.call(element, 'pattern')
    && !Object.prototype.hasOwnProperty.call(element, 'valueType')
    && !Array.isArray(element.values)
    && !Array.isArray(element.superTypes)
    && !Array.isArray(element.attributeUses)
  ) candidates.push('identifierTypes');
  if (
    candidates.length === 0
    && (Array.isArray(element.superTypes) || Array.isArray(element.attributeUses))
  ) candidates.push('objectTypes');
  return candidates;
}

function mergeNote(definition, note) {
  if (!note) return definition;
  const left = String(definition || '').trim();
  const right = String(note).trim();
  return `${left}${/[.!?。！？]$/.test(left) ? '' : '.'} ${right}`.trim();
}

function normalizeAlignment(alignment) {
  const result = {
    vocabulary: alignment.vocabulary,
    targetIri: alignment.targetIri,
    relation: alignment.relation,
  };
  if (alignment.sourceRelease) {
    result.sourceRelease = {
      vocabulary: alignment.sourceRelease.vocabulary,
      release: alignment.sourceRelease.release,
      artifactDigest: alignment.sourceRelease.artifactDigest,
    };
  }
  if (alignment.sourceLocator) result.sourceLocator = alignment.sourceLocator;
  if (alignment.rationale) result.rationale = alignment.rationale;
  if (alignment.verification) result.verification = alignment.verification;
  return result;
}

function commonFields(element) {
  return {
    iri: element.iri,
    namespace: element.namespace,
    localName: element.localName,
    label: element.label,
    definition: mergeNote(element.definition, element.note),
  };
}

function normalizeAttributeUse(value) {
  const result = { attribute: value.attribute };
  for (const key of ['minCount', 'maxCount', 'label', 'defaultValue', 'constraints']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  }
  return result;
}

function normalizePatternBindings(bindings) {
  const result = [];
  const seen = new Set();
  for (const binding of (bindings || [])) {
    if (plainObject(binding)) {
      const unknown = Object.keys(binding)
        .filter((key) => !['pattern', 'parameters', 'rationale'].includes(key));
      if (unknown.length > 0) {
        throw new Error(`unsupported legacy PatternBinding fields ${unknown.join(',')}`);
      }
    }
    const normalized = typeof binding === 'string'
      ? { pattern: binding }
      : {
        pattern: binding.pattern,
        ...(binding.parameters !== undefined ? { parameters: binding.parameters } : {}),
      };
    if (!normalized.pattern || seen.has(normalized.pattern)) continue;
    seen.add(normalized.pattern);
    result.push(normalized);
  }
  return result;
}

function normalizeElement(container, element, moduleName, codeListIris, generatedConstraints) {
  for (const key of Object.keys(element)) {
    if (!ALLOWED[container].has(key)) {
      throw new Error(`${moduleName}/${element.localName}: unsupported legacy field ${key}`);
    }
  }

  const result = commonFields(element);
  if (Array.isArray(element.alignments)) result.alignments = element.alignments.map(normalizeAlignment);
  const bindingRationales = (element.patternBindings || [])
    .filter((binding) => plainObject(binding) && binding.rationale)
    .map((binding) => `${binding.pattern}: ${binding.rationale}`);
  if (bindingRationales.length > 0) {
    result.definition = mergeNote(
      result.definition,
      `Pattern applicability rationale — ${bindingRationales.join('; ')}`,
    );
  }

  if (container === 'objectTypes') {
    if (Array.isArray(element.superTypes)) result.superTypes = [...element.superTypes];
    if (Array.isArray(element.attributeUses)) result.attributeUses = element.attributeUses.map(normalizeAttributeUse);
    if (Array.isArray(element.patternBindings)) result.patternBindings = normalizePatternBindings(element.patternBindings);
    if (element.governance) result.governance = { ...element.governance };
  } else if (container === 'associationTypes') {
    result.participantRoles = element.participantRoles.map((role) => {
      const roleResult = {
        id: role.id || role.roleName,
        range: role.range,
        minCount: role.minCount,
        maxCount: role.maxCount,
      };
      if (role.label) roleResult.label = role.label;
      if (role.definition || role.note) roleResult.definition = mergeNote(role.definition || '', role.note);
      const unknown = Object.keys(role).filter((key) =>
        !['id', 'roleName', 'roleIri', 'range', 'minCount', 'maxCount', 'label', 'definition', 'note', 'referenceMode'].includes(key)
      );
      if (unknown.length) throw new Error(`${moduleName}/${element.localName}/${role.id || role.roleName}: unsupported role fields ${unknown.join(',')}`);
      return roleResult;
    });
    if (Array.isArray(element.attributeUses)) result.attributeUses = element.attributeUses.map(normalizeAttributeUse);
    if (Array.isArray(element.patternBindings)) result.patternBindings = normalizePatternBindings(element.patternBindings);
    if (Array.isArray(element.projectedRelations)) result.projectedRelations = [...element.projectedRelations];
  } else if (container === 'relationTypes') {
    result.domain = element.domain;
    result.range = element.range;
    if (element.inverseOf) result.inverseOf = element.inverseOf;
    if (Array.isArray(element.characteristics)) result.characteristics = [...element.characteristics];
  } else if (container === 'attributeTypes') {
    if (element.codeListReference) {
      const target = codeListIris.get(`${moduleName}:${element.codeListReference}`);
      if (!target) throw new Error(`${moduleName}/${element.localName}: unresolved local code list ${element.codeListReference}`);
      result.valueType = target;
    } else if (element.valueType === LEGACY_MONEY) {
      result.valueType = MONEY;
    } else if (element.valueType === LEGACY_QUANTITY) {
      result.valueType = QUANTITY;
    } else {
      result.valueType = element.valueType;
    }
    for (const key of ['owlProjectionOverride', 'defaultCardinality', 'enumValues', 'pattern', 'unit']) {
      if (Object.prototype.hasOwnProperty.call(element, key)) result[key] = element[key];
    }
  } else if (container === 'identifierTypes') {
    const profile = IDENTIFIER_PROFILES[element.localName];
    if (!profile) throw new Error(`${moduleName}/${element.localName}: no reviewed identifier profile`);
    const constraintLocalName = `${element.localName}Validation`;
    const constraintIri = `${element.iri.slice(0, element.iri.lastIndexOf('/') + 1)}${constraintLocalName}`;
    if (profile.definition) result.definition = profile.definition;
    result.baseType = 'string';
    result.standard = profile.standard;
    result.validatorRef = constraintIri;
    result.issuingAuthority = profile.authority;
    generatedConstraints[constraintLocalName] = {
      iri: constraintIri,
      namespace: element.namespace,
      localName: constraintLocalName,
      label: `${element.label} Validation`,
      definition: `identifier validation rule that enforces the reviewed lexical and check algorithm profile for ${element.label}`,
      constraintType: 'Custom',
      scope: 'Identifier',
      expression: {
        language: 'Custom',
        expression: [
          `profile=${element.localName}`,
          `pattern=${element.pattern || ''}`,
          `length=${element.length ?? ''}`,
          `algorithm=${element.checkAlgorithm || 'none'}`,
        ].join(';'),
      },
      severity: 'Error',
      message: `${element.localName} value does not satisfy its reviewed identifier profile`,
      targetElement: element.iri,
    };
  } else if (container === 'codeLists') {
    const referenceId = EXACT_CODE_LIST_EVIDENCE[`${moduleName}/${element.localName}`];
    result.vocabulary = element.label;
    result.version = '0.3.0';
    result.maintainer = 'Axiolune ontology maintainers';
    result.sourceEvidenceRef = referenceId
      ? `https://axiolune.ai/references/${referenceId}`
      : `https://axiolune.ai/pending-source-evidence/${encodeURIComponent(moduleName)}/${encodeURIComponent(element.localName)}`;
    result.values = element.values.map((value) => {
      const notation = plainObject(value) ? value.notation : String(value);
      if (!notation) throw new Error(`${moduleName}/${element.localName}: empty code notation`);
      const encoded = encodeURIComponent(notation.normalize('NFC'));
      return {
        iri: plainObject(value) && value.iri ? value.iri : `${element.iri}/${encoded}`,
        notation,
        label: plainObject(value) && value.label ? value.label : notation,
        definition: plainObject(value) && value.definition
          ? value.definition
          : `code value that denotes ${notation} within ${element.label} version 0.3.0`,
        ...(plainObject(value) && value.deprecated !== undefined ? { deprecated: value.deprecated } : {}),
        ...(plainObject(value) && value.replacedBy ? { replacedBy: value.replacedBy } : {}),
      };
    });
  }
  return result;
}

function buildCodeListIndex(docs) {
  const index = new Map();
  for (const [moduleName, doc] of docs) {
    if (Object.keys(doc.domain || {}).some((key) => DOMAIN_KEYS.has(key))) continue;
    for (const [localName, element] of Object.entries(doc.domain || {})) {
      if (Array.isArray(element && element.values)) index.set(`${moduleName}:${localName}`, element.iri);
    }
  }
  return index;
}

function migrate(moduleName, doc, codeListIris) {
  if (!plainObject(doc) || !plainObject(doc.module) || !plainObject(doc.domain)) {
    throw new Error(`${moduleName}: expected module and domain objects`);
  }
  if (Object.keys(doc.domain).some((key) => DOMAIN_KEYS.has(key))) {
    throw new Error(`${moduleName}: already uses typed containers`);
  }

  const output = {
    module: {
      ...doc.module,
      version: '0.3.0',
      imports: (doc.module.imports || []).map((entry) => ({
        ...entry,
        version: '0.3.0',
      })),
      exports: (doc.module.exports || []).filter((exportedIri) => ![
        LEGACY_MONEY,
        LEGACY_QUANTITY,
        'https://axiolune.ai/ontology/finance/foundation/hasNumericAmount',
        'https://axiolune.ai/ontology/finance/foundation/hasScale',
        'https://axiolune.ai/ontology/finance/foundation/hasUnitCode',
      ].includes(exportedIri)),
      status: 'draft',
      governance: {
        ownerRef: 'urn:axiolune:principal:repository-owner',
        status: 'draft',
      },
    },
    domain: Object.fromEntries(CONTAINERS.map((name) => [name, {}])),
  };
  output.domain.relationUses = [];
  output.domain.constraintBindings = [];

  const generatedConstraints = {};
  const contextualRelationUses = [];
  const roleReferenceModes = [];
  for (const [localName, element] of Object.entries(doc.domain)) {
    const candidates = classify(element);
    if (candidates.length !== 1) {
      throw new Error(`${moduleName}/${localName}: expected one classifier, got ${candidates.join(',') || 'none'}`);
    }
    const container = candidates[0];
    if (container === 'objectTypes' && Array.isArray(element.relationUses)) {
      for (const use of element.relationUses) contextualRelationUses.push({ containingType: element.iri, ...use });
    }
    if (container === 'associationTypes') {
      for (const role of (element.participantRoles || [])) {
        if (!role.referenceMode) continue;
        const roleId = role.id || role.roleName;
        roleReferenceModes.push({
          associationIri: element.iri,
          roleId,
          referenceMode: role.referenceMode,
        });
      }
    }
    if (
      moduleName === 'foundation'
      && container === 'objectTypes'
      && ['MonetaryAmount', 'QuantityValue'].includes(localName)
    ) continue;
    if (
      moduleName === 'foundation'
      && container === 'attributeTypes'
      && ['hasNumericAmount', 'hasScale', 'hasUnitCode'].includes(localName)
    ) continue;
    output.domain[container][localName] = normalizeElement(
      container,
      element,
      moduleName,
      codeListIris,
      generatedConstraints,
    );
  }
  Object.assign(output.domain.constraints, generatedConstraints);
  for (const role of roleReferenceModes) {
    if (!['logical', 'version'].includes(role.referenceMode)) {
      throw new Error(`${moduleName}: invalid role referenceMode ${role.referenceMode}`);
    }
    output.domain.constraintBindings.push({
      constraintRef: role.referenceMode === 'logical' ? LOGICAL_REFERENCE : EXACT_VERSION_REFERENCE,
      targetElement: `${role.associationIri}/role/${role.roleId}`,
      enforcementLevel: 'Mandatory',
    });
  }

  const contextualKeys = new Set(
    contextualRelationUses.map((use) => `${use.relation}\0${use.containingType}`),
  );
  for (const relation of Object.values(output.domain.relationTypes)) {
    if (contextualKeys.has(`${relation.iri}\0${relation.domain}`)) continue;
    const use = {
      relation: relation.iri,
      subjectType: relation.domain,
      objectType: relation.range,
    };
    if ((relation.characteristics || []).includes('functional')) {
      use.outboundCardinality = {
        minCount: relation.localName === 'listingQuoteCurrency' ? 1 : 0,
        maxCount: 1,
      };
    }
    if (relation.localName === 'listingQuoteCurrency') {
      use.constraints = [{
        constraintRef: LOGICAL_REFERENCE,
        targetElement: relation.iri,
      }];
    }
    output.domain.relationUses.push(use);
  }

  const relationByIri = new Map(Object.values(output.domain.relationTypes).map((relation) => [relation.iri, relation]));
  for (const legacyUse of contextualRelationUses) {
    const relation = relationByIri.get(legacyUse.relation);
    if (!relation) throw new Error(`${moduleName}: contextual relation use references unknown relation ${legacyUse.relation}`);
    const use = {
      relation: relation.iri,
      subjectType: legacyUse.containingType,
      objectType: relation.range,
      outboundCardinality: {
        minCount: legacyUse.minCount ?? 0,
        maxCount: legacyUse.maxCount ?? null,
      },
    };
    if (legacyUse.referenceMode) {
      if (!['logical', 'version'].includes(legacyUse.referenceMode)) {
        throw new Error(`${moduleName}: invalid contextual referenceMode ${legacyUse.referenceMode}`);
      }
      use.constraints = [{
        constraintRef: legacyUse.referenceMode === 'logical' ? LOGICAL_REFERENCE : EXACT_VERSION_REFERENCE,
        targetElement: relation.iri,
      }];
    }
    output.domain.relationUses.push(use);
  }

  output.domain.relationUses.sort((a, b) =>
    compareUtf8(
      [a.relation, a.subjectType, a.objectType].join('\0'),
      [b.relation, b.subjectType, b.objectType].join('\0'),
    )
  );
  return output;
}

function render(moduleName, doc) {
  const header = [
    `# Axiolune M2 Finance — ${doc.module.label}`,
    '# Authoring profile: RFC-001 typed containers',
    '# Version: 0.3.0',
    '# Status: draft',
    '',
  ].join('\n');
  return header + yaml.dump(doc, {
    lineWidth: 120,
    noRefs: true,
    noCompatMode: true,
    sortKeys: false,
  });
}

function main() {
  const docs = [];
  for (const entry of fs.readdirSync(FINANCE, { withFileTypes: true })
    .sort((a, b) => compareUtf8(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(FINANCE, entry.name, 'module.yaml');
    if (!fs.existsSync(file)) continue;
    docs.push([entry.name, yaml.load(fs.readFileSync(file, 'utf8')), file]);
  }

  const codeListIris = buildCodeListIndex(docs);
  const staged = [];
  for (const [moduleName, doc, file] of docs) {
    const migrated = migrate(moduleName, doc, codeListIris);
    staged.push([moduleName, file, render(moduleName, migrated), migrated]);
  }

  for (const [moduleName, , , migrated] of staged) {
    const counts = CONTAINERS.map((name) => `${name}=${Object.keys(migrated.domain[name]).length}`).join(' ');
    console.log(`${moduleName}: ${counts} relationUses=${migrated.domain.relationUses.length}`);
  }

  if (WRITE) {
    for (const [, file, bytes] of staged) fs.writeFileSync(file, bytes, 'utf8');
    console.log(`WROTE ${staged.length} typed v0.3 module sources`);
  } else {
    console.log(`DRY-RUN: ${staged.length} modules are migratable; pass --write to replace them`);
  }
}

if (require.main === module) main();

module.exports = {
  IDENTIFIER_PROFILES,
  migrate,
  normalizeElement,
};
