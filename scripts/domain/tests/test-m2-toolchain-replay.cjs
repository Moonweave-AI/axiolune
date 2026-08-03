'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const { verifyToolchainReplay } = require('../lib/m2-toolchain-replay.cjs');

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function ref(filePath) {
  return { kind: 'path', root: 'sourceTree', path: filePath };
}

function fixture() {
  const source = new Map();
  function artifact(filePath, text = filePath) {
    const bytes = Buffer.from(text, 'utf8');
    source.set(filePath, bytes);
    return { ref: ref(filePath), digest: digest(bytes) };
  }
  const toolArtifact = artifact('tools/runner.bin');
  const runtime = artifact('tools/runtime.bin');
  function capability(capabilityId) {
    const fields = {};
    for (const prefix of [
      'capability', 'entrypoint', 'inputContract', 'outputContract',
      'discoveryContract', 'evidenceSchema', 'testVectors',
    ]) {
      const value = artifact(`tools/${capabilityId}/${prefix}.json`);
      fields[`${prefix}Ref`] = value.ref;
      fields[`${prefix}Digest`] = value.digest;
    }
    return { capabilityId, ...fields };
  }
  const gateCapability = capability('gate-capability');
  const checkCapability = capability('verifier-capability');
  const lock = {
    schemaVersion: '1.0',
    tools: [{
      toolId: 'm2-tool',
      version: '1.0.0',
      artifactRef: toolArtifact.ref,
      artifactDigest: toolArtifact.digest,
      runtimeRef: runtime.ref,
      runtimeDigest: runtime.digest,
      capabilities: [gateCapability, checkCapability],
    }],
  };
  const lockBytes = Buffer.from(canonicalJcs(lock), 'utf8');
  source.set('toolchain.lock.json', lockBytes);
  function tuple(value) {
    return {
      toolId: 'm2-tool',
      capabilityId: value.capabilityId,
      capabilityRef: value.capabilityRef,
      capabilityDigest: value.capabilityDigest,
      entrypointRef: value.entrypointRef,
      entrypointDigest: value.entrypointDigest,
      discoveryContractRef: value.discoveryContractRef,
      discoveryContractDigest: value.discoveryContractDigest,
      evidenceSchemaRef: value.evidenceSchemaRef,
      evidenceSchemaDigest: value.evidenceSchemaDigest,
    };
  }
  const build = {
    toolLockRef: ref('toolchain.lock.json'),
    toolLockDigest: digest(lockBytes),
  };
  return {
    lock,
    source,
    options: {
      enforceCustomConstraintClosure: false,
      enforceConstraintInstanceClosure: false,
      enforceReleaseCapabilityClosure: false,
      gitReplay: {
        p1: {
          files: [...source].map(([filePath, content]) => ({ path: filePath, content })),
        },
      },
      requiredGates: { gates: [{ gateId: 'test-gate', ...tuple(gateCapability) }] },
      releaseChecks: {
        stages: [{
          stageId: 'test-stage',
          checks: [{ checkId: 'test-check', ...tuple(checkCapability) }],
        }],
      },
      p0: { build },
      p1: { build: structuredClone(build) },
    },
  };
}

test('joins every gate/check tuple to byte-verified P1 toolchain capability rows', () => {
  const value = fixture();
  const result = verifyToolchainReplay(value.options);
  assert.equal(result.capabilityCount, 2);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.issues, []);
  assert.equal(result.capabilityExecutionCount, 0);
});

test('substituted gate tuple cannot borrow another locked capability', () => {
  const value = fixture();
  value.options.requiredGates.gates[0].entrypointDigest = `sha256:${'f'.repeat(64)}`;
  const result = verifyToolchainReplay(value.options);
  assert.ok(result.issues.some((issue) => issue.code === 'M2_TOOLCHAIN_TUPLE_JOIN'));
});

test('changed Git blob bytes invalidate the lock-declared artifact digest', () => {
  const value = fixture();
  const file = value.options.gitReplay.p1.files.find(
    (row) => row.path === 'tools/gate-capability/evidenceSchema.json',
  );
  file.content = Buffer.from('tampered evidence schema', 'utf8');
  const result = verifyToolchainReplay(value.options);
  assert.ok(result.issues.some((issue) => issue.code === 'M2_TOOLCHAIN_ARTIFACT_DIGEST'));
});

test('P0/P1 lock substitution is rejected before tuple evaluation', () => {
  const value = fixture();
  value.options.p1.build.toolLockDigest = `sha256:${'0'.repeat(64)}`;
  const result = verifyToolchainReplay(value.options);
  assert.ok(result.issues.some(
    (issue) => issue.code === 'M2_RELEASE_TOOLCHAIN_P0_P1_BINDING',
  ));
});
