'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  DECISION_PAYLOAD_TAG,
  VERIFICATION_POLICY_TAG,
  sha256,
  taggedJcsDigest,
  validateVerificationTrustPolicy,
  verifyPromotionAuthorization,
  verifyPureEd25519,
  verifyScopedEd25519Envelope,
} = require('../lib/m2-ed25519.cjs');

function fixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKeyText = rawPublicKey.toString('base64url');
  const fingerprint = sha256(rawPublicKey);
  const policy = {
    schemaVersion: '1.0',
    policyId: 'm2-dri-policy',
    principals: [{
      driRef: 'https://axiolune.ai/principals/dri',
      keyRef: 'https://axiolune.ai/keys/dri-2026',
      algorithm: 'Ed25519',
      publicKeyEncoding: 'base64url-nopad',
      publicKey: publicKeyText,
      publicKeyFingerprint: fingerprint,
      notBefore: '2026-07-01T00:00:00Z',
      notAfter: '2027-01-01T00:00:00Z',
      status: 'active',
    }],
  };
  const payload = {
    decisionType: 'promotionAuthorization',
    decision: 'authorizeP1',
    repositoryId: 'urn:axiolune:repository:m2',
    authoritativeRef: 'refs/heads/release/m2-v0.3.0',
    expectedOldCommitId: '1'.repeat(40),
    gitObjectFormat: 'sha1',
    targetVersion: '0.3.0',
    p0ManifestRef: { kind: 'path', root: 'payload', path: 'evidence/p0-review-manifest.json' },
    p0ManifestDigest: `sha256:${'2'.repeat(64)}`,
    p0VerificationReportRef: { kind: 'path', root: 'payload', path: 'evidence/p0-verification-report.json' },
    p0VerificationReportDigest: `sha256:${'3'.repeat(64)}`,
    decisionTrustPolicyRef: { kind: 'path', root: 'sourceTree', path: 'policy/decision-trust-policy.json' },
    decisionTrustPolicyDigest: taggedJcsDigest(
      'axiolune-decision-trust-policy-v1\0',
      policy,
    ),
    driRef: policy.principals[0].driRef,
    keyRef: policy.principals[0].keyRef,
    publicKeyFingerprint: fingerprint,
    algorithm: 'Ed25519',
    authorizationTime: '2026-08-01T00:00:00Z',
    rationale: 'Authorize the exact independently verified P0 evidence for P1.',
  };
  const digest = taggedJcsDigest(DECISION_PAYLOAD_TAG, payload);
  const signature = crypto.sign(null, Buffer.from(digest.slice(7), 'hex'), privateKey);
  const authorization = {
    schemaVersion: '1.0',
    decisionPayload: payload,
    decisionPayloadDigest: digest,
    signature: {
      signedDigest: digest,
      signatureEncoding: 'base64url-nopad',
      value: signature.toString('base64url'),
    },
  };
  return { authorization, policy, privateKey, publicKeyText };
}

function verificationFixture() {
  const scopes = [
    'adoptionAttemptChallenge',
    'adoptionAttestation',
    'refUpdateReceipt',
  ];
  const keys = scopes.map((scope) => {
    const pair = crypto.generateKeyPairSync('ed25519');
    const bytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    return {
      scope,
      privateKey: pair.privateKey,
      publicKey: bytes.toString('base64url'),
      publicKeyFingerprint: sha256(bytes),
    };
  });
  const repositoryId = 'urn:axiolune:repository:m2';
  const authoritativeRef = 'refs/heads/release/m2-v0.3.0';
  const policy = {
    schemaVersion: '1.0',
    policyId: 'm2-verification-policy',
    principals: keys.map((key) => ({
      principalRef: `https://axiolune.ai/principals/${key.scope}`,
      keyRef: `https://axiolune.ai/keys/${key.scope}-2026`,
      scope: key.scope,
      repositoryId,
      authoritativeRef,
      algorithm: 'Ed25519',
      publicKeyEncoding: 'base64url-nopad',
      publicKey: key.publicKey,
      publicKeyFingerprint: key.publicKeyFingerprint,
      notBefore: '2026-07-01T00:00:00Z',
      notAfter: '2027-01-01T00:00:00Z',
      status: 'active',
    })),
  };
  const signer = policy.principals[0];
  const payload = {
    challengeType: 'adoptionAttempt',
    repositoryId,
    authoritativeRef,
    coordinatorPrincipalRef: signer.principalRef,
    keyRef: signer.keyRef,
    publicKeyFingerprint: signer.publicKeyFingerprint,
    algorithm: signer.algorithm,
    issuedAt: '2026-08-01T00:00:00Z',
  };
  const payloadTag = 'axiolune-test-adoption-challenge-payload-v1\0';
  const payloadDigest = taggedJcsDigest(payloadTag, payload);
  const signature = crypto.sign(
    null,
    Buffer.from(payloadDigest.slice(7), 'hex'),
    keys[0].privateKey,
  );
  const envelope = {
    schemaVersion: '1.0',
    challengePayload: payload,
    challengePayloadDigest: payloadDigest,
    signature: {
      signedDigest: payloadDigest,
      signatureEncoding: 'base64url-nopad',
      value: signature.toString('base64url'),
    },
  };
  return {
    authoritativeRef,
    envelope,
    keys,
    payloadTag,
    policy,
    policyDigest: taggedJcsDigest(VERIFICATION_POLICY_TAG, policy),
    repositoryId,
    signer,
  };
}

