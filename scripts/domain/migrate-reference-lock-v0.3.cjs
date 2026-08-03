#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('./lib/strict-source-locator.cjs');
const {
  extractRdfXmlResourceBytes,
} = require('./lib/rdf-resource-source-extractor.cjs');
const {
  collectActiveReferenceEvidence,
} = require('./lib/active-reference-evidence.cjs');
const {
  validateSemanticReviewDecision,
} = require('./lib/authority-decision.cjs');
const {
  digestCandidate: codeListCandidateDigest,
} = require('./lib/source-evidence-reference.cjs');
const {
  digestCandidate: termAuthorityCandidateDigest,
} = require('./lib/term-authority.cjs');
const {
  validateQuantityRegistry,
} = require('./lib/slice-a-source-locks.cjs');
const {
  BUNDLE_TAG,
  PAYWALLED_SENTINEL,
  computeWholeFileSelectionDigest,
  fileDigest,
  u64be,
} = require('./lib/reference-closure.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const COVERAGE_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reference-review-coverage.json',
);
const PROFILE_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'reference-extractors',
  'whole-file-v1.json',
);
const PROFILE_REF = {
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/reference-extractors/whole-file-v1.json',
};
const RDF_RESOURCE_PROFILE_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'reference-extractors',
  'rdf-resource-rdfxml-v1.json',
);
const RDF_RESOURCE_PROFILE_REF = {
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/reference-extractors/rdf-resource-rdfxml-v1.json',
};
const FIBO_RIGHTS_RESOURCE = Object.freeze({
  path: 'CAE/CorporateEvents/SecurityRelatedCorporateActions.rdf',
  mediaType: 'application/rdf+xml',
  resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/CAE/CorporateEvents/SecurityRelatedCorporateActions/RightsExerciseEvent',
});
const RELEASE_FALLBACKS = new Map([
  ['fibo-local-evidence', 'FIBO development snapshot; observed versionIRI 20260701'],
  ['finregont-fibo-import-pattern', 'unversioned-local-snapshot'],
  ['lean', 'unversioned-local-snapshot'],
]);
const MATURITY = new Map([
  ['fibo-local-evidence', 'development-ontology-snapshot'],
  ['finregont-fibo-import-pattern', 'implementation-pattern-snapshot'],
]);
const MANUALLY_LOCKED_INTERNAL_CANDIDATE_PATHS = new Set([
  'reference/ontology-design-reference/axiolune-controlled-quantity-units',
  'reference/ontology-design-reference/axiolune-controlled-terminology',
  'reference/ontology-design-reference/axiolune-controlled-vocabularies',
]);
const INTERNAL_CANDIDATES = new Map([
  [
    'reference/ontology-design-reference/axiolune-controlled-quantity-units',
    {
      fileName: 'm2-v0.3-quantity-units.json',
      finalLf: true,
      kind: 'quantityUnits',
      releasePrefix: 'M2 v0.3 controlled Quantity-unit subset candidate ',
    },
  ],
  [
    'reference/ontology-design-reference/axiolune-controlled-terminology',
    {
      fileName: 'm2-v0.3-terms.json',
      finalLf: false,
      kind: 'terminology',
      releasePrefix: 'M2 v0.3 controlled-terminology candidate ',
    },
  ],
  [
    'reference/ontology-design-reference/axiolune-controlled-vocabularies',
    {
      fileName: 'm2-v0.3-code-lists.json',
      finalLf: false,
      kind: 'vocabularies',
      releasePrefix: 'M2 v0.3 controlled-vocabulary candidate ',
    },
  ],
]);

function posix(value) {
  return value.replace(/\\/gu, '/').replace(/\/+$/u, '');
}

function isManuallyLockedAuthorityReference(source) {
  if (!source || typeof source.localPath !== 'string') return false;
  const localPath = posix(source.localPath);
  return localPath.startsWith('reference/authority-reference/')
    || MANUALLY_LOCKED_INTERNAL_CANDIDATE_PATHS.has(localPath);
}

