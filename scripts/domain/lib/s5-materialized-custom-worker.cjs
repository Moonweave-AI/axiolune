#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');
const {
  canonicalJcs,
  validateArtifactRef,
} = require('./strict-source-locator.cjs');
const {
  validateMaterializedCustom,
} = require('./s5-materialized-custom-validation.cjs');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...names].sort());
}

function readFile(file, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file)
      || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} must be an existing absolute file`);
  }
  return fs.readFileSync(file);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
  );
}

function main() {
  const requestBytes = fs.readFileSync(0);
  const input = parseJsonRejectingDuplicateMembers(requestBytes.toString('utf8'));
  if (!exactKeys(input, [
    'allowedGeneratingContextIris', 'asOfAvailable', 'asOfKnowledge', 'asOfValid',
    'dataNQuads', 'lockedEvidenceArtifacts', 'moduleSourcePaths', 'referenceTime', 'schemaVersion',
    'supportNQuads', 'targetGraphIri',
  ]) || input.schemaVersion !== '1.0') {
    throw new Error('request differs from the closed S5 materialized-Custom protocol');
  }
  for (const field of [
    'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'dataNQuads', 'referenceTime',
    'supportNQuads', 'targetGraphIri',
  ]) {
    if (typeof input[field] !== 'string') throw new Error(`${field} must be a string`);
  }
  if (!Array.isArray(input.allowedGeneratingContextIris)
      || !Array.isArray(input.lockedEvidenceArtifacts)
      || input.lockedEvidenceArtifacts.length === 0
      || !Array.isArray(input.moduleSourcePaths)
      || input.moduleSourcePaths.length === 0) {
    throw new Error('module, evidence, and generating-context closures must be non-empty arrays');
  }
  const modules = input.moduleSourcePaths.map((file, index) => {
    const bytes = readFile(file, `moduleSourcePaths[${index}]`);
    const document = yaml.load(bytes.toString('utf8'), { json: false });
    return {
      bytes,
      document,
      file,
      moduleIri: document.module.moduleIri,
      sourceDigest: sha256(bytes),
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.moduleIri, 'utf8'),
    Buffer.from(right.moduleIri, 'utf8'),
  ));
  if (new Set(modules.map((entry) => entry.moduleIri)).size !== modules.length) {
    throw new Error('moduleSourcePaths resolve to duplicate module IRIs');
  }
  const lockedEvidence = new Map();
  const lockedArtifactsByRef = new Map();
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..', '..', '..'));
  const evidenceRows = [];
  let previousEvidenceIri = null;
  for (const [index, row] of input.lockedEvidenceArtifacts.entries()) {
    const hasExplicitArtifactRef = Object.prototype.hasOwnProperty.call(row, 'artifactRef');
    const expectedKeys = hasExplicitArtifactRef
      ? ['artifactDigest', 'artifactRef', 'evidenceIri', 'evidenceKind', 'file']
      : ['artifactDigest', 'evidenceIri', 'evidenceKind', 'file'];
    if (!exactKeys(row, expectedKeys) || !/^sha256:[0-9a-f]{64}$/u.test(row.artifactDigest || '')
        || typeof row.evidenceIri !== 'string' || typeof row.evidenceKind !== 'string') {
      throw new Error(`lockedEvidenceArtifacts[${index}] differs from the closed binding schema`);
    }
    if (previousEvidenceIri !== null
        && Buffer.compare(Buffer.from(previousEvidenceIri), Buffer.from(row.evidenceIri)) >= 0) {
      throw new Error('lockedEvidenceArtifacts must be strictly byte-sorted and unique by evidenceIri');
    }
    previousEvidenceIri = row.evidenceIri;
    const bytes = readFile(row.file, `lockedEvidenceArtifacts[${index}].file`);
    if (sha256(bytes) !== row.artifactDigest) {
      throw new Error(`lockedEvidenceArtifacts[${index}] digest differs from exact bytes`);
    }
    const realFile = fs.realpathSync(row.file);
    let artifactRef;
    if (hasExplicitArtifactRef) {
      const validation = validateArtifactRef(
        row.artifactRef,
        `lockedEvidenceArtifacts[${index}].artifactRef`,
      );
      if (!validation.ok
          || row.artifactRef.kind !== 'path'
          || row.artifactRef.root !== 'sourceTree') {
        throw new Error(
          `lockedEvidenceArtifacts[${index}].artifactRef must be one locked sourceTree path ArtifactRef`,
        );
      }
      artifactRef = row.artifactRef;
    } else {
      if (!inside(repositoryRoot, realFile)) {
        throw new Error(
          `lockedEvidenceArtifacts[${index}] outside the repository requires an explicit ArtifactRef`,
        );
      }
      artifactRef = {
        kind: 'path',
        path: path.relative(repositoryRoot, realFile).split(path.sep).join('/'),
        root: 'sourceTree',
      };
    }
    let value = null;
    if (![
      'executableRuntime',
      'executableTransform',
      'valuationFormulaImplementation',
    ].includes(row.evidenceKind)) {
      const text = bytes.toString('utf8');
      value = parseJsonRejectingDuplicateMembers(text);
      if (text !== canonicalJcs(value)) {
        throw new Error(`lockedEvidenceArtifacts[${index}] is not exact RFC8785 JCS`);
      }
    }
    const evidence = { ...row, artifactRef, bytes, value };
    lockedEvidence.set(row.evidenceIri, evidence);
    const artifactKey = canonicalJcs(artifactRef);
    const existing = lockedArtifactsByRef.get(artifactKey);
    if (existing && !existing.equals(bytes)) {
      throw new Error(`lockedEvidenceArtifacts[${index}] aliases different bytes at one ArtifactRef`);
    }
    lockedArtifactsByRef.set(artifactKey, bytes);
    evidenceRows.push({
      artifactDigest: row.artifactDigest,
      evidenceIri: row.evidenceIri,
      evidenceKind: row.evidenceKind,
    });
  }
  const readLockedArtifact = (artifactRef, label = 'artifactRef') => {
    const validation = validateArtifactRef(artifactRef, label);
    if (!validation.ok || artifactRef.kind !== 'path' || artifactRef.root !== 'sourceTree') {
      throw new Error(`${label} must be one locked sourceTree path ArtifactRef`);
    }
    const bytes = lockedArtifactsByRef.get(canonicalJcs(artifactRef));
    if (!bytes) throw new Error(`${label} is absent from SupportEvidenceClosure`);
    return bytes;
  };
  const evidence = validateMaterializedCustom({
    ...input,
    lockedEvidence,
    readLockedArtifact,
    moduleDocuments: modules.map((entry) => entry.document),
  });
  evidence.lockedEvidence = evidenceRows;
  evidence.modules = modules.map((entry) => ({
    moduleIri: entry.moduleIri,
    sourceDigest: entry.sourceDigest,
  }));
  // Prove that validation did not mutate any source ontology bytes.
  modules.forEach((entry) => {
    const after = readFile(entry.file, entry.moduleIri);
    if (!after.equals(entry.bytes)) {
      throw new Error('ontology module changed while Custom validation was executing');
    }
  });
  process.stdout.write(canonicalJcs(evidence));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
