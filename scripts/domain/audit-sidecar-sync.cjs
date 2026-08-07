#!/usr/bin/env node
'use strict';

/**
 * Audit sidecar evidence sync: registry versions, terminology entity coverage,
 * CQ yaml keys, alignments vs traceability.
 *
 * Usage: node scripts/domain/audit-sidecar-sync.cjs [--strict]
 * Exit 1 if any mismatch found (--strict) or version mismatches (always).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const STRICT = process.argv.includes('--strict');

function loadYaml(p) {
  const full = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!fs.existsSync(full)) return null;
  return yaml.load(fs.readFileSync(full, 'utf8'));
}

function collectDomainElements(domain) {
  const elements = [];
  const containers = [
    'objectTypes', 'associationTypes', 'relationTypes', 'attributeTypes',
    'identifierTypes', 'codeLists',
  ];
  for (const container of containers) {
    const block = domain?.[container];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, def] of Object.entries(block)) {
      if (def && typeof def === 'object' && def.iri) elements.push([name, def]);
    }
  }
  return elements;
}

function collectDomainEntityNames(domain) {
  return new Set(collectDomainElements(domain).map(([name]) => name));
}

const MODULES = [
  { dir: 'foundation', termPrefix: 'fin-foundation', cqPrefix: 'fin-foundation' },
  { dir: 'market-structure', termPrefix: 'fin-market-structure', cqPrefix: 'fin-market-structure' },
  { dir: 'instruments', termPrefix: 'fin-instruments', cqPrefix: 'fin-instruments' },
  { dir: 'market-rules', termPrefix: 'fin-market-rules', cqPrefix: 'fin-market-rules' },
  { dir: 'market-data', termPrefix: 'fin-market-data', cqPrefix: 'fin-market-data' },
  { dir: 'portfolio-positions', termPrefix: 'fin-portfolio-positions', cqPrefix: 'fin-portfolio-positions' },
  { dir: 'orders-execution', termPrefix: 'fin-orders-execution', cqPrefix: 'fin-orders-execution' },
  { dir: 'strategy-research', termPrefix: 'fin-strategy-research', cqPrefix: 'fin-strategy-research' },
  { dir: 'risk', termPrefix: 'fin-risk', cqPrefix: 'fin-risk' },
  { dir: 'post-trade-operations', termPrefix: 'fin-post-trade-operations', cqPrefix: 'fin-post-trade' },
];

let failures = 0;

console.log('=== MODULE REGISTRY vs module.yaml versions ===');
const reg = loadYaml('ontology/domain/finance/registry/module-registry.yaml');
for (const m of reg.modules) {
  const mod = loadYaml(m.path);
  const modVer = mod?.module?.version;
  const slug = m.path.split('/').slice(-2, -1)[0];
  const mismatch = modVer !== m.version;
  if (mismatch) {
    failures++;
    console.log(`${slug}: registry=${m.version} yaml=${modVer} *** MISMATCH ***`);
  } else {
    console.log(`${slug}: ${modVer} ✓`);
  }
}

console.log('\n=== TERMINOLOGY vs ENTITIES ===');
for (const { dir, termPrefix } of MODULES) {
  const modData = loadYaml(`ontology/domain/finance/${dir}/module.yaml`);
  const termData = loadYaml(`docs/ontology/terminology/${termPrefix}-terms.yaml`);
  const entities = collectDomainEntityNames(modData?.domain || {});
  const cards = termData?.cards || termData?.terms || [];
  const terms = new Set(cards.map(t => t.term || t.name || t.entity));
  const missingTerms = [...entities].filter(e => !terms.has(e)).sort();
  const staleTerms = [...terms].filter(t => !entities.has(t)).sort();
  if (missingTerms.length || staleTerms.length) {
    if (STRICT) failures++;
    console.log(`\n${dir}:`);
    if (missingTerms.length) console.log(`  entities without term (${missingTerms.length}): ${missingTerms.slice(0, 8).join(', ')}${missingTerms.length > 8 ? '...' : ''}`);
    if (staleTerms.length) console.log(`  stale terms (${staleTerms.length}): ${staleTerms.slice(0, 8).join(', ')}${staleTerms.length > 8 ? '...' : ''}`);
  }
}

console.log('\n=== ALIGNMENTS vs TRACEABILITY ===');
const alignDir = path.join(ROOT, 'docs/ontology/alignments');
const traceDir = path.join(ROOT, 'docs/ontology/traceability');
const alignFiles = fs.readdirSync(alignDir).filter(f => f.endsWith('.yaml')).map(f => f.replace('-alignments.yaml', ''));
const traceFiles = fs.readdirSync(traceDir).filter(f => f.endsWith('.md')).map(f => f.replace('-traceability.md', ''));
const alignNoTrace = alignFiles.filter(a => !traceFiles.includes(a));
const traceNoAlign = traceFiles.filter(t => !alignFiles.includes(t) && !t.startsWith('slice-'));
if (alignNoTrace.length) console.log('alignments without traceability:', alignNoTrace.join(', '));
if (traceNoAlign.length) console.log('traceability without alignments (expected for slices):', traceNoAlign.join(', ') || 'none');

console.log('\n=== CQ counts: cq.yaml vs traceability ===');
for (const { dir, cqPrefix } of MODULES) {
  const cqPath = `docs/ontology/competency-questions/${cqPrefix}-cq.yaml`;
  const tracePath = path.join(ROOT, `docs/ontology/traceability/${termPrefixFromDir(dir)}-traceability.md`);
  const cq = loadYaml(cqPath);
  if (!cq) {
    console.log(`${cqPrefix}: cq.yaml MISSING`);
    if (STRICT) failures++;
    continue;
  }
  const cqList = cq?.cqs || cq?.competencyQuestions || cq?.questions || [];
  const cqIds = new Set(cqList.map(q => q.id));
  const cqCount = cqIds.size;
  if (!fs.existsSync(tracePath)) {
    console.log(`${cqPrefix}: traceability MISSING, cq.yaml=${cqCount}`);
    continue;
  }
  const text = fs.readFileSync(tracePath, 'utf8');
  const refs = [...text.matchAll(/\b(CQ-[A-Z0-9]+(?:\.\.[A-Z0-9]+)?)\b/g)].map(m => m[1]);
  const uniqueRefs = new Set(refs);
  const inTraceNotCq = [...uniqueRefs].filter(r => {
    const base = r.split('..')[0];
    return !cqIds.has(r) && !cqIds.has(base);
  });
  if (inTraceNotCq.length) {
    console.log(`${cqPrefix}: cq.yaml=${cqCount}, refs in traceability but not cq.yaml (${inTraceNotCq.length})`);
  } else {
    console.log(`${cqPrefix}: ${cqCount} CQs ✓`);
  }
}

function termPrefixFromDir(dir) {
  const m = MODULES.find(x => x.dir === dir);
  return m ? m.termPrefix : dir;
}

console.log('\n=== CROSS-MODULE CQ vs slice-a traceability ===');
const crossModulePath = path.join(ROOT, 'docs/ontology/competency-questions/fin-cross-module-cq.yaml');
const sliceTracePath = path.join(ROOT, 'docs/ontology/traceability/slice-a-traceability.md');
if (!fs.existsSync(crossModulePath)) {
  failures++;
  console.log('fin-cross-module-cq.yaml: MISSING');
} else {
  const crossCq = loadYaml(crossModulePath);
  const crossIds = new Set((crossCq?.cqs || []).map(q => q.id));
  const expectedCross = ['CQ-S1', 'CQ-S2', 'CQ-S5'];
  const missingCross = expectedCross.filter(id => !crossIds.has(id));
  const extraCross = [...crossIds].filter(id => !expectedCross.includes(id));
  if (missingCross.length || extraCross.length) {
    failures++;
    if (missingCross.length) console.log(`  missing expected IDs: ${missingCross.join(', ')}`);
    if (extraCross.length) console.log(`  unexpected IDs: ${extraCross.join(', ')}`);
  } else {
    console.log(`fin-cross-module-cq.yaml: ${crossIds.size} CQs (${[...crossIds].join(', ')}) ✓`);
  }
  const portfolioCq = loadYaml('docs/ontology/competency-questions/fin-portfolio-positions-cq.yaml');
  const portfolioIds = new Set((portfolioCq?.cqs || []).map(q => q.id));
  for (const sliceId of ['CQ-S3', 'CQ-S4']) {
    if (crossIds.has(sliceId)) {
      failures++;
      console.log(`  ${sliceId} must live in fin-portfolio-positions-cq.yaml, not cross-module`);
    } else if (!portfolioIds.has(sliceId)) {
      if (STRICT) failures++;
      console.log(`  ${sliceId} missing from fin-portfolio-positions-cq.yaml`);
    }
  }
  if (fs.existsSync(sliceTracePath)) {
    const sliceText = fs.readFileSync(sliceTracePath, 'utf8');
    for (const id of expectedCross) {
      if (!sliceText.includes(id)) {
        failures++;
        console.log(`  ${id} not referenced in slice-a-traceability.md`);
      }
    }
    const s5 = (crossCq?.cqs || []).find(q => q.id === 'CQ-S5');
    const digest = s5?.stableSourceTreeCandidate?.entrypointDigest;
    if (!digest || digest === 'pending-sync' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      failures++;
      console.log(`  CQ-S5 entrypointDigest invalid or pending: ${digest || '(missing)'}`);
    } else {
      console.log('  CQ-S5 stableSourceTreeCandidate digest ✓');
    }
  } else if (STRICT) {
    failures++;
    console.log('slice-a-traceability.md: MISSING');
  }
}

console.log(`\n=== Result: ${failures} failure(s) ===`);
if (failures > 0) process.exit(1);
console.log('✅ Sidecar sync audit passed.');
