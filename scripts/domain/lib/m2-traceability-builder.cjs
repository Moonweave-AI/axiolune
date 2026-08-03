'use strict';

const crypto = require('node:crypto');
const {
  assertValidTraceabilityManifest,
  compareEdgeTuple,
  semanticNodeId,
  traceabilityManifestDigest,
} = require('./m2-traceability-contract.cjs');
const {
  canonicalJcs,
  validateArtifactRef,
} = require('./strict-source-locator.cjs');
const {
  TAGS: IDENTITY_TAGS,
  taggedJcsDigest,
  validateCompilationInput,
  validateIdentityManifest,
} = require('./identity-contract-compiler.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const TRACE_PROFILE_REF = PROFILE_REF;
const GATE_EXPECTATIONS_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/traceability-gate-expectations.json',
});
const SUBJECT_KINDS = Object.freeze(new Set([
  'targetIdentityContract', 'identityMapping', 'identityTermContract', 'controlledIriSet',
]));
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const IDENTITY_BINDING_ROOT_FIELDS = Object.freeze([
  'schemaVersion', 'profileRef', 'identityManifestRef', 'identityManifestDigest',
  'identityTermRegistryRef', 'identityTermRegistryDigest', 'entries',
]);
const IDENTITY_BINDING_ENTRY_FIELDS = Object.freeze(['subjectKind', 'subjectRef', 'sources']);
const SOURCE_CITATION_FIELDS = Object.freeze([
  'referenceId', 'artifactRef', 'artifactDigest', 'locator', 'usage',
]);
const CQ_BINDING_ROOT_FIELDS = Object.freeze([
  'schemaVersion', 'profileRef', 'cqSourceInventoryRef', 'cqSourceInventoryDigest', 'entries',
]);
const CQ_BINDING_ENTRY_FIELDS = Object.freeze([
  'cqId', 'executionIdentity', 'exercisedPublicIris', 'positiveFixtures', 'negativeFixtures',
]);
const FIXTURE_BINDING_FIELDS = Object.freeze(['fixtureId', 'artifactRef', 'artifactDigest']);

class TraceabilityBuildError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TraceabilityBuildError';
    this.code = code;
    this.details = details;
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function requireArtifactRef(value, label) {
  const validation = validateArtifactRef(value, label);
  if (!validation.ok) {
    throw new TraceabilityBuildError('TRACE_ARTIFACT_REF_INVALID', `${label}: ${validation.errors[0]}`);
  }
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw new TraceabilityBuildError('TRACE_DIGEST_INVALID', `${label} must be sha256:<64 lowercase hex>`);
  }
}

function requireAbsoluteIri(value, label) {
  try {
    if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')
        || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('invalid');
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) throw new Error('invalid');
  } catch {
    throw new TraceabilityBuildError('TRACE_IRI_INVALID', `${label} must be an absolute normalized IRI`);
  }
}

function requireAsciiId(value, label) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new TraceabilityBuildError('TRACE_ASCII_ID_INVALID', `${label} must be a non-empty visible ASCII identifier`);
  }
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function fileArtifactDigest(bytes) {
  return sha256(bytes);
}

function gateCheckIdForIdentity(contractRef) {
  return `identity-${crypto.createHash('sha256').update(Buffer.from(contractRef, 'utf8')).digest('hex')}`;
}

function addNode(nodes, value) {
  const node = { ...value, nodeId: semanticNodeId(value) };
  const existing = nodes.get(node.nodeId);
  if (existing && canonicalJcs(existing) !== canonicalJcs(node)) {
    throw new TraceabilityBuildError('TRACE_NODE_COLLISION', `trace node collision ${node.nodeId}`);
  }
  nodes.set(node.nodeId, node);
  return node;
}

function addEdge(edges, from, to, edgeKind) {
  const edge = { fromNodeId: from.nodeId, toNodeId: to.nodeId, edgeKind };
  edges.set(canonicalJcs(edge), edge);
}

function refKey(ref) {
  return canonicalJcs(ref);
}

function sourceKey(referenceId, artifactRef, artifactDigest, locator) {
  return canonicalJcs({ referenceId, artifactRef, artifactDigest, locator });
}

function buildReferenceIndex(referenceClosure) {
  if (!referenceClosure || referenceClosure.schemaVersion !== '1.0'
      || !Array.isArray(referenceClosure.entries)) {
    throw new TraceabilityBuildError('TRACE_REFERENCE_CLOSURE_INVALID', 'reference closure manifest is invalid');
  }
  const sources = new Map();
  for (const entry of referenceClosure.entries) {
    for (const locator of entry.locators || []) {
      const key = sourceKey(entry.referenceId, entry.artifactRef, entry.artifactDigest, locator);
      if (sources.has(key)) {
        throw new TraceabilityBuildError('TRACE_REFERENCE_SOURCE_DUPLICATE', `duplicate reference locator ${entry.referenceId}`);
      }
      sources.set(key, {
        referenceId: entry.referenceId,
        artifactRef: entry.artifactRef,
        artifactDigest: entry.artifactDigest,
        locator,
      });
    }
  }
  return sources;
}

function normalizeCitation(citation) {
  return {
    referenceId: citation.referenceId,
    artifactRef: citation.artifactRef,
    artifactDigest: citation.artifactDigest,
    locator: citation.locator,
  };
}

function validateSourceCitation(citation, label) {
  if (!hasExactFields(citation, SOURCE_CITATION_FIELDS)
      || !['normative', 'implementation'].includes(citation.usage)) {
    throw new TraceabilityBuildError(
      'TRACE_SOURCE_CITATION_SCHEMA',
      `${label} must be a closed source citation with normative|implementation usage`,
    );
  }
  requireAsciiId(citation.referenceId, `${label}.referenceId`);
  requireArtifactRef(citation.artifactRef, `${label}.artifactRef`);
  requireDigest(citation.artifactDigest, `${label}.artifactDigest`);
}

