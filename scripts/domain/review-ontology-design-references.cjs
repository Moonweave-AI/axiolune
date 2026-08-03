'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { Parser: N3Parser } = require('n3');
const {
  BUNDLE_TAG,
  u64be,
} = require('./lib/reference-closure.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  collectActiveReferenceEvidence,
} = require('./lib/active-reference-evidence.cjs');
const {
  findUnusedDecisions,
  loadSemanticReviewDecisions,
  resolveSemanticReviewDecision,
} = require('./lib/semantic-reference-review-decisions.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const REFERENCE_ROOT = path.join(ROOT, 'reference', 'ontology-design-reference');
const OUTPUT_ROOT = path.join(ROOT, 'docs', 'ontology', 'references', 'reviews', 'ontology-design');
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const RFC_PATH = path.join(ROOT, 'docs', 'domain', 'planning', 'RFC-001-m2-conformance-profile-and-domain-contract.md');
const XML_HELPER = path.join(__dirname, 'lib', 'inspect-ontology-design-binaries.ps1');
const SEMANTIC_REVIEW_DECISIONS_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reviews',
  'semantic-review-decisions.json',
);
const REVIEWER_REF = 'codex-agent:/root/ontology_reference_semantic_audit';
const REVIEW_DATE = '2026-08-01';
const REVIEW_SCHEMA = '1.0';
const FRAGMENT_SCHEMA = '1.0';
const AUTHORITY_MANAGED_PROJECTS = new Set([
  'axiolune-controlled-quantity-units',
  'axiolune-controlled-terminology',
  'axiolune-controlled-vocabularies',
]);
const TARGET_PATH_RE = /reference\/ontology-design-reference\/[A-Za-z0-9_./ +()&-]+/gu;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const BINARY_EXTENSIONS = new Set([
  '.doc', '.docx', '.gif', '.jpeg', '.jpg', '.mdzip', '.pdf', '.png', '.xlsx', '.zip',
]);
const XML_EXTENSIONS = new Set(['.rdf', '.xml']);
const TEXT_EXTENSIONS = new Set([
  '', '.bak', '.css', '.csv', '.gitignore', '.htaccess', '.html', '.js', '.md', '.n3',
  '.rq', '.sh', '.sparql', '.sq', '.tbc', '.ttl', '.txt', '.yaml', '.yml',
]);
const SEMANTIC_TERMS = [
  'account', 'authority', 'calendar', 'clearing', 'corporate action', 'currency',
  'execution', 'identifier', 'instrument', 'issuance', 'listing', 'market', 'order',
  'party', 'payment', 'portfolio', 'price', 'reconciliation', 'risk', 'security',
  'settlement', 'strategy', 'trade', 'venue',
];

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeRepoPath(value) {
  return value.replaceAll('\\', '/');
}

function repoPath(absolute) {
  return normalizeRepoPath(path.relative(ROOT, absolute));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function mediaTypeFor(extension, tableDelimiter = null, binary = false) {
  if (binary && !BINARY_EXTENSIONS.has(extension)) return 'application/octet-stream';
  const map = {
    '': 'text/plain',
    '.bak': binary ? 'application/octet-stream' : 'text/plain',
    '.css': 'text/css',
    '.csv': tableDelimiter === '\t' ? 'text/tab-separated-values' : 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.gif': 'image/gif',
    '.gitignore': 'text/plain',
    '.htaccess': 'text/plain',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.md': 'text/markdown',
    '.mdzip': 'application/zip',
    '.n3': 'text/n3',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.rdf': 'application/rdf+xml',
    '.rq': 'application/sparql-query',
    '.sh': 'text/x-shellscript',
    '.sparql': 'application/sparql-query',
    '.sq': 'application/sparql-query',
    '.tbc': binary ? 'application/octet-stream' : 'text/plain',
    '.ttl': 'text/turtle',
    '.txt': 'text/plain',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.zip': 'application/zip',
  };
  return map[extension] || (binary ? 'application/octet-stream' : 'text/plain');
}

function walkRegularFiles(directory) {
  const files = [];
  const issues = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = path.join(current, entry.name);
      const relative = repoPath(absolute);
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        issues.push({
          code: 'REFERENCE_SYMLINK',
          path: relative,
          detail: 'Symlink is excluded because the reference bundle contract permits only real files.',
        });
      } else if (stats.isDirectory()) {
        walk(absolute);
      } else if (stats.isFile()) {
        files.push({
          absolute,
          bytes: stats.size,
          path: relative,
          projectId: path.relative(REFERENCE_ROOT, absolute).split(path.sep)[0],
        });
      } else {
        issues.push({
          code: 'REFERENCE_NON_REGULAR',
          path: relative,
          detail: 'Filesystem entry is neither a regular file nor a directory.',
        });
      }
    }
  }
  walk(directory);
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return { files, issues };
}

function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le-bom', text: new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2)) };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return { encoding: 'utf-16be-bom', text: new TextDecoder('utf-16le', { fatal: true }).decode(swapped) };
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  try {
    return {
      encoding: bytes.length === body.length ? 'utf-8' : 'utf-8-bom',
      text: new TextDecoder('utf-8', { fatal: true }).decode(body),
    };
  } catch {
    return {
      encoding: 'windows-1252-fallback',
      text: new TextDecoder('windows-1252', { fatal: true }).decode(bytes),
    };
  }
}

