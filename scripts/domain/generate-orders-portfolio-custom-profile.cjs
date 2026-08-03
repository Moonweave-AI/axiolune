#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  CONSTRAINT_BINDINGS,
  canonicalJcs,
  constraintDispatchDescriptor,
} = require('./lib/orders-portfolio-custom-validators.cjs');
const {
  TARGET_TYPE_BY_EVALUATOR,
  TYPES,
} = require('./lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  buildLockedReferenceRegistry,
} = require('./lib/orders-portfolio-reference-registry.cjs');
const {
  PATHS,
  PROFILE_REF,
  ROOT,
  buildVectorSet,
  compareUtf8,
  reconciliationProducerInputs,
} = require('./lib/orders-portfolio-custom-profile.cjs');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function bytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function ref(file) {
  return { kind: 'path', path: path.relative(ROOT, file).split(path.sep).join('/'), root: 'sourceTree' };
}

function readModule(file, moduleId) {
  const document = YAML.parse(fs.readFileSync(file, 'utf8'));
  const constraints = Object.values(document.domain?.constraints || {})
    .filter((row) => row.expression?.language === 'Custom')
    .sort((left, right) => compareUtf8(left.iri, right.iri));
  return { constraints, document, moduleId };
}

function buildDiscovery(
  implementationDigest,
  adapterDigest,
  arithmeticDigest,
  referenceRegistryDigest,
  inputContractDigest,
  outputContractDigest,
) {
  const modules = [
    readModule(PATHS.ordersModule, 'fin-orders-execution'),
    readModule(PATHS.portfolioModule, 'fin-portfolio-positions'),
  ];
  const rows = [];
  for (const module of modules) {
    for (const constraint of module.constraints) {
      const validatorId = CONSTRAINT_BINDINGS[constraint.iri];
      if (!validatorId) throw new Error(`unbound authored Custom constraint ${constraint.iri}`);
      const bindings = (module.document.domain?.constraintBindings || []).filter((row) => (
        row.constraintRef === constraint.iri && row.targetElement === constraint.targetElement
      ));
      if (bindings.length !== 1) throw new Error(`${constraint.iri} lacks one exact target binding`);
      const dispatch = constraintDispatchDescriptor(constraint.iri);
      if (dispatch.evaluatorId !== validatorId) throw new Error(`dispatch binding drift at ${constraint.iri}`);
      rows.push({
        adapterDigest,
        adapterRef: ref(PATHS.adapter),
        arithmeticDigest,
        arithmeticRef: ref(PATHS.arithmetic),
        constraintIri: constraint.iri,
        dispatchDigest: dispatch.dispatchDigest,
        expressionDigest: sha256(bytes(constraint.expression)),
        inputContractDigest,
        inputContractRef: ref(PATHS.inputContract),
        implementationDigest,
        implementationRef: ref(PATHS.implementation),
        module: module.moduleId,
        outputContractDigest,
        outputContractRef: ref(PATHS.outputContract),
        referenceRegistryDigest,
        referenceRegistryRef: ref(PATHS.referenceRegistry),
        scope: constraint.scope,
        targetElement: constraint.targetElement,
        validatorId,
      });
    }
  }
  rows.sort((left, right) => compareUtf8(left.constraintIri, right.constraintIri));
  if (rows.length !== 35 || new Set(rows.map((row) => row.constraintIri)).size !== 35) {
    throw new Error(`Orders/Portfolio Custom inventory must be exactly 35, got ${rows.length}`);
  }
  if (Object.keys(CONSTRAINT_BINDINGS).length !== 35) throw new Error('trusted validator binding inventory is not exactly 35');
  return {
    constraints: rows,
    profileRef: PROFILE_REF,
    runtimeId: 'axiolune-orders-portfolio-custom-runtime-v1',
    schemaVersion: '1.0',
  };
}

