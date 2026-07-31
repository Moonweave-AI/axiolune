#!/usr/bin/env node
/**
 * validate-m2-core — G0+ M2 authoring-profile validator (ADR-013).
 *
 * Strengthened vs original G0 shallow gate:
 *   - Rejects alternate dialect keys (participants/attributes/patternIri)
 *   - Pattern IRI must use meta/patterns
 *   - Import digests must not be all-zero placeholders when --strict
 *   - Association must have participantRoles; ObjectType attributeUses use `attribute`
 *   - Detects bare decimal money/quantity smell when --strict
 *
 * Usage: node scripts/domain/validate-m2-core.js <file.yaml> [...] | --all [--strict]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const DOMAIN_ROOT = path.join(ROOT, 'ontology', 'domain');
const PREFIX_FILE = path.join(DOMAIN_ROOT, 'finance', 'registry', 'prefixes.yaml');
const REGISTRY_FILE = path.join(DOMAIN_ROOT, 'finance', 'registry', 'module-registry.yaml');

const IRI_RE = /^https?:\/\/[^\s]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const ZERO_DIGEST = 'sha256:' + '0'.repeat(64);
const META_PATTERN = 'https://axiolune.ai/ontology/meta/patterns/';
const BAD_PATTERN = 'https://axiolune.ai/ontology/foundation/patterns/';

const STRICT = process.argv.includes('--strict');

const M3_TYPE_SIGNATURES = [
  { type: 'ObjectTypeDefinition', required: ['iri', 'namespace', 'localName', 'label', 'definition'], optional: ['superTypes', 'attributeUses', 'patternBindings', 'constraints', 'alignments', 'governance', 'note'] },
  { type: 'AssociationTypeDefinition', required: ['iri', 'namespace', 'localName', 'label', 'definition'], optional: ['participantRoles', 'attributeUses', 'patternBindings', 'constraints', 'alignments', 'governance', 'note'] },
  { type: 'RelationTypeDefinition', required: ['iri', 'namespace', 'localName', 'label', 'definition'], optional: ['domain', 'range', 'inverseOf', 'characteristics', 'alignments', 'note'] },
  { type: 'AttributeTypeDefinition', required: ['iri', 'namespace', 'localName', 'label', 'definition', 'valueType'], optional: ['pattern', 'range', 'unit', 'defaultCardinality', 'owlProjectionOverride', 'alignments', 'codeListReference', 'note'] },
  { type: 'IdentifierTypeDefinition', required: ['iri', 'namespace', 'localName', 'label', 'definition'], optional: ['pattern', 'validator', 'checkAlgorithm', 'length', 'alignments', 'note'] },
  { type: 'CodeListTypeDefinition', required: ['iri', 'namespace', 'localName', 'label', 'definition'], optional: ['values', 'version', 'maintainer', 'effectiveFrom', 'effectiveTo', 'alignments', 'note'] },
];

const FORBIDDEN_DIALECT = ['participants', 'patternIri', 'attributeIri'];
const MONEYISH = /price|value|amount|pnl|commission|cost|marketvalue|tick/i;
const QTYISH = /quantity|size|volume|lot/i;

// Whitelist of valid valueType strings (M2-PLAN §1: only M3-sanctioned dialects)
const VALID_VALUE_TYPES = new Set([
  'string', 'decimal', 'integer', 'boolean', 'date', 'instant', 'duration', 'uri', 'codelist',
]);

let errors = [];
const err = (loc, msg) => errors.push(`${loc}: ${msg}`);

let prefixes = {};
try {
  if (fs.existsSync(PREFIX_FILE)) {
    const reg = yaml.load(fs.readFileSync(PREFIX_FILE, 'utf8'));
    prefixes = (reg && reg.prefixes) || {};
  }
} catch (_) {}

function isAbsoluteIri(v) { return typeof v === 'string' && IRI_RE.test(v); }
function isRegisteredCurie(v) {
  if (typeof v !== 'string') return false;
  const colon = v.indexOf(':');
  if (colon < 1) return false;
  return Object.prototype.hasOwnProperty.call(prefixes, v.slice(0, colon));
}
function isIri(v) { return isAbsoluteIri(v) || isRegisteredCurie(v); }

function inferType(el) {
  const fields = Object.keys(el || {});
  // Prefer more specific signatures
  if (Array.isArray(el.participantRoles)) return ['AssociationTypeDefinition'];
  if (fields.includes('valueType')) return ['AttributeTypeDefinition'];
  if (fields.includes('domain') || fields.includes('range')) {
    if (!fields.includes('superTypes') && !fields.includes('attributeUses')) return ['RelationTypeDefinition'];
  }
  if (fields.includes('values')) return ['CodeListTypeDefinition'];
  if (fields.includes('pattern') && !fields.includes('valueType') && !fields.includes('superTypes')) return ['IdentifierTypeDefinition'];
  return M3_TYPE_SIGNATURES.filter(sig => sig.required.every(r => fields.includes(r))).map(m => m.type);
}

function fileSha256(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return 'sha256:' + h.digest('hex');
}

function validateFile(filePath) {
  let doc;
  try { doc = yaml.load(fs.readFileSync(filePath, 'utf8')); }
  catch (e) { err(filePath, `YAML parse error: ${e.message}`); return; }
  if (!doc || typeof doc !== 'object') { err(filePath, 'empty or non-object document'); return; }

  const topKeys = Object.keys(doc);
  for (const k of topKeys) {
    if (k !== 'module' && k !== 'domain') err(filePath, `unknown top-level key \`${k}\``);
  }
  if (!doc.module) err(filePath, 'missing top-level `module`');
  if (!doc.domain) err(filePath, 'missing top-level `domain`');

  const m = doc.module || {};
  for (const f of ['moduleIri', 'baseIri', 'preferredPrefix', 'version', 'label', 'definition']) {
    if (m[f] === undefined || m[f] === null || m[f] === '') err(`${filePath}.module`, `missing required field \`${f}\``);
  }
  if (m.moduleIri && !isAbsoluteIri(m.moduleIri)) err(`${filePath}.module.moduleIri`, 'must be absolute IRI');
  if (m.baseIri && !/^https?:\/\/[^\s]+[/]$/.test(m.baseIri)) err(`${filePath}.module.baseIri`, 'must end with /');
  if (m.version && !SEMVER_RE.test(m.version)) err(`${filePath}.module.version`, 'not semver');
  if (m.status && !['draft', 'review', 'approved', 'deprecated'].includes(m.status)) err(`${filePath}.module.status`, 'bad enum');

  if (Array.isArray(m.imports)) {
    m.imports.forEach((imp, i) => {
      for (const f of ['moduleIri', 'version', 'artifactDigest', 'importMode']) {
        if (imp[f] === undefined || imp[f] === null || imp[f] === '') err(`${filePath}.module.imports[${i}]`, `missing \`${f}\``);
      }
      if (imp.moduleIri && !isAbsoluteIri(imp.moduleIri)) err(`${filePath}.module.imports[${i}].moduleIri`, 'must be absolute IRI');
      if (imp.version && !SEMVER_RE.test(imp.version)) err(`${filePath}.module.imports[${i}].version`, 'not semver');
      if (imp.artifactDigest && !SHA_RE.test(imp.artifactDigest)) err(`${filePath}.module.imports[${i}].artifactDigest`, 'not sha256:...');
      if (STRICT && imp.artifactDigest === ZERO_DIGEST) {
        err(`${filePath}.module.imports[${i}].artifactDigest`, 'placeholder zero digest forbidden under --strict');
      }
      if (imp.importMode && !['All', 'Selective'].includes(imp.importMode)) err(`${filePath}.module.imports[${i}].importMode`, 'bad enum');
    });
  }

  const d = doc.domain || {};
  const seenIris = new Set();
  for (const [localName, el] of Object.entries(d)) {
    if (!el || typeof el !== 'object') { err(`${filePath}.domain.${localName}`, 'must be an object'); continue; }
    if ('kind' in el) err(`${filePath}.domain.${localName}`, '`kind:` field is PROHIBITED');

    for (const bad of FORBIDDEN_DIALECT) {
      if (bad in el) err(`${filePath}.domain.${localName}`, `forbidden dialect key \`${bad}\` (use participantRoles/attributeUses/pattern)`);
    }
    // attributes used as AttributeUse list is forbidden; AttributeTypeDefinition is a different element
    if (Array.isArray(el.attributes)) {
      err(`${filePath}.domain.${localName}`, 'forbidden dialect key `attributes` (use attributeUses with `attribute:`)');
    }

    for (const f of ['iri', 'namespace', 'localName', 'label', 'definition']) {
      if (el[f] === undefined || el[f] === null || el[f] === '') err(`${filePath}.domain.${localName}`, `missing required field \`${f}\``);
    }
    if (el.localName && el.localName !== localName) err(`${filePath}.domain.${localName}`, `localName mismatch`);
    if (el.iri && !isIri(el.iri)) err(`${filePath}.domain.${localName}.iri`, `bad IRI: ${el.iri}`);
    if (el.iri) {
      if (seenIris.has(el.iri)) err(`${filePath}.domain.${localName}.iri`, `duplicate IRI`);
      seenIris.add(el.iri);
    }

    const types = inferType(el);
    if (types.length === 0) err(`${filePath}.domain.${localName}`, 'fields do not match any M3 meta-type signature');

    if (Array.isArray(el.attributeUses)) {
      el.attributeUses.forEach((u, i) => {
        if (!u.attribute) err(`${filePath}.domain.${localName}.attributeUses[${i}]`, 'missing `attribute`');
        if (u.attributeIri) err(`${filePath}.domain.${localName}.attributeUses[${i}]`, 'use `attribute` not `attributeIri`');
      });
    }
    if (Array.isArray(el.participantRoles)) {
      el.participantRoles.forEach((r, i) => {
        if (!r.roleName) err(`${filePath}.domain.${localName}.participantRoles[${i}]`, 'missing `roleName`');
        if (!r.range) err(`${filePath}.domain.${localName}.participantRoles[${i}]`, 'missing `range`');
        // Role range → import closure check (M2-PLAN §5.1: no forward/dangling references)
        if (STRICT && r.range && typeof r.range === 'string' && r.range.startsWith('http')) {
          const rangeBase = r.range.replace(/[^/]+$/, '');
          if (rangeBase !== m.baseIri && !(m.imports || []).some(imp => r.range.startsWith(imp.moduleIri + '/'))) {
            // Check if range is a local element defined in this module
            const localRange = r.range.split('/').pop();
            if (!d[localRange]) {
              err(`${filePath}.domain.${localName}.participantRoles[${i}].range`, `role range ${r.range} not in self or imports (forward/dangling ref)`);
            }
          }
        }
      });
    } else if (types.includes('AssociationTypeDefinition') && (el.patternBindings || el.note)) {
      // Heuristic: if someone intended association without roles
      if (!el.superTypes && !el.valueType && !el.values && !el.domain) {
        // only warn via error if patternBindings present without roles — likely association
        if (Array.isArray(el.patternBindings) && el.patternBindings.length && !Array.isArray(el.attributeUses)) {
          err(`${filePath}.domain.${localName}`, 'association-like element missing participantRoles');
        }
      }
    }

    if (Array.isArray(el.patternBindings)) {
      el.patternBindings.forEach((b, i) => {
        const p = b.pattern || b.patternIri;
        if (!p) err(`${filePath}.domain.${localName}.patternBindings[${i}]`, 'missing pattern');
        if (b.patternIri) err(`${filePath}.domain.${localName}.patternBindings[${i}]`, 'use `pattern` not `patternIri`');
        if (typeof p === 'string' && p.startsWith(BAD_PATTERN)) {
          err(`${filePath}.domain.${localName}.patternBindings[${i}]`, `bad pattern base (use ${META_PATTERN})`);
        }
        if (typeof p === 'string' && p.startsWith('http') && !p.startsWith(META_PATTERN) && p.includes('/patterns/')) {
          err(`${filePath}.domain.${localName}.patternBindings[${i}]`, `pattern must be under ${META_PATTERN}`);
        }
      });
    }

    if (STRICT && el.valueType === 'decimal' && (MONEYISH.test(localName) || QTYISH.test(localName))) {
      // hasNumericAmount / hasScale are internal numeric slots of MonetaryAmount/QuantityValue,
      // not standalone money/quantity values — they are compliant with valueType: decimal.
      const isNumericSlot = localName === 'hasNumericAmount' || localName === 'hasScale';
      if (!isNumericSlot) {
        err(`${filePath}.domain.${localName}`, 'bare decimal for money/quantity; use MonetaryAmount/QuantityValue IRI');
      }
    }

    // valueType whitelist check (M2-PLAN §1: only M3-sanctioned dialects)
    if (STRICT && el.valueType && typeof el.valueType === 'string' && !el.valueType.startsWith('http')) {
      if (!VALID_VALUE_TYPES.has(el.valueType)) {
        err(`${filePath}.domain.${localName}.valueType`, `unrecognized valueType '${el.valueType}' (not in whitelist: ${[...VALID_VALUE_TYPES].join(', ')})`);
      }
    }
  }
}

const args = process.argv.slice(2).filter(a => a !== '--strict');
let files = [];
if (args.includes('--all')) {
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (p.endsWith('.yaml') && !p.includes(`${path.sep}registry${path.sep}`)) files.push(p);
    }
  };
  scan(DOMAIN_ROOT);
} else {
  files = args.filter(a => a.endsWith('.yaml'));
}

if (files.length === 0) {
  console.error('Usage: node scripts/domain/validate-m2-core.js <file.yaml> [...] | --all [--strict]');
  process.exit(1);
}

console.log(`=== validate-m2-core (${files.length} file(s)${STRICT ? ', strict' : ''}) ===\n`);
for (const f of files) validateFile(f);

if (errors.length === 0) {
  console.log(`✅ M2 CORE VALID (0 errors, ${files.length} file(s))`);
  if (STRICT && fs.existsSync(REGISTRY_FILE)) {
    const reg = yaml.load(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    const mods = (reg && reg.modules) || [];
    if (mods.length === 0) {
      console.log('⚠ registry modules: [] (populate after digests; not an error until approved imports required)');
    }
  }
  process.exit(0);
}
console.log(`❌ M2 CORE INVALID (${errors.length} errors)\n`);
errors.forEach(e => console.log('  - ' + e));
process.exit(1);
