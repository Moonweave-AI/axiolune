#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const yaml = require('js-yaml');
const path = require('path');

const META_DIR = path.join(__dirname, '..', 'ontology', 'meta');
const DIGESTS_FILE = path.join(META_DIR, 'digests.json');

const FILES = [
  { key: 'core', file: 'core-meta-model.yaml', iri: 'https://axiolune.ai/ontology/meta/core' },
  { key: 'patterns', file: 'cross-domain-patterns.yaml', iri: 'https://axiolune.ai/ontology/meta/patterns' },
  { key: 'behavior', file: 'behavior-meta-model.yaml', iri: 'https://axiolune.ai/ontology/meta/behavior' },
  { key: 'dataBinding', file: 'data-binding-meta-model.yaml', iri: 'https://axiolune.ai/ontology/meta/data-binding' }
];

function calculateDigest(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function updateImportsInFile(filePath, newDigests) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // Pattern: moduleIri with digest
  const pattern = /(moduleIri:\s*"https:\/\/axiolune\.ai\/ontology\/meta\/(core|patterns|behavior|data-binding))(?:#sha256:[a-f0-9]{64})?(")/g;

  content = content.replace(pattern, (match, prefix, module, suffix) => {
    const moduleKey = module === 'data-binding' ? 'dataBinding' : module;
    const moduleInfo = FILES.find(f => f.key === moduleKey);
    if (moduleInfo && newDigests[moduleInfo.iri]) {
      modified = true;
      return `${prefix}#${newDigests[moduleInfo.iri]}${suffix}`;
    }
    return match;
  });

  // Pattern: artifactDigest
  const digestPattern = /(artifactDigest:\s*")(sha256:[a-f0-9]{64})(")/g;
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Find moduleIri line to determine which digest to use
    if (lines[i].includes('moduleIri:')) {
      const moduleMatch = lines[i].match(/https:\/\/axiolune\.ai\/ontology\/meta\/(core|patterns|behavior|data-binding)/);
      if (moduleMatch) {
        const module = moduleMatch[1];
        const moduleKey = module === 'data-binding' ? 'dataBinding' : module;
        const moduleInfo = FILES.find(f => f.key === moduleKey);

        // Look for artifactDigest in next few lines
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (lines[j].includes('artifactDigest:')) {
            const newDigest = newDigests[moduleInfo.iri];
            if (newDigest) {
              lines[j] = lines[j].replace(digestPattern, `$1${newDigest}$3`);
              modified = true;
            }
            break;
          }
        }
      }
    }
  }

  content = lines.join('\n');

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function convergeDigests(maxIterations = 10) {
  console.log('Starting digest convergence...\n');

  let digests = {};

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(`Iteration ${iteration}:`);

    const oldDigests = { ...digests };
    digests = {};

    // Calculate current digests
    for (const fileInfo of FILES) {
      const filePath = path.join(META_DIR, fileInfo.file);
      digests[fileInfo.iri] = calculateDigest(filePath);
      console.log(`  ${fileInfo.key}: ${digests[fileInfo.iri]}`);
    }

    // Check convergence
    let converged = iteration > 1;
    for (const iri in digests) {
      if (oldDigests[iri] !== digests[iri]) {
        converged = false;
        break;
      }
    }

    if (converged) {
      console.log(`\n✓ Converged after ${iteration} iterations`);
      return digests;
    }

    // Update imports for next iteration
    if (iteration < maxIterations) {
      console.log('  Updating imports...');
      for (const fileInfo of FILES) {
        const filePath = path.join(META_DIR, fileInfo.file);
        updateImportsInFile(filePath, digests);
      }
    }

    console.log('');
  }

  console.log(`✗ Failed to converge after ${maxIterations} iterations`);
  return null;
}

// Run convergence
const finalDigests = convergeDigests();

if (finalDigests) {
  // Write digests.json
  const digestsContent = {
    generated: new Date().toISOString(),
    digests: finalDigests
  };

  fs.writeFileSync(DIGESTS_FILE, JSON.stringify(digestsContent, null, 2) + '\n', 'utf8');
  console.log('\n✓ Updated digests.json');

  // Verify
  console.log('\nFinal verification:');
  for (const fileInfo of FILES) {
    const filePath = path.join(META_DIR, fileInfo.file);
    const actualDigest = calculateDigest(filePath);
    const recordedDigest = finalDigests[fileInfo.iri];

    if (actualDigest === recordedDigest) {
      console.log(`  ✓ ${fileInfo.file}`);
    } else {
      console.log(`  ✗ ${fileInfo.file}: mismatch`);
      console.log(`    Expected: ${recordedDigest}`);
      console.log(`    Actual:   ${actualDigest}`);
    }
  }

  process.exit(0);
} else {
  console.error('\n✗ Digest convergence failed');
  process.exit(1);
}
