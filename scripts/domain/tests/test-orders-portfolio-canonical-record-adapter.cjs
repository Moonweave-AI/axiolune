'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TARGET_TYPE_BY_EVALUATOR,
  TYPES,
  decodeCanonicalOrdersPortfolioScenario,
  encodeCanonicalOrdersPortfolioScenario,
  validateCanonicalDocument,
} = require('../lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  CustomConstraintViolation,
  instantNanoseconds,
  iriSetDigest,
  sha256DomainJcs,
  sha256Jcs,
  validateConstraint,
} = require('../lib/orders-portfolio-custom-validators.cjs');
const {
  buildLockedReferenceRegistry,
  sealReferenceRegistry,
} = require('../lib/orders-portfolio-reference-registry.cjs');
const {
  PATHS,
} = require('../lib/orders-portfolio-custom-profile.cjs');
const {
  readStrictJcs,
} = require('../run-orders-portfolio-custom-runtime.cjs');

function clone(value) {
  return structuredClone(value);
}

function vectorByEvaluator(vectors, evaluatorId) {
  const vector = vectors.vectors.find((row) => row.validatorId === evaluatorId);
  assert.ok(vector, `missing vector for ${evaluatorId}`);
  return vector;
}

function focus(document) {
  const record = document.records.find((row) => row.versionIri === document.focusVersionIri);
  assert.ok(record, 'focus record is absent');
  return record;
}

function rebindLineageGraphInventory(scenario) {
  const lineageVersionIris = scenario.lineages
    .map((lineage) => lineage.versionIri)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const payload = {
    artifactKind: 'OrderIntentLineageGraphInventory',
    focusVersionIri: scenario.versionIri,
    lineageVersionCount: lineageVersionIris.length,
    lineageVersionIris,
    lineageVersionSetDigest: iriSetDigest(lineageVersionIris),
    pitRequestDigest: scenario.pitRequest.digest,
    pitRequestRef: scenario.pitRequest.ref,
    schemaVersion: '1.0',
    selectionScopeRef:
      'https://axiolune.ai/source-scopes/orders/order-intent-lineage/complete-graph/v1',
  };
  const evidence = {
    digest: sha256Jcs(payload),
    payload,
    ref: scenario.sourceEvidence.ref,
  };
  scenario.sourceEvidence = evidence;
  for (const lineage of scenario.lineages) lineage.sourceEvidence = evidence;
  return scenario;
}

function assertCanonicalFailure(action, code) {
  assert.throws(action, (cause) => cause?.code === code, `expected canonical failure ${code}`);
}

const inputContract = readStrictJcs(PATHS.inputContract).value;
const vectors = readStrictJcs(PATHS.vectors).value;

test('ontology-derived input contract names only formal attributes, relations, roles, M3 fields, and controls', () => {
  const expectedTypes = new Set([
    ...Object.values(TARGET_TYPE_BY_EVALUATOR),
    TYPES.DirectUnitPriceQuotationContract,
    TYPES.FXRateObservation,
    TYPES.InstrumentListing,
    TYPES.OTCTradingContext,
    TYPES.PriceObservation,
  ]);
  assert.deepEqual(new Set(inputContract.recordSchemas.map((row) => row.typeIri)), expectedTypes);
  assert.equal(inputContract.unknownFields, 'fatal');
  for (const schema of inputContract.recordSchemas) {
    for (const field of schema.fieldContracts) {
      assert.ok(['attribute', 'control', 'm3Attribute', 'participantRole', 'relation'].includes(field.kind));
      if (field.kind === 'control') continue;
      assert.equal(typeof field.ontologyElement, 'string', `${schema.typeIri}.${field.field}`);
      if (field.kind === 'participantRole') {
        assert.ok(field.ontologyElement.endsWith(`/role/${field.field}`), `${schema.typeIri}.${field.field}`);
      } else {
        assert.ok(field.ontologyElement.endsWith(`/${field.field}`), `${schema.typeIri}.${field.field}`);
      }
    }
  }
  const intent = inputContract.recordSchemas.find((row) => row.typeIri === TYPES.OrderIntent);
  const orderType = intent.fieldContracts.find((row) => row.field === 'orderType');
  assert.deepEqual(orderType.allowedValues, [
    'https://axiolune.ai/ontology/finance/orders-execution/OrderType/value/Limit',
    'https://axiolune.ai/ontology/finance/orders-execution/OrderType/value/LimitIfTouched',
    'https://axiolune.ai/ontology/finance/orders-execution/OrderType/value/Market',
    'https://axiolune.ai/ontology/finance/orders-execution/OrderType/value/MarketIfTouched',
    'https://axiolune.ai/ontology/finance/orders-execution/OrderType/value/Stop',
    'https://axiolune.ai/ontology/finance/orders-execution/OrderType/value/StopLimit',
  ]);

  const stream = inputContract.recordSchemas.find((row) => row.typeIri === TYPES.OrderEventStream);
  const required = new Set(stream.fieldContracts.filter((row) => row.minCount === 1).map((row) => row.field));
  for (const field of [
    'providerApiIdentifier', 'providerSchemaVersion', 'providerStreamId',
    'sourceContractDigest', 'sourceContractRef', 'streamExternalOrder', 'streamProvider',
  ]) assert.ok(required.has(field), `OrderEventStream.${field} must be required`);

  const execution = inputContract.recordSchemas.find((row) => row.typeIri === TYPES.Execution);
  const executionFields = new Map(execution.fieldContracts.map((row) => [row.field, row]));
  for (const [field, expectedTargetType] of [
    ['executionParty', 'https://axiolune.ai/ontology/finance/foundation/Party'],
    ['contraAccount', 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount'],
    ['contraParty', 'https://axiolune.ai/ontology/finance/foundation/Party'],
  ]) {
    const contract = executionFields.get(field);
    assert.equal(contract?.kind, 'participantRole', `Execution.${field} must be a participant role`);
    assert.equal(contract?.minCount, 1, `Execution.${field} must be required`);
    assert.equal(contract?.maxCount, 1, `Execution.${field} must be functional`);
    assert.equal(contract?.referenceMode, 'logical', `Execution.${field} must be logical`);
    assert.equal(contract?.expectedTargetType, expectedTargetType, `Execution.${field} target type drift`);
  }
  assert.equal(executionFields.get('executingBroker')?.minCount, 0);

  const lineage = inputContract.recordSchemas.find((row) => row.typeIri === TYPES.OrderIntentLineage);
  assert.equal(lineage?.ontologyKind, 'AssociationTypeDefinition');
  const lineageFields = new Map(lineage.fieldContracts.map((row) => [row.field, row]));
  for (const role of ['sourceOrderIntent', 'resultOrderIntent']) {
    assert.equal(lineageFields.get(role)?.kind, 'participantRole');
    assert.equal(lineageFields.get(role)?.minCount, 1);
    assert.equal(lineageFields.get(role)?.maxCount, null);
    assert.equal(lineageFields.get(role)?.referenceMode, 'version');
    assert.equal(lineageFields.get(role)?.expectedTargetType, TYPES.OrderIntent);
  }
  for (const field of [
    'orderLineageKind',
    'sourceIntentCount',
    'sourceIntentVersionSetDigest',
    'resultIntentCount',
    'resultIntentVersionSetDigest',
    'orderLineageKeyDigest',
    'sourceArtifactRef',
    'sourceArtifactDigest',
    'sourceLocator',
  ]) assert.equal(lineageFields.get(field)?.minCount, 1, `OrderIntentLineage.${field} must be required`);
});

test('all 70 generated documents pass canonical schema and direct reconciliation remains fail-closed without branded evidence', () => {
  let documentCount = 0;
  for (const vector of vectors.vectors) {
    for (const polarity of ['accepted', 'violation']) {
      const document = vector[polarity].scenario;
      const state = validateCanonicalDocument(document, vector.validatorId, inputContract);
      assert.equal(state.focus.typeIri, TARGET_TYPE_BY_EVALUATOR[vector.validatorId]);
      const scenario = decodeCanonicalOrdersPortfolioScenario(document, vector.validatorId, inputContract);
      if (vector.validatorId === 'PortfolioPositionReconciliationFindingContract'
          && polarity === 'accepted') {
        assert.throws(
          () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
          (cause) => cause instanceof CustomConstraintViolation
            && cause.code === 'RECONCILIATION_UNVERIFIED_PROJECTION',
        );
      } else if (polarity === 'accepted') {
        assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, scenario));
      } else {
        assert.throws(
          () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
          (cause) => cause instanceof CustomConstraintViolation && cause.code === vector.violation.expectedCode,
        );
      }
      documentCount += 1;
    }
  }
  assert.equal(documentCount, 70);
});

