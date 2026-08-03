#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  validateCanonicalDefinitions,
  validateTerminologyHygiene,
} = require('../lib/canonical-definition-hygiene.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const TERMINOLOGY = path.join(ROOT, 'docs', 'ontology', 'terminology');

test('all canonical finance definitions are implementation-name free', () => {
  const findings = [];
  for (const entry of fs.readdirSync(FINANCE, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'registry') continue;
    const modulePath = path.join(FINANCE, entry.name, 'module.yaml');
    if (!fs.existsSync(modulePath)) continue;
    const document = yaml.load(fs.readFileSync(modulePath, 'utf8'));
    for (const finding of validateCanonicalDefinitions(document)) {
      findings.push({ module: entry.name, ...finding });
    }
  }
  assert.deepEqual(findings, []);
});

test('an implementation name inserted into a definition fails closed', () => {
  const document = {
    domain: {
      codeLists: {
        TriggerPriceBasis: {
          definition: 'Vocabulary copied from the Nautilus TriggerType implementation.',
        },
      },
    },
  };
  assert.deepEqual(validateCanonicalDefinitions(document), [{
    code: 'PROJECT_IMPLEMENTATION_NAME_IN_CANONICAL_DEFINITION',
    implementation: 'Nautilus',
    location: 'domain.codeLists.TriggerPriceBasis.definition',
  }]);
});

test('implementation evidence remains allowed outside canonical definition fields', () => {
  const document = {
    domain: {
      codeLists: {
        TriggerPriceBasis: {
          definition: 'Closed classification of market observations used by an order trigger.',
          rationale: 'Nautilus was reviewed as implementation evidence.',
          note: 'Lean is corroborating evidence only.',
        },
      },
    },
  };
  assert.deepEqual(validateCanonicalDefinitions(document), []);
});

test('terminology sources reject the legacy concatenated MIC lexical model', () => {
  const findings = [];
  for (const file of fs.readdirSync(TERMINOLOGY).filter((name) => name.endsWith('-terms.yaml'))) {
    const document = yaml.load(fs.readFileSync(path.join(TERMINOLOGY, file), 'utf8'));
    for (const finding of validateTerminologyHygiene(document)) {
      findings.push({ file, ...finding });
    }
  }
  assert.deepEqual(findings, []);
});

test('a segment MIC described as a concatenated code fails closed', () => {
  const document = {
    cards: [{
      term: 'MarketSegment',
      differentia: ['identified by a segment MIC (4+4 character)'],
    }],
  };
  assert.deepEqual(validateTerminologyHygiene(document), [{
    code: 'LEGACY_CONCATENATED_MIC_MODEL',
    term: 'MarketSegment',
    location: 'cards[0].differentia[0]',
  }]);
});
