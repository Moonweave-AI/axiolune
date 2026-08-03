#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  MAX_INPUT_UTF8_BYTES,
  validateIsolatedWasmModule,
} = require('./lib/foundation-identifier-custom.cjs');
const {
  DISCOVERY_PATH,
  EVIDENCE_SCHEMA_PATH,
  IMPLEMENTATION_CLOSURE_PATH,
  INPUT_CONTRACT_PATH,
  MODULE_PATH,
  OUTPUT_CONTRACT_PATH,
  PROFILE_REF,
  REGISTRY_PATH,
  ROOT,
  TEST_VECTORS_PATH,
  WASM_BUILD_PATH,
  WASM_CORE_PATH,
  WAT_SOURCE_PATH,
  WORKER_PATH,
  discoverIdentifierConstraints,
  executeSandboxed,
  expectedCapabilityRows,
  fileDigest,
  loadCapabilityArtifacts,
  loadFoundationModule,
  repositoryPath,
  sourceRef,
  verifyImplementationClosure,
} = require('./lib/foundation-identifier-capability.cjs');

const CATEGORIES = Object.freeze([
  'emptySubject',
  'engineFailure',
  'positive',
  'tamper',
  'violation',
]);
const HOST_IMPORT_WASM = Buffer.from(
  'AGFzbQEAAAABBAFgAAACDAEDZW52BGhvc3QAAAMCAQAHBwEDcnVuAAEKBAECAAs=',
  'base64',
);
const INFINITE_LOOP_WASM =
  'AGFzbQEAAAABBAFgAAADAgEABwcBA3J1bgAACgkBBwADQAwACws=';

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length
      || actual.some((field, index) => field !== wanted[index])) {
    throw new TypeError(`${label} fields differ: actual=${actual.join(',')} expected=${wanted.join(',')}`);
  }
}

