'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  CORPUS_PATHS,
  GATE_ID,
  INVENTORY_TAG,
  VECTOR_SUBJECT_TAG,
  applyMutation,
  discoverSubjects,
  discoveryRules,
  evaluateModuleImportDagRequiredGate,
  expectedDiscoveryTuple,
  fileRows,
  loadProductionCorpus,
  taggedDigest,
  validateCapturedCorpus,
} = require('../lib/module-import-dag-required-gate-semantic-adapter.cjs');
const {
  CANONICAL_IMPORTS,
} = require('../lib/canonical-finance-dag.cjs');
const {
  PROFILE_REF,
} = require('../lib/m2-release-capability-definitions.cjs');
const {
  productionVectorBaseline,
  productionVectorIdentity,
  productionVectorSubject,
} = require('../lib/production-required-gate-semantic-adapters.cjs');
const {
  compareUtf8,
  validateModuleImportDag,
} = require('../lib/module-import-dag-validator.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function fileIdentity(absolutePath) {
  const stat = fs.statSync(absolutePath, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function descriptorHasIdentity(descriptor, identity) {
  if (typeof descriptor !== 'number') return false;
  const stat = fs.fstatSync(descriptor, { bigint: true });
  return String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
}

function appendInvalidUtf8Comment(bytes) {
  return Buffer.concat([bytes, Buffer.from([0x0a, 0x23, 0x20, 0xff, 0x0a])]);
}

function vectorRequest(category) {
  const subject = category === 'emptySubject'
    ? null
    : productionVectorSubject(
      ROOT,
      GATE_ID,
      category === 'violation' ? 'violation' : 'positive',
    );
  const digest = subject === null ? null : taggedDigest(VECTOR_SUBJECT_TAG, subject);
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: 'semanticVector',
    capabilityId: `gate.${GATE_ID}`,
    gateId: GATE_ID,
    vectorCategory: category,
    subject,
    subjectDigest: category === 'tamper' ? `sha256:${'0'.repeat(64)}` : digest,
    fault: category === 'engineFailure' ? 'forced-engine-failure' : null,
  };
}

function copyCorpus(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-module-dag-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relativePath of CORPUS_PATHS) {
    const target = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, ...relativePath.split('/')), target);
  }
  const discoveryPath = [
    'scripts/domain/release-capability-profile/v0.3.0/gates',
    GATE_ID,
    'discovery-contract.json',
  ].join('/');
  const discoveryTarget = path.join(root, ...discoveryPath.split('/'));
  fs.mkdirSync(path.dirname(discoveryTarget), { recursive: true });
  fs.writeFileSync(discoveryTarget, Buffer.from(canonicalJcs({
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    capabilityId: `gate.${GATE_ID}`,
    bindingKind: 'requiredGate',
    stageId: null,
    strategy: { kind: 'sourceTreePathSet-v1', rules: discoveryRules() },
  }), 'utf8'));
  return root;
}

function mutatePostTradeAndReseal(root, mutate) {
  const moduleRelative = 'ontology/domain/finance/post-trade-operations/module.yaml';
  const modulePath = path.join(root, ...moduleRelative.split('/'));
  const module = yaml.load(fs.readFileSync(modulePath, 'utf8'));
  mutate(module, root);
  const moduleBytes = Buffer.from(yaml.dump(module, { lineWidth: 120, noRefs: true }), 'utf8');
  fs.writeFileSync(modulePath, moduleBytes);

  const registryRelative = 'ontology/domain/finance/registry/module-registry.yaml';
  const registryPath = path.join(root, ...registryRelative.split('/'));
  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
  registry.modules.find((row) => row.path === moduleRelative).artifactDigest = sha256(moduleBytes);
  fs.writeFileSync(
    registryPath,
    yaml.dump(registry, { lineWidth: 120, noRefs: true }),
    'utf8',
  );
}

function resealCanonicalDag(root, options = {}) {
  const digestByIri = new Map();
  for (const moduleName of Object.keys(CANONICAL_IMPORTS)) {
    const relativePath = `ontology/domain/finance/${moduleName}/module.yaml`;
    const absolutePath = path.join(root, ...relativePath.split('/'));
    const module = yaml.load(fs.readFileSync(absolutePath, 'utf8'));
    for (const imported of module.module.imports) {
      const targetDigest = digestByIri.get(imported.moduleIri);
      assert.ok(targetDigest, `topological reseal lacks ${imported.moduleIri}`);
      imported.artifactDigest = targetDigest;
    }
    const bytes = Buffer.from(yaml.dump(module, { lineWidth: 120, noRefs: true }), 'utf8');
    fs.writeFileSync(absolutePath, bytes);
    digestByIri.set(module.module.moduleIri, sha256(bytes));
  }
  const registryPath = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
  for (const row of registry.modules) {
    row.artifactDigest = sha256(fs.readFileSync(path.join(root, ...row.path.split('/'))));
  }
  fs.writeFileSync(registryPath, yaml.dump(registry, { lineWidth: 120, noRefs: true }), 'utf8');
  const validation = validateModuleImportDag(root);
  if (options.expectValid !== false) {
    assert.equal(validation.ok, true, JSON.stringify(validation.findings));
  }
  return validation;
}

function runM2Core(root) {
  const moduleFiles = CORPUS_PATHS
    .filter((relativePath) => relativePath !== 'ontology/domain/finance/registry/module-registry.yaml')
    .map((relativePath) => path.join(root, ...relativePath.split('/')));
  return spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'domain', 'validate-m2-core.js'),
    ...moduleFiles,
    '--strict',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
}

