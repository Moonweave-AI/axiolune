#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  TermAuthorityError,
  compileTermAuthorityCandidate,
  mergeTermAuthorityOverrides,
  validateTermAuthorityManifest,
} = require('./lib/term-authority.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FINANCE_ROOT = path.join(ROOT, 'ontology', 'domain', 'finance');
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const OVERRIDE_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'term-authority-overrides.json',
);
const CODE_LIST_OVERRIDE_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'code-list-authority-overrides.json',
);
const OUTPUT = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-terminology',
  'm2-v0.3-terms.json',
);

function discoverModules() {
  return fs.readdirSync(FINANCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .map((entry) => path.join(FINANCE_ROOT, entry.name, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .sort()
    .map((file) => YAML.parse(fs.readFileSync(file, 'utf8')));
}

function readOptionalJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function compile() {
  const moduleDocs = discoverModules();
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const termOverrides = readOptionalJson(OVERRIDE_PATH, {
    schemaVersion: '1.0',
    entries: [],
  });
  const codeListOverrides = JSON.parse(fs.readFileSync(CODE_LIST_OVERRIDE_PATH, 'utf8'));
  const overrides = mergeTermAuthorityOverrides(
    moduleDocs,
    termOverrides,
    codeListOverrides,
  );
  const candidate = compileTermAuthorityCandidate(moduleDocs, overrides, lock);
  if (fs.existsSync(OUTPUT)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    if (existing.candidateDigest === candidate.candidateDigest && existing.decision) {
      candidate.decision = existing.decision;
    } else if (existing.decision && existing.decision.status === 'reviewed') {
      throw new Error(
        'refusing to replace a reviewed term authority with a different candidate digest',
      );
    }
  }
  const validation = validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides);
  if (!validation.ok) throw new TermAuthorityError(validation.errors);
  return candidate;
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const stdout = argv.includes('--stdout');
  const unknown = argv.filter((argument) => !['--check', '--write', '--stdout'].includes(argument));
  if (unknown.length > 0 || (write && stdout)) {
    throw new Error(
      'usage: node scripts/domain/generate-term-authority-manifest.cjs '
      + '[--check|--write|--stdout]',
    );
  }
  const manifest = compile();
  const bytes = Buffer.from(canonicalJcs(manifest), 'utf8');
  const relative = path.relative(ROOT, OUTPUT).replaceAll(path.sep, '/');
  if (stdout) {
    process.stdout.write(bytes);
    return;
  }
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, bytes);
    console.log(
      `WROTE ${relative} (${manifest.entries.length} authored terms, `
      + `${manifest.candidateDigest}, decision=${manifest.decision.status})`,
    );
    return;
  }
  if (!fs.existsSync(OUTPUT)) {
    console.error(`MISSING ${relative}`);
    process.exitCode = 1;
    return;
  }
  const actual = fs.readFileSync(OUTPUT);
  if (!actual.equals(bytes)) {
    console.error(`DRIFT ${relative} (candidate=${manifest.candidateDigest})`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS term authority candidate (${manifest.entries.length} authored terms, `
    + `${manifest.candidateDigest}, decision=${manifest.decision.status})`,
  );
}

try {
  main();
} catch (error) {
  console.error(`FATAL term authority generation failed: ${error.stack || error.message}`);
  process.exitCode = 1;
}
