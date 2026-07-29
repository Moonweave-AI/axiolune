#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const CORE_FILE = path.join(__dirname, '..', 'ontology', 'meta', 'core-meta-model.yaml');
const BASE_IRI = 'https://axiolune.ai/ontology/meta/patterns/attributes/';

// 15 missing pattern attributes
const MISSING_ATTRIBUTES = [
  {
    name: 'recordedAt',
    label: 'Recorded At',
    definition: 'instant in time when an observation was captured and recorded into the system',
    valueType: 'instant',
    note: 'Used by TemporalObservation pattern; distinct from knowledgeFrom which marks when platform became aware',
    alignments: [
      {
        vocabulary: 'PROV-O',
        targetIri: 'http://www.w3.org/ns/prov#generatedAtTime',
        relation: 'skos:closeMatch'
      }
    ]
  },
  {
    name: 'evidenceType',
    label: 'Evidence Type',
    definition: 'categorical classification of the kind of evidence supporting a claim or assertion',
    valueType: 'string',
    note: 'Enumerated values: document, measurement, testimony, calculation, inference, etc.',
    alignments: []
  },
  {
    name: 'evidenceRef',
    label: 'Evidence Reference',
    definition: 'globally unique identifier or IRI pointing to the evidence artifact that supports a claim',
    valueType: 'uri',
    note: 'Must be resolvable to the actual evidence document, dataset, or record',
    alignments: [
      {
        vocabulary: 'PROV-O',
        targetIri: 'http://www.w3.org/ns/prov#hadPrimarySource',
        relation: 'skos:closeMatch'
      }
    ]
  },
  {
    name: 'evidenceDigest',
    label: 'Evidence Digest',
    definition: 'cryptographic hash of the evidence artifact ensuring integrity and enabling tamper detection',
    valueType: 'string',
    note: 'Format: algorithm:hexdigest (e.g., sha256:abc123...); validated by DigestFormat constraint',
    alignments: []
  },
  {
    name: 'evidenceTimestamp',
    label: 'Evidence Timestamp',
    definition: 'instant in time when the evidence was captured or created',
    valueType: 'instant',
    note: 'Distinct from the timestamp of the claim itself; records provenance of supporting evidence',
    alignments: [
      {
        vocabulary: 'PROV-O',
        targetIri: 'http://www.w3.org/ns/prov#generatedAtTime',
        relation: 'skos:relatedMatch'
      }
    ]
  },
  {
    name: 'evidenceDescription',
    label: 'Evidence Description',
    definition: 'human-readable narrative explaining the nature and relevance of the evidence',
    valueType: 'string',
    note: 'Should describe what the evidence shows and why it supports the claim',
    alignments: []
  },
  {
    name: 'lifecycleState',
    label: 'Lifecycle State',
    definition: 'enumerated value representing the current stage in the lifecycle of an entity or fact',
    valueType: 'string',
    note: 'Common states: draft, active, deprecated, superseded, retired',
    alignments: []
  },
  {
    name: 'lifecycleVersion',
    label: 'Lifecycle Version',
    definition: 'non-negative integer tracking the number of lifecycle state transitions',
    valueType: 'integer',
    note: 'Increments on each state change; enables audit trail of lifecycle evolution',
    alignments: []
  },
  {
    name: 'createdAt',
    label: 'Created At',
    definition: 'instant in time when an entity was first created in the system',
    valueType: 'instant',
    note: 'Immutable; distinct from validFrom (business time) and knowledgeFrom (epistemology time)',
    alignments: [
      {
        vocabulary: 'Dublin Core',
        targetIri: 'http://purl.org/dc/terms/created',
        relation: 'skos:exactMatch'
      }
    ]
  },
  {
    name: 'updatedAt',
    label: 'Updated At',
    definition: 'instant in time when an entity was last modified',
    valueType: 'instant',
    note: 'Updated on each mutation; tracks technical modification time, not business validity time',
    alignments: [
      {
        vocabulary: 'Dublin Core',
        targetIri: 'http://purl.org/dc/terms/modified',
        relation: 'skos:exactMatch'
      }
    ]
  },
  {
    name: 'deprecatedAt',
    label: 'Deprecated At',
    definition: 'instant in time when an entity was marked as deprecated',
    valueType: 'instant',
    note: 'Optional; null if entity is not deprecated',
    alignments: []
  },
  {
    name: 'semanticVersion',
    label: 'Semantic Version',
    definition: 'string conforming to semantic versioning specification (MAJOR.MINOR.PATCH) indicating compatibility level',
    valueType: 'string',
    note: 'Pattern: ^\\d+\\.\\d+\\.\\d+$; validated by SemanticVersionFormat constraint',
    alignments: [
      {
        vocabulary: 'SemVer',
        targetIri: 'https://semver.org/spec/v2.0.0.html',
        relation: 'skos:exactMatch'
      }
    ]
  },
  {
    name: 'versionedIri',
    label: 'Versioned IRI',
    definition: 'globally unique IRI that includes version information, enabling precise identification of versioned resources',
    valueType: 'uri',
    note: 'Typically baseIri + localName + version separator + semanticVersion',
    alignments: [
      {
        vocabulary: 'OWL',
        targetIri: 'http://www.w3.org/2002/07/owl#versionIRI',
        relation: 'skos:exactMatch'
      }
    ]
  },
  {
    name: 'priorVersion',
    label: 'Prior Version',
    definition: 'IRI reference to the immediately preceding version of this entity',
    valueType: 'uri',
    note: 'Forms a linked version chain; null for initial version',
    alignments: [
      {
        vocabulary: 'OWL',
        targetIri: 'http://www.w3.org/2002/07/owl#priorVersion',
        relation: 'skos:exactMatch'
      }
    ]
  },
  {
    name: 'incompatibleWith',
    label: 'Incompatible With',
    definition: 'IRI reference to a version that this version is known to be incompatible with',
    valueType: 'uri',
    note: 'Used to declare breaking changes; multiple incompatibilities expressed via cardinality > 1',
    alignments: [
      {
        vocabulary: 'OWL',
        targetIri: 'http://www.w3.org/2002/07/owl#incompatibleWith',
        relation: 'skos:exactMatch'
      }
    ]
  }
];

