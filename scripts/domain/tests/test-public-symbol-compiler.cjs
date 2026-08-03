#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MONEY_VALUE,
  PUBLIC_SYMBOL_MANIFEST_TAG,
  PublicSymbolCompilationError,
  QUANTITY_VALUE,
  compilePublicSymbolManifest,
  sourceKey,
  taggedJcsDigest,
} = require('../lib/public-symbol-compiler.cjs');

const BASE = 'https://axiolune.ai/test/public/';
const MODULE = `${BASE}module`;

function element(localName, extra = {}) {
  return {
    iri: `${BASE}${localName}`,
    localName,
    ...extra,
  };
}

function fixture() {
  return {
    module: {
      moduleIri: MODULE,
      exports: [],
    },
    domain: {
      objectTypes: {
        Object: element('Object'),
      },
      associationTypes: {
        Association: element('Association', {
          participantRoles: [{ id: 'subjectParty' }],
        }),
      },
      relationTypes: {
        relation: element('relation'),
      },
      attributeTypes: {
        text: element('text', { valueType: 'string' }),
        money: element('money', { valueType: MONEY_VALUE }),
        quantity: element('quantity', { valueType: QUANTITY_VALUE }),
      },
      identifierTypes: {
        Identifier: element('Identifier'),
      },
      codeLists: {
        State: element('State', {
          values: [{ iri: `${BASE}State/open` }],
        }),
      },
      constraints: {
        Constraint: element('Constraint'),
      },
    },
  };
}

function errorCodes(action) {
  try {
    action();
  } catch (error) {
    if (!(error instanceof PublicSymbolCompilationError)) throw error;
    return new Set(error.errors.map((entry) => entry.code));
  }
  return new Set();
}

test('all authored classifiers and all three generated kinds are emitted deterministically', () => {
  const compiled = compilePublicSymbolManifest([fixture()]);
  assert.equal(compiled.manifest.symbols.length, 13);
  assert.deepEqual(
    compiled.manifest.symbols.map((row) => row.publicIri),
    [...compiled.manifest.symbols.map((row) => row.publicIri)].sort(),
  );
  assert.equal(
    compiled.manifestDigest,
    taggedJcsDigest(PUBLIC_SYMBOL_MANIFEST_TAG, compiled.manifest),
  );
  const byIri = new Map(compiled.manifest.symbols.map((row) => [row.publicIri, row]));
  assert.equal(byIri.get(`${BASE}money`).sourceElementKey, sourceKey({
    kind: 'authoredElement',
    ownerModule: MODULE,
    containerKind: 'attributeTypes',
    metaType: 'MoneyTypeDefinition',
    elementIri: `${BASE}money`,
  }));
  assert.equal(byIri.get(`${BASE}quantity`).sourceElementKey, sourceKey({
    kind: 'authoredElement',
    ownerModule: MODULE,
    containerKind: 'attributeTypes',
    metaType: 'QuantityTypeDefinition',
    elementIri: `${BASE}quantity`,
  }));
  assert.deepEqual(
    new Set(compiled.manifest.symbols
      .filter((row) => row.origin === 'generated')
      .map((row) => row.generatedKind)),
    new Set(['rolePredicate', 'codeMember', 'logicalIdentityClass']),
  );
});

test('an explicit export narrows authored and source-derived generated symbols together', () => {
  const input = fixture();
  input.module.exports = [`${BASE}Association`];
  const { manifest } = compilePublicSymbolManifest([input]);
  assert.deepEqual(
    manifest.symbols.map((row) => [row.publicIri, row.generatedKind || 'authored']),
    [
      [`${BASE}Association`, 'authored'],
      [`${BASE}Association/LogicalIdentity`, 'logicalIdentityClass'],
      [`${BASE}Association/role/subjectParty`, 'rolePredicate'],
    ],
  );
});

test('abstract object types remain public but do not receive logical-identity companions', () => {
  const input = fixture();
  input.domain.objectTypes.Object.abstract = true;
  const { manifest } = compilePublicSymbolManifest([input]);
  const publicIris = new Set(manifest.symbols.map((row) => row.publicIri));
  assert.equal(publicIris.has(`${BASE}Object`), true);
  assert.equal(publicIris.has(`${BASE}Object/LogicalIdentity`), false);

  input.domain.objectTypes.Object.abstract = 'true';
  assert.ok(
    errorCodes(() => compilePublicSymbolManifest([input])).has('INVALID_ABSTRACT_FLAG'),
  );
});

test('orphan exports and public/generated IRI collisions fail closed', () => {
  const orphan = fixture();
  orphan.module.exports = [`${BASE}missing`];
  assert.ok(errorCodes(() => compilePublicSymbolManifest([orphan])).has('ORPHAN_EXPLICIT_EXPORT'));

  const collision = fixture();
  collision.domain.attributeTypes.colliding = element('Association/LogicalIdentity', {
    valueType: 'string',
  });
  assert.ok(errorCodes(() => compilePublicSymbolManifest([collision])).has('DUPLICATE_PUBLIC_IRI'));
});

test('public-symbol sources reject non-canonical absolute IRI serializations', () => {
  const module = fixture();
  module.module.moduleIri = 'HTTPS://AXIOLUNE.AI/test/public/module';
  assert.ok(errorCodes(() => compilePublicSymbolManifest([module])).has('INVALID_MODULE_IRI'));

  const authored = fixture();
  authored.domain.objectTypes.Object.iri = 'HTTPS://AXIOLUNE.AI/test/public/Object';
  assert.ok(errorCodes(() => compilePublicSymbolManifest([authored])).has('INVALID_AUTHORED_ELEMENT'));

  const codeValue = fixture();
  codeValue.domain.codeLists.State.values[0].iri = 'HTTPS://AXIOLUNE.AI/test/public/State/open';
  assert.ok(errorCodes(() => compilePublicSymbolManifest([codeValue])).has('INVALID_CODE_VALUE_IRI'));

  assert.ok(errorCodes(() => compilePublicSymbolManifest(
    [fixture()], { profileRef: 'HTTPS://AXIOLUNE.AI/conformance/m2/0.3.0' },
  )).has('INVALID_PROFILE_REF'));
});
