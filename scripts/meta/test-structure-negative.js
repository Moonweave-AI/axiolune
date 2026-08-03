#!/usr/bin/env node
/**
 * Negative tests for scripts/validate-structure.js — proves the validator
 * actually rejects malformed meta-models (catches the ADR-010 acceptance
 * criterion "unknown fields must fail"). Each case mutates a real file,
 * writes the 4-file set to a temp dir, runs the validator, and asserts it
 * exits non-zero (FAIL). A passing suite means the validator is not a
 * rubber stamp.
 *
 * Usage: node scripts/test-structure-negative.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const META_DIR = path.join(__dirname, '..', '..', 'ontology', 'meta');
const VALIDATOR = path.join(__dirname, 'validate-structure.js');
const FILES = ['core-meta-model.yaml', 'cross-domain-patterns.yaml', 'behavior-meta-model.yaml', 'data-binding-meta-model.yaml'];

function load(name) { return yaml.load(fs.readFileSync(path.join(META_DIR, name), 'utf8')); }

// Deep-clone via YAML round-trip (preserves structure, drops comments).
function clone(doc) { return yaml.load(yaml.dump(doc)); }

let failures = 0;
const cases = [];

// targetFile: which file to mutate ('*' = all). mutate(doc) mutates in place.
function case_(name, targetFile, mutate) { cases.push({ name, targetFile, mutate }); }

const CORE = 'core-meta-model.yaml';
const PAT = 'cross-domain-patterns.yaml';
const DB = 'data-binding-meta-model.yaml';

// 1. Unknown top-level key
case_('unknown top-level key', CORE, d => { d.__bogus_section = {}; });
// 2. Missing module.version
case_('missing module.version', CORE, d => { delete d.module.version; });
// 3. Bad semver on module.version
case_('bad semver', CORE, d => { d.module.version = '0.4'; });
// 4. Two layer sections present
case_('two layer sections', CORE, d => { d.CrossDomainPatterns = { version: '0.4.0', layer: 1 }; });
// 6. Attribute instance missing valueType
case_('attribute missing valueType', CORE, d => { delete d.MetaModel.validFrom.valueType; });
// 7. Attribute instance missing iri
case_('attribute missing iri', CORE, d => { delete d.MetaModel.availableFrom.iri; });
// 8. Bad owlProjectionOverride enum
case_('bad owlProjectionOverride', CORE, d => { d.MetaModel.validFrom.owlProjectionOverride = 'bogusProperty'; });
// 9. Bad baseIri (no trailing slash/#)
case_('bad baseIri', CORE, d => { d.module.baseIri = 'https://axiolune.ai/ontology/meta/core'; });

// Patterns-file mutations.
case_('constraint missing constraintType', PAT, d => { delete d.CrossDomainPatterns.constraints.PublishBeforeReceive.constraintType; });
case_('constraint bad severity', PAT, d => { d.CrossDomainPatterns.constraints.ConfidenceRange.severity = 'fatal'; });
case_('pattern missing iri', PAT, d => { delete d.CrossDomainPatterns.patterns[0].iri; });
case_('pattern bad version', PAT, d => { d.CrossDomainPatterns.patterns[0].version = '1.0'; });
case_('object abstract classifier weakened', CORE, d => {
  d.MetaModel.ObjectTypeDefinition.optionalFields.abstract.type = 'string';
});

// v0.6 closed-schema and reference-closure regressions.
case_('code value missing canonical notation', CORE,
  d => { delete d.MetaModel.CodeValueDefinition.requiredFields.notation; });
case_('symbol localAlias loses non-empty contract', CORE,
  d => { delete d.MetaModel.SymbolImportSpec.optionalFields.localAlias.minLength; });
case_('quantity rounding lexical set drift', CORE,
  d => { d.MetaModel.QuantityTypeDefinition.owlProjection.properties.find(
    p => p.predicateIri.endsWith('/hasRounding')).values = ['floor', 'ceiling', 'half-up']; });
case_('alignment locator weakened to plain IRI', CORE,
  d => { d.MetaModel.Alignment.requiredFields.sourceLocator.type = 'uri'; });
case_('removed run telemetry field restored', DB,
  d => { d.DataBinding.MaterializationRun.optionalFields = { status: { type: 'string' } }; });
case_('identity spec field-name drift', DB, d => {
  d.DataBinding.IdentitySpec.requiredFields.logicalComponentBindings =
    d.DataBinding.IdentitySpec.requiredFields.logicalKeyBindings;
  delete d.DataBinding.IdentitySpec.requiredFields.logicalKeyBindings;
});
case_('semantic mapping identity made optional', DB, d => {
  d.DataBinding.SemanticMappingDefinition.optionalFields.identity =
    d.DataBinding.SemanticMappingDefinition.requiredFields.identity;
  delete d.DataBinding.SemanticMappingDefinition.requiredFields.identity;
});
case_('runtime context omits immutable run IRI', DB, d => {
  d.DataBinding.ValueBinding.variants.RuntimeContextBinding.fields.contextField.values =
    ['assertionTime', 'referenceTime', 'runId'];
});
case_('runtime context admits digest injection', DB, d => {
  d.DataBinding.ValueBinding.variants.RuntimeContextBinding.fields.contextField.values =
    ['iri', 'assertionTime', 'referenceTime', 'runId', 'recordDigest'];
});
case_('unresolved schema type reference', DB,
  d => { d.DataBinding.MaterializationRun.requiredFields.result.type = 'MissingMaterializationResult'; });
case_('legacy PIT materializationRun field restored', DB,
  d => { d.DataBinding.PITValidationRequest.requiredFields.materializationRun = { type: 'uri' }; });
case_('missing SHACL property-shape type definition', PAT,
  d => { delete d.CrossDomainPatterns.SHACLPropertyShape; });
case_('legacy identifier and code-list datatype projection restored', CORE, d => {
  const rules = d.MetaModel.AttributeTypeDefinition.owlProjection.rules;
  rules.splice(1, 2,
    'IF valueType references IdentifierTypeDefinition or CodeListTypeDefinition THEN owl:DatatypeProperty');
});
case_('code-list attribute projection weakened to datatype property', CORE, d => {
  d.MetaModel.AttributeTypeDefinition.owlProjection.rules[2] =
    'IF valueType references CodeListTypeDefinition THEN owl:DatatypeProperty';
});
case_('sourceEvidenceRef projected as datatype property', CORE, d => {
  d.MetaModel.sourceEvidenceRef.owlProjectionOverride = 'datatypeProperty';
});
case_('pattern definition class signature removed', PAT, d => {
  delete d.CrossDomainPatterns.PatternDefinition.owlProjection;
});
case_('authored alignment without locked evidence', CORE, d => {
  d.MetaModel.validFrom.alignments = [{
    vocabulary: 'PROV-O',
    targetIri: 'http://www.w3.org/ns/prov#generatedAtTime',
    relation: 'rdfs:subPropertyOf',
    rationale: 'mutation must fail closed',
  }];
});
case_('alignment evidence fields made optional again', CORE, d => {
  d.MetaModel.Alignment.optionalFields = {
    sourceRelease: d.MetaModel.Alignment.requiredFields.sourceRelease,
    sourceLocator: d.MetaModel.Alignment.requiredFields.sourceLocator,
    rationale: d.MetaModel.Alignment.requiredFields.rationale,
    verification: d.MetaModel.Alignment.requiredFields.verification,
  };
  delete d.MetaModel.Alignment.requiredFields.sourceRelease;
  delete d.MetaModel.Alignment.requiredFields.sourceLocator;
  delete d.MetaModel.Alignment.requiredFields.rationale;
  delete d.MetaModel.Alignment.requiredFields.verification;
});

function runCase(c) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-meta-'));
  try {
    for (const f of FILES) {
      let doc = clone(load(f));
      if (c.targetFile === '*' || c.targetFile === f) c.mutate(doc);
      fs.writeFileSync(path.join(tmp, f), yaml.dump(doc));
    }
    const args = c.strict ? [VALIDATOR, '--strict'] : [VALIDATOR];
    let exitCode = 0;
    try {
      execFileSync('node', args, { env: { ...process.env, META_DIR: tmp }, stdio: 'ignore' });
    } catch (e) {
      exitCode = e.status ?? 1;
    }
    if (exitCode === 0) {
      console.log(`  ✗ FAIL: "${c.name}" — validator accepted malformed input (should have rejected)`);
      failures++;
    } else {
      console.log(`  ✓ "${c.name}" correctly rejected (exit ${exitCode})`);
    }
  } finally {
    for (const f of FILES) { try { fs.unlinkSync(path.join(tmp, f)); } catch {} }
    try { fs.rmdirSync(tmp); } catch {}
  }
}

// --strict typo-detection case (must be caught only in strict mode)
const strictCases = [
  { name: 'strict: typo type-classifier name', targetFile: CORE, strict: true,
    mutate: d => { d.MetaModel.ObjectTypeDefiniton = { definition: 'typo' }; } },
];

console.log('=== Negative Tests for validate-structure.js ===\n');
for (const c of cases) runCase(c);
console.log('\n=== --strict typo-detection ===');
for (const c of strictCases) runCase(c);

console.log('\n' + '='.repeat(50));
if (failures === 0) {
  console.log(`✅ ALL ${cases.length + strictCases.length} NEGATIVE TESTS PASSED`);
  process.exit(0);
} else {
  console.log(`❌ ${failures}/${cases.length + strictCases.length} negative tests failed`);
  process.exit(1);
}
