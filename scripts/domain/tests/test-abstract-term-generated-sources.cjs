'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  sourceKey,
} = require('../lib/public-symbol-compiler.cjs');
const {
  buildGeneratedSourceIndex,
} = require('../lib/term-card-compiler.cjs');

test('abstract association keeps public role sources while omitting its identity companion', () => {
  const associationIri = 'https://example.test/module/AbstractAssociation';
  const moduleIri = 'https://example.test/module';
  const roleId = 'participant';
  const modules = [{
    module: { moduleIri, exports: [] },
    domain: {
      objectTypes: {},
      associationTypes: {
        AbstractAssociation: {
          iri: associationIri,
          abstract: true,
          definition: 'An abstract association with a reusable participant role.',
          participantRoles: [{
            id: roleId,
            definition: 'A role inherited by concrete association specializations.',
          }],
        },
      },
      codeLists: {},
    },
  }];
  const errors = [];
  const sources = buildGeneratedSourceIndex(modules, errors);
  const roleKey = sourceKey({
    kind: 'participantRole',
    containingType: associationIri,
    roleId,
  });
  const logicalKey = sourceKey({
    kind: 'logicalIdentityClass',
    typeIri: associationIri,
  });

  assert.deepEqual(errors, []);
  assert.equal(sources.size, 1);
  assert.equal(sources.get(roleKey).generatedIri, `${associationIri}/role/${roleId}`);
  assert.equal(sources.has(logicalKey), false);
});
