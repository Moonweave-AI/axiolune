'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  REQUIRED_REFERENCE_PROFILES,
} = require('./post-trade-authority-evidence.cjs');
const {
  REQUIRED_DECISIONS,
  sha256,
} = require('./reviewed-no-alignment.cjs');

const CANDIDATE_PATHS = Object.freeze([
  'reference/ontology-design-reference/axiolune-controlled-vocabularies/m2-v0.3-code-lists.json',
  'reference/ontology-design-reference/axiolune-controlled-terminology/m2-v0.3-terms.json',
]);
const OVERRIDE_PATHS = Object.freeze([
  'docs/ontology/references/code-list-authority-overrides.json',
  'docs/ontology/references/term-authority-overrides.json',
]);
const NO_ALIGNMENT_DECISION_PATH = 'docs/ontology/alignments/reviewed-no-alignment-decisions-v1.json';

function posix(value) {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '');
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function subsetLocatorMatch(locator, required) {
  if (!isPlainObject(locator) || !isPlainObject(required)) return false;
  return Object.entries(required).every(([field, expected]) => (
    Object.prototype.hasOwnProperty.call(locator, field)
      && canonicalJcs(locator[field]) === canonicalJcs(expected)
  ));
}

function collectActiveReferenceEvidence(rootDir, lock) {
  if (!lock || !Array.isArray(lock.references)) {
    throw new Error('reference lock must contain a references array');
  }
  const references = new Map();
  for (const reference of lock.references) {
    if (!reference || typeof reference.id !== 'string') {
      throw new Error('reference lock contains an entry without an id');
    }
    if (references.has(reference.id)) throw new Error(`duplicate reference id ${reference.id}`);
    references.set(reference.id, reference);
  }

  const byPath = new Map();
  const byLocator = new Map();
  const locatorRecords = new Map();
  function add(reference, locator, evidence) {
    if (typeof reference.localPath !== 'string' || typeof locator.path !== 'string') {
      throw new Error(`${reference.id}: active evidence requires localPath and locator.path`);
    }
    const fullPath = `${posix(reference.localPath)}/${posix(locator.path)}`;
    const locatorKey = `${reference.id}\0${canonicalJcs(locator)}`;
    if (!byPath.has(fullPath)) byPath.set(fullPath, []);
    if (!byLocator.has(locatorKey)) byLocator.set(locatorKey, []);
    if (!locatorRecords.has(locatorKey)) {
      locatorRecords.set(locatorKey, {
        referenceId: reference.id,
        locator: structuredClone(locator),
      });
    }
    const record = {
      referenceId: reference.id,
      locatorKind: locator.kind,
      sourceRef: evidence.sourceRef,
      usage: evidence.usage,
    };
    const recordKey = canonicalJcs(record);
    if (!byPath.get(fullPath).some((candidate) => canonicalJcs(candidate) === recordKey)) {
      byPath.get(fullPath).push(record);
      byPath.get(fullPath).sort((left, right) => (
        Buffer.compare(Buffer.from(canonicalJcs(left), 'utf8'), Buffer.from(canonicalJcs(right), 'utf8'))
      ));
    }
    if (!byLocator.get(locatorKey).some((candidate) => canonicalJcs(candidate) === recordKey)) {
      byLocator.get(locatorKey).push(record);
    }
  }

  function requireExactLockedLocator(referenceId, locator, sourceRef, usage) {
    const reference = references.get(referenceId);
    if (!reference || !Array.isArray(reference.locators)) {
      throw new Error(`${sourceRef}: ${referenceId} is not an exact local lock reference`);
    }
    const key = canonicalJcs(locator);
    const matches = reference.locators.filter((candidate) => canonicalJcs(candidate) === key);
    if (matches.length !== 1) {
      throw new Error(`${sourceRef}: ${referenceId} locator must equal exactly one locked locator`);
    }
    add(reference, matches[0], { sourceRef, usage });
  }

  for (const candidatePath of CANDIDATE_PATHS) {
    const absolute = path.join(rootDir, ...candidatePath.split('/'));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`missing active-evidence candidate ${candidatePath}`);
    }
    const candidate = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (!candidate || candidate.schemaVersion !== '1.0' || !Array.isArray(candidate.entries)) {
      throw new Error(`${candidatePath}: invalid authority candidate envelope`);
    }
    candidate.entries.forEach((entry, entryIndex) => {
      if (!Array.isArray(entry.upstreamEvidence)) {
        throw new Error(`${candidatePath}.entries[${entryIndex}].upstreamEvidence must be an array`);
      }
      entry.upstreamEvidence.forEach((evidence, evidenceIndex) => {
        if (!evidence || typeof evidence.referenceId !== 'string' || !isPlainObject(evidence.locator)) {
          throw new Error(
            `${candidatePath}.entries[${entryIndex}].upstreamEvidence[${evidenceIndex}] is invalid`,
          );
        }
        requireExactLockedLocator(
          evidence.referenceId,
          evidence.locator,
          `${candidatePath}#entries[${entryIndex}].upstreamEvidence[${evidenceIndex}]`,
          evidence.usage,
        );
      });
    });
  }

  for (const overridePath of OVERRIDE_PATHS) {
    const absolute = path.join(rootDir, ...overridePath.split('/'));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`missing active-evidence override ${overridePath}`);
    }
    const document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (!document || document.schemaVersion !== '1.0' || !Array.isArray(document.entries)) {
      throw new Error(`${overridePath}: invalid authority override envelope`);
    }
    document.entries.forEach((entry, entryIndex) => {
      if (!Array.isArray(entry.upstreamEvidence)) {
        throw new Error(`${overridePath}.entries[${entryIndex}].upstreamEvidence must be an array`);
      }
      entry.upstreamEvidence.forEach((evidence, evidenceIndex) => {
        const sourceRef = `${overridePath}#entries[${entryIndex}].upstreamEvidence[${evidenceIndex}]`;
        if (!evidence || typeof evidence.referenceId !== 'string' || !isPlainObject(evidence.locator)) {
          throw new Error(`${sourceRef}: invalid authority override evidence`);
        }
        const reference = references.get(evidence.referenceId);
        if (!reference || !Array.isArray(reference.locators)) {
          throw new Error(`${sourceRef}: ${evidence.referenceId} is not a local lock reference`);
        }
        const key = canonicalJcs(evidence.locator);
        const matches = reference.locators.filter((locator) => canonicalJcs(locator) === key);
        if (matches.length > 1) throw new Error(`${sourceRef}: locator ambiguously joins the lock`);
        // Overrides are compiler inputs. Allow an exact not-yet-locked selector
        // here so the deterministic migration can bootstrap it; authority
        // candidate compilation remains fail-closed until migration writes the
        // identical locator into the lock.
        add(reference, matches[0] || evidence.locator, {
          sourceRef,
          usage: evidence.usage,
        });
      });
    });
  }

  const noAlignmentAbsolute = path.join(rootDir, ...NO_ALIGNMENT_DECISION_PATH.split('/'));
  if (!fs.existsSync(noAlignmentAbsolute) || !fs.statSync(noAlignmentAbsolute).isFile()) {
    throw new Error(`missing reviewed no-alignment decision source ${NO_ALIGNMENT_DECISION_PATH}`);
  }
  const noAlignment = JSON.parse(fs.readFileSync(noAlignmentAbsolute, 'utf8'));
  if (!noAlignment
      || noAlignment.schemaVersion !== '1.0'
      || noAlignment.review?.conclusion !== 'reviewed-no-alignment'
      || !Array.isArray(noAlignment.decisions)
      || typeof noAlignment.reference?.id !== 'string') {
    throw new Error(`${NO_ALIGNMENT_DECISION_PATH}: invalid reviewed no-alignment envelope`);
  }
  const noAlignmentReference = references.get(noAlignment.reference.id);
  if (!noAlignmentReference
      || noAlignmentReference.artifactDigest !== noAlignment.reference.artifactDigest
      || noAlignmentReference.releaseOrCommit !== noAlignment.reference.releaseOrCommit
      || !Array.isArray(noAlignmentReference.locators)) {
    throw new Error(`${NO_ALIGNMENT_DECISION_PATH}: reference pin does not equal one exact lock record`);
  }
  const requiredDecisionIds = Object.keys(REQUIRED_DECISIONS).sort();
  const actualDecisionIds = noAlignment.decisions.map((decision) => decision?.decisionId).sort();
  if (canonicalJcs(actualDecisionIds) !== canonicalJcs(requiredDecisionIds)) {
    throw new Error(`${NO_ALIGNMENT_DECISION_PATH}: exact reviewed decision set drift`);
  }
  noAlignment.decisions.forEach((decision, decisionIndex) => {
    const sourceRef = `${NO_ALIGNMENT_DECISION_PATH}#decisions[${decisionIndex}].candidate.sourceLocator`;
    const locator = decision?.candidate?.sourceLocator;
    const specification = REQUIRED_DECISIONS[decision?.decisionId];
    if (!specification
        || sha256(Buffer.from(canonicalJcs(decision), 'utf8')) !== specification.decisionDigest
        || decision?.outcome !== 'reviewed-no-alignment-semantic-mismatch'
        || decision?.candidate?.relation !== 'rdfs:subClassOf'
        || !isPlainObject(locator)) {
      throw new Error(`${sourceRef}: invalid reviewed no-alignment evidence`);
    }
    const key = canonicalJcs(locator);
    const matches = noAlignmentReference.locators.filter((candidate) => canonicalJcs(candidate) === key);
    if (matches.length > 1) throw new Error(`${sourceRef}: locator ambiguously joins the lock`);
    // A reviewed rejection still consumes exact external semantics. Permit the
    // deterministic lock migration to bootstrap a missing exact selector, but
    // require all stable checks to join the identical locator afterwards.
    add(noAlignmentReference, matches[0] || locator, {
      sourceRef,
      usage: 'implementation',
    });
  });

  const financeRoot = path.join(rootDir, 'ontology', 'domain', 'finance');
  const modulePaths = fs.readdirSync(financeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(financeRoot, entry.name, 'module.yaml'))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .sort();
  for (const modulePath of modulePaths) {
    const moduleDocument = YAML.parse(fs.readFileSync(modulePath, 'utf8'));
    const moduleRef = posix(path.relative(rootDir, modulePath));
    function visit(value, at) {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${at}[${index}]`));
        return;
      }
      if (!isPlainObject(value)) return;
      if (typeof value.targetIri === 'string' && isPlainObject(value.sourceLocator)) {
        const artifactDigest = value.sourceRelease?.artifactDigest;
        const candidates = [...references.values()].filter((reference) => (
          reference.artifactDigest === artifactDigest
          && typeof reference.localPath === 'string'
          && Array.isArray(reference.locators)
        ));
        if (candidates.length !== 1) {
          throw new Error(`${moduleRef}#${at}: alignment sourceRelease must select one exact lock artifact`);
        }
        const reference = candidates[0];
        if (typeof value.sourceRelease.release === 'string'
            && value.sourceRelease.release !== reference.releaseOrCommit) {
          throw new Error(`${moduleRef}#${at}: alignment source release does not equal the lock pin`);
        }
        const key = canonicalJcs(value.sourceLocator);
        const matches = reference.locators.filter((locator) => canonicalJcs(locator) === key);
        if (matches.length > 1) {
          throw new Error(`${moduleRef}#${at}: alignment locator ambiguously joins the lock`);
        }
        // A missing locator is still an active machine-readable use for review
        // generation, so migration can repair the lock from file-level
        // coverage. Stable --check mode subsequently requires the exact join.
        add(reference, matches[0] || value.sourceLocator, {
          sourceRef: `${moduleRef}#${at}`,
          usage: 'normative',
        });
      }
      for (const [field, child] of Object.entries(value)) {
        visit(child, at ? `${at}.${field}` : field);
      }
    }
    visit(moduleDocument, '');
  }

  // Required profiles are machine consumers even before every authority row is
  // available. Count only required selectors that already resolve to exactly
  // one local lock locator; unresolved profiles remain pending in the PTO gate.
  for (const profile of REQUIRED_REFERENCE_PROFILES) {
    if (typeof profile.id !== 'string' || !Array.isArray(profile.requiredLocators)) continue;
    const reference = references.get(profile.id);
    if (!reference || !Array.isArray(reference.locators)) continue;
    for (const required of profile.requiredLocators) {
      const matches = reference.locators.filter((locator) => subsetLocatorMatch(locator, required));
      if (matches.length > 1) {
        throw new Error(`post-trade profile ${profile.key} ambiguously selects ${profile.id}`);
      }
      if (matches.length === 1) {
        add(reference, matches[0], {
          sourceRef: `postTradeReferenceProfile:${profile.key}`,
          usage: 'normative',
        });
      }
    }
  }

  return {
    byLocator,
    byPath,
    locators: [...locatorRecords.values()].sort((left, right) => (
      Buffer.compare(Buffer.from(canonicalJcs(left), 'utf8'), Buffer.from(canonicalJcs(right), 'utf8'))
    )),
    usedPaths: new Set(byPath.keys()),
  };
}

module.exports = {
  CANDIDATE_PATHS,
  NO_ALIGNMENT_DECISION_PATH,
  OVERRIDE_PATHS,
  collectActiveReferenceEvidence,
  subsetLocatorMatch,
};
