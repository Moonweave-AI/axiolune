#!/usr/bin/env node
'use strict';

/**
 * Sync terminology sidecar YAML files with M2 module.yaml objectTypes.
 * - Matches existing cards by canonicalIri (preserves rich ISO 704 content)
 * - Renames term field to PascalCase entity name (matches objectType key)
 * - Adds stub cards for entities missing terminology
 * - Removes stale cards whose IRI no longer matches any entity
 *
 * Usage: node scripts/domain/sync-terminology-sidecars.cjs [--write]
 * Default: dry-run report only; pass --write to apply changes.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const WRITE = process.argv.includes('--write');

const MODULES = [
  { dir: 'foundation', termPrefix: 'fin-foundation' },
  { dir: 'market-structure', termPrefix: 'fin-market-structure' },
  { dir: 'instruments', termPrefix: 'fin-instruments' },
  { dir: 'market-rules', termPrefix: 'fin-market-rules' },
  { dir: 'market-data', termPrefix: 'fin-market-data' },
  { dir: 'portfolio-positions', termPrefix: 'fin-portfolio-positions' },
  { dir: 'orders-execution', termPrefix: 'fin-orders-execution' },
  { dir: 'strategy-research', termPrefix: 'fin-strategy-research' },
  { dir: 'risk', termPrefix: 'fin-risk' },
  { dir: 'post-trade-operations', termPrefix: 'fin-post-trade-operations' },
];

function loadYaml(p) {
  return yaml.load(fs.readFileSync(path.join(ROOT, p), 'utf8'));
}

function extractCards(doc) {
  const list = doc?.cards || doc?.terms || [];
  return Array.isArray(list) ? list : [];
}

function cardRootKey(doc) {
  if (doc?.cards) return 'cards';
  if (doc?.terms) return 'terms';
  return 'cards';
}

function collectDomainElements(domain) {
  const elements = [];
  const containers = [
    'objectTypes', 'associationTypes', 'relationTypes', 'attributeTypes',
    'identifierTypes', 'codeLists',
  ];
  for (const container of containers) {
    const block = domain?.[container];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, def] of Object.entries(block)) {
      if (def && typeof def === 'object' && def.iri) {
        elements.push([name, def]);
      }
    }
  }
  return elements;
}

function stripDefinitionPrefix(def) {
  if (!def || typeof def !== 'string') return def || '';
  return def.replace(/^[A-Za-z][A-Za-z0-9 ]*, is (a |an )?/i, '').trim();
}

function buildStubCard(entityName, entityDef, moduleVersion) {
  const iri = entityDef.iri || entityDef.localName;
  const definition = stripDefinitionPrefix(entityDef.definition) || entityDef.label || entityName;
  return {
    term: entityName,
    canonicalIri: iri,
    definition,
    genus: entityDef.label || entityName,
    differentia: entityDef.cnNote ? [entityDef.cnNote] : [],
    excludes: [],
    sources: [{ reference: 'module-yaml', locator: `ontology/domain/finance (v${moduleVersion})` }],
    candidateM3Type: 'ObjectTypeDefinition',
    status: 'accepted',
    owner: 'axiolune-m2-team',
  };
}

let totalAdded = 0;
let totalRenamed = 0;
let totalRemoved = 0;
let totalPreserved = 0;

for (const { dir, termPrefix } of MODULES) {
  const modPath = `ontology/domain/finance/${dir}/module.yaml`;
  const termPath = `docs/ontology/terminology/${termPrefix}-terms.yaml`;
  const modData = loadYaml(modPath);
  const modVersion = modData?.module?.version || '?';
  const entities = collectDomainElements(modData?.domain || {});

  let termDoc;
  try {
    termDoc = loadYaml(termPath);
  } catch {
    termDoc = { cards: [] };
  }

  const rootKey = cardRootKey(termDoc);
  const existing = extractCards(termDoc);

  const byIri = new Map();
  const byTerm = new Map();
  for (const card of existing) {
    if (card.canonicalIri) byIri.set(card.canonicalIri, card);
    const t = card.term || card.name || card.entity;
    if (t) byTerm.set(t, card);
  }

  const entityIris = new Set(entities.map(([, def]) => def.iri).filter(Boolean));
  const newCards = [];

  for (const [entityName, entityDef] of entities) {
    const iri = entityDef.iri;
    let card = byIri.get(iri);

    if (!card) {
      const localSuffix = iri ? iri.split('/').pop() : entityName;
      card = byTerm.get(entityName) || byTerm.get(localSuffix);
      if (card && card.canonicalIri && card.canonicalIri !== iri) {
        card = null;
      }
    }

    if (card) {
      const renamed = card.term !== entityName;
      const updated = { ...card, term: entityName, canonicalIri: iri || card.canonicalIri };
      newCards.push(updated);
      if (renamed) {
        totalRenamed++;
        console.log(`  rename: ${card.term} → ${entityName}`);
      } else {
        totalPreserved++;
      }
    } else {
      newCards.push(buildStubCard(entityName, entityDef, modVersion));
      totalAdded++;
      console.log(`  add stub: ${entityName}`);
    }
  }

  const removed = existing.filter(c => c.canonicalIri && !entityIris.has(c.canonicalIri));
  for (const c of removed) {
    totalRemoved++;
    console.log(`  remove stale: ${c.term} (${c.canonicalIri})`);
  }

  newCards.sort((a, b) => (a.term || '').localeCompare(b.term || ''));

  const header = `# ${termPrefix} — Terminology Cards\n# Synced from module.yaml v${modVersion} — ${new Date().toISOString().slice(0, 10)}\n# Each card: term (module.yaml entity key), canonicalIri, ISO 704 definition\n\n`;
  const outDoc = { [rootKey]: newCards };
  const yamlBody = yaml.dump(outDoc, { lineWidth: 120, noRefs: true, quotingType: '"' });

  console.log(`\n${termPrefix}: ${newCards.length} cards (${entities.length} entities)`);

  if (WRITE) {
    fs.writeFileSync(path.join(ROOT, termPath), header + yamlBody, 'utf8');
  }
}

console.log(`\n=== Summary ===`);
console.log(`Added: ${totalAdded}, Renamed: ${totalRenamed}, Removed: ${totalRemoved}, Preserved: ${totalPreserved}`);
console.log(WRITE ? '✅ Written.' : '(dry-run — pass --write to apply)');