function bundleDigest(directory) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`candidate reference contains a non-regular entry: ${absolute}`);
    }
  }
  walk(directory);
  files.sort((left, right) => utf8Compare(posix(path.relative(directory, left)), posix(path.relative(directory, right))));
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relativeBytes = Buffer.from(posix(path.relative(directory, file)), 'utf8');
    const bytes = fs.readFileSync(file);
    hash.update(u64be(relativeBytes.length));
    hash.update(relativeBytes);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function refreshInternalCandidate(source, profileDigest, rootDir = ROOT) {
  const localPath = posix(source.localPath);
  const spec = INTERNAL_CANDIDATES.get(localPath);
  if (!spec) return null;
  const directory = path.join(rootDir, ...localPath.split('/'));
  const absolute = path.join(directory, spec.fileName);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${source.id}: missing internal candidate ${localPath}/${spec.fileName}`);
  }
  const bytes = fs.readFileSync(absolute);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const candidate = JSON.parse(decoded);
  const expectedBytes = Buffer.from(
    `${canonicalJcs(candidate)}${spec.finalLf ? '\n' : ''}`,
    'utf8',
  );
  if (!bytes.equals(expectedBytes)) {
    throw new Error(`${source.id}: internal authority must use its exact canonical JSON bytes`);
  }
  let expectedCandidateDigest;
  if (spec.kind === 'vocabularies') {
    if (canonicalJcs(Object.keys(candidate).sort()) !== canonicalJcs([
      'candidateDigest', 'decision', 'entries', 'profileRef', 'schemaVersion', 'snapshotVersion',
    ].sort())
        || candidate.schemaVersion !== '1.0'
        || candidate.profileRef !== 'https://axiolune.ai/conformance/m2/0.3.0'
        || candidate.snapshotVersion !== '0.3.0'
        || !Array.isArray(candidate.entries)
        || candidate.entries.length === 0) {
      throw new Error(`${source.id}: controlled-vocabulary authority header drift`);
    }
    expectedCandidateDigest = codeListCandidateDigest(
      candidate.profileRef,
      candidate.snapshotVersion,
      candidate.entries,
    );
  } else if (spec.kind === 'terminology') {
    if (canonicalJcs(Object.keys(candidate).sort()) !== canonicalJcs([
      'candidateDigest', 'decision', 'entries', 'profileRef', 'schemaVersion', 'snapshotVersion',
    ].sort())
        || candidate.schemaVersion !== '1.0'
        || candidate.profileRef !== 'https://axiolune.ai/conformance/m2/0.3.0'
        || candidate.snapshotVersion !== '0.3.0'
        || !Array.isArray(candidate.entries)
        || candidate.entries.length === 0) {
      throw new Error(`${source.id}: controlled-terminology authority header drift`);
    }
    expectedCandidateDigest = termAuthorityCandidateDigest(
      candidate.snapshotVersion,
      candidate.entries,
      candidate.profileRef,
    );
  } else if (spec.kind === 'quantityUnits') {
    if (canonicalJcs(Object.keys(candidate).sort()) !== canonicalJcs([
      'artifactKind', 'candidateDigest', 'candidateVersion', 'decision',
      'externalContextEvidence', 'normativeScope', 'profileRef', 'schemaVersion', 'units',
    ].sort())) {
      throw new Error(`${source.id}: controlled Quantity-unit authority fields drift`);
    }
    validateQuantityRegistry(candidate);
    expectedCandidateDigest = candidate.candidateDigest;
  } else {
    throw new Error(`${source.id}: unsupported internal authority kind ${spec.kind}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate.candidateDigest || '')
      || candidate.candidateDigest !== expectedCandidateDigest) {
    throw new Error(`${source.id}: internal authority candidate digest mismatch`);
  }
  validateSemanticReviewDecision(
    candidate.decision,
    `${source.id}.decision`,
    expectedCandidateDigest,
  );
  const row = {
    mediaType: 'application/json',
    path: `${localPath}/${spec.fileName}`,
  };
  return {
    ...source,
    releaseOrCommit: `${spec.releasePrefix}${candidate.candidateDigest}`,
    localPath,
    artifactDigest: bundleDigest(directory),
    locators: [buildLocator(localPath, row, profileDigest, rootDir)],
  };
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${path.relative(ROOT, file)}`);
  return fs.readFileSync(file, 'utf8');
}

function cleanText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/鈥\?/gu, '-')
    .replace(/鈫\?/gu, '->')
    .replace(/\s+/gu, ' ')
    .trim();
}

function contextOnlyUsageScope() {
  return 'reviewedContextOnly';
}

function buildLocator(referenceRoot, row, profileDigest, rootDir = ROOT) {
  const relativePath = row.path.slice(referenceRoot.length + 1);
  const absolute = path.join(rootDir, ...row.path.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`used coverage path is not a regular file: ${row.path}`);
  }
  const locator = {
    kind: 'wholeFile',
    path: relativePath,
    mediaType: row.mediaType,
    extractorProfileRef: { ...PROFILE_REF },
    extractorProfileDigest: profileDigest,
    selectionDigest: `sha256:${'0'.repeat(64)}`,
  };
  locator.selectionDigest = computeWholeFileSelectionDigest(locator, absolute);
  return locator;
}

function buildRdfResourceLocator(referenceRoot, row, profileDigest) {
  const relativePath = row.path.slice(referenceRoot.length + 1);
  if (relativePath !== FIBO_RIGHTS_RESOURCE.path
      || row.mediaType !== FIBO_RIGHTS_RESOURCE.mediaType) {
    throw new Error('FIBO RightsExerciseEvent coverage row identity drift');
  }
  const absolute = path.join(ROOT, ...row.path.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`rdfResource coverage path is not a regular file: ${row.path}`);
  }
  const locator = {
    kind: 'rdfResource',
    path: relativePath,
    mediaType: row.mediaType,
    extractorProfileRef: { ...RDF_RESOURCE_PROFILE_REF },
    extractorProfileDigest: profileDigest,
    selectionDigest: `sha256:${'0'.repeat(64)}`,
    resourceIri: FIBO_RIGHTS_RESOURCE.resourceIri,
  };
  const selected = extractRdfXmlResourceBytes(
    fs.readFileSync(absolute),
    locator.resourceIri,
  );
  locator.selectionDigest = computeSelectionDigest(locator, selected);
  return locator;
}

function copyDefined(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source[field] !== undefined) result[field] = source[field];
  }
  return result;
}

function buildReferenceLock(
  authoring,
  coverage,
  profileDigest,
  rdfResourceProfileDigest,
  activeLocatorRecords = null,
) {
  if (!authoring || !Array.isArray(authoring.references)) {
    throw new Error('references.lock.yaml has no reference list');
  }
  if (!coverage || coverage.schemaVersion !== '1.0' || !Array.isArray(coverage.projects)) {
    throw new Error('reference-review-coverage.json is not the strict aggregate');
  }
  const projectByRoot = new Map(coverage.projects.map((project) => [project.rootPath, project]));
  const references = [];

  for (const source of authoring.references) {
    if (!source || typeof source.id !== 'string') throw new Error('reference entry has no id');
    if (source.artifactDigest === PAYWALLED_SENTINEL) {
      references.push({
        ...copyDefined(source, [
          'id',
          'authority',
          'releaseOrCommit',
          'artifactUrl',
          'license',
          'retrievalDate',
        ]),
        artifactDigest: PAYWALLED_SENTINEL,
        maturity: 'external-standard',
        usageScope: 'unavailableNormativeReference',
        note: cleanText(source.note || 'Licensed source bytes are unavailable; no local evidence is claimed.'),
        locators: [],
      });
      continue;
    }
    // Authority snapshots and the two exact internal authority candidates
    // have independently governed locators. The aggregate project review can
    // legitimately lag their acquisition or regeneration. Do not silently
    // delete or lossy-rebuild such a lock merely because its category coverage
    // row is not present yet; reference-closure validation remains responsible
    // for failing closed on stale bytes or locators.
    const refreshedCandidate = refreshInternalCandidate(source, profileDigest);
    if (refreshedCandidate) {
      references.push(refreshedCandidate);
      continue;
    }
    if (isManuallyLockedAuthorityReference(source)) {
      if (!Array.isArray(source.locators)) {
        throw new Error(`${source.id}: manually locked authority reference has no locator list`);
      }
      const manual = {
        ...source,
        localPath: posix(source.localPath),
        locators: source.locators.map((locator) => structuredClone(locator)),
      };
      manual.locators.sort(
        (left, right) => utf8Compare(canonicalJcs(left), canonicalJcs(right)),
      );
      references.push(manual);
      continue;
    }
    if (typeof source.localPath !== 'string') {
      throw new Error(`${source.id}: non-paywalled reference has no checked-in localPath`);
    }
    const localPath = posix(source.localPath);
    const project = projectByRoot.get(localPath);
    const usedRows = coverage.projects
      .flatMap((candidate) => candidate.files)
      .filter(
        (row) => row.path.startsWith(`${localPath}/`)
          && ['usedNormative', 'usedImplementation'].includes(row.disposition),
      );
    if (usedRows.length === 0) {
      // Exact project provenance and semantic use are separate contracts. A
      // fully reviewed project still needs its bundle pin so rejected/no-bearing
      // decisions remain reproducible, but no file locator may survive without
      // an active downstream consumer.
      if (project) {
        const releaseOrCommit = project.releaseOrCommit || cleanText(source.releaseOrCommit);
        if (!releaseOrCommit) {
          throw new Error(`${source.id}: reviewed context has no honest release/snapshot label`);
        }
        references.push({
          ...copyDefined(source, [
            'id',
            'authority',
            'artifactUrl',
            'license',
            'retrievalDate',
          ]),
          releaseOrCommit,
          maturity: cleanText(source.maturity) || 'reviewed-context-snapshot',
          usageScope: contextOnlyUsageScope(source),
          note: cleanText(
            source.note
              || 'Exact checked-in project provenance for reviewed context only; no active semantic locator is claimed.',
          ),
          localPath,
          artifactDigest: project.projectDigest,
          locators: [],
        });
      }
      continue;
    }
    if (!project) {
      throw new Error(`${source.id}: used localPath must equal one reviewed project root`);
    }
    let locators;
    if (Array.isArray(activeLocatorRecords)) {
      locators = activeLocatorRecords
        .filter((record) => record.referenceId === source.id)
        .map((record) => structuredClone(record.locator));
      if (locators.length === 0) {
        throw new Error(`${source.id}: used coverage rows have no exact active downstream locators`);
      }
      const usedPaths = new Set(usedRows.map((row) => row.path));
      for (const locator of locators) {
        const fullPath = `${localPath}/${locator.path}`;
        if (!usedPaths.has(fullPath)) {
          throw new Error(`${source.id}: active locator file is not marked used in coverage: ${fullPath}`);
        }
      }
    } else {
      // Compatibility path for pure unit fixtures. Production migration passes
      // exact machine-readable downstream locators and never widens a selector
      // merely because coverage is file-granular.
      locators = usedRows
        .filter((row) => !(
          source.id === 'fibo-local-evidence'
          && row.path === `${localPath}/${FIBO_RIGHTS_RESOURCE.path}`
        ))
        .map((row) => buildLocator(localPath, row, profileDigest));
    }
    if (!Array.isArray(activeLocatorRecords) && source.id === 'fibo-local-evidence') {
      if (typeof rdfResourceProfileDigest !== 'string') {
        throw new Error('FIBO exact rdfResource extractor profile digest is required');
      }
      const rightsRow = usedRows.find(
        (row) => row.path === `${localPath}/${FIBO_RIGHTS_RESOURCE.path}`,
      );
      if (!rightsRow) {
        throw new Error('FIBO RightsExerciseEvent source file is not marked semantically used');
      }
      locators.push(buildRdfResourceLocator(
        localPath,
        rightsRow,
        rdfResourceProfileDigest,
      ));
    }
    locators.sort((left, right) => utf8Compare(canonicalJcs(left), canonicalJcs(right)));
    const releaseOrCommit = project.releaseOrCommit
      || RELEASE_FALLBACKS.get(source.id)
      || cleanText(source.releaseOrCommit);
    if (!releaseOrCommit) throw new Error(`${source.id}: no honest release/snapshot label`);
    const hasNormative = usedRows.some((row) => row.disposition === 'usedNormative');
    references.push({
      ...copyDefined(source, [
        'id',
        'authority',
        'artifactUrl',
        'license',
        'retrievalDate',
        'pinnedVersionIRI',
        'importPolicy',
      ]),
      releaseOrCommit,
      maturity: MATURITY.get(source.id) || 'implementation-reference-snapshot',
      usageScope: hasNormative
        ? 'ontologyAlignmentAndImplementationEvidence'
        : 'implementationEvidence',
      note: source.id === 'fibo-local-evidence'
        ? 'Exact checked-in FIBO development snapshot used selectively for reviewed alignments; it is not wholesale-imported and is not represented as a Production release.'
        : cleanText(source.note || 'Exact checked-in implementation evidence; not a normative financial authority.'),
      localPath,
      artifactDigest: project.projectDigest,
      locators,
    });
  }
  return {
    lockVersion: '0.3.0',
    updated: '2026-08-01',
    note: 'Deterministic M2 v0.3 reference lock. Local artifact digests cover complete reviewed project roots; only semantically used files receive strict SourceLocators. Paywalled sources use the explicit unavailable sentinel.',
    references,
  };
}

function lockBytes(value) {
  return Buffer.from(YAML.stringify(value, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  }), 'utf8');
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check) throw new Error('choose exactly one mode: --write or --check');
  const source = YAML.parse(requireFile(LOCK_PATH, 'reference lock'));
  const coverage = JSON.parse(requireFile(COVERAGE_PATH, 'reference review coverage'));
  const profileDigest = fileDigest(PROFILE_PATH);
  const rdfResourceProfileDigest = fileDigest(RDF_RESOURCE_PROFILE_PATH);
  const activeLocatorRecords = collectActiveReferenceEvidence(ROOT, source).locators;
  const result = buildReferenceLock(
    source,
    coverage,
    profileDigest,
    rdfResourceProfileDigest,
    activeLocatorRecords,
  );
  const expected = lockBytes(result);
  if (write) {
    fs.writeFileSync(LOCK_PATH, expected);
  } else if (!fs.readFileSync(LOCK_PATH).equals(expected)) {
    throw new Error('references.lock.yaml is not deterministic v0.3 output');
  }
  return {
    mode: write ? 'write' : 'check',
    referenceCount: result.references.length,
    localReferenceCount: result.references.filter(
      (reference) => reference.artifactDigest !== PAYWALLED_SENTINEL,
    ).length,
    paywalledReferenceCount: result.references.filter(
      (reference) => reference.artifactDigest === PAYWALLED_SENTINEL,
    ).length,
    locatorCount: result.references.reduce(
      (total, reference) => total + reference.locators.length,
      0,
    ),
    extractorProfileDigest: profileDigest,
    rdfResourceExtractorProfileDigest: rdfResourceProfileDigest,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL reference lock migration: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildReferenceLock,
  contextOnlyUsageScope,
  isManuallyLockedAuthorityReference,
  lockBytes,
  refreshInternalCandidate,
  run,
};
