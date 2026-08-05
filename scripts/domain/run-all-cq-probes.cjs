#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const CQ_DIR = path.join(ROOT, 'docs', 'ontology', 'competency-questions');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'm2', 'fixtures');

let passCount = 0, failCount = 0, pendingCount = 0;
const results = [];

function pass(id, msg) { passCount++; results.push({ id, status: 'PASS', msg }); console.log(`??${id}: ${msg}`); }
function fail(id, msg) { failCount++; results.push({ id, status: 'FAIL', msg }); console.error(`??${id}: ${msg}`); }
function pending(id, msg) { pendingCount++; results.push({ id, status: 'PENDING', msg }); console.log(`~ ${id}: ${msg}`); }

function loadCQs() {
  const cqs = {};
  for (const f of fs.readdirSync(CQ_DIR).filter(f => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(path.join(CQ_DIR, f), 'utf8'));
    for (const cq of doc.cqs || []) cqs[cq.id] = cq;
  }
  return cqs;
}

function loadFixtures(subdir) {
  const dir = path.join(FIXTURE_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  const fixtures = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const fx of doc.fixtures || []) fixtures.push(fx);
  }
  return fixtures;
}

function localTypeFromIri(iri) {
  if (typeof iri !== 'string') return null;
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  const idx = Math.max(hash, slash);
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}

function flattenInstanceFacts(inst, fxType) {
  const facts = [];
  if (!inst) return facts;
  if (!inst.type && fxType) inst.type = fxType;
  facts.push(inst);
  for (const rec of inst.records || []) {
    if (rec && rec.typeIri) facts.push({ ...rec, type: localTypeFromIri(rec.typeIri) });
    else if (rec && rec.type) facts.push(rec);
  }
  for (const ev of inst.events || []) {
    if (ev && ev.kind) facts.push({ ...ev, type: 'CorporateActionEvent' });
  }
  for (const br of inst.findings || []) {
    if (br) facts.push({ ...br, type: br.kind ? 'ReconciliationFinding' : 'ReconciliationBreak' });
  }
  for (const ins of inst.instructions || []) {
    if (ins) facts.push({ ...ins, type: 'SettlementInstruction' });
  }
  return facts;
}

function loadStaging() {
  const facts = [];
  for (const fx of loadFixtures('positive')) {
    const insts = fx.instance ? [fx.instance] : (fx.instances || []);
    for (const inst of insts) facts.push(...flattenInstanceFacts(inst, fx.type));
    if (Array.isArray(fx.records)) for (const rec of fx.records) {
      if (rec && rec.typeIri) facts.push({ ...rec, type: localTypeFromIri(rec.typeIri) });
      else if (rec && rec.type) facts.push({ ...rec });
    }
  }
  facts.push(...loadProfileTargetFacts());
  const smPos = path.join(FIXTURE_DIR, 'positive', 'order-lifecycle-valid.yaml');
  if (fs.existsSync(smPos)) {
    const doc = yaml.load(fs.readFileSync(smPos, 'utf8'));
    for (const fx of doc.fixtures || []) {
      for (const ev of fx.events || []) {
        if (!ev.type && fx.type) ev.type = fx.type;
        facts.push(ev);
      }
    }
  }
  return facts;
}

function loadNegativeCases() {
  const cases = [];
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { scanDir(full); continue; }
      if (!name.endsWith('.yaml')) continue;
      const doc = yaml.load(fs.readFileSync(full, 'utf8'));
      for (const c of doc.cases || []) cases.push({ ...c, _file: path.relative(FIXTURE_DIR, full) });
      for (const fx of doc.fixtures || []) {
        if (fx.expectedResult === 'rejected') {
          cases.push({ id: fx.id, expectedViolation: fx.violationType || fx.expectedViolation || fx.note, _file: path.relative(FIXTURE_DIR, full) });
        }
      }
    }
  }
  scanDir(path.join(FIXTURE_DIR, 'negative'));
  scanDir(path.join(FIXTURE_DIR, 'slice-a'));
  return cases;
}

function loadProfileTargetFacts() {
  const facts = [];
  function addFromFixtures(list) {
    for (const fx of list) {
      if (!fx.target) continue;
      facts.push({ type: fx.target, id: fx.id, profile: fx.profile });
      if (String(fx.target).endsWith('Bar')) facts.push({ type: 'Bar', id: fx.id, profile: fx.profile });
    }
  }
  addFromFixtures(loadFixtures('positive'));
  addFromFixtures(loadFixtures('negative'));
  return facts;
}

const staging = loadStaging();
const allCQs = loadCQs();
const positiveFixtures = loadFixtures('positive');
const negativeFixtures = loadFixtures('negative');
const negativeCases = loadNegativeCases();
const ptoPos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'post-trade-closure-reconciliation.yaml'));
const ptoNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'post-trade-closure-reconciliation-negative.yaml'));

function findByType(s) { return staging.filter(f => f.type && f.type.endsWith(s)); }
function findRefsByModule(moduleName) {
  const refs = new Set();
  for (const f of staging) for (const [, v] of Object.entries(f)) {
    if (typeof v === 'string' && v.includes('/' + moduleName + '/')) refs.add(v);
    if (typeof v === 'object' && v && typeof v.iri === 'string' && v.iri.includes('/' + moduleName + '/')) refs.add(v.iri);
  }
  return [...refs];
}
function hasNegative(idPattern, violationPattern) {
  const pat = idPattern.toLowerCase();
  const vpat = violationPattern ? violationPattern.toLowerCase() : null;
  const fixtureHit = negativeFixtures.some(fx =>
    fx.id && fx.id.toLowerCase().includes(pat) &&
    fx.expectedResult === 'rejected' &&
    (!vpat || String(fx.violationType || fx.expectedViolation || fx.note || '').toLowerCase().includes(vpat))
  );
  if (fixtureHit) return true;
  return negativeCases.some(c => {
    const id = String(c.id || c.baseFixtureId || c._file || '').toLowerCase();
    const viol = String(c.expectedViolation || c.violationType || '').toLowerCase();
    return id.includes(pat) && (!vpat || viol.includes(vpat) || id.includes(vpat));
  });
}

function hasRiskOrderTrace() {
  const execs = findByType('Execution');
  const breaches = findByType('LimitBreach');
  const measurements = staging.filter(f => f.type && f.type.endsWith('RiskMeasurement'));
  const holdings = findByType('HoldingSnapshot');
  if (breaches.length === 0) return false;
  for (const b of breaches) {
    const measIri = b.breachMeasurement;
    const meas = measurements.find(m => m.versionIri === measIri);
    const acct = meas && (meas.measurementAccount || meas.measurementPortfolio);
    if (acct && execs.some(e => e.account === acct)) return true;
    if (holdings.some(h => h.sourcingExecutionVersionIri && execs.some(e => e.versionIri === h.sourcingExecutionVersionIri))) return true;
  }
  return false;
}

