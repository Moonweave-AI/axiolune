'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  PROFILE_REF,
  compareUtf8,
} = require('./m2-release-capability-definitions.cjs');
const {
  ASSERTIONS,
  CORPUS_PATHS,
  REGISTRY_PATH,
  captureRegularFile,
  decodeUtf8Strict,
  readRegularFile,
  sameFileCapture,
  sha256,
  validateModuleImportDag,
} = require('./module-import-dag-validator.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const GATE_ID = 'module-import-dag';
const ADAPTER_VERSION = '1.0.0';
const RUNTIME_POLICY = 'offline-isolated-p1-module-import-dag-validator-v1';
const SEMANTIC_EVIDENCE_USE = 'required-gate-release-eligibility-evidence';
const VECTOR_EVIDENCE_USE = 'required-gate-semantic-test-vector-only';
const SUBJECT_TAG = 'axiolune-required-gate-subject-v1\0';
const INVENTORY_TAG = 'axiolune-gate-subject-inventory-v1\0';
const VECTOR_SUBJECT_TAG = 'axiolune-module-import-dag-required-gate-vector-subject-v1\0';
const INPUT_TAG = 'axiolune-module-import-dag-required-gate-input-v1\0';
const RESULT_TAG = 'axiolune-module-import-dag-required-gate-result-v1\0';
const SEMANTIC_TAG = 'axiolune-module-import-dag-required-gate-evidence-v1\0';
const TEMP_DIRECTORY = '.semantic-tmp';
const TEMP_PREFIX = 'module-dag-corpus-';
const MAX_FINDINGS = 5000;

const VECTOR_CODES = Object.freeze({
  emptySubject: 'MODULE_IMPORT_DAG_VECTOR_EMPTY_SUBJECT',
  engineFailure: 'MODULE_IMPORT_DAG_VECTOR_ENGINE_FAILURE',
  tamper: 'MODULE_IMPORT_DAG_VECTOR_SUBJECT_DIGEST',
  tamperNotDemonstrated: 'MODULE_IMPORT_DAG_VECTOR_TAMPER_NOT_DEMONSTRATED',
  vectorCategoryInvalid: 'MODULE_IMPORT_DAG_VECTOR_CATEGORY_INVALID',
  violation: 'MODULE_IMPORT_DAG_SEMANTIC_VIOLATION',
});

const DISCOVERY_RULES = Object.freeze([
  Object.freeze({
    classifier: 'financeModule',
    pathPrefix: 'ontology/domain/finance/',
    pathSuffix: '/module.yaml',
  }),
  Object.freeze({
    classifier: 'moduleRegistry',
    pathPrefix: 'ontology/domain/finance/registry/',
    pathSuffix: 'module-registry.yaml',
  }),
].sort((left, right) => compareUtf8(canonicalJcs(left), canonicalJcs(right))));

function taggedDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort(compareUtf8))
      === canonicalJcs([...expected].sort(compareUtf8));
}

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function discoveryRules(gateId = GATE_ID) {
  if (gateId !== GATE_ID) throw new Error(`unsupported module DAG gate ${String(gateId)}`);
  return DISCOVERY_RULES.map((rule) => ({ ...rule }));
}

function discoverPaths(root) {
  const resolvedRoot = path.resolve(root);
  const financeRoot = path.join(resolvedRoot, 'ontology', 'domain', 'finance');
  const result = [];
  const visit = (absolute, relativePath) => {
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`module DAG discovery refuses symlink ${relativePath}`);
    if (stat.isFile()) {
      const matches = DISCOVERY_RULES.filter((rule) => (
        relativePath.startsWith(rule.pathPrefix) && relativePath.endsWith(rule.pathSuffix)
      ));
      if (matches.length > 1) throw new Error(`ambiguous module DAG discovery for ${relativePath}`);
      if (matches.length === 1) result.push({ relativePath, classifier: matches[0].classifier });
      return;
    }
    if (!stat.isDirectory()) throw new Error(`module DAG discovery refuses ${relativePath}`);
    for (const name of fs.readdirSync(absolute).sort(compareUtf8)) {
      visit(path.join(absolute, name), `${relativePath}/${name}`);
    }
  };
  visit(financeRoot, 'ontology/domain/finance');
  return result.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
}

