'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { isBuiltin } = require('node:module');
const path = require('node:path');
const { isDeepStrictEqual, TextDecoder } = require('node:util');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  parseDecimalLexical,
} = require('./decimal-lexical.cjs');
const {
  compareUtcInstantLexical,
  durationNanosecondsToDecimalSeconds,
  isUtcInstantLexical,
  utcInstantDifferenceNanoseconds,
} = require('./instant-lexical.cjs');
const CALCULATION_RUN_SCHEMA = require('./market-data-calculation-run-v1.schema.json');
const {
  extractJsonPointerJcsBytes,
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');
const {
  extractWholeFileBytes,
} = require('./whole-file-source-extractor.cjs');

const DEFAULT_REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/u;
const ARTIFACT_TYPE_BASE =
  'https://axiolune.ai/ontology/finance/market-data/artifact-types/';
const CAPABILITY_BASE =
  'https://axiolune.ai/ontology/finance/market-data/capabilities/';
const BINDING_FIELDS = Object.freeze(['artifactDigest', 'artifactIri', 'artifactRef']);
const IMPLEMENTATION_ROLES = new Set([
  'dependency',
  'entrypoint',
  'releaseVerifier',
  'runtimeData',
]);
const PROVENANCE_FIELDS = Object.freeze([
  'sourceArtifactDigest',
  'sourceArtifactRef',
  'sourceLocator',
]);
const CALCULATION_INPUT_SET_DOMAIN = 'axiolune-market-data-calculation-input-fact-set-v1\0';
const CALCULATION_CLOSURE_SET_DOMAIN =
  'axiolune-market-data-calculation-closure-assertion-set-v1\0';
const IMPLEMENTATION_CLOSURE_DOMAIN =
  'axiolune-market-data-implementation-closure-v1\0';
const CALCULATION_RUN_SCHEMA_FILE = require.resolve('./market-data-calculation-run-v1.schema.json');
const CALCULATION_RUN_SCHEMA_DIGEST = sha256(fs.readFileSync(CALCULATION_RUN_SCHEMA_FILE));
const CALCULATION_ARITHMETIC_POLICY = Object.freeze({
  input: 'exact-base-10-decimal',
  intermediate: 'exact-rational',
  rounding: Object.freeze({
    mode: 'half-even',
    scale: 2,
    stage: 'final-output-only',
  }),
});
const CALCULATION_RECALCULATION_POLICY = Object.freeze({
  invalidatedBy: Object.freeze([
    'calculation-definition-digest-change',
    'selected-input-fact-version-set-change',
    'selected-input-fact-payload-change',
    'selection-window-or-condition-change',
    'pit-selection-or-closure-assertion-set-change',
  ]),
  outputMutationPolicy: 'append-new-revision',
  overwriteAllowed: false,
  recalculationRequiredWhenInvalidated: true,
});

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validIri(value) {
  return typeof value === 'string'
    && IRI_RE.test(value)
    && value === value.normalize('NFC');
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function isSyntheticDigest(value) {
  if (!DIGEST_RE.test(value || '')) return true;
  const hex = value.slice('sha256:'.length);
  return /^([0-9a-f])\1{63}$/u.test(hex) || /^([0-9a-f]{2})\1{31}$/u.test(hex);
}

function finding(code, at, message) {
  return { code, at, message };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function createRepositoryReader(repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  const root = path.resolve(repositoryRoot);
  const byteCache = new Map();

  function resolveArtifactRef(ref, at) {
    const validation = validateArtifactRef(ref, at);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    if (ref.kind !== 'path' || ref.root !== 'sourceTree') {
      throw new Error(`${at}: release byte verification requires a sourceTree path ArtifactRef`);
    }
    const candidate = path.resolve(root, ...ref.path.split('/'));
    if (!inside(root, candidate)) throw new Error(`${at}: artifact escapes sourceTree`);
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch (error) {
      throw new Error(`${at}: artifact cannot be read: ${error.message}`);
    }
    const realRoot = fs.realpathSync(root);
    if (!inside(realRoot, real)) throw new Error(`${at}: artifact symlink escapes sourceTree`);
    if (!fs.statSync(real).isFile()) throw new Error(`${at}: artifact is not a regular file`);
    return real;
  }

  function readArtifact(ref, at) {
    const file = resolveArtifactRef(ref, at);
    if (!byteCache.has(file)) byteCache.set(file, fs.readFileSync(file));
    return { file, bytes: byteCache.get(file) };
  }

  function readLocatorPath(locator, at) {
    const ref = { kind: 'path', root: 'sourceTree', path: locator.path };
    return readArtifact(ref, `${at}.path`);
  }

  return { readArtifact, readLocatorPath, root };
}

function parseStrictJsonBytes(bytes, at) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${at}: invalid UTF-8: ${error.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${at}: UTF-8 BOM is forbidden`);
  try {
    return parseJsonRejectingDuplicateMembers(text);
  } catch (error) {
    throw new Error(`${at}: invalid or ambiguous JSON: ${error.message}`);
  }
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).sort().join('\0') === expected.slice().sort().join('\0');
}

function verifyProfileImplementation(reader, profile, at) {
  if (isSyntheticDigest(profile.implementationDigest)) {
    throw new Error(`${at}.implementationDigest: synthetic or invalid digest is not executable evidence`);
  }
  const errors = validateByteArtifact(
    reader,
    profile.implementationRef,
    profile.implementationDigest,
    `${at}.implementation`,
  );
  if (errors.length > 0) throw new Error(errors.join('; '));
}

function parseLockedProfile(reader, locator, at) {
  if (isSyntheticDigest(locator?.extractorProfileDigest)) {
    throw new Error(`${at}.extractorProfileDigest: synthetic or invalid digest is not release evidence`);
  }
  const { bytes } = reader.readArtifact(locator.extractorProfileRef, `${at}.extractorProfileRef`);
  const actual = sha256(bytes);
  if (actual !== locator.extractorProfileDigest) {
    throw new Error(`${at}.extractorProfileDigest: expected ${actual}, found ${String(locator.extractorProfileDigest)}`);
  }
  const profile = parseStrictJsonBytes(bytes, `${at}.extractorProfileRef`);
  if (locator.kind === 'wholeFile') {
    const expectedKeys = [
      'algorithm',
      'domainTag',
      'encoding',
      'extractorStatus',
      'implementationDigest',
      'implementationRef',
      'inputMediaTypes',
      'networkAccess',
      'schemaVersion',
      'selectionCardinality',
    ];
    if (!exactKeys(profile, expectedKeys)
        || profile.algorithm !== 'identity-raw-bytes'
        || profile.domainTag !== 'axiolune-source-selection-v1\0'
        || profile.encoding !== 'raw-bytes'
        || profile.extractorStatus !== 'executable'
        || profile.networkAccess !== false
        || profile.schemaVersion !== '1.0'
        || profile.selectionCardinality !== 'exactly-one-non-empty-byte-sequence'
        || !Array.isArray(profile.inputMediaTypes)
        || !profile.inputMediaTypes.includes(locator.mediaType)) {
      throw new Error(`${at}.extractorProfileRef: profile does not lock executable wholeFile/raw-bytes extraction for ${locator.mediaType}`);
    }
  } else if (locator.kind === 'jsonPointer') {
    const expectedKeys = [
      'algorithm',
      'dependencies',
      'domainTag',
      'duplicateMemberPolicy',
      'encoding',
      'extractorStatus',
      'implementationDigest',
      'implementationRef',
      'networkAccess',
      'numberProfile',
      'pointerProfile',
      'schemaVersion',
      'selectionCardinality',
      'unicodePolicy',
    ];
    if (!exactKeys(profile, expectedKeys)
        || profile.algorithm !== 'rfc6901-select-then-jcs'
        || !Array.isArray(profile.dependencies)
        || profile.dependencies.length !== 1
        || profile.domainTag !== 'axiolune-source-selection-v1\0'
        || profile.duplicateMemberPolicy !== 'reject-decoded-name-duplicates-at-any-depth'
        || profile.encoding !== 'utf-8-fatal-no-bom'
        || profile.extractorStatus !== 'executable'
        || profile.networkAccess !== false
        || profile.numberProfile !== 'selected-value-must-satisfy-axiolune-safe-integer-jcs'
        || profile.pointerProfile !== 'canonical-rfc6901-string-form'
        || profile.schemaVersion !== '1.0'
        || profile.selectionCardinality !== 'exactly-one-non-empty-jcs-value'
        || profile.unicodePolicy !== 'valid-utf8-unicode-scalars-nfc-in-selected-value') {
      throw new Error(`${at}.extractorProfileRef: profile does not lock the executable RFC6901/JCS extractor`);
    }
    const dependency = profile.dependencies[0];
    if (!exactKeys(dependency, ['dependencyDigest', 'dependencyRef', 'role'])
        || dependency.role !== 'canonical-jcs-and-selection-digest'
        || isSyntheticDigest(dependency.dependencyDigest)) {
      throw new Error(`${at}.extractorProfileRef.dependencies: expected one closed canonical JCS/selection-digest dependency lock`);
    }
    const dependencyErrors = validateByteArtifact(
      reader,
      dependency.dependencyRef,
      dependency.dependencyDigest,
      `${at}.extractorProfileRef.dependencies[0]`,
    );
    if (dependencyErrors.length > 0) throw new Error(dependencyErrors.join('; '));
  } else {
    throw new Error(`${at}.kind: Market Data release evidence does not implement ${String(locator.kind)}`);
  }
  verifyProfileImplementation(reader, profile, `${at}.extractorProfileRef`);
  return profile;
}

function selectBytes(reader, locator, at) {
  parseLockedProfile(reader, locator, at);
  const { bytes } = reader.readLocatorPath(locator, at);
  if (locator.kind === 'wholeFile') return extractWholeFileBytes(bytes);
  if (locator.kind === 'jsonPointer') return extractJsonPointerJcsBytes(bytes, locator.pointer);
  throw new Error(`${at}.kind: Market Data release evidence does not implement ${String(locator.kind)}`);
}

function validateLocator(reader, locator, at, expectedArtifactRef) {
  const errors = [];
  const shape = validateSourceLocator(locator, { at });
  if (!shape.ok) return shape.errors;
  if (isSyntheticDigest(locator.selectionDigest)) {
    errors.push(`${at}.selectionDigest: synthetic digest is not release evidence`);
  }
  if (expectedArtifactRef?.kind === 'path'
      && (expectedArtifactRef.root !== 'sourceTree' || expectedArtifactRef.path !== locator.path)) {
    errors.push(`${at}.path: locator does not select from its sourceArtifactRef`);
  }
  let selectedBytes;
  try {
    selectedBytes = selectBytes(reader, locator, at);
    if (selectedBytes.length === 0) errors.push(`${at}: selected byte sequence is empty`);
  } catch (error) {
    errors.push(error.message);
  }
  if (selectedBytes) {
    errors.push(...validateSourceLocator(locator, { at, selectedBytes }).errors);
  }
  return errors;
}

function validateByteArtifact(reader, artifactRef, artifactDigest, at) {
  const errors = [];
  if (isSyntheticDigest(artifactDigest)) {
    errors.push(`${at}.artifactDigest: synthetic or invalid digest is not release evidence`);
    return errors;
  }
  try {
    const { bytes } = reader.readArtifact(artifactRef, `${at}.artifactRef`);
    const actual = sha256(bytes);
    if (actual !== artifactDigest) {
      errors.push(`${at}.artifactDigest: expected ${actual}, found ${String(artifactDigest)}`);
    }
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

function buildArtifactBindings(scenario, reader) {
  const violations = [];
  const bindings = new Map();
  const rows = Array.isArray(scenario?.artifactBindings) ? scenario.artifactBindings : [];
  if (rows.length === 0) {
    violations.push(finding('RELEASE_ARTIFACT_BINDING', 'artifactBindings', 'at least one byte-verifiable artifact binding is required'));
    return { bindings, violations };
  }
  rows.forEach((binding, index) => {
    const at = `artifactBindings[${index}]`;
    if (!isPlainObject(binding)
        || Object.keys(binding).sort().join('\0') !== BINDING_FIELDS.join('\0')) {
      violations.push(finding('RELEASE_ARTIFACT_BINDING', at, 'binding must be a closed artifactDigest/artifactIri/artifactRef object'));
      return;
    }
    const usableIri = validIri(binding.artifactIri) && !bindings.has(binding.artifactIri);
    if (!validIri(binding.artifactIri)) {
      violations.push(finding('RELEASE_ARTIFACT_BINDING', `${at}.artifactIri`, 'absolute artifact IRI is required'));
    } else if (bindings.has(binding.artifactIri)) {
      violations.push(finding('RELEASE_ARTIFACT_BINDING', `${at}.artifactIri`, 'artifact IRI binding is duplicated'));
    }
    const digestErrors = validateByteArtifact(reader, binding.artifactRef, binding.artifactDigest, at);
    for (const error of digestErrors) {
      violations.push(finding('RELEASE_ARTIFACT_DIGEST', at, error));
    }
    if (!usableIri) return;
    let document;
    try {
      const { bytes } = reader.readArtifact(binding.artifactRef, `${at}.artifactRef`);
      document = parseStrictJsonBytes(bytes, `${at}.artifactRef`);
      const identityFields = [
        'sourceContractIri',
        'transformationIri',
        'calculationDefinitionIri',
        'calculationRunIri',
        'materializationRunIri',
        'testContextIri',
      ].filter((field) => Object.hasOwn(document, field));
      if (identityFields.length !== 1 || document[identityFields[0]] !== binding.artifactIri) {
        violations.push(finding(
          'RELEASE_ARTIFACT_CONTENT',
          at,
          `artifact bytes must declare exactly their bound identity ${binding.artifactIri}`,
        ));
      }
    } catch (error) {
      violations.push(finding('RELEASE_ARTIFACT_CONTENT', at, error.message));
    }
    bindings.set(binding.artifactIri, { ...binding, document });
  });
  return { bindings, violations };
}

function implementationClosureDigest(artifacts) {
  return sha256(Buffer.concat([
    Buffer.from(IMPLEMENTATION_CLOSURE_DOMAIN, 'utf8'),
    Buffer.from(canonicalJcs(artifacts), 'utf8'),
  ]));
}

function decodeImplementationSource(bytes, at) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${at}: invalid UTF-8: ${error.message}`);
  }
  if (source.charCodeAt(0) === 0xfeff) throw new Error(`${at}: UTF-8 BOM is forbidden`);
  return source;
}

function staticRequires(source, at) {
  const token = 'req' + 'uire';
  const occurrences = [...source.matchAll(new RegExp(`\\b${token}\\b`, 'gu'))];
  const calls = [...source.matchAll(new RegExp(
    `\\b${token}\\s*\\(\\s*(['"])([^'"\\\\\\r\\n]+)\\1\\s*\\)`,
    'gu',
  ))];
  const resolutions = [...source.matchAll(new RegExp(
    `\\b${token}\\s*\\.\\s*resolve\\s*\\(\\s*(['"])([^'"\\\\\\r\\n]+)\\1\\s*\\)`,
    'gu',
  ))];
  if (occurrences.length !== calls.length + resolutions.length) {
    throw new Error(`${at}: every CommonJS dependency must use one unescaped static string literal`);
  }
  return [...calls, ...resolutions].map((match) => match[2]);
}

function validateImplementationReachability(reader, artifacts, at) {
  const errors = [];
  const artifactsByPath = new Map();
  const entrypoints = [];
  for (const artifact of artifacts) {
    if (!isPlainObject(artifact)
        || artifact?.artifactRef?.kind !== 'path'
        || artifact?.artifactRef?.root !== 'sourceTree'
        || typeof artifact?.artifactRef?.path !== 'string') {
      continue;
    }
    artifactsByPath.set(artifact.artifactRef.path, artifact);
    if (artifact.role === 'entrypoint') entrypoints.push(artifact.artifactRef.path);
  }
  if (entrypoints.length !== 1) {
    errors.push(`${at}: implementation closure requires exactly one entrypoint, found ${entrypoints.length}`);
    return errors;
  }

  const reachable = new Set();
  const queue = [entrypoints[0]];
  while (queue.length > 0) {
    const artifactPath = queue.shift();
    if (reachable.has(artifactPath)) continue;
    reachable.add(artifactPath);
    const artifact = artifactsByPath.get(artifactPath);
    if (!artifact) {
      errors.push(`${at}: reachable dependency ${artifactPath} is absent from the manifest`);
      continue;
    }
    let bytes;
    try {
      ({ bytes } = reader.readArtifact(artifact.artifactRef, `${at}(${artifactPath})`));
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (artifactPath.endsWith('.json')) {
      try {
        parseStrictJsonBytes(bytes, `${at}(${artifactPath})`);
      } catch (error) {
        errors.push(error.message);
      }
      continue;
    }
    if (!artifactPath.endsWith('.cjs')) {
      errors.push(`${at}(${artifactPath}): only .cjs and .json implementation artifacts are supported`);
      continue;
    }
    let dependencies;
    try {
      dependencies = staticRequires(
        decodeImplementationSource(bytes, `${at}(${artifactPath})`),
        `${at}(${artifactPath})`,
      );
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    for (const dependency of dependencies) {
      if (isBuiltin(dependency)) continue;
      if (!dependency.startsWith('./') && !dependency.startsWith('../')) {
        errors.push(`${at}(${artifactPath}): external dependency ${dependency} is not byte-closed`);
        continue;
      }
      if (dependency.includes('\\')) {
        errors.push(`${at}(${artifactPath}): dependency paths must use canonical '/' separators`);
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(
        path.posix.dirname(artifactPath),
        dependency,
      ));
      if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
        errors.push(`${at}(${artifactPath}): dependency ${dependency} escapes sourceTree`);
        continue;
      }
      if (!/\.(?:cjs|json)$/u.test(resolved)) {
        errors.push(`${at}(${artifactPath}): dependency ${dependency} must name its exact extension`);
        continue;
      }
      if (!artifactsByPath.has(resolved)) {
        errors.push(`${at}(${artifactPath}): reachable dependency ${resolved} is absent from the manifest`);
        continue;
      }
      queue.push(resolved);
    }
  }
  for (const artifactPath of artifactsByPath.keys()) {
    if (!reachable.has(artifactPath)) {
      errors.push(`${at}: manifest artifact ${artifactPath} is not reachable from the entrypoint`);
    }
  }
  return errors;
}

function buildMarketDataImplementationClosure(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
) {
  const root = path.resolve(repositoryRoot);
  const entrypoint = 'scripts/domain/lib/market-data-v03-contracts.cjs';
  const releaseVerifier = 'scripts/domain/lib/market-data-release-evidence.cjs';
  const implementationArtifactIri = 'urn:implementation-closure:market-data-validator-v1';
  const discovered = new Set();
  const queue = [entrypoint];

  while (queue.length > 0) {
    const artifactPath = queue.shift();
    if (discovered.has(artifactPath)) continue;
    if (path.posix.isAbsolute(artifactPath)
        || artifactPath.startsWith('../')
        || artifactPath.includes('\\')) {
      throw new Error(`implementation artifact escapes sourceTree: ${artifactPath}`);
    }
    const absolute = path.join(root, ...artifactPath.split('/'));
    const relative = path.relative(root, absolute);
    if (relative === ''
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
      throw new Error(`implementation artifact escapes sourceTree: ${artifactPath}`);
    }
    const bytes = fs.readFileSync(absolute);
    discovered.add(artifactPath);
    if (artifactPath.endsWith('.json')) {
      parseStrictJsonBytes(bytes, artifactPath);
      continue;
    }
    if (!artifactPath.endsWith('.cjs')) {
      throw new Error(`unsupported implementation artifact: ${artifactPath}`);
    }
    const dependencies = staticRequires(
      decodeImplementationSource(bytes, artifactPath),
      artifactPath,
    );
    for (const dependency of dependencies) {
      if (isBuiltin(dependency)) continue;
      if ((!dependency.startsWith('./') && !dependency.startsWith('../'))
          || dependency.includes('\\')) {
        throw new Error(
          `${artifactPath}: dependency ${dependency} is not a canonical sourceTree dependency`,
        );
      }
      const resolved = path.posix.normalize(path.posix.join(
        path.posix.dirname(artifactPath),
        dependency,
      ));
      if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
        throw new Error(`${artifactPath}: dependency ${dependency} escapes sourceTree`);
      }
      if (!/\.(?:cjs|json)$/u.test(resolved)) {
        throw new Error(`${artifactPath}: dependency ${dependency} must name its exact extension`);
      }
      queue.push(resolved);
    }
  }

  const artifacts = [...discovered].map((artifactPath) => {
    const artifactRef = { kind: 'path', path: artifactPath, root: 'sourceTree' };
    let role = 'dependency';
    if (artifactPath === entrypoint) role = 'entrypoint';
    else if (artifactPath === releaseVerifier) role = 'releaseVerifier';
    else if (artifactPath.endsWith('.json')) role = 'runtimeData';
    return {
      artifactDigest: sha256(fs.readFileSync(path.join(root, ...artifactPath.split('/')))),
      artifactRef,
      role,
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(canonicalJcs(left.artifactRef), 'utf8'),
    Buffer.from(canonicalJcs(right.artifactRef), 'utf8'),
  ));

  return {
    artifacts,
    closureDigest: implementationClosureDigest(artifacts),
    implementationArtifactIri,
    schemaVersion: '1.0',
  };
}

function validateImplementationClosure(reader, runDocument, at) {
  const errors = [];
  let closure;
  try {
    const { bytes } = reader.readArtifact(
      runDocument.implementationArtifactRef,
      `${at}.implementationArtifactRef`,
    );
    closure = parseStrictJsonBytes(bytes, `${at}.implementationArtifactRef`);
  } catch (error) {
    errors.push(error.message);
    return errors;
  }
  if (!isPlainObject(closure)
      || Object.keys(closure).sort().join('\0')
        !== ['artifacts', 'closureDigest', 'implementationArtifactIri', 'schemaVersion']
          .sort().join('\0')
      || closure.schemaVersion !== '1.0'
      || closure.implementationArtifactIri !== runDocument.implementationArtifactIri
      || !Array.isArray(closure.artifacts)
      || closure.artifacts.length === 0) {
    errors.push(`${at}: implementation closure is not one closed v1 manifest`);
    return errors;
  }
  let previousRef = null;
  const seenRefs = new Set();
  for (const [index, artifact] of closure.artifacts.entries()) {
    const artifactAt = `${at}.artifacts[${index}]`;
    if (!isPlainObject(artifact)
        || Object.keys(artifact).sort().join('\0')
          !== ['artifactDigest', 'artifactRef', 'role'].sort().join('\0')
        || !validateArtifactRef(artifact.artifactRef).ok
        || artifact.artifactRef.kind !== 'path'
        || artifact.artifactRef.root !== 'sourceTree'
        || !DIGEST_RE.test(artifact.artifactDigest || '')
        || !IMPLEMENTATION_ROLES.has(artifact.role)) {
      errors.push(`${artifactAt}: expected one closed sourceTree artifact lock`);
      continue;
    }
    const refKey = canonicalJcs(artifact.artifactRef);
    if (seenRefs.has(refKey) || (previousRef !== null
        && Buffer.compare(Buffer.from(previousRef), Buffer.from(refKey)) >= 0)) {
      errors.push(`${artifactAt}: artifact refs must be strictly JCS-sorted and unique`);
    }
    previousRef = refKey;
    seenRefs.add(refKey);
    errors.push(...validateByteArtifact(
      reader,
      artifact.artifactRef,
      artifact.artifactDigest,
      artifactAt,
    ));
  }
  const actualDigest = implementationClosureDigest(closure.artifacts);
  if (closure.closureDigest !== actualDigest) {
    errors.push(`${at}.closureDigest: expected ${actualDigest}`);
  }
  errors.push(...validateImplementationReachability(reader, closure.artifacts, at));
  return errors;
}

function validateGeneratingContexts(scenario, bindings, reader, violations) {
  const fixtureScope = scenario?.fixtureScope;
  if (!exactKeys(fixtureScope, ['familyId', 'kind', 'releaseEligible'])
      || typeof fixtureScope.familyId !== 'string'
      || fixtureScope.familyId.length === 0
      || fixtureScope.kind !== 'semantic-contract-fixture'
      || fixtureScope.releaseEligible !== false) {
    violations.push(finding(
      'FIXTURE_SCOPE',
      'fixtureScope',
      'Market Data contract fixtures must declare one familyId and be explicitly closed as semantic-contract-fixture and non-release-eligible',
    ));
  }
  const requiredContextRefs = new Set();
  for (const values of [
    scenario?.closures,
    scenario?.findings,
    scenario?.fxDerivations,
  ]) {
    for (const value of values || []) {
      if (typeof value?.generatingContextRef === 'string') {
        requiredContextRefs.add(value.generatingContextRef);
      }
    }
  }
  const expectedFields = [
    'artifactTypeIri',
    'capabilityIris',
    'fixtureFamilyId',
    'implementationArtifactDigest',
    'implementationArtifactIri',
    'implementationArtifactRef',
    'implementationLocator',
    'releaseEligible',
    'referenceTime',
    'scope',
    'subjectGraphRef',
    'testContextIri',
    'version',
  ].sort();
  for (const contextRef of requiredContextRefs) {
    const at = `generatingContextRef(${contextRef})`;
    const binding = bindings.get(contextRef);
    const document = binding?.document;
    const exactDocument = isPlainObject(document)
      && Object.keys(document).sort().join('\0') === expectedFields.join('\0');
    const validDocument = exactDocument
      && document.testContextIri === contextRef
      && document.artifactTypeIri === `${ARTIFACT_TYPE_BASE}SemanticFixtureContextDefinition`
      && isDeepStrictEqual(
        document.capabilityIris,
        [`${CAPABILITY_BASE}semantic-fixture-validation`],
      )
      && document.version === '1.0.0'
      && document.fixtureFamilyId === fixtureScope?.familyId
      && document.scope === 'semantic-only'
      && document.releaseEligible === false
      && validIri(document.subjectGraphRef)
      && document.subjectGraphRef === scenario?.graphRef
      && validInstant(document.referenceTime)
      && document.referenceTime === scenario?.queryPivot?.referenceTime
      && validateArtifactRef(document.implementationArtifactRef).ok
      && validIri(document.implementationArtifactIri)
      && DIGEST_RE.test(document.implementationArtifactDigest || '')
      && validateSourceLocator(document.implementationLocator).ok
      && document.implementationArtifactRef?.kind === 'path'
      && document.implementationArtifactRef?.root === 'sourceTree'
      && document.implementationArtifactRef?.path === document.implementationLocator?.path;
    if (!validDocument) {
      violations.push(finding(
        'FIXTURE_CONTEXT_RECORD',
        at,
        'semantic-only generatingContextRef must resolve exactly once to a closed non-release fixture context bound to this case, graph, and referenceTime',
      ));
      continue;
    }
    for (const error of validateByteArtifact(
      reader,
      document.implementationArtifactRef,
      document.implementationArtifactDigest,
      `${at}.implementationArtifactRef`,
    )) {
      violations.push(finding('FIXTURE_CONTEXT_IMPLEMENTATION', at, error));
    }
    for (const error of validateLocator(
      reader,
      document.implementationLocator,
      `${at}.implementationLocator`,
    )) {
      violations.push(finding('FIXTURE_CONTEXT_IMPLEMENTATION', at, error));
    }
    for (const error of validateImplementationClosure(reader, document, at)) {
      violations.push(finding('FIXTURE_CONTEXT_IMPLEMENTATION', at, error));
    }
  }
}

function validateStreamSourceContract(bindings, stream, at, violations) {
  const binding = bindings.get(stream?.sourceContractRef);
  const contract = binding?.document;
  if (!isPlainObject(contract)) return;
  const expectedKeys = [
    'artifactTypeIri',
    'capabilityIris',
    'observationIdFieldLocator',
    'providerLogicalIri',
    'providerStreamId',
    'purpose',
    'revisionMode',
    'sourceApiIdentifier',
    'sourceContractIri',
    'sourceSchemaIdentifier',
    'sourceSchemaVersion',
    'version',
  ];
  if (stream?.revisionMode === 'revisionedRecord') expectedKeys.push('sourceRevisionFieldLocator');
  const scalarFieldNamesAbsent = contract.observationIdField === undefined
    && contract.sourceRevisionField === undefined;
  const scalarFieldsMatch = contract.sourceContractIri === stream.sourceContractRef
    && contract.artifactTypeIri === `${ARTIFACT_TYPE_BASE}SourceContract`
    && isDeepStrictEqual(
      contract.capabilityIris,
      [`${CAPABILITY_BASE}source-record-contract`],
    )
    && contract.version === '1.0.0'
    && contract.providerLogicalIri === stream.providerLogicalIri
    && contract.providerStreamId === stream.providerStreamId
    && contract.sourceApiIdentifier === stream.sourceApiIdentifier
    && contract.sourceSchemaIdentifier === stream.sourceSchemaIdentifier
    && contract.sourceSchemaVersion === stream.sourceSchemaVersion
    && contract.purpose === stream.purpose
    && contract.revisionMode === stream.revisionMode;
  const locatorFieldsMatch = isDeepStrictEqual(
    contract.observationIdFieldLocator,
    stream?.mappings?.observationIdFieldLocator,
  ) && (stream?.revisionMode === 'revisionedRecord'
    ? isDeepStrictEqual(
      contract.sourceRevisionFieldLocator,
      stream?.mappings?.sourceRevisionFieldLocator,
    )
    : contract.sourceRevisionFieldLocator === undefined);
  if (!exactKeys(contract, expectedKeys)
      || !scalarFieldNamesAbsent
      || !scalarFieldsMatch
      || !locatorFieldsMatch) {
    violations.push(finding(
      'RELEASE_ARTIFACT_CONTENT',
      `${at}.sourceContractRef`,
      'source-contract bytes must exactly match stream identity, provider/schema fields, revision mode, and closed field locators',
    ));
  }
}

function validateBoundReference(
  bindings,
  artifactIri,
  artifactDigest,
  expectedType,
  expectedCapability,
  at,
  violations,
) {
  const binding = bindings.get(artifactIri);
  if (!binding) {
    violations.push(finding('RELEASE_ARTIFACT_BINDING', at, `no byte artifact binding exists for ${String(artifactIri)}`));
  } else if (binding.artifactDigest !== artifactDigest) {
    violations.push(finding('RELEASE_ARTIFACT_DIGEST', at, `semantic digest does not equal bound artifact bytes for ${artifactIri}`));
  }
  if (binding && (
    binding.document?.artifactTypeIri !== expectedType
    || !isDeepStrictEqual(binding.document?.capabilityIris, [expectedCapability])
  )) {
    violations.push(finding(
      'RELEASE_ARTIFACT_CAPABILITY',
      at,
      `artifact must have type ${expectedType} and sole capability ${expectedCapability}`,
    ));
  }
}

function isCanonicalOrderingTransformation(binding) {
  const document = binding?.document;
  return exactKeys(document, [
    'artifactTypeIri',
    'capabilityIris',
    'inputFields',
    'outputTuple',
    'requirements',
    'transformationIri',
    'version',
  ])
    && document.artifactTypeIri === `${ARTIFACT_TYPE_BASE}CanonicalOrderingTransformation`
    && isDeepStrictEqual(
      document.capabilityIris,
      [`${CAPABILITY_BASE}canonical-observation-ordering`],
    )
    && document.transformationIri === binding.artifactIri
    && document.version === '1.0.0'
    && isDeepStrictEqual(document.inputFields, [
      'observedAt',
      'sourceSequence',
      'sourceEventId',
    ])
    && isDeepStrictEqual(document.outputTuple, [
      'observedAt',
      'streamLogicalIri',
      'sourceOrderKey',
      'sourceEventId',
    ])
    && isDeepStrictEqual(document.requirements, {
      lossless: true,
      stable: true,
      sourceOrderKey: 'non-negative-safe-integer',
      tieBreak: 'sourceEventId-utf8-byte-order',
    });
}

function validateOrderingTransformation(binding, at, violations) {
  if (!isCanonicalOrderingTransformation(binding)) {
    violations.push(finding(
      'RELEASE_ARTIFACT_CONTENT',
      at,
      'canonical ordering transformation must equal its closed executable v1 contract',
    ));
  }
}

function executeCanonicalOrderingTransformation(binding, record, streamLogicalIri) {
  if (!isCanonicalOrderingTransformation(binding)) {
    throw new Error('ordering artifact is not the closed canonical ordering transformation');
  }
  if (!Number.isSafeInteger(record?.sourceSequence) || record.sourceSequence < 0) {
    throw new Error('sourceSequence must be a non-negative safe integer');
  }
  if (typeof record?.observedAt !== 'string' || record.observedAt.length === 0) {
    throw new Error('observedAt must be a non-empty string');
  }
  if (typeof record?.id !== 'string' || record.id.length === 0) {
    throw new Error('sourceEventId must be a non-empty string');
  }
  if (!validIri(streamLogicalIri)) {
    throw new Error('streamLogicalIri must be an absolute IRI');
  }
  return {
    observedAt: record.observedAt,
    streamLogicalIri,
    sourceOrderKey: record.sourceSequence,
    sourceEventId: record.id,
  };
}

function validateCalculationDefinition(binding, priceKind, at, violations) {
  const document = binding?.document;
  const contracts = {
    vwap: {
      expression: 'sum(price * quantity) / sum(quantity)',
      inputContract: {
        price: 'MonetaryAmount',
        quantity: 'QuantityValue',
        window: 'half-open-interval',
      },
      requirements: [
        'all price.currency = quotation-currency',
        'all quantity.unit = quotation-denominator-unit',
        'sum(quantity) > 0',
        'all samples are within window',
        'select exactly one three-axis-eligible FactVersion per logical identity at output pivot',
      ],
    },
    twap: {
      expression: 'sum(price * durationSeconds) / sum(durationSeconds)',
      inputContract: {
        price: 'MonetaryAmount',
        durationSeconds: 'positive-decimal',
        window: 'half-open-interval',
      },
      requirements: [
        'all price.currency = quotation-currency',
        'all durationSeconds > 0',
        'durationSeconds derived from adjacent observedAt or window.endExclusive',
        'durations partition window without gaps or overlaps',
        'sum(durationSeconds) > 0',
        'select exactly one three-axis-eligible FactVersion per logical identity at output pivot',
      ],
    },
  };
  const contract = contracts[priceKind];
  const valid = contract !== undefined && exactKeys(document, [
    'arithmetic',
    'arithmeticPolicy',
    'artifactTypeIri',
    'calculationDefinitionIri',
    'capabilityIris',
    'expression',
    'inputContract',
    'outputContract',
    'requirements',
    'version',
  ])
    && document.calculationDefinitionIri === binding.artifactIri
    && document.version === '1.0.0'
    && document.expression === contract.expression
    && document.arithmetic === 'exact-base-10-decimal'
    && isDeepStrictEqual(document.arithmeticPolicy, CALCULATION_ARITHMETIC_POLICY)
    && isDeepStrictEqual(document.inputContract, contract.inputContract)
    && isDeepStrictEqual(document.requirements, contract.requirements)
    && isDeepStrictEqual(document.outputContract, {
      value: 'MonetaryAmount',
      currency: 'quotation-currency',
    });
  if (!valid) {
    violations.push(finding(
      'RELEASE_ARTIFACT_CONTENT',
      at,
      `calculation definition does not execute the closed ${String(priceKind)} contract`,
    ));
  }
  return valid ? document.arithmeticPolicy : null;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function validInstant(value) {
  return isUtcInstantLexical(value);
}

function contextVersionIri(observation) {
  return observation?.context?.listing?.versionIri
    || observation?.context?.otc?.versionIri;
}

function decimalPower(exponent) {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 1000) {
    throw new TypeError('decimal scale must be a non-negative safe integer no greater than 1000');
  }
  return 10n ** BigInt(exponent);
}

function formatFixedDecimal(coefficient, scale) {
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const digits = absolute.toString();
  const sign = negative && absolute !== 0n ? '-' : '';
  if (scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(scale + 1, '0');
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function quantizeExactRational(numerator, denominator, policy) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    throw new TypeError('exact rational numerator and denominator must be BigInt');
  }
  if (denominator === 0n) throw new RangeError('exact rational denominator must be non-zero');
  const mode = policy?.mode;
  const scale = policy?.scale;
  if (!['floor', 'ceiling', 'half-up', 'half-even'].includes(mode)
      || !Number.isSafeInteger(scale)
      || scale < 0
      || scale > 1000) {
    throw new TypeError('rounding policy requires a supported mode and scale 0..1000');
  }
  let signedNumerator = numerator;
  let positiveDenominator = denominator;
  if (positiveDenominator < 0n) {
    signedNumerator = -signedNumerator;
    positiveDenominator = -positiveDenominator;
  }
  const negative = signedNumerator < 0n;
  const absoluteScaledNumerator = (negative ? -signedNumerator : signedNumerator)
    * decimalPower(scale);
  const truncated = absoluteScaledNumerator / positiveDenominator;
  const remainder = absoluteScaledNumerator % positiveDenominator;
  let increment = false;
  if (mode === 'floor') increment = negative && remainder !== 0n;
  else if (mode === 'ceiling') increment = !negative && remainder !== 0n;
  else {
    const doubled = remainder * 2n;
    increment = doubled > positiveDenominator
      || (doubled === positiveDenominator
        && (mode === 'half-up' || truncated % 2n !== 0n));
  }
  const roundedAbsolute = truncated + (increment ? 1n : 0n);
  return formatFixedDecimal(negative ? -roundedAbsolute : roundedAbsolute, scale);
}

function expectedReciprocalLexical(sourceValue, policy) {
  const source = parseDecimalLexical(sourceValue);
  if (source.coefficient <= 0n) {
    throw new RangeError('reciprocal source must be a positive decimal');
  }
  return quantizeExactRational(
    decimalPower(source.scale),
    source.coefficient,
    policy,
  );
}

function addDecimals(values) {
  const parsed = values.map((value) => parseDecimalLexical(value));
  const scale = parsed.reduce((maximum, value) => Math.max(maximum, value.scale), 0);
  return {
    coefficient: parsed.reduce(
      (total, value) => total + (value.coefficient * decimalPower(scale - value.scale)),
      0n,
    ),
    scale,
  };
}

function multiplyDecimals(leftValue, rightValue) {
  const left = parseDecimalLexical(leftValue);
  const right = parseDecimalLexical(rightValue);
  return {
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  };
}

function addParsedDecimals(values) {
  const scale = values.reduce((maximum, value) => Math.max(maximum, value.scale), 0);
  return {
    coefficient: values.reduce(
      (total, value) => total + (value.coefficient * decimalPower(scale - value.scale)),
      0n,
    ),
    scale,
  };
}

function quantizedWeightedMean(inputs, priceField, weightValues, arithmeticPolicy) {
  try {
    if (!Array.isArray(inputs)
        || !Array.isArray(weightValues)
        || inputs.length === 0
        || inputs.length !== weightValues.length
        || !isDeepStrictEqual(arithmeticPolicy, CALCULATION_ARITHMETIC_POLICY)) return null;
    const weights = weightValues.map((weight) => parseDecimalLexical(weight));
    if (weights.some((weight) => weight.coefficient <= 0n)) return null;
    const totalWeight = addDecimals(weightValues);
    if (totalWeight.coefficient <= 0n) return null;
    const numerator = addParsedDecimals(inputs.map((input, index) => (
      multiplyDecimals(input?.[priceField]?.amount, weightValues[index])
    )));
    return quantizeExactRational(
      numerator.coefficient * decimalPower(totalWeight.scale),
      totalWeight.coefficient * decimalPower(numerator.scale),
      arithmeticPolicy.rounding,
    );
  } catch {
    return null;
  }
}

function closureIndex(closures) {
  const index = new Map();
  for (const closure of closures || []) {
    const key = `${closure?.targetVersionIri}\0${closure?.axis}`;
    const values = index.get(key) || [];
    values.push(closure);
    index.set(key, values);
  }
  return index;
}

function uniqueClosure(index, versionIri, axis) {
  const values = index.get(`${versionIri}\0${axis}`) || [];
  return values.length === 1 ? values[0] : null;
}

function inputFactSnapshot(observation, priceKind, closuresByTargetAxis = new Map()) {
  const common = {
    axes: {
      availableFrom: observation?.axes?.availableFrom,
      availableTo: uniqueClosure(
        closuresByTargetAxis,
        observation?.versionIri,
        'availability',
      )?.closedAt ?? null,
      knowledgeFrom: observation?.axes?.knowledgeFrom,
      knowledgeTo: uniqueClosure(
        closuresByTargetAxis,
        observation?.versionIri,
        'knowledge',
      )?.closedAt ?? null,
      revision: observation?.axes?.revision,
      validFrom: observation?.axes?.validFrom,
      validTo: observation?.axes?.validTo ?? null,
    },
    contextVersionIri: contextVersionIri(observation),
    observedAt: observation?.observedAt,
    observedInstrumentVersionIri: observation?.observedInstrument?.versionIri,
    priceKind: observation?.priceKind,
    quotationVersionIri: observation?.quotation?.versionIri,
    streamVersionIri: observation?.streamVersionIri,
    type: observation?.type,
    versionIri: observation?.versionIri,
  };
  if (priceKind === 'vwap') {
    return {
      ...common,
      price: observation?.tradePrice,
      weight: observation?.tradeSize,
    };
  }
  return {
    ...common,
    price: observation?.price,
  };
}

function closureAffectsPit(closure, pitSelection) {
  if (pitSelection === null || pitSelection === undefined) return true;
  const pivot = closure?.axis === 'knowledge'
    ? pitSelection?.asOfKnowledge
    : pitSelection?.asOfAvailable;
  return validInstant(closure?.closedAt)
    && validInstant(pivot)
    && compareUtcInstantLexical(closure.closedAt, pivot) <= 0;
}

function calculationInputSetDigest(inputs, priceKind, closures = [], pitSelection = null) {
  const closuresByTargetAxis = closureIndex(
    (closures || []).filter((closure) => closureAffectsPit(closure, pitSelection)),
  );
  const snapshots = [...inputs]
    .sort((left, right) => compareUtf8(left?.versionIri, right?.versionIri))
    .map((input) => inputFactSnapshot(input, priceKind, closuresByTargetAxis));
  return sha256(Buffer.from(
    `${CALCULATION_INPUT_SET_DOMAIN}${canonicalJcs(snapshots)}`,
    'utf8',
  ));
}

function calculationClosureAssertionSetDigest(
  candidates,
  closures = [],
  pitSelection = null,
) {
  const candidateIris = new Set((candidates || []).map((candidate) => candidate?.versionIri));
  const snapshots = (closures || [])
    .filter((closure) => candidateIris.has(closure?.targetVersionIri)
      && ['knowledge', 'availability'].includes(closure?.axis)
      && closureAffectsPit(closure, pitSelection))
    .map((closure) => ({
      axis: closure?.axis,
      causeKind: closure?.causeKind,
      causeVersionIri: closure?.causeVersionIri ?? null,
      closedAt: closure?.closedAt,
      evidenceRef: closure?.evidenceRef,
      generatingContextRef: closure?.generatingContextRef,
      targetVersionIri: closure?.targetVersionIri,
    }))
    .sort((left, right) => compareUtf8(
      `${left.targetVersionIri}\0${left.axis}\0${left.closedAt}\0${left.causeVersionIri ?? ''}`,
      `${right.targetVersionIri}\0${right.axis}\0${right.closedAt}\0${right.causeVersionIri ?? ''}`,
    ));
  return sha256(Buffer.from(
    `${CALCULATION_CLOSURE_SET_DOMAIN}${canonicalJcs(snapshots)}`,
    'utf8',
  ));
}

function expectedCalculationSelection(priceKind, document) {
  if (priceKind === 'vwap') {
    return {
      contextVersionIri: document?.selection?.contextVersionIri,
      inputStreamVersionIri: document?.selection?.inputStreamVersionIri,
      inputType: 'TradeObservation',
      instrumentVersionIri: document?.selection?.instrumentVersionIri,
      priceKind: 'last',
      quotationVersionIri: document?.selection?.quotationVersionIri,
      revisionSelection: 'exact-version-iri',
      windowPredicate: 'observedAt-in-half-open-interval',
    };
  }
  if (priceKind === 'twap') {
    return {
      contextVersionIri: document?.selection?.contextVersionIri,
      inputStreamVersionIri: document?.selection?.inputStreamVersionIri,
      inputType: 'PriceObservation',
      instrumentVersionIri: document?.selection?.instrumentVersionIri,
      priceKind: 'last',
      quotationVersionIri: document?.selection?.quotationVersionIri,
      revisionSelection: 'exact-version-iri',
      windowPredicate: 'observedAt-step-function-partitions-half-open-window',
    };
  }
  return null;
}

function inputMatchesSelection(input, selection, window) {
  if (input?.type !== selection.inputType
      || input?.streamVersionIri !== selection.inputStreamVersionIri
      || input?.observedInstrument?.versionIri !== selection.instrumentVersionIri
      || contextVersionIri(input) !== selection.contextVersionIri
      || input?.quotation?.versionIri !== selection.quotationVersionIri
      || input?.priceKind !== selection.priceKind) return false;
  if (selection.windowPredicate === 'observedAt-in-half-open-interval'
      || selection.windowPredicate === 'observedAt-step-function-partitions-half-open-window') {
    return validInstant(input?.observedAt)
      && compareUtcInstantLexical(input.observedAt, window.startInclusive) >= 0
      && compareUtcInstantLexical(input.observedAt, window.endExclusive) < 0;
  }
  return validInstant(input?.axes?.validFrom)
    && validInstant(input?.axes?.validTo)
    && compareUtcInstantLexical(input.axes.validFrom, window.startInclusive) >= 0
    && compareUtcInstantLexical(input.axes.validTo, window.endExclusive) <= 0;
}

function expectedCalculationPitSelection(observation) {
  return {
    asOfAvailable: observation?.axes?.availableFrom,
    asOfKnowledge: observation?.axes?.knowledgeFrom,
    asOfValid: observation?.axes?.validFrom,
    referenceTime: observation?.axes?.availableFrom,
  };
}

function intervalContains(start, end, pivot) {
  return validInstant(start)
    && validInstant(pivot)
    && compareUtcInstantLexical(start, pivot) <= 0
    && (!validInstant(end) || compareUtcInstantLexical(pivot, end) < 0);
}

function selectCalculationInputsAtPit(
  observations,
  selection,
  window,
  pitSelection,
  closures = [],
) {
  const candidates = (observations || []).filter((input) => (
    inputMatchesSelection(input, selection, window)
  ));
  const closuresByTargetAxis = closureIndex(closures);
  const conflicts = [];
  const groups = new Map();
  for (const candidate of candidates) {
    if (!validIri(candidate?.logicalIri)) {
      conflicts.push({
        logicalIri: candidate?.logicalIri,
        reason: 'candidate is missing a logical identity IRI',
        versionIris: [candidate?.versionIri],
      });
      continue;
    }
    const group = groups.get(candidate.logicalIri) || [];
    group.push(candidate);
    groups.set(candidate.logicalIri, group);
  }
  const inputs = [];
  for (const [logicalIri, group] of groups) {
    const relevantVersionIris = new Set(group.map((candidate) => candidate?.versionIri));
    const duplicateClosureKeys = [...closuresByTargetAxis.entries()]
      .filter(([key, values]) => relevantVersionIris.has(key.split('\0')[0]) && values.length !== 1)
      .map(([key]) => key);
    if (duplicateClosureKeys.length > 0) {
      conflicts.push({
        logicalIri,
        reason: `ambiguous closure assertions: ${duplicateClosureKeys.join(', ')}`,
        versionIris: group.map((candidate) => candidate?.versionIri),
      });
      continue;
    }
    const eligible = group.filter((candidate) => {
      const knowledgeEnd = uniqueClosure(
        closuresByTargetAxis,
        candidate?.versionIri,
        'knowledge',
      )?.closedAt;
      const availabilityEnd = uniqueClosure(
        closuresByTargetAxis,
        candidate?.versionIri,
        'availability',
      )?.closedAt;
      return intervalContains(
        candidate?.axes?.validFrom,
        candidate?.axes?.validTo,
        pitSelection?.asOfValid,
      ) && intervalContains(
        candidate?.axes?.knowledgeFrom,
        knowledgeEnd,
        pitSelection?.asOfKnowledge,
      ) && intervalContains(
        candidate?.axes?.availableFrom,
        availabilityEnd,
        pitSelection?.asOfAvailable,
      );
    });
    if (eligible.length > 1) {
      conflicts.push({
        logicalIri,
        reason: 'multiple FactVersions are three-axis eligible at the calculation pivot',
        versionIris: eligible.map((candidate) => candidate?.versionIri),
      });
    } else if (eligible.length === 1) {
      inputs.push(eligible[0]);
    }
  }
  return { candidates, conflicts, inputs };
}

function validateTwapPartition(inputs, window) {
  const ordered = [...inputs].sort((left, right) => (
    compareUtcInstantLexical(left.observedAt, right.observedAt)
      || compareUtf8(left.versionIri, right.versionIri)
  ));
  if (ordered.length === 0
      || ordered[0]?.observedAt !== window.startInclusive
      || compareUtcInstantLexical(ordered.at(-1)?.observedAt, window.endExclusive) >= 0) return false;
  return ordered.every((input, index) => (
    validInstant(input?.observedAt)
      && (index === 0 || compareUtcInstantLexical(
        ordered[index - 1].observedAt,
        input.observedAt,
      ) < 0)
  ));
}

function twapDurationWeights(inputs, window) {
  const ordered = [...inputs].sort((left, right) => (
    compareUtcInstantLexical(left.observedAt, right.observedAt)
      || compareUtf8(left.versionIri, right.versionIri)
  ));
  const byVersion = new Map(ordered.map((input, index) => {
    const nextInstant = index + 1 < ordered.length
      ? ordered[index + 1].observedAt
      : window.endExclusive;
    return [
      input.versionIri,
      durationNanosecondsToDecimalSeconds(
        utcInstantDifferenceNanoseconds(nextInstant, input.observedAt),
      ),
    ];
  }));
  return inputs.map((input) => byVersion.get(input.versionIri));
}

function validateCalculationRun(
  binding,
  arithmeticPolicy,
  observation,
  observations,
  closures,
  at,
  violations,
) {
  const document = binding?.document;
  const expectedKeys = CALCULATION_RUN_SCHEMA.required;
  const schemaShapeValid = exactKeys(document, expectedKeys)
    && document.schemaIri === CALCULATION_RUN_SCHEMA.$id
    && document.schemaDigest === CALCULATION_RUN_SCHEMA_DIGEST
    && DIGEST_RE.test(document.calculationDefinitionDigest || '')
    && DIGEST_RE.test(document.calculationInputSetDigest || '')
    && validIri(document.calculationRunIri)
    && validIri(document.calculationDefinitionRef)
    && validIri(document.outputObservationVersionIri)
    && Array.isArray(document.capabilityIris)
    && document.capabilityIris.length === 1
    && Array.isArray(document.inputObservationVersionIris)
    && document.inputObservationVersionIris.length > 0
    && exactKeys(document.window, CALCULATION_RUN_SCHEMA.properties.window.required)
    && exactKeys(document.selection, CALCULATION_RUN_SCHEMA.properties.selection.required)
    && exactKeys(
      document.pitSelection,
      CALCULATION_RUN_SCHEMA.properties.pitSelection.required,
    )
    && DIGEST_RE.test(document.closureAssertionSetDigest || '')
    && exactKeys(document.computedOutput, CALCULATION_RUN_SCHEMA.properties.computedOutput.required)
    && exactKeys(
      document.recalculationPolicy,
      CALCULATION_RUN_SCHEMA.properties.recalculationPolicy.required,
    );
  const schemaContractValid = schemaShapeValid
    && document.artifactTypeIri
      === CALCULATION_RUN_SCHEMA.properties.artifactTypeIri.const
    && CALCULATION_RUN_SCHEMA.properties.capabilityIris.items.enum
      .includes(document.capabilityIris[0])
    && document.version === CALCULATION_RUN_SCHEMA.properties.version.const
    && CALCULATION_RUN_SCHEMA.properties.priceKind.enum.includes(document.priceKind)
    && Object.values(document.pitSelection).every(validInstant)
    && new RegExp(CALCULATION_RUN_SCHEMA.properties.computedOutput.properties.amount.pattern, 'u')
      .test(document.computedOutput.amount || '')
    && new RegExp(CALCULATION_RUN_SCHEMA.properties.computedOutput.properties.currency.pattern, 'u')
      .test(document.computedOutput.currency || '')
    && isDeepStrictEqual(
      document.recalculationPolicy.invalidatedBy,
      CALCULATION_RUN_SCHEMA.properties.recalculationPolicy
        .properties.invalidatedBy.const,
    )
    && document.recalculationPolicy.outputMutationPolicy
      === CALCULATION_RUN_SCHEMA.properties.recalculationPolicy
        .properties.outputMutationPolicy.const
    && document.recalculationPolicy.overwriteAllowed
      === CALCULATION_RUN_SCHEMA.properties.recalculationPolicy
        .properties.overwriteAllowed.const
    && document.recalculationPolicy.recalculationRequiredWhenInvalidated
      === CALCULATION_RUN_SCHEMA.properties.recalculationPolicy
        .properties.recalculationRequiredWhenInvalidated.const;
  if (!schemaContractValid) {
    violations.push(finding(
      'RELEASE_ARTIFACT_SCHEMA',
      at,
      `calculation-run bytes do not satisfy exact schema ${CALCULATION_RUN_SCHEMA.$id}#${CALCULATION_RUN_SCHEMA_DIGEST}`,
    ));
  }
  if (!exactKeys(document, expectedKeys)
      || document?.calculationRunIri !== binding?.artifactIri
      || document?.version !== '1.0.0'
      || document?.priceKind !== observation?.priceKind
      || document?.outputObservationVersionIri !== observation?.versionIri) {
    violations.push(finding(
      'RELEASE_ARTIFACT_CONTENT',
      at,
      'calculation-run evidence must be a closed v1 artifact for this exact output FactVersion and PriceKind',
    ));
    return;
  }
  if (document.calculationDefinitionRef !== observation.calculationDefinitionRef
      || document.calculationDefinitionDigest !== observation.calculationDefinitionDigest) {
    violations.push(finding(
      'CALCULATION_DEFINITION_RUN',
      at,
      'calculation run does not bind the output observation exact calculation definition and digest',
    ));
  }
  const windowValid = exactKeys(document.window, ['endExclusive', 'startInclusive'])
    && validInstant(document.window.startInclusive)
    && validInstant(document.window.endExclusive)
    && compareUtcInstantLexical(
      document.window.startInclusive,
      document.window.endExclusive,
    ) < 0
    && observation?.observedAt === document.window.endExclusive;
  if (!windowValid) {
    violations.push(finding(
      'CALCULATION_WINDOW',
      `${at}.window`,
      'calculation window must be a non-empty half-open UTC interval ending at output observedAt',
    ));
    return;
  }
  const expectedSelection = expectedCalculationSelection(observation.priceKind, document);
  if (!expectedSelection || !isDeepStrictEqual(document.selection, expectedSelection)) {
    violations.push(finding(
      'CALCULATION_SELECTION',
      `${at}.selection`,
      'calculation selection does not equal the closed branch-specific FactVersion selection contract',
    ));
    return;
  }
  const expectedPitSelection = expectedCalculationPitSelection(observation);
  const pitSelectionValid = isDeepStrictEqual(document.pitSelection, expectedPitSelection)
    && validInstant(document.pitSelection?.asOfValid)
    && validInstant(document.pitSelection?.asOfKnowledge)
    && validInstant(document.pitSelection?.asOfAvailable)
    && validInstant(document.pitSelection?.referenceTime)
    && compareUtcInstantLexical(
      document.pitSelection.asOfKnowledge,
      document.pitSelection.referenceTime,
    ) <= 0
    && compareUtcInstantLexical(
      document.pitSelection.asOfAvailable,
      document.pitSelection.referenceTime,
    ) <= 0;
  if (!pitSelectionValid) {
    violations.push(finding(
      'CALCULATION_PIT_SELECTION',
      `${at}.pitSelection`,
      'calculation PIT selection must bind the output FactVersion valid/knowledge/availability axes and deterministic referenceTime',
    ));
    return;
  }
  const pitResult = selectCalculationInputsAtPit(
    observations,
    document.selection,
    document.window,
    document.pitSelection,
    closures,
  );
  const selectedInputs = pitResult.inputs;
  if (pitResult.conflicts.length > 0) {
    violations.push(finding(
      'CALCULATION_PIT_SELECTION',
      `${at}.pitSelection`,
      `calculation PIT selection is ambiguous: ${pitResult.conflicts
        .map((conflict) => `${conflict.logicalIri}: ${conflict.reason}`)
        .join('; ')}`,
    ));
  }
  let actualClosureSetDigest = null;
  try {
    actualClosureSetDigest = calculationClosureAssertionSetDigest(
      pitResult.candidates,
      closures,
      document.pitSelection,
    );
  } catch {
    // Structural validation reports malformed assertions; keep the evidence gate fail closed.
  }
  if (actualClosureSetDigest === null
      || document.closureAssertionSetDigest !== actualClosureSetDigest) {
    violations.push(finding(
      'CALCULATION_CLOSURE_SET',
      `${at}.closureAssertionSetDigest`,
      'calculation closure-assertion digest must bind every knowledge/availability closure affecting the semantic candidate set',
    ));
  }
  const selectedIris = selectedInputs.map((input) => input.versionIri)
    .sort(compareUtf8);
  const declaredIris = Array.isArray(document.inputObservationVersionIris)
    ? document.inputObservationVersionIris
    : [];
  const declaredCanonical = declaredIris.length > 0
    && declaredIris.every(validIri)
    && new Set(declaredIris).size === declaredIris.length
    && isDeepStrictEqual(declaredIris, [...declaredIris].sort(compareUtf8));
  if (!declaredCanonical || !isDeepStrictEqual(declaredIris, selectedIris)) {
    violations.push(finding(
      'CALCULATION_INPUT_SET',
      `${at}.inputObservationVersionIris`,
      'declared exact input FactVersion set does not equal the deterministic selection result',
    ));
  }
  let actualInputSetDigest = null;
  try {
    actualInputSetDigest = calculationInputSetDigest(
      selectedInputs,
      observation.priceKind,
      closures,
      document.pitSelection,
    );
  } catch {
    // Structural validation reports the malformed input; keep this gate fail closed.
  }
  if (actualInputSetDigest === null
      || document.calculationInputSetDigest !== actualInputSetDigest
      || observation.calculationInputSetDigest !== actualInputSetDigest) {
    violations.push(finding(
      'CALCULATION_INPUT_SET',
      `${at}.calculationInputSetDigest`,
      'calculation input-set digest does not equal the canonical selected FactVersion snapshots',
    ));
  }
  const observationsByVersion = new Map((observations || []).map((input) => [
    input?.versionIri,
    input,
  ]));
  const declaredInputs = declaredIris.map((iri) => observationsByVersion.get(iri)).filter(Boolean);
  if (declaredInputs.some((input) => (
    !validInstant(input?.axes?.knowledgeFrom)
      || !validInstant(input?.axes?.availableFrom)
      || compareUtcInstantLexical(
        input.axes.knowledgeFrom,
        document.pitSelection.asOfKnowledge,
      ) > 0
      || compareUtcInstantLexical(
        input.axes.availableFrom,
        document.pitSelection.asOfAvailable,
      ) > 0
  ))) {
    violations.push(finding(
      'CALCULATION_INPUT_FUTURE',
      `${at}.inputObservationVersionIris`,
      'every declared input FactVersion must be known and available at the calculation PIT pivot',
    ));
  }
  const sameCurrency = selectedInputs.every((input) => (
    (observation.priceKind === 'vwap' ? input?.tradePrice?.currency : input?.price?.currency)
      === observation?.price?.currency
  ));
  const vwapUnitsValid = observation.priceKind !== 'vwap' || selectedInputs.every((input) => (
    input?.tradeSize?.unit === observation?.quotation?.denominatorUnit
  ));
  const partitionValid = observation.priceKind !== 'twap'
    || validateTwapPartition(selectedInputs, document.window);
  const weights = observation.priceKind === 'vwap'
    ? selectedInputs.map((input) => input?.tradeSize?.value)
    : twapDurationWeights(selectedInputs, document.window);
  const outputMatches = exactKeys(document.computedOutput, ['amount', 'currency'])
    && isDeepStrictEqual(document.computedOutput, observation?.price)
    && sameCurrency
    && vwapUnitsValid
    && partitionValid
    && observation?.price?.amount === quantizedWeightedMean(
      selectedInputs,
      observation.priceKind === 'vwap' ? 'tradePrice' : 'price',
      weights,
      arithmeticPolicy,
    );
  if (!outputMatches) {
    violations.push(finding(
      'CALCULATION_OUTPUT',
      `${at}.computedOutput`,
      'computed output must replay the selected same-currency inputs, units, window partition, and digest-bound exact-rational final rounding policy',
    ));
  }
  if (!isDeepStrictEqual(document.recalculationPolicy, CALCULATION_RECALCULATION_POLICY)) {
    violations.push(finding(
      'CALCULATION_POLICY',
      `${at}.recalculationPolicy`,
      'derived output must be invalidated and append-only recalculated on definition, input-set, input-payload, selection, PIT, or closure drift',
    ));
  }
  if (!isDeepStrictEqual(arithmeticPolicy, CALCULATION_ARITHMETIC_POLICY)) {
    violations.push(finding(
      'CALCULATION_POLICY',
      `${at}.calculationDefinitionRef`,
      'calculation run requires the digest-bound exact-rational final-output rounding policy',
    ));
  }
}

function validateFxReciprocalTransformation(binding, derivation, source, at, violations) {
  const document = binding?.document;
  const valid = exactKeys(document, [
    'arithmetic',
    'artifactTypeIri',
    'capabilityIris',
    'invariants',
    'operator',
    'rounding',
    'transformationIri',
    'version',
  ])
    && document.transformationIri === binding.artifactIri
    && document.version === '1.0.0'
    && document.operator === 'reciprocal'
    && document.arithmetic === 'exact-base-10-decimal'
    && isDeepStrictEqual(document.rounding, {
      mode: 'half-even',
      scale: 16,
      maximumAbsoluteProductError: '0.0000000000000001',
    })
    && isDeepStrictEqual(document.invariants, [
      'derivedBaseCurrency=sourceQuoteCurrency',
      'derivedQuoteCurrency=sourceBaseCurrency',
      'derivedRate*sourceRate approximately 1 within maximumAbsoluteProductError',
      'derived inverse is not stored as a FactVersion',
    ]);
  if (!valid) {
    violations.push(finding(
      'RELEASE_ARTIFACT_CONTENT',
      at,
      'FX reciprocal transformation must equal its closed executable v1 contract',
    ));
    return;
  }
  let expectedValue = null;
  try {
    expectedValue = expectedReciprocalLexical(source?.fxRate?.value, document.rounding);
  } catch {
    // The structural validator reports malformed source values; this evidence gate fails closed.
  }
  if (expectedValue === null
      || derivation?.rate?.rounding !== document.rounding.mode
      || derivation?.rate?.value !== expectedValue) {
    violations.push(finding(
      'FX_RECIPROCAL_POLICY',
      at,
      'derived FX rate must equal the digest-bound exact reciprocal after final scale-16 half-even quantization and must declare that rounding mode',
    ));
  }
}

function validateProvenanceEvidence(reader, value, at, violations) {
  if (!isPlainObject(value)
      || Object.keys(value).sort().join('\0') !== PROVENANCE_FIELDS.join('\0')) {
    violations.push(finding('RELEASE_PROVENANCE_SHAPE', at, 'provenance must be a closed sourceArtifactDigest/sourceArtifactRef/sourceLocator object'));
    return;
  }
  for (const error of validateByteArtifact(
    reader,
    value.sourceArtifactRef,
    value.sourceArtifactDigest,
    at,
  )) {
    violations.push(finding('RELEASE_SOURCE_ARTIFACT', at, error));
  }
  for (const error of validateLocator(
    reader,
    value.sourceLocator,
    `${at}.sourceLocator`,
    value.sourceArtifactRef,
  )) {
    violations.push(finding('RELEASE_SOURCE_SELECTION', at, error));
  }
}

/**
 * Validate one ProvenancedFact source claim against authenticated source-tree
 * bytes. This is deliberately narrower than the complete Market Data release
 * evidence gate so semantic validators can enforce byte closure without also
 * taking ownership of unrelated release-only findings.
 */
function validateSourceArtifactEvidence(value, options = {}) {
  const violations = [];
  const reader = createRepositoryReader(options.repositoryRoot);
  validateProvenanceEvidence(
    reader,
    value,
    options.at || 'provenance',
    violations,
  );
  return violations;
}

/**
 * Validate every source-evidenced record in a Market Data scenario. A source
 * digest is not semantic evidence unless it equals the referenced artifact
 * bytes and the SourceLocator selection digest equals the selected bytes under
 * its digest-locked extractor profile.
 */
function validateScenarioSourceEvidence(scenario, options = {}) {
  const violations = [];
  const reader = createRepositoryReader(options.repositoryRoot);
  for (const [collection, values] of [
    ['streams', scenario?.streams],
    ['barSpecifications', scenario?.barSpecifications],
    ['observations', scenario?.observations],
    ['findings', scenario?.findings],
    ['fxDerivations', scenario?.fxDerivations],
  ]) {
    for (const [index, record] of (values || []).entries()) {
      validateProvenanceEvidence(
        reader,
        record?.provenance,
        `${collection}[${index}].provenance`,
        violations,
      );
    }
  }
  return violations;
}

function expectedSourceFields(observation) {
  if (observation?.type === 'PriceObservation') {
    return {
      price: observation?.price?.amount,
      currency: observation?.price?.currency,
      priceKind: observation?.priceKind,
    };
  }
  if (observation?.type === 'QuoteObservation') {
    return {
      bidPrice: observation?.bidPrice?.amount,
      bidSize: observation?.bidSize?.value,
      askPrice: observation?.askPrice?.amount,
      askSize: observation?.askSize?.value,
      currency: observation?.bidPrice?.currency,
    };
  }
  if (observation?.type === 'TradeObservation') {
    return {
      tradePrice: observation?.tradePrice?.amount,
      tradeSize: observation?.tradeSize?.value,
      currency: observation?.tradePrice?.currency,
    };
  }
  if (observation?.type === 'TradeBar') {
    return {
      open: observation?.tradeOpenPrice?.amount,
      high: observation?.tradeHighPrice?.amount,
      low: observation?.tradeLowPrice?.amount,
      close: observation?.tradeClosePrice?.amount,
      volume: observation?.tradeVolume?.value,
      currency: observation?.tradeOpenPrice?.currency,
    };
  }
  if (observation?.type === 'QuoteBar') {
    return {
      bidOpen: observation?.bidOpenPrice?.amount,
      bidHigh: observation?.bidHighPrice?.amount,
      bidLow: observation?.bidLowPrice?.amount,
      bidClose: observation?.bidClosePrice?.amount,
      askOpen: observation?.askOpenPrice?.amount,
      askHigh: observation?.askHighPrice?.amount,
      askLow: observation?.askLowPrice?.amount,
      askClose: observation?.askClosePrice?.amount,
      lastBidSize: observation?.lastBidSize?.value,
      lastAskSize: observation?.lastAskSize?.value,
      currency: observation?.bidOpenPrice?.currency,
    };
  }
  if (observation?.type === 'FXRateObservation') {
    return {
      rate: observation?.fxRate?.value,
      base: observation?.baseCurrency?.code,
      quote: observation?.quoteCurrency?.code,
    };
  }
  return {};
}

function validateObservationSourcePresence(
  reader,
  bindings,
  observation,
  stream,
  at,
  violations,
) {
  const ref = observation?.provenance?.sourceArtifactRef;
  if (!isPlainObject(ref) || ref.kind !== 'path') return;
  let document;
  try {
    const { bytes } = reader.readArtifact(ref, `${at}.provenance.sourceArtifactRef`);
    document = parseStrictJsonBytes(bytes, `${at}.provenance.sourceArtifactRef`);
  } catch (error) {
    violations.push(finding('RELEASE_SOURCE_RECORD', at, error.message));
    return;
  }
  const eventId = observation?.type === 'TradeObservation'
    ? observation?.sourceTradeId
    : observation?.providerObservationId;
  const expectedFields = expectedSourceFields(observation);
  const orderingBinding = bindings.get(stream?.mappings?.orderingTransformRef);
  const sourceCandidates = Array.isArray(document.records)
    ? document.records.filter((record) => record?.id === eventId
      && record?.streamId === stream?.providerStreamId
      && (observation?.sourceRevisionToken === undefined
        || record?.revisionToken === observation.sourceRevisionToken)
      && (observation?.sourceRevisionOrder === undefined
        || record?.sourceRevisionOrder === observation.sourceRevisionOrder)
      && record?.observedAt === observation?.observedAt
      && Object.entries(expectedFields).every(([field, value]) => record?.[field] === value))
    : [];
  const matches = [];
  for (const record of sourceCandidates) {
    try {
      const ordered = executeCanonicalOrderingTransformation(
        orderingBinding,
        record,
        stream?.logicalIri,
      );
      if (ordered.observedAt === observation?.observedAt
          && ordered.streamLogicalIri === stream?.logicalIri
          && ordered.sourceOrderKey === observation?.sourceOrderKey
          && ordered.sourceEventId === eventId) {
        matches.push(record);
      }
    } catch (error) {
      violations.push(finding(
        'RELEASE_ORDERING_EXECUTION',
        at,
        error.message,
      ));
    }
  }
  if (matches.length !== 1) {
    violations.push(finding(
      'RELEASE_SOURCE_RECORD',
      at,
      `expected one content-identical ${String(stream?.providerStreamId)} source record for ${String(eventId)}/${String(observation?.sourceRevisionToken || 'immutable')}, found ${matches.length}`,
    ));
    return;
  }
}

function validateScenarioReleaseEvidence(scenario, options = {}) {
  const reader = createRepositoryReader(options.repositoryRoot);
  const { bindings, violations } = buildArtifactBindings(scenario, reader);
  validateGeneratingContexts(scenario, bindings, reader, violations);
  const streamsById = new Map((scenario?.streams || []).map((stream) => [stream?.id, stream]));

  for (const [index, stream] of (scenario?.streams || []).entries()) {
    const at = `streams[${index}]`;
    validateBoundReference(
      bindings,
      stream?.sourceContractRef,
      stream?.sourceContractDigest,
      `${ARTIFACT_TYPE_BASE}SourceContract`,
      `${CAPABILITY_BASE}source-record-contract`,
      `${at}.sourceContractRef`,
      violations,
    );
    validateStreamSourceContract(bindings, stream, at, violations);
    validateBoundReference(
      bindings,
      stream?.mappings?.orderingTransformRef,
      stream?.mappings?.orderingTransformDigest,
      `${ARTIFACT_TYPE_BASE}CanonicalOrderingTransformation`,
      `${CAPABILITY_BASE}canonical-observation-ordering`,
      `${at}.mappings.orderingTransformRef`,
      violations,
    );
    validateOrderingTransformation(
      bindings.get(stream?.mappings?.orderingTransformRef),
      `${at}.mappings.orderingTransformRef`,
      violations,
    );
    for (const [field, locator] of [
      ['observationIdFieldLocator', stream?.mappings?.observationIdFieldLocator],
      ['sourceRevisionFieldLocator', stream?.mappings?.sourceRevisionFieldLocator],
    ]) {
      if (locator === undefined) continue;
      for (const error of validateLocator(reader, locator, `${at}.mappings.${field}`)) {
        violations.push(finding('RELEASE_FIELD_SELECTION', `${at}.mappings.${field}`, error));
      }
    }
  }

  for (const [index, observation] of (scenario?.observations || []).entries()) {
    const at = `observations[${index}]`;
    let arithmeticPolicy = null;
    if (Object.hasOwn(observation || {}, 'calculationDefinitionRef')
        || Object.hasOwn(observation || {}, 'calculationDefinitionDigest')) {
      validateBoundReference(
        bindings,
        observation.calculationDefinitionRef,
        observation.calculationDefinitionDigest,
        `${ARTIFACT_TYPE_BASE}CalculationDefinition`,
        `${CAPABILITY_BASE}${observation.priceKind}-calculation`,
        `${at}.calculationDefinitionRef`,
        violations,
      );
      arithmeticPolicy = validateCalculationDefinition(
        bindings.get(observation.calculationDefinitionRef),
        observation.priceKind,
        `${at}.calculationDefinitionRef`,
        violations,
      );
    }
    if (Object.hasOwn(observation || {}, 'calculationRunRef')
        || Object.hasOwn(observation || {}, 'calculationRunDigest')
        || Object.hasOwn(observation || {}, 'calculationInputSetDigest')) {
      validateBoundReference(
        bindings,
        observation.calculationRunRef,
        observation.calculationRunDigest,
        `${ARTIFACT_TYPE_BASE}CalculationRunEvidence`,
        `${CAPABILITY_BASE}${observation.priceKind}-calculation-run`,
        `${at}.calculationRunRef`,
        violations,
      );
      validateCalculationRun(
        bindings.get(observation.calculationRunRef),
        arithmeticPolicy,
        observation,
        scenario.observations,
        scenario.closures,
        `${at}.calculationRunRef`,
        violations,
      );
    }
    validateObservationSourcePresence(
      reader,
      bindings,
      observation,
      streamsById.get(observation?.stream),
      at,
      violations,
    );
  }
  for (const [index, derivation] of (scenario?.fxDerivations || []).entries()) {
    validateBoundReference(
      bindings,
      derivation?.transformationRef,
      derivation?.transformationDigest,
      `${ARTIFACT_TYPE_BASE}FXReciprocalTransformation`,
      `${CAPABILITY_BASE}fx-reciprocal-derivation`,
      `fxDerivations[${index}].transformationRef`,
      violations,
    );
    validateFxReciprocalTransformation(
      bindings.get(derivation?.transformationRef),
      derivation,
      (scenario?.observations || []).find(
        (observation) => observation?.versionIri === derivation?.sourceVersionIri,
      ),
      `fxDerivations[${index}].transformationRef`,
      violations,
    );
  }

  for (const [collection, values] of [
    ['streams', scenario?.streams],
    ['barSpecifications', scenario?.barSpecifications],
    ['observations', scenario?.observations],
    ['findings', scenario?.findings],
    ['fxDerivations', scenario?.fxDerivations],
  ]) {
    for (const [index, record] of (values || []).entries()) {
      validateProvenanceEvidence(reader, record?.provenance, `${collection}[${index}].provenance`, violations);
    }
  }

  return violations;
}

module.exports = {
  buildMarketDataImplementationClosure,
  calculationClosureAssertionSetDigest,
  calculationInputSetDigest,
  createRepositoryReader,
  expectedReciprocalLexical,
  executeCanonicalOrderingTransformation,
  isSyntheticDigest,
  quantizeExactRational,
  quantizedWeightedMean,
  selectCalculationInputsAtPit,
  sha256,
  validateScenarioSourceEvidence,
  validateScenarioReleaseEvidence,
  validateSourceArtifactEvidence,
};