function validateCitationList(citations, label) {
  if (!Array.isArray(citations) || citations.length === 0) {
    throw new TraceabilityBuildError('TRACE_SOURCE_CITATION_EMPTY', `${label} must be non-empty`);
  }
  let previous = null;
  const locatorKeys = new Set();
  citations.forEach((citation, index) => {
    validateSourceCitation(citation, `${label}[${index}]`);
    if (previous !== null && compareCitationTuple(previous, citation) >= 0) {
      throw new TraceabilityBuildError('TRACE_SOURCE_CITATION_ORDER', `${label} is not strict citation-tuple sorted`);
    }
    previous = citation;
    const locatorKey = sourceKey(
      citation.referenceId,
      citation.artifactRef,
      citation.artifactDigest,
      citation.locator,
    );
    if (locatorKeys.has(locatorKey)) {
      throw new TraceabilityBuildError('TRACE_SOURCE_CITATION_DUPLICATE', `${label} repeats one locator`);
    }
    locatorKeys.add(locatorKey);
  });
}

function compareCitationTuple(left, right) {
  for (const [leftValue, rightValue] of [
    [left.referenceId, right.referenceId],
    [canonicalJcs(left.artifactRef), canonicalJcs(right.artifactRef)],
    [left.artifactDigest, right.artifactDigest],
    [canonicalJcs(left.locator), canonicalJcs(right.locator)],
    [left.usage, right.usage],
  ]) {
    const comparison = compareUtf8(leftValue, rightValue);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function addSourceSupport(context, citation, subject, edgeKind) {
  validateSourceCitation(citation, `source support for ${subject.nodeKind}`);
  const normalized = normalizeCitation(citation);
  const key = sourceKey(
    normalized.referenceId,
    normalized.artifactRef,
    normalized.artifactDigest,
    normalized.locator,
  );
  if (!context.referenceSources.has(key)) {
    throw new TraceabilityBuildError(
      'TRACE_SOURCE_NOT_IN_REFERENCE_CLOSURE',
      `source support for ${subject.nodeKind} is not an exact reference-closure locator`,
      { citation: normalized },
    );
  }
  let source = context.sources.get(key);
  if (!source) {
    source = addNode(context.nodes, { nodeKind: 'sourceLocator', ...normalized });
    context.sources.set(key, source);
  }
  addEdge(context.edges, source, subject, edgeKind);
}

function parseArtifact(resolveArtifact, ref, digest, label) {
  const artifact = resolveArtifact(ref);
  if (!artifact || !Buffer.isBuffer(artifact.bytes)) {
    throw new TraceabilityBuildError('TRACE_ARTIFACT_MISSING', `${label} is missing`, { ref });
  }
  if (fileArtifactDigest(artifact.bytes) !== digest) {
    throw new TraceabilityBuildError('TRACE_ARTIFACT_DIGEST', `${label} raw artifact digest differs`, { ref });
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes));
  } catch (error) {
    throw new TraceabilityBuildError('TRACE_ARTIFACT_PARSE', `${label} cannot be parsed: ${error.message}`, { ref });
  }
  if (!artifact.bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new TraceabilityBuildError('TRACE_ARTIFACT_JCS', `${label} is not exact UTF-8 JCS`, { ref });
  }
  return value;
}

function verifyResolvedArtifact(resolveArtifact, ref, digest, label) {
  requireArtifactRef(ref, `${label} artifactRef`);
  requireDigest(digest, `${label} artifactDigest`);
  const artifact = resolveArtifact(ref);
  if (!artifact || !Buffer.isBuffer(artifact.bytes)) {
    throw new TraceabilityBuildError('TRACE_ARTIFACT_MISSING', `${label} is missing`, { ref });
  }
  const actual = fileArtifactDigest(artifact.bytes);
  if (actual !== digest) {
    throw new TraceabilityBuildError('TRACE_ARTIFACT_DIGEST', `${label} raw artifact digest must be ${actual}`, { ref });
  }
  return artifact;
}

function validatePublicAndTermInputs(publicSymbols, termCards) {
  if (!hasExactFields(publicSymbols, ['schemaVersion', 'profileRef', 'symbols'])
      || publicSymbols.schemaVersion !== '1.0' || publicSymbols.profileRef !== PROFILE_REF
      || !Array.isArray(publicSymbols.symbols)) {
    throw new TraceabilityBuildError('TRACE_PUBLIC_SYMBOL_MANIFEST_INVALID', 'public-symbol manifest is invalid');
  }
  if (!hasExactFields(termCards, [
    'schemaVersion', 'profileRef', 'publicSymbolManifestRef',
    'publicSymbolManifestDigest', 'directEntries', 'generatedEntries',
  ]) || termCards.schemaVersion !== '1.0' || termCards.profileRef !== PROFILE_REF
      || !Array.isArray(termCards.directEntries) || !Array.isArray(termCards.generatedEntries)) {
    throw new TraceabilityBuildError('TRACE_TERM_CARD_MANIFEST_INVALID', 'accepted term-card manifest is missing or invalid');
  }
  requireArtifactRef(termCards.publicSymbolManifestRef, 'term-card publicSymbolManifestRef');
  requireDigest(termCards.publicSymbolManifestDigest, 'term-card publicSymbolManifestDigest');
  let previousSymbol = null;
  for (const [index, symbol] of publicSymbols.symbols.entries()) {
    requireAbsoluteIri(symbol?.publicIri, `public-symbol manifest symbols[${index}].publicIri`);
    if (previousSymbol !== null && compareUtf8(previousSymbol, symbol.publicIri) >= 0) {
      throw new TraceabilityBuildError('TRACE_PUBLIC_SYMBOL_ORDER', 'public-symbol entries are not strictly publicIri-sorted');
    }
    previousSymbol = symbol.publicIri;
  }
  for (const [entries, key, label] of [
    [termCards.directEntries, 'publicIri', 'direct term-card entries'],
    [termCards.generatedEntries, 'generatedIri', 'generated term-card entries'],
  ]) {
    let previous = null;
    for (const [index, entry] of entries.entries()) {
      requireAbsoluteIri(entry?.[key], `${label}[${index}].${key}`);
      if (previous !== null && compareUtf8(previous, entry[key]) >= 0) {
        throw new TraceabilityBuildError('TRACE_TERM_CARD_ORDER', `${label} are not strictly ${key}-sorted`);
      }
      previous = entry[key];
    }
  }
  const direct = new Map(termCards.directEntries.map((entry) => [entry.publicIri, entry]));
  const generated = new Map(termCards.generatedEntries.map((entry) => [entry.generatedIri, entry]));
  if (direct.size !== termCards.directEntries.length || generated.size !== termCards.generatedEntries.length) {
    throw new TraceabilityBuildError('TRACE_TERM_CARD_DUPLICATE', 'term-card entries contain duplicate semantic IRIs');
  }
  const symbolIris = publicSymbols.symbols.map((symbol) => symbol.publicIri);
  const cardIris = [...direct.keys(), ...generated.keys()].sort(compareUtf8);
  if (canonicalJcs([...symbolIris].sort(compareUtf8)) !== canonicalJcs(cardIris)) {
    throw new TraceabilityBuildError('TRACE_TERM_PUBLIC_SET_MISMATCH', 'term-card and public-symbol sets differ');
  }
  for (const entry of direct.values()) {
    if (entry.status !== 'accepted' || entry.review?.decision !== 'accept') {
      throw new TraceabilityBuildError('TRACE_TERM_CARD_NOT_ACCEPTED', `term card ${entry.publicIri} is not accepted`);
    }
    validateCitationList(entry.sourceCitations, `term card ${entry.publicIri} sourceCitations`);
  }
  return { direct, generated };
}

