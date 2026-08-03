#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(
  ROOT,
  'scripts',
  'domain',
  'identifier-custom-profile',
  'v0.3.0',
  'foundation-identifier-core.wat',
);
const TARGET = path.join(
  ROOT,
  'scripts',
  'domain',
  'identifier-custom-profile',
  'v0.3.0',
  'foundation-identifier-core.wasm',
);
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const DEPENDENCY_LOCK_FILE = path.join(ROOT, 'package-lock.json');

function verifyCompilerLock() {
  const packageDocument = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
  const dependencyLock = JSON.parse(fs.readFileSync(DEPENDENCY_LOCK_FILE, 'utf8'));
  const locked = dependencyLock.packages?.['node_modules/wabt'];
  if (packageDocument.devDependencies?.wabt !== '1.0.39'
      || dependencyLock.packages?.['']?.devDependencies?.wabt !== '1.0.39'
      || locked?.version !== '1.0.39'
      || locked?.dev !== true
      || typeof locked.integrity !== 'string'
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(locked.integrity)) {
    throw new Error('package.json/package-lock.json do not exactly lock wabt 1.0.39 with integrity');
  }
  return locked.integrity;
}

async function compile() {
  verifyCompilerLock();
  const packageVersion = require('wabt/package.json').version;
  if (packageVersion !== '1.0.39') {
    throw new Error(`wabt must be exactly 1.0.39; found ${packageVersion}`);
  }
  const wabt = await require('wabt')();
  const source = fs.readFileSync(SOURCE, 'utf8');
  const parsed = wabt.parseWat('foundation-identifier-core.wat', source, {
    bulk_memory: false,
    exceptions: false,
    gc: false,
    memory64: false,
    multi_memory: false,
    reference_types: false,
    simd: false,
    tail_call: false,
    threads: false,
  });
  try {
    parsed.resolveNames();
    parsed.validate();
    const generated = parsed.toBinary({
      canonicalize_lebs: true,
      log: false,
      relocatable: false,
      write_debug_names: false,
    });
    return Buffer.from(generated.buffer);
  } finally {
    parsed.destroy();
  }
}

async function main() {
  const write = process.argv.slice(2).includes('--write');
  const unknown = process.argv.slice(2).filter((value) => value !== '--write');
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(', ')}`);
  const bytes = await compile();
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error('Foundation identifier WASM must have zero imports');
  }
  if (write) {
    fs.writeFileSync(TARGET, bytes);
    console.log(`wrote ${path.relative(ROOT, TARGET)} (${bytes.length} bytes)`);
    return;
  }
  if (!fs.existsSync(TARGET)) throw new Error('Foundation identifier WASM is missing; run with --write');
  const actual = fs.readFileSync(TARGET);
  if (!actual.equals(bytes)) {
    throw new Error('Foundation identifier WASM drifted from locked WAT+wabt build');
  }
  console.log(`PASS Foundation identifier WASM deterministic rebuild (${bytes.length} bytes, zero imports)`);
}

main().catch((cause) => {
  console.error(cause.stack || cause.message);
  process.exitCode = 1;
});

module.exports = { compile };
