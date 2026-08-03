#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  closesExternalTermAlignment,
} = require('../lib/slice-a-market-contracts.cjs');

const DIGEST = `sha256:${'a'.repeat(64)}`;

function evidence() {
  return {
    noAlignment: {
      ok: true,
      evidence: {
        referenceArtifactDigest: DIGEST,
        decisions: [
          'instruments-financial-instrument-fibo-financial-instrument',
          'instruments-security-fibo-security',
        ].map((decisionId) => ({
          decisionId,
          outcome: 'reviewed-no-alignment-semantic-mismatch',
          decisionDigest: DIGEST,
          localElementDigest: DIGEST,
          sourceSelectionDigest: DIGEST,
          selectedContentDigest: DIGEST,
          rejectedTriple: { present: false },
        })),
      },
    },
    authoritySourceLocks: { mic: true, tzdb: true, quantityUnit: true },
  };
}

test('external term-alignment closure consumes exact reviewed decisions and authority replays', () => {
  assert.equal(closesExternalTermAlignment(evidence()), true);
});

test('external term-alignment closure remains pending on missing or weakened evidence', () => {
  assert.equal(closesExternalTermAlignment(undefined), false);
  const missingDecision = evidence();
  missingDecision.noAlignment.evidence.decisions.pop();
  assert.equal(closesExternalTermAlignment(missingDecision), false);
  const assertedTriple = evidence();
  assertedTriple.noAlignment.evidence.decisions[0].rejectedTriple.present = true;
  assert.equal(closesExternalTermAlignment(assertedTriple), false);
  const missingAuthority = evidence();
  missingAuthority.authoritySourceLocks.tzdb = false;
  assert.equal(closesExternalTermAlignment(missingAuthority), false);
});
