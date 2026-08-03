#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  BINDING_ROWS,
  CONSTRAINT_BINDINGS,
  CUSTOM_CONSTRAINT_COUNT,
  canonicalJcs,
  compareUtf8,
} = require('./lib/foundation-market-strategy-custom-validators.cjs');
const {
  PATHS,
  PROFILE_REF,
  ROOT,
  buildVectorSet,
  relative,
  sha256,
} = require('./lib/foundation-market-strategy-custom-profile.cjs');

const MODULE_IDS = Object.freeze([
  ['fin-foundation', 'foundation'],
  ['fin-instruments', 'instruments'],
  ['fin-market-data', 'market-data'],
  ['fin-market-rules', 'market-rules'],
  ['fin-market-structure', 'market-structure'],
  ['fin-strategy-research', 'strategy-research'],
]);

const IDENTIFIER_CUSTOM = new Set([
  'https://axiolune.ai/ontology/finance/foundation/ISINValidation',
  'https://axiolune.ai/ontology/finance/foundation/LEIValidation',
  'https://axiolune.ai/ontology/finance/foundation/LocalIdentifierValidation',
  'https://axiolune.ai/ontology/finance/foundation/MICValidation',
]);

const CONTRACT_IMPLEMENTATIONS = Object.freeze({
  'foundation-account': [
    'scripts/domain/test-foundation-account-identity.cjs',
    'scripts/domain/lib/foundation-identifier-custom.cjs',
    'scripts/domain/lib/foundation-identifier-capability.cjs',
  ],
  'foundation-market-rules': [
    'scripts/domain/lib/foundation-market-rules-contract.cjs',
  ],
  'market-data-v03': [
    'scripts/domain/lib/decimal-lexical.cjs',
    'scripts/domain/lib/instant-lexical.cjs',
    'scripts/domain/lib/json-pointer-source-extractor.cjs',
    'scripts/domain/lib/market-data-calculation-run-v1.schema.json',
    'scripts/domain/lib/market-data-release-evidence.cjs',
    'scripts/domain/lib/market-data-v03-contracts.cjs',
    'scripts/domain/lib/pattern-injected-fields.cjs',
    'scripts/domain/lib/source-evidence-reference.cjs',
    'scripts/domain/lib/strict-source-locator.cjs',
    'scripts/domain/lib/whole-file-source-extractor.cjs',
  ],
  'market-rules-v03': [
    'scripts/domain/lib/market-rules-cq.cjs',
  ],
  'slice-a': [
    'scripts/domain/lib/slice-a-market-contracts.cjs',
  ],
  'strategy-research': [
    'scripts/domain/lib/strategy-research-contracts.cjs',
  ],
});

function bytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function artifactRef(file) {
  return { kind: 'path', path: relative(file), root: 'sourceTree' };
}

function fileRow(relativePath) {
  const file = path.join(ROOT, ...relativePath.split('/'));
  return { digest: sha256(fs.readFileSync(file)), ref: artifactRef(file) };
}

function implementationRows(binding) {
  return [
    'scripts/domain/lib/foundation-market-strategy-custom-validators.cjs',
    ...CONTRACT_IMPLEMENTATIONS[binding.fixtureContract],
  ].map(fileRow).sort((left, right) => compareUtf8(left.ref.path, right.ref.path));
}

function readModules() {
  return MODULE_IDS.map(([moduleId, directory]) => {
    const file = path.join(ROOT, 'ontology/domain/finance', directory, 'module.yaml');
    return {
      document: YAML.parse(fs.readFileSync(file, 'utf8')),
      file,
      moduleId,
    };
  });
}

