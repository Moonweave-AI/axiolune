#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  auditPostTradeAuthorityEvidence,
  parseReferenceLockYaml,
} = require('./lib/post-trade-authority-evidence.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_PATH = path.join(
  ROOT,
  'ontology/domain/finance/post-trade-operations/module.yaml',
);
const REFERENCE_LOCK_PATH = path.join(
  ROOT,
  'docs/ontology/references/references.lock.yaml',
);
const AUTHORITY_MANIFEST_PATH = path.join(
  ROOT,
  'reference/ontology-design-reference/axiolune-controlled-vocabularies/m2-v0.3-code-lists.json',
);

function main() {
  const moduleDocument = yaml.load(fs.readFileSync(MODULE_PATH, 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  });
  const referenceLock = parseReferenceLockYaml(
    fs.readFileSync(REFERENCE_LOCK_PATH, 'utf8'),
  );
  const authorityManifest = fs.existsSync(AUTHORITY_MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(AUTHORITY_MANIFEST_PATH, 'utf8'))
    : undefined;
  const audit = auditPostTradeAuthorityEvidence({
    moduleDocument,
    referenceLock,
    authorityManifest,
  });

  for (const item of audit.errors) {
    console.error(`FAIL ${item.code} ${item.path}: ${item.message}`);
  }
  for (const item of audit.pending) {
    console.log(`PENDING ${item.code} ${item.path}: ${item.message}`);
  }
  for (const name of audit.resolved.references) {
    console.log(`PASS PTO_REFERENCE_LOCK ${name}`);
  }
  for (const name of audit.resolved.codeLists) {
    console.log(`PASS PTO_CODE_LIST_AUTHORITY ${name}`);
  }
  console.log(
    `Post-trade authority evidence: ${audit.status.toUpperCase()} `
      + `(${audit.errors.length} failures, ${audit.pending.length} pending, `
      + `${audit.resolved.references.length}/${audit.referenceRequirementCount} reference profiles, `
      + `${audit.resolved.codeLists.length}/${audit.codeListCount} code lists resolved)`,
  );
  process.exitCode = audit.status === 'fail' ? 1 : audit.status === 'pending' ? 2 : 0;
}

try {
  main();
} catch (cause) {
  console.error(`FATAL PTO_AUTHORITY_EVIDENCE: ${cause.stack || cause.message}`);
  process.exitCode = 1;
}
