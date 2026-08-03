'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  PROFILE_MANIFEST_REL,
  PROFILE_REF,
  RECORD_TYPE_ID_FIELD,
  TOOL_LOCK_REL,
  artifactDigest,
  canonicalRecordBytes,
  controlRecordIri,
  plannedInputDigest,
  resolvedInputDigest,
  sourceSchemaClosureDigest,
  sourceSnapshotRootDigest,
  sourceTreeDigest,
  taggedJcsDigest,
  verifyCompletedMaterializationRunBundle,
  verifiedMaterializationRunContext,
} = require('../lib/s5-control-record-chain.cjs');
const {
  PORTFOLIO_GRAPH_IRI,
} = require('../lib/s5-canonical-materialization.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');
const {
  computeDatasetDigest,
  computeNamedGraphDigest,
} = require('../lib/rdfc-1.0.cjs');
const {
  TAGS: IDENTITY_TAGS,
} = require('../lib/identity-contract-compiler.cjs');
const {
  normalizeOntologyIr,
  selectedImportSymbolIris,
  sortUniqueOntologyImportRows,
} = require('../lib/ontology-ir-normalizer.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUTPUT_GRAPH = PORTFOLIO_GRAPH_IRI;
const OUTPUT_REF = iriRef('urn:axiolune:artifact:test:completed-output:v1');
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const FACT_VERSION = 'https://axiolune.ai/ontology/meta/data-binding/FactVersion';
const GENERATING_CONTEXT = 'https://axiolune.ai/ontology/meta/data-binding/attributes/generatingContextRef';
const XSD_ANY_URI = 'http://www.w3.org/2001/XMLSchema#anyURI';

function pathRef(root, relativePath) {
  return { kind: 'path', path: relativePath, root };
}

function iriRef(iri) {
  return { iri, kind: 'iri' };
}

function refKey(ref) {
  return canonicalJcs(ref);
}

function bytesAt(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));
}

