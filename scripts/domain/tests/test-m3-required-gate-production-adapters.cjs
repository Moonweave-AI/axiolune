'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  FILES_BY_GATE,
  GATE_IDS,
  INVENTORY_TAG,
  VECTOR_CODES,
  VECTOR_SUBJECT_TAG,
  applyMutation,
  captureValidatedProductionCorpus,
  discoverSnapshot,
  discoverSubjects,
  evaluateM3RequiredGate,
  expectedDiscoveryTuple,
  runGateValidator,
  taggedDigest,
  validateCapturedCorpus,
} = require('../lib/m3-required-gate-semantic-adapter.cjs');
const {
  PROFILE_REF,
} = require('../lib/m2-release-capability-definitions.cjs');
const {
  productionVectorBaseline,
  productionVectorSubject,
} = require('../lib/production-required-gate-semantic-adapters.cjs');
const {
  REGISTRY_PATH,
  RELEASE_CHECKS_PATH,
  REQUIRED_GATES_PATH,
  parseRegistryBytes,
  validateReleaseCapabilityRegistry,
} = require('../lib/m2-release-capability-registry.cjs');
const {
  CATALOG_TAG,
  INVENTORY_TAG: REPLAY_INVENTORY_TAG,
  artifactKey,
  taggedJcsDigest,
} = require('../lib/m2-gate-artifact-binding-replay.cjs');
const {
  discoverSubjects: replayDiscoverSubjects,
  expectedInventory,
  verifyRequiredGateSemanticReplay,
} = require('../lib/m2-required-gate-semantic-replay.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const { sourceFileMap } = require('../replay-release-capability-payload.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE = path.join(
  ROOT,
  'scripts',
  'domain',
  'release-capability-profile',
  'v0.3.0',
  'gates',
);

function copyMetaCorpus(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m3-production-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const meta = path.join(root, 'ontology', 'meta');
  fs.mkdirSync(meta, { recursive: true });
  for (const name of FILES_BY_GATE['m3-import-digest']) {
    fs.copyFileSync(path.join(ROOT, 'ontology', 'meta', name), path.join(meta, name));
  }
  for (const gateId of GATE_IDS) {
    const relativePath = path.join(
      'scripts', 'domain', 'release-capability-profile', 'v0.3.0',
      'gates', gateId, 'discovery-contract.json',
    );
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relativePath), target);
  }
  return { root, meta };
}

function vector(gateId, category) {
  return JSON.parse(fs.readFileSync(
    path.join(PROFILE, gateId, 'vectors', `${category}.json`),
    'utf8',
  ));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function candidateRequest(root, gateId, snapshot = discoverSnapshot(root, gateId)) {
  const discovery = expectedDiscoveryTuple(root, gateId);
  const inventory = {
    schemaVersion: '1.0',
    gateId,
    discoveryContractRef: discovery.ref,
    discoveryContractDigest: discovery.digest,
    subjects: snapshot.subjects,
  };
  return {
    schemaVersion: '1.0', profileRef: PROFILE_REF,
    operation: 'replayRequiredGate', capabilityId: `gate.${gateId}`, gateId,
    subjectInventory: inventory,
    subjectInventoryDigest: taggedDigest(INVENTORY_TAG, inventory),
    dependencyReports: [], vectorCategory: null, fault: null,
  };
}

function equivalentQuotedFlowCore(bytes) {
  const text = bytes.toString('utf8');
  const document = yaml.load(text);
  const start = text.search(/^module:\s*$/mu);
  const metaModel = /^MetaModel:/mu.exec(text);
  const end = metaModel?.index ?? -1;
  assert.ok(start >= 0 && end > start, 'canonical core header boundaries are absent');
  const header = document.module;
  const flow = [
    '"module": {',
    `exports: [], version: ${JSON.stringify(header.version)}, imports: [], `,
    `preferredPrefix: ${JSON.stringify(header.preferredPrefix)}, `,
    `baseIri: ${JSON.stringify(header.baseIri)}, `,
    `moduleIri: ${JSON.stringify(header.moduleIri)}} # legal equivalent layout`,
  ].join('');
  return Buffer.from(`${text.slice(0, start)}${flow}\n\n${text.slice(end)}`, 'utf8');
}

function invalidCoreBytes(gateId, validBytes) {
  return applyMutation(gateId, new Map([
    ['core-meta-model.yaml', validBytes],
  ])).files.get('core-meta-model.yaml');
}

test('both production M3 adapters execute the real validators on the current isolated corpus', (t) => {
  const fixture = copyMetaCorpus(t);
  for (const gateId of GATE_IDS) {
    const result = runGateValidator(gateId, fixture.meta);
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.failedAssertions, []);
    assert.ok(result.checkedArtifactCount >= FILES_BY_GATE[gateId].length);
  }
});