test('module-import-dag validator accepts the exact current ten-module graph and registry', () => {
  const result = validateModuleImportDag(ROOT);
  assert.deepEqual(result, {
    ok: true,
    findings: [],
    checkedArtifactCount: 11,
    passedAssertions: ['acyclic-imports', 'exact-version-imports', 'module-inventory'],
    failedAssertions: [],
  });
});

test('module-import-dag production adapter executes all five semantic polarities', () => {
  for (const category of [
    'positive', 'violation', 'tamper', 'emptySubject', 'engineFailure',
  ]) {
    const request = vectorRequest(category);
    const result = evaluateModuleImportDagRequiredGate(request, { root: ROOT });
    const expected = productionVectorIdentity(GATE_ID, category);
    assert.deepEqual({
      status: result.value.status,
      outcome: result.value.outcome,
      code: result.value.code,
      exitStatus: result.exitStatus,
      releaseEligibilityEvidence: result.value.releaseEligibilityEvidence,
    }, expected);
    assert.equal(result.value.callerEvidenceAccepted, false);
    assert.deepEqual(
      result.value.kindEvidence.checkedAssertions,
      ['acyclic-imports', 'exact-version-imports', 'module-inventory'],
    );
    if (category === 'violation') {
      assert.deepEqual(result.value.kindEvidence.failedAssertions, ['exact-version-imports']);
      assert.ok(result.value.kindEvidence.findings.some((row) => (
        row.code === 'IMPORT_VERSION_MISMATCH'
      )));
    }
  }
});

test('production vector baseline validates and returns the same captured source bytes', (t) => {
  const root = copyCorpus(t);
  resealCanonicalDag(root);
  const target = path.join(
    root, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
  );
  const expected = fs.readFileSync(target);
  const baseline = productionVectorBaseline(root, GATE_ID);
  assert.equal(baseline.get('ontology/domain/finance/foundation/module.yaml').equals(expected), true);
});

