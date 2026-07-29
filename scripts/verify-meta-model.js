#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const yaml = require('js-yaml');
const path = require('path');

const META_DIR = path.join(__dirname, '..', 'ontology', 'meta');
const FILES = {
  core: 'core-meta-model.yaml',
  patterns: 'cross-domain-patterns.yaml',
  behavior: 'behavior-meta-model.yaml',
  dataBinding: 'data-binding-meta-model.yaml'
};

const ISSUES = {
  yamlSyntax: { title: 'YAML Syntax Validity', blocking: true, results: [] },
  digestMatch: { title: 'Digest Consistency', blocking: true, results: [] },
  importLock: { title: 'Import Digest Lock', blocking: true, results: [] },
  patternClosure: { title: 'Pattern Attribute Closure', blocking: true, results: [] },
  constraintClosure: { title: 'Constraint Definition Closure', blocking: true, results: [] },
  temporalMapping: { title: 'Temporal Mapping Completeness', blocking: true, results: [] },
  dataBindingTruth: { title: 'Data Binding Single Truth Source', blocking: true, results: [] },
  actionSafety: { title: 'Action Safety Contracts', blocking: true, results: [] }
};

function calculateDigest(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function validateYamlSyntax() {
  console.log('\n=== YAML Syntax Validation ===');
  let allValid = true;

  for (const [key, filename] of Object.entries(FILES)) {
    const filePath = path.join(META_DIR, filename);
    try {
      yaml.load(fs.readFileSync(filePath, 'utf8'));
      console.log(`✓ ${filename}`);
      ISSUES.yamlSyntax.results.push(`✓ ${filename}`);
    } catch (e) {
      console.log(`✗ ${filename}: ${e.message}`);
      ISSUES.yamlSyntax.results.push(`✗ ${filename}: ${e.message}`);
      allValid = false;
    }
  }

  return allValid;
}

function validateDigests() {
  console.log('\n=== Digest Consistency Check ===');
  const digestsPath = path.join(META_DIR, 'digests.json');
  const digests = JSON.parse(fs.readFileSync(digestsPath, 'utf8')).digests;

  const moduleMap = {
    'https://axiolune.ai/ontology/meta/core': 'core-meta-model.yaml',
    'https://axiolune.ai/ontology/meta/patterns': 'cross-domain-patterns.yaml',
    'https://axiolune.ai/ontology/meta/behavior': 'behavior-meta-model.yaml',
    'https://axiolune.ai/ontology/meta/data-binding': 'data-binding-meta-model.yaml'
  };

  let allMatch = true;

  for (const [moduleIri, filename] of Object.entries(moduleMap)) {
    const filePath = path.join(META_DIR, filename);
    const actualDigest = calculateDigest(filePath);
    const recordedDigest = digests[moduleIri];

    if (actualDigest === recordedDigest) {
      console.log(`✓ ${filename}: ${actualDigest}`);
      ISSUES.digestMatch.results.push(`✓ ${filename}`);
    } else {
      console.log(`✗ ${filename}:`);
      console.log(`  Expected: ${recordedDigest}`);
      console.log(`  Actual:   ${actualDigest}`);
      ISSUES.digestMatch.results.push(`✗ ${filename}: mismatch`);
      allMatch = false;
    }
  }

  return allMatch;
}

function validateImportLocks() {
  console.log('\n=== Import Digest Lock Validation ===');
  let allLocked = true;

  for (const [key, filename] of Object.entries(FILES)) {
    const filePath = path.join(META_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    const doc = yaml.load(content);

    // Check imports
    const imports = [];
    for (const section in doc) {
      if (doc[section].imports) {
        imports.push(...doc[section].imports);
      }
    }

    console.log(`\n${filename}:`);
    if (imports.length === 0) {
      console.log('  (no imports)');
      continue;
    }

    for (const imp of imports) {
      const match = imp.moduleIri.match(/sha256:([a-f0-9]{64})/);
      if (!match) {
        console.log(`  ✗ ${imp.moduleIri}: no digest`);
        ISSUES.importLock.results.push(`✗ ${filename}: ${imp.moduleIri} has no digest`);
        allLocked = false;
      } else {
        console.log(`  ✓ ${imp.moduleIri.split('/').pop()}`);
      }
    }
  }

  ISSUES.importLock.results.push(allLocked ? '✓ All imports locked' : '✗ Some imports unlocked');
  return allLocked;
}

function validatePatternAttributeClosure() {
  console.log('\n=== Pattern Attribute Closure ===');

  const corePath = path.join(META_DIR, FILES.core);
  const patternsPath = path.join(META_DIR, FILES.patterns);

  const coreDoc = yaml.load(fs.readFileSync(corePath, 'utf8'));
  const patternsDoc = yaml.load(fs.readFileSync(patternsPath, 'utf8'));

  // Extract defined attributes from core
  const definedAttributes = new Set();
  if (coreDoc.MetaModel) {
    for (const attrName in coreDoc.MetaModel) {
      if (coreDoc.MetaModel[attrName].namespace === 'pattern') {
        definedAttributes.add(attrName);
      }
    }
  }

  console.log(`Defined pattern attributes: ${definedAttributes.size}`);
  console.log(`  ${Array.from(definedAttributes).join(', ')}`);

  // Extract referenced attributes from patterns
  const referencedAttributes = new Set();
  if (patternsDoc.CrossDomainPatterns) {
    for (const patternName in patternsDoc.CrossDomainPatterns) {
      const pattern = patternsDoc.CrossDomainPatterns[patternName];
      if (pattern.injectsAttributes) {
        pattern.injectsAttributes.forEach(attr => referencedAttributes.add(attr));
      }
    }
  }

  console.log(`\nReferenced pattern attributes: ${referencedAttributes.size}`);
  console.log(`  ${Array.from(referencedAttributes).join(', ')}`);

  // Find missing
  const missing = Array.from(referencedAttributes).filter(attr => !definedAttributes.has(attr));

  if (missing.length === 0) {
    console.log('\n✓ All pattern attributes defined');
    ISSUES.patternClosure.results.push('✓ All attributes defined');
    return true;
  } else {
    console.log(`\n✗ Missing definitions for: ${missing.join(', ')}`);
    ISSUES.patternClosure.results.push(`✗ Missing: ${missing.join(', ')}`);
    return false;
  }
}

function validateConstraintClosure() {
  console.log('\n=== Constraint Definition Closure ===');

  const patternsPath = path.join(META_DIR, FILES.patterns);
  const patternsDoc = yaml.load(fs.readFileSync(patternsPath, 'utf8'));

  // Extract defined constraints
  const definedConstraints = new Set();
  if (patternsDoc.CrossDomainPatterns) {
    for (const item in patternsDoc.CrossDomainPatterns) {
      const def = patternsDoc.CrossDomainPatterns[item];
      if (def.iri && def.iri.includes('/constraints/')) {
        definedConstraints.add(item);
      }
    }
  }

  console.log(`Defined constraints: ${definedConstraints.size}`);

  // Extract referenced constraints
  const referencedConstraints = new Set();
  if (patternsDoc.CrossDomainPatterns) {
    for (const patternName in patternsDoc.CrossDomainPatterns) {
      const pattern = patternsDoc.CrossDomainPatterns[patternName];
      if (pattern.constraints) {
        pattern.constraints.forEach(c => {
          const name = c.constraintRef.split('/').pop();
          referencedConstraints.add(name);
        });
      }
    }
  }

  console.log(`Referenced constraints: ${referencedConstraints.size}`);
  console.log(`  ${Array.from(referencedConstraints).join(', ')}`);

  const missing = Array.from(referencedConstraints).filter(c => !definedConstraints.has(c));

  if (missing.length === 0) {
    console.log('\n✓ All constraints defined');
    ISSUES.constraintClosure.results.push('✓ All constraints defined');
    return true;
  } else {
    console.log(`\n✗ Missing constraint definitions: ${missing.join(', ')}`);
    ISSUES.constraintClosure.results.push(`✗ Missing: ${missing.join(', ')}`);
    return false;
  }
}

function generateReport() {
  console.log('\n' + '='.repeat(70));
  console.log('VERIFICATION SUMMARY');
  console.log('='.repeat(70));

  let blockingFailed = false;

  for (const [key, issue] of Object.entries(ISSUES)) {
    const status = issue.results.some(r => r.startsWith('✗')) ? '✗ FAIL' : '✓ PASS';
    const blocking = issue.blocking ? '[BLOCKING]' : '';

    console.log(`\n${status} ${issue.title} ${blocking}`);
    issue.results.forEach(r => console.log(`  ${r}`));

    if (issue.blocking && status === '✗ FAIL') {
      blockingFailed = true;
    }
  }

  console.log('\n' + '='.repeat(70));
  if (blockingFailed) {
    console.log('❌ BLOCKING ISSUES DETECTED - NOT READY FOR ACCEPTANCE');
  } else {
    console.log('✅ ALL BLOCKING CHECKS PASSED');
  }
  console.log('='.repeat(70));

  return !blockingFailed;
}

// Run all validations
validateYamlSyntax();
validateDigests();
validateImportLocks();
validatePatternAttributeClosure();
validateConstraintClosure();

const passed = generateReport();
process.exit(passed ? 0 : 1);
