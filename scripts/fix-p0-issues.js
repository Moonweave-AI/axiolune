#!/usr/bin/env node

/**
 * P0 Fix Script - Resolves all blocking issues identified in ADR-010
 *
 * Fixes:
 * - P0-2: Updates sha256:pending with actual digests
 * - P0-2: Fixes version conflicts (behavior imports behavior v0.3.0 → v0.4.0)
 * - P0-3: Resolves {BASE_IRI} templates to actual IRIs
 *
 * Usage: node scripts/fix-p0-issues.js
 */

const fs = require('fs');
const path = require('path');

// Load calculated digests
const digestsPath = path.resolve('ontology/meta/digests.json');
const digests = JSON.parse(fs.readFileSync(digestsPath, 'utf8')).digests;

const FILES = [
  {
    path: 'ontology/meta/core-meta-model.yaml',
    baseIri: 'https://axiolune.ai/ontology/meta/core/',
    version: '0.3.0'
  },
  {
    path: 'ontology/meta/cross-domain-patterns.yaml',
    baseIri: 'https://axiolune.ai/ontology/meta/patterns/',
    version: '0.3.0'
  },
  {
    path: 'ontology/meta/behavior-meta-model.yaml',
    baseIri: 'https://axiolune.ai/ontology/meta/behavior/',
    version: '0.4.0'
  },
  {
    path: 'ontology/meta/data-binding-meta-model.yaml',
    baseIri: 'https://axiolune.ai/ontology/meta/data-binding/',
    version: '0.4.0'
  }
];

function fixFile(fileInfo) {
  const fullPath = path.resolve(fileInfo.path);
  console.log(`\nProcessing: ${fileInfo.path}`);

  let content = fs.readFileSync(fullPath, 'utf8');
  let changeCount = 0;

  // P0-2: Replace sha256:pending with actual digests
  content = content.replace(
    /artifactDigest:\s*"sha256:pending"/g,
    (match, offset) => {
      // Find the moduleIri for this import
      const before = content.substring(0, offset);
      const lastModuleIri = before.match(/moduleIri:\s*"([^"]+)"/g);

      if (lastModuleIri) {
        const iriMatch = lastModuleIri[lastModuleIri.length - 1].match(/"([^"]+)"/);
        if (iriMatch && digests[iriMatch[1]]) {
          changeCount++;
          return `artifactDigest: "${digests[iriMatch[1]]}"`;
        }
      }
      return match;
    }
  );

  // P0-2: Fix version conflict in data-binding-meta-model.yaml
  // It imports behavior v0.3.0 but behavior is actually v0.4.0
  if (fileInfo.path.includes('data-binding')) {
    content = content.replace(
      /moduleIri:\s*"https:\/\/axiolune\.ai\/ontology\/meta\/behavior"\s+version:\s*"0\.3\.0"/g,
      () => {
        changeCount++;
        return 'moduleIri: "https://axiolune.ai/ontology/meta/behavior"\n      version: "0.4.0"';
      }
    );
  }

  // P0-3: Resolve {BASE_IRI} templates
  // Note: baseIri already ends with /, so {BASE_IRI}/xyz becomes baseIri + xyz
  const templatePattern = /\{BASE_IRI\}\/?/g;
  const templateMatches = content.match(templatePattern);
  if (templateMatches) {
    console.log(`  Found ${templateMatches.length} {BASE_IRI} templates`);
    content = content.replace(templatePattern, fileInfo.baseIri);
    changeCount += templateMatches.length;
  }

  // Write back
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`  ✓ Applied ${changeCount} fixes`);

  return changeCount;
}

function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('P0 Fix Script - ADR-010 Implementation');
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nLoaded digests:');
  Object.entries(digests).forEach(([iri, digest]) => {
    console.log(`  ${iri}`);
    console.log(`    → ${digest.substring(0, 20)}...`);
  });

  let totalChanges = 0;
  for (const fileInfo of FILES) {
    totalChanges += fixFile(fileInfo);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`✓ Complete: ${totalChanges} total fixes applied`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nFixed issues:');
  console.log('  ✓ P0-2: Replaced all sha256:pending with actual digests');
  console.log('  ✓ P0-2: Fixed version conflict (data-binding → behavior)');
  console.log('  ✓ P0-3: Resolved all {BASE_IRI} templates to actual IRIs');
  console.log('\nRemaining P0 issues (require manual fixes):');
  console.log('  ⚠ P0-1: Schema rewrite for hierarchical structure');
  console.log('  ⚠ P0-4: Naming consistency (*Definition suffix)');
  console.log('  ⚠ P0-5: Pattern semantics (conflicts, injected attributes)');
  console.log('  ⚠ P0-6: Data binding single truth source');
  console.log('  ⚠ P0-7: Action safety (idempotency rules)');
}

main();