test('OrderIntentLineage canonical/runtime boundary rejects orphan, wrong-type, cycle, duplicate, and private reservation state', () => {
  const vector = vectorByEvaluator(vectors, 'OrderIntentLineageContract');
  const accepted = clone(vector.accepted.scenario);
  const lineage = focus(accepted);
  const resultRefs = Array.isArray(lineage.resultOrderIntent)
    ? lineage.resultOrderIntent
    : [lineage.resultOrderIntent];

  const orphan = clone(accepted);
  orphan.records = orphan.records.filter((record) => record.versionIri !== resultRefs[0]);
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(orphan, vector.validatorId, inputContract),
    'orders-portfolio-canonical-reference',
  );

  const wrongType = clone(accepted);
  const externalVector = vectorByEvaluator(vectors, 'ExternalOrderContract');
  const replacement = clone(focus(externalVector.accepted.scenario));
  replacement.versionIri = resultRefs[0];
  replacement.externalOrderOriginatingIntent = Array.isArray(lineage.sourceOrderIntent)
    ? lineage.sourceOrderIntent[0]
    : lineage.sourceOrderIntent;
  wrongType.records = wrongType.records.map((record) => (
    record.versionIri === resultRefs[0] ? replacement : record
  ));
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(wrongType, vector.validatorId, inputContract),
    'orders-portfolio-canonical-reference-type',
  );

  const reservation = clone(accepted);
  focus(reservation).reservationId = 'runtime-reservation-1';
  assertCanonicalFailure(
    () => validateCanonicalDocument(reservation, vector.validatorId, inputContract),
    'orders-portfolio-canonical-unknown-field',
  );

  const decoded = decodeCanonicalOrdersPortfolioScenario(
    accepted,
    vector.validatorId,
    inputContract,
  );
  const missingMaterializationRun = clone(accepted);
  missingMaterializationRun.artifacts = missingMaterializationRun.artifacts.filter(
    (row) => row.payload?.artifactKind !== 'MaterializationRunCompletion',
  );
  const missingRunScenario = decodeCanonicalOrdersPortfolioScenario(
    missingMaterializationRun,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      missingRunScenario,
    ),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'ORDER_LINEAGE_PIT_RUN',
  );
  const reverseSources = [...decoded.resultIntentVersionIris];
  const reverseResults = [...decoded.sourceIntentVersionIris];
  const reverseSourceDigest = iriSetDigest(reverseSources);
  const reverseResultDigest = iriSetDigest(reverseResults);
  const cycleLegacy = clone(decoded);
  cycleLegacy.lineages.push({
    kind: 'aggregation',
    orderLineageKeyDigest: sha256DomainJcs(
      'axiolune-order-intent-lineage-key-v1',
      {
        kind: 'aggregation',
        resultIntentVersionSetDigest: reverseResultDigest,
        sourceIntentVersionSetDigest: reverseSourceDigest,
      },
    ),
    resultIntentCount: reverseResults.length,
    resultIntentVersionSetDigest: reverseResultDigest,
    resultIntentVersionIris: reverseResults,
    sourceEvidence: decoded.sourceEvidence,
    sourceIntentCount: reverseSources.length,
    sourceIntentVersionSetDigest: reverseSourceDigest,
    sourceIntentVersionIris: reverseSources,
    temporal: decoded.temporal,
    versionIri: 'https://axiolune.ai/data/order-intent-lineage/cycle/version/0',
  });
  rebindLineageGraphInventory(cycleLegacy);
  const cycle = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, cycleLegacy);
  const omittedCycleRow = clone(cycle);
  omittedCycleRow.records = omittedCycleRow.records.filter(
    (record) => record.versionIri
      !== 'https://axiolune.ai/data/order-intent-lineage/cycle/version/0',
  );
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(
      omittedCycleRow,
      vector.validatorId,
      inputContract,
    ),
    'orders-portfolio-canonical-lineage-graph-inventory',
  );
  const cycleScenario = decodeCanonicalOrdersPortfolioScenario(
    cycle,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, cycleScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'ORDER_LINEAGE_CYCLE',
  );

  const duplicateLegacy = clone(decoded);
  duplicateLegacy.lineages.push({
    ...clone(duplicateLegacy.lineages[0]),
    versionIri: 'https://axiolune.ai/data/order-intent-lineage/duplicate/version/0',
  });
  rebindLineageGraphInventory(duplicateLegacy);
  const duplicate = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, duplicateLegacy);
  const duplicateScenario = decodeCanonicalOrdersPortfolioScenario(
    duplicate,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, duplicateScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'ORDER_LINEAGE_DUPLICATE',
  );
});

test('currency and Quantity-unit references resolve only through the exact closed bijections', () => {
  const vector = vectorByEvaluator(vectors, 'ExecutionContract');
  const lockedRegistry = buildLockedReferenceRegistry();
  for (const currency of ['CNY', 'GBP', 'JPY']) {
    assert.equal(
      lockedRegistry.currencies.find((row) => row.lexical === currency)?.logicalIri,
      `https://axiolune.ai/data/currency/${currency}`,
    );
  }

  const { registryDigest: ignoredDigest, ...payload } = clone(lockedRegistry);
  assert.match(ignoredDigest, /^sha256:[0-9a-f]{64}$/u);
  const usd = payload.currencies.find((row) => row.lexical === 'USD');
  assert.ok(usd);
  usd.logicalIri = 'urn:test:currency:usd';
  const injectedRegistry = sealReferenceRegistry(payload);
  const injectedContract = clone(inputContract);
  injectedContract.referenceRegistryDigest = injectedRegistry.registryDigest;
  const legacy = decodeCanonicalOrdersPortfolioScenario(
    vector.accepted.scenario,
    vector.validatorId,
    inputContract,
  );
  const injectedDocument = encodeCanonicalOrdersPortfolioScenario(
    vector.validatorId,
    legacy,
    { referenceRegistry: injectedRegistry },
  );
  const injectedQuotation = injectedDocument.records.find(
    (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
  );
  assert.equal(injectedQuotation.quotationQuoteCurrency, 'urn:test:currency:usd');
  assert.equal(
    decodeCanonicalOrdersPortfolioScenario(
      injectedDocument,
      vector.validatorId,
      injectedContract,
      { referenceRegistry: injectedRegistry },
    ).contextQuoteCurrency,
    'USD',
  );
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(
      injectedDocument,
      vector.validatorId,
      inputContract,
    ),
    'orders-portfolio-canonical-reference-registry',
  );

  const mutateQuotation = (field, value) => {
    const document = clone(vector.accepted.scenario);
    const quotation = document.records.find(
      (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
    );
    assert.ok(quotation);
    quotation[field] = value;
    return document;
  };
  for (const document of [
    mutateQuotation('quotationQuoteCurrency', 'https://collision.example/currency/USD'),
    mutateQuotation('quotationQuoteCurrency', 'urn:currency:USD'),
    mutateQuotation('quotationDenominatorUnit', 'https://collision.example/units/share'),
    mutateQuotation('quotationDenominatorUnit', 'urn:unit:share'),
  ]) {
    assertCanonicalFailure(
      () => decodeCanonicalOrdersPortfolioScenario(
        document,
        vector.validatorId,
        inputContract,
      ),
      'orders-portfolio-canonical-reference-registry',
    );
  }
});

test('canonical boundary rejects legacy/private fields, missing official fields, bad structured values, and reference mistakes', () => {
  const executionVector = vectorByEvaluator(vectors, 'ExecutionContract');
  const streamVector = vectorByEvaluator(vectors, 'OrderEventStreamContract');
  const externalBasisVector = vectorByEvaluator(
    vectors,
    'ExternalCostBasisObservationContract',
  );

  assertCanonicalFailure(
    () => validateCanonicalDocument({ account: 'https://axiolune.ai/data/account/1' }, executionVector.validatorId, inputContract),
    'orders-portfolio-canonical-required-field',
  );

  const privateField = clone(executionVector.accepted.scenario);
  focus(privateField).privateExecutionAccount = 'https://axiolune.ai/data/account/1';
  assertCanonicalFailure(
    () => validateCanonicalDocument(privateField, executionVector.validatorId, inputContract),
    'orders-portfolio-canonical-unknown-field',
  );

  for (const missingRole of ['executionParty', 'contraAccount', 'contraParty']) {
    const missingParticipant = clone(executionVector.accepted.scenario);
    const execution = focus(missingParticipant);
    execution.executingBroker = 'https://axiolune.ai/data/party/executing-broker/1';
    delete execution[missingRole];
    assertCanonicalFailure(
      () => validateCanonicalDocument(
        missingParticipant,
        executionVector.validatorId,
        inputContract,
      ),
      'orders-portfolio-canonical-required-field',
    );
  }

  const missingStreamField = clone(streamVector.accepted.scenario);
  delete focus(missingStreamField).providerStreamId;
  assertCanonicalFailure(
    () => validateCanonicalDocument(missingStreamField, streamVector.validatorId, inputContract),
    'orders-portfolio-canonical-required-field',
  );

  const missingObservationStream = clone(externalBasisVector.accepted.scenario);
  delete focus(missingObservationStream).externalBasisObservationStream;
  assertCanonicalFailure(
    () => validateCanonicalDocument(
      missingObservationStream,
      externalBasisVector.validatorId,
      inputContract,
    ),
    'orders-portfolio-canonical-required-field',
  );
  const missingBasisDefinition = clone(
    externalBasisVector.accepted.scenario,
  );
  delete focus(missingBasisDefinition).externalBasisDefinition;
  assertCanonicalFailure(
    () => validateCanonicalDocument(
      missingBasisDefinition,
      externalBasisVector.validatorId,
      inputContract,
    ),
    'orders-portfolio-canonical-required-field',
  );
  const wrongBasisDefinitionType = clone(
    externalBasisVector.accepted.scenario,
  );
  focus(wrongBasisDefinitionType).externalBasisDefinition =
    focus(wrongBasisDefinitionType).versionIri;
  assertCanonicalFailure(
    () => validateCanonicalDocument(
      wrongBasisDefinitionType,
      externalBasisVector.validatorId,
      inputContract,
    ),
    'orders-portfolio-canonical-reference-type',
  );
  const missingBasisDefinitionTarget = clone(
    externalBasisVector.accepted.scenario,
  );
  const definitionVersionIri =
    focus(missingBasisDefinitionTarget).externalBasisDefinition;
  missingBasisDefinitionTarget.records =
    missingBasisDefinitionTarget.records.filter(
      (row) => row.versionIri !== definitionVersionIri,
    );
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(
      missingBasisDefinitionTarget,
      externalBasisVector.validatorId,
      inputContract,
    ),
    'orders-portfolio-canonical-reference',
  );
  const missingObservationStreamLegacy = decodeCanonicalOrdersPortfolioScenario(
    externalBasisVector.accepted.scenario,
    externalBasisVector.validatorId,
    inputContract,
  );
  delete missingObservationStreamLegacy.observationStream;
  assert.throws(
    () => validateConstraint(
      externalBasisVector.constraintIri,
      externalBasisVector.validatorId,
      missingObservationStreamLegacy,
    ),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'EXTERNAL_BASIS_IDENTITY',
  );

  const wrongReferenceMode = clone(executionVector.accepted.scenario);
  focus(wrongReferenceMode).executionAccount = 'https://axiolune.ai/data/account/1/version/0';
  assertCanonicalFailure(
    () => validateCanonicalDocument(wrongReferenceMode, executionVector.validatorId, inputContract),
    'orders-portfolio-canonical-reference-mode',
  );

  const wrongTargetType = clone(executionVector.accepted.scenario);
  focus(wrongTargetType).executionOrderIntent = focus(wrongTargetType).executionQuotationContract;
  assertCanonicalFailure(
    () => validateCanonicalDocument(wrongTargetType, executionVector.validatorId, inputContract),
    'orders-portfolio-canonical-reference-type',
  );

  const malformedMoney = clone(executionVector.accepted.scenario);
  focus(malformedMoney).executionPrice.privateAmountMicros = 3000000;
  assertCanonicalFailure(
    () => validateCanonicalDocument(malformedMoney, executionVector.validatorId, inputContract),
    'orders-portfolio-canonical-unknown-field',
  );

  const invalidCalendarInstant = clone(executionVector.accepted.scenario);
  focus(invalidCalendarInstant).availableFrom = '2025-02-30T00:00:00Z';
  assertCanonicalFailure(
    () => validateCanonicalDocument(invalidCalendarInstant, executionVector.validatorId, inputContract),
    'orders-portfolio-canonical-attribute-type',
  );

  const intentVector = vectorByEvaluator(vectors, 'OrderIntentContract');
  const unknownCodeMember = clone(intentVector.accepted.scenario);
  focus(unknownCodeMember).orderType =
    'https://axiolune.ai/ontology/finance/orders-execution/OrderType/value/Unknown';
  assertCanonicalFailure(
    () => validateCanonicalDocument(unknownCodeMember, intentVector.validatorId, inputContract),
    'orders-portfolio-canonical-code-value',
  );

  const locatorDigestSubstitution = clone(executionVector.accepted.scenario);
  focus(locatorDigestSubstitution).sourceLocator.selectionDigest = `sha256:${'1'.repeat(64)}`;
  assertCanonicalFailure(
    () => validateCanonicalDocument(locatorDigestSubstitution, executionVector.validatorId, inputContract),
    'orders-portfolio-canonical-source-locator',
  );
});

