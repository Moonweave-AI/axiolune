# ADR-012: Reproducible Three-Axis Temporal Semantics

## Status
**Accepted (meta-model layer)** | 2026-07-29

Implementation: data-binding-meta-model v0.5.0 + cross-domain-patterns v0.4.0
Validation: ADR-012 compliance verified by `scripts/meta/deep-analysis-v0.5.js` (6/6 checks), `scripts/meta/validate-references.js`, and grep confirming no functional `CURRENT_TIMESTAMP` usage in the meta-model (the 6 surviving mentions are changelog/prohibition prose only).
Digest: sha256:f23edc168fce27e5bd03ac731ea617f334409437e607a56b432d1c75a05a93af

**Scope of acceptance**: criteria 1-6 are implemented and machine-verified at the meta-model layer (incl. `NoFutureKnowledge` rewritten to `$referenceTime` and `AvailabilityBeforeUse` added).
Criteria 7-9 (executed golden-path example with correction scenario, PIT query API implementation, historical replay test) are runtime concerns and remain pending.

## Context

ADR-006 established basic temporal semantics, but production requirements for backtesting, compliance auditing, and reproducible point-in-time (PIT) queries revealed critical gaps:

### Problems with Current Temporal Model

1. **Incomplete Time Axis Coverage**:
   - Current model uses `recordedAt`, `validFrom/To`, `observedAt`, `publishedAt`, `receivedAt`
   - These mix multiple temporal concerns without clear separation
   - Cannot distinguish "when fact was true" vs "when we knew it" vs "when we could use it"

2. **Non-Reproducible Historical Queries**:
   - `NoFutureKnowledge` constraint uses `CURRENT_TIMESTAMP`
   - Replaying historical materialization produces different results each time
   - Cannot reconstruct "what did the system know at 10:30 AM" after the fact

3. **Look-Ahead Bias Risk**:
   - No `availableAt` filtering in queries
   - Backtesting can accidentally use data that wasn't available to the strategy at query time
   - Compliance audits cannot verify that decisions used only authorized data

4. **Semantic Confusion**:
   - `recordedAt` used for both system observation timestamps and knowledge acquisition time
   - `observedAt` vs `publishedAt` vs `receivedAt` relationships unclear
   - No formal specification of when corrections/revisions close previous knowledge versions

5. **Undefined Mapping Specification**:
   - `TemporalMappingSpec` referenced but never defined
   - Current mappings use deprecated `recordedAtField`
   - No way to specify three-axis time sources from physical data

### What ADR-006 Got Right

ADR-006's decision to support bi-temporal semantics (valid time vs knowledge time) was correct but incomplete. This ADR extends rather than replaces ADR-006.

## Decision

### Supplements ADR-006

This ADR **supplements and extends** ADR-006 with:
- Complete three-axis temporal model
- Reproducible runtime context
- Formal temporal mapping specification
- Strict prohibition of non-reproducible time functions

### Three-Axis Temporal Model

All temporally-sensitive facts must support three independent time axes:

| Time Axis | Fields | Meaning | Query Parameter |
|-----------|--------|---------|-----------------|
| **Valid Time** | `validFrom` / `validTo` | When the fact holds true in the real world | `asOfValid` |
| **Knowledge Time** | `knowledgeFrom` / `knowledgeTo` | When the platform considers this fact version as known/retracted | `asOfKnowledge` |
| **Availability Time** | `availableFrom` / `availableTo` | When policy or downstream subject can actually use this data | `asOfAvailable` |

**All three fields use half-open intervals**: `[from, to)` where `to` is exclusive.

#### Semantic Definitions

**Valid Time**: The time period during which a fact holds true in the domain being modeled.
- Example: A security price quote is valid from 09:30:00 to 09:30:01
- Corrections do not change valid time; they create new knowledge versions with different valid-time facts

**Knowledge Time**: The time period during which the platform treats a particular version of knowledge as the authoritative answer.
- Example: Price initially known as $100 from 09:30:00, corrected to $101 at 09:31:00
  - Version 1: `validFrom: 09:30:00, knowledgeFrom: 09:30:00, knowledgeTo: 09:31:00`
  - Version 2: `validFrom: 09:30:00, knowledgeFrom: 09:31:00, knowledgeTo: null`
- Knowledge time enables "as-of" queries: "What did we know at time T?"

**Availability Time**: The time period during which data is accessible to a specific consumer due to policy, licensing, or processing delays.
- Example: Premium data embargoed for 15 minutes; research insights restricted to specific groups
- Enables compliance: "What could this strategy legally see at decision time?"
- Prevents look-ahead bias in backtesting

### Auxiliary Time Fields

The following auxiliary time fields are **retained** for provenance and observation metadata but **cannot substitute** for any of the three canonical axes:

- `observedAt` - When an external system observed/measured the phenomenon
- `publishedAt` - When the information source published the data
- `receivedAt` - When our system received the data from the source
- `recordedAt` - **Reserved for system telemetry only** (TemporalObservation pattern); never used as `knowledgeFrom`

### Temporal Mapping Specification

**Define**: `TemporalMappingSpec` as a formal structure within `SemanticMappingDefinition.temporal`.

```yaml
# Within SemanticMappingDefinition
temporal:
  # Pattern reference declaring which time axes this mapping populates
  patternRef: "ax-pattern:TemporalFact"
  
  # Valid Time: When facts hold true in reality
  validTime:
    from:
      sourceType: "field"
      dataset: "price"
      field: "quote_time"
    to:
      sourceType: "field"
      dataset: "price"
      field: "quote_expiry"
      # If null/missing, treated as instantaneous fact
  
  # Knowledge Time: When platform knows/retracts this version
  knowledgeTime:
    from:
      sourceType: "runtimeContext"
      contextField: "assertionTime"
    closePolicy: "closePreviousVersion"
    # closePolicy determines how knowledgeTo is set for superseded versions:
    # - "closePreviousVersion": Previous version's knowledgeTo = this version's knowledgeFrom
    # - "explicitOnly": Previous version remains open unless explicitly closed
  
  # Availability Time: When consumers can use this data
  availabilityTime:
    from:
      sourceType: "transformation"
      transformationRef: "fin:ComputeEmbargoEnd"
      inputs:
        publishedAt:
          dataset: "price"
          field: "published_at"
        embargoMinutes:
          literal: 15
    to:
      sourceType: "literal"
      value: null
      # null = available indefinitely once embargo ends
```

**Source Types**:
- `field` - Direct physical field value
- `runtimeContext` - Immutable value from `MaterializationRun` (assertionTime, referenceTime)
- `transformation` - Computed via versioned transformation
- `literal` - Static value (e.g., null for unbounded intervals)

### Immutable Runtime Context

**Prohibition**: The following non-reproducible constructs are **strictly forbidden** in any semantic definition, constraint, or query:

- `CURRENT_TIMESTAMP` or database-specific equivalents (`NOW()`, `GETDATE()`, etc.)
- `SYSDATE` or system clock functions
- Any function that returns different values when re-executed with same inputs

**Required**: All time-sensitive operations must reference immutable runtime context provided by `MaterializationRun`:

```yaml
MaterializationRun:
  runId: "mr_2026-07-29_093000_abc123"
  planRef: "..."
  
  # Immutable time context
  assertionTime: "2026-07-29T09:30:00Z"  # When this run asserted knowledge
  referenceTime: "2026-07-29T09:30:00Z"  # Reference point for time-based queries
  
  # Immutable input snapshot
  inputSnapshotDigest: "sha256:..."
  inputDatasets:
    - datasetRef: "..."
      versionDigest: "sha256:..."
      rowCount: 12500
  
  # Runtime outcomes (recorded after execution)
  status: "completed"
  startedAt: "2026-07-29T09:29:55Z"
  completedAt: "2026-07-29T09:30:02Z"
  outputRowCount: 8432
  errors: []
```

**Historical Replay**: When replaying or auditing historical materialization:
1. Retrieve original `MaterializationRun` record
2. Use its `assertionTime`, `referenceTime`, `inputSnapshotDigest`
3. Re-execute mapping with identical context
4. Results must be byte-for-byte identical (modulo non-deterministic transformation implementations, which are forbidden separately)

### Updated Constraint Definitions

**NoFutureKnowledge** constraint rewritten:

```yaml
# OLD (non-reproducible)
formalExpression: 'knowledgeFrom <= CURRENT_TIMESTAMP'

# NEW (reproducible)
formalExpression: 'knowledgeFrom <= $referenceTime'
# Where $referenceTime is bound to MaterializationRun.referenceTime
```

**NewConstraint: AvailabilityBeforeUse**

```yaml
AvailabilityBeforeUse:
  iri: "https://axiolune.ai/ontology/meta/patterns/constraints/AvailabilityBeforeUse"
  namespace: "pattern"
  localName: "AvailabilityBeforeUse"
  label: "Availability Before Use Constraint"
  definition: "validation rule ensuring that data is not used before its availability period begins"
  constraintType: "validation"
  formalExpression: '$queryTime >= availableFrom OR availableFrom IS NULL'
  targetElement: "https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom"
  severity: "error"
  message: "Cannot query data before its availability period"
  note: "Prevents look-ahead bias in backtesting; enforces compliance with data licensing"
```

### Point-in-Time Query Contract

**Requirement**: All PIT query APIs must accept explicit time parameters for all three axes. **Defaulting to "now" is forbidden** for compliance and audit use cases.