function discoverSnapshot(root) {
  const files = new Map();
  const captures = new Map();
  const discovered = discoverPaths(root);
  const subjects = discovered.map(({ relativePath, classifier }) => {
    const capture = captureRegularFile(root, relativePath);
    const { bytes } = capture;
    captures.set(relativePath, capture);
    files.set(relativePath, bytes);
    const subjectRef = sourceRef(relativePath);
    const subjectDigest = sha256(bytes);
    return {
      subjectId: taggedDigest(SUBJECT_TAG, {
        gateId: GATE_ID, subjectRef, subjectDigest, classifier,
      }),
      subjectRef,
      subjectDigest,
      classifier,
    };
  }).sort((left, right) => compareUtf8(left.subjectId, right.subjectId));
  const afterCapture = discoverPaths(root);
  if (canonicalJcs(afterCapture) !== canonicalJcs(discovered)) {
    throw new Error('module DAG discovery changed while its immutable byte snapshot was captured');
  }

  // A mutable filesystem cannot provide an atomic multi-file snapshot. Reopening every path and
  // checking fd identity/timestamps/size plus the captured content digest makes observed changes
  // fail closed. Release evidence should bind a fixed Git tree/CAS object when such an identity is
  // supplied by the caller; this source-tree adapter must not invent one for a mutable checkout.
  for (const { relativePath } of discovered) {
    let rechecked;
    try {
      rechecked = captureRegularFile(root, relativePath);
    } catch (cause) {
      const error = new Error(
        `module DAG source changed after capture: ${relativePath}`,
      );
      error.code = 'SOURCE_CHANGED_AFTER_CAPTURE';
      error.cause = cause;
      throw error;
    }
    if (!sameFileCapture(captures.get(relativePath), rechecked)) {
      const error = new Error(`module DAG source changed after capture: ${relativePath}`);
      error.code = 'SOURCE_CHANGED_AFTER_CAPTURE';
      throw error;
    }
  }
  const afterRecheck = discoverPaths(root);
  if (canonicalJcs(afterRecheck) !== canonicalJcs(discovered)) {
    throw new Error('module DAG discovery changed while its immutable byte snapshot was rechecked');
  }
  return { files, subjects };
}

function discoverSubjects(root) {
  return discoverSnapshot(root).subjects;
}

function expectedDiscoveryTuple(root) {
  const relativePath = [
    'scripts/domain/release-capability-profile/v0.3.0/gates',
    GATE_ID,
    'discovery-contract.json',
  ].join('/');
  const bytes = readRegularFile(root, relativePath);
  const value = JSON.parse(decodeUtf8Strict(bytes, relativePath));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))
      || !exactKeys(value, [
        'schemaVersion', 'profileRef', 'capabilityId', 'bindingKind', 'stageId', 'strategy',
      ])
      || value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF
      || value.capabilityId !== `gate.${GATE_ID}`
      || value.bindingKind !== 'requiredGate' || value.stageId !== null
      || !exactKeys(value.strategy, ['kind', 'rules'])
      || value.strategy.kind !== 'sourceTreePathSet-v1'
      || canonicalJcs(value.strategy.rules) !== canonicalJcs(discoveryRules())) {
    throw new Error(`${relativePath} differs from the exact production discovery contract`);
  }
  return { ref: sourceRef(relativePath), digest: sha256(bytes) };
}

function loadProductionCorpus(root) {
  return new Map(CORPUS_PATHS.map((relativePath) => [
    relativePath,
    readRegularFile(root, relativePath),
  ]));
}

