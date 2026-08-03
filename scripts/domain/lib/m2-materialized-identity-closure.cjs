'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  TAGS,
  compileIdentityContracts,
  taggedJcsDigest,
  validateCompilationInput,
  validateIdentityManifest,
} = require('./identity-contract-compiler.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const GLOBAL_REGISTRY_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/identity-term-registry.json',
});
const GLOBAL_COMPILATION_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/materialized-target-identity-compilation.json',
});
const GLOBAL_MANIFEST_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/materialized-target-identity-manifest.json',
});
const SOURCE_MANIFEST_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/materialized-mapping-source-manifest.json',
});
const MATERIALIZED_TARGET_INVENTORY_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/materialized-target-inventory.json',
});
const TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/temporalfact-materialization-disposition.json',
});
const DISCOVERY_ROOT = 'mappings/finance/v0.3.0';
const NORMALIZED_MODULE_ROOT = 'ontology/domain/finance';
const TEMPORAL_FACT_PATTERN_REF = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const MATERIALIZED_DISPOSITION = 'materialized';
const NON_MATERIALIZED_DISPOSITION = 'nonMaterialized';
const NO_CANONICAL_MAPPING_REASON = 'NO_CANONICAL_IDENTITY_COMPILATION_MAPPING';
const OUTPUT_PATHS = new Set([
  GLOBAL_REGISTRY_REF.path,
  GLOBAL_COMPILATION_REF.path,
  GLOBAL_MANIFEST_REF.path,
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function artifactDigest(bytes) {
  const crypto = require('node:crypto');
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function resolveSourceTree(root, ref, label) {
  if (!ref || ref.kind !== 'path' || ref.root !== 'sourceTree'
      || typeof ref.path !== 'string' || path.posix.normalize(ref.path) !== ref.path
      || path.posix.isAbsolute(ref.path) || ref.path.startsWith('../')) {
    throw new Error(`${label} must be a canonical sourceTree path ArtifactRef`);
  }
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, ...ref.path.split('/'));
  const relative = path.relative(resolvedRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the source tree`);
  }
  let cursor = resolvedRoot;
  for (const segment of ref.path.split('/')) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) throw new Error(`${label} is missing: ${ref.path}`);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} rejects symbolic-link path component: ${ref.path}`);
    }
  }
  if (!fs.statSync(absolute).isFile()) {
    throw new Error(`${label} is missing: ${ref.path}`);
  }
  const realRoot = fs.realpathSync.native(resolvedRoot);
  const realAbsolute = fs.realpathSync.native(absolute);
  const realRelative = path.relative(realRoot, realAbsolute);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)) {
    throw new Error(`${label} resolves outside the source tree`);
  }
  return absolute;
}

function readExactJcs(root, ref, label) {
  const absolute = resolveSourceTree(root, ref, label);
  const bytes = fs.readFileSync(absolute);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  const expected = Buffer.from(canonicalJcs(value), 'utf8');
  const expectedWithLf = Buffer.concat([expected, Buffer.from('\n', 'utf8')]);
  if (!bytes.equals(expected) && !bytes.equals(expectedWithLf)) {
    throw new Error(`${label} is not exact UTF-8 RFC 8785 JCS bytes with at most one final LF`);
  }
  return { ref, absolute, bytes, value, digest: artifactDigest(bytes) };
}

function isCompilationInput(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.contracts) && Array.isArray(value.mappings)
    && Array.isArray(value.concreteTargetTypes)
    && value.identityTermRegistry && Array.isArray(value.identityTermRegistry.termContracts)
    && Array.isArray(value.normalizationRules) && Array.isArray(value.derivations);
}

function walkJson(root, relativeRoot) {
  const absoluteRoot = path.resolve(root, ...relativeRoot.split('/'));
  if (!fs.existsSync(absoluteRoot)) return [];
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`mapping discovery rejects symlink ${toPosix(path.relative(root, absolute))}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(toPosix(path.relative(root, absolute)));
      }
    }
  }
  visit(absoluteRoot);
  return files.sort(compareUtf8);
}

function discoverCompilationRefs(root) {
  const refs = [];
  for (const relativePath of walkJson(root, DISCOVERY_ROOT)) {
    if (OUTPUT_PATHS.has(relativePath)) continue;
    let value;
    try {
      value = JSON.parse(fs.readFileSync(path.resolve(root, ...relativePath.split('/')), 'utf8'));
    } catch (error) {
      throw new Error(`mapping discovery cannot parse ${relativePath}: ${error.message}`);
    }
    if (isCompilationInput(value)) refs.push(artifactRef(relativePath));
  }

  const byJcs = new Map();
  for (const ref of refs) byJcs.set(canonicalJcs(ref), ref);
  return [...byJcs.values()].sort((left, right) => compareUtf8(left.path, right.path));
}

function closureFailure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactObjectKeys(value, expected, label, code) {
  if (!isPlainObject(value)) closureFailure(code, `${label} must be an object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (canonicalJcs(actual) !== canonicalJcs(wanted)) {
    closureFailure(code, `${label} fields differ: expected ${wanted.join(', ')}`);
  }
}

