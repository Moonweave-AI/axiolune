# P0 Remaining Issues - Resolution Summary

**Date**: 2026-07-28  
**Session**: Post-automated fixes  
**Status**: 4/7 Complete

## Completed in This Session ✅

### P0-2: Module Reproducibility ✅
- ✅ All `sha256:pending` replaced with actual digests
- ✅ Version conflict fixed (data-binding → behavior v0.4.0)
- ✅ 83 automated fixes applied

### P0-3: IRI Template Resolution ✅
- ✅ All 76 `{BASE_IRI}` templates resolved
- ✅ No more double-slash IRI bugs
- ✅ All IRIs globally unique

### P0-4: Naming Consistency ✅
- ✅ 26 renames to `*Definition` suffix
- ✅ All meta-types follow ADR-004 convention

### P0-7: Action Safety ✅
- ✅ SubmitOrder: removed retryPolicy
- ✅ Changed `conditionallyIdempotent` → `nonIdempotent`
- ✅ Added ADR-008 compliance note

**Automated fixes applied**: 110 total changes  
**Committed**: commit 279d99d  
**Pushed**: origin/main

---

## Remaining Work - Critical Analysis 🔴

### P0-1: Schema Rewrite 🔴

**Current blocker**: Schema expects flat `definitions[]` array, YAMLs use hierarchical structure.

**Complexity**: High - requires complete Schema rewrite  
**Estimated effort**: 2-3 hours  
**Decision**: Preserve hierarchical YAML structure (better for governance), rewrite Schema to match

**Why not done in this session**: 
- Schema rewrite requires careful validation of all 12+ definition types
- Must add missing types: AssociationTypeDefinition, ExecutionRecordDefinition, etc.
- Risk of breaking existing validation logic

**Recommendation**: Handle in dedicated session with full validation testing

---

### P0-5: Pattern Semantics 🟡 PARTIALLY ADDRESSABLE

#### Issue 5.1: Conflict Symmetry ✅ CAN FIX NOW
```yaml
# TemporalFact currently has NO conflicts declared
# Need to add:
conflicts:
  - "https://axiolune.ai/ontology/meta/patterns/patterns/TemporalObservation"
```

**Impact**: Low risk, straightforward YAML edit  
**Can be fixed**: Yes, in this session

#### Issue 5.2: Missing Attribute Definitions 🔴 REQUIRES SEMANTIC DECISIONS

**Problem**: Pattern-injected attributes like `validFrom`, `knowledgeFrom`, etc. are referenced but not defined as `AttributeTypeDefinition` in core-meta-model.yaml.

**Required additions** (13 new AttributeTypeDefinition entries):
1. `validFrom` - instant, required for TemporalFact
2. `validTo` - instant, optional for TemporalFact
3. `knowledgeFrom` - instant, required for TemporalFact
4. `knowledgeTo` - instant, optional for TemporalFact
5. `observedAt` - instant, optional for observations
6. `availableAt` - instant, optional for availability tracking
7. `publishedAt` - instant, optional from PublicationTiming
8. `receivedAt` - instant, optional from PublicationTiming
9. `source` - uri, required for ProvenancedFact
10. `sourceVersion` - string, optional
11. `confidence` - decimal, optional, range 0.0-1.0
12. `revision` - integer, optional
13. `derivedFrom` - list[uri], optional

**Complexity**: Medium - each AttributeTypeDefinition needs:
- Proper IRI (using correct baseIri)
- ISO 704 definition (genus-differentia structure)
- OWL projection rules
- Value type mapping
- Constraints

**Estimated effort**: 2-3 hours to write 13 complete AttributeTypeDefinition entries with proper semantics

**Why not done**: Requires semantic precision for ontological correctness, not just mechanical fixes

---

### P0-6: Data Binding Single Truth Source 🟡 PARTIALLY ADDRESSABLE

**Current violations**:
1. ❌ `Dataset.semanticMappings` field exists (duplicate truth source)
2. ❌ `SemanticMappingDefinition` type exists (should be removed)
3. ❌ Free-form transformation expressions still present

**Can be fixed mechanically**:
```yaml
# REMOVE from data-binding-meta-model.yaml:
Dataset.semanticMappings  # Lines ~200-205
SemanticMappingDefinition  # Entire section ~300-350
```

