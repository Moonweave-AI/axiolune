#!/usr/bin/env node
'use strict';

// Bootstrap imports are deliberately limited to Node built-ins plus the
// measured-closure bootstrap.  Cryptographic/Git/component modules are not
// evaluated until verifyTerminalRuntimeClosure succeeds.
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJcs,
  verifyTerminalRuntimeClosure,
} = require('./lib/m2-terminal-runtime-closure.cjs');

const TERMINAL_VERIFIER_ID = 'm2-terminal-adoption-verifier';
const TERMINAL_SCOPE = 'terminal-adoption';
const CONFIG_ARGUMENT = '--config';

function usage() {
  return [
    'Usage: node scripts/domain/run-m2-adoption-verifier.cjs',
    '  --config <external-canonical-jcs-terminal-config.json>',
    '',
    'The config, trust pins, runtime-closure manifest, coordinator state, and',
    'public-key policies must remain outside the candidate/runtime Git roots.',
    'This command is read-only: it cannot sign, commit, or update a ref.',
  ].join('\n');
}

function assertPristineNodeBootstrap() {
  if (process.execArgv.length !== 0) {
    throw new Error('terminal verifier forbids Node execution flags/preloads');
  }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH']) {
    const row = Object.entries(process.env).find(([key]) => key.toUpperCase() === name);
    if (row && row[1]) throw new Error(`terminal verifier forbids inherited ${name}`);
  }
  const expected = new Set([
    fs.realpathSync.native(__filename),
    fs.realpathSync.native(require.resolve('./lib/m2-terminal-runtime-closure.cjs')),
  ]);
  const unexpected = Object.keys(require.cache)
    .map((file) => fs.realpathSync.native(file))
    .filter((file) => !expected.has(file));
  if (unexpected.length > 0) {
    throw new Error('terminal verifier detected modules evaluated before runtime preflight');
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== CONFIG_ARGUMENT
      || typeof argv[1] !== 'string' || argv[1].length === 0
      || argv[1].startsWith('--')) {
    const unknown = argv.find((argument) => argument.startsWith('--')
      && argument !== CONFIG_ARGUMENT);
    if (unknown) throw new Error(`unknown argument ${unknown}`);
    throw new Error('--config requires exactly one external config path');
  }
  return { configPath: argv[1] };
}

function readCanonicalJson(file, label) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const real = fs.realpathSync.native(absolute);
  const bytes = fs.readFileSync(real);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${label} is not strict UTF-8 JSON: ${cause.message}`);
  }
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} bytes are not exact RFC 8785 JCS`);
  }
  return { absolute: real, bytes, value };
}

function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a closed object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`${label} fields differ from the closed schema`);
  }
}

function normalizeConfig(config) {
  exactKeys(config, [
    'schemaVersion', 'runtimeRoot', 'runtimeClosurePath', 'bundlePath',
    'repositoryRoot', 'checkoutRoot', 'coordinatorStatePath',
    'decisionTrustPolicyPath', 'verificationTrustPolicyPath', 'trustedPins',
  ], 'terminal verifier config');
  if (config.schemaVersion !== '1.0') {
    throw new Error('terminal verifier config.schemaVersion must be 1.0');
  }
  for (const field of [
    'runtimeRoot', 'runtimeClosurePath', 'bundlePath', 'repositoryRoot',
    'checkoutRoot', 'coordinatorStatePath', 'decisionTrustPolicyPath',
    'verificationTrustPolicyPath',
  ]) {
    if (typeof config[field] !== 'string' || config[field].length === 0
        || !path.isAbsolute(config[field])) {
      throw new Error(`terminal verifier config.${field} must be an absolute path`);
    }
  }
  if (!config.trustedPins || typeof config.trustedPins !== 'object'
      || Array.isArray(config.trustedPins)) {
    throw new Error('terminal verifier config.trustedPins must be a closed object');
  }
  return config;
}

