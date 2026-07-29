# Migration Guide: v0.4 → v0.5 Data Binding Meta-Model

**Version**: 0.4.0 → 0.5.0  
**Date**: 2026-07-29  
**Type**: BREAKING CHANGE  
**ADRs**: ADR-011 (Canonical Data Binding Truth Source), ADR-012 (Three-Axis Temporal)  

---

## Executive Summary

This is a **breaking change** that implements single truth source architecture for data binding. Field-level semantic mappings have been removed, and `SemanticMappingDefinition` is now the only structure for expressing semantic mappings.

### Impact Assessment

- **Breaking Changes**: 8 major structural changes
- **Deleted Types**: 3 (Field, SemanticFieldMapping, TransformationReference)
- **New Types**: 10 (SourceBinding, RowSetSpec, IdentitySpec, ValueBinding, etc.)
- **Renamed Fields**: 1 (fieldMappings → slotMappings)
- **Affected Modules**: All Layer 4 data binding definitions
- **Migration Effort**: High (requires manual review of all mappings)
- **Automated Migration**: Not possible (semantic decisions required)

---

## Breaking Changes Summary

| Change | v0.4 | v0.5 | Migration Complexity |
|--------|------|------|---------------------|
| **Field.semanticMapping** | Exists | **DELETED** | High - move to SemanticMappingDefinition |
| **SemanticFieldMapping type** | Exists | **DELETED** | High - replace with SlotMapping |
| **TransformationReference** | Exists | **DELETED** | Medium - use versioned TransformationDefinition |
| **SemanticMappingDefinition.sourceDataset** | `uri` | **SourceBinding** | High - express joins, filters |
| **SemanticMappingDefinition.fieldMappings** | Exists | **Renamed to slotMappings** | Medium - update references |
| **FieldMapping** | Exists | **Replaced with SlotMapping** | High - use ValueBinding |
| **TemporalMappingSpec** | Basic | **Three-axis model** | High - map all three axes |
| **MaterializationPlanDefinition.watermark** | Exists | **DELETED** | Low - move to MaterializationRun |

---

## Migration Strategy

### Phase 1: Assessment (Before Migration)

#### 1.1 Inventory Current Mappings

```bash
# Find all semantic mappings in your codebase
grep -r "semanticMapping:" . --include="*.yaml"
grep -r "SemanticFieldMapping" . --include="*.yaml"
grep -r "fieldMappings:" . --include="*.yaml"
```

#### 1.2 Classify Mapping Complexity

For each mapping, determine:

- **Simple Field Mapping**: Single field → single attribute, no transformation
  - **Effort**: Low (30 min per mapping)
  - **Example**: `isin_code` → `fin:hasISIN`

- **Transformed Mapping**: Single field → attribute with transformation
  - **Effort**: Medium (1 hour per mapping)
  - **Example**: `close_price` + `currency_code` → `fin:quotedPrice` (Money)

- **Multi-Field Participant Role**: Multiple fields → participant role
  - **Effort**: High (2 hours per mapping)
  - **Example**: `isin` + `exchange_code` → `fin:quotedInstrument`

- **Multi-Table Mapping**: Requires joins, filters, or aggregation
  - **Effort**: Very High (4 hours per mapping)
  - **Example**: Position from `positions` + `accounts` tables

#### 1.3 Create Migration Checklist

For each mapping:
- [ ] Mapping ID: _______________
- [ ] Complexity: [ ] Simple [ ] Transformed [ ] Multi-Field [ ] Multi-Table
- [ ] Current location (file:line): _______________
- [ ] Dependencies: _______________
- [ ] Estimated effort: _____ hours
- [ ] Assigned to: _______________
- [ ] Status: [ ] Not Started [ ] In Progress [ ] Complete [ ] Verified

### Phase 2: Implementation (During Migration)

#### 2.1 Delete Field-Level Semantic Mappings

**v0.4 (DELETE THIS)**:
```yaml
# In DatasetDefinition or inline
Field:
  name: "close_price"
  dataType: "DECIMAL(18,4)"
  semanticMapping:
    targetAttribute: "fin:quotedPrice"
    transformation:
      transformationIri: "data:CreateMoney"
      parameters:
        currencyField: "currency_code"
```

