'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  CQ_SOURCE_INVENTORY_REF,
  PROFILE_REF,
  artifactDigest,
  compileCqSourceInventory,
  discoverCqSourcePaths,
  sourcePath,
} = require('./m2-cq-source-inventory.cjs');
const {
  canonicalJcs,
  validateArtifactRef,
} = require('./strict-source-locator.cjs');

const CQ_TRACEABILITY_BINDINGS_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/cq-traceability-bindings.json',
});
const PUBLIC_SYMBOL_MANIFEST_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'docs/domain/infrastructure/public-symbol-manifest.json',
});
const TRACEABILITY_FIELDS = Object.freeze([
  'exercisedPublicIris', 'positiveFixtures', 'negativeFixtures',
]);
const FIXTURE_FIELDS = Object.freeze(['fixtureId', 'artifactRef']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasExactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort(compareUtf8))
      === canonicalJcs([...fields].sort(compareUtf8));
}

function refKey(value) {
  return canonicalJcs(value);
}

function fixtureKey(value) {
  return `${value.fixtureId}\0${refKey(value.artifactRef)}`;
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

function readExactJcs(root, artifactRef, label) {
  const bytes = readRegularSourceBytes(root, artifactRef, label);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not strict UTF-8 JSON: ${error.message}`);
  }
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} is not exact UTF-8 JCS bytes`);
  }
  return { bytes, value };
}

function loadPublicIris(root) {
  const { value } = readExactJcs(root, PUBLIC_SYMBOL_MANIFEST_REF, 'public symbol manifest');
  if (!hasExactFields(value, ['schemaVersion', 'profileRef', 'symbols'])
      || value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF
      || !Array.isArray(value.symbols) || value.symbols.length === 0) {
    throw new Error('public symbol manifest root is invalid');
  }
  const publicIris = new Set();
  for (const [index, symbol] of value.symbols.entries()) {
    assertCanonicalAbsoluteIri(symbol?.publicIri, `public symbol manifest symbols[${index}].publicIri`);
    if (publicIris.has(symbol.publicIri)) {
      throw new Error(`public symbol manifest repeats ${symbol.publicIri}`);
    }
    publicIris.add(symbol.publicIri);
  }
  return publicIris;
}

function loadCqDocuments(root) {
  const documents = new Map();
  for (const relativePath of discoverCqSourcePaths(root)) {
    const bytes = readRegularSourceBytes(
      root,
      { kind: 'path', root: 'sourceTree', path: relativePath },
      `CQ source ${relativePath}`,
    );
    let document;
    try {
      document = yaml.load(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error(`cannot parse CQ source ${relativePath}: ${error.message}`);
    }
    if (!document || typeof document !== 'object' || !Array.isArray(document.cqs)) {
      throw new Error(`CQ source ${relativePath} has no cqs array`);
    }
    documents.set(relativePath, document);
  }
  return documents;
}

function compileFixtureBindings(root, cqId, polarity, fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error(`CQ ${cqId} ${polarity}Fixtures must be a non-empty array`);
  }
  const compiled = [];
  let previous = null;
  for (const [index, fixture] of fixtures.entries()) {
    if (!hasExactFields(fixture, FIXTURE_FIELDS) || !ID_RE.test(fixture.fixtureId || '')) {
      throw new Error(`CQ ${cqId} ${polarity}Fixtures[${index}] is not a closed fixture binding`);
    }
    const bytes = readRegularSourceBytes(
      root,
      fixture.artifactRef,
      `CQ ${cqId} ${polarity} fixture ${fixture.fixtureId}`,
    );
    const row = {
      fixtureId: fixture.fixtureId,
      artifactRef: fixture.artifactRef,
      artifactDigest: artifactDigest(bytes),
    };
    const key = fixtureKey(row);
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      throw new Error(`CQ ${cqId} ${polarity}Fixtures are not strictly fixture/ref sorted`);
    }
    previous = key;
    compiled.push(row);
  }
  return compiled;
}

function validateExecutionFixtureLock(cq, polarity, compiled) {
  const execution = cq.execution;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return;
  const pathField = `${polarity}Fixture`;
  const digestField = `${polarity}FixtureDigest`;
  if (!Object.hasOwn(execution, pathField) && !Object.hasOwn(execution, digestField)) return;
  if (typeof execution[pathField] !== 'string' || typeof execution[digestField] !== 'string') {
    throw new Error(`CQ ${cq.id} execution ${polarity} fixture lock is incomplete`);
  }
  const match = compiled.find((fixture) => fixture.artifactRef.kind === 'path'
    && fixture.artifactRef.root === 'sourceTree'
    && fixture.artifactRef.path === execution[pathField]);
  if (!match) {
    throw new Error(`CQ ${cq.id} traceability omits its execution ${polarity} fixture`);
  }
  if (match.artifactDigest !== execution[digestField]) {
    throw new Error(
      `CQ ${cq.id} execution ${polarity} fixture digest is stale: expected ${match.artifactDigest}`,
    );
  }
}