test('real M3 byte mutations are rejected by the same production validators', (t) => {
  const schema = copyMetaCorpus(t);
  const schemaCore = path.join(schema.meta, 'core-meta-model.yaml');
  const schemaText = fs.readFileSync(schemaCore, 'utf8');
  fs.writeFileSync(schemaCore, schemaText.replace(/^module:/mu, 'moduleBroken:'));
  const schemaResult = runGateValidator('m3-schema', schema.meta);
  assert.equal(schemaResult.ok, false);
  assert.ok(schemaResult.findings.some((row) => row.code === 'M3_STRUCTURE'));

  const imports = copyMetaCorpus(t);
  const importCore = path.join(imports.meta, 'core-meta-model.yaml');
  fs.appendFileSync(importCore, '\n# controlled test digest mutation\n');
  const importResult = runGateValidator('m3-import-digest', imports.meta);
  assert.equal(importResult.ok, false);
  assert.ok(importResult.findings.some((row) => row.code === 'M3_DIGESTMATCH'));
});

test('generated positive/violation vectors bind current source bytes and execute all semantic polarities', (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m3-vector-test-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  for (const gateId of GATE_IDS) {
    for (const category of ['positive', 'violation', 'tamper', 'emptySubject', 'engineFailure']) {
      const request = vector(gateId, category);
      if (request.subject) {
        for (const row of request.subject.baselineFiles) {
          const actual = fs.readFileSync(path.join(ROOT, 'ontology', 'meta', row.path));
          assert.equal(actual.toString('base64'), row.contentBase64);
        }
      }
      const result = evaluateM3RequiredGate(request, { root: runtime });
      const expected = {
        positive: ['completed', 'accepted', null, 0],
        violation: [
          'completed',
          'violation',
          gateId === 'm3-schema'
            ? 'M3_SCHEMA_SEMANTIC_VIOLATION'
            : 'M3_IMPORT_DIGEST_SEMANTIC_VIOLATION',
          0,
        ],
        tamper: ['engineFailure', 'engineFailure', 'M3_GATE_VECTOR_SUBJECT_DIGEST', 2],
        emptySubject: ['engineFailure', 'engineFailure', 'M3_GATE_VECTOR_EMPTY_SUBJECT', 2],
        engineFailure: ['engineFailure', 'engineFailure', 'M3_GATE_VECTOR_ENGINE_FAILURE', 2],
      }[category];
      assert.deepEqual(
        [result.value.status, result.value.outcome, result.value.code, result.exitStatus],
        expected,
      );
      assert.equal(result.value.releaseEligibilityEvidence, false);
    }
  }
});

test('coherently re-digested vector mutation still fails the deterministic baseline-to-candidate proof', (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m3-vector-mutation-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const request = vector('m3-schema', 'violation');
  const target = request.subject.candidateFiles.find((row) => (
    row.path === 'core-meta-model.yaml'
  ));
  const bytes = Buffer.from(target.contentBase64, 'base64');
  const changed = Buffer.concat([bytes, Buffer.from('\n# resealed attacker mutation\n')]);
  target.contentBase64 = changed.toString('base64');
  target.byteLength = changed.length;
  target.digest = `sha256:${require('node:crypto').createHash('sha256').update(changed).digest('hex')}`;
  request.subjectDigest = taggedDigest(
    'axiolune-m3-required-gate-vector-subject-v1\0',
    request.subject,
  );
  const result = evaluateM3RequiredGate(request, { root: runtime });
  assert.equal(result.value.status, 'engineFailure');
  assert.equal(result.value.code, 'M3_GATE_VECTOR_CORPUS_BINDING');
  assert.equal(result.exitStatus, 2);
});

