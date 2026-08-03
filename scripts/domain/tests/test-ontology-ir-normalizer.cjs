'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const { projectOwl } = require('../generate-m2-owl.cjs');
const { projectShacl } = require('../generate-m2-shacl.cjs');

const {
  assertOntologyImportRowsSortedUnique,
  compareOntologyImportRows,
  normalizeOntologyIr,
  selectedImportSymbolIris,
  sortUniqueOntologyImportRows,
} = require('../lib/ontology-ir-normalizer.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

function document(exports, importedSymbols) {
  return {
    module: {
      moduleIri: 'https://axiolune.ai/ontology/finance/example',
      exports,
      imports: [{
        moduleIri: 'https://axiolune.ai/ontology/finance/foundation',
        version: '0.3.0',
        artifactDigest: `sha256:${'1'.repeat(64)}`,
        importMode: 'Selective',
        importedSymbols,
      }],
    },
    orderedIdentityComponents: ['account', 'instrument'],
  };
}

test('module exports and SymbolImportSpec lists normalize as set-semantic arrays', () => {
  const left = document(
    ['https://example.test/B', 'https://example.test/A'],
    [
      { symbolIri: 'https://example.test/Y', localAlias: 'Y' },
      { symbolIri: 'https://example.test/X', localAlias: 'X' },
    ],
  );
  const right = document(
    [...left.module.exports].reverse(),
    [...left.module.imports[0].importedSymbols].reverse(),
  );
  assert.equal(
    canonicalJcs(normalizeOntologyIr(left)),
    canonicalJcs(normalizeOntologyIr(right)),
  );
});

test('arrays without a declared set-semantic ontology path remain ordered', () => {
  const left = document([], []);
  const right = structuredClone(left);
  right.orderedIdentityComponents.reverse();
  assert.notEqual(
    canonicalJcs(normalizeOntologyIr(left)),
    canonicalJcs(normalizeOntologyIr(right)),
  );
});

test('M2 set-semantic authoring lists cannot drift projections or normalized IR', async () => {
  const source = yaml.load(fs.readFileSync(path.join(
    ROOT, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
  ), 'utf8'));
  const reordered = structuredClone(source);
  const reverseFirst = (container, field) => {
    const element = Object.values(container).find((row) => (
      Array.isArray(row[field]) && row[field].length > 1
    ));
    assert.ok(element, `fixture requires a multi-entry ${field}`);
    element[field].reverse();
  };
  reverseFirst(reordered.domain.objectTypes, 'attributeUses');
  reverseFirst(reordered.domain.objectTypes, 'patternBindings');
  reverseFirst(reordered.domain.associationTypes, 'participantRoles');
  reverseFirst(reordered.domain.associationTypes, 'attributeUses');
  reverseFirst(reordered.domain.codeLists, 'values');
  reordered.domain.relationUses.reverse();
  reordered.domain.constraintBindings.reverse();

  assert.deepEqual(normalizeOntologyIr(source), normalizeOntologyIr(reordered));
  assert.equal((await projectOwl(source)).equals(await projectOwl(reordered)), true);
  assert.equal((await projectShacl(source)).equals(await projectShacl(reordered)), true);
});

test('declared identity component sequence remains order-sensitive', () => {
  const left = {
    identity: {
      logicalComponents: [{ component: 'scheme' }, { component: 'value' }],
      versionComponents: [{ component: 'revision' }, { component: 'source' }],
    },
  };
  const right = structuredClone(left);
  right.identity.logicalComponents.reverse();
  right.identity.versionComponents.reverse();
  assert.notDeepEqual(normalizeOntologyIr(left), normalizeOntologyIr(right));
});

test('set-semantic arrays reject duplicate declared unique keys', () => {
  const source = document([], [
    { symbolIri: 'https://example.test/X' },
    { symbolIri: 'https://example.test/X', localAlias: 'duplicate' },
  ]);
  assert.throws(
    () => normalizeOntologyIr(source),
    /duplicate selected-import-symbols key/u,
  );
});

test('selected import closure projects unique SymbolImportSpec IRIs in byte order', () => {
  assert.deepEqual(selectedImportSymbolIris({ importedSymbols: [
    { symbolIri: 'https://example.test/Z', localAlias: 'Zed' },
    { symbolIri: 'https://example.test/A' },
  ] }), ['https://example.test/A', 'https://example.test/Z']);
  assert.throws(
    () => selectedImportSymbolIris({ importedSymbols: ['https://example.test/A'] }),
    /not a SymbolImportSpec/u,
  );
  assert.throws(
    () => selectedImportSymbolIris({ importedSymbols: [
      { symbolIri: 'https://example.test/A' },
      { symbolIri: 'https://example.test/A' },
    ] }),
    /duplicate symbolIri/u,
  );
});

test('ontology imports use the RFC importer/target tuple order and reject duplicate tuples', () => {
  const rows = [
    {
      importerModuleIri: 'https://example.test/B',
      importedModuleIri: 'https://example.test/A',
      importMode: 'All',
    },
    {
      importerModuleIri: 'https://example.test/A',
      importedModuleIri: 'https://example.test/Z',
      importMode: 'Selective',
    },
    {
      importerModuleIri: 'https://example.test/A',
      importedModuleIri: 'https://example.test/B',
      importMode: 'All',
    },
  ];
  const sorted = sortUniqueOntologyImportRows(rows);
  assert.deepEqual(sorted.map((row) => [row.importerModuleIri, row.importedModuleIri]), [
    ['https://example.test/A', 'https://example.test/B'],
    ['https://example.test/A', 'https://example.test/Z'],
    ['https://example.test/B', 'https://example.test/A'],
  ]);
  assert.equal(compareOntologyImportRows(sorted[0], sorted[1]) < 0, true);

  const targetGrouped = [rows[0], rows[2], rows[1]];
  assert.throws(
    () => assertOntologyImportRowsSortedUnique(targetGrouped),
    /importerModuleIri, importedModuleIri/u,
  );
  assert.throws(
    () => sortUniqueOntologyImportRows([rows[0], { ...rows[0], importMode: 'Selective' }]),
    /sorted and unique/u,
  );
});