function fileRows(files) {
  return [...files].sort((left, right) => compareUtf8(left[0], right[0]))
    .map(([relativePath, bytes]) => ({
      path: relativePath,
      byteLength: bytes.length,
      digest: sha256(bytes),
      contentBase64: bytes.toString('base64'),
    }));
}

function decodeFileRows(rows, label) {
  if (!Array.isArray(rows) || rows.length !== CORPUS_PATHS.length) {
    throw new Error(`${label} does not contain the exact ${CORPUS_PATHS.length}-file module DAG corpus`);
  }
  const result = new Map();
  let previous = null;
  for (const [index, row] of rows.entries()) {
    if (!exactKeys(row, ['path', 'byteLength', 'digest', 'contentBase64'])
        || typeof row.path !== 'string' || !CORPUS_PATHS.includes(row.path)
        || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0
        || !/^sha256:[0-9a-f]{64}$/u.test(row.digest || '')
        || typeof row.contentBase64 !== 'string') {
      throw new Error(`${label}/${index} is not a closed module DAG file row`);
    }
    if (previous !== null && compareUtf8(previous, row.path) >= 0) {
      throw new Error(`${label} rows are not strictly byte-sorted and unique`);
    }
    previous = row.path;
    const bytes = Buffer.from(row.contentBase64, 'base64');
    if (bytes.toString('base64') !== row.contentBase64
        || bytes.length !== row.byteLength || sha256(bytes) !== row.digest) {
      throw new Error(`${label}/${row.path} byte length/digest/base64 binding differs`);
    }
    result.set(row.path, bytes);
  }
  if (canonicalJcs([...result.keys()]) !== canonicalJcs(CORPUS_PATHS)) {
    throw new Error(`${label} inventory differs from the exact reviewed module DAG corpus`);
  }
  return result;
}

function applyMutation(gateId, baseline) {
  if (gateId !== GATE_ID) throw new Error(`unsupported module DAG mutation ${String(gateId)}`);
  const modules = [];
  const inbound = new Map();
  for (const relativePath of CORPUS_PATHS.filter((value) => value !== REGISTRY_PATH)) {
    const bytes = baseline.get(relativePath);
    if (!Buffer.isBuffer(bytes)) throw new Error(`module DAG mutation corpus lacks ${relativePath}`);
    const doc = yaml.load(decodeUtf8Strict(bytes, relativePath));
    const header = doc?.module;
    if (!header || typeof header.moduleIri !== 'string' || !Array.isArray(header.imports)) {
      throw new Error(`module DAG mutation baseline header is invalid: ${relativePath}`);
    }
    modules.push({ relativePath, bytes, doc, header });
    inbound.set(header.moduleIri, inbound.get(header.moduleIri) || 0);
  }
  for (const module of modules) {
    for (const imported of module.header.imports) {
      inbound.set(imported.moduleIri, (inbound.get(imported.moduleIri) || 0) + 1);
    }
  }
  const target = modules.filter((module) => (
    module.header.imports.length > 0 && (inbound.get(module.header.moduleIri) || 0) === 0
  )).sort((left, right) => compareUtf8(left.relativePath, right.relativePath))[0];
  if (!target) throw new Error('module DAG mutation has no imported leaf module target');
  const imported = target.header.imports[0];
  const sourceVersion = imported.version;
  const resultVersion = '9.9.9';
  if (typeof sourceVersion !== 'string' || sourceVersion === resultVersion) {
    throw new Error('module DAG mutation source version is invalid');
  }
  const oldDigest = sha256(target.bytes);
  imported.version = resultVersion;
  const resultBytes = Buffer.from(yaml.dump(target.doc, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  }), 'utf8');

  const registrySource = baseline.get(REGISTRY_PATH);
  if (!Buffer.isBuffer(registrySource)) throw new Error('module DAG mutation corpus lacks registry');
  const registryDoc = yaml.load(decodeUtf8Strict(registrySource, REGISTRY_PATH));
  const registryRows = registryDoc?.modules?.filter(
    (row) => row?.moduleIri === target.header.moduleIri,
  );
  if (!Array.isArray(registryRows) || registryRows.length !== 1
      || registryRows[0].artifactDigest !== oldDigest) {
    throw new Error('module DAG mutation registry target is not byte-bound to its module');
  }
  const newDigest = sha256(resultBytes);
  registryRows[0].artifactDigest = newDigest;
  const registryResult = Buffer.from(yaml.dump(registryDoc, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  }), 'utf8');
  const files = new Map([...baseline].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  files.set(target.relativePath, resultBytes);
  files.set(REGISTRY_PATH, registryResult);
  return {
    files,
    descriptor: {
      kind: 'resealed-import-version-mismatch-v1',
      targetPath: target.relativePath,
      registryPath: REGISTRY_PATH,
      importedModuleIri: imported.moduleIri,
      sourceVersion,
      resultVersion,
      targetSourceDigest: oldDigest,
      targetResultDigest: newDigest,
      registrySourceDigest: sha256(registrySource),
      registryResultDigest: sha256(registryResult),
    },
  };
}