test('reconciliation source-kind diagnostics precede final projection ingress', () => {
  const vector = vectorByEvaluator(
    vectors,
    'PortfolioPositionReconciliationFindingContract',
  );
  const document = clone(vector.accepted.scenario);
  const derived = document.records.find((row) => row.typeIri === TYPES.PositionSnapshot);
  assert.ok(derived, 'accepted reconciliation vector lacks its derived position');
  derived.positionSourceKind =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSourceKind/value/externalReported';
  const scenario = decodeCanonicalOrdersPortfolioScenario(
    document,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'RECONCILIATION_SOURCE_KIND',
  );
});

test('temporal comparisons preserve UTC nanoseconds and reject calendar normalization', () => {
  assert.equal(instantNanoseconds('2025-02-30T00:00:00Z'), null);
  assert.equal(
    instantNanoseconds('2025-01-01T00:00:02.000000002Z')
      - instantNanoseconds('2025-01-01T00:00:02.000000001Z'),
    1n,
  );
  assert.equal(instantNanoseconds('2024-02-29T23:59:59.123456789Z') !== null, true);
});

test('closed exact-version sets use the RFC section 5.8 framed IRI-set digest', () => {
  const values = [
    'https://axiolune.ai/data/membership/b/version/0',
    'https://axiolune.ai/data/membership/a/version/0',
  ];
  const sorted = [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.equal(iriSetDigest(values), iriSetDigest(sorted));
  assert.notEqual(iriSetDigest(values), sha256Jcs(sorted), 'a JSON-array digest is not an IRI-set digest');

  const vector = vectorByEvaluator(vectors, 'PortfolioAccountMembershipClosureContract');
  const legacyDigest = clone(vector.accepted.scenario);
  const closure = focus(legacyDigest);
  closure.membershipVersionSetDigest = sha256Jcs(closure.closedMembership);
  const scenario = decodeCanonicalOrdersPortfolioScenario(
    legacyDigest,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'MEMBERSHIP_CLOSURE_SET',
  );
});

test('OrderEventStream digest binds source schema, semantic mapping, and liquidity capability bytes', () => {
  const vector = vectorByEvaluator(vectors, 'OrderEventStreamContract');
  const accepted = clone(vector.accepted.scenario);
  const decoded = decodeCanonicalOrdersPortfolioScenario(accepted, vector.validatorId, inputContract);
  assert.deepEqual(Object.keys(decoded.lockedSourceContract).sort(), [
    'liquidityRoleCapability', 'schemaVersion', 'semanticMapping', 'sourceSchema',
  ]);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, decoded));

  const capabilitySubstitution = clone(accepted);
  focus(capabilitySubstitution).liquidityRoleCapability =
    'https://axiolune.ai/ontology/finance/orders-execution/LiquidityRoleCapability/value/optional';
  const capabilityScenario = decodeCanonicalOrdersPortfolioScenario(
    capabilitySubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, capabilityScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'EVENT_STREAM_DIGEST',
  );

  const mappingByteSubstitution = clone(accepted);
  const contract = mappingByteSubstitution.artifacts[0];
  contract.payload.semanticMapping.rawFieldLocator = '/other';
  contract.artifactDigest = sha256Jcs(contract.payload);
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(mappingByteSubstitution, vector.validatorId, inputContract),
    'orders-portfolio-canonical-artifact-reference',
  );
});

test('OrderTransitionProfile resolves every executable digest to exact artifact bytes', () => {
  const vector = vectorByEvaluator(vectors, 'OrderTransitionProfileContract');
  const accepted = clone(vector.accepted.scenario);
  assert.equal(accepted.artifacts.length, 5);
  const decoded = decodeCanonicalOrdersPortfolioScenario(accepted, vector.validatorId, inputContract);
  assert.deepEqual(new Set(Object.keys(decoded.lockedArtifacts)), new Set([
    'implementation', 'inputContract', 'outputContract', 'runtime', 'toolLock',
  ]));
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, decoded));

  const digestSubstitution = clone(accepted);
  focus(digestSubstitution).implementationDigest = `sha256:${'1'.repeat(64)}`;
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(digestSubstitution, vector.validatorId, inputContract),
    'orders-portfolio-canonical-artifact-reference',
  );

  const toolRefSubstitution = clone(accepted);
  focus(toolRefSubstitution).toolLockRef = 'https://axiolune.ai/tools/transition-lock/other';
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(toolRefSubstitution, vector.validatorId, inputContract),
    'orders-portfolio-canonical-artifact-reference',
  );
});

test('LiquidityRoleMapping binds source/mapping bytes and requires explicit auction semantics', () => {
  const vector = vectorByEvaluator(vectors, 'LiquidityRoleMappingContract');
  const accepted = clone(vector.accepted.scenario);
  const decoded = decodeCanonicalOrdersPortfolioScenario(accepted, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, decoded));

  const perspectiveSubstitution = clone(accepted);
  focus(perspectiveSubstitution).rawPerspective = 'executionAccountOrder';
  const perspectiveScenario = decodeCanonicalOrdersPortfolioScenario(
    perspectiveSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, perspectiveScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIQUIDITY_MAPPING_DIGEST',
  );

  const missingAuctionSemantic = clone(decoded);
  missingAuctionSemantic.entries.push({ rawValue: 'A', role: 'Undefined' });
  const missingAuctionDocument = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, missingAuctionSemantic);
  const missingAuctionScenario = decodeCanonicalOrdersPortfolioScenario(
    missingAuctionDocument,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, missingAuctionScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIQUIDITY_MAPPING_VALUES',
  );

  const reviewedAuction = clone(decoded);
  reviewedAuction.entries.push({
    auctionSemantic: { kind: 'auction-or-uncrossed', reviewed: true },
    rawValue: 'A',
    role: 'Undefined',
  });
  const reviewedAuctionDocument = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, reviewedAuction);
  const reviewedAuctionScenario = decodeCanonicalOrdersPortfolioScenario(
    reviewedAuctionDocument,
    vector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, reviewedAuctionScenario));
});

