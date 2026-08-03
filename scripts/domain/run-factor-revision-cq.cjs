#!/usr/bin/env node
'use strict';

/**
 * Execute the FactorObservation revision-selection competency probes against
 * the canonical v0.3 contract. Successors point backward to an exact prior
 * version and knowledge/availability ends are derived from immutable closure
 * assertions; implementation-private linked-record fields are rejected.
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'factor-observation-revision.yaml');
const CQ = path.join(ROOT, 'tests', 'm2', 'competency-queries', 'cq-factor-revision.yaml');
const YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);
const TYPE = 'https://axiolune.ai/ontology/finance/strategy-research/FactorObservation';
const SUPERSEDES = `${TYPE}/role/supersedesFactorVersion`;
const FORBIDDEN_KEYS = new Set([
  '_next',
  'nextRevision',
  'hasFactorPeriod',
  'hasFactorValue',
  'hasNumericAmount',
  'knowledgeTo',
  'availableTo',
  'targetVersionIri',
  'causeVersionIri',
]);

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: YAML_SCHEMA });
}

function parseInstant(value, at) {
  if (typeof value !== 'string') throw new Error(`${at} must be an explicit instant`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${at} is not a valid instant`);
  return parsed;
}

function collectForbidden(value, at = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectForbidden(entry, `${at}[${index}]`, findings));
    return findings;
  }
  if (!value || typeof value !== 'object') return findings;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) findings.push(`${at}.${key}`);
    collectForbidden(child, `${at}.${key}`, findings);
  }
  return findings;
}

function inHalfOpen(from, to, asOf) {
  return from <= asOf && (to === null || asOf < to);
}

function loadCanonicalChain(document) {
  const fixture = (document.fixtures || []).find((entry) => entry.id === 'factor-obs-revision-chain-positive');
  if (!fixture) throw new Error('canonical revision-chain fixture is missing');
  if (fixture.expectedResult !== 'accepted') throw new Error('canonical revision-chain fixture is not positive');

  const forbidden = collectForbidden(fixture);
  if (forbidden.length > 0) throw new Error(`legacy or mutable revision fields are forbidden: ${forbidden.join(', ')}`);

  const observations = (fixture.instances || []).filter((entry) => entry && entry.type === TYPE);
  if (observations.length < 2) throw new Error('revision chain requires at least two FactorObservation versions');
  const byIri = new Map();
  const successors = new Map();
  for (const observation of observations) {
    if (typeof observation.iri !== 'string' || byIri.has(observation.iri)) {
      throw new Error(`observation IRI is missing or duplicated: ${String(observation.iri)}`);
    }
    if (typeof observation.logicalIri !== 'string') throw new Error(`${observation.iri} lacks logicalIri`);
    if (!Number.isInteger(observation.revision) || observation.revision < 0) {
      throw new Error(`${observation.iri} has an invalid revision`);
    }
    if (!observation.factorValue || observation.factorValue.type !== 'QuantityValue'
        || !Number.isFinite(Number(observation.factorValue.value))
        || typeof observation.factorValue.unit !== 'string'
        || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(observation.factorValue.unit)
        || !['floor', 'ceiling', 'half-up', 'half-even'].includes(observation.factorValue.rounding)) {
      throw new Error(`${observation.iri} does not carry a canonical QuantityValue`);
    }
    for (const axis of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
      parseInstant(observation[axis], `${observation.iri}.${axis}`);
    }
    byIri.set(observation.iri, observation);
  }

  for (const observation of observations) {
    const priorIri = observation[SUPERSEDES];
    if (!priorIri) continue;
    const prior = byIri.get(priorIri);
    if (!prior) throw new Error(`${observation.iri} supersedes an unknown exact version ${priorIri}`);
    if (successors.has(priorIri)) throw new Error(`${priorIri} has more than one direct successor`);
    if (observation.logicalIri !== prior.logicalIri) throw new Error('successor changed the logical identity');
    if (observation.revision !== prior.revision + 1) throw new Error('successor revision is not contiguous');
    successors.set(priorIri, observation);
  }

  const closures = new Map();
  for (const [index, closure] of (fixture.closures || []).entries()) {
    const at = `closures[${index}]`;
    if (!closure || !['knowledge', 'availability'].includes(closure.axis)) {
      throw new Error(`${at} has an invalid axis`);
    }
    const target = byIri.get(closure.targetVersion);
    const cause = byIri.get(closure.causeVersion);
    if (!target || !cause) throw new Error(`${at} does not identify two fixture versions`);
    if (closure.causeKind !== 'successor' || closure.evidenceRef !== closure.causeVersion) {
      throw new Error(`${at} is not an evidence-bound successor closure`);
    }
    if (cause[SUPERSEDES] !== target.iri) throw new Error(`${at} cause does not supersede target`);
    const startField = closure.axis === 'knowledge' ? 'knowledgeFrom' : 'availableFrom';
    if (parseInstant(closure.closedAt, `${at}.closedAt`) !== parseInstant(cause[startField], `${cause.iri}.${startField}`)) {
      throw new Error(`${at}.closedAt does not equal the successor axis start`);
    }
    const key = `${target.iri}|${closure.axis}`;
    if (closures.has(key)) throw new Error(`${at} duplicates ${key}`);
    closures.set(key, closure);
  }

  for (const [priorIri, successor] of successors) {
    for (const axis of ['knowledge', 'availability']) {
      const closure = closures.get(`${priorIri}|${axis}`);
      if (!closure || closure.causeVersion !== successor.iri) {
        throw new Error(`${priorIri} lacks an exact ${axis} closure caused by ${successor.iri}`);
      }
    }
  }

  const heads = observations.filter((entry) => !entry[SUPERSEDES]);
  if (heads.length !== 1) throw new Error(`expected one chain head, got ${heads.length}`);
  return { head: heads[0], byIri, successors, closures };
}

function selectRevision(chain, asOf) {
  const pivots = {
    valid: parseInstant(asOf.asOfValid, 'asOf.asOfValid'),
    knowledge: parseInstant(asOf.asOfKnowledge, 'asOf.asOfKnowledge'),
    availability: parseInstant(asOf.asOfAvailable, 'asOf.asOfAvailable'),
  };
  let current = chain.head;
  let selected = null;
  const visited = new Set();
  while (current) {
    if (visited.has(current.iri)) throw new Error(`revision cycle at ${current.iri}`);
    visited.add(current.iri);
    const validTo = current.validTo == null ? null : parseInstant(current.validTo, `${current.iri}.validTo`);
    const knowledgeClosure = chain.closures.get(`${current.iri}|knowledge`);
    const availabilityClosure = chain.closures.get(`${current.iri}|availability`);
    const knowledgeTo = knowledgeClosure ? parseInstant(knowledgeClosure.closedAt, 'knowledge closure') : null;
    const availabilityTo = availabilityClosure ? parseInstant(availabilityClosure.closedAt, 'availability closure') : null;
    if (inHalfOpen(parseInstant(current.validFrom, 'validFrom'), validTo, pivots.valid)
        && inHalfOpen(parseInstant(current.knowledgeFrom, 'knowledgeFrom'), knowledgeTo, pivots.knowledge)
        && inHalfOpen(parseInstant(current.availableFrom, 'availableFrom'), availabilityTo, pivots.availability)) {
      selected = current;
    }
    current = chain.successors.get(current.iri) || null;
  }
  return selected;
}

function terminal(chain) {
  let current = chain.head;
  const visited = new Set();
  while (chain.successors.has(current.iri)) {
    if (visited.has(current.iri)) throw new Error(`revision cycle at ${current.iri}`);
    visited.add(current.iri);
    current = chain.successors.get(current.iri);
  }
  return current;
}

let failed = 0;
function pass(id, detail) {
  console.log(`PASS ${id}: ${detail}`);
}
function fail(id, detail) {
  failed += 1;
  console.error(`FAIL ${id}: ${detail}`);
}

let chain;
try {
  chain = loadCanonicalChain(readYaml(FIXTURE));
  pass('setup', `validated immutable chain beginning at ${chain.head.iri}`);
} catch (error) {
  fail('setup', error.message);
}

if (chain) {
  const cqDocument = readYaml(CQ);
  if (cqDocument.schemaVersion !== '1.0' || cqDocument.contract !== 'factor-observation-v0.3-immutable-closure') {
    fail('cq-contract', 'CQ document does not bind the canonical v0.3 immutable-closure contract');
  }
  for (const probe of cqDocument.probes || []) {
    try {
      const selected = selectRevision(chain, probe.asOf);
      if (probe.expectedResult === 'empty') {
        if (selected === null) pass(probe.id, 'empty result as expected');
        else fail(probe.id, `unexpectedly selected ${selected.iri}`);
        continue;
      }
      if (!selected) {
        fail(probe.id, 'no revision selected');
        continue;
      }
      const actualValue = selected.factorValue.value;
      if (selected.iri !== probe.expected.observationIri
          || String(actualValue) !== String(probe.expected.factorValue)) {
        fail(probe.id, `got ${selected.iri}/${actualValue}; expected ${probe.expected.observationIri}/${probe.expected.factorValue}`);
        continue;
      }
      pass(probe.id, `selected ${selected.iri} value=${actualValue}`);
      if (probe.assertNotTerminal) {
        const last = terminal(chain);
        if (last.iri === selected.iri) fail(`${probe.id}-nonterminal`, 'query collapsed to the terminal revision');
        else pass(`${probe.id}-nonterminal`, `selection differs from terminal ${last.iri}`);
      }
    } catch (error) {
      fail(probe.id || 'unknown-probe', error.message);
    }
  }
}

console.log('\n=== Factor revision CQ ===');
console.log(failed === 0 ? 'PASS' : `FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
