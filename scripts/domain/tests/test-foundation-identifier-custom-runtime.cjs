'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  CONSTRAINTS,
  IDENTIFIER_CORE_PATH,
  MAX_INPUT_UTF8_BYTES,
  executeIdentifierConstraint,
  isinChecksumValid,
  leiChecksumValid,
  normalizeSchemeValidatorRegistry,
  validateIsolatedWasmModule,
  wasmCoreValidate,
} = require('../lib/foundation-identifier-custom.cjs');
const {
  ROOT,
  WASM_BUILD_PATH,
  discoverIdentifierConstraints,
  executeSandboxed,
  expectedCapabilityRows,
  loadCapabilityArtifacts,
  loadFoundationModule,
  verifyImplementationClosure,
} = require('../lib/foundation-identifier-capability.cjs');
const {
  assessPosixLeastPrivilege,
  assessWindowsLeastPrivilege,
} = require('../run-foundation-identifier-custom.cjs');

const BASE = 'https://axiolune.ai/ontology/finance/foundation/';
const ACCOUNT_VALIDATOR = 'https://axiolune.ai/validators/local/account-id-v1';
const HOST_IMPORT_WASM = Buffer.from(
  'AGFzbQEAAAABBAFgAAACDAEDZW52BGhvc3QAAAMCAQAHBwEDcnVuAAEKBAECAAs=',
  'base64',
);

test('Windows least-privilege assessment is SID-based and locale independent', () => {
  const localizedWhoamiBytes = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x80, 0x81]),
    Buffer.from(' S-1-5-32-544 S-1-16-8192 ', 'ascii'),
    Buffer.from([0x82, 0x83]),
  ]);
  assert.deepEqual(
    assessWindowsLeastPrivilege(
      { status: 0, stdout: localizedWhoamiBytes },
      { status: 0, stdout: 'not-enabled\r\n' },
    ),
    {
      administratorDenyOnly: true,
      integrityLevelSid: 'S-1-16-8192',
      platform: 'win32',
      verified: true,
    },
  );
});

test('Windows elevated administrator and failed probes fail closed', () => {
  const mediumAdmin = Buffer.from('S-1-5-32-544 S-1-16-8192', 'ascii');
  assert.equal(
    assessWindowsLeastPrivilege(
      { status: 0, stdout: mediumAdmin },
      { status: 0, stdout: 'enabled\n' },
    ).verified,
    false,
  );
  assert.equal(
    assessWindowsLeastPrivilege(
      { status: 0, stdout: mediumAdmin },
      { status: 1, stdout: '', stderr: 'probe failed' },
    ).verified,
    false,
  );
  assert.equal(
    assessWindowsLeastPrivilege(
      { status: 1, stdout: mediumAdmin },
      { status: 0, stdout: 'not-enabled\n' },
    ).verified,
    false,
  );
});

test('POSIX least-privilege assessment rejects root and missing UID', () => {
  assert.deepEqual(assessPosixLeastPrivilege(1000, 'linux'), {
    platform: 'linux',
    uid: 1000,
    verified: true,
  });
  assert.equal(assessPosixLeastPrivilege(0, 'linux').verified, false);
  assert.equal(assessPosixLeastPrivilege(null, 'linux').verified, false);
});

function input(profile, lexicalValue, schemeValidatorRef = null) {
  return {
    constraintDefinitionIri: `${BASE}${profile}Validation`,
    focusNode: `https://axiolune.ai/data/test/runtime/${profile}`,
    lexicalValue,
    schemaVersion: '1.0',
    schemeValidatorRef,
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-identifier-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(resolved, { force: true, recursive: true });
  });
  return directory;
}

