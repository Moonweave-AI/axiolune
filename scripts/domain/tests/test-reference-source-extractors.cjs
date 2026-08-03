'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const { fileDigest } = require('../lib/reference-closure.cjs');
const {
  computeSelectionDigest,
  validateSourceLocator,
} = require('../lib/strict-source-locator.cjs');
const {
  extractJsonPointerJcsBytes,
} = require('../lib/json-pointer-source-extractor.cjs');
const {
  computeTreeDigest,
  extractPdfPageRangeBytes,
  parseRuntimeLock,
  resolveRuntimeRoot,
  verifyRuntime,
} = require('../lib/pdf-page-range-runtime.cjs');
const {
  extractRdfXmlResourceBytes,
} = require('../lib/rdf-resource-source-extractor.cjs');
const { extractUniqueXmlElementBytes } = require('../lib/reference-source-extractors.cjs');

const LOCATOR = {
  kind: 'xmlElement',
  path: 'list.xml',
  mediaType: 'application/xml',
  elementId: 'CcyTbl',
  extractorProfileRef: {
    kind: 'path',
    root: 'sourceTree',
    path: 'scripts/domain/reference-extractors/xml-element-v1.json',
  },
  extractorProfileDigest: `sha256:${'a'.repeat(64)}`,
  selectionDigest: `sha256:${'b'.repeat(64)}`,
};

test('XML element selector returns the exact original UTF-8 byte span', () => {
  const source = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><ISO_4217><CcyTbl>\n<CcyNtry>Å</CcyNtry>\n</CcyTbl></ISO_4217>',
    'utf8',
  );
  const selected = extractUniqueXmlElementBytes(source, 'CcyTbl');
  assert.equal(selected.toString('utf8'), '<CcyTbl>\n<CcyNtry>Å</CcyNtry>\n</CcyTbl>');
  const digest = computeSelectionDigest(LOCATOR, selected);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(
    digest,
    computeSelectionDigest(LOCATOR, Buffer.from(`${selected.toString('utf8')}\n`, 'utf8')),
  );
});

test('XML element selector ignores element-like text in comments, CDATA, and processing instructions', () => {
  const source = Buffer.from(
    '<?probe fake="<CcyTbl></CcyTbl>"?>'
      + '<root><!-- <CcyTbl></CcyTbl> -->'
      + '<![CDATA[<CcyTbl></CcyTbl>]]>'
      + '<CcyTbl id="real">value</CcyTbl></root>',
    'utf8',
  );
  assert.equal(
    extractUniqueXmlElementBytes(source, 'CcyTbl').toString('utf8'),
    '<CcyTbl id="real">value</CcyTbl>',
  );
});

test('XML element selector fails closed for missing, duplicate, nested, or self-closing candidates', () => {
  assert.throws(
    () => extractUniqueXmlElementBytes(Buffer.from('<root/>'), 'CcyTbl'),
    /exactly one/u,
  );
  assert.throws(
    () => extractUniqueXmlElementBytes(Buffer.from('<root><CcyTbl></CcyTbl><CcyTbl></CcyTbl></root>'), 'CcyTbl'),
    /exactly one/u,
  );
  assert.throws(
    () => extractUniqueXmlElementBytes(Buffer.from('<CcyTbl><CcyTbl></CcyTbl></CcyTbl>'), 'CcyTbl'),
    /exactly one/u,
  );
  assert.throws(
    () => extractUniqueXmlElementBytes(Buffer.from('<root><CcyTbl/></root>'), 'CcyTbl'),
    /non-self-closing/u,
  );
});

test('XML element selector rejects DTD/entity declarations and invalid UTF-8', () => {
  assert.throws(
    () => extractUniqueXmlElementBytes(
      Buffer.from('<!DOCTYPE root [<!ENTITY x "y">]><root><CcyTbl>&x;</CcyTbl></root>'),
      'CcyTbl',
    ),
    /DTD and entity/u,
  );
  assert.throws(
    () => extractUniqueXmlElementBytes(Buffer.from([0xff, 0xfe, 0x00]), 'CcyTbl'),
    /valid UTF-8/u,
  );
});

