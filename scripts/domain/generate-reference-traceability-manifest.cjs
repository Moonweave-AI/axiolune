#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');
const {
  fileDigest,
  semanticNodeId,
} = require('./lib/reference-closure.cjs');
const {
  taggedJcsDigest,
} = require('./lib/term-card-compiler.cjs');
const {
  DECISION_PATH,
  verifyReviewedNoAlignments,
} = require('./lib/reviewed-no-alignment.cjs');
const {
  validateQuantityRegistry,
} = require('./lib/slice-a-source-locks.cjs');
const {
  REQUIRED_REFERENCE_PROFILES,
} = require('./lib/post-trade-authority-evidence.cjs');
const {
  validateSemanticReviewDecision,
} = require('./lib/authority-decision.cjs');
const {
  validateReferenceClosure,
} = require('./lib/reference-closure.cjs');
const {
  digestCandidate: codeListCandidateDigest,
} = require('./lib/source-evidence-reference.cjs');
const {
  digestCandidate: termAuthorityCandidateDigest,
} = require('./lib/term-authority.cjs');
const {
  compile: compileTermCardManifest,
} = require('./generate-term-card-manifest.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const VOCAB_PATH = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-vocabularies',
  'm2-v0.3-code-lists.json',
);
const TERM_PATH = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-terminology',
  'm2-v0.3-terms.json',
);
const QUANTITY_PATH = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-quantity-units',
  'm2-v0.3-quantity-units.json',
);
const OUTPUT_PATH = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'reference-support-diagnostics.json',
);
const RELEASE_OUTPUT_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'traceability-manifest.json',
);
const TERM_CARD_ROOT = path.join(ROOT, 'docs', 'ontology', 'term-cards', 'v0.3');
const TERM_CARD_DIRECT_ROOT = path.join(TERM_CARD_ROOT, 'direct');
const TERM_CARD_REVIEW_ROOT = path.join(TERM_CARD_ROOT, 'reviews');
const TERM_CARD_INHERITANCE_ROOT = path.join(TERM_CARD_ROOT, 'inheritance');
const TERM_CARD_INDEX_PATH = path.join(TERM_CARD_ROOT, 'candidate-index.json');
const TERM_CARD_MANIFEST_PATH = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'term-card-manifest.json',
);
const PROFILE_REF = {
  kind: 'path',
  root: 'sourceTree',
  path: 'docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md',
};
const VOCAB_REFERENCE_ID = 'axiolune-m2-controlled-vocabularies';
const TERM_REFERENCE_ID = 'axiolune-m2-controlled-terminology';
const QUANTITY_REFERENCE_ID = 'axiolune-m2-controlled-quantity-units';
const MIC_REFERENCE_ID = 'iso20022-mic-register-2026-07-13';
const TZDB_REFERENCE_ID = 'iana-tzdb-2026c-2026-07-08';
const POST_TRADE_PROFILE_PATH = 'scripts/domain/lib/post-trade-authority-evidence.cjs';
const POST_TRADE_PROFILE_TARGETS = Object.freeze({
  'finra-rule-11140': Object.freeze({
    targetPublicIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionScheduleResolution',
    assertionScope: 'normative',
  }),
  'finra-notice-00-54': Object.freeze({
    targetPublicIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionScheduleResolution',
    assertionScope: 'contextOnly',
  }),
  'investor-gov-ex-dividend': Object.freeze({
    targetPublicIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionScheduleResolution',
    assertionScope: 'contextOnly',
  }),
  'dtc-distributions-service-guide': Object.freeze({
    targetPublicIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionDueBillTradeQualification',
    assertionScope: 'normative',
  }),
  'dtc-settlement-service-guide': Object.freeze({
    targetPublicIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/SettlementInstruction',
    assertionScope: 'normative',
  }),
  'fibo-rights-exercise-event': Object.freeze({
    targetPublicIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/CorporateActionEvent',
    assertionScope: 'implementation',
  }),
});

