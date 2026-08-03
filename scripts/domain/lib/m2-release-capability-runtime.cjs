'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  PROFILE_REF,
  RELEASE_CAPABILITY_EVIDENCE_USE,
  releaseCapabilityDefinitions,
} = require('./m2-release-capability-definitions.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'profileRef', 'operation', 'capabilityId', 'subject',
  'subjectDigest', 'dependencyEvidence', 'fault',
]);
const SUBJECT_FIELDS = Object.freeze([
  'bindingKind', 'subjectId', 'stageId', 'assertions',
]);
const ASSERTION_FIELDS = Object.freeze(['assertionId', 'proofDigest']);
const DEPENDENCY_FIELDS = Object.freeze(['dependencyId', 'outcome', 'evidenceDigest']);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function exactFields(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...expected].sort());
}

function assertionProofDigest(capabilityId, assertionId) {
  return sha256(Buffer.from(
    `axiolune-release-capability-assertion-v1\0${capabilityId}\0${assertionId}`,
    'utf8',
  ));
}

function dependencyEvidenceDigest(capabilityId, dependencyId) {
  return sha256(Buffer.from(
    `axiolune-release-capability-dependency-v1\0${capabilityId}\0${dependencyId}\0passed`,
    'utf8',
  ));
}

function subjectDigest(subject) {
  return taggedJcsDigest('axiolune-release-capability-subject-v1\0', subject);
}

const DEFINITIONS = Object.freeze(Object.fromEntries(
  releaseCapabilityDefinitions().map((definition) => [
    definition.capabilityId,
    Object.freeze(structuredClone(definition)),
  ]),
));

function output(capabilityId, definition, values) {
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    capabilityId,
    semanticOwner: capabilityId,
    evidenceUse: RELEASE_CAPABILITY_EVIDENCE_USE,
    releaseEligibilityEvidence: false,
    status: values.status,
    outcome: values.outcome,
    code: values.code,
    subjectId: definition?.subjectId || null,
    evidence: {
      bindingKind: definition?.bindingKind || null,
      stageId: definition?.stageId || null,
      subjectId: definition?.subjectId || null,
      computedSubjectDigest: values.computedSubjectDigest || null,
      assertionCount: values.assertionCount || 0,
      dependencyCount: values.dependencyCount || 0,
      validatedAssertions: values.validatedAssertions || [],
      validatedDependencies: values.validatedDependencies || [],
    },
  };
}

function engineFailure(capabilityId, definition, code, values = {}) {
  return output(capabilityId, definition, {
    status: 'engineFailure',
    outcome: 'engineFailure',
    code,
    ...values,
  });
}

function violation(capabilityId, definition, code, values = {}) {
  return output(capabilityId, definition, {
    status: 'completed',
    outcome: 'violation',
    code,
    ...values,
  });
}

