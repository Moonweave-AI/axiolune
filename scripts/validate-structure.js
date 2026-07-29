#!/usr/bin/env node
/**
 * Deep structural validator for the Axiolune meta-model (canonical).
 *
 * The meta-model is a heterogeneous DSL: a single top-level section mixes
 * meta-type classifiers (ObjectTypeDefinition, ...) with inline attribute
 * instances (validFrom, ...). A blanket additionalProperties:false is therefore
 * impossible by design (requiredFields/optionalFields are intentionally open maps).
 * This validator enforces the structural invariants that matter for production:
 *   - root shape (module + exactly one layer section, no unknown top-level keys)
 *   - module metadata (required fields, IRI/semver formats, import lock shape)
 *   - layer-section metadata (semver, layer range, changes)
 *   - IRI well-formedness on every `iri:` field (type defs, attributes, constraints, patterns)
 *   - required fields per kind: attribute instances, constraint definitions, pattern definitions
 *   - enum correctness on key fields
 *
 * Usage: node scripts/validate-structure.js [--strict]
 *   --strict also flags unknown fields on type-classifiers (typo detection).
 * Exit 0 if valid, 1 otherwise.
 */
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const META_DIR = process.env.META_DIR ? path.resolve(process.env.META_DIR) : path.join(__dirname, '..', 'ontology', 'meta');
const STRICT = process.argv.includes('--strict');

const IRI_RE = /^https?:\/\/[^\s]+$/;
const CURIE_RE = /^[a-zA-Z][a-zA-Z0-9._-]*:[^\s]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const LAYER_SECTIONS = {
  MetaModel: { file: 'core-meta-model.yaml', layer: 1 },
  CrossDomainPatterns: { file: 'cross-domain-patterns.yaml', layer: 2 },
  PlatformBehavior: { file: 'behavior-meta-model.yaml', layer: 3 },
  DataBinding: { file: 'data-binding-meta-model.yaml', layer: 4 },
};

let errors = [];
const err = (loc, msg) => errors.push(`${loc}: ${msg}`);

// Accepts absolute IRIs (https://...) and CURIEs (prefix:localName), per the
// meta-model's compact-IRI convention used in examples and cross-refs.
function isIri(v) { return typeof v === 'string' && v.length > 0 && (IRI_RE.test(v) || CURIE_RE.test(v)); }

function validateModule(doc, file) {
  const m = doc.module;
  if (!m) return err(file, 'missing top-level `module`');
  for (const f of ['moduleIri', 'baseIri', 'preferredPrefix', 'version']) {
    if (!m[f]) err(`${file}.module`, `missing required field \`${f}\``);
  }
  if (m.moduleIri && !isIri(m.moduleIri)) err(`${file}.module.moduleIri`, 'not a valid IRI');
  if (m.baseIri && !/^https?:\/\/[^\s]+[/#]$/.test(m.baseIri)) err(`${file}.module.baseIri`, 'must end with / or #');
  if (m.preferredPrefix && !/^[a-z][a-z0-9-]*$/.test(m.preferredPrefix)) err(`${file}.module.preferredPrefix`, 'invalid prefix');
  if (m.version && !SEMVER_RE.test(m.version)) err(`${file}.module.version`, 'not semver');
  if (Array.isArray(m.imports)) {
    m.imports.forEach((imp, i) => {
      for (const f of ['moduleIri', 'version', 'artifactDigest', 'importMode']) {
        if (!imp[f]) err(`${file}.module.imports[${i}]`, `missing \`${f}\``);
      }
      if (imp.moduleIri && !isIri(imp.moduleIri)) err(`${file}.module.imports[${i}].moduleIri`, 'not a valid IRI');
      if (imp.version && !SEMVER_RE.test(imp.version)) err(`${file}.module.imports[${i}].version`, 'not semver');
      if (imp.artifactDigest && !SHA_RE.test(imp.artifactDigest)) err(`${file}.module.imports[${i}].artifactDigest`, 'not sha256:...');
      if (imp.importMode && !['All', 'Selective'].includes(imp.importMode)) err(`${file}.module.imports[${i}].importMode`, 'bad enum');
    });
  }
}

function validateLayerMeta(doc, file, expectedLayer) {
  const sectionKey = Object.keys(LAYER_SECTIONS).find(k => doc[k]);
  if (!sectionKey) return err(file, 'missing layer section');
  const s = doc[sectionKey];
  if (typeof s.version === 'string' && !SEMVER_RE.test(s.version)) err(`${file}.${sectionKey}.version`, 'not semver');
  if (s.layer !== undefined && (typeof s.layer !== 'number' || s.layer < 1 || s.layer > 4)) err(`${file}.${sectionKey}.layer`, 'must be 1-4');
  if (expectedLayer && s.layer !== expectedLayer) err(`${file}.${sectionKey}.layer`, `expected ${expectedLayer}, got ${s.layer}`);
  if (s.description !== undefined && typeof s.description !== 'string') err(`${file}.${sectionKey}.description`, 'must be string');
  if (s.changes !== undefined && !Array.isArray(s.changes)) err(`${file}.${sectionKey}.changes`, 'must be array');
}

// Recursively find every `iri:` string value and check format.
function scanIris(obj, loc) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === 'iri' && typeof v === 'string' && !isIri(v)) err(`${loc}.iri`, `invalid IRI: ${v}`);
    if (k === 'iri' && v === undefined) err(`${loc}.iri`, 'empty IRI');
    if (v && typeof v === 'object') scanIris(v, `${loc}.${k}`);
  }
}