```typescript
// Correct API
queryFactsAtPointInTime(params: {
  asOfValid: Instant;      // Required: "Show facts valid at this real-world time"
  asOfKnowledge: Instant;  // Required: "Using knowledge available at this time"
  asOfAvailable: Instant;  // Required: "Restricted to data available at this time"
  factType: IRI;
  filters: Filter[];
}): FactSet

// FORBIDDEN: Implicit defaulting
queryFacts(factType: IRI) // Uses current time for all axes - breaks reproducibility
```

**Example Use Cases**:

1. **Backtesting**: "What would a strategy have seen at 2024-06-15 10:30:00?"
   ```
   asOfValid: 2024-06-15T10:30:00Z
   asOfKnowledge: 2024-06-15T10:30:00Z
   asOfAvailable: 2024-06-15T10:30:00Z
   ```

2. **Compliance Audit**: "Did the portfolio manager use only authorized data when making decision X?"
   ```
   asOfValid: <decision time>
   asOfKnowledge: <decision time>
   asOfAvailable: <decision time> // Filters to data this user could access
   ```

3. **Historical Correction Analysis**: "What did we think the price was yesterday vs what we know now?"
   ```
   Query 1 (yesterday's knowledge):
     asOfValid: 2024-06-28T15:00:00Z
     asOfKnowledge: 2024-06-28T23:59:59Z
     asOfAvailable: 2024-06-28T23:59:59Z
   
   Query 2 (current knowledge):
     asOfValid: 2024-06-28T15:00:00Z
     asOfKnowledge: <now>
     asOfAvailable: <now>
   ```

### Migration from Current Fields

**Deprecation Path**:

| Current Field | Migration Target | Timeline |
|---------------|------------------|----------|
| `availableAt` | `availableFrom` | Map during transition, remove in v0.6 |
| `recordedAt` (in semantic mappings) | Remove; use `knowledgeFrom` from runtime context | Immediate |
| `recordedAt` (in TemporalObservation) | Retain as auxiliary telemetry field | No change |
| `observedAt`, `publishedAt`, `receivedAt` | Retain as auxiliary provenance fields | No change |

**Clarification**: `observedAt`, `publishedAt`, `receivedAt` are valuable provenance metadata but are not canonical time axes and cannot substitute for valid/knowledge/availability time in queries or constraints.

## Consequences

### Positive
- **Reproducible Queries**: Historical PIT queries return identical results
- **Compliance Auditable**: Can prove what data was available at decision time
- **No Look-Ahead Bias**: Backtesting cannot accidentally use future information
- **Clear Semantics**: Three axes with distinct meanings and query parameters
- **Correction Support**: Knowledge time enables proper handling of late-arriving corrections

### Negative
- **Increased Complexity**: Three time axes instead of simple timestamps
- **Storage Overhead**: Each fact version stores 6 time values (3 axes × from/to)
- **Query Complexity**: PIT queries require explicit time parameters

### Migration Required
- Define `TemporalMappingSpec` type in meta-model
- Add `MaterializationRun` type for immutable runtime context
- Update `NoFutureKnowledge` constraint to use `$referenceTime`
- Add `AvailabilityBeforeUse` constraint
- Migrate `availableAt` to `availableFrom` in all existing data
- Remove `CURRENT_TIMESTAMP` from all mappings and constraints
- Update all PIT query APIs to require explicit time parameters

### Compatibility
- **Breaking Change**: Queries using implicit "now" semantics will fail
- **Migration Path**: All query call sites must add explicit time parameters
- **Timeline**: Core temporal model changes estimated 1-2 days; query API updates depend on number of consumers

## References
- ADR-006: Temporal and Event Modeling (supplemented by this ADR)
- ADR-011: Canonical Data Binding Truth Source (companion ADR, defines MaterializationRun)
- P1-1 high-priority issue: Temporal Mapping Incompleteness

## Acceptance Criteria

Before this ADR can move from Draft to Accepted:

1. ✅ Three-axis temporal model defined (valid/knowledge/availability)
2. ✅ `TemporalMappingSpec` type added to meta-model (verified: deep-analysis-v0.5)
3. ✅ `MaterializationRun` type added with immutable runtime context (verified)
4. ✅ `NoFutureKnowledge` constraint updated to use `$referenceTime` (verified: no functional `CURRENT_TIMESTAMP` remains)
5. ✅ `AvailabilityBeforeUse` constraint added (verified: validate-references resolves it)
6. ✅ All functional `CURRENT_TIMESTAMP` usage removed from meta-model (verified: the 6 surviving mentions are changelog/prohibition prose only)
7. ⬜ At least one golden path example executed with:
   - Valid time from source field
   - Knowledge time from runtime context
   - Availability time from transformation
   - Correction scenario showing knowledge version closure
8. ⬜ PIT query API implemented with required time parameters
9. ⬜ Historical replay test: Same MaterializationRun context produces identical output

**Current Status**: Implemented and machine-verified at the meta-model layer (criteria 1-6, 2026-07-29). Criteria 7-9 are runtime/query-layer concerns and remain pending.