function compileTraceabilityEntry(root, source, cq, publicIris) {
  const traceability = cq.traceability;
  if (!hasExactFields(traceability, TRACEABILITY_FIELDS)
      || !Array.isArray(traceability.exercisedPublicIris)
      || traceability.exercisedPublicIris.length === 0) {
    throw new Error(`active CQ ${source.cqId} lacks one closed, non-empty traceability declaration`);
  }
  let previousIri = null;
  for (const [index, publicIri] of traceability.exercisedPublicIris.entries()) {
    assertCanonicalAbsoluteIri(publicIri, `CQ ${source.cqId} exercisedPublicIris[${index}]`);
    if (!publicIris.has(publicIri)) {
      throw new Error(`CQ ${source.cqId} exercises unknown public IRI ${publicIri}`);
    }
    if (previousIri !== null && compareUtf8(previousIri, publicIri) >= 0) {
      throw new Error(`CQ ${source.cqId} exercisedPublicIris are not strictly sorted`);
    }
    previousIri = publicIri;
  }
  const positiveFixtures = compileFixtureBindings(
    root, source.cqId, 'positive', traceability.positiveFixtures,
  );
  const negativeFixtures = compileFixtureBindings(
    root, source.cqId, 'negative', traceability.negativeFixtures,
  );
  for (const positive of positiveFixtures) {
    for (const negative of negativeFixtures) {
      if (positive.fixtureId === negative.fixtureId
          || refKey(positive.artifactRef) === refKey(negative.artifactRef)
          || positive.artifactDigest === negative.artifactDigest) {
        throw new Error(
          `CQ ${source.cqId} positive and negative fixture identities, artifacts, and bytes must be distinct`,
        );
      }
    }
  }
  validateExecutionFixtureLock(cq, 'positive', positiveFixtures);
  validateExecutionFixtureLock(cq, 'negative', negativeFixtures);
  return {
    cqId: source.cqId,
    executionIdentity: source.executionIdentity,
    exercisedPublicIris: traceability.exercisedPublicIris,
    positiveFixtures,
    negativeFixtures,
  };
}

function compileCqTraceabilityBindings(root) {
  const inventoryResult = compileCqSourceInventory(root);
  const publicIris = loadPublicIris(root);
  const documents = loadCqDocuments(root);
  const cqRows = new Map();
  for (const [relativePath, document] of documents) {
    for (const cq of document.cqs) {
      if (cqRows.has(cq.id)) throw new Error(`duplicate CQ declaration ${cq.id}`);
      cqRows.set(cq.id, { cq, relativePath });
    }
  }
  const entries = [];
  for (const source of inventoryResult.inventory.entries) {
    const located = cqRows.get(source.cqId);
    if (!located || located.relativePath !== source.sourceRef.path) {
      throw new Error(`CQ ${source.cqId} cannot be joined back to its inventory source`);
    }
    if (source.status !== 'active') {
      if (Object.hasOwn(located.cq, 'traceability')) {
        throw new Error(`non-active CQ ${source.cqId} must not declare release traceability`);
      }
      continue;
    }
    entries.push(compileTraceabilityEntry(root, source, located.cq, publicIris));
  }
  entries.sort((left, right) => compareUtf8(left.cqId, right.cqId));
  const bindings = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    cqSourceInventoryRef: CQ_SOURCE_INVENTORY_REF,
    cqSourceInventoryDigest: artifactDigest(inventoryResult.bytes),
    entries,
  };
  return {
    bindings,
    bytes: Buffer.from(canonicalJcs(bindings), 'utf8'),
    inventory: inventoryResult.inventory,
    inventoryBytes: inventoryResult.bytes,
    stats: {
      cqBindingCount: entries.length,
      exercisedPublicIriCount: new Set(entries.flatMap((entry) => entry.exercisedPublicIris)).size,
      positiveFixtureBindingCount: entries.reduce(
        (sum, entry) => sum + entry.positiveFixtures.length, 0,
      ),
      negativeFixtureBindingCount: entries.reduce(
        (sum, entry) => sum + entry.negativeFixtures.length, 0,
      ),
    },
  };
}

module.exports = {
  CQ_TRACEABILITY_BINDINGS_REF,
  FIXTURE_FIELDS,
  PUBLIC_SYMBOL_MANIFEST_REF,
  TRACEABILITY_FIELDS,
  compileCqTraceabilityBindings,
  readRegularSourceBytes,
};