function buildTermAndPublicNodes(context, inputs) {
  const indexes = validatePublicAndTermInputs(inputs.publicSymbols, inputs.termCards);
  const directByRef = new Map(inputs.termCards.directEntries.map((entry) => [refKey(entry.cardRef), entry]));
  const publicNodes = new Map();
  const termNodes = new Map();

  for (const symbol of inputs.publicSymbols.symbols) {
    const publicNode = addNode(context.nodes, {
      nodeKind: 'publicSymbol',
      artifactRef: inputs.termCards.publicSymbolManifestRef,
      artifactDigest: inputs.termCards.publicSymbolManifestDigest,
      publicIri: symbol.publicIri,
    });
    publicNodes.set(symbol.publicIri, publicNode);

    const direct = indexes.direct.get(symbol.publicIri);
    if (direct) {
      const termNode = addNode(context.nodes, {
        nodeKind: 'termCard',
        artifactRef: direct.cardRef,
        artifactDigest: direct.cardDigest,
        publicIri: direct.publicIri,
      });
      termNodes.set(direct.publicIri, termNode);
      addEdge(context.edges, termNode, publicNode, 'definesSymbol');
      for (const citation of direct.sourceCitations) addSourceSupport(context, citation, termNode, 'supportsTerm');
      continue;
    }

    const generated = indexes.generated.get(symbol.publicIri);
    const inheritance = parseArtifact(
      inputs.resolveArtifact,
      generated.inheritanceRecordRef,
      generated.inheritanceRecordDigest,
      `generated inheritance ${generated.generatedIri}`,
    );
    const sourceCard = directByRef.get(refKey(inheritance.sourceCardRef));
    if (!sourceCard || sourceCard.cardDigest !== inheritance.sourceCardDigest) {
      throw new TraceabilityBuildError('TRACE_GENERATED_SOURCE_CARD', `generated term ${generated.generatedIri} has no exact source card`);
    }
    const termNode = addNode(context.nodes, {
      nodeKind: 'termCard',
      artifactRef: generated.inheritanceRecordRef,
      artifactDigest: generated.inheritanceRecordDigest,
      publicIri: generated.generatedIri,
    });
    termNodes.set(generated.generatedIri, termNode);
    addEdge(context.edges, termNode, publicNode, 'definesSymbol');
    for (const citation of sourceCard.sourceCitations) addSourceSupport(context, citation, termNode, 'supportsTerm');
  }
  return { publicNodes, termNodes };
}

function validateIdentitySourceBindings(bindings, identity) {
  if (!hasExactFields(bindings, IDENTITY_BINDING_ROOT_FIELDS)
      || bindings.schemaVersion !== '1.0' || bindings.profileRef !== PROFILE_REF
      || !Array.isArray(bindings.entries)) {
    throw new TraceabilityBuildError('TRACE_IDENTITY_SOURCE_BINDINGS_MISSING', 'identity-source-bindings.json is missing or invalid');
  }
  if (bindings.identityManifestRef == null
      || refKey(bindings.identityManifestRef) !== refKey(identity.manifestRef)
      || bindings.identityManifestDigest !== identity.manifestDigest
      || refKey(bindings.identityTermRegistryRef) !== refKey(identity.registryRef)
      || bindings.identityTermRegistryDigest !== identity.registryDigest) {
    throw new TraceabilityBuildError('TRACE_IDENTITY_SOURCE_BINDING_SCOPE', 'identity source bindings target a different identity closure');
  }
  const result = new Map();
  let previous = null;
  for (const [index, entry] of bindings.entries.entries()) {
    if (!hasExactFields(entry, IDENTITY_BINDING_ENTRY_FIELDS)
        || !SUBJECT_KINDS.has(entry.subjectKind) || typeof entry.subjectRef !== 'string'
        || !Array.isArray(entry.sources) || entry.sources.length === 0) {
      throw new TraceabilityBuildError('TRACE_IDENTITY_SOURCE_BINDING_ENTRY', 'invalid identity source binding entry');
    }
    requireAbsoluteIri(entry.subjectRef, `identity source bindings entries[${index}].subjectRef`);
    validateCitationList(entry.sources, `identity source bindings entries[${index}].sources`);
    const key = `${entry.subjectKind}\0${entry.subjectRef}`;
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      throw new TraceabilityBuildError('TRACE_IDENTITY_SOURCE_BINDING_ORDER', 'identity source bindings are not strictly sorted');
    }
    previous = key;
    result.set(key, entry.sources);
  }
  return result;
}

function componentTermClosure(contract, compilation) {
  const rules = new Map(compilation.normalizationRules.map((row) => [row.iri, row]));
  const derivations = new Map(compilation.derivations.map((row) => [row.iri, row]));
  const terms = new Set();
  const derivationQueue = [];
  for (const component of [...contract.logicalComponents, ...contract.versionComponents]) {
    terms.add(component.termContractRef);
    const rule = rules.get(component.normalizationRuleRef);
    if (!rule) throw new TraceabilityBuildError('TRACE_IDENTITY_RULE_MISSING', `normalization ${component.normalizationRuleRef} is missing`);
    terms.add(rule.inputTermContractRef);
    terms.add(rule.outputTermContractRef);
    if (component.semanticValue?.valueKind === 'derivation') derivationQueue.push(component.semanticValue.derivationRef);
  }
  const seen = new Set();
  while (derivationQueue.length > 0) {
    const ref = derivationQueue.shift();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const derivation = derivations.get(ref);
    if (!derivation) throw new TraceabilityBuildError('TRACE_IDENTITY_DERIVATION_MISSING', `derivation ${ref} is missing`);
    for (const output of derivation.outputs) terms.add(output.termContractRef);
    for (const input of derivation.inputSemanticValues) {
      if (input.valueKind === 'derivation') derivationQueue.push(input.derivationRef);
    }
  }
  return terms;
}

