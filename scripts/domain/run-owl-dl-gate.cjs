#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const {
  DataFactory,
  Parser,
  Writer,
} = require('n3');
const { version: N3_VERSION } = require('n3/package.json');

const {
  blankNode,
  namedNode,
  quad,
} = DataFactory;

const ROOT = path.resolve(__dirname, '..', '..');
const sourceRootArgumentIndex = process.argv.indexOf('--source-root');
const SOURCE_ROOT = sourceRootArgumentIndex >= 0
  ? path.resolve(process.argv[sourceRootArgumentIndex + 1] || '')
  : ROOT;
const FINANCE = path.join(SOURCE_ROOT, 'ontology', 'domain', 'finance');
const META_OWL = path.join(SOURCE_ROOT, 'ontology', 'meta', 'projection', 'axiolune-meta.owl.ttl');
const LOCK_FILE = path.join(
  SOURCE_ROOT,
  'scripts',
  'domain',
  'owl-dl-profile',
  'v0.3.0',
  'tool-lock.json',
);
const DISCOVERY_CONTRACT_FILE = path.join(
  SOURCE_ROOT,
  'scripts',
  'domain',
  'owl-dl-profile',
  'v0.3.0',
  'subject-discovery-contract.json',
);
const EVIDENCE_SCHEMA_FILE = path.join(
  SOURCE_ROOT,
  'scripts',
  'domain',
  'owl-dl-profile',
  'v0.3.0',
  'owl-dl-evidence.schema.json',
);
const NODE_DEPENDENCY_LOCK_FILE = path.join(SOURCE_ROOT, 'package-lock.json');
const FIXTURE_ROOT = path.join(SOURCE_ROOT, 'tests', 'm2', 'fixtures', 'owl-dl');
const META_IRI = 'https://axiolune.ai/ontology/meta';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const OWL_IMPORTS = 'http://www.w3.org/2002/07/owl#imports';
const OWL_VERSION_IRI = 'http://www.w3.org/2002/07/owl#versionIRI';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty';
const OWL_DATATYPE_PROPERTY = 'http://www.w3.org/2002/07/owl#DatatypeProperty';
const OWL_ANNOTATION_PROPERTY = 'http://www.w3.org/2002/07/owl#AnnotationProperty';
const RDFS_DATATYPE = 'http://www.w3.org/2000/01/rdf-schema#Datatype';
const OWL_ENTITY_DECLARATION_TYPES = new Set([
  OWL_CLASS,
  OWL_OBJECT_PROPERTY,
  OWL_DATATYPE_PROPERTY,
  OWL_ANNOTATION_PROPERTY,
  RDFS_DATATYPE,
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function exactStringArray(actual, expected, label) {
  requireCondition(
    Array.isArray(actual) && actual.length === expected.length
      && actual.every((value, index) => value === expected[index]),
    `${label} does not equal the locked inventory`,
  );
}

function loadStaticContracts() {
  const discovery = JSON.parse(fs.readFileSync(DISCOVERY_CONTRACT_FILE, 'utf8'));
  const evidenceSchema = JSON.parse(fs.readFileSync(EVIDENCE_SCHEMA_FILE, 'utf8'));
  requireCondition(
    discovery.schemaVersion === '1.0'
      && discovery.profileRef === 'https://axiolune.ai/conformance/m2/0.3.0'
      && discovery.entrypoint === 'scripts/domain/run-owl-dl-gate.cjs',
    'OWL DL discovery contract identity is invalid',
  );
  requireCondition(
    discovery.moduleDiscovery
      && discovery.moduleDiscovery.root === 'ontology/domain/finance'
      && discovery.moduleDiscovery.manifestFileName === 'module.yaml'
      && discovery.moduleDiscovery.owlFileName === 'module.owl.ttl'
      && discovery.moduleDiscovery.exactCount === 10,
    'OWL DL module discovery contract is invalid',
  );
  requireCondition(
    discovery.metaProjection === 'ontology/meta/projection/axiolune-meta.owl.ttl',
    'OWL DL discovery contract names the wrong M3 projection',
  );
  requireCondition(
    discovery.closureConstruction
      && discovery.closureConstruction.parserPackage === 'n3'
      && discovery.closureConstruction.parserVersion === N3_VERSION
      && discovery.closureConstruction.dependencyLock === 'package-lock.json'
      && discovery.closureConstruction.packageIntegrity
        === 'sha512-kqg8ers6Lc+uAmHeS+ycd3b8mC4x8wr8V8Fi6+w7l4hX6b0KZ5bT05Tf49qM2mujwaqZT3+08zcgtXgfxivbVQ=='
      && discovery.closureConstruction.aggregateOntologyIri
        === 'https://axiolune.ai/ontology/finance/0.3.0/reasoner-aggregate'
      && discovery.closureConstruction.outputFileName === 'flattened-closure.ttl'
      && discovery.closureConstruction.requiredMetaImport === META_IRI
      && discovery.closureConstruction.mode
        === 'parse-verify-strip-headers-deduplicate-flatten'
      && discovery.closureConstruction.invocationTimeoutMs === 300000,
    'OWL DL flattened-closure contract is invalid',
  );
  exactStringArray(
    discovery.gateIds,
    ['owl-dl-profile', 'owl-reasoner-primary', 'owl-reasoner-secondary'],
    'OWL DL gate IDs',
  );
  requireCondition(
    discovery.positiveFixture === 'tests/m2/fixtures/owl-dl/consistent.ttl',
    'OWL DL positive fixture contract is invalid',
  );
  exactStringArray(
    discovery.negativeFixtures,
    [
      'tests/m2/fixtures/owl-dl/inconsistent.ttl',
      'tests/m2/fixtures/owl-dl/profile-violation.ttl',
      'tests/m2/fixtures/owl-dl/unsatisfiable.ttl',
    ],
    'OWL DL negative fixtures',
  );
  requireCondition(
    evidenceSchema.$id === 'https://axiolune.ai/schemas/m2/0.3.0/owl-dl-evidence'
      && evidenceSchema.type === 'object'
      && evidenceSchema.additionalProperties === false,
    'OWL DL evidence schema identity is invalid',
  );
  exactStringArray(
    evidenceSchema.required,
    [
      'schemaVersion', 'profileRef', 'outcome', 'moduleCount',
      'importedOntologyIris', 'sourceArtifacts', 'flattenedClosure',
      'toolchain', 'gates', 'negativeReasonerCorpus',
    ],
    'OWL DL evidence required fields',
  );
  return { discovery, evidenceSchema };
}

function resolveExisting(candidate, label) {
  requireCondition(typeof candidate === 'string' && candidate.length > 0, `${label} was not provided`);
  const resolved = path.resolve(ROOT, candidate);
  requireCondition(fs.existsSync(resolved), `${label} does not exist: ${resolved}`);
  requireCondition(fs.statSync(resolved).isFile(), `${label} is not a file: ${resolved}`);
  return resolved;
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function prepareOutputDirectory(requestedOutput) {
  const outputRoot = path.resolve(ROOT, requestedOutput);
  const sourceRootReal = fs.realpathSync(SOURCE_ROOT);
  requireCondition(
    !isPathWithin(ROOT, outputRoot) && !isPathWithin(SOURCE_ROOT, outputRoot),
    'OWL-DL output directory must be outside the source tree',
  );
  if (fs.existsSync(outputRoot)) {
    const stat = fs.lstatSync(outputRoot);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(),
      'OWL-DL output path must be a non-symlink directory');
    requireCondition(fs.readdirSync(outputRoot).length === 0,
      'OWL-DL output directory must be empty');
  } else {
    fs.mkdirSync(outputRoot, { recursive: true });
  }
  const outputReal = fs.realpathSync(outputRoot);
  requireCondition(
    !isPathWithin(sourceRootReal, outputReal),
    'OWL-DL output directory resolves into the source tree',
  );
  return outputRoot;
}

function discoverModules() {
  return fs.readdirSync(FINANCE)
    .filter((name) => fs.existsSync(path.join(FINANCE, name, 'module.yaml')))
    .sort()
    .map((name) => {
      const manifest = yaml.load(
        fs.readFileSync(path.join(FINANCE, name, 'module.yaml'), 'utf8'),
        { schema: yaml.CORE_SCHEMA.withTags(yaml.mergeTag) },
      );
      const owlFile = path.join(FINANCE, name, 'module.owl.ttl');
      requireCondition(fs.existsSync(owlFile), `${name} lacks module.owl.ttl`);
      requireCondition(
        manifest && manifest.module && typeof manifest.module.moduleIri === 'string',
        `${name} lacks module.moduleIri`,
      );
      const declaredImports = Array.isArray(manifest.module.imports)
        ? manifest.module.imports.map((entry) => entry && entry.moduleIri)
        : [];
      requireCondition(
        declaredImports.every((iri) => typeof iri === 'string' && iri.length > 0),
        `${name} contains an invalid module import`,
      );
      const expectedImports = [...new Set([...declaredImports, META_IRI])].sort(compareUtf8);
      return {
        name,
        moduleIri: manifest.module.moduleIri,
        versionIri: `${manifest.module.moduleIri}/${manifest.module.version}`,
        expectedImports,
        owlFile,
        owlDigest: sha256(owlFile),
      };
    });
}

function termKey(term, normalizeFlattenedBlankNodes = false) {
  if (term.termType === 'NamedNode') return `N${term.value.length}:${term.value}`;
  if (term.termType === 'DefaultGraph') return 'G';
  if (term.termType === 'BlankNode') {
    let value = term.value;
    if (normalizeFlattenedBlankNodes) {
      const marker = value.indexOf('owlflat_');
      requireCondition(marker >= 0, `flattened graph contains an unscoped blank node ${value}`);
      value = value.slice(marker);
    }
    return `B${value.length}:${value}`;
  }
  if (term.termType === 'Literal') {
    const language = term.language || '';
    const datatype = term.datatype && term.datatype.value ? term.datatype.value : '';
    return `L${term.value.length}:${term.value}:${language.length}:${language}:${datatype.length}:${datatype}`;
  }
  throw new Error(`unsupported RDF term type ${term.termType}`);
}

function quadKey(value, normalizeFlattenedBlankNodes = false) {
  return [value.subject, value.predicate, value.object, value.graph]
    .map((term) => termKey(term, normalizeFlattenedBlankNodes))
    .join('|');
}

function owlSerializationRank(value, aggregateOntologyIri) {
  if (value.subject.termType === 'NamedNode'
      && value.subject.value === aggregateOntologyIri
      && value.predicate.value === RDF_TYPE
      && value.object.termType === 'NamedNode'
      && value.object.value === OWL_ONTOLOGY) return 0;
  if (value.predicate.value === RDF_TYPE
      && value.object.termType === 'NamedNode'
      && OWL_ENTITY_DECLARATION_TYPES.has(value.object.value)) return 1;
  // Structural-node declarations (for example owl:Restriction), property
  // characteristics, NamedIndividual declarations, and class assertions must
  // all precede predicates that consume the typed subject.
  if (value.predicate.value === RDF_TYPE) return 2;
  return 3;
}

function compareOwlSerializationOrder(left, right, aggregateOntologyIri) {
  const rankDifference = owlSerializationRank(left, aggregateOntologyIri)
    - owlSerializationRank(right, aggregateOntologyIri);
  if (rankDifference !== 0) return rankDifference;
  return compareUtf8(quadKey(left, true), quadKey(right, true));
}

function sortedUniqueStrings(values) {
  return [...new Set(values)].sort(compareUtf8);
}

function inspectOntologySource(sourceText, specification) {
  let quads;
  try {
    quads = new Parser().parse(sourceText);
  } catch (cause) {
    throw new Error(`${specification.label} is not strict Turtle: ${cause.message}`);
  }
  requireCondition(quads.length > 0, `${specification.label} parsed as an empty graph`);
  requireCondition(
    quads.every((value) => value.graph.termType === 'DefaultGraph'),
    `${specification.label} contains a named graph`,
  );
  const declarations = quads.filter((value) => (
    value.predicate.termType === 'NamedNode'
      && value.predicate.value === RDF_TYPE
      && value.object.termType === 'NamedNode'
      && value.object.value === OWL_ONTOLOGY
  ));
  requireCondition(
    declarations.length === 1,
    `${specification.label} must contain exactly one owl:Ontology declaration; found ${declarations.length}`,
  );
  const ontology = declarations[0].subject;
  requireCondition(
    ontology.termType === 'NamedNode' && ontology.value === specification.ontologyIri,
    `${specification.label} ontology header does not equal ${specification.ontologyIri}`,
  );
  const misplacedImports = quads.filter((value) => (
    value.predicate.termType === 'NamedNode'
      && value.predicate.value === OWL_IMPORTS
      && !value.subject.equals(ontology)
  ));
  requireCondition(
    misplacedImports.length === 0,
    `${specification.label} contains owl:imports outside its ontology header`,
  );
  const imports = quads
    .filter((value) => value.subject.equals(ontology)
      && value.predicate.termType === 'NamedNode'
      && value.predicate.value === OWL_IMPORTS)
    .map((value) => {
      requireCondition(
        value.object.termType === 'NamedNode',
        `${specification.label} contains a non-IRI owl:imports target`,
      );
      return value.object.value;
    });
  const uniqueImports = sortedUniqueStrings(imports);
  requireCondition(
    imports.length === uniqueImports.length,
    `${specification.label} contains duplicate owl:imports targets`,
  );
  exactStringArray(uniqueImports, [...specification.expectedImports].sort(compareUtf8),
    `${specification.label} imports`);
  const versionIris = quads
    .filter((value) => value.subject.equals(ontology)
      && value.predicate.termType === 'NamedNode'
      && value.predicate.value === OWL_VERSION_IRI)
    .map((value) => value.object);
  requireCondition(
    versionIris.length === 1
      && versionIris[0].termType === 'NamedNode'
      && versionIris[0].value === specification.versionIri,
    `${specification.label} must contain exactly the version IRI ${specification.versionIri}`,
  );
  const headerQuads = quads.filter((value) => value.subject.equals(ontology));
  const axiomQuads = quads.filter((value) => !value.subject.equals(ontology));
  requireCondition(axiomQuads.length > 0, `${specification.label} has no non-header axioms`);
  return {
    label: specification.label,
    path: specification.path,
    digest: specification.digest,
    ontologyIri: ontology.value,
    imports: uniqueImports,
    quads,
    headerQuads,
    axiomQuads,
  };
}

function validateOntologyImportDag(analyses) {
  const byIri = new Map(analyses.map((analysis) => [analysis.ontologyIri, analysis]));
  requireCondition(byIri.size === analyses.length, 'OWL source inventory contains duplicate ontology IRIs');
  for (const analysis of analyses) {
    for (const importedIri of analysis.imports) {
      requireCondition(
        byIri.has(importedIri),
        `${analysis.label} imports an ontology outside the flattened source inventory: ${importedIri}`,
      );
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(ontologyIri, trail) {
    requireCondition(
      !visiting.has(ontologyIri),
      `OWL import cycle: ${[...trail, ontologyIri].join(' -> ')}`,
    );
    if (visited.has(ontologyIri)) return;
    visiting.add(ontologyIri);
    for (const importedIri of byIri.get(ontologyIri).imports) {
      visit(importedIri, [...trail, ontologyIri]);
    }
    visiting.delete(ontologyIri);
    visited.add(ontologyIri);
  }
  for (const ontologyIri of [...byIri.keys()].sort(compareUtf8)) visit(ontologyIri, []);
}

function remapDocumentAxioms(analysis, sourceIndex) {
  const blankNodes = new Map();
  function remap(term) {
    if (term.termType !== 'BlankNode') return term;
    if (!blankNodes.has(term.value)) {
      // N3 scopes parsed blank labels with a process-global b<counter>_ prefix.
      // Remove exactly that parser scope; sourceIndex supplies our stable document scope.
      const sourceLocalLabel = term.value.replace(/^b\d+_/u, '');
      const stableId = crypto.createHash('sha256')
        .update(`${sourceIndex}\0${sourceLocalLabel}`, 'utf8')
        .digest('hex');
      blankNodes.set(term.value, blankNode(`owlflat_s${sourceIndex}_${stableId}`));
    }
    return blankNodes.get(term.value);
  }
  return analysis.axiomQuads.map((value) => quad(
    remap(value.subject),
    value.predicate,
    remap(value.object),
  ));
}

function verifyExactFlattenedQuadSet(actual, expected, label = 'flattened closure') {
  const actualKeys = actual.map((value) => quadKey(value, true)).sort(compareUtf8);
  const expectedKeys = expected.map((value) => quadKey(value, true)).sort(compareUtf8);
  requireCondition(
    actualKeys.length === expectedKeys.length
      && actualKeys.every((value, index) => value === expectedKeys[index]),
    `${label} dropped, added, or changed at least one non-header axiom`,
  );
}

function buildFlattenedClosure(analyses, aggregateOntologyIri) {
  const mappedAxioms = analyses.flatMap((analysis, index) => (
    remapDocumentAxioms(analysis, index)
  ));
  const uniqueAxiomsByKey = new Map();
  for (const value of mappedAxioms) {
    const key = quadKey(value, true);
    if (!uniqueAxiomsByKey.has(key)) uniqueAxiomsByKey.set(key, value);
  }
  const aggregateHeader = quad(
    namedNode(aggregateOntologyIri),
    namedNode(RDF_TYPE),
    namedNode(OWL_ONTOLOGY),
  );
  const expectedQuads = [aggregateHeader, ...uniqueAxiomsByKey.values()]
    // OWLAPI strict RDF parsing deliberately refuses to infer missing entity types.
    // Emit explicit declarations before every dependent restriction/domain/range
    // axiom so parse success is independent of source-file statement order.
    .sort((left, right) => compareOwlSerializationOrder(
      left,
      right,
      aggregateOntologyIri,
    ));
  const serialized = new Writer({ format: 'N-Triples' }).quadsToString(expectedQuads);
  const reparsed = new Parser().parse(serialized);
  verifyExactFlattenedQuadSet(reparsed, expectedQuads, 'serialized flattened closure');
  const declarations = reparsed.filter((value) => (
    value.predicate.value === RDF_TYPE && value.object.value === OWL_ONTOLOGY
  ));
  requireCondition(
    declarations.length === 1
      && declarations[0].subject.termType === 'NamedNode'
      && declarations[0].subject.value === aggregateOntologyIri,
    'flattened closure does not contain exactly one aggregate ontology header',
  );
  requireCondition(
    reparsed.every((value) => value.predicate.value !== OWL_IMPORTS),
    'flattened closure retained an owl:imports statement',
  );
  return {
    serialized,
    quads: expectedQuads,
    sourceQuadCount: analyses.reduce((total, analysis) => total + analysis.quads.length, 0),
    removedHeaderQuadCount: analyses.reduce(
      (total, analysis) => total + analysis.headerQuads.length,
      0,
    ),
    preDedupAxiomQuadCount: mappedAxioms.length,
    duplicateAxiomQuadCount: mappedAxioms.length - uniqueAxiomsByKey.size,
    outputQuadCount: expectedQuads.length,
  };
}

function execute(java, robotJar, robotArguments, label) {
  const result = spawnSync(
    java,
    ['-Xmx2g', '-jar', robotJar, ...robotArguments],
    {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
    },
  );
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    label,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    warnings: `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .filter((line) => /\bWARN(?:ING)?\b/i.test(line)),
  };
}

function requireCleanSuccess(result) {
  const diagnosticLines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const salient = diagnosticLines.filter((line) => (
    /(?:caused by|error|exception|expected one ontology declaration|inconsistent|unsatisfiable|violation)/iu
      .test(line)
  ));
  const diagnostic = [...new Set([...diagnosticLines.slice(0, 5), ...salient])]
    .slice(0, 30)
    .join(' | ');
  requireCondition(
    result.status === 0,
    `${result.label} failed with exit ${result.status}${diagnostic ? `: ${diagnostic}` : ''}`,
  );
  requireCondition(result.signal === null, `${result.label} ended with signal ${result.signal}`);
  requireCondition(
    result.warnings.length === 0,
    `${result.label} emitted warning(s): ${result.warnings.slice(0, 5).join(' | ')}`,
  );
}

function requireRejected(result, expectedPatterns) {
  requireCondition(
    result.status === 1 && result.signal === null,
    `${result.label} negative unexpectedly passed`,
  );
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  for (const pattern of expectedPatterns) {
    requireCondition(
      pattern.test(diagnostic),
      `${result.label} failed for the wrong reason; missing diagnostic ${pattern}`,
    );
  }
}

function main() {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  const contracts = loadStaticContracts();
  const dependencyLock = JSON.parse(fs.readFileSync(NODE_DEPENDENCY_LOCK_FILE, 'utf8'));
  requireCondition(lock.schemaVersion === '1.0', 'OWL DL tool lock schemaVersion must equal 1.0');
  requireCondition(lock.profile && lock.profile.robotArgument === 'DL', 'tool lock must select DL');
  requireCondition(
    Array.isArray(lock.reasoners)
      && lock.reasoners.length === 2
      && new Set(lock.reasoners.map((entry) => entry.implementation)).size === 2,
    'tool lock must contain exactly two independent reasoner implementations',
  );
  const n3Lock = dependencyLock.packages && dependencyLock.packages['node_modules/n3'];
  requireCondition(
    n3Lock
      && n3Lock.version === N3_VERSION
      && n3Lock.integrity === contracts.discovery.closureConstruction.packageIntegrity,
    'package-lock.json does not bind the executing N3 parser bytes',
  );

  const runtimeRoot = path.join(ROOT, 'tmp', 'owl-dl-runtime');
  const java = resolveExisting(
    argument('--java')
      || process.env.AXIOLUNE_JAVA
      || path.join(
        runtimeRoot,
        'jre-17.0.20+8',
        'jdk-17.0.20+8-jre',
        'bin',
        process.platform === 'win32' ? 'java.exe' : 'java',
      ),
    'Java runtime',
  );
  const robotJar = resolveExisting(
    argument('--robot-jar')
      || process.env.AXIOLUNE_ROBOT_JAR
      || path.join(runtimeRoot, lock.robot.artifactFileName),
    'ROBOT jar',
  );
  const jreArchive = resolveExisting(
    argument('--jre-archive')
      || process.env.AXIOLUNE_JRE_ARCHIVE
      || path.join(runtimeRoot, lock.javaRuntime.archiveFileName),
    'JRE distribution archive',
  );
  requireCondition(
    sha256(robotJar) === lock.robot.artifactDigest,
    `ROBOT jar digest mismatch: ${sha256(robotJar)}`,
  );
  requireCondition(
    sha256(jreArchive) === lock.javaRuntime.artifactDigest,
    `JRE archive digest mismatch: ${sha256(jreArchive)}`,
  );

  const version = spawnSync(java, ['-version'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: 30000,
  });
  requireCondition(version.status === 0, 'java -version failed');
  const versionText = `${version.stdout || ''}\n${version.stderr || ''}`;
  for (const expected of lock.javaRuntime.versionOutputContains) {
    requireCondition(versionText.includes(expected), `Java version output lacks ${expected}`);
  }
  const robotVersion = execute(java, robotJar, ['--version'], 'ROBOT version');
  requireCleanSuccess(robotVersion);
  requireCondition(
    robotVersion.stdout.includes(`ROBOT version ${lock.robot.version}`),
    `ROBOT version output does not equal ${lock.robot.version}`,
  );

  const requestedOutput = argument('--output-dir')
    || process.env.AXIOLUNE_GATE_OUTPUT_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-owl-dl-'));
  const outputRoot = prepareOutputDirectory(requestedOutput);
  const modules = discoverModules();
  requireCondition(
    modules.length === contracts.discovery.moduleDiscovery.exactCount,
    `expected ${contracts.discovery.moduleDiscovery.exactCount} active modules, found ${modules.length}`,
  );
  requireCondition(fs.existsSync(META_OWL), 'M3 OWL projection is missing');
  const sourceSpecifications = [
    {
      label: 'M3 canonical projection',
      path: path.relative(SOURCE_ROOT, META_OWL).split(path.sep).join('/'),
      digest: sha256(META_OWL),
      file: META_OWL,
      ontologyIri: META_IRI,
      versionIri: 'https://axiolune.ai/ontology/meta/0.6.0',
      expectedImports: [],
    },
    ...modules.map((module) => ({
      label: `M2 ${module.name}`,
      path: path.relative(SOURCE_ROOT, module.owlFile).split(path.sep).join('/'),
      digest: module.owlDigest,
      file: module.owlFile,
      ontologyIri: module.moduleIri,
      versionIri: module.versionIri,
      expectedImports: module.expectedImports,
    })),
  ];
  const analyses = sourceSpecifications.map((specification) => inspectOntologySource(
    fs.readFileSync(specification.file, 'utf8'),
    specification,
  ));
  const ontologyIris = analyses.map((analysis) => analysis.ontologyIri);
  validateOntologyImportDag(analyses);
  const flattened = buildFlattenedClosure(
    analyses,
    contracts.discovery.closureConstruction.aggregateOntologyIri,
  );
  const flattenedFile = path.join(
    outputRoot,
    contracts.discovery.closureConstruction.outputFileName,
  );
  fs.writeFileSync(flattenedFile, flattened.serialized);
  requireCondition(
    sha256Bytes(flattened.serialized) === sha256(flattenedFile),
    'flattened closure bytes changed while writing evidence',
  );

  const profileReport = path.join(outputRoot, 'owl-dl-profile-report.txt');
  const profile = execute(java, robotJar, [
    'validate-profile',
    '--profile',
    lock.profile.robotArgument,
    '--input',
    flattenedFile,
    '--output',
    profileReport,
    '--strict',
  ], 'OWL 2 DL profile');
  requireCleanSuccess(profile);
  requireCondition(fs.existsSync(profileReport), 'ROBOT did not emit the DL profile report');

  const reasonerResults = [];
  for (const reasoner of lock.reasoners) {
    const output = path.join(outputRoot, `${reasoner.gateId}-reasoned.owl`);
    const result = execute(java, robotJar, [
      'reason',
      '--reasoner',
      reasoner.robotArgument,
      '--input',
      flattenedFile,
      '--output',
      output,
      '--equivalent-classes-allowed',
      'all',
      '--strict',
    ], `${reasoner.name} current closure`);
    requireCleanSuccess(result);
    requireCondition(fs.existsSync(output) && fs.statSync(output).size > 0, `${reasoner.name} emitted no ontology`);
    reasonerResults.push({
      gateId: reasoner.gateId,
      name: reasoner.name,
      implementation: reasoner.implementation,
      version: reasoner.version,
      outcome: 'passed',
      outputDigest: sha256(output),
    });
  }

  const profileNegative = execute(java, robotJar, [
    'validate-profile',
    '--profile',
    lock.profile.robotArgument,
    '--input',
    path.join(FIXTURE_ROOT, 'profile-violation.ttl'),
    '--output',
    path.join(outputRoot, 'profile-violation-report.txt'),
  ], 'OWL 2 DL profile violation');
  // ROBOT writes semantic profile violations to the requested report file.
  // A non-zero process result proves rejection; the exact violation is checked
  // from that report immediately below. Do not couple this control to parser
  // diagnostics, which are evidence of malformed RDF rather than an OWL 2 DL
  // profile violation.
  requireRejected(profileNegative, []);
  const profileNegativeReport = path.join(outputRoot, 'profile-violation-report.txt');
  requireCondition(
    fs.existsSync(profileNegativeReport)
      && fs.readFileSync(profileNegativeReport, 'utf8').includes(
        'Use of non-simple property in a restriction',
      ),
    'profile negative was not rejected for the expected OWL 2 DL violation',
  );

  const negativeResults = [];
  for (const reasoner of lock.reasoners) {
    for (const fixture of ['inconsistent.ttl', 'unsatisfiable.ttl']) {
      const result = execute(java, robotJar, [
        'reason',
        '--reasoner',
        reasoner.robotArgument,
        '--input',
        path.join(FIXTURE_ROOT, fixture),
        '--output',
        path.join(outputRoot, `${reasoner.gateId}-${fixture}.owl`),
        '--equivalent-classes-allowed',
        'all',
        '--strict',
      ], `${reasoner.name} ${fixture}`);
      const diagnosticCode = fixture === 'inconsistent.ttl'
        ? 'ontology-inconsistent'
        : 'unsatisfiable-class';
      const expectedPatterns = fixture === 'inconsistent.ttl'
        ? [/The ontology is inconsistent\./iu]
        : [
          /There are 1 unsatisfiable classes in the ontology\./iu,
          /https:\/\/axiolune\.ai\/test\/owl-dl\/unsatisfiable\/Impossible/iu,
        ];
      requireRejected(result, expectedPatterns);
      negativeResults.push({
        reasoner: reasoner.name,
        fixture,
        outcome: 'rejected',
        diagnosticCode,
      });
    }
    const control = execute(java, robotJar, [
      'reason',
      '--reasoner',
      reasoner.robotArgument,
      '--input',
      path.join(FIXTURE_ROOT, 'consistent.ttl'),
      '--output',
      path.join(outputRoot, `${reasoner.gateId}-consistent.owl`),
      '--equivalent-classes-allowed',
      'all',
      '--strict',
    ], `${reasoner.name} consistent control`);
    requireCleanSuccess(control);
  }

  const evidence = {
    schemaVersion: '1.0',
    profileRef: lock.profileRef,
    outcome: 'passed',
    moduleCount: modules.length,
    importedOntologyIris: ontologyIris,
    sourceArtifacts: analyses.map((analysis) => ({
      path: analysis.path,
      digest: analysis.digest,
      ontologyIri: analysis.ontologyIri,
      imports: analysis.imports,
      quadCount: analysis.quads.length,
      headerQuadCount: analysis.headerQuads.length,
      axiomQuadCount: analysis.axiomQuads.length,
    })),
    flattenedClosure: {
      path: contracts.discovery.closureConstruction.outputFileName,
      digest: sha256(flattenedFile),
      sourceQuadCount: flattened.sourceQuadCount,
      removedHeaderQuadCount: flattened.removedHeaderQuadCount,
      preDedupAxiomQuadCount: flattened.preDedupAxiomQuadCount,
      duplicateAxiomQuadCount: flattened.duplicateAxiomQuadCount,
      outputQuadCount: flattened.outputQuadCount,
    },
    toolchain: {
      toolLockPath: path.relative(SOURCE_ROOT, LOCK_FILE).split(path.sep).join('/'),
      toolLockDigest: sha256(LOCK_FILE),
      discoveryContractPath: path.relative(SOURCE_ROOT, DISCOVERY_CONTRACT_FILE).split(path.sep).join('/'),
      discoveryContractDigest: sha256(DISCOVERY_CONTRACT_FILE),
      evidenceSchemaPath: path.relative(SOURCE_ROOT, EVIDENCE_SCHEMA_FILE).split(path.sep).join('/'),
      evidenceSchemaDigest: sha256(EVIDENCE_SCHEMA_FILE),
      javaArchiveDigest: sha256(jreArchive),
      robotDigest: sha256(robotJar),
      robotVersion: lock.robot.version,
      owlApiVersion: lock.robot.owlApiVersion,
      n3Version: N3_VERSION,
      n3PackageIntegrity: n3Lock.integrity,
      nodeDependencyLockPath: 'package-lock.json',
      nodeDependencyLockDigest: sha256(NODE_DEPENDENCY_LOCK_FILE),
    },
    gates: [
      {
        gateId: 'owl-dl-profile',
        outcome: 'passed',
        negativeProfileViolation: 'rejected',
      },
      ...reasonerResults,
    ],
    negativeReasonerCorpus: negativeResults,
  };
  const evidenceFile = path.join(outputRoot, 'owl-dl-evidence.json');
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('PASS: OWL 2 DL profile + HermiT + JFact');
  console.log(`Evidence: ${evidenceFile}`);
}

if (require.main === module) {
  try {
    main();
  } catch (cause) {
    console.error(`FAIL: ${cause.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildFlattenedClosure,
  inspectOntologySource,
  requireRejected,
  validateOntologyImportDag,
  verifyExactFlattenedQuadSet,
};
