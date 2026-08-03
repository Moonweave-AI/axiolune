'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DATASET_DOMAIN_TAG,
  GRAPH_DOMAIN_TAG,
  MAX_INPUT_BYTES,
  MAX_QUADS,
  RdfcError,
  canonicalizeNQuads,
  computeDatasetDigest,
  computeNamedGraphDigest,
  computeTaggedNamedGraphDigest,
  packageVersion,
  stagingFactsToNQuads,
} = require('../lib/rdfc-1.0.cjs');

const GRAPH = 'urn:axiolune:graph:test';
const OTHER_GRAPH = 'urn:axiolune:graph:other';
const DATASET_A = [
  '_:alpha <urn:p:name> "A" <urn:axiolune:graph:test> .',
  '<urn:subject> <urn:p:child> _:alpha <urn:axiolune:graph:test> .',
  '<urn:subject> <urn:p:value> "1"^^<http://www.w3.org/2001/XMLSchema#integer> <urn:axiolune:graph:test> .',
  '<urn:other> <urn:p:value> "x" <urn:axiolune:graph:other> .',
  '',
].join('\n');
const DATASET_B = [
  '<urn:other> <urn:p:value> "x" <urn:axiolune:graph:other> .',
  '<urn:subject> <urn:p:value> "1"^^<http://www.w3.org/2001/XMLSchema#integer> <urn:axiolune:graph:test> .',
  '<urn:subject> <urn:p:child> _:renamed <urn:axiolune:graph:test> .',
  '_:renamed <urn:p:name> "A" <urn:axiolune:graph:test> .',
  '',
].join('\n');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof RdfcError && error.code === code);
}

test('locks the release RDFC implementation and exact algorithm name', () => {
  assert.equal(packageVersion(), '5.0.0');
  assert.equal(GRAPH_DOMAIN_TAG, 'axiolune-rdf-graph-v1\0');
  assert.equal(DATASET_DOMAIN_TAG, 'axiolune-rdf-dataset-v1\0');
  const result = canonicalizeNQuads(DATASET_A);
  assert.equal(result.algorithm, 'RDFC-1.0');
  assert.match(result.canonicalNQuads, /_:c14n0/u);
});

