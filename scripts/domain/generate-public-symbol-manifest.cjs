#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  compilePublicSymbolManifest,
} = require('./lib/public-symbol-compiler.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'public-symbol-manifest.json',
);

function discoverModules(root = ROOT) {
  const financeRoot = path.join(root, 'ontology', 'domain', 'finance');
  return fs.readdirSync(financeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .map((entry) => path.join(financeRoot, entry.name, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .sort()
    .map((file) => yaml.load(fs.readFileSync(file, 'utf8')));
}

function compile(root = ROOT) {
  return compilePublicSymbolManifest(discoverModules(root));
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const stdout = argv.includes('--stdout');
  const unknown = argv
    .filter((argument) => !['--check', '--write', '--stdout'].includes(argument));
  if (unknown.length > 0 || (write && stdout)) {
    throw new Error(
      'usage: node scripts/domain/generate-public-symbol-manifest.cjs [--check|--write|--stdout]',
    );
  }
  const compiled = compile();
  const bytes = Buffer.from(canonicalJcs(compiled.manifest), 'utf8');
  if (stdout) {
    process.stdout.write(bytes);
    return;
  }
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, bytes);
    console.log(
      `WROTE ${path.relative(ROOT, OUTPUT)} (${compiled.manifest.symbols.length} symbols, ${compiled.manifestDigest})`,
    );
    return;
  }
  if (!fs.existsSync(OUTPUT)) {
    console.error(`MISSING ${path.relative(ROOT, OUTPUT)}`);
    process.exitCode = 1;
    return;
  }
  const actual = fs.readFileSync(OUTPUT);
  if (!actual.equals(bytes)) {
    console.error(`DRIFT ${path.relative(ROOT, OUTPUT)}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS public-symbol-manifest (${compiled.manifest.symbols.length} symbols, ${compiled.manifestDigest})`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`FATAL public-symbol manifest generation failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { compile, discoverModules, main };
