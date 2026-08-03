'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CATEGORIES,
  EXPECTED_NODE_VERSION,
  GROUPS,
  PROFILE_REF,
  REGISTRY_PATH,
  ROOT,
  RUNTIME_LOCK_PATH,
  absolute,
  buildCustomReleaseArtifacts,
  byteCompare,
  componentImplementationDigest,
  ordersPortfolioExecution,
  readBytes,
  runtimeJcs,
  sha256,
} = require('./custom-release-capability.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const { executeSandboxed } = require('./foundation-identifier-capability.cjs');
const { executeRequest: executeFoundationMarketStrategy } = require('../run-foundation-market-strategy-custom-runtime.cjs');
const {
  executeRequest: executeOrdersPortfolio,
  executeRequestWithReconciliationEvidence,
} = require('../run-orders-portfolio-custom-runtime.cjs');
const { executeRequest: executePostTrade } = require('../run-post-trade-custom-runtime.cjs');
const { executeRequest: executeRisk } = require('../run-risk-custom-runtime.cjs');

const ASSURANCE_FIELDS = Object.freeze([
  'childProcessDenied', 'fileWriteDenied', 'networkDenied', 'permissionModelEnabled',
  'unrelatedFileReadDenied', 'workerCreationDenied',
]);
const GROUP_EXECUTORS = Object.freeze({
  'foundation-market-strategy': executeFoundationMarketStrategy,
  'orders-portfolio': executeOrdersPortfolio,
  'post-trade': executePostTrade,
  risk: executeRisk,
});

function exactKeys(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(byteCompare);
  const expected = [...required].sort(byteCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} is not closed: actual=[${actual}] expected=[${expected}]`);
  }
}

function sameArtifact(left, right, label) {
  if (!left || !right || left.digest !== right.digest
      || canonicalJcs(left.ref) !== canonicalJcs(right.ref)) {
    throw new Error(`${label} artifact tuple mismatch`);
  }
}

function strictJcsBytes(bytes, label, runtime = false) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`${label} is not JSON: ${cause.message}`);
  }
  const canonical = Buffer.from(runtime ? runtimeJcs(value) : canonicalJcs(value), 'utf8');
  if (!bytes.equals(canonical)) throw new Error(`${label} is not exact canonical JCS bytes`);
  return value;
}

function readBound(ref, digest, label, runtime = false) {
  exactKeys(ref, ['kind', 'root', 'path'], `${label} ref`);
  if (ref.kind !== 'path' || ref.root !== 'sourceTree') throw new Error(`${label} must use sourceTree path ref`);
  const bytes = readBytes(ref.path);
  if (sha256(bytes) !== digest) throw new Error(`${label} digest mismatch`);
  return { bytes, value: strictJcsBytes(bytes, label, runtime) };
}

function requireDirectEntrypoint(group, ref, digest, label) {
  if (ref?.kind !== 'path' || ref?.root !== 'sourceTree' || ref?.path !== group.entrypointPath) {
    throw new Error(`${label} does not directly bind ${group.entrypointPath}`);
  }
  if (sha256(readBytes(group.entrypointPath)) !== digest) throw new Error(`${label} entrypoint digest mismatch`);
}

function discoveryConstraintIri(group, row) {
  return group.groupId === 'identifier' ? row.constraintDefinitionIri : row.constraintIri;
}

function assurancePassed(value) {
  return value && ASSURANCE_FIELDS.every((field) => value[field] === true);
}

function identifierResult(input) {
  const execution = executeSandboxed(input, { timeoutMs: 2500 });
  const output = execution.output;
  const status = output.outcome === 'engineFailure' ? 'engineFailure' : 'completed';
  const outcome = output.outcome === 'conforms' ? 'accepted' : output.outcome;
  const code = output.outcome === 'violation'
    ? output.violations[0]?.code || null
    : output.outcome === 'engineFailure' ? output.errors[0]?.code || null : null;
  return {
    status,
    outcome,
    code,
    output,
    stderr: String(execution.stderr || ''),
  };
}

function stdinResult(group, input, category) {
  const useReconciliationEvidence = group.groupId === 'orders-portfolio'
    && category === 'positive'
    && input.validatorId
      === 'PortfolioPositionReconciliationFindingContract';
  const execution = useReconciliationEvidence
    ? executeRequestWithReconciliationEvidence(input, 'baseline')
    : GROUP_EXECUTORS[group.groupId](input, {
      timeoutMs: category === 'engineFailure' ? 250 : 2500,
    });
  if (execution.status !== 'completed') {
    return {
      status: 'engineFailure',
      outcome: 'engineFailure',
      code: execution.code || 'ENGINE_FAILURE',
      output: null,
      stderr: String(execution.detail || ''),
    };
  }
  const output = execution.response;
  let outcome = output.outcome;
  if (outcome === 'rejected') outcome = 'violation';
  let code = null;
  if (group.groupId === 'foundation-market-strategy') {
    code = outcome === 'violation' ? output.observedViolationCodes[0] || null : null;
  } else {
    code = outcome === 'violation' ? output.violation : null;
  }
  return { status: 'completed', outcome, code, output, stderr: '' };
}

function verifyOutputIdentity(group, descriptor, category, actual, expected) {
  const semantic = descriptor.semanticOwner;
  if (actual.output === null) return;
  const output = actual.output;
  if (group.groupId === 'identifier') {
    if (!['tamper', 'emptySubject'].includes(category)
        && output.constraintDefinitionIri !== descriptor.constraintIri) {
      throw new Error(`${descriptor.constraintIri}/${category} identifier ownership mismatch`);
    }
    return;
  }
  if (output.constraintIri !== descriptor.constraintIri) {
    throw new Error(`${descriptor.constraintIri}/${category} output constraint identity mismatch`);
  }
  if (output.dispatchDigest !== semantic.dispatchDigest) {
    throw new Error(`${descriptor.constraintIri}/${category} dispatch digest mismatch`);
  }
  if (group.groupId === 'risk') {
    if (output.evaluatorId !== semantic.evaluatorId) throw new Error(`${descriptor.constraintIri}/${category} evaluator mismatch`);
  } else if (output.validatorId !== semantic.validatorId) {
    throw new Error(`${descriptor.constraintIri}/${category} validator mismatch`);
  }
  if (group.groupId === 'post-trade' && output.evaluatorId !== semantic.evaluatorId) {
    throw new Error(`${descriptor.constraintIri}/${category} post-trade evaluator mismatch`);
  }
  if (category === 'positive' && !assurancePassed(output.assurance)) {
    throw new Error(`${descriptor.constraintIri} sandbox self-assurance is incomplete`);
  }
  if (category === 'violation' && group.groupId === 'foundation-market-strategy') {
    if (output.observedViolationOwner !== expected.semanticOwner
        || output.observedViolationCodes.length === 0
        || output.observedViolationCodes.some((code) => code !== expected.code)) {
      throw new Error(`${descriptor.constraintIri} violation owner/code is not exact`);
    }
  }
  if (category === 'violation' && group.groupId === 'post-trade'
      && output.observedViolationOwner !== null) {
    throw new Error(`${descriptor.constraintIri} direct post-trade dispatch unexpectedly attributed a peer owner`);
  }
}

function evidenceRow(testCase, descriptor, actual) {
  const outputBytes = actual.output === null ? null : Buffer.from(canonicalJcs(actual.output), 'utf8');
  const stderrBytes = Buffer.from(actual.stderr, 'utf8');
  return {
    caseId: testCase.caseId,
    caseStatus: testCase.expected.caseStatus,
    category: testCase.category,
    constraintIri: descriptor.constraintIri,
    inputDigest: testCase.inputDigest,
    status: actual.status,
    outcome: actual.outcome,
    code: actual.code,
    pendingRequirement: testCase.expected.caseStatus === 'pending'
      ? descriptor.semanticOwner.execution.pendingRequirement
      : null,
    semanticOwner: descriptor.constraintIri,
    output: actual.output,
    outputDigest: outputBytes === null ? null : sha256(outputBytes),
    stderrDigest: sha256(stderrBytes),
  };
}

function summarizeCaseRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Custom evidence rows must be an array');
  for (const row of rows) {
    if (!row || !['passed', 'pending'].includes(row.caseStatus)) {
      throw new Error('Custom evidence row has an unknown caseStatus');
    }
    if (row.caseStatus === 'pending') {
      if (row.status !== 'completed' || row.outcome !== 'violation'
          || typeof row.code !== 'string' || row.code.length === 0
          || typeof row.pendingRequirement !== 'string'
          || row.pendingRequirement.length === 0) {
        throw new Error('pending Custom evidence row lacks an exact fail-closed result');
      }
    } else if (row.pendingRequirement !== null) {
      throw new Error('passed Custom evidence row carries a pending requirement');
    }
  }
  const pendingRows = rows.filter((row) => row.caseStatus === 'pending');
  const passedCaseCount = rows.length - pendingRows.length;
  const pending = {
    caseCount: pendingRows.length,
    codes: [...new Set(pendingRows.map((row) => row.code))].sort(byteCompare),
    constraintIris: [...new Set(pendingRows.map((row) => row.constraintIri))]
      .sort(byteCompare),
    requirements: [...new Set(pendingRows.map((row) => row.pendingRequirement))]
      .sort(byteCompare),
  };
  const componentEligible = pendingRows.length === 0;
  return Object.freeze({
    componentEligible,
    outcome: componentEligible ? 'passed' : 'pending',
    passedCaseCount,
    pending,
    pendingCaseCount: pendingRows.length,
  });
}

function verifyRegistryEntry(entry, state) {
  const group = GROUPS.find((candidate) => candidate.toolId === entry.toolId);
  if (!group) throw new Error(`${entry.constraintIri} uses unknown tool ${entry.toolId}`);
  if (entry.toolVersion !== '0.3.0') throw new Error(`${entry.constraintIri} tool version is not 0.3.0`);
  requireDirectEntrypoint(group, entry.entrypointRef, entry.entrypointDigest, entry.constraintIri);
  sameArtifact(
    { ref: entry.runtimeRef, digest: entry.runtimeDigest },
    state.runtimeArtifact,
    `${entry.constraintIri} runtime`,
  );
  sameArtifact(
    { ref: entry.toolArtifactRef, digest: entry.toolArtifactDigest },
    state.toolArtifacts.get(group.groupId),
    `${entry.constraintIri} tool`,
  );

  const capability = readBound(entry.capabilityRef, entry.capabilityDigest, `${entry.constraintIri} capability`).value;
  const input = readBound(entry.inputContractRef, entry.inputContractDigest, `${entry.constraintIri} input contract`).value;
  const output = readBound(entry.outputContractRef, entry.outputContractDigest, `${entry.constraintIri} output contract`).value;
  const discoveryArtifact = readBound(entry.discoveryContractRef, entry.discoveryContractDigest, `${entry.constraintIri} discovery`);
  const evidence = readBound(entry.evidenceSchemaRef, entry.evidenceSchemaDigest, `${entry.constraintIri} evidence schema`).value;
  const vectors = readBound(entry.testVectorsRef, entry.testVectorsDigest, `${entry.constraintIri} test vectors`).value;
  const discovery = discoveryArtifact.value;

  if (capability.capabilityId !== entry.constraintIri || capability.constraintIri !== entry.constraintIri
      || capability.groupId !== group.groupId || capability.toolId !== group.toolId) {
    throw new Error(`${entry.constraintIri} capability identity mismatch`);
  }
  requireDirectEntrypoint(group, capability.entrypoint.ref, capability.entrypoint.digest, `${entry.constraintIri} capability`);
  sameArtifact(capability.runtime, state.runtimeArtifact, `${entry.constraintIri} capability runtime`);
  sameArtifact(capability.toolArtifact, state.toolArtifacts.get(group.groupId), `${entry.constraintIri} capability tool`);
  for (const [label, actual, expected] of [
    ['input', capability.inputContract, { ref: entry.inputContractRef, digest: entry.inputContractDigest }],
    ['output', capability.outputContract, { ref: entry.outputContractRef, digest: entry.outputContractDigest }],
    ['discovery', capability.subjectDiscoveryComponent, { ref: entry.discoveryContractRef, digest: entry.discoveryContractDigest }],
    ['evidence', capability.evidenceResultComponent, { ref: entry.evidenceSchemaRef, digest: entry.evidenceSchemaDigest }],
    ['vectors', capability.testVectors, { ref: entry.testVectorsRef, digest: entry.testVectorsDigest }],
  ]) sameArtifact(actual, expected, `${entry.constraintIri} capability ${label}`);
  for (const contract of [input, output]) {
    if (contract.constraintIri !== entry.constraintIri) throw new Error(`${entry.constraintIri} contract identity mismatch`);
    sameArtifact(contract.subjectDiscoveryComponent, capability.subjectDiscoveryComponent, `${entry.constraintIri} contract discovery`);
    sameArtifact(contract.evidenceResultComponent, capability.evidenceResultComponent, `${entry.constraintIri} contract evidence`);
  }
  if (discovery.subjectCount !== 1 || discovery.subjects?.length !== 1
      || discovery.subjects[0].constraintIri !== entry.constraintIri
      || discovery.subjects[0].contextCount !== discovery.subjects[0].contexts?.length
      || discovery.subjects[0].contextCount !== capability.contextCount) {
    throw new Error(`${entry.constraintIri} singleton discovery/context closure mismatch`);
  }
  if (evidence.properties?.constraintIri?.const !== entry.constraintIri
      || evidence.properties?.semanticOwner?.const !== entry.constraintIri) {
    throw new Error(`${entry.constraintIri} evidence schema ownership mismatch`);
  }

  const componentRow = state.discoveryRows.get(group.groupId).get(entry.constraintIri);
  if (!componentRow) throw new Error(`${entry.constraintIri} is absent from the real component discovery`);
  let componentExecution = null;
  let componentVector = null;
  if (group.groupId === 'orders-portfolio') {
    componentVector = state.componentVectors.get(group.groupId)?.get(entry.constraintIri);
    if (!componentVector) {
      throw new Error(`${entry.constraintIri} is absent from the real component vectors`);
    }
    componentExecution = ordersPortfolioExecution(componentVector, componentRow);
  }
  const rowDigest = sha256(Buffer.from(canonicalJcs(componentRow), 'utf8'));
  if (capability.componentDiscoveryRowDigest !== rowDigest
      || capability.implementationDigest !== componentImplementationDigest(group, componentRow)) {
    throw new Error(`${entry.constraintIri} component discovery/implementation digest mismatch`);
  }
  const expectedViolationCode = componentExecution?.status === 'pending'
    ? componentExecution.pendingCode
    : componentVector?.violation?.expectedCode
      || vectors.categories.violation[0].expected.code;
  if (capability.semanticOwner.constraintIri !== entry.constraintIri
      || capability.semanticOwner.dispatchDigest !== (componentRow.dispatchDigest || rowDigest)
      || capability.semanticOwner.expectedViolationCode !== expectedViolationCode
      || (group.groupId === 'orders-portfolio'
        && (capability.semanticOwner.authoredViolationCode
          !== componentVector.violation.expectedCode
          || canonicalJcs(capability.semanticOwner.execution)
            !== canonicalJcs(componentExecution)))) {
    throw new Error(`${entry.constraintIri} semantic dispatch owner mismatch`);
  }

  exactKeys(vectors.categories, CATEGORIES, `${entry.constraintIri} vector categories`);
  const caseIds = new Set();
  const inputRefs = new Set();
  const inputDigests = new Set();
  const cases = [];
  for (const category of CATEGORIES) {
    const rows = vectors.categories[category];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${entry.constraintIri}/${category} is empty`);
    for (const testCase of rows) {
      exactKeys(
        testCase,
        ['caseId', 'category', 'expected', 'inputDigest', 'inputRef'],
        `${entry.constraintIri}/${category} case`,
      );
      exactKeys(
        testCase.expected,
        ['caseStatus', 'code', 'outcome', 'semanticOwner', 'status'],
        `${entry.constraintIri}/${category} expectation`,
      );
      if (testCase.category !== category || testCase.expected.semanticOwner !== entry.constraintIri) {
        throw new Error(`${entry.constraintIri}/${category} case binding mismatch`);
      }
      const shouldBePending = componentExecution?.status === 'pending'
        && (category === 'positive' || category === 'violation');
      if (testCase.expected.caseStatus !== (shouldBePending ? 'pending' : 'passed')) {
        throw new Error(`${entry.constraintIri}/${category} case lifecycle mismatch`);
      }
      if (shouldBePending
          && (testCase.expected.status !== 'completed'
            || testCase.expected.outcome !== 'violation'
            || testCase.expected.code !== componentExecution.pendingCode)) {
        throw new Error(`${entry.constraintIri}/${category} pending expectation mismatch`);
      }
      if (group.groupId === 'orders-portfolio' && !shouldBePending
          && category === 'positive'
          && (testCase.expected.status !== 'completed'
            || testCase.expected.outcome !== 'accepted'
            || testCase.expected.code !== null)) {
        throw new Error(`${entry.constraintIri}/${category} executable expectation mismatch`);
      }
      if (group.groupId === 'orders-portfolio' && !shouldBePending
          && category === 'violation'
          && (testCase.expected.status !== 'completed'
            || testCase.expected.outcome !== 'violation'
            || testCase.expected.code !== componentVector.violation.expectedCode)) {
        throw new Error(`${entry.constraintIri}/${category} executable violation mismatch`);
      }
      const inputArtifact = readBound(testCase.inputRef, testCase.inputDigest, `${entry.constraintIri}/${category} input`, true);
      if (caseIds.has(testCase.caseId) || inputRefs.has(testCase.inputRef.path)
          || inputDigests.has(testCase.inputDigest)) {
        throw new Error(`${entry.constraintIri} reuses a case ID, input ref, or input digest across categories`);
      }
      caseIds.add(testCase.caseId);
      inputRefs.add(testCase.inputRef.path);
      inputDigests.add(testCase.inputDigest);
      cases.push({ category, descriptor: capability, group, input: inputArtifact.value, testCase });
    }
  }
  return { cases, contextCount: capability.contextCount };
}

