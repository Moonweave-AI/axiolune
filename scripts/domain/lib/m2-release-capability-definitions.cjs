'use strict';

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const RELEASE_CAPABILITY_EVIDENCE_USE =
  'interface-conformance-only-not-release-eligibility-evidence';
const REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE =
  'required-gate-semantic-replay-v1';

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function sorted(values) {
  return [...values].sort(compareUtf8);
}

const CRITERION_REFS = Object.freeze(
  Array.from({ length: 6 }, (_, index) => `${PROFILE_REF}/criteria/${index + 1}`),
);

const REQUIRED_GATE_IDS = Object.freeze(sorted([
  'aggregate-pre-manifest',
  'artifact-dependency-dag',
  'compatibility-migration',
  'cq-coverage-execution',
  'm2-compile',
  'm3-import-digest',
  'm3-schema',
  'mapping-materialization',
  'module-import-dag',
  'owl-dl-profile',
  'owl-reasoner-primary',
  'owl-reasoner-secondary',
  'pit-execution',
  'projection-determinism-drift',
  'public-symbol-term-coverage',
  'reference-coverage-traceability',
  'release-bundle-tamper',
  'replay-equivalence',
  'shacl-execution',
  'shacl-meta',
  'source-mutation',
  'target-identity-contract',
]));

const PRODUCTION_REQUIRED_GATE_IDS = Object.freeze(sorted([
  'm3-import-digest',
  'm3-schema',
  'module-import-dag',
]));

const REPORT_KIND_BY_GATE = Object.freeze({
  'aggregate-pre-manifest': 'aggregate',
  'artifact-dependency-dag': 'release',
  'compatibility-migration': 'compatibility',
  'cq-coverage-execution': 'cq',
  'm2-compile': 'module',
  'm3-import-digest': 'import',
  'm3-schema': 'meta',
  'mapping-materialization': 'mapping',
  'module-import-dag': 'import',
  'owl-dl-profile': 'owl',
  'owl-reasoner-primary': 'owl',
  'owl-reasoner-secondary': 'owl',
  'pit-execution': 'pit',
  'projection-determinism-drift': 'projection',
  'public-symbol-term-coverage': 'term',
  'reference-coverage-traceability': 'reference',
  'release-bundle-tamper': 'release',
  'replay-equivalence': 'replay',
  'shacl-execution': 'shacl',
  'shacl-meta': 'shacl',
  'source-mutation': 'mutation',
  'target-identity-contract': 'identity',
});

const GATES_BY_CRITERION = Object.freeze({
  [CRITERION_REFS[0]]: Object.freeze(sorted([
    'aggregate-pre-manifest', 'm2-compile', 'm3-import-digest', 'm3-schema',
    'module-import-dag', 'target-identity-contract',
  ])),
  [CRITERION_REFS[1]]: Object.freeze(sorted([
    'aggregate-pre-manifest', 'public-symbol-term-coverage',
    'reference-coverage-traceability',
  ])),
  [CRITERION_REFS[2]]: Object.freeze(sorted([
    'aggregate-pre-manifest', 'owl-dl-profile', 'owl-reasoner-primary',
    'owl-reasoner-secondary', 'projection-determinism-drift',
    'shacl-execution', 'shacl-meta',
  ])),
  [CRITERION_REFS[3]]: Object.freeze(sorted([
    'aggregate-pre-manifest', 'cq-coverage-execution',
  ])),
  [CRITERION_REFS[4]]: Object.freeze(sorted([
    'aggregate-pre-manifest', 'mapping-materialization', 'pit-execution',
    'replay-equivalence', 'target-identity-contract',
  ])),
  [CRITERION_REFS[5]]: Object.freeze(sorted([
    'aggregate-pre-manifest', 'artifact-dependency-dag',
    'compatibility-migration', 'release-bundle-tamper', 'source-mutation',
  ])),
});