function generateAttributeYAML(attr) {
  let yaml = `  ${attr.name}:\n`;
  yaml += `    iri: "${BASE_IRI}${attr.name}"\n`;
  yaml += `    namespace: "pattern"\n`;
  yaml += `    localName: "${attr.name}"\n`;
  yaml += `    label: "${attr.label}"\n`;
  yaml += `    definition: "${attr.definition}"\n`;
  yaml += `    valueType: "${attr.valueType}"\n`;
  yaml += `    owlProjectionOverride: "datatypeProperty"\n`;
  yaml += `    defaultCardinality:\n`;
  yaml += `      minCount: 0\n`;
  yaml += `      maxCount: 1\n`;

  if (attr.alignments && attr.alignments.length > 0) {
    yaml += `    alignments:\n`;
    attr.alignments.forEach(alignment => {
      yaml += `      - vocabulary: "${alignment.vocabulary}"\n`;
      yaml += `        targetIri: "${alignment.targetIri}"\n`;
      yaml += `        relation: "${alignment.relation}"\n`;
    });
  }

  if (attr.note) {
    yaml += `    note: "${attr.note}"\n`;
  }

  return yaml;
}

function addMissingAttributes() {
  console.log('Adding 15 missing pattern attributes to core-meta-model.yaml...\n');

  let content = fs.readFileSync(CORE_FILE, 'utf8');

  // Find the insertion point (after the last existing pattern attribute, before RelationTypeDefinition)
  const insertMarker = '  # ==================== Relation Type ====================';
  const insertIndex = content.indexOf(insertMarker);

  if (insertIndex === -1) {
    console.error('ERROR: Could not find insertion marker');
    process.exit(1);
  }

  // Generate all attribute definitions
  let attributesYAML = '\n  # ==================== Additional Pattern Attributes ====================\n';
  attributesYAML += '  # Added to complete pattern closure (P0-1 fix)\n\n';

  MISSING_ATTRIBUTES.forEach(attr => {
    attributesYAML += generateAttributeYAML(attr) + '\n';
  });

  // Insert before the relation types section
  const before = content.substring(0, insertIndex);
  const after = content.substring(insertIndex);
  const newContent = before + attributesYAML + after;

  fs.writeFileSync(CORE_FILE, newContent, 'utf8');

  console.log('✓ Added 15 attribute definitions');
  console.log('\nAdded attributes:');
  MISSING_ATTRIBUTES.forEach(attr => {
    console.log(`  - ${attr.name}: ${attr.label}`);
  });

  console.log('\n✓ Pattern attribute closure fix complete');
}

addMissingAttributes();