test('OrderLifecycleEvent follows the exact stream-order-intent chain and hashes complete retry objects', () => {
  const vector = vectorByEvaluator(vectors, 'OrderLifecycleEventContract');
  const accepted = clone(vector.accepted.scenario);
  const decoded = decodeCanonicalOrdersPortfolioScenario(accepted, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, decoded));

  const chainSubstitution = clone(accepted);
  chainSubstitution.records.find((row) => row.typeIri === TYPES.OrderEventStream).streamExternalOrder =
    'https://axiolune.ai/data/external-order/other';
  const chainScenario = decodeCanonicalOrdersPortfolioScenario(
    chainSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, chainScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIFECYCLE_EVENT_CHAIN',
  );

  const nestedRetryDifference = clone(decoded);
  nestedRetryDifference.retries[1].event.providerPayload = { nested: { value: 'different' } };
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, nestedRetryDifference),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIFECYCLE_EVENT_DUPLICATE',
  );

  const keyOrderOnly = clone(decoded);
  keyOrderOnly.retries[1].event = { key: 1, kind: 'Accepted' };
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, keyOrderOnly));
});

test('OrderIntent and Execution close listing/OTC context, PIT, quotation, and exact order-chain joins', () => {
  const intentVector = vectorByEvaluator(vectors, 'OrderIntentContract');
  const intentAccepted = clone(intentVector.accepted.scenario);
  const intentScenario = decodeCanonicalOrdersPortfolioScenario(
    intentAccepted,
    intentVector.validatorId,
    inputContract,
  );
  assert.equal(intentScenario.contextKind, 'listing');
  assert.doesNotThrow(() => validateConstraint(intentVector.constraintIri, intentVector.validatorId, intentScenario));

  const wrongListedInstrument = clone(intentAccepted);
  wrongListedInstrument.records.find((row) => row.typeIri === TYPES.InstrumentListing).listedInstrument =
    'https://axiolune.ai/data/instrument/other/version/0';
  const wrongListedScenario = decodeCanonicalOrdersPortfolioScenario(
    wrongListedInstrument,
    intentVector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(intentVector.constraintIri, intentVector.validatorId, wrongListedScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'ORDER_INTENT_CONTEXT',
  );

  const futureListing = clone(intentAccepted);
  futureListing.records.find((row) => row.typeIri === TYPES.InstrumentListing).availableFrom =
    '2025-01-01T00:00:02.000000001Z';
  focus(futureListing).availableFrom = '2025-01-01T00:00:02Z';
  const futureListingScenario = decodeCanonicalOrdersPortfolioScenario(
    futureListing,
    intentVector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(intentVector.constraintIri, intentVector.validatorId, futureListingScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'ORDER_INTENT_CONTEXT',
  );

  const otcIntentLegacy = clone(intentScenario);
  otcIntentLegacy.contextKind = 'otc';
  const otcIntent = encodeCanonicalOrdersPortfolioScenario(intentVector.validatorId, otcIntentLegacy);
  const otcIntentScenario = decodeCanonicalOrdersPortfolioScenario(
    otcIntent,
    intentVector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(intentVector.constraintIri, intentVector.validatorId, otcIntentScenario));

  const executionVector = vectorByEvaluator(vectors, 'ExecutionContract');
  const executionAccepted = clone(executionVector.accepted.scenario);
  const executionScenario = decodeCanonicalOrdersPortfolioScenario(
    executionAccepted,
    executionVector.validatorId,
    inputContract,
  );
  assert.equal(executionScenario.executionParty.logicalIri, 'https://axiolune.ai/data/party/execution-principal/1');
  assert.equal(executionScenario.contraAccount.logicalIri, 'https://axiolune.ai/data/account/contra/1');
  assert.equal(executionScenario.contraParty.logicalIri, 'https://axiolune.ai/data/party/contra/1');
  assert.equal(executionScenario.executingBroker.logicalIri, 'https://axiolune.ai/data/party/executing-broker/1');
  assert.doesNotThrow(() => validateConstraint(
    executionVector.constraintIri,
    executionVector.validatorId,
    executionScenario,
  ));

  const streamOrderSubstitution = clone(executionAccepted);
  streamOrderSubstitution.records.find((row) => row.typeIri === TYPES.OrderEventStream).streamExternalOrder =
    'https://axiolune.ai/data/external-order/other';
  const streamOrderScenario = decodeCanonicalOrdersPortfolioScenario(
    streamOrderSubstitution,
    executionVector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(executionVector.constraintIri, executionVector.validatorId, streamOrderScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'EXECUTION_ORDER_CHAIN',
  );

  const executionOtcLegacy = clone(executionScenario);
  executionOtcLegacy.contextKind = 'otc';
  const executionOtc = encodeCanonicalOrdersPortfolioScenario(executionVector.validatorId, executionOtcLegacy);
  const executionOtcScenario = decodeCanonicalOrdersPortfolioScenario(
    executionOtc,
    executionVector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(
    executionVector.constraintIri,
    executionVector.validatorId,
    executionOtcScenario,
  ));
});

test('LiquidityRoleDetermination resolves RFC 6901 pointers and enforces required/optional/unsupported branches', () => {
  const vector = vectorByEvaluator(vectors, 'LiquidityRoleDeterminationContract');
  const accepted = clone(vector.accepted.scenario);
  const decoded = decodeCanonicalOrdersPortfolioScenario(accepted, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, decoded));

  const nestedLegacy = clone(decoded);
  nestedLegacy.pointer = '/payload/a~1b/~0role';
  nestedLegacy.sourceRecord = { payload: { 'a/b': { '~role': 'M' } } };
  nestedLegacy.sourceRecordDigest = sha256Jcs(nestedLegacy.sourceRecord);
  const nested = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, nestedLegacy);
  const nestedScenario = decodeCanonicalOrdersPortfolioScenario(nested, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, nestedScenario));

  const missingPointerLegacy = clone(decoded);
  missingPointerLegacy.pointer = '/missing';
  const missingPointer = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, missingPointerLegacy);
  const missingPointerScenario = decodeCanonicalOrdersPortfolioScenario(
    missingPointer,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, missingPointerScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIQUIDITY_REQUIRED',
  );

  const roleSubstitution = clone(accepted);
  focus(roleSubstitution).liquidityRole =
    'https://axiolune.ai/ontology/finance/orders-execution/LiquidityRole/value/taker';
  const roleScenario = decodeCanonicalOrdersPortfolioScenario(
    roleSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, roleScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIQUIDITY_REQUIRED',
  );

  const optionalLegacy = clone(decoded);
  optionalLegacy.capability = 'optional';
  optionalLegacy.outcome = 'unavailable';
  optionalLegacy.absenceReason = 'providerNotSpecified';
  optionalLegacy.absenceProbePassed = true;
  optionalLegacy.pointer = '/missing';
  delete optionalLegacy.mapping;
  delete optionalLegacy.rawValue;
  delete optionalLegacy.role;
  const optional = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, optionalLegacy);
  const optionalScenario = decodeCanonicalOrdersPortfolioScenario(optional, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, optionalScenario));

  const falseAbsenceLegacy = clone(optionalLegacy);
  falseAbsenceLegacy.pointer = '/liquidity';
  const falseAbsence = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, falseAbsenceLegacy);
  const falseAbsenceScenario = decodeCanonicalOrdersPortfolioScenario(
    falseAbsence,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, falseAbsenceScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIQUIDITY_OPTIONAL',
  );

  const unsupportedLegacy = clone(decoded);
  unsupportedLegacy.capability = 'unsupported';
  unsupportedLegacy.outcome = 'unavailable';
  unsupportedLegacy.absenceReason = 'contractUnsupported';
  delete unsupportedLegacy.absenceProbe;
  delete unsupportedLegacy.mapping;
  delete unsupportedLegacy.rawValue;
  delete unsupportedLegacy.role;
  const unsupported = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, unsupportedLegacy);
  const unsupportedScenario = decodeCanonicalOrdersPortfolioScenario(
    unsupported,
    vector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, unsupportedScenario));

  const contraLegacy = clone(decoded);
  contraLegacy.mappingEntries = [{ rawValue: 'M', role: 'Maker' }];
  contraLegacy.mappingPerspectiveInversion = true;
  contraLegacy.mappingRawPerspective = 'contraOrder';
  contraLegacy.role = 'Taker';
  const contra = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, contraLegacy);
  const contraScenario = decodeCanonicalOrdersPortfolioScenario(contra, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, contraScenario));

  const uninvertedRole = clone(contra);
  focus(uninvertedRole).liquidityRole =
    'https://axiolune.ai/ontology/finance/orders-execution/LiquidityRole/value/maker';
  const uninvertedScenario = decodeCanonicalOrdersPortfolioScenario(
    uninvertedRole,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, uninvertedScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIQUIDITY_REQUIRED',
  );
});

