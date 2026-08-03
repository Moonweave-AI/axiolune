'use strict';

const {
  buildVerifierOwnedPitIngress,
  canonicalJcs,
  controlRecordIri,
  instantNanoseconds,
  iriSetDigest,
  mappingClosureDigest,
  rdfGraphDigest,
  sha256DomainJcs,
  sha256Jcs,
  sourceSchemaClosureDigest,
  sourceSnapshotRootDigest,
  taggedJcsDigest,
} = require('./orders-portfolio-custom-validators.cjs');
const {
  DEFAULT_COST_BASIS_PRECISION_POLICY,
  DEFAULT_COST_BASIS_ROUNDING_POLICY,
  DEFAULT_VALUATION_PRECISION_POLICY,
  DEFAULT_VALUATION_ROUNDING_POLICY,
  costBasisDirectUnitValueRaw,
  directUnitValueRaw,
  fxValueRaw,
  safeNumber,
} = require('./orders-portfolio-exact-arithmetic.cjs');
const {
  loadGeneratedReferenceRegistry,
  validateReferenceRegistry,
} = require('./orders-portfolio-reference-registry.cjs');
const {
  canonicalJcs: strictCanonicalJcs,
  computeSelectionDigest,
  validateSourceLocator: validateStrictSourceLocator,
} = require('./strict-source-locator.cjs');

const ORDERS = 'https://axiolune.ai/ontology/finance/orders-execution/';
const PORTFOLIO = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
const INSTRUMENTS = 'https://axiolune.ai/ontology/finance/instruments/';
const MARKET_DATA = 'https://axiolune.ai/ontology/finance/market-data/';
const DATA = 'https://axiolune.ai/data/';
const UNIT = 'https://axiolune.ai/units/';
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u;
const SOURCE_EXTRACTOR_PROFILE_REF =
  'https://axiolune.ai/extractors/orders-portfolio-canonical-whole-file/v1';
const SOURCE_EXTRACTOR_PROFILE_PAYLOAD = Object.freeze({
  canonicalization: 'RFC8785-JCS-safe-integer-profile',
  extractorKind: 'wholeFile',
  mediaType: 'application/json',
  profileId: 'orders-portfolio-canonical-whole-file-v1',
  schemaVersion: '1.0',
  selectionDigestDomain: 'axiolune-source-selection-v1',
});
const SOURCE_EXTRACTOR_PROFILE_DIGEST = sha256Jcs(
  SOURCE_EXTRACTOR_PROFILE_PAYLOAD,
);
const SOURCE_PAYLOAD = Symbol('ordersPortfolioCanonicalSourcePayload');

const TYPES = Object.freeze({
  CostBasisCalculationDefinition: `${PORTFOLIO}CostBasisCalculationDefinition`,
  DirectUnitPriceQuotationContract: `${INSTRUMENTS}DirectUnitPriceQuotationContract`,
  Execution: `${ORDERS}Execution`,
  ExecutionLotAllocationClosure: `${PORTFOLIO}ExecutionLotAllocationClosure`,
  ExternalCostBasisObservation: `${PORTFOLIO}ExternalCostBasisObservation`,
  ExternalOrder: `${ORDERS}ExternalOrder`,
  ExternalOrderStatusMapping: `${ORDERS}ExternalOrderStatusMapping`,
  ExternalOrderStatusVocabulary: `${ORDERS}ExternalOrderStatusVocabulary`,
  FXConversion: `${PORTFOLIO}FXConversion`,
  FXRateObservation: `${MARKET_DATA}FXRateObservation`,
  Fee: `${ORDERS}Fee`,
  HoldingSnapshot: `${PORTFOLIO}HoldingSnapshot`,
  InstrumentListing: `${INSTRUMENTS}InstrumentListing`,
  LiquidityRoleDetermination: `${ORDERS}LiquidityRoleDetermination`,
  LiquidityRoleMapping: `${ORDERS}LiquidityRoleMapping`,
  OrderEventIntegrityFinding: `${ORDERS}OrderEventIntegrityFinding`,
  OrderEventStream: `${ORDERS}OrderEventStream`,
  OrderIntent: `${ORDERS}OrderIntent`,
  OrderIntentLineage: `${ORDERS}OrderIntentLineage`,
  OrderLifecycleEvent: `${ORDERS}OrderLifecycleEvent`,
  OrderTransitionProfile: `${ORDERS}OrderTransitionProfile`,
  OTCTradingContext: 'https://axiolune.ai/ontology/finance/market-structure/OTCTradingContext',
  Portfolio: `${PORTFOLIO}Portfolio`,
  PortfolioObservationStream: `${PORTFOLIO}PortfolioObservationStream`,
  PortfolioAccountMembership: `${PORTFOLIO}PortfolioAccountMembership`,
  PortfolioAccountMembershipClosure: `${PORTFOLIO}PortfolioAccountMembershipClosure`,
  PortfolioManagementMandate: `${PORTFOLIO}PortfolioManagementMandate`,
  PortfolioPositionReconciliationFinding: `${PORTFOLIO}PortfolioPositionReconciliationFinding`,
  PortfolioValuation: `${PORTFOLIO}PortfolioValuation`,
  PositionLot: `${PORTFOLIO}PositionLot`,
  PositionLotAllocation: `${PORTFOLIO}PositionLotAllocation`,
  PositionLotFeeAllocation: `${PORTFOLIO}PositionLotFeeAllocation`,
  PositionLotStateClosure: `${PORTFOLIO}PositionLotStateClosure`,
  PositionSnapshot: `${PORTFOLIO}PositionSnapshot`,
  PositionValuation: `${PORTFOLIO}PositionValuation`,
  PriceObservation: `${MARKET_DATA}PriceObservation`,
  UnrealizedPnLObservation: `${PORTFOLIO}UnrealizedPnLObservation`,
  ValuationCalculationDefinition: `${PORTFOLIO}ValuationCalculationDefinition`,
});

const TARGET_TYPE_BY_EVALUATOR = Object.freeze({
  CostBasisCalculationDefinitionContract: TYPES.CostBasisCalculationDefinition,
  ExecutionContract: TYPES.Execution,
  ExecutionLiquidityDeterminationCompletenessContract: TYPES.Execution,
  ExecutionLotAllocationClosureContract: TYPES.ExecutionLotAllocationClosure,
  ExternalCostBasisObservationContract: TYPES.ExternalCostBasisObservation,
  ExternalOrderContract: TYPES.ExternalOrder,
  ExternalOrderStatusMappingContract: TYPES.ExternalOrderStatusMapping,
  ExternalOrderStatusVocabularyContract: TYPES.ExternalOrderStatusVocabulary,
  FXConversionContract: TYPES.FXConversion,
  FeeContract: TYPES.Fee,
  HoldingSnapshotContract: TYPES.HoldingSnapshot,
  LiquidityRoleDeterminationContract: TYPES.LiquidityRoleDetermination,
  LiquidityRoleMappingContract: TYPES.LiquidityRoleMapping,
  OrderEventIntegrityFindingContract: TYPES.OrderEventIntegrityFinding,
  OrderEventStreamContract: TYPES.OrderEventStream,
  OrderIntentContract: TYPES.OrderIntent,
  OrderIntentLineageContract: TYPES.OrderIntentLineage,
  OrderLifecycleEventContract: TYPES.OrderLifecycleEvent,
  OrderTransitionProfileContract: TYPES.OrderTransitionProfile,
  PortfolioAccountMembershipClosureContract: TYPES.PortfolioAccountMembershipClosure,
  PortfolioAccountMembershipContract: TYPES.PortfolioAccountMembership,
  PortfolioContract: TYPES.Portfolio,
  PortfolioObservationStreamContract: TYPES.PortfolioObservationStream,
  PortfolioManagementMandateContract: TYPES.PortfolioManagementMandate,
  PortfolioPositionReconciliationFindingContract: TYPES.PortfolioPositionReconciliationFinding,
  PortfolioValuationContract: TYPES.PortfolioValuation,
  PositionLotAllocationContract: TYPES.PositionLotAllocation,
  PositionLotContract: TYPES.PositionLot,
  PositionLotFeeAllocationContract: TYPES.PositionLotFeeAllocation,
  PositionLotOpeningAllocationCompletenessContract: TYPES.PositionLot,
  PositionLotStateClosureContract: TYPES.PositionLotStateClosure,
  PositionSnapshotContract: TYPES.PositionSnapshot,
  PositionValuationContract: TYPES.PositionValuation,
  UnrealizedPnLObservationContract: TYPES.UnrealizedPnLObservation,
  ValuationCalculationDefinitionContract: TYPES.ValuationCalculationDefinition,
});

class CanonicalOrdersPortfolioRecordError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CanonicalOrdersPortfolioRecordError';
    this.code = code;
  }
}

function fail(code, detail) {
  throw new CanonicalOrdersPortfolioRecordError(code, detail);
}

const LOCKED_REFERENCE_REGISTRY = validateReferenceRegistry(
  loadGeneratedReferenceRegistry(),
);
const REFERENCE_REGISTRY_DIGEST = LOCKED_REFERENCE_REGISTRY.registry.registryDigest;
let activeReferenceResolver = LOCKED_REFERENCE_REGISTRY;

function withReferenceRegistry(registry, operation) {
  if (registry === undefined) return operation();
  const prior = activeReferenceResolver;
  activeReferenceResolver = validateReferenceRegistry(registry);
  try {
    return operation();
  } finally {
    activeReferenceResolver = prior;
  }
}

function referenceIri(registry, lexical, label) {
  const iriValue = registry.iriByLexical.get(lexical);
  if (!iriValue) fail('orders-portfolio-canonical-reference-registry', `${label}:${lexical}`);
  return iriValue;
}

function referenceLexical(registry, iriValue, label) {
  if (!IRI.test(iriValue || '')) fail('orders-portfolio-canonical-iri', label);
  const lexical = registry.lexicalByIri.get(iriValue);
  if (!lexical) fail('orders-portfolio-canonical-reference-registry', `${label}:${iriValue}`);
  return lexical;
}

function currencyIri(lexical, label = 'currency') {
  return referenceIri(activeReferenceResolver.currencies, lexical, label);
}

function currencyLexical(iriValue, label = 'currency') {
  return referenceLexical(activeReferenceResolver.currencies, iriValue, label);
}

function quantityUnitIri(lexical, label = 'Quantity.unit') {
  const controlled = activeReferenceResolver.quantityUnits.iriByLexical.get(lexical);
  if (controlled) return controlled;
  const pair = /^([A-Z]{3})-per-([A-Z]{3})$/u.exec(lexical);
  if (pair
      && activeReferenceResolver.currencies.iriByLexical.has(pair[1])
      && activeReferenceResolver.currencies.iriByLexical.has(pair[2])) {
    return `${UNIT}${lexical}`;
  }
  fail('orders-portfolio-canonical-reference-registry', `${label}:${lexical}`);
}

function quantityUnitLexical(iriValue, label = 'Quantity.unit') {
  return referenceLexical(activeReferenceResolver.quantityUnits, iriValue, label);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function requireIri(value, label) {
  if (typeof value !== 'string' || !IRI.test(value)) fail('orders-portfolio-canonical-iri', label);
  return value;
}

function exactVersion(value) {
  return typeof value === 'string' && IRI.test(value) && /\/version\/[A-Za-z0-9._~:-]+$/u.test(value);
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('orders-portfolio-canonical-digest', label);
  return value;
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('orders-portfolio-canonical-object', label);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('orders-portfolio-canonical-required-field', `${label}.${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('orders-portfolio-canonical-unknown-field', `${label}.${key}`);
  }
}

function code(list, notation) {
  return `${list}/value/${notation}`;
}

function decodeCode(value, list, label) {
  const prefix = `${list}/value/`;
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length === prefix.length) {
    fail('orders-portfolio-canonical-code-value', label);
  }
  return value.slice(prefix.length);
}

function decimalFromMicros(value) {
  if (!Number.isSafeInteger(value)) return String(value);
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.trunc(absolute / 1000000)}.${String(absolute % 1000000).padStart(6, '0')}`;
}

function microsFromDecimal(value, scale, label) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
      || scale !== 6) fail('orders-portfolio-canonical-decimal', label);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > 6) fail('orders-portfolio-canonical-decimal', label);
  const result = Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(result)) fail('orders-portfolio-canonical-decimal', label);
  return negative ? -result : result;
}

function money(micros, currency = 'USD') {
  currencyIri(currency, 'Money.currency');
  return { amount: decimalFromMicros(micros), currency, scale: 6 };
}

function decodeMoney(value, label) {
  exactKeys(value, ['amount', 'currency', 'scale'], [], label);
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)
      || !activeReferenceResolver.currencies.iriByLexical.has(value.currency)) {
    fail('orders-portfolio-canonical-money', `${label}.currency`);
  }
  return {
    currency: value.currency,
    micros: microsFromDecimal(value.amount, value.scale, `${label}.amount`),
    scale: value.scale,
  };
}

function quantity(micros, unit = 'share') {
  return {
    numericValue: decimalFromMicros(micros),
    precision: 6,
    rounding: 'half-even',
    unit: quantityUnitIri(unit),
  };
}

function decodeQuantity(value, label) {
  exactKeys(value, ['numericValue', 'precision', 'rounding', 'unit'], [], label);
  if (!IRI.test(value.unit || '') || !['floor', 'ceiling', 'half-up', 'half-even'].includes(value.rounding)
      || value.precision !== 6) fail('orders-portfolio-canonical-quantity', label);
  return {
    micros: microsFromDecimal(value.numericValue, value.precision, `${label}.numericValue`),
    precision: value.precision,
    rounding: value.rounding,
    unit: activeReferenceResolver.quantityUnits.lexicalByIri.get(value.unit) || value.unit,
  };
}

function artifactRef(iriValue) {
  return { iri: iriValue, kind: 'iri' };
}

function sourceLocator(payload, path = 'canonical-source.json') {
  const locator = {
    extractorProfileDigest: SOURCE_EXTRACTOR_PROFILE_DIGEST,
    extractorProfileRef: artifactRef(SOURCE_EXTRACTOR_PROFILE_REF),
    kind: 'wholeFile',
    mediaType: 'application/json',
    path,
  };
  locator.selectionDigest = computeSelectionDigest(
    locator,
    Buffer.from(strictCanonicalJcs(payload), 'utf8'),
  );
  return locator;
}

function temporalFromLegacy(value) {
  const result = {
    availableFrom: value?.availableFrom || '2025-01-01T00:00:02Z',
    knowledgeFrom: value?.knowledgeFrom || '2025-01-01T00:00:01Z',
    revision: value?.revision ?? 0,
    validFrom: value?.validFrom || '2025-01-01T00:00:00Z',
  };
  if (value?.validTo !== undefined) result.validTo = value.validTo;
  return result;
}

function common(typeIri, versionIri, temporal, suffix) {
  return {
    ...temporalFromLegacy(temporal),
    source: `https://axiolune.ai/sources/orders-portfolio-custom/${suffix}`,
    typeIri,
    versionIri,
  };
}

function sourceFields(name, evidenceValue) {
  const ref = evidenceValue?.ref || `https://axiolune.ai/evidence/orders-portfolio/${name}`;
  const inferredPayload = { evidence: name };
  const suppliedDigest = evidenceValue?.digest;
  const payload = structuredClone(
    evidenceValue?.payload
      || (suppliedDigest && inferSyntheticSourcePayload(ref, suppliedDigest))
      || inferredPayload,
  );
  const actualDigest = sha256Jcs(payload);
  const digestValue = suppliedDigest || actualDigest;
  if (digestValue !== actualDigest) {
    fail(
      'orders-portfolio-canonical-source-evidence-payload',
      `${name}: supplied digest has no matching canonical source bytes`,
    );
  }
  return {
    [SOURCE_PAYLOAD]: payload,
    sourceArtifactDigest: digestValue,
    sourceArtifactRef: artifactRef(ref),
    sourceLocator: sourceLocator(payload),
  };
}

function refVersion(name) {
  return `${DATA}${name}/version/0`;
}

function refLogical(name) {
  if (name.startsWith('currency/')) {
    return currencyIri(name.slice('currency/'.length), 'logical currency reference');
  }
  return `${DATA}${name}`;
}

function defaultRecord(typeIri, name, temporal, overrides = {}) {
  const v = refVersion(name);
  const logicalAccount = refLogical('account/1');
  const logicalExecutionParty = refLogical('party/execution-principal/1');
  const logicalContraAccount = refLogical('account/contra/1');
  const logicalContraParty = refLogical('party/contra/1');
  const logicalInstrument = refLogical('instrument/1');
  const exactInstrument = `${logicalInstrument}/version/0`;
  const quote = refVersion('quotation/1');
  const targetDefaults = {
    [TYPES.OrderIntent]: {
      clientIntentId: 'intent-1', intentAccount: logicalAccount, intentInstrument: logicalInstrument,
      orderQuantity: quantity(1000000), orderSide: code(`${ORDERS}OrderSide`, 'Buy'),
      orderType: code(`${ORDERS}OrderType`, 'Market'), timeInForce: code(`${ORDERS}TimeInForce`, 'DAY'),
      ...sourceFields(`${name}-source`),
    },
    [TYPES.ExternalOrder]: {
      externalOrderId: 'external-1', externalOrderOriginatingIntent: refVersion('intent/1'),
      externalOrderProvider: refLogical('provider/1'), providerApiIdentifier: 'api-v1', providerSchemaVersion: '1.0',
      ...sourceFields(`${name}-source`),
    },
    [TYPES.OrderEventStream]: {
      liquidityRoleCapability: code(`${ORDERS}LiquidityRoleCapability`, 'required'), providerApiIdentifier: 'api-v1',
      providerSchemaVersion: '1.0', providerStreamId: 'provider-stream-1', sourceContractDigest: sha256Jcs({ fields: ['liquidity'], schemaVersion: '1.0' }),
      sourceContractRef: 'https://axiolune.ai/contracts/orders/source/1', streamExternalOrder: refLogical('external-order/1'),
      streamProvider: refLogical('provider/1'), ...sourceFields(`${name}-source`),
    },
    [TYPES.ExternalOrderStatusVocabulary]: {
      providerApiIdentifier: 'api-v1', providerSchemaVersion: '1.0', statusVocabularyId: 'status-v1',
      statusVocabularyProvider: refLogical('provider/1'), ...sourceFields(`${name}-source`),
    },
    [TYPES.OrderTransitionProfile]: {
      implementationDigest: sha256Jcs({ artifact: 'transition-implementation' }), inputContractDigest: sha256Jcs({ artifact: 'transition-input' }),
      outputContractDigest: sha256Jcs({ artifact: 'transition-output' }), runtimeDigest: sha256Jcs({ artifact: 'transition-runtime' }),
      toolLockDigest: sha256Jcs({ artifact: 'transition-tool' }), toolLockRef: 'https://axiolune.ai/tools/transition-lock',
      transitionProfileId: 'transition-v1', transitionProfileProvider: refLogical('provider/1'),
    },
    [TYPES.LiquidityRoleMapping]: {
      liquidityMappingId: 'liquidity-v1', mappingDigest: sha256Jcs([{ rawValue: 'M', role: 'Maker' }]),
      perspectiveInversion: false, rawFieldLocator: '/liquidity', rawPerspective: 'executionAccountOrder',
      sourceContractDigest: sha256Jcs({ fields: ['liquidity'] }), sourceContractRef: 'https://axiolune.ai/contracts/orders/source/1',
    },
    [TYPES.OrderLifecycleEvent]: {
      eventStream: refVersion('order-stream/1'), externalOrder: refVersion('external-order/1'),
      lifecycleState: code(`${ORDERS}OrderLifecycleState`, 'Accepted'), observedAt: temporalFromLegacy(temporal).validFrom,
      orderEventKind: code(`${ORDERS}OrderEventKind`, 'Accepted'), orderIntent: refVersion('intent/1'), providerEventId: 'evt-1', sourceOrderKey: 1,
      ...sourceFields(`${name}-source`),
    },
    [TYPES.OrderIntentLineage]: (() => {
      const sourceIntentVersions = [refVersion('intent/source')];
      const resultIntentVersions = [
        refVersion('intent/result-a'),
        refVersion('intent/result-b'),
      ].sort(compareUtf8);
      const sourceIntentVersionSetDigest = iriSetDigest(sourceIntentVersions);
      const resultIntentVersionSetDigest = iriSetDigest(resultIntentVersions);
      return {
        orderLineageKeyDigest: sha256DomainJcs(
          'axiolune-order-intent-lineage-key-v1',
          {
            kind: 'split',
            resultIntentVersionSetDigest,
            sourceIntentVersionSetDigest,
          },
        ),
        orderLineageKind: code(`${ORDERS}OrderLineageKind`, 'split'),
        resultIntentCount: resultIntentVersions.length,
        resultIntentVersionSetDigest,
        resultOrderIntent: resultIntentVersions,
        sourceIntentCount: sourceIntentVersions.length,
        sourceIntentVersionSetDigest,
        sourceOrderIntent: sourceIntentVersions,
        ...sourceFields(`${name}-source`),
      };
    })(),
    [TYPES.Execution]: {
      contraAccount: logicalContraAccount, contraParty: logicalContraParty,
      executionAccount: logicalAccount, executionExternalOrder: refVersion('external-order/1'), executionInstrument: logicalInstrument,
      executionOrderIntent: refVersion('intent/1'), executionPrice: money(3000000), executionQuantity: quantity(1000000),
      executionParty: logicalExecutionParty,
      executionQuotationContract: quote, executionStream: refVersion('order-stream/1'), observedAt: temporalFromLegacy(temporal).validFrom,
      orderSide: code(`${ORDERS}OrderSide`, 'Buy'), providerExecutionId: 'execution-1', sourceOrderKey: 1,
      ...sourceFields(`${name}-source`),
    },
    [TYPES.Fee]: {
      feeAmount: money(125), feeEffect: code(`${ORDERS}FeeEffect`, 'charge'), feeExecution: refVersion('execution/1'),
      feeId: 'fee-1', feeKind: code(`${ORDERS}FeeKind`, 'commission'), ...sourceFields(`${name}-source`),
    },
    [TYPES.ExternalOrderStatusMapping]: {
      canonicalLifecycleState: code(`${ORDERS}OrderLifecycleState`, 'Accepted'), providerApiIdentifier: 'api-v1', providerSchemaVersion: '1.0',
      rawStatusCode: 'ACCEPTED', reviewDecisionDigest: sha256Jcs({ decision: 'accepted' }), reviewDecisionRef: 'https://axiolune.ai/reviews/status/1',
      statusMappingReviewer: refLogical('party/reviewer'), statusMappingVersion: '1.0', statusProvider: refLogical('provider/1'),
      statusVocabulary: refVersion('status-vocabulary/1'), ...sourceFields(`${name}-source`),
    },
    [TYPES.LiquidityRoleDetermination]: {
      determinedExecution: refVersion('execution/1'), determinationStream: refVersion('order-stream/1'),
      generatingContextRef: refVersion('run/liquidity/1'), liquidityDeterminationResult: code(`${ORDERS}LiquidityDeterminationResult`, 'classified'),
      liquidityMapping: refVersion('liquidity-mapping/1'), liquidityPerspective: code(`${ORDERS}LiquidityPerspective`, 'executionAccountOrder'),
      liquidityRole: code(`${ORDERS}LiquidityRole`, 'maker'), rawFieldLocator: '/liquidity', rawLexicalValue: 'M',
      sourceRecordDigest: sha256Jcs({ liquidity: 'M' }), sourceRecordRef: 'https://axiolune.ai/source-records/liquidity/1',
    },
    [TYPES.OrderEventIntegrityFinding]: {
      affectedKeyDigest: sha256DomainJcs(
        'axiolune-order-finding-subject-v1',
        { missingFrom: 2, missingTo: 4 },
      ),
      findingStream: refVersion('order-stream/1'),
      generatingContextRef: refVersion('run/order-integrity/1'), missingKeyFrom: 2, missingKeyTo: 4,
      orderIntegrityKind: code(`${ORDERS}OrderIntegrityKind`, 'sequenceGap'), relatedLifecycleEvent: [refVersion('event/1')],
      relatedVersionSetDigest: iriSetDigest([refVersion('event/1')]),
    },
    [TYPES.Portfolio]: { portfolioId: 'PORT-1' },
    [TYPES.PortfolioObservationStream]: {
      portfolioObservationCompletenessContractDigest: sha256Jcs({ contract: 'portfolio-observation-completeness' }),
      portfolioObservationCompletenessContractRef: 'https://axiolune.ai/contracts/portfolio-observation/completeness/1',
      portfolioObservationPaginationContractDigest: sha256Jcs({ contract: 'portfolio-observation-pagination' }),
      portfolioObservationPaginationContractRef: 'https://axiolune.ai/contracts/portfolio-observation/pagination/1',
      portfolioObservationSourceContractDigest: sha256Jcs({ contract: 'portfolio-observation-source' }),
      portfolioObservationSourceContractRef: 'https://axiolune.ai/contracts/portfolio-observation/source/1',
      portfolioObservationStreamId: 'portfolio-observation-stream-1',
      portfolioObservationStreamProvider: refLogical('provider/portfolio-observation/1'),
      ...sourceFields(`${name}-source`),
    },
    [TYPES.PortfolioAccountMembership]: {
      approvalDigest: sha256Jcs({ approval: 'membership' }), approvalRef: 'https://axiolune.ai/approvals/membership/1', authorityScope: 'portfolio-membership',
      memberAccount: logicalAccount, membershipAuthority: refLogical('party/authority'), membershipId: 'membership-1',
      membershipPortfolio: refLogical('portfolio/1'), ...sourceFields(`${name}-source`),
    },
    [TYPES.PortfolioManagementMandate]: {
      approvalDigest: sha256Jcs({ approval: 'mandate' }), approvalRef: 'https://axiolune.ai/approvals/mandate/1', authorityScope: 'portfolio-management',
      managedPortfolio: refLogical('portfolio/1'), managingParty: refLogical('party/manager'), mandateAuthority: refLogical('party/authority'),
      mandateId: 'mandate-1', ...sourceFields(`${name}-source`),
    },
    [TYPES.PortfolioAccountMembershipClosure]: {
      closedMembership: [refVersion('membership/a'), refVersion('membership/b')], closurePortfolio: refLogical('portfolio/1'),
      generatingContextRef: refVersion('run/membership-closure/1'), inputContextRecordDigest: sha256Jcs({ context: 'membership-input' }),
      inputContextRef: 'https://axiolune.ai/context/membership-input/1', membershipClosureProbeDigest: sha256Jcs({ probe: 'membership-closure' }),
      membershipClosureProbeRef: 'https://axiolune.ai/probes/membership-closure/1', membershipCount: 2,
      membershipVersionSetDigest: iriSetDigest([refVersion('membership/a'), refVersion('membership/b')]),
      pitRequestRecordDigest: sha256Jcs({ pit: 'membership' }), pitRequestRef: 'https://axiolune.ai/pit/membership/1',
    },
    [TYPES.HoldingSnapshot]: {
      holdingAccount: logicalAccount, holdingInstrument: logicalInstrument,
      holdingObservationStream: refVersion('portfolio-observation-stream/1'), holdingQuantity: quantity(0), positionSourceKind: code(`${PORTFOLIO}PositionSourceKind`, 'externalReported'),
      generatingContextRef: refVersion('run/holding/1'), snapshotId: 'holding-1', ...sourceFields(`${name}-source`),
    },
    [TYPES.PositionSnapshot]: {
      generatingContextRef: refVersion('run/position/1'),
      positionAccount: logicalAccount, positionInstrument: logicalInstrument,
      positionObservationStream: refLogical('portfolio-observation-stream/1'), positionQuantity: quantity(-1000000),
      positionSourceKind: code(`${PORTFOLIO}PositionSourceKind`, 'executionDerived'), snapshotId: 'position-1', ...sourceFields(`${name}-source`),
    },
    [TYPES.PositionLot]: {
      calculationContextRef: 'https://axiolune.ai/context/calculation/1', costBasisDefinition: refVersion('cost-definition/1'),
      lotDiscriminator: 'openingRemainder', lotForInstrument: logicalInstrument, lotInAccount: logicalAccount,
      lotQuotationContract: quote, openingCostBasis: money(1000), openingExecution: refVersion('execution/1'), openingGross: money(1000),
      originalQuantity: quantity(100), ...sourceFields(`${name}-source`),
    },
    [TYPES.ValuationCalculationDefinition]: {
      formulaDigest: sha256Jcs({ artifact: 'formula' }), inputContractDigest: sha256Jcs({ artifact: 'valuation-input' }),
      outputContractDigest: sha256Jcs({ artifact: 'valuation-output' }), precisionPolicyDigest: sha256Jcs({ artifact: 'precision' }),
      precisionPolicyRef: 'https://axiolune.ai/policies/precision/1', roundingPolicyDigest: sha256Jcs({ artifact: 'rounding' }),
      roundingPolicyRef: 'https://axiolune.ai/policies/rounding/1', runtimeDigest: sha256Jcs({ artifact: 'valuation-runtime' }),
      toolLockDigest: sha256Jcs({ artifact: 'valuation-tool' }), toolLockRef: 'https://axiolune.ai/tools/valuation/1',
      valuationDefinitionAuthority: refLogical('authority/valuation'), valuationDefinitionId: 'valuation-v1',
      valuationDefinitionQuotationContract: [quote],
      valuationMethod: code(`${PORTFOLIO}ValuationMethod`, 'directUnitPriceTimesQuantity'),
      valuationQuotationContractCount: 1,
      valuationQuotationContractVersionSetDigest: iriSetDigest([quote]),
    },
    [TYPES.CostBasisCalculationDefinition]: {
      costBasisDefinitionAuthority: refLogical('authority/cost'), costBasisDefinitionBasisCurrency: refLogical('currency/USD'),
      costBasisDefinitionId: 'cost-v1', costBasisDefinitionQuotationContract: quote,
      costBasisMethod: code(`${PORTFOLIO}CostBasisMethod`, 'executionAllocatedDirectUnitCost'), currencyPolicy: 'definitionBasisCurrency',
      feeTreatment: code(`${PORTFOLIO}FeeTreatment`, 'included'), fxPolicy: 'explicitDirectionCorrect',
      implementationDigest: sha256Jcs({ artifact: 'cost-implementation' }), inputContractDigest: sha256Jcs({ artifact: 'cost-input' }),
      lotConsumptionPolicy: code(`${PORTFOLIO}LotConsumptionPolicy`, 'fifo'), lotOpeningPolicy: code(`${PORTFOLIO}LotOpeningPolicy`, 'openingRemainder'),
      outputContractDigest: sha256Jcs({ artifact: 'cost-output' }), precisionPolicyDigest: sha256Jcs({ artifact: 'cost-precision' }),
      precisionPolicyRef: 'https://axiolune.ai/policies/cost-precision/1', roundingPolicyDigest: sha256Jcs({ artifact: 'cost-rounding' }),
      roundingPolicyRef: 'https://axiolune.ai/policies/cost-rounding/1', runtimeDigest: sha256Jcs({ artifact: 'cost-runtime' }),
      toolLockDigest: sha256Jcs({ artifact: 'cost-tool' }), toolLockRef: 'https://axiolune.ai/tools/cost/1', ...sourceFields(`${name}-source`),
    },
    [TYPES.PortfolioValuation]: {
      conversionContextDigest: sha256Jcs({ context: 'conversion' }), conversionContextRef: 'https://axiolune.ai/context/conversion/1',
      generatingContextRef: refVersion('run/valuation/1'), inputContextRecordDigest: sha256Jcs({ context: 'valuation-input' }),
      inputContextRef: 'https://axiolune.ai/context/valuation-input/1', memberAccountClosure: refVersion('membership-closure/1'),
      pitRequestRecordDigest: sha256Jcs({ pit: 'valuation' }), pitRequestRef: 'https://axiolune.ai/pit/valuation/1',
      reportingCurrency: refLogical('currency/USD'), valuationDefinition: refVersion('valuation-definition/1'), valuationRunId: 'valuation-run-1',
      valuedPortfolio: refLogical('portfolio/1'),
    },
    [TYPES.PositionValuation]: {
      marketValue: money(6000000), valuationHeader: refVersion('portfolio-valuation/1'), valuationPrice: refVersion('price/1'),
      valuedPositionSnapshot: refVersion('position/1'),
    },
    [TYPES.FXConversion]: {
      conversionRate: refVersion('fx-rate/1'), conversionValuationLine: refVersion('valuation/1'), fxConversionDirection: code(`${PORTFOLIO}FXConversionDirection`, 'baseToQuote'),
      generatingContextRef: refVersion('run/fx/1'), inputContextRecordDigest: sha256Jcs({ context: 'fx-input' }), inputContextRef: 'https://axiolune.ai/context/fx-input/1',
      inputMoney: money(100, 'USD'), outputMoney: money(200, 'EUR'), roundingPolicyDigest: sha256Jcs({ policy: 'fx-rounding' }),
      roundingPolicyRef: 'https://axiolune.ai/policies/fx-rounding/1',
    },
    [TYPES.PositionLotAllocation]: {
      allocatedLot: refVersion('lot/1'), allocatedQuantity: quantity(100), allocationCostBasisDefinition: refVersion('cost-definition/1'),
      allocationExecution: refVersion('execution/1'), calculationContextRef: 'https://axiolune.ai/context/calculation/1',
      generatingContextRef: refVersion('run/allocation/1'), lotAllocationKind: code(`${PORTFOLIO}PositionLotAllocationKind`, 'opening'),
    },
    [TYPES.PositionLotFeeAllocation]: {
      allocatedFee: refVersion('fee/1'), allocatedFeeAmount: money(10), calculationContextRef: 'https://axiolune.ai/context/calculation/1',
      feeCostBasisDefinition: refVersion('cost-definition/1'), feeLotAllocation: refVersion('allocation/1'), generatingContextRef: refVersion('run/fee-allocation/1'),
    },
    [TYPES.ExecutionLotAllocationClosure]: {
      allocationClosureProbeDigest: sha256Jcs({ probe: 'allocation' }), allocationClosureProbeRef: 'https://axiolune.ai/probes/allocation/1', allocationCount: 2,
      allocationVersionSetDigest: iriSetDigest([refVersion('allocation/a'), refVersion('allocation/b')]), closureAllocation: [refVersion('allocation/a'), refVersion('allocation/b')],
      closureCostBasisDefinition: refVersion('cost-definition/1'), closureEligibleLot: [refVersion('lot/a'), refVersion('lot/b')], closureExecution: refVersion('execution/1'),
      consumptionSelectionProbeDigest: sha256Jcs({ probe: 'selection' }), consumptionSelectionProbeRef: 'https://axiolune.ai/probes/selection/1',
      eligibleLotCount: 2, eligibleLotVersionSetDigest: iriSetDigest([refVersion('lot/a'), refVersion('lot/b')]), feeAllocationCount: 0,
      feeAllocationVersionSetDigest: iriSetDigest([]), feeClosureProbeDigest: sha256Jcs({ probe: 'fee' }), feeClosureProbeRef: 'https://axiolune.ai/probes/fee/1',
      feeCount: 0, feeVersionSetDigest: iriSetDigest([]), generatingContextRef: refVersion('run/execution-closure/1'),
      inputContextRecordDigest: sha256Jcs({ context: 'allocation-input' }), inputContextRef: 'https://axiolune.ai/context/allocation-input/1',
      pitRequestRecordDigest: sha256Jcs({ pit: 'allocation' }), pitRequestRef: 'https://axiolune.ai/pit/allocation/1',
    },
    [TYPES.PositionLotStateClosure]: {
      calculationContextRef: 'https://axiolune.ai/context/calculation/1', closedPositionSnapshot: refVersion('position/1'),
      generatingContextRef: refVersion('run/lot-state/1'), inputContextRecordDigest: sha256Jcs({ context: 'lot-state-input' }),
      inputContextRef: 'https://axiolune.ai/context/lot-state-input/1', lotClosureProbeDigest: sha256Jcs({ probe: 'lot' }),
      lotClosureProbeRef: 'https://axiolune.ai/probes/lot/1', openLot: [refVersion('lot/open')], openLotVersionSetDigest: iriSetDigest([refVersion('lot/open')]),
      pitRequestRecordDigest: sha256Jcs({ pit: 'lot-state' }), pitRequestRef: 'https://axiolune.ai/pit/lot-state/1', remainingCostBasis: money(600),
      snapshotPivotRef: 'https://axiolune.ai/pivots/position/1', stateAccount: logicalAccount, stateAllocation: [refVersion('allocation/open')],
      stateAllocationClosureProbeDigest: sha256Jcs({ probe: 'state-allocation' }), stateAllocationClosureProbeRef: 'https://axiolune.ai/probes/state-allocation/1',
      stateAllocationVersionSetDigest: iriSetDigest([refVersion('allocation/open')]), stateCostBasisDefinition: refVersion('cost-definition/1'),
      stateExecutionClosure: [refVersion('execution-closure/1')], stateExecutionClosureVersionSetDigest: iriSetDigest([refVersion('execution-closure/1')]),
      stateInstrument: logicalInstrument, stateQuotationContract: quote,
    },
    [TYPES.UnrealizedPnLObservation]: {
      calculationContextRef: 'https://axiolune.ai/context/calculation/1', conversionContextDigest: sha256Jcs({ context: 'conversion' }),
      conversionContextRef: 'https://axiolune.ai/context/conversion/1', generatingContextRef: refVersion('run/pnl/1'), marketValue: money(1000),
      openLotVersionSetDigest: iriSetDigest([refVersion('lot/open')]), pnlCostBasisDefinition: refVersion('cost-definition/1'),
      pnlLotStateClosure: refVersion('lot-state/1'), pnlQuotationContract: quote, pnlValuation: refVersion('valuation/1'),
      remainingCostBasis: money(600), stateAllocationVersionSetDigest: iriSetDigest([refVersion('allocation/open')]),
      stateExecutionClosureVersionSetDigest: iriSetDigest([refVersion('execution-closure/1')]), unrealizedPnl: money(400),
    },
    [TYPES.ExternalCostBasisObservation]: {
      externalBasisAccount: logicalAccount, externalBasisId: 'external-basis-1', externalBasisInstrument: logicalInstrument,
      externalBasisDefinition: refVersion('cost-definition/1'),
      externalBasisObservationStream: refLogical('portfolio-observation-stream/1'), externalCostBasis: money(100),
      generatingContextRef: refVersion('run/external-basis/1'), ...sourceFields(`${name}-source`),
    },
    [TYPES.PortfolioPositionReconciliationFinding]: {},
    [TYPES.InstrumentListing]: {
      listedInstrument: exactInstrument, listingBusinessFrom: '2020-01-01',
      listingFacility: refVersion('facility/1'), listingIdentifierScheme: refLogical('identifier-scheme/listing'),
      listingIdentifierValue: refLogical('identifier-value/listing'), listingQuoteCurrency: refLogical('currency/USD'),
      ...sourceFields(`${name}-source`),
    },
    [TYPES.OTCTradingContext]: {
      marketConvention: code(
        'https://axiolune.ai/ontology/finance/market-structure/MarketConvention',
        'directQuotePerUnit',
      ),
      otcQuoteCurrency: refLogical('currency/USD'),
      otcSourceProvider: refVersion('provider/1'), providerContextId: 'otc-context-1',
      sourceContractDigest: sha256Jcs({ context: 'otc' }),
      sourceContractRef: 'https://axiolune.ai/contracts/otc/1',
      ...sourceFields(`${name}-source`),
    },
    [TYPES.DirectUnitPriceQuotationContract]: {
      contractMultiplier: '1', normalizationContractDigest: sha256Jcs({ contract: 'direct-unit-normalization' }),
      normalizationContractRef: 'https://axiolune.ai/contracts/normalization/direct-unit/1', quotationDenominatorUnit: quantityUnitIri('share'),
      quotationInstrument: logicalInstrument,
      quotationKind: code(`${INSTRUMENTS}QuotationKind`, 'directUnitPrice'),
      quotationQuoteCurrency: refLogical('currency/USD'),
      ...sourceFields(`${name}-source`),
    },
    [TYPES.PriceObservation]: {
      observationStream: refVersion('market-data-stream/1'), observedAt: temporalFromLegacy(temporal).validFrom, observedInstrument: exactInstrument,
      priceKind: code(`${MARKET_DATA}PriceKind`, 'reference/close'),
      priceValue: money(3000000), providerObservationId: 'price-1', quotationContract: quote,
      sourceOrderKey: 1,
    },
    [TYPES.FXRateObservation]: {
      baseCurrency: refLogical('currency/USD'), fxRate: quantity(2000000, 'EUR-per-USD'), observationStream: refVersion('market-data-stream/1'),
      observedAt: temporalFromLegacy(temporal).validFrom, providerObservationId: 'fx-rate-1', quoteCurrency: refLogical('currency/EUR'), sourceOrderKey: 1,
    },
  };
  if (!targetDefaults[typeIri]) fail('orders-portfolio-canonical-type', typeIri);
  return { ...common(typeIri, v, temporal, name), ...targetDefaults[typeIri], ...overrides };
}

function artifact(artifactRefIri, payload, digestOverride) {
  return {
    artifactDigest: digestOverride || sha256Jcs(payload),
    artifactRef: artifactRef(artifactRefIri),
    mediaType: 'application/json',
    payload: structuredClone(payload),
  };
}

function lockedArtifact(value, defaultRef, defaultPayload) {
  const payload = structuredClone(value?.payload || defaultPayload);
  const ref = value?.ref || defaultRef;
  const digestValue = value?.digest || sha256Jcs(payload);
  return {
    artifact: artifact(ref, payload, digestValue),
    digest: digestValue,
    payload,
    ref,
  };
}

/*
 * Valuation producer implementation. This intentionally does not call the
 * verifier's buildVerifierOwnedPitIngress helper: the generated evidence and
 * the runtime reconstruction therefore travel through separate assembly code
 * paths. Both paths share only the normative RFC 8785 and framed IRI-set
 * digest primitives.
 */
function deriveMaterializedFactOutput(
  selectionBindings,
  selectedRecords,
  outputPlan,
) {
  if (!Array.isArray(selectionBindings)
      || !Array.isArray(selectedRecords)
      || !outputPlan
      || typeof outputPlan !== 'object'
      || Array.isArray(outputPlan)) {
    fail('orders-portfolio-pit-producer-input', 'selection or output plan is malformed');
  }
  const recordsByVersion = new Map(selectedRecords.map((record) => [
    record.versionIri,
    record,
  ]));
  if (recordsByVersion.size !== selectedRecords.length) {
    fail('orders-portfolio-pit-producer-selection', 'selected records are not unique');
  }
  const requestedVersions = [...new Set(selectionBindings.flatMap(
    (binding) => binding.factVersionIris,
  ))].sort(compareUtf8);
  const suppliedVersions = [...recordsByVersion.keys()].sort(compareUtf8);
  if (canonicalJcs(requestedVersions) !== canonicalJcs(suppliedVersions)) {
    fail(
      'orders-portfolio-pit-producer-selection',
      'selected record bytes do not close the selection-binding union',
    );
  }
  const versionsByRole = new Map(selectionBindings.map((binding) => [
    binding.role,
    binding.factVersionIris,
  ]));
  const exactRoles = (expectedRoles) => {
    const actualRoles = [...versionsByRole.keys()].sort(compareUtf8);
    const expected = [...expectedRoles].sort(compareUtf8);
    if (canonicalJcs(actualRoles) !== canonicalJcs(expected)) {
      fail(
        'orders-portfolio-pit-producer-selection-role',
        `selection roles ${canonicalJcs(actualRoles)} do not equal ${canonicalJcs(expected)}`,
      );
    }
  };
  const one = (role, typeIri) => {
    const versions = versionsByRole.get(role);
    if (!Array.isArray(versions) || versions.length !== 1) {
      fail('orders-portfolio-pit-producer-selection', `${role} must select exactly one FactVersion`);
    }
    const record = recordsByVersion.get(versions[0]);
    if (!record || record.typeIri !== typeIri) {
      fail('orders-portfolio-pit-producer-selection', `${role} selects the wrong FactVersion type`);
    }
    return record;
  };
  const many = (role, typeIri) => {
    const versions = versionsByRole.get(role) || [];
    return versions.map((versionIri) => {
      const record = recordsByVersion.get(versionIri);
      if (!record || record.typeIri !== typeIri) {
        fail('orders-portfolio-pit-producer-selection', `${role} selects the wrong FactVersion type`);
      }
      return record;
    });
  };

  if (outputPlan.outputFactTypeIri === TYPES.PortfolioValuation) {
    exactRoles([
      'memberAccountClosure',
      'memberMembership',
      'valuationDefinition',
      'valuationQuotationContract',
    ]);
    const closure = one('memberAccountClosure', TYPES.PortfolioAccountMembershipClosure);
    const definition = one('valuationDefinition', TYPES.ValuationCalculationDefinition);
    const memberships = many('memberMembership', TYPES.PortfolioAccountMembership);
    const quotations = many(
      'valuationQuotationContract',
      TYPES.DirectUnitPriceQuotationContract,
    );
    const membershipVersions = memberships.map((record) => record.versionIri)
      .sort(compareUtf8);
    const quotationVersions = quotations.map((record) => record.versionIri)
      .sort(compareUtf8);
    if (canonicalJcs(membershipVersions) !== canonicalJcs(
      [...(closure.closedMembership || [])].sort(compareUtf8),
    )
        || memberships.some((record) => (
          record.membershipPortfolio !== closure.closurePortfolio
        ))
        || closure.closurePortfolio !== outputPlan.valuedPortfolio
        || canonicalJcs(quotationVersions) !== canonicalJcs(
          [...(definition.valuationDefinitionQuotationContract || [])].sort(compareUtf8),
        )) {
      fail(
        'orders-portfolio-pit-producer-join',
        'PortfolioValuation selected closure, memberships, definition, quotations, or portfolio do not join',
      );
    }
    return {
      ...temporalFromLegacy(outputPlan.temporal),
      conversionContextDigest: outputPlan.conversionContext.digest,
      conversionContextRef: outputPlan.conversionContext.ref,
      generatingContextRef: outputPlan.generatingContextRef,
      inputContextRecordDigest: outputPlan.inputContext.digest,
      inputContextRef: outputPlan.inputContext.ref,
      memberAccountClosure: closure.versionIri,
      pitRequestRecordDigest: outputPlan.pitRequest.digest,
      pitRequestRef: outputPlan.pitRequest.ref,
      reportingCurrency: outputPlan.reportingCurrency,
      source: outputPlan.source,
      typeIri: outputPlan.outputFactTypeIri,
      valuationDefinition: definition.versionIri,
      valuationRunId: outputPlan.valuationRunId,
      valuedPortfolio: outputPlan.valuedPortfolio,
      versionIri: outputPlan.outputFactVersionIri,
    };
  }

  if (outputPlan.outputFactTypeIri === TYPES.UnrealizedPnLObservation) {
    exactRoles([
      'costBasisDefinition',
      ...(versionsByRole.has('pnlFxConversion') ? ['pnlFxConversion'] : []),
      'pnlLotStateClosure',
      'pnlValuation',
      'quotationContract',
      'stateSnapshot',
      'valuationDefinition',
      'valuationHeader',
      'valuationPrice',
      'valuationQuotationContract',
    ]);
    const valuation = one('pnlValuation', TYPES.PositionValuation);
    const lotState = one('pnlLotStateClosure', TYPES.PositionLotStateClosure);
    const stateDefinition = one('costBasisDefinition', TYPES.CostBasisCalculationDefinition);
    const quotation = one('quotationContract', TYPES.DirectUnitPriceQuotationContract);
    const snapshot = one('stateSnapshot', TYPES.PositionSnapshot);
    const definition = one('valuationDefinition', TYPES.ValuationCalculationDefinition);
    const header = one('valuationHeader', TYPES.PortfolioValuation);
    const price = one('valuationPrice', TYPES.PriceObservation);
    const valuationQuotations = many(
      'valuationQuotationContract',
      TYPES.DirectUnitPriceQuotationContract,
    );
    const valuationQuotationVersions = valuationQuotations
      .map((record) => record.versionIri)
      .sort(compareUtf8);
    const declaredValuationQuotationVersions = [
      ...(definition.valuationDefinitionQuotationContract || []),
    ].sort(compareUtf8);
    const fxRows = many('pnlFxConversion', TYPES.FXConversion);
    const valuationSnapshot = valuation.valuedPositionSnapshot
      || valuation.valuedHoldingSnapshot;
    if (valuation.valuationHeader !== header.versionIri
        || valuation.valuationPrice !== price.versionIri
        || valuationSnapshot !== snapshot.versionIri
        || lotState.closedPositionSnapshot !== snapshot.versionIri
        || lotState.stateCostBasisDefinition !== stateDefinition.versionIri
        || lotState.stateQuotationContract !== quotation.versionIri
        || header.valuationDefinition !== definition.versionIri
        || price.quotationContract !== quotation.versionIri
        || canonicalJcs(valuationQuotationVersions)
          !== canonicalJcs(declaredValuationQuotationVersions)
        || definition.valuationQuotationContractCount
          !== declaredValuationQuotationVersions.length
        || definition.valuationQuotationContractVersionSetDigest
          !== iriSetDigest(declaredValuationQuotationVersions)
        || !valuationQuotationVersions.includes(quotation.versionIri)
        || (valuation.valuationFxConversion || null) !== (fxRows[0]?.versionIri || null)
        || fxRows.length > 1) {
      fail(
        'orders-portfolio-pit-producer-join',
        'PnL selected valuation, lot state, snapshot, definitions, quotation, price, header, or FX do not join',
      );
    }
    const market = decodeMoney(valuation.marketValue, 'PnL producer valuation.marketValue');
    const basis = decodeMoney(lotState.remainingCostBasis, 'PnL producer lotState.remainingCostBasis');
    const priceMoney = decodeMoney(price.priceValue, 'PnL producer price.priceValue');
    const reportingCurrency = currencyLexical(
      header.reportingCurrency,
      'PnL producer header.reportingCurrency',
    );
    const basisDefinitionCurrency = currencyLexical(
      stateDefinition.costBasisDefinitionBasisCurrency,
      'PnL producer cost-basis definition currency',
    );
    if (market.currency !== basis.currency
        || market.currency !== priceMoney.currency
        || market.currency !== reportingCurrency
        || market.currency !== basisDefinitionCurrency) {
      fail(
        'orders-portfolio-pit-producer-currency',
        'PnL selected market value, remaining basis, price, and reporting currency disagree',
      );
    }
    const pnlMicros = safeNumber(
      BigInt(market.micros) - BigInt(basis.micros),
      'PnL producer unrealizedPnl',
    );
    return {
      ...temporalFromLegacy(outputPlan.temporal),
      calculationContextRef: lotState.calculationContextRef,
      conversionContextDigest: header.conversionContextDigest,
      conversionContextRef: header.conversionContextRef,
      generatingContextRef: header.generatingContextRef,
      marketValue: structuredClone(valuation.marketValue),
      openLotVersionSetDigest: lotState.openLotVersionSetDigest,
      pnlCostBasisDefinition: stateDefinition.versionIri,
      ...(fxRows.length === 0 ? {} : { pnlFxConversion: fxRows[0].versionIri }),
      pnlLotStateClosure: lotState.versionIri,
      pnlQuotationContract: quotation.versionIri,
      pnlValuation: valuation.versionIri,
      remainingCostBasis: structuredClone(lotState.remainingCostBasis),
      source: outputPlan.source,
      stateAllocationVersionSetDigest: lotState.stateAllocationVersionSetDigest,
      stateExecutionClosureVersionSetDigest:
        lotState.stateExecutionClosureVersionSetDigest,
      typeIri: outputPlan.outputFactTypeIri,
      unrealizedPnl: money(pnlMicros, market.currency),
      versionIri: outputPlan.outputFactVersionIri,
    };
  }
  fail(
    'orders-portfolio-pit-producer-output-type',
    `unsupported materialized output type ${outputPlan.outputFactTypeIri}`,
  );
}

function produceMaterializedFactPitIngress(
  pitRequest,
  selectionBindings,
  selectedRecords,
  outputPlan,
) {
  if (!pitRequest
      || !IRI.test(pitRequest.ref || '')
      || !DIGEST.test(pitRequest.digest || '')
      || !pitRequest.payload
      || typeof pitRequest.payload !== 'object'
      || Array.isArray(pitRequest.payload)
      || pitRequest.digest !== sha256Jcs(pitRequest.payload)
      || !Array.isArray(selectionBindings)
      || selectionBindings.length === 0
      || !Array.isArray(selectedRecords)
      || selectedRecords.length === 0
      || !outputPlan
      || typeof outputPlan !== 'object'
      || Array.isArray(outputPlan)
      || !IRI.test(outputPlan.outputFactTypeIri || '')
      || !exactVersion(outputPlan.outputFactVersionIri)
      || !outputPlan.temporal
      || typeof outputPlan.temporal !== 'object'
      || Array.isArray(outputPlan.temporal)) {
    fail(
      'orders-portfolio-pit-producer-input',
      'request, selection, selected records, or output plan is not canonical',
    );
  }
  const requestPivotFields = ['validAt', 'knowledgeAt', 'availableAt', 'completedAt'];
  const outputTemporal = temporalFromLegacy(outputPlan.temporal);
  if (requestPivotFields.some(
    (field) => instantNanoseconds(pitRequest.payload[field]) === null,
  )
      || ['validFrom', 'knowledgeFrom', 'availableFrom'].some(
        (field) => instantNanoseconds(outputTemporal[field]) === null,
      )
      || instantNanoseconds(pitRequest.payload.completedAt)
        >= instantNanoseconds(outputTemporal.availableFrom)) {
    fail(
      'orders-portfolio-pit-producer-temporal',
      'request pivots and producer completion must be valid and precede output availability',
    );
  }
  for (const record of selectedRecords) {
    const recordTemporal = record && typeof record === 'object' && !Array.isArray(record)
      ? {
        availableFrom: record.availableFrom,
        knowledgeFrom: record.knowledgeFrom,
        validFrom: record.validFrom,
      }
      : null;
    if (!recordTemporal
        || !exactVersion(record.versionIri)
        || !IRI.test(record.typeIri || '')
        || instantNanoseconds(recordTemporal.validFrom) === null
        || instantNanoseconds(recordTemporal.knowledgeFrom) === null
        || instantNanoseconds(recordTemporal.availableFrom) === null
        || instantNanoseconds(recordTemporal.validFrom)
          > instantNanoseconds(pitRequest.payload.validAt)
        || (record.validTo !== undefined
          && (instantNanoseconds(record.validTo) === null
            || instantNanoseconds(pitRequest.payload.validAt)
              >= instantNanoseconds(record.validTo)))
        || instantNanoseconds(recordTemporal.knowledgeFrom)
          > instantNanoseconds(pitRequest.payload.knowledgeAt)
        || instantNanoseconds(recordTemporal.availableFrom)
          > instantNanoseconds(pitRequest.payload.availableAt)) {
      fail(
        'orders-portfolio-pit-producer-selection-temporal',
        `selected record ${record?.versionIri || '<unknown>'} is not PIT-eligible`,
      );
    }
  }
  let previousRole = null;
  const boundVersions = [];
  for (const binding of selectionBindings) {
    if (!binding
        || typeof binding !== 'object'
        || Array.isArray(binding)
        || Object.keys(binding).sort().join(',') !== 'factVersionIris,role'
        || typeof binding.role !== 'string'
        || !/^[a-z][A-Za-z0-9]*$/u.test(binding.role)
        || (previousRole !== null && compareUtf8(previousRole, binding.role) >= 0)
        || !Array.isArray(binding.factVersionIris)
        || binding.factVersionIris.length === 0
        || binding.factVersionIris.some((value) => !exactVersion(value))
        || new Set(binding.factVersionIris).size !== binding.factVersionIris.length
        || binding.factVersionIris.some((value, index) => (
          index > 0 && compareUtf8(binding.factVersionIris[index - 1], value) >= 0
        ))) {
      fail(
        'orders-portfolio-pit-producer-input',
        'selection bindings are not role-sorted exact-version sets',
      );
    }
    previousRole = binding.role;
    boundVersions.push(...binding.factVersionIris);
  }
  const boundVersionSet = [...new Set(boundVersions)].sort(compareUtf8);
  if (boundVersionSet.length === 0) {
    fail(
      'orders-portfolio-pit-producer-input',
      'selection binding union must contain at least one exact FactVersion',
    );
  }
  const selectedFactVersionIris = boundVersionSet;
  const outputRecord = deriveMaterializedFactOutput(
    selectionBindings,
    selectedRecords,
    outputPlan,
  );
  if (!outputRecord
      || typeof outputRecord !== 'object'
      || Array.isArray(outputRecord)
      || outputRecord.typeIri !== outputPlan.outputFactTypeIri
      || outputRecord.versionIri !== outputPlan.outputFactVersionIri) {
    fail(
      'orders-portfolio-pit-producer-output',
      'derived materialized output does not match the declared output identity',
    );
  }
  canonicalJcs(outputRecord);
  const schemaVersion = '1.0';
  const protocol = 'axiolune.orders-portfolio.pit-ingress-verifier.v1';
  const requestKey = sha256Jcs({
    pitRequestRef: pitRequest.ref,
    schemaVersion,
  }).slice('sha256:'.length);
  const proofRef = (role) => `urn:axiolune:pit-ingress:${requestKey}:${role}`;
  const proof = (ref, payload) => ({ digest: sha256Jcs(payload), payload, ref });
  const selected = structuredClone(selectedFactVersionIris);
  const selectedFactVersionSetDigest = iriSetDigest(selected);
  const inventoryRef = proofRef('selected-fact-version-inventory');
  const selectionRequestRef = proofRef('fact-version-selection-request');
  const outputRef = proofRef('materialized-fact-output');
  const runRef = proofRef('materialization-run');
  const reportRef = proofRef('validation-report');
  const ledgerRef = proofRef('evidence-ledger');
  const selectionRequest = proof(selectionRequestRef, {
    artifactKind: 'FactVersionSelectionRequest',
    asOfAvailable: pitRequest.payload.availableAt,
    asOfKnowledge: pitRequest.payload.knowledgeAt,
    asOfValid: pitRequest.payload.validAt,
    outputFactTypeIri: outputRecord.typeIri,
    outputFactVersionIri: outputRecord.versionIri,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion,
    selectedFactVersionCount: selected.length,
    selectedFactVersionSetDigest,
    selectionBindings: structuredClone(selectionBindings),
    selectionContractDigest: sha256DomainJcs(
      'axiolune-fact-version-selection-contract-v1',
      { outputFactTypeIri: outputRecord.typeIri, selectionBindings },
    ),
    selectionRequestRef,
  });
  const selectedFactVersionInventory = proof(inventoryRef, {
    artifactKind: 'SelectedFactVersionInventory',
    inventoryRef,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion,
    selectionRequestDigest: selectionRequest.digest,
    selectionRequestRef: selectionRequest.ref,
    selectedFactVersionCount: selected.length,
    selectedFactVersionIris: selected,
    selectedFactVersionSetDigest,
  });
  const materializedOutput = proof(outputRef, {
    artifactKind: 'MaterializedFactOutput',
    outputFactTypeIri: outputRecord.typeIri,
    outputFactVersionIri: outputRecord.versionIri,
    outputRecord: structuredClone(outputRecord),
    outputRecordDigest: sha256Jcs(outputRecord),
    outputRef,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion,
    selectionRequestDigest: selectionRequest.digest,
    selectionRequestRef: selectionRequest.ref,
    selectedFactVersionInventoryDigest: selectedFactVersionInventory.digest,
    selectedFactVersionInventoryRef: selectedFactVersionInventory.ref,
    selectedFactVersionSetDigest,
  });
  const materializationRun = proof(runRef, {
    artifactKind: 'MaterializationRunCompletion',
    completedAt: pitRequest.payload.completedAt,
    materializationRunRef: runRef,
    materializedOutputDigest: materializedOutput.digest,
    materializedOutputRef: materializedOutput.ref,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    result: {
      outcome: 'completed',
      outputFactTypeIri: outputRecord.typeIri,
      outputFactVersionIri: outputRecord.versionIri,
      outputRecordDigest: materializedOutput.payload.outputRecordDigest,
      selectedFactVersionCount: selected.length,
      selectedFactVersionSetDigest,
    },
    schemaVersion,
    selectionRequestDigest: selectionRequest.digest,
    selectionRequestRef: selectionRequest.ref,
    selectedFactVersionInventoryDigest: selectedFactVersionInventory.digest,
    selectedFactVersionInventoryRef: selectedFactVersionInventory.ref,
    status: 'completed',
  });
  const validationReport = proof(reportRef, {
    artifactKind: 'ValidationReport',
    conforms: true,
    materializationRunDigest: materializationRun.digest,
    materializationRunRef: materializationRun.ref,
    materializedOutputDigest: materializedOutput.digest,
    materializedOutputRef: materializedOutput.ref,
    outputRecordDigest: materializedOutput.payload.outputRecordDigest,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion,
    selectionRequestDigest: selectionRequest.digest,
    selectionRequestRef: selectionRequest.ref,
    selectedFactVersionInventoryDigest: selectedFactVersionInventory.digest,
    selectedFactVersionInventoryRef: selectedFactVersionInventory.ref,
    selectedFactVersionSetDigest,
    status: 'passed',
    validationReportRef: reportRef,
    verifiedAt: pitRequest.payload.completedAt,
    verifierId: protocol,
    verifierProtocolDigest: sha256Jcs({ protocol, schemaVersion }),
  });
  const entries = [
    { artifactDigest: pitRequest.digest, artifactRef: pitRequest.ref, role: 'pitRequest' },
    { artifactDigest: selectedFactVersionInventory.digest, artifactRef: selectedFactVersionInventory.ref, role: 'selectedFactVersionInventory' },
    { artifactDigest: selectionRequest.digest, artifactRef: selectionRequest.ref, role: 'factVersionSelectionRequest' },
    { artifactDigest: materializedOutput.digest, artifactRef: materializedOutput.ref, role: 'materializedFactOutput' },
    { artifactDigest: materializationRun.digest, artifactRef: materializationRun.ref, role: 'materializationRunCompletion' },
    { artifactDigest: validationReport.digest, artifactRef: validationReport.ref, role: 'validationReport' },
  ].sort((left, right) => compareUtf8(left.artifactRef, right.artifactRef));
  const evidenceLedger = proof(ledgerRef, {
    artifactKind: 'EvidenceLedger',
    entries,
    evidenceLedgerRef: ledgerRef,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion,
    status: 'sealed',
  });
  return {
    evidenceLedger,
    materializationRun,
    materializedOutput,
    outputRecord: structuredClone(outputRecord),
    selectionRequest,
    selectedFactVersionInventory,
    validationReport,
  };
}

function namedLockedArtifact(source, artifactField, digestField, defaultRef, artifactName) {
  const supplied = source?.[artifactField] || {};
  return lockedArtifact(
    {
      ...supplied,
      ...(source?.[digestField] ? { digest: source[digestField] } : {}),
    },
    defaultRef,
    { artifact: artifactName },
  );
}

function valuationPolicies(source = {}) {
  return {
    precision: lockedArtifact(
      source.precisionPolicy,
      'https://axiolune.ai/policies/valuation-precision/1',
      DEFAULT_VALUATION_PRECISION_POLICY,
    ),
    rounding: lockedArtifact(
      source.roundingPolicy,
      'https://axiolune.ai/policies/valuation-rounding/1',
      DEFAULT_VALUATION_ROUNDING_POLICY,
    ),
  };
}

function costBasisPolicies(source = {}) {
  return {
    precision: lockedArtifact(
      source.precisionPolicy,
      'https://axiolune.ai/policies/cost-basis-precision/1',
      DEFAULT_COST_BASIS_PRECISION_POLICY,
    ),
    rounding: lockedArtifact(
      source.roundingPolicy,
      'https://axiolune.ai/policies/cost-basis-rounding/1',
      DEFAULT_COST_BASIS_ROUNDING_POLICY,
    ),
  };
}

function fxInputContext(source = {}) {
  return lockedArtifact(
    source.inputContext,
    'https://axiolune.ai/contexts/fx-input/1',
    {
      completedAt: '2025-01-01T00:00:00Z',
      contextId: 'fx-input-1',
      schemaVersion: '1.0',
      status: 'completed',
    },
  );
}

function inferSyntheticSourcePayload(refIri, digestValue) {
  const prefixes = [
    'https://axiolune.ai/evidence/orders-portfolio/',
    'https://axiolune.ai/evidence/',
  ];
  for (const prefix of prefixes) {
    if (!refIri.startsWith(prefix) || refIri.length === prefix.length) continue;
    const payload = { evidence: refIri.slice(prefix.length) };
    if (sha256Jcs(payload) === digestValue) return payload;
  }
  return undefined;
}

function sourceClaimFields(record) {
  return [
    Object.hasOwn(record, 'sourceArtifactDigest'),
    Object.hasOwn(record, 'sourceArtifactRef'),
    Object.hasOwn(record, 'sourceLocator'),
  ];
}

function validateLineageGraphInventoryPayload(
  payload,
  lineageVersionIris,
  focusVersionIri,
  label,
) {
  exactKeys(payload, [
    'artifactKind',
    'focusVersionIri',
    'lineageVersionCount',
    'lineageVersionIris',
    'lineageVersionSetDigest',
    'pitRequestDigest',
    'pitRequestRef',
    'schemaVersion',
    'selectionScopeRef',
  ], [], label);
  const actualVersions = [...lineageVersionIris].sort(compareUtf8);
  const declaredVersions = Array.isArray(payload.lineageVersionIris)
    ? [...payload.lineageVersionIris]
    : [];
  const canonicalDeclaredVersions = [...new Set(declaredVersions)].sort(compareUtf8);
  if (payload.artifactKind !== 'OrderIntentLineageGraphInventory'
      || payload.schemaVersion !== '1.0'
      || !exactVersion(payload.focusVersionIri)
      || payload.focusVersionIri !== focusVersionIri
      || !IRI.test(payload.selectionScopeRef || '')
      || !IRI.test(payload.pitRequestRef || '')
      || !DIGEST.test(payload.pitRequestDigest || '')
      || !Number.isSafeInteger(payload.lineageVersionCount)
      || payload.lineageVersionCount < 1
      || payload.lineageVersionCount !== declaredVersions.length
      || declaredVersions.length !== canonicalDeclaredVersions.length
      || strictCanonicalJcs(declaredVersions)
        !== strictCanonicalJcs(canonicalDeclaredVersions)
      || !declaredVersions.every(exactVersion)
      || payload.lineageVersionSetDigest !== iriSetDigest(declaredVersions)
      || strictCanonicalJcs(declaredVersions) !== strictCanonicalJcs(actualVersions)) {
    fail(
      'orders-portfolio-canonical-lineage-graph-inventory',
      label,
    );
  }
}

function validateLockedSourceEvidenceJoin(record, artifactsByRef, label) {
  const present = sourceClaimFields(record);
  if (!present.some(Boolean)) return;
  if (!present.every(Boolean)) {
    fail('orders-portfolio-canonical-source-evidence-pairing', label);
  }
  const sourceRef = record.sourceArtifactRef?.iri;
  const sourceArtifact = artifactsByRef.get(sourceRef);
  if (!sourceArtifact || sourceArtifact.artifactDigest !== record.sourceArtifactDigest) {
    fail('orders-portfolio-canonical-source-artifact-join', label);
  }
  if (sourceArtifact.mediaType !== record.sourceLocator.mediaType) {
    fail('orders-portfolio-canonical-source-media-type-join', label);
  }
  const profileRef = record.sourceLocator.extractorProfileRef?.iri;
  const profileArtifact = artifactsByRef.get(profileRef);
  if (profileRef !== SOURCE_EXTRACTOR_PROFILE_REF
      || record.sourceLocator.extractorProfileRef?.kind !== 'iri'
      || record.sourceLocator.extractorProfileDigest !== SOURCE_EXTRACTOR_PROFILE_DIGEST
      || record.sourceLocator.kind !== 'wholeFile'
      || !profileArtifact
      || profileArtifact.artifactDigest !== SOURCE_EXTRACTOR_PROFILE_DIGEST
      || profileArtifact.mediaType !== 'application/json'
      || strictCanonicalJcs(profileArtifact.payload)
        !== strictCanonicalJcs(SOURCE_EXTRACTOR_PROFILE_PAYLOAD)) {
    fail('orders-portfolio-canonical-source-extractor-profile', label);
  }
  let selectedBytes;
  try {
    selectedBytes = Buffer.from(strictCanonicalJcs(sourceArtifact.payload), 'utf8');
  } catch (error) {
    fail('orders-portfolio-canonical-source-bytes', `${label}:${error.message}`);
  }
  const locatorResult = validateStrictSourceLocator(record.sourceLocator, {
    at: `${label}.sourceLocator`,
    selectedBytes,
  });
  if (!locatorResult.ok) {
    fail(
      'orders-portfolio-canonical-source-locator',
      locatorResult.errors.join('; '),
    );
  }
}

function closeCanonicalSourceEvidence(records, artifacts) {
  const closedArtifacts = [...artifacts];
  const claims = records.filter((record) => sourceClaimFields(record).some(Boolean));
  if (claims.length === 0) return closedArtifacts;
  const artifactsByRef = new Map();
  for (const row of closedArtifacts) {
    const refIri = row?.artifactRef?.iri;
    if (typeof refIri !== 'string' || artifactsByRef.has(refIri)) {
      fail('orders-portfolio-canonical-artifact-duplicate', refIri || 'missing-ref');
    }
    artifactsByRef.set(refIri, row);
  }
  if (!artifactsByRef.has(SOURCE_EXTRACTOR_PROFILE_REF)) {
    const profileArtifact = artifact(
      SOURCE_EXTRACTOR_PROFILE_REF,
      SOURCE_EXTRACTOR_PROFILE_PAYLOAD,
      SOURCE_EXTRACTOR_PROFILE_DIGEST,
    );
    closedArtifacts.push(profileArtifact);
    artifactsByRef.set(SOURCE_EXTRACTOR_PROFILE_REF, profileArtifact);
  }
  for (const record of claims) {
    const present = sourceClaimFields(record);
    if (!present.every(Boolean)) {
      fail('orders-portfolio-canonical-source-evidence-pairing', record.versionIri);
    }
    const refIri = record.sourceArtifactRef?.iri;
    if (!artifactsByRef.has(refIri)) {
      const payload = record[SOURCE_PAYLOAD]
        || inferSyntheticSourcePayload(refIri, record.sourceArtifactDigest);
      if (payload === undefined) {
        fail(
          'orders-portfolio-canonical-source-artifact-missing',
          `${record.versionIri}:${refIri}`,
        );
      }
      const row = artifact(refIri, payload, record.sourceArtifactDigest);
      closedArtifacts.push(row);
      artifactsByRef.set(refIri, row);
    }
    validateLockedSourceEvidenceJoin(record, artifactsByRef, record.versionIri);
    delete record[SOURCE_PAYLOAD];
  }
  return closedArtifacts;
}

function canonicalDocument(focus, records, artifacts = []) {
  const closedArtifacts = closeCanonicalSourceEvidence(records, artifacts);
  return {
    artifacts: closedArtifacts.sort((a, b) => compareUtf8(a.artifactRef.iri, b.artifactRef.iri)),
    focusVersionIri: focus.versionIri,
    records: records.sort((a, b) => compareUtf8(a.versionIri, b.versionIri)),
    schemaVersion: '1.0',
  };
}

function codeFromLegacy(list, value, aliases = {}) {
  return code(list, aliases[value] || value);
}

function encodeCanonicalOrdersPortfolioScenario(evaluatorId, s, options = {}) {
  if (options.referenceRegistry !== undefined) {
    return withReferenceRegistry(
      options.referenceRegistry,
      () => encodeCanonicalOrdersPortfolioScenario(evaluatorId, s),
    );
  }
  const typeIri = TARGET_TYPE_BY_EVALUATOR[evaluatorId];
  if (!typeIri) fail('orders-portfolio-canonical-evaluator', evaluatorId);
  const t = s?.temporal;
  const records = [];
  const artifacts = [];
  let focus;
  const add = (record) => { records.push(record); return record; };
  const addArtifact = (row) => { artifacts.push(row); return row; };
  const addVerifierOwnedPitIngress = (pitRequest, selectedFactVersionIris) => {
    const ingress = buildVerifierOwnedPitIngress(
      pitRequest,
      selectedFactVersionIris,
    );
    for (const proof of [
      ingress.selectedFactVersionInventory,
      ingress.materializationRun,
      ingress.validationReport,
      ingress.evidenceLedger,
    ]) {
      addArtifact(artifact(proof.ref, proof.payload, proof.digest));
    }
  };
  const addProducedMaterializedFactPitIngress = (
    pitRequest,
    selectionBindings,
    selectedRecords,
    outputPlan,
  ) => {
    const ingress = produceMaterializedFactPitIngress(
      pitRequest,
      selectionBindings,
      selectedRecords,
      outputPlan,
    );
    for (const proof of [
      ingress.selectedFactVersionInventory,
      ingress.selectionRequest,
      ingress.materializedOutput,
      ingress.materializationRun,
      ingress.validationReport,
      ingress.evidenceLedger,
    ]) {
      addArtifact(artifact(proof.ref, proof.payload, proof.digest));
    }
    return ingress;
  };
  const account = s?.account?.logicalIri || refLogical('account/1');
  const instrument = s?.instrument?.logicalIri || refLogical('instrument/1');
  const streamVersion = s?.stream?.versionIri || s?.executionStream?.versionIri || refVersion('order-stream/1');
  const ensureCostBasisDefinitionRecord = (
    versionIri,
    basisCurrency = 'USD',
    suffix = 'support',
  ) => {
    if (!exactVersion(versionIri)) {
      fail(
        'orders-portfolio-canonical-reference-mode',
        `CostBasisCalculationDefinition:${versionIri}`,
      );
    }
    const existing = records.find((row) => row.versionIri === versionIri);
    if (existing) {
      if (existing.typeIri !== TYPES.CostBasisCalculationDefinition) {
        fail('orders-portfolio-canonical-reference-type', versionIri);
      }
      return existing;
    }
    return add(defaultRecord(
      TYPES.CostBasisCalculationDefinition,
      `cost-definition/${suffix}`,
      t,
      {
        costBasisDefinitionBasisCurrency: refLogical(
          `currency/${basisCurrency}`,
        ),
        costBasisDefinitionId: `cost-${suffix}`,
        versionIri,
      },
    ));
  };
  const addMarketContext = (options = {}) => {
    const kind = options.kind || 'listing';
    if (kind === 'listing') {
      const listing = add(defaultRecord(
        TYPES.InstrumentListing,
        options.name || 'listing/1',
        options.temporal || t,
        {
          listedInstrument: options.listedInstrumentVersionIri || `${options.instrumentIri || instrument}/version/0`,
          listingQuoteCurrency: refLogical(`currency/${options.quoteCurrency || 'USD'}`),
        },
      ));
      return { kind, record: listing };
    }
    if (kind === 'otc') {
      const otc = add(defaultRecord(
        TYPES.OTCTradingContext,
        options.name || 'otc-context/1',
        options.temporal || t,
        { otcQuoteCurrency: refLogical(`currency/${options.quoteCurrency || 'USD'}`) },
      ));
      return { kind, record: otc };
    }
    fail('orders-portfolio-canonical-market-context', kind);
  };
  const addLiquidityDetermination = (source = {}, suffix = '1', options = {}) => {
    const executionVersionIri = options.executionVersionIri
      || source.execution?.versionIri
      || refVersion('execution/1');
    const determinationStreamVersionIri = source.stream?.versionIri
      || options.streamVersionIri
      || streamVersion;
    const capability = source.capability || 'required';
    const perspective = source.perspective || 'executionAccountOrder';
    const outcome = source.outcome || (capability === 'unsupported' ? 'unavailable' : 'classified');
    const pointer = source.pointer || '/liquidity';
    const role = source.role || 'Maker';
    const sourceRecord = structuredClone(
      source.sourceRecord || (outcome === 'classified' ? { liquidity: source.rawValue || 'M' } : {}),
    );
    const sourceRecordDigest = sha256Jcs(sourceRecord);

    let streamRecord = records.find((record) => (
      record.versionIri === determinationStreamVersionIri
      && record.typeIri === TYPES.OrderEventStream
    ));
    let sourceContractRef;
    let sourceContractDigest;
    if (streamRecord) {
      sourceContractRef = streamRecord.sourceContractRef;
      sourceContractDigest = streamRecord.sourceContractDigest;
    } else {
      sourceContractRef = `https://axiolune.ai/contracts/orders/liquidity/${suffix}`;
      const sourceContractPayload = {
        liquidityRoleCapability: capability,
        schemaVersion: '1.0',
        semanticMapping: { rawFieldLocator: pointer },
        sourceSchema: { fields: [pointer], schemaVersion: '1.0' },
      };
      sourceContractDigest = sha256Jcs(sourceContractPayload);
      addArtifact(artifact(sourceContractRef, sourceContractPayload, sourceContractDigest));
      streamRecord = add(defaultRecord(TYPES.OrderEventStream, `order-stream/${suffix}`, t, {
        liquidityRoleCapability: codeFromLegacy(`${ORDERS}LiquidityRoleCapability`, capability),
        sourceContractDigest,
        sourceContractRef,
        versionIri: determinationStreamVersionIri,
      }));
    }

    if (options.addExecution !== false
        && !records.some((record) => record.versionIri === executionVersionIri)) {
      add(defaultRecord(TYPES.Execution, `execution/${suffix}`, t, {
        executionStream: determinationStreamVersionIri,
        versionIri: executionVersionIri,
      }));
    }
    const recordRef = `https://axiolune.ai/source-records/liquidity/${suffix}`;
    addArtifact(artifact(recordRef, sourceRecord, sourceRecordDigest));
    const overrides = {
      determinedExecution: executionVersionIri,
      determinationStream: determinationStreamVersionIri,
      liquidityDeterminationResult: codeFromLegacy(`${ORDERS}LiquidityDeterminationResult`, outcome),
      liquidityPerspective: codeFromLegacy(`${ORDERS}LiquidityPerspective`, perspective),
      sourceRecordDigest,
      sourceRecordRef: recordRef,
    };
    if (outcome === 'classified') {
      const rawValue = source.rawValue ?? sourceRecord.liquidity ?? 'M';
      const mappingEntries = structuredClone(source.mappingEntries || [{
        ...(role === 'Undefined'
          ? { auctionSemantic: { kind: 'auction-or-uncrossed', reviewed: true } } : {}),
        rawValue,
        role,
      }]);
      const mappingPayload = {
        entries: mappingEntries,
        perspectiveInversion: source.mappingPerspectiveInversion === true,
        rawFieldLocator: pointer,
        rawPerspective: source.mappingRawPerspective || 'executionAccountOrder',
        schemaVersion: '1.0',
      };
      const mappingRef = `https://axiolune.ai/mappings/liquidity/determination/${suffix}`;
      const mappingDigest = sha256Jcs(mappingPayload);
      addArtifact(artifact(mappingRef, mappingPayload, mappingDigest));
      const mapping = add(defaultRecord(
        TYPES.LiquidityRoleMapping,
        `liquidity-mapping/${suffix}`,
        t,
        {
          liquidityMappingId: `liquidity-determination-${suffix}`,
          mappingDigest,
          perspectiveInversion: mappingPayload.perspectiveInversion,
          rawFieldLocator: pointer,
          rawPerspective: mappingPayload.rawPerspective,
          sourceContractDigest,
          sourceContractRef,
        },
      ));
      overrides.liquidityMapping = mapping.versionIri;
      overrides.liquidityRole = code(`${ORDERS}LiquidityRole`, {
        Maker: 'maker', Taker: 'taker', Undefined: 'auctionUndefined',
      }[role] || role);
      overrides.rawFieldLocator = pointer;
      overrides.rawLexicalValue = rawValue;
    } else {
      overrides.liquidityUnavailableReason = codeFromLegacy(
        `${ORDERS}LiquidityUnavailableReason`,
        source.absenceReason || (
          capability === 'unsupported' ? 'contractUnsupported' : 'providerNotSpecified'
        ),
      );
      if (source.rawValue !== undefined) overrides.rawLexicalValue = source.rawValue;
      const shouldAddProbe = source.absenceProbePassed === true
        || (capability === 'optional' && source.absenceProbePassed !== false);
      if (shouldAddProbe) {
        const probePayload = {
          rawFieldLocator: pointer,
          result: 'absent',
          schemaVersion: '1.0',
          sourceRecordDigest,
          status: 'completed',
        };
        overrides.fieldAbsenceProbeRef = `https://axiolune.ai/probes/liquidity-absence/${suffix}`;
        overrides.fieldAbsenceProbeDigest = sha256Jcs(probePayload);
        addArtifact(artifact(
          overrides.fieldAbsenceProbeRef,
          probePayload,
          overrides.fieldAbsenceProbeDigest,
        ));
      }
    }
    const determination = defaultRecord(
      TYPES.LiquidityRoleDetermination,
      `liquidity-determination/${suffix}`,
      t,
      overrides,
    );
    if (outcome !== 'classified') {
      for (const field of [
        'liquidityMapping', 'liquidityRole', 'rawFieldLocator', 'rawLexicalValue',
      ]) delete determination[field];
      if (source.rawValue !== undefined) determination.rawLexicalValue = source.rawValue;
    }
    return add(determination);
  };
  const addMembershipClosure = (source = {}, suffix = '1') => {
    const closureTemporal = source.temporal || t;
    const portfolioIri = source.portfolio?.logicalIri
      || source.portfolioLogicalIri
      || source.memberClosurePortfolioIri
      || refLogical('portfolio/1');
    const declaredMembers = [...(source.members || [
      refVersion('membership/a'),
      refVersion('membership/b'),
    ])].sort(compareUtf8);
    const defaultMemberTemporal = source.memberTemporal || {
      availableFrom: '2025-01-01T00:00:00.500000000Z',
      knowledgeFrom: '2025-01-01T00:00:00.250000000Z',
      revision: 0,
      validFrom: '2025-01-01T00:00:00Z',
    };
    const membershipSources = source.membershipRecords || declaredMembers.map((versionIri, index) => ({
      account: { logicalIri: refLogical(`account/${index + 1}`), referenceMode: 'logical' },
      membershipId: `membership-${index + 1}`,
      portfolio: { logicalIri: portfolioIri, referenceMode: 'logical' },
      temporal: defaultMemberTemporal,
      versionIri,
    }));
    for (const [index, membership] of membershipSources.entries()) {
      add(defaultRecord(
        TYPES.PortfolioAccountMembership,
        `membership/closure-${suffix}-${index + 1}`,
        membership.temporal || closureTemporal,
        {
          memberAccount: membership.account?.logicalIri || refLogical(`account/${index + 1}`),
          membershipId: membership.membershipId || `membership-${index + 1}`,
          membershipPortfolio: membership.portfolio?.logicalIri || portfolioIri,
          versionIri: membership.versionIri || declaredMembers[index],
        },
      ));
    }

    const inputContext = lockedArtifact(
      source.inputContext,
      source.inputContextRef || `https://axiolune.ai/contexts/membership-closure/${suffix}`,
      {
        completedAt: '2025-01-01T00:00:00Z',
        contextId: `membership-closure-${suffix}`,
        schemaVersion: '1.0',
        status: 'completed',
      },
    );
    const pitRequest = lockedArtifact(
      source.pitRequest,
      source.pitRequestRef || `https://axiolune.ai/pit/membership-closure/${suffix}`,
      {
        availableAt: '2025-01-01T00:00:01Z',
        completedAt: '2025-01-01T00:00:01Z',
        knowledgeAt: '2025-01-01T00:00:01Z',
        requestId: `membership-closure-${suffix}`,
        schemaVersion: '1.0',
        status: 'passed',
        validAt: '2025-01-01T00:00:00Z',
      },
    );
    const closureProbe = lockedArtifact(
      source.closureProbe,
      `https://axiolune.ai/probes/membership-closure/${suffix}`,
      {
        completedAt: '2025-01-01T00:00:01.500000000Z',
        inputContextDigest: inputContext.digest,
        inputContextRef: inputContext.ref,
        membershipCount: source.membershipCount ?? declaredMembers.length,
        membershipVersionIris: declaredMembers,
        membershipVersionSetDigest: source.membershipVersionSetDigest
          || iriSetDigest(declaredMembers),
        pitRequestDigest: pitRequest.digest,
        pitRequestRef: pitRequest.ref,
        portfolioLogicalIri: portfolioIri,
        result: 'complete',
        schemaVersion: '1.0',
        status: 'completed',
      },
    );
    addArtifact(inputContext.artifact);
    addArtifact(pitRequest.artifact);
    addVerifierOwnedPitIngress(pitRequest, declaredMembers);
    addArtifact(closureProbe.artifact);
    return add(defaultRecord(
      TYPES.PortfolioAccountMembershipClosure,
      `membership-closure/${suffix}`,
      closureTemporal,
      {
        closedMembership: declaredMembers,
        closurePortfolio: portfolioIri,
        generatingContextRef: source.generatingContextRef
          || refVersion(`run/membership-closure/${suffix}`),
        inputContextRecordDigest: inputContext.digest,
        inputContextRef: inputContext.ref,
        membershipClosureProbeDigest: closureProbe.digest,
        membershipClosureProbeRef: closureProbe.ref,
        membershipCount: source.membershipCount ?? declaredMembers.length,
        membershipVersionSetDigest: source.membershipVersionSetDigest
          || iriSetDigest(declaredMembers),
        pitRequestRecordDigest: pitRequest.digest,
        pitRequestRef: pitRequest.ref,
        ...(source.versionIri ? { versionIri: source.versionIri } : {}),
      },
    ));
  };
  const addValuationDefinition = (source = {}, suffix = '1') => {
    const definitionTemporal = source.temporal || t;
    const quotationSources = source.quotationContracts
      || (source.quotationContract ? [source.quotationContract] : [{
        versionIri: refVersion(`quotation/${suffix}`),
      }]);
    const quotations = quotationSources.map((quotation, index) => {
      const versionIri = quotation.versionIri
        || refVersion(`quotation/${suffix}-${index + 1}`);
      const existing = records.find((record) => record.versionIri === versionIri);
      if (existing) {
        if (existing.typeIri !== TYPES.DirectUnitPriceQuotationContract) {
          fail('orders-portfolio-canonical-reference-type', versionIri);
        }
        return existing;
      }
      return add(defaultRecord(
        TYPES.DirectUnitPriceQuotationContract,
        `quotation/${suffix}-${index + 1}`,
        quotation.temporal || definitionTemporal,
        {
          quotationDenominatorUnit: quantityUnitIri(quotation.denominatorUnit || 'share'),
          quotationInstrument: quotation.instrument?.logicalIri
            || quotation.instrumentLogicalIri
            || refLogical('instrument/1'),
          quotationQuoteCurrency: quotation.quoteCurrency?.logicalIri
            || quotation.quoteCurrencyLogicalIri
            || refLogical('currency/USD'),
          versionIri,
        },
      ));
    });
    const quotationVersionIris = quotations.map((quotation) => quotation.versionIri)
      .sort(compareUtf8);
    const policies = valuationPolicies(source);
    const executable = {
      formula: namedLockedArtifact(
        source,
        'formulaArtifact',
        'formulaDigest',
        `https://axiolune.ai/artifacts/valuation/${suffix}/formula`,
        'formula',
      ),
      input: namedLockedArtifact(
        source,
        'inputContractArtifact',
        'inputContractDigest',
        `https://axiolune.ai/artifacts/valuation/${suffix}/input`,
        'input',
      ),
      output: namedLockedArtifact(
        source,
        'outputContractArtifact',
        'outputContractDigest',
        `https://axiolune.ai/artifacts/valuation/${suffix}/output`,
        'output',
      ),
      runtime: namedLockedArtifact(
        source,
        'runtimeArtifact',
        'runtimeDigest',
        `https://axiolune.ai/artifacts/valuation/${suffix}/runtime`,
        'runtime',
      ),
      toolLock: namedLockedArtifact(
        source,
        'toolLockArtifact',
        'toolLockDigest',
        source.toolLockRef || `https://axiolune.ai/artifacts/valuation/${suffix}/tool-lock`,
        'tool-lock',
      ),
    };
    for (const row of [
      policies.precision,
      policies.rounding,
      executable.formula,
      executable.input,
      executable.output,
      executable.runtime,
      executable.toolLock,
    ]) addArtifact(row.artifact);
    return add(defaultRecord(
      TYPES.ValuationCalculationDefinition,
      `valuation-definition/${suffix}`,
      definitionTemporal,
      {
        formulaDigest: executable.formula.digest,
        inputContractDigest: executable.input.digest,
        outputContractDigest: executable.output.digest,
        precisionPolicyDigest: policies.precision.digest,
        precisionPolicyRef: policies.precision.ref,
        roundingPolicyDigest: policies.rounding.digest,
        roundingPolicyRef: policies.rounding.ref,
        runtimeDigest: executable.runtime.digest,
        toolLockDigest: executable.toolLock.digest,
        toolLockRef: executable.toolLock.ref,
        valuationDefinitionAuthority: source.authority?.logicalIri
          || refLogical('authority/valuation'),
        valuationDefinitionId: source.definitionId ?? `valuation-${suffix}`,
        valuationDefinitionQuotationContract: quotationVersionIris,
        valuationMethod: codeFromLegacy(
          `${PORTFOLIO}ValuationMethod`,
          source.method || 'directUnitPriceTimesQuantity',
        ),
        valuationQuotationContractCount: source.quotationContractCount
          ?? quotationVersionIris.length,
        valuationQuotationContractVersionSetDigest:
          source.quotationContractVersionSetDigest || iriSetDigest(quotationVersionIris),
        ...(source.versionIri ? { versionIri: source.versionIri } : {}),
      },
    ));
  };

  switch (evaluatorId) {
    case 'OrderIntentContract': {
      const context = addMarketContext({
        kind: s.contextKind || 'listing',
        listedInstrumentVersionIri: s.listedInstrumentVersionIri,
        quoteCurrency: s.contextQuoteCurrency || 'USD',
        temporal: s.contextTemporal,
      });
      const overrides = {
        clientIntentId: s.clientIntentId, intentAccount: account, intentInstrument: instrument,
        orderQuantity: quantity(s.quantityMicros), orderSide: codeFromLegacy(`${ORDERS}OrderSide`, s.side),
        orderType: codeFromLegacy(`${ORDERS}OrderType`, s.kind),
        timeInForce: codeFromLegacy(`${ORDERS}TimeInForce`, s.timeInForce, { Day: 'DAY' }),
        ...sourceFields('intent', s.sourceEvidence),
      };
      overrides[context.kind === 'listing' ? 'intentListing' : 'intentOtcContext'] = context.record.versionIri;
      if (s.validUntil !== undefined) overrides.orderValidUntil = s.validUntil;
      if (s.limitPriceMicros !== undefined) overrides.limitPrice = money(s.limitPriceMicros);
      if (s.triggerPriceMicros !== undefined) overrides.triggerPrice = money(s.triggerPriceMicros);
      if (s.triggerPriceBasis !== undefined) overrides.triggerPriceBasis = codeFromLegacy(`${ORDERS}TriggerPriceBasis`, s.triggerPriceBasis);
      focus = add(defaultRecord(typeIri, 'intent/1', t, overrides));
      break;
    }
    case 'ExternalOrderContract':
      focus = add(defaultRecord(typeIri, 'external-order/1', t, {
        externalOrderId: s.externalOrderId, externalOrderOriginatingIntent: s.originatingIntent.versionIri || s.originatingIntent.logicalIri,
        externalOrderProvider: s.provider.logicalIri, providerApiIdentifier: s.apiIdentifier, providerSchemaVersion: s.providerSchemaVersion,
        ...sourceFields('external-order', s.sourceEvidence),
      }));
      break;
    case 'OrderEventStreamContract': {
      const contractRef = 'https://axiolune.ai/contracts/orders/source/1';
      addArtifact(artifact(contractRef, s.lockedSourceContract, s.sourceContractDigest));
      focus = add(defaultRecord(typeIri, 'order-stream/1', t, {
        liquidityRoleCapability: codeFromLegacy(`${ORDERS}LiquidityRoleCapability`, s.liquidityRoleCapability),
        providerApiIdentifier: s.providerApiIdentifier ?? 'api-v1', providerSchemaVersion: s.providerSchemaVersion ?? '1.0',
        providerStreamId: s.providerStreamId ?? 'provider-stream-1', sourceContractDigest: s.sourceContractDigest,
        sourceContractRef: contractRef, streamExternalOrder: s.externalOrder.logicalIri, streamProvider: s.provider.logicalIri,
        ...sourceFields('event-stream', s.sourceEvidence),
      }));
      break;
    }
    case 'ExternalOrderStatusVocabularyContract':
      focus = add(defaultRecord(typeIri, 'status-vocabulary/1', t, {
        providerApiIdentifier: s.apiIdentifier, providerSchemaVersion: s.providerSchemaVersion,
        statusVocabularyId: s.vocabularyId, statusVocabularyProvider: s.provider.logicalIri,
        ...sourceFields('status-vocabulary', s.sourceEvidence),
      }));
      break;
    case 'OrderTransitionProfileContract':
      for (const [role, digestValue, ref, payload] of [
        ['implementation', s.implementationDigest, 'https://axiolune.ai/artifacts/transition/implementation/1', { artifact: 'transition-implementation' }],
        ['input-contract', s.inputContractDigest, 'https://axiolune.ai/artifacts/transition/input-contract/1', { artifact: 'transition-input' }],
        ['output-contract', s.outputContractDigest, 'https://axiolune.ai/artifacts/transition/output-contract/1', { artifact: 'transition-output' }],
        ['runtime', s.runtimeDigest, 'https://axiolune.ai/artifacts/transition/runtime/1', { artifact: 'transition-runtime' }],
        ['tool-lock', s.toolLockDigest, s.toolLockRef, { artifact: 'transition-tool' }],
      ]) {
        const supplied = s.lockedArtifacts?.[role];
        addArtifact(artifact(
          supplied?.ref || ref,
          supplied?.payload || payload,
          supplied?.digest || digestValue,
        ));
      }
      focus = add(defaultRecord(typeIri, 'transition-profile/1', t, {
        implementationDigest: s.implementationDigest, inputContractDigest: s.inputContractDigest, outputContractDigest: s.outputContractDigest,
        runtimeDigest: s.runtimeDigest, toolLockDigest: s.toolLockDigest, toolLockRef: s.toolLockRef,
        transitionProfileId: s.profileId, transitionProfileProvider: s.provider.logicalIri,
      }));
      break;
    case 'LiquidityRoleMappingContract': {
      const rawFieldLocator = s.rawFieldLocator || '/liquidity';
      const sourceContract = lockedArtifact(
        s.sourceContractArtifact,
        s.sourceContractRef,
        { artifact: 'source-contract' },
      );
      addArtifact(sourceContract.artifact);
      const mappingRef = `https://axiolune.ai/mappings/liquidity/${encodeURIComponent(s.mappingId || 'mapping')}`;
      const mappingPayload = {
        entries: structuredClone(s.entries),
        perspectiveInversion: s.perspectiveInversion,
        rawFieldLocator,
        rawPerspective: s.rawPerspective,
        schemaVersion: '1.0',
      };
      const mappingDigest = sha256Jcs(mappingPayload);
      addArtifact(artifact(mappingRef, mappingPayload, mappingDigest));
      focus = add(defaultRecord(typeIri, 'liquidity-mapping/1', t, {
        liquidityMappingId: s.mappingId, mappingDigest, perspectiveInversion: s.perspectiveInversion,
        rawFieldLocator, rawPerspective: s.rawPerspective,
        sourceContractDigest: sourceContract.digest, sourceContractRef: sourceContract.ref,
      }));
      break;
    }
    case 'OrderLifecycleEventContract': {
      const retries = s.retries || [{ key: s.sourceOrderKey, kind: 'Accepted' }];
      const sourcePayload = {
        providerEvents: retries.map((row) => ({
          event: structuredClone(row),
          providerEventId: s.providerEventId,
          sourceOrderKey: s.sourceOrderKey,
        })),
        schemaVersion: '1.0',
      };
      const sourceDigest = sha256Jcs(sourcePayload);
      const sourceRef = 'https://axiolune.ai/source-records/order-event/1';
      addArtifact(artifact(sourceRef, sourcePayload, sourceDigest));
      add(defaultRecord(TYPES.OrderIntent, 'intent/1', t, {
        versionIri: s.orderIntent.versionIri,
      }));
      add(defaultRecord(TYPES.ExternalOrder, 'external-order/1', t, {
        externalOrderOriginatingIntent: s.orderIntent.versionIri,
        versionIri: s.externalOrder.versionIri,
      }));
      add(defaultRecord(TYPES.OrderEventStream, 'order-stream/1', t, {
        streamExternalOrder: s.externalOrder.logicalIri,
        versionIri: s.stream.versionIri,
      }));
      focus = add(defaultRecord(typeIri, 'event/1', t, {
        eventStream: streamVersion, externalOrder: s.externalOrder.versionIri || s.externalOrder.logicalIri,
        lifecycleState: code(`${ORDERS}OrderLifecycleState`, retries[0]?.kind || 'Accepted'),
        orderEventKind: code(`${ORDERS}OrderEventKind`, retries[0]?.kind || 'Accepted'),
        orderIntent: s.orderIntent.versionIri || s.orderIntent.logicalIri, providerEventId: s.providerEventId,
        sourceOrderKey: s.sourceOrderKey,
        ...sourceFields('order-event', {
          digest: sourceDigest,
          payload: sourcePayload,
          ref: sourceRef,
        }),
      }));
      break;
    }
    case 'OrderIntentLineageContract': {
      const endpointIntents = [
        ...(s.sourceIntents || []),
        ...(s.resultIntents || []),
      ];
      const uniqueEndpointIntents = new Map();
      for (const endpoint of endpointIntents) {
        if (endpoint?.versionIri) uniqueEndpointIntents.set(endpoint.versionIri, endpoint);
      }
      const context = addMarketContext({
        kind: 'listing',
        listedInstrumentVersionIri: refVersion('instrument/1'),
        quoteCurrency: 'USD',
        temporal: t,
      });
      for (const [index, endpoint] of [...uniqueEndpointIntents.values()].entries()) {
        if (!endpoint.sourceEvidence) {
          fail(
            'orders-portfolio-canonical-lineage-endpoint-source-evidence',
            endpoint.versionIri || `endpoint-${index + 1}`,
          );
        }
        add(defaultRecord(
          TYPES.OrderIntent,
          `intent/lineage-${index + 1}`,
          endpoint.temporal || t,
          {
            clientIntentId: endpoint.clientIntentId || `lineage-intent-${index + 1}`,
            intentAccount: endpoint.account?.logicalIri || refLogical(`account/lineage-${index + 1}`),
            intentInstrument: endpoint.instrument?.logicalIri || instrument,
            intentListing: context.record.versionIri,
            orderQuantity: quantity(endpoint.quantityMicros, endpoint.quantityUnit),
            orderSide: codeFromLegacy(`${ORDERS}OrderSide`, endpoint.side),
            versionIri: endpoint.versionIri,
            ...sourceFields(`order-lineage-intent-${index + 1}`, endpoint.sourceEvidence),
          },
        ));
      }
      const lineageRows = (s.lineages || [{
        kind: s.kind,
        orderLineageKeyDigest: s.orderLineageKeyDigest,
        resultIntentCount: s.resultIntentCount,
        resultIntentVersionSetDigest: s.resultIntentVersionSetDigest,
        resultIntentVersionIris: s.resultIntentVersionIris,
        sourceIntentCount: s.sourceIntentCount,
        sourceIntentVersionSetDigest: s.sourceIntentVersionSetDigest,
        sourceIntentVersionIris: s.sourceIntentVersionIris,
        temporal: s.temporal,
        versionIri: s.versionIri || refVersion('order-intent-lineage/1'),
      }]);
      for (const [index, lineage] of lineageRows.entries()) {
        if (!(lineage.sourceEvidence || s.sourceEvidence)) {
          fail(
            'orders-portfolio-canonical-lineage-source-evidence',
            lineage.versionIri || `lineage-${index + 1}`,
          );
        }
        const sourceIntentVersionIris = [...lineage.sourceIntentVersionIris].sort(compareUtf8);
        const resultIntentVersionIris = [...lineage.resultIntentVersionIris].sort(compareUtf8);
        const sourceIntentVersionSetDigest = lineage.sourceIntentVersionSetDigest
          || iriSetDigest(sourceIntentVersionIris);
        const resultIntentVersionSetDigest = lineage.resultIntentVersionSetDigest
          || iriSetDigest(resultIntentVersionIris);
        const kind = lineage.kind;
        const orderLineageKeyDigest = lineage.orderLineageKeyDigest || sha256DomainJcs(
          'axiolune-order-intent-lineage-key-v1',
          { kind, resultIntentVersionSetDigest, sourceIntentVersionSetDigest },
        );
        const record = add(defaultRecord(
          TYPES.OrderIntentLineage,
          `order-intent-lineage/${index + 1}`,
          lineage.temporal || t,
          {
            orderLineageKeyDigest,
            orderLineageKind: code(`${ORDERS}OrderLineageKind`, kind),
            resultIntentCount: lineage.resultIntentCount ?? resultIntentVersionIris.length,
            resultIntentVersionSetDigest,
            resultOrderIntent: resultIntentVersionIris,
            sourceIntentCount: lineage.sourceIntentCount ?? sourceIntentVersionIris.length,
            sourceIntentVersionSetDigest,
            sourceOrderIntent: sourceIntentVersionIris,
            versionIri: lineage.versionIri || refVersion(`order-intent-lineage/${index + 1}`),
            ...sourceFields(`order-intent-lineage-${index + 1}`, lineage.sourceEvidence || s.sourceEvidence),
          },
        ));
        if (index === 0) focus = record;
      }
      const requestedFocus = s.versionIri || s.focusVersionIri;
      if (requestedFocus) {
        focus = records.find((row) => row.versionIri === requestedFocus) || focus;
      }
      const graphEvidence = s.sourceEvidence || lineageRows[0]?.sourceEvidence;
      if (!graphEvidence?.payload) {
        fail(
          'orders-portfolio-canonical-lineage-graph-inventory',
          'selected graph evidence payload is absent',
        );
      }
      validateLineageGraphInventoryPayload(
        graphEvidence.payload,
        lineageRows.map((lineage) => (
          lineage.versionIri || refVersion(`order-intent-lineage/${lineageRows.indexOf(lineage) + 1}`)
        )),
        focus.versionIri,
        'OrderIntentLineage.selectedGraphInventory',
      );
      if (!s.pitRequest?.payload
          || s.pitRequest.ref !== graphEvidence.payload.pitRequestRef
          || s.pitRequest.digest !== graphEvidence.payload.pitRequestDigest
          || s.pitRequest.digest !== sha256Jcs(s.pitRequest.payload)) {
        fail(
          'orders-portfolio-canonical-lineage-pit-request',
          'selected graph inventory does not bind an exact PIT validation request',
        );
      }
      for (const [index, lineage] of lineageRows.entries()) {
        const evidenceValue = lineage.sourceEvidence || s.sourceEvidence;
        if (!evidenceValue
            || evidenceValue.ref !== graphEvidence.ref
            || evidenceValue.digest !== graphEvidence.digest
            || strictCanonicalJcs(evidenceValue.payload)
              !== strictCanonicalJcs(graphEvidence.payload)) {
          fail(
            'orders-portfolio-canonical-lineage-graph-inventory',
            `lineage-${index + 1} does not bind the common selected graph inventory`,
          );
        }
      }
      addArtifact(artifact(
        s.pitRequest.ref,
        s.pitRequest.payload,
        s.pitRequest.digest,
      ));
      const selectedLineageFactVersions = [...new Set([
        ...uniqueEndpointIntents.keys(),
        ...records
          .filter((record) => record.typeIri === TYPES.OrderIntentLineage)
          .map((record) => record.versionIri),
      ])].sort(compareUtf8);
      addVerifierOwnedPitIngress(s.pitRequest, selectedLineageFactVersions);
      break;
    }
    case 'ExecutionContract': {
      const context = addMarketContext({
        kind: s.contextKind || 'listing',
        listedInstrumentVersionIri: s.listedInstrumentVersionIri,
        quoteCurrency: s.quoteCurrency,
        temporal: s.contextTemporal,
      });
      const intentVersion = refVersion('intent/1');
      const quoteVersion = refVersion('quotation/1');
      const contextField = context.kind === 'listing' ? 'intentListing' : 'intentOtcContext';
      add(defaultRecord(TYPES.OrderIntent, 'intent/1', t, {
        [contextField]: context.record.versionIri,
        intentAccount: s.intentAccountIri,
        intentInstrument: s.intentInstrumentIri,
      }));
      const externalOrder = add(defaultRecord(TYPES.ExternalOrder, 'external-order/1', t, {
        externalOrderOriginatingIntent: intentVersion,
      }));
      add(defaultRecord(TYPES.OrderEventStream, 'order-stream/1', t, {
        streamExternalOrder: externalOrder.versionIri.slice(0, externalOrder.versionIri.lastIndexOf('/version/')),
        versionIri: streamVersion,
      }));
      add(defaultRecord(TYPES.DirectUnitPriceQuotationContract, 'quotation/1', t, {
        [context.kind === 'listing' ? 'quotationListingContext' : 'quotationOTCContext']: context.record.versionIri,
        quotationDenominatorUnit: quantityUnitIri(s.quoteDenominatorUnit), quotationInstrument: s.quoteInstrumentIri,
        quotationQuoteCurrency: refLogical(`currency/${s.quoteCurrency}`),
      }));
      focus = add(defaultRecord(typeIri, 'execution/1', t, {
        contraAccount: s.contraAccount.logicalIri, contraParty: s.contraParty.logicalIri,
        executionAccount: account, executionInstrument: instrument, executionOrderIntent: intentVersion,
        executionExternalOrder: externalOrder.versionIri,
        executionParty: s.executionParty.logicalIri,
        [context.kind === 'listing' ? 'executionListing' : 'executionOtcContext']: context.record.versionIri,
        executionPrice: money(s.priceMicros ?? 3000000, s.priceCurrency), executionQuantity: quantity(s.quantityMicros, s.quantityUnit),
        executionQuotationContract: quoteVersion, executionStream: streamVersion,
        ...(s.executingBroker?.logicalIri ? { executingBroker: s.executingBroker.logicalIri } : {}),
        orderSide: codeFromLegacy(`${ORDERS}OrderSide`, s.side),
        providerExecutionId: s.providerExecutionId ?? 'execution-1',
        ...sourceFields('execution', s.sourceEvidence),
      }));
      break;
    }
    case 'ExecutionLiquidityDeterminationCompletenessContract': {
      focus = add(defaultRecord(TYPES.Execution, 'execution/1', t, { executionStream: streamVersion }));
      for (const [index, row] of (s.determinations || []).entries()) {
        addLiquidityDetermination(row, String(index + 1), {
          addExecution: false,
          executionVersionIri: focus.versionIri,
          streamVersionIri: row.stream?.versionIri || streamVersion,
        });
      }
      break;
    }
    case 'FeeContract':
      focus = add(defaultRecord(typeIri, 'fee/1', t, {
        feeAmount: money(s.amountMicros, s.amountCurrency || 'USD'),
        feeEffect: codeFromLegacy(`${ORDERS}FeeEffect`, s.effect),
        feeExecution: s.execution.versionIri || s.execution.logicalIri,
        feeId: s.feeId,
        feeKind: codeFromLegacy(`${ORDERS}FeeKind`, s.feeKind || 'commission'),
        ...(s.assessor?.logicalIri ? { feeAssessor: s.assessor.logicalIri } : {}),
        ...sourceFields('fee', s.sourceEvidence),
      }));
      break;
    case 'ExternalOrderStatusMappingContract': {
      const vocabulary = add(defaultRecord(TYPES.ExternalOrderStatusVocabulary, 'status-vocabulary/1', t, {
        providerApiIdentifier: s.vocabularyApiIdentifier, providerSchemaVersion: s.vocabularySchemaVersion,
        statusVocabularyProvider: s.vocabularyProviderIri,
      }));
      focus = add(defaultRecord(typeIri, 'status-mapping/1', t, {
        canonicalLifecycleState: code(`${ORDERS}OrderLifecycleState`, s.canonicalStates[0]),
        providerApiIdentifier: s.apiIdentifier, providerSchemaVersion: s.providerSchemaVersion,
        rawStatusCode: s.rawStatusCode || 'ACCEPTED',
        reviewDecisionDigest: s.reviewEvidence.digest,
        reviewDecisionRef: s.reviewEvidence.ref,
        statusMappingReviewer: s.reviewer?.logicalIri || refLogical('party/reviewer'),
        statusMappingVersion: s.mappingVersion || '1.0',
        statusProvider: s.provider.logicalIri, statusVocabulary: vocabulary.versionIri,
        ...sourceFields('status-mapping', s.sourceEvidence),
      }));
      break;
    }
    case 'LiquidityRoleDeterminationContract': {
      focus = addLiquidityDetermination(s, '1', {
        executionVersionIri: s.execution.versionIri,
        streamVersionIri: s.stream.versionIri,
      });
      break;
    }
    case 'OrderEventIntegrityFindingContract': {
      const subject = structuredClone(s.findingSubject || (() => {
        switch (s.kind) {
          case 'duplicateConflict':
            return { providerEventId: s.findingProviderEventId };
          case 'sequenceGap':
            return { missingFrom: s.missingKeyFrom, missingTo: s.missingKeyTo };
          case 'outOfOrder':
            return {
              observedKey: s.observedSourceOrderKey,
              requiredPredecessorKey: s.requiredPredecessorSourceOrderKey,
            };
          case 'lateFill':
            return {
              fillVersionIri: s.subjectFillExecutionVersionIri,
              terminalEventVersionIri: s.subjectTerminalEventVersionIri,
            };
          case 'missingAcknowledgement':
            return {
              expectedAfterKey: s.expectedAfterSourceOrderKey,
              externalOrderVersionIri: s.subjectMissingAcknowledgementOrderVersionIri,
            };
          case 'transitionViolation':
            return {
              fromEventVersionIri: s.subjectFromEventVersionIri,
              toEventVersionIri: s.subjectToEventVersionIri,
              transitionProfileVersionIri: s.evaluatedTransitionProfileVersionIri,
            };
          default:
            return {};
        }
      })());
      const ensureArtifact = (ref, payload) => {
        const digestValue = sha256Jcs(payload);
        const existing = artifacts.find((row) => row.artifactRef.iri === ref);
        if (existing) {
          if (existing.artifactDigest !== digestValue
              || canonicalJcs(existing.payload) !== canonicalJcs(payload)) {
            fail('orders-portfolio-canonical-artifact-conflict', ref);
          }
          return existing;
        }
        return addArtifact(artifact(ref, payload, digestValue));
      };
      const ensureRecord = (record) => {
        const existing = records.find((row) => row.versionIri === record.versionIri);
        if (existing) {
          if (existing.typeIri !== record.typeIri) {
            fail('orders-portfolio-canonical-reference-type', record.versionIri);
          }
          return existing;
        }
        return add(record);
      };
      const externalVersionIri = subject.externalOrderVersionIri
        || refVersion('external-order/finding');
      const externalLogicalIri = externalVersionIri.slice(
        0,
        externalVersionIri.lastIndexOf('/version/'),
      );
      const intent = ensureRecord(defaultRecord(TYPES.OrderIntent, 'intent/finding', t));
      const externalOrder = ensureRecord(defaultRecord(
        TYPES.ExternalOrder,
        'external-order/finding',
        t,
        {
          externalOrderOriginatingIntent: intent.versionIri,
          versionIri: externalVersionIri,
        },
      ));
      const stream = ensureRecord(defaultRecord(TYPES.OrderEventStream, 'order-stream/finding', t, {
        streamExternalOrder: externalLogicalIri,
        versionIri: streamVersion,
      }));
      const addFindingEvent = (descriptor, index) => {
        const eventVersionIri = descriptor.versionIri
          || refVersion(`event/finding-${index + 1}`);
        const providerEventId = descriptor.providerEventId || `finding-event-${index + 1}`;
        const sourceOrderKey = descriptor.sourceOrderKey ?? index;
        const eventKind = descriptor.kind || 'Accepted';
        const lifecycleState = descriptor.lifecycleState || eventKind;
        const sourcePayload = structuredClone(descriptor.sourcePayload || {
          eventKind,
          lifecycleState,
          providerEventId,
          schemaVersion: '1.0',
          sourceOrderKey,
        });
        const sourceDigest = sha256Jcs(sourcePayload);
        const sourceRef = descriptor.sourceRef
          || `https://axiolune.ai/source-records/order-finding/${sourceDigest.slice(7)}`;
        ensureArtifact(sourceRef, sourcePayload);
        return ensureRecord(defaultRecord(
          TYPES.OrderLifecycleEvent,
          `event/finding-${index + 1}`,
          t,
          {
            eventStream: stream.versionIri,
            externalOrder: externalOrder.versionIri,
            lifecycleState: code(`${ORDERS}OrderLifecycleState`, lifecycleState),
            observedAt: descriptor.observedAt || '2025-01-01T00:00:00.100000000Z',
            orderEventKind: code(`${ORDERS}OrderEventKind`, eventKind),
            orderIntent: intent.versionIri,
            providerEventId,
            sourceOrderKey,
            versionIri: eventVersionIri,
            ...sourceFields(`order-finding-event-${index + 1}`, {
              digest: sourceDigest,
              payload: sourcePayload,
              ref: sourceRef,
            }),
          },
        ));
      };
      const addFindingExecution = (descriptor = {}) => ensureRecord(defaultRecord(
        TYPES.Execution,
        'execution/finding-fill',
        t,
        {
          executionExternalOrder: externalOrder.versionIri,
          executionOrderIntent: intent.versionIri,
          executionStream: stream.versionIri,
          observedAt: descriptor.observedAt || '2025-01-01T00:00:00.200000000Z',
          providerExecutionId: descriptor.providerExecutionId || 'finding-fill-1',
          sourceOrderKey: descriptor.sourceOrderKey ?? 2,
          versionIri: descriptor.versionIri || refVersion('execution/finding-fill'),
        },
      ));
      const addFindingTransitionProfile = (descriptor = {}) => {
        const inputPayload = structuredClone(descriptor.inputContract || {
          allowedTransitions: { Accepted: ['Filled'] },
          schemaVersion: '1.0',
        });
        const locks = {
          implementation: {
            payload: descriptor.implementation || { artifact: 'order-finding-transition-implementation' },
            ref: 'https://axiolune.ai/artifacts/order-finding-transition/implementation/1',
          },
          inputContract: {
            payload: inputPayload,
            ref: 'https://axiolune.ai/artifacts/order-finding-transition/input-contract/1',
          },
          outputContract: {
            payload: descriptor.outputContract || { artifact: 'order-finding-transition-output' },
            ref: 'https://axiolune.ai/artifacts/order-finding-transition/output-contract/1',
          },
          runtime: {
            payload: descriptor.runtime || { artifact: 'order-finding-transition-runtime' },
            ref: 'https://axiolune.ai/artifacts/order-finding-transition/runtime/1',
          },
          toolLock: {
            payload: descriptor.toolLock || { artifact: 'order-finding-transition-tool' },
            ref: descriptor.toolLockRef
              || 'https://axiolune.ai/tools/order-finding-transition-lock/1',
          },
        };
        for (const lock of Object.values(locks)) ensureArtifact(lock.ref, lock.payload);
        return ensureRecord(defaultRecord(
          TYPES.OrderTransitionProfile,
          'transition-profile/finding',
          t,
          {
            implementationDigest: sha256Jcs(locks.implementation.payload),
            inputContractDigest: sha256Jcs(locks.inputContract.payload),
            outputContractDigest: sha256Jcs(locks.outputContract.payload),
            runtimeDigest: sha256Jcs(locks.runtime.payload),
            toolLockDigest: sha256Jcs(locks.toolLock.payload),
            toolLockRef: locks.toolLock.ref,
            transitionProfileId: descriptor.profileId || 'order-finding-transition-v1',
            versionIri: descriptor.versionIri
              || subject.transitionProfileVersionIri
              || refVersion('transition-profile/finding'),
          },
        ));
      };

      let eventDescriptors = structuredClone(s.relatedLifecycleEvents || []);
      let executionDescriptors = structuredClone(s.relatedExecutions || []);
      let transitionProfileDescriptor = structuredClone(s.evaluatedTransitionProfile || {});
      if (eventDescriptors.length === 0) {
        switch (s.kind) {
          case 'duplicateConflict':
            eventDescriptors = [
              {
                kind: 'Accepted',
                lifecycleState: 'Accepted',
                providerEventId: subject.providerEventId,
                sourceOrderKey: 1,
                versionIri: refVersion('event/finding-duplicate-a'),
              },
              {
                kind: 'Rejected',
                lifecycleState: 'Rejected',
                providerEventId: subject.providerEventId,
                sourceOrderKey: 1,
                versionIri: refVersion('event/finding-duplicate-b'),
              },
            ];
            break;
          case 'sequenceGap':
            eventDescriptors = [
              ...(subject.missingFrom === 0 ? [] : [{
                sourceOrderKey: subject.missingFrom - 1,
                versionIri: refVersion('event/finding-gap-before'),
              }]),
              {
                sourceOrderKey: subject.missingTo,
                versionIri: refVersion('event/finding-gap-after'),
              },
            ];
            break;
          case 'outOfOrder':
            eventDescriptors = [
              {
                observedAt: '2025-01-01T00:00:00.100000000Z',
                sourceOrderKey: subject.requiredPredecessorKey,
                versionIri: refVersion('event/finding-required-predecessor'),
              },
              {
                observedAt: '2025-01-01T00:00:00.200000000Z',
                sourceOrderKey: subject.observedKey,
                versionIri: refVersion('event/finding-observed'),
              },
            ];
            break;
          case 'lateFill':
            eventDescriptors = [{
              kind: 'Canceled',
              lifecycleState: 'Canceled',
              observedAt: '2025-01-01T00:00:00.100000000Z',
              sourceOrderKey: 1,
              versionIri: subject.terminalEventVersionIri,
            }];
            executionDescriptors = [{
              observedAt: '2025-01-01T00:00:00.200000000Z',
              sourceOrderKey: 2,
              versionIri: subject.fillVersionIri,
            }];
            break;
          case 'missingAcknowledgement':
            eventDescriptors = [{
              kind: 'Submitted',
              lifecycleState: 'Submitted',
              sourceOrderKey: subject.expectedAfterKey,
              versionIri: refVersion('event/finding-submitted'),
            }];
            break;
          case 'transitionViolation':
            eventDescriptors = [
              {
                kind: 'Accepted',
                lifecycleState: 'Accepted',
                sourceOrderKey: 1,
                versionIri: subject.fromEventVersionIri,
              },
              {
                kind: 'Canceled',
                lifecycleState: 'Canceled',
                sourceOrderKey: 2,
                versionIri: subject.toEventVersionIri,
              },
            ];
            transitionProfileDescriptor.versionIri = subject.transitionProfileVersionIri;
            break;
          default:
            break;
        }
      }
      const relatedEvents = eventDescriptors.map(addFindingEvent);
      const relatedExecutions = executionDescriptors.map(addFindingExecution);
      const overrides = {
        affectedKeyDigest: sha256DomainJcs('axiolune-order-finding-subject-v1', subject),
        findingStream: stream.versionIri,
        generatingContextRef: s.generatingContextRef || refVersion('run/order-integrity/1'),
        orderIntegrityKind: codeFromLegacy(`${ORDERS}OrderIntegrityKind`, s.kind),
      };
      if (relatedEvents.length > 0) {
        overrides.relatedLifecycleEvent = relatedEvents.map((record) => record.versionIri);
      }
      if (relatedExecutions.length > 0) {
        overrides.relatedExecution = relatedExecutions.map((record) => record.versionIri);
      }
      const specialRelated = [];
      switch (s.kind) {
        case 'duplicateConflict':
          overrides.findingProviderEventId = subject.providerEventId;
          break;
        case 'sequenceGap':
          overrides.missingKeyFrom = subject.missingFrom;
          overrides.missingKeyTo = subject.missingTo;
          break;
        case 'outOfOrder':
          overrides.observedSourceOrderKey = subject.observedKey;
          overrides.requiredPredecessorSourceOrderKey = subject.requiredPredecessorKey;
          break;
        case 'lateFill':
          overrides.subjectFillExecution = subject.fillVersionIri;
          overrides.subjectTerminalEvent = subject.terminalEventVersionIri;
          specialRelated.push(subject.fillVersionIri, subject.terminalEventVersionIri);
          break;
        case 'missingAcknowledgement':
          overrides.expectedAfterSourceOrderKey = subject.expectedAfterKey;
          overrides.subjectMissingAcknowledgementOrder = subject.externalOrderVersionIri;
          specialRelated.push(subject.externalOrderVersionIri);
          break;
        case 'transitionViolation': {
          const profile = addFindingTransitionProfile(transitionProfileDescriptor);
          overrides.evaluatedTransitionProfile = profile.versionIri;
          overrides.subjectFromEvent = subject.fromEventVersionIri;
          overrides.subjectToEvent = subject.toEventVersionIri;
          specialRelated.push(
            subject.fromEventVersionIri,
            subject.toEventVersionIri,
            profile.versionIri,
          );
          break;
        }
        default:
          break;
      }
      const relatedVersions = [...new Set([
        ...relatedEvents.map((record) => record.versionIri),
        ...relatedExecutions.map((record) => record.versionIri),
        ...specialRelated,
      ])].sort(compareUtf8);
      overrides.relatedVersionSetDigest = iriSetDigest(relatedVersions);
      const finding = defaultRecord(typeIri, 'order-finding/1', t);
      for (const field of [
        'evaluatedTransitionProfile',
        'expectedAfterSourceOrderKey',
        'findingProviderEventId',
        'missingKeyFrom',
        'missingKeyTo',
        'observedSourceOrderKey',
        'relatedExecution',
        'relatedLifecycleEvent',
        'requiredPredecessorSourceOrderKey',
        'subjectFillExecution',
        'subjectFromEvent',
        'subjectMissingAcknowledgementOrder',
        'subjectTerminalEvent',
        'subjectToEvent',
      ]) delete finding[field];
      focus = add(Object.assign(finding, overrides));
      break;
    }
    case 'PortfolioContract':
      focus = add(defaultRecord(typeIri, 'portfolio/1', t, { portfolioId: s.portfolioId }));
      break;
    case 'PortfolioObservationStreamContract':
      focus = add(defaultRecord(typeIri, 'portfolio-observation-stream/1', t, {
        portfolioObservationCompletenessContractDigest: s.completenessContract.digest,
        portfolioObservationCompletenessContractRef: s.completenessContract.ref,
        portfolioObservationPaginationContractDigest: s.paginationContract.digest,
        portfolioObservationPaginationContractRef: s.paginationContract.ref,
        portfolioObservationSourceContractDigest: s.sourceContract.digest,
        portfolioObservationSourceContractRef: s.sourceContract.ref,
        portfolioObservationStreamId: s.streamId,
        portfolioObservationStreamProvider: s.provider.logicalIri,
        ...sourceFields('portfolio-observation-stream', s.sourceEvidence),
        ...(s.versionIri ? { versionIri: s.versionIri } : {}),
      }));
      break;
    case 'PortfolioAccountMembershipContract':
      focus = add(defaultRecord(typeIri, 'membership/1', t, {
        approvalDigest: s.approvalEvidence.digest, approvalRef: s.approvalEvidence.ref,
        memberAccount: s.account.logicalIri, membershipAuthority: s.authorityEvidence.ref,
        membershipId: s.membershipId, membershipPortfolio: s.portfolio.logicalIri,
        ...sourceFields('membership', s.sourceEvidence),
      }));
      break;
    case 'PortfolioManagementMandateContract':
      focus = add(defaultRecord(typeIri, 'mandate/1', t, {
        approvalDigest: s.approvalEvidence.digest, approvalRef: s.approvalEvidence.ref,
        managedPortfolio: s.portfolio.logicalIri, managingParty: s.managingParty.logicalIri,
        mandateAuthority: s.authorityEvidence.ref, mandateId: s.mandateId,
        ...sourceFields('mandate', s.sourceEvidence),
      }));
      break;
    case 'PortfolioAccountMembershipClosureContract': {
      focus = addMembershipClosure(s);
      break;
    }
    case 'HoldingSnapshotContract': {
      const listingVersionIri = s.listingVersionIri === null
        ? null
        : (s.listingVersionIri || refVersion('listing/holding'));
      if (listingVersionIri) {
        add(defaultRecord(
          TYPES.InstrumentListing,
          'listing/holding',
          s.listingTemporal || t,
          {
            listedInstrument: s.listingInstrumentVersionIri
              || `${instrument}/version/0`,
            versionIri: listingVersionIri,
          },
        ));
      }
      focus = add(defaultRecord(typeIri, 'holding/1', t, {
        generatingContextRef: s.generatingContextRef
          || refVersion('run/holding/1'),
        holdingAccount: account,
        holdingInstrument: instrument,
        holdingObservationStream: s.observationStream?.versionIri
          || refVersion('portfolio-observation-stream/1'),
        ...(listingVersionIri ? { holdingListing: listingVersionIri } : {}),
        holdingQuantity: quantity(
          s.quantityMicros,
          s.quantityUnit || 'share',
        ),
        positionSourceKind: codeFromLegacy(
          `${PORTFOLIO}PositionSourceKind`,
          s.sourceKind || 'externalReported',
        ),
        snapshotId: s.snapshotId || 'holding-1',
        ...sourceFields('holding', s.sourceEvidence),
        ...(s.versionIri ? { versionIri: s.versionIri } : {}),
      }));
      break;
    }
    case 'PositionSnapshotContract': {
      const listingVersionIri = s.listingVersionIri === null
        ? null
        : (s.listingVersionIri || refVersion('listing/position'));
      if (listingVersionIri) {
        add(defaultRecord(
          TYPES.InstrumentListing,
          'listing/position',
          s.listingTemporal || t,
          {
            listedInstrument: s.listingInstrumentVersionIri
              || `${instrument}/version/0`,
            versionIri: listingVersionIri,
          },
        ));
      }
      focus = add(defaultRecord(typeIri, 'position/1', t, {
        generatingContextRef: s.generatingContextRef
          || refVersion('run/position/1'),
        positionAccount: account,
        positionInstrument: instrument,
        positionObservationStream: s.observationStream?.logicalIri
          || refLogical('portfolio-observation-stream/1'),
        ...(listingVersionIri ? { positionListing: listingVersionIri } : {}),
        positionQuantity: quantity(
          s.quantityMicros,
          s.quantityUnit || 'share',
        ),
        positionSourceKind: codeFromLegacy(
          `${PORTFOLIO}PositionSourceKind`,
          s.sourceKind || 'executionDerived',
        ),
        snapshotId: s.snapshotId || 'position-1',
        ...sourceFields('position', s.sourceEvidence),
        ...(s.versionIri ? { versionIri: s.versionIri } : {}),
      }));
      break;
    }
    case 'PositionLotContract': {
      const policies = costBasisPolicies(s.costBasisDefinition);
      addArtifact(policies.precision.artifact);
      addArtifact(policies.rounding.artifact);
      const listing = add(defaultRecord(TYPES.InstrumentListing, 'listing/1', t, {
        listedInstrument: `${s.instrument.logicalIri}/version/0`,
        listingQuoteCurrency: refLogical(`currency/${s.executionCurrency}`),
      }));
      const quote = add(defaultRecord(TYPES.DirectUnitPriceQuotationContract, 'quotation/1', t, {
        quotationDenominatorUnit: quantityUnitIri(s.quantityUnit),
        quotationInstrument: s.instrument.logicalIri,
        quotationListingContext: listing.versionIri,
        quotationQuoteCurrency: refLogical(`currency/${s.executionCurrency}`),
      }));
      const definition = add(defaultRecord(TYPES.CostBasisCalculationDefinition, 'cost-definition/1', t, {
        costBasisDefinitionBasisCurrency: refLogical(`currency/${s.basisCurrency}`),
        costBasisDefinitionQuotationContract: quote.versionIri,
        precisionPolicyDigest: policies.precision.digest,
        precisionPolicyRef: policies.precision.ref,
        roundingPolicyDigest: policies.rounding.digest,
        roundingPolicyRef: policies.rounding.ref,
      }));
      const execution = add(defaultRecord(TYPES.Execution, 'execution/1', t, {
        executionAccount: s.account.logicalIri,
        executionInstrument: s.instrument.logicalIri,
        executionListing: listing.versionIri,
        executionPrice: money(s.executionPriceMicros, s.executionCurrency),
        executionQuantity: quantity(Math.abs(s.originalQuantityMicros), s.quantityUnit),
        executionQuotationContract: quote.versionIri,
        orderSide: code(`${ORDERS}OrderSide`, s.originalQuantityMicros < 0 ? 'Sell' : 'Buy'),
      }));
      focus = add(defaultRecord(typeIri, 'lot/1', t, {
        calculationContextRef: s.calculationContextRef,
        costBasisDefinition: definition.versionIri,
        lotDiscriminator: s.lotDiscriminator,
        lotAtListing: listing.versionIri,
        lotForInstrument: s.instrument.logicalIri,
        lotInAccount: s.account.logicalIri,
        lotQuotationContract: quote.versionIri,
        openingCostBasis: money(s.openingCostBasisMicros, s.basisCurrency),
        openingExecution: execution.versionIri,
        openingGross: money(s.openingGrossMicros, s.basisCurrency),
        originalQuantity: quantity(s.originalQuantityMicros, s.quantityUnit),
        ...sourceFields('position-lot', s.sourceEvidence),
      }));
      if (s.fxConversion) {
        const rate = add(defaultRecord(TYPES.FXRateObservation, 'opening-fx-rate/1', s.fxConversion.rateTemporal || t, {
          baseCurrency: refLogical(`currency/${s.fxConversion.baseCurrency}`),
          fxRate: quantity(
            s.fxConversion.ratePpm,
            `${s.fxConversion.quoteCurrency}-per-${s.fxConversion.baseCurrency}`,
          ),
          quoteCurrency: refLogical(`currency/${s.fxConversion.quoteCurrency}`),
        }));
        const inputContext = fxInputContext(s.fxConversion);
        addArtifact(inputContext.artifact);
        const directGross = safeNumber(
          costBasisDirectUnitValueRaw(
            Math.abs(s.originalQuantityMicros),
            s.executionPriceMicros,
            policies.precision.payload,
            policies.rounding.payload,
          ),
          'pre-FX opening gross',
        );
        const fx = add(defaultRecord(TYPES.FXConversion, 'opening-fx/1', t, {
          conversionOpeningLot: focus.versionIri,
          conversionRate: rate.versionIri,
          fxConversionDirection: codeFromLegacy(`${PORTFOLIO}FXConversionDirection`, s.fxConversion.direction),
          inputContextRecordDigest: inputContext.digest,
          inputContextRef: inputContext.ref,
          inputMoney: money(s.fxConversion.inputMicros ?? directGross, s.fxConversion.inputCurrency),
          outputMoney: money(s.fxConversion.outputMicros ?? s.openingGrossMicros, s.fxConversion.outputCurrency),
          roundingPolicyDigest: policies.rounding.digest,
          roundingPolicyRef: policies.rounding.ref,
        }));
        focus.openingGrossFxConversion = fx.versionIri;
      }
      break;
    }
    case 'PositionLotOpeningAllocationCompletenessContract': {
      const lotDocument = encodeCanonicalOrdersPortfolioScenario(
        'PositionLotContract',
        {
          account: logicalRef(s.accountIri || refLogical('account/1')),
          basisCurrency: s.basisCurrency || 'USD',
          calculationContextRef: s.calculationContextRef
            || 'https://axiolune.ai/context/calculation/1',
          costBasisDefinition: s.costBasisDefinition,
          executionCurrency: s.executionCurrency || 'USD',
          executionPriceMicros: s.executionPriceMicros || 1_000_000,
          instrument: logicalRef(s.instrumentIri || refLogical('instrument/1')),
          lotDiscriminator: 'openingRemainder',
          openingCostBasisMicros: Math.sign(s.originalQuantityMicros)
            * Math.abs(s.originalQuantityMicros),
          openingGrossMicros: Math.abs(s.originalQuantityMicros),
          originalQuantityMicros: s.originalQuantityMicros,
          quantityUnit: s.quantityUnit || 'share',
          sourceEvidence: {
            digest: sha256Jcs({ evidence: 'opening-allocation-lot' }),
            ref: 'https://axiolune.ai/evidence/opening-allocation-lot',
          },
          temporal: t,
        },
      );
      for (const row of lotDocument.artifacts) addArtifact(row);
      for (const row of lotDocument.records) add(row);
      focus = records.find((row) => row.versionIri === lotDocument.focusVersionIri);
      for (const [index, row] of s.openingAllocations.entries()) {
        add(defaultRecord(TYPES.PositionLotAllocation, `opening-allocation/${index}`, t, {
          allocatedLot: row.lotVersionIri,
          allocatedQuantity: quantity(
            row.quantityMicros,
            row.quantityUnit || s.quantityUnit || 'share',
          ),
          allocationCostBasisDefinition: row.definitionVersionIri
            || focus.costBasisDefinition,
          allocationExecution: row.executionVersionIri,
          calculationContextRef: row.calculationContextRef
            || focus.calculationContextRef,
          lotAllocationKind: code(`${PORTFOLIO}PositionLotAllocationKind`, 'opening'),
          ...(row.versionIri ? { versionIri: row.versionIri } : {}),
        }));
      }
      break;
    }
    case 'ValuationCalculationDefinitionContract': {
      focus = addValuationDefinition(s);
      break;
    }
    case 'CostBasisCalculationDefinitionContract': {
      const policies = costBasisPolicies(s);
      const executable = {
        implementation: namedLockedArtifact(
          s,
          'implementationArtifact',
          'implementationDigest',
          'https://axiolune.ai/artifacts/cost-basis/1/implementation',
          'cost-implementation',
        ),
        input: namedLockedArtifact(
          s,
          'inputContractArtifact',
          'inputContractDigest',
          'https://axiolune.ai/artifacts/cost-basis/1/input',
          'cost-input',
        ),
        output: namedLockedArtifact(
          s,
          'outputContractArtifact',
          'outputContractDigest',
          'https://axiolune.ai/artifacts/cost-basis/1/output',
          'cost-output',
        ),
        runtime: namedLockedArtifact(
          s,
          'runtimeArtifact',
          'runtimeDigest',
          'https://axiolune.ai/artifacts/cost-basis/1/runtime',
          'cost-runtime',
        ),
        toolLock: namedLockedArtifact(
          s,
          'toolLockArtifact',
          'toolLockDigest',
          s.toolLockRef || 'https://axiolune.ai/artifacts/cost-basis/1/tool-lock',
          'cost-tool-lock',
        ),
      };
      for (const row of [
        policies.precision,
        policies.rounding,
        executable.implementation,
        executable.input,
        executable.output,
        executable.runtime,
        executable.toolLock,
      ]) addArtifact(row.artifact);
      focus = add(defaultRecord(typeIri, 'cost-definition/1', t, {
        costBasisDefinitionAuthority: s.authority.logicalIri, costBasisDefinitionBasisCurrency: s.basisCurrency.logicalIri,
        costBasisDefinitionId: s.definitionId,
        costBasisDefinitionQuotationContract: s.quotationContract.versionIri, costBasisMethod: codeFromLegacy(`${PORTFOLIO}CostBasisMethod`, s.method),
        currencyPolicy: s.currencyPolicy,
        feeTreatment: codeFromLegacy(`${PORTFOLIO}FeeTreatment`, s.feeTreatment), implementationDigest: executable.implementation.digest,
        fxPolicy: s.fxPolicy,
        inputContractDigest: executable.input.digest, lotConsumptionPolicy: codeFromLegacy(`${PORTFOLIO}LotConsumptionPolicy`, s.lotConsumptionPolicy),
        lotOpeningPolicy: codeFromLegacy(`${PORTFOLIO}LotOpeningPolicy`, s.lotOpeningPolicy), outputContractDigest: executable.output.digest,
        precisionPolicyDigest: policies.precision.digest, precisionPolicyRef: policies.precision.ref,
        roundingPolicyDigest: policies.rounding.digest, roundingPolicyRef: policies.rounding.ref,
        runtimeDigest: executable.runtime.digest, toolLockDigest: executable.toolLock.digest, toolLockRef: executable.toolLock.ref,
        ...(s.versionIri ? { versionIri: s.versionIri } : {}),
        ...sourceFields('cost-definition', s.sourceEvidence),
      }));
      break;
    }
    case 'PortfolioValuationContract': {
      const inputTemporal = s.inputTemporal || t;
      const memberClosure = addMembershipClosure(
        s.memberClosure ? {
          ...s.memberClosure,
          temporal: s.memberClosure.temporal || inputTemporal,
        } : {
          memberClosurePortfolioIri: s.memberClosurePortfolioIri,
          temporal: inputTemporal,
        },
        'portfolio-valuation',
      );
      const definition = addValuationDefinition(
        {
          ...(s.valuationDefinition || {}),
          temporal: s.valuationDefinition?.temporal || inputTemporal,
        },
        'portfolio-valuation',
      );
      const inputContext = lockedArtifact(
        s.inputContext,
        'https://axiolune.ai/contexts/portfolio-valuation/input',
        {
          completedAt: '2025-01-01T00:00:00Z',
          contextId: 'portfolio-valuation-input',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const conversionContext = lockedArtifact(
        s.conversionContext,
        'https://axiolune.ai/contexts/portfolio-valuation/conversion',
        {
          completedAt: '2025-01-01T00:00:00Z',
          contextId: 'portfolio-valuation-conversion',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const pitRequest = lockedArtifact(
        s.pitRequest,
        'https://axiolune.ai/pit/portfolio-valuation',
        {
          availableAt: '2025-01-01T00:00:02Z',
          completedAt: '2025-01-01T00:00:02Z',
          knowledgeAt: '2025-01-01T00:00:01Z',
          requestId: 'portfolio-valuation',
          schemaVersion: '1.0',
          status: 'passed',
          validAt: '2025-01-01T00:00:00Z',
        },
      );
      addArtifact(inputContext.artifact);
      addArtifact(conversionContext.artifact);
      addArtifact(pitRequest.artifact);
      const selectionBindings = [
        { factVersionIris: [memberClosure.versionIri], role: 'memberAccountClosure' },
        { factVersionIris: structuredClone(memberClosure.closedMembership || []), role: 'memberMembership' },
        { factVersionIris: [definition.versionIri], role: 'valuationDefinition' },
        {
          factVersionIris: structuredClone(
            definition.valuationDefinitionQuotationContract || [],
          ),
          role: 'valuationQuotationContract',
        },
      ].filter((row) => row.factVersionIris.length > 0)
        .sort((left, right) => compareUtf8(left.role, right.role));
      const selectedFactVersionIris = [...new Set(selectionBindings.flatMap(
        (row) => row.factVersionIris,
      ))].sort(compareUtf8);
      const selectedRecords = selectedFactVersionIris.map((versionIri) => {
        const record = records.find((candidate) => candidate.versionIri === versionIri);
        if (!record) fail('orders-portfolio-pit-producer-selection', versionIri);
        return record;
      });
      const ingress = addProducedMaterializedFactPitIngress(
        pitRequest,
        selectionBindings,
        selectedRecords,
        {
          conversionContext,
          generatingContextRef: s.generatingContextRef
            || refVersion('run/portfolio-valuation/1'),
          inputContext,
          outputFactTypeIri: typeIri,
          outputFactVersionIri: s.versionIri || refVersion('portfolio-valuation/1'),
          pitRequest,
          reportingCurrency: s.reportingCurrency?.logicalIri
            || refLogical(`currency/${s.reportingCurrency || 'USD'}`),
          source: 'https://axiolune.ai/sources/orders-portfolio-custom/portfolio-valuation/1',
          temporal: t,
          valuationRunId: s.valuationRunId,
          valuedPortfolio: s.valuedPortfolio.logicalIri,
        },
      );
      focus = add(ingress.outputRecord);
      break;
    }
    case 'PositionValuationContract': {
      const definitionSource = s.valuationDefinition || {};
      const policies = valuationPolicies(definitionSource);
      addArtifact(policies.precision.artifact);
      addArtifact(policies.rounding.artifact);
      const marketContext = addMarketContext({
        instrumentIri: s.priceInstrumentIri,
        kind: s.contextKind || s.priceContext?.kind || 'listing',
        name: 'valuation-market-context/1',
        quoteCurrency: s.priceCurrency,
        temporal: s.contextTemporal || s.priceContext?.temporal || t,
      });
      const snapshotOverrides = {
        positionAccount: s.snapshotAccountIri, positionInstrument: s.snapshotInstrumentIri,
        positionQuantity: quantity(s.quantityMicros, s.quantityUnit),
      };
      if (marketContext.kind === 'listing') {
        snapshotOverrides.positionListing = marketContext.record.versionIri;
      }
      const snapshot = add(defaultRecord(TYPES.PositionSnapshot, 'position/1', t, snapshotOverrides));
      const quoteOverrides = {
        quotationDenominatorUnit: quantityUnitIri(s.quoteDenominatorUnit), quotationInstrument: s.priceInstrumentIri,
        quotationQuoteCurrency: refLogical(`currency/${s.priceCurrency}`),
      };
      if (marketContext.kind === 'listing') {
        quoteOverrides.quotationListingContext = marketContext.record.versionIri;
      } else {
        quoteOverrides.quotationOTCContext = marketContext.record.versionIri;
      }
      const quote = add(defaultRecord(TYPES.DirectUnitPriceQuotationContract, 'quotation/1', t, quoteOverrides));
      const priceOverrides = {
        observedInstrument: `${s.priceInstrumentIri}/version/0`,
        priceValue: money(s.priceMicros, s.priceCurrency),
        quotationContract: quote.versionIri,
      };
      if (marketContext.kind === 'listing') {
        priceOverrides.observedListing = marketContext.record.versionIri;
      } else {
        priceOverrides.observedOtcContext = marketContext.record.versionIri;
      }
      const price = add(defaultRecord(TYPES.PriceObservation, 'price/1', t, priceOverrides));
      const definition = add(defaultRecord(TYPES.ValuationCalculationDefinition, 'valuation-definition/1', t, {
        precisionPolicyDigest: policies.precision.digest,
        precisionPolicyRef: policies.precision.ref,
        roundingPolicyDigest: policies.rounding.digest,
        roundingPolicyRef: policies.rounding.ref,
        valuationDefinitionQuotationContract: [quote.versionIri],
        valuationMethod: codeFromLegacy(
          `${PORTFOLIO}ValuationMethod`,
          definitionSource.method || 'directUnitPriceTimesQuantity',
        ),
        valuationQuotationContractCount: 1,
        valuationQuotationContractVersionSetDigest: iriSetDigest([quote.versionIri]),
      }));
      const membership = add(defaultRecord(TYPES.PortfolioAccountMembership, 'membership/a', t, {
        memberAccount: s.memberAccountIri || s.memberAccountIris?.[0],
      }));
      const closure = add(defaultRecord(TYPES.PortfolioAccountMembershipClosure, 'membership-closure/1', t, {
        closedMembership: [membership.versionIri], membershipCount: 1, membershipVersionSetDigest: iriSetDigest([membership.versionIri]),
      }));
      const header = add(defaultRecord(TYPES.PortfolioValuation, 'portfolio-valuation/1', t, {
        memberAccountClosure: closure.versionIri, reportingCurrency: refLogical(`currency/${s.reportingCurrency}`),
        valuationDefinition: definition.versionIri,
      }));
      const overrides = { marketValue: money(s.marketValueMicros, s.reportingCurrency), valuationHeader: header.versionIri, valuationPrice: price.versionIri, valuedPositionSnapshot: snapshot.versionIri };
      if (s.fx) {
        const rate = add(defaultRecord(TYPES.FXRateObservation, 'valuation-fx-rate/1', s.fx.rateTemporal || t, {
          baseCurrency: refLogical(`currency/${s.fx.baseCurrency}`),
          fxRate: quantity(
            s.fx.ratePpm,
            `${s.fx.quoteCurrency}-per-${s.fx.baseCurrency}`,
          ),
          quoteCurrency: refLogical(`currency/${s.fx.quoteCurrency}`),
        }));
        const inputContext = fxInputContext(s.fx);
        addArtifact(inputContext.artifact);
        const preFxRaw = safeNumber(
          directUnitValueRaw(
            s.quantityMicros,
            s.priceMicros,
            policies.precision.payload,
            policies.rounding.payload,
          ),
          'pre-FX valuation amount',
        );
        const fx = add(defaultRecord(TYPES.FXConversion, 'valuation-fx/1', t, {
          conversionRate: rate.versionIri,
          conversionValuationLine: refVersion('valuation/1'),
          fxConversionDirection: codeFromLegacy(`${PORTFOLIO}FXConversionDirection`, s.fx.direction),
          inputContextRecordDigest: inputContext.digest,
          inputContextRef: inputContext.ref,
          inputMoney: money(s.fx.inputMicros ?? preFxRaw, s.fx.inputCurrency),
          outputMoney: money(s.fx.outputMicros ?? s.marketValueMicros, s.fx.outputCurrency),
          roundingPolicyDigest: policies.rounding.digest,
          roundingPolicyRef: policies.rounding.ref,
        }));
        overrides.valuationFxConversion = fx.versionIri;
      }
      focus = add(defaultRecord(typeIri, 'valuation/1', t, overrides));
      break;
    }
    case 'FXConversionContract': {
      const policies = valuationPolicies(s);
      const inputContext = fxInputContext(s);
      addArtifact(policies.rounding.artifact);
      addArtifact(inputContext.artifact);
      const rate = add(defaultRecord(TYPES.FXRateObservation, 'fx-rate/1', s.rateTemporal || t, {
        baseCurrency: refLogical(`currency/${s.baseCurrency}`),
        fxRate: quantity(s.ratePpm, `${s.quoteCurrency}-per-${s.baseCurrency}`),
        quoteCurrency: refLogical(`currency/${s.quoteCurrency}`),
      }));
      add(defaultRecord(TYPES.PositionValuation, 'valuation/1', t, {
        valuationFxConversion: refVersion('fx-conversion/1'),
      }));
      focus = add(defaultRecord(typeIri, 'fx-conversion/1', t, {
        conversionRate: rate.versionIri, fxConversionDirection: codeFromLegacy(`${PORTFOLIO}FXConversionDirection`, s.direction),
        inputContextRecordDigest: inputContext.digest, inputContextRef: inputContext.ref,
        inputMoney: money(s.inputMicros, s.direction === 'baseToQuote' ? s.baseCurrency : s.quoteCurrency),
        outputMoney: money(s.outputMicros, s.direction === 'baseToQuote' ? s.quoteCurrency : s.baseCurrency),
        roundingPolicyDigest: policies.rounding.digest, roundingPolicyRef: policies.rounding.ref,
      }));
      delete focus.conversionValuationLine;
      const consumerKey = ['conversionValuationLine', 'conversionOpeningLot', 'conversionFeeAllocation'][0];
      focus[consumerKey] = s.consumers[0];
      break;
    }
    case 'PositionLotAllocationContract': {
      const allocationAccount = s.accountIri || refLogical('account/1');
      const allocationInstrument = s.instrumentIri || refLogical('instrument/1');
      const allocationUnit = s.quantityUnit || 'share';
      const allocationCurrency = s.currency || 'USD';
      const listing = add(defaultRecord(TYPES.InstrumentListing, 'allocation-listing/1', t, {
        listedInstrument: `${allocationInstrument}/version/0`,
        listingQuoteCurrency: refLogical(`currency/${allocationCurrency}`),
      }));
      const quote = add(defaultRecord(
        TYPES.DirectUnitPriceQuotationContract,
        'allocation-quotation/1',
        t,
        {
          quotationDenominatorUnit: quantityUnitIri(allocationUnit),
          quotationInstrument: allocationInstrument,
          quotationListingContext: listing.versionIri,
          quotationQuoteCurrency: refLogical(`currency/${allocationCurrency}`),
        },
      ));
      add(defaultRecord(TYPES.CostBasisCalculationDefinition, 'allocation-cost-definition/1', t, {
        costBasisDefinitionQuotationContract: quote.versionIri,
        versionIri: s.definitionVersionIri,
      }));
      const executionSide = s.executionSide || (
        s.kind === 'opening'
          ? (s.originalQuantityMicros < 0 ? 'Sell' : 'Buy')
          : (s.originalQuantityMicros < 0 ? 'Buy' : 'Sell')
      );
      add(defaultRecord(TYPES.Execution, 'execution/1', s.executionTemporal || t, {
        executionAccount: allocationAccount,
        executionInstrument: allocationInstrument,
        executionListing: listing.versionIri,
        executionQuantity: quantity(s.executionQuantityMicros || s.quantityMicros, allocationUnit),
        executionQuotationContract: quote.versionIri,
        orderSide: codeFromLegacy(`${ORDERS}OrderSide`, executionSide),
        versionIri: s.execution.versionIri,
      }));
      add(defaultRecord(TYPES.PositionLot, 'lot/1', s.lotTemporal || t, {
        calculationContextRef: s.lotCalculationContextRef,
        costBasisDefinition: s.lotDefinitionVersionIri,
        lotAtListing: listing.versionIri,
        lotForInstrument: allocationInstrument,
        lotInAccount: allocationAccount,
        lotQuotationContract: quote.versionIri,
        openingExecution: s.openingExecutionVersionIri,
        originalQuantity: quantity(s.originalQuantityMicros, allocationUnit),
        versionIri: s.lot.versionIri,
      }));
      focus = add(defaultRecord(typeIri, 'allocation/1', t, {
        allocatedLot: s.lot.versionIri,
        allocatedQuantity: quantity(s.quantityMicros, allocationUnit),
        allocationCostBasisDefinition: s.definitionVersionIri,
        allocationExecution: s.execution.versionIri, calculationContextRef: s.calculationContextRef,
        generatingContextRef: s.generatingContextRef || refVersion('run/allocation/1'),
        lotAllocationKind: codeFromLegacy(`${PORTFOLIO}PositionLotAllocationKind`, s.kind),
      }));
      break;
    }
    case 'PositionLotFeeAllocationContract': {
      const basisCurrency = s.basisCurrency || s.currency;
      const feeAmountMicros = s.feeAmountMicros ?? s.amountMicros;
      const policies = costBasisPolicies(s.costBasisDefinition || {});
      addArtifact(policies.precision.artifact);
      addArtifact(policies.rounding.artifact);
      const definition = add(defaultRecord(
        TYPES.CostBasisCalculationDefinition,
        'fee-cost-definition/1',
        t,
        {
          costBasisDefinitionBasisCurrency: refLogical(`currency/${basisCurrency}`),
          precisionPolicyDigest: policies.precision.digest,
          precisionPolicyRef: policies.precision.ref,
          roundingPolicyDigest: policies.rounding.digest,
          roundingPolicyRef: policies.rounding.ref,
          versionIri: s.definitionVersionIri,
        },
      ));
      const execution = add(defaultRecord(TYPES.Execution, 'execution/1', t));
      const fee = add(defaultRecord(TYPES.Fee, 'fee/1', t, {
        feeAmount: money(feeAmountMicros, s.feeCurrency),
        feeExecution: execution.versionIri,
      }));
      const lot = add(defaultRecord(TYPES.PositionLot, 'fee-lot/1', t, {
        costBasisDefinition: definition.versionIri,
        openingExecution: execution.versionIri,
      }));
      const allocation = add(defaultRecord(TYPES.PositionLotAllocation, 'allocation/1', t, {
        allocatedLot: lot.versionIri,
        allocationCostBasisDefinition: s.lotAllocationDefinitionVersionIri,
        allocationExecution: execution.versionIri,
        calculationContextRef: s.lotAllocationContextRef,
        versionIri: s.lotAllocationVersionIri,
      }));
      focus = add(defaultRecord(typeIri, 'fee-allocation/1', t, {
        allocatedFee: fee.versionIri, allocatedFeeAmount: money(s.amountMicros, s.currency),
        calculationContextRef: s.calculationContextRef, feeCostBasisDefinition: s.definitionVersionIri,
        feeLotAllocation: s.lotAllocationVersionIri,
        generatingContextRef: s.generatingContextRef || refVersion('run/fee-allocation/1'),
      }));
      if (s.fx) {
        const rate = add(defaultRecord(
          TYPES.FXRateObservation,
          'fee-allocation-fx-rate/1',
          s.fx.rateTemporal || t,
          {
            baseCurrency: refLogical(`currency/${s.fx.baseCurrency}`),
            fxRate: quantity(
              s.fx.ratePpm,
              `${s.fx.quoteCurrency}-per-${s.fx.baseCurrency}`,
            ),
            quoteCurrency: refLogical(`currency/${s.fx.quoteCurrency}`),
          },
        ));
        const inputContext = fxInputContext(s.fx);
        addArtifact(inputContext.artifact);
        const outputMicros = s.fx.outputMicros ?? safeNumber(
          fxValueRaw(
            feeAmountMicros,
            s.fx.ratePpm,
            s.fx.direction,
            policies.precision.payload,
            policies.rounding.payload,
          ),
          'fee allocation FX output',
        );
        const fx = add(defaultRecord(TYPES.FXConversion, 'fee-allocation-fx/1', t, {
          conversionFeeAllocation: focus.versionIri,
          conversionRate: rate.versionIri,
          fxConversionDirection: codeFromLegacy(
            `${PORTFOLIO}FXConversionDirection`,
            s.fx.direction,
          ),
          inputContextRecordDigest: inputContext.digest,
          inputContextRef: inputContext.ref,
          inputMoney: money(
            s.fx.inputMicros ?? feeAmountMicros,
            s.fx.inputCurrency || s.feeCurrency,
          ),
          outputMoney: money(outputMicros, s.fx.outputCurrency || s.currency),
          roundingPolicyDigest: policies.rounding.digest,
          roundingPolicyRef: policies.rounding.ref,
        }));
        focus.feeFxConversion = fx.versionIri;
      }
      const closureAllocationVersionIris = [...(s.closureAllocationVersionIris
        || [allocation.versionIri])].sort(compareUtf8);
      add(defaultRecord(TYPES.ExecutionLotAllocationClosure, 'fee-allocation-closure/1', t, {
        allocationCount: closureAllocationVersionIris.length,
        allocationVersionSetDigest: iriSetDigest(closureAllocationVersionIris),
        closureAllocation: closureAllocationVersionIris,
        closureCostBasisDefinition: definition.versionIri,
        closureExecution: execution.versionIri,
        closureFee: [fee.versionIri],
        closureFeeAllocation: [focus.versionIri],
        feeAllocationCount: 1,
        feeAllocationVersionSetDigest: iriSetDigest([focus.versionIri]),
        feeCount: 1,
        feeVersionSetDigest: iriSetDigest([fee.versionIri]),
      }));
      break;
    }
    case 'ExecutionLotAllocationClosureContract': {
      const definitionInput = s.definition || {};
      const definitionVersionIri = definitionInput.versionIri
        || s.definitionVersionIri
        || refVersion('cost-definition/1');
      const executionInput = s.execution || {};
      const executionVersionIri = executionInput.versionIri
        || s.executionVersionIri
        || refVersion('execution/1');
      const calculationContextRef = s.calculationContextRef
        || 'https://axiolune.ai/context/calculation/1';
      const executionAccount = executionInput.accountIri || refLogical('account/1');
      const executionInstrument = executionInput.instrumentIri || refLogical('instrument/1');
      const executionUnit = executionInput.unit || s.quantityUnit || 'share';
      const executionSide = executionInput.side || s.executionSide || 'Sell';
      const listing = add(defaultRecord(
        TYPES.InstrumentListing,
        'execution-closure-listing/1',
        t,
        {
          listedInstrument: `${executionInstrument}/version/0`,
          listingQuoteCurrency: refLogical(`currency/${definitionInput.basisCurrency || 'USD'}`),
          versionIri: executionInput.listingVersionIri || refVersion('listing/1'),
        },
      ));
      const quotation = add(defaultRecord(
        TYPES.DirectUnitPriceQuotationContract,
        'execution-closure-quotation/1',
        t,
        {
          quotationDenominatorUnit: quantityUnitIri(executionUnit),
          quotationInstrument: executionInstrument,
          quotationListingContext: listing.versionIri,
          quotationQuoteCurrency: refLogical(`currency/${definitionInput.basisCurrency || 'USD'}`),
          versionIri: definitionInput.quotationVersionIri || refVersion('quotation/1'),
        },
      ));
      const policies = costBasisPolicies(definitionInput);
      const executable = {
        implementation: namedLockedArtifact(
          definitionInput,
          'implementationArtifact',
          'implementationDigest',
          'https://axiolune.ai/artifacts/execution-closure/cost-basis/implementation',
          'cost-implementation',
        ),
        input: namedLockedArtifact(
          definitionInput,
          'inputContractArtifact',
          'inputContractDigest',
          'https://axiolune.ai/artifacts/execution-closure/cost-basis/input',
          'cost-input',
        ),
        output: namedLockedArtifact(
          definitionInput,
          'outputContractArtifact',
          'outputContractDigest',
          'https://axiolune.ai/artifacts/execution-closure/cost-basis/output',
          'cost-output',
        ),
        runtime: namedLockedArtifact(
          definitionInput,
          'runtimeArtifact',
          'runtimeDigest',
          'https://axiolune.ai/artifacts/execution-closure/cost-basis/runtime',
          'cost-runtime',
        ),
        toolLock: namedLockedArtifact(
          definitionInput,
          'toolLockArtifact',
          'toolLockDigest',
          definitionInput.toolLockRef
            || 'https://axiolune.ai/artifacts/execution-closure/cost-basis/tool-lock',
          'cost-tool-lock',
        ),
      };
      for (const row of [
        policies.precision,
        policies.rounding,
        executable.implementation,
        executable.input,
        executable.output,
        executable.runtime,
        executable.toolLock,
      ]) addArtifact(row.artifact);
      const definition = add(defaultRecord(
        TYPES.CostBasisCalculationDefinition,
        'cost-definition/1',
        t,
        {
          costBasisDefinitionBasisCurrency: refLogical(
            `currency/${definitionInput.basisCurrency || 'USD'}`,
          ),
          costBasisDefinitionQuotationContract: quotation.versionIri,
          feeTreatment: codeFromLegacy(
            `${PORTFOLIO}FeeTreatment`,
            definitionInput.feeTreatment || 'included',
          ),
          implementationDigest: executable.implementation.digest,
          inputContractDigest: executable.input.digest,
          lotConsumptionPolicy: codeFromLegacy(
            `${PORTFOLIO}LotConsumptionPolicy`,
            definitionInput.lotConsumptionPolicy || 'fifo',
          ),
          outputContractDigest: executable.output.digest,
          precisionPolicyDigest: policies.precision.digest,
          precisionPolicyRef: policies.precision.ref,
          roundingPolicyDigest: policies.rounding.digest,
          roundingPolicyRef: policies.rounding.ref,
          runtimeDigest: executable.runtime.digest,
          toolLockDigest: executable.toolLock.digest,
          toolLockRef: executable.toolLock.ref,
          versionIri: definitionVersionIri,
        },
      ));
      const execution = add(defaultRecord(
        TYPES.Execution,
        'execution/1',
        t,
        {
          executionAccount,
          executionInstrument,
          executionListing: listing.versionIri,
          executionPrice: money(
            executionInput.priceMicros || 1_000_000,
            definitionInput.basisCurrency || 'USD',
          ),
          executionQuantity: quantity(s.executionQuantityMicros, executionUnit),
          executionQuotationContract: quotation.versionIri,
          orderSide: codeFromLegacy(`${ORDERS}OrderSide`, executionSide),
          versionIri: executionVersionIri,
        },
      ));
      const lotInputs = s.lots || (s.eligibleLotVersionIris || []).map(
        (versionIri, index) => ({
          originalQuantityMicros: s.allocationQuantityMicros?.[index]
            || s.executionQuantityMicros,
          temporal: {
            availableFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:02Z`,
            knowledgeFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:01Z`,
            revision: 0,
            validFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
          },
          versionIri,
        }),
      );
      const lots = lotInputs.map((descriptor, index) => {
        const lotTemporal = descriptor.temporal || {
          availableFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:02Z`,
          knowledgeFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:01Z`,
          revision: 0,
          validFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        };
        const originalQuantityMicros = descriptor.originalQuantityMicros;
        const openingExecution = add(defaultRecord(
          TYPES.Execution,
          `execution/opening-${index + 1}`,
          lotTemporal,
          {
            executionAccount,
            executionInstrument,
            executionListing: listing.versionIri,
            executionQuantity: quantity(Math.abs(originalQuantityMicros), executionUnit),
            executionQuotationContract: quotation.versionIri,
            orderSide: codeFromLegacy(
              `${ORDERS}OrderSide`,
              originalQuantityMicros > 0 ? 'Buy' : 'Sell',
            ),
            versionIri: descriptor.openingExecutionVersionIri
              || refVersion(`execution/opening-${index + 1}`),
          },
        ));
        return add(defaultRecord(
          TYPES.PositionLot,
          `lot/closure-${index + 1}`,
          lotTemporal,
          {
            calculationContextRef,
            costBasisDefinition: definition.versionIri,
            lotAtListing: listing.versionIri,
            lotForInstrument: executionInstrument,
            lotInAccount: executionAccount,
            lotQuotationContract: quotation.versionIri,
            openingCostBasis: money(
              descriptor.openingCostBasisMicros
                ?? Math.abs(originalQuantityMicros),
              definitionInput.basisCurrency || 'USD',
            ),
            openingExecution: openingExecution.versionIri,
            openingGross: money(
              descriptor.openingGrossMicros
                ?? Math.abs(originalQuantityMicros),
              definitionInput.basisCurrency || 'USD',
            ),
            originalQuantity: quantity(originalQuantityMicros, executionUnit),
            versionIri: descriptor.versionIri,
          },
        ));
      });
      const allocationInputs = s.allocations || (s.allocationVersionIris || []).map(
        (versionIri, index) => ({
          lotVersionIri: lots[index]?.versionIri,
          quantityMicros: s.allocationQuantityMicros[index],
          versionIri,
        }),
      );
      const allocations = allocationInputs.map((descriptor, index) => add(defaultRecord(
        TYPES.PositionLotAllocation,
        `allocation/closure-${index + 1}`,
        t,
        {
          allocatedLot: descriptor.lotVersionIri,
          allocatedQuantity: quantity(descriptor.quantityMicros, executionUnit),
          allocationCostBasisDefinition: definition.versionIri,
          allocationExecution: execution.versionIri,
          calculationContextRef,
          lotAllocationKind: codeFromLegacy(
            `${PORTFOLIO}PositionLotAllocationKind`,
            descriptor.kind || 'consumption',
          ),
          versionIri: descriptor.versionIri,
        },
      )));
      const feeInputs = s.fees || [];
      const fees = feeInputs.map((descriptor, index) => add(defaultRecord(
        TYPES.Fee,
        `fee/closure-${index + 1}`,
        t,
        {
          feeAmount: money(
            descriptor.amountMicros,
            descriptor.currency || definitionInput.basisCurrency || 'USD',
          ),
          feeExecution: execution.versionIri,
          versionIri: descriptor.versionIri,
        },
      )));
      const feeAllocationInputs = s.feeAllocations || [];
      const feeAllocations = feeAllocationInputs.map((descriptor, index) => add(defaultRecord(
        TYPES.PositionLotFeeAllocation,
        `fee-allocation/closure-${index + 1}`,
        t,
        {
          allocatedFee: descriptor.feeVersionIri,
          allocatedFeeAmount: money(
            descriptor.amountMicros,
            descriptor.currency || definitionInput.basisCurrency || 'USD',
          ),
          calculationContextRef,
          feeCostBasisDefinition: definition.versionIri,
          feeLotAllocation: descriptor.lotAllocationVersionIri,
          versionIri: descriptor.versionIri,
        },
      )));
      const eligibleLotVersionIris = [...(
        s.eligibleLotVersionIris || lots.map((row) => row.versionIri)
      )].sort(compareUtf8);
      const allocationVersionIris = [...(
        s.allocationVersionIris || allocations.map((row) => row.versionIri)
      )].sort(compareUtf8);
      const feeVersionIris = [...(
        s.feeVersionIris || fees.map((row) => row.versionIri)
      )].sort(compareUtf8);
      const feeAllocationVersionIris = [...(
        s.feeAllocationVersionIris || feeAllocations.map((row) => row.versionIri)
      )].sort(compareUtf8);
      const selectedLotVersionIris = [...(s.selectedLotVersionIris || [])].sort(compareUtf8);
      const inputContext = lockedArtifact(
        s.inputContext,
        'https://axiolune.ai/contexts/execution-allocation-closure/input',
        {
          completedAt: '2025-01-01T00:00:00Z',
          contextId: 'execution-allocation-closure-input',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const pitRequest = lockedArtifact(
        s.pitRequest,
        'https://axiolune.ai/pit/execution-allocation-closure',
        {
          availableAt: '2025-01-01T00:00:01Z',
          completedAt: '2025-01-01T00:00:01Z',
          knowledgeAt: '2025-01-01T00:00:01Z',
          requestId: 'execution-allocation-closure',
          schemaVersion: '1.0',
          status: 'passed',
          validAt: '2025-01-01T00:00:00Z',
        },
      );
      addArtifact(inputContext.artifact);
      addArtifact(pitRequest.artifact);
      addVerifierOwnedPitIngress(pitRequest, eligibleLotVersionIris);
      const closureVersionIri = s.versionIri || refVersion('execution-closure/1');
      const commonProbe = {
        closureDefinitionVersionIri: definition.versionIri,
        closureExecutionVersionIri: execution.versionIri,
        closureVersionIri,
        completedAt: s.probeCompletedAt || '2025-01-01T00:00:01Z',
        inputContextDigest: inputContext.digest,
        inputContextRef: inputContext.ref,
        pitRequestDigest: pitRequest.digest,
        pitRequestRef: pitRequest.ref,
        schemaVersion: '1.0',
        status: 'passed',
      };
      const selectionProbe = lockedArtifact(
        s.selectionProbe,
        'https://axiolune.ai/probes/execution-allocation-closure/selection',
        {
          ...commonProbe,
          eligibleLotVersionIris,
          eligibleLotVersionSetDigest: iriSetDigest(eligibleLotVersionIris),
          lotConsumptionPolicy: definitionInput.lotConsumptionPolicy || 'fifo',
          selectedLotVersionIris,
          selectedLotVersionSetDigest: iriSetDigest(selectedLotVersionIris),
        },
      );
      const allocationProbe = lockedArtifact(
        s.allocationProbe,
        'https://axiolune.ai/probes/execution-allocation-closure/allocation',
        {
          ...commonProbe,
          allocationVersionIris,
          allocationVersionSetDigest: iriSetDigest(allocationVersionIris),
          executionQuantityMicros: s.executionQuantityMicros,
        },
      );
      const feeProbe = lockedArtifact(
        s.feeProbe,
        'https://axiolune.ai/probes/execution-allocation-closure/fee',
        {
          ...commonProbe,
          feeAllocationVersionIris,
          feeAllocationVersionSetDigest: iriSetDigest(feeAllocationVersionIris),
          feeTreatment: definitionInput.feeTreatment || 'included',
          feeVersionIris,
          feeVersionSetDigest: iriSetDigest(feeVersionIris),
        },
      );
      for (const row of [selectionProbe, allocationProbe, feeProbe]) {
        addArtifact(row.artifact);
      }
      const closureOverrides = {
        allocationClosureProbeDigest: allocationProbe.digest,
        allocationClosureProbeRef: allocationProbe.ref,
        allocationCount: s.allocationCount ?? allocationVersionIris.length,
        allocationVersionSetDigest: s.allocationVersionSetDigest
          || iriSetDigest(allocationVersionIris),
        closureAllocation: allocationVersionIris,
        closureCostBasisDefinition: definition.versionIri,
        closureEligibleLot: eligibleLotVersionIris,
        closureExecution: execution.versionIri,
        closureFee: feeVersionIris,
        closureFeeAllocation: feeAllocationVersionIris,
        consumptionSelectionProbeDigest: selectionProbe.digest,
        consumptionSelectionProbeRef: selectionProbe.ref,
        eligibleLotCount: s.eligibleLotCount ?? eligibleLotVersionIris.length,
        eligibleLotVersionSetDigest: s.eligibleLotVersionSetDigest
          || iriSetDigest(eligibleLotVersionIris),
        feeAllocationCount: s.feeAllocationCount ?? feeAllocationVersionIris.length,
        feeAllocationVersionSetDigest: s.feeAllocationVersionSetDigest
          || iriSetDigest(feeAllocationVersionIris),
        feeClosureProbeDigest: feeProbe.digest,
        feeClosureProbeRef: feeProbe.ref,
        feeCount: s.feeCount ?? feeVersionIris.length,
        feeVersionSetDigest: s.feeVersionSetDigest || iriSetDigest(feeVersionIris),
        generatingContextRef: s.generatingContextRef
          || refVersion('run/execution-closure/1'),
        inputContextRecordDigest: inputContext.digest,
        inputContextRef: inputContext.ref,
        pitRequestRecordDigest: pitRequest.digest,
        pitRequestRef: pitRequest.ref,
        versionIri: closureVersionIri,
      };
      if ((definitionInput.lotConsumptionPolicy || 'fifo') === 'specificIdentification') {
        const specificSelection = lockedArtifact(
          s.specificSelection,
          'https://axiolune.ai/selections/execution-allocation-closure/specific',
          {
            closureDefinitionVersionIri: definition.versionIri,
            closureExecutionVersionIri: execution.versionIri,
            schemaVersion: '1.0',
            selectedLotVersionIris,
            selectedLotVersionSetDigest: iriSetDigest(selectedLotVersionIris),
            status: 'approved',
          },
        );
        addArtifact(specificSelection.artifact);
        Object.assign(closureOverrides, {
          closureSelectedLot: selectedLotVersionIris,
          specificSelectionCount: selectedLotVersionIris.length,
          specificSelectionDigest: specificSelection.digest,
          specificSelectionRef: specificSelection.ref,
          specificSelectionVersionSetDigest: iriSetDigest(selectedLotVersionIris),
        });
      }
      focus = add(defaultRecord(typeIri, 'execution-closure/1', t, closureOverrides));
      break;
    }
    case 'PositionLotStateClosureContract': {
      const definitionInput = s.costBasisDefinition || {};
      const definitionVersionIri = definitionInput.versionIri
        || refVersion('cost-definition/1');
      const basisCurrency = definitionInput.basisCurrency || s.currency || 'USD';
      const stateAccount = s.accountIri || refLogical('account/1');
      const stateInstrument = s.instrumentIri || refLogical('instrument/1');
      const stateUnit = s.quantityUnit || 'share';
      const calculationContextRef = s.calculationContextRef
        || 'https://axiolune.ai/context/calculation/1';
      const definitionDocument = encodeCanonicalOrdersPortfolioScenario(
        'CostBasisCalculationDefinitionContract',
        {
          authority: logicalRef(refLogical('authority/cost')),
          basisCurrency: logicalRef(refLogical(`currency/${basisCurrency}`)),
          currencyPolicy: 'definitionBasisCurrency',
          definitionId: 'cost-v1',
          feeTreatment: definitionInput.feeTreatment || 'included',
          fxPolicy: 'explicitDirectionCorrect',
          lotConsumptionPolicy: definitionInput.lotConsumptionPolicy || 'fifo',
          lotOpeningPolicy: 'openingRemainder',
          method: 'executionAllocatedDirectUnitCost',
          precisionPolicy: definitionInput.precisionPolicy,
          quotationContract: versionRef(refVersion('quotation/1')),
          roundingPolicy: definitionInput.roundingPolicy,
          sourceEvidence: {
            digest: sha256Jcs({ evidence: 'lot-state-cost-definition' }),
            ref: 'https://axiolune.ai/evidence/lot-state-cost-definition',
          },
          temporal: t,
          toolLockRef: 'https://axiolune.ai/artifacts/lot-state/cost-basis/tool-lock',
          versionIri: definitionVersionIri,
        },
      );
      for (const row of definitionDocument.artifacts) addArtifact(row);
      for (const row of definitionDocument.records) add(row);
      const definition = records.find((row) => row.versionIri === definitionVersionIri);
      const listing = add(defaultRecord(
        TYPES.InstrumentListing,
        'lot-state-listing/1',
        t,
        {
          listedInstrument: `${stateInstrument}/version/0`,
          listingQuoteCurrency: refLogical(`currency/${basisCurrency}`),
          versionIri: s.listingVersionIri || refVersion('listing/1'),
        },
      ));
      const quotation = add(defaultRecord(
        TYPES.DirectUnitPriceQuotationContract,
        'lot-state-quotation/1',
        t,
        {
          quotationDenominatorUnit: quantityUnitIri(stateUnit),
          quotationInstrument: stateInstrument,
          quotationListingContext: listing.versionIri,
          quotationQuoteCurrency: refLogical(`currency/${basisCurrency}`),
          versionIri: refVersion('quotation/1'),
        },
      ));
      definition.costBasisDefinitionQuotationContract = quotation.versionIri;
      const consumptionExecution = add(defaultRecord(
        TYPES.Execution,
        'execution/lot-state-consumption',
        t,
        {
          executionAccount: stateAccount,
          executionInstrument: stateInstrument,
          executionListing: listing.versionIri,
          executionQuantity: quantity(
            s.lots.reduce((sum, lot) => sum + lot.consumedQuantityMicros, 0),
            stateUnit,
          ),
          executionQuotationContract: quotation.versionIri,
          orderSide: codeFromLegacy(`${ORDERS}OrderSide`, 'Sell'),
        },
      ));
      const lots = [];
      const allocations = [];
      for (const [index, lot] of s.lots.entries()) {
        const lotTemporal = lot.temporal || {
          availableFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:02Z`,
          knowledgeFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:01Z`,
          revision: 0,
          validFrom: `2024-12-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        };
        const openingExecution = add(defaultRecord(
          TYPES.Execution,
          `execution/lot-state-opening-${index + 1}`,
          lotTemporal,
          {
            executionAccount: stateAccount,
            executionInstrument: stateInstrument,
            executionListing: listing.versionIri,
            executionQuantity: quantity(Math.abs(lot.originalQuantityMicros), stateUnit),
            executionQuotationContract: quotation.versionIri,
            orderSide: codeFromLegacy(
              `${ORDERS}OrderSide`,
              lot.originalQuantityMicros > 0 ? 'Buy' : 'Sell',
            ),
          },
        ));
        const lotRecord = add(defaultRecord(
          TYPES.PositionLot,
          `lot/state-${index + 1}`,
          lotTemporal,
          {
            calculationContextRef,
            costBasisDefinition: definition.versionIri,
            lotAtListing: listing.versionIri,
            lotForInstrument: stateInstrument,
            lotInAccount: stateAccount,
            lotQuotationContract: quotation.versionIri,
            openingCostBasis: money(lot.openingCostBasisMicros, basisCurrency),
            openingExecution: openingExecution.versionIri,
            openingGross: money(
              lot.openingGrossMicros ?? lot.openingCostBasisMicros,
              basisCurrency,
            ),
            originalQuantity: quantity(lot.originalQuantityMicros, stateUnit),
            versionIri: lot.versionIri
              || s.openLotVersionIris?.[index]
              || refVersion(`lot/state-${index + 1}`),
          },
        ));
        lots.push(lotRecord);
        if (lot.consumedQuantityMicros > 0) {
          allocations.push(add(defaultRecord(
            TYPES.PositionLotAllocation,
            `allocation/state-${index + 1}`,
            t,
            {
              allocatedLot: lotRecord.versionIri,
              allocatedQuantity: quantity(lot.consumedQuantityMicros, stateUnit),
              allocationCostBasisDefinition: definition.versionIri,
              allocationExecution: consumptionExecution.versionIri,
              calculationContextRef,
              lotAllocationKind: code(
                `${PORTFOLIO}PositionLotAllocationKind`,
                'consumption',
              ),
              versionIri: lot.allocationVersionIri
                || s.stateAllocationVersionIris?.[index]
                || refVersion(`allocation/state-${index + 1}`),
            },
          )));
        }
      }
      const openLotVersionIris = [...(
        s.openLotVersionIris
          || lots.filter((lot, index) => (
            Math.abs(s.lots[index].originalQuantityMicros)
              > s.lots[index].consumedQuantityMicros
          )).map((row) => row.versionIri)
      )].sort(compareUtf8);
      const allocationVersionIris = [...(
        s.stateAllocationVersionIris || allocations.map((row) => row.versionIri)
      )].sort(compareUtf8);
      const executionClosureVersionIri = s.stateExecutionClosureVersionIris?.[0]
        || refVersion('execution-closure/state-1');
      const supportInput = lockedArtifact(
        undefined,
        'https://axiolune.ai/contexts/lot-state/supporting-execution-closure',
        {
          completedAt: '2025-01-01T00:00:00Z',
          contextId: 'lot-state-supporting-execution-closure',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const supportPit = lockedArtifact(
        undefined,
        'https://axiolune.ai/pit/lot-state/supporting-execution-closure',
        {
          availableAt: '2025-01-01T00:00:01Z',
          completedAt: '2025-01-01T00:00:01Z',
          knowledgeAt: '2025-01-01T00:00:01Z',
          requestId: 'lot-state-supporting-execution-closure',
          schemaVersion: '1.0',
          status: 'passed',
          validAt: '2025-01-01T00:00:00Z',
        },
      );
      const supportSelection = lockedArtifact(
        undefined,
        'https://axiolune.ai/probes/lot-state/supporting-selection',
        { passed: true, schemaVersion: '1.0' },
      );
      const supportAllocation = lockedArtifact(
        undefined,
        'https://axiolune.ai/probes/lot-state/supporting-allocation',
        { passed: true, schemaVersion: '1.0' },
      );
      const supportFee = lockedArtifact(
        undefined,
        'https://axiolune.ai/probes/lot-state/supporting-fee',
        { passed: true, schemaVersion: '1.0' },
      );
      for (const row of [
        supportInput,
        supportPit,
        supportSelection,
        supportAllocation,
        supportFee,
      ]) addArtifact(row.artifact);
      const executionClosure = add(defaultRecord(
        TYPES.ExecutionLotAllocationClosure,
        'execution-closure/state-1',
        t,
        {
          allocationClosureProbeDigest: supportAllocation.digest,
          allocationClosureProbeRef: supportAllocation.ref,
          allocationCount: allocationVersionIris.length,
          allocationVersionSetDigest: iriSetDigest(allocationVersionIris),
          closureAllocation: allocationVersionIris,
          closureCostBasisDefinition: definition.versionIri,
          closureEligibleLot: lots.map((row) => row.versionIri).sort(compareUtf8),
          closureExecution: consumptionExecution.versionIri,
          consumptionSelectionProbeDigest: supportSelection.digest,
          consumptionSelectionProbeRef: supportSelection.ref,
          eligibleLotCount: lots.length,
          eligibleLotVersionSetDigest: iriSetDigest(
            lots.map((row) => row.versionIri),
          ),
          feeAllocationCount: 0,
          feeAllocationVersionSetDigest: iriSetDigest([]),
          feeClosureProbeDigest: supportFee.digest,
          feeClosureProbeRef: supportFee.ref,
          feeCount: 0,
          feeVersionSetDigest: iriSetDigest([]),
          inputContextRecordDigest: supportInput.digest,
          inputContextRef: supportInput.ref,
          pitRequestRecordDigest: supportPit.digest,
          pitRequestRef: supportPit.ref,
          versionIri: executionClosureVersionIri,
        },
      ));
      const executionClosureVersionIris = [...(
        s.stateExecutionClosureVersionIris || [executionClosure.versionIri]
      )].sort(compareUtf8);
      const snapshot = add(defaultRecord(
        TYPES.PositionSnapshot,
        'position/lot-state',
        t,
        {
          generatingContextRef: s.generatingContextRef
            || refVersion('run/lot-state/1'),
          positionAccount: stateAccount,
          positionListing: listing.versionIri,
          positionInstrument: stateInstrument,
          positionQuantity: quantity(s.remainingQuantityMicros, stateUnit),
          positionSourceKind: code(`${PORTFOLIO}PositionSourceKind`, 'executionDerived'),
          ...(s.sourceScopeRef ? { source: s.sourceScopeRef } : {}),
        },
      ));
      const inputContext = lockedArtifact(
        s.inputContext,
        'https://axiolune.ai/contexts/lot-state/input',
        {
          completedAt: '2025-01-01T00:00:00Z',
          contextId: 'lot-state-input',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const pitRequest = lockedArtifact(
        s.pitRequest,
        'https://axiolune.ai/pit/lot-state',
        {
          availableAt: '2025-01-01T00:00:01Z',
          completedAt: '2025-01-01T00:00:01Z',
          knowledgeAt: '2025-01-01T00:00:01Z',
          requestId: 'lot-state',
          schemaVersion: '1.0',
          status: 'passed',
          validAt: '2025-01-01T00:00:00Z',
        },
      );
      addArtifact(inputContext.artifact);
      addArtifact(pitRequest.artifact);
      addVerifierOwnedPitIngress(pitRequest, openLotVersionIris);
      const closureVersionIri = s.versionIri || refVersion('lot-state/1');
      const probeCommon = {
        closureVersionIri,
        completedAt: s.probeCompletedAt || '2025-01-01T00:00:01Z',
        definitionVersionIri: definition.versionIri,
        inputContextDigest: inputContext.digest,
        inputContextRef: inputContext.ref,
        pitRequestDigest: pitRequest.digest,
        pitRequestRef: pitRequest.ref,
        schemaVersion: '1.0',
        snapshotPivotRef: snapshot.versionIri,
        snapshotVersionIri: snapshot.versionIri,
        status: 'passed',
      };
      const lotProbe = lockedArtifact(
        s.lotProbe,
        'https://axiolune.ai/probes/lot-state/open-lot',
        {
          ...probeCommon,
          openLotVersionIris,
          openLotVersionSetDigest: iriSetDigest(openLotVersionIris),
          remainingCostBasisMicros: s.remainingCostBasisMicros,
          remainingQuantityMicros: s.remainingQuantityMicros,
        },
      );
      const allocationProbe = lockedArtifact(
        s.allocationProbe,
        'https://axiolune.ai/probes/lot-state/allocation',
        {
          ...probeCommon,
          allocationVersionIris,
          allocationVersionSetDigest: iriSetDigest(allocationVersionIris),
          executionClosureVersionIris,
          executionClosureVersionSetDigest: iriSetDigest(
            executionClosureVersionIris,
          ),
        },
      );
      addArtifact(lotProbe.artifact);
      addArtifact(allocationProbe.artifact);
      focus = add(defaultRecord(typeIri, 'lot-state/1', t, {
        calculationContextRef,
        closedPositionSnapshot: snapshot.versionIri,
        generatingContextRef: s.generatingContextRef || refVersion('run/lot-state/1'),
        inputContextRecordDigest: inputContext.digest,
        inputContextRef: inputContext.ref,
        lotClosureProbeDigest: lotProbe.digest,
        lotClosureProbeRef: lotProbe.ref,
        openLot: openLotVersionIris,
        openLotVersionSetDigest: s.openLotVersionSetDigest
          || iriSetDigest(openLotVersionIris),
        pitRequestRecordDigest: pitRequest.digest,
        pitRequestRef: pitRequest.ref,
        remainingCostBasis: money(s.remainingCostBasisMicros, basisCurrency),
        snapshotPivotRef: snapshot.versionIri,
        stateAccount,
        stateAllocation: allocationVersionIris,
        stateAllocationClosureProbeDigest: allocationProbe.digest,
        stateAllocationClosureProbeRef: allocationProbe.ref,
        stateAllocationVersionSetDigest: s.stateAllocationVersionSetDigest
          || iriSetDigest(allocationVersionIris),
        stateCostBasisDefinition: definition.versionIri,
        stateExecutionClosure: executionClosureVersionIris,
        stateExecutionClosureVersionSetDigest:
          s.stateExecutionClosureVersionSetDigest
          || iriSetDigest(executionClosureVersionIris),
        stateInstrument,
        stateListing: listing.versionIri,
        stateQuotationContract: quotation.versionIri,
        ...(s.sourceScopeRef ? { source: s.sourceScopeRef } : {}),
        versionIri: closureVersionIri,
      }));
      break;
    }
    case 'UnrealizedPnLObservationContract': {
      const inputTemporal = s.inputTemporal || t;
      const lotStateDocument = encodeCanonicalOrdersPortfolioScenario(
        'PositionLotStateClosureContract',
        s.lotStateDetails || {
          costBasisDefinition: {
            basisCurrency: s.remainingCostBasisCurrency,
          },
          lots: [{
            consumedQuantityMicros: 40,
            openingCostBasisMicros: 1_000,
            originalQuantityMicros: 100,
            versionIri: 'https://axiolune.ai/data/lot/open/version/0',
          }],
          openLotVersionIris: ['https://axiolune.ai/data/lot/open/version/0'],
          remainingCostBasisMicros: s.remainingCostBasisMicros,
          remainingQuantityMicros: 60,
          temporal: inputTemporal,
          versionIri: s.lotState.versionIri,
        },
      );
      for (const row of lotStateDocument.artifacts) addArtifact(row);
      for (const row of lotStateDocument.records) add(row);
      const lotState = records.find(
        (row) => row.versionIri === lotStateDocument.focusVersionIri,
      );
      const snapshot = records.find(
        (row) => row.versionIri === lotState.closedPositionSnapshot,
      );
      const definition = addValuationDefinition(
        {
          quotationContract: {
            versionIri: lotState.stateQuotationContract,
          },
          versionIri: s.valuationDefinitionVersionIri
            || refVersion('valuation-definition/pnl'),
          temporal: inputTemporal,
        },
        'pnl',
      );
      const inputContext = lockedArtifact(
        s.valuationInputContext,
        'https://axiolune.ai/contexts/pnl/valuation-input',
        {
          completedAt: '2025-01-01T00:00:00Z',
          contextId: 'pnl-valuation-input',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const conversionContext = lockedArtifact(
        s.conversionContext,
        'https://axiolune.ai/contexts/pnl/conversion',
        {
          completedAt: '2025-01-01T00:00:00Z',
          contextId: 'pnl-conversion',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const pitRequest = lockedArtifact(
        s.valuationPitRequest,
        'https://axiolune.ai/pit/pnl/valuation',
        {
          availableAt: '2025-01-01T00:00:02Z',
          completedAt: '2025-01-01T00:00:02Z',
          knowledgeAt: '2025-01-01T00:00:01Z',
          requestId: 'pnl-valuation',
          schemaVersion: '1.0',
          status: 'passed',
          validAt: '2025-01-01T00:00:00Z',
        },
      );
      addArtifact(inputContext.artifact);
      addArtifact(conversionContext.artifact);
      addArtifact(pitRequest.artifact);
      const reportingCurrency = s.currency;
      const valuationRunVersionIri = s.generatingContextRef
        || refVersion('run/pnl-valuation/1');
      const valuationHeader = add(defaultRecord(
        TYPES.PortfolioValuation,
        'portfolio-valuation/pnl',
        inputTemporal,
        {
          conversionContextDigest: conversionContext.digest,
          conversionContextRef: conversionContext.ref,
          generatingContextRef: valuationRunVersionIri,
          inputContextRecordDigest: inputContext.digest,
          inputContextRef: inputContext.ref,
          pitRequestRecordDigest: pitRequest.digest,
          pitRequestRef: pitRequest.ref,
          reportingCurrency: refLogical(`currency/${reportingCurrency}`),
          valuationDefinition: definition.versionIri,
        },
      ));
      const price = add(defaultRecord(
        TYPES.PriceObservation,
        'price/pnl',
        inputTemporal,
        {
          observedInstrument: `${lotState.stateInstrument}/version/0`,
          observedListing: lotState.stateListing,
          priceValue: money(
            s.marketValueMicros,
            s.marketValueCurrency,
          ),
          quotationContract: lotState.stateQuotationContract,
        },
      ));
      const valuation = add(defaultRecord(
        TYPES.PositionValuation,
        'valuation/1',
        inputTemporal,
        {
          marketValue: money(s.marketValueMicros, s.marketValueCurrency),
          valuationHeader: valuationHeader.versionIri,
          valuationPrice: price.versionIri,
          valuedPositionSnapshot: snapshot.versionIri,
          versionIri: s.valuation.versionIri,
        },
      ));
      const selectionBindings = [
        { factVersionIris: [lotState.stateCostBasisDefinition], role: 'costBasisDefinition' },
        {
          factVersionIris: valuation.valuationFxConversion === undefined
            ? []
            : [valuation.valuationFxConversion],
          role: 'pnlFxConversion',
        },
        { factVersionIris: [lotState.versionIri], role: 'pnlLotStateClosure' },
        { factVersionIris: [valuation.versionIri], role: 'pnlValuation' },
        { factVersionIris: [lotState.stateQuotationContract], role: 'quotationContract' },
        { factVersionIris: [lotState.closedPositionSnapshot], role: 'stateSnapshot' },
        { factVersionIris: [definition.versionIri], role: 'valuationDefinition' },
        { factVersionIris: [valuationHeader.versionIri], role: 'valuationHeader' },
        { factVersionIris: [price.versionIri], role: 'valuationPrice' },
        {
          factVersionIris: structuredClone(
            definition.valuationDefinitionQuotationContract || [],
          ),
          role: 'valuationQuotationContract',
        },
      ].filter((row) => row.factVersionIris.length > 0)
        .sort((left, right) => compareUtf8(left.role, right.role));
      const selectedFactVersionIris = [...new Set(selectionBindings.flatMap(
        (row) => row.factVersionIris,
      ))].sort(compareUtf8);
      const selectedRecords = selectedFactVersionIris.map((versionIri) => {
        const record = records.find((candidate) => candidate.versionIri === versionIri);
        if (!record) fail('orders-portfolio-pit-producer-selection', versionIri);
        return record;
      });
      const ingress = addProducedMaterializedFactPitIngress(
        pitRequest,
        selectionBindings,
        selectedRecords,
        {
          outputFactTypeIri: typeIri,
          outputFactVersionIri: s.versionIri || refVersion('pnl/1'),
          source: 'https://axiolune.ai/sources/orders-portfolio-custom/pnl/1',
          temporal: t,
        },
      );
      focus = add(ingress.outputRecord);
      if (s.unrealizedPnlMicros !== undefined) {
        const requestedPnl = money(s.unrealizedPnlMicros, s.currency);
        if (canonicalJcs(requestedPnl) !== canonicalJcs(focus.unrealizedPnl)) {
          focus.unrealizedPnl = requestedPnl;
        }
      }
      break;
    }
    case 'ExternalCostBasisObservationContract': {
      const costBasisDefinitionVersionIri =
        s.costBasisDefinitionVersionIri
        || refVersion('cost-definition/external-basis');
      ensureCostBasisDefinitionRecord(
        costBasisDefinitionVersionIri,
        s.currency || 'USD',
        'external-basis',
      );
      const listingVersionIri = s.listingVersionIri === null
        ? null
        : (s.listingVersionIri || refVersion('listing/external-basis'));
      if (listingVersionIri) {
        add(defaultRecord(
          TYPES.InstrumentListing,
          'listing/external-basis',
          s.listingTemporal || t,
          {
            listedInstrument: s.listingInstrumentVersionIri
              || `${instrument}/version/0`,
            listingQuoteCurrency: refLogical(
              `currency/${s.currency || 'USD'}`,
            ),
            versionIri: listingVersionIri,
          },
        ));
      }
      focus = add(defaultRecord(typeIri, 'external-basis/1', t, {
        externalBasisAccount: account,
        externalBasisDefinition: costBasisDefinitionVersionIri,
        externalBasisId: s.externalBasisId,
        externalBasisInstrument: instrument,
        externalBasisObservationStream: s.observationStream?.logicalIri
          || refLogical('portfolio-observation-stream/1'),
        generatingContextRef: s.generatingContextRef
          || refVersion('run/external-basis/1'),
        ...(listingVersionIri ? { externalBasisListing: listingVersionIri } : {}),
        externalCostBasis: money(
          s.amountMicros ?? 100,
          s.currency || 'USD',
        ),
        ...sourceFields('external-basis', s.sourceEvidence),
        ...(s.versionIri ? { versionIri: s.versionIri } : {}),
      }));
      break;
    }
    case 'PortfolioPositionReconciliationFindingContract': {
      const inputTemporal = s.inputTemporal || {
        availableFrom: '2025-01-01T00:00:01.500000000Z',
        knowledgeFrom: '2025-01-01T00:00:01Z',
        revision: 0,
        validFrom: '2025-01-01T00:00:00Z',
      };
      const externalSourceScopeRef = s.externalSourceScopeRef
        || 'https://axiolune.ai/sources/portfolio-reconciliation/external';
      const derivedSourceScopeRef = s.derivedSourceScopeRef
        || 'https://axiolune.ai/sources/portfolio-reconciliation/derived';
      const externalGeneratingContextRef = s.externalGeneratingContextRef
        || refVersion('run/portfolio-reconciliation-external-source/1');
      const derivedGeneratingContextRef = s.derivedGeneratingContextRef
        || refVersion('run/portfolio-reconciliation-derived-source/1');
      const reconciliationGeneratingContextRef = s.generatingContextRef
        || refVersion('run/portfolio-reconciliation/1');
      const externalTemporal = s.externalTemporal || inputTemporal;
      const derivedTemporal = s.derivedTemporal || inputTemporal;
      const externalAccountIri = s.leftAccountIri || refLogical('account/1');
      const derivedAccountIri = s.rightAccountIri || refLogical('account/1');
      const externalInstrumentIri = s.leftInstrumentIri || refLogical('instrument/1');
      const derivedInstrumentIri = s.rightInstrumentIri || refLogical('instrument/1');
      const externalListingVersionIri = s.leftListingVersionIri
        || refVersion('listing/reconciliation');
      const derivedListingVersionIri = s.rightListingVersionIri
        || externalListingVersionIri;
      const ensureListing = (versionIri, instrumentIri, temporalValue, suffix, currency = 'USD') => {
        const existing = records.find((row) => row.versionIri === versionIri);
        if (existing) return existing;
        return add(defaultRecord(
          TYPES.InstrumentListing,
          `listing/reconciliation-${suffix}`,
          temporalValue,
          {
            listedInstrument: `${instrumentIri}/version/0`,
            listingQuoteCurrency: refLogical(`currency/${currency}`),
            versionIri,
          },
        ));
      };
      const overrides = {};
      let externalHolding = null;
      let externalPosition = null;
      let derivedSnapshot = null;
      let externalBasis = null;
      let lotState = null;

      if (s.externalSnapshot) {
        const listing = ensureListing(
          externalListingVersionIri,
          externalInstrumentIri,
          externalTemporal,
          'external-holding',
        );
        externalHolding = add(defaultRecord(
          TYPES.HoldingSnapshot,
          'holding/external',
          externalTemporal,
          {
            generatingContextRef: externalGeneratingContextRef,
            holdingAccount: externalAccountIri,
            holdingInstrument: externalInstrumentIri,
            holdingListing: listing.versionIri,
            holdingObservationStream: refVersion(
              'portfolio-observation-stream/reconciliation-external',
            ),
            holdingQuantity: quantity(
              s.leftValueMicros,
              s.leftUnit || 'share',
            ),
            positionSourceKind: code(
              `${PORTFOLIO}PositionSourceKind`,
              'externalReported',
            ),
            source: externalSourceScopeRef,
            versionIri: s.externalSnapshot.versionIri,
          },
        ));
        overrides.comparedExternalSnapshot = externalHolding.versionIri;
      }
      if (s.externalPositionSnapshot) {
        const listing = ensureListing(
          externalListingVersionIri,
          externalInstrumentIri,
          externalTemporal,
          'external-position',
        );
        externalPosition = add(defaultRecord(
          TYPES.PositionSnapshot,
          'position/external',
          externalTemporal,
          {
            generatingContextRef: externalGeneratingContextRef,
            positionAccount: externalAccountIri,
            positionInstrument: externalInstrumentIri,
            positionListing: listing.versionIri,
            positionObservationStream: refLogical(
              'portfolio-observation-stream/reconciliation-external',
            ),
            positionQuantity: quantity(
              s.leftValueMicros,
              s.leftUnit || 'share',
            ),
            positionSourceKind: code(
              `${PORTFOLIO}PositionSourceKind`,
              'externalReported',
            ),
            source: externalSourceScopeRef,
            versionIri: s.externalPositionSnapshot.versionIri,
          },
        ));
        overrides.comparedExternalPositionSnapshot = externalPosition.versionIri;
      }
      if (s.derivedSnapshot) {
        const listing = ensureListing(
          derivedListingVersionIri,
          derivedInstrumentIri,
          derivedTemporal,
          'derived-position',
        );
        derivedSnapshot = add(defaultRecord(
          TYPES.PositionSnapshot,
          'position/derived',
          derivedTemporal,
          {
            generatingContextRef: derivedGeneratingContextRef,
            positionAccount: derivedAccountIri,
            positionInstrument: derivedInstrumentIri,
            positionListing: listing.versionIri,
            positionObservationStream: refLogical(
              'portfolio-observation-stream/reconciliation-derived',
            ),
            positionQuantity: quantity(
              s.rightValueMicros,
              s.rightUnit || 'share',
            ),
            positionSourceKind: code(
              `${PORTFOLIO}PositionSourceKind`,
              'executionDerived',
            ),
            source: derivedSourceScopeRef,
            versionIri: s.derivedSnapshot.versionIri,
          },
        ));
        overrides.comparedDerivedSnapshot = derivedSnapshot.versionIri;
      }
      if (s.lotState) {
        const stateDocument = encodeCanonicalOrdersPortfolioScenario(
          'PositionLotStateClosureContract',
          {
            accountIri: derivedAccountIri,
            costBasisDefinition: {
              basisCurrency: s.rightCurrency || 'USD',
            },
            instrumentIri: derivedInstrumentIri,
            generatingContextRef: derivedGeneratingContextRef,
            listingVersionIri: derivedListingVersionIri,
            lots: [{
              consumedQuantityMicros: 50,
              openingCostBasisMicros: s.rightValueMicros * 2,
              originalQuantityMicros: 100,
              versionIri: refVersion('lot/reconciliation-open'),
            }],
            openLotVersionIris: [refVersion('lot/reconciliation-open')],
            quantityUnit: s.rightUnit || 'share',
            remainingCostBasisMicros: s.rightValueMicros,
            remainingQuantityMicros: 50,
            sourceScopeRef: derivedSourceScopeRef,
            temporal: derivedTemporal,
            versionIri: s.lotState.versionIri,
          },
        );
        for (const row of stateDocument.artifacts) addArtifact(row);
        for (const row of stateDocument.records) {
          if (!records.some((existing) => existing.versionIri === row.versionIri)) {
            add(row);
          }
        }
        lotState = records.find(
          (row) => row.versionIri === stateDocument.focusVersionIri,
        );
        overrides.comparedLotStateClosure = lotState.versionIri;
      }
      if (s.externalBasis) {
        const currency = s.leftCurrency || 'USD';
        const externalBasisDefinitionVersionIri =
          s.externalBasisDefinitionVersionIri
          || lotState?.stateCostBasisDefinition
          || refVersion('cost-definition/reconciliation-external');
        ensureCostBasisDefinitionRecord(
          externalBasisDefinitionVersionIri,
          currency,
          'reconciliation-external',
        );
        const listing = ensureListing(
          externalListingVersionIri,
          externalInstrumentIri,
          externalTemporal,
          'external-basis',
          currency,
        );
        externalBasis = add(defaultRecord(
          TYPES.ExternalCostBasisObservation,
          'basis/external',
          externalTemporal,
          {
            externalBasisAccount: externalAccountIri,
            externalBasisDefinition: externalBasisDefinitionVersionIri,
            externalBasisId: s.externalBasisId || 'external-basis-reconciliation',
            externalBasisInstrument: externalInstrumentIri,
            externalBasisListing: listing.versionIri,
            externalBasisObservationStream: refLogical(
              'portfolio-observation-stream/reconciliation-external',
            ),
            externalCostBasis: money(s.leftValueMicros, currency),
            generatingContextRef: externalGeneratingContextRef,
            ...(s.externalBasisSourceEvidence
              ? sourceFields('external-basis-reconciliation', s.externalBasisSourceEvidence)
              : {}),
            source: externalSourceScopeRef,
            versionIri: s.externalBasis.versionIri,
          },
        ));
        overrides.comparedExternalBasis = externalBasis.versionIri;
      }

      const snapshotFamily = Boolean(
        externalHolding || externalPosition || derivedSnapshot,
      );
      const comparisonFamily = snapshotFamily ? 'quantity' : 'basis';
      const externalRecord = externalHolding || externalPosition || externalBasis;
      const derivedRecord = derivedSnapshot || lotState;
      const externalRecordType = externalHolding
        ? 'HoldingSnapshot'
        : externalPosition
          ? 'PositionSnapshot'
          : externalBasis
            ? 'ExternalCostBasisObservation'
            : null;
      const comparisonAccountIri = externalRecord
        ? externalAccountIri
        : derivedAccountIri;
      const comparisonInstrumentIri = externalRecord
        ? externalInstrumentIri
        : derivedInstrumentIri;
      const comparisonListingVersionIri = externalRecord
        ? externalListingVersionIri
        : derivedListingVersionIri;
      const comparisonUnitOrCurrency = comparisonFamily === 'quantity'
        ? quantityUnitIri(externalRecord ? (s.leftUnit || 'share') : (s.rightUnit || 'share'))
        : (externalRecord ? (s.leftCurrency || 'USD') : (s.rightCurrency || 'USD'));
      const generatingContextRef = reconciliationGeneratingContextRef;
      const findingVersionIri = s.versionIri || refVersion('reconciliation/1');
      const externalCandidateVersionIris = externalRecord
        ? [externalRecord.versionIri]
        : [];
      const derivedCandidateVersionIris = derivedRecord
        ? [derivedRecord.versionIri]
        : [];
      const externalCandidateVersionSetDigest = iriSetDigest(
        externalCandidateVersionIris,
      );
      const derivedCandidateVersionSetDigest = iriSetDigest(
        derivedCandidateVersionIris,
      );
      const externalCandidates = externalRecord ? [{
        recordType: externalRecordType,
        versionIri: externalRecord.versionIri,
      }] : [];
      const derivedCandidates = derivedRecord ? [{
        recordType: comparisonFamily === 'quantity'
          ? 'PositionSnapshot'
          : 'PositionLotStateClosure',
        versionIri: derivedRecord.versionIri,
      }] : [];
      const pitRequest = lockedArtifact(
        s.pitRequest,
        'https://axiolune.ai/pit/portfolio-reconciliation/1',
        {
          availableAt: s.pitAvailableAt
            || '2025-01-01T00:00:01.500000000Z',
          completedAt: s.pitCompletedAt
            || '2025-01-01T00:00:01.600000000Z',
          knowledgeAt: s.pitKnowledgeAt
            || '2025-01-01T00:00:01Z',
          requestId: 'portfolio-reconciliation-1',
          schemaVersion: '1.0',
          status: 'passed',
          validAt: s.pitValidAt
            || '2025-01-01T00:00:00Z',
        },
      );
      const candidateTypes = new Map([
        [TYPES.HoldingSnapshot, 'HoldingSnapshot'],
        [TYPES.PositionSnapshot, 'PositionSnapshot'],
        [TYPES.ExternalCostBasisObservation, 'ExternalCostBasisObservation'],
        [TYPES.PositionLotStateClosure, 'PositionLotStateClosure'],
      ]);
      const candidateScope = (row) => {
        if (row.typeIri === TYPES.HoldingSnapshot) {
          return {
            accountLogicalIri: row.holdingAccount,
            instrumentLogicalIri: row.holdingInstrument,
            listingVersionIri: row.holdingListing || null,
          };
        }
        if (row.typeIri === TYPES.PositionSnapshot) {
          return {
            accountLogicalIri: row.positionAccount,
            instrumentLogicalIri: row.positionInstrument,
            listingVersionIri: row.positionListing || null,
          };
        }
        if (row.typeIri === TYPES.ExternalCostBasisObservation) {
          return {
            accountLogicalIri: row.externalBasisAccount,
            instrumentLogicalIri: row.externalBasisInstrument,
            listingVersionIri: row.externalBasisListing || null,
          };
        }
        return {
          accountLogicalIri: row.stateAccount,
          instrumentLogicalIri: row.stateInstrument,
          listingVersionIri: row.stateListing || null,
        };
      };
      const candidateGraphRows = records
        .filter((row) => candidateTypes.has(row.typeIri))
        .map((row) => ({
          ...candidateScope(row),
          generatingContextRef: row.generatingContextRef,
          recordDigest: sha256Jcs(row),
          recordType: candidateTypes.get(row.typeIri),
          sourceScopeRef: row.source,
          versionIri: row.versionIri,
        }))
        .sort((left, right) => compareUtf8(
          left.versionIri,
          right.versionIri,
        ));
      const inComparisonSubject = (row) => (
        row.accountLogicalIri === comparisonAccountIri
          && row.instrumentLogicalIri === comparisonInstrumentIri
          && row.listingVersionIri
            === (comparisonListingVersionIri || null)
      );
      const externalManifestRows = candidateGraphRows
        .filter((row) => row.sourceScopeRef === externalSourceScopeRef)
        .filter(inComparisonSubject)
        .filter((row) => comparisonFamily === 'quantity'
          ? ['HoldingSnapshot', 'PositionSnapshot'].includes(row.recordType)
          : row.recordType === 'ExternalCostBasisObservation');
      const derivedManifestRows = candidateGraphRows
        .filter((row) => row.sourceScopeRef === derivedSourceScopeRef)
        .filter(inComparisonSubject)
        .filter((row) => comparisonFamily === 'quantity'
          ? row.recordType === 'PositionSnapshot'
          : row.recordType === 'PositionLotStateClosure');
      const externalManifestRecordSetDigest = sha256DomainJcs(
        'axiolune-reconciliation-record-set-v1',
        externalManifestRows,
      );
      const derivedManifestRecordSetDigest = sha256DomainJcs(
        'axiolune-reconciliation-record-set-v1',
        derivedManifestRows,
      );
      const queryDefinition = lockedArtifact(
        s.queryDefinition,
        'https://axiolune.ai/queries/portfolio-reconciliation/candidate-selection/1',
        {
          absenceSemantics:
            'missing-side-only-after-complete-source-manifest',
          algorithm: 'three-axis-pit-half-open-v1',
          candidateFamilies: {
            basis: {
              derived: ['PositionLotStateClosure'],
              external: ['ExternalCostBasisObservation'],
            },
            quantity: {
              derived: ['PositionSnapshot:executionDerived'],
              external: [
                'HoldingSnapshot:externalReported',
                'PositionSnapshot:externalReported',
              ],
            },
          },
          exactScopeFields: [
            'accountLogicalIri',
            'instrumentLogicalIri',
            'listingVersionIri',
            'sourceScopeRef',
          ],
          schemaVersion: '1.0',
          selectionCardinality: 'zero-or-one-per-side',
          validInterval: '[validFrom,validTo)',
        },
      );
      const queryToolLock = lockedArtifact(
        s.queryToolLock,
        'https://axiolune.ai/tools/portfolio-reconciliation/query-lock/1',
        {
          canonicalization: 'RFC8785-JCS',
          implementationContract:
            'orders-portfolio-reconciliation-candidate-selection-v1',
          queryDefinitionDigest: queryDefinition.digest,
          queryDefinitionRef: queryDefinition.ref,
          runtime: 'node-commonjs-restricted-worker',
          schemaVersion: '1.0',
          status: 'locked',
        },
      );
      const candidateGraph = lockedArtifact(
        s.candidateGraph,
        'https://axiolune.ai/graphs/portfolio-reconciliation/candidates/1',
        {
          graphKind: 'preReconciliationCandidateInput',
          records: candidateGraphRows,
          schemaVersion: '1.0',
          sourceScopes: [
            derivedSourceScopeRef,
            externalSourceScopeRef,
          ].sort(compareUtf8),
          status: 'sealed',
        },
      );
      const externalSourceContract = lockedArtifact(
        s.externalSourceContract,
        'https://axiolune.ai/contracts/portfolio-reconciliation/external-full-snapshot/1',
        {
          absenceInference:
            'allowedOnlyAfterTerminalCompleteResponse',
          completenessSemantics: 'fullSnapshot',
          pagination: {
            requireContiguousPageIndexes: true,
            requireTerminalPage: true,
          },
          schemaVersion: '1.0',
          sourceScopeRef: externalSourceScopeRef,
          status: 'locked',
          subjectScopeFields: [
            'accountLogicalIri',
            'comparisonFamily',
            'instrumentLogicalIri',
            'listingVersionIri',
          ],
        },
      );
      const externalSnapshotPage = lockedArtifact(
        s.externalSnapshotPage,
        'https://axiolune.ai/pages/portfolio-reconciliation/external/1/0',
        {
          nextPageToken: null,
          pageIndex: 0,
          recordCount: externalManifestRows.length,
          recordSetDigest: externalManifestRecordSetDigest,
          records: externalManifestRows,
          schemaVersion: '1.0',
          terminal: true,
        },
      );
      const externalSnapshotManifest = lockedArtifact(
        s.externalSnapshotManifest,
        'https://axiolune.ai/manifests/portfolio-reconciliation/external/1',
        {
          accountLogicalIri: comparisonAccountIri,
          comparisonFamily,
          completeResponse: true,
          completedAt: s.externalManifestCompletedAt
            || '2025-01-01T00:00:01.550000000Z',
          completenessSemantics: 'fullSnapshot',
          instrumentLogicalIri: comparisonInstrumentIri,
          listingVersionIri: comparisonListingVersionIri || null,
          pageCount: 1,
          pages: [{
            pageDigest: externalSnapshotPage.digest,
            pageIndex: 0,
            pageRef: externalSnapshotPage.ref,
            terminal: true,
          }],
          recordCount: externalManifestRows.length,
          recordSetDigest: externalManifestRecordSetDigest,
          records: externalManifestRows,
          schemaVersion: '1.0',
          sourceContractDigest: externalSourceContract.digest,
          sourceContractRef: externalSourceContract.ref,
          sourceScopeRef: externalSourceScopeRef,
          status: 'completed',
          terminalPageIndex: 0,
        },
      );
      const derivedOutputManifest = lockedArtifact(
        s.derivedOutputManifest,
        'https://axiolune.ai/manifests/portfolio-reconciliation/derived/1',
        {
          accountLogicalIri: comparisonAccountIri,
          comparisonFamily,
          completedAt: s.derivedManifestCompletedAt
            || '2025-01-01T00:00:01.575000000Z',
          generatingContextRef: derivedGeneratingContextRef,
          instrumentLogicalIri: comparisonInstrumentIri,
          listingVersionIri: comparisonListingVersionIri || null,
          recordCount: derivedManifestRows.length,
          recordSetDigest: derivedManifestRecordSetDigest,
          records: derivedManifestRows,
          schemaVersion: '1.0',
          sourceScopeRef: derivedSourceScopeRef,
          status: 'completed',
        },
      );
      const inputContext = lockedArtifact(
        s.inputContext,
        'https://axiolune.ai/contexts/portfolio-reconciliation/input/1',
        {
          accountLogicalIri: comparisonAccountIri,
          candidateGraphDigest: candidateGraph.digest,
          candidateGraphRecordCount: candidateGraphRows.length,
          candidateGraphRef: candidateGraph.ref,
          comparisonFamily,
          completedAt: s.inputContextCompletedAt
            || '2025-01-01T00:00:01.625000000Z',
          contextId: 'portfolio-reconciliation-input-1',
          derivedCandidateCount: derivedCandidateVersionIris.length,
          derivedCandidateVersionSetDigest,
          derivedCandidates,
          derivedOutputManifestDigest: derivedOutputManifest.digest,
          derivedOutputManifestRef: derivedOutputManifest.ref,
          derivedSourceScopeRef,
          externalCandidateCount: externalCandidateVersionIris.length,
          externalCandidateVersionSetDigest,
          externalCandidates,
          externalSnapshotManifestDigest: externalSnapshotManifest.digest,
          externalSnapshotManifestRef: externalSnapshotManifest.ref,
          externalSourceScopeRef,
          instrumentLogicalIri: comparisonInstrumentIri,
          listingVersionIri: comparisonListingVersionIri || null,
          queryDefinitionDigest: queryDefinition.digest,
          queryDefinitionRef: queryDefinition.ref,
          queryToolLockDigest: queryToolLock.digest,
          queryToolLockRef: queryToolLock.ref,
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const externalValueMicros = externalRecord
        ? (s.leftValueMicros ?? 100)
        : null;
      const derivedValueMicros = derivedRecord
        ? (s.rightValueMicros ?? 100)
        : null;
      const comparisonContext = lockedArtifact(
        s.reconciliationContext,
        'https://axiolune.ai/contexts/portfolio-reconciliation/comparison/1',
        {
          accountLogicalIri: comparisonAccountIri,
          candidateGraphDigest: candidateGraph.digest,
          candidateGraphRef: candidateGraph.ref,
          comparedDerivedVersionIri: derivedRecord?.versionIri || null,
          comparedExternalRecordType: externalRecordType,
          comparedExternalVersionIri: externalRecord?.versionIri || null,
          comparisonFamily,
          comparisonMode: 'exact',
          comparisonUnitOrCurrency,
          completedAt: s.contextCompletedAt
            || '2025-01-01T00:00:01.750000000Z',
          derivedCandidateCount: derivedCandidateVersionIris.length,
          derivedCandidateVersionSetDigest,
          derivedOutputManifestDigest: derivedOutputManifest.digest,
          derivedOutputManifestRef: derivedOutputManifest.ref,
          derivedSourceScopeRef,
          derivedValueMicros,
          externalCandidateCount: externalCandidateVersionIris.length,
          externalCandidateVersionSetDigest,
          externalSnapshotManifestDigest: externalSnapshotManifest.digest,
          externalSnapshotManifestRef: externalSnapshotManifest.ref,
          externalSourceScopeRef,
          externalValueMicros,
          generatingContextRef,
          inputContextDigest: inputContext.digest,
          inputContextRef: inputContext.ref,
          instrumentLogicalIri: comparisonInstrumentIri,
          listingVersionIri: comparisonListingVersionIri || null,
          pitRequestDigest: pitRequest.digest,
          pitRequestRef: pitRequest.ref,
          queryDefinitionDigest: queryDefinition.digest,
          queryDefinitionRef: queryDefinition.ref,
          queryToolLockDigest: queryToolLock.digest,
          queryToolLockRef: queryToolLock.ref,
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      const closureProbe = lockedArtifact(
        s.closureProbe,
        'https://axiolune.ai/probes/portfolio-reconciliation/closure/1',
        {
          accountLogicalIri: comparisonAccountIri,
          candidateGraphDigest: candidateGraph.digest,
          candidateGraphRecordCount: candidateGraphRows.length,
          candidateGraphRef: candidateGraph.ref,
          comparedDerivedVersionIri: derivedRecord?.versionIri || null,
          comparedExternalRecordType: externalRecordType,
          comparedExternalVersionIri: externalRecord?.versionIri || null,
          comparisonFamily,
          completedAt: s.probeCompletedAt
            || '2025-01-01T00:00:01.850000000Z',
          derivedCandidateCount: derivedCandidateVersionIris.length,
          derivedCandidateVersionSetDigest,
          derivedCandidateVersionIris,
          derivedOutputManifestDigest: derivedOutputManifest.digest,
          derivedOutputManifestRef: derivedOutputManifest.ref,
          derivedSourceScopeRef,
          externalCandidateCount: externalCandidateVersionIris.length,
          externalCandidateVersionSetDigest,
          externalCandidateVersionIris,
          externalSnapshotManifestDigest: externalSnapshotManifest.digest,
          externalSnapshotManifestRef: externalSnapshotManifest.ref,
          externalSourceScopeRef,
          findingVersionIri,
          inputContextDigest: inputContext.digest,
          inputContextRef: inputContext.ref,
          instrumentLogicalIri: comparisonInstrumentIri,
          listingVersionIri: comparisonListingVersionIri || null,
          pitRequestDigest: pitRequest.digest,
          pitRequestRef: pitRequest.ref,
          queryDefinitionDigest: queryDefinition.digest,
          queryDefinitionRef: queryDefinition.ref,
          queryToolLockDigest: queryToolLock.digest,
          queryToolLockRef: queryToolLock.ref,
          reconciliationContextDigest: comparisonContext.digest,
          reconciliationContextRef: comparisonContext.ref,
          result: 'complete',
          schemaVersion: '1.0',
          status: 'completed',
        },
      );
      for (const row of [
        candidateGraph,
        derivedOutputManifest,
        externalSnapshotManifest,
        externalSnapshotPage,
        externalSourceContract,
        inputContext,
        pitRequest,
        comparisonContext,
        closureProbe,
        queryDefinition,
        queryToolLock,
      ]) addArtifact(row.artifact);
      const subject = {
        candidateGraphDigest: candidateGraph.digest,
        comparisonFamily,
        derivedCandidateVersionSetDigest,
        derivedOutputManifestDigest: derivedOutputManifest.digest,
        derivedSourceScopeRef,
        derivedVersionIri: derivedRecord?.versionIri || null,
        externalCandidateVersionSetDigest,
        externalSnapshotManifestDigest: externalSnapshotManifest.digest,
        externalRecordType,
        externalSourceScopeRef,
        externalVersionIri: externalRecord?.versionIri || null,
        pitRequestDigest: pitRequest.digest,
        queryDefinitionDigest: queryDefinition.digest,
        queryToolLockDigest: queryToolLock.digest,
      };
      Object.assign(overrides, {
        generatingContextRef,
        inputContextRecordDigest: inputContext.digest,
        inputContextRef: inputContext.ref,
        pitRequestRecordDigest: pitRequest.digest,
        pitRequestRef: pitRequest.ref,
        portfolioReconciliationKind: codeFromLegacy(
          `${PORTFOLIO}PortfolioReconciliationKind`,
          s.kind === 'difference'
            ? (comparisonFamily === 'quantity' ? 'quantityMismatch' : 'basisMismatch')
            : s.kind,
        ),
        reconciliationClosureProbeDigest: closureProbe.digest,
        reconciliationClosureProbeRef: closureProbe.ref,
        reconciliationContextDigest: comparisonContext.digest,
        reconciliationContextRef: comparisonContext.ref,
        reconciliationCandidateGraphDigest: candidateGraph.digest,
        reconciliationCandidateGraphRecordCount:
          s.candidateGraphRecordCount ?? candidateGraphRows.length,
        reconciliationCandidateGraphRef: candidateGraph.ref,
        reconciliationDerivedCandidateCount:
          s.derivedCandidateCount ?? derivedCandidateVersionIris.length,
        reconciliationDerivedCandidateVersionSetDigest:
          s.derivedCandidateVersionSetDigest || derivedCandidateVersionSetDigest,
        reconciliationDerivedOutputManifestDigest:
          derivedOutputManifest.digest,
        reconciliationDerivedOutputManifestRef:
          derivedOutputManifest.ref,
        reconciliationDerivedSourceScopeRef: derivedSourceScopeRef,
        reconciliationExternalCandidateCount:
          s.externalCandidateCount ?? externalCandidateVersionIris.length,
        reconciliationExternalCandidateVersionSetDigest:
          s.externalCandidateVersionSetDigest || externalCandidateVersionSetDigest,
        reconciliationExternalSnapshotManifestDigest:
          externalSnapshotManifest.digest,
        reconciliationExternalSnapshotManifestRef:
          externalSnapshotManifest.ref,
        reconciliationExternalSourceScopeRef: externalSourceScopeRef,
        reconciliationQueryDefinitionDigest: queryDefinition.digest,
        reconciliationQueryDefinitionRef: queryDefinition.ref,
        reconciliationQueryToolLockDigest: queryToolLock.digest,
        reconciliationQueryToolLockRef: queryToolLock.ref,
        reconciliationSubjectDigest: s.reconciliationSubjectDigest
          || sha256DomainJcs(
            'axiolune-portfolio-reconciliation-subject-v4',
            subject,
          ),
        versionIri: findingVersionIri,
      });
      const finding = defaultRecord(
        typeIri,
        'reconciliation/1',
        t,
        overrides,
      );
      for (const role of [
        'comparedDerivedSnapshot',
        'comparedExternalBasis',
        'comparedExternalPositionSnapshot',
        'comparedExternalSnapshot',
        'comparedLotStateClosure',
      ]) {
        if (!Object.hasOwn(overrides, role)) delete finding[role];
      }
      focus = add(finding);
      break;
    }
    default:
      fail('orders-portfolio-canonical-evaluator', evaluatorId);
  }
  return canonicalDocument(focus, records, artifacts);
}

function validateArtifactRef(value, label) {
  exactKeys(value, ['iri', 'kind'], [], label);
  if (value.kind !== 'iri') fail('orders-portfolio-canonical-artifact-ref', label);
  requireIri(value.iri, `${label}.iri`);
}

function validateSourceLocator(value, label) {
  const result = validateStrictSourceLocator(value, { at: label });
  if (!result.ok) {
    fail('orders-portfolio-canonical-source-locator', result.errors.join('; '));
  }
}

function cardinalValues(record, field) {
  if (!Object.hasOwn(record, field)) return [];
  return Array.isArray(record[field]) ? record[field] : [record[field]];
}

function validateAttributeValue(value, valueType, label, allowedValues) {
  if (!valueType) return;
  if (valueType === 'string') {
    if (typeof value !== 'string') fail('orders-portfolio-canonical-attribute-type', label);
    return;
  }
  if (valueType === 'integer') {
    if (!Number.isSafeInteger(value)) fail('orders-portfolio-canonical-attribute-type', label);
    return;
  }
  if (valueType === 'boolean') {
    if (typeof value !== 'boolean') fail('orders-portfolio-canonical-attribute-type', label);
    return;
  }
  if (valueType === 'uri') {
    requireIri(value, label);
    return;
  }
  if (valueType === 'instant' || valueType === 'datetime') {
    if (instantNanoseconds(value) === null) fail('orders-portfolio-canonical-attribute-type', label);
    return;
  }
  if (valueType === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail('orders-portfolio-canonical-attribute-type', label);
    return;
  }
  if (valueType === 'duration') {
    if (typeof value !== 'string' || !/^-?P(?=\d|T\d)[0-9YMWDTHS.]+$/u.test(value)) fail('orders-portfolio-canonical-attribute-type', label);
    return;
  }
  if (valueType === 'decimal') {
    if (!((typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)))) {
      fail('orders-portfolio-canonical-attribute-type', label);
    }
    return;
  }
  if (valueType.endsWith('/MonetaryAmount')) {
    decodeMoney(value, label);
    return;
  }
  if (valueType.endsWith('/QuantityValue')) {
    decodeQuantity(value, label);
    return;
  }
  if (valueType.endsWith('/SourceLocator')) {
    validateSourceLocator(value, label);
    return;
  }
  if (IRI.test(valueType)) {
    const prefix = `${valueType}/value/`;
    if (typeof value !== 'string' || !value.startsWith(prefix) || value.length === prefix.length
        || (Array.isArray(allowedValues) && !allowedValues.includes(value))) {
      fail('orders-portfolio-canonical-code-value', label);
    }
    return;
  }
  fail('orders-portfolio-canonical-contract-value-type', `${label}:${valueType}`);
}

function validateCanonicalDocument(document, evaluatorId, inputContract, options = {}) {
  if (options.referenceRegistry !== undefined) {
    return withReferenceRegistry(
      options.referenceRegistry,
      () => validateCanonicalDocument(document, evaluatorId, inputContract),
    );
  }
  exactKeys(document, ['artifacts', 'focusVersionIri', 'records', 'schemaVersion'], [], 'scenario');
  if (document.schemaVersion !== '1.0' || !Array.isArray(document.records) || !Array.isArray(document.artifacts)) {
    fail('orders-portfolio-canonical-scenario', 'schemaVersion/records/artifacts');
  }
  if (!inputContract || inputContract.schemaVersion !== '1.0' || !Array.isArray(inputContract.recordSchemas)
      || inputContract.referenceRegistryDigest !== activeReferenceResolver.registry.registryDigest) {
    fail('orders-portfolio-canonical-contract', 'input contract is absent or malformed');
  }
  const schemas = new Map(inputContract.recordSchemas.map((row) => [row.typeIri, row]));
  const recordsByVersion = new Map();
  for (const [index, record] of document.records.entries()) {
    requireIri(record?.typeIri, `records[${index}].typeIri`);
    const schema = schemas.get(record.typeIri);
    if (!schema) fail('orders-portfolio-canonical-type', record.typeIri);
    const required = schema.fieldContracts.filter((field) => field.minCount > 0).map((field) => field.field);
    const optional = schema.fieldContracts.filter((field) => field.minCount === 0).map((field) => field.field);
    exactKeys(record, required, optional, `records[${index}]`);
    if (!exactVersion(record.versionIri)) fail('orders-portfolio-canonical-version-iri', `records[${index}].versionIri`);
    if (recordsByVersion.has(record.versionIri)) fail('orders-portfolio-canonical-duplicate-version', record.versionIri);
    recordsByVersion.set(record.versionIri, record);
    for (const field of schema.fieldContracts) {
      const values = cardinalValues(record, field.field);
      if (values.length < field.minCount || (field.maxCount !== null && values.length > field.maxCount)) {
        fail('orders-portfolio-canonical-cardinality', `${record.typeIri}.${field.field}`);
      }
      if (field.referenceMode) {
        for (const value of values) {
          requireIri(value, `${record.typeIri}.${field.field}`);
          if (field.referenceMode === 'version' && !exactVersion(value)) {
            fail('orders-portfolio-canonical-reference-mode', `${record.typeIri}.${field.field}:version`);
          }
          if (field.referenceMode === 'logical' && exactVersion(value)) {
            fail('orders-portfolio-canonical-reference-mode', `${record.typeIri}.${field.field}:logical`);
          }
        }
      }
      if (field.kind === 'attribute' || field.kind === 'm3Attribute') {
        for (const value of values) {
          validateAttributeValue(value, field.valueType, `${record.typeIri}.${field.field}`, field.allowedValues);
        }
      }
    }
    if (instantNanoseconds(record.validFrom) === null || instantNanoseconds(record.knowledgeFrom) === null
        || instantNanoseconds(record.availableFrom) === null || !Number.isSafeInteger(record.revision)
        || record.revision < 0 || !IRI.test(record.source || '')) {
      fail('orders-portfolio-canonical-m3-pattern', record.versionIri);
    }
    for (const key of Object.keys(record)) {
      if (key.endsWith('Digest')) requireDigest(record[key], `${record.versionIri}.${key}`);
      if (key === 'sourceArtifactRef') validateArtifactRef(record[key], `${record.versionIri}.${key}`);
      if (key === 'sourceLocator') validateSourceLocator(record[key], `${record.versionIri}.${key}`);
    }
    const sourceClaimPresence = sourceClaimFields(record);
    if (sourceClaimPresence.some(Boolean) && !sourceClaimPresence.every(Boolean)) {
      fail('orders-portfolio-canonical-source-evidence-pairing', record.versionIri);
    }
  }
  for (const record of recordsByVersion.values()) {
    const schema = schemas.get(record.typeIri);
    for (const field of schema.fieldContracts.filter((row) => row.expectedTargetType && row.referenceMode === 'version')) {
      for (const value of cardinalValues(record, field.field)) {
        const referenced = recordsByVersion.get(value);
        if (referenced && referenced.typeIri !== field.expectedTargetType) {
          fail('orders-portfolio-canonical-reference-type', `${record.typeIri}.${field.field}`);
        }
      }
    }
  }
  const artifactsByRef = new Map();
  const artifactsByDigest = new Map();
  let previousArtifact = null;
  for (const [index, row] of document.artifacts.entries()) {
    exactKeys(row, ['artifactDigest', 'artifactRef', 'mediaType', 'payload'], [], `artifacts[${index}]`);
    validateArtifactRef(row.artifactRef, `artifacts[${index}].artifactRef`);
    requireDigest(row.artifactDigest, `artifacts[${index}].artifactDigest`);
    if (typeof row.mediaType !== 'string'
        || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(row.mediaType)) {
      fail('orders-portfolio-canonical-artifact-media-type', row.artifactRef.iri);
    }
    if (row.artifactDigest !== sha256Jcs(row.payload)) fail('orders-portfolio-canonical-artifact-digest', row.artifactRef.iri);
    if (previousArtifact !== null && compareUtf8(previousArtifact, row.artifactRef.iri) >= 0) {
      fail('orders-portfolio-canonical-artifact-order', row.artifactRef.iri);
    }
    previousArtifact = row.artifactRef.iri;
    if (artifactsByRef.has(row.artifactRef.iri)) fail('orders-portfolio-canonical-artifact-duplicate', row.artifactRef.iri);
    artifactsByRef.set(row.artifactRef.iri, row);
    const digestRows = artifactsByDigest.get(row.artifactDigest) || [];
    digestRows.push(row);
    artifactsByDigest.set(row.artifactDigest, digestRows);
  }
  for (const record of recordsByVersion.values()) {
    validateLockedSourceEvidenceJoin(record, artifactsByRef, record.versionIri);
  }
  const focus = recordsByVersion.get(document.focusVersionIri);
  const expectedType = TARGET_TYPE_BY_EVALUATOR[evaluatorId];
  if (!focus || focus.typeIri !== expectedType) {
    fail('orders-portfolio-canonical-focus', `${evaluatorId}:${document.focusVersionIri}`);
  }
  if (expectedType === TYPES.OrderIntentLineage) {
    const lineageRecords = [...recordsByVersion.values()]
      .filter((record) => record.typeIri === TYPES.OrderIntentLineage)
      .sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
    const sourceSignature = strictCanonicalJcs({
      digest: focus.sourceArtifactDigest,
      locator: focus.sourceLocator,
      ref: focus.sourceArtifactRef,
    });
    if (lineageRecords.some((record) => strictCanonicalJcs({
      digest: record.sourceArtifactDigest,
      locator: record.sourceLocator,
      ref: record.sourceArtifactRef,
    }) !== sourceSignature)) {
      fail(
        'orders-portfolio-canonical-lineage-graph-inventory',
        'lineage records do not share one exact selected graph source artifact',
      );
    }
    const graphArtifact = artifactsByRef.get(focus.sourceArtifactRef.iri);
    if (!graphArtifact || graphArtifact.artifactDigest !== focus.sourceArtifactDigest) {
      fail(
        'orders-portfolio-canonical-lineage-graph-inventory',
        'selected graph artifact does not resolve',
      );
    }
    validateLineageGraphInventoryPayload(
      graphArtifact.payload,
      lineageRecords.map((record) => record.versionIri),
      focus.versionIri,
      'OrderIntentLineage.selectedGraphInventory',
    );
    const pitRequestArtifact = artifactsByRef.get(
      graphArtifact.payload.pitRequestRef,
    );
    if (!pitRequestArtifact
        || pitRequestArtifact.artifactDigest
          !== graphArtifact.payload.pitRequestDigest) {
      fail(
        'orders-portfolio-canonical-lineage-pit-request',
        'selected graph PIT request artifact does not resolve exactly',
      );
    }
  }
  return { artifactsByDigest, artifactsByRef, focus, recordsByVersion };
}

function versionRef(value) {
  if (!exactVersion(value)) fail('orders-portfolio-canonical-reference-mode', value);
  const marker = value.lastIndexOf('/version/');
  return { logicalIri: value.slice(0, marker), referenceMode: 'version', versionIri: value };
}

function logicalRef(value) {
  if (!IRI.test(value || '') || exactVersion(value)) fail('orders-portfolio-canonical-reference-mode', value);
  return { logicalIri: value, referenceMode: 'logical' };
}

function temporalToLegacy(record) {
  const result = {
    availableFrom: record.availableFrom, knowledgeFrom: record.knowledgeFrom,
    revision: record.revision, validFrom: record.validFrom,
  };
  if (record.validTo !== undefined) result.validTo = record.validTo;
  return result;
}

function evidenceToLegacy(record, state) {
  const sourceArtifact = state.artifactsByRef.get(record.sourceArtifactRef.iri);
  const extractorProfile = state.artifactsByRef.get(
    record.sourceLocator.extractorProfileRef.iri,
  );
  if (!sourceArtifact || !extractorProfile) {
    fail('orders-portfolio-canonical-source-artifact-join', record.versionIri);
  }
  return {
    digest: record.sourceArtifactDigest,
    extractorProfile: {
      digest: extractorProfile.artifactDigest,
      mediaType: extractorProfile.mediaType,
      payload: structuredClone(extractorProfile.payload),
      ref: extractorProfile.artifactRef.iri,
    },
    locator: structuredClone(record.sourceLocator),
    mediaType: sourceArtifact.mediaType,
    payload: structuredClone(sourceArtifact.payload),
    ref: record.sourceArtifactRef.iri,
  };
}

function oneRecord(recordsByVersion, versionIri, typeIri, label) {
  const record = recordsByVersion.get(versionIri);
  if (!record || record.typeIri !== typeIri) fail('orders-portfolio-canonical-reference', label);
  return record;
}

function decodeMarketContext(recordsByVersion, record, listingField, otcField, label) {
  const listingRef = record[listingField];
  const otcRef = record[otcField];
  if (Number(listingRef !== undefined) + Number(otcRef !== undefined) !== 1) {
    fail('orders-portfolio-canonical-market-context', label);
  }
  if (listingRef !== undefined) {
    const listing = oneRecord(recordsByVersion, listingRef, TYPES.InstrumentListing, `${label}.${listingField}`);
    return {
      kind: 'listing',
      listedInstrumentIri: versionRef(listing.listedInstrument).logicalIri,
      quoteCurrency: currencyLexical(
        listing.listingQuoteCurrency,
        `${label}.${listingField}.listingQuoteCurrency`,
      ),
      temporal: temporalToLegacy(listing),
      versionIri: listing.versionIri,
    };
  }
  const otc = oneRecord(recordsByVersion, otcRef, TYPES.OTCTradingContext, `${label}.${otcField}`);
  return {
    kind: 'otc',
    quoteCurrency: currencyLexical(
      otc.otcQuoteCurrency,
      `${label}.${otcField}.otcQuoteCurrency`,
    ),
    temporal: temporalToLegacy(otc),
    versionIri: otc.versionIri,
  };
}

function artifactPayload(state, refIri, digestValue, label) {
  const row = state.artifactsByRef.get(refIri);
  if (!row || row.artifactDigest !== digestValue) fail('orders-portfolio-canonical-artifact-reference', label);
  return structuredClone(row.payload);
}

function pitIngressVerification(state, pitRequestRef) {
  const rowsByKind = {
    EvidenceLedger: [],
    FactVersionSelectionRequest: [],
    MaterializedFactOutput: [],
    MaterializationRunCompletion: [],
    SelectedFactVersionInventory: [],
    ValidationReport: [],
  };
  for (const row of state.artifactsByRef.values()) {
    const payload = row.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || payload.pitRequestRef !== pitRequestRef
        || !Object.hasOwn(rowsByKind, payload.artifactKind)) {
      continue;
    }
    rowsByKind[payload.artifactKind].push({
      digest: row.artifactDigest,
      payload: structuredClone(payload),
      ref: row.artifactRef.iri,
    });
  }
  const result = {
    evidenceLedger: rowsByKind.EvidenceLedger,
    materializationRun: rowsByKind.MaterializationRunCompletion,
    selectedFactVersionInventory: rowsByKind.SelectedFactVersionInventory,
    validationReport: rowsByKind.ValidationReport,
  };
  if (rowsByKind.MaterializedFactOutput.length > 0) {
    result.materializedOutput = rowsByKind.MaterializedFactOutput;
  }
  if (rowsByKind.FactVersionSelectionRequest.length > 0) {
    result.selectionRequest = rowsByKind.FactVersionSelectionRequest;
  }
  return Object.values(result).every((rows) => rows.length === 0)
    ? undefined
    : result;
}

function decodedPitRequest(state, refIri, digestValue, label) {
  const result = {
    digest: digestValue,
    payload: artifactPayload(state, refIri, digestValue, label),
    ref: refIri,
  };
  const verification = pitIngressVerification(state, refIri);
  if (verification !== undefined) result.verification = verification;
  return result;
}

function artifactByDigest(state, digestValue, label) {
  const rows = state.artifactsByDigest.get(digestValue) || [];
  if (rows.length !== 1) fail('orders-portfolio-canonical-artifact-reference', label);
  return {
    digest: rows[0].artifactDigest,
    payload: structuredClone(rows[0].payload),
    ref: rows[0].artifactRef.iri,
  };
}

function decodeMembershipClosureRecord(state, record, label = 'PortfolioAccountMembershipClosure') {
  const closedMemberships = (record.closedMembership || []).map((versionIri) => oneRecord(
    state.recordsByVersion,
    versionIri,
    TYPES.PortfolioAccountMembership,
    `${label}.closedMembership`,
  ));
  const membershipRecords = [...state.recordsByVersion.values()]
    .filter((candidate) => candidate.typeIri === TYPES.PortfolioAccountMembership)
    .map((membership) => ({
      account: logicalRef(membership.memberAccount),
      membershipId: membership.membershipId,
      portfolio: logicalRef(membership.membershipPortfolio),
      temporal: temporalToLegacy(membership),
      versionIri: membership.versionIri,
    }));
  const inputContext = {
    digest: record.inputContextRecordDigest,
    payload: artifactPayload(
      state,
      record.inputContextRef,
      record.inputContextRecordDigest,
      `${label}.inputContext`,
    ),
    ref: record.inputContextRef,
  };
  const pitRequest = decodedPitRequest(
    state,
    record.pitRequestRef,
    record.pitRequestRecordDigest,
    `${label}.pitRequest`,
  );
  const closureProbe = {
    digest: record.membershipClosureProbeDigest,
    payload: artifactPayload(
      state,
      record.membershipClosureProbeRef,
      record.membershipClosureProbeDigest,
      `${label}.closureProbe`,
    ),
    ref: record.membershipClosureProbeRef,
  };
  return {
    closureProbe,
    generatingContextRef: record.generatingContextRef,
    inputContext,
    members: closedMemberships.map((membership) => membership.versionIri),
    membershipCount: record.membershipCount,
    membershipRecords,
    membershipVersionSetDigest: record.membershipVersionSetDigest,
    pitRequest,
    portfolio: logicalRef(record.closurePortfolio),
    temporal: temporalToLegacy(record),
    versionIri: record.versionIri,
  };
}

function decodeValuationDefinitionRecord(state, record, label = 'ValuationCalculationDefinition') {
  const quotationContractVersionIris = structuredClone(
    record.valuationDefinitionQuotationContract || [],
  );
  const quotationContractRecords = quotationContractVersionIris.map((versionIri) => {
    const quotationRecord = oneRecord(
      state.recordsByVersion,
      versionIri,
      TYPES.DirectUnitPriceQuotationContract,
      `${label}.quotationContract`,
    );
    return {
      temporal: temporalToLegacy(quotationRecord),
      versionIri: quotationRecord.versionIri,
    };
  });
  const formulaArtifact = artifactByDigest(
    state,
    record.formulaDigest,
    `${label}.formula`,
  );
  const inputContractArtifact = artifactByDigest(
    state,
    record.inputContractDigest,
    `${label}.inputContract`,
  );
  const outputContractArtifact = artifactByDigest(
    state,
    record.outputContractDigest,
    `${label}.outputContract`,
  );
  const runtimeArtifact = artifactByDigest(
    state,
    record.runtimeDigest,
    `${label}.runtime`,
  );
  return {
    authority: logicalRef(record.valuationDefinitionAuthority),
    definitionId: record.valuationDefinitionId,
    formulaArtifact,
    formulaDigest: record.formulaDigest,
    inputContractArtifact,
    inputContractDigest: record.inputContractDigest,
    method: decodeCode(
      record.valuationMethod,
      `${PORTFOLIO}ValuationMethod`,
      `${label}.method`,
    ),
    outputContractArtifact,
    outputContractDigest: record.outputContractDigest,
    precisionDigest: record.precisionPolicyDigest,
    precisionPolicy: {
      digest: record.precisionPolicyDigest,
      payload: artifactPayload(
        state,
        record.precisionPolicyRef,
        record.precisionPolicyDigest,
        `${label}.precisionPolicy`,
      ),
      ref: record.precisionPolicyRef,
    },
    quotationContractCount: record.valuationQuotationContractCount,
    quotationContractRecords,
    quotationContractVersionIris,
    quotationContractVersionSetDigest:
      record.valuationQuotationContractVersionSetDigest,
    roundingDigest: record.roundingPolicyDigest,
    roundingPolicy: {
      digest: record.roundingPolicyDigest,
      payload: artifactPayload(
        state,
        record.roundingPolicyRef,
        record.roundingPolicyDigest,
        `${label}.roundingPolicy`,
      ),
      ref: record.roundingPolicyRef,
    },
    runtimeArtifact,
    runtimeDigest: record.runtimeDigest,
    temporal: temporalToLegacy(record),
    toolLockArtifact: {
      digest: record.toolLockDigest,
      payload: artifactPayload(
        state,
        record.toolLockRef,
        record.toolLockDigest,
        `${label}.toolLock`,
      ),
      ref: record.toolLockRef,
    },
    toolLockDigest: record.toolLockDigest,
    versionIri: record.versionIri,
  };
}

function decodeLiquidityDeterminationRecord(state, record) {
  const byVersion = state.recordsByVersion;
  const execution = oneRecord(
    byVersion,
    record.determinedExecution,
    TYPES.Execution,
    'LiquidityRoleDetermination.determinedExecution',
  );
  const stream = oneRecord(
    byVersion,
    record.determinationStream,
    TYPES.OrderEventStream,
    'LiquidityRoleDetermination.determinationStream',
  );
  const sourceRecord = artifactPayload(
    state,
    record.sourceRecordRef,
    record.sourceRecordDigest,
    'LiquidityRoleDetermination.sourceRecord',
  );
  const sourceContractArtifact = {
    digest: stream.sourceContractDigest,
    payload: artifactPayload(
      state,
      stream.sourceContractRef,
      stream.sourceContractDigest,
      'LiquidityRoleDetermination.sourceContract',
    ),
    ref: stream.sourceContractRef,
  };
  const result = {
    capability: decodeCode(
      stream.liquidityRoleCapability,
      `${ORDERS}LiquidityRoleCapability`,
      'OrderEventStream.liquidityRoleCapability',
    ),
    execution: versionRef(record.determinedExecution),
    executionStreamVersionIri: execution.executionStream,
    generatingContextRef: record.generatingContextRef,
    outcome: decodeCode(
      record.liquidityDeterminationResult,
      `${ORDERS}LiquidityDeterminationResult`,
      'LiquidityRoleDetermination.result',
    ),
    perspective: decodeCode(
      record.liquidityPerspective,
      `${ORDERS}LiquidityPerspective`,
      'LiquidityRoleDetermination.perspective',
    ),
    sourceContractArtifact,
    sourceContractDigest: stream.sourceContractDigest,
    sourceContractRef: stream.sourceContractRef,
    sourceRecord,
    sourceRecordDigest: record.sourceRecordDigest,
    sourceRecordRef: record.sourceRecordRef,
    stream: versionRef(record.determinationStream),
    temporal: temporalToLegacy(record),
    versionIri: record.versionIri,
  };
  if (record.liquidityMapping !== undefined) {
    const mapping = oneRecord(
      byVersion,
      record.liquidityMapping,
      TYPES.LiquidityRoleMapping,
      'LiquidityRoleDetermination.liquidityMapping',
    );
    const mappingArtifact = artifactByDigest(
      state,
      mapping.mappingDigest,
      'LiquidityRoleDetermination.mappingDigest',
    );
    result.mapping = {
      entries: structuredClone(mappingArtifact.payload.entries),
      mappingArtifact,
      mappingDigest: mapping.mappingDigest,
      mappingId: mapping.liquidityMappingId,
      perspectiveInversion: mapping.perspectiveInversion,
      rawFieldLocator: mapping.rawFieldLocator,
      rawPerspective: mapping.rawPerspective,
      sourceContractArtifact,
      sourceContractDigest: mapping.sourceContractDigest,
      sourceContractRef: mapping.sourceContractRef,
      temporal: temporalToLegacy(mapping),
      versionIri: mapping.versionIri,
    };
  }
  if (record.rawFieldLocator !== undefined) result.pointer = record.rawFieldLocator;
  if (record.rawLexicalValue !== undefined) result.rawValue = record.rawLexicalValue;
  if (record.liquidityRole !== undefined) {
    const notation = decodeCode(
      record.liquidityRole,
      `${ORDERS}LiquidityRole`,
      'LiquidityRoleDetermination.role',
    );
    result.role = { maker: 'Maker', taker: 'Taker', auctionUndefined: 'Undefined' }[notation]
      || notation;
  }
  if (record.liquidityUnavailableReason !== undefined) {
    result.absenceReason = decodeCode(
      record.liquidityUnavailableReason,
      `${ORDERS}LiquidityUnavailableReason`,
      'LiquidityRoleDetermination.reason',
    );
  }
  if (record.fieldAbsenceProbeRef !== undefined && record.fieldAbsenceProbeDigest !== undefined) {
    result.absenceProbe = {
      digest: record.fieldAbsenceProbeDigest,
      payload: artifactPayload(
        state,
        record.fieldAbsenceProbeRef,
        record.fieldAbsenceProbeDigest,
        'LiquidityRoleDetermination.absenceProbe',
      ),
      ref: record.fieldAbsenceProbeRef,
    };
  }
  return result;
}

function decodeIntegrityLifecycleEvent(state, versionIri, label) {
  const record = oneRecord(
    state.recordsByVersion,
    versionIri,
    TYPES.OrderLifecycleEvent,
    label,
  );
  return {
    externalOrderVersionIri: record.externalOrder,
    kind: decodeCode(
      record.orderEventKind,
      `${ORDERS}OrderEventKind`,
      `${label}.orderEventKind`,
    ),
    lifecycleState: decodeCode(
      record.lifecycleState,
      `${ORDERS}OrderLifecycleState`,
      `${label}.lifecycleState`,
    ),
    observedAt: record.observedAt,
    orderIntentVersionIri: record.orderIntent,
    providerEventId: record.providerEventId,
    sourceArtifact: artifactPayload(
      state,
      record.sourceArtifactRef.iri,
      record.sourceArtifactDigest,
      `${label}.sourceArtifact`,
    ),
    sourceArtifactDigest: record.sourceArtifactDigest,
    sourceOrderKey: record.sourceOrderKey,
    streamVersionIri: record.eventStream,
    versionIri: record.versionIri,
  };
}

function decodeIntegrityExecution(state, versionIri, label) {
  const record = oneRecord(state.recordsByVersion, versionIri, TYPES.Execution, label);
  return {
    observedAt: record.observedAt,
    providerExecutionId: record.providerExecutionId,
    sourceOrderKey: record.sourceOrderKey,
    streamVersionIri: record.executionStream,
    versionIri: record.versionIri,
  };
}

function decodeIntegrityTransitionProfile(state, versionIri, label) {
  const record = oneRecord(
    state.recordsByVersion,
    versionIri,
    TYPES.OrderTransitionProfile,
    label,
  );
  const implementation = artifactByDigest(
    state,
    record.implementationDigest,
    `${label}.implementation`,
  );
  const inputContract = artifactByDigest(
    state,
    record.inputContractDigest,
    `${label}.inputContract`,
  );
  const outputContract = artifactByDigest(
    state,
    record.outputContractDigest,
    `${label}.outputContract`,
  );
  const runtime = artifactByDigest(state, record.runtimeDigest, `${label}.runtime`);
  const toolLockPayload = artifactPayload(
    state,
    record.toolLockRef,
    record.toolLockDigest,
    `${label}.toolLock`,
  );
  return {
    implementation,
    inputContract: inputContract.payload,
    inputContractArtifact: inputContract,
    outputContract,
    runtime,
    toolLock: {
      digest: record.toolLockDigest,
      payload: toolLockPayload,
      ref: record.toolLockRef,
    },
    versionIri: record.versionIri,
  };
}

function decodeCanonicalOrdersPortfolioScenario(document, evaluatorId, inputContract, options = {}) {
  if (options.referenceRegistry !== undefined) {
    return withReferenceRegistry(
      options.referenceRegistry,
      () => decodeCanonicalOrdersPortfolioScenario(document, evaluatorId, inputContract),
    );
  }
  const state = validateCanonicalDocument(document, evaluatorId, inputContract);
  const r = state.focus;
  const temporal = temporalToLegacy(r);
  const byVersion = state.recordsByVersion;
  switch (evaluatorId) {
    case 'OrderIntentContract': {
      const quantityValue = decodeQuantity(r.orderQuantity, 'OrderIntent.orderQuantity');
      const context = decodeMarketContext(byVersion, r, 'intentListing', 'intentOtcContext', 'OrderIntent.context');
      const result = {
        account: logicalRef(r.intentAccount), clientIntentId: r.clientIntentId, instrument: logicalRef(r.intentInstrument),
        contextKind: context.kind, contextQuoteCurrency: context.quoteCurrency,
        contextTemporal: context.temporal, contextVersionIri: context.versionIri,
        kind: decodeCode(r.orderType, `${ORDERS}OrderType`, 'OrderIntent.orderType'), quantityMicros: quantityValue.micros,
        side: decodeCode(r.orderSide, `${ORDERS}OrderSide`, 'OrderIntent.orderSide'),
        sourceEvidence: evidenceToLegacy(r, state), temporal,
        timeInForce: decodeCode(r.timeInForce, `${ORDERS}TimeInForce`, 'OrderIntent.timeInForce'),
      };
      if (context.listedInstrumentIri !== undefined) result.listedInstrumentIri = context.listedInstrumentIri;
      if (result.timeInForce === 'DAY') result.timeInForce = 'Day';
      if (r.orderValidUntil !== undefined) result.validUntil = r.orderValidUntil;
      if (r.limitPrice !== undefined) result.limitPriceMicros = decodeMoney(r.limitPrice, 'OrderIntent.limitPrice').micros;
      if (r.triggerPrice !== undefined) result.triggerPriceMicros = decodeMoney(r.triggerPrice, 'OrderIntent.triggerPrice').micros;
      if (r.triggerPriceBasis !== undefined) result.triggerPriceBasis = decodeCode(r.triggerPriceBasis, `${ORDERS}TriggerPriceBasis`, 'OrderIntent.triggerPriceBasis');
      return result;
    }
    case 'ExternalOrderContract':
      return {
        apiIdentifier: r.providerApiIdentifier, externalOrderId: r.externalOrderId,
        originatingIntent: versionRef(r.externalOrderOriginatingIntent), provider: logicalRef(r.externalOrderProvider),
        providerSchemaVersion: r.providerSchemaVersion, sourceEvidence: evidenceToLegacy(r, state), temporal,
      };
    case 'OrderEventStreamContract':
      return {
        apiIdentifier: r.providerApiIdentifier,
        externalOrder: logicalRef(r.streamExternalOrder),
        liquidityRoleCapability: decodeCode(r.liquidityRoleCapability, `${ORDERS}LiquidityRoleCapability`, 'OrderEventStream.liquidityRoleCapability'),
        lockedSourceContract: artifactPayload(state, r.sourceContractRef, r.sourceContractDigest, 'OrderEventStream.sourceContract'),
        provider: logicalRef(r.streamProvider), providerSchemaVersion: r.providerSchemaVersion,
        providerStreamId: r.providerStreamId, sourceContractDigest: r.sourceContractDigest,
        sourceEvidence: evidenceToLegacy(r, state), temporal,
      };
    case 'ExternalOrderStatusVocabularyContract':
      return {
        apiIdentifier: r.providerApiIdentifier, provider: logicalRef(r.statusVocabularyProvider), providerSchemaVersion: r.providerSchemaVersion,
        sourceEvidence: evidenceToLegacy(r, state), temporal, vocabularyId: r.statusVocabularyId,
      };
    case 'OrderTransitionProfileContract': {
      const lockedArtifacts = {
        implementation: artifactByDigest(state, r.implementationDigest, 'OrderTransitionProfile.implementation'),
        inputContract: artifactByDigest(state, r.inputContractDigest, 'OrderTransitionProfile.inputContract'),
        outputContract: artifactByDigest(state, r.outputContractDigest, 'OrderTransitionProfile.outputContract'),
        runtime: artifactByDigest(state, r.runtimeDigest, 'OrderTransitionProfile.runtime'),
        toolLock: artifactPayload(state, r.toolLockRef, r.toolLockDigest, 'OrderTransitionProfile.toolLock'),
      };
      lockedArtifacts.toolLock = {
        digest: r.toolLockDigest,
        payload: lockedArtifacts.toolLock,
        ref: r.toolLockRef,
      };
      return {
        implementationDigest: r.implementationDigest, inputContractDigest: r.inputContractDigest, outputContractDigest: r.outputContractDigest,
        lockedArtifacts, profileId: r.transitionProfileId, provider: logicalRef(r.transitionProfileProvider), runtimeDigest: r.runtimeDigest,
        temporal, toolLockDigest: r.toolLockDigest, toolLockRef: r.toolLockRef,
      };
    }
    case 'LiquidityRoleMappingContract': {
      const mappingArtifact = artifactByDigest(state, r.mappingDigest, 'LiquidityRoleMapping.mappingDigest');
      const sourceContractArtifact = {
        digest: r.sourceContractDigest,
        payload: artifactPayload(state, r.sourceContractRef, r.sourceContractDigest, 'LiquidityRoleMapping.sourceContract'),
        ref: r.sourceContractRef,
      };
      return {
        entries: structuredClone(mappingArtifact.payload.entries), mappingArtifact,
        mappingDigest: r.mappingDigest, mappingId: r.liquidityMappingId,
        perspectiveInversion: r.perspectiveInversion, rawFieldLocator: r.rawFieldLocator,
        rawPerspective: r.rawPerspective, sourceContractArtifact,
        sourceContractDigest: r.sourceContractDigest, sourceContractRef: r.sourceContractRef, temporal,
      };
    }
    case 'OrderLifecycleEventContract': {
      const source = artifactPayload(state, r.sourceArtifactRef.iri, r.sourceArtifactDigest, 'OrderLifecycleEvent.sourceArtifact');
      exactKeys(source, ['providerEvents', 'schemaVersion'], [], 'OrderLifecycleEvent.sourceArtifact');
      if (source.schemaVersion !== '1.0') {
        fail('orders-portfolio-canonical-source-artifact', 'OrderLifecycleEvent.sourceArtifact');
      }
      const stream = oneRecord(byVersion, r.eventStream, TYPES.OrderEventStream, 'OrderLifecycleEvent.eventStream');
      const externalOrder = oneRecord(byVersion, r.externalOrder, TYPES.ExternalOrder, 'OrderLifecycleEvent.externalOrder');
      oneRecord(byVersion, r.orderIntent, TYPES.OrderIntent, 'OrderLifecycleEvent.orderIntent');
      return {
        externalOrder: versionRef(r.externalOrder), externalOriginatingIntentVersionIri: externalOrder.externalOrderOriginatingIntent,
        orderIntent: versionRef(r.orderIntent), providerEventId: r.providerEventId,
        retries: structuredClone(source.providerEvents), sourceOrderKey: r.sourceOrderKey,
        stream: versionRef(r.eventStream), streamExternalOrderIri: stream.streamExternalOrder, temporal,
      };
    }
    case 'OrderIntentLineageContract': {
      const referenceArray = (value) => (Array.isArray(value) ? [...value] : [value]);
      const graphInventory = artifactPayload(
        state,
        r.sourceArtifactRef.iri,
        r.sourceArtifactDigest,
        'OrderIntentLineage.selectedGraphInventory',
      );
      const pitRequest = decodedPitRequest(
        state,
        graphInventory.pitRequestRef,
        graphInventory.pitRequestDigest,
        'OrderIntentLineage.pitRequest',
      );
      const decodeEndpoint = (versionIri, label) => {
        const endpoint = oneRecord(byVersion, versionIri, TYPES.OrderIntent, label);
        const quantityValue = decodeQuantity(endpoint.orderQuantity, `${label}.orderQuantity`);
        return {
          instrument: logicalRef(endpoint.intentInstrument),
          quantityMicros: quantityValue.micros,
          quantityUnit: quantityValue.unit,
          side: decodeCode(endpoint.orderSide, `${ORDERS}OrderSide`, `${label}.orderSide`),
          sourceEvidence: evidenceToLegacy(endpoint, state),
          temporal: temporalToLegacy(endpoint),
          versionIri: endpoint.versionIri,
        };
      };
      const decodeLineage = (record) => {
        const sourceIntentVersionIris = referenceArray(record.sourceOrderIntent);
        const resultIntentVersionIris = referenceArray(record.resultOrderIntent);
        return {
          kind: decodeCode(
            record.orderLineageKind,
            `${ORDERS}OrderLineageKind`,
            'OrderIntentLineage.orderLineageKind',
          ),
          orderLineageKeyDigest: record.orderLineageKeyDigest,
          resultIntentCount: record.resultIntentCount,
          resultIntentVersionSetDigest: record.resultIntentVersionSetDigest,
          resultIntentVersionIris,
          resultIntents: resultIntentVersionIris.map((versionIri, index) => decodeEndpoint(
            versionIri,
            `OrderIntentLineage.graph.resultOrderIntent[${index}]`,
          )),
          sourceEvidence: evidenceToLegacy(record, state),
          sourceIntentCount: record.sourceIntentCount,
          sourceIntentVersionSetDigest: record.sourceIntentVersionSetDigest,
          sourceIntentVersionIris,
          sourceIntents: sourceIntentVersionIris.map((versionIri, index) => decodeEndpoint(
            versionIri,
            `OrderIntentLineage.graph.sourceOrderIntent[${index}]`,
          )),
          temporal: temporalToLegacy(record),
          versionIri: record.versionIri,
        };
      };
      const sourceIntentVersionIris = referenceArray(r.sourceOrderIntent);
      const resultIntentVersionIris = referenceArray(r.resultOrderIntent);
      return {
        kind: decodeCode(
          r.orderLineageKind,
          `${ORDERS}OrderLineageKind`,
          'OrderIntentLineage.orderLineageKind',
        ),
        lineages: [...byVersion.values()]
          .filter((record) => record.typeIri === TYPES.OrderIntentLineage)
          .sort((left, right) => compareUtf8(left.versionIri, right.versionIri))
          .map(decodeLineage),
        orderLineageKeyDigest: r.orderLineageKeyDigest,
        pitRequest,
        resultIntentCount: r.resultIntentCount,
        resultIntentVersionSetDigest: r.resultIntentVersionSetDigest,
        resultIntentVersionIris,
        resultIntents: resultIntentVersionIris.map((versionIri, index) => decodeEndpoint(
          versionIri,
          `OrderIntentLineage.resultOrderIntent[${index}]`,
        )),
        sourceEvidence: evidenceToLegacy(r, state),
        sourceIntentCount: r.sourceIntentCount,
        sourceIntentVersionSetDigest: r.sourceIntentVersionSetDigest,
        sourceIntentVersionIris,
        sourceIntents: sourceIntentVersionIris.map((versionIri, index) => decodeEndpoint(
          versionIri,
          `OrderIntentLineage.sourceOrderIntent[${index}]`,
        )),
        temporal,
        versionIri: r.versionIri,
      };
    }
    case 'ExecutionContract': {
      const intent = oneRecord(byVersion, r.executionOrderIntent, TYPES.OrderIntent, 'Execution.executionOrderIntent');
      const externalOrder = oneRecord(byVersion, r.executionExternalOrder, TYPES.ExternalOrder, 'Execution.executionExternalOrder');
      const stream = oneRecord(byVersion, r.executionStream, TYPES.OrderEventStream, 'Execution.executionStream');
      const quoteRecord = oneRecord(byVersion, r.executionQuotationContract, TYPES.DirectUnitPriceQuotationContract, 'Execution.executionQuotationContract');
      const executionContext = decodeMarketContext(
        byVersion, r, 'executionListing', 'executionOtcContext', 'Execution.context',
      );
      const quotationContext = decodeMarketContext(
        byVersion, quoteRecord, 'quotationListingContext', 'quotationOTCContext', 'Execution.quotationContext',
      );
      const quantityValue = decodeQuantity(r.executionQuantity, 'Execution.executionQuantity');
      const price = decodeMoney(r.executionPrice, 'Execution.executionPrice');
      return {
        account: logicalRef(r.executionAccount), contextKind: executionContext.kind,
        contraAccount: logicalRef(r.contraAccount), contraParty: logicalRef(r.contraParty),
        contextQuoteCurrency: executionContext.quoteCurrency,
        contextTemporal: executionContext.temporal, contextVersionIri: executionContext.versionIri,
        executionExternalOrderLogicalIri: versionRef(r.executionExternalOrder).logicalIri,
        externalOriginatingIntentVersionIri: externalOrder.externalOrderOriginatingIntent,
        executionParty: logicalRef(r.executionParty),
        instrument: logicalRef(r.executionInstrument), intentAccountIri: intent.intentAccount,
        intentInstrumentIri: intent.intentInstrument, orderIntentVersionIri: r.executionOrderIntent,
        priceCurrency: price.currency, providerExecutionId: r.providerExecutionId,
        quantityMicros: quantityValue.micros,
        quantityUnit: quantityValue.unit,
        quoteCurrency: currencyLexical(
          quoteRecord.quotationQuoteCurrency,
          'Execution.quotationQuoteCurrency',
        ),
        quotationContextKind: quotationContext.kind, quotationContextVersionIri: quotationContext.versionIri,
        quoteDenominatorUnit: quantityUnitLexical(
          quoteRecord.quotationDenominatorUnit,
          'Execution.quotationDenominatorUnit',
        ),
        quoteInstrumentIri: quoteRecord.quotationInstrument,
        side: decodeCode(r.orderSide, `${ORDERS}OrderSide`, 'Execution.orderSide'),
        sourceEvidence: evidenceToLegacy(r, state), stream: versionRef(r.executionStream),
        streamExternalOrderIri: stream.streamExternalOrder, temporal,
        ...(r.executingBroker !== undefined
          ? { executingBroker: logicalRef(r.executingBroker) } : {}),
        ...(executionContext.listedInstrumentIri !== undefined
          ? { listedInstrumentIri: executionContext.listedInstrumentIri } : {}),
      };
    }
    case 'ExecutionLiquidityDeterminationCompletenessContract':
      return {
        determinations: [...byVersion.values()].filter((row) => row.typeIri === TYPES.LiquidityRoleDetermination
          && row.determinedExecution === r.versionIri)
          .sort((left, right) => compareUtf8(left.versionIri, right.versionIri))
          .map((row) => decodeLiquidityDeterminationRecord(state, row)),
        executionStream: versionRef(r.executionStream),
      };
    case 'FeeContract': {
      const fee = decodeMoney(r.feeAmount, 'Fee.feeAmount');
      return {
        amountCurrency: fee.currency,
        amountMicros: fee.micros,
        amountScale: fee.scale,
        effect: decodeCode(r.feeEffect, `${ORDERS}FeeEffect`, 'Fee.feeEffect'),
        execution: versionRef(r.feeExecution),
        feeId: r.feeId,
        feeKind: decodeCode(r.feeKind, `${ORDERS}FeeKind`, 'Fee.feeKind'),
        ...(r.feeAssessor !== undefined ? { assessor: logicalRef(r.feeAssessor) } : {}),
        sourceEvidence: evidenceToLegacy(r, state),
        temporal,
      };
    }
    case 'ExternalOrderStatusMappingContract': {
      const vocabulary = oneRecord(byVersion, r.statusVocabulary, TYPES.ExternalOrderStatusVocabulary, 'ExternalOrderStatusMapping.statusVocabulary');
      const result = {
        apiIdentifier: r.providerApiIdentifier,
        canonicalStates: [decodeCode(r.canonicalLifecycleState, `${ORDERS}OrderLifecycleState`, 'ExternalOrderStatusMapping.canonicalLifecycleState')],
        mappingVersion: r.statusMappingVersion,
        provider: logicalRef(r.statusProvider), providerSchemaVersion: r.providerSchemaVersion,
        rawStatusCode: r.rawStatusCode,
        retiredAliases: [], reviewEvidence: { digest: r.reviewDecisionDigest, ref: r.reviewDecisionRef },
        reviewer: logicalRef(r.statusMappingReviewer),
        sourceEvidence: evidenceToLegacy(r, state), temporal, vocabularyApiIdentifier: vocabulary.providerApiIdentifier,
        vocabularyId: vocabulary.statusVocabularyId,
        vocabularyProviderIri: vocabulary.statusVocabularyProvider,
        vocabularySchemaVersion: vocabulary.providerSchemaVersion,
        vocabularyVersionIri: vocabulary.versionIri,
      };
      return result;
    }
    case 'LiquidityRoleDeterminationContract':
      return decodeLiquidityDeterminationRecord(state, r);
    case 'OrderEventIntegrityFindingContract': {
      const lifecycleRefs = [...(r.relatedLifecycleEvent || [])];
      const executionRefs = [...(r.relatedExecution || [])];
      const relatedLifecycleEvents = lifecycleRefs.map((versionIri, index) => (
        decodeIntegrityLifecycleEvent(
          state,
          versionIri,
          `OrderEventIntegrityFinding.relatedLifecycleEvent[${index}]`,
        )
      ));
      const relatedExecutions = executionRefs.map((versionIri, index) => (
        decodeIntegrityExecution(
          state,
          versionIri,
          `OrderEventIntegrityFinding.relatedExecution[${index}]`,
        )
      ));
      const kind = decodeCode(
        r.orderIntegrityKind,
        `${ORDERS}OrderIntegrityKind`,
        'OrderEventIntegrityFinding.kind',
      );
      const branchFields = [
        'evaluatedTransitionProfile',
        'expectedAfterSourceOrderKey',
        'findingProviderEventId',
        'missingKeyFrom',
        'missingKeyTo',
        'observedSourceOrderKey',
        'requiredPredecessorSourceOrderKey',
        'subjectFillExecution',
        'subjectFromEvent',
        'subjectMissingAcknowledgementOrder',
        'subjectTerminalEvent',
        'subjectToEvent',
      ];
      const presentBranchFields = branchFields.filter((field) => r[field] !== undefined);
      let findingSubject;
      switch (kind) {
        case 'duplicateConflict':
          findingSubject = { providerEventId: r.findingProviderEventId };
          break;
        case 'sequenceGap':
          findingSubject = { missingFrom: r.missingKeyFrom, missingTo: r.missingKeyTo };
          break;
        case 'outOfOrder':
          findingSubject = {
            observedKey: r.observedSourceOrderKey,
            requiredPredecessorKey: r.requiredPredecessorSourceOrderKey,
          };
          break;
        case 'lateFill':
          findingSubject = {
            fillVersionIri: r.subjectFillExecution,
            terminalEventVersionIri: r.subjectTerminalEvent,
          };
          break;
        case 'missingAcknowledgement':
          findingSubject = {
            expectedAfterKey: r.expectedAfterSourceOrderKey,
            externalOrderVersionIri: r.subjectMissingAcknowledgementOrder,
          };
          break;
        case 'transitionViolation':
          findingSubject = {
            fromEventVersionIri: r.subjectFromEvent,
            toEventVersionIri: r.subjectToEvent,
            transitionProfileVersionIri: r.evaluatedTransitionProfile,
          };
          break;
        default:
          findingSubject = {};
          break;
      }
      const specialRefs = presentBranchFields
        .filter((field) => [
          'evaluatedTransitionProfile',
          'subjectFillExecution',
          'subjectFromEvent',
          'subjectMissingAcknowledgementOrder',
          'subjectTerminalEvent',
          'subjectToEvent',
        ].includes(field))
        .map((field) => r[field]);
      const relatedVersions = [...new Set([
        ...lifecycleRefs,
        ...executionRefs,
        ...specialRefs,
      ])].sort(compareUtf8);
      const result = {
        affectedKeyDigest: r.affectedKeyDigest,
        findingSubject,
        generatingContextRef: r.generatingContextRef,
        genericRelatedVersionRefs: [...lifecycleRefs, ...executionRefs],
        kind,
        presentBranchFields,
        relatedExecutions,
        relatedLifecycleEvents,
        relatedVersions,
        relatedVersionSetDigest: r.relatedVersionSetDigest,
        stream: versionRef(r.findingStream),
        temporal,
      };
      if (r.subjectMissingAcknowledgementOrder !== undefined) {
        result.subjectMissingAcknowledgementOrder = versionRef(
          oneRecord(
            byVersion,
            r.subjectMissingAcknowledgementOrder,
            TYPES.ExternalOrder,
            'OrderEventIntegrityFinding.subjectMissingAcknowledgementOrder',
          ).versionIri,
        );
      }
      if (r.evaluatedTransitionProfile !== undefined) {
        result.evaluatedTransitionProfile = decodeIntegrityTransitionProfile(
          state,
          r.evaluatedTransitionProfile,
          'OrderEventIntegrityFinding.evaluatedTransitionProfile',
        );
      }
      return result;
    }
    case 'PortfolioContract': return { portfolioId: r.portfolioId, temporal };
    case 'PortfolioObservationStreamContract':
      return {
        completenessContract: {
          digest: r.portfolioObservationCompletenessContractDigest,
          ref: r.portfolioObservationCompletenessContractRef,
        },
        paginationContract: {
          digest: r.portfolioObservationPaginationContractDigest,
          ref: r.portfolioObservationPaginationContractRef,
        },
        provider: logicalRef(r.portfolioObservationStreamProvider),
        sourceContract: {
          digest: r.portfolioObservationSourceContractDigest,
          ref: r.portfolioObservationSourceContractRef,
        },
        sourceEvidence: evidenceToLegacy(r, state),
        sourceLocatorPresent: r.sourceLocator !== undefined,
        streamId: r.portfolioObservationStreamId,
        temporal,
        versionIri: r.versionIri,
      };
    case 'PortfolioAccountMembershipContract':
      return {
        account: logicalRef(r.memberAccount), approvalEvidence: { digest: r.approvalDigest, ref: r.approvalRef },
        authorityEvidence: { digest: sha256Jcs({ authority: r.membershipAuthority }), ref: r.membershipAuthority }, membershipId: r.membershipId,
        portfolio: logicalRef(r.membershipPortfolio), sourceEvidence: evidenceToLegacy(r, state), temporal,
      };
    case 'PortfolioManagementMandateContract':
      return {
        approvalEvidence: { digest: r.approvalDigest, ref: r.approvalRef }, authorityEvidence: { digest: sha256Jcs({ authority: r.mandateAuthority }), ref: r.mandateAuthority },
        managingParty: logicalRef(r.managingParty), mandateId: r.mandateId, portfolio: logicalRef(r.managedPortfolio),
        sourceEvidence: evidenceToLegacy(r, state), temporal,
      };
    case 'PortfolioAccountMembershipClosureContract':
      return decodeMembershipClosureRecord(state, r);
    case 'HoldingSnapshotContract': {
      const q = decodeQuantity(r.holdingQuantity, 'HoldingSnapshot.holdingQuantity');
      const listing = r.holdingListing
        ? oneRecord(
          byVersion,
          r.holdingListing,
          TYPES.InstrumentListing,
          'HoldingSnapshot.holdingListing',
        )
        : null;
      return {
        account: logicalRef(r.holdingAccount),
        generatingContextRef: r.generatingContextRef,
        instrument: logicalRef(r.holdingInstrument),
        observationStream: versionRef(r.holdingObservationStream),
        listingInstrumentVersionIri: listing?.listedInstrument,
        listingTemporal: listing ? temporalToLegacy(listing) : null,
        listingVersionIri: listing?.versionIri,
        quantityMicros: q.micros,
        quantityUnit: q.unit,
        quantityUnitIri: r.holdingQuantity.unit,
        snapshotId: r.snapshotId,
        sourceEvidence: evidenceToLegacy(r, state),
        sourceKind: decodeCode(
          r.positionSourceKind,
          `${PORTFOLIO}PositionSourceKind`,
          'HoldingSnapshot.positionSourceKind',
        ),
        sourceScopeRef: r.source,
        temporal,
        versionIri: r.versionIri,
      };
    }
    case 'PositionSnapshotContract': {
      const q = decodeQuantity(r.positionQuantity, 'PositionSnapshot.positionQuantity');
      const listing = r.positionListing
        ? oneRecord(
          byVersion,
          r.positionListing,
          TYPES.InstrumentListing,
          'PositionSnapshot.positionListing',
        )
        : null;
      return {
        account: logicalRef(r.positionAccount),
        generatingContextRef: r.generatingContextRef,
        instrument: logicalRef(r.positionInstrument),
        observationStream: logicalRef(r.positionObservationStream),
        listingInstrumentVersionIri: listing?.listedInstrument,
        listingTemporal: listing ? temporalToLegacy(listing) : null,
        listingVersionIri: listing?.versionIri,
        quantityMicros: q.micros,
        quantityUnit: q.unit,
        quantityUnitIri: r.positionQuantity.unit,
        snapshotId: r.snapshotId,
        sourceEvidence: evidenceToLegacy(r, state),
        sourceKind: decodeCode(
          r.positionSourceKind,
          `${PORTFOLIO}PositionSourceKind`,
          'PositionSnapshot.positionSourceKind',
        ),
        sourceScopeRef: r.source,
        temporal,
        versionIri: r.versionIri,
      };
    }
    case 'PositionLotContract': {
      const original = decodeQuantity(r.originalQuantity, 'PositionLot.originalQuantity');
      const gross = decodeMoney(r.openingGross, 'PositionLot.openingGross');
      const basis = decodeMoney(r.openingCostBasis, 'PositionLot.openingCostBasis');
      const execution = oneRecord(byVersion, r.openingExecution, TYPES.Execution, 'PositionLot.openingExecution');
      const executionPrice = decodeMoney(execution.executionPrice, 'Execution.executionPrice');
      const definition = oneRecord(byVersion, r.costBasisDefinition, TYPES.CostBasisCalculationDefinition, 'PositionLot.costBasisDefinition');
      const quote = oneRecord(byVersion, r.lotQuotationContract, TYPES.DirectUnitPriceQuotationContract, 'PositionLot.lotQuotationContract');
      const listing = oneRecord(
        byVersion,
        r.lotAtListing,
        TYPES.InstrumentListing,
        'PositionLot.lotAtListing',
      );
      const result = {
        account: logicalRef(r.lotInAccount),
        basisCurrency: basis.currency,
        calculationContextRef: r.calculationContextRef,
        costBasisDefinition: {
          basisCurrency: currencyLexical(
            definition.costBasisDefinitionBasisCurrency,
            'PositionLot.costBasisDefinitionBasisCurrency',
          ),
          precisionPolicy: {
            digest: definition.precisionPolicyDigest,
            payload: artifactPayload(state, definition.precisionPolicyRef, definition.precisionPolicyDigest, 'PositionLot.precisionPolicy'),
            ref: definition.precisionPolicyRef,
          },
          quotationContractVersionIri: definition.costBasisDefinitionQuotationContract,
          roundingPolicy: {
            digest: definition.roundingPolicyDigest,
            payload: artifactPayload(state, definition.roundingPolicyRef, definition.roundingPolicyDigest, 'PositionLot.roundingPolicy'),
            ref: definition.roundingPolicyRef,
          },
          versionIri: definition.versionIri,
        },
        executionAccountIri: execution.executionAccount,
        executionCurrency: executionPrice.currency,
        executionInstrumentIri: execution.executionInstrument,
        executionListingVersionIri: execution.executionListing,
        executionPriceMicros: executionPrice.micros,
        executionPriceScale: executionPrice.scale,
        executionQuotationContractVersionIri: execution.executionQuotationContract,
        instrument: logicalRef(r.lotForInstrument),
        lotDiscriminator: r.lotDiscriminator,
        listingInstrumentVersionIri: listing.listedInstrument,
        listingTemporal: temporalToLegacy(listing),
        listingVersionIri: listing.versionIri,
        openingCostBasisMicros: basis.micros,
        openingCostBasisScale: basis.scale,
        openingExecution: versionRef(r.openingExecution),
        openingGrossCurrency: gross.currency,
        openingGrossMicros: gross.micros,
        openingGrossScale: gross.scale,
        originalQuantityMicros: original.micros,
        quantityScale: original.precision,
        quantityUnit: original.unit,
        quotationContract: versionRef(r.lotQuotationContract),
        quoteCurrency: currencyLexical(
          quote.quotationQuoteCurrency,
          'PositionLot.quotationQuoteCurrency',
        ),
        quoteDenominatorUnit: quantityUnitLexical(
          quote.quotationDenominatorUnit,
          'PositionLot.quotationDenominatorUnit',
        ),
        quoteInstrumentIri: quote.quotationInstrument,
        quoteListingVersionIri: quote.quotationListingContext,
        sourceEvidence: evidenceToLegacy(r, state),
        temporal,
        versionIri: r.versionIri,
      };
      if (r.openingGrossFxConversion !== undefined) {
        const fx = oneRecord(byVersion, r.openingGrossFxConversion, TYPES.FXConversion, 'PositionLot.openingGrossFxConversion');
        const rateRecord = oneRecord(byVersion, fx.conversionRate, TYPES.FXRateObservation, 'FXConversion.conversionRate');
        const rate = decodeQuantity(rateRecord.fxRate, 'FXRateObservation.fxRate');
        const input = decodeMoney(fx.inputMoney, 'FXConversion.inputMoney');
        const output = decodeMoney(fx.outputMoney, 'FXConversion.outputMoney');
        result.fxConversion = {
          baseCurrency: currencyLexical(
            rateRecord.baseCurrency,
            'PositionLot.fxRate.baseCurrency',
          ),
          consumerBackReference: r.openingGrossFxConversion,
          consumerVersionIri: fx.conversionOpeningLot,
          direction: decodeCode(fx.fxConversionDirection, `${PORTFOLIO}FXConversionDirection`, 'FXConversion.direction'),
          inputContext: {
            digest: fx.inputContextRecordDigest,
            payload: artifactPayload(state, fx.inputContextRef, fx.inputContextRecordDigest, 'PositionLot.fxInputContext'),
            ref: fx.inputContextRef,
          },
          inputCurrency: input.currency,
          inputMicros: input.micros,
          inputScale: input.scale,
          outputCurrency: output.currency,
          outputMicros: output.micros,
          outputScale: output.scale,
          quoteCurrency: currencyLexical(
            rateRecord.quoteCurrency,
            'PositionLot.fxRate.quoteCurrency',
          ),
          ratePpm: rate.micros,
          rateScale: rate.precision,
          rateTemporal: temporalToLegacy(rateRecord),
          rateUnit: rateRecord.fxRate.unit,
          rateVersionIri: rateRecord.versionIri,
          roundingPolicy: {
            digest: fx.roundingPolicyDigest,
            payload: artifactPayload(state, fx.roundingPolicyRef, fx.roundingPolicyDigest, 'PositionLot.fxRoundingPolicy'),
            ref: fx.roundingPolicyRef,
          },
          versionIri: fx.versionIri,
        };
      }
      return result;
    }
    case 'PositionLotOpeningAllocationCompletenessContract': {
      const original = decodeQuantity(r.originalQuantity, 'PositionLot.originalQuantity');
      const execution = oneRecord(
        byVersion,
        r.openingExecution,
        TYPES.Execution,
        'PositionLotOpeningAllocation.openingExecution',
      );
      const executionQuantity = decodeQuantity(
        execution.executionQuantity,
        'PositionLotOpeningAllocation.executionQuantity',
      );
      const definition = oneRecord(
        byVersion,
        r.costBasisDefinition,
        TYPES.CostBasisCalculationDefinition,
        'PositionLotOpeningAllocation.costBasisDefinition',
      );
      const quotation = oneRecord(
        byVersion,
        r.lotQuotationContract,
        TYPES.DirectUnitPriceQuotationContract,
        'PositionLotOpeningAllocation.quotationContract',
      );
      const listing = r.lotAtListing === undefined
        ? null
        : oneRecord(
          byVersion,
          r.lotAtListing,
          TYPES.InstrumentListing,
          'PositionLotOpeningAllocation.listing',
        );
      const allocations = [...byVersion.values()].filter((row) => (
        row.typeIri === TYPES.PositionLotAllocation
          && row.allocatedLot === r.versionIri
          && decodeCode(
            row.lotAllocationKind,
            `${PORTFOLIO}PositionLotAllocationKind`,
            'PositionLotAllocation.kind',
          ) === 'opening'
      ));
      return {
        accountIri: r.lotInAccount,
        calculationContextRef: r.calculationContextRef,
        definitionQuotationVersionIri:
          definition.costBasisDefinitionQuotationContract,
        definitionVersionIri: definition.versionIri,
        executionAccountIri: execution.executionAccount,
        executionInstrumentIri: execution.executionInstrument,
        executionListingVersionIri: execution.executionListing,
        executionQuantityMicros: executionQuantity.micros,
        executionQuantityUnit: executionQuantity.unit,
        executionQuotationVersionIri: execution.executionQuotationContract,
        executionSide: decodeCode(
          execution.orderSide,
          `${ORDERS}OrderSide`,
          'PositionLotOpeningAllocation.executionSide',
        ),
        instrumentIri: r.lotForInstrument,
        listingInstrumentIri: listing?.listedInstrument,
        listingVersionIri: listing?.versionIri,
        lot: versionRef(r.versionIri),
        openingAllocations: allocations.map((row) => {
          const allocated = decodeQuantity(
            row.allocatedQuantity,
            'PositionLotAllocation.allocatedQuantity',
          );
          return {
            calculationContextRef: row.calculationContextRef,
            definitionVersionIri: row.allocationCostBasisDefinition,
            executionVersionIri: row.allocationExecution,
            lotVersionIri: row.allocatedLot,
            quantityMicros: allocated.micros,
            quantityUnit: allocated.unit,
            temporal: temporalToLegacy(row),
            versionIri: row.versionIri,
          };
        }),
        openingExecutionVersionIri: r.openingExecution,
        originalQuantityMicros: original.micros,
        quantityUnit: original.unit,
        quotationInstrumentIri: quotation.quotationInstrument,
        quotationVersionIri: quotation.versionIri,
        temporal,
      };
    }
    case 'ValuationCalculationDefinitionContract':
      return decodeValuationDefinitionRecord(state, r);
    case 'CostBasisCalculationDefinitionContract':
      return {
        authority: logicalRef(r.costBasisDefinitionAuthority), basisCurrency: logicalRef(r.costBasisDefinitionBasisCurrency),
        currencyPolicy: r.currencyPolicy, definitionId: r.costBasisDefinitionId,
        feeTreatment: decodeCode(r.feeTreatment, `${PORTFOLIO}FeeTreatment`, 'CostBasisDefinition.feeTreatment'),
        fxPolicy: r.fxPolicy,
        implementationArtifact: artifactByDigest(state, r.implementationDigest, 'CostBasisDefinition.implementation'),
        implementationDigest: r.implementationDigest,
        inputContractArtifact: artifactByDigest(state, r.inputContractDigest, 'CostBasisDefinition.inputContract'),
        inputContractDigest: r.inputContractDigest,
        lotConsumptionPolicy: decodeCode(r.lotConsumptionPolicy, `${PORTFOLIO}LotConsumptionPolicy`, 'CostBasisDefinition.lotConsumptionPolicy'),
        lotOpeningPolicy: decodeCode(r.lotOpeningPolicy, `${PORTFOLIO}LotOpeningPolicy`, 'CostBasisDefinition.lotOpeningPolicy'),
        method: decodeCode(r.costBasisMethod, `${PORTFOLIO}CostBasisMethod`, 'CostBasisDefinition.method'),
        outputContractArtifact: artifactByDigest(state, r.outputContractDigest, 'CostBasisDefinition.outputContract'),
        outputContractDigest: r.outputContractDigest,
        precisionPolicy: {
          digest: r.precisionPolicyDigest,
          payload: artifactPayload(state, r.precisionPolicyRef, r.precisionPolicyDigest, 'CostBasisDefinition.precisionPolicy'),
          ref: r.precisionPolicyRef,
        },
        quotationContract: versionRef(r.costBasisDefinitionQuotationContract),
        roundingPolicy: {
          digest: r.roundingPolicyDigest,
          payload: artifactPayload(state, r.roundingPolicyRef, r.roundingPolicyDigest, 'CostBasisDefinition.roundingPolicy'),
          ref: r.roundingPolicyRef,
        },
        runtimeArtifact: artifactByDigest(state, r.runtimeDigest, 'CostBasisDefinition.runtime'),
        runtimeDigest: r.runtimeDigest, sourceEvidence: evidenceToLegacy(r, state), temporal,
        toolLockArtifact: {
          digest: r.toolLockDigest,
          payload: artifactPayload(state, r.toolLockRef, r.toolLockDigest, 'CostBasisDefinition.toolLock'),
          ref: r.toolLockRef,
        },
        toolLockDigest: r.toolLockDigest, toolLockRef: r.toolLockRef,
      };
    case 'PortfolioValuationContract': {
      const closure = oneRecord(byVersion, r.memberAccountClosure, TYPES.PortfolioAccountMembershipClosure, 'PortfolioValuation.memberAccountClosure');
      const definition = oneRecord(
        byVersion,
        r.valuationDefinition,
        TYPES.ValuationCalculationDefinition,
        'PortfolioValuation.valuationDefinition',
      );
      return {
        conversionContext: {
          digest: r.conversionContextDigest,
          payload: artifactPayload(
            state,
            r.conversionContextRef,
            r.conversionContextDigest,
            'PortfolioValuation.conversionContext',
          ),
          ref: r.conversionContextRef,
        },
        generatingContextRef: r.generatingContextRef,
        inputContext: {
          digest: r.inputContextRecordDigest,
          payload: artifactPayload(
            state,
            r.inputContextRef,
            r.inputContextRecordDigest,
            'PortfolioValuation.inputContext',
          ),
          ref: r.inputContextRef,
        },
        memberClosure: decodeMembershipClosureRecord(
          state,
          closure,
          'PortfolioValuation.memberAccountClosure',
        ),
        pitRequest: decodedPitRequest(
          state,
          r.pitRequestRef,
          r.pitRequestRecordDigest,
          'PortfolioValuation.pitRequest',
        ),
        reportingCurrency: logicalRef(r.reportingCurrency),
        sourceScopeRef: r.source,
        temporal,
        valuationDefinition: decodeValuationDefinitionRecord(
          state,
          definition,
          'PortfolioValuation.valuationDefinition',
        ),
        valuationRunId: r.valuationRunId,
        valuedPortfolio: logicalRef(r.valuedPortfolio),
        versionIri: r.versionIri,
      };
    }
    case 'PositionValuationContract': {
      const snapshotRef = r.valuedHoldingSnapshot || r.valuedPositionSnapshot;
      const snapshotType = r.valuedHoldingSnapshot ? TYPES.HoldingSnapshot : TYPES.PositionSnapshot;
      const snapshot = oneRecord(byVersion, snapshotRef, snapshotType, 'PositionValuation.snapshot');
      const price = oneRecord(byVersion, r.valuationPrice, TYPES.PriceObservation, 'PositionValuation.valuationPrice');
      const quoteRecord = oneRecord(byVersion, price.quotationContract, TYPES.DirectUnitPriceQuotationContract, 'PriceObservation.quotationContract');
      const header = oneRecord(byVersion, r.valuationHeader, TYPES.PortfolioValuation, 'PositionValuation.valuationHeader');
      const definition = oneRecord(byVersion, header.valuationDefinition, TYPES.ValuationCalculationDefinition, 'PortfolioValuation.valuationDefinition');
      const closure = oneRecord(byVersion, header.memberAccountClosure, TYPES.PortfolioAccountMembershipClosure, 'PortfolioValuation.memberAccountClosure');
      const memberships = (closure.closedMembership || []).map((value) => oneRecord(byVersion, value, TYPES.PortfolioAccountMembership, 'MembershipClosure.closedMembership'));
      const priceContext = decodeMarketContext(
        byVersion,
        price,
        'observedListing',
        'observedOtcContext',
        'PositionValuation.priceContext',
      );
      const quoteContext = decodeMarketContext(
        byVersion,
        quoteRecord,
        'quotationListingContext',
        'quotationOTCContext',
        'PositionValuation.quoteContext',
      );
      const q = decodeQuantity(snapshot.holdingQuantity || snapshot.positionQuantity, 'PositionValuation.snapshotQuantity');
      const p = decodeMoney(price.priceValue, 'PositionValuation.priceValue');
      const market = decodeMoney(r.marketValue, 'PositionValuation.marketValue');
      const precisionPolicy = {
        digest: definition.precisionPolicyDigest,
        payload: artifactPayload(state, definition.precisionPolicyRef, definition.precisionPolicyDigest, 'PositionValuation.precisionPolicy'),
        ref: definition.precisionPolicyRef,
      };
      const roundingPolicy = {
        digest: definition.roundingPolicyDigest,
        payload: artifactPayload(state, definition.roundingPolicyRef, definition.roundingPolicyDigest, 'PositionValuation.roundingPolicy'),
        ref: definition.roundingPolicyRef,
      };
      const result = {
        marketValueCurrency: market.currency, marketValueMicros: market.micros, marketValueScale: market.scale,
        memberAccountIris: [...new Set(memberships.map((membership) => membership.memberAccount))]
          .sort(compareUtf8),
        priceContext,
        priceCurrency: p.currency, priceInstrumentIri: versionRef(price.observedInstrument).logicalIri,
        priceMicros: p.micros, priceQuotationContractVersionIri: price.quotationContract, priceScale: p.scale,
        quantityMicros: q.micros, quantityScale: q.precision, quantityUnit: q.unit,
        quoteDenominatorUnit: quantityUnitLexical(
          quoteRecord.quotationDenominatorUnit,
          'PositionValuation.quotationDenominatorUnit',
        ),
        quoteContext,
        quoteCurrency: currencyLexical(
          quoteRecord.quotationQuoteCurrency,
          'PositionValuation.quotationQuoteCurrency',
        ),
        quoteInstrumentIri: quoteRecord.quotationInstrument,
        reportingCurrency: currencyLexical(
          header.reportingCurrency,
          'PositionValuation.reportingCurrency',
        ),
        snapshotAccountIri: snapshot.holdingAccount || snapshot.positionAccount,
        snapshotInstrumentIri: snapshot.holdingInstrument || snapshot.positionInstrument,
        snapshotListingVersionIri: snapshot.holdingListing || snapshot.positionListing,
        temporal,
        valuationDefinition: {
          method: decodeCode(definition.valuationMethod, `${PORTFOLIO}ValuationMethod`, 'ValuationCalculationDefinition.method'),
          precisionPolicy,
          quotationContractCount: definition.valuationQuotationContractCount,
          quotationContractVersionIris: structuredClone(definition.valuationDefinitionQuotationContract || []),
          quotationContractVersionSetDigest: definition.valuationQuotationContractVersionSetDigest,
          roundingPolicy,
          versionIri: definition.versionIri,
        },
        versionIri: r.versionIri,
      };
      if (r.valuationFxConversion) {
        const fx = oneRecord(byVersion, r.valuationFxConversion, TYPES.FXConversion, 'PositionValuation.valuationFxConversion');
        const rateRecord = oneRecord(byVersion, fx.conversionRate, TYPES.FXRateObservation, 'FXConversion.conversionRate');
        const rate = decodeQuantity(rateRecord.fxRate, 'FXRateObservation.fxRate');
        const input = decodeMoney(fx.inputMoney, 'FXConversion.inputMoney');
        const output = decodeMoney(fx.outputMoney, 'FXConversion.outputMoney');
        result.fx = {
          baseCurrency: currencyLexical(
            rateRecord.baseCurrency,
            'PositionValuation.fxRate.baseCurrency',
          ),
          consumerBackReference: r.valuationFxConversion,
          consumerVersionIri: fx.conversionValuationLine,
          direction: decodeCode(fx.fxConversionDirection, `${PORTFOLIO}FXConversionDirection`, 'FXConversion.direction'),
          inputContext: {
            digest: fx.inputContextRecordDigest,
            payload: artifactPayload(state, fx.inputContextRef, fx.inputContextRecordDigest, 'PositionValuation.fxInputContext'),
            ref: fx.inputContextRef,
          },
          inputCurrency: input.currency,
          inputMicros: input.micros,
          inputScale: input.scale,
          outputCurrency: output.currency,
          outputMicros: output.micros,
          outputScale: output.scale,
          quoteCurrency: currencyLexical(
            rateRecord.quoteCurrency,
            'PositionValuation.fxRate.quoteCurrency',
          ),
          ratePpm: rate.micros,
          rateScale: rate.precision,
          rateTemporal: temporalToLegacy(rateRecord),
          rateUnit: rateRecord.fxRate.unit,
          rateVersionIri: rateRecord.versionIri,
          roundingPolicy: {
            digest: fx.roundingPolicyDigest,
            payload: artifactPayload(state, fx.roundingPolicyRef, fx.roundingPolicyDigest, 'PositionValuation.fxRoundingPolicy'),
            ref: fx.roundingPolicyRef,
          },
          versionIri: fx.versionIri,
        };
      }
      return result;
    }
    case 'FXConversionContract': {
      const rateRecord = oneRecord(byVersion, r.conversionRate, TYPES.FXRateObservation, 'FXConversion.conversionRate');
      const rate = decodeQuantity(rateRecord.fxRate, 'FXRateObservation.fxRate');
      const input = decodeMoney(r.inputMoney, 'FXConversion.inputMoney');
      const output = decodeMoney(r.outputMoney, 'FXConversion.outputMoney');
      const branches = [
        ['conversionValuationLine', TYPES.PositionValuation, 'valuationFxConversion'],
        ['conversionOpeningLot', TYPES.PositionLot, 'openingGrossFxConversion'],
        ['conversionFeeAllocation', TYPES.PositionLotFeeAllocation, 'feeFxConversion'],
      ].filter(([field]) => r[field] !== undefined);
      if (branches.length !== 1) fail('orders-portfolio-canonical-fx-consumer', r.versionIri);
      const [consumerField, consumerType, backField] = branches[0];
      const consumer = oneRecord(byVersion, r[consumerField], consumerType, `FXConversion.${consumerField}`);
      return {
        baseCurrency: currencyLexical(
          rateRecord.baseCurrency,
          'FXConversion.fxRate.baseCurrency',
        ),
        consumers: [r.conversionValuationLine || r.conversionOpeningLot || r.conversionFeeAllocation],
        direction: decodeCode(r.fxConversionDirection, `${PORTFOLIO}FXConversionDirection`, 'FXConversion.direction'),
        consumerBackReference: consumer[backField],
        inputContext: {
          digest: r.inputContextRecordDigest,
          payload: artifactPayload(state, r.inputContextRef, r.inputContextRecordDigest, 'FXConversion.inputContext'),
          ref: r.inputContextRef,
        },
        inputCurrency: input.currency, inputMicros: input.micros, inputScale: input.scale,
        outputCurrency: output.currency, outputMicros: output.micros, outputScale: output.scale,
        quoteCurrency: currencyLexical(
          rateRecord.quoteCurrency,
          'FXConversion.fxRate.quoteCurrency',
        ),
        ratePpm: rate.micros, rateScale: rate.precision, rateTemporal: temporalToLegacy(rateRecord),
        rateUnit: rateRecord.fxRate.unit,
        rateVersionIri: rateRecord.versionIri,
        roundingPolicy: {
          digest: r.roundingPolicyDigest,
          payload: artifactPayload(state, r.roundingPolicyRef, r.roundingPolicyDigest, 'FXConversion.roundingPolicy'),
          ref: r.roundingPolicyRef,
        },
        temporal, versionIri: r.versionIri,
      };
    }
    case 'PositionLotAllocationContract': {
      const lot = oneRecord(byVersion, r.allocatedLot, TYPES.PositionLot, 'PositionLotAllocation.allocatedLot');
      const execution = oneRecord(
        byVersion,
        r.allocationExecution,
        TYPES.Execution,
        'PositionLotAllocation.allocationExecution',
      );
      const definition = oneRecord(
        byVersion,
        r.allocationCostBasisDefinition,
        TYPES.CostBasisCalculationDefinition,
        'PositionLotAllocation.allocationCostBasisDefinition',
      );
      const lotQuotation = oneRecord(
        byVersion,
        lot.lotQuotationContract,
        TYPES.DirectUnitPriceQuotationContract,
        'PositionLotAllocation.lotQuotationContract',
      );
      const executionQuotation = oneRecord(
        byVersion,
        execution.executionQuotationContract,
        TYPES.DirectUnitPriceQuotationContract,
        'PositionLotAllocation.executionQuotationContract',
      );
      const lotListing = oneRecord(
        byVersion,
        lot.lotAtListing,
        TYPES.InstrumentListing,
        'PositionLotAllocation.lotAtListing',
      );
      const executionListing = oneRecord(
        byVersion,
        execution.executionListing,
        TYPES.InstrumentListing,
        'PositionLotAllocation.executionListing',
      );
      const quantityValue = decodeQuantity(r.allocatedQuantity, 'PositionLotAllocation.allocatedQuantity');
      const original = decodeQuantity(lot.originalQuantity, 'PositionLot.originalQuantity');
      const executionQuantity = decodeQuantity(
        execution.executionQuantity,
        'PositionLotAllocation.executionQuantity',
      );
      const result = {
        calculationContextRef: r.calculationContextRef,
        definitionQuotationVersionIri: definition.costBasisDefinitionQuotationContract,
        definitionVersionIri: r.allocationCostBasisDefinition,
        execution: versionRef(r.allocationExecution),
        executionAccountIri: execution.executionAccount,
        executionInstrumentIri: execution.executionInstrument,
        executionListingVersionIri: executionListing.versionIri,
        executionQuantityMicros: executionQuantity.micros,
        executionQuantityUnit: executionQuantity.unit,
        executionQuotationVersionIri: executionQuotation.versionIri,
        executionSide: decodeCode(
          execution.orderSide,
          `${ORDERS}OrderSide`,
          'PositionLotAllocation.executionSide',
        ),
        executionTemporal: temporalToLegacy(execution),
        generatingContextRef: r.generatingContextRef,
        kind: decodeCode(r.lotAllocationKind, `${PORTFOLIO}PositionLotAllocationKind`, 'PositionLotAllocation.kind'),
        lot: versionRef(r.allocatedLot),
        lotAccountIri: lot.lotInAccount,
        lotCalculationContextRef: lot.calculationContextRef,
        lotDefinitionVersionIri: lot.costBasisDefinition,
        lotInstrumentIri: lot.lotForInstrument,
        lotListedInstrumentVersionIri: lotListing.listedInstrument,
        lotListingVersionIri: lotListing.versionIri,
        lotQuantityUnit: original.unit,
        lotQuotationVersionIri: lotQuotation.versionIri,
        lotTemporal: temporalToLegacy(lot),
        openingExecutionVersionIri: lot.openingExecution,
        originalQuantityMicros: original.micros,
        quantityMicros: quantityValue.micros,
        quantityUnit: quantityValue.unit,
        temporal,
      };
      return result;
    }
    case 'PositionLotFeeAllocationContract': {
      const fee = oneRecord(byVersion, r.allocatedFee, TYPES.Fee, 'PositionLotFeeAllocation.allocatedFee');
      const allocation = oneRecord(byVersion, r.feeLotAllocation, TYPES.PositionLotAllocation, 'PositionLotFeeAllocation.feeLotAllocation');
      const definition = oneRecord(
        byVersion,
        r.feeCostBasisDefinition,
        TYPES.CostBasisCalculationDefinition,
        'PositionLotFeeAllocation.feeCostBasisDefinition',
      );
      const feeExecution = oneRecord(
        byVersion,
        fee.feeExecution,
        TYPES.Execution,
        'PositionLotFeeAllocation.feeExecution',
      );
      const allocationExecution = oneRecord(
        byVersion,
        allocation.allocationExecution,
        TYPES.Execution,
        'PositionLotFeeAllocation.allocationExecution',
      );
      const amount = decodeMoney(r.allocatedFeeAmount, 'PositionLotFeeAllocation.allocatedFeeAmount');
      const feeAmount = decodeMoney(fee.feeAmount, 'Fee.feeAmount');
      const governingClosures = [...byVersion.values()].filter((row) => row.typeIri === TYPES.ExecutionLotAllocationClosure
        && (row.closureAllocation || []).includes(allocation.versionIri));
      if (governingClosures.length !== 1) fail('orders-portfolio-canonical-reference', 'PositionLotFeeAllocation.governingClosure');
      const closure = governingClosures[0];
      const result = {
        amountMicros: amount.micros,
        basisCurrency: currencyLexical(
          definition.costBasisDefinitionBasisCurrency,
          'PositionLotFeeAllocation.costBasisDefinitionBasisCurrency',
        ),
        calculationContextRef: r.calculationContextRef,
        closureAllocationVersionIris: structuredClone(closure.closureAllocation || []),
        closureDefinitionVersionIri: closure.closureCostBasisDefinition,
        closureExecutionVersionIri: closure.closureExecution,
        closureFeeAllocationCount: closure.feeAllocationCount,
        closureFeeAllocationVersionIris: structuredClone(
          closure.closureFeeAllocation || [],
        ),
        closureFeeAllocationVersionSetDigest: closure.feeAllocationVersionSetDigest,
        closureFeeCount: closure.feeCount,
        closureFeeVersionIris: structuredClone(closure.closureFee || []),
        closureFeeVersionSetDigest: closure.feeVersionSetDigest,
        currency: amount.currency,
        definitionVersionIri: r.feeCostBasisDefinition,
        feeAmountMicros: feeAmount.micros,
        feeCurrency: feeAmount.currency,
        feeExecutionVersionIri: feeExecution.versionIri,
        feeVersionIri: fee.versionIri,
        generatingContextRef: r.generatingContextRef,
        lotAllocationContextRef: allocation.calculationContextRef,
        lotAllocationDefinitionVersionIri: allocation.allocationCostBasisDefinition,
        lotAllocationExecutionVersionIri: allocationExecution.versionIri,
        lotAllocationVersionIri: allocation.versionIri,
        precisionPolicy: {
          digest: definition.precisionPolicyDigest,
          payload: artifactPayload(
            state,
            definition.precisionPolicyRef,
            definition.precisionPolicyDigest,
            'PositionLotFeeAllocation.precisionPolicy',
          ),
          ref: definition.precisionPolicyRef,
        },
        roundingPolicy: {
          digest: definition.roundingPolicyDigest,
          payload: artifactPayload(
            state,
            definition.roundingPolicyRef,
            definition.roundingPolicyDigest,
            'PositionLotFeeAllocation.roundingPolicy',
          ),
          ref: definition.roundingPolicyRef,
        },
        temporal,
        versionIri: r.versionIri,
      };
      if (r.feeFxConversion !== undefined) {
        const fx = oneRecord(
          byVersion,
          r.feeFxConversion,
          TYPES.FXConversion,
          'PositionLotFeeAllocation.feeFxConversion',
        );
        const rateRecord = oneRecord(
          byVersion,
          fx.conversionRate,
          TYPES.FXRateObservation,
          'PositionLotFeeAllocation.fxRate',
        );
        const rate = decodeQuantity(rateRecord.fxRate, 'PositionLotFeeAllocation.fxRateValue');
        const input = decodeMoney(fx.inputMoney, 'PositionLotFeeAllocation.fxInput');
        const output = decodeMoney(fx.outputMoney, 'PositionLotFeeAllocation.fxOutput');
        result.fx = {
          baseCurrency: currencyLexical(
            rateRecord.baseCurrency,
            'PositionLotFeeAllocation.fxRate.baseCurrency',
          ),
          consumerBackReference: r.feeFxConversion,
          consumerVersionIri: fx.conversionFeeAllocation,
          direction: decodeCode(
            fx.fxConversionDirection,
            `${PORTFOLIO}FXConversionDirection`,
            'PositionLotFeeAllocation.fxDirection',
          ),
          inputContext: {
            digest: fx.inputContextRecordDigest,
            payload: artifactPayload(
              state,
              fx.inputContextRef,
              fx.inputContextRecordDigest,
              'PositionLotFeeAllocation.fxInputContext',
            ),
            ref: fx.inputContextRef,
          },
          inputCurrency: input.currency,
          inputMicros: input.micros,
          inputScale: input.scale,
          outputCurrency: output.currency,
          outputMicros: output.micros,
          outputScale: output.scale,
          quoteCurrency: currencyLexical(
            rateRecord.quoteCurrency,
            'PositionLotFeeAllocation.fxRate.quoteCurrency',
          ),
          ratePpm: rate.micros,
          rateScale: rate.precision,
          rateTemporal: temporalToLegacy(rateRecord),
          rateUnit: rateRecord.fxRate.unit,
          rateVersionIri: rateRecord.versionIri,
          roundingPolicy: {
            digest: fx.roundingPolicyDigest,
            payload: artifactPayload(
              state,
              fx.roundingPolicyRef,
              fx.roundingPolicyDigest,
              'PositionLotFeeAllocation.fxRoundingPolicy',
            ),
            ref: fx.roundingPolicyRef,
          },
          versionIri: fx.versionIri,
        };
      }
      return result;
    }
    case 'ExecutionLotAllocationClosureContract': {
      const execution = oneRecord(
        byVersion,
        r.closureExecution,
        TYPES.Execution,
        'ExecutionLotAllocationClosure.closureExecution',
      );
      const definition = oneRecord(
        byVersion,
        r.closureCostBasisDefinition,
        TYPES.CostBasisCalculationDefinition,
        'ExecutionLotAllocationClosure.closureCostBasisDefinition',
      );
      const listing = execution.executionListing === undefined
        ? null
        : oneRecord(
          byVersion,
          execution.executionListing,
          TYPES.InstrumentListing,
          'ExecutionLotAllocationClosure.executionListing',
        );
      const quantityValue = decodeQuantity(
        execution.executionQuantity,
        'ExecutionLotAllocationClosure.executionQuantity',
      );
      const allLots = [...byVersion.values()]
        .filter((row) => row.typeIri === TYPES.PositionLot)
        .map((lot) => {
          const original = decodeQuantity(
            lot.originalQuantity,
            'ExecutionLotAllocationClosure.PositionLot.originalQuantity',
          );
          const openingExecution = oneRecord(
            byVersion,
            lot.openingExecution,
            TYPES.Execution,
            'ExecutionLotAllocationClosure.PositionLot.openingExecution',
          );
          return {
            accountIri: lot.lotInAccount,
            calculationContextRef: lot.calculationContextRef,
            definitionVersionIri: lot.costBasisDefinition,
            instrumentIri: lot.lotForInstrument,
            listingVersionIri: lot.lotAtListing,
            openingExecutionAccountIri: openingExecution.executionAccount,
            openingExecutionInstrumentIri: openingExecution.executionInstrument,
            openingExecutionListingVersionIri: openingExecution.executionListing,
            openingExecutionSide: decodeCode(
              openingExecution.orderSide,
              `${ORDERS}OrderSide`,
              'ExecutionLotAllocationClosure.openingExecution.orderSide',
            ),
            openingExecutionVersionIri: openingExecution.versionIri,
            originalQuantityMicros: original.micros,
            quantityUnit: original.unit,
            quotationVersionIri: lot.lotQuotationContract,
            temporal: temporalToLegacy(lot),
            versionIri: lot.versionIri,
          };
        });
      const allAllocations = [...byVersion.values()]
        .filter((row) => row.typeIri === TYPES.PositionLotAllocation)
        .map((allocation) => {
          const allocated = decodeQuantity(
            allocation.allocatedQuantity,
            'ExecutionLotAllocationClosure.PositionLotAllocation.allocatedQuantity',
          );
          return {
            calculationContextRef: allocation.calculationContextRef,
            definitionVersionIri: allocation.allocationCostBasisDefinition,
            executionVersionIri: allocation.allocationExecution,
            kind: decodeCode(
              allocation.lotAllocationKind,
              `${PORTFOLIO}PositionLotAllocationKind`,
              'ExecutionLotAllocationClosure.PositionLotAllocation.kind',
            ),
            lotVersionIri: allocation.allocatedLot,
            quantityMicros: allocated.micros,
            quantityUnit: allocated.unit,
            temporal: temporalToLegacy(allocation),
            versionIri: allocation.versionIri,
          };
        });
      const allFees = [...byVersion.values()]
        .filter((row) => row.typeIri === TYPES.Fee)
        .map((fee) => {
          const amount = decodeMoney(
            fee.feeAmount,
            'ExecutionLotAllocationClosure.Fee.feeAmount',
          );
          return {
            amountMicros: amount.micros,
            currency: amount.currency,
            executionVersionIri: fee.feeExecution,
            temporal: temporalToLegacy(fee),
            versionIri: fee.versionIri,
          };
        });
      const allFeeAllocations = [...byVersion.values()]
        .filter((row) => row.typeIri === TYPES.PositionLotFeeAllocation)
        .map((feeAllocation) => {
          const amount = decodeMoney(
            feeAllocation.allocatedFeeAmount,
            'ExecutionLotAllocationClosure.PositionLotFeeAllocation.allocatedFeeAmount',
          );
          return {
            amountMicros: amount.micros,
            calculationContextRef: feeAllocation.calculationContextRef,
            currency: amount.currency,
            definitionVersionIri: feeAllocation.feeCostBasisDefinition,
            feeVersionIri: feeAllocation.allocatedFee,
            fxVersionIri: feeAllocation.feeFxConversion,
            lotAllocationVersionIri: feeAllocation.feeLotAllocation,
            temporal: temporalToLegacy(feeAllocation),
            versionIri: feeAllocation.versionIri,
          };
        });
      const allocationVersionIris = structuredClone(r.closureAllocation || []);
      const eligibleLotVersionIris = structuredClone(r.closureEligibleLot || []);
      const feeVersionIris = structuredClone(r.closureFee || []);
      const feeAllocationVersionIris = structuredClone(r.closureFeeAllocation || []);
      const selectedLotVersionIris = structuredClone(r.closureSelectedLot || []);
      return {
        allocationCount: r.allocationCount,
        allocationProbe: {
          digest: r.allocationClosureProbeDigest,
          payload: artifactPayload(
            state,
            r.allocationClosureProbeRef,
            r.allocationClosureProbeDigest,
            'ExecutionLotAllocationClosure.allocationProbe',
          ),
          ref: r.allocationClosureProbeRef,
        },
        allocationVersionIris,
        allocationVersionSetDigest: r.allocationVersionSetDigest,
        allAllocations,
        allFeeAllocations,
        allFees,
        allLots,
        basisCurrency: currencyLexical(
          definition.costBasisDefinitionBasisCurrency,
          'ExecutionLotAllocationClosure.costBasisDefinitionBasisCurrency',
        ),
        calculationContextRef: allLots.find(
          (row) => eligibleLotVersionIris.includes(row.versionIri),
        )?.calculationContextRef,
        definitionArtifacts: {
          implementation: artifactByDigest(
            state,
            definition.implementationDigest,
            'ExecutionLotAllocationClosure.definition.implementation',
          ),
          inputContract: artifactByDigest(
            state,
            definition.inputContractDigest,
            'ExecutionLotAllocationClosure.definition.inputContract',
          ),
          outputContract: artifactByDigest(
            state,
            definition.outputContractDigest,
            'ExecutionLotAllocationClosure.definition.outputContract',
          ),
          runtime: artifactByDigest(
            state,
            definition.runtimeDigest,
            'ExecutionLotAllocationClosure.definition.runtime',
          ),
          toolLock: {
            digest: definition.toolLockDigest,
            payload: artifactPayload(
              state,
              definition.toolLockRef,
              definition.toolLockDigest,
              'ExecutionLotAllocationClosure.definition.toolLock',
            ),
            ref: definition.toolLockRef,
          },
        },
        definitionVersionIri: definition.versionIri,
        eligibleLotCount: r.eligibleLotCount,
        eligibleLotVersionIris,
        eligibleLotVersionSetDigest: r.eligibleLotVersionSetDigest,
        executionAccountIri: execution.executionAccount,
        executionInstrumentIri: execution.executionInstrument,
        executionListingInstrumentIri: listing?.listedInstrument,
        executionListingVersionIri: listing?.versionIri,
        executionQuantityMicros: quantityValue.micros,
        executionQuantityUnit: quantityValue.unit,
        executionQuotationVersionIri: execution.executionQuotationContract,
        executionSide: decodeCode(
          execution.orderSide,
          `${ORDERS}OrderSide`,
          'ExecutionLotAllocationClosure.executionSide',
        ),
        executionVersionIri: execution.versionIri,
        feeAllocationCount: r.feeAllocationCount,
        feeAllocationVersionIris,
        feeAllocationVersionSetDigest: r.feeAllocationVersionSetDigest,
        feeCount: r.feeCount,
        feeProbe: {
          digest: r.feeClosureProbeDigest,
          payload: artifactPayload(
            state,
            r.feeClosureProbeRef,
            r.feeClosureProbeDigest,
            'ExecutionLotAllocationClosure.feeProbe',
          ),
          ref: r.feeClosureProbeRef,
        },
        feeTreatment: decodeCode(
          definition.feeTreatment,
          `${PORTFOLIO}FeeTreatment`,
          'ExecutionLotAllocationClosure.feeTreatment',
        ),
        feeVersionIris,
        feeVersionSetDigest: r.feeVersionSetDigest,
        generatingContextRef: r.generatingContextRef,
        inputContext: {
          digest: r.inputContextRecordDigest,
          payload: artifactPayload(
            state,
            r.inputContextRef,
            r.inputContextRecordDigest,
            'ExecutionLotAllocationClosure.inputContext',
          ),
          ref: r.inputContextRef,
        },
        lotConsumptionPolicy: decodeCode(
          definition.lotConsumptionPolicy,
          `${PORTFOLIO}LotConsumptionPolicy`,
          'ExecutionLotAllocationClosure.lotConsumptionPolicy',
        ),
        pitRequest: decodedPitRequest(
          state,
          r.pitRequestRef,
          r.pitRequestRecordDigest,
          'ExecutionLotAllocationClosure.pitRequest',
        ),
        precisionPolicy: {
          digest: definition.precisionPolicyDigest,
          payload: artifactPayload(
            state,
            definition.precisionPolicyRef,
            definition.precisionPolicyDigest,
            'ExecutionLotAllocationClosure.precisionPolicy',
          ),
          ref: definition.precisionPolicyRef,
        },
        quotationVersionIri: definition.costBasisDefinitionQuotationContract,
        roundingPolicy: {
          digest: definition.roundingPolicyDigest,
          payload: artifactPayload(
            state,
            definition.roundingPolicyRef,
            definition.roundingPolicyDigest,
            'ExecutionLotAllocationClosure.roundingPolicy',
          ),
          ref: definition.roundingPolicyRef,
        },
        selectedLotCount: r.specificSelectionCount,
        selectedLotVersionIris,
        selectedLotVersionSetDigest: r.specificSelectionVersionSetDigest,
        selectionProbe: {
          digest: r.consumptionSelectionProbeDigest,
          payload: artifactPayload(
            state,
            r.consumptionSelectionProbeRef,
            r.consumptionSelectionProbeDigest,
            'ExecutionLotAllocationClosure.selectionProbe',
          ),
          ref: r.consumptionSelectionProbeRef,
        },
        specificSelection: r.specificSelectionRef === undefined
          ? null
          : {
            digest: r.specificSelectionDigest,
            payload: artifactPayload(
              state,
              r.specificSelectionRef,
              r.specificSelectionDigest,
              'ExecutionLotAllocationClosure.specificSelection',
            ),
            ref: r.specificSelectionRef,
          },
        temporal,
        versionIri: r.versionIri,
      };
    }
    case 'PositionLotStateClosureContract': {
      const snapshot = oneRecord(
        byVersion,
        r.closedPositionSnapshot,
        TYPES.PositionSnapshot,
        'PositionLotStateClosure.closedPositionSnapshot',
      );
      const definition = oneRecord(
        byVersion,
        r.stateCostBasisDefinition,
        TYPES.CostBasisCalculationDefinition,
        'PositionLotStateClosure.stateCostBasisDefinition',
      );
      const listing = oneRecord(
        byVersion,
        r.stateListing,
        TYPES.InstrumentListing,
        'PositionLotStateClosure.stateListing',
      );
      const allLots = [...byVersion.values()]
        .filter((row) => row.typeIri === TYPES.PositionLot)
        .map((lot) => {
          const original = decodeQuantity(
            lot.originalQuantity,
            'PositionLotStateClosure.PositionLot.originalQuantity',
          );
          const basis = decodeMoney(
            lot.openingCostBasis,
            'PositionLotStateClosure.PositionLot.openingCostBasis',
          );
          const openingExecution = oneRecord(
            byVersion,
            lot.openingExecution,
            TYPES.Execution,
            'PositionLotStateClosure.PositionLot.openingExecution',
          );
          const openingExecutionQuantity = decodeQuantity(
            openingExecution.executionQuantity,
            'PositionLotStateClosure.openingExecution.executionQuantity',
          );
          return {
            accountIri: lot.lotInAccount,
            basisCurrency: basis.currency,
            calculationContextRef: lot.calculationContextRef,
            definitionVersionIri: lot.costBasisDefinition,
            instrumentIri: lot.lotForInstrument,
            listingVersionIri: lot.lotAtListing,
            openingCostBasisMicros: basis.micros,
            openingExecutionAccountIri: openingExecution.executionAccount,
            openingExecutionInstrumentIri: openingExecution.executionInstrument,
            openingExecutionListingVersionIri: openingExecution.executionListing,
            openingExecutionQuantityMicros: openingExecutionQuantity.micros,
            openingExecutionQuantityUnit: openingExecutionQuantity.unit,
            openingExecutionSide: decodeCode(
              openingExecution.orderSide,
              `${ORDERS}OrderSide`,
              'PositionLotStateClosure.openingExecution.orderSide',
            ),
            openingExecutionVersionIri: openingExecution.versionIri,
            originalQuantityMicros: original.micros,
            quantityUnit: original.unit,
            quotationVersionIri: lot.lotQuotationContract,
            temporal: temporalToLegacy(lot),
            versionIri: lot.versionIri,
          };
        });
      const allAllocations = [...byVersion.values()]
        .filter((row) => row.typeIri === TYPES.PositionLotAllocation)
        .map((allocation) => {
          const allocated = decodeQuantity(
            allocation.allocatedQuantity,
            'PositionLotStateClosure.PositionLotAllocation.allocatedQuantity',
          );
          return {
            calculationContextRef: allocation.calculationContextRef,
            definitionVersionIri: allocation.allocationCostBasisDefinition,
            executionVersionIri: allocation.allocationExecution,
            kind: decodeCode(
              allocation.lotAllocationKind,
              `${PORTFOLIO}PositionLotAllocationKind`,
              'PositionLotStateClosure.PositionLotAllocation.kind',
            ),
            lotVersionIri: allocation.allocatedLot,
            quantityMicros: allocated.micros,
            quantityUnit: allocated.unit,
            temporal: temporalToLegacy(allocation),
            versionIri: allocation.versionIri,
          };
        });
      const allExecutionClosures = [...byVersion.values()]
        .filter((row) => row.typeIri === TYPES.ExecutionLotAllocationClosure)
        .map((closure) => ({
          allocationVersionIris: structuredClone(closure.closureAllocation || []),
          allocationVersionSetDigest: closure.allocationVersionSetDigest,
          definitionVersionIri: closure.closureCostBasisDefinition,
          executionVersionIri: closure.closureExecution,
          temporal: temporalToLegacy(closure),
          versionIri: closure.versionIri,
        }));
      const remainingBasis = decodeMoney(
        r.remainingCostBasis,
        'PositionLotStateClosure.remainingCostBasis',
      );
      const snapshotQuantity = decodeQuantity(
        snapshot.positionQuantity,
        'PositionLotStateClosure.positionQuantity',
      );
      const openLotVersionIris = structuredClone(r.openLot || []);
      const allocationVersionIris = structuredClone(r.stateAllocation || []);
      const executionClosureVersionIris = structuredClone(
        r.stateExecutionClosure || [],
      );
      return {
        accountIri: r.stateAccount,
        allocationProbe: {
          digest: r.stateAllocationClosureProbeDigest,
          payload: artifactPayload(
            state,
            r.stateAllocationClosureProbeRef,
            r.stateAllocationClosureProbeDigest,
            'PositionLotStateClosure.allocationProbe',
          ),
          ref: r.stateAllocationClosureProbeRef,
        },
        allocationVersionIris,
        allocationVersionSetDigest: r.stateAllocationVersionSetDigest,
        allAllocations,
        allExecutionClosures,
        allLots,
        basisCurrency: remainingBasis.currency,
        calculationContextRef: r.calculationContextRef,
        costBasisDefinition: {
          artifacts: {
            implementation: artifactByDigest(
              state,
              definition.implementationDigest,
              'PositionLotStateClosure.definition.implementation',
            ),
            inputContract: artifactByDigest(
              state,
              definition.inputContractDigest,
              'PositionLotStateClosure.definition.inputContract',
            ),
            outputContract: artifactByDigest(
              state,
              definition.outputContractDigest,
              'PositionLotStateClosure.definition.outputContract',
            ),
            runtime: artifactByDigest(
              state,
              definition.runtimeDigest,
              'PositionLotStateClosure.definition.runtime',
            ),
            toolLock: {
              digest: definition.toolLockDigest,
              payload: artifactPayload(
                state,
                definition.toolLockRef,
                definition.toolLockDigest,
                'PositionLotStateClosure.definition.toolLock',
              ),
              ref: definition.toolLockRef,
            },
          },
          basisCurrency: currencyLexical(
            definition.costBasisDefinitionBasisCurrency,
            'PositionLotStateClosure.costBasisDefinitionBasisCurrency',
          ),
          precisionPolicy: {
            digest: definition.precisionPolicyDigest,
            payload: artifactPayload(state, definition.precisionPolicyRef, definition.precisionPolicyDigest, 'PositionLotStateClosure.precisionPolicy'),
            ref: definition.precisionPolicyRef,
          },
          roundingPolicy: {
            digest: definition.roundingPolicyDigest,
            payload: artifactPayload(state, definition.roundingPolicyRef, definition.roundingPolicyDigest, 'PositionLotStateClosure.roundingPolicy'),
            ref: definition.roundingPolicyRef,
          },
          versionIri: definition.versionIri,
        },
        executionClosureVersionIris,
        executionClosureVersionSetDigest: r.stateExecutionClosureVersionSetDigest,
        generatingContextRef: r.generatingContextRef,
        inputContext: {
          digest: r.inputContextRecordDigest,
          payload: artifactPayload(
            state,
            r.inputContextRef,
            r.inputContextRecordDigest,
            'PositionLotStateClosure.inputContext',
          ),
          ref: r.inputContextRef,
        },
        instrumentIri: r.stateInstrument,
        listingInstrumentIri: listing.listedInstrument,
        listingTemporal: temporalToLegacy(listing),
        listingVersionIri: listing.versionIri,
        lotProbe: {
          digest: r.lotClosureProbeDigest,
          payload: artifactPayload(
            state,
            r.lotClosureProbeRef,
            r.lotClosureProbeDigest,
            'PositionLotStateClosure.lotProbe',
          ),
          ref: r.lotClosureProbeRef,
        },
        openLotCount: openLotVersionIris.length,
        openLotVersionIris,
        openLotVersionSetDigest: r.openLotVersionSetDigest,
        pitRequest: decodedPitRequest(
          state,
          r.pitRequestRef,
          r.pitRequestRecordDigest,
          'PositionLotStateClosure.pitRequest',
        ),
        quantityUnit: snapshotQuantity.unit,
        quotationVersionIri: r.stateQuotationContract,
        remainingCostBasisMicros: remainingBasis.micros,
        remainingQuantityMicros: snapshotQuantity.micros,
        snapshotAccountIri: snapshot.positionAccount,
        snapshotInstrumentIri: snapshot.positionInstrument,
        snapshotListingVersionIri: snapshot.positionListing,
        snapshotPivotRef: r.snapshotPivotRef,
        snapshotSourceKind: decodeCode(
          snapshot.positionSourceKind,
          `${PORTFOLIO}PositionSourceKind`,
          'PositionLotStateClosure.snapshotSourceKind',
        ),
        snapshotVersionIri: snapshot.versionIri,
        sourceScopeRef: r.source,
        temporal,
        versionIri: r.versionIri,
      };
    }
    case 'UnrealizedPnLObservationContract': {
      const valuation = oneRecord(
        byVersion,
        r.pnlValuation,
        TYPES.PositionValuation,
        'UnrealizedPnLObservation.pnlValuation',
      );
      const lotState = oneRecord(
        byVersion,
        r.pnlLotStateClosure,
        TYPES.PositionLotStateClosure,
        'UnrealizedPnLObservation.pnlLotStateClosure',
      );
      const valuationHeader = oneRecord(
        byVersion,
        valuation.valuationHeader,
        TYPES.PortfolioValuation,
        'UnrealizedPnLObservation.valuationHeader',
      );
      const valuationDefinition = oneRecord(
        byVersion,
        valuationHeader.valuationDefinition,
        TYPES.ValuationCalculationDefinition,
        'UnrealizedPnLObservation.valuationDefinition',
      );
      const valuationPrice = oneRecord(
        byVersion,
        valuation.valuationPrice,
        TYPES.PriceObservation,
        'UnrealizedPnLObservation.valuationPrice',
      );
      const stateSnapshot = oneRecord(
        byVersion,
        lotState.closedPositionSnapshot,
        TYPES.PositionSnapshot,
        'UnrealizedPnLObservation.stateSnapshot',
      );
      const stateDefinition = oneRecord(
        byVersion,
        lotState.stateCostBasisDefinition,
        TYPES.CostBasisCalculationDefinition,
        'UnrealizedPnLObservation.stateDefinition',
      );
      const stateQuotation = oneRecord(
        byVersion,
        lotState.stateQuotationContract,
        TYPES.DirectUnitPriceQuotationContract,
        'UnrealizedPnLObservation.stateQuotation',
      );
      const valuationQuotationRecords = (
        valuationDefinition.valuationDefinitionQuotationContract || []
      ).map((versionIri) => oneRecord(
        byVersion,
        versionIri,
        TYPES.DirectUnitPriceQuotationContract,
        'UnrealizedPnLObservation.valuationDefinitionQuotation',
      ));
      const valuationFxConversion = valuation.valuationFxConversion === undefined
        ? undefined
        : oneRecord(
          byVersion,
          valuation.valuationFxConversion,
          TYPES.FXConversion,
          'UnrealizedPnLObservation.valuationFxConversion',
        );
      const market = decodeMoney(
        r.marketValue,
        'UnrealizedPnLObservation.marketValue',
      );
      const basis = decodeMoney(
        r.remainingCostBasis,
        'UnrealizedPnLObservation.remainingCostBasis',
      );
      const pnl = decodeMoney(
        r.unrealizedPnl,
        'UnrealizedPnLObservation.unrealizedPnl',
      );
      const valuationMarket = decodeMoney(
        valuation.marketValue,
        'UnrealizedPnLObservation.valuation.marketValue',
      );
      const stateBasis = decodeMoney(
        lotState.remainingCostBasis,
        'UnrealizedPnLObservation.state.remainingCostBasis',
      );
      const priceValue = decodeMoney(
        valuationPrice.priceValue,
        'UnrealizedPnLObservation.valuation.priceValue',
      );
      return {
        calculationContextRef: r.calculationContextRef,
        closedSnapshotVersionIri: lotState.closedPositionSnapshot,
        conversionContext: {
          digest: r.conversionContextDigest,
          payload: artifactPayload(
            state,
            r.conversionContextRef,
            r.conversionContextDigest,
            'UnrealizedPnLObservation.conversionContext',
          ),
          ref: r.conversionContextRef,
        },
        currency: pnl.currency,
        generatingContextRef: r.generatingContextRef,
        // The authoring adapter uses one input temporal pivot when it rebuilds
        // the nested lot-state, valuation definition, valuation header, price,
        // and position valuation selected by the PnL materialization.  Preserve
        // that pivot on decode; falling back to the later PnL output temporal
        // makes an otherwise valid canonical document fail its own PIT replay
        // during decode -> encode round-tripping.
        inputTemporal: temporalToLegacy(valuationHeader),
        lotState: versionRef(r.pnlLotStateClosure),
        marketValueCurrency: market.currency,
        marketValueMicros: market.micros,
        openLotVersionSetDigest: r.openLotVersionSetDigest,
        pnlCostBasisDefinitionVersionIri: r.pnlCostBasisDefinition,
        ...(r.pnlFxConversion === undefined ? {} : {
          pnlFxConversionVersionIri: r.pnlFxConversion,
        }),
        pnlQuotationVersionIri: r.pnlQuotationContract,
        remainingCostBasisCurrency: basis.currency,
        remainingCostBasisMicros: basis.micros,
        stateAllocationVersionSetDigest: r.stateAllocationVersionSetDigest,
        stateBasisCurrency: currencyLexical(
          stateDefinition.costBasisDefinitionBasisCurrency,
          'UnrealizedPnLObservation.stateDefinition.basisCurrency',
        ),
        stateCalculationContextRef: lotState.calculationContextRef,
        stateCostBasisDefinitionVersionIri: lotState.stateCostBasisDefinition,
        stateDefinitionTemporal: temporalToLegacy(stateDefinition),
        stateExecutionClosureVersionSetDigest:
          r.stateExecutionClosureVersionSetDigest,
        stateGeneratingContextRef: lotState.generatingContextRef,
        stateOpenLotVersionSetDigest: lotState.openLotVersionSetDigest,
        stateQuotationVersionIri: lotState.stateQuotationContract,
        stateQuotationTemporal: temporalToLegacy(stateQuotation),
        stateRemainingCostBasisMicros: stateBasis.micros,
        stateStateAllocationVersionSetDigest:
          lotState.stateAllocationVersionSetDigest,
        stateStateExecutionClosureVersionSetDigest:
          lotState.stateExecutionClosureVersionSetDigest,
        stateSnapshotTemporal: temporalToLegacy(stateSnapshot),
        stateTemporal: temporalToLegacy(lotState),
        sourceScopeRef: r.source,
        temporal,
        unrealizedPnlMicros: pnl.micros,
        valuation: versionRef(r.pnlValuation),
        valuationDefinitionQuotationVersionIris: structuredClone(
          valuationDefinition.valuationDefinitionQuotationContract || [],
        ),
        valuationDefinitionQuotationRecords: valuationQuotationRecords.map(
          (record) => ({
            temporal: temporalToLegacy(record),
            versionIri: record.versionIri,
          }),
        ),
        valuationDefinitionTemporal: temporalToLegacy(valuationDefinition),
        valuationDefinitionVersionIri: valuationDefinition.versionIri,
        valuationFxConversionVersionIri: valuation.valuationFxConversion,
        ...(valuationFxConversion === undefined ? {} : {
          valuationFxConversionTemporal: temporalToLegacy(valuationFxConversion),
        }),
        valuationGeneratingContextRef: valuationHeader.generatingContextRef,
        valuationHeaderTemporal: temporalToLegacy(valuationHeader),
        valuationHeaderVersionIri: valuationHeader.versionIri,
        valuationHeaderConversionContext: {
          digest: valuationHeader.conversionContextDigest,
          payload: artifactPayload(
            state,
            valuationHeader.conversionContextRef,
            valuationHeader.conversionContextDigest,
            'UnrealizedPnLObservation.valuationHeader.conversionContext',
          ),
          ref: valuationHeader.conversionContextRef,
        },
        valuationInputContext: {
          digest: valuationHeader.inputContextRecordDigest,
          payload: artifactPayload(
            state,
            valuationHeader.inputContextRef,
            valuationHeader.inputContextRecordDigest,
            'UnrealizedPnLObservation.valuationHeader.inputContext',
          ),
          ref: valuationHeader.inputContextRef,
        },
        valuationMarketValueCurrency: valuationMarket.currency,
        valuationMarketValueMicros: valuationMarket.micros,
        valuationPitRequest: decodedPitRequest(
          state,
          valuationHeader.pitRequestRef,
          valuationHeader.pitRequestRecordDigest,
          'UnrealizedPnLObservation.valuationHeader.pitRequest',
        ),
        valuationPriceCurrency: priceValue.currency,
        valuationPriceQuotationVersionIri: valuationPrice.quotationContract,
        valuationPriceTemporal: temporalToLegacy(valuationPrice),
        valuationPriceVersionIri: valuationPrice.versionIri,
        valuationReportingCurrency: currencyLexical(
          valuationHeader.reportingCurrency,
          'UnrealizedPnLObservation.valuationReportingCurrency',
        ),
        valuationSnapshotVersionIri:
          valuation.valuedPositionSnapshot || valuation.valuedHoldingSnapshot,
        valuationTemporal: temporalToLegacy(valuation),
        versionIri: r.versionIri,
      };
    }
    case 'ExternalCostBasisObservationContract': {
      const amount = decodeMoney(
        r.externalCostBasis,
        'ExternalCostBasisObservation.externalCostBasis',
      );
      const definition = oneRecord(
        byVersion,
        r.externalBasisDefinition,
        TYPES.CostBasisCalculationDefinition,
        'ExternalCostBasisObservation.externalBasisDefinition',
      );
      const listing = r.externalBasisListing
        ? oneRecord(
          byVersion,
          r.externalBasisListing,
          TYPES.InstrumentListing,
          'ExternalCostBasisObservation.externalBasisListing',
        )
        : null;
      return {
        account: logicalRef(r.externalBasisAccount),
        amountMicros: amount.micros,
        costBasisDefinitionVersionIri: definition.versionIri,
        currency: amount.currency,
        externalBasisId: r.externalBasisId,
        generatingContextRef: r.generatingContextRef,
        instrument: logicalRef(r.externalBasisInstrument),
        observationStream: logicalRef(r.externalBasisObservationStream),
        listingInstrumentVersionIri: listing?.listedInstrument,
        listingTemporal: listing ? temporalToLegacy(listing) : null,
        listingVersionIri: listing?.versionIri,
        overwritesDerivedState: false,
        sourceEvidence: evidenceToLegacy(r, state),
        sourceScopeRef: r.source,
        temporal,
        versionIri: r.versionIri,
      };
    }
    case 'PortfolioPositionReconciliationFindingContract': {
      const decodeNested = (versionIri, validatorId) => (
        decodeCanonicalOrdersPortfolioScenario(
          { ...document, focusVersionIri: versionIri },
          validatorId,
          inputContract,
        )
      );
      const locked = (ref, digestValue, label) => ({
        digest: digestValue,
        payload: artifactPayload(
          state,
          ref,
          digestValue,
          label,
        ),
        ref,
      });
      const result = {
        candidateRecords: [],
        candidateGraph: locked(
          r.reconciliationCandidateGraphRef,
          r.reconciliationCandidateGraphDigest,
          'PortfolioPositionReconciliationFinding.candidateGraph',
        ),
        candidateGraphRecordCount:
          r.reconciliationCandidateGraphRecordCount,
        closureProbe: locked(
          r.reconciliationClosureProbeRef,
          r.reconciliationClosureProbeDigest,
          'PortfolioPositionReconciliationFinding.closureProbe',
        ),
        derivedCandidateCount: r.reconciliationDerivedCandidateCount,
        derivedCandidateVersionSetDigest:
          r.reconciliationDerivedCandidateVersionSetDigest,
        derivedOutputManifest: locked(
          r.reconciliationDerivedOutputManifestRef,
          r.reconciliationDerivedOutputManifestDigest,
          'PortfolioPositionReconciliationFinding.derivedOutputManifest',
        ),
        derivedSourceScopeRef: r.reconciliationDerivedSourceScopeRef,
        externalCandidateCount: r.reconciliationExternalCandidateCount,
        externalCandidateVersionSetDigest:
          r.reconciliationExternalCandidateVersionSetDigest,
        externalSnapshotManifest: locked(
          r.reconciliationExternalSnapshotManifestRef,
          r.reconciliationExternalSnapshotManifestDigest,
          'PortfolioPositionReconciliationFinding.externalSnapshotManifest',
        ),
        externalSourceScopeRef: r.reconciliationExternalSourceScopeRef,
        generatingContextRef: r.generatingContextRef,
        inputContext: locked(
          r.inputContextRef,
          r.inputContextRecordDigest,
          'PortfolioPositionReconciliationFinding.inputContext',
        ),
        kind: decodeCode(
          r.portfolioReconciliationKind,
          `${PORTFOLIO}PortfolioReconciliationKind`,
          'PortfolioPositionReconciliationFinding.kind',
        ),
        pitRequest: locked(
          r.pitRequestRef,
          r.pitRequestRecordDigest,
          'PortfolioPositionReconciliationFinding.pitRequest',
        ),
        reconciliationContext: locked(
          r.reconciliationContextRef,
          r.reconciliationContextDigest,
          'PortfolioPositionReconciliationFinding.reconciliationContext',
        ),
        queryDefinition: locked(
          r.reconciliationQueryDefinitionRef,
          r.reconciliationQueryDefinitionDigest,
          'PortfolioPositionReconciliationFinding.queryDefinition',
        ),
        queryToolLock: locked(
          r.reconciliationQueryToolLockRef,
          r.reconciliationQueryToolLockDigest,
          'PortfolioPositionReconciliationFinding.queryToolLock',
        ),
        subjectDigest: r.reconciliationSubjectDigest,
        temporal,
        versionIri: r.versionIri,
      };
      if (r.comparedExternalSnapshot) {
        result.externalHoldingSnapshot = decodeNested(
          r.comparedExternalSnapshot,
          'HoldingSnapshotContract',
        );
        result.externalSnapshot = versionRef(r.comparedExternalSnapshot);
      }
      if (r.comparedExternalPositionSnapshot) {
        result.externalPositionSnapshot = decodeNested(
          r.comparedExternalPositionSnapshot,
          'PositionSnapshotContract',
        );
        result.externalPosition = versionRef(
          r.comparedExternalPositionSnapshot,
        );
      }
      if (r.comparedDerivedSnapshot) {
        result.derivedSnapshotDetails = decodeNested(
          r.comparedDerivedSnapshot,
          'PositionSnapshotContract',
        );
        result.derivedSnapshot = versionRef(r.comparedDerivedSnapshot);
      }
      if (r.comparedExternalBasis) {
        result.externalBasisDetails = decodeNested(
          r.comparedExternalBasis,
          'ExternalCostBasisObservationContract',
        );
        result.externalBasis = versionRef(r.comparedExternalBasis);
      }
      if (r.comparedLotStateClosure) {
        result.lotStateDetails = decodeNested(
          r.comparedLotStateClosure,
          'PositionLotStateClosureContract',
        );
        result.lotState = versionRef(r.comparedLotStateClosure);
      }
      const candidateDefinitions = new Map([
        [TYPES.HoldingSnapshot, [
          'HoldingSnapshot',
          'HoldingSnapshotContract',
        ]],
        [TYPES.PositionSnapshot, [
          'PositionSnapshot',
          'PositionSnapshotContract',
        ]],
        [TYPES.ExternalCostBasisObservation, [
          'ExternalCostBasisObservation',
          'ExternalCostBasisObservationContract',
        ]],
        [TYPES.PositionLotStateClosure, [
          'PositionLotStateClosure',
          'PositionLotStateClosureContract',
        ]],
      ]);
      result.candidateRecords = [...byVersion.values()]
        .filter((record) => candidateDefinitions.has(record.typeIri))
        .map((record) => {
          const [recordType, validatorId] = candidateDefinitions.get(
            record.typeIri,
          );
          return {
            ...decodeNested(record.versionIri, validatorId),
            recordDigest: sha256Jcs(record),
            recordType,
          };
        })
        .sort((left, right) => compareUtf8(
          left.versionIri,
          right.versionIri,
        ));
      const externalManifest = result.externalSnapshotManifest.payload;
      result.externalSourceContract = locked(
        externalManifest.sourceContractRef,
        externalManifest.sourceContractDigest,
        'PortfolioPositionReconciliationFinding.externalSourceContract',
      );
      result.externalSnapshotPages = (externalManifest.pages || []).map(
        (page, index) => locked(
          page.pageRef,
          page.pageDigest,
          `PortfolioPositionReconciliationFinding.externalSnapshotPages[${index}]`,
        ),
      );
      return result;
    }
    default: fail('orders-portfolio-canonical-evaluator', evaluatorId);
  }
}

module.exports = {
  CanonicalOrdersPortfolioRecordError,
  REFERENCE_REGISTRY_DIGEST,
  TARGET_TYPE_BY_EVALUATOR,
  TYPES,
  decodeCanonicalOrdersPortfolioScenario,
  encodeCanonicalOrdersPortfolioScenario,
  validateCanonicalDocument,
};
