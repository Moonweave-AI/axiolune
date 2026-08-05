#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');
if (!fs.existsSync(dataPath)) {
  console.error('FAIL: missing data.json — run node fibo-visualization/generate.cjs first');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const errors = [];

function fail(msg) { errors.push(msg); }

if (data.meta?.projection !== 'structural-v2') fail('meta.projection must be structural-v2');

const folded = new Set(['attribute', 'patternAttr', 'relation', 'constraint']);
const bad = (data.nodes || []).filter(n => folded.has(n.kind));
if (bad.length) fail('canvas still has folded kinds: ' + bad.slice(0, 5).map(n => n.kind + ':' + n.label).join(', ') + (bad.length > 5 ? '…' : ''));

const orphans = data.meta?.counts?.orphanAttributes;
if (orphans !== 0) fail('orphanAttributes expected 0, got ' + orphans);

const relationDefs = data.relationDefs || [];
const relationEdges = (data.edges || []).filter(e => e.type === 'relation');
if (!relationDefs.length) fail('relationDefs empty');
if (!relationEdges.length) fail('no relation edges on canvas');

const foldedAttrs = data.meta?.counts?.foldedAttributes;
const foldedPA = data.meta?.counts?.foldedPatternAttrs;
if (!(foldedAttrs > 0)) fail('foldedAttributes should be > 0');

const hostsWithAttrs = (data.nodes || []).filter(n => Array.isArray(n.attrs) && n.attrs.length).length;
if (!hostsWithAttrs) fail('no host nodes carry attrs[]');

const modules = data.meta?.counts?.stats?.modules || data.meta?.counts?.modules;
if (!(modules >= 200)) fail('FIBO modules expected >= 200, got ' + modules);

const canvas = data.meta?.counts?.canvasNodes;
if (!(canvas > 1000)) fail('canvasNodes expected > 1000 for full FIBO mirror, got ' + canvas);

if (errors.length) {
  console.error('ASSERT FAIL (' + errors.length + ')');
  errors.forEach(e => console.error(' -', e));
  process.exit(1);
}

console.log('ASSERT PASS structural-v2 (FIBO)');
console.log('  canvasNodes:', canvas);
console.log('  canvasEdges:', data.meta.counts.canvasEdges);
console.log('  modules:', modules);
console.log('  foldedAttributes:', foldedAttrs);
console.log('  foldedPatternAttrs:', foldedPA);
console.log('  relationDefs:', relationDefs.length);
console.log('  relationEdges:', relationEdges.length);
console.log('  hostsWithAttrs:', hostsWithAttrs);
console.log('  orphans:', orphans);
