'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  inventoryContextKey,
  projectShaclWithInventory,
} = require('../generate-m2-shacl.cjs');
const {
  EXECUTION_ROUTES_PATH,
  PROFILE_REF,
  auditConstraintInstanceClosure,
  constraintInstanceId,
} = require('./m2-constraint-instance-audit.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const MANIFEST_PATH =
  'scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json';
const EXPECTATIONS_PATH =
  'scripts/domain/release-profile/v0.3.0/constraint-instance-expectations.json';

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function posix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function sourcePath(root, relativePath) {
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

function readRegularSourceFile(root, relativePath) {
  const absolute = sourcePath(root, relativePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`sourceTree artifact is not a regular non-symlink file: ${relativePath}`);
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(absolute);
  const relativeReal = path.relative(realRoot, realFile);
  if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
    throw new Error(`sourceTree artifact resolves outside source root: ${relativePath}`);
  }
  return fs.readFileSync(realFile);
}

function discoverModules(sourceRoot) {
  const finance = sourcePath(sourceRoot, 'ontology/domain/finance');
  const modules = [];
  for (const entry of fs.readdirSync(finance, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const relativePath = `ontology/domain/finance/${entry.name}/module.yaml`;
    const absolute = sourcePath(sourceRoot, relativePath);
    if (!fs.existsSync(absolute)) continue;
    const bytes = readRegularSourceFile(sourceRoot, relativePath);
    modules.push({
      path: relativePath,
      bytes,
      document: yaml.load(bytes.toString('utf8')),
    });
  }
  modules.sort((left, right) => byteCompare(left.path, right.path));
  if (modules.length === 0) throw new Error('no M2 finance module.yaml files were discovered');
  return modules;
}

function normalizeModules(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error('modules must be a non-empty list');
  }
  const seen = new Set();
  const normalized = modules.map((module, index) => {
    if (!exactKeys(module, ['path', 'bytes', 'document'])
        || typeof module.path !== 'string' || !Buffer.isBuffer(module.bytes)
        || module.document === null || typeof module.document !== 'object') {
      throw new Error(`modules[${index}] is not a closed {path,bytes,document} tuple`);
    }
    sourcePath(process.cwd(), module.path);
    if (seen.has(module.path)) throw new Error(`duplicate module path: ${module.path}`);
    seen.add(module.path);
    return module;
  });
  normalized.sort((left, right) => byteCompare(left.path, right.path));
  return normalized;
}

function dedupeContexts(contexts) {
  const byKey = new Map();
  for (const context of contexts) {
    const key = inventoryContextKey(context);
    const previous = byKey.get(key);
    if (previous) {
      if (canonicalJcs(previous) !== canonicalJcs(context)) {
        throw new Error(`normalized IR emitted conflicting constraint context ${key}`);
      }
      continue;
    }
    byKey.set(key, context);
  }
  return [...byKey.values()].sort((left, right) => (
    byteCompare(inventoryContextKey(left), inventoryContextKey(right))
  ));
}

function validateExpectationShape(value, expectedResult, at, issues) {
  const fields = [
    'fixtureId', 'artifactRef', 'artifactDigest', 'schemaRef', 'schemaDigest',
    'expectedResult',
  ];
  if (!exactKeys(value, fields)
      || typeof value.fixtureId !== 'string' || !/^[\x21-\x7e]+$/u.test(value.fixtureId)
      || value.expectedResult !== expectedResult
      || !/^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest)
      || !/^sha256:[0-9a-f]{64}$/u.test(value.schemaDigest)) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_SCHEMA',
      path: at,
      message: `expected a closed ${expectedResult} expectation tuple`,
    });
    return false;
  }
  return true;
}