**v0.5 (NO EQUIVALENT)**: Field-level mappings are forbidden. Move to SemanticMappingDefinition.

#### 2.2 Create SemanticMappingDefinition (Simple Case)

**v0.5 (NEW)**:
```yaml
SemanticMappingDefinition:
  iri: "fin:mapping:EquityPrice"
  label: "Equity Price Observation Mapping"
  
  # Source: What physical data
  source:
    datasets:
      - dataset: "datasource:bloomberg/equity_prices_eod"
        alias: "price"
    # No rowSet needed for simple case
  
  # Target: What ontological type
  target:
    typeRef: "fin:PriceObservation"
  
  # Identity: How to construct entity IRI
  identity:
    logicalKey:
      - {dataset: "price", field: "isin"}
      - {dataset: "price", field: "trade_date"}
    iriTemplate: "https://moonweave.ai/observation/price/{isin}/{trade_date}"
  
  # Slot Mappings: How to populate attributes and roles
  slotMappings:
    # Simple direct field mapping
    - target:
        slotType: "attribute"
        targetAttribute: "fin:observedISIN"
      value:
        bindingType: "directField"
        source: {dataset: "price", field: "isin"}
    
    # Transformed mapping (Money construction)
    - target:
        slotType: "attribute"
        targetAttribute: "fin:quotedPrice"
      value:
        bindingType: "transformation"
        transformationRef: "ax-binding:CreateMoney"
        inputs:
          amount:
            bindingType: "directField"
            source: {dataset: "price", field: "close_price"}
          currency:
            bindingType: "directField"
            source: {dataset: "price", field: "currency_code"}
  
  # Temporal: Three-axis time
  temporal:
    patternRef: "ax-pattern:TemporalObservation"
    validTime:
      from:
        bindingType: "directField"
        source: {dataset: "price", field: "trade_date"}
      to:
        bindingType: "literal"
        value: null  # Instantaneous observation
    knowledgeTime:
      from:
        bindingType: "runtimeContext"
        contextField: "assertionTime"
      closePolicy: "closePreviousVersion"
    availabilityTime:
      from:
        bindingType: "runtimeContext"
        contextField: "assertionTime"
      to:
        bindingType: "literal"
        value: null  # Available immediately
  
  # Provenance
  provenance:
    sourceSystem:
      bindingType: "literal"
      value: "Bloomberg"
    acquisitionTime:
      bindingType: "directField"
      source: {dataset: "price", field: "received_at"}
```

#### 2.3 Create SemanticMappingDefinition (Multi-Table Case)

**v0.5 (NEW)**:
```yaml
SemanticMappingDefinition:
  iri: "fin:mapping:PortfolioHolding"
  label: "Portfolio Holding Mapping"
  
  # Source: Multi-table with join
  source:
    datasets:
      - dataset: "datasource:internal/positions"
        alias: "pos"
      - dataset: "datasource:internal/accounts"
        alias: "acct"
    rowSet:
      joins:
        - leftDataset: "pos"
          rightDataset: "acct"
          joinType: "inner"
          conditions:
            - leftField: "account_id"
              operator: "="
              rightField: "id"
      filters:
        - dataset: "pos"
          field: "quantity"
          operator: ">"
          value: 0
  
  target:
    typeRef: "fin:Holding"
  
  identity:
    logicalKey:
      - {dataset: "pos", field: "account_id"}
      - {dataset: "pos", field: "isin"}
      - {dataset: "pos", field: "effective_date"}
    iriTemplate: "https://moonweave.ai/holding/{account_id}/{isin}/{effective_date}"
  
  slotMappings:
    # Participant role: Account (from joined table)
    - target:
        slotType: "participantRole"
        roleRef: "fin:holdingAccount"
      value:
        bindingType: "transformation"
        transformationRef: "fin:ResolveAccountByID"
        inputs:
          accountId:
            bindingType: "directField"
            source: {dataset: "acct", field: "id"}
    
    # Participant role: Instrument
    - target:
        slotType: "participantRole"
        roleRef: "fin:heldInstrument"
      value:
        bindingType: "transformation"
        transformationRef: "fin:ResolveInstrumentByISIN"
        inputs:
          isin:
            bindingType: "directField"
            source: {dataset: "pos", field: "isin"}
    
    # Attribute: Quantity
    - target:
        slotType: "attribute"
        targetAttribute: "fin:quantity"
      value:
        bindingType: "directField"
        source: {dataset: "pos", field: "quantity"}
  
  temporal:
    patternRef: "ax-pattern:TemporalFact"
    validTime:
      from:
        bindingType: "directField"
        source: {dataset: "pos", field: "effective_date"}
      to:
        bindingType: "directField"
        source: {dataset: "pos", field: "expiration_date"}
    knowledgeTime:
      from:
        bindingType: "directField"
        source: {dataset: "pos", field: "updated_at"}
      closePolicy: "closePreviousVersion"
    availabilityTime:
      from:
        bindingType: "runtimeContext"
        contextField: "assertionTime"
```

