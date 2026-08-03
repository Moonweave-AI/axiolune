'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const FIELD_PRIME = (1n << 255n) - 19n;
const EDWARDS_D = mod(
  -121665n * modPow(121666n, FIELD_PRIME - 2n, FIELD_PRIME),
  FIELD_PRIME,
);
const SQRT_M1 = modPow(2n, (FIELD_PRIME - 1n) / 4n, FIELD_PRIME);
const DECISION_PAYLOAD_TAG = 'axiolune-promotion-authorization-payload-v1\0';
const DECISION_POLICY_TAG = 'axiolune-decision-trust-policy-v1\0';
const VERIFICATION_POLICY_TAG = 'axiolune-verification-trust-policy-v1\0';
const VERIFICATION_SCOPES = Object.freeze([
  'adoptionAttemptChallenge',
  'adoptionAttestation',
  'refUpdateReceipt',
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function rawDigestBytes(value, label) {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value);
  if (!match) throw new Error(`${label} must be a canonical sha256 digest`);
  return Buffer.from(match[1], 'hex');
}

function decodeBase64url(value, expectedLength, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} must be canonical unpadded base64url`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== expectedLength || bytes.toString('base64url') !== value) {
    throw new Error(`${label} must encode exactly ${expectedLength} bytes canonically`);
  }
  return bytes;
}

function littleEndianInteger(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

function mod(value, modulus) {
  const reduced = value % modulus;
  return reduced >= 0n ? reduced : reduced + modulus;
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let factor = mod(base, modulus);
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    remaining >>= 1n;
  }
  return result;
}

function decompressEd25519Point(bytes, label) {
  const yBytes = Buffer.from(bytes);
  const sign = yBytes[31] >>> 7;
  yBytes[31] &= 0x7f;
  const y = littleEndianInteger(yBytes);
  if (y >= FIELD_PRIME) {
    throw new Error(`${label} has a non-canonical field encoding`);
  }
  const y2 = mod(y * y, FIELD_PRIME);
  const numerator = mod(y2 - 1n, FIELD_PRIME);
  const denominator = mod(EDWARDS_D * y2 + 1n, FIELD_PRIME);
  if (denominator === 0n) throw new Error(`${label} is not an Edwards25519 point`);
  const x2 = mod(
    numerator * modPow(denominator, FIELD_PRIME - 2n, FIELD_PRIME),
    FIELD_PRIME,
  );
  let x = modPow(x2, (FIELD_PRIME + 3n) / 8n, FIELD_PRIME);
  if (mod(x * x - x2, FIELD_PRIME) !== 0n) {
    x = mod(x * SQRT_M1, FIELD_PRIME);
  }
  if (mod(x * x - x2, FIELD_PRIME) !== 0n) {
    throw new Error(`${label} is not an Edwards25519 point`);
  }
  if (x === 0n && sign === 1) {
    throw new Error(`${label} has a non-canonical x-sign encoding`);
  }
  if (Number(x & 1n) !== sign) x = mod(-x, FIELD_PRIME);
  return { x, y };
}

function doubleEd25519Point(point, label) {
  const { x, y } = point;
  const xx = mod(x * x, FIELD_PRIME);
  const yy = mod(y * y, FIELD_PRIME);
  const product = mod(EDWARDS_D * xx * yy, FIELD_PRIME);
  const xDenominator = mod(1n + product, FIELD_PRIME);
  const yDenominator = mod(1n - product, FIELD_PRIME);
  if (xDenominator === 0n || yDenominator === 0n) {
    throw new Error(`${label} produced an invalid Edwards25519 denominator`);
  }
  return {
    x: mod(
      2n * x * y * modPow(xDenominator, FIELD_PRIME - 2n, FIELD_PRIME),
      FIELD_PRIME,
    ),
    y: mod(
      (yy + xx) * modPow(yDenominator, FIELD_PRIME - 2n, FIELD_PRIME),
      FIELD_PRIME,
    ),
  };
}

function assertCanonicalPoint(bytes, label) {
  let multiplied = decompressEd25519Point(bytes, label);
  for (let index = 0; index < 3; index += 1) {
    multiplied = doubleEd25519Point(multiplied, label);
  }
  if (multiplied.x === 0n && multiplied.y === 1n) {
    throw new Error(`${label} is a forbidden small-order point`);
  }
}

function verifyPureEd25519({ publicKey, signature, messageDigest }) {
  const keyBytes = decodeBase64url(publicKey, 32, 'publicKey');
  const signatureBytes = decodeBase64url(signature, 64, 'signature');
  assertCanonicalPoint(keyBytes, 'publicKey');
  assertCanonicalPoint(signatureBytes.subarray(0, 32), 'signature R');
  if (littleEndianInteger(signatureBytes.subarray(32)) >= ED25519_ORDER) {
    throw new Error('signature S is non-canonical');
  }
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
    format: 'der',
    type: 'spki',
  });
  const message = rawDigestBytes(messageDigest, 'signedDigest');
  if (!crypto.verify(null, message, key, signatureBytes)) {
    throw new Error('pure Ed25519 verification failed');
  }
  return { publicKeyBytes: keyBytes, signatureBytes };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`${label} fields differ from the closed schema`);
  }
}

function instant(value, label) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC whole-second instant`);
  }
  return Date.parse(value);
}

