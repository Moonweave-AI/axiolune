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
const { validateM2Core } = require('../validate-m2-core.js');
const {
  validateCanonicalFinanceDag,
} = require('./canonical-finance-dag.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  INVENTORY_TAG,
} = require('./m2-gate-artifact-binding-replay.cjs');
const { projectOwl } = require('../generate-m2-owl.cjs');
const { projectShacl } = require('../generate-m2-shacl.cjs');
const termCoverage = require('./public-symbol-term-coverage-validator.cjs');
const {
  PROFILE_REF,
  compareUtf8,
} = require('./m2-release-capability-definitions.cjs');
const {
  SEMANTIC_EVIDENCE_USE,
  SUBJECT_TAG,
  VECTOR_EVIDENCE_USE,
} = require('./m2-required-gate-semantic-replay.cjs');

const ADAPTER_VERSION = '1.0.0';
const RUNTIME_POLICY = 'offline-readonly-independent-discovery-v1';
const INPUT_TAG = 'axiolune-stable-required-gate-input-v1\0';
const RESULT_TAG = 'axiolune-stable-required-gate-result-v1\0';
const SEMANTIC_TAG = 'axiolune-stable-required-gate-evidence-v1\0';
const VECTOR_SEMANTICS_UNIMPLEMENTED = 'STABLE_GATE_VECTOR_SEMANTICS_UNIMPLEMENTED';
const MAX_FINDINGS = 5000;
const MAX_FINDING_TEXT_BYTES = 512;
const FINANCE_BASE = 'https://axiolune.ai/ontology/finance/';

const STABLE_GATE_IDS = Object.freeze([
  'm2-compile',
  'm3-import-digest',
  'm3-schema',
  'module-import-dag',
  'projection-determinism-drift',
  'public-symbol-term-coverage',
].sort(compareUtf8));

const ASSERTIONS_BY_GATE = Object.freeze({
  'm2-compile': Object.freeze([
    'global-iri-closure', 'strict-authoring-schema', 'typed-projection-input',
  ].sort(compareUtf8)),
  'm3-import-digest': Object.freeze([
    'content-addressed-imports', 'digest-closure', 'version-closure',
  ].sort(compareUtf8)),
  'm3-schema': Object.freeze([
    'closed-meta-schema', 'negative-schema-corpus', 'strict-structure',
  ].sort(compareUtf8)),
  'module-import-dag': Object.freeze([
    'acyclic-imports', 'exact-version-imports', 'module-inventory',
  ].sort(compareUtf8)),
  'projection-determinism-drift': Object.freeze([
    'byte-equality', 'double-generation', 'source-projection-binding',
  ].sort(compareUtf8)),
  'public-symbol-term-coverage': Object.freeze([
    'accepted-term-card', 'generated-inheritance', 'public-symbol-inventory',
  ].sort(compareUtf8)),
});

