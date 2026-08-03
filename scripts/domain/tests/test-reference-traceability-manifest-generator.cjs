#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compile,
  requireCandidate,
} = require('../generate-reference-traceability-manifest.cjs');
const {
  digestCandidate: termAuthorityCandidateDigest,
} = require('../lib/term-authority.cjs');

test('reference diagnostics bind pending candidates without qualifying as canonical release traceability', () => {
  const result = compile();
  assert.equal(result.manifest.artifactKind, 'referenceSupportDiagnostics');
  assert.equal(result.manifest.releaseEvidenceEligible, false);
  const sources = result.manifest.nodes.filter((node) => node.nodeKind === 'sourceLocator');
  const candidateSources = sources.filter((node) => [
    'axiolune-m2-controlled-quantity-units',
    'axiolune-m2-controlled-vocabularies',
    'axiolune-m2-controlled-terminology',
  ].includes(node.referenceId));
  assert.equal(candidateSources.length, 3);
  const termCards = result.manifest.nodes.filter((node) => node.nodeKind === 'termCard');
  assert.equal(termCards.length, 1172);
  assert.ok(termCards.every((node) => (
    node.artifactRef.kind === 'path'
      && node.artifactRef.root === 'sourceTree'
      && node.artifactRef.path.startsWith('docs/ontology/term-cards/v0.3/direct/')
  )), 'TermCardNode must bind the real direct-card artifact, not the authority candidate');
  assert.equal(
    result.manifest.nodes.filter((node) => node.nodeKind === 'controlledIriSet').length,
    3,
    'MIC, IANA tzdb, and the exact Quantity-unit subset require distinct controlled sets',
  );
  assert.equal(
    result.manifest.nodes.filter((node) => node.nodeKind === 'alignmentDecision').length,
    7,
    'FinancialInstrument, Security, Portfolio, and additional no-alignment decisions must be traced',
  );
  assert.equal(
    result.manifest.nodes.filter((node) => node.nodeKind === 'constraintInstance').length,
    6,
    'every exact post-trade authority profile must be represented as a constraint instance',
  );
  assert.equal(result.stats.pendingCandidateCount, 0);
  assert.equal(result.stats.termCardStatus, 'accepted');
  assert.equal(result.stats.termCardReviewCount, 1172);
  assert.equal(result.stats.releaseLimitation, 'semantic-review-satisfied');
  assert.equal(result.manifest.releaseEvidenceEligible, false);
  assert.equal(result.stats.sourceLocatorCount, result.stats.lockedLocatorCount);
  assert.equal(result.stats.untracedLocatorCount, 0, 'every retained locator must have a real downstream term trace');
  assert.deepEqual(result.stats.untracedByReference, {});
  const bipmSources = sources.filter((node) => node.referenceId === 'bipm-si-brochure-9-v4.01-2026-06');
  assert.equal(bipmSources.length, 3);
  for (const source of bipmSources) {
    const outgoing = result.manifest.edges.filter((edge) => edge.fromNodeId === source.nodeId);
    assert.ok(outgoing.some((edge) => (
      edge.edgeKind === 'supportsControlledSet' && edge.assertionScope === 'contextOnly'
    )), 'BIPM evidence must remain explicit contextOnly support');
  }
  for (const referenceId of [
    'finra-notice-00-54-2026-07-31',
    'investor-gov-ex-dividend-2026-07-31',
  ]) {
    const contextualSources = sources.filter((node) => node.referenceId === referenceId);
    assert.ok(contextualSources.length > 0);
    assert.ok(contextualSources.every((source) => result.manifest.edges.some((edge) => (
      edge.fromNodeId === source.nodeId
        && edge.edgeKind === 'supportsConstraint'
        && edge.assertionScope === 'contextOnly'
    ))), `${referenceId} must remain contextOnly`);
  }
  assert.ok(result.manifest.edges.every((edge) => (
    ['normative', 'implementation', 'contextOnly'].includes(edge.assertionScope)
  )), 'every trace edge must declare its assertion scope');
  const nodesById = new Map(result.manifest.nodes.map((node) => [node.nodeId, node]));
  const fiboFinancialInstrumentSources = sources.filter((node) => (
    node.referenceId === 'fibo-local-evidence'
      && node.locator.kind === 'textLineRange'
      && node.locator.path === 'FBC/FinancialInstruments/FinancialInstruments.rdf'
  ));
  assert.equal(fiboFinancialInstrumentSources.length, 2);
  const expectedDecisionByRange = new Map([
    ['268:315', 'instruments-financial-instrument-fibo-financial-instrument'],
    ['465:481', 'instruments-security-fibo-security'],
  ]);
  for (const source of fiboFinancialInstrumentSources) {
    const decisions = result.manifest.edges
      .filter((edge) => (
        edge.fromNodeId === source.nodeId
          && edge.edgeKind === 'supportsAlignmentDecision'
      ))
      .map((edge) => nodesById.get(edge.toNodeId)?.decisionId)
      .sort();
    assert.deepEqual(
      decisions,
      [expectedDecisionByRange.get(`${source.locator.startLine}:${source.locator.endLine}`)],
      'a semantic selector must not inherit another selector\'s target from the same file',
    );
  }
  assert.ok(!JSON.stringify(result.manifest).includes('adopted'));
});

test('traceability candidate envelope supports exact semantic review and rejects loose approval', () => {
  const entries = [{}];
  const candidate = {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    snapshotVersion: '0.3.0',
    entries,
    candidateDigest: termAuthorityCandidateDigest(
      '0.3.0',
      entries,
      'https://axiolune.ai/conformance/m2/0.3.0',
    ),
    decision: {
      candidateDigest: termAuthorityCandidateDigest(
        '0.3.0',
        entries,
        'https://axiolune.ai/conformance/m2/0.3.0',
      ),
      decisionTime: '2026-08-01T00:00:00Z',
      rationale: 'Review the exact candidate bytes and recorded evidence boundaries.',
      reviewBasisRefs: ['urn:axiolune:review:m2-authority'],
      reviewerRef: 'urn:axiolune:principal:test-reviewer',
      status: 'reviewed',
    },
  };
  assert.equal(requireCandidate(candidate, 'test candidate', 'terminology'), 'reviewed');
  assert.throws(
    () => requireCandidate({
      ...candidate,
      decision: { status: 'reviewed' },
    }, 'test candidate', 'terminology'),
    /reviewed fields/u,
  );
  assert.throws(
    () => requireCandidate({
      ...candidate,
      entries: [{ drift: true }],
    }, 'test candidate', 'terminology'),
    /candidateDigest/u,
  );
});
