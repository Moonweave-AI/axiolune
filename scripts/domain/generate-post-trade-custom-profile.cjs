#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  POST_TRADE_CUSTOM_CONTRACT_LOCK,
  auditPostTradeCustomContracts,
} = require('./lib/post-trade-custom-contract-audit.cjs');
const {
  PATHS,
  PROFILE_REF,
  ROOT,
  VECTOR_CONFIG,
  compareUtf8,
} = require('./lib/post-trade-custom-profile.cjs');
const {
  customConstraintDispatchDescriptor,
  mutate,
  refreshMissingSideRuntimeEvidence,
} = require('./lib/post-trade-v03-contract.cjs');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');
const {
  authenticateSourceClaims,
} = require('./lib/post-trade-risk-source-artifact-inventory.cjs');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function artifactRef(file) {
  return {
    kind: 'path',
    path: path.relative(ROOT, file).split(path.sep).join('/'),
    root: 'sourceTree',
  };
}

function exactSet(values) {
  const sorted = [...values].sort(compareUtf8);
  if (new Set(sorted).size !== sorted.length) throw new Error('fixture inventory contains duplicate IDs');
  return { count: sorted.length, digest: sha256(jcsBytes(sorted)), values: sorted };
}

function parseYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function canonicalSourceScenario(instance) {
  return refreshMissingSideRuntimeEvidence(
    authenticateSourceClaims(instance, { namespace: 'post-trade-source' }),
  );
}

function buildDiscovery(moduleDocument, implementationDigest) {
  auditPostTradeCustomContracts(moduleDocument);
  const custom = Object.values(moduleDocument.domain?.constraints || {})
    .filter((constraint) => constraint.expression?.language === 'Custom')
    .sort((left, right) => compareUtf8(left.iri, right.iri));
  if (custom.length !== 31) throw new Error(`post-trade module must expose 31 Custom constraints, got ${custom.length}`);
  const configByIri = new Map(VECTOR_CONFIG.map((row) => [row.constraintIri, row]));
  const rows = custom.map((constraint) => {
    const config = configByIri.get(constraint.iri);
    if (!config) throw new Error(`unbound post-trade Custom constraint ${constraint.iri}`);
    const lock = POST_TRADE_CUSTOM_CONTRACT_LOCK[config.validatorId];
    if (!lock || lock.iri !== constraint.iri) throw new Error(`${constraint.iri} is absent from the independent expression lock`);
    const bindings = (moduleDocument.domain?.constraintBindings || []).filter(
      (binding) => binding.constraintRef === constraint.iri,
    );
    if (bindings.length !== 1
        || bindings[0].targetElement !== constraint.targetElement
        || bindings[0].enforcementLevel !== 'Mandatory') {
      throw new Error(`${constraint.iri} lacks one exact Mandatory target binding`);
    }
    const expressionTextDigest = sha256(Buffer.from(constraint.expression.expression, 'utf8'));
    if (expressionTextDigest !== `sha256:${lock.expressionSha256}`) {
      throw new Error(`${constraint.iri} expression text drifted from the independent lock`);
    }
    const dispatch = customConstraintDispatchDescriptor(config.validatorId);
    if (dispatch.fixtureContract !== config.fixtureContract
        || !dispatch.ownedViolationCodes.includes(config.expectedViolation)) {
      throw new Error(`${constraint.iri} is not owned by its constraint-specific dispatch`);
    }
    return {
      constraintIri: constraint.iri,
      dispatchDigest: dispatch.dispatchDigest,
      evaluatorId: dispatch.evaluatorId,
      expressionDigest: sha256(jcsBytes(constraint.expression)),
      expressionTextDigest,
      fixtureContract: config.fixtureContract,
      implementationDigest,
      implementationRef: artifactRef(PATHS.implementation),
      module: 'fin-post-trade-operations',
      scope: constraint.scope,
      targetElement: constraint.targetElement,
      violationCodeSetDigest: sha256(jcsBytes(dispatch.ownedViolationCodes)),
      validatorId: config.validatorId,
    };
  });
  if (rows.length !== configByIri.size) throw new Error('post-trade Custom vector configuration has an extra row');
  return {
    constraints: rows,
    profileRef: PROFILE_REF,
    runtimeId: 'axiolune-post-trade-custom-runtime-v1',
    schemaVersion: '1.0',
  };
}

