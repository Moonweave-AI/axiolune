#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BINDING_ROWS,
  CUSTOM_CONSTRAINT_COUNT,
  canonicalJcs,
} = require('./lib/foundation-market-strategy-custom-validators.cjs');
const {
  COMPONENT_DISCOVERY_PATHS,
} = require('./lib/m2-toolchain-lock-builder.cjs');
const {
  decodeCanonicalEvidencePayload,
  encodeCanonicalEvidencePayload,
  validateEvidenceNumbers,
} = require('./lib/foundation-market-strategy-payload-codec.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_ROOT = path.join(
  ROOT,
  'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0',
);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function run(file, argument) {
  const result = spawnSync(process.execPath, [file, argument], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  requireCondition(result.status === 0, `${path.basename(file)} ${argument} failed with exit ${result.status}`);
}

function main() {
  const astral = '\u{10000}';
  const bmpPrivateUse = '\uE000';
  requireCondition(
    canonicalJcs({ [bmpPrivateUse]: 1, [astral]: 2 })
      === `{"${astral}":2,"${bmpPrivateUse}":1}`,
    'runtime JCS does not use RFC 8785 UTF-16 property ordering',
  );
  let rejectedUnpairedSurrogate = false;
  try {
    canonicalJcs({ broken: '\uD800' });
  } catch (error) {
    rejectedUnpairedSurrogate = /unpaired Unicode surrogate/u.test(error.message);
  }
  requireCondition(rejectedUnpairedSurrogate, 'runtime JCS accepted an unpaired Unicode surrogate');

  const encodedDecimal = encodeCanonicalEvidencePayload({ decimal: 0.25, integer: 25 });
  requireCondition(
    canonicalJcs(encodedDecimal)
      === '{"decimalPaths":["/decimal"],"payload":{"decimal":"0.25","integer":25}}',
    'binary64 fixture decimal was not converted to the canonical signed string dialect',
  );
  requireCondition(
    decodeCanonicalEvidencePayload(
      encodedDecimal.payload,
      encodedDecimal.decimalPaths,
    ).decimal === 0.25,
    'canonical decimal-string transport did not decode for the reviewed semantic validator',
  );
  for (const lexical of ['1.0', '1.2300', '-0.0', '0.10000000000000001']) {
    let rejectedLossyLexical = false;
    try {
      decodeCanonicalEvidencePayload({ decimal: lexical }, ['/decimal']);
    } catch (error) {
      rejectedLossyLexical = /lossless canonical lexical form/u.test(error.message);
    }
    requireCondition(
      rejectedLossyLexical,
      `signed evidence accepted lossy or non-canonical decimal lexical ${lexical}`,
    );
  }
  let rejectedBinary64 = false;
  try {
    validateEvidenceNumbers({ decimal: 0.25 });
  } catch (error) {
    rejectedBinary64 = /safe integers/u.test(error.message);
  }
  requireCondition(rejectedBinary64, 'signed evidence accepted a binary64 decimal JSON number');
  let rejectedUnsafeInteger = false;
  try {
    encodeCanonicalEvidencePayload({ value: 9_007_199_254_740_992 });
  } catch (error) {
    rejectedUnsafeInteger = /unsafe integer/u.test(error.message);
  }
  requireCondition(rejectedUnsafeInteger, 'signed evidence accepted an unsafe integer');

  requireCondition(CUSTOM_CONSTRAINT_COUNT === 57, 'reviewed definition count is not exactly 57');
  requireCondition(BINDING_ROWS.length === CUSTOM_CONSTRAINT_COUNT, 'definition inventory count drift');
  requireCondition(new Set(BINDING_ROWS.map((row) => row.validatorId)).size === CUSTOM_CONSTRAINT_COUNT, 'validator IDs are not independent');
  requireCondition(new Set(BINDING_ROWS.map((row) => row.dispatchDigest)).size === CUSTOM_CONSTRAINT_COUNT, 'dispatch digests are not independent');
  requireCondition(
    COMPONENT_DISCOVERY_PATHS.includes(
      'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/discovery-contract.json',
    ),
    'release lock builder does not consume the six-module discovery contract',
  );

  run(path.join(ROOT, 'scripts/domain/generate-foundation-market-strategy-custom-profile.cjs'), '--check');
  run(path.join(ROOT, 'scripts/domain/run-foundation-market-strategy-custom-runtime.cjs'), '--check');

  const evidenceBytes = fs.readFileSync(path.join(PROFILE_ROOT, 'runtime-evidence.json'));
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  requireCondition(
    evidenceBytes.equals(Buffer.from(canonicalJcs(evidence), 'utf8')),
    'runtime evidence is not exact JCS',
  );
  requireCondition(
    evidence.outcome === 'passed'
      && evidence.componentEligible === true
      && evidence.constraintDefinitionCount === CUSTOM_CONSTRAINT_COUNT
      && evidence.contextContractCount === 6,
    'definition/context identity or runtime outcome is invalid',
  );
  const categories = new Map();
  for (const row of evidence.vectorResults || []) {
    categories.set(row.category, (categories.get(row.category) || 0) + 1);
    requireCondition(row.status === 'passed', `vector ${row.id} did not pass`);
  }
  requireCondition(
    categories.get('positive') === CUSTOM_CONSTRAINT_COUNT
      && categories.get('negative') === CUSTOM_CONSTRAINT_COUNT
      && categories.get('crossDispatch') === CUSTOM_CONSTRAINT_COUNT,
    `vector categories differ: ${canonicalJcs(Object.fromEntries(categories))}`,
  );
  requireCondition(
    Array.isArray(evidence.controlResults)
      && evidence.controlResults.length === 15
      && evidence.controlResults.every((row) => row.status === 'passed'),
    'engineFailure/sandbox controls are incomplete',
  );
  process.stdout.write(`PASS six-module Custom executable gate: definitions=${CUSTOM_CONSTRAINT_COUNT} contexts=6 positive=${CUSTOM_CONSTRAINT_COUNT} negative=${CUSTOM_CONSTRAINT_COUNT} crossDispatch=${CUSTOM_CONSTRAINT_COUNT} controls=15\n`);
}

try {
  main();
} catch (cause) {
  process.stderr.write(`${cause?.stack || cause}\n`);
  process.exitCode = 1;
}
