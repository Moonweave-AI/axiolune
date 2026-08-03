'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { validateMetaStructure } = require('../../meta/validate-structure.js');
const {
  runStructureNegativeCorpus,
} = require('../../meta/lib/structure-negative-corpus.js');
const { verifyMetaModel } = require('../../meta/verify-meta-model.js');
const {
  PROFILE_REF,
  compareUtf8,
} = require('./m2-release-capability-definitions.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const ADAPTER_VERSION = '1.1.0';
const RUNTIME_POLICY = 'offline-isolated-p1-m3-validator-v2';
const SEMANTIC_EVIDENCE_USE = 'required-gate-release-eligibility-evidence';
const VECTOR_EVIDENCE_USE = 'required-gate-semantic-test-vector-only';
const SUBJECT_TAG = 'axiolune-required-gate-subject-v1\0';
const INVENTORY_TAG = 'axiolune-gate-subject-inventory-v1\0';
const VECTOR_SUBJECT_TAG = 'axiolune-m3-required-gate-vector-subject-v1\0';
const INPUT_TAG = 'axiolune-m3-required-gate-input-v1\0';
const RESULT_TAG = 'axiolune-m3-required-gate-result-v1\0';
const SEMANTIC_TAG = 'axiolune-m3-required-gate-evidence-v1\0';
const MAX_FINDINGS = 5000;
const TEMP_DIRECTORY = '.semantic-tmp';
const TEMP_PREFIX = 'm3-corpus-';

const GATE_IDS = Object.freeze(['m3-import-digest', 'm3-schema']);
const META_FILES = Object.freeze([
  'behavior-meta-model.yaml',
  'core-meta-model.yaml',
  'cross-domain-patterns.yaml',
  'data-binding-meta-model.yaml',
]);
const FILES_BY_GATE = Object.freeze({
  'm3-schema': META_FILES,
  'm3-import-digest': Object.freeze([...META_FILES, 'digests.json'].sort(compareUtf8)),
});
const ASSERTIONS_BY_GATE = Object.freeze({
  'm3-schema': Object.freeze([
    'closed-meta-schema', 'negative-schema-corpus', 'strict-structure',
  ]),
  'm3-import-digest': Object.freeze([
    'content-addressed-imports', 'digest-closure', 'version-closure',
  ]),
});
const DISCOVERY_RULES_BY_GATE = Object.freeze({
  'm3-schema': Object.freeze([
    Object.freeze({
      classifier: 'metaModel', pathPrefix: 'ontology/meta/', pathSuffix: '.yaml',
    }),
  ]),
  'm3-import-digest': Object.freeze([
    Object.freeze({
      classifier: 'metaDigestManifest',
      pathPrefix: 'ontology/meta/',
      pathSuffix: 'digests.json',
    }),
    Object.freeze({
      classifier: 'metaModel', pathPrefix: 'ontology/meta/', pathSuffix: '.yaml',
    }),
  ].sort((left, right) => compareUtf8(canonicalJcs(left), canonicalJcs(right)))),
});

const VECTOR_CODES = Object.freeze({
  emptySubject: 'M3_GATE_VECTOR_EMPTY_SUBJECT',
  engineFailure: 'M3_GATE_VECTOR_ENGINE_FAILURE',
  tamper: 'M3_GATE_VECTOR_SUBJECT_DIGEST',
  tamperNotDemonstrated: 'M3_GATE_VECTOR_TAMPER_NOT_DEMONSTRATED',
  vectorCategoryInvalid: 'M3_GATE_VECTOR_CATEGORY_INVALID',
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

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

function subjectId(gateId, relativePath, digest, classifier) {
  return taggedDigest(SUBJECT_TAG, {
    gateId,
    subjectRef: sourceRef(relativePath),
    subjectDigest: digest,
    classifier,
  });
}

function discoveryRules(gateId) {
  const rules = DISCOVERY_RULES_BY_GATE[gateId];
  if (!rules) throw new Error(`unsupported M3 required gate ${String(gateId)}`);
  return rules.map((rule) => ({ ...rule }));
}

function readRegularSourceFile(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const absolute = path.join(resolvedRoot, ...relativePath.split('/'));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular non-symlink file`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realFile = fs.realpathSync(absolute);
  const relative = path.relative(realRoot, realFile);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${relativePath} resolves outside the source root`);
  }
  return fs.readFileSync(realFile);
}

function discoverPaths(root, gateId) {
  const resolvedRoot = path.resolve(root);
  const metaRoot = path.join(resolvedRoot, 'ontology', 'meta');
  const rules = discoveryRules(gateId);
  const result = [];
  const visit = (absolute, relativePath) => {
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`M3 discovery refuses symlink ${relativePath}`);
    }
    if (stat.isFile()) {
      const matches = rules.filter((rule) => (
        relativePath.startsWith(rule.pathPrefix) && relativePath.endsWith(rule.pathSuffix)
      ));
      if (matches.length > 1) {
        throw new Error(`ambiguous M3 discovery for ${relativePath}`);
      }
      if (matches.length === 1) {
        result.push({ relativePath, classifier: matches[0].classifier });
      }
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`M3 discovery refuses non-file ${relativePath}`);
    }
    for (const name of fs.readdirSync(absolute).sort(compareUtf8)) {
      visit(path.join(absolute, name), `${relativePath}/${name}`);
    }
  };
  visit(metaRoot, 'ontology/meta');
  return result.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
}

