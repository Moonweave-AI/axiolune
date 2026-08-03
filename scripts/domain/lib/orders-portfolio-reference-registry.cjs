'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REGISTRY_KIND = 'axioluneOrdersPortfolioClosedReferenceRegistry';
const DEFAULT_REGISTRY_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'orders-portfolio-custom-profile',
  'v0.3.0',
  'reference-registry.json',
);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function digestJcs(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJcs(value), 'utf8').digest('hex')}`;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (canonicalJcs(actual) !== canonicalJcs(wanted)) {
    throw new Error(`${label} fields differ`);
  }
}

function validateRows(rows, label, lexicalPattern) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${label} must be non-empty`);
  const iriByLexical = new Map();
  const lexicalByIri = new Map();
  let prior = null;
  for (const [index, row] of rows.entries()) {
    exactKeys(row, ['lexical', 'logicalIri'], `${label}[${index}]`);
    if (typeof row.lexical !== 'string' || !lexicalPattern.test(row.lexical)
        || typeof row.logicalIri !== 'string'
        || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(row.logicalIri)) {
      throw new Error(`${label}[${index}] is malformed`);
    }
    if (prior !== null && compareUtf8(prior, row.lexical) >= 0) {
      throw new Error(`${label} must be strictly lexical-sorted and unique`);
    }
    prior = row.lexical;
    if (iriByLexical.has(row.lexical) || lexicalByIri.has(row.logicalIri)) {
      throw new Error(`${label} is not a bijection`);
    }
    iriByLexical.set(row.lexical, row.logicalIri);
    lexicalByIri.set(row.logicalIri, row.lexical);
  }
  return { iriByLexical, lexicalByIri };
}

function registryPayload(value) {
  return {
    currencies: value.currencies,
    profileRef: value.profileRef,
    quantityUnits: value.quantityUnits,
    registryKind: value.registryKind,
    schemaVersion: value.schemaVersion,
    sourceClosure: value.sourceClosure,
  };
}

function sealReferenceRegistry(payload) {
  exactKeys(
    payload,
    ['currencies', 'profileRef', 'quantityUnits', 'registryKind', 'schemaVersion', 'sourceClosure'],
    'reference registry payload',
  );
  return {
    ...structuredClone(payload),
    registryDigest: digestJcs(payload),
  };
}

function validateReferenceRegistry(registry) {
  exactKeys(
    registry,
    [
      'currencies', 'profileRef', 'quantityUnits', 'registryDigest',
      'registryKind', 'schemaVersion', 'sourceClosure',
    ],
    'reference registry',
  );
  if (registry.schemaVersion !== '1.0'
      || registry.registryKind !== REGISTRY_KIND
      || registry.profileRef !== 'https://axiolune.ai/conformance/m2/0.3.0/orders-portfolio-custom'
      || !/^sha256:[0-9a-f]{64}$/u.test(registry.registryDigest)
      || registry.registryDigest !== digestJcs(registryPayload(registry))) {
    throw new Error('reference registry header or digest is invalid');
  }
  exactKeys(registry.sourceClosure, ['iso4217', 'quantityUnits'], 'reference registry sourceClosure');
  for (const [label, row] of Object.entries(registry.sourceClosure)) {
    exactKeys(row, ['artifactDigest', 'artifactRef', 'selectionDigest'], `sourceClosure.${label}`);
    if (!/^sha256:[0-9a-f]{64}$/u.test(row.artifactDigest)
        || !/^sha256:[0-9a-f]{64}$/u.test(row.selectionDigest)
        || typeof row.artifactRef !== 'string'
        || row.artifactRef.length === 0) {
      throw new Error(`sourceClosure.${label} is malformed`);
    }
  }
  const currencies = validateRows(registry.currencies, 'currencies', /^[A-Z]{3}$/u);
  const quantityUnits = validateRows(
    registry.quantityUnits,
    'quantityUnits',
    /^[A-Za-z][A-Za-z0-9._-]*$/u,
  );
  return {
    currencies,
    quantityUnits,
    registry,
  };
}

function buildLockedReferenceRegistry(root = ROOT) {
  // Keep the authority-source reader out of the production adapter's runtime
  // dependency graph. Generation independently compiles the locked sources;
  // the restricted worker consumes only the exact generated registry.
  const {
    loadLockedIso4217Registry,
    loadLockedQuantityRegistry,
  } = require('./slice-a-source-locks.cjs');
  const iso = loadLockedIso4217Registry(root);
  const quantity = loadLockedQuantityRegistry(root);
  const payload = {
    currencies: [...iso.entries.values()].map((row) => ({
      lexical: row.alphaCode,
      logicalIri: `https://axiolune.ai/data/currency/${row.alphaCode}`,
    })).sort((left, right) => compareUtf8(left.lexical, right.lexical)),
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0/orders-portfolio-custom',
    quantityUnits: quantity.registry.units.map((row) => ({
      lexical: row.notation,
      logicalIri: row.unitIri,
    })).sort((left, right) => compareUtf8(left.lexical, right.lexical)),
    registryKind: REGISTRY_KIND,
    schemaVersion: '1.0',
    sourceClosure: {
      iso4217: {
        artifactDigest: iso.rawDigest,
        artifactRef: 'reference/authority-reference/six/2026-07-31/iso-4217-list-one/iso-4217-list-one.xml',
        selectionDigest: iso.tableLocator.selectionDigest,
      },
      quantityUnits: {
        artifactDigest: quantity.rawDigest,
        artifactRef: 'reference/ontology-design-reference/axiolune-controlled-quantity-units/m2-v0.3-quantity-units.json',
        selectionDigest: quantity.registry.candidateDigest,
      },
    },
  };
  const registry = sealReferenceRegistry(payload);
  validateReferenceRegistry(registry);
  return registry;
}

function loadGeneratedReferenceRegistry(file = DEFAULT_REGISTRY_PATH) {
  const bytes = fs.readFileSync(file);
  let registry;
  try {
    registry = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`generated reference registry is not JSON: ${cause.message}`);
  }
  if (!bytes.equals(Buffer.from(canonicalJcs(registry), 'utf8'))) {
    throw new Error('generated reference registry is not exact RFC 8785 JCS');
  }
  validateReferenceRegistry(registry);
  return registry;
}

module.exports = {
  DEFAULT_REGISTRY_PATH,
  REGISTRY_KIND,
  buildLockedReferenceRegistry,
  loadGeneratedReferenceRegistry,
  sealReferenceRegistry,
  validateReferenceRegistry,
};