test('execution liquidity completeness replays the sole determination instead of counting a shallow link', () => {
  const vector = vectorByEvaluator(vectors, 'ExecutionLiquidityDeterminationCompletenessContract');
  const stream = {
    logicalIri: 'https://axiolune.ai/data/order-stream/1',
    referenceMode: 'version',
    versionIri: 'https://axiolune.ai/data/order-stream/1/version/0',
  };
  const requiredLegacy = {
    determinations: [{
      capability: 'required',
      outcome: 'classified',
      perspective: 'executionAccountOrder',
      rawValue: 'M',
      role: 'Maker',
      sourceRecord: { liquidity: 'M' },
      stream,
    }],
    executionStream: stream,
  };
  const required = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, requiredLegacy);
  const requiredScenario = decodeCanonicalOrdersPortfolioScenario(
    required,
    vector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, requiredScenario));

  const deepSourceTamper = clone(required);
  const sourceArtifact = deepSourceTamper.artifacts.find(
    (row) => row.artifactRef.iri.includes('/source-records/liquidity/'),
  );
  sourceArtifact.payload.liquidity = 'T';
  sourceArtifact.artifactDigest = sha256Jcs(sourceArtifact.payload);
  deepSourceTamper.records.find((row) => row.typeIri === TYPES.LiquidityRoleDetermination)
    .sourceRecordDigest = sourceArtifact.artifactDigest;
  const deepTamperScenario = decodeCanonicalOrdersPortfolioScenario(
    deepSourceTamper,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, deepTamperScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'LIQUIDITY_REQUIRED',
  );

  const duplicate = clone(required);
  const duplicateDetermination = clone(
    duplicate.records.find((row) => row.typeIri === TYPES.LiquidityRoleDetermination),
  );
  duplicateDetermination.versionIri =
    'https://axiolune.ai/data/liquidity-determination/duplicate/version/0';
  duplicate.records.push(duplicateDetermination);
  duplicate.records.sort((left, right) => Buffer.compare(
    Buffer.from(left.versionIri),
    Buffer.from(right.versionIri),
  ));
  const duplicateScenario = decodeCanonicalOrdersPortfolioScenario(
    duplicate,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, duplicateScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'EXECUTION_LIQUIDITY_COMPLETENESS',
  );

  const wrongStream = clone(required);
  const existingStream = wrongStream.records.find((row) => row.typeIri === TYPES.OrderEventStream);
  const otherStream = clone(existingStream);
  otherStream.versionIri = 'https://axiolune.ai/data/order-stream/other/version/0';
  wrongStream.records.push(otherStream);
  wrongStream.records.find((row) => row.typeIri === TYPES.LiquidityRoleDetermination)
    .determinationStream = otherStream.versionIri;
  wrongStream.records.sort((left, right) => Buffer.compare(
    Buffer.from(left.versionIri),
    Buffer.from(right.versionIri),
  ));
  const wrongStreamScenario = decodeCanonicalOrdersPortfolioScenario(
    wrongStream,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, wrongStreamScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'EXECUTION_LIQUIDITY_COMPLETENESS',
  );

  for (const [capability, absenceReason, pointer] of [
    ['optional', 'providerNotSpecified', '/missing'],
    ['unsupported', 'contractUnsupported', '/liquidity'],
  ]) {
    const unavailable = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, {
      determinations: [{
        absenceReason,
        capability,
        outcome: 'unavailable',
        perspective: 'executionAccountOrder',
        pointer,
        sourceRecord: {},
        stream,
      }],
      executionStream: stream,
    });
    const unavailableScenario = decodeCanonicalOrdersPortfolioScenario(
      unavailable,
      vector.validatorId,
      inputContract,
    );
    assert.doesNotThrow(() => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      unavailableScenario,
    ));
  }
});

test('Fee closes kind, positive Money magnitude, effect, identity, assessor, and source evidence', () => {
  const vector = vectorByEvaluator(vectors, 'FeeContract');
  const accepted = clone(vector.accepted.scenario);
  const acceptedScenario = decodeCanonicalOrdersPortfolioScenario(
    accepted,
    vector.validatorId,
    inputContract,
  );
  assert.equal(acceptedScenario.feeKind, 'commission');
  assert.equal(acceptedScenario.amountCurrency, 'USD');
  assert.doesNotThrow(() => validateConstraint(
    vector.constraintIri,
    vector.validatorId,
    acceptedScenario,
  ));

  const reviewedKind = clone(accepted);
  focus(reviewedKind).feeKind =
    'https://axiolune.ai/ontology/finance/orders-execution/FeeKind/value/regulatory';
  const reviewedKindScenario = decodeCanonicalOrdersPortfolioScenario(
    reviewedKind,
    vector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(
    vector.constraintIri,
    vector.validatorId,
    reviewedKindScenario,
  ));

  const emptyId = clone(accepted);
  focus(emptyId).feeId = '';
  const emptyIdScenario = decodeCanonicalOrdersPortfolioScenario(
    emptyId,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, emptyIdScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'FEE_IDENTITY',
  );

  const missingEvidence = clone(accepted);
  focus(missingEvidence).sourceArtifactDigest = `sha256:${'0'.repeat(64)}`;
  focus(missingEvidence).sourceLocator.selectionDigest = `sha256:${'0'.repeat(64)}`;
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(
      missingEvidence,
      vector.validatorId,
      inputContract,
    ),
    'orders-portfolio-canonical-source-artifact-join',
  );

  const unknownKind = clone(accepted);
  focus(unknownKind).feeKind =
    'https://axiolune.ai/ontology/finance/orders-execution/FeeKind/value/unreviewed';
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(unknownKind, vector.validatorId, inputContract),
    'orders-portfolio-canonical-code-value',
  );
});

test('status mappings bind the complete provider/raw/version/reviewer identity and vocabulary scope', () => {
  const vector = vectorByEvaluator(vectors, 'ExternalOrderStatusMappingContract');
  const accepted = clone(vector.accepted.scenario);
  const acceptedScenario = decodeCanonicalOrdersPortfolioScenario(
    accepted,
    vector.validatorId,
    inputContract,
  );
  assert.equal(acceptedScenario.rawStatusCode, 'ACCEPTED');
  assert.equal(acceptedScenario.mappingVersion, '1.0');
  assert.equal(acceptedScenario.reviewer.referenceMode, 'logical');
  assert.doesNotThrow(() => validateConstraint(
    vector.constraintIri,
    vector.validatorId,
    acceptedScenario,
  ));

  for (const field of ['rawStatusCode', 'statusMappingVersion']) {
    const missingIdentity = clone(accepted);
    focus(missingIdentity)[field] = '';
    const missingIdentityScenario = decodeCanonicalOrdersPortfolioScenario(
      missingIdentity,
      vector.validatorId,
      inputContract,
    );
    assert.throws(
      () => validateConstraint(vector.constraintIri, vector.validatorId, missingIdentityScenario),
      (cause) => cause instanceof CustomConstraintViolation
        && cause.code === 'STATUS_MAPPING_IDENTITY',
    );
  }

  const reviewEvidenceTamper = clone(accepted);
  focus(reviewEvidenceTamper).reviewDecisionDigest = `sha256:${'0'.repeat(64)}`;
  const reviewEvidenceScenario = decodeCanonicalOrdersPortfolioScenario(
    reviewEvidenceTamper,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, reviewEvidenceScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'STATUS_MAPPING_EVIDENCE',
  );

  const scopeMismatch = clone(accepted);
  focus(scopeMismatch).providerApiIdentifier = 'api-v2';
  const scopeMismatchScenario = decodeCanonicalOrdersPortfolioScenario(
    scopeMismatch,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, scopeMismatchScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'STATUS_MAPPING_SCOPE',
  );

  const unknownState = clone(accepted);
  focus(unknownState).canonicalLifecycleState =
    'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleState/value/unreviewed';
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(unknownState, vector.validatorId, inputContract),
    'orders-portfolio-canonical-code-value',
  );
});

