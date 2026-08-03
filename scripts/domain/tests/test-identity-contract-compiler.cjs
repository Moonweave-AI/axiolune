'use strict';

const assert = require('assert');
const crypto = require('crypto');

const {
  IdentityContractError,
  TAGS,
  buildIdentityIris,
  canonicalJcs,
  compileIdentityContracts,
  taggedJcsDigest,
  validateCompilationInput,
  validateIdentityManifest,
} = require('../lib/identity-contract-compiler.cjs');
const {
  buildFixture,
} = require('../../../tests/m2/fixtures/identity/valid-compilation.cjs');
const compilationNegativeVectors =
  require('../../../tests/m2/fixtures/identity/negative-vectors.cjs');
const manifestNegativeVectors =
  require('../../../tests/m2/fixtures/identity/manifest-negative-vectors.cjs');

function clone(value) {
  return structuredClone(value);
}

function errorCodes(error) {
  if (!(error instanceof IdentityContractError)) throw error;
  return new Set(error.errors.map((entry) => entry.code));
}

function compileCodes(input, options) {
  try {
    compileIdentityContracts(input, options);
    return new Set();
  } catch (error) {
    return errorCodes(error);
  }
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function independentIdentityDigest(components) {
  const chunks = [
    Buffer.from('axiolune-identity-key-v1\0', 'utf8'),
    u64be(components.length),
  ];
  for (const [name, term] of components) {
    const nameBytes = Buffer.from(name, 'utf8');
    const termBytes = Buffer.from(term, 'utf8');
    chunks.push(u64be(nameBytes.length), nameBytes, u64be(termBytes.length), termBytes);
  }
  return crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

function runPositiveCompilation() {
  const fixture = buildFixture();
  const validation = validateCompilationInput(fixture);
  assert.deepStrictEqual(validation.errors, []);
  assert.strictEqual(validation.ok, true);

  const compiled = compileIdentityContracts(fixture);
  assert.strictEqual(
    compiled.manifestDigest,
    taggedJcsDigest(TAGS.identityManifest, compiled.manifest),
  );
  assert.deepStrictEqual(
    compiled.manifest.contracts.map((row) => row.targetType),
    [...fixture.concreteTargetTypes].sort(),
    'manifest contracts must be targetType-sorted',
  );
  assert.strictEqual(
    compiled.manifest.contracts.flatMap((row) => row.mappings).length,
    fixture.mappings.length,
    'each mapping must appear exactly once',
  );
  for (const row of compiled.manifest.contracts) {
    const contract = fixture.contracts.find((candidate) => candidate.iri === row.contractRef);
    assert.deepStrictEqual(row.logicalComponents, contract.logicalComponents);
    assert.deepStrictEqual(row.versionComponents, contract.versionComponents);
    assert.strictEqual(row.contractDigest, taggedJcsDigest(TAGS.targetContract, contract));
  }
  assert.deepStrictEqual(validateIdentityManifest(compiled.manifest, fixture).errors, []);

  const edges = new Map(compiled.dependencyEdges);
  assert.deepStrictEqual(
    edges.get('https://axiolune.ai/test/identity/mappings/account'),
    ['https://axiolune.ai/test/identity/mappings/party'],
  );
  assert.deepStrictEqual(
    edges.get('https://axiolune.ai/test/identity/mappings/holding'),
    [
      'https://axiolune.ai/test/identity/mappings/account',
      'https://axiolune.ai/test/identity/mappings/party',
    ],
  );

  const reordered = clone(fixture);
  const account = reordered.mappings.find((mapping) => mapping.iri.endsWith('/mappings/account'));
  account.identity.logicalKeyBindings = {
    accountId: account.identity.logicalKeyBindings.accountId,
    owner: account.identity.logicalKeyBindings.owner,
    accountKind: account.identity.logicalKeyBindings.accountKind,
  };
  const holding = reordered.mappings.find((mapping) => mapping.iri.endsWith('/mappings/holding'));
  const accountRef = holding.identity.logicalKeyBindings.accountVersion;
  accountRef.keyBindings = {
    accountId: accountRef.keyBindings.accountId,
    accountKind: accountRef.keyBindings.accountKind,
    owner: accountRef.keyBindings.owner,
    asOf: accountRef.keyBindings.asOf,
  };
  assert.strictEqual(
    compileIdentityContracts(reordered).manifestDigest,
    compiled.manifestDigest,
    'binding-map member order must not change canonical output',
  );
}

function runFramingVectors() {
  const fixture = buildFixture();
  const party = fixture.contracts.find((contract) => contract.iri.endsWith('/contracts/party'));
  const logicalTerm = '"Pé-001"^^<http://www.w3.org/2001/XMLSchema#string>';
  const versionTerm =
    '"2026-07-31T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>';
  const expectedLogicalHex = independentIdentityDigest([['partyId', logicalTerm]]);
  const expectedVersionHex = independentIdentityDigest([['asOf', versionTerm]]);
  assert.strictEqual(
    expectedLogicalHex,
    '70c4ba8e32126c206dfc1b6b46c83f1780bc6f2dd732432e6d04db223db43530',
  );
  assert.strictEqual(
    expectedVersionHex,
    '2e3f0070c4f73b095882899e59ec1cb5189419b3df3c849338aab59784a306f9',
  );
  assert.deepStrictEqual(
    buildIdentityIris(
      party,
      { partyId: logicalTerm },
      { asOf: versionTerm },
    ),
    {
      logicalIri:
        'https://axiolune.ai/test/identity/data/party/sha256-70c4ba8e32126c206dfc1b6b46c83f1780bc6f2dd732432e6d04db223db43530',
      versionIri:
        'https://axiolune.ai/test/identity/data/party/sha256-70c4ba8e32126c206dfc1b6b46c83f1780bc6f2dd732432e6d04db223db43530/version/sha256-2e3f0070c4f73b095882899e59ec1cb5189419b3df3c849338aab59784a306f9',
    },
  );

  assert.throws(
    () => buildIdentityIris(
      party,
      { partyId: logicalTerm, extra: '"unused"' },
      { asOf: versionTerm },
    ),
    (error) => errorCodes(error).has('IDENTITY_TERM_COVERAGE_MISMATCH'),
  );
  assert.throws(
    () => buildIdentityIris(
      party,
      { partyId: logicalTerm },
      {},
    ),
    (error) => errorCodes(error).has('IDENTITY_TERM_COVERAGE_MISMATCH'),
  );
  assert.throws(
    () => buildIdentityIris(
      party,
      { partyId: '_:blank' },
      { asOf: versionTerm },
    ),
    (error) => errorCodes(error).has('INVALID_CANONICAL_RDF_TERM'),
  );
  assert.throws(
    () => buildIdentityIris(
      party,
      { partyId: '"ambiguous plain literal"' },
      { asOf: versionTerm },
    ),
    (error) => errorCodes(error).has('INVALID_CANONICAL_RDF_TERM'),
  );

  const unversioned = clone(party);
  unversioned.versionComponents = [];
  assert.strictEqual(
    buildIdentityIris(unversioned, { partyId: logicalTerm }).versionIri,
    null,
  );
  assert.throws(
    () => buildIdentityIris(unversioned, { partyId: logicalTerm }, { asOf: versionTerm }),
    (error) => errorCodes(error).has('VERSION_IRI_FORBIDDEN'),
  );
}

function runCompilationNegativeVectors() {
  for (const vector of compilationNegativeVectors) {
    const fixture = buildFixture();
    vector.mutate(fixture);
    const codes = compileCodes(fixture);
    assert(
      codes.has(vector.expectedCode),
      `${vector.vectorId}: expected ${vector.expectedCode}; got ${[...codes].join(', ')}`,
    );
  }

  const fixture = buildFixture();
  const accountRef = 'https://axiolune.ai/test/identity/mappings/account';
  const visibilityCodes = compileCodes(fixture, {
    visibleMappingRefsByMapping: {
      [accountRef]: [],
    },
  });
  assert(visibilityCodes.has('INVISIBLE_TARGET_MAPPING'));

  const missingExactSlotKey = buildFixture();
  const accountWithExactSlot = missingExactSlotKey.mappings.find((mapping) => (
    mapping.iri.endsWith('/mappings/account')
  ));
  delete accountWithExactSlot.slotMappings[0].value.keyBindings.asOf;
  assert(
    compileCodes(missingExactSlotKey).has('REFERENCE_KEY_COVERAGE_MISMATCH'),
    'exact-version semantic slot references must be compiled with complete target identity keys',
  );

  const wrongExactSlotTarget = buildFixture();
  wrongExactSlotTarget.mappings.find((mapping) => (
    mapping.iri.endsWith('/mappings/account')
  )).slotMappings[0].target.targetObjectType =
    'https://axiolune.ai/test/identity/types/Account';
  assert(
    compileCodes(wrongExactSlotTarget).has('REFERENCE_TARGET_TYPE_MISMATCH'),
    'semantic relation target type must agree with the referenced identity mapping',
  );

  const arbitraryRuntimeField = buildFixture();
  arbitraryRuntimeField.mappings.find((mapping) => (
    mapping.iri.endsWith('/mappings/account')
  )).slotMappings[1].value.contextField = 'adapterSuppliedIri';
  assert(
    compileCodes(arbitraryRuntimeField).has('INVALID_RUNTIME_CONTEXT_FIELD'),
    'runtime context bindings must use the closed MaterializationRun field vocabulary',
  );
}

function runManifestNegativeVectors() {
  const fixture = buildFixture();
  const original = compileIdentityContracts(fixture).manifest;
  for (const vector of manifestNegativeVectors) {
    const manifest = clone(original);
    vector.mutate(manifest);
    const result = validateIdentityManifest(manifest, fixture);
    const codes = new Set(result.errors.map((entry) => entry.code));
    assert(
      codes.has(vector.expectedCode),
      `${vector.vectorId}: expected ${vector.expectedCode}; got ${[...codes].join(', ')}`,
    );
  }
}

function runCanonicalDigestChecks() {
  const left = { z: 1, a: { beta: true, alpha: 'é' } };
  const right = { a: { alpha: 'é', beta: true }, z: 1 };
  assert.strictEqual(canonicalJcs(left), canonicalJcs(right));
  assert.strictEqual(
    taggedJcsDigest('fixture-domain-v1\0', left),
    taggedJcsDigest('fixture-domain-v1\0', right),
  );
  assert.notStrictEqual(
    taggedJcsDigest('fixture-domain-v1\0', left),
    taggedJcsDigest('fixture-domain-v2\0', left),
  );
}

runCanonicalDigestChecks();
runPositiveCompilation();
runFramingVectors();
runCompilationNegativeVectors();
runManifestNegativeVectors();

console.log(
  `identity-contract-compiler: PASS `
  + `(positive compilation/framing, ${compilationNegativeVectors.length} compilation negatives, `
  + `${manifestNegativeVectors.length} manifest negatives)`,
);
