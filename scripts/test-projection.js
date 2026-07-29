#!/usr/bin/env node
/**
 * D4/D5 verification for the M3->M2 projection.
 *   1. Parse the generated OWL turtle (n3) — asserts zero syntax errors.
 *   2. Parse the generated SHACL turtle (n3) — asserts zero syntax errors
 *      (this also parse-verifies the Tier-2 sh:SPARQL constraints).
 *   3. SHACL-validate good M1 data -> conforms TRUE.
 *   4. SHACL-validate bad M1 data for each Tier-1 constraint -> conforms FALSE
 *      and the violation points at the right path.
 *
 * Exit 0 only if all assertions pass. Uses rdf-validate-shacl (core SHACL only;
 * sh:SPARQL Tier-2 constraints are parse-verified in step 2, enforcement needs a
 * SPARQL-capable engine and is out of scope for this machine check).
 */
const fs = require('fs');
const path = require('path');
const { Parser, Store } = require('n3');
const SHACLValidator = require('rdf-validate-shacl').default;

const META = path.join(__dirname, '..', 'ontology', 'meta');
const AX = 'https://axiolune.ai/ontology/meta/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ATTR = AX + 'patterns/attributes/';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.error('  ✗ ' + m); fail++; };

function parse(file, label) {
  const ttl = fs.readFileSync(file, 'utf8');
  try {
    const quads = new Parser().parse(ttl);
    ok(`${label} parses: ${quads.length} quads`);
    return new Store(quads);
  } catch (e) {
    bad(`${label} parse error: ${e.message}`);
    return null;
  }
}

const owlStore = parse(path.join(META, 'projection', 'axiolune-meta.owl.ttl'), 'OWL turtle');
const shaclStore = parse(path.join(META, 'projection', 'axiolune-meta.shacl.ttl'), 'SHACL turtle (Tier1)');
const sparqlStore = parse(path.join(META, 'projection', 'axiolune-meta.shacl-sparql.ttl'), 'SHACL turtle (Tier2 SPARQL, parse-only)');
if (!owlStore || !shaclStore || !sparqlStore) { console.log('\n❌ parse failed'); process.exit(1); }

// Build a data graph (M1 instance) as a Store.
function dataGraph(props, type) {
  const inst = 'http://test/inst';
  const lines = ['@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .', `@prefix ax: <${AX}> .`];
  const cls = type ? `<${AX}${type}>` : `<${AX}PatternFact>`;
  const pps = Object.entries(props).map(([k, v]) => {
    const [val, dt] = Array.isArray(v) ? v : [v, null];
    const obj = dt ? `"${val}"^^xsd:${dt}` : (v === null ? '""' : `"${val}"`);
    return `<${ATTR}${k}> ${obj}`;
  });
  lines.push(`<${inst}> a ${cls} ; ${pps.join(' ; ')} .`);
  return new Store(new Parser().parse(lines.join('\n')));
}

async function validate(data, label) {
  const v = new SHACLValidator(shaclStore);
  const report = await v.validate(data);
  const paths = report.conforms ? [] : [...report.results].map(r => r.path && r.path.value).filter(Boolean);
  return { conforms: report.conforms, paths };
}

(async () => {
  console.log('\n=== SHACL validation (good vs bad M1 data) ===');

  const good = dataGraph({
    confidence: ['0.8', 'decimal'], semanticVersion: '1.2.3', evidenceDigest: 'sha256:' + 'a'.repeat(64),
  });
  const gr = await validate(good, 'good');
  if (gr.conforms) ok('good data conforms (all Tier-1 constraints satisfied)');
  else bad(`good data should conform, got violations on: ${gr.paths.join(', ')}`);

  // bad: confidence out of range
  const badConf = dataGraph({ confidence: ['1.5', 'decimal'], semanticVersion: '1.2.3', evidenceDigest: 'sha256:' + 'a'.repeat(64) });
  const r1 = await validate(badConf, 'confidence');
  if (!r1.conforms && r1.paths.some(p => p.includes('confidence'))) ok('confidence=1.5 correctly rejected (ConfidenceRange)');
  else bad(`confidence=1.5 should be rejected on confidence path; conforms=${r1.conforms} paths=${r1.paths.join(',')}`);

  // bad: bad semver
  const badSemver = dataGraph({ confidence: ['0.5', 'decimal'], semanticVersion: '1.0', evidenceDigest: 'sha256:' + 'a'.repeat(64) });
  const r2 = await validate(badSemver, 'semver');
  if (!r2.conforms && r2.paths.some(p => p.includes('semanticVersion'))) ok('semanticVersion=1.0 correctly rejected (SemanticVersionFormat)');
  else bad(`semanticVersion=1.0 should be rejected; conforms=${r2.conforms} paths=${r2.paths.join(',')}`);

  // bad: bad digest
  const badDig = dataGraph({ confidence: ['0.5', 'decimal'], semanticVersion: '1.0.0', evidenceDigest: 'not-a-digest' });
  const r3 = await validate(badDig, 'digest');
  if (!r3.conforms && r3.paths.some(p => p.includes('evidenceDigest'))) ok('evidenceDigest=not-a-digest correctly rejected (DigestFormat)');
  else bad(`evidenceDigest=bad should be rejected; conforms=${r3.conforms} paths=${r3.paths.join(',')}`);

  // ---- Per-pattern TemporalFactShape enforcement (Tier 1) ----
  console.log('\n=== Per-pattern shape enforcement (TemporalFact) ===');
  // good: a TemporalFact instance WITH validFrom + knowledgeFrom
  const tfGood = dataGraph({
    validFrom: ['2026-07-29T09:30:00Z', 'dateTime'], knowledgeFrom: ['2026-07-29T09:30:00Z', 'dateTime'],
  }, 'TemporalFact');
  const rtg = await validate(tfGood, 'tf-good');
  if (rtg.conforms) ok('TemporalFact with validFrom+knowledgeFrom conforms');
  else bad(`TemporalFact good should conform; violations on: ${rtg.paths.join(', ')}`);

  // bad: a TemporalFact instance MISSING validFrom (TemporalFactShape requires minCount 1)
  const tfBad = dataGraph({ knowledgeFrom: ['2026-07-29T09:30:00Z', 'dateTime'] }, 'TemporalFact');
  const rtb = await validate(tfBad, 'tf-bad-missing-validFrom');
  if (!rtb.conforms && rtb.paths.some(p => p.includes('validFrom'))) ok('TemporalFact missing validFrom correctly rejected (TemporalFactShape requires validFrom)');
  else bad(`TemporalFact missing validFrom should be rejected on validFrom; conforms=${rtb.conforms} paths=${rtb.paths.join(',')}`);

  console.log('\n' + '='.repeat(60));
  if (fail === 0) { console.log(`✅ PROJECTION VERIFIED (${pass} assertions)`); process.exit(0); }
  else { console.log(`❌ PROJECTION VERIFICATION FAILED (${fail} failures)`); process.exit(1); }
})();
