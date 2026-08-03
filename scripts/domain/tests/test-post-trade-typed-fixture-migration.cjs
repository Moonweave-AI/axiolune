'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  loadYaml,
  mutate,
  validateScenario,
} = require('../lib/post-trade-v03-contract.cjs');
const {
  TYPED_FIXTURE_PROFILE,
  assertCanonicalTypedFixtureBuildMatchesManifest,
  buildPostTradeCanonicalTypedFixture,
  compileSchema,
  mergeFinanceOntologyDocuments,
  normalizePostTradeCanonicalTypedFixture,
  validateCanonicalTypedFixtureManifest,
} = require('../lib/post-trade-canonical-envelope-builder.cjs');
const {
  NON_RECORD_REASON,
  compilePostTradeTypedRouteInventory,
  digest,
} = require('../lib/post-trade-typed-route-inventory.cjs');
const {
  auditPostTradeFixtureOntologyCoverage,
} = require('../lib/post-trade-fixture-ontology-coverage.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_REF = 'tests/m2/fixtures/positive/post-trade-closure-reconciliation.yaml';
const CLASSIFICATION_REF = 'tests/m2/fixtures/positive/post-trade-non-record-classifications.json';
const MANIFEST_REF = 'tests/m2/fixtures/positive/post-trade-typed-envelope-overlay.json';
const BUILDER_REF = 'scripts/domain/lib/post-trade-canonical-envelope-builder.cjs';
const SOURCE_PATH = path.join(ROOT, ...SOURCE_REF.split('/'));
const CLASSIFICATION_PATH = path.join(ROOT, ...CLASSIFICATION_REF.split('/'));
const MANIFEST_PATH = path.join(ROOT, ...MANIFEST_REF.split('/'));
const BUILDER_PATH = path.join(ROOT, ...BUILDER_REF.split('/'));
const NEGATIVE_PATH = path.join(
  ROOT,
  'tests/m2/fixtures/negative/post-trade-closure-reconciliation-negative.yaml',
);
const PATTERN_PATH = path.join(ROOT, 'ontology/meta/cross-domain-patterns.yaml');
const PROVENANCED_FACT = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const REVISION = 'https://axiolune.ai/ontology/meta/patterns/attributes/revision';
const PRICE_OBSERVATION = 'https://axiolune.ai/ontology/finance/market-data/PriceObservation';

const sourceBytes = fs.readFileSync(SOURCE_PATH);
const classificationBytes = fs.readFileSync(CLASSIFICATION_PATH);
const builderBytes = fs.readFileSync(BUILDER_PATH);
const sourceDocument = loadYaml(SOURCE_PATH);
const classificationDocument = JSON.parse(classificationBytes.toString('utf8'));
const manifestDocument = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const patternDocument = loadYaml(PATTERN_PATH);
const ontologyDocuments = fs.readdirSync(path.join(ROOT, 'ontology/domain/finance'))
  .sort()
  .map((moduleName) => path.join(ROOT, 'ontology/domain/finance', moduleName, 'module.yaml'))
  .filter((modulePath) => fs.existsSync(modulePath))
  .map((modulePath) => loadYaml(modulePath));
const ontologyClosure = mergeFinanceOntologyDocuments(ontologyDocuments);
const extractorProfileRef = {
  kind: 'path',
  root: 'sourceTree',
  path: BUILDER_REF,
};

function clone(value) {
  return structuredClone(value);
}

function validateManifest(overrides = {}) {
  return validateCanonicalTypedFixtureManifest({
    manifestDocument,
    sourceFixtureRef: SOURCE_REF,
    sourceBytes,
    sourceDocument,
    classificationRef: CLASSIFICATION_REF,
    classificationBytes,
    extractorProfileRef,
    extractorProfileBytes: builderBytes,
    ...overrides,
  });
}

function build(overrides = {}) {
  validateManifest();
  const built = buildPostTradeCanonicalTypedFixture({
    sourceDocument,
    sourceFixtureRef: SOURCE_REF,
    sourceBytes,
    ontologyDocument: ontologyClosure,
    patternDocument,
    classificationDocument,
    extractorProfileRef,
    extractorProfileDigest: manifestDocument.extractorProfileDigest,
    ...overrides,
  });
  assertCanonicalTypedFixtureBuildMatchesManifest(manifestDocument, built);
  return built;
}

function audit(fixtureDocument) {
  return auditPostTradeFixtureOntologyCoverage({
    ontologyDocument: ontologyClosure,
    patternDocument,
    fixtureDocument,
    fixtureRef: `${SOURCE_REF}#canonical-typed`,
  });
}

function allRecords(typedDocument) {
  return typedDocument.fixtures.flatMap((fixture) => fixture.ontologyRecords);
}

function expectCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, code, error.stack || error.message);
    return true;
  });
}

