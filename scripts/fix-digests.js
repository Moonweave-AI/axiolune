#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const META_DIR = path.join(__dirname, '..', 'ontology', 'meta');

const FILES = [
  { key: 'core', file: 'core-meta-model.yaml', iri: 'https://axiolune.ai/ontology/meta/core' },
  { key: 'patterns', file: 'cross-domain-patterns.yaml', iri: 'https://axiolune.ai/ontology/meta/patterns' },
  { key: 'behavior', file: 'behavior-meta-model.yaml', iri: 'https://axiolune.ai/ontology/meta/behavior' },
  { key: 'dataBinding', file: 'data-binding-meta-model.yaml', iri: 'https://axiolune.ai/ontology/meta/data-binding' }
];

function calculateDigest(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return 'sha256:' + crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

console.log('Step 1: Calculate current digests\n');

const currentDigests = {};
for (const fileInfo of FILES) {
  const filePath = path.join(META_DIR, fileInfo.file);
  currentDigests[fileInfo.iri] = calculateDigest(filePath);
  console.log(`${fileInfo.key}: ${currentDigests[fileInfo.iri]}`);
}

console.log('\nStep 2: Update digests.json\n');

const digestsPath = path.join(META_DIR, 'digests.json');
const digestsContent = {
  generated: new Date().toISOString(),
  digests: currentDigests
};

fs.writeFileSync(digestsPath, JSON.stringify(digestsContent, null, 2) + '\n', 'utf8');
console.log('✓ Updated digests.json');

console.log('\nStep 3: Update import references in dependent files\n');

// Update patterns (imports core)
let patternsPath = path.join(META_DIR, 'cross-domain-patterns.yaml');
let patternsContent = fs.readFileSync(patternsPath, 'utf8');
patternsContent = patternsContent.replace(
  /(- moduleIri: "https:\/\/axiolune\.ai\/ontology\/meta\/core)(?:#sha256:[a-f0-9]{64})?(")/,
  `$1#${currentDigests['https://axiolune.ai/ontology/meta/core']}$2`
);
patternsContent = patternsContent.replace(
  /(artifactDigest: ")(sha256:[a-f0-9]{64})(" *# .*core)/i,
  `$1${currentDigests['https://axiolune.ai/ontology/meta/core']}$3`
);
// Also update standalone artifactDigest for core
patternsContent = patternsContent.replace(
  /moduleIri: "https:\/\/axiolune\.ai\/ontology\/meta\/core#[^"]*"\s+version: "0\.3\.0"\s+artifactDigest: "sha256:[a-f0-9]{64}"/,
  `moduleIri: "https://axiolune.ai/ontology/meta/core#${currentDigests['https://axiolune.ai/ontology/meta/core']}"\n      version: "0.3.0"\n      artifactDigest: "${currentDigests['https://axiolune.ai/ontology/meta/core']}"`
);
fs.writeFileSync(patternsPath, patternsContent, 'utf8');
console.log('✓ Updated cross-domain-patterns.yaml');

// Recalculate patterns digest after update
currentDigests['https://axiolune.ai/ontology/meta/patterns'] = calculateDigest(patternsPath);
console.log(`  New patterns digest: ${currentDigests['https://axiolune.ai/ontology/meta/patterns']}`);

// Update behavior (imports core and patterns)
let behaviorPath = path.join(META_DIR, 'behavior-meta-model.yaml');
let behaviorContent = fs.readFileSync(behaviorPath, 'utf8');
behaviorContent = behaviorContent.replace(
  /(- moduleIri: "https:\/\/axiolune\.ai\/ontology\/meta\/core)(?:#sha256:[a-f0-9]{64})?(")/,
  `$1#${currentDigests['https://axiolune.ai/ontology/meta/core']}$2`
);
behaviorContent = behaviorContent.replace(
  /(- moduleIri: "https:\/\/axiolune\.ai\/ontology\/meta\/patterns)(?:#sha256:[a-f0-9]{64})?(")/,
  `$1#${currentDigests['https://axiolune.ai/ontology/meta/patterns']}$2`
);
// Update both artifactDigest entries
const lines = behaviorContent.split('\n');
let coreImportSection = false;
let patternsImportSection = false;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('moduleIri: "https://axiolune.ai/ontology/meta/core')) {
    coreImportSection = true;
    patternsImportSection = false;
  } else if (lines[i].includes('moduleIri: "https://axiolune.ai/ontology/meta/patterns')) {
    patternsImportSection = true;
    coreImportSection = false;
  } else if (lines[i].trim().startsWith('- moduleIri:')) {
    coreImportSection = false;
    patternsImportSection = false;
  }

  if (lines[i].includes('artifactDigest:')) {
    if (coreImportSection) {
      lines[i] = lines[i].replace(/sha256:[a-f0-9]{64}/, currentDigests['https://axiolune.ai/ontology/meta/core'].replace('sha256:', 'sha256:'));
    } else if (patternsImportSection) {
      lines[i] = lines[i].replace(/sha256:[a-f0-9]{64}/, currentDigests['https://axiolune.ai/ontology/meta/patterns'].replace('sha256:', 'sha256:'));
    }
  }
}