function sameFileMaps(left, right) {
  if (left.size !== right.size) return false;
  for (const [name, bytes] of left) {
    if (!Buffer.isBuffer(right.get(name)) || !bytes.equals(right.get(name))) return false;
  }
  return true;
}

function validateVectorSubject(subject, category) {
  if (!exactKeys(subject, [
    'schemaVersion', 'gateId', 'baselineFiles', 'candidateFiles', 'mutation',
  ]) || subject.schemaVersion !== '1.0' || subject.gateId !== GATE_ID) {
    throw new Error('semantic vector subject is not the closed module DAG corpus contract');
  }
  const baseline = decodeFileRows(subject.baselineFiles, 'baselineFiles');
  const candidate = decodeFileRows(subject.candidateFiles, 'candidateFiles');
  if (category === 'violation') {
    const applied = applyMutation(GATE_ID, baseline);
    if (!exactKeys(subject.mutation, [
      'kind', 'targetPath', 'registryPath', 'importedModuleIri', 'sourceVersion',
      'resultVersion', 'targetSourceDigest', 'targetResultDigest',
      'registrySourceDigest', 'registryResultDigest',
    ]) || canonicalJcs(subject.mutation) !== canonicalJcs(applied.descriptor)
        || !sameFileMaps(candidate, applied.files)) {
      throw new Error('violation corpus is not the exact resealed import-version mutation');
    }
  } else if (subject.mutation !== null || !sameFileMaps(candidate, baseline)) {
    throw new Error(`${category} vector must carry an unmodified candidate corpus`);
  }
  return { baseline, candidate };
}