const RELEASE_CHECK_IDS = Object.freeze({
  adoptionVerification: Object.freeze(sorted([
    'adoption-result-matrix', 'approval-signature-scope',
    'artifact-dependency-dag', 'attempt-challenge-signature-state',
    'authoritative-commit-tree', 'cas-old-new-ref',
    'challenge-time-sequence', 'checkout-cleanliness',
    'checkout-manifest-equality', 'eligibility', 'payload-reverification',
    'ref-update-receipt',
  ])),
  approvalEligibility: Object.freeze(sorted([
    'aggregate-pre-manifest', 'eligibility-result-matrix',
    'payload-verification', 'six-criterion-closure',
  ])),
  p0Verification: Object.freeze(sorted([
    'artifact-dependency-dag', 'build-binding', 'control-record-collisions',
    'git-object', 'manifest-inventory', 'manifest-schema',
    'report-ledger-closure', 'required-gates', 'source-tree',
    'tool-policy-locks', 'traceability-index',
  ])),
  payloadVerification: Object.freeze(sorted([
    'artifact-dependency-dag', 'compatibility-migration',
    'control-record-collisions', 'detached-exclusion', 'entry-bytes',
    'exact-payload-closure', 'generated-drift', 'manifest-schema-inventory',
    'p0-chain-signature', 'p0p1-diff-policy', 'p1-build-locks',
    'p1-report-ledger-closure', 'p1-source-tree-git-object',
    'payload-artifact-catalog', 'traceability-closure',
  ])),
});

const CHECK_DEPENDENCIES = Object.freeze({
  adoptionVerification: Object.freeze({
    'attempt-challenge-signature-state': [],
    'approval-signature-scope': ['attempt-challenge-signature-state'],
    eligibility: ['approval-signature-scope'],
    'ref-update-receipt': ['eligibility'],
    'cas-old-new-ref': ['ref-update-receipt'],
    'challenge-time-sequence': ['ref-update-receipt'],
    'authoritative-commit-tree': ['cas-old-new-ref'],
    'payload-reverification': ['authoritative-commit-tree'],
    'checkout-cleanliness': ['authoritative-commit-tree'],
    'checkout-manifest-equality': ['checkout-cleanliness', 'payload-reverification'],
    'artifact-dependency-dag': [
      'approval-signature-scope', 'attempt-challenge-signature-state',
      'authoritative-commit-tree', 'cas-old-new-ref', 'challenge-time-sequence',
      'checkout-cleanliness', 'checkout-manifest-equality', 'eligibility',
      'payload-reverification', 'ref-update-receipt',
    ],
    'adoption-result-matrix': [
      'approval-signature-scope', 'artifact-dependency-dag',
      'attempt-challenge-signature-state', 'authoritative-commit-tree',
      'cas-old-new-ref', 'challenge-time-sequence', 'checkout-cleanliness',
      'checkout-manifest-equality', 'eligibility', 'payload-reverification',
      'ref-update-receipt',
    ],
  }),
  approvalEligibility: Object.freeze({
    'aggregate-pre-manifest': [],
    'payload-verification': [],
    'six-criterion-closure': ['aggregate-pre-manifest', 'payload-verification'],
    'eligibility-result-matrix': ['six-criterion-closure'],
  }),
  p0Verification: Object.freeze({
    'manifest-schema': [],
    'manifest-inventory': ['manifest-schema'],
    'source-tree': ['manifest-inventory'],
    'git-object': ['source-tree'],
    'build-binding': ['git-object'],
    'tool-policy-locks': ['build-binding'],
    'required-gates': ['tool-policy-locks'],
    'report-ledger-closure': ['required-gates'],
    'traceability-index': ['report-ledger-closure'],
    'control-record-collisions': ['report-ledger-closure'],
    'artifact-dependency-dag': [
      'build-binding', 'control-record-collisions', 'git-object',
      'manifest-inventory', 'manifest-schema', 'report-ledger-closure',
      'required-gates', 'source-tree', 'tool-policy-locks', 'traceability-index',
    ],
  }),
  payloadVerification: Object.freeze({
    'manifest-schema-inventory': [],
    'payload-artifact-catalog': ['manifest-schema-inventory'],
    'exact-payload-closure': ['payload-artifact-catalog'],
    'entry-bytes': ['exact-payload-closure'],
    'detached-exclusion': ['exact-payload-closure'],
    'p1-source-tree-git-object': ['entry-bytes'],
    'p0-chain-signature': ['p1-source-tree-git-object'],
    'p0p1-diff-policy': ['p0-chain-signature'],
    'p1-build-locks': ['p0p1-diff-policy'],
    'p1-report-ledger-closure': ['p1-build-locks'],
    'generated-drift': ['p1-report-ledger-closure'],
    'traceability-closure': ['p1-report-ledger-closure'],
    'compatibility-migration': ['p1-report-ledger-closure'],
    'control-record-collisions': ['p1-report-ledger-closure'],
    'artifact-dependency-dag': [
      'compatibility-migration', 'control-record-collisions',
      'detached-exclusion', 'entry-bytes', 'exact-payload-closure',
      'generated-drift', 'manifest-schema-inventory', 'p0-chain-signature',
      'p0p1-diff-policy', 'p1-build-locks', 'p1-report-ledger-closure',
      'p1-source-tree-git-object', 'payload-artifact-catalog',
      'traceability-closure',
    ],
  }),
});

