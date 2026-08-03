'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  EVIDENCE_NAME,
  createEvidence,
  executeRequest,
  parseStrictJcsBytes,
  readStrictJcs,
  validateProfile,
  validateVectors,
  verifyClosure,
} = require('../run-post-trade-custom-runtime.cjs');
const {
  PATHS,
  ROOT,
} = require('../lib/post-trade-custom-profile.cjs');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');

function clone(value) {
  return structuredClone(value);
}

test('restricted runtime discovers all 31 bindings and executes selected plus complete fixture evidence', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-pto-custom-test-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [PATHS.runner, '--output-dir', output], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 180000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /constraints=31, vectors=68, regression=242, dispatchAttribution=29/u);
  const bytes = fs.readFileSync(path.join(output, EVIDENCE_NAME));
  const evidence = JSON.parse(bytes.toString('utf8'));
  assert.ok(bytes.equals(Buffer.from(canonicalJcs(evidence), 'utf8')));
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.componentEligible, true);
  assert.equal(evidence.discoveredConstraints.length, 31);
  assert.equal(evidence.vectorResults.length, 68);
  assert.equal(evidence.focusedRegressionResults.length, 242);
  assert.equal(evidence.dispatchAttributionResults.length, 29);
  assert.ok(evidence.vectorResults.every((row) => row.status === 'passed'));
  assert.ok(evidence.focusedRegressionResults.every((row) => row.status === 'passed'));
  assert.equal(
    evidence.dispatchAttributionResults.filter((row) => row.actual === 'WORKER_EXIT').length,
    1,
  );
  assert.ok(evidence.dispatchAttributionResults.every((row) => (
    row.status === 'passed'
      && (
        (row.actual === 'notApplicable'
          && row.expected === 'notApplicable'
          && row.observedViolationOwner)
        || (row.actual === 'WORKER_EXIT'
          && row.expected === 'WORKER_EXIT'
          && row.observedViolationOwner === null)
      )
  )));
  const byConstraint = new Map();
  for (const row of evidence.vectorResults) {
    if (!row.constraintIri || !['accepted', 'violation'].includes(row.category)) continue;
    const categories = byConstraint.get(row.constraintIri) || new Set();
    categories.add(row.category);
    byConstraint.set(row.constraintIri, categories);
  }
  assert.equal(byConstraint.size, 31);
  assert.ok([...byConstraint.values()].every((set) => set.has('accepted') && set.has('violation')));
  assert.deepEqual(
    new Map(evidence.vectorResults.filter((row) => row.category === 'engineFailure').map((row) => [row.caseId, row.actual])),
    new Map([
      ['unknown-constraint', 'WORKER_EXIT'],
      ['binding-tamper', 'WORKER_EXIT'],
      ['fixture-contract-tamper', 'WORKER_EXIT'],
      ['timeout', 'TIME_LIMIT'],
      ['oversize-input', 'INPUT_LIMIT'],
      ['oversize-output-cap', 'OUTPUT_LIMIT'],
    ]),
  );
  assert.ok(Object.values(evidence.permissionAssurance).every((value) => value === true));
  assert.deepEqual(evidence.evidenceClassification, {
    authorityClaim: 'none',
    externalAuthorityEvidence: false,
    productionEligible: false,
    scope: 'M2 Custom runtime conformance',
    syntheticFixture: true,
  });
});

test('discovery rejects expression, implementation, target, and inventory tampering', () => {
  const profile = readStrictJcs(PATHS.discovery).value;
  assert.equal(validateProfile(profile).constraints.length, 31);
  const expression = clone(profile);
  expression.constraints[0].expressionDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateProfile(expression), /expression digest drift/u);
  const implementation = clone(profile);
  implementation.constraints[0].implementationDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateProfile(implementation), /implementation digest\/ref drift/u);
  const target = clone(profile);
  target.constraints[0].targetElement = 'https://axiolune.ai/ontology/finance/post-trade-operations/Wrong';
  assert.throws(() => validateProfile(target), /target\/scope\/fixture binding drift/u);
  const missing = clone(profile);
  missing.constraints.pop();
  assert.throws(() => validateProfile(missing), /exactly 31 bindings/u);
});

