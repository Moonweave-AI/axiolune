# ADR-010: P0 Blocking Issues Resolution

**Status**: Proposed  
**Decision Owner**: TBD  
**Date**: 2026-07-28  
**Supersedes**: None  
**Related**: ADR-004, ADR-005, ADR-006, ADR-007, ADR-008, ADR-009

## Context

Following comprehensive review of ADR-005 through ADR-009, six P0 blocking issues prevent acceptance:

1. **Schema-YAML structural mismatch**: Schema expects `definitions[]` array, YAMLs use hierarchical structure
2. **Unresolved module dependencies**: All imports show `sha256:pending`, version conflicts exist
3. **IRI template placeholders**: 76 `{BASE_IRI}` references cause double-slash IRIs
4. **Naming inconsistency**: YAMLs use `IdentifierType`, ADRs reference `IdentifierTypeDefinition`
5. **Incomplete pattern semantics**: Missing attributes, asymmetric conflicts, bi-temporal field gaps
6. **Data binding contradictions**: Dual truth sources violate ADR-007 single-source decision

## Decision

### 1. Meta-Language Structure (P0-1)

**Decision**: Preserve hierarchical YAML structure, rewrite Schema to match.

**Rationale**:
- Hierarchical structure (`MetaModel:`, `CrossDomainPatterns:`) provides better governance organization
- Each layer's purpose is self-documenting
- JSON Schema can validate hierarchical structures just as well as flat arrays
- Changing 4 YAML files to match one incomplete Schema is backwards

**Action**:
- Rewrite `meta-model.schema.json` to accept both:
  - Top-level keys: `module`, `MetaModel` | `CrossDomainPatterns` | `PlatformBehavior` | `DataBinding`
  - Each section contains typed definitions under semantic grouping
- Remove obsolete `definitions[]` array requirement
- Add all missing definition types: `AssociationTypeDefinition`, `ExecutionRecordDefinition`, `TransformationDefinition`, etc.

### 2. Module Reproducibility (P0-2)

**Decision**: Calculate and embed actual SHA-256 digests, fix version conflicts.

**Actions**:
- Write script to calculate SHA-256 of each YAML file
- Update all `artifactDigest: "sha256:pending"` with actual digests
- Fix version conflicts:
  - `behavior-meta-model.yaml` imports `core` v0.3.0 → should import v0.3.0 (correct)
  - `data-binding-meta-model.yaml` imports `behavior` v0.3.0 → should import v0.4.0 (fix)
- Resolve all `{BASE_IRI}` templates to actual IRIs using module `baseIri`

### 3. IRI Template Resolution (P0-3)

**Decision**: All `{BASE_IRI}/...` → direct concatenation `{baseIri}...` (baseIri already ends with /)

**Rules**:
- Module `baseIri` MUST end with `/` or `#` (Schema enforces)
- Reference formation: `baseIri + localName` (no additional separator)
- Pattern injection references: Use full IRI, not template
- 76 templates to resolve across 4 files

**Example**:
```yaml
# Before
iri: "{BASE_IRI}/patterns/TemporalFact"

# After (given baseIri: "https://axiolune.ai/ontology/meta/patterns/")
iri: "https://axiolune.ai/ontology/meta/patterns/TemporalFact"
```

### 4. Naming Consistency (P0-4)

**Decision**: All meta-types use `*Definition` suffix (ADR-004 decision).

**Changes Required**:
- `core-meta-model.yaml`: Rename `IdentifierType` → `IdentifierTypeDefinition`, `CodeListType` → `CodeListTypeDefinition`, etc.
- `cross-domain-patterns.yaml`: Already correct (`PatternDefinition`)
- `behavior-meta-model.yaml`: Rename `PolicyType` → `PolicyTypeDefinition`
- `data-binding-meta-model.yaml`: `DataSource` → `DataSourceDefinition`, `Field` → `FieldDefinition`

**Validation**: ADR-009 examples must reference corrected names.

### 5. Pattern Semantics Closure (P0-5)

**Decision**: Make pattern injection references resolvable and symmetric.

**Actions**:

#### 5.1 Conflict Symmetry
```yaml
# cross-domain-patterns.yaml
TemporalFact:
  conflicts: ["https://axiolune.ai/ontology/meta/patterns/TemporalObservation"]

TemporalObservation:
  conflicts: ["https://axiolune.ai/ontology/meta/patterns/TemporalFact"]
```

#### 5.2 Complete Bi-Temporal Model
- `TemporalFact` injected attributes: `validFrom`, `validTo`, `knowledgeFrom`, `knowledgeTo`, `observedAt`, `availableAt`
- `PublicationTiming` injected attributes: `publishedAt`, `receivedAt`
- ADR-009 examples MUST include all required fields
- Data binding layer: Map `recordedAtField` → `knowledgeFrom`, add `knowledgeTo`, `availableAt` mappings

#### 5.3 Injected Attribute Definitions
All pattern-injected attributes must be defined in `core-meta-model.yaml` as `AttributeTypeDefinition`:
- `validFrom`, `validTo`, `knowledgeFrom`, `knowledgeTo`, `observedAt`, `availableAt`, `publishedAt`, `receivedAt`, `source`, `sourceVersion`, `confidence`, `revision`, etc.