function validateDecisionTrustPolicy(policy) {
  exactKeys(policy, ['schemaVersion', 'policyId', 'principals'], 'decision trust policy');
  if (policy.schemaVersion !== '1.0'
      || typeof policy.policyId !== 'string'
      || !/^[\x21-\x7e]+$/u.test(policy.policyId)
      || !Array.isArray(policy.principals)
      || policy.principals.length === 0) {
    throw new Error('decision trust policy identity/inventory is invalid');
  }
  const keyRefs = new Set();
  const keyBytesSeen = new Set();
  const fingerprints = new Set();
  let previousKey = null;
  for (let index = 0; index < policy.principals.length; index += 1) {
    const row = policy.principals[index];
    const allowed = [
      'driRef', 'keyRef', 'algorithm', 'publicKeyEncoding', 'publicKey',
      'publicKeyFingerprint', 'notBefore', 'status',
    ];
    if (Object.hasOwn(row || {}, 'notAfter')) allowed.push('notAfter');
    exactKeys(row, allowed, `decision trust policy principal ${index}`);
    if (row.algorithm !== 'Ed25519'
        || row.publicKeyEncoding !== 'base64url-nopad'
        || !['active', 'revoked'].includes(row.status)) {
      throw new Error(`decision trust policy principal ${index} has an invalid algorithm/status`);
    }
    const keyBytes = decodeBase64url(row.publicKey, 32, `principals/${index}/publicKey`);
    assertCanonicalPoint(keyBytes, `principals/${index}/publicKey`);
    if (row.publicKeyFingerprint !== sha256(keyBytes)) {
      throw new Error(`decision trust policy principal ${index} fingerprint differs from key bytes`);
    }
    const sortKey = `${row.driRef}\0${row.keyRef}`;
    if (previousKey !== null && Buffer.compare(Buffer.from(previousKey), Buffer.from(sortKey)) >= 0) {
      throw new Error('decision trust policy principals are not strictly sorted and unique');
    }
    previousKey = sortKey;
    if (keyRefs.has(row.keyRef) || keyBytesSeen.has(row.publicKey)
        || fingerprints.has(row.publicKeyFingerprint)) {
      throw new Error('decision trust policy contains a key alias or duplicate key material');
    }
    keyRefs.add(row.keyRef);
    keyBytesSeen.add(row.publicKey);
    fingerprints.add(row.publicKeyFingerprint);
    const notBefore = instant(row.notBefore, `principals/${index}/notBefore`);
    if (Object.hasOwn(row, 'notAfter')
        && instant(row.notAfter, `principals/${index}/notAfter`) <= notBefore) {
      throw new Error('decision trust policy has an empty/reversed validity interval');
    }
  }
  return taggedJcsDigest(DECISION_POLICY_TAG, policy);
}