function materializeCorpus(root, files) {
  const resolvedRoot = path.resolve(root);
  const base = path.join(resolvedRoot, TEMP_DIRECTORY);
  let createdBase = false;
  let realBase;
  let directory;
  try {
    if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { recursive: false });
      createdBase = true;
    }
    const baseStat = fs.lstatSync(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
      throw new Error(`${TEMP_DIRECTORY} must be a real directory below the source root`);
    }
    const realRoot = fs.realpathSync(resolvedRoot);
    realBase = fs.realpathSync(base);
    const baseRelative = path.relative(realRoot, realBase);
    if (baseRelative !== TEMP_DIRECTORY || path.isAbsolute(baseRelative)) {
      throw new Error(`${TEMP_DIRECTORY} resolves outside the source root`);
    }
    directory = fs.mkdtempSync(path.join(realBase, TEMP_PREFIX));
    for (const [relativePath, bytes] of files) {
      if (typeof relativePath !== 'string' || relativePath.length === 0
          || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
          || path.posix.normalize(relativePath) !== relativePath
          || !Buffer.isBuffer(bytes)) {
        throw new Error(`refusing unsafe module DAG corpus path ${String(relativePath)}`);
      }
      const absolute = path.resolve(directory, ...relativePath.split('/'));
      const targetRelative = path.relative(path.resolve(directory), absolute);
      if (targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`)
          || path.isAbsolute(targetRelative)) {
        throw new Error(`module DAG corpus path escapes materialization root: ${relativePath}`);
      }
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, bytes, { flag: 'wx' });
    }
  } catch (cause) {
    if (directory && realBase
        && path.dirname(path.resolve(directory)) === path.resolve(realBase)
        && path.basename(directory).startsWith(TEMP_PREFIX)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    if (createdBase && fs.existsSync(base)) fs.rmdirSync(base);
    throw cause;
  }
  return { base: realBase, createdBase, directory };
}

function removeMaterializedCorpus(materialized) {
  const resolvedDirectory = path.resolve(materialized.directory);
  if (path.dirname(resolvedDirectory) !== path.resolve(materialized.base)
      || !path.basename(resolvedDirectory).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove unexpected module DAG corpus ${resolvedDirectory}`);
  }
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  if (materialized.createdBase) fs.rmdirSync(materialized.base);
}

function validateCorpus(root, files) {
  const materialized = materializeCorpus(root, files);
  try {
    return validateModuleImportDag(materialized.directory);
  } finally {
    removeMaterializedCorpus(materialized);
  }
}

function validateCapturedCorpus(root, files) {
  if (!(files instanceof Map)) throw new Error('captured module DAG corpus must be a Map');
  return validateCorpus(root, new Map(
    [...files].map(([relativePath, bytes]) => [relativePath, Buffer.from(bytes)]),
  ));
}

function makeFinding(code, at, message) {
  return { code, path: String(at || ''), message: String(message || '') };
}

function normalizedValidation(validation) {
  const findings = validation.findings.map((row) => ({
    code: String(row.code).replace(/[^A-Z0-9_]/gu, '_').toUpperCase(),
    path: String(row.path || ''),
    message: String(row.message || ''),
  })).sort((left, right) => compareUtf8(
    `${left.code}\0${left.path}\0${left.message}`,
    `${right.code}\0${right.path}\0${right.message}`,
  ));
  return {
    ...validation,
    findings: findings.length <= MAX_FINDINGS ? findings : [
      ...findings.slice(0, MAX_FINDINGS - 1),
      makeFinding('FINDINGS_TRUNCATED', '', `${findings.length - (MAX_FINDINGS - 1)} findings omitted`),
    ],
  };
}

function failedValidation(code, message, checkedArtifactCount = 0) {
  return normalizedValidation({
    ok: false,
    findings: [makeFinding(code, GATE_ID, message)],
    checkedArtifactCount,
    passedAssertions: [],
    failedAssertions: [...ASSERTIONS],
  });
}

function kindEvidence(request, validation, subjectCount) {
  const normalized = normalizedValidation(validation);
  const checkedAssertions = [...ASSERTIONS];
  return {
    adapterVersion: ADAPTER_VERSION,
    gateKind: GATE_ID,
    runtimePolicy: RUNTIME_POLICY,
    checkedAssertions,
    passedAssertions: normalized.passedAssertions,
    failedAssertions: normalized.failedAssertions,
    subjectCount,
    checkedArtifactCount: normalized.checkedArtifactCount,
    findingCount: normalized.findings.length,
    findings: normalized.findings,
    inputDigest: taggedDigest(INPUT_TAG, {
      gateId: GATE_ID,
      vectorCategory: request.vectorCategory,
      subjectDigest: request.subjectDigest || null,
      subjectInventoryDigest: request.subjectInventoryDigest || null,
      dependencyReports: request.dependencyReports || [],
    }),
    resultDigest: taggedDigest(RESULT_TAG, {
      checkedAssertions,
      passedAssertions: normalized.passedAssertions,
      failedAssertions: normalized.failedAssertions,
      findings: normalized.findings,
    }),
  };
}

