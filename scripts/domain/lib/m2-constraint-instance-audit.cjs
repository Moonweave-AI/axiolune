'use strict';

const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  verifyConstraintInstanceGateJoin,
} = require('./m2-constraint-instance-gate-join.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const EXECUTION_ROUTES_PATH =
  'scripts/domain/release-profile/v0.3.0/constraint-instance-execution-routes.json';
const ARTIFACT_DIGEST_CACHE = new WeakMap();

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactDigest(bytes) {
  let digest = ARTIFACT_DIGEST_CACHE.get(bytes);
  if (!digest) {
    digest = sha256(bytes);
    ARTIFACT_DIGEST_CACHE.set(bytes, digest);
  }
  return digest;
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function escapeLiteral(value) {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
    .replace(/\n/gu, '\\n').replace(/\r/gu, '\\r');
}

function iriTerm(value) {
  return Buffer.from(`<${value}>`, 'utf8');
}

function stringTerm(value) {
  return Buffer.from(`"${escapeLiteral(value.normalize('NFC'))}"`, 'utf8');
}

function booleanTerm(value) {
  return Buffer.from(`"${value ? 'true' : 'false'}"^^<${XSD_BOOLEAN}>`, 'utf8');
}

function constraintInstanceId(entry) {
  const pathPresent = Object.hasOwn(entry, 'pathKind') || Object.hasOwn(entry, 'path');
  const components = [
    ['originKind', stringTerm(entry.originKind)],
    ['originRef', iriTerm(entry.originRef)],
    ['targetRef', iriTerm(entry.targetRef)],
    ['pathPresent', booleanTerm(pathPresent)],
  ];
  if (pathPresent) {
    components.push(
      ['pathKind', stringTerm(entry.pathKind)],
      ['path', entry.pathKind === 'iri' ? iriTerm(entry.path) : stringTerm(entry.path)],
    );
  }
  components.push(['component', iriTerm(entry.component)]);
  const chunks = [
    Buffer.from('axiolune-constraint-instance-id-v1\0', 'utf8'),
    u64be(components.length),
  ];
  for (const [name, term] of components) {
    const nameBytes = Buffer.from(name.normalize('NFC'), 'utf8');
    chunks.push(u64be(nameBytes.length), nameBytes, u64be(term.length), term);
  }
  return crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...expected].sort());
}

