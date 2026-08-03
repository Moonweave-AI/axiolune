#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const SYN = path.join(ROOT, 'mappings', 'finance', 'synthetic');
const CAPABILITY = 'minimal-slot-interpreter-v0';

function loadYaml(rel) { return yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

function compareUtf8(l, r) { return Buffer.compare(Buffer.from(l, 'utf8'), Buffer.from(r, 'utf8')); }

function resolvePath(ctx, dotPath) {
  let cur = ctx;
  for (const p of String(dotPath).split('.')) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

function expandTemplate(tpl, ctx) {
  return String(tpl).replace(/\{([^}]+)\}/g, (_, key) => {
    const v = resolvePath(ctx, key.trim());
    if (v == null || v === '') throw new Error(`unresolved iriTemplate slot {${key}}`);
    return String(v);
  });
}

function resolveBinding(binding, ctx) {
  if (!binding) return undefined;
  if (binding.field != null) return resolvePath(ctx, binding.field);
  if (binding.iriTemplate != null) return expandTemplate(binding.iriTemplate, ctx);
  if (binding.literal != null) return binding.literal;
  throw new Error('binding requires field|iriTemplate|literal');
}

function parseJoinSide(side) {
  const i = String(side).indexOf('.');
  if (i < 0) throw new Error('bad join side: ' + side);
  return { table: side.slice(0, i), column: side.slice(i + 1) };
}

function buildContexts(fromTable, rows, joins) {
  const baseRows = rows[fromTable] || [];
  return baseRows.map((row) => {
    const ctx = { [fromTable]: { ...row } };
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const j of joins || []) {
        const L = parseJoinSide(j.left);
        const R = parseJoinSide(j.right);
        const tryAttach = (have, need) => {
          if (!ctx[have.table] || ctx[need.table]) return false;
          const key = ctx[have.table][have.column];
          const candidates = (rows[need.table] || []).filter((r) => r[need.column] === key);
          if (candidates.length !== 1) throw new Error(`join expected 1 row, got ${candidates.length}`);
          ctx[need.table] = { ...candidates[0] };
          return true;
        };
        if (tryAttach(L, R) || tryAttach(R, L)) progressed = true;
      }
    }
    return ctx;
  });
}

function slotKey(sm) {
  if (sm.slotLocal) return sm.slotLocal;
  if (sm.slotRole) return sm.slotRole;
  if (sm.slot) { const parts = String(sm.slot).split('/'); return parts[parts.length - 1]; }
  throw new Error('slotMapping missing slotLocal|slotRole|slot');
}

function interpretMapping(mapping, contract) {
  if (mapping.runnerCapability !== CAPABILITY) throw new Error(`unsupported runnerCapability=${mapping.runnerCapability}`);
  const rows = contract.rows;
  const joins = (mapping.source && mapping.source.rowSet && mapping.source.rowSet.joins) || [];
  const facts = [];
  const seen = new Set();
  for (const target of mapping.targets || []) {
    const fromTable = target.fromTable;
    if (!fromTable) throw new Error('target missing fromTable: ' + target.targetTypeIri);
    const contexts = buildContexts(fromTable, rows, joins);
    for (const ctx of contexts) {
      const iri = expandTemplate(target.identity.iriTemplate, ctx);
      if (seen.has(iri + '|' + target.targetTypeIri)) continue;
      seen.add(iri + '|' + target.targetTypeIri);
      const fact = { iri, type: target.targetTypeIri };
      for (const sm of target.slotMappings || []) {
        const key = slotKey(sm);
        const val = resolveBinding(sm.binding, ctx);
        if (val !== undefined) fact[key] = val;
      }
      if (target.temporal) {
        for (const [axis, bind] of Object.entries(target.temporal)) {
          const v = resolveBinding(bind, ctx);
          fact[axis] = (v !== undefined && v !== null && v !== '') ? v : null;
        }
      }
      if (target.provenance) {
        for (const [k, bind] of Object.entries(target.provenance)) {
          const v = resolveBinding(bind, ctx);
          if (v !== undefined) fact[k] = v;
        }
      }
      facts.push(fact);
    }
  }
  facts.sort((a, b) => compareUtf8(a.type + a.iri, b.type + b.iri));
  return { materializer: CAPABILITY, mappingIri: mapping.iri, facts };
}

