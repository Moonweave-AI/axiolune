#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const {
  verifyAlignmentSemantics,
} = require('../lib/alignment-semantic-verifier.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(
  ROOT,
  'scripts',
  'domain',
  'alignment-semantic-profile',
  'foundation-v1.json',
), 'utf8'));
const MODULE = YAML.parse(fs.readFileSync(path.join(
  ROOT,
  'ontology',
  'domain',
  'finance',
  'foundation',
  'module.yaml',
), 'utf8'));
const LOCK = YAML.parse(fs.readFileSync(path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'references.lock.yaml',
), 'utf8'));
const FIBO_ROOT = path.join(ROOT, 'reference', 'ontology-design-reference', 'fibo');

function clone(value) {
  return structuredClone(value);
}

function source(pathValue) {
  return fs.readFileSync(path.join(FIBO_ROOT, pathValue.split('/').join(path.sep)));
}

async function verify(moduleDocument = MODULE, options = {}) {
  return verifyAlignmentSemantics({
    root: ROOT,
    moduleDocument,
    profile: options.profile || PROFILE,
    referenceLock: LOCK,
    sourceBytesByPath: options.sourceBytesByPath || new Map(),
    mirrorBytesByPath: options.mirrorBytesByPath || new Map(),
  });
}

test('canonical Foundation alignments close local type, locked target semantics, direction, and OWL projection', async () => {
  const result = await verify();
  assert.deepEqual(result.errors, []);
  assert.equal(result.artifact.summary.originalDecisionCount, 8);
  assert.equal(result.artifact.summary.retainedMachineReviewedCount, 6);
  assert.equal(result.artifact.summary.removedUnverifiableCount, 2);
  assert.equal(result.artifact.summary.currentAuthoredAlignmentCount, 6);
  assert.equal(result.artifact.summary.status, 'pass');
});

test('lexical IdentifierTypeDefinition cannot be realigned to an external OWL class', async () => {
  const mutated = clone(MODULE);
  mutated.domain.identifierTypes.ISIN.alignments = mutated.domain.objectTypes.ISINValue.alignments;
  delete mutated.domain.objectTypes.ISINValue.alignments;
  await assert.rejects(
    verify(mutated),
    /IdentifierTypeDefinition projects to rdfs:Datatype/,
  );
});

test('relation strengthening or reversal cannot inherit reviewed status', async () => {
  const mutated = clone(MODULE);
  mutated.domain.objectTypes.Currency.alignments[0].relation = 'owl:equivalentClass';
  const result = await verify(mutated);
  assert.ok(result.errors.some((message) => message.includes('.relation')));
  assert.ok(result.errors.some((message) => message.includes('generated OWL contains 0 exact alignment triples')));
});

test('locked target type and definition mutations are both detected', async () => {
  const currencyPath = 'FND/Accounting/CurrencyAmount.rdf';
  const opening = '<owl:Class rdf:about="&fibo-fnd-acc-cur;Currency">';
  const raw = source(currencyPath).toString('utf8');
  const targetStart = raw.indexOf(opening);
  const targetEnd = raw.indexOf('</owl:Class>', targetStart);
  assert.ok(targetStart >= 0 && targetEnd > targetStart);
  const mutatedText = (
    raw.slice(0, targetStart)
    + raw.slice(targetStart, targetEnd)
      .replace(opening, '<owl:DatatypeProperty rdf:about="&fibo-fnd-acc-cur;Currency">')
      .replace(
        'medium of exchange value, defined by reference to the geographical location',
        'mutated exchange value, defined by reference to the geographical location',
      )
    + '</owl:DatatypeProperty>'
    + raw.slice(targetEnd + '</owl:Class>'.length)
  );
  const result = await verify(MODULE, {
    sourceBytesByPath: new Map([[currencyPath, Buffer.from(mutatedText, 'utf8')]]),
  });
  assert.ok(result.errors.some((message) => message.includes('.external.resourceDigest')));
  assert.ok(result.errors.some((message) => message.includes('.external.rdfType')));
  assert.ok(result.errors.some((message) => message.includes('.external.definition')));
});

test('a Provisional target module cannot masquerade as reviewed Release-maturity evidence', async () => {
  const currencyPath = 'FND/Accounting/CurrencyAmount.rdf';
  const mutatedText = source(currencyPath).toString('utf8').replace(
    'rdf:resource="&fibo-fnd-utl-av;Release"',
    'rdf:resource="&fibo-fnd-utl-av;Provisional"',
  );
  const result = await verify(MODULE, {
    sourceBytesByPath: new Map([[currencyPath, Buffer.from(mutatedText, 'utf8')]]),
  });
  assert.ok(result.errors.some((message) => message.includes('.external.ontologyMaturityIris')));
});

test('unlocked Commons base semantics cannot be silently restored as logical alignments', async () => {
  const mutated = clone(MODULE);
  const rejected = PROFILE.decisions.find((entry) => entry.decisionId === 'foundation-party-commons-party');
  mutated.domain.objectTypes.Party.alignments = [{
    vocabulary: 'FIBO',
    targetIri: rejected.external.targetIri,
    relation: rejected.formerRelation,
    sourceRelease: {
      vocabulary: 'FIBO',
      release: LOCK.references.find((entry) => entry.id === PROFILE.referenceId).releaseOrCommit,
      artifactDigest: LOCK.references.find((entry) => entry.id === PROFILE.referenceId).artifactDigest,
    },
    sourceLocator: LOCK.references
      .find((entry) => entry.id === PROFILE.referenceId).locators
      .find((entry) => entry.kind === 'wholeFile' && entry.path === rejected.external.sourcePath),
    rationale: 'mutation that attempts to restore an unclosed claim',
    verification: PROFILE.expectedInlineVerification,
  }];
  const result = await verify(mutated);
  assert.ok(result.errors.some((message) => message.includes('rejected alignment is still authored')));
  assert.ok(result.errors.some((message) => message.includes('unreviewed authored alignment')));
});

test('a new alignment outside the eight-decision profile fails closed', async () => {
  const mutated = clone(MODULE);
  mutated.domain.objectTypes.Currency.alignments.push({
    ...clone(mutated.domain.objectTypes.Currency.alignments[0]),
    targetIri: 'https://example.test/unreviewed/Currency',
  });
  const result = await verify(mutated);
  assert.ok(result.errors.some((message) => message.includes('unreviewed authored alignment')));
});

test('OWL mirror byte drift is independent of the authored semantic checks', async () => {
  const baseline = await verify();
  assert.deepEqual(baseline.errors, []);
  const result = await verify(MODULE, {
    mirrorBytesByPath: new Map([
      ['ontology/domain/finance/foundation/module.owl.ttl', Buffer.from('stale projection', 'utf8')],
    ]),
  });
  assert.ok(result.errors.some((message) => message.includes('not byte-identical')));
});