test('candidate replay discovers P1 bytes and establishes only independently validated evidence', (t) => {
  const fixture = copyMetaCorpus(t);
  for (const gateId of GATE_IDS) {
    const subjects = discoverSubjects(fixture.root, gateId);
    const discovery = expectedDiscoveryTuple(fixture.root, gateId);
    const inventory = {
      schemaVersion: '1.0',
      gateId,
      discoveryContractRef: discovery.ref,
      discoveryContractDigest: discovery.digest,
      subjects,
    };
    const request = {
      schemaVersion: '1.0', profileRef: PROFILE_REF,
      operation: 'replayRequiredGate', capabilityId: `gate.${gateId}`, gateId,
      subjectInventory: inventory,
      subjectInventoryDigest: taggedDigest(INVENTORY_TAG, inventory),
      dependencyReports: [], vectorCategory: null, fault: null,
    };
    const result = evaluateM3RequiredGate(request, { root: fixture.root });
    assert.equal(result.value.outcome, 'passed');
    assert.equal(result.value.releaseEligibilityEvidence, true);
    assert.equal(result.value.callerEvidenceAccepted, false);
  }
});

test('production baseline validates and returns one immutable M3 byte snapshot', (t) => {
  for (const gateId of GATE_IDS) {
    const fixture = copyMetaCorpus(t);
    const target = path.join(fixture.meta, 'core-meta-model.yaml');
    const expected = fs.readFileSync(target);
    const originalRead = fs.readFileSync;
    let sourceReadCount = 0;
    let switched = false;
    fs.readFileSync = function sourceSwitchAttempt(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(target)) {
        sourceReadCount += 1;
        if (sourceReadCount === 2) {
          fs.writeFileSync(target, Buffer.from('module: [controlled-invalid-yaml\n', 'utf8'));
          switched = true;
        }
      }
      return originalRead.call(this, file, ...args);
    };
    let baseline;
    try {
      baseline = productionVectorBaseline(fixture.root, gateId);
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(sourceReadCount, 1);
    assert.equal(switched, false);
    assert.equal(baseline.get('core-meta-model.yaml').equals(expected), true);
  }
});

test('object-level violation mutation accepts quoted keys, reordered fields, comments, and flow style', (t) => {
  const fixture = copyMetaCorpus(t);
  const corePath = path.join(fixture.meta, 'core-meta-model.yaml');
  const original = fs.readFileSync(corePath);
  const equivalent = equivalentQuotedFlowCore(original);
  const schemaFiles = discoverSnapshot(fixture.root, 'm3-schema').files;
  schemaFiles.set('core-meta-model.yaml', equivalent);
  const schemaBaseline = validateCapturedCorpus(fixture.root, 'm3-schema', schemaFiles);
  assert.equal(schemaBaseline.ok, true, JSON.stringify(schemaBaseline.findings));

  for (const gateId of GATE_IDS) {
    const files = discoverSnapshot(fixture.root, gateId).files;
    files.set('core-meta-model.yaml', equivalent);
    const mutation = applyMutation(gateId, files);
    assert.equal(mutation.descriptor.sourceDigest, sha256(equivalent));
    assert.notEqual(mutation.descriptor.resultDigest, mutation.descriptor.sourceDigest);
    const changed = yaml.load(mutation.files.get('core-meta-model.yaml').toString('utf8'));
    if (gateId === 'm3-schema') {
      assert.equal(Object.hasOwn(changed, 'module'), false);
      assert.equal(Object.hasOwn(changed, 'moduleBroken'), true);
    } else {
      assert.match(changed.MetaModel.description, /\[controlled digest mutation\]$/u);
    }
  }
});

test('object-level production mutations are rejected by their matching M3 validators', (t) => {
  for (const gateId of GATE_IDS) {
    const fixture = copyMetaCorpus(t);
    const baseline = captureValidatedProductionCorpus(fixture.root, gateId);
    const mutation = applyMutation(gateId, baseline);
    const validation = validateCapturedCorpus(fixture.root, gateId, mutation.files);
    assert.equal(validation.ok, false);
    assert.ok(validation.findings.length > 0);
    if (gateId === 'm3-schema') {
      assert.ok(validation.findings.some((row) => row.code === 'M3_STRUCTURE'));
    } else {
      assert.ok(validation.findings.some((row) => (
        ['M3_DIGESTMATCH', 'M3_IMPORT_VALIDATION_FAILED'].includes(row.code)
      )));
    }
  }
});