function parseT(v) {
  if (v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}
function inHalfOpen(from, to, asOf) {
  if (asOf == null) return true;
  if (from == null) return false;
  if (asOf < from) return false;
  if (to != null && asOf >= to) return false;
  return true;
}
function pitOk(fact, asOf) {
  if (fact.availableFrom == null) return { ok: false, reason: 'missing-availableFrom' };
  const checks = [
    ['valid', fact.validFrom, fact.validTo, asOf.asOfValid],
    ['knowledge', fact.knowledgeFrom, fact.knowledgeTo, asOf.asOfKnowledge],
    ['available', fact.availableFrom, fact.availableTo, asOf.asOfAvailable],
  ];
  for (const [axis, from, to, asOfT] of checks) {
    if (!inHalfOpen(parseT(from), parseT(to), parseT(asOfT))) return { ok: false, reason: axis + '-axis-miss' };
  }
  return { ok: true };
}

const contract = loadYaml('mappings/finance/synthetic/slice-a-source-contract.yaml');
const mapping = loadYaml('mappings/finance/synthetic/slice-a-semantic-mapping.yaml');
const cqDoc = loadYaml('tests/m2/competency-queries/cq-s1-s5.yaml');

const staging = interpretMapping(mapping, contract);
const futureLeakAsOf = { asOfValid: '2026-07-29T14:30:00Z', asOfKnowledge: '2026-07-29T14:30:00.123Z', asOfAvailable: '2026-07-29T14:30:00.100Z' };

let failed = 0;
const results = [];
function pass(id, detail) { results.push({ id, status: 'PASS', detail }); console.log('✓ ' + id + ': ' + detail); }
function fail(id, detail) { failed++; results.push({ id, status: 'FAIL', detail }); console.error('✗ ' + id + ': ' + detail); }

function find(typeSuffix) { return staging.facts.filter((f) => f.type.endsWith(typeSuffix)); }

// Interpreter proof
{
  if (staging.materializer !== CAPABILITY) fail('R3-M1', 'materializer not interpreter');
  else if (!staging.facts.some((f) => f.type.endsWith('LegalEntity'))) fail('R3-M1', 'LegalEntity missing');
  else if (!staging.facts.some((f) => f.type.endsWith('PriceObservation') && f.hasPriceValue != null)) fail('R3-M1', 'PriceObservation slots not filled');
  else pass('R3-M1', `interpreter produced ${staging.facts.length} facts`);
}

// CQ-S1
{
  const probe = cqDoc.probes.find((p) => p.id === 'CQ-S1');
  const instruments = find('FinancialInstrument');
  const match = instruments.filter((i) => i.hasPrimaryIdentifier === probe.expected.isin && i.internalId === 'AX-EQ-AAPL');
  if (match.length === 1 && match[0].issuerName === probe.expected.issuerName && match[0].iri === probe.expected.instrumentIri) pass('CQ-S1', `unique Instrument ${match[0].iri} issued by ${match[0].issuerName}`);
  else fail('CQ-S1', `expected unique instrument, got ${JSON.stringify(match)}`);

  const negProbe = probe.negative || {};
  if (negProbe.expectedResult === 'rejected-or-isolated') {
    function identifierUniquenessOk(instrs) {
      const seen = new Map();
      for (const i of instrs) { const key = `${i.hasPrimaryIdentifier}|${i.internalId}`; if (seen.has(key)) return { ok: false, conflict: `${i.iri} duplicates ${seen.get(key)}` }; seen.set(key, i.iri); }
      return { ok: true };
    }
    const cleanCheck = identifierUniquenessOk(instruments);
    const conflict = JSON.parse(JSON.stringify(instruments));
    conflict.push({ iri: 'https://axiolune.ai/data/instruments/AX-EQ-DUP', type: 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument', hasPrimaryIdentifier: probe.expected.isin, internalId: 'AX-EQ-AAPL', issuerName: 'Conflict Corp', validFrom: '2026-07-29T14:30:00Z', knowledgeFrom: '2026-07-29T21:05:00Z', availableFrom: '2026-07-29T21:05:00Z' });
    const conflictCheck = identifierUniquenessOk(conflict);
    if (cleanCheck.ok && !conflictCheck.ok) pass('CQ-S1-neg', `duplicate ISIN rejected (${conflictCheck.conflict})`);
    else fail('CQ-S1-neg', 'uniqueness validator did not catch duplicate');
  }
}

// CQ-S2
{
  const probe = cqDoc.probes.find((p) => p.id === 'CQ-S2');
  const prices = find('PriceObservation');
  const ok = prices.filter((p) => pitOk(p, probe.asOf).ok && p.hasPriceKind === 'Last');
  if (ok.length === 1 && ok[0].iri === probe.expected.priceObsIri && String(ok[0].hasPriceValue) === String(probe.expected.priceValue)) pass('CQ-S2', `price ${ok[0].hasPriceValue} @ ${ok[0].iri}`);
  else fail('CQ-S2', `expected one Last price, got ${ok.length}`);
  const leak = prices.filter((p) => pitOk(p, futureLeakAsOf).ok);
  if (leak.length === 0) pass('CQ-S2-neg', 'pre-availability returns empty');
  else fail('CQ-S2-neg', 'future data leaked');
}

// CQ-S3
{
  const probe = cqDoc.probes.find((p) => p.id === 'CQ-S3');
  const holdings = find('HoldingSnapshot').filter((h) => pitOk(h, probe.asOf).ok);
  if (holdings.length === 1 && holdings[0].iri === probe.expected.holdingIri && String(holdings[0].hasQuantity) === String(probe.expected.quantity)) pass('CQ-S3', `holding qty=${holdings[0].hasQuantity}`);
  else fail('CQ-S3', `expected holding, got ${JSON.stringify(holdings)}`);
  if (holdings.length) {
    const bad = JSON.parse(JSON.stringify(holdings[0]));
    bad.validTo = '2026-07-28T00:00:00Z';
    if (!pitOk(bad, probe.asOf).ok) pass('CQ-S3-neg', 'interval-inverted holding rejected');
    else fail('CQ-S3-neg', 'interval inversion not rejected');
  }
}

// CQ-S4
{
  const probe = cqDoc.probes.find((p) => p.id === 'CQ-S4');
  const vals = find('PositionValuation').filter((v) => pitOk(v, probe.asOf).ok);
  if (vals.length === 1 && vals[0].iri === probe.expected.valuationIri && vals[0].usesPriceObservation === probe.expected.priceObsIri && String(vals[0].hasMarketValue) === String(probe.expected.marketValue) && vals[0].hasCurrencyCode === probe.expected.currency) pass('CQ-S4', `valuation→price chain ${vals[0].usesPriceObservation}`);
  else fail('CQ-S4', `traceability break: ${JSON.stringify(vals)}`);
  const px = find('PriceObservation')[0];
  if (px) {
    const revised = JSON.parse(JSON.stringify(px));
    revised.availableFrom = '2099-01-01T00:00:00Z';
    if (!pitOk(revised, probe.asOf).ok) pass('CQ-S4-neg', 'future-revised price rejected');
    else fail('CQ-S4-neg', 'future-revised price not rejected');
  }
}

// CQ-S5 — replay determinism (same inputs → same facts)
{
  const staging2 = interpretMapping(mapping, contract);
  const same = JSON.stringify(staging2.facts) === JSON.stringify(staging.facts);
  if (same) pass('CQ-S5', 'replay produces identical staging facts');
  else fail('CQ-S5', 'replay facts differ');
  const mutated = JSON.parse(JSON.stringify(staging));
  mutated.facts.push({ iri: 'https://axiolune.ai/data/market-data/px-future', type: 'https://axiolune.ai/ontology/finance/market-data/PriceObservation', hasPriceValue: '999', validFrom: '2099-01-01T00:00:00Z', knowledgeFrom: '2099-01-01T00:00:00Z', availableFrom: '2099-01-01T00:00:00Z' });
  const histAsOf = cqDoc.probes.find((p) => p.id === 'CQ-S2').asOf;
  const histPrices = staging.facts.filter((f) => f.type.endsWith('PriceObservation') && pitOk(f, histAsOf).ok);
  const histPricesMut = mutated.facts.filter((f) => f.type.endsWith('PriceObservation') && pitOk(f, histAsOf).ok);
  if (histPrices.length === histPricesMut.length && histPrices[0].iri === histPricesMut[0].iri) pass('CQ-S5-neg', 'future append does not change historical answer');
  else fail('CQ-S5-neg', 'historical answer changed');
}

console.log('\n=== Slice A Summary ===');
console.log('Pass/Fail:', results.filter((r) => r.status === 'PASS').length, '/', failed);
process.exit(failed > 0 ? 1 : 0);
