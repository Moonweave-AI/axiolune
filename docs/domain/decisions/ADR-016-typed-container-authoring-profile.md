# ADR-016: M2 Typed-Container Authoring Profile

**Status**: Accepted  
**Date**: 2026-08-04  
**Supersedes**: ADR-013-m2-authoring-profile (inferred-type profile)  
**Related**: RFC-001 (semantic conformance), meta ADR-013 (M3 v0.6.0 baseline), M2-PLAN, ADR-014 (release governance)

## Context

M3 defines meta-types (`OntologyModuleDefinition`, `ObjectTypeDefinition`, `AssociationTypeDefinition`, `RelationTypeDefinition`, `AttributeTypeDefinition`, `IdentifierTypeDefinition`, `CodeListTypeDefinition`, `ConstraintDefinition`, and Layer 2–4 structures) but, prior to this ADR, did not fix how a domain (M2) YAML file declares which meta-type each element instantiates. The earlier profile (ADR-013) inferred the M3 type from the presence of M3 required-fields. Inference worked for a small fixture but did not scale to ten finance modules: ambiguous elements, dialect drift, and validators that could not distinguish a typed relation from a typed attribute without guessing.

RFC-001 (the M2 semantic conformance contract) requires a deterministic, machine-checkable authoring profile so that `validate-m2-core`, `generate-m2-owl`, `generate-m2-shacl`, and the typed projection generators all agree on what each domain element is. The M2 finance modules have already been migrated to explicit typed containers (the migration is complete in `ontology/domain/finance/*/module.yaml`); this ADR records that migration as the binding authoring profile and binds it to RFC-001.

## Decision

### 1. Typed-container authoring profile (binding)

Every M2 finance module YAML has exactly two top-level keys: `module` (an `OntologyModuleDefinition` instance) and `domain` (the element container). Under `domain:`, elements are grouped into **explicit typed containers** keyed by M3 meta-type:

| Container | M3 meta-type |
|-----------|--------------|
| `objectTypes` | `ObjectTypeDefinition` |
| `associationTypes` | `AssociationTypeDefinition` |
| `relationTypes` | `RelationTypeDefinition` |
| `attributeTypes` | `AttributeTypeDefinition` |
| `identifierTypes` | `IdentifierTypeDefinition` |
| `codeLists` | `CodeListTypeDefinition` |
| `constraints` | `ConstraintDefinition` |
| `relationUses` | `RelationUse` (contextual relation binding) |
| `constraintBindings` | `ConstraintBinding` |

The container name — not inferred field-shape — declares the M3 meta-type of every element inside it. Each entry is keyed by `localName`.

### 2. No `kind:` discriminant; container is the classifier

The typed-container name is the sole classifier. A `kind:` discriminant field is forbidden. This is consistent with M3's own convention (type-classifiers and instances are keyed by name, not by a `kind` field) while removing the inference ambiguity that the inferred-type profile (ADR-013) carried.

### 3. Validation and generation contract

- `validate-m2-core` accepts the `module` + `domain` root with the typed containers above and rejects unknown containers, unknown top-level keys, and any `kind:` field.
- `generate-m2-owl` / `generate-m2-shacl` / the typed projection generators read the typed containers directly; they do not infer meta-type from field shape.
- Dialect unity: the E5/E6 alternate dialects and the inferred-type dialect are non-canonical; `scripts/domain/migrate-to-v0.3-typed.cjs` is the one-way migration tool from the rejected flat dialect to this typed-container dialect.

### 4. Binding to RFC-001

This typed-container authoring profile is the authoring contract behind RFC-001's semantic conformance axes. RFC-001 acceptance (definitions, CQs, lifecycle, alignment locators) presumes that each domain element is already declared in its correct typed container; an element in the wrong container is an authoring failure before semantic review even begins. This ADR binds RFC-001 as the acceptance contract and the typed-container profile as the authoring contract.

### 5. Upstream baseline

This profile compiles against M3 v0.6.0 (meta ADR-013). The `patternBindings` in M2 modules reference the v0.6.0 cross-domain patterns; `MoneyTypeDefinition` / `QuantityTypeDefinition` structured-value projections and the `abstract` flag are the v0.6.0 semantics.

## Consequences

- M2 finance modules (`ontology/domain/finance/*/module.yaml`) use the `module` + `domain` envelope with typed containers — this is already the case in the codebase.
- ADR-013 (inferred-type profile) is Superseded; it remains as a historical record.
- `validate-m2-core` is the G0 gate; domain-specific validators are added per-module.
- Future M3 meta-types require a new typed container to be declared here (or a successor ADR) before M2 may instantiate them; M2 may not invent containers.
- The typed-container profile is the input contract for all M2 generation, projection, and visualization tooling that reads `ontology/domain/finance/*/module.yaml`.

## References

- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [meta ADR-013](../../meta/decisions/ADR-013-m3-v0.6.0.md) (M3 v0.6.0 baseline)
- [ADR-013](ADR-013-m2-authoring-profile.md) (superseded inferred-type profile)
- [M2-PLAN](../planning/M2-PLAN.md)
