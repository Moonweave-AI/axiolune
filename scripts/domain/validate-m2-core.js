#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const DOMAIN_ROOT = path.join(ROOT, 'ontology', 'domain');
const FINANCE_ROOT = path.join(DOMAIN_ROOT, 'finance');

const IRI_RE = /^https?:\/\/[^\s]+$/;
const BASE_IRI_RE = /^https?:\/\/[^\s]+\/$/;
const META_PATTERN_BASE = 'https://axiolune.ai/ontology/meta/patterns/';
const BAD_PATTERN_BASE = 'https://axiolune.ai/ontology/foundation/patterns/';
const VALID_VALUE_TYPES = new Set([
  'string', 'decimal', 'integer', 'boolean', 'date', 'instant', 'duration', 'uri', 'codelist',
]);

const FORBIDDEN_DIALECT = ['participants', 'patternIri', 'attributeIri', 'datatype', 'codeListIri', 'moneyTypeDefinition'];

let errors = [];

function err(loc, msg) { errors.push(`${loc}: ${msg}`); }

function isAbsoluteIri(s) { return typeof s === 'string' && IRI_RE.test(s); }

function inferType(el) {
  const types = [];
  if (Array.isArray(el.participantRoles) || (el.attributeUses && el.participantRoles)) types.push('AssociationTypeDefinition');
  if (el.valueType !== undefined) types.push('AttributeTypeDefinition');
  if (el.domain !== undefined || el.range !== undefined) types.push('RelationTypeDefinition');
  if (Array.isArray(el.values)) types.push('CodeListTypeDefinition');
  if (el.pattern && el.valueType === undefined && !Array.isArray(el.values) && el.domain === undefined) types.push('IdentifierTypeDefinition');
  if (types.length === 0 && (el.attributeUses || el.superTypes !== undefined || el.patternBindings || !el.valueType)) types.push('ObjectTypeDefinition');
  return types;
}

