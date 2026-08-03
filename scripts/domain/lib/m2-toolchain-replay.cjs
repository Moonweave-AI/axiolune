'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const yaml = require('js-yaml');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  assertRegistryMatchesLock,
  executeCustomPayload,
} = require('./custom-release-payload-replay.cjs');
const {
  replayConstraintInstancesFromP1,
} = require('./m2-constraint-instance-p1-replay.cjs');
const {
  REGISTRY_PATH: RELEASE_CAPABILITY_REGISTRY_PATH,
  parseRegistryBytes: parseReleaseCapabilityRegistryBytes,
  validateReleaseCapabilityRegistry,
} = require('./m2-release-capability-registry.cjs');
const {
  assertReleaseRegistryMatchesLock,
  executeReleaseCapabilityPayload,
} = require('./m2-release-capability-replay.cjs');
const { constraintInstanceId } = require('./m2-constraint-instance-audit.cjs');

const CUSTOM_VECTOR_CATEGORIES = Object.freeze([
  'positive', 'violation', 'tamper', 'emptySubject', 'engineFailure',
]);
const CUSTOM_REGISTRY_PATH =
  'scripts/domain/release-profile/v0.3.0/custom-capability-bindings.json';
const CUSTOM_COMPONENT =
  'https://axiolune.ai/conformance/m2/0.3.0/components/CustomConstraintComponent';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function exactKeys(value, expected, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ code: 'M2_TOOLCHAIN_SCHEMA', path: label, message: `${label} must be an object` });
    return false;
  }
  if (canonicalJcs(Object.keys(value).sort()) !== canonicalJcs([...expected].sort())) {
    issues.push({ code: 'M2_TOOLCHAIN_SCHEMA', path: label, message: `${label} fields differ from the closed schema` });
    return false;
  }
  return true;
}

function refKey(reference) {
  return canonicalJcs(reference);
}

function tupleKey(value) {
  return canonicalJcs({
    toolId: value.toolId,
    capabilityId: value.capabilityId,
    capabilityRef: value.capabilityRef,
    capabilityDigest: value.capabilityDigest,
    entrypointRef: value.entrypointRef,
    entrypointDigest: value.entrypointDigest,
    discoveryContractRef: value.discoveryContractRef,
    discoveryContractDigest: value.discoveryContractDigest,
    evidenceSchemaRef: value.evidenceSchemaRef,
    evidenceSchemaDigest: value.evidenceSchemaDigest,
  });
}

function sourceFileMap(gitReplay) {
  return new Map((gitReplay?.p1?.files || []).map((file) => [file.path, file.content]));
}

function resolveSourceRef(reference, digest, files, label, issues) {
  if (!reference || reference.kind !== 'path' || reference.root !== 'sourceTree') {
    issues.push({
      code: 'M2_TOOLCHAIN_NON_SOURCE_REF',
      path: label,
      message: `${label} cannot be resolved from the independently reconstructed P1 Git tree`,
      kind: 'unverified',
    });
    return null;
  }
  const bytes = files.get(reference.path);
  if (!bytes) {
    issues.push({
      code: 'M2_TOOLCHAIN_ARTIFACT_MISSING',
      path: reference.path,
      message: `${label} is absent from the reconstructed P1 Git tree`,
      kind: 'missing',
    });
    return null;
  }
  if (sha256(bytes) !== digest) {
    issues.push({
      code: 'M2_TOOLCHAIN_ARTIFACT_DIGEST',
      path: reference.path,
      message: `${label} digest differs from reconstructed Git blob bytes`,
    });
    return null;
  }
  return bytes;
}

function collectRequiredTuples(requiredGates, releaseChecks) {
  const rows = [];
  for (const gate of Array.isArray(requiredGates?.gates) ? requiredGates.gates : []) {
    rows.push({ label: `required-gate:${gate.gateId}`, value: gate });
  }
  for (const stage of Array.isArray(releaseChecks?.stages) ? releaseChecks.stages : []) {
    for (const check of Array.isArray(stage?.checks) ? stage.checks : []) {
      rows.push({ label: `release-check:${stage.stageId}/${check.checkId}`, value: check });
    }
  }
  return rows;
}

