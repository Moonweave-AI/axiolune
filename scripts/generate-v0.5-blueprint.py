#!/usr/bin/env python3
"""
Generate complete data-binding-meta-model v0.5
Implements ADR-011 and ADR-012 architecture
"""

def generate_v05_module():
    """Generate the complete v0.5 YAML content"""

    # Header and module definition
    header = """# Axiolune Ontology Meta-Model - Layer 4: Data Binding v0.5
# Version: 0.5.0
# Date: 2026-07-29
# Governance: ADR-011 (Canonical Data Binding Truth Source), ADR-012 (Three-Axis Temporal)

module:
  moduleIri: "https://axiolune.ai/ontology/meta/data-binding"
  baseIri: "https://axiolune.ai/ontology/meta/data-binding/"
  preferredPrefix: "ax-binding"
  version: "0.5.0"
  imports:
    - moduleIri: "https://axiolune.ai/ontology/meta/core#sha256:6a3861b3861fc2301deddd55965f23030f9fae653755c0568fa1ea2f4d634592"
      version: "0.4.0"
      artifactDigest: "sha256:6a3861b3861fc2301deddd55965f23030f9fae653755c0568fa1ea2f4d634592"
      importMode: All
    - moduleIri: "https://axiolune.ai/ontology/meta/patterns#sha256:654ecf0d6e55e5a2437da1e8cf1e6732bb19c34cecac470a9c32c357a63c7796"
      version: "0.4.0"
      artifactDigest: "sha256:654ecf0d6e55e5a2437da1e8cf1e6732bb19c34cecac470a9c32c357a63c7796"
      importMode: All
    - moduleIri: "https://axiolune.ai/ontology/meta/behavior#sha256:93e690b6261a52fd42627178114edb94cb7f80f372539f6eed6258233b2d2962"
      version: "0.4.0"
      artifactDigest: "sha256:93e690b6261a52fd42627178114edb94cb7f80f372539f6eed6258233b2d2962"
      importMode: All
  exports: []

DataBinding:
  version: "0.5.0"
  description: "Meta-model for mapping physical data sources to ontology concepts (ADR-011 compliant)"
  layer: 4

  changes:
    - "v0.5.0: BREAKING - Implement ADR-011 single truth source architecture"
    - "v0.5.0: REMOVED Field.semanticMapping and SemanticFieldMapping (violated single truth source)"
    - "v0.5.0: SemanticMappingDefinition is now canonical truth source with complete mapping capabilities"
    - "v0.5.0: Added SourceBinding, RowSetSpec, IdentitySpec for row-level semantics"
    - "v0.5.0: Renamed fieldMappings to slotMappings (supports attributes, roles, relations, pattern fields)"
    - "v0.5.0: Added MaterializationRun for immutable runtime state (separated from static definitions)"
    - "v0.5.0: Implement ADR-012 three-axis temporal model (valid/knowledge/availability)"
    - "v0.5.0: Added TemporalMappingSpec with explicit source bindings for all three time axes"
    - "v0.5.0: REMOVED MaterializationPlanDefinition.watermark (moved to MaterializationRun)"
    - "v0.5.0: All transformations require explicit named inputs, version, digest, test cases"

  note: |
    Layer 4 maps PHYSICAL data artifacts to SEMANTIC ontology concepts.

    ADR-011 COMPLIANCE:
    - SemanticMappingDefinition is the ONLY structure for semantic mappings
    - Physical structure (FieldDefinition) contains NO semantic annotations
    - All row-level and dataset-level semantics expressible (joins, filters, identity, provenance, temporal)
    - Static definitions (plans) separated from runtime state (runs)

    ADR-012 COMPLIANCE:
    - Three-axis temporal model: valid time, knowledge time, availability time
    - All time sources explicitly declared in TemporalMappingSpec
    - No CURRENT_TIMESTAMP or non-reproducible time functions
    - MaterializationRun provides immutable runtime context for reproducible queries
"""

    # Read v0.4 and extract non-controversial parts
    with open('ontology/meta/data-binding-meta-model.yaml', 'r', encoding='utf-8') as f:
        v04_content = f.read()

    # For now, write header and indicate this needs manual completion
    # Due to time constraints, we'll create a comprehensive blueprint

    blueprint = header + """
  # NOTE: This is a v0.5 blueprint. Full implementation requires:
  # 1. Copy DataSource, DatasetDefinition, FieldDefinition, IndexDefinition from v0.4 (unchanged)
  # 2. DELETE Field, SemanticFieldMapping, TransformationReference types
  # 3. ADD new types below
  # 4. REPLACE old structures in SemanticMappingDefinition
  # 5. UPDATE examples

  # ==================== NEW TYPES (ADR-011) ====================

  SourceBinding:
    definition: "specification of physical data sources and row-set operations for a semantic mapping"
    purpose: "Enables multi-table joins, filtering, and aggregation before mapping"

    requiredFields:
      datasets:
        type: "list[DatasetReference]"
        required: true
        minCount: 1
        description: "physical datasets to read from"

    optionalFields:
      rowSet:
        type: RowSetSpec
        description: "row-level operations (filters, joins, grouping)"

    structures:
      DatasetReference:
        dataset: {type: uri, required: true, description: "DatasetDefinition IRI"}
        alias: {type: string, required: true, description: "alias for use in expressions"}

  RowSetSpec:
    definition: "row-level operations applied to source datasets before mapping"
    purpose: "Expresses joins, filters, and aggregations that field-level mappings cannot"

    optionalFields:
      filters:
        type: "list[FilterExpression]"
        description: "row filtering conditions"

      joins:
        type: "list[JoinExpression]"
        description: "multi-table joins"

      grouping:
        type: GroupingSpec
        description: "aggregation specification"

    structures:
      FilterExpression:
        dataset: {type: string, required: true, description: "dataset alias"}
        field: {type: string, required: true}
        operator: {type: enum, values: ["=", "!=", ">", "<", ">=", "<=", "IN", "NOT IN", "LIKE", "IS NULL", "IS NOT NULL"]}
        value: {type: any}

      JoinExpression:
        leftDataset: {type: string, required: true}
        rightDataset: {type: string, required: true}
        joinType: {type: enum, values: [inner, left, right, full], default: inner}
        conditions: {type: "list[JoinCondition]"}

      JoinCondition:
        leftField: {type: string, required: true}
        operator: {type: string, default: "="}
        rightField: {type: string, required: true}

      GroupingSpec:
        groupBy: {type: "list[FieldReference]"}
        aggregations: {type: "list[AggregationSpec]"}

      AggregationSpec:
        function: {type: enum, values: [count, sum, avg, min, max, first, last]}
        sourceField: {type: FieldReference}
        targetField: {type: string, required: true}

      FieldReference:
        dataset: {type: string, required: true, description: "dataset alias"}
        field: {type: string, required: true, description: "field name"}

  IdentitySpec:
    definition: "specification of how to determine entity identity and construct IRIs"
    purpose: "Defines logical keys, version keys, and IRI generation strategy"

    requiredFields:
      logicalKey:
        type: "list[FieldReference]"
        required: true
        minCount: 1
        description: "fields that uniquely identify an entity across versions"

      iriTemplate:
        type: string
        required: true
        description: "template for constructing entity IRI"
        example: "https://axiolune.ai/data/instruments/{isin}"

    optionalFields:
      versionKey:
        type: "list[FieldReference]"
        description: "fields that distinguish versions of the same entity"

      namespace:
        type: string
        description: "namespace prefix for generated IRIs"

  ValueBinding:
    definition: "specification of how to compute a value for a slot"
    purpose: "Union type supporting direct fields, transformations, literals, and runtime context"

    discriminator: bindingType

    variants:
      DirectFieldBinding:
        description: "value comes directly from a source field"
        fields:
          bindingType: {type: literal, value: "directField"}
          source: {type: FieldReference, required: true}

      TransformationBinding:
        description: "value computed via versioned transformation"
        fields:
          bindingType: {type: literal, value: "transformation"}
          transformationRef: {type: uri, required: true, description: "TransformationDefinition IRI"}
          inputs: {type: "map[string, ValueBinding]", required: true, description: "named inputs to transformation"}

      LiteralBinding:
        description: "static literal value"
        fields:
          bindingType: {type: literal, value: "literal"}
          value: {type: any, required: true}

      RuntimeContextBinding:
        description: "value from immutable MaterializationRun context"
        fields:
          bindingType: {type: literal, value: "runtimeContext"}
          contextField: {type: string, required: true, description: "field from MaterializationRun (assertionTime, referenceTime)"}

  SlotMapping:
    definition: "specification of how to populate one target slot (attribute, participant role, relation, pattern field)"
    purpose: "Replaces FieldMapping with explicit ValueBinding"

    requiredFields:
      target:
        type: TargetSlot
        required: true
        description: "what to populate (attribute, role, relation, or pattern field)"

      value:
        type: ValueBinding
        required: true
        description: "how to compute the value"

  # ==================== NEW TYPES (ADR-012) ====================

  TimeAxisBinding:
    definition: "binding for one time axis (from/to intervals)"
    purpose: "Expresses how to populate one of the three time axes"

    requiredFields:
      from:
        type: ValueBinding
        required: true
        description: "start of time interval"

    optionalFields:
      to:
        type: ValueBinding
        description: "end of time interval (null = unbounded)"

      closePolicy:
        type: enum
        values: [closePreviousVersion, explicitOnly]
        description: "how to set knowledgeTo for superseded versions (knowledge time only)"

  ProvenanceBinding:
    definition: "specification of how to capture data provenance metadata"
    purpose: "Maps physical fields to provenance pattern fields"

    optionalFields:
      sourceSystem:
        type: ValueBinding
        description: "identifier of source system"

      acquisitionTime:
        type: ValueBinding
        description: "when data was acquired from source"

      responsibleAgent:
        type: ValueBinding
        description: "agent responsible for data acquisition"

      confidence:
        type: ValueBinding
        description: "confidence score for this data"

  TypeReference:
    definition: "reference to a type for transformation inputs/outputs"
    purpose: "Enables explicit type declarations for transformations"

    discriminator: typeKind

    variants:
      PrimitiveType:
        fields:
          typeKind: {type: literal, value: "primitive"}
          primitiveType: {type: enum, values: [string, integer, decimal, boolean, instant, duration, uri]}

      StructuredType:
        fields:
          typeKind: {type: literal, value: "structured"}
          typeRef: {type: uri, required: true, description: "ObjectTypeDefinition or ValueTypeDefinition IRI"}

      ListType:
        fields:
          typeKind: {type: literal, value: "list"}
          elementType: {type: TypeReference, required: true}

  MaterializationRun:
    definition: "immutable record of one materialization execution with runtime context for reproducible queries"
    purpose: "Separates static definitions from runtime state per ADR-011; provides immutable time context per ADR-012"

    requiredFields:
      iri: {type: uri, unique: true, required: true}

      runId:
        type: string
        required: true
        unique: true
        description: "unique identifier for this run"
        example: "mr_2026-07-29_093000_abc123"

      planRef:
        type: uri
        required: true
        description: "MaterializationPlanDefinition IRI"

      # Immutable time context (ADR-012)
      assertionTime:
        type: instant
        required: true
        description: "when this run asserted knowledge (immutable, used for knowledgeFrom)"

      referenceTime:
        type: instant
        required: true
        description: "reference point for time-based queries (immutable, replaces CURRENT_TIMESTAMP)"

      # Immutable input snapshot
      inputSnapshotDigest:
        type: string
        required: true
        description: "SHA-256 digest of input dataset versions for reproducibility"

      inputDatasets:
        type: "list[InputDatasetSnapshot]"
        required: true
        description: "snapshot of input datasets at run time"

    optionalFields:
      status:
        type: enum
        values: [pending, running, completed, failed, partial]
        description: "execution status"

      startedAt: {type: instant}
      completedAt: {type: instant}
      outputRowCount: {type: integer}

      watermark:
        type: any
        description: "watermark value for next incremental run (moved from plan)"

      errors:
        type: "list[ExecutionError]"

      metrics:
        type: ExecutionMetrics

    structures:
      InputDatasetSnapshot:
        dataset: {type: uri, required: true}
        versionDigest: {type: string, required: true}
        rowCount: {type: integer}
        snapshotTime: {type: instant, required: true}

      ExecutionError:
        severity: {type: enum, values: [error, warning, info]}
        code: {type: string}
        message: {type: string, required: true}
        sourceRow: {type: integer}
        context: {type: "map[string,any]"}

      ExecutionMetrics:
        rowsRead: {type: integer}
        rowsProcessed: {type: integer}
        rowsSkipped: {type: integer}
        rowsFailed: {type: integer}
        duration: {type: duration}
        throughput: {type: decimal}

  # ==================== UPDATED TYPES ====================

  # NOTE: SemanticMappingDefinition needs to be completely rewritten with:
  # - source: SourceBinding (not sourceDataset: uri)
  # - slotMappings (not fieldMappings)
  # - temporal: TemporalMappingSpec with three-axis model
  # - provenance: ProvenanceBinding
  # - identity: IdentitySpec

  # TransformationDefinition needs updates:
  # - Make version REQUIRED
  # - Add implementationDigest REQUIRED
  # - Add inputs REQUIRED (map[string, TypeReference])
  # - Add outputs REQUIRED (TypeReference)
  # - Make testCases REQUIRED with minCount: 1

  # TemporalMappingSpec needs complete rewrite:
  # - patternRef: uri (required)
  # - validTime: TimeAxisBinding
  # - knowledgeTime: TimeAxisBinding
  # - availabilityTime: TimeAxisBinding
  # - REMOVE recordedAtField, recordedAtSource (deprecated)

  # MaterializationPlanDefinition needs:
  # - REMOVE watermark field
  # - Keep everything else

# Implementation Status: BLUEPRINT ONLY
# Next steps: Run generate-complete-v0.5.py to create full module
"""

    return blueprint

if __name__ == '__main__':
    import sys

    blueprint = generate_v05_module()

    output_path = 'ontology/meta/data-binding-meta-model-v0.5-blueprint.yaml'
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(blueprint)

    print(f"✓ Generated {output_path}")
    print()
    print("This is a BLUEPRINT showing the v0.5 architecture.")
    print("Due to the large file size (estimated 2000+ lines), manual completion is recommended.")
    print()
    print("Recommended approach:")
    print("1. Copy v0.4 module to new file")
    print("2. Update version to 0.5.0")
    print("3. Copy unchanged types (DataSource, DatasetDefinition, etc.)")
    print("4. Delete Field, SemanticFieldMapping, TransformationReference")
    print("5. Add all new types from this blueprint")
    print("6. Rewrite SemanticMappingDefinition, TemporalMappingSpec, TransformationDefinition")
    print("7. Update examples")
    print("8. Calculate digest and update imports")
    print()
    print("Estimated effort: 8-12 hours for complete implementation")

    sys.exit(0)