function absoluteIri(value, label, code) {
  if (typeof value !== 'string' || value.length === 0) {
    closureFailure(code, `${label} must be a non-empty absolute IRI`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || !value.includes(':')) throw new Error('missing scheme');
  } catch {
    closureFailure(code, `${label} must be an absolute IRI`);
  }
  return value;
}

function discoverModuleSourceRefs(root) {
  const refs = [];
  const start = path.resolve(root, ...NORMALIZED_MODULE_ROOT.split('/'));
  if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) {
    closureFailure('IDENTITY_NORMALIZED_IR_SOURCE', `module root is missing: ${NORMALIZED_MODULE_ROOT}`);
  }
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        closureFailure(
          'IDENTITY_NORMALIZED_IR_SOURCE',
          `module discovery rejects symlink ${toPosix(path.relative(root, absolute))}`,
        );
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === 'module.yaml') {
        refs.push(artifactRef(toPosix(path.relative(root, absolute))));
      }
    }
  }
  visit(start);
  return refs.sort((left, right) => compareUtf8(left.path, right.path));
}

function loadNormalizedModuleIr(root) {
  const modules = [];
  const types = [];
  const typeByIri = new Map();
  for (const sourceRef of discoverModuleSourceRefs(root)) {
    const absolute = resolveSourceTree(root, sourceRef, `NormalizedModuleIR source ${sourceRef.path}`);
    const bytes = fs.readFileSync(absolute);
    let document;
    try {
      document = yaml.load(bytes.toString('utf8'));
    } catch (error) {
      closureFailure('IDENTITY_NORMALIZED_IR_SOURCE', `${sourceRef.path} cannot be parsed: ${error.message}`);
    }
    const module = document?.module;
    const domain = document?.domain;
    absoluteIri(module?.moduleIri, `${sourceRef.path}.module.moduleIri`, 'IDENTITY_NORMALIZED_IR_SOURCE');
    if (!isPlainObject(domain)) {
      closureFailure('IDENTITY_NORMALIZED_IR_SOURCE', `${sourceRef.path}.domain must be an object`);
    }
    const moduleTypes = [];
    for (const [container, definitionKind] of [
      ['objectTypes', 'ObjectTypeDefinition'],
      ['associationTypes', 'AssociationTypeDefinition'],
    ]) {
      const definitions = domain[container] || {};
      if (!isPlainObject(definitions)) {
        closureFailure('IDENTITY_NORMALIZED_IR_SOURCE', `${sourceRef.path}.domain.${container} must be a map`);
      }
      for (const [key, definition] of Object.entries(definitions)) {
        if (!isPlainObject(definition)
            || definition.localName !== key
            || typeof definition.iri !== 'string') {
          closureFailure(
            'IDENTITY_NORMALIZED_IR_SOURCE',
            `${sourceRef.path}.domain.${container}.${key} is not a normalized type definition`,
          );
        }
        absoluteIri(
          definition.iri,
          `${sourceRef.path}.domain.${container}.${key}.iri`,
          'IDENTITY_NORMALIZED_IR_SOURCE',
        );
        if (typeByIri.has(definition.iri)) {
          closureFailure('IDENTITY_NORMALIZED_IR_DUPLICATE', `duplicate type IRI ${definition.iri}`);
        }
        const row = {
          abstract: definition.abstract === true,
          definitionKind,
          localName: key,
          moduleIri: module.moduleIri,
          patternRefs: (Array.isArray(definition.patternBindings)
            ? definition.patternBindings
              .map((binding) => binding?.pattern)
              .filter((pattern) => typeof pattern === 'string')
            : []).sort(compareUtf8),
          sourceRef,
          superTypes: (Array.isArray(definition.superTypes)
            ? definition.superTypes.filter((superType) => typeof superType === 'string')
            : []).sort(compareUtf8),
          targetType: definition.iri,
        };
        typeByIri.set(row.targetType, row);
        moduleTypes.push(row);
        types.push(row);
      }
    }
    moduleTypes.sort((left, right) => compareUtf8(left.targetType, right.targetType));
    modules.push({
      moduleIri: module.moduleIri,
      sourceDigest: artifactDigest(bytes),
      sourceRef,
      types: moduleTypes,
    });
  }
  modules.sort((left, right) => compareUtf8(left.moduleIri, right.moduleIri));
  types.sort((left, right) => compareUtf8(left.targetType, right.targetType));
  return {
    modules,
    schemaVersion: '1.0',
    typeByIri,
    types,
  };
}