test('snapshot capture fails closed on same-path old-bytes to live-file replacement', (t) => {
  const root = copyCorpus(t);
  resealCanonicalDag(root);
  const target = path.join(
    root, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
  );
  const identity = fileIdentity(target);
  const originalRead = fs.readFileSync;
  let switched = false;
  fs.readFileSync = function sourceSwitchAttempt(file, ...args) {
    const targetsSource = descriptorHasIdentity(file, identity);
    const bytes = originalRead.call(this, file, ...args);
    if (!switched && targetsSource) {
      fs.writeFileSync(target, Buffer.from('module: [controlled-invalid-yaml\n', 'utf8'));
      switched = true;
    }
    return bytes;
  };
  try {
    assert.throws(
      () => productionVectorBaseline(root, GATE_ID),
      /changed while its bytes were captured|source changed after capture/u,
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(switched, true);
});

test('snapshot capture fails when a matching module appears after initial discovery', (t) => {
  const root = copyCorpus(t);
  resealCanonicalDag(root);
  const trigger = path.join(
    root, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
  );
  const triggerIdentity = fileIdentity(trigger);
  const extra = path.join(
    root, 'ontology', 'domain', 'finance', 'concurrent-extra', 'module.yaml',
  );
  const originalRead = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function concurrentExtraInjection(file, ...args) {
    const targetsTrigger = descriptorHasIdentity(file, triggerIdentity);
    const bytes = originalRead.call(this, file, ...args);
    if (!injected && targetsTrigger) {
      injected = true;
      fs.mkdirSync(path.dirname(extra), { recursive: true });
      fs.writeFileSync(extra, Buffer.from('module: {}\n', 'utf8'));
    }
    return bytes;
  };
  try {
    assert.throws(
      () => productionVectorBaseline(root, GATE_ID),
      /discovery changed while its immutable byte snapshot was captured/u,
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(injected, true);
});

test('captured corpus materialization rejects traversal before writing outside its root', (t) => {
  const root = copyCorpus(t);
  const files = loadProductionCorpus(root);
  const escapeName = `${path.basename(root)}-controlled-escape.yaml`;
  files.set(`../${escapeName}`, Buffer.from('escape: true\n', 'utf8'));
  assert.throws(
    () => validateCapturedCorpus(root, files),
    /unsafe module DAG corpus path|escapes materialization root/u,
  );
  assert.equal(fs.existsSync(path.join(root, '..', escapeName)), false);
});

test('violation mutation is invariant to quoted scalars and import-field order', (t) => {
  const root = copyCorpus(t);
  resealCanonicalDag(root);
  const moduleRelative = 'ontology/domain/finance/post-trade-operations/module.yaml';
  const modulePath = path.join(root, ...moduleRelative.split('/'));
  const module = yaml.load(fs.readFileSync(modulePath, 'utf8'));
  const imported = module.module.imports[0];
  module.module.imports[0] = {
    version: imported.version,
    importMode: imported.importMode,
    artifactDigest: imported.artifactDigest,
    moduleIri: imported.moduleIri,
    ...(imported.importedSymbols === undefined
      ? {}
      : { importedSymbols: imported.importedSymbols }),
  };
  const moduleBytes = Buffer.from(yaml.dump(module, {
    forceQuotes: true,
    lineWidth: 120,
    noCompatMode: true,
    noRefs: true,
    quotingType: "'",
    sortKeys: false,
  }), 'utf8');
  fs.writeFileSync(modulePath, moduleBytes);
  const registryPath = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
  registry.modules.find((row) => row.path === moduleRelative).artifactDigest = sha256(moduleBytes);
  fs.writeFileSync(registryPath, yaml.dump(registry, { lineWidth: 120, noRefs: true }), 'utf8');
  assert.equal(validateModuleImportDag(root).ok, true);

  const subject = productionVectorSubject(root, GATE_ID, 'violation');
  const request = {
    schemaVersion: '1.0', profileRef: PROFILE_REF, operation: 'semanticVector',
    capabilityId: `gate.${GATE_ID}`, gateId: GATE_ID, vectorCategory: 'violation',
    subject, subjectDigest: taggedDigest(VECTOR_SUBJECT_TAG, subject), fault: null,
  };
  const result = evaluateModuleImportDagRequiredGate(request, { root });
  assert.equal(result.value.status, 'completed');
  assert.equal(result.value.outcome, 'violation');
  assert.ok(result.value.kindEvidence.findings.some((row) => (
    row.code === 'IMPORT_VERSION_MISMATCH'
  )));
});

test('violation mutation preserves an exact semantic delta for full-flow quoted-key commented YAML', (t) => {
  const root = copyCorpus(t);
  resealCanonicalDag(root);
  const moduleRelative = 'ontology/domain/finance/post-trade-operations/module.yaml';
  const registryRelative = 'ontology/domain/finance/registry/module-registry.yaml';
  const modulePath = path.join(root, ...moduleRelative.split('/'));
  const registryPath = path.join(root, ...registryRelative.split('/'));
  const module = yaml.load(fs.readFileSync(modulePath, 'utf8'));
  const imported = module.module.imports[0];
  module.module.imports[0] = {
    version: imported.version,
    importMode: imported.importMode,
    artifactDigest: imported.artifactDigest,
    moduleIri: imported.moduleIri,
    ...(imported.importedSymbols === undefined
      ? {}
      : { importedSymbols: imported.importedSymbols }),
  };
  const moduleBytes = Buffer.from(
    `# full-flow module with quoted keys/scalars\n${JSON.stringify(module)}\n`,
    'utf8',
  );
  fs.writeFileSync(modulePath, moduleBytes);
  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
  registry.modules.find((row) => row.path === moduleRelative).artifactDigest = sha256(moduleBytes);
  const registryBytes = Buffer.from(
    `# full-flow registry with quoted keys/scalars\n${JSON.stringify(registry)}\n`,
    'utf8',
  );
  fs.writeFileSync(registryPath, registryBytes);
  assert.equal(validateModuleImportDag(root).ok, true);

  const baseline = loadProductionCorpus(root);
  const first = applyMutation(GATE_ID, baseline);
  const second = applyMutation(GATE_ID, baseline);
  assert.deepEqual(first.descriptor, second.descriptor);
  assert.equal(first.descriptor.targetPath, moduleRelative);
  assert.deepEqual(
    [...first.files].map(([name, bytes]) => [name, sha256(bytes)]),
    [...second.files].map(([name, bytes]) => [name, sha256(bytes)]),
  );

  const changedPaths = [...baseline]
    .filter(([name, bytes]) => !bytes.equals(first.files.get(name)))
    .map(([name]) => name)
    .sort(compareUtf8);
  assert.deepEqual(changedPaths, [moduleRelative, registryRelative].sort(compareUtf8));

  const baselineModule = yaml.load(baseline.get(moduleRelative).toString('utf8'));
  const expectedModule = structuredClone(baselineModule);
  expectedModule.module.imports.find((row) => (
    row.moduleIri === first.descriptor.importedModuleIri
  )).version = first.descriptor.resultVersion;
  assert.deepEqual(
    yaml.load(first.files.get(moduleRelative).toString('utf8')),
    expectedModule,
  );

  const baselineRegistry = yaml.load(baseline.get(registryRelative).toString('utf8'));
  const expectedRegistry = structuredClone(baselineRegistry);
  expectedRegistry.modules.find((row) => row.path === moduleRelative).artifactDigest =
    first.descriptor.targetResultDigest;
  assert.deepEqual(
    yaml.load(first.files.get(registryRelative).toString('utf8')),
    expectedRegistry,
  );

  const baselineValidation = validateCapturedCorpus(root, baseline);
  const candidateValidation = validateCapturedCorpus(root, first.files);
  assert.equal(baselineValidation.ok, true, JSON.stringify(baselineValidation.findings));
  assert.equal(candidateValidation.ok, false);
  assert.deepEqual(candidateValidation.failedAssertions, ['exact-version-imports']);
  assert.deepEqual(
    [...new Set(candidateValidation.findings.map((row) => row.code))],
    ['IMPORT_VERSION_MISMATCH'],
  );
});

test('production semantic worker completes under the P1 .semantic-tmp write boundary', (t) => {
  const root = copyCorpus(t);
  resealCanonicalDag(root);
  const semanticTemp = path.join(root, '.semantic-tmp');
  fs.mkdirSync(semanticTemp, { recursive: false });
  const files = loadProductionCorpus(root);
  const subject = {
    schemaVersion: '1.0',
    gateId: GATE_ID,
    baselineFiles: fileRows(files),
    candidateFiles: fileRows(files),
    mutation: null,
  };
  const request = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: 'semanticVector',
    capabilityId: `gate.${GATE_ID}`,
    gateId: GATE_ID,
    vectorCategory: 'positive',
    subject,
    subjectDigest: taggedDigest(VECTOR_SUBJECT_TAG, subject),
    fault: null,
  };
  const result = spawnSync(process.execPath, [
    '--permission',
    `--allow-fs-read=${ROOT}`,
    `--allow-fs-read=${root}`,
    `--allow-fs-write=${semanticTemp}`,
    '--no-global-search-paths',
    path.join(ROOT, 'scripts', 'domain', 'run-production-required-gate.cjs'),
    '--required-gate-semantic',
  ], {
    cwd: root,
    input: Buffer.from(canonicalJcs(request), 'utf8'),
    encoding: null,
    timeout: 30_000,
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
  assert.ok(stdout.length > 0);
  assert.equal(stdout.includes(0x0a) || stdout.includes(0x0d), false);
  const output = JSON.parse(stdout.toString('utf8'));
  assert.equal(stdout.equals(Buffer.from(canonicalJcs(output), 'utf8')), true);
  assert.equal(output.status, 'completed');
  assert.equal(output.outcome, 'accepted');
  assert.equal(output.releaseEligibilityEvidence, false);
  assert.deepEqual(fs.readdirSync(semanticTemp), []);
});

test('tamper label substitution without a digest mismatch fails closed', () => {
  const request = vectorRequest('tamper');
  request.subjectDigest = taggedDigest(VECTOR_SUBJECT_TAG, request.subject);
  const result = evaluateModuleImportDagRequiredGate(request, { root: ROOT });
  assert.equal(result.value.status, 'engineFailure');
  assert.equal(result.value.outcome, 'engineFailure');
  assert.equal(result.value.code, 'MODULE_IMPORT_DAG_VECTOR_TAMPER_NOT_DEMONSTRATED');
  assert.equal(result.exitStatus, 2);
});

test('unknown vector polarity fails closed before corpus evaluation', () => {
  const request = vectorRequest('positive');
  request.vectorCategory = 'attacker-defined-polarity';
  const result = evaluateModuleImportDagRequiredGate(request, { root: ROOT });
  assert.equal(result.value.status, 'engineFailure');
  assert.equal(result.value.code, 'MODULE_IMPORT_DAG_VECTOR_CATEGORY_INVALID');
  assert.equal(result.exitStatus, 2);
});

test('coherently resealed alternate module mutation cannot borrow the locked violation vector', () => {
  const request = vectorRequest('violation');
  const row = request.subject.candidateFiles.find((candidate) => (
    candidate.path === request.subject.mutation.targetPath
  ));
  const bytes = Buffer.from(row.contentBase64, 'base64');
  const changed = Buffer.concat([bytes, Buffer.from('\n# attacker-resealed alternate mutation\n', 'utf8')]);
  row.contentBase64 = changed.toString('base64');
  row.byteLength = changed.length;
  row.digest = sha256(changed);
  request.subjectDigest = taggedDigest(VECTOR_SUBJECT_TAG, request.subject);
  const result = evaluateModuleImportDagRequiredGate(request, { root: ROOT });
  assert.equal(result.value.status, 'engineFailure');
  assert.equal(result.value.code, 'MODULE_IMPORT_DAG_VECTOR_CORPUS_BINDING');
  assert.equal(result.exitStatus, 2);
});

test('candidate replay binds independent discovery, discovery bytes, inventory digest and empty dependencies', () => {
  const discovery = expectedDiscoveryTuple(ROOT);
  const subjects = discoverSubjects(ROOT);
  const inventory = {
    schemaVersion: '1.0',
    gateId: GATE_ID,
    discoveryContractRef: discovery.ref,
    discoveryContractDigest: discovery.digest,
    subjects,
  };
  const request = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: 'replayRequiredGate',
    capabilityId: `gate.${GATE_ID}`,
    gateId: GATE_ID,
    subjectInventory: inventory,
    subjectInventoryDigest: taggedDigest(INVENTORY_TAG, inventory),
    dependencyReports: [],
    vectorCategory: null,
    fault: null,
  };
  const accepted = evaluateModuleImportDagRequiredGate(request, { root: ROOT });
  assert.equal(accepted.value.outcome, 'passed');
  assert.equal(accepted.value.releaseEligibilityEvidence, true);
  request.subjectInventoryDigest = `sha256:${'0'.repeat(64)}`;
  const tampered = evaluateModuleImportDagRequiredGate(request, { root: ROOT });
  assert.equal(tampered.value.outcome, 'failed');
  assert.equal(tampered.value.releaseEligibilityEvidence, false);
  assert.ok(tampered.value.kindEvidence.findings.some((row) => (
    row.code === 'MODULE_IMPORT_DAG_SUBJECT_INVENTORY_DIGEST'
  )));
});

test('duplicate registry identity fails module-inventory even when YAML and all module bytes remain parseable', (t) => {
  const root = copyCorpus(t);
  const registryPath = path.join(root, ...CORPUS_PATHS.find((value) => (
    value.endsWith('module-registry.yaml')
  )).split('/'));
  const text = fs.readFileSync(registryPath, 'utf8');
  const firstStart = text.indexOf('  - moduleIri: ');
  const secondStart = text.indexOf('\n  - moduleIri: ', firstStart + 1);
  assert.ok(firstStart >= 0 && secondStart > firstStart);
  const firstBlock = text.slice(firstStart, secondStart);
  fs.writeFileSync(registryPath, `${text}${firstBlock}\n`, 'utf8');
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('module-inventory'));
  assert.ok(result.findings.some((row) => (
    ['REGISTRY_DUPLICATE_MODULE', 'REGISTRY_INVENTORY_MISMATCH'].includes(row.code)
  )));
});

test('missing-file findings are byte-deterministic across different materialization roots', (t) => {
  const left = copyCorpus(t);
  const right = copyCorpus(t);
  const registryRelative = 'ontology/domain/finance/registry/module-registry.yaml';
  fs.unlinkSync(path.join(left, ...registryRelative.split('/')));
  fs.unlinkSync(path.join(right, ...registryRelative.split('/')));
  const leftResult = validateModuleImportDag(left);
  const rightResult = validateModuleImportDag(right);
  assert.deepEqual(leftResult, rightResult);
  assert.equal(leftResult.ok, false);
  assert.ok(leftResult.findings.some((row) => row.code === 'REGISTRY_INVALID'));
});

test('deleting importMode remains a semantic failure after coherently resealing the leaf and registry', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module) => delete module.module.imports[0].importMode);

  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_TUPLE_INVALID'));
});

