#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateSourceLocator,
} = require('./lib/strict-source-locator.cjs');
const {
  computeWholeFileSelectionDigest,
  fileDigest,
  inspectReferenceBundle,
} = require('./lib/reference-closure.cjs');
const {
  extractUniqueXmlElementBytes,
} = require('./lib/reference-source-extractors.cjs');
const {
  extractTextLineRangeBytes,
} = require('./lib/text-line-range-source-extractor.cjs');
const {
  validateSemanticReviewDecision,
} = require('./lib/authority-decision.cjs');
const {
  digestCandidate: codeListCandidateDigest,
} = require('./lib/source-evidence-reference.cjs');
const {
  digestCandidate: termAuthorityCandidateDigest,
} = require('./lib/term-authority.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const REVIEW_DATE = '2026-08-01';
const REVIEWER_REF = 'urn:axiolune:reviewer:codex-agent:reference-authority-chain';
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const OUTPUT_DIR = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reviews',
  'authority',
);
const FRAGMENT_PATH = path.join(OUTPUT_DIR, 'reference-review-coverage.fragment.json');

const PROJECTS = Object.freeze([
  {
    projectId: 'authority-anna-isin-2026-08-01',
    rootPath: 'reference/authority-reference/anna',
    reviewFile: 'authority-anna-isin-2026-08-01.review.json',
    files: [
      {
        path: 'reference/authority-reference/anna/2026-08-01/isin-guidelines-v26/isin-guidelines-v26.pdf',
        mediaType: 'application/pdf',
        disposition: 'usedNormative',
        referenceId: 'anna-isin-guidelines-v26-2026-06',
        rationale: 'Official ANNA ISIN Uniform Guidelines bytes support the exact locked ISO 6166 registration-authority, allocative-responsibility, identifier-structure, and check-digit selectors; no broader semantic import is claimed.',
      },
    ],
  },
  {
    projectId: 'authority-gleif-lei-2026-08-01',
    rootPath: 'reference/authority-reference/gleif',
    reviewFile: 'authority-gleif-lei-2026-08-01.review.json',
    files: [
      {
        path: 'reference/authority-reference/gleif/2026-08-01/lei-faq-v1.0/lei-faq-v1.0.pdf',
        mediaType: 'application/pdf',
        disposition: 'usedNormative',
        referenceId: 'gleif-lei-faq-v1-2024-04-22',
        rationale: 'Official GLEIF FAQ bytes support the exact locked LEI length, ISO 17442 basis, governance/issuer distinction, and accredited-LOU issuance selectors; no broader semantic import is claimed.',
      },
      {
        path: 'reference/authority-reference/gleif/2026-08-01/lei-cdf-qa-v2.4/lei-cdf-qa-v2.4.pdf',
        mediaType: 'application/pdf',
        disposition: 'usedNormative',
        referenceId: 'gleif-lei-cdf-qa-v2.4-2022-02-22',
        rationale: 'Official GLEIF Common Data File Q&A bytes support the exact locked LEI character repertoire, issuer-prefix/entity-section layout, and ISO 7064 check-digit selector; no broader semantic import is claimed.',
      },
    ],
  },
  {
    projectId: 'authority-iso10383-ra-mic-2026-08-01',
    rootPath: 'reference/authority-reference/iso10383-ra',
    reviewFile: 'authority-iso10383-ra-mic-2026-08-01.review.json',
    files: [
      {
        path: 'reference/authority-reference/iso10383-ra/2026-08-01/mic-release-2-factsheet-v2/mic-release-2-factsheet-v2.pdf',
        mediaType: 'application/pdf',
        disposition: 'usedNormative',
        referenceId: 'iso10383-ra-mic-release-2-factsheet-v2-2022-11',
        rationale: 'Official ISO 10383 Registration Authority factsheet bytes support the exact locked SWIFT registration-authority, market-coverage, and four-character uppercase ASCII MIC selectors; no broader semantic import is claimed.',
      },
    ],
  },
  {
    projectId: 'authority-iso20022-mic-register-2026-07-13',
    rootPath: 'reference/authority-reference/iso20022',
    reviewFile: 'authority-iso20022-mic-register-2026-07-13.review.json',
    files: [
      {
        path: 'reference/authority-reference/iso20022/2026-08-01/mic-register-2026-07-13/ISO10383_MIC.csv',
        mediaType: 'text/csv',
        disposition: 'usedNormative',
        referenceId: 'iso20022-mic-register-2026-07-13',
        rationale: 'Official ISO 10383 Registration Authority register bytes and exact locked rows establish the current 17-column schema plus the XNMS segment-MIC to XNAS operating-MIC relationship.',
      },
      {
        path: 'reference/authority-reference/iso20022/2026-08-01/mic-register-2026-07-13/mic-source-lock.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'iso20022-mic-register-2026-07-13',
        jsonKind: 'micSourceLock',
        rationale: 'Canonical source-lock metadata binds retrieval, raw CSV digest, publication and implementation dates, extractor profile, and exact row selectors; it is implementation evidence, not a second normative source.',
      },
    ],
  },
  {
    projectId: 'authority-iana-tzdb-2026c-2026-07-08',
    rootPath: 'reference/authority-reference/iana',
    reviewFile: 'authority-iana-tzdb-2026c-2026-07-08.review.json',
    files: [
      {
        path: 'reference/authority-reference/iana/2026-08-01/tzdata2026c/tzdata2026c.tar.gz',
        mediaType: 'application/gzip',
        disposition: 'usedNormative',
        referenceId: 'iana-tzdb-2026c-2026-07-08',
        rationale: 'Official IANA tzdb 2026c data archive bytes are the normative release artifact; archive-member integrity is separately enforced by the digest-bound source-lock runtime.',
      },
      {
        path: 'reference/authority-reference/iana/2026-08-01/tzdata2026c/tzdb-source-lock.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'iana-tzdb-2026c-2026-07-08',
        jsonKind: 'tzdbSourceLock',
        rationale: 'Canonical source-lock metadata binds release 2026c, archive/member digests, extractor profile, and exact zone selectors; it is implementation evidence, not a replacement authority.',
      },
      {
        path: 'reference/authority-reference/iana/2026-08-01/tzdata2026c/version',
        mediaType: 'text/plain',
        disposition: 'usedNormative',
        referenceId: 'iana-tzdb-2026c-2026-07-08',
        expectedText: '2026c\n',
        rationale: 'The exact version member extracted from the official archive identifies the locked tzdb release as 2026c.',
      },
      {
        path: 'reference/authority-reference/iana/2026-08-01/tzdata2026c/zone1970.tab',
        mediaType: 'text/tab-separated-values',
        disposition: 'usedNormative',
        referenceId: 'iana-tzdb-2026c-2026-07-08',
        rationale: 'The exact archive member and locked line selectors establish Asia/Shanghai and America/New_York as IANA time-zone identifiers in release 2026c.',
      },
    ],
  },
  {
    projectId: 'authority-bipm-si-brochure-9-v4.01-2026-06',
    rootPath: 'reference/authority-reference/bipm',
    reviewFile: 'authority-bipm-si-brochure-9-v4.01-2026-06.review.json',
    files: [
      {
        path: 'reference/authority-reference/bipm/2026-08-01/si-brochure-9-v4.01/SI-Brochure-9-EN-v4.01.pdf',
        mediaType: 'application/pdf',
        disposition: 'usedImplementation',
        referenceId: 'bipm-si-brochure-9-v4.01-2026-06',
        rationale: 'Exact BIPM pages are used only as contextual implementation evidence for quantities that count entities and documented descriptive terms; they do not define share as an SI unit or authorize a complete SI registry claim.',
      },
    ],
  },
  {
    projectId: 'authority-dtc-2026-07-31',
    rootPath: 'reference/authority-reference/dtc',
    reviewFile: 'authority-dtc-2026-07-31.review.json',
    files: [
      {
        path: 'reference/authority-reference/dtc/2026-07-31/distributions-service-guide/distributions-service-guide.pdf',
        mediaType: 'application/pdf',
        disposition: 'usedNormative',
        referenceId: 'dtc-distributions-service-guide-2026-05-06',
        rationale: 'Official DTC service-guide bytes support the locked distribution-event and entitlement-operating context; review does not extend beyond the exact locked page selector.',
      },
      {
        path: 'reference/authority-reference/dtc/2026-07-31/settlement-service-guide/settlement-service-guide.pdf',
        mediaType: 'application/pdf',
        disposition: 'usedNormative',
        referenceId: 'dtc-settlement-service-guide-2026-06-10',
        rationale: 'Official DTC service-guide bytes support the locked settlement-obligation operating context; review does not extend beyond the exact locked page selector.',
      },
    ],
  },
  {
    projectId: 'authority-finra-2026-07-31',
    rootPath: 'reference/authority-reference/finra',
    reviewFile: 'authority-finra-2026-07-31.review.json',
    files: [
      {
        path: 'reference/authority-reference/finra/2026-07-31/rule-11140/capture.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'finra-rule-11140-2026-07-31',
        jsonKind: 'webPageCapture',
        expectedCaptureId: 'finra-rule-11140-2026-07-31',
        expectedAuthorityPageUrl: 'https://www.finra.org/rules-guidance/rulebooks/finra-rules/11140',
        expectedSelector: '.field--name-field-tab-content .field--name-body.field__item',
        rationale: 'Canonical capture metadata binds the official URL, final URL, scoped DOM selector, timestamp, artifact lengths, and SHA-256 digests; it is implementation evidence rather than rule text.',
      },
      {
        path: 'reference/authority-reference/finra/2026-07-31/rule-11140/content.html',
        mediaType: 'text/html',
        disposition: 'usedImplementation',
        referenceId: 'finra-rule-11140-2026-07-31',
        rationale: 'Exact scoped DOM bytes preserve the official current Rule 11140 page body selected at capture time; semantic claims remain limited to the separately locked text-line selectors.',
      },
      {
        path: 'reference/authority-reference/finra/2026-07-31/rule-11140/content.txt',
        mediaType: 'text/plain',
        disposition: 'usedNormative',
        referenceId: 'finra-rule-11140-2026-07-31',
        rationale: 'Exact current FINRA Rule 11140 clauses and amendment metadata are replayed through five byte-bound line-range selectors; no unselected page content is treated as authority.',
      },
      {
        path: 'reference/authority-reference/finra/2026-07-31/notice-00-54/capture.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'finra-notice-00-54-2026-07-31',
        jsonKind: 'webPageCapture',
        expectedCaptureId: 'finra-notice-00-54-2026-07-31',
        expectedAuthorityPageUrl: 'https://www.finra.org/rules-guidance/notices/00-54',
        expectedSelector: 'article.node--type-notices .field--name-body.field__item',
        rationale: 'Canonical capture metadata binds the official URL, final URL, scoped notice selector, timestamp, artifact lengths, and SHA-256 digests; it is implementation evidence rather than current rule authority.',
      },
      {
        path: 'reference/authority-reference/finra/2026-07-31/notice-00-54/content.html',
        mediaType: 'text/html',
        disposition: 'usedImplementation',
        referenceId: 'finra-notice-00-54-2026-07-31',
        rationale: 'Exact scoped DOM bytes preserve historical Notice 00-54 for audit; the notice is explicitly not used as current scheduling authority.',
      },
      {
        path: 'reference/authority-reference/finra/2026-07-31/notice-00-54/content.txt',
        mediaType: 'text/plain',
        disposition: 'usedImplementation',
        referenceId: 'finra-notice-00-54-2026-07-31',
        rationale: 'The exact selected historical passage provides economic explanation for the deferred ex-date and seller distribution obligation; current normative scheduling remains bound to Rule 11140.',
      },
    ],
  },
  {
    projectId: 'authority-investor-gov-2026-07-31',
    rootPath: 'reference/authority-reference/investor-gov',
    reviewFile: 'authority-investor-gov-2026-07-31.review.json',
    files: [
      {
        path: 'reference/authority-reference/investor-gov/2026-07-31/ex-dividend/capture.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'investor-gov-ex-dividend-2026-07-31',
        jsonKind: 'webPageCapture',
        expectedCaptureId: 'investor-gov-ex-dividend-2026-07-31',
        expectedAuthorityPageUrl: 'https://www.investor.gov/introduction-investing/investing-basics/glossary/ex-dividend-dates-when-are-you-entitled-stock-and',
        expectedSelector: 'article.node--type-glossary-term',
        rationale: 'Canonical capture metadata binds the official URL, final URL, scoped article selector, timestamp, artifact lengths, and SHA-256 digests; it is implementation evidence.',
      },
      {
        path: 'reference/authority-reference/investor-gov/2026-07-31/ex-dividend/content.html',
        mediaType: 'text/html',
        disposition: 'usedImplementation',
        referenceId: 'investor-gov-ex-dividend-2026-07-31',
        rationale: 'Exact scoped DOM bytes preserve the official investor-education article for audit; the page is contextual and does not replace FINRA rule authority.',
      },
      {
        path: 'reference/authority-reference/investor-gov/2026-07-31/ex-dividend/content.txt',
        mediaType: 'text/plain',
        disposition: 'usedImplementation',
        referenceId: 'investor-gov-ex-dividend-2026-07-31',
        rationale: 'The exact selected explanatory passage covers special distributions, post-payment ex-date timing, and due-bill delivery context without being represented as normative market rule text.',
      },
    ],
  },
  {
    projectId: 'authority-six-iso-4217-2026-07-31',
    rootPath: 'reference/authority-reference/six',
    reviewFile: 'authority-six-iso-4217-2026-07-31.review.json',
    files: [
      {
        path: 'reference/authority-reference/six/2026-07-31/iso-4217-list-one/iso-4217-list-one.xml',
        mediaType: 'application/xml',
        disposition: 'usedNormative',
        referenceId: 'six-iso-4217-list-one-2026-01-01',
        rationale: 'Official ISO 4217 Maintenance Agency current-currency register bytes support the exact locked CcyTbl selection.',
      },
      {
        path: 'reference/authority-reference/six/2026-07-31/iso-4217-list-three/iso-4217-list-three.xml',
        mediaType: 'application/xml',
        disposition: 'usedNormative',
        referenceId: 'six-iso-4217-list-three-2026-01-01',
        rationale: 'Official ISO 4217 Maintenance Agency historical-currency register bytes support the exact locked HstrcCcyTbl selection.',
      },
    ],
  },
  {
    projectId: 'axiolune-m2-controlled-terminology-candidate',
    rootPath: 'reference/ontology-design-reference/axiolune-controlled-terminology',
    reviewFile: 'axiolune-m2-controlled-terminology-candidate.review.json',
    candidate: true,
    candidateKind: 'generatedEntryEnvelope',
    entryCount: 1172,
    files: [
      {
        path: 'reference/ontology-design-reference/axiolune-controlled-terminology/m2-v0.3-terms.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'axiolune-m2-controlled-terminology',
        rationale: 'Machine-generated authored-term candidate is locked as implementation evidence only; decision.status remains pending and no DRI adoption is inferred.',
      },
    ],
  },
  {
    projectId: 'axiolune-m2-controlled-vocabularies-candidate',
    rootPath: 'reference/ontology-design-reference/axiolune-controlled-vocabularies',
    reviewFile: 'axiolune-m2-controlled-vocabularies-candidate.review.json',
    candidate: true,
    candidateKind: 'generatedEntryEnvelope',
    entryCount: 81,
    files: [
      {
        path: 'reference/ontology-design-reference/axiolune-controlled-vocabularies/m2-v0.3-code-lists.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'axiolune-m2-controlled-vocabularies',
        rationale: 'Machine-generated controlled-vocabulary candidate is locked as implementation evidence only; decision.status remains pending and no DRI adoption is inferred.',
      },
    ],
  },
  {
    projectId: 'axiolune-m2-controlled-quantity-units-candidate',
    rootPath: 'reference/ontology-design-reference/axiolune-controlled-quantity-units',
    reviewFile: 'axiolune-m2-controlled-quantity-units-candidate.review.json',
    candidate: true,
    candidateKind: 'quantityUnitSubset',
    entryCount: 1,
    expectedCandidateDigest: 'sha256:a0e313f0eee878e539d5424998e6d46f8abcb9a392c2dba05ca98530768fb2d4',
    files: [
      {
        path: 'reference/ontology-design-reference/axiolune-controlled-quantity-units/m2-v0.3-quantity-units.json',
        mediaType: 'application/json',
        disposition: 'usedImplementation',
        referenceId: 'axiolune-m2-controlled-quantity-units',
        jsonKind: 'quantityUnitSubset',
        rationale: 'Canonical single-unit Axiolune candidate is locked as implementation evidence only; completeSiRegistry is false, share is explicitly not an SI unit, and exact-byte DRI adoption remains pending.',
      },
    ],
  },
]);