test('overlay manifest byte-locks the executable full migration and exact 146+23 closure', () => {
  assert.equal(validateManifest(), true);
  const built = build();
  assert.equal(built.document.typedFixtureProfile, TYPED_FIXTURE_PROFILE);
  assert.deepEqual(
    {
      sourceCandidates: built.summary.sourceHeuristicCandidateCount,
      typed: built.summary.typedRecordCount,
      unique: built.summary.uniqueTypedRecordCount,
      duplicateOccurrences: built.summary.duplicateRecordOccurrenceCount,
      classifiedNonRecords: built.summary.classifiedNonRecordCount,
      unresolved: built.summary.unresolvedCount,
      extra: built.summary.extraClaimCount,
      complete: built.summary.complete,
      stopShip: built.summary.stopShip,
      approvalEligible: built.summary.approvalEligible,
      releaseEvidence: built.summary.releaseEvidence,
    },
    {
      sourceCandidates: 169,
      typed: 146,
      unique: 143,
      duplicateOccurrences: 3,
      classifiedNonRecords: 23,
      unresolved: 0,
      extra: 0,
      complete: true,
      stopShip: false,
      approvalEligible: false,
      releaseEvidence: false,
    },
  );
  assert.equal(built.summary.routeInventoryDigest, manifestDocument.expected.routeInventoryDigest);
  assert.equal(built.summary.typedDocumentDigest, manifestDocument.expected.typedDocumentDigest);
  assert.equal(built.summary.summaryDigest, manifestDocument.expected.summaryDigest);
});

test('route inventory proves 169 = 146 records + 23 digest-locked non-records', () => {
  const inventory = compilePostTradeTypedRouteInventory(
    sourceDocument,
    classificationDocument.classifications,
  );
  assert.equal(inventory.sourceHeuristicCandidateCount, 169);
  assert.equal(inventory.typedRecordCount, 146);
  assert.equal(inventory.classifiedNonRecordCount, 23);
  assert.equal(inventory.unresolvedCount, 0);
  assert.equal(inventory.extraClaimCount, 0);
  assert.equal(inventory.inventoryDigest, manifestDocument.expected.routeInventoryDigest);
  const reasonCounts = Object.fromEntries(
    Object.values(NON_RECORD_REASON).map((reason) => [
      reason,
      inventory.nonRecords.filter((entry) => entry.reason === reason).length,
    ]),
  );
  assert.deepEqual(reasonCounts, {
    fixtureScenarioContainer: 4,
    expectedProjectionAssertion: 12,
    embeddedRecordPositionEvidence: 7,
  });
});