function referenceLuhn(value) {
  let digits = '';
  for (const character of value) {
    digits += /[0-9]/u.test(character) ? character : String(character.charCodeAt(0) - 55);
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function createIsin(base) {
  for (let check = 0; check <= 9; check += 1) {
    const candidate = `${base}${check}`;
    if (referenceLuhn(candidate)) return candidate;
  }
  throw new Error(`no ISIN check digit for ${base}`);
}

function referenceMod97(value) {
  let remainder = 0;
  for (const character of value) {
    const digits = /[0-9]/u.test(character)
      ? character : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = ((remainder * 10) + Number(digit)) % 97;
  }
  return remainder;
}

function createLei(base) {
  const check = 98 - referenceMod97(`${base}00`);
  return `${base}${String(check).padStart(2, '0')}`;
}

const artifacts = loadCapabilityArtifacts();
const registry = normalizeSchemeValidatorRegistry(artifacts.registry);

test('ISIN implementation enforces lexical structure and the Luhn check digit', () => {
  assert.equal(isinChecksumValid('US0378331005'), true);
  assert.equal(isinChecksumValid('GB0002634946'), true);
  assert.equal(isinChecksumValid('US0378331006'), false);
  assert.equal(isinChecksumValid('us0378331005'), false);
  assert.equal(executeIdentifierConstraint(input('ISIN', 'US0378331005'), registry).outcome, 'conforms');
  assert.equal(
    executeIdentifierConstraint(input('ISIN', 'US0378331006'), registry).violations[0].code,
    'ISIN_CHECK_DIGIT',
  );
});

test('LEI implementation executes ISO/IEC 7064 MOD 97-10 rather than format-only validation', () => {
  assert.equal(leiChecksumValid('HWUPKR0MPOU8FGXBT394'), true);
  assert.equal(leiChecksumValid('5493001KJTIIGC8Y1R12'), true);
  assert.equal(leiChecksumValid('HWUPKR0MPOU8FGXBT395'), false);
  assert.equal(leiChecksumValid('hwupkr0mpou8fgxbt394'), false);
  assert.equal(executeIdentifierConstraint(input('LEI', 'HWUPKR0MPOU8FGXBT394'), registry).outcome, 'conforms');
  assert.equal(
    executeIdentifierConstraint(input('LEI', 'HWUPKR0MPOU8FGXBT395'), registry).violations[0].code,
    'LEI_CHECK_DIGIT',
  );
});

test('WASM checksum core agrees with deterministic independent ISIN and LEI reference vectors', () => {
  for (let index = 0; index < 100; index += 1) {
    const isin = createIsin(`US${index.toString(36).toUpperCase().padStart(9, '0')}`);
    assert.equal(isinChecksumValid(isin), true, isin);
    assert.equal(
      isinChecksumValid(`${isin.slice(0, -1)}${(Number(isin.at(-1)) + 1) % 10}`),
      false,
      isin,
    );
    const leiBase = `5493${index.toString(36).toUpperCase().padStart(14, '0')}`;
    const lei = createLei(leiBase);
    assert.equal(referenceMod97(lei), 1, lei);
    assert.equal(leiChecksumValid(lei), true, lei);
    assert.equal(
      leiChecksumValid(`${lei.slice(0, -1)}${(Number(lei.at(-1)) + 1) % 10}`),
      false,
      lei,
    );
  }
});

test('WASM core has zero host imports, exact exports, and a one-page hard memory maximum', () => {
  const bytes = fs.readFileSync(IDENTIFIER_CORE_PATH);
  const validated = validateIsolatedWasmModule(bytes);
  assert.deepEqual(WebAssembly.Module.imports(validated.module), []);
  assert.deepEqual(
    WebAssembly.Module.exports(validated.module).map((row) => row.name).sort(),
    ['memory', 'validate_isin', 'validate_lei', 'validate_local', 'validate_mic'],
  );
  assert.throws(() => validated.instance.exports.memory.grow(1), RangeError);
  assert.equal(wasmCoreValidate('validate_isin', 'US0378331005'), 0);
});

test('WASM isolation rejects host imports and oversized input fails before guest execution', () => {
  assert.throws(
    () => validateIsolatedWasmModule(HOST_IMPORT_WASM),
    (cause) => cause?.code === 'IDENTIFIER_WASM_HOST_IMPORT',
  );
  const oversized = executeIdentifierConstraint(
    input('LocalIdentifier', 'A'.repeat(MAX_INPUT_UTF8_BYTES + 1), ACCOUNT_VALIDATOR),
    registry,
  );
  assert.equal(oversized.outcome, 'engineFailure');
  assert.equal(oversized.errors[0].code, 'IDENTIFIER_INPUT_CONTRACT');
});

test('locked WAT and wabt 1.0.39 deterministically rebuild the checked-in WASM bytes', () => {
  const execution = spawnSync(process.execPath, [WASM_BUILD_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 15000,
  });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.match(execution.stdout, /deterministic rebuild/u);
});

test('MIC is exactly four uppercase ASCII alphanumeric characters', () => {
  assert.equal(executeIdentifierConstraint(input('MIC', 'XNAS'), registry).outcome, 'conforms');
  for (const value of ['xnas', 'XNASX', 'XN-S', 'ＸＮＡＳ']) {
    const result = executeIdentifierConstraint(input('MIC', value), registry);
    assert.equal(result.outcome, 'violation');
    assert.equal(result.violations[0].code, 'MIC_LEXICAL_FORM');
  }
});

test('LocalIdentifier requires NFC and a locked scheme-specific validator', () => {
  assert.equal(
    executeIdentifierConstraint(input('LocalIdentifier', 'ACCT-001', ACCOUNT_VALIDATOR), registry).outcome,
    'conforms',
  );
  const noValidator = executeIdentifierConstraint(input('LocalIdentifier', 'ACCT-001'), registry);
  assert.equal(noValidator.outcome, 'violation');
  assert.equal(noValidator.violations[0].code, 'LOCAL_IDENTIFIER_SCHEME_VALIDATOR_REQUIRED');

  const decomposed = executeIdentifierConstraint(
    input('LocalIdentifier', 'e\u0301', ACCOUNT_VALIDATOR),
    registry,
  );
  assert.equal(decomposed.outcome, 'violation');
  assert.ok(decomposed.violations.some((row) => row.code === 'LOCAL_IDENTIFIER_NOT_NFC'));

  const unbound = executeIdentifierConstraint(
    input('LocalIdentifier', 'ACCT-001', 'https://axiolune.ai/validators/local/unbound-v1'),
    registry,
  );
  assert.equal(unbound.outcome, 'engineFailure');
  assert.equal(unbound.errors[0].code, 'LOCAL_IDENTIFIER_SCHEME_VALIDATOR_UNBOUND');
});

test('closed input contract rejects unknown fields and unbound Custom constraints as engine failures', () => {
  const extra = { ...input('ISIN', 'US0378331005'), injected: true };
  assert.equal(executeIdentifierConstraint(extra, registry).errors[0].code, 'IDENTIFIER_INPUT_CONTRACT');
  const unknown = {
    ...input('ISIN', 'US0378331005'),
    constraintDefinitionIri: `${BASE}UnknownValidation`,
  };
  assert.equal(executeIdentifierConstraint(unknown, registry).errors[0].code, 'IDENTIFIER_CUSTOM_UNBOUND');
});

test('scheme-validator registry is digest-locked, closed, sorted, and unique', () => {
  assert.equal(registry.size, 2);
  const tampered = structuredClone(artifacts.registry);
  tampered.validators[0].pattern = '^.*$';
  assert.throws(() => normalizeSchemeValidatorRegistry(tampered), /digest mismatch/u);
  const reordered = structuredClone(artifacts.registry);
  reordered.validators.reverse();
  assert.throws(() => normalizeSchemeValidatorRegistry(reordered), /sorted and unique/u);
});

test('discovery contract exactly closes the four authored Foundation Identifier Custom constraints', () => {
  const moduleDocument = loadFoundationModule();
  assert.deepEqual(
    discoverIdentifierConstraints(moduleDocument, artifacts.discovery),
    Object.keys(CONSTRAINTS).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
  const missing = structuredClone(moduleDocument);
  delete missing.domain.constraints.LEIValidation;
  assert.throws(
    () => discoverIdentifierConstraints(missing, artifacts.discovery),
    /inventory mismatch/u,
  );
  const drifted = structuredClone(moduleDocument);
  drifted.domain.constraints.MICValidation.expression.expression = 'format-only=true';
  assert.throws(
    () => discoverIdentifierConstraints(drifted, artifacts.discovery),
    /constraint drift/u,
  );

  const unbound = structuredClone(moduleDocument);
  unbound.domain.constraintBindings = unbound.domain.constraintBindings.filter((binding) => (
    binding.constraintRef !== `${BASE}ISINValidation`
  ));
  assert.throws(
    () => discoverIdentifierConstraints(unbound, artifacts.discovery),
    /ConstraintBinding drift/u,
  );

  const advisory = structuredClone(moduleDocument);
  advisory.domain.constraintBindings.find((binding) => (
    binding.constraintRef === `${BASE}MICValidation`
  )).enforcementLevel = 'Advisory';
  assert.throws(
    () => discoverIdentifierConstraints(advisory, artifacts.discovery),
    /ConstraintBinding drift/u,
  );
});

test('implementation closure rejects byte substitution and capability rows bind every required artifact digest', () => {
  const closure = verifyImplementationClosure();
  const tampered = structuredClone(closure);
  tampered.artifacts[0].digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => verifyImplementationClosure(tampered), /digest mismatch/u);
  const rows = expectedCapabilityRows(artifacts);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.capabilityId), [
    'foundation-isin-validation',
    'foundation-lei-validation',
    'foundation-local-identifier-validation',
    'foundation-mic-validation',
  ]);
  for (const row of rows) {
    for (const field of Object.keys(row).filter((key) => key.endsWith('Digest'))) {
      assert.match(row[field], /^sha256:[0-9a-f]{64}$/u);
    }
  }
});

