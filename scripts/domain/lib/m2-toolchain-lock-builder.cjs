'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  discoverCustomConstraints,
  verifyCustomConstraintClosure,
} = require('./m2-toolchain-replay.cjs');
const {
  REGISTRY_PATH: RELEASE_CAPABILITY_REGISTRY_PATH,
  parseRegistryBytes: parseReleaseCapabilityRegistryBytes,
  validateReleaseCapabilityRegistry,
} = require('./m2-release-capability-registry.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const REGISTRY_PATH =
  'scripts/domain/release-profile/v0.3.0/custom-capability-bindings.json';
const RELEASE_LOCK_PATH = 'releases/v0.3.0/toolchain.lock.json';
const COMPONENT_DISCOVERY_PATHS = Object.freeze([
  'scripts/domain/identifier-custom-profile/v0.3.0/discovery-contract.json',
  'scripts/domain/risk-custom-profile/v0.3.0/discovery-contract.json',
  'scripts/domain/orders-portfolio-custom-profile/v0.3.0/discovery-contract.json',
  'scripts/domain/post-trade-custom-profile/v0.3.0/discovery-contract.json',
  'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/discovery-contract.json',
]);
const ENTRY_FIELDS = Object.freeze([
  'constraintIri', 'toolId', 'toolVersion', 'toolArtifactRef',
  'toolArtifactDigest', 'runtimeRef', 'runtimeDigest', 'capabilityRef',
  'capabilityDigest', 'entrypointRef', 'entrypointDigest', 'inputContractRef',
  'inputContractDigest', 'outputContractRef', 'outputContractDigest',
  'discoveryContractRef', 'discoveryContractDigest', 'evidenceSchemaRef',
  'evidenceSchemaDigest', 'testVectorsRef', 'testVectorsDigest',
]);
const REF_FIELDS = Object.freeze([
  'toolArtifact', 'runtime', 'capability', 'entrypoint', 'inputContract',
  'outputContract', 'discoveryContract', 'evidenceSchema', 'testVectors',
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function safeSourcePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || relativePath.includes('\\') || relativePath.startsWith('/')
      || /^[A-Za-z]:/u.test(relativePath)
      || relativePath.split('/').some((segment) => (
        segment === '' || segment === '.' || segment === '..'
      ))) {
    throw new Error(`unsafe sourceTree path: ${String(relativePath)}`);
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`sourceTree path escapes source root: ${relativePath}`);
  }
  return absolute;
}

function readSourceFile(root, relativePath) {
  const absolute = safeSourcePath(root, relativePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular non-symlink file`);
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(absolute);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${relativePath} resolves outside source root`);
  }
  return fs.readFileSync(realFile);
}

function loadFinanceModules(sourceRoot, files) {
  const finance = safeSourcePath(sourceRoot, 'ontology/domain/finance');
  for (const entry of fs.readdirSync(finance, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const relativePath = `ontology/domain/finance/${entry.name}/module.yaml`;
    const absolute = safeSourcePath(sourceRoot, relativePath);
    if (fs.existsSync(absolute)) files.set(relativePath, readSourceFile(sourceRoot, relativePath));
  }
}

function componentProfileCoverage(files, sourceRoot, requiredIris) {
  const required = new Set(requiredIris);
  const rows = [];
  const covered = new Set();
  for (const profilePath of COMPONENT_DISCOVERY_PATHS) {
    let bytes = files.get(profilePath);
    if (!bytes && sourceRoot && fs.existsSync(safeSourcePath(sourceRoot, profilePath))) {
      bytes = readSourceFile(sourceRoot, profilePath);
      files.set(profilePath, bytes);
    }
    const constraintIris = [];
    if (bytes) {
      try {
        const value = JSON.parse(bytes.toString('utf8'));
        for (const constraint of Array.isArray(value.constraints) ? value.constraints : []) {
          const iri = constraint.constraintIri || constraint.constraintDefinitionIri;
          if (typeof iri === 'string') {
            constraintIris.push(iri);
            if (required.has(iri)) covered.add(iri);
          }
        }
      } catch {
        // This is only a non-authoritative gap inventory. The release registry
        // and byte replay below remain the fail-closed source of truth.
      }
    }
    constraintIris.sort(byteCompare);
    rows.push({ profilePath, discoveredConstraintIris: constraintIris });
  }
  return {
    profiles: rows,
    coveredConstraintIris: [...covered].sort(byteCompare),
    uncoveredConstraintIris: requiredIris.filter((iri) => !covered.has(iri)),
  };
}

function parseRegistryBytes(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error('registry is not exact UTF-8 RFC 8785 JCS');
  }
  return value;
}

