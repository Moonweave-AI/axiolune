# P0-3 Data Binding Architecture Refactoring Plan

**Status**: In Progress  
**Date**: 2026-07-29  
**ADR**: ADR-011 (Canonical Data Binding Truth Source)  
**Estimated Duration**: 2-3 days  

---

## Executive Summary

Refactor Layer 4 (data-binding-meta-model) from v0.4 to v0.5 to implement ADR-011's single truth source architecture. This resolves the P0-3 blocking issue where three concurrent mapping structures violate the single truth source principle.

---

## Current Architecture Problems (v0.4)

### 1. Multiple Truth Sources (P0-3 Blocker)

**Three concurrent mapping structures**:
1. `Field.semanticMapping: SemanticFieldMapping` (line 306-308)
2. `SemanticMappingDefinition` (line 453-531)
3. `MaterializationPlanDefinition.semanticMappings: list[uri]` (line 676-680)

**Problem**: Ambiguous authority - which structure is canonical?

### 2. Field-Level Mapping Cannot Express Critical Semantics

`SemanticFieldMapping` (lines 311-327) can only map:
- Single field → single attribute
- With optional transformation

**Cannot express**:
- Multi-table joins (e.g., Instrument from prices + reference data)
- Row filtering (e.g., security_type = 'EQUITY')
- Entity identity across multiple columns (logical keys)
- Participant roles requiring multiple fields (ISIN + Exchange → Instrument)
- Dataset-level semantics (provenance, bi-temporal, access control)

### 3. Structural Inconsistency

- `DatasetSchema.fields` uses `FieldDefinition` (line 184)
- `SemanticFieldMapping` uses different `Field` construct (line 273-309)
- Two parallel type hierarchies for the same concept

### 4. Runtime State Mixed with Static Definitions

`MaterializationPlanDefinition` contains (lines 706-709):
- `watermark` - runtime state
- `incrementalKey` - static configuration

**Problem**: Cannot reconstruct historical materialization context

### 5. Inline Transformations Without Versioning

`FieldMapping.transformationExpression` (lines 551-554) allows:
```yaml
transformationExpression: "UPPER(TRIM(isin_code))"
```

**Problem**: No version control, no input/output types, no test cases, not reproducible

---

## Target Architecture (v0.5)

### Principle: Single Truth Source

**ONLY ONE** structure for semantic mappings: `SemanticMappingDefinition`

All other structures **FORBIDDEN** from containing semantic mapping information.

### Architecture Layers

| Layer | Retained/New | Explicitly Forbidden |
|-------|--------------|---------------------|
| **Physical Structure** | `DatasetDefinition`, `FieldDefinition` | Semantic annotations on fields |
| **Canonical Truth Source** | `SemanticMappingDefinition` | `SemanticFieldMapping`, field-level mappings |
| **Mapping Internals** | `SourceBinding`, `RowSetSpec`, `IdentitySpec`, `SlotMapping` | Single-field-only mappings |
| **Transformation** | Versioned `TransformationDefinition` with explicit inputs | Inline `transformationExpression` |
| **Materialization Plan** | `MaterializationPlanDefinition` (references only) | Runtime state (watermark, lastRun) |
| **Runtime State** | `MaterializationRun` (immutable context) | Using CURRENT_TIMESTAMP |

---

## Detailed Changes

### 1. DELETE: Field.semanticMapping and SemanticFieldMapping

**Remove** (lines 273-327):
- `Field` type (duplicate of `FieldDefinition`)
- `Field.semanticMapping` field
- `SemanticFieldMapping` type
- `TransformationReference` type (replaced by versioned TransformationDefinition)

**Rationale**: Violates single truth source; cannot express required semantics.

### 2. ENHANCE: SemanticMappingDefinition

**Current structure** (lines 453-531) is a good foundation but incomplete.

**Add new required components**:

#### a. SourceBinding (replaces simple sourceDataset)

```yaml
SourceBinding:
  definition: "specification of physical data sources and row-set operations for a semantic mapping"
  
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

DatasetReference:
  dataset: {type: uri, required: true, description: "DatasetDefinition IRI"}
  alias: {type: string, description: "alias for use in expressions"}
```

#### b. RowSetSpec (new)

