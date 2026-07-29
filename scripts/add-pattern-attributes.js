#!/usr/bin/env node
/**
 * P0-5.2: Add 13 Missing Pattern Attribute Definitions
 *
 * This script adds AttributeTypeDefinition entries for all pattern-injected
 * attributes to core-meta-model.yaml, resolving P0-5.2 blocking issue.
 */

const fs = require('fs');
const path = require('path');

const CORE_META_MODEL_PATH = path.join(__dirname, '../ontology/meta/core-meta-model.yaml');
const BASE_IRI = 'https://axiolune.ai/ontology/meta/patterns/';

// 13 pattern attributes that need AttributeTypeDefinition entries
const PATTERN_ATTRIBUTES = `
  # ==================== Pattern-Injected Attributes ====================
  # These attributes are injected by cross-domain patterns (Layer 2)
  # Defined here to provide proper AttributeTypeDefinition foundation

  # --- Bi-Temporal Attributes (TemporalFact Pattern) ---

  validFrom:
    iri: "${BASE_IRI}attributes/validFrom"
    namespace: "pattern"
    localName: "validFrom"
    label: "Valid From"
    definition: "instant in time that marks the beginning of the business validity period during which a fact is considered true in the real world"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    alignments:
      - vocabulary: "FIBO"
        targetIri: "https://spec.edmcouncil.org/fibo/ontology/FND/DatesAndTimes/FinancialDates/hasStartDate"
        relation: "skos:closeMatch"
        rationale: "Business validity start aligns with FIBO start date semantics"

  validTo:
    iri: "${BASE_IRI}attributes/validTo"
    namespace: "pattern"
    localName: "validTo"
    label: "Valid To"
    definition: "instant in time that marks the end of the business validity period during which a fact is considered true in the real world, or null if the fact remains valid indefinitely"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    alignments:
      - vocabulary: "FIBO"
        targetIri: "https://spec.edmcouncil.org/fibo/ontology/FND/DatesAndTimes/FinancialDates/hasEndDate"
        relation: "skos:closeMatch"
        rationale: "Business validity end aligns with FIBO end date semantics"

  knowledgeFrom:
    iri: "${BASE_IRI}attributes/knowledgeFrom"
    namespace: "pattern"
    localName: "knowledgeFrom"
    label: "Knowledge From"
    definition: "instant in system time when the platform began to assert a particular version of a fact as part of its knowledge base"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "Distinct from validFrom; knowledgeFrom tracks when WE learned about the fact, not when it became true in reality"
    alignments:
      - vocabulary: "PROV-O"
        targetIri: "http://www.w3.org/ns/prov#generatedAtTime"
        relation: "skos:closeMatch"
        rationale: "System knowledge time aligns with PROV entity generation time"

  knowledgeTo:
    iri: "${BASE_IRI}attributes/knowledgeTo"
    namespace: "pattern"
    localName: "knowledgeTo"
    label: "Knowledge To"
    definition: "instant in system time when the platform ceased to assert a particular version of a fact as current, either due to supersession by a newer version or explicit retraction, or null if this version remains current"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "null value indicates current version; non-null indicates superseded or retracted"

  # --- Time Auxiliary Attributes ---

  observedAt:
    iri: "${BASE_IRI}attributes/observedAt"
    namespace: "pattern"
    localName: "observedAt"
    label: "Observed At"
    definition: "instant in time when a measurement, observation, or market data reading was originally made or captured by the source system"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "Used for market data and sensor readings; semantically distinct from validFrom (observation instant vs validity period)"

  availableAt:
    iri: "${BASE_IRI}attributes/availableAt"
    namespace: "pattern"
    localName: "availableAt"
    label: "Available At"
    definition: "instant in time when data became available for consumption by trading strategies or downstream systems, accounting for processing delays, authorization checks, and embargo periods"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "Captures operational availability, not publication or reception; critical for look-ahead bias prevention"

  # --- Publication Timing Attributes ---

  publishedAt:
    iri: "${BASE_IRI}attributes/publishedAt"
    namespace: "pattern"
    localName: "publishedAt"
    label: "Published At"
    definition: "instant in time when the data provider or source system officially published or released the information"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "Source publication time; must be <= receivedAt if both present"

  receivedAt:
    iri: "${BASE_IRI}attributes/receivedAt"
    namespace: "pattern"
    localName: "receivedAt"
    label: "Received At"
    definition: "instant in time when the platform's ingestion system received the information from the external source"
    valueType: "instant"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "Platform reception time; must be >= publishedAt if both present"

  # --- Provenance Attributes (ProvenancedFact Pattern) ---

  source:
    iri: "${BASE_IRI}attributes/source"
    namespace: "pattern"
    localName: "source"
    label: "Source"
    definition: "uniform resource identifier that designates the authoritative data provider, system, or organization from which the information originated"
    valueType: "uri"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    alignments:
      - vocabulary: "PROV-O"
        targetIri: "http://www.w3.org/ns/prov#hadPrimarySource"
        relation: "skos:exactMatch"
        rationale: "Source URI maps directly to PROV primary source"

  sourceVersion:
    iri: "${BASE_IRI}attributes/sourceVersion"
    namespace: "pattern"
    localName: "sourceVersion"
    label: "Source Version"
    definition: "string identifier that denotes the version, snapshot, or release of the source system or dataset from which the information was obtained"
    valueType: "string"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "Enables reproducibility by locking to specific source snapshots"

  confidence:
    iri: "${BASE_IRI}attributes/confidence"
    namespace: "pattern"
    localName: "confidence"
    label: "Confidence Score"
    definition: "decimal number in the closed interval [0.0, 1.0] that quantifies the assessed reliability, certainty, or probability that the asserted fact is correct"
    valueType: "decimal"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    pattern: "^(0(\\.\\d+)?|1(\\.0+)?)$"
    note: "0.0 = no confidence, 1.0 = complete certainty; constraint validation enforces [0.0, 1.0] range"

  revision:
    iri: "${BASE_IRI}attributes/revision"
    namespace: "pattern"
    localName: "revision"
    label: "Revision Number"
    definition: "non-negative integer that increments monotonically with each update or correction to a fact, enabling change tracking and audit history"
    valueType: "integer"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: 1
    note: "Starts at 0 for initial version; increments by 1 for each revision"

  derivedFrom:
    iri: "${BASE_IRI}attributes/derivedFrom"
    namespace: "pattern"
    localName: "derivedFrom"
    label: "Derived From"
    definition: "list of uniform resource identifiers that reference the source facts from which this fact was computed, transformed, or inferred, establishing lineage for derived data"
    valueType: "uri"
    owlProjectionOverride: "datatypeProperty"
    defaultCardinality:
      minCount: 0
      maxCount: null
    note: "Unbounded list; used for computed facts, aggregations, and transformations to trace back to original sources"
    alignments:
      - vocabulary: "PROV-O"
        targetIri: "http://www.w3.org/ns/prov#wasDerivedFrom"
        relation: "skos:exactMatch"
        rationale: "Derivation lineage maps directly to PROV wasDerivedFrom"
`;

function addPatternAttributes() {
  console.log('Reading core-meta-model.yaml...');
  const content = fs.readFileSync(CORE_META_MODEL_PATH, 'utf8');

  // Find insertion point: after AttributeTypeDefinition section, before RelationTypeDefinition
  const insertionMarker = '  # ==================== Relation Type ====================';
  const insertionIndex = content.indexOf(insertionMarker);

  if (insertionIndex === -1) {
    throw new Error('Could not find insertion point (Relation Type section)');
  }

  console.log('Inserting 13 pattern attribute definitions...');
  const updatedContent =
    content.slice(0, insertionIndex) +
    PATTERN_ATTRIBUTES + '\n' +
    content.slice(insertionIndex);

  fs.writeFileSync(CORE_META_MODEL_PATH, updatedContent, 'utf8');
  console.log('✅ Successfully added 13 AttributeTypeDefinition entries for pattern attributes');
  console.log('   Location: Before Relation Type section in core-meta-model.yaml');
  console.log('   Base IRI:', BASE_IRI);
}

// Execute
try {
  addPatternAttributes();
  process.exit(0);
} catch (error) {
  console.error('❌ Error:', error.message);
  process.exit(1);
}