function corpusDescriptor(file, ids) {
  const set = exactSet(ids);
  return {
    artifactDigest: sha256(fs.readFileSync(file)),
    artifactRef: artifactRef(file),
    itemCount: set.count,
    itemIdSetDigest: set.digest,
  };
}

function buildVectors() {
  const positiveDocument = parseYaml(PATHS.positive);
  const negativeDocument = parseYaml(PATHS.negative);
  const processingFindingPositive = parseYaml(PATHS.processingFindingPositive);
  const processingFindingNegative = parseYaml(PATHS.processingFindingNegative);
  const positives = new Map((positiveDocument.fixtures || []).map((fixture) => [fixture.id, fixture]));
  const negatives = new Map((negativeDocument.cases || []).map((testCase) => [testCase.id, testCase]));
  if (positives.size !== 8 || negatives.size !== 219) {
    throw new Error(`post-trade fixture corpus must remain 8 positive / 219 negative, got ${positives.size}/${negatives.size}`);
  }
  const standardPositiveIds = [...positives.keys()];
  const standardNegativeIds = [...negatives.keys()];
  const supplementalPositive = processingFindingPositive.fixture;
  if (!supplementalPositive || supplementalPositive.contract !== 'CorporateActionProcessingFinding') {
    throw new Error('processing-finding positive fixture identity drift');
  }
  const supplementalCases = processingFindingNegative.cases || [];
  if (processingFindingNegative.baseFixtureId !== supplementalPositive.id || supplementalCases.length !== 14) {
    throw new Error('processing-finding negative fixture inventory drift');
  }
  positives.set(supplementalPositive.id, supplementalPositive);
  for (const testCase of supplementalCases) {
    if (negatives.has(testCase.id)) throw new Error(`duplicate supplemental negative ID ${testCase.id}`);
    negatives.set(testCase.id, { ...testCase, baseFixtureId: processingFindingNegative.baseFixtureId });
  }
  const vectors = VECTOR_CONFIG
    .map((config) => {
      const positive = positives.get(config.positiveFixtureId);
      if (!positive || positive.contract !== config.fixtureContract) {
        throw new Error(`${config.constraintIri} positive fixture/contract binding drift`);
      }
      const acceptedScenario = canonicalSourceScenario(positive.instance);
      let negativeScenario;
      let negativeMutations;
      let negativeSourceId;
      if (config.negativeCaseId) {
        const testCase = negatives.get(config.negativeCaseId);
        if (!testCase || testCase.baseFixtureId !== positive.id
            || testCase.expectedViolation !== config.expectedViolation) {
          throw new Error(`${config.constraintIri} negative fixture join drift`);
        }
        negativeScenario = acceptedScenario;
        negativeMutations = testCase.mutations || [];
        for (const mutation of negativeMutations) negativeScenario = mutate(negativeScenario, mutation);
        negativeSourceId = testCase.id;
      } else {
        negativeMutations = [config.inlineNegativeMutation];
        negativeScenario = mutate(acceptedScenario, config.inlineNegativeMutation);
        negativeSourceId = `${config.validatorId}-inline-negative`;
      }
      if (!negativeMutations.some((mutation) => (
        /(?:^|\.)(?:sourceArtifactRef|sourceArtifactDigest|sourceLocator)(?:\.|$)/u
          .test(mutation.path)
      ))) {
        negativeScenario = canonicalSourceScenario(negativeScenario);
      }
      const acceptedFixture = {
        contract: positive.contract,
        instance: acceptedScenario,
      };
      const rejectedFixture = {
        contract: positive.contract,
        instance: negativeScenario,
      };
      return {
        accepted: {
          caseId: `${config.validatorId}-accepted`,
          fixture: acceptedFixture,
          fixtureDigest: sha256(jcsBytes(acceptedFixture)),
          sourceFixtureId: positive.id,
        },
        constraintIri: config.constraintIri,
        validatorId: config.validatorId,
        violation: {
          caseId: `${config.validatorId}-violation`,
          expectedCode: config.expectedViolation,
          fixture: rejectedFixture,
          fixtureDigest: sha256(jcsBytes(rejectedFixture)),
          sourceFixtureId: negativeSourceId,
        },
      };
    })
    .sort((left, right) => compareUtf8(left.constraintIri, right.constraintIri));
  return {
    fixtureCorpus: {
      negative: corpusDescriptor(PATHS.negative, standardNegativeIds),
      positive: corpusDescriptor(PATHS.positive, standardPositiveIds),
      processingFindingNegative: corpusDescriptor(
        PATHS.processingFindingNegative,
        supplementalCases.map((testCase) => testCase.id),
      ),
      processingFindingPositive: corpusDescriptor(
        PATHS.processingFindingPositive,
        [supplementalPositive.id],
      ),
    },
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    vectors,
  };
}