```yaml
RowSetSpec:
  definition: "row-level operations applied to source datasets before mapping"
  
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
```

#### c. IdentitySpec (enhanced)

**Replace** `IdentityMappingSpec` (lines 588-612) with:

```yaml
IdentitySpec:
  definition: "specification of how to determine entity identity and construct IRIs"
  
  requiredFields:
    logicalKey:
      type: "list[FieldReference]"
      required: true
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

FieldReference:
  dataset: {type: string, required: true, description: "dataset alias"}
  field: {type: string, required: true, description: "field name"}
```

#### d. SlotMapping (renamed from FieldMapping)

**Rename** `fieldMappings` → `slotMappings` to reflect that it maps to "slots" (attributes, roles, pattern fields), not just fields.

**Replace** `FieldMapping` (lines 533-563) with:

```yaml
SlotMapping:
  definition: "specification of how to populate one target slot (attribute, participant role, relation, pattern field)"
  
  requiredFields:
    target:
      type: TargetSlot
      required: true
      description: "what to populate (attribute, role, relation, or pattern field)"
    
    value:
      type: ValueBinding
      required: true
      description: "how to compute the value"

ValueBinding:
  definition: "specification of how to compute a value for a slot"
  
  discriminator: bindingType
  
  variants:
    DirectFieldBinding:
      fields:
        bindingType: {type: literal, value: "directField"}
        source: {type: FieldReference, required: true}
    
    TransformationBinding:
      fields:
        bindingType: {type: literal, value: "transformation"}
        transformationRef: {type: uri, required: true, description: "TransformationDefinition IRI"}
        inputs: {type: "map[string, ValueBinding]", required: true, description: "named inputs to transformation"}
    
    LiteralBinding:
      fields:
        bindingType: {type: literal, value: "literal"}
        value: {type: any, required: true}
    
    RuntimeContextBinding:
      fields:
        bindingType: {type: literal, value: "runtimeContext"}
        contextField: {type: string, required: true, description: "field from MaterializationRun"}
```

#### e. TemporalMappingSpec (ADR-012 compliant)

**Replace** `TemporalMappingSpec` (lines 613-634) with:

```yaml
TemporalMappingSpec:
  definition: "specification of how to map physical data to three-axis temporal semantics (ADR-012)"
  
  requiredFields:
    patternRef:
      type: uri
      required: true
      description: "temporal pattern IRI (e.g., ax-pattern:TemporalFact)"
  
  optionalFields:
    validTime:
      type: TimeAxisBinding
      description: "binding for valid time axis (when fact holds true in reality)"
    
    knowledgeTime:
      type: TimeAxisBinding
      description: "binding for knowledge time axis (when platform knows/retracts this version)"
    
    availabilityTime:
      type: TimeAxisBinding
      description: "binding for availability time axis (when consumers can use this data)"

TimeAxisBinding:
  definition: "binding for one time axis (from/to)"
  
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
      description: "how to set knowledgeTo for superseded versions"
```

#### f. ProvenanceBinding (renamed from ProvenanceMappingSpec)

**Replace** `ProvenanceMappingSpec` (lines 635-641) with:

```yaml
ProvenanceBinding:
  definition: "specification of how to capture data provenance metadata"
  
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
```

### 3. ENHANCE: TransformationDefinition

**Current** (lines 346-414) is mostly correct but needs stricter requirements.

**Make mandatory**:
- `version` field (currently optional, line 375-377)
- `implementationDigest` field (new, for reproducibility)
- `testCases` field (currently optional, line 379-381)
- `inputs` field (new, explicit named inputs)
- `outputs` field (new, explicit output type)

**Add new fields**:

```yaml
TransformationDefinition:
  requiredFields:
    # ... existing fields ...
    
    inputs:
      type: "map[string, TypeReference]"
      required: true
      description: "named input parameters with types"
      example: {amount: "decimal", currency: "string"}
    
    outputs:
      type: TypeReference
      required: true
      description: "output type"
    
    version:
      type: string
      required: true
      description: "semantic version of this transformation"
    
    implementationDigest:
      type: string
      required: true
      description: "SHA-256 digest of implementation artifact"
    
    testCases:
      type: "list[TransformationTestCase]"
      required: true
      minCount: 1
      description: "test cases for validation"

TypeReference:
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
```