function validateExpectationRegistry(registry, instanceIds, issues) {
  if (!exactKeys(registry, ['schemaVersion', 'profileRef', 'entries'])
      || registry.schemaVersion !== '1.0'
      || registry.profileRef !== PROFILE_REF
      || !Array.isArray(registry.entries)) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_REGISTRY_SCHEMA',
      path: EXPECTATIONS_PATH,
      message: 'expectation registry differs from its closed v1 schema',
    });
    return new Map();
  }
  const expectations = new Map();
  let previousId = null;
  registry.entries.forEach((entry, index) => {
    const at = `${EXPECTATIONS_PATH}/entries/${index}`;
    if (!exactKeys(entry, [
      'constraintInstanceId', 'positiveExpectation', 'negativeExpectation',
    ]) || !/^[0-9a-f]{64}$/u.test(entry.constraintInstanceId)) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_REGISTRY_ENTRY',
        path: at,
        message: 'registry entry is not a closed constraint-instance expectation tuple',
      });
      return;
    }
    if (previousId !== null && byteCompare(previousId, entry.constraintInstanceId) >= 0) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_REGISTRY_ORDER',
        path: at,
        message: 'expectation registry entries must be ID-sorted and unique',
      });
    }
    previousId = entry.constraintInstanceId;
    const positiveValid = validateExpectationShape(
      entry.positiveExpectation,
      'conforms',
      `${at}/positiveExpectation`,
      issues,
    );
    const negativeValid = validateExpectationShape(
      entry.negativeExpectation,
      'violates',
      `${at}/negativeExpectation`,
      issues,
    );
    if (positiveValid && negativeValid) {
      expectations.set(entry.constraintInstanceId, entry);
    }
  });
  const required = new Set(instanceIds);
  const actual = new Set(expectations.keys());
  const missingIds = instanceIds.filter((id) => !actual.has(id));
  const extraIds = [...actual].filter((id) => !required.has(id)).sort(byteCompare);
  if (missingIds.length > 0 || extraIds.length > 0
      || expectations.size !== registry.entries.length) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_COVERAGE',
      path: EXPECTATIONS_PATH,
      message: `expectation coverage differs from normalized IR: missing=${missingIds.length}, extra=${extraIds.length}`,
      missingIds,
      extraIds,
    });
  }
  return expectations;
}

function expectationSourcePaths(registry) {
  const paths = new Set();
  for (const entry of registry?.entries || []) {
    for (const expectation of [entry.positiveExpectation, entry.negativeExpectation]) {
      for (const reference of [expectation?.artifactRef, expectation?.schemaRef]) {
        if (reference?.kind === 'path' && reference.root === 'sourceTree'
            && typeof reference.path === 'string') {
          paths.add(reference.path);
        }
      }
    }
  }
  return [...paths].sort(byteCompare);
}

function hydrateSourceFiles(files, registry, sourceRoot, issues) {
  for (const relativePath of expectationSourcePaths(registry)) {
    if (files.has(relativePath)) continue;
    if (!sourceRoot) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_SOURCE_UNAVAILABLE',
        path: relativePath,
        message: 'expectation artifact bytes were not supplied',
      });
      continue;
    }
    try {
      files.set(relativePath, readRegularSourceFile(sourceRoot, relativePath));
    } catch (cause) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_SOURCE_UNAVAILABLE',
        path: relativePath,
        message: cause.message,
      });
    }
  }
}

