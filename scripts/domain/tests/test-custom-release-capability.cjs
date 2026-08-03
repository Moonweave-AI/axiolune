#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  CATEGORIES,
  GROUPS,
  buildCustomReleaseArtifacts,
  loadGroupCapabilities,
  ontologyCustomDefinitions,
  ordersPortfolioExecution,
  readJcs,
  readRuntimeJcs,
  runtimeJcs,
} = require('../lib/custom-release-capability.cjs');
const {
  customReleaseExitCode,
  summarizeCaseRows,
  verifyCustomReleaseCapabilities,
} = require('../lib/custom-release-capability-executor.cjs');

function expectReject(value, pattern) {
  assert.throws(() => runtimeJcs(value), pattern);
}

async function main() {
  assert.equal(runtimeJcs(1), '1');
  assert.equal(runtimeJcs(1.0), '1');
  assert.equal(runtimeJcs(1e-7), '1e-7');
  assert.equal(runtimeJcs(1e21), '1e+21');
  assert.equal(runtimeJcs(-0), '0');
  assert.equal(runtimeJcs(Number.MAX_VALUE), JSON.stringify(Number.MAX_VALUE));
  assert.equal(runtimeJcs(Number.MIN_VALUE), JSON.stringify(Number.MIN_VALUE));
  assert.equal(runtimeJcs(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.equal(runtimeJcs(Number.MIN_SAFE_INTEGER), String(Number.MIN_SAFE_INTEGER));
  expectReject(Number.NaN, /not finite/u);
  expectReject(Number.POSITIVE_INFINITY, /not finite/u);
  expectReject(Number.NEGATIVE_INFINITY, /not finite/u);
  expectReject('\ud800', /unpaired surrogate/u);
  expectReject('\udfff', /unpaired surrogate/u);
  expectReject(new Date(0), /not a JSON value/u);

  const sparse = [];
  sparse[1] = 1;
  expectReject(sparse, /sparse or has non-index properties/u);
  const extended = [1];
  extended.extra = true;
  expectReject(extended, /sparse or has non-index properties/u);

  const composed = '\u00e9';
  const decomposed = 'e\u0301';
  assert.notEqual(runtimeJcs(composed), runtimeJcs(decomposed), 'runtime JCS must not normalize Unicode');
  assert.equal(runtimeJcs({ '\ue000': 1, '\ud800\udc00': 2 }), '{"\ud800\udc00":2,"\ue000":1}');

  const tamperedBytes = Buffer.from(' {"a":1}', 'utf8');
  const canonicalBytes = Buffer.from(runtimeJcs(JSON.parse(tamperedBytes.toString('utf8'))), 'utf8');
  assert.equal(tamperedBytes.equals(canonicalBytes), false, 'whitespace byte tamper must be observable');

  const seenCategories = new Set();
  const modeledRows = [];
  const pendingCategories = new Set();
  let definitionCount = 0;
  const componentIris = [];
  for (const group of GROUPS) {
    const capabilities = loadGroupCapabilities(group);
    definitionCount += capabilities.length;
    for (const capability of capabilities) {
      const constraintIri = group.groupId === 'identifier'
        ? capability.row.constraintDefinitionIri
        : capability.row.constraintIri;
      componentIris.push(constraintIri);
      assert.deepEqual(Object.keys(capability.expectations).sort(), [...CATEGORIES].sort());
    for (const category of CATEGORIES) {
      seenCategories.add(category);
        const expected = capability.expectations[category];
        assert.doesNotThrow(() => runtimeJcs(capability.requests[category]));
        assert.deepEqual(
          Object.keys(expected).sort(),
          ['caseStatus', 'code', 'outcome', 'semanticOwner', 'status'].sort(),
        );
        if (expected.caseStatus === 'pending') {
          pendingCategories.add(category);
          assert.equal(expected.status, 'completed');
          assert.equal(expected.outcome, 'violation');
          assert.equal(typeof expected.code, 'string');
          assert.equal(group.groupId, 'orders-portfolio');
          assert.equal(capability.vector.execution.status, 'pending');
          assert.equal(expected.code, capability.vector.execution.pendingCode);
        } else {
          assert.equal(expected.caseStatus, 'passed');
        }
        modeledRows.push({
          caseStatus: expected.caseStatus,
          code: expected.code,
          constraintIri,
          outcome: expected.outcome,
          pendingRequirement: expected.caseStatus === 'pending'
            ? capability.vector.execution.pendingRequirement
            : null,
          status: expected.status,
        });
      }
    }
  }
  const authoritativeIris = ontologyCustomDefinitions().map((row) => row.constraintIri);
  assert.deepEqual([...componentIris].sort(), authoritativeIris);
  assert.equal(definitionCount, authoritativeIris.length);
  assert.ok(authoritativeIris.includes(
    'https://axiolune.ai/ontology/finance/orders-execution/OrderIntentLineageContract',
  ));
  assert.deepEqual([...seenCategories].sort(), [...CATEGORIES].sort());
  assert.deepEqual([...pendingCategories].sort(), []);

  const summary = summarizeCaseRows(modeledRows);
  const expectedCaseCount = definitionCount * CATEGORIES.length;
  assert.equal(modeledRows.length, expectedCaseCount);
  assert.equal(summary.componentEligible, true);
  assert.equal(summary.outcome, 'passed');
  assert.equal(summary.passedCaseCount, expectedCaseCount);
  assert.equal(summary.pendingCaseCount, 0);
  assert.equal(summary.pending.caseCount, 0);
  assert.equal(summary.pending.constraintIris.length, 0);
  assert.equal(summary.pending.codes.length, 0);
  assert.equal(summary.pending.requirements.length, 0);
  assert.equal(customReleaseExitCode(summary), 0);
  assert.equal(customReleaseExitCode({
    componentEligible: true,
    outcome: 'passed',
    pendingCaseCount: 0,
  }), 0);
  assert.throws(
    () => customReleaseExitCode({
      componentEligible: true,
      outcome: 'passed',
      pendingCaseCount: 1,
    }),
    /inconsistent eligibility/u,
  );
  assert.throws(
    () => summarizeCaseRows([{
      caseStatus: 'pending',
      code: null,
      constraintIri: 'urn:test',
      outcome: 'accepted',
      pendingRequirement: null,
      status: 'completed',
    }]),
    /lacks an exact fail-closed result/u,
  );

  const ordersGroup = GROUPS.find((group) => group.groupId === 'orders-portfolio');
  const ordersVectors = readRuntimeJcs(ordersGroup.vectorsPath).value.vectors;
  const ordersDiscovery = readJcs(ordersGroup.discoveryPath).value.constraints;
  const discoveryByIri = new Map(ordersDiscovery.map((row) => [row.constraintIri, row]));
  const pendingVectors = ordersVectors.filter((vector) => (
    ordersPortfolioExecution(vector, discoveryByIri.get(vector.constraintIri)).status === 'pending'
  ));
  assert.equal(pendingVectors.length, 0);
  assert.ok(ordersVectors.every((vector) => vector.execution.status === 'executable'));
  const forgedPending = structuredClone(ordersVectors[0]);
  forgedPending.execution = {
    eligible: false,
    pendingCode: 'FORGED_PENDING',
    pendingRequirement: 'caller-authored pending lifecycle',
    status: 'pending',
  };
  assert.throws(
    () => ordersPortfolioExecution(
      forgedPending,
      discoveryByIri.get(forgedPending.constraintIri),
    ),
    /execution lifecycle drift/u,
  );

  const generated = await buildCustomReleaseArtifacts();
  assert.equal(generated.definitionCount, authoritativeIris.length);
  assert.deepEqual(generated.definitionIris, authoritativeIris);
  assert.ok(generated.contextCount >= generated.definitionCount);

  const verified = await verifyCustomReleaseCapabilities();
  assert.equal(verified.evidence.definitionCount, generated.definitionCount);
  assert.equal(verified.evidence.contextCount, generated.contextCount);
  assert.equal(verified.evidence.caseCount, expectedCaseCount);
  assert.equal(verified.evidence.passedCaseCount, expectedCaseCount);
  assert.equal(verified.evidence.pendingCaseCount, 0);
  assert.equal(verified.evidence.outcome, 'passed');
  process.stdout.write(
    'custom release capability status-model tests: passed; '
      + `release inventory: closed at ${generated.definitionCount} definitions/`
      + `${generated.contextCount} contexts/${expectedCaseCount} cases; `
      + `all ${expectedCaseCount} cases executable and passed)\n`,
  );
}

main().catch((cause) => {
  process.stderr.write(`${cause.stack || cause.message}\n`);
  process.exitCode = 1;
});
