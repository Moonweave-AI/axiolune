#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { Parser } = require('n3');
const { projectOwl } = require('./generate-m2-owl.cjs');
const { projectShacl } = require('./generate-m2-shacl.cjs');
const {
  auditModuleContract,
  findingDigest,
  validateScenario,
} = require('./lib/market-data-v03-contracts.cjs');
const {
  loadFixture,
  materializeYamlMerges,
} = require('./lib/strict-fixture-loader.cjs');
const {
  effectivePatternInjectedAttributeUse,
} = require('./lib/pattern-injected-fields.cjs');
const {
  buildCodeListAuthorityIndex,
  buildReferenceEvidenceIndex,
} = require('./lib/source-evidence-reference.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'market-data', 'module.yaml');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'm2', 'fixtures', 'market-data-v03');
const REFERENCE_LOCK_FILE = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'references.lock.yaml',
);
const CODE_LIST_AUTHORITY_FILE = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-vocabularies',
  'm2-v0.3-code-lists.json',
);
const PROVENANCE = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const REVISION = 'https://axiolune.ai/ontology/meta/patterns/attributes/revision';
function loadYaml(file) {
  return materializeYamlMerges(yaml.load(fs.readFileSync(file, 'utf8')));
}

function format(finding) {
  return `${finding.code} @ ${finding.at}: ${finding.message}`;
}