#### 2.4 Update TransformationDefinition

**v0.4 (INCOMPLETE)**:
```yaml
TransformationDefinition:
  iri: "data:CreateMoney"
  kind: "ExpressionTransformation"
  sourceType: "decimal"
  targetType: "fin:Money"
  # Missing: version, digest, inputs, outputs, testCases
```

**v0.5 (COMPLETE)**:
```yaml
TransformationDefinition:
  iri: "ax-binding:CreateMoney"
  namespace: "ax-binding"
  localName: "CreateMoney"
  label: "Create Money Value"
  definition: "a transformation that constructs a Money structured value from amount and currency code"
  
  kind: "ExpressionTransformation"
  
  # REQUIRED: Explicit inputs with types
  inputs:
    amount:
      typeKind: "primitive"
      primitiveType: "decimal"
    currency:
      typeKind: "primitive"
      primitiveType: "string"
  
  # REQUIRED: Explicit output type
  outputs:
    typeKind: "structured"
    typeRef: "fin:Money"
  
  # REQUIRED: Version
  version: "1.0.0"
  
  # REQUIRED: Implementation digest
  implementationDigest: "sha256:abc123..."
  
  # REQUIRED: Test cases
  testCases:
    - input: {amount: 100.50, currency: "USD"}
      expectedOutput: {amount: 100.50, currency: "USD"}
      description: "USD currency"
    - input: {amount: 99.99, currency: "EUR"}
      expectedOutput: {amount: 99.99, currency: "EUR"}
      description: "EUR currency"
  
  implementation:
    expression: "{ amount: $amount, currency: $currency }"
    language: "jsonPath"
```

#### 2.5 Create MaterializationRun for Runtime State

**v0.4 (MIXED IN PLAN)**:
```yaml
MaterializationPlanDefinition:
  iri: "plan:DailyPrices"
  # ...
  watermark: "2026-07-28T23:59:59Z"  # WRONG PLACE
```

**v0.5 (SEPARATED)**:
```yaml
# Static plan (no runtime state)
MaterializationPlanDefinition:
  iri: "plan:DailyPrices"
  label: "Daily Price Materialization"
  sourceDatasets: ["datasource:bloomberg/equity_prices_eod"]
  targetOntologyModule: "fin:market-data"
  semanticMappings: ["fin:mapping:EquityPrice"]
  materializationMode: "Incremental"
  incrementalKey: "trade_date"  # Static configuration
  # watermark removed

# Runtime execution record (new)
MaterializationRun:
  iri: "run:DailyPrices_2026-07-29"
  runId: "mr_2026-07-29_093000_abc123"
  planRef: "plan:DailyPrices"
  
  # Immutable time context (ADR-012)
  assertionTime: "2026-07-29T09:30:00Z"
  referenceTime: "2026-07-29T09:30:00Z"
  
  # Immutable input snapshot
  inputSnapshotDigest: "sha256:def456..."
  inputDatasets:
    - dataset: "datasource:bloomberg/equity_prices_eod"
      versionDigest: "sha256:789abc..."
      rowCount: 12500
      snapshotTime: "2026-07-29T09:29:55Z"
  
  # Runtime outcomes
  status: "completed"
  startedAt: "2026-07-29T09:29:55Z"
  completedAt: "2026-07-29T09:30:02Z"
  outputRowCount: 8432
  watermark: "2026-07-29T00:00:00Z"  # Moved here
  errors: []
```