const GATE_ASSERTIONS = Object.freeze({
  'aggregate-pre-manifest': ['dependency-report-exact-set', 'same-build', 'all-results-passed'],
  'artifact-dependency-dag': ['complete-prefix', 'acyclic', 'digest-edge-closure'],
  'compatibility-migration': ['breaking-change-inventory', 'migration-path', 'rollback-path'],
  'cq-coverage-execution': ['release-cq-inventory', 'positive-execution', 'negative-execution'],
  'm2-compile': ['strict-authoring-schema', 'global-iri-closure', 'typed-projection-input'],
  'm3-import-digest': ['content-addressed-imports', 'digest-closure', 'version-closure'],
  'm3-schema': ['closed-meta-schema', 'strict-structure', 'negative-schema-corpus'],
  'mapping-materialization': ['mapping-source-closure', 'deterministic-output', 'provenance-binding'],
  'module-import-dag': ['module-inventory', 'acyclic-imports', 'exact-version-imports'],
  'owl-dl-profile': ['owl-dl-profile', 'profile-negative-control', 'flattened-closure'],
  'owl-reasoner-primary': ['primary-reasoner-pinned', 'consistent-positive', 'inconsistent-negative'],
  'owl-reasoner-secondary': ['secondary-reasoner-pinned', 'consistent-positive', 'inconsistent-negative'],
  'pit-execution': ['reference-time-binding', 'knowledge-time-filter', 'expected-pit-result'],
  'projection-determinism-drift': ['double-generation', 'byte-equality', 'source-projection-binding'],
  'public-symbol-term-coverage': ['public-symbol-inventory', 'accepted-term-card', 'generated-inheritance'],
  'reference-coverage-traceability': ['locked-reference-bytes', 'review-coverage', 'traceability-closure'],
  'release-bundle-tamper': ['missing-rejected', 'extra-rejected', 'byte-manifest-git-tamper-rejected'],
  'replay-equivalence': ['source-snapshot-replay', 'ontology-mapping-locks', 'byte-equivalent-output'],
  'shacl-execution': ['exact-constraint-inventory', 'positive-and-negative-cases', 'engine-execution'],
  'shacl-meta': ['shape-parse', 'shape-meta-validation', 'constraint-component-binding'],
  'source-mutation': ['pre-snapshot', 'post-snapshot', 'no-source-delta'],
  'target-identity-contract': ['identity-key-inventory', 'cross-module-reference', 'materialized-identity'],
});