test('executable PDF profile binds the exact driver, implementation, and runtime lock', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const profilePath = path.join(
    root,
    'scripts',
    'domain',
    'reference-extractors',
    'pdf-page-range-pdfplumber-v1.json',
  );
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.equal(profile.extractorStatus, 'executable');
  assert.equal(profile.pythonVersion, '3.12.13');
  assert.equal(profile.pdfplumberVersion, '0.11.9');
  assert.equal(profile.pdfminerVersion, '20251230');
  assert.equal(
    fileDigest(path.join(root, ...profile.implementationRef.path.split('/'))),
    profile.implementationDigest,
  );
  assert.equal(
    fileDigest(path.join(root, ...profile.executionDriverRef.path.split('/'))),
    profile.executionDriverDigest,
  );
  const runtimeLockPath = path.join(root, ...profile.runtimeLockRef.path.split('/'));
  assert.equal(fileDigest(runtimeLockPath), profile.runtimeLockDigest);
  const runtimeLock = parseRuntimeLock(fs.readFileSync(runtimeLockPath));
  assert.equal(runtimeLock.python.version, profile.pythonVersion);
  assert.equal(
    runtimeLock.packages.find((entry) => entry.distribution === 'pdfplumber').version,
    profile.pdfplumberVersion,
  );
  assert.equal(
    runtimeLock.packages.find((entry) => entry.distribution === 'pdfminer-six').version,
    profile.pdfminerVersion,
  );
  assert.doesNotThrow(() => verifyRuntime(resolveRuntimeRoot(root), runtimeLock));
});

test('locked PDF page selectors execute and reproduce both DTC selection digests', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const profilePath = path.join(
    root,
    'scripts',
    'domain',
    'reference-extractors',
    'pdf-page-range-pdfplumber-v1.json',
  );
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const runtimeLock = parseRuntimeLock(fs.readFileSync(path.join(
    root,
    ...profile.runtimeLockRef.path.split('/'),
  )));
  const runtimeRoot = resolveRuntimeRoot(root);
  const pythonTree = path.join(runtimeRoot, ...runtimeLock.python.tree.path.split('/'));
  const sitePackagesTree = path.join(
    runtimeRoot,
    ...runtimeLock.sitePackagesTree.path.split('/'),
  );
  const runtimeBefore = {
    python: computeTreeDigest(pythonTree),
    sitePackages: computeTreeDigest(sitePackagesTree),
  };
  const implementationPath = path.join(root, ...profile.implementationRef.path.split('/'));
  const referenceLock = YAML.parse(fs.readFileSync(path.join(
    root,
    'docs',
    'ontology',
    'references',
    'references.lock.yaml',
  ), 'utf8'));
  const expected = [
    ['dtc-distributions-service-guide-2026-05-06', 34, 35],
    ['dtc-settlement-service-guide-2026-06-10', 10, 10],
  ];
  for (const [referenceId, startPage, endPage] of expected) {
    const reference = referenceLock.references.find((entry) => entry.id === referenceId);
    assert.ok(reference, `missing locked reference ${referenceId}`);
    const locator = reference.locators.find((entry) => entry.kind === 'pdfPageRange');
    assert.ok(locator, `missing PDF page locator for ${referenceId}`);
    assert.equal(locator.startPage, startPage);
    assert.equal(locator.endPage, endPage);
    assert.equal(locator.extractorProfileDigest, fileDigest(profilePath));
    const selected = extractPdfPageRangeBytes({
      implementationPath,
      lock: runtimeLock,
      runtimeRoot,
      sourcePath: path.join(root, reference.localPath, locator.path),
      startPage,
      endPage,
    });
    assert.equal(computeSelectionDigest(locator, selected), locator.selectionDigest);
  }
  assert.deepEqual(
    {
      python: computeTreeDigest(pythonTree),
      sitePackages: computeTreeDigest(sitePackagesTree),
    },
    runtimeBefore,
    'locked PDF extraction must not mutate either runtime tree',
  );
});

