# M2 Domain Progress Report

**Status**: **Approved** (v1.0.0 semantic release)  
**Date**: 2026-08-03  
**Review**: [M2-REVIEW-ROUND-12.md](M2-REVIEW-ROUND-12.md)

## Executive summary

Ten finance modules at `version: 1.0.0` are **`approved`** per RFC-001 semantic acceptance and ADR-017 completion criteria. Round-12 closes M2 ontology engineering; M1 materialization may begin via [M2-V1.0.0-M1-HANDOFF.md](../handoffs/M2-V1.0.0-M1-HANDOFF.md). Machine gates (`test-all-domain`, CQ probes) remain regression signals only — not the approval bar.

## Progress matrix (semantic primary)

| Module | Rubric | Gap P0/P1/P2 | Core CQ active | Lifecycle link | Status |
|--------|--------|----------------|----------------|----------------|--------|
| foundation | pass | closed | **active** (4) | yes | **approved** @ 1.0.0 |
| market-structure | pass | closed | **active** (4) | yes | **approved** @ 1.0.0 |
| instruments | pass | closed | **active** (3) | yes | **approved** @ 1.0.0 |
| market-rules | pass | closed | **active** (3) | yes | **approved** @ 1.0.0 |
| market-data | pass | closed | **active** (7) | yes | **approved** @ 1.0.0 |
| portfolio-positions | pass | closed | **active** (7) | yes | **approved** @ 1.0.0 |
| orders-execution | pass | closed | **active** (10) | yes | **approved** @ 1.0.0 |
| strategy-research | pass | closed | **active** (8) | yes | **approved** @ 1.0.0 |
| risk | pass | closed | **active** (5) | yes | **approved** @ 1.0.0 |
| post-trade-operations | pass | closed | **active** (10) | yes | **approved** @ 1.0.0 |

## Lifecycle story

See [M2-LIFECYCLE-STORY.md](../planning/M2-LIFECYCLE-STORY.md). End-to-end narratability verified for Round-12 (instrument → rules/data → order → portfolio → strategy → risk → post-trade). Slice A/B synthetic M1 chain documented in [traceability matrices](../../ontology/traceability/).

## Smoke reference (not acceptance)

| Check | Role | Last run |
|-------|------|----------|
| `node scripts/domain/test-all-domain.js` | YAML/compile smoke | PASS (2026-08-03) |
| `node scripts/domain/run-all-cq-probes.cjs` | CQ honesty probes | **120+ PASS / 0 PENDING / 0 FAIL** (60+ CQs) |
| `node scripts/domain/run-pyshacl-smoke.cjs` | Optional pySHACL smoke | PASS — [shacl-smoke-evidence.json](../infrastructure/shacl-smoke-evidence.json) (2026-08-03) |
| `node scripts/meta/test-all.js` | M3 meta-model smoke | run separately |
| pySHACL Tier-2 SPARQL | Optional — not acceptance | see [SHACL-RUNTIME-NOTES.md](../infrastructure/SHACL-RUNTIME-NOTES.md) |

## Revoked narratives

v0.2.0 `approved` claims remain revoked per [ADR-015](ADR-015-revoke-v0.2.0-approval.md). Do not cite Round-9 or digest-based registry as completion. v0.3.0 Round-11 is superseded as final sign-off by Round-12 / v1.0.0 per [ADR-017](ADR-017-m2-v1-completion-and-m1-handoff.md).

## Governance

- Module registry: `ontology/domain/finance/registry/module-registry.yaml` (10 modules @ 1.0.0, no digest fields)
- Release path: [ADR-014](ADR-014-m2-release-governance.md) semantic review + Round sign-off
- v1.0.0 completion: [ADR-017](ADR-017-m2-v1-completion-and-m1-handoff.md), post-trade matrix [ADR-018](ADR-018-post-trade-cq-coverage-matrix.md)
- Gap detail: [gap/](gap/) — all closed at v1.0.0
