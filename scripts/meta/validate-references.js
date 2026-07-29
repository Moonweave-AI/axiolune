#!/usr/bin/env node
/**
 * Reference-integrity validator for the meta-model (replaces vacuous closure checks).
 * Verifies that every IRI referenced by Layer 2 patterns resolves to a defined
 * attribute (Layer 1 core) or a defined constraint (Layer 2 constraints).
 *
 * Usage: node scripts/validate-references.js
 * Exit code: 0 if all references resolve, 1 otherwise.
 */
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const META_DIR = path.join(__dirname, '..', '..', 'ontology', 'meta');
const core = yaml.load(fs.readFileSync(path.join(META_DIR, 'core-meta-model.yaml'), 'utf8'));
const patterns = yaml.load(fs.readFileSync(path.join(META_DIR, 'cross-domain-patterns.yaml'), 'utf8'));

const fail = (msg) => { console.error('  ✗ ' + msg); return false; };

// ---- Collect defined attributes (Layer 1, namespace=pattern) ----
const definedAttrIris = new Set();
let defAttrCount = 0;
if (core.MetaModel) {
  for (const key of Object.keys(core.MetaModel)) {
    const v = core.MetaModel[key];
    if (v && typeof v === 'object' && v.namespace === 'pattern' && v.iri) {
      definedAttrIris.add(v.iri);
      defAttrCount++;
    }
  }
}
console.log(`Defined pattern attributes (Layer 1): ${defAttrCount}`);

// ---- Collect defined constraints (Layer 2) ----
const definedCstrIris = new Set();
let defCstrCount = 0;
const cstrBlock = patterns.CrossDomainPatterns && patterns.CrossDomainPatterns.constraints;
if (cstrBlock && typeof cstrBlock === 'object') {
  for (const key of Object.keys(cstrBlock)) {
    const v = cstrBlock[key];
    if (v && v.iri && typeof v.iri === 'string' && v.iri.includes('/constraints/')) {
      definedCstrIris.add(v.iri);
      defCstrCount++;
    }
  }
}
console.log(`Defined constraints (Layer 2): ${defCstrCount}`);

// ---- Collect referenced attributes & constraints from patterns ----
const refAttr = new Set();
const refCstr = new Set();
const patternList = patterns.CrossDomainPatterns && patterns.CrossDomainPatterns.patterns;
const patCount = Array.isArray(patternList) ? patternList.length : 0;
if (Array.isArray(patternList)) {
  for (const p of patternList) {
    (p.injectedAttributes || []).forEach(a => { if (a && a.attribute) refAttr.add(a.attribute); });
    (p.constraintsAdded || []).forEach(c => {
      if (c.constraintRef) refCstr.add(c.constraintRef);
      if (c.targetElement && c.targetElement.includes('/attributes/')) refAttr.add(c.targetElement);
    });
  }
}
console.log(`Patterns: ${patCount}`);
console.log(`Referenced attribute IRIs: ${refAttr.size}`);
console.log(`Referenced constraint IRIs: ${refCstr.size}`);

// ---- Cross-check ----
let ok = true;
const missingAttr = [...refAttr].filter(iri => !definedAttrIris.has(iri));
const missingCstr = [...refCstr].filter(iri => !definedCstrIris.has(iri));

console.log('\n=== Attribute reference closure ===');
if (missingAttr.length === 0) {
  console.log(`  ✓ All ${refAttr.size} referenced attributes resolve to Layer 1 definitions`);
} else {
  ok = fail(`Missing attribute definitions: ${missingAttr.join(', ')}`);
}

console.log('\n=== Constraint reference closure ===');
if (missingCstr.length === 0) {
  console.log(`  ✓ All ${refCstr.size} referenced constraints resolve to Layer 2 definitions`);
} else {
  ok = fail(`Missing constraint definitions: ${missingCstr.join(', ')}`) && ok;
}

// ---- Constraint targetElement closure ----
console.log('\n=== Constraint targetElement closure ===');
let teOk = true;
const teMissing = [];
if (cstrBlock) {
  for (const key of Object.keys(cstrBlock)) {
    const v = cstrBlock[key];
    if (v && v.targetElement && v.targetElement.includes('/attributes/')) {
      if (!definedAttrIris.has(v.targetElement)) teMissing.push(`${key} -> ${v.targetElement}`);
    }
  }
}
if (teMissing.length === 0) {
  console.log('  ✓ All constraint targetElements resolve to defined attributes');
} else {
  teOk = false;
  teMissing.forEach(m => fail('Unresolved targetElement: ' + m));
}

// ---- Version-label consistency: import.version must equal imported module self-version ----
console.log('\n=== Import version-label consistency ===');
const allFiles = {
  'https://axiolune.ai/ontology/meta/core': ['core-meta-model.yaml', core],
  'https://axiolune.ai/ontology/meta/patterns': ['cross-domain-patterns.yaml', patterns],
};
const behaviorDoc = yaml.load(fs.readFileSync(path.join(META_DIR, 'behavior-meta-model.yaml'), 'utf8'));
const dbDoc = yaml.load(fs.readFileSync(path.join(META_DIR, 'data-binding-meta-model.yaml'), 'utf8'));
allFiles['https://axiolune.ai/ontology/meta/behavior'] = ['behavior-meta-model.yaml', behaviorDoc];
allFiles['https://axiolune.ai/ontology/meta/data-binding'] = ['data-binding-meta-model.yaml', dbDoc];
const selfVersion = {};
for (const [base, [f, d]] of Object.entries(allFiles)) selfVersion[base] = d.module && d.module.version;
let verOk = true;
for (const [base, [f, d]] of Object.entries(allFiles)) {
  for (const imp of (d.module.imports || [])) {
    const impBase = imp.moduleIri.split('#')[0];
    const self = selfVersion[impBase];
    if (self && imp.version !== self) {
      teOk = false; verOk = false;
      fail(`${f} imports ${impBase}@${imp.version} but module self-declares ${self}`);
    }
  }
}
if (verOk) console.log('  ✓ All import version labels match imported module self-declared versions');

console.log('\n' + '='.repeat(60));
if (ok && teOk && verOk) {
  console.log('✅ REFERENCE INTEGRITY PASSED');
  process.exit(0);
} else {
  console.log('❌ REFERENCE INTEGRITY FAILED');
  process.exit(1);
}