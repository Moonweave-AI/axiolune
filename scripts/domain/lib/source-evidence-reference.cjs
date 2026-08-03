'use strict';

const crypto = require('node:crypto');
const {
  canonicalJcs,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const { validateSemanticReviewDecision } = require('./authority-decision.cjs');

const REFERENCE_EVIDENCE_BASE = 'https://axiolune.ai/references/';
const PENDING_SOURCE_EVIDENCE_BASE = 'https://axiolune.ai/pending-source-evidence/';
const CODE_LIST_AUTHORITY_REFERENCE_ID = 'axiolune-m2-controlled-vocabularies';
const CODE_LIST_AUTHORITY_REFERENCE_IRI =
  `${REFERENCE_EVIDENCE_BASE}${CODE_LIST_AUTHORITY_REFERENCE_ID}`;
const CODE_LIST_AUTHORITY_LOCAL_PATH =
  'reference/ontology-design-reference/axiolune-controlled-vocabularies';
const CODE_LIST_AUTHORITY_FILE_NAME = 'm2-v0.3-code-lists.json';
const PAYWALLED_SENTINEL = 'sha256:unavailable-paywalled';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const ASCII_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ABSOLUTE_IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/u;
const CODE_LIST_AUTHORITY_TAG = Buffer.from(
  'axiolune-code-list-authority-candidate-v1\0',
  'utf8',
);
const CODE_LIST_AUTHORITY_KINDS = new Set([
  'externalExact',
  'externalAdapted',
  'implementationAdopted',
  'axioluneComposite',
  'axioluneOperational',
]);
const UPSTREAM_USAGES = new Set(['normative', 'implementation', 'contextual']);
const UPSTREAM_TRANSFORMATIONS = new Set([
  'exactIdentity',
  'caseNormalizedSubset',
  'adaptedComposite',
  'contextOnly',
]);
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isAbsoluteIri(value) {
  return typeof value === 'string'
    && ABSOLUTE_IRI_RE.test(value)
    && value === value.normalize('NFC');
}

function isCanonicalText(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value === value.normalize('NFC');
}

function exactFields(value, fields, at, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${at} must be an object`);
    return false;
  }
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    errors.push(`${at} fields must equal ${expected.join(', ')}`);
    return false;
  }
  return true;
}

function digestCandidate(profileRef, snapshotVersion, entries) {
  const hash = crypto.createHash('sha256');
  hash.update(CODE_LIST_AUTHORITY_TAG);
  hash.update(Buffer.from(canonicalJcs({
    profileRef,
    snapshotVersion,
    entries,
  }), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareCanonical(left, right) {
  return utf8Compare(canonicalJcs(left), canonicalJcs(right));
}

function isWholeSecondUtcInstant(value) {
  const match = typeof value === 'string' ? INSTANT_RE.exec(value) : null;
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const [y, m, d, h, min, s] = [year, month, day, hour, minute, second].map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59) {
    return false;
  }
  const instant = new Date(0);
  instant.setUTCFullYear(y, m - 1, d);
  instant.setUTCHours(h, min, s, 0);
  return instant.getUTCFullYear() === y
    && instant.getUTCMonth() === m - 1
    && instant.getUTCDate() === d
    && instant.getUTCHours() === h
    && instant.getUTCMinutes() === min
    && instant.getUTCSeconds() === s;
}

function validateMember(member, at, errors) {
  const fields = ['definition', 'iri', 'label', 'notation'];
  if (member && member.deprecated !== undefined) fields.push('deprecated');
  if (member && member.replacedBy !== undefined) fields.push('replacedBy');
  if (member && member.sourceEvidenceRef !== undefined) fields.push('sourceEvidenceRef');
  if (!exactFields(member, fields, at, errors)) return;
  for (const field of ['definition', 'label', 'notation']) {
    if (!isCanonicalText(member[field])) {
      errors.push(`${at}.${field} must be non-empty NFC text without control characters`);
    }
  }
  if (!isAbsoluteIri(member.iri)) {
    errors.push(`${at}.iri must be an absolute IRI`);
  }
  if (member.deprecated !== undefined && typeof member.deprecated !== 'boolean') {
    errors.push(`${at}.deprecated must be boolean`);
  }
  if (member.replacedBy !== undefined
      && !isAbsoluteIri(member.replacedBy)) {
    errors.push(`${at}.replacedBy must be an absolute IRI`);
  }
  if (member.sourceEvidenceRef !== undefined
      && !isAbsoluteIri(member.sourceEvidenceRef)) {
    errors.push(`${at}.sourceEvidenceRef must be an absolute IRI`);
  }
}

function isProjectImplementationReference(reference) {
  return isPlainObject(reference)
    && typeof reference.localPath === 'string'
    && reference.localPath.replaceAll('\\', '/').startsWith('reference/project-reference/');
}

function validateImplementationEvidencePolicy(evidence, reference, at, errors) {
  if (!isPlainObject(evidence)) return;
  if (evidence.usage === 'normative' && evidence.transformation === 'contextOnly') {
    errors.push(
      `${at} normative evidence cannot use transformation=contextOnly; `
      + 'context-only evidence does not authorize canonical vocabulary semantics',
    );
  }
  if (evidence.usage === 'implementation' && evidence.transformation !== 'contextOnly') {
    errors.push(
      `${at} implementation evidence must use transformation=contextOnly; `
      + 'an implementation cannot define or map canonical M2 vocabulary',
    );
  }
  if (isProjectImplementationReference(reference)
      && (evidence.usage !== 'implementation' || evidence.transformation !== 'contextOnly')) {
    errors.push(
      `${at} project-reference evidence must be implementation/contextOnly; `
      + 'M2-PLAN forbids project internals from becoming normative vocabulary authority',
    );
  }
}

function validateUpstreamEvidence(evidence, at, referenceEntries, errors) {
  if (!exactFields(
    evidence,
    ['locator', 'rationale', 'referenceId', 'transformation', 'usage'],
    at,
    errors,
  )) return;
  if (typeof evidence.referenceId !== 'string' || !ASCII_ID_RE.test(evidence.referenceId)) {
    errors.push(`${at}.referenceId must be an ASCII reference identifier`);
  }
  if (!UPSTREAM_USAGES.has(evidence.usage)) {
    errors.push(`${at}.usage must be one of ${[...UPSTREAM_USAGES].join(', ')}`);
  }
  if (!UPSTREAM_TRANSFORMATIONS.has(evidence.transformation)) {
    errors.push(`${at}.transformation must be one of ${[...UPSTREAM_TRANSFORMATIONS].join(', ')}`);
  }
  if (!isCanonicalText(evidence.rationale)) {
    errors.push(`${at}.rationale must be non-empty NFC text without control characters`);
  }
  if (!isPlainObject(evidence.locator)) {
    errors.push(`${at}.locator must be a strict SourceLocator object`);
    return;
  }
  errors.push(...validateSourceLocator(evidence.locator, {
    at: `${at}.locator`,
  }).errors);
  const reference = referenceEntries.get(`${REFERENCE_EVIDENCE_BASE}${evidence.referenceId}`);
  if (!reference) {
    errors.push(`${at}.referenceId does not resolve to one locked reference`);
    return;
  }
  validateImplementationEvidencePolicy(evidence, reference, at, errors);
  let locatorKey;
  try {
    locatorKey = canonicalJcs(evidence.locator);
  } catch (cause) {
    errors.push(`${at}.locator is not canonicalizable: ${cause.message}`);
    return;
  }
  const lockedLocators = Array.isArray(reference.locators) ? reference.locators : [];
  if (!lockedLocators.some((locator) => {
    try {
      return canonicalJcs(locator) === locatorKey;
    } catch {
      return false;
    }
  })) {
    errors.push(`${at}.locator is not byte-identical to a locator in references.lock.yaml`);
  }
}

/**
 * Compile the digest-bound, semantically reviewed code-list authority snapshot
 * into a lookup. This state is release-candidate evidence, not terminal
 * release adoption.
 *
 * The snapshot is intentionally separate from references.lock.yaml. A lock
 * proves immutable bytes; this manifest proves which exact code-list/member
 * set those bytes authorize. Without both closures, a broad FIBO or project
 * lock must not be treated as evidence for an arbitrary local enumeration.
 */
function buildCodeListAuthorityIndex(manifest, referenceEntries = new Map()) {
  const errors = [];
  const entries = new Map();
  let decisionStatus = 'missing';
  if (!exactFields(
    manifest,
    [
      'candidateDigest',
      'decision',
      'entries',
      'profileRef',
      'schemaVersion',
      'snapshotVersion',
    ],
    'code-list-authority-manifest.json',
    errors,
  )) {
    return { entries, errors, decisionStatus };
  }
  if (manifest.schemaVersion !== '1.0') {
    errors.push('code-list-authority-manifest.json.schemaVersion must equal 1.0');
  }
  if (!isAbsoluteIri(manifest.profileRef)) {
    errors.push('code-list-authority-manifest.json.profileRef must be an absolute IRI');
  }
  if (typeof manifest.snapshotVersion !== 'string'
      || !/^\d+\.\d+\.\d+$/u.test(manifest.snapshotVersion)) {
    errors.push('code-list-authority-manifest.json.snapshotVersion must be SemVer');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push('code-list-authority-manifest.json.entries must be a non-empty array');
    return { entries, errors, decisionStatus };
  }
  let actualCandidateDigest;
  try {
    actualCandidateDigest = digestCandidate(
      manifest.profileRef,
      manifest.snapshotVersion,
      manifest.entries,
    );
  } catch (cause) {
    errors.push(`code-list-authority-manifest.json candidate is not canonicalizable: ${cause.message}`);
  }
  if (!SHA256_RE.test(manifest.candidateDigest || '')
      || (actualCandidateDigest && manifest.candidateDigest !== actualCandidateDigest)) {
    errors.push(
      `code-list-authority-manifest.json.candidateDigest must equal ${actualCandidateDigest || 'the tagged candidate digest'}`,
    );
  }

  if (!isPlainObject(manifest.decision)) {
    errors.push('code-list-authority-manifest.json.decision must be an object');
  } else if (manifest.decision.status === 'pending') {
    decisionStatus = 'pending';
    exactFields(
      manifest.decision,
      ['status'],
      'code-list-authority-manifest.json.decision',
      errors,
    );
  } else if (manifest.decision.status === 'reviewed'
      || manifest.decision.status === 'adopted') {
    try {
      decisionStatus = validateSemanticReviewDecision(
        manifest.decision,
        'code-list-authority-manifest.json.decision',
        actualCandidateDigest,
      );
    } catch (cause) {
      decisionStatus = `unverified-${manifest.decision.status}`;
      errors.push(cause.message);
    }
  } else {
    errors.push('code-list-authority-manifest.json.decision.status must be pending or reviewed');
  }

  let previousIri = null;
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    const at = `code-list-authority-manifest.json.entries[${index}]`;
    if (!exactFields(
      entry,
      [
        'authorityKind',
        'codeListIri',
        'codeListName',
        'members',
        'moduleId',
        'rationale',
        'sourceEvidenceRef',
        'upstreamEvidence',
        'version',
      ],
      at,
      errors,
    )) continue;
    for (const field of ['codeListName', 'moduleId']) {
      if (typeof entry[field] !== 'string' || !ASCII_ID_RE.test(entry[field])) {
        errors.push(`${at}.${field} must be a non-empty ASCII identifier`);
      }
    }
    if (!isAbsoluteIri(entry.codeListIri)) {
      errors.push(`${at}.codeListIri must be an absolute IRI`);
    }
    if (previousIri !== null
        && Buffer.compare(Buffer.from(previousIri), Buffer.from(entry.codeListIri || '')) >= 0) {
      errors.push(`${at}.codeListIri entries must be strictly IRI-byte sorted and unique`);
    }
    previousIri = entry.codeListIri;
    if (entries.has(entry.codeListIri)) {
      errors.push(`${at}.codeListIri duplicates ${entry.codeListIri}`);
    } else {
      entries.set(entry.codeListIri, entry);
    }
    if (typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(entry.version)) {
      errors.push(`${at}.version must be SemVer`);
    }
    if (!CODE_LIST_AUTHORITY_KINDS.has(entry.authorityKind)) {
      errors.push(`${at}.authorityKind is unsupported`);
    }
    if (!isCanonicalText(entry.rationale)) {
      errors.push(`${at}.rationale must be non-empty NFC text without control characters`);
    }
    if (typeof entry.sourceEvidenceRef !== 'string'
        || !entry.sourceEvidenceRef.startsWith(REFERENCE_EVIDENCE_BASE)) {
      errors.push(`${at}.sourceEvidenceRef must use the locked-reference namespace`);
    } else if (!referenceEntries.has(entry.sourceEvidenceRef)) {
      errors.push(`${at}.sourceEvidenceRef does not resolve to one locked reference`);
    } else if (entry.sourceEvidenceRef !== CODE_LIST_AUTHORITY_REFERENCE_IRI) {
      errors.push(
        `${at}.sourceEvidenceRef must select the exact internal authority snapshot `
        + CODE_LIST_AUTHORITY_REFERENCE_IRI,
      );
    } else {
      const authorityReference = referenceEntries.get(entry.sourceEvidenceRef);
      if (authorityReference.localPath !== CODE_LIST_AUTHORITY_LOCAL_PATH) {
        errors.push(
          `${at}.sourceEvidenceRef lock localPath must equal ${CODE_LIST_AUTHORITY_LOCAL_PATH}`,
        );
      }
      if (!Array.isArray(authorityReference.locators)
          || !authorityReference.locators.some(
            (locator) => isPlainObject(locator)
              && locator.path === CODE_LIST_AUTHORITY_FILE_NAME,
          )) {
        errors.push(
          `${at}.sourceEvidenceRef lock must locate ${CODE_LIST_AUTHORITY_FILE_NAME}`,
        );
      }
    }
    if (!Array.isArray(entry.members) || entry.members.length === 0) {
      errors.push(`${at}.members must be a non-empty array`);
    } else {
      const memberIris = new Set();
      const memberNotations = new Set();
      let previousMemberIri = null;
      for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
        const member = entry.members[memberIndex];
        const memberAt = `${at}.members[${memberIndex}]`;
        validateMember(member, memberAt, errors);
        if (memberIris.has(member.iri)) errors.push(`${memberAt}.iri is duplicated`);
        memberIris.add(member.iri);
        if (memberNotations.has(member.notation)) {
          errors.push(`${memberAt}.notation is duplicated within the code list`);
        }
        memberNotations.add(member.notation);
        if (previousMemberIri !== null
            && Buffer.compare(Buffer.from(previousMemberIri), Buffer.from(member.iri || '')) >= 0) {
          errors.push(`${memberAt}.iri members must be strictly IRI-byte sorted and unique`);
        }
        previousMemberIri = member.iri;
      }
    }
    if (!Array.isArray(entry.upstreamEvidence)) {
      errors.push(`${at}.upstreamEvidence must be an array`);
    } else {
      for (let evidenceIndex = 1;
        evidenceIndex < entry.upstreamEvidence.length;
        evidenceIndex += 1) {
        if (compareCanonical(
          entry.upstreamEvidence[evidenceIndex - 1],
          entry.upstreamEvidence[evidenceIndex],
        ) >= 0) {
          errors.push(`${at}.upstreamEvidence must be strictly JCS-sorted and unique`);
          break;
        }
      }
      for (let evidenceIndex = 0; evidenceIndex < entry.upstreamEvidence.length; evidenceIndex += 1) {
        validateUpstreamEvidence(
          entry.upstreamEvidence[evidenceIndex],
          `${at}.upstreamEvidence[${evidenceIndex}]`,
          referenceEntries,
          errors,
        );
      }
      if (entry.authorityKind === 'externalExact'
          && !entry.upstreamEvidence.some(
            (evidence) => evidence.usage === 'normative'
              && evidence.transformation === 'exactIdentity',
          )) {
        errors.push(`${at} externalExact authority requires normative exactIdentity upstream evidence`);
      }
      if (entry.authorityKind === 'externalExact') {
        const exactResourceIris = new Set(entry.upstreamEvidence
          .filter((evidence) => evidence.usage === 'normative'
            && evidence.transformation === 'exactIdentity'
            && evidence.locator
            && evidence.locator.kind === 'rdfResource'
            && typeof evidence.locator.resourceIri === 'string')
          .map((evidence) => evidence.locator.resourceIri));
        const unboundMembers = Array.isArray(entry.members)
          ? entry.members.filter((member) => !exactResourceIris.has(member.iri))
          : [];
        if (unboundMembers.length > 0) {
          errors.push(
            `${at} externalExact authority requires one normative exactIdentity rdfResource `
            + 'whose resourceIri equals each authored member IRI; local aliases or adapted '
            + 'labels/definitions must use externalAdapted',
          );
        }
      }
      if (entry.authorityKind === 'externalAdapted'
          && !entry.upstreamEvidence.some((evidence) => evidence.usage === 'normative')) {
        errors.push(`${at} externalAdapted authority requires normative upstream evidence`);
      }
      if (entry.authorityKind === 'implementationAdopted') {
        errors.push(
          `${at} implementationAdopted authority is prohibited by M2-PLAN; `
          + 'implementation projects may supply contextOnly evidence, never canonical vocabulary authority',
        );
      }
      if (entry.authorityKind === 'axioluneComposite'
          && entry.upstreamEvidence.length < 2) {
        errors.push(`${at} axioluneComposite authority requires at least two upstream evidence records`);
      }
    }
  }
  return {
    entries,
    errors,
    decisionStatus,
    candidateDigest: actualCandidateDigest,
  };
}

function comparableMember(member) {
  const result = {
    iri: member.iri,
    notation: member.notation,
    label: member.label,
    definition: member.definition,
  };
  if (member.deprecated !== undefined) result.deprecated = member.deprecated;
  if (member.replacedBy !== undefined) result.replacedBy = member.replacedBy;
  if (member.sourceEvidenceRef !== undefined) {
    result.sourceEvidenceRef = member.sourceEvidenceRef;
  }
  return result;
}

function validateCodeListAuthority(codeList, context) {
  const errors = [];
  const authorityState = context && context.authorityState;
  if (!authorityState || !(authorityState.entries instanceof Map)) {
    return ['has no machine-readable code-list authority manifest'];
  }
  if (Array.isArray(authorityState.errors) && authorityState.errors.length > 0) {
    return [
      `code-list authority manifest is invalid (${authorityState.errors.length} validation error(s))`,
    ];
  }
  if (authorityState.decisionStatus !== 'reviewed') {
    errors.push(
      `code-list authority snapshot is ${authorityState.decisionStatus || 'missing'}, not semantically reviewed`,
    );
  }
  const entry = authorityState.entries.get(codeList && codeList.iri);
  if (!entry) return [...errors, 'has no exact code-list authority entry'];
  if (entry.moduleId !== context.moduleId) {
    errors.push(`authority entry moduleId ${entry.moduleId} does not equal ${context.moduleId}`);
  }
  if (entry.codeListName !== context.codeListName) {
    errors.push(
      `authority entry codeListName ${entry.codeListName} does not equal ${context.codeListName}`,
    );
  }
  if (entry.version !== codeList.version) {
    errors.push(`authority entry version ${entry.version} does not equal ${codeList.version}`);
  }
  if (entry.sourceEvidenceRef !== codeList.sourceEvidenceRef) {
    errors.push('authority entry sourceEvidenceRef does not equal the authored code-list reference');
  }
  const authoredMembers = (Array.isArray(codeList.values) ? codeList.values : [])
    .map(comparableMember)
    .sort((left, right) => Buffer.compare(Buffer.from(left.iri || ''), Buffer.from(right.iri || '')));
  let authorityMembers;
  try {
    authorityMembers = [...entry.members]
      .map(comparableMember)
      .sort((left, right) => Buffer.compare(Buffer.from(left.iri || ''), Buffer.from(right.iri || '')));
    if (canonicalJcs(authoredMembers) !== canonicalJcs(authorityMembers)) {
      errors.push('authored member set/definitions do not equal the reviewed authority snapshot');
    }
  } catch (cause) {
    errors.push(`cannot compare exact authority members: ${cause.message}`);
  }
  return errors;
}

function buildReferenceEvidenceIndex(lock) {
  const errors = [];
  const entries = new Map();
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)
      || !Array.isArray(lock.references)) {
    return {
      entries,
      errors: ['references.lock.yaml must contain a references array'],
    };
  }

  for (let index = 0; index < lock.references.length; index += 1) {
    const reference = lock.references[index];
    const at = `references[${index}]`;
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (typeof reference.id !== 'string' || !ASCII_ID_RE.test(reference.id)) {
      errors.push(`${at}.id must be a non-empty ASCII reference identifier`);
      continue;
    }
    const evidenceIri = `${REFERENCE_EVIDENCE_BASE}${reference.id}`;
    if (entries.has(evidenceIri)) {
      errors.push(`${at}.id duplicates ${reference.id}`);
      continue;
    }
    entries.set(evidenceIri, reference);
  }
  return { entries, errors };
}

function validateLockedSourceEvidenceRef(value, entries, context = undefined) {
  if (typeof value !== 'string' || value.length === 0) {
    return ['must be a non-empty source-evidence IRI'];
  }
  if (value.startsWith(PENDING_SOURCE_EVIDENCE_BASE)) {
    return ['is unresolved pending evidence, not a locked source reference'];
  }
  if (!value.startsWith(REFERENCE_EVIDENCE_BASE)) {
    return [`must use the canonical locked-reference namespace ${REFERENCE_EVIDENCE_BASE}`];
  }
  const reference = entries.get(value);
  if (!reference) {
    return ['does not resolve to exactly one references.lock.yaml record'];
  }
  if (reference.artifactDigest === PAYWALLED_SENTINEL) {
    return ['resolves only to unavailable paywalled evidence and cannot prove a release code list'];
  }
  if (typeof reference.artifactDigest !== 'string'
      || !SHA256_RE.test(reference.artifactDigest)
      || /^sha256:0{64}$/u.test(reference.artifactDigest)) {
    return ['resolves to a reference without a valid non-placeholder SHA-256 artifact digest'];
  }
  if (!Array.isArray(reference.locators) || reference.locators.length === 0) {
    return ['resolves to a reference without a locked SourceLocator'];
  }
  const locatorErrors = reference.locators.flatMap((locator, index) => (
    validateSourceLocator(locator, {
      at: `reference(${reference.id}).locators[${index}]`,
    }).errors
  ));
  if (locatorErrors.length > 0) {
    return [
      'resolves to a reference with an invalid locked SourceLocator: '
      + locatorErrors.join('; '),
    ];
  }
  if (context && context.codeList) {
    return validateCodeListAuthority(context.codeList, context);
  }
  return [];
}

module.exports = {
  CODE_LIST_AUTHORITY_FILE_NAME,
  CODE_LIST_AUTHORITY_KINDS,
  CODE_LIST_AUTHORITY_LOCAL_PATH,
  CODE_LIST_AUTHORITY_REFERENCE_ID,
  CODE_LIST_AUTHORITY_REFERENCE_IRI,
  CODE_LIST_AUTHORITY_TAG,
  PENDING_SOURCE_EVIDENCE_BASE,
  REFERENCE_EVIDENCE_BASE,
  buildCodeListAuthorityIndex,
  buildReferenceEvidenceIndex,
  digestCandidate,
  isProjectImplementationReference,
  validateCodeListAuthority,
  validateImplementationEvidencePolicy,
  validateLockedSourceEvidenceRef,
};
