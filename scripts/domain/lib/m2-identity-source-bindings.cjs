'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  GLOBAL_MANIFEST_REF,
  GLOBAL_REGISTRY_REF,
  compileMaterializedIdentityClosure,
} = require('./m2-materialized-identity-closure.cjs');
const {
  artifactDigest,
  sourcePath,
} = require('./m2-cq-source-inventory.cjs');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const REFERENCE_CLOSURE_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'docs/ontology/references/reference-closure-manifest.json',
});
const IDENTITY_SOURCE_BINDING_AUTHORING_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/identity-source-binding-authoring.json',
});
const IDENTITY_SOURCE_BINDINGS_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/identity-source-bindings.json',
});
const SUBJECT_KINDS = Object.freeze(new Set([
  'targetIdentityContract', 'identityMapping', 'identityTermContract', 'controlledIriSet',
]));
const ROOT_FIELDS = Object.freeze(['schemaVersion', 'profileRef', 'entries']);
const ENTRY_FIELDS = Object.freeze(['subjectKind', 'subjectRef', 'sources']);
const SOURCE_SELECTOR_FIELDS = Object.freeze(['referenceId', 'selectionDigest', 'usage']);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasExactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function subjectKey(value) {
  return `${value.subjectKind}\0${value.subjectRef}`;
}

function selectorKey(value) {
  return `${value.referenceId}\0${value.selectionDigest}\0${value.usage}`;
}

function compareCitation(left, right) {
  for (const [a, b] of [
    [left.referenceId, right.referenceId],
    [canonicalJcs(left.artifactRef), canonicalJcs(right.artifactRef)],
    [left.artifactDigest, right.artifactDigest],
    [canonicalJcs(left.locator), canonicalJcs(right.locator)],
    [left.usage, right.usage],
  ]) {
    const result = compareUtf8(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

function assertCanonicalAbsoluteIri(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is not a non-empty NFC absolute IRI`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not an absolute IRI`);
  }
  if (!parsed.protocol || parsed.href !== value) {
    throw new Error(`${label} is not in canonical absolute IRI spelling`);
  }
}

function readRegularSourceBytes(root, artifactRef, label) {
  const validation = validateArtifactRef(artifactRef, label);
  if (!validation.ok || artifactRef.kind !== 'path' || artifactRef.root !== 'sourceTree') {
    throw new Error(`${label} must be a valid sourceTree path ArtifactRef: ${validation.errors.join('; ')}`);
  }
  const absolute = sourcePath(root, artifactRef.path);
  if (!fs.existsSync(absolute)) throw new Error(`${label} does not exist: ${artifactRef.path}`);
  let cursor = path.resolve(root);
  for (const segment of artifactRef.path.split('/')) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic-link path component: ${artifactRef.path}`);
    }
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink file: ${artifactRef.path}`);
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(absolute);
  const relativeReal = path.relative(realRoot, realFile);
  if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeReal)) {
    throw new Error(`${label} resolves outside the source tree: ${artifactRef.path}`);
  }
  return fs.readFileSync(realFile);
}

