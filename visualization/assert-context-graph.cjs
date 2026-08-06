#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const template = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'));
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };

assert(template.includes('id="contextGraph"'), 'missing lower-right context panel');
assert(template.includes('id="contextSvg"'), 'missing two-hop SVG surface');
assert(template.includes('height:calc((100% - 120px)/2)'), 'context panels are not constrained to equal half-height regions');
assert(template.includes('width:min(440px,calc(100% - 24px))'), 'right-side panels do not use the widened responsive width');
assert(template.includes('function buildTwoHopContext(rootId)'), 'missing two-hop scope builder');
assert(template.includes('function renderContextGraph(rootId)'), 'missing two-hop renderer');
assert(template.includes('function seedContextPositions(nodes,width,height,cx,cy)'), 'missing hop-aware ring placement');
assert(template.includes("iterations(6).strength(1)"), 'strong context-node collision avoidance is missing');
assert(template.includes('function applyContextLabelVisibility(scale)'), 'semantic label visibility is missing');
assert(template.includes('scale>=1.75') && template.includes('scale>=2.4'), 'two-hop label zoom thresholds are missing');
assert(template.includes("scaleExtent([.6,3.5])"), 'context SVG zoom range is missing');
assert(template.includes('id="contextZoomIn"') && template.includes('id="contextZoomOut"') && template.includes('id="contextZoomFit"'), 'context zoom controls are missing');
assert(template.includes('its connections · click for'), 'bottom help text does not contain rendered separators');
assert(!template.includes('its connections \\u00b7'), 'bottom help text still contains literal Unicode escapes');
assert(template.includes('CONTEXT_MAX_NODES'), 'missing compact-graph bound');
assert(template.includes("if(edge.type==='pattern') return;"), 'pattern fan-out guard is missing');
assert(template.includes('showTip(d,ev)'), 'context-node hover does not reuse the explanation tooltip');
assert(template.includes('renderContextGraph(d.id)'), 'main-node click does not update context graph');
assert(template.includes('circle-and-label visual language'), 'main graph has not adopted the context graph visual language');
assert(template.includes("return 'M'+d.source.x+','+d.source.y+' L'+d.target.x+','+d.target.y;"), 'main graph edges are not the compact straight style');
assert(template.includes("attr('class','node-shape')"), 'main graph nodes are not rendered as compact circles');
assert(template.includes('const showLandmarks = k >= .95;') && template.includes('const showDetail = k >= 1.65;'), 'main graph semantic label zoom thresholds are missing');
assert(template.includes('.leg-marker.module') && template.includes("const markerClass = g==='module'"), 'legend does not share the main graph circle markers');
assert(template.includes('#legend::-webkit-scrollbar') && template.includes('scrollbar-color:var(--scroll-thumb)'), 'panel scrollbar styling is missing');
assert(index.includes('Two-hop context'), 'generated index is stale');

const structural = new Set(['subClassOf','relation','participant','fieldType','appliesTo','injects','dependsOn','conflicts','inverseOf','import','domainOf','rangeOf','targets']);
const structuralEdges = data.edges.filter(edge => structural.has(edge.type));
assert(structuralEdges.length > 0, 'projection has no usable structural edges');
const known = new Set(data.nodes.map(node => node.id));
assert(structuralEdges.every(edge => known.has(edge.from) && known.has(edge.to)), 'structural edge has an unresolved endpoint');

if (errors.length) {
  console.error(`ASSERT FAIL context-graph (${errors.length})`);
  errors.forEach(error => console.error(' -', error));
  process.exit(1);
}

console.log('ASSERT PASS context-graph');
console.log(`  structural edges available: ${structuralEdges.length}`);
console.log('  scope: root + ranked first-hop + ranked second-hop structural nodes');
