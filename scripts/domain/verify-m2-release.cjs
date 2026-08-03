#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  CRITERION_REFS,
  VERIFIER_ID,
  verifyM2Release,
} = require('./lib/m2-release-verifier.cjs');

function usage() {
  return 'Usage: node scripts/domain/verify-m2-release.cjs '
    + '--release-dir <candidate-directory> [--output-dir <detached-output-directory>] '
    + '[--expected-repository-id <absolute-iri> '
    + '--expected-authoritative-ref <refs/...> --expected-old-commit-id <hex>] '
    + '[--decision-trust-policy <independently-trusted-policy.json>]';
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if ([
      '--release-dir', '--output-dir', '--expected-repository-id',
      '--expected-authoritative-ref', '--expected-old-commit-id',
      '--decision-trust-policy',
    ].includes(argument)) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error(`${argument} requires one path`);
      }
      const key = {
        '--release-dir': 'releaseDir',
        '--output-dir': 'outputDir',
        '--expected-repository-id': 'expectedRepositoryId',
        '--expected-authoritative-ref': 'expectedAuthoritativeRef',
        '--expected-old-commit-id': 'expectedOldCommitId',
        '--decision-trust-policy': 'decisionTrustPolicyPath',
      }[argument];
      if (Object.hasOwn(options, key)) throw new Error(`${argument} may be provided only once`);
      options[key] = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  if (!options.releaseDir) throw new Error('--release-dir is required');
  return options;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function prospectiveRealPath(target) {
  const unresolved = [];
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(target);
    unresolved.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(fs.realpathSync(cursor), ...unresolved);
}

function validateDetachedOutput(releaseDir, outputDir) {
  if (!outputDir) return;
  if (isInside(outputDir, releaseDir)) {
    throw new Error('refusing to write verifier diagnostics inside the reviewed candidate directory');
  }
  if (fs.existsSync(outputDir)) {
    const stat = fs.lstatSync(outputDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('detached output path must be a non-symlink directory');
    }
  }
  if (fs.existsSync(releaseDir)) {
    const realRelease = fs.realpathSync(releaseDir);
    const realOutput = prospectiveRealPath(outputDir);
    if (isInside(realOutput, realRelease)) {
      throw new Error('refusing to write verifier diagnostics through a symlink into the reviewed candidate directory');
    }
  }
  const diagnostic = path.join(outputDir, 'release-verification-diagnostic.json');
  if (fs.existsSync(diagnostic)) {
    throw new Error('refusing to overwrite an existing detached verifier diagnostic');
  }
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${usage()}\n${cause.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const releaseDir = path.resolve(options.releaseDir);
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : null;
  try {
    validateDetachedOutput(releaseDir, outputDir);
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = verifyM2Release({
      releaseDir,
      expectedRepositoryId: options.expectedRepositoryId,
      expectedAuthoritativeRef: options.expectedAuthoritativeRef,
      expectedOldCommitId: options.expectedOldCommitId,
      decisionTrustPolicyPath: options.decisionTrustPolicyPath,
    });
  } catch (cause) {
    result = {
      schemaVersion: '1.0',
      verifierId: VERIFIER_ID,
      profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
      targetVersion: '0.3.0',
      verificationScope: 'post-payload-approval-eligibility',
      governanceOutcome: 'engineFailure',
      trustedScope: {
        repositoryId: options.expectedRepositoryId || null,
        authoritativeRef: options.expectedAuthoritativeRef || null,
        expectedOldCommitId: options.expectedOldCommitId || null,
        provided: Boolean(options.expectedRepositoryId
          && options.expectedAuthoritativeRef && options.expectedOldCommitId),
        matched: false,
      },
      outcome: 'engineFailure',
      eligible: false,
      criterionResults: CRITERION_REFS.map((criterionRef) => ({
        criterionRef,
        status: 'notEstablished',
        evidence: [],
      })),
      approvalStatus: 'not-approved',
      adoptionStatus: 'not-verified',
      releaseComplete: false,
      releaseDirectory: releaseDir,
      checkedArtifacts: [],
      issueCounts: { invalid: 1, missing: 0, unverified: 0 },
      issues: [{
        code: 'M2_RELEASE_VERIFIER_ENGINE_FAILURE',
        stage: 'verifier',
        path: '',
        kind: 'invalid',
        message: cause && cause.message ? cause.message : String(cause),
      }],
    };
  }

  const bytes = Buffer.from(`${canonicalJcs(result)}\n`, 'utf8');
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'release-verification-diagnostic.json'),
      bytes,
      { flag: 'wx' },
    );
  }
  process.stdout.write(bytes);
  process.exitCode = result.eligible ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  isInside,
  main,
  parseArguments,
  prospectiveRealPath,
  validateDetachedOutput,
};