function requireSourceBinding(sourceBindings, kind, ref) {
  const key = `${kind}\0${ref}`;
  const citations = sourceBindings.get(key);
  if (!citations) throw new TraceabilityBuildError('TRACE_IDENTITY_SOURCE_MISSING', `${kind} ${ref} has no reviewed source binding`);
  return citations;
}

function buildIdentityNodes(context, inputs, publicNodes) {
  const identity = inputs.identity;
  if (!identity?.manifest || !identity?.registry || !identity?.compilation) {
    throw new TraceabilityBuildError('TRACE_IDENTITY_CLOSURE_MISSING', 'global materialized identity closure is missing');
  }
  const compilationValidation = validateCompilationInput(identity.compilation);
  if (!compilationValidation.ok) {
    const first = compilationValidation.errors[0];
    throw new TraceabilityBuildError('TRACE_IDENTITY_COMPILATION_INVALID', `${first.code} ${first.path}: ${first.message}`);
  }
  const manifestValidation = validateIdentityManifest(identity.manifest, identity.compilation);
  if (!manifestValidation.ok) {
    const first = manifestValidation.errors[0];
    throw new TraceabilityBuildError('TRACE_IDENTITY_MANIFEST_INVALID', `${first.code} ${first.path}: ${first.message}`);
  }
  const expectedManifestDigest = taggedJcsDigest(IDENTITY_TAGS.identityManifest, identity.manifest);
  const expectedRegistryDigest = taggedJcsDigest(IDENTITY_TAGS.termRegistry, identity.registry);
  if (identity.manifestDigest !== expectedManifestDigest || identity.registryDigest !== expectedRegistryDigest) {
    throw new TraceabilityBuildError('TRACE_IDENTITY_DIGEST', 'identity manifest or registry tagged digest differs');
  }
  if (refKey(identity.compilation.identityTermRegistryRef) !== refKey(identity.registryRef)
      || identity.compilation.identityTermRegistryDigest !== identity.registryDigest
      || canonicalJcs(identity.compilation.identityTermRegistry) !== canonicalJcs(identity.registry)) {
    throw new TraceabilityBuildError('TRACE_IDENTITY_COMPILATION_REGISTRY_JOIN', 'identity compilation does not embed the exact registry');
  }
  if (identity.manifest.identityTermRegistryDigest !== identity.registryDigest
      || refKey(identity.manifest.identityTermRegistryRef) !== refKey(identity.registryRef)) {
    throw new TraceabilityBuildError('TRACE_IDENTITY_REGISTRY_JOIN', 'identity manifest and registry binding differ');
  }
  const sources = validateIdentitySourceBindings(inputs.identitySourceBindings, identity);
  const contractDefinitions = new Map(identity.compilation.contracts.map((row) => [row.iri, row]));
  const termRows = new Map(identity.registry.termContracts.map((row) => [row.termContractRef, row]));
  const setRows = new Map(identity.registry.controlledSets.map((row) => [row.controlledSetRef, row]));
  const usedBindingKeys = new Set();
  const termNodes = new Map();
  const setNodes = new Map();

  function identityTermNode(ref) {
    if (termNodes.has(ref)) return termNodes.get(ref);
    const row = termRows.get(ref);
    if (!row) throw new TraceabilityBuildError('TRACE_IDENTITY_TERM_MISSING', `identity term ${ref} is absent from the registry`);
    const node = addNode(context.nodes, {
      nodeKind: 'identityTermContract',
      identityTermRegistryRef: identity.registryRef,
      identityTermRegistryDigest: identity.registryDigest,
      termContractRef: row.termContractRef,
      termContractDigest: row.termContractDigest,
    });
    termNodes.set(ref, node);
    const key = `identityTermContract\0${ref}`;
    usedBindingKeys.add(key);
    for (const citation of requireSourceBinding(sources, 'identityTermContract', ref)) {
      addSourceSupport(context, citation, node, 'supportsIdentityTerm');
    }
    const controlled = row.definition?.termContract?.referenceMode === 'controlledIri'
      ? row.definition.termContract.controlledSetRef : null;
    if (controlled) {
      let setNode = setNodes.get(controlled);
      if (!setNode) {
        const set = setRows.get(controlled);
        if (!set) throw new TraceabilityBuildError('TRACE_CONTROLLED_SET_MISSING', `controlled set ${controlled} is absent`);
        setNode = addNode(context.nodes, {
          nodeKind: 'controlledIriSet',
          identityTermRegistryRef: identity.registryRef,
          identityTermRegistryDigest: identity.registryDigest,
          controlledSetRef: set.controlledSetRef,
          controlledSetDigest: set.controlledSetDigest,
        });
        setNodes.set(controlled, setNode);
        const setKey = `controlledIriSet\0${controlled}`;
        usedBindingKeys.add(setKey);
        for (const citation of requireSourceBinding(sources, 'controlledIriSet', controlled)) {
          addSourceSupport(context, citation, setNode, 'supportsControlledSet');
        }
      }
      addEdge(context.edges, node, setNode, 'usesControlledSet');
    }
    return node;
  }

  for (const contractRow of identity.manifest.contracts) {
    const publicNode = publicNodes.get(contractRow.targetType);
    if (!publicNode) throw new TraceabilityBuildError('TRACE_IDENTITY_TARGET_NOT_PUBLIC', `identity target ${contractRow.targetType} is not public`);
    const definition = contractDefinitions.get(contractRow.contractRef);
    if (!definition || definition.targetType !== contractRow.targetType) {
      throw new TraceabilityBuildError('TRACE_IDENTITY_CONTRACT_DEFINITION', `identity contract ${contractRow.contractRef} does not resolve`);
    }
    const contractNode = addNode(context.nodes, {
      nodeKind: 'targetIdentityContract',
      identityManifestRef: identity.manifestRef,
      identityManifestDigest: identity.manifestDigest,
      contractRef: contractRow.contractRef,
      contractDigest: contractRow.contractDigest,
      targetType: contractRow.targetType,
    });
    addEdge(context.edges, publicNode, contractNode, 'hasIdentityContract');
    const contractKey = `targetIdentityContract\0${contractRow.contractRef}`;
    usedBindingKeys.add(contractKey);
    for (const citation of requireSourceBinding(sources, 'targetIdentityContract', contractRow.contractRef)) {
      addSourceSupport(context, citation, contractNode, 'supportsIdentity');
    }

    const gate = { gateId: 'target-identity-contract', checkId: gateCheckIdForIdentity(contractRow.contractRef) };
    context.executionSubjects.push({ subject: contractNode, ...gate });
    for (const mapping of contractRow.mappings) {
      const mappingNode = addNode(context.nodes, {
        nodeKind: 'identityMapping',
        identityManifestRef: identity.manifestRef,
        identityManifestDigest: identity.manifestDigest,
        mappingRef: mapping.mappingRef,
        mappingDigest: mapping.mappingDigest,
        targetType: contractRow.targetType,
        contractRef: contractRow.contractRef,
        contractDigest: contractRow.contractDigest,
      });
      addEdge(context.edges, contractNode, mappingNode, 'boundByMapping');
      const mappingKey = `identityMapping\0${mapping.mappingRef}`;
      usedBindingKeys.add(mappingKey);
      for (const citation of requireSourceBinding(sources, 'identityMapping', mapping.mappingRef)) {
        addSourceSupport(context, citation, mappingNode, 'supportsMapping');
      }
      context.executionSubjects.push({ subject: mappingNode, ...gate });
    }

    for (const termRef of componentTermClosure(definition, identity.compilation)) {
      const termNode = identityTermNode(termRef);
      addEdge(context.edges, contractNode, termNode, 'usesIdentityTerm');
      context.executionSubjects.push({ subject: termNode, ...gate });
      for (const edge of context.edges.values()) {
        if (edge.fromNodeId !== termNode.nodeId || edge.edgeKind !== 'usesControlledSet') continue;
        context.executionSubjects.push({ subject: context.nodes.get(edge.toNodeId), ...gate });
      }
    }
  }
  const actualKeys = [...sources.keys()].sort(compareUtf8);
  const usedKeys = [...usedBindingKeys].sort(compareUtf8);
  if (canonicalJcs(actualKeys) !== canonicalJcs(usedKeys)) {
    throw new TraceabilityBuildError('TRACE_IDENTITY_SOURCE_SET', 'identity source bindings contain missing or unused subjects', { actualKeys, usedKeys });
  }
  const registryTerms = [...termRows.keys()].sort(compareUtf8);
  const usedTerms = [...termNodes.keys()].sort(compareUtf8);
  const registrySets = [...setRows.keys()].sort(compareUtf8);
  const usedSets = [...setNodes.keys()].sort(compareUtf8);
  if (canonicalJcs(registryTerms) !== canonicalJcs(usedTerms)
      || canonicalJcs(registrySets) !== canonicalJcs(usedSets)) {
    throw new TraceabilityBuildError(
      'TRACE_IDENTITY_REGISTRY_UNUSED_ENTRY',
      'identity registry contains an entry outside the materialized identity closure',
      { registryTerms, usedTerms, registrySets, usedSets },
    );
  }
}