const COMMON_FIELDS = Object.freeze([
  { field: 'availableFrom', kind: 'm3Attribute', maxCount: 1, minCount: 1, ontologyElement: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom', valueType: 'datetime' },
  { field: 'knowledgeFrom', kind: 'm3Attribute', maxCount: 1, minCount: 1, ontologyElement: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom', valueType: 'datetime' },
  { field: 'revision', kind: 'm3Attribute', maxCount: 1, minCount: 1, ontologyElement: 'https://axiolune.ai/ontology/meta/patterns/attributes/revision', valueType: 'integer' },
  { field: 'source', kind: 'm3Attribute', maxCount: 1, minCount: 1, ontologyElement: 'https://axiolune.ai/ontology/meta/patterns/attributes/source', valueType: 'uri' },
  { field: 'sourceVersion', kind: 'm3Attribute', maxCount: 1, minCount: 0, ontologyElement: 'https://axiolune.ai/ontology/meta/patterns/attributes/sourceVersion', valueType: 'string' },
  { field: 'typeIri', kind: 'control', maxCount: 1, minCount: 1 },
  { field: 'validFrom', kind: 'm3Attribute', maxCount: 1, minCount: 1, ontologyElement: 'https://axiolune.ai/ontology/meta/patterns/attributes/validFrom', valueType: 'datetime' },
  { field: 'validTo', kind: 'm3Attribute', maxCount: 1, minCount: 0, ontologyElement: 'https://axiolune.ai/ontology/meta/patterns/attributes/validTo', valueType: 'datetime' },
  { field: 'versionIri', kind: 'control', maxCount: 1, minCount: 1 },
]);

function referenceMode(constraints, label) {
  const values = (constraints || []).map((row) => {
    if (row.constraintRef?.endsWith('/ExactVersionReference')) return 'version';
    if (row.constraintRef?.endsWith('/LogicalReference')) return 'logical';
    return null;
  }).filter(Boolean);
  if (values.length !== 1) throw new Error(`${label} requires one exact reference-mode binding`);
  return values[0];
}

function buildInputContract(referenceRegistry = buildLockedReferenceRegistry(ROOT)) {
  const moduleFiles = [
    PATHS.ordersModule, PATHS.portfolioModule, PATHS.instrumentsModule,
    PATHS.marketDataModule, PATHS.marketStructureModule,
  ];
  const documents = moduleFiles.map((file) => YAML.parse(fs.readFileSync(file, 'utf8')));
  const requiredTypes = new Set([...Object.values(TARGET_TYPE_BY_EVALUATOR),
    TYPES.DirectUnitPriceQuotationContract, TYPES.FXRateObservation,
    TYPES.InstrumentListing, TYPES.OTCTradingContext, TYPES.PriceObservation]);
  const typeDefinitions = new Map();
  const attributeDefinitions = new Map();
  const codeListValues = new Map();
  const relationUses = [];
  const bindingModes = new Map();
  for (const document of documents) {
    for (const collection of ['objectTypes', 'associationTypes']) {
      for (const definition of Object.values(document.domain?.[collection] || {})) {
        if (requiredTypes.has(definition.iri)) typeDefinitions.set(definition.iri, { collection, definition });
      }
    }
    for (const definition of Object.values(document.domain?.attributeTypes || {})) {
      attributeDefinitions.set(definition.iri, definition);
    }
    for (const definition of Object.values(document.domain?.codeLists || {})) {
      codeListValues.set(
        definition.iri,
        (definition.values || []).map((value) => value.iri).sort(compareUtf8),
      );
    }
    relationUses.push(...(document.domain?.relationUses || []));
    for (const binding of document.domain?.constraintBindings || []) {
      const mode = binding.constraintRef?.endsWith('/ExactVersionReference') ? 'version'
        : binding.constraintRef?.endsWith('/LogicalReference') ? 'logical' : null;
      if (mode) bindingModes.set(binding.targetElement, mode);
    }
  }
  if (typeDefinitions.size !== requiredTypes.size) {
    throw new Error(`canonical input-contract type closure mismatch expected=${requiredTypes.size} actual=${typeDefinitions.size}`);
  }
  const recordSchemas = [];
  for (const typeIri of [...requiredTypes].sort(compareUtf8)) {
    const { collection, definition } = typeDefinitions.get(typeIri);
    const fields = new Map(COMMON_FIELDS.map((row) => [row.field, { ...row }]));
    const add = (row) => {
      const prior = fields.get(row.field);
      if (!prior) fields.set(row.field, row);
      else {
        const merged = {
        ...prior,
        maxCount: prior.maxCount === null || row.maxCount === null ? null : Math.min(prior.maxCount, row.maxCount),
        minCount: Math.max(prior.minCount, row.minCount),
        };
        const mode = prior.referenceMode || row.referenceMode;
        if (mode) merged.referenceMode = mode;
        fields.set(row.field, merged);
      }
    };
    for (const use of definition.attributeUses || []) {
      const attributeDefinition = attributeDefinitions.get(use.attribute);
      add({
        field: use.attribute.slice(use.attribute.lastIndexOf('/') + 1), kind: 'attribute',
        maxCount: use.maxCount, minCount: use.minCount, ontologyElement: use.attribute,
        ...(attributeDefinition?.valueType ? { valueType: attributeDefinition.valueType } : {}),
        ...(codeListValues.has(attributeDefinition?.valueType)
          ? { allowedValues: codeListValues.get(attributeDefinition.valueType) } : {}),
      });
    }
    for (const role of definition.participantRoles || []) {
      const target = `${typeIri}/role/${role.id}`;
      const mode = bindingModes.get(target);
      if (!mode) throw new Error(`${target} lacks exact reference-mode binding`);
      add({
        expectedTargetType: role.range, field: role.id, kind: 'participantRole', maxCount: role.maxCount,
        minCount: role.minCount, ontologyElement: target, referenceMode: mode,
      });
    }
    for (const use of relationUses.filter((row) => row.subjectType === typeIri)) {
      const relationLocalName = use.relation.slice(use.relation.lastIndexOf('/') + 1);
      add({
        expectedTargetType: use.objectType, field: relationLocalName, kind: 'relation',
        maxCount: use.outboundCardinality.maxCount, minCount: use.outboundCardinality.minCount,
        ontologyElement: use.relation,
        referenceMode: referenceMode(use.constraints, `${typeIri}.${relationLocalName}`),
      });
    }
    recordSchemas.push({
      fieldContracts: [...fields.values()].sort((left, right) => compareUtf8(left.field, right.field)),
      ontologyKind: collection === 'objectTypes' ? 'ObjectTypeDefinition' : 'AssociationTypeDefinition',
      typeIri,
    });
  }
  return {
    artifactSchema: {
      optionalFields: [],
      requiredFields: ['artifactDigest', 'artifactRef', 'mediaType', 'payload'],
    },
    canonicalEncoding: 'RFC8785-JCS',
    contractId: 'axiolune-orders-portfolio-custom-canonical-record-input-v1',
    focusField: 'focusVersionIri',
    referenceRegistryDigest: referenceRegistry.registryDigest,
    recordSchemas,
    schemaVersion: '1.0',
    topLevelOptionalFields: [],
    topLevelRequiredFields: ['artifacts', 'focusVersionIri', 'records', 'schemaVersion'],
    unknownFields: 'fatal',
  };
}

function buildOutputContract() {
  return {
    canonicalEncoding: 'RFC8785-JCS',
    contractId: 'axiolune-orders-portfolio-custom-output-v1',
    fields: ['assurance', 'constraintIri', 'dispatchDigest', 'outcome', 'schemaVersion', 'validatorId', 'violation'],
    outcomes: ['accepted', 'violation'],
    schemaVersion: '1.0',
    unknownFields: 'fatal',
  };
}

function buildClosure(
  discoveryBytes,
  vectorBytes,
  inputContractBytes,
  outputContractBytes,
  referenceRegistryBytes,
  reconciliationProducerInputBytes,
) {
  const artifactRows = [
    ['adapter', PATHS.adapter, fs.readFileSync(PATHS.adapter)],
    ['arithmetic', PATHS.arithmetic, fs.readFileSync(PATHS.arithmetic)],
    ['canonicalization', PATHS.canonicalization, fs.readFileSync(PATHS.canonicalization)],
    ['discovery', PATHS.discovery, discoveryBytes],
    ['generator', PATHS.generator, fs.readFileSync(PATHS.generator)],
    ['implementation', PATHS.implementation, fs.readFileSync(PATHS.implementation)],
    ['input-contract', PATHS.inputContract, inputContractBytes],
    ['iso-4217-source', PATHS.iso4217Source, fs.readFileSync(PATHS.iso4217Source)],
    ['output-contract', PATHS.outputContract, outputContractBytes],
    ['profile-builder', PATHS.profileBuilder, fs.readFileSync(PATHS.profileBuilder)],
    ['quantity-units-source', PATHS.quantityUnitsSource, fs.readFileSync(PATHS.quantityUnitsSource)],
    ['reference-registry', PATHS.referenceRegistry, referenceRegistryBytes],
    ['reference-registry-generator', PATHS.referenceRegistryGenerator, fs.readFileSync(PATHS.referenceRegistryGenerator)],
    ['reference-registry-implementation', PATHS.referenceRegistryImplementation, fs.readFileSync(PATHS.referenceRegistryImplementation)],
    ['reference-source-locks', PATHS.referenceSourceLocks, fs.readFileSync(PATHS.referenceSourceLocks)],
    ['reconciliation-evidence', PATHS.reconciliationEvidence, fs.readFileSync(PATHS.reconciliationEvidence)],
    ['reconciliation-producer-inputs', PATHS.reconciliationProducerInputs, reconciliationProducerInputBytes],
    ['runner', PATHS.runner, fs.readFileSync(PATHS.runner)],
    ['vectors', PATHS.vectors, vectorBytes],
    ['worker', PATHS.worker, fs.readFileSync(PATHS.worker)],
  ].map(([role, file, content]) => ({ digest: sha256(content), ref: ref(file), role }))
    .sort((left, right) => compareUtf8(left.ref.path, right.ref.path));
  return {
    artifacts: artifactRows,
    closureDigest: sha256(Buffer.concat([
      Buffer.from('axiolune-orders-portfolio-custom-closure-v1\0', 'utf8'),
      bytes(artifactRows),
    ])),
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
}

function expectedArtifacts() {
  const implementationDigest = sha256(fs.readFileSync(PATHS.implementation));
  const adapterDigest = sha256(fs.readFileSync(PATHS.adapter));
  const arithmeticDigest = sha256(fs.readFileSync(PATHS.arithmetic));
  const referenceRegistry = buildLockedReferenceRegistry(ROOT);
  const referenceRegistryBytes = bytes(referenceRegistry);
  const inputContract = buildInputContract(referenceRegistry);
  const outputContract = buildOutputContract();
  const inputContractBytes = bytes(inputContract);
  const outputContractBytes = bytes(outputContract);
  const discovery = buildDiscovery(
    implementationDigest,
    adapterDigest,
    arithmeticDigest,
    sha256(referenceRegistryBytes),
    sha256(inputContractBytes),
    sha256(outputContractBytes),
  );
  const vectors = buildVectorSet(referenceRegistry);
  const discoveryBytes = bytes(discovery);
  const vectorBytes = bytes(vectors);
  const reconciliationProducerInputBytes = bytes(
    reconciliationProducerInputs(),
  );
  const closure = buildClosure(
    discoveryBytes,
    vectorBytes,
    inputContractBytes,
    outputContractBytes,
    referenceRegistryBytes,
    reconciliationProducerInputBytes,
  );
  return [
    [PATHS.discovery, discoveryBytes],
    [PATHS.inputContract, inputContractBytes],
    [PATHS.outputContract, outputContractBytes],
    [PATHS.referenceRegistry, referenceRegistryBytes],
    [PATHS.reconciliationProducerInputs, reconciliationProducerInputBytes],
    [PATHS.vectors, vectorBytes],
    [PATHS.closure, bytes(closure)],
  ];
}

function main(argv) {
  if (argv.length !== 1 || !['--write', '--check'].includes(argv[0])) {
    throw new Error('Usage: node scripts/domain/generate-orders-portfolio-custom-profile.cjs --write|--check');
  }
  const artifacts = expectedArtifacts();
  if (argv[0] === '--write') {
    fs.mkdirSync(path.dirname(PATHS.discovery), { recursive: true });
    for (const [file, content] of artifacts) {
      fs.writeFileSync(file, content);
      process.stdout.write(`wrote ${file}\n`);
    }
  } else {
    for (const [file, content] of artifacts) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) {
        throw new Error(`Orders/Portfolio Custom artifact drift: ${path.relative(ROOT, file)}`);
      }
    }
  }
  process.stdout.write(`PASS Orders/Portfolio Custom profile (${argv[0].slice(2)}, 35 bindings)\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildClosure, buildDiscovery, buildInputContract, buildOutputContract, expectedArtifacts };