test('an unparseable import edge cannot be reported as acyclic', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module) => delete module.module.imports[0].moduleIri);
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('acyclic-imports'));
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_EDGE_INVALID'));
});

test('All mode rejects even an empty importedSymbols field after coherent reseal', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module) => {
    module.module.imports[0].importedSymbols = [];
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_SYMBOLS_MODE_MISMATCH'));
});

test('Selective mode rejects an empty localAlias after coherent reseal', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module, fixtureRoot) => {
    const foundation = yaml.load(fs.readFileSync(path.join(
      fixtureRoot, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
    ), 'utf8'));
    const symbol = Object.values(foundation.domain.objectTypes)
      .find((value) => typeof value?.iri === 'string').iri;
    module.module.imports[0].importMode = 'Selective';
    module.module.imports[0].importedSymbols = [{ symbolIri: symbol, localAlias: '' }];
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_SYMBOL_INVALID'));
});

test('Selective mode requires localAlias to be authored in Unicode NFC', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module, fixtureRoot) => {
    const foundation = yaml.load(fs.readFileSync(path.join(
      fixtureRoot, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
    ), 'utf8'));
    const symbol = Object.values(foundation.domain.objectTypes)
      .find((value) => typeof value?.iri === 'string').iri;
    const imported = module.module.imports.find((row) => row.moduleIri.endsWith('/foundation'));
    imported.importMode = 'Selective';
    imported.importedSymbols = [{ symbolIri: symbol, localAlias: 'e\u0301Alias' }];
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_ALIAS_INVALID'));
  const core = runM2Core(root);
  assert.equal(core.status, 1);
  assert.match(`${core.stdout}\n${core.stderr}`, /localAlias.*Unicode NFC/u);
});

