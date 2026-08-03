'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  BUNDLE_TAG,
  computeWholeFileSelectionDigest,
  fileDigest,
  u64be,
} = require('./reference-closure.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('./strict-source-locator.cjs');
const {
  decodeUtf8Lines,
  extractTextLineRangeBytes,
} = require('./text-line-range-source-extractor.cjs');
const {
  extractTarGzipMembers,
} = require('./tar-gzip-member-source-extractor.cjs');
const {
  extractPdfPageRangeBytes,
  parseRuntimeLock,
  resolveRuntimeRoot,
} = require('./pdf-page-range-runtime.cjs');
const {
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');
const {
  extractUniqueXmlElementBytes,
} = require('./reference-source-extractors.cjs');
const {
  validateSemanticReviewDecision,
} = require('./authority-decision.cjs');

const WHOLE_PROFILE = 'scripts/domain/reference-extractors/whole-file-v1.json';
const WHOLE_PROFILE_DIGEST = 'sha256:49c5d4e1c0de9f60a95ac9a1b144dc5f7fb14dd302e7da2cf26fa2cb5360d775';
const TEXT_PROFILE = 'scripts/domain/reference-extractors/text-line-range-utf8-v1.json';
const TEXT_PROFILE_DIGEST = 'sha256:c4477ead7814966979f29e2a98a32116f0b837f1b3b1850d15ce8ed1ae1afff2';
const TAR_PROFILE = 'scripts/domain/reference-extractors/tar-gzip-member-v1.json';
const TAR_PROFILE_DIGEST = 'sha256:cf21bef0a043796dd81a1e45110990e48bae4a165b043753da1f448064bf5147';
const PDF_PROFILE = 'scripts/domain/reference-extractors/pdf-page-range-pdfplumber-v1.json';
const PDF_PROFILE_DIGEST = 'sha256:0ec0292543c3930032212e96e622140cc36c7d339df3e23c8a29baac2a155c04';
const XML_PROFILE = 'scripts/domain/reference-extractors/xml-element-v1.json';
const XML_PROFILE_DIGEST = 'sha256:60051057d27aa539bea2b5488248209200b69e6824156bc90676ca4c0745d420';

const EXPECTED = Object.freeze({
  mic: {
    id: 'iso20022-mic-register-2026-07-13',
    localPath: 'reference/authority-reference/iso20022/2026-08-01/mic-register-2026-07-13',
    releaseOrCommit: 'ISO 10383 MIC register published 2026-07-13; modifications implemented 2026-07-27',
    artifactUrl: 'https://www.iso20022.org/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv',
    artifactDigest: 'sha256:1ccd0ab770db3c505db1da95bb7cc08b52d6cf42338e954cfecba07b5e7ee898',
    usageScope: 'normativeOperationalMICRegisterEvidence',
    rawDigest: 'sha256:d04443b3fc68639e0b7808bb4ad8c6b7174189f767d603dc346857a024bef61c',
    rawBytes: 492451,
    metadataDigest: 'sha256:2d7916eb70433f445ded2adfe8563fcbfe1c425c6ead7451293d7f98430114b4',
    rows: {
      header: { line: 1, digest: 'sha256:651b10a31a6ac08e3cf0d6ff3f7d09194d6ee8acacf208483e1d5c34d4f4114a' },
      XNMS: { line: 2259, digest: 'sha256:dfd1365868dbed0f9e8cf81c2341c163fa9e346336214fe4b2831067d9196f21' },
      XNAS: { line: 2260, digest: 'sha256:8517f173b8c85685dfc2cc7841fee8918f12a423e4f668215597bf10afb5e5b1' },
    },
  },
  tzdb: {
    id: 'iana-tzdb-2026c-2026-07-08',
    localPath: 'reference/authority-reference/iana/2026-08-01/tzdata2026c',
    releaseOrCommit: 'tzdb data-only release 2026c, released 2026-07-08',
    artifactUrl: 'https://data.iana.org/time-zones/releases/tzdata2026c.tar.gz',
    artifactDigest: 'sha256:c7086c3cad07d3e9409a376159c15981eae9d4bf29ed52b2c0d5bc1a27e60eeb',
    usageScope: 'normativeTimeZoneIdentifierEvidence',
    rawDigest: 'sha256:e4a178a4477f3d0ea77cc31828ff72aa38feff8d61aa13e7e99e142e9d902be4',
    rawBytes: 475694,
    metadataDigest: 'sha256:b1812946b306a2e816f6b994b889230dcdc0999fcf60c4b42daf87d8d612ee23',
    members: {
      version: { bytes: 6, digest: 'sha256:b8b066b540bc2870e6f1f3cd76f1b0e6c3629b2e3a12f14ba9e47085a1abb781' },
      'zone1970.tab': { bytes: 17596, digest: 'sha256:77b5e45415fa684fcc42de3421a6b0f15cc9b2c137f258083850346e8f76eea8' },
    },
    zones: {
      'Asia/Shanghai': { line: 130, country: 'CN', digest: 'sha256:97f23aeb2a151251f6e022aff7f95d07af5f030163e02687cc607c3dd6f38ee2' },
      'America/New_York': { line: 315, country: 'US', digest: 'sha256:725ccbe36b7ec4abd30dec6f8228f7724502ea645f687706a2c44b5768aed668' },
    },
  },
  bipm: {
    id: 'bipm-si-brochure-9-v4.01-2026-06',
    localPath: 'reference/authority-reference/bipm/2026-08-01/si-brochure-9-v4.01',
    releaseOrCommit: 'SI Brochure 9th edition, version 4.01, June 2026',
    artifactUrl: 'https://www.bipm.org/documents/d/guest/si-brochure-9-en-pdf',
    artifactDigest: 'sha256:c6005b3a2f6ab18e934e185105529ce860629ef702f32a52d49767ce42f9dcea',
    usageScope: 'contextualQuantityUnitEvidence',
    rawDigest: 'sha256:5442eea2c680caf77a9d96879205a97f57c7c270b98a0bd0126c18fefe47e02c',
    rawBytes: 1979202,
    pages: {
      22: 'sha256:f78cbae06464b489a0c500bdf0f39307ff4fd072a9c51821ef2a59b26d712b0c',
      36: 'sha256:fa6255e744f6cf3a62e56b8bed49c5a26dcac7635134deeba58448e2c14226b9',
    },
  },
  units: {
    id: 'axiolune-m2-controlled-quantity-units',
    localPath: 'reference/ontology-design-reference/axiolune-controlled-quantity-units',
    releaseOrCommit: 'M2 v0.3 controlled Quantity-unit subset candidate sha256:a0e313f0eee878e539d5424998e6d46f8abcb9a392c2dba05ca98530768fb2d4',
    artifactUrl: 'https://axiolune.ai/references/axiolune-m2-controlled-quantity-units',
    usageScope: 'candidateControlledQuantityUnitEvidence',
    candidateDigest: 'sha256:a0e313f0eee878e539d5424998e6d46f8abcb9a392c2dba05ca98530768fb2d4',
  },
  iso4217: {
    id: 'six-iso-4217-list-one-2026-01-01',
    localPath: 'reference/authority-reference/six/2026-07-31/iso-4217-list-one',
    releaseOrCommit: 'ISO 4217 List One published 2026-01-01',
    artifactUrl: 'https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml',
    artifactDigest: 'sha256:ee6fe43f5644465ea7423bd8e3045f499f3aa7651599a8a2c166c5362eda57c1',
    usageScope: 'normativeCodeListEvidence',
    retrievalDate: '2026-07-31',
    rawDigest: 'sha256:838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9',
    rawBytes: 47463,
    tableSelectionDigest: 'sha256:f9127c3e23a868fac9d342962860f28da2b93ab5477a1c7122362456227a5d2c',
    wholeSelectionDigest: 'sha256:fa2b330aaec0e30094fcb76dc259198bdcc9e84b6a4af9e3804a6ef7ef57223a',
  },
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function quantityCandidateDigest(registry) {
  const payload = {
    artifactKind: registry.artifactKind,
    candidateVersion: registry.candidateVersion,
    externalContextEvidence: registry.externalContextEvidence,
    normativeScope: registry.normativeScope,
    profileRef: registry.profileRef,
    schemaVersion: registry.schemaVersion,
    units: registry.units,
  };
  return sha256(Buffer.concat([
    Buffer.from('axiolune-controlled-quantity-unit-candidate-v1\0', 'utf8'),
    Buffer.from(canonicalJcs(payload), 'utf8'),
  ]));
}

function loadLockedQuantityRegistry(rootDir) {
  const expected = EXPECTED.units;
  const registryPath = safeResolve(
    rootDir,
    `${expected.localPath}/m2-v0.3-quantity-units.json`,
  );
  const registryBytes = fs.readFileSync(registryPath);
  const rawDigest = sha256(registryBytes);
  const registry = validateQuantityRegistry(
    parseCanonicalJsonFile(registryPath, rawDigest),
  );
  invariant(
    registry.candidateDigest === expected.candidateDigest
      && quantityCandidateDigest(registry) === expected.candidateDigest,
    'Quantity-unit candidate digest drift',
  );
  return { registry, rawDigest, registryPath };
}

function oneSimpleXmlText(fragment, tag, required = true) {
  const matches = [...fragment.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gu'))];
  if (matches.length === 0 && !required) return null;
  invariant(matches.length === 1, `ISO 4217 entry requires exactly one ${tag}`);
  return matches[0][1];
}

function loadLockedIso4217Registry(rootDir) {
  const expected = EXPECTED.iso4217;
  const localRoot = safeResolve(rootDir, expected.localPath);
  invariant(computeBundleDigest(localRoot) === expected.artifactDigest, `${expected.id} bundle digest drift`);
  const xmlPath = path.join(localRoot, 'iso-4217-list-one.xml');
  const xmlBytes = fs.readFileSync(xmlPath);
  invariant(
    xmlBytes.length === expected.rawBytes && sha256(xmlBytes) === expected.rawDigest,
    'ISO 4217 List One raw bytes drift',
  );
  const tableBytes = extractUniqueXmlElementBytes(xmlBytes, 'CcyTbl');
  const tableLocator = {
    kind: 'xmlElement',
    path: 'iso-4217-list-one.xml',
    mediaType: 'application/xml',
    extractorProfileRef: profileRef(XML_PROFILE),
    extractorProfileDigest: XML_PROFILE_DIGEST,
    selectionDigest: expected.tableSelectionDigest,
    elementId: 'CcyTbl',
  };
  invariant(
    computeSelectionDigest(tableLocator, tableBytes) === expected.tableSelectionDigest,
    'ISO 4217 CcyTbl selected bytes drift',
  );
  const text = tableBytes.toString('utf8');
  const entryFragments = [...text.matchAll(/<CcyNtry>([\s\S]*?)<\/CcyNtry>/gu)]
    .map((match) => match[1]);
  invariant(entryFragments.length > 0, 'ISO 4217 CcyTbl has no currency entries');
  const entries = new Map();
  for (const fragment of entryFragments) {
    const alphaCode = oneSimpleXmlText(fragment, 'Ccy', false);
    if (alphaCode === null) continue;
    const numericCode = oneSimpleXmlText(fragment, 'CcyNbr');
    const minorUnitText = oneSimpleXmlText(fragment, 'CcyMnrUnts');
    invariant(/^[A-Z]{3}$/u.test(alphaCode), `invalid ISO 4217 alpha code ${alphaCode}`);
    invariant(/^\d{3}$/u.test(numericCode), `invalid ISO 4217 numeric code ${numericCode}`);
    invariant(/^(?:(?:0|[1-9]\d*)|N\.A\.)$/u.test(minorUnitText), `invalid ISO 4217 minor unit for ${alphaCode}`);
    const row = {
      alphaCode,
      numericCode,
      minorUnit: minorUnitText === 'N.A.' ? null : Number(minorUnitText),
    };
    const prior = entries.get(alphaCode);
    invariant(
      prior === undefined
        || (prior.numericCode === row.numericCode && prior.minorUnit === row.minorUnit),
      `inconsistent ISO 4217 rows for ${alphaCode}`,
    );
    entries.set(alphaCode, row);
  }
  invariant(entries.size > 0, 'ISO 4217 registry compilation is empty');
  return { entries, xmlPath, rawDigest: expected.rawDigest, tableLocator };
}

function safeResolve(rootDir, relativePath) {
  invariant(typeof relativePath === 'string' && relativePath.length > 0, 'path must be non-empty');
  invariant(!path.isAbsolute(relativePath) && !relativePath.includes('\\'), `unsafe relative path ${relativePath}`);
  invariant(!relativePath.split('/').some((part) => part === '' || part === '.' || part === '..'), `unsafe relative path ${relativePath}`);
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, absolute);
  invariant(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `path escapes repository: ${relativePath}`);
  return absolute;
}

function inventoryBundle(rootPath, directory = rootPath, files = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    invariant(!entry.isSymbolicLink(), `bundle contains symlink ${absolute}`);
    if (entry.isDirectory()) inventoryBundle(rootPath, absolute, files);
    else {
      invariant(entry.isFile(), `bundle contains non-regular entry ${absolute}`);
      files.push({
        absolute,
        relative: path.relative(rootPath, absolute).split(path.sep).join('/'),
      });
    }
  }
  return files;
}

function computeBundleDigest(rootPath) {
  invariant(fs.existsSync(rootPath) && fs.statSync(rootPath).isDirectory(), `bundle root is absent: ${rootPath}`);
  const files = inventoryBundle(rootPath).sort((left, right) => compareUtf8(left.relative, right.relative));
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relative = Buffer.from(file.relative, 'utf8');
    const bytes = fs.readFileSync(file.absolute);
    hash.update(u64be(relative.length));
    hash.update(relative);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function parseCanonicalJsonFile(filePath, expectedDigest) {
  const bytes = fs.readFileSync(filePath);
  invariant(sha256(bytes) === expectedDigest, `${path.basename(filePath)} raw digest drift`);
  invariant(bytes.length === 0 || bytes.at(-1) === 0x0a, `${path.basename(filePath)} must end with one LF`);
  const text = bytes.toString('utf8');
  const value = parseJsonRejectingDuplicateMembers(text);
  invariant(text === `${canonicalJcs(value)}\n`, `${path.basename(filePath)} is not canonical JCS plus one final LF`);
  return value;
}

function exactReference(lockDocument, expected) {
  const matches = (Array.isArray(lockDocument?.references) ? lockDocument.references : [])
    .filter((reference) => reference?.id === expected.id);
  invariant(matches.length === 1, `expected exactly one reference lock ${expected.id}`);
  const reference = matches[0];
  for (const field of ['localPath', 'releaseOrCommit', 'artifactUrl', 'artifactDigest', 'usageScope']) {
    invariant(reference[field] === expected[field], `${expected.id}.${field} drift`);
  }
  invariant(
    reference.retrievalDate === (expected.retrievalDate || '2026-08-01'),
    `${expected.id}.retrievalDate drift`,
  );
  invariant(Array.isArray(reference.locators) && reference.locators.length > 0, `${expected.id} has no locators`);
  return reference;
}

function profileRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function locatorMatches(reference, expectedLocator) {
  return reference.locators.filter((locator) => canonicalJcs(locator) === canonicalJcs(expectedLocator));
}

function wholeLocator(pathName, mediaType, digest) {
  return {
    kind: 'wholeFile',
    path: pathName,
    mediaType,
    extractorProfileRef: profileRef(WHOLE_PROFILE),
    extractorProfileDigest: WHOLE_PROFILE_DIGEST,
    selectionDigest: digest,
  };
}

function textLocator(pathName, mediaType, line, digest) {
  return {
    kind: 'textLineRange',
    path: pathName,
    mediaType,
    extractorProfileRef: profileRef(TEXT_PROFILE),
    extractorProfileDigest: TEXT_PROFILE_DIGEST,
    selectionDigest: digest,
    startLine: line,
    endLine: line,
  };
}

function pdfLocator(page, digest) {
  return {
    kind: 'pdfPageRange',
    path: 'SI-Brochure-9-EN-v4.01.pdf',
    mediaType: 'application/pdf',
    extractorProfileRef: profileRef(PDF_PROFILE),
    extractorProfileDigest: PDF_PROFILE_DIGEST,
    selectionDigest: digest,
    startPage: page,
    endPage: page,
  };
}

function requireLocator(reference, locator) {
  invariant(locatorMatches(reference, locator).length === 1, `${reference.id} lacks exact locator ${canonicalJcs(locator)}`);
}

function verifyWhole(rootDir, reference, localRoot, pathName, mediaType, digest) {
  const locator = wholeLocator(pathName, mediaType, digest);
  requireLocator(reference, locator);
  const actual = computeWholeFileSelectionDigest(locator, path.join(localRoot, ...pathName.split('/')));
  invariant(actual === locator.selectionDigest, `${reference.id}/${pathName} whole-file selection drift`);
}

function verifyText(reference, localRoot, pathName, mediaType, line, digest) {
  const locator = textLocator(pathName, mediaType, line, digest);
  requireLocator(reference, locator);
  const source = fs.readFileSync(path.join(localRoot, ...pathName.split('/')));
  const selected = extractTextLineRangeBytes(source, line, line);
  invariant(computeSelectionDigest(locator, selected) === digest, `${reference.id}/${pathName}:${line} selection drift`);
  return { locator, selected };
}

function assertProfile(rootDir, relativePath, expectedDigest, algorithm) {
  const absolute = safeResolve(rootDir, relativePath);
  invariant(fileDigest(absolute) === expectedDigest, `${relativePath} digest drift`);
  const profile = parseJsonRejectingDuplicateMembers(fs.readFileSync(absolute, 'utf8'));
  invariant(profile.schemaVersion === '1.0' && profile.networkAccess === false, `${relativePath} is not a network-disabled v1 profile`);
  invariant(profile.algorithm === algorithm, `${relativePath} algorithm drift`);
  if (profile.implementationRef) {
    invariant(profile.implementationRef.kind === 'path' && profile.implementationRef.root === 'sourceTree', `${relativePath} implementation ref is not source-tree bound`);
    invariant(fileDigest(safeResolve(rootDir, profile.implementationRef.path)) === profile.implementationDigest, `${relativePath} implementation digest drift`);
  }
  return profile;
}

function parseCsvRecord(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else if (character === '"' && field === '') {
      quoted = true;
    } else {
      invariant(character !== '"', 'CSV contains a quote inside an unquoted field');
      field += character;
    }
  }
  invariant(!quoted, 'CSV record has an unterminated quoted field');
  fields.push(field);
  return fields;
}

function expectNegative(label, operation) {
  let rejected = false;
  try {
    operation();
  } catch {
    rejected = true;
  }
  invariant(rejected, `${label} negative did not reject`);
}

function verifyMic(rootDir, lockDocument) {
  const expected = EXPECTED.mic;
  const reference = exactReference(lockDocument, expected);
  const localRoot = safeResolve(rootDir, expected.localPath);
  invariant(computeBundleDigest(localRoot) === expected.artifactDigest, `${expected.id} bundle digest drift`);
  assertProfile(rootDir, WHOLE_PROFILE, WHOLE_PROFILE_DIGEST, 'return-exact-input-bytes');
  assertProfile(rootDir, TEXT_PROFILE, TEXT_PROFILE_DIGEST, 'utf8-line-range-framing-v1');

  const csvPath = path.join(localRoot, 'ISO10383_MIC.csv');
  const csvBytes = fs.readFileSync(csvPath);
  invariant(csvBytes.length === expected.rawBytes && sha256(csvBytes) === expected.rawDigest, 'MIC CSV raw bytes drift');
  const sourceLock = parseCanonicalJsonFile(path.join(localRoot, 'mic-source-lock.json'), expected.metadataDigest);
  invariant(sourceLock.schemaVersion === '1.0', 'MIC source-lock schema drift');
  invariant(sourceLock.publicationDate === '2026-07-13' && sourceLock.modificationImplementationDate === '2026-07-27', 'MIC publication metadata drift');
  invariant(sourceLock.retrievalInstant === '2026-07-31T19:11:05Z', 'MIC retrieval instant drift');
  invariant(sourceLock.sourceUrl === expected.artifactUrl, 'MIC source URL drift');
  invariant(sourceLock.artifact?.rawSha256 === expected.rawDigest && sourceLock.artifact?.byteLength === expected.rawBytes, 'MIC raw binding drift');
  invariant(sourceLock.extractorProfile?.digest === TEXT_PROFILE_DIGEST
    && canonicalJcs(sourceLock.extractorProfile.ref) === canonicalJcs(profileRef(TEXT_PROFILE)), 'MIC text extractor binding drift');

  verifyWhole(rootDir, reference, localRoot, 'ISO10383_MIC.csv', 'text/csv', 'sha256:fbd9e2b4b865011f7f5d5e6c8bacebb8ec7d701fb415689df6b6b9a4fd8a85f5');
  verifyWhole(rootDir, reference, localRoot, 'mic-source-lock.json', 'application/json', 'sha256:cc5c828967a524ecd3c07d205a7e5cfa45cca415a5e7b7bfa0ee0401bfe06b5d');
  for (const row of Object.values(expected.rows)) verifyText(reference, localRoot, 'ISO10383_MIC.csv', 'text/csv', row.line, row.digest);

  const lines = decodeUtf8Lines(csvBytes);
  const header = parseCsvRecord(lines[0]);
  invariant(header.length === 17 && header[0] === 'MIC' && header[1] === 'OPERATING MIC'
    && header[2] === 'OPRT/SGMT' && header[11] === 'STATUS', 'MIC CSV header semantics drift');
  const xnms = parseCsvRecord(lines[2258]);
  const xnas = parseCsvRecord(lines[2259]);
  invariant(xnms.length === 17 && xnms[0] === 'XNMS' && xnms[1] === 'XNAS'
    && xnms[2] === 'SGMT' && xnms[11] === 'ACTIVE', 'XNMS segment row semantics drift');
  invariant(xnas.length === 17 && xnas[0] === 'XNAS' && xnas[1] === 'XNAS'
    && xnas[2] === 'OPRT' && xnas[11] === 'ACTIVE', 'XNAS operating row semantics drift');

  const lockedRow = textLocator('ISO10383_MIC.csv', 'text/csv', expected.rows.XNAS.line, expected.rows.XNAS.digest);
  const mutatedCsv = Buffer.from(csvBytes);
  const rowOffset = csvBytes.indexOf(Buffer.from('XNAS,XNAS,OPRT', 'utf8'));
  invariant(rowOffset >= 0, 'XNAS tamper probe target is absent');
  mutatedCsv[rowOffset] = 0x59;
  const mutatedSelection = extractTextLineRangeBytes(mutatedCsv, expected.rows.XNAS.line, expected.rows.XNAS.line);
  invariant(computeSelectionDigest(lockedRow, mutatedSelection) !== lockedRow.selectionDigest, 'MIC selected-byte tamper was not detected');

  const paywalled = (lockDocument.references || []).find((entry) => entry?.id === 'iso-10383');
  invariant(paywalled?.artifactDigest === 'sha256:unavailable-paywalled', 'ISO 10383 paywall boundary is not explicit');
  return [
    'MIC_REGISTER_LOCK: official current CSV, release metadata, header and XNMS/XNAS OPRT-SGMT rows replayed',
    'MIC_REGISTER_TAMPER_NEGATIVE: selected-row mutation changes the locked digest',
    'ISO_10383_PUBLIC_RA_BOUNDARY: public Registration Authority evidence is executable; paywalled standard text remains unavailable and unclaimed',
  ];
}

function verifyTzdb(rootDir, lockDocument) {
  const expected = EXPECTED.tzdb;
  const reference = exactReference(lockDocument, expected);
  const localRoot = safeResolve(rootDir, expected.localPath);
  invariant(computeBundleDigest(localRoot) === expected.artifactDigest, `${expected.id} bundle digest drift`);
  assertProfile(rootDir, WHOLE_PROFILE, WHOLE_PROFILE_DIGEST, 'return-exact-input-bytes');
  assertProfile(rootDir, TEXT_PROFILE, TEXT_PROFILE_DIGEST, 'utf8-line-range-framing-v1');
  const tarProfile = assertProfile(rootDir, TAR_PROFILE, TAR_PROFILE_DIGEST, 'gzip-rfc1952-then-ustar-regular-member-v1');

  const archivePath = path.join(localRoot, 'tzdata2026c.tar.gz');
  const archive = fs.readFileSync(archivePath);
  invariant(archive.length === expected.rawBytes && sha256(archive) === expected.rawDigest, 'tzdata2026c raw bytes drift');
  const sourceLock = parseCanonicalJsonFile(path.join(localRoot, 'tzdb-source-lock.json'), expected.metadataDigest);
  invariant(sourceLock.schemaVersion === '1.0' && sourceLock.release === '2026c'
    && sourceLock.released === '2026-07-08', 'tzdb release metadata drift');
  invariant(sourceLock.retrievalInstant === '2026-07-31T19:11:06Z', 'tzdb retrieval instant drift');
  invariant(sourceLock.sourceUrl === expected.artifactUrl, 'tzdb source URL drift');
  invariant(sourceLock.archive?.rawSha256 === expected.rawDigest && sourceLock.archive?.byteLength === expected.rawBytes, 'tzdb archive binding drift');
  invariant(sourceLock.extractorProfile?.digest === TAR_PROFILE_DIGEST
    && canonicalJcs(sourceLock.extractorProfile.ref) === canonicalJcs(profileRef(TAR_PROFILE)), 'tzdb tar extractor binding drift');
  invariant(tarProfile.maxCompressedBytes === 16777216 && tarProfile.maxExpandedBytes === 67108864, 'tzdb tar extractor bounds drift');

  const members = extractTarGzipMembers(archive, ['version', 'zone1970.tab']);
  for (const [memberPath, memberExpected] of Object.entries(expected.members)) {
    const selected = members.get(memberPath);
    const extracted = fs.readFileSync(path.join(localRoot, memberPath));
    invariant(selected.equals(extracted), `tzdb member ${memberPath} does not equal checked-in selector bytes`);
    invariant(selected.length === memberExpected.bytes && sha256(selected) === memberExpected.digest, `tzdb member ${memberPath} digest drift`);
  }
  invariant(members.get('version').toString('utf8') === '2026c\n', 'tzdb version member is not exactly 2026c');

  verifyWhole(rootDir, reference, localRoot, 'tzdata2026c.tar.gz', 'application/gzip', 'sha256:28ffe41280009700004914a421ccfe551f4bd8397bbce007b03e2f36b8a1ee7d');
  verifyWhole(rootDir, reference, localRoot, 'tzdb-source-lock.json', 'application/json', 'sha256:0c41966f370ee09374bd22230b1b03059dc37af1563d2a6acc168267dd772202');
  verifyWhole(rootDir, reference, localRoot, 'version', 'text/plain', 'sha256:4ea6c147bc450105ce38d946f90bb7c0bd1b581e957a907742443db9546c1eda');
  verifyWhole(rootDir, reference, localRoot, 'zone1970.tab', 'text/tab-separated-values', 'sha256:03c91d0c7e14dafe05e4661997f82952ace8483d1c4dd0cca8eb2e05ac78c43e');
  for (const zone of Object.values(expected.zones)) verifyText(reference, localRoot, 'zone1970.tab', 'text/tab-separated-values', zone.line, zone.digest);

  const zoneLines = decodeUtf8Lines(members.get('zone1970.tab'));
  for (const [zoneName, zone] of Object.entries(expected.zones)) {
    const columns = zoneLines[zone.line - 1].split('\t');
    invariant(columns[0] === zone.country && columns[2] === zoneName, `tzdb ${zoneName} selector semantics drift`);
  }
  const stale = (lockDocument.references || []).filter((entry) => (
    entry?.id?.includes('2026b') || entry?.releaseOrCommit?.includes('2026b')
    || entry?.artifactUrl?.includes('2026b') || entry?.localPath?.includes('2026b')
  ));
  invariant(stale.length === 0, `stale tzdb 2026b lock remains: ${stale.map((entry) => entry.id).join(', ')}`);

  const corrupted = Buffer.from(archive);
  corrupted[corrupted.length - 8] ^= 1;
  expectNegative('tzdb gzip CRC mutation', () => extractTarGzipMembers(corrupted, ['version']));
  const zoneLocator = textLocator('zone1970.tab', 'text/tab-separated-values', expected.zones['America/New_York'].line, expected.zones['America/New_York'].digest);
  const mutatedZone = Buffer.from(members.get('zone1970.tab'));
  const zoneOffset = mutatedZone.indexOf(Buffer.from('America/New_York'));
  invariant(zoneOffset >= 0, 'tzdb tamper probe target is absent');
  mutatedZone[zoneOffset] = 0x42;
  const mutatedSelection = extractTextLineRangeBytes(mutatedZone, zoneLocator.startLine, zoneLocator.endLine);
  invariant(computeSelectionDigest(zoneLocator, mutatedSelection) !== zoneLocator.selectionDigest, 'tzdb selected-line tamper was not detected');
  return [
    'IANA_TZDB_LOCK: exact 2026c data-only archive, release/retrieval metadata and archive-member bytes replayed',
    'IANA_TZDB_ZONE_SELECTORS: Asia/Shanghai and America/New_York replayed from locked zone1970.tab lines',
    'IANA_TZDB_TAMPER_NEGATIVE: gzip CRC and selected-zone mutations are rejected',
  ];
}

function validateQuantityRegistry(registry) {
  invariant(registry?.schemaVersion === '1.0'
    && registry?.artifactKind === 'axioluneControlledQuantityUnitSubset'
    && registry?.candidateVersion === '0.3.0'
    && registry?.profileRef === 'https://axiolune.ai/profiles/controlled-quantity-unit-subset/1.0', 'Quantity-unit registry header drift');
  invariant(registry.candidateDigest === EXPECTED.units.candidateDigest
    && quantityCandidateDigest(registry) === registry.candidateDigest, 'Quantity-unit candidate digest drift');
  validateSemanticReviewDecision(
    registry.decision,
    'Quantity-unit semantic review decision',
    registry.candidateDigest,
  );
  invariant(registry.normativeScope?.authorityKind === 'axioluneOperationalCandidate'
    && registry.normativeScope?.completeSiRegistry === false
    && registry.normativeScope?.scope === 'M2 Slice-A direct-unit security quotation denominators only', 'Quantity-unit scope drift');
  invariant(Array.isArray(registry.units) && registry.units.length === 1, 'Quantity-unit subset must contain exactly one reviewed unit');
  const unit = registry.units[0];
  invariant(unit.unitIri === 'https://axiolune.ai/units/share'
    && unit.notation === 'share' && unit.label === 'Share'
    && unit.controlled === true && unit.coherentUnitOneFactor === 1
    && unit.quantityKind === 'numberOfSecurityUnits'
    && unit.siStatus === 'descriptiveTermForNumberOfEntitiesNotAnSiUnit'
    && canonicalJcs(unit.allowedApplications) === canonicalJcs(['directUnitPriceQuotationDenominator']), 'reviewed share unit semantics drift');
  invariant(Array.isArray(registry.externalContextEvidence)
    && registry.externalContextEvidence.length === 1, 'Quantity-unit subset requires exactly one external context boundary');
  const context = registry.externalContextEvidence[0];
  invariant(context.referenceId === EXPECTED.bipm.id && context.assertionScope === 'contextOnly'
    && context.usage === 'contextual' && /does not define the Axiolune term share/u.test(context.statement), 'BIPM context-only boundary drift');
  invariant(canonicalJcs(context.locators) === canonicalJcs([
    { endPage: 22, kind: 'pdfPageRange', selectionDigest: EXPECTED.bipm.pages[22], startPage: 22 },
    { endPage: 36, kind: 'pdfPageRange', selectionDigest: EXPECTED.bipm.pages[36], startPage: 36 },
  ]), 'Quantity-unit BIPM locator bindings drift');
  return registry;
}

function pdfExecution(rootDir) {
  const profile = assertProfile(rootDir, PDF_PROFILE, PDF_PROFILE_DIGEST, 'pdfplumber-page-text-framing-v1');
  invariant(profile.extractorStatus === 'executable' && profile.networkAccess === false, 'PDF profile is not executable and offline');
  for (const [refField, digestField] of [
    ['implementationRef', 'implementationDigest'],
    ['executionDriverRef', 'executionDriverDigest'],
    ['runtimeLockRef', 'runtimeLockDigest'],
  ]) {
    invariant(profile[refField]?.kind === 'path' && profile[refField]?.root === 'sourceTree', `PDF ${refField} is not source-tree bound`);
    invariant(fileDigest(safeResolve(rootDir, profile[refField].path)) === profile[digestField], `PDF ${digestField} drift`);
  }
  return {
    implementationPath: safeResolve(rootDir, profile.implementationRef.path),
    lock: parseRuntimeLock(fs.readFileSync(safeResolve(rootDir, profile.runtimeLockRef.path))),
    runtimeRoot: resolveRuntimeRoot(rootDir),
  };
}

function verifyQuantityUnits(rootDir, lockDocument, positiveFixture) {
  const bipmExpected = EXPECTED.bipm;
  const unitExpected = EXPECTED.units;
  const bipmReference = exactReference(lockDocument, bipmExpected);
  const bipmRoot = safeResolve(rootDir, bipmExpected.localPath);
  const unitRoot = safeResolve(rootDir, unitExpected.localPath);
  invariant(computeBundleDigest(bipmRoot) === bipmExpected.artifactDigest, `${bipmExpected.id} bundle digest drift`);
  assertProfile(rootDir, WHOLE_PROFILE, WHOLE_PROFILE_DIGEST, 'return-exact-input-bytes');

  const pdfPath = path.join(bipmRoot, 'SI-Brochure-9-EN-v4.01.pdf');
  const pdfBytes = fs.readFileSync(pdfPath);
  invariant(pdfBytes.length === bipmExpected.rawBytes && sha256(pdfBytes) === bipmExpected.rawDigest, 'BIPM PDF raw bytes drift');
  verifyWhole(rootDir, bipmReference, bipmRoot, 'SI-Brochure-9-EN-v4.01.pdf', 'application/pdf', 'sha256:09f444e8e3bf7f9c94af6bf2b920a2ce928d645d59c855923f506422080de86b');

  const execution = pdfExecution(rootDir);
  const selectedPages = new Map();
  for (const page of [22, 36]) {
    const locator = pdfLocator(page, bipmExpected.pages[page]);
    requireLocator(bipmReference, locator);
    const selected = extractPdfPageRangeBytes({
      ...execution,
      sourcePath: pdfPath,
      startPage: page,
      endPage: page,
    });
    invariant(computeSelectionDigest(locator, selected) === locator.selectionDigest, `BIPM physical page ${page} selection drift`);
    invariant(selected.includes(Buffer.from('unit one', 'utf8'))
      && selected.includes(Buffer.from('number of entities', 'utf8')), `BIPM physical page ${page} lacks the reviewed unit-one context`);
    selectedPages.set(page, selected);
  }

  const {
    registry,
    rawDigest: registryRawDigest,
    registryPath,
  } = loadLockedQuantityRegistry(rootDir);
  const unitInventory = inventoryBundle(unitRoot);
  invariant(unitInventory.length === 1
    && unitInventory[0].relative === 'm2-v0.3-quantity-units.json', 'Quantity-unit authority bundle inventory drift');
  const currentUnitExpected = {
    ...unitExpected,
    artifactDigest: computeBundleDigest(unitRoot),
  };
  const unitReference = exactReference(lockDocument, currentUnitExpected);
  const provisionalLocator = wholeLocator(
    'm2-v0.3-quantity-units.json',
    'application/json',
    `sha256:${'0'.repeat(64)}`,
  );
  const currentSelectionDigest = computeWholeFileSelectionDigest(
    provisionalLocator,
    registryPath,
  );
  verifyWhole(
    rootDir,
    unitReference,
    unitRoot,
    'm2-v0.3-quantity-units.json',
    'application/json',
    currentSelectionDigest,
  );

  invariant(canonicalJcs(positiveFixture?.quantityUnitRegistry) === canonicalJcs([
    {
      unitIri: 'https://axiolune.ai/units/share',
      controlled: true,
      allowedApplication: 'directUnitPriceQuotationDenominator',
      registryRef: 'https://axiolune.ai/references/axiolune-m2-controlled-quantity-units',
      registryVersion: '0.3.0',
      registryCandidateDigest: unitExpected.candidateDigest,
      registryArtifactDigest: registryRawDigest,
      decisionStatus: registry.decision.status,
    },
  ]), 'Slice-A executable fixture does not consume the exact reviewed Quantity-unit subset');

  const mutatedRegistry = structuredClone(registry);
  mutatedRegistry.normativeScope.completeSiRegistry = true;
  expectNegative('Quantity-unit scope expansion', () => validateQuantityRegistry(mutatedRegistry));
  const p36Locator = pdfLocator(36, bipmExpected.pages[36]);
  const mutatedPage = Buffer.from(selectedPages.get(36));
  mutatedPage[mutatedPage.length - 1] ^= 1;
  invariant(computeSelectionDigest(p36Locator, mutatedPage) !== p36Locator.selectionDigest, 'BIPM selected-byte tamper was not detected');

  return {
    passes: [
      'QUANTITY_UNIT_REGISTRY_LOCK: exact one-unit Axiolune subset is byte-locked and consumed by the executable Slice-A fixture',
      'QUANTITY_UNIT_BIPM_BOUNDARY: physical pages 22/36 replay unit-one context without misrepresenting share as an SI unit',
      'QUANTITY_UNIT_TAMPER_NEGATIVE: scope expansion and BIPM selected-byte mutation are rejected',
    ],
    pending: registry.decision.status === 'pending' ? [
      `PENDING_QUANTITY_UNIT_SEMANTIC_REVIEW @ ${unitExpected.localPath}/m2-v0.3-quantity-units.json: exact candidate ${unitExpected.candidateDigest} (raw ${registryRawDigest}) is locked but its semantic review is not recorded`,
    ] : [],
  };
}

function verifyIso4217(rootDir, lockDocument, positiveFixture) {
  const expected = EXPECTED.iso4217;
  const reference = exactReference(lockDocument, expected);
  assertProfile(rootDir, WHOLE_PROFILE, WHOLE_PROFILE_DIGEST, 'return-exact-input-bytes');
  assertProfile(rootDir, XML_PROFILE, XML_PROFILE_DIGEST, 'select-exact-source-byte-span');
  const compiled = loadLockedIso4217Registry(rootDir);
  requireLocator(reference, compiled.tableLocator);
  verifyWhole(
    rootDir,
    reference,
    path.dirname(compiled.xmlPath),
    'iso-4217-list-one.xml',
    'application/xml',
    expected.wholeSelectionDigest,
  );
  const expectedFixtureRows = new Map([
    ['USD', { numericCode: '840', minorUnit: 2, currency: 'urn:currency:usd' }],
    ['EUR', { numericCode: '978', minorUnit: 2, currency: 'urn:currency:eur' }],
  ]);
  invariant(
    Array.isArray(positiveFixture?.currencyRegistry)
      && positiveFixture.currencyRegistry.length === expectedFixtureRows.size,
    'Slice-A fixture must carry exactly the USD/EUR registry facts consumed by the scenario',
  );
  for (const fact of positiveFixture.currencyRegistry) {
    const expectedRow = expectedFixtureRows.get(fact?.iso4217AlphaCode);
    const authorityRow = compiled.entries.get(fact?.iso4217AlphaCode);
    invariant(expectedRow !== undefined && authorityRow !== undefined, 'Slice-A fixture contains an unreviewed Currency registry fact');
    invariant(
      fact.iso4217RegistryAuthority === 'urn:authority:iso4217'
        && fact.iso4217NumericCode === expectedRow.numericCode
        && fact.iso4217MinorUnit === expectedRow.minorUnit
        && fact.iso4217EntryStatus === 'active'
        && fact.iso4217EntryCurrency === expectedRow.currency
        && fact.iso4217RegistrySourceRef
          === 'https://axiolune.ai/references/six-iso-4217-list-one-2026-01-01'
        && authorityRow.numericCode === expectedRow.numericCode
        && authorityRow.minorUnit === expectedRow.minorUnit,
      `Slice-A ${fact.iso4217AlphaCode} registry fact does not join the locked ISO 4217 entry`,
    );
  }
  const selectedTable = extractUniqueXmlElementBytes(
    fs.readFileSync(compiled.xmlPath),
    'CcyTbl',
  );
  const mutatedTable = Buffer.from(selectedTable);
  const usdOffset = mutatedTable.indexOf(Buffer.from('<Ccy>USD</Ccy>', 'utf8'));
  invariant(usdOffset >= 0, 'ISO 4217 tamper target is absent');
  mutatedTable[usdOffset + 5] = 0x58;
  invariant(
    computeSelectionDigest(compiled.tableLocator, mutatedTable)
      !== compiled.tableLocator.selectionDigest,
    'ISO 4217 selected-byte tamper was not detected',
  );
  return {
    passes: [
      'ISO4217_CURRENT_REGISTRY_LOCK: official List One bytes, CcyTbl selector and USD/EUR code/minor-unit rows replayed',
      'ISO4217_FIXTURE_JOIN: every Slice-A Currency registry fact joins the locked authority snapshot',
      'ISO4217_TAMPER_NEGATIVE: selected registry-byte mutation changes the locked digest',
    ],
    pending: [],
  };
}

function auditSliceASourceLocks({ rootDir, lockDocument, positiveFixture }) {
  const passes = [];
  const failures = [];
  const pending = [];
  const verified = {
    mic: false,
    tzdb: false,
    quantityUnit: false,
    iso4217: false,
  };
  for (const [key, label, operation] of [
    ['mic', 'MIC', () => ({ passes: verifyMic(rootDir, lockDocument), pending: [] })],
    ['tzdb', 'IANA TZDB', () => ({ passes: verifyTzdb(rootDir, lockDocument), pending: [] })],
    ['iso4217', 'ISO 4217', () => verifyIso4217(rootDir, lockDocument, positiveFixture)],
    ['quantityUnit', 'Quantity unit', () => verifyQuantityUnits(rootDir, lockDocument, positiveFixture)],
  ]) {
    try {
      const result = operation();
      passes.push(...result.passes);
      pending.push(...result.pending);
      verified[key] = true;
    } catch (error) {
      failures.push(`${label} source-lock verification failed: ${error.message}`);
    }
  }
  return { passes, failures, pending, verified };
}

module.exports = {
  EXPECTED,
  auditSliceASourceLocks,
  computeBundleDigest,
  parseCsvRecord,
  loadLockedIso4217Registry,
  loadLockedQuantityRegistry,
  quantityCandidateDigest,
  validateQuantityRegistry,
};
