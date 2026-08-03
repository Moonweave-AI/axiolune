#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VALIDATOR = path.join(ROOT, 'scripts', 'domain', 'validate-m2-core.js');
const DOMAIN_GATE = path.join(ROOT, 'scripts', 'domain', 'test-all-domain.js');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function moduleDocument({
  moduleIri,
  baseIri,
  preferredPrefix,
  elementIri,
  imports = [],
}) {
  return {
    module: {
      moduleIri,
      baseIri,
      preferredPrefix,
      version: '1.0.0',
      label: preferredPrefix,
      definition: `test module ${preferredPrefix}`,
      imports,
      exports: [],
      status: 'draft',
      governance: {
        ownerRef: 'urn:axiolune:principal:test-owner',
        status: 'draft',
      },
    },
    domain: {
      objectTypes: {},
      associationTypes: {},
      relationTypes: {},
      attributeTypes: {
        TestAttribute: {
          iri: elementIri,
          namespace: preferredPrefix,
          localName: 'TestAttribute',
          label: 'Test Attribute',
          definition: 'a test-only attribute',
          valueType: 'string',
        },
      },
      identifierTypes: {},
      codeLists: {},
      constraints: {},
      relationUses: [],
      constraintBindings: [],
    },
  };
}

function writeYaml(dir, name, document) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, yaml.dump(document, { noRefs: true, lineWidth: 120 }));
  return file;
}

function runValidator(files) {
  return spawnSync(process.execPath, [VALIDATOR, ...files, '--strict'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
}

function completeAlignment(relation = 'rdfs:subClassOf') {
  return {
    vocabulary: 'Example',
    targetIri: 'https://external.example.test/ontology/Target',
    relation,
    sourceRelease: {
      vocabulary: 'Example',
      release: 'snapshot-v1',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    },
    sourceLocator: {
      kind: 'wholeFile',
      path: 'ontology/example.ttl',
      mediaType: 'text/turtle',
      extractorProfileRef: {
        kind: 'path',
        root: 'sourceTree',
        path: 'toolchain/whole-file.json',
      },
      extractorProfileDigest: `sha256:${'b'.repeat(64)}`,
      selectionDigest: `sha256:${'c'.repeat(64)}`,
    },
    rationale: 'the local test class is a strict specialization of the external target',
    verification: {
      status: 'proposed',
    },
  };
}

test('strict validator rejects a stale imported version and byte digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const imported = writeYaml(dir, 'imported.yaml', moduleDocument({
    moduleIri: 'https://example.test/ontology/imported',
    baseIri: 'https://example.test/ontology/imported/',
    preferredPrefix: 'imported',
    elementIri: 'https://example.test/ontology/imported/TestAttribute',
  }));
  const importer = writeYaml(dir, 'importer.yaml', moduleDocument({
    moduleIri: 'https://example.test/ontology/importer',
    baseIri: 'https://example.test/ontology/importer/',
    preferredPrefix: 'importer',
    elementIri: 'https://example.test/ontology/importer/TestAttribute',
    imports: [{
      moduleIri: 'https://example.test/ontology/imported',
      version: '0.9.0',
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      importMode: 'All',
    }],
  }));

  const result = runValidator([imported, importer]);
  assert.notEqual(result.status, 0, 'stale import metadata must fail closed');
  assert.match(`${result.stdout}\n${result.stderr}`, /import.*(?:version|digest)/i);

  // Guard the test setup itself: the deliberately wrong digest must differ.
  assert.notEqual(sha256(fs.readFileSync(imported)), `sha256:${'1'.repeat(64)}`);
});

test('strict validator rejects duplicate element IRIs across modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const sharedIri = 'https://example.test/ontology/shared/TestAttribute';
  const first = writeYaml(dir, 'first.yaml', moduleDocument({
    moduleIri: 'https://example.test/ontology/first',
    baseIri: 'https://example.test/ontology/first/',
    preferredPrefix: 'first',
    elementIri: sharedIri,
  }));
  const second = writeYaml(dir, 'second.yaml', moduleDocument({
    moduleIri: 'https://example.test/ontology/second',
    baseIri: 'https://example.test/ontology/second/',
    preferredPrefix: 'second',
    elementIri: sharedIri,
  }));

  const result = runValidator([first, second]);
  assert.notEqual(result.status, 0, 'cross-module duplicate IRIs must fail closed');
  assert.match(`${result.stdout}\n${result.stderr}`, /duplicate.*IRI/i);
});

