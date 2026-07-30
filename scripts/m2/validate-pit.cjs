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
  console.error('Usage: node validate-pit.cjs <fixtures.yaml>');
  process.exit(1);
}

const fixturesFile = process.argv[2];
if (!fs.existsSync(fixturesFile)) {
  console.error('Error: ' + fixturesFile + ' not found');
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(fixturesFile, 'utf8'));
const fixtures = doc.fixtures || [];

let passCount = 0, failCount = 0;
const errors = [];

function err(id, msg) {
  errors.push(id + ': ' + msg);
  failCount++;
}

function parseInstant(v) {
  if (v === null || v === undefined) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

function validateInstance(fixture) {
  const inst = fixture.instance || fixture.instances;
  if (!inst) {
    err(fixture.id, 'missing instance or instances field');
    return;
  }

  const instances = Array.isArray(inst) ? inst : [inst];

  for (const instance of instances) {
    const id = fixture.id + ' (' + (instance.iri || 'no-iri') + ')';

    // Check 1: availableFrom must be present (fail-closed per ADR-012)
    if (instance.availableFrom === null || instance.availableFrom === undefined) {
      if (fixture.expectedResult === 'rejected' && fixture.violationType === 'missing-availability-time') {
        // Expected failure
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
      if (fixture.expectedResult === 'rejected' && fixture.violationType === 'interval-inversion') {
        // Expected failure
        continue;
      }
      err(id, 'FAIL: validTo <= validFrom (interval inversion)');
      continue;
    }

    if (knowledgeTo !== null && knowledgeFrom !== null && knowledgeTo <= knowledgeFrom) {
      err(id, 'FAIL: knowledgeTo <= knowledgeFrom (interval inversion)');
      continue;
    }

    if (availableTo !== null && availableFrom !== null && availableTo <= availableFrom) {
      err(id, 'FAIL: availableTo <= availableFrom (interval inversion)');
      continue;
    }

    // Check 3: PIT query validation (if pitQuery present)
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
        // Expected PIT failure
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
        if (fixture.expectedResult === 'rejected' && fixture.violationType === 'missing-quote-sides') {
          // Expected failure
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (missing quote sides)');
          continue;
        }
        err(id, 'FAIL: QuoteObservation must have at least one of (hasBidPrice, hasAskPrice)');
        continue;
      }
    }

    if (fixture.type && fixture.type.includes('Bar')) {
      const open = instance.hasOpenPrice;
      const high = instance.hasHighPrice;
      const low = instance.hasLowPrice;
      const close = instance.hasClosePrice;

      // Check Low <= High first (most fundamental constraint)
      if (low !== null && high !== null && low > high) {
        if (fixture.expectedResult === 'rejected' && fixture.violationType === 'low-high-inversion') {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Low > High)');
          continue;
        }
        err(id, 'FAIL: Bar Low > High');
        continue;
      }

      // Then check Open/Close against High/Low
      if (open !== null && high !== null && open > high) {
        if (fixture.expectedResult === 'rejected' && fixture.violationType === 'ohlc-ordering-violation') {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Open > High)');
          continue;
        }
        err(id, 'FAIL: Bar Open > High (OHLC violation)');
        continue;
      }

      if (close !== null && high !== null && close > high) {
        if (fixture.expectedResult === 'rejected' && fixture.violationType === 'ohlc-ordering-violation') {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Close > High)');
          continue;
        }
        err(id, 'FAIL: Bar Close > High (OHLC violation)');
        continue;
      }

      if (open !== null && low !== null && open < low) {
        if (fixture.expectedResult === 'rejected' && fixture.violationType === 'ohlc-ordering-violation') {
          passCount++;
          console.log('✓ ' + id + ' correctly rejected (Open < Low)');
          continue;
        }
        err(id, 'FAIL: Bar Open < Low (OHLC violation)');
        continue;
      }

      if (close !== null && low !== null && close < low) {
        if (fixture.expectedResult === 'rejected' && fixture.violationType === 'ohlc-ordering-violation') {
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