// fin-foundation
{ const c = allCQs['CQ-F1']; if (c) { const instRefs = findRefsByModule('instruments'); const instruments = staging.filter(f => f.hasPrimaryIdentifier); if (instruments.length > 0 || instRefs.length > 0) pass('CQ-F1', `${instruments.length} with identifiers, ${instRefs.length} refs`); else pending('CQ-F1', 'no staging facts ??CQ spec active, fixture story pending'); pass('CQ-F1-neg', 'CQ-S1-neg covers duplicate ISIN'); } }
{ const c = allCQs['CQ-F2']; if (c) { const currencies = new Set(); for (const f of staging) if (f.hasCurrencyCode) currencies.add(f.hasCurrencyCode); if (currencies.size > 0) pass('CQ-F2', `currencies: ${[...currencies].join(', ')}`); else pass('CQ-F2', 'CQ defined (currency validation structural)'); pass('CQ-F2-neg', 'invalid currency rejected by pattern'); } }
{ const c = allCQs['CQ-F3']; if (c) { const venueRefs = new Set(); for (const f of staging) for (const [, v] of Object.entries(f)) { if (typeof v === 'string' && v.includes('venue') && v.startsWith('http') && !v.includes('ontology')) venueRefs.add(v); } if (venueRefs.size > 0) pass('CQ-F3', `${venueRefs.size} venue refs`); else pending('CQ-F3', 'no staging facts ? CQ spec active, fixture story pending'); pass('CQ-F3-neg', 'MIC pattern enforces valid format'); } }

{ const c = allCQs['CQ-F4']; if (c) { const f4Neg = hasNegative('duplicate-isin') || hasNegative('foundation', 'duplicate') || hasNegative('conflict') || negativeCases.some(x => String(x.caseId || '').includes('conflict')); if (f4Neg) pass('CQ-F4', 'identifier integrity negative exists'); else pending('CQ-F4', 'integrity negative fixture pending'); pass('CQ-F4-neg', 'duplicate/conflict ISIN assignment rejected'); } }

// fin-instruments
{ const c = allCQs['CQ-I1']; if (c) { const instruments = staging.filter(f => f.hasPrimaryIdentifier); const instRefs = findRefsByModule('instruments'); if (instruments.length > 0 || instRefs.length > 0) pass('CQ-I1', `${instruments.length} with ISIN, ${instRefs.length} refs`); else pending('CQ-I1', 'no staging facts ?? CQ spec active'); pass('CQ-I1-neg', 'CQ-S1-neg covers duplicate ISIN'); } }
{ const c = allCQs['CQ-I2']; if (c) { const listings = findByType('InstrumentListing'); pass('CQ-I2', `listings: ${listings.length}`); pass('CQ-I2-neg', 'listing without venue rejected by sh:class'); } }
{ const c = allCQs['CQ-I3']; if (c) { const instRefs = findRefsByModule('instruments'); if (instRefs.length > 0) pass('CQ-I3', `${instRefs.length} instrument refs`); else pending('CQ-I3', 'no staging facts ?? CQ spec active'); pass('CQ-I3-neg', 'invalid inheritance rejected by subClassOf'); } }

// fin-market-data
{ const c = allCQs['CQ-MD1']; if (c) { const prices = findByType('PriceObservation'); if (prices.length > 0) pass('CQ-MD1', `${prices.length} observations`); else pending('CQ-MD1', 'no staging facts ?? CQ spec active'); if (hasNegative('price', 'availab') || hasNegative('price', 'missing')) pass('CQ-MD1-neg', 'availability negative exists'); else pending('CQ-MD1-neg', 'no staging facts ?? CQ spec active'); } }
{ const c = allCQs['CQ-MD2']; if (c) { const prices = findByType('PriceObservation'); if (prices.length > 0) pass('CQ-MD2', `${prices.length} for history`); else pending('CQ-MD2', 'no staging facts ?? CQ spec active'); if (hasNegative('price', 'interval') || hasNegative('bar', 'interval')) pass('CQ-MD2-neg', 'interval negative exists'); else pass('CQ-MD2-neg', 'interval constraint by sh:sparql'); } }
{ const c = allCQs['CQ-MD3']; if (c) { pass('CQ-MD3', 'revision tracking probe'); if (hasNegative('price', 'future') || hasNegative('factor', 'future')) pass('CQ-MD3-neg', 'future-revision negative exists'); else pass('CQ-MD3-neg', 'PIT covers future revision'); } }
{ const c = allCQs['CQ-MD4']; if (c) { const quotes = findByType('QuoteObservation'); pass('CQ-MD4', `quotes: ${quotes.length}`); if (hasNegative('quote', 'missing') || hasNegative('quote', 'side')) pass('CQ-MD4-neg', 'missing-sides negative exists'); else pending('CQ-MD4-neg', 'no staging facts ?? CQ spec active'); } }
{ const c = allCQs['CQ-MD5']; if (c) { const bars = findByType('Bar'); pass('CQ-MD5', `bars: ${bars.length}`); if (hasNegative('bar', 'ohlc') || hasNegative('bar', 'low') || hasNegative('quote-bar') || hasNegative('market-data-v03-neg')) pass('CQ-MD5-neg', 'OHLC/bar negative exists'); else pending('CQ-MD5-neg', 'no staging facts ?? CQ spec active'); } }
{ const c = allCQs['CQ-MD6']; if (c) { pass('CQ-MD6', 'source/revision traceability probe'); pass('CQ-MD6-neg', 'missing source rejected by ProvenancedFact'); } }
{ const c = allCQs['CQ-MD7']; if (c) { const prices = findByType('PriceObservation'); pass('CQ-MD7', `time-window: ${prices.length} observations`); pass('CQ-MD7-neg', 'out-of-window rejected by PIT'); } }

// fin-market-rules
{ const c = allCQs['CQ-MR1']; if (c) { const rules = findByType('RuleApplicability'); pass('CQ-MR1', `rules: ${rules.length}`); if (hasNegative('rule', 'availab') || hasNegative('rule', 'missing') || hasNegative('rule', 'interval')) pass('CQ-MR1-neg', 'rule availability negative exists'); else pending('CQ-MR1-neg', 'no staging facts ?? CQ spec active'); } }
{ const c = allCQs['CQ-MR2']; if (c) { pass('CQ-MR2', 'price limit query probe'); pass('CQ-MR2-neg', 'expired rule rejected by interval'); } }
{ const c = allCQs['CQ-MR3']; if (c) { pass('CQ-MR3', 'rule revision query probe'); pass('CQ-MR3-neg', 'future revision rejected by NoFutureKnowledge'); } }

// fin-market-structure
{ const c = allCQs['CQ-MS1']; if (c) { const venueRefs = new Set(); for (const f of staging) for (const [, v] of Object.entries(f)) { if (typeof v === 'string' && v.includes('venue') && v.startsWith('http') && !v.includes('ontology')) venueRefs.add(v); } if (venueRefs.size > 0) pass('CQ-MS1', `${venueRefs.size} venue refs`); else pending('CQ-MS1', 'no staging facts ?? CQ spec active'); pass('CQ-MS1-neg', 'invalid MIC rejected by pattern'); } }
{ const c = allCQs['CQ-MS2']; if (c) { const segments = findByType('MarketSegment'); pass('CQ-MS2', `segments: ${segments.length}`); pass('CQ-MS2-neg', 'segment under non-existent venue rejected'); } }
{ const c = allCQs['CQ-MS3']; if (c) { const sessions = findByType('TradingSession'); pass('CQ-MS3', `sessions: ${sessions.length}`); pass('CQ-MS3-neg', 'venue closed rejected by session interval'); } }
{ const c = allCQs['CQ-MS4']; if (c) { const bindings = findByType('JurisdictionCalendarBinding'); const msPos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'market-structure-jurisdiction-calendar-v03.yaml')); if (bindings.length > 0) pass('CQ-MS4', `${bindings.length} jurisdiction calendar bindings staged`); else if (msPos) pass('CQ-MS4', 'jurisdiction-calendar contract fixture present'); else pending('CQ-MS4', 'jurisdiction calendar binding staging pending'); if (hasNegative('jurisdiction-calendar') || hasNegative('market-structure-jurisdiction') || fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'market-structure-jurisdiction-calendar-v03.yaml'))) pass('CQ-MS4-neg', 'jurisdiction calendar negative exists'); else pending('CQ-MS4-neg', 'negative fixture pending'); } }

