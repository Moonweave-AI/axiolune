# M2 Semantic Quality Rubric (Flights-inspired)

**Status**: Accepted  
**Date**: 2026-08-03  
**Applies to**: All 10 finance modules at v0.3.0

## Purpose

Provide a **content-first** review checklist inspired by the Flights ontology example (identity, constrained types, narratable definitions, integrity constraints, mapping coherence). This rubric maps onto **existing M2 dialect fields** — no new YAML fields such as `verbalizes` or `identify_by`.

## Rubric items

| # | Item | Where in M2 | Pass when |
|---|------|-------------|-----------|
| 1 | **Stable identity** | Object/Association `definition` (logical identity); Identifier types; participant keys | Reviewer can state business key without "current value" as source of truth |
| 2 | **Typed quantities** | `MoneyTypeDefinition`, `QuantityTypeDefinition`, `CodeListTypeDefinition`, `IdentifierTypeDefinition` | No bare `decimal` for money; codes versioned |
| 3 | **Narratable definition** | `definition` + terminology card (genus, differentia, excludes) | Non-expert can paraphrase what the concept is and is not |
| 4 | **Cross-entity integrity** | Association roles + constraints + negative fixture/story | At least one business counterexample explains why invalid data is rejected (Flights: Flight operated_by must match Aircraft carrier) |
| 5 | **Temporal / availability story** | `TemporalFact` pattern bindings; valid/knowledge/availability | Core facts explain three-axis as-of behavior; no implicit `now()` |
| 6 | **Competency questions** | `docs/ontology/competency-questions/fin-*-cq.yaml` | Core CQs `active`; question, expected, negative reason narratable — not stub |
| 7 | **Source traceability** | Terminology `sources`, alignments, `references.bibliography.yaml` | Locator to FIBO/ISO/engine reference — **no digest lock required** |
| 8 | **Mapping narrative** | `SemanticMappingDefinition` + synthetic slice | One story traces physical field → semantic slot for module's core fact |

## Module sign-off

Each module gap doc ends with:

```markdown
## Rubric sign-off
| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | yes/no | ... |
...
```

Round-11 requires all core exported concepts to pass items 1–6; items 7–8 required for modules with external alignment or mapping scope.

## Anti-patterns (automatic fail)

- Stub CQ file (`# stub`, two questions for 100+ types)
- CQ probe PASS with zero staging facts
- `approved` module with draft-only core CQs
- Inventing dialect fields to mimic Flights syntax
- Citing digest/gate PASS as rubric substitute