test('strict validator rejects a non-array imports container', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/bad-imports',
    baseIri: 'https://example.test/ontology/bad-imports/',
    preferredPrefix: 'bad-imports',
    elementIri: 'https://example.test/ontology/bad-imports/TestAttribute',
  });
  document.module.imports = {};
  const file = writeYaml(dir, 'bad-imports.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'imports must be a closed ordered list');
  assert.match(`${result.stdout}\n${result.stderr}`, /imports.*array/i);
});

test('strict validator rejects legacy flat domain maps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/flat',
    baseIri: 'https://example.test/ontology/flat/',
    preferredPrefix: 'flat',
    elementIri: 'https://example.test/ontology/flat/TestAttribute',
  });
  document.domain = document.domain.attributeTypes;
  const file = writeYaml(dir, 'flat.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'legacy inferred typing must never satisfy the core gate');
  assert.match(`${result.stdout}\n${result.stderr}`, /M2-TYPED-CONTAINERS-REQUIRED/);
});

test('strict validator rejects unresolved code-list source evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/pending-evidence',
    baseIri: 'https://example.test/ontology/pending-evidence/',
    preferredPrefix: 'pending-evidence',
    elementIri: 'https://example.test/ontology/pending-evidence/TestAttribute',
  });
  document.domain.codeLists.TestCodeList = {
    iri: 'https://example.test/ontology/pending-evidence/TestCodeList',
    namespace: 'pending-evidence',
    localName: 'TestCodeList',
    label: 'Test Code List',
    definition: 'a test-only controlled value set',
    vocabulary: 'Test Code List',
    version: '1.0.0',
    maintainer: 'Test Maintainer',
    sourceEvidenceRef:
      'https://axiolune.ai/pending-source-evidence/pending-evidence/TestCodeList',
    values: [{
      iri: 'https://example.test/ontology/pending-evidence/TestCodeList/one',
      notation: 'one',
      label: 'one',
      definition: 'the first test value',
    }],
  };
  const file = writeYaml(dir, 'pending-evidence.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'unresolved evidence must never satisfy the strict gate');
  assert.match(`${result.stdout}\n${result.stderr}`, /unresolved pending evidence/i);
});

test('draft alignments still require the complete evidence contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/incomplete-alignment',
    baseIri: 'https://example.test/ontology/incomplete-alignment/',
    preferredPrefix: 'incomplete-alignment',
    elementIri: 'https://example.test/ontology/incomplete-alignment/TestAttribute',
  });
  document.domain.attributeTypes.TestAttribute.alignments = [{
    vocabulary: 'Example',
    targetIri: 'https://external.example.test/ontology/property',
    relation: 'rdfs:subPropertyOf',
  }];
  const file = writeYaml(dir, 'incomplete-alignment.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'draft status must not legalize evidence-free alignments');
  assert.match(`${result.stdout}\n${result.stderr}`, /missing required field `sourceRelease`/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /missing required field `sourceLocator`/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /missing required field `rationale`/i);
});