function discoverSnapshot(root, gateId) {
  const files = new Map();
  const subjects = discoverPaths(root, gateId).map(({ relativePath, classifier }) => {
    const bytes = readRegularSourceFile(root, relativePath);
    const metaRelativePath = relativePath.slice('ontology/meta/'.length);
    files.set(metaRelativePath, Buffer.from(bytes));
    const digest = sha256(bytes);
    return {
      subjectId: subjectId(gateId, relativePath, digest, classifier),
      subjectRef: sourceRef(relativePath),
      subjectDigest: digest,
      classifier,
    };
  }).sort((left, right) => compareUtf8(left.subjectId, right.subjectId));
  return { files, subjects };
}

function discoverSubjects(root, gateId) {
  return discoverSnapshot(root, gateId).subjects;
}

function expectedDiscoveryTuple(root, gateId) {
  const relativePath = [
    'scripts/domain/release-capability-profile/v0.3.0/gates',
    gateId,
    'discovery-contract.json',
  ].join('/');
  const bytes = readRegularSourceFile(root, relativePath);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))
      || !exactKeys(value, [
        'schemaVersion', 'profileRef', 'capabilityId', 'bindingKind', 'stageId',
        'strategy',
      ])
      || value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF
      || value.capabilityId !== `gate.${gateId}`
      || value.bindingKind !== 'requiredGate' || value.stageId !== null
      || !exactKeys(value.strategy, ['kind', 'rules'])
      || value.strategy.kind !== 'sourceTreePathSet-v1'
      || canonicalJcs(value.strategy.rules) !== canonicalJcs(discoveryRules(gateId))) {
    throw new Error(`${relativePath} differs from the exact production discovery contract`);
  }
  return { ref: sourceRef(relativePath), digest: sha256(bytes) };
}

function makeFinding(code, at, message) {
  return {
    code: String(code).toUpperCase().replace(/[^A-Z0-9_]/gu, '_'),
    path: String(at || ''),
    message: String(message || ''),
  };
}

function normalizeFindings(findings) {
  const rows = findings.map((row) => makeFinding(row.code, row.path, row.message))
    .sort((left, right) => compareUtf8(
      `${left.code}\0${left.path}\0${left.message}`,
      `${right.code}\0${right.path}\0${right.message}`,
    ));
  if (rows.length <= MAX_FINDINGS) return rows;
  return [
    ...rows.slice(0, MAX_FINDINGS - 1),
    makeFinding(
      'FINDINGS_TRUNCATED',
      '',
      `${rows.length - (MAX_FINDINGS - 1)} deterministic findings omitted`,
    ),
  ];
}

function relativeStructureFinding(raw) {
  const text = String(raw);
  const separator = text.indexOf(': ');
  return makeFinding(
    'M3_STRUCTURE',
    separator >= 0 ? text.slice(0, separator) : '',
    separator >= 0 ? text.slice(separator + 2) : text,
  );
}