test('OrderEventIntegrityFinding executes all six strict subjects and rejects branch, byte, set, and proof substitutions', () => {
  const vector = vectorByEvaluator(vectors, 'OrderEventIntegrityFindingContract');
  const baseline = decodeCanonicalOrdersPortfolioScenario(
    vector.accepted.scenario,
    vector.validatorId,
    inputContract,
  );
  const branchSources = {
    duplicateConflict: {
      findingSubject: { providerEventId: 'duplicate-provider-event-1' },
      kind: 'duplicateConflict',
    },
    sequenceGap: {
      findingSubject: { missingFrom: 2, missingTo: 4 },
      kind: 'sequenceGap',
    },
    outOfOrder: {
      findingSubject: { observedKey: 2, requiredPredecessorKey: 5 },
      kind: 'outOfOrder',
    },
    lateFill: {
      findingSubject: {
        fillVersionIri: 'https://axiolune.ai/data/execution/finding-late/version/0',
        terminalEventVersionIri:
          'https://axiolune.ai/data/event/finding-terminal/version/0',
      },
      kind: 'lateFill',
    },
    missingAcknowledgement: {
      findingSubject: {
        expectedAfterKey: 3,
        externalOrderVersionIri:
          'https://axiolune.ai/data/external-order/finding-missing-ack/version/0',
      },
      kind: 'missingAcknowledgement',
    },
    transitionViolation: {
      findingSubject: {
        fromEventVersionIri:
          'https://axiolune.ai/data/event/finding-transition-from/version/0',
        toEventVersionIri:
          'https://axiolune.ai/data/event/finding-transition-to/version/0',
        transitionProfileVersionIri:
          'https://axiolune.ai/data/transition-profile/finding/version/0',
      },
      kind: 'transitionViolation',
    },
  };
  const documents = {};
  for (const [kind, source] of Object.entries(branchSources)) {
    const document = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, {
      ...clone(source),
      stream: baseline.stream,
      temporal: baseline.temporal,
    });
    const scenario = decodeCanonicalOrdersPortfolioScenario(
      document,
      vector.validatorId,
      inputContract,
    );
    assert.equal(scenario.kind, kind);
    assert.equal(
      scenario.affectedKeyDigest,
      sha256DomainJcs('axiolune-order-finding-subject-v1', scenario.findingSubject),
    );
    assert.equal(
      scenario.relatedVersionSetDigest,
      iriSetDigest(scenario.relatedVersions),
    );
    assert.doesNotThrow(() => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      scenario,
    ));
    documents[kind] = document;
  }

  const affectedDigestSubstitution = clone(documents.sequenceGap);
  focus(affectedDigestSubstitution).affectedKeyDigest = `sha256:${'0'.repeat(64)}`;
  const affectedDigestScenario = decodeCanonicalOrdersPortfolioScenario(
    affectedDigestSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      affectedDigestScenario,
    ),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_AFFECTED_DIGEST',
  );

  const mixedBranch = clone(documents.sequenceGap);
  focus(mixedBranch).observedSourceOrderKey = 2;
  const mixedBranchScenario = decodeCanonicalOrdersPortfolioScenario(
    mixedBranch,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, mixedBranchScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_SEQUENCE_GAP',
  );

  const relatedDigestSubstitution = clone(documents.outOfOrder);
  focus(relatedDigestSubstitution).relatedVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  const relatedDigestScenario = decodeCanonicalOrdersPortfolioScenario(
    relatedDigestSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, relatedDigestScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_RELATED_DIGEST',
  );

  const duplicatedRelation = clone(documents.sequenceGap);
  focus(duplicatedRelation).relatedLifecycleEvent.push(
    focus(duplicatedRelation).relatedLifecycleEvent[0],
  );
  const duplicatedRelationScenario = decodeCanonicalOrdersPortfolioScenario(
    duplicatedRelation,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      duplicatedRelationScenario,
    ),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_SUBJECT',
  );

  const identicalRetry = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, {
    findingSubject: { providerEventId: 'identical-retry-1' },
    kind: 'duplicateConflict',
    relatedLifecycleEvents: [
      {
        kind: 'Accepted',
        lifecycleState: 'Accepted',
        providerEventId: 'identical-retry-1',
        sourceOrderKey: 1,
        versionIri: 'https://axiolune.ai/data/event/identical-retry-a/version/0',
      },
      {
        kind: 'Accepted',
        lifecycleState: 'Accepted',
        providerEventId: 'identical-retry-1',
        sourceOrderKey: 1,
        versionIri: 'https://axiolune.ai/data/event/identical-retry-b/version/0',
      },
    ],
    stream: baseline.stream,
    temporal: baseline.temporal,
  });
  const identicalRetryScenario = decodeCanonicalOrdersPortfolioScenario(
    identicalRetry,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      identicalRetryScenario,
    ),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_DUPLICATE_CONFLICT',
  );

  const boundarySubstitution = clone(documents.sequenceGap);
  const gapAfter = boundarySubstitution.records.find(
    (row) => row.versionIri
      === 'https://axiolune.ai/data/event/finding-gap-after/version/0',
  );
  gapAfter.sourceOrderKey = 5;
  const boundaryScenario = decodeCanonicalOrdersPortfolioScenario(
    boundarySubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, boundaryScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_SEQUENCE_GAP',
  );

  const lateOrderingSubstitution = clone(documents.lateFill);
  const fillExecution = lateOrderingSubstitution.records.find(
    (row) => row.versionIri
      === branchSources.lateFill.findingSubject.fillVersionIri,
  );
  fillExecution.observedAt = '2025-01-01T00:00:00.050000000Z';
  const lateOrderingScenario = decodeCanonicalOrdersPortfolioScenario(
    lateOrderingSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, lateOrderingScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_LATE_FILL',
  );

  const acknowledgementSubstitution = clone(documents.missingAcknowledgement);
  const submitted = acknowledgementSubstitution.records.find(
    (row) => row.typeIri === TYPES.OrderLifecycleEvent,
  );
  submitted.orderEventKind =
    'https://axiolune.ai/ontology/finance/orders-execution/OrderEventKind/value/Accepted';
  submitted.lifecycleState =
    'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleState/value/Accepted';
  const acknowledgementScenario = decodeCanonicalOrdersPortfolioScenario(
    acknowledgementSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, acknowledgementScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_MISSING_ACKNOWLEDGEMENT',
  );

  const transitionSubstitution = clone(documents.transitionViolation);
  const transitionProfile = transitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.OrderTransitionProfile,
  );
  const transitionInput = transitionSubstitution.artifacts.find(
    (row) => row.artifactDigest === transitionProfile.inputContractDigest,
  );
  transitionInput.payload.allowedTransitions.Accepted = ['Canceled'];
  transitionInput.artifactDigest = sha256Jcs(transitionInput.payload);
  transitionProfile.inputContractDigest = transitionInput.artifactDigest;
  const transitionScenario = decodeCanonicalOrdersPortfolioScenario(
    transitionSubstitution,
    vector.validatorId,
    inputContract,
  );
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, transitionScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'FINDING_TRANSITION_VIOLATION',
  );
});

test('Execution truth joins and PositionValuation arithmetic are derived from official graph records', () => {
  const executionVector = vectorByEvaluator(vectors, 'ExecutionContract');
  const executionDocument = clone(executionVector.accepted.scenario);
  const intent = executionDocument.records.find((row) => row.typeIri === TYPES.OrderIntent);
  intent.intentAccount = 'https://axiolune.ai/data/account/other';
  const executionScenario = decodeCanonicalOrdersPortfolioScenario(
    executionDocument,
    executionVector.validatorId,
    inputContract,
  );
  assert.equal(executionScenario.account.logicalIri, 'https://axiolune.ai/data/account/1');
  assert.equal(executionScenario.intentAccountIri, 'https://axiolune.ai/data/account/other');
  assert.throws(
    () => validateConstraint(executionVector.constraintIri, executionVector.validatorId, executionScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'EXECUTION_TRUTH_JOIN',
  );

  const valuationVector = vectorByEvaluator(vectors, 'PositionValuationContract');
  const valuationDocument = clone(valuationVector.accepted.scenario);
  const price = valuationDocument.records.find((row) => row.typeIri === TYPES.PriceObservation);
  price.priceValue.amount = '0.000004';
  const valuationScenario = decodeCanonicalOrdersPortfolioScenario(
    valuationDocument,
    valuationVector.validatorId,
    inputContract,
  );
  assert.equal(valuationScenario.priceMicros, 4);
  assert.throws(
    () => validateConstraint(valuationVector.constraintIri, valuationVector.validatorId, valuationScenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === 'POSITION_VALUATION_ARITHMETIC',
  );

  const quotation = valuationDocument.records.find((row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract);
  assert.equal(quotation.quotationKind, 'https://axiolune.ai/ontology/finance/instruments/QuotationKind/value/directUnitPrice');
  assert.equal(price.priceKind, 'https://axiolune.ai/ontology/finance/market-data/PriceKind/value/reference/close');
});

function acceptedValuationLegacy() {
  const vector = vectorByEvaluator(vectors, 'PositionValuationContract');
  return decodeCanonicalOrdersPortfolioScenario(
    clone(vector.accepted.scenario),
    vector.validatorId,
    inputContract,
  );
}

function assertValuationViolation(document, expectedCode) {
  const vector = vectorByEvaluator(vectors, 'PositionValuationContract');
  const scenario = decodeCanonicalOrdersPortfolioScenario(document, vector.validatorId, inputContract);
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === expectedCode,
  );
}

test('PositionValuation uses scale-aware BigInt arithmetic and rejects the former one-million-times result', () => {
  const vector = vectorByEvaluator(vectors, 'PositionValuationContract');
  const normal = decodeCanonicalOrdersPortfolioScenario(
    vector.accepted.scenario,
    vector.validatorId,
    inputContract,
  );
  assert.equal(normal.quantityMicros, 2_000_000);
  assert.equal(normal.priceMicros, 3_000_000);
  assert.equal(normal.marketValueMicros, 6_000_000);

  const subMicro = acceptedValuationLegacy();
  subMicro.quantityMicros = 2;
  subMicro.priceMicros = 3;
  subMicro.marketValueMicros = 0;
  const correctDocument = encodeCanonicalOrdersPortfolioScenario('PositionValuationContract', subMicro);
  const correctScenario = decodeCanonicalOrdersPortfolioScenario(
    correctDocument,
    'PositionValuationContract',
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, correctScenario));

  subMicro.marketValueMicros = 6;
  assertValuationViolation(
    encodeCanonicalOrdersPortfolioScenario('PositionValuationContract', subMicro),
    'POSITION_VALUATION_ARITHMETIC',
  );
});

test('PositionValuation replays the exact definition policies and both FX directions', () => {
  const vector = vectorByEvaluator(vectors, 'PositionValuationContract');
  const baseToQuote = acceptedValuationLegacy();
  baseToQuote.reportingCurrency = 'EUR';
  baseToQuote.marketValueMicros = 12_000_000;
  baseToQuote.fx = {
    baseCurrency: 'USD',
    direction: 'baseToQuote',
    inputContext: {
      digest: sha256Jcs({
        completedAt: '2025-01-01T00:00:00Z',
        contextId: 'fx-input-1',
        schemaVersion: '1.0',
        status: 'completed',
      }),
      payload: {
        completedAt: '2025-01-01T00:00:00Z',
        contextId: 'fx-input-1',
        schemaVersion: '1.0',
        status: 'completed',
      },
      ref: 'https://axiolune.ai/contexts/fx-input/1',
    },
    inputCurrency: 'USD',
    outputCurrency: 'EUR',
    quoteCurrency: 'EUR',
    ratePpm: 2_000_000,
  };
  const baseDocument = encodeCanonicalOrdersPortfolioScenario('PositionValuationContract', baseToQuote);
  const baseScenario = decodeCanonicalOrdersPortfolioScenario(baseDocument, 'PositionValuationContract', inputContract);
  assert.equal(baseScenario.fx.inputMicros, 6_000_000, 'FX input must be the pre-FX line value, not the unit price');
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, baseScenario));

  const quoteToBase = acceptedValuationLegacy();
  quoteToBase.priceCurrency = 'EUR';
  quoteToBase.reportingCurrency = 'USD';
  quoteToBase.marketValueMicros = 3_000_000;
  quoteToBase.fx = {
    ...clone(baseToQuote.fx),
    direction: 'quoteToBase',
    inputCurrency: 'EUR',
    outputCurrency: 'USD',
  };
  const quoteDocument = encodeCanonicalOrdersPortfolioScenario('PositionValuationContract', quoteToBase);
  const quoteScenario = decodeCanonicalOrdersPortfolioScenario(quoteDocument, 'PositionValuationContract', inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, quoteScenario));
});