const DISCOVERY_RULES_BY_GATE = Object.freeze({
  'm3-schema': Object.freeze([
    Object.freeze({
      classifier: 'metaModel', pathPrefix: 'ontology/meta/', pathSuffix: '-meta-model.yaml',
    }),
  ]),
  'm3-import-digest': Object.freeze([
    Object.freeze({
      classifier: 'metaDigestManifest', pathPrefix: 'ontology/meta/', pathSuffix: 'digests.json',
    }),
    Object.freeze({
      classifier: 'metaModel', pathPrefix: 'ontology/meta/', pathSuffix: '-meta-model.yaml',
    }),
  ]),
  'm2-compile': Object.freeze([
    Object.freeze({
      classifier: 'codeListAuthority',
      pathPrefix: 'reference/ontology-design-reference/axiolune-controlled-vocabularies/',
      pathSuffix: 'm2-v0.3-code-lists.json',
    }),
    Object.freeze({
      classifier: 'financeModule', pathPrefix: 'ontology/domain/finance/', pathSuffix: '/module.yaml',
    }),
    Object.freeze({
      classifier: 'financeRegistry',
      pathPrefix: 'ontology/domain/finance/registry/', pathSuffix: '.yaml',
    }),
    Object.freeze({
      classifier: 'metaDigestManifest', pathPrefix: 'ontology/meta/', pathSuffix: 'digests.json',
    }),
    Object.freeze({
      classifier: 'metaModel', pathPrefix: 'ontology/meta/', pathSuffix: '-meta-model.yaml',
    }),
    Object.freeze({
      classifier: 'referenceLock',
      pathPrefix: 'docs/ontology/references/', pathSuffix: 'references.lock.yaml',
    }),
  ]),
  'module-import-dag': Object.freeze([
    Object.freeze({
      classifier: 'financeModule', pathPrefix: 'ontology/domain/finance/', pathSuffix: '/module.yaml',
    }),
    Object.freeze({
      classifier: 'moduleRegistry',
      pathPrefix: 'ontology/domain/finance/registry/', pathSuffix: 'module-registry.yaml',
    }),
  ]),
  'projection-determinism-drift': Object.freeze([
    Object.freeze({
      classifier: 'financeModule', pathPrefix: 'ontology/domain/finance/', pathSuffix: '/module.yaml',
    }),
    Object.freeze({
      classifier: 'generatedOwlProjection',
      pathPrefix: 'generated/ontology/finance/', pathSuffix: '.owl.ttl',
    }),
    Object.freeze({
      classifier: 'generatedShaclProjection',
      pathPrefix: 'generated/ontology/finance/', pathSuffix: '.shacl.ttl',
    }),
    Object.freeze({
      classifier: 'sourceOwlProjection',
      pathPrefix: 'ontology/domain/finance/', pathSuffix: '/module.owl.ttl',
    }),
    Object.freeze({
      classifier: 'sourceShaclProjection',
      pathPrefix: 'ontology/domain/finance/', pathSuffix: '/module.shacl.ttl',
    }),
  ]),
  'public-symbol-term-coverage': Object.freeze([
    ...termCoverage.DISCOVERY_RULES,
  ]),
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

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort(compareUtf8))
      === canonicalJcs([...expected].sort(compareUtf8));
}

function posix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function stableGateDiscoveryRules(gateId) {
  const rules = DISCOVERY_RULES_BY_GATE[gateId];
  if (!rules) throw new Error(`unsupported stable required gate ${String(gateId)}`);
  return rules.map((row) => ({ ...row })).sort((left, right) => (
    compareUtf8(canonicalJcs(left), canonicalJcs(right))
  ));
}

function candidateDirectories(root, rules) {
  const directories = new Set();
  for (const rule of rules) {
    const prefix = rule.pathPrefix.endsWith('/')
      ? rule.pathPrefix.slice(0, -1)
      : path.posix.dirname(rule.pathPrefix);
    directories.add(prefix === '.' ? '' : prefix);
  }
  return [...directories].sort(compareUtf8).map((relative) => ({
    relative,
    absolute: path.join(root, ...relative.split('/').filter(Boolean)),
  }));
}

function discoveredFiles(root, rules) {
  const files = new Set();
  const visit = (absolute, relative) => {
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`discovery refuses symbolic link ${relative}`);
    if (stat.isFile()) {
      const matches = rules.filter((rule) => (
        relative.startsWith(rule.pathPrefix) && relative.endsWith(rule.pathSuffix)
      ));
      if (matches.length > 1) throw new Error(`ambiguous discovery rules for ${relative}`);
      if (matches.length === 1) files.add(relative);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`discovery refuses non-regular entry ${relative}`);
    for (const name of fs.readdirSync(absolute).sort(compareUtf8)) {
      const childRelative = relative ? `${relative}/${name}` : name;
      visit(path.join(absolute, name), childRelative);
    }
  };
  for (const directory of candidateDirectories(root, rules)) {
    visit(directory.absolute, directory.relative);
  }
  return [...files].sort(compareUtf8);
}

