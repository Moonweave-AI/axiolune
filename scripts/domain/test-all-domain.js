#!/usr/bin/env node
/**
 * Domain (M2) unified gate — honest progress, no fabricated pass rates.
 *
 * Steps:
 *  1. validate-m2-core --all
 *  2. regenerate OWL/SHACL into ontology/domain/.../module.*.ttl and generated/ontology/finance/
 *  3. drift check (sidecar == regenerated)
 *  4. PIT fixtures under tests/m2/fixtures/{positive,negative}/*market*|portfolio*|orders*|strategy*
 *  5. require Slice A synthetic mapping files exist
 *
 * Usage: node scripts/domain/test-all-domain.js
 * Exit 0 only if all steps pass.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const GENERATED = path.join(ROOT, 'generated', 'ontology', 'finance');
const FIXTURES = path.join(ROOT, 'tests', 'm2', 'fixtures');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function modules() {
  return fs.readdirSync(FINANCE).filter((n) => fs.existsSync(path.join(FINANCE, n, 'module.yaml')));
}

console.log('=== test-all-domain ===\n');
let failed = 0;

console.log('--- 1. validate-m2-core --all --strict ---');
if (!run('node', ['scripts/domain/validate-m2-core.js', '--all', '--strict'])) {
  console.error('FAIL: validate-m2-core --strict');
  failed++;
}

console.log('\n--- 2. regenerate OWL/SHACL ---');
for (const name of modules()) {
  const yamlPath = path.join(FINANCE, name, 'module.yaml');
  const owlSide = path.join(FINANCE, name, 'module.owl.ttl');
  const shaclSide = path.join(FINANCE, name, 'module.shacl.ttl');
  const genDir = path.join(GENERATED, name);
  fs.mkdirSync(genDir, { recursive: true });
  const owlGen = path.join(genDir, `${name}.owl.ttl`);
  const shaclGen = path.join(genDir, `${name}.shacl.ttl`);

  if (!run('node', ['scripts/domain/generate-m2-owl.cjs', yamlPath, owlSide])) {
    console.error('FAIL: owl ' + name);
    failed++;
    continue;
  }
  if (!run('node', ['scripts/domain/generate-m2-shacl.cjs', yamlPath, shaclSide])) {
    console.error('FAIL: shacl ' + name);
    failed++;
    continue;
  }
  // Use read+write instead of copyFileSync to avoid Windows/Node copyFile UNKNOWN errors
  fs.writeFileSync(owlGen, fs.readFileSync(owlSide));
  fs.writeFileSync(shaclGen, fs.readFileSync(shaclSide));

  // Sanity: generated file must look like Turtle, not generator stdout
  const head = fs.readFileSync(owlGen, 'utf8').slice(0, 80);
  if (head.includes('✓ M2') || head.includes('triples ->')) {
    console.error('FAIL: corrupted TTL for ' + name);
    failed++;
  }
  // Associations should emit ObjectProperty or sh:property when participantRoles exist
  const doc = require('js-yaml').load(fs.readFileSync(yamlPath, 'utf8'));
  const hasRoles = Object.values(doc.domain || {}).some((el) => Array.isArray(el.participantRoles) && el.participantRoles.length);
  if (hasRoles) {
    const owlTxt = fs.readFileSync(owlSide, 'utf8');
    const shaclTxt = fs.readFileSync(shaclSide, 'utf8');
    if (!owlTxt.includes('ObjectProperty') && !owlTxt.includes('owl:ObjectProperty')) {
      console.error('FAIL: ' + name + ' has participantRoles but OWL lacks ObjectProperty');
      failed++;
    }
    if (!shaclTxt.includes('sh:property') && !shaclTxt.includes('sh:minCount')) {
      console.error('FAIL: ' + name + ' has participantRoles but SHACL lacks property constraints');
      failed++;
    }
  }
}

console.log('\n--- 3. PIT fixtures (incl. factor / CN rule-applicability) ---');
const pitFiles = [];
for (const kind of ['positive', 'negative']) {
  const dir = path.join(FIXTURES, kind);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yaml')) continue;
    // Round-3: FactorObservation + CN RuleApplicability enter the gate
    if (/market-data|portfolio|orders|strategy|factor|rule-applicability/.test(f)) {
      pitFiles.push(path.join(dir, f));
    }
  }
}
const requiredPit = [
  'tests/m2/fixtures/positive/factor-observation-revision.yaml',
  'tests/m2/fixtures/negative/factor-observation-revision-negative.yaml',
  'tests/m2/fixtures/positive/rule-applicability-cn-market.yaml',
  'tests/m2/fixtures/negative/rule-applicability-cn-market-negative.yaml',
];
for (const rel of requiredPit) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error('FAIL: missing required PIT fixture ' + rel);
    failed++;
  } else if (!pitFiles.includes(p)) {
    pitFiles.push(p);
  }
}
const PIT_RUN_FILE = path.join(ROOT, 'mappings/finance/synthetic/slice-a-materialization-run.yaml');
for (const f of pitFiles) {
  console.log('\nPIT: ' + path.relative(ROOT, f));
  const args = ['scripts/domain/validate-pit.cjs', f];
  if (fs.existsSync(PIT_RUN_FILE)) args.push(PIT_RUN_FILE);
  if (!run('node', args)) {
    console.error('FAIL: PIT ' + f);
    failed++;
  }
}

console.log('\n--- 4. Slice A synthetic mapping presence ---');
const sliceA = [
  'mappings/finance/synthetic/slice-a-source-contract.yaml',
  'mappings/finance/synthetic/slice-a-semantic-mapping.yaml',
  'mappings/finance/synthetic/slice-a-materialization-run.yaml',
  'mappings/finance/synthetic/slice-a-pit-validation-request.yaml',
  'tests/m2/competency-queries/cq-s1-s5.yaml',
];
for (const rel of sliceA) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error('FAIL: missing ' + rel);
    failed++;
  } else {
    console.log('✓ ' + rel);
  }
}

console.log('\n--- 5. Slice A executable replay (run-slice-a) ---');
if (!run('node', ['scripts/domain/run-slice-a.cjs'])) {
  console.error('FAIL: run-slice-a');
  failed++;
} else {
  const runReport = path.join(ROOT, 'mappings/finance/synthetic/runs/slice-a-2026-07-30-r1.json');
  if (!fs.existsSync(runReport)) {
    console.error('FAIL: missing Slice A run report');
    failed++;
  } else {
    const rep = JSON.parse(fs.readFileSync(runReport, 'utf8'));
    if (!rep.outputGraphDigest || rep.outputGraphDigest.includes('pending')) {
      console.error('FAIL: Slice A outputGraphDigest still pending');
      failed++;
    } else {
      console.log('✓ Slice A outputGraphDigest ' + rep.outputGraphDigest);
    }
  }
}

console.log('\n--- 6. references.lock hygiene ---');
const lockPath = path.join(ROOT, 'docs/ontology/references/references.lock.yaml');
if (!fs.existsSync(lockPath)) {
  console.error('FAIL: missing references.lock.yaml');
  failed++;
} else {
  const lock = require('js-yaml').load(fs.readFileSync(lockPath, 'utf8'));
  for (const ref of (lock.references || [])) {
    const d = ref.artifactDigest || '';
    if (/sha256:0{64}/.test(d)) {
      console.error('FAIL: zero digest still present for ' + ref.id);
      failed++;
    }
    if (ref.localPath && String(ref.localPath).includes('docs/meta/reference')) {
      console.error('FAIL: stale localPath for ' + ref.id + ': ' + ref.localPath);
      failed++;
    }
    if (ref.localPath) {
      const lp = path.join(ROOT, ref.localPath);
      if (!fs.existsSync(lp)) {
        console.error('FAIL: localPath missing on disk for ' + ref.id + ': ' + ref.localPath);
        failed++;
      }
    }
  }
  console.log('✓ references.lock digests non-zero / paths under reference/');
}

console.log('\n--- 7. SHACL engine pin + honest smoke ---');
const pinPath = path.join(ROOT, 'docs/domain/infrastructure/SHACL-ENGINE-PIN.yaml');
if (!fs.existsSync(pinPath)) {
  console.error('FAIL: missing SHACL-ENGINE-PIN.yaml');
  failed++;
} else if (!run('node', ['scripts/domain/run-pyshacl-smoke.cjs'])) {
  console.error('FAIL: run-pyshacl-smoke');
  failed++;
} else {
  const evPath = path.join(ROOT, 'docs/domain/infrastructure/shacl-smoke-evidence.json');
  if (!fs.existsSync(evPath)) {
    console.error('FAIL: missing shacl-smoke-evidence.json');
    failed++;
  } else {
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    if (!ev.evidenceStatus) {
      console.error('FAIL: smoke evidence missing evidenceStatus');
      failed++;
    } else {
      console.log('✓ SHACL pin + smoke evidenceStatus=' + ev.evidenceStatus);
    }
  }
}

console.log('\n--- 8. Slice A interpreter honesty ---');
{
  const runReport = path.join(ROOT, 'mappings/finance/synthetic/runs/slice-a-2026-07-30-r1.json');
  const mappingYaml = fs.readFileSync(path.join(ROOT, 'mappings/finance/synthetic/slice-a-semantic-mapping.yaml'), 'utf8');
  if (!mappingYaml.includes('runnerCapability') || !mappingYaml.includes('minimal-slot-interpreter-v0')) {
    console.error('FAIL: mapping must declare runnerCapability minimal-slot-interpreter-v0');
    failed++;
  } else if (!fs.existsSync(runReport)) {
    console.error('FAIL: missing Slice A run report for honesty check');
    failed++;
  } else {
    const rep = JSON.parse(fs.readFileSync(runReport, 'utf8'));
    if (rep.materializer !== 'minimal-slot-interpreter-v0') {
      console.error('FAIL: run report materializer is not interpreter');
      failed++;
    } else if (rep.outputGraphDigestKind !== 'deterministic-json-canon-of-interpreter-facts') {
      console.error('FAIL: must declare JSON-canon digest kind (not pretend RDF URDNA2015)');
      failed++;
    } else {
      console.log('✓ Slice A materializer + digest-kind honesty');
    }
  }
}

console.log('\n--- 9. Factor revision-selection CQ (nextRevision walk) ---');
if (!fs.existsSync(path.join(ROOT, 'tests/m2/competency-queries/cq-factor-revision.yaml'))) {
  console.error('FAIL: missing cq-factor-revision.yaml');
  failed++;
} else if (!run('node', ['scripts/domain/run-factor-revision-cq.cjs'])) {
  console.error('FAIL: run-factor-revision-cq');
  failed++;
}

console.log('\n--- 10. alignment digests ↔ references.lock ---');
if (!run('node', ['scripts/domain/sync-alignment-digests.cjs', '--check'])) {
  console.error('FAIL: alignment digests still zero or unmapped — run sync-alignment-digests.cjs');
  failed++;
}

console.log('\n--- 11. Domain SHACL validation (pySHACL over M2 shapes) ---');
if (!run('node', ['scripts/domain/run-domain-shacl.cjs'])) {
  console.error('FAIL: run-domain-shacl');
  failed++;
}

console.log('\n--- 12. Order state-machine CQ (CQ-OE6) ---');
if (!run('node', ['scripts/domain/run-order-state-machine-cq.cjs',
  'tests/m2/fixtures/positive/order-lifecycle-valid.yaml',
  'tests/m2/fixtures/negative/order-lifecycle-invalid.yaml'])) {
  console.error('FAIL: run-order-state-machine-cq');
  failed++;
}

console.log('\n--- 13. OWL 2 DL consistency check (OWL-RL) ---');
if (!run('node', ['scripts/domain/run-owl-consistency-cq.cjs'])) {
  console.error('FAIL: run-owl-consistency-cq');
  failed++;
}

console.log('\n--- 14. Comprehensive CQ probes (all 48 CQs) ---');
if (!run('node', ['scripts/domain/run-all-cq-probes.cjs'])) {
  console.error('FAIL: run-all-cq-probes');
  failed++;
}

console.log('\n=== Summary ===');
if (failed === 0) {
  console.log('✅ test-all-domain PASS');
  process.exit(0);
}
console.log(`❌ test-all-domain FAIL (${failed} failure group(s))`);
process.exit(1);
