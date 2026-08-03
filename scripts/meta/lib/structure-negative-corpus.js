'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { validateMetaStructure } = require('../validate-structure.js');

const FILES = Object.freeze([
  'behavior-meta-model.yaml',
  'core-meta-model.yaml',
  'cross-domain-patterns.yaml',
  'data-binding-meta-model.yaml',
]);
const CORE = 'core-meta-model.yaml';
const PATTERNS = 'cross-domain-patterns.yaml';
const BINDING = 'data-binding-meta-model.yaml';

function cases() {
  return [
    ['unknown top-level key', CORE, false, (doc) => { doc.__bogus_section = {}; }],
    ['missing module.version', CORE, false, (doc) => { delete doc.module.version; }],
    ['bad semver', CORE, false, (doc) => { doc.module.version = '0.4'; }],
    ['bad import digest', BINDING, false, (doc) => {
      doc.module.imports[0].artifactDigest = 'not-a-digest';
    }],
    ['two layer sections', CORE, false, (doc) => {
      doc.CrossDomainPatterns = { version: '0.4.0', layer: 1 };
    }],
    ['attribute missing valueType', CORE, false, (doc) => {
      delete doc.MetaModel.validFrom.valueType;
    }],
    ['attribute missing iri', CORE, false, (doc) => {
      delete doc.MetaModel.availableFrom.iri;
    }],
    ['bad owlProjectionOverride', CORE, false, (doc) => {
      doc.MetaModel.validFrom.owlProjectionOverride = 'bogusProperty';
    }],
    ['bad baseIri', CORE, false, (doc) => {
      doc.module.baseIri = 'https://axiolune.ai/ontology/meta/core';
    }],
    ['constraint missing constraintType', PATTERNS, false, (doc) => {
      delete doc.CrossDomainPatterns.constraints.PublishBeforeReceive.constraintType;
    }],
    ['constraint bad severity', PATTERNS, false, (doc) => {
      doc.CrossDomainPatterns.constraints.ConfidenceRange.severity = 'fatal';
    }],
    ['pattern missing iri', PATTERNS, false, (doc) => {
      delete doc.CrossDomainPatterns.patterns[0].iri;
    }],
    ['pattern bad version', PATTERNS, false, (doc) => {
      doc.CrossDomainPatterns.patterns[0].version = '1.0';
    }],
    ['object abstract classifier weakened', CORE, false, (doc) => {
      doc.MetaModel.ObjectTypeDefinition.optionalFields.abstract.type = 'string';
    }],
    ['code value missing canonical notation', CORE, false, (doc) => {
      delete doc.MetaModel.CodeValueDefinition.requiredFields.notation;
    }],
    ['symbol localAlias loses non-empty contract', CORE, false, (doc) => {
      delete doc.MetaModel.SymbolImportSpec.optionalFields.localAlias.minLength;
    }],
    ['quantity rounding lexical set drift', CORE, false, (doc) => {
      doc.MetaModel.QuantityTypeDefinition.owlProjection.properties.find(
        (property) => property.predicateIri.endsWith('/hasRounding'),
      ).values = ['floor', 'ceiling', 'half-up'];
    }],
    ['alignment locator weakened to plain IRI', CORE, false, (doc) => {
      doc.MetaModel.Alignment.requiredFields.sourceLocator.type = 'uri';
    }],
    ['removed run telemetry field restored', BINDING, false, (doc) => {
      doc.DataBinding.MaterializationRun.optionalFields = { status: { type: 'string' } };
    }],
    ['identity spec field-name drift', BINDING, false, (doc) => {
      doc.DataBinding.IdentitySpec.requiredFields.logicalComponentBindings =
        doc.DataBinding.IdentitySpec.requiredFields.logicalKeyBindings;
      delete doc.DataBinding.IdentitySpec.requiredFields.logicalKeyBindings;
    }],
    ['semantic mapping identity made optional', BINDING, false, (doc) => {
      doc.DataBinding.SemanticMappingDefinition.optionalFields.identity =
        doc.DataBinding.SemanticMappingDefinition.requiredFields.identity;
      delete doc.DataBinding.SemanticMappingDefinition.requiredFields.identity;
    }],
    ['runtime context omits immutable run IRI', BINDING, false, (doc) => {
      doc.DataBinding.ValueBinding.variants.RuntimeContextBinding.fields.contextField.values =
        ['assertionTime', 'referenceTime', 'runId'];
    }],
    ['runtime context admits digest injection', BINDING, false, (doc) => {
      doc.DataBinding.ValueBinding.variants.RuntimeContextBinding.fields.contextField.values =
        ['iri', 'assertionTime', 'referenceTime', 'runId', 'recordDigest'];
    }],
    ['unresolved schema type reference', BINDING, false, (doc) => {
      doc.DataBinding.MaterializationRun.requiredFields.result.type =
        'MissingMaterializationResult';
    }],
    ['legacy PIT materializationRun field restored', BINDING, false, (doc) => {
      doc.DataBinding.PITValidationRequest.requiredFields.materializationRun = { type: 'uri' };
    }],
    ['missing SHACL property-shape type definition', PATTERNS, false, (doc) => {
      delete doc.CrossDomainPatterns.SHACLPropertyShape;
    }],
    ['legacy identifier and code-list datatype projection restored', CORE, false, (doc) => {
      const rules = doc.MetaModel.AttributeTypeDefinition.owlProjection.rules;
      rules.splice(
        1,
        2,
        'IF valueType references IdentifierTypeDefinition or CodeListTypeDefinition THEN owl:DatatypeProperty',
      );
    }],
    ['code-list attribute projection weakened to datatype property', CORE, false, (doc) => {
      doc.MetaModel.AttributeTypeDefinition.owlProjection.rules[2] =
        'IF valueType references CodeListTypeDefinition THEN owl:DatatypeProperty';
    }],
    ['sourceEvidenceRef projected as datatype property', CORE, false, (doc) => {
      doc.MetaModel.sourceEvidenceRef.owlProjectionOverride = 'datatypeProperty';
    }],
    ['pattern definition class signature removed', PATTERNS, false, (doc) => {
      delete doc.CrossDomainPatterns.PatternDefinition.owlProjection;
    }],
    ['authored alignment without locked evidence', CORE, false, (doc) => {
      doc.MetaModel.validFrom.alignments = [{
        vocabulary: 'PROV-O',
        targetIri: 'http://www.w3.org/ns/prov#generatedAtTime',
        relation: 'rdfs:subPropertyOf',
        rationale: 'mutation must fail closed',
      }];
    }],
    ['alignment evidence fields made optional again', CORE, false, (doc) => {
      doc.MetaModel.Alignment.optionalFields = {
        sourceRelease: doc.MetaModel.Alignment.requiredFields.sourceRelease,
        sourceLocator: doc.MetaModel.Alignment.requiredFields.sourceLocator,
        rationale: doc.MetaModel.Alignment.requiredFields.rationale,
        verification: doc.MetaModel.Alignment.requiredFields.verification,
      };
      delete doc.MetaModel.Alignment.requiredFields.sourceRelease;
      delete doc.MetaModel.Alignment.requiredFields.sourceLocator;
      delete doc.MetaModel.Alignment.requiredFields.rationale;
      delete doc.MetaModel.Alignment.requiredFields.verification;
    }],
    ['strict typo type-classifier name', CORE, true, (doc) => {
      doc.MetaModel.ObjectTypeDefiniton = { definition: 'typo' };
    }],
  ].map(([name, targetFile, strict, mutate]) => ({ name, targetFile, strict, mutate }));
}

