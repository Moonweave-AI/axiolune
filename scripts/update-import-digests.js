#!/usr/bin/env node
/**
 * Update import digests in all meta-model YAML files
 */

const fs = require('fs');
const path = require('path');

const DIGESTS_PATH = path.join(__dirname, '../ontology/meta/digests.json');
const META_DIR = path.join(__dirname, '../ontology/meta');

const digests = JSON.parse(fs.readFileSync(DIGESTS_PATH, 'utf8'));

const files = [
  'cross-domain-patterns.yaml',
  'behavior-meta-model.yaml',
  'data-binding-meta-model.yaml'
];

let totalUpdates = 0;

for (const file of files) {
  const filePath = path.join(META_DIR, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let updates = 0;

  // Replace each digest
  for (const [moduleIri, digest] of Object.entries(digests)) {
    const pattern = new RegExp(
      `(moduleIri:\\s*"${moduleIri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\n\\s*version:\\s*"[^"]+?"\\s*\\n\\s*artifactDigest:\\s*)"sha256:[0-9a-f]{64}"`,
      'g'
    );

    const before = content;
    content = content.replace(pattern, `$1"${digest}"`);

    if (content !== before) {
      updates++;
    }
  }

  if (updates > 0) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ ${file}: updated ${updates} digest(s)`);
    totalUpdates += updates;
  } else {
    console.log(`  ${file}: no changes needed`);
  }
}

console.log(`\n✅ Total: ${totalUpdates} digest(s) updated`);