test('Selective mode accepts the lower-camel localAlias used by the M3 contract', (t) => {
  const root = copyCorpus(t);
  const foundationPath = path.join(
    root, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
  );
  const foundation = yaml.load(fs.readFileSync(foundationPath, 'utf8'));
  const symbolIri = Object.values(foundation.domain.objectTypes)
    .find((value) => typeof value?.iri === 'string').iri;
  foundation.module.exports = [symbolIri];
  fs.writeFileSync(
    foundationPath,
    yaml.dump(foundation, { lineWidth: 120, noRefs: true }),
    'utf8',
  );
  const postTradePath = path.join(
    root, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.yaml',
  );
  const postTrade = yaml.load(fs.readFileSync(postTradePath, 'utf8'));
  const imported = postTrade.module.imports.find((row) => row.moduleIri.endsWith('/foundation'));
  imported.importMode = 'Selective';
  imported.importedSymbols = [{ symbolIri, localAlias: 'isIssuedBy' }];
  fs.writeFileSync(
    postTradePath,
    yaml.dump(postTrade, { lineWidth: 120, noRefs: true }),
    'utf8',
  );
  resealCanonicalDag(root);
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test('Selective aliases are unique across every import in the importing module', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module, fixtureRoot) => {
    const chooseSymbol = (moduleName) => {
      const target = yaml.load(fs.readFileSync(path.join(
        fixtureRoot, 'ontology', 'domain', 'finance', moduleName, 'module.yaml',
      ), 'utf8'));
      return Object.values(target.domain.objectTypes)
        .find((value) => typeof value?.iri === 'string').iri;
    };
    for (const moduleName of ['foundation', 'market-structure']) {
      const imported = module.module.imports.find((row) => row.moduleIri.endsWith(`/${moduleName}`));
      imported.importMode = 'Selective';
      imported.importedSymbols = [{
        symbolIri: chooseSymbol(moduleName),
        localAlias: 'Collision',
      }];
    }
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_ALIAS_DUPLICATE'));
});

test('Selective alias uniqueness uses Unicode NFC keys across imports', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module, fixtureRoot) => {
    const chooseSymbol = (moduleName) => {
      const target = yaml.load(fs.readFileSync(path.join(
        fixtureRoot, 'ontology', 'domain', 'finance', moduleName, 'module.yaml',
      ), 'utf8'));
      return Object.values(target.domain.objectTypes)
        .find((value) => typeof value?.iri === 'string').iri;
    };
    for (const [moduleName, localAlias] of [
      ['foundation', '\u00e9Alias'],
      ['market-structure', 'e\u0301Alias'],
    ]) {
      const imported = module.module.imports.find((row) => row.moduleIri.endsWith(`/${moduleName}`));
      imported.importMode = 'Selective';
      imported.importedSymbols = [{ symbolIri: chooseSymbol(moduleName), localAlias }];
    }
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_ALIAS_INVALID'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_ALIAS_DUPLICATE'));
  const core = runM2Core(root);
  assert.equal(core.status, 1);
  assert.match(`${core.stdout}\n${core.stderr}`, /local alias .*collides with/u);
});

test('Selective alias cannot shadow an authored localName in the importing module', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module, fixtureRoot) => {
    const foundation = yaml.load(fs.readFileSync(path.join(
      fixtureRoot, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
    ), 'utf8'));
    const symbol = Object.values(foundation.domain.objectTypes)
      .find((value) => typeof value?.iri === 'string').iri;
    const ownLocalName = Object.values(module.domain.objectTypes)
      .find((value) => /^[A-Z][a-zA-Z0-9]*$/u.test(value?.localName || '')).localName;
    const imported = module.module.imports.find((row) => row.moduleIri.endsWith('/foundation'));
    imported.importMode = 'Selective';
    imported.importedSymbols = [{ symbolIri: symbol, localAlias: ownLocalName }];
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_ALIAS_LOCAL_COLLISION'));
});