function resolveConstraintTargetPublicNode(targetRef, publicNodes) {
  const direct = publicNodes.get(targetRef);
  if (direct) return direct;
  let candidate = null;
  for (const publicIri of publicNodes.keys()) {
    if (!targetRef.startsWith(`${publicIri}/`)) continue;
    if (candidate === null || publicIri.length > candidate.publicIri.length) {
      candidate = publicNodes.get(publicIri);
    }
  }
  return candidate || null;
}

function buildConstraintNodes(context, inputs, publicNodes) {
  const artifact = inputs.constraintArtifact;
  const manifest = artifact?.value;
  if (!artifact || !Buffer.isBuffer(artifact.bytes)) {
    throw new TraceabilityBuildError('TRACE_CONSTRAINT_MANIFEST_MISSING', 'constraint-instance manifest bytes are missing');
  }
  requireArtifactRef(artifact.ref, 'constraint-instance manifest ref');
  requireDigest(artifact.digest, 'constraint-instance manifest digest');
  if (fileArtifactDigest(artifact.bytes) !== artifact.digest
      || !artifact.bytes.equals(Buffer.from(canonicalJcs(manifest), 'utf8'))) {
    throw new TraceabilityBuildError('TRACE_CONSTRAINT_MANIFEST_DIGEST', 'constraint-instance manifest bytes/digest/value differ');
  }
  if (!hasExactFields(manifest, ['schemaVersion', 'profileRef', 'entries'])
      || manifest.schemaVersion !== '1.0' || manifest.profileRef !== PROFILE_REF
      || !Array.isArray(manifest.entries)
      || manifest.entries.length === 0) {
    throw new TraceabilityBuildError('TRACE_CONSTRAINT_MANIFEST_MISSING', 'constraint-instance manifest is missing or invalid');
  }
  let previousConstraintId = null;
  for (const [entryIndex, entry] of manifest.entries.entries()) {
    const baseFields = [
      'constraintInstanceId', 'originKind', 'originRef', 'targetRef',
      'component', 'severity', 'generatedOrAuthored',
      'positiveExpectation', 'negativeExpectation',
    ];
    const hasPath = isPlainObject(entry)
      && (Object.hasOwn(entry, 'pathKind') || Object.hasOwn(entry, 'path'));
    if (!hasExactFields(entry, hasPath ? [...baseFields, 'pathKind', 'path'] : baseFields)
        || !/^[0-9a-f]{64}$/u.test(entry.constraintInstanceId || '')) {
      throw new TraceabilityBuildError('TRACE_CONSTRAINT_ENTRY_SCHEMA', `constraint manifest entry ${entryIndex} is not closed or has an invalid stable ID`);
    }
    if (previousConstraintId !== null
        && compareUtf8(previousConstraintId, entry.constraintInstanceId) >= 0) {
      throw new TraceabilityBuildError('TRACE_CONSTRAINT_ENTRY_ORDER', 'constraint manifest entries are not strictly constraintInstanceId-sorted');
    }
    previousConstraintId = entry.constraintInstanceId;
    requireAbsoluteIri(entry.originRef, `constraint ${entry.constraintInstanceId} originRef`);
    requireAbsoluteIri(entry.targetRef, `constraint ${entry.constraintInstanceId} targetRef`);
    requireAbsoluteIri(entry.component, `constraint ${entry.constraintInstanceId} component`);
    if (!['constraintDefinition', 'generatedConstraint'].includes(entry.originKind)
        || !['violation', 'warning', 'info'].includes(entry.severity)
        || !['generated', 'authored'].includes(entry.generatedOrAuthored)
        || (entry.originKind === 'constraintDefinition') !== (entry.generatedOrAuthored === 'authored')) {
      throw new TraceabilityBuildError('TRACE_CONSTRAINT_ENTRY_KIND', `constraint ${entry.constraintInstanceId} origin/severity/authorship is invalid`);
    }
    if (hasPath) {
      if (entry.pathKind === 'iri') requireAbsoluteIri(entry.path, `constraint ${entry.constraintInstanceId} path`);
      else if (entry.pathKind === 'posixPath') {
        if (typeof entry.path !== 'string' || entry.path.length === 0
            || entry.path !== entry.path.normalize('NFC') || entry.path.includes('\\')
            || entry.path.startsWith('/') || /^[A-Za-z]:/u.test(entry.path)
            || entry.path.split('/').some((segment) => ['', '.', '..'].includes(segment))) {
          throw new TraceabilityBuildError('TRACE_CONSTRAINT_PATH', `constraint ${entry.constraintInstanceId} path is not a canonical POSIX relative path`);
        }
      } else {
        throw new TraceabilityBuildError('TRACE_CONSTRAINT_PATH_KIND', `constraint ${entry.constraintInstanceId} pathKind is invalid`);
      }
    }
    const publicNode = resolveConstraintTargetPublicNode(entry.targetRef, publicNodes);
    if (!publicNode) continue;
    const constraintNode = addNode(context.nodes, {
      nodeKind: 'constraintInstance',
      artifactRef: artifact.ref,
      artifactDigest: artifact.digest,
      constraintInstanceId: entry.constraintInstanceId,
      targetPublicIri: publicNode.publicIri,
    });
    addEdge(context.edges, publicNode, constraintNode, 'hasConstraint');
    const gate = { gateId: 'shacl-execution', checkId: entry.constraintInstanceId };
    context.executionSubjects.push({ subject: constraintNode, ...gate });
    for (const [polarity, expectation, edgeKind] of [
      ['positiveFixture', entry.positiveExpectation, 'hasPositiveCase'],
      ['negativeFixture', entry.negativeExpectation, 'hasNegativeCase'],
    ]) {
      if (!hasExactFields(expectation, [
        'fixtureId', 'artifactRef', 'artifactDigest', 'schemaRef', 'schemaDigest',
        'expectedResult',
      ])) {
        throw new TraceabilityBuildError('TRACE_CONSTRAINT_EXPECTATION_SCHEMA', `${entry.constraintInstanceId} ${polarity} expectation is not closed`);
      }
      const expectedResult = polarity === 'positiveFixture' ? 'conforms' : 'violates';
      if (expectation.expectedResult !== expectedResult) {
        throw new TraceabilityBuildError('TRACE_CONSTRAINT_EXPECTATION_RESULT', `${entry.constraintInstanceId} ${polarity} expectedResult must be ${expectedResult}`);
      }
      requireAsciiId(expectation.fixtureId, `${entry.constraintInstanceId} ${polarity} fixtureId`);
      requireArtifactRef(expectation.schemaRef, `${entry.constraintInstanceId} ${polarity} schemaRef`);
      requireDigest(expectation.schemaDigest, `${entry.constraintInstanceId} ${polarity} schemaDigest`);
      verifyResolvedArtifact(inputs.resolveArtifact, expectation.artifactRef, expectation.artifactDigest, `${entry.constraintInstanceId} ${polarity}`);
      verifyResolvedArtifact(inputs.resolveArtifact, expectation.schemaRef, expectation.schemaDigest, `${entry.constraintInstanceId} ${polarity} schema`);
      const fixture = addNode(context.nodes, {
        nodeKind: polarity,
        artifactRef: expectation.artifactRef,
        artifactDigest: expectation.artifactDigest,
        fixtureId: expectation.fixtureId,
      });
      addEdge(context.edges, constraintNode, fixture, edgeKind);
      context.executionSubjects.push({ subject: fixture, ...gate });
    }
    if (refKey(entry.positiveExpectation.artifactRef) === refKey(entry.negativeExpectation.artifactRef)
        || entry.positiveExpectation.artifactDigest === entry.negativeExpectation.artifactDigest) {
      throw new TraceabilityBuildError('TRACE_CONSTRAINT_FIXTURE_NOT_DISTINCT', `constraint ${entry.constraintInstanceId} positive and negative artifacts are not distinct`);
    }
  }
}