function resolveEntryArtifact(entry, prefix, files, sourceRoot, at, issues) {
  const reference = entry[`${prefix}Ref`];
  const digest = entry[`${prefix}Digest`];
  if (!exactKeys(reference, ['kind', 'root', 'path'])
      || reference.kind !== 'path' || reference.root !== 'sourceTree'
      || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    issues.push({
      code: 'M2_TOOLCHAIN_BUILDER_ARTIFACT_REF',
      path: `${at}/${prefix}`,
      message: `${prefix} must be a digest-bound sourceTree path reference`,
    });
    return;
  }
  let bytes = files.get(reference.path);
  if (!bytes && sourceRoot) {
    try {
      bytes = readSourceFile(sourceRoot, reference.path);
      files.set(reference.path, bytes);
    } catch (cause) {
      issues.push({
        code: 'M2_TOOLCHAIN_BUILDER_ARTIFACT_MISSING',
        path: reference.path,
        message: cause.message,
      });
      return;
    }
  }
  if (!bytes) {
    issues.push({
      code: 'M2_TOOLCHAIN_BUILDER_ARTIFACT_MISSING',
      path: reference.path,
      message: `${prefix} bytes were not supplied`,
    });
  } else if (sha256(bytes) !== digest) {
    issues.push({
      code: 'M2_TOOLCHAIN_BUILDER_ARTIFACT_DIGEST',
      path: reference.path,
      message: `${prefix} digest differs from sourceTree bytes`,
    });
  }
}

function validateRegistry(registry, requiredIris, files, sourceRoot, issues) {
  if (!exactKeys(registry, ['schemaVersion', 'profileRef', 'entries'])
      || registry.schemaVersion !== '1.0' || registry.profileRef !== PROFILE_REF
      || !Array.isArray(registry.entries)) {
    issues.push({
      code: 'M2_TOOLCHAIN_BUILDER_REGISTRY_SCHEMA',
      path: REGISTRY_PATH,
      message: 'custom capability registry differs from its closed v1 schema',
    });
    return new Map();
  }
  const byIri = new Map();
  const capabilityRefs = new Set();
  let previous = null;
  for (const [index, entry] of registry.entries.entries()) {
    const at = `${REGISTRY_PATH}/entries/${index}`;
    if (!exactKeys(entry, ENTRY_FIELDS)
        || typeof entry.constraintIri !== 'string'
        || typeof entry.toolId !== 'string' || entry.toolId.length === 0
        || typeof entry.toolVersion !== 'string' || entry.toolVersion.length === 0) {
      issues.push({
        code: 'M2_TOOLCHAIN_BUILDER_REGISTRY_ENTRY',
        path: at,
        message: 'registry entry differs from the closed capability binding schema',
      });
      continue;
    }
    if (previous !== null && byteCompare(previous, entry.constraintIri) >= 0) {
      issues.push({
        code: 'M2_TOOLCHAIN_BUILDER_REGISTRY_ORDER',
        path: at,
        message: 'registry entries must be constraintIri-sorted and unique',
      });
    }
    previous = entry.constraintIri;
    for (const prefix of REF_FIELDS) {
      resolveEntryArtifact(entry, prefix, files, sourceRoot, at, issues);
    }
    let capabilityRefKey = '';
    try {
      capabilityRefKey = canonicalJcs(entry.capabilityRef);
    } catch {
      // resolveEntryArtifact emits the structural diagnostic.
    }
    if (capabilityRefs.has(capabilityRefKey)) {
      issues.push({
        code: 'M2_TOOLCHAIN_BUILDER_CAPABILITY_ALIAS',
        path: at,
        message: 'two constraint IRIs reuse one capabilityRef',
      });
    }
    capabilityRefs.add(capabilityRefKey);
    byIri.set(entry.constraintIri, entry);
  }
  const required = new Set(requiredIris);
  const actual = new Set(byIri.keys());
  const missingCapabilityIris = requiredIris.filter((iri) => !actual.has(iri));
  const extraCapabilityIris = [...actual].filter((iri) => !required.has(iri)).sort(byteCompare);
  if (missingCapabilityIris.length > 0 || extraCapabilityIris.length > 0
      || byIri.size !== registry.entries.length) {
    issues.push({
      code: 'M2_TOOLCHAIN_BUILDER_COVERAGE',
      path: REGISTRY_PATH,
      message: `capability coverage differs from Custom inventory: missing=${missingCapabilityIris.length}, extra=${extraCapabilityIris.length}`,
      missingCapabilityIris,
      extraCapabilityIris,
    });
  }
  return byIri;
}

