#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  artifactDigest,
  compilePublicSymbolManifest,
  sourceKey,
  utf8Compare,
} = require('./lib/public-symbol-compiler.cjs');
const {
  BUNDLE_TAG,
  computeWholeFileSelectionDigest,
  u64be,
} = require('./lib/reference-closure.cjs');
const {
  SOURCE_CITATIONS_TAG,
  citationSortTuple,
  taggedJcsDigest,
} = require('./lib/term-card-compiler.cjs');
const {
  digestCandidate: termAuthorityCandidateDigest,
} = require('./lib/term-authority.cjs');
const {
  validateSemanticReviewDecision,
} = require('./lib/authority-decision.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FINANCE_ROOT = path.join(ROOT, 'ontology', 'domain', 'finance');
const PUBLIC_SYMBOL_MANIFEST = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'public-symbol-manifest.json',
);
const REFERENCE_CLOSURE = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reference-closure-manifest.json',
);
const AUTHORITY_FILE = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-terminology',
  'm2-v0.3-terms.json',
);
const AUTHORITY_REFERENCE_ID = 'axiolune-m2-controlled-terminology';
const CARD_ROOT = path.join(ROOT, 'docs', 'ontology', 'term-cards', 'v0.3');
const DIRECT_ROOT = path.join(CARD_ROOT, 'direct');
const REVIEW_ROOT = path.join(CARD_ROOT, 'reviews');
const INHERITANCE_ROOT = path.join(CARD_ROOT, 'inheritance');
const GENERATION_RULE = path.join(
  ROOT,
  'scripts',
  'domain',
  'rules',
  'public-iri-generation-v1.json',
);
const INDEX_FILE = path.join(CARD_ROOT, 'candidate-index.json');

function posix(relative) {
  return relative.split(path.sep).join('/');
}

function ref(file) {
  return {
    kind: 'path',
    root: 'sourceTree',
    path: posix(path.relative(ROOT, file)),
  };
}

function exactJcsFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${posix(path.relative(ROOT, file))}`);
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} must be exact UTF-8 RFC 8785 JCS bytes`);
  }
  return { bytes, value };
}