function compareFixtureBinding(left, right) {
  return compareUtf8(
    `${left.fixtureId}\0${canonicalJcs(left.artifactRef)}`,
    `${right.fixtureId}\0${canonicalJcs(right.artifactRef)}`,
  );
}

function validateFixtureBindings(fixtures, label) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new TraceabilityBuildError('TRACE_CQ_FIXTURE_EMPTY', `${label} must be non-empty`);
  }
  let previous = null;
  fixtures.forEach((fixture, index) => {
    if (!hasExactFields(fixture, FIXTURE_BINDING_FIELDS)) {
      throw new TraceabilityBuildError('TRACE_CQ_FIXTURE_SCHEMA', `${label}[${index}] is not a closed fixture binding`);
    }
    requireAsciiId(fixture.fixtureId, `${label}[${index}].fixtureId`);
    requireArtifactRef(fixture.artifactRef, `${label}[${index}].artifactRef`);
    requireDigest(fixture.artifactDigest, `${label}[${index}].artifactDigest`);
    if (previous !== null && compareFixtureBinding(previous, fixture) >= 0) {
      throw new TraceabilityBuildError('TRACE_CQ_FIXTURE_ORDER', `${label} is not strictly fixture/ref sorted`);
    }
    previous = fixture;
  });
}

function validateCqInventory(artifact) {
  if (!artifact || !hasExactFields(artifact.value, ['schemaVersion', 'profileRef', 'entries'])
      || artifact.value.schemaVersion !== '1.0' || artifact.value.profileRef !== PROFILE_REF
      || !Array.isArray(artifact.value.entries)) {
    throw new TraceabilityBuildError('TRACE_CQ_INVENTORY_INVALID', 'CQ source inventory is missing or invalid');
  }
  requireArtifactRef(artifact.ref, 'CQ source inventory ref');
  requireDigest(artifact.digest, 'CQ source inventory digest');
  const actual = fileArtifactDigest(Buffer.from(canonicalJcs(artifact.value), 'utf8'));
  if (actual !== artifact.digest) {
    throw new TraceabilityBuildError('TRACE_CQ_INVENTORY_DIGEST', `CQ source inventory digest must be ${actual}`);
  }
  const byId = new Map();
  let previous = null;
  for (const [index, entry] of artifact.value.entries.entries()) {
    if (!hasExactFields(entry, [
      'cqId', 'status', 'executionIdentity', 'aliasOf', 'sourceRef', 'sourceDigest',
    ]) || !['active', 'retired', 'deferred'].includes(entry.status)
        || (entry.aliasOf !== null && typeof entry.aliasOf !== 'string')) {
      throw new TraceabilityBuildError('TRACE_CQ_INVENTORY_ENTRY', `CQ source inventory entry ${index} is invalid`);
    }
    requireAsciiId(entry.cqId, `CQ source inventory entries[${index}].cqId`);
    requireAsciiId(entry.executionIdentity, `CQ source inventory entries[${index}].executionIdentity`);
    requireArtifactRef(entry.sourceRef, `CQ source inventory entries[${index}].sourceRef`);
    requireDigest(entry.sourceDigest, `CQ source inventory entries[${index}].sourceDigest`);
    if (previous !== null && compareUtf8(previous, entry.cqId) >= 0) {
      throw new TraceabilityBuildError('TRACE_CQ_INVENTORY_ORDER', 'CQ source inventory is not strictly cqId-sorted');
    }
    previous = entry.cqId;
    byId.set(entry.cqId, entry);
  }
  return byId;
}