function clone(value) {
  return yaml.load(yaml.dump(value, { noRefs: true }));
}

function loadDocuments(metaDir) {
  return new Map(FILES.map((file) => [
    file,
    yaml.load(fs.readFileSync(path.join(metaDir, file), 'utf8')),
  ]));
}

function serializeDocuments(documents) {
  return new Map([...documents].map(([file, document]) => [
    file,
    yaml.dump(document, { noRefs: true }),
  ]));
}

function runStructureNegativeCorpus(options = {}) {
  const metaDir = path.resolve(options.metaDir);
  const base = loadDocuments(metaDir);
  const positive = validateMetaStructure({ metaDir, strict: true });
  const results = [];
  for (const testCase of cases()) {
    try {
      const documents = new Map([...base].map(([file, document]) => [file, clone(document)]));
      testCase.mutate(documents.get(testCase.targetFile));
      const validation = validateMetaStructure({
        metaDir,
        strict: testCase.strict,
        sources: serializeDocuments(documents),
      });
      results.push({
        name: testCase.name,
        rejected: !validation.ok,
        errorCount: validation.errors.length,
        firstError: validation.errors[0] || null,
      });
    } catch (error) {
      results.push({
        name: testCase.name,
        rejected: false,
        errorCount: 0,
        firstError: `negative fixture failed to execute: ${error.message}`,
      });
    }
  }
  return {
    ok: positive.ok && results.every((row) => row.rejected),
    positive,
    caseCount: results.length,
    results,
  };
}

module.exports = { FILES, cases, runStructureNegativeCorpus };
