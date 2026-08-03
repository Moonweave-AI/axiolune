#!/usr/bin/env node
'use strict';
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const cats = {
  unknownBase: 0,
  manifestDrift: 0,
  customExpr: 0,
  undefinedInstance: 0,
  customRuntime: 0,
  other: [],
};
const baseFixtures = new Map();
for (const line of lines) {
  if (!line.startsWith('FAIL')) continue;
  if (line.includes('PTO_TYPED_MANIFEST_BUILD_DRIFT')) {
    cats.manifestDrift += 1;
    continue;
  }
  if (line.includes('PTO_CUSTOM_EXPRESSION_TRIVIAL')) {
    cats.customExpr += 1;
    continue;
  }
  if (line.includes('unknown base fixture')) {
    cats.unknownBase += 1;
    const m = line.match(/unknown base fixture ([^\r\n]+)/);
    if (m) {
      const b = m[1].trim();
      baseFixtures.set(b, (baseFixtures.get(b) || 0) + 1);
    }
    continue;
  }
  if (line.includes("Cannot read properties of undefined (reading 'instance')")) {
    cats.undefinedInstance += 1;
    continue;
  }
  if (line.includes('CUSTOM-RUNTIME-PTO')) {
    cats.customRuntime += 1;
    continue;
  }
  cats.other.push(line.slice(0, 220));
}
console.log(JSON.stringify({ counts: cats, baseFixtures: Object.fromEntries([...baseFixtures.entries()].sort((a, b) => b[1] - a[1])) }, null, 2));