function output(request, identity, validation, subjectCount) {
  const vector = request.vectorCategory !== null;
  const evidence = kindEvidence(request, validation, subjectCount);
  return {
    value: {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: request.capabilityId,
      gateId: GATE_ID,
      status: identity.status,
      outcome: identity.outcome,
      code: identity.code,
      evidenceUse: vector ? VECTOR_EVIDENCE_USE : SEMANTIC_EVIDENCE_USE,
      releaseEligibilityEvidence: !vector && identity.outcome === 'passed',
      callerEvidenceAccepted: false,
      subjectInventoryDigest: vector ? null : request.subjectInventoryDigest,
      dependencyReportDigests: vector ? [] : request.dependencyReports
        .map((row) => row.reportDigest).sort(compareUtf8),
      semanticDigest: taggedDigest(SEMANTIC_TAG, evidence),
      kindEvidence: evidence,
    },
    exitStatus: identity.exitStatus,
  };
}

function evaluateVector(request, root) {
  const category = request.vectorCategory;
  if (!['positive', 'violation', 'tamper', 'emptySubject', 'engineFailure'].includes(category)) {
    const code = VECTOR_CODES.vectorCategoryInvalid;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedValidation(code, `unsupported semantic vector category ${String(category)}`), 0);
  }
  if (category === 'emptySubject' || request.subject === null) {
    const code = VECTOR_CODES.emptySubject;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedValidation(code, 'semantic vector subject is empty'), 0);
  }
  if (request.subjectDigest !== taggedDigest(VECTOR_SUBJECT_TAG, request.subject)) {
    const code = VECTOR_CODES.tamper;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedValidation(code, 'semantic vector subject digest differs'), 0);
  }
  if (category === 'tamper') {
    const code = VECTOR_CODES.tamperNotDemonstrated;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedValidation(code, 'tamper category supplied a correctly bound subject'), 0);
  }
  if (category === 'engineFailure' || request.fault !== null) {
    const code = VECTOR_CODES.engineFailure;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedValidation(code, 'controlled engine-failure path executed'), 0);
  }
  let corpora;
  try {
    corpora = validateVectorSubject(request.subject, category);
  } catch (cause) {
    const code = 'MODULE_IMPORT_DAG_VECTOR_CORPUS_BINDING';
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedValidation(code, cause.message), 0);
  }
  const baseline = validateCorpus(root, corpora.baseline);
  if (!baseline.ok) {
    const code = 'MODULE_IMPORT_DAG_VECTOR_BASELINE_INVALID';
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, baseline, corpora.baseline.size);
  }
  const candidate = validateCorpus(root, corpora.candidate);
  if (category === 'positive') {
    return output(request, {
      status: 'completed',
      outcome: candidate.ok ? 'accepted' : 'violation',
      code: candidate.ok ? null : 'MODULE_IMPORT_DAG_VECTOR_POSITIVE_REJECTED',
      exitStatus: 0,
    }, candidate, corpora.candidate.size);
  }
  return output(request, {
    status: 'completed',
    outcome: candidate.ok ? 'accepted' : 'violation',
    code: candidate.ok ? null : VECTOR_CODES.violation,
    exitStatus: 0,
  }, candidate, corpora.candidate.size);
}

