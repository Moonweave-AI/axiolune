'use strict';

const FINANCE_BASE = 'https://axiolune.ai/ontology/finance/';

const CANONICAL_IMPORTS = Object.freeze({
  foundation: [],
  'market-structure': ['foundation'],
  instruments: ['foundation', 'market-structure'],
  'market-rules': ['foundation', 'market-structure', 'instruments'],
  'market-data': ['foundation', 'market-structure', 'instruments', 'market-rules'],
  'orders-execution': ['foundation', 'market-structure', 'instruments', 'market-rules'],
  'portfolio-positions': ['foundation', 'instruments', 'market-data', 'orders-execution'],
  'strategy-research': ['foundation', 'instruments', 'market-data', 'portfolio-positions'],
  risk: ['foundation', 'market-data', 'portfolio-positions'],
  'post-trade-operations': [
    'foundation',
    'market-structure',
    'instruments',
    'market-rules',
    'market-data',
    'orders-execution',
    'portfolio-positions',
  ],
});

function utf8Sort(values) {
  return [...values].sort((left, right) => (
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  ));
}

function localModuleName(moduleIri) {
  return typeof moduleIri === 'string' && moduleIri.startsWith(FINANCE_BASE)
    ? moduleIri.slice(FINANCE_BASE.length)
    : null;
}

function validateCanonicalFinanceDag(records) {
  const findings = [];
  const byName = new Map();
  for (const record of records) {
    const module = record?.module || record;
    const name = localModuleName(module?.moduleIri);
    if (name === null) continue;
    if (byName.has(name)) {
      findings.push({
        code: 'DUPLICATE_FINANCE_MODULE',
        module: name,
        message: `multiple active module records declare ${module.moduleIri}`,
      });
      continue;
    }
    byName.set(name, module);
  }

  const expectedNames = Object.keys(CANONICAL_IMPORTS);
  for (const name of expectedNames) {
    if (!byName.has(name)) {
      findings.push({
        code: 'MISSING_FINANCE_MODULE',
        module: name,
        message: `RFC-001 v0.3 active finance module is missing: ${name}`,
      });
    }
  }
  for (const name of byName.keys()) {
    if (!Object.prototype.hasOwnProperty.call(CANONICAL_IMPORTS, name)) {
      findings.push({
        code: 'EXTRA_FINANCE_MODULE',
        module: name,
        message: `module is outside the RFC-001 ten-node active inventory: ${name}`,
      });
    }
  }

  for (const [name, expectedLocalImports] of Object.entries(CANONICAL_IMPORTS)) {
    const module = byName.get(name);
    if (!module) continue;
    if (module.version !== '0.3.0') {
      findings.push({
        code: 'WRONG_FINANCE_VERSION',
        module: name,
        message: `canonical v0.3 graph requires version 0.3.0, got ${String(module.version)}`,
      });
    }
    const imports = Array.isArray(module.imports) ? module.imports : [];
    const actualIris = imports.map((entry) => entry?.moduleIri);
    const duplicates = actualIris.filter(
      (iri, index) => actualIris.indexOf(iri) !== index,
    );
    if (duplicates.length > 0) {
      findings.push({
        code: 'DUPLICATE_DIRECT_IMPORT',
        module: name,
        message: `duplicate direct imports: ${utf8Sort(new Set(duplicates)).join(', ')}`,
      });
    }
    const expectedIris = expectedLocalImports.map((localName) => `${FINANCE_BASE}${localName}`);
    const actualSorted = utf8Sort(new Set(actualIris));
    const expectedSorted = utf8Sort(expectedIris);
    if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
      findings.push({
        code: 'DIRECT_IMPORT_SET_MISMATCH',
        module: name,
        message:
          `expected [${expectedSorted.join(', ')}], got [${actualSorted.join(', ')}]`,
      });
    }
  }

  return findings.sort((left, right) => {
    const leftKey = `${left.module}\0${left.code}\0${left.message}`;
    const rightKey = `${right.module}\0${right.code}\0${right.message}`;
    return Buffer.compare(Buffer.from(leftKey, 'utf8'), Buffer.from(rightKey, 'utf8'));
  });
}

module.exports = {
  CANONICAL_IMPORTS,
  FINANCE_BASE,
  validateCanonicalFinanceDag,
};
