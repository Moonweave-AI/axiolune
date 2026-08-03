#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  MODULE_ID,
  REQUIRED_REFERENCE_PROFILES,
  auditPostTradeAuthorityEvidence,
  auditPostTradeCodeListAuthority,
  auditPostTradeReferenceLock,
  compilePostTradeEvidenceContext,
  parseReferenceLockYaml,
} = require('../lib/post-trade-authority-evidence.cjs');
const {
  CODE_LIST_AUTHORITY_LOCAL_PATH,
  CODE_LIST_AUTHORITY_REFERENCE_ID,
  CODE_LIST_AUTHORITY_REFERENCE_IRI,
  digestCandidate,
} = require('../lib/source-evidence-reference.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = path.join(
  ROOT,
  'ontology/domain/finance/post-trade-operations/module.yaml',
);
const REFERENCE_LOCK_PATH = path.join(
  ROOT,
  'docs/ontology/references/references.lock.yaml',
);
const AUTHORITY_CAPTURE_SCRIPT = path.join(
  ROOT,
  'scripts/domain/capture-post-trade-authority-pages.cjs',
);
const VALID_DIGEST = `sha256:${'1'.repeat(64)}`;
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';

function loadModule() {
  return yaml.load(fs.readFileSync(MODULE_PATH, 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  });
}

function loadReferenceLock() {
  return parseReferenceLockYaml(fs.readFileSync(REFERENCE_LOCK_PATH, 'utf8'));
}

function wholeFileLocator(
  locatorPath = 'm2-v0.3-code-lists.json',
  mediaType = 'application/json',
) {
  return {
    kind: 'wholeFile',
    path: locatorPath,
    mediaType,
    extractorProfileRef: {
      kind: 'path',
      root: 'sourceTree',
      path: 'scripts/domain/reference-extractors/whole-file-v1.json',
    },
    extractorProfileDigest: VALID_DIGEST,
    selectionDigest: VALID_DIGEST,
  };
}

function authorityReference() {
  return {
    id: CODE_LIST_AUTHORITY_REFERENCE_ID,
    artifactDigest: VALID_DIGEST,
    localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
    locators: [wholeFileLocator()],
  };
}

function oneCodeListModule() {
  return {
    module: {
      status: 'draft',
      governance: { status: 'draft' },
    },
    domain: {
      codeLists: {
        State: {
          iri: 'https://axiolune.ai/ontology/finance/post-trade-operations/State',
          version: '0.3.0',
          sourceEvidenceRef: CODE_LIST_AUTHORITY_REFERENCE_IRI,
          values: [
            {
              iri: 'https://axiolune.ai/ontology/finance/post-trade-operations/State/value/closed',
              notation: 'closed',
              label: 'Closed',
              definition: 'A terminal state in the exact adopted fixture vocabulary.',
            },
            {
              iri: 'https://axiolune.ai/ontology/finance/post-trade-operations/State/value/open',
              notation: 'open',
              label: 'Open',
              definition: 'A non-terminal state in the exact adopted fixture vocabulary.',
            },
          ],
        },
      },
    },
  };
}

function authorityManifest(codeList, decisionStatus = 'reviewed') {
  const entries = [{
    authorityKind: 'axioluneOperational',
    codeListIri: codeList.iri,
    codeListName: 'State',
    members: codeList.values,
    moduleId: MODULE_ID,
    rationale: 'The exact member set is a Post-trade interoperability contract.',
    sourceEvidenceRef: codeList.sourceEvidenceRef,
    upstreamEvidence: [],
    version: codeList.version,
  }];
  const candidateDigest = digestCandidate(PROFILE_REF, '0.3.0', entries);
  let decision = { status: 'pending' };
  if (decisionStatus === 'reviewed') {
    decision = {
      candidateDigest,
      decisionTime: '2026-08-01T00:00:00Z',
      rationale: 'The fixture reviewer checked the exact candidate digest and source boundaries.',
      reviewBasisRefs: ['https://axiolune.ai/reviews/test-post-trade-authority'],
      reviewerRef: 'https://axiolune.ai/principals/test-reviewer',
      status: 'reviewed',
    };
  } else if (decisionStatus === 'adopted') {
    decision = {
      candidateDigest,
      decisionTime: '2026-08-01T00:00:00Z',
      driRef: 'https://axiolune.ai/principals/test-dri',
      rationale: 'The fixture DRI adopted the exact candidate digest.',
      reviewBasisRefs: ['https://axiolune.ai/reviews/test-post-trade-authority'],
      status: 'adopted',
    };
  }
  return {
    candidateDigest,
    decision,
    entries,
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    snapshotVersion: '0.3.0',
  };
}

