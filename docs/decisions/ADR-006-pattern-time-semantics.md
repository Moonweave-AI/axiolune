# ADR-006: Pattern and Time Semantics

**Status**: Proposed  
**Date**: 2026-07-28  
**Requires**: ADR-004 (meta-model foundation), ADR-005 (executable meta-language)

## Context

ADR-004 resolved the pattern composition conflict by extracting `PublicationTiming` as a shared base pattern. However, several temporal semantics remain incomplete:

1. **Pattern Composition Proof**: Need to prove that `TemporalFact` + `ProvenancedFact` can be applied to the same object without field conflicts
2. **Bi-Temporal Semantics**: `logicalKey` and revision priority are documented but not fully specified
3. **Point-in-Time Queries**: The `QueryTypeDefinition` has `querySemantics: pointInTime` but no implementation guidance
4. **Retraction Semantics**: How to handle corrections, restatements, and withdrawn facts

## Decision

### 1. Pattern Composition Semantics

**Dependency Resolution**:
- When `ObjectType` applies pattern P, all patterns in P's transitive dependency closure are also applied
- Dependencies are resolved depth-first, post-order (base patterns inject fields first)
- If multiple patterns in the closure inject the same attribute IRI, the **first declaration wins** (no re-injection)

**Conflict Detection**:
- Before applying patterns, check transitive closure for any pair (P1, P2) where P1.conflicts includes P2.iri
- If conflict found, validation fails with clear error message

**Example Composition**:
```yaml
# Object applies both patterns
ObjectTypeDefinition:
  iri: "fin:PriceObservation"
  appliedPatterns:
    - "ax-pattern:TemporalFact"
    - "ax-pattern:ProvenancedFact"

# Dependency resolution:
# TemporalFact depends on PublicationTiming → inject publishedAt, receivedAt, observedAt, availableAt
# ProvenancedFact depends on PublicationTiming → publishedAt, receivedAt already injected (skip), inject source, sourceVersion, confidence, revision, derivedFrom

# Final effective attributes:
# - publishedAt (from PublicationTiming via TemporalFact)
# - receivedAt (from PublicationTiming via TemporalFact)
# - observedAt (from TemporalFact)
# - availableAt (from TemporalFact)
# - source (from ProvenancedFact)
# - sourceVersion (from ProvenancedFact)
# - confidence (from ProvenancedFact)
# - revision (from ProvenancedFact)
# - derivedFrom (from ProvenancedFact)
```

### 2. Bi-Temporal Semantics

#### 2.1 Time Dimensions