function validateFile(filePath) {
  let doc;
  try { doc = yaml.load(fs.readFileSync(filePath, 'utf8')); } catch (e) { err(filePath, `YAML parse error: ${e.message}`); return; }
  if (!doc || !doc.module) { err(filePath, 'missing module section'); return; }
  const m = doc.module;
  for (const f of ['moduleIri', 'baseIri', 'preferredPrefix', 'label', 'definition', 'status']) {
    if (m[f] === undefined || m[f] === null || m[f] === '') err(`${filePath}.module`, `missing field \`${f}\``);
  }
  if (m.moduleIri && !isAbsoluteIri(m.moduleIri)) err(`${filePath}.module.moduleIri`, 'must be absolute IRI');
  if (m.baseIri && !BASE_IRI_RE.test(m.baseIri)) err(`${filePath}.module.baseIri`, 'must end with /');
  if (m.status && !['draft', 'review', 'approved', 'deprecated'].includes(m.status)) err(`${filePath}.module.status`, 'bad status');

  if (Array.isArray(m.imports)) {
    m.imports.forEach((imp, i) => {
      if (!imp.moduleIri) err(`${filePath}.module.imports[${i}]`, 'missing moduleIri');
      else if (!isAbsoluteIri(imp.moduleIri)) err(`${filePath}.module.imports[${i}].moduleIri`, 'must be absolute IRI');
    });
  }

  const d = doc.domain || {};
  const seenIris = new Set();
  const moduleBaseIri = m.baseIri || '';
  const importBases = (m.imports || []).map(imp => imp.moduleIri + '/');

  // Collect elements from both flat and nested container structures
  const elements = [];
  for (const [key, val] of Object.entries(d)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val.iri) {
        // Flat structure: key is element name, val is element def
        elements.push([key, val]);
      } else {
        // Nested container: key is container name (objectTypes, attributeTypes, etc.), val has element defs
        for (const [elName, elDef] of Object.entries(val)) {
          if (elDef && typeof elDef === 'object' && !Array.isArray(elDef)) {
            elements.push([elName, elDef]);
          }
        }
      }
    }
  }

  for (const [localName, el] of elements) {
    if (!el || typeof el !== 'object') { err(`${filePath}.domain.${localName}`, 'must be an object'); continue; }
    for (const bad of FORBIDDEN_DIALECT) {
      if (bad in el) err(`${filePath}.domain.${localName}`, `forbidden dialect key \`${bad}\``);
    }
    if (Array.isArray(el.attributes)) err(`${filePath}.domain.${localName}`, 'use attributeUses not attributes');

    for (const f of ['iri', 'namespace', 'localName', 'label', 'definition']) {
      if (el[f] === undefined || el[f] === null || el[f] === '') err(`${filePath}.domain.${localName}`, `missing field \`${f}\``);
    }
    if (el.localName && el.localName !== localName) err(`${filePath}.domain.${localName}`, 'localName mismatch');
    if (el.iri && !IRI_RE.test(el.iri)) err(`${filePath}.domain.${localName}.iri`, `bad IRI: ${el.iri}`);
    if (el.iri) { if (seenIris.has(el.iri)) err(`${filePath}.domain.${localName}.iri`, 'duplicate IRI'); seenIris.add(el.iri); }

    const types = inferType(el);
    if (types.length === 0) err(`${filePath}.domain.${localName}`, 'cannot infer M3 type');

    if (Array.isArray(el.attributeUses)) {
      el.attributeUses.forEach((u, i) => {
        if (!u.attribute) err(`${filePath}.domain.${localName}.attributeUses[${i}]`, 'missing attribute');
      });
    }
    if (Array.isArray(el.participantRoles)) {
      el.participantRoles.forEach((r, i) => {
        const roleName = r.roleName || r.id;
        if (!roleName) err(`${filePath}.domain.${localName}.participantRoles[${i}]`, 'missing roleName or id');
        if (!r.range) err(`${filePath}.domain.${localName}.participantRoles[${i}]`, 'missing range');
        // Check role range resolves to self or imports
        if (r.range && typeof r.range === 'string' && r.range.startsWith('http')) {
          const rangeBase = r.range.replace(/[^/]+$/, '');
          const isLocal = d[r.range.split('/').pop()] !== undefined;
          if (rangeBase !== moduleBaseIri && !importBases.some(b => r.range.startsWith(b)) && !isLocal) {
            err(`${filePath}.domain.${localName}.participantRoles[${i}].range`, `range not in self or imports: ${r.range}`);
          }
        }
      });
    }
    if (Array.isArray(el.patternBindings)) {
      el.patternBindings.forEach((b, i) => {
        const p = b.pattern;
        if (!p) err(`${filePath}.domain.${localName}.patternBindings[${i}]`, 'missing pattern');
        if (typeof p === 'string' && p.startsWith(BAD_PATTERN_BASE)) err(`${filePath}.domain.${localName}.patternBindings[${i}]`, `bad pattern base`);
        if (typeof p === 'string' && p.startsWith('http') && !p.startsWith(META_PATTERN_BASE) && p.includes('/patterns/')) err(`${filePath}.domain.${localName}.patternBindings[${i}]`, `pattern must be under ${META_PATTERN_BASE}`);
      });
    }
    if (el.valueType && typeof el.valueType === 'string' && !el.valueType.startsWith('http') && !VALID_VALUE_TYPES.has(el.valueType)) {
      err(`${filePath}.domain.${localName}.valueType`, `unrecognized valueType '${el.valueType}'`);
    }
  }
}

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const filteredArgs = args.filter(a => a !== '--strict');
let files = [];
if (filteredArgs.includes('--all')) {
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (p.endsWith('.yaml') && !p.includes(`${path.sep}registry${path.sep}`)) files.push(p);
    }
  };
  scan(FINANCE_ROOT);
} else {
  files = filteredArgs.filter(a => a.endsWith('.yaml'));
}

if (files.length === 0) { console.error('Usage: node validate-m2-core.js <file.yaml> [...] | --all [--strict]'); process.exit(1); }

console.log(`=== validate-m2-core (${files.length} file(s)${strict ? ', strict' : ''}) ===`);
for (const f of files) validateFile(f);

if (errors.length === 0) { console.log(`M2 CORE VALID (0 errors, ${files.length} file(s))`); process.exit(0); }
console.log(`M2 CORE INVALID (${errors.length} errors)`);
errors.forEach(e => console.log('  - ' + e));
process.exit(1);