const OWL_OVERRIDE = ['datatypeProperty', 'objectProperty', 'annotationProperty'];
const CONSTRAINT_TYPES = ['Cardinality', 'ValueRange', 'Pattern', 'Custom', 'Logical', 'Uniqueness', 'Dependency', 'validation'];
const SEVERITIES = ['Error', 'Warning', 'Info', 'error', 'warning', 'info'];

function validateAttributeInstance(name, v, loc) {
  for (const f of ['iri', 'namespace', 'localName', 'label', 'definition', 'valueType']) {
    if (v[f] === undefined || v[f] === null || v[f] === '') err(`${loc}`, `attribute instance missing \`${f}\``);
  }
  if (v.owlProjectionOverride && !OWL_OVERRIDE.includes(v.owlProjectionOverride)) err(`${loc}.owlProjectionOverride`, 'bad enum');
}

function validateConstraintDef(name, v, loc) {
  for (const f of ['iri', 'namespace', 'localName', 'label', 'definition', 'constraintType', 'formalExpression', 'targetElement', 'severity', 'message']) {
    if (v[f] === undefined || v[f] === null || v[f] === '') err(`${loc}`, `constraint missing \`${f}\``);
  }
  if (v.constraintType && !CONSTRAINT_TYPES.includes(v.constraintType)) err(`${loc}.constraintType`, `bad enum: ${v.constraintType}`);
  if (v.severity && !SEVERITIES.includes(v.severity)) err(`${loc}.severity`, `bad enum: ${v.severity}`);
}

function validatePattern(p, i, loc) {
  const base = `${loc}[${i}]`;
  for (const f of ['pattern', 'iri', 'namespace', 'localName', 'label', 'definition', 'version']) {
    if (p[f] === undefined || p[f] === null || p[f] === '') err(base, `pattern missing \`${f}\``);
  }
  if (p.version && !SEMVER_RE.test(p.version)) err(`${base}.version`, 'not semver');
  if (p.appliesTo !== undefined && !Array.isArray(p.appliesTo)) err(`${base}.appliesTo`, 'must be array');
  if (Array.isArray(p.injectedAttributes)) {
    p.injectedAttributes.forEach((a, j) => {
      if (!a.attribute) err(`${base}.injectedAttributes[${j}]`, 'missing `attribute`');
      if (a.minCount !== undefined && typeof a.minCount !== 'number') err(`${base}.injectedAttributes[${j}].minCount`, 'must be number');
    });
  }
  if (Array.isArray(p.constraintsAdded)) {
    p.constraintsAdded.forEach((c, j) => {
      if (!c.constraintRef) err(`${base}.constraintsAdded[${j}]`, 'missing `constraintRef`');
      if (!c.targetElement) err(`${base}.constraintsAdded[${j}]`, 'missing `targetElement`');
    });
  }
}