function isLikelyBinary(bytes) {
  if (bytes.length === 0) return false;
  let controls = 0;
  const limit = Math.min(bytes.length, 8192);
  for (let index = 0; index < limit; index++) {
    const value = bytes[index];
    if (value === 0) return true;
    if (value < 9 || (value > 13 && value < 32)) controls += 1;
  }
  return controls / limit > 0.02;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let interiorQuoteCount = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else if (
          index + 1 === text.length
          || text[index + 1] === delimiter
          || text[index + 1] === '\r'
          || text[index + 1] === '\n'
        ) {
          quoted = false;
        } else {
          // The checked-in BIAN exporter emits unescaped quotes inside quoted
          // descriptions. Treat those marks literally and report their count.
          cell += '"';
          interiorQuoteCount += 1;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      if (cell.length !== 0) throw new Error(`unexpected quote at character ${index}`);
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  const unterminatedQuotedFieldRecovered = quoted;
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { interiorQuoteCount, rows, unterminatedQuotedFieldRecovered };
}

function chooseDelimiter(text) {
  const firstLines = text.split(/\r?\n/u).filter((line) => line.trim() !== '').slice(0, 10);
  const tabs = firstLines.reduce((sum, line) => sum + (line.match(/\t/gu) || []).length, 0);
  const commas = firstLines.reduce((sum, line) => sum + (line.match(/,/gu) || []).length, 0);
  return tabs > commas ? '\t' : ',';
}

function semanticSignals(text) {
  const lower = text.toLowerCase();
  return SEMANTIC_TERMS.filter((term) => lower.includes(term));
}

function compactValues(values, limit = 12) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value).replace(/\s+/gu, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized.slice(0, 160));
    if (result.length >= limit) break;
  }
  return result;
}

function emptyInspection(parser, outcome = 'parsed') {
  return {
    alignmentObjectIris: [],
    alignmentSubjectIris: [],
    archiveEntryCount: null,
    contentSignals: [],
    elementCount: null,
    encoding: null,
    evidenceResourceObjectIris: [],
    evidenceResourceSubjectIris: [],
    notes: [],
    outcome,
    parser,
    recordCount: null,
    statementCount: null,
    uniqueIriCount: null,
  };
}