test('Selective alias/localName collision uses Unicode NFC keys', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module, fixtureRoot) => {
    const foundation = yaml.load(fs.readFileSync(path.join(
      fixtureRoot, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
    ), 'utf8'));
    const symbol = Object.values(foundation.domain.objectTypes)
      .find((value) => typeof value?.iri === 'string').iri;
    Object.values(module.domain.objectTypes)
      .find((value) => typeof value?.localName === 'string').localName = 'e\u0301Collision';
    const imported = module.module.imports.find((row) => row.moduleIri.endsWith('/foundation'));
    imported.importMode = 'Selective';
    imported.importedSymbols = [{ symbolIri: symbol, localAlias: '\u00e9Collision' }];
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_ALIAS_LOCAL_COLLISION'));
  const core = runM2Core(root);
  assert.equal(core.status, 1);
  assert.match(
    `${core.stdout}\n${core.stderr}`,
    /local alias .*collides with an authored localName/u,
  );
});

test('invalid canonical module YAML invalidates all three graph assertions', (t) => {
  const root = copyCorpus(t);
  const moduleRelative = 'ontology/domain/finance/post-trade-operations/module.yaml';
  const modulePath = path.join(root, ...moduleRelative.split('/'));
  const invalidBytes = Buffer.from('module: [controlled-invalid-yaml\n', 'utf8');
  fs.writeFileSync(modulePath, invalidBytes);
  const registryPath = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
  registry.modules.find((row) => row.path === moduleRelative).artifactDigest = sha256(invalidBytes);
  fs.writeFileSync(registryPath, yaml.dump(registry, { lineWidth: 120, noRefs: true }), 'utf8');

  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.passedAssertions, []);
  assert.deepEqual(
    result.failedAssertions,
    ['acyclic-imports', 'exact-version-imports', 'module-inventory'],
  );
  assert.ok(result.findings.some((row) => row.code === 'MODULE_YAML_INVALID'));
  assert.throws(
    () => productionVectorSubject(root, GATE_ID, 'positive'),
    /production module-import-dag vector baseline is invalid:.*MODULE_YAML_INVALID/u,
  );
});

