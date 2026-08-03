'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const {
  COVERAGE_PROFILE,
  auditPostTradeFixtureOntologyCoverage,
} = require('../lib/post-trade-fixture-ontology-coverage.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ONTOLOGY_PATH = path.join(
  ROOT,
  'ontology/domain/finance/post-trade-operations/module.yaml',
);
const PATTERN_PATH = path.join(ROOT, 'ontology/meta/cross-domain-patterns.yaml');
const POSITIVE_PATH = path.join(
  ROOT,
  'tests/m2/fixtures/positive/post-trade-closure-reconciliation.yaml',
);
const NEGATIVE_PATH = path.join(
  ROOT,
  'tests/m2/fixtures/negative/post-trade-closure-reconciliation-negative.yaml',
);
const BASE = 'https://axiolune.ai/ontology/finance/post-trade-operations/';
const TYPE = `${BASE}CorporateActionElectionProviderPrecedenceEdge`;

function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

const ontologyDocument = loadYaml(ONTOLOGY_PATH);
const patternDocument = loadYaml(PATTERN_PATH);

function audit(fixtureDocument, fixtureRef = 'synthetic-post-trade-fixture') {
  return auditPostTradeFixtureOntologyCoverage({
    ontologyDocument,
    patternDocument,
    fixtureDocument,
    fixtureRef,
  });
}

function typedRecord() {
  return {
    ontologyType: TYPE,
    recordIri: 'https://example.test/fact/provider-precedence/version/1',
    attributes: {
      generatingContextRef: 'https://example.test/control/run/provider-precedence/1',
      validFrom: '2026-05-01T00:00:00Z',
      knowledgeFrom: '2026-05-01T00:01:00Z',
      availableFrom: '2026-05-01T00:02:00Z',
      source: 'https://example.test/source/provider-policy',
    },
    roles: {
      precedencePolicy: 'https://example.test/fact/provider-policy/version/1',
      higherPriorityProvider: 'https://example.test/party/provider-a',
      lowerPriorityProvider: 'https://example.test/party/provider-b',
    },
  };
}

function typedFixture() {
  return {
    fixtureProfile: 'axiolune-post-trade-v0.3',
    ontologyCoverage: {
      profile: COVERAGE_PROFILE,
      completeness: 'complete',
      recordCount: 1,
    },
    fixtures: [{
      id: 'authored-ontology-coverage-example',
      contract: 'CoverageOnly',
      instance: { ontologyRecords: [typedRecord()] },
    }],
  };
}

function codes(report) {
  return new Set(report.diagnostics.map((item) => item.code));
}

test('current positive fixture is pending because 169 record-like objects have zero type tags', () => {
  const report = audit(loadYaml(POSITIVE_PATH), 'tests/m2/fixtures/positive/post-trade-closure-reconciliation.yaml');
  assert.equal(report.status, 'pending-type-migration');
  assert.equal(report.ok, false);
  assert.equal(report.coverageComplete, false);
  assert.equal(report.approvalEligible, false);
  assert.equal(report.releaseEvidence, false);
  assert.equal(report.typedRecordCount, 0);
  assert.equal(report.untypedRecordCandidateCount, 169);
  assert.equal(report.objectCount, 301);
  assert.deepEqual(
    report.sharedRequiredPatternFields.map((field) => field.localName).sort(),
    ['availableFrom', 'knowledgeFrom', 'source', 'validFrom'],
  );
  assert.deepEqual(
    report.untypedRecordCandidates[0].provisionalMissingSharedPatternFields
      .map((field) => field.localName).sort(),
    ['availableFrom', 'knowledgeFrom', 'source', 'validFrom'],
  );
  const qualification = report.untypedRecordCandidates.find((candidate) => (
    candidate.path === '$.fixtures[2].instance.qualifications[0]'
  ));
  assert.deepEqual(
    qualification.provisionalMissingSharedPatternFields.map((field) => field.localName),
    ['source'],
  );
  assert.deepEqual(report.ontologyAttributeAliasAmbiguities, [{
    typeIri: `${BASE}CorporateActionElection`,
    typeLocalName: 'CorporateActionElection',
    alias: 'receivedAt',
    candidateIris: [
      'https://axiolune.ai/ontology/finance/post-trade-operations/receivedAt',
      'https://axiolune.ai/ontology/meta/patterns/attributes/receivedAt',
    ],
  }]);
  assert.ok(codes(report).has('PTO_FIXTURE_TYPE_TAGS_MISSING'));
  assert.ok(codes(report).has('PTO_FIXTURE_COVERAGE_DECLARATION_MISSING'));
  assert.ok(codes(report).has('PTO_FIXTURE_UNTYPED_RECORD_CANDIDATE'));
  assert.match(report.minimumMigrationPlan[0].action, /ontologyType/u);
  assert.match(report.minimumMigrationPlan[2].action, /validFrom.*knowledgeFrom.*availableFrom.*source/u);
});

