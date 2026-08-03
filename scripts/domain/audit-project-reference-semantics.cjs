'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const { collectActiveReferenceEvidence } = require('./lib/active-reference-evidence.cjs');
const {
  loadSemanticReviewDecisions,
} = require('./lib/semantic-reference-review-decisions.cjs');
const {
  EVIDENCE_USE,
  loadProjectReferenceSemanticEvidence,
} = require('./lib/project-reference-semantic-evidence.cjs');
const {
  SEMANTIC_MAPPINGS,
  SEMANTIC_RULES,
  categoryFromPath,
  compareUtf8,
  digest,
  extensionOf,
  mediaTypeFor,
  posix,
  semanticScan,
  walkFiles,
} = require('./generate-project-reference-review.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.join(ROOT, 'reference', 'project-reference');
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const REVIEW_ROOT = path.join(ROOT, 'docs', 'ontology', 'references', 'reviews');
const DECISIONS_PATH = path.join(REVIEW_ROOT, 'semantic-review-decisions.json');
const EVIDENCE_PATH = path.join(
  REVIEW_ROOT,
  'project-reference',
  'project-reference-semantic-evidence.json',
);
const REVIEWER_REF = 'tool:axiolune-project-reference-triage/v1';
const LEGACY_AUTOMATED_REVIEWER_REFS = new Set([
  'codex-agent:/root/project_reference_semantic_audit',
  REVIEWER_REF,
]);
const MODES = process.argv.filter((arg) => arg === '--write' || arg === '--check');
if (MODES.length !== 1) {
  throw new Error('usage: node scripts/domain/audit-project-reference-semantics.cjs --write|--check');
}
const CHECK_ONLY = MODES[0] === '--check';

const REVIEWED_AGAINST = [
  'docs/domain/planning/M2-PLAN.md#01-m2-完成的严格定义',
  'docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md#523-reference-contract',
  'docs/ontology/competency-questions',
  'ontology/domain/finance',
];

const TAG_ASSESSMENTS = new Map(Object.entries({
  PIT: 'Its as-of/publication/revision mechanics do not by themselves establish the valid, knowledge, and availability axes plus a PITValidationRequest bound to one run and exact inputs.',
  identity: 'Its runtime identifiers or symbols do not establish the active M2 canonical-key, revisionIdentityRule, alias-resolution, and immutable fact-version identity contracts.',
  instrument: 'Its implementation asset/security types are not an authoritative FinancialInstrument taxonomy or an exact controlled-set alignment.',
  market: 'Its feed, quote, trade, bar, or order-book representation does not establish the active market-data fact identity, three-axis time, and source-provenance contract.',
  marketRules: 'Its executable venue rule lacks the complete M2 RuleApplicability scope, versioned effective interval, knowledge/availability interval, and authoritative-source binding.',
  order: 'Its order/fill API or state machine does not establish the complete immutable OrderLifecycleEvent identity, three-axis time, generating-input, and evidence-provenance contract.',
  portfolio: 'Its account, holding, position, valuation, or PnL runtime model does not establish the active position-lot lineage, valuation-input identity, as-of selection, and reconciliation contracts.',
  posttrade: 'Its clearing, allocation, settlement, custody, or corporate-action workflow is not an exact M2 obligation/event/reconciliation fact contract.',
  provenance: 'Its source/log/version metadata is not equivalent to the active SourceContract, MaterializationRun, evidence digest, and byte-traceable generating-input chain.',
  risk: 'Its risk or performance calculation does not establish the active risk-observation identity, scenario/input lineage, temporal axes, and reproducible run evidence.',
  strategy: 'Its strategy, signal, factor, indicator, optimizer, or backtest API is not the active FactorObservation/SignalObservation revision and research-lineage contract.',
  temporal: 'Its timestamps or time-series indexes are operational fields and do not jointly establish validFrom/validTo, knowledgeFrom/knowledgeTo, and availableFrom/availableTo.',
}));

const SOURCE_EXTENSIONS = new Set([
  '.bash', '.bat', '.capnp', '.cs', '.csx', '.h', '.java', '.js', '.mjs',
  '.ps1', '.pxd', '.py', '.pyi', '.pyx', '.rs', '.sh', '.sql', '.ts', '.vue',
]);
const DOCUMENT_EXTENSIONS = new Set(['.html', '.ipynb', '.md', '.rst', '.txt']);
const TAG_PRIORITY = [
  'PIT',
  'temporal',
  'identity',
  'marketRules',
  'order',
  'portfolio',
  'posttrade',
  'risk',
  'strategy',
  'market',
  'instrument',
  'provenance',
];

function slug(name) {
  return name.normalize('NFC').replace(/_/gu, '-').toLowerCase();
}

function sanitize(value, limit = 180) {
  const normalized = String(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function withinProjectPath(repoPath) {
  return repoPath.split('/').slice(3).join('/');
}

function isBoilerplateLine(line) {
  const value = line.trim();
  return value === ''
    || /SPDX-License-Identifier|copyright|licensed under|all rights reserved/iu.test(value)
    || /you may (?:not )?use this file|distributed under the license/iu.test(value)
    || /WITHOUT WARRANTIES OR CONDITIONS|limitations under the license/iu.test(value)
    || /^https?:\/\/\S+$/iu.test(value)
    || /^[/*#;!\-=_ ]+$/u.test(value);
}

function isSemanticNoise(tag, line, matched) {
  const value = line.toLowerCase();
  if (tag === 'identity' && /spdx-license-identifier|license identifier/iu.test(value)) return true;
  if (tag === 'identity' && /matplotlib\.ticker|axis(?:es)?[^\n]{0,40}\bticker\b/iu.test(value)) return true;
  if (tag === 'order' && /\bin order to\b|\border(?:ed|ing)? (?:by|of)\b/iu.test(value)) return true;
  if (tag === 'instrument' && /(?:static|web|image|css|javascript) assets?/iu.test(value)) return true;
  if (tag === 'market' && /\bmarketing\b/iu.test(value)) return true;
  if (/"image\/(?:png|jpeg|svg\+xml)"\s*:|data:image\/|[A-Za-z0-9+/]{500,}={0,2}/u.test(line)) return true;
  return isBoilerplateLine(line) && !/[A-Za-z_]\w*(?:Order|Trade|Position|Portfolio|Risk|Market)/u.test(matched);
}

function excerptAroundMatch(line, matchIndex, matchLength) {
  const radius = 80;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(line.length, matchIndex + matchLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return sanitize(`${prefix}${line.slice(start, end)}${suffix}`);
}

function sourceKind(filePath) {
  const extension = extensionOf(filePath);
  if (SOURCE_EXTENSIONS.has(extension)) return `${extension.slice(1) || 'extensionless'} source`;
  if (DOCUMENT_EXTENSIONS.has(extension)) return `${extension.slice(1) || 'plain-text'} documentation`;
  if (extension === '.csv') return 'CSV data/documentation';
  if (['.json', '.jsonc', '.jsonl'].includes(extension)) return 'JSON data/configuration';
  if (['.yaml', '.yml'].includes(extension)) return 'YAML data/configuration';
  if (['.toml', '.ini', '.cfg', '.config', '.properties'].includes(extension)) {
    return `${extension.slice(1)} configuration`;
  }
  if (['.xml', '.csproj', '.sbe', '.svg'].includes(extension)) return 'XML structured text';
  return `${extension.slice(1) || 'extensionless'} UTF-8 text`;
}

function roleFromPath(repoPath, category) {
  const lower = withinProjectPath(repoPath).toLowerCase();
  if (category === 'test-or-fixture') return 'test or fixture exercising project behavior';
  if (category === 'documentation-or-example') return 'documentation, notebook, tutorial, or worked example';
  if (/\b(?:readme|changelog|history|contributing|license|notice|authors?)\b/u.test(lower)) {
    return 'project metadata or contributor documentation';
  }
  if (/(?:broker|exchange|venue|adapter|execution)/u.test(lower)) return 'broker, venue, or execution adapter implementation';
  if (/(?:order|fill|trade)/u.test(lower)) return 'order, fill, or trade implementation';
  if (/(?:portfolio|position|holding|account|wallet|cash)/u.test(lower)) return 'portfolio, position, account, or cash implementation';
  if (/(?:settlement|clearing|corporate.?action|reconcil|custod)/u.test(lower)) return 'post-trade workflow implementation';
  if (/(?:risk|margin|drawdown|exposure|leverage|greek)/u.test(lower)) return 'risk or performance-measure implementation';
  if (/(?:strategy|factor|signal|indicator|backtest|optimizer|research)/u.test(lower)) {
    return 'strategy, research, signal, or backtest implementation';
  }
  if (/(?:market.?data|quote|ticker|bar|candle|ohlc|feed)/u.test(lower)) return 'market-data implementation';
  if (category === 'configuration') return 'build, dependency, or runtime configuration';
  if (category === 'project-metadata') return 'project metadata';
  if (category === 'generated-or-vendor') return 'generated or vendored project material';
  return 'project source or technical documentation';
}

function declarationLocators(lines, extension) {
  const locators = [];
  const add = (line, kind, excerpt) => {
    const normalized = sanitize(excerpt);
    if (!normalized) return;
    locators.push({ excerpt: normalized, kind, line });
  };
  for (let index = 0; index < lines.length && locators.length < 6; index++) {
    const line = lines[index];
    let match = null;
    if (['.py', '.pyi', '.pyx', '.pxd'].includes(extension)) {
      match = line.match(/^\s*(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/u);
    } else if (['.cs', '.csx', '.java'].includes(extension)) {
      match = line.match(/^\s*(?:(?:public|protected|private|internal|static|abstract|sealed|partial|readonly|unsafe|new)\s+)*(class|record|struct|interface|enum)\s+([A-Za-z_]\w*)/u);
    } else if (extension === '.rs') {
      match = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:async\s+)?(struct|enum|trait|fn|type|mod)\s+([A-Za-z_]\w*)/u);
    } else if (['.js', '.mjs', '.ts', '.vue'].includes(extension)) {
      match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/u);
    } else if (['.h', '.capnp', '.sbe'].includes(extension)) {
      match = line.match(/^\s*(?:(?:typedef|public|private|protected)\s+)?(struct|enum|class|interface|message)\s+([A-Za-z_]\w*)/u);
    }
    if (match) add(index + 1, `${match[1]} declaration`, `${match[2]} — ${line}`);
  }
  return locators;
}

function documentationLocators(lines, extension) {
  const locators = [];
  const add = (line, kind, excerpt) => {
    const normalized = sanitize(excerpt);
    if (normalized) locators.push({ excerpt: normalized, kind, line });
  };
  for (let index = 0; index < lines.length && locators.length < 5; index++) {
    const line = lines[index];
    if (extension === '.md') {
      const match = line.match(/^\s{0,3}#{1,6}\s+(.+)/u);
      if (match) add(index + 1, 'heading', match[1]);
    } else if (extension === '.rst' && index + 1 < lines.length
        && /^[=\-~^"'`:+*#<>_]{3,}\s*$/u.test(lines[index + 1])) {
      add(index + 1, 'heading', line);
    } else if (extension === '.ipynb') {
      const trimmed = line.trim().replace(/,$/u, '');
      if (/^"(?:source|cells|cell_type)"\s*:/u.test(trimmed)) {
        add(index + 1, 'notebook structure', line);
      } else if (/^"(?:#|[A-Za-z\u0080-\uFFFF])/u.test(trimmed)
          && !/^(?:"image\/|"[A-Za-z0-9+/]{200,})/u.test(trimmed)) {
        try {
          const decoded = JSON.parse(trimmed);
          if (typeof decoded === 'string' && sanitize(decoded).length > 8) {
            add(index + 1, 'notebook source', decoded);
          }
        } catch {
          // Other JSON structure is covered by the full-file parser and semantic inventory.
        }
      }
    }
  }
  return locators;
}

function structuredLocators(lines, extension) {
  const locators = [];
  const add = (line, kind, excerpt) => {
    const normalized = sanitize(excerpt);
    if (normalized) locators.push({ excerpt: normalized, kind, line });
  };
  if (extension === '.csv' && lines.length > 0) add(1, 'CSV header', lines[0]);
  for (let index = 0; index < lines.length && locators.length < 5; index++) {
    const line = lines[index];
    if (['.json', '.jsonc', '.jsonl'].includes(extension)) {
      const match = line.match(/^\s*"([^"\\]+)"\s*:/u);
      if (match) add(index + 1, 'JSON key', match[1]);
    } else if (['.yaml', '.yml'].includes(extension)) {
      const match = line.match(/^([A-Za-z_][\w.-]*)\s*:/u);
      if (match) add(index + 1, 'YAML key', match[1]);
    } else if (['.toml', '.ini', '.cfg', '.config', '.properties'].includes(extension)) {
      const match = line.match(/^\s*(?:\[([^\]]+)\]|([A-Za-z_][\w.-]*)\s*[=:])/u);
      if (match) add(index + 1, 'configuration key', match[1] || match[2]);
    } else if (['.xml', '.csproj', '.sbe', '.svg'].includes(extension)) {
      const match = line.match(/<([A-Za-z_][\w:.-]*)\b/u);
      if (match) add(index + 1, 'XML element', match[1]);
    }
  }
  return locators;
}

function semanticLocators(lines) {
  const byTag = new Map();
  for (const [tag, patterns] of SEMANTIC_RULES) {
    outer: for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      for (const pattern of patterns) {
        const expression = new RegExp(pattern.source, pattern.flags);
        expression.lastIndex = 0;
        const match = expression.exec(line);
        if (!match || isSemanticNoise(tag, line, match[0])) continue;
        byTag.set(tag, {
          excerpt: `${sanitize(match[0], 50)} — ${excerptAroundMatch(line, match.index, match[0].length)}`,
          kind: `${tag} semantic evidence`,
          line: index + 1,
        });
        break outer;
      }
    }
  }
  return byTag;
}

function firstContentLocator(lines) {
  for (let index = 0; index < lines.length; index++) {
    if (isBoilerplateLine(lines[index])) continue;
    const excerpt = sanitize(lines[index]);
    if (excerpt) return { excerpt, kind: 'content', line: index + 1 };
  }
  return {
    excerpt: lines.length === 0 || lines.every((line) => line.trim() === '')
      ? '<empty file>'
      : '<license or comment boilerplate only>',
    kind: 'complete-content assessment',
    line: 1,
  };
}

function uniqueSortedLocators(locators) {
  const byKey = new Map();
  for (const locator of locators) {
    const key = `${locator.line}\0${locator.kind}\0${locator.excerpt}`;
    byKey.set(key, locator);
  }
  return [...byKey.values()].sort((left, right) => (
    left.line - right.line
      || compareUtf8(left.kind, right.kind)
      || compareUtf8(left.excerpt, right.excerpt)
  )).slice(0, 6);
}

function inferredPathTags(repoPath) {
  const lower = withinProjectPath(repoPath).toLowerCase();
  const tags = [];
  const checks = [
    ['PIT', /(?:point.?in.?time|lookahead|pit)/u],
    ['marketRules', /(?:price.?limit|tick.?size|lot.?size|close.?today|trading.?calendar|session)/u],
    ['posttrade', /(?:settlement|clearing|corporate.?action|reconcil|custod)/u],
    ['portfolio', /(?:portfolio|position|holding|account|wallet|pnl|valuation)/u],
    ['order', /(?:order|fill|execution|trade)/u],
    ['risk', /(?:risk|margin|drawdown|exposure|leverage|greek)/u],
    ['strategy', /(?:strateg(?:y|ies)|factor|signal|indicator|backtest|optimizer|research|alpha|model|experiment|workflow|recorder|reinforcement|drl)/u],
    ['market', /(?:market.?data|quote|ticker|bar|candle|ohlc|feed)/u],
    ['identity', /(?:ticker|symbol|identifier|universe|sp500)/u],
    ['instrument', /(?:instrument|security|future|option|equity|stock|bond|fund|forex|crypto|asset|ticker|symbol|universe|sp500|components?)/u],
  ];
  for (const [tag, pattern] of checks) if (pattern.test(lower)) tags.push(tag);
  return tags.sort(compareUtf8);
}

function m2Assessment(disposition, meaningfulTags, role, kind) {
  if (disposition === 'candidateNoBearing') {
    return `Automated triage found no lexical, path, declaration, heading, or structured-key signal sufficient to nominate this ${kind} ${role} file as M2 evidence. This is only a candidateNoBearing classification; it does not establish semantic review or release closure.`;
  }
  const selected = [...meaningfulTags].sort((left, right) => (
    TAG_PRIORITY.indexOf(left) - TAG_PRIORITY.indexOf(right)
      || compareUtf8(left, right)
  )).slice(0, 3);
  const details = selected.map((tag) => TAG_ASSESSMENTS.get(tag)).filter(Boolean).join(' ');
  return `Automated triage found implementation/context signals for M2 ${selected.join(', ')} semantics. ${details} This is only a candidateRejected classification for later semantic review; it is not a reviewedRejected decision and cannot close release evidence.`;
}

function readLockState() {
  const document = YAML.parseDocument(fs.readFileSync(LOCK_PATH, 'utf8'), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('\n'));
  const lock = document.toJS({ maxAliasCount: 0 });
  const active = collectActiveReferenceEvidence(ROOT, lock);
  const byRoot = new Map();
  for (const row of lock.references || []) {
    if (typeof row.localPath !== 'string' || !row.localPath.startsWith('reference/project-reference/')) continue;
    const rootPath = row.localPath.replace(/\/+$/u, '');
    const rows = byRoot.get(rootPath) || [];
    rows.push({
      id: row.id,
      locatorPaths: (row.locators || []).map((locator) => `${rootPath}/${locator.path}`),
      releaseOrCommit: row.releaseOrCommit,
    });
    byRoot.set(rootPath, rows);
  }
  return { byRoot, usedPaths: active.usedPaths };
}

function observedCheckout(projectRoot) {
  const dotGit = path.join(projectRoot, '.git');
  if (!fs.existsSync(dotGit)) return { clean: null, commit: null };
  // The checked-in reference repositories can be owned by the workspace user
  // while verification runs under an isolated CI/sandbox account.  Bind the
  // exception to this exact, already-resolved project root instead of relying
  // on mutable global Git configuration or disabling ownership checks broadly.
  const gitPrefix = ['-c', `safe.directory=${projectRoot}`, '-C', projectRoot];
  const head = spawnSync('git', [...gitPrefix, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
    shell: false,
  });
  const status = spawnSync('git', [...gitPrefix, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    shell: false,
  });
  return {
    clean: status.status === 0 && status.stdout.trim() === '',
    commit: head.status === 0 && /^[0-9a-f]{40,64}$/u.test(head.stdout.trim())
      ? head.stdout.trim()
      : null,
  };
}

function provenanceAssessment(repoPath, checkout, lockRows) {
  const exactLock = checkout.commit !== null
    && lockRows.some((row) => row.releaseOrCommit === checkout.commit);
  const exactLocator = lockRows.some((row) => row.locatorPaths.includes(repoPath));
  if (exactLock && exactLocator) {
    return `Provenance boundary: checkout commit ${checkout.commit} and this exact locator are present in references.lock; any use remains implementation-only unless the active mapping explicitly selects it.`;
  }
  if (exactLock) {
    return `Provenance boundary: checkout commit ${checkout.commit} is pinned in references.lock, but this path is outside its exact locator set; it cannot serve as adopted evidence without an explicit digest-bound locator and semantic mapping.`;
  }
  if (checkout.commit) {
    return `Provenance blocker: a ${checkout.clean ? 'clean' : 'dirty'} checkout at observed commit ${checkout.commit} was inspected, but that commit/path is absent from references.lock; the observation is informational and cannot close normative or adopted evidence.`;
  }
  return 'Provenance blocker: the checked-in project has no readable exact commit and no matching references.lock locator, so the file cannot close normative, adopted, or release evidence.';
}

function evidenceForFile(filePath, projectId, checkout, lockRows) {
  const repoPath = posix(path.relative(ROOT, filePath)).normalize('NFC');
  const bytes = fs.readFileSync(filePath);
  const media = mediaTypeFor(filePath, bytes);
  if (media.contentKind === 'binary') return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const category = categoryFromPath(repoPath);
  const extension = extensionOf(filePath);
  let semanticText = text;
  if (extension === '.ipynb') {
    try {
      const notebook = JSON.parse(text);
      if (Array.isArray(notebook.cells)) {
        semanticText = notebook.cells.map((cell) => (
          Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '')
        )).join('\n');
      }
    } catch {
      // The project-review generator records a structured parse failure and reviews full UTF-8 text.
    }
  }
  const scannedTags = semanticScan(semanticText).tags;
  const pathTags = inferredPathTags(repoPath);
  // Every decodable file receives a digest-bound, file-specific disposition.
  // Configuration/metadata suffixes and terse fixture keys can hide semantics;
  // absence of a token/path hit is discovery output, not permission to bypass
  // the per-file evidence record. Binary payloads remain metadata-only.
  const lines = text === '' ? [] : text.split(/\r?\n/gu);
  const semantic = semanticLocators(lines);
  const meaningfulTags = [...new Set([
    ...semantic.keys(),
    ...pathTags,
  ])].sort(compareUtf8);
  const role = roleFromPath(repoPath, category);
  const kind = sourceKind(filePath);
  const declarations = declarationLocators(lines, extension);
  const headings = documentationLocators(lines, extension);
  const structured = structuredLocators(lines, extension);
  const evidenceLocators = uniqueSortedLocators([
    ...declarations.slice(0, 3),
    ...headings.slice(0, 2),
    ...structured.slice(0, 2),
    ...[...semantic.values()].slice(0, 3),
  ]);
  if (evidenceLocators.length === 0) evidenceLocators.push(firstContentLocator(lines));
  const disposition = meaningfulTags.length > 0 ? 'candidateRejected' : 'candidateNoBearing';
  const capsule = evidenceLocators
    .slice(0, 3)
    .map((locator) => `${locator.kind} ${sanitize(locator.excerpt, 100)} at L${locator.line}`)
    .join('; ');
  const semanticSummary = `${repoPath} is a ${role} (${kind}, ${bytes.length} exact bytes). Its file-specific content capsule is: ${capsule}.`;
  return {
    artifactDigest: digest(bytes),
    disposition,
    evidenceLocators,
    fileRole: role,
    m2Assessment: m2Assessment(disposition, meaningfulTags, role, kind),
    path: repoPath,
    projectId,
    provenanceAssessment: provenanceAssessment(repoPath, checkout, lockRows),
    reviewMethod: `deterministic full-byte UTF-8 decode of ${bytes.length} bytes with ${kind} declaration/heading/structured-key extraction, lexical/path signal classification, and exact 1-based candidate locators; no human or agent semantic review is inferred`,
    reviewStatus: 'automatedCandidate',
    reviewerRef: REVIEWER_REF,
    semanticSummary,
    semanticTags: meaningfulTags,
    sourceKind: kind,
  };
}

function writeOrCheck(filePath, bytes) {
  if (CHECK_ONLY) {
    if (!fs.existsSync(filePath)) throw new Error(`missing generated artifact ${posix(path.relative(ROOT, filePath))}`);
    const actual = fs.readFileSync(filePath);
    if (!actual.equals(bytes)) throw new Error(`generated artifact drift ${posix(path.relative(ROOT, filePath))}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function run() {
  const loadedDecisions = loadSemanticReviewDecisions({ manifestPath: DECISIONS_PATH, rootDir: ROOT });
  const lock = readLockState();
  const records = [];
  const projectEntries = fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareUtf8(slug(left.name), slug(right.name)));
  const summaries = [];
  for (const projectEntry of projectEntries) {
    const projectRoot = path.join(PROJECT_ROOT, projectEntry.name);
    const rootPath = posix(path.relative(ROOT, projectRoot));
    const projectId = slug(projectEntry.name);
    const checkout = observedCheckout(projectRoot);
    const lockRows = lock.byRoot.get(rootPath) || [];
    let skippedBinaryOrUndecodable = 0;
    let skippedMappedOrUsed = 0;
    const projectRecords = [];
    for (const filePath of walkFiles(projectRoot)) {
      const repoPath = posix(path.relative(ROOT, filePath)).normalize('NFC');
      if (lock.usedPaths.has(repoPath) || SEMANTIC_MAPPINGS.has(repoPath)) {
        skippedMappedOrUsed += 1;
        continue;
      }
      const record = evidenceForFile(filePath, projectId, checkout, lockRows);
      if (record === null) {
        skippedBinaryOrUndecodable += 1;
        continue;
      }
      projectRecords.push(record);
    }
    projectRecords.sort((left, right) => compareUtf8(left.path, right.path));
    records.push(...projectRecords);
    const dispositions = Object.fromEntries(['candidateNoBearing', 'candidateRejected'].map((value) => [
      value,
      projectRecords.filter((record) => record.disposition === value).length,
    ]));
    summaries.push({
      checkout,
      dispositions,
      projectId,
      reviewedFiles: projectRecords.length,
      skippedBinaryOrUndecodable,
      skippedMappedOrUsed,
    });
  }
  records.sort((left, right) => compareUtf8(left.path, right.path));
  const evidence = {
    evidenceUse: EVIDENCE_USE,
    recordKind: 'projectReferenceSemanticEvidence',
    records,
    reviewedAgainst: REVIEWED_AGAINST,
    schemaVersion: '1.0',
  };
  const evidenceBytes = Buffer.from(canonicalJcs(evidence), 'utf8');
  writeOrCheck(EVIDENCE_PATH, evidenceBytes);

  // Preserve authored/digest-bound project decisions, but remove legacy rows
  // that this automated scanner previously promoted by itself. Candidate
  // extraction is discovery input, never review authority.
  const merged = loadedDecisions.manifest.decisions.filter((decision) => (
    !decision.path.startsWith('reference/project-reference/')
      || !LEGACY_AUTOMATED_REVIEWER_REFS.has(decision.reviewerRef)
  ))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const decisionManifest = { decisions: merged, schemaVersion: '1.0' };
  const decisionsBytes = Buffer.from(canonicalJcs(decisionManifest), 'utf8');
  writeOrCheck(DECISIONS_PATH, decisionsBytes);

  const loadedEvidence = loadProjectReferenceSemanticEvidence({ evidencePath: EVIDENCE_PATH, rootDir: ROOT });
  if (loadedEvidence.byPath.size !== records.length) {
    throw new Error('project semantic triage candidate cardinality mismatch');
  }
  loadSemanticReviewDecisions({ manifestPath: DECISIONS_PATH, rootDir: ROOT });
  for (const summary of summaries) process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.stdout.write(`${CHECK_ONLY ? 'Verified' : 'Wrote'} ${records.length} file-specific automated triage candidates; zero candidates were promoted to semantic review decisions.\n`);
}

run();