function validationResult(gateId, findings, passedAssertions, checkedArtifactCount) {
  const normalized = normalizeFindings(findings);
  const expected = ASSERTIONS_BY_GATE[gateId];
  const passed = [...new Set(passedAssertions)].sort(compareUtf8);
  const failed = expected.filter((assertion) => !passed.includes(assertion));
  return {
    ok: normalized.length === 0 && failed.length === 0,
    findings: normalized,
    checkedArtifactCount,
    passedAssertions: passed,
    failedAssertions: failed,
  };
}

function validateM3Schema(metaDir) {
  const structure = validateMetaStructure({ metaDir, strict: true });
  const corpus = runStructureNegativeCorpus({ metaDir });
  const findings = structure.errors.map(relativeStructureFinding);
  for (const row of corpus.results.filter((item) => !item.rejected)) {
    findings.push(makeFinding(
      'M3_NEGATIVE_CORPUS_ACCEPTED',
      row.name,
      row.firstError || 'controlled schema mutation was accepted',
    ));
  }
  if (!corpus.positive.ok) {
    findings.push(makeFinding(
      'M3_NEGATIVE_CORPUS_BASE_INVALID',
      'ontology/meta',
      corpus.positive.errors[0] || 'base schema corpus is invalid',
    ));
  }
  return validationResult('m3-schema', findings, [
    ...(structure.ok ? ['closed-meta-schema', 'strict-structure'] : []),
    ...(corpus.ok ? ['negative-schema-corpus'] : []),
  ], META_FILES.length + corpus.caseCount);
}

function validateM3ImportDigest(metaDir) {
  let verified;
  try {
    verified = verifyMetaModel({ metaDir, quiet: true });
  } catch (cause) {
    return validationResult('m3-import-digest', [
      makeFinding('M3_IMPORT_VALIDATOR_ERROR', 'ontology/meta', cause.message),
    ], [], FILES_BY_GATE['m3-import-digest'].length);
  }
  const findings = [];
  if (!verified.ok) {
    for (const [kind, issue] of Object.entries(verified.issues || {})) {
      const failedRows = (issue?.results || []).filter((row) => (
        String(row).startsWith('✗')
          || /mismatch|unlocked|invalid|fail/iu.test(String(row))
      ));
      for (const row of failedRows) {
        findings.push(makeFinding(`M3_${kind}`, 'ontology/meta', row));
      }
    }
    if (findings.length === 0) {
      findings.push(makeFinding(
        'M3_IMPORT_VALIDATION_FAILED',
        'ontology/meta',
        'meta-model verifier failed without a structured negative diagnostic',
      ));
    }
  }
  return validationResult(
    'm3-import-digest',
    findings,
    findings.length === 0 ? ASSERTIONS_BY_GATE['m3-import-digest'] : [],
    FILES_BY_GATE['m3-import-digest'].length,
  );
}

function runGateValidator(gateId, metaDir) {
  if (gateId === 'm3-schema') return validateM3Schema(metaDir);
  if (gateId === 'm3-import-digest') return validateM3ImportDigest(metaDir);
  throw new Error(`unsupported M3 required gate ${String(gateId)}`);
}

function decodeFileRows(rows, gateId, label) {
  const expected = FILES_BY_GATE[gateId];
  if (!Array.isArray(rows) || rows.length !== expected.length) {
    throw new Error(`${label} does not contain the exact ${expected.length}-file M3 corpus`);
  }
  const result = new Map();
  let previous = null;
  for (const [index, row] of rows.entries()) {
    if (!exactKeys(row, ['path', 'byteLength', 'digest', 'contentBase64'])
        || typeof row.path !== 'string' || !expected.includes(row.path)
        || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0
        || !/^sha256:[0-9a-f]{64}$/u.test(row.digest || '')
        || typeof row.contentBase64 !== 'string') {
      throw new Error(`${label}/${index} is not a closed M3 file row`);
    }
    if (previous !== null && compareUtf8(previous, row.path) >= 0) {
      throw new Error(`${label} file rows are not strictly byte-sorted and unique`);
    }
    previous = row.path;
    const bytes = Buffer.from(row.contentBase64, 'base64');
    if (bytes.toString('base64') !== row.contentBase64
        || bytes.length !== row.byteLength || sha256(bytes) !== row.digest) {
      throw new Error(`${label}/${row.path} byte length/digest/base64 binding differs`);
    }
    result.set(row.path, bytes);
  }
  if (canonicalJcs([...result.keys()]) !== canonicalJcs(expected)) {
    throw new Error(`${label} file inventory differs from the exact reviewed M3 corpus`);
  }
  return result;
}