function normalizeBundle(bundle) {
  const fields = [
    'schemaVersion', 'refs', 'challenge', 'approval', 'adoptionReceipt',
    'checkoutManifest', 'coordinatorState', 'adoptionReport',
    'adoptionDependencyManifest', 'attestation', 'expected', 'verifiedChecks',
  ];
  exactKeys(bundle, fields, 'terminal bundle');
  if (bundle.schemaVersion !== '1.0' || !Array.isArray(bundle.verifiedChecks)) {
    throw new Error('terminal bundle schemaVersion/check inventory is invalid');
  }
  return bundle;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sameFilesystemPath(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return normalize(left) === normalize(right);
}

function assertExternalAuthorityFile(file, roots, label) {
  for (const root of roots) {
    if (isInside(file, root)) {
      throw new Error(`${label} must be outside the candidate, checkout, and runtime roots`);
    }
  }
}

function assertStableRead(first, second, label) {
  if (first.absolute !== second.absolute || !first.bytes.equals(second.bytes)) {
    throw new Error(`${label} changed during terminal verification`);
  }
}

function failureDiagnostic(cause, context = {}) {
  return {
    schemaVersion: '1.0',
    verifierId: TERMINAL_VERIFIER_ID,
    verificationScope: TERMINAL_SCOPE,
    outcome: 'pending',
    eligible: false,
    approvalStatus: 'not-approved',
    adoptionStatus: 'not-terminally-verified',
    releaseComplete: false,
    repositoryId: context.repositoryId || null,
    authoritativeRef: context.authoritativeRef || null,
    issues: [{
      code: 'M2_TERMINAL_ADOPTION_NOT_ESTABLISHED',
      kind: 'unverified',
      message: cause && cause.message ? cause.message : String(cause),
    }],
  };
}

function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${usage()}\n${cause.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let result;
  let context = {};
  try {
    assertPristineNodeBootstrap();
    const configRead = readCanonicalJson(parsed.configPath, 'terminal verifier config');
    const config = normalizeConfig(configRead.value);
    context = {
      repositoryId: config.trustedPins.repositoryId,
      authoritativeRef: config.trustedPins.authoritativeRef,
    };
    const runtimeRoot = fs.realpathSync.native(path.resolve(config.runtimeRoot));
    const runningRuntimeRoot = fs.realpathSync.native(path.resolve(__dirname, '..', '..'));
    if (!sameFilesystemPath(runtimeRoot, runningRuntimeRoot)) {
      throw new Error('terminal runtimeRoot does not contain the running CLI bootstrap');
    }
    const repositoryRoot = fs.realpathSync.native(path.resolve(config.repositoryRoot));
    const checkoutRoot = fs.realpathSync.native(path.resolve(config.checkoutRoot));
    const authorityRoots = [...new Set([runtimeRoot, repositoryRoot, checkoutRoot])];
    assertExternalAuthorityFile(configRead.absolute, authorityRoots, 'terminal verifier config');

    const closureRead = readCanonicalJson(
      config.runtimeClosurePath,
      'terminal runtime closure manifest',
    );
    assertExternalAuthorityFile(
      closureRead.absolute,
      authorityRoots,
      'terminal runtime closure manifest',
    );
    verifyTerminalRuntimeClosure({
      runtimeRoot,
      manifest: closureRead.value,
      expectedClosureDigest: config.trustedPins.terminalRuntimeClosureDigest,
    });

    // Only after the fixed runtime closure passes may Node evaluate the
    // cryptographic, Git, and component-verifier modules.
    const {
      verifyTerminalAdoption,
    } = require('./lib/m2-terminal-adoption-verifier.cjs');

    const bundle = readCanonicalJson(config.bundlePath, 'terminal evidence bundle');
    const coordinator = readCanonicalJson(
      config.coordinatorStatePath,
      'protected coordinator state observation',
    );
    const decisionPolicy = readCanonicalJson(
      config.decisionTrustPolicyPath,
      'decision trust policy',
    );
    const verificationPolicy = readCanonicalJson(
      config.verificationTrustPolicyPath,
      'verification trust policy',
    );
    for (const [item, label] of [
      [bundle, 'terminal evidence bundle'],
      [coordinator, 'protected coordinator state observation'],
      [decisionPolicy, 'decision trust policy'],
      [verificationPolicy, 'verification trust policy'],
    ]) assertExternalAuthorityFile(item.absolute, authorityRoots, label);

    let terminalCoordinatorObservation = null;
    const readCoordinatorState = () => {
      const observed = readCanonicalJson(
        config.coordinatorStatePath,
        'protected coordinator state observation',
      );
      assertExternalAuthorityFile(
        observed.absolute,
        authorityRoots,
        'protected coordinator state observation',
      );
      if (observed.absolute !== coordinator.absolute) {
        throw new Error('protected coordinator authority path changed during terminal verification');
      }
      if (terminalCoordinatorObservation) {
        assertStableRead(
          terminalCoordinatorObservation,
          observed,
          'protected coordinator state observation',
        );
      }
      terminalCoordinatorObservation = observed;
      return observed.value;
    };
    result = verifyTerminalAdoption({
      runtimeRoot,
      runtimeClosure: closureRead.value,
      repositoryRoot,
      checkoutRoot,
      evidence: normalizeBundle(bundle.value),
      decisionTrustPolicy: decisionPolicy.value,
      verificationTrustPolicy: verificationPolicy.value,
      readCoordinatorState,
      trustedPins: config.trustedPins,
    });

    assertStableRead(
      configRead,
      readCanonicalJson(parsed.configPath, 'terminal verifier config'),
      'terminal verifier config',
    );
    assertStableRead(
      closureRead,
      readCanonicalJson(config.runtimeClosurePath, 'terminal runtime closure manifest'),
      'terminal runtime closure manifest',
    );
    assertStableRead(
      bundle,
      readCanonicalJson(config.bundlePath, 'terminal evidence bundle'),
      'terminal evidence bundle',
    );
    if (!terminalCoordinatorObservation) {
      throw new Error('terminal verifier did not query the protected coordinator authority');
    }
    assertStableRead(
      terminalCoordinatorObservation,
      readCanonicalJson(
        config.coordinatorStatePath,
        'protected coordinator state observation',
      ),
      'protected coordinator state observation',
    );
    assertStableRead(
      decisionPolicy,
      readCanonicalJson(config.decisionTrustPolicyPath, 'decision trust policy'),
      'decision trust policy',
    );
    assertStableRead(
      verificationPolicy,
      readCanonicalJson(config.verificationTrustPolicyPath, 'verification trust policy'),
      'verification trust policy',
    );
  } catch (cause) {
    result = failureDiagnostic(cause, context);
  }
  process.stdout.write(`${canonicalJcs(result)}\n`);
  process.exitCode = result.releaseComplete === true ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  assertPristineNodeBootstrap,
  assertExternalAuthorityFile,
  failureDiagnostic,
  isInside,
  main,
  normalizeBundle,
  normalizeConfig,
  parseArguments,
  readCanonicalJson,
  usage,
};