test('valuation definitions close one-or-more quotation versions and lines select a member', () => {
  const definitionVector = vectorByEvaluator(vectors, 'ValuationCalculationDefinitionContract');
  const definitionDocument = clone(definitionVector.accepted.scenario);
  const definition = focus(definitionDocument);
  const secondQuotationVersionIri = 'https://axiolune.ai/data/quotation/2/version/0';
  const definitionQuotation = definitionDocument.records.find(
    (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
  );
  assert.ok(definitionQuotation, 'accepted valuation definition must include its quotation record');
  definitionDocument.records.push({
    ...clone(definitionQuotation),
    versionIri: secondQuotationVersionIri,
  });
  definition.valuationDefinitionQuotationContract = [
    ...definition.valuationDefinitionQuotationContract,
    secondQuotationVersionIri,
  ].sort();
  definition.valuationQuotationContractCount = 2;
  definition.valuationQuotationContractVersionSetDigest =
    iriSetDigest(definition.valuationDefinitionQuotationContract);
  const decodedDefinition = decodeCanonicalOrdersPortfolioScenario(
    definitionDocument,
    definitionVector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(
    definitionVector.constraintIri,
    definitionVector.validatorId,
    decodedDefinition,
  ));

  const valuationVector = vectorByEvaluator(vectors, 'PositionValuationContract');
  const valuationDocument = clone(valuationVector.accepted.scenario);
  const valuationDefinition = valuationDocument.records.find(
    (row) => row.typeIri === TYPES.ValuationCalculationDefinition,
  );
  const valuationQuotation = valuationDocument.records.find(
    (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
  );
  assert.ok(valuationQuotation, 'accepted valuation must include its selected quotation record');
  valuationDocument.records.push({
    ...clone(valuationQuotation),
    versionIri: secondQuotationVersionIri,
  });
  valuationDefinition.valuationDefinitionQuotationContract = [
    ...valuationDefinition.valuationDefinitionQuotationContract,
    secondQuotationVersionIri,
  ].sort();
  valuationDefinition.valuationQuotationContractCount = 2;
  valuationDefinition.valuationQuotationContractVersionSetDigest =
    iriSetDigest(valuationDefinition.valuationDefinitionQuotationContract);
  const decodedValuation = decodeCanonicalOrdersPortfolioScenario(
    valuationDocument,
    valuationVector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(
    valuationVector.constraintIri,
    valuationVector.validatorId,
    decodedValuation,
  ));

  const countTamper = clone(valuationDocument);
  countTamper.records.find((row) => row.typeIri === TYPES.ValuationCalculationDefinition)
    .valuationQuotationContractCount = 1;
  assertValuationViolation(countTamper, 'POSITION_VALUATION_DEFINITION');

  const digestTamper = clone(valuationDocument);
  digestTamper.records.find((row) => row.typeIri === TYPES.ValuationCalculationDefinition)
    .valuationQuotationContractVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  assertValuationViolation(digestTamper, 'POSITION_VALUATION_DEFINITION');
});

test('PositionValuation fails closed on policy, definition, FX rate/input/direction, reverse-link, PIT, and context tampering', () => {
  const vector = vectorByEvaluator(vectors, 'PositionValuationContract');
  const source = acceptedValuationLegacy();
  source.reportingCurrency = 'EUR';
  source.marketValueMicros = 12_000_000;
  source.fx = {
    baseCurrency: 'USD',
    direction: 'baseToQuote',
    inputContext: {
      digest: sha256Jcs({
        completedAt: '2025-01-01T00:00:00Z',
        contextId: 'fx-input-1',
        schemaVersion: '1.0',
        status: 'completed',
      }),
      payload: {
        completedAt: '2025-01-01T00:00:00Z',
        contextId: 'fx-input-1',
        schemaVersion: '1.0',
        status: 'completed',
      },
      ref: 'https://axiolune.ai/contexts/fx-input/1',
    },
    inputCurrency: 'USD',
    outputCurrency: 'EUR',
    quoteCurrency: 'EUR',
    ratePpm: 2_000_000,
  };
  const canonical = encodeCanonicalOrdersPortfolioScenario('PositionValuationContract', source);

  const wrongDefinitionQuotation = clone(canonical);
  const definition = wrongDefinitionQuotation.records.find((row) => row.typeIri === TYPES.ValuationCalculationDefinition);
  definition.valuationDefinitionQuotationContract = ['https://axiolune.ai/data/quotation/other/version/0'];
  definition.valuationQuotationContractVersionSetDigest =
    iriSetDigest(definition.valuationDefinitionQuotationContract);
  assertValuationViolation(wrongDefinitionQuotation, 'POSITION_VALUATION_DEFINITION');

  const wrongInput = clone(canonical);
  wrongInput.records.find((row) => row.typeIri === TYPES.FXConversion).inputMoney.amount = '5.000000';
  assertValuationViolation(wrongInput, 'POSITION_VALUATION_FX');

  const wrongRate = clone(canonical);
  wrongRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).fxRate.numericValue = '3.000000';
  assertValuationViolation(wrongRate, 'POSITION_VALUATION_ARITHMETIC');

  const wrongDirection = clone(canonical);
  wrongDirection.records.find((row) => row.typeIri === TYPES.FXConversion).fxConversionDirection =
    'https://axiolune.ai/ontology/finance/portfolio-positions/FXConversionDirection/value/quoteToBase';
  assertValuationViolation(wrongDirection, 'POSITION_VALUATION_FX');

  const wrongReverseLink = clone(canonical);
  wrongReverseLink.records.find((row) => row.typeIri === TYPES.FXConversion).conversionValuationLine =
    'https://axiolune.ai/data/valuation/other/version/0';
  assertValuationViolation(wrongReverseLink, 'POSITION_VALUATION_FX');

  const futureRate = clone(canonical);
  futureRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).availableFrom = '2025-01-02T00:00:00Z';
  assertValuationViolation(futureRate, 'POSITION_VALUATION_FX');

  const nanosecondFutureRate = clone(canonical);
  const futureRateConsumer = focus(nanosecondFutureRate);
  futureRateConsumer.availableFrom = '2025-01-01T00:00:02.000000001Z';
  nanosecondFutureRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).availableFrom =
    '2025-01-01T00:00:02.000000002Z';
  assertValuationViolation(nanosecondFutureRate, 'POSITION_VALUATION_FX');

  const nanosecondPriorRate = clone(canonical);
  const priorRateConsumer = focus(nanosecondPriorRate);
  priorRateConsumer.availableFrom = '2025-01-01T00:00:02.000000002Z';
  nanosecondPriorRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).availableFrom =
    '2025-01-01T00:00:02.000000001Z';
  const priorRateScenario = decodeCanonicalOrdersPortfolioScenario(
    nanosecondPriorRate,
    vector.validatorId,
    inputContract,
  );
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, priorRateScenario));

  const lateContext = clone(canonical);
  const fx = lateContext.records.find((row) => row.typeIri === TYPES.FXConversion);
  const contextArtifact = lateContext.artifacts.find((row) => row.artifactRef.iri === fx.inputContextRef);
  contextArtifact.payload.completedAt = '2025-01-02T00:00:00Z';
  contextArtifact.artifactDigest = sha256Jcs(contextArtifact.payload);
  fx.inputContextRecordDigest = contextArtifact.artifactDigest;
  assertValuationViolation(lateContext, 'POSITION_VALUATION_FX');

  const nanosecondLateContext = clone(canonical);
  focus(nanosecondLateContext).availableFrom = '2025-01-01T00:00:02.000000001Z';
  const nanosecondFx = nanosecondLateContext.records.find((row) => row.typeIri === TYPES.FXConversion);
  const nanosecondContextArtifact = nanosecondLateContext.artifacts.find(
    (row) => row.artifactRef.iri === nanosecondFx.inputContextRef,
  );
  nanosecondContextArtifact.payload.completedAt = '2025-01-01T00:00:02.000000002Z';
  nanosecondContextArtifact.artifactDigest = sha256Jcs(nanosecondContextArtifact.payload);
  nanosecondFx.inputContextRecordDigest = nanosecondContextArtifact.artifactDigest;
  assertValuationViolation(nanosecondLateContext, 'POSITION_VALUATION_FX');

  const invalidPolicy = clone(canonical);
  const invalidDefinition = invalidPolicy.records.find((row) => row.typeIri === TYPES.ValuationCalculationDefinition);
  const roundingArtifact = invalidPolicy.artifacts.find((row) => row.artifactRef.iri === invalidDefinition.roundingPolicyRef);
  roundingArtifact.payload.stages = ['fx-conversion'];
  roundingArtifact.artifactDigest = sha256Jcs(roundingArtifact.payload);
  invalidDefinition.roundingPolicyDigest = roundingArtifact.artifactDigest;
  invalidPolicy.records.find((row) => row.typeIri === TYPES.FXConversion).roundingPolicyDigest = roundingArtifact.artifactDigest;
  assertValuationViolation(invalidPolicy, 'POSITION_VALUATION_POLICY');

  const digestOnlyTamper = clone(canonical);
  digestOnlyTamper.records.find((row) => row.typeIri === TYPES.ValuationCalculationDefinition).precisionPolicyDigest =
    `sha256:${'0'.repeat(64)}`;
  assertCanonicalFailure(
    () => decodeCanonicalOrdersPortfolioScenario(digestOnlyTamper, 'PositionValuationContract', inputContract),
    'orders-portfolio-canonical-artifact-reference',
  );
});