const GATE_IMPLEMENTATION_PATHS = Object.freeze({
  'aggregate-pre-manifest': ['scripts/domain/lib/m2-release-verifier.cjs'],
  'artifact-dependency-dag': [
    'scripts/domain/lib/m2-release-verifier.cjs',
    'scripts/domain/lib/m2-build-dependency-replay.cjs',
    'scripts/domain/lib/m2-payload-closure-replay.cjs',
    'scripts/domain/lib/m2-payload-independent-replay.cjs',
  ],
  'compatibility-migration': ['scripts/domain/lib/m2-release-verifier.cjs'],
  'cq-coverage-execution': ['scripts/domain/run-all-cq-probes.cjs'],
  'm2-compile': ['scripts/domain/validate-m2-core.js'],
  'm3-import-digest': ['scripts/meta/verify-meta-model.js'],
  'm3-schema': ['scripts/meta/validate-structure.js'],
  'mapping-materialization': [
    'scripts/domain/run-s5-control-record-chain.cjs',
    'scripts/domain/lib/s5-control-record-chain.cjs',
    'scripts/domain/lib/s5-canonical-materialization.cjs',
    'scripts/domain/lib/s5-completed-run-producer-replay.cjs',
  ],
  'module-import-dag': [
    'scripts/domain/lib/canonical-finance-dag.cjs',
    'scripts/domain/lib/module-import-dag-validator.cjs',
  ],
  'owl-dl-profile': ['scripts/domain/run-owl-dl-gate.cjs'],
  'owl-reasoner-primary': ['scripts/domain/run-owl-dl-gate.cjs'],
  'owl-reasoner-secondary': ['scripts/domain/run-owl-dl-gate.cjs'],
  'pit-execution': [
    'scripts/domain/validate-pit.cjs',
    'scripts/domain/lib/s5-control-record-chain.cjs',
    'scripts/domain/lib/s5-completed-run-producer-replay.cjs',
    'scripts/domain/lib/m2-pit-validation-request.cjs',
  ],
  'projection-determinism-drift': [
    'scripts/domain/generate-m2-owl.cjs',
    'scripts/domain/generate-m2-shacl.cjs',
    'scripts/meta/test-projection.js',
  ],
  'public-symbol-term-coverage': [
    'scripts/domain/generate-public-symbol-manifest.cjs',
    'scripts/domain/generate-term-card-manifest.cjs',
  ],
  'reference-coverage-traceability': [
    'scripts/domain/validate-reference-closure.cjs',
    'scripts/domain/generate-m2-traceability-manifest.cjs',
  ],
  'release-bundle-tamper': [
    'scripts/domain/lib/m2-release-verifier.cjs',
    'scripts/domain/tests/test-m2-release-verifier.cjs',
  ],
  'replay-equivalence': [
    'scripts/domain/lib/m2-release-verifier.cjs',
    'scripts/domain/lib/m2-toolchain-replay.cjs',
  ],
  'shacl-execution': [
    'scripts/domain/run-m2-shacl-instance-closure.cjs',
    'scripts/domain/lib/m2-constraint-instance-p1-replay.cjs',
  ],
  'shacl-meta': [
    'scripts/domain/generate-m2-shacl.cjs',
    'scripts/domain/lib/m2-shacl-instance-fixture-compiler.cjs',
  ],
  'source-mutation': [
    'scripts/domain/test-all-domain.js',
    'scripts/domain/lib/m2-release-verifier.cjs',
  ],
  'target-identity-contract': [
    'scripts/domain/test-materialized-identity-coverage.cjs',
    'scripts/domain/lib/m2-traceability-builder.cjs',
  ],
});

const P1_COMPONENT_REPLAY_IMPLEMENTATION_PATH =
  'scripts/domain/lib/m2-component-p1-replay.cjs';
const GATE_ARTIFACT_BINDING_REPLAY_IMPLEMENTATION_PATH =
  'scripts/domain/lib/m2-gate-artifact-binding-replay.cjs';
const REQUIRED_GATE_SEMANTIC_REPLAY_IMPLEMENTATION_PATH =
  'scripts/domain/lib/m2-required-gate-semantic-replay.cjs';
const PRODUCTION_REQUIRED_GATE_ENTRYPOINT_PATH =
  'scripts/domain/run-production-required-gate.cjs';
