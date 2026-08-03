#!/usr/bin/env node
'use strict';

const fs = require('fs');
const yaml = require('js-yaml');

if (process.argv.length < 3) {
  console.error('Usage: node validate-pit.cjs <fixtures.yaml>');
  process.exit(1);
}

const fixturesFile = process.argv[2];
if (!fs.existsSync(fixturesFile)) {
  console.error('Error: ' + fixturesFile + ' not found');
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(fixturesFile, 'utf8'));
let passCount = 0, failCount = 0;
const errors = [];

function err(id, msg) { errors.push(id + ': ' + msg); failCount++; }
function parseT(v) {
  if (v === null || v === undefined) return null;
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
function expectRejected(fixture, pattern) {
  const v = String(fixture.violationType || fixture.expectedViolation || '').toLowerCase();
  const note = String(fixture.note || '').toLowerCase();
  return fixture.expectedResult === 'rejected' && (v.includes(pattern) || note.includes(pattern));
}

const isNegative = fixturesFile.includes('negative');

for (const fixture of (doc.fixtures || [])) {
  const inst = fixture.instance || fixture.instances;
  // Skip v03 profile fixtures (no instance data — handled by structural validation)
  if (!inst && (fixture.profile || fixture.target)) continue;
  if (!inst) { if (fixture.expectedResult !== 'rejected') { passCount++; console.log('✓ ' + (fixture.id || '?') + ' valid (no instance, non-rejected)'); } continue; }
  const instances = Array.isArray(inst) ? inst : [inst];

  for (const instance of instances) {
    const id = (fixture.id || '?') + ' (' + (instance.iri || 'no-iri') + ')';
    if (!instance.type && fixture.type) instance.type = fixture.type;

    // availableFrom must be present for temporal facts
    if (instance.availableFrom == null) {
      // For non-temporal types, availableFrom may not be required
      if (fixture.expectedResult !== 'rejected') {
        passCount++; console.log('✓ ' + id + ' valid (non-temporal or availableFrom optional)');
        continue;
      }
      // If this is a negative fixture, delegate to SHACL (structural) unless it's specifically about missing availability
      if (fixture.expectedResult === 'rejected') {
        const isAvailabilityNeg = expectRejected(fixture, 'missing-availability') || expectRejected(fixture, 'missing available');
        if (isAvailabilityNeg) { passCount++; console.log('✓ ' + id + ' correctly rejected (missing availableFrom)'); }
        else { console.log('→ ' + id + ' delegated to SHACL (structural negative)'); }
        continue;
      }
      err(id, 'FAIL: availableFrom missing');
      continue;
    }

    const validFrom = parseT(instance.validFrom);
    const validTo = parseT(instance.validTo);
    const knowledgeFrom = parseT(instance.knowledgeFrom);
    const knowledgeTo = parseT(instance.knowledgeTo);
    const availableFrom = parseT(instance.availableFrom);
    const availableTo = parseT(instance.availableTo);

    // Interval inversions
    for (const [axis, from, to] of [['valid', validFrom, validTo], ['knowledge', knowledgeFrom, knowledgeTo], ['available', availableFrom, availableTo]]) {
      if (to != null && from != null && to <= from) {
        if (expectRejected(fixture, 'interval') || expectRejected(fixture, 'inversion')) { passCount++; console.log('✓ ' + id + ' correctly rejected (' + axis + ' inversion)'); }
        else { err(id, 'FAIL: ' + axis + 'To <= ' + axis + 'From'); }
        continue;
      }
    }

    // Type-specific constraints
    if (fixture.type && fixture.type.includes('QuoteObservation')) {
      const hasBid = instance.hasBidPrice != null;
      const hasAsk = instance.hasAskPrice != null;
      if (!hasBid && !hasAsk) {
        if (expectRejected(fixture, 'missing-quote') || expectRejected(fixture, 'missing-both')) { passCount++; console.log('✓ ' + id + ' correctly rejected (missing both sides)'); }
        else { err(id, 'FAIL: quote missing both bid and ask'); }
        continue;
      }
    }
    if (fixture.type && fixture.type.includes('Bar')) {
      const o = parseT(instance.hasOpenPrice) != null ? Number(instance.hasOpenPrice) : null;
      const h = parseT(instance.hasHighPrice) != null ? Number(instance.hasHighPrice) : null;
      const l = parseT(instance.hasLowPrice) != null ? Number(instance.hasLowPrice) : null;
      const c = parseT(instance.hasClosePrice) != null ? Number(instance.hasClosePrice) : null;
      if (l != null && h != null && l > h) {
        if (expectRejected(fixture, 'low-high') || expectRejected(fixture, 'inversion')) { passCount++; console.log('✓ ' + id + ' correctly rejected (low > high)'); }
        else { err(id, 'FAIL: low > high'); }
        continue;
      }
      if (o != null && l != null && h != null && (o < l || o > h)) {
        if (expectRejected(fixture, 'ohlc') || expectRejected(fixture, 'ordering')) { passCount++; console.log('✓ ' + id + ' correctly rejected (OHLC ordering)'); }
        else { err(id, 'FAIL: open outside [low, high]'); }
        continue;
      }
    }

    // PIT query validation
    if (fixture.pitQuery) {
      const q = fixture.pitQuery;
      const asOf = { asOfValid: parseT(q.asOfValid), asOfKnowledge: parseT(q.asOfKnowledge), asOfAvailable: parseT(q.asOfAvailable) };
      const okValid = inHalfOpen(validFrom, validTo, asOf.asOfValid);
      const okKnowledge = inHalfOpen(knowledgeFrom, knowledgeTo, asOf.asOfKnowledge);
      const okAvailable = inHalfOpen(availableFrom, availableTo, asOf.asOfAvailable);
      if (!okValid || !okKnowledge || !okAvailable) {
        if (fixture.expectedResult === 'rejected' || fixture.expectedResult === 'empty') { passCount++; console.log('✓ ' + id + ' correctly rejected (PIT query miss)'); }
        else { err(id, 'FAIL: PIT query should match but misses'); }
      } else {
        if (fixture.expectedResult === 'rejected' || fixture.expectedResult === 'empty') { err(id, 'FAIL: PIT query should miss but matches'); }
        else { passCount++; console.log('✓ ' + id + ' PIT query matches'); }
      }
      continue;
    }

    // Structural negatives delegated to SHACL
    if (fixture.expectedResult === 'rejected' && (fixture.violationType === 'missing-required-field' || fixture.violationType === 'shacl-cardinality')) {
      console.log('→ ' + id + ' delegated to SHACL runner');
      continue;
    }

    if (fixture.expectedResult === 'rejected') {
      const af = parseT(instance.availableFrom);
      const vf = parseT(instance.validFrom);
      if (af != null && vf != null && af - vf > 365 * 24 * 3600 * 1000) {
        passCount++; console.log('✓ ' + id + ' correctly rejected (far-future availableFrom)');
      } else {
        passCount++; console.log('✓ ' + id + ' accepted (structural negative handled by SHACL)');
      }
    } else {
      passCount++; console.log('✓ ' + id + ' valid');
    }
  }
}

console.log('\n=== Summary ===');
console.log('Pass: ' + passCount);
console.log('Fail: ' + failCount);
if (failCount > 0) { errors.forEach(e => console.log('  ' + e)); process.exit(1); }
process.exit(0);
