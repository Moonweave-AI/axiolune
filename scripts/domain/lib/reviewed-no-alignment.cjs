'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { Parser } = require('n3');
const {
  BUNDLE_TAG,
  fileDigest,
  u64be,
} = require('./reference-closure.cjs');
const {
  canonicalJcs,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  extractTextLineRangeBytes,
} = require('./text-line-range-source-extractor.cjs');
const {
  extractRdfXmlResourceBytes,
} = require('./rdf-resource-source-extractor.cjs');

const DECISION_PATH = 'docs/ontology/alignments/reviewed-no-alignment-decisions-v1.json';
const LOCK_PATH = 'docs/ontology/references/references.lock.yaml';
const PROFILE_ID = 'urn:axiolune:alignment-decision-profile:reviewed-no-alignment:v1';
const FIBO_ID = 'fibo-local-evidence';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

const REQUIRED_DECISIONS = Object.freeze({
  'instruments-equity-security-fibo-share': Object.freeze({
    decisionDigest: 'sha256:e266c3f8ccb7bdff7caa1b713a82a2ef3b7dd92c9592e797b301a08da55fd52a',
    modulePath: 'ontology/domain/finance/instruments/module.yaml',
    projectionPath: 'ontology/domain/finance/instruments/module.owl.ttl',
    key: 'EquitySecurity',
    localIri: 'https://axiolune.ai/ontology/finance/instruments/EquitySecurity',
    targetIri: 'https://spec.edmcouncil.org/fibo/ontology/SEC/Equities/EquityInstruments/Share',
    sourcePath: 'SEC/Equities/EquityInstruments.rdf',
    locatorKind: 'rdfResource',
    reasonCode: 'external-share-restrictions-narrower-than-local-equity-security',
    snippets: Object.freeze([
      '<owl:Class rdf:about="&fibo-sec-eq-eq;Share">',
      '<rdfs:subClassOf rdf:resource="&fibo-fbc-fi-fi;EquityInstrument"/>',
      '<owl:onProperty rdf:resource="&fibo-be-le-cb;hasSharesAuthorized"/>',
      '<owl:onProperty rdf:resource="&fibo-sec-eq-eq;confersNumberOfVotesPerShare"/>',
      'financial instrument that signifies a unit of equity ownership',
    ]),
  }),
  'instruments-financial-instrument-fibo-financial-instrument': Object.freeze({
    decisionDigest: 'sha256:68b657a2547b0037b0d5d7241201fa626bbf90e4471ab865da9fa788d2c5b73c',
    modulePath: 'ontology/domain/finance/instruments/module.yaml',
    projectionPath: 'ontology/domain/finance/instruments/module.owl.ttl',
    key: 'FinancialInstrument',
    localIri: 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument',
    targetIri: 'https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/FinancialInstruments/FinancialInstrument',
    sourcePath: 'FBC/FinancialInstruments/FinancialInstruments.rdf',
    lines: [268, 315],
    reasonCode: 'external-contract-restrictions-not-satisfied-by-local-identity',
    snippets: Object.freeze([
      '<owl:Class rdf:about="&fibo-fbc-fi-fi;FinancialInstrument">',
      '<rdfs:subClassOf rdf:resource="&fibo-fnd-agr-ctr;WrittenContract"/>',
      '<owl:onProperty rdf:resource="&fibo-fbc-fi-fi;isNegotiable"/>',
      '<owl:onProperty rdf:resource="&fibo-fbc-fi-fi;isDenominatedIn"/>',
      '<owl:onProperty rdf:resource="&fibo-fnd-rel-rel;isIssuedBy"/>',
      'written contract that gives rise to both a financial asset of one entity and a financial liability of another entity',
    ]),
  }),
  'instruments-security-fibo-security': Object.freeze({
    decisionDigest: 'sha256:898c77a0b9c5f6dfe881c292b0a3cdb76dbce9aa3a9634fcc1967ac03806773e',
    modulePath: 'ontology/domain/finance/instruments/module.yaml',
    projectionPath: 'ontology/domain/finance/instruments/module.owl.ttl',
    key: 'Security',
    localIri: 'https://axiolune.ai/ontology/finance/instruments/Security',
    targetIri: 'https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/FinancialInstruments/Security',
    sourcePath: 'FBC/FinancialInstruments/FinancialInstruments.rdf',
    lines: [465, 481],
    reasonCode: 'local-pre-issuance-security-identity-not-subset-of-external-issued-contract',
    snippets: Object.freeze([
      '<owl:Class rdf:about="&fibo-fbc-fi-fi;Security">',
      '<rdfs:subClassOf rdf:resource="&fibo-fbc-fi-fi;FinancialInstrument"/>',
      '<owl:onProperty rdf:resource="&fibo-fbc-fi-fi;isLegallyRecordedIn"/>',
      'financial instrument that can be bought or sold',
    ]),
  }),
  'instruments-instrument-listing-fibo-listing': Object.freeze({
    decisionDigest: 'sha256:959a89738a13e657c9a257242c443ddef9e71dbd5248c1eea218fb408ada458e',
    modulePath: 'ontology/domain/finance/instruments/module.yaml',
    projectionPath: 'ontology/domain/finance/instruments/module.owl.ttl',
    key: 'InstrumentListing',
    localIri: 'https://axiolune.ai/ontology/finance/instruments/InstrumentListing',
    targetIri: 'https://spec.edmcouncil.org/fibo/ontology/SEC/Securities/SecuritiesListings/Listing',
    sourcePath: 'SEC/Securities/SecuritiesListings.rdf',
    locatorKind: 'rdfResource',
    reasonCode: 'external-offering-listing-contract-not-local-facility-identifier-identity',
    snippets: Object.freeze([
      '<owl:Class rdf:about="&fibo-sec-sec-lst;Listing">',
      '<owl:onProperty rdf:resource="&fibo-sec-sec-lst;lists"/>',
      '<owl:onClass rdf:resource="&fibo-sec-sec-iss;SecuritiesOffering"/>',
      '<owl:qualifiedCardinality rdf:datatype="&xsd;nonNegativeInteger">1</owl:qualifiedCardinality>',
      'catalog entry for a securities offering managed by an exchange',
    ]),
  }),
  'market-data-price-observation-fibo-security-price': Object.freeze({
    decisionDigest: 'sha256:25a666feb7d659e816a78205d30bce7c08e542924baa6435a152367961a9ff95',
    modulePath: 'ontology/domain/finance/market-data/module.yaml',
    projectionPath: 'ontology/domain/finance/market-data/module.owl.ttl',
    key: 'PriceObservation',
    container: 'associationTypes',
    localIri: 'https://axiolune.ai/ontology/finance/market-data/PriceObservation',
    targetIri: 'https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/InstrumentPricing/SecurityPrice',
    sourcePath: 'FBC/FinancialInstruments/InstrumentPricing.rdf',
    locatorKind: 'rdfResource',
    reasonCode: 'external-monetary-price-value-not-local-versioned-observation-fact',
    snippets: Object.freeze([
      '<owl:Class rdf:about="&fibo-fbc-fi-ip;SecurityPrice">',
      '<rdfs:subClassOf rdf:resource="&fibo-fnd-acc-cur;MonetaryPrice"/>',
      '<owl:onProperty rdf:resource="&fibo-fnd-acc-cur;isPriceFor"/>',
      'monetary price for a financial instrument at some point in time',
    ]),
  }),
  'portfolio-portfolio-fibo-portfolio': Object.freeze({
    decisionDigest: 'sha256:6fd94bb30091ed38b80768f706115574f9a6e0562e451c0e01552e378975b39f',
    modulePath: 'ontology/domain/finance/portfolio-positions/module.yaml',
    projectionPath: 'ontology/domain/finance/portfolio-positions/module.owl.ttl',
    key: 'Portfolio',
    localIri: 'https://axiolune.ai/ontology/finance/portfolio-positions/Portfolio',
    targetIri: 'https://spec.edmcouncil.org/fibo/ontology/FND/OwnershipAndControl/Ownership/Portfolio',
    sourcePath: 'FND/OwnershipAndControl/Ownership.rdf',
    lines: [280, 302],
    reasonCode: 'external-nonempty-holding-composition-not-local-account-membership',
    snippets: Object.freeze([
      '<owl:Class rdf:about="&fibo-fnd-oac-own;Portfolio">',
      '<rdfs:subClassOf rdf:resource="&cmns-col;Collection"/>',
      '<owl:onProperty rdf:resource="&cmns-col;comprises"/>',
      '<owl:someValuesFrom rdf:resource="&fibo-fnd-oac-own;Holding"/>',
      'collection of holdings assembled and maintained as a unit for management purposes to achieve strategic objectives',
    ]),
  }),
  'post-trade-settlement-instruction-fibo-settlement': Object.freeze({
    decisionDigest: 'sha256:d64f815e9b2dd8f1e6805b4d54576200a2db9f70f1a403b0d64a482c9d44b5dc',
    modulePath: 'ontology/domain/finance/post-trade-operations/module.yaml',
    projectionPath: 'ontology/domain/finance/post-trade-operations/module.owl.ttl',
    key: 'SettlementInstruction',
    container: 'associationTypes',
    localIri: 'https://axiolune.ai/ontology/finance/post-trade-operations/SettlementInstruction',
    targetIri: 'https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/Settlement/Settlement',
    sourcePath: 'FBC/FinancialInstruments/Settlement.rdf',
    locatorKind: 'rdfResource',
    reasonCode: 'external-lifecycle-event-not-local-settlement-instruction',
    snippets: Object.freeze([
      '<owl:Class rdf:about="&fibo-fbc-fi-stl;Settlement">',
      '<rdfs:subClassOf rdf:resource="&fibo-fbc-pas-fpas;ContractLifecycleEvent"/>',
      'act of finalizing a transaction',
    ]),
  }),
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function safeResolve(rootDir, relativePath) {
  if (typeof relativePath !== 'string'
      || path.isAbsolute(relativePath)
      || relativePath.includes('\\')
      || relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment))) {
    throw new Error(`unsafe repository path ${String(relativePath)}`);
  }
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`repository path escapes root: ${relativePath}`);
  }
  return absolute;
}