function discoverGateSubjects(root, gateId) {
  if (gateId === termCoverage.GATE_ID) {
    return termCoverage.discoverSnapshot(root).subjects;
  }
  const rules = stableGateDiscoveryRules(gateId);
  const subjects = [];
  for (const relativePath of discoveredFiles(root, rules)) {
    const matches = rules.filter((rule) => (
      relativePath.startsWith(rule.pathPrefix) && relativePath.endsWith(rule.pathSuffix)
    ));
    const bytes = fs.readFileSync(path.join(root, ...relativePath.split('/')));
    const subjectRef = sourceRef(relativePath);
    const subjectDigest = sha256(bytes);
    const classifier = matches[0].classifier;
    subjects.push({
      subjectId: taggedDigest(SUBJECT_TAG, {
        gateId, subjectRef, subjectDigest, classifier,
      }),
      subjectRef,
      subjectDigest,
      classifier,
    });
  }
  return subjects.sort((left, right) => compareUtf8(left.subjectId, right.subjectId));
}

function makeFinding(code, at, message) {
  const boundedText = (value) => {
    const full = Buffer.from(String(value ?? ''), 'utf8');
    if (full.length <= MAX_FINDING_TEXT_BYTES) return full.toString('utf8');
    const suffix = `…[truncated sha256=${sha256(full)}]`;
    const prefixBudget = MAX_FINDING_TEXT_BYTES - Buffer.byteLength(suffix, 'utf8');
    let end = Math.max(0, prefixBudget);
    while (end > 0 && (full[end] & 0xc0) === 0x80) end -= 1;
    return `${full.subarray(0, end).toString('utf8')}${suffix}`;
  };
  return {
    code: String(code).replace(/[^A-Z0-9_]/gu, '_').toUpperCase(),
    path: boundedText(at),
    message: boundedText(message),
  };
}

function normalizeFindings(findings) {
  const sorted = findings.map((row) => makeFinding(row.code, row.path, row.message))
    .sort((left, right) => compareUtf8(
      `${left.code}\0${left.path}\0${left.message}`,
      `${right.code}\0${right.path}\0${right.message}`,
  ));
  if (sorted.length <= MAX_FINDINGS) return sorted;
  const omitted = sorted.slice(MAX_FINDINGS - 1);
  const omittedDigest = taggedDigest(
    'axiolune-omitted-stable-gate-findings-v1\0',
    omitted,
  );
  return [
    ...sorted.slice(0, MAX_FINDINGS - 1),
    makeFinding(
      'FINDINGS_TRUNCATED',
      '',
      `${omitted.length} additional deterministic findings omitted; `
        + `omittedFindingsDigest=${omittedDigest}`,
    ),
  ];
}

function allAssertionResult(gateId, ok) {
  const assertions = ASSERTIONS_BY_GATE[gateId];
  return {
    passedAssertions: ok ? [...assertions] : [],
    failedAssertions: ok ? [] : [...assertions],
  };
}

function validationResult(gateId, findings, assertionResult = null, checkedArtifactCount = 0) {
  const normalized = normalizeFindings(findings);
  const assertions = assertionResult || allAssertionResult(gateId, normalized.length === 0);
  return {
    ok: normalized.length === 0 && assertions.failedAssertions.length === 0,
    findings: normalized,
    checkedArtifactCount,
    passedAssertions: [...assertions.passedAssertions].sort(compareUtf8),
    failedAssertions: [...assertions.failedAssertions].sort(compareUtf8),
  };
}

function relativeFinding(root, raw, code) {
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  let text = String(raw);
  if (text.startsWith(normalizedRoot)) text = posix(text.slice(normalizedRoot.length));
  const separator = text.indexOf(': ');
  return makeFinding(
    code,
    separator >= 0 ? text.slice(0, separator) : '',
    separator >= 0 ? text.slice(separator + 2) : text,
  );
}