test('SKOS mappings on OWL classes are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/skos-class',
    baseIri: 'https://example.test/ontology/skos-class/',
    preferredPrefix: 'skos-class',
    elementIri: 'https://example.test/ontology/skos-class/TestAttribute',
  });
  document.domain.objectTypes.TestObject = {
    iri: 'https://example.test/ontology/skos-class/TestObject',
    namespace: 'skos-class',
    localName: 'TestObject',
    label: 'Test Object',
    definition: 'a materialized test object',
    superTypes: [],
    attributeUses: [],
    patternBindings: [
      { pattern: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact' },
      { pattern: 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact' },
    ],
    alignments: [completeAlignment('skos:closeMatch')],
  };
  const file = writeYaml(dir, 'skos-class.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'SKOS must not masquerade as an OWL class alignment');
  assert.match(`${result.stdout}\n${result.stderr}`, /SKOS mapping properties require an actual CodeValueDefinition/i);
});

test('SKOS mappings on CodeListTypeDefinition are rejected because the list projects to owl:Class', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/skos-code-list',
    baseIri: 'https://example.test/ontology/skos-code-list/',
    preferredPrefix: 'skos-code-list',
    elementIri: 'https://example.test/ontology/skos-code-list/TestAttribute',
  });
  document.domain.codeLists.TestCodeList = {
    iri: 'https://example.test/ontology/skos-code-list/TestCodeList',
    namespace: 'skos-code-list',
    localName: 'TestCodeList',
    label: 'Test Code List',
    definition: 'a test-only controlled value set',
    vocabulary: 'Test Code List',
    version: '1.0.0',
    maintainer: 'Test Maintainer',
    sourceEvidenceRef: 'https://axiolune.ai/references/axiolune-m2-controlled-vocabularies',
    values: [{
      iri: 'https://example.test/ontology/skos-code-list/TestCodeList/value/one',
      notation: 'one',
      label: 'One',
      definition: 'the first test value',
    }],
    alignments: [completeAlignment('skos:exactMatch')],
  };
  const file = writeYaml(dir, 'skos-code-list.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'an owl:Class code list must not masquerade as a SKOS concept');
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /CodeListTypeDefinition projects to owl:Class.*no value-level Alignment field/i,
  );
});

test('approved modules require approved, principal-bound alignment review', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/approved-alignment',
    baseIri: 'https://example.test/ontology/approved-alignment/',
    preferredPrefix: 'approved-alignment',
    elementIri: 'https://example.test/ontology/approved-alignment/TestAttribute',
  });
  document.module.status = 'approved';
  document.module.governance = {
    ownerRef: 'urn:axiolune:principal:test-owner',
    approvedBy: 'urn:axiolune:principal:test-approver',
    approvedAt: '2026-07-31T00:00:00Z',
    status: 'approved',
  };
  document.domain.objectTypes.TestObject = {
    iri: 'https://example.test/ontology/approved-alignment/TestObject',
    namespace: 'approved-alignment',
    localName: 'TestObject',
    label: 'Test Object',
    definition: 'a materialized test object',
    superTypes: [],
    attributeUses: [],
    patternBindings: [
      { pattern: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact' },
      { pattern: 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact' },
    ],
    alignments: [completeAlignment()],
  };
  const file = writeYaml(dir, 'approved-alignment.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'proposed alignment review must block approved status');
  assert.match(`${result.stdout}\n${result.stderr}`, /approved modules require approved alignment verification/i);
});

test('reviewed alignments require an identified principal and explicit-timezone instant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/reviewed-alignment',
    baseIri: 'https://example.test/ontology/reviewed-alignment/',
    preferredPrefix: 'reviewed-alignment',
    elementIri: 'https://example.test/ontology/reviewed-alignment/TestAttribute',
  });
  const reviewed = completeAlignment('rdfs:subPropertyOf');
  reviewed.verification = {
    status: 'reviewed',
    verifiedBy: 'anonymous-reviewer',
    verifiedAt: '2026-07-31T00:00:00',
  };
  document.domain.attributeTypes.TestAttribute.alignments = [reviewed];
  const file = writeYaml(dir, 'reviewed-alignment.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'unbound review assertions must fail closed');
  assert.match(`${result.stdout}\n${result.stderr}`, /must be an absolute principal IRI/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be an explicit-timezone instant/i);
});

