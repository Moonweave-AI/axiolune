# RFC-001: M2 Semantic Conformance Profile and Domain Contract

**Status**: Accepted (semantic acceptance contract)  
**Date**: 2026-08-03  
**Scope**: 10 finance modules at v1.0.0 (Round-12)

## v1.0.0 extensions (ADR-017)

In addition to axes 1–5 below, v1.0.0 requires:

- Per-module [alignments](../../ontology/alignments/) sidecar
- Core terminology cards at `status: accepted`
- Per-module [traceability](../../ontology/traceability/) matrix
- Post-trade CQ coverage per [ADR-018](../decisions/ADR-018-post-trade-cq-coverage-matrix.md)
- Synthetic M1 chain templates (Slice A/B + MaterializationRun/PIT sidecars)
- Round-12 human review record

## Purpose

Define what **semantic completion** means for M2 finance domain modules. This RFC is the acceptance contract for `draft → approved`. It explicitly **does not** bind to `scripts/domain/release-profile/v0.3.0/` or digest/byte-lock gates.

## Acceptance axes (all required for module approval)

### 1. Flights quality rubric

Each module's exported core concepts must pass [M2-SEMANTIC-QUALITY-RUBRIC.md](M2-SEMANTIC-QUALITY-RUBRIC.md): identity, typed quantities, narratable definitions, cross-entity integrity, temporal story, active CQs, source locators, mapping narrative.

### 2. Dual-track gap closure

Per-module [gap doc](../decisions/gap/) must show P0/P1 cleared. Track A = M2-PLAN scope; Track B = `reference/` alignment evidence.

### 3. Competency questions

Core CQs must be `status: active` with:

- Business question in plain language
- Expected result and negative rejection reason (narratable)
- `dependsOnElements` or equivalent IRI list
- At least one positive and one negative story (fixture or slice)

Stub CQs (`# stub`, 2-line placeholders) are **not** acceptable for approval.

### 4. Lifecycle coherence

Module must connect to [M2-LIFECYCLE-STORY.md](M2-LIFECYCLE-STORY.md) without boundary breaks.

### 5. Human review record

Round-12 (v1.0.0) review document signs off per module.

## Explicitly not acceptance criteria

- `artifactDigest` / `sha256:` locks
- `references.lock.yaml` digest closure
- `run-release-capability` or 21-gate matrix PASS
- release bundle / tamper evidence JSON
- `test-all-domain` PASS alone
- pySHACL fixture count KPIs

## Module approval workflow

```
draft → review (gap + rubric + CQ) → approved (Round-11 @ 0.3.0)
review → approved (Round-12 @ 1.0.0 — ontology engineering complete)
```

Only ADR-014 governs the state transition; no digest manifest required.

## Relationship to M2-PLAN §0.1

M2-PLAN §0.1 remains the long-form definition. This RFC **reweights** it: semantic items (definitions, CQs, lifecycle, alignment locators) are primary; OWL/SHACL byte-trace and lock files are **supporting smoke only**, not blockers for semantic approval when content is complete.