### 6. Data Binding Single Truth Source (P0-6)

**Decision**: `Field.semanticMapping` is sole truth source (ADR-007).

**Actions**:
- Remove `DatasetDefinition.semanticMappings` field entirely
- Remove `SemanticMappingDefinition` type
- Keep only `Field.semanticMapping: SemanticFieldMapping`
- `SemanticFieldMapping` structure:
  ```yaml
  SemanticFieldMapping:
    requiredFields:
      targetAttribute: {type: string}  # IRI or field path
    optionalFields:
      transformation: {type: TransformationReference}
  ```
- Remove free-form transformation expressions (`lookup_instrument_by_isin(...)`)
- All transformations must reference typed `TransformationDefinition` via IRI

### 7. Action Safety Compliance (P0-7)

**Decision**: Enforce idempotency rule strictly.

**Rule**: Actions with `retryPolicy` MUST have `isIdempotent: true` (not `conditionallyIdempotent`).

**Fix in behavior-meta-model.yaml**:
```yaml
SubmitOrder:
  isIdempotent: false  # NOT idempotent without external contract
  retryPolicy: null     # REMOVE retry policy
  note: "Non-idempotent action; use ExecutionRecord reconciliation for timeout recovery"
```

**Validation Rule**:
```yaml
ValidationRules:
  - "ActionTypeDefinition with retryPolicy MUST have isIdempotent=true (strict, not conditionallyIdempotent)"
  - "Non-idempotent actions MUST use ExecutionRecord reconciliation protocol for unknown-status recovery"
```

## Implementation Phases

### Phase 1: Schema Rewrite (1 file)
- [ ] Rewrite `meta-model.schema.json` for hierarchical validation
- [ ] Add all missing definition types
- [ ] Test against all 4 YAML files

### Phase 2: IRI Resolution (4 files)
- [ ] Resolve all 76 `{BASE_IRI}` templates
- [ ] Fix double-slash issues
- [ ] Ensure all IRIs are globally unique

### Phase 3: Module Digests (4 files + script)
- [ ] Write digest calculation script
- [ ] Calculate SHA-256 for each file
- [ ] Update all imports with actual digests
- [ ] Fix version conflicts

### Phase 4: Naming Consistency (4 files)
- [ ] Rename all types to `*Definition` suffix
- [ ] Update all references in ADR-009

### Phase 5: Pattern Semantics (2 files)
- [ ] Add conflict symmetry
- [ ] Define all injected attributes
- [ ] Complete bi-temporal field mappings

### Phase 6: Data Binding Cleanup (1 file)
- [ ] Remove dual truth sources
- [ ] Enforce typed transformations only

### Phase 7: Action Safety Fix (1 file)
- [ ] Fix SubmitOrder idempotency declaration
- [ ] Remove non-compliant retry policies

### Phase 8: ADR-009 Validation (1 file)
- [ ] Regenerate all 5 examples with complete M3→M2→M1 chain
- [ ] Include all bi-temporal fields
- [ ] Prove OWL consistency
- [ ] Add SHACL validation results

## Verification

Each fix must pass:
1. ✅ YAML syntax parse
2. ✅ JSON Schema validation
3. ✅ Symbol resolution (all IRIs resolvable)
4. ✅ No circular dependencies
5. ✅ ADR-009 examples compile to valid Turtle
6. ✅ OWL DL consistency check
7. ✅ SHACL validation

## Success Criteria

- [ ] All 4 YAML files pass `meta-model.schema.json` validation
- [ ] Zero `sha256:pending` digests
- [ ] Zero `{BASE_IRI}` templates
- [ ] Zero naming inconsistencies
- [ ] All pattern-injected attributes defined
- [ ] Single data binding truth source
- [ ] All actions with retry policies are `isIdempotent: true`
- [ ] ADR-009 examples complete with M2 OWL + M1 instances
- [ ] CI pipeline validates all assertions

## Non-Goals

- Full SHACL shape generation (deferred to implementation)
- Complete transformation library (sample only)
- Production-ready OWL reasoner integration (validation only)
- Comprehensive test suite (regression tests only)

## Timeline

- Schema rewrite: 2 hours
- IRI resolution: 1 hour
- Module digests: 1 hour
- Naming consistency: 2 hours
- Pattern semantics: 3 hours
- Data binding cleanup: 1 hour
- Action safety: 30 minutes
- ADR-009 validation: 4 hours

**Total estimated effort**: 14.5 hours

## Status Tracking

| Issue | Status | Blocking |
|-------|--------|----------|
| P0-1 Schema mismatch | 🔴 Not Started | Yes |
| P0-2 Module digests | 🔴 Not Started | Yes |
| P0-3 IRI templates | 🔴 Not Started | Yes |
| P0-4 Naming | 🔴 Not Started | Yes |
| P0-5 Pattern semantics | 🔴 Not Started | Yes |
| P0-6 Data binding | 🔴 Not Started | Yes |
| P0-7 Action safety | 🔴 Not Started | Yes |

**Current blocker count**: 7 P0 issues

## Notes

- This ADR documents the fix plan; implementation evidence will be tracked separately
- After P0 fixes, ADR-004 through ADR-009 status remains "Proposed" until implementation checklist completion
- Final acceptance requires passing CI validation pipeline (not yet implemented)