test('PDF runtime lock and tree framing reject structural and byte drift', (t) => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const runtimeLockPath = path.join(
    root,
    'scripts',
    'domain',
    'reference-extractors',
    'pdf-page-range-pdfplumber-v1.runtime-lock.json',
  );
  const runtimeLock = JSON.parse(fs.readFileSync(runtimeLockPath, 'utf8'));
  const unknown = structuredClone(runtimeLock);
  unknown.untrustedField = true;
  assert.throws(() => parseRuntimeLock(JSON.stringify(unknown)), /contain exactly/u);
  assert.throws(
    () => parseRuntimeLock('{"schemaVersion":"1.0","schemaVersion":"2.0"}'),
    /duplicate JSON member/u,
  );
  assert.throws(
    () => parseRuntimeLock(Buffer.from('\ufeff{}', 'utf8')),
    /BOM is forbidden/u,
  );
  const reordered = structuredClone(runtimeLock);
  reordered.packages.reverse();
  assert.throws(() => parseRuntimeLock(JSON.stringify(reordered)), /UTF-8 sorted/u);
  const insecure = structuredClone(runtimeLock);
  insecure.packages[0].wheel.url = 'http://files.pythonhosted.org/unlocked.whl';
  assert.throws(() => parseRuntimeLock(JSON.stringify(insecure)), /HTTPS/u);

  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'axiolune-runtime-tree-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporary, 'nested'));
  fs.writeFileSync(path.join(temporary, 'nested', 'artifact.bin'), Buffer.from([0, 1, 2, 3]));
  const before = computeTreeDigest(temporary);
  fs.writeFileSync(path.join(temporary, 'nested', 'artifact.bin'), Buffer.from([0, 1, 2, 4]));
  const after = computeTreeDigest(temporary);
  assert.equal(before.fileCount, after.fileCount);
  assert.notEqual(before.digest, after.digest);
});

test('XML profile binds the exact executable selector implementation', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const profile = JSON.parse(fs.readFileSync(path.join(
    root,
    'scripts',
    'domain',
    'reference-extractors',
    'xml-element-v1.json',
  ), 'utf8'));
  assert.equal(
    fileDigest(path.join(root, ...profile.implementationRef.path.split('/'))),
    profile.implementationDigest,
  );
});

test('JSON Pointer selector returns JCS bytes for the exact selected value', () => {
  const source = Buffer.from(
    '{"terms":[{"definition":"first"},{"definition":{"b":2,"a":"Å"}}],"a/b":{"~key":true}}',
    'utf8',
  );
  assert.equal(
    extractJsonPointerJcsBytes(source, '/terms/1/definition').toString('utf8'),
    '{"a":"Å","b":2}',
  );
  assert.equal(
    extractJsonPointerJcsBytes(source, '/a~1b/~0key').toString('utf8'),
    'true',
  );
  assert.equal(
    extractJsonPointerJcsBytes(source, '').toString('utf8'),
    '{"a/b":{"~key":true},"terms":[{"definition":"first"},{"definition":{"a":"Å","b":2}}]}',
  );
});

test('JSON Pointer selector rejects duplicate decoded keys, malformed bytes, and ambiguity', () => {
  assert.throws(
    () => extractJsonPointerJcsBytes(Buffer.from('{"a":1,"\\u0061":2}'), '/a'),
    /duplicate JSON member/u,
  );
  assert.throws(
    () => extractJsonPointerJcsBytes(Buffer.from('{"a":[1]}'), '/a/01'),
    /canonical array index/u,
  );
  assert.throws(
    () => extractJsonPointerJcsBytes(Buffer.from('{"a":[1]}'), '/a/1'),
    /outside the selected array/u,
  );
  assert.throws(
    () => extractJsonPointerJcsBytes(Buffer.from([0xff]), ''),
    /valid UTF-8/u,
  );
  assert.throws(
    () => extractJsonPointerJcsBytes(Buffer.from('{"a":"\\ud800"}'), '/a'),
    /unpaired Unicode surrogate/u,
  );
});

test('JSON Pointer profile binds its exact executable implementation', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const profile = JSON.parse(fs.readFileSync(path.join(
    root,
    'scripts',
    'domain',
    'reference-extractors',
    'json-pointer-jcs-v1.json',
  ), 'utf8'));
  assert.equal(profile.extractorStatus, 'executable');
  assert.equal(
    fileDigest(path.join(root, ...profile.implementationRef.path.split('/'))),
    profile.implementationDigest,
  );
  assert.deepEqual(
    profile.dependencies.map((dependency) => dependency.role),
    ['canonical-jcs-and-selection-digest'],
  );
  assert.equal(
    fileDigest(path.join(root, ...profile.dependencies[0].dependencyRef.path.split('/'))),
    profile.dependencies[0].dependencyDigest,
  );
});

test('RDF/XML resource selector matches expanded rdf:about and returns exact source bytes', () => {
  const resourceIri = 'https://example.test/vocab/Target';
  const source = Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE rdf:RDF [<!ENTITY vocab "https://example.test/vocab/">]>',
    '<rdf:RDF xml:base="https://example.test/"',
    ' xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
    ' xmlns:owl="http://www.w3.org/2002/07/owl#">',
    '<!-- <owl:Class rdf:about="https://example.test/vocab/Target"/> -->',
    '<owl:Class rdf:about="&vocab;Target">',
    '<rdf:value>exact</rdf:value>',
    '</owl:Class>',
    '</rdf:RDF>',
  ].join(''), 'utf8');
  assert.equal(
    extractRdfXmlResourceBytes(source, resourceIri).toString('utf8'),
    '<owl:Class rdf:about="&vocab;Target"><rdf:value>exact</rdf:value></owl:Class>',
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(source, resourceIri, 'https://example.test/graph'),
    /graphIri is unsupported/u,
  );
});