function hasFinding(findings, code, pathFragment = undefined) {
  return findings.some((item) => item.code === code
    && (pathFragment === undefined || item.path === pathFragment));
}

test('authority capture refuses to derive an authoritative timestamp from the wall clock', () => {
  const result = spawnSync(process.execPath, [AUTHORITY_CAPTURE_SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout || ''}\n${result.stderr || ''}`,
    /--captured-at is required; authority evidence capture must not derive an authoritative timestamp from the wall clock/u,
  );
});

test('repository Post-trade code-list adoption is pending while all six exact external locks resolve', () => {
  const audit = auditPostTradeAuthorityEvidence({
    moduleDocument: loadModule(),
    referenceLock: loadReferenceLock(),
  });
  assert.equal(audit.status, 'pending');
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.codeListCount, 20);
  assert.equal(
    audit.pending.filter((item) => item.code === 'PTO_CODE_LIST_AUTHORITY_PENDING').length,
    20,
  );
  assert.deepEqual(audit.resolved.codeLists, []);
  assert.deepEqual(
    audit.resolved.references,
    [
      'finra-rule-11140',
      'finra-notice-00-54',
      'investor-gov-ex-dividend',
      'dtc-distributions-service-guide',
      'dtc-settlement-service-guide',
      'fibo-rights-exercise-event',
    ],
  );
  assert.equal(
    audit.pending.some((item) => item.code === 'PTO_REFERENCE_LOCK_PENDING'),
    false,
  );
});

test('a semantically different FINRA line selector cannot discharge the exact rule lock', () => {
  const referenceLock = loadReferenceLock();
  const rule = referenceLock.references.find(
    (reference) => reference.id === 'finra-rule-11140-2026-07-31',
  );
  const selector = rule.locators.find(
    (locator) => locator.kind === 'textLineRange' && locator.startLine === 5,
  );
  selector.startLine = 9;
  selector.endLine = 10;
  const audit = auditPostTradeAuthorityEvidence({
    moduleDocument: loadModule(),
    referenceLock,
  });
  assert.equal(audit.status, 'pending');
  assert.ok(hasFinding(
    audit.pending,
    'PTO_REFERENCE_LOCK_PENDING',
    'referenceRequirements.finra-rule-11140',
  ));
});

test('an arbitrary non-pending code-list evidence IRI fails and remains pending', () => {
  const moduleDocument = loadModule();
  const name = Object.keys(moduleDocument.domain.codeLists)[0];
  const at = `domain.codeLists.${name}.sourceEvidenceRef`;
  moduleDocument.domain.codeLists[name].sourceEvidenceRef = 'https://example.test/forged-authority';
  const audit = auditPostTradeAuthorityEvidence({
    moduleDocument,
    referenceLock: loadReferenceLock(),
  });
  assert.equal(audit.status, 'fail');
  assert.ok(hasFinding(audit.errors, 'PTO_CODE_LIST_EVIDENCE_REF', at));
  assert.ok(hasFinding(audit.pending, 'PTO_CODE_LIST_AUTHORITY_PENDING', at));
});

test('the canonical authority IRI cannot resolve without its exact lock and manifest', () => {
  const moduleDocument = loadModule();
  const name = Object.keys(moduleDocument.domain.codeLists)[0];
  const at = `domain.codeLists.${name}.sourceEvidenceRef`;
  moduleDocument.domain.codeLists[name].sourceEvidenceRef = CODE_LIST_AUTHORITY_REFERENCE_IRI;
  const referenceLock = loadReferenceLock();
  referenceLock.references = referenceLock.references.filter(
    (reference) => reference.id !== CODE_LIST_AUTHORITY_REFERENCE_ID,
  );
  const audit = auditPostTradeAuthorityEvidence({
    moduleDocument,
    referenceLock,
  });
  assert.equal(audit.status, 'fail');
  assert.ok(hasFinding(audit.errors, 'PTO_CODE_LIST_AUTHORITY_LOCK', at));
  assert.ok(hasFinding(audit.pending, 'PTO_CODE_LIST_AUTHORITY_PENDING', at));
});

test('comments and note strings cannot impersonate structured reference records', () => {
  const discoveryStrings = REQUIRED_REFERENCE_PROFILES
    .map((profile) => [profile.id, profile.artifactUrl, profile.label]
      .filter(Boolean)
      .join(' '))
    .join('\n');
  const parsed = parseReferenceLockYaml([
    'schemaVersion: "1.0"',
    'note: |',
    ...discoveryStrings.split('\n').map((line) => `  ${line}`),
    '# RightsExerciseEvent and every required URL appear only in comments/notes.',
    'references: []',
    '',
  ].join('\n'));
  const audit = auditPostTradeReferenceLock(parsed);
  assert.equal(audit.status, 'pending');
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.resolved.length, 0);
  assert.equal(audit.pending.length, REQUIRED_REFERENCE_PROFILES.length);
});

test('a repository-edited adopted authority cannot close a Post-trade code list', () => {
  const moduleDocument = oneCodeListModule();
  const codeList = moduleDocument.domain.codeLists.State;
  const referenceLock = { references: [authorityReference()] };
  const context = compilePostTradeEvidenceContext(
    referenceLock,
    authorityManifest(codeList, 'adopted'),
  );
  const audit = auditPostTradeCodeListAuthority(moduleDocument, context);
  assert.equal(audit.status, 'fail', JSON.stringify(audit, null, 2));
  assert.ok(audit.errors.some((finding) => (
    finding.code === 'PTO_CODE_LIST_AUTHORITY_MANIFEST'
      || finding.code === 'PTO_CODE_LIST_AUTHORITY_MISMATCH'
  )));
  assert.ok(hasFinding(
    audit.pending,
    'PTO_CODE_LIST_AUTHORITY_PENDING',
    'domain.codeLists.State.sourceEvidenceRef',
  ));
  assert.deepEqual(audit.resolved, []);
});

test('pending review and reviewed member drift both fail closed', () => {
  const moduleDocument = oneCodeListModule();
  const codeList = moduleDocument.domain.codeLists.State;
  const referenceLock = { references: [authorityReference()] };

  const pendingContext = compilePostTradeEvidenceContext(
    referenceLock,
    authorityManifest(codeList, 'pending'),
  );
  const pendingAudit = auditPostTradeCodeListAuthority(moduleDocument, pendingContext);
  assert.equal(pendingAudit.status, 'pending');
  assert.deepEqual(pendingAudit.errors, []);
  assert.ok(hasFinding(
    pendingAudit.pending,
    'PTO_CODE_LIST_AUTHORITY_PENDING',
    'domain.codeLists.State.sourceEvidenceRef',
  ));

  const reviewedContext = compilePostTradeEvidenceContext(
    referenceLock,
    authorityManifest(codeList, 'reviewed'),
  );
  const drifted = structuredClone(moduleDocument);
  drifted.domain.codeLists.State.values[0].definition = 'Silently changed after semantic review.';
  const driftAudit = auditPostTradeCodeListAuthority(drifted, reviewedContext);
  assert.equal(driftAudit.status, 'fail');
  assert.ok(hasFinding(
    driftAudit.errors,
    'PTO_CODE_LIST_AUTHORITY_MISMATCH',
    'domain.codeLists.State.sourceEvidenceRef',
  ));
  assert.ok(hasFinding(
    driftAudit.pending,
    'PTO_CODE_LIST_AUTHORITY_PENDING',
    'domain.codeLists.State.sourceEvidenceRef',
  ));
});

test('approved lifecycle cannot coexist with unresolved authority evidence', () => {
  const moduleDocument = loadModule();
  moduleDocument.module.status = 'approved';
  moduleDocument.module.governance.status = 'approved';
  const audit = auditPostTradeAuthorityEvidence({
    moduleDocument,
    referenceLock: loadReferenceLock(),
  });
  assert.equal(audit.status, 'fail');
  assert.ok(hasFinding(audit.errors, 'PTO_APPROVED_WITH_PENDING_EVIDENCE'));
});

test('focused CLI returns exit 0 when authority evidence is fully resolved', () => {
  const cli = path.join(
    ROOT,
    'scripts/domain/validate-post-trade-authority-evidence.cjs',
  );
  const run = spawnSync(process.execPath, [cli], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Post-trade authority evidence: PASS/u);
  assert.match(
    run.stdout,
    /PASS \(0 failures, 0 pending, 6\/6 reference profiles, 20\/20 code lists resolved\)/u,
  );
});
