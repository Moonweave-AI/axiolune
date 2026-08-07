'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  collectActiveReferenceEvidence,
} = require('./lib/active-reference-evidence.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateSourceLocator,
} = require('./lib/strict-source-locator.cjs');
const {
  extractRdfXmlResourceBytes,
} = require('./lib/rdf-resource-source-extractor.cjs');
const {
  decodeUtf8Lines,
  extractTextLineRangeBytes,
} = require('./lib/text-line-range-source-extractor.cjs');
const {
  verifyReviewedNoAlignments,
} = require('./lib/reviewed-no-alignment.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE_ROOT = path.join(ROOT, 'reference', 'ontology-design-reference');
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const DECISIONS_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reviews',
  'semantic-review-decisions.json',
);
const ASSESSMENTS_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reviews',
  'ontology-design',
  'semantic-adoption-assessments.json',
);
const REVIEWER_REF = 'codex-agent:/root/ontology_reference_semantic_audit';
const TARGET_PROJECTS = new Set(['BIAN', 'FinRegOnt', 'fibo']);
const TEXT_PROFILE_PATH = 'scripts/domain/reference-extractors/text-line-range-utf8-v1.json';
const RDF_PROFILE_PATH = 'scripts/domain/reference-extractors/rdf-resource-rdfxml-v1.json';
const WHOLE_FILE_PROFILE_PATH = 'scripts/domain/reference-extractors/whole-file-v1.json';