function buildDiscovery() {
  const modules = readModules();
  const moduleById = new Map(modules.map((module) => [module.moduleId, module]));
  const authoredCustom = new Map();
  for (const module of modules) {
    for (const constraint of Object.values(module.document.domain?.constraints || {})) {
      if (constraint.expression?.language !== 'Custom') continue;
      if (authoredCustom.has(constraint.iri)) throw new Error(`duplicate authored Custom IRI ${constraint.iri}`);
      authoredCustom.set(constraint.iri, { constraint, module });
    }
  }
  const unassigned = [...authoredCustom.keys()].filter((iri) => !CONSTRAINT_BINDINGS[iri]);
  if (unassigned.length !== 4 || unassigned.some((iri) => !IDENTIFIER_CUSTOM.has(iri))) {
    throw new Error(`unexpected Custom definition outside six-module profile: ${unassigned.join(', ')}`);
  }

  const constraints = BINDING_ROWS.map((binding) => {
    const authored = authoredCustom.get(binding.constraintIri);
    if (!authored || authored.module.moduleId !== binding.module) {
      throw new Error(`missing or wrong-module authored Custom definition ${binding.constraintIri}`);
    }
    const targetElement = authored.constraint.targetElement ?? null;
    const bindings = (authored.module.document.domain?.constraintBindings || []).filter(
      (candidate) => candidate.constraintRef === binding.constraintIri,
    );
    const targetBindings = bindings.map((candidate) => candidate.targetElement).sort(compareUtf8);
    if (targetBindings.length === 0
        || new Set(targetBindings).size !== targetBindings.length
        || (targetElement !== null && !targetBindings.includes(targetElement))) {
      throw new Error(`${binding.constraintIri} has missing, duplicate, or drifting authored target bindings`);
    }
    const implementations = implementationRows(binding);
    return {
      constraintIri: binding.constraintIri,
      definitionKind: 'ConstraintDefinition',
      dispatchDigest: binding.dispatchDigest,
      dispatchKey: binding.dispatchKey,
      expectedAtPrefix: binding.expectedAtPrefix,
      expectedCode: binding.expectedCode,
      expressionDigest: sha256(bytes(authored.constraint.expression)),
      fixtureContract: binding.fixtureContract,
      implementationDigest: sha256(bytes(implementations)),
      implementationRefs: implementations,
      module: binding.module,
      moduleRef: artifactRef(authored.module.file),
      scope: authored.constraint.scope ?? null,
      targetElement,
      targetBindings,
      validatorId: binding.validatorId,
    };
  });
  if (constraints.length !== CUSTOM_CONSTRAINT_COUNT) {
    throw new Error(`discovery must contain ${CUSTOM_CONSTRAINT_COUNT} definitions, got ${constraints.length}`);
  }
  return {
    constraintDefinitionCount: CUSTOM_CONSTRAINT_COUNT,
    constraints,
    contextContractCount: 6,
    profileRef: PROFILE_REF,
    runtimeId: 'axiolune-foundation-market-strategy-custom-runtime-v1',
    schemaVersion: '1.0',
  };
}

function inputContract() {
  return {
    closed: true,
    fields: ['constraintIri', 'dispatchDigest', 'scenario', 'schemaVersion', 'validatorId'],
    optionalFields: ['mode'],
    scenario: {
      closed: true,
      fields: [
        'decimalPaths',
        'dispatchKey',
        'fixtureContract',
        'payload',
        'scenarioId',
        'schemaVersion',
      ],
      decimalEncoding: {
        pathSyntax: 'RFC6901-JSON-Pointer',
        representation: 'canonical-non-exponent-decimal-string',
        signedJsonNumberPolicy: 'safe-integers-only',
      },
      payloadPolicy: 'exact-jcs-digest-locked-formal-fixture-context',
    },
    schemaVersion: '1.0',
  };
}

function outputContract() {
  return {
    closed: true,
    fields: [
      'assurance',
      'constraintIri',
      'dispatchDigest',
      'observedViolationCodes',
      'observedViolationOwner',
      'outcome',
      'schemaVersion',
      'validatorId',
    ],
    outcomes: ['accepted', 'notApplicable', 'rejected'],
    schemaVersion: '1.0',
  };
}

function evidenceSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: {
      componentEligible: { const: true },
      constraintDefinitionCount: { const: CUSTOM_CONSTRAINT_COUNT },
      contextContractCount: { const: 6 },
      controlResults: { type: 'array' },
      discoveryDigest: { pattern: '^sha256:[0-9a-f]{64}$', type: 'string' },
      outcome: { const: 'passed' },
      profileRef: { const: PROFILE_REF },
      runtimeId: { const: 'axiolune-foundation-market-strategy-custom-runtime-v1' },
      schemaVersion: { const: '1.0' },
      vectorResults: {
        maxItems: CUSTOM_CONSTRAINT_COUNT * 3,
        minItems: CUSTOM_CONSTRAINT_COUNT * 3,
        type: 'array',
      },
    },
    required: [
      'componentEligible', 'constraintDefinitionCount', 'contextContractCount',
      'controlResults', 'discoveryDigest', 'outcome', 'profileRef', 'runtimeId',
      'schemaVersion', 'vectorResults',
    ],
    type: 'object',
  };
}

