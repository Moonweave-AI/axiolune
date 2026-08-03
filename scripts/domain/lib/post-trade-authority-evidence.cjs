'use strict';

const yaml = require('js-yaml');
const {
  CODE_LIST_AUTHORITY_FILE_NAME,
  CODE_LIST_AUTHORITY_REFERENCE_IRI,
  PENDING_SOURCE_EVIDENCE_BASE,
  REFERENCE_EVIDENCE_BASE,
  buildCodeListAuthorityIndex,
  buildReferenceEvidenceIndex,
  validateLockedSourceEvidenceRef,
} = require('./source-evidence-reference.cjs');
const { validateSourceLocator } = require('./strict-source-locator.cjs');

const MODULE_ID = 'post-trade-operations';
const SEMANTIC_TEXT_LOCATOR_KINDS = new Set([
  'htmlFragment',
  'textHeading',
  'textLineRange',
]);

const REQUIRED_REFERENCE_PROFILES = Object.freeze([
  Object.freeze({
    key: 'finra-rule-11140',
    label: 'current FINRA Rule 11140 clauses and amendment metadata',
    id: 'finra-rule-11140-2026-07-31',
    artifactUrl: 'https://www.finra.org/rules-guidance/rulebooks/finra-rules/11140',
    authority: 'Financial Industry Regulatory Authority (FINRA)',
    localPath: 'reference/authority-reference/finra/2026-07-31/rule-11140',
    minimumWholeFileLocators: 1,
    minimumSemanticLocators: 4,
    requiredLocators: Object.freeze([
      Object.freeze({
        kind: 'textLineRange',
        path: 'content.txt',
        mediaType: 'text/plain',
        startLine: 1,
        endLine: 2,
      }),
      Object.freeze({
        kind: 'textLineRange',
        path: 'content.txt',
        mediaType: 'text/plain',
        startLine: 3,
        endLine: 4,
      }),
      Object.freeze({
        kind: 'textLineRange',
        path: 'content.txt',
        mediaType: 'text/plain',
        startLine: 5,
        endLine: 6,
      }),
      Object.freeze({
        kind: 'textLineRange',
        path: 'content.txt',
        mediaType: 'text/plain',
        startLine: 7,
        endLine: 8,
      }),
      Object.freeze({
        kind: 'textLineRange',
        path: 'content.txt',
        mediaType: 'text/plain',
        startLine: 13,
        endLine: 20,
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'content.html',
        mediaType: 'text/html',
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'content.txt',
        mediaType: 'text/plain',
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'capture.json',
        mediaType: 'application/json',
      }),
    ]),
  }),
  Object.freeze({
    key: 'finra-notice-00-54',
    label: 'historical FINRA Notice 00-54 due-bill passage',
    id: 'finra-notice-00-54-2026-07-31',
    artifactUrl: 'https://www.finra.org/rules-guidance/notices/00-54',
    authority: 'Financial Industry Regulatory Authority (FINRA); originally National Association of Securities Dealers (NASD)',
    localPath: 'reference/authority-reference/finra/2026-07-31/notice-00-54',
    minimumWholeFileLocators: 1,
    minimumSemanticLocators: 1,
    requiredLocators: Object.freeze([
      Object.freeze({
        kind: 'textLineRange',
        path: 'content.txt',
        mediaType: 'text/plain',
        startLine: 17,
        endLine: 21,
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'content.html',
        mediaType: 'text/html',
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'content.txt',
        mediaType: 'text/plain',
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'capture.json',
        mediaType: 'application/json',
      }),
    ]),
  }),
  Object.freeze({
    key: 'investor-gov-ex-dividend',
    label: 'Investor.gov explanatory ex-dividend page',
    id: 'investor-gov-ex-dividend-2026-07-31',
    artifactUrl: 'https://www.investor.gov/introduction-investing/investing-basics/glossary/ex-dividend-dates-when-are-you-entitled-stock-and',
    authority: 'U.S. Securities and Exchange Commission, Office of Investor Education and Advocacy (Investor.gov)',
    localPath: 'reference/authority-reference/investor-gov/2026-07-31/ex-dividend',
    minimumWholeFileLocators: 1,
    minimumSemanticLocators: 1,
    requiredLocators: Object.freeze([
      Object.freeze({
        kind: 'textLineRange',
        path: 'content.txt',
        mediaType: 'text/plain',
        startLine: 17,
        endLine: 21,
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'content.html',
        mediaType: 'text/html',
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'content.txt',
        mediaType: 'text/plain',
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'capture.json',
        mediaType: 'application/json',
      }),
    ]),
  }),
  Object.freeze({
    key: 'dtc-distributions-service-guide',
    label: 'DTC Distributions Service Guide due-bill pages',
    id: 'dtc-distributions-service-guide-2026-05-06',
    artifactUrl: 'https://www.dtcc.com/-/media/Files/Downloads/legal/service-guides/Service-Guide-Distributions.pdf',
    authority: 'The Depository Trust Company (DTC)',
    localPath: 'reference/authority-reference/dtc/2026-07-31/distributions-service-guide',
    requiredLocators: Object.freeze([
      Object.freeze({
        kind: 'pdfPageRange',
        path: 'distributions-service-guide.pdf',
        mediaType: 'application/pdf',
        startPage: 34,
        endPage: 35,
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'distributions-service-guide.pdf',
        mediaType: 'application/pdf',
      }),
    ]),
  }),
  Object.freeze({
    key: 'dtc-settlement-service-guide',
    label: 'DTC Settlement Service Guide delivery-with-or-without-payment page',
    id: 'dtc-settlement-service-guide-2026-06-10',
    artifactUrl: 'https://www.dtcc.com/-/media/Files/Downloads/legal/service-guides/Settlement.pdf',
    authority: 'The Depository Trust Company (DTC)',
    localPath: 'reference/authority-reference/dtc/2026-07-31/settlement-service-guide',
    requiredLocators: Object.freeze([
      Object.freeze({
        kind: 'pdfPageRange',
        path: 'settlement-service-guide.pdf',
        mediaType: 'application/pdf',
        startPage: 10,
        endPage: 10,
      }),
      Object.freeze({
        kind: 'wholeFile',
        path: 'settlement-service-guide.pdf',
        mediaType: 'application/pdf',
      }),
    ]),
  }),
  Object.freeze({
    key: 'fibo-rights-exercise-event',
    label: 'FIBO RightsExerciseEvent exact RDF resource',
    id: 'fibo-local-evidence',
    artifactUrl: 'https://github.com/edmcouncil/fibo',
    localPath: 'reference/ontology-design-reference/fibo',
    requiredLocators: Object.freeze([
      Object.freeze({
        kind: 'rdfResource',
        path: 'CAE/CorporateEvents/SecurityRelatedCorporateActions.rdf',
        mediaType: 'application/rdf+xml',
        resourceIri: 'https://spec.edmcouncil.org/fibo/ontology/CAE/CorporateEvents/SecurityRelatedCorporateActions/RightsExerciseEvent',
      }),
    ]),
  }),
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function finding(code, path, message) {
  return { code, path, message };
}

function statusOf(errors, pending) {
  if (errors.length > 0) return 'fail';
  if (pending.length > 0) return 'pending';
  return 'pass';
}

function result(errors, pending, resolved, extra = {}) {
  return {
    status: statusOf(errors, pending),
    errors,
    pending,
    resolved,
    ...extra,
  };
}

function parseReferenceLockYaml(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('reference lock YAML must be non-empty text');
  }
  const document = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  if (!isPlainObject(document)) {
    throw new Error('reference lock YAML root must be an object');
  }
  return document;
}

function compilePostTradeEvidenceContext(referenceLock, authorityManifest = undefined) {
  const referenceState = buildReferenceEvidenceIndex(referenceLock);
  const authorityProvided = authorityManifest !== undefined && authorityManifest !== null;
  const authorityState = authorityProvided
    ? buildCodeListAuthorityIndex(authorityManifest, referenceState.entries)
    : {
      entries: new Map(),
      errors: [],
      decisionStatus: 'missing',
    };
  return {
    authorityProvided,
    authorityState,
    referenceState,
  };
}

function exactLocatorMatch(locator, expected) {
  if (!isPlainObject(locator)) return false;
  return Object.entries(expected).every(([key, value]) => locator[key] === value);
}

function locateReference(referenceLock, profile) {
  const references = Array.isArray(referenceLock?.references)
    ? referenceLock.references
    : [];
  if (profile.id) {
    return references.filter((reference) => isPlainObject(reference)
      && reference.id === profile.id);
  }
  return references.filter((reference) => isPlainObject(reference)
    && reference.artifactUrl === profile.artifactUrl);
}

function auditPostTradeReferenceLock(referenceLock, context = undefined) {
  const compiled = context || compilePostTradeEvidenceContext(referenceLock);
  const errors = compiled.referenceState.errors.map((message) => finding(
    'PTO_REFERENCE_LOCK_STRUCTURE',
    'docs/ontology/references/references.lock.yaml',
    message,
  ));
  const pending = [];
  const resolved = [];

  for (const profile of REQUIRED_REFERENCE_PROFILES) {
    const at = `referenceRequirements.${profile.key}`;
    const matches = locateReference(referenceLock, profile);
    if (matches.length === 0) {
      pending.push(finding(
        'PTO_REFERENCE_LOCK_PENDING',
        at,
        `${profile.label} has no exact structured reference-lock record`,
      ));
      continue;
    }
    if (matches.length !== 1) {
      errors.push(finding(
        'PTO_REFERENCE_LOCK_AMBIGUOUS',
        at,
        `${profile.label} resolves to ${matches.length} records instead of exactly one`,
      ));
      pending.push(finding(
        'PTO_REFERENCE_LOCK_PENDING',
        at,
        `${profile.label} is ambiguous and therefore unresolved`,
      ));
      continue;
    }

    const reference = matches[0];
    const reasons = [];
    let invalid = false;
    for (const field of ['artifactUrl', 'authority', 'localPath']) {
      if (profile[field] !== undefined && reference[field] !== profile[field]) {
        invalid = true;
        errors.push(finding(
          'PTO_REFERENCE_LOCK_IDENTITY',
          `${at}.${field}`,
          `must equal ${profile[field]}`,
        ));
      }
    }

    const evidenceRef = typeof reference.id === 'string'
      ? `${REFERENCE_EVIDENCE_BASE}${reference.id}`
      : undefined;
    for (const message of validateLockedSourceEvidenceRef(
      evidenceRef,
      compiled.referenceState.entries,
    )) {
      invalid = true;
      errors.push(finding(
        'PTO_REFERENCE_LOCK_INVALID',
        at,
        message,
      ));
    }

    const locators = Array.isArray(reference.locators) ? reference.locators : [];
    for (let index = 0; index < locators.length; index += 1) {
      const validation = validateSourceLocator(locators[index], {
        at: `${at}.locators[${index}]`,
      });
      for (const message of validation.errors) {
        invalid = true;
        errors.push(finding(
          'PTO_REFERENCE_LOCATOR_INVALID',
          `${at}.locators[${index}]`,
          message,
        ));
      }
    }

    for (const expected of profile.requiredLocators || []) {
      const count = locators.filter((locator) => exactLocatorMatch(locator, expected)).length;
      if (count === 0) {
        reasons.push(`missing exact ${expected.kind} locator ${JSON.stringify(expected)}`);
      } else if (count !== 1) {
        invalid = true;
        errors.push(finding(
          'PTO_REFERENCE_LOCATOR_AMBIGUOUS',
          at,
          `exact locator ${JSON.stringify(expected)} occurs ${count} times`,
        ));
      }
    }

    if (profile.minimumWholeFileLocators !== undefined) {
      const count = locators.filter((locator) => locator?.kind === 'wholeFile').length;
      if (count < profile.minimumWholeFileLocators) {
        reasons.push(`requires at least ${profile.minimumWholeFileLocators} wholeFile locator(s)`);
      }
    }
    if (profile.minimumSemanticLocators !== undefined) {
      const count = locators.filter((locator) => SEMANTIC_TEXT_LOCATOR_KINDS.has(locator?.kind)).length;
      if (count < profile.minimumSemanticLocators) {
        reasons.push(`requires at least ${profile.minimumSemanticLocators} structured semantic text locator(s)`);
      }
    }

    if (invalid || reasons.length > 0) {
      pending.push(finding(
        'PTO_REFERENCE_LOCK_PENDING',
        at,
        reasons.length > 0
          ? reasons.join('; ')
          : `${profile.label} has invalid lock or locator structure`,
      ));
    } else {
      resolved.push(profile.key);
    }
  }

  return result(errors, pending, resolved, {
    requiredCount: REQUIRED_REFERENCE_PROFILES.length,
  });
}

function unresolvedCodeList(pending, name, at, message) {
  pending.push(finding(
    'PTO_CODE_LIST_AUTHORITY_PENDING',
    at,
    `${name}: ${message}`,
  ));
}

function auditPostTradeCodeListAuthority(moduleDocument, context) {
  const errors = [];
  const pending = [];
  const resolved = [];
  const codeLists = moduleDocument?.domain?.codeLists;
  if (!isPlainObject(codeLists) || Object.keys(codeLists).length === 0) {
    errors.push(finding(
      'PTO_CODE_LIST_INVENTORY',
      'domain.codeLists',
      'Post-trade must contain a non-empty code-list map',
    ));
    return result(errors, pending, resolved, { codeListCount: 0 });
  }

  const compiled = context || compilePostTradeEvidenceContext({ references: [] });
  if (compiled.reportContextErrors !== false) {
    for (const message of compiled.referenceState.errors) {
      errors.push(finding(
        'PTO_REFERENCE_LOCK_STRUCTURE',
        'docs/ontology/references/references.lock.yaml',
        message,
      ));
    }
    if (compiled.authorityProvided) {
      for (const message of compiled.authorityState.errors) {
        errors.push(finding(
          'PTO_CODE_LIST_AUTHORITY_MANIFEST',
          CODE_LIST_AUTHORITY_FILE_NAME,
          message,
        ));
      }
    }
  }

  const names = Object.keys(codeLists)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of names) {
    const codeList = codeLists[name];
    const at = `domain.codeLists.${name}.sourceEvidenceRef`;
    const sourceEvidenceRef = codeList?.sourceEvidenceRef;
    const expectedPendingRef = `${PENDING_SOURCE_EVIDENCE_BASE}${MODULE_ID}/${name}`;

    if (sourceEvidenceRef === expectedPendingRef) {
      unresolvedCodeList(
        pending,
        name,
        at,
        'authored reference is explicitly unresolved',
      );
      continue;
    }

    if (typeof sourceEvidenceRef === 'string'
        && sourceEvidenceRef.startsWith(PENDING_SOURCE_EVIDENCE_BASE)) {
      errors.push(finding(
        'PTO_CODE_LIST_PENDING_REF_IDENTITY',
        at,
        `pending reference must equal ${expectedPendingRef}`,
      ));
      unresolvedCodeList(pending, name, at, 'pending reference identity is malformed');
      continue;
    }

    if (sourceEvidenceRef !== CODE_LIST_AUTHORITY_REFERENCE_IRI) {
      errors.push(finding(
        'PTO_CODE_LIST_EVIDENCE_REF',
        at,
        `non-pending evidence must equal ${CODE_LIST_AUTHORITY_REFERENCE_IRI}`,
      ));
      unresolvedCodeList(
        pending,
        name,
        at,
        'arbitrary non-pending evidence cannot discharge authority',
      );
      continue;
    }

    const genericErrors = validateLockedSourceEvidenceRef(
      sourceEvidenceRef,
      compiled.referenceState.entries,
    );
    if (genericErrors.length > 0) {
      for (const message of genericErrors) {
        errors.push(finding(
          'PTO_CODE_LIST_AUTHORITY_LOCK',
          at,
          message,
        ));
      }
      unresolvedCodeList(pending, name, at, 'canonical authority lock is absent or invalid');
      continue;
    }

    if (!compiled.authorityProvided) {
      unresolvedCodeList(
        pending,
        name,
        at,
        'canonical lock exists but no machine-readable authority manifest exists',
      );
      continue;
    }

    const exactErrors = validateLockedSourceEvidenceRef(
      sourceEvidenceRef,
      compiled.referenceState.entries,
      {
        authorityState: compiled.authorityState,
        codeList,
        codeListName: name,
        moduleId: MODULE_ID,
      },
    );
    if (compiled.authorityState.decisionStatus !== 'reviewed') {
      unresolvedCodeList(
        pending,
        name,
        at,
        exactErrors.join('; ') || 'authority snapshot has not completed digest-bound semantic review',
      );
      continue;
    }
    if (compiled.authorityState.errors.length > 0 || exactErrors.length > 0) {
      for (const message of exactErrors) {
        errors.push(finding(
          'PTO_CODE_LIST_AUTHORITY_MISMATCH',
          at,
          message,
        ));
      }
      unresolvedCodeList(pending, name, at, 'reviewed authority does not exactly match authored bytes');
      continue;
    }
    resolved.push(name);
  }

  return result(errors, pending, resolved, { codeListCount: names.length });
}