test('current mutation fixture is also pending and cannot inherit a release pass from its base fixture', () => {
  const report = audit(loadYaml(NEGATIVE_PATH), 'tests/m2/fixtures/negative/post-trade-closure-reconciliation-negative.yaml');
  assert.equal(report.status, 'pending-type-migration');
  assert.equal(report.releaseEvidence, false);
  assert.equal(report.typedRecordCount, 0);
  assert.equal(report.untypedRecordCandidateCount, 19);
  assert.equal(report.objectCount, 516);
  assert.ok(codes(report).has('PTO_FIXTURE_TYPE_TAGS_MISSING'));
});

test('a closed typed envelope resolves exact AssociationType attributes roles and pattern fields', () => {
  const report = audit(typedFixture());
  assert.equal(report.status, 'diagnostic-conformant');
  assert.equal(report.ok, true);
  assert.equal(report.coverageComplete, true);
  assert.equal(report.approvalEligible, false);
  assert.equal(report.releaseEvidence, false);
  assert.equal(report.diagnosticOnly, true);
  assert.equal(report.authoredTypeCount, 34);
  assert.equal(report.typedRecordCount, 1);
  assert.equal(report.untypedRecordCandidateCount, 0);
  assert.equal(report.errorCount, 0);
  assert.equal(report.pendingCount, 0);
  assert.match(report.diagnosticDigest, /^sha256:[0-9a-f]{64}$/u);
  const [record] = report.records;
  assert.equal(record.typeIri, TYPE);
  assert.equal(record.typeKind, 'AssociationType');
  assert.deepEqual(record.missingRequiredAttributes, []);
  assert.deepEqual(record.missingRequiredRoles, []);
  assert.deepEqual(record.missingRequiredPatternFields, []);
  assert.deepEqual(
    record.usedRoles.map((role) => role.id),
    ['higherPriorityProvider', 'lowerPriorityProvider', 'precedencePolicy'],
  );
  assert.ok(record.absentOptionalPatternFields.some((field) => field.localName === 'validTo'));
  assert.ok(record.absentOptionalPatternFields.some((field) => field.localName === 'derivedFrom'));
});

test('unknown ontology type fails instead of guessing from a private fixture path', () => {
  const fixture = typedFixture();
  fixture.fixtures[0].instance.ontologyRecords[0].ontologyType = `${BASE}FabricatedType`;
  const report = audit(fixture);
  assert.equal(report.status, 'failed');
  assert.equal(report.ok, false);
  assert.ok(codes(report).has('PTO_FIXTURE_UNKNOWN_TYPE'));
});

test('ontologyType localName alone is rejected instead of inferring a namespace', () => {
  const fixture = typedFixture();
  fixture.fixtures[0].instance.ontologyRecords[0].ontologyType = 'CorporateActionElectionProviderPrecedenceEdge';
  const report = audit(fixture);
  assert.equal(report.status, 'failed');
  assert.ok(codes(report).has('PTO_FIXTURE_UNKNOWN_TYPE'));
});

test('unknown attributes roles and flat fields all fail closed', () => {
  const fixture = typedFixture();
  const record = fixture.fixtures[0].instance.ontologyRecords[0];
  record.privatePolicyVersionIri = 'https://example.test/private/policy/version/1';
  record.attributes.fabricatedAttribute = true;
  record.roles.fabricatedRole = 'https://example.test/private/role-target';
  const report = audit(fixture);
  assert.equal(report.status, 'failed');
  assert.ok(codes(report).has('PTO_FIXTURE_FLAT_FIELD'));
  assert.ok(codes(report).has('PTO_FIXTURE_UNKNOWN_ATTRIBUTE'));
  assert.ok(codes(report).has('PTO_FIXTURE_UNKNOWN_ROLE'));
});