**Requires semantic review**:
- Verify no other references to removed types
- Ensure Field.semanticMapping is truly sufficient
- Check that all examples use typed TransformationReference

**Estimated effort**: 1 hour (mechanical removal + verification)

**Why partially done**: Can remove duplicate structures, but need to verify integrity

---

## What I Can Fix Right Now (Low Risk)

### 1. P0-5.1: Add Conflict Symmetry ✅
One-line YAML addition, zero risk:
```yaml
# In TemporalFact pattern definition
conflicts:
  - "https://axiolune.ai/ontology/meta/patterns/patterns/TemporalObservation"
```

### 2. P0-6: Remove Duplicate Data Binding Structures 🟡
Medium risk, requires verification:
- Remove `Dataset.semanticMappings`
- Remove `SemanticMappingDefinition` type
- Verify no broken references

---

## What Should Wait for Next Session (High Risk)

### 1. P0-1: Schema Rewrite
**Reason**: Full validation infrastructure needed, risk of breaking existing validation

### 2. P0-5.2: AttributeTypeDefinition additions
**Reason**: Requires semantic precision, ISO 704 definitions, proper OWL projections - not mechanical fixes

---

## Recommendation for This Session

**Option A (Conservative)**: 
- ✅ Fix P0-5.1 conflict symmetry (5 minutes)
- ✅ Document remaining work
- ✅ Create tracking issues
- ⏸️ Stop here, commit progress

**Option B (Aggressive)**:
- ✅ Fix P0-5.1 conflict symmetry
- 🟡 Attempt P0-6 duplicate removal (with rollback plan)
- 🔴 Start P0-5.2 attribute definitions (time-boxed)
- ⚠️ Risk: May introduce incomplete semantics

**My recommendation**: Option A + detailed specification for next session

---

## Current State Assessment

### Validation Status
```bash
# What works now:
✅ YAML syntax: all 4 files parse correctly
✅ Module digests: all resolved, reproducible builds enabled
✅ IRI resolution: no templates, no double-slashes
✅ Naming: consistent *Definition suffix
✅ Action safety: SubmitOrder complies with ADR-008

# What still fails:
❌ JSON Schema validation: structural mismatch (P0-1)
❌ Symbol resolution: 13 attributes referenced but undefined (P0-5.2)
❌ Data binding: dual truth sources violate ADR-007 (P0-6)
```

### Progress Metrics
- **Automated fixes**: 110 changes (100% complete)
- **Manual fixes**: 1 of 4 complete (P0-7 only)
- **Overall completion**: 4/7 = 57.1%
- **Blocking issues remaining**: 3 (P0-1, P0-5.2, P0-6)

### Risk Assessment

**Can ship current state?** ❌ No
- Schema validation fails
- Pattern semantics incomplete (missing attributes)
- Data binding has conflicting truth sources

**Can use for development?** 🟡 Partially
- Core structure is sound
- Module system works
- Naming is consistent
- Action safety model is correct

**What breaks without remaining fixes?**
- P0-1: Any JSON Schema validation tooling
- P0-5.2: Pattern composition at runtime (missing attribute definitions)
- P0-6: Data ingestion (ambiguous mapping rules)

---

## Next Session Preparation

### Pre-work Required
1. Write ISO 704 definitions for 13 temporal/provenance attributes
2. Design OWL projection rules for bi-temporal attributes
3. Audit all data-binding-meta-model.yaml references to SemanticMappingDefinition
4. Draft new meta-model.schema.json structure supporting hierarchical validation

### Acceptance Criteria for "Done"
- [ ] All 4 YAML files pass JSON Schema validation
- [ ] All pattern-injected attributes defined in core-meta-model.yaml
- [ ] Zero references to removed data binding types
- [ ] ADR-009 examples regenerate with complete M3→M2→M1 chain
- [ ] CI validation pipeline passes (when implemented)

---

## Conclusion

**This session achieved**: 57% completion, all automatable fixes done, critical action safety fixed

**Next session must address**: Schema rewrite (2-3h), attribute definitions (2-3h), data binding cleanup (1h)

**Estimated total remaining effort**: 5-7 hours of careful semantic work

**Current state**: Suitable for architecture review, NOT suitable for production or acceptance sign-off
