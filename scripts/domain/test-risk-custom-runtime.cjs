#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  EVIDENCE_NAME,
  createEvidence,
} = require('./run-risk-custom-runtime.cjs');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-risk-custom-'));
const result = childProcess.spawnSync(
  process.execPath,
  [
    path.join(ROOT, 'scripts', 'domain', 'run-risk-custom-runtime.cjs'),
    '--output-dir',
    output,
  ],
  {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  },
);
assert.equal(result.status, 0, result.stderr || result.stdout);
const evidenceBytes = fs.readFileSync(path.join(output, EVIDENCE_NAME));
const evidence = JSON.parse(evidenceBytes.toString('utf8'));
assert(evidenceBytes.equals(Buffer.from(canonicalJcs(evidence), 'utf8')));
assert.equal(evidence.outcome, 'passed');
assert.equal(evidence.componentEligible, true);
assert.equal(evidence.discoveredConstraints.length, 8);
assert.equal(evidence.vectorResults.length, 36);
assert(evidence.vectorResults.every((row) => row.status === 'passed'));
assert.deepEqual(
  [...new Set(evidence.vectorResults.map((row) => row.category))].sort(),
  [
    'adversarialEvidence',
    'dispatchAttribution',
    'engineFailure',
    'inputContract',
    'positive',
    'violation',
  ],
);
assert(Object.values(evidence.permissionAssurance).every((value) => value === true));

const profile = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'scripts', 'domain', 'risk-custom-profile', 'v0.3.0', 'discovery-contract.json'),
  'utf8',
));
const digestTamper = structuredClone(profile);
digestTamper.constraints[0].expressionDigest = `sha256:${'0'.repeat(64)}`;
assert.throws(() => createEvidence(digestTamper), /expression drift/u);

const missingBinding = structuredClone(profile);
missingBinding.constraints.pop();
assert.throws(() => createEvidence(missingBinding), /exactly eight/u);

console.log(
  'Risk Custom runtime: PASS '
    + '(8 discovered constraints, 36 canonical/dispatch/adversarial vectors, permission/tamper fail-closed)',
);
