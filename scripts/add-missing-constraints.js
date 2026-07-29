#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PATTERNS_FILE = path.join(__dirname, '..', 'ontology', 'meta', 'cross-domain-patterns.yaml');
const BASE_IRI = 'https://axiolune.ai/ontology/meta/patterns/constraints/';

// 8 missing constraints as dictionary entries
const CONSTRAINTS_YAML = `
  # ==================== Constraint Definitions ====================
  # Added to complete constraint closure (P0-2 fix)

  constraints:
    PublishBeforeReceive:
      iri: "${BASE_IRI}PublishBeforeReceive"
      namespace: "pattern"
      localName: "PublishBeforeReceive"
      label: "Publish Before Receive Constraint"
      definition: "validation rule ensuring that the publication timestamp of information does not occur after its reception timestamp"
      constraintType: "validation"
      formalExpression: 'publishedAt <= receivedAt OR receivedAt IS NULL'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/publishedAt"
      severity: "error"
      message: "Publication time must not be after reception time"
      note: "Allows null receivedAt for unpublished drafts; enforces causal consistency"

    ValidIntervalConsistency:
      iri: "${BASE_IRI}ValidIntervalConsistency"
      namespace: "pattern"
      localName: "ValidIntervalConsistency"
      label: "Valid Interval Consistency Constraint"
      definition: "validation rule ensuring that the start of a business validity interval does not occur after its end"
      constraintType: "validation"
      formalExpression: 'validFrom <= validTo OR validTo IS NULL'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/validFrom"
      severity: "error"
      message: "Valid interval start must not be after end"
      note: "Allows open-ended intervals (null validTo); enforces temporal coherence"

    KnowledgeIntervalConsistency:
      iri: "${BASE_IRI}KnowledgeIntervalConsistency"
      namespace: "pattern"
      localName: "KnowledgeIntervalConsistency"
      label: "Knowledge Interval Consistency Constraint"
      definition: "validation rule ensuring that the start of a knowledge time interval does not occur after its end"
      constraintType: "validation"
      formalExpression: 'knowledgeFrom <= knowledgeTo OR knowledgeTo IS NULL'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom"
      severity: "error"
      message: "Knowledge interval start must not be after end"
      note: "Allows open-ended knowledge (null knowledgeTo); critical for bi-temporal queries"

    NoFutureKnowledge:
      iri: "${BASE_IRI}NoFutureKnowledge"
      namespace: "pattern"
      localName: "NoFutureKnowledge"
      label: "No Future Knowledge Constraint"
      definition: "validation rule ensuring that knowledge acquisition time does not occur in the future relative to the current system time"
      constraintType: "validation"
      formalExpression: 'knowledgeFrom <= CURRENT_TIMESTAMP'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom"
      severity: "warning"
      message: "Knowledge time must not be in the future"
      note: "WARNING: Uses CURRENT_TIMESTAMP which makes historical replay non-deterministic; should be replaced with transaction time for reproducibility"

    ObservationBeforeRecording:
      iri: "${BASE_IRI}ObservationBeforeRecording"
      namespace: "pattern"
      localName: "ObservationBeforeRecording"
      label: "Observation Before Recording Constraint"
      definition: "validation rule ensuring that the observation timestamp does not occur after the recording timestamp"
      constraintType: "validation"
      formalExpression: 'observedAt <= recordedAt'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/observedAt"
      severity: "error"
      message: "Observation time must not be after recording time"
      note: "Used by TemporalObservation pattern; enforces causal ordering"

    ConfidenceRange:
      iri: "${BASE_IRI}ConfidenceRange"
      namespace: "pattern"
      localName: "ConfidenceRange"
      label: "Confidence Range Constraint"
      definition: "validation rule ensuring that confidence values are bounded within the closed interval from zero to one"
      constraintType: "validation"
      formalExpression: 'confidence >= 0.0 AND confidence <= 1.0'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/confidence"
      severity: "error"
      message: "Confidence must be between 0.0 and 1.0 inclusive"
      note: "Enforces probability interpretation; 0.0 = no confidence, 1.0 = certainty"

    DigestFormat:
      iri: "${BASE_IRI}DigestFormat"
      namespace: "pattern"
      localName: "DigestFormat"
      label: "Digest Format Constraint"
      definition: "validation rule ensuring that cryptographic digest values conform to the canonical format of algorithm prefix followed by colon and hexadecimal hash"
      constraintType: "validation"
      formalExpression: '^(sha256|sha512|blake3):[a-f0-9]{64,128}$'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/evidenceDigest"
      severity: "error"
      message: "Digest must be in format algorithm:hexdigest (e.g., sha256:abc123...)"
      note: "Supports sha256 (64 hex), sha512 (128 hex), blake3 (64 hex); ensures integrity verification"

    SemanticVersionFormat:
      iri: "${BASE_IRI}SemanticVersionFormat"
      namespace: "pattern"
      localName: "SemanticVersionFormat"
      label: "Semantic Version Format Constraint"
      definition: "validation rule ensuring that semantic version strings conform to the MAJOR.MINOR.PATCH specification"
      constraintType: "validation"
      formalExpression: '^\\\\d+\\\\.\\\\d+\\\\.\\\\d+$'
      targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/semanticVersion"
      severity: "error"
      message: "Semantic version must be in format MAJOR.MINOR.PATCH (e.g., 1.2.3)"
      note: "Follows SemVer 2.0.0 specification; pre-release and build metadata not currently supported"

`;

function addMissingConstraints() {
  console.log('Adding 8 missing constraint definitions to cross-domain-patterns.yaml...\n');

  let content = fs.readFileSync(PATTERNS_FILE, 'utf8');

  // Find the patterns: section
  const patternsMarker = '  patterns:';
  const patternsIndex = content.indexOf(patternsMarker);

  if (patternsIndex === -1) {
    console.error('ERROR: Could not find patterns: section');
    process.exit(1);
  }

  // Insert constraints dictionary before patterns:
  const before = content.substring(0, patternsIndex);
  const after = content.substring(patternsIndex);
  const newContent = before + CONSTRAINTS_YAML + '\n' + after;

  fs.writeFileSync(PATTERNS_FILE, newContent, 'utf8');

  console.log('✓ Added 8 constraint definitions as constraints: dictionary');
  console.log('\nAdded constraints:');
  console.log('  - PublishBeforeReceive');
  console.log('  - ValidIntervalConsistency');
  console.log('  - KnowledgeIntervalConsistency');
  console.log('  - NoFutureKnowledge');
  console.log('  - ObservationBeforeRecording');
  console.log('  - ConfidenceRange');
  console.log('  - DigestFormat');
  console.log('  - SemanticVersionFormat');

  console.log('\n✓ Constraint definition closure fix complete');
}

addMissingConstraints();