const M3_REQUIRED_GATE_ENTRYPOINT_PATH = PRODUCTION_REQUIRED_GATE_ENTRYPOINT_PATH;
const PRODUCTION_REQUIRED_GATE_COMMON_IMPLEMENTATION_PATHS = Object.freeze(sorted([
  'scripts/domain/lib/m2-release-capability-definitions.cjs',
  'scripts/domain/lib/production-required-gate-semantic-adapters.cjs',
  'scripts/domain/lib/strict-source-locator.cjs',
  PRODUCTION_REQUIRED_GATE_ENTRYPOINT_PATH,
]));
const M3_REQUIRED_GATE_IMPLEMENTATION_PATHS = Object.freeze(sorted([
  ...PRODUCTION_REQUIRED_GATE_COMMON_IMPLEMENTATION_PATHS,
  'scripts/domain/lib/m3-required-gate-semantic-adapter.cjs',
  'scripts/meta/lib/structure-negative-corpus.js',
  'scripts/meta/validate-structure.js',
  'scripts/meta/verify-meta-model.js',
]));
const MODULE_IMPORT_DAG_REQUIRED_GATE_IMPLEMENTATION_PATHS = Object.freeze(sorted([
  ...PRODUCTION_REQUIRED_GATE_COMMON_IMPLEMENTATION_PATHS,
  'scripts/domain/lib/canonical-finance-dag.cjs',
  'scripts/domain/lib/module-import-dag-required-gate-semantic-adapter.cjs',
  'scripts/domain/lib/module-import-dag-validator.cjs',
  'scripts/domain/lib/public-symbol-compiler.cjs',
]));

function productionRequiredGateImplementationPaths(gateId) {
  if (!PRODUCTION_REQUIRED_GATE_IDS.includes(gateId)) {
    throw new Error(`${String(gateId)} is not a production required gate`);
  }
  return gateId === 'module-import-dag'
    ? [...MODULE_IMPORT_DAG_REQUIRED_GATE_IMPLEMENTATION_PATHS]
    : [...M3_REQUIRED_GATE_IMPLEMENTATION_PATHS];
}

function gateSemanticImplementationPaths(gateId) {
  if (PRODUCTION_REQUIRED_GATE_IDS.includes(gateId)) {
    return productionRequiredGateImplementationPaths(gateId);
  }
  const gateSpecific = GATE_IMPLEMENTATION_PATHS[gateId];
  if (Array.isArray(gateSpecific) && gateSpecific.length > 0) {
    return sorted(gateSpecific);
  }
  return sorted([
    GATE_ARTIFACT_BINDING_REPLAY_IMPLEMENTATION_PATH,
    P1_COMPONENT_REPLAY_IMPLEMENTATION_PATH,
    REQUIRED_GATE_SEMANTIC_REPLAY_IMPLEMENTATION_PATH,
  ]);
}

const RELEASE_CHECK_IMPLEMENTATION_PATHS = Object.freeze([
  'scripts/domain/lib/m2-release-verifier.cjs',
  'scripts/domain/lib/m2-build-dependency-replay.cjs',
  GATE_ARTIFACT_BINDING_REPLAY_IMPLEMENTATION_PATH,
  'scripts/domain/lib/m2-payload-closure-replay.cjs',
  'scripts/domain/lib/m2-payload-independent-replay.cjs',
  REQUIRED_GATE_SEMANTIC_REPLAY_IMPLEMENTATION_PATH,
  'scripts/domain/lib/rdfc-1.0.cjs',
  'scripts/domain/lib/rdfc-1.0-worker.cjs',
  P1_COMPONENT_REPLAY_IMPLEMENTATION_PATH,
]);

function expectedCriterionRefsForGate(gateId) {
  return CRITERION_REFS.filter((criterionRef) => GATES_BY_CRITERION[criterionRef].includes(gateId));
}

function gateDependencies(gateId) {
  if (gateId === 'aggregate-pre-manifest') {
    return REQUIRED_GATE_IDS.filter((id) => id !== 'aggregate-pre-manifest');
  }
  if (gateId === 'artifact-dependency-dag') {
    return REQUIRED_GATE_IDS.filter(
      (id) => !['aggregate-pre-manifest', 'artifact-dependency-dag'].includes(id),
    );
  }
  return [];
}