function evaluateCandidate(request, root) {
  const snapshot = discoverSnapshot(root);
  const discovered = snapshot.subjects;
  const discoveredPaths = discovered.map((row) => row.subjectRef.path).sort(compareUtf8);
  const corpusInventoryMatches = canonicalJcs(discoveredPaths) === canonicalJcs(CORPUS_PATHS);
  let discovery;
  try {
    discovery = expectedDiscoveryTuple(root);
  } catch (cause) {
    discovery = { ref: null, digest: null, error: cause.message };
  }
  const authored = request.subjectInventory?.subjects;
  const inventoryMatches = exactKeys(request.subjectInventory, [
    'schemaVersion', 'gateId', 'discoveryContractRef',
    'discoveryContractDigest', 'subjects',
  ])
    && request.subjectInventory.schemaVersion === '1.0'
    && request.subjectInventory.gateId === GATE_ID
    && canonicalJcs(request.subjectInventory.discoveryContractRef) === canonicalJcs(discovery.ref)
    && request.subjectInventory.discoveryContractDigest === discovery.digest
    && Array.isArray(authored)
    && canonicalJcs(authored) === canonicalJcs(discovered)
    && !discovery.error;
  const digestMatches = request.subjectInventoryDigest
    === taggedDigest(INVENTORY_TAG, request.subjectInventory);
  const dependenciesValid = Array.isArray(request.dependencyReports)
    && request.dependencyReports.length === 0;
  let validation = normalizedValidation(validateCorpus(root, snapshot.files));
  const extra = [];
  if (!inventoryMatches) {
    extra.push(makeFinding(
      'MODULE_IMPORT_DAG_SUBJECT_INVENTORY_MISMATCH',
      GATE_ID,
      'caller inventory differs from independent P1 filesystem discovery',
    ));
    if (discovery.error) extra.push(makeFinding(
      'MODULE_IMPORT_DAG_DISCOVERY_CONTRACT', GATE_ID, discovery.error,
    ));
  }
  if (!corpusInventoryMatches) extra.push(makeFinding(
    'MODULE_IMPORT_DAG_CORPUS_INVENTORY', GATE_ID,
    'independent discovery differs from the exact ten-module plus one-registry corpus',
  ));
  if (!digestMatches) extra.push(makeFinding(
    'MODULE_IMPORT_DAG_SUBJECT_INVENTORY_DIGEST', GATE_ID,
    'subject inventory tagged digest differs',
  ));
  if (!dependenciesValid) extra.push(makeFinding(
    'MODULE_IMPORT_DAG_DEPENDENCY_SET', GATE_ID,
    'module-import-dag requires the exact empty dependency report set',
  ));
  if (extra.length > 0) {
    validation = normalizedValidation({
      ...validation,
      ok: false,
      findings: [...validation.findings, ...extra],
      passedAssertions: [],
      failedAssertions: [...ASSERTIONS],
    });
  }
  const passed = validation.ok && inventoryMatches && corpusInventoryMatches
    && digestMatches && dependenciesValid;
  return output(request, {
    status: 'completed',
    outcome: passed ? 'passed' : 'failed',
    code: passed ? null : 'MODULE_IMPORT_DAG_REQUIRED_GATE_FAILED',
    exitStatus: 0,
  }, validation, discovered.length);
}

function evaluateModuleImportDagRequiredGate(request, options = {}) {
  if (request?.gateId !== GATE_ID
      || request.capabilityId !== `gate.${GATE_ID}`
      || request.profileRef !== PROFILE_REF) {
    throw new Error('request does not select the production module-import-dag gate');
  }
  const root = path.resolve(options.root || process.cwd());
  return request.vectorCategory === null
    ? evaluateCandidate(request, root)
    : evaluateVector(request, root);
}

module.exports = {
  ADAPTER_VERSION,
  ASSERTIONS,
  CORPUS_PATHS,
  DISCOVERY_RULES,
  GATE_ID,
  INVENTORY_TAG,
  RUNTIME_POLICY,
  VECTOR_CODES,
  VECTOR_SUBJECT_TAG,
  applyMutation,
  discoverSnapshot,
  discoverSubjects,
  discoveryRules,
  evaluateModuleImportDagRequiredGate,
  expectedDiscoveryTuple,
  fileRows,
  loadProductionCorpus,
  taggedDigest,
  validateCapturedCorpus,
  validateVectorSubject,
};
