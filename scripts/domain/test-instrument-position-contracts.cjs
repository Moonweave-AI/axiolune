#!/usr/bin/env node
/**
 * Targeted executable checks for the M2 v0.3 listing-currency and PositionLot
 * contracts. This is deliberately separate from test-all-domain.js until the
 * shared M3 v0.6 typed-container/compiler migration is complete.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const yaml = require('js-yaml');
const {
  costBasisDirectUnitValueRaw,
  isCostBasisPrecisionPolicy,
  isCostBasisRoundingPolicy,
  quantizeRational,
} = require('./lib/orders-portfolio-exact-arithmetic.cjs');
const {
  verifyReviewedNoAlignments,
} = require('./lib/reviewed-no-alignment.cjs');

const ROOT = path.join(__dirname, '..', '..');
const INSTRUMENTS = path.join(ROOT, 'ontology', 'domain', 'finance', 'instruments', 'module.yaml');
const PORTFOLIO = path.join(ROOT, 'ontology', 'domain', 'finance', 'portfolio-positions', 'module.yaml');
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'm2', 'fixtures');
const IRI = /^https?:\/\/[^\s]+$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

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

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function elementMap(doc) {
  const domain = doc.domain || {};
  const typedMaps = [
    'objectTypes',
    'associationTypes',
    'relationTypes',
    'attributeTypes',
    'identifierTypes',
    'codeLists',
    'constraints',
  ];
  const out = {};
  let typed = false;
  for (const name of typedMaps) {
    if (domain[name] && typeof domain[name] === 'object' && !Array.isArray(domain[name])) {
      Object.assign(out, domain[name]);
      typed = true;
    }
  }
  if (!typed) {
    for (const [name, value] of Object.entries(domain)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && value.iri) out[name] = value;
    }
  }
  return out;
}

function useName(use) {
  return use.attribute || use.relation || use.roleName || use.id || '';
}

function exactCardinality(value, min, max) {
  return value && value.minCount === min && value.maxCount === max;
}

function validateModuleContracts() {
  const instruments = loadYaml(INSTRUMENTS);
  const instrumentElements = elementMap(instruments);
  const quoteCurrency = instrumentElements.listingQuoteCurrency;
  const listing = instrumentElements.InstrumentListing;
  const instrumentAlignments = Object.values(instrumentElements).flatMap(
    (element) => element.alignments || []
  );
  const noAlignment = verifyReviewedNoAlignments({ rootDir: ROOT });
  const noAlignmentEvidence = new Map(
    (noAlignment.evidence && noAlignment.evidence.decisions || []).map((row) => [row.decisionId, row])
  );
  const requiredInstrumentDecisions = [
    'instruments-financial-instrument-fibo-financial-instrument',
    'instruments-security-fibo-security',
  ];
  if (
    noAlignment.ok &&
    instrumentAlignments.length === 0 &&
    requiredInstrumentDecisions.every((id) => {
      const row = noAlignmentEvidence.get(id);
      return row &&
        row.outcome === 'reviewed-no-alignment-semantic-mismatch' &&
        SHA256.test(row.decisionDigest || '') &&
        SHA256.test(row.localElementDigest || '') &&
        SHA256.test(row.sourceSelectionDigest || '') &&
        SHA256.test(row.selectedContentDigest || '') &&
        row.rejectedTriple && row.rejectedTriple.present === false;
    })
  ) {
    pass('MODULE-I0', 'FinancialInstrument/Security reviewed-no-alignment decisions replay exact local, FIBO, lock, and OWL evidence');
  } else {
    fail(
      'MODULE-I0',
      `reviewed-no-alignment evidence failed: ${noAlignment.errors.join('; ') || 'required decision evidence absent'}`
    );
  }

  if (
    quoteCurrency &&
    quoteCurrency.iri === 'https://axiolune.ai/ontology/finance/instruments/listingQuoteCurrency' &&
    quoteCurrency.domain === 'https://axiolune.ai/ontology/finance/instruments/InstrumentListing' &&
    quoteCurrency.range === 'https://axiolune.ai/ontology/finance/foundation/Currency' &&
    Array.isArray(quoteCurrency.characteristics) &&
    quoteCurrency.characteristics.includes('functional')
  ) {
    pass('MODULE-I1', 'listingQuoteCurrency is a functional Listing-to-Currency RelationType');
  } else {
    fail('MODULE-I1', 'listingQuoteCurrency RelationType/range/functionality is incomplete');
  }

  const listingAttrUses = new Map((listing && listing.attributeUses || []).map((u) => [u.attribute, u]));
  const listingAttrs = new Set(listingAttrUses.keys());
  const listingPatterns = new Set((listing && listing.patternBindings || []).map((b) => b.pattern || b));
  const listingSourceAttrs = [
    'sourceArtifactRef',
    'sourceArtifactDigest',
    'sourceLocator',
  ].every((name) => exactCardinality(
    listingAttrUses.get(`https://axiolune.ai/ontology/meta/data-binding/attributes/${name}`),
    1,
    1
  ));
  if (
    listing &&
    !listingAttrs.has('https://axiolune.ai/ontology/finance/instruments/hasDenominatedCurrency') &&
    !listingAttrs.has('https://axiolune.ai/ontology/finance/instruments/hasTickSize') &&
    !listingAttrs.has('https://axiolune.ai/ontology/finance/instruments/hasLotSize') &&
    !instrumentElements.hasTickSize &&
    !instrumentElements.hasLotSize &&
    listingSourceAttrs &&
    listingPatterns.has('https://axiolune.ai/ontology/meta/patterns/TemporalFact') &&
    listingPatterns.has('https://axiolune.ai/ontology/meta/patterns/ProvenancedFact')
  ) {
    pass('MODULE-I2', 'listing separates quote/denomination, locks source bytes, and delegates tick/lot schedules');
  } else {
    fail('MODULE-I2', 'listing still duplicates currency/tick/lot truth or lacks temporal provenance');
  }

  const relationUses = instruments.domain && instruments.domain.relationUses;
  const quoteUse = Array.isArray(relationUses)
    ? relationUses.find((u) =>
        u.relation === quoteCurrency.iri &&
        u.subjectType === quoteCurrency.domain &&
        u.objectType === quoteCurrency.range)
    : null;
  const quoteUseConstraints = (quoteUse && quoteUse.constraints) || [];
  const logicalReferenceCount = quoteUseConstraints.filter(
    (binding) =>
      binding.constraintRef ===
      'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference'
  ).length;
  const exactVersionReferenceCount = quoteUseConstraints.filter(
    (binding) =>
      binding.constraintRef ===
      'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference'
  ).length;
  if (
    quoteUse &&
    exactCardinality(quoteUse.outboundCardinality, 1, 1) &&
    logicalReferenceCount === 1 &&
    exactVersionReferenceCount === 0
  ) {
    pass('MODULE-I3', 'typed RelationUse requires exactly one logical quote Currency per listing');
  } else {
    pend(
      'MODULE-I3',
      'exactly-one LogicalReference RelationUse awaits the shared M3 v0.6 typed-container migration; fixture enforcement is active'
    );
  }

  const portfolio = loadYaml(PORTFOLIO);
  const portfolioElements = elementMap(portfolio);
  const portfolioAlignments = Object.values(portfolioElements).flatMap(
    (element) => element.alignments || []
  );
  const portfolioDecision = noAlignmentEvidence.get('portfolio-portfolio-fibo-portfolio');
  if (
    noAlignment.ok &&
    portfolioAlignments.length === 0 &&
    portfolioDecision &&
    portfolioDecision.outcome === 'reviewed-no-alignment-semantic-mismatch' &&
    SHA256.test(portfolioDecision.decisionDigest || '') &&
    SHA256.test(portfolioDecision.localElementDigest || '') &&
    SHA256.test(portfolioDecision.sourceSelectionDigest || '') &&
    SHA256.test(portfolioDecision.selectedContentDigest || '') &&
    portfolioDecision.rejectedTriple && portfolioDecision.rejectedTriple.present === false
  ) {
    pass('MODULE-PP0', 'Portfolio reviewed-no-alignment decision replays exact local, FIBO, lock, and OWL evidence');
  } else {
    fail(
      'MODULE-PP0',
      `reviewed-no-alignment evidence failed: ${noAlignment.errors.join('; ') || 'Portfolio decision evidence absent'}`
    );
  }
  const lot = portfolioElements.PositionLot;
  const discriminator = portfolioElements.lotDiscriminator;
  const roles = new Map((lot && lot.participantRoles || []).map((r) => [r.roleName || r.id, r]));
  const attrs = new Map((lot && lot.attributeUses || []).map((u) => [u.attribute, u]));
  const lotPatterns = new Set((lot && lot.patternBindings || []).map((b) => b.pattern || b));
  const requiredRoles = [
    ['lotInAccount', 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount', 1, 1],
    ['lotForInstrument', 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument', 1, 1],
    ['lotAtListing', 'https://axiolune.ai/ontology/finance/instruments/InstrumentListing', 0, 1],
    ['openingExecution', 'https://axiolune.ai/ontology/finance/orders-execution/Execution', 1, 1],
    [
      'costBasisDefinition',
      'https://axiolune.ai/ontology/finance/portfolio-positions/CostBasisCalculationDefinition',
      1,
      1,
    ],
  ];
  const rolesOk = requiredRoles.every(([name, range, min, max]) => {
    const role = roles.get(name);
    return role && role.range === range && role.minCount === min && role.maxCount === max;
  });
  const requiredAttrs = [
    'lotDiscriminator',
    'originalQuantity',
    'openingGross',
    'openingCostBasis',
    'calculationContextRef',
  ].map((name) => `https://axiolune.ai/ontology/finance/portfolio-positions/${name}`);
  requiredAttrs.push(
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator'
  );
  const attrsOk = requiredAttrs.every((iri) => exactCardinality(attrs.get(iri), 1, 1));
  const forbiddenAttrs = [
    'hasQuantity',
    'hasCostBasis',
    'hasPositionSide',
    'cost',
  ].map((name) => `https://axiolune.ai/ontology/finance/portfolio-positions/${name}`);
  const forbiddenAbsent = forbiddenAttrs.every((iri) => !attrs.has(iri));
  if (
    lot &&
    rolesOk &&
    attrsOk &&
    forbiddenAbsent &&
    lotPatterns.has('https://axiolune.ai/ontology/meta/patterns/TemporalFact') &&
    lotPatterns.has('https://axiolune.ai/ontology/meta/patterns/ProvenancedFact') &&
    discriminator &&
    discriminator.valueType === 'string' &&
    discriminator.pattern === '^openingRemainder$'
  ) {
    pass('MODULE-PP1', 'PositionLot has exact opening roles/fields and no duplicate quantity/cost/side truth');
  } else {
    fail('MODULE-PP1', 'PositionLot role, attribute, discriminator, or duplicate-truth contract is incomplete');
  }

  const imports = (portfolio.module && portfolio.module.imports) || [];
  const ordersImport = imports.find(
    (i) => i.moduleIri === 'https://axiolune.ai/ontology/finance/orders-execution'
  );
  const definition = portfolioElements.CostBasisCalculationDefinition;
  const definitionAttrs = new Map(
    (definition && definition.attributeUses || []).map((u) => [u.attribute, u])
  );
  const definitionPatterns = new Set(
    (definition && definition.patternBindings || []).map((b) => b.pattern || b)
  );
  const requiredDefinitionAttrs = [
    'https://axiolune.ai/ontology/finance/portfolio-positions/costBasisDefinitionId',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator',
  ].every((iri) => exactCardinality(definitionAttrs.get(iri), 1, 1));
  if (
    ordersImport &&
    SHA256.test(ordersImport.artifactDigest || '') &&
    definition &&
    requiredDefinitionAttrs &&
    definitionPatterns.has('https://axiolune.ai/ontology/meta/patterns/TemporalFact') &&
    definitionPatterns.has('https://axiolune.ai/ontology/meta/patterns/ProvenancedFact')
  ) {
    pass('MODULE-PP2', 'opening Execution dependency and versioned CostBasisCalculationDefinition are explicit');
  } else {
    fail('MODULE-PP2', 'orders import or CostBasisCalculationDefinition is incomplete');
  }

  const identityTest = childProcess.spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'domain', 'test-position-lot-identity.cjs')],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    }
  );
  if (
    identityTest.status === 0 &&
    /PositionLot identity contract: PASS/.test(identityTest.stdout || '') &&
    !/PENDING|SKIP|UNVERIFIED/i.test(`${identityTest.stdout || ''}\n${identityTest.stderr || ''}`)
  ) {
    pass(
      'MODULE-PP3',
      'M3 v0.6 TargetIdentityContractDefinition compiles the exact PositionLot logical and standard version keys'
    );
  } else {
    fail(
      'MODULE-PP3',
      `TargetIdentityContract execution failed (exit=${String(identityTest.status)}): `
        + `${String(identityTest.stderr || identityTest.stdout || '').trim()}`
    );
  }
}

function isEligible(version, pivot) {
  if (!pivot) return true;
  const axes = [
    ['validFrom', 'validTo', 'asOfValid'],
    ['knowledgeFrom', 'knowledgeTo', 'asOfKnowledge'],
    ['availableFrom', 'availableTo', 'asOfAvailable'],
  ];
  for (const [fromKey, toKey, pivotKey] of axes) {
    const at = Date.parse(pivot[pivotKey]);
    const from = Date.parse(version[fromKey]);
    const to = version[toKey] == null ? null : Date.parse(version[toKey]);
    if (!Number.isFinite(at) || !Number.isFinite(from) || at < from || (to != null && at >= to)) return false;
  }
  return true;
}

function sourceClosureOk(source) {
  if (!source || !IRI.test(source.artifactRef || '') || !SHA256.test(source.artifactDigest || '')) return false;
  const locator = source.locator;
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return false;
  const common = [
    'kind',
    'path',
    'mediaType',
    'extractorProfileRef',
    'extractorProfileDigest',
    'selectionDigest',
  ];
  if (
    typeof locator.path !== 'string' ||
    locator.path.length === 0 ||
    locator.path !== locator.path.normalize('NFC') ||
    locator.path.startsWith('/') ||
    locator.path.includes('\\') ||
    typeof locator.mediaType !== 'string' ||
    locator.mediaType.length === 0 ||
    !IRI.test(locator.extractorProfileRef || '') ||
    !SHA256.test(locator.extractorProfileDigest || '') ||
    !SHA256.test(locator.selectionDigest || '')
  ) {
    return false;
  }
  const variants = {
    wholeFile: [],
    textLineRange: ['startLine', 'endLine'],
    pdfPageRange: ['startPage', 'endPage'],
    jsonPointer: ['pointer'],
  };
  const variantFields = variants[locator.kind];
  if (!variantFields) return false;
  const allowed = new Set([...common, ...variantFields]);
  if (Object.keys(locator).some((key) => !allowed.has(key))) return false;
  if (locator.kind === 'textLineRange') {
    if (
      !locator.mediaType.startsWith('text/') ||
      !Number.isSafeInteger(locator.startLine) ||
      !Number.isSafeInteger(locator.endLine) ||
      locator.startLine < 1 ||
      locator.startLine > locator.endLine
    ) {
      return false;
    }
  } else if (locator.kind === 'pdfPageRange') {
    if (
      locator.mediaType !== 'application/pdf' ||
      !Number.isSafeInteger(locator.startPage) ||
      !Number.isSafeInteger(locator.endPage) ||
      locator.startPage < 1 ||
      locator.startPage > locator.endPage
    ) {
      return false;
    }
  } else if (locator.kind === 'jsonPointer') {
    if (
      locator.mediaType !== 'application/json' ||
      typeof locator.pointer !== 'string' ||
      (locator.pointer !== '' && !locator.pointer.startsWith('/'))
    ) {
      return false;
    }
  }
  return true;
}

function listingViolation(testCase) {
  const versions = testCase.listingVersions || [];
  for (const version of versions) {
    if (!Array.isArray(version.listingQuoteCurrency) || version.listingQuoteCurrency.length !== 1) {
      return 'listingQuoteCurrency-cardinality';
    }
    const currency = version.listingQuoteCurrency[0];
    if (!IRI.test(currency)) return 'listingQuoteCurrency-not-iri';
    const matchingRegistry = (testCase.registryEntries || []).filter(
      (entry) => entry.currency === currency && entry.pitEligible === true
    );
    if (matchingRegistry.length !== 1) return 'listingQuoteCurrency-registry-closure';
    if (!sourceClosureOk(version.source)) return 'listingQuoteCurrency-source-closure';
  }

  const groups = new Map();
  for (const version of versions.filter((v) => isEligible(v, testCase.pivot))) {
    const group = groups.get(version.logicalIri) || [];
    group.push(version);
    groups.set(version.logicalIri, group);
  }
  for (const group of groups.values()) {
    const currencies = new Set(group.map((v) => v.listingQuoteCurrency[0]));
    if (group.length > 1 && currencies.size > 1) return 'listingQuoteCurrency-current-version-conflict';
  }

  for (const logicalIri of new Set(versions.map((v) => v.logicalIri))) {
    const chain = versions
      .filter((v) => v.logicalIri === logicalIri)
      .sort((a, b) => a.revision - b.revision);
    for (let i = 1; i < chain.length; i += 1) {
      if (
        chain[i].revision !== chain[i - 1].revision + 1 ||
        chain[i - 1].knowledgeTo !== chain[i].knowledgeFrom
      ) {
        return 'listingQuoteCurrency-revision-chain';
      }
    }
  }
  return null;
}

const DECIMAL_LEXICAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function exactDecimal(value) {
  if (typeof value !== 'string' || value !== value.trim() || !DECIMAL_LEXICAL.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, fractionalPart = ''] = unsigned.split('.');
  if (fractionalPart.length > 18) return null;
  let coefficient = BigInt(`${integerPart}${fractionalPart}`);
  if (negative) coefficient = -coefficient;
  return { coefficient, scale: fractionalPart.length };
}

function powerOfTen(scale) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 36) return null;
  return 10n ** BigInt(scale);
}

function alignedCoefficient(value, scale) {
  const factor = powerOfTen(scale - value.scale);
  return factor === null ? null : value.coefficient * factor;
}

function decimalCompare(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = alignedCoefficient(left, scale);
  const rightCoefficient = alignedCoefficient(right, scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function decimalEqual(left, right) {
  return decimalCompare(left, right) === 0;
}

function decimalAbs(value) {
  return value.coefficient < 0n
    ? { coefficient: -value.coefficient, scale: value.scale }
    : value;
}

function decimalToScaledInteger(value, scale) {
  if (!value || !Number.isSafeInteger(scale) || scale < value.scale || scale > 18) return null;
  return value.coefficient * powerOfTen(scale - value.scale);
}

function scaledIntegerToDecimal(value, scale) {
  return { coefficient: value, scale };
}

function canonicalJcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite canonical JSON number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJcs).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('non-canonical JSON value');
  }
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJcs(value[key])}`
  ).join(',')}}`;
}

function sha256Jcs(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJcs(value), 'utf8').digest('hex')}`;
}

function policyPayload(artifact, predicate) {
  if (
    !artifact ||
    !IRI.test(artifact.ref || '') ||
    !SHA256.test(artifact.digest || '') ||
    !artifact.payload ||
    artifact.digest !== sha256Jcs(artifact.payload) ||
    !predicate(artifact.payload)
  ) {
    return null;
  }
  return artifact.payload;
}

function exactStructuredDecimal(value, valueField, scaleField, requiredScale) {
  if (!value || value[scaleField] !== requiredScale) return null;
  const parsed = exactDecimal(value[valueField]);
  return parsed && decimalToScaledInteger(parsed, requiredScale) !== null ? parsed : null;
}

function temporalRecordEligible(record, pivot) {
  if (!record || !pivot) return false;
  for (const axis of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
    const recordAt = Date.parse(record[axis]);
    const pivotAt = Date.parse(pivot[axis]);
    if (!Number.isFinite(recordAt) || !Number.isFinite(pivotAt) || recordAt > pivotAt) return false;
  }
  return true;
}

function completedContextOk(context, expectedRef, knowledgePivot) {
  if (
    !context ||
    context.ref !== expectedRef ||
    !IRI.test(context.ref || '') ||
    !SHA256.test(context.digest || '') ||
    !context.payload ||
    context.digest !== sha256Jcs(context.payload) ||
    context.payload.status !== 'completed'
  ) {
    return false;
  }
  const completedAt = Date.parse(context.payload.completedAt);
  const pivot = Date.parse(knowledgePivot);
  return Number.isFinite(completedAt) && Number.isFinite(pivot) && completedAt <= pivot;
}

function exactFxOpeningGross(conversion, input, inputCurrency, outputCurrency, lot, policies) {
  if (!conversion) return { violation: 'openingGrossFxConversion-required' };
  if (
    !exactVersionIri(conversion.versionIri) ||
    !exactVersionIri(conversion.rateVersionIri) ||
    conversion.consumerKind !== 'openingLot' ||
    conversion.consumerVersionIri !== lot.versionIri ||
    lot.openingGrossFxConversionVersionIri !== conversion.versionIri
  ) {
    return { violation: 'openingGrossFxConversion-consumer-closure' };
  }
  const conversionRounding = policyPayload(conversion.roundingPolicy, isCostBasisRoundingPolicy);
  if (
    !conversionRounding ||
    conversion.roundingPolicy.ref !== lot.costBasisDefinitionRecord.roundingPolicy.ref ||
    conversion.roundingPolicy.digest !== lot.costBasisDefinitionRecord.roundingPolicy.digest ||
    canonicalJcs(conversionRounding) !== canonicalJcs(policies.rounding)
  ) {
    return { violation: 'openingGrossFxConversion-policy-closure' };
  }
  const rateObservation = conversion.rateObservation;
  if (
    !rateObservation ||
    !exactVersionIri(rateObservation.versionIri) ||
    rateObservation.versionIri !== conversion.rateVersionIri ||
    rateObservation.baseCurrency !== conversion.baseCurrency ||
    rateObservation.quoteCurrency !== conversion.quoteCurrency ||
    conversion.baseCurrency === conversion.quoteCurrency
  ) {
    return { violation: 'openingGrossFxConversion-rate-closure' };
  }
  if (!temporalRecordEligible(rateObservation, conversion) || !temporalRecordEligible(conversion, lot)) {
    return { violation: 'openingGrossFxConversion-pit' };
  }
  const rate = exactStructuredDecimal(
    rateObservation.rate,
    'amount',
    'precision',
    policies.precision.rateScale,
  );
  if (
    !rate ||
    rate.coefficient <= 0n ||
    rateObservation.rate.unit !== `urn:unit:${conversion.quoteCurrency}-per-${conversion.baseCurrency}`
  ) {
    return { violation: 'openingGrossFxConversion-rate-closure' };
  }
  if (
    !completedContextOk(conversion.inputContext, lot.calculationContextRef, conversion.knowledgeFrom) ||
    conversion.generatingContextRef !== lot.calculationContextRef
  ) {
    return { violation: 'openingGrossFxConversion-context-closure' };
  }
  const declaredInput = exactStructuredDecimal(
    conversion.inputMoney,
    'amount',
    'scale',
    policies.precision.amountScale,
  );
  const declaredOutput = exactStructuredDecimal(
    conversion.outputMoney,
    'amount',
    'scale',
    policies.rounding.outputScale,
  );
  if (
    !declaredInput ||
    !declaredOutput ||
    !decimalEqual(declaredInput, input) ||
    conversion.inputMoney.currency !== inputCurrency ||
    conversion.outputMoney.currency !== outputCurrency
  ) {
    return { violation: 'openingGrossFxConversion-money-closure' };
  }
  const inputRaw = decimalToScaledInteger(input, policies.precision.amountScale);
  const rateRaw = decimalToScaledInteger(rate, policies.precision.rateScale);
  const outputFactor = powerOfTen(policies.rounding.outputScale);
  const inputFactor = powerOfTen(policies.precision.amountScale);
  const rateFactor = powerOfTen(policies.precision.rateScale);
  let numerator;
  let denominator;
  if (conversion.direction === 'baseToQuote') {
    if (inputCurrency !== conversion.baseCurrency || outputCurrency !== conversion.quoteCurrency) {
      return { violation: 'openingGrossFxConversion-direction' };
    }
    numerator = inputRaw * rateRaw * outputFactor;
    denominator = inputFactor * rateFactor;
  } else if (conversion.direction === 'quoteToBase') {
    if (inputCurrency !== conversion.quoteCurrency || outputCurrency !== conversion.baseCurrency) {
      return { violation: 'openingGrossFxConversion-direction' };
    }
    numerator = inputRaw * rateFactor * outputFactor;
    denominator = inputFactor * rateRaw;
  } else {
    return { violation: 'openingGrossFxConversion-direction' };
  }
  const expected = scaledIntegerToDecimal(
    quantizeRational(numerator, denominator, policies.rounding.mode),
    policies.rounding.outputScale,
  );
  return decimalEqual(declaredOutput, expected)
    ? { value: declaredOutput }
    : { violation: 'openingGrossFxConversion-arithmetic' };
}

function positionLotOpeningViolation(lot) {
  if (!exactVersionIri(lot.lotAtListing) || !exactVersionIri(lot.lotQuotationContract)) {
    return 'positionLot-listing-quotation-exact-version';
  }
  const execution = lot.openingExecutionRecord;
  if (
    !execution ||
    execution.versionIri !== lot.openingExecution ||
    execution.logicalIri !== lot.openingExecutionLogicalIri ||
    execution.account !== lot.lotInAccount ||
    execution.instrument !== lot.lotForInstrument ||
    execution.listingVersionIri !== lot.lotAtListing ||
    execution.quotationContractVersionIri !== lot.lotQuotationContract ||
    !['Buy', 'Sell'].includes(execution.side) ||
    !temporalRecordEligible(execution, lot)
  ) {
    return 'openingExecution-record-closure';
  }
  const listing = lot.listingRecord;
  const quotation = lot.quotationRecord;
  if (
    !listing ||
    listing.versionIri !== lot.lotAtListing ||
    listing.instrument !== lot.lotForInstrument ||
    !/^[A-Z]{3}$/.test(listing.quoteCurrency || '') ||
    !temporalRecordEligible(listing, lot) ||
    !quotation ||
    quotation.versionIri !== lot.lotQuotationContract ||
    quotation.instrument !== lot.lotForInstrument ||
    quotation.listingVersionIri !== lot.lotAtListing ||
    quotation.quoteCurrency !== listing.quoteCurrency ||
    quotation.contractMultiplier !== '1' ||
    !temporalRecordEligible(quotation, lot)
  ) {
    return 'positionLot-listing-quotation-closure';
  }
  const definition = lot.costBasisDefinitionRecord;
  if (
    !definition ||
    definition.versionIri !== lot.costBasisDefinition ||
    definition.logicalIri !== lot.costBasisDefinitionLogicalIri ||
    definition.quotationContractVersionIri !== lot.lotQuotationContract ||
    definition.method !== 'executionAllocatedDirectUnitCost' ||
    !/^[A-Z]{3}$/.test(definition.basisCurrency || '') ||
    !temporalRecordEligible(definition, lot)
  ) {
    return 'costBasisDefinition-record-closure';
  }
  const precision = policyPayload(definition.precisionPolicy, isCostBasisPrecisionPolicy);
  const rounding = policyPayload(definition.roundingPolicy, isCostBasisRoundingPolicy);
  if (!precision || !rounding || precision.amountScale !== rounding.outputScale) {
    return 'costBasisDefinition-policy-closure';
  }
  if (!completedContextOk(lot.calculationContext, lot.calculationContextRef, lot.knowledgeFrom)) {
    return 'calculationContext-record-closure';
  }
  const original = exactStructuredDecimal(
    lot.originalQuantity,
    'amount',
    'precision',
    precision.quantityScale,
  );
  const executionQuantity = exactStructuredDecimal(
    execution.quantity,
    'amount',
    'precision',
    precision.quantityScale,
  );
  const executionPrice = exactStructuredDecimal(
    execution.price,
    'amount',
    'scale',
    precision.amountScale,
  );
  if (
    !original ||
    !executionQuantity ||
    !executionPrice ||
    executionQuantity.coefficient <= 0n ||
    executionPrice.coefficient < 0n ||
    !decimalEqual(decimalAbs(original), executionQuantity) ||
    (execution.side === 'Buy') !== (original.coefficient > 0n) ||
    execution.quantity.unit !== lot.originalQuantity.unit ||
    quotation.denominatorUnit !== execution.quantity.unit ||
    execution.price.currency !== quotation.quoteCurrency
  ) {
    return 'openingExecution-economic-join';
  }
  const rawGross = scaledIntegerToDecimal(
    costBasisDirectUnitValueRaw(
      decimalToScaledInteger(executionQuantity, precision.quantityScale),
      decimalToScaledInteger(executionPrice, precision.amountScale),
      precision,
      rounding,
    ),
    rounding.outputScale,
  );
  let expectedGross = rawGross;
  if (execution.price.currency === definition.basisCurrency) {
    if (lot.openingGrossFxConversion || lot.openingGrossFxConversionVersionIri) {
      return 'openingGrossFxConversion-forbidden';
    }
  } else {
    const fxResult = exactFxOpeningGross(
      lot.openingGrossFxConversion,
      rawGross,
      execution.price.currency,
      definition.basisCurrency,
      lot,
      { precision, rounding },
    );
    if (fxResult.violation) return fxResult.violation;
    expectedGross = fxResult.value;
  }
  const openingGross = exactStructuredDecimal(
    lot.openingGross,
    'amount',
    'scale',
    rounding.outputScale,
  );
  if (
    !openingGross ||
    lot.openingGross.currency !== definition.basisCurrency ||
    !decimalEqual(openingGross, expectedGross)
  ) {
    return 'openingGross-replay';
  }
  return null;
}

function exactVersionIri(value) {
  return IRI.test(value || '') && /\/version\/sha256-[^/]+$/.test(value);
}

function lotKey(lot) {
  return [
    lot.lotInAccount,
    lot.lotForInstrument,
    lot.openingExecutionLogicalIri,
    lot.costBasisDefinitionLogicalIri,
    lot.lotDiscriminator,
  ].join('\u001f');
}

function resolveFixtureMerges(value) {
  if (Array.isArray(value)) return value.map(resolveFixtureMerges);
  if (!value || typeof value !== 'object') return value;
  const merged = {};
  const inherited = value['<<'];
  const parents = inherited === undefined ? [] : Array.isArray(inherited) ? inherited : [inherited];
  for (const parent of parents) Object.assign(merged, resolveFixtureMerges(parent));
  for (const [key, child] of Object.entries(value)) {
    if (key !== '<<') merged[key] = resolveFixtureMerges(child);
  }
  return merged;
}

function positionLotViolation(testCase) {
  const lots = (testCase.lots || []).map(resolveFixtureMerges);
  const logicalToKey = new Map();
  const keyToLogical = new Map();
  const versionKeys = new Map();
  for (const lot of lots) {
    if (
      lot.lotDiscriminator !== 'openingRemainder' ||
      lot.lotDiscriminator.normalize('NFC') !== lot.lotDiscriminator
    ) {
      return 'lotDiscriminator-openingRemainder';
    }
    if (!exactVersionIri(lot.openingExecution)) return 'openingExecution-exact-version';
    if (!exactVersionIri(lot.costBasisDefinition)) return 'costBasisDefinition-exact-version';
    if (
      !IRI.test(lot.logicalIri || '') ||
      !exactVersionIri(lot.versionIri) ||
      !IRI.test(lot.lotInAccount || '') ||
      !IRI.test(lot.lotForInstrument || '') ||
      !IRI.test(lot.openingExecutionLogicalIri || '') ||
      !IRI.test(lot.costBasisDefinitionLogicalIri || '')
    ) {
      return 'positionLot-identity-component';
    }
    for (const forbidden of ['hasQuantity', 'hasCostBasis', 'hasPositionSide', 'cost', 'rowNumber', 'arrivalOrder']) {
      if (Object.prototype.hasOwnProperty.call(lot, forbidden)) return 'positionLot-forbidden-stored-truth';
    }
    const quantity = exactDecimal(lot.originalQuantity && lot.originalQuantity.amount);
    const gross = exactDecimal(lot.openingGross && lot.openingGross.amount);
    const basis = exactDecimal(lot.openingCostBasis && lot.openingCostBasis.amount);
    if (!quantity || quantity.coefficient === 0n) return 'originalQuantity-nonzero-signed';
    if (!gross || gross.coefficient <= 0n) return 'openingGross-positive';
    if (
      !basis ||
      basis.coefficient === 0n ||
      (basis.coefficient > 0n) !== (quantity.coefficient > 0n)
    ) {
      return 'openingCostBasis-sign';
    }
    if (
      !lot.openingGross ||
      !lot.openingCostBasis ||
      lot.openingGross.currency !== lot.openingCostBasis.currency
    ) {
      return 'opening-basis-currency-equality';
    }
    if (!IRI.test(lot.calculationContextRef || '')) return 'calculationContextRef-iri';
    if (!sourceClosureOk(lot.source)) return 'positionLot-source-closure';
    if (
      !Number.isInteger(lot.revision) ||
      lot.revision < 0 ||
      !Number.isFinite(Date.parse(lot.validFrom)) ||
      !Number.isFinite(Date.parse(lot.knowledgeFrom)) ||
      !Number.isFinite(Date.parse(lot.availableFrom))
    ) {
      return 'positionLot-standard-version-key';
    }

    const key = lotKey(lot);
    if (logicalToKey.has(lot.logicalIri) && logicalToKey.get(lot.logicalIri) !== key) {
      return 'positionLot-logical-key-drift';
    }
    logicalToKey.set(lot.logicalIri, key);
    const logicals = keyToLogical.get(key) || new Set();
    logicals.add(lot.logicalIri);
    keyToLogical.set(key, logicals);
    if (logicals.size > 1) return 'openingRemainder-tuple-unique';

    const versionKey = [lot.logicalIri, lot.validFrom, lot.knowledgeFrom, lot.availableFrom, lot.revision].join(
      '\u001f'
    );
    if (versionKeys.has(versionKey) && versionKeys.get(versionKey) !== lot.versionIri) {
      return 'positionLot-version-key-conflict';
    }
    versionKeys.set(versionKey, lot.versionIri);
  }

  for (const logicalIri of logicalToKey.keys()) {
    const chain = lots
      .filter((lot) => lot.logicalIri === logicalIri)
      .sort((a, b) => a.revision - b.revision);
    for (let i = 1; i < chain.length; i += 1) {
      if (
        chain[i].revision !== chain[i - 1].revision + 1 ||
        chain[i - 1].knowledgeTo !== chain[i].knowledgeFrom
      ) {
        return 'positionLot-revision-chain';
      }
    }
  }
  for (const lot of lots) {
    const openingViolation = positionLotOpeningViolation(lot);
    if (openingViolation) return openingViolation;
  }
  return null;
}

function validateFixtureFile(file, validator, expectAccepted) {
  const doc = loadYaml(file);
  for (const testCase of doc.cases || []) {
    const violation = validator(testCase);
    if (expectAccepted) {
      if (testCase.expectedResult !== 'accepted') {
        fail(testCase.id, 'positive fixture does not declare expectedResult: accepted');
      } else if (violation) {
        fail(testCase.id, `unexpected violation ${violation}`);
      } else {
        pass(testCase.id, 'accepted by executable contract validator');
      }
    } else if (testCase.expectedResult !== 'rejected') {
      fail(testCase.id, 'negative fixture does not declare expectedResult: rejected');
    } else if (!violation) {
      fail(testCase.id, 'negative fixture was incorrectly accepted');
    } else if (violation !== testCase.expectedViolation) {
      fail(testCase.id, `expected ${testCase.expectedViolation}, got ${violation}`);
    } else {
      pass(testCase.id, `rejected with ${violation}`);
    }
  }
}

console.log('=== M2 targeted instrument/listing and PositionLot contracts ===');
validateModuleContracts();
validateFixtureFile(
  path.join(FIXTURE_ROOT, 'positive', 'instrument-listing-quote-currency.yaml'),
  listingViolation,
  true
);
validateFixtureFile(
  path.join(FIXTURE_ROOT, 'negative', 'instrument-listing-quote-currency.yaml'),
  listingViolation,
  false
);
validateFixtureFile(
  path.join(FIXTURE_ROOT, 'positive', 'position-lot-identity.yaml'),
  positionLotViolation,
  true
);
validateFixtureFile(
  path.join(FIXTURE_ROOT, 'negative', 'position-lot-identity.yaml'),
  positionLotViolation,
  false
);

console.log(`SUMMARY pass=${passed} fail=${failed} pending-shared-profile=${pending}`);
if (pending > 0) {
  console.log('NOTE pending items are not PASS and do not authorize M2 approval.');
}
process.exit(failed > 0 ? 1 : pending > 0 ? 2 : 0);
