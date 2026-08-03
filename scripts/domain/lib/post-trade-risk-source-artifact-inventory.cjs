'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractJsonPointerJcsBytes,
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXTRACTOR_PROFILE_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'reference-extractors',
  'json-pointer-jcs-v1.json',
);
const EXTRACTOR_PROFILE_REF = Object.freeze({
  kind: 'path',
  path: 'scripts/domain/reference-extractors/json-pointer-jcs-v1.json',
  root: 'sourceTree',
});
const EXTRACTOR_PROFILE_DIGEST = sha256(fs.readFileSync(EXTRACTOR_PROFILE_PATH));
const ARTIFACT_FIELDS = Object.freeze([
  'artifactDigest',
  'artifactPath',
  'artifactRef',
  'extractorProfileDigest',
  'extractorProfileRef',
  'mediaType',
  'rawBytesBase64',
]);
const SOURCE_FIELDS = Object.freeze([
  'sourceArtifactDigest',
  'sourceArtifactRef',
  'sourceLocator',
]);

class SourceArtifactInventoryError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SourceArtifactInventoryError';
    this.code = code;
  }
}

function fail(code, detail) {
  throw new SourceArtifactInventoryError(code, detail);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, at) {
  if (!isPlainObject(value)) fail('source-artifact-schema', `${at} must be an object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...fields].sort(compareUtf8);
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    fail(
      'source-artifact-schema',
      `${at} fields differ: expected ${expected.join(',')}, got ${actual.join(',')}`,
    );
  }
}

function normalizeArtifactRef(value, at) {
  const normalized = typeof value === 'string'
    ? { kind: 'iri', iri: value }
    : structuredClone(value);
  const validation = validateArtifactRef(normalized, at);
  if (!validation.ok) fail('source-artifact-ref', validation.errors.join('; '));
  return normalized;
}

function pointerToken(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function collectSourceClaims(root) {
  const claims = [];

  function visit(value, at) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${at}/${index}`));
      return;
    }
    if (at === '$/artifacts') return;
    const hasAnyClaimField = Object.hasOwn(value, 'sourceArtifactDigest')
      || Object.hasOwn(value, 'sourceArtifactRef');
    if (hasAnyClaimField) {
      const present = SOURCE_FIELDS.filter((field) => Object.hasOwn(value, field));
      if (present.length !== SOURCE_FIELDS.length) {
        fail(
          'source-artifact-pair',
          `${at} must carry sourceArtifactRef/sourceArtifactDigest/sourceLocator together`,
        );
      }
      claims.push({ at, record: value });
    }
    for (const key of Object.keys(value).sort(compareUtf8)) {
      if (key !== 'artifacts') visit(value[key], `${at}/${pointerToken(key)}`);
    }
  }

  visit(root, '$');
  return claims;
}

function stripSourceEvidence(value) {
  if (Array.isArray(value)) return value.map(stripSourceEvidence);
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    if (SOURCE_FIELDS.includes(key) || key === 'artifacts') continue;
    result[key] = stripSourceEvidence(value[key]);
  }
  return result;
}

