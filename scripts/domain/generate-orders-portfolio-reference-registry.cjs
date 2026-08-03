#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_REGISTRY_PATH,
  buildLockedReferenceRegistry,
} = require('./lib/orders-portfolio-reference-registry.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function expectedBytes() {
  return Buffer.from(canonicalJcs(buildLockedReferenceRegistry(ROOT)), 'utf8');
}

function main(argv) {
  if (argv.length !== 1 || !['--write', '--check'].includes(argv[0])) {
    throw new Error(
      'Usage: node scripts/domain/generate-orders-portfolio-reference-registry.cjs --write|--check',
    );
  }
  const expected = expectedBytes();
  if (argv[0] === '--write') {
    fs.mkdirSync(path.dirname(DEFAULT_REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(DEFAULT_REGISTRY_PATH, expected);
  } else if (!fs.existsSync(DEFAULT_REGISTRY_PATH)
      || !fs.readFileSync(DEFAULT_REGISTRY_PATH).equals(expected)) {
    throw new Error(
      `Orders/Portfolio reference registry drift: ${path.relative(ROOT, DEFAULT_REGISTRY_PATH)}`,
    );
  }
  const registry = JSON.parse(expected.toString('utf8'));
  process.stdout.write(
    `PASS Orders/Portfolio reference registry (${argv[0].slice(2)}, `
      + `${registry.currencies.length} currencies, ${registry.quantityUnits.length} quantity units, `
      + `${registry.registryDigest})\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = { expectedBytes };
