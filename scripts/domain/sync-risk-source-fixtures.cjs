#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  authenticateSourceClaims,
  validateAuthenticatedSourceArtifacts,
} = require('./lib/post-trade-risk-source-artifact-inventory.cjs');
const {
  TYPES,
} = require('./lib/risk-canonical-record-adapter.cjs');
const {
  approvalDecisionDigest,
} = require('./lib/risk-v03-contract.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const POSITIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'risk-v03.yaml');
const NEGATIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'risk-v03.yaml');
const IMPLEMENTATION_FILE = path.join(ROOT, 'scripts', 'domain', 'lib', 'risk-v03-contract.cjs');
const INPUT_CONTRACT_FILE = path.join(
  ROOT,
  'scripts',
  'domain',
  'risk-custom-profile',
  'v0.3.0',
  'input-contract.json',
);
const OUTPUT_CONTRACT_FILE = path.join(
  ROOT,
  'scripts',
  'domain',
  'risk-custom-profile',
  'v0.3.0',
  'output-contract.json',
);
const RETRACTION_EVIDENCE_REL = 'tests/m2/fixtures/risk-measurement-retraction-v1.json';
const RETRACTION_EVIDENCE_FILE = path.join(ROOT, ...RETRACTION_EVIDENCE_REL.split('/'));
const WHOLE_FILE_PROFILE_REL = 'scripts/domain/reference-extractors/whole-file-v1.json';
const WHOLE_FILE_PROFILE_FILE = path.join(ROOT, ...WHOLE_FILE_PROFILE_REL.split('/'));
const BUCKET_KEY_CONTRACT_REL = 'tests/m2/fixtures/risk-bucket-key-contract-v1.json';
const BUCKET_KEY_CONTRACT_FILE = path.join(ROOT, ...BUCKET_KEY_CONTRACT_REL.split('/'));
const REPEATED_BYTE_DIGEST = /^sha256:([0-9a-f]{2})\1{31}$/u;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function refreshExecutableArtifactDigests(instance) {
  const result = structuredClone(instance);
  const definition = result.records.find((record) => record.typeIri === TYPES.definition);
  if (!definition) throw new Error('risk fixture has no RiskMeasureDefinition record');
  for (const [role, field, file] of [
    ['implementation', 'implementationDigest', IMPLEMENTATION_FILE],
    ['inputContract', 'inputContractDigest', INPUT_CONTRACT_FILE],
    ['outputContract', 'outputContractDigest', OUTPUT_CONTRACT_FILE],
  ]) {
    const digest = sha256(fs.readFileSync(file));
    definition[field] = digest;
    const artifact = result.artifactRecords.find((record) => record.artifactRole === role);
    if (!artifact) throw new Error(`risk fixture lacks ${role} artifact record`);
    artifact.artifactDigest = digest;
  }
  for (const artifact of result.artifactRecords) {
    if (artifact.artifactRole === 'definitionSource') delete artifact.sourceLocator;
  }
  const implementationDigest = sha256(fs.readFileSync(IMPLEMENTATION_FILE));
  const bucketKeyContractDigest = sha256(fs.readFileSync(BUCKET_KEY_CONTRACT_FILE));
  for (const record of result.records) {
    if (record.typeIri === TYPES.limit) {
      record.approvalDecisionDigest = approvalDecisionDigest(record);
    } else if (record.typeIri === TYPES.evaluation) {
      record.evaluatorDigest = implementationDigest;
    } else if (record.typeIri === TYPES.bucketSchema) {
      record.bucketKeyContractDigest = bucketKeyContractDigest;
    }
  }
  const retractionBytes = fs.readFileSync(RETRACTION_EVIDENCE_FILE);
  const profileDigest = sha256(fs.readFileSync(WHOLE_FILE_PROFILE_FILE));
  for (const evidence of result.evidenceRecords) {
    const locator = {
      extractorProfileDigest: profileDigest,
      extractorProfileRef: {
        kind: 'path',
        path: WHOLE_FILE_PROFILE_REL,
        root: 'sourceTree',
      },
      kind: 'wholeFile',
      mediaType: 'application/json',
      path: RETRACTION_EVIDENCE_REL,
      selectionDigest: `sha256:${'0'.repeat(64)}`,
    };
    locator.selectionDigest = computeSelectionDigest(locator, retractionBytes);
    evidence.artifactDigest = sha256(retractionBytes);
    evidence.artifactRef = {
      kind: 'path',
      path: RETRACTION_EVIDENCE_REL,
      root: 'sourceTree',
    };
    evidence.sourceLocator = locator;
  }
  return result;
}

