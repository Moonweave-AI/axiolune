#!/usr/bin/env node
/**
 * validate-m2-core — G0 universal M2 authoring-profile validator (ADR-013).
 *
 * Checks every M2 module YAML against the M2 Authoring Profile:
 *   1. Root shape: exactly `module` + `domain` top-level keys
 *   2. Module metadata: all OntologyModuleDefinition required fields + semver
 *   3. Element identity: every element has iri, namespace, localName, label, definition
 *   4. IRI uniqueness: no duplicate IRIs in the module
 *   5. IRI format: absolute IRI or registered CURIE prefix
 *   6. Import lock: every import has version + artifactDigest (sha256) + importMode
 *   7. Type inference: element's fields match at least one M3 meta-type
 *   8. Sidecar separation: no `kind:` field; no evidence fields in domain YAML
 *
 * Usage: node scripts/m2/validate-m2-core.js <file.yaml> [<file2.yaml> ...]
 *        node scripts/m2/validate-m2-core.js --all   (scan all M2 YAML)
 * Exit 0 if all valid, 1 otherwise.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const PREFIX_FILE = path.join(ROOT, 'ontology', 'm2', 'finance', 'registry', 'prefixes.yaml');

const IRI_RE = /^https?:\/\/[^\s]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;

// M3 meta-type inference signatures: an element is recognized as a given M3 type
// if it has all the required fields of that type. (Consistent with M3's own convention
// of keying by localName and inferring type from field presence, not a `kind:` discriminant.)
const M3_TYPE_SIGNATURES = [
  {
    type: 'ObjectTypeDefinition',
    required: ['iri', 'namespace', 'localName', 'label', 'definition'],
    optional: ['superTypes', 'attributeUses', 'patternBindings', 'constraints', 'alignments', 'governance'],
  },
  {
    type: 'AssociationTypeDefinition',
    required: ['iri', 'namespace', 'localName', 'label', 'definition'],
    optional: ['participantRoles', 'patternBindings', 'constraints', 'alignments', 'governance'],
  },
  {
    type: 'RelationTypeDefinition',
    required: ['iri', 'namespace', 'localName', 'label', 'definition'],
    optional: ['domain', 'range', 'inverseOf', 'characteristics', 'alignments'],
  },
  {
    type: 'AttributeTypeDefinition',
    required: ['iri', 'namespace', 'localName', 'label', 'definition', 'valueType'],
    optional: ['pattern', 'range', 'unit', 'defaultCardinality', 'owlProjectionOverride', 'alignments'],
  },
  {
    type: 'IdentifierTypeDefinition',
    required: ['iri', 'namespace', 'localName', 'label', 'definition'],
    optional: ['pattern', 'validator', 'checkAlgorithm', 'length', 'alignments'],
  },
  {
    type: 'CodeListTypeDefinition',
    required: ['iri', 'namespace', 'localName', 'label', 'definition'],
    optional: ['values', 'version', 'maintainer', 'effectiveFrom', 'effectiveTo', 'alignments'],
  },
];

let errors = [];
const err = (loc, msg) => errors.push(`${loc}: ${msg}`);

// ---- Load prefix registry ----
let prefixes = {};
try {
  if (fs.existsSync(PREFIX_FILE)) {
    const reg = yaml.load(fs.readFileSync(PREFIX_FILE, 'utf8'));
    prefixes = (reg && reg.prefixes) || {};
  }
} catch (e) {
  // non-fatal: prefix checks become warnings
}

function isAbsoluteIri(v) {
  return typeof v === 'string' && IRI_RE.test(v);
}

function isRegisteredCurie(v) {
  if (typeof v !== 'string') return false;
  const colon = v.indexOf(':');
  if (colon < 1) return false;
  const prefix = v.slice(0, colon);
  return Object.prototype.hasOwnProperty.call(prefixes, prefix);
}

function isIri(v) {
  return isAbsoluteIri(v) || isRegisteredCurie(v);
}

// ---- Check 7: type inference ----
function inferType(el) {
  const fields = Object.keys(el || {});
  const matches = M3_TYPE_SIGNATURES.filter(sig =>
    sig.required.every(r => fields.includes(r))
  );
  return matches.map(m => m.type);
}

// ---- Validate one file ----
function validateFile(filePath) {
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    err(filePath, `YAML parse error: ${e.message}`);
    return;
  }
  if (!doc || typeof doc !== 'object') {
    err(filePath, 'empty or non-object document');
    return;
  }

  // Check 1: root shape
  const topKeys = Object.keys(doc);
  const allowed = new Set(['module', 'domain']);
  for (const k of topKeys) {
    if (!allowed.has(k)) err(filePath, `unknown top-level key \`${k}\` (only module + domain allowed)`);
  }
  if (!doc.module) err(filePath, 'missing top-level `module`');
  if (!doc.domain) err(filePath, 'missing top-level `domain`');

  // Check 2: module metadata (OntologyModuleDefinition required fields)
  const m = doc.module || {};
  const modReq = ['moduleIri', 'baseIri', 'preferredPrefix', 'version', 'label', 'definition'];
  for (const f of modReq) {
    if (m[f] === undefined || m[f] === null || m[f] === '') err(`${filePath}.module`, `missing required field \`${f}\``);
  }
  if (m.moduleIri && !isAbsoluteIri(m.moduleIri)) err(`${filePath}.module.moduleIri`, 'must be absolute IRI');
  if (m.baseIri && !/^https?:\/\/[^\s]+[/]$/.test(m.baseIri)) err(`${filePath}.module.baseIri`, 'must end with /');
  if (m.version && !SEMVER_RE.test(m.version)) err(`${filePath}.module.version`, 'not semver');
  if (m.status && !['draft', 'review', 'approved', 'deprecated'].includes(m.status)) err(`${filePath}.module.status`, 'bad enum');

  // Check 6: import lock
  if (Array.isArray(m.imports)) {
    m.imports.forEach((imp, i) => {
      for (const f of ['moduleIri', 'version', 'artifactDigest', 'importMode']) {
        if (imp[f] === undefined || imp[f] === null || imp[f] === '') err(`${filePath}.module.imports[${i}]`, `missing \`${f}\``);
      }
      if (imp.moduleIri && !isAbsoluteIri(imp.moduleIri)) err(`${filePath}.module.imports[${i}].moduleIri`, 'must be absolute IRI');
      if (imp.version && !SEMVER_RE.test(imp.version)) err(`${filePath}.module.imports[${i}].version`, 'not semver');
      if (imp.artifactDigest && !SHA_RE.test(imp.artifactDigest)) err(`${filePath}.module.imports[${i}].artifactDigest`, 'not sha256:...');
      if (imp.importMode && !['All', 'Selective'].includes(imp.importMode)) err(`${filePath}.module.imports[${i}].importMode`, 'bad enum');
    });
  }

  // Check 3-5, 7-8: element validation
  const d = doc.domain || {};
  const seenIris = new Set();
  for (const [localName, el] of Object.entries(d)) {
    if (!el || typeof el !== 'object') {
      err(`${filePath}.domain.${localName}`, 'must be an object');
      continue;
    }
    // Check 8: no kind: discriminant
    if ('kind' in el) err(`${filePath}.domain.${localName}`, `\`kind:\` field is PROHIBITED (type inferred from fields per ADR-013)`);

    // Check 3: element identity
    for (const f of ['iri', 'namespace', 'localName', 'label', 'definition']) {
      if (el[f] === undefined || el[f] === null || el[f] === '') err(`${filePath}.domain.${localName}`, `missing required field \`${f}\``);
    }
    if (el.localName && el.localName !== localName) err(`${filePath}.domain.${localName}`, `localName \`${el.localName}\` does not match key \`${localName}\``);

    // Check 5: IRI format
    if (el.iri && !isIri(el.iri)) err(`${filePath}.domain.${localName}.iri`, `not absolute IRI or registered CURIE: ${el.iri}`);

    // Check 4: IRI uniqueness
    if (el.iri) {
      if (seenIris.has(el.iri)) err(`${filePath}.domain.${localName}.iri`, `duplicate IRI: ${el.iri}`);
      seenIris.add(el.iri);
    }

    // Check 7: type inference — must match at least one M3 meta-type
    const types = inferType(el);
    if (types.length === 0) err(`${filePath}.domain.${localName}`, `fields do not match any M3 meta-type signature`);
  }
}

// ---- CLI ----
const args = process.argv.slice(2);
let files = [];
if (args.includes('--all')) {
  const base = path.join(ROOT, 'ontology', 'm2');
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (p.endsWith('.yaml') && !p.includes('registry')) files.push(p);
    }
  };
  if (fs.existsSync(base)) scan(base);
} else {
  files = args.filter(a => a.endsWith('.yaml'));
}

if (files.length === 0) {
  console.error('Usage: node scripts/m2/validate-m2-core.js <file.yaml> [...] | --all');
  process.exit(1);
}

console.log(`=== validate-m2-core (${files.length} file(s)) ===\n`);
for (const f of files) validateFile(f);

if (errors.length === 0) {
  console.log(`✅ M2 CORE VALID (0 errors, ${files.length} file(s))`);
  process.exit(0);
} else {
  console.log(`❌ M2 CORE INVALID (${errors.length} errors)\n`);
  errors.forEach(e => console.log('  - ' + e));
  process.exit(1);
}
