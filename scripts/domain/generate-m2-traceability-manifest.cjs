#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  outputs: materializedIdentityOutputs,
} = require('./generate-materialized-identity-closure.cjs');
const {
  compile: compileTermCardManifest,
} = require('./generate-term-card-manifest.cjs');
const {
  MANIFEST_PATH: CONSTRAINT_MANIFEST_PATH,
  buildConstraintInstanceManifest,
} = require('./lib/m2-constraint-instance-builder.cjs');
const {
  CQ_SOURCE_INVENTORY_REF,
  artifactDigest,
  compileCqSourceInventory,
  sourcePath,
} = require('./lib/m2-cq-source-inventory.cjs');
const {
  CQ_TRACEABILITY_BINDINGS_REF,
  compileCqTraceabilityBindings,
} = require('./lib/m2-cq-traceability-bindings.cjs');
const {
  GLOBAL_COMPILATION_REF,
  GLOBAL_MANIFEST_REF,
  GLOBAL_REGISTRY_REF,
  compileMaterializedIdentityClosure,
} = require('./lib/m2-materialized-identity-closure.cjs');
const {
  IDENTITY_SOURCE_BINDINGS_REF,
  compileIdentitySourceBindings,
} = require('./lib/m2-identity-source-bindings.cjs');
const {
  validateReferenceClosure,
} = require('./lib/reference-closure.cjs');
const {
  GATE_EXPECTATIONS_REF,
  buildTraceabilityManifest,
  fileArtifactDigest,
} = require('./lib/m2-traceability-builder.cjs');
const {
  validateTraceabilityManifest,
} = require('./lib/m2-traceability-contract.cjs');
const {
  canonicalJcs,
  validateArtifactRef,
} = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_SYMBOL_PATH = 'docs/domain/infrastructure/public-symbol-manifest.json';
const TERM_CARD_PATH = 'docs/domain/infrastructure/term-card-manifest.json';
const REFERENCE_CLOSURE_PATH = 'docs/ontology/references/reference-closure-manifest.json';
const TRACEABILITY_PATH = 'docs/ontology/references/traceability-manifest.json';
const IDENTITY_BINDINGS_PATH = IDENTITY_SOURCE_BINDINGS_REF.path;
const CQ_BINDINGS_PATH = CQ_TRACEABILITY_BINDINGS_REF.path;

function ref(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function readRegularSourceBytes(relativePath) {
  const absolute = sourcePath(ROOT, relativePath);
  if (!fs.existsSync(absolute)) throw new Error(`missing ${relativePath}`);
  let cursor = path.resolve(ROOT);
  for (const segment of relativePath.split('/')) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${relativePath} contains a symbolic-link path component`);
    }
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular non-symlink file`);
  }
  const realRoot = fs.realpathSync(ROOT);
  const realFile = fs.realpathSync(absolute);
  const relativeReal = path.relative(realRoot, realFile);
  if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeReal)) {
    throw new Error(`${relativePath} resolves outside the source tree`);
  }
  return fs.readFileSync(realFile);
}