function loadMaterializedTargetInventory(root) {
  const artifact = readExactJcs(root, MATERIALIZED_TARGET_INVENTORY_REF, 'materialized-target inventory');
  const inventory = artifact.value;
  exactObjectKeys(
    inventory,
    ['inventoryKind', 'profileRef', 'schemaVersion', 'targets'],
    'materialized-target inventory',
    'IDENTITY_TARGET_INVENTORY_SCHEMA',
  );
  if (inventory.schemaVersion !== '1.0'
      || inventory.inventoryKind !== 'independentMaterializedTargetInventory'
      || inventory.profileRef !== PROFILE_REF
      || !Array.isArray(inventory.targets)
      || inventory.targets.length === 0) {
    closureFailure('IDENTITY_TARGET_INVENTORY_SCHEMA', 'materialized-target inventory header is invalid');
  }
  let priorTarget = null;
  const seenContracts = new Set();
  const seenMappings = new Set();
  for (const [index, row] of inventory.targets.entries()) {
    const label = `materialized-target inventory.targets[${index}]`;
    exactObjectKeys(
      row,
      [
        'contractRef', 'definitionKind', 'mappingRefs', 'moduleIri',
        'sourceCompilationRef', 'targetType',
      ],
      label,
      'IDENTITY_TARGET_INVENTORY_SCHEMA',
    );
    absoluteIri(row.targetType, `${label}.targetType`, 'IDENTITY_TARGET_INVENTORY_SCHEMA');
    absoluteIri(row.moduleIri, `${label}.moduleIri`, 'IDENTITY_TARGET_INVENTORY_SCHEMA');
    absoluteIri(row.contractRef, `${label}.contractRef`, 'IDENTITY_TARGET_INVENTORY_SCHEMA');
    if (!['ObjectTypeDefinition', 'AssociationTypeDefinition'].includes(row.definitionKind)) {
      closureFailure('IDENTITY_TARGET_INVENTORY_SCHEMA', `${label}.definitionKind is invalid`);
    }
    if (priorTarget !== null && compareUtf8(priorTarget, row.targetType) >= 0) {
      closureFailure('IDENTITY_TARGET_INVENTORY_ORDER', 'target rows must be strictly targetType-sorted and unique');
    }
    priorTarget = row.targetType;
    if (!Array.isArray(row.mappingRefs) || row.mappingRefs.length === 0) {
      closureFailure('IDENTITY_TARGET_INVENTORY_SCHEMA', `${label}.mappingRefs must be non-empty`);
    }
    let priorMapping = null;
    for (const [mappingIndex, mappingRef] of row.mappingRefs.entries()) {
      absoluteIri(mappingRef, `${label}.mappingRefs[${mappingIndex}]`, 'IDENTITY_TARGET_INVENTORY_SCHEMA');
      if (priorMapping !== null && compareUtf8(priorMapping, mappingRef) >= 0) {
        closureFailure('IDENTITY_TARGET_INVENTORY_ORDER', `${label}.mappingRefs must be strictly sorted and unique`);
      }
      priorMapping = mappingRef;
      if (seenMappings.has(mappingRef)) {
        closureFailure('IDENTITY_TARGET_INVENTORY_DUPLICATE', `mapping ${mappingRef} is assigned twice`);
      }
      seenMappings.add(mappingRef);
    }
    if (seenContracts.has(row.contractRef)) {
      closureFailure('IDENTITY_TARGET_INVENTORY_DUPLICATE', `contract ${row.contractRef} is assigned twice`);
    }
    seenContracts.add(row.contractRef);
    const sourcePath = row.sourceCompilationRef?.path;
    if (typeof sourcePath !== 'string'
        || !sourcePath.startsWith(`${DISCOVERY_ROOT}/`)
        || sourcePath.includes('/fixtures/')
        || sourcePath.startsWith('tests/')
        || OUTPUT_PATHS.has(sourcePath)) {
      closureFailure(
        'IDENTITY_FIXTURE_SOURCE',
        `${label}.sourceCompilationRef must name a canonical production compilation under ${DISCOVERY_ROOT}`,
      );
    }
    try {
      resolveSourceTree(root, row.sourceCompilationRef, `${label}.sourceCompilationRef`);
    } catch (error) {
      closureFailure('IDENTITY_TARGET_SOURCE', error.message);
    }
  }
  return { artifact, inventory };
}

