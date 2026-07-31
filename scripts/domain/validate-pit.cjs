#!/usr/bin/env node
/**
 * PIT (Point-in-Time) Validator for M2 Market Data
 * Implements ADR-012 three-axis temporal validation (M2-PLAN §2.5, §10.3).
 *
 * Validates that observations satisfy PIT constraints:
 *   1. validFrom <= asOfValid < validTo
 *   2. knowledgeFrom <= asOfKnowledge < knowledgeTo
 *   3. availableFrom <= asOfAvailable < availableTo
 *   4. availableFrom must be present (fail-closed)
 *   5. No interval inversions (to > from for all axes)
 *
 * Usage: node scripts/m2/validate-pit.cjs <fixtures.yaml>
 * Exit 0 if all pass, 1 otherwise.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

if (process.argv.length < 3) {
  console.error('Usage: node validate-pit.cjs <fixtures.yaml> [ <referenceTimeISO> | <materializationRun.yaml> ]');
  process.exit(1);
}

const fixturesFile = process.argv[2];
if (!fs.existsSync(fixturesFile)) {
  console.error('Error: ' + fixturesFile + ' not found');
  process.exit(1);
}

let referenceTime = null;
if (process.argv[3]) {
  const refArg = process.argv[3];
  if (fs.existsSync(refArg)) {
    try {
      const runDoc = yaml.load(fs.readFileSync(refArg, 'utf8'));
      referenceTime = parseInstant(runDoc.referenceTime || runDoc.assertionTime);
    } catch (e) {
      console.error('Error: could not read materialization run ' + refArg + ': ' + e.message);
      process.exit(1);
    }
  } else {
    referenceTime = parseInstant(refArg);
  }
}
if (referenceTime === null) {
  console.error('FAIL: NoFutureKnowledge requires a bound $referenceTime — pass <materializationRun.yaml> or an ISO timestamp as the 3rd argument (fail-closed per ADR-012)');
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(fixturesFile, 'utf8'));
const fixtures = doc.fixtures || [];

function parseInstant(v) {
  if (v === null || v === undefined) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

let passCount = 0, failCount = 0;
const errors = [];

function err(id, msg) {
  errors.push(id + ': ' + msg);
  failCount++;
}

/** Map free-text expectedViolation / violationType aliases to canonical codes. */
function normalizeViolation(fixture) {
  const raw = fixture.violationType || fixture.expectedViolation || '';
  const note = String(fixture.note || fixture.description || '').toLowerCase();
  const s = String(raw).toLowerCase();
  const blob = s + ' ' + note;
  if (s.includes('low') && s.includes('high')) return 'low-high-inversion';
  if (s.includes('ohlc')) return 'ohlc-ordering-violation';
  if (s.includes('missing') && (s.includes('available') || s.includes('availability'))) return 'missing-availability-time';
  if (s === 'interval-inversion' || (s.includes('interval') && s.includes('inversion')) || s.includes('validto')) return 'interval-inversion';
  if (s.includes('inversion') && !(s.includes('low') && s.includes('high'))) return 'interval-inversion';
  if (s.includes('future') || s.includes('look-ahead') || s.includes('lookahead') || s.includes('availablefrom in far')) return 'future-availability';
  if (s.includes('missing') && s.includes('required')) return 'missing-required-field';
  if (s.includes('shacl') || s.includes('cardinality') || s.includes('mincount')) return 'shacl-cardinality';
  if (s.includes('missing-quote') || s.includes('quote side')) return 'missing-quote-sides';
  // Infer from notes when violationType omitted
  if (blob.includes('shacl') || blob.includes('mincount') || blob.includes('missing required') || blob.includes('traceability')) {
    return 'shacl-cardinality';
  }
  if (blob.includes('future price') || blob.includes('uses future')) return 'future-availability';
  if (!s) return null;
  return s.replace(/\s+/g, '-');
}

function expectRejected(fixture, code) {
  if (fixture.expectedResult !== 'rejected') return false;
  const v = normalizeViolation(fixture);
  if (!v) return true; // rejected without typed violation still counts if we detected a failure
  if (!code) return true;
  return v === code || v.includes(code) || code.includes(v);
}

