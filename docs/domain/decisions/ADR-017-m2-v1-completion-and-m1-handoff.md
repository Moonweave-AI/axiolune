# ADR-017: M2 v1.0.0 Completion and M1 Handoff

**Status**: Accepted  
**Date**: 2026-08-03  
**Context**: Ontology engineering completion before M1 materialization  
**Supersedes**: Round-11 as final M2 sign-off basis (Round-12 per this ADR)

## Context

Round-11 approved M2 finance domain at **v0.3.0** on semantic grounds (RFC-001). Remaining work blocks a clean handoff to **M1** (real data contracts, materialization production gate). v1.0.0 is the **last M2 ontology engineering release** before M1 work begins.

## Decision

### 1. v1.0.0 completion definition

M2 v1.0.0 is complete when **all** of the following hold:

| Axis | Requirement |
|------|-------------|
| RFC-001 + Round-12 | Human review record; all modules `approved` @ **1.0.0** |
| Gap closure | All P0/P1/P2 gap items **closed** or ADR-deferred with M1-only boundary |
| Sidecar evidence | Per-module `alignments.yaml`, terminology `accepted` for core exports, traceability matrix |
| CQ coverage | Active CQs with pos/neg fixtures; post-trade coverage matrix per ADR-018 |
| Synthetic M1 chain | Slice A/B replay verified; per-module MaterializationRun/PIT **templates** (synthetic) |
| Validation smoke | `test-all-domain` PASS; CQ probes 0 pending; pySHACL smoke covers all 10 modules |
| Semantic consistency | CQ/lifecycle IRIs match exported ontology types (no orphan CQ references) |

### 2. Explicitly NOT v1.0.0 (M1 / runtime)

- Real production table/column mapping (M2-PLAN section 10.4)
- `artifactDigest` / byte-lock manifests / `references.lock.yaml`
- `run-release-capability` 21-gate matrix
- L3 SubmitOrder / broker runtime safety gate
- Full post-trade type-by-type CQ (use coverage matrix instead)

### 3. Version bump

All ten finance modules and [module-registry.yaml](../../../ontology/domain/finance/registry/module-registry.yaml) move to **version: 1.0.0** upon Round-12 approval.

### 4. M1 handoff artifact

[docs/domain/handoffs/M2-V1.0.0-M1-HANDOFF.md](../handoffs/M2-V1.0.0-M1-HANDOFF.md) is the canonical entry point for M1 work.

## Consequences

- Ontology YAML changes after v1.0.0 require semver per ADR-014.
- M1 pilot ingest must not alter M2 IRIs without ADR.

## References

- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [ADR-014](ADR-014-m2-release-governance.md) (semantic release manifest)
- [ADR-018](ADR-018-post-trade-cq-coverage-matrix.md)
- [M2-REVIEW-ROUND-12.md](M2-REVIEW-ROUND-12.md)