### 4. NEW: MaterializationRun

**Add new type** for immutable runtime state:

```yaml
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
      description: "when this run asserted knowledge (immutable)"
    
    referenceTime:
      type: instant
      required: true
      description: "reference point for time-based queries (immutable)"
    
    # Immutable input snapshot
    inputSnapshotDigest:
      type: string
      required: true
      description: "SHA-256 digest of input dataset versions"
    
    inputDatasets:
      type: "list[InputDatasetSnapshot]"
      required: true
      description: "snapshot of input datasets at run time"
  
  optionalFields:
    # Runtime outcomes (recorded after execution)
    status:
      type: enum
      values: [pending, running, completed, failed, partial]
      description: "execution status"
    
    startedAt:
      type: instant
      description: "when execution started"
    
    completedAt:
      type: instant
      description: "when execution completed"
    
    outputRowCount:
      type: integer
      description: "number of entity instances materialized"
    
    errors:
      type: "list[ExecutionError]"
      description: "errors encountered during execution"
    
    watermark:
      type: any
      description: "watermark value for next incremental run (moved from plan)"
    
    metrics:
      type: ExecutionMetrics
      description: "performance and quality metrics"

InputDatasetSnapshot:
  dataset: {type: uri, required: true, description: "DatasetDefinition IRI"}
  versionDigest: {type: string, required: true, description: "SHA-256 of dataset version"}
  rowCount: {type: integer, description: "number of rows in this snapshot"}
  snapshotTime: {type: instant, required: true, description: "when snapshot was taken"}

ExecutionError:
  severity: {type: enum, values: [error, warning, info]}
  code: {type: string}
  message: {type: string, required: true}
  sourceRow: {type: integer, description: "row number that caused error"}
  context: {type: "map[string,any]", description: "additional error context"}

ExecutionMetrics:
  rowsRead: {type: integer}
  rowsProcessed: {type: integer}
  rowsSkipped: {type: integer}
  rowsFailed: {type: integer}
  duration: {type: duration}
  throughput: {type: decimal, description: "rows per second"}
```

### 5. UPDATE: MaterializationPlanDefinition

**Remove runtime state fields**:
- `watermark` (line 706-709) → moved to `MaterializationRun`
- `incrementalKey` (line 703-705) → keep (this is static configuration)

**Clarify semanticMappings field** (line 676-680):
- This is correct: plan references mapping IRIs
- Mappings themselves are the canonical definitions

**Add validation rule**:
```yaml
ValidationRules:
  - "MaterializationPlanDefinition.semanticMappings must all be SemanticMappingDefinition IRIs"
  - "MaterializationPlanDefinition contains only static configuration; all runtime state in MaterializationRun"
```

---

## Migration Table

| v0.4 Structure | v0.5 Action | Rationale |
|----------------|-------------|-----------|
| `Field` | **DELETE** | Duplicate of `FieldDefinition` |
| `Field.semanticMapping` | **DELETE** | Violates single truth source |
| `SemanticFieldMapping` | **DELETE** | Cannot express required semantics |
| `TransformationReference` | **DELETE** | Replaced by versioned TransformationDefinition with explicit inputs |
| `SemanticMappingDefinition` | **ENHANCE** | Add SourceBinding, IdentitySpec, slotMappings, full temporal/provenance |
| `SemanticMappingDefinition.sourceDataset` | **REPLACE** with `source: SourceBinding` | Enable multi-table, joins, filters |
| `SemanticMappingDefinition.fieldMappings` | **RENAME** to `slotMappings` | Clarify it maps to slots, not just fields |
| `FieldMapping` | **REPLACE** with `SlotMapping` | Add ValueBinding union type |
| `IdentityMappingSpec` | **REPLACE** with `IdentitySpec` | Add logicalKey, versionKey, clearer structure |
| `TemporalMappingSpec` | **REPLACE** | Implement ADR-012 three-axis model |
| `ProvenanceMappingSpec` | **RENAME** to `ProvenanceBinding` + enhance | Use ValueBinding for all fields |
| `TransformationDefinition` | **ENHANCE** | Make version, digest, testCases, inputs, outputs mandatory |
| `MaterializationPlanDefinition.watermark` | **MOVE** to `MaterializationRun` | Runtime state, not static config |
| N/A | **ADD** `MaterializationRun` | Immutable runtime context |
| N/A | **ADD** `SourceBinding` | Multi-table, joins, filters |
| N/A | **ADD** `RowSetSpec` | Row-level operations |
| N/A | **ADD** `ValueBinding` | Unified value source specification |
| N/A | **ADD** `TimeAxisBinding` | Three-axis temporal binding |

