'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CODE_LIST_OVERRIDES = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'code-list-authority-overrides.json',
);
const TERM_OVERRIDES = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'term-authority-overrides.json',
);
const ORDERS_MODULE = path.join(
  ROOT,
  'ontology',
  'domain',
  'finance',
  'orders-execution',
  'module.yaml',
);

const EXPECTED_CODE_LISTS = new Set([
  'https://axiolune.ai/ontology/finance/orders-execution/OrderEventKind',
  'https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleState',
  'https://axiolune.ai/ontology/finance/orders-execution/OrderSide',
  'https://axiolune.ai/ontology/finance/orders-execution/OrderType',
  'https://axiolune.ai/ontology/finance/orders-execution/TimeInForce',
]);
const TRIGGER_PRICE_BASIS =
  'https://axiolune.ai/ontology/finance/orders-execution/TriggerPriceBasis';

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertContextOnly(entry, identity) {
  assert.equal(entry.authorityKind, 'axioluneOperational', `${identity} authorityKind`);
  const evidence = entry.upstreamEvidence.filter(
    (record) => record.referenceId === 'nautilus-trader',
  );
  assert.equal(evidence.length, 1, `${identity} Nautilus evidence cardinality`);
  assert.equal(evidence[0].usage, 'implementation', `${identity} usage`);
  assert.equal(evidence[0].transformation, 'contextOnly', `${identity} transformation`);
}

test('all six repository implementation-informed vocabularies remain Axiolune-owned', () => {
  const codeListDocument = read(CODE_LIST_OVERRIDES);
  const selected = codeListDocument.entries.filter(
    (entry) => EXPECTED_CODE_LISTS.has(entry.codeListIri),
  );
  assert.equal(selected.length, EXPECTED_CODE_LISTS.size);
  for (const entry of selected) assertContextOnly(entry, entry.codeListIri);

  const termDocument = read(TERM_OVERRIDES);
  const trigger = termDocument.entries.find(
    (entry) => entry.publicIri === TRIGGER_PRICE_BASIS,
  );
  assert.ok(trigger, 'missing TriggerPriceBasis authority override');
  assertContextOnly(trigger, TRIGGER_PRICE_BASIS);

  const all = [...codeListDocument.entries, ...termDocument.entries];
  assert.equal(
    all.filter((entry) => entry.authorityKind === 'implementationAdopted').length,
    0,
    'repository must not retain implementationAdopted authority',
  );
});

test('canonical ontology definitions do not name an implementation project as authority', () => {
  const moduleDocument = YAML.parse(fs.readFileSync(ORDERS_MODULE, 'utf8'));
  const codeLists = moduleDocument?.domain?.codeLists;
  assert.ok(codeLists && typeof codeLists === 'object', 'orders module code lists are missing');

  for (const iri of [...EXPECTED_CODE_LISTS, TRIGGER_PRICE_BASIS]) {
    const definition = Object.values(codeLists).find((candidate) => candidate?.iri === iri);
    assert.ok(definition, `missing authored code list ${iri}`);
    assert.equal(
      definition.sourceEvidenceRef,
      'https://axiolune.ai/references/axiolune-m2-controlled-vocabularies',
      `${iri} sourceEvidenceRef`,
    );
    const normativeText = [
      definition.definition,
      ...(definition.values || []).map((member) => member.definition),
    ].join('\n');
    assert.doesNotMatch(
      normativeText,
      /nautilus(?:[_ -]?trader)?/iu,
      `${iri} normative definition must be implementation-independent`,
    );
  }
});