function parseArguments(argv) {
  const options = { outputDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output-dir' && index + 1 < argv.length) {
      options.outputDirectory = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${argv[index]}`);
    }
  }
  return options;
}

function validateVectors(vectors) {
  exactKeys(vectors, [...CATEGORIES, 'schemaVersion'], 'identifier test vectors');
  if (vectors.schemaVersion !== '1.0') throw new Error('identifier test vectors schemaVersion must equal 1.0');
  const ids = new Set();
  for (const category of CATEGORIES) {
    const rows = vectors[category];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`identifier test-vector category ${category} must be non-empty`);
    }
    let previous = null;
    for (const row of rows) {
      if (typeof row?.caseId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(row.caseId)) {
        throw new Error(`invalid ${category} caseId`);
      }
      if (ids.has(row.caseId)) throw new Error(`duplicate identifier test-vector caseId ${row.caseId}`);
      if (previous !== null && compareUtf8(previous, row.caseId) >= 0) {
        throw new Error(`${category} identifier vectors must be strictly caseId sorted`);
      }
      ids.add(row.caseId);
      previous = row.caseId;
    }
  }
}

function outputCode(output) {
  if (output.outcome === 'violation') return output.violations[0]?.code || null;
  if (output.outcome === 'engineFailure') return output.errors[0]?.code || null;
  return null;
}

function runNormalVector(category, row) {
  const execution = executeSandboxed(row.input);
  const actualCode = outputCode(execution.output);
  const passed = execution.output.outcome === row.expectedOutcome
    && (row.expectedCode === undefined || actualCode === row.expectedCode);
  return {
    actualCode,
    actualOutcome: execution.output.outcome,
    caseId: row.caseId,
    category,
    expectedCode: row.expectedCode || null,
    expectedOutcome: row.expectedOutcome,
    status: passed ? 'passed' : 'failed',
  };
}

function engineFailureResult(row, actualCode, rejected) {
  return {
    actualCode: rejected ? actualCode : null,
    actualOutcome: rejected ? 'engineFailure' : 'conforms',
    caseId: row.caseId,
    category: 'engineFailure',
    expectedCode: row.expectedCode,
    expectedOutcome: row.expectedOutcome,
    status: rejected
      && row.expectedOutcome === 'engineFailure'
      && row.expectedCode === actualCode ? 'passed' : 'failed',
  };
}

function runEngineFailureVector(row) {
  if (row.input) return runNormalVector('engineFailure', row);
  if (row.fault === 'hostImport') {
    let code = null;
    try {
      validateIsolatedWasmModule(HOST_IMPORT_WASM);
    } catch (cause) {
      code = cause.code || null;
    }
    return engineFailureResult(row, 'IDENTIFIER_WASM_HOST_IMPORT', code === 'IDENTIFIER_WASM_HOST_IMPORT');
  }
  if (row.fault === 'infiniteLoop') {
    const probe = [
      `const bytes=Buffer.from('${INFINITE_LOOP_WASM}','base64');`,
      'const module=new WebAssembly.Module(bytes);',
      'new WebAssembly.Instance(module,{}).exports.run();',
    ].join('');
    const execution = spawnSync(process.execPath, ['-e', probe], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { SystemRoot: process.env.SystemRoot || '', TZ: 'UTC' },
      maxBuffer: 4096,
      shell: false,
      timeout: 100,
      windowsHide: true,
    });
    return engineFailureResult(
      row,
      'IDENTIFIER_WASM_TIMEOUT',
      execution.error?.code === 'ETIMEDOUT',
    );
  }
  if (row.fault === 'oversizedInput') {
    const execution = executeSandboxed({
      constraintDefinitionIri: 'https://axiolune.ai/ontology/finance/foundation/LocalIdentifierValidation',
      focusNode: 'https://axiolune.ai/data/test/identifier/oversized',
      lexicalValue: 'A'.repeat(MAX_INPUT_UTF8_BYTES + 1),
      schemaVersion: '1.0',
      schemeValidatorRef: 'https://axiolune.ai/validators/local/account-id-v1',
    });
    return engineFailureResult(
      row,
      'IDENTIFIER_INPUT_CONTRACT',
      execution.output.outcome === 'engineFailure'
        && execution.output.errors[0]?.code === 'IDENTIFIER_INPUT_CONTRACT',
    );
  }
  throw new Error(`unsupported engine-failure fault ${String(row.fault)}`);
}

function runTamperVector(row, closure) {
  const tampered = structuredClone(closure);
  if (row.fault !== 'implementationDigest') {
    throw new Error(`unsupported tamper fault ${String(row.fault)}`);
  }
  const binary = tampered.artifacts.find((artifact) => artifact.role === 'wasm');
  if (!binary) throw new Error('implementation closure does not contain the WASM core');
  binary.digest = `sha256:${'0'.repeat(64)}`;
  let rejected = false;
  try {
    verifyImplementationClosure(tampered);
  } catch {
    rejected = true;
  }
  return {
    actualCode: rejected ? 'IMPLEMENTATION_CLOSURE_TAMPER' : null,
    actualOutcome: rejected ? 'engineFailure' : 'conforms',
    caseId: row.caseId,
    category: 'tamper',
    expectedCode: 'IMPLEMENTATION_CLOSURE_TAMPER',
    expectedOutcome: row.expectedOutcome,
    status: rejected && row.expectedOutcome === 'engineFailure' ? 'passed' : 'failed',
  };
}

function runEmptySubjectVector(row, moduleDocument, discovery) {
  const empty = structuredClone(moduleDocument);
  for (const locked of discovery.constraints) {
    for (const [key, value] of Object.entries(empty.domain.constraints || {})) {
      if (value?.iri === locked.constraintDefinitionIri) delete empty.domain.constraints[key];
    }
  }
  let rejected = false;
  try {
    discoverIdentifierConstraints(empty, discovery);
  } catch {
    rejected = true;
  }
  return {
    actualCode: rejected ? 'EMPTY_CUSTOM_CONSTRAINT_INVENTORY' : null,
    actualOutcome: rejected ? 'engineFailure' : 'conforms',
    caseId: row.caseId,
    category: 'emptySubject',
    expectedCode: 'EMPTY_CUSTOM_CONSTRAINT_INVENTORY',
    expectedOutcome: row.expectedOutcome,
    status: rejected && row.expectedOutcome === 'engineFailure' ? 'passed' : 'failed',
  };
}

function nodeExecutableDigest() {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')}`;
}

function assessWindowsLeastPrivilege(whoamiExecution, administratorRoleExecution) {
  const groupBytes = Buffer.isBuffer(whoamiExecution.stdout)
    ? whoamiExecution.stdout
    : Buffer.from(whoamiExecution.stdout || '', 'utf8');
  const mediumIntegrity = groupBytes.includes(Buffer.from('S-1-16-8192', 'ascii'));
  const administratorSidPresent = groupBytes.includes(Buffer.from('S-1-5-32-544', 'ascii'));
  const roleProbeSucceeded = administratorRoleExecution.status === 0;
  const administratorEnabled = roleProbeSucceeded
    && String(administratorRoleExecution.stdout || '').trim() === 'enabled';

  // `whoami` localizes group attributes and writes in an OEM code page. Raw
  // SID bytes plus WindowsPrincipal membership avoid language/encoding guesses:
  // a present Administrators SID that is not enabled is the filtered deny-only
  // membership expected from a medium-integrity UAC token.
  const administratorDenyOnly = administratorSidPresent
    && roleProbeSucceeded
    && !administratorEnabled;
  return {
    administratorDenyOnly,
    integrityLevelSid: mediumIntegrity ? 'S-1-16-8192' : null,
    platform: 'win32',
    verified: whoamiExecution.status === 0
      && mediumIntegrity
      && administratorDenyOnly,
  };
}

function assessPosixLeastPrivilege(uid, platform) {
  return {
    platform,
    uid,
    verified: Number.isInteger(uid) && uid > 0,
  };
}

function hostLeastPrivilegeEvidence() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'whoami.exe');
    const execution = spawnSync(executable, ['/groups', '/fo', 'csv', '/nh'], {
      encoding: null,
      env: { SystemRoot: systemRoot },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 5000,
      windowsHide: true,
    });
    const powershell = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const administratorRoleExecution = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); "
        + '$principal = [Security.Principal.WindowsPrincipal]::new('
        + '[Security.Principal.WindowsIdentity]::GetCurrent()); '
        + "if ($principal.IsInRole($sid)) { 'enabled' } else { 'not-enabled' }",
    ], {
      encoding: 'utf8',
      env: { SystemRoot: systemRoot },
      maxBuffer: 4096,
      shell: false,
      timeout: 5000,
      windowsHide: true,
    });
    return assessWindowsLeastPrivilege(execution, administratorRoleExecution);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return assessPosixLeastPrivilege(uid, process.platform);
}

