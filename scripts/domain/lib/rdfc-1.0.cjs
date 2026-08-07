'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

const DATASET_DOMAIN_TAG = 'axiolune-rdf-dataset-v1\0';
const GRAPH_DOMAIN_TAG = 'axiolune-rdf-graph-v1\0';
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_QUADS = 10000;
const WORKER_PATH = path.join(__dirname, 'rdfc-1.0-worker.cjs');
const ALGORITHM = 'RDFC-1.0';

class RdfcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RdfcError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RdfcError(code, message);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function packageVersion() {
  return '5.0.0';
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function ensureStringInput(input, label = 'input') {
  if (typeof input !== 'string') fail('RDFC_INPUT_TYPE', `${label} must be a UTF-8 string`);
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes === 0) fail('RDFC_EMPTY_DATASET', `${label} must not be empty`);
  if (bytes > MAX_INPUT_BYTES) fail('RDFC_INPUT_TOO_LARGE', `${label} exceeds ${MAX_INPUT_BYTES} bytes`);
  return input;
}

function parseLineTerms(line) {
  const terms = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i += 1;
    if (i >= line.length) break;
    if (line[i] === '<') {
      const end = line.indexOf('>', i);
      if (end < 0) fail('RDFC_PARSE', 'unterminated IRI');
      terms.push(line.slice(i, end + 1));
      i = end + 1;
    } else if (line[i] === '_') {
      let j = i + 1;
      while (j < line.length && line[j] !== ' ') j += 1;
      terms.push(line.slice(i, j));
      i = j;
    } else if (line[i] === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < line.length) {
        const ch = line[j];
        if (escaped) { escaped = false; j += 1; continue; }
        if (ch === '\\') { escaped = true; j += 1; continue; }
        if (ch === '"') { j += 1; break; }
        j += 1;
      }
      while (j < line.length && line[j] === ' ') j += 1;
      if (line.startsWith('^^', j)) {
        const end = line.indexOf('>', j);
        if (end < 0) fail('RDFC_PARSE', 'unterminated datatype IRI');
        j = end + 1;
      } else if (line[j] === '@') {
        j += 1;
        while (j < line.length && line[j] !== ' ') j += 1;
      }
      terms.push(line.slice(i, j));
      i = j;
    } else {
      fail('RDFC_PARSE', 'unexpected N-Quads term');
    }
  }
  return terms;
}

function parseQuadLine(line) {
  if (!line.endsWith(' .')) fail('RDFC_PARSE', 'invalid N-Quads line terminator');
  const terms = parseLineTerms(line.slice(0, -2));
  if (terms.length === 3) fail('RDFC_GRAPH_NAME', 'default graph quads are prohibited');
  if (terms.length !== 4) fail('RDFC_PARSE', 'invalid N-Quads term count');
  const graphTerm = terms[3];
  if (!graphTerm.startsWith('<') || !graphTerm.endsWith('>')) {
    fail('RDFC_GRAPH_NAME', 'graph term must be an absolute IRI');
  }
  return { line, graphIri: graphTerm.slice(1, -1) };
}

function parseDataset(input) {
  const text = ensureStringInput(input);
  if (!text.endsWith('\n')) fail('RDFC_PARSE', 'N-Quads input must end with a newline');
  const rawLines = text.slice(0, -1).split('\n');
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  if (rawLines.some((line) => line.length === 0)) fail('RDFC_PARSE', 'N-Quads must not contain blank lines');
  if (rawLines.length > MAX_QUADS) fail('RDFC_TOO_MANY_QUADS', `quad count exceeds ${MAX_QUADS}`);
  const quads = rawLines.map(parseQuadLine);
  const graphIris = [...new Set(quads.map((quad) => quad.graphIri))].sort(compareUtf8);
  const normalized = `${rawLines.join('\n')}\n`;
  return { text: normalized, quads, graphIris, quadCount: quads.length };
}

function spawnCanonicalizer(input) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = spawnSync(process.execPath, [WORKER_PATH], {
    input: Buffer.from(input, 'utf8'),
    maxBuffer: MAX_INPUT_BYTES * 2,
    env,
  });
  if (result.error) fail('RDFC_WORKER', result.error.message);
  if (result.status !== 0) {
    const message = (result.stderr || Buffer.alloc(0)).toString('utf8').trim() || 'RDFC worker failed';
    if (message.includes('RDFC_PARSE')) fail('RDFC_PARSE', message);
    fail('RDFC_WORKER', message);
  }
  const canonical = result.stdout.toString('utf8');
  if (!canonical.endsWith('\n')) fail('RDFC_WORKER', 'canonical N-Quads must end with a newline');
  return canonical;
}