test('PositionLotStateClosure accepts half-even replay and rejects a coherently rebound half-up policy', () => {
  const vector = vectorByEvaluator(vectors, 'PositionLotStateClosureContract');
  const legacy = decodeCanonicalOrdersPortfolioScenario(
    vector.accepted.scenario,
    vector.validatorId,
    inputContract,
  );
  legacy.lots = [{ consumedQuantityMicros: 1, openingCostBasisMicros: 1, originalQuantityMicros: 2 }];
  legacy.remainingQuantityMicros = 1;
  legacy.remainingCostBasisMicros = 0;
  delete legacy.lotProbe;
  delete legacy.allocationProbe;
  const halfEven = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, legacy);
  const halfEvenScenario = decodeCanonicalOrdersPortfolioScenario(halfEven, vector.validatorId, inputContract);
  assert.doesNotThrow(
    () => validateConstraint(vector.constraintIri, vector.validatorId, halfEvenScenario),
  );

  const halfUp = clone(halfEven);
  const definition = halfUp.records.find((row) => row.typeIri === TYPES.CostBasisCalculationDefinition);
  const policy = halfUp.artifacts.find((row) => row.artifactRef.iri === definition.roundingPolicyRef);
  policy.payload.mode = 'half-up';
  policy.artifactDigest = sha256Jcs(policy.payload);
  definition.roundingPolicyDigest = policy.artifactDigest;
  const halfUpScenario = decodeCanonicalOrdersPortfolioScenario(halfUp, vector.validatorId, inputContract);
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, halfUpScenario),
    (cause) => cause instanceof CustomConstraintViolation
      && cause.code === 'LOT_STATE_REMAINING',
  );
});

function acceptedPositionLotLegacy() {
  const vector = vectorByEvaluator(vectors, 'PositionLotContract');
  return decodeCanonicalOrdersPortfolioScenario(
    clone(vector.accepted.scenario),
    vector.validatorId,
    inputContract,
  );
}

function assertPositionLotViolation(document, expectedCode) {
  const vector = vectorByEvaluator(vectors, 'PositionLotContract');
  const scenario = decodeCanonicalOrdersPortfolioScenario(document, vector.validatorId, inputContract);
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
    (cause) => cause instanceof CustomConstraintViolation && cause.code === expectedCode,
  );
}

test('PositionLot replays opening gross from exact Execution, quotation, definition, and policy', () => {
  const vector = vectorByEvaluator(vectors, 'PositionLotContract');
  const accepted = acceptedPositionLotLegacy();
  assert.equal(accepted.originalQuantityMicros, 2_000_000);
  assert.equal(accepted.executionPriceMicros, 3_000_000);
  assert.equal(accepted.openingGrossMicros, 6_000_000);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, accepted));

  const wrongPrice = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, accepted);
  wrongPrice.records.find((row) => row.typeIri === TYPES.Execution).executionPrice.amount = '4.000000';
  assertPositionLotViolation(wrongPrice, 'POSITION_LOT_GROSS');

  const wrongQuotation = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, accepted);
  wrongQuotation.records.find((row) => row.typeIri === TYPES.CostBasisCalculationDefinition)
    .costBasisDefinitionQuotationContract = 'https://axiolune.ai/data/quotation/other/version/0';
  assertPositionLotViolation(wrongQuotation, 'POSITION_LOT_JOIN');

  const halfEven = acceptedPositionLotLegacy();
  halfEven.originalQuantityMicros = 5;
  halfEven.executionPriceMicros = 500_000;
  halfEven.openingGrossMicros = 2;
  halfEven.openingCostBasisMicros = 2;
  const halfEvenDocument = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, halfEven);
  const halfEvenScenario = decodeCanonicalOrdersPortfolioScenario(halfEvenDocument, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, halfEvenScenario));

  const halfUpDocument = clone(halfEvenDocument);
  const definition = halfUpDocument.records.find((row) => row.typeIri === TYPES.CostBasisCalculationDefinition);
  const rounding = halfUpDocument.artifacts.find((row) => row.artifactRef.iri === definition.roundingPolicyRef);
  rounding.payload.mode = 'half-up';
  rounding.artifactDigest = sha256Jcs(rounding.payload);
  definition.roundingPolicyDigest = rounding.artifactDigest;
  assertPositionLotViolation(halfUpDocument, 'POSITION_LOT_GROSS');
});

test('PositionLot enforces both FX directions, exact pre-FX input, rate, reverse link, PIT, and context', () => {
  const vector = vectorByEvaluator(vectors, 'PositionLotContract');
  const contextPayload = {
    completedAt: '2025-01-01T00:00:00Z',
    contextId: 'fx-input-1',
    schemaVersion: '1.0',
    status: 'completed',
  };
  const baseToQuote = acceptedPositionLotLegacy();
  baseToQuote.basisCurrency = 'EUR';
  baseToQuote.costBasisDefinition.basisCurrency = 'EUR';
  baseToQuote.openingGrossMicros = 12_000_000;
  baseToQuote.openingCostBasisMicros = 12_000_000;
  baseToQuote.fxConversion = {
    baseCurrency: 'USD',
    direction: 'baseToQuote',
    inputContext: {
      digest: sha256Jcs(contextPayload),
      payload: contextPayload,
      ref: 'https://axiolune.ai/contexts/fx-input/1',
    },
    inputCurrency: 'USD',
    outputCurrency: 'EUR',
    quoteCurrency: 'EUR',
    ratePpm: 2_000_000,
  };
  const baseDocument = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, baseToQuote);
  const baseScenario = decodeCanonicalOrdersPortfolioScenario(baseDocument, vector.validatorId, inputContract);
  assert.equal(baseScenario.fxConversion.inputMicros, 6_000_000);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, baseScenario));

  const quoteToBase = acceptedPositionLotLegacy();
  quoteToBase.executionCurrency = 'EUR';
  quoteToBase.openingGrossMicros = 3_000_000;
  quoteToBase.openingCostBasisMicros = 3_000_000;
  quoteToBase.fxConversion = {
    ...clone(baseToQuote.fxConversion),
    direction: 'quoteToBase',
    inputCurrency: 'EUR',
    outputCurrency: 'USD',
  };
  const quoteDocument = encodeCanonicalOrdersPortfolioScenario(vector.validatorId, quoteToBase);
  const quoteScenario = decodeCanonicalOrdersPortfolioScenario(quoteDocument, vector.validatorId, inputContract);
  assert.doesNotThrow(() => validateConstraint(vector.constraintIri, vector.validatorId, quoteScenario));

  const inputSubstitution = clone(baseDocument);
  inputSubstitution.records.find((row) => row.typeIri === TYPES.FXConversion).inputMoney.amount = '5.000000';
  assertPositionLotViolation(inputSubstitution, 'POSITION_LOT_FX');

  const rateSubstitution = clone(baseDocument);
  rateSubstitution.records.find((row) => row.typeIri === TYPES.FXRateObservation).fxRate.numericValue = '3.000000';
  assertPositionLotViolation(rateSubstitution, 'POSITION_LOT_GROSS');

  const reverseLink = clone(baseDocument);
  reverseLink.records.find((row) => row.typeIri === TYPES.FXConversion).conversionOpeningLot =
    'https://axiolune.ai/data/lot/other/version/0';
  assertPositionLotViolation(reverseLink, 'POSITION_LOT_FX');

  const futureRate = clone(baseDocument);
  futureRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).knowledgeFrom = '2025-01-02T00:00:00Z';
  assertPositionLotViolation(futureRate, 'POSITION_LOT_FX');

  const lateContext = clone(baseDocument);
  const fx = lateContext.records.find((row) => row.typeIri === TYPES.FXConversion);
  const context = lateContext.artifacts.find((row) => row.artifactRef.iri === fx.inputContextRef);
  context.payload.completedAt = '2025-01-02T00:00:00Z';
  context.artifactDigest = sha256Jcs(context.payload);
  fx.inputContextRecordDigest = context.artifactDigest;
  assertPositionLotViolation(lateContext, 'POSITION_LOT_FX');
});
