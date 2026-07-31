#!/usr/bin/env node
/**
 * Normalize E5/E6 alternate authoring dialect → ADR-013 canonical dialect.
 *
 * participants  → participantRoles (roleName from roleIri localName)
 * attributes    → attributeUses   (attribute from attributeIri)
 * patternIri    → pattern         (and fix foundation/patterns → meta/patterns)
 *
 * Usage: node scripts/domain/normalize-authoring-dialect.cjs [--write]
 * Default: dry-run report. --write rewrites module YAML in place.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const PATTERN_BAD = 'https://axiolune.ai/ontology/foundation/patterns/';
const PATTERN_GOOD = 'https://axiolune.ai/ontology/meta/patterns/';

const write = process.argv.includes('--write');
let changedFiles = 0;

function localNameFromIri(iri) {
  if (!iri || typeof iri !== 'string') return null;
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  const i = Math.max(hash, slash);
  return i >= 0 ? iri.slice(i + 1) : iri;
}

function normalizeElement(el) {
  let changed = false;
  if (!el || typeof el !== 'object') return changed;

  if (Array.isArray(el.participants) && !el.participantRoles) {
    el.participantRoles = el.participants.map((p) => {
      const roleName = p.roleName || localNameFromIri(p.roleIri);
      const out = {
        roleName,
        range: p.range || p.targetTypeIri,
        minCount: p.minCount,
        maxCount: p.maxCount,
      };
      if (p.label) out.label = p.label;
      if (p.definition) out.definition = p.definition;
      if (p.roleIri) out.roleIri = p.roleIri;
      return out;
    });
    delete el.participants;
    changed = true;
  }

  if (Array.isArray(el.attributes) && !el.attributeUses) {
    const looksLikeUses = el.attributes.every(
      (a) => a && (a.attributeIri || a.attribute)
    );
    if (looksLikeUses) {
      el.attributeUses = el.attributes.map((a) => ({
        attribute: a.attribute || a.attributeIri,
        minCount: a.minCount,
        maxCount: a.maxCount,
      }));
      delete el.attributes;
      changed = true;
    }
  }

  if (Array.isArray(el.patternBindings)) {
    for (const b of el.patternBindings) {
      if (b.patternIri && !b.pattern) {
        b.pattern = b.patternIri.startsWith(PATTERN_BAD)
          ? PATTERN_GOOD + b.patternIri.slice(PATTERN_BAD.length)
          : b.patternIri;
        delete b.patternIri;
        changed = true;
      } else if (typeof b.pattern === 'string' && b.pattern.startsWith(PATTERN_BAD)) {
        b.pattern = PATTERN_GOOD + b.pattern.slice(PATTERN_BAD.length);
        changed = true;
      }
    }
  }

  return changed;
}

function walkModules() {
  for (const name of fs.readdirSync(FINANCE)) {
    const modPath = path.join(FINANCE, name, 'module.yaml');
    if (!fs.existsSync(modPath)) continue;
    const raw = fs.readFileSync(modPath, 'utf8');
    const doc = yaml.load(raw);
    if (!doc || !doc.domain) continue;

    let fileChanged = false;
    for (const el of Object.values(doc.domain)) {
      if (normalizeElement(el)) fileChanged = true;
    }

    if (!fileChanged) {
      console.log(`  = ${name}`);
      continue;
    }
    changedFiles++;
    console.log(`  * ${name}${write ? ' (written)' : ' (would write)'}`);
    if (write) {
      const out = yaml.dump(doc, {
        lineWidth: 120,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false,
      });
      const header = raw.match(/^([\s\S]*?\n)(?=module:)/);
      const prefix = header ? header[1] : '';
      fs.writeFileSync(modPath, prefix + out);
    }
  }
}

console.log(`=== normalize-authoring-dialect (${write ? 'WRITE' : 'dry-run'}) ===`);
walkModules();
console.log(`\nChanged: ${changedFiles}`);
if (!write && changedFiles > 0) {
  console.log('Re-run with --write to apply.');
  process.exit(2);
}
process.exit(0);