function artifactRef(repoPath) {
  return { kind: 'path', root: 'sourceTree', path: repoPath };
}

function repoPath(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join('/');
}

function exactJcsFile(file, label, finalLf = false) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${repoPath(file)}`);
  }
  const bytes = fs.readFileSync(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  const expected = Buffer.from(`${canonicalJcs(value)}${finalLf ? '\n' : ''}`, 'utf8');
  if (!bytes.equals(expected)) {
    throw new Error(`${label} is not exact UTF-8 RFC 8785 JCS${finalLf ? ' plus one LF' : ''} bytes`);
  }
  return { bytes, value };
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sourceKey(referenceId, locator) {
  return `${referenceId}\0${canonicalJcs(locator)}`;
}

function addNode(nodes, value) {
  const node = { ...value, nodeId: semanticNodeId(value) };
  const previous = nodes.get(node.nodeId);
  if (previous && canonicalJcs(previous) !== canonicalJcs(node)) {
    throw new Error(`semantic node collision ${node.nodeId}`);
  }
  nodes.set(node.nodeId, node);
  return node;
}

function addTarget(mapping, key, target, edgeKind = 'supportsTerm', assertionScope = 'implementation') {
  if (!mapping.has(key)) mapping.set(key, new Map());
  const bindingKey = `${target.nodeId}\0${edgeKind}\0${assertionScope}`;
  mapping.get(key).set(bindingKey, { target, edgeKind, assertionScope });
}

function evidenceScope(value) {
  if (value === 'normative') return 'normative';
  if (value === 'contextual' || value === 'contextOnly') return 'contextOnly';
  return 'implementation';
}

function requireCandidate(value, label, candidateKind) {
  if (!value || value.schemaVersion !== '1.0'
      || value.profileRef !== 'https://axiolune.ai/conformance/m2/0.3.0'
      || value.snapshotVersion !== '0.3.0'
      || !Array.isArray(value.entries)
      || value.entries.length === 0
      || canonicalJcs(Object.keys(value).sort()) !== canonicalJcs([
        'candidateDigest', 'decision', 'entries', 'profileRef', 'schemaVersion', 'snapshotVersion',
      ].sort())) {
    throw new Error(`${label} is not the exact M2 v0.3 candidate envelope`);
  }
  const expectedDigest = candidateKind === 'vocabularies'
    ? codeListCandidateDigest(value.profileRef, value.snapshotVersion, value.entries)
    : candidateKind === 'terminology'
      ? termAuthorityCandidateDigest(value.snapshotVersion, value.entries, value.profileRef)
      : null;
  if (expectedDigest === null || value.candidateDigest !== expectedDigest) {
    throw new Error(`${label}.candidateDigest does not bind the exact semantic entries`);
  }
  return validateSemanticReviewDecision(
    value.decision,
    `${label}.decision`,
    expectedDigest,
  );
}

function exactJsonFiles(directory, label) {
  if (!fs.existsSync(directory)) return [];
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} is not a directory: ${repoPath(directory)}`);
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => utf8Compare(repoPath(left), repoPath(right)))
    .map((file) => ({ file, artifact: exactJcsFile(file, label) }));
}

