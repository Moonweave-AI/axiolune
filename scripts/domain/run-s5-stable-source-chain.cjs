#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  INPUT_FIXTURE_REL,
  S5ControlChainError,
  createS5ControlRecordChain,
  verifyS5ControlRecordChain,
} = require('./lib/s5-control-record-chain.cjs');
const {
  inspectCommit,
  repositoryObjectFormat,
} = require('./lib/m2-git-replay.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

function usage() {
  return 'usage: node scripts/domain/run-s5-stable-source-chain.cjs '
    + '--generate <absolute-empty-evidence-directory> '
    + '--repository <absolute-git-repository> --commit <full-object-id>\n'
    + '   or: node scripts/domain/run-s5-stable-source-chain.cjs '
    + '--verify <absolute-evidence-directory> '
    + '--repository <absolute-git-repository>';
}

function parseArguments(argv) {
  if (argv.length !== 4 && argv.length !== 6) throw new Error(usage());
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--commit', '--generate', '--repository', '--verify'].includes(name)
        || values.has(name)
        || typeof value !== 'string'
        || value.length === 0) {
      throw new Error(usage());
    }
    values.set(name, value);
  }
  const generate = values.has('--generate');
  const verify = values.has('--verify');
  if (generate === verify
      || !values.has('--repository')
      || (generate !== values.has('--commit'))
      || values.size !== (generate ? 3 : 2)) {
    throw new Error(usage());
  }
  const repository = values.get('--repository');
  const evidence = values.get(generate ? '--generate' : '--verify');
  for (const [label, value] of [['repository', repository], ['evidence', evidence]]) {
    if (!path.isAbsolute(value)) throw new Error(`${label} path must be absolute`);
  }
  return { commitId: values.get('--commit'), evidence, generate, repository };
}

function requireDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} must be an existing directory`);
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  requireDirectory(options.repository, 'repository');
  if (options.generate) {
    if (!fs.existsSync(options.evidence)) fs.mkdirSync(options.evidence, { recursive: true });
    requireDirectory(options.evidence, 'evidence output');
    if (fs.readdirSync(options.evidence).length !== 0) {
      throw new Error('evidence output must be empty');
    }
    const gitObjectFormat = repositoryObjectFormat(options.repository);
    const commit = inspectCommit(options.repository, options.commitId, gitObjectFormat);
    const summary = createS5ControlRecordChain(
      { kind: 'path', root: 'sourceTree', path: INPUT_FIXTURE_REL },
      { sourceTree: options.repository, buildEvidence: options.evidence },
      {
        sourceTreeSelector: {
          commitId: commit.commitId,
          gitObjectFormat,
          schemaVersion: '1.0',
          selectorKind: 'gitCommit',
          treeId: commit.treeId,
        },
      },
    );
    process.stdout.write(`${canonicalJcs(summary)}\n`);
    return;
  }
  requireDirectory(options.evidence, 'evidence directory');
  const summary = verifyS5ControlRecordChain({
    sourceTree: options.repository,
    buildEvidence: options.evidence,
  });
  process.stdout.write(`${canonicalJcs(summary)}\n`);
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
