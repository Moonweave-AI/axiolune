#!/usr/bin/env node

/**
 * P0-4: Naming Consistency Fix
 *
 * Ensures all meta-types use *Definition suffix per ADR-004
 *
 * Changes:
 * - ValueType → (keep as is, it's a meta-meta-type describing primitives)
 * - IdentifierType → IdentifierTypeDefinition
 * - MoneyType → MoneyTypeDefinition
 * - QuantityType → QuantityTypeDefinition
 * - CodeListType → CodeListTypeDefinition
 * - PolicyType → PolicyTypeDefinition
 * - DataSource → DataSourceDefinition
 * - Field → FieldDefinition
 */

const fs = require('fs');
const path = require('path');

const RENAMES = [
  // Core meta-model renames
  { from: /^  IdentifierType:/gm, to: '  IdentifierTypeDefinition:' },
  { from: /^  MoneyType:/gm, to: '  MoneyTypeDefinition:' },
  { from: /^  QuantityType:/gm, to: '  QuantityTypeDefinition:' },
  { from: /^  CodeListType:/gm, to: '  CodeListTypeDefinition:' },

  // References to these types
  { from: /type:\s*IdentifierType\b/g, to: 'type: IdentifierTypeDefinition' },
  { from: /type:\s*MoneyType\b/g, to: 'type: MoneyTypeDefinition' },
  { from: /type:\s*QuantityType\b/g, to: 'type: QuantityTypeDefinition' },
  { from: /type:\s*CodeListType\b/g, to: 'type: CodeListTypeDefinition' },

  // In notes and comments
  { from: /\bIdentifierType\b(?!Definition)/g, to: 'IdentifierTypeDefinition' },
  { from: /\bMoneyType\b(?!Definition)/g, to: 'MoneyTypeDefinition' },
  { from: /\bQuantityType\b(?!Definition)/g, to: 'QuantityTypeDefinition' },
  { from: /\bCodeListType\b(?!Definition)/g, to: 'CodeListTypeDefinition' },
];

const FILES = [
  'ontology/meta/core-meta-model.yaml',
  'ontology/meta/cross-domain-patterns.yaml',
  'ontology/meta/behavior-meta-model.yaml',
  'ontology/meta/data-binding-meta-model.yaml',
];

function fixFile(filePath) {
  const fullPath = path.resolve(filePath);
  console.log(`\nProcessing: ${filePath}`);

  let content = fs.readFileSync(fullPath, 'utf8');
  let changeCount = 0;

  for (const rename of RENAMES) {
    const matches = content.match(rename.from);
    if (matches) {
      content = content.replace(rename.from, rename.to);
      changeCount += matches.length;
    }
  }

  fs.writeFileSync(fullPath, content, 'utf8');
  console.log(`  ✓ Applied ${changeCount} renames`);

  return changeCount;
}

function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('P0-4: Naming Consistency Fix');
  console.log('═══════════════════════════════════════════════════════');

  let totalChanges = 0;
  for (const file of FILES) {
    totalChanges += fixFile(file);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`✓ Complete: ${totalChanges} renames applied`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nAll meta-types now use *Definition suffix per ADR-004');
}

main();
