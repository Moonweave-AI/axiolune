# M2 Domain Progress Report

**Status**: **Approved** (v1.0.0 semantic release + v1.1.0/v2.0.0 architecture revisions)  
**Date**: 2026-08-07  
**Baseline review**: [M2-REVIEW-ROUND-12.md](M2-REVIEW-ROUND-12.md) (v1.0.0 completion)  
**Architecture wave**: Rounds [13](M2-REVIEW-ROUND-13.md)–[19](M2-REVIEW-ROUND-19.md) (2026-08-04–05)

## Executive summary

Ten finance modules remain **`approved`** per RFC-001 semantic acceptance and ADR-017 completion criteria. Round-12 closed the v1.0.0 M2 ontology engineering baseline; Rounds 13–19 independently reviewed each module and landed additive architecture revisions (Option B: generic semantic core + optional assurance profiles) as v1.1.0 or v2.0.0 per ADR-020–033. M1 materialization may proceed via [M2-V1.0.0-M1-HANDOFF.md](../handoffs/M2-V1.0.0-M1-HANDOFF.md). SME RFC gates (RFC-005–008) for portfolio, post-trade, risk, and strategy-research remain **outstanding** — not fabricated.

Machine gates (`test-all-domain`, CQ probes) remain regression signals only — not the approval bar.

## Progress matrix (semantic primary)

| Module | Version | Rubric | Architecture ADR | Review round | Status |
|--------|---------|--------|------------------|--------------|--------|
| foundation | **2.0.0** | pass | [ADR-020](ADR-020-foundation-identity-architecture.md) | Round-12 + identity revision | **approved** |
| market-structure | 1.1.0 | pass | [ADR-024](ADR-024-market-structure-architecture.md) | [Round-14](M2-REVIEW-ROUND-14.md) | **approved** |
| instruments | **2.0.0** | pass | [ADR-021](ADR-021-instruments-architecture.md) | identity revision | **approved** · Phase B W0 envelope |
| market-rules | 1.1.0 | pass | [ADR-023](ADR-023-market-rules-architecture.md) | [Round-13](M2-REVIEW-ROUND-13.md) | **approved** |
| market-data | **2.0.0** | pass | [ADR-022](ADR-022-market-data-architecture.md) | identity revision | **approved** |
| portfolio-positions | 1.1.0 | pass | [ADR-029](ADR-029-portfolio-positions-architecture.md) | [Round-16](M2-REVIEW-ROUND-16.md) | **approved** (SME RFC-005 outstanding) |
| orders-execution | 1.1.0 | pass | [ADR-025](ADR-025-orders-execution-architecture.md) | [Round-15](M2-REVIEW-ROUND-15.md) | **approved** |
| strategy-research | 1.1.0 | pass | [ADR-033](ADR-033-strategy-research-architecture.md) | [Round-19](M2-REVIEW-ROUND-19.md) | **approved** (SME RFC-008 outstanding) |
| risk | 1.1.0 | pass | [ADR-032](ADR-032-fin-risk-architecture.md) | [Round-18](M2-REVIEW-ROUND-18.md) | **approved** (SME RFC-007 outstanding) |
| post-trade-operations | 1.1.0 | pass | [ADR-030](ADR-030-post-trade-operations-architecture.md) | [Round-17](M2-REVIEW-ROUND-17.md) | **approved** (SME RFC-006 outstanding) |

## Phase B — practitioner-first refactor (2026-08-07)

**Charter**: [ADR-034](ADR-034-m2-practitioner-first-refactor.md) (Proposed) · [RFC-009](../planning/RFC-009-m2-practitioner-authoring-refactor.md)

Practitioner review concluded M2 `module.yaml` files are machine-valid but not human-readable. Phase B splits authoring into `module.core.yaml` / `module.profile.yaml` / `module.binding.yaml` with merged compile to `module.yaml`. RFC-001 **Axis 6 (SME readability)** is proposed as a blocking gate per module.

| Wave | Module | Envelope | Practitioner guide | Axis 6 SME |
|------|--------|----------|-------------------|------------|
| W0 | instruments | **split + merged** | [fin-instruments-guide](../../ontology/practitioner/fin-instruments-guide.md) | **pending** |
| W1 | foundation, market-structure, market-data | not started | — | pending |
| W2 | market-rules, orders-execution, portfolio-positions | not started | — | pending |
| W3 | risk, strategy-research, post-trade-operations | not started | — | pending |

Semantic `approved` status for v1.x/v2.x baseline unchanged until Axis 6 passes; Phase B tracks packaging/readability separately.

## Version policy

- **v1.0.0** — Round-12 RFC-001 semantic acceptance baseline (2026-08-03).
- **v2.0.0** — Major identity/architecture revision for foundation, instruments, market-data (ADR-020–022); structural changes per ADR-014.
- **v1.1.0** — Additive in-place architecture revisions for seven modules (ADR-023–033); backward-compatible profile layering.

## Lifecycle story

See [M2-LIFECYCLE-STORY.md](../planning/M2-LIFECYCLE-STORY.md). End-to-end narratability verified for Round-12; v1.1.0/v2.0.0 revisions broaden business-semantic coverage per module architecture ADRs. Slice A/B synthetic M1 chain documented in [traceability matrices](../../ontology/traceability/).

## Smoke reference (not acceptance)

| Check | Role | Last run |
|-------|------|----------|
| `node scripts/meta/test-all.js` | M3 meta-model smoke | PASS (2026-08-07) |
| `node scripts/domain/test-all-domain.js` | YAML/compile smoke | PASS (2026-08-07) |
| `node scripts/domain/run-all-cq-probes.cjs` | CQ honesty probes | **199 PASS / 0 PENDING / 0 FAIL** (105 CQs) |
| `node scripts/domain/run-pyshacl-smoke.cjs` | Optional pySHACL smoke | see [shacl-smoke-evidence.json](../infrastructure/shacl-smoke-evidence.json) |
| `node scripts/domain/audit-sidecar-sync.cjs` | Sidecar/registry sync audit | run after sidecar updates |

## Revoked narratives

v0.2.0 `approved` claims remain revoked per [ADR-015](ADR-015-revoke-v0.2.0-approval.md). Do not cite Round-9 or digest-based registry as completion. v0.3.0 Round-11 is superseded as final sign-off by Round-12 / v1.0.0 per [ADR-017](ADR-017-m2-v1-completion-and-m1-handoff.md).

## Governance

- Module registry: `ontology/domain/finance/registry/module-registry.yaml` (10 modules; 3× v2.0.0 + 7× v1.1.0)
- Release path: [ADR-014](ADR-014-m2-release-governance.md) semantic review + Round sign-off
- v1.0.0 completion: [ADR-017](ADR-017-m2-v1-completion-and-m1-handoff.md)
- Architecture revisions: ADR-020–033 (Proposed/Accepted per ADR; SME RFCs outstanding where noted)
- Gap detail: [gap/](gap/) — P0 closed at v1.0.0; v1.1.0/v2.0.0 gaps tracked per module ADR