test('fresh production vector subjects execute both M3 semantic polarities', (t) => {
  for (const gateId of GATE_IDS) {
    const fixture = copyMetaCorpus(t);
    for (const category of ['positive', 'violation']) {
      const subject = productionVectorSubject(fixture.root, gateId, category);
      const request = {
        schemaVersion: '1.0', profileRef: PROFILE_REF,
        operation: 'semanticVector', capabilityId: `gate.${gateId}`, gateId,
        vectorCategory: category, subject,
        subjectDigest: taggedDigest(VECTOR_SUBJECT_TAG, subject),
        fault: null,
      };
      const result = evaluateM3RequiredGate(request, { root: fixture.root });
      assert.deepEqual(
        [result.value.status, result.value.outcome, result.exitStatus],
        category === 'positive'
          ? ['completed', 'accepted', 0]
          : ['completed', 'violation', 0],
      );
      if (category === 'violation') {
        assert.equal(
          result.value.code,
          gateId === 'm3-schema'
            ? 'M3_SCHEMA_SEMANTIC_VIOLATION'
            : 'M3_IMPORT_DIGEST_SEMANTIC_VIOLATION',
        );
      }
    }
  }
});

test('recursive M3 discovery blocks direct extra, nested extra, and missing gate files', async (t) => {
  await t.test('direct extra YAML', () => {
    const fixture = copyMetaCorpus(t);
    fs.writeFileSync(
      path.join(fixture.meta, 'controlled-extra.yaml'),
      'module: {moduleIri: "https://example.invalid/extra"}\n',
      'utf8',
    );
    assert.throws(
      () => productionVectorBaseline(fixture.root, 'm3-schema'),
      /vector corpus inventory differs/u,
    );
    const request = candidateRequest(fixture.root, 'm3-schema');
    const result = evaluateM3RequiredGate(request, { root: fixture.root });
    assert.equal(result.value.outcome, 'failed');
    assert.ok(result.value.kindEvidence.findings.some((row) => (
      row.code === 'M3_GATE_CORPUS_INVENTORY'
    )));
  });

  await t.test('nested extra YAML', () => {
    const fixture = copyMetaCorpus(t);
    const nested = path.join(fixture.meta, 'nested', 'controlled-extra.yaml');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'controlled: true\n', 'utf8');
    assert.throws(
      () => productionVectorBaseline(fixture.root, 'm3-import-digest'),
      /vector corpus inventory differs/u,
    );
    const request = candidateRequest(fixture.root, 'm3-import-digest');
    const result = evaluateM3RequiredGate(request, { root: fixture.root });
    assert.equal(result.value.outcome, 'failed');
    assert.ok(result.value.kindEvidence.findings.some((row) => (
      row.code === 'M3_GATE_CORPUS_INVENTORY'
    )));
  });

  await t.test('missing canonical YAML', () => {
    const fixture = copyMetaCorpus(t);
    fs.unlinkSync(path.join(fixture.meta, 'behavior-meta-model.yaml'));
    assert.throws(
      () => productionVectorBaseline(fixture.root, 'm3-schema'),
      /vector corpus inventory differs/u,
    );
    const request = candidateRequest(fixture.root, 'm3-schema');
    const result = evaluateM3RequiredGate(request, { root: fixture.root });
    assert.equal(result.value.outcome, 'failed');
    assert.ok(result.value.kindEvidence.findings.some((row) => (
      row.code === 'M3_GATE_CORPUS_INVENTORY'
    )));
  });
});