function strictBase64(value, at) {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail('source-artifact-bytes', `${at} must be non-empty canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    fail('source-artifact-bytes', `${at} is not canonical base64`);
  }
  return bytes;
}

function authenticateSourceClaims(document, options = {}) {
  if (!isPlainObject(document)) fail('source-artifact-document', 'document must be an object');
  const namespace = options.namespace || 'canonical-source';
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(namespace)) {
    fail('source-artifact-namespace', namespace);
  }
  const result = structuredClone(document);
  delete result.artifacts;
  const claims = collectSourceClaims(result);
  const groups = new Map();
  for (const claim of claims) {
    const artifactRef = normalizeArtifactRef(
      claim.record.sourceArtifactRef,
      `${claim.at}/sourceArtifactRef`,
    );
    const key = canonicalJcs(artifactRef);
    const rows = groups.get(key) || { artifactRef, claims: [] };
    rows.claims.push(claim);
    groups.set(key, rows);
  }

  const artifacts = [];
  for (const [refKey, group] of [...groups.entries()].sort((left, right) => compareUtf8(left[0], right[0]))) {
    group.claims.sort((left, right) => compareUtf8(left.at, right.at));
    const rawDocument = {
      claims: group.claims.map((claim) => stripSourceEvidence(claim.record)),
      schemaVersion: '1.0',
    };
    const rawBytes = Buffer.from(canonicalJcs(rawDocument), 'utf8');
    const artifactDigest = sha256(rawBytes);
    const refDigest = sha256(Buffer.from(refKey, 'utf8')).slice('sha256:'.length);
    const artifactPath = `embedded/${namespace}/${refDigest}.json`;
    const artifact = {
      artifactDigest,
      artifactPath,
      artifactRef: group.artifactRef,
      extractorProfileDigest: EXTRACTOR_PROFILE_DIGEST,
      extractorProfileRef: structuredClone(EXTRACTOR_PROFILE_REF),
      mediaType: 'application/json',
      rawBytesBase64: rawBytes.toString('base64'),
    };
    artifacts.push(artifact);

    group.claims.forEach((claim, index) => {
      const locator = {
        extractorProfileDigest: EXTRACTOR_PROFILE_DIGEST,
        extractorProfileRef: structuredClone(EXTRACTOR_PROFILE_REF),
        kind: 'jsonPointer',
        mediaType: 'application/json',
        path: artifactPath,
        pointer: `/claims/${index}`,
        selectionDigest: `sha256:${'0'.repeat(64)}`,
      };
      const selectedBytes = Buffer.from(canonicalJcs(rawDocument.claims[index]), 'utf8');
      locator.selectionDigest = computeSelectionDigest(locator, selectedBytes);
      claim.record.sourceArtifactDigest = artifactDigest;
      claim.record.sourceArtifactRef = structuredClone(group.artifactRef);
      claim.record.sourceLocator = locator;
    });
  }
  result.artifacts = artifacts;
  validateAuthenticatedSourceArtifacts(result);
  return result;
}

function validateAuthenticatedSourceArtifacts(document) {
  if (!isPlainObject(document) || !Array.isArray(document.artifacts)) {
    fail('source-artifact-inventory', 'document.artifacts must be an array');
  }
  const inventory = new Map();
  let previousRef = null;
  for (const [index, artifact] of document.artifacts.entries()) {
    const at = `artifacts[${index}]`;
    exactKeys(artifact, ARTIFACT_FIELDS, at);
    const artifactRef = normalizeArtifactRef(artifact.artifactRef, `${at}.artifactRef`);
    const refKey = canonicalJcs(artifactRef);
    if (previousRef !== null && compareUtf8(previousRef, refKey) >= 0) {
      fail('source-artifact-order', 'artifacts must be strictly ArtifactRef-sorted and unique');
    }
    previousRef = refKey;
    if (artifact.mediaType !== 'application/json'
        || canonicalJcs(artifact.extractorProfileRef) !== canonicalJcs(EXTRACTOR_PROFILE_REF)
        || artifact.extractorProfileDigest !== EXTRACTOR_PROFILE_DIGEST) {
      fail('source-artifact-profile', `${at} extractor/media binding drift`);
    }
    const rawBytes = strictBase64(artifact.rawBytesBase64, `${at}.rawBytesBase64`);
    if (artifact.artifactDigest !== sha256(rawBytes)) {
      fail('source-artifact-digest', `${at} raw-byte digest mismatch`);
    }
    let rawDocument;
    try {
      const text = rawBytes.toString('utf8');
      rawDocument = parseJsonRejectingDuplicateMembers(text);
      if (!rawBytes.equals(Buffer.from(canonicalJcs(rawDocument), 'utf8'))) {
        fail('source-artifact-jcs', `${at} raw bytes are not exact JCS`);
      }
    } catch (cause) {
      if (cause instanceof SourceArtifactInventoryError) throw cause;
      fail('source-artifact-jcs', `${at}: ${cause.message}`);
    }
    exactKeys(rawDocument, ['claims', 'schemaVersion'], `${at}.rawDocument`);
    if (rawDocument.schemaVersion !== '1.0'
        || !Array.isArray(rawDocument.claims)
        || rawDocument.claims.length === 0) {
      fail('source-artifact-jcs', `${at} raw document has no closed claims inventory`);
    }
    inventory.set(refKey, {
      artifact,
      rawBytes,
      rawClaimCount: rawDocument.claims.length,
      usedPointers: new Set(),
    });
  }

  const claims = collectSourceClaims(document);
  for (const claim of claims) {
    const artifactRef = normalizeArtifactRef(
      claim.record.sourceArtifactRef,
      `${claim.at}/sourceArtifactRef`,
    );
    const inventoryRow = inventory.get(canonicalJcs(artifactRef));
    if (!inventoryRow) {
      fail('source-artifact-join', `${claim.at} has no exactly matching artifact`);
    }
    if (claim.record.sourceArtifactDigest !== inventoryRow.artifact.artifactDigest) {
      fail('source-artifact-join', `${claim.at} digest does not match joined artifact bytes`);
    }
    const locator = claim.record.sourceLocator;
    const structural = validateSourceLocator(locator, { at: `${claim.at}/sourceLocator` });
    if (!structural.ok) fail('source-artifact-locator', structural.errors.join('; '));
    if (locator.kind !== 'jsonPointer'
        || locator.path !== inventoryRow.artifact.artifactPath
        || locator.mediaType !== inventoryRow.artifact.mediaType
        || canonicalJcs(locator.extractorProfileRef)
          !== canonicalJcs(inventoryRow.artifact.extractorProfileRef)
        || locator.extractorProfileDigest !== inventoryRow.artifact.extractorProfileDigest) {
      fail('source-artifact-locator', `${claim.at} locator/artifact profile join drift`);
    }
    if (inventoryRow.usedPointers.has(locator.pointer)) {
      fail('source-artifact-selection-duplicate', `${claim.at} reuses ${locator.pointer}`);
    }
    let selectedBytes;
    try {
      selectedBytes = extractJsonPointerJcsBytes(inventoryRow.rawBytes, locator.pointer);
    } catch (cause) {
      fail('source-artifact-selection', `${claim.at}: ${cause.message}`);
    }
    const selectedValidation = validateSourceLocator(locator, {
      at: `${claim.at}/sourceLocator`,
      selectedBytes,
    });
    if (!selectedValidation.ok) {
      fail('source-artifact-selection', selectedValidation.errors.join('; '));
    }
    const expectedSelectedBytes = Buffer.from(
      canonicalJcs(stripSourceEvidence(claim.record)),
      'utf8',
    );
    if (!selectedBytes.equals(expectedSelectedBytes)) {
      fail('source-artifact-selection', `${claim.at} selected bytes differ from the source payload`);
    }
    inventoryRow.usedPointers.add(locator.pointer);
  }

  for (const [refKey, row] of inventory) {
    if (row.usedPointers.size !== row.rawClaimCount) {
      fail(
        'source-artifact-coverage',
        `${refKey} has ${row.rawClaimCount} selected values but ${row.usedPointers.size} exact claims`,
      );
    }
  }
  if (claims.length === 0 && inventory.size !== 0) {
    fail('source-artifact-extra', 'artifact inventory is non-empty without source claims');
  }
  return { artifactCount: inventory.size, sourceClaimCount: claims.length };
}

module.exports = {
  ARTIFACT_FIELDS,
  EXTRACTOR_PROFILE_DIGEST,
  EXTRACTOR_PROFILE_PATH,
  EXTRACTOR_PROFILE_REF,
  SourceArtifactInventoryError,
  authenticateSourceClaims,
  collectSourceClaims,
  stripSourceEvidence,
  validateAuthenticatedSourceArtifacts,
};