function applyMutation(gateId, baseline) {
  if (!GATE_IDS.includes(gateId)) {
    throw new Error(`unsupported M3 required-gate mutation ${String(gateId)}`);
  }
  const result = new Map([...baseline].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const targetPath = 'core-meta-model.yaml';
  const original = result.get(targetPath);
  if (!Buffer.isBuffer(original)) throw new Error('M3 mutation target is absent');
  const document = yaml.load(original.toString('utf8'));
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('M3 mutation target is not a YAML mapping');
  }
  let mutated;
  let kind;
  if (gateId === 'm3-schema') {
    kind = 'rename-top-level-module-key-v1';
    if (!Object.prototype.hasOwnProperty.call(document, 'module')) {
      throw new Error('M3 schema mutation target property is absent');
    }
    const renamed = {};
    for (const [key, value] of Object.entries(document)) {
      renamed[key === 'module' ? 'moduleBroken' : key] = value;
    }
    mutated = Buffer.from(yaml.dump(renamed, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    }), 'utf8');
  } else {
    kind = 'modify-meta-description-without-digest-reseal-v1';
    if (typeof document.MetaModel?.description !== 'string') {
      throw new Error('M3 import-digest mutation target property is absent');
    }
    document.MetaModel.description = `${document.MetaModel.description} [controlled digest mutation]`;
    mutated = Buffer.from(yaml.dump(document, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    }), 'utf8');
  }
  result.set(targetPath, mutated);
  return {
    files: result,
    descriptor: {
      kind,
      targetPath,
      sourceDigest: sha256(original),
      resultDigest: sha256(mutated),
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

function validateVectorSubject(subject, gateId, category) {
  if (!exactKeys(subject, [
    'schemaVersion', 'gateId', 'baselineFiles', 'candidateFiles', 'mutation',
  ]) || subject.schemaVersion !== '1.0' || subject.gateId !== gateId) {
    throw new Error('semantic vector subject is not the closed M3 corpus contract');
  }
  const baseline = decodeFileRows(subject.baselineFiles, gateId, 'baselineFiles');
  const candidate = decodeFileRows(subject.candidateFiles, gateId, 'candidateFiles');
  if (category === 'violation') {
    const applied = applyMutation(gateId, baseline);
    if (!exactKeys(subject.mutation, [
      'kind', 'targetPath', 'sourceDigest', 'resultDigest',
    ]) || canonicalJcs(subject.mutation) !== canonicalJcs(applied.descriptor)
        || !sameFileMaps(candidate, applied.files)) {
      throw new Error('violation corpus is not the exact deterministic mutation of its baseline');
    }
  } else if (subject.mutation !== null || !sameFileMaps(candidate, baseline)) {
    throw new Error(`${category} vector must carry an unmodified candidate corpus`);
  }
  return { baseline, candidate };
}

function assertCorpusRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
      || path.posix.normalize(relativePath) !== relativePath
      || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`unsafe M3 corpus path ${String(relativePath)}`);
  }
}

function materializeCorpus(root, files) {
  if (!(files instanceof Map)) throw new Error('captured M3 corpus must be a Map');
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
      assertCorpusRelativePath(relativePath);
      if (!Buffer.isBuffer(bytes)) {
        throw new Error(`M3 corpus ${relativePath} is not captured bytes`);
      }
      const absolute = path.join(directory, ...relativePath.split('/'));
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
    throw new Error(`refusing to remove unexpected M3 corpus ${resolvedDirectory}`);
  }
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  if (materialized.createdBase) fs.rmdirSync(materialized.base);
}

function validateCorpus(root, gateId, files) {
  const materialized = materializeCorpus(root, files);
  try {
    return runGateValidator(gateId, materialized.directory);
  } finally {
    removeMaterializedCorpus(materialized);
  }
}