function capabilityFromEntry(entry) {
  return {
    toolId: entry.toolId,
    toolVersion: entry.toolVersion,
    runtimeRef: entry.runtimeRef,
    runtimeDigest: entry.runtimeDigest,
    capabilityId: entry.constraintIri,
    capabilityRef: entry.capabilityRef,
    capabilityDigest: entry.capabilityDigest,
    entrypointRef: entry.entrypointRef,
    entrypointDigest: entry.entrypointDigest,
    inputContractRef: entry.inputContractRef,
    inputContractDigest: entry.inputContractDigest,
    outputContractRef: entry.outputContractRef,
    outputContractDigest: entry.outputContractDigest,
    discoveryContractRef: entry.discoveryContractRef,
    discoveryContractDigest: entry.discoveryContractDigest,
    evidenceSchemaRef: entry.evidenceSchemaRef,
    evidenceSchemaDigest: entry.evidenceSchemaDigest,
    testVectorsRef: entry.testVectorsRef,
    testVectorsDigest: entry.testVectorsDigest,
  };
}

function loadVectorInputs(entries, files, sourceRoot, issues) {
  if (!sourceRoot) return;
  for (const entry of entries) {
    const bytes = files.get(entry.testVectorsRef?.path);
    if (!bytes) continue;
    let vectors;
    try {
      vectors = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    for (const rows of Object.values(vectors.categories || {})) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const relativePath = row?.inputRef?.path;
        if (typeof relativePath !== 'string' || files.has(relativePath)) continue;
        try {
          files.set(relativePath, readSourceFile(sourceRoot, relativePath));
        } catch (cause) {
          issues.push({
            code: 'M2_TOOLCHAIN_BUILDER_VECTOR_INPUT_MISSING',
            path: relativePath,
            message: cause.message,
          });
        }
      }
    }
  }
}

