#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const { validateSemanticReviewDecision } = require('./lib/authority-decision.cjs');
const {
  CODE_LIST_AUTHORITY_KINDS,
  CODE_LIST_AUTHORITY_REFERENCE_IRI,
  digestCandidate,
  validateImplementationEvidencePolicy,
} = require('./lib/source-evidence-reference.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FINANCE_ROOT = path.join(ROOT, 'ontology', 'domain', 'finance');
const OUTPUT = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-vocabularies',
  'm2-v0.3-code-lists.json',
);
const OVERRIDES = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'code-list-authority-overrides.json',
);
const LOCK = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const SNAPSHOT_VERSION = '0.3.0';
const SOURCE_EVIDENCE_REF = CODE_LIST_AUTHORITY_REFERENCE_IRI;
const DEFAULT_RATIONALE =
  'Axiolune v0.3 defines this exact closed member set as an internal interoperability contract. '
  + 'External standards and implementation projects may inform individual terms, but do not '
  + 'silently become authority for the complete local enumeration.';

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function discoverCodeLists() {
  const rows = [];
  const directories = fs.readdirSync(FINANCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .sort((left, right) => utf8Compare(left.name, right.name));
  for (const directory of directories) {
    const modulePath = path.join(FINANCE_ROOT, directory.name, 'module.yaml');
    if (!fs.existsSync(modulePath)) continue;
    const document = YAML.parse(fs.readFileSync(modulePath, 'utf8'));
    for (const [codeListName, definition] of Object.entries(
      document && document.domain && document.domain.codeLists
        ? document.domain.codeLists
        : {},
    )) {
      rows.push({
        moduleId: directory.name,
        codeListName,
        definition,
      });
    }
  }
  return rows.sort((left, right) => utf8Compare(
    left.definition.iri,
    right.definition.iri,
  ));
}

function readOverrides() {
  if (!fs.existsSync(OVERRIDES)) return new Map();
  const document = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
  if (!document || document.schemaVersion !== '1.0' || !Array.isArray(document.entries)) {
    throw new Error('code-list-authority-overrides.json must be schemaVersion 1.0 with entries');
  }
  const lock = YAML.parse(fs.readFileSync(LOCK, 'utf8'));
  const references = new Map((lock.references || []).map((reference) => [reference.id, reference]));
  const result = new Map();
  for (const entry of document.entries) {
    if (!entry || typeof entry.codeListIri !== 'string') {
      throw new Error('each code-list authority override requires codeListIri');
    }
    if (result.has(entry.codeListIri)) {
      throw new Error(`duplicate authority override ${entry.codeListIri}`);
    }
    const fields = Object.keys(entry).sort();
    const expected = [
      'authorityKind',
      'codeListIri',
      'rationale',
      'upstreamEvidence',
    ].sort();
    if (canonicalJcs(fields) !== canonicalJcs(expected)) {
      throw new Error(
        `override ${entry.codeListIri} fields must equal ${expected.join(', ')}`,
      );
    }
    if (!CODE_LIST_AUTHORITY_KINDS.has(entry.authorityKind)) {
      throw new Error(`override ${entry.codeListIri} has unsupported authorityKind`);
    }
    if (entry.authorityKind === 'implementationAdopted') {
      throw new Error(
        `override ${entry.codeListIri} uses prohibited implementationAdopted authority; `
        + 'implementation projects are context-only under M2-PLAN',
      );
    }
    if (typeof entry.rationale !== 'string' || entry.rationale.trim() === '') {
      throw new Error(`override ${entry.codeListIri} requires a rationale`);
    }
    if (!Array.isArray(entry.upstreamEvidence)) {
      throw new Error(`override ${entry.codeListIri} upstreamEvidence must be an array`);
    }
    const policyErrors = [];
    entry.upstreamEvidence.forEach((evidence, index) => {
      validateImplementationEvidencePolicy(
        evidence,
        references.get(evidence && evidence.referenceId),
        `override ${entry.codeListIri}.upstreamEvidence[${index}]`,
        policyErrors,
      );
    });
    if (policyErrors.length > 0) throw new Error(policyErrors.join('\n'));
    result.set(entry.codeListIri, entry);
  }
  return result;
}

function normalizeMember(member) {
  const result = {
    definition: member.definition,
    iri: member.iri,
    label: member.label,
    notation: member.notation,
  };
  if (member.deprecated !== undefined) result.deprecated = member.deprecated;
  if (member.replacedBy !== undefined) result.replacedBy = member.replacedBy;
  if (member.sourceEvidenceRef !== undefined) {
    result.sourceEvidenceRef = member.sourceEvidenceRef;
  }
  return result;
}

function compileManifest() {
  const overrides = readOverrides();
  const rows = discoverCodeLists();
  const codeListIris = new Set(rows.map((row) => row.definition.iri));
  for (const iri of overrides.keys()) {
    if (!codeListIris.has(iri)) {
      throw new Error(`orphan authority override ${iri}`);
    }
  }
  const entries = rows.map(({ moduleId, codeListName, definition }) => {
    const override = overrides.get(definition.iri);
    return {
      authorityKind: override ? override.authorityKind : 'axioluneOperational',
      codeListIri: definition.iri,
      codeListName,
      members: [...(definition.values || [])]
        .map(normalizeMember)
        .sort((left, right) => utf8Compare(left.iri, right.iri)),
      moduleId,
      rationale: override ? override.rationale : DEFAULT_RATIONALE,
      sourceEvidenceRef: SOURCE_EVIDENCE_REF,
      upstreamEvidence: override
        ? [...override.upstreamEvidence].sort((left, right) => utf8Compare(
          canonicalJcs(left),
          canonicalJcs(right),
        ))
        : [],
      version: definition.version,
    };
  });
  const candidateDigest = digestCandidate(PROFILE_REF, SNAPSHOT_VERSION, entries);
  let decision = { status: 'pending' };
  if (fs.existsSync(OUTPUT)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    if (existing.candidateDigest === candidateDigest && existing.decision) {
      validateSemanticReviewDecision(
        existing.decision,
        'code-list authority decision',
        candidateDigest,
      );
      decision = existing.decision;
    } else if (existing.decision && existing.decision.status === 'reviewed') {
      throw new Error(
        'refusing to replace a reviewed authority snapshot with a different candidate digest',
      );
    }
  }
  return {
    candidateDigest,
    decision,
    entries,
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    snapshotVersion: SNAPSHOT_VERSION,
  };
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const stdout = argv.includes('--stdout');
  const unknown = argv.filter((argument) => !['--check', '--stdout', '--write'].includes(argument));
  if (unknown.length > 0 || (write && stdout)) {
    throw new Error(
      'usage: node scripts/domain/generate-code-list-authority-manifest.cjs '
      + '[--check|--stdout|--write]',
    );
  }
  const manifest = compileManifest();
  const bytes = Buffer.from(canonicalJcs(manifest), 'utf8');
  if (stdout) {
    process.stdout.write(bytes);
    return;
  }
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, bytes);
    console.log(
      `WROTE ${path.relative(ROOT, OUTPUT).replaceAll(path.sep, '/')} `
      + `(${manifest.entries.length} code lists, ${manifest.candidateDigest}, `
      + `decision=${manifest.decision.status})`,
    );
    return;
  }
  if (!fs.existsSync(OUTPUT)) {
    console.error(`MISSING ${path.relative(ROOT, OUTPUT).replaceAll(path.sep, '/')}`);
    process.exitCode = 1;
    return;
  }
  const actual = fs.readFileSync(OUTPUT);
  if (!actual.equals(bytes)) {
    console.error(
      `DRIFT ${path.relative(ROOT, OUTPUT).replaceAll(path.sep, '/')} `
      + `(candidate=${manifest.candidateDigest})`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS code-list authority candidate (${manifest.entries.length} code lists, `
    + `${manifest.candidateDigest}, decision=${manifest.decision.status})`,
  );
}

try {
  run();
} catch (cause) {
  console.error(`FATAL code-list authority generation failed: ${cause.stack || cause.message}`);
  process.exitCode = 1;
}
