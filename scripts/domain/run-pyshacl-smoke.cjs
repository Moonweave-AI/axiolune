#!/usr/bin/env node
/**
 * Optional pySHACL smoke — runs domain SHACL fixtures and writes honest evidence JSON.
 * NOT M2 semantic acceptance (see SHACL-RUNTIME-NOTES.md).
 *
 * Usage: node scripts/domain/run-pyshacl-smoke.cjs
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'domain', 'infrastructure', 'shacl-smoke-evidence.json');
const ranAt = new Date().toISOString();

const child = spawnSync('node', ['scripts/domain/run-domain-shacl.cjs'], {
  cwd: ROOT,
  encoding: 'utf8',
});

const stdout = child.stdout || '';
const stderr = child.stderr || '';
const passLines = stdout.split('\n').filter((line) => line.startsWith('✓'));
const failLines = [...stdout.split('\n'), ...stderr.split('\n')].filter((line) => line.startsWith('✗'));

const evidence = {
  status: child.status === 0 ? 'pass' : 'fail',
  ranAt,
  exitCode: child.status ?? 1,
  note: 'Optional engineering evidence — not M2 semantic acceptance per SHACL-RUNTIME-NOTES.md',
  runner: 'scripts/domain/run-domain-shacl.cjs',
  summary: {
    passFixtures: passLines.length,
    failFixtures: failLines.length,
  },
  tailStdout: stdout.split('\n').slice(-25).join('\n'),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(`pySHACL smoke: ${evidence.status.toUpperCase()} (${evidence.summary.passFixtures} pass, ${evidence.summary.failFixtures} fail)`);
console.log(`Evidence: ${path.relative(ROOT, OUT)}`);

process.exit(child.status ?? 1);
