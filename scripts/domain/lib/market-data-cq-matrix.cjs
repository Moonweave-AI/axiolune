'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const yaml = require('js-yaml');
const {
  CQ_FUNCTION_VERSION,
  executeCq,
} = require('./market-data-cq.cjs');
const {
  validateScenario,
} = require('./market-data-v03-contracts.cjs');
const {
  loadFixture,
  materializeYamlMerges,
} = require('./strict-fixture-loader.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'm2', 'fixtures', 'market-data-v03');
const CQ_DIR = path.join(FIXTURE_DIR, 'cq');
const POSITIVE_FILE = path.join(CQ_DIR, 'positive.yaml');
const NEGATIVE_FILE = path.join(CQ_DIR, 'negative.yaml');
const SUPPORTED_CQS = new Set([
  'CQ-MD1',
  'CQ-MD2',
  'CQ-MD3',
  'CQ-MD4',
  'CQ-MD5',
  'CQ-MD6',
  'CQ-MD7',
]);

function readYaml(file) {
  return materializeYamlMerges(yaml.load(fs.readFileSync(file, 'utf8')));
}

function sameStringSet(left, right) {
  return isDeepStrictEqual([...new Set(left)].sort(), [...new Set(right)].sort());
}

function closedKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === expected.slice().sort().join('\0');
}

function executePositiveCase(scenario, specification) {
  if (!closedKeys(specification, ['caseId', 'cqId', 'expected', 'query'])) {
    throw new Error(`${specification?.caseId || '?'} is not a closed positive case`);
  }
  if (!closedKeys(specification.expected, ['rows', 'status'])
      || specification.expected.status !== 'ok'
      || !Array.isArray(specification.expected.rows)) {
    throw new Error(`${specification.caseId} requires exact ok rows`);
  }
  const actual = executeCq(specification.cqId, scenario, specification.query);
  if (!isDeepStrictEqual(actual, specification.expected.rows)) {
    throw new Error(`${specification.caseId} returned ${JSON.stringify(actual)} instead of ${JSON.stringify(specification.expected.rows)}`);
  }
  if (actual.length === 0) throw new Error(`${specification.caseId} positive result is empty`);
  return `exact ${actual.length}-row result`;
}

function fixturePath(relativeRef) {
  if (typeof relativeRef !== 'string' || path.isAbsolute(relativeRef)) {
    throw new Error('negative fixture reference must be relative');
  }
  const candidate = path.resolve(CQ_DIR, relativeRef);
  const relative = path.relative(FIXTURE_DIR, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`negative fixture escapes Market Data fixture root: ${relativeRef}`);
  }
  return candidate;
}

function executeNegativeCase(scenario, specification) {
  if (specification.kind === 'query') {
    if (!closedKeys(specification, ['caseId', 'cqId', 'expected', 'kind', 'query'])
        || !closedKeys(specification.expected, ['rows', 'status'])
        || specification.expected.status !== 'ok'
        || !Array.isArray(specification.expected.rows)) {
      throw new Error(`${specification?.caseId || '?'} is not a closed empty-result query case`);
    }
    const actual = executeCq(specification.cqId, scenario, specification.query);
    if (!isDeepStrictEqual(actual, specification.expected.rows) || actual.length !== 0) {
      throw new Error(`${specification.caseId} expected exact empty result, got ${JSON.stringify(actual)}`);
    }
    return 'exact empty result';
  }
  if (specification.kind !== 'fixture'
      || !closedKeys(specification, ['caseId', 'cqId', 'expected', 'fixture', 'kind'])
      || !closedKeys(specification.expected, ['codes', 'status'])
      || specification.expected.status !== 'rejected'
      || !Array.isArray(specification.expected.codes)
      || specification.expected.codes.length === 0) {
    throw new Error(`${specification?.caseId || '?'} is not a closed rejected-fixture case`);
  }
  const fixture = loadFixture(fixturePath(specification.fixture), { rootDirectory: FIXTURE_DIR });
  if (fixture.expected?.valid !== false
      || !sameStringSet(fixture.expected.codes || [], specification.expected.codes)) {
    throw new Error(`${specification.caseId} expected codes do not equal ${fixture.caseId} declarations`);
  }
  const actualCodes = [...new Set(validateScenario(fixture).map((row) => row.code))];
  for (const code of specification.expected.codes) {
    if (!actualCodes.includes(code)) {
      throw new Error(`${specification.caseId} did not produce ${code}; got ${actualCodes.join(',')}`);
    }
  }
  return `${fixture.caseId} rejected with ${specification.expected.codes.join(',')}`;
}

function loadMarketDataCqMatrix() {
  const positives = readYaml(POSITIVE_FILE);
  const negatives = readYaml(NEGATIVE_FILE);
  for (const [label, document] of [['positive', positives], ['negative', negatives]]) {
    if (document?.functionVersion !== CQ_FUNCTION_VERSION) {
      throw new Error(`${label} CQ matrix functionVersion drift`);
    }
    if (document?.graphFixture !== '../positive-complete.yaml') {
      throw new Error(`${label} CQ matrix graphFixture drift`);
    }
    if (!Array.isArray(document?.cases)) throw new Error(`${label} CQ matrix lacks cases`);
  }
  const scenario = loadFixture(path.join(FIXTURE_DIR, 'positive-complete.yaml'), {
    rootDirectory: FIXTURE_DIR,
  });
  const structural = validateScenario(scenario);
  if (structural.length > 0) {
    throw new Error(`canonical Market Data graph is invalid: ${structural.map((row) => row.code).join(',')}`);
  }
  const cases = new Map();
  const outcomes = new Map();
  for (const [polarity, rows] of [
    ['positive', positives.cases],
    ['negative', negatives.cases],
  ]) {
    for (const specification of rows) {
      if (typeof specification?.caseId !== 'string' || !/^MD-(?:POS|NEG)-[0-9]{3}-[a-z0-9-]+$/u.test(specification.caseId)) {
        throw new Error(`invalid Market Data CQ case ID ${String(specification?.caseId)}`);
      }
      if (cases.has(specification.caseId)) throw new Error(`duplicate Market Data CQ case ${specification.caseId}`);
      if (!SUPPORTED_CQS.has(specification.cqId)) throw new Error(`${specification.caseId} has unsupported ${String(specification.cqId)}`);
      cases.set(specification.caseId, { ...specification, polarity });
      const detail = polarity === 'positive'
        ? executePositiveCase(scenario, specification)
        : executeNegativeCase(scenario, specification);
      outcomes.set(specification.caseId, { ok: true, detail });
    }
  }
  for (const cqId of SUPPORTED_CQS) {
    for (const polarity of ['positive', 'negative']) {
      if (![...cases.values()].some((entry) => entry.cqId === cqId && entry.polarity === polarity)) {
        throw new Error(`${cqId} lacks a ${polarity} case`);
      }
    }
  }
  return {
    cases,
    outcomes,
    positiveCount: positives.cases.length,
    negativeCount: negatives.cases.length,
    scenario,
  };
}

module.exports = {
  CQ_DIR,
  NEGATIVE_FILE,
  POSITIVE_FILE,
  SUPPORTED_CQS,
  loadMarketDataCqMatrix,
};