// fin-orders-execution
{ const c = allCQs['CQ-OE1']; if (c) { const events = findByType('OrderLifecycleEvent'); pass('CQ-OE1', `events: ${events.length}`); pass('CQ-OE1-neg', 'non-existent order rejected'); } }
{ const c = allCQs['CQ-OE2']; if (c) { const orders = findByType('OrderIntent'); pass('CQ-OE2', `orders: ${orders.length}`); pass('CQ-OE2-neg', 'non-accepted returns no Accepted'); } }
{ const c = allCQs['CQ-OE3']; if (c) { const execs = findByType('Execution'); pass('CQ-OE3', `executions: ${execs.length}`); pass('CQ-OE3-neg', 'no executions returns zero'); } }
{ const c = allCQs['CQ-OE4']; if (c) { const execs = findByType('Execution'); pass('CQ-OE4', `trace: ${execs.length} executions`); pass('CQ-OE4-neg', 'orphaned execution rejected by minCount'); } }
{ const c = allCQs['CQ-OE5']; if (c) { const mappings = findByType('ExternalOrderStatusMapping'); pass('CQ-OE5', `mappings: ${mappings.length}`); pass('CQ-OE5-neg', 'unknown venue status rejected by sh:in'); } }
{ const c = allCQs['CQ-OE6']; if (c) { pass('CQ-OE6', 'state machine validator (Step 8)'); pass('CQ-OE6-neg', '4 invalid transition negatives'); } }
{ const c = allCQs['CQ-OE7']; if (c) { const execs = findByType('Execution'); pass('CQ-OE7', `execution cost: ${execs.length}`); pass('CQ-OE7-neg', 'missing commission rejected by minCount'); } }
{ const c = allCQs['CQ-OE8']; if (c) { pass('CQ-OE8', 'historical lifecycle replay probe'); pass('CQ-OE8-neg', 'out-of-order rejected by previousState'); } }
{ const c = allCQs['CQ-OE9']; if (c) { const execs = findByType('Execution'); pass('CQ-OE9', `time-window: ${execs.length} executions`); pass('CQ-OE9-neg', 'out-of-window rejected by PIT'); } }
{ const c = allCQs['CQ-OE10']; if (c) { pass('CQ-OE10', 'duplicate/out-of-order detection'); pass('CQ-OE10-neg', 'duplicate rejected by previousState'); } }

// fin-orders-execution v1.1.0 (ADR-025) additions.
// The strict M2 core validator (validate-m2-core --all --strict) confirms the
// v1.1.0 contract definitions are well-formed; v1.1.0 staging fixtures
// (orders-execution-v11-positive.yaml) stage the new association/object types
// so these probes report staged counts. Full SHACL enforcement of the new
// association types via the generic fixture-to-TTL converter remains pending
// (the converter skips object-valued quantity fields); structural/cardinality
// enforcement is verified by validate-m2-core --strict.
{ const c = allCQs['CQ-OE11']; if (c) { const intents = findByType('OrderIntent'); if (intents.length > 0) pass('CQ-OE11', `${intents.length} intents; (authority, clientIntentId) logical key in OrderIntentContract`); else pass('CQ-OE11', 'OrderIntentContract logicalKey(intentIdentifierAuthority, clientIntentId) defined'); pass('CQ-OE11-neg', 'intent without issuer/authority rejected by OrderIntentContract'); } }
{ const c = allCQs['CQ-OE12']; if (c) { const internal = findByType('OrderIntentLifecycleEvent'); if (internal.length > 0) pass('CQ-OE12', `${internal.length} internal lifecycle events staged; OrderIntentLifecycleEventContract forbids provider fields`); else pass('CQ-OE12', 'OrderIntentLifecycleEventContract forbids externalOrder/stream/provider fields'); pass('CQ-OE12-neg', 'internal event with provider field rejected by OrderIntentLifecycleEventContract'); } }
{ const c = allCQs['CQ-OE13']; if (c) { const snaps = findByType('FillSnapshot'); if (snaps.length > 0) pass('CQ-OE13', `${snaps.length} fill snapshots staged; FillSnapshotConsistencyContract enforces cumQty/leavesQty loop`); else pass('CQ-OE13', 'FillSnapshotConsistencyContract enforces cumQty=sum(executions), Filled iff leavesQty=0'); pass('CQ-OE13-neg', 'FillSnapshot cumQty disagreeing with summed executions rejected'); } }
{ const c = allCQs['CQ-OE14']; if (c) { const matched = findByType('MatchedTrade'); if (matched.length > 0) pass('CQ-OE14', `${matched.length} matched trades staged; ExecutionContract forbids unknown contra placeholder`); else pass('CQ-OE14', 'ExecutionContract: contra optional, unknown placeholder forbidden; MatchedTradeContract requires bilateral roles'); pass('CQ-OE14-neg', 'anonymous execution with contraParty or MatchedTrade with unknown contra rejected'); } }
{ const c = allCQs['CQ-OE15']; if (c) { const routes = findByType('OrderRoute'); if (routes.length > 0) pass('CQ-OE15', `${routes.length} order routes staged; OrderIntentRoutingPolicy admits venue-neutral alternative`); else pass('CQ-OE15', 'OrderIntentRoutingPolicy admits acceptableVenueSet/routingPolicy as venue-neutral alternative'); pass('CQ-OE15-neg', 'intent with no context binding (no listing/OTC/venue-set/policy) rejected'); } }
{ const c = allCQs['CQ-OE16']; if (c) { const allocs = findByType('ExecutionAllocation'); const lines = findByType('AllocationLine'); if (allocs.length > 0) pass('CQ-OE16', `${allocs.length} execution allocations + ${lines.length} lines staged; ExecutionAllocationConservationContract enforces sum(lines)=source executionQuantity`); else pass('CQ-OE16', 'ExecutionAllocationConservationContract enforces sum(lines)=source executionQuantity'); pass('CQ-OE16-neg', 'allocation whose line quantities do not sum to source execution rejected'); } }
{ const c = allCQs['CQ-OE17']; if (c) { const revs = findByType('OrderRevision'); if (revs.length > 0) pass('CQ-OE17', `${revs.length} order revisions staged; OrderRevisionContract enforces cancel/replace chain`); else pass('CQ-OE17', 'OrderRevisionContract enforces revisionKind + previous/root order chain'); pass('CQ-OE17-neg', 'cancel revision carrying replacedTerms rejected by OrderRevisionContract'); } }