function discoverCustomConstraints(files, issues, options = {}) {
  const modules = [];
  const constraints = [];
  const parsedModules = [];
  for (const [filePath, bytes] of files) {
    if (!/^ontology\/domain\/finance\/[^/]+\/module\.yaml$/u.test(filePath)) continue;
    try {
      const document = yaml.load(bytes.toString('utf8'), {
        schema: yaml.CORE_SCHEMA.withTags(yaml.mergeTag),
      });
      modules.push(filePath);
      parsedModules.push({ document, filePath });
      for (const constraint of Object.values(document?.domain?.constraints || {})) {
        if (constraint?.expression?.language !== 'Custom') continue;
        if (typeof constraint.iri !== 'string' || constraint.iri.length === 0) {
          issues.push({
            code: 'M2_CUSTOM_CONSTRAINT_IRI',
            path: filePath,
            message: 'Custom constraint lacks a stable IRI',
          });
        } else {
          constraints.push({
            constraintIri: constraint.iri,
            sourcePath: filePath,
            targetRef: typeof constraint.targetElement === 'string'
              ? constraint.targetElement : null,
          });
        }
      }
    } catch (cause) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_DISCOVERY',
        path: filePath,
        message: `cannot parse module for Custom constraints: ${cause.message}`,
      });
    }
  }
  modules.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  constraints.sort((left, right) => Buffer.compare(
    Buffer.from(left.constraintIri),
    Buffer.from(right.constraintIri),
  ));
  const expectedModuleCount = options.expectedModuleCount ?? 10;
  const expectedConstraintCount = options.expectedConstraintCount;
  if (modules.length !== expectedModuleCount || constraints.length === 0
      || (expectedConstraintCount !== undefined
        && constraints.length !== expectedConstraintCount)) {
    issues.push({
      code: 'M2_CUSTOM_CONSTRAINT_INVENTORY',
      path: 'ontology/domain/finance',
      message: `expected ${expectedModuleCount} modules / ${expectedConstraintCount ?? 'a non-empty ontology-authoritative set of'} Custom constraints; discovered ${modules.length} / ${constraints.length}`,
    });
  }
  const seen = new Set();
  for (const row of constraints) {
    if (seen.has(row.constraintIri)) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_DUPLICATE',
        path: row.sourcePath,
        message: `duplicate Custom constraint IRI ${row.constraintIri}`,
      });
    }
    seen.add(row.constraintIri);
  }
  const contexts = [];
  const boundOrigins = new Set();
  for (const { document, filePath } of parsedModules) {
    for (const [index, binding] of (document?.domain?.constraintBindings || []).entries()) {
      if (!seen.has(binding?.constraintRef)) continue;
      if (typeof binding.targetElement !== 'string' || binding.targetElement.length === 0) {
        issues.push({
          code: 'M2_CUSTOM_CONSTRAINT_CONTEXT_TARGET',
          path: `${filePath}/domain/constraintBindings/${index}`,
          message: `${binding.constraintRef} Custom binding lacks a stable targetElement IRI`,
        });
        continue;
      }
      boundOrigins.add(binding.constraintRef);
      const context = {
        originKind: 'constraintDefinition',
        originRef: binding.constraintRef,
        targetRef: binding.targetElement,
        component: CUSTOM_COMPONENT,
      };
      contexts.push({
        constraintIri: binding.constraintRef,
        constraintInstanceId: constraintInstanceId(context),
        targetRef: binding.targetElement,
        sourcePath: filePath,
      });
    }
  }
  for (const constraint of constraints) {
    if (boundOrigins.has(constraint.constraintIri)) continue;
    if (!constraint.targetRef) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_CONTEXT_MISSING',
        path: constraint.sourcePath,
        message: `${constraint.constraintIri} has neither a ConstraintBinding nor a definition targetElement`,
      });
      continue;
    }
    const context = {
      originKind: 'constraintDefinition',
      originRef: constraint.constraintIri,
      targetRef: constraint.targetRef,
      component: CUSTOM_COMPONENT,
    };
    contexts.push({
      constraintIri: constraint.constraintIri,
      constraintInstanceId: constraintInstanceId(context),
      targetRef: constraint.targetRef,
      sourcePath: constraint.sourcePath,
    });
  }
  contexts.sort((left, right) => Buffer.compare(
    Buffer.from(left.constraintInstanceId),
    Buffer.from(right.constraintInstanceId),
  ));
  for (let index = 1; index < contexts.length; index += 1) {
    if (contexts[index - 1].constraintInstanceId === contexts[index].constraintInstanceId) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_CONTEXT_DUPLICATE',
        path: contexts[index].sourcePath,
        message: `duplicate Custom target context ${contexts[index].constraintInstanceId}`,
      });
    }
  }
  return { modules, constraints, contexts };
}

function parseClosedJcs(bytes, label, issues, options = {}) {
  if (!bytes) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
      throw new Error('artifact bytes are not exact UTF-8 RFC 8785 JCS');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (options.requireSchemaVersion !== false && value.schemaVersion !== '1.0')) {
      throw new Error(options.requireSchemaVersion === false
        ? 'artifact must be an object'
        : 'artifact must be a schemaVersion 1.0 object');
    }
    return value;
  } catch (cause) {
    issues.push({
      code: 'M2_CUSTOM_CONSTRAINT_CONTRACT_JCS',
      path: label,
      message: `${label}: ${cause.message}`,
    });
    return null;
  }
}