test('RDF/XML resource selector rejects namespace spoofing, duplicates, and unsafe entities', () => {
  const resourceIri = 'https://example.test/vocab/Target';
  const namespace = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from(`<root xmlns:fake="https://example.test/not-rdf"><item fake:about="${resourceIri}"/></root>`),
      resourceIri,
    ),
    /found 0/u,
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from(`<rdf:RDF ${namespace}><item rdf:about="${resourceIri}"/><item rdf:about="${resourceIri}"/></rdf:RDF>`),
      resourceIri,
    ),
    /found 2/u,
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from(`<!DOCTYPE rdf:RDF SYSTEM "https://attacker.test/payload.dtd"><rdf:RDF ${namespace}/>`),
      resourceIri,
    ),
    /external and parameter entities/u,
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from(`<!DOCTYPE rdf:RDF [<!ENTITY % external SYSTEM "https://attacker.test/payload.dtd">%external;]><rdf:RDF ${namespace}/>`),
      resourceIri,
    ),
    /external and parameter entities/u,
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from([
        '<!-- <!DOCTYPE root [<!ENTITY vocab "https://example.test/vocab/">]> -->',
        `<root ${namespace}><item rdf:about="&vocab;Target"/></root>`,
      ].join('')),
      resourceIri,
    ),
    /undeclared XML entity vocab/u,
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from(`<root/><!DOCTYPE root [<!ENTITY vocab "https://example.test/vocab/">]>`),
      resourceIri,
    ),
    /DOCTYPE must precede/u,
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from(`<root xmlns:xml="https://attacker.test/not-xml" ${namespace}/>`),
      resourceIri,
    ),
    /xml prefix must bind/u,
  );
  assert.throws(
    () => extractRdfXmlResourceBytes(
      Buffer.from(`<one/><two ${namespace} rdf:about="${resourceIri}"/>`),
      resourceIri,
    ),
    /exactly one document element/u,
  );
});

test('locked FIBO RightsExerciseEvent locator executes against exact bytes and returns semantic content', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const lock = YAML.parse(fs.readFileSync(path.join(
    root,
    'docs/ontology/references/references.lock.yaml',
  ), 'utf8'));
  const reference = lock.references.find((entry) => entry.id === 'fibo-local-evidence');
  const locator = reference.locators.find((entry) => (
    entry.kind === 'rdfResource'
      && entry.resourceIri === 'https://spec.edmcouncil.org/fibo/ontology/CAE/CorporateEvents/SecurityRelatedCorporateActions/RightsExerciseEvent'
  ));
  assert.ok(locator, 'exact RightsExerciseEvent locator must remain locked');
  const source = fs.readFileSync(path.join(
    root,
    reference.localPath,
    locator.path,
  ));
  const selected = extractRdfXmlResourceBytes(
    source,
    locator.resourceIri,
  );
  assert.equal(
    fileDigest(path.join(root, ...locator.extractorProfileRef.path.split('/'))),
    locator.extractorProfileDigest,
  );
  assert.deepEqual(validateSourceLocator(locator, { selectedBytes: selected }).errors, []);
  assert.equal(computeSelectionDigest(locator, selected), locator.selectionDigest);
  assert.equal(selected.length, 860);
  assert.match(selected.toString('utf8'), /^<owl:Class rdf:about=/u);
  assert.match(selected.toString('utf8'), /<skos:definition xml:lang="en">/u);
  assert.match(selected.toString('utf8'), /<cmns-av:explanatoryNote xml:lang="en">/u);
});

test('RDF/XML resource profile binds the exact executable selector implementation', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const profile = JSON.parse(fs.readFileSync(path.join(
    root,
    'scripts/domain/reference-extractors/rdf-resource-rdfxml-v1.json',
  ), 'utf8'));
  assert.equal(profile.extractorStatus, 'executable');
  assert.equal(profile.algorithm, 'rdfxml-about-resource-source-span-v1');
  assert.equal(
    fileDigest(path.join(root, ...profile.implementationRef.path.split('/'))),
    profile.implementationDigest,
  );
});