function loadState() {
  const runtimeArtifact = { ref: { kind: 'path', root: 'sourceTree', path: RUNTIME_LOCK_PATH }, digest: sha256(readBytes(RUNTIME_LOCK_PATH)) };
  const runtime = readBound(runtimeArtifact.ref, runtimeArtifact.digest, 'Custom runtime lock').value;
  if (runtime.version !== EXPECTED_NODE_VERSION || process.versions.node !== EXPECTED_NODE_VERSION
      || runtime.engine !== 'node' || runtime.permissionModelRequired !== true
      || runtime.networkPolicy !== 'deny') {
    throw new Error(`Custom runtime lock requires Node ${EXPECTED_NODE_VERSION} with denied network permission model`);
  }
  if (!Array.isArray(runtime.entrypoints) || runtime.entrypoints.length !== GROUPS.length) {
    throw new Error('Custom runtime lock does not bind all five real entrypoints');
  }
  for (const group of GROUPS) {
    const row = runtime.entrypoints.find((candidate) => candidate.groupId === group.groupId);
    if (!row || row.toolId !== group.toolId) throw new Error(`${group.groupId} runtime entrypoint binding is missing`);
    requireDirectEntrypoint(group, row.entrypoint.ref, row.entrypoint.digest, `${group.groupId} runtime lock`);
  }
  const toolArtifacts = new Map();
  const discoveryRows = new Map();
  const componentVectors = new Map();
  for (const group of GROUPS) {
    const toolPath = `scripts/domain/custom-release-profile/v0.3.0/tools/${group.groupId}.json`;
    const toolArtifact = { ref: { kind: 'path', root: 'sourceTree', path: toolPath }, digest: sha256(readBytes(toolPath)) };
    const tool = readBound(toolArtifact.ref, toolArtifact.digest, `${group.groupId} tool`).value;
    if (tool.toolId !== group.toolId || tool.groupId !== group.groupId) throw new Error(`${group.groupId} tool identity mismatch`);
    requireDirectEntrypoint(group, tool.entrypoint.ref, tool.entrypoint.digest, `${group.groupId} tool`);
    if (tool.componentDiscovery.ref.path !== group.discoveryPath
        || tool.componentDiscovery.digest !== sha256(readBytes(group.discoveryPath))) {
      throw new Error(`${group.groupId} tool component discovery mismatch`);
    }
    if (!Array.isArray(tool.implementationArtifacts) || tool.implementationArtifacts.length === 0
        || !tool.implementationArtifacts.some((row) => (
          row.ref.path === group.entrypointPath && row.digest === sha256(readBytes(group.entrypointPath))
        ))) {
      throw new Error(`${group.groupId} tool omits its real worker from implementation closure`);
    }
    for (const artifact of tool.implementationArtifacts) {
      if (artifact.digest !== sha256(readBytes(artifact.ref.path))) {
        throw new Error(`${group.groupId} implementation artifact drift at ${artifact.ref.path}`);
      }
    }
    const component = JSON.parse(readBytes(group.discoveryPath).toString('utf8'));
    const rows = new Map(component.constraints.map((row) => [discoveryConstraintIri(group, row), row]));
    if (rows.size !== component.constraints.length) throw new Error(`${group.groupId} component discovery has duplicate constraints`);
    discoveryRows.set(group.groupId, rows);
    if (group.groupId === 'orders-portfolio') {
      const vectorBytes = readBytes(group.vectorsPath);
      const vectorDocument = strictJcsBytes(
        vectorBytes,
        `${group.groupId} component vectors`,
        true,
      );
      if (!Array.isArray(vectorDocument.vectors)) {
        throw new Error(`${group.groupId} component vectors are missing`);
      }
      const vectorsByIri = new Map(vectorDocument.vectors.map((vector) => [
        vector.constraintIri,
        vector,
      ]));
      if (vectorsByIri.size !== vectorDocument.vectors.length) {
        throw new Error(`${group.groupId} component vectors have duplicate constraints`);
      }
      componentVectors.set(group.groupId, vectorsByIri);
    }
    toolArtifacts.set(group.groupId, toolArtifact);
  }
  return { componentVectors, discoveryRows, runtimeArtifact, toolArtifacts };
}