function assembleLock(entries, issues) {
  const tools = new Map();
  const capabilityIds = new Set();
  const capabilityRefs = new Set();
  for (const entry of entries) {
    const capabilityId = entry.constraintIri || entry.capabilityId;
    let capabilityRefKey = '';
    try {
      capabilityRefKey = canonicalJcs(entry.capabilityRef);
    } catch {
      // Registry validation emits the structural artifact-ref diagnostic.
    }
    if (capabilityIds.has(capabilityId) || capabilityRefs.has(capabilityRefKey)) {
      issues.push({
        code: 'M2_TOOLCHAIN_BUILDER_GLOBAL_CAPABILITY_ALIAS',
        path: capabilityId,
        message: 'capability ID/ref is duplicated across the combined Custom/gate/check lock',
      });
      continue;
    }
    capabilityIds.add(capabilityId);
    capabilityRefs.add(capabilityRefKey);
    const toolMetadata = {
      version: entry.toolVersion,
      artifactRef: entry.toolArtifactRef,
      artifactDigest: entry.toolArtifactDigest,
      runtimeRef: entry.runtimeRef,
      runtimeDigest: entry.runtimeDigest,
    };
    const previous = tools.get(entry.toolId);
    if (previous && canonicalJcs(previous.metadata) !== canonicalJcs(toolMetadata)) {
      issues.push({
        code: 'M2_TOOLCHAIN_BUILDER_TOOL_CONFLICT',
        path: entry.toolId,
        message: 'one toolId has conflicting version/artifact/runtime bindings',
      });
      continue;
    }
    const row = previous || { metadata: toolMetadata, capabilities: [] };
    row.capabilities.push({
      capabilityId,
      capabilityRef: entry.capabilityRef,
      capabilityDigest: entry.capabilityDigest,
      entrypointRef: entry.entrypointRef,
      entrypointDigest: entry.entrypointDigest,
      inputContractRef: entry.inputContractRef,
      inputContractDigest: entry.inputContractDigest,
      outputContractRef: entry.outputContractRef,
      outputContractDigest: entry.outputContractDigest,
      discoveryContractRef: entry.discoveryContractRef,
      discoveryContractDigest: entry.discoveryContractDigest,
      evidenceSchemaRef: entry.evidenceSchemaRef,
      evidenceSchemaDigest: entry.evidenceSchemaDigest,
      testVectorsRef: entry.testVectorsRef,
      testVectorsDigest: entry.testVectorsDigest,
    });
    tools.set(entry.toolId, row);
  }
  return {
    schemaVersion: '1.0',
    tools: [...tools]
      .sort((left, right) => byteCompare(left[0], right[0]))
      .map(([toolId, row]) => ({
        toolId,
        version: row.metadata.version,
        artifactRef: row.metadata.artifactRef,
        artifactDigest: row.metadata.artifactDigest,
        runtimeRef: row.metadata.runtimeRef,
        runtimeDigest: row.metadata.runtimeDigest,
        capabilities: row.capabilities.sort((left, right) => (
          byteCompare(left.capabilityId, right.capabilityId)
        )),
      })),
  };
}

function incompleteResult(inventory, coverage, issues) {
  return {
    outcome: 'incomplete',
    issues,
    moduleCount: inventory.modules.length,
    customConstraintCount: inventory.constraints.length,
    customConstraintIris: inventory.constraints.map((row) => row.constraintIri),
    customContextCount: inventory.contexts?.length || 0,
    componentProfileCoveredCount: coverage.coveredConstraintIris.length,
    componentProfileUncoveredCount: coverage.uncoveredConstraintIris.length,
    requiredGateCapabilityCount: 0,
    releaseCheckCapabilityCount: 0,
    releaseCapabilityCount: 0,
    componentProfiles: coverage.profiles,
    missingCapabilityIris: inventory.constraints.map((row) => row.constraintIri),
    lock: null,
    bytes: null,
  };
}