function readExactJcs(relativePath) {
  const bytes = readRegularSourceBytes(relativePath);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${relativePath} is not strict UTF-8 JSON: ${error.message}`);
  }
  const expected = Buffer.from(canonicalJcs(value), 'utf8');
  if (!bytes.equals(expected)) throw new Error(`${relativePath} is not exact UTF-8 JCS bytes`);
  return { ref: ref(relativePath), bytes, value, digest: artifactDigest(bytes) };
}

function assertStoredBytes(relativePath, expected) {
  const actual = readRegularSourceBytes(relativePath);
  if (!actual.equals(expected)) throw new Error(`${relativePath} is byte-drifted from its compiler`);
}

function resolveArtifact(artifactRef) {
  const validation = validateArtifactRef(artifactRef, 'trace artifactRef');
  if (!validation.ok || artifactRef.kind !== 'path' || artifactRef.root !== 'sourceTree') {
    throw new Error(`trace build can resolve only a valid sourceTree path ArtifactRef: ${validation.errors.join('; ')}`);
  }
  return { bytes: readRegularSourceBytes(artifactRef.path) };
}

function errorSummary(error) {
  if (Array.isArray(error?.errors)) {
    const counts = new Map();
    for (const row of error.errors) counts.set(row.code, (counts.get(row.code) || 0) + 1);
    return [...counts.entries()].sort().map(([code, count]) => `${code}=${count}`).join(', ');
  }
  return error?.message || String(error);
}

async function collectInputs(options = {}) {
  const blockers = [];
  const input = {};
  function capture(code, action) {
    try {
      return action();
    } catch (error) {
      blockers.push({ code, message: errorSummary(error) });
      return null;
    }
  }

  if (!options.skipReferenceClosureReplay) {
    capture('TRACE_REFERENCE_CLOSURE_REPLAY', () => {
      const result = validateReferenceClosure({ rootDir: ROOT });
      if (!result.ok) {
        const error = new Error(`reference closure replay found ${result.errors.length} issue(s)`);
        error.errors = result.errors;
        throw error;
      }
      return result;
    });
  }

  const publicSymbols = capture('TRACE_PUBLIC_SYMBOL_INPUT', () => readExactJcs(PUBLIC_SYMBOL_PATH));
  if (publicSymbols) input.publicSymbols = publicSymbols.value;

  const referenceClosure = capture('TRACE_REFERENCE_CLOSURE_INPUT', () => readExactJcs(REFERENCE_CLOSURE_PATH));
  if (referenceClosure) input.referenceClosure = referenceClosure.value;

  const termCompilation = capture('TRACE_TERM_CARD_ACCEPTANCE', () => {
    const compiled = compileTermCardManifest();
    const expected = Buffer.from(canonicalJcs(compiled.manifest), 'utf8');
    assertStoredBytes(TERM_CARD_PATH, expected);
    return compiled;
  });
  if (termCompilation) input.termCards = termCompilation.manifest;

  const identity = capture('TRACE_GLOBAL_IDENTITY_CLOSURE', () => {
    const compiled = compileMaterializedIdentityClosure(ROOT);
    for (const [artifactRef, bytes] of materializedIdentityOutputs(compiled)) {
      assertStoredBytes(artifactRef.path, bytes);
    }
    return compiled;
  });
  if (identity) {
    input.identity = {
      compilation: identity.compilation,
      manifest: identity.manifest,
      manifestRef: GLOBAL_MANIFEST_REF,
      manifestDigest: identity.manifestDigest,
      registry: identity.registry,
      registryRef: GLOBAL_REGISTRY_REF,
      registryDigest: identity.registryDigest,
      compilationRef: GLOBAL_COMPILATION_REF,
    };
  }

  const identityBindings = capture('TRACE_IDENTITY_SOURCE_BINDINGS', () => {
    if (!input.identity || !referenceClosure) {
      throw new Error('identity and reference closures must compile before source bindings');
    }
    const compiled = compileIdentitySourceBindings(ROOT, {
      identity: input.identity,
      referenceClosure: referenceClosure.value,
    });
    assertStoredBytes(IDENTITY_BINDINGS_PATH, compiled.bytes);
    return compiled;
  });
  if (identityBindings) input.identitySourceBindings = identityBindings.bindings;

  let constraint;
  try {
    constraint = await buildConstraintInstanceManifest({ sourceRoot: ROOT });
    if (constraint.outcome !== 'built' || !constraint.manifest || !Buffer.isBuffer(constraint.bytes)) {
      const issues = (constraint.issues || []).slice(0, 8)
        .map((issue) => `${issue.code}:${issue.path}`).join(', ');
      throw new Error(`constraint compiler outcome=${constraint.outcome}${issues ? ` (${issues})` : ''}`);
    }
    assertStoredBytes(CONSTRAINT_MANIFEST_PATH, constraint.bytes);
    input.constraintArtifact = {
      ref: ref(CONSTRAINT_MANIFEST_PATH),
      digest: fileArtifactDigest(constraint.bytes),
      value: constraint.manifest,
      bytes: constraint.bytes,
    };
  } catch (error) {
    blockers.push({ code: 'TRACE_CONSTRAINT_INSTANCE_CLOSURE', message: errorSummary(error) });
  }

  const cqInventory = capture('TRACE_CQ_SOURCE_INVENTORY', () => {
    const compiled = compileCqSourceInventory(ROOT);
    assertStoredBytes(CQ_SOURCE_INVENTORY_REF.path, compiled.bytes);
    return compiled;
  });
  if (cqInventory) {
    input.cqInventoryArtifact = {
      ref: CQ_SOURCE_INVENTORY_REF,
      digest: artifactDigest(cqInventory.bytes),
      value: cqInventory.inventory,
    };
  }

  const cqBindings = capture('TRACE_CQ_BINDINGS', () => {
    const compiled = compileCqTraceabilityBindings(ROOT);
    assertStoredBytes(CQ_BINDINGS_PATH, compiled.bytes);
    return compiled;
  });
  if (cqBindings) input.cqBindings = cqBindings.bindings;
  input.resolveArtifact = resolveArtifact;

  return { input, blockers };
}

function auditStoredTraceability(blockers) {
  try {
    const artifact = readExactJcs(TRACEABILITY_PATH);
    const validation = validateTraceabilityManifest(artifact.value);
    if (!validation.ok) {
      const counts = new Map();
      for (const issue of validation.errors) {
        counts.set(issue.code, (counts.get(issue.code) || 0) + 1);
      }
      blockers.push({
        code: 'TRACE_CANONICAL_MANIFEST_INVALID',
        message: [...counts.entries()].sort().map(([code, count]) => `${code}=${count}`).join(', '),
      });
    }
  } catch (error) {
    blockers.push({ code: 'TRACE_CANONICAL_MANIFEST_MISSING_OR_NON_JCS', message: errorSummary(error) });
  }
}

async function run(argv = process.argv.slice(2)) {
  const modes = ['--audit', '--write', '--check'].filter((mode) => argv.includes(mode));
  const writePendingReferenceClosure = argv.includes('--write-pending-reference-closure');
  if (modes.length !== 1
      || argv.some((argument) => ![
        '--audit', '--write', '--check', '--write-pending-reference-closure',
      ].includes(argument))) {
    throw new Error(
      'usage: node scripts/domain/generate-m2-traceability-manifest.cjs '
      + '(--audit|--write|--check) [--write-pending-reference-closure]',
    );
  }
  if (writePendingReferenceClosure && modes[0] !== '--write') {
    throw new Error('--write-pending-reference-closure is valid only with --write');
  }
  const mode = modes[0];
  const collected = await collectInputs({
    skipReferenceClosureReplay: writePendingReferenceClosure,
  });
  if (mode === '--audit') auditStoredTraceability(collected.blockers);
  if (collected.blockers.length > 0) {
    const error = new Error(
      `strict M2 traceability is blocked by ${collected.blockers.length} condition(s):\n`
      + collected.blockers.map((row) => `  - ${row.code}: ${row.message}`).join('\n'),
    );
    error.blockers = collected.blockers;
    throw error;
  }

  const result = buildTraceabilityManifest(collected.input);
  const outputs = [
    [TRACEABILITY_PATH, Buffer.from(canonicalJcs(result.manifest), 'utf8')],
    [GATE_EXPECTATIONS_REF.path, Buffer.from(canonicalJcs(result.gateExpectations), 'utf8')],
  ];
  for (const [relativePath, expected] of outputs) {
    const absolute = sourcePath(ROOT, relativePath);
    if (mode === '--write') {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, expected);
    } else {
      assertStoredBytes(relativePath, expected);
    }
  }
  return {
    mode: mode === '--write' ? 'write' : mode === '--audit' ? 'audit' : 'check',
    outcome: 'passed',
    ...result.stats,
    manifestDigest: result.manifestDigest,
  };
}

if (require.main === module) {
  run().then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(`FAIL strict M2 traceability: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  CQ_BINDINGS_PATH,
  IDENTITY_BINDINGS_PATH,
  TRACEABILITY_PATH,
  collectInputs,
  readExactJcs,
  resolveArtifact,
  run,
};
