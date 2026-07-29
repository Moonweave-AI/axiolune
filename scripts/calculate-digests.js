#!/usr/bin/env node

/**
 * Calculate SHA-256 digests for meta-model YAML files
 * Used for version-locked imports (ADR-004, ADR-010)
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const FILES = [
  'ontology/meta/core-meta-model.yaml',
  'ontology/meta/cross-domain-patterns.yaml',
  'ontology/meta/behavior-meta-model.yaml',
  'ontology/meta/data-binding-meta-model.yaml'
];

function calculateDigest(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return 'sha256:' + hash.digest('hex');
}

function main() {
  console.log('Calculating SHA-256 digests for meta-model files...\n');

  const digests = {};

  for (const file of FILES) {
    const fullPath = path.resolve(file);
    if (!fs.existsSync(fullPath)) {
      console.error(`❌ File not found: ${file}`);
      process.exit(1);
    }

    const digest = calculateDigest(fullPath);
    const basename = path.basename(file, '.yaml');
    digests[basename] = digest;

    console.log(`✓ ${basename}`);
    console.log(`  ${digest}\n`);
  }

  // Output mapping for reference
  console.log('\nModule IRI → Digest mapping:');
  console.log('─────────────────────────────────────────────────────────');
  console.log('https://axiolune.ai/ontology/meta/core');
  console.log(`  → ${digests['core-meta-model']}`);
  console.log('\nhttps://axiolune.ai/ontology/meta/patterns');
  console.log(`  → ${digests['cross-domain-patterns']}`);
  console.log('\nhttps://axiolune.ai/ontology/meta/behavior');
  console.log(`  → ${digests['behavior-meta-model']}`);
  console.log('\nhttps://axiolune.ai/ontology/meta/data-binding');
  console.log(`  → ${digests['data-binding-meta-model']}`);

  // Write to JSON for programmatic use
  const outputPath = 'ontology/meta/digests.json';
  fs.writeFileSync(outputPath, JSON.stringify({
    generated: new Date().toISOString(),
    digests: {
      'https://axiolune.ai/ontology/meta/core': digests['core-meta-model'],
      'https://axiolune.ai/ontology/meta/patterns': digests['cross-domain-patterns'],
      'https://axiolune.ai/ontology/meta/behavior': digests['behavior-meta-model'],
      'https://axiolune.ai/ontology/meta/data-binding': digests['data-binding-meta-model']
    }
  }, null, 2));

  console.log(`\n✓ Digests written to ${outputPath}`);
}

main();