function validateTemporalFactDispositionDocument(disposition) {
  exactObjectKeys(
    disposition,
    ['dispositionKind', 'entries', 'profileRef', 'schemaVersion'],
    'TemporalFact materialization disposition',
    'TEMPORALFACT_DISPOSITION_SCHEMA',
  );
  if (disposition.schemaVersion !== '1.0'
      || disposition.dispositionKind !== 'independentTemporalFactMaterializationDisposition'
      || disposition.profileRef !== PROFILE_REF
      || !Array.isArray(disposition.entries)
      || disposition.entries.length === 0) {
    closureFailure('TEMPORALFACT_DISPOSITION_SCHEMA', 'TemporalFact disposition header is invalid');
  }

  let priorTarget = null;
  for (const [index, row] of disposition.entries.entries()) {
    const label = `TemporalFact materialization disposition.entries[${index}]`;
    const expectedKeys = row?.disposition === NON_MATERIALIZED_DISPOSITION
      ? ['definitionKind', 'disposition', 'moduleIri', 'patternRef', 'reasonCode', 'targetType']
      : ['definitionKind', 'disposition', 'moduleIri', 'patternRef', 'targetType'];
    exactObjectKeys(row, expectedKeys, label, 'TEMPORALFACT_DISPOSITION_SCHEMA');
    absoluteIri(row.targetType, `${label}.targetType`, 'TEMPORALFACT_DISPOSITION_SCHEMA');
    absoluteIri(row.moduleIri, `${label}.moduleIri`, 'TEMPORALFACT_DISPOSITION_SCHEMA');
    if (!['ObjectTypeDefinition', 'AssociationTypeDefinition'].includes(row.definitionKind)) {
      closureFailure('TEMPORALFACT_DISPOSITION_SCHEMA', `${label}.definitionKind is invalid`);
    }
    if (row.patternRef !== TEMPORAL_FACT_PATTERN_REF) {
      closureFailure(
        'TEMPORALFACT_DISPOSITION_SCHEMA',
        `${label}.patternRef must be ${TEMPORAL_FACT_PATTERN_REF}`,
      );
    }
    if (![MATERIALIZED_DISPOSITION, NON_MATERIALIZED_DISPOSITION].includes(row.disposition)) {
      closureFailure('TEMPORALFACT_DISPOSITION_SCHEMA', `${label}.disposition is invalid`);
    }
    if (row.disposition === NON_MATERIALIZED_DISPOSITION
        && row.reasonCode !== NO_CANONICAL_MAPPING_REASON) {
      closureFailure(
        'TEMPORALFACT_DISPOSITION_REASON',
        `${label}.reasonCode must be ${NO_CANONICAL_MAPPING_REASON}`,
      );
    }
    if (priorTarget !== null && compareUtf8(priorTarget, row.targetType) >= 0) {
      closureFailure(
        'TEMPORALFACT_DISPOSITION_ORDER',
        'disposition entries must be strictly targetType-sorted and unique',
      );
    }
    priorTarget = row.targetType;
  }
  return disposition;
}

function loadTemporalFactMaterializationDisposition(root) {
  const artifact = readExactJcs(
    root,
    TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF,
    'TemporalFact materialization disposition',
  );
  const disposition = validateTemporalFactDispositionDocument(artifact.value);
  return { artifact, disposition };
}

function concreteTemporalFactTypes(normalizedModuleIr) {
  const memo = new Map();
  const visiting = new Set();

  function hasTemporalFact(targetType) {
    if (memo.has(targetType)) return memo.get(targetType);
    const row = normalizedModuleIr.typeByIri.get(targetType);
    if (!row) return false;
    if (row.patternRefs.includes(TEMPORAL_FACT_PATTERN_REF)) {
      memo.set(targetType, true);
      return true;
    }
    if (visiting.has(targetType)) {
      closureFailure(
        'TEMPORALFACT_DISPOSITION_INHERITANCE_CYCLE',
        `cannot resolve effective TemporalFact binding through cyclic inheritance at ${targetType}`,
      );
    }
    visiting.add(targetType);
    const result = row.superTypes.some((superType) => hasTemporalFact(superType));
    visiting.delete(targetType);
    memo.set(targetType, result);
    return result;
  }

  return normalizedModuleIr.types
    .filter((row) => !row.abstract && hasTemporalFact(row.targetType))
    .sort((left, right) => compareUtf8(left.targetType, right.targetType));
}

function compareSets(expectedValues, actualValues) {
  const expected = [...new Set(expectedValues)].sort(compareUtf8);
  const actual = [...new Set(actualValues)].sort(compareUtf8);
  return {
    actual,
    expected,
    extra: actual.filter((value) => !expected.includes(value)),
    omitted: expected.filter((value) => !actual.includes(value)),
  };
}