function verifyCustomRegistryClosure(files, lock, issues, expectedConstraintIris) {
  const bytes = files.get(CUSTOM_REGISTRY_PATH);
  if (!Buffer.isBuffer(bytes)) {
    issues.push({
      code: 'M2_CUSTOM_CAPABILITY_REGISTRY_MISSING',
      path: CUSTOM_REGISTRY_PATH,
      message: 'the reconstructed P1 Git tree lacks the single Custom capability registry',
      kind: 'missing',
    });
    return null;
  }
  try {
    const registry = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(registry), 'utf8'))) {
      throw new Error('registry bytes are not exact UTF-8 RFC 8785 JCS');
    }
    assertRegistryMatchesLock(registry, lock, expectedConstraintIris);
    return registry;
  } catch (cause) {
    issues.push({
      code: 'M2_CUSTOM_CAPABILITY_REGISTRY_CLOSURE',
      path: CUSTOM_REGISTRY_PATH,
      message: cause.message,
    });
    return null;
  }
}

function verifyReleaseCapabilityRegistryClosure(
  files,
  lock,
  requiredGates,
  releaseChecks,
  issues,
) {
  const bytes = files.get(RELEASE_CAPABILITY_REGISTRY_PATH);
  if (!Buffer.isBuffer(bytes)) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_REGISTRY_MISSING',
      path: RELEASE_CAPABILITY_REGISTRY_PATH,
      message: 'reconstructed P1 lacks the 22-gate/42-check release capability registry',
      kind: 'missing',
    });
    return null;
  }
  try {
    const registry = parseReleaseCapabilityRegistryBytes(bytes);
    const registryIssues = [];
    const closure = validateReleaseCapabilityRegistry({
      registry,
      files,
      requiredGates,
      releaseChecks,
      issues: registryIssues,
    });
    if (registryIssues.length > 0) {
      for (const issue of registryIssues) issues.push(issue);
      return null;
    }
    if (closure.entries.length !== 64
        || closure.requiredGateCount !== 22 || closure.releaseCheckCount !== 42) {
      throw new Error('release capability registry does not close exact 22/42/64 inventory');
    }
    assertReleaseRegistryMatchesLock(registry, lock);
    return registry;
  } catch (cause) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_REGISTRY_CLOSURE',
      path: RELEASE_CAPABILITY_REGISTRY_PATH,
      message: cause.message,
    });
    return null;
  }
}

function verifyCaseRows(rows, category, constraintIri, files, label, issues) {
  if (!Array.isArray(rows) || rows.length === 0) {
    issues.push({
      code: 'M2_CUSTOM_CONSTRAINT_VECTOR_POLARITY',
      path: label,
      message: `${constraintIri} requires at least one ${category} case`,
    });
    return [];
  }
  const validRows = [];
  let previous = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const required = ['caseId', 'category', 'inputRef', 'inputDigest', 'expected'];
    const expectedFields = ['caseStatus', 'status', 'outcome', 'code', 'semanticOwner'];
    const expectedByCategory = {
      positive: { status: 'completed', outcome: 'accepted', code: null },
      violation: { status: 'completed', outcome: 'violation', code: 'non-empty' },
      tamper: { status: 'engineFailure', outcome: 'engineFailure', code: 'non-empty' },
      emptySubject: { status: 'engineFailure', outcome: 'engineFailure', code: 'non-empty' },
      engineFailure: { status: 'engineFailure', outcome: 'engineFailure', code: 'non-empty' },
    }[category];
    const pending = row?.expected?.caseStatus === 'pending';
    const expectedStatus = pending ? 'completed' : expectedByCategory?.status;
    const expectedOutcome = pending ? 'violation' : expectedByCategory?.outcome;
    const expectedCode = pending ? 'non-empty' : expectedByCategory?.code;
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || canonicalJcs(Object.keys(row).sort()) !== canonicalJcs(required.sort())
        || typeof row.caseId !== 'string' || row.caseId.length === 0
        || row.category !== category
        || !row.expected || typeof row.expected !== 'object' || Array.isArray(row.expected)
        || canonicalJcs(Object.keys(row.expected).sort())
          !== canonicalJcs(expectedFields.sort())
        || !['passed', 'pending'].includes(row.expected.caseStatus)
        || (pending && !['positive', 'violation'].includes(category))
        || row.expected.status !== expectedStatus
        || row.expected.outcome !== expectedOutcome
        || (expectedCode === null ? row.expected.code !== null
          : typeof row.expected.code !== 'string' || row.expected.code.length === 0)
        || row.expected.semanticOwner !== constraintIri) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_VECTOR_SCHEMA',
        path: `${label}/${index}`,
        message: `${constraintIri} ${category} case differs from the closed five-category schema`,
      });
      continue;
    }
    if (previous !== null
        && Buffer.compare(Buffer.from(previous), Buffer.from(row.caseId)) >= 0) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_VECTOR_ORDER',
        path: `${label}/${index}`,
        message: `${constraintIri} cases are not caseId-sorted and unique`,
      });
    }
    previous = row.caseId;
    resolveSourceRef(
      row.inputRef,
      row.inputDigest,
      files,
      `${constraintIri} ${category} input ${row.caseId}`,
      issues,
    );
    validRows.push(row);
  }
  return validRows;
}

