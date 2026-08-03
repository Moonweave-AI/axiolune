'use strict';

const { canonicalJcs } = require('./strict-source-locator.cjs');

const WHOLE_SECOND_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/u;
const TERMINAL_AUTHORITY_ADOPTION_UNAVAILABLE =
  'terminal authority adoption is unavailable: repository-edited adopted JSON is not '
  + 'DRI authority; a separately trusted terminal adoption verifier must bind the exact '
  + 'candidate digest, protected ref transition, post-ref checkout, dependency closure, '
  + 'and signed AdoptionAttestation';

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactFields(value, fields) {
  return canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...fields].sort());
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isAbsoluteCanonicalIri(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || hasUnpairedSurrogate(value)
      || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
}

function isWholeSecondUtcInstant(value) {
  const match = typeof value === 'string' ? WHOLE_SECOND_UTC_RE.exec(value) : null;
  if (!match) return false;
  const [year, month, day, hour, minute, second] = value
    .slice(0, -1)
    .split(/[-T:]/u)
    .map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31
      || hour > 23 || minute > 59 || second > 59) return false;
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  return instant.getUTCFullYear() === year
    && instant.getUTCMonth() === month - 1
    && instant.getUTCDate() === day
    && instant.getUTCHours() === hour
    && instant.getUTCMinutes() === minute
    && instant.getUTCSeconds() === second;
}

function validateDecisionBody(
  decision,
  label,
  expectedCandidateDigest,
  {
    actorField,
    status,
  },
) {
  const fields = [
    ...(expectedCandidateDigest === undefined ? [] : ['candidateDigest']),
    'decisionTime',
    actorField,
    'rationale',
    'reviewBasisRefs',
    'status',
  ];
  if (!exactFields(decision, fields)) {
    throw new Error(`${label} ${status} fields must equal ${fields.join(', ')}`);
  }
  if (expectedCandidateDigest !== undefined
      && (!SHA256_RE.test(expectedCandidateDigest)
        || !SHA256_RE.test(decision.candidateDigest || '')
        || decision.candidateDigest !== expectedCandidateDigest)) {
    throw new Error(
      `${label}.candidateDigest must equal the exact current candidate digest ${expectedCandidateDigest}`,
    );
  }
  if (!isAbsoluteCanonicalIri(decision[actorField])) {
    throw new Error(`${label}.${actorField} must be an absolute canonical IRI`);
  }
  if (!isWholeSecondUtcInstant(decision.decisionTime)) {
    throw new Error(`${label}.decisionTime must be a calendar-valid whole-second UTC instant`);
  }
  if (typeof decision.rationale !== 'string'
      || decision.rationale.trim() === ''
      || decision.rationale !== decision.rationale.normalize('NFC')
      || hasUnpairedSurrogate(decision.rationale)) {
    throw new Error(`${label}.rationale must be non-empty valid-Unicode NFC text`);
  }
  if (!Array.isArray(decision.reviewBasisRefs)
      || decision.reviewBasisRefs.length === 0
      || decision.reviewBasisRefs.some(
        (value) => !isAbsoluteCanonicalIri(value),
      )) {
    throw new Error(`${label}.reviewBasisRefs must be a non-empty canonical absolute-IRI array`);
  }
  for (let index = 1; index < decision.reviewBasisRefs.length; index += 1) {
    if (utf8Compare(
      decision.reviewBasisRefs[index - 1],
      decision.reviewBasisRefs[index],
    ) >= 0) {
      throw new Error(`${label}.reviewBasisRefs must be strictly UTF-8 sorted and unique`);
    }
  }
  return status;
}

/**
 * Validate a source-tree semantic-review decision. `reviewed` means only that
 * the exact candidate digest has received the recorded semantic review. It is
 * deliberately not a release/adoption result and carries no authority to move
 * a module or release from draft to approved. The terminal adoption verifier
 * remains the sole component allowed to establish that transition.
 */
function validateSemanticReviewDecision(
  decision,
  label = 'semantic review decision',
  expectedCandidateDigest = undefined,
) {
  if (!isPlainObject(decision)) throw new Error(`${label} must be an object`);
  if (decision.status === 'pending') {
    if (!exactFields(decision, ['status'])) {
      throw new Error(`${label} pending fields must equal status`);
    }
    return 'pending';
  }
  if (decision.status === 'adopted') {
    // Preserve the explicit diagnostic for legacy repository-only adoption
    // attempts; callers must never reinterpret those bytes as semantic review.
    return validateAuthorityDecision(decision, label, expectedCandidateDigest);
  }
  if (decision.status !== 'reviewed') {
    throw new Error(`${label}.status must be pending or reviewed`);
  }
  return validateDecisionBody(
    decision,
    label,
    expectedCandidateDigest,
    { actorField: 'reviewerRef', status: 'reviewed' },
  );
}

/**
 * Validate the shared, exact DRI-decision envelope used by the M2 authority
 * snapshots.  A pending decision carries no implied reviewer identity.  An
 * `status=adopted` is deliberately fail-closed.  The repository currently has
 * only a component verifier for adoption evidence; it explicitly returns
 * `not-terminally-verified`.  Consequently, accepting an adopted object from
 * repository bytes would let an attacker edit the object and recompute every
 * downstream lock/card.  A future terminal verifier must introduce a separate
 * unforgeable trust handle before this function can return `adopted`.
 */
function validateAuthorityDecision(
  decision,
  label = 'authority decision',
  expectedCandidateDigest = undefined,
) {
  if (!isPlainObject(decision)) throw new Error(`${label} must be an object`);
  if (decision.status === 'pending') {
    if (!exactFields(decision, ['status'])) {
      throw new Error(`${label} pending fields must equal status`);
    }
    return 'pending';
  }
  if (decision.status !== 'adopted') {
    throw new Error(`${label}.status must be pending or adopted`);
  }
  validateDecisionBody(
    decision,
    label,
    expectedCandidateDigest,
    { actorField: 'driRef', status: 'adopted' },
  );
  throw new Error(`${label}: ${TERMINAL_AUTHORITY_ADOPTION_UNAVAILABLE}`);
}

module.exports = {
  TERMINAL_AUTHORITY_ADOPTION_UNAVAILABLE,
  validateAuthorityDecision,
  validateSemanticReviewDecision,
};
