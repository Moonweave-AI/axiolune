'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  IdentityContractError,
  canonicalJcs,
  compileIdentityContracts,
} = require('./identity-contract-compiler.cjs');
const {
  discoverCompilationRefs: discoverProductionCompilationRefs,
  loadMaterializedTargetInventory,
  loadNormalizedModuleIr,
  loadTemporalFactMaterializationDisposition,
  readExactJcs,
  validateTemporalFactMaterializationDisposition,
} = require('./m2-materialized-identity-closure.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FINANCE_BASE = 'https://axiolune.ai/ontology/finance/';

const CANONICAL_SCOPES = Object.freeze([
  Object.freeze({
    id: 'release-mapping-artifacts',
    relativePath: 'mappings/finance/v0.3.0',
    excludedRelativeFiles: Object.freeze([
      // This is the deterministic aggregate output produced from the four
      // canonical source compilations below.  Feeding it back into discovery
      // would make the coverage check compare source contracts with their
      // globally re-bound normalization digests.
      'materialized-target-identity-compilation.json',
    ]),
    requiredRelativeFiles: Object.freeze([
      'portfolio-positions/identity/portfolio-observation-identity-compilation.json',
      'portfolio-positions/identity/position-lot-identity-compilation.json',
      'slice-a-s5/identity-compilation.json',
      'strategy-research/semantic-mapping-set.json',
    ]),
  }),
]);

const FIXTURE_DYNAMIC_TYPES = Object.freeze({
  facilities: Object.freeze({
    base: `${FINANCE_BASE}market-structure/`,
    allowed: Object.freeze(['MarketSegment', 'TradingVenue']),
  }),
  instruments: Object.freeze({
    base: `${FINANCE_BASE}instruments/`,
    allowed: Object.freeze(['EquitySecurity', 'FinancialInstrument', 'Security']),
  }),
  parties: Object.freeze({
    base: `${FINANCE_BASE}foundation/`,
    allowed: Object.freeze(['LegalEntity', 'Party']),
  }),
});

const FIXTURE_STATIC_TYPES = Object.freeze({
  calendarExceptions: `${FINANCE_BASE}market-structure/TradingCalendarException`,
  calendars: `${FINANCE_BASE}market-structure/TradingCalendar`,
  identifierAuthorizations: `${FINANCE_BASE}foundation/IdentifierSchemeAuthorization`,
  identifierSchemes: `${FINANCE_BASE}foundation/IdentifierScheme`,
  identifierValues: `${FINANCE_BASE}foundation/LocalIdentifierValue`,
  issuances: `${FINANCE_BASE}instruments/InstrumentIssuance`,
  listings: `${FINANCE_BASE}instruments/InstrumentListing`,
  micEntries: `${FINANCE_BASE}market-structure/MICRegistryEntry`,
  offerings: `${FINANCE_BASE}instruments/SecurityOffering`,
  otcContexts: `${FINANCE_BASE}market-structure/OTCTradingContext`,
  quotationContracts: `${FINANCE_BASE}instruments/DirectUnitPriceQuotationContract`,
  sessionOccurrences: `${FINANCE_BASE}market-structure/TradingSessionOccurrence`,
  sessionTemplates: `${FINANCE_BASE}market-structure/TradingSessionTemplate`,
});

class MaterializedIdentityCoverageError extends Error {
  constructor(errors) {
    super(errors.map((entry) => `${entry.code} ${entry.at}: ${entry.message}`).join('\n'));
    this.name = 'MaterializedIdentityCoverageError';
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sorted(values) {
  return [...new Set(values)].sort(utf8Compare);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function addError(errors, code, at, message) {
  errors.push({ code, at, message });
}

function isCompilationArtifact(value) {
  return isObject(value)
    && Array.isArray(value.concreteTargetTypes)
    && Array.isArray(value.contracts)
    && Array.isArray(value.mappings);
}

function walkJsonFiles(directory, errors, label) {
  if (!fs.existsSync(directory)) {
    addError(errors, 'MISSING_CANONICAL_SCOPE', label, `missing directory ${directory}`);
    return [];
  }
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
    utf8Compare(left.name, right.name)
  ))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      addError(errors, 'SYMLINK_IN_CANONICAL_SCOPE', label, `refusing symlink ${absolute}`);
    } else if (entry.isDirectory()) {
      result.push(...walkJsonFiles(absolute, errors, label));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      result.push(absolute);
    }
  }
  return result;
}