function validateMaterializedTargetClosure(normalizedModuleIr, inventory, sources) {
  const sourceByPath = new Map(sources.map((source) => [source.ref.path, source]));
  const mappingRows = [];
  const contractRows = [];
  for (const source of sources) {
    for (const row of source.value.mappings) mappingRows.push({ row, sourceRef: source.ref });
    for (const row of source.value.contracts) contractRows.push({ row, sourceRef: source.ref });
  }
  const expectedTargets = inventory.targets.map((row) => row.targetType);
  const mappingComparison = compareSets(expectedTargets, mappingRows.map(({ row }) => row.targetType));
  if (mappingComparison.omitted.length > 0) {
    closureFailure('IDENTITY_TARGET_OMITTED', `mapping closure omits ${mappingComparison.omitted.join(', ')}`);
  }
  if (mappingComparison.extra.length > 0) {
    closureFailure('IDENTITY_TARGET_EXTRA', `mapping closure adds ${mappingComparison.extra.join(', ')}`);
  }
  const contractComparison = compareSets(expectedTargets, contractRows.map(({ row }) => row.targetType));
  if (contractComparison.omitted.length > 0) {
    closureFailure('IDENTITY_CONTRACT_OMITTED', `contract closure omits ${contractComparison.omitted.join(', ')}`);
  }
  if (contractComparison.extra.length > 0) {
    closureFailure('IDENTITY_CONTRACT_EXTRA', `contract closure adds ${contractComparison.extra.join(', ')}`);
  }

  for (const expected of inventory.targets) {
    const sourcePath = expected.sourceCompilationRef?.path;
    if (typeof sourcePath !== 'string'
        || !sourcePath.startsWith(`${DISCOVERY_ROOT}/`)
        || sourcePath.includes('/fixtures/')
        || sourcePath.startsWith('tests/')
        || OUTPUT_PATHS.has(sourcePath)) {
      closureFailure(
        'IDENTITY_FIXTURE_SOURCE',
        `${expected.targetType} source compilation is not a canonical production source`,
      );
    }
    const normalizedType = normalizedModuleIr.typeByIri.get(expected.targetType);
    if (!normalizedType) {
      closureFailure('IDENTITY_TARGET_NOT_IN_NORMALIZED_IR', `${expected.targetType} is absent from NormalizedModuleIR`);
    }
    if (normalizedType.abstract
        || normalizedType.moduleIri !== expected.moduleIri
        || normalizedType.definitionKind !== expected.definitionKind) {
      closureFailure(
        'IDENTITY_TARGET_IR_MISMATCH',
        `${expected.targetType} inventory classification differs from NormalizedModuleIR`,
      );
    }
    const source = sourceByPath.get(expected.sourceCompilationRef.path);
    if (!source) {
      closureFailure(
        'IDENTITY_TARGET_SOURCE',
        `${expected.targetType} source compilation is outside the discovered production source closure`,
      );
    }
    const targetContracts = contractRows.filter(({ row }) => row.targetType === expected.targetType);
    if (targetContracts.length !== 1
        || targetContracts[0].sourceRef.path !== expected.sourceCompilationRef.path
        || targetContracts[0].row.iri !== expected.contractRef) {
      closureFailure(
        'IDENTITY_MAPPING_CONTRACT_MISMATCH',
        `${expected.targetType} does not join its unique inventoried source contract`,
      );
    }
    const targetMappings = mappingRows.filter(({ row }) => row.targetType === expected.targetType);
    const actualMappingRefs = targetMappings.map(({ row }) => row.iri).sort(compareUtf8);
    if (canonicalJcs(actualMappingRefs) !== canonicalJcs(expected.mappingRefs)
        || targetMappings.some(({ row, sourceRef }) => (
          sourceRef.path !== expected.sourceCompilationRef.path
          || row.identity?.contractRef !== expected.contractRef
        ))) {
      closureFailure(
        'IDENTITY_MAPPING_CONTRACT_MISMATCH',
        `${expected.targetType} mapping/source/contract join differs from the independent inventory`,
      );
    }
  }
  return {
    expectedTargetTypes: [...expectedTargets],
    normalizedModuleCount: normalizedModuleIr.modules.length,
  };
}