function digestWithTag(tag, canonicalNQuads) {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(tag, 'utf8'));
  hash.update(Buffer.from(canonicalNQuads, 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function filterGraphQuads(input, graphIri) {
  const dataset = parseDataset(input);
  const selected = dataset.quads.filter((quad) => quad.graphIri === graphIri);
  if (selected.length === 0) fail('RDFC_GRAPH_MISSING', `graph not present: ${graphIri}`);
  const graphDocument = `${selected.map((quad) => quad.line).join('\n')}\n`;
  const canonicalNQuads = spawnCanonicalizer(graphDocument);
  return {
    algorithm: ALGORITHM,
    canonicalNQuads,
    digest: digestWithTag(GRAPH_DOMAIN_TAG, canonicalNQuads),
    graphIris: [graphIri],
    quadCount: selected.length,
  };
}

function canonicalizeNQuads(input) {
  const dataset = parseDataset(input);
  const canonicalNQuads = spawnCanonicalizer(dataset.text);
  return {
    algorithm: ALGORITHM,
    canonicalNQuads,
    graphIris: dataset.graphIris,
    quadCount: dataset.quadCount,
  };
}

function computeNamedGraphDigest(input, graphIri) {
  if (typeof graphIri !== 'string' || graphIri.length === 0) {
    fail('RDFC_GRAPH_NAME', 'graph IRI must be a non-empty string');
  }
  return filterGraphQuads(input, graphIri);
}

function computeTaggedNamedGraphDigest(input, graphIri, tag) {
  const base = filterGraphQuads(input, graphIri);
  return {
    ...base,
    digest: digestWithTag(tag, base.canonicalNQuads),
  };
}

function computeDatasetDigest(input, graphIris) {
  const dataset = parseDataset(input);
  const scope = graphIris == null
    ? dataset.graphIris
    : [...graphIris].sort(compareUtf8);

  if (graphIris != null) {
    if (!Array.isArray(graphIris) || graphIris.some((iri) => typeof iri !== 'string')) {
      fail('RDFC_DATASET_SCOPE', 'graph scope must be an array of IRIs');
    }
    const expected = dataset.graphIris.join('\0');
    const actual = scope.join('\0');
    if (expected !== actual) fail('RDFC_DATASET_SCOPE', 'graph scope must equal the dataset graph inventory');
  }

  const scopedLines = dataset.quads
    .filter((quad) => scope.includes(quad.graphIri))
    .map((quad) => quad.line);
  const scopedDocument = `${scopedLines.join('\n')}\n`;
  const canonicalNQuads = spawnCanonicalizer(scopedDocument);
  return {
    algorithm: ALGORITHM,
    canonicalNQuads,
    digest: digestWithTag(DATASET_DOMAIN_TAG, canonicalNQuads),
    graphIris: scope,
    quadCount: scopedLines.length,
  };
}

function nterm(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (/^https?:\/\//u.test(value) || value.startsWith('urn:')) return `<${value}>`;
    if (value.startsWith('_:')) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `"${String(value)}"`;
  return null;
}

function graphTerm(graphIri) {
  if (graphIri.startsWith('<') && graphIri.endsWith('>')) return graphIri;
  return `<${graphIri}>`;
}

function stagingFactsToNQuads(facts, graphIri, options = {}) {
  if (!Array.isArray(facts) || typeof graphIri !== 'string') {
    fail('RDFC_STAGING_INPUT', 'facts must be an array and graphIri must be a string');
  }
  const prefix = options.blankNodePrefix || 'b';
  const reverse = Boolean(options.reverse);
  let blankCounter = 0;
  const lines = [];

  function emit(subject, predicate, object) {
    lines.push(`${subject} ${predicate} ${object} ${graphTerm(graphIri)} .`);
  }

  function walk(node, subjectIri) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'iri' || key === 'type') continue;
      const predicate = key.startsWith('http') ? `<${key}>` : `<urn:axiolune:pred:${key}>`;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const blank = `_:${prefix}${blankCounter++}`;
        emit(subjectIri, predicate, blank);
        walk(value, blank);
      } else {
        const object = nterm(value);
        if (object) emit(subjectIri, predicate, object);
      }
    }
  }

  const orderedFacts = reverse ? [...facts].reverse() : [...facts];
  for (const fact of orderedFacts) {
    if (!fact || typeof fact !== 'object') continue;
    const subject = nterm(fact.iri);
    if (!subject) continue;
    if (fact.type) emit(subject, '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>', nterm(fact.type));
    walk(fact, subject);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  ALGORITHM,
  DATASET_DOMAIN_TAG,
  GRAPH_DOMAIN_TAG,
  MAX_INPUT_BYTES,
  MAX_QUADS,
  RdfcError,
  canonicalizeNQuads,
  computeDatasetDigest,
  computeNamedGraphDigest,
  computeTaggedNamedGraphDigest,
  packageVersion,
  sha256,
  stagingFactsToNQuads,
};