test('M3 discovery and temporary materialization refuse symlinks when the platform permits them', (t) => {
  let exercised = 0;
  let discoveryExercised = false;
  const discoveryFixture = copyMetaCorpus(t);
  const validRequest = candidateRequest(discoveryFixture.root, 'm3-schema');
  const linkedYaml = path.join(discoveryFixture.meta, 'linked-extra.yaml');
  try {
    fs.symlinkSync(path.join(discoveryFixture.meta, 'core-meta-model.yaml'), linkedYaml, 'file');
    exercised += 1;
    discoveryExercised = true;
    const discoveryResult = evaluateM3RequiredGate(validRequest, {
      root: discoveryFixture.root,
    });
    assert.equal(discoveryResult.value.outcome, 'failed');
    assert.ok(discoveryResult.value.kindEvidence.findings.some((row) => (
      row.code === 'M3_GATE_DISCOVERY_FAILED' && /symlink/iu.test(row.message)
    )));
  } catch (cause) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(cause.code)) {
      t.diagnostic(`file symlink is unavailable on this platform: ${cause.code}`);
    } else {
      throw cause;
    }
  }
  if (!discoveryExercised) {
    const outsideDiscovery = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m3-discovery-outside-'));
    t.after(() => fs.rmSync(outsideDiscovery, { recursive: true, force: true }));
    const linkedDirectory = path.join(discoveryFixture.meta, 'linked-directory');
    try {
      fs.symlinkSync(outsideDiscovery, linkedDirectory, 'junction');
      exercised += 1;
      discoveryExercised = true;
      const discoveryResult = evaluateM3RequiredGate(validRequest, {
        root: discoveryFixture.root,
      });
      assert.equal(discoveryResult.value.outcome, 'failed');
      assert.ok(discoveryResult.value.kindEvidence.findings.some((row) => (
        row.code === 'M3_GATE_DISCOVERY_FAILED' && /symlink/iu.test(row.message)
      )));
    } catch (cause) {
      if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(cause.code)) {
        t.diagnostic(`discovery junction is unavailable on this platform: ${cause.code}`);
      } else {
        throw cause;
      }
    }
  }

  const materializationFixture = copyMetaCorpus(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m3-semantic-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const semanticTemp = path.join(materializationFixture.root, '.semantic-tmp');
  try {
    fs.symlinkSync(outside, semanticTemp, 'junction');
    exercised += 1;
    const files = discoverSnapshot(materializationFixture.root, 'm3-schema').files;
    assert.throws(
      () => validateCapturedCorpus(materializationFixture.root, 'm3-schema', files),
      /must be a real directory below the source root/u,
    );
  } catch (cause) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(cause.code)) {
      t.diagnostic(`directory link is unavailable on this platform: ${cause.code}`);
    } else {
      throw cause;
    }
  }
  if (exercised === 0) t.skip('symlink and junction creation are both unavailable');
});