**Transaction Time** (`publishedAt`, `receivedAt`):
- `publishedAt`: When the source system published this fact (source's timestamp)
- `receivedAt`: When our system received/ingested this fact (our timestamp)
- Immutable once recorded (append-only ledger)

**Valid Time** (`observedAt`, `availableAt`):
- `observedAt`: When the fact was true in the real world (e.g., market price at 10:30:00)
- `availableAt`: When the fact became knowable (e.g., market data feed timestamp)
- Can be backdated or future-dated

**Revision** (`revision`):
- Integer version number for the same logical fact
- Higher revision supersedes lower revision for the same `logicalKey`

#### 2.2 Logical Key Semantics

`logicalKey` defines which attributes identify "the same fact" across revisions:

```yaml
ObjectTypeDefinition:
  iri: "fin:PriceObservation"
  logicalKey:
    - "fin:instrument"      # which instrument
    - "fin:priceType"       # bid/ask/last
    - "fin:observedAt"      # when in valid time
```

**Uniqueness constraint**:
- For any given `(logicalKey values, revision)` tuple, there is at most one fact
- Multiple rows with same `logicalKey` but different `revision` represent the same logical fact evolving over time

#### 2.3 Revision Priority

When querying for "current" or "as-of" data, revision priority determines which version wins:

**Rule**: For the same `logicalKey`, the fact with:
1. Highest `revision` number, AND
2. Received before the query's as-of time (`receivedAt <= asOf`)

**Example**:
```
Fact A: instrument=AAPL, priceType=last, observedAt=2026-07-28T10:30:00, revision=1, receivedAt=2026-07-28T10:30:05, price=150.00
Fact B: instrument=AAPL, priceType=last, observedAt=2026-07-28T10:30:00, revision=2, receivedAt=2026-07-28T10:35:00, price=150.05  (correction)

Query: GetPriceAsOf(instrument=AAPL, priceType=last, validTime=2026-07-28T10:30:00, asOf=2026-07-28T10:32:00)
Result: Fact A (revision 2 not yet received)

Query: GetPriceAsOf(instrument=AAPL, priceType=last, validTime=2026-07-28T10:30:00, asOf=2026-07-28T10:40:00)
Result: Fact B (revision 2 supersedes revision 1)
```

### 3. Point-in-Time Query Semantics

`QueryTypeDefinition` with `querySemantics: pointInTime` must specify:

```yaml
QueryTypeDefinition:
  iri: "fin:GetPriceAsOf"
  definition: "Retrieve price observation as it was known at a specific transaction time"
  querySemantics: pointInTime
  parameters:
    instrument: {type: "fin:InstrumentIdentifier"}
    priceType: {type: "fin:PriceType"}
    validTime: {type: datetime}
    asOfTime: {type: datetime}     # Transaction time boundary
  returnType: "fin:PriceObservation?"
  implementation:
    logic: |
      SELECT * FROM facts
      WHERE instrument = :instrument
        AND priceType = :priceType
        AND observedAt = :validTime
        AND receivedAt <= :asOfTime
      ORDER BY revision DESC, receivedAt DESC
      LIMIT 1
```

**Guarantees**:
- Reproducibility: Same query parameters always return same result (time travel)
- Audit trail: Can reconstruct what was known at any past moment
- Correction handling: Later revisions automatically supersede earlier ones

### 4. Retraction Semantics

**Soft Retraction** (preferred):
- Publish a new fact with higher `revision` and a special marker attribute
- Example: Add `isRetracted: true` or `confidence: 0.0`
- Original fact remains in ledger for audit

**Hard Deletion** (exceptional):
- Only for GDPR/compliance (PII removal)
- Mark record as tombstone, purge from indexes
- Log the deletion event separately

**Restatement** (correction):
- Publish new revision with corrected values
- `derivedFrom` can point to original fact IRI
- Downstream systems re-process based on `revision` change

### 5. Pattern Validation Tests

We will create test cases to prove pattern composition works:

**Test 1: Dependency Resolution**
- Apply `TemporalFact` and `ProvenancedFact` to same object
- Verify `PublicationTiming` attributes injected exactly once
- Verify no duplicate field errors

**Test 2: Conflict Detection**
- Create two patterns with symmetric conflicts
- Apply both to same object
- Verify validation fails with clear error

**Test 3: Cycle Detection**
- Create pattern dependency cycle: A → B → C → A
- Verify validation fails before field injection

**Test 4: Transitive Closure**
- Create deep dependency chain: A → B → C → D
- Verify all attributes from D, C, B, A injected in correct order

## Acceptance Criteria

- [ ] Pattern composition algorithm documented with pseudocode
- [ ] Dependency resolution is deterministic (same input → same output)
- [ ] Conflict detection catches all transitive conflicts
- [ ] Bi-temporal query returns correct revision for any `(validTime, asOfTime)` pair
- [ ] Test suite covers:
  - [ ] TemporalFact + ProvenancedFact composition (no conflicts)
  - [ ] Conflicting patterns rejected
  - [ ] Cyclic dependencies rejected
  - [ ] Point-in-time query returns correct historical data
  - [ ] Revision priority correctly orders facts
- [ ] Documentation includes:
  - [ ] Bi-temporal data model diagram
  - [ ] SQL query examples for common patterns
  - [ ] Retraction and correction workflows

## Implementation Plan

### Phase 1: Pattern Composition Algorithm
- [ ] Implement transitive dependency resolver
- [ ] Implement conflict checker
- [ ] Add to `validate-meta-model.js`

### Phase 2: Bi-Temporal Schema
- [ ] Define database schema for bi-temporal facts
- [ ] Create indexes on `(logicalKey, revision, receivedAt)`
- [ ] Document storage patterns (PostgreSQL, FoundationDB, etc.)

### Phase 3: Query Implementation
- [ ] Implement point-in-time query engine
- [ ] Add query result caching
- [ ] Create query performance tests

### Phase 4: Test Suite
- [ ] Unit tests for pattern composition
- [ ] Integration tests for bi-temporal queries
- [ ] Property-based tests for time travel consistency

## Consequences

### Positive
- **Provable correctness**: Pattern composition is mechanical and verifiable
- **Audit compliance**: Bi-temporal model supports regulatory requirements
- **Time travel debugging**: Can replay system state at any past moment
- **Graceful corrections**: Restatements don't break existing queries

### Negative
- **Storage cost**: Bi-temporal data stores every version (no in-place updates)
- **Query complexity**: Point-in-time queries require careful indexing
- **Learning curve**: Developers must understand transaction vs. valid time

### Risks
- **Clock skew**: If `publishedAt` from sources is unreliable, ordering breaks
- **Revision conflicts**: Two systems publishing revision=2 simultaneously
- **Index bloat**: High-frequency updates create many revisions

## Migration Path

1. Implement pattern composition validator (non-breaking)
2. Add bi-temporal columns to existing fact tables (nullable)
3. Backfill `receivedAt` with record creation time
4. Deploy point-in-time query endpoints (alongside current queries)
5. Migrate clients to new endpoints incrementally
6. Make bi-temporal columns non-nullable after migration complete

## References

- ADR-004: Meta-Model Foundation
- ADR-005: Executable Meta-Language
- "Developing Time-Oriented Database Applications in SQL" (Richard T. Snodgrass)
- ISO/IEC 9075:2011 (SQL:2011) - Temporal features
- Martin Fowler: "Temporal Patterns"