function buildReleaseToolchainLock(options = {}) {
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : null;
  const files = options.files instanceof Map ? new Map(options.files) : new Map();
  if (sourceRoot) loadFinanceModules(sourceRoot, files);
  const discoveryIssues = [];
  const inventory = discoverCustomConstraints(files, discoveryIssues, {
    expectedModuleCount: options.expectedModuleCount,
    expectedConstraintCount: options.expectedConstraintCount,
  });
  const requiredIris = inventory.constraints.map((row) => row.constraintIri);
  const coverage = componentProfileCoverage(files, sourceRoot, requiredIris);
  const issues = [...discoveryIssues];
  const enforceReleaseCapabilities = options.enforceReleaseCapabilities ?? Boolean(sourceRoot);
  let registry = options.registry;
  if (registry === undefined && sourceRoot) {
    const absolute = safeSourcePath(sourceRoot, REGISTRY_PATH);
    if (fs.existsSync(absolute)) {
      try {
        registry = parseRegistryBytes(readSourceFile(sourceRoot, REGISTRY_PATH));
      } catch (cause) {
        issues.push({
          code: 'M2_TOOLCHAIN_BUILDER_REGISTRY_JCS',
          path: REGISTRY_PATH,
          message: cause.message,
        });
      }
    }
  }
  if (registry === undefined) {
    issues.push({
      code: 'M2_TOOLCHAIN_BUILDER_REGISTRY_MISSING',
      path: REGISTRY_PATH,
      message: `single release capability registry is missing for ${requiredIris.length} Custom constraints`,
      missingCapabilityIris: requiredIris,
    });
    return incompleteResult(inventory, coverage, issues);
  }
  const byIri = validateRegistry(registry, requiredIris, files, sourceRoot, issues);
  let releaseRegistry = options.releaseCapabilityRegistry;
  let releaseClosure = {
    entries: [], requiredGateCount: 0, releaseCheckCount: 0,
    requiredGates: null, releaseChecks: null,
  };
  if (enforceReleaseCapabilities) {
    if (releaseRegistry === undefined && sourceRoot) {
      const absolute = safeSourcePath(sourceRoot, RELEASE_CAPABILITY_REGISTRY_PATH);
      if (fs.existsSync(absolute)) {
        try {
          releaseRegistry = parseReleaseCapabilityRegistryBytes(
            readSourceFile(sourceRoot, RELEASE_CAPABILITY_REGISTRY_PATH),
          );
        } catch (cause) {
          issues.push({
            code: 'M2_RELEASE_CAPABILITY_REGISTRY_JCS',
            path: RELEASE_CAPABILITY_REGISTRY_PATH,
            message: cause.message,
          });
        }
      }
    }
    if (releaseRegistry === undefined) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_REGISTRY_MISSING',
        path: RELEASE_CAPABILITY_REGISTRY_PATH,
        message: '22 required gates and 42 release checks have no closed capability registry',
      });
    } else {
      releaseClosure = validateReleaseCapabilityRegistry({
        registry: releaseRegistry,
        files,
        sourceRoot,
        requiredGates: options.requiredGates,
        releaseChecks: options.releaseChecks,
        issues,
      });
    }
  }
  if (issues.length > 0) {
    const result = incompleteResult(inventory, coverage, issues);
    const required = new Set(requiredIris);
    result.missingCapabilityIris = requiredIris.filter((iri) => !byIri.has(iri));
    result.extraCapabilityIris = [...byIri.keys()].filter((iri) => !required.has(iri));
    result.requiredGateCapabilityCount = releaseClosure.requiredGateCount || 0;
    result.releaseCheckCapabilityCount = releaseClosure.releaseCheckCount || 0;
    result.releaseCapabilityCount = releaseClosure.entries.length;
    return result;
  }
  const capabilitiesById = new Map(
    [...byIri].map(([constraintIri, entry]) => (
      [constraintIri, capabilityFromEntry(entry)]
    )),
  );
  loadVectorInputs(
    [...byIri.values(), ...releaseClosure.entries],
    files,
    sourceRoot,
    issues,
  );
  const closureIssues = [];
  const closure = verifyCustomConstraintClosure(
    files,
    capabilitiesById,
    closureIssues,
    {
      expectedModuleCount: options.expectedModuleCount,
      expectedConstraintCount: options.expectedConstraintCount,
      expectedContextCount: options.expectedContextCount,
    },
  );
  issues.push(...closureIssues);
  const lock = assembleLock(
    [...byIri.values(), ...releaseClosure.entries],
    issues,
  );
  if (issues.length > 0) {
    return {
      ...incompleteResult(inventory, coverage, issues),
      missingCapabilityIris: closure.missingCapabilityIris,
    };
  }
  return {
    outcome: 'built',
    issues: [],
    moduleCount: inventory.modules.length,
    customConstraintCount: inventory.constraints.length,
    customConstraintIris: inventory.constraints.map((row) => row.constraintIri),
    customContextCount: closure.customContextCount,
    componentProfileCoveredCount: coverage.coveredConstraintIris.length,
    componentProfileUncoveredCount: coverage.uncoveredConstraintIris.length,
    requiredGateCapabilityCount: releaseClosure.requiredGateCount || 0,
    releaseCheckCapabilityCount: releaseClosure.releaseCheckCount || 0,
    releaseCapabilityCount: releaseClosure.entries.length,
    componentProfiles: coverage.profiles,
    missingCapabilityIris: [],
    lock,
    bytes: Buffer.from(canonicalJcs(lock), 'utf8'),
  };
}

module.exports = {
  COMPONENT_DISCOVERY_PATHS,
  ENTRY_FIELDS,
  PROFILE_REF,
  REGISTRY_PATH,
  RELEASE_LOCK_PATH,
  RELEASE_CAPABILITY_REGISTRY_PATH,
  buildReleaseToolchainLock,
  componentProfileCoverage,
  parseRegistryBytes,
  validateRegistry,
};