test('M3 semantic worker stays within the P1 .semantic-tmp write boundary', (t) => {
  for (const gateId of GATE_IDS) {
    const fixture = copyMetaCorpus(t);
    const semanticTemp = path.join(fixture.root, '.semantic-tmp');
    fs.mkdirSync(semanticTemp, { recursive: false });
    const request = vector(gateId, 'positive');
    const result = spawnSync(process.execPath, [
      '--permission',
      `--allow-fs-read=${ROOT}`,
      `--allow-fs-read=${fixture.root}`,
      `--allow-fs-write=${semanticTemp}`,
      '--no-global-search-paths',
      path.join(ROOT, 'scripts', 'domain', 'run-production-required-gate.cjs'),
      '--required-gate-semantic',
    ], {
      cwd: fixture.root,
      input: Buffer.from(canonicalJcs(request), 'utf8'),
      encoding: null,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || '',
        WINDIR: process.env.WINDIR || '',
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, Buffer.from(result.stderr || []).toString('utf8'));
    assert.equal(Buffer.from(result.stderr || []).length, 0);
    const stdout = Buffer.from(result.stdout || []);
    const output = JSON.parse(stdout.toString('utf8'));
    assert.equal(stdout.equals(Buffer.from(canonicalJcs(output), 'utf8')), true);
    assert.equal(output.status, 'completed');
    assert.equal(output.outcome, 'accepted');
    assert.equal(output.releaseEligibilityEvidence, false);
    assert.deepEqual(fs.readdirSync(semanticTemp), []);
  }
});

test('M3 temporary materialization rejects traversal and cleans only its owned directory', (t) => {
  const fixture = copyMetaCorpus(t);
  const semanticTemp = path.join(fixture.root, '.semantic-tmp');
  const files = discoverSnapshot(fixture.root, 'm3-schema').files;
  const valid = validateCapturedCorpus(fixture.root, 'm3-schema', files);
  assert.equal(valid.ok, true, JSON.stringify(valid.findings));
  assert.equal(fs.existsSync(semanticTemp), false);

  const unsafe = new Map(files);
  unsafe.set('../escape.yaml', Buffer.from('controlled: true\n', 'utf8'));
  assert.throws(
    () => validateCapturedCorpus(fixture.root, 'm3-schema', unsafe),
    /unsafe M3 corpus path/u,
  );
  assert.equal(fs.existsSync(path.join(fixture.root, 'escape.yaml')), false);
  assert.equal(fs.existsSync(semanticTemp), false);
});

test('M3 candidate validation is snapshot-consistent under invalid-to-valid and valid-to-invalid switches', (t) => {
  for (const gateId of GATE_IDS) {
    for (const direction of ['invalid-to-valid', 'valid-to-invalid']) {
      const fixture = copyMetaCorpus(t);
      const corePath = path.join(fixture.meta, 'core-meta-model.yaml');
      const valid = fs.readFileSync(corePath);
      const invalid = invalidCoreBytes(gateId, valid);
      const source = direction === 'invalid-to-valid' ? invalid : valid;
      const replacement = direction === 'invalid-to-valid' ? valid : invalid;
      fs.writeFileSync(corePath, source);
      const request = candidateRequest(fixture.root, gateId);

      const originalRead = fs.readFileSync;
      let switched = false;
      fs.readFileSync = function switchedRead(file, ...args) {
        const bytes = originalRead.call(this, file, ...args);
        if (!switched && path.resolve(String(file)) === path.resolve(corePath)) {
          switched = true;
          fs.writeFileSync(corePath, replacement);
        }
        return bytes;
      };
      let result;
      try {
        result = evaluateM3RequiredGate(request, { root: fixture.root });
      } finally {
        fs.readFileSync = originalRead;
      }
      assert.equal(switched, true);
      assert.equal(
        result.value.outcome,
        direction === 'invalid-to-valid' ? 'failed' : 'passed',
        `${gateId}/${direction}: ${JSON.stringify(result.value.kindEvidence.findings)}`,
      );
      assert.equal(
        result.value.releaseEligibilityEvidence,
        direction === 'valid-to-invalid',
      );
    }
  }
});

test('M3 vector evaluator rejects a correctly digested tamper label and unknown categories', (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m3-vector-polarity-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  for (const gateId of GATE_IDS) {
    const correctlyBoundTamper = vector(gateId, 'positive');
    correctlyBoundTamper.vectorCategory = 'tamper';
    correctlyBoundTamper.subjectDigest = taggedDigest(
      'axiolune-m3-required-gate-vector-subject-v1\0',
      correctlyBoundTamper.subject,
    );
    const tamperResult = evaluateM3RequiredGate(correctlyBoundTamper, { root: runtime });
    assert.equal(tamperResult.value.status, 'engineFailure');
    assert.equal(tamperResult.value.code, VECTOR_CODES.tamperNotDemonstrated);
    assert.equal(tamperResult.exitStatus, 2);

    const unknown = vector(gateId, 'positive');
    unknown.vectorCategory = 'controlled-unknown-category';
    const unknownResult = evaluateM3RequiredGate(unknown, { root: runtime });
    assert.equal(unknownResult.value.status, 'engineFailure');
    assert.equal(unknownResult.value.code, VECTOR_CODES.vectorCategoryInvalid);
    assert.equal(unknownResult.exitStatus, 2);
  }
});

test('production capability source-byte mutation breaks the registry digest closure', () => {
  const files = sourceFileMap(ROOT);
  const registry = parseRegistryBytes(files.get(REGISTRY_PATH));
  const entry = registry.entries.find((row) => row.capabilityId === 'gate.m3-schema');
  files.set(entry.capabilityRef.path, Buffer.concat([
    files.get(entry.capabilityRef.path), Buffer.from(' ', 'utf8'),
  ]));
  const issues = [];
  validateReleaseCapabilityRegistry({
    registry,
    files,
    requiredGates: JSON.parse(files.get(REQUIRED_GATES_PATH).toString('utf8')),
    releaseChecks: JSON.parse(files.get(RELEASE_CHECKS_PATH).toString('utf8')),
    issues,
  });
  assert.ok(issues.some((issue) => (
    issue.code === 'M2_RELEASE_CAPABILITY_ARTIFACT_DIGEST'
      && issue.path === entry.capabilityRef.path
  )));
});

test('coherently resealed semantic dependency tuple cannot diverge from the runtime lock', () => {
  const files = sourceFileMap(ROOT);
  const registry = parseRegistryBytes(files.get(REGISTRY_PATH));
  const entry = registry.entries.find((row) => row.capabilityId === 'gate.m3-schema');
  const input = JSON.parse(files.get(entry.inputContractRef.path).toString('utf8'));
  input.runtimeDependencies[0].treeDigest = `sha256:${'0'.repeat(64)}`;
  const inputBytes = jcsBytes(input);
  files.set(entry.inputContractRef.path, inputBytes);
  entry.inputContractDigest = sha256(inputBytes);

  const capability = JSON.parse(files.get(entry.capabilityRef.path).toString('utf8'));
  capability.inputContract.digest = entry.inputContractDigest;
  const capabilityBytes = jcsBytes(capability);
  files.set(entry.capabilityRef.path, capabilityBytes);
  entry.capabilityDigest = sha256(capabilityBytes);

  const required = JSON.parse(files.get(REQUIRED_GATES_PATH).toString('utf8'));
  const gate = required.gates.find((row) => row.gateId === 'm3-schema');
  gate.capabilityDigest = entry.capabilityDigest;
  files.set(REQUIRED_GATES_PATH, jcsBytes(required));
  const releaseChecks = JSON.parse(files.get(RELEASE_CHECKS_PATH).toString('utf8'));
  const issues = [];
  validateReleaseCapabilityRegistry({
    registry, files, requiredGates: required, releaseChecks, issues,
  });
  assert.ok(issues.some((issue) => (
    issue.code === 'M2_RELEASE_CAPABILITY_RUNTIME_DEPENDENCY_BINDING'
      && issue.path === entry.inputContractRef.path
  )));
});

test('generated production descriptors establish both M3 gates through isolated P1 semantic replay', {
  timeout: 120_000,
}, () => {
  const sourceArtifacts = sourceFileMap(ROOT);
  for (const name of FILES_BY_GATE['m3-import-digest']) {
    sourceArtifacts.set(
      `ontology/meta/${name}`,
      fs.readFileSync(path.join(ROOT, 'ontology', 'meta', name)),
    );
  }
  const requiredGates = JSON.parse(
    sourceArtifacts.get(REQUIRED_GATES_PATH).toString('utf8'),
  );
  const artifacts = new Map();
  const putPayload = (relativePath, value) => {
    const bytes = Buffer.isBuffer(value) ? value : jcsBytes(value);
    artifacts.set(relativePath, bytes);
    return {
      ref: { kind: 'path', root: 'payload', path: relativePath },
      digest: sha256(bytes),
      bytes,
    };
  };
  const build = {
    phase: 'P1ReleaseBuild',
    buildId: `sha256:${'7'.repeat(64)}`,
  };
  const catalogEntries = [];
  const gateReports = [];
  for (const gateId of GATE_IDS) {
    const gate = requiredGates.gates.find((row) => row.gateId === gateId);
    const discovery = JSON.parse(
      sourceArtifacts.get(gate.discoveryContractRef.path).toString('utf8'),
    );
    const subjects = replayDiscoverSubjects(gate, discovery, sourceArtifacts);
    const inventory = expectedInventory(gate, subjects);
    const inventoryDigest = taggedJcsDigest(REPLAY_INVENTORY_TAG, inventory);
    const inventoryPayload = putPayload(`evidence/${gateId}-inventory.json`, inventory);
    const inventoryRef = {
      kind: 'path', root: 'buildEvidence', path: `inventories/${gateId}`,
    };
    catalogEntries.push({
      artifactRef: inventoryRef,
      artifactDigest: inventoryDigest,
      payloadByteDigest: inventoryPayload.digest,
      mediaType: 'application/json',
      locator: {
        kind: 'wholeFile',
        path: inventoryPayload.ref.path,
        byteLength: inventoryPayload.bytes.length,
      },
      digestProfile: {
        kind: 'taggedJcs',
        domainTag: REPLAY_INVENTORY_TAG,
        canonicalization: 'RFC8785-JCS',
      },
    });
    const request = {
      schemaVersion: '1.0', profileRef: PROFILE_REF,
      operation: 'replayRequiredGate', capabilityId: gate.capabilityId, gateId,
      subjectInventory: inventory, subjectInventoryDigest: inventoryDigest,
      dependencyReports: [], vectorCategory: null, fault: null,
    };
    const evidenceValue = evaluateM3RequiredGate(request, { root: ROOT }).value;
    const evidencePayload = putPayload(`evidence/${gateId}-evidence.json`, evidenceValue);
    const reportValue = {
      schemaVersion: '1.0', profileRef: PROFILE_REF, build,
      gateId, reportKind: gate.reportKind, criterionRefs: gate.criterionRefs,
      toolId: gate.toolId, capabilityId: gate.capabilityId,
      capabilityRef: gate.capabilityRef, capabilityDigest: gate.capabilityDigest,
      entrypointRef: gate.entrypointRef, entrypointDigest: gate.entrypointDigest,
      discoveryContractRef: gate.discoveryContractRef,
      discoveryContractDigest: gate.discoveryContractDigest,
      subjectInventoryRef: inventoryRef, subjectInventoryDigest: inventoryDigest,
      kindEvidence: {
        schemaRef: gate.evidenceSchemaRef,
        schemaDigest: gate.evidenceSchemaDigest,
        artifactRef: evidencePayload.ref,
        artifactDigest: evidencePayload.digest,
      },
      recordType: 'validationReport', result: { outcome: 'passed' },
    };
    const reportPayload = putPayload(`evidence/${gateId}-report.json`, reportValue);
    gateReports.push({
      gateId,
      reportRef: reportPayload.ref,
      reportDigest: reportPayload.digest,
      outcome: 'passed',
    });
  }
  catalogEntries.sort((left, right) => Buffer.compare(
    Buffer.from(artifactKey(left.artifactRef, left.artifactDigest), 'utf8'),
    Buffer.from(artifactKey(right.artifactRef, right.artifactDigest), 'utf8'),
  ));
  const catalog = {
    schemaVersion: '1.0', targetVersion: '0.3.0', entries: catalogEntries,
  };
  const catalogPayload = putPayload('payload-artifact-catalog.json', catalog);
  const entries = [...artifacts].map(([relativePath, bytes]) => ({
    path: relativePath,
    mediaType: 'application/json',
    byteLength: bytes.length,
    payloadByteDigest: sha256(bytes),
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'),
  ));
  gateReports.sort((left, right) => Buffer.compare(
    Buffer.from(left.gateId, 'utf8'), Buffer.from(right.gateId, 'utf8'),
  ));
  const p1 = {
    targetVersion: '0.3.0', build, entries, gateReports,
    payloadArtifactCatalogRef: catalogPayload.ref,
    payloadArtifactCatalogDigest: taggedJcsDigest(CATALOG_TAG, catalog),
  };
  const result = verifyRequiredGateSemanticReplay({
    p1,
    requiredGates,
    artifacts,
    sourceArtifacts,
    trustedRoot: ROOT,
    timeoutMs: 60_000,
  });
  const established = result.gateOutcomes
    .filter((row) => row.releaseGateEvidenceEstablished)
    .map((row) => row.gateId);
  assert.deepEqual(established, GATE_IDS);
  for (const gateId of GATE_IDS) {
    const row = result.gateOutcomes.find((item) => item.gateId === gateId);
    assert.equal(row.declaredEntrypointExecuted, true);
    assert.equal(row.declaredDiscoveryReplayed, true);
    assert.equal(row.declaredEvidenceSchemaValidated, true);
    assert.equal(row.kindEvidenceByteEquivalent, true);
    assert.equal(row.fiveVectorCategoriesPassed, true);
    assert.equal(row.vectorCaseCount, 5);
  }
  assert.equal(result.releaseGateEvidenceEstablished, false);
});
