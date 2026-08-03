'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CARD_SPECS,
  CROSS_MODULE_S5_CONTRACT_REF,
  CqByteLockError,
  LEGACY_S5_TOOL_LOCK_REF,
  checkOutputs,
  createOutputs,
} = require('../sync-cq-byte-locks.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('non-PTO CQ/S5 byte-lock graph is deterministic and closed', () => {
  const outputs = createOutputs();
  assert.deepEqual(checkOutputs(outputs), []);
  assert.equal(outputs.size, 54);
  assert.equal(outputs.has(LEGACY_S5_TOOL_LOCK_REF), true);
  assert.equal(outputs.has(CROSS_MODULE_S5_CONTRACT_REF), true);
  for (const { ref } of CARD_SPECS) assert.equal(outputs.has(ref), true, ref);
  assert.equal(
    [...outputs.keys()].some((ref) => /post-trade|posttrade|fin-post-trade/u.test(ref)),
    false,
  );
});

test('an upstream implementation byte change invalidates every dependent CQ card', () => {
  const implementationRef = 'scripts/domain/lib/foundation-market-instrument-cq.cjs';
  const source = fs.readFileSync(path.join(ROOT, implementationRef));
  const outputs = createOutputs({
    sourceOverrides: new Map([[implementationRef, Buffer.concat([source, Buffer.from('\n')])]]),
  });
  const drift = checkOutputs(outputs);
  for (const card of [
    'docs/ontology/competency-questions/fin-foundation-cq.yaml',
    'docs/ontology/competency-questions/fin-market-structure-cq.yaml',
    'docs/ontology/competency-questions/fin-instruments-cq.yaml',
    'docs/ontology/competency-questions/fin-cross-module-cq.yaml',
  ]) {
    assert.equal(drift.some((entry) => entry.startsWith(`${card}: byte drift`)), true, card);
  }
});

test('a package-lock byte change cascades through tool lock, replay contract, and cards', () => {
  const packageLock = fs.readFileSync(path.join(ROOT, 'package-lock.json'));
  const outputs = createOutputs({
    sourceOverrides: new Map([['package-lock.json', Buffer.concat([packageLock, Buffer.from('\n')])]]),
  });
  const drift = checkOutputs(outputs);
  for (const ref of [
    LEGACY_S5_TOOL_LOCK_REF,
    CROSS_MODULE_S5_CONTRACT_REF,
    ...CARD_SPECS.map(({ ref: cardRef }) => cardRef),
  ]) {
    assert.equal(drift.some((entry) => entry.startsWith(`${ref}: byte drift`)), true, ref);
  }
});

test('stable-source candidate entrypoint bytes are locked by the CQ-S5 card', () => {
  const entrypointRef = 'scripts/domain/run-s5-stable-source-chain.cjs';
  const source = fs.readFileSync(path.join(ROOT, entrypointRef));
  const outputs = createOutputs({
    sourceOverrides: new Map([[
      entrypointRef,
      Buffer.concat([source, Buffer.from('\n')]),
    ]]),
  });
  const drift = checkOutputs(outputs);
  assert.equal(
    drift.some((entry) => entry.startsWith(
      'docs/ontology/competency-questions/fin-cross-module-cq.yaml: byte drift',
    )),
    true,
  );
});

test('a ref substitution is rejected instead of being blessed with a new digest', () => {
  const cardRef = 'docs/ontology/competency-questions/fin-foundation-cq.yaml';
  const source = fs.readFileSync(path.join(ROOT, cardRef), 'utf8');
  const substituted = source.replace(
    'implementation: scripts/domain/lib/foundation-market-instrument-cq.cjs',
    'implementation: package-lock.json',
  );
  assert.notEqual(substituted, source);
  assert.throws(
    () => createOutputs({ sourceOverrides: new Map([[cardRef, substituted]]) }),
    (error) => error instanceof CqByteLockError && error.code === 'CQ_LOCK_INVENTORY',
  );
});
