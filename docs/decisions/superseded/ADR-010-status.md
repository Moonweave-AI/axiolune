# P0 Blocking Issues - Resolution Status

**Document**: ADR-010 Implementation Tracking  
**Date**: 2026-07-28  
**Status**: In Progress

## Executive Summary

| Issue | Status | Auto/Manual | Evidence |
|-------|--------|-------------|----------|
| P0-1: Schema-YAML mismatch | 🔴 Not Started | Manual | Requires Schema rewrite |
| P0-2: Module digests | ✅ Complete | Auto | 83 fixes, 0 pending digests |
| P0-3: IRI templates | ✅ Complete | Auto | 76 {BASE_IRI} resolved |
| P0-4: Naming consistency | ✅ Complete | Auto | 26 renames to *Definition |
| P0-5: Pattern semantics | 🟡 Partial | Manual | Requires attribute definitions |
| P0-6: Data binding | 🔴 Not Started | Manual | Remove dual truth sources |
| P0-7: Action safety | 🔴 Not Started | Manual | Fix SubmitOrder idempotency |

**Overall Progress**: 3/7 complete (42.9%)

---

## P0-2: Module Reproducibility ✅ COMPLETE

**Script**: `scripts/calculate-digests.js` + `scripts/fix-p0-issues.js`

### Changes Applied

#### 1. SHA-256 Digest Calculation

All module digests calculated and embedded:

```yaml
# Before
artifactDigest: "sha256:pending"

# After
artifactDigest: "sha256:f2eddc1184bdf99b7a77c88f69cff0ace9f962abcacf852cd3a56d6acfbc2b6a"
```

**Digest Map**:
- `core-meta-model.yaml`: `sha256:f2eddc1184bdf99b7a77c88f69cff0ace9f962abcacf852cd3a56d6acfbc2b6a`
- `cross-domain-patterns.yaml`: `sha256:06570776bf5acc6832a50dbb799d8b9159739768b338c22382055d550908fc44`
- `behavior-meta-model.yaml`: `sha256:e169f9fb159f0cea47aaad617bf7a67eb6f5b522e945a6b36f292b0c089908d9`
- `data-binding-meta-model.yaml`: `sha256:88bf8dbe53b0bf3bdaefec4e350d551e78a3cee88a8b9b30de1c9b3f046eb001`

#### 2. Version Conflict Resolution

Fixed `data-binding-meta-model.yaml` import:

```yaml
# Before
imports:
  - moduleIri: "https://axiolune.ai/ontology/meta/behavior"
    version: "0.3.0"  # ❌ Wrong - behavior is v0.4.0

# After
imports:
  - moduleIri: "https://axiolune.ai/ontology/meta/behavior"
    version: "0.4.0"  # ✅ Correct
```

### Verification

```bash
$ grep -r "sha256:pending" ontology/meta/*.yaml
# (no results) ✅

$ grep -r "version.*0\.3\.0.*behavior" ontology/meta/data-binding-meta-model.yaml
# (no results) ✅
```

---

## P0-3: IRI Template Resolution ✅ COMPLETE

**Script**: `scripts/fix-p0-issues.js`

### Changes Applied

Resolved all 76 `{BASE_IRI}` template placeholders:

```yaml
# Before (double-slash bug)
baseIri: "https://axiolune.ai/ontology/meta/patterns/"
iri: "{BASE_IRI}/patterns/TemporalFact"
# Would become: https://axiolune.ai/ontology/meta/patterns//patterns/TemporalFact ❌

# After
iri: "https://axiolune.ai/ontology/meta/patterns/TemporalFact"  # ✅
```

### Resolution Count by File

- `core-meta-model.yaml`: 12 templates
- `cross-domain-patterns.yaml`: 62 templates
- `behavior-meta-model.yaml`: 1 template
- `data-binding-meta-model.yaml`: 1 template

**Total**: 76 templates resolved

### Verification

```bash
$ grep -r "{BASE_IRI}" ontology/meta/*.yaml
# (no results) ✅
```

---

## P0-4: Naming Consistency ✅ COMPLETE

**Script**: `scripts/fix-naming-consistency.js`

### Changes Applied

All meta-types now use `*Definition` suffix per ADR-004:

| Before | After | Occurrences |
|--------|-------|-------------|
| `IdentifierType` | `IdentifierTypeDefinition` | 8 |
| `MoneyType` | `MoneyTypeDefinition` | 7 |
| `QuantityType` | `QuantityTypeDefinition` | 4 |
| `CodeListType` | `CodeListTypeDefinition` | 7 |

**Total**: 26 renames across 4 files

### Example

```yaml
# Before
IdentifierType:
  definition: "a meta-classifier for standard identifiers..."
  
# After
IdentifierTypeDefinition:
  definition: "a meta-classifier for standard identifiers..."
```

### Verification

```bash
$ grep -E "^  (Identifier|Money|Quantity|CodeList)Type:" ontology/meta/*.yaml
# (no results) ✅
```

---

## P0-5: Pattern Semantics 🟡 PARTIAL

**Status**: Requires manual attribute definitions and conflict symmetry

### Remaining Work

#### 1. Conflict Symmetry

```yaml
# cross-domain-patterns.yaml
TemporalFact:
  conflicts:
    - "https://axiolune.ai/ontology/meta/patterns/TemporalObservation"

TemporalObservation:
  conflicts:
    - "https://axiolune.ai/ontology/meta/patterns/TemporalFact"  # ✅ Must add
```

#### 2. Injected Attribute Definitions

All pattern-injected attributes must be defined in `core-meta-model.yaml`:

**Required AttributeTypeDefinition entries**:
- `validFrom` (instant, required)
- `validTo` (instant, optional)
- `knowledgeFrom` (instant, required)
- `knowledgeTo` (instant, optional)
- `observedAt` (instant, optional)
- `availableAt` (instant, optional)
- `publishedAt` (instant, optional)
- `receivedAt` (instant, optional)
- `source` (uri, required)
- `sourceVersion` (string, optional)
- `confidence` (decimal, optional, range 0.0-1.0)
- `revision` (integer, optional)
- `derivedFrom` (list[uri], optional)

#### 3. Data Binding Field Mappings

`data-binding-meta-model.yaml` must map to new bi-temporal fields:

```yaml
# Current (incomplete)
recordedAtField: "timestamp"

# Required (complete bi-temporal)
temporalFieldMappings:
  observedAt: "observation_time"
  knowledgeFrom: "ingestion_timestamp"
  knowledgeTo: null  # Current version
  availableAt: "available_from"
```

---

## P0-6: Data Binding Single Truth Source 🔴 NOT STARTED

**Status**: Requires removal of `Dataset.semanticMappings` and `SemanticMappingDefinition`

### Required Changes

#### 1. Remove Dual Truth Sources

```yaml
# data-binding-meta-model.yaml

# ❌ DELETE THIS (duplicate truth source)
DatasetDefinition:
  optionalFields:
    semanticMappings:  # REMOVE
      type: "list[SemanticMappingDefinition]"

# ❌ DELETE THIS (entire type)
SemanticMappingDefinition:
  definition: "..."  # REMOVE ENTIRE SECTION

# ✅ KEEP THIS (single truth source per ADR-007)
FieldDefinition:
  optionalFields:
    semanticMapping:
      type: SemanticFieldMapping
```

#### 2. Remove Free-Form Transformation Expressions

```yaml
# ❌ DELETE
FieldMapping:
  transformationExpression: "lookup_instrument_by_isin(...)"  # REMOVE

# ✅ KEEP (typed reference)
FieldMapping:
  transformation:
    type: TransformationReference
    transformationIri: "data:TickerToISIN"
```

---

## P0-7: Action Safety Compliance 🔴 NOT STARTED

**Status**: Requires fixing `SubmitOrder` idempotency declaration

### Required Changes

```yaml
# behavior-meta-model.yaml

# Before ❌
SubmitOrder:
  isIdempotent: conditionallyIdempotent  # ❌ Not allowed with retry
  retryPolicy:
    maxAttempts: 3

# After ✅
SubmitOrder:
  isIdempotent: false  # Honest declaration
  retryPolicy: null     # No automatic retry
  note: "Non-idempotent action; use ExecutionRecord reconciliation protocol for timeout recovery (ADR-008)"
```

### Validation Rule Update

```yaml
ValidationRules:
  - "ActionTypeDefinition with retryPolicy MUST have isIdempotent=true (strict boolean, not conditionallyIdempotent)"
```

---

## P0-1: Schema Rewrite 🔴 NOT STARTED

**Status**: Requires complete Schema rewrite to match hierarchical YAML structure

### Required Changes

Current Schema expects:

```json
{
  "module": {...},
  "definitions": [...]  // ❌ YAMLs don't have this
}
```

YAMLs actually use:

```yaml
module: {...}
MetaModel:  # or CrossDomainPatterns, PlatformBehavior, DataBinding
  ObjectTypeDefinition: {...}
  AttributeTypeDefinition: {...}
```

**Decision**: Rewrite Schema to validate hierarchical structure (see ADR-010)

---

## Automation Summary

### Scripts Created

1. ✅ `scripts/calculate-digests.js` - SHA-256 calculation
2. ✅ `scripts/fix-p0-issues.js` - P0-2 and P0-3 automation
3. ✅ `scripts/fix-naming-consistency.js` - P0-4 automation

### Total Automated Fixes

- **83 fixes** (P0-2, P0-3): Digests and IRI templates
- **26 renames** (P0-4): Naming consistency
- **109 total changes** applied automatically

### Manual Work Remaining

- P0-1: Schema rewrite (~2 hours)
- P0-5: Pattern attribute definitions (~3 hours)
- P0-6: Data binding cleanup (~1 hour)
- P0-7: Action safety fix (~30 minutes)

**Estimated remaining effort**: 6.5 hours

---

## Next Steps

### Immediate (This Session)

1. ✅ Execute P0-2 automation
2. ✅ Execute P0-3 automation
3. ✅ Execute P0-4 automation
4. 🔲 Document current state (this file)
5. 🔲 Commit all automated fixes
6. 🔲 Begin P0-7 manual fix (quick win)

### Next Session

1. Complete P0-5: Define all pattern-injected attributes
2. Complete P0-6: Remove dual truth sources
3. Complete P0-1: Rewrite Schema for hierarchical validation
4. Regenerate ADR-009 examples with complete M3→M2→M1 chain

---

## Verification Commands

```bash
# P0-2: No pending digests
grep -r "sha256:pending" ontology/meta/*.yaml
# Expected: (no results)

# P0-3: No IRI templates
grep -r "{BASE_IRI}" ontology/meta/*.yaml
# Expected: (no results)

# P0-4: No old naming patterns
grep -E "^  (Identifier|Money|Quantity|CodeList)Type:" ontology/meta/*.yaml
# Expected: (no results)

# P0-7: Check SubmitOrder
grep -A5 "SubmitOrder:" ontology/meta/behavior-meta-model.yaml | grep -E "(isIdempotent|retryPolicy)"
# Expected: isIdempotent: false, retryPolicy: null
```

---

## Conclusion

**Automated fixes (P0-2, P0-3, P0-4)** are complete and verified. **109 total changes** applied.

**Manual fixes (P0-1, P0-5, P0-6, P0-7)** require careful semantic edits and are documented above for next session.

**Progress**: 42.9% complete (3/7 issues resolved)