function validateM3Schema(root) {
  const metaDir = path.join(root, 'ontology', 'meta');
  const structure = validateMetaStructure({ metaDir, strict: true });
  const corpus = runStructureNegativeCorpus({ metaDir });
  const findings = structure.errors.map((entry) => relativeFinding(metaDir, entry, 'M3_STRUCTURE'));
  for (const row of corpus.results.filter((item) => !item.rejected)) {
    findings.push(makeFinding('M3_NEGATIVE_CORPUS_ACCEPTED', row.name, row.firstError || 'mutation accepted'));
  }
  if (!corpus.positive.ok) {
    findings.push(makeFinding(
      'M3_NEGATIVE_CORPUS_BASE_INVALID',
      'ontology/meta',
      corpus.positive.errors[0] || 'base model is invalid',
    ));
  }
  const result = validationResult('m3-schema', findings, {
    passedAssertions: [
      ...(structure.ok ? ['closed-meta-schema', 'strict-structure'] : []),
      ...(corpus.ok ? ['negative-schema-corpus'] : []),
    ],
    failedAssertions: [
      ...(!structure.ok ? ['closed-meta-schema', 'strict-structure'] : []),
      ...(!corpus.ok ? ['negative-schema-corpus'] : []),
    ],
  }, 4 + corpus.caseCount);
  return result;
}

function validateM3Imports(root) {
  const findings = [];
  let verified;
  try {
    verified = verifyMetaModel({
      metaDir: path.join(root, 'ontology', 'meta'),
      quiet: true,
    });
  } catch (error) {
    findings.push(makeFinding('M3_IMPORT_VALIDATOR_ERROR', 'ontology/meta', error.message));
    return validationResult('m3-import-digest', findings, null, 5);
  }
  for (const [kind, issue] of Object.entries(verified.issues)) {
    for (const row of issue.results.filter((value) => value.startsWith('✗'))) {
      findings.push(makeFinding(`M3_${kind}`, 'ontology/meta', row));
    }
  }
  return validationResult('m3-import-digest', findings, null, 5);
}

function validateM2Compilation(root) {
  let result;
  try {
    result = validateM2Core({ root, all: true, strict: true });
  } catch (error) {
    return validationResult('m2-compile', [
      makeFinding('M2_CORE_VALIDATOR_ERROR', 'ontology/domain/finance', error.message),
    ]);
  }
  const findings = result.errors.map((entry) => relativeFinding(root, entry, (
    entry.includes('artifactDigest') ? 'M2_IMPORT_DIGEST'
      : entry.includes('authority snapshot is pending') ? 'M2_AUTHORITY_PENDING'
        : 'M2_CORE_INVALID'
  )));
  return validationResult('m2-compile', findings, null, result.fileCount);
}