test('sandboxed worker distinguishes conformance, domain violation, and engine failure', () => {
  const accepted = executeSandboxed(input('ISIN', 'US0378331005'));
  assert.equal(accepted.output.outcome, 'conforms');
  const violation = executeSandboxed(input('LEI', 'HWUPKR0MPOU8FGXBT395'));
  assert.equal(violation.output.outcome, 'violation');
  assert.equal(violation.output.violations[0].code, 'LEI_CHECK_DIGIT');
  const failure = executeSandboxed({
    ...input('ISIN', 'US0378331005'),
    constraintDefinitionIri: `${BASE}UnknownValidation`,
  });
  assert.equal(failure.output.outcome, 'engineFailure');
  assert.equal(failure.output.errors[0].code, 'IDENTIFIER_CUSTOM_UNBOUND');
});

test('locked vector runner emits digest-bound evidence and does not overclaim release eligibility', (t) => {
  const output = temporaryDirectory(t);
  const runner = path.join(ROOT, 'scripts', 'domain', 'run-foundation-identifier-custom.cjs');
  const execution = spawnSync(process.execPath, [runner, '--output-dir', output], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 30000,
  });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const evidencePath = path.join(output, 'foundation-identifier-custom-evidence.json');
  assert.ok(fs.existsSync(evidencePath));
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.releaseEligible, false);
  assert.equal(evidence.executionAssurance.networkIsolation, false);
  assert.equal(
    evidence.executionAssurance.leastPrivilegeUser,
    evidence.runtime.leastPrivilege.verified,
  );
  if (process.platform === 'win32') {
    assert.equal(evidence.runtime.leastPrivilege.integrityLevelSid, 'S-1-16-8192');
    assert.equal(evidence.runtime.leastPrivilege.administratorDenyOnly, true);
  }
  assert.deepEqual(
    [...new Set(evidence.vectorResults.map((row) => row.category))].sort(),
    ['emptySubject', 'engineFailure', 'positive', 'tamper', 'violation'],
  );
  assert.ok(evidence.vectorResults.every((row) => row.status === 'passed'));
});
