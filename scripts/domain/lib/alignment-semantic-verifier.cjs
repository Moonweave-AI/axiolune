'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { Parser } = require('n3');

const { projectOwl } = require('../generate-m2-owl.cjs');
const { canonicalJcs, validateSourceLocator } = require('./strict-source-locator.cjs');
const { extractRdfXmlResourceBytes } = require('./rdf-resource-source-extractor.cjs');

const NS = Object.freeze({
  OWL: 'http://www.w3.org/2002/07/owl#',
  RDF: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  RDFS: 'http://www.w3.org/2000/01/rdf-schema#',
  SKOS: 'http://www.w3.org/2004/02/skos/core#',
});

const RELATION_PREDICATES = Object.freeze({
  'rdfs:subClassOf': `${NS.RDFS}subClassOf`,
  'rdfs:subPropertyOf': `${NS.RDFS}subPropertyOf`,
  'owl:equivalentClass': `${NS.OWL}equivalentClass`,
  'owl:equivalentProperty': `${NS.OWL}equivalentProperty`,
  'skos:exactMatch': `${NS.SKOS}exactMatch`,
  'skos:closeMatch': `${NS.SKOS}closeMatch`,
  'skos:broadMatch': `${NS.SKOS}broadMatch`,
  'skos:narrowMatch': `${NS.SKOS}narrowMatch`,
  'skos:relatedMatch': `${NS.SKOS}relatedMatch`,
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeText(value) {
  return value.trim().replace(/[\t\n\r ]+/gu, ' ');
}

function decodeXml(value, entities) {
  const builtins = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['quot', '"'],
  ]);
  let cursor = 0;
  let result = '';
  const references = /&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z_][A-Za-z0-9_.-]*);/gu;
  for (let match = references.exec(value); match; match = references.exec(value)) {
    if (value.slice(cursor, match.index).includes('&')) {
      throw new Error('malformed XML entity reference');
    }
    result += value.slice(cursor, match.index);
    const name = match[1];
    if (name.startsWith('#x')) {
      result += String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    } else if (name.startsWith('#')) {
      result += String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    } else if (builtins.has(name)) {
      result += builtins.get(name);
    } else if (entities.has(name)) {
      result += entities.get(name);
    } else {
      throw new Error(`undeclared XML entity ${name}`);
    }
    cursor = match.index + match[0].length;
  }
  if (value.slice(cursor).includes('&')) throw new Error('malformed XML entity reference');
  return result + value.slice(cursor);
}

