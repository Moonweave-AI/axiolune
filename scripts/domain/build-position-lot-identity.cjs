#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  IdentityContractError,
  TAGS,
  buildIdentityIris,
  canonicalJcs,
  compileIdentityContracts,
  taggedJcsDigest,
  validateIdentityManifest,
} = require('./lib/identity-contract-compiler.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const BASE = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
const IDENTITY_DIR_REL = 'mappings/finance/v0.3.0/portfolio-positions/identity';
const IDENTITY_DIR = path.join(ROOT, ...IDENTITY_DIR_REL.split('/'));
const FILES = Object.freeze({
  contract: 'normalization-contract.json',
  implementation: 'normalization-implementation.cjs',
  vectors: 'normalization-vectors.json',
  source: 'source-record.json',
  registry: 'identity-term-registry.json',
  compilation: 'position-lot-identity-compilation.json',
  manifest: 'position-lot-identity-manifest.json',
  evidence: 'position-lot-identity-evidence.json',
});
const MODULE_REL = 'ontology/domain/finance/portfolio-positions/module.yaml';
const MODULE_FILE = path.join(ROOT, ...MODULE_REL.split('/'));
const XSD = 'http://www.w3.org/2001/XMLSchema#';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function artifact(fileName) {
  return {
    kind: 'path',
    root: 'sourceTree',
    path: `${IDENTITY_DIR_REL}/${fileName}`,
  };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} keys must equal ${expected.join(',')}`);
  }
}

function loadJson(fileName) {
  const bytes = fs.readFileSync(path.join(IDENTITY_DIR, fileName));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function requireModuleContract() {
  const document = YAML.parse(fs.readFileSync(MODULE_FILE, 'utf8'));
  const lot = document.domain?.associationTypes?.PositionLot;
  if (!lot || lot.iri !== `${BASE}PositionLot`) throw new Error('PositionLot target is missing');
  const roles = new Map((lot.participantRoles || []).map((role) => [role.id, role]));
  const requiredRoles = new Map([
    ['lotInAccount', 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount'],
    ['lotForInstrument', 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument'],
    ['openingExecution', 'https://axiolune.ai/ontology/finance/orders-execution/Execution'],
    ['costBasisDefinition', `${BASE}CostBasisCalculationDefinition`],
  ]);
  for (const [roleId, range] of requiredRoles) {
    const role = roles.get(roleId);
    if (!role || role.range !== range || role.minCount !== 1 || role.maxCount !== 1) {
      throw new Error(`PositionLot role ${roleId} drifted from the identity contract`);
    }
  }
  const discriminator = document.domain?.attributeTypes?.lotDiscriminator;
  if (!discriminator || discriminator.iri !== `${BASE}lotDiscriminator`
      || discriminator.valueType !== 'string' || discriminator.pattern !== '^openingRemainder$') {
    throw new Error('PositionLot lotDiscriminator contract drifted');
  }
  const expression = document.domain?.constraints?.PositionLotContract?.expression?.expression;
  const normalized = String(expression || '').replace(/\s+/gu, '');
  for (const required of [
    'logicalKey(lotInAccount.logicalIri,lotForInstrument.logicalIri,openingExecution.logicalIri,costBasisDefinition.logicalIri,lotDiscriminator)',
    'versionKey(validFrom,knowledgeFrom,availableFrom,revision)',
  ]) {
    if (!normalized.includes(required.replace(/\s+/gu, ''))) {
      throw new Error(`PositionLotContract no longer contains ${required}`);
    }
  }
  return { document, lot };
}

function validateSourceRecord(source) {
  exactKeys(source, ['schemaVersion', 'dataset', 'row'], 'source record');
  if (source.schemaVersion !== '1.0' || source.dataset !== 'position_lot_identity_fixture') {
    throw new Error('source record identity is invalid');
  }
  exactKeys(source.row, [
    'accountLogicalIri',
    'instrumentLogicalIri',
    'openingExecutionLogicalIri',
    'costBasisDefinitionLogicalIri',
    'lotDiscriminator',
    'validFrom',
    'knowledgeFrom',
    'availableFrom',
    'revision',
    'sourceArtifactRef',
    'sourceArtifactDigest',
  ], 'source record row');
  if (source.row.lotDiscriminator !== 'openingRemainder') {
    throw new Error('source lotDiscriminator violates the fixed PositionLot contract');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(source.row.sourceArtifactDigest)) {
    throw new Error('source artifact digest is invalid');
  }
}

function validateAndRunVectors(vectorDocument, implementation) {
  exactKeys(vectorDocument, ['schemaVersion', 'vectors'], 'normalization vectors');
  if (vectorDocument.schemaVersion !== '1.0'
      || !Array.isArray(vectorDocument.vectors)
      || vectorDocument.vectors.length < 8) {
    throw new Error('normalization vector document is incomplete');
  }
  const ids = new Set();
  const results = [];
  for (const vector of vectorDocument.vectors) {
    if (!vector || typeof vector !== 'object' || Array.isArray(vector)) {
      throw new Error('normalization vector must be an object');
    }
    const negative = Object.hasOwn(vector, 'expectedError');
    exactKeys(
      vector,
      negative
        ? ['id', 'algorithmId', 'input', 'expectedError']
        : ['id', 'algorithmId', 'input', 'expected'],
      `normalization vector ${String(vector.id)}`,
    );
    if (ids.has(vector.id)) throw new Error(`duplicate normalization vector ${vector.id}`);
    ids.add(vector.id);
    let outcome;
    try {
      outcome = { value: implementation.normalize(vector.algorithmId, vector.input) };
    } catch (cause) {
      outcome = { error: cause && cause.message ? cause.message : String(cause) };
    }
    const passed = negative
      ? typeof outcome.error === 'string' && outcome.error.includes(vector.expectedError)
      : outcome.value === vector.expected;
    if (!passed) throw new Error(`normalization vector ${vector.id} failed`);
    results.push({ id: vector.id, status: 'passed', branch: negative ? 'rejection' : 'acceptance' });
  }
  if (!results.some((row) => row.branch === 'acceptance')
      || !results.some((row) => row.branch === 'rejection')) {
    throw new Error('normalization vectors must cover acceptance and rejection');
  }
  return results;
}

function termDefinition(iri, label, definition, termContract) {
  const value = { iri, label, definition, termContract };
  return {
    termContractRef: iri,
    termContractDigest: taggedJcsDigest(TAGS.termContract, value),
    definition: value,
  };
}

function buildCompilationInput(resources, implementation) {
  const ns = 'https://axiolune.ai/mapping/finance/v0.3.0/portfolio-positions/identity/';
  const targetType = `${BASE}PositionLot`;
  const termRows = [
    termDefinition(
      `${ns}terms/account-logical`,
      'FinancialAccount logical identity',
      'Canonical logical IRI of the PositionLot account.',
      {
        termKind: 'iri',
        referenceMode: 'logical',
        expectedTargetType: 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount',
      },
    ),
    termDefinition(
      `${ns}terms/cost-basis-definition-logical`,
      'CostBasisCalculationDefinition logical identity',
      'Canonical logical IRI of the cost-basis definition.',
      { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${BASE}CostBasisCalculationDefinition` },
    ),
    termDefinition(
      `${ns}terms/date-time-stamp`,
      'UTC date-time stamp',
      'Canonical xsd:dateTimeStamp identity term.',
      { termKind: 'literal', datatypeIri: `${XSD}dateTimeStamp` },
    ),
    termDefinition(
      `${ns}terms/execution-logical`,
      'Execution logical identity',
      'Canonical logical IRI of the opening Execution.',
      {
        termKind: 'iri',
        referenceMode: 'logical',
        expectedTargetType: 'https://axiolune.ai/ontology/finance/orders-execution/Execution',
      },
    ),
    termDefinition(
      `${ns}terms/instrument-logical`,
      'FinancialInstrument logical identity',
      'Canonical logical IRI of the PositionLot instrument.',
      {
        termKind: 'iri',
        referenceMode: 'logical',
        expectedTargetType: 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument',
      },
    ),
    termDefinition(
      `${ns}terms/non-negative-integer`,
      'Non-negative revision',
      'Canonical xsd:nonNegativeInteger identity term.',
      { termKind: 'literal', datatypeIri: `${XSD}nonNegativeInteger` },
    ),
    termDefinition(
      `${ns}terms/string`,
      'NFC string',
      'Canonical non-empty xsd:string identity term.',
      { termKind: 'literal', datatypeIri: `${XSD}string` },
    ),
  ].sort((left, right) => Buffer.compare(
    Buffer.from(left.termContractRef, 'utf8'),
    Buffer.from(right.termContractRef, 'utf8'),
  ));
  const termBySuffix = new Map(termRows.map((row) => [row.termContractRef.split('/').pop(), row]));
  const registry = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    termContracts: termRows,
    controlledSets: [],
  };
  const registryDigest = taggedJcsDigest(TAGS.termRegistry, registry);

  function rule(suffix, termSuffix, algorithmId) {
    const term = termBySuffix.get(termSuffix);
    return {
      iri: `${ns}normalization/${suffix}`,
      label: `${suffix} normalization`,
      definition: `Deterministic ${algorithmId} normalization for PositionLot identity.`,
      inputTermContractRef: term.termContractRef,
      inputTermContractDigest: term.termContractDigest,
      outputTermContractRef: term.termContractRef,
      outputTermContractDigest: term.termContractDigest,
      algorithmId,
      algorithmVersion: '1.0.0',
      specificationRef: artifact(FILES.contract),
      specificationDigest: sha256(resources.contract.bytes),
      implementationRef: artifact(FILES.implementation),
      implementationDigest: sha256(resources.implementation.bytes),
      testVectorsRef: artifact(FILES.vectors),
      testVectorsDigest: sha256(resources.vectors.bytes),
    };
  }
  const rules = [
    rule('account-logical', 'account-logical', 'absolute_iri_v1'),
    rule('cost-basis-definition-logical', 'cost-basis-definition-logical', 'absolute_iri_v1'),
    rule('date-time-stamp', 'date-time-stamp', 'utc_datetime_stamp_v1'),
    rule('execution-logical', 'execution-logical', 'absolute_iri_v1'),
    rule('instrument-logical', 'instrument-logical', 'absolute_iri_v1'),
    rule('non-negative-integer', 'non-negative-integer', 'non_negative_integer_v1'),
    rule('string', 'string', 'nfc_string_v1'),
  ];
  const ruleBySuffix = new Map(rules.map((row) => [row.iri.split('/').pop(), row]));

  function participant(name, roleId, termSuffix, ruleSuffix) {
    const term = termBySuffix.get(termSuffix);
    const normalizationRule = ruleBySuffix.get(ruleSuffix);
    return {
      name,
      semanticValue: {
        valueKind: 'participantRole',
        containingAssociation: targetType,
        roleId,
        effectivePredicate: `${targetType}/role/${roleId}`,
      },
      termContractRef: term.termContractRef,
      termContractDigest: term.termContractDigest,
      normalizationRuleRef: normalizationRule.iri,
      normalizationRuleDigest: taggedJcsDigest(TAGS.normalizationRule, normalizationRule),
    };
  }

  function attribute(name, attributeRef, termSuffix, ruleSuffix) {
    const term = termBySuffix.get(termSuffix);
    const normalizationRule = ruleBySuffix.get(ruleSuffix);
    return {
      name,
      semanticValue: {
        valueKind: 'attributeUse',
        containingType: targetType,
        attributeRef,
      },
      termContractRef: term.termContractRef,
      termContractDigest: term.termContractDigest,
      normalizationRuleRef: normalizationRule.iri,
      normalizationRuleDigest: taggedJcsDigest(TAGS.normalizationRule, normalizationRule),
    };
  }

  function pattern(name, fieldRef, termSuffix, ruleSuffix) {
    const term = termBySuffix.get(termSuffix);
    const normalizationRule = ruleBySuffix.get(ruleSuffix);
    return {
      name,
      semanticValue: {
        valueKind: 'patternField',
        containingType: targetType,
        patternRef: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
        fieldRef,
      },
      termContractRef: term.termContractRef,
      termContractDigest: term.termContractDigest,
      normalizationRuleRef: normalizationRule.iri,
      normalizationRuleDigest: taggedJcsDigest(TAGS.normalizationRule, normalizationRule),
    };
  }

  const contract = {
    iri: `${ns}contracts/position-lot`,
    label: 'PositionLot target identity contract',
    definition: 'Canonical PositionLot logical identity and standard immutable four-component version identity.',
    targetType,
    identityBaseIri: 'https://axiolune.ai/data/position-lot',
    logicalComponents: [
      participant('lotInAccount', 'lotInAccount', 'account-logical', 'account-logical'),
      participant('lotForInstrument', 'lotForInstrument', 'instrument-logical', 'instrument-logical'),
      participant('openingExecution', 'openingExecution', 'execution-logical', 'execution-logical'),
      participant(
        'costBasisDefinition',
        'costBasisDefinition',
        'cost-basis-definition-logical',
        'cost-basis-definition-logical',
      ),
      attribute('lotDiscriminator', `${BASE}lotDiscriminator`, 'string', 'string'),
    ],
    versionComponents: [
      pattern(
        'validFrom',
        'https://axiolune.ai/ontology/meta/patterns/validFrom',
        'date-time-stamp',
        'date-time-stamp',
      ),
      pattern(
        'knowledgeFrom',
        'https://axiolune.ai/ontology/meta/patterns/knowledgeFrom',
        'date-time-stamp',
        'date-time-stamp',
      ),
      pattern(
        'availableFrom',
        'https://axiolune.ai/ontology/meta/patterns/availableFrom',
        'date-time-stamp',
        'date-time-stamp',
      ),
      pattern(
        'revision',
        'https://axiolune.ai/ontology/meta/patterns/revision',
        'non-negative-integer',
        'non-negative-integer',
      ),
    ],
  };

  function direct(field) {
    return { bindingType: 'directField', source: { dataset: 'lot', field } };
  }
  const mapping = {
    iri: `${ns}mappings/position-lot`,
    label: 'PositionLot identity conformance mapping',
    source: {
      datasets: [{
        dataset: 'https://axiolune.ai/source/position-lot-identity-fixture',
        alias: 'lot',
      }],
    },
    targetType,
    mappingType: 'directTable',
    identity: {
      contractRef: contract.iri,
      logicalKeyBindings: {
        lotInAccount: direct('accountLogicalIri'),
        lotForInstrument: direct('instrumentLogicalIri'),
        openingExecution: direct('openingExecutionLogicalIri'),
        costBasisDefinition: direct('costBasisDefinitionLogicalIri'),
        lotDiscriminator: direct('lotDiscriminator'),
      },
      versionKeyBindings: {
        validFrom: direct('validFrom'),
        knowledgeFrom: direct('knowledgeFrom'),
        availableFrom: direct('availableFrom'),
        revision: direct('revision'),
      },
    },
    slotMappings: [
      {
        target: {
          slotType: 'attribute',
          targetAttribute: `${BASE}lotDiscriminator`,
        },
        value: direct('lotDiscriminator'),
      },
    ],
    temporal: {
      patternRef: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
      validTime: { from: direct('validFrom'), closePolicy: 'externalClosureAssertion' },
      knowledgeTime: { from: direct('knowledgeFrom'), closePolicy: 'externalClosureAssertion' },
      availabilityTime: { from: direct('availableFrom'), closePolicy: 'externalClosureAssertion' },
    },
    provenance: {
      sourceArtifactRef: direct('sourceArtifactRef'),
      sourceArtifactDigest: direct('sourceArtifactDigest'),
    },
  };
  const input = {
    profileRef: PROFILE_REF,
    identityTermRegistryRef: artifact(FILES.registry),
    identityTermRegistryDigest: registryDigest,
    identityTermRegistry: registry,
    normalizationRules: rules,
    derivations: [],
    contracts: [contract],
    mappings: [mapping],
    concreteTargetTypes: [targetType],
  };
  const row = resources.source.value.row;
  const logicalTerms = {
    lotInAccount: implementation.normalize('absolute_iri_v1', row.accountLogicalIri),
    lotForInstrument: implementation.normalize('absolute_iri_v1', row.instrumentLogicalIri),
    openingExecution: implementation.normalize('absolute_iri_v1', row.openingExecutionLogicalIri),
    costBasisDefinition: implementation.normalize(
      'absolute_iri_v1',
      row.costBasisDefinitionLogicalIri,
    ),
    lotDiscriminator: implementation.normalize('nfc_string_v1', row.lotDiscriminator),
  };
  const versionTerms = {
    validFrom: implementation.normalize('utc_datetime_stamp_v1', row.validFrom),
    knowledgeFrom: implementation.normalize('utc_datetime_stamp_v1', row.knowledgeFrom),
    availableFrom: implementation.normalize('utc_datetime_stamp_v1', row.availableFrom),
    revision: implementation.normalize('non_negative_integer_v1', row.revision),
  };
  return { input, contract, mapping, registry, logicalTerms, versionTerms };
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJcs(value)}\n`, 'utf8');
}

function createArtifacts() {
  requireModuleContract();
  const resources = {
    contract: loadJson(FILES.contract),
    implementation: {
      bytes: fs.readFileSync(path.join(IDENTITY_DIR, FILES.implementation)),
    },
    vectors: loadJson(FILES.vectors),
    source: loadJson(FILES.source),
  };
  validateSourceRecord(resources.source.value);
  exactKeys(resources.contract.value, ['schemaVersion', 'profileRef', 'algorithms'], 'normalization contract');
  if (resources.contract.value.schemaVersion !== '1.0'
      || resources.contract.value.profileRef !== PROFILE_REF
      || !Array.isArray(resources.contract.value.algorithms)
      || resources.contract.value.algorithms.length !== 4) {
    throw new Error('normalization contract is invalid');
  }
  const implementationPath = path.join(IDENTITY_DIR, FILES.implementation);
  delete require.cache[require.resolve(implementationPath)];
  const implementation = require(implementationPath);
  const vectorResults = validateAndRunVectors(resources.vectors.value, implementation);
  const built = buildCompilationInput(resources, implementation);
  const compiled = compileIdentityContracts(built.input);
  const manifestValidation = validateIdentityManifest(compiled.manifest, built.input);
  if (!manifestValidation.ok) throw new IdentityContractError(manifestValidation.errors);
  const identities = buildIdentityIris(built.contract, built.logicalTerms, built.versionTerms);

  const compilation = {
    profileRef: PROFILE_REF,
    identityTermRegistryRef: built.input.identityTermRegistryRef,
    identityTermRegistryDigest: built.input.identityTermRegistryDigest,
    identityTermRegistry: built.registry,
    normalizationRules: built.input.normalizationRules,
    derivations: [],
    contracts: [built.contract],
    mappings: [built.mapping],
    concreteTargetTypes: built.input.concreteTargetTypes,
  };
  const evidence = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    outcome: 'passed',
    moduleRef: 'https://axiolune.ai/ontology/finance/portfolio-positions',
    targetType: `${BASE}PositionLot`,
    sourceArtifactRef: artifact(FILES.source),
    sourceArtifactDigest: sha256(resources.source.bytes),
    compilationArtifactRef: artifact(FILES.compilation),
    compilationArtifactDigest: sha256(canonicalBytes(compilation)),
    manifestArtifactRef: artifact(FILES.manifest),
    manifestArtifactDigest: sha256(canonicalBytes(compiled.manifest)),
    identityManifestDigest: compiled.manifestDigest,
    normalizationArtifactDigests: {
      contract: sha256(resources.contract.bytes),
      implementation: sha256(resources.implementation.bytes),
      vectors: sha256(resources.vectors.bytes),
    },
    vectorResults,
    materializedIdentity: {
      logicalIri: identities.logicalIri,
      versionIri: identities.versionIri,
      logicalTerms: built.logicalTerms,
      versionTerms: built.versionTerms,
    },
    negativeAssurances: [
      'module-logical-key-drift-fails',
      'module-version-key-drift-fails',
      'compiler-binding-coverage-fails',
      'manifest-tamper-fails',
      'generated-byte-drift-fails',
    ],
  };
  return {
    [FILES.registry]: built.registry,
    [FILES.compilation]: compilation,
    [FILES.manifest]: compiled.manifest,
    [FILES.evidence]: evidence,
  };
}

function writeArtifacts(artifacts) {
  fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  for (const [fileName, value] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(IDENTITY_DIR, fileName), canonicalBytes(value));
  }
}

function checkArtifacts(artifacts) {
  for (const [fileName, value] of Object.entries(artifacts)) {
    const expected = canonicalBytes(value);
    const file = path.join(IDENTITY_DIR, fileName);
    if (!fs.existsSync(file)) throw new Error(`generated identity artifact is missing: ${fileName}`);
    const actual = fs.readFileSync(file);
    if (!actual.equals(expected)) throw new Error(`generated identity artifact drift: ${fileName}`);
  }
}

function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && !['--write', '--check'].includes(argv[0]))) {
    process.stderr.write('Usage: node scripts/domain/build-position-lot-identity.cjs [--write|--check]\n');
    return 2;
  }
  const artifacts = createArtifacts();
  if (argv[0] === '--write') writeArtifacts(artifacts);
  else checkArtifacts(artifacts);
  process.stdout.write(
    `PositionLot TargetIdentityContract: PASS `
      + `(artifacts=${Object.keys(artifacts).length}, vectors=${artifacts[FILES.evidence].vectorResults.length})\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause && cause.stack ? cause.stack : cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  FILES,
  IDENTITY_DIR,
  buildCompilationInput,
  canonicalBytes,
  checkArtifacts,
  createArtifacts,
  main,
  requireModuleContract,
};