function validateVerificationTrustPolicy(policy) {
  exactKeys(policy, ['schemaVersion', 'policyId', 'principals'], 'verification trust policy');
  if (policy.schemaVersion !== '1.0'
      || typeof policy.policyId !== 'string'
      || !/^[\x21-\x7e]+$/u.test(policy.policyId)
      || !Array.isArray(policy.principals)
      || policy.principals.length === 0) {
    throw new Error('verification trust policy identity/inventory is invalid');
  }

  const keyRefs = new Set();
  const keyBytesSeen = new Set();
  const fingerprints = new Set();
  let previousSortKey = null;
  for (let index = 0; index < policy.principals.length; index += 1) {
    const row = policy.principals[index];
    const fields = [
      'principalRef', 'keyRef', 'scope', 'repositoryId', 'authoritativeRef',
      'algorithm', 'publicKeyEncoding', 'publicKey', 'publicKeyFingerprint',
      'notBefore', 'status',
    ];
    if (Object.hasOwn(row || {}, 'notAfter')) fields.push('notAfter');
    exactKeys(row, fields, `verification trust policy principal ${index}`);
    if (!VERIFICATION_SCOPES.includes(row.scope)
        || typeof row.principalRef !== 'string' || row.principalRef.length === 0
        || typeof row.keyRef !== 'string' || row.keyRef.length === 0
        || typeof row.repositoryId !== 'string' || row.repositoryId.length === 0
        || typeof row.authoritativeRef !== 'string'
        || !/^refs\/[^\s]+$/u.test(row.authoritativeRef)
        || row.algorithm !== 'Ed25519'
        || row.publicKeyEncoding !== 'base64url-nopad'
        || !['active', 'revoked'].includes(row.status)) {
      throw new Error(`verification trust policy principal ${index} has an invalid scope, identity, algorithm, or status`);
    }

    const keyBytes = decodeBase64url(
      row.publicKey,
      32,
      `verification principals/${index}/publicKey`,
    );
    assertCanonicalPoint(keyBytes, `verification principals/${index}/publicKey`);
    if (row.publicKeyFingerprint !== sha256(keyBytes)) {
      throw new Error(`verification trust policy principal ${index} fingerprint differs from key bytes`);
    }
    const sortKey = [
      row.scope,
      row.principalRef,
      row.keyRef,
      row.repositoryId,
      row.authoritativeRef,
    ].join('\0');
    if (previousSortKey !== null
        && Buffer.compare(Buffer.from(previousSortKey), Buffer.from(sortKey)) >= 0) {
      throw new Error('verification trust policy principals are not strictly scope/principal/key/repository/ref sorted and unique');
    }
    previousSortKey = sortKey;

    if (keyRefs.has(row.keyRef) || keyBytesSeen.has(row.publicKey)
        || fingerprints.has(row.publicKeyFingerprint)) {
      throw new Error('verification trust policy contains a key alias or duplicate key material');
    }
    keyRefs.add(row.keyRef);
    keyBytesSeen.add(row.publicKey);
    fingerprints.add(row.publicKeyFingerprint);

    const notBefore = instant(row.notBefore, `verification principals/${index}/notBefore`);
    if (Object.hasOwn(row, 'notAfter')
        && instant(row.notAfter, `verification principals/${index}/notAfter`) <= notBefore) {
      throw new Error('verification trust policy has an empty/reversed validity interval');
    }
  }
  return taggedJcsDigest(VERIFICATION_POLICY_TAG, policy);
}

function verifyScopedEd25519Envelope(options) {
  const {
    envelope,
    envelopeLabel,
    payloadField,
    payloadDigestField,
    payloadTag,
    policy,
    expectedPolicyDigest,
    scope,
    principalRef,
    keyRef,
    publicKeyFingerprint,
    algorithm,
    repositoryId,
    authoritativeRef,
    signedAt,
  } = options;
  if (!VERIFICATION_SCOPES.includes(scope)) {
    throw new Error(`${envelopeLabel} has an unsupported verification signature scope`);
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error(`${envelopeLabel} must be an object`);
  }
  const payload = envelope[payloadField];
  const payloadDigest = taggedJcsDigest(payloadTag, payload);
  if (envelope[payloadDigestField] !== payloadDigest) {
    throw new Error(`${envelopeLabel} payload digest binding differs`);
  }
  exactKeys(
    envelope.signature,
    ['signedDigest', 'signatureEncoding', 'value'],
    `${envelopeLabel} signature`,
  );
  if (envelope.signature.signedDigest !== payloadDigest
      || envelope.signature.signatureEncoding !== 'base64url-nopad') {
    throw new Error(`${envelopeLabel} signature digest or encoding differs`);
  }

  const policyDigest = validateVerificationTrustPolicy(policy);
  if (expectedPolicyDigest !== policyDigest) {
    throw new Error(`${envelopeLabel} does not bind the independently trusted verification policy`);
  }
  const rows = policy.principals.filter((row) => (
    row.scope === scope
      && row.principalRef === principalRef
      && row.keyRef === keyRef
      && row.publicKeyFingerprint === publicKeyFingerprint
      && row.algorithm === algorithm
      && row.repositoryId === repositoryId
      && row.authoritativeRef === authoritativeRef
  ));
  if (rows.length !== 1) {
    throw new Error(`${envelopeLabel} signer tuple has no unique scoped policy row`);
  }
  const row = rows[0];
  const signatureTime = instant(signedAt, `${envelopeLabel} signedAt`);
  const active = row.status === 'active'
    && signatureTime >= instant(row.notBefore, `${envelopeLabel} policy notBefore`)
    && (!row.notAfter
      || signatureTime < instant(row.notAfter, `${envelopeLabel} policy notAfter`));
  if (!active) {
    throw new Error(`${envelopeLabel} signer is revoked or outside its validity window`);
  }
  verifyPureEd25519({
    publicKey: row.publicKey,
    signature: envelope.signature.value,
    messageDigest: payloadDigest,
  });
  return {
    payloadDigest,
    policyDigest,
    publicKeyFingerprint: row.publicKeyFingerprint,
    scope,
  };
}