function validateCqBindings(bindings, inventoryArtifact) {
  const inventory = validateCqInventory(inventoryArtifact);
  if (!hasExactFields(bindings, CQ_BINDING_ROOT_FIELDS)
      || bindings.schemaVersion !== '1.0' || bindings.profileRef !== PROFILE_REF
      || !Array.isArray(bindings.entries) || bindings.entries.length === 0) {
    throw new TraceabilityBuildError('TRACE_CQ_BINDINGS_MISSING', 'cq-traceability-bindings.json is missing or invalid');
  }
  if (refKey(bindings.cqSourceInventoryRef) !== refKey(inventoryArtifact.ref)
      || bindings.cqSourceInventoryDigest !== inventoryArtifact.digest) {
    throw new TraceabilityBuildError('TRACE_CQ_BINDING_SCOPE', 'CQ bindings target a different source inventory');
  }
  const activeIds = [...inventory.values()]
    .filter((entry) => entry.status === 'active')
    .map((entry) => entry.cqId)
    .sort(compareUtf8);
  let previous = null;
  for (const [index, entry] of bindings.entries.entries()) {
    if (!hasExactFields(entry, CQ_BINDING_ENTRY_FIELDS)
        || typeof entry.cqId !== 'string' || typeof entry.executionIdentity !== 'string'
        || !CHECK_ID_RE.test(entry.executionIdentity)
        || !Array.isArray(entry.exercisedPublicIris) || entry.exercisedPublicIris.length === 0
        || !Array.isArray(entry.positiveFixtures) || entry.positiveFixtures.length === 0
        || !Array.isArray(entry.negativeFixtures) || entry.negativeFixtures.length === 0) {
      throw new TraceabilityBuildError('TRACE_CQ_BINDING_ENTRY', `CQ binding ${String(entry.cqId)} is incomplete`);
    }
    const source = inventory.get(entry.cqId);
    if (!source || source.status !== 'active' || source.executionIdentity !== entry.executionIdentity) {
      throw new TraceabilityBuildError('TRACE_CQ_BINDING_SOURCE_JOIN', `CQ binding ${entry.cqId} does not join one active inventory row`);
    }
    let previousIri = null;
    entry.exercisedPublicIris.forEach((publicIri, publicIndex) => {
      requireAbsoluteIri(publicIri, `CQ bindings entries[${index}].exercisedPublicIris[${publicIndex}]`);
      if (previousIri !== null && compareUtf8(previousIri, publicIri) >= 0) {
        throw new TraceabilityBuildError('TRACE_CQ_PUBLIC_IRI_ORDER', `CQ binding ${entry.cqId} public IRIs are not strictly sorted`);
      }
      previousIri = publicIri;
    });
    validateFixtureBindings(entry.positiveFixtures, `CQ binding ${entry.cqId} positiveFixtures`);
    validateFixtureBindings(entry.negativeFixtures, `CQ binding ${entry.cqId} negativeFixtures`);
    for (const positive of entry.positiveFixtures) {
      for (const negative of entry.negativeFixtures) {
        if (positive.fixtureId === negative.fixtureId
            || refKey(positive.artifactRef) === refKey(negative.artifactRef)
            || positive.artifactDigest === negative.artifactDigest) {
          throw new TraceabilityBuildError(
            'TRACE_CQ_FIXTURE_NOT_DISTINCT',
            `CQ ${entry.cqId} positive and negative fixture identities, artifacts, and bytes must be distinct`,
          );
        }
      }
    }
    if (previous !== null && compareUtf8(previous, entry.cqId) >= 0) {
      throw new TraceabilityBuildError('TRACE_CQ_BINDING_ORDER', 'CQ bindings are not strictly cqId-sorted');
    }
    previous = entry.cqId;
  }
  if (canonicalJcs(bindings.entries.map((entry) => entry.cqId)) !== canonicalJcs(activeIds)) {
    throw new TraceabilityBuildError('TRACE_CQ_BINDING_SET', 'CQ bindings differ from the complete active source inventory');
  }
  return inventory;
}