function validateCapturedCorpus(root, gateId, files) {
  if (!(files instanceof Map)) throw new Error('captured M3 corpus must be a Map');
  const snapshot = new Map();
  for (const [relativePath, bytes] of files) {
    if (!Buffer.isBuffer(bytes)) {
      throw new Error(`captured M3 corpus ${String(relativePath)} is not bytes`);
    }
    snapshot.set(relativePath, Buffer.from(bytes));
  }
  return validateCorpus(root, gateId, snapshot);
}

function captureValidatedProductionCorpus(root, gateId) {
  const snapshot = discoverSnapshot(root, gateId);
  const expected = FILES_BY_GATE[gateId];
  const actual = [...snapshot.files.keys()].sort(compareUtf8);
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(
      `production ${gateId} vector corpus inventory differs from the exact ${expected.length}-file set`,
    );
  }
  const validation = validateCapturedCorpus(root, gateId, snapshot.files);
  if (!validation.ok) {
    const codes = [...new Set(validation.findings.map((row) => row.code))]
      .sort(compareUtf8);
    throw new Error(
      `production ${gateId} vector baseline is invalid: ${codes.join(', ') || 'unknown finding'}`,
    );
  }
  return new Map(expected.map((relativePath) => [
    relativePath,
    Buffer.from(snapshot.files.get(relativePath)),
  ]));
}

function kindEvidence(request, validation, subjectCount) {
  const checkedAssertions = [...ASSERTIONS_BY_GATE[request.gateId]];
  const body = {
    adapterVersion: ADAPTER_VERSION,
    gateKind: request.gateId,
    runtimePolicy: RUNTIME_POLICY,
    checkedAssertions,
    passedAssertions: validation.passedAssertions,
    failedAssertions: validation.failedAssertions,
    subjectCount,
    checkedArtifactCount: validation.checkedArtifactCount,
    findingCount: validation.findings.length,
    findings: validation.findings,
    inputDigest: taggedDigest(INPUT_TAG, {
      gateId: request.gateId,
      vectorCategory: request.vectorCategory,
      subjectDigest: request.subjectDigest || null,
      subjectInventoryDigest: request.subjectInventoryDigest || null,
      dependencyReports: request.dependencyReports || [],
    }),
    resultDigest: taggedDigest(RESULT_TAG, {
      checkedAssertions,
      passedAssertions: validation.passedAssertions,
      failedAssertions: validation.failedAssertions,
      findings: validation.findings,
    }),
  };
  return body;
}

function output(request, identity, validation, subjectCount) {
  const isVector = request.vectorCategory !== null;
  const evidence = kindEvidence(request, validation, subjectCount);
  return {
    value: {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: request.capabilityId,
      gateId: request.gateId,
      status: identity.status,
      outcome: identity.outcome,
      code: identity.code,
      evidenceUse: isVector ? VECTOR_EVIDENCE_USE : SEMANTIC_EVIDENCE_USE,
      releaseEligibilityEvidence: !isVector && identity.outcome === 'passed',
      callerEvidenceAccepted: false,
      subjectInventoryDigest: isVector ? null : request.subjectInventoryDigest,
      dependencyReportDigests: isVector || !Array.isArray(request.dependencyReports)
        ? []
        : request.dependencyReports.map((row) => row.reportDigest).sort(compareUtf8),
      semanticDigest: taggedDigest(SEMANTIC_TAG, evidence),
      kindEvidence: evidence,
    },
    exitStatus: identity.exitStatus,
  };
}

function failedVectorValidation(gateId, code, message, checkedArtifactCount = 0) {
  return validationResult(
    gateId,
    [makeFinding(code, gateId, message)],
    [],
    checkedArtifactCount,
  );
}