async function buildConstraintInstanceManifest(options = {}) {
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : null;
  const modules = options.modules
    ? normalizeModules(options.modules)
    : discoverModules(sourceRoot || process.cwd());
  const files = options.files instanceof Map ? new Map(options.files) : new Map();
  const contexts = [];
  const projections = [];
  for (const module of modules) {
    const projection = await projectShaclWithInventory(module.document);
    files.set(module.path, module.bytes);
    contexts.push(...projection.contexts);
    projections.push({
      modulePath: module.path,
      contexts: projection.contexts,
      shaclBytes: projection.bytes,
      contextCount: projection.contexts.length,
    });
  }
  if (sourceRoot) {
    for (const runnerPath of [
      EXECUTION_ROUTES_PATH,
      'scripts/domain/run-m2-shacl-instance-closure.cjs',
      'scripts/domain/verify-custom-release-capabilities.cjs',
      'scripts/domain/release-profile/v0.3.0/custom-capability-bindings.json',
    ]) {
      if (!files.has(runnerPath) && fs.existsSync(sourcePath(sourceRoot, runnerPath))) {
        files.set(runnerPath, readRegularSourceFile(sourceRoot, runnerPath));
      }
    }
  }
  const replayedContextInventory = dedupeContexts(contexts);
  const instances = replayedContextInventory
    .map((context) => ({
      ...context,
      constraintInstanceId: constraintInstanceId(context),
    }))
    .sort((left, right) => byteCompare(
      left.constraintInstanceId,
      right.constraintInstanceId,
    ));
  if (new Set(instances.map((entry) => entry.constraintInstanceId)).size !== instances.length) {
    throw new Error('constraint-instance stable ID collision');
  }

  const issues = [];
  let registry = options.expectations;
  if (registry === undefined && sourceRoot) {
    const absolute = sourcePath(sourceRoot, EXPECTATIONS_PATH);
    if (fs.existsSync(absolute)) {
      const bytes = readRegularSourceFile(sourceRoot, EXPECTATIONS_PATH);
      try {
        registry = JSON.parse(bytes.toString('utf8'));
        if (!bytes.equals(Buffer.from(canonicalJcs(registry), 'utf8'))) {
          throw new Error('expectation registry is not exact UTF-8 RFC 8785 JCS');
        }
      } catch (cause) {
        issues.push({
          code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_REGISTRY_JCS',
          path: EXPECTATIONS_PATH,
          message: cause.message,
        });
      }
    }
  }
  if (registry === undefined) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_EXPECTATIONS_MISSING',
      path: EXPECTATIONS_PATH,
      message: `no expectation registry exists for ${instances.length} normalized-IR instances`,
      missingIds: instances.map((entry) => entry.constraintInstanceId),
    });
    return {
      outcome: 'incomplete',
      issues,
      moduleCount: modules.length,
      instanceCount: instances.length,
      authoredCount: instances.filter((entry) => entry.originKind === 'constraintDefinition').length,
      generatedCount: instances.filter((entry) => entry.originKind === 'generatedConstraint').length,
      instances,
      projections,
      manifest: null,
      bytes: null,
      audit: null,
    };
  }

  const expectations = validateExpectationRegistry(
    registry,
    instances.map((entry) => entry.constraintInstanceId),
    issues,
  );
  hydrateSourceFiles(files, registry, sourceRoot, issues);
  if (issues.length > 0) {
    return {
      outcome: 'incomplete',
      issues,
      moduleCount: modules.length,
      instanceCount: instances.length,
      authoredCount: instances.filter((entry) => entry.originKind === 'constraintDefinition').length,
      generatedCount: instances.filter((entry) => entry.originKind === 'generatedConstraint').length,
      instances,
      projections,
      manifest: null,
      bytes: null,
      audit: null,
    };
  }

  const entries = instances.map((instance) => {
    const expectation = expectations.get(instance.constraintInstanceId);
    return {
      constraintInstanceId: instance.constraintInstanceId,
      originKind: instance.originKind,
      originRef: instance.originRef,
      targetRef: instance.targetRef,
      ...(Object.hasOwn(instance, 'path')
        ? { pathKind: instance.pathKind, path: instance.path }
        : {}),
      component: instance.component,
      severity: instance.severity,
      generatedOrAuthored: instance.generatedOrAuthored,
      positiveExpectation: expectation.positiveExpectation,
      negativeExpectation: expectation.negativeExpectation,
    };
  });
  const manifest = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    entries,
  };
  const bytes = Buffer.from(canonicalJcs(manifest), 'utf8');
  files.set(MANIFEST_PATH, bytes);
  const audit = auditConstraintInstanceClosure({ files, replayedContextInventory });
  const structuralIssues = audit.issues.filter((issue) => (
    issue.code !== 'M2_SHACL_EXECUTION_INSTANCE_JOIN_REQUIRED'
      && issue.code !== 'M2_SHACL_MODULE_ROUTING_INCOMPLETE'
  ));
  if (structuralIssues.length > 0) {
    return {
      outcome: 'invalid',
      issues: structuralIssues,
      moduleCount: modules.length,
      instanceCount: instances.length,
      authoredCount: instances.filter((entry) => entry.originKind === 'constraintDefinition').length,
      generatedCount: instances.filter((entry) => entry.originKind === 'generatedConstraint').length,
      instances,
      projections,
      manifest: null,
      bytes: null,
      audit,
    };
  }
  return {
    outcome: 'built',
    issues: audit.issues,
    moduleCount: modules.length,
    instanceCount: instances.length,
    authoredCount: instances.filter((entry) => entry.originKind === 'constraintDefinition').length,
    generatedCount: instances.filter((entry) => entry.originKind === 'generatedConstraint').length,
    instances,
    projections,
    manifest,
    bytes,
    audit,
  };
}

module.exports = {
  EXPECTATIONS_PATH,
  MANIFEST_PATH,
  buildConstraintInstanceManifest,
  dedupeContexts,
  discoverModules,
  validateExpectationRegistry,
};
