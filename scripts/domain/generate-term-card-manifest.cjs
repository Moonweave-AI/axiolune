#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const YAML = require('yaml');
const {
  TermCardCompilationError,
  compileTermCardManifest,
  validateTermCardManifest,
} = require('./lib/term-card-compiler.cjs');
const { evaluatePublicIriGeneration } = require('./lib/public-iri-generation-rule.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  GENERATION_RULE_PATH,
  PUBLIC_MANIFEST_PATH,
  REFERENCE_CLOSURE_PATH,
  TERM_MANIFEST_PATH,
  classify,
  discoverSnapshot,
} = require('./lib/public-symbol-term-coverage-validator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'term-card-manifest.json',
);
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';

function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

function artifactRef(file) {
  return {
    kind: 'path',
    root: 'sourceTree',
    path: path.isAbsolute(file) ? toPosix(path.relative(ROOT, file)) : file,
  };
}

function fatalUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${label} is not valid UTF-8: ${cause.message}`);
  }
}

function parseExactJcs(bytes, label) {
  const value = JSON.parse(fatalUtf8(bytes, label));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} is not exact RFC 8785 JCS bytes`);
  }
  return value;
}

function validateSnapshotInventory(files) {
  if (!(files instanceof Map)) throw new Error('term-card snapshot must be a byte Map');
  const exactSingleton = (classifier, relativePath, optional = false) => {
    const matches = [...files.keys()].filter((candidate) => classify(candidate) === classifier);
    if ((optional && matches.length === 0)
        || (matches.length === 1 && matches[0] === relativePath)) return;
    throw new Error(
      `term-card generator expected ${optional ? 'zero or one' : 'exactly one'} `
      + `${classifier} at ${relativePath}`,
    );
  };
  exactSingleton('publicSymbolManifest', PUBLIC_MANIFEST_PATH);
  exactSingleton('referenceClosure', REFERENCE_CLOSURE_PATH);
  exactSingleton('generationRule', GENERATION_RULE_PATH);
  exactSingleton('termCardManifest', TERM_MANIFEST_PATH, true);
}

function compile() {
  const snapshot = discoverSnapshot(ROOT);
  const files = snapshot.files;
  validateSnapshotInventory(files);
  const required = (relativePath, label) => {
    const bytes = files.get(relativePath);
    if (!Buffer.isBuffer(bytes)) throw new Error(`${label} is missing: ${relativePath}`);
    return bytes;
  };
  const publicBytes = required(PUBLIC_MANIFEST_PATH, 'public-symbol manifest');
  const closureBytes = required(REFERENCE_CLOSURE_PATH, 'reference-closure manifest');
  const generationRuleBytes = required(GENERATION_RULE_PATH, 'public IRI generation rule');
  const modules = [...files]
    .filter(([relativePath]) => classify(relativePath) === 'financeModule')
    .sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])))
    .map(([relativePath, bytes]) => YAML.parse(fatalUtf8(bytes, relativePath)));
  const artifacts = (classifier) => [...files]
    .filter(([relativePath]) => classify(relativePath) === classifier)
    .sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])))
    .map(([relativePath, bytes]) => ({
      artifactRef: artifactRef(relativePath),
      bytes,
    }));
  const input = {
    profileRef: PROFILE_REF,
    publicSymbolManifestArtifact: {
      artifactRef: artifactRef(PUBLIC_MANIFEST_PATH),
      bytes: publicBytes,
    },
    referenceClosureManifest: parseExactJcs(closureBytes, REFERENCE_CLOSURE_PATH),
    moduleDocs: modules,
    cardArtifacts: artifacts('directTermCard'),
    reviewArtifacts: artifacts('termReview'),
    inheritanceArtifacts: artifacts('generatedInheritance'),
    generationRuleArtifacts: [{
      artifactRef: artifactRef(GENERATION_RULE_PATH),
      bytes: generationRuleBytes,
    }],
  };
  const options = {
    generationRuleEvaluator: evaluatePublicIriGeneration,
    requireAccepted: true,
  };
  const compiled = compileTermCardManifest(input, options);
  const validation = validateTermCardManifest(compiled.manifest, input, options);
  if (!validation.ok) throw new TermCardCompilationError(validation.errors);
  return compiled;
}

function formatCompilationError(error) {
  const counts = new Map();
  for (const entry of error.errors) counts.set(entry.code, (counts.get(entry.code) || 0) + 1);
  const summary = [...counts.entries()]
    .sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])))
    .map(([code, count]) => `${code}=${count}`)
    .join(', ');
  const examples = error.errors.slice(0, 20)
    .map((entry) => `  - ${entry.code} ${entry.path}: ${entry.message}`)
    .join('\n');
  return `term-card compilation failed (${error.errors.length} issue(s): ${summary})`
    + (examples ? `\n${examples}` : '');
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const stdout = argv.includes('--stdout');
  const unknown = argv.filter((argument) => !['--check', '--write', '--stdout'].includes(argument));
  if (unknown.length > 0 || (write && stdout)) {
    throw new Error(
      'usage: node scripts/domain/generate-term-card-manifest.cjs '
      + '[--check|--write|--stdout]',
    );
  }
  const compiled = compile();
  const bytes = Buffer.from(canonicalJcs(compiled.manifest), 'utf8');
  const relative = toPosix(path.relative(ROOT, OUTPUT));
  if (stdout) {
    process.stdout.write(bytes);
    return;
  }
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, bytes);
    console.log(
      `WROTE ${relative} (${compiled.manifest.directEntries.length} direct, `
      + `${compiled.manifest.generatedEntries.length} generated, ${compiled.manifestDigest})`,
    );
    return;
  }
  if (!fs.existsSync(OUTPUT)) {
    console.error(`MISSING ${relative}`);
    process.exitCode = 1;
    return;
  }
  const actual = fs.readFileSync(OUTPUT);
  if (!actual.equals(bytes)) {
    console.error(`DRIFT ${relative} (${compiled.manifestDigest})`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS term-card manifest (${compiled.manifest.directEntries.length} direct, `
    + `${compiled.manifest.generatedEntries.length} generated, ${compiled.manifestDigest})`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `FATAL ${error instanceof TermCardCompilationError
        ? formatCompilationError(error)
        : (error.stack || error.message)}`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  compile,
  main,
  parseExactJcs,
  validateSnapshotInventory,
};