### Phase 3: Validation (After Migration)

#### 3.1 Automated Validation

```bash
# Run structure validation
node scripts/verify-meta-model.js

# Run semantic validation (updated for v0.5)
node scripts/deep-analysis-v0.5.js

# Expected output:
# ✅ No field-level semantic mappings found
# ✅ All SemanticMappingDefinition have SourceBinding
# ✅ All slotMappings use ValueBinding
# ✅ All transformations have version, digest, inputs, outputs, testCases
# ✅ All temporal mappings have three axes
# ✅ No CURRENT_TIMESTAMP references found
# ✅ MaterializationRun provides immutable context
```

#### 3.2 Manual Review Checklist

For each migrated mapping:

- [ ] No field-level `semanticMapping` remains
- [ ] `SemanticMappingDefinition` created with `SourceBinding`
- [ ] Multi-table mappings have `joins` specified
- [ ] Row filters specified if needed
- [ ] `IdentitySpec` has `logicalKey` and `iriTemplate`
- [ ] All `slotMappings` use `ValueBinding` union type
- [ ] Participant roles use `transformation` with explicit inputs
- [ ] `TemporalMappingSpec` has all three axes (valid/knowledge/availability)
- [ ] No `recordedAtField` used (use `knowledgeTime` instead)
- [ ] No `CURRENT_TIMESTAMP` (use `runtimeContext.assertionTime`)
- [ ] `ProvenanceBinding` uses `ValueBinding` for all fields
- [ ] Referenced `TransformationDefinition` has version, digest, tests
- [ ] `MaterializationPlanDefinition` has no `watermark`
- [ ] `MaterializationRun` created for runtime state

#### 3.3 Semantic Equivalence Testing

```python
# Pseudo-code for testing semantic equivalence
def test_semantic_equivalence(v04_mapping, v05_mapping):
    # Load sample input data
    input_data = load_fixture("test_prices.csv")
    
    # Run v0.4 materialization
    v04_output = materialize_v04(v04_mapping, input_data)
    
    # Run v0.5 materialization with same input
    v05_output = materialize_v05(v05_mapping, input_data)
    
    # Compare outputs (should be identical or documented differences)
    assert v04_output.entity_count == v05_output.entity_count
    assert v04_output.triples == v05_output.triples
```

---

## Common Migration Patterns

### Pattern 1: Simple Field → Attribute

**v0.4**:
```yaml
Field:
  name: "isin_code"
  semanticMapping:
    targetAttribute: "fin:hasISIN"
```

**v0.5**:
```yaml
# In SemanticMappingDefinition.slotMappings:
- target:
    slotType: "attribute"
    targetAttribute: "fin:hasISIN"
  value:
    bindingType: "directField"
    source: {dataset: "price", field: "isin_code"}
```

### Pattern 2: Transformed Field → Attribute

**v0.4**:
```yaml
Field:
  name: "close_price"
  semanticMapping:
    targetAttribute: "fin:quotedPrice"
    transformation:
      transformationIri: "data:CreateMoney"
      parameters:
        currencyField: "currency_code"
```

**v0.5**:
```yaml
- target:
    slotType: "attribute"
    targetAttribute: "fin:quotedPrice"
  value:
    bindingType: "transformation"
    transformationRef: "ax-binding:CreateMoney"
    inputs:
      amount: {bindingType: "directField", source: {dataset: "price", field: "close_price"}}
      currency: {bindingType: "directField", source: {dataset: "price", field: "currency_code"}}
```

### Pattern 3: Multi-Field → Participant Role

**v0.4**: Not expressible (limitation of field-level mapping)

**v0.5**:
```yaml
- target:
    slotType: "participantRole"
    roleRef: "fin:quotedInstrument"
  value:
    bindingType: "transformation"
    transformationRef: "fin:ResolveInstrumentByISIN"
    inputs:
      isin: {bindingType: "directField", source: {dataset: "price", field: "isin"}}
      exchange: {bindingType: "directField", source: {dataset: "price", field: "exchange_code"}}
```

