#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { Parser } = require('n3');
const { projectOwl } = require('./generate-m2-owl.cjs');
const { projectShacl } = require('./generate-m2-shacl.cjs');
const {
  auditModuleContract,
  validateScenario,
} = require('./lib/slice-a-market-contracts.cjs');
const {
  auditSliceASourceLocks,
} = require('./lib/slice-a-source-locks.cjs');
const {
  verifyReviewedNoAlignments,
} = require('./lib/reviewed-no-alignment.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKET_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'market-structure', 'module.yaml');
const INSTRUMENT_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'instruments', 'module.yaml');
const LOCK_FILE = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'm2', 'fixtures', 'slice-a');
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function materializeYamlMerges(value) {
  if (Array.isArray(value)) return value.map(materializeYamlMerges);
  if (value === null || typeof value !== 'object') return value;
  const merged = {};
  const sources = Array.isArray(value['<<']) ? value['<<'] : [value['<<']];
  for (const source of sources) {
    if (source && typeof source === 'object') Object.assign(merged, materializeYamlMerges(source));
  }
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe YAML key ${key}`);
    if (key !== '<<') merged[key] = materializeYamlMerges(child);
  }
  return merged;
}

function loadYaml(file) {
  return materializeYamlMerges(yaml.load(fs.readFileSync(file, 'utf8')));
}

function clone(value) {
  return structuredClone(value);
}

function pathTokens(expression) {
  const tokens = [];
  const regex = /([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g;
  let cursor = 0;
  let match;
  while ((match = regex.exec(expression)) !== null) {
    if (match.index !== cursor && expression.slice(cursor, match.index) !== '.') {
      throw new Error(`invalid mutation path ${expression}`);
    }
    tokens.push(match[1] === undefined ? Number(match[2]) : match[1]);
    if (typeof tokens[tokens.length - 1] === 'string'
        && DANGEROUS_KEYS.has(tokens[tokens.length - 1])) {
      throw new Error(`unsafe mutation path ${expression}`);
    }
    cursor = regex.lastIndex;
    if (expression[cursor] === '.') cursor += 1;
    regex.lastIndex = cursor;
  }
  if (cursor !== expression.length || tokens.length === 0) {
    throw new Error(`invalid mutation path ${expression}`);
  }
  return tokens;
}

function applyMutation(target, mutation) {
  if (!['set', 'delete'].includes(mutation?.op)) {
    throw new Error(`unsupported fixture mutation ${mutation?.op}`);
  }
  const tokens = pathTokens(mutation.path);
  let parent = target;
  for (const token of tokens.slice(0, -1)) {
    if (parent === null || parent === undefined || !(token in parent)) {
      throw new Error(`mutation path does not resolve: ${mutation.path}`);
    }
    parent = parent[token];
  }
  const last = tokens[tokens.length - 1];
  if (mutation.op === 'delete') {
    if (!(last in parent)) throw new Error(`delete path does not resolve: ${mutation.path}`);
    delete parent[last];
  } else {
    parent[last] = clone(mutation.value);
  }
}

function loadFixture(file, stack = []) {
  const resolved = path.resolve(file);
  const relative = path.relative(FIXTURE_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`fixture extends path escapes fixture directory: ${file}`);
  }
  const realFixtureRoot = fs.realpathSync(FIXTURE_DIR);
  const realResolved = fs.realpathSync(resolved);
  const realRelative = path.relative(realFixtureRoot, realResolved);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`fixture symlink escapes fixture directory: ${file}`);
  }
  if (stack.includes(resolved)) throw new Error(`cyclic fixture inheritance: ${[...stack, resolved].join(' -> ')}`);
  const document = loadYaml(resolved);
  if (!document.extends) return document;
  const base = clone(loadFixture(path.join(FIXTURE_DIR, document.extends), [...stack, resolved]));
  for (const mutation of document.mutations || []) applyMutation(base, mutation);
  base.caseId = document.caseId;
  base.expected = document.expected;
  delete base.extends;
  delete base.mutations;
  return base;
}

function formatFinding(finding) {
  return `${finding.code} @ ${finding.at}: ${finding.message}`;
}

async function main() {
  const passes = [];
  const failures = [];
  const pending = [];

  const market = loadYaml(MARKET_FILE);
  const instruments = loadYaml(INSTRUMENT_FILE);
  const locks = loadYaml(LOCK_FILE);

  let positiveFixture;
  try {
    positiveFixture = loadFixture(path.join(FIXTURE_DIR, 'positive-market-instrument-contract.yaml'));
  } catch (error) {
    failures.push(`Slice-A positive fixture source-lock binding failed to load: ${error.message}`);
  }

  const sourceAudit = auditSliceASourceLocks({
    rootDir: ROOT,
    lockDocument: locks,
    positiveFixture,
  });
  passes.push(...sourceAudit.passes);
  failures.push(...sourceAudit.failures);
  pending.push(...sourceAudit.pending);

  if (positiveFixture) {
    const reordered = clone(positiveFixture);
    for (const collection of ['micEntries', 'otcContexts', 'listings']) {
      reordered[collection].reverse();
    }
    const reorderViolations = validateScenario(reordered);
    if (reorderViolations.length === 0) {
      passes.push('VERSION_CHAIN_ORDER_INVARIANCE: MIC, OTC and listing identity validation is independent of YAML row order');
    } else {
      failures.push(`Version-chain row reordering changed validity: ${reorderViolations.map(formatFinding).join(' | ')}`);
    }
  }

  const noAlignment = verifyReviewedNoAlignments({ rootDir: ROOT });
  if (noAlignment.ok) {
    passes.push('EXTERNAL_ALIGNMENT_DECISIONS: exact FinancialInstrument/Security reviewed-no-alignment evidence replayed');
  } else {
    failures.push(`External alignment decision replay failed: ${noAlignment.errors.join('; ')}`);
  }

  const ontologyAudit = auditModuleContract(market, instruments, {
    externalTermAlignmentEvidence: {
      noAlignment,
      authoritySourceLocks: sourceAudit.verified,
    },
  });
  if (ontologyAudit.violations.length === 0) {
    passes.push('ONTOLOGY_CONTRACT: typed Market Structure + Instruments classifier/reference-mode contract');
  } else {
    failures.push(...ontologyAudit.violations.map(formatFinding));
  }
  pending.push(...ontologyAudit.pending.map(formatFinding));

  for (const [name, document] of [['market-structure', market], ['instruments', instruments]]) {
    try {
      const [owlFirst, owlSecond, shaclFirst, shaclSecond] = await Promise.all([
        projectOwl(document),
        projectOwl(document),
        projectShacl(document),
        projectShacl(document),
      ]);
      if (!Buffer.from(owlFirst).equals(Buffer.from(owlSecond))) {
        failures.push(`${name}: OWL projection is not deterministic`);
      } else {
        new Parser().parse(String(owlFirst));
        passes.push(`${name}: deterministic parseable OWL projection`);
      }
      if (!Buffer.from(shaclFirst).equals(Buffer.from(shaclSecond))) {
        failures.push(`${name}: SHACL projection is not deterministic`);
      } else {
        const shaclQuads = new Parser().parse(String(shaclFirst));
        passes.push(`${name}: deterministic parseable Tier-1 SHACL projection`);
        if (name === 'instruments') {
          const expectedSubject =
            'https://axiolune.ai/ontology/finance/instruments/'
            + 'DirectUnitPriceQuotationContextXone/shape';
          const hasExecutableXone = shaclQuads.some((quad) => (
            quad.subject.value === expectedSubject
            && quad.predicate.value === 'http://www.w3.org/ns/shacl#xone'
          ));
          if (hasExecutableXone) {
            passes.push(`${name}: authored quotation-context xone is present in generated SHACL`);
          } else {
            failures.push(`${name}: generated SHACL omits quotation-context sh:xone`);
          }
        }
      }
    } catch (error) {
      failures.push(`${name}: projection failed: ${error.message}`);
    }
  }

  const fixtureFiles = fs.readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of fixtureFiles) {
    let fixture;
    try {
      fixture = loadFixture(path.join(FIXTURE_DIR, name));
    } catch (error) {
      failures.push(`${name}: fixture load failed: ${error.message}`);
      continue;
    }
    const violations = validateScenario(fixture);
    const actualCodes = new Set(violations.map((violation) => violation.code));
    if (fixture.expected?.valid === true) {
      if (violations.length === 0) {
        passes.push(`${fixture.caseId}: accepted`);
      } else {
        failures.push(`${fixture.caseId}: expected accepted, got ${violations.map(formatFinding).join(' | ')}`);
      }
      continue;
    }
    if (fixture.expected?.valid !== false) {
      failures.push(`${fixture.caseId}: expected.valid must be boolean`);
      continue;
    }
    if (violations.length === 0) {
      failures.push(`${fixture.caseId}: negative fixture was accepted`);
      continue;
    }
    const missingCodes = (fixture.expected.codes || []).filter((code) => !actualCodes.has(code));
    if (missingCodes.length > 0) {
      failures.push(`${fixture.caseId}: expected violation codes not observed: ${missingCodes.join(', ')}`);
      continue;
    }
    passes.push(`${fixture.caseId}: rejected with ${[...actualCodes].sort().join(', ')}`);
  }

  console.log('=== Slice-A Market Structure + Instruments contract gate ===');
  for (const item of passes) console.log(`PASS ${item}`);
  for (const item of failures) console.log(`FAIL ${item}`);
  for (const item of pending) console.log(`PENDING ${item}`);
  console.log(`SUMMARY pass=${passes.length} fail=${failures.length} pending=${pending.length}`);

  if (failures.length > 0) process.exitCode = 1;
  else if (pending.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