const BIAN_ASSESSMENTS = Object.freeze({
  CorporateAction: {
    coverage: 'CorporateActionEvent, entitlement, election, due-bill, and subscription-right models already cover the v0.3 post-trade slice at a finer fact level.',
    finding: 'The BIAN role focuses on service responsibility for entitlement allocation; it does not add a missing M2 identity or fact contract.',
    landing: [],
    outcome: 'covered-no-adoption',
    severity: 'info',
  },
  CounterpartyRisk: {
    coverage: 'Counterparty and Exposure primitives exist, while complete counterparty-risk management is outside the narrow v0.3 risk slice.',
    finding: 'The service-domain process is useful future scope input but is neither a versioned authority nor a substitute for risk measurement semantics.',
    landing: [],
    outcome: 'future-scope-no-adoption',
    severity: 'info',
  },
  FinancialInstrumentReferenceDataManagement: {
    coverage: 'Instrument, InstrumentIdentifier, InstrumentListing, Issuer, and exact identifier authority evidence cover the current reference-data ontology requirements.',
    finding: 'Central-directory ingestion, multiple-feed consolidation, and corporate-event feed operations are M1/catalog or runtime concerns rather than missing M2 concepts.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  FinancialInstrumentValuation: {
    coverage: 'PriceObservation, ValuationSnapshot, PositionValuation, Money, QuotationContract, and PIT axes cover current valuation facts.',
    finding: 'Valuation service execution and mark-to-model orchestration are runtime concerns; the source does not specify a stronger v0.3 fact identity contract.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  FinancialInstrumentValuationModels: {
    coverage: 'The strategy-research and valuation slices capture model identity/evidence only where required by current CQs.',
    finding: 'A full valuation-model catalogue and model execution service are expressly outside the M2 v0.3 ontology slice.',
    landing: [],
    outcome: 'future-scope-no-adoption',
    severity: 'info',
  },
  InvestmentPortfolioAnalysis: {
    coverage: 'Portfolio, Position, Holding, ValuationSnapshot, PositionValuation, Exposure, and current CQs cover the approved v0.3 analysis facts.',
    finding: 'Performance attribution and broad portfolio analytics are future slices, not evidence that current facts are incomplete.',
    landing: [],
    outcome: 'future-scope-no-adoption',
    severity: 'info',
  },
  InvestmentPortfolioManagement: {
    coverage: 'Portfolio, ManagementMandate, PortfolioAccountMembership, Holding, Position, and valuation facts cover current structural semantics.',
    finding: 'Rebalancing workflow and mandate enforcement are behavioral/runtime concerns outside the current ontology acceptance slice.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  LegalEntityDirectory: {
    coverage: 'Party, Organization, LEI identifier records, and issuer/account roles cover the current stable domain identities.',
    finding: 'Directory administration is a catalog/M1 concern; any further adoption requires an exact selected term-level locator and a demonstrated M2 semantic gap.',
    landing: [],
    outcome: 'covered-and-catalog-non-goal',
    severity: 'info',
  },
  MarketDataSwitchAdministration: {
    coverage: 'MarketDataStream, source contracts, observation provenance, and PIT availability cover the M2 data facts.',
    finding: 'Switch configuration and administration are runtime infrastructure, explicitly not domain ontology semantics.',
    landing: [],
    outcome: 'runtime-non-goal',
    severity: 'info',
  },
  MarketDataSwitchOperation: {
    coverage: 'MarketDataStream and immutable observation facts cover the domain-facing data contract.',
    finding: 'Feed routing/switch operation is runtime infrastructure and therefore not adopted into M2.',
    landing: [],
    outcome: 'runtime-non-goal',
    severity: 'info',
  },
  MarketInformationManagement: {
    coverage: 'Source-specific streams, observation provenance, revision identity, quality/availability axes, and PIT CQs cover current consolidation semantics.',
    finding: 'Operational knowledge-base management and feed verification workflow are runtime/catalog concerns, not missing domain types.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  MarketOrder: {
    coverage: 'OrderIntent and OrderLifecycleEvent cover stable intent identity, lifecycle, quantity, listing/OTC context, and status normalization.',
    finding: 'The source explicitly describes sell-side position blocking and one order splitting into multiple trades or aggregation into a block trade. Reservation is runtime scope, but the current ontology has no explicit parent/child split-or-aggregation lineage contract.',
    landing: [
      { action: 'Add an immutable exact-version split/aggregation lineage association rather than a mutable parent-order field.', kind: 'module', status: 'required', target: 'ontology/domain/finance/orders-execution/module.yaml#OrderIntentLineage' },
      { action: 'Bind endpoint closure, PIT eligibility, exact Quantity conservation, graph integrity, and provenance in an executable contract.', kind: 'constraint', status: 'required', target: 'ontology/domain/finance/orders-execution/module.yaml#OrderIntentLineageContract' },
      { action: 'Add an executable probe for one-to-many split and many-to-one aggregation lineage.', kind: 'cq', status: 'required', target: 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml#CQ-OE11' },
      { action: 'Add positive split/aggregation and negative cycle, orphan, duplicate, conservation, PIT, and runtime-state fixtures.', kind: 'fixture', status: 'required', target: 'tests/m2/fixtures/{positive,negative}/orders-execution-*.yaml' },
      { action: 'Bind the contract to the canonical adapter and fail-closed custom runtime profile with executable polarity vectors.', kind: 'runtime', status: 'required', target: 'scripts/domain/orders-portfolio-custom-profile/v0.3.0' },
    ],
    outcome: 'gap-requires-owner-decision',
    severity: 'major',
  },
  MarketOrderExecution: {
    coverage: 'Execution currently captures one executionAccount, instrument, listing/OTC context, quantity, price, fees, time, and optional executingBroker.',
    finding: 'The BIAN booking role and M2-PLAN Slice B both expose bilateral/account-role semantics. A single executionAccount plus optional broker does not represent the contra party/account role required by M2-PLAN.',
    landing: [
      { action: 'Add explicit bilateral execution party/account roles without conflating executing broker, venue, principal, or counterparty.', kind: 'module', status: 'required', target: 'ontology/domain/finance/orders-execution/module.yaml#Execution' },
      { action: 'Add cardinality/role-distinctness and listed/OTC applicability constraints.', kind: 'constraint', status: 'required', target: 'ontology/domain/finance/orders-execution/module.yaml#constraints' },
      { action: 'Extend an executable CQ to return and verify both execution-side roles.', kind: 'cq', status: 'required', target: 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml' },
      { action: 'Add positive bilateral and negative missing/equal-role fixtures.', kind: 'fixture', status: 'required', target: 'tests/m2/fixtures/{positive,negative}/orders-execution-*.yaml' },
    ],
    outcome: 'unclosed-plan-gap',
    severity: 'blocker',
  },
  MarketRiskModels: {
    coverage: 'RiskMeasure, Exposure, and model/evidence references cover only the current narrow risk slice.',
    finding: 'A portfolio of model lifecycle services is future scope and cannot be imported wholesale from a service-domain artifact as canonical ontology.',
    landing: [],
    outcome: 'future-scope-no-adoption',
    severity: 'info',
  },
  OrderAllocation: {
    coverage: 'Post-trade allocation and settlement instructions model current allocation identities and legs.',
    finding: 'The BIAN completed-order allocation workflow is operational; no additional current M2 identity or constraint is established by this role description.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  PartyReferenceDataDirectory: {
    coverage: 'Party and Organization identities plus reviewed authority identifiers cover current party reference semantics.',
    finding: 'Directory operation is catalog/M1 scope; the pinned BIAN artifact does not establish a missing canonical M2 identity contract.',
    landing: [],
    outcome: 'covered-and-catalog-non-goal',
    severity: 'info',
  },
  PositionKeeping: {
    coverage: 'Account, Position, PositionLot, Holding, valuations, lifecycle facts, and reconciliation findings cover the present financial-position ontology slice.',
    finding: 'Generic balance/limit/block bookkeeping is broader operational ledger scope and is not adopted.',
    landing: [],
    outcome: 'covered-and-ledger-non-goal',
    severity: 'info',
  },
  PositionManagement: {
    coverage: 'Portfolio/position/holding/exposure facts provide current consolidated views by account and instrument.',
    finding: 'Cross-currency/sector/counterparty management views are analytics/runtime projections, not missing canonical identities for v0.3.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  ProgramTrading: {
    coverage: 'StrategyDefinition, StrategyVersion, signal/factor observations, and execution references cover current research lineage.',
    finding: 'Automated order-generation and execution control are runtime agent behavior outside M2 ontology scope.',
    landing: [],
    outcome: 'runtime-non-goal',
    severity: 'info',
  },
  QuoteManagement: {
    coverage: 'QuoteObservation and bid/offer side semantics model observed market data.',
    finding: 'Creating/managing executable dealer quotes is a service behavior and must not be conflated with immutable quote observations.',
    landing: [],
    outcome: 'semantic-distinction-no-adoption',
    severity: 'info',
  },
  SecuritiesPositionKeeping: {
    coverage: 'Position/lot identity, corporate-action effects, valuation, and reconciliation facts cover current per-account/instrument position semantics.',
    finding: 'Transaction-log maintenance and balance posting are operational ledger behavior outside the current domain ontology.',
    landing: [],
    outcome: 'covered-and-ledger-non-goal',
    severity: 'info',
  },
  SettlementObligationManagement: {
    coverage: 'SettlementInstruction, SettlementLeg, allocation, status, reconciliation, counterparty and standing-instruction references cover current post-trade facts.',
    finding: 'Clearing/settlement orchestration is runtime behavior; the BIAN role does not supersede existing authority-backed constraints.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  SuitabilityChecking: {
    coverage: 'Suitability/compliance decisioning is not part of the M2 v0.3 trading-domain ontology scope.',
    finding: 'Customer suitability policy and decision workflow are explicit future regulatory/compliance scope.',
    landing: [],
    outcome: 'explicit-non-goal',
    severity: 'info',
  },
  TradeandPriceReporting: {
    coverage: 'Immutable trade/price observations exist, but regulatory reporting payloads and submission workflows are excluded from v0.3.',
    finding: 'The source describes regulatory reporting service behavior, an explicit M2-PLAN non-goal.',
    landing: [],
    outcome: 'explicit-non-goal',
    severity: 'info',
  },
  TradeConfirmationMatching: {
    coverage: 'Execution, allocation, settlement instruction/status, and reconciliation case/finding facts cover current post-trade matching evidence.',
    finding: 'Matching engine workflow is runtime behavior; bilateral role completeness is tracked separately under MarketOrderExecution.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
  TradedPositionManagement: {
    coverage: 'Position, PositionLot, Holding, ValuationSnapshot, and Exposure cover current traded-position facts.',
    finding: 'Intraday position control and trader workflow are runtime concerns outside M2.',
    landing: [],
    outcome: 'covered-and-runtime-non-goal',
    severity: 'info',
  },
});

const FIBO_ASSESSMENTS = Object.freeze([
  {
    candidateMeaning: 'FIBO SecurityPrice is a MonetaryPrice with optional pricing-source semantics; it is a value/classification construct, not a temporal observation record.',
    coverage: 'M2 PriceObservation is a TemporalFact with immutable identity, context, quotation contract, revision, provenance, and three temporal axes.',
    gaps: ['Do not assert owl:equivalentClass or rdfs:subClassOf between PriceObservation and SecurityPrice; their identity criteria differ.'],
    landing: [{ action: 'Record a reviewed semantic-mismatch/no-equivalence decision before any alignment claim.', kind: 'term', status: 'required-if-used', target: 'docs/ontology/terminology/fin-market-data-terms.yaml#PriceObservation' }],
    outcome: 'candidate-reviewed-no-equivalence',
    noAlignmentDecisionId: 'market-data-price-observation-fibo-security-price',
    path: 'FBC/FinancialInstruments/InstrumentPricing.rdf',
    resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/InstrumentPricing/SecurityPrice',
    severity: 'major',
  },
  {
    candidateMeaning: 'FIBO Listing represents a securities offering listing with registration status, dates, lot/tick data, and a listing service.',
    coverage: 'M2 InstrumentListing identifies instrument-at-market/segment trading context and has different identity and applicability rules.',
    gaps: ['The classes overlap but are not proven equivalent; a narrow reviewed relation or explicit no-alignment decision is required.'],
    landing: [{ action: 'Decide and evidence a precise alignment relation; prohibit automatic equivalence.', kind: 'term', status: 'required-if-used', target: 'docs/ontology/terminology/fin-instruments-terms.yaml#InstrumentListing' }],
    outcome: 'candidate-relation-unresolved',
    noAlignmentDecisionId: 'instruments-instrument-listing-fibo-listing',
    path: 'SEC/Securities/SecuritiesListings.rdf',
    resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/SEC/Securities/SecuritiesListings/Listing',
    severity: 'major',
  },
  {
    candidateMeaning: 'FIBO Settlement is a contract lifecycle event finalizing a transaction; it is distinct from SettlementConvention and SettlementTerms.',
    coverage: 'M2 SettlementInstruction is an instruction/obligation record with legs, status, allocation and reconciliation semantics, not the lifecycle event itself.',
    gaps: ['No equivalence/subclass relation is justified between SettlementInstruction and FIBO Settlement.'],
    landing: [{ action: 'Keep the semantic distinction explicit in the term card/no-alignment register if FIBO settlement is cited.', kind: 'term', status: 'required-if-used', target: 'docs/ontology/terminology/fin-post-trade-operations-terms.yaml#SettlementInstruction' }],
    outcome: 'candidate-reviewed-no-equivalence',
    noAlignmentDecisionId: 'post-trade-settlement-instruction-fibo-settlement',
    path: 'FBC/FinancialInstruments/Settlement.rdf',
    resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/Settlement/Settlement',
    severity: 'major',
  },
  {
    candidateMeaning: 'FIBO Share is an EquityInstrument with share-capital properties and specializations.',
    coverage: 'M2 EquitySecurity is deliberately broader than a share and may include non-share equity securities.',
    gaps: ['EquitySecurity must not be declared equivalent to the narrower FIBO Share class.'],
    landing: [{ action: 'Use only a reviewed narrower/broader relation for a future Share subtype, or record no alignment for EquitySecurity.', kind: 'term', status: 'required-if-used', target: 'docs/ontology/terminology/fin-instruments-terms.yaml#EquitySecurity' }],
    outcome: 'candidate-reviewed-no-equivalence',
    noAlignmentDecisionId: 'instruments-equity-security-fibo-share',
    path: 'SEC/Equities/EquityInstruments.rdf',
    resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/SEC/Equities/EquityInstruments/Share',
    severity: 'major',
  },
  {
    candidateMeaning: 'FIBO CorporateAction is an issuer/legal-entity action affecting issued securities and stakeholders.',
    coverage: 'M2 already uses an exact resource in SecurityRelatedCorporateActions for the narrower current post-trade event semantics.',
    gaps: ['The broader CorporateAction candidate adds no required current alignment and must not replace the existing exact narrower evidence without review.'],
    landing: [],
    outcome: 'covered-by-more-specific-active-source',
    path: 'CAE/CorporateEvents/CorporateActions.rdf',
    resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/CAE/CorporateEvents/CorporateActions/CorporateAction',
    severity: 'info',
  },
  {
    candidateMeaning: 'The Informative MarketTransactions extension models asymmetric transaction principal and counterparty roles.',
    coverage: 'Execution currently has one executionAccount and an optional executingBroker, which does not satisfy M2-PLAN bilateral party/account-role wording.',
    gaps: ['The useful role distinction is corroborating design input only: the FIBO module is Informative and is not acceptable as sole normative authority.'],
    landing: [{ action: 'Close bilateral roles in Execution, constraints, CQ and fixtures using M2-PLAN as the controlling requirement.', kind: 'module', status: 'required', target: 'ontology/domain/finance/orders-execution/module.yaml#Execution' }],
    outcome: 'corroborates-unclosed-plan-gap',
    path: 'FND/TransactionsExt/MarketTransactions.rdf',
    resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/FND/TransactionsExt/MarketTransactions/TransactionCounterparty',
    severity: 'blocker',
  },
  {
    candidateMeaning: 'The Informative SecuritiesTransactions extension specializes securities transaction principal and counterparty roles.',
    coverage: 'M2 execution role coverage remains unilateral at the account level.',
    gaps: ['This Informative module cannot be normative, but it reinforces the exact M2-PLAN requirement for both execution parties/account roles.'],
    landing: [{ action: 'Add bilateral execution-role coverage and executable rejection fixtures.', kind: 'fixture', status: 'required', target: 'tests/m2/fixtures/{positive,negative}/orders-execution-*.yaml' }],
    outcome: 'corroborates-unclosed-plan-gap',
    path: 'FND/TransactionsExt/SecuritiesTransactions.rdf',
    resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/FND/TransactionsExt/SecuritiesTransactions/SecuritiesTransactionCounterparty',
    severity: 'blocker',
  },
]);

const FINREG_ASSESSMENTS = Object.freeze([
  ['ref/LegalReference.ttl', 'Legal-document structure, legal roles, authorities and source references', 'The M2 v0.3 scope excludes full legal/regulatory-document ontology and the publisher marks this project as a legacy 2017 artifact.'],
  ['ref/FinancialReference.ttl', 'FinRegOnt extensions to older FIBO financial/regulatory concepts', 'The extensions are locked to an official but unsupported legacy snapshot and cannot override current exact FIBO/resource authority evidence.'],
  ['FRO_Banking.ttl', 'Banking regulation and capital/risk concepts', 'Regulatory reporting and complete prudential regulation are explicit v0.3 non-goals; exact provenance does not make this legacy snapshot current authority.'],
  ['Investment_Adviser_Act_USC_CFR.ttl', 'US Investment Advisers Act/CFR population and linkage', 'Jurisdiction-specific legal text population and compliance reasoning are outside v0.3, and the embedded legal content is not a substitute for separately current legal-source authority.'],
  ['ref/FIBO_EthOn_Alignment.ttl', 'Legacy FIBO-to-EthOn account/actor/network mappings', 'The mapping targets an old external ontology and does not establish current M2 identity or authority semantics.'],
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeRepoPath(value) {
  return value.replaceAll('\\', '/');
}

function repoPath(absolute) {
  return normalizeRepoPath(path.relative(ROOT, absolute));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function walkRegularFiles(directory) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => compareUtf8(a.name, b.name))) {
      if (entry.name === '.git') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const relative = normalizeRepoPath(path.relative(REFERENCE_ROOT, absolute));
        const [projectId] = relative.split('/');
        if (TARGET_PROJECTS.has(projectId)) files.push({ absolute, path: repoPath(absolute), projectId });
      }
    }
  }
  walk(directory);
  return files.sort((a, b) => compareUtf8(a.path, b.path));
}

function compact(value, limit = 220) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function bianRole(fileName) {
  if (fileName.endsWith('BusinessObects.csv')) return 'generated shared Business Objects model';
  if (fileName.endsWith('ControlRecordModel.csv')) return 'service-specific Control Record model';
  if (fileName.endsWith('ServiceOperations.csv')) return 'service operation/API inventory';
  if (fileName.endsWith('Specification.csv')) return 'service-domain specification';
  return 'project metadata';
}

function bianRoleDefinition(serviceDirectory) {
  const specification = path.join(
    REFERENCE_ROOT,
    'BIAN',
    serviceDirectory,
    `${serviceDirectory}Specification.csv`,
  );
  if (!fs.existsSync(specification)) return 'No companion Role Definition is present.';
  const lines = decodeText(fs.readFileSync(specification)).split(/\r?\n/u);
  const roleLine = lines.find((line) => /^"?Role Definition"?\t/u.test(line));
  if (!roleLine) return 'The companion specification has no parseable Role Definition row.';
  const value = roleLine.replace(/^"?Role Definition"?\t/u, '').replace(/^"|"$/gu, '').replaceAll('""', '"');
  return compact(value);
}

function bianDecision(file, bytes, bianClosures) {
  const relative = normalizeRepoPath(path.relative(path.join(REFERENCE_ROOT, 'BIAN'), file.absolute));
  const parts = relative.split('/');
  if (parts.length === 1) {
    const isLicense = parts[0] === 'LICENSE';
    return {
      disposition: 'reviewedNoBearing',
      rationale: isLicense
        ? 'BIAN LICENSE is Apache-2.0 licensing metadata; its complete bytes were reviewed and it defines no finance-domain class, relation, constraint, or CQ. Project provenance is locked separately to the exact official Git commit and complete local bundle digest.'
        : `BIAN root metadata ${parts[0]} was reviewed in full; it contains no version/release identity or domain semantic definition and therefore has no M2 ontology bearing.`,
      reviewMethod: 'complete-byte metadata review and project-provenance comparison',
    };
  }
  const service = parts[0];
  const role = bianRole(parts.at(-1));
  const definition = bianRoleDefinition(service);
  const curated = resolveBianAssessment(service, bianClosures);
  const roleFinding = role === 'generated shared Business Objects model'
    ? 'The exporter repeats a broad shared enterprise BOM across service domains; it is not a service-specific authoritative taxonomy.'
    : (role === 'service operation/API inventory'
      ? 'Operation verbs and request/response behavior are service/runtime design, not domain ontology authority.'
      : (role === 'service-specific Control Record model'
        ? 'The control record is a BIAN service transaction projection, not a canonical M2 fact identity contract.'
        : 'The role statement was compared with the active M2 module/CQ scope.'));
  const semantic = curated
    ? `${curated.coverage} ${curated.finding}`
    : `The ${service} service domain is outside the narrow M2 v0.3 finance ontology slice or contributes service behavior rather than a missing canonical identity/fact.`;
  return {
    disposition: 'reviewedRejected',
    rationale: `BIAN ${service} ${role}; companion Role Definition: “${definition}” ${roleFinding} ${semantic} The complete local BIAN tree is locked to exact official Git commit a928c56e7989492f7214b2bd0ae7b204644efc03; this file is rejected because of the stated semantic mismatch or non-goal, not because provenance is missing.`,
    reviewMethod: 'full-byte tolerant TSV inspection; artifact-role classification; companion Role Definition and M2-PLAN/module/CQ semantic comparison',
  };
}

function rdfMetadata(text) {
  const label = /<rdfs:label(?:\s+[^>]*)?>([^<]+)<\/rdfs:label>/iu.exec(text)?.[1];
  const version = /<owl:versionIRI\s+rdf:resource="([^"]+)"\s*\/?\s*>/iu.exec(text)?.[1];
  const maturity = /hasMaturityLevel\s+rdf:resource="[^"]*[;\/]([^;\/"]+)"/iu.exec(text)?.[1];
  const resources = [...text.matchAll(/<(?:owl:Class|owl:ObjectProperty|owl:DatatypeProperty|owl:NamedIndividual)\s+rdf:about="([^"]+)"/gu)];
  return {
    label: compact(label || 'unlabelled RDF/XML module', 120),
    maturity: maturity || 'not-declared',
    resourceCount: resources.length,
    version: version || 'not-declared',
  };
}

function fiboDecision(file, bytes) {
  const relative = normalizeRepoPath(path.relative(path.join(REFERENCE_ROOT, 'fibo'), file.absolute));
  const extension = path.extname(file.absolute).toLowerCase();
  if (extension === '.rdf') {
    const meta = rdfMetadata(decodeText(bytes));
    const curated = FIBO_ASSESSMENTS.find((entry) => entry.path === relative);
    const fit = curated
      ? `${curated.candidateMeaning} ${curated.coverage} ${curated.gaps.join(' ')}`
      : `The ${relative.split('/')[0]} subject area was compared with current M2 public elements and CQs. Whole-file import would violate the selective resource-level alignment policy; future adoption requires an exact resource locator and explicit semantic relation.`;
    return {
      disposition: 'reviewedRejected',
      rationale: `FIBO RDF/XML ${relative} (“${meta.label}”; versionIRI=${meta.version}; maturity=${meta.maturity}; ${meta.resourceCount} named class/property/individual declarations) was structurally and semantically reviewed. ${fit} The file is retained as design input but rejected as a whole-file M2 semantic source.`,
      reviewMethod: 'complete RDF/XML structural/resource inventory review plus M2 module/term/CQ semantic comparison',
    };
  }
  if (extension === '.ttl' || extension === '.n3') {
    return {
      disposition: 'reviewedRejected',
      rationale: `FIBO ${relative} is a semantic example/mapping graph rather than a selectively reviewed normative resource. Its full text was reviewed by artifact role; M2 v0.3 does not adopt ACTUS/example individuals or whole-file Turtle graphs, so it is rejected.`,
      reviewMethod: 'complete text/RDF artifact-role review against M2 selective-alignment policy',
    };
  }
  if (extension === '.mdzip' || ['.doc', '.docx', '.pdf', '.xlsx', '.zip'].includes(extension)) {
    return {
      disposition: 'reviewedRejected',
      rationale: `FIBO ${relative} is a binary model/document container. Magic bytes and archive manifest were inspected; an opaque container cannot provide executable resource-level SourceLocator evidence and is rejected as an M2 semantic source.`,
      reviewMethod: 'binary magic/archive-manifest inspection plus format and semantic-source suitability review',
    };
  }
  if (['.rq', '.sparql', '.sq'].includes(extension)) {
    return {
      disposition: 'reviewedRejected',
      rationale: `FIBO ${relative} is a SPARQL query/test artifact. Its full query text was reviewed; it tests or transforms FIBO content but does not define M2 domain semantics and is rejected as ontology evidence.`,
      reviewMethod: 'complete SPARQL text and artifact-role review',
    };
  }
  return {
    disposition: 'reviewedNoBearing',
    rationale: `FIBO ${relative} is repository governance, documentation, catalog, build, or tooling metadata. Its complete decodable text or binary metadata was reviewed by file role and it does not define an adoptable M2 finance-domain resource.`,
    reviewMethod: 'complete-file repository-artifact role and semantic-bearing review',
  };
}

function finRegDecision(file, bytes) {
  const relative = normalizeRepoPath(path.relative(path.join(REFERENCE_ROOT, 'FinRegOnt'), file.absolute));
  const extension = path.extname(file.absolute).toLowerCase();
  const iconOrStyle = /(?:^|\/)html(?:_widoco)?\/(?:icons|resources)\//u.test(relative)
    && ['.gif', '.css', '.js'].includes(extension);
  if (iconOrStyle) {
    return {
      disposition: 'reviewedNoBearing',
      rationale: `FinRegOnt ${relative} is generated-documentation presentation/tooling support. Its complete text or binary metadata was inspected and it defines no legal/finance ontology resource, so it has no M2 semantic bearing.`,
      reviewMethod: 'complete presentation-asset text or binary-metadata role review',
    };
  }
  const kind = extension === '.ttl'
    ? 'Turtle ontology/data graph'
    : (extension === '.html' ? 'generated ontology documentation' : (
      ['.jpg', '.gif', '.png'].includes(extension) ? 'generated ontology diagram/graph' : (
        ['.rq', '.sparql', '.sq'].includes(extension) ? 'SPARQL mapping/validation query' : 'supporting semantic artifact'
      )
    ));
  const textSignal = ['.ttl', '.html', '.rq', '.sparql', '.sq', '.txt', '.xml'].includes(extension)
    ? compact(decodeText(bytes).slice(0, 800), 150)
    : `binaryBytes=${bytes.length}`;
  return {
    disposition: 'reviewedRejected',
    rationale: `FinRegOnt ${relative} is ${kind} (file signature: “${textSignal}”). The complete local tree is path-for-path and byte-for-byte identical to the publisher's official ZIP and is locked by bundle digest under GPL-3.0. The publisher also identifies FRO as a legacy 2017 project that is no longer updated or supported. Regulatory reporting, jurisdiction-specific legal text, and broad compliance reasoning are M2 v0.3 non-goals, so the file is rejected because it is legacy or out of scope—not because provenance is missing, and never as current normative authority.`,
    reviewMethod: 'complete text parse or binary/archive metadata inspection; file-role, publisher-currency, provenance, and M2-PLAN scope review',
  };
}

function constructDecision(file, bytes, options = {}) {
  if (file.projectId === 'BIAN') {
    return bianDecision(file, bytes, options.bianClosures || inspectBianClosures());
  }
  if (file.projectId === 'FinRegOnt') return finRegDecision(file, bytes);
  return fiboDecision(file, bytes);
}

function profileDigest(profilePath) {
  return sha256(fs.readFileSync(path.join(ROOT, ...profilePath.split('/'))));
}

function locatorBase(kind, relativePath, mediaType, profilePath) {
  return {
    extractorProfileDigest: profileDigest(profilePath),
    extractorProfileRef: { kind: 'path', path: profilePath, root: 'sourceTree' },
    kind,
    mediaType,
    path: relativePath,
  };
}

function bianRoleLocator(service) {
  const relative = `${service}/${service}Specification.csv`;
  const absolute = path.join(REFERENCE_ROOT, 'BIAN', ...relative.split('/'));
  const bytes = fs.readFileSync(absolute);
  const lines = decodeUtf8Lines(bytes);
  const index = lines.findIndex((line) => /^"?Role Definition"?\t/u.test(line));
  if (index < 0) throw new Error(`BIAN ${service}: Role Definition line not found`);
  const locator = {
    ...locatorBase('textLineRange', relative, 'text/tab-separated-values', TEXT_PROFILE_PATH),
    // The example row carries the buyer/seller and involved-account details
    // needed to interpret MarketOrderExecution as implementation context.
    endLine: index + (service === 'MarketOrderExecution' ? 2 : 1),
    startLine: index + 1,
  };
  locator.selectionDigest = computeSelectionDigest(
    locator,
    extractTextLineRangeBytes(bytes, locator.startLine, locator.endLine),
  );
  const validation = validateSourceLocator(locator, {
    at: `BIAN.${service}.candidateLocator`,
    selectedBytes: extractTextLineRangeBytes(bytes, locator.startLine, locator.endLine),
  });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return { absolute, locator };
}

function fiboResourceLocator(entry) {
  const absolute = path.join(REFERENCE_ROOT, 'fibo', ...entry.path.split('/'));
  const bytes = fs.readFileSync(absolute);
  const locator = {
    ...locatorBase('rdfResource', entry.path, 'application/rdf+xml', RDF_PROFILE_PATH),
    resourceIri: entry.resourceIri,
  };
  const selected = extractRdfXmlResourceBytes(bytes, locator.resourceIri);
  locator.selectionDigest = computeSelectionDigest(locator, selected);
  const validation = validateSourceLocator(locator, { at: `fibo.${entry.path}.candidateLocator`, selectedBytes: selected });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return { absolute, locator };
}

function wholeFileLocator(projectId, relativePath, mediaType) {
  const absolute = path.join(REFERENCE_ROOT, projectId, ...relativePath.split('/'));
  const bytes = fs.readFileSync(absolute);
  const locator = locatorBase('wholeFile', relativePath, mediaType, WHOLE_FILE_PROFILE_PATH);
  locator.selectionDigest = computeSelectionDigest(locator, bytes);
  const validation = validateSourceLocator(locator, { at: `${projectId}.${relativePath}.candidateLocator`, selectedBytes: bytes });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return { absolute, locator };
}

function inspectBilateralExecutionClosure() {
  const errors = [];
  const readYaml = (relativePath) => YAML.parse(fs.readFileSync(
    path.join(ROOT, ...relativePath.split('/')),
    'utf8',
  ));
  try {
    const moduleDocument = readYaml('ontology/domain/finance/orders-execution/module.yaml');
    const execution = moduleDocument?.domain?.associationTypes?.Execution;
    const roles = new Map((execution?.participantRoles || []).map((role) => [role.id, role]));
    const expectedRoles = new Map([
      ['executionAccount', 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount'],
      ['executionParty', 'https://axiolune.ai/ontology/finance/foundation/Party'],
      ['contraAccount', 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount'],
      ['contraParty', 'https://axiolune.ai/ontology/finance/foundation/Party'],
    ]);
    for (const [roleId, range] of expectedRoles) {
      const role = roles.get(roleId);
      if (!role || role.range !== range || role.minCount !== 1 || role.maxCount !== 1) {
        errors.push(`Execution.${roleId} must be an exact required 1..1 ${range} role`);
      }
    }
    const broker = roles.get('executingBroker');
    if (!broker
        || broker.range !== 'https://axiolune.ai/ontology/finance/foundation/Party'
        || broker.minCount !== 0
        || broker.maxCount !== 1) {
      errors.push('Execution.executingBroker must remain a separate optional 0..1 Party role');
    }
    const executionDefinition = String(execution?.definition || '');
    for (const token of ['execution-side Party/account', 'contra-side Party/account', 'never substitutes']) {
      if (!executionDefinition.includes(token)) errors.push(`Execution definition omits ${token}`);
    }
    const contractExpression = String(
      moduleDocument?.domain?.constraints?.ExecutionContract?.expression?.expression || '',
    );
    for (const token of [
      'executionParty', 'executionAccount', 'contraParty', 'contraAccount',
      'executingBroker', 'cannot substitute',
    ]) {
      if (!contractExpression.includes(token)) errors.push(`ExecutionContract omits ${token}`);
    }

    const cqDocument = readYaml('docs/ontology/competency-questions/fin-orders-execution-cq.yaml');
    const cq = (cqDocument?.cqs || []).find((entry) => entry.id === 'CQ-OE4');
    const returns = new Set(cq?.queryContract?.returns || []);
    for (const field of [
      'accountVersionIri', 'executionPartyLogicalIri', 'contraAccountVersionIri',
      'contraPartyLogicalIri', 'executingBrokerLogicalIri',
    ]) {
      if (!returns.has(field)) errors.push(`CQ-OE4 does not return ${field}`);
    }
    const cqNegatives = new Set(cq?.negativeCases || []);
    for (const caseId of [
      'cq-oe4-executing-broker-does-not-substitute-contra-party',
      'cq-oe4-executing-broker-does-not-substitute-contra-account',
    ]) {
      if (!cqNegatives.has(caseId)) errors.push(`CQ-OE4 does not bind negative ${caseId}`);
    }

    const positive = readYaml('tests/m2/fixtures/positive/orders-execution-v03.yaml')?.fixtures || [];
    for (const fixtureId of ['OE-POS-006-listed-execution', 'OE-POS-007-otc-execution']) {
      const fixture = positive.find((entry) => entry.id === fixtureId);
      if (!fixture || fixture.contract !== 'ExecutionContract' || fixture.expectedResult !== 'accepted') {
        errors.push(`${fixtureId} is not an accepted ExecutionContract fixture`);
        continue;
      }
      for (const field of ['account', 'executionParty', 'contraAccount', 'contraParty']) {
        if (typeof fixture.instance?.[field] !== 'string') errors.push(`${fixtureId} omits ${field}`);
      }
    }

    const negative = readYaml('tests/m2/fixtures/negative/orders-execution-v03.yaml')?.fixtures || [];
    const requiredNegatives = [
      ['OE-NEG-018-executing-broker-cannot-substitute-contra-party', 'contraParty'],
      ['OE-NEG-019-executing-broker-cannot-substitute-contra-account', 'contraAccount'],
    ];
    for (const [fixtureId, omittedField] of requiredNegatives) {
      const fixture = negative.find((entry) => entry.id === fixtureId);
      if (!fixture
          || fixture.contract !== 'ExecutionContract'
          || fixture.expectedResult !== 'rejected'
          || typeof fixture.instance?.executingBroker !== 'string'
          || Object.prototype.hasOwnProperty.call(fixture.instance || {}, omittedField)) {
        errors.push(`${fixtureId} does not prove broker non-substitution for ${omittedField}`);
      }
    }

    const cqPositive = readYaml('tests/m2/fixtures/orders-portfolio-cq/positive.yaml')?.cases || [];
    const cqNegative = readYaml('tests/m2/fixtures/orders-portfolio-cq/negative.yaml')?.cases || [];
    if (!cqPositive.some((entry) => entry.id === 'cq-oe4-complete-immutable-trace')) {
      errors.push('CQ-OE4 executable positive case is missing');
    }
    for (const caseId of cqNegatives) {
      if (caseId.startsWith('cq-oe4-executing-broker-')
          && !cqNegative.some((entry) => entry.id === caseId)) {
        errors.push(`CQ-OE4 executable negative case ${caseId} is missing`);
      }
    }
  } catch (error) {
    errors.push(`bilateral execution closure inspection failed: ${error.message}`);
  }
  errors.sort(compareUtf8);
  return { errors, ok: errors.length === 0 };
}

function inspectOrderLineageClosure(options = {}) {
  const errors = [];
  const rootDir = path.resolve(options.rootDir || ROOT);
  const contentOverrides = options.contentOverrides instanceof Map
    ? options.contentOverrides
    : new Map();
  const normalizeRelative = (relativePath) => normalizeRepoPath(relativePath);
  const absoluteFor = (relativePath) => {
    const normalized = normalizeRelative(relativePath);
    const absolute = path.resolve(rootDir, ...normalized.split('/'));
    const relative = path.relative(rootDir, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${normalized} escapes the requested source root`);
    }
    return absolute;
  };
  const readBytes = (relativePath) => {
    const normalized = normalizeRelative(relativePath);
    if (contentOverrides.has(normalized)) {
      const value = contentOverrides.get(normalized);
      return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    }
    return fs.readFileSync(absoluteFor(normalized));
  };
  const readText = (relativePath) => readBytes(relativePath).toString('utf8');
  const materializeYamlMerges = (value) => {
    if (Array.isArray(value)) return value.map(materializeYamlMerges);
    if (value === null || typeof value !== 'object') return value;
    const result = {};
    const sources = Array.isArray(value['<<']) ? value['<<'] : [value['<<']];
    for (const source of sources) {
      if (source !== undefined && source !== null && typeof source === 'object') {
        Object.assign(result, materializeYamlMerges(source));
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== '<<') result[key] = materializeYamlMerges(child);
    }
    return result;
  };
  const readYaml = (relativePath) => materializeYamlMerges(YAML.parse(
    readText(relativePath),
    { maxAliasCount: 10_000 },
  ));
  const readJson = (relativePath) => JSON.parse(readText(relativePath));
  const expectDigest = (relativePath, expectedDigest, label) => {
    if (expectedDigest !== sha256(readBytes(relativePath))) {
      errors.push(`${label} digest does not bind ${normalizeRelative(relativePath)}`);
    }
  };
  const exactSet = (actual, expected, label) => {
    const actualValues = Array.isArray(actual) ? actual : [];
    const actualSet = new Set(actualValues);
    if (actualValues.length !== expected.length
        || actualSet.size !== actualValues.length
        || expected.some((value) => !actualSet.has(value))) {
      errors.push(`${label} is not the required exact set`);
    }
  };
  const requiredDomainNegativeReasons = {
    'OE-NEG-020-order-lineage-cycle': 'order-intent lineage graph contains a directed cycle',
    'OE-NEG-021-order-lineage-orphan-endpoint': 'order-intent lineage endpoint is orphaned: https://axiolune.ai/orders/intents/lineage-c/version/v1',
    'OE-NEG-022-order-lineage-duplicate-transformation': 'order-intent lineage graph contains a duplicate transformation key',
    'OE-NEG-023-order-lineage-wrong-endpoint-type': 'order-intent lineage endpoint has the wrong type',
    'OE-NEG-024-order-lineage-quantity-not-conserved': 'order-intent lineage does not conserve exact Quantity',
    'OE-NEG-025-order-lineage-runtime-reservation-forbidden': 'runtime reservation state is forbidden in M2 order lineage',
    'OE-NEG-026-order-lineage-unsorted-source-set': 'source intent exact-version set must be UTF-8 sorted',
    'OE-NEG-027-order-lineage-source-locator-required': 'order-intent lineage source locator is missing or invalid',
  };
  const requiredDomainNegatives = Object.keys(requiredDomainNegativeReasons);
  const requiredCqPositives = [
    'cq-oe11-split-one-to-many-lineage',
    'cq-oe11-aggregation-many-to-one-lineage',
  ];
  const requiredCqNegativeCodes = {
    'cq-oe11-source-count-closure-drift-rejected': 'CQ_OE11_SOURCE_SET',
    'cq-oe11-result-digest-closure-drift-rejected': 'CQ_OE11_RESULT_SET',
    'cq-oe11-unbound-domain-separated-key-rejected': 'CQ_OE11_KEY',
    'cq-oe11-wrong-branch-cardinality-rejected': 'CQ_OE11_BRANCH',
    'cq-oe11-orphan-endpoint-rejected': 'CQ_OE11_ENDPOINT_ORPHAN',
    'cq-oe11-wrong-endpoint-type-rejected': 'CQ_OE11_ENDPOINT_TYPE',
    'cq-oe11-self-edge-rejected': 'CQ_OE11_SELF_EDGE',
    'cq-oe11-cycle-rejected': 'CQ_OE11_CYCLE',
    'cq-oe11-duplicate-transformation-key-rejected': 'CQ_OE11_DUPLICATE_KEY',
    'cq-oe11-duplicate-directed-edge-rejected': 'CQ_OE11_DUPLICATE_EDGE',
    'cq-oe11-quantity-nonconservation-rejected': 'CQ_OE11_QUANTITY_CONSERVATION',
    'cq-oe11-instrument-mismatch-rejected': 'CQ_OE11_ENDPOINT_SEMANTICS',
    'cq-oe11-side-mismatch-rejected': 'CQ_OE11_ENDPOINT_SEMANTICS',
    'cq-oe11-quantity-unit-mismatch-rejected': 'CQ_OE11_ENDPOINT_SEMANTICS',
    'cq-oe11-endpoint-not-pit-eligible-at-lineage-rejected': 'CQ_OE11_ENDPOINT_PIT',
    'cq-oe11-runtime-reservation-state-rejected': 'CQ_OE11_FORBIDDEN_RUNTIME',
  };
  const requiredCqNegatives = Object.keys(requiredCqNegativeCodes);
  const requiredDependencyLocks = [
    'scripts/domain/lib/orders-portfolio-exact-arithmetic.cjs',
    'scripts/domain/lib/strict-fixture-loader.cjs',
    'scripts/domain/lib/strict-source-locator.cjs',
  ];
  const requiredArtifactLocks = [
    'tests/m2/fixtures/orders-portfolio-cq/source-records.yaml',
  ];
  const requiredReturnFields = [
    'orderIntentVersionIri', 'focusRole', 'lineageVersionIri', 'lineageKind',
    'sourceIntentVersionIris', 'sourceIntentCount', 'sourceIntentVersionSetDigest',
    'resultIntentVersionIris', 'resultIntentCount', 'resultIntentVersionSetDigest',
    'orderLineageKeyDigest',
  ];
  const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
  const validFixtureSourceLocator = (value) => (
    typeof value === 'string'
      && value.length > 2
      && value.startsWith('$.')
      && !/\s/u.test(value)
  );
  const requiredCqPositiveSemantics = {
    'cq-oe11-split-one-to-many-lineage': {
      focusRole: 'source', kind: 'split', resultCount: 2, sourceCount: 1,
    },
    'cq-oe11-aggregation-many-to-one-lineage': {
      focusRole: 'result', kind: 'aggregation', resultCount: 1, sourceCount: 2,
    },
  };
  const domainIntentFields = [
    'type', 'versionIri', 'instrument', 'side', 'quantity',
    'validFrom', 'knowledgeFrom', 'availableFrom',
  ];
  const domainLineageFields = [
    'versionIri', 'kind',
    'sourceIntentVersionIris', 'sourceIntentCount', 'sourceIntentVersionSetDigest',
    'resultIntentVersionIris', 'resultIntentCount', 'resultIntentVersionSetDigest',
    'orderLineageKeyDigest', 'validFrom', 'knowledgeFrom', 'availableFrom',
    'sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator',
  ];
  const queryPivotFields = ['asOfValid', 'asOfKnowledge', 'asOfAvailable'];
  const u64be = (value) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(value));
    return buffer;
  };
  const iriSetDigest = (values) => {
    if (!Array.isArray(values)
        || values.some((value) => !isNonEmptyString(value))
        || new Set(values).size !== values.length) return null;
    const sorted = [...values].sort(compareUtf8);
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
    hash.update(u64be(sorted.length));
    for (const value of sorted) {
      const bytes = Buffer.from(value, 'utf8');
      hash.update(u64be(bytes.length));
      hash.update(bytes);
    }
    return `sha256:${hash.digest('hex')}`;
  };
  const orderLineageKeyDigest = (lineage) => {
    if (!isNonEmptyString(lineage?.kind)
        || !isNonEmptyString(lineage?.resultIntentVersionSetDigest)
        || !isNonEmptyString(lineage?.sourceIntentVersionSetDigest)) return null;
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from('axiolune-order-intent-lineage-key-v1\0', 'utf8'));
    hash.update(Buffer.from(canonicalJcs({
      kind: lineage.kind,
      resultIntentVersionSetDigest: lineage.resultIntentVersionSetDigest,
      sourceIntentVersionSetDigest: lineage.sourceIntentVersionSetDigest,
    }), 'utf8'));
    return `sha256:${hash.digest('hex')}`;
  };
  const decimal = (value) => {
    const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(String(value));
    if (!match) return null;
    const fraction = match[3] || '';
    const coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
    return { coefficient, scale: fraction.length };
  };
  const decimalSum = (values) => {
    const parsed = values.map(decimal);
    if (parsed.some((value) => value === null)) return null;
    const scale = Math.max(0, ...parsed.map((value) => value.scale));
    return {
      coefficient: parsed.reduce(
        (sum, value) => sum + value.coefficient * (10n ** BigInt(scale - value.scale)),
        0n,
      ),
      scale,
    };
  };
  const decimalEqual = (left, right) => left !== null && right !== null
    && left.coefficient * (10n ** BigInt(right.scale))
      === right.coefficient * (10n ** BigInt(left.scale));
  const validateCqQuery = (query, label) => {
    if (!isRecord(query)) {
      errors.push(`${label} query is absent or invalid`);
      return;
    }
    exactSet(Object.keys(query), ['orderIntentVersionIri', 'pivot'], `${label} query fields`);
    if (!isNonEmptyString(query.orderIntentVersionIri)) {
      errors.push(`${label} orderIntentVersionIri is absent`);
    }
    if (!isRecord(query.pivot)) {
      errors.push(`${label} query pivot is absent or invalid`);
      return;
    }
    exactSet(Object.keys(query.pivot), queryPivotFields, `${label} query pivot fields`);
    for (const field of queryPivotFields) {
      if (!isNonEmptyString(query.pivot[field])) errors.push(`${label} query pivot omits ${field}`);
    }
  };
  const validateCqPositiveCase = (fixture) => {
    const label = fixture?.id || 'CQ-OE11 positive fixture';
    if (!isRecord(fixture)) {
      errors.push(`${label} case schema is invalid`);
      return;
    }
    exactSet(Object.keys(fixture), ['id', 'cqId', 'query', 'expectedRows'], `${label} case fields`);
    if (fixture.cqId !== 'CQ-OE11') errors.push(`${label} is bound to the wrong CQ`);
    validateCqQuery(fixture.query, label);
    const expectation = requiredCqPositiveSemantics[fixture.id];
    if (!expectation || !Array.isArray(fixture.expectedRows) || fixture.expectedRows.length !== 1) {
      errors.push(`${label} must contain its one exact expected result row`);
      return;
    }
    const [row] = fixture.expectedRows;
    if (!isRecord(row)) {
      errors.push(`${label} expected row is invalid`);
      return;
    }
    exactSet(Object.keys(row), requiredReturnFields, `${label} expected row fields`);
    for (const field of ['orderIntentVersionIri', 'lineageVersionIri']) {
      if (!isNonEmptyString(row[field])) errors.push(`${label} expected row omits ${field}`);
    }
    if (row.orderIntentVersionIri !== fixture.query?.orderIntentVersionIri
        || row.focusRole !== expectation.focusRole
        || row.lineageKind !== expectation.kind) {
      errors.push(`${label} expected row does not bind its focus role and branch semantics`);
    }
    for (const [arrayField, countField, digestField, expectedCount] of [
      ['sourceIntentVersionIris', 'sourceIntentCount', 'sourceIntentVersionSetDigest', expectation.sourceCount],
      ['resultIntentVersionIris', 'resultIntentCount', 'resultIntentVersionSetDigest', expectation.resultCount],
    ]) {
      if (!Array.isArray(row[arrayField])
          || row[arrayField].length !== expectedCount
          || row[countField] !== expectedCount
          || !sha256Pattern.test(row[digestField] || '')) {
        errors.push(`${label} expected row has an invalid ${arrayField} closure`);
      }
    }
    if (!sha256Pattern.test(row.orderLineageKeyDigest || '')) {
      errors.push(`${label} expected row has an invalid lineage key digest`);
    }
  };
  const validateCqNegativeCase = (fixture) => {
    const label = fixture?.id || 'CQ-OE11 negative fixture';
    if (!isRecord(fixture)) {
      errors.push(`${label} case schema is invalid`);
      return;
    }
    exactSet(
      Object.keys(fixture),
      ['id', 'cqId', 'query', 'mutations', 'expectedErrorCode'],
      `${label} case fields`,
    );
    if (fixture.cqId !== 'CQ-OE11') errors.push(`${label} is bound to the wrong CQ`);
    validateCqQuery(fixture.query, label);
    if (fixture.expectedErrorCode !== requiredCqNegativeCodes[fixture.id]) {
      errors.push(`${label} has the wrong exact expected error code`);
    }
    if (!Array.isArray(fixture.mutations) || fixture.mutations.length === 0) {
      errors.push(`${label} has no executable mutation`);
      return;
    }
    for (const [index, mutation] of fixture.mutations.entries()) {
      if (!isRecord(mutation)) {
        errors.push(`${label} mutation ${index} is invalid`);
        continue;
      }
      exactSet(Object.keys(mutation), ['op', 'path', 'value'], `${label} mutation ${index} fields`);
      if (mutation.op !== 'set' || !isNonEmptyString(mutation.path)) {
        errors.push(`${label} mutation ${index} is not an exact set operation`);
      }
    }
  };
  const validateDomainFixtureStructure = (fixture, label, options = {}) => {
    if (!isRecord(fixture?.instance)) {
      errors.push(`${label} instance is absent or invalid`);
      return;
    }
    exactSet(Object.keys(fixture.instance), ['focusVersionIri', 'intents', 'lineages'], `${label} instance fields`);
    if (!isNonEmptyString(fixture.instance.focusVersionIri)) errors.push(`${label} focusVersionIri is absent`);
    if (!Array.isArray(fixture.instance.intents) || fixture.instance.intents.length === 0) {
      errors.push(`${label} intent inventory is absent`);
    } else {
      for (const [index, intent] of fixture.instance.intents.entries()) {
        const intentLabel = `${label}.intents[${index}]`;
        if (!isRecord(intent)) {
          errors.push(`${intentLabel} is invalid`);
          continue;
        }
        exactSet(Object.keys(intent), domainIntentFields, `${intentLabel} fields`);
        for (const field of ['type', 'versionIri', 'instrument', 'side', 'validFrom', 'knowledgeFrom', 'availableFrom']) {
          if (!isNonEmptyString(intent[field])) errors.push(`${intentLabel}.${field} is absent`);
        }
        if (!isRecord(intent.quantity)
            || !isNonEmptyString(intent.quantity.value)
            || !isNonEmptyString(intent.quantity.unit)) {
          errors.push(`${intentLabel}.quantity is absent or invalid`);
        }
      }
    }
    if (!Array.isArray(fixture.instance.lineages) || fixture.instance.lineages.length === 0) {
      errors.push(`${label} lineage inventory is absent`);
      return;
    }
    for (const [index, lineage] of fixture.instance.lineages.entries()) {
      const lineageLabel = `${label}.lineages[${index}]`;
      if (!isRecord(lineage)) {
        errors.push(`${lineageLabel} is invalid`);
        continue;
      }
      const extraFields = options.extraLineageFields || [];
      exactSet(Object.keys(lineage), [...domainLineageFields, ...extraFields], `${lineageLabel} fields`);
      for (const field of [
        'versionIri', 'kind', 'validFrom', 'knowledgeFrom', 'availableFrom', 'sourceArtifactRef',
      ]) {
        if (!isNonEmptyString(lineage[field])) errors.push(`${lineageLabel}.${field} is absent`);
      }
      for (const [arrayField, countField, digestField] of [
        ['sourceIntentVersionIris', 'sourceIntentCount', 'sourceIntentVersionSetDigest'],
        ['resultIntentVersionIris', 'resultIntentCount', 'resultIntentVersionSetDigest'],
      ]) {
        if (!Array.isArray(lineage[arrayField])
            || lineage[arrayField].length === 0
            || lineage[arrayField].some((value) => !isNonEmptyString(value))
            || !Number.isSafeInteger(lineage[countField])
            || lineage[countField] <= 0
            || !sha256Pattern.test(lineage[digestField] || '')) {
          errors.push(`${lineageLabel}.${arrayField} closure is absent or invalid`);
        }
      }
      if (!sha256Pattern.test(lineage.orderLineageKeyDigest || '')
          || !sha256Pattern.test(lineage.sourceArtifactDigest || '')) {
        errors.push(`${lineageLabel} digest evidence is absent or invalid`);
      }
      if (!options.allowInvalidLocator && !validFixtureSourceLocator(lineage.sourceLocator)) {
        errors.push(`${lineageLabel}.sourceLocator is absent or invalid`);
      }
    }
  };
  const hasDirectedCycle = (lineages) => {
    const adjacency = new Map();
    for (const lineage of lineages || []) {
      for (const source of lineage.sourceIntentVersionIris || []) {
        const targets = adjacency.get(source) || new Set();
        for (const result of lineage.resultIntentVersionIris || []) targets.add(result);
        adjacency.set(source, targets);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (node) => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const next of adjacency.get(node) || []) if (visit(next)) return true;
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    return [...adjacency.keys()].some(visit);
  };

  try {
    const modulePath = 'ontology/domain/finance/orders-execution/module.yaml';
    const moduleDocument = readYaml(modulePath);
    const lineage = moduleDocument?.domain?.associationTypes?.OrderIntentLineage;
    if (lineage?.iri !== 'https://axiolune.ai/ontology/finance/orders-execution/OrderIntentLineage') {
      errors.push('OrderIntentLineage association is absent or has the wrong public IRI');
    }
    exactSet(
      (lineage?.participantRoles || []).map((role) => role.id),
      ['sourceOrderIntent', 'resultOrderIntent'],
      'OrderIntentLineage participant roles',
    );
    const roles = new Map((lineage?.participantRoles || []).map((role) => [role.id, role]));
    for (const roleId of ['sourceOrderIntent', 'resultOrderIntent']) {
      const role = roles.get(roleId);
      if (!role
          || role.range !== 'https://axiolune.ai/ontology/finance/orders-execution/OrderIntent'
          || role.minCount !== 1
          || role.maxCount !== null) {
        errors.push(`OrderIntentLineage.${roleId} must be a required unbounded exact OrderIntent-version role`);
      }
    }
    const requiredAttributes = [
      'https://axiolune.ai/ontology/finance/orders-execution/orderLineageKind',
      'https://axiolune.ai/ontology/finance/orders-execution/sourceIntentCount',
      'https://axiolune.ai/ontology/finance/orders-execution/sourceIntentVersionSetDigest',
      'https://axiolune.ai/ontology/finance/orders-execution/resultIntentCount',
      'https://axiolune.ai/ontology/finance/orders-execution/resultIntentVersionSetDigest',
      'https://axiolune.ai/ontology/finance/orders-execution/orderLineageKeyDigest',
      'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef',
      'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest',
      'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator',
    ];
    exactSet(
      (lineage?.attributeUses || []).map((attributeUse) => attributeUse.attribute),
      requiredAttributes,
      'OrderIntentLineage attribute uses',
    );
    const attributeUses = new Map(
      (lineage?.attributeUses || []).map((attributeUse) => [attributeUse.attribute, attributeUse]),
    );
    for (const attributeIri of requiredAttributes) {
      const attributeUse = attributeUses.get(attributeIri);
      if (!attributeUse || attributeUse.minCount !== 1 || attributeUse.maxCount !== 1) {
        errors.push(`OrderIntentLineage requires an exact 1..1 attribute use for ${attributeIri}`);
      }
    }
    exactSet(
      (lineage?.patternBindings || []).map((binding) => binding.pattern),
      [
        'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
        'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact',
      ],
      'OrderIntentLineage pattern bindings',
    );
    const lineageDefinition = String(lineage?.definition || '');
    for (const token of ['exact source OrderIntent versions', 'split', 'aggregation', 'does not represent account reservation']) {
      if (!lineageDefinition.includes(token)) errors.push(`OrderIntentLineage definition omits ${token}`);
    }

    const contract = moduleDocument?.domain?.constraints?.OrderIntentLineageContract;
    if (!contract
        || contract.constraintType !== 'Logical'
        || contract.scope !== 'Association'
        || contract.severity !== 'Error'
        || contract.expression?.language !== 'Custom'
        || contract.targetElement !== lineage?.iri) {
      errors.push('OrderIntentLineageContract is not an Error-level Logical Association constraint on OrderIntentLineage');
    }
    const expression = String(contract?.expression?.expression || '');
    for (const token of [
      'sorted unique closed exact-version sets',
      'RFC section-5.8 framed IRI-set digests',
      'split requires sourceIntentCount = 1 and resultIntentCount >= 2',
      'aggregation requires sourceIntentCount >= 2 and resultIntentCount = 1',
      'PIT-eligible OrderIntent version',
      'same instrument logical IRI, orderSide, and Quantity unit',
      'exact source Quantity sum equals exact result Quantity sum',
      'no self edge, directed cycle, duplicate directed source/result pair',
      'duplicate orderLineageKeyDigest',
      'axiolune-order-intent-lineage-key-v1\\0',
      'RFC8785-JCS',
      'logicalKey(orderLineageKeyDigest)',
      'versionKey(validFrom,knowledgeFrom,availableFrom,revision)',
    ]) {
      if (!expression.includes(token)) errors.push(`OrderIntentLineageContract omits ${token}`);
    }

    const cqPath = 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml';
    const cqDocument = readYaml(cqPath);
    const cq = (cqDocument?.cqs || []).find((entry) => entry.id === 'CQ-OE11');
    if (!cq || cq.status !== 'active' || cq.riskLevel !== 'high') {
      errors.push('CQ-OE11 is absent or is not active/high risk');
    }
    const implementationPath = 'scripts/domain/lib/orders-portfolio-cq.cjs';
    if (cq?.execution?.kind !== 'versionedFunction'
        || cq.execution.implementation !== implementationPath) {
      errors.push('CQ-OE11 does not bind the versioned Orders/Portfolio CQ implementation');
    } else {
      expectDigest(implementationPath, cq.execution.implementationDigest, 'CQ-OE11 implementation');
    }
    for (const [pathField, digestField, label] of [
      ['graphFixture', 'graphFixtureDigest', 'CQ-OE11 graph fixture'],
      ['positiveFixture', 'positiveFixtureDigest', 'CQ-OE11 positive fixture'],
      ['negativeFixture', 'negativeFixtureDigest', 'CQ-OE11 negative fixture'],
    ]) {
      const relativePath = cq?.execution?.[pathField];
      if (typeof relativePath !== 'string') errors.push(`${label} path is absent`);
      else expectDigest(relativePath, cq.execution[digestField], label);
    }
    const dependencyLocks = cq?.execution?.dependencyLocks;
    exactSet(
      Array.isArray(dependencyLocks) ? dependencyLocks.map((lock) => lock?.ref) : dependencyLocks,
      requiredDependencyLocks,
      'CQ-OE11 dependency locks',
    );
    for (const lock of dependencyLocks || []) {
      if (typeof lock?.ref !== 'string') errors.push('CQ-OE11 has an invalid dependency lock');
      else expectDigest(lock.ref, lock.digest, `CQ-OE11 dependency ${lock.ref}`);
    }
    const artifactLocks = cq?.execution?.artifactLocks;
    exactSet(
      Array.isArray(artifactLocks) ? artifactLocks.map((lock) => lock?.ref) : artifactLocks,
      requiredArtifactLocks,
      'CQ-OE11 artifact locks',
    );
    for (const lock of artifactLocks || []) {
      if (typeof lock?.ref !== 'string') errors.push('CQ-OE11 has an invalid artifact lock');
      else expectDigest(lock.ref, lock.digest, `CQ-OE11 artifact ${lock.ref}`);
    }
    exactSet(cq?.queryContract?.requiredBindings, ['orderIntentVersionIri'], 'CQ-OE11 required bindings');
    exactSet(cq?.queryContract?.requiredPivots, [
      'asOfValid', 'asOfKnowledge', 'asOfAvailable', 'referenceTime',
    ], 'CQ-OE11 required PIT pivots');
    exactSet(cq?.queryContract?.returns, requiredReturnFields, 'CQ-OE11 returns');
    if (cq?.queryContract?.branchSemantics?.split
          !== 'exactly one source and at least two results'
        || cq?.queryContract?.branchSemantics?.aggregation
          !== 'at least two sources and exactly one result') {
      errors.push('CQ-OE11 branch semantics do not bind split and aggregation cardinality');
    }
    exactSet(cq?.queryContract?.forbids, [
      'orphan or non-OrderIntent endpoints',
      'non-exact, unsorted, duplicate, or digest-drifted endpoint sets',
      'self edges, directed cycles, duplicate edges, or duplicate transformation keys',
      'non-conserved exact Quantity',
      'mixed instrument, OrderSide, or Quantity unit',
      'endpoints unavailable at the lineage or query PIT pivot',
      'runtime reservation or account-block state in the immutable lineage fact',
    ], 'CQ-OE11 forbidden outcomes');
    exactSet(cq?.positiveCases, requiredCqPositives, 'CQ-OE11 positive cases');
    exactSet(cq?.negativeCases, requiredCqNegatives, 'CQ-OE11 negative cases');
    exactSet(cq?.traceability?.exercisedPublicIris, [
      lineage?.iri,
      'https://axiolune.ai/ontology/finance/orders-execution/OrderLineageKind',
      'https://axiolune.ai/ontology/finance/orders-execution/sourceOrderIntent',
      'https://axiolune.ai/ontology/finance/orders-execution/resultOrderIntent',
      'https://axiolune.ai/ontology/finance/orders-execution/sourceIntentVersionSetDigest',
      'https://axiolune.ai/ontology/finance/orders-execution/resultIntentVersionSetDigest',
      'https://axiolune.ai/ontology/finance/orders-execution/orderLineageKeyDigest',
    ], 'CQ-OE11 exercised public IRIs');

    const positive = readYaml('tests/m2/fixtures/positive/orders-execution-v03.yaml')?.fixtures || [];
    const lineagePositiveId = 'OE-POS-020-immutable-split-and-aggregation-lineage';
    const lineagePositiveEntries = positive.filter((entry) => entry.id === lineagePositiveId);
    exactSet(
      lineagePositiveEntries.map((entry) => entry.id),
      [lineagePositiveId],
      'OrderIntentLineage domain positive fixture inventory',
    );
    const [lineagePositive] = lineagePositiveEntries;
    if (!lineagePositive
        || lineagePositive.contract !== 'OrderIntentLineageContract'
        || lineagePositive.expectedResult !== 'accepted') {
      errors.push('OE-POS-020 is not an accepted OrderIntentLineageContract fixture');
    } else {
      exactSet(
        Object.keys(lineagePositive),
        ['id', 'contract', 'expectedResult', 'instance'],
        'OE-POS-020 fixture fields',
      );
      validateDomainFixtureStructure(lineagePositive, 'OE-POS-020');
      const lineages = lineagePositive.instance?.lineages || [];
      const split = lineages.find((entry) => entry.kind === 'split');
      const aggregation = lineages.find((entry) => entry.kind === 'aggregation');
      if (lineages.length !== 2 || !split || split.sourceIntentCount !== 1 || split.resultIntentCount < 2) {
        errors.push('OE-POS-020 does not prove a one-to-many split');
      }
      if (lineages.length !== 2
          || !aggregation
          || aggregation.sourceIntentCount < 2
          || aggregation.resultIntentCount !== 1) {
        errors.push('OE-POS-020 does not prove a many-to-one aggregation');
      }
      const intents = lineagePositive.instance?.intents || [];
      const intentByVersion = new Map(intents.map((intent) => [intent.versionIri, intent]));
      if (intentByVersion.size !== intents.length) errors.push('OE-POS-020 repeats an OrderIntent version');
      if (lineages.filter((entry) => entry.versionIri === lineagePositive.instance?.focusVersionIri).length !== 1) {
        errors.push('OE-POS-020 focus lineage is absent or duplicated');
      }
      for (const [index, lineageEntry] of lineages.entries()) {
        const label = `OE-POS-020.lineages[${index}]`;
        for (const [arrayField, countField, digestField] of [
          ['sourceIntentVersionIris', 'sourceIntentCount', 'sourceIntentVersionSetDigest'],
          ['resultIntentVersionIris', 'resultIntentCount', 'resultIntentVersionSetDigest'],
        ]) {
          const values = lineageEntry[arrayField];
          if (!Array.isArray(values)
              || values.length !== lineageEntry[countField]
              || new Set(values).size !== values.length
              || values.some((value, valueIndex) => (
                valueIndex > 0 && compareUtf8(values[valueIndex - 1], value) >= 0
              ))
              || iriSetDigest(values) !== lineageEntry[digestField]) {
            errors.push(`${label}.${arrayField} is not a digest-closed sorted exact set`);
          }
        }
        if (orderLineageKeyDigest(lineageEntry) !== lineageEntry.orderLineageKeyDigest) {
          errors.push(`${label}.orderLineageKeyDigest does not bind the transformation`);
        }
        const sourceIntents = (lineageEntry.sourceIntentVersionIris || []).map(
          (versionIri) => intentByVersion.get(versionIri),
        );
        const resultIntents = (lineageEntry.resultIntentVersionIris || []).map(
          (versionIri) => intentByVersion.get(versionIri),
        );
        const endpoints = [...sourceIntents, ...resultIntents];
        if (endpoints.some((intent) => !intent || intent.type !== 'OrderIntent')) {
          errors.push(`${label} has an orphaned or wrong-type endpoint`);
          continue;
        }
        const first = endpoints[0];
        if (!endpoints.every((intent) => intent.instrument === first.instrument
            && intent.side === first.side
            && intent.quantity?.unit === first.quantity?.unit)) {
          errors.push(`${label} endpoint semantics disagree`);
        }
        const sourceQuantity = decimalSum(sourceIntents.map((intent) => intent.quantity?.value));
        const resultQuantity = decimalSum(resultIntents.map((intent) => intent.quantity?.value));
        if (!decimalEqual(sourceQuantity, resultQuantity)) {
          errors.push(`${label} does not conserve exact Quantity`);
        }
      }
    }
    const negative = readYaml('tests/m2/fixtures/negative/orders-execution-v03.yaml')?.fixtures || [];
    const lineageNegativeEntries = negative.filter((entry) => requiredDomainNegatives.includes(entry.id));
    exactSet(
      lineageNegativeEntries.map((entry) => entry.id),
      requiredDomainNegatives,
      'OrderIntentLineage domain negative fixture inventory',
    );
    const negativeById = new Map(lineageNegativeEntries.map((entry) => [entry.id, entry]));
    for (const fixtureId of requiredDomainNegatives) {
      const fixture = negativeById.get(fixtureId);
      if (!fixture
          || fixture.contract !== 'OrderIntentLineageContract'
          || fixture.expectedResult !== 'rejected'
          || fixture.expectedReason !== requiredDomainNegativeReasons[fixtureId]) {
        errors.push(`${fixtureId} is not an executable rejected OrderIntentLineageContract fixture`);
        continue;
      }
      exactSet(
        Object.keys(fixture),
        ['id', 'contract', 'expectedResult', 'expectedReason', 'instance'],
        `${fixtureId} fixture fields`,
      );
      validateDomainFixtureStructure(fixture, fixtureId, {
        allowInvalidLocator: fixtureId.endsWith('source-locator-required'),
        extraLineageFields: fixtureId.endsWith('runtime-reservation-forbidden')
          ? ['reservationId']
          : [],
      });
    }
    const negativeDefects = {
      'OE-NEG-020-order-lineage-cycle': (fixture) => hasDirectedCycle(fixture.instance?.lineages),
      'OE-NEG-021-order-lineage-orphan-endpoint': (fixture) => {
        const intentVersions = new Set((fixture.instance?.intents || []).map((intent) => intent.versionIri));
        return (fixture.instance?.lineages || []).some((entry) => [
          ...(entry.sourceIntentVersionIris || []), ...(entry.resultIntentVersionIris || []),
        ].some((versionIri) => !intentVersions.has(versionIri)));
      },
      'OE-NEG-022-order-lineage-duplicate-transformation': (fixture) => {
        const keys = (fixture.instance?.lineages || []).map((entry) => entry.orderLineageKeyDigest);
        return new Set(keys).size !== keys.length;
      },
      'OE-NEG-023-order-lineage-wrong-endpoint-type': (fixture) => {
        const intents = new Map((fixture.instance?.intents || []).map((intent) => [intent.versionIri, intent]));
        return (fixture.instance?.lineages || []).some((entry) => [
          ...(entry.sourceIntentVersionIris || []), ...(entry.resultIntentVersionIris || []),
        ].some((versionIri) => (
          intents.has(versionIri) && intents.get(versionIri)?.type !== 'OrderIntent'
        )));
      },
      'OE-NEG-024-order-lineage-quantity-not-conserved': (fixture) => {
        const intents = new Map((fixture.instance?.intents || []).map((intent) => [intent.versionIri, intent]));
        return (fixture.instance?.lineages || []).some((entry) => {
          const source = decimalSum((entry.sourceIntentVersionIris || []).map(
            (versionIri) => intents.get(versionIri)?.quantity?.value,
          ));
          const result = decimalSum((entry.resultIntentVersionIris || []).map(
            (versionIri) => intents.get(versionIri)?.quantity?.value,
          ));
          return source !== null && result !== null && !decimalEqual(source, result);
        });
      },
      'OE-NEG-025-order-lineage-runtime-reservation-forbidden': (fixture) => (
        (fixture.instance?.lineages || []).some((entry) => (
          ['reservation', 'reservationId', 'accountBlock'].some((field) => Object.hasOwn(entry, field))
        ))
      ),
      'OE-NEG-026-order-lineage-unsorted-source-set': (fixture) => (
        (fixture.instance?.lineages || []).some((entry) => (
          (entry.sourceIntentVersionIris || []).some((value, index, values) => (
            index > 0 && compareUtf8(values[index - 1], value) >= 0
          ))
        ))
      ),
      'OE-NEG-027-order-lineage-source-locator-required': (fixture) => (
        (fixture.instance?.lineages || []).some((entry) => !validFixtureSourceLocator(entry.sourceLocator))
      ),
    };
    for (const [fixtureId, defectCheck] of Object.entries(negativeDefects)) {
      const fixture = negativeById.get(fixtureId);
      if (fixture && !defectCheck(fixture)) {
        errors.push(`${fixtureId} does not encode its declared rejection reason`);
      }
    }

    const cqPositive = readYaml('tests/m2/fixtures/orders-portfolio-cq/positive.yaml')?.cases || [];
    const cqNegative = readYaml('tests/m2/fixtures/orders-portfolio-cq/negative.yaml')?.cases || [];
    const cqOe11Positive = cqPositive.filter((entry) => entry.cqId === 'CQ-OE11');
    const cqOe11Negative = cqNegative.filter((entry) => entry.cqId === 'CQ-OE11');
    exactSet(
      cqOe11Positive.map((entry) => entry.id),
      requiredCqPositives,
      'CQ-OE11 executable positive fixtures',
    );
    exactSet(
      cqOe11Negative.map((entry) => entry.id),
      requiredCqNegatives,
      'CQ-OE11 executable negative fixtures',
    );
    cqOe11Positive.forEach(validateCqPositiveCase);
    cqOe11Negative.forEach(validateCqNegativeCase);

    const validatorPath = 'scripts/domain/lib/orders-portfolio-custom-validators.cjs';
    const adapterPath = 'scripts/domain/lib/orders-portfolio-canonical-record-adapter.cjs';
    const fixtureLoaderPath = 'scripts/domain/lib/strict-fixture-loader.cjs';
    const runtimeSourcePaths = [implementationPath, validatorPath, adapterPath, fixtureLoaderPath];
    let runtimeModules = null;
    if (rootDir !== ROOT) {
      errors.push('Order lineage runtime verification requires the canonical repository root');
    } else {
      const overriddenRuntimeSources = runtimeSourcePaths.filter((relativePath) => (
        contentOverrides.has(normalizeRelative(relativePath))
      ));
      if (overriddenRuntimeSources.length > 0) {
        errors.push(
          `Order lineage runtime source overrides cannot be machine-executed: ${overriddenRuntimeSources.join(', ')}`,
        );
      } else {
        try {
          runtimeModules = {
            adapter: require(absoluteFor(adapterPath)),
            cq: require(absoluteFor(implementationPath)),
            fixtureLoader: require(absoluteFor(fixtureLoaderPath)),
            validator: require(absoluteFor(validatorPath)),
          };
        } catch (error) {
          errors.push(`Order lineage runtime modules failed to load: ${error.message}`);
        }
      }
    }
    if (runtimeModules && typeof cq?.execution?.graphFixture === 'string') {
      let graph = null;
      try {
        graph = readYaml(cq.execution.graphFixture);
      } catch (error) {
        errors.push(`CQ-OE11 graph fixture failed to load: ${error.message}`);
      }
      if (graph) {
        for (const fixture of cqOe11Positive) {
          try {
            const actual = runtimeModules.cq.executeCq('CQ-OE11', structuredClone(graph), fixture.query);
            if (canonicalJcs(actual) !== canonicalJcs(fixture.expectedRows)) {
              errors.push(`${fixture.id} runtime rows differ from the exact expected rows`);
            }
          } catch (error) {
            errors.push(`${fixture.id} positive runtime failed: ${error.code || error.message}`);
          }
        }
        for (const fixture of cqOe11Negative) {
          const mutated = structuredClone(graph);
          let runtimeError = null;
          try {
            for (const mutation of fixture.mutations || []) {
              runtimeModules.fixtureLoader.applyMutation(mutated, mutation);
            }
            runtimeModules.cq.executeCq('CQ-OE11', mutated, fixture.query);
          } catch (error) {
            runtimeError = error;
          }
          if (!(runtimeError instanceof runtimeModules.cq.CqContractError)
              || runtimeError.code !== fixture.expectedErrorCode) {
            errors.push(
              `${fixture.id} runtime returned ${runtimeError?.code || runtimeError?.message || 'accepted'}, expected ${fixture.expectedErrorCode}`,
            );
          }
        }
      }
    }
    const validatorSource = readText(validatorPath);
    const adapterSource = readText(adapterPath);
    const cqSource = readText(implementationPath);
    for (const [source, token, label] of [
      [validatorSource, 'function validateOrderIntentLineage(', 'custom validator implementation'],
      [validatorSource, 'OrderIntentLineageContract: validateOrderIntentLineage', 'custom validator dispatch'],
      [validatorSource, 'ORDER_LINEAGE_CYCLE', 'custom validator cycle rejection'],
      [validatorSource, 'axiolune-order-intent-lineage-key-v1', 'custom validator lineage-key domain separation'],
      [adapterSource, 'OrderIntentLineageContract: TYPES.OrderIntentLineage', 'canonical adapter target binding'],
      [adapterSource, "case 'OrderIntentLineageContract':", 'canonical adapter encode/decode branch'],
      [cqSource, 'function validateOrderIntentLineageGraph(', 'CQ-OE11 graph validator'],
      [cqSource, 'function executeOe11(', 'CQ-OE11 executor'],
      [cqSource, "'CQ-OE11': executeOe11", 'CQ-OE11 runtime dispatch'],
    ]) {
      if (!source.includes(token)) errors.push(`Order lineage ${label} is missing`);
    }

    const discovery = readJson(
      'scripts/domain/orders-portfolio-custom-profile/v0.3.0/discovery-contract.json',
    );
    const binding = (discovery?.constraints || []).find(
      (entry) => entry.validatorId === 'OrderIntentLineageContract',
    );
    if (!binding
        || binding.constraintIri !== contract?.iri
        || binding.targetElement !== lineage?.iri
        || binding.scope !== 'Association') {
      errors.push('Custom discovery profile does not exactly bind OrderIntentLineageContract');
    } else {
      expectDigest(validatorPath, binding.implementationDigest, 'OrderIntentLineage custom implementation');
      expectDigest(adapterPath, binding.adapterDigest, 'OrderIntentLineage canonical adapter');
    }
    const vectorDocument = readJson(
      'scripts/domain/orders-portfolio-custom-profile/v0.3.0/test-vectors.json',
    );
    const vector = (vectorDocument?.vectors || []).find(
      (entry) => entry.validatorId === 'OrderIntentLineageContract',
    );
    if (!vector
        || vector.constraintIri !== contract?.iri
        || vector.execution?.eligible !== true
        || vector.execution?.status !== 'executable'
        || vector.accepted?.expectedOutcome !== 'accepted'
        || vector.violation?.expectedOutcome !== 'violation'
        || vector.violation?.expectedCode !== 'ORDER_LINEAGE_BRANCH') {
      errors.push('Custom runtime profile lacks executable accepted/violation OrderIntentLineage polarity vectors');
    } else if (runtimeModules) {
      const { adapter, validator } = runtimeModules;
      const inputContract = readJson(
        'scripts/domain/orders-portfolio-custom-profile/v0.3.0/input-contract.json',
      );
      const acceptedScenario = adapter.decodeCanonicalOrdersPortfolioScenario(
        vector.accepted.scenario,
        vector.validatorId,
        inputContract,
      );
      try {
        validator.validateConstraint(
          vector.constraintIri,
          vector.validatorId,
          acceptedScenario,
        );
      } catch (error) {
        errors.push(`OrderIntentLineage accepted runtime vector failed: ${error.code || error.message}`);
      }
      const violationScenario = adapter.decodeCanonicalOrdersPortfolioScenario(
        vector.violation.scenario,
        vector.validatorId,
        inputContract,
      );
      let violationCode = null;
      try {
        validator.validateConstraint(
          vector.constraintIri,
          vector.validatorId,
          violationScenario,
        );
      } catch (error) {
        violationCode = error instanceof validator.CustomConstraintViolation
          ? error.code
          : `engine-error:${error.message}`;
      }
      if (violationCode !== vector.violation.expectedCode) {
        errors.push(
          `OrderIntentLineage violation runtime vector returned ${violationCode || 'accepted'}, expected ${vector.violation.expectedCode}`,
        );
      }
    }
  } catch (error) {
    errors.push(`order lineage closure inspection failed: ${error.message}`);
  }
  errors.sort(compareUtf8);
  return { errors, ok: errors.length === 0 };
}

function inspectBianClosures() {
  return {
    bilateralExecution: inspectBilateralExecutionClosure(),
    orderLineage: inspectOrderLineageClosure(),
  };
}

function resolveBianAssessment(service, bianClosures) {
  const configured = BIAN_ASSESSMENTS[service];
  if (!configured) return null;
  const { bilateralExecution, orderLineage } = bianClosures;
  if (service === 'MarketOrder' && orderLineage.ok) {
    return {
      coverage: 'OrderIntentLineage now represents immutable exact-version one-to-many splits and many-to-one aggregations with closed endpoint sets, framed digests, domain-separated identity, PIT provenance, exact Quantity conservation, and acyclic graph integrity. CQ-OE11, domain fixtures, the canonical adapter, and executable Custom profile bind the same contract.',
      finding: 'The BIAN split/aggregation gap is closed in executable source artifacts. Sell-side position reservation remains an explicit runtime non-goal; BIAN is retained only as locked implementation context and no normative equivalence is asserted.',
      landing: configured.landing.map((entry) => ({
        ...entry,
        status: 'implemented-source-closure-machine-checked',
      })),
      outcome: 'implemented-plan-gap-closed',
      severity: 'info',
    };
  }
  if (service === 'MarketOrderExecution' && bilateralExecution.ok) {
    return {
      coverage: 'Execution now requires exact execution-side and contra-side Party/account roles; executingBroker remains a separate optional intermediary. CQ-OE4 and listed/OTC positive plus broker-substitution negative fixtures bind the same contract.',
      finding: 'The previously identified M2-PLAN section 6.3 bilateral-role gap is closed in executable source artifacts. BIAN remains implementation context only and is not asserted as a normative equivalence.',
      landing: configured.landing.map((entry) => ({
        ...entry,
        status: 'implemented-source-closure-machine-checked',
      })),
      outcome: 'implemented-plan-gap-closed',
      severity: 'info',
    };
  }
  return {
    ...configured,
    ...(service === 'MarketOrder' && !orderLineage.ok
      ? { finding: `${configured.finding} Source-closure audit: ${orderLineage.errors.join('; ')}` }
      : {}),
    ...(service === 'MarketOrderExecution' && !bilateralExecution.ok
      ? { finding: `${configured.finding} Source-closure audit: ${bilateralExecution.errors.join('; ')}` }
      : {}),
  };
}

function constructAssessments(bianClosures = inspectBianClosures()) {
  const { bilateralExecution, orderLineage } = bianClosures;
  const noAlignmentVerification = verifyReviewedNoAlignments({ rootDir: ROOT });
  const verifiedNoAlignmentIds = new Set(
    noAlignmentVerification.ok
      ? noAlignmentVerification.evidence.decisions.map((entry) => entry.decisionId)
      : [],
  );
  const entries = [];
  for (const service of Object.keys(BIAN_ASSESSMENTS).sort(compareUtf8)) {
    const assessment = resolveBianAssessment(service, bianClosures);
    const { absolute, locator } = bianRoleLocator(service);
    entries.push({
      artifactDigest: sha256(fs.readFileSync(absolute)),
      assessmentId: `bian-${service}`,
      candidateLocator: locator,
      candidateMeaning: bianRoleDefinition(service),
      gapsOrNonGoals: [assessment.finding],
      m2Coverage: assessment.coverage,
      outcome: assessment.outcome,
      path: repoPath(absolute),
      projectId: 'BIAN',
      requiredLanding: assessment.landing,
      severity: assessment.severity,
      sourceStatus: (service === 'MarketOrder' && orderLineage.ok)
          || (service === 'MarketOrderExecution' && bilateralExecution.ok)
        ? 'locked-official-commit-implementation-context'
        : 'bundle-locked-candidate-locator-not-selected',
    });
  }
  for (const entry of FIBO_ASSESSMENTS) {
    const { absolute, locator } = fiboResourceLocator(entry);
    let resolved = entry;
    if (entry.noAlignmentDecisionId
        && verifiedNoAlignmentIds.has(entry.noAlignmentDecisionId)) {
      resolved = {
        ...entry,
        gaps: [
          ...entry.gaps,
          `Exact no-alignment decision ${entry.noAlignmentDecisionId} replays the locked source resource, local element digest, generated OWL projection, and absence of the rejected subclass triple.`,
        ],
        landing: entry.landing.map((landing) => ({
          ...landing,
          status: 'reviewed-no-alignment-machine-checked',
        })),
        outcome: 'reviewed-no-alignment-machine-checked',
        severity: 'info',
      };
    } else if (entry.noAlignmentDecisionId && !noAlignmentVerification.ok) {
      resolved = {
        ...entry,
        gaps: [
          ...entry.gaps,
          `No-alignment verifier failed closed: ${noAlignmentVerification.errors.join('; ')}`,
        ],
      };
    } else if (bilateralExecution.ok
        && entry.outcome === 'corroborates-unclosed-plan-gap') {
      resolved = {
        ...entry,
        coverage: 'The exact M2-PLAN bilateral execution Party/account-role requirement is now implemented and bound to CQ and rejection fixtures.',
        gaps: ['This Informative FIBO resource remains corroborating context only; no normative equivalence or full ontology import is asserted.'],
        landing: entry.landing.map((landing) => ({
          ...landing,
          status: 'implemented-source-closure-machine-checked',
        })),
        outcome: 'corroborates-implemented-plan-requirement',
        severity: 'info',
      };
    }
    entries.push({
      artifactDigest: sha256(fs.readFileSync(absolute)),
      assessmentId: `fibo-${entry.path.replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}-${entry.resourceIri.split('/').at(-1)}`,
      candidateLocator: locator,
      candidateMeaning: resolved.candidateMeaning,
      gapsOrNonGoals: resolved.gaps,
      m2Coverage: resolved.coverage,
      outcome: resolved.outcome,
      path: repoPath(absolute),
      projectId: 'fibo',
      requiredLanding: resolved.landing,
      severity: resolved.severity,
      sourceStatus: 'locked-development-snapshot-not-automatically-normative',
    });
  }
  for (const [relativePath, candidateMeaning, finding] of FINREG_ASSESSMENTS) {
    const { absolute, locator } = wholeFileLocator('FinRegOnt', relativePath, 'text/turtle');
    entries.push({
      artifactDigest: sha256(fs.readFileSync(absolute)),
      assessmentId: `finregont-${relativePath.replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}`,
      candidateLocator: locator,
      candidateMeaning,
      gapsOrNonGoals: [finding],
      m2Coverage: 'No current M2 v0.3 acceptance criterion requires this legacy regulatory/legal subject area.',
      outcome: 'rejected-legacy-or-out-of-scope',
      path: repoPath(absolute),
      projectId: 'FinRegOnt',
      requiredLanding: [],
      severity: 'info',
      sourceStatus: 'locked-official-legacy-zip-not-adopted',
    });
  }
  entries.sort((a, b) => compareUtf8(a.assessmentId, b.assessmentId));
  return {
    entries,
    externalProvenance: [
      { claim: 'The complete local BIAN tree is byte-identical by Git blob identity to official Apache-2.0 repository commit a928c56e7989492f7214b2bd0ae7b204644efc03.', url: 'https://github.com/bian-official/artefacts' },
      { claim: 'FinRegOnt publisher describes FRO as a legacy 2017 project that is no longer updated or supported.', url: 'https://finregont.com/ontology-directory-files-prefixes/' },
      { claim: 'FinRegOnt publisher describes FRO as an OWL ontology based on FIBO and LKIF.', url: 'https://finregont.com/' },
      { claim: 'FinRegOnt ontology files are licensed GPL-3.0 by the publisher.', url: 'https://jayzed.com/terms-of-use/' },
    ],
    reviewBasis: {
      m2Plan: 'docs/domain/planning/M2-PLAN.md#0.1',
      note: 'Candidate locators identify exact checked-in bytes. BIAN is pinned to an exact official commit and FinRegOnt is byte-identical to the official legacy ZIP. Only explicitly selected lock locators are release-traceable context; other candidate locators remain review inputs, not adopted normative evidence.',
      reviewerRef: REVIEWER_REF,
    },
    schemaVersion: '1.0',
    summary: {
      blocker: entries.filter((entry) => entry.severity === 'blocker').length,
      info: entries.filter((entry) => entry.severity === 'info').length,
      major: entries.filter((entry) => entry.severity === 'major').length,
      total: entries.length,
    },
  };
}

function loadExistingManifest() {
  if (!fs.existsSync(DECISIONS_PATH)) return { decisions: [], schemaVersion: '1.0' };
  const parsed = JSON.parse(fs.readFileSync(DECISIONS_PATH, 'utf8'));
  if (parsed?.schemaVersion !== '1.0' || !Array.isArray(parsed.decisions)) {
    throw new Error(`${repoPath(DECISIONS_PATH)} is not a schemaVersion 1.0 decision manifest`);
  }
  return parsed;
}

function constructArtifacts() {
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const active = collectActiveReferenceEvidence(ROOT, lock);
  const files = walkRegularFiles(REFERENCE_ROOT);
  const retained = loadExistingManifest().decisions.filter((decision) => {
    const prefix = 'reference/ontology-design-reference/';
    if (!decision.path.startsWith(prefix)) return true;
    const projectId = decision.path.slice(prefix.length).split('/')[0];
    return !TARGET_PROJECTS.has(projectId);
  });
  const bianClosures = inspectBianClosures();
  const generated = [];
  for (const file of files) {
    if (active.byPath.has(file.path)) continue;
    const bytes = fs.readFileSync(file.absolute);
    const assessment = constructDecision(file, bytes, { bianClosures });
    generated.push({
      artifactDigest: sha256(bytes),
      disposition: assessment.disposition,
      path: file.path,
      rationale: assessment.rationale,
      reviewMethod: assessment.reviewMethod,
      reviewerRef: REVIEWER_REF,
    });
  }
  const decisions = [...retained, ...generated].sort((a, b) => compareUtf8(a.path, b.path));
  const duplicate = decisions.find((decision, index) => index > 0 && decisions[index - 1].path === decision.path);
  if (duplicate) throw new Error(`duplicate semantic review decision ${duplicate.path}`);
  const manifest = { decisions, schemaVersion: '1.0' };
  const assessments = constructAssessments(bianClosures);
  return {
    activeTargetFileCount: files.filter((file) => active.byPath.has(file.path)).length,
    assessments,
    decisionCount: generated.length,
    decisions: manifest,
    fileCount: files.length,
  };
}

function writeArtifacts(result) {
  fs.mkdirSync(path.dirname(DECISIONS_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(ASSESSMENTS_PATH), { recursive: true });
  fs.writeFileSync(DECISIONS_PATH, canonicalJcs(result.decisions));
  fs.writeFileSync(ASSESSMENTS_PATH, canonicalJcs(result.assessments));
}

function checkArtifact(targetPath, expected) {
  if (!fs.existsSync(targetPath)) return [`${repoPath(targetPath)}: missing`];
  const actual = fs.readFileSync(targetPath, 'utf8');
  const errors = [];
  if (actual !== canonicalJcs(expected)) errors.push(`${repoPath(targetPath)}: deterministic bytes differ`);
  try {
    if (actual !== canonicalJcs(JSON.parse(actual))) errors.push(`${repoPath(targetPath)}: not canonical JCS`);
  } catch (error) {
    errors.push(`${repoPath(targetPath)}: invalid JSON: ${error.message}`);
  }
  return errors;
}

function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (!write && !check) {
    process.stderr.write('Usage: node scripts/domain/generate-ontology-design-semantic-review-decisions.cjs --write|--check\n');
    process.exitCode = 2;
    return;
  }
  const result = constructArtifacts();
  if (write) writeArtifacts(result);
  if (check) {
    const errors = [
      ...checkArtifact(DECISIONS_PATH, result.decisions),
      ...checkArtifact(ASSESSMENTS_PATH, result.assessments),
    ];
    if (errors.length > 0) {
      errors.forEach((error) => process.stderr.write(`ERROR ${error}\n`));
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(`${canonicalJcs({
    activeTargetFileCount: result.activeTargetFileCount,
    assessmentCount: result.assessments.entries.length,
    decisionCount: result.decisionCount,
    fileCount: result.fileCount,
    mode: write && check ? 'write-and-check' : (write ? 'write' : 'check'),
  })}\n`);
}

if (require.main === module) main();

module.exports = {
  ASSESSMENTS_PATH,
  DECISIONS_PATH,
  REVIEWER_REF,
  TARGET_PROJECTS,
  constructArtifacts,
  constructDecision,
  inspectOrderLineageClosure,
};
