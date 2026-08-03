'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DataFactory, Parser, Store } = require('n3');
const SHACLValidator = require('rdf-validate-shacl').default;
const YAML = require('yaml');
const {
  projectShacl,
} = require('../generate-m2-shacl.cjs');
const {
  createEvidence: createCustomRuntimeEvidence,
} = require('../run-post-trade-custom-runtime.cjs');
const {
  PATHS: CUSTOM_PATHS,
} = require('./post-trade-custom-profile.cjs');
const {
  assertCanonicalTypedFixtureBuildMatchesManifest,
  buildPostTradeCanonicalTypedFixture,
  mergeFinanceOntologyDocuments,
  normalizePostTradeCanonicalTypedFixture,
  validateCanonicalTypedFixtureManifest,
} = require('./post-trade-canonical-envelope-builder.cjs');
const {
  auditPostTradeFixtureOntologyCoverage,
} = require('./post-trade-fixture-ontology-coverage.cjs');
const {
  canonicalJcs,
} = require('./strict-source-locator.cjs');

const { namedNode, quad } = DataFactory;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE = 'axiolune-post-trade-fixture-release-evidence/v1';
const PATHS = Object.freeze({
  boundaryImplementation: __filename,
  boundaryRunner: path.join(ROOT, 'scripts', 'domain', 'run-post-trade-fixture-release-evidence.cjs'),
  builder: path.join(ROOT, 'scripts', 'domain', 'lib', 'post-trade-canonical-envelope-builder.cjs'),
  coverageImplementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'post-trade-fixture-ontology-coverage.cjs'),
  classification: path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'post-trade-non-record-classifications.json'),
  diagnosticManifest: path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'post-trade-typed-envelope-overlay.json'),
  module: path.join(ROOT, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.yaml'),
  negative: path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'post-trade-closure-reconciliation-negative.yaml'),
  pattern: path.join(ROOT, 'ontology', 'meta', 'cross-domain-patterns.yaml'),
  patternProfile: path.join(ROOT, 'scripts', 'domain', 'lib', 'pattern-injected-fields.cjs'),
  positive: path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'post-trade-closure-reconciliation.yaml'),
  processingFindingNegative: path.join(
    ROOT, 'tests', 'm2', 'fixtures', 'post-trade-processing-finding', 'negative.yaml',
  ),
  processingFindingPositive: path.join(
    ROOT, 'tests', 'm2', 'fixtures', 'post-trade-processing-finding', 'positive.yaml',
  ),
});
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
const SH = 'http://www.w3.org/ns/shacl#';
const FACT_IDENTITY = 'https://axiolune.ai/ontology/meta/data-binding/FactIdentity';
const FACT_VERSION = 'https://axiolune.ai/ontology/meta/data-binding/FactVersion';
const VERSION_OF = 'https://axiolune.ai/ontology/meta/data-binding/properties/versionOf';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function ref(file) {
  return {
    kind: 'path',
    path: path.relative(ROOT, file).split(path.sep).join('/'),
    root: 'sourceTree',
  };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an unknown or missing field`);
  }
}

function resolveRef(artifactRef, label) {
  exactKeys(artifactRef, ['kind', 'path', 'root'], label);
  if (artifactRef.kind !== 'path' || artifactRef.root !== 'sourceTree'
      || typeof artifactRef.path !== 'string' || path.isAbsolute(artifactRef.path)
      || artifactRef.path.includes('\\') || artifactRef.path.split('/').includes('..')) {
    throw new TypeError(`${label} is not a closed sourceTree path`);
  }
  const file = path.resolve(ROOT, ...artifactRef.path.split('/'));
  const relative = path.relative(ROOT, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`${label} escapes the source tree`);
  }
  return file;
}

function parseYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function artifactRows() {
  return [
    ['boundaryImplementation', PATHS.boundaryImplementation],
    ['boundaryRunner', PATHS.boundaryRunner],
    ['canonicalVectors', CUSTOM_PATHS.vectors],
    ['classification', PATHS.classification],
    ['coverageImplementation', PATHS.coverageImplementation],
    ['customClosure', CUSTOM_PATHS.closure],
    ['customDiscovery', CUSTOM_PATHS.discovery],
    ['customImplementation', CUSTOM_PATHS.implementation],
    ['customWorker', CUSTOM_PATHS.worker],
    ['diagnosticBuilder', PATHS.builder],
    ['diagnosticManifest', PATHS.diagnosticManifest],
    ['negativeFixtures', PATHS.negative],
    ['ontologyModule', PATHS.module],
    ['patternModule', PATHS.pattern],
    ['patternProfile', PATHS.patternProfile],
    ['positiveFixtures', PATHS.positive],
    ['processingFindingNegativeFixtures', PATHS.processingFindingNegative],
    ['processingFindingPositiveFixtures', PATHS.processingFindingPositive],
  ].map(([role, file]) => ({ digest: sha256(fs.readFileSync(file)), ref: ref(file), role }))
    .sort((left, right) => compareUtf8(left.ref.path, right.ref.path));
}

function auditDiagnosticDerivationQuarantine(built) {
  if (!built || built.summary?.requiredSyntheticDerivationCount !== 814
      || built.derivations?.length !== 814
      || built.summary?.approvalEligible !== false
      || built.summary?.releaseEvidence !== false) {
    throw new Error('diagnostic typed adapter classification/count drift');
  }
  const derivationKeys = built.derivations.map(
    (row) => `${row.sourcePointer}\0${row.propertyIri}`,
  );
  if (new Set(derivationKeys).size !== derivationKeys.length) {
    throw new Error('diagnostic typed derivation identity is not unique');
  }
  const sourceBoundKeys = new Set();
  for (const mapping of built.adapterPlan?.records || []) {
    for (const binding of mapping.bindings || []) {
      if (typeof binding.propertyIri === 'string') {
        sourceBoundKeys.add(`${mapping.sourcePointer}\0${binding.propertyIri}`);
      }
    }
  }
  const overlap = derivationKeys.filter((key) => sourceBoundKeys.has(key));
  if (overlap.length > 0) {
    throw new Error(`diagnostic derivation leaked into source-semantic adapter bindings (${overlap.length})`);
  }
  const kinds = Object.fromEntries(
    [...new Set(built.derivations.map((row) => row.kind))]
      .sort(compareUtf8)
      .map((kind) => [kind, built.derivations.filter((row) => row.kind === kind).length]),
  );
  if (canonicalJcs(kinds) !== canonicalJcs({
    requiredAttribute: 671,
    requiredRole: 138,
    semanticBranchAttribute: 1,
    semanticBranchRole: 4,
  })) {
    throw new Error('diagnostic typed derivation-kind inventory drift');
  }
  return {
    boundDerivationOverlapCount: 0,
    derivationCount: derivationKeys.length,
    derivationIdentitySetDigest: sha256(jcsBytes([...derivationKeys].sort(compareUtf8))),
    derivationKinds: kinds,
    releaseEvidence: false,
  };
}

function object(source, subject, predicate) {
  return source.getQuads(subject, namedNode(predicate), null, null)[0]?.object;
}

function extractXone(shaclQuads, targetClass, constraintIri) {
  const source = new Store(shaclQuads);
  const shapes = new Store();
  const targetShape = namedNode(`${targetClass}Shape`);
  const constraintShape = namedNode(`${constraintIri}/shape`);
  shapes.addQuad(quad(targetShape, namedNode(RDF_TYPE), namedNode(`${SH}NodeShape`)));
  shapes.addQuad(quad(targetShape, namedNode(`${SH}targetClass`), namedNode(targetClass)));
  shapes.addQuad(quad(targetShape, namedNode(`${SH}node`), constraintShape));
  const queue = [constraintShape];
  const visited = new Set();
  while (queue.length > 0) {
    const subject = queue.shift();
    const key = `${subject.termType}\0${subject.value}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const statement of source.getQuads(subject, null, null, null)) {
      shapes.addQuad(statement);
      if (statement.object.termType === 'BlankNode'
          || (statement.object.termType === 'NamedNode' && statement.object.value.startsWith(constraintIri))) {
        queue.push(statement.object);
      }
    }
  }
  const paths = [];
  let cursor = object(source, constraintShape, `${SH}xone`);
  if (!cursor) throw new Error(`${constraintIri} has no generated sh:xone list`);
  const seen = new Set();
  while (cursor.value !== RDF_NIL) {
    if (seen.has(cursor.value)) throw new Error(`${constraintIri} has a cyclic sh:xone list`);
    seen.add(cursor.value);
    const branch = object(source, cursor, RDF_FIRST);
    const propertyShape = branch && object(source, branch, `${SH}property`);
    const propertyPath = propertyShape && object(source, propertyShape, `${SH}path`);
    if (propertyPath?.termType !== 'NamedNode') throw new Error(`${constraintIri} branch path is not a named IRI`);
    paths.push(propertyPath.value);
    cursor = object(source, cursor, RDF_REST);
    if (!cursor) throw new Error(`${constraintIri} sh:xone list misses rdf:rest`);
  }
  if (paths.length < 2) throw new Error(`${constraintIri} must expose at least two sh:xone branches`);
  return { paths, shapes };
}