function evaluateVector(request, root) {
  const category = request.vectorCategory;
  if (!['positive', 'violation', 'tamper', 'emptySubject', 'engineFailure'].includes(category)) {
    const code = VECTOR_CODES.vectorCategoryInvalid;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedVectorValidation(
      request.gateId,
      code,
      `unsupported semantic vector category ${String(category)}`,
    ), 0);
  }
  if (category === 'emptySubject' || request.subject === null) {
    const code = VECTOR_CODES.emptySubject;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedVectorValidation(request.gateId, code, 'semantic vector subject is empty'), 0);
  }
  const computedDigest = taggedDigest(VECTOR_SUBJECT_TAG, request.subject);
  if (request.subjectDigest !== computedDigest) {
    const code = VECTOR_CODES.tamper;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedVectorValidation(request.gateId, code, 'semantic vector subject digest differs'), 0);
  }
  if (category === 'tamper') {
    const code = VECTOR_CODES.tamperNotDemonstrated;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedVectorValidation(
      request.gateId,
      code,
      'tamper category supplied a correctly bound subject',
    ), 0);
  }
  if (category === 'engineFailure' || request.fault !== null) {
    const code = VECTOR_CODES.engineFailure;
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedVectorValidation(request.gateId, code, 'controlled engine-failure path executed'), 0);
  }
  let corpora;
  try {
    corpora = validateVectorSubject(request.subject, request.gateId, category);
  } catch (cause) {
    const code = 'M3_GATE_VECTOR_CORPUS_BINDING';
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, failedVectorValidation(request.gateId, code, cause.message), 0);
  }
  const baseline = validateCorpus(root, request.gateId, corpora.baseline);
  if (!baseline.ok) {
    const code = 'M3_GATE_VECTOR_BASELINE_INVALID';
    return output(request, {
      status: 'engineFailure', outcome: 'engineFailure', code, exitStatus: 2,
    }, baseline, corpora.baseline.size);
  }
  const candidate = validateCorpus(root, request.gateId, corpora.candidate);
  if (category === 'positive') {
    return output(request, {
      status: 'completed',
      outcome: candidate.ok ? 'accepted' : 'violation',
      code: candidate.ok ? null : 'M3_GATE_VECTOR_POSITIVE_REJECTED',
      exitStatus: 0,
    }, candidate, corpora.candidate.size);
  }
  const code = request.gateId === 'm3-schema'
    ? 'M3_SCHEMA_SEMANTIC_VIOLATION'
    : 'M3_IMPORT_DIGEST_SEMANTIC_VIOLATION';
  return output(request, {
    status: 'completed',
    outcome: candidate.ok ? 'accepted' : 'violation',
    code: candidate.ok ? null : code,
    exitStatus: 0,
  }, candidate, corpora.candidate.size);
}