function isAbsoluteNormalizedIri(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')
      || /[\u0000-\u0020<>"{}|\\^`\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
}

function isPosixRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC')
    && !/[\u0000-\u001f\u007f\\]/u.test(value) && !value.startsWith('/')
    && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function sourceModules(files) {
  return [...files.keys()]
    .filter((filePath) => /^ontology\/domain\/finance\/[^/]+\/module\.yaml$/u.test(filePath))
    .sort();
}

function discoverAuthoredConstraints(files, issues) {
  const constraints = [];
  for (const filePath of sourceModules(files)) {
    try {
      const document = yaml.load(files.get(filePath).toString('utf8'), {
        schema: yaml.CORE_SCHEMA.withTags(yaml.mergeTag),
      });
      for (const value of Object.values(document?.domain?.constraints || {})) {
        if (typeof value?.iri === 'string') {
          constraints.push({
            constraintIri: value.iri,
            targetRef: typeof value.targetElement === 'string' ? value.targetElement : null,
            language: value.expression?.language || null,
            sourcePath: filePath,
          });
        }
      }
    } catch (cause) {
      issues.push({ code: 'M2_CONSTRAINT_INSTANCE_SOURCE_PARSE', path: filePath, message: cause.message });
    }
  }
  constraints.sort((left, right) => Buffer.compare(
    Buffer.from(left.constraintIri),
    Buffer.from(right.constraintIri),
  ));
  return constraints;
}

function discoverConstraintBindings(files, issues) {
  const bindings = [];
  for (const filePath of sourceModules(files)) {
    try {
      const document = yaml.load(files.get(filePath).toString('utf8'), {
        schema: yaml.CORE_SCHEMA.withTags(yaml.mergeTag),
      });
      for (const [index, value] of (document?.domain?.constraintBindings || []).entries()) {
        if (!isAbsoluteNormalizedIri(value?.constraintRef)
            || !isAbsoluteNormalizedIri(value?.targetElement)) {
          issues.push({
            code: 'M2_CONSTRAINT_BINDING_CONTEXT_SCHEMA',
            path: `${filePath}/domain/constraintBindings/${index}`,
            message: 'constraintRef and targetElement must be absolute normalized IRIs',
          });
          continue;
        }
        bindings.push({
          originRef: value.constraintRef,
          targetRef: value.targetElement,
          sourcePath: filePath,
          sourceIndex: index,
        });
      }
    } catch (cause) {
      issues.push({ code: 'M2_CONSTRAINT_BINDING_SOURCE_PARSE', path: filePath, message: cause.message });
    }
  }
  bindings.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.originRef}\0${left.targetRef}`),
    Buffer.from(`${right.originRef}\0${right.targetRef}`),
  ));
  for (let index = 1; index < bindings.length; index += 1) {
    const previous = bindings[index - 1];
    const current = bindings[index];
    if (previous.originRef === current.originRef && previous.targetRef === current.targetRef) {
      issues.push({
        code: 'M2_CONSTRAINT_BINDING_CONTEXT_DUPLICATE',
        path: `${current.sourcePath}/domain/constraintBindings/${current.sourceIndex}`,
        message: `duplicate binding context ${current.originRef} -> ${current.targetRef}`,
      });
    }
  }
  return bindings;
}

function discoverDomainShaclRoutes(files, issues = []) {
  const bytes = files.get(EXECUTION_ROUTES_PATH);
  if (!bytes) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_EXECUTION_ROUTES_MISSING',
      path: EXECUTION_ROUTES_PATH,
      message: 'the P1 source tree lacks the closed SHACL/Custom constraint-instance route manifest',
      kind: 'missing',
    });
    return [];
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
      throw new Error('route manifest is not exact UTF-8 RFC 8785 JCS');
    }
  } catch (cause) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_EXECUTION_ROUTES_JCS',
      path: EXECUTION_ROUTES_PATH,
      message: cause.message,
    });
    return [];
  }
  if (!exactKeys(value, ['schemaVersion', 'profileRef', 'executors', 'modules'])
      || value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF
      || !exactKeys(value.executors, ['SHACL', 'Custom'])
      || !Array.isArray(value.modules)) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_EXECUTION_ROUTES_SCHEMA',
      path: EXECUTION_ROUTES_PATH,
      message: 'route manifest differs from the closed dual-executor v1 schema',
    });
    return [];
  }
  const executorFields = {
    SHACL: ['entrypointRef', 'entrypointDigest'],
    Custom: ['entrypointRef', 'entrypointDigest', 'registryRef', 'registryDigest'],
  };
  for (const kind of ['SHACL', 'Custom']) {
    const executor = value.executors[kind];
    if (!exactKeys(executor, executorFields[kind])) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXECUTION_ROUTE_EXECUTOR',
        path: `${EXECUTION_ROUTES_PATH}/executors/${kind}`,
        message: `${kind} executor binding differs from its closed schema`,
      });
      continue;
    }
    resolveSourceArtifact(
      files, executor.entrypointRef, executor.entrypointDigest,
      `${kind} constraint-instance executor`, issues,
    );
    if (kind === 'Custom') {
      resolveSourceArtifact(
        files, executor.registryRef, executor.registryDigest,
        'Custom constraint-instance registry', issues,
      );
    }
  }
  const routed = [];
  let previous = null;
  for (const [index, route] of value.modules.entries()) {
    const at = `${EXECUTION_ROUTES_PATH}/modules/${index}`;
    if (!exactKeys(route, [
      'moduleName', 'moduleRef', 'moduleDigest', 'executionKinds',
    ]) || typeof route.moduleName !== 'string'
        || !Array.isArray(route.executionKinds)
        || canonicalJcs(route.executionKinds) !== canonicalJcs(['Custom', 'SHACL'])) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXECUTION_ROUTE_MODULE',
        path: at,
        message: 'each finance module must bind both Custom and SHACL execution routes',
      });
      continue;
    }
    if (previous !== null
        && Buffer.compare(Buffer.from(previous), Buffer.from(route.moduleName)) >= 0) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXECUTION_ROUTE_ORDER',
        path: at,
        message: 'constraint-instance module routes must be moduleName-sorted and unique',
      });
    }
    previous = route.moduleName;
    const expectedPath = `ontology/domain/finance/${route.moduleName}/module.yaml`;
    if (route.moduleRef?.path !== expectedPath) {
      issues.push({
        code: 'M2_CONSTRAINT_INSTANCE_EXECUTION_ROUTE_MODULE_REF',
        path: at,
        message: `module route must bind ${expectedPath}`,
      });
    }
    resolveSourceArtifact(files, route.moduleRef, route.moduleDigest, `${route.moduleName} module`, issues);
    routed.push(route.moduleName);
  }
  return routed.sort();
}

function resolveSourceArtifact(files, reference, digest, label, issues) {
  if (!reference || reference.kind !== 'path' || reference.root !== 'sourceTree'
      || typeof reference.path !== 'string') {
    issues.push({ code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_REF', path: label, message: `${label} must resolve inside the P1 source tree` });
    return null;
  }
  const bytes = files.get(reference.path);
  if (!bytes) {
    issues.push({ code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_MISSING', path: reference.path, message: `${label} artifact is missing`, kind: 'missing' });
    return null;
  }
  if (artifactDigest(bytes) !== digest) {
    issues.push({ code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_DIGEST', path: reference.path, message: `${label} digest differs from Git blob bytes` });
    return null;
  }
  return bytes;
}

function validateExpectation(value, expectedResult, files, label, issues) {
  if (!exactKeys(value, [
    'fixtureId', 'artifactRef', 'artifactDigest', 'schemaRef', 'schemaDigest',
    'expectedResult',
  ]) || typeof value.fixtureId !== 'string' || !/^[\x21-\x7e]+$/u.test(value.fixtureId)
      || value.expectedResult !== expectedResult
      || !/^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest)
      || !/^sha256:[0-9a-f]{64}$/u.test(value.schemaDigest)) {
    issues.push({ code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_SCHEMA', path: label, message: `${label} differs from the closed ${expectedResult} expectation schema` });
    return false;
  }
  resolveSourceArtifact(files, value.artifactRef, value.artifactDigest, `${label} fixture`, issues);
  resolveSourceArtifact(files, value.schemaRef, value.schemaDigest, `${label} schema`, issues);
  return true;
}

function contextKey(value) {
  const pathPresent = Object.hasOwn(value || {}, 'pathKind') || Object.hasOwn(value || {}, 'path');
  return [
    value?.originKind || '',
    value?.originRef || '',
    value?.targetRef || '',
    pathPresent ? '1' : '0',
    pathPresent ? value?.pathKind || '' : '',
    pathPresent ? value?.path || '' : '',
    value?.component || '',
  ].join('\0');
}

function bindingContextKey(originRef, targetRef) {
  return `${originRef}\0${targetRef}`;
}

function compareContextInventory(entries, expectedEntries, manifestPath, issues) {
  if (!Array.isArray(expectedEntries) || expectedEntries.length === 0) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_CONTEXTUAL_IR_REPLAY_REQUIRED',
      path: manifestPath,
      message: 'the complete authored/generated target/path/component inventory must be independently regenerated from normalized IR before manifest closure can pass',
      kind: 'unverified',
    });
    return false;
  }
  const expectedKeys = expectedEntries.map(contextKey).sort();
  const actualKeys = entries.map(contextKey).sort();
  if (canonicalJcs(actualKeys) !== canonicalJcs(expectedKeys)) {
    const actual = new Set(actualKeys);
    const expected = new Set(expectedKeys);
    const missing = expectedKeys.filter((key) => !actual.has(key));
    const extra = actualKeys.filter((key) => !expected.has(key));
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_CONTEXT_INVENTORY_MISMATCH',
      path: manifestPath,
      message: `manifest context inventory differs from normalized IR replay: missing=${missing.length}, extra=${extra.length}`,
    });
    return false;
  }
  return true;
}

function validateManifest(
  manifest,
  manifestPath,
  files,
  authored,
  bindings,
  replayedContextInventory,
  issues,
) {
  if (!exactKeys(manifest, ['schemaVersion', 'profileRef', 'entries'])
      || manifest.schemaVersion !== '1.0'
      || manifest.profileRef !== PROFILE_REF
      || !Array.isArray(manifest.entries)
      || manifest.entries.length === 0) {
    issues.push({ code: 'M2_CONSTRAINT_INSTANCE_MANIFEST_SCHEMA', path: manifestPath, message: 'constraint-instance manifest differs from its closed v0.3 schema' });
    return {
      entryCount: 0,
      authoredOriginMissing: authored.map((row) => row.constraintIri),
      authoredBindingMissing: bindings,
    };
  }
  let previous = null;
  const authoredOrigins = new Set();
  const authoredBindingContexts = new Set();
  let generatedCount = 0;
  const validEntries = [];
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    const base = [
      'constraintInstanceId', 'originKind', 'originRef', 'targetRef', 'component',
      'severity', 'generatedOrAuthored', 'positiveExpectation', 'negativeExpectation',
    ];
    const pathPresent = Object.hasOwn(entry || {}, 'pathKind') || Object.hasOwn(entry || {}, 'path');
    if (pathPresent) base.push('pathKind', 'path');
    if (!exactKeys(entry, base)
        || !/^[0-9a-f]{64}$/u.test(entry.constraintInstanceId)
        || !['constraintDefinition', 'generatedConstraint'].includes(entry.originKind)
        || !['violation', 'warning', 'info'].includes(entry.severity)
        || !['generated', 'authored'].includes(entry.generatedOrAuthored)
        || (entry.originKind === 'constraintDefinition') !== (entry.generatedOrAuthored === 'authored')
        || !isAbsoluteNormalizedIri(entry.originRef)
        || !isAbsoluteNormalizedIri(entry.targetRef)
        || !isAbsoluteNormalizedIri(entry.component)
        || (pathPresent && (!['iri', 'posixPath'].includes(entry.pathKind)
          || (entry.pathKind === 'iri' && !isAbsoluteNormalizedIri(entry.path))
          || (entry.pathKind === 'posixPath' && !isPosixRelativePath(entry.path))))) {
      issues.push({ code: 'M2_CONSTRAINT_INSTANCE_ENTRY_SCHEMA', path: `${manifestPath}/entries/${index}`, message: 'constraint instance entry violates its closed union' });
      continue;
    }
    if (previous !== null
        && Buffer.compare(Buffer.from(previous), Buffer.from(entry.constraintInstanceId)) >= 0) {
      issues.push({ code: 'M2_CONSTRAINT_INSTANCE_ORDER', path: `${manifestPath}/entries/${index}`, message: 'constraint instances are not ID-sorted and unique' });
    }
    previous = entry.constraintInstanceId;
    const recomputedId = constraintInstanceId(entry);
    if (entry.constraintInstanceId !== recomputedId) {
      issues.push({ code: 'M2_CONSTRAINT_INSTANCE_ID', path: `${manifestPath}/entries/${index}/constraintInstanceId`, message: `declared ${entry.constraintInstanceId}; recomputed ${recomputedId}` });
    }
    validEntries.push(entry);
    if (entry.originKind === 'constraintDefinition') {
      authoredOrigins.add(entry.originRef);
      authoredBindingContexts.add(bindingContextKey(entry.originRef, entry.targetRef));
      if (Object.hasOwn(entry, 'path')) {
        authoredBindingContexts.add(bindingContextKey(entry.originRef, entry.path));
      }
    }
    else generatedCount += 1;
    const positiveValid = validateExpectation(
      entry.positiveExpectation,
      'conforms',
      files,
      `${entry.constraintInstanceId}/positive`,
      issues,
    );
    const negativeValid = validateExpectation(
      entry.negativeExpectation,
      'violates',
      files,
      `${entry.constraintInstanceId}/negative`,
      issues,
    );
    if (positiveValid && negativeValid
        && (canonicalJcs(entry.positiveExpectation.artifactRef)
          === canonicalJcs(entry.negativeExpectation.artifactRef)
          || entry.positiveExpectation.artifactDigest === entry.negativeExpectation.artifactDigest
          || entry.positiveExpectation.fixtureId === entry.negativeExpectation.fixtureId)) {
      issues.push({ code: 'M2_CONSTRAINT_INSTANCE_EXPECTATION_REUSE', path: entry.constraintInstanceId, message: 'positive and negative expectations reuse one fixture ID or artifact ref/digest' });
    }
  }
  const authoredOriginMissing = authored
    .filter((row) => !authoredOrigins.has(row.constraintIri))
    .map((row) => row.constraintIri);
  for (const iri of authoredOriginMissing) {
    issues.push({ code: 'M2_CONSTRAINT_INSTANCE_AUTHORED_MISSING', path: iri, message: `authored ConstraintDefinition ${iri} has no constraint instance` , kind: 'missing' });
  }
  const authoredBindingMissing = bindings.filter((binding) => !authoredBindingContexts.has(
    bindingContextKey(binding.originRef, binding.targetRef),
  ));
  for (const binding of authoredBindingMissing) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_BINDING_CONTEXT_MISSING',
      path: `${binding.originRef} -> ${binding.targetRef}`,
      message: 'one authored ConstraintBinding target context has no constraint instance',
      kind: 'missing',
    });
  }
  const contextualReplayVerified = compareContextInventory(
    validEntries,
    replayedContextInventory,
    manifestPath,
    issues,
  );
  if (generatedCount === 0) {
    issues.push({ code: 'M2_CONSTRAINT_INSTANCE_GENERATED_MISSING', path: manifestPath, message: 'manifest contains no compiler-generated constraint instances', kind: 'missing' });
  } else if (!contextualReplayVerified) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_GENERATED_DISCOVERY_REPLAY_REQUIRED',
      path: manifestPath,
      message: 'compiler-generated cardinality/datatype/class/node-kind/closed-shape/role/relation/reference/pattern/cross-field/PIT inventory must be independently regenerated from normalized IR',
      kind: 'unverified',
    });
  }
  return {
    entryCount: manifest.entries.length,
    authoredOriginMissing,
    authoredBindingMissing,
    generatedCount,
    contextualReplayVerified,
  };
}

function auditConstraintInstanceClosure(options) {
  const files = options.files instanceof Map ? options.files : new Map();
  const issues = [];
  const modules = sourceModules(files);
  const authored = discoverAuthoredConstraints(files, issues);
  const bindings = discoverConstraintBindings(files, issues);
  const bindingContexts = new Set(bindings.map((binding) => (
    bindingContextKey(binding.originRef, binding.targetRef)
  )));
  const boundOrigins = new Set(bindings.map((binding) => binding.originRef));
  const unboundAuthoredDefinitions = authored.filter((constraint) => (
    constraint.targetRef
      ? !bindingContexts.has(bindingContextKey(constraint.constraintIri, constraint.targetRef))
      : !boundOrigins.has(constraint.constraintIri)
  ));
  for (const constraint of unboundAuthoredDefinitions) {
    issues.push({
      code: 'M2_CONSTRAINT_DEFINITION_UNBOUND',
      path: constraint.constraintIri,
      message: `${constraint.language || 'unknown'} ConstraintDefinition has no exact top-level ConstraintBinding for ${constraint.targetRef || 'a target'}`,
    });
  }
  const expectedAuthoredContexts = [...bindings];
  for (const constraint of unboundAuthoredDefinitions) {
    if (constraint.targetRef) {
      expectedAuthoredContexts.push({
        originRef: constraint.constraintIri,
        targetRef: constraint.targetRef,
        sourcePath: constraint.sourcePath,
        sourceIndex: null,
        impliedByDefinitionOnly: true,
      });
    }
  }
  expectedAuthoredContexts.sort((left, right) => Buffer.compare(
    Buffer.from(bindingContextKey(left.originRef, left.targetRef)),
    Buffer.from(bindingContextKey(right.originRef, right.targetRef)),
  ));
  const routedModules = discoverDomainShaclRoutes(files, issues);
  const moduleNames = modules.map((filePath) => filePath.split('/')[3]).sort();
  const missingRoutedModules = moduleNames.filter((name) => !routedModules.includes(name));
  if (routedModules.length !== moduleNames.length || missingRoutedModules.length > 0) {
    issues.push({
      code: 'M2_SHACL_MODULE_ROUTING_INCOMPLETE',
      path: 'scripts/domain/run-domain-shacl.cjs',
      message: `release shacl-execution routes ${routedModules.length}/${moduleNames.length} modules; missing ${missingRoutedModules.join(',') || 'none'}`,
    });
  }
  const manifestPaths = [...files.keys()]
    .filter((filePath) => /(^|\/)constraint-instance-manifest\.json$/u.test(filePath))
    .sort();
  let manifestResult = {
    entryCount: 0,
    authoredOriginMissing: authored.map((row) => row.constraintIri),
    authoredBindingMissing: expectedAuthoredContexts,
    generatedCount: 0,
  };
  let manifestDigest = null;
  let manifestValue = null;
  if (manifestPaths.length !== 1) {
    issues.push({
      code: manifestPaths.length === 0
        ? 'M2_CONSTRAINT_INSTANCE_MANIFEST_MISSING'
        : 'M2_CONSTRAINT_INSTANCE_MANIFEST_AMBIGUOUS',
      path: '',
      message: `P1 source tree must contain exactly one constraint-instance-manifest.json; found ${manifestPaths.length}`,
      kind: manifestPaths.length === 0 ? 'missing' : 'invalid',
    });
  } else {
    const manifestPath = manifestPaths[0];
    const bytes = files.get(manifestPath);
    try {
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!bytes.equals(Buffer.from(canonicalJcs(manifest), 'utf8'))) {
        throw new Error('manifest is not exact UTF-8 RFC 8785 JCS');
      }
      manifestResult = validateManifest(
        manifest,
        manifestPath,
        files,
        authored,
        expectedAuthoredContexts,
        options.replayedContextInventory,
        issues,
      );
      manifestValue = manifest;
      manifestDigest = taggedJcsDigest(
        'axiolune-constraint-instance-manifest-v1\0',
        manifest,
      );
    } catch (cause) {
      issues.push({ code: 'M2_CONSTRAINT_INSTANCE_MANIFEST_JCS', path: manifestPath, message: cause.message });
    }
  }
  let gateJoin = null;
  if (manifestValue !== null && options.gateJoin) {
    try {
      gateJoin = verifyConstraintInstanceGateJoin({
        manifest: manifestValue,
        discovery: options.gateJoin.discovery,
        subjectInventory: options.gateJoin.subjectInventory,
        report: options.gateJoin.report,
      });
      for (const issue of gateJoin.issues) issues.push(issue);
    } catch (cause) {
      gateJoin = {
        outcome: 'invalid',
        issues: [{
          code: 'M2_SHACL_INSTANCE_JOIN_REPLAY',
          path: manifestPaths[0],
          message: cause.message,
        }],
        itemCount: 0,
        checkCount: 0,
      };
      issues.push(...gateJoin.issues);
    }
  } else if (manifestValue !== null) {
    issues.push({
      code: 'M2_SHACL_EXECUTION_INSTANCE_JOIN_REQUIRED',
      path: manifestPaths[0],
      message: 'shacl-execution discovery IDs, GateCheck IDs, fixtures, schemas, and exact expected violations must be replayed and joined to every manifest entry',
      kind: 'unverified',
    });
  }
  return {
    outcome: issues.some((issue) => (issue.kind || 'invalid') === 'invalid')
      ? 'invalid' : issues.length > 0 ? 'incomplete' : 'passed',
    issues,
    moduleCount: modules.length,
    authoredConstraintCount: authored.length,
    authoredBindingCount: bindings.length,
    authoredContextLowerBound: expectedAuthoredContexts.length,
    unboundAuthoredDefinitions: unboundAuthoredDefinitions.map((constraint) => ({
      constraintIri: constraint.constraintIri,
      targetRef: constraint.targetRef,
      language: constraint.language,
      sourcePath: constraint.sourcePath,
    })),
    routedModules,
    missingRoutedModules,
    manifestPath: manifestPaths.length === 1 ? manifestPaths[0] : null,
    manifestDigest,
    gateJoin,
    // Compatibility alias: this is definition-origin coverage only, not a
    // complete contextual constraint-instance inventory.
    authoredMissing: manifestResult.authoredOriginMissing,
    ...manifestResult,
  };
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([Buffer.from(tag, 'utf8'), Buffer.from(canonicalJcs(value), 'utf8')]));
}

module.exports = {
  PROFILE_REF,
  EXECUTION_ROUTES_PATH,
  auditConstraintInstanceClosure,
  constraintInstanceId,
  compareContextInventory,
  discoverAuthoredConstraints,
  discoverConstraintBindings,
  discoverDomainShaclRoutes,
};