function verifyPromotionAuthorization(authorization, policy, expected = {}) {
  exactKeys(
    authorization,
    ['schemaVersion', 'decisionPayload', 'decisionPayloadDigest', 'signature'],
    'PromotionAuthorization',
  );
  if (authorization.schemaVersion !== '1.0') {
    throw new Error('PromotionAuthorization schemaVersion must be 1.0');
  }
  const payloadFields = [
    'decisionType', 'decision', 'repositoryId', 'authoritativeRef',
    'expectedOldCommitId', 'gitObjectFormat', 'targetVersion', 'p0ManifestRef',
    'p0ManifestDigest', 'p0VerificationReportRef', 'p0VerificationReportDigest',
    'decisionTrustPolicyRef', 'decisionTrustPolicyDigest', 'driRef', 'keyRef',
    'publicKeyFingerprint', 'algorithm', 'authorizationTime', 'rationale',
  ];
  exactKeys(authorization.decisionPayload, payloadFields, 'PromotionAuthorization payload');
  exactKeys(
    authorization.signature,
    ['signedDigest', 'signatureEncoding', 'value'],
    'PromotionAuthorization signature',
  );
  const payload = authorization.decisionPayload;
  if (payload.decisionType !== 'promotionAuthorization'
      || payload.decision !== 'authorizeP1'
      || payload.algorithm !== 'Ed25519'
      || authorization.signature.signatureEncoding !== 'base64url-nopad') {
    throw new Error('PromotionAuthorization is not an authorizeP1 pure-Ed25519 decision');
  }
  const payloadDigest = taggedJcsDigest(DECISION_PAYLOAD_TAG, payload);
  if (authorization.decisionPayloadDigest !== payloadDigest
      || authorization.signature.signedDigest !== payloadDigest) {
    throw new Error('PromotionAuthorization payload/signed digest binding differs');
  }
  const policyDigest = validateDecisionTrustPolicy(policy);
  if (payload.decisionTrustPolicyDigest !== policyDigest
      || (expected.decisionTrustPolicyDigest
        && expected.decisionTrustPolicyDigest !== policyDigest)) {
    throw new Error('PromotionAuthorization does not bind the independently trusted policy');
  }
  const expectedFields = [
    'repositoryId', 'authoritativeRef', 'expectedOldCommitId', 'gitObjectFormat',
    'targetVersion', 'p0ManifestRef', 'p0ManifestDigest',
    'p0VerificationReportRef', 'p0VerificationReportDigest',
  ];
  for (const field of expectedFields) {
    if (Object.hasOwn(expected, field)
        && canonicalJcs(payload[field]) !== canonicalJcs(expected[field])) {
      throw new Error(`PromotionAuthorization ${field} differs from the reviewed P0 chain`);
    }
  }
  const decisionTime = instant(payload.authorizationTime, 'authorizationTime');
  const rows = policy.principals.filter((row) => (
    row.driRef === payload.driRef
      && row.keyRef === payload.keyRef
      && row.publicKeyFingerprint === payload.publicKeyFingerprint
      && row.algorithm === payload.algorithm
  ));
  if (rows.length !== 1) throw new Error('PromotionAuthorization key tuple has no unique policy row');
  const row = rows[0];
  const active = row.status === 'active'
    && decisionTime >= instant(row.notBefore, 'policy notBefore')
    && (!row.notAfter || decisionTime < instant(row.notAfter, 'policy notAfter'));
  if (!active) throw new Error('PromotionAuthorization key is revoked or outside its validity window');
  verifyPureEd25519({
    publicKey: row.publicKey,
    signature: authorization.signature.value,
    messageDigest: payloadDigest,
  });
  return { payloadDigest, policyDigest, publicKeyFingerprint: row.publicKeyFingerprint };
}

module.exports = {
  DECISION_PAYLOAD_TAG,
  DECISION_POLICY_TAG,
  VERIFICATION_POLICY_TAG,
  VERIFICATION_SCOPES,
  decodeBase64url,
  sha256,
  taggedJcsDigest,
  validateDecisionTrustPolicy,
  validateVerificationTrustPolicy,
  verifyPromotionAuthorization,
  verifyPureEd25519,
  verifyScopedEd25519Envelope,
};