function validateTemporalFactMaterializationDisposition(
  normalizedModuleIr,
  inventory,
  sources,
  disposition,
) {
  validateTemporalFactDispositionDocument(disposition);
  const temporalTypes = concreteTemporalFactTypes(normalizedModuleIr);
  const temporalByTarget = new Map(temporalTypes.map((row) => [row.targetType, row]));
  const dispositionByTarget = new Map(disposition.entries.map((row) => [row.targetType, row]));
  const inventoryTargets = new Set(inventory.targets.map((row) => row.targetType));
  const mappingTargets = new Set(
    sources.flatMap((source) => source.value.mappings.map((mapping) => mapping.targetType)),
  );

  const closure = compareSets(
    temporalTypes.map((row) => row.targetType),
    disposition.entries.map((row) => row.targetType),
  );
  if (closure.omitted.length > 0) {
    closureFailure(
      'TEMPORALFACT_DISPOSITION_OMITTED',
      `disposition omits concrete TemporalFact types: ${closure.omitted.join(', ')}`,
    );
  }
  if (closure.extra.length > 0) {
    closureFailure(
      'TEMPORALFACT_DISPOSITION_EXTRA',
      `disposition includes non-concrete or non-TemporalFact types: ${closure.extra.join(', ')}`,
    );
  }

  for (const row of disposition.entries) {
    const normalized = temporalByTarget.get(row.targetType);
    if (!normalized
        || normalized.moduleIri !== row.moduleIri
        || normalized.definitionKind !== row.definitionKind) {
      closureFailure(
        'TEMPORALFACT_DISPOSITION_IR_MISMATCH',
        `${row.targetType} disposition classification differs from NormalizedModuleIR`,
      );
    }
    if (row.disposition === MATERIALIZED_DISPOSITION) {
      if (!inventoryTargets.has(row.targetType)) {
        closureFailure(
          'TEMPORALFACT_MATERIALIZED_NOT_IN_INVENTORY',
          `${row.targetType} is materialized but absent from the independent materialized-target inventory`,
        );
      }
      if (!mappingTargets.has(row.targetType)) {
        closureFailure(
          'TEMPORALFACT_MATERIALIZED_WITHOUT_MAPPING',
          `${row.targetType} is materialized but has no canonical identity-compilation mapping`,
        );
      }
    } else {
      if (inventoryTargets.has(row.targetType)) {
        closureFailure(
          'TEMPORALFACT_NON_MATERIALIZED_IN_INVENTORY',
          `${row.targetType} is non-materialized but appears in the materialized-target inventory`,
        );
      }
      if (mappingTargets.has(row.targetType)) {
        closureFailure(
          'TEMPORALFACT_NON_MATERIALIZED_HAS_MAPPING',
          `${row.targetType} claims ${NO_CANONICAL_MAPPING_REASON} but has a canonical identity-compilation mapping`,
        );
      }
    }
  }

  for (const targetType of inventoryTargets) {
    if (dispositionByTarget.get(targetType)?.disposition !== MATERIALIZED_DISPOSITION) {
      closureFailure(
        'TEMPORALFACT_INVENTORY_WITHOUT_MATERIALIZED_DISPOSITION',
        `${targetType} is inventoried for materialization without a materialized disposition`,
      );
    }
  }

  return {
    concreteTemporalFactCount: temporalTypes.length,
    materializedCount: disposition.entries
      .filter((row) => row.disposition === MATERIALIZED_DISPOSITION).length,
    nonMaterializedCount: disposition.entries
      .filter((row) => row.disposition === NON_MATERIALIZED_DISPOSITION).length,
  };
}

function addUnique(index, row, key, kind, sourceRef) {
  const identity = row?.[key];
  if (typeof identity !== 'string' || identity.length === 0) {
    throw new Error(`${kind} in ${sourceRef.path} lacks ${key}`);
  }
  const prior = index.get(identity);
  if (prior && canonicalJcs(prior.row) !== canonicalJcs(row)) {
    throw new Error(`${kind} ${identity} has conflicting definitions in ${prior.sourceRef.path} and ${sourceRef.path}`);
  }
  if (!prior) index.set(identity, { row, sourceRef });
}

function collectDerivationRefs(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectDerivationRefs(item, output);
  } else if (value && typeof value === 'object') {
    if (value.valueKind === 'derivation' && typeof value.derivationRef === 'string') {
      output.add(value.derivationRef);
    }
    for (const item of Object.values(value)) collectDerivationRefs(item, output);
  }
  return output;
}