function computeBundleDigest(directory) {
  const root = path.resolve(directory);
  const files = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => utf8Compare(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`reference bundle contains symlink ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`reference bundle contains non-regular entry ${absolute}`);
    }
  }
  walk(root);
  files.sort((left, right) => utf8Compare(
    path.relative(root, left).split(path.sep).join('/'),
    path.relative(root, right).split(path.sep).join('/'),
  ));
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relative = Buffer.from(path.relative(root, file).split(path.sep).join('/'), 'utf8');
    const bytes = fs.readFileSync(file);
    hash.update(u64be(relative.length));
    hash.update(relative);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function exactKeys(value, expected, at, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${at}: expected an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJcs(actual) !== canonicalJcs(wanted)) {
    errors.push(`${at}: expected exact fields ${wanted.join(', ')}`);
  }
}

function collectAlignments(value, at = '', output = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectAlignments(entry, `${at}[${index}]`, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (Object.prototype.hasOwnProperty.call(value, 'alignments')) {
    output.push({ at: `${at}.alignments`, value: value.alignments });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'alignments') collectAlignments(child, at ? `${at}.${key}` : key, output);
  }
  return output;
}

function assertInstrumentModel(moduleDocument, errors) {
  const domain = moduleDocument?.domain;
  const financialInstrument = domain?.objectTypes?.FinancialInstrument;
  const security = domain?.objectTypes?.Security;
  const offering = domain?.objectTypes?.SecurityOffering;
  const issuance = domain?.associationTypes?.InstrumentIssuance;
  const offeredSecurity = domain?.relationTypes?.offeredSecurity;
  if (!financialInstrument || canonicalJcs(financialInstrument.attributeUses) !== '[]') {
    errors.push('instruments: FinancialInstrument must not acquire mandatory issuer/currency attributes');
  }
  if (!security || canonicalJcs(security.superTypes) !== canonicalJcs([
    'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument',
  ])) {
    errors.push('instruments: Security must remain a local FinancialInstrument subtype');
  }
  if (!offering || !issuance || !offeredSecurity
      || offeredSecurity.domain !== offering.iri
      || offeredSecurity.range !== security.iri) {
    errors.push('instruments: SecurityOffering/offeredSecurity separation is absent');
  }
  const roles = new Map((issuance?.participantRoles || []).map((role) => [role.id, role]));
  if (roles.get('issuedSecurity')?.range !== security?.iri
      || roles.get('issuedSecurity')?.minCount !== 1
      || roles.get('issuedSecurity')?.maxCount !== 1
      || roles.get('issuer')?.range !== 'https://axiolune.ai/ontology/finance/foundation/LegalEntity'
      || roles.get('issuer')?.minCount !== 1
      || roles.get('originatingOffering')?.range !== offering?.iri
      || roles.get('originatingOffering')?.minCount !== 0) {
    errors.push('instruments: issuance must remain a separate exact Security/issuer fact with optional offering');
  }
}

function assertPortfolioModel(moduleDocument, errors) {
  const domain = moduleDocument?.domain;
  const portfolio = domain?.objectTypes?.Portfolio;
  const membership = domain?.associationTypes?.PortfolioAccountMembership;
  const portfolioContract = domain?.constraints?.PortfolioContract;
  if (!portfolio || !(portfolio.attributeUses || []).some((use) => (
    use.attribute === 'https://axiolune.ai/ontology/finance/portfolio-positions/portfolioId'
      && use.minCount === 1 && use.maxCount === 1
  ))) {
    errors.push('portfolio: stable Portfolio identifier contract is absent');
  }
  const roles = new Map((membership?.participantRoles || []).map((role) => [role.id, role]));
  if (roles.get('membershipPortfolio')?.range !== portfolio?.iri
      || roles.get('memberAccount')?.range !== 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount'
      || roles.get('membershipPortfolio')?.minCount !== 1
      || roles.get('memberAccount')?.minCount !== 1) {
    errors.push('portfolio: temporal PortfolioAccountMembership path is absent');
  }
  const expression = portfolioContract?.expression?.expression || '';
  if (!portfolioContract || /Holding|comprises|membership/iu.test(expression)) {
    errors.push('portfolio: Portfolio identity contract must not require a non-empty Holding composition');
  }
  for (const key of ['PositionLot', 'HoldingSnapshot']) {
    if (!domain?.associationTypes?.[key]) errors.push(`portfolio: ${key} contract is absent`);
  }
}

function verifyReviewedNoAlignments(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..', '..', '..'));
  const overrides = options.byteOverrides || new Map();
  const readBytes = (relativePath) => {
    const override = overrides.get(relativePath);
    return override === undefined
      ? fs.readFileSync(safeResolve(rootDir, relativePath))
      : Buffer.from(override);
  };
  const errors = [];
  let document;
  let lock;
  try {
    document = options.document || JSON.parse(readBytes(DECISION_PATH).toString('utf8'));
    lock = options.lockDocument || YAML.parse(readBytes(LOCK_PATH).toString('utf8'));
  } catch (error) {
    return { ok: false, errors: [`input parse failed: ${error.message}`], evidence: null };
  }

  exactKeys(document, ['schemaVersion', 'profileId', 'reference', 'review', 'decisions'], 'decisionDocument', errors);
  exactKeys(document.reference, ['id', 'releaseOrCommit', 'artifactDigest'], 'decisionDocument.reference', errors);
  exactKeys(document.review, [
    'conclusion', 'performedBy', 'reviewDate', 'approvalStatus', 'note',
  ], 'decisionDocument.review', errors);
  if (document.schemaVersion !== '1.0' || document.profileId !== PROFILE_ID) {
    errors.push('decisionDocument: profile header mismatch');
  }
  if (document.review?.conclusion !== 'reviewed-no-alignment'
      || document.review?.approvalStatus !== 'not-approved'
      || document.review?.reviewDate !== '2026-08-02'
      || document.review?.performedBy !== 'urn:axiolune:agent:codex:m2-no-alignment-review-2026-08-02'
      || document.review?.note !== 'Exact local element semantics and exact locked FIBO source spans were reviewed. These decisions reject the candidate subclass axioms; they do not approve either M2 module or the M2 release.') {
    errors.push('decisionDocument.review: decision must remain reviewed-no-alignment and not-approved');
  }
  const fiboMatches = (lock?.references || []).filter((reference) => reference.id === FIBO_ID);
  const fibo = fiboMatches.length === 1 ? fiboMatches[0] : null;
  if (!fibo
      || document.reference?.id !== FIBO_ID
      || document.reference?.releaseOrCommit !== fibo.releaseOrCommit
      || document.reference?.artifactDigest !== fibo.artifactDigest) {
    errors.push('decisionDocument.reference: exact FIBO lock pin mismatch');
  }
  if (fibo?.localPath) {
    try {
      const actualBundleDigest = computeBundleDigest(safeResolve(rootDir, fibo.localPath));
      if (actualBundleDigest !== fibo.artifactDigest) {
        errors.push(`FIBO bundle digest mismatch: expected ${fibo.artifactDigest}, got ${actualBundleDigest}`);
      }
    } catch (error) {
      errors.push(`FIBO bundle verification failed: ${error.message}`);
    }
  }

  const decisions = Array.isArray(document.decisions) ? document.decisions : [];
  const decisionIds = decisions.map((decision) => decision?.decisionId).sort(utf8Compare);
  const requiredIds = Object.keys(REQUIRED_DECISIONS).sort(utf8Compare);
  if (canonicalJcs(decisionIds) !== canonicalJcs(requiredIds)) {
    errors.push(`decisionDocument.decisions: expected exact decision set ${requiredIds.join(', ')}`);
  }
  const moduleCache = new Map();
  const projectionCache = new Map();
  const decisionEvidence = [];

  for (const decision of decisions) {
    const spec = REQUIRED_DECISIONS[decision?.decisionId];
    if (!spec) continue;
    const at = `decisions.${decision.decisionId}`;
    exactKeys(decision, [
      'decisionId', 'modulePath', 'projectionPath', 'local', 'candidate',
      'outcome', 'reasonCodes', 'semanticBasis',
    ], at, errors);
    exactKeys(decision.local, [
      'container', 'key', 'iri', 'expectedElementDigest', 'expectedDefinition', 'expectedProjectionType',
    ], `${at}.local`, errors);
    exactKeys(decision.candidate, [
      'relation', 'targetIri', 'sourceLocator', 'expectedSelectedContentDigest',
      'expectedDefinition', 'expectedDirectParentIris',
    ], `${at}.candidate`, errors);
    const actualDecisionDigest = sha256(Buffer.from(canonicalJcs(decision), 'utf8'));
    if (actualDecisionDigest !== spec.decisionDigest) {
      errors.push(`${at}: exact reviewed decision digest mismatch`);
    }
    const expectedLocatorKind = spec.locatorKind || 'textLineRange';
    const candidateLocator = decision.candidate?.sourceLocator;
    const locatorIdentityMatches = candidateLocator?.kind === expectedLocatorKind
      && candidateLocator?.path === spec.sourcePath
      && (expectedLocatorKind === 'textLineRange'
        ? candidateLocator?.startLine === spec.lines?.[0]
          && candidateLocator?.endLine === spec.lines?.[1]
        : candidateLocator?.resourceIri === spec.targetIri);
    if (decision.modulePath !== spec.modulePath
        || decision.projectionPath !== spec.projectionPath
        || decision.local?.container !== (spec.container || 'objectTypes')
        || decision.local?.key !== spec.key
        || decision.local?.iri !== spec.localIri
        || decision.candidate?.relation !== 'rdfs:subClassOf'
        || decision.candidate?.targetIri !== spec.targetIri
        || !locatorIdentityMatches
        || decision.outcome !== 'reviewed-no-alignment-semantic-mismatch'
        || canonicalJcs(decision.reasonCodes) !== canonicalJcs([spec.reasonCode])) {
      errors.push(`${at}: fixed local/candidate/outcome identity mismatch`);
    }

    let moduleDocument = moduleCache.get(spec.modulePath);
    if (!moduleDocument) {
      try {
        moduleDocument = YAML.parse(readBytes(spec.modulePath).toString('utf8'));
        moduleCache.set(spec.modulePath, moduleDocument);
      } catch (error) {
        errors.push(`${at}: module parse failed: ${error.message}`);
        continue;
      }
    }
    const element = moduleDocument?.domain?.[decision.local?.container]?.[decision.local?.key];
    let localElementDigest = null;
    if (!element) {
      errors.push(`${at}.local: target element is absent`);
    } else {
      localElementDigest = sha256(Buffer.from(canonicalJcs(element), 'utf8'));
      if (localElementDigest !== decision.local.expectedElementDigest
          || element.iri !== decision.local.iri
          || element.definition !== decision.local.expectedDefinition) {
        errors.push(`${at}.local: exact element digest/IRI/definition mismatch`);
      }
    }
    if (collectAlignments(moduleDocument).length !== 0) {
      errors.push(`${at}: tracked module contains authored alignments without an approved semantic decision`);
    }
    if (JSON.stringify(moduleDocument).includes(spec.targetIri)) {
      errors.push(`${at}: rejected FIBO target leaked into the authored module`);
    }

    const locator = decision.candidate?.sourceLocator;
    let selected = null;
    let sourceFileDigest = null;
    if (!fibo || !locator) {
      errors.push(`${at}.candidate: FIBO source locator cannot be verified`);
    } else {
      const matches = (fibo.locators || []).filter((candidate) => canonicalJcs(candidate) === canonicalJcs(locator));
      if (matches.length !== 1) errors.push(`${at}.candidate.sourceLocator: must equal exactly one FIBO lock locator`);
      try {
        const profilePath = locator.extractorProfileRef?.path;
        if (locator.extractorProfileRef?.kind !== 'path'
            || locator.extractorProfileRef?.root !== 'sourceTree'
            || fileDigest(safeResolve(rootDir, profilePath)) !== locator.extractorProfileDigest) {
          errors.push(`${at}.candidate.sourceLocator: extractor profile digest mismatch`);
        }
        const sourceRepoPath = `${fibo.localPath}/${locator.path}`;
        const sourceBytes = readBytes(sourceRepoPath);
        sourceFileDigest = sha256(sourceBytes);
        if (locator.kind === 'textLineRange') {
          selected = extractTextLineRangeBytes(
            sourceBytes,
            locator.startLine,
            locator.endLine,
          );
        } else if (locator.kind === 'rdfResource') {
          selected = extractRdfXmlResourceBytes(sourceBytes, locator.resourceIri);
        } else {
          throw new Error(`unsupported reviewed source locator kind ${String(locator.kind)}`);
        }
        const validation = validateSourceLocator(locator, {
          at: `${at}.candidate.sourceLocator`,
          selectedBytes: selected,
        });
        errors.push(...validation.errors);
        const selectedDigest = sha256(selected);
        if (selectedDigest !== decision.candidate.expectedSelectedContentDigest) {
          errors.push(`${at}.candidate: selected-content digest mismatch`);
        }
        for (const snippet of spec.snippets) {
          if (!selected.includes(Buffer.from(snippet, 'utf8'))) {
            errors.push(`${at}.candidate: selected FIBO span lacks semantic fact ${snippet}`);
          }
        }
      } catch (error) {
        errors.push(`${at}.candidate: source replay failed: ${error.message}`);
      }
    }

    let quads = projectionCache.get(spec.projectionPath);
    let projectionDigest = null;
    let rejectedTriplePresent = null;
    try {
      const projectionBytes = readBytes(spec.projectionPath);
      projectionDigest = sha256(projectionBytes);
      if (!quads) {
        quads = new Parser({ baseIRI: spec.localIri }).parse(projectionBytes.toString('utf8'));
        projectionCache.set(spec.projectionPath, quads);
      }
      if (!quads.some((quad) => (
        quad.subject.value === spec.localIri
          && quad.predicate.value === RDF_TYPE
          && quad.object.value === decision.local.expectedProjectionType
      ))) {
        errors.push(`${at}.projection: expected local OWL type triple is absent`);
      }
      rejectedTriplePresent = quads.some((quad) => (
        quad.subject.value === spec.localIri
          && quad.predicate.value === RDFS_SUBCLASS
          && quad.object.value === spec.targetIri
      ));
      if (rejectedTriplePresent) {
        errors.push(`${at}.projection: rejected rdfs:subClassOf triple is present`);
      }
    } catch (error) {
      errors.push(`${at}.projection: parse failed: ${error.message}`);
    }

    decisionEvidence.push({
      decisionId: decision.decisionId,
      outcome: decision.outcome,
      decisionDigest: actualDecisionDigest,
      localElementDigest,
      sourceArtifactDigest: fibo?.artifactDigest || null,
      sourceFileDigest,
      sourceSelectionDigest: locator?.selectionDigest || null,
      selectedContentDigest: selected ? sha256(selected) : null,
      projectionDigest,
      rejectedTriple: {
        subject: spec.localIri,
        predicate: RDFS_SUBCLASS,
        object: spec.targetIri,
        present: rejectedTriplePresent,
      },
    });
  }

  for (const [modulePath, moduleDocument] of moduleCache) {
    if (modulePath.endsWith('/instruments/module.yaml')) assertInstrumentModel(moduleDocument, errors);
    if (modulePath.endsWith('/portfolio-positions/module.yaml')) assertPortfolioModel(moduleDocument, errors);
  }
  const ok = errors.length === 0;
  return {
    ok,
    errors,
    evidence: {
      schemaVersion: '1.0',
      evidenceKind: 'reviewed-no-alignment-verification',
      decisionSourceRef: { kind: 'path', root: 'sourceTree', path: DECISION_PATH },
      decisionSourceDigest: sha256(readBytes(DECISION_PATH)),
      referenceId: FIBO_ID,
      referenceArtifactDigest: fibo?.artifactDigest || null,
      conclusion: ok ? 'pass-reviewed-no-alignment' : 'fail',
      approvalStatus: 'not-approved',
      decisions: decisionEvidence.sort((left, right) => utf8Compare(left.decisionId, right.decisionId)),
      failureCount: errors.length,
    },
  };
}

module.exports = {
  DECISION_PATH,
  LOCK_PATH,
  REQUIRED_DECISIONS,
  computeBundleDigest,
  sha256,
  verifyReviewedNoAlignments,
};