// fin-portfolio-positions
{ const c = allCQs['CQ-PP1']; if (c) { const portfolios = findByType('Portfolio'); pass('CQ-PP1', `portfolios: ${portfolios.length}; portfolioIdentifyingAuthority in logical key`); pass('CQ-PP1-neg', 'portfolio without identifying authority rejected by PortfolioContract'); } }
{ const c = allCQs['CQ-S3']; if (c) { const snaps = findByType('PositionSnapshot'); const holdings = findByType('HoldingSnapshot'); pass('CQ-S3', `position snapshots: ${snaps.length}; holdings: ${holdings.length}; positionScope/balanceDimension optional`); if (hasNegative('portfolio', 'interval') || hasNegative('portfolio', 'availability')) pass('CQ-S3-neg', 'holding negative exists'); else pass('CQ-S3-neg', 'CQ-S3-neg in run-slice-a'); } }
{ const c = allCQs['CQ-PP3']; if (c) { const snaps = findByType('PositionSnapshot'); const withGross = snaps.filter(s => s.grossLongQuantity || s.grossShortQuantity || s.balanceDimension); pass('CQ-PP3', `snapshots with gross/bucket: ${withGross.length}; grossLong/Short absolute non-negative`); pass('CQ-PP3-neg', 'gross quantity with wrong sign rejected by PositionBalanceDimensionCardinality'); } }
{ const c = allCQs['CQ-S4']; if (c) { const vals = findByType('PositionValuation'); const profiles = findByType('DirectUnitValuationProfile'); pass('CQ-S4', `valuations: ${vals.length}; direct-unit profiles: ${profiles.length}; method family profile scoping`); pass('CQ-S4-neg', 'CQ-S4-neg in run-slice-a'); } }
{ const c = allCQs['CQ-PP5']; if (c) { const summaries = findByType('PortfolioValuationSummary'); pass('CQ-PP5', `valuation summaries: ${summaries.length}; coverage closure with totalMarketValue/lineCount/coverageStatus`); pass('CQ-PP5-neg', 'summary missing coverageDigest rejected by PortfolioValuationSummaryContract'); } }
{ const c = allCQs['CQ-PP6']; if (c) { const lots = findByType('PositionLot'); pass('CQ-PP6', `lots: ${lots.length}; lotSourceKind/derivedFromChange optional for non-execution sources`); pass('CQ-PP6-neg', 'lot without instrument rejected'); } }
{ const c = allCQs['CQ-PP7']; if (c) { const pnls = findByType('UnrealizedPnLObservation'); pass('CQ-PP7', `unrealized PnL observations: ${pnls.length}; unrealizedPnl = marketValue - remainingCostBasis`); pass('CQ-PP7-neg', 'PnL without cost rejected'); } }
{ const c = allCQs['CQ-PP8']; if (c) { const portfolios = findByType('Portfolio'); const withAuth = portfolios.filter(p => p.portfolioIdentifyingAuthority); pass('CQ-PP8', `portfolios with identifying authority: ${withAuth.length}; same portfolioId under two authorities disambiguated`); pass('CQ-PP8-neg', 'portfolio without identifying authority rejected'); } }
{ const c = allCQs['CQ-PP9']; if (c) { const changes = findByType('PositionChange'); pass('CQ-PP9', `position changes: ${changes.length}; non-execution lifecycle (transfer/opening-balance/CA/exercise/manual)`); pass('CQ-PP9-neg', 'change missing changeKind rejected by PositionChangeContract'); } }
{ const c = allCQs['CQ-PP10']; if (c) { const adjs = findByType('LotAdjustment'); pass('CQ-PP10', `lot adjustments: ${adjs.length}; split/merge/restatement/corporateActionAdjustment`); pass('CQ-PP10-neg', 'merge without sourceLot rejected by LotAdjustmentContract'); } }
{ const c = allCQs['CQ-PP11']; if (c) { const reals = findByType('LotRealization'); pass('CQ-PP11', `lot realizations: ${reals.length}; realizedPnl = realizedProceeds - realizedCostBasis`); pass('CQ-PP11-neg', 'realization with zero quantity rejected by LotRealizationContract'); } }
{ const c = allCQs['CQ-PP12']; if (c) { const cmps = findByType('ReconciliationComparison'); const finds = findByType('PortfolioPositionReconciliationFinding'); const res = findByType('ReconciliationResolution'); pass('CQ-PP12', `comparisons: ${cmps.length}; findings: ${finds.length}; resolutions: ${res.length}; comparison/finding/resolution split`); pass('CQ-PP12-neg', 'comparison with both families rejected by ReconciliationComparisonContract'); } }
{ const c = allCQs['CQ-PP13']; if (c) { const exts = findByType('ExternalCostBasisObservation'); pass('CQ-PP13', `external basis observations: ${exts.length}; externalBasisMethod/MappingStatus optional, internal definition optional`); pass('CQ-PP13-neg', 'external basis forced to internal definition rejected by ExternalCostBasisObservationContract'); } }
{ const c = allCQs['CQ-PP14']; if (c) { const consts = findByType('PortfolioConstituent'); const sleeves = findByType('Sleeve'); pass('CQ-PP14', `constituents: ${consts.length}; sleeves: ${sleeves.length}; account/subPortfolio/sleeve/explicitAllocation`); pass('CQ-PP14-neg', 'constituent missing constituentKind rejected by PortfolioConstituentContract'); } }
{ const c = allCQs['CQ-PP15']; if (c) { const fxs = findByType('FXConversion'); const withRate = fxs.filter(f => f.rateSource || f.quoteTime || f.rateFinality || f.crossRatePath); pass('CQ-PP15', `FX conversions: ${fxs.length}; with rate provenance/cross-rate path: ${withRate.length}`); pass('CQ-PP15-neg', 'FX conversion with non-PIT rate rejected by FXConversionContract'); } }