function financeModules(root) {
  const financeRoot = path.join(root, 'ontology', 'domain', 'finance');
  if (!fs.existsSync(financeRoot)) return [];
  return fs.readdirSync(financeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .map((entry) => ({
      name: entry.name,
      path: `ontology/domain/finance/${entry.name}/module.yaml`,
    }))
    .filter((row) => fs.existsSync(path.join(root, ...row.path.split('/'))))
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((row) => {
      const bytes = fs.readFileSync(path.join(root, ...row.path.split('/')));
      return { ...row, bytes, digest: sha256(bytes), doc: yaml.load(bytes.toString('utf8')) };
    });
}

function validateModuleDag(root) {
  const findings = [];
  let modules;
  try {
    modules = financeModules(root);
  } catch (error) {
    return validationResult('module-import-dag', [
      makeFinding('MODULE_YAML_PARSE', 'ontology/domain/finance', error.message),
    ]);
  }
  const byIri = new Map(modules.map((row) => [row.doc?.module?.moduleIri, row]));
  for (const row of validateCanonicalFinanceDag(modules.map((item) => item.doc))) {
    findings.push(makeFinding(row.code, row.module, row.message));
  }
  const edges = new Map();
  for (const row of modules) {
    const moduleIri = row.doc?.module?.moduleIri;
    const imports = Array.isArray(row.doc?.module?.imports) ? row.doc.module.imports : [];
    const local = [];
    for (const [index, imported] of imports.entries()) {
      const target = byIri.get(imported?.moduleIri);
      const at = `${row.path}.module.imports[${index}]`;
      if (!target) {
        findings.push(makeFinding('UNKNOWN_IMPORT_TARGET', at, String(imported?.moduleIri)));
        continue;
      }
      local.push(imported.moduleIri);
      if (imported.version !== target.doc?.module?.version) {
        findings.push(makeFinding(
          'IMPORT_VERSION_MISMATCH', `${at}.version`,
          `${String(imported.version)} != ${String(target.doc?.module?.version)}`,
        ));
      }
      if (imported.artifactDigest !== target.digest) {
        findings.push(makeFinding(
          'IMPORT_DIGEST_MISMATCH', `${at}.artifactDigest`,
          `${String(imported.artifactDigest)} != ${target.digest}`,
        ));
      }
    }
    edges.set(moduleIri, local);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (iri, chain) => {
    if (visiting.has(iri)) {
      findings.push(makeFinding('IMPORT_CYCLE', iri, [...chain, iri].join(' -> ')));
      return;
    }
    if (visited.has(iri)) return;
    visiting.add(iri);
    for (const child of edges.get(iri) || []) visit(child, [...chain, iri]);
    visiting.delete(iri);
    visited.add(iri);
  };
  for (const iri of [...edges.keys()].sort(compareUtf8)) visit(iri, []);
  const registryPath = path.join(
    root, 'ontology', 'domain', 'finance', 'registry', 'module-registry.yaml',
  );
  try {
    const registry = yaml.load(fs.readFileSync(registryPath, 'utf8'));
    const rows = Array.isArray(registry?.modules) ? registry.modules : [];
    const registryByIri = new Map(rows.map((row) => [row?.moduleIri, row]));
    if (rows.length !== modules.length || registryByIri.size !== modules.length) {
      findings.push(makeFinding(
        'REGISTRY_INVENTORY_MISMATCH', posix(path.relative(root, registryPath)),
        `${rows.length} registry rows for ${modules.length} modules`,
      ));
    }
    for (const module of modules) {
      const row = registryByIri.get(module.doc.module.moduleIri);
      if (!row) {
        findings.push(makeFinding('REGISTRY_MODULE_MISSING', module.path, module.doc.module.moduleIri));
        continue;
      }
      if (row.path !== module.path || row.version !== module.doc.module.version
          || row.artifactDigest !== module.digest) {
        findings.push(makeFinding(
          'REGISTRY_MODULE_MISMATCH', module.path,
          'registry path/version/digest differs from discovered module bytes',
        ));
      }
    }
  } catch (error) {
    findings.push(makeFinding('REGISTRY_INVALID', posix(path.relative(root, registryPath)), error.message));
  }
  const codes = new Set(findings.map((row) => row.code));
  const inventoryCodes = new Set([
    'DUPLICATE_FINANCE_MODULE', 'EXTRA_FINANCE_MODULE', 'MISSING_FINANCE_MODULE',
    'REGISTRY_INVALID', 'REGISTRY_INVENTORY_MISMATCH', 'REGISTRY_MODULE_MISMATCH',
    'REGISTRY_MODULE_MISSING',
  ]);
  const versionCodes = new Set([
    'IMPORT_DIGEST_MISMATCH', 'IMPORT_VERSION_MISMATCH', 'UNKNOWN_IMPORT_TARGET',
    'WRONG_FINANCE_VERSION',
  ]);
  const failed = [];
  if ([...codes].some((code) => inventoryCodes.has(code))) failed.push('module-inventory');
  if (codes.has('IMPORT_CYCLE')) failed.push('acyclic-imports');
  if ([...codes].some((code) => versionCodes.has(code))) failed.push('exact-version-imports');
  if (findings.length > 0 && failed.length === 0) failed.push(...ASSERTIONS_BY_GATE['module-import-dag']);
  return validationResult('module-import-dag', findings, {
    passedAssertions: ASSERTIONS_BY_GATE['module-import-dag'].filter((id) => !failed.includes(id)),
    failedAssertions: failed,
  }, modules.length + 1);
}

async function validateProjectionDrift(root) {
  const findings = [];
  let modules;
  try {
    modules = financeModules(root);
  } catch (error) {
    return validationResult('projection-determinism-drift', [
      makeFinding('PROJECTION_SOURCE_PARSE', 'ontology/domain/finance', error.message),
    ]);
  }
  for (const module of modules) {
    try {
      const owlFirst = await projectOwl(module.doc);
      const owlSecond = await projectOwl(module.doc);
      const shaclFirst = await projectShacl(module.doc);
      const shaclSecond = await projectShacl(module.doc);
      if (!owlFirst.equals(owlSecond) || !shaclFirst.equals(shaclSecond)) {
        findings.push(makeFinding(
          'PROJECTION_NONDETERMINISTIC', module.path,
          'two pure generations did not produce byte-identical projections',
        ));
      }
      const pairs = [
        [`ontology/domain/finance/${module.name}/module.owl.ttl`, owlFirst],
        [`ontology/domain/finance/${module.name}/module.shacl.ttl`, shaclFirst],
        [`generated/ontology/finance/${module.name}/${module.name}.owl.ttl`, owlFirst],
        [`generated/ontology/finance/${module.name}/${module.name}.shacl.ttl`, shaclFirst],
      ];
      for (const [relativePath, expected] of pairs) {
        const absolute = path.join(root, ...relativePath.split('/'));
        if (!fs.existsSync(absolute)) {
          findings.push(makeFinding('PROJECTION_MISSING', relativePath, 'projection artifact is missing'));
        } else if (!fs.readFileSync(absolute).equals(expected)) {
          findings.push(makeFinding(
            'PROJECTION_DRIFT', relativePath,
            `${sha256(fs.readFileSync(absolute))} != regenerated ${sha256(expected)}`,
          ));
        }
      }
    } catch (error) {
      findings.push(makeFinding('PROJECTION_ERROR', module.path, error.message));
    }
  }
  const nondeterministic = findings.some((row) => row.code === 'PROJECTION_NONDETERMINISTIC');
  const drift = findings.some((row) => row.code !== 'PROJECTION_NONDETERMINISTIC');
  return validationResult('projection-determinism-drift', findings, {
    passedAssertions: [
      ...(!nondeterministic ? ['double-generation', 'byte-equality'] : []),
      ...(!drift ? ['source-projection-binding'] : []),
    ],
    failedAssertions: [
      ...(nondeterministic ? ['double-generation', 'byte-equality'] : []),
      ...(drift ? ['source-projection-binding'] : []),
    ],
  }, modules.length * 5);
}

function validatePublicSymbolTerms(root) {
  return termCoverage.captureAndValidate(root).validation;
}

async function runCandidateValidation(root, gateId) {
  if (gateId === 'm3-schema') return validateM3Schema(root);
  if (gateId === 'm3-import-digest') return validateM3Imports(root);
  if (gateId === 'm2-compile') return validateM2Compilation(root);
  if (gateId === 'module-import-dag') return validateModuleDag(root);
  if (gateId === 'projection-determinism-drift') return validateProjectionDrift(root);
  if (gateId === 'public-symbol-term-coverage') return validatePublicSymbolTerms(root);
  throw new Error(`unsupported stable required gate ${String(gateId)}`);
}

function vectorResult(request) {
  // These adapters can independently evaluate a reconstructed candidate tree,
  // but their locked test-vector subjects are not yet gate-specific semantic
  // fixtures.  A generic `valid: true` flag or a hard-coded violation is not a
  // negative execution of the production validator.  Keep every vector
  // category fail-closed until the same gate validator consumes a controlled
  // positive corpus and a real semantic mutation for that gate.
  return {
    status: 'engineFailure', outcome: 'engineFailure',
    code: VECTOR_SEMANTICS_UNIMPLEMENTED, exitStatus: 2,
  };
}

function evidence(request, validation, resultIdentity, discovered, inventoryMatches) {
  const checkedAssertions = [...ASSERTIONS_BY_GATE[request.gateId]];
  const findings = [...validation.findings];
  if (!inventoryMatches) {
    findings.push(makeFinding(
      'SUBJECT_INVENTORY_MISMATCH', request.gateId,
      'caller inventory differs from adapter-independent filesystem discovery',
    ));
  }
  const normalizedFindings = normalizeFindings(findings);
  const failedAssertions = inventoryMatches
    ? validation.failedAssertions : checkedAssertions;
  const passedAssertions = inventoryMatches
    ? validation.passedAssertions : [];
  const inputDigest = taggedDigest(INPUT_TAG, {
    gateId: request.gateId,
    subjects: discovered,
    dependencyReports: request.dependencyReports || [],
  });
  const resultDigest = taggedDigest(RESULT_TAG, {
    checkedAssertions,
    passedAssertions,
    failedAssertions,
    findings: normalizedFindings,
  });
  const kindEvidence = {
    adapterVersion: ADAPTER_VERSION,
    gateKind: request.gateId,
    runtimePolicy: RUNTIME_POLICY,
    checkedAssertions,
    passedAssertions,
    failedAssertions,
    subjectCount: discovered.length,
    checkedArtifactCount: validation.checkedArtifactCount,
    findingCount: normalizedFindings.length,
    findings: normalizedFindings,
    inputDigest,
    resultDigest,
  };
  const isVector = request.vectorCategory !== null;
  const value = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    capabilityId: request.capabilityId,
    gateId: request.gateId,
    status: resultIdentity.status,
    outcome: resultIdentity.outcome,
    code: resultIdentity.code,
    evidenceUse: isVector ? VECTOR_EVIDENCE_USE : SEMANTIC_EVIDENCE_USE,
    // This module remains the explicitly non-production candidate adapter.
    // A diagnostic pass must never be promoted into release eligibility; only
    // the reviewed production adapter registry may emit that evidence.
    releaseEligibilityEvidence: false,
    callerEvidenceAccepted: false,
    subjectInventoryDigest: isVector ? null : request.subjectInventoryDigest,
    dependencyReportDigests: isVector ? [] : request.dependencyReports
      .map((row) => row.reportDigest).sort(compareUtf8),
    semanticDigest: taggedDigest(SEMANTIC_TAG, kindEvidence),
    kindEvidence,
  };
  return { value, exitStatus: resultIdentity.exitStatus };
}

async function evaluateStableRequiredGate(request, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  if (!STABLE_GATE_IDS.includes(request?.gateId)
      || request.capabilityId !== `gate.${request.gateId}`
      || request.profileRef !== PROFILE_REF) {
    throw new Error('request does not select one reviewed stable required gate');
  }
  if (request.vectorCategory !== null) {
    const resultIdentity = vectorResult(request);
    const fixtureFindings = resultIdentity.outcome === 'accepted' ? [] : [
      makeFinding(resultIdentity.code, request.gateId, 'locked semantic vector result'),
    ];
    const validation = validationResult(request.gateId, fixtureFindings, {
      passedAssertions: resultIdentity.outcome === 'accepted'
        ? ASSERTIONS_BY_GATE[request.gateId] : [],
      failedAssertions: resultIdentity.outcome === 'accepted'
        ? [] : ASSERTIONS_BY_GATE[request.gateId],
    }, request.subject === null ? 0 : 1);
    return evidence(request, validation, resultIdentity, [], true);
  }
  let discovered;
  let validation;
  if (request.gateId === termCoverage.GATE_ID) {
    try {
      const captured = termCoverage.captureAndValidate(root);
      discovered = captured.snapshot.subjects;
      validation = captured.validation;
    } catch (error) {
      discovered = [];
      validation = validationResult(termCoverage.GATE_ID, [
        makeFinding('TERM_CORPUS_CAPTURE_FAILED', termCoverage.GATE_ID, error.message),
      ]);
      return evidence(request, validation, {
        status: 'engineFailure',
        outcome: 'engineFailure',
        code: 'TERM_CORPUS_CAPTURE_FAILED',
        exitStatus: 2,
      }, discovered, false);
    }
  } else {
    discovered = discoverGateSubjects(root, request.gateId);
    validation = await runCandidateValidation(root, request.gateId);
  }
  const inventory = request.subjectInventory;
  const authoredSubjects = inventory?.subjects;
  const discoveryContractPath = [
    'scripts/domain/release-capability-profile/v0.3.0/gates',
    request.gateId,
    'discovery-contract.json',
  ].join('/');
  let expectedDiscoveryContractDigest = null;
  let discoveryContractError = null;
  try {
    if (request.gateId === termCoverage.GATE_ID) {
      expectedDiscoveryContractDigest = sha256(
        termCoverage.readStableRegularFile(root, discoveryContractPath),
      );
    } else {
      const absoluteDiscovery = path.join(root, ...discoveryContractPath.split('/'));
      const stat = fs.lstatSync(absoluteDiscovery);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('discovery contract is not a regular source file');
      }
      expectedDiscoveryContractDigest = sha256(fs.readFileSync(absoluteDiscovery));
    }
  } catch (error) {
    discoveryContractError = error;
    expectedDiscoveryContractDigest = null;
  }
  if (discoveryContractError !== null) {
    const failedValidation = validationResult(request.gateId, [
      ...validation.findings,
      makeFinding(
        'DISCOVERY_CONTRACT_CAPTURE_FAILED',
        discoveryContractPath,
        discoveryContractError.message,
      ),
    ], allAssertionResult(request.gateId, false), validation.checkedArtifactCount);
    return evidence(request, failedValidation, {
      status: 'engineFailure',
      outcome: 'engineFailure',
      code: 'DISCOVERY_CONTRACT_CAPTURE_FAILED',
      exitStatus: 2,
    }, discovered, false);
  }
  const inventoryEnvelopeMatches = exactKeys(inventory, [
    'schemaVersion', 'gateId', 'discoveryContractRef',
    'discoveryContractDigest', 'subjects',
  ])
    && inventory.schemaVersion === '1.0'
    && inventory.gateId === request.gateId
    && exactKeys(inventory.discoveryContractRef, ['kind', 'root', 'path'])
    && inventory.discoveryContractRef?.kind === 'path'
    && inventory.discoveryContractRef?.root === 'sourceTree'
    && inventory.discoveryContractRef?.path === discoveryContractPath
    && /^sha256:[0-9a-f]{64}$/u.test(expectedDiscoveryContractDigest || '')
    && inventory.discoveryContractDigest === expectedDiscoveryContractDigest
    && Array.isArray(authoredSubjects)
    && canonicalJcs(authoredSubjects) === canonicalJcs(discovered);
  const inventoryDigestMatches = inventory !== null && typeof inventory === 'object'
    && !Array.isArray(inventory)
    && /^sha256:[0-9a-f]{64}$/u.test(request.subjectInventoryDigest || '')
    && request.subjectInventoryDigest === taggedDigest(INVENTORY_TAG, inventory);
  const dependenciesMatch = Array.isArray(request.dependencyReports)
    && request.dependencyReports.length === 0;
  const inventoryMatches = inventoryEnvelopeMatches && inventoryDigestMatches
    && dependenciesMatch;
  const passed = validation.ok && inventoryMatches;
  return evidence(request, validation, {
    status: 'completed',
    outcome: passed ? 'passed' : 'failed',
    code: passed ? null : `STABLE_GATE_${request.gateId.replace(/-/gu, '_').toUpperCase()}_FAILED`,
    exitStatus: 0,
  }, discovered, inventoryMatches);
}

module.exports = {
  ADAPTER_VERSION,
  ASSERTIONS_BY_GATE,
  DISCOVERY_RULES_BY_GATE,
  RUNTIME_POLICY,
  STABLE_GATE_IDS,
  VECTOR_SEMANTICS_UNIMPLEMENTED,
  discoverGateSubjects,
  evaluateStableRequiredGate,
  runCandidateValidation,
  stableGateDiscoveryRules,
};
