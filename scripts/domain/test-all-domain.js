#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.trim()) console.log(out.trim());
  return r.status === 0;
}

let failed = 0;

console.log('=== test-all-domain ===\n');

console.log('--- 1. validate-m2-core --all --strict ---');
if (!run('node', ['scripts/domain/validate-m2-core.js', '--all', '--strict'])) { console.error('FAIL: validate-m2-core'); failed++; }

console.log('\n--- 2. regenerate OWL/SHACL ---');
{
  const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
  const GEN = path.join(ROOT, 'generated', 'ontology', 'finance');
  let ok = true;
  for (const name of fs.readdirSync(FINANCE)) {
    const mod = path.join(FINANCE, name, 'module.yaml');
    if (!fs.existsSync(mod)) continue;
    const owlOut = path.join(FINANCE, name, 'module.owl.ttl');
    const shaclOut = path.join(FINANCE, name, 'module.shacl.ttl');
    const r1 = spawnSync('node', ['scripts/domain/generate-m2-owl.cjs', mod, owlOut], { encoding: 'utf8', cwd: ROOT });
    const r2 = spawnSync('node', ['scripts/domain/generate-m2-shacl.cjs', mod, shaclOut], { encoding: 'utf8', cwd: ROOT });
    if (r1.status !== 0 || r2.status !== 0) { ok = false; console.error(`FAIL: regenerate ${name}`); }
    else {
      const genDir = path.join(GEN, name);
      fs.mkdirSync(genDir, { recursive: true });
      const prefix = name.replace(/-./g, m => m[1].toUpperCase()).replace(/^./, m => m.toUpperCase());
      fs.writeFileSync(path.join(genDir, prefix + '.owl.ttl'), fs.readFileSync(owlOut));
      fs.writeFileSync(path.join(genDir, prefix + '.shacl.ttl'), fs.readFileSync(shaclOut));
    }
  }
  if (ok) console.log('OK: OWL/SHACL regenerated for all modules');
  else failed++;
}

console.log('\n--- 3. PIT fixtures ---');
{
  const pitDir = path.join(ROOT, 'tests', 'm2', 'fixtures');
  const pitFiles = [];
  function scanPit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) scanPit(p);
      else if (f.name.endsWith('.yaml')) pitFiles.push(p);
    }
  }
  scanPit(path.join(pitDir, 'positive'));
  scanPit(path.join(pitDir, 'negative'));
  for (const f of pitFiles) {
    if (!run('node', ['scripts/domain/validate-pit.cjs', f])) { console.error('FAIL: PIT ' + f); failed++; }
  }
}

console.log('\n--- 4. Slice A synthetic mapping presence ---');
{
  const SYN = path.join(ROOT, 'mappings', 'finance', 'synthetic');
  const required = ['slice-a-semantic-mapping.yaml', 'slice-a-source-contract.yaml', 'slice-a-materialization-run.yaml'];
  let ok = true;
  for (const f of required) { if (!fs.existsSync(path.join(SYN, f))) { ok = false; console.error('FAIL: missing ' + f); } }
  if (ok) console.log('OK: Slice A mapping files present');
  else failed++;
}

console.log('\n--- 5. Slice A executable replay ---');
if (!run('node', ['scripts/domain/run-slice-a.cjs'])) { console.error('FAIL: run-slice-a'); failed++; }

console.log('\n--- 6. Factor revision-selection CQ ---');
if (!run('node', ['scripts/domain/run-factor-revision-cq.cjs'])) { console.error('FAIL: run-factor-revision-cq'); failed++; }

console.log('\n--- 7. Domain SHACL validation (pySHACL) ---');
if (!run('node', ['scripts/domain/run-domain-shacl.cjs'])) { console.error('FAIL: run-domain-shacl'); failed++; }

console.log('\n--- 8. Order state-machine CQ (CQ-OE6) ---');
if (!run('node', ['scripts/domain/run-order-state-machine-cq.cjs',
  'tests/m2/fixtures/positive/order-lifecycle-valid.yaml',
  'tests/m2/fixtures/negative/order-lifecycle-invalid.yaml'])) { console.error('FAIL: run-order-state-machine-cq'); failed++; }

console.log('\n--- 9. OWL consistency check (OWL-RL) ---');
if (!run('node', ['scripts/domain/run-owl-consistency-cq.cjs'])) { console.error('FAIL: run-owl-consistency-cq'); failed++; }

console.log('\n--- 10. Comprehensive CQ probes ---');
if (!run('node', ['scripts/domain/run-all-cq-probes.cjs'])) { console.error('FAIL: run-all-cq-probes'); failed++; }

console.log('\n=== Summary ===');
if (failed === 0) { console.log('test-all-domain PASS'); process.exit(0); }
console.log(`test-all-domain FAIL (${failed} failure group(s))`);
process.exit(1);