function checkDependencies(stageId, checkId) {
  return sorted(CHECK_DEPENDENCIES[stageId]?.[checkId] || []);
}

function gateCapabilityId(gateId) {
  return `gate.${gateId}`;
}

function checkCapabilityId(stageId, checkId) {
  return `check.${stageId}.${checkId}`;
}

function checkAssertions(stageId, checkId) {
  return [
    `${stageId}-input-closure`,
    `${checkId}-recomputed`,
    `${stageId}-evidence-schema`,
  ].sort(compareUtf8);
}

function releaseCapabilityDefinitions() {
  const definitions = REQUIRED_GATE_IDS.map((gateId) => ({
    bindingKind: 'requiredGate',
    capabilityId: gateCapabilityId(gateId),
    subjectId: gateId,
    stageId: null,
    reportKind: REPORT_KIND_BY_GATE[gateId],
    criterionRefs: expectedCriterionRefsForGate(gateId),
    dependsOn: gateDependencies(gateId),
    requiredAssertions: sorted(GATE_ASSERTIONS[gateId]),
    implementationMode: PRODUCTION_REQUIRED_GATE_IDS.includes(gateId)
      ? REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE
      : RELEASE_CAPABILITY_EVIDENCE_USE,
    entrypointPath: PRODUCTION_REQUIRED_GATE_IDS.includes(gateId)
      ? PRODUCTION_REQUIRED_GATE_ENTRYPOINT_PATH
      : 'scripts/domain/run-release-capability.cjs',
    semanticImplementationPaths: gateSemanticImplementationPaths(gateId),
  }));
  for (const stageId of Object.keys(RELEASE_CHECK_IDS).sort(compareUtf8)) {
    for (const checkId of RELEASE_CHECK_IDS[stageId]) {
      definitions.push({
        bindingKind: 'releaseCheck',
        capabilityId: checkCapabilityId(stageId, checkId),
        subjectId: checkId,
        stageId,
        reportKind: null,
        criterionRefs: [],
        dependsOn: checkDependencies(stageId, checkId),
        requiredAssertions: checkAssertions(stageId, checkId),
        implementationMode: RELEASE_CAPABILITY_EVIDENCE_USE,
        entrypointPath: 'scripts/domain/run-release-capability.cjs',
        semanticImplementationPaths: [...RELEASE_CHECK_IMPLEMENTATION_PATHS],
      });
    }
  }
  return definitions.sort((left, right) => compareUtf8(left.capabilityId, right.capabilityId));
}

module.exports = {
  CHECK_DEPENDENCIES,
  CRITERION_REFS,
  GATES_BY_CRITERION,
  GATE_IMPLEMENTATION_PATHS,
  GATE_ARTIFACT_BINDING_REPLAY_IMPLEMENTATION_PATH,
  M3_REQUIRED_GATE_ENTRYPOINT_PATH,
  M3_REQUIRED_GATE_IMPLEMENTATION_PATHS,
  MODULE_IMPORT_DAG_REQUIRED_GATE_IMPLEMENTATION_PATHS,
  P1_COMPONENT_REPLAY_IMPLEMENTATION_PATH,
  PRODUCTION_REQUIRED_GATE_COMMON_IMPLEMENTATION_PATHS,
  PRODUCTION_REQUIRED_GATE_ENTRYPOINT_PATH,
  REQUIRED_GATE_SEMANTIC_REPLAY_IMPLEMENTATION_PATH,
  PROFILE_REF,
  PRODUCTION_REQUIRED_GATE_IDS,
  RELEASE_CAPABILITY_EVIDENCE_USE,
  REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE,
  RELEASE_CHECK_IDS,
  REPORT_KIND_BY_GATE,
  RELEASE_CHECK_IMPLEMENTATION_PATHS,
  REQUIRED_GATE_IDS,
  checkAssertions,
  checkCapabilityId,
  checkDependencies,
  compareUtf8,
  expectedCriterionRefsForGate,
  gateCapabilityId,
  gateDependencies,
  gateSemanticImplementationPaths,
  productionRequiredGateImplementationPaths,
  releaseCapabilityDefinitions,
};