function auditPostTradeAuthorityEvidence({
  moduleDocument,
  referenceLock,
  authorityManifest = undefined,
}) {
  const context = compilePostTradeEvidenceContext(referenceLock, authorityManifest);
  const referenceResult = auditPostTradeReferenceLock(referenceLock, context);
  const codeListResult = auditPostTradeCodeListAuthority(moduleDocument, {
    ...context,
    reportContextErrors: false,
  });
  const errors = [
    ...context.referenceState.errors.map((message) => finding(
      'PTO_REFERENCE_LOCK_STRUCTURE',
      'docs/ontology/references/references.lock.yaml',
      message,
    )),
    ...(context.authorityProvided
      ? context.authorityState.errors.map((message) => finding(
        'PTO_CODE_LIST_AUTHORITY_MANIFEST',
        CODE_LIST_AUTHORITY_FILE_NAME,
        message,
      ))
      : []),
    ...referenceResult.errors.filter((item) => item.code !== 'PTO_REFERENCE_LOCK_STRUCTURE'),
    ...codeListResult.errors,
  ];
  const pending = [...referenceResult.pending, ...codeListResult.pending];

  const moduleApproved = moduleDocument?.module?.status === 'approved'
    || moduleDocument?.module?.governance?.status === 'approved';
  if (moduleApproved && pending.length > 0) {
    errors.push(finding(
      'PTO_APPROVED_WITH_PENDING_EVIDENCE',
      'module.status',
      `approved Post-trade module still has ${pending.length} unresolved evidence item(s)`,
    ));
  }

  return result(errors, pending, {
    codeLists: codeListResult.resolved,
    references: referenceResult.resolved,
  }, {
    authorityDecisionStatus: context.authorityState.decisionStatus,
    codeListCount: codeListResult.codeListCount,
    referenceRequirementCount: referenceResult.requiredCount,
  });
}

module.exports = {
  MODULE_ID,
  REQUIRED_REFERENCE_PROFILES,
  auditPostTradeAuthorityEvidence,
  auditPostTradeCodeListAuthority,
  auditPostTradeReferenceLock,
  compilePostTradeEvidenceContext,
  parseReferenceLockYaml,
};