function collectAlignmentTargetsAndCodeLists() {
  const targets = new Set();
  const evidenceResources = new Set();
  const codeLists = [];
  const moduleRoot = path.join(ROOT, 'ontology', 'domain', 'finance');
  if (!fs.existsSync(moduleRoot)) return { codeLists, targets: [] };
  for (const moduleName of fs.readdirSync(moduleRoot).sort(compareUtf8)) {
    const modulePath = path.join(moduleRoot, moduleName, 'module.yaml');
    if (!fs.existsSync(modulePath)) continue;
    const document = YAML.parse(fs.readFileSync(modulePath, 'utf8'));
    function visit(value) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === 'object') {
        if (typeof value.targetIri === 'string' && /^https?:\/\//u.test(value.targetIri)) targets.add(value.targetIri);
        for (const child of Object.values(value)) visit(child);
      }
    }
    visit(document);
    const definitions = document.domain?.codeLists && typeof document.domain.codeLists === 'object'
      ? document.domain.codeLists
      : (document.domain || {});
    for (const [name, definition] of Object.entries(definitions)) {
      if (!definition || typeof definition !== 'object' || !Array.isArray(definition.values)) continue;
      codeLists.push({
        alignmentTargetIris: compactValues((definition.alignments || []).map((alignment) => alignment.targetIri), 100)
          .filter((iri) => /^https?:\/\//u.test(iri)),
        declaredNote: typeof definition.note === 'string' ? definition.note : null,
        declaredSourceEvidenceRef: typeof definition.sourceEvidenceRef === 'string'
          ? definition.sourceEvidenceRef
          : null,
        localIri: definition.iri,
        moduleId: moduleName,
        name,
        values: definition.values.map((value) => (
          typeof value === 'string'
            ? { definition: null, iri: null, label: value, notation: value }
            : {
              definition: typeof value.definition === 'string' ? value.definition : null,
              iri: typeof value.iri === 'string' ? value.iri : null,
              label: typeof value.label === 'string' ? value.label : null,
              notation: typeof (value.notation || value.code || value.value) === 'string'
                ? (value.notation || value.code || value.value)
                : null,
            }
        )),
      });
    }
  }
  const alignmentRoot = path.join(ROOT, 'docs', 'ontology', 'alignments');
  if (fs.existsSync(alignmentRoot)) {
    for (const name of fs.readdirSync(alignmentRoot).filter((value) => /\.ya?ml$/u.test(value)).sort(compareUtf8)) {
      const document = YAML.parse(fs.readFileSync(path.join(alignmentRoot, name), 'utf8'));
      function visit(value) {
        if (Array.isArray(value)) for (const item of value) visit(item);
        else if (value && typeof value === 'object') {
          if (typeof value.targetIri === 'string' && /^https?:\/\//u.test(value.targetIri)) targets.add(value.targetIri);
          for (const child of Object.values(value)) visit(child);
        }
      }
      visit(document);
    }
  }
  if (fs.existsSync(RFC_PATH)) {
    const rfc = fs.readFileSync(RFC_PATH, 'utf8');
    for (const match of rfc.matchAll(/RDF resource\s+locator\s+`(https?:\/\/[^`]+)`/gu)) {
      evidenceResources.add(match[1]);
    }
  }
  codeLists.sort((left, right) => compareUtf8(left.localIri, right.localIri));
  return {
    codeLists,
    evidenceResources: [...evidenceResources].sort(compareUtf8),
    targets: [...targets].sort(compareUtf8),
  };
}

function collectCitationSources(lock) {
  const citations = new Map();
  function add(citedPath, source) {
    const normalized = normalizeRepoPath(citedPath).replace(/\/+$/u, '');
    const list = citations.get(normalized) || [];
    if (!list.includes(source)) list.push(source);
    citations.set(normalized, list.sort(compareUtf8));
  }
  for (const reference of lock.references || []) {
    for (const evidencePath of reference.evidenceFiles || []) {
      add(evidencePath, `${repoPath(LOCK_PATH)}#${reference.id}`);
    }
  }
  const sources = [];
  if (fs.existsSync(RFC_PATH)) sources.push(RFC_PATH);
  const ontologyDocs = path.join(ROOT, 'docs', 'ontology');
  function collectTextFiles(directory) {
    if (!fs.existsSync(directory)) return;
    if (path.resolve(directory).startsWith(path.resolve(OUTPUT_ROOT))) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareUtf8(a.name, b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collectTextFiles(absolute);
      else if (entry.isFile() && /\.(?:json|md|ya?ml)$/u.test(entry.name)) sources.push(absolute);
    }
  }
  collectTextFiles(ontologyDocs);
  for (const source of sources) {
    if (path.resolve(source) === path.resolve(LOCK_PATH)) continue;
    let text;
    try {
      text = fs.readFileSync(source, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(TARGET_PATH_RE)) add(match[0].replace(/[.`);,:]+$/u, ''), repoPath(source));
  }
  return citations;
}

function runBinaryInspector(targets) {
  const temporary = path.join(os.tmpdir(), `axiolune-alignment-targets-${process.pid}.json`);
  fs.writeFileSync(temporary, JSON.stringify(targets), 'utf8');
  try {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', XML_HELPER,
        '-Root', REFERENCE_ROOT,
        '-RepositoryRoot', ROOT,
        '-TargetsPath', temporary,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'PowerShell inspector failed').trim());
    }
    const records = new Map();
    for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      const record = JSON.parse(line);
      records.set(record.path, record);
    }
    return records;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function inspectN3(text, file, targets, evidenceTargets) {
  const parser = new N3Parser({ baseIRI: `file:///${file.path}` });
  const quads = parser.parse(text);
  const subjects = new Set();
  const iriTerms = new Set();
  const defined = new Set();
  const referenced = new Set();
  const evidenceDefined = new Set();
  const evidenceReferenced = new Set();
  for (const quad of quads) {
    subjects.add(quad.subject.value);
    for (const term of [quad.subject, quad.predicate, quad.object, quad.graph]) {
      if (term.termType === 'NamedNode') iriTerms.add(term.value);
    }
    if (targets.has(quad.subject.value)) defined.add(quad.subject.value);
    if (targets.has(quad.object.value)) referenced.add(quad.object.value);
    if (evidenceTargets.has(quad.subject.value)) evidenceDefined.add(quad.subject.value);
    if (evidenceTargets.has(quad.object.value)) evidenceReferenced.add(quad.object.value);
  }
  const inspection = emptyInspection('n3.Parser');
  inspection.alignmentSubjectIris = [...defined].sort(compareUtf8);
  inspection.alignmentObjectIris = [...referenced].sort(compareUtf8);
  inspection.evidenceResourceSubjectIris = [...evidenceDefined].sort(compareUtf8);
  inspection.evidenceResourceObjectIris = [...evidenceReferenced].sort(compareUtf8);
  inspection.recordCount = subjects.size;
  inspection.statementCount = quads.length;
  inspection.uniqueIriCount = iriTerms.size;
  inspection.contentSignals = semanticSignals(text);
  return inspection;
}

function inspectTable(text) {
  const delimiter = chooseDelimiter(text);
  const parsed = parseDelimited(text, delimiter);
  const rows = parsed.rows;
  const flat = rows.flat();
  const nonempty = flat.filter((value) => value.trim() !== '');
  const widths = rows.map((row) => row.length);
  const inspection = emptyInspection(delimiter === '\t' ? 'full TSV state-machine parse' : 'full CSV state-machine parse');
  inspection.contentSignals = semanticSignals(text);
  inspection.notes = [
    `delimiter=${delimiter === '\t' ? 'TAB' : 'COMMA'}`,
    `columnWidthRange=${widths.length ? Math.min(...widths) : 0}..${widths.length ? Math.max(...widths) : 0}`,
    `nonEmptyCells=${nonempty.length}`,
    `unescapedInteriorQuotesTreatedLiterally=${parsed.interiorQuoteCount}`,
    `unterminatedQuotedFieldRecovered=${parsed.unterminatedQuotedFieldRecovered}`,
    `leadingValues=${canonicalJcs(compactValues(nonempty))}`,
  ];
  inspection.recordCount = rows.length;
  return { delimiter, inspection };
}

function inspectText(text, extension) {
  const lines = text.split(/\r\n|\n|\r/u);
  const inspection = emptyInspection('full decoded-text scan');
  inspection.contentSignals = semanticSignals(text);
  inspection.recordCount = lines.length;
  if (extension === '.yaml' || extension === '.yml') {
    YAML.parse(text);
    inspection.parser = 'yaml.parse plus full decoded-text scan';
  } else if (extension === '.html') {
    const openTags = (text.match(/<[A-Za-z][^>]*>/gu) || []).length;
    const titles = compactValues([...text.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/giu)].map((match) => match[1]));
    inspection.parser = 'full HTML source scan (no DOM repair)';
    inspection.elementCount = openTags;
    inspection.notes.push(`titles=${canonicalJcs(titles)}`);
  } else if (extension === '.md') {
    const headings = compactValues([...text.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => match[1]));
    inspection.parser = 'full Markdown source scan';
    inspection.notes.push(`headings=${canonicalJcs(headings)}`);
  } else if (['.rq', '.sparql', '.sq'].includes(extension)) {
    inspection.parser = 'full SPARQL source scan (syntax not executed)';
    inspection.notes.push(`queryForms=${canonicalJcs(compactValues([...text.matchAll(/\b(?:ASK|CONSTRUCT|DESCRIBE|SELECT|UPDATE)\b/giu)].map((match) => match[0].toUpperCase())))}`);
  }
  return inspection;
}

function projectBundleDigest(projectRoot, files) {
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relative = normalizeRepoPath(path.relative(projectRoot, file.absolute));
    const pathBytes = Buffer.from(relative, 'utf8');
    const bytes = fs.readFileSync(file.absolute);
    hash.update(u64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function dispositionFor(file, inspection, activeEvidence, decision = null) {
  if (activeEvidence.some((evidence) => evidence.usage === 'normative')) return 'usedNormative';
  if (activeEvidence.length > 0) return 'usedImplementation';
  if (decision) return decision.disposition;
  if (inspection.outcome === 'metadata-inspected') return 'binaryInspected';
  return null;
}

function rationaleFor(file, inspection, disposition, citationSources, activeEvidence, decision = null) {
  const citations = citationSources.length ? ` Citation inventory: ${citationSources.join(', ')}.` : '';
  const active = activeEvidence.length
    ? ` Exact active consumer(s): ${activeEvidence.map((evidence) => (
      `${evidence.sourceRef} [${evidence.referenceId}/${evidence.locatorKind}/${evidence.usage}]`
    )).join(', ')}.`
    : '';
  if (disposition === 'binaryInspected') {
    const archive = inspection.archiveEntryCount === null
      ? ''
      : ` Container manifest has ${inspection.archiveEntryCount} entries.`;
    return `Only binary metadata and magic bytes were inspected; semantic content was not reviewed.${archive}`;
  }
  if (disposition === 'usedImplementation') {
    return `The complete file is selected by an exact implementation-evidence locator.${active}${citations}`;
  }
  if (disposition === 'usedNormative') {
    return `The complete file contains an exact locator selected by a current machine-readable normative consumer.${active}${citations}`;
  }
  if (decision && ['reviewedNoBearing', 'reviewedRejected'].includes(disposition)) {
    return `${decision.rationale}${citations}`;
  }
  if (inspection.outcome === 'failed') {
    return `Inspection failed; no reviewed disposition is claimed. ${inspection.notes.join(' ')}`.trim();
  }
  return 'Semantic disposition is pending: every non-active file requires an explicit digest-bound reviewedNoBearing or reviewedRejected decision.';
}

function reviewMethodFor(inspection, decision = null) {
  if (decision) return decision.reviewMethod;
  if (inspection.outcome === 'metadata-inspected') {
    return inspection.archiveEntryCount === null
      ? 'binary magic and size metadata inspection'
      : 'binary magic plus archive central-directory metadata inspection';
  }
  if (inspection.outcome === 'failed') return `failed ${inspection.parser}`;
  if (inspection.parser.includes('XmlReader')) return 'full RDF/XML or XML structural parse plus exact alignment-IRI scan';
  if (inspection.parser === 'n3.Parser') return 'full RDF graph parse plus exact alignment-IRI scan';
  if (inspection.parser.includes('TSV') || inspection.parser.includes('CSV')) {
    return 'full tabular row/cell parse plus semantic term scan';
  }
  return `${inspection.parser} plus semantic term scan`;
}

function normalizeHelperInspection(helper, targetSet, evidenceTargetSet) {
  const inspection = emptyInspection(helper.parser, helper.outcome);
  inspection.alignmentSubjectIris = (helper.alignmentDefinitions || []).filter((iri) => targetSet.has(iri));
  inspection.alignmentObjectIris = (helper.alignmentReferences || []).filter((iri) => targetSet.has(iri));
  inspection.evidenceResourceSubjectIris = (helper.alignmentDefinitions || []).filter((iri) => evidenceTargetSet.has(iri));
  inspection.evidenceResourceObjectIris = (helper.alignmentReferences || []).filter((iri) => evidenceTargetSet.has(iri));
  inspection.archiveEntryCount = helper.archiveEntryCount;
  inspection.elementCount = helper.elementCount;
  inspection.uniqueIriCount = helper.uniqueIriCount;
  inspection.notes = [
    `magicHex=${helper.magicHex}`,
    ...(helper.archiveUncompressedBytes === null ? [] : [`archiveUncompressedBytes=${helper.archiveUncompressedBytes}`]),
    ...(helper.ontologyCount === null ? [] : [`owlOntologyElements=${helper.ontologyCount}`]),
    ...(helper.classCount === null ? [] : [`owlClassElements=${helper.classCount}`]),
    ...(helper.propertyCount === null ? [] : [`owlPropertyElements=${helper.propertyCount}`]),
    ...(helper.sampleEntries || []).map((entry) => `archiveEntry=${entry}`),
    ...(helper.error ? [`error=${helper.error}`] : []),
  ];
  return inspection;
}

function inspectFile(file, bytes, helperByPath, targetSet, evidenceTargetSet) {
  const extension = path.extname(file.absolute).toLowerCase();
  const helper = helperByPath.get(file.path);
  if (helper) return normalizeHelperInspection(helper, targetSet, evidenceTargetSet);
  if (BINARY_EXTENSIONS.has(extension) || (!TEXT_EXTENSIONS.has(extension) && isLikelyBinary(bytes))) {
    const inspection = emptyInspection('fixed-header-magic-inspection', 'metadata-inspected');
    inspection.notes = [`magicHex=${bytes.subarray(0, 32).toString('hex')}`];
    return inspection;
  }
  if (isLikelyBinary(bytes)) {
    const inspection = emptyInspection('fixed-header-magic-inspection', 'metadata-inspected');
    inspection.notes = [`magicHex=${bytes.subarray(0, 32).toString('hex')}`];
    return inspection;
  }
  try {
    const decoded = decodeText(bytes);
    let inspection;
    if (extension === '.ttl' || extension === '.n3') {
      inspection = inspectN3(decoded.text, file, targetSet, evidenceTargetSet);
    } else if (extension === '.csv') {
      const table = inspectTable(decoded.text);
      inspection = table.inspection;
      inspection.notes.push(`detectedMediaType=${mediaTypeFor(extension, table.delimiter)}`);
    } else {
      inspection = inspectText(decoded.text, extension);
    }
    inspection.encoding = decoded.encoding;
    return inspection;
  } catch (error) {
    const inspection = emptyInspection(
      extension === '.ttl' || extension === '.n3'
        ? 'n3.Parser'
        : (extension === '.csv' ? 'full delimited-table state-machine parse' : 'full decoded-text scan'),
      'failed',
    );
    inspection.notes = [`error=${error.message}`];
    return inspection;
  }
}

function inspectLock(lock, inventory) {
  const observations = [];
  const paywalledReferences = [];
  const filesByAbsolute = new Map(inventory.map((file) => [path.resolve(file.absolute), file]));
  for (const reference of lock.references || []) {
    if (reference.artifactDigest === 'sha256:unavailable-paywalled') {
      paywalledReferences.push({
        artifactUrl: reference.artifactUrl,
        id: reference.id,
        reason: 'No licensed local bytes are present; no file review or source locator can be claimed.',
        releaseOrCommit: reference.releaseOrCommit,
      });
      continue;
    }
    if (!reference.localPath || !reference.localPath.startsWith('reference/ontology-design-reference/')) continue;
    const localAbsolute = path.resolve(ROOT, reference.localPath);
    const localFiles = inventory.filter((file) => {
      const relative = path.relative(localAbsolute, file.absolute);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
    const actualBundleDigest = localFiles.length > 0 && fs.statSync(localAbsolute).isDirectory()
      ? projectBundleDigest(localAbsolute, localFiles)
      : (localFiles.length === 1 ? localFiles[0].artifactDigest : null);
    let declaredScopeDigest = null;
    if (reference.artifactDigestScope && /all 295 \*\.rdf files/iu.test(reference.artifactDigestScope)) {
      const rdfFiles = localFiles.filter((file) => path.extname(file.absolute).toLowerCase() === '.rdf');
      declaredScopeDigest = projectBundleDigest(localAbsolute, rdfFiles);
    }
    observations.push({
      actualContractBundleDigest: actualBundleDigest,
      declaredArtifactDigest: reference.artifactDigest,
      declaredDigestMatchesContractBundle: actualBundleDigest === reference.artifactDigest,
      declaredScopeDigest,
      declaredScopeDigestMatches: declaredScopeDigest === null ? null : declaredScopeDigest === reference.artifactDigest,
      evidenceFiles: [...(reference.evidenceFiles || [])].sort(compareUtf8),
      id: reference.id,
      localPath: normalizeRepoPath(reference.localPath).replace(/\/+$/u, ''),
      strictLocatorCount: Array.isArray(reference.locators) ? reference.locators.length : 0,
    });
  }
  observations.sort((left, right) => compareUtf8(left.id, right.id));
  paywalledReferences.sort((left, right) => compareUtf8(left.id, right.id));
  return { observations, paywalledReferences };
}

function buildCodeListRecord(codeLists, recordsByPath, alignmentSubjects) {
  const targetToEvidence = new Map();
  for (const [filePath, row] of recordsByPath) {
    for (const iri of row.inspection.alignmentSubjectIris) {
      const evidence = targetToEvidence.get(iri) || [];
      evidence.push({
        artifactDigest: row.artifactDigest,
        mediaType: row.mediaType,
        path: filePath,
        resourceIri: iri,
      });
      targetToEvidence.set(iri, evidence);
    }
  }
  const assessments = codeLists.map((codeList) => {
    const exactEvidence = [];
    for (const iri of codeList.alignmentTargetIris) {
      for (const evidence of targetToEvidence.get(iri) || []) exactEvidence.push(evidence);
    }
    exactEvidence.sort((left, right) => (
      compareUtf8(left.resourceIri, right.resourceIri) || compareUtf8(left.path, right.path)
    ));
    const requiredNamedFoundationReview = codeList.moduleId === 'foundation'
      && new Set([
        'AccountType',
        'FinancialAccountPartyRoleKind',
        'IdentifierAuthorityRole',
        'IdentifierSchemeKind',
        'IdentifierUniquenessScope',
      ]).has(codeList.name);
    const exact = exactEvidence.length > 0;
    return {
      alignmentTargetIris: codeList.alignmentTargetIris,
      declaredNote: codeList.declaredNote,
      declaredSourceEvidenceRef: codeList.declaredSourceEvidenceRef,
      exactEvidence,
      localIri: codeList.localIri,
      moduleId: codeList.moduleId,
      name: codeList.name,
      outcome: exact ? 'exact-target-found-source-locator-pending' : 'pending-no-exact-locked-evidence',
      rationale: exact
        ? 'An explicit code-list alignment target is defined in parsed locked bytes, but a strict SourceLocator cannot be emitted until an extractor profile and locator are added to the lock.'
        : `${requiredNamedFoundationReview ? 'Required Foundation identifier/account review completed. ' : ''}${codeList.declaredSourceEvidenceRef?.includes('/pending-source-evidence/') ? 'The module itself declares pending source evidence. ' : ''}No explicit code-list alignment target and no exact equivalent member set was found in the locked ontology-design bytes; lexical resemblance is not treated as authority.`,
      sourceLocator: null,
      sourceLocatorStatus: exact
        ? 'pending-extractor-profile-lock-entry-and-selection-digest'
        : 'not-applicable-until-exact-evidence-exists',
      values: codeList.values,
    };
  });
  const missingNamed = [
    'AccountType',
    'FinancialAccountPartyRoleKind',
    'IdentifierAuthorityRole',
    'IdentifierSchemeKind',
    'IdentifierUniquenessScope',
  ].filter((name) => !assessments.some((item) => item.moduleId === 'foundation' && item.name === name));
  return {
    assessments,
    reviewDate: REVIEW_DATE,
    reviewId: 'axiolune-ontology-design-code-list-identifier-alignment-review-2026-07-31',
    reviewerRef: REVIEWER_REF,
    schemaVersion: REVIEW_SCHEMA,
    scope: {
      assessmentCount: assessments.length,
      exactTargetSubjectCount: alignmentSubjects.size,
      missingRequiredFoundationCodeLists: missingNamed,
      rule: 'A strict SourceLocator is emitted only for exact semantic evidence and only when its locked extractor profile and selection digest exist. Broad FIBO attribution and lexical-only matching are forbidden.',
      scopeRoot: 'reference/ontology-design-reference',
    },
    summary: {
      exactTargetFoundButLocatorPending: assessments.filter((item) => item.outcome === 'exact-target-found-source-locator-pending').length,
      pendingNoExactLockedEvidence: assessments.filter((item) => item.outcome === 'pending-no-exact-locked-evidence').length,
    },
  };
}

function constructArtifacts() {
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const semanticDecisions = loadSemanticReviewDecisions({
    manifestPath: SEMANTIC_REVIEW_DECISIONS_PATH,
    rootDir: ROOT,
  });
  const usedSemanticDecisionPaths = new Set();
  const { codeLists, evidenceResources, targets } = collectAlignmentTargetsAndCodeLists();
  const targetSet = new Set(targets);
  const evidenceTargetSet = new Set(evidenceResources);
  const citations = collectCitationSources(lock);
  const inventoryResult = walkRegularFiles(REFERENCE_ROOT);
  const activeEvidence = collectActiveReferenceEvidence(ROOT, lock);
  const helperByPath = runBinaryInspector([...new Set([...targets, ...evidenceResources])].sort(compareUtf8));
  const projectFiles = new Map();
  const allRows = new Map();
  const unclosed = [...inventoryResult.issues];
  const integrityFindings = [];
  const alignmentSubjects = new Map(targets.map((target) => [target, []]));
  const alignmentObjects = new Map(targets.map((target) => [target, []]));

  for (const file of inventoryResult.files) {
    if (AUTHORITY_MANAGED_PROJECTS.has(file.projectId)) continue;
    const bytes = fs.readFileSync(file.absolute);
    file.artifactDigest = sha256(bytes);
    const inspection = inspectFile(file, bytes, helperByPath, targetSet, evidenceTargetSet);
    const extension = path.extname(file.absolute).toLowerCase();
    const delimiterNote = inspection.notes.find((note) => note.startsWith('delimiter='));
    const delimiter = delimiterNote?.endsWith('TAB') ? '\t' : ',';
    const mediaType = mediaTypeFor(extension, delimiter, inspection.outcome === 'metadata-inspected');
    const citationSources = citations.get(file.path) || [];
    const activeFileEvidence = activeEvidence.byPath.get(file.path) || [];
    const decision = resolveSemanticReviewDecision(
      semanticDecisions,
      file.path,
      file.artifactDigest,
    );
    if (decision) usedSemanticDecisionPaths.add(file.path);
    if (decision && activeFileEvidence.length > 0) {
      unclosed.push({
        code: 'SEMANTIC_REVIEW_DECISION_CONFLICTS_WITH_ACTIVE_USE',
        path: file.path,
        detail: 'A reviewedNoBearing/reviewedRejected decision cannot coexist with an active normative or implementation consumer.',
      });
    }
    const effectiveDecision = activeFileEvidence.length > 0 ? null : decision;
    const disposition = dispositionFor(file, inspection, activeFileEvidence, effectiveDecision);
    const row = {
      artifactDigest: file.artifactDigest,
      bytes: file.bytes,
      citationSources,
      disposition,
      inspection,
      mediaType,
      path: file.path,
      rationale: rationaleFor(
        file,
        inspection,
        disposition,
        citationSources,
        activeFileEvidence,
        effectiveDecision,
      ),
      reviewMethod: reviewMethodFor(inspection, effectiveDecision),
      reviewerRef: effectiveDecision?.reviewerRef || REVIEWER_REF,
    };
    const list = projectFiles.get(file.projectId) || [];
    list.push(row);
    projectFiles.set(file.projectId, list);
    allRows.set(file.path, row);
    if (inspection.outcome === 'failed') {
      unclosed.push({
        code: 'FILE_INSPECTION_FAILED',
        path: file.path,
        detail: inspection.notes.join('; '),
      });
    }
    if (activeFileEvidence.length === 0 && !effectiveDecision) {
      unclosed.push({
        code: 'SEMANTIC_REVIEW_DECISION_MISSING',
        path: file.path,
        detail: inspection.contentSignals.length > 0
          ? `Digest-bound manual disposition is required; parsed signal(s): ${inspection.contentSignals.join(', ')}.`
          : 'Digest-bound manual disposition is required for every non-active regular file; absence of a keyword signal is not a no-bearing decision.',
      });
    }
    const interiorQuoteNote = inspection.notes.find((note) => note.startsWith('unescapedInteriorQuotesTreatedLiterally='));
    const interiorQuoteCount = interiorQuoteNote ? Number(interiorQuoteNote.split('=')[1]) : 0;
    if (interiorQuoteCount > 0) {
      integrityFindings.push({
        code: 'MALFORMED_TABLE_INTERIOR_QUOTES_RECOVERED',
        detail: `${interiorQuoteCount} unescaped interior quote(s) were treated literally by the documented tolerant parser.`,
        path: file.path,
      });
    }
    if (inspection.notes.includes('unterminatedQuotedFieldRecovered=true')) {
      integrityFindings.push({
        code: 'MALFORMED_TABLE_UNTERMINATED_QUOTE_RECOVERED',
        detail: 'The final quoted field was unterminated; EOF recovery retained all decoded bytes for semantic review.',
        path: file.path,
      });
    }
    for (const target of inspection.alignmentSubjectIris) {
      const paths = alignmentSubjects.get(target) || [];
      paths.push(file.path);
      alignmentSubjects.set(target, paths);
    }
    for (const target of inspection.alignmentObjectIris) {
      const paths = alignmentObjects.get(target) || [];
      paths.push(file.path);
      alignmentObjects.set(target, paths);
    }
  }
  for (const decisionPath of findUnusedDecisions(
    semanticDecisions,
    usedSemanticDecisionPaths,
    'reference/ontology-design-reference',
  )) {
    unclosed.push({
      code: 'ORPHAN_SEMANTIC_REVIEW_DECISION',
      path: decisionPath,
      detail: 'Decision does not join to a current regular file in the ontology-design reference inventory.',
    });
  }

  const projectRecords = new Map();
  const coverageProjects = [];
  for (const projectId of [...projectFiles.keys()].sort(compareUtf8)) {
    const rows = projectFiles.get(projectId).sort((left, right) => compareUtf8(left.path, right.path));
    const rootPath = `reference/ontology-design-reference/${projectId}`;
    const projectRoot = path.resolve(ROOT, rootPath);
    const sourceFiles = inventoryResult.files
      .filter((file) => file.projectId === projectId)
      .sort((left, right) => compareUtf8(left.path, right.path));
    const projectDigest = projectBundleDigest(projectRoot, sourceFiles);
    const record = {
      files: rows,
      projectDigest,
      projectId,
      reviewDate: REVIEW_DATE,
      reviewId: `axiolune-ontology-design-${projectId}-file-review-2026-07-31`,
      reviewerRef: REVIEWER_REF,
      rootPath,
      schemaVersion: REVIEW_SCHEMA,
      summary: {
        binaryInspected: rows.filter((row) => row.disposition === 'binaryInspected').length,
        failedInspection: rows.filter((row) => row.disposition === null).length,
        pendingSemanticReview: rows.filter((row) => (
          row.disposition === null && row.inspection.outcome === 'parsed'
        )).length,
        reviewedNoBearing: rows.filter((row) => row.disposition === 'reviewedNoBearing').length,
        reviewedRejected: rows.filter((row) => row.disposition === 'reviewedRejected').length,
        totalFiles: rows.length,
        usedImplementation: rows.filter((row) => row.disposition === 'usedImplementation').length,
        usedNormative: rows.filter((row) => row.disposition === 'usedNormative').length,
      },
    };
    const outputName = `${projectId}.review.json`;
    const bytes = Buffer.from(canonicalJcs(record), 'utf8');
    projectRecords.set(outputName, { bytes, record });
    const lockEntry = (lock.references || []).find((reference) => (
      typeof reference.localPath === 'string'
      && normalizeRepoPath(reference.localPath).replace(/\/+$/u, '') === rootPath
    ));
    if (!lockEntry) {
      unclosed.push({
        code: 'REFERENCE_PROJECT_LOCK_MISSING',
        path: rootPath,
        detail: 'The reviewed local project has no exact references.lock.yaml entry with authority, license, release/commit, localPath, and bundle digest; it cannot supply approved normative or implementation evidence.',
      });
    }
    coverageProjects.push({
      ...(lockEntry?.releaseOrCommit ? { releaseOrCommit: lockEntry.releaseOrCommit } : {}),
      files: rows.filter((row) => row.disposition !== null).map((row) => ({
        artifactDigest: row.artifactDigest,
        disposition: row.disposition,
        mediaType: row.mediaType,
        path: row.path,
        rationale: row.rationale,
        reviewMethod: row.reviewMethod,
        reviewRecordDigest: sha256(bytes),
        reviewRecordRef: {
          kind: 'path',
          path: `docs/ontology/references/reviews/ontology-design/${outputName}`,
          root: 'sourceTree',
        },
        reviewerRef: row.reviewerRef,
      })),
      projectDigest,
      projectId,
      rootPath,
    });
  }
  coverageProjects.sort((left, right) => compareUtf8(left.projectId, right.projectId));

  const lockInspection = inspectLock(lock, inventoryResult.files);
  const alignmentTargetEvidence = targets.map((targetIri) => {
    const subjectPaths = [...new Set(alignmentSubjects.get(targetIri) || [])].sort(compareUtf8);
    const objectPaths = [...new Set(alignmentObjects.get(targetIri) || [])].sort(compareUtf8);
    return {
      objectPaths,
      status: subjectPaths.length > 0
        ? 'subject-present'
        : (objectPaths.length > 0 ? 'reference-only' : 'absent'),
      subjectPaths,
      targetIri,
    };
  });
  const missingAlignmentTargets = alignmentTargetEvidence
    .filter((entry) => entry.status === 'absent')
    .map((entry) => entry.targetIri);
  const unclosedAlignmentTargets = alignmentTargetEvidence
    .filter((entry) => entry.status !== 'subject-present')
    .map((entry) => ({
      status: entry.status,
      targetIri: entry.targetIri,
    }));
  const citedRdfResourceEvidence = evidenceResources.map((resourceIri) => {
    const subjectPaths = [];
    const objectPaths = [];
    for (const [filePath, row] of allRows) {
      if (row.inspection.evidenceResourceSubjectIris.includes(resourceIri)) subjectPaths.push(filePath);
      if (row.inspection.evidenceResourceObjectIris.includes(resourceIri)) objectPaths.push(filePath);
    }
    return {
      objectPaths: objectPaths.sort(compareUtf8),
      resourceIri,
      status: subjectPaths.length > 0
        ? 'subject-present'
        : (objectPaths.length > 0 ? 'reference-only' : 'absent'),
      subjectPaths: subjectPaths.sort(compareUtf8),
    };
  });
  const fragment = {
    alignmentTargetEvidence,
    citedRdfResourceEvidence,
    coverageSchemaVersion: '1.0',
    fragmentKind: 'ontology-design-reference-project-fragment',
    integrityFindings: integrityFindings.sort((left, right) => (
      compareUtf8(left.code, right.code) || compareUtf8(left.path, right.path)
    )),
    lockObservations: lockInspection.observations,
    missingAlignmentTargets,
    paywalledReferences: lockInspection.paywalledReferences,
    projects: coverageProjects,
    reviewDate: REVIEW_DATE,
    reviewerRef: REVIEWER_REF,
    schemaVersion: FRAGMENT_SCHEMA,
    scopeDigest: projectBundleDigest(
      REFERENCE_ROOT,
      inventoryResult.files.filter((file) => !AUTHORITY_MANAGED_PROJECTS.has(file.projectId)),
    ),
    scopeRoot: 'reference/ontology-design-reference',
    unclosedFiles: unclosed.sort((left, right) => (
      compareUtf8(left.code, right.code) || compareUtf8(left.path, right.path)
    )),
    unclosedAlignmentTargets,
  };
  const codeListRecord = buildCodeListRecord(codeLists, allRows, new Set(
    [...alignmentSubjects.entries()].filter(([, paths]) => paths.length > 0).map(([iri]) => iri),
  ));
  const semanticDecisionBlockers = unclosed.filter((finding) => (
    finding.code === 'SEMANTIC_REVIEW_DECISION_MISSING'
    || finding.code === 'SEMANTIC_REVIEW_DECISION_CONFLICTS_WITH_ACTIVE_USE'
    || finding.code === 'ORPHAN_SEMANTIC_REVIEW_DECISION'
  )).sort((left, right) => (
    compareUtf8(left.code, right.code) || compareUtf8(left.path, right.path)
  ));
  const referenceProvenanceBlockers = unclosed.filter((finding) => (
    finding.code === 'REFERENCE_PROJECT_LOCK_MISSING'
  )).sort((left, right) => (
    compareUtf8(left.code, right.code) || compareUtf8(left.path, right.path)
  ));
  return {
    artifacts: new Map([
      ...projectRecords,
      ['code-list-identifier-alignment.review.json', {
        bytes: Buffer.from(canonicalJcs(codeListRecord), 'utf8'),
        record: codeListRecord,
      }],
      ['reference-review-coverage.fragment.json', {
        bytes: Buffer.from(canonicalJcs(fragment), 'utf8'),
        record: fragment,
      }],
    ]),
    stats: {
      alignmentTargetCount: targets.length,
      codeListCount: codeLists.length,
      fileCount: inventoryResult.files.length,
      missingAlignmentTargetCount: missingAlignmentTargets.length,
      unclosedAlignmentTargetCount: unclosedAlignmentTargets.length,
      paywalledReferenceCount: lockInspection.paywalledReferences.length,
      referenceProvenanceBlockerCount: referenceProvenanceBlockers.length,
      semanticDecisionBlockerCount: semanticDecisionBlockers.length,
      unclosedFileCount: unclosed.length,
    },
    referenceProvenanceBlockers,
    semanticDecisionBlockers,
  };
}

function writeArtifacts(artifacts) {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  for (const [name, artifact] of artifacts) {
    fs.writeFileSync(path.join(OUTPUT_ROOT, name), artifact.bytes);
  }
}

function findAuthorityManagedReviewArtifacts(outputRoot = OUTPUT_ROOT) {
  return [...AUTHORITY_MANAGED_PROJECTS]
    .sort(compareUtf8)
    .map((projectId) => `${projectId}.review.json`)
    .filter((name) => fs.existsSync(path.join(outputRoot, name)));
}

function checkArtifacts(artifacts, outputRoot = OUTPUT_ROOT) {
  const errors = [];
  for (const name of findAuthorityManagedReviewArtifacts(outputRoot)) {
    errors.push(`${name}: authority-managed project review must not remain in the ontology-design active review directory`);
  }
  for (const [name, artifact] of artifacts) {
    const outputPath = path.join(outputRoot, name);
    if (!fs.existsSync(outputPath)) {
      errors.push(`${name}: missing`);
      continue;
    }
    const actual = fs.readFileSync(outputPath);
    if (!actual.equals(artifact.bytes)) errors.push(`${name}: bytes differ from deterministic regenerated JCS`);
    let parsed;
    try {
      parsed = JSON.parse(actual.toString('utf8'));
    } catch (error) {
      errors.push(`${name}: invalid JSON: ${error.message}`);
      continue;
    }
    if (actual.toString('utf8') !== canonicalJcs(parsed)) errors.push(`${name}: bytes are not exact canonical JCS`);
  }
  const fragment = artifacts.get('reference-review-coverage.fragment.json')?.record;
  const coverageRows = fragment?.projects.flatMap((project) => project.files) || [];
  const coveragePaths = coverageRows.map((row) => row.path);
  if (new Set(coveragePaths).size !== coveragePaths.length) {
    errors.push('reference-review-coverage.fragment.json: duplicate coverage path');
  }
  const allowedDispositions = new Set([
    'binaryInspected',
    'reviewedNoBearing',
    'reviewedRejected',
    'usedImplementation',
    'usedNormative',
  ]);
  for (const project of fragment?.projects || []) {
    const recordName = `${project.projectId}.review.json`;
    const reviewArtifact = artifacts.get(recordName);
    const expectedDigest = reviewArtifact ? sha256(reviewArtifact.bytes) : null;
    const reviewedPaths = reviewArtifact?.record.files.map((row) => row.path) || [];
    if (canonicalJcs(project.files.map((row) => row.path)) !== canonicalJcs(reviewedPaths)) {
      errors.push(`${project.projectId}: coverage and review-record file unions differ`);
    }
    for (const row of project.files) {
      if (!DIGEST_RE.test(row.artifactDigest)) errors.push(`${row.path}: invalid artifact digest`);
      if (!allowedDispositions.has(row.disposition)) errors.push(`${row.path}: invalid coverage disposition`);
      if (row.reviewRecordDigest !== expectedDigest) errors.push(`${row.path}: review record digest mismatch`);
      if (typeof row.reviewMethod !== 'string' || row.reviewMethod.trim() === '') {
        errors.push(`${row.path}: empty review method`);
      }
      if (!['usedImplementation', 'usedNormative'].includes(row.disposition)
        && (typeof row.rationale !== 'string' || row.rationale.trim() === '')) {
        errors.push(`${row.path}: non-used disposition has no rationale`);
      }
    }
  }
  const codeListRecord = artifacts.get('code-list-identifier-alignment.review.json')?.record;
  if ((codeListRecord?.scope.missingRequiredFoundationCodeLists || []).length > 0) {
    errors.push('code-list review: required Foundation code lists are missing');
  }
  return errors;
}

function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (!write && !check) {
    process.stderr.write('Usage: node scripts/domain/review-ontology-design-references.cjs --write|--check\n');
    process.exitCode = 2;
    return;
  }
  const result = constructArtifacts();
  if (result.semanticDecisionBlockers.length > 0) {
    for (const finding of result.semanticDecisionBlockers.slice(0, 200)) {
      process.stderr.write(`ERROR ${finding.code} ${finding.path}: ${finding.detail}\n`);
    }
    if (result.semanticDecisionBlockers.length > 200) {
      process.stderr.write(
        `ERROR SEMANTIC_REVIEW_BLOCKER_SUMMARY `
        + `${result.semanticDecisionBlockers.length - 200} additional blocker(s) omitted\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  if (write) writeArtifacts(result.artifacts);
  if (check) {
    const errors = checkArtifacts(result.artifacts);
    for (const finding of result.referenceProvenanceBlockers) {
      errors.push(`${finding.code} ${finding.path}: ${finding.detail}`);
    }
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(`${canonicalJcs({
    mode: write && check ? 'write-and-check' : (write ? 'write' : 'check'),
    outputRoot: repoPath(OUTPUT_ROOT),
    ...result.stats,
  })}\n`);
}

if (require.main === module) main();

module.exports = {
  checkArtifacts,
  constructArtifacts,
  dispositionFor,
  findAuthorityManagedReviewArtifacts,
};