function parseRdfXmlEnvironment(sourceText) {
  const entities = new Map();
  for (const match of sourceText.matchAll(
    /<!ENTITY\s+([A-Za-z_][A-Za-z0-9_.-]*)\s+(?:"([^"<>]*)"|'([^'<>]*)')\s*>/gu,
  )) {
    entities.set(match[1], match[2] === undefined ? match[3] : match[2]);
  }
  const root = /<rdf:RDF\b([\s\S]*?)>/u.exec(sourceText);
  if (!root) throw new Error('RDF/XML source has no rdf:RDF document element');
  const namespaces = new Map();
  for (const match of root[1].matchAll(
    /\bxmlns(?::([A-Za-z_][A-Za-z0-9_.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/gu,
  )) {
    namespaces.set(match[1] || '', decodeXml(match[2] === undefined ? match[3] : match[2], entities));
  }
  const baseMatch = /\bxml:base\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(root[1]);
  const baseIri = baseMatch
    ? decodeXml(baseMatch[1] === undefined ? baseMatch[2] : baseMatch[1], entities)
    : null;
  return { baseIri, entities, namespaces };
}

function expandQName(qname, namespaces) {
  const colon = qname.indexOf(':');
  const prefix = colon < 0 ? '' : qname.slice(0, colon);
  const localName = colon < 0 ? qname : qname.slice(colon + 1);
  if (!namespaces.has(prefix)) throw new Error(`undeclared QName prefix ${prefix}`);
  return `${namespaces.get(prefix)}${localName}`;
}

function expandResource(value, environment) {
  const decoded = decodeXml(value, environment.entities);
  try {
    return environment.baseIri === null
      ? new URL(decoded).href
      : new URL(decoded, environment.baseIri).href;
  } catch {
    throw new Error(`cannot resolve RDF resource ${decoded}`);
  }
}

function collectElementText(block, qname, environment) {
  const escaped = qname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(
    `<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`,
    'gu',
  );
  const values = [];
  for (const match of block.matchAll(pattern)) {
    if (/<[A-Za-z_]/u.test(match[1])) {
      throw new Error(`${qname} contains nested markup outside the semantic review profile`);
    }
    values.push(normalizeText(decodeXml(match[1], environment.entities)));
  }
  return values;
}

function extractRdfXmlSemanticFacts(sourceBytes, targetIri) {
  const sourceText = sourceBytes.toString('utf8');
  const environment = parseRdfXmlEnvironment(sourceText);
  const resourceBytes = extractRdfXmlResourceBytes(sourceBytes, targetIri);
  const block = resourceBytes.toString('utf8');
  const opening = /^<([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)\b/u.exec(block);
  if (!opening) throw new Error(`target resource ${targetIri} has no typed opening element`);
  const directParentIris = [];
  for (const match of block.matchAll(
    /<rdfs:(?:subClassOf|subPropertyOf)\b[^>]*\brdf:resource\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\/>/gu,
  )) {
    directParentIris.push(expandResource(match[1] === undefined ? match[2] : match[1], environment));
  }
  directParentIris.sort(utf8Compare);
  const ontologyMaturityIris = [];
  for (const match of sourceText.matchAll(
    /<[^>\s]+:hasMaturityLevel\b[^>]*\brdf:resource\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\/>/gu,
  )) {
    ontologyMaturityIris.push(
      expandResource(match[1] === undefined ? match[2] : match[1], environment),
    );
  }
  ontologyMaturityIris.sort(utf8Compare);
  const ontologyImportIris = [];
  for (const match of sourceText.matchAll(
    /<owl:imports\b[^>]*\brdf:resource\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\/>/gu,
  )) {
    ontologyImportIris.push(
      expandResource(match[1] === undefined ? match[2] : match[1], environment),
    );
  }
  ontologyImportIris.sort(utf8Compare);
  return {
    resourceDigest: sha256(resourceBytes),
    rdfType: expandQName(opening[1], environment.namespaces),
    labels: collectElementText(block, 'rdfs:label', environment),
    definitions: collectElementText(block, 'skos:definition', environment),
    directParentIris,
    ontologyMaturityIris,
    ontologyImportIris,
    resourceByteLength: resourceBytes.length,
    selectedBytes: resourceBytes,
    sourceDigest: sha256(sourceBytes),
  };
}

function collectAlignments(moduleDocument) {
  const records = [];
  for (const [container, elements] of Object.entries(moduleDocument.domain || {})) {
    if (elements === null || typeof elements !== 'object' || Array.isArray(elements)) continue;
    for (const [key, element] of Object.entries(elements)) {
      for (const [index, alignment] of (element.alignments || []).entries()) {
        records.push({ alignment, container, element, index, key });
      }
    }
  }
  return records;
}

function quadsMatching(quads, subject, predicate, object) {
  return quads.filter((quad) => (
    quad.subject.value === subject
    && quad.predicate.value === predicate
    && quad.object.value === object
  ));
}

function incompatibleProjectionTypes(expectedType) {
  if (expectedType === `${NS.OWL}Class`) {
    return new Set([
      `${NS.RDFS}Datatype`,
      `${NS.OWL}ObjectProperty`,
      `${NS.OWL}DatatypeProperty`,
      `${NS.OWL}AnnotationProperty`,
    ]);
  }
  if (expectedType === `${NS.OWL}DatatypeProperty`) {
    return new Set([`${NS.OWL}Class`, `${NS.RDFS}Datatype`, `${NS.OWL}ObjectProperty`]);
  }
  if (expectedType === `${NS.OWL}ObjectProperty`) {
    return new Set([`${NS.OWL}Class`, `${NS.RDFS}Datatype`, `${NS.OWL}DatatypeProperty`]);
  }
  return new Set();
}

function uniqueLockLocator(reference, sourcePath, targetIri) {
  const matches = (reference.locators || []).filter((locator) => (
    locator.kind === 'rdfResource'
    && locator.path === sourcePath
    && locator.resourceIri === targetIri
  ));
  if (matches.length !== 1) {
    throw new Error(
      `${sourcePath}: expected exactly one rdfResource locator for ${targetIri} in ${reference.id}; found ${matches.length}`,
    );
  }
  return matches[0];
}

function compareExpected(errors, at, actual, expected) {
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    errors.push(`${at}: expected ${canonicalJcs(expected)}, found ${canonicalJcs(actual)}`);
  }
}

async function verifyAlignmentSemantics({
  root,
  moduleDocument,
  profile,
  referenceLock,
  sourceBytesByPath = new Map(),
  mirrorBytesByPath = new Map(),
}) {
  const errors = [];
  const reference = (referenceLock.references || []).find((entry) => entry.id === profile.referenceId);
  if (!reference) throw new Error(`reference lock has no ${profile.referenceId}`);
  const projectionBytes = await projectOwl(moduleDocument);
  const projectionQuads = new Parser().parse(projectionBytes.toString('utf8'));
  const authoredAlignments = collectAlignments(moduleDocument);
  const activeDecisionKeys = new Set();
  const decisionEvidence = [];

  for (const decision of profile.decisions || []) {
    const at = decision.decisionId;
    const local = decision.local;
    const external = decision.external;
    const element = moduleDocument.domain?.[local.container]?.[local.key];
    if (!element) {
      errors.push(`${at}: local element ${local.container}.${local.key} is missing`);
      continue;
    }
    if (element.iri !== local.iri) errors.push(`${at}: local IRI drifted to ${String(element.iri)}`);
    const sourceAbsolute = path.join(
      root,
      reference.localPath,
      external.sourcePath.split('/').join(path.sep),
    );
    const sourceBytes = sourceBytesByPath.get(external.sourcePath)
      || fs.readFileSync(sourceAbsolute);
    let targetFacts;
    try {
      targetFacts = extractRdfXmlSemanticFacts(sourceBytes, external.targetIri);
    } catch (error) {
      errors.push(`${at}: target extraction failed: ${error.message}`);
      continue;
    }
    compareExpected(errors, `${at}.external.resourceDigest`, targetFacts.resourceDigest, external.expectedResourceDigest);
    compareExpected(errors, `${at}.external.rdfType`, targetFacts.rdfType, external.expectedRdfType);
    compareExpected(
      errors,
      `${at}.external.label`,
      targetFacts.labels.length === 0 ? null : targetFacts.labels.length === 1 ? targetFacts.labels[0] : targetFacts.labels,
      external.expectedLabel,
    );
    compareExpected(
      errors,
      `${at}.external.definition`,
      targetFacts.definitions.length === 0
        ? null
        : targetFacts.definitions.length === 1 ? targetFacts.definitions[0] : targetFacts.definitions,
      external.expectedDefinition,
    );
    compareExpected(
      errors,
      `${at}.external.directParentIris`,
      targetFacts.directParentIris,
      [...external.expectedDirectParentIris].sort(utf8Compare),
    );
    compareExpected(
      errors,
      `${at}.external.ontologyMaturityIris`,
      targetFacts.ontologyMaturityIris,
      [profile.expectedTargetModuleMaturityIri],
    );
    if (external.requiredImportIri
        && !targetFacts.ontologyImportIris.includes(external.requiredImportIri)) {
      errors.push(`${at}.external: locked source does not import ${external.requiredImportIri}`);
    }

    const localTypes = projectionQuads
      .filter((quad) => quad.subject.value === local.iri && quad.predicate.value === `${NS.RDF}type`)
      .map((quad) => quad.object.value)
      .sort(utf8Compare);
    if (!localTypes.includes(local.expectedProjectionType)) {
      errors.push(`${at}: projection lacks local type ${local.expectedProjectionType}`);
    }
    for (const incompatible of incompatibleProjectionTypes(local.expectedProjectionType)) {
      if (localTypes.includes(incompatible)) errors.push(`${at}: projection also assigns incompatible type ${incompatible}`);
    }

    const matches = (element.alignments || []).filter((alignment) => (
      alignment.targetIri === external.targetIri
    ));
    let projectionTriplePresent = false;
    if (decision.outcome === 'retained-machine-reviewed') {
      const activeKey = `${local.container}\0${local.key}\0${external.targetIri}`;
      activeDecisionKeys.add(activeKey);
      if (matches.length !== 1) {
        errors.push(`${at}: expected exactly one active alignment; found ${matches.length}`);
      } else {
        const alignment = matches[0];
        compareExpected(errors, `${at}.relation`, alignment.relation, decision.relation);
        compareExpected(errors, `${at}.rationale`, alignment.rationale, decision.rationale);
        compareExpected(
          errors,
          `${at}.verification`,
          alignment.verification,
          profile.expectedInlineVerification,
        );
        compareExpected(errors, `${at}.sourceRelease`, alignment.sourceRelease, {
          vocabulary: 'FIBO',
          release: reference.releaseOrCommit,
          artifactDigest: reference.artifactDigest,
        });
        let locator;
        try {
          locator = uniqueLockLocator(reference, external.sourcePath, external.targetIri);
          compareExpected(errors, `${at}.sourceLocator`, alignment.sourceLocator, locator);
        } catch (error) {
          errors.push(`${at}: ${error.message}`);
        }
        const locatorValidation = validateSourceLocator(alignment.sourceLocator, {
          at: `${at}.sourceLocator`,
          selectedBytes: targetFacts.selectedBytes,
        });
        for (const message of locatorValidation.errors) errors.push(message);
        const predicate = RELATION_PREDICATES[decision.relation];
        if (!predicate) {
          errors.push(`${at}: unsupported reviewed relation ${String(decision.relation)}`);
        } else {
          const projectionMatches = quadsMatching(
            projectionQuads,
            local.iri,
            predicate,
            external.targetIri,
          );
          projectionTriplePresent = projectionMatches.length === 1;
          if (!projectionTriplePresent) {
            errors.push(`${at}: generated OWL contains ${projectionMatches.length} exact alignment triples`);
          }
        }
      }
      if (decision.relation === 'rdfs:subClassOf'
          && (local.expectedProjectionType !== `${NS.OWL}Class`
            || external.expectedRdfType !== `${NS.OWL}Class`)) {
        errors.push(`${at}: rdfs:subClassOf requires class-to-class projection and target evidence`);
      }
      if (decision.relation === 'rdfs:subPropertyOf'
          && local.expectedProjectionType !== external.expectedRdfType) {
        errors.push(`${at}: rdfs:subPropertyOf crosses incompatible OWL property kinds`);
      }
    } else if (decision.outcome === 'removed-unverifiable-target-semantics') {
      if (matches.length !== 0) errors.push(`${at}: rejected alignment is still authored`);
      for (const predicate of Object.values(RELATION_PREDICATES)) {
        const projectionMatches = quadsMatching(
          projectionQuads,
          local.iri,
          predicate,
          external.targetIri,
        );
        if (projectionMatches.length > 0) {
          errors.push(`${at}: rejected alignment is still present in generated OWL`);
        }
      }
      if (targetFacts.labels.length !== 0 || targetFacts.definitions.length !== 0) {
        errors.push(`${at}: removal decision requires the locked target block to lack both label and definition`);
      }
    } else {
      errors.push(`${at}: unsupported outcome ${String(decision.outcome)}`);
    }

    decisionEvidence.push({
      decisionId: decision.decisionId,
      outcome: decision.outcome,
      local: {
        container: local.container,
        key: local.key,
        iri: local.iri,
        projectedTypes: localTypes,
      },
      external: {
        targetIri: external.targetIri,
        sourcePath: external.sourcePath,
        sourceDigest: targetFacts.sourceDigest,
        resourceDigest: targetFacts.resourceDigest,
        resourceByteLength: targetFacts.resourceByteLength,
        rdfType: targetFacts.rdfType,
        labels: targetFacts.labels,
        definitions: targetFacts.definitions,
        directParentIris: targetFacts.directParentIris,
        ontologyMaturityIris: targetFacts.ontologyMaturityIris,
        ontologyImportIris: targetFacts.ontologyImportIris,
      },
      relation: decision.relation || decision.formerRelation,
      projectionTriplePresent,
      semanticBasis: decision.semanticBasis,
    });
  }

  for (const record of authoredAlignments) {
    const key = `${record.container}\0${record.key}\0${record.alignment.targetIri}`;
    if (!activeDecisionKeys.has(key)) {
      errors.push(
        `unreviewed authored alignment at ${record.container}.${record.key}.alignments[${record.index}] -> ${record.alignment.targetIri}`,
      );
    }
    if (record.container === 'identifierTypes') {
      errors.push(
        `${record.container}.${record.key}.alignments[${record.index}]: datatype-to-class/property alignment is forbidden`,
      );
    }
  }

  const mirrors = [];
  for (const [mirrorPath, mirrorBytes] of [...mirrorBytesByPath.entries()].sort((a, b) => utf8Compare(a[0], b[0]))) {
    if (!Buffer.from(mirrorBytes).equals(projectionBytes)) {
      errors.push(`${mirrorPath}: generated OWL mirror is not byte-identical to the current projection`);
    }
    mirrors.push({ path: mirrorPath, digest: sha256(mirrorBytes) });
  }

  const retainedCount = (profile.decisions || []).filter(
    (entry) => entry.outcome === 'retained-machine-reviewed',
  ).length;
  const removedCount = (profile.decisions || []).filter(
    (entry) => entry.outcome === 'removed-unverifiable-target-semantics',
  ).length;
  const moduleBytes = Buffer.from(YAML.stringify(moduleDocument, { lineWidth: 0 }), 'utf8');
  const artifact = {
    schemaVersion: '1.0',
    profileId: profile.profileId,
    modulePath: profile.modulePath,
    moduleSemanticDigest: sha256(moduleBytes),
    projectionDigest: sha256(projectionBytes),
    reference: {
      id: reference.id,
      releaseOrCommit: reference.releaseOrCommit,
      artifactDigest: reference.artifactDigest,
    },
    inlineVerification: profile.expectedInlineVerification,
    machineReview: profile.machineReview,
    summary: {
      originalDecisionCount: (profile.decisions || []).length,
      retainedMachineReviewedCount: retainedCount,
      removedUnverifiableCount: removedCount,
      currentAuthoredAlignmentCount: authoredAlignments.length,
      verificationFailureCount: errors.length,
      status: errors.length === 0 ? 'pass' : 'fail',
    },
    owlMirrors: mirrors,
    decisions: decisionEvidence,
  };
  return { artifact, errors, projectionBytes };
}

module.exports = {
  NS,
  RELATION_PREDICATES,
  collectAlignments,
  extractRdfXmlSemanticFacts,
  sha256,
  verifyAlignmentSemantics,
};
