#!/usr/bin/env node
/**
 * D4/D5 verification for the M3->M2 projection.
 *   1. Parse the generated OWL turtle (n3) — asserts zero syntax errors.
 *   2. Parse the generated SHACL turtle (n3) — asserts zero syntax errors
 *      (this also parse-verifies the Tier-2 sh:SPARQL constraints).
 *   3. SHACL-validate good M1 data -> conforms TRUE.
 *   4. SHACL-validate bad M1 data for each Tier-1 constraint -> conforms FALSE
 *      and the violation points at the right path.
 *
 * Exit 0 only if all assertions pass. Uses rdf-validate-shacl (core SHACL only;
 * sh:SPARQL Tier-2 constraints are parse-verified in step 2, enforcement needs a
 * SPARQL-capable engine and is out of scope for this machine check).
 */
const fs = require('fs');
const path = require('path');
const { Parser, Store, DataFactory } = require('n3');
const { namedNode } = DataFactory;
const yaml = require('js-yaml');
const SHACLValidator = require('rdf-validate-shacl').default;

const META = process.env.META_DIR
  ? path.resolve(process.env.META_DIR)
  : path.join(__dirname, '..', '..', 'ontology', 'meta');
const PROJECTION = process.env.META_PROJECTION_DIR
  ? path.resolve(process.env.META_PROJECTION_DIR)
  : path.join(META, 'projection');
const AX = 'https://axiolune.ai/ontology/meta/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ATTR = AX + 'patterns/attributes/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL = 'http://www.w3.org/2002/07/owl#';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.error('  ✗ ' + m); fail++; };

function parse(file, label) {
  const ttl = fs.readFileSync(file, 'utf8');
  try {
    const quads = new Parser().parse(ttl);
    ok(`${label} parses: ${quads.length} quads`);
    return new Store(quads);
  } catch (e) {
    bad(`${label} parse error: ${e.message}`);
    return null;
  }
}

const owlStore = parse(path.join(PROJECTION, 'axiolune-meta.owl.ttl'), 'OWL turtle');
const shaclStore = parse(path.join(PROJECTION, 'axiolune-meta.shacl.ttl'), 'SHACL turtle (Tier1)');
const sparqlStore = parse(path.join(PROJECTION, 'axiolune-meta.shacl-sparql.ttl'), 'SHACL turtle (Tier2 SPARQL, parse-only)');
if (!owlStore || !shaclStore || !sparqlStore) { console.log('\n❌ parse failed'); process.exit(1); }

function hasOwlType(iri, typeLocalName) {
  return owlStore.countQuads(
    namedNode(iri), namedNode(RDF_TYPE), namedNode(OWL + typeLocalName), null,
  ) > 0;
}

console.log('\n=== Canonical OWL signature closure ===');
const sourceEvidenceRef = AX + 'core/annotations/sourceEvidenceRef';
if (hasOwlType(sourceEvidenceRef, 'AnnotationProperty') &&
    !hasOwlType(sourceEvidenceRef, 'DatatypeProperty') &&
    !hasOwlType(sourceEvidenceRef, 'ObjectProperty')) {
  ok('sourceEvidenceRef has the exclusive owl:AnnotationProperty signature');
} else {
  bad('sourceEvidenceRef must be exclusively owl:AnnotationProperty');
}

const sourcePatterns = yaml.load(
  fs.readFileSync(path.join(META, 'cross-domain-patterns.yaml'), 'utf8'),
).CrossDomainPatterns.patterns || [];
if (sourcePatterns.length !== 7) {
  bad(`expected 7 concrete PatternDefinition instances, found ${sourcePatterns.length}`);
}
for (const pattern of sourcePatterns) {
  if (hasOwlType(pattern.iri, 'Class')) ok(`${pattern.pattern} has explicit owl:Class signature`);
  else bad(`${pattern.pattern} is missing its explicit owl:Class signature`);
}

// Build a data graph (M1 instance) as a Store.
function dataGraph(props, type) {
  const inst = 'http://test/inst';
  const lines = ['@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .', `@prefix ax: <${AX}> .`];
  // Pattern types live under .../meta/patterns/<Name>; the generic PatternFact is under .../meta/
  const typeIri = type && type !== 'PatternFact' ? `${AX}patterns/${type}` : `${AX}${type || 'PatternFact'}`;
  const cls = `<${typeIri}>`;
  const pps = Object.entries(props).map(([k, v]) => {
    const [val, dt] = Array.isArray(v) ? v : [v, null];
    const obj = dt ? `"${val}"^^xsd:${dt}` : (v === null ? '""' : `"${val}"`);
    return `<${ATTR}${k}> ${obj}`;
  });
  lines.push(`<${inst}> a ${cls} ; ${pps.join(' ; ')} .`);
  return new Store(new Parser().parse(lines.join('\n')));
}