function extractPropertyShape(shaclQuads, targetClass, predicate) {
  const source = new Store(shaclQuads);
  const shapes = new Store();
  const sourceTargetShape = namedNode(`${targetClass}Shape`);
  const propertyShapes = source.getQuads(
    sourceTargetShape, namedNode(`${SH}property`), null, null,
  ).map((statement) => statement.object);
  const selected = propertyShapes.filter(
    (propertyShape) => object(source, propertyShape, `${SH}path`)?.value === predicate,
  );
  if (selected.length !== 1) {
    throw new Error(`${targetClass} must expose exactly one generated property shape for ${predicate}`);
  }
  const targetShape = namedNode(`${targetClass}/fixture-release/property-shape`);
  shapes.addQuad(quad(targetShape, namedNode(RDF_TYPE), namedNode(`${SH}NodeShape`)));
  shapes.addQuad(quad(targetShape, namedNode(`${SH}targetClass`), namedNode(targetClass)));
  shapes.addQuad(quad(targetShape, namedNode(`${SH}property`), selected[0]));
  const queue = [selected[0]];
  const visited = new Set();
  while (queue.length > 0) {
    const subject = queue.shift();
    const key = `${subject.termType}\0${subject.value}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const statement of source.getQuads(subject, null, null, null)) {
      shapes.addQuad(statement);
      if (statement.object.termType === 'BlankNode') {
        queue.push(statement.object);
      } else if (statement.object.termType === 'NamedNode'
          && source.countQuads(
            statement.object,
            namedNode(RDF_TYPE),
            namedNode(`${SH}NodeShape`),
            null,
          ) === 1) {
        // Exact/logical reference constraints are compiled as named nested
        // NodeShapes. Include their complete closure instead of testing only
        // the outer cardinality property shape.
        queue.push(statement.object);
      }
    }
  }
  return shapes;
}

async function executeShaclXoneEvidence(moduleDocument, projectionOverride = null) {
  const projection = projectionOverride || await projectShacl(moduleDocument);
  const shaclQuads = new Parser().parse(projection.toString('utf8'));
  const constraints = Object.values(moduleDocument.domain?.constraints || {})
    .filter((constraint) => constraint.expression?.language === 'SHACL')
    .sort((left, right) => compareUtf8(left.iri, right.iri));
  if (constraints.length !== 21) throw new Error(`post-trade SHACL xone inventory must be 21, got ${constraints.length}`);
  const results = [];
  for (const constraint of constraints) {
    const { paths, shapes } = extractXone(shaclQuads, constraint.targetElement, constraint.iri);
    const validator = new SHACLValidator(shapes);
    const graph = (selected) => {
      const focus = namedNode(`urn:axiolune:fixture-release:${constraint.localName}`);
      const store = new Store([quad(focus, namedNode(RDF_TYPE), namedNode(constraint.targetElement))]);
      for (const predicate of selected) {
        store.addQuad(quad(focus, namedNode(predicate), namedNode(`urn:axiolune:value:${paths.indexOf(predicate)}`)));
      }
      return store;
    };
    for (const [caseKind, selected, expected] of [
      ['one-branch', [paths[0]], true],
      ['zero-branch', [], false],
      ['two-branch', paths.slice(0, 2), false],
    ]) {
      const actual = (await validator.validate(graph(selected))).conforms;
      if (actual !== expected) throw new Error(`${constraint.iri}/${caseKind} expected conforms=${expected}, got ${actual}`);
      results.push({
        actualConforms: actual,
        caseId: `${constraint.localName}/${caseKind}`,
        constraintIri: constraint.iri,
        expectedConforms: expected,
        status: 'passed',
      });
    }
  }
  const processingConstraint = constraints.find((row) => row.localName === 'ProcessingFindingStageXone');
  if (!processingConstraint) throw new Error('ProcessingFindingStageXone is absent from the generated SHACL inventory');
  const processing = extractXone(
    shaclQuads, processingConstraint.targetElement, processingConstraint.iri,
  );
  if (processing.paths.length !== 3) {
    throw new Error(`ProcessingFindingStageXone must expose three branches, got ${processing.paths.length}`);
  }
  const pathByField = new Map([
    ['scheduleSubjectVersionIri', `${processingConstraint.targetElement}/role/scheduleSubject`],
    ['entitlementSubjectVersionIri', `${processingConstraint.targetElement}/role/entitlementSubject`],
    ['dueBillSubjectVersionIri', `${processingConstraint.targetElement}/role/dueBillSubject`],
  ]);
  if ([...pathByField.values()].some((predicate) => !processing.paths.includes(predicate))) {
    throw new Error('ProcessingFindingStageXone generated paths drifted from the canonical entity roles');
  }
  const fixture = parseYaml(PATHS.processingFindingPositive).fixture;
  if (fixture?.contract !== 'CorporateActionProcessingFinding'
      || fixture.instance?.findings?.length !== 3) {
    throw new Error('processing-finding SHACL source fixture inventory drift');
  }
  const processingValidator = new SHACLValidator(processing.shapes);
  const processingFindingEntityResults = [];
  const graph = (finding, selected) => {
    const focus = namedNode(finding.versionIri);
    const store = new Store([
      quad(focus, namedNode(RDF_TYPE), namedNode(processingConstraint.targetElement)),
    ]);
    for (const predicate of selected) {
      const field = [...pathByField].find(([, value]) => value === predicate)?.[0];
      const objectIri = finding[field]
        || `https://example.test/fact/corporate-action/shacl-extra/${predicate.split('/').at(-1)}/v1`;
      store.addQuad(quad(focus, namedNode(predicate), namedNode(objectIri)));
    }
    return store;
  };
  for (const finding of fixture.instance.findings) {
    const selected = [...pathByField]
      .filter(([field]) => Object.prototype.hasOwnProperty.call(finding, field))
      .map(([, predicate]) => predicate);
    if (selected.length !== 1) throw new Error(`${finding.versionIri} is not a canonical one-stage finding fixture`);
    const actual = (await processingValidator.validate(graph(finding, selected))).conforms;
    if (!actual) throw new Error(`${finding.versionIri} failed its generated ProcessingFindingStageXone shape`);
    processingFindingEntityResults.push({
      actualConforms: actual,
      caseId: `processing-finding-entity/${finding.findingStage}/${finding.processingFindingKind}`,
      expectedConforms: true,
      findingVersionIri: finding.versionIri,
      status: 'passed',
    });
  }
  const seedFinding = fixture.instance.findings[0];
  for (const [caseKind, selected] of [
    ['stage-subject-is-required', []],
    ['stage-subject-is-exclusive', processing.paths.slice(0, 2)],
  ]) {
    const actual = (await processingValidator.validate(graph(seedFinding, selected))).conforms;
    if (actual) throw new Error(`processing-finding entity ${caseKind} unexpectedly conformed`);
    processingFindingEntityResults.push({
      actualConforms: actual,
      caseId: `processing-finding-entity/${caseKind}`,
      expectedConforms: false,
      findingVersionIri: seedFinding.versionIri,
      status: 'passed',
    });
  }
  const relatedEntitlementPredicate = `${processingConstraint.targetElement}/role/relatedEntitlement`;
  const relatedEntitlementValidator = new SHACLValidator(extractPropertyShape(
    shaclQuads, processingConstraint.targetElement, relatedEntitlementPredicate,
  ));
  const dueBillFinding = fixture.instance.findings.find((finding) => finding.findingStage === 'dueBill');
  const relatedEntitlementIri = dueBillFinding?.relatedEntitlementVersionIri;
  if (!relatedEntitlementIri) {
    throw new Error('canonical due-bill processing finding omits relatedEntitlementVersionIri');
  }
  const relatedEntitlementRoleResults = [];
  const roleGraph = (values) => {
    const focus = namedNode(dueBillFinding.versionIri);
    const store = new Store([
      quad(focus, namedNode(RDF_TYPE), namedNode(processingConstraint.targetElement)),
    ]);
    for (const [iri, type] of values) {
      const target = namedNode(iri);
      const identity = namedNode(`${iri}/identity`);
      store.addQuad(quad(focus, namedNode(relatedEntitlementPredicate), target));
      store.addQuad(quad(target, namedNode(RDF_TYPE), namedNode(`${processingConstraint.targetElement
        .slice(0, processingConstraint.targetElement.lastIndexOf('/') + 1)}${type}`)));
      store.addQuad(quad(target, namedNode(RDF_TYPE), namedNode(FACT_VERSION)));
      store.addQuad(quad(target, namedNode(VERSION_OF), identity));
      store.addQuad(quad(identity, namedNode(RDF_TYPE), namedNode(FACT_IDENTITY)));
    }
    return store;
  };
  for (const [caseKind, values, expected] of [
    ['optional-zero', [], true],
    ['one-exact-entitlement', [[relatedEntitlementIri, 'CorporateActionEntitlement']], true],
    ['max-count-one', [
      [relatedEntitlementIri, 'CorporateActionEntitlement'],
      ['https://example.test/fact/corporate-action/entitlement/pf-1/v2', 'CorporateActionEntitlement'],
    ], false],
    ['range-is-entitlement', [[relatedEntitlementIri, 'CorporateActionElection']], false],
  ]) {
    const actual = (await relatedEntitlementValidator.validate(roleGraph(values))).conforms;
    if (actual !== expected) {
      throw new Error(`processing-finding relatedEntitlement/${caseKind} expected ${expected}, got ${actual}`);
    }
    relatedEntitlementRoleResults.push({
      actualConforms: actual,
      caseId: `processing-finding-related-entitlement/${caseKind}`,
      expectedConforms: expected,
      status: 'passed',
    });
  }
  return {
    constraintCount: constraints.length,
    processingFindingEntityResultCount: processingFindingEntityResults.length,
    processingFindingEntityResults,
    projectionDigest: sha256(projection),
    relatedEntitlementRoleResultCount: relatedEntitlementRoleResults.length,
    relatedEntitlementRoleResults,
    resultCount: results.length,
    results,
  };
}