### Pattern 4: Multi-Table Join

**v0.4**: Not expressible

**v0.5**:
```yaml
source:
  datasets:
    - {dataset: "ds:table1", alias: "t1"}
    - {dataset: "ds:table2", alias: "t2"}
  rowSet:
    joins:
      - leftDataset: "t1"
        rightDataset: "t2"
        joinType: "inner"
        conditions:
          - {leftField: "id", operator: "=", rightField: "foreign_id"}
```

### Pattern 5: Three-Axis Temporal

**v0.4**:
```yaml
temporalMapping:
  pattern: "TemporalFact"
  validFromField: "effective_date"
  validToField: "expiration_date"
  recordedAtSource: "ingestionTimestamp"  # WRONG
```

**v0.5**:
```yaml
temporal:
  patternRef: "ax-pattern:TemporalFact"
  validTime:
    from: {bindingType: "directField", source: {dataset: "pos", field: "effective_date"}}
    to: {bindingType: "directField", source: {dataset: "pos", field: "expiration_date"}}
  knowledgeTime:
    from: {bindingType: "runtimeContext", contextField: "assertionTime"}
    closePolicy: "closePreviousVersion"
  availabilityTime:
    from: {bindingType: "runtimeContext", contextField: "assertionTime"}
```

---

## Troubleshooting

### Issue 1: "Cannot express participant role with single field"

**Symptom**: Participant role requires multiple fields (e.g., ISIN + Exchange → Instrument)

**Solution**: Use `transformation` binding with explicit inputs:
```yaml
value:
  bindingType: "transformation"
  transformationRef: "fin:ResolveInstrument"
  inputs:
    isin: {bindingType: "directField", source: {dataset: "price", field: "isin"}}
    exchange: {bindingType: "directField", source: {dataset: "price", field: "exchange"}}
```

### Issue 2: "Need to filter rows before mapping"

**Symptom**: Only certain rows should be mapped (e.g., `security_type = 'EQUITY'`)

**Solution**: Use `rowSet.filters`:
```yaml
source:
  datasets:
    - {dataset: "ds:securities", alias: "sec"}
  rowSet:
    filters:
      - {dataset: "sec", field: "security_type", operator: "=", value: "EQUITY"}
```

### Issue 3: "Temporal mapping shows drift in historical replay"

**Symptom**: Re-running historical materialization produces different results

**Root Cause**: Using `CURRENT_TIMESTAMP` or `ingestionTimestamp` instead of immutable context

**Solution**: Use `runtimeContext` binding:
```yaml
knowledgeTime:
  from:
    bindingType: "runtimeContext"
    contextField: "assertionTime"  # Immutable value from MaterializationRun
```

### Issue 4: "Transformation missing version/digest"

**Symptom**: Validation fails: "TransformationDefinition must have version and implementationDigest"

**Solution**: Add required fields:
```yaml
TransformationDefinition:
  # ... existing fields ...
  version: "1.0.0"
  implementationDigest: "sha256:..."
  inputs: {...}
  outputs: {...}
  testCases: [...]
```

---

## Rollback Plan

If migration fails and rollback is needed:

1. **Restore v0.4 module**:
   ```bash
   git checkout v0.4.0 -- ontology/meta/data-binding-meta-model.yaml
   ```

2. **Restore v0.4 digests**:
   ```bash
   git checkout v0.4.0 -- ontology/meta/digests.json
   ```

3. **Revert dependent modules**:
   ```bash
   # Any modules that imported v0.5
   git checkout v0.4.0 -- [affected-files]
   ```

4. **Run verification**:
   ```bash
   node scripts/verify-meta-model.js
   ```

5. **Document rollback reason** in `docs/incidents/v0.5-rollback-[date].md`

---

## Support

**Questions**: Contact architecture team  
**Issues**: File in GitHub Issues with label `migration-v0.5`  
**ADRs**: [ADR-011](../decisions/ADR-011-canonical-data-binding-truth-source.md), [ADR-012](../decisions/ADR-012-reproducible-three-axis-temporal-semantics.md)  
**Tracker**: [Implementation Tracker](implementation-tracker.md)