function migratePositiveDocument(document) {
  if (!document || !Array.isArray(document.fixtures) || document.fixtures.length === 0) {
    throw new Error('risk positive fixture document has no fixtures');
  }
  const result = {
    schemaVersion: 1,
    queryPivot: structuredClone(document.queryPivot),
    fixtures: document.fixtures.map((fixture) => {
      const instance = authenticateSourceClaims(
        refreshExecutableArtifactDigests(fixture.instance),
        { namespace: 'risk-source' },
      );
      validateAuthenticatedSourceArtifacts(instance);
      return {
        id: fixture.id,
        expectedResult: fixture.expectedResult,
        instance,
      };
    }),
  };
  return result;
}

function collectPlaceholderFindings(value, at = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectPlaceholderFindings(entry, `${at}/${index}`, findings));
    return findings;
  }
  if (!value || typeof value !== 'object') return findings;
  for (const [key, child] of Object.entries(value)) {
    const childAt = `${at}/${key}`;
    if (typeof child === 'string'
        && child.startsWith('sha256:')
        && REPEATED_BYTE_DIGEST.test(child)) {
      findings.push(`${childAt}: repeated-byte placeholder digest`);
    }
    if (key === 'sourceLocator'
        && (child === null || typeof child !== 'object' || Array.isArray(child))) {
      findings.push(`${childAt}: scalar sourceLocator`);
    }
    collectPlaceholderFindings(child, childAt, findings);
  }
  return findings;
}

function validateNegativeDocument(document) {
  if (!document || !Array.isArray(document.cases) || document.cases.length === 0) {
    throw new Error('risk negative fixture document has no cases');
  }
  const findings = collectPlaceholderFindings(document);
  if (findings.length !== 0) {
    throw new Error(`risk negative fixture contains placeholder evidence: ${findings.join('; ')}`);
  }
  for (const testCase of document.cases) {
    for (const mutation of testCase.mutations || []) {
      if (/(?:^|\.)sourceLocator$/u.test(mutation.path)
          && (mutation.value === null || typeof mutation.value !== 'object')) {
        if (testCase.expectedViolation !== 'definition-provenance') {
          throw new Error(`${testCase.id} has an unattributed scalar sourceLocator mutation`);
        }
      }
    }
  }
}

function expectedPositiveDocument() {
  return migratePositiveDocument(YAML.parse(fs.readFileSync(POSITIVE_FILE, 'utf8')));
}

function check() {
  const actual = YAML.parse(fs.readFileSync(POSITIVE_FILE, 'utf8'));
  const expected = migratePositiveDocument(actual);
  const findings = collectPlaceholderFindings(actual);
  if (findings.length !== 0) {
    throw new Error(`risk positive fixture contains placeholder evidence: ${findings.join('; ')}`);
  }
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error('risk positive fixture source evidence is not synchronized');
  }
  validateNegativeDocument(YAML.parse(fs.readFileSync(NEGATIVE_FILE, 'utf8')));
  return actual.fixtures.length;
}

function write() {
  const expected = expectedPositiveDocument();
  fs.writeFileSync(POSITIVE_FILE, YAML.stringify(expected, { lineWidth: 0 }), 'utf8');
  return check();
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const fixtureCount = mode === 'write' ? write() : check();
  console.log(`Risk source fixtures: PASS (${mode}, ${fixtureCount} positive fixtures)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Risk source fixtures: FAIL (${error.message})`);
    process.exitCode = 1;
  }
}

module.exports = {
  REPEATED_BYTE_DIGEST,
  collectPlaceholderFindings,
  migratePositiveDocument,
  refreshExecutableArtifactDigests,
  validateNegativeDocument,
};