function readExactJcs(root, artifactRef, label, options = {}) {
  const bytes = readRegularSourceBytes(root, artifactRef, label);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not strict UTF-8 JSON: ${error.message}`);
  }
  const exact = Buffer.from(canonicalJcs(value), 'utf8');
  const accepted = bytes.equals(exact)
    || (options.allowSingleTrailingLf === true
      && bytes.equals(Buffer.concat([exact, Buffer.from('\n', 'utf8')])));
  if (!accepted) {
    throw new Error(`${label} is not exact UTF-8 JCS bytes`);
  }
  return { bytes, value };
}

function termClosureForContract(contract, compilation) {
  const rules = new Map(compilation.normalizationRules.map((row) => [row.iri, row]));
  const derivations = new Map(compilation.derivations.map((row) => [row.iri, row]));
  const terms = new Set();
  const queue = [];
  for (const component of [...contract.logicalComponents, ...contract.versionComponents]) {
    terms.add(component.termContractRef);
    const rule = rules.get(component.normalizationRuleRef);
    if (!rule) throw new Error(`identity normalization ${component.normalizationRuleRef} is missing`);
    terms.add(rule.inputTermContractRef);
    terms.add(rule.outputTermContractRef);
    if (component.semanticValue?.valueKind === 'derivation') queue.push(component.semanticValue.derivationRef);
  }
  const seen = new Set();
  while (queue.length > 0) {
    const derivationRef = queue.shift();
    if (seen.has(derivationRef)) continue;
    seen.add(derivationRef);
    const derivation = derivations.get(derivationRef);
    if (!derivation) throw new Error(`identity derivation ${derivationRef} is missing`);
    for (const output of derivation.outputs) terms.add(output.termContractRef);
    for (const input of derivation.inputSemanticValues) {
      if (input.valueKind === 'derivation') queue.push(input.derivationRef);
    }
  }
  return terms;
}

function expectedIdentitySubjects(identity) {
  if (!identity?.manifest || !identity?.registry || !identity?.compilation) {
    throw new Error('global materialized identity closure is missing');
  }
  const subjects = new Map();
  const add = (subjectKind, subjectRef) => {
    assertCanonicalAbsoluteIri(subjectRef, `${subjectKind} subjectRef`);
    const row = { subjectKind, subjectRef };
    const key = subjectKey(row);
    if (subjects.has(key)) throw new Error(`duplicate identity subject ${key}`);
    subjects.set(key, row);
  };
  const definitions = new Map(identity.compilation.contracts.map((row) => [row.iri, row]));
  const usedTerms = new Set();
  for (const contract of identity.manifest.contracts) {
    add('targetIdentityContract', contract.contractRef);
    const definition = definitions.get(contract.contractRef);
    if (!definition || definition.targetType !== contract.targetType) {
      throw new Error(`identity contract ${contract.contractRef} does not join its compilation definition`);
    }
    for (const mapping of contract.mappings) add('identityMapping', mapping.mappingRef);
    for (const termRef of termClosureForContract(definition, identity.compilation)) usedTerms.add(termRef);
  }
  const registryTerms = new Map(identity.registry.termContracts
    .map((row) => [row.termContractRef, row]));
  const registrySets = new Map(identity.registry.controlledSets
    .map((row) => [row.controlledSetRef, row]));
  for (const termRef of [...usedTerms].sort(compareUtf8)) {
    const row = registryTerms.get(termRef);
    if (!row) throw new Error(`used identity term ${termRef} is absent from the registry`);
    add('identityTermContract', termRef);
    const setRef = row.definition?.termContract?.referenceMode === 'controlledIri'
      ? row.definition.termContract.controlledSetRef : null;
    if (setRef && !subjects.has(`controlledIriSet\0${setRef}`)) {
      if (!registrySets.has(setRef)) throw new Error(`used controlled set ${setRef} is absent from the registry`);
      add('controlledIriSet', setRef);
    }
  }
  const unusedTerms = [...registryTerms.keys()].filter((ref) => !usedTerms.has(ref));
  const usedSets = new Set([...subjects.values()]
    .filter((row) => row.subjectKind === 'controlledIriSet').map((row) => row.subjectRef));
  const unusedSets = [...registrySets.keys()].filter((ref) => !usedSets.has(ref));
  if (unusedTerms.length > 0 || unusedSets.length > 0) {
    throw new Error(`identity registry contains unused entries: terms=${unusedTerms.length}, sets=${unusedSets.length}`);
  }
  return [...subjects.values()].sort((left, right) => compareUtf8(subjectKey(left), subjectKey(right)));
}

function buildReferenceSelectorIndex(referenceClosure) {
  if (!referenceClosure || referenceClosure.schemaVersion !== '1.0'
      || !Array.isArray(referenceClosure.entries)) {
    throw new Error('reference closure manifest is invalid');
  }
  const selectors = new Map();
  for (const [entryIndex, entry] of referenceClosure.entries.entries()) {
    if (!ID_RE.test(entry.referenceId || '')) {
      throw new Error(`reference closure entry ${entryIndex} identity is invalid`);
    }
    if (!Array.isArray(entry.locators)) throw new Error(`reference closure ${entry.referenceId} has no locators array`);
    if (entry.locators.length === 0) continue;
    if (!DIGEST_RE.test(entry.artifactDigest || '')) {
      throw new Error(`reference closure entry ${entryIndex} artifact digest is invalid`);
    }
    const artifactValidation = validateArtifactRef(entry.artifactRef, `reference closure entries[${entryIndex}].artifactRef`);
    if (!artifactValidation.ok) throw new Error(artifactValidation.errors.join('; '));
    for (const [locatorIndex, locator] of entry.locators.entries()) {
      const validation = validateSourceLocator(locator, {
        at: `reference closure entries[${entryIndex}].locators[${locatorIndex}]`,
      });
      if (!validation.ok) throw new Error(validation.errors.join('; '));
      const key = `${entry.referenceId}\0${locator.selectionDigest}`;
      if (selectors.has(key)) throw new Error(`ambiguous reference selector ${key}`);
      selectors.set(key, {
        referenceId: entry.referenceId,
        artifactRef: entry.artifactRef,
        artifactDigest: entry.artifactDigest,
        locator,
      });
    }
  }
  return selectors;
}

function compileIdentitySourceBindings(root, options = {}) {
  const compiledIdentity = options.identity || compileMaterializedIdentityClosure(root);
  const identity = {
    ...compiledIdentity,
    manifestRef: options.identity?.manifestRef || GLOBAL_MANIFEST_REF,
    registryRef: options.identity?.registryRef || GLOBAL_REGISTRY_REF,
  };
  const referenceClosure = options.referenceClosure
    || readExactJcs(root, REFERENCE_CLOSURE_REF, 'reference closure manifest').value;
  const authoring = options.authoring
    || readExactJcs(root, IDENTITY_SOURCE_BINDING_AUTHORING_REF,
      'identity source binding authoring', { allowSingleTrailingLf: true }).value;
  if (!hasExactFields(authoring, ROOT_FIELDS)
      || authoring.schemaVersion !== '1.0' || authoring.profileRef !== PROFILE_REF
      || !Array.isArray(authoring.entries)) {
    throw new Error('identity source binding authoring root is invalid');
  }
  const expected = expectedIdentitySubjects(identity);
  const expectedKeys = expected.map(subjectKey);
  const selectors = buildReferenceSelectorIndex(referenceClosure);
  const entries = [];
  let previousSubject = null;
  for (const [entryIndex, entry] of authoring.entries.entries()) {
    if (!hasExactFields(entry, ENTRY_FIELDS) || !SUBJECT_KINDS.has(entry.subjectKind)
        || !Array.isArray(entry.sources) || entry.sources.length === 0) {
      throw new Error(`identity source binding authoring entry ${entryIndex} is invalid`);
    }
    assertCanonicalAbsoluteIri(entry.subjectRef, `identity source binding entries[${entryIndex}].subjectRef`);
    const key = subjectKey(entry);
    if (previousSubject !== null && compareUtf8(previousSubject, key) >= 0) {
      throw new Error('identity source binding authoring entries are not strictly subject-sorted');
    }
    previousSubject = key;
    let previousSelector = null;
    const seenLocator = new Set();
    const sources = [];
    for (const [sourceIndex, source] of entry.sources.entries()) {
      if (!hasExactFields(source, SOURCE_SELECTOR_FIELDS) || !ID_RE.test(source.referenceId || '')
          || !DIGEST_RE.test(source.selectionDigest || '')
          || !['normative', 'implementation'].includes(source.usage)) {
        throw new Error(`identity source binding ${key} sources[${sourceIndex}] is invalid`);
      }
      const sourceKey = selectorKey(source);
      if (previousSelector !== null && compareUtf8(previousSelector, sourceKey) >= 0) {
        throw new Error(`identity source binding ${key} sources are not strictly selector-sorted`);
      }
      previousSelector = sourceKey;
      const selected = selectors.get(`${source.referenceId}\0${source.selectionDigest}`);
      if (!selected) {
        throw new Error(`identity source binding ${key} references an unknown reviewed locator`);
      }
      const locatorKey = canonicalJcs(selected);
      if (seenLocator.has(locatorKey)) throw new Error(`identity source binding ${key} repeats a locator`);
      seenLocator.add(locatorKey);
      sources.push({ ...selected, usage: source.usage });
    }
    sources.sort(compareCitation);
    entries.push({ subjectKind: entry.subjectKind, subjectRef: entry.subjectRef, sources });
  }
  const actualKeys = entries.map(subjectKey);
  if (canonicalJcs(actualKeys) !== canonicalJcs(expectedKeys)) {
    const expectedSet = new Set(expectedKeys);
    const actualSet = new Set(actualKeys);
    const missing = expectedKeys.filter((key) => !actualSet.has(key));
    const extra = actualKeys.filter((key) => !expectedSet.has(key));
    throw new Error(`identity source binding subject closure differs: missing=${missing.length}, extra=${extra.length}`);
  }
  const bindings = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    identityManifestRef: identity.manifestRef,
    identityManifestDigest: identity.manifestDigest,
    identityTermRegistryRef: identity.registryRef,
    identityTermRegistryDigest: identity.registryDigest,
    entries,
  };
  return {
    bindings,
    bytes: Buffer.from(canonicalJcs(bindings), 'utf8'),
    stats: {
      subjectBindingCount: entries.length,
      sourceCitationCount: entries.reduce((sum, entry) => sum + entry.sources.length, 0),
      uniqueReviewedLocatorCount: new Set(entries.flatMap((entry) => entry.sources)
        .map((source) => `${source.referenceId}\0${source.locator.selectionDigest}`)).size,
    },
  };
}

module.exports = {
  IDENTITY_SOURCE_BINDING_AUTHORING_REF,
  IDENTITY_SOURCE_BINDINGS_REF,
  REFERENCE_CLOSURE_REF,
  SOURCE_SELECTOR_FIELDS,
  compileIdentitySourceBindings,
  expectedIdentitySubjects,
  readRegularSourceBytes,
};
