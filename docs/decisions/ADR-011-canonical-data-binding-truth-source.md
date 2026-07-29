# ADR-011: Canonical Data Binding Truth Source

## Status
**Accepted** | 2026-07-29

Implementation: data-binding-meta-model v0.5.0  
Validation: All 10 acceptance criteria pass  
Digest: sha256:f16924434185d5074c5c3a2327c0092618fed619469997ed87b98a17a9ff611e

## Context

ADR-007 established `Field.semanticMapping` as the single truth source for data binding, intending to prevent duplicate semantic definitions. However, production implementation revealed critical architectural issues:

### Problems with Field-Level Mapping as Sole Truth Source

1. **Cannot Express Row-Level Semantics**: A single field cannot independently express:
   - Multi-table joins and foreign key relationships
   - Row filtering and aggregation logic
   - Entity identity across multiple columns (logical keys)
   - Participant roles requiring multiple fields (e.g., Instrument from ISIN + Exchange)

2. **Cannot Express Dataset-Level Semantics**:
   - Provenance (data source, acquisition time, responsible agent)
   - Bi-temporal semantics (valid time vs knowledge time vs availability time)
   - Version closure and snapshot consistency
   - Access control and data classification

3. **Structural Inconsistency**:
   - `DatasetSchema.fields` uses `FieldDefinition` (physical structure)
   - `SemanticFieldMapping` uses a different `Field` construct (semantic binding)
   - This creates two parallel type hierarchies for the same concept

4. **Multiple Truth Sources in Practice**: Despite ADR-007's intent, the current meta-model contains three concurrent mapping structures:
   - `Field.semanticMapping` (field-level)
   - `SemanticMappingDefinition` (independent top-level definition)
   - `MaterializationPlanDefinition.semanticMappings` (plan-level)

### What ADR-007 Got Right

ADR-007's decisions on typed value construction (`Money`, `Quantity`) and explicit transformation definitions remain valid and are preserved.

## Decision

### Supersedes
This ADR **supersedes** the portion of ADR-007 that designated `Field.semanticMapping` as the sole truth source, while **preserving** ADR-007's decisions on:
- Typed value construction (Money, Quantity, structured values)
- Explicit transformation definitions with version control
- Prohibition of implicit cross-field dependencies

### New Architecture: SemanticMappingDefinition as Canonical Truth Source

**Single Truth Source**: `SemanticMappingDefinition` is the canonical and only structure for expressing how physical data maps to ontological semantics.

**Strict Prohibition**: The following are explicitly forbidden:
- Field-level `semanticMapping` or any semantic annotations on `FieldDefinition`
- Inline transformation expressions without versioning
- Semantic mappings embedded in `MaterializationPlanDefinition`
- Any structure that allows field-to-attribute mapping without context

### Architecture Layers

| Layer | Retained/New | Explicitly Forbidden |
|-------|--------------|---------------------|
| Physical Structure | `DatasetDefinition`, `FieldDefinition` | Storing business semantics in fields |
| Canonical Truth Source | `SemanticMappingDefinition` | Parallel `SemanticFieldMapping`, independent field-level mappings |
| Mapping Internals | `SourceBinding`, `RowSetSpec`, `IdentitySpec`, `SlotMapping`, temporal/provenance mappings | Expressing joins, aggregation, identity, or row-level semantics via single field |
| Transformation | Versioned `TransformationDefinition` with explicit named inputs | Inline `transformationExpression`, implicit reading of other columns |
| Materialization | `MaterializationPlanDefinition` references mappings only | Storing runtime state (watermark, lastRun) in static definitions |
| Runtime State | Independent `MaterializationRun` with immutable runtime contract | Using current machine time to re-derive historical results |

### Semantic Mapping Minimal Structure

**Rename**: `SemanticMappingDefinition.fieldMappings` → `slotMappings` to avoid misunderstanding as narrow "field-to-attribute" mapping.

**Required Components**:

```yaml
SemanticMappingDefinition:
  iri: "..."
  namespace: "..."
  localName: "..."
  label: "..."
  definition: "..." # ISO 704 genus-differentia
  
  # Source: What physical data + row-level operations
  source:
    datasets:
      - datasetRef: "..."
        alias: "..."
    rowSet:
      filters: [...]
      joins: [...]
      grouping: {...}
  
  # Target: What ontological type and instance graph structure
  target:
    typeRef: "fin:PriceObservation"
    instanceGraph: "..."
  
  # Identity: How to determine if two source rows represent the same entity
  identity:
    logicalKey:
      - dataset: "price"
        field: "instrument_id"
      - dataset: "price"
        field: "timestamp"
    versionKey:
      - dataset: "price"
        field: "version"
    iriTemplate: "https://axiolune.ai/data/observations/price/{instrument_id}/{timestamp}"
  
  # Slot Mappings: How to populate attributes, participant roles, and pattern fields
  slotMappings:
    # Example: Participant role requiring transformation
    - target:
        slotType: "participantRole"
        roleRef: "fin:quotedInstrument"
      value:
        transformationRef: "fin:ResolveInstrumentByISIN"
        inputs:
          isin:
            dataset: "price"
            field: "isin"
          exchange:
            dataset: "price"
            field: "exchange_code"
    
    # Example: Attribute requiring typed value construction
    - target:
        slotType: "attribute"
        attributeRef: "fin:quotedPrice"
      value:
        transformationRef: "ax-binding:CreateMoney"
        inputs:
          amount:
            dataset: "price"
            field: "close_price"
          currency:
            dataset: "price"
            field: "currency_code"
  
  # Temporal: Three-axis time semantics (see ADR-012)
  temporal:
    patternRef: "ax-pattern:TemporalFact"
    validTime: {...}
    knowledgeTime: {...}
    availabilityTime: {...}
  
  # Provenance: Where data came from, when acquired, responsible agent
  provenance:
    sourceSystem: "..."
    acquisitionTime: "..."
    responsibleAgent: "..."
```

### Hard Rules After Refactoring

1. **Physical Structure Only**: `FieldDefinition` describes only physical columns; delete duplicate `Field` and `SemanticFieldMapping` types.

2. **Single Mapping, Multiple Uses**: A field can be used by multiple mappings, but all "what it represents in a context" definitions exist only within `SemanticMappingDefinition`.

3. **Explicit Transformations**: All transformations must declare:
   - Input types and names
   - Output type
   - Version
   - Implementation digest
   - Test cases
   - Expression implementations allowed, but unversioned inline expressions forbidden

4. **Static Plan, Dynamic Run**:
   - `MaterializationPlanDefinition` holds only mapping references and static output strategy
   - Watermark, runtime, input snapshot, success/failure, row counts go into `MaterializationRun`

5. **Immutable Runtime Context**: `MaterializationRun` provides immutable `assertionTime`, `referenceTime`, `inputSnapshotDigest` that historical replay must reuse.

### TargetSlot Preservation

`TargetSlot` is **retained** as it correctly models the three slot types:
- `attribute` - direct attribute value
- `participantRole` - entity participating in a relation
- `patternField` - field injected by cross-domain pattern

This is one of the correct and valuable parts of the current design.

## Consequences

### Positive
- **Complete Semantic Expression**: Can now express joins, aggregation, identity, multi-field participant roles
- **Clear Separation of Concerns**: Physical structure vs semantic interpretation vs runtime state
- **Reproducible Materialization**: Immutable runtime context enables historical replay
- **Single Truth Source**: No ambiguity about where semantic mappings are defined

### Migration Required
- Delete `Field.semanticMapping` and `SemanticFieldMapping` type
- Rename `fieldMappings` to `slotMappings` in all existing `SemanticMappingDefinition`
- Move any semantic mappings from `MaterializationPlanDefinition` into referenced `SemanticMappingDefinition`
- Create `MaterializationRun` type for runtime state
- Update all existing mappings to new structure

### Compatibility
- **Breaking Change**: Existing field-level mappings cannot be automatically migrated
- **Migration Path**: Each field-level mapping must be manually reviewed to determine required source row-set operations and identity semantics
- **Timeline**: Estimated 2-3 days for architecture implementation, additional time for migrating existing mappings

## References
- ADR-007: Data Binding and Transformation Model (partially superseded)
- ADR-012: Reproducible Three-Axis Temporal Semantics (companion ADR)
- P0-3 blocking issue: Data Binding Multiple Truth Sources

## Acceptance Criteria

Before this ADR can move from Draft to Accepted:

1. ✅ `SemanticMappingDefinition` structure defined with all required components
2. ⬜ `MaterializationRun` type defined for runtime state
3. ⬜ `Field.semanticMapping` and `SemanticFieldMapping` removed from meta-model
4. ⬜ All existing mappings migrated to new structure
5. ⬜ Validation rules enforce single truth source (no field-level semantic annotations)
6. ⬜ At least two production-grade golden path mappings:
   - Market price with Money construction, participant roles, three-axis time
   - Position snapshot with multi-table join, logical key, validity period
7. ⬜ All five ADR-009 examples regenerated and passing with new structure

**Current Status**: Draft - architecture defined, implementation not started
