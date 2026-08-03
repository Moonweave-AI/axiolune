'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  checkArtifacts,
  dispositionFor,
  findAuthorityManagedReviewArtifacts,
} = require('../review-ontology-design-references.cjs');

test('ontology-design review gate rejects active artifacts owned by authority review', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-ontology-review-'));
  const forbiddenNames = [
    'axiolune-controlled-quantity-units.review.json',
    'axiolune-controlled-terminology.review.json',
    'axiolune-controlled-vocabularies.review.json',
  ].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));

  try {
    fs.writeFileSync(path.join(temporaryRoot, 'fibo.review.json'), '{}');
    assert.deepEqual(findAuthorityManagedReviewArtifacts(temporaryRoot), []);

    for (const name of forbiddenNames) fs.writeFileSync(path.join(temporaryRoot, name), '{}');

    assert.deepEqual(findAuthorityManagedReviewArtifacts(temporaryRoot), forbiddenNames);
    const errors = checkArtifacts(new Map(), temporaryRoot);
    assert.equal(errors.length, forbiddenNames.length);
    for (const name of forbiddenNames) {
      assert.ok(errors.some((error) => error.startsWith(`${name}: authority-managed project review`)));
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('semantic signals cannot be auto-classified as reviewedNoBearing', () => {
  const parsed = {
    contentSignals: ['order', 'trade'],
    outcome: 'parsed',
  };
  assert.equal(dispositionFor({}, parsed, []), null);
  assert.equal(
    dispositionFor({}, parsed, [], { disposition: 'reviewedRejected' }),
    'reviewedRejected',
  );
  assert.equal(
    dispositionFor({}, parsed, [{ usage: 'implementation' }]),
    'usedImplementation',
  );
  assert.equal(
    dispositionFor({}, { contentSignals: [], outcome: 'parsed' }, []),
    null,
  );
});
