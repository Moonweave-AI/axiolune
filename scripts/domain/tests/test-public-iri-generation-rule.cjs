'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  evaluatePublicIriGeneration,
  parseLockedRule,
} = require('../lib/public-iri-generation-rule.cjs');

const RULE = fs.readFileSync(path.resolve(
  __dirname,
  '..',
  'rules',
  'public-iri-generation-v1.json',
));

test('locked generation rule reproduces all three public IRI branches', () => {
  assert.equal(parseLockedRule(RULE).schemaVersion, '1.0');
  assert.equal(
    evaluatePublicIriGeneration({
      bytes: RULE,
      generatedKind: 'codeMember',
      source: {
        kind: 'codeValue',
        codeListIri: 'https://example.test/Side',
        codeValueIri: 'https://example.test/Side/value/Buy',
      },
    }),
    'https://example.test/Side/value/Buy',
  );
  assert.equal(
    evaluatePublicIriGeneration({
      bytes: RULE,
      generatedKind: 'logicalIdentityClass',
      source: {
        kind: 'logicalIdentityClass',
        typeIri: 'https://example.test/Trade',
      },
    }),
    'https://example.test/Trade/LogicalIdentity',
  );
  assert.equal(
    evaluatePublicIriGeneration({
      bytes: RULE,
      generatedKind: 'rolePredicate',
      source: {
        kind: 'participantRole',
        containingType: 'https://example.test/Trade',
        roleId: 'instrument',
      },
    }),
    'https://example.test/Trade/role/instrument',
  );
});

test('generation rule fails closed on byte, schema, tuple, and kind drift', () => {
  assert.throws(() => parseLockedRule(Buffer.concat([RULE, Buffer.from('\n')])), /exact UTF-8 JCS/u);
  assert.throws(
    () => parseLockedRule(Buffer.from('{"rules":{},"schemaVersion":"1.0"}\n')),
    /closed rule contract/u,
  );
  assert.throws(
    () => evaluatePublicIriGeneration({
      bytes: RULE,
      generatedKind: 'rolePredicate',
      source: {
        kind: 'participantRole',
        containingType: 'https://example.test/Trade',
        roleId: 'Instrument',
      },
    }),
    /lowerCamelCase/u,
  );
  assert.throws(
    () => evaluatePublicIriGeneration({
      bytes: RULE,
      generatedKind: 'invented',
      source: {},
    }),
    /unsupported generatedKind/u,
  );
});