test('module and registry parsing reject malformed UTF-8 even inside YAML comments', (t) => {
  const moduleRoot = copyCorpus(t);
  resealCanonicalDag(moduleRoot);
  const moduleRelative = 'ontology/domain/finance/post-trade-operations/module.yaml';
  const modulePath = path.join(moduleRoot, ...moduleRelative.split('/'));
  const invalidModule = appendInvalidUtf8Comment(fs.readFileSync(modulePath));
  fs.writeFileSync(modulePath, invalidModule);
  const moduleRegistryPath = path.join(
    moduleRoot, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  const moduleRegistry = yaml.load(fs.readFileSync(moduleRegistryPath, 'utf8'));
  moduleRegistry.modules.find((row) => row.path === moduleRelative).artifactDigest =
    sha256(invalidModule);
  fs.writeFileSync(
    moduleRegistryPath,
    yaml.dump(moduleRegistry, { lineWidth: 120, noRefs: true }),
    'utf8',
  );
  const moduleResult = validateModuleImportDag(moduleRoot);
  assert.equal(moduleResult.ok, false);
  assert.ok(moduleResult.findings.some((row) => (
    row.code === 'MODULE_YAML_INVALID' && /not valid UTF-8/u.test(row.message)
  )));

  const registryRoot = copyCorpus(t);
  resealCanonicalDag(registryRoot);
  const registryPath = path.join(
    registryRoot, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  fs.writeFileSync(registryPath, appendInvalidUtf8Comment(fs.readFileSync(registryPath)));
  const registryResult = validateModuleImportDag(registryRoot);
  assert.equal(registryResult.ok, false);
  assert.ok(registryResult.findings.some((row) => (
    row.code === 'REGISTRY_INVALID' && /not valid UTF-8/u.test(row.message)
  )));
});

test('semantic mutation rejects malformed UTF-8 in either module or registry bytes', (t) => {
  const root = copyCorpus(t);
  resealCanonicalDag(root);
  const baseline = loadProductionCorpus(root);
  for (const relativePath of [
    'ontology/domain/finance/post-trade-operations/module.yaml',
    'ontology/domain/finance/registry/module-registry.yaml',
  ]) {
    const corrupted = new Map(
      [...baseline].map(([name, bytes]) => [name, Buffer.from(bytes)]),
    );
    corrupted.set(relativePath, appendInvalidUtf8Comment(corrupted.get(relativePath)));
    assert.throws(
      () => applyMutation(GATE_ID, corrupted),
      new RegExp(`${relativePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} is not valid UTF-8`, 'u'),
    );
  }
});

test('canonical module path is inseparable from its module identity', (t) => {
  const root = copyCorpus(t);
  const foundationRelative = 'ontology/domain/finance/foundation/module.yaml';
  const marketRelative = 'ontology/domain/finance/market-structure/module.yaml';
  const foundationPath = path.join(root, ...foundationRelative.split('/'));
  const marketPath = path.join(root, ...marketRelative.split('/'));
  const foundationBytes = fs.readFileSync(foundationPath);
  const marketBytes = fs.readFileSync(marketPath);
  fs.writeFileSync(foundationPath, marketBytes);
  fs.writeFileSync(marketPath, foundationBytes);

  const registryPath = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
  const foundationRow = registry.modules.find((row) => row.moduleIri.endsWith('/foundation'));
  const marketRow = registry.modules.find((row) => row.moduleIri.endsWith('/market-structure'));
  foundationRow.path = marketRelative;
  marketRow.path = foundationRelative;
  fs.writeFileSync(registryPath, yaml.dump(registry, { lineWidth: 120, noRefs: true }), 'utf8');

  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.passedAssertions, []);
  assert.ok(result.findings.some((row) => row.code === 'MODULE_PATH_IDENTITY_MISMATCH'));
});

test('module exports used for import visibility are a closed owned symbol inventory', async (t) => {
  await t.test('exports must be an array', (subtest) => {
    const root = copyCorpus(subtest);
    mutatePostTradeAndReseal(root, (module) => {
      module.module.exports = 'not-an-array';
    });
    const result = validateModuleImportDag(root);
    assert.equal(result.ok, false);
    assert.ok(result.failedAssertions.includes('exact-version-imports'));
    assert.ok(result.findings.some((row) => row.code === 'MODULE_EXPORTS_INVALID'));
  });

  await t.test('explicit export must be owned by the module', (subtest) => {
    const root = copyCorpus(subtest);
    mutatePostTradeAndReseal(root, (module) => {
      module.module.exports = ['https://attacker.invalid/ontology/Evil'];
    });
    const result = validateModuleImportDag(root);
    assert.equal(result.ok, false);
    assert.ok(result.failedAssertions.includes('exact-version-imports'));
    assert.ok(result.findings.some((row) => row.code === 'MODULE_EXPORT_NOT_OWNED'));
  });

  await t.test('explicit exports must be unique', (subtest) => {
    const root = copyCorpus(subtest);
    mutatePostTradeAndReseal(root, (module) => {
      const iri = Object.values(module.domain.objectTypes)
        .find((value) => typeof value?.iri === 'string').iri;
      module.module.exports = [iri, iri];
    });
    const result = validateModuleImportDag(root);
    assert.equal(result.ok, false);
    assert.ok(result.failedAssertions.includes('exact-version-imports'));
    assert.ok(result.findings.some((row) => row.code === 'MODULE_EXPORT_INVENTORY_INVALID'));
  });

  await t.test('unique explicit exports may use any source order', (subtest) => {
    const root = copyCorpus(subtest);
    mutatePostTradeAndReseal(root, (module) => {
      const iris = Object.values(module.domain.objectTypes)
        .filter((value) => typeof value?.iri === 'string')
        .slice(0, 2)
        .map((value) => value.iri)
        .sort(compareUtf8)
        .reverse();
      assert.equal(iris.length, 2);
      module.module.exports = iris;
    });
    resealCanonicalDag(root);
    const result = validateModuleImportDag(root);
    assert.equal(result.ok, true, JSON.stringify(result.findings));
  });
});

test('unique Selective importedSymbols may use any source order', (t) => {
  const root = copyCorpus(t);
  const foundationPath = path.join(
    root, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
  );
  const foundation = yaml.load(fs.readFileSync(foundationPath, 'utf8'));
  const iris = Object.values(foundation.domain.objectTypes)
    .filter((value) => typeof value?.iri === 'string')
    .slice(0, 2)
    .map((value) => value.iri)
    .sort(compareUtf8);
  assert.equal(iris.length, 2);
  foundation.module.exports = [...iris];
  fs.writeFileSync(
    foundationPath,
    yaml.dump(foundation, { lineWidth: 120, noRefs: true }),
    'utf8',
  );
  const postTradePath = path.join(
    root, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.yaml',
  );
  const postTrade = yaml.load(fs.readFileSync(postTradePath, 'utf8'));
  const imported = postTrade.module.imports.find((row) => row.moduleIri.endsWith('/foundation'));
  imported.importMode = 'Selective';
  imported.importedSymbols = [...iris].reverse().map((symbolIri) => ({ symbolIri }));
  fs.writeFileSync(
    postTradePath,
    yaml.dump(postTrade, { lineWidth: 120, noRefs: true }),
    'utf8',
  );
  resealCanonicalDag(root);
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test('Selective importedSymbols still reject duplicate IRIs independent of source order', (t) => {
  const root = copyCorpus(t);
  mutatePostTradeAndReseal(root, (module, fixtureRoot) => {
    const foundation = yaml.load(fs.readFileSync(path.join(
      fixtureRoot, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
    ), 'utf8'));
    const symbolIri = Object.values(foundation.domain.objectTypes)
      .find((value) => typeof value?.iri === 'string').iri;
    const imported = module.module.imports.find((row) => row.moduleIri.endsWith('/foundation'));
    imported.importMode = 'Selective';
    imported.importedSymbols = [{ symbolIri }, { symbolIri }];
  });
  const result = validateModuleImportDag(root);
  assert.equal(result.ok, false);
  assert.ok(result.failedAssertions.includes('exact-version-imports'));
  assert.ok(result.findings.some((row) => row.code === 'IMPORT_SYMBOL_INVENTORY'));
});

test('generated public symbols follow the authoritative authored-container export surface', async (t) => {
  const firstAssociation = (module) => Object.values(module.domain.associationTypes)
    .find((value) => Array.isArray(value?.participantRoles) && value.participantRoles.length > 0);
  const firstCodeList = (module) => Object.values(module.domain.codeLists)
    .find((value) => Array.isArray(value?.values) && value.values.length > 0);
  const firstConcreteType = (module) => [
    ...Object.values(module.domain.objectTypes),
    ...Object.values(module.domain.associationTypes),
  ].find((value) => value?.abstract !== true && typeof value?.iri === 'string');

  for (const generatedKind of ['role', 'codeMember', 'logicalIdentity']) {
    await t.test(`direct explicit export of ${generatedKind} is rejected`, (subtest) => {
      const root = copyCorpus(subtest);
      mutatePostTradeAndReseal(root, (module) => {
        if (generatedKind === 'role') {
          const association = firstAssociation(module);
          module.module.exports = [
            `${association.iri}/role/${association.participantRoles[0].id}`,
          ];
        } else if (generatedKind === 'codeMember') {
          module.module.exports = [firstCodeList(module).values[0].iri];
        } else {
          module.module.exports = [`${firstConcreteType(module).iri}/LogicalIdentity`];
        }
      });
      resealCanonicalDag(root, { expectValid: false });
      const result = validateModuleImportDag(root);
      assert.equal(result.ok, false);
      assert.ok(result.failedAssertions.includes('exact-version-imports'));
      assert.ok(result.findings.some((row) => row.code === 'MODULE_EXPORT_NOT_OWNED'));
      assert.ok(result.findings.some((row) => row.code === 'PUBLIC_SYMBOL_ORPHAN_EXPLICIT_EXPORT'));
    });
  }

  for (const generatedKind of ['role', 'codeMember', 'logicalIdentity']) {
    await t.test(`Selective import sees ${generatedKind} generated by an exported container`, (subtest) => {
      const root = copyCorpus(subtest);
      const foundationPath = path.join(
        root, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
      );
      const foundation = yaml.load(fs.readFileSync(foundationPath, 'utf8'));
      let generatedIri;
      if (generatedKind === 'role') {
        const association = firstAssociation(foundation);
        foundation.module.exports = [association.iri];
        generatedIri = `${association.iri}/role/${association.participantRoles[0].id}`;
      } else if (generatedKind === 'codeMember') {
        const codeList = firstCodeList(foundation);
        foundation.module.exports = [codeList.iri];
        generatedIri = codeList.values[0].iri;
      } else {
        const concrete = firstConcreteType(foundation);
        foundation.module.exports = [];
        generatedIri = `${concrete.iri}/LogicalIdentity`;
      }
      fs.writeFileSync(
        foundationPath,
        yaml.dump(foundation, { lineWidth: 120, noRefs: true }),
        'utf8',
      );
      const postTradePath = path.join(
        root, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.yaml',
      );
      const postTrade = yaml.load(fs.readFileSync(postTradePath, 'utf8'));
      const imported = postTrade.module.imports.find((row) => row.moduleIri.endsWith('/foundation'));
      imported.importMode = 'Selective';
      imported.importedSymbols = [{ symbolIri: generatedIri }];
      fs.writeFileSync(
        postTradePath,
        yaml.dump(postTrade, { lineWidth: 120, noRefs: true }),
        'utf8',
      );
      resealCanonicalDag(root);
      const result = validateModuleImportDag(root);
      assert.equal(result.ok, true, JSON.stringify(result.findings));
    });
  }
});

test('a nested duplicate registry is independently discovered and blocks candidate eligibility', (t) => {
  const root = copyCorpus(t);
  const canonical = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  const nested = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'nested', 'module-registry.yaml',
  );
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.copyFileSync(canonical, nested);

  const discovery = expectedDiscoveryTuple(root);
  const subjects = discoverSubjects(root);
  const inventory = {
    schemaVersion: '1.0', gateId: GATE_ID,
    discoveryContractRef: discovery.ref,
    discoveryContractDigest: discovery.digest,
    subjects,
  };
  const result = evaluateModuleImportDagRequiredGate({
    schemaVersion: '1.0', profileRef: PROFILE_REF,
    operation: 'replayRequiredGate', capabilityId: `gate.${GATE_ID}`, gateId: GATE_ID,
    subjectInventory: inventory,
    subjectInventoryDigest: taggedDigest(INVENTORY_TAG, inventory),
    dependencyReports: [], vectorCategory: null, fault: null,
  }, { root });
  assert.equal(result.value.outcome, 'failed');
  assert.equal(result.value.releaseEligibilityEvidence, false);
  assert.ok(result.value.kindEvidence.findings.some((row) => (
    ['MODULE_IMPORT_DAG_CORPUS_INVENTORY', 'REGISTRY_EXTRA'].includes(row.code)
  )));
});

test('candidate validation consumes the same immutable bytes as its bound inventory under a TOCTOU switch', (t) => {
  const root = copyCorpus(t);
  const discovery = expectedDiscoveryTuple(root);
  const modulePath = path.join(
    root, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.yaml',
  );
  const registryPath = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  const validModule = fs.readFileSync(modulePath);
  const validRegistry = fs.readFileSync(registryPath);
  fs.writeFileSync(modulePath, Buffer.from('module: [controlled-invalid-yaml\n', 'utf8'));
  const subjects = discoverSubjects(root);
  const boundModule = subjects.find((row) => row.subjectRef.path.endsWith(
    '/post-trade-operations/module.yaml',
  ));
  assert.notEqual(boundModule.subjectDigest, sha256(validModule));
  const inventory = {
    schemaVersion: '1.0', gateId: GATE_ID,
    discoveryContractRef: discovery.ref,
    discoveryContractDigest: discovery.digest,
    subjects,
  };
  const request = {
    schemaVersion: '1.0', profileRef: PROFILE_REF,
    operation: 'replayRequiredGate', capabilityId: `gate.${GATE_ID}`, gateId: GATE_ID,
    subjectInventory: inventory,
    subjectInventoryDigest: taggedDigest(INVENTORY_TAG, inventory),
    dependencyReports: [], vectorCategory: null, fault: null,
  };

  const discoveryAbsolute = path.join(root, ...discovery.ref.path.split('/'));
  const originalOpen = fs.openSync;
  let switched = false;
  fs.openSync = function switchedOpen(file, ...args) {
    if (!switched && path.resolve(String(file)) === path.resolve(discoveryAbsolute)) {
      switched = true;
      fs.writeFileSync(modulePath, validModule);
      fs.writeFileSync(registryPath, validRegistry);
    }
    return originalOpen.call(this, file, ...args);
  };
  let result;
  try {
    result = evaluateModuleImportDagRequiredGate(request, { root });
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(switched, true);
  assert.equal(result.value.outcome, 'failed');
  assert.equal(result.value.releaseEligibilityEvidence, false);
  assert.ok(result.value.kindEvidence.findings.some((row) => (
    ['MODULE_YAML_INVALID', 'REGISTRY_MODULE_MISMATCH'].includes(row.code)
  )));
});
