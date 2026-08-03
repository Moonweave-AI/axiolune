#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildClosureManifest,
  outputBytes,
} = require('../generate-reference-closure-manifest.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const { PAYWALLED_SENTINEL } = require('../lib/reference-closure.cjs');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function locator(path) {
  return {
    kind: 'wholeFile',
    path,
    mediaType: 'text/plain',
    extractorProfileRef: {
      kind: 'path',
      root: 'sourceTree',
      path: 'scripts/domain/reference-extractors/whole-file-v1.json',
    },
    extractorProfileDigest: DIGEST_A,
    selectionDigest: DIGEST_B,
  };
}

test('closure is sorted, copies strict locator bytes, and keeps paywalls artifact-free', () => {
  const localLocator = locator('evidence.txt');
  const lock = {
    references: [{
      id: 'z-local',
      releaseOrCommit: 'v1',
      artifactUrl: 'https://example.test/local',
      license: 'MIT',
      maturity: 'fixture',
      usageScope: 'implementationEvidence',
      localPath: 'reference/project-reference/z-local',
      artifactDigest: DIGEST_A,
      locators: [localLocator],
    }, {
      id: 'a-paywall',
      releaseOrCommit: 'edition',
      artifactUrl: 'https://example.test/paywall',
      license: 'Copyright',
      maturity: 'external-standard',
      usageScope: 'unavailableNormativeReference',
      artifactDigest: PAYWALLED_SENTINEL,
      locators: [],
    }],
  };
  const result = buildClosureManifest(
    lock,
    { referenceRootDigest: DIGEST_B },
    DIGEST_A,
  );
  assert.deepEqual(result.entries.map((entry) => entry.referenceId), [
    'a-paywall',
    'z-local',
  ]);
  assert.equal('artifactRef' in result.entries[0], false);
  assert.equal('artifactDigest' in result.entries[0], false);
  assert.deepEqual(result.entries[1].locators, [localLocator]);
  assert.equal(outputBytes(result).toString('utf8'), canonicalJcs(result));
});
