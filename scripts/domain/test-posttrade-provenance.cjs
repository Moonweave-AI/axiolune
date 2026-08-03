#!/usr/bin/env node
'use strict';

/**
 * Executable RFC-001 v0.3 Post-trade gate.
 *
 * This gate deliberately exits 2 while provenance/reference locks remain
 * pending. Exit 0 is reserved for a genuinely closed gate; exit 1 means an
 * ontology, projection, SHACL-runtime, positive-fixture, or negative-fixture
 * failure.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Parser, Store, DataFactory } = require('n3');
const SHACLValidator = require('rdf-validate-shacl').default;
const { projectOwl } = require('./generate-m2-owl.cjs');
const { projectShacl } = require('./generate-m2-shacl.cjs');
const {
  loadYaml,
  mutate,
  validatePostTradeModule,
  validateScenario,
} = require('./lib/post-trade-v03-contract.cjs');
const {
  auditPostTradeFixtureOntologyCoverage,
} = require('./lib/post-trade-fixture-ontology-coverage.cjs');
const {
  assertCanonicalTypedFixtureBuildMatchesManifest,
  buildPostTradeCanonicalTypedFixture,
  mergeFinanceOntologyDocuments,
  normalizePostTradeCanonicalTypedFixture,
  validateCanonicalTypedFixtureManifest,
} = require('./lib/post-trade-canonical-envelope-builder.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateSourceLocator,
} = require('./lib/strict-source-locator.cjs');
const {
  PATHS: CUSTOM_RUNTIME_PATHS,
} = require('./lib/post-trade-custom-profile.cjs');
const {
  PATHS: FIXTURE_RELEASE_PATHS,
  verifyPostTradeFixtureReleaseEvidence,
} = require('./lib/post-trade-fixture-release-evidence.cjs');
const {
  extractPdfPageRangeBytes,
  parseRuntimeLock,
  resolveRuntimeRoot,
} = require('./lib/pdf-page-range-runtime.cjs');

const { namedNode, quad } = DataFactory;
const ROOT = path.resolve(__dirname, '..', '..');
const POST_TRADE_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.yaml');
const MARKET_RULES_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'market-rules', 'module.yaml');
const PATTERN_FILE = path.join(ROOT, 'ontology', 'meta', 'cross-domain-patterns.yaml');
const REFERENCE_LOCK_FILE = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const CODE_LIST_AUTHORITY_FILE = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-vocabularies',
  'm2-v0.3-code-lists.json',
);
const POSITIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'post-trade-closure-reconciliation.yaml');
const TYPED_OVERLAY_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'post-trade-typed-envelope-overlay.json');
const NON_RECORD_CLASSIFICATION_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'post-trade-non-record-classifications.json');
const NEGATIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'post-trade-closure-reconciliation-negative.yaml');
const TYPED_BUILDER_FILE = path.join(ROOT, 'scripts', 'domain', 'lib', 'post-trade-canonical-envelope-builder.cjs');
const TRACKED_PROJECTIONS = [
  {
    label: 'ontology OWL sidecar',
    kind: 'owl',
    file: path.join(ROOT, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.owl.ttl'),
  },
  {
    label: 'generated OWL mirror',
    kind: 'owl',
    file: path.join(ROOT, 'generated', 'ontology', 'finance', 'post-trade-operations', 'post-trade-operations.owl.ttl'),
  },
  {
    label: 'ontology SHACL sidecar',
    kind: 'shacl',
    file: path.join(ROOT, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.shacl.ttl'),
  },
  {
    label: 'generated SHACL mirror',
    kind: 'shacl',
    file: path.join(ROOT, 'generated', 'ontology', 'finance', 'post-trade-operations', 'post-trade-operations.shacl.ttl'),
  },
];
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
const SH = 'http://www.w3.org/ns/shacl#';

let passed = 0;
let failed = 0;
let pending = 0;

function pass(id, detail) {
  passed += 1;
  console.log(`PASS ${id}: ${detail}`);
}

function fail(id, detail) {
  failed += 1;
  console.error(`FAIL ${id}: ${detail}`);
}

function pend(id, detail) {
  pending += 1;
  console.log(`PENDING ${id}: ${detail}`);
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function resolvesInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateDtcLocatorEvidence(referenceLock) {
  const requirements = [
    { id: 'dtc-distributions-service-guide-2026-05-06', startPage: 34, endPage: 35 },
    { id: 'dtc-settlement-service-guide-2026-06-10', startPage: 10, endPage: 10 },
  ];
  for (const requirement of requirements) {
    const reference = (referenceLock.references || []).find((item) => item.id === requirement.id);
    const checkId = `DTC-LOCATOR/${requirement.id}`;
    if (!reference || typeof reference.localPath !== 'string' || !Array.isArray(reference.locators)) {
      fail(checkId, 'required locked DTC reference/locator inventory is missing');
      continue;
    }
    const localRoot = path.resolve(ROOT, ...reference.localPath.split('/'));
    if (!resolvesInside(localRoot, ROOT) || !fs.existsSync(localRoot) || !fs.statSync(localRoot).isDirectory()) {
      fail(checkId, 'localPath is absent, escapes the repository, or is not a directory');
      continue;
    }
    const wholeLocators = reference.locators.filter((item) => item.kind === 'wholeFile');
    const pageLocators = reference.locators.filter((item) => item.kind === 'pdfPageRange');
    if (wholeLocators.length !== 1 || pageLocators.length !== 1) {
      fail(checkId, 'exactly one wholeFile and one pdfPageRange locator are required');
      continue;
    }
    for (const locator of reference.locators) {
      const locatorId = `${checkId}/${locator.kind}`;
      const sourceFile = path.resolve(localRoot, ...String(locator.path || '').split('/'));
      if (!resolvesInside(sourceFile, localRoot) || !fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
        fail(locatorId, 'locator path is absent, escapes the locked artifact, or is not a regular file');
        continue;
      }
      const profileRef = locator.extractorProfileRef;
      const profileFile = profileRef?.root === 'sourceTree' && profileRef?.kind === 'path'
        ? path.resolve(ROOT, ...String(profileRef.path || '').split('/')) : undefined;
      if (!profileFile || !resolvesInside(profileFile, ROOT) || !fs.existsSync(profileFile)
          || !fs.statSync(profileFile).isFile() || sha256File(profileFile) !== locator.extractorProfileDigest) {
        fail(locatorId, 'extractor profile is not a digest-locked source-tree file');
        continue;
      }
      const selectedBytes = locator.kind === 'wholeFile' ? fs.readFileSync(sourceFile) : undefined;
      const locatorResult = validateSourceLocator(locator, { at: locatorId, selectedBytes });
      if (!locatorResult.ok) {
        for (const error of locatorResult.errors) fail(locatorId, error);
        continue;
      }
      let profile;
      try {
        profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      } catch (error) {
        fail(locatorId, `extractor profile is invalid JSON: ${error.message}`);
        continue;
      }
      if (locator.kind === 'wholeFile') {
        pass(locatorId, `exact PDF bytes and selectionDigest verified (${path.basename(sourceFile)})`);
        continue;
      }
      if (locator.startPage !== requirement.startPage || locator.endPage !== requirement.endPage) {
        fail(locatorId, `required physical-page selector is ${requirement.startPage}-${requirement.endPage}`);
        continue;
      }
      if (profile.extractorStatus !== 'executable') {
        pend(locatorId, `fail-closed: selector shape/profile/source bytes verified, but profile status is ${profile.extractorStatus || 'unspecified'}; selectionDigest was not runtime-recomputed`);
      } else {
        try {
          const resolveProfileArtifact = (artifactRef, digest, label) => {
            if (artifactRef?.kind !== 'path' || artifactRef.root !== 'sourceTree') {
              throw new Error(`${label} must be a sourceTree path reference`);
            }
            const artifactFile = path.resolve(ROOT, ...String(artifactRef.path || '').split('/'));
            if (!resolvesInside(artifactFile, ROOT)
                || !fs.existsSync(artifactFile)
                || !fs.statSync(artifactFile).isFile()) {
              throw new Error(`${label} is absent, escapes the repository, or is not a regular file`);
            }
            if (sha256File(artifactFile) !== digest) {
              throw new Error(`${label} digest does not match the executable profile`);
            }
            return artifactFile;
          };
          const implementationFile = resolveProfileArtifact(
            profile.implementationRef,
            profile.implementationDigest,
            'PDF selector implementation',
          );
          resolveProfileArtifact(
            profile.executionDriverRef,
            profile.executionDriverDigest,
            'PDF runtime execution driver',
          );
          const runtimeLockFile = resolveProfileArtifact(
            profile.runtimeLockRef,
            profile.runtimeLockDigest,
            'PDF runtime lock',
          );
          if (profile.networkAccess !== false) {
            throw new Error('PDF executable profile must prohibit runtime network access');
          }
          const runtimeLock = parseRuntimeLock(fs.readFileSync(runtimeLockFile));
          const selected = extractPdfPageRangeBytes({
            implementationPath: implementationFile,
            lock: runtimeLock,
            runtimeRoot: resolveRuntimeRoot(ROOT),
            sourcePath: sourceFile,
            startPage: locator.startPage,
            endPage: locator.endPage,
          });
          const recomputedDigest = computeSelectionDigest(locator, selected);
          const replayValidation = validateSourceLocator(locator, {
            at: locatorId,
            selectedBytes: selected,
          });
          if (!replayValidation.ok || recomputedDigest !== locator.selectionDigest) {
            const details = replayValidation.errors.length > 0
              ? replayValidation.errors.join('; ')
              : `expected ${recomputedDigest}`;
            fail(locatorId, `locked runtime replay did not reproduce selectionDigest: ${details}`);
          } else {
            pass(
              locatorId,
              `locked runtime replay reproduced ${selected.length} selected bytes and ${recomputedDigest}`,
            );
          }
        } catch (error) {
          fail(locatorId, `locked runtime replay failed closed: ${error.message}`);
        }
      }
    }
  }
}

function object(source, subject, predicate) {
  return source.getQuads(subject, namedNode(predicate), null, null)[0]?.object;
}

function extractGeneratedXone(quads, targetClass, constraintIri) {
  const source = new Store(quads);
  const result = new Store();
  const targetShape = namedNode(`${targetClass}Shape`);
  const constraintShape = namedNode(`${constraintIri}/shape`);
  result.addQuad(quad(targetShape, namedNode(RDF_TYPE), namedNode(`${SH}NodeShape`)));
  result.addQuad(quad(targetShape, namedNode(`${SH}targetClass`), namedNode(targetClass)));
  result.addQuad(quad(targetShape, namedNode(`${SH}node`), constraintShape));

  const queue = [constraintShape];
  const visited = new Set();
  while (queue.length > 0) {
    const subject = queue.shift();
    const key = `${subject.termType}\0${subject.value}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const statement of source.getQuads(subject, null, null, null)) {
      result.addQuad(statement);
      const candidate = statement.object;
      if (candidate.termType === 'BlankNode'
          || (candidate.termType === 'NamedNode' && candidate.value.startsWith(constraintIri))) {
        queue.push(candidate);
      }
    }
  }

  const listHead = object(source, constraintShape, `${SH}xone`);
  assert.ok(listHead, `${constraintIri} has no generated sh:xone list`);
  const paths = [];
  let cursor = listHead;
  const seen = new Set();
  while (cursor.value !== RDF_NIL) {
    assert.ok(!seen.has(cursor.value), `${constraintIri} has cyclic RDF list`);
    seen.add(cursor.value);
    const branch = object(source, cursor, RDF_FIRST);
    assert.ok(branch, `${constraintIri} xone list misses rdf:first`);
    const propertyShape = object(source, branch, `${SH}property`);
    const propertyPath = propertyShape && object(source, propertyShape, `${SH}path`);
    assert.equal(propertyPath?.termType, 'NamedNode', `${constraintIri} branch path is not a named predicate`);
    paths.push(propertyPath.value);
    cursor = object(source, cursor, RDF_REST);
    assert.ok(cursor, `${constraintIri} xone list misses rdf:rest`);
  }
  assert.ok(paths.length >= 2, `${constraintIri} must have at least two branches`);
  return { shapeStore: result, paths };
}

async function validateGeneratedXone(shaclQuads, targetClass, constraintIri) {
  const { shapeStore, paths } = extractGeneratedXone(shaclQuads, targetClass, constraintIri);
  const validator = new SHACLValidator(shapeStore);
  const graph = (selected) => {
    const focus = namedNode(`urn:axiolune:test:${constraintIri.split('/').at(-1)}`);
    const store = new Store([quad(focus, namedNode(RDF_TYPE), namedNode(targetClass))]);
    for (const predicate of selected) store.addQuad(quad(focus, namedNode(predicate), namedNode(`urn:axiolune:value:${paths.indexOf(predicate)}`)));
    return store;
  };
  assert.equal((await validator.validate(graph([paths[0]]))).conforms, true, 'one branch must conform');
  assert.equal((await validator.validate(graph([]))).conforms, false, 'zero branches must fail');
  assert.equal((await validator.validate(graph(paths.slice(0, 2)))).conforms, false, 'two branches must fail');
  return paths;
}

function validateCustomRuntime() {
  const profileCheck = spawnSync(
    process.execPath,
    [CUSTOM_RUNTIME_PATHS.generator, '--check'],
    {
      cwd: ROOT, encoding: 'utf8', shell: false, timeout: 30000,
      maxBuffer: 1024 * 1024, windowsHide: true,
    },
  );
  assert.equal(
    profileCheck.status,
    0,
    `Post-trade Custom profile drift: ${profileCheck.error?.message || profileCheck.stderr || profileCheck.stdout}`,
  );
  const inheritedOutput = process.env.AXIOLUNE_GATE_OUTPUT_DIR;
  const outputDirectory = inheritedOutput
    ? path.join(path.resolve(inheritedOutput), 'post-trade-custom-runtime')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-pto-custom-'));
  if (inheritedOutput) fs.mkdirSync(outputDirectory, { recursive: true });
  try {
    const run = spawnSync(
      process.execPath,
      [CUSTOM_RUNTIME_PATHS.runner, '--output-dir', outputDirectory],
      {
        cwd: ROOT, encoding: 'utf8', shell: false, timeout: 180000,
        maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      },
    );
    assert.equal(
      run.status,
      0,
      `Post-trade Custom runtime failed: ${run.error?.message || run.stderr || run.stdout}`,
    );
    const evidenceFile = path.join(outputDirectory, 'post-trade-custom-runtime-evidence.json');
    assert.ok(fs.existsSync(evidenceFile), 'Post-trade Custom runtime emitted no evidence');
    const evidenceBytes = fs.readFileSync(evidenceFile);
    const evidence = JSON.parse(evidenceBytes.toString('utf8'));
    assert.ok(
      evidenceBytes.equals(Buffer.from(canonicalJcs(evidence), 'utf8')),
      'Post-trade Custom runtime evidence is not exact RFC 8785 JCS',
    );
    assert.equal(evidence.outcome, 'passed');
    assert.equal(evidence.componentEligible, true);
    assert.equal(evidence.discoveredConstraints?.length, 31);
    assert.equal(evidence.vectorResults?.length, 68);
    assert.equal(evidence.focusedRegressionResults?.length, 242);
    assert.ok(evidence.vectorResults.every((row) => row.status === 'passed'));
    assert.ok(evidence.focusedRegressionResults.every((row) => row.status === 'passed'));
    assert.equal(
      evidence.focusedRegressionResults.filter((row) => row.category === 'positive').length,
      8,
    );
    assert.equal(
      evidence.focusedRegressionResults.filter((row) => row.category === 'violation').length,
      219,
    );
    assert.equal(
      evidence.focusedRegressionResults.filter((row) => row.category === 'processingFindingPositive').length,
      1,
    );
    assert.equal(
      evidence.focusedRegressionResults.filter((row) => row.category === 'processingFindingViolation').length,
      14,
    );
    const byConstraint = new Map();
    for (const row of evidence.vectorResults) {
      if (!row.constraintIri || !['accepted', 'violation'].includes(row.category)) continue;
      const categories = byConstraint.get(row.constraintIri) || new Set();
      categories.add(row.category);
      byConstraint.set(row.constraintIri, categories);
    }
    assert.equal(byConstraint.size, 31);
    assert.ok([...byConstraint.values()].every(
      (categories) => categories.has('accepted') && categories.has('violation'),
    ));
    const controls = new Map(
      evidence.vectorResults
        .filter((row) => row.category === 'engineFailure')
        .map((row) => [row.caseId, row.actual]),
    );
    assert.deepEqual(controls, new Map([
      ['unknown-constraint', 'WORKER_EXIT'],
      ['binding-tamper', 'WORKER_EXIT'],
      ['fixture-contract-tamper', 'WORKER_EXIT'],
      ['timeout', 'TIME_LIMIT'],
      ['oversize-input', 'INPUT_LIMIT'],
      ['oversize-output-cap', 'OUTPUT_LIMIT'],
    ]));
    assert.ok(Object.values(evidence.permissionAssurance || {}).every((value) => value === true));
    assert.equal(evidence.executionBoundary?.exactReadAllowlistCount, 7);
    assert.equal(evidence.executionBoundary?.nodePermissionModel, true);
    assert.equal(evidence.evidenceClassification?.syntheticFixture, true);
    assert.equal(evidence.evidenceClassification?.productionEligible, false);
    assert.equal(evidence.evidenceClassification?.authorityClaim, 'none');
    for (const [referenceField, digestField] of [
      ['closureRef', 'closureDigest'],
      ['discoveryRef', 'discoveryDigest'],
      ['implementationRef', 'implementationDigest'],
      ['negativeFixtureRef', 'negativeFixtureDigest'],
      ['positiveFixtureRef', 'positiveFixtureDigest'],
      ['vectorRef', 'vectorDigest'],
      ['workerRef', 'workerDigest'],
    ]) {
      const ref = evidence.artifacts?.[referenceField];
      assert.equal(ref?.kind, 'path');
      assert.equal(ref?.root, 'sourceTree');
      assert.equal(typeof ref?.path, 'string');
      assert.equal(path.isAbsolute(ref.path), false);
      const file = path.resolve(ROOT, ...ref.path.split('/'));
      assert.ok(resolvesInside(file, ROOT));
      assert.equal(sha256File(file), evidence.artifacts[digestField]);
    }
    return {
      constraints: byConstraint.size,
      regression: evidence.focusedRegressionResults.length,
      vectors: evidence.vectorResults.length,
    };
  } finally {
    if (!inheritedOutput) {
      const resolved = path.resolve(outputDirectory);
      assert.ok(resolvesInside(resolved, os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('axiolune-pto-custom-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

function validateFixtureReleaseEvidence() {
  const inheritedOutput = process.env.AXIOLUNE_GATE_OUTPUT_DIR;
  const outputDirectory = inheritedOutput
    ? path.join(path.resolve(inheritedOutput), 'post-trade-fixture-release')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-pto-fixture-release-'));
  if (inheritedOutput) fs.mkdirSync(outputDirectory, { recursive: true });
  try {
    const run = spawnSync(
      process.execPath,
      [FIXTURE_RELEASE_PATHS.boundaryRunner, '--output-dir', outputDirectory],
      {
        cwd: ROOT, encoding: 'utf8', shell: false, timeout: 180000,
        maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      },
    );
    assert.equal(
      run.status,
      0,
      `Post-trade fixture release evidence failed: ${run.error?.message || run.stderr || run.stdout}`,
    );
    const evidenceFile = path.join(outputDirectory, 'post-trade-fixture-release-evidence.json');
    assert.ok(fs.existsSync(evidenceFile), 'fixture release runner emitted no evidence');
    const evidenceBytes = fs.readFileSync(evidenceFile);
    const evidence = JSON.parse(evidenceBytes.toString('utf8'));
    assert.ok(
      evidenceBytes.equals(Buffer.from(canonicalJcs(evidence), 'utf8')),
      'fixture release evidence is not exact RFC 8785 JCS',
    );
    verifyPostTradeFixtureReleaseEvidence(evidence);
    return evidence;
  } finally {
    if (!inheritedOutput) {
      const resolved = path.resolve(outputDirectory);
      assert.ok(resolvesInside(resolved, os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('axiolune-pto-fixture-release-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

async function main() {
  const postTrade = loadYaml(POST_TRADE_FILE);
  const marketRules = loadYaml(MARKET_RULES_FILE);
  const referenceLock = loadYaml(REFERENCE_LOCK_FILE);
  const referenceLockText = fs.readFileSync(REFERENCE_LOCK_FILE, 'utf8');
  const authorityManifest = fs.existsSync(CODE_LIST_AUTHORITY_FILE)
    ? JSON.parse(fs.readFileSync(CODE_LIST_AUTHORITY_FILE, 'utf8'))
    : undefined;
  const moduleValidationOptions = { authorityManifest };

  const moduleResult = validatePostTradeModule(
    postTrade,
    marketRules,
    referenceLockText,
    moduleValidationOptions,
  );
  if (moduleResult.errors.length === 0) {
    pass('MODULE-PTO', 'typed inventory, seven-module import closure, dual facts, role modes, canonical Market Rules reuse, and 21 xones');
  } else {
    for (const error of moduleResult.errors) fail('MODULE-PTO', error);
  }
  for (const item of moduleResult.pending) pend('EVIDENCE-PTO', item);
  validateDtcLocatorEvidence(referenceLock);

  const expectModuleMutationRejected = (id, change, expectedFragment) => {
    const mutated = structuredClone(postTrade);
    change(mutated);
    const result = validatePostTradeModule(
      mutated,
      marketRules,
      referenceLockText,
      moduleValidationOptions,
    );
    const matched = result.errors.find((item) => item.includes(expectedFragment));
    if (matched) pass(`MODULE-MUTATION/${id}`, matched);
    else fail(`MODULE-MUTATION/${id}`, `expected error containing ${expectedFragment}; got ${result.errors.join('; ') || 'no errors'}`);
  };
  expectModuleMutationRejected('event-source-id-deleted', (document) => {
    const type = document.domain.associationTypes.CorporateActionEvent;
    type.attributeUses = type.attributeUses.filter((item) => !item.attribute.endsWith('/sourceEventId'));
  }, 'CorporateActionEvent missing required attribute sourceEventId');
  expectModuleMutationRejected('due-bill-role-deleted', (document) => {
    const type = document.domain.associationTypes.CorporateActionDueBillObligation;
    type.participantRoles = type.participantRoles.filter((item) => item.id !== 'liableAccountPartyRole');
  }, 'CorporateActionDueBillObligation missing required role liableAccountPartyRole');
  expectModuleMutationRejected('due-bill-account-range-cardinality-drift', (document) => {
    const role = document.domain.associationTypes.CorporateActionDueBillObligation.participantRoles.find((item) => item.id === 'beneficiaryAccount');
    role.range = 'https://axiolune.ai/ontology/finance/foundation/Party';
    role.minCount = 0;
    role.maxCount = null;
  }, 'CorporateActionDueBillObligation.beneficiaryAccount range/cardinality drift');
  expectModuleMutationRejected('event-source-reference-mode-drift', (document) => {
    const target = 'https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionEvent/role/sourceAuthority';
    const binding = document.domain.constraintBindings.find((item) => item.targetElement === target);
    binding.constraintRef = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
  }, 'CorporateActionEvent.sourceAuthority reference mode drift');
  expectModuleMutationRejected('missing-side-unit-field-deleted', (document) => {
    const type = document.domain.associationTypes.MissingSideAssertion;
    type.attributeUses = type.attributeUses.filter((item) => !item.attribute.endsWith('/comparisonQuantityUnit'));
  }, 'MissingSideAssertion missing required attribute comparisonQuantityUnit');
  expectModuleMutationRejected('election-policy-provider-member-relation-deleted', (document) => {
    document.domain.relationUses = document.domain.relationUses.filter((item) => !item.relation.endsWith('/electionPolicyProviderMember'));
  }, 'missing required RelationUse electionPolicyProviderMember');
  expectModuleMutationRejected('election-provider-member-logical-mode-drift', (document) => {
    const target = 'https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionElectionProviderMember/role/eligibleProvider';
    const binding = document.domain.constraintBindings.find((item) => item.targetElement === target);
    binding.constraintRef = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
  }, 'CorporateActionElectionProviderMember.eligibleProvider reference mode drift');
  expectModuleMutationRejected('election-policy-equivalence-field-deleted', (document) => {
    const type = document.domain.objectTypes.CorporateActionElectionProviderPolicy;
    type.attributeUses = type.attributeUses.filter((item) => !item.attribute.endsWith('/electionEquivalenceField'));
  }, 'CorporateActionElectionProviderPolicy missing required attribute electionEquivalenceField');
  expectModuleMutationRejected('election-policy-member-version-digest-deleted', (document) => {
    const type = document.domain.objectTypes.CorporateActionElectionProviderPolicy;
    type.attributeUses = type.attributeUses.filter((item) => !item.attribute.endsWith('/providerMemberVersionSetDigest'));
  }, 'CorporateActionElectionProviderPolicy missing required attribute providerMemberVersionSetDigest');
  expectModuleMutationRejected('distribution-assessment-price-kind-deleted', (document) => {
    const type = document.domain.associationTypes.CorporateActionDistributionSizeAssessment;
    type.attributeUses = type.attributeUses.filter((item) => !item.attribute.endsWith('/priceKind'));
  }, 'CorporateActionDistributionSizeAssessment missing required attribute https://axiolune.ai/ontology/finance/market-data/priceKind');
  expectModuleMutationRejected('distribution-assessment-input-digest-deleted', (document) => {
    const type = document.domain.associationTypes.CorporateActionDistributionSizeAssessment;
    type.attributeUses = type.attributeUses.filter((item) => !item.attribute.endsWith('/assessmentInputVersionSetDigest'));
  }, 'CorporateActionDistributionSizeAssessment missing required attribute assessmentInputVersionSetDigest');
  expectModuleMutationRejected('reconciliation-cross-dimensions-deleted', (document) => {
    const type = document.domain.associationTypes.ReconciliationFinding;
    type.attributeUses = type.attributeUses.filter((item) => !item.attribute.endsWith('/crossMismatchDimension'));
  }, 'ReconciliationFinding missing required attribute crossMismatchDimension');
  expectModuleMutationRejected('custom-contract-deleted', (document) => {
    const constraint = document.domain.constraints.DueBillObligationContract;
    delete document.domain.constraints.DueBillObligationContract;
    document.domain.constraintBindings = document.domain.constraintBindings.filter((item) => item.constraintRef !== constraint.iri);
  }, 'Custom semantic contract inventory drift');
  expectModuleMutationRejected('custom-contract-expression-drift', (document) => {
    document.domain.constraints.DueBillObligationContract.expression.expression = 'return true';
  }, 'PTO_CUSTOM_EXPRESSION_TRIVIAL');
  expectModuleMutationRejected('fabricated-code-list-authority', (document) => {
    document.domain.codeLists.DueBillQualificationResult.sourceEvidenceRef =
      'https://example.test/forged-code-list-authority';
  }, 'PTO_CODE_LIST_EVIDENCE_REF');

  try {
    const [owlA, owlB, shaclA, shaclB] = await Promise.all([
      projectOwl(postTrade), projectOwl(postTrade), projectShacl(postTrade), projectShacl(postTrade),
    ]);
    assert.deepEqual(owlA, owlB, 'OWL projection is not deterministic');
    assert.deepEqual(shaclA, shaclB, 'SHACL projection is not deterministic');
    const owlQuads = new Parser().parse(owlA.toString('utf8'));
    const shaclQuads = new Parser().parse(shaclA.toString('utf8'));
    pass('PROJECTION-FRESH-PTO', `fresh deterministic parseable OWL=${owlQuads.length} quads SHACL=${shaclQuads.length} quads`);
    for (const constraint of moduleResult.xones) {
      const paths = await validateGeneratedXone(shaclQuads, constraint.targetElement, constraint.iri);
      pass(`SHACL-XONE/${constraint.localName}`, `rdf-validate-shacl accepts one and rejects zero/two across ${paths.length} branches`);
    }
    for (const artifact of TRACKED_PROJECTIONS) {
      const fresh = artifact.kind === 'owl' ? owlA : shaclA;
      if (!fs.existsSync(artifact.file)) {
        fail(`PROJECTION-DRIFT-PTO/${artifact.label}`, `tracked artifact is missing: ${artifact.file}`);
        continue;
      }
      const tracked = fs.readFileSync(artifact.file);
      if (fresh.equals(tracked)) {
        pass(`PROJECTION-DRIFT-PTO/${artifact.label}`, `tracked bytes equal fresh ${artifact.kind.toUpperCase()} projection`);
      } else {
        fail(
          `PROJECTION-DRIFT-PTO/${artifact.label}`,
          `fresh=${crypto.createHash('sha256').update(fresh).digest('hex')} tracked=${crypto.createHash('sha256').update(tracked).digest('hex')}`,
        );
      }
    }
  } catch (error) {
    fail('PROJECTION-FRESH-PTO', error.stack || error.message);
  }

  // The executable contract never consumes the private flat source fixture
  // directly. A byte- and JCS-locked overlay first migrates authored records
  // into exact-IRI envelopes; the coverage audit then fails or pends closed;
  // finally an explicit adapter reconstructs the legacy validator payload and
  // proves whole-document semantic equivalence to the locked source digest.
  let positive = null;
  try {
    const sourceFixtureRef = path.relative(ROOT, POSITIVE_FILE).split(path.sep).join('/');
    const sourceBytes = fs.readFileSync(POSITIVE_FILE);
    const sourceDocument = loadYaml(POSITIVE_FILE);
    const overlay = JSON.parse(fs.readFileSync(TYPED_OVERLAY_FILE, 'utf8'));
    const classificationBytes = fs.readFileSync(NON_RECORD_CLASSIFICATION_FILE);
    const classification = JSON.parse(classificationBytes.toString('utf8'));
    const patternDocument = loadYaml(PATTERN_FILE);
    const financeOntologyDocuments = fs.readdirSync(path.join(ROOT, 'ontology', 'domain', 'finance'))
      .sort()
      .map((moduleName) => path.join(ROOT, 'ontology', 'domain', 'finance', moduleName, 'module.yaml'))
      .filter((moduleFile) => fs.existsSync(moduleFile))
      .map((moduleFile) => loadYaml(moduleFile));
    const financeOntologyClosure = mergeFinanceOntologyDocuments(financeOntologyDocuments);

    const classificationRef = path.relative(ROOT, NON_RECORD_CLASSIFICATION_FILE).split(path.sep).join('/');
    const extractorProfileRef = {
      kind: 'path',
      root: 'sourceTree',
      path: path.relative(ROOT, TYPED_BUILDER_FILE).split(path.sep).join('/'),
    };
    const extractorProfileBytes = fs.readFileSync(TYPED_BUILDER_FILE);
    validateCanonicalTypedFixtureManifest({
      manifestDocument: overlay,
      sourceFixtureRef,
      sourceBytes,
      sourceDocument,
      classificationRef,
      classificationBytes,
      extractorProfileRef,
      extractorProfileBytes,
    });

    const sourceCoverage = auditPostTradeFixtureOntologyCoverage({
      ontologyDocument: postTrade,
      patternDocument,
      fixtureDocument: sourceDocument,
      fixtureRef: sourceFixtureRef,
    });
    if (
      sourceCoverage.errorCount !== 0
      || sourceCoverage.typedRecordCount !== 0
      || sourceCoverage.untypedRecordCandidateCount !== overlay.expected.sourceHeuristicCandidateCount
    ) {
      fail(
        'FIXTURE-SOURCE-INVENTORY-PTO',
        `expected locked source inventory typed=0 candidates=${overlay.expected.sourceHeuristicCandidateCount}; got errors=${sourceCoverage.errorCount} typed=${sourceCoverage.typedRecordCount} candidates=${sourceCoverage.untypedRecordCandidateCount}`,
      );
    } else {
      pass(
        'FIXTURE-SOURCE-INVENTORY-PTO',
        `locked source inventory contains exactly ${sourceCoverage.untypedRecordCandidateCount} record-like migration candidates`,
      );
    }

    const migrated = buildPostTradeCanonicalTypedFixture({
      sourceDocument,
      sourceFixtureRef,
      sourceBytes,
      ontologyDocument: financeOntologyClosure,
      patternDocument,
      classificationDocument: classification,
      extractorProfileRef,
      extractorProfileDigest: overlay.extractorProfileDigest,
    });
    assertCanonicalTypedFixtureBuildMatchesManifest(overlay, migrated);
    const coverage = auditPostTradeFixtureOntologyCoverage({
      ontologyDocument: financeOntologyClosure,
      patternDocument,
      fixtureDocument: migrated.document,
      fixtureRef: `${sourceFixtureRef}#canonical-typed`,
    });
    if (
      coverage.errorCount !== 0
      || coverage.status !== 'diagnostic-conformant'
      || !coverage.coverageComplete
      || coverage.typedRecordCount !== overlay.expected.typedRecordCount
      || coverage.untypedRecordCandidateCount !== 0
      || migrated.summary.classifiedNonRecordCount !== overlay.expected.classifiedNonRecordCount
      || migrated.summary.unresolvedCount !== 0
      || migrated.summary.extraClaimCount !== 0
    ) {
      fail(
        'FIXTURE-ONTOLOGY-COVERAGE-PTO',
        `required typed=${overlay.expected.typedRecordCount} classifiedNonRecord=${overlay.expected.classifiedNonRecordCount} unresolved=0 extra=0; got status=${coverage.status} errors=${coverage.errorCount} typed=${coverage.typedRecordCount} untyped=${coverage.untypedRecordCandidateCount} classifiedNonRecord=${migrated.summary.classifiedNonRecordCount} unresolved=${migrated.summary.unresolvedCount} extra=${migrated.summary.extraClaimCount}`,
      );
    } else {
      pass(
        'FIXTURE-ONTOLOGY-COVERAGE-PTO',
        `closed inventory: ${coverage.typedRecordCount}/${overlay.expected.typedRecordCount} exact-IRI ontology record occurrences, ${migrated.summary.classifiedNonRecordCount}/${overlay.expected.classifiedNonRecordCount} digest-locked non-records, 0 unresolved/extra`,
      );
    }

    const normalized = normalizePostTradeCanonicalTypedFixture(
      migrated.document,
      migrated.adapterPlan,
      {
        expectedDocumentDigest: overlay.sourceDocumentDigest,
      },
    );
    positive = normalized.document;
    pass(
      'FIXTURE-NORMALIZATION-PTO',
      `${migrated.summary.typedRecordCount} typed record occurrences normalize to locked source semantics ${normalized.normalizedDocumentDigest}`,
    );
    try {
      const releaseEvidence = validateFixtureReleaseEvidence();
      pass(
        'FIXTURE-TYPED-DERIVATIONS-PTO',
        `${releaseEvidence.diagnosticTypedAdapter.derivationCount} deterministic typed enrichments are `
          + `machine-quarantined diagnostic-only with ${releaseEvidence.diagnosticTypedAdapter.boundDerivationOverlapCount} `
          + `source-semantic binding overlap; release fixture evidence instead executes `
          + `${releaseEvidence.canonicalRuntime.customRuntimeEvidence.discoveredConstraints.length} Custom bindings, `
          + `${releaseEvidence.canonicalRuntime.positiveFixtureCount}/${releaseEvidence.canonicalRuntime.negativeFixtureCount} `
          + `canonical positive/negative fixtures, ${releaseEvidence.shacl.resultCount} SHACL branch checks, and exact normalization`,
      );
    } catch (error) {
      fail('FIXTURE-TYPED-DERIVATIONS-PTO', error.stack || error.message);
    }
  } catch (error) {
    fail('FIXTURE-TYPED-MIGRATION-PTO', `${error.code || error.message}: ${error.message}`);
  }

  const byId = new Map((positive?.fixtures || []).map((fixture) => [fixture.id, fixture]));
  for (const fixture of positive?.fixtures || []) {
    try {
      validateScenario(fixture);
      pass(`FIXTURE+/${fixture.id}`, 'accepted by executable RFC v0.3 contract');
    } catch (error) {
      fail(`FIXTURE+/${fixture.id}`, `unexpected ${error.code || error.message}`);
    }
  }

  // A correction that is not yet visible at the Case knowledge/availability
  // pivots must not erase its still-current predecessor. This is a positive
  // historical-query regression, not a rejection test.
  try {
    const base = byId.get('economic-allocation-projection-and-closed-finding-matrix');
    const historical = structuredClone(base);
    const predecessor = historical.instance.allocations.find((item) => item.versionIri.endsWith('/rec-1/v2'));
    historical.instance.allocations.push({
      ...structuredClone(predecessor),
      versionIri: 'https://example.test/fact/allocation/rec-1/v3-future',
      supersedesVersionIri: predecessor.versionIri,
      knowledgeFrom: '2026-07-16T00:00:01Z',
      availableFrom: '2026-07-16T00:01:01Z',
    });
    validateScenario(historical);
    pass('FIXTURE+/reconciliation-future-correction-preserves-visible-predecessor', 'future correction is excluded before current-version resolution at Case pivots');
  } catch (error) {
    fail('FIXTURE+/reconciliation-future-correction-preserves-visible-predecessor', `unexpected ${error.code || error.message}`);
  }

  try {
    const base = byId.get('rights-election-subscription-adjustment-chain');
    const historical = structuredClone(base);
    const predecessor = historical.instance.fulfillments.find((item) => item.assetKind === 'cashPayment');
    historical.instance.fulfillments.push({
      ...structuredClone(predecessor),
      versionIri: 'https://example.test/fact/subscription-fulfillment/cash/v2-future',
      supersedesVersionIri: predecessor.versionIri,
      knowledgeFrom: '2026-07-13T00:00:01Z',
      availableFrom: '2026-07-13T00:00:01Z',
    });
    validateScenario(historical);
    pass('FIXTURE+/rights-future-fulfillment-correction-preserves-visible-predecessor', 'future fulfillment correction is excluded before current-version resolution at fulfillment pivots');
  } catch (error) {
    fail('FIXTURE+/rights-future-fulfillment-correction-preserves-visible-predecessor', `unexpected ${error.code || error.message}`);
  }

  const negative = loadYaml(NEGATIVE_FILE);
  for (const testCase of negative.cases || []) {
    const base = byId.get(testCase.baseFixtureId);
    if (!base) {
      fail(`FIXTURE-/${testCase.id}`, `unknown base fixture ${testCase.baseFixtureId}`);
      continue;
    }
    let instance = base.instance;
    try {
      for (const mutation of testCase.mutations || []) instance = mutate(instance, mutation);
      validateScenario({ ...base, instance });
      fail(`FIXTURE-/${testCase.id}`, 'unexpected acceptance');
    } catch (error) {
      if (error.code === testCase.expectedViolation) {
        pass(`FIXTURE-/${testCase.id}`, `rejected with ${error.code}`);
      } else {
        fail(`FIXTURE-/${testCase.id}`, `expected ${testCase.expectedViolation}, got ${error.code || error.message}`);
      }
    }
  }

  try {
    const runtime = validateCustomRuntime();
    pass(
      'CUSTOM-RUNTIME-PTO',
      `${runtime.constraints} exact constraint/target/expression/implementation bindings executed `
        + `${runtime.vectors} accepted, violation, tamper, unknown, timeout, and size-cap vectors; `
        + `the digest-bound focused corpus replayed ${runtime.regression} cases`,
    );
  } catch (error) {
    fail('CUSTOM-RUNTIME-PTO', error.stack || error.message);
  }
  console.log(`\npost-trade v0.3 targeted checks: ${passed} passed, ${failed} failed, ${pending} pending`);
  process.exitCode = failed > 0 ? 1 : pending > 0 ? 2 : 0;
}

main().catch((error) => {
  fail('UNCAUGHT', error.stack || error.message);
  process.exitCode = 1;
});