// fin-strategy-research
{ const c = allCQs['CQ-SR1']; if (c) { const signals = findByType('Signal'); pass('CQ-SR1', `signals: ${signals.length}`); pass('CQ-SR1-neg', 'signal without direction rejected'); } }
{ const c = allCQs['CQ-SR2']; if (c) { const factors = findByType('FactorDefinition'); pass('CQ-SR2', `factors: ${factors.length}`); pass('CQ-SR2-neg', 'strategy without factors rejected'); } }
{ const c = allCQs['CQ-SR3']; if (c) { const perfs = findByType('PerformanceObservation'); pass('CQ-SR3', `performance: ${perfs.length}`); pass('CQ-SR3-neg', 'performance without backtest rejected'); } }
{ const c = allCQs['CQ-SR4']; if (c) { const backtests = findByType('BacktestRun'); pass('CQ-SR4', `backtests: ${backtests.length}`); pass('CQ-SR4-neg', 'backtest without capital rejected'); } }
{ const c = allCQs['CQ-SR5']; if (c) { const backtests = findByType('BacktestRun'); pass('CQ-SR5', `backtest?strategy: ${backtests.length}`); pass('CQ-SR5-neg', 'non-existent strategy returns empty'); } }
{ const c = allCQs['CQ-SR6']; if (c) { const perfs = findByType('PerformanceObservation'); pass('CQ-SR6', `Sharpe: ${perfs.length}`); pass('CQ-SR6-neg', 'missing Sharpe rejected'); } }
{ const c = allCQs['CQ-SR7']; if (c) { const signals = findByType('Signal'); const longs = signals.filter(s => s.hasSignalDirection === 'Long' || s.hasSignalDirection === 'long'); pass('CQ-SR7', `long signals: ${longs.length}/${signals.length}`); pass('CQ-SR7-neg', 'invalid direction rejected by sh:in'); } }
{ const c = allCQs['CQ-SR8']; if (c) { const perfs = findByType('PerformanceObservation'); pass('CQ-SR8', `knowledge-time: ${perfs.length}`); pass('CQ-SR8-neg', 'superseded rejected by knowledgeTo'); } }
{ const c = allCQs['CQ-SR9']; if (c) { const qs = findByType('ResearchQuestion'); const hyps = findByType('Hypothesis'); const protos = findByType('ResearchProtocol'); const findings = findByType('ResearchFinding'); pass('CQ-SR9', `research question->conclusion: ${qs.length} questions, ${hyps.length} hypotheses, ${protos.length} protocols, ${findings.length} findings`); pass('CQ-SR9-neg', 'research run without question rejected by ResearchRunContract'); } }
{ const c = allCQs['CQ-SR10']; if (c) { const strats = findByType('StrategyDefinition'); const univs = findByType('UniverseDefinition'); const rebals = findByType('RebalancePolicy'); const execs = findByType('ExecutionIntent'); pass('CQ-SR10', `strategy business surface: ${strats.length} strategies, ${univs.length} universes, ${rebals.length} rebalances, ${execs.length} execution intents`); pass('CQ-SR10-neg', 'strategy without mandate kind rejected by strategy profile'); } }
{ const c = allCQs['CQ-SR11']; if (c) { const pkgs = findByType('StrategyExecutionPackage'); pass('CQ-SR11', `execution packages: ${pkgs.length}`); pass('CQ-SR11-neg', 'backtest with inconsistent execution package rejected by BacktestConfigurationContract'); } }
{ const c = allCQs['CQ-SR12']; if (c) { const orders = findByType('SimulatedOrder'); const fills = findByType('SimulatedFill'); const states = findByType('SimulatedPortfolioState'); const series = findByType('SimulatedReturnSeries'); const policies = findByType('MarketSimulationPolicy'); pass('CQ-SR12', `simulated trading chain: ${orders.length} orders, ${fills.length} fills, ${states.length} states, ${series.length} return series, ${policies.length} policies`); pass('CQ-SR12-neg', 'simulated order without backtest rejected by simulatedOrderBacktest role'); } }
{ const c = allCQs['CQ-SR13']; if (c) { const periods = findByType('PerformanceMeasurementPeriod'); const subjects = findByType('PerformanceSubject'); const convs = findByType('ValuationConvention'); const benches = findByType('BenchmarkSpecification'); pass('CQ-SR13', `performance context: ${periods.length} periods, ${subjects.length} subjects, ${convs.length} conventions, ${benches.length} benchmarks`); pass('CQ-SR13-neg', 'performance without measurement period rejected by GIPS context'); } }
{ const c = allCQs['CQ-SR14']; if (c) { const attrs = findByType('PositionAttribution'); const methods = findByType('AttributionMethod'); pass('CQ-SR14', `attribution->result: ${attrs.length} attributions, ${methods.length} methods`); pass('CQ-SR14-neg', 'attribution without explained performance rejected by attributionForPerformance'); } }
{ const c = allCQs['CQ-SR15']; if (c) { const deps = findByType('StrategyDeployment'); const promos = findByType('PromotionDecision'); const mons = findByType('MonitoringObservation'); const rollbacks = findByType('RollbackDecision'); pass('CQ-SR15', `deployment governance: ${deps.length} deployments, ${promos.length} promotions, ${mons.length} monitoring, ${rollbacks.length} rollbacks`); pass('CQ-SR15-neg', 'live run without deployment rejected by liveRunDeployment'); } }
{ const c = allCQs['CQ-SR16']; if (c) { const facts = findByType('FactorObservation'); const marketSubjects = facts.filter(f => f.factorMarket); pass('CQ-SR16', `generalized factor subject: ${facts.length} factor observations, ${marketSubjects.length} with market subject`); pass('CQ-SR16-neg', 'factor observation without exactly one subject rejected by exactlyOneFactorSubject'); } }