test('canonical coverage is 146/146 typed, 0 untyped, and uses exact full property IRIs', () => {
  const built = build();
  const report = audit(built.document);
  assert.equal(report.status, 'diagnostic-conformant');
  assert.equal(report.coverageComplete, true);
  assert.equal(report.errorCount, 0);
  assert.equal(report.pendingCount, 0);
  assert.equal(report.typedRecordCount, 146);
  assert.equal(report.untypedRecordCandidateCount, 0);
  assert.equal(report.authoredTypeCount, 156);
  assert.equal(report.approvalEligible, false);
  assert.equal(report.releaseEvidence, false);
  assert.equal(allRecords(built.document).length, 146);
  for (const record of allRecords(built.document)) {
    assert.match(record.ontologyType, /^https:\/\/axiolune\.ai\/ontology\//u);
    assert.match(record.recordIri, /^https:\/\//u);
    assert.ok(Object.keys(record.attributes).every((key) => /^https:\/\//u.test(key)));
    assert.ok(Object.keys(record.roles).every((key) => /^https:\/\//u.test(key)));
    for (const local of ['validFrom', 'knowledgeFrom', 'availableFrom', 'source', 'revision']) {
      assert.ok(
        Object.hasOwn(record.attributes, `https://axiolune.ai/ontology/meta/patterns/attributes/${local}`),
        `${record.ontologyType} missing ${local}`,
      );
    }
  }
});

test('raw ProvenancedFact revision 0..1 cannot weaken the effective finance revision 1..1 contract', () => {
  const rawProvenance = patternDocument.CrossDomainPatterns.patterns
    .find((pattern) => pattern.iri === PROVENANCED_FACT);
  const rawRevision = rawProvenance.injectedAttributes
    .find((injection) => injection.attribute === REVISION);
  assert.equal(rawRevision.minCount, 0, 'regression fixture must exercise the raw optional M3 declaration');
  assert.equal(rawRevision.maxCount, 1);

  const schema = compileSchema(ontologyClosure, patternDocument);
  const effectiveRevision = schema.typesByIri.get(PRICE_OBSERVATION).attributes
    .find((attribute) => attribute.iri === REVISION);
  assert.deepEqual(
    { minCount: effectiveRevision.minCount, maxCount: effectiveRevision.maxCount },
    { minCount: 1, maxCount: 1 },
  );

  const built = build();
  assert.ok(built.derivations.some((entry) => (
    entry.sourcePointer === '/fixtures/1/instance/assessment/priceObservation'
      && entry.ontologyType === PRICE_OBSERVATION
      && entry.kind === 'requiredAttribute'
      && entry.propertyIri === REVISION
  )), 'missing legacy PriceObservation revision must be an explicit deterministic derivation');

  const price = allRecords(built.document).find((record) => (
    record.recordIri === 'https://example.test/fact/assessment/price/v1'
  ));
  assert.equal(price.attributes[REVISION], 0);
  delete price.attributes[REVISION];
  const report = audit(built.document);
  assert.equal(report.status, 'failed');
  assert.ok(report.diagnostics.some((item) => (
    item.code === 'PTO_FIXTURE_PATTERN_FIELD_REQUIRED'
      && item.iri === REVISION
  )));
});

test('legacy mutable closure fields are quarantined from immutable FactVersion envelopes', () => {
  const rawPrice = sourceDocument.fixtures[1].instance.assessment.priceObservation;
  assert.equal(typeof rawPrice.knowledgeTo, 'string');
  assert.equal(typeof rawPrice.availableTo, 'string');

  const built = build();
  const price = allRecords(built.document).find((record) => (
    record.recordIri === rawPrice.versionIri
  ));
  const knowledgeTo = 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeTo';
  const availableTo = 'https://axiolune.ai/ontology/meta/patterns/attributes/availableTo';
  assert.equal(Object.hasOwn(price.attributes, knowledgeTo), false);
  assert.equal(Object.hasOwn(price.attributes, availableTo), false);
  const mapping = built.adapterPlan.records.find((row) => row.recordIri === rawPrice.versionIri);
  assert.equal(mapping.bindings.some((row) => row.propertyIri === knowledgeTo), false);
  assert.equal(mapping.bindings.some((row) => row.propertyIri === availableTo), false);

  const normalized = normalizePostTradeCanonicalTypedFixture(built.document, built.adapterPlan, {
    expectedDocumentDigest: manifestDocument.sourceDocumentDigest,
  });
  assert.equal(normalized.document.fixtures[1].instance.assessment.priceObservation.knowledgeTo, rawPrice.knowledgeTo);
  assert.equal(normalized.document.fixtures[1].instance.assessment.priceObservation.availableTo, rawPrice.availableTo);
});

test('compiled attribute and role inventories use UTF-8 byte order independent of locale', () => {
  const orderingType = {
    iri: 'https://example.test/ontology/OrderingProbe',
    localName: 'OrderingProbe',
    attributeUses: [
      { attribute: 'https://example.test/attribute/\u00e9', minCount: 0, maxCount: 1 },
      { attribute: 'https://example.test/attribute/z', minCount: 0, maxCount: 1 },
    ],
    participantRoles: [
      { id: '\u00e9', range: 'https://example.test/type/Target', minCount: 0, maxCount: 1 },
      { id: 'z', range: 'https://example.test/type/Target', minCount: 0, maxCount: 1 },
    ],
    patternBindings: [],
  };
  const schema = compileSchema({
    domain: {
      attributeTypes: {},
      codeLists: {},
      objectTypes: {},
      associationTypes: { OrderingProbe: orderingType },
    },
  }, patternDocument);
  const compiled = schema.typesByIri.get(orderingType.iri);
  assert.deepEqual(compiled.attributes.map((attribute) => attribute.localName), ['z', '\u00e9']);
  assert.deepEqual(compiled.roles.map((role) => role.id), ['z', '\u00e9']);
});

test('domain attributes use canonical primitives, structured values, and exact code-value IRIs', () => {
  const built = build();
  const schema = compileSchema(ontologyClosure, patternDocument);
  let moneyCount = 0;
  let quantityCount = 0;
  let codeValueCount = 0;
  const decimal = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/u;
  for (const record of allRecords(built.document)) {
    for (const [attributeIri, value] of Object.entries(record.attributes)) {
      const attributeType = schema.attributeTypesByIri.get(attributeIri);
      if (!attributeType) continue;
      const values = Array.isArray(value) ? value : [value];
      const codeList = schema.codeListsByIri.get(attributeType.valueType);
      if (codeList) {
        const allowed = new Set(codeList.values.map((item) => item.iri));
        assert.ok(values.length > 0);
        assert.ok(values.every((item) => allowed.has(item)), `${attributeIri} uses a non-IRI code value`);
        codeValueCount += values.length;
      } else if (attributeType.valueType.endsWith('/MonetaryAmount')) {
        moneyCount += values.length;
        for (const item of values) {
          assert.equal(Object.getPrototypeOf(item), Object.prototype);
          assert.ok(Object.keys(item).every((key) => ['amount', 'currency', 'scale'].includes(key)));
          assert.match(item.amount, decimal);
          assert.match(item.currency, /^[A-Z]{3}$/u);
          if (item.scale !== undefined) assert.ok(Number.isInteger(item.scale) && item.scale >= 0);
        }
      } else if (attributeType.valueType.endsWith('/QuantityValue')) {
        quantityCount += values.length;
        for (const item of values) {
          assert.equal(Object.getPrototypeOf(item), Object.prototype);
          assert.ok(Object.keys(item).every(
            (key) => ['value', 'unit', 'precision', 'rounding'].includes(key),
          ));
          assert.match(item.value, decimal);
          assert.equal(typeof item.unit, 'string');
          assert.ok(item.unit.length > 0);
          if (item.precision !== undefined) {
            assert.ok(Number.isInteger(item.precision) && item.precision >= 0);
          }
          if (item.rounding !== undefined) {
            assert.ok(['floor', 'ceiling', 'half-up', 'half-even'].includes(item.rounding));
          }
        }
      } else if (attributeType.valueType === 'integer') {
        assert.ok(values.every(Number.isSafeInteger), `${attributeIri} must contain integers`);
      } else if (attributeType.valueType === 'boolean') {
        assert.ok(values.every((item) => typeof item === 'boolean'), `${attributeIri} must contain booleans`);
      } else if (attributeType.valueType === 'decimal') {
        assert.ok(values.every((item) => typeof item === 'string' && decimal.test(item)));
      } else if (attributeType.valueType === 'uri') {
        assert.ok(values.every((item) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(item)));
      }
    }
  }
  assert.equal(moneyCount, 17);
  assert.equal(quantityCount, 83);
  assert.equal(codeValueCount, 139);
});

test('all 133 envelope-addressable authored SHACL xone evaluations select exactly one branch', () => {
  const built = build();
  const schema = compileSchema(ontologyClosure, patternDocument);
  let evaluationCount = 0;
  for (const record of allRecords(built.document)) {
    for (const constraint of schema.xoneConstraintsByTypeIri.get(record.ontologyType) || []) {
      const present = constraint.branches.filter((branch) => {
        const value = branch.container === 'attribute'
          ? record.attributes[branch.propertyIri]
          : record.roles[branch.propertyIri];
        return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
      });
      assert.equal(
        present.length,
        1,
        `${record.ontologyType} violates ${constraint.name}: ${present.map((item) => item.localName)}`,
      );
      evaluationCount += 1;
    }
  }
  assert.equal(evaluationCount, 133);
});

test('the 814 deterministic synthetic enrichments include every effective finance revision', () => {
  const built = build();
  assert.equal(built.summary.requiredSyntheticDerivationCount, 814);
  assert.equal(built.derivations.length, 814);
  assert.ok(built.derivations.every((entry) => (
    entry.kind === 'requiredAttribute'
      || entry.kind === 'requiredRole'
      || entry.kind === 'semanticBranchAttribute'
      || entry.kind === 'semanticBranchRole'
  )));
  assert.deepEqual(
    Object.fromEntries([...new Set(built.derivations.map((entry) => entry.kind))].map((kind) => [
      kind,
      built.derivations.filter((entry) => entry.kind === kind).length,
    ])),
    {
      requiredAttribute: 671,
      requiredRole: 138,
      semanticBranchAttribute: 1,
      semanticBranchRole: 4,
    },
  );
  assert.equal(
    built.derivations.filter((entry) => entry.propertyIri === REVISION).length,
    146,
    'all 146 routed record occurrences require an effective revision value',
  );
  assert.ok(built.derivations.every((entry) => /^https:\/\//u.test(entry.propertyIri)));
  assert.equal(built.summary.approvalEligible, false);
  assert.equal(built.summary.releaseEvidence, false);
});

test('non-price fact types fail coverage when effective revision is removed', () => {
  for (const typeSuffix of ['/CorporateActionEvent', '/SettlementLeg']) {
    const built = build();
    const record = allRecords(built.document).find((candidate) => (
      candidate.ontologyType.endsWith(typeSuffix)
    ));
    assert.ok(record, `missing regression record for ${typeSuffix}`);
    delete record.attributes[REVISION];
    const report = audit(built.document);
    assert.equal(report.status, 'failed');
    assert.ok(report.diagnostics.some((item) => (
      item.code === 'PTO_FIXTURE_PATTERN_FIELD_REQUIRED' && item.iri === REVISION
    )), `${typeSuffix} revision removal escaped ontology coverage`);
  }
});

test('revision and exact recordIri cannot drift independently of the locked FactVersion envelope', () => {
  const built = build();
  const revisionsByRecordIri = new Map();
  for (const record of allRecords(built.document)) {
    assert.match(record.recordIri, /^https:\/\//u);
    assert.ok(Number.isSafeInteger(record.attributes[REVISION]));
    assert.ok(record.attributes[REVISION] >= 0);
    const prior = revisionsByRecordIri.get(record.recordIri);
    if (prior !== undefined) assert.equal(record.attributes[REVISION], prior);
    revisionsByRecordIri.set(record.recordIri, record.attributes[REVISION]);
  }

  const revisionDrift = clone(built.document);
  const revisionRecord = allRecords(revisionDrift).find((record) => (
    record.ontologyType.endsWith('/CorporateActionEvent')
  ));
  revisionRecord.attributes[REVISION] += 1;
  expectCode(
    () => normalizePostTradeCanonicalTypedFixture(revisionDrift, built.adapterPlan),
    'PTO_TYPED_DOCUMENT_DRIFT',
  );

  const iriDrift = clone(built.document);
  allRecords(iriDrift)[0].recordIri += '/drift';
  expectCode(
    () => normalizePostTradeCanonicalTypedFixture(iriDrift, built.adapterPlan),
    'PTO_TYPED_ADAPTER_RECORD',
  );
});

test('full migration is deterministic and normalizes to the exact locked legacy semantics', () => {
  const first = build();
  const second = build();
  assert.equal(canonicalJcs(first.document), canonicalJcs(second.document));
  assert.deepEqual(first.summary, second.summary);
  assert.equal(first.adapterPlan.adapterPlanDigest, second.adapterPlan.adapterPlanDigest);
  const normalized = normalizePostTradeCanonicalTypedFixture(first.document, first.adapterPlan, {
    expectedDocumentDigest: manifestDocument.sourceDocumentDigest,
  });
  assert.equal(normalized.normalizedDocumentDigest, manifestDocument.sourceDocumentDigest);
  assert.equal(canonicalJcs(normalized.document), canonicalJcs(sourceDocument));
  assert.equal(normalized.document.fixtures.length, 8);
  for (const fixture of normalized.document.fixtures) validateScenario(fixture);
});

test('all 219 mutation negatives retain exact rejection semantics after canonical normalization', () => {
  const built = build();
  const normalized = normalizePostTradeCanonicalTypedFixture(built.document, built.adapterPlan, {
    expectedDocumentDigest: manifestDocument.sourceDocumentDigest,
  }).document;
  const byId = new Map(normalized.fixtures.map((fixture) => [fixture.id, fixture]));
  const negative = loadYaml(NEGATIVE_PATH);
  assert.equal(negative.cases.length, 219);
  for (const testCase of negative.cases) {
    const base = byId.get(testCase.baseFixtureId);
    assert.ok(base, `${testCase.id}: unknown base fixture`);
    let instance = base.instance;
    for (const mutation of testCase.mutations || []) instance = mutate(instance, mutation);
    try {
      validateScenario({ ...base, instance });
      assert.fail(`${testCase.id}: unexpectedly accepted`);
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
      assert.equal(error.code, testCase.expectedViolation, `${testCase.id}: ${error.stack || error.message}`);
    }
  }
});

test('legacy source values that cannot be canonicalized fail closed', async (t) => {
  await t.test('malformed QuantityValue scalar', () => {
    const source = clone(sourceDocument);
    source.fixtures[4].instance.allocations[0].quantity.amount = 'not-a-decimal';
    expectCode(() => build({ sourceDocument: source }), 'PTO_TYPED_CANONICAL_SOURCE');
  });
  await t.test('unknown code-list notation', () => {
    const source = clone(sourceDocument);
    source.fixtures[0].instance.events[0].kind = 'fabricatedCorporateActionKind';
    expectCode(() => build({ sourceDocument: source }), 'PTO_TYPED_CANONICAL_SOURCE');
  });
});

test('non-record exclusion path content category and source-candidate closure fail closed', async (t) => {
  await t.test('classified content mutation', () => {
    const source = clone(sourceDocument);
    source.fixtures[2].instance.entitlements[0].recordPosition.quantity = '999';
    expectCode(
      () => compilePostTradeTypedRouteInventory(source, classificationDocument.classifications),
      'PTO_ROUTE_CLASSIFICATION_DIGEST',
    );
  });
  await t.test('classified path mutation', () => {
    const classifications = clone(classificationDocument.classifications);
    classifications[0].path = '/fixtures/2/instance/event';
    expectCode(
      () => compilePostTradeTypedRouteInventory(sourceDocument, classifications),
      'PTO_ROUTE_DUPLICATE',
    );
  });
  await t.test('classified reason mutation', () => {
    const classifications = clone(classificationDocument.classifications);
    classifications[0].reason = 'fabricatedExemption';
    expectCode(
      () => compilePostTradeTypedRouteInventory(sourceDocument, classifications),
      'PTO_ROUTE_CLASSIFICATION',
    );
  });
  await t.test('new heuristic object', () => {
    const source = clone(sourceDocument);
    source.fixtures[5].instance.unroutedRecord = {
      versionIri: 'https://example.test/fact/unrouted/version/1',
    };
    expectCode(
      () => compilePostTradeTypedRouteInventory(source, classificationDocument.classifications),
      'PTO_ROUTE_CLOSURE',
    );
  });
  await t.test('record route count drift', () => {
    const source = clone(sourceDocument);
    source.fixtures[6].instance.findings.pop();
    expectCode(
      () => compilePostTradeTypedRouteInventory(source, classificationDocument.classifications),
      'PTO_ROUTE_COUNT',
    );
  });
});

test('manifest rejects source classification executable and generated-result drift', async (t) => {
  await t.test('source bytes', () => {
    expectCode(
      () => validateManifest({ sourceBytes: Buffer.concat([sourceBytes, Buffer.from('\n')]) }),
      'PTO_TYPED_MANIFEST',
    );
  });
  await t.test('classification bytes', () => {
    expectCode(
      () => validateManifest({ classificationBytes: Buffer.concat([classificationBytes, Buffer.from('\n')]) }),
      'PTO_TYPED_MANIFEST',
    );
  });
  await t.test('executable builder bytes', () => {
    expectCode(
      () => validateManifest({ extractorProfileBytes: Buffer.concat([builderBytes, Buffer.from('\n')]) }),
      'PTO_TYPED_MANIFEST',
    );
  });
  await t.test('expected count', () => {
    const manifest = clone(manifestDocument);
    manifest.expected.typedRecordCount = 145;
    expectCode(
      () => assertCanonicalTypedFixtureBuildMatchesManifest(manifest, build()),
      'PTO_TYPED_MANIFEST_BUILD_DRIFT',
    );
  });
});

test('typed record mutations cannot evade ontology coverage or adapter equivalence', async (t) => {
  await t.test('required authored attribute removal', () => {
    const built = build();
    const event = allRecords(built.document).find((record) => record.ontologyType.endsWith('/CorporateActionEvent'));
    delete event.attributes['https://axiolune.ai/ontology/finance/post-trade-operations/sourceEventId'];
    const report = audit(built.document);
    assert.equal(report.status, 'failed');
    assert.ok(report.diagnostics.some((item) => item.code === 'PTO_FIXTURE_AUTHORED_ATTRIBUTE_REQUIRED'));
  });
  await t.test('required pattern field removal', () => {
    const built = build();
    const event = allRecords(built.document)[0];
    delete event.attributes['https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom'];
    const report = audit(built.document);
    assert.equal(report.status, 'failed');
    assert.ok(report.diagnostics.some((item) => item.code === 'PTO_FIXTURE_PATTERN_FIELD_REQUIRED'));
  });
  await t.test('required role removal', () => {
    const built = build();
    const event = allRecords(built.document).find((record) => record.ontologyType.endsWith('/CorporateActionEvent'));
    delete event.roles['https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionEvent/role/sourceAuthority'];
    const report = audit(built.document);
    assert.equal(report.status, 'failed');
    assert.ok(report.diagnostics.some((item) => item.code === 'PTO_FIXTURE_AUTHORED_ROLE_REQUIRED'));
  });
  await t.test('short ontology type', () => {
    const built = build();
    allRecords(built.document)[0].ontologyType = 'CorporateActionEvent';
    const report = audit(built.document);
    assert.equal(report.status, 'failed');
    assert.ok(report.diagnostics.some((item) => item.code === 'PTO_FIXTURE_UNKNOWN_TYPE'));
  });
  await t.test('ambiguous CorporateActionElection.receivedAt alias', () => {
    const built = build();
    const election = allRecords(built.document).find((record) => record.ontologyType.endsWith('/CorporateActionElection'));
    const exact = 'https://axiolune.ai/ontology/finance/post-trade-operations/receivedAt';
    election.attributes.receivedAt = election.attributes[exact];
    delete election.attributes[exact];
    const report = audit(built.document);
    assert.equal(report.status, 'failed');
    assert.ok(report.diagnostics.some((item) => item.code === 'PTO_FIXTURE_AMBIGUOUS_ATTRIBUTE'));
  });
  await t.test('record removal', () => {
    const built = build();
    built.document.fixtures[0].ontologyRecords.pop();
    expectCode(
      () => normalizePostTradeCanonicalTypedFixture(built.document, built.adapterPlan),
      'PTO_TYPED_ADAPTER_COUNT',
    );
  });
  await t.test('mapped corporate-action kind drift', () => {
    const built = build();
    const event = built.document.fixtures[0].ontologyRecords[0];
    event.attributes['https://axiolune.ai/ontology/finance/market-rules/corporateActionKind'] =
      'https://axiolune.ai/ontology/finance/market-rules/CorporateActionKind/value/stockSplit';
    expectCode(
      () => normalizePostTradeCanonicalTypedFixture(built.document, built.adapterPlan),
      'PTO_TYPED_ADAPTER_BINDING',
    );
  });
  await t.test('mapped QuantityValue unit drift', () => {
    const built = build();
    const obligation = allRecords(built.document).find(
      (record) => record.ontologyType.endsWith('/CorporateActionDueBillObligation'),
    );
    obligation.attributes[
      'https://axiolune.ai/ontology/finance/post-trade-operations/obligationQuantity'
    ].unit = 'https://example.test/unit/fabricated';
    expectCode(
      () => normalizePostTradeCanonicalTypedFixture(built.document, built.adapterPlan),
      'PTO_TYPED_ADAPTER_BINDING',
    );
  });
  await t.test('synthetic semantic branch removal', () => {
    const built = build();
    const execution = allRecords(built.document).find(
      (record) => record.ontologyType.endsWith('/Execution'),
    );
    delete execution.roles[
      'https://axiolune.ai/ontology/finance/orders-execution/Execution/role/executionListing'
    ];
    expectCode(
      () => normalizePostTradeCanonicalTypedFixture(built.document, built.adapterPlan),
      'PTO_TYPED_DOCUMENT_DRIFT',
    );
  });
});

test('classification digest itself changes for path content or reason mutation', () => {
  const baseline = digest(classificationDocument.classifications);
  for (const mutateClassification of [
    (rows) => { rows[0].path = '/fixtures/3/instance'; },
    (rows) => { rows[0].reason = 'expectedProjectionAssertion'; },
    (rows) => { rows[0].sourceObjectDigest = `sha256:${'0'.repeat(64)}`; },
  ]) {
    const rows = clone(classificationDocument.classifications);
    mutateClassification(rows);
    assert.notEqual(digest(rows), baseline);
  }
});