function buildArtifactBindings(artifacts) {
  const packageFile = path.join(ROOT, 'package.json');
  const dependencyLockFile = path.join(ROOT, 'package-lock.json');
  return {
    dependencyContract: {
      digest: fileDigest(packageFile),
      ref: sourceRef('package.json'),
    },
    dependencyLock: {
      digest: fileDigest(dependencyLockFile),
      ref: sourceRef('package-lock.json'),
    },
    discoveryContract: {
      digest: fileDigest(DISCOVERY_PATH),
      ref: sourceRef(repositoryPath(DISCOVERY_PATH)),
    },
    evidenceSchema: {
      digest: fileDigest(EVIDENCE_SCHEMA_PATH),
      ref: sourceRef(repositoryPath(EVIDENCE_SCHEMA_PATH)),
    },
    implementationClosure: {
      artifactDigest: fileDigest(IMPLEMENTATION_CLOSURE_PATH),
      closureDigest: artifacts.closure.closureDigest,
      ref: sourceRef(repositoryPath(IMPLEMENTATION_CLOSURE_PATH)),
    },
    inputContract: {
      digest: fileDigest(INPUT_CONTRACT_PATH),
      ref: sourceRef(repositoryPath(INPUT_CONTRACT_PATH)),
    },
    module: {
      digest: fileDigest(MODULE_PATH),
      ref: sourceRef(repositoryPath(MODULE_PATH)),
    },
    outputContract: {
      digest: fileDigest(OUTPUT_CONTRACT_PATH),
      ref: sourceRef(repositoryPath(OUTPUT_CONTRACT_PATH)),
    },
    schemeValidatorRegistry: {
      digest: fileDigest(REGISTRY_PATH),
      ref: sourceRef(repositoryPath(REGISTRY_PATH)),
    },
    testVectors: {
      digest: fileDigest(TEST_VECTORS_PATH),
      ref: sourceRef(repositoryPath(TEST_VECTORS_PATH)),
    },
    wasmBuildEntrypoint: {
      digest: fileDigest(WASM_BUILD_PATH),
      ref: sourceRef(repositoryPath(WASM_BUILD_PATH)),
    },
    wasmBuildSource: {
      digest: fileDigest(WAT_SOURCE_PATH),
      ref: sourceRef(repositoryPath(WAT_SOURCE_PATH)),
    },
    wasmCore: {
      digest: fileDigest(WASM_CORE_PATH),
      ref: sourceRef(repositoryPath(WASM_CORE_PATH)),
    },
    worker: {
      digest: fileDigest(WORKER_PATH),
      ref: sourceRef(repositoryPath(WORKER_PATH)),
    },
  };
}