function verifyPostTradeFixtureReleaseEvidence(evidence) {
  exactKeys(evidence, [
    'artifacts', 'canonicalRuntime', 'classification', 'diagnosticTypedAdapter',
    'normalization', 'outcome', 'profile', 'schemaVersion', 'shacl',
  ], 'fixture release evidence');
  if (evidence.schemaVersion !== '1.0' || evidence.profile !== PROFILE || evidence.outcome !== 'passed') {
    throw new Error('fixture release evidence identity/outcome drift');
  }
  if (evidence.classification?.fixtureReleaseEvidenceEligible !== true
      || evidence.classification?.m2ConformanceOnly !== true
      || evidence.classification?.productionDataEligible !== false
      || evidence.classification?.syntheticFixture !== true
      || evidence.classification?.typedEnvelopeReleaseEvidence !== false) {
    throw new Error('fixture release evidence classification drift');
  }
  const expectedArtifacts = artifactRows();
  if (canonicalJcs(evidence.artifacts) !== canonicalJcs(expectedArtifacts)) {
    throw new Error('fixture release evidence artifact closure drift');
  }
  for (const [index, row] of evidence.artifacts.entries()) {
    const file = resolveRef(row.ref, `artifacts[${index}].ref`);
    if (sha256(fs.readFileSync(file)) !== row.digest) throw new Error(`fixture release artifact digest drift: ${row.role}`);
  }
  const custom = evidence.canonicalRuntime?.customRuntimeEvidence;
  if (sha256(jcsBytes(custom)) !== evidence.canonicalRuntime?.customRuntimeEvidenceDigest
      || custom?.outcome !== 'passed' || custom?.componentEligible !== true
      || custom?.discoveredConstraints?.length !== 31
      || custom?.vectorResults?.length !== 68
      || custom?.focusedRegressionResults?.length !== 242
      || custom?.dispatchAttributionResults?.length !== 29
      || !custom.vectorResults.every((row) => row.status === 'passed')
      || !custom.focusedRegressionResults.every((row) => row.status === 'passed')
      || !custom.dispatchAttributionResults.every((row) => row.status === 'passed'
        && ((row.actual === 'notApplicable' && row.observedViolationOwner)
          || (row.actual === 'WORKER_EXIT' && row.expected === 'WORKER_EXIT')))) {
    throw new Error('canonical focused runtime evidence is incomplete or tampered');
  }
  if (evidence.canonicalRuntime?.selectedAcceptedViolationCount !== 62
      || evidence.canonicalRuntime?.positiveFixtureCount !== 8
      || evidence.canonicalRuntime?.negativeFixtureCount !== 219
      || evidence.canonicalRuntime?.processingFindingPositiveFixtureCount !== 1
      || evidence.canonicalRuntime?.processingFindingNegativeFixtureCount !== 14) {
    throw new Error('canonical focused runtime fixture counts drift');
  }
  if (evidence.diagnosticTypedAdapter?.releaseEvidence !== false
      || evidence.diagnosticTypedAdapter?.boundDerivationOverlapCount !== 0
      || evidence.diagnosticTypedAdapter?.derivationCount !== 814) {
    throw new Error('diagnostic typed derivation quarantine drift');
  }
  if (evidence.normalization?.exactSourceRoundTrip !== true
      || evidence.normalization?.normalizedDocumentDigest !== evidence.normalization?.sourceDocumentDigest) {
    throw new Error('diagnostic typed normalization no longer round-trips exact source semantics');
  }
  if (evidence.shacl?.constraintCount !== 21 || evidence.shacl?.resultCount !== 63
      || evidence.shacl?.processingFindingEntityResultCount !== 5
      || evidence.shacl?.relatedEntitlementRoleResultCount !== 4
      || !evidence.shacl.results.every((row) => row.status === 'passed')
      || !evidence.shacl.processingFindingEntityResults.every((row) => (
        row.status === 'passed' && row.actualConforms === row.expectedConforms
      ))
      || !evidence.shacl.relatedEntitlementRoleResults.every((row) => (
        row.status === 'passed' && row.actualConforms === row.expectedConforms
      ))) {
    throw new Error('SHACL xone execution evidence is incomplete or tampered');
  }
  return evidence;
}

