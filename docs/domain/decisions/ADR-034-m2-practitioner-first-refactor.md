# ADR-034: M2 Practitioner-First Refactor (Phase B)

**Status**: Proposed  
**Date**: 2026-08-07  
**created**: 2026-08-07  
**updated**: 2026-08-07  
**last_reviewed**: 2026-08-07  
**summary**: Authorize Phase B — multi-file module envelope, practitioner definitions, SME readability gate; pilot on fin-instruments.  
**canonical**: true  
**related**: [RFC-009](../planning/RFC-009-m2-practitioner-authoring-refactor.md), [ADR-016](ADR-016-typed-container-authoring-profile.md), [ADR-014](ADR-014-m2-release-governance.md), [M2-DEFINITION-STYLE-GUIDE.md](../planning/M2-DEFINITION-STYLE-GUIDE.md)  
**supersedes**: none  
**superseded_by**: none

## Context

Practitioner review (2026-08-07) established that M2 `module.yaml` files are **structurally valid but human-unreadable**: 916–8802 lines per module, 1100+ digest/contract fields, mechanical ISO-704 templates, and commingled domain + materialization concerns. Machine gates (`test-all-domain`, CQ probes) pass; finance SMEs cannot use the artifacts as domain documentation.

Round-12 / ADR-017 v1.0.0 approval addressed **semantic conformance**, not **authoring ergonomics**. ADR-029 D6 explicitly deferred physical separation of runtime/reproducibility profile to a follow-up — that follow-up is Phase B.

## Decision

**Accept Phase B — practitioner-first refactor in place (IRI-retentive, additive envelope split, no public entailment break during migration).**

### D1. Multi-file module envelope

Binding per [RFC-009](../planning/RFC-009-m2-practitioner-authoring-refactor.md):

- Source fragments: `module.core.yaml`, optional `module.profile.yaml`, optional `module.binding.yaml`.
- Compile target: `module.yaml` via `node scripts/domain/merge-module-envelope.cjs <module-dir> --write`.
- ADR-016 typed containers preserved; merge concatenates `attributeUses` by attribute IRI union.

### D2. Concern assignment

| Concern | Location |
|---------|----------|
| Business object/association/relation semantics | `module.core.yaml` |
| Assurance / implementation profiles (`*Profile`, profile-scoped constraints) | `module.profile.yaml` when separable; else annotated in core until W2 |
| Layer-4 `meta/data-binding` attributeUses, contract ref/digest attrs, probe locks | `module.binding.yaml` |
| Practitioner narrative entry | `docs/ontology/practitioner/fin-*-guide.md` |

### D3. Definition rewrite standard

All Phase B migrated modules MUST conform to [M2-DEFINITION-STYLE-GUIDE.md](../planning/M2-DEFINITION-STYLE-GUIDE.md). Legacy `"X, is a … used for …"` openings are **deprecated** for new/edited definitions.

### D4. Status and versioning during migration

- Modules mid-migration: `module.status` remains `approved` for v1.x/v2.x baseline; envelope migration tracked in PROGRESS-REPORT wave column.
- Phase B completion per module: patch bump (e.g. 2.0.0 → 2.0.1) when only definitions/split; minor bump if profile types move files without IRI change.
- Breaking IRI/entailment changes still require ADR-014 major path — Phase B does not authorize breaks.

### D5. Acceptance gate

RFC-001 **Axis 6 (Practitioner readability)** becomes blocking for Phase B sign-off per module (see RFC-009). Until axis 6 passes, modules MUST NOT claim "practitioner-ready" in PROGRESS-REPORT.

### D6. Pilot

**Wave W0: `fin-instruments`** — split envelope + rewrite core definitions + practitioner guide + merge/regression. Other modules follow RFC-009 wave schedule.

### D7. Tooling

- `scripts/domain/lib/load-module-envelope.cjs` — load merged view from fragments or legacy single file.
- `scripts/domain/merge-module-envelope.cjs` — deterministic merge/write.
- `scripts/domain/split-module-envelope.cjs` — bootstrap split from legacy `module.yaml` (binding extraction heuristics).
- `test-all-domain` step: warn if fragments exist and merged `module.yaml` is stale (byte compare).

## Consequences

**Positive**

- Domain experts can read `module.core.yaml` and practitioner guides without digest noise.
- Materialization concerns become Layer-4 engineer territory.
- Rubric #3 (narratable definition) becomes enforceable.

**Negative**

- Dual maintenance during migration (fragments + merged artifact).
- All generators must eventually call envelope loader (W1+).
- SME time required for axis 6 — not automatable.

**Neutral**

- Public IRIs and OWL projection unchanged during split-only waves.
- Visualization continues to read merged `module.yaml` until loader wired.

## Alternatives rejected

| Option | Why rejected |
|--------|--------------|
| Rewrite definitions only, no split | Does not remove 1100+ binding field noise from practitioner view |
| Physical module split now (fin-portfolio-runtime, etc.) | Cross-module import churn; ADR-029 deferred for cause |
| New dialect fields (`businessAlias`, `verbalizes`) | Violates ADR-016 / user rubric mapping constraint |
| Revoke v1.0.0 approval | Over-scoped; semantic content largely sound — packaging failed |

## Implementation tasks

1. ✅ RFC-009 + M2-DEFINITION-STYLE-GUIDE + envelope tooling (W0)
2. ☐ instruments W0 SME axis-6 review
3. ☐ Wire `load-module-envelope` into validate-m2-core / generate-m2-owl (W1)
4. ☐ Migration waves W1–W3
5. ☐ PROGRESS-REPORT + Round-20 practitioner supplement

**Owner / DRI**: repository-owner (proposed) — SME reviewers TBD per module wave.