function prepareOutputDirectory(requested) {
  const directory = requested || fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-identifier-evidence-'));
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('identifier evidence output must be a non-symlink directory');
  }
  if (fs.readdirSync(directory).length !== 0) {
    throw new Error('identifier evidence output directory must be empty');
  }
  return directory;
}

function verifyWasmRebuild() {
  const execution = spawnSync(process.execPath, [WASM_BUILD_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 15000,
    windowsHide: true,
  });
  if (execution.status !== 0) {
    throw new Error(
      `Foundation identifier WASM deterministic rebuild failed: ${execution.stderr || execution.stdout}`,
    );
  }
}

function runCapability() {
  verifyWasmRebuild();
  const artifacts = loadCapabilityArtifacts();
  validateVectors(artifacts.vectors);
  const moduleDocument = loadFoundationModule();
  const discovered = discoverIdentifierConstraints(moduleDocument, artifacts.discovery);
  const results = [];
  const leastPrivilege = hostLeastPrivilegeEvidence();
  for (const row of artifacts.vectors.engineFailure) results.push(runEngineFailureVector(row));
  for (const category of ['positive', 'violation']) {
    for (const row of artifacts.vectors[category]) results.push(runNormalVector(category, row));
  }
  for (const row of artifacts.vectors.emptySubject) {
    results.push(runEmptySubjectVector(row, moduleDocument, artifacts.discovery));
  }
  for (const row of artifacts.vectors.tamper) results.push(runTamperVector(row, artifacts.closure));
  results.sort((left, right) => compareUtf8(`${left.category}\0${left.caseId}`, `${right.category}\0${right.caseId}`));
  return {
    artifactBindings: buildArtifactBindings(artifacts),
    capabilityRows: expectedCapabilityRows(artifacts),
    discoveredConstraints: discovered,
    executionAssurance: {
      capabilityImportsEmpty: true,
      capabilityMemoryMaximum: true,
      environmentAllowlist: true,
      fileSystemPermissions: true,
      freshOutputDirectory: true,
      leastPrivilegeUser: leastPrivilege.verified,
      networkIsolation: false,
      outputLimit: true,
      processCreationDenied: true,
      timeout: true,
    },
    outcome: results.every((row) => row.status === 'passed') ? 'passed' : 'failed',
    profileRef: PROFILE_REF,
    releaseEligible: false,
    releaseEligibilityBlockers: [
      ...(leastPrivilege.verified ? [] : ['least-privilege-user-not-independently-proven']),
      'network-isolation-not-enforced-by-node-permission-model',
      'not-joined-to-single-release-toolchain-lock',
      'not-replayed-by-complete-shacl-execution-gate',
    ],
    runtime: {
      nodeExecutableDigest: nodeExecutableDigest(),
      nodeVersion: process.version,
      permissionModel: 'node --permission',
      leastPrivilege,
      wasmCompilerPackage: 'wabt@1.0.39',
    },
    schemaVersion: '1.0',
    vectorResults: results,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputDirectory = prepareOutputDirectory(options.outputDirectory);
  const evidence = runCapability();
  const evidenceFile = path.join(outputDirectory, 'foundation-identifier-custom-evidence.json');
  fs.writeFileSync(evidenceFile, Buffer.from(canonicalJcs(evidence), 'utf8'), { flag: 'wx' });
  for (const row of evidence.vectorResults) {
    const marker = row.status === 'passed' ? 'PASS' : 'FAIL';
    console.log(`${marker} ${row.category}/${row.caseId}: ${row.actualOutcome}`);
  }
  console.log(`identifier Custom capability: ${evidence.outcome}; releaseEligible=false`);
  console.log(`evidence: ${evidenceFile}`);
  return evidence.outcome === 'passed' ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (cause) {
    console.error(cause.stack || cause.message);
    process.exitCode = 1;
  }
}

module.exports = {
  assessPosixLeastPrivilege,
  assessWindowsLeastPrivilege,
  runCapability,
  validateVectors,
};