function validateCore(doc) {
  const mm = doc.MetaModel;
  if (!mm) return;
  const knownClassifiers = new Set([
    'OntologyModuleDefinition','ModuleImportDefinition','SymbolImportSpec','LocalizedTextDefinition',
    'ValueType','IdentifierTypeDefinition','MoneyTypeDefinition','QuantityTypeDefinition',
    'CodeListTypeDefinition','ObjectTypeDefinition','AttributeTypeDefinition','AttributeUse',
    'RelationTypeDefinition','RelationUse','AssociationTypeDefinition','ParticipantRole',
    'PatternBinding','Alignment','ConstraintDefinition','ConstraintExpression','ConstraintParameter',
    'ConstraintBinding','ChangeRecord','GovernanceMetadata',
  ]);
  const metaStructural = new Set(['version','description','layer','changes','note',
    'ValidationRules','Notes','Examples','ImplementationNotes','constraints','patterns']);
  for (const key of Object.keys(mm)) {
    const v = mm[key];
    if (!v || typeof v !== 'object') continue;
    // attribute instances carry namespace: "pattern"; type-classifiers do not
    if (v.namespace === 'pattern') {
      validateAttributeInstance(key, v, `MetaModel.${key}`);
    } else if (STRICT && !knownClassifiers.has(key) && !metaStructural.has(key)) {
      err(`MetaModel.${key}`, `unknown key (not a known type-classifier nor a pattern attribute) — possible typo`);
    }
  }
}

function validatePatterns(doc) {
  const cdp = doc.CrossDomainPatterns;
  if (!cdp) return;
  const c = cdp.constraints;
  if (c && typeof c === 'object') {
    for (const name of Object.keys(c)) validateConstraintDef(name, c[name], `CrossDomainPatterns.constraints.${name}`);
  }
  if (Array.isArray(cdp.patterns)) cdp.patterns.forEach((p, i) => validatePattern(p, i, 'CrossDomainPatterns.patterns'));
}

function validateFile(name, expectedLayer) {
  const file = LAYER_SECTIONS[name].file;
  const p = path.join(META_DIR, file);
  let doc;
  try { doc = yaml.load(fs.readFileSync(p, 'utf8')); }
  catch (e) { err(file, `YAML parse error: ${e.message}`); return; }
  // root: module + exactly one layer section, no unknown top-level keys
  const knownTop = new Set(['module', ...Object.keys(LAYER_SECTIONS)]);
  for (const k of Object.keys(doc)) {
    if (!knownTop.has(k)) err(file, `unknown top-level key \`${k}\``);
  }
  const present = Object.keys(LAYER_SECTIONS).filter(k => doc[k]);
  if (present.length !== 1) err(file, `expected exactly one layer section, found ${present.length}: ${present.join(', ')}`);
  if (present[0] !== name) err(file, `expected layer section ${name}, found ${present[0]}`);
  validateModule(doc, file);
  validateLayerMeta(doc, file, expectedLayer);
  scanIris(doc, file);
  if (name === 'MetaModel') validateCore(doc);
  if (name === 'CrossDomainPatterns') validatePatterns(doc);
}

console.log('=== Deep Structural Validation ===\n');
validateFile('MetaModel', 1);
validateFile('CrossDomainPatterns', 2);
validateFile('PlatformBehavior', 3);
validateFile('DataBinding', 4);

if (errors.length === 0) {
  console.log('✅ STRUCTURE VALID (0 errors)');
  process.exit(0);
} else {
  console.log(`❌ STRUCTURE INVALID (${errors.length} errors)\n`);
  errors.forEach(e => console.log('  - ' + e));
  process.exit(1);
}