function assertAuthorityRootCoverage(inventoryProjects, projectSpecs = PROJECTS) {
  const configuredRoots = new Set(
    projectSpecs
      .map((project) => project.rootPath)
      .filter((rootPath) => rootPath.startsWith('reference/authority-reference/')),
  );
  const inventoryRoots = inventoryProjects
    .map((project) => project.rootPath)
    .filter((rootPath) => rootPath.startsWith('reference/authority-reference/'));
  const uncovered = inventoryRoots.filter((rootPath) => !configuredRoots.has(rootPath));
  if (uncovered.length > 0) {
    throw new Error(`unreviewed authority reference roots: ${uncovered.sort().join(', ')}`);
  }
}

function outputBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function lockById() {
  const document = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  if (!document || !Array.isArray(document.references)) {
    throw new Error('references.lock.yaml has no references array');
  }
  return new Map(document.references.map((reference) => [reference.id, reference]));
}

function locateLockFile(reference, repoPath) {
  if (!reference || typeof reference.localPath !== 'string' || !Array.isArray(reference.locators)) {
    throw new Error(`${repoPath}: no exact locked reference`);
  }
  const prefix = `${reference.localPath}/`;
  if (!repoPath.startsWith(prefix)) throw new Error(`${repoPath}: outside locked localPath`);
  const relativePath = repoPath.slice(prefix.length);
  const matches = reference.locators.filter((locator) => locator.path === relativePath);
  if (matches.length === 0) throw new Error(`${repoPath}: no locked locator`);
  return matches;
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label}: invalid UTF-8: ${error.message}`);
  }
}

function inspectTextSelections(spec, locators, bytes, inspection) {
  const selectors = locators.filter((locator) => locator.kind === 'textLineRange');
  inspection.textLineSelections = selectors.map((locator, index) => {
    const selected = extractTextLineRangeBytes(bytes, locator.startLine, locator.endLine);
    const validation = validateSourceLocator(locator, {
      at: `${spec.path}.locators[${index}]`,
      selectedBytes: selected,
    });
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    return {
      startLine: locator.startLine,
      endLine: locator.endLine,
      selectionDigest: locator.selectionDigest,
      byteLength: selected.length,
    };
  });
}

function inspectCanonicalJson(spec, bytes, inspection) {
  const decoded = decodeUtf8(bytes, spec.path);
  const value = JSON.parse(decoded);
  const canonical = Buffer.from(canonicalJcs(value), 'utf8');
  const canonicalDocument = spec.jsonKind
    ? Buffer.concat([canonical, Buffer.from('\n', 'ascii')])
    : canonical;
  if (!bytes.equals(canonicalDocument)) {
    throw new Error(`${spec.path}: JSON is not the required canonical JCS document bytes`);
  }
  if (spec.jsonKind === 'micSourceLock') {
    const csv = path.join(path.dirname(path.join(ROOT, ...spec.path.split('/'))), 'ISO10383_MIC.csv');
    if (value.schemaVersion !== '1.0'
        || value.authority !== 'SWIFT as ISO 10383 Registration Authority'
        || value.publicationDate !== '2026-07-13'
        || value.modificationImplementationDate !== '2026-07-27'
        || value.artifact?.path !== 'ISO10383_MIC.csv'
        || value.artifact?.rawSha256 !== fileDigest(csv)
        || !Array.isArray(value.selectors)
        || value.selectors.length !== 3) {
      throw new Error(`${spec.path}: MIC source-lock contract mismatch`);
    }
    inspection.sourceLockKind = spec.jsonKind;
    inspection.boundArtifactDigest = value.artifact.rawSha256;
    inspection.selectorCount = value.selectors.length;
    return;
  }
  if (spec.jsonKind === 'tzdbSourceLock') {
    const directory = path.dirname(path.join(ROOT, ...spec.path.split('/')));
    const archive = path.join(directory, 'tzdata2026c.tar.gz');
    const expectedMembers = new Map([
      ['version', fileDigest(path.join(directory, 'version'))],
      ['zone1970.tab', fileDigest(path.join(directory, 'zone1970.tab'))],
    ]);
    if (value.schemaVersion !== '1.0'
        || value.authority !== 'Internet Assigned Numbers Authority'
        || value.release !== '2026c'
        || value.released !== '2026-07-08'
        || value.archive?.path !== 'tzdata2026c.tar.gz'
        || value.archive?.rawSha256 !== fileDigest(archive)
        || !Array.isArray(value.members)
        || value.members.length !== 2
        || !value.members.every((member) => (
          expectedMembers.get(member.extractedPath) === member.rawSha256
            && member.memberPath === member.extractedPath
        ))
        || !Array.isArray(value.zoneSelectors)
        || value.zoneSelectors.length !== 2) {
      throw new Error(`${spec.path}: tzdb source-lock contract mismatch`);
    }
    inspection.sourceLockKind = spec.jsonKind;
    inspection.boundArtifactDigest = value.archive.rawSha256;
    inspection.memberCount = value.members.length;
    inspection.selectorCount = value.zoneSelectors.length;
    return;
  }
  if (spec.jsonKind === 'quantityUnitSubset') {
    const unit = Array.isArray(value.units) && value.units.length === 1 ? value.units[0] : null;
    const decisionStatus = validateSemanticReviewDecision(
      value.decision,
      `${spec.path}.decision`,
      value.candidateDigest,
    );
    if (value.schemaVersion !== '1.0'
        || value.artifactKind !== 'axioluneControlledQuantityUnitSubset'
        || value.candidateVersion !== '0.3.0'
        || value.profileRef !== 'https://axiolune.ai/profiles/controlled-quantity-unit-subset/1.0'
        || !/^sha256:[0-9a-f]{64}$/u.test(value.candidateDigest || '')
        || value.normativeScope?.completeSiRegistry !== false
        || !unit
        || unit.unitIri !== 'https://axiolune.ai/units/share'
        || unit.siStatus !== 'descriptiveTermForNumberOfEntitiesNotAnSiUnit'
        || unit.coherentUnitOneFactor !== 1) {
      throw new Error(`${spec.path}: controlled Quantity-unit subset contract mismatch`);
    }
    inspection.candidateDigest = fileDigest(path.join(ROOT, ...spec.path.split('/')));
    inspection.semanticCandidateDigest = value.candidateDigest;
    inspection.decisionStatus = decisionStatus;
    inspection.entryCount = value.units.length;
    inspection.completeSiRegistry = value.normativeScope.completeSiRegistry;
    inspection.siStatus = unit.siStatus;
    return;
  }
  if (spec.jsonKind === 'webPageCapture') {
    const directory = path.dirname(path.join(ROOT, ...spec.path.split('/')));
    const expectedArtifacts = new Map([
      ['content.html', 'text/html'],
      ['content.txt', 'text/plain'],
    ]);
    if (value.schemaVersion !== '1.0'
        || value.id !== spec.expectedCaptureId
        || value.authorityPageUrl !== spec.expectedAuthorityPageUrl
        || value.finalUrl !== spec.expectedAuthorityPageUrl
        || value.capturedAt !== '2026-07-31T20:00:00Z'
        || value.captureMethod !== 'Chrome CDP isolated background tab; scoped DOM element serialization'
        || value.contentSelector !== spec.expectedSelector
        || value.htmlNormalization !== 'CRLF/CR converted to LF; Unicode NFC; one terminal LF'
        || value.textNormalization !== 'innerText; CRLF/CR to LF; trim/collapse horizontal whitespace; remove empty lines; Unicode NFC; one terminal LF'
        || !Array.isArray(value.artifacts)
        || value.artifacts.length !== expectedArtifacts.size) {
      throw new Error(`${spec.path}: web-page capture envelope mismatch`);
    }
    for (const artifact of value.artifacts) {
      const expectedMediaType = expectedArtifacts.get(artifact?.path);
      const artifactPath = expectedMediaType
        ? path.join(directory, artifact.path)
        : undefined;
      if (!expectedMediaType
          || artifact.mediaType !== expectedMediaType
          || !artifactPath
          || !fs.existsSync(artifactPath)
          || !fs.statSync(artifactPath).isFile()
          || artifact.byteLength !== fs.statSync(artifactPath).size
          || artifact.digest !== fileDigest(artifactPath)) {
        throw new Error(`${spec.path}: captured artifact metadata mismatch`);
      }
    }
    inspection.sourceLockKind = spec.jsonKind;
    inspection.captureId = value.id;
    inspection.authorityPageUrl = value.authorityPageUrl;
    inspection.contentSelector = value.contentSelector;
    inspection.capturedAt = value.capturedAt;
    inspection.boundArtifactCount = value.artifacts.length;
    return;
  }
  if (value.schemaVersion !== '1.0'
      || value.profileRef !== 'https://axiolune.ai/conformance/m2/0.3.0'
      || value.snapshotVersion !== '0.3.0'
      || canonicalJcs(Object.keys(value).sort()) !== canonicalJcs([
        'candidateDigest', 'decision', 'entries', 'profileRef', 'schemaVersion', 'snapshotVersion',
      ].sort())
      || !Array.isArray(value.entries)
      || value.entries.length === 0) {
    throw new Error(`${spec.path}: candidate envelope mismatch`);
  }
  const semanticDigest = spec.referenceId === 'axiolune-m2-controlled-vocabularies'
    ? codeListCandidateDigest(value.profileRef, value.snapshotVersion, value.entries)
    : spec.referenceId === 'axiolune-m2-controlled-terminology'
      ? termAuthorityCandidateDigest(value.snapshotVersion, value.entries, value.profileRef)
      : null;
  if (semanticDigest === null || value.candidateDigest !== semanticDigest) {
    throw new Error(`${spec.path}: candidate semantic digest mismatch`);
  }
  const decisionStatus = validateSemanticReviewDecision(
    value.decision,
    `${spec.path}.decision`,
    semanticDigest,
  );
  inspection.candidateDigest = value.candidateDigest;
  inspection.decisionStatus = decisionStatus;
  inspection.entryCount = Array.isArray(value.entries) ? value.entries.length : null;
}

function inspectLockedFile(spec, references) {
  const absolute = path.join(ROOT, ...spec.path.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${spec.path}: expected a checked-in regular file`);
  }
  const reference = references.get(spec.referenceId);
  const locators = locateLockFile(reference, spec.path);
  const wholeFile = locators.find((locator) => locator.kind === 'wholeFile');
  if (!wholeFile) throw new Error(`${spec.path}: exact wholeFile locator is required`);
  const wholeFileDigest = computeWholeFileSelectionDigest(wholeFile, absolute);
  if (wholeFileDigest !== wholeFile.selectionDigest) {
    throw new Error(`${spec.path}: wholeFile selection digest mismatch`);
  }
  const bytes = fs.readFileSync(absolute);
  const inspection = {
    byteLength: bytes.length,
    wholeFileSelectionDigest: wholeFile.selectionDigest,
  };
  let reviewMethod;
  if (spec.mediaType === 'application/pdf') {
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))
        || !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF', 'ascii'))) {
      throw new Error(`${spec.path}: invalid PDF boundary markers`);
    }
    inspection.pdfBoundaryMarkers = 'present';
    inspection.semanticLocatorKinds = locators
      .filter((locator) => locator.kind !== 'wholeFile')
      .map((locator) => locator.kind)
      .sort();
    reviewMethod = 'complete byte hashing, PDF header/EOF boundary inspection, and exact locked page-locator metadata review';
  } else if (spec.mediaType === 'application/xml') {
    const selectors = locators.filter((locator) => locator.kind === 'xmlElement');
    if (selectors.length !== 1) throw new Error(`${spec.path}: expected one exact xmlElement locator`);
    const selected = extractUniqueXmlElementBytes(bytes, selectors[0].elementId);
    const actual = computeSelectionDigest(selectors[0], selected);
    if (actual !== selectors[0].selectionDigest) {
      throw new Error(`${spec.path}: XML element selection digest mismatch`);
    }
    inspection.xmlElementId = selectors[0].elementId;
    inspection.xmlElementSelectionDigest = actual;
    inspection.xmlElementByteLength = selected.length;
    reviewMethod = 'fatal UTF-8 XML parse, unique element extraction, exact selection digest verification, and complete byte hashing';
  } else if (spec.mediaType === 'application/json') {
    inspectCanonicalJson(spec, bytes, inspection);
    reviewMethod = spec.jsonKind
      ? 'strict JSON parse, canonical JCS plus one LF document-byte verification, and source/candidate-specific contract binding'
      : 'strict JSON parse, canonical generated-byte check boundary, candidate digest/count verification, and exact DRI-decision validation';
  } else if (spec.mediaType === 'application/gzip') {
    if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) {
      throw new Error(`${spec.path}: invalid gzip boundary markers`);
    }
    inspection.gzipBoundaryMarkers = 'present';
    reviewMethod = 'complete byte hashing and gzip header boundary inspection; exact member replay is enforced by the digest-bound archive extractor runtime';
  } else if (spec.mediaType.startsWith('text/')) {
    const decoded = decodeUtf8(bytes, spec.path);
    if (spec.expectedText !== undefined && decoded !== spec.expectedText) {
      throw new Error(`${spec.path}: exact text contract mismatch`);
    }
    inspectTextSelections(spec, locators, bytes, inspection);
    inspection.lineCount = decoded.split(/\r\n|\n|\r/u).length - (decoded.endsWith('\n') || decoded.endsWith('\r') ? 1 : 0);
    reviewMethod = 'fatal UTF-8 decode, exact locked line-selection replay, selection-digest verification, and complete byte hashing';
  } else {
    throw new Error(`${spec.path}: unsupported review media type`);
  }
  return {
    path: spec.path,
    artifactDigest: fileDigest(absolute),
    mediaType: spec.mediaType,
    disposition: spec.disposition,
    reviewMethod,
    rationale: spec.rationale,
    byteLength: bytes.length,
    inspection,
  };
}

