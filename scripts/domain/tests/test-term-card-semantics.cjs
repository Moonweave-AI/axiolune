'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const {
  compilePublicSymbolManifest,
} = require('../lib/public-symbol-compiler.cjs');
const {
  CANDIDATE_M3_TYPE_IRIS,
  CANDIDATE_M3_TYPES,
  MONEY_M3_TYPE,
  MONEY_VALUE,
  QUANTITY_M3_TYPE,
  QUANTITY_VALUE,
  candidateM3TypeFor,
  deriveTermCardSemantics,
} = require('../lib/term-card-semantics.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FINANCE_ROOT = path.join(ROOT, 'ontology', 'domain', 'finance');
const CORE_META = path.join(ROOT, 'ontology', 'meta', 'core-meta-model.yaml');
const CONTAINERS = Object.keys(CANDIDATE_M3_TYPES);

function modules() {
  return fs.readdirSync(FINANCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .map((entry) => path.join(FINANCE_ROOT, entry.name, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .sort()
    .map((file) => YAML.parse(fs.readFileSync(file, 'utf8')));
}

function utf8SortedUnique(values) {
  for (let index = 1; index < values.length; index += 1) {
    if (Buffer.compare(
      Buffer.from(values[index - 1], 'utf8'),
      Buffer.from(values[index], 'utf8'),
    ) >= 0) return false;
  }
  return new Set(values).size === values.length;
}

function rows(moduleDocs) {
  const authored = new Set(
    compilePublicSymbolManifest(moduleDocs).manifest.symbols
      .filter((symbol) => symbol.origin === 'authored')
      .map((symbol) => symbol.publicIri),
  );
  const result = [];
  for (const document of moduleDocs) {
    for (const containerKind of CONTAINERS) {
      for (const [localName, element] of Object.entries(
        document.domain[containerKind] || {},
      )) {
        if (!authored.has(element.iri)) continue;
        result.push({
          containerKind,
          element,
          localName,
          moduleIri: document.module.moduleIri,
          semantics: deriveTermCardSemantics(containerKind, element),
        });
      }
    }
  }
  assert.equal(result.length, authored.size);
  return result;
}

test('candidate M3 term types resolve exactly in the canonical core meta-model', () => {
  const core = YAML.parse(fs.readFileSync(CORE_META, 'utf8'));
  assert.equal(core.module.baseIri, 'https://axiolune.ai/ontology/meta/core/');
  for (const iri of CANDIDATE_M3_TYPE_IRIS) {
    const localName = iri.slice(core.module.baseIri.length);
    assert.ok(
      Object.prototype.hasOwnProperty.call(core.MetaModel, localName),
      `${iri} does not resolve in core-meta-model.yaml`,
    );
  }
});

test('Foundation and Market Data produce complete fact-derived ISO 704 card fields', () => {
  const selected = rows(modules()).filter((row) => (
    row.moduleIri.endsWith('/foundation') || row.moduleIri.endsWith('/market-data')
  ));
  assert.ok(selected.length > 0);
  assert.deepEqual(
    new Set(selected.map((row) => row.containerKind)),
    new Set(CONTAINERS),
  );
  for (const row of selected) {
    const at = `${row.moduleIri}#${row.containerKind}.${row.localName}`;
    assert.equal(
      row.semantics.candidateM3Type,
      candidateM3TypeFor(row.containerKind, row.element),
      at,
    );
    assert.ok(row.semantics.genus.length > 0, at);
    assert.ok(row.semantics.differentia.length > 0, at);
    assert.ok(row.semantics.excludes.length > 0, at);
    assert.ok(utf8SortedUnique(row.semantics.differentia), at);
    assert.ok(utf8SortedUnique(row.semantics.excludes), at);
    assert.doesNotMatch(
      JSON.stringify(row.semantics),
      /\b(?:todo|tbd|placeholder|undefined)\b/iu,
      at,
    );
  }
});

test('classification rules bind each card category to its authored structural facts', () => {
  for (const row of rows(modules())) {
    const { containerKind, element, semantics } = row;
    const semanticText = [semantics.genus, ...semantics.differentia].join('\n');
    if (containerKind === 'objectTypes') {
      for (const superType of element.superTypes || []) assert.match(semanticText, new RegExp(superType, 'u'));
    } else if (containerKind === 'associationTypes') {
      for (const role of element.participantRoles || []) {
        assert.ok(semanticText.includes(role.id));
        assert.ok(semanticText.includes(role.range));
        assert.ok(semanticText.includes(role.label));
        assert.ok(semanticText.includes(role.definition));
      }
    } else if (containerKind === 'relationTypes') {
      assert.ok(semantics.genus.includes(element.domain));
      assert.ok(semantics.genus.includes(element.range));
    } else if (containerKind === 'attributeTypes') {
      assert.ok(semantics.genus.includes(element.valueType));
    } else if (containerKind === 'identifierTypes') {
      for (const fact of [
        element.baseType,
        element.standard,
        element.issuingAuthority,
        element.validatorRef,
      ]) assert.ok(semanticText.includes(fact));
    } else if (containerKind === 'codeLists') {
      assert.ok(semanticText.includes(String(element.values.length)));
      for (const value of element.values) {
        assert.ok(semanticText.includes(value.iri));
        assert.ok(semanticText.includes(value.notation));
        assert.ok(semanticText.includes(value.label));
        assert.ok(semanticText.includes(value.definition));
      }
    } else if (containerKind === 'constraints') {
      for (const fact of [
        element.constraintType,
        element.scope,
        element.expression.language,
        element.expression.expression,
        element.severity,
      ]) assert.ok(semanticText.includes(fact));
      if (element.targetElement) assert.ok(semanticText.includes(element.targetElement));
    }
  }
});

test('generated role and code-member definitions are review-bound by containing-card semantics', () => {
  const association = {
    participantRoles: [{
      id: 'subjectParty',
      range: 'https://example.test/Party',
      minCount: 1,
      maxCount: 1,
      label: 'subject party',
      definition: 'Party occupying the subject role.',
    }],
    attributeUses: [],
    patternBindings: [],
  };
  const associationBefore = deriveTermCardSemantics('associationTypes', association);
  association.participantRoles[0].definition = 'Changed, and therefore not yet reviewed.';
  const associationAfter = deriveTermCardSemantics('associationTypes', association);
  assert.notDeepEqual(associationAfter.differentia, associationBefore.differentia);

  const codeList = {
    maintainer: 'Example authority',
    vocabulary: 'Example vocabulary',
    version: '1.0.0',
    sourceEvidenceRef: 'https://example.test/source',
    values: [{
      iri: 'https://example.test/code/open',
      notation: 'open',
      label: 'open',
      definition: 'The open state.',
    }],
  };
  const codeListBefore = deriveTermCardSemantics('codeLists', codeList);
  codeList.values[0].definition = 'A changed open-state definition.';
  const codeListAfter = deriveTermCardSemantics('codeLists', codeList);
  assert.notDeepEqual(codeListAfter.differentia, codeListBefore.differentia);
});

test('new M3 source fields fail closed until term-card review semantics bind them', () => {
  assert.throws(
    () => deriveTermCardSemantics('relationTypes', {
      domain: 'https://example.test/Source',
      range: 'https://example.test/Target',
      newlyIntroducedSemanticField: 'unreviewed',
    }),
    /do not review-bind relationTypes field\(s\): newlyIntroducedSemanticField/u,
  );
});

test('currently optional M3 semantic fields participate in derived review content', () => {
  const relation = {
    domain: 'https://example.test/Source',
    range: 'https://example.test/Target',
    inverseOf: 'https://example.test/inverse',
  };
  const before = deriveTermCardSemantics('relationTypes', relation);
  relation.inverseOf = 'https://example.test/changedInverse';
  const after = deriveTermCardSemantics('relationTypes', relation);
  assert.notDeepEqual(after.differentia, before.differentia);

  const constraint = {
    constraintType: 'Dependency',
    scope: 'Object',
    expression: { language: 'Custom', expression: 'subject is valid' },
    severity: 'Error',
    message: 'Subject is invalid.',
    dependencies: ['https://example.test/prerequisite'],
  };
  const constraintBefore = deriveTermCardSemantics('constraints', constraint);
  constraint.dependencies = ['https://example.test/changedPrerequisite'];
  const constraintAfter = deriveTermCardSemantics('constraints', constraint);
  assert.notDeepEqual(constraintAfter.differentia, constraintBefore.differentia);

  const expressionBefore = deriveTermCardSemantics('constraints', constraint);
  constraint.expression.expressionDigest = `sha256:${'1'.repeat(64)}`;
  const expressionAfter = deriveTermCardSemantics('constraints', constraint);
  assert.notDeepEqual(expressionAfter.differentia, expressionBefore.differentia);

  const attribute = {
    valueType: 'decimal',
    defaultCardinality: { minCount: 0, maxCount: 1 },
  };
  const cardinalityBefore = deriveTermCardSemantics('attributeTypes', attribute);
  attribute.defaultCardinality.futureSemanticFlag = true;
  assert.ok(cardinalityBefore.differentia.length > 0);
  assert.throws(
    () => deriveTermCardSemantics('attributeTypes', attribute),
    /do not review-bind attributeTypes\.defaultCardinality field\(s\): futureSemanticFlag/u,
  );
});

test('identifier term-card derivation honors optional issuingAuthority', () => {
  const identifier = {
    baseType: 'string',
    standard: 'Example Standard',
    validatorRef: 'https://example.test/constraints/IdentifierSyntax',
  };
  const absent = deriveTermCardSemantics('identifierTypes', identifier);
  assert.ok(absent.differentia.includes('declares no issuing authority'));

  const present = deriveTermCardSemantics('identifierTypes', {
    ...identifier,
    issuingAuthority: 'Example Authority',
  });
  assert.ok(present.differentia.includes('is issued under authority Example Authority'));
  assert.notDeepEqual(present, absent);
});

test('MonetaryAmount and QuantityValue attributes retain their exact M3 classifiers', () => {
  assert.equal(
    deriveTermCardSemantics('attributeTypes', { valueType: MONEY_VALUE }).candidateM3Type,
    MONEY_M3_TYPE,
  );
  assert.equal(
    deriveTermCardSemantics('attributeTypes', { valueType: QUANTITY_VALUE }).candidateM3Type,
    QUANTITY_M3_TYPE,
  );
  assert.equal(
    deriveTermCardSemantics('attributeTypes', { valueType: 'string' }).candidateM3Type,
    CANDIDATE_M3_TYPES.attributeTypes,
  );
});
