'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertExternalAuthorityFile,
  normalizeBundle,
  normalizeConfig,
  parseArguments,
  readCanonicalJson,
} = require('../run-m2-adoption-verifier.cjs');
const { canonicalJcs } = require('../lib/m2-terminal-runtime-closure.cjs');

const PROFILE_ROOT = path.resolve(__dirname, '..', 'release-profile', 'v0.3.0');

test('terminal CLI accepts only one external config and no signing authority', () => {
  const parsed = parseArguments(['--config', 'external-config.json']);
  assert.equal(parsed.configPath, 'external-config.json');
  assert.throws(() => parseArguments([]), /requires exactly one/u);
  assert.throws(
    () => parseArguments(['--config', 'a.json', '--config', 'b.json']),
    /requires exactly one/u,
  );
  assert.throws(
    () => parseArguments(['--private-key', 'forbidden.pem']),
    /unknown argument/u,
  );
});

test('terminal CLI accepts only byte-exact canonical JCS authority files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, canonicalJcs({ schemaVersion: '1.0', state: 'consumed' }));
  assert.equal(readCanonicalJson(file, 'state').value.state, 'consumed');
  fs.writeFileSync(file, `${canonicalJcs({ schemaVersion: '1.0', state: 'consumed' })}\n`);
  assert.throws(() => readCanonicalJson(file, 'state'), /exact RFC 8785 JCS/u);
});

test('terminal bundle is closed and authority files cannot live inside candidate roots', (t) => {
  const fields = {
    schemaVersion: '1.0',
    refs: {},
    challenge: {},
    approval: {},
    adoptionReceipt: {},
    checkoutManifest: {},
    coordinatorState: {},
    adoptionReport: {},
    adoptionDependencyManifest: {},
    attestation: {},
    expected: {},
    verifiedChecks: [],
  };
  assert.equal(normalizeBundle(fields).schemaVersion, '1.0');
  assert.throws(
    () => normalizeBundle({ ...fields, callerOverride: true }),
    /closed schema/u,
  );

  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-cli-repo-'));
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-cli-checkout-'));
  t.after(() => {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  });
  assert.throws(
    () => assertExternalAuthorityFile(
      path.join(repository, 'candidate-policy.json'),
      [repository, checkout],
      'policy',
    ),
    /outside the candidate, checkout, and runtime roots/u,
  );
});

test('terminal config is closed and carries paths plus embedded external pins', () => {
  const absolute = (name) => path.resolve(os.tmpdir(), name);
  const config = {
    schemaVersion: '1.0',
    runtimeRoot: absolute('runtime'),
    runtimeClosurePath: absolute('closure.json'),
    bundlePath: absolute('bundle.json'),
    repositoryRoot: absolute('repo'),
    checkoutRoot: absolute('checkout'),
    coordinatorStatePath: absolute('state.json'),
    decisionTrustPolicyPath: absolute('decision.json'),
    verificationTrustPolicyPath: absolute('verification.json'),
    trustedPins: {},
  };
  assert.equal(normalizeConfig(config).runtimeClosurePath, absolute('closure.json'));
  assert.throws(
    () => normalizeConfig({ ...config, callerTerminalResult: { releaseComplete: true } }),
    /closed schema/u,
  );
});

test('terminal transport and out-of-band pin schemas are closed JSON Schema artifacts', () => {
  for (const name of [
    'terminal-adoption-bundle.schema.json',
    'terminal-adoption-config.schema.json',
    'terminal-adoption-runtime-closure.schema.json',
    'terminal-adoption-trusted-pins.schema.json',
  ]) {
    const bytes = fs.readFileSync(path.join(PROFILE_ROOT, name));
    const value = JSON.parse(bytes.toString('utf8'));
    assert.equal(value.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(value.additionalProperties, false);
    const canonical = Buffer.from(canonicalJcs(value), 'utf8');
    assert.equal(
      bytes.equals(canonical) || bytes.equals(Buffer.concat([canonical, Buffer.from('\n')])),
      true,
    );
  }
});
