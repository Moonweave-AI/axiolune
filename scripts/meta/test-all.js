#!/usr/bin/env node
/**
 * Meta-model gate — semantic checks only (no digest / byte-lock / projection drift).
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const steps = [
  ['validate-references', ['node', ['scripts/meta/validate-references.js']]],
  ['validate-structure', ['node', ['scripts/meta/validate-structure.js']]],
  ['validate-structure --strict', ['node', ['scripts/meta/validate-structure.js', '--strict']]],
  ['negative tests (structure)', ['node', ['scripts/meta/test-structure-negative.js']]],
  ['projection parse + validate', ['node', ['scripts/meta/test-projection-gate.cjs', '--semantic-only']]],
];

let fail = 0;
for (const [label, [cmd, args]] of steps) {
  process.stdout.write(`• ${label} ... `);
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT });
    console.log('PASS');
  } catch (e) {
    console.log('FAIL');
    if (e.stderr) console.log(`   ${e.stderr.toString().split('\n').slice(0, 5).join('\n   ')}`);
    fail += 1;
  }
}
console.log(`\n${'='.repeat(50)}`);
if (fail === 0) {
  console.log(`✅ ALL ${steps.length} STEPS PASSED`);
  process.exit(0);
}
console.log(`❌ ${fail}/${steps.length} STEPS FAILED`);
process.exit(1);