function evaluateCandidate(request, root) {
  let snapshot;
  let discoveryFailure = null;
  try {
    snapshot = discoverSnapshot(root, request.gateId);
  } catch (cause) {
    snapshot = { files: new Map(), subjects: [] };
    discoveryFailure = cause.message;
  }
  const discovered = snapshot.subjects;
  const discoveredPaths = discovered
    .map((row) => row.subjectRef.path)
    .sort(compareUtf8);
  const expectedPaths = FILES_BY_GATE[request.gateId]
    .map((relativePath) => `ontology/meta/${relativePath}`)
    .sort(compareUtf8);
  const corpusInventoryMatches = !discoveryFailure
    && canonicalJcs(discoveredPaths) === canonicalJcs(expectedPaths);
  let discovery;
  try {
    discovery = expectedDiscoveryTuple(root, request.gateId);
  } catch (cause) {
    discovery = { ref: null, digest: null, error: cause.message };
  }
  const authored = request.subjectInventory?.subjects;
  const inventoryMatches = exactKeys(request.subjectInventory, [
    'schemaVersion', 'gateId', 'discoveryContractRef',
    'discoveryContractDigest', 'subjects',
  ])
    && request.subjectInventory.schemaVersion === '1.0'
    && request.subjectInventory.gateId === request.gateId
    && canonicalJcs(request.subjectInventory.discoveryContractRef)
      === canonicalJcs(discovery.ref)
    && request.subjectInventory.discoveryContractDigest === discovery.digest
    && Array.isArray(authored)
    && canonicalJcs(authored) === canonicalJcs(discovered)
    && !discovery.error
    && !discoveryFailure;
  const expectedInventoryDigest = taggedDigest(INVENTORY_TAG, request.subjectInventory);
  const digestMatches = request.subjectInventoryDigest === expectedInventoryDigest;
  const dependenciesValid = Array.isArray(request.dependencyReports)
    && request.dependencyReports.length === 0;
  let validation;
  if (discoveryFailure) {
    validation = validationResult(request.gateId, [
      makeFinding(
        'M3_GATE_DISCOVERY_FAILED',
        request.gateId,
        discoveryFailure,
      ),
    ], [], 0);
  } else {
    try {
      validation = validateCapturedCorpus(root, request.gateId, snapshot.files);
    } catch (cause) {
      validation = validationResult(request.gateId, [
        makeFinding(
          'M3_GATE_VALIDATOR_ERROR',
          request.gateId,
          cause.message,
        ),
      ], [], snapshot.files.size);
    }
  }
  if (!inventoryMatches) {
    validation.findings = normalizeFindings([
      ...validation.findings,
      makeFinding(
        'M3_GATE_SUBJECT_INVENTORY_MISMATCH',
        request.gateId,
        'caller subject inventory differs from independent P1 filesystem discovery',
      ),
    ]);
    if (discovery.error) {
      validation.findings = normalizeFindings([
        ...validation.findings,
        makeFinding(
          'M3_GATE_DISCOVERY_CONTRACT',
          request.gateId,
          discovery.error,
        ),
      ]);
    }
  }
  if (!digestMatches) {
    validation.findings = normalizeFindings([
      ...validation.findings,
      makeFinding(
        'M3_GATE_SUBJECT_INVENTORY_DIGEST',
        request.gateId,
        'subject inventory tagged digest differs',
      ),
    ]);
  }
  if (!corpusInventoryMatches) {
    validation.findings = normalizeFindings([
      ...validation.findings,
      makeFinding(
        'M3_GATE_CORPUS_INVENTORY',
        request.gateId,
        `independent discovery differs from the exact ${expectedPaths.length}-file M3 corpus`,
      ),
    ]);
  }
  if (!dependenciesValid) {
    validation.findings = normalizeFindings([
      ...validation.findings,
      makeFinding(
        'M3_GATE_DEPENDENCY_SET',
        request.gateId,
        'M3 schema/import gates require the exact empty dependency report set',
      ),
    ]);
  }
  if (!inventoryMatches || !corpusInventoryMatches || !digestMatches || !dependenciesValid) {
    validation.ok = false;
    validation.passedAssertions = [];
    validation.failedAssertions = [...ASSERTIONS_BY_GATE[request.gateId]];
    validation.findingCount = validation.findings.length;
  }
  const passed = validation.ok && inventoryMatches && corpusInventoryMatches
    && digestMatches && dependenciesValid;
  return output(request, {
    status: 'completed',
    outcome: passed ? 'passed' : 'failed',
    code: passed ? null : `M3_GATE_${request.gateId.replace(/-/gu, '_').toUpperCase()}_FAILED`,
    exitStatus: 0,
  }, validation, discovered.length);
}

function evaluateM3RequiredGate(request, options = {}) {
  if (!GATE_IDS.includes(request?.gateId)
      || request.capabilityId !== `gate.${request.gateId}`
      || request.profileRef !== PROFILE_REF) {
    throw new Error('request does not select one production M3 required gate');
  }
  const root = path.resolve(options.root || process.cwd());
  return request.vectorCategory === null
    ? evaluateCandidate(request, root)
    : evaluateVector(request, root);
}

module.exports = {
  ADAPTER_VERSION,
  ASSERTIONS_BY_GATE,
  DISCOVERY_RULES_BY_GATE,
  FILES_BY_GATE,
  GATE_IDS,
  INVENTORY_TAG,
  META_FILES,
  RUNTIME_POLICY,
  SEMANTIC_EVIDENCE_USE,
  VECTOR_EVIDENCE_USE,
  VECTOR_CODES,
  VECTOR_SUBJECT_TAG,
  applyMutation,
  captureValidatedProductionCorpus,
  discoverSnapshot,
  discoverSubjects,
  discoveryRules,
  expectedDiscoveryTuple,
  evaluateM3RequiredGate,
  runGateValidator,
  sha256,
  taggedDigest,
  validateCapturedCorpus,
};