function usedIdentityClosure(contracts, normalizationIndex, derivationIndex, termIndex, setIndex) {
  const normalizationRefs = new Set();
  const derivationRefs = new Set();
  const termRefs = new Set();
  for (const contract of contracts) {
    for (const component of [...contract.logicalComponents, ...contract.versionComponents]) {
      normalizationRefs.add(component.normalizationRuleRef);
      termRefs.add(component.termContractRef);
      collectDerivationRefs(component.semanticValue, derivationRefs);
    }
  }

  const visitedDerivations = new Set();
  const derivationQueue = [...derivationRefs];
  while (derivationQueue.length > 0) {
    const ref = derivationQueue.shift();
    if (visitedDerivations.has(ref)) continue;
    const row = derivationIndex.get(ref)?.row;
    if (!row) throw new Error(`used identity derivation is absent: ${ref}`);
    visitedDerivations.add(ref);
    for (const output of row.outputs) termRefs.add(output.termContractRef);
    const nested = collectDerivationRefs(row.inputSemanticValues);
    for (const nestedRef of nested) derivationQueue.push(nestedRef);
  }

  const normalizations = [...normalizationRefs].map((ref) => {
    const row = normalizationIndex.get(ref)?.row;
    if (!row) throw new Error(`used identity normalization rule is absent: ${ref}`);
    termRefs.add(row.inputTermContractRef);
    termRefs.add(row.outputTermContractRef);
    return row;
  }).sort((left, right) => compareUtf8(left.iri, right.iri));

  const controlledSetRefs = new Set();
  const termContracts = [...termRefs].map((ref) => {
    const row = termIndex.get(ref)?.row;
    if (!row) throw new Error(`used identity term contract is absent: ${ref}`);
    if (row.definition?.termContract?.referenceMode === 'controlledIri') {
      controlledSetRefs.add(row.definition.termContract.controlledSetRef);
    }
    return row;
  }).sort((left, right) => compareUtf8(left.termContractRef, right.termContractRef));

  const controlledSets = [...controlledSetRefs].map((ref) => {
    const row = setIndex.get(ref)?.row;
    if (!row) throw new Error(`used controlled IRI set is absent: ${ref}`);
    return row;
  }).sort((left, right) => compareUtf8(left.controlledSetRef, right.controlledSetRef));

  return {
    normalizations,
    derivations: [...visitedDerivations]
      .map((ref) => derivationIndex.get(ref).row)
      .sort((left, right) => compareUtf8(left.iri, right.iri)),
    termContracts,
    controlledSets,
  };
}

