'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildMarketDataImplementationClosure,
} = require('./lib/market-data-release-evidence.cjs');
const {
  computeSelectionDigest,
} = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'm2', 'fixtures', 'market-data-v03');
const CLOSURE_FILE = path.join(
  FIXTURE_ROOT,
  'evidence',
  'market-data-validator-implementation-closure-v1.json',
);
const CONTEXT_FILE = path.join(
  FIXTURE_ROOT,
  'evidence',
  'market-data-semantic-fixture-context-v1.json',
);
const POSITIVE_FIXTURE_FILE = path.join(FIXTURE_ROOT, 'positive-complete.yaml');
const DIGEST_RE = /sha256:[0-9a-f]{64}/u;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function replaceFixtureContextDigest(source, digest) {
  const pattern = new RegExp(
    '(  - artifactIri: urn:validation-run:market-data-v03\\r?\\n'
      + '    artifactRef: \\{kind: path, root: sourceTree, path: '
      + 'tests/m2/fixtures/market-data-v03/evidence/'
      + 'market-data-semantic-fixture-context-v1\\.json\\}\\r?\\n'
      + '    artifactDigest: )'
      + DIGEST_RE.source,
    'u',
  );
  const matches = source.match(new RegExp(pattern.source, 'gu')) || [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one semantic fixture context binding, found ${matches.length}`);
  }
  return source.replace(pattern, `$1${digest}`);
}

function expectedArtifacts() {
  const closure = buildMarketDataImplementationClosure(ROOT);
  const closureBytes = jsonBytes(closure);
  const context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
  context.implementationArtifactDigest = sha256(closureBytes);
  context.implementationLocator.selectionDigest = computeSelectionDigest(
    context.implementationLocator,
    closureBytes,
  );
  const contextBytes = jsonBytes(context);
  const fixtureText = fs.readFileSync(POSITIVE_FIXTURE_FILE, 'utf8');
  const expectedFixtureText = replaceFixtureContextDigest(fixtureText, sha256(contextBytes));
  return new Map([
    [CLOSURE_FILE, closureBytes],
    [CONTEXT_FILE, contextBytes],
    [POSITIVE_FIXTURE_FILE, Buffer.from(expectedFixtureText, 'utf8')],
  ]);
}

function run(mode) {
  const outputs = expectedArtifacts();
  const drifted = [];
  for (const [file, expected] of outputs) {
    const actual = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (actual?.equals(expected)) continue;
    drifted.push(path.relative(ROOT, file).split(path.sep).join('/'));
    if (mode === 'write') fs.writeFileSync(file, expected);
  }
  if (mode === 'check' && drifted.length > 0) {
    throw new Error(`market-data implementation closure drift: ${drifted.join(', ')}`);
  }
  console.log(
    `Market Data implementation closure: ${mode === 'write' ? 'WROTE' : 'PASS'} `
      + `(${outputs.size} artifacts, ${drifted.length} changed)`,
  );
}

const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
  console.error(
    'Usage: node scripts/domain/generate-market-data-implementation-closure.cjs '
      + '<--check|--write>',
  );
  process.exit(2);
}

try {
  run(args[0].slice(2));
} catch (error) {
  console.error(`Market Data implementation closure: FAIL\n- ${error.message}`);
  process.exit(1);
}