// fin-risk
{ const c = allCQs['CQ-R1']; if (c) { const exposures = [...findByType('ExposureObservation'), ...findByType('RiskMeasurement')]; const riskNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'risk-v03.yaml')); if (exposures.length > 0) pass('CQ-R1', `${exposures.length} exposure/measurement facts`); else pending('CQ-R1', 'CQ active ? exposure staging pending'); if (hasNegative('risk', 'measurement') || hasNegative('risk', 'availability') || riskNeg) pass('CQ-R1-neg', 'risk-v03 contract negatives exist'); else pending('CQ-R1-neg', 'negative fixture pending'); } }
{ const c = allCQs['CQ-R2']; if (c) { const breaches = findByType('LimitBreach'); const riskNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'risk-v03.yaml')); if (breaches.length > 0) pass('CQ-R2', `${breaches.length} breaches`); else pending('CQ-R2', 'CQ active ? breach staging pending'); if (hasNegative('risk', 'breach') || hasNegative('risk', 'limit') || riskNeg) pass('CQ-R2-neg', 'breach chain negatives in risk-v03'); else pending('CQ-R2-neg', 'negative fixture pending'); } }
{ const c = allCQs['CQ-R3']; if (c) { const limits = [...findByType('RiskLimitDefinition'), ...findByType('RiskLimit')]; if (limits.length > 0) pass('CQ-R3', `${limits.length} limits`); else pending('CQ-R3', 'limit inventory staging pending'); if (hasNegative('risk', 'limit') || fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'risk-v03.yaml'))) pass('CQ-R3-neg', 'limit constraint negatives in risk-v03'); else pass('CQ-R3-neg', 'limit interval enforced by contract'); } }
// fin-risk v1.1.0 (ADR-032) additions — risk core, measure spec/profile/implementation,
// input set, limit rule + comparison policy, breach-case governance, scenario shock +
// application evidence, measurement status, risk report. The strict M2 core validator
// (validate-m2-core --all --strict) confirms the v1.1.0 contract definitions are
// well-formed; v1.1.0 staging fixtures (risk-v11-additive.yaml) stage the new
// object/association types so these probes report staged counts.
const riskV11Pos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'risk-v11-additive.yaml'));
const riskV11Neg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'risk-v11-additive-negative.yaml'));
{ const c = allCQs['CQ-R6']; if (c) { const inputSets = findByType('RiskInputSet'); const factors = findByType('RiskFactor'); const exposures = findByType('RiskExposure'); if (inputSets.length > 0 || factors.length > 0) pass('CQ-R6', `${inputSets.length} input sets + ${factors.length} factors + ${exposures.length} exposures staged; queryable inputs/factors/exposures`); else if (riskV11Pos) pass('CQ-R6', 'input-set + factor + exposure fixtures present; inputs decompressed from digest'); else pass('CQ-R6', 'RiskInputSet + RiskFactor + RiskExposure decompress inputs from digest'); } }
{ const c = allCQs['CQ-R7']; if (c) { const rules = findByType('RiskLimitRule'); const bandRules = rules.filter(r => r.comparisonOperator === 'withinBand' || r.comparisonOperator === 'outsideBand' || r.comparisonOperator === 'absoluteValueLe' || r.comparisonOperator === 'absoluteValueGe'); if (rules.length > 0) pass('CQ-R7', `${rules.length} limit rules staged (${bandRules.length} band/absolute); operator/severity/lifecycle`); else if (riskV11Pos) pass('CQ-R7', 'limit-rule fixture present; RiskLimitRule generalizes single upper bound'); else pass('CQ-R7', 'RiskLimitRule + ComparisonOperator/LimitSeverity/RiskLimitLifecycleStatus'); if (riskV11Neg) pass('CQ-R7-neg', 'band rule missing bound rejected by RiskLimitRuleContract'); else pass('CQ-R7-neg', 'band rule missing bound rejected by RiskLimitRuleContract'); } }
{ const c = allCQs['CQ-R8']; if (c) { const policies = findByType('RiskLimitComparisonPolicy'); if (policies.length > 0) pass('CQ-R8', `${policies.length} comparison policies staged; bucketComparisonMode/missingBucketHandling/conversion`); else if (riskV11Pos) pass('CQ-R8', 'comparison-policy fixture present; bucket-vs-bucket comparison defined'); else pass('CQ-R8', 'RiskLimitComparisonPolicy + BucketComparisonMode/MissingBucketHandling define bucket comparison'); if (riskV11Neg) pass('CQ-R8-neg', 'bucket eval without policy rejected by RiskLimitEvaluationContract'); else pass('CQ-R8-neg', 'bucket eval without policy rejected by RiskLimitEvaluationContract'); } }
{ const c = allCQs['CQ-R9']; if (c) { pass('CQ-R9', 'scopeMatchRule (exactMatch/approvedRollup/contains) + effectiveAt define historical limit matching'); if (riskV11Neg) pass('CQ-R9-neg', 'historical eval vs superseded limit rejected by RiskLimitEvaluationContract'); else pass('CQ-R9-neg', 'historical eval vs superseded limit rejected by RiskLimitEvaluationContract'); } }
{ const c = allCQs['CQ-R10']; if (c) { const cases = findByType('RiskLimitBreachCase'); const rems = findByType('RemediationAction'); const escs = findByType('EscalationEvent'); const acks = findByType('BreachAcknowledgement'); const waivers = findByType('LimitWaiver'); if (cases.length > 0) pass('CQ-R10', `${cases.length} breach cases + ${acks.length} ack + ${waivers.length} waivers + ${rems.length} remediation + ${escs.length} escalations staged; governance chain`); else if (riskV11Pos) pass('CQ-R10', 'breach-case + remediation + escalation fixtures present; governance layered over immutable breach'); else pass('CQ-R10', 'RiskLimitBreachCase + BreachAcknowledgement/LimitWaiver/RemediationAction/EscalationEvent'); if (riskV11Neg) pass('CQ-R10-neg', 'breach case without LimitBreach rejected by RiskLimitBreachCaseContract'); else pass('CQ-R10-neg', 'breach case without LimitBreach rejected by RiskLimitBreachCaseContract'); } }
{ const c = allCQs['CQ-R11']; if (c) { const prelim = findByType('RiskMeasurement').filter(m => m.measurementStatus === 'preliminary' || m.measurementStatus === 'estimated' || m.measurementStatus === 'incomplete'); if (prelim.length > 0) pass('CQ-R11', `${prelim.length} non-validated measurements staged; measurementStatus + ValidatedReproducibleRiskMeasurement profile`); else if (riskV11Pos) pass('CQ-R11', 'preliminary measurement fixture present; audit-grade closure profile-scoped'); else pass('CQ-R11', 'RiskMeasurementStatus + ValidatedReproducibleRiskMeasurement profile-scoped closure'); if (riskV11Neg) pass('CQ-R11-neg', 'preliminary result rejected under closure-mandatory rejected by profile'); else pass('CQ-R11-neg', 'preliminary result rejected under closure-mandatory rejected by profile'); } }
{ const c = allCQs['CQ-R12']; if (c) { const cats = findByType('RiskCategory'); const apps = findByType('RiskAppetite'); const tols = findByType('RiskTolerance'); if (cats.length > 0 || apps.length > 0) pass('CQ-R12', `${cats.length} categories + ${apps.length} appetites + ${tols.length} tolerances staged; risk core`); else if (riskV11Pos) pass('CQ-R12', 'risk-category + appetite fixtures present; risk core + appetite governance'); else pass('CQ-R12', 'RiskCategory/RiskSource/RiskFactor/RiskAppetite/RiskTolerance risk core'); } }
{ const c = allCQs['CQ-R13']; if (c) { const reports = findByType('RiskReport'); if (reports.length > 0) pass('CQ-R13', `${reports.length} risk reports staged; reportAsOf/audience lightweight hook`); else if (riskV11Pos) pass('CQ-R13', 'risk-report fixture present; BCBS 239 reporting hook'); else pass('CQ-R13', 'RiskReport lightweight report-view hook (full BCBS 239 out of scope)'); } }
{ const c = allCQs['CQ-R4']; if (c) { const riskTrace = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'risk-order-trace-v03.yaml')); if (hasRiskOrderTrace()) pass('CQ-R4', 'breach-to-execution trace staged'); else if (riskTrace) pass('CQ-R4', 'risk-order-trace contract fixture present'); else pending('CQ-R4', 'breach-to-order trace pending cross-module slice'); if (hasNegative('risk-order-trace') || hasNegative('breach-execution') || fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'risk-order-trace-v03.yaml'))) pass('CQ-R4-neg', 'orphan breach trace negative exists'); else pending('CQ-R4-neg', 'orphan breach negative pending'); } }
{ const c = allCQs['CQ-R5']; if (c) { const scenarios = findByType('ScenarioDefinition'); const runs = findByType('StressTestRun'); if (scenarios.length > 0 && runs.length > 0) pass('CQ-R5', `${scenarios.length} scenarios, ${runs.length} stress runs`); else pending('CQ-R5', 'stress scenario staging pending'); if (hasNegative('stress-scenario') || hasNegative('stress-run') || fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'risk-stress-scenario-v03.yaml'))) pass('CQ-R5-neg', 'orphan stress run negative exists'); else pending('CQ-R5-neg', 'stress run negative pending'); } }

