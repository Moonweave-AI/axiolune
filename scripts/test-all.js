#!/usr/bin/env node
/**
 * Consolidated meta-model test runner (CI gate). Runs every validator and test
 * in dependency order and reports an aggregate pass/fail. A single command for
 * "100% verified":
 *
 *   node scripts/test-all.js
 *
 * Exit 0 only if every step passes.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const steps = [
  ['YAML syntax', ['node', ['scripts/validate-yaml.js',
    'ontology/meta/core-meta-model.yaml', 'ontology/meta/cross-domain-patterns.yaml',
    'ontology/meta/behavior-meta-model.yaml', 'ontology/meta/data-binding-meta-model.yaml']]],
  ['verify-meta-model (digest + import lock)', ['node', ['scripts/verify-meta-model.js']]],
  ['deep-analysis-v0.5 (ADR-011/012 compliance)', ['node', ['scripts/deep-analysis-v0.5.js']]],
  ['validate-references (real closure)', ['node', ['scripts/validate-references.js']]],
  ['validate-structure (deep structural)', ['node', ['scripts/validate-structure.js']]],
  ['validate-structure --strict (typo detection)', ['node', ['scripts/validate-structure.js', '--strict']]],
  ['negative tests (structure)', ['node', ['scripts/test-structure-negative.js']]],
  ['generate-owl', ['node', ['scripts/generate-owl.js']]],
  ['generate-shacl', ['node', ['scripts/generate-shacl.js']]],
  ['test-projection (M3->M2 parse + SHACL validate)', ['node', ['scripts/test-projection.js']]],
  ['projection drift check (committed == regenerated)', ['git', ['diff', '--exit-code', '--', 'ontology/meta/projection/']]],
];

let fail = 0;
for (const [label, [cmd, args]] of steps) {
  process.stdout.write(`• ${label} ... `);
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd: path.join(__dirname, '..') });
    console.log('PASS');
  } catch (e) {
    console.log('FAIL');
    if (e.stderr) console.log('   ' + e.stderr.toString().split('\n').slice(0, 5).join('\n   '));
    fail++;
  }
}
console.log('\n' + '='.repeat(50));
if (fail === 0) { console.log(`✅ ALL ${steps.length} STEPS PASSED`); process.exit(0); }
else { console.log(`❌ ${fail}/${steps.length} STEPS FAILED`); process.exit(1); }