function evaluateReleaseCapability(request) {
  const capabilityId = typeof request?.capabilityId === 'string'
    ? request.capabilityId : 'unknown';
  const definition = DEFINITIONS[capabilityId] || null;
  if (!exactFields(request, REQUEST_FIELDS)
      || request.schemaVersion !== '1.0'
      || request.profileRef !== PROFILE_REF
      || request.operation !== 'evaluate') {
    return engineFailure(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_INPUT_CONTRACT',
    );
  }
  if (!definition) {
    return engineFailure(
      capabilityId,
      null,
      'M2_RELEASE_CAPABILITY_UNKNOWN',
    );
  }
  if (request.fault !== null) {
    if (request.fault === 'forced-engine-failure') {
      throw new Error(`forced engine-failure vector for ${capabilityId}`);
    }
    return engineFailure(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_FAULT_CONTRACT',
    );
  }
  if (request.subject === null) {
    return engineFailure(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_EMPTY_SUBJECT',
    );
  }
  if (!exactFields(request.subject, SUBJECT_FIELDS)
      || request.subject.bindingKind !== definition.bindingKind
      || request.subject.subjectId !== definition.subjectId
      || request.subject.stageId !== definition.stageId
      || !Array.isArray(request.subject.assertions)) {
    return violation(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_SUBJECT_CONTRACT',
    );
  }

  const computedSubjectDigest = subjectDigest(request.subject);
  if (!DIGEST_RE.test(request.subjectDigest || '')
      || request.subjectDigest !== computedSubjectDigest) {
    return engineFailure(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_INPUT_DIGEST',
      { computedSubjectDigest },
    );
  }

  const assertionIds = [];
  let previousAssertion = null;
  for (const assertion of request.subject.assertions) {
    if (!exactFields(assertion, ASSERTION_FIELDS)
        || typeof assertion.assertionId !== 'string'
        || !DIGEST_RE.test(assertion.proofDigest || '')
        || (previousAssertion !== null
          && Buffer.compare(Buffer.from(previousAssertion), Buffer.from(assertion.assertionId)) >= 0)) {
      return violation(
        capabilityId,
        definition,
        'M2_RELEASE_CAPABILITY_ASSERTION_CONTRACT',
        { computedSubjectDigest, assertionCount: assertionIds.length },
      );
    }
    previousAssertion = assertion.assertionId;
    assertionIds.push(assertion.assertionId);
    if (assertion.proofDigest !== assertionProofDigest(capabilityId, assertion.assertionId)) {
      return violation(
        capabilityId,
        definition,
        'M2_RELEASE_CAPABILITY_ASSERTION_PROOF',
        { computedSubjectDigest, assertionCount: assertionIds.length - 1 },
      );
    }
  }
  if (canonicalJcs(assertionIds) !== canonicalJcs(definition.requiredAssertions)) {
    return violation(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_ASSERTION_INVENTORY',
      { computedSubjectDigest, assertionCount: assertionIds.length },
    );
  }

  if (!Array.isArray(request.dependencyEvidence)) {
    return violation(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_DEPENDENCY_CONTRACT',
      { computedSubjectDigest, assertionCount: assertionIds.length },
    );
  }
  const dependencyIds = [];
  let previousDependency = null;
  for (const dependency of request.dependencyEvidence) {
    if (!exactFields(dependency, DEPENDENCY_FIELDS)
        || typeof dependency.dependencyId !== 'string'
        || dependency.outcome !== 'passed'
        || !DIGEST_RE.test(dependency.evidenceDigest || '')
        || (previousDependency !== null
          && Buffer.compare(Buffer.from(previousDependency), Buffer.from(dependency.dependencyId)) >= 0)) {
      return violation(
        capabilityId,
        definition,
        'M2_RELEASE_CAPABILITY_DEPENDENCY_CONTRACT',
        {
          computedSubjectDigest,
          assertionCount: assertionIds.length,
          dependencyCount: dependencyIds.length,
        },
      );
    }
    previousDependency = dependency.dependencyId;
    dependencyIds.push(dependency.dependencyId);
    if (dependency.evidenceDigest
        !== dependencyEvidenceDigest(capabilityId, dependency.dependencyId)) {
      return violation(
        capabilityId,
        definition,
        'M2_RELEASE_CAPABILITY_DEPENDENCY_PROOF',
        {
          computedSubjectDigest,
          assertionCount: assertionIds.length,
          dependencyCount: dependencyIds.length - 1,
        },
      );
    }
  }
  if (canonicalJcs(dependencyIds) !== canonicalJcs(definition.dependsOn)) {
    return violation(
      capabilityId,
      definition,
      'M2_RELEASE_CAPABILITY_DEPENDENCY_INVENTORY',
      {
        computedSubjectDigest,
        assertionCount: assertionIds.length,
        dependencyCount: dependencyIds.length,
      },
    );
  }

  return output(capabilityId, definition, {
    status: 'completed',
    outcome: 'accepted',
    code: null,
    computedSubjectDigest,
    assertionCount: assertionIds.length,
    dependencyCount: dependencyIds.length,
    validatedAssertions: assertionIds,
    validatedDependencies: dependencyIds,
  });
}

function engineFailureOutput(request, cause) {
  const capabilityId = typeof request?.capabilityId === 'string'
    ? request.capabilityId : 'unknown';
  return engineFailure(
    capabilityId,
    DEFINITIONS[capabilityId] || null,
    'M2_RELEASE_CAPABILITY_ENGINE_FAILURE',
    {
      validatedAssertions: [],
      validatedDependencies: [],
    },
  );
}

module.exports = {
  ASSERTION_FIELDS,
  DEFINITIONS,
  DEPENDENCY_FIELDS,
  DIGEST_RE,
  REQUEST_FIELDS,
  SUBJECT_FIELDS,
  assertionProofDigest,
  dependencyEvidenceDigest,
  engineFailureOutput,
  evaluateReleaseCapability,
  sha256,
  subjectDigest,
  taggedJcsDigest,
};