test('SHACL prose is rejected unless it uses the compiler-supported exact xone syntax', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/uncompiled-shacl',
    baseIri: 'https://example.test/ontology/uncompiled-shacl/',
    preferredPrefix: 'uncompiled-shacl',
    elementIri: 'https://example.test/ontology/uncompiled-shacl/TestAttribute',
  });
  document.domain.constraints.UncompiledConstraint = {
    iri: 'https://example.test/ontology/uncompiled-shacl/UncompiledConstraint',
    namespace: 'uncompiled-shacl',
    localName: 'UncompiledConstraint',
    label: 'Uncompiled Constraint',
    definition: 'test-only prose incorrectly labeled as executable SHACL',
    constraintType: 'Logical',
    scope: 'Object',
    expression: {
      language: 'SHACL',
      expression: 'sh:xone(first,second); the values must also agree',
    },
    severity: 'Error',
    message: 'the branches are incompatible',
    targetElement: 'https://example.test/ontology/uncompiled-shacl/TestAttribute',
  };
  document.domain.constraintBindings.push({
    constraintRef: document.domain.constraints.UncompiledConstraint.iri,
    targetElement: document.domain.constraints.UncompiledConstraint.targetElement,
    enforcementLevel: 'Mandatory',
  });
  const file = writeYaml(dir, 'uncompiled-shacl.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'uncompiled SHACL prose must fail closed');
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /current compiler accepts only exact sh:xone/i,
  );
});

test('materialized finance objects require both three-axis and provenance patterns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/materialized',
    baseIri: 'https://example.test/ontology/materialized/',
    preferredPrefix: 'materialized',
    elementIri: 'https://example.test/ontology/materialized/TestAttribute',
  });
  document.domain.objectTypes.TestObject = {
    iri: 'https://example.test/ontology/materialized/TestObject',
    namespace: 'materialized',
    localName: 'TestObject',
    label: 'Test Object',
    definition: 'a test-only materialized object',
    superTypes: [],
    attributeUses: [],
    patternBindings: [{
      pattern: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
    }],
  };
  const file = writeYaml(dir, 'materialized.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'missing provenance binding must fail closed');
  assert.match(`${result.stdout}\n${result.stderr}`, /requires exactly one .*ProvenancedFact/i);
});

test('exported association roles require lowerCamelCase labels and definitions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/public-role',
    baseIri: 'https://example.test/ontology/public-role/',
    preferredPrefix: 'public-role',
    elementIri: 'https://example.test/ontology/public-role/TestAttribute',
  });
  document.domain.associationTypes.TestAssociation = {
    iri: 'https://example.test/ontology/public-role/TestAssociation',
    namespace: 'public-role',
    localName: 'TestAssociation',
    label: 'Test Association',
    definition: 'a test-only public association',
    participantRoles: [
      {
        id: 'First_role',
        range: 'https://example.test/ontology/public-role/TestAssociation',
        minCount: 1,
        maxCount: 1,
      },
      {
        id: 'secondRole',
        range: 'https://example.test/ontology/public-role/TestAssociation',
        minCount: 1,
        maxCount: 1,
      },
    ],
    patternBindings: [
      { pattern: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact' },
      { pattern: 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact' },
    ],
  };
  const file = writeYaml(dir, 'public-role.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'underspecified public role contract must fail');
  assert.match(`${result.stdout}\n${result.stderr}`, /lowerCamelCase/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /missing required field `label`/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /missing required field `definition`/i);
});

test('typed-container membership rejects fields outside the selected M3 classifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/unknown-field',
    baseIri: 'https://example.test/ontology/unknown-field/',
    preferredPrefix: 'unknown-field',
    elementIri: 'https://example.test/ontology/unknown-field/TestAttribute',
  });
  document.domain.attributeTypes.TestAttribute.note = 'legacy extension';
  const file = writeYaml(dir, 'unknown-field.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'typed membership must select a closed M3 schema');
  assert.match(`${result.stdout}\n${result.stderr}`, /field is not allowed.*attributeTypes/i);
});

test('association roles reject legacy roleName and require M3 id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const document = moduleDocument({
    moduleIri: 'https://example.test/ontology/role',
    baseIri: 'https://example.test/ontology/role/',
    preferredPrefix: 'role',
    elementIri: 'https://example.test/ontology/role/TestAttribute',
  });
  document.domain.associationTypes.TestAssociation = {
    iri: 'https://example.test/ontology/role/TestAssociation',
    namespace: 'role',
    localName: 'TestAssociation',
    label: 'Test Association',
    definition: 'a test-only association',
    participantRoles: [
      {
        roleName: 'legacySubject',
        range: 'https://example.test/ontology/role/Subject',
        minCount: 1,
        maxCount: 1,
      },
      {
        id: 'object',
        range: 'https://example.test/ontology/role/Object',
        minCount: 1,
        maxCount: 1,
      },
    ],
  };
  const file = writeYaml(dir, 'role.yaml', document);

  const result = runValidator([file]);
  assert.notEqual(result.status, 0, 'legacy participant role dialect must fail');
  assert.match(`${result.stdout}\n${result.stderr}`, /missing M3 ParticipantRole `id`/);
  assert.match(`${result.stdout}\n${result.stderr}`, /roleName.*prohibited/i);
});