function buildClosure(discoveryBytes, vectorBytes) {
  const supplied = new Map([
    [PATHS.discovery, discoveryBytes],
    [PATHS.vectors, vectorBytes],
  ]);
  const artifacts = [
    ['audit', PATHS.audit],
    ['discovery', PATHS.discovery],
    ['generator', PATHS.generator],
    ['implementation', PATHS.implementation],
    ['jsonPointerExtractor', PATHS.jsonPointerExtractor],
    ['jsonPointerProfile', PATHS.jsonPointerProfile],
    ['negativeFixtures', PATHS.negative],
    ['ontologySource', PATHS.module],
    ['positiveFixtures', PATHS.positive],
    ['processingFindingNegativeFixtures', PATHS.processingFindingNegative],
    ['processingFindingPositiveFixtures', PATHS.processingFindingPositive],
    ['profileLibrary', PATHS.profileLibrary],
    ['runner', PATHS.runner],
    ['strictJcs', PATHS.strictJcs],
    ['sourceArtifactInventory', PATHS.sourceArtifactInventory],
    ['vectors', PATHS.vectors],
    ['worker', PATHS.worker],
  ].map(([role, file]) => ({
    digest: sha256(supplied.get(file) || fs.readFileSync(file)),
    ref: artifactRef(file),
    role,
  })).sort((left, right) => compareUtf8(left.ref.path, right.ref.path));
  return {
    artifacts,
    closureDigest: sha256(Buffer.concat([
      Buffer.from('axiolune-post-trade-custom-closure-v1\0', 'utf8'),
      jcsBytes(artifacts),
    ])),
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
}

function expectedArtifacts() {
  const moduleDocument = parseYaml(PATHS.module);
  const discovery = buildDiscovery(moduleDocument, sha256(fs.readFileSync(PATHS.implementation)));
  const vectors = buildVectors();
  const discoveryBytes = jcsBytes(discovery);
  const vectorBytes = jcsBytes(vectors);
  return [
    [PATHS.discovery, discoveryBytes],
    [PATHS.vectors, vectorBytes],
    [PATHS.closure, jcsBytes(buildClosure(discoveryBytes, vectorBytes))],
  ];
}

function main(argv) {
  if (argv.length !== 1 || !['--write', '--check'].includes(argv[0])) {
    throw new Error('Usage: node scripts/domain/generate-post-trade-custom-profile.cjs --write|--check');
  }
  const artifacts = expectedArtifacts();
  if (argv[0] === '--write') {
    fs.mkdirSync(path.dirname(PATHS.discovery), { recursive: true });
    for (const [file, content] of artifacts) {
      fs.writeFileSync(file, content);
      process.stdout.write(`wrote ${file}\n`);
    }
  } else {
    for (const [file, content] of artifacts) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) {
        throw new Error(`Post-trade Custom artifact drift: ${path.relative(ROOT, file)}`);
      }
    }
  }
  process.stdout.write(`PASS Post-trade Custom profile (${argv[0].slice(2)}, 31 bindings, 8/219 + 1/14 corpus)\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildClosure,
  buildDiscovery,
  buildVectors,
  expectedArtifacts,
};