test('RDFC worker does not inherit NODE_OPTIONS or NODE_PATH code injection', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-rdfc-env-'));
  const marker = path.join(directory, 'node-options-loaded');
  const preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preload, [
    "'use strict';",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    '',
  ].join('\n'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previousNodeOptions = process.env.NODE_OPTIONS;
  const previousNodePath = process.env.NODE_PATH;
  try {
    process.env.NODE_OPTIONS = `--require=${preload}`;
    process.env.NODE_PATH = directory;
    const result = canonicalizeNQuads(DATASET_A);
    assert.equal(result.algorithm, 'RDFC-1.0');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    if (previousNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previousNodePath;
  }
});

test('canonicalizer returns the exact closed output shape and sorted graph inventory', () => {
  const result = canonicalizeNQuads(DATASET_A);
  assert.deepEqual(
    Object.keys(result).sort(),
    ['algorithm', 'canonicalNQuads', 'graphIris', 'quadCount'],
  );
  assert.deepEqual(result.graphIris, [OTHER_GRAPH, GRAPH]);
  assert.equal(result.quadCount, 4);
  assert.match(result.canonicalNQuads, /\n$/u);
});

test('blank-node relabeling and input order produce the same canonical dataset digest', () => {
  const left = computeDatasetDigest(DATASET_A, [GRAPH, OTHER_GRAPH]);
  const right = computeDatasetDigest(DATASET_B, [OTHER_GRAPH, GRAPH]);
  assert.equal(left.digest, right.digest);
  assert.equal(left.canonicalNQuads, right.canonicalNQuads);
  assert.equal(left.quadCount, 4);
});

test('named-graph digest includes the graph name and excludes other graphs', () => {
  const selected = computeNamedGraphDigest(DATASET_A, GRAPH);
  const renamed = computeNamedGraphDigest(
    DATASET_A.replaceAll(GRAPH, 'urn:axiolune:graph:renamed'),
    'urn:axiolune:graph:renamed',
  );
  assert.notEqual(selected.digest, renamed.digest);
  assert.equal(selected.quadCount, 3);
  assert.doesNotMatch(selected.canonicalNQuads, /graph:other/u);
});

test('catalog replay can bind an artifact-specific tagged RDFC named-graph digest', () => {
  const first = computeTaggedNamedGraphDigest(
    DATASET_A,
    GRAPH,
    'axiolune-catalog-rdf-artifact-v1\0',
  );
  const reordered = computeTaggedNamedGraphDigest(
    DATASET_B,
    GRAPH,
    'axiolune-catalog-rdf-artifact-v1\0',
  );
  const retagged = computeTaggedNamedGraphDigest(
    DATASET_A,
    GRAPH,
    'axiolune-catalog-rdf-artifact-v2\0',
  );
  assert.equal(first.digest, reordered.digest);
  assert.notEqual(first.digest, retagged.digest);
  assert.equal(first.quadCount, 3);
});

test('semantic mutation changes graph and dataset digests', () => {
  const mutated = DATASET_A.replace(
    '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
    '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
  );
  assert.notEqual(
    computeNamedGraphDigest(DATASET_A, GRAPH).digest,
    computeNamedGraphDigest(mutated, GRAPH).digest,
  );
  assert.notEqual(
    computeDatasetDigest(DATASET_A).digest,
    computeDatasetDigest(mutated).digest,
  );
});

test('fails closed on default graphs, graph-set substitution, invalid N-Quads, and empty input', () => {
  expectCode(
    () => canonicalizeNQuads('<urn:s> <urn:p> <urn:o> .\n'),
    'RDFC_GRAPH_NAME',
  );
  expectCode(
    () => computeDatasetDigest(DATASET_A, [GRAPH]),
    'RDFC_DATASET_SCOPE',
  );
  expectCode(() => canonicalizeNQuads('not n-quads\n'), 'RDFC_PARSE');
  expectCode(() => canonicalizeNQuads(''), 'RDFC_EMPTY_DATASET');
  expectCode(() => canonicalizeNQuads(Buffer.from(DATASET_A)), 'RDFC_INPUT_TYPE');
  expectCode(() => computeNamedGraphDigest(DATASET_A, 'urn:axiolune:graph:missing'), 'RDFC_GRAPH_MISSING');
});

test('fails closed at the locked input-byte and quad-count resource limits', () => {
  expectCode(
    () => canonicalizeNQuads('x'.repeat(MAX_INPUT_BYTES + 1)),
    'RDFC_INPUT_TOO_LARGE',
  );
  const excessiveDataset = `${Array.from({ length: MAX_QUADS + 1 }, (_, index) => (
    `<urn:subject:${index}> <urn:predicate> "value" <urn:axiolune:graph:test> .`
  )).join('\n')}\n`;
  assert.ok(Buffer.byteLength(excessiveDataset, 'utf8') <= MAX_INPUT_BYTES);
  expectCode(() => canonicalizeNQuads(excessiveDataset), 'RDFC_TOO_MANY_QUADS');
});

test('staging RDF conversion is invariant to statement order and blank-node labels', () => {
  const facts = [{
    iri: 'urn:fact:one',
    type: 'urn:type:Fact',
    validFrom: '2026-07-31T00:00:00Z',
    amount: { hasNumericAmount: '12.50', hasCurrencyCode: 'USD' },
  }];
  const left = stagingFactsToNQuads(facts, GRAPH, { blankNodePrefix: 'left' });
  const right = stagingFactsToNQuads(facts, GRAPH, {
    blankNodePrefix: 'right',
    reverse: true,
  });
  assert.equal(
    computeNamedGraphDigest(left, GRAPH).digest,
    computeNamedGraphDigest(right, GRAPH).digest,
  );
});