function discoverModules() {
  return fs.readdirSync(FINANCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .map((entry) => path.join(FINANCE_ROOT, entry.name, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => utf8Compare(posix(left), posix(right)))
    .map((file) => YAML.parse(fs.readFileSync(file, 'utf8')));
}

function tupleCompare(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const comparison = utf8Compare(String(left[index] ?? ''), String(right[index] ?? ''));
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function closureEntryMap(closure) {
  if (!closure || !Array.isArray(closure.entries)) {
    throw new Error('reference closure must contain an entries array');
  }
  const map = new Map();
  for (const entry of closure.entries) {
    if (typeof entry.referenceId !== 'string' || map.has(entry.referenceId)) {
      throw new Error('reference closure IDs must be non-empty and unique');
    }
    map.set(entry.referenceId, entry);
  }
  return map;
}

function citationFromEvidence(evidence, closureById) {
  if (!['normative', 'implementation'].includes(evidence.usage)) return null;
  const entry = closureById.get(evidence.referenceId);
  if (!entry) throw new Error(`upstream reference ${evidence.referenceId} is absent from closure`);
  return {
    referenceId: evidence.referenceId,
    artifactRef: entry.artifactRef,
    artifactDigest: entry.artifactDigest,
    locator: evidence.locator,
    usage: evidence.usage,
  };
}

function authorityCitation(authorityEntry, reviewed) {
  if (!Array.isArray(authorityEntry.locators)) {
    throw new Error('controlled-terminology closure entry lacks locators');
  }
  const locators = authorityEntry.locators.filter((locator) => (
    locator.kind === 'wholeFile'
      && locator.path === 'm2-v0.3-terms.json'
      && locator.mediaType === 'application/json'
  ));
  if (locators.length !== 1) {
    throw new Error('controlled-terminology closure must expose one exact JSON whole-file locator');
  }
  return {
    referenceId: AUTHORITY_REFERENCE_ID,
    artifactRef: authorityEntry.artifactRef,
    artifactDigest: authorityEntry.artifactDigest,
    locator: locators[0],
    usage: reviewed ? 'normative' : 'implementation',
  };
}

function referenceBundleDigest(directory) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`controlled-terminology authority contains a non-regular entry: ${absolute}`);
    }
  }
  visit(directory);
  files.sort((left, right) => utf8Compare(posix(path.relative(directory, left)), posix(path.relative(directory, right))));
  const hash = require('node:crypto').createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relative = Buffer.from(posix(path.relative(directory, file)), 'utf8');
    const bytes = fs.readFileSync(file);
    hash.update(u64be(relative.length));
    hash.update(relative);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function collectGeneratedSources(moduleDocs, publicByIri) {
  const sources = [];
  function add(source) {
    const publicSymbol = publicByIri.get(source.generatedIri);
    if (!publicSymbol
        || publicSymbol.origin !== 'generated'
        || publicSymbol.generatedKind !== source.generatedKind
        || publicSymbol.sourceElementKey !== source.sourceElementKey
        || publicSymbol.ownerModule !== source.ownerModule) {
      throw new Error(`generated source does not join public-symbol manifest: ${source.generatedIri}`);
    }
    sources.push(source);
  }

  for (const document of moduleDocs) {
    const ownerModule = document.module.moduleIri;
    const exports = new Set(document.module.exports || []);
    const exportsAll = exports.size === 0;
    const selected = (element) => exportsAll || exports.has(element.iri);
    for (const containerName of ['objectTypes', 'associationTypes']) {
      for (const element of Object.values(document.domain[containerName] || {})) {
        if (!selected(element)) continue;
        if (element.abstract !== true) {
          const logicalTuple = { kind: 'logicalIdentityClass', typeIri: element.iri };
          add({
            definition: element.definition,
            generatedIri: `${element.iri}/LogicalIdentity`,
            generatedKind: 'logicalIdentityClass',
            ownerModule,
            sourceElementKey: sourceKey(logicalTuple),
            sourcePublicIri: element.iri,
          });
        }
        if (containerName === 'associationTypes') {
          for (const role of element.participantRoles || []) {
            const roleTuple = {
              kind: 'participantRole',
              containingType: element.iri,
              roleId: role.id,
            };
            add({
              definition: role.definition,
              generatedIri: `${element.iri}/role/${role.id}`,
              generatedKind: 'rolePredicate',
              ownerModule,
              sourceElementKey: sourceKey(roleTuple),
              sourcePublicIri: element.iri,
            });
          }
        }
      }
    }
    for (const codeList of Object.values(document.domain.codeLists || {})) {
      if (!selected(codeList)) continue;
      for (const value of codeList.values || []) {
        const valueTuple = {
          kind: 'codeValue',
          codeListIri: codeList.iri,
          codeValueIri: value.iri,
        };
        add({
          definition: value.definition,
          generatedIri: value.iri,
          generatedKind: 'codeMember',
          ownerModule,
          sourceElementKey: sourceKey(valueTuple),
          sourcePublicIri: codeList.iri,
        });
      }
    }
  }
  return sources.sort((left, right) => utf8Compare(left.generatedIri, right.generatedIri));
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function cardPath(sourceElementKey) {
  return path.join(DIRECT_ROOT, `${sourceElementKey.slice('sha256:'.length)}.json`);
}

function reviewPath(sourceElementKey) {
  return path.join(REVIEW_ROOT, `${sourceElementKey.slice('sha256:'.length)}.json`);
}

function inheritancePath(sourceElementKey) {
  return path.join(INHERITANCE_ROOT, `${sourceElementKey.slice('sha256:'.length)}.json`);
}

function compileArtifacts() {
  const modules = discoverModules();
  const expectedPublic = compilePublicSymbolManifest(modules).manifest;
  const publicArtifact = exactJcsFile(PUBLIC_SYMBOL_MANIFEST, 'public-symbol manifest');
  if (canonicalJcs(publicArtifact.value) !== canonicalJcs(expectedPublic)) {
    throw new Error('public-symbol manifest is not the exact current module projection');
  }
  const authorityArtifact = exactJcsFile(AUTHORITY_FILE, 'controlled terminology authority');
  const authority = authorityArtifact.value;
  if (canonicalJcs(Object.keys(authority).sort()) !== canonicalJcs([
    'candidateDigest',
    'decision',
    'entries',
    'profileRef',
    'schemaVersion',
    'snapshotVersion',
  ].sort())
      || authority.schemaVersion !== '1.0'
      || authority.profileRef !== expectedPublic.profileRef
      || authority.snapshotVersion !== '0.3.0'
      || !Array.isArray(authority.entries)
      || authority.entries.length === 0
      || authority.candidateDigest !== termAuthorityCandidateDigest(
        authority.snapshotVersion,
        authority.entries,
        authority.profileRef,
      )) {
    throw new Error('controlled terminology authority is not the exact digest-bound v0.3 envelope');
  }
  const decisionStatus = validateSemanticReviewDecision(
    authority.decision,
    'controlled terminology authority.decision',
    authority.candidateDigest,
  );
  const closure = exactJcsFile(REFERENCE_CLOSURE, 'reference closure').value;
  const closureById = closureEntryMap(closure);
  const authorityClosureEntry = closureById.get(AUTHORITY_REFERENCE_ID);
  if (!authorityClosureEntry) {
    throw new Error('controlled terminology authority is not present in reference closure');
  }
  const authorityDirectory = path.dirname(AUTHORITY_FILE);
  const expectedAuthorityRef = ref(authorityDirectory);
  const authorityLocators = Array.isArray(authorityClosureEntry.locators)
    ? authorityClosureEntry.locators.filter((locator) => (
      locator.kind === 'wholeFile'
        && locator.path === path.basename(AUTHORITY_FILE)
        && locator.mediaType === 'application/json'
    ))
    : [];
  if (canonicalJcs(authorityClosureEntry.artifactRef) !== canonicalJcs(expectedAuthorityRef)
      || authorityClosureEntry.artifactDigest !== referenceBundleDigest(authorityDirectory)
      || authorityLocators.length !== 1
      || computeWholeFileSelectionDigest(authorityLocators[0], AUTHORITY_FILE)
        !== authorityLocators[0].selectionDigest) {
    throw new Error('controlled terminology authority reference closure is stale or does not bind exact bytes');
  }
  const reviewed = decisionStatus === 'reviewed';
  const baseCitation = authorityCitation(authorityClosureEntry, reviewed);
  const publicByIri = new Map(expectedPublic.symbols.map((symbol) => [symbol.publicIri, symbol]));
  const authorityByIri = new Map(authority.entries.map((entry) => [entry.publicIri, entry]));
  const authoredSymbols = expectedPublic.symbols.filter((symbol) => symbol.origin === 'authored');
  if (authority.entries.length !== authorityByIri.size
      || authorityByIri.size !== authoredSymbols.length) {
    throw new Error('controlled terminology authority does not equal the authored public-symbol inventory');
  }

  const files = new Map();
  const cards = new Map();
  for (const symbol of authoredSymbols) {
    const authorityEntry = authorityByIri.get(symbol.publicIri);
    if (!authorityEntry
        || authorityEntry.sourceElementKey !== symbol.sourceElementKey
        || authorityEntry.ownerModule !== symbol.ownerModule) {
      throw new Error(`authority/public-symbol join failed for ${symbol.publicIri}`);
    }
    const citations = [
      baseCitation,
      ...(authorityEntry.upstreamEvidence || [])
        .map((evidence) => citationFromEvidence(evidence, closureById))
        .filter((citation) => citation !== null),
    ].sort((left, right) => tupleCompare(citationSortTuple(left), citationSortTuple(right)));
    const card = {
      candidateM3Type: authorityEntry.candidateM3Type,
      definition: authorityEntry.definition,
      definitionDigest: authorityEntry.definitionDigest,
      differentia: authorityEntry.differentia,
      excludes: authorityEntry.excludes,
      genus: authorityEntry.genus,
      ownerRef: authorityEntry.ownerRef,
      preferredLabel: authorityEntry.preferredLabel,
      publicIri: authorityEntry.publicIri,
      schemaVersion: '1.0',
      sourceCitations: citations,
      status: reviewed ? 'accepted' : 'review',
      version: authorityEntry.version,
    };
    const file = cardPath(symbol.sourceElementKey);
    const bytes = jcsBytes(card);
    files.set(file, bytes);
    cards.set(symbol.publicIri, {
      card,
      cardDigest: artifactDigest(bytes),
      cardRef: ref(file),
      sourceElementKey: symbol.sourceElementKey,
    });
  }

  const reviews = new Map();
  if (reviewed) {
    for (const [publicIri, cardState] of cards) {
      const review = {
        cardDigest: cardState.cardDigest,
        cardRef: cardState.cardRef,
        decision: 'accept',
        decisionTime: authority.decision.decisionTime,
        publicIri,
        rationale: `Digest-bound semantic review of exact controlled-terminology candidate ${authority.candidateDigest}; the card is its exact normalized module projection. This review is not terminal release adoption.`,
        reviewedDefinitionDigest: cardState.card.definitionDigest,
        reviewedVersion: cardState.card.version,
        reviewerRef: authority.decision.reviewerRef,
        schemaVersion: '1.0',
        sourceCitationsDigest: taggedJcsDigest(
          SOURCE_CITATIONS_TAG,
          cardState.card.sourceCitations,
        ),
      };
      const file = reviewPath(cardState.sourceElementKey);
      const bytes = jcsBytes(review);
      files.set(file, bytes);
      reviews.set(publicIri, {
        review,
        reviewDigest: artifactDigest(bytes),
        reviewRef: ref(file),
      });
    }
  }

  const generatedSources = collectGeneratedSources(modules, publicByIri);
  const generationRuleBytes = fs.readFileSync(GENERATION_RULE);
  if (generatedSources.length > 0 && generationRuleBytes.length === 0) {
    throw new Error('public IRI generation rule is empty');
  }
  if (reviewed) {
    for (const source of generatedSources) {
      const cardState = cards.get(source.sourcePublicIri);
      const reviewState = reviews.get(source.sourcePublicIri);
      if (!cardState || !reviewState) {
        throw new Error(`generated term lacks accepted source card/review: ${source.generatedIri}`);
      }
      const inheritance = {
        generatedIri: source.generatedIri,
        generatedKind: source.generatedKind,
        generationRuleDigest: artifactDigest(generationRuleBytes),
        generationRuleRef: ref(GENERATION_RULE),
        inheritedDefinitionDigest: artifactDigest(Buffer.from(source.definition, 'utf8')),
        ownerRef: cardState.card.ownerRef,
        reviewRecordDigest: reviewState.reviewDigest,
        reviewRecordRef: reviewState.reviewRef,
        schemaVersion: '1.0',
        sourceCardDigest: cardState.cardDigest,
        sourceCardRef: cardState.cardRef,
        sourceCitationsDigest: taggedJcsDigest(
          SOURCE_CITATIONS_TAG,
          cardState.card.sourceCitations,
        ),
        sourceElementKey: source.sourceElementKey,
      };
      files.set(inheritancePath(source.sourceElementKey), jcsBytes(inheritance));
    }
  }

  const directIndex = [...cards.entries()]
    .sort(([left], [right]) => utf8Compare(left, right))
    .map(([publicIri, state]) => ({
      cardDigest: state.cardDigest,
      cardRef: state.cardRef,
      publicIri,
    }));
  const index = {
    authorityArtifactDigest: artifactDigest(authorityArtifact.bytes),
    authorityCandidateDigest: authority.candidateDigest,
    authorityDecisionStatus: authority.decision.status,
    directCardCount: directIndex.length,
    directCardsDigest: taggedJcsDigest(
      'axiolune-direct-term-card-index-v1\0',
      directIndex,
    ),
    generatedInheritanceCount: reviewed ? generatedSources.length : 0,
    profileRef: expectedPublic.profileRef,
    reviewCount: reviewed ? reviews.size : 0,
    schemaVersion: '1.0',
  };
  files.set(INDEX_FILE, jcsBytes(index));
  return { reviewed, files, index };
}

function existingJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function synchronize(compiled, write) {
  const actualFiles = [
    ...existingJsonFiles(DIRECT_ROOT),
    ...existingJsonFiles(REVIEW_ROOT),
    ...existingJsonFiles(INHERITANCE_ROOT),
    ...(fs.existsSync(INDEX_FILE) ? [INDEX_FILE] : []),
  ];
  const expectedPaths = new Set(compiled.files.keys());
  const extras = actualFiles.filter((file) => !expectedPaths.has(file));
  if (extras.length > 0) {
    throw new Error(
      `refusing to delete ${extras.length} unexpected term-card artifact(s): `
      + extras.slice(0, 5).map((file) => posix(path.relative(ROOT, file))).join(', '),
    );
  }
  const drift = [];
  for (const [file, bytes] of compiled.files) {
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) drift.push(file);
  }
  if (!write && drift.length > 0) {
    throw new Error(
      `${drift.length} term-card artifact(s) are missing or drifted; first: `
      + posix(path.relative(ROOT, drift[0])),
    );
  }
  if (write) {
    for (const file of drift) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, compiled.files.get(file));
    }
  }
  return drift.length;
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const unknown = argv.filter((argument) => !['--check', '--write'].includes(argument));
  if (unknown.length > 0) {
    throw new Error('usage: node scripts/domain/generate-term-card-artifacts.cjs [--check|--write]');
  }
  const compiled = compileArtifacts();
  const changed = synchronize(compiled, write);
  const disposition = compiled.reviewed
    ? 'release-candidate-semantic-review-complete'
    : 'pending-semantic-review';
  process.stdout.write(
    `${write ? 'WROTE' : 'PASS'} ${compiled.index.directCardCount} direct cards, `
    + `${compiled.index.reviewCount} reviews, `
    + `${compiled.index.generatedInheritanceCount} inheritance records `
    + `(${changed} ${write ? 'written' : 'drifted'}, ${disposition})\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`FATAL term-card artifact generation: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  collectGeneratedSources,
  compileArtifacts,
  main,
};