async function createPostTradeFixtureReleaseEvidence(options = {}) {
  const sourceBytes = fs.readFileSync(PATHS.positive);
  const sourceDocument = options.sourceDocumentOverride || parseYaml(PATHS.positive);
  const negativeDocument = parseYaml(PATHS.negative);
  const negativeBytes = fs.readFileSync(PATHS.negative);
  const manifest = JSON.parse(fs.readFileSync(PATHS.diagnosticManifest, 'utf8'));
  const classificationBytes = fs.readFileSync(PATHS.classification);
  const classification = JSON.parse(classificationBytes.toString('utf8'));
  const processingFindingPositiveDocument = parseYaml(PATHS.processingFindingPositive);
  const processingFindingNegativeDocument = parseYaml(PATHS.processingFindingNegative);
  const patternDocument = parseYaml(PATHS.pattern);
  const financeDocuments = fs.readdirSync(path.join(ROOT, 'ontology', 'domain', 'finance'))
    .sort(compareUtf8)
    .map((name) => path.join(ROOT, 'ontology', 'domain', 'finance', name, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .map(parseYaml);
  const ontologyClosure = mergeFinanceOntologyDocuments(financeDocuments);
  const sourceFixtureRef = path.relative(ROOT, PATHS.positive).split(path.sep).join('/');
  const classificationRef = path.relative(ROOT, PATHS.classification).split(path.sep).join('/');
  const extractorProfileRef = ref(PATHS.builder);
  const builderBytes = fs.readFileSync(PATHS.builder);
  validateCanonicalTypedFixtureManifest({
    manifestDocument: manifest,
    sourceFixtureRef,
    sourceBytes,
    sourceDocument,
    classificationRef,
    classificationBytes,
    extractorProfileRef,
    extractorProfileBytes: builderBytes,
  });
  const built = options.builtOverride || buildPostTradeCanonicalTypedFixture({
    sourceDocument,
    sourceFixtureRef,
    sourceBytes,
    ontologyDocument: ontologyClosure,
    patternDocument,
    classificationDocument: classification,
    extractorProfileRef,
    extractorProfileDigest: manifest.extractorProfileDigest,
  });
  assertCanonicalTypedFixtureBuildMatchesManifest(manifest, built);
  const coverage = auditPostTradeFixtureOntologyCoverage({
    ontologyDocument: ontologyClosure,
    patternDocument,
    fixtureDocument: built.document,
    fixtureRef: `${sourceFixtureRef}#diagnostic-canonical-typed`,
  });
  if (coverage.status !== 'diagnostic-conformant' || coverage.errorCount !== 0
      || coverage.pendingCount !== 0 || coverage.typedRecordCount !== 146
      || coverage.untypedRecordCandidateCount !== 0
      || coverage.releaseEvidence !== false || coverage.approvalEligible !== false) {
    throw new Error('diagnostic typed ontology coverage is not closed and quarantined');
  }
  const quarantine = auditDiagnosticDerivationQuarantine(built);
  const normalized = normalizePostTradeCanonicalTypedFixture(built.document, built.adapterPlan, {
    expectedDocumentDigest: manifest.sourceDocumentDigest,
  });
  if (canonicalJcs(normalized.document) !== canonicalJcs(sourceDocument)) {
    throw new Error('diagnostic typed normalization differs from exact source semantics');
  }

  const customRuntimeEvidence = options.customRuntimeEvidenceOverride || createCustomRuntimeEvidence();
  const shacl = await executeShaclXoneEvidence(
    options.moduleOverride || parseYaml(PATHS.module),
    options.shaclProjectionOverride || null,
  );
  const evidence = {
    artifacts: artifactRows(),
    canonicalRuntime: {
      customRuntimeEvidence,
      customRuntimeEvidenceDigest: sha256(jcsBytes(customRuntimeEvidence)),
      negativeFixtureCount: negativeDocument.cases?.length || 0,
      positiveFixtureCount: sourceDocument.fixtures?.length || 0,
      processingFindingNegativeFixtureCount: processingFindingNegativeDocument.cases?.length || 0,
      processingFindingPositiveFixtureCount: processingFindingPositiveDocument.fixture ? 1 : 0,
      selectedAcceptedViolationCount: customRuntimeEvidence.vectorResults
        .filter((row) => ['accepted', 'violation'].includes(row.category)).length,
    },
    classification: {
      fixtureReleaseEvidenceEligible: true,
      m2ConformanceOnly: true,
      productionDataEligible: false,
      syntheticFixture: true,
      typedEnvelopeReleaseEvidence: false,
    },
    diagnosticTypedAdapter: {
      ...quarantine,
      approvalEligible: false,
      coverageDiagnosticDigest: coverage.diagnosticDigest,
      coverageStatus: coverage.status,
      typedRecordCount: coverage.typedRecordCount,
    },
    normalization: {
      exactSourceRoundTrip: true,
      normalizedDocumentDigest: normalized.normalizedDocumentDigest,
      sourceDocumentDigest: manifest.sourceDocumentDigest,
    },
    outcome: 'passed',
    profile: PROFILE,
    schemaVersion: '1.0',
    shacl,
  };
  return verifyPostTradeFixtureReleaseEvidence(evidence);
}

module.exports = {
  PATHS,
  PROFILE,
  artifactRows,
  auditDiagnosticDerivationQuarantine,
  createPostTradeFixtureReleaseEvidence,
  executeShaclXoneEvidence,
  verifyPostTradeFixtureReleaseEvidence,
};
