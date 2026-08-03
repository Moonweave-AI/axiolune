'use strict';

const crypto = require('node:crypto');
const {
  PROFILE_REF,
  artifactDigest,
  compilePublicSymbolManifest,
  utf8Compare,
} = require('./public-symbol-compiler.cjs');
const { canonicalJcs, validateSourceLocator } = require('./strict-source-locator.cjs');
const {
  validateImplementationEvidencePolicy,
} = require('./source-evidence-reference.cjs');
const { validateSemanticReviewDecision } = require('./authority-decision.cjs');
const {
  candidateM3TypeAllowedForContainer,
  deriveTermCardSemantics,
} = require('./term-card-semantics.cjs');

const TERM_AUTHORITY_TAG = Buffer.from('axiolune-term-authority-candidate-v1\0', 'utf8');
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const AUTHORITY_KINDS = new Set([
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
const CONTAINER_KINDS = new Set([
  'objectTypes',
  'associationTypes',
  'relationTypes',
  'attributeTypes',
  'identifierTypes',
  'codeLists',
  'constraints',
]);

class TermAuthorityError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'TermAuthorityError';
    this.errors = errors;
  }
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactFields(value, expected, at, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${at} must be a closed object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (canonicalJcs(actual) !== canonicalJcs(fields)) {
    errors.push(`${at} fields must equal ${fields.join(', ')}`);
    return false;
  }
  return true;
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

function nonEmptyNfc(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.normalize('NFC')
    && !hasUnpairedSurrogate(value);
}

function isAbsoluteCanonicalIri(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
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

function digestCandidate(snapshotVersion, entries, profileRef = PROFILE_REF) {
  const hash = crypto.createHash('sha256');
  hash.update(TERM_AUTHORITY_TAG);
  hash.update(Buffer.from(canonicalJcs({ entries, profileRef, snapshotVersion }), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function referenceMap(lock) {
  const result = new Map();
  if (!isPlainObject(lock) || !Array.isArray(lock.references)) return result;
  for (const reference of lock.references) {
    if (isPlainObject(reference) && typeof reference.id === 'string') {
      if (!result.has(reference.id)) result.set(reference.id, []);
      result.get(reference.id).push(reference);
    }
  }
  return result;
}

function validateUpstreamEvidence(evidence, at, references, errors) {
  if (!exactFields(
    evidence,
    ['locator', 'rationale', 'referenceId', 'transformation', 'usage'],
    at,
    errors,
  )) return;
  if (typeof evidence.referenceId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(evidence.referenceId)) {
    errors.push(`${at}.referenceId must be a canonical ASCII reference ID`);
  }
  if (!UPSTREAM_USAGES.has(evidence.usage)) {
    errors.push(`${at}.usage is unsupported`);
  }
  if (!UPSTREAM_TRANSFORMATIONS.has(evidence.transformation)) {
    errors.push(`${at}.transformation is unsupported`);
  }
  if (!nonEmptyNfc(evidence.rationale)) {
    errors.push(`${at}.rationale must be non-empty Unicode-NFC text`);
  }
  const locatorResult = validateSourceLocator(evidence.locator, { at: `${at}.locator` });
  errors.push(...locatorResult.errors);
  const matches = references.get(evidence.referenceId) || [];
  if (matches.length !== 1) {
    errors.push(`${at}.referenceId must resolve exactly one references.lock.yaml record`);
    return;
  }
  validateImplementationEvidencePolicy(evidence, matches[0], at, errors);
  let key;
  try {
    key = canonicalJcs(evidence.locator);
  } catch (error) {
    errors.push(`${at}.locator cannot be canonicalized: ${error.message}`);
    return;
  }
  const locators = Array.isArray(matches[0].locators) ? matches[0].locators : [];
  const locatorMatches = locators.filter((locator) => {
    try {
      return canonicalJcs(locator) === key;
    } catch {
      return false;
    }
  });
  if (locatorMatches.length !== 1) {
    errors.push(`${at}.locator must be byte-identical to exactly one locked locator`);
  }
}

function validateAuthorityRequirements(entry, at, errors) {
  if (!AUTHORITY_KINDS.has(entry.authorityKind)) {
    errors.push(`${at}.authorityKind is unsupported`);
    return;
  }
  const upstream = Array.isArray(entry.upstreamEvidence) ? entry.upstreamEvidence : [];
  if (entry.authorityKind === 'externalExact'
      && !upstream.some(
        (evidence) => evidence.usage === 'normative'
          && evidence.transformation === 'exactIdentity',
      )) {
    errors.push(`${at} externalExact requires normative exactIdentity evidence`);
  }
  if (entry.authorityKind === 'externalExact'
      && !upstream.some((evidence) => evidence.usage === 'normative'
        && evidence.transformation === 'exactIdentity'
        && evidence.locator
        && evidence.locator.kind === 'rdfResource'
        && evidence.locator.resourceIri === entry.publicIri)) {
    errors.push(
      `${at} externalExact requires a normative exactIdentity rdfResource whose resourceIri `
      + 'equals the authored publicIri; a local alias or semantic adaptation must use externalAdapted',
    );
  }
  if (entry.authorityKind === 'externalAdapted'
      && !upstream.some((evidence) => evidence.usage === 'normative')) {
    errors.push(`${at} externalAdapted requires normative evidence`);
  }
  if (entry.authorityKind === 'implementationAdopted') {
    errors.push(
      `${at} implementationAdopted is prohibited by M2-PLAN; `
      + 'implementation projects may supply contextOnly evidence, never canonical term authority',
    );
  }
  if (entry.authorityKind === 'axioluneComposite' && upstream.length < 2) {
    errors.push(`${at} axioluneComposite requires at least two upstream evidence records`);
  }
}

function compareCanonical(left, right) {
  return utf8Compare(canonicalJcs(left), canonicalJcs(right));
}

function canonicalEvidence(records) {
  return [...records].sort(compareCanonical);
}

function validateSortedNonEmptyTextArray(value, at, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${at} must be a non-empty array`);
    return;
  }
  let previous = null;
  value.forEach((item, index) => {
    if (!nonEmptyNfc(item)) {
      errors.push(`${at}[${index}] must be non-empty Unicode-NFC text`);
      return;
    }
    if (previous !== null && utf8Compare(previous, item) >= 0) {
      errors.push(`${at} must be strictly UTF-8 sorted and unique`);
    }
    previous = item;
  });
}

function codeListIriSet(moduleDocs) {
  const result = new Set();
  for (const document of moduleDocs) {
    const codeLists = document
      && document.domain
      && document.domain.codeLists;
    if (!isPlainObject(codeLists)) continue;
    for (const definition of Object.values(codeLists)) {
      if (isPlainObject(definition) && typeof definition.iri === 'string') {
        result.add(definition.iri);
      }
    }
  }
  return result;
}

function mergeTermAuthorityOverrides(moduleDocs, termOverrides, codeListOverrides) {
  const errors = [];
  const explicit = termOverrides === undefined || termOverrides === null
    ? { schemaVersion: '1.0', entries: [] }
    : termOverrides;
  const codeLists = codeListOverrides === undefined || codeListOverrides === null
    ? { schemaVersion: '1.0', entries: [] }
    : codeListOverrides;
  const selectedCodeLists = codeListIriSet(moduleDocs);

  if (!exactFields(explicit, ['entries', 'schemaVersion'], 'termOverrides', errors)
      || explicit.schemaVersion !== '1.0'
      || !Array.isArray(explicit.entries)) {
    errors.push('termOverrides must be schemaVersion 1.0 with an entries array');
  }
  if (!exactFields(codeLists, ['entries', 'schemaVersion'], 'codeListOverrides', errors)
      || codeLists.schemaVersion !== '1.0'
      || !Array.isArray(codeLists.entries)) {
    errors.push('codeListOverrides must be schemaVersion 1.0 with an entries array');
  }
  if (errors.length > 0) throw new TermAuthorityError(errors);

  const entries = [];
  const seen = new Set();
  explicit.entries.forEach((entry, index) => {
    const at = `termOverrides.entries[${index}]`;
    if (!exactFields(
      entry,
      ['authorityKind', 'publicIri', 'upstreamEvidence'],
      at,
      errors,
    )) return;
    if (typeof entry.publicIri !== 'string') {
      errors.push(`${at}.publicIri must be a string`);
      return;
    }
    if (seen.has(entry.publicIri)) {
      errors.push(`${at}.publicIri is duplicated across authority override inputs`);
      return;
    }
    seen.add(entry.publicIri);
    entries.push(structuredClone(entry));
  });
  codeLists.entries.forEach((entry, index) => {
    const at = `codeListOverrides.entries[${index}]`;
    if (!exactFields(
      entry,
      ['authorityKind', 'codeListIri', 'rationale', 'upstreamEvidence'],
      at,
      errors,
    )) return;
    if (typeof entry.codeListIri !== 'string' || !selectedCodeLists.has(entry.codeListIri)) {
      errors.push(`${at}.codeListIri must select one current domain CodeListDefinition`);
      return;
    }
    if (!nonEmptyNfc(entry.rationale)) {
      errors.push(`${at}.rationale must be non-empty Unicode-NFC text`);
    }
    if (seen.has(entry.codeListIri)) {
      errors.push(`${at}.codeListIri is duplicated across authority override inputs`);
      return;
    }
    seen.add(entry.codeListIri);
    entries.push({
      authorityKind: entry.authorityKind,
      publicIri: entry.codeListIri,
      upstreamEvidence: structuredClone(entry.upstreamEvidence),
    });
  });
  if (errors.length > 0) throw new TermAuthorityError(errors);
  return {
    entries: entries.sort((left, right) => utf8Compare(left.publicIri, right.publicIri)),
    schemaVersion: '1.0',
  };
}

function authoredElements(moduleDocs, errors) {
  const result = new Map();
  const publicManifest = compilePublicSymbolManifest(moduleDocs).manifest;
  const authoredSymbols = new Map(
    publicManifest.symbols
      .filter((symbol) => symbol.origin === 'authored')
      .map((symbol) => [symbol.publicIri, symbol]),
  );
  moduleDocs.forEach((document, moduleIndex) => {
    const at = `moduleDocs[${moduleIndex}]`;
    if (!isPlainObject(document)
        || !isPlainObject(document.module)
        || !isPlainObject(document.domain)) {
      errors.push(`${at} must contain module and domain objects`);
      return;
    }
    const exports = new Set(Array.isArray(document.module.exports) ? document.module.exports : []);
    const exportsAll = exports.size === 0;
    for (const containerKind of CONTAINER_KINDS) {
      const container = document.domain[containerKind];
      if (container === undefined) continue;
      if (!isPlainObject(container)) {
        errors.push(`${at}.domain.${containerKind} must be an object map`);
        continue;
      }
      for (const [localName, element] of Object.entries(container)) {
        if (!isPlainObject(element)
            || typeof element.iri !== 'string'
            || (!exportsAll && !exports.has(element.iri))) continue;
        const symbol = authoredSymbols.get(element.iri);
        if (!symbol) {
          errors.push(`${at}.domain.${containerKind}.${localName} has no authored public symbol`);
          continue;
        }
        if (result.has(element.iri)) {
          errors.push(`${at}.domain.${containerKind}.${localName} duplicates ${element.iri}`);
          continue;
        }
        if (!nonEmptyNfc(element.label) || !nonEmptyNfc(element.definition)) {
          errors.push(
            `${at}.domain.${containerKind}.${localName} requires non-empty NFC label and definition`,
          );
          continue;
        }
        if (!isAbsoluteCanonicalIri(document.module.moduleIri)
            || !isAbsoluteCanonicalIri(
              document.module.governance && document.module.governance.ownerRef,
            )
            || !SEMVER_RE.test(document.module.version || '')) {
          errors.push(
            `${at}.module requires canonical moduleIri, governance.ownerRef, and SemVer`,
          );
          continue;
        }
        let termSemantics;
        try {
          termSemantics = deriveTermCardSemantics(containerKind, element);
        } catch (error) {
          errors.push(
            `${at}.domain.${containerKind}.${localName} term-card semantics failed: ${error.message}`,
          );
          continue;
        }
        result.set(element.iri, {
          ...termSemantics,
          containerKind,
          definition: element.definition,
          ownerModule: document.module.moduleIri,
          ownerRef: document.module.governance && document.module.governance.ownerRef,
          preferredLabel: element.label,
          publicIri: element.iri,
          sourceElementKey: symbol.sourceElementKey,
          version: document.module.version,
        });
      }
    }
  });
  if (result.size !== authoredSymbols.size) {
    errors.push(
      `authored term inventory has ${result.size} rows but public-symbol manifest has `
      + `${authoredSymbols.size}`,
    );
  }
  return result;
}

function compileTermAuthorityCandidate(moduleDocs, overrideDocument, lock) {
  const errors = [];
  let sourceElements;
  try {
    sourceElements = authoredElements(moduleDocs, errors);
  } catch (error) {
    throw new TermAuthorityError([error.message]);
  }
  const references = referenceMap(lock);
  const overrides = new Map();
  if (overrideDocument !== undefined && overrideDocument !== null) {
    if (!exactFields(overrideDocument, ['entries', 'schemaVersion'], 'overrides', errors)) {
      throw new TermAuthorityError(errors);
    }
    if (overrideDocument.schemaVersion !== '1.0' || !Array.isArray(overrideDocument.entries)) {
      errors.push('overrides must be schemaVersion 1.0 with an entries array');
    } else {
      overrideDocument.entries.forEach((override, index) => {
        const at = `overrides.entries[${index}]`;
        if (!exactFields(
          override,
          ['authorityKind', 'publicIri', 'upstreamEvidence'],
          at,
          errors,
        )) return;
        if (typeof override.publicIri !== 'string' || !sourceElements.has(override.publicIri)) {
          errors.push(`${at}.publicIri does not select one authored public symbol`);
          return;
        }
        if (overrides.has(override.publicIri)) {
          errors.push(`${at}.publicIri is duplicated`);
          return;
        }
        if (!Array.isArray(override.upstreamEvidence)) {
          errors.push(`${at}.upstreamEvidence must be an array`);
          return;
        }
        override.upstreamEvidence.forEach((evidence, evidenceIndex) => {
          validateUpstreamEvidence(
            evidence,
            `${at}.upstreamEvidence[${evidenceIndex}]`,
            references,
            errors,
          );
        });
        validateAuthorityRequirements(override, at, errors);
        overrides.set(override.publicIri, override);
      });
    }
  }
  const entries = [...sourceElements.values()]
    .sort((left, right) => utf8Compare(left.publicIri, right.publicIri))
    .map((source) => {
      const override = overrides.get(source.publicIri);
      return {
        authorityKind: override ? override.authorityKind : 'axioluneOperational',
        candidateM3Type: source.candidateM3Type,
        containerKind: source.containerKind,
        definition: source.definition,
        definitionDigest: artifactDigest(Buffer.from(source.definition, 'utf8')),
        differentia: source.differentia,
        excludes: source.excludes,
        genus: source.genus,
        ownerModule: source.ownerModule,
        ownerRef: source.ownerRef,
        preferredLabel: source.preferredLabel,
        publicIri: source.publicIri,
        sourceElementKey: source.sourceElementKey,
        upstreamEvidence: override ? canonicalEvidence(override.upstreamEvidence) : [],
        version: source.version,
      };
    });
  if (errors.length > 0) throw new TermAuthorityError(errors);
  return {
    candidateDigest: digestCandidate('0.3.0', entries),
    decision: { status: 'pending' },
    entries,
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    snapshotVersion: '0.3.0',
  };
}

function validateTermAuthorityManifest(manifest, moduleDocs, lock, overrideDocument = undefined) {
  const errors = [];
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
    'manifest',
    errors,
  )) return { errors, ok: false };
  if (manifest.schemaVersion !== '1.0') errors.push('manifest.schemaVersion must equal 1.0');
  if (manifest.profileRef !== PROFILE_REF) errors.push(`manifest.profileRef must equal ${PROFILE_REF}`);
  if (!SEMVER_RE.test(manifest.snapshotVersion || '')) {
    errors.push('manifest.snapshotVersion must be canonical SemVer');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push('manifest.entries must be a non-empty array');
    return { errors, ok: false };
  }
  const references = referenceMap(lock);
  let previous = null;
  const publicIris = new Set();
  manifest.entries.forEach((entry, index) => {
    const at = `manifest.entries[${index}]`;
    if (!exactFields(
      entry,
      [
        'authorityKind',
        'candidateM3Type',
        'containerKind',
        'definition',
        'definitionDigest',
        'differentia',
        'excludes',
        'genus',
        'ownerModule',
        'ownerRef',
        'preferredLabel',
        'publicIri',
        'sourceElementKey',
        'upstreamEvidence',
        'version',
      ],
      at,
      errors,
    )) return;
    if (!CONTAINER_KINDS.has(entry.containerKind)) {
      errors.push(`${at}.containerKind is unsupported`);
    }
    for (const field of ['definition', 'genus', 'preferredLabel']) {
      if (!nonEmptyNfc(entry[field])) errors.push(`${at}.${field} must be non-empty NFC text`);
    }
    validateSortedNonEmptyTextArray(entry.differentia, `${at}.differentia`, errors);
    validateSortedNonEmptyTextArray(entry.excludes, `${at}.excludes`, errors);
    if (!isAbsoluteCanonicalIri(entry.publicIri)
        || !isAbsoluteCanonicalIri(entry.candidateM3Type)
        || !isAbsoluteCanonicalIri(entry.ownerModule)
        || !isAbsoluteCanonicalIri(entry.ownerRef)) {
      errors.push(
        `${at} publicIri, candidateM3Type, ownerModule, and ownerRef must be absolute IRIs`,
      );
    }
    if (!candidateM3TypeAllowedForContainer(entry.containerKind, entry.candidateM3Type)) {
      errors.push(
        `${at}.candidateM3Type must equal the canonical M3 type for ${entry.containerKind}`,
      );
    }
    if (!DIGEST_RE.test(entry.sourceElementKey || '')
        || !DIGEST_RE.test(entry.definitionDigest || '')) {
      errors.push(`${at} sourceElementKey and definitionDigest must be SHA-256 digests`);
    }
    if (nonEmptyNfc(entry.definition)) {
      const expected = artifactDigest(Buffer.from(entry.definition, 'utf8'));
      if (entry.definitionDigest !== expected) {
        errors.push(`${at}.definitionDigest must equal ${expected}`);
      }
    }
    if (!SEMVER_RE.test(entry.version || '')) errors.push(`${at}.version must be canonical SemVer`);
    if (previous !== null && utf8Compare(previous, entry.publicIri || '') >= 0) {
      errors.push(`${at}.publicIri must be strictly UTF-8 sorted and unique`);
    }
    previous = entry.publicIri;
    if (publicIris.has(entry.publicIri)) errors.push(`${at}.publicIri is duplicated`);
    publicIris.add(entry.publicIri);
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
      entry.upstreamEvidence.forEach((evidence, evidenceIndex) => {
        validateUpstreamEvidence(
          evidence,
          `${at}.upstreamEvidence[${evidenceIndex}]`,
          references,
          errors,
        );
      });
    }
    validateAuthorityRequirements(entry, at, errors);
  });
  let expectedCandidate;
  try {
    expectedCandidate = digestCandidate(
      manifest.snapshotVersion,
      manifest.entries,
      manifest.profileRef,
    );
  } catch (error) {
    errors.push(`manifest candidate cannot be canonicalized: ${error.message}`);
  }
  if (!DIGEST_RE.test(manifest.candidateDigest || '')
      || (expectedCandidate && manifest.candidateDigest !== expectedCandidate)) {
    errors.push(`manifest.candidateDigest must equal ${expectedCandidate || 'the tagged digest'}`);
  }
  if (!isPlainObject(manifest.decision)) {
    errors.push('manifest.decision must be a closed object');
  } else if (manifest.decision.status === 'pending') {
    decisionStatus = 'pending';
    exactFields(manifest.decision, ['status'], 'manifest.decision', errors);
  } else if (manifest.decision.status === 'reviewed'
      || manifest.decision.status === 'adopted') {
    try {
      decisionStatus = validateSemanticReviewDecision(
        manifest.decision,
        'manifest.decision',
        expectedCandidate,
      );
    } catch (cause) {
      decisionStatus = `unverified-${manifest.decision.status}`;
      errors.push(cause.message);
    }
  } else {
    errors.push('manifest.decision.status must be pending or reviewed');
  }

  let expected;
  try {
    const projectionOverrides = overrideDocument === undefined
      ? {
        schemaVersion: '1.0',
        entries: manifest.entries
          .filter((entry) => entry.authorityKind !== 'axioluneOperational'
            || entry.upstreamEvidence.length > 0)
          .map((entry) => ({
            authorityKind: entry.authorityKind,
            publicIri: entry.publicIri,
            upstreamEvidence: entry.upstreamEvidence,
          })),
      }
      : overrideDocument;
    expected = compileTermAuthorityCandidate(moduleDocs, projectionOverrides, lock);
  } catch (error) {
    errors.push(...(error instanceof TermAuthorityError ? error.errors : [error.message]));
  }
  if (expected) {
    const actualComparable = {
      candidateDigest: manifest.candidateDigest,
      entries: manifest.entries,
      profileRef: manifest.profileRef,
      schemaVersion: manifest.schemaVersion,
      snapshotVersion: manifest.snapshotVersion,
    };
    const expectedComparable = {
      candidateDigest: expected.candidateDigest,
      entries: expected.entries,
      profileRef: expected.profileRef,
      schemaVersion: expected.schemaVersion,
      snapshotVersion: expected.snapshotVersion,
    };
    if (canonicalJcs(actualComparable) !== canonicalJcs(expectedComparable)) {
      errors.push('manifest entries are not the exact projection of current module definitions');
    }
  }
  return {
    candidateDigest: expectedCandidate,
    decisionStatus,
    errors,
    ok: errors.length === 0,
  };
}

module.exports = {
  AUTHORITY_KINDS,
  TERM_AUTHORITY_TAG,
  TermAuthorityError,
  compileTermAuthorityCandidate,
  digestCandidate,
  mergeTermAuthorityOverrides,
  validateTermAuthorityManifest,
};
