#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  INPUT_FIXTURE_REL,
  S5ControlChainError,
  createS5ControlRecordChain,
  verifyS5ControlRecordChain,
} = require('./lib/s5-control-record-chain.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.join(__dirname, '..', '..');

function usage() {
  return 'usage: node scripts/domain/run-s5-control-record-chain.cjs '
    + '[--check | --output <empty-directory> | --verify <evidence-directory>]';
}

function outputSummary(summary) {
  process.stdout.write(`${canonicalJcs(summary)}\n`);
}

function createAt(directory) {
  return createS5ControlRecordChain(
    { kind: 'path', root: 'sourceTree', path: INPUT_FIXTURE_REL },
    { sourceTree: ROOT, buildEvidence: directory },
  );
}

function main() {
  const [mode = '--check', argument, extra] = process.argv.slice(2);
  if (extra !== undefined || !['--check', '--output', '--verify'].includes(mode)) {
    throw new Error(usage());
  }
  if (mode === '--check') {
    if (argument !== undefined) throw new Error(usage());
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-s5-control-chain-'));
    try {
      outputSummary(createAt(directory));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    return;
  }
  if (typeof argument !== 'string' || !path.isAbsolute(argument)) {
    throw new Error(`${mode} requires an absolute directory path`);
  }
  if (mode === '--output') {
    if (!fs.existsSync(argument)) fs.mkdirSync(argument, { recursive: true });
    if (!fs.statSync(argument).isDirectory() || fs.readdirSync(argument).length !== 0) {
      throw new Error('--output target must be an empty directory');
    }
    outputSummary(createAt(argument));
    return;
  }
  if (!fs.existsSync(argument) || !fs.statSync(argument).isDirectory()) {
    throw new Error('--verify target must be an existing evidence directory');
  }
  outputSummary(verifyS5ControlRecordChain({ sourceTree: ROOT, buildEvidence: argument }));
}

try {
  main();
} catch (error) {
  if (error instanceof S5ControlChainError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(`${error.stack || error.message}\n`);
  }
  process.exitCode = 1;
}