async function verifySourceSnapshot() {
  const generated = await buildCustomReleaseArtifacts();
  for (const [relativePath, expected] of generated.artifacts) {
    const actual = readBytes(relativePath);
    if (!actual.equals(expected)) throw new Error(`generated Custom release artifact drift: ${relativePath}`);
  }
  return generated;
}

async function verifyCustomReleaseCapabilities(options = {}) {
  const before = await verifySourceSnapshot();
  const registryArtifact = readBound(
    { kind: 'path', root: 'sourceTree', path: REGISTRY_PATH },
    before.registryDigest,
    'Custom capability registry',
  );
  const registry = registryArtifact.value;
  if (registry.profileRef !== PROFILE_REF || !Array.isArray(registry.entries)
      || canonicalJcs(registry.entries.map((entry) => entry.constraintIri))
        !== canonicalJcs(before.definitionIris)) {
    throw new Error(
      'Custom capability registry must exactly bind the authoritative ontology Custom IRI inventory',
    );
  }
  const state = loadState();
  const cases = [];
  let contextCount = 0;
  let previous = null;
  for (const entry of registry.entries) {
    if (previous !== null && byteCompare(previous, entry.constraintIri) >= 0) {
      throw new Error('Custom capability registry is not strictly IRI-sorted and unique');
    }
    previous = entry.constraintIri;
    const verified = verifyRegistryEntry(entry, state);
    contextCount += verified.contextCount;
    cases.push(...verified.cases);
  }
  const expectedCaseCount = before.definitionCount * CATEGORIES.length;
  if (contextCount !== before.contextCount || cases.length !== expectedCaseCount) {
    throw new Error(
      `Custom execution inventory requires ${before.contextCount} ontology contexts/`
        + `${expectedCaseCount} category cases; found ${contextCount}/${cases.length}`,
    );
  }

  const rows = [];
  const groupCounts = {};
  for (const work of cases) {
    let actual;
    try {
      actual = work.group.groupId === 'identifier'
        ? identifierResult(work.input)
        : stdinResult(work.group, work.input, work.category);
    } catch (cause) {
      actual = { status: 'engineFailure', outcome: 'engineFailure', code: 'VERIFIER_EXECUTION', output: null, stderr: cause.message };
    }
    verifyOutputIdentity(work.group, work.descriptor, work.category, actual, work.testCase.expected);
    const expected = work.testCase.expected;
    if (actual.status !== expected.status || actual.outcome !== expected.outcome
        || actual.code !== expected.code || expected.semanticOwner !== work.descriptor.constraintIri) {
      throw new Error(
        `${work.descriptor.constraintIri}/${work.category} expected `
          + `${expected.status}/${expected.outcome}/${String(expected.code)}, got `
          + `${actual.status}/${actual.outcome}/${String(actual.code)}`,
      );
    }
    rows.push(evidenceRow(work.testCase, work.descriptor, actual));
    groupCounts[work.group.groupId] = (groupCounts[work.group.groupId] || 0) + 1;
    if (typeof options.onProgress === 'function' && rows.length % 50 === 0) {
      options.onProgress(rows.length, cases.length);
    }
  }
  const after = await verifySourceSnapshot();
  if (after.registryDigest !== before.registryDigest) throw new Error('Custom source snapshot changed during execution');
  const summary = summarizeCaseRows(rows);
  const groupPendingCaseCounts = Object.fromEntries(GROUPS.map((group) => [
    group.groupId,
    rows.filter((row) => row.caseStatus === 'pending'
      && state.discoveryRows.get(group.groupId).has(row.constraintIri)).length,
  ]));
  const evidence = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    componentEligible: summary.componentEligible,
    outcome: summary.outcome,
    definitionCount: registry.entries.length,
    contextCount,
    caseCount: rows.length,
    passedCaseCount: summary.passedCaseCount,
    failedCaseCount: 0,
    skippedCaseCount: 0,
    pendingCaseCount: summary.pendingCaseCount,
    pending: summary.pending,
    groupCaseCounts: groupCounts,
    groupPendingCaseCounts,
    registryRef: { kind: 'path', root: 'sourceTree', path: REGISTRY_PATH },
    registryDigest: before.registryDigest,
    runtimeRef: state.runtimeArtifact.ref,
    runtimeDigest: state.runtimeArtifact.digest,
    runtime: { engine: 'node', version: process.versions.node },
    sandboxPolicy: {
      network: 'denied-by-node-permission-model',
      childProcess: 'denied-inside-workers',
      fileWrite: 'denied-except-identifier-single-output',
      timeoutMs: 2500,
      engineFailureTimeoutMs: 250,
    },
    rows,
  };
  return Object.freeze({ evidence, evidenceBytes: Buffer.from(canonicalJcs(evidence), 'utf8') });
}