test('fixture vectors reject corpus digest and embedded scenario tampering', () => {
  const profile = readStrictJcs(PATHS.discovery).value;
  const vectors = readStrictJcs(PATHS.vectors).value;
  assert.equal(validateVectors(vectors, profile).vectors.length, 31);
  const corpus = clone(vectors);
  corpus.fixtureCorpus.positive.artifactDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateVectors(corpus, profile), /fixture corpus digest/u);
  const scenario = clone(vectors);
  scenario.vectors[0].accepted.fixture.instance = {};
  assert.throws(() => validateVectors(scenario, profile), /fixture\/vector drift/u);
  assert.throws(() => createEvidence({ vectorOverride: scenario }), /fixture\/vector drift/u);
});

test('implementation closure rejects artifact and join-digest tampering', () => {
  const discovery = readStrictJcs(PATHS.discovery);
  const vectors = readStrictJcs(PATHS.vectors);
  const closure = readStrictJcs(PATHS.closure).value;
  assert.equal(verifyClosure(closure, discovery.bytes, vectors.bytes).artifacts.length, 17);
  const artifact = clone(closure);
  artifact.artifacts[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyClosure(artifact, discovery.bytes, vectors.bytes), /artifact digest drift/u);
  const join = clone(closure);
  join.closureDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyClosure(join, discovery.bytes, vectors.bytes), /join digest drift/u);
});

test('worker fails closed for unknown, mismatched, timeout, and closed-schema requests', () => {
  const vectors = readStrictJcs(PATHS.vectors).value.vectors;
  const seed = vectors[0];
  const next = vectors[1];
  assert.equal(executeRequest({
    constraintIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/UnknownCustom',
    fixture: seed.accepted.fixture,
    schemaVersion: '1.0',
    validatorId: seed.validatorId,
  }).code, 'WORKER_EXIT');
  assert.equal(executeRequest({
    constraintIri: seed.constraintIri,
    fixture: seed.accepted.fixture,
    schemaVersion: '1.0',
    validatorId: next.validatorId,
  }).code, 'WORKER_EXIT');
  assert.equal(executeRequest({
    constraintIri: seed.constraintIri,
    fixture: seed.accepted.fixture,
    mode: 'hang',
    schemaVersion: '1.0',
    validatorId: seed.validatorId,
  }, { timeoutMs: 200 }).code, 'TIME_LIMIT');
  assert.equal(executeRequest({
    constraintIri: seed.constraintIri,
    fixture: seed.accepted.fixture,
    schemaVersion: '1.0',
    unexpected: true,
    validatorId: seed.validatorId,
  }).code, 'WORKER_EXIT');
});

test('same-contract cross-dispatch cannot credit an ElectionResolution mutation to Election', () => {
  const vectors = readStrictJcs(PATHS.vectors).value.vectors;
  const owner = vectors.find((row) => row.validatorId === 'ElectionResolutionContract');
  const wrongTarget = vectors.find((row) => row.validatorId === 'CorporateActionElectionContract');
  assert(owner && wrongTarget);
  assert.equal(owner.violation.expectedCode, 'rights-resolution-precedence-proof');
  assert.equal(owner.violation.fixture.contract, wrongTarget.accepted.fixture.contract);
  const result = executeRequest({
    constraintIri: wrongTarget.constraintIri,
    fixture: owner.violation.fixture,
    schemaVersion: '1.0',
    validatorId: wrongTarget.validatorId,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.response.outcome, 'notApplicable');
  assert.equal(result.response.violation, null);
  assert.equal(result.response.observedViolation, owner.violation.expectedCode);
  assert.equal(result.response.observedViolationOwner, owner.validatorId);
});

test('strict evidence parser rejects duplicate-key and non-canonical JSON tampering', () => {
  assert.throws(
    () => parseStrictJcsBytes(Buffer.from('{"a":1,"a":1}', 'utf8'), 'duplicate'),
    /not exact JCS/u,
  );
  assert.throws(
    () => parseStrictJcsBytes(Buffer.from('{ "a": 1 }', 'utf8'), 'spaced'),
    /not exact JCS/u,
  );
});

test('profile generator check independently rejects source/artifact drift', () => {
  const run = spawnSync(process.execPath, [PATHS.generator, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /31 bindings, 8\/219 \+ 1\/14 corpus/u);
});