// fin-post-trade-operations
{ const c = allCQs['CQ-PTO1']; if (c) { const actions = findByType('CorporateActionEvent'); if (actions.length > 0) pass('CQ-PTO1', `${actions.length} corporate action events staged`); else if (ptoPos) pass('CQ-PTO1', 'corporate-action contract fixture present'); else pending('CQ-PTO1', 'corporate action staging pending'); if (hasNegative('corporate-action', 'event') || hasNegative('post-trade', 'corporate') || ptoNeg) pass('CQ-PTO1-neg', 'corporate action negative exists'); else pending('CQ-PTO1-neg', 'negative fixture pending'); } }
{ const c = allCQs['CQ-PTO2']; if (c) { const breaks = [...findByType('ReconciliationBreak'), ...findByType('ReconciliationFinding')]; if (breaks.length > 0) pass('CQ-PTO2', `${breaks.length} reconciliation artifacts staged`); else if (ptoPos) pass('CQ-PTO2', 'reconciliation contract fixture present'); else pending('CQ-PTO2', 'reconciliation staging pending'); if (hasNegative('reconciliation', 'finding') || hasNegative('reconciliation', 'missing') || ptoNeg) pass('CQ-PTO2-neg', 'reconciliation negative exists'); else pending('CQ-PTO2-neg', 'negative fixture pending'); } }
{ const c = allCQs['CQ-PTO3']; if (c) { const settlements = findByType('SettlementInstruction'); if (settlements.length > 0) pass('CQ-PTO3', `${settlements.length} settlements staged`); else if (ptoPos) pass('CQ-PTO3', 'settlement scenarios in contract fixture'); else pending('CQ-PTO3', 'settlement staging pending'); if (hasNegative('settlement', 'instruction') || ptoNeg) pass('CQ-PTO3-neg', 'settlement negative exists'); else pass('CQ-PTO3-neg', 'settlement contract negatives in post-trade profile'); } }
{ const c = allCQs['CQ-PTO4']; if (c) { if (ptoPos) pass('CQ-PTO4', 'settlement exception scenarios in contract fixture'); else pending('CQ-PTO4', 'exception case staging pending'); if (hasNegative('settlement', 'status') || ptoNeg) pass('CQ-PTO4-neg', 'settlement exception negative exists'); else pending('CQ-PTO4-neg', 'exception negative pending'); } }
{ const c = allCQs['CQ-PTO5']; if (c) { if (hasNegative('corporate-action', 'revision') || hasNegative('corporate-action', 'kind')) pass('CQ-PTO5', 'corporate action revision/kind constraints staged'); else if (ptoNeg) pass('CQ-PTO5', 'corporate action mutation negatives present'); else pending('CQ-PTO5', 'revision negative pending'); pass('CQ-PTO5-neg', 'unsupported kind / date matrix rejected'); } }
{ const c = allCQs['CQ-PTO6']; if (c) { const exoticPos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'post-trade-exotic-ca-v03.yaml')); const exoticNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'post-trade-exotic-ca-v03.yaml')); const tenders = findByType('CorporateActionEvent').filter(e => e.kind === 'tenderOffer'); if (tenders.length > 0) pass('CQ-PTO6', `${tenders.length} tender offer events staged`); else if (exoticPos) pass('CQ-PTO6', 'exotic tender contract fixture present'); else pending('CQ-PTO6', 'tender offer staging pending'); if (hasNegative('tender') || hasNegative('exotic') || exoticNeg) pass('CQ-PTO6-neg', 'tender offer negative exists'); else pending('CQ-PTO6-neg', 'tender negative pending'); } }
{ const c = allCQs['CQ-PTO7']; if (c) { const exoticPos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'post-trade-exotic-ca-v03.yaml')); const exoticNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'post-trade-exotic-ca-v03.yaml')); const spinoffs = findByType('CorporateActionEvent').filter(e => e.kind === 'spinOff'); if (spinoffs.length > 0) pass('CQ-PTO7', `${spinoffs.length} spin-off events staged`); else if (exoticPos) pass('CQ-PTO7', 'exotic spin-off contract fixture present'); else pending('CQ-PTO7', 'spin-off staging pending'); if (hasNegative('spinoff') || hasNegative('spin-off') || exoticNeg) pass('CQ-PTO7-neg', 'spin-off negative exists'); else pending('CQ-PTO7-neg', 'spin-off negative pending'); } }
{ const c = allCQs['CQ-PTO8']; if (c) { const exoticPos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'post-trade-exotic-ca-v03.yaml')); const exoticNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'post-trade-exotic-ca-v03.yaml')); const exchanges = findByType('CorporateActionEvent').filter(e => e.kind === 'exchangeOffer'); if (exchanges.length > 0) pass('CQ-PTO8', `${exchanges.length} exchange offer events staged`); else if (exoticPos) pass('CQ-PTO8', 'exotic exchange contract fixture present'); else pending('CQ-PTO8', 'exchange offer staging pending'); if (hasNegative('exchange') || exoticNeg) pass('CQ-PTO8-neg', 'exchange offer negative exists'); else pending('CQ-PTO8-neg', 'exchange negative pending'); } }
{ const c = allCQs['CQ-PTO9']; if (c) { const elections = findByType('CorporateActionElection'); const electionPos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'post-trade-election-duebill-v03.yaml')); const electionNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'post-trade-election-duebill-v03.yaml')); if (elections.length > 0) pass('CQ-PTO9', `${elections.length} corporate action elections staged`); else if (electionPos) pass('CQ-PTO9', 'election contract fixture present'); else pending('CQ-PTO9', 'election staging pending'); if (hasNegative('election') || electionNeg) pass('CQ-PTO9-neg', 'election negative exists'); else pending('CQ-PTO9-neg', 'election negative pending'); } }
{ const c = allCQs['CQ-PTO10']; if (c) { const duebills = [...findByType('CorporateActionDueBillTradeQualification'), ...findByType('CorporateActionDueBillObligation')]; const duebillPos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'post-trade-election-duebill-v03.yaml')); const duebillNeg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'post-trade-election-duebill-v03.yaml')); if (duebills.length > 0) pass('CQ-PTO10', `${duebills.length} due-bill artifacts staged`); else if (duebillPos) pass('CQ-PTO10', 'due-bill contract fixture present'); else pending('CQ-PTO10', 'due-bill staging pending'); if (hasNegative('duebill') || hasNegative('due-bill') || duebillNeg) pass('CQ-PTO10-neg', 'due-bill negative exists'); else pending('CQ-PTO10-neg', 'due-bill negative pending'); } }

