'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  REASONER_GATE_IDS,
  TRUSTED_CONTROL_PATHS,
  artifactDigest,
  materializeVerifiedP1Subset,
  verifyReasonerReplay,
} = require('../lib/m2-reasoner-replay.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function treeFile(relativePath, content = null) {
  const bytes = content === null
    ? fs.readFileSync(path.join(ROOT, ...relativePath.split('/')))
    : Buffer.from(content);
  return {
    mode: '100644',
    path: relativePath,
    byteLength: bytes.length,
    artifactDigest: 'sha256:'.padEnd(71, '0'),
    content: bytes,
  };
}

function replayTree() {
  return {
    outcome: 'passed',
    issues: [],
    p1: {
      files: [
        ...TRUSTED_CONTROL_PATHS.map((relativePath) => treeFile(relativePath)),
        treeFile('package-lock.json'),
        treeFile('ontology/meta/projection/axiolune-meta.owl.ttl'),
        treeFile('ontology/domain/finance/foundation/module.yaml', 'module: fixture\n'),
        treeFile('tests/m2/fixtures/owl-dl/consistent.ttl', '<urn:s> <urn:p> <urn:o> .\n'),
        treeFile('unrelated/private.txt', 'must-not-be-materialized'),
      ],
    },
  };
}

function evidence() {
  return {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    outcome: 'passed',
    moduleCount: 10,
    importedOntologyIris: Array.from({ length: 11 }, (_, index) => `urn:ontology:${index}`),
    sourceArtifacts: Array.from({ length: 11 }, (_, index) => ({ path: `source-${index}` })),
    flattenedClosure: { path: 'flattened-closure.ttl' },
    toolchain: { robotVersion: '1.9.10' },
    gates: [
      { gateId: 'owl-dl-profile', outcome: 'passed', negativeProfileViolation: 'rejected' },
      {
        gateId: 'owl-reasoner-primary', name: 'HermiT', outcome: 'passed',
        implementation: 'org.semanticweb.HermiT', version: '1.4.5.456',
        outputDigest: 'sha256:'.padEnd(71, '1'),
      },
      {
        gateId: 'owl-reasoner-secondary', name: 'JFact', outcome: 'passed',
        implementation: 'uk.ac.manchester.cs.jfact', version: '4.0.4',
        outputDigest: 'sha256:'.padEnd(71, '2'),
      },
    ],
    negativeReasonerCorpus: [
      {
        reasoner: 'HermiT', fixture: 'inconsistent.ttl', outcome: 'rejected',
        diagnosticCode: 'ontology-inconsistent',
      },
      {
        reasoner: 'HermiT', fixture: 'unsatisfiable.ttl', outcome: 'rejected',
        diagnosticCode: 'unsatisfiable-class',
      },
      {
        reasoner: 'JFact', fixture: 'inconsistent.ttl', outcome: 'rejected',
        diagnosticCode: 'ontology-inconsistent',
      },
      {
        reasoner: 'JFact', fixture: 'unsatisfiable.ttl', outcome: 'rejected',
        diagnosticCode: 'unsatisfiable-class',
      },
    ],
  };
}

function candidate(replayEvidence = evidence()) {
  const digest = artifactDigest(replayEvidence);
  const evidenceRef = { kind: 'path', root: 'buildEvidence', path: 'owl/evidence' };
  const evidencePath = 'evidence/owl-dl-evidence.json';
  const artifacts = new Map([[evidencePath, Buffer.from(canonicalJcs(replayEvidence), 'utf8')]]);
  const gateReports = [];
  for (const gateId of REASONER_GATE_IDS) {
    const report = {
      gateId,
      kindEvidence: { artifactRef: evidenceRef, artifactDigest: digest },
    };
    const reportPath = `evidence/gates/${gateId}.json`;
    artifacts.set(reportPath, Buffer.from(canonicalJcs(report), 'utf8'));
    gateReports.push({
      gateId,
      reportRef: { kind: 'path', root: 'payload', path: reportPath },
      reportDigest: artifactDigest(report),
      outcome: 'passed',
    });
  }
  const catalog = {
    schemaVersion: '1.0',
    targetVersion: '0.3.0',
    entries: [{
      artifactRef: evidenceRef,
      artifactDigest: digest,
      locator: { kind: 'wholeFile', path: evidencePath },
    }],
  };
  artifacts.set('payload-artifact-catalog.json', Buffer.from(canonicalJcs(catalog), 'utf8'));
  return {
    p1: {
      gateReports,
      payloadArtifactCatalogRef: {
        kind: 'path', root: 'payload', path: 'payload-artifact-catalog.json',
      },
    },
    artifacts,
  };
}