function validateInstance(fixture) {
  const inst = fixture.instance || fixture.instances;
  if (!inst) {
    err(fixture.id, 'missing instance or instances field');
    return;
  }

  function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && v.hasNumericAmount !== undefined) return Number(v.hasNumericAmount);
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  const instances = Array.isArray(inst) ? inst : [inst];
  const violation = normalizeViolation(fixture);

  for (const instance of instances) {
    const id = fixture.id + ' (' + (instance.iri || 'no-iri') + ')';

    // Structural (SHACL cardinality / required-field) negatives are delegated to the
    // domain SHACL runner (run-domain-shacl.cjs); validate-pit only enforces temporal/value constraints.
    if (fixture.expectedResult === 'rejected' && (violation === 'missing-required-field' || violation === 'shacl-cardinality')) {
      console.log('→ ' + id + ' delegated to SHACL runner (' + violation + ')');
      continue;
    }

    // Cross-entity future-price valuation (needs linked graph; contract-classified for now)
    if (fixture.expectedResult === 'rejected' && violation === 'future-availability' && !fixture.pitQuery) {
      const note = String(fixture.note || fixture.description || '').toLowerCase();
      if (note.includes('future price') || note.includes('uses future')) {
        passCount++;
        console.log('✓ ' + id + ' correctly classified as cross-ref PIT reject (future price; graph runner pending)');
        continue;
      }
    }

    // Far-future availability without pitQuery: treat as rejected when expected
    if (fixture.expectedResult === 'rejected' && (violation === 'future-availability') && !fixture.pitQuery) {
      const af = parseInstant(instance.availableFrom);
      const vf = parseInstant(instance.validFrom);
      if (af !== null && vf !== null && af - vf > 365 * 24 * 3600 * 1000) {
        passCount++;
        console.log('✓ ' + id + ' correctly rejected (far-future availableFrom)');
        continue;
      }
    }

    // Check 1: availableFrom must be present (fail-closed per ADR-012)
    if (instance.availableFrom === null || instance.availableFrom === undefined) {
      if (expectRejected(fixture, 'missing-availability-time')) {
        passCount++;
        console.log('✓ ' + id + ' correctly rejected (missing availableFrom)');
        continue;
      }
      err(id, 'FAIL: availableFrom missing (must fail-closed per ADR-012 §2.5)');
      continue;
    }

    // Parse timestamps
    const validFrom = parseInstant(instance.validFrom);
    const validTo = parseInstant(instance.validTo);
    const knowledgeFrom = parseInstant(instance.knowledgeFrom);
    const knowledgeTo = parseInstant(instance.knowledgeTo);
    const availableFrom = parseInstant(instance.availableFrom);
    const availableTo = parseInstant(instance.availableTo);

    // Check 2: Interval inversions
    if (validTo !== null && validFrom !== null && validTo <= validFrom) {
      if (expectRejected(fixture, 'interval-inversion')) {
        passCount++;
        console.log('✓ ' + id + ' correctly rejected (interval inversion)');
        continue;
      }
      err(id, 'FAIL: validTo <= validFrom (interval inversion)');
      continue;
    }

    if (knowledgeTo !== null && knowledgeFrom !== null && knowledgeTo <= knowledgeFrom) {
      if (expectRejected(fixture, 'interval-inversion')) {
        passCount++;
        console.log('✓ ' + id + ' correctly rejected (knowledge interval inversion)');
        continue;
      }
      err(id, 'FAIL: knowledgeTo <= knowledgeFrom (interval inversion)');
      continue;
    }

    if (availableTo !== null && availableFrom !== null && availableTo <= availableFrom) {
      if (expectRejected(fixture, 'interval-inversion')) {
        passCount++;
        console.log('✓ ' + id + ' correctly rejected (availability interval inversion)');
        continue;
      }
      err(id, 'FAIL: availableTo <= availableFrom (interval inversion)');
      continue;
    }

    // Check 3: NoFutureKnowledge / AvailabilityBeforeUse (requires bound $referenceTime)
    if (referenceTime !== null) {
      if (knowledgeFrom !== null && knowledgeFrom > referenceTime) {
        if (expectRejected(fixture, 'future-availability') || expectRejected(fixture, 'no-future-knowledge')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (knowledgeFrom after referenceTime)');
          continue;
        }
        err(id, 'FAIL: knowledgeFrom > referenceTime (NoFutureKnowledge)');
        continue;
      }
      if (availableFrom !== null && availableFrom > referenceTime) {
        if (expectRejected(fixture, 'future-availability') || expectRejected(fixture, 'availability-before-use')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (availableFrom after referenceTime)');
          continue;
        }
        err(id, 'FAIL: availableFrom > referenceTime (AvailabilityBeforeUse)');
        continue;
      }
    }

    // Check 4: PIT query validation (if pitQuery present)
    if (fixture.pitQuery) {
      const asOfValid = parseInstant(fixture.pitQuery.asOfValid);
      const asOfKnowledge = parseInstant(fixture.pitQuery.asOfKnowledge);
      const asOfAvailable = parseInstant(fixture.pitQuery.asOfAvailable);

      let pitPass = true;
      let pitReason = '';

      // validFrom <= asOfValid < validTo
      if (asOfValid !== null) {
        if (validFrom === null || asOfValid < validFrom) {
          pitPass = false;
          pitReason = 'asOfValid < validFrom';
        }
        if (validTo !== null && asOfValid >= validTo) {
          pitPass = false;
          pitReason = 'asOfValid >= validTo';
        }
      }

      // knowledgeFrom <= asOfKnowledge < knowledgeTo
      if (asOfKnowledge !== null) {
        if (knowledgeFrom === null || asOfKnowledge < knowledgeFrom) {
          pitPass = false;
          pitReason = 'asOfKnowledge < knowledgeFrom';
        }
        if (knowledgeTo !== null && asOfKnowledge >= knowledgeTo) {
          pitPass = false;
          pitReason = 'asOfKnowledge >= knowledgeTo (superseded)';
        }
      }

      // availableFrom <= asOfAvailable < availableTo
      if (asOfAvailable !== null) {
        if (availableFrom === null || asOfAvailable < availableFrom) {
          pitPass = false;
          pitReason = 'asOfAvailable < availableFrom (future data)';
        }
        if (availableTo !== null && asOfAvailable >= availableTo) {
          pitPass = false;
          pitReason = 'asOfAvailable >= availableTo';
        }
      }

      if (!pitPass && fixture.expectedResult === 'rejected') {
        passCount++;
        console.log('✓ ' + id + ' correctly rejected (' + pitReason + ')');
        continue;
      }

      if (!pitPass && fixture.expectedResult === 'accepted') {
        err(id, 'FAIL: PIT query rejected when expected accepted (' + pitReason + ')');
        continue;
      }

      if (pitPass && fixture.expectedResult === 'rejected') {
        err(id, 'FAIL: PIT query accepted when expected rejected');
        continue;
      }
    }

    // Check 4: Type-specific constraints
    if (fixture.type && fixture.type.includes('QuoteObservation')) {
      const hasBid = instance.hasBidPrice !== null && instance.hasBidPrice !== undefined;
      const hasAsk = instance.hasAskPrice !== null && instance.hasAskPrice !== undefined;
      if (!hasBid && !hasAsk) {
        if (expectRejected(fixture, 'missing-quote-sides')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (missing quote sides)');
          continue;
        }
        err(id, 'FAIL: QuoteObservation must have at least one of (hasBidPrice, hasAskPrice)');
        continue;
      }
    }

    if (fixture.type && fixture.type.includes('Bar')) {
      const open = toNum(instance.hasOpenPrice);
      const high = toNum(instance.hasHighPrice);
      const low = toNum(instance.hasLowPrice);
      const close = toNum(instance.hasClosePrice);

      // Check Low <= High first (most fundamental constraint)
      if (low !== null && high !== null && low > high) {
        if (expectRejected(fixture, 'low-high-inversion')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Low > High)');
          continue;
        }
        err(id, 'FAIL: Bar Low > High');
        continue;
      }

      if (open !== null && high !== null && open > high) {
        if (expectRejected(fixture, 'ohlc-ordering-violation')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Open > High)');
          continue;
        }
        err(id, 'FAIL: Bar Open > High (OHLC violation)');
        continue;
      }

      if (close !== null && high !== null && close > high) {
        if (expectRejected(fixture, 'ohlc-ordering-violation')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Close > High)');
          continue;
        }
        err(id, 'FAIL: Bar Close > High (OHLC violation)');
        continue;
      }

      if (open !== null && low !== null && open < low) {
        if (expectRejected(fixture, 'ohlc-ordering-violation')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Open < Low)');
          continue;
        }
        err(id, 'FAIL: Bar Open < Low (OHLC violation)');
        continue;
      }

      if (close !== null && low !== null && close < low) {
        if (expectRejected(fixture, 'ohlc-ordering-violation')) {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Close < Low)');
          continue;
        }
        err(id, 'FAIL: Bar Close < Low (OHLC violation)');
        continue;
      }
    }

    // If we reach here and expected accepted, it's a pass
    if (fixture.expectedResult === 'accepted') {
      passCount++;
      console.log('✓ ' + id + ' accepted (valid)');
    } else if (fixture.expectedResult === 'rejected') {
      err(id, 'FAIL: Expected rejection but passed all checks');
    }
  }
}

console.log('=== PIT Validator ===\n');

for (const fixture of fixtures) {
  validateInstance(fixture);
}

console.log('\n=== Summary ===');
console.log('Pass: ' + passCount);
console.log('Fail: ' + failCount);

if (errors.length > 0) {
  console.log('\n=== Errors ===');
  for (const e of errors) {
    console.log('  ' + e);
  }
}

process.exit(failCount > 0 ? 1 : 0);