function loadReviewTermCards(terms, terminologyReference) {
  if (!terminologyReference
      || typeof terminologyReference.localPath !== 'string'
      || !Array.isArray(terminologyReference.locators)
      || terminologyReference.locators.length !== 1) {
    throw new Error('terminology authority has no exact one-locator lock record');
  }
  const indexArtifact = exactJcsFile(TERM_CARD_INDEX_PATH, 'term-card candidate index');
  const index = indexArtifact.value;
  const exactIndexFields = [
    'authorityArtifactDigest',
    'authorityCandidateDigest',
    'authorityDecisionStatus',
    'directCardCount',
    'directCardsDigest',
    'generatedInheritanceCount',
    'profileRef',
    'reviewCount',
    'schemaVersion',
  ].sort();
  if (canonicalJcs(Object.keys(index).sort()) !== canonicalJcs(exactIndexFields)
      || index.schemaVersion !== '1.0'
      || index.profileRef !== terms.profileRef
      || index.authorityArtifactDigest !== fileDigest(TERM_PATH)
      || index.authorityCandidateDigest !== terms.candidateDigest
      || index.authorityDecisionStatus !== terms.decision.status
      || (terms.decision.status === 'pending'
        && (index.reviewCount !== 0 || index.generatedInheritanceCount !== 0))
      || (terms.decision.status === 'reviewed'
        && (index.reviewCount !== index.directCardCount
          || index.generatedInheritanceCount <= 0))) {
    throw new Error('term-card candidate index does not bind the exact terminology authority state');
  }
  const reviewArtifacts = exactJsonFiles(TERM_CARD_REVIEW_ROOT, 'term-card review record');
  const inheritanceArtifacts = exactJsonFiles(
    TERM_CARD_INHERITANCE_ROOT,
    'term-card inheritance record',
  );
  if (reviewArtifacts.length !== index.reviewCount) {
    throw new Error(
      `term-card review artifact count ${reviewArtifacts.length} does not equal index ${index.reviewCount}`,
    );
  }
  if (inheritanceArtifacts.length !== index.generatedInheritanceCount) {
    throw new Error(
      'term-card inheritance artifact count '
      + `${inheritanceArtifacts.length} does not equal index ${index.generatedInheritanceCount}`,
    );
  }
  if (terms.decision.status === 'reviewed') {
    const compiled = compileTermCardManifest();
    const expectedManifestBytes = Buffer.from(canonicalJcs(compiled.manifest), 'utf8');
    if (!fs.existsSync(TERM_CARD_MANIFEST_PATH)
        || !fs.statSync(TERM_CARD_MANIFEST_PATH).isFile()
        || !fs.readFileSync(TERM_CARD_MANIFEST_PATH).equals(expectedManifestBytes)) {
      throw new Error(
        'reviewed terminology trace requires the exact current term-card manifest',
      );
    }
  } else if (fs.existsSync(TERM_CARD_MANIFEST_PATH)) {
    throw new Error('pending terminology authority forbids an accepted term-card manifest');
  }
  if (!fs.existsSync(TERM_CARD_DIRECT_ROOT) || !fs.statSync(TERM_CARD_DIRECT_ROOT).isDirectory()) {
    throw new Error(`term-card direct directory is missing: ${repoPath(TERM_CARD_DIRECT_ROOT)}`);
  }
  const files = fs.readdirSync(TERM_CARD_DIRECT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(TERM_CARD_DIRECT_ROOT, entry.name));
  if (files.length !== index.directCardCount || files.length !== terms.entries.length) {
    throw new Error(
      `term-card count ${files.length} does not equal index ${index.directCardCount} `
      + `and term authority ${terms.entries.length}`,
    );
  }
  const termsByIri = new Map(terms.entries.map((entry) => [entry.publicIri, entry]));
  const cardsByIri = new Map();
  const directIndex = [];
  for (const file of files) {
    const artifact = exactJcsFile(file, 'direct term card');
    const card = artifact.value;
    const term = termsByIri.get(card.publicIri);
    if (!term || cardsByIri.has(card.publicIri)) {
      throw new Error(`${repoPath(file)}: term card must select one unique authority term`);
    }
    for (const field of [
      'definition',
      'definitionDigest',
      'ownerRef',
      'preferredLabel',
      'publicIri',
      'version',
    ]) {
      if (card[field] !== term[field]) {
        throw new Error(`${repoPath(file)}: ${field} does not equal the terminology authority entry`);
      }
    }
    const authorityCitations = Array.isArray(card.sourceCitations)
      ? card.sourceCitations.filter((citation) => (
        citation.referenceId === TERM_REFERENCE_ID
          && citation.artifactDigest === terminologyReference.artifactDigest
          && canonicalJcs(citation.artifactRef) === canonicalJcs(
            artifactRef(terminologyReference.localPath),
          )
          && canonicalJcs(citation.locator) === canonicalJcs(terminologyReference.locators[0])
      ))
      : [];
    const expectedCardStatus = terms.decision.status === 'reviewed' ? 'accepted' : 'review';
    if (card.schemaVersion !== '1.0'
        || card.status !== expectedCardStatus
        || authorityCitations.length !== 1) {
      throw new Error(`${repoPath(file)}: direct card is not an exact ${expectedCardStatus} source record`);
    }
    const cardRef = artifactRef(repoPath(file));
    const cardDigest = fileDigest(file);
    cardsByIri.set(card.publicIri, { card, cardDigest, cardRef });
    directIndex.push({ cardDigest, cardRef, publicIri: card.publicIri });
  }
  directIndex.sort((left, right) => utf8Compare(left.publicIri, right.publicIri));
  const actualIndexDigest = taggedJcsDigest(
    'axiolune-direct-term-card-index-v1\0',
    directIndex,
  );
  if (actualIndexDigest !== index.directCardsDigest) {
    throw new Error(`term-card direct index digest mismatch: expected ${actualIndexDigest}`);
  }
  return {
    cardsByIri,
    index,
    inheritanceArtifacts,
    reviewArtifacts,
  };
}