test('verifies exact P0 binding, trusted policy, validity interval, and pure Ed25519', () => {
  const value = fixture();
  const result = verifyPromotionAuthorization(value.authorization, value.policy, {
    repositoryId: value.authorization.decisionPayload.repositoryId,
    authoritativeRef: value.authorization.decisionPayload.authoritativeRef,
    expectedOldCommitId: value.authorization.decisionPayload.expectedOldCommitId,
    gitObjectFormat: value.authorization.decisionPayload.gitObjectFormat,
    targetVersion: value.authorization.decisionPayload.targetVersion,
    p0ManifestRef: value.authorization.decisionPayload.p0ManifestRef,
    p0ManifestDigest: value.authorization.decisionPayload.p0ManifestDigest,
    p0VerificationReportRef: value.authorization.decisionPayload.p0VerificationReportRef,
    p0VerificationReportDigest: value.authorization.decisionPayload.p0VerificationReportDigest,
  });
  assert.equal(result.payloadDigest, value.authorization.decisionPayloadDigest);
  assert.equal(result.publicKeyFingerprint, value.policy.principals[0].publicKeyFingerprint);
});

test('changed signed payload or signature is rejected', () => {
  const value = fixture();
  const changedPayload = structuredClone(value.authorization);
  changedPayload.decisionPayload.rationale = 'substituted rationale';
  assert.throws(
    () => verifyPromotionAuthorization(changedPayload, value.policy),
    /digest binding differs/u,
  );

  const changedSignature = structuredClone(value.authorization);
  const bytes = Buffer.from(changedSignature.signature.value, 'base64url');
  bytes[10] ^= 1;
  changedSignature.signature.value = bytes.toString('base64url');
  assert.throws(
    () => verifyPromotionAuthorization(changedSignature, value.policy),
    /verification failed|non-canonical|small-order|not an Edwards25519 point/u,
  );
});

test('revoked, expired, aliased, or substituted policy keys are rejected', () => {
  for (const mutation of [
    (policy) => { policy.principals[0].status = 'revoked'; },
    (policy) => { policy.principals[0].notAfter = '2026-08-01T00:00:00Z'; },
    (policy) => { policy.principals.push(structuredClone(policy.principals[0])); },
  ]) {
    const value = fixture();
    mutation(value.policy);
    assert.throws(() => verifyPromotionAuthorization(value.authorization, value.policy));
  }
});