function customReleaseExitCode(evidence) {
  if (evidence?.componentEligible === true && evidence.outcome === 'passed'
      && evidence.pendingCaseCount === 0) {
    return 0;
  }
  if (evidence?.componentEligible === false && evidence.outcome === 'pending'
      && Number.isSafeInteger(evidence.pendingCaseCount)
      && evidence.pendingCaseCount > 0) {
    return 2;
  }
  throw new Error('Custom release evidence has an inconsistent eligibility/outcome state');
}

function writeEvidence(outputDirectory, result) {
  const resolved = path.resolve(outputDirectory);
  const evidenceRoot = path.resolve(ROOT, 'docs', 'domain', 'infrastructure', 'custom-release-capability-runs');
  if (!resolved.startsWith(`${evidenceRoot}${path.sep}`) || resolved === evidenceRoot) {
    throw new Error('Custom capability evidence output must be a named child of docs/domain/infrastructure/custom-release-capability-runs');
  }
  if (fs.existsSync(resolved)) throw new Error(`refusing to overwrite immutable evidence directory ${resolved}`);
  fs.mkdirSync(resolved, { recursive: true });
  const evidenceFile = path.join(resolved, 'custom-release-capability-evidence.json');
  fs.writeFileSync(evidenceFile, result.evidenceBytes, { flag: 'wx' });
  const manifest = {
    schemaVersion: '1.0',
    evidenceRef: {
      kind: 'path', root: 'sourceTree',
      path: path.relative(ROOT, evidenceFile).split(path.sep).join('/'),
    },
    evidenceDigest: sha256(result.evidenceBytes),
    evidenceByteLength: result.evidenceBytes.length,
  };
  fs.writeFileSync(
    path.join(resolved, 'manifest.json'),
    Buffer.from(canonicalJcs(manifest), 'utf8'),
    { flag: 'wx' },
  );
  return manifest;
}

module.exports = {
  ASSURANCE_FIELDS,
  customReleaseExitCode,
  exactKeys,
  summarizeCaseRows,
  strictJcsBytes,
  verifyCustomReleaseCapabilities,
  writeEvidence,
};