function compile() {
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const vocab = exactJcsFile(VOCAB_PATH, 'controlled-vocabulary candidate').value;
  const terms = exactJcsFile(TERM_PATH, 'controlled-terminology candidate').value;
  const vocabDecisionStatus = requireCandidate(
    vocab,
    'controlled-vocabulary candidate',
    'vocabularies',
  );
  const termDecisionStatus = requireCandidate(
    terms,
    'controlled-terminology candidate',
    'terminology',
  );
  if (!lock || !Array.isArray(lock.references)) throw new Error('reference lock has no references');
  const references = new Map(lock.references.map((reference) => [reference.id, reference]));
  if (references.size !== lock.references.length) throw new Error('duplicate reference lock ID');

  const nodes = new Map();
  const targetsBySource = new Map();
  const termCardState = loadReviewTermCards(terms, references.get(TERM_REFERENCE_ID));
  const termNodes = new Map();
  for (const entry of terms.entries) {
    const cardState = termCardState.cardsByIri.get(entry.publicIri);
    if (!cardState) throw new Error(`${entry.publicIri}: no exact direct review card`);
    const target = addNode(nodes, {
      nodeKind: 'termCard',
      artifactRef: cardState.cardRef,
      artifactDigest: cardState.cardDigest,
      publicIri: entry.publicIri,
    });
    termNodes.set(entry.publicIri, target);
  }

  function exactLockedLocator(referenceId, locator) {
    const reference = references.get(referenceId);
    if (!reference || !Array.isArray(reference.locators)) {
      throw new Error(`${referenceId}: upstream evidence has no locked reference`);
    }
    const key = canonicalJcs(locator);
    const matches = reference.locators.filter((candidate) => canonicalJcs(candidate) === key);
    if (matches.length !== 1) {
      throw new Error(`${referenceId}: upstream evidence must equal exactly one locked locator`);
    }
    return sourceKey(referenceId, matches[0]);
  }

  function exactLockedLocatorSubset(referenceId, locator) {
    const reference = references.get(referenceId);
    if (!reference || !Array.isArray(reference.locators)) {
      throw new Error(`${referenceId}: upstream evidence has no locked reference`);
    }
    const matches = reference.locators.filter((candidate) => Object.entries(locator).every(
      ([field, expected]) => Object.prototype.hasOwnProperty.call(candidate, field)
        && canonicalJcs(candidate[field]) === canonicalJcs(expected),
    ));
    if (matches.length !== 1) {
      throw new Error(`${referenceId}: upstream evidence subset must select exactly one locked locator`);
    }
    return sourceKey(referenceId, matches[0]);
  }

  for (const entry of vocab.entries) {
    const target = termNodes.get(entry.codeListIri);
    if (!target) {
      throw new Error(`${entry.codeListIri}: controlled vocabulary has no authored-term candidate`);
    }
    for (const evidence of entry.upstreamEvidence || []) {
      addTarget(
        targetsBySource,
        exactLockedLocator(evidence.referenceId, evidence.locator),
        target,
        'supportsTerm',
        evidenceScope(evidence.usage),
      );
    }
  }
  for (const entry of terms.entries) {
    const target = termNodes.get(entry.publicIri);
    for (const evidence of entry.upstreamEvidence || []) {
      addTarget(
        targetsBySource,
        exactLockedLocator(evidence.referenceId, evidence.locator),
        target,
        'supportsTerm',
        evidenceScope(evidence.usage),
      );
    }
  }

  const noAlignmentVerification = verifyReviewedNoAlignments({ rootDir: ROOT });
  if (!noAlignmentVerification.ok) {
    throw new Error(`reviewed no-alignment evidence is invalid: ${noAlignmentVerification.errors.join('; ')}`);
  }
  const noAlignmentDocument = JSON.parse(fs.readFileSync(path.join(ROOT, ...DECISION_PATH.split('/')), 'utf8'));
  const verifiedDecisionIds = new Set(
    noAlignmentVerification.evidence.decisions.map((decision) => decision.decisionId),
  );
  for (const decision of noAlignmentDocument.decisions) {
    if (!verifiedDecisionIds.has(decision.decisionId)) {
      throw new Error(`${decision.decisionId}: no exact reviewed no-alignment verification row`);
    }
    const target = addNode(nodes, {
      nodeKind: 'alignmentDecision',
      artifactRef: artifactRef(DECISION_PATH),
      artifactDigest: fileDigest(path.join(ROOT, ...DECISION_PATH.split('/'))),
      decisionId: decision.decisionId,
      localPublicIri: decision.local.iri,
      targetPublicIri: decision.candidate.targetIri,
      outcome: decision.outcome,
    });
    addTarget(
      targetsBySource,
      exactLockedLocator(noAlignmentDocument.reference.id, decision.candidate.sourceLocator),
      target,
      'supportsAlignmentDecision',
      'implementation',
    );
  }

  const quantityArtifact = exactJcsFile(QUANTITY_PATH, 'controlled Quantity-unit candidate', true);
  const quantity = validateQuantityRegistry(quantityArtifact.value);
  const quantityDecisionStatus = validateSemanticReviewDecision(
    quantity.decision,
    'controlled Quantity-unit candidate.decision',
    quantity.candidateDigest,
  );
  const quantityReference = references.get(QUANTITY_REFERENCE_ID);
  if (!quantityReference || quantityReference.locators?.length !== 1
      || quantityReference.locators[0].kind !== 'wholeFile'
      || quantityReference.locators[0].path !== 'm2-v0.3-quantity-units.json') {
    throw new Error(`${QUANTITY_REFERENCE_ID}: expected one exact wholeFile candidate locator`);
  }
  const quantityRef = artifactRef(
    'reference/ontology-design-reference/axiolune-controlled-quantity-units/m2-v0.3-quantity-units.json',
  );
  const quantityTarget = addNode(nodes, {
    nodeKind: 'controlledIriSet',
    identityTermRegistryRef: quantityRef,
    identityTermRegistryDigest: fileDigest(QUANTITY_PATH),
    controlledSetRef: quantityRef,
    controlledSetDigest: fileDigest(QUANTITY_PATH),
  });
  addTarget(
    targetsBySource,
    sourceKey(QUANTITY_REFERENCE_ID, quantityReference.locators[0]),
    quantityTarget,
    'supportsControlledSet',
    quantityDecisionStatus === 'reviewed' ? 'normative' : 'implementation',
  );
  for (const context of quantity.externalContextEvidence) {
    if (context.assertionScope !== 'contextOnly' || context.usage !== 'contextual') {
      throw new Error('Quantity-unit external context must remain contextOnly/contextual');
    }
    for (const locator of context.locators) {
      addTarget(
        targetsBySource,
        exactLockedLocatorSubset(context.referenceId, locator),
        quantityTarget,
        'supportsControlledSet',
        'contextOnly',
      );
    }
  }

  function addExternalControlledSet(referenceId, registryPath, controlledPath) {
    const reference = references.get(referenceId);
    if (!reference || !Array.isArray(reference.locators) || typeof reference.localPath !== 'string') {
      throw new Error(`${referenceId}: controlled-set source has no exact local lock`);
    }
    const registryRepoPath = `${reference.localPath}/${registryPath}`;
    const controlledRepoPath = `${reference.localPath}/${controlledPath}`;
    const target = addNode(nodes, {
      nodeKind: 'controlledIriSet',
      identityTermRegistryRef: artifactRef(registryRepoPath),
      identityTermRegistryDigest: fileDigest(path.join(ROOT, ...registryRepoPath.split('/'))),
      controlledSetRef: artifactRef(controlledRepoPath),
      controlledSetDigest: fileDigest(path.join(ROOT, ...controlledRepoPath.split('/'))),
    });
    for (const locator of reference.locators) {
      addTarget(
        targetsBySource,
        sourceKey(referenceId, locator),
        target,
        'supportsControlledSet',
        locator.path === registryPath ? 'implementation' : 'normative',
      );
    }
    return target;
  }

  addExternalControlledSet(MIC_REFERENCE_ID, 'mic-source-lock.json', 'ISO10383_MIC.csv');
  addExternalControlledSet(TZDB_REFERENCE_ID, 'tzdb-source-lock.json', 'zone1970.tab');

  const postTradeProfileArtifact = path.join(ROOT, ...POST_TRADE_PROFILE_PATH.split('/'));
  for (const profile of REQUIRED_REFERENCE_PROFILES) {
    const policy = POST_TRADE_PROFILE_TARGETS[profile.key];
    if (!policy) throw new Error(`${profile.key}: trace assertion-scope policy is absent`);
    const reference = references.get(profile.id);
    if (!reference
        || reference.localPath !== profile.localPath
        || reference.artifactUrl !== profile.artifactUrl) {
      throw new Error(`${profile.key}: post-trade reference profile does not equal the exact lock identity`);
    }
    const target = addNode(nodes, {
      nodeKind: 'constraintInstance',
      artifactRef: artifactRef(POST_TRADE_PROFILE_PATH),
      artifactDigest: fileDigest(postTradeProfileArtifact),
      constraintInstanceId: `post-trade-reference-profile:${profile.key}`,
      targetPublicIri: policy.targetPublicIri,
    });
    for (const requiredLocator of profile.requiredLocators) {
      addTarget(
        targetsBySource,
        exactLockedLocatorSubset(profile.id, requiredLocator),
        target,
        'supportsConstraint',
        policy.assertionScope,
      );
    }
  }

  const vocabReference = references.get(VOCAB_REFERENCE_ID);
  const termReference = references.get(TERM_REFERENCE_ID);
  if (!vocabReference || vocabReference.locators.length !== 1
      || vocabReference.locators[0].kind !== 'wholeFile') {
    throw new Error(`${VOCAB_REFERENCE_ID}: expected one exact wholeFile candidate locator`);
  }
  if (!termReference || termReference.locators.length !== 1
      || termReference.locators[0].kind !== 'wholeFile') {
    throw new Error(`${TERM_REFERENCE_ID}: expected one exact wholeFile candidate locator`);
  }
  const vocabSourceKey = sourceKey(VOCAB_REFERENCE_ID, vocabReference.locators[0]);
  for (const entry of vocab.entries) {
    addTarget(
      targetsBySource,
      vocabSourceKey,
      termNodes.get(entry.codeListIri),
      'supportsTerm',
      vocabDecisionStatus === 'reviewed' ? 'normative' : 'implementation',
    );
  }
  const termSourceKey = sourceKey(TERM_REFERENCE_ID, termReference.locators[0]);
  for (const target of termNodes.values()) {
    addTarget(
      targetsBySource,
      termSourceKey,
      target,
      'supportsTerm',
      termDecisionStatus === 'reviewed' ? 'normative' : 'implementation',
    );
  }

  // When a semantic selector and a whole-file selector bind the same locked
  // artifact, the whole file may conservatively support the selector's target.
  // Propagation is intentionally one-way: selectors must never inherit targets
  // from other selectors on the same path. Otherwise two disjoint FIBO classes
  // or rule passages would be falsely represented as supporting each other's
  // conclusions merely because they reside in the same source file.
  for (const reference of lock.references) {
    if (!Array.isArray(reference.locators)) continue;
    const selectorTargetsByPath = new Map();
    for (const locator of reference.locators) {
      if (locator.kind === 'wholeFile') continue;
      const targets = targetsBySource.get(sourceKey(reference.id, locator));
      if (!targets) continue;
      if (!selectorTargetsByPath.has(locator.path)) selectorTargetsByPath.set(locator.path, new Map());
      for (const binding of targets.values()) {
        const bindingKey = `${binding.target.nodeId}\0${binding.edgeKind}\0${binding.assertionScope}`;
        selectorTargetsByPath.get(locator.path).set(bindingKey, binding);
      }
    }
    for (const locator of reference.locators) {
      if (locator.kind !== 'wholeFile') continue;
      const targets = selectorTargetsByPath.get(locator.path);
      if (!targets) continue;
      for (const binding of targets.values()) {
        addTarget(
          targetsBySource,
          sourceKey(reference.id, locator),
          binding.target,
          binding.edgeKind,
          binding.assertionScope,
        );
      }
    }
  }

  const edges = [];
  for (const reference of lock.references) {
    if (!Array.isArray(reference.locators) || typeof reference.localPath !== 'string') continue;
    for (const locator of reference.locators) {
      const targets = targetsBySource.get(sourceKey(reference.id, locator));
      if (!targets || targets.size === 0) continue;
      const repoPath = `${reference.localPath}/${locator.path}`;
      const absolute = path.join(ROOT, ...repoPath.split('/'));
      const source = addNode(nodes, {
        nodeKind: 'sourceLocator',
        referenceId: reference.id,
        artifactRef: artifactRef(repoPath),
        artifactDigest: fileDigest(absolute),
        locator,
      });
      for (const binding of targets.values()) {
        edges.push({
          fromNodeId: source.nodeId,
          toNodeId: binding.target.nodeId,
          edgeKind: binding.edgeKind,
          assertionScope: binding.assertionScope,
        });
      }
    }
  }
  const uniqueEdges = new Map();
  for (const edge of edges) {
    const key = `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.edgeKind}\0${edge.assertionScope}`;
    uniqueEdges.set(key, edge);
  }
  const sortedNodes = [...nodes.values()].sort((left, right) => utf8Compare(left.nodeId, right.nodeId));
  const sortedEdges = [...uniqueEdges.entries()]
    .sort((left, right) => utf8Compare(left[0], right[0]))
    .map(([, edge]) => edge);
  const tracedSourceCount = sortedNodes.filter((node) => node.nodeKind === 'sourceLocator').length;
  const lockedLocatorCount = lock.references.reduce(
    (sum, reference) => sum + (Array.isArray(reference.locators) ? reference.locators.length : 0),
    0,
  );
  const tracedReferenceIds = new Set(
    sortedNodes
      .filter((node) => node.nodeKind === 'sourceLocator')
      .map((node) => node.referenceId),
  );
  const untracedByReference = {};
  for (const reference of lock.references) {
    const total = Array.isArray(reference.locators) ? reference.locators.length : 0;
    if (total === 0) continue;
    const traced = reference.locators.filter((locator) => (
      targetsBySource.has(sourceKey(reference.id, locator))
    )).length;
    if (traced !== total) untracedByReference[reference.id] = total - traced;
  }
  const authorityStatuses = [
    vocabDecisionStatus,
    termDecisionStatus,
    quantityDecisionStatus,
  ];
  const referenceClosureReplay = validateReferenceClosure({ rootDir: ROOT });
  const releaseEvidenceEligible = referenceClosureReplay.ok
    && authorityStatuses.every((status) => status === 'reviewed')
    && lockedLocatorCount === tracedSourceCount
    && Object.keys(untracedByReference).length === 0
    && termCardState.index.reviewCount === termCardState.index.directCardCount
    && termCardState.index.generatedInheritanceCount > 0;
  return {
    manifest: {
      schemaVersion: '1.0',
      artifactKind: releaseEvidenceEligible
        ? 'referenceTraceabilityManifest'
        : 'referenceSupportDiagnostics',
      releaseEvidenceEligible,
      profileRef: PROFILE_REF,
      nodes: sortedNodes,
      edges: sortedEdges,
    },
    stats: {
      nodeCount: sortedNodes.length,
      edgeCount: sortedEdges.length,
      sourceLocatorCount: tracedSourceCount,
      lockedLocatorCount,
      untracedLocatorCount: lockedLocatorCount - tracedSourceCount,
      tracedReferenceCount: tracedReferenceIds.size,
      untracedByReference,
      pendingCandidateCount: authorityStatuses.filter((status) => status === 'pending').length,
      termCardStatus: termDecisionStatus === 'reviewed' ? 'accepted' : 'review',
      termCardReviewCount: termCardState.index.reviewCount,
      releaseLimitation: authorityStatuses.includes('pending')
        ? 'pending-semantic-review'
        : 'semantic-review-satisfied',
    },
  };
}

function outputBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/generate-reference-traceability-manifest.cjs (--write|--check)');
  }
  const result = compile();
  const bytes = outputBytes(result.manifest);
  if (write) {
    if (!result.manifest.releaseEvidenceEligible && fs.existsSync(RELEASE_OUTPUT_PATH)) {
      throw new Error(
        'stale release traceability manifest exists while semantic review is incomplete',
      );
    }
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, bytes);
    if (result.manifest.releaseEvidenceEligible) {
      fs.mkdirSync(path.dirname(RELEASE_OUTPUT_PATH), { recursive: true });
      fs.writeFileSync(RELEASE_OUTPUT_PATH, bytes);
    }
  } else if (!fs.existsSync(OUTPUT_PATH) || !fs.readFileSync(OUTPUT_PATH).equals(bytes)) {
    throw new Error('reference-support-diagnostics.json is missing or byte-drifted');
  } else if (result.manifest.releaseEvidenceEligible
      && (!fs.existsSync(RELEASE_OUTPUT_PATH)
        || !fs.readFileSync(RELEASE_OUTPUT_PATH).equals(bytes))) {
    throw new Error('release traceability manifest is missing or byte-drifted');
  } else if (!result.manifest.releaseEvidenceEligible && fs.existsSync(RELEASE_OUTPUT_PATH)) {
    throw new Error(
      'stale release traceability manifest exists while semantic review is incomplete',
    );
  }
  return { mode: write ? 'write' : 'check', ...result.stats };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL reference support diagnostics: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  OUTPUT_PATH,
  RELEASE_OUTPUT_PATH,
  compile,
  outputBytes,
  requireCandidate,
  run,
};