test('strict validator accepts exact imported version and byte digest for draft work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const imported = writeYaml(dir, 'imported.yaml', moduleDocument({
    moduleIri: 'https://example.test/ontology/imported',
    baseIri: 'https://example.test/ontology/imported/',
    preferredPrefix: 'imported',
    elementIri: 'https://example.test/ontology/imported/TestAttribute',
  }));
  const importer = writeYaml(dir, 'importer.yaml', moduleDocument({
    moduleIri: 'https://example.test/ontology/importer',
    baseIri: 'https://example.test/ontology/importer/',
    preferredPrefix: 'importer',
    elementIri: 'https://example.test/ontology/importer/TestAttribute',
    imports: [{
      moduleIri: 'https://example.test/ontology/imported',
      version: '1.0.0',
      artifactDigest: sha256(fs.readFileSync(imported)),
      importMode: 'All',
    }],
  }));

  const result = runValidator([imported, importer]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('approved module cannot import a draft module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-validator-'));
  const imported = writeYaml(dir, 'imported.yaml', moduleDocument({
    moduleIri: 'https://example.test/ontology/imported',
    baseIri: 'https://example.test/ontology/imported/',
    preferredPrefix: 'imported',
    elementIri: 'https://example.test/ontology/imported/TestAttribute',
  }));
  const importerDocument = moduleDocument({
    moduleIri: 'https://example.test/ontology/importer',
    baseIri: 'https://example.test/ontology/importer/',
    preferredPrefix: 'importer',
    elementIri: 'https://example.test/ontology/importer/TestAttribute',
    imports: [{
      moduleIri: 'https://example.test/ontology/imported',
      version: '1.0.0',
      artifactDigest: sha256(fs.readFileSync(imported)),
      importMode: 'All',
    }],
  });
  importerDocument.module.status = 'approved';
  importerDocument.module.governance.status = 'approved';
  const importer = writeYaml(dir, 'importer.yaml', importerDocument);

  const result = runValidator([imported, importer]);
  assert.notEqual(result.status, 0, 'approved-to-draft import must fail closed');
  assert.match(`${result.stdout}\n${result.stderr}`, /approved module imports draft module/i);
});

test('domain gate generates only into an isolated temporary output root', () => {
  const source = fs.readFileSync(DOMAIN_GATE, 'utf8');

  assert.match(source, /mkdtempSync/, 'gate must allocate an isolated output root');
  assert.match(source, /repositorySnapshot/, 'gate must snapshot repository bytes and status');
  assert.match(source, /assertSnapshotUnchanged/, 'gate must fail when a child mutates the repository');
  assert.match(source, /--untracked-files=all/, 'mutation guard must include new untracked files');
  assert.match(
    source,
    /untrackedSnapshot/,
    'mutation guard must fingerprint the bytes of already-untracked files',
  );
  assert.doesNotMatch(
    source,
    /generate-m2-owl\.cjs['"],\s*yamlPath,\s*owlSide/,
    'gate must never invoke a generator with a tracked ontology sidecar as output',
  );
  assert.doesNotMatch(
    source,
    /writeFileSync\(\s*owlGen|writeFileSync\(\s*shaclGen/,
    'gate must not copy generated bytes back into the repository',
  );
});

test('domain gate rejects pending, skipped, and warning evidence', () => {
  const source = fs.readFileSync(DOMAIN_GATE, 'utf8');

  assert.match(source, /pending/i);
  assert.match(source, /skipp?ed|SKIP/);
  assert.match(source, /warnings?|reasoner-warning/i);
  assert.doesNotMatch(
    source,
    /if\s*\(\s*!ev\.evidenceStatus\s*\)/,
    'mere presence of an evidenceStatus must not count as acceptance',
  );
});