test('non-canonical S and small-order public keys are rejected before OpenSSL verification', () => {
  const value = fixture();
  const signature = Buffer.from(value.authorization.signature.value, 'base64url');
  signature.fill(0xff, 32);
  assert.throws(
    () => verifyPureEd25519({
      publicKey: value.publicKeyText,
      signature: signature.toString('base64url'),
      messageDigest: value.authorization.decisionPayloadDigest,
    }),
    /signature S is non-canonical/u,
  );
  assert.throws(
    () => verifyPureEd25519({
      publicKey: Buffer.alloc(32).toString('base64url'),
      signature: value.authorization.signature.value,
      messageDigest: value.authorization.decisionPayloadDigest,
    }),
    /small-order/u,
  );

  const orderTwo = Buffer.alloc(32);
  let orderTwoY = (1n << 255n) - 20n;
  for (let index = 0; index < orderTwo.length; index += 1) {
    orderTwo[index] = Number(orderTwoY & 0xffn);
    orderTwoY >>= 8n;
  }
  const orderFourNegativeX = Buffer.alloc(32);
  orderFourNegativeX[31] = 0x80;
  for (const point of [orderTwo, orderFourNegativeX]) {
    assert.throws(
      () => verifyPureEd25519({
        publicKey: point.toString('base64url'),
        signature: value.authorization.signature.value,
        messageDigest: value.authorization.decisionPayloadDigest,
      }),
      /small-order/u,
    );
  }

  const identityWithNegativeX = Buffer.alloc(32);
  identityWithNegativeX[0] = 1;
  identityWithNegativeX[31] = 0x80;
  assert.throws(
    () => verifyPureEd25519({
      publicKey: identityWithNegativeX.toString('base64url'),
      signature: value.authorization.signature.value,
      messageDigest: value.authorization.decisionPayloadDigest,
    }),
    /non-canonical x-sign/u,
  );
});

test('verification policy enforces distinct scoped keys and verifies a scoped envelope', () => {
  const value = verificationFixture();
  assert.equal(validateVerificationTrustPolicy(value.policy), value.policyDigest);
  const result = verifyScopedEd25519Envelope({
    envelope: value.envelope,
    envelopeLabel: 'AdoptionAttemptChallenge',
    payloadField: 'challengePayload',
    payloadDigestField: 'challengePayloadDigest',
    payloadTag: value.payloadTag,
    policy: value.policy,
    expectedPolicyDigest: value.policyDigest,
    scope: 'adoptionAttemptChallenge',
    principalRef: value.signer.principalRef,
    keyRef: value.signer.keyRef,
    publicKeyFingerprint: value.signer.publicKeyFingerprint,
    algorithm: value.signer.algorithm,
    repositoryId: value.repositoryId,
    authoritativeRef: value.authoritativeRef,
    signedAt: value.envelope.challengePayload.issuedAt,
  });
  assert.equal(result.scope, 'adoptionAttemptChallenge');
  assert.equal(result.payloadDigest, value.envelope.challengePayloadDigest);
});

test('verification policy rejects key aliases, wrong scopes, and policy substitution', () => {
  const aliased = verificationFixture();
  aliased.policy.principals[1].keyRef = aliased.policy.principals[0].keyRef;
  assert.throws(
    () => validateVerificationTrustPolicy(aliased.policy),
    /key alias|sorted/u,
  );

  const wrongScope = verificationFixture();
  assert.throws(
    () => verifyScopedEd25519Envelope({
      envelope: wrongScope.envelope,
      envelopeLabel: 'AdoptionAttemptChallenge',
      payloadField: 'challengePayload',
      payloadDigestField: 'challengePayloadDigest',
      payloadTag: wrongScope.payloadTag,
      policy: wrongScope.policy,
      expectedPolicyDigest: wrongScope.policyDigest,
      scope: 'refUpdateReceipt',
      principalRef: wrongScope.signer.principalRef,
      keyRef: wrongScope.signer.keyRef,
      publicKeyFingerprint: wrongScope.signer.publicKeyFingerprint,
      algorithm: wrongScope.signer.algorithm,
      repositoryId: wrongScope.repositoryId,
      authoritativeRef: wrongScope.authoritativeRef,
      signedAt: wrongScope.envelope.challengePayload.issuedAt,
    }),
    /no unique scoped policy row/u,
  );

  const substituted = verificationFixture();
  assert.throws(
    () => verifyScopedEd25519Envelope({
      envelope: substituted.envelope,
      envelopeLabel: 'AdoptionAttemptChallenge',
      payloadField: 'challengePayload',
      payloadDigestField: 'challengePayloadDigest',
      payloadTag: substituted.payloadTag,
      policy: substituted.policy,
      expectedPolicyDigest: `sha256:${'0'.repeat(64)}`,
      scope: 'adoptionAttemptChallenge',
      principalRef: substituted.signer.principalRef,
      keyRef: substituted.signer.keyRef,
      publicKeyFingerprint: substituted.signer.publicKeyFingerprint,
      algorithm: substituted.signer.algorithm,
      repositoryId: substituted.repositoryId,
      authoritativeRef: substituted.authoritativeRef,
      signedAt: substituted.envelope.challengePayload.issuedAt,
    }),
    /independently trusted verification policy/u,
  );
});
