'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditM2GovernanceBaseline,
} = require('../lib/m2-governance-baseline.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function write(root, relativePath, text) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

function createAcceptedBaseline() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-governance-test-'));
  write(
    root,
    'docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md',
    '# RFC-001\n\n**Status**: Accepted\n\nM3 v0.6.0 and typed containers.\n',
  );
  write(
    root,
    'docs/domain/planning/M2-PLAN.md',
    [
      '# M2 PLAN',
      '',
      '**Status**: Accepted',
      '**Upstream baseline**: M3 v0.6.0',
      '',
      'RFC-001 is the accepted conformance profile.',
      '',
      '| Milestone | Deliverable | Evidence | Dependency |',
      '|---|---|---|---|',
      '| E0: M2 compiler base | typed containers | G0 | M3 v0.6.0 release manifest |',
      '',
    ].join('\n'),
  );
  write(
    root,
    'docs/meta/decisions/ADR-013-m3-v0.6.0.md',
    '# ADR-013: M3 v0.6.0 breaking prerequisite\n\n**Status**: Accepted\n',
  );
  write(
    root,
    'docs/domain/decisions/ADR-013-m2-authoring-profile.md',
    '# ADR-013: historical inferred profile\n\n**Status**: Superseded by ADR-016\n',
  );
  write(
    root,
    'docs/domain/decisions/ADR-016-typed-container-authoring-profile.md',
    '# ADR-016: strict typed-container profile\n\n**Status**: Accepted\n\nImplements RFC-001.\n',
  );
  return root;
}

function codes(result) {
  return result.issues.map((issue) => issue.code);
}

test('current repository governance baseline is aligned to M3 v0.6.0 / RFC-001 / typed-container ADRs', () => {
  const result = auditM2GovernanceBaseline(ROOT);
  const driftCodes = codes(result);
  const stopShipCodes = [
    'M2_GOV_RFC001_NOT_ACCEPTED',
    'M2_GOV_META_ADR013_MISSING',
    'M2_GOV_META_ADR013_NOT_ACCEPTED',
    'M2_GOV_META_ADR013_WRONG_BASELINE',
    'M2_GOV_DOMAIN_ADR013_NOT_SUPERSEDED',
    'M2_GOV_DOMAIN_ADR016_MISSING',
    'M2_GOV_DOMAIN_ADR016_NOT_ACCEPTED',
    'M2_GOV_DOMAIN_ADR016_CONTRACT_MISMATCH',
    'M2_GOV_M2_PLAN_HEADER_BASELINE_DRIFT',
    'M2_GOV_M2_PLAN_E0_BASELINE_DRIFT',
    'M2_GOV_M2_PLAN_RFC001_UNBOUND',
  ];
  const leaks = stopShipCodes.filter((c) => driftCodes.includes(c));
  assert.deepEqual(
    leaks,
    [],
    `repository regressed to a governance Stop-Ship: ${leaks.join(', ')}`,
  );
  assert.equal(result.outcome, 'passed', `governance baseline must pass after M3 v0.6.0 alignment; issues: ${driftCodes.join(', ')}`);
});

test('an internally consistent accepted v0.6/RFC/ADR/plan transaction passes', (context) => {
  const root = createAcceptedBaseline();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = auditM2GovernanceBaseline(root);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.issues, []);
  assert.ok(result.checks.length >= 8);
  assert.ok(result.checks.every((row) => row.passed));
});

test('editing only the RFC status cannot hide stale plan and authoring decisions', (context) => {
  const root = createAcceptedBaseline();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(
    root,
    'docs/domain/planning/M2-PLAN.md',
    '# M2 PLAN\n\n**Status**: Proposed\n**Upstream baseline**: M3 v0.5.1\n\n'
      + '| E0: M2 compiler base | inferred | G0 | M3 v0.5.1 release manifest |\n',
  );
  write(
    root,
    'docs/domain/decisions/ADR-013-m2-authoring-profile.md',
    '# ADR-013\n\n**Status**: Accepted (G0 baseline)\n',
  );
  const result = auditM2GovernanceBaseline(root);
  assert.equal(result.outcome, 'failed');
  assert.ok(codes(result).includes('M2_GOV_M2_PLAN_NOT_ACCEPTED'));
  assert.ok(codes(result).includes('M2_GOV_M2_PLAN_HEADER_BASELINE_DRIFT'));
  assert.ok(codes(result).includes('M2_GOV_M2_PLAN_E0_BASELINE_DRIFT'));
  assert.ok(codes(result).includes('M2_GOV_M2_PLAN_RFC001_UNBOUND'));
  assert.ok(codes(result).includes('M2_GOV_DOMAIN_ADR013_NOT_SUPERSEDED'));
});

test('a proposed or wrong-version meta ADR remains a blocker', (context) => {
  const root = createAcceptedBaseline();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(
    root,
    'docs/meta/decisions/ADR-013-m3-v0.6.0.md',
    '# ADR-013: M3 migration\n\n**Status**: Proposed\n\nM3 v0.5.1.\n',
  );
  const result = auditM2GovernanceBaseline(root);
  assert.equal(result.outcome, 'failed');
  assert.ok(codes(result).includes('M2_GOV_META_ADR013_NOT_ACCEPTED'));
  assert.ok(codes(result).includes('M2_GOV_META_ADR013_WRONG_BASELINE'));
});