async function main() {
  const passes = [];
  const failures = [];
  const pending = [];
  const moduleDocument = loadYaml(MODULE_FILE);
  const referenceState = buildReferenceEvidenceIndex(loadYaml(REFERENCE_LOCK_FILE));
  failures.push(...referenceState.errors.map((message) => (
    `reference evidence index: ${message}`
  )));
  const codeListAuthorityState = buildCodeListAuthorityIndex(
    JSON.parse(fs.readFileSync(CODE_LIST_AUTHORITY_FILE, 'utf8')),
    referenceState.entries,
  );
  failures.push(...codeListAuthorityState.errors.map((message) => (
    `code-list authority candidate: ${message}`
  )));
  const marketDataAuthorityEntries = [...codeListAuthorityState.entries.values()]
    .filter((entry) => entry.moduleId === 'market-data');
  const marketDataUpstreamEvidence = marketDataAuthorityEntries
    .flatMap((entry) => entry.upstreamEvidence || []);
  if (marketDataAuthorityEntries.length === 7
      && marketDataAuthorityEntries.every((entry) => (
        entry.authorityKind === 'axioluneOperational'
          && Array.isArray(entry.upstreamEvidence)
      ))
      && marketDataUpstreamEvidence.every((evidence) => evidence.usage !== 'normative')) {
    passes.push(
      `locked authority candidate resolves all seven Market Data lists as local operational vocabularies without fabricated normative upstream authority (context records=${marketDataUpstreamEvidence.length})`,
    );
  } else {
    failures.push(
      'Market Data authority trace must resolve exactly seven axioluneOperational entries without an unsupported normative upstream claim',
    );
  }
  const audit = auditModuleContract(moduleDocument, { codeListAuthorityState });
  if (audit.violations.length === 0) passes.push('typed ontology contract');
  else failures.push(...audit.violations.map(format));
  pending.push(...audit.pending.map(format));

  const materialized = [
    moduleDocument.domain.objectTypes.MarketDataStream,
    moduleDocument.domain.objectTypes.BarSpecification,
    moduleDocument.domain.associationTypes.PriceObservation,
    moduleDocument.domain.associationTypes.QuoteObservation,
    moduleDocument.domain.associationTypes.TradeObservation,
    moduleDocument.domain.associationTypes.TradeBar,
    moduleDocument.domain.associationTypes.QuoteBar,
    moduleDocument.domain.associationTypes.MarketDataQualityFinding,
    moduleDocument.domain.associationTypes.FXRateObservation,
  ];
  const effectiveRevisionProfile = materialized.every((element) => {
    const authored = array(element?.attributeUses)
      .filter((use) => use?.attribute === REVISION);
    const effective = effectivePatternInjectedAttributeUse(element, REVISION);
    return authored.length === 0 && effective?.minCount === 1 && effective?.maxCount === 1;
  });
  if (effectiveRevisionProfile) {
    passes.push('shared ProvenancedFact profile injects revision 1..1 without duplicate AttributeUse');
  } else {
    failures.push('shared ProvenancedFact profile did not resolve revision 1..1 for all nine materialized types');
  }

  const missingProvenance = structuredClone(moduleDocument);
  missingProvenance.domain.objectTypes.MarketDataStream.patternBindings = array(
    missingProvenance.domain.objectTypes.MarketDataStream.patternBindings,
  ).filter((binding) => binding?.pattern !== PROVENANCE);
  const negativeAudit = auditModuleContract(missingProvenance);
  const negativeCodes = new Set(negativeAudit.violations
    .filter((finding) => finding.at === 'MarketDataStream')
    .map((finding) => finding.code));
  if (negativeCodes.has('ONTOLOGY_FACT_PATTERNS')
      && negativeCodes.has('ONTOLOGY_VERSION_KEY')) {
    passes.push('missing ProvenancedFact binding fails both fact-pattern and effective version-key gates');
  } else {
    failures.push(`missing ProvenancedFact regression escaped: ${[...negativeCodes].sort().join(', ')}`);
  }

  const digestSet = ['urn:observation:b', 'urn:observation:a', 'urn:observation:a'];
  const canonicalDigest = findingDigest('crossedQuote', digestSet);
  if (canonicalDigest !== findingDigest('duplicateConflict', digestSet)
      || canonicalDigest !== findingDigest('orderingCollision', ['urn:observation:a', 'urn:observation:b'])
      || canonicalDigest === findingDigest('crossedQuote', ['urn:observation:a\0urn:observation:b'])) {
    failures.push('quality-finding iriSetDigest framing/kind separation is invalid');
  } else {
    passes.push('quality-finding framed iriSetDigest is set-stable and keeps kind outside the digest');
  }

  try {
    const [owlOne, owlTwo, shaclOne, shaclTwo] = await Promise.all([
      projectOwl(moduleDocument), projectOwl(moduleDocument),
      projectShacl(moduleDocument), projectShacl(moduleDocument),
    ]);
    if (!Buffer.from(owlOne).equals(Buffer.from(owlTwo))) failures.push('OWL projection is nondeterministic');
    else {
      const owlQuads = new Parser().parse(String(owlOne));
      passes.push('deterministic parseable OWL projection');
      const revisionRestrictionCount = materialized.reduce((count, element) => {
        const restrictions = owlQuads
          .filter((quad) => (
            quad.subject.value === element.iri
            && quad.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
            && quad.object.termType === 'BlankNode'
          ))
          .map((quad) => quad.object.value)
          .filter((subject) => owlQuads.some((quad) => (
            quad.subject.value === subject
            && quad.predicate.value === 'http://www.w3.org/2002/07/owl#onProperty'
            && quad.object.value === REVISION
          )))
          .filter((subject) => owlQuads.some((quad) => (
            quad.subject.value === subject
            && quad.predicate.value === 'http://www.w3.org/2002/07/owl#cardinality'
            && quad.object.value === '1'
          )));
        return count + (restrictions.length === 1 ? 1 : 0);
      }, 0);
      if (revisionRestrictionCount === materialized.length) {
        passes.push('OWL projects one unqualified revision cardinality-1 restriction for all nine materialized types');
      } else {
        failures.push(`OWL projects valid revision cardinality for ${revisionRestrictionCount}/${materialized.length} materialized types`);
      }
      const priceObservationIri = moduleDocument.domain.associationTypes.PriceObservation.iri;
      const calculationFields = [
        `${moduleDocument.module.baseIri}calculationDefinitionRef`,
        `${moduleDocument.module.baseIri}calculationDefinitionDigest`,
        `${moduleDocument.module.baseIri}calculationRunRef`,
        `${moduleDocument.module.baseIri}calculationRunDigest`,
        `${moduleDocument.module.baseIri}calculationInputSetDigest`,
      ];
      const optionalCalculationRestrictions = calculationFields.filter((field) => {
        const restrictions = owlQuads
          .filter((quad) => (
            quad.subject.value === priceObservationIri
            && quad.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
            && quad.object.termType === 'BlankNode'
          ))
          .map((quad) => quad.object.value);
        return restrictions.some((subject) => (
          owlQuads.some((quad) => (
            quad.subject.value === subject
            && quad.predicate.value === 'http://www.w3.org/2002/07/owl#onProperty'
            && quad.object.value === field
          ))
          && owlQuads.some((quad) => (
            quad.subject.value === subject
            && quad.predicate.value === 'http://www.w3.org/2002/07/owl#maxCardinality'
            && quad.object.value === '1'
          ))
        ));
      });
      if (optionalCalculationRestrictions.length === calculationFields.length) {
        passes.push('OWL exposes all five byte-locked calculation evidence fields as PriceObservation 0..1 slots');
      } else {
        failures.push('OWL does not expose all definition/run/input-set evidence slots on PriceObservation');
      }
    }
    if (!Buffer.from(shaclOne).equals(Buffer.from(shaclTwo))) failures.push('SHACL projection is nondeterministic');
    else {
      const quads = new Parser().parse(String(shaclOne));
      const xoneSubjects = new Set(quads
        .filter((quad) => quad.predicate.value === 'http://www.w3.org/ns/shacl#xone')
        .map((quad) => quad.subject.value));
      if (xoneSubjects.size !== 6) failures.push(`generated SHACL contains ${xoneSubjects.size} xone shapes; expected 6`);
      else passes.push('six target-specific context xone constraints compile to SHACL');
      const revisionShapeCount = materialized.reduce((count, element) => {
        const shapes = quads
          .filter((quad) => (
            quad.predicate.value === 'http://www.w3.org/ns/shacl#path'
            && quad.object.value === REVISION
            && quad.subject.value.startsWith(element.iri)
          ))
          .map((quad) => quad.subject.value)
          .filter((subject) => (
            quads.some((quad) => (
              quad.subject.value === subject
              && quad.predicate.value === 'http://www.w3.org/ns/shacl#minCount'
              && quad.object.value === '1'
            ))
            && quads.some((quad) => (
              quad.subject.value === subject
              && quad.predicate.value === 'http://www.w3.org/ns/shacl#maxCount'
              && quad.object.value === '1'
            ))
          ));
        return count + (shapes.length === 1 ? 1 : 0);
      }, 0);
      if (revisionShapeCount === materialized.length) {
        passes.push('SHACL projects revision minCount/maxCount 1 for all nine materialized types');
      } else {
        failures.push(`SHACL projects valid revision cardinality for ${revisionShapeCount}/${materialized.length} materialized types`);
      }
      const priceObservationIri = moduleDocument.domain.associationTypes.PriceObservation.iri;
      const calculationFields = [
        `${moduleDocument.module.baseIri}calculationDefinitionRef`,
        `${moduleDocument.module.baseIri}calculationDefinitionDigest`,
        `${moduleDocument.module.baseIri}calculationRunRef`,
        `${moduleDocument.module.baseIri}calculationRunDigest`,
        `${moduleDocument.module.baseIri}calculationInputSetDigest`,
      ];
      const optionalCalculationShapes = calculationFields.filter((field) => {
        const subjects = quads
          .filter((quad) => (
            quad.predicate.value === 'http://www.w3.org/ns/shacl#path'
            && quad.object.value === field
            && quad.subject.value.startsWith(priceObservationIri)
          ))
          .map((quad) => quad.subject.value);
        return subjects.some((subject) => (
          quads.some((quad) => (
            quad.subject.value === subject
            && quad.predicate.value === 'http://www.w3.org/ns/shacl#maxCount'
            && quad.object.value === '1'
          ))
          && !quads.some((quad) => (
            quad.subject.value === subject
            && quad.predicate.value === 'http://www.w3.org/ns/shacl#minCount'
            && quad.object.value !== '0'
          ))
        ));
      });
      if (optionalCalculationShapes.length === calculationFields.length) {
        passes.push('SHACL exposes all five byte-locked calculation evidence fields as PriceObservation 0..1 slots');
      } else {
        failures.push('SHACL does not expose all definition/run/input-set evidence slots on PriceObservation');
      }
      passes.push('deterministic parseable Tier-1 SHACL projection');
    }
  } catch (error) {
    failures.push(`projection failed: ${error.message}`);
  }

  const fixtureFiles = fs.readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of fixtureFiles) {
    let fixture;
    try {
      fixture = loadFixture(path.join(FIXTURE_DIR, name), { rootDirectory: FIXTURE_DIR });
    } catch (error) {
      failures.push(`${name}: load failed: ${error.message}`);
      continue;
    }
    const violations = validateScenario(fixture);
    const codes = new Set(violations.map((violation) => violation.code));
    if (fixture.expected?.valid === true) {
      if (violations.length === 0) passes.push(`${fixture.caseId}: accepted`);
      else failures.push(`${fixture.caseId}: expected accepted, got ${violations.map(format).join(' | ')}`);
    } else if (fixture.expected?.valid === false) {
      if (violations.length === 0) failures.push(`${fixture.caseId}: negative fixture was accepted`);
      else {
        const missing = array(fixture.expected.codes).filter((code) => !codes.has(code));
        if (missing.length > 0) failures.push(`${fixture.caseId}: missing expected codes ${missing.join(', ')}`);
        else passes.push(`${fixture.caseId}: rejected with ${[...codes].sort().join(', ')}`);
      }
    } else {
      failures.push(`${fixture.caseId || name}: expected.valid must be boolean`);
    }
  }

  console.log('=== Market Data v0.3.0 contract gate ===');
  passes.forEach((item) => console.log(`PASS ${item}`));
  failures.forEach((item) => console.log(`FAIL ${item}`));
  pending.forEach((item) => console.log(`PENDING ${item}`));
  console.log(`SUMMARY pass=${passes.length} fail=${failures.length} pending=${pending.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else if (pending.length > 0) process.exitCode = 2;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