function compile() {
  const inspection = inspectReferenceBundle({ rootDir: ROOT });
  if (!inspection.ok) throw new Error('reference bundle inventory is invalid');
  assertAuthorityRootCoverage(inspection.projects);
  const inventoryByRoot = new Map(
    inspection.projects.map((project) => [project.rootPath, project]),
  );
  const references = lockById();
  const records = [];
  const fragmentProjects = [];
  for (const projectSpec of PROJECTS) {
    const inventory = inventoryByRoot.get(projectSpec.rootPath);
    if (!inventory) throw new Error(`${projectSpec.rootPath}: missing reference project`);
    if (inventory.fileCount !== projectSpec.files.length) {
      throw new Error(`${projectSpec.rootPath}: expected ${projectSpec.files.length} files, got ${inventory.fileCount}`);
    }
    const files = projectSpec.files.map((spec) => inspectLockedFile(spec, references));
    if (projectSpec.candidate) {
      const candidate = files[0].inspection;
      if (!/^sha256:[0-9a-f]{64}$/u.test(candidate.candidateDigest || '')
          || candidate.entryCount !== projectSpec.entryCount
          || !['pending', 'reviewed'].includes(candidate.decisionStatus)
          || (projectSpec.expectedArtifactDigest
            && candidate.candidateDigest !== projectSpec.expectedArtifactDigest)
          || (projectSpec.expectedCandidateDigest
            && candidate.semanticCandidateDigest !== projectSpec.expectedCandidateDigest)) {
        throw new Error(`${projectSpec.projectId}: candidate digest/count/decision mismatch`);
      }
      if (candidate.decisionStatus === 'reviewed') {
        files[0].disposition = 'usedNormative';
        files[0].rationale =
          'Exact candidate bytes have a digest-bound semantic review within their declared '
          + 'scope; the embedded decision envelope and immutable reference lock bind the review, '
          + 'while final release adoption remains a separate terminal operation.';
      }
    }
    const reviewRecord = {
      schemaVersion: '1.0',
      reviewId: projectSpec.projectId,
      reviewDate: REVIEW_DATE,
      reviewerRef: REVIEWER_REF,
      rootPath: projectSpec.rootPath,
      projectDigest: inventory.projectDigest,
      decisionBoundary: projectSpec.candidate
        ? (files[0].inspection.decisionStatus === 'reviewed'
          ? 'Exact candidate bytes and generated semantics are bound to the embedded semantic-review decision; this record does not claim terminal release adoption.'
          : 'Candidate bytes and generated semantics are implementation evidence only; a digest-bound semantic-review decision remains pending.')
        : 'Exact external source bytes were reviewed only within the locked locator scope; no broader semantic import is claimed.',
      files,
      summary: {
        fileCount: files.length,
        usedNormativeCount: files.filter((file) => file.disposition === 'usedNormative').length,
        usedImplementationCount: files.filter((file) => file.disposition === 'usedImplementation').length,
      },
    };
    const reviewRecordRef = {
      kind: 'path',
      root: 'sourceTree',
      path: `docs/ontology/references/reviews/authority/${projectSpec.reviewFile}`,
    };
    const bytes = outputBytes(reviewRecord);
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    records.push({ path: path.join(OUTPUT_DIR, projectSpec.reviewFile), bytes, reviewRecord });
    fragmentProjects.push({
      projectId: projectSpec.projectId,
      rootPath: projectSpec.rootPath,
      projectDigest: inventory.projectDigest,
      files: files.map((file) => ({
        path: file.path,
        artifactDigest: file.artifactDigest,
        mediaType: file.mediaType,
        disposition: file.disposition,
        reviewMethod: file.reviewMethod,
        rationale: file.rationale,
        reviewerRef: REVIEWER_REF,
        reviewRecordRef,
        reviewRecordDigest: digest,
      })),
    });
  }
  const fragment = {
    schemaVersion: '1.0',
    fragmentKind: 'authority-and-internal-candidate-reference-project-fragment',
    reviewDate: REVIEW_DATE,
    reviewerRef: REVIEWER_REF,
    projects: fragmentProjects,
  };
  return {
    inspection,
    records,
    fragment,
    fragmentBytes: outputBytes(fragment),
  };
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/generate-authority-reference-review.cjs (--write|--check)');
  }
  const result = compile();
  const outputs = [
    ...result.records.map((record) => ({ path: record.path, bytes: record.bytes })),
    { path: FRAGMENT_PATH, bytes: result.fragmentBytes },
  ];
  for (const output of outputs) {
    if (write) {
      fs.mkdirSync(path.dirname(output.path), { recursive: true });
      fs.writeFileSync(output.path, output.bytes);
    } else if (!fs.existsSync(output.path) || !fs.readFileSync(output.path).equals(output.bytes)) {
      throw new Error(`${path.relative(ROOT, output.path)} is missing or byte-drifted`);
    }
  }
  return {
    mode: write ? 'write' : 'check',
    projectCount: result.fragment.projects.length,
    fileCount: result.fragment.projects.reduce((sum, project) => sum + project.files.length, 0),
    pendingCandidateCount: result.records.filter((record) => (
      record.reviewRecord.files[0]?.inspection?.decisionStatus === 'pending'
    )).length,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL authority reference review: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  PROJECTS,
  assertAuthorityRootCoverage,
  compile,
  outputBytes,
  run,
};