function verifyCustomConstraintClosure(
  files,
  capabilitiesById,
  issues,
  options = {},
) {
  const inventory = discoverCustomConstraints(files, issues, options);
  const expectedContextsByIri = new Map();
  for (const context of inventory.contexts) {
    if (!expectedContextsByIri.has(context.constraintIri)) {
      expectedContextsByIri.set(context.constraintIri, []);
    }
    expectedContextsByIri.get(context.constraintIri).push({
      constraintInstanceId: context.constraintInstanceId,
      targetRef: context.targetRef,
    });
  }
  for (const rows of expectedContextsByIri.values()) {
    rows.sort((left, right) => Buffer.compare(
      Buffer.from(left.constraintInstanceId),
      Buffer.from(right.constraintInstanceId),
    ));
  }
  const missing = [];
  const contextIds = new Set();
  let customContextCount = 0;
  for (const row of inventory.constraints) {
    const binding = capabilitiesById.get(row.constraintIri);
    if (!binding) {
      missing.push(row.constraintIri);
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_CAPABILITY_MISSING',
        path: row.sourcePath,
        message: `${row.constraintIri} has no dedicated capability in the single release toolchain lock`,
        kind: 'missing',
      });
      continue;
    }
    if (typeof binding.toolVersion !== 'string' || binding.toolVersion.length === 0) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_TOOL_VERSION',
        path: row.constraintIri,
        message: 'Custom capability has no pinned tool version',
      });
    }
    const capabilityBytes = resolveSourceRef(
      binding.capabilityRef,
      binding.capabilityDigest,
      files,
      `${row.constraintIri} capability`,
      issues,
    );
    const inputBytes = resolveSourceRef(
      binding.inputContractRef,
      binding.inputContractDigest,
      files,
      `${row.constraintIri} input contract`,
      issues,
    );
    const outputBytes = resolveSourceRef(
      binding.outputContractRef,
      binding.outputContractDigest,
      files,
      `${row.constraintIri} output contract`,
      issues,
    );
    const capability = parseClosedJcs(capabilityBytes, `${row.constraintIri} capability`, issues);
    const inputContract = parseClosedJcs(inputBytes, `${row.constraintIri} input contract`, issues);
    const outputContract = parseClosedJcs(outputBytes, `${row.constraintIri} output contract`, issues);
    const discoveryBytes = resolveSourceRef(
      binding.discoveryContractRef,
      binding.discoveryContractDigest,
      files,
      `${row.constraintIri} discovery contract`,
      issues,
    );
    const evidenceBytes = resolveSourceRef(
      binding.evidenceSchemaRef,
      binding.evidenceSchemaDigest,
      files,
      `${row.constraintIri} evidence schema`,
      issues,
    );
    const discovery = parseClosedJcs(discoveryBytes, `${row.constraintIri} discovery contract`, issues);
    const evidenceSchema = parseClosedJcs(
      evidenceBytes, `${row.constraintIri} evidence schema`, issues,
      { requireSchemaVersion: false },
    );
    const discoveryTuple = {
      ref: binding.discoveryContractRef,
      digest: binding.discoveryContractDigest,
    };
    const evidenceTuple = {
      ref: binding.evidenceSchemaRef,
      digest: binding.evidenceSchemaDigest,
    };
    const sameTuple = (actual, expected) => actual && expected
      && actual.digest === expected.digest && refKey(actual.ref) === refKey(expected.ref);
    if (capability && (capability.capabilityId !== row.constraintIri
        || capability.constraintIri !== row.constraintIri
        || !sameTuple(capability.inputContract, {
          ref: binding.inputContractRef, digest: binding.inputContractDigest,
        })
        || !sameTuple(capability.outputContract, {
          ref: binding.outputContractRef, digest: binding.outputContractDigest,
        })
        || !sameTuple(capability.subjectDiscoveryComponent, discoveryTuple)
        || !sameTuple(capability.evidenceResultComponent, evidenceTuple)
        || !sameTuple(capability.testVectors, {
          ref: binding.testVectorsRef, digest: binding.testVectorsDigest,
        }))) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_CAPABILITY_BINDING',
        path: row.constraintIri,
        message: 'capability descriptor does not bind its exact contracts/discovery/evidence/vectors tuple',
      });
    }
    for (const [kind, contract] of [['input', inputContract], ['output', outputContract]]) {
      if (contract && (contract.constraintIri !== row.constraintIri
          || !sameTuple(contract.subjectDiscoveryComponent, discoveryTuple)
          || !sameTuple(contract.evidenceResultComponent, evidenceTuple))) {
        issues.push({
          code: 'M2_CUSTOM_CONSTRAINT_CONTRACT_BINDING',
          path: `${row.constraintIri}/${kind}`,
          message: `${kind} contract does not name the exact discovery/evidence components`,
        });
      }
    }
    if (discovery) {
      const subject = Array.isArray(discovery.subjects) && discovery.subjects.length === 1
        ? discovery.subjects[0] : null;
      if (discovery.subjectCount !== 1 || !subject
          || subject.constraintIri !== row.constraintIri
          || !Array.isArray(subject.contexts) || subject.contexts.length === 0
          || subject.contextCount !== subject.contexts.length) {
        issues.push({
          code: 'M2_CUSTOM_CONSTRAINT_DISCOVERY_BINDING',
          path: row.constraintIri,
          message: 'discovery contract is not one explicit non-empty singleton subject/context inventory',
        });
      } else {
        const actualContexts = subject.contexts.map((context) => ({
          constraintInstanceId: context?.constraintInstanceId,
          targetRef: context?.targetRef,
        })).sort((left, right) => Buffer.compare(
          Buffer.from(String(left.constraintInstanceId)),
          Buffer.from(String(right.constraintInstanceId)),
        ));
        const expectedContexts = expectedContextsByIri.get(row.constraintIri) || [];
        if (canonicalJcs(actualContexts) !== canonicalJcs(expectedContexts)) {
          issues.push({
            code: 'M2_CUSTOM_CONSTRAINT_CONTEXT_BINDING',
            path: row.constraintIri,
            message: 'discovery contexts differ from the exact ontology ConstraintBinding target inventory',
          });
        }
        customContextCount += subject.contexts.length;
        for (const context of subject.contexts) {
          const contextId = context?.constraintInstanceId;
          if (typeof contextId !== 'string' || contextId.length === 0
              || typeof context?.targetRef !== 'string' || context.targetRef.length === 0
              || contextIds.has(contextId)) {
            issues.push({
              code: 'M2_CUSTOM_CONSTRAINT_CONTEXT_CLOSURE',
              path: row.constraintIri,
              message: 'Custom context IDs/targets must be non-empty and globally unique',
            });
          } else contextIds.add(contextId);
        }
      }
    }
    if (evidenceSchema && (evidenceSchema.properties?.constraintIri?.const !== row.constraintIri
        || evidenceSchema.properties?.semanticOwner?.const !== row.constraintIri)) {
      issues.push({
        code: 'M2_CUSTOM_CONSTRAINT_EVIDENCE_BINDING',
        path: row.constraintIri,
        message: 'evidence schema does not bind the exact constraint and semantic owner',
      });
    }
    const vectorBytes = resolveSourceRef(
      binding.testVectorsRef,
      binding.testVectorsDigest,
      files,
      `${row.constraintIri} test vectors`,
      issues,
    );
    const vectors = parseClosedJcs(vectorBytes, `${row.constraintIri} test vectors`, issues);
    if (vectors) {
      if (!exactKeys(
        vectors,
        ['schemaVersion', 'profileRef', 'constraintIri', 'categories'],
        `${row.constraintIri} test vectors`,
        issues,
      ) || vectors.constraintIri !== row.constraintIri
        || !vectors.categories || typeof vectors.categories !== 'object'
        || Array.isArray(vectors.categories)
        || canonicalJcs(Object.keys(vectors.categories).sort())
          !== canonicalJcs([...CUSTOM_VECTOR_CATEGORIES].sort())) {
        issues.push({
          code: 'M2_CUSTOM_CONSTRAINT_VECTOR_BINDING',
          path: row.constraintIri,
          message: 'test-vector artifact is not exclusively bound to its Custom constraint IRI',
        });
      } else {
        const seenIds = new Set();
        const seenRefs = new Set();
        const seenDigests = new Set();
        for (const category of CUSTOM_VECTOR_CATEGORIES) {
          const cases = verifyCaseRows(
            vectors.categories[category], category, row.constraintIri, files,
            `${row.constraintIri}/categories/${category}`, issues,
          );
          for (const testCase of cases) {
            const reference = refKey(testCase.inputRef);
            if (seenIds.has(testCase.caseId) || seenRefs.has(reference)
                || seenDigests.has(testCase.inputDigest)) {
              issues.push({
                code: 'M2_CUSTOM_CONSTRAINT_VECTOR_REUSE',
                path: `${row.constraintIri}/${testCase.caseId}`,
                message: 'five vector categories must use distinct case IDs and input artifacts/digests',
              });
            }
            seenIds.add(testCase.caseId);
            seenRefs.add(reference);
            seenDigests.add(testCase.inputDigest);
          }
        }
      }
    }
  }
  const expectedContextCount = inventory.contexts.length;
  if (customContextCount !== expectedContextCount || contextIds.size !== expectedContextCount) {
    issues.push({
      code: 'M2_CUSTOM_CONSTRAINT_CONTEXT_INVENTORY',
      path: 'Custom/discovery-contexts',
      message: `expected ${expectedContextCount} unique Custom contexts; found ${customContextCount}/${contextIds.size}`,
    });
  }
  if (options.expectedContextCount !== undefined
      && expectedContextCount !== options.expectedContextCount) {
    issues.push({
      code: 'M2_CUSTOM_CONSTRAINT_SOURCE_CONTEXT_INVENTORY',
      path: 'ontology/domain/finance',
      message: `caller expected ${options.expectedContextCount} ontology Custom contexts; discovered ${expectedContextCount}`,
    });
  }
  return {
    moduleCount: inventory.modules.length,
    customConstraintCount: inventory.constraints.length,
    customConstraintIris: inventory.constraints.map((row) => row.constraintIri),
    customContextCount,
    missingCapabilityIris: missing,
  };
}

