#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');
if (!fs.existsSync(dataPath)) {
  console.error('FAIL: missing data.json — run node visualization/generate.cjs first');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const errors = [];

function fail(msg) { errors.push(msg); }

if (data.meta?.projection !== 'structural-v2') fail('meta.projection must be structural-v2');

// `constraint` is intentionally a canvas kind (domain/M3 constraints are
// first-class nodes). Only attribute/patternAttr/relation are folded.
const folded = new Set(['attribute', 'patternAttr', 'relation']);
const bad = (data.nodes || []).filter(n => folded.has(n.kind));
if (bad.length) fail('canvas still has folded kinds: ' + bad.slice(0, 5).map(n => n.kind + ':' + n.label).join(', ') + (bad.length > 5 ? '…' : ''));

const orphans = data.meta?.counts?.orphanAttributes;
if (orphans !== 0) fail('orphanAttributes expected 0, got ' + orphans);

const relationDefs = data.relationDefs || [];
const relationEdges = (data.edges || []).filter(e => e.type === 'relation');
if (!relationDefs.length) fail('relationDefs empty');
if (!relationEdges.length) fail('no relation edges on canvas');

let missingEdge = 0;
for (const r of relationDefs) {
  if (!r.domainId || !r.rangeId) continue;
  const hit = relationEdges.some(e =>
    e.from === r.domainId && e.to === r.rangeId && (e.label === r.label || !e.label)
  );
  if (!hit) missingEdge++;
}
if (missingEdge > 0) fail(missingEdge + ' relationDefs lack matching domain→range relation edge');

const foldedAttrs = data.meta?.counts?.foldedAttributes;
const foldedPA = data.meta?.counts?.foldedPatternAttrs;
if (!(foldedAttrs > 0)) fail('foldedAttributes should be > 0');
if (!(foldedPA > 0)) fail('foldedPatternAttrs should be > 0');

const hostsWithAttrs = (data.nodes || []).filter(n => Array.isArray(n.attrs) && n.attrs.length).length;
if (!hostsWithAttrs) fail('no host nodes carry attrs[]');

const canvas = data.meta?.counts?.canvasNodes;
if (!(canvas > 0) || !(canvas < 1200)) fail('canvasNodes unexpected: ' + canvas + ' (expected < 1200 with constraints on canvas)');

// Constraint surface (new in ontology revision ADR-020..033)
const constraintNodes = (data.nodes || []).filter(n => n.kind === 'constraint');
if (!constraintNodes.length) fail('no constraint nodes on canvas (domain/M3 constraints missing)');
const domainConstraints = data.meta?.counts?.domainConstraints;
if (!(domainConstraints > 0)) fail('domainConstraints count should be > 0, got ' + domainConstraints);
const targetEdges = (data.edges || []).filter(e => e.type === 'targets');
if (!targetEdges.length) fail('no targets edges (constraints must link to targets)');
const enrichedRels = relationDefs.filter(r => (r.useCardinality && r.useCardinality !== '') || (Array.isArray(r.boundConstraints) && r.boundConstraints.length));
if (!enrichedRels.length) fail('no relationDefs enriched with useCardinality/boundConstraints (relationUses not read)');
const cbCount = data.meta?.counts?.constraintBindings;
if (!(cbCount > 0)) fail('constraintBindings count should be > 0, got ' + cbCount);

if (errors.length) {
  console.error('ASSERT FAIL (' + errors.length + ')');
  errors.forEach(e => console.error(' -', e));
  process.exit(1);
}

console.log('ASSERT PASS structural-v2');
console.log('  canvasNodes:', canvas);
console.log('  canvasEdges:', data.meta.counts.canvasEdges);
console.log('  foldedAttributes:', foldedAttrs);
console.log('  foldedPatternAttrs:', foldedPA);
console.log('  relationDefs:', relationDefs.length, '(enriched:', enrichedRels.length, ')');
console.log('  relationEdges:', relationEdges.length);
console.log('  constraintNodes:', constraintNodes.length, '(M3:', data.meta.counts.m3Constraints, 'domain:', domainConstraints, ')');
console.log('  targetsEdges:', targetEdges.length);
console.log('  relationUses:', data.meta.counts.relationUses, 'constraintBindings:', cbCount);
console.log('  hostsWithAttrs:', hostsWithAttrs);
console.log('  orphans:', orphans);