function closureArtifacts(generated) {
  const rows = new Map();
  function add(role, file, content = null) {
    const ref = artifactRef(file);
    const digest = sha256(content === null ? fs.readFileSync(file) : content);
    const prior = rows.get(ref.path);
    if (prior && prior.digest !== digest) throw new Error(`closure digest collision ${ref.path}`);
    rows.set(ref.path, { digest, ref, role: prior ? `${prior.role}+${role}` : role });
  }
  add('discovery', PATHS.discovery, generated.discovery);
  add('evidenceSchema', PATHS.evidenceSchema, generated.evidenceSchema);
  add('inputContract', PATHS.inputContract, generated.inputContract);
  add('outputContract', PATHS.outputContract, generated.outputContract);
  add('vectors', PATHS.vectors, generated.vectors);
  for (const [role, file] of [
    ['generator', PATHS.generator],
    ['implementation', PATHS.implementation],
    ['profileBuilder', PATHS.profile],
    ['runner', PATHS.runner],
    ['worker', PATHS.worker],
  ]) add(role, file);
  for (const relativePath of new Set(Object.values(CONTRACT_IMPLEMENTATIONS).flat())) {
    add('reusedSemanticValidator', path.join(ROOT, ...relativePath.split('/')));
  }
  const runtimeQueue = [
    PATHS.worker,
    PATHS.implementation,
    ...new Set(Object.values(CONTRACT_IMPLEMENTATIONS).flat()),
  ].map((file) => path.isAbsolute(file) ? file : path.join(ROOT, ...file.split('/')));
  const runtimeVisited = new Set();
  while (runtimeQueue.length > 0) {
    const file = runtimeQueue.shift();
    const normalized = path.resolve(file);
    if (runtimeVisited.has(normalized)) continue;
    runtimeVisited.add(normalized);
    const source = fs.readFileSync(normalized, 'utf8');
    const directory = path.dirname(normalized);
    for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu)) {
      const unresolved = path.resolve(directory, match[1]);
      const candidates = [unresolved, `${unresolved}.cjs`, `${unresolved}.js`, `${unresolved}.json`];
      const dependency = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!dependency) throw new Error(`unresolved local runtime dependency ${match[1]} from ${relative(normalized)}`);
      const relativeDependency = path.relative(ROOT, dependency);
      if (relativeDependency.startsWith('..') || path.isAbsolute(relativeDependency)) {
        throw new Error(`runtime dependency escapes source tree: ${dependency}`);
      }
      add('transitiveRuntimeDependency', dependency);
      if (/\.(?:cjs|js)$/u.test(dependency)) runtimeQueue.push(dependency);
    }
  }
  for (const relativePath of [
    'scripts/domain/foundation-identifier-worker.cjs',
    'scripts/domain/identifier-custom-profile/v0.3.0/discovery-contract.json',
    'scripts/domain/identifier-custom-profile/v0.3.0/evidence.schema.json',
    'scripts/domain/identifier-custom-profile/v0.3.0/foundation-identifier-core.wasm',
    'scripts/domain/identifier-custom-profile/v0.3.0/implementation-closure.json',
    'scripts/domain/identifier-custom-profile/v0.3.0/input-contract.json',
    'scripts/domain/identifier-custom-profile/v0.3.0/output-contract.json',
    'scripts/domain/identifier-custom-profile/v0.3.0/scheme-validator-registry.json',
    'scripts/domain/identifier-custom-profile/v0.3.0/test-vectors.json',
  ]) add('transitiveRuntimeData', path.join(ROOT, ...relativePath.split('/')));
  for (const [, directory] of MODULE_IDS) {
    add('authoredConstraintModule', path.join(ROOT, 'ontology/domain/finance', directory, 'module.yaml'));
  }
  const vectorDocument = JSON.parse(generated.vectors.toString('utf8'));
  for (const vector of vectorDocument.vectors) {
    for (const branch of [vector.accepted, vector.negative]) {
      for (const fixture of branch.fixtureSources) {
        const file = path.join(ROOT, ...fixture.ref.path.split('/'));
        if (fixture.digest !== sha256(fs.readFileSync(file))) {
          throw new Error(`fixture source digest drift ${fixture.ref.path}`);
        }
        add('formalFixtureSource', file);
      }
    }
  }
  return [...rows.values()].sort((left, right) => compareUtf8(left.ref.path, right.ref.path));
}

function expectedArtifacts() {
  const values = {
    discovery: bytes(buildDiscovery()),
    evidenceSchema: bytes(evidenceSchema()),
    inputContract: bytes(inputContract()),
    outputContract: bytes(outputContract()),
    vectors: bytes(buildVectorSet()),
  };
  const artifacts = closureArtifacts(values);
  const closure = {
    artifacts,
    closureDigest: sha256(Buffer.concat([
      Buffer.from('axiolune-foundation-market-strategy-custom-closure-v1\0', 'utf8'),
      bytes(artifacts),
    ])),
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
  return [
    [PATHS.discovery, values.discovery],
    [PATHS.inputContract, values.inputContract],
    [PATHS.outputContract, values.outputContract],
    [PATHS.evidenceSchema, values.evidenceSchema],
    [PATHS.vectors, values.vectors],
    [PATHS.closure, bytes(closure)],
  ];
}

function main(argv) {
  if (argv.length !== 1 || !['--check', '--write'].includes(argv[0])) {
    throw new Error('Usage: node scripts/domain/generate-foundation-market-strategy-custom-profile.cjs --check|--write');
  }
  const artifacts = expectedArtifacts();
  if (argv[0] === '--write') {
    fs.mkdirSync(path.dirname(PATHS.discovery), { recursive: true });
    for (const [file, content] of artifacts) {
      fs.writeFileSync(file, content);
      process.stdout.write(`wrote ${relative(file)}\n`);
    }
  } else {
    for (const [file, content] of artifacts) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(content)) {
        throw new Error(`six-module Custom artifact drift: ${relative(file)}`);
      }
    }
  }
  process.stdout.write(`PASS six-module Custom profile ${argv[0].slice(2)} (definitions=${CUSTOM_CONSTRAINT_COUNT} contexts=6)\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildDiscovery,
  evidenceSchema,
  expectedArtifacts,
  inputContract,
  outputContract,
};