function discoverCompilationArtifacts(root = ROOT) {
  const errors = [];
  const artifacts = [];
  for (const scope of CANONICAL_SCOPES) {
    const scopeRoot = path.join(root, ...scope.relativePath.split('/'));
    const discovered = new Map();
    for (const absolute of walkJsonFiles(scopeRoot, errors, scope.id)) {
      let value;
      try {
        value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      } catch (cause) {
        addError(
          errors,
          'INVALID_JSON_IN_CANONICAL_SCOPE',
          toPosix(path.relative(root, absolute)),
          cause.message,
        );
        continue;
      }
      if (!isCompilationArtifact(value)) continue;
      const relativeToScope = toPosix(path.relative(scopeRoot, absolute));
      if ((scope.excludedRelativeFiles || []).includes(relativeToScope)) continue;
      discovered.set(relativeToScope, true);
      artifacts.push({
        absolutePath: absolute,
        relativePath: toPosix(path.relative(root, absolute)),
        scopeId: scope.id,
        value,
      });
    }
    for (const required of scope.requiredRelativeFiles) {
      if (!discovered.has(required)) {
        addError(
          errors,
          'MISSING_CANONICAL_COMPILATION_ARTIFACT',
          `${scope.id}/${required}`,
          'required canonical SemanticMappingDefinition compilation artifact was not discovered',
        );
      }
    }
  }
  artifacts.sort((left, right) => utf8Compare(left.relativePath, right.relativePath));
  return { artifacts, errors };
}

function moduleOf(targetType) {
  if (typeof targetType !== 'string' || !targetType.startsWith(FINANCE_BASE)) return null;
  const relative = targetType.slice(FINANCE_BASE.length);
  const slash = relative.indexOf('/');
  return slash > 0 ? relative.slice(0, slash) : null;
}

function analyzeCompilationArtifacts(artifacts, initialErrors = []) {
  const errors = [...initialErrors];
  const discoveredTargets = [];
  const contractTargets = [];
  const contractByTarget = new Map();
  const baseOwner = new Map();
  const artifactRows = [];

  for (const artifact of artifacts) {
    const value = artifact.value;
    let compilation = null;
    try {
      compilation = compileIdentityContracts(value);
    } catch (cause) {
      if (cause instanceof IdentityContractError) {
        for (const issue of cause.errors) {
          addError(
            errors,
            `IDENTITY_COMPILER_${issue.code}`,
            `${artifact.relativePath}:${issue.path}`,
            issue.message,
          );
        }
      } else {
        addError(errors, 'IDENTITY_COMPILER_FAILURE', artifact.relativePath, cause.message);
      }
    }

    const mappingTargets = sorted(value.mappings
      .map((mapping) => mapping?.targetType)
      .filter((target) => typeof target === 'string'));
    const declaredTargets = sorted(value.concreteTargetTypes
      .filter((target) => typeof target === 'string'));
    const artifactContractTargets = sorted(value.contracts
      .map((contract) => contract?.targetType)
      .filter((target) => typeof target === 'string'));
    discoveredTargets.push(...mappingTargets);
    contractTargets.push(...artifactContractTargets);

    for (const contract of value.contracts) {
      if (!isObject(contract) || typeof contract.targetType !== 'string') continue;
      const fingerprint = canonicalJcs(contract);
      const prior = contractByTarget.get(contract.targetType);
      if (prior && prior.fingerprint !== fingerprint) {
        addError(
          errors,
          'CROSS_ARTIFACT_TARGET_CONTRACT_CONFLICT',
          artifact.relativePath,
          `${contract.targetType} differs from contract in ${prior.relativePath}`,
        );
      } else if (!prior) {
        contractByTarget.set(contract.targetType, { fingerprint, relativePath: artifact.relativePath });
      }
      if (typeof contract.identityBaseIri === 'string') {
        const priorOwner = baseOwner.get(contract.identityBaseIri);
        if (priorOwner && priorOwner.targetType !== contract.targetType) {
          addError(
            errors,
            'CROSS_ARTIFACT_IDENTITY_BASE_COLLISION',
            artifact.relativePath,
            `${contract.identityBaseIri} is shared by ${priorOwner.targetType} and ${contract.targetType}`,
          );
        } else if (!priorOwner) {
          baseOwner.set(contract.identityBaseIri, {
            relativePath: artifact.relativePath,
            targetType: contract.targetType,
          });
        }
      }
    }

    artifactRows.push({
      path: artifact.relativePath,
      profileRef: value.profileRef,
      declaredTargets,
      discoveredTargets: mappingTargets,
      contractTargets: artifactContractTargets,
      manifestDigest: compilation?.manifestDigest || null,
    });
  }

  const canonicalTargets = sorted(discoveredTargets);
  const uniqueContractTargets = sorted(contractTargets);
  const contractSet = new Set(uniqueContractTargets);
  const targetSet = new Set(canonicalTargets);
  const missingContractTargets = canonicalTargets.filter((target) => !contractSet.has(target));
  const orphanContractTargets = uniqueContractTargets.filter((target) => !targetSet.has(target));
  for (const target of missingContractTargets) {
    addError(errors, 'GLOBAL_TARGET_WITHOUT_CONTRACT', target, 'materialized target has no contract');
  }
  for (const target of orphanContractTargets) {
    addError(errors, 'GLOBAL_ORPHAN_CONTRACT', target, 'contract target is outside materialized mapping closure');
  }

  const targetsByModule = {};
  for (const target of canonicalTargets) {
    const moduleName = moduleOf(target) || '(external)';
    if (!targetsByModule[moduleName]) targetsByModule[moduleName] = [];
    targetsByModule[moduleName].push(target);
  }

  return {
    artifacts: artifactRows,
    canonicalTargets,
    contractTargets: uniqueContractTargets,
    errors,
    missingContractTargets,
    orphanContractTargets,
    targetsByModule,
  };
}

