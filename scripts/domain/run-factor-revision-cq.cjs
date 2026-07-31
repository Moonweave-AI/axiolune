#!/usr/bin/env node
/**
 * FactorObservation revision-selection CQ (R4-M1).
 *
 * Qlib PIT model: (publication/date, period, value, _next). Selecting "as-of knowledge"
 * must walk nextRevision and pick the revision whose knowledge interval covers asOfKnowledge
 * — not merely accept that each revision independently has valid axis intervals.
 *
 * Exit 0 on PASS.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'factor-observation-revision.yaml');
const CQ = path.join(ROOT, 'tests', 'm2', 'competency-queries', 'cq-factor-revision.yaml');

function parseT(v) {
  if (v == null) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function inHalfOpen(from, to, asOf) {
  if (asOf == null) return true;
  if (from == null || asOf < from) return false;
  if (to != null && asOf >= to) return false;
  return true;
}

function loadInstances(doc) {
  const byIri = {};
  for (const fx of doc.fixtures || []) {
    const inst = fx.instances || fx.instance;
    const list = Array.isArray(inst) ? inst : inst ? [inst] : [];
    for (const i of list) {
      if (i && i.iri) byIri[i.iri] = i;
    }
  }
  return byIri;
}

/** Find chain heads: observations that are not targets of any nextRevision. */
function chainHeads(byIri) {
  const targets = new Set();
  for (const o of Object.values(byIri)) {
    if (o.nextRevision) targets.add(o.nextRevision);
  }
  return Object.values(byIri).filter((o) => !targets.has(o.iri));
}

/**
 * Walk nextRevision from head; return the observation valid under three-axis asOf,
 * preferring the latest revision in the chain that still covers asOfKnowledge
 * (Qlib: follow _next until publication date exceeds as-of).
 */
function selectRevision(head, byIri, asOf) {
  const asOfK = parseT(asOf.asOfKnowledge);
  const asOfV = parseT(asOf.asOfValid);
  const asOfA = parseT(asOf.asOfAvailable);
  let cur = head;
  let selected = null;
  const visited = new Set();
  while (cur && !visited.has(cur.iri)) {
    visited.add(cur.iri);
    const kOk = inHalfOpen(parseT(cur.knowledgeFrom), parseT(cur.knowledgeTo), asOfK);
    const vOk = inHalfOpen(parseT(cur.validFrom), parseT(cur.validTo), asOfV);
    const aOk =
      cur.availableFrom == null
        ? false
        : inHalfOpen(parseT(cur.availableFrom), parseT(cur.availableTo), asOfA);
    // Qlib semantics: a revision published at knowledgeFrom is usable once asOfKnowledge >= knowledgeFrom
    // and before it is superseded (knowledgeTo). Also require valid/available axes.
    if (kOk && vOk && aOk) selected = cur;
    // Continue walking even after selecting — later revision may supersede if still in window
    cur = cur.nextRevision ? byIri[cur.nextRevision] : null;
  }
  return selected;
}

/** Naive baseline that would wrongly return the terminal node regardless of asOf. */
function naiveTerminal(head, byIri) {
  let cur = head;
  const visited = new Set();
  while (cur && cur.nextRevision && !visited.has(cur.iri)) {
    visited.add(cur.iri);
    cur = byIri[cur.nextRevision];
  }
  return cur;
}

const fixtureDoc = yaml.load(fs.readFileSync(FIXTURE, 'utf8'));
const cqDoc = yaml.load(fs.readFileSync(CQ, 'utf8'));
const byIri = loadInstances(fixtureDoc);
const heads = chainHeads(byIri).filter((h) => h.hasFactorPeriod === '2024Q1');

let failed = 0;
function pass(id, detail) {
  console.log('✓ ' + id + ': ' + detail);
}
function fail(id, detail) {
  failed++;
  console.error('✗ ' + id + ': ' + detail);
}

if (heads.length !== 1) {
  fail('setup', `expected one 2024Q1 chain head, got ${heads.length}`);
} else {
  pass('setup', `chain head ${heads[0].iri}`);
}

const head = heads[0];

for (const probe of cqDoc.probes || []) {
  const selected = selectRevision(head, byIri, probe.asOf);
  if (!selected) {
    if (probe.expectedResult === 'empty') pass(probe.id, 'empty as expected');
    else fail(probe.id, 'no revision selected');
    continue;
  }
  const okIri = selected.iri === probe.expected.observationIri;
  const actualVal = typeof selected.hasFactorValue === 'object' && selected.hasFactorValue ? selected.hasFactorValue.hasNumericAmount : selected.hasFactorValue;
  const okVal = String(actualVal) === String(probe.expected.factorValue);
  if (okIri && okVal) pass(probe.id, `selected ${selected.iri} value=${actualVal}`);
  else fail(probe.id, `got ${selected.iri}/${actualVal}, expected ${probe.expected.observationIri}/${probe.expected.factorValue}`);

  if (probe.assertNotNaiveTerminal) {
    const term = naiveTerminal(head, byIri);
    if (term && term.iri === selected.iri && probe.expected.observationIri !== term.iri) {
      fail(probe.id + '-naive', 'selection collapsed to terminal (did not walk knowledge)');
    } else if (term && selected.iri !== term.iri) {
      pass(probe.id + '-naive', `differs from naive terminal ${term.iri}`);
    }
  }
}

console.log('\n=== Factor revision CQ ===');
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
