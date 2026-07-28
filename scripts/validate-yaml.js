#!/usr/bin/env node
/**
 * Simple YAML syntax validator
 * Usage: node scripts/validate-yaml.js <file1.yaml> [file2.yaml ...]
 */

const fs = require('fs');
const yaml = require('yaml');

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node validate-yaml.js <file1.yaml> [file2.yaml ...]');
  process.exit(1);
}

let hasErrors = false;

args.forEach(file => {
  try {
    const content = fs.readFileSync(file, 'utf8');
    yaml.parse(content);
    console.log(`✓ ${file}: valid YAML`);
  } catch (e) {
    console.error(`✗ ${file}: ${e.message}`);
    hasErrors = true;
  }
});

process.exit(hasErrors ? 1 : 0);