function discoverFixtureTargets(root = ROOT) {
  const fixturePath = path.join(
    root,
    'tests', 'm2', 'fixtures', 'slice-a', 'positive-market-instrument-contract.yaml',
  );
  const document = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
  const errors = [];
  const targets = [];
  for (const [collection, targetType] of Object.entries(FIXTURE_STATIC_TYPES)) {
    if (!Array.isArray(document?.[collection]) || document[collection].length === 0) {
      addError(errors, 'MISSING_FIXTURE_COLLECTION', collection, 'fixture collection is absent or empty');
      continue;
    }
    targets.push(targetType);
  }
  for (const [collection, descriptor] of Object.entries(FIXTURE_DYNAMIC_TYPES)) {
    if (!Array.isArray(document?.[collection]) || document[collection].length === 0) {
      addError(errors, 'MISSING_FIXTURE_COLLECTION', collection, 'fixture collection is absent or empty');
      continue;
    }
    for (const [index, record] of document[collection].entries()) {
      if (!descriptor.allowed.includes(record?.type)) {
        addError(
          errors,
          'UNKNOWN_FIXTURE_TARGET_TYPE',
          `${collection}[${index}].type`,
          `expected one of ${descriptor.allowed.join(', ')}`,
        );
        continue;
      }
      targets.push(`${descriptor.base}${record.type}`);
    }
  }
  return { errors, targets: sorted(targets) };
}

function discoverLegacyMappingTargets(root = ROOT) {
  const mappingPath = path.join(
    root,
    'mappings', 'finance', 'synthetic', 'slice-a-semantic-mapping.yaml',
  );
  const document = yaml.load(fs.readFileSync(mappingPath, 'utf8'));
  return sorted((Array.isArray(document?.targets) ? document.targets : [])
    .map((target) => target?.targetTypeIri)
    .filter((target) => typeof target === 'string'));
}

function auditMaterializedIdentityCoverage(root = ROOT) {
  const discovery = discoverCompilationArtifacts(root);
  const analysis = analyzeCompilationArtifacts(discovery.artifacts, discovery.errors);
  const fixture = discoverFixtureTargets(root);
  analysis.errors.push(...fixture.errors);
  const canonicalSet = new Set(analysis.canonicalTargets);
  const legacyTargets = discoverLegacyMappingTargets(root);
  let temporalFactDisposition = null;
  try {
    const normalized = loadNormalizedModuleIr(root);
    const inventory = loadMaterializedTargetInventory(root).inventory;
    const disposition = loadTemporalFactMaterializationDisposition(root).disposition;
    const sources = discoverProductionCompilationRefs(root).map((ref) => (
      readExactJcs(root, ref, `materialized identity coverage source ${ref.path}`)
    ));
    temporalFactDisposition = validateTemporalFactMaterializationDisposition(
      normalized,
      inventory,
      sources,
      disposition,
    );
  } catch (cause) {
    addError(
      analysis.errors,
      cause.code || 'TEMPORALFACT_DISPOSITION_VALIDATION_FAILURE',
      'temporalfact-materialization-disposition',
      cause.message,
    );
  }
  return {
    ...analysis,
    errors: analysis.errors,
    fixtureTargets: fixture.targets,
    fixtureOnlyTargets: fixture.targets.filter((target) => !canonicalSet.has(target)),
    legacyMappingTargets: legacyTargets,
    legacyOnlyTargets: legacyTargets.filter((target) => !canonicalSet.has(target)),
    temporalFactDisposition,
  };
}

function assertMaterializedIdentityCoverage(root = ROOT) {
  const report = auditMaterializedIdentityCoverage(root);
  if (report.errors.length > 0) throw new MaterializedIdentityCoverageError(report.errors);
  return report;
}

module.exports = {
  CANONICAL_SCOPES,
  FIXTURE_DYNAMIC_TYPES,
  FIXTURE_STATIC_TYPES,
  MaterializedIdentityCoverageError,
  analyzeCompilationArtifacts,
  assertMaterializedIdentityCoverage,
  auditMaterializedIdentityCoverage,
  discoverCompilationArtifacts,
  discoverFixtureTargets,
  discoverLegacyMappingTargets,
  isCompilationArtifact,
  moduleOf,
};