function verifyToolchainReplay(options) {
  const issues = [];
  const files = sourceFileMap(options.gitReplay);
  if (files.size === 0) {
    issues.push({
      code: 'M2_RELEASE_TOOLCHAIN_SOURCE_TREE_REQUIRED',
      path: '',
      message: 'toolchain replay requires a successfully reconstructed P1 Git tree',
      kind: 'unverified',
    });
    return { outcome: 'incomplete', issues, capabilityCount: 0 };
  }
  const p0Build = options.p0?.build;
  const p1Build = options.p1?.build;
  if (!p0Build || !p1Build
      || refKey(p0Build.toolLockRef) !== refKey(p1Build.toolLockRef)
      || p0Build.toolLockDigest !== p1Build.toolLockDigest) {
    issues.push({
      code: 'M2_RELEASE_TOOLCHAIN_P0_P1_BINDING',
      path: '/build/toolLockRef',
      message: 'P0 and P1 do not bind one byte-identical toolchain lock',
    });
    return { outcome: 'invalid', issues, capabilityCount: 0 };
  }
  const lockBytes = resolveSourceRef(
    p1Build.toolLockRef,
    p1Build.toolLockDigest,
    files,
    'toolchain lock',
    issues,
  );
  if (!lockBytes) return { outcome: 'invalid', issues, capabilityCount: 0 };
  let lock;
  try {
    lock = JSON.parse(lockBytes.toString('utf8'));
    if (!lockBytes.equals(Buffer.from(canonicalJcs(lock), 'utf8'))) {
      throw new Error('toolchain lock is not exact canonical JCS');
    }
  } catch (cause) {
    issues.push({ code: 'M2_TOOLCHAIN_JCS', path: p1Build.toolLockRef.path, message: cause.message });
    return { outcome: 'invalid', issues, capabilityCount: 0 };
  }
  if (!exactKeys(lock, ['schemaVersion', 'tools'], 'toolchain lock', issues)
      || lock.schemaVersion !== '1.0'
      || !Array.isArray(lock.tools)
      || lock.tools.length === 0) {
    issues.push({ code: 'M2_TOOLCHAIN_INVENTORY', path: '/tools', message: 'toolchain lock has no closed non-empty tool inventory' });
    return { outcome: 'invalid', issues, capabilityCount: 0 };
  }
  const capabilities = new Map();
  const capabilitiesById = new Map();
  const seenCapabilityIds = new Set();
  const seenCapabilityRefs = new Set();
  let previousToolId = null;
  for (let toolIndex = 0; toolIndex < lock.tools.length; toolIndex += 1) {
    const tool = lock.tools[toolIndex];
    if (!exactKeys(
      tool,
      ['toolId', 'version', 'artifactRef', 'artifactDigest', 'runtimeRef', 'runtimeDigest', 'capabilities'],
      `/tools/${toolIndex}`,
      issues,
    )) continue;
    if (previousToolId !== null
        && Buffer.compare(Buffer.from(previousToolId), Buffer.from(tool.toolId || '')) >= 0) {
      issues.push({ code: 'M2_TOOLCHAIN_TOOL_ORDER', path: `/tools/${toolIndex}/toolId`, message: 'tools are not strictly toolId-sorted and unique' });
    }
    previousToolId = tool.toolId;
    resolveSourceRef(tool.artifactRef, tool.artifactDigest, files, `tool ${tool.toolId} artifact`, issues);
    resolveSourceRef(tool.runtimeRef, tool.runtimeDigest, files, `tool ${tool.toolId} runtime`, issues);
    if (!Array.isArray(tool.capabilities) || tool.capabilities.length === 0) {
      issues.push({ code: 'M2_TOOLCHAIN_CAPABILITY_INVENTORY', path: `/tools/${toolIndex}/capabilities`, message: 'tool capabilities must be non-empty' });
      continue;
    }
    let previousCapabilityId = null;
    for (let capabilityIndex = 0; capabilityIndex < tool.capabilities.length; capabilityIndex += 1) {
      const capability = tool.capabilities[capabilityIndex];
      const at = `/tools/${toolIndex}/capabilities/${capabilityIndex}`;
      if (!exactKeys(
        capability,
        [
          'capabilityId', 'capabilityRef', 'capabilityDigest', 'entrypointRef',
          'entrypointDigest', 'inputContractRef', 'inputContractDigest',
          'outputContractRef', 'outputContractDigest', 'discoveryContractRef',
          'discoveryContractDigest', 'evidenceSchemaRef', 'evidenceSchemaDigest',
          'testVectorsRef', 'testVectorsDigest',
        ],
        at,
        issues,
      )) continue;
      if (previousCapabilityId !== null
          && Buffer.compare(Buffer.from(previousCapabilityId), Buffer.from(capability.capabilityId || '')) >= 0) {
        issues.push({ code: 'M2_TOOLCHAIN_CAPABILITY_ORDER', path: `${at}/capabilityId`, message: 'capabilities are not strictly capabilityId-sorted and unique' });
      }
      previousCapabilityId = capability.capabilityId;
      const capabilityRefKey = refKey(capability.capabilityRef);
      if (seenCapabilityIds.has(capability.capabilityId)
          || seenCapabilityRefs.has(capabilityRefKey)) {
        issues.push({ code: 'M2_TOOLCHAIN_CAPABILITY_ALIAS', path: at, message: 'capability ID/ref is duplicated across tools' });
      }
      seenCapabilityIds.add(capability.capabilityId);
      seenCapabilityRefs.add(capabilityRefKey);
      for (const prefix of [
        'capability', 'entrypoint', 'inputContract', 'outputContract',
        'discoveryContract', 'evidenceSchema', 'testVectors',
      ]) {
        resolveSourceRef(
          capability[`${prefix}Ref`],
          capability[`${prefix}Digest`],
          files,
          `${tool.toolId}/${capability.capabilityId} ${prefix}`,
          issues,
        );
      }
      const joined = {
        toolId: tool.toolId,
        toolVersion: tool.version,
        runtimeRef: tool.runtimeRef,
        runtimeDigest: tool.runtimeDigest,
        capabilityId: capability.capabilityId,
        ...capability,
      };
      capabilities.set(tupleKey(joined), joined);
      capabilitiesById.set(capability.capabilityId, joined);
    }
  }
  for (const required of collectRequiredTuples(options.requiredGates, options.releaseChecks)) {
    if (!capabilities.has(tupleKey(required.value))) {
      issues.push({
        code: 'M2_TOOLCHAIN_TUPLE_JOIN',
        path: required.label,
        message: `${required.label} does not join exactly one complete toolchain capability tuple`,
      });
    }
  }
  const customClosure = options.enforceCustomConstraintClosure === false
    ? { moduleCount: 0, customConstraintCount: 0, missingCapabilityIris: [] }
    : verifyCustomConstraintClosure(
      files,
      capabilitiesById,
      issues,
      {
        expectedModuleCount: options.expectedModuleCount,
        expectedConstraintCount: options.expectedCustomConstraintCount,
      },
    );
  const customRegistry = options.enforceCustomConstraintClosure === false
    ? null
    : verifyCustomRegistryClosure(
      files,
      lock,
      issues,
      customClosure.customConstraintIris,
    );
  const releaseCapabilityRegistry = options.enforceReleaseCapabilityClosure === false
    ? null
    : verifyReleaseCapabilityRegistryClosure(
      files,
      lock,
      options.requiredGates,
      options.releaseChecks,
      issues,
    );
  let constraintInstanceClosure = {
    moduleCount: 0,
    authoredConstraintCount: 0,
    authoredBindingCount: 0,
    authoredInstanceCount: 0,
    generatedCount: 0,
    routedModuleCount: 0,
    missingRoutedModuleCount: 0,
    entryCount: 0,
    manifestByteReplayMatched: false,
    contextualReplayVerified: false,
    gateJoinOutcome: 'not-run',
    gateJoinItemCount: 0,
    gateJoinCheckCount: 0,
    isolatedTemporaryCopy: false,
    callerEvidenceAccepted: null,
  };
  if (options.enforceConstraintInstanceClosure !== false) {
    try {
      constraintInstanceClosure = replayConstraintInstancesFromP1({
        files,
        timeoutMs: options.constraintInstanceReplayTimeoutMs,
      });
      for (const issue of constraintInstanceClosure.issues) {
        issues.push({
          ...issue,
          path: issue.path || 'constraint-instance-manifest.json',
        });
      }
    } catch (cause) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_P1_REPLAY_FAILED',
        path: 'scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json',
        message: `independent reconstructed-P1 constraint-instance replay failed: ${cause.message}`,
      });
    }
  }
  let capabilityExecution = null;
  if (issues.length === 0 && options.enforceCustomConstraintClosure !== false) {
    try {
      capabilityExecution = executeCustomPayload({
        files,
        lock,
        registry: customRegistry,
        expectedConstraintIris: customClosure.customConstraintIris,
        expectedContextCount: customClosure.customContextCount,
        hostDependencyRoot: options.hostDependencyRoot || path.resolve(__dirname, '../../..'),
        onProgress: options.onCapabilityExecutionProgress,
      });
    } catch (cause) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_EXECUTION_FAILED',
        path: '',
        message: `isolated reconstructed-P1 capability execution failed: ${cause.message}`,
      });
    }
  }
  let releaseCapabilityExecution = null;
  if (issues.length === 0 && options.enforceReleaseCapabilityClosure !== false) {
    try {
      releaseCapabilityExecution = executeReleaseCapabilityPayload({
        files,
        lock,
        registry: releaseCapabilityRegistry,
        requiredGates: options.requiredGates,
        releaseChecks: options.releaseChecks,
        timeoutMs: options.releaseCapabilityTimeoutMs,
        onProgress: options.onReleaseCapabilityExecutionProgress,
      });
    } catch (cause) {
      issues.push({
        code: 'M2_RELEASE_GATE_CHECK_CAPABILITY_EXECUTION_FAILED',
        path: RELEASE_CAPABILITY_REGISTRY_PATH,
        message: `isolated reconstructed-P1 gate/check execution failed: ${cause.message}`,
      });
    }
  }
  return {
    outcome: issues.length === 0 ? 'passed'
      : issues.some((issue) => (issue.kind || 'invalid') === 'invalid') ? 'invalid' : 'incomplete',
    issues,
    capabilityCount: capabilities.size,
    ...customClosure,
    constraintInstanceCount: constraintInstanceClosure.entryCount,
    authoredConstraintDefinitionCount: constraintInstanceClosure.authoredConstraintCount,
    authoredConstraintBindingCount: constraintInstanceClosure.authoredBindingCount,
    authoredConstraintContextLowerBound: constraintInstanceClosure.authoredInstanceCount,
    generatedConstraintInstanceCount: constraintInstanceClosure.generatedCount,
    shaclRoutedModuleCount: constraintInstanceClosure.routedModuleCount,
    shaclMissingModuleCount: constraintInstanceClosure.missingRoutedModuleCount,
    constraintManifestByteReplayMatched:
      constraintInstanceClosure.manifestByteReplayMatched,
    constraintContextualReplayVerified:
      constraintInstanceClosure.contextualReplayVerified,
    constraintGateJoinOutcome: constraintInstanceClosure.gateJoinOutcome,
    constraintGateJoinItemCount: constraintInstanceClosure.gateJoinItemCount,
    constraintGateJoinCheckCount: constraintInstanceClosure.gateJoinCheckCount,
    constraintReplayIsolated: constraintInstanceClosure.isolatedTemporaryCopy,
    constraintReplayCallerEvidenceAccepted:
      constraintInstanceClosure.callerEvidenceAccepted,
    shaclConstraintInstanceCount:
      constraintInstanceClosure.shaclInstanceCount || 0,
    shaclConstraintCaseExecutionCount:
      constraintInstanceClosure.shaclCaseExecutionCount || 0,
    shaclConstraintExecutionOutcome:
      constraintInstanceClosure.shaclExecutionOutcome || 'not-run',
    shaclConstraintCallerEvidenceAccepted:
      constraintInstanceClosure.shaclCallerEvidenceAccepted ?? null,
    capabilityExecutionCount: capabilityExecution?.caseCount || 0,
    capabilityExecutionDefinitionCount: capabilityExecution?.definitionCount || 0,
    capabilityExecutionIsolated: capabilityExecution?.isolatedTemporaryCopy === true,
    callerEvidenceAccepted: capabilityExecution?.callerEvidenceAccepted ?? null,
    releaseCapabilityExecutionCount: releaseCapabilityExecution?.caseCount || 0,
    releaseCapabilityCount: releaseCapabilityExecution?.capabilityCount || 0,
    requiredGateCapabilityCount:
      releaseCapabilityExecution?.requiredGateCapabilityCount || 0,
    releaseCheckCapabilityCount:
      releaseCapabilityExecution?.releaseCheckCapabilityCount || 0,
    releaseCapabilityExecutionIsolated:
      releaseCapabilityExecution?.isolatedTemporaryCopy === true,
    releaseCapabilityCallerEvidenceAccepted:
      releaseCapabilityExecution?.callerEvidenceAccepted ?? null,
  };
}

module.exports = {
  collectRequiredTuples,
  discoverCustomConstraints,
  tupleKey,
  verifyCustomRegistryClosure,
  verifyReleaseCapabilityRegistryClosure,
  verifyCustomConstraintClosure,
  verifyToolchainReplay,
};