function structuredDataGraph(typeLocalName, props) {
  const typeIri = `${AX}core/values/${typeLocalName}`;
  const base = `${AX}core/properties/`;
  const lines = [
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    `<http://test/structured> a <${typeIri}> ;`,
  ];
  const values = Object.entries(props).map(([name, [value, datatype]]) =>
    `  <${base}${name}> "${value}"^^xsd:${datatype}`
  );
  lines.push(values.join(' ;\n') + ' .');
  return new Store(new Parser().parse(lines.join('\n')));
}

async function validate(data, label) {
  const v = new SHACLValidator(shaclStore);
  const report = await v.validate(data);
  const paths = report.conforms ? [] : [...report.results].map(r => r.path && r.path.value).filter(Boolean);
  return { conforms: report.conforms, paths };
}

(async () => {
  console.log('\n=== SHACL validation (good vs bad M1 data) ===');

  const good = dataGraph({
    confidence: ['0.8', 'decimal'], semanticVersion: '1.2.3', evidenceDigest: 'sha256:' + 'a'.repeat(64),
  });
  const gr = await validate(good, 'good');
  if (gr.conforms) ok('good data conforms (all Tier-1 constraints satisfied)');
  else bad(`good data should conform, got violations on: ${gr.paths.join(', ')}`);

  // bad: confidence out of range
  const badConf = dataGraph({ confidence: ['1.5', 'decimal'], semanticVersion: '1.2.3', evidenceDigest: 'sha256:' + 'a'.repeat(64) });
  const r1 = await validate(badConf, 'confidence');
  if (!r1.conforms && r1.paths.some(p => p.includes('confidence'))) ok('confidence=1.5 correctly rejected (ConfidenceRange)');
  else bad(`confidence=1.5 should be rejected on confidence path; conforms=${r1.conforms} paths=${r1.paths.join(',')}`);

  // bad: bad semver
  const badSemver = dataGraph({ confidence: ['0.5', 'decimal'], semanticVersion: '1.0', evidenceDigest: 'sha256:' + 'a'.repeat(64) });
  const r2 = await validate(badSemver, 'semver');
  if (!r2.conforms && r2.paths.some(p => p.includes('semanticVersion'))) ok('semanticVersion=1.0 correctly rejected (SemanticVersionFormat)');
  else bad(`semanticVersion=1.0 should be rejected; conforms=${r2.conforms} paths=${r2.paths.join(',')}`);

  // bad: bad digest
  const badDig = dataGraph({ confidence: ['0.5', 'decimal'], semanticVersion: '1.0.0', evidenceDigest: 'not-a-digest' });
  const r3 = await validate(badDig, 'digest');
  if (!r3.conforms && r3.paths.some(p => p.includes('evidenceDigest'))) ok('evidenceDigest=not-a-digest correctly rejected (DigestFormat)');
  else bad(`evidenceDigest=bad should be rejected; conforms=${r3.conforms} paths=${r3.paths.join(',')}`);

  // ---- Per-pattern TemporalFactShape enforcement (Tier 1) ----
  console.log('\n=== Per-pattern shape enforcement (TemporalFact) ===');
  // good: a TemporalFact instance WITH validFrom + knowledgeFrom + availableFrom (all 3 axes required, fail-closed)
  const tfGood = dataGraph({
    validFrom: ['2026-07-29T09:30:00Z', 'dateTime'], knowledgeFrom: ['2026-07-29T09:30:00Z', 'dateTime'],
    availableFrom: ['2026-07-29T09:35:00Z', 'dateTime'],
  }, 'TemporalFact');
  const rtg = await validate(tfGood, 'tf-good');
  if (rtg.conforms) ok('TemporalFact with validFrom+knowledgeFrom+availableFrom conforms');
  else bad(`TemporalFact good should conform; violations on: ${rtg.paths.join(', ')}`);

  // bad: a TemporalFact instance MISSING validFrom (TemporalFactShape requires minCount 1)
  const tfBad = dataGraph({ knowledgeFrom: ['2026-07-29T09:30:00Z', 'dateTime'], availableFrom: ['2026-07-29T09:35:00Z', 'dateTime'] }, 'TemporalFact');
  const rtb = await validate(tfBad, 'tf-bad-missing-validFrom');
  if (!rtb.conforms && rtb.paths.some(p => p.includes('validFrom'))) ok('TemporalFact missing validFrom correctly rejected (TemporalFactShape requires validFrom)');
  else bad(`TemporalFact missing validFrom should be rejected on validFrom; conforms=${rtb.conforms} paths=${rtb.paths.join(',')}`);

  // bad: a TemporalFact instance MISSING availableFrom (fail-closed: minCount 1 after review fix)
  const tfBadAvail = dataGraph({ validFrom: ['2026-07-29T09:30:00Z', 'dateTime'], knowledgeFrom: ['2026-07-29T09:30:00Z', 'dateTime'] }, 'TemporalFact');
  const rtba = await validate(tfBadAvail, 'tf-bad-missing-availableFrom');
  if (!rtba.conforms && rtba.paths.some(p => p.includes('availableFrom'))) ok('TemporalFact missing availableFrom correctly rejected (fail-closed PIT)');
  else bad(`TemporalFact missing availableFrom should be rejected (fail-closed); conforms=${rtba.conforms} paths=${rtba.paths.join(',')}`);

  // ---- Canonical structured-value enforcement (Tier 1) ----
  console.log('\n=== Structured-value shape enforcement ===');
  const quantityGood = structuredDataGraph('QuantityValue', {
    hasNumericValue: ['12.5', 'decimal'],
    hasUnit: ['https://qudt.org/vocab/unit/Share', 'string'],
    hasRounding: ['half-even', 'string'],
  });
  const quantityGoodResult = await validate(quantityGood, 'quantity-good');
  if (quantityGoodResult.conforms) ok('QuantityValue with value, absolute unit IRI lexical form, and rounding conforms');
  else bad(`QuantityValue good should conform; violations on: ${quantityGoodResult.paths.join(', ')}`);

  const quantityMissingRounding = structuredDataGraph('QuantityValue', {
    hasNumericValue: ['12.5', 'decimal'],
    hasUnit: ['https://qudt.org/vocab/unit/Share', 'string'],
  });
  const quantityMissingResult = await validate(quantityMissingRounding, 'quantity-missing-rounding');
  if (!quantityMissingResult.conforms && quantityMissingResult.paths.some(p => p.includes('hasRounding'))) {
    ok('QuantityValue missing hasRounding correctly rejected');
  } else {
    bad(`QuantityValue missing hasRounding should be rejected; conforms=${quantityMissingResult.conforms} paths=${quantityMissingResult.paths.join(',')}`);
  }

  const quantityBadRounding = structuredDataGraph('QuantityValue', {
    hasNumericValue: ['12.5', 'decimal'],
    hasUnit: ['https://qudt.org/vocab/unit/Share', 'string'],
    hasRounding: ['bankers-ish', 'string'],
  });
  const quantityBadResult = await validate(quantityBadRounding, 'quantity-bad-rounding');
  if (!quantityBadResult.conforms && quantityBadResult.paths.some(p => p.includes('hasRounding'))) {
    ok('QuantityValue unsupported rounding lexical value correctly rejected');
  } else {
    bad(`QuantityValue bad rounding should be rejected; conforms=${quantityBadResult.conforms} paths=${quantityBadResult.paths.join(',')}`);
  }

  const moneyMissingCurrency = structuredDataGraph('MonetaryAmount', {
    hasAmount: ['10.00', 'decimal'],
    hasScale: ['2', 'integer'],
  });
  const moneyMissingResult = await validate(moneyMissingCurrency, 'money-missing-currency');
  if (!moneyMissingResult.conforms && moneyMissingResult.paths.some(p => p.includes('hasCurrency'))) {
    ok('MonetaryAmount missing hasCurrency correctly rejected');
  } else {
    bad(`MonetaryAmount missing currency should be rejected; conforms=${moneyMissingResult.conforms} paths=${moneyMissingResult.paths.join(',')}`);
  }

  // ---- Constraint coverage: every source constraint must have a SHACL projection ----
  console.log('\n=== Constraint coverage (source -> SHACL product) ===');
  const fs2 = require('fs');
  const patterns = yaml.load(fs2.readFileSync(path.join(META, 'cross-domain-patterns.yaml'), 'utf8'));
  const sourceConstraints = Object.keys(patterns.CrossDomainPatterns.constraints || {});
  // Collect all string literals from both SHACL files (messages carry constraint identity)
  const shaclText = fs2.readFileSync(path.join(PROJECTION, 'axiolune-meta.shacl.ttl'), 'utf8');
  const sparqlText = fs2.readFileSync(path.join(PROJECTION, 'axiolune-meta.shacl-sparql.ttl'), 'utf8');
  let covered = 0;
  for (const name of sourceConstraints) {
    const c = patterns.CrossDomainPatterns.constraints[name];
    // Each constraint's message should appear in one of the SHACL files
    const msg = c.message || '';
    const found = shaclText.includes(msg) || sparqlText.includes(msg) ||
                  sparqlText.includes(name + 'Component'); // ConstraintComponent naming
    if (found) { ok(`constraint ${name} has SHACL projection`); covered++; }
    else bad(`constraint ${name} has NO SHACL projection (message not found in any .ttl)`);
  }
  if (covered === sourceConstraints.length) ok(`All ${covered} source constraints have SHACL projections`);
  else bad(`Only ${covered}/${sourceConstraints.length} constraints have SHACL projections`);

  console.log('\n' + '='.repeat(60));
  if (fail === 0) { console.log(`✅ PROJECTION VERIFIED (${pass} assertions)`); process.exit(0); }
  else { console.log(`❌ PROJECTION VERIFICATION FAILED (${fail} failures)`); process.exit(1); }
})();