behaviorContent = lines.join('\n');
fs.writeFileSync(behaviorPath, behaviorContent, 'utf8');
console.log('✓ Updated behavior-meta-model.yaml');

// Recalculate behavior digest
currentDigests['https://axiolune.ai/ontology/meta/behavior'] = calculateDigest(behaviorPath);
console.log(`  New behavior digest: ${currentDigests['https://axiolune.ai/ontology/meta/behavior']}`);

// Update data-binding (imports core, patterns, and behavior)
let dataBindingPath = path.join(META_DIR, 'data-binding-meta-model.yaml');
let dataBindingContent = fs.readFileSync(dataBindingPath, 'utf8');
dataBindingContent = dataBindingContent.replace(
  /(- moduleIri: "https:\/\/axiolune\.ai\/ontology\/meta\/core)(?:#sha256:[a-f0-9]{64})?(")/,
  `$1#${currentDigests['https://axiolune.ai/ontology/meta/core']}$2`
);
dataBindingContent = dataBindingContent.replace(
  /(- moduleIri: "https:\/\/axiolune\.ai\/ontology\/meta\/patterns)(?:#sha256:[a-f0-9]{64})?(")/,
  `$1#${currentDigests['https://axiolune.ai/ontology/meta/patterns']}$2`
);
dataBindingContent = dataBindingContent.replace(
  /(- moduleIri: "https:\/\/axiolune\.ai\/ontology\/meta\/behavior)(?:#sha256:[a-f0-9]{64})?(")/,
  `$1#${currentDigests['https://axiolune.ai/ontology/meta/behavior']}$2`
);

const dbLines = dataBindingContent.split('\n');
let dbCoreSection = false;
let dbPatternsSection = false;
let dbBehaviorSection = false;

for (let i = 0; i < dbLines.length; i++) {
  if (dbLines[i].includes('moduleIri: "https://axiolune.ai/ontology/meta/core')) {
    dbCoreSection = true;
    dbPatternsSection = false;
    dbBehaviorSection = false;
  } else if (dbLines[i].includes('moduleIri: "https://axiolune.ai/ontology/meta/patterns')) {
    dbPatternsSection = true;
    dbCoreSection = false;
    dbBehaviorSection = false;
  } else if (dbLines[i].includes('moduleIri: "https://axiolune.ai/ontology/meta/behavior')) {
    dbBehaviorSection = true;
    dbCoreSection = false;
    dbPatternsSection = false;
  } else if (dbLines[i].trim().startsWith('- moduleIri:')) {
    dbCoreSection = false;
    dbPatternsSection = false;
    dbBehaviorSection = false;
  }

  if (dbLines[i].includes('artifactDigest:')) {
    if (dbCoreSection) {
      dbLines[i] = dbLines[i].replace(/sha256:[a-f0-9]{64}/, currentDigests['https://axiolune.ai/ontology/meta/core'].replace('sha256:', 'sha256:'));
    } else if (dbPatternsSection) {
      dbLines[i] = dbLines[i].replace(/sha256:[a-f0-9]{64}/, currentDigests['https://axiolune.ai/ontology/meta/patterns'].replace('sha256:', 'sha256:'));
    } else if (dbBehaviorSection) {
      dbLines[i] = dbLines[i].replace(/sha256:[a-f0-9]{64}/, currentDigests['https://axiolune.ai/ontology/meta/behavior'].replace('sha256:', 'sha256:'));
    }
  }
}

dataBindingContent = dbLines.join('\n');
fs.writeFileSync(dataBindingPath, dataBindingContent, 'utf8');
console.log('✓ Updated data-binding-meta-model.yaml');

// Recalculate data-binding digest
currentDigests['https://axiolune.ai/ontology/meta/data-binding'] = calculateDigest(dataBindingPath);
console.log(`  New data-binding digest: ${currentDigests['https://axiolune.ai/ontology/meta/data-binding']}`);

console.log('\nStep 4: Update digests.json with final digests\n');

digestsContent.digests = currentDigests;
digestsContent.generated = new Date().toISOString();
fs.writeFileSync(digestsPath, JSON.stringify(digestsContent, null, 2) + '\n', 'utf8');

console.log('Final digests:');
for (const fileInfo of FILES) {
  console.log(`  ${fileInfo.key}: ${currentDigests[fileInfo.iri]}`);
}

console.log('\n✓ All digests updated successfully');