function compileMaterializedIdentityClosure(root, options = {}) {
  const compilationRefs = discoverCompilationRefs(root);
  if (compilationRefs.length === 0) throw new Error('no SemanticMappingDefinition compilation source was discovered');

  const sources = compilationRefs.map((ref) => readExactJcs(root, ref, `mapping compilation ${ref.path}`));
  const normalizedModuleIr = options.normalizedModuleIr || loadNormalizedModuleIr(root);
  const inventoryArtifact = options.inventory
    ? null
    : loadMaterializedTargetInventory(root);
  const inventory = options.inventory || inventoryArtifact.inventory;
  const dispositionArtifact = options.disposition
    ? null
    : loadTemporalFactMaterializationDisposition(root);
  const disposition = options.disposition || dispositionArtifact.disposition;
  const contracts = new Map();
  const mappings = new Map();
  const normalizations = new Map();
  const derivations = new Map();
  const terms = new Map();
  const sets = new Map();

  for (const source of sources) {
    if (!isCompilationInput(source.value)) throw new Error(`${source.ref.path} is not a complete identity compilation input`);
    const validation = validateCompilationInput(source.value);
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new Error(`${source.ref.path} is invalid: ${first.code} ${first.path}: ${first.message}`);
    }
    for (const row of source.value.contracts) addUnique(contracts, row, 'iri', 'identity contract', source.ref);
    for (const row of source.value.mappings) addUnique(mappings, row, 'iri', 'SemanticMappingDefinition', source.ref);
    for (const row of source.value.normalizationRules) addUnique(normalizations, row, 'iri', 'normalization rule', source.ref);
    for (const row of source.value.derivations) addUnique(derivations, row, 'iri', 'identity derivation', source.ref);
    for (const row of source.value.identityTermRegistry.termContracts) {
      addUnique(terms, row, 'termContractRef', 'identity term contract', source.ref);
    }
    for (const row of source.value.identityTermRegistry.controlledSets) {
      addUnique(sets, row, 'controlledSetRef', 'controlled IRI set', source.ref);
    }
  }

  const temporalFactDisposition = validateTemporalFactMaterializationDisposition(
    normalizedModuleIr,
    inventory,
    sources,
    disposition,
  );
  const expectedClosure = validateMaterializedTargetClosure(
    normalizedModuleIr,
    inventory,
    sources,
  );

  const mappingRows = [...mappings.values()].map((value) => value.row)
    .sort((left, right) => compareUtf8(left.iri, right.iri));
  const targetTypes = expectedClosure.expectedTargetTypes;
  const contractRows = [...contracts.values()].map((value) => value.row)
    .filter((contract) => targetTypes.includes(contract.targetType))
    .sort((left, right) => compareUtf8(left.iri, right.iri));
  if (contractRows.length !== targetTypes.length) {
    throw new Error(`mapping target/identity contract cardinality differs: ${targetTypes.length}/${contractRows.length}`);
  }

  const used = usedIdentityClosure(contractRows, normalizations, derivations, terms, sets);
  const registry = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    termContracts: used.termContracts,
    controlledSets: used.controlledSets,
  };
  const registryDigest = taggedJcsDigest(TAGS.termRegistry, registry);
  const compilation = {
    profileRef: PROFILE_REF,
    identityTermRegistryRef: GLOBAL_REGISTRY_REF,
    identityTermRegistryDigest: registryDigest,
    identityTermRegistry: registry,
    normalizationRules: used.normalizations,
    derivations: used.derivations,
    contracts: contractRows,
    mappings: mappingRows,
    concreteTargetTypes: targetTypes,
  };
  const compiled = compileIdentityContracts(compilation);
  const validation = validateIdentityManifest(compiled.manifest, compilation);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`global identity manifest failed replay: ${first.code} ${first.path}: ${first.message}`);
  }

  const sourceManifest = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    compilationSources: sources.map((source) => ({
      artifactRef: source.ref,
      artifactDigest: source.digest,
      contractRefs: source.value.contracts.map((row) => row.iri).sort(compareUtf8),
      mappingRefs: source.value.mappings.map((row) => row.iri).sort(compareUtf8),
      targetTypes: [...new Set(source.value.mappings.map((row) => row.targetType))].sort(compareUtf8),
    })).sort((left, right) => compareUtf8(left.artifactRef.path, right.artifactRef.path)),
    discoveredTargetTypes: targetTypes,
    materializedTargetInventoryDigest: inventoryArtifact?.artifact.digest || options.inventoryDigest || null,
    materializedTargetInventoryRef: MATERIALIZED_TARGET_INVENTORY_REF,
    temporalFactMaterializationDispositionDigest:
      dispositionArtifact?.artifact.digest || options.dispositionDigest || null,
    temporalFactMaterializationDispositionRef: TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF,
    normalizedModuleSources: normalizedModuleIr.modules.map((module) => ({
      moduleIri: module.moduleIri,
      sourceDigest: module.sourceDigest,
      sourceRef: module.sourceRef,
    })),
    globalCompilationRef: GLOBAL_COMPILATION_REF,
    globalIdentityTermRegistryRef: GLOBAL_REGISTRY_REF,
    globalIdentityTermRegistryDigest: registryDigest,
    globalIdentityManifestRef: GLOBAL_MANIFEST_REF,
    globalIdentityManifestDigest: compiled.manifestDigest,
  };

  return {
    compilation,
    manifest: compiled.manifest,
    manifestDigest: compiled.manifestDigest,
    registry,
    registryDigest,
    sourceManifest,
    stats: {
      sourceCount: sources.length,
      normalizedModuleCount: expectedClosure.normalizedModuleCount,
      concreteTemporalFactCount: temporalFactDisposition.concreteTemporalFactCount,
      nonMaterializedTemporalFactCount: temporalFactDisposition.nonMaterializedCount,
      materializedTemporalFactCount: temporalFactDisposition.materializedCount,
      targetCount: targetTypes.length,
      contractCount: contractRows.length,
      mappingCount: mappingRows.length,
      termContractCount: used.termContracts.length,
      controlledSetCount: used.controlledSets.length,
      normalizationRuleCount: used.normalizations.length,
      derivationCount: used.derivations.length,
    },
  };
}

module.exports = {
  GLOBAL_COMPILATION_REF,
  GLOBAL_MANIFEST_REF,
  GLOBAL_REGISTRY_REF,
  MATERIALIZED_TARGET_INVENTORY_REF,
  MATERIALIZED_DISPOSITION,
  NON_MATERIALIZED_DISPOSITION,
  NO_CANONICAL_MAPPING_REASON,
  PROFILE_REF,
  SOURCE_MANIFEST_REF,
  TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF,
  TEMPORAL_FACT_PATTERN_REF,
  artifactDigest,
  compileMaterializedIdentityClosure,
  concreteTemporalFactTypes,
  discoverCompilationRefs,
  discoverModuleSourceRefs,
  isCompilationInput,
  loadMaterializedTargetInventory,
  loadNormalizedModuleIr,
  loadTemporalFactMaterializationDisposition,
  readExactJcs,
  validateMaterializedTargetClosure,
  validateTemporalFactDispositionDocument,
  validateTemporalFactMaterializationDisposition,
};