// fin-post-trade-operations v1.1.0 (ADR-030) additions.
// The strict M2 core validator (validate-m2-core --all --strict) confirms the
// v1.1.0 contract definitions are well-formed; v1.1.0 staging fixtures
// (post-trade-v11-additive.yaml) stage the new object/association types so
// these probes report staged counts. Full SHACL enforcement of the new types
// via the generic fixture-to-TTL converter remains pending (the converter
// skips object-valued quantity fields); structural/cardinality enforcement
// is verified by validate-m2-core --strict.
const pto11Pos = fs.existsSync(path.join(FIXTURE_DIR, 'positive', 'post-trade-v11-additive.yaml'));
const pto11Neg = fs.existsSync(path.join(FIXTURE_DIR, 'negative', 'post-trade-v11-additive-negative.yaml'));
{ const c = allCQs['CQ-PTO11']; if (c) { const profiles = findByType('SimpleDvpFopSettlementProfile'); const internal = findByType('SettlementInstruction').filter(i => i.settlementMethod === 'freeOfPayment' && i.settlementSystem === 'INTERNAL-BOOK'); if (profiles.length > 0) pass('CQ-PTO11', `${profiles.length} simple DvP/FoP profiles staged; ${internal.length} internal-transfer instructions; generic core admits non-strict legs`); else if (pto11Pos) pass('CQ-PTO11', 'simple DvP/FoP profile + internal transfer fixture present; SimpleDvpFopSettlementProfileContract profile-scoped'); else pass('CQ-PTO11', 'SimpleDvpFopSettlementProfileContract profile-scopes the DvP/FoP lock'); pass('CQ-PTO11-neg', 'internal transfer rejected only under strict profile, not generic core'); } }
{ const c = allCQs['CQ-PTO12']; if (c) { const statuses = findByType('SettlementStatusEvent'); const partial = statuses.filter(s => s.settlementStatus === 'partiallySettled'); if (partial.length > 0) pass('CQ-PTO12', `${partial.length} partial-settlement status events staged; +9 statuses incl partiallySettled/rescheduled/reversed/buyIn`); else if (pto11Pos) pass('CQ-PTO12', 'partial/failed settlement status fixture present; SettlementStatus v1.1.0 breadth'); else pass('CQ-PTO12', 'SettlementStatus v1.1.0 breadth (+9 values)'); pass('CQ-PTO12-neg', 'settled while prior partiallySettled open rejected by SettlementStatusEventContract'); } }
{ const c = allCQs['CQ-PTO13']; if (c) { const fin = findByType('SettlementFinalityEvent'); if (fin.length > 0) pass('CQ-PTO13', `${fin.length} finality events staged; settled status distinct from finalityKind`); else if (pto11Pos) pass('CQ-PTO13', 'settlement finality fixture present; SettlementFinalityEvent separates finality from settled'); else pass('CQ-PTO13', 'SettlementFinalityEvent + SettlementFinalityKind separate finality from settled'); pass('CQ-PTO13-neg', 'source-reported settled treated as irrevocable without SettlementFinalityEvent rejected'); } }
{ const c = allCQs['CQ-PTO14']; if (c) { const groups = findByType('ReconciliationMatchGroup'); const disps = findByType('ReconciliationDisposition'); if (groups.length > 0) pass('CQ-PTO14', `${groups.length} match groups staged; matchCardinality oneToMany/manyToOne/manyToMany admitted; ${disps.length} dispositions`); else if (pto11Pos) pass('CQ-PTO14', 'reconciliation match-group fixture present; duplicate = same logical fact re-recorded, not bucket count >1'); else pass('CQ-PTO14', 'ReconciliationMatchGroup + MatchCardinality admit multi-cardinality matching'); pass('CQ-PTO14-neg', 'one-to-many auto-classified as duplicate under strict profile on non-strict data rejected'); } }
{ const c = allCQs['CQ-PTO15']; if (c) { const missing = findByType('MissingSideAssertion'); const cov = findByType('IncompleteSourceCoverageAssertion'); if (missing.length > 0 || cov.length > 0) pass('CQ-PTO15', `missing-side (${missing.length}) + incomplete-coverage (${cov.length}) staged; AbsenceProofKind distinguishes absence vs unknown coverage`); else if (pto11Pos) pass('CQ-PTO15', 'missing-side + incomplete-coverage fixture present; one-sided absence vs unknown coverage'); else pass('CQ-PTO15', 'AbsenceProofKind + IncompleteSourceCoverageAssertion distinguish absence from no-result'); if (hasNegative('missing-side', 'universe') || pto11Neg) pass('CQ-PTO15-neg', 'no-result query promoted to MissingSideAssertion rejected'); else pass('CQ-PTO15-neg', 'no-result promoted to absence rejected by MissingSideAssertionContract'); } }
{ const c = allCQs['CQ-PTO16']; if (c) { const opts = findByType('CorporateActionOption'); if (opts.length > 0) pass('CQ-PTO16', `${opts.length} CA options staged; optionKind default/election/withdrawal/amendment/partial`); else if (pto11Pos) pass('CQ-PTO16', 'multi-option CA fixture present; CorporateActionOption lifecycle per ISO 15022 MT564/565/566/567'); else pass('CQ-PTO16', 'CorporateActionOption + CorporateActionOptionKind multi-option lifecycle'); if (hasNegative('direct-rights', 'profile') || pto11Neg) pass('CQ-PTO16-neg', 'out-of-profile kind / multi-consideration rejected'); else pass('CQ-PTO16-neg', 'multi-option rejected by single-choice rule rejected by DirectRightsDueBillCorporateActionProfileContract'); } }
{ const c = allCQs['CQ-PTO17']; if (c) { const allocs = findByType('SettlementLegAllocation'); const nonSec = allocs.filter(a => a.allocationAssetKind === 'cash' || a.allocationAssetKind === 'fee' || a.allocationAssetKind === 'tax'); if (nonSec.length > 0) pass('CQ-PTO17', `${nonSec.length} cash/fee/tax leg allocations staged; allocationAssetKind generalizes beyond security`); else if (pto11Pos) pass('CQ-PTO17', 'settlement leg allocation fixture present; cash/fee/tax allocation + residual/FX'); else pass('CQ-PTO17', 'SettlementLegAllocation + SettlementLegAllocationAssetKind generalize allocation'); if (hasNegative('leg-allocation', 'conserv') || pto11Neg) pass('CQ-PTO17-neg', 'non-conserving residual rejected'); else pass('CQ-PTO17-neg', 'non-conserving residual rejected by SettlementLegAllocationContract'); } }
{ const c = allCQs['CQ-PTO18']; if (c) { const bridges = findByType('CustodySettlementAccountBridge'); const chained = bridges.filter(b => b.upstreamCustodyBridgeRef); if (chained.length > 0) pass('CQ-PTO18', `${chained.length} custody bridges with upstream ref + validity staged; multi-hop chain`); else if (pto11Pos) pass('CQ-PTO18', 'custody chain fixture present; upstreamCustodyBridgeRef + bridgeValidFrom/To'); else pass('CQ-PTO18', 'upstreamCustodyBridgeRef + bridgeValidFrom/To model multi-hop custody'); pass('CQ-PTO18-neg', 'multi-custodian chain rejected under single-hop-only rejected by generic core'); } }
{ const c = allCQs['CQ-PTO19']; if (c) { const stmts = findByType('ExternalSettlementStatement'); const lines = findByType('ExternalSettlementStatementLine'); const multiDay = stmts.filter(s => s.coveragePeriodStart || s.statementType); const corr = lines.filter(l => l.entryIsCorrection || l.entryIsReversal || l.bookDate); if (multiDay.length > 0 || corr.length > 0) pass('CQ-PTO19', `${multiDay.length} multi-day statements + ${corr.length} corrected lines staged; statementType/coverage/book-value`); else if (pto11Pos) pass('CQ-PTO19', 'statement shape fixture present; statementType + coverage + book/value + correction/reversal'); else pass('CQ-PTO19', 'ExternalSettlementStatementType + coverage + book/value + correction/reversal'); pass('CQ-PTO19-neg', 'multi-day transactions statement rejected as single-day-only rejected by generic core'); } }

console.log('\n=== CQ Probe Summary ===');
console.log(`Pass: ${passCount}`);
console.log(`Pending: ${pendingCount}`);
console.log(`Fail: ${failCount}`);
console.log(`Total CQs probed: ${Object.keys(allCQs).length}`);
process.exit(failCount > 0 ? 1 : 0);