function fakeRunner(replayEvidence) {
  return ({ outputRoot }) => {
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(
      path.join(outputRoot, 'owl-dl-evidence.json'),
      `${JSON.stringify(replayEvidence, null, 2)}\n`,
    );
    return { status: 0, signal: null, stdout: 'PASS', stderr: '' };
  };
}

test('materializes only the reasoner input subset from verified P1 bytes', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-reasoner-materialize-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const destination = path.join(parent, 'source');
  const written = materializeVerifiedP1Subset(replayTree().p1.files, destination);
  assert.ok(written.includes('ontology/domain/finance/foundation/module.yaml'));
  assert.equal(fs.existsSync(path.join(destination, 'unrelated', 'private.txt')), false);
  assert.equal(
    fs.readFileSync(
      path.join(destination, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml'),
      'utf8',
    ),
    'module: fixture\n',
  );
});

test('refuses a selected P1 path that attempts traversal', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-reasoner-traversal-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const files = replayTree().p1.files.concat([
    treeFile('ontology/domain/finance/../escape', 'escape'),
  ]);
  assert.throws(
    () => materializeVerifiedP1Subset(files, path.join(parent, 'source')),
    /unsafe reasoner source entry/u,
  );
});

test('trusted P1 replay joins exact evidence to all three gate reports', () => {
  const replayEvidence = evidence();
  const input = candidate(replayEvidence);
  const result = verifyReasonerReplay({
    gitReplay: replayTree(),
    p1: input.p1,
    artifacts: input.artifacts,
    trustedRoot: ROOT,
    executeRunner: fakeRunner(replayEvidence),
  });
  assert.equal(result.outcome, 'passed');
  assert.equal(result.releaseGateEvidenceEstablished, false);
  assert.equal(result.declaredEntrypointExecuted, false);
  assert.deepEqual(result.issues, []);
});

test('caller-authored reasoner evidence cannot differ from trusted replay', () => {
  const replayEvidence = evidence();
  const input = candidate(replayEvidence);
  const authored = structuredClone(replayEvidence);
  authored.gates[1].outputDigest = 'sha256:'.padEnd(71, '3');
  input.artifacts.set(
    'evidence/owl-dl-evidence.json',
    Buffer.from(canonicalJcs(authored), 'utf8'),
  );
  const result = verifyReasonerReplay({
    gitReplay: replayTree(),
    p1: input.p1,
    artifacts: input.artifacts,
    trustedRoot: ROOT,
    executeRunner: fakeRunner(replayEvidence),
  });
  assert.equal(result.outcome, 'invalid');
  assert.equal(
    result.issues.filter((issue) => (
      issue.code === 'M2_RELEASE_REASONER_EVIDENCE_REPLAY_MISMATCH'
    )).length,
    3,
  );
});

test('P1 cannot substitute the trusted reasoner runner before execution', () => {
  const gitReplay = replayTree();
  const runner = gitReplay.p1.files.find((file) => (
    file.path === 'scripts/domain/run-owl-dl-gate.cjs'
  ));
  runner.content = Buffer.concat([runner.content, Buffer.from('\n// substitution\n')]);
  let executed = false;
  const input = candidate();
  const result = verifyReasonerReplay({
    gitReplay,
    p1: input.p1,
    artifacts: input.artifacts,
    trustedRoot: ROOT,
    executeRunner: () => { executed = true; return { status: 0 }; },
  });
  assert.equal(executed, false);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_RELEASE_REASONER_TRUSTED_CONTROL_SUBSTITUTION'
  )));
});

test('reasoner replay stays unverified without an issue-free reconstructed P1 tree', () => {
  const result = verifyReasonerReplay({ gitReplay: null });
  assert.equal(result.outcome, 'incomplete');
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    'M2_RELEASE_REASONER_P1_TREE_REQUIRED',
  ]);
});