function buildCqNodes(context, inputs, publicNodes) {
  const inventory = validateCqBindings(inputs.cqBindings, inputs.cqInventoryArtifact);
  for (const entry of inputs.cqBindings.entries) {
    const source = inventory.get(entry.cqId);
    verifyResolvedArtifact(inputs.resolveArtifact, source.sourceRef, source.sourceDigest, `CQ source ${entry.cqId}`);
    const cqNode = addNode(context.nodes, {
      nodeKind: 'competencyQuestion',
      artifactRef: source.sourceRef,
      artifactDigest: source.sourceDigest,
      cqId: entry.cqId,
      executionIdentity: entry.executionIdentity,
    });
    for (const publicIri of entry.exercisedPublicIris) {
      const publicNode = publicNodes.get(publicIri);
      if (!publicNode) throw new TraceabilityBuildError('TRACE_CQ_TARGET_NOT_PUBLIC', `CQ ${entry.cqId} exercises unknown public IRI ${publicIri}`);
      addEdge(context.edges, publicNode, cqNode, 'hasExercise');
    }
    const gate = { gateId: 'cq-coverage-execution', checkId: entry.executionIdentity };
    context.executionSubjects.push({ subject: cqNode, ...gate });
    for (const [kind, fixtures, edgeKind] of [
      ['positiveFixture', entry.positiveFixtures, 'hasPositiveCase'],
      ['negativeFixture', entry.negativeFixtures, 'hasNegativeCase'],
    ]) {
      for (const fixtureEntry of fixtures) {
        verifyResolvedArtifact(inputs.resolveArtifact, fixtureEntry.artifactRef, fixtureEntry.artifactDigest, `CQ ${entry.cqId} fixture ${fixtureEntry.fixtureId}`);
        const fixture = addNode(context.nodes, { nodeKind: kind, ...fixtureEntry });
        addEdge(context.edges, cqNode, fixture, edgeKind);
        context.executionSubjects.push({ subject: fixture, ...gate });
      }
    }
  }
}

function finalizeGateExpectations(context) {
  const bySubjectPair = new Map();
  for (const row of context.executionSubjects) {
    if (!CHECK_ID_RE.test(row.gateId) || !CHECK_ID_RE.test(row.checkId)) {
      throw new TraceabilityBuildError('TRACE_GATE_CHECK_ID', `invalid gate/check pair ${row.gateId}/${row.checkId}`);
    }
    const key = `${row.subject.nodeId}\0${row.gateId}\0${row.checkId}`;
    bySubjectPair.set(key, row);
  }
  const expectationRows = [...bySubjectPair.values()]
    .map((row) => ({
      subjectNodeId: row.subject.nodeId,
      subjectNodeKind: row.subject.nodeKind,
      gateId: row.gateId,
      checkId: row.checkId,
    }))
    .sort((left, right) => {
      for (const field of ['gateId', 'checkId', 'subjectNodeId']) {
        const comparison = compareUtf8(left[field], right[field]);
        if (comparison !== 0) return comparison;
      }
      return 0;
    });
  const artifact = { schemaVersion: '1.0', profileRef: PROFILE_REF, expectations: expectationRows };
  const artifactDigest = fileArtifactDigest(Buffer.from(canonicalJcs(artifact), 'utf8'));
  const gates = new Map();
  for (const row of bySubjectPair.values()) {
    const pair = `${row.gateId}\0${row.checkId}`;
    let gate = gates.get(pair);
    if (!gate) {
      gate = addNode(context.nodes, {
        nodeKind: 'gateCheckExpectation',
        artifactRef: GATE_EXPECTATIONS_REF,
        artifactDigest,
        gateId: row.gateId,
        checkId: row.checkId,
      });
      gates.set(pair, gate);
    }
    addEdge(context.edges, row.subject, gate, 'executedAs');
  }
  return { artifact, artifactDigest };
}

function buildTraceabilityManifest(inputs) {
  if (typeof inputs.resolveArtifact !== 'function') {
    throw new TraceabilityBuildError('TRACE_RESOLVER_MISSING', 'an artifact resolver is required');
  }
  const context = {
    nodes: new Map(),
    edges: new Map(),
    sources: new Map(),
    referenceSources: buildReferenceIndex(inputs.referenceClosure),
    executionSubjects: [],
  };
  const { publicNodes } = buildTermAndPublicNodes(context, inputs);
  buildIdentityNodes(context, inputs, publicNodes);
  buildConstraintNodes(context, inputs, publicNodes);
  buildCqNodes(context, inputs, publicNodes);
  const gateExpectations = finalizeGateExpectations(context);
  const manifest = {
    schemaVersion: '1.0',
    profileRef: TRACE_PROFILE_REF,
    nodes: [...context.nodes.values()].sort((left, right) => compareUtf8(left.nodeId, right.nodeId)),
    edges: [...context.edges.values()].sort(compareEdgeTuple),
  };
  const validation = assertValidTraceabilityManifest(manifest);
  return {
    manifest,
    manifestDigest: traceabilityManifestDigest(manifest),
    gateExpectations: gateExpectations.artifact,
    gateExpectationsDigest: gateExpectations.artifactDigest,
    stats: {
      nodeCount: validation.nodeCount,
      edgeCount: validation.edgeCount,
      sourceLocatorCount: manifest.nodes.filter((node) => node.nodeKind === 'sourceLocator').length,
      publicSymbolCount: publicNodes.size,
      identityContractCount: manifest.nodes.filter((node) => node.nodeKind === 'targetIdentityContract').length,
      constraintInstanceCount: manifest.nodes.filter((node) => node.nodeKind === 'constraintInstance').length,
      competencyQuestionCount: manifest.nodes.filter((node) => node.nodeKind === 'competencyQuestion').length,
      gateExpectationCount: manifest.nodes.filter((node) => node.nodeKind === 'gateCheckExpectation').length,
    },
  };
}

module.exports = {
  GATE_EXPECTATIONS_REF,
  PROFILE_REF,
  TRACE_PROFILE_REF,
  TraceabilityBuildError,
  buildTraceabilityManifest,
  fileArtifactDigest,
  gateCheckIdForIdentity,
};