---

## Implementation Steps

### Step 1: Create v0.5 Module Structure (30 min)
- Copy v0.4 module to new file
- Update version to 0.5.0
- Update change log
- Update note with ADR-011/012 compliance statements

### Step 2: Add New Core Types (1 hour)
- SourceBinding
- RowSetSpec (with FilterExpression, JoinExpression, GroupingSpec)
- IdentitySpec
- ValueBinding (union type with 4 variants)
- TimeAxisBinding
- ProvenanceBinding
- MaterializationRun (with supporting types)
- TypeReference (for explicit transformation types)

### Step 3: Delete Obsolete Types (15 min)
- Field
- SemanticFieldMapping
- TransformationReference

### Step 4: Refactor SemanticMappingDefinition (1 hour)
- Replace `sourceDataset: uri` with `source: SourceBinding`
- Rename `fieldMappings` to `slotMappings`
- Replace `FieldMapping` with `SlotMapping`
- Replace `IdentityMappingSpec` with `IdentitySpec`
- Replace `TemporalMappingSpec` with ADR-012 compliant version
- Replace `ProvenanceMappingSpec` with `ProvenanceBinding`

### Step 5: Enhance TransformationDefinition (30 min)
- Make `version` required
- Add `implementationDigest` required field
- Add `inputs` required field with TypeReference
- Add `outputs` required field with TypeReference
- Make `testCases` required with minCount: 1

### Step 6: Update MaterializationPlanDefinition (15 min)
- Remove `watermark` field
- Add validation rules

### Step 7: Update Examples (2 hours)
- Rewrite EquityPriceMapping example using new structure
- Rewrite HoldingMapping example using new structure
- Add example with multi-table join
- Add example with knowledge time correction

### Step 8: Update Validation Rules (30 min)
- Remove rules referencing deleted types
- Add rules for new types
- Add ADR-011 compliance rules
- Add ADR-012 compliance rules

### Step 9: Calculate Digest and Update Imports (15 min)
- Calculate SHA-256 of new module
- Update digests.json
- Update imports in dependent modules (if any)

### Step 10: Create Migration Guide (1 hour)
- Document breaking changes
- Provide migration examples
- Document validation script updates

---

## Acceptance Criteria

- ✅ Zero field-level semantic mappings (Field.semanticMapping deleted)
- ✅ SemanticMappingDefinition is sole mapping structure
- ✅ Can express multi-table joins
- ✅ Can express row filtering and grouping
- ✅ Can express entity identity across multiple columns
- ✅ Can express participant roles requiring multiple fields
- ✅ Can express dataset-level semantics (provenance, temporal)
- ✅ Static definitions separated from runtime state
- ✅ All transformations have version, digest, explicit inputs/outputs, test cases
- ✅ ADR-012 three-axis temporal model implemented
- ✅ No CURRENT_TIMESTAMP or non-reproducible time functions
- ✅ MaterializationRun provides immutable runtime context
- ✅ Examples demonstrate all new capabilities
- ✅ Validation rules enforce single truth source

---

## Timeline

- **Day 1 Morning** (4 hours): Steps 1-3 (structure, new types, delete obsolete)
- **Day 1 Afternoon** (4 hours): Steps 4-5 (refactor SemanticMapping, enhance Transformation)
- **Day 2 Morning** (4 hours): Steps 6-7 (update plan, rewrite examples)
- **Day 2 Afternoon** (3 hours): Steps 8-10 (validation, digest, migration guide)

**Total**: 15 hours ≈ 2 days

---

## Next Phases

After P0-3 completion:
- **P1-1**: Implement temporal mapping in practice (1-2 days)
- **Validators**: Build validation tools (2 days)
- **End-to-End**: Migrate ADR-009 examples (2 days)
- **Production**: Gray release (1 day)

**Total Timeline**: 8-10 days to production baseline