function mediaTypeFor(relativePath) {
  if (relativePath.endsWith('.json')) return 'application/json';
  if (relativePath.endsWith('.yaml') || relativePath.endsWith('.yml')) return 'application/yaml';
  if (relativePath.endsWith('.cjs') || relativePath.endsWith('.js')) return 'application/javascript';
  if (relativePath.endsWith('.ttl')) return 'text/turtle';
  if (relativePath.endsWith('.py')) return 'text/x-python';
  if (relativePath.endsWith('.txt')) return 'text/plain';
  if (relativePath.endsWith('.nq')) return 'application/n-quads';
  return 'application/octet-stream';
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function rawDigestBytes(value) {
  return Buffer.from(value.slice('sha256:'.length), 'hex');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mappingClosureDigest(entries) {
  const ordered = [...entries].sort((left, right) => Buffer.compare(
    Buffer.from(left.mappingRef), Buffer.from(right.mappingRef),
  ));
  const parts = [Buffer.from('axiolune-mapping-closure-v1\0'), u64be(ordered.length)];
  for (const entry of ordered) {
    const mapping = Buffer.from(entry.mappingRef);
    const ref = Buffer.from(`path\0${entry.transformationClosureRef.root}\0${entry.transformationClosureRef.path}`);
    parts.push(
      u64be(mapping.length), mapping,
      rawDigestBytes(entry.mappingSourceDigest),
      u64be(ref.length), ref,
      rawDigestBytes(entry.transformationClosureDigest),
    );
  }
  return artifactDigest(Buffer.concat(parts));
}

function singleFileBundleDigest(relativePath, bytes) {
  const name = Buffer.from(path.posix.basename(relativePath));
  return artifactDigest(Buffer.concat([
    Buffer.from('axiolune-reference-bundle-v1\0'),
    u64be(1),
    u64be(name.length), name,
    u64be(bytes.length), bytes,
  ]));
}

class ArtifactInventory {
  constructor(sourceOverrides = new Map()) {
    this.byRef = new Map();
    this.sourceOverrides = sourceOverrides;
  }

  put(ref, bytes, mediaType = mediaTypeFor(ref.path || 'artifact.bin'), replace = false) {
    const key = refKey(ref);
    const normalized = Buffer.from(bytes);
    const prior = this.byRef.get(key);
    if (prior && !replace) {
      assert.ok(prior.bytes.equals(normalized), `artifact collision for ${key}`);
      return prior;
    }
    const row = { bytes: normalized, mediaType, ref: deepClone(ref) };
    this.byRef.set(key, row);
    return row;
  }

  putJcs(ref, value, replace = false) {
    return this.put(ref, Buffer.from(canonicalJcs(value)), 'application/json', replace);
  }

  putSource(relativePath) {
    const ref = pathRef('sourceTree', relativePath);
    const bytes = this.sourceOverrides.has(relativePath)
      ? this.sourceOverrides.get(relativePath)
      : bytesAt(relativePath);
    return this.put(ref, bytes, mediaTypeFor(relativePath));
  }

  get(ref) {
    return this.byRef.get(refKey(ref));
  }

  rows() {
    return [...this.byRef.values()].sort((left, right) => Buffer.compare(
      Buffer.from(refKey(left.ref)), Buffer.from(refKey(right.ref)),
    ));
  }
}

function updateToolLock(inventory) {
  const lock = deepClone(JSON.parse(bytesAt(TOOL_LOCK_REL).toString('utf8')));
  for (const tool of lock.tools) {
    const toolArtifact = inventory.putSource(tool.artifactRef.path);
    tool.artifactDigest = artifactDigest(toolArtifact.bytes);

    const runtime = deepClone(JSON.parse(bytesAt(tool.runtimeRef.path).toString('utf8')));
    for (const entry of runtime.entries) {
      const dependency = inventory.putSource(entry.artifactRef.path);
      entry.artifactDigest = artifactDigest(dependency.bytes);
    }
    const runtimeArtifact = inventory.putJcs(tool.runtimeRef, runtime, true);
    tool.runtimeDigest = artifactDigest(runtimeArtifact.bytes);

    for (const capability of tool.capabilities) {
      for (const [refField, digestField] of [
        ['capabilityRef', 'capabilityDigest'],
        ['entrypointRef', 'entrypointDigest'],
        ['inputContractRef', 'inputContractDigest'],
        ['outputContractRef', 'outputContractDigest'],
        ['discoveryContractRef', 'discoveryContractDigest'],
        ['evidenceSchemaRef', 'evidenceSchemaDigest'],
        ['testVectorsRef', 'testVectorsDigest'],
      ]) {
        const artifact = inventory.putSource(capability[refField].path);
        capability[digestField] = artifactDigest(artifact.bytes);
      }
    }
  }
  const lockRef = pathRef('sourceTree', TOOL_LOCK_REL);
  inventory.putJcs(lockRef, lock, true);
  return { lock, lockRef };
}

function updateSchemaManifest(inventory) {
  const manifest = deepClone(JSON.parse(bytesAt(PROFILE_MANIFEST_REL).toString('utf8')));
  for (const row of manifest.recordTypes) {
    for (const [refField, digestField] of [
      ['plannedInputSchemaRef', 'plannedInputSchemaDigest'],
      ['recordSchemaRef', 'recordSchemaDigest'],
      ['resolvedInputProjectionRef', 'resolvedInputProjectionDigest'],
    ]) {
      const artifact = inventory.putSource(row[refField].path);
      row[digestField] = artifactDigest(artifact.bytes);
    }
  }
  const manifestRef = pathRef('sourceTree', PROFILE_MANIFEST_REL);
  inventory.putJcs(manifestRef, manifest, true);
  return { manifest, manifestRef };
}

function makeOntologyClosure(inventory) {
  const descriptors = [
    ['m3', 'ontology/meta/core-meta-model.yaml'],
    ['m3', 'ontology/meta/cross-domain-patterns.yaml'],
    ['m3', 'ontology/meta/behavior-meta-model.yaml'],
    ['m3', 'ontology/meta/data-binding-meta-model.yaml'],
    ['m2', 'ontology/domain/finance/foundation/module.yaml'],
    ['m2', 'ontology/domain/finance/market-structure/module.yaml'],
    ['m2', 'ontology/domain/finance/instruments/module.yaml'],
    ['m2', 'ontology/domain/finance/market-rules/module.yaml'],
    ['m2', 'ontology/domain/finance/market-data/module.yaml'],
    ['m2', 'ontology/domain/finance/orders-execution/module.yaml'],
    ['m2', 'ontology/domain/finance/portfolio-positions/module.yaml'],
  ].map(([layer, relativePath]) => {
    const document = yaml.load(bytesAt(relativePath).toString('utf8'));
    return { document, layer, relativePath, moduleIri: document.module.moduleIri };
  });
  const byIri = new Map(descriptors.map((entry) => [entry.moduleIri, entry]));
  const completed = new Map();
  while (completed.size < descriptors.length) {
    let progressed = false;
    for (const descriptor of descriptors) {
      if (completed.has(descriptor.moduleIri)) continue;
      const importedIris = (descriptor.document.module.imports || []).map((entry) => (
        entry.moduleIri.replace(/#sha256:[0-9a-f]{64}$/u, '')
      ));
      assert.ok(importedIris.every((iri) => byIri.has(iri)), 'test ontology closure misses an import');
      if (!importedIris.every((iri) => completed.has(iri))) continue;
      const document = deepClone(normalizeOntologyIr(descriptor.document));
      for (const imported of document.module.imports || []) {
        const targetIri = imported.moduleIri.replace(/#sha256:[0-9a-f]{64}$/u, '');
        imported.moduleIri = targetIri;
        imported.version = completed.get(targetIri).row.version;
        imported.artifactDigest = completed.get(targetIri).row.sourceDigest;
      }
      const sourceBytes = Buffer.from(yaml.dump(document, { lineWidth: -1, noRefs: true }));
      const reparsed = yaml.load(sourceBytes.toString('utf8'));
      const sourceRef = pathRef('sourceTree', descriptor.relativePath);
      inventory.put(sourceRef, sourceBytes, 'application/yaml', true);
      const row = {
        layer: descriptor.layer,
        moduleIri: descriptor.moduleIri,
        normalizedIrDigest: taggedJcsDigest(
          descriptor.layer === 'm2'
            ? 'axiolune-normalized-m2-ir-v1\0'
            : 'axiolune-normalized-m3-ir-v1\0',
          normalizeOntologyIr(reparsed),
        ),
        sourceDigest: artifactDigest(sourceBytes),
        sourceRef,
        version: reparsed.module.version,
      };
      completed.set(descriptor.moduleIri, { document: reparsed, row });
      progressed = true;
    }
    assert.ok(progressed, 'test ontology import graph must be acyclic');
  }
  const modules = [...completed.values()].map((entry) => entry.row).sort((left, right) => (
    Buffer.compare(Buffer.from(left.moduleIri), Buffer.from(right.moduleIri))
  ));
  const imports = [];
  for (const [importerModuleIri, state] of completed) {
    for (const imported of state.document.module.imports || []) {
      const importedModuleIri = imported.moduleIri.replace(/#sha256:[0-9a-f]{64}$/u, '');
      const target = completed.get(importedModuleIri);
      imports.push({
        importMode: imported.importMode,
        importedModuleIri,
        importedSourceDigest: target.row.sourceDigest,
        importedVersion: imported.version,
        importerModuleIri,
        selectedSymbols: selectedImportSymbolIris(imported),
      });
    }
  }
  const closure = {
    imports: sortUniqueOntologyImportRows(imports),
    modules,
    schemaVersion: '1.0',
  };
  const ref = pathRef('sourceTree', 'tests/virtual/completed-run/ontology-closure.json');
  inventory.putJcs(ref, closure);
  return { closure, ref };
}

function makeReferenceClosure(inventory) {
  const referenceRef = pathRef(
    'sourceTree',
    'tests/virtual/completed-run/reference/synthetic-reference.json',
  );
  const referenceValue = { evidence: 'completed-run-bundle-test', schemaVersion: '1.0' };
  const referenceArtifact = inventory.putJcs(referenceRef, referenceValue);
  const extractorRef = pathRef(
    'sourceTree',
    'scripts/domain/reference-extractors/whole-file-v1.json',
  );
  const extractorArtifact = inventory.putSource(extractorRef.path);
  const locator = {
    extractorProfileDigest: artifactDigest(extractorArtifact.bytes),
    extractorProfileRef: extractorRef,
    kind: 'wholeFile',
    mediaType: 'application/json',
    path: referenceRef.path,
  };
  locator.selectionDigest = computeSelectionDigest(locator, referenceArtifact.bytes);
  const lock = {
    references: [{
      artifactDigest: artifactDigest(referenceArtifact.bytes),
      artifactRef: referenceRef,
      id: 'axiolune-s5-synthetic-reference',
      locator,
    }],
    schemaVersion: '1.0',
  };
  const lockRef = pathRef(
    'sourceTree',
    'tests/virtual/completed-run/reference/reference-lock.json',
  );
  const lockArtifact = inventory.putJcs(lockRef, lock);
  const closure = {
    entries: [{
      artifactDigest: artifactDigest(referenceArtifact.bytes),
      artifactRef: referenceRef,
      availability: 'localLocked',
      license: 'CC0-1.0 synthetic fixture',
      locators: [locator],
      maturity: 'syntheticTestOnly',
      referenceId: 'axiolune-s5-synthetic-reference',
      releaseOrCommit: 'fixture-v1',
      sourceUrl: 'urn:axiolune:fixture:s5-synthetic-reference',
      usageScope: 'CQ-S5 executable replay fixture only',
    }],
    lockSourceDigest: artifactDigest(lockArtifact.bytes),
    lockSourceRef: lockRef,
    referenceBundleDigest: singleFileBundleDigest(referenceRef.path, referenceArtifact.bytes),
    referenceBundleRef: referenceRef,
    schemaVersion: '1.0',
  };
  const ref = pathRef('sourceTree', 'tests/virtual/completed-run/reference-closure.json');
  inventory.putJcs(ref, closure);
  return { closure, ref };
}

function artifactBinding(name, row) {
  return {
    artifactDigest: artifactDigest(row.bytes),
    artifactRef: row.ref,
    mediaType: row.mediaType,
    name,
  };
}

function makeIdentityCompilation(inventory, mappingInput, options = {}) {
  const mappings = Array.isArray(mappingInput) ? mappingInput : [mappingInput];
  const targetTypes = [...new Set(mappings.map((mapping) => mapping.targetType))];
  assert.equal(targetTypes.length, 1, 'synthetic identity compilation requires one target type');
  const [targetType] = targetTypes;
  const contractRef = 'urn:axiolune:identity-contract:test:completed-run:v1';
  const base = 'tests/virtual/completed-run/identity';
  const registryRef = pathRef('sourceTree', `${base}/term-registry.json`);
  const normalizationSpecification = inventory.put(
    pathRef('sourceTree', `${base}/normalization-specification.txt`),
    Buffer.from('Synthetic canonical identity normalization specification.\n'),
    'text/plain',
  );
  const normalizationImplementation = inventory.put(
    pathRef('sourceTree', `${base}/normalization-implementation.js`),
    Buffer.from("'use strict';\nmodule.exports = (value) => value;\n"),
    'application/javascript',
  );
  const normalizationVectors = inventory.putJcs(
    pathRef('sourceTree', `${base}/normalization-vectors.json`),
    { schemaVersion: '1.0', vectors: [{ input: 'one', output: 'one' }] },
  );

  const termDefinitions = [
    {
      definition: 'Canonical xsd:dateTimeStamp identity term.',
      iri: 'urn:axiolune:identity-term:test:instant:v1',
      label: 'Synthetic instant identity term',
      termContract: {
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#dateTimeStamp',
        termKind: 'literal',
      },
    },
    {
      definition: 'Canonical xsd:string identity term.',
      iri: 'urn:axiolune:identity-term:test:string:v1',
      label: 'Synthetic string identity term',
      termContract: {
        datatypeIri: 'http://www.w3.org/2001/XMLSchema#string',
        termKind: 'literal',
      },
    },
  ];
  const termRows = termDefinitions.map((definition) => ({
    definition,
    termContractDigest: taggedJcsDigest(IDENTITY_TAGS.termContract, definition),
    termContractRef: definition.iri,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.termContractRef),
    Buffer.from(right.termContractRef),
  ));
  const termByRef = new Map(termRows.map((row) => [row.termContractRef, row]));
  const registry = {
    controlledSets: [],
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    termContracts: termRows,
  };
  inventory.putJcs(
    registryRef,
    options.registryArtifactSubstitution === true
      ? { ...registry, profileRef: 'urn:axiolune:profile:substituted' }
      : registry,
  );

  function normalizationRule(suffix, termRef) {
    const term = termByRef.get(termRef);
    const rule = {
      algorithmId: `synthetic_${suffix}`,
      algorithmVersion: '1.0.0',
      definition: `Synthetic normalization for ${suffix}.`,
      implementationDigest: artifactDigest(normalizationImplementation.bytes),
      implementationRef: normalizationImplementation.ref,
      inputTermContractDigest: term.termContractDigest,
      inputTermContractRef: term.termContractRef,
      iri: `urn:axiolune:identity-normalization:test:${suffix}:v1`,
      label: `Synthetic ${suffix} normalization`,
      outputTermContractDigest: term.termContractDigest,
      outputTermContractRef: term.termContractRef,
      specificationDigest: options.normalizationDigestSubstitution === true && suffix === 'string'
        ? `sha256:${'f'.repeat(64)}`
        : artifactDigest(normalizationSpecification.bytes),
      specificationRef: normalizationSpecification.ref,
      testVectorsDigest: artifactDigest(normalizationVectors.bytes),
      testVectorsRef: normalizationVectors.ref,
    };
    return rule;
  }
  const normalizationRules = [
    normalizationRule('instant', 'urn:axiolune:identity-term:test:instant:v1'),
    normalizationRule('string', 'urn:axiolune:identity-term:test:string:v1'),
  ];
  const rulesByIri = new Map(normalizationRules.map((rule) => [rule.iri, rule]));
  const component = (name, semanticValue, termRef, ruleRef) => {
    const term = termByRef.get(termRef);
    const rule = rulesByIri.get(ruleRef);
    return {
      name,
      normalizationRuleDigest: taggedJcsDigest(IDENTITY_TAGS.normalizationRule, rule),
      normalizationRuleRef: rule.iri,
      semanticValue,
      termContractDigest: term.termContractDigest,
      termContractRef: term.termContractRef,
    };
  };

  const derivations = [];
  let logicalSemanticValue = {
    attributeRef: 'https://axiolune.ai/ontology/finance/portfolio-positions/snapshotId',
    containingType: targetType,
    valueKind: 'attributeUse',
  };
  if (options.derivationDigestSubstitution === true
      || options.invalidDerivationSemanticValue === true) {
    const expression = inventory.put(
      pathRef('sourceTree', `${base}/derivation-expression.txt`),
      Buffer.from('externalId\n'),
      'text/plain',
    );
    const implementation = inventory.put(
      pathRef('sourceTree', `${base}/derivation-implementation.js`),
      Buffer.from("'use strict';\nmodule.exports = ({ externalId }) => externalId;\n"),
      'application/javascript',
    );
    const vectors = inventory.putJcs(
      pathRef('sourceTree', `${base}/derivation-vectors.json`),
      { schemaVersion: '1.0', vectors: [{ expected: 'one', input: { externalId: 'one' } }] },
    );
    const derivation = {
      definition: 'Synthetic identity derivation with a substituted external digest.',
      expressionDigest: options.derivationDigestSubstitution === true
        ? `sha256:${'e'.repeat(64)}`
        : artifactDigest(expression.bytes),
      expressionRef: expression.ref,
      implementationDigest: artifactDigest(implementation.bytes),
      implementationRef: implementation.ref,
      inputSemanticValues: [{
        attributeRef: options.invalidDerivationSemanticValue === true
          ? 'urn:axiolune:attribute:test:ghost'
          : 'https://axiolune.ai/ontology/finance/portfolio-positions/snapshotId',
        containingType: targetType,
        valueKind: 'attributeUse',
      }],
      iri: 'urn:axiolune:identity-derivation:test:external-id:v1',
      label: 'Synthetic external identifier derivation',
      outputs: [{
        outputName: 'externalId',
        termContractDigest: termByRef.get('urn:axiolune:identity-term:test:string:v1')
          .termContractDigest,
        termContractRef: 'urn:axiolune:identity-term:test:string:v1',
      }],
      testVectorsDigest: artifactDigest(vectors.bytes),
      testVectorsRef: vectors.ref,
    };
    derivations.push(derivation);
    logicalSemanticValue = {
      derivationDigest: taggedJcsDigest(IDENTITY_TAGS.derivation, derivation),
      derivationRef: derivation.iri,
      outputName: 'externalId',
      valueKind: 'derivation',
    };
  }

  const contract = {
    definition: 'Synthetic exact target identity contract for completed bundle verification.',
    identityBaseIri: 'urn:axiolune:data:test:holding-snapshot',
    iri: contractRef,
    label: 'Synthetic HoldingSnapshot identity contract',
    logicalComponents: [component(
      'externalId',
      logicalSemanticValue,
      'urn:axiolune:identity-term:test:string:v1',
      'urn:axiolune:identity-normalization:test:string:v1',
    )],
    targetType,
    versionComponents: [component(
      'assertionTime',
      {
        containingType: targetType,
        fieldRef: 'https://axiolune.ai/ontology/meta/patterns/attributes/validFrom',
        patternRef: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
        valueKind: 'patternField',
      },
      'urn:axiolune:identity-term:test:instant:v1',
      'urn:axiolune:identity-normalization:test:instant:v1',
    )],
  };
  const compilationMappings = options.identityMappingOmission === true ? [] : [...mappings];
  if (options.identityMappingExtra === true) {
    compilationMappings.push({
      ...deepClone(mappings[0]),
      iri: 'urn:axiolune:mapping:test:extra:v1',
    });
  }
  const compilation = {
    concreteTargetTypes: options.identityTargetSubstitution === true
      ? ['urn:axiolune:type:test:substituted']
      : [targetType],
    contracts: options.missingTargetContract === true ? [] : [contract],
    derivations,
    identityTermRegistry: registry,
    identityTermRegistryDigest: taggedJcsDigest(IDENTITY_TAGS.termRegistry, registry),
    identityTermRegistryRef: registryRef,
    mappings: compilationMappings,
    normalizationRules,
    profileRef: PROFILE_REF,
  };
  if (options.missingIdentityCompilation !== true) {
    inventory.putJcs(
      pathRef('sourceTree', `${base}/identity-compilation.json`),
      compilation,
    );
  }
  return compilation;
}

function makeAlternative(recordType, recordId, plannedInputRef, planned, options = {}) {
  return {
    activation: options.activation || { kind: 'always' },
    attemptId: 'attempt-1',
    finalizationDependencies: options.finalizationDependencies || [],
    plannedInputDigest: plannedInputDigest(recordType, planned),
    plannedInputRef,
    recordId,
    recordType,
  };
}

function makeBase(alternative, build, iri) {
  return {
    attemptId: alternative.attemptId,
    build,
    iri,
    [RECORD_TYPE_ID_FIELD[alternative.recordType]]: alternative.recordId,
    plannedInputDigest: alternative.plannedInputDigest,
    recordType: alternative.recordType,
    schemaVersion: '1.0',
    slotId: alternative.slotId,
  };
}

function finalize(record) {
  const value = { ...record };
  value.resolvedInputDigest = resolvedInputDigest(value);
  return value;
}

function buildBundle(options = {}) {
  const inventory = new ArtifactInventory(options.sourceOverrides || new Map());
  const includeUnselectedMappingReportEvidence =
    options.includeUnselectedMappingReportEvidence === true;
  const outputTargetType = options.targetType
    || 'https://axiolune.ai/ontology/finance/portfolio-positions/HoldingSnapshot';
  const { lock: toolLock, lockRef: toolLockRef } = updateToolLock(inventory);
  const { manifest: schemaManifest, manifestRef: schemaManifestRef } = updateSchemaManifest(inventory);
  inventory.putSource('scripts/domain/lib/m2-pit-validation-request.cjs');
  const ontology = makeOntologyClosure(inventory);
  const references = makeReferenceClosure(inventory);
  const materializerTool = toolLock.tools.find((entry) => (
    entry.toolId === 's5-canonical-materializer'
  ));
  const materializerCapability = materializerTool.capabilities.find((entry) => (
    entry.capabilityId === 's5-canonical-materialization'
  ));

  const dataset = 'urn:axiolune:dataset:test:external-snapshot:v1';
  const snapshotRef = pathRef('sourceTree', 'tests/virtual/completed-run/source-snapshot.json');
  const sourceSchemaRef = pathRef('sourceTree', 'tests/virtual/completed-run/source-schema.json');
  const mappingRef = 'https://axiolune.ai/test/mapping/completed-run';
  const secondMappingRef = 'https://axiolune.ai/test/mapping/completed-run-second';
  const mappingArtifactRef = pathRef('sourceTree', 'tests/virtual/completed-run/mapping.json');
  const secondMappingArtifactRef = pathRef(
    'sourceTree',
    'tests/virtual/completed-run/mapping-second.json',
  );
  const transformationRef = pathRef('sourceTree', 'tests/virtual/completed-run/transformation-closure.json');
  const secondTransformationRef = pathRef(
    'sourceTree',
    'tests/virtual/completed-run/transformation-closure-second.json',
  );
  const transformationDefinitionIri = options.transformationUndeclaredByCapability === true
    ? 'urn:axiolune:transformation:test:undeclared:v1'
    : 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/money-value';
  const transformationDefinitionRef = pathRef(
    'sourceTree',
    'tests/virtual/completed-run/transformation-definition.json',
  );
  const materializationPlanRef = 'https://axiolune.ai/test/plan/completed-run';
  const materializationPlanArtifactRef = pathRef(
    'sourceTree',
    'tests/virtual/completed-run/materialization-plan.json',
  );
  const snapshot = options.invalidSnapshotPayload === true
    ? 'opaque but not a dataset snapshot'
    : {
      dataset,
      rows: [{ externalId: 'one' }],
      schemaVersion: '1.0',
      snapshotTime: '2024-07-10T00:00:00Z',
    };
  const sourceSchema = {
    dataset: options.substituteSchemaDataset || dataset,
    fields: options.emptySchemaFields === true ? [] : [{
      dataType: 'string',
      name: 'externalId',
      nullable: false,
    }],
    schemaVersion: '1.0',
  };
  const directExternalId = {
    bindingType: 'directField',
    source: {
      dataset: 'row',
      field: options.mappingUnknownField === true ? 'ghost_field' : 'externalId',
    },
  };
  const runAssertionTime = {
    bindingType: 'runtimeContext',
    contextField: options.invalidRuntimeContext === true
      ? 'unreviewedContext'
      : 'assertionTime',
  };
  const runIriContext = { bindingType: 'runtimeContext', contextField: 'iri' };
  const mapping = {
    identity: {
      contractRef: 'urn:axiolune:identity-contract:test:completed-run:v1',
      logicalKeyBindings: { externalId: directExternalId },
      versionKeyBindings: { assertionTime: runAssertionTime },
    },
    iri: mappingRef,
    label: 'Completed run canonical semantic mapping',
    mappingType: 'directTable',
    provenance: {
      sourceSystem: options.runtimeContextIri === true ? runIriContext : directExternalId,
    },
    slotMappings: [{
      target: {
        ...(options.unknownParticipantRole === true ? {
          slotType: 'participantRole',
          targetAssociation: 'https://axiolune.ai/ontology/finance/market-data/PriceObservation',
          targetRole: 'ghostRole',
        } : {
          slotType: 'attribute',
          targetAttribute: options.unknownTargetAttribute === true
            ? 'urn:axiolune:attribute:ghost'
            : 'https://axiolune.ai/ontology/finance/portfolio-positions/snapshotId',
        }),
      },
      value: directExternalId,
    }],
    source: {
      datasets: [{
        alias: 'row',
        dataset: options.mappingForeignDataset === true
          ? 'urn:axiolune:dataset:test:foreign-mapping-source:v1'
          : dataset,
      }],
    },
    targetType: options.unknownTargetType === true
      ? 'urn:axiolune:type:ghost'
      : outputTargetType,
    temporal: {
      availabilityTime: { from: runAssertionTime },
      knowledgeTime: { from: runAssertionTime },
      patternRef: options.unknownTemporalPattern === true
        ? 'urn:axiolune:pattern:ghost'
        : 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
      validTime: { from: runAssertionTime },
    },
  };
  if (options.mappingActiveWindow === true) {
    mapping.effectiveDate = '2024-07-10T00:00:01Z';
    mapping.expirationDate = '2024-07-10T00:00:03Z';
  }
  if (options.mappingExpired === true) {
    mapping.effectiveDate = '2024-07-10T00:00:00Z';
    mapping.expirationDate = '2024-07-10T00:00:02Z';
  }
  if (options.mappingFuture === true) {
    mapping.effectiveDate = '2024-07-10T00:00:03Z';
  }
  if (options.mappingInvertedWindow === true) {
    mapping.effectiveDate = '2024-07-10T00:00:03Z';
    mapping.expirationDate = '2024-07-10T00:00:01Z';
  }
  if (options.duplicateSlotMapping === true) {
    mapping.slotMappings.push(deepClone(mapping.slotMappings[0]));
  }
  if (options.malformedMapping === true) mapping.slotMappings = [];
  const includeTransformation = options.validTransformation === true
    || options.invalidTransformationKind === true;
  if (includeTransformation) {
    mapping.slotMappings[0].value = {
      bindingType: 'transformation',
      inputs: {
        amount: directExternalId,
        currency: directExternalId,
        scale: directExternalId,
      },
      transformationRef: transformationDefinitionIri,
    };
  }
  if (options.identityContractRefMissing === true) {
    mapping.identity.contractRef = 'urn:axiolune:identity-contract:test:missing:v1';
  }
  if (options.identityLogicalKeyOmission === true) {
    delete mapping.identity.logicalKeyBindings.externalId;
  }
  if (options.identityLogicalKeyExtra === true) {
    mapping.identity.logicalKeyBindings.smuggled = directExternalId;
  }
  if (options.referenceIdentityCycle === true
      || options.nonIdentityWrongReferenceKeys === true) {
    mapping.slotMappings[0].value = {
      bindingType: 'referenceIdentity',
      keyBindings: options.nonIdentityWrongReferenceKeys === true
        ? { wrongKey: directExternalId }
        : { externalId: directExternalId },
      referenceMode: 'logical',
      targetMappingRef: mappingRef,
    };
  }
  const includeSecondMapping = options.sameTargetEqualPriority === true
    || options.sameTargetDistinctPriority === true
    || options.sameTargetOverlappingWindows === true;
  if (options.sameTargetEqualPriority === true
      || options.sameTargetDistinctPriority === true) {
    mapping.priority = 7;
  }
  if (options.sameTargetOverlappingWindows === true) {
    mapping.effectiveDate = '2024-07-10T00:00:00Z';
    mapping.expirationDate = '2024-07-10T00:00:04Z';
  }
  const secondMapping = includeSecondMapping
    ? {
      ...deepClone(mapping),
      iri: secondMappingRef,
      label: 'Completed run conflicting second semantic mapping',
    }
    : null;
  if (secondMapping !== null && options.sameTargetEqualPriority === true) {
    secondMapping.priority = 7;
  }
  if (secondMapping !== null && options.sameTargetDistinctPriority === true) {
    secondMapping.priority = 8;
  }
  if (secondMapping !== null && options.sameTargetOverlappingWindows === true) {
    secondMapping.effectiveDate = '2024-07-10T00:00:01Z';
    secondMapping.expirationDate = '2024-07-10T00:00:03Z';
  }
  const actualMappings = [mapping, ...(secondMapping === null ? [] : [secondMapping])]
    .sort((left, right) => Buffer.compare(Buffer.from(left.iri), Buffer.from(right.iri)));
  const sourceSchemaBytes = Buffer.from(canonicalJcs(sourceSchema));
  const forgedTransformationArtifact = options.forgedTransformationTuple === true
    ? inventory.put(
      pathRef('sourceTree', 'tests/virtual/completed-run/forged-transformation-runtime.bin'),
      Buffer.from('fully recomputed but unauthorized transformation tuple\n'),
      'application/octet-stream',
    )
    : null;
  const transformationTupleRef = forgedTransformationArtifact?.ref;
  const transformationTupleDigest = forgedTransformationArtifact?.digest;
  const transformationDefinition = includeTransformation ? {
    definition: 'Synthetic reproducible transformation used by completed-run bundle tests.',
    implementation: {
      entrypoint: 'executeCanonicalTransformation',
      runtime: 'javascript',
      scriptPath: options.transformationScriptPathSubstitution === true
        ? 'scripts/domain/lib/substituted-materializer.cjs'
        : 'scripts/domain/lib/s5-canonical-materialization.cjs',
    },
    implementationDigest: materializerCapability.capabilityDigest,
    inputs: {
      amount: { primitiveType: 'string', typeKind: 'primitive' },
      currency: { primitiveType: 'string', typeKind: 'primitive' },
      scale: { primitiveType: 'integer', typeKind: 'primitive' },
    },
    iri: transformationDefinitionIri,
    kind: options.invalidTransformationKind === true
      ? 'SmuggledTransformation'
      : 'ScriptTransformation',
    outputs: {
      typeKind: 'structured',
      typeRef: 'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount',
    },
    testCases: [{
      description: 'Exact Money construction smoke vector.',
      expectedOutput: options.transformationExpectedOutputMismatch === true
        ? { amount: '42.51', currency: 'USD', scale: 2 }
        : { amount: '42.50', currency: 'USD', scale: 2 },
      input: options.transformationTestCaseInputMismatch === true
        ? { smuggled: 'one' }
        : {
          amount: options.transformationSemanticInputInvalid === true ? '042.50' : '42.50',
          currency: 'USD',
          scale: 2,
        },
    }],
    version: options.transformationNonSemver === true ? '01.0' : '1.0.0',
  } : null;
  const transformationDefinitionDigest = transformationDefinition === null
    ? null
    : artifactDigest(Buffer.from(canonicalJcs(transformationDefinition), 'utf8'));
  const transformation = {
    mappingRef,
    schemaVersion: '1.0',
    transformations: includeTransformation ? [{
      capabilityDigest: transformationTupleDigest || materializerCapability.capabilityDigest,
      capabilityId: forgedTransformationArtifact === null
        ? materializerCapability.capabilityId
        : 'forged-materializer',
      capabilityRef: transformationTupleRef || materializerCapability.capabilityRef,
      definitionDigest: transformationDefinitionDigest,
      definitionRef: transformationDefinitionRef,
      dependencies: [],
      implementationDigest: transformationTupleDigest || materializerCapability.entrypointDigest,
      implementationRef: transformationTupleRef || materializerCapability.entrypointRef,
      inputContractDigest: transformationTupleDigest || artifactDigest(sourceSchemaBytes),
      inputContractRef: transformationTupleRef || sourceSchemaRef,
      outputContractDigest: transformationTupleDigest
        || materializerCapability.outputContractDigest,
      outputContractRef: transformationTupleRef || materializerCapability.outputContractRef,
      runtimeDigest: transformationTupleDigest || materializerTool.runtimeDigest,
      runtimeRef: transformationTupleRef || materializerTool.runtimeRef,
      transformationRef: transformationDefinitionIri,
    }] : [],
  };
  const secondTransformation = secondMapping === null ? null : {
    mappingRef: secondMapping.iri,
    schemaVersion: '1.0',
    transformations: [],
  };
  const materializationPlan = {
    definition: 'Synthetic completed-run bundle proof plan.',
    iri: materializationPlanRef,
    label: 'Completed run bundle test',
    materializationMode: 'Full',
    owner: 'repository-owner',
    semanticMappings: actualMappings.map((entry) => entry.iri),
    sourceDatasets: [dataset],
    targetGraphUri: OUTPUT_GRAPH,
    targetOntologyModule: options.targetModuleMismatch === true
      ? 'https://axiolune.ai/ontology/finance/foundation'
      : 'https://axiolune.ai/ontology/finance/portfolio-positions',
  };
  if (options.planUnknownField === true) {
    materializationPlan.unreviewedBehavior = 'smuggled';
  }
  const snapshotArtifact = inventory.putJcs(snapshotRef, snapshot);
  const schemaArtifact = inventory.putJcs(sourceSchemaRef, sourceSchema);
  const mappingArtifact = inventory.putJcs(mappingArtifactRef, mapping);
  const transformationArtifact = inventory.putJcs(transformationRef, transformation);
  const secondMappingArtifact = secondMapping === null
    ? null
    : inventory.putJcs(secondMappingArtifactRef, secondMapping);
  const secondTransformationArtifact = secondTransformation === null
    ? null
    : inventory.putJcs(secondTransformationRef, secondTransformation);
  if (transformationDefinition !== null) {
    inventory.putJcs(transformationDefinitionRef, transformationDefinition);
  }
  const materializationPlanArtifact = inventory.putJcs(
    materializationPlanArtifactRef,
    materializationPlan,
  );
  makeIdentityCompilation(inventory, actualMappings, options);
  let additionalDatasetArtifacts = null;
  if (options.runExtraDataset === true) {
    const additionalDataset = 'urn:axiolune:dataset:test:undeclared-extra:v1';
    const additionalSnapshotRef = pathRef(
      'sourceTree',
      'tests/virtual/completed-run/extra-source-snapshot.json',
    );
    const additionalSchemaRef = pathRef(
      'sourceTree',
      'tests/virtual/completed-run/extra-source-schema.json',
    );
    additionalDatasetArtifacts = {
      dataset: additionalDataset,
      schema: inventory.putJcs(additionalSchemaRef, {
        dataset: additionalDataset,
        fields: [{ dataType: 'string', name: 'externalId', nullable: false }],
        schemaVersion: '1.0',
      }),
      snapshot: inventory.putJcs(additionalSnapshotRef, {
        dataset: additionalDataset,
        rows: [{ externalId: 'extra' }],
        schemaVersion: '1.0',
        snapshotTime: '2024-07-10T00:00:00Z',
      }),
    };
  }

  const schemaManifestDigest = taggedJcsDigest(
    'axiolune-control-record-schema-manifest-v1\0',
    schemaManifest,
  );
  const toolLockDigest = taggedJcsDigest('axiolune-tool-lock-v1\0', toolLock);
  const runPlanned = {
    dependencySelectors: [],
    recordType: 'materializationRun',
    schemaVersion: '1.0',
    staticInputs: { purpose: 'completed-run-bundle-test' },
  };
  const passedPlanned = {
    dependencySelectors: [{
      fieldPointer: '/result/outputGraphDigest',
      sourceSlotId: 'run',
      sourceStage: 'executionOutput',
    }],
    recordType: 'validationReport',
    schemaVersion: '1.0',
    staticInputs: { purpose: 'completed-run-validation' },
  };
  const failedPlanned = {
    dependencySelectors: [{
      fieldPointer: '/result/failureStage',
      sourceSlotId: 'run',
      sourceStage: 'executionOutput',
    }],
    recordType: 'failureReport',
    schemaVersion: '1.0',
    staticInputs: { purpose: 'failed-run-validation' },
  };
  const unselectedReportPlanned = {
    dependencySelectors: [],
    recordType: 'validationReport',
    schemaVersion: '1.0',
    staticInputs: { purpose: 'unselected-mapping-validation-evidence-closure' },
  };
  const runPlannedRef = pathRef('buildEvidence', 'planned/run.json');
  const passedPlannedRef = pathRef('buildEvidence', 'planned/run-report-passed.json');
  const failedPlannedRef = pathRef('buildEvidence', 'planned/run-report-failed.json');
  const unselectedReportPlannedRef = pathRef(
    'buildEvidence',
    'planned/unselected-mapping-report.json',
  );
  inventory.putJcs(runPlannedRef, runPlanned);
  inventory.putJcs(passedPlannedRef, passedPlanned);
  inventory.putJcs(failedPlannedRef, failedPlanned);
  if (includeUnselectedMappingReportEvidence) {
    inventory.putJcs(unselectedReportPlannedRef, unselectedReportPlanned);
  }
  const runAlternative = {
    ...makeAlternative('materializationRun', 'completed-run', runPlannedRef, runPlanned),
    slotId: 'run',
  };
  const passedAlternative = {
    ...makeAlternative(
      'validationReport',
      'completed-run-passed',
      passedPlannedRef,
      passedPlanned,
      { activation: { kind: 'outcomeEquals', parentOutcome: 'completed', parentSlotId: 'run' } },
    ),
    slotId: 'run-report',
  };
  const failedAlternative = {
    ...makeAlternative(
      'failureReport',
      'completed-run-failed',
      failedPlannedRef,
      failedPlanned,
      { activation: { kind: 'outcomeEquals', parentOutcome: 'failed', parentSlotId: 'run' } },
    ),
    slotId: 'run-report',
  };
  const unselectedReportAlternative = includeUnselectedMappingReportEvidence ? {
    ...makeAlternative(
      'validationReport',
      'unselected-mapping-report',
      unselectedReportPlannedRef,
      unselectedReportPlanned,
    ),
    slotId: 'unselected-mapping-report',
  } : null;
  const ledgerPlanned = {
    alternatives: [
      failedAlternative,
      runAlternative,
      passedAlternative,
      ...(unselectedReportAlternative === null ? [] : [unselectedReportAlternative]),
    ].map((entry) => ({
      attemptId: entry.attemptId,
      recordId: entry.recordId,
      recordType: entry.recordType,
      slotId: entry.slotId,
    })).sort((left, right) => Buffer.compare(
      Buffer.from([left.slotId, left.recordType, left.recordId, left.attemptId].join('\0')),
      Buffer.from([right.slotId, right.recordType, right.recordId, right.attemptId].join('\0')),
    )),
    recordType: 'evidenceLedger',
    schemaManifestBinding: {
      artifactDigest: schemaManifestDigest,
      artifactRef: schemaManifestRef,
    },
    schemaVersion: '1.0',
  };
  const ledgerPlannedRef = pathRef('buildEvidence', 'planned/evidence-ledger.json');
  inventory.putJcs(ledgerPlannedRef, ledgerPlanned);
  const ledgerAlternative = {
    ...makeAlternative(
      'evidenceLedger',
      'completed-run-ledger',
      ledgerPlannedRef,
      ledgerPlanned,
      {
        finalizationDependencies: [
          { sourceSlotId: 'run', sourceStage: 'finalRecord', targetStage: 'finalRecord' },
          { sourceSlotId: 'run-report', sourceStage: 'finalRecord', targetStage: 'finalRecord' },
          ...(unselectedReportAlternative === null ? [] : [{
            sourceSlotId: 'unselected-mapping-report',
            sourceStage: 'finalRecord',
            targetStage: 'finalRecord',
          }]),
        ],
      },
    ),
    slotId: 'evidence-ledger',
  };
  const controlPlan = {
    controlRecordSchemaManifestDigest: schemaManifestDigest,
    controlRecordSchemaManifestRef: schemaManifestRef,
    schemaVersion: '1.0',
    slots: [
      {
        alternatives: [{ ...ledgerAlternative, slotId: undefined }].map((entry) => {
          const { slotId, ...withoutSlot } = entry;
          return withoutSlot;
        }),
        cardinality: 'required',
        slotId: 'evidence-ledger',
      },
      {
        alternatives: [{ ...runAlternative, slotId: undefined }].map((entry) => {
          const { slotId, ...withoutSlot } = entry;
          return withoutSlot;
        }),
        cardinality: 'required',
        slotId: 'run',
      },
      {
        alternatives: [failedAlternative, passedAlternative].map((entry) => {
          const { slotId, ...withoutSlot } = entry;
          return withoutSlot;
        }),
        cardinality: 'outcomeChoice',
        slotId: 'run-report',
      },
      ...(unselectedReportAlternative === null ? [] : [{
        alternatives: [{ ...unselectedReportAlternative, slotId: undefined }].map((entry) => {
          const { slotId, ...withoutSlot } = entry;
          return withoutSlot;
        }),
        cardinality: 'required',
        slotId: 'unselected-mapping-report',
      }]),
    ],
  };
  const controlPlanRef = pathRef('buildEvidence', 'control-record-plan.json');
  inventory.putJcs(controlPlanRef, controlPlan);
  const controlPlanDigest = taggedJcsDigest('axiolune-control-record-plan-v1\0', controlPlan);

  const sourceRows = inventory.rows().filter((entry) => entry.ref.kind === 'path'
    && entry.ref.root === 'sourceTree');
  const sourceFiles = sourceRows.map((entry) => ({
    artifactDigest: artifactDigest(entry.bytes),
    byteLength: entry.bytes.length,
    bytes: entry.bytes,
    mode: '100644',
    path: entry.ref.path,
  }));
  const sourceDigest = sourceTreeDigest(sourceFiles);
  const sourceManifest = {
    files: sourceFiles.map(({ bytes, ...entry }) => entry),
    schemaVersion: '1.0',
    sourceTreeDigest: sourceDigest,
  };
  const sourceManifestRef = pathRef('buildEvidence', 'source-tree-manifest.json');
  inventory.putJcs(sourceManifestRef, sourceManifest);
  const buildInputRows = [
    ['mapping', mappingArtifact],
    ['materializationPlan', materializationPlanArtifact],
    ['ontologyClosure', inventory.get(ontology.ref)],
    ['referenceClosure', inventory.get(references.ref)],
    ['snapshot', snapshotArtifact],
    ['sourceSchema', schemaArtifact],
    ['transformationClosure', transformationArtifact],
    ...(secondMappingArtifact === null ? [] : [
      ['mapping-second', secondMappingArtifact],
      ['transformationClosure-second', secondTransformationArtifact],
    ]),
    ...(additionalDatasetArtifacts === null ? [] : [
      ['sourceSchema-extra', additionalDatasetArtifacts.schema],
      ['snapshot-extra', additionalDatasetArtifacts.snapshot],
    ]),
  ].map(([name, row]) => artifactBinding(name, row)).sort((left, right) => (
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
  ));
  const buildInputs = {
    controlRecordPlanDigest: controlPlanDigest,
    controlRecordPlanRef: controlPlanRef,
    controlRecordSchemaManifestDigest: schemaManifestDigest,
    controlRecordSchemaManifestRef: schemaManifestRef,
    inputs: buildInputRows,
    profileRef: PROFILE_REF,
    referenceTime: '2024-07-10T00:00:02Z',
    schemaVersion: '1.0',
    sourceTreeDigest: sourceDigest,
    sourceTreeManifestDigest: taggedJcsDigest('axiolune-source-tree-manifest-v1\0', sourceManifest),
    sourceTreeManifestRef: sourceManifestRef,
    toolLockDigest,
    toolLockRef,
  };
  const buildInputsRef = pathRef('buildEvidence', 'build-inputs.json');
  inventory.putJcs(buildInputsRef, buildInputs);
  const buildInputsDigest = taggedJcsDigest('axiolune-build-inputs-v1\0', buildInputs);
  const buildId = artifactDigest(Buffer.concat([
    Buffer.from('axiolune-build-v1\0'),
    rawDigestBytes(sourceDigest),
    rawDigestBytes(toolLockDigest),
    rawDigestBytes(buildInputsDigest),
  ]));
  const build = {
    buildId,
    buildInputsDigest,
    buildInputsRef,
    controlRecordPlanDigest: controlPlanDigest,
    controlRecordPlanRef: controlPlanRef,
    controlRecordSchemaManifestDigest: schemaManifestDigest,
    controlRecordSchemaManifestRef: schemaManifestRef,
    sourceTreeDigest: sourceDigest,
    toolLockDigest,
    toolLockRef,
  };

  const runIri = controlRecordIri(
    buildId,
    runAlternative.slotId,
    runAlternative.recordType,
    runAlternative.recordId,
    runAlternative.attemptId,
    runAlternative.plannedInputDigest,
  );
  const reportIri = controlRecordIri(
    buildId,
    passedAlternative.slotId,
    passedAlternative.recordType,
    passedAlternative.recordId,
    passedAlternative.attemptId,
    passedAlternative.plannedInputDigest,
  );
  const unselectedReportIri = unselectedReportAlternative === null ? null : controlRecordIri(
    buildId,
    unselectedReportAlternative.slotId,
    unselectedReportAlternative.recordType,
    unselectedReportAlternative.recordId,
    unselectedReportAlternative.attemptId,
    unselectedReportAlternative.plannedInputDigest,
  );
  const ledgerIri = controlRecordIri(
    buildId,
    ledgerAlternative.slotId,
    ledgerAlternative.recordType,
    ledgerAlternative.recordId,
    ledgerAlternative.attemptId,
    ledgerAlternative.plannedInputDigest,
  );
  const factIri = `https://axiolune.ai/test/fact/version/sha256-${crypto.createHash('sha256').update('fact-one').digest('hex')}`;
  const generatingContextIri = options.outputGeneratingContextSubstitution === true
    ? 'urn:axiolune:materialization-run:substituted'
    : runIri;
  const targetNquads = [
    `<${factIri}> <${RDF_TYPE}> <${FACT_VERSION}> <${OUTPUT_GRAPH}> .`,
    ...(options.outputMissingTargetType === true ? [] : [
      `<${factIri}> <${RDF_TYPE}> <${
        options.outputTargetTypeSubstitution === true
          ? 'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSnapshot'
          : outputTargetType
      }> <${OUTPUT_GRAPH}> .`,
    ]),
    `<${factIri}> <${GENERATING_CONTEXT}> "${generatingContextIri}"^^<${XSD_ANY_URI}> <${OUTPUT_GRAPH}> .`,
  ];
  const namedGraphNquads = [
    ...targetNquads,
    ...(options.extraNamedGraph === true ? [
      '<urn:axiolune:test:extra-subject> <urn:axiolune:test:extra-predicate> "extra" <urn:axiolune:graph:test:extra> .',
    ] : []),
  ];
  let output = computeDatasetDigest(`${namedGraphNquads.join('\n')}\n`).canonicalNQuads;
  if (options.extraDefaultGraph === true) {
    output = [
      ...output.trimEnd().split('\n'),
      '<urn:axiolune:test:extra-subject> <urn:axiolune:test:extra-predicate> "extra-default" .',
    ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).join('\n') + '\n';
  }
  const outputArtifact = inventory.put(OUTPUT_REF, Buffer.from(output), 'application/n-quads');
  const graphDigest = computeNamedGraphDigest(`${targetNquads.join('\n')}\n`, OUTPUT_GRAPH).digest;

  const tool = toolLock.tools.find((entry) => entry.toolId === 's5-control-record-chain');
  const capability = tool.capabilities.find((entry) => entry.capabilityId === 's5-control-chain');
  const gateId = 'mapping-materialization.portfolio-valuation';
  const subjectKey = { classifier: 'namedGraph', subjectDigest: graphDigest, subjectRef: OUTPUT_REF };
  const subjectId = taggedJcsDigest('axiolune-gate-subject-v1\0', subjectKey);
  const subjectInventory = {
    discoveryContractDigest: capability.discoveryContractDigest,
    discoveryContractRef: capability.discoveryContractRef,
    gateId,
    schemaVersion: '1.0',
    subjects: [{
      classifier: 'namedGraph',
      subjectDigest: graphDigest,
      subjectId,
      subjectRef: OUTPUT_REF,
    }],
  };
  const subjectInventoryRef = pathRef('buildEvidence', 'gate-evidence/completed-run-proof-subject-inventory.json');
  inventory.putJcs(subjectInventoryRef, subjectInventory);
  const evidence = { outcome: 'passed', schemaVersion: '1.0', targetGraphIri: OUTPUT_GRAPH };
  const evidenceRef = pathRef('buildEvidence', 'gate-evidence/completed-run-proof.json');
  const evidenceArtifact = inventory.putJcs(evidenceRef, evidence);
  const reportInputs = [artifactBinding('snapshot', snapshotArtifact)];
  const check = {
    capabilityDigest: capability.capabilityDigest,
    capabilityId: capability.capabilityId,
    capabilityRef: capability.capabilityRef,
    checkId: 'execute',
    entrypointDigest: capability.entrypointDigest,
    entrypointRef: capability.entrypointRef,
    evidenceDigest: artifactDigest(evidenceArtifact.bytes),
    evidenceRef,
    inputDigests: [artifactDigest(snapshotArtifact.bytes)],
    outputDigests: [graphDigest],
    status: 'passed',
    subjectDigest: graphDigest,
    subjectId,
    subjectRef: OUTPUT_REF,
    toolId: tool.toolId,
  };
  const report = finalize({
    ...makeBase(passedAlternative, build, reportIri),
    capabilityDigest: capability.capabilityDigest,
    capabilityId: capability.capabilityId,
    capabilityRef: capability.capabilityRef,
    criterionRefs: [`${PROFILE_REF}/criteria/5`],
    counts: { discovered: 1, executed: 1, failed: 0, passed: 1, pending: 0, skipped: 0, warnings: 0 },
    discoveryContractDigest: capability.discoveryContractDigest,
    discoveryContractRef: capability.discoveryContractRef,
    entrypointDigest: capability.entrypointDigest,
    entrypointRef: capability.entrypointRef,
    gateId,
    inputs: reportInputs,
    kindEvidence: {
      artifactDigest: artifactDigest(evidenceArtifact.bytes),
      artifactRef: evidenceRef,
      schemaDigest: capability.evidenceSchemaDigest,
      schemaRef: capability.evidenceSchemaRef,
    },
    profileRef: PROFILE_REF,
    reportKind: 'mapping',
    result: { checks: [check], errors: [], outcome: 'passed', violations: [] },
    subjectInventoryDigest: taggedJcsDigest('axiolune-gate-subject-inventory-v1\0', subjectInventory),
    subjectInventoryRef,
    subjectRef: OUTPUT_REF,
    toolId: tool.toolId,
  });
  const reportBytes = canonicalRecordBytes(report);
  const reportRecordRef = pathRef('buildEvidence', 'records/run-report.json');
  inventory.put(reportRecordRef, reportBytes, 'application/json');

  let unselectedReport = null;
  let unselectedReportBytes = null;
  let unselectedReportRecordRef = null;
  let unselectedShaclEvidenceRef = null;
  let unselectedCustomEvidenceRef = null;
  if (unselectedReportAlternative !== null) {
    const unselectedGateId = 'mapping-materialization.unselected';
    const unselectedSubjectInventory = {
      ...deepClone(subjectInventory),
      gateId: unselectedGateId,
    };
    const unselectedSubjectInventoryRef = pathRef(
      'buildEvidence',
      'gate-evidence/unselected-mapping-subject-inventory.json',
    );
    inventory.putJcs(unselectedSubjectInventoryRef, unselectedSubjectInventory);

    unselectedShaclEvidenceRef = pathRef(
      'buildEvidence',
      'gate-evidence/unselected-mapping-current-domain-shacl.json',
    );
    const unselectedShaclEvidenceArtifact = inventory.putJcs(
      unselectedShaclEvidenceRef,
      {
        artifactKind: 's5MaterializedCurrentDomainShaclEvidenceSet',
        outcome: 'passed',
        schemaVersion: '1.0',
      },
    );
    unselectedCustomEvidenceRef = pathRef(
      'buildEvidence',
      'gate-evidence/unselected-mapping-applicable-custom.json',
    );
    const unselectedCustomEvidenceArtifact = inventory.putJcs(
      unselectedCustomEvidenceRef,
      {
        artifactKind: 's5MaterializedApplicableCustomEvidence',
        outcome: 'passed',
        schemaVersion: '1.0',
      },
    );
    const unselectedCombinedEvidenceRef = pathRef(
      'buildEvidence',
      'gate-evidence/unselected-mapping-combined.json',
    );
    const unselectedCombinedEvidenceArtifact = inventory.putJcs(
      unselectedCombinedEvidenceRef,
      {
        artifactKind: 's5MaterializedSHACLAndApplicableCustomEvidence',
        checks: [
          {
            artifactDigest: artifactDigest(unselectedCustomEvidenceArtifact.bytes),
            artifactRef: unselectedCustomEvidenceRef,
            kind: 'applicableCustom',
          },
          {
            artifactDigest: artifactDigest(unselectedShaclEvidenceArtifact.bytes),
            artifactRef: unselectedShaclEvidenceRef,
            kind: 'currentDomainSHACL',
          },
        ],
        outcome: 'passed',
        schemaVersion: '1.0',
        supportDatasetDigest: artifactDigest(Buffer.from('synthetic support dataset\n')),
        targetGraphIri: OUTPUT_GRAPH,
      },
    );
    const unselectedReportInputs = [artifactBinding('snapshot', snapshotArtifact)];
    const unselectedCheck = {
      capabilityDigest: capability.capabilityDigest,
      capabilityId: capability.capabilityId,
      capabilityRef: capability.capabilityRef,
      checkId: 'execute',
      entrypointDigest: capability.entrypointDigest,
      entrypointRef: capability.entrypointRef,
      evidenceDigest: artifactDigest(unselectedCombinedEvidenceArtifact.bytes),
      evidenceRef: unselectedCombinedEvidenceRef,
      inputDigests: [artifactDigest(snapshotArtifact.bytes)],
      outputDigests: [graphDigest],
      status: 'passed',
      subjectDigest: graphDigest,
      subjectId,
      subjectRef: OUTPUT_REF,
      toolId: tool.toolId,
    };
    unselectedReport = finalize({
      ...makeBase(unselectedReportAlternative, build, unselectedReportIri),
      capabilityDigest: capability.capabilityDigest,
      capabilityId: capability.capabilityId,
      capabilityRef: capability.capabilityRef,
      criterionRefs: [`${PROFILE_REF}/criteria/5`],
      counts: {
        discovered: 1,
        executed: 1,
        failed: 0,
        passed: 1,
        pending: 0,
        skipped: 0,
        warnings: 0,
      },
      discoveryContractDigest: capability.discoveryContractDigest,
      discoveryContractRef: capability.discoveryContractRef,
      entrypointDigest: capability.entrypointDigest,
      entrypointRef: capability.entrypointRef,
      gateId: unselectedGateId,
      inputs: unselectedReportInputs,
      kindEvidence: {
        artifactDigest: artifactDigest(unselectedCombinedEvidenceArtifact.bytes),
        artifactRef: unselectedCombinedEvidenceRef,
        schemaDigest: capability.evidenceSchemaDigest,
        schemaRef: capability.evidenceSchemaRef,
      },
      profileRef: PROFILE_REF,
      reportKind: 'mapping',
      result: { checks: [unselectedCheck], errors: [], outcome: 'passed', violations: [] },
      subjectInventoryDigest: taggedJcsDigest(
        'axiolune-gate-subject-inventory-v1\0',
        unselectedSubjectInventory,
      ),
      subjectInventoryRef: unselectedSubjectInventoryRef,
      subjectRef: OUTPUT_REF,
      toolId: tool.toolId,
    });
    unselectedReportBytes = canonicalRecordBytes(unselectedReport);
    unselectedReportRecordRef = pathRef(
      'buildEvidence',
      'records/unselected-mapping-report.json',
    );
    inventory.put(unselectedReportRecordRef, unselectedReportBytes, 'application/json');
  }

  const inputDatasets = [{
    artifactDigest: artifactDigest(snapshotArtifact.bytes),
    dataset,
    rowCount: 1,
    schemaDigest: artifactDigest(schemaArtifact.bytes),
    snapshotRef,
    snapshotTime: '2024-07-10T00:00:00Z',
  }];
  if (additionalDatasetArtifacts !== null) {
    inputDatasets.push({
      artifactDigest: artifactDigest(additionalDatasetArtifacts.snapshot.bytes),
      dataset: additionalDatasetArtifacts.dataset,
      rowCount: 1,
      schemaDigest: artifactDigest(additionalDatasetArtifacts.schema.bytes),
      snapshotRef: additionalDatasetArtifacts.snapshot.ref,
      snapshotTime: '2024-07-10T00:00:00Z',
    });
  }
  const mappingClosure = [
    { mapping, transformation, transformationRef },
    ...(secondMapping === null ? [] : [{
      mapping: secondMapping,
      transformation: secondTransformation,
      transformationRef: secondTransformationRef,
    }]),
  ].map((entry) => ({
    mappingRef: entry.mapping.iri,
    mappingSourceDigest: taggedJcsDigest(
      'axiolune-semantic-mapping-v1\0',
      entry.mapping,
    ),
    transformationClosureDigest: taggedJcsDigest(
      'axiolune-transformation-closure-v1\0',
      entry.transformation,
    ),
    transformationClosureRef: entry.transformationRef,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.mappingRef),
    Buffer.from(right.mappingRef),
  ));
  const run = finalize({
    ...makeBase(runAlternative, build, runIri),
    assertionTime: '2024-07-10T00:00:02Z',
    compilerDigest: capability.capabilityDigest,
    executorDigest: capability.capabilityDigest,
    inputDatasets,
    mappingClosure,
    mappingClosureDigest: mappingClosureDigest(mappingClosure),
    ontologyClosureDigest: taggedJcsDigest('axiolune-ontology-closure-v1\0', ontology.closure),
    ontologyClosureRef: ontology.ref,
    outputRdfCanonicalization: 'RDFC-1.0',
    planRef: materializationPlanRef,
    planSourceDigest: taggedJcsDigest('axiolune-materialization-plan-v1\0', materializationPlan),
    referenceLockDigest: taggedJcsDigest('axiolune-reference-closure-v1\0', references.closure),
    referenceLockRef: references.ref,
    referenceTime: '2024-07-10T00:00:02Z',
    result: {
      outcome: 'completed',
      outputFactVersionCount: 1,
      outputGraph: OUTPUT_GRAPH,
      outputGraphDigest: graphDigest,
      validationReportDigest: artifactDigest(reportBytes),
      validationReportRef: reportIri,
    },
    sourceSchemaClosureDigest: sourceSchemaClosureDigest(inputDatasets),
    sourceSnapshotRootDigest: sourceSnapshotRootDigest(inputDatasets),
    validatorDigest: capability.entrypointDigest,
  });
  const runBytes = canonicalRecordBytes(run);
  const runRecordRef = pathRef('buildEvidence', 'records/run.json');
  inventory.put(runRecordRef, runBytes, 'application/json');

  const recordRows = [
    { alternative: runAlternative, bytes: runBytes, record: run },
    { alternative: passedAlternative, bytes: reportBytes, record: report },
    ...(unselectedReportAlternative === null ? [] : [{
      alternative: unselectedReportAlternative,
      bytes: unselectedReportBytes,
      record: unselectedReport,
    }]),
  ].sort((left, right) => Buffer.compare(
    Buffer.from(left.record.slotId), Buffer.from(right.record.slotId),
  ));
  const ledger = finalize({
    ...makeBase(ledgerAlternative, build, ledgerIri),
    entries: recordRows.map((entry) => ({
      byteLength: entry.bytes.length,
      canonicalization: 'RFC8785-JCS',
      mediaType: 'application/json',
      recordDigest: artifactDigest(entry.bytes),
      recordIri: entry.record.iri,
      recordType: entry.record.recordType,
      slotId: entry.record.slotId,
    })),
    slotSelections: recordRows.map((entry) => ({
      attemptId: entry.record.attemptId,
      recordId: entry.alternative.recordId,
      recordIri: entry.record.iri,
      recordType: entry.record.recordType,
      slotId: entry.record.slotId,
    })),
  });
  const ledgerBytes = canonicalRecordBytes(ledger);
  const ledgerRecordRef = pathRef('buildEvidence', 'records/evidence-ledger.json');
  inventory.put(ledgerRecordRef, ledgerBytes, 'application/json');

  return {
    bundle: { artifacts: inventory.rows(), schemaVersion: '1.0' },
    expectations: {
      evidenceLedger: { iri: ledgerIri, recordDigest: artifactDigest(ledgerBytes) },
      output: {
        artifactRef: OUTPUT_REF,
        factVersionIris: [factIri],
        graphDigest,
        graphIri: OUTPUT_GRAPH,
      },
      run: { iri: runIri, recordDigest: artifactDigest(runBytes) },
      validationReport: { iri: reportIri, recordDigest: artifactDigest(reportBytes) },
    },
    refs: {
      output: OUTPUT_REF,
      run: runRecordRef,
      snapshot: snapshotRef,
      ...(unselectedReportAlternative === null ? {} : {
        unselectedReport: unselectedReportRecordRef,
        unselectedReportCustomEvidence: unselectedCustomEvidenceRef,
        unselectedReportShaclEvidence: unselectedShaclEvidenceRef,
      }),
    },
  };
}

function cloneCase(testCase) {
  return {
    bundle: {
      artifacts: testCase.bundle.artifacts.map((entry) => ({
        bytes: Buffer.from(entry.bytes),
        mediaType: entry.mediaType,
        ref: deepClone(entry.ref),
      })),
      schemaVersion: testCase.bundle.schemaVersion,
    },
    expectations: deepClone(testCase.expectations),
    refs: deepClone(testCase.refs),
  };
}

function artifactByRef(testCase, ref) {
  const row = testCase.bundle.artifacts.find((entry) => refKey(entry.ref) === refKey(ref));
  assert.ok(row, `missing test artifact ${refKey(ref)}`);
  return row;
}

function completedRecordArtifact(testCase, recordType) {
  const matches = testCase.bundle.artifacts.filter((entry) => {
    try {
      const value = JSON.parse(entry.bytes.toString('utf8'));
      return value.recordType === recordType && typeof value.iri === 'string';
    } catch {
      return false;
    }
  });
  assert.equal(matches.length, 1, `expected one final ${recordType} artifact`);
  return matches[0];
}

/**
 * Rewrites the output RDF and then fully reseals every caller-controlled
 * digest/report/ledger field. This models the attack that a pure closed-bundle
 * verifier must reject: all bytes are internally consistent, but no trusted
 * producer independently derived them from the snapshot and mapping.
 */
function resealCompletedBundleOutput(testCase, extraNQuadLines) {
  const outputArtifact = artifactByRef(testCase, testCase.expectations.output.artifactRef);
  const existingLines = outputArtifact.bytes.toString('utf8').trimEnd().split('\n');
  const outputText = computeDatasetDigest(
    `${[...existingLines, ...extraNQuadLines].join('\n')}\n`,
  ).canonicalNQuads;
  outputArtifact.bytes = Buffer.from(outputText, 'utf8');
  const graphDigest = computeNamedGraphDigest(
    outputText,
    testCase.expectations.output.graphIri,
  ).digest;
  testCase.expectations.output.graphDigest = graphDigest;

  const reportArtifact = completedRecordArtifact(testCase, 'validationReport');
  const report = JSON.parse(reportArtifact.bytes.toString('utf8'));
  const inventoryArtifact = artifactByRef(testCase, report.subjectInventoryRef);
  const inventory = JSON.parse(inventoryArtifact.bytes.toString('utf8'));
  const subjectKey = {
    classifier: inventory.subjects[0].classifier,
    subjectDigest: graphDigest,
    subjectRef: inventory.subjects[0].subjectRef,
  };
  const subjectId = taggedJcsDigest('axiolune-gate-subject-v1\0', subjectKey);
  inventory.subjects[0].subjectDigest = graphDigest;
  inventory.subjects[0].subjectId = subjectId;
  inventoryArtifact.bytes = Buffer.from(canonicalJcs(inventory), 'utf8');
  report.subjectInventoryDigest = taggedJcsDigest(
    'axiolune-gate-subject-inventory-v1\0',
    inventory,
  );
  report.result.checks[0].subjectDigest = graphDigest;
  report.result.checks[0].subjectId = subjectId;
  report.result.checks[0].outputDigests = [graphDigest];
  report.resolvedInputDigest = resolvedInputDigest(report);
  reportArtifact.bytes = canonicalRecordBytes(report);
  testCase.expectations.validationReport.recordDigest = artifactDigest(reportArtifact.bytes);

  const runArtifact = completedRecordArtifact(testCase, 'materializationRun');
  const run = JSON.parse(runArtifact.bytes.toString('utf8'));
  run.result.outputGraphDigest = graphDigest;
  run.result.validationReportDigest = artifactDigest(reportArtifact.bytes);
  run.resolvedInputDigest = resolvedInputDigest(run);
  runArtifact.bytes = canonicalRecordBytes(run);
  testCase.expectations.run.recordDigest = artifactDigest(runArtifact.bytes);

  const ledgerArtifact = completedRecordArtifact(testCase, 'evidenceLedger');
  const ledger = JSON.parse(ledgerArtifact.bytes.toString('utf8'));
  for (const entry of ledger.entries) {
    const recordArtifact = entry.recordType === 'materializationRun'
      ? runArtifact
      : reportArtifact;
    entry.byteLength = recordArtifact.bytes.length;
    entry.recordDigest = artifactDigest(recordArtifact.bytes);
  }
  ledger.resolvedInputDigest = resolvedInputDigest(ledger);
  ledgerArtifact.bytes = canonicalRecordBytes(ledger);
  testCase.expectations.evidenceLedger.recordDigest = artifactDigest(ledgerArtifact.bytes);
  return testCase;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code, code);
}

function run() {
  const baseline = buildBundle();
  assert.equal(baseline.expectations.output.artifactRef.kind, 'iri');
  expectCode(
    () => verifyCompletedMaterializationRunBundle(baseline.bundle, baseline.expectations),
    'S5_BUNDLE_REPORT_REPLAY_SHACL',
  );
  expectCode(
    () => verifiedMaterializationRunContext(Object.freeze({})),
    'S5_BUNDLE_UNVERIFIED_SUMMARY',
  );

  {
    const withUnselectedReport = buildBundle({
      includeUnselectedMappingReportEvidence: true,
    });
    expectCode(
      () => verifyCompletedMaterializationRunBundle(
        withUnselectedReport.bundle,
        withUnselectedReport.expectations,
      ),
      'S5_BUNDLE_REPORT_REPLAY_SHACL',
    );
  }

  {
    const missingUnselectedChild = buildBundle({
      includeUnselectedMappingReportEvidence: true,
    });
    const omitted = missingUnselectedChild.bundle.artifacts.findIndex((entry) => (
      refKey(entry.ref) === refKey(missingUnselectedChild.refs.unselectedReportShaclEvidence)
    ));
    assert.notEqual(omitted, -1);
    missingUnselectedChild.bundle.artifacts.splice(omitted, 1);
    expectCode(
      () => verifyCompletedMaterializationRunBundle(
        missingUnselectedChild.bundle,
        missingUnselectedChild.expectations,
      ),
      'S5_BUNDLE_ARTIFACT_MISSING',
    );
  }

  {
    const tamperedUnselectedChild = buildBundle({
      includeUnselectedMappingReportEvidence: true,
    });
    const child = artifactByRef(
      tamperedUnselectedChild,
      tamperedUnselectedChild.refs.unselectedReportCustomEvidence,
    );
    const value = JSON.parse(child.bytes.toString('utf8'));
    value.outcome = 'failed';
    child.bytes = Buffer.from(canonicalJcs(value), 'utf8');
    expectCode(
      () => verifyCompletedMaterializationRunBundle(
        tamperedUnselectedChild.bundle,
        tamperedUnselectedChild.expectations,
      ),
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
    );
  }

  {
    const oversizedInventory = cloneCase(baseline);
    for (let index = 0; index < 4096; index += 1) {
      oversizedInventory.bundle.artifacts.push({
        bytes: Buffer.from('x'),
        mediaType: 'text/plain',
        ref: pathRef('buildEvidence', `oversized-inventory/${index}.txt`),
      });
    }
    expectCode(
      () => verifyCompletedMaterializationRunBundle(
        oversizedInventory.bundle,
        oversizedInventory.expectations,
      ),
      'S5_BUNDLE_LIMIT',
    );
  }

  {
    const workerPath = 'scripts/domain/lib/s5-materialized-shacl-worker.cjs';
    const attackerWorker = Buffer.concat([
      bytesAt(workerPath),
      Buffer.from('\n// attacker-controlled candidate worker bytes\n', 'utf8'),
    ]);
    const resealedRuntime = buildBundle({
      sourceOverrides: new Map([[workerPath, attackerWorker]]),
    });
    expectCode(
      () => verifyCompletedMaterializationRunBundle(
        resealedRuntime.bundle,
        resealedRuntime.expectations,
      ),
      'S5_BUNDLE_REPORT_REPLAY_RUNTIME',
    );
  }

  const outputGraph = baseline.expectations.output.graphIri;
  const [factVersionIri] = baseline.expectations.output.factVersionIris;
  const snapshotId = 'https://axiolune.ai/ontology/finance/portfolio-positions/snapshotId';

  // The baseline mapping declares snapshot.externalId -> snapshotId, while the
  // output omits snapshotId entirely. Internal byte consistency alone must not
  // turn that declaration/output mismatch into a verifier brand.
  assert.doesNotMatch(
    artifactByRef(baseline, baseline.refs.output).bytes.toString('utf8'),
    /snapshotId/u,
  );

  for (const [attackName, attackLine] of [
    [
      'extra-unmapped-property',
      `<${factVersionIri}> <urn:axiolune:property:not-in-mapping> "attacker" <${outputGraph}> .`,
    ],
    [
      'source-output-value-substitution',
      `<${factVersionIri}> <${snapshotId}> "NOT-one" <${outputGraph}> .`,
    ],
    [
      'unmapped-arbitrary-typed-node',
      `<urn:axiolune:rogue> <${RDF_TYPE}> <urn:axiolune:type:rogue> <${outputGraph}> .`,
    ],
  ]) {
    const attack = resealCompletedBundleOutput(buildBundle(), [attackLine]);
    const resealedReport = JSON.parse(
      completedRecordArtifact(attack, 'validationReport').bytes.toString('utf8'),
    );
    const resealedRun = JSON.parse(
      completedRecordArtifact(attack, 'materializationRun').bytes.toString('utf8'),
    );
    assert.equal(resealedReport.result.outcome, 'passed');
    assert.equal(resealedReport.result.checks[0].status, 'passed');
    assert.equal(resealedRun.result.outcome, 'completed');
    assert.equal(
      resealedRun.result.validationReportDigest,
      attack.expectations.validationReport.recordDigest,
    );
    expectCode(
      () => verifyCompletedMaterializationRunBundle(attack.bundle, attack.expectations),
      'S5_BUNDLE_REPORT_REPLAY_SHACL',
    );
    assert.ok(attackName.length > 0);
  }

  {
    const omittedMappingOutput = buildBundle({ sameTargetDistinctPriority: true });
    const runRecord = JSON.parse(
      artifactByRef(omittedMappingOutput, omittedMappingOutput.refs.run).bytes.toString('utf8'),
    );
    assert.equal(runRecord.mappingClosure.length, 2);
    assert.equal(omittedMappingOutput.expectations.output.factVersionIris.length, 1);
    expectCode(
      () => verifyCompletedMaterializationRunBundle(
        omittedMappingOutput.bundle,
        omittedMappingOutput.expectations,
      ),
      'S5_BUNDLE_REPORT_REPLAY_SHACL',
    );
  }

  for (const options of [
    { validTransformation: true },
    { runtimeContextIri: true },
    { mappingActiveWindow: true },
  ]) {
    const declarationOnly = buildBundle(options);
    expectCode(
      () => verifyCompletedMaterializationRunBundle(
        declarationOnly.bundle,
        declarationOnly.expectations,
      ),
      'S5_BUNDLE_REPORT_REPLAY_SHACL',
    );
  }

  {
    const testCase = cloneCase(baseline);
    const snapshot = artifactByRef(testCase, testCase.refs.snapshot);
    snapshot.bytes = Buffer.from(`${snapshot.bytes.toString('utf8')} `);
    assert.throws(() => verifyCompletedMaterializationRunBundle(
      testCase.bundle,
      testCase.expectations,
    ));
  }

  {
    const testCase = cloneCase(baseline);
    const omitted = testCase.bundle.artifacts.findIndex((entry) => (
      entry.ref.kind === 'path'
      && entry.ref.root === 'sourceTree'
      && entry.ref.path === 'ontology/meta/core-meta-model.yaml'
    ));
    assert.notEqual(omitted, -1);
    testCase.bundle.artifacts.splice(omitted, 1);
    expectCode(
      () => verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations),
      'S5_BUNDLE_ARTIFACT_MISSING',
    );
  }

  {
    const testCase = cloneCase(baseline);
    const duplicate = artifactByRef(testCase, testCase.refs.snapshot);
    testCase.bundle.artifacts.push({
      bytes: Buffer.from(duplicate.bytes),
      mediaType: duplicate.mediaType,
      ref: deepClone(duplicate.ref),
    });
    expectCode(
      () => verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations),
      'S5_BUNDLE_DUPLICATE_ARTIFACT',
    );
  }

  {
    const testCase = cloneCase(baseline);
    testCase.bundle.artifacts.push({
      bytes: Buffer.from('unreferenced'),
      mediaType: 'text/plain',
      ref: pathRef('buildEvidence', 'smuggled/unreferenced.txt'),
    });
    expectCode(
      () => verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations),
      'S5_BUNDLE_UNREFERENCED_ARTIFACT',
    );
  }

  {
    const testCase = cloneCase(baseline);
    const output = artifactByRef(testCase, testCase.refs.output);
    const forbiddenRef = pathRef('payload', 'rdf/completed-output.nq');
    testCase.bundle.artifacts.push({
      bytes: Buffer.from(output.bytes),
      mediaType: output.mediaType,
      ref: forbiddenRef,
    });
    testCase.expectations.output.artifactRef = forbiddenRef;
    expectCode(
      () => verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations),
      'S5_CHAIN_ARTIFACT_ROOT',
    );
  }

  {
    const testCase = cloneCase(baseline);
    const runArtifact = artifactByRef(testCase, testCase.refs.run);
    const parsed = JSON.parse(runArtifact.bytes.toString('utf8'));
    runArtifact.bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
    testCase.expectations.run.recordDigest = artifactDigest(runArtifact.bytes);
    expectCode(
      () => verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations),
      'S5_BUNDLE_JCS',
    );
  }

  {
    const testCase = cloneCase(baseline);
    const runArtifact = artifactByRef(testCase, testCase.refs.run);
    const parsed = JSON.parse(runArtifact.bytes.toString('utf8'));
    parsed.result = {
      errors: [{ code: 'TEST_FAILURE', message: 'synthetic failure', stage: 'execution' }],
      failureReportDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      failureReportRef: 'urn:axiolune:test:failure-report',
      failureStage: 'execution',
      outcome: 'failed',
    };
    runArtifact.bytes = Buffer.from(canonicalJcs(parsed));
    testCase.expectations.run.recordDigest = artifactDigest(runArtifact.bytes);
    expectCode(
      () => verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations),
      'S5_BUNDLE_RUN_NOT_COMPLETED',
    );
  }

  {
    const testCase = cloneCase(baseline);
    const outputArtifact = artifactByRef(testCase, testCase.refs.output);
    const altered = outputArtifact.bytes.toString('utf8').replace('/fact/version/', '/wrong/version/');
    outputArtifact.bytes = Buffer.from(computeDatasetDigest(altered).canonicalNQuads);
    expectCode(
      () => verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations),
      'S5_BUNDLE_OUTPUT_BINDING',
    );
  }

  expectCode(
    () => {
      const testCase = buildBundle({ planUnknownField: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_PLAN_SOURCE',
  );

  expectCode(
    () => {
      const testCase = buildBundle({ runExtraDataset: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_PLAN_SOURCE',
  );

  expectCode(
    () => {
      const testCase = buildBundle({
        substituteSchemaDataset: 'urn:axiolune:dataset:test:substituted-schema:v1',
      });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_BUNDLE_SCHEMA_ARTIFACT_MISSING',
  );

  for (const option of ['malformedMapping', 'mappingForeignDataset']) {
    expectCode(
      () => {
        const testCase = buildBundle({ [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_CHAIN_MAPPING',
    );
  }

  expectCode(
    () => {
      const testCase = buildBundle({ invalidRuntimeContext: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_MAPPING',
  );

  for (const option of ['mappingExpired', 'mappingFuture', 'mappingInvertedWindow']) {
    expectCode(
      () => {
        const testCase = buildBundle({ [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_CHAIN_MAPPING_ACTIVATION',
    );
  }

  expectCode(
    () => {
      const testCase = buildBundle({ duplicateSlotMapping: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_MAPPING_CONFLICT',
  );

  for (const option of [
    'sameTargetEqualPriority',
    'sameTargetOverlappingWindows',
  ]) {
    expectCode(
      () => {
        const testCase = buildBundle({ [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_CHAIN_MAPPING_CONFLICT',
    );
  }

  expectCode(
    () => {
      const testCase = buildBundle({ mappingUnknownField: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_SOURCE_SCHEMA',
  );

  expectCode(
    () => {
      const testCase = buildBundle({ emptySchemaFields: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_SOURCE_SNAPSHOT',
  );

  expectCode(
    () => {
      const testCase = buildBundle({ invalidSnapshotPayload: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_SOURCE_SNAPSHOT',
  );

  for (const option of [
    'targetModuleMismatch',
    'unknownParticipantRole',
    'unknownTargetAttribute',
    'unknownTargetType',
    'unknownTemporalPattern',
  ]) {
    expectCode(
      () => {
        const testCase = buildBundle({ [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_CHAIN_ONTOLOGY_TARGET',
    );
  }

  for (const option of [
    'derivationDigestSubstitution',
    'identityContractRefMissing',
    'invalidDerivationSemanticValue',
    'identityLogicalKeyExtra',
    'identityMappingExtra',
    'identityMappingOmission',
    'identityTargetSubstitution',
    'missingIdentityCompilation',
    'missingTargetContract',
    'nonIdentityWrongReferenceKeys',
    'normalizationDigestSubstitution',
    'referenceIdentityCycle',
    'registryArtifactSubstitution',
  ]) {
    expectCode(
      () => {
        const testCase = buildBundle({ [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_CHAIN_IDENTITY_CLOSURE',
    );
  }

  expectCode(
    () => {
      const testCase = buildBundle({ invalidTransformationKind: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CHAIN_TRANSFORMATION',
  );

  for (const option of [
    'forgedTransformationTuple',
    'transformationExpectedOutputMismatch',
    'transformationNonSemver',
    'transformationSemanticInputInvalid',
    'transformationScriptPathSubstitution',
    'transformationTestCaseInputMismatch',
    'transformationUndeclaredByCapability',
  ]) {
    expectCode(
      () => {
        const testCase = buildBundle({ validTransformation: true, [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_CHAIN_TRANSFORMATION',
    );
  }

  expectCode(
    () => {
      const testCase = buildBundle({ outputGeneratingContextSubstitution: true });
      verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
    },
    'S5_CANONICAL_GENERATING_CONTEXT',
  );

  for (const option of ['outputMissingTargetType', 'outputTargetTypeSubstitution']) {
    expectCode(
      () => {
        const testCase = buildBundle({ [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_BUNDLE_OUTPUT_TARGET_TYPE',
    );
  }

  for (const option of ['extraNamedGraph', 'extraDefaultGraph']) {
    expectCode(
      () => {
        const testCase = buildBundle({ [option]: true });
        verifyCompletedMaterializationRunBundle(testCase.bundle, testCase.expectations);
      },
      'S5_BUNDLE_OUTPUT_GRAPH_INVENTORY',
    );
  }

  process.stdout.write('completed MaterializationRun bundle tests: PASS\n');
}

if (require.main === module) {
  run();
}

// Shared only by focused verifier tests. Production code never imports this
// synthetic builder; it exists so downstream PIT tests must consume an actual
// completed-bundle verifier result instead of a caller-manufactured lookalike.
module.exports = {
  buildCompletedMaterializationRunBundleFixture: buildBundle,
  resealCompletedBundleOutputFixture: resealCompletedBundleOutput,
};