test('ambiguous receivedAt localName fails and exact full IRIs remain distinguishable', () => {
  const shortNameFixture = typedFixture();
  const shortNameRecord = shortNameFixture.fixtures[0].instance.ontologyRecords[0];
  shortNameRecord.ontologyType = `${BASE}CorporateActionElection`;
  shortNameRecord.attributes = {
    receivedAt: '2026-05-01T00:00:00Z',
  };
  shortNameRecord.roles = {};
  const ambiguous = audit(shortNameFixture);
  assert.ok(codes(ambiguous).has('PTO_FIXTURE_AMBIGUOUS_ATTRIBUTE'));

  const exactIriFixture = structuredClone(shortNameFixture);
  const exactAttributes = exactIriFixture.fixtures[0].instance.ontologyRecords[0].attributes;
  delete exactAttributes.receivedAt;
  exactAttributes['https://axiolune.ai/ontology/finance/post-trade-operations/receivedAt'] = '2026-05-01T00:00:00Z';
  exactAttributes['https://axiolune.ai/ontology/meta/patterns/attributes/receivedAt'] = '2026-05-01T00:00:00Z';
  const exact = audit(exactIriFixture);
  assert.equal(codes(exact).has('PTO_FIXTURE_AMBIGUOUS_ATTRIBUTE'), false);
});

test('missing TemporalFact and ProvenancedFact required injections are listed exactly', () => {
  const fixture = typedFixture();
  const attributes = fixture.fixtures[0].instance.ontologyRecords[0].attributes;
  delete attributes.validFrom;
  delete attributes.knowledgeFrom;
  delete attributes.availableFrom;
  delete attributes.source;
  const report = audit(fixture);
  assert.equal(report.status, 'failed');
  assert.ok(codes(report).has('PTO_FIXTURE_PATTERN_FIELD_REQUIRED'));
  assert.deepEqual(
    report.records[0].missingRequiredPatternFields.map((field) => field.localName).sort(),
    ['availableFrom', 'knowledgeFrom', 'source', 'validFrom'],
  );
  assert.ok(report.records[0].missingRequiredPatternFields.every(
    (field) => field.boundPatternIris.length > 0 && field.declaringPatternIris.length > 0,
  ));
});

test('missing required authored attribute and participant role are reported separately', () => {
  const fixture = typedFixture();
  const record = fixture.fixtures[0].instance.ontologyRecords[0];
  delete record.attributes.generatingContextRef;
  delete record.roles.higherPriorityProvider;
  const report = audit(fixture);
  assert.equal(report.status, 'failed');
  assert.ok(codes(report).has('PTO_FIXTURE_AUTHORED_ATTRIBUTE_REQUIRED'));
  assert.ok(codes(report).has('PTO_FIXTURE_AUTHORED_ROLE_REQUIRED'));
  assert.deepEqual(
    report.records[0].missingRequiredAttributes.map((field) => field.localName),
    ['generatingContextRef'],
  );
  assert.deepEqual(
    report.records[0].missingRequiredRoles.map((role) => role.id),
    ['higherPriorityProvider'],
  );
});

test('partial tagging remains pending when any record-like private object is untyped', () => {
  const fixture = typedFixture();
  fixture.fixtures[0].instance.legacyPrivateRecord = {
    versionIri: 'https://example.test/fact/legacy/version/1',
  };
  const report = audit(fixture);
  assert.equal(report.status, 'pending-type-migration');
  assert.equal(report.ok, false);
  assert.equal(report.typedRecordCount, 1);
  assert.equal(report.untypedRecordCandidateCount, 1);
  assert.ok(codes(report).has('PTO_FIXTURE_UNTYPED_RECORD_CANDIDATE'));
});

test('record-like objects nested in a typed attribute value cannot evade pending coverage', () => {
  const fixture = typedFixture();
  fixture.fixtures[0].instance.ontologyRecords[0].attributes.generatingContextRef = {
    versionIri: 'https://example.test/control/run/provider-precedence/version/1',
  };
  const report = audit(fixture);
  assert.equal(report.status, 'pending-type-migration');
  assert.equal(report.untypedRecordCandidateCount, 1);
  assert.equal(
    report.untypedRecordCandidates[0].path,
    '$.fixtures[0].instance.ontologyRecords[0].attributes.generatingContextRef',
  );
});

test('a false complete declaration cannot hide a missing tagged record', () => {
  const fixture = typedFixture();
  fixture.ontologyCoverage.recordCount = 2;
  const report = audit(fixture);
  assert.equal(report.status, 'failed');
  assert.ok(codes(report).has('PTO_FIXTURE_COVERAGE_RECORD_COUNT'));
  assert.equal(report.releaseEvidence, false);
});
