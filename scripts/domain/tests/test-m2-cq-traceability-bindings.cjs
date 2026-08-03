#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  artifactDigest,
} = require('../lib/m2-cq-source-inventory.cjs');
const {
  CQ_TRACEABILITY_BINDINGS_REF,
  compileCqTraceabilityBindings,
} = require('../lib/m2-cq-traceability-bindings.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const PUBLIC_A = 'https://example.test/ontology/A';
const PUBLIC_B = 'https://example.test/ontology/B';

function artifactRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function fixture(fixtureId, relativePath) {
  return { fixtureId, artifactRef: artifactRef(relativePath) };
}

function makeTrace(cqId, publicIris = [PUBLIC_A]) {
  return {
    exercisedPublicIris: publicIris,
    positiveFixtures: [fixture(`${cqId}.positive`, 'tests/fixtures/positive.yaml')],
    negativeFixtures: [fixture(`${cqId}.negative`, 'tests/fixtures/negative.yaml')],
  };
}

function createRoot(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-cq-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs', 'ontology', 'competency-questions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'domain', 'infrastructure'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests', 'fixtures'), { recursive: true });
  const positiveBytes = Buffer.from('kind: positive\n', 'utf8');
  const negativeBytes = Buffer.from('kind: negative\n', 'utf8');
  fs.writeFileSync(path.join(root, 'tests', 'fixtures', 'positive.yaml'), positiveBytes);
  fs.writeFileSync(path.join(root, 'tests', 'fixtures', 'negative.yaml'), negativeBytes);
  const document = {
    schemaVersion: '1.0',
    cqs: [
      { id: 'CQ-A1', status: 'active', traceability: makeTrace('CQ-A1') },
      {
        id: 'CQ-B1',
        status: 'active',
        aliasOf: 'CQ-A1',
        executionIdentity: 'CQ-A1',
        traceability: makeTrace('CQ-B1', [PUBLIC_B]),
      },
      { id: 'CQ-C1', status: 'deferred' },
    ],
  };
  const context = { document, positiveBytes, negativeBytes };
  mutate(context);
  fs.writeFileSync(
    path.join(root, 'docs', 'ontology', 'competency-questions', 'test.yaml'),
    yaml.dump(document, { noRefs: true, lineWidth: -1, sortKeys: false }),
  );
  const publicManifest = {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    symbols: [
      { publicIri: PUBLIC_A },
      { publicIri: PUBLIC_B },
    ],
  };
  fs.writeFileSync(
    path.join(root, 'docs', 'domain', 'infrastructure', 'public-symbol-manifest.json'),
    canonicalJcs(publicManifest),
  );
  return root;
}

test('CQ traceability compiler closes active inventory, public symbols, aliases, and fixture bytes', (t) => {
  const root = createRoot(t);
  const first = compileCqTraceabilityBindings(root);
  const second = compileCqTraceabilityBindings(root);
  assert.deepEqual(first.bindings, second.bindings);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.at(-1), 0x7d, 'binding JCS must not have a trailing LF');
  assert.equal(first.stats.cqBindingCount, 2);
  assert.equal(first.stats.exercisedPublicIriCount, 2);
  assert.deepEqual(first.bindings.entries.map((entry) => entry.cqId), ['CQ-A1', 'CQ-B1']);
  assert.equal(first.bindings.entries[1].executionIdentity, 'CQ-A1');
  assert.equal(
    first.bindings.entries[0].positiveFixtures[0].artifactDigest,
    artifactDigest(Buffer.from('kind: positive\n', 'utf8')),
  );
  assert.deepEqual(first.bindings.cqSourceInventoryRef, {
    kind: 'path',
    root: 'sourceTree',
    path: 'scripts/domain/release-profile/v0.3.0/cq-source-inventory.json',
  });
  assert.equal(CQ_TRACEABILITY_BINDINGS_REF.path,
    'scripts/domain/release-profile/v0.3.0/cq-traceability-bindings.json');
});

test('CQ traceability compiler rejects missing active binding and non-active release binding', async (t) => {
  await t.test('missing active declaration', (child) => {
    const root = createRoot(child, ({ document }) => { delete document.cqs[0].traceability; });
    assert.throws(
      () => compileCqTraceabilityBindings(root),
      /active CQ CQ-A1 lacks one closed, non-empty traceability declaration/u,
    );
  });
  await t.test('deferred declaration', (child) => {
    const root = createRoot(child, ({ document }) => {
      document.cqs[2].traceability = makeTrace('CQ-C1');
    });
    assert.throws(
      () => compileCqTraceabilityBindings(root),
      /non-active CQ CQ-C1 must not declare release traceability/u,
    );
  });
});

test('CQ traceability compiler rejects invented or noncanonical public targets', async (t) => {
  await t.test('unknown target', (child) => {
    const root = createRoot(child, ({ document }) => {
      document.cqs[0].traceability.exercisedPublicIris = ['https://example.test/ontology/Unknown'];
    });
    assert.throws(
      () => compileCqTraceabilityBindings(root),
      /exercises unknown public IRI/u,
    );
  });
  await t.test('noncanonical spelling', (child) => {
    const root = createRoot(child, ({ document }) => {
      document.cqs[0].traceability.exercisedPublicIris = ['https://example.test:443/ontology/A'];
    });
    assert.throws(
      () => compileCqTraceabilityBindings(root),
      /canonical absolute IRI spelling/u,
    );
  });
});

test('CQ traceability compiler keeps positive and negative fixtures fail-closed', async (t) => {
  await t.test('same artifact', (child) => {
    const root = createRoot(child, ({ document }) => {
      document.cqs[0].traceability.negativeFixtures = [
        fixture('CQ-A1.negative', 'tests/fixtures/positive.yaml'),
      ];
    });
    assert.throws(
      () => compileCqTraceabilityBindings(root),
      /positive and negative fixture identities, artifacts, and bytes must be distinct/u,
    );
  });
  await t.test('unsafe path', (child) => {
    const root = createRoot(child, ({ document }) => {
      document.cqs[0].traceability.negativeFixtures = [
        fixture('CQ-A1.negative', '../outside.yaml'),
      ];
    });
    assert.throws(
      () => compileCqTraceabilityBindings(root),
      /valid sourceTree path ArtifactRef/u,
    );
  });
});

test('CQ traceability compiler rejects stale execution fixture locks', (t) => {
  const root = createRoot(t, ({ document }) => {
    document.cqs[0].execution = {
      positiveFixture: 'tests/fixtures/positive.yaml',
      positiveFixtureDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      negativeFixture: 'tests/fixtures/negative.yaml',
      negativeFixtureDigest: artifactDigest(Buffer.from('kind: negative\n', 'utf8')),
    };
  });
  assert.throws(
    () => compileCqTraceabilityBindings(root),
    /execution positive fixture digest is stale/u,
  );
});
