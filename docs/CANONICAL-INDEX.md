# Axiolune Canonical Documentation Index

**Last updated**: 2026-08-07  
**M2 status**: **Approved** v1.0.0 baseline + v1.1.0/v2.0.0 architecture revisions → see [PROGRESS-REPORT](domain/decisions/PROGRESS-REPORT.md)

## M2 domain (finance)

| Need | Path |
|------|------|
| Scope blueprint | [docs/domain/planning/M2-PLAN.md](domain/planning/M2-PLAN.md) |
| Semantic quality rubric | [docs/domain/planning/M2-SEMANTIC-QUALITY-RUBRIC.md](domain/planning/M2-SEMANTIC-QUALITY-RUBRIC.md) |
| Semantic acceptance contract | [docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md](domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md) |
| Honest progress | [docs/domain/decisions/PROGRESS-REPORT.md](domain/decisions/PROGRESS-REPORT.md) |
| v1.0.0 baseline review | [docs/domain/decisions/M2-REVIEW-ROUND-12.md](domain/decisions/M2-REVIEW-ROUND-12.md) |
| Architecture review wave (R13–R19) | [Round-13](domain/decisions/M2-REVIEW-ROUND-13.md) … [Round-19](domain/decisions/M2-REVIEW-ROUND-19.md) |
| v1.0.0 completion + M1 handoff | [docs/domain/decisions/ADR-017-m2-v1-completion-and-m1-handoff.md](domain/decisions/ADR-017-m2-v1-completion-and-m1-handoff.md) |
| Post-trade CQ matrix | [docs/domain/decisions/ADR-018-post-trade-cq-coverage-matrix.md](domain/decisions/ADR-018-post-trade-cq-coverage-matrix.md) |
| Foundation v2.0.0 identity | [docs/domain/decisions/ADR-020-foundation-identity-architecture.md](domain/decisions/ADR-020-foundation-identity-architecture.md) |
| Instruments v2.0.0 | [docs/domain/decisions/ADR-021-instruments-architecture.md](domain/decisions/ADR-021-instruments-architecture.md) |
| Market-data v2.0.0 | [docs/domain/decisions/ADR-022-market-data-architecture.md](domain/decisions/ADR-022-market-data-architecture.md) |
| Market-rules v1.1.0 | [docs/domain/decisions/ADR-023-market-rules-architecture.md](domain/decisions/ADR-023-market-rules-architecture.md) |
| Market-structure v1.1.0 | [docs/domain/decisions/ADR-024-market-structure-architecture.md](domain/decisions/ADR-024-market-structure-architecture.md) |
| Orders-execution v1.1.0 | [docs/domain/decisions/ADR-025-orders-execution-architecture.md](domain/decisions/ADR-025-orders-execution-architecture.md) |
| Portfolio-positions v1.1.0 | [docs/domain/decisions/ADR-029-portfolio-positions-architecture.md](domain/decisions/ADR-029-portfolio-positions-architecture.md) |
| Post-trade v1.1.0 | [docs/domain/decisions/ADR-030-post-trade-operations-architecture.md](domain/decisions/ADR-030-post-trade-operations-architecture.md) |
| Risk v1.1.0 | [docs/domain/decisions/ADR-032-fin-risk-architecture.md](domain/decisions/ADR-032-fin-risk-architecture.md) |
| Strategy-research v1.1.0 | [docs/domain/decisions/ADR-033-strategy-research-architecture.md](domain/decisions/ADR-033-strategy-research-architecture.md) |
| M1 handoff entry | [docs/domain/handoffs/M2-V1.0.0-M1-HANDOFF.md](domain/handoffs/M2-V1.0.0-M1-HANDOFF.md) |
| v0.2.0 revocation | [docs/domain/decisions/ADR-015-revoke-v0.2.0-approval.md](domain/decisions/ADR-015-revoke-v0.2.0-approval.md) |
| Exotic CA defer (P2) | [docs/domain/decisions/ADR-019-defer-exotic-corporate-actions.md](domain/decisions/ADR-019-defer-exotic-corporate-actions.md) |
| Authoring profile (typed-container) | [docs/domain/decisions/ADR-016-typed-container-authoring-profile.md](domain/decisions/ADR-016-typed-container-authoring-profile.md) |
| Authoring profile (superseded) | [docs/domain/decisions/ADR-013-m2-authoring-profile.md](domain/decisions/ADR-013-m2-authoring-profile.md) |
| Release governance | [docs/domain/decisions/ADR-014-m2-release-governance.md](domain/decisions/ADR-014-m2-release-governance.md) |
| Module gaps | [docs/domain/decisions/gap/](domain/decisions/gap/) |
| Module alignments | [docs/ontology/alignments/](ontology/alignments/) |
| Traceability matrices | [docs/ontology/traceability/](ontology/traceability/) |
| Risk CQ trace | [risk-order-trace-v03.yaml](../tests/m2/fixtures/positive/risk-order-trace-v03.yaml) (CQ-R4) |
| Risk stress CQ | [risk-stress-scenario-v03.yaml](../tests/m2/fixtures/positive/risk-stress-scenario-v03.yaml) (CQ-R5) |
| Mapping narratives (P2+) | [docs/domain/planning/mapping-narratives/](domain/planning/mapping-narratives/) |
| Lifecycle story | [docs/domain/planning/M2-LIFECYCLE-STORY.md](domain/planning/M2-LIFECYCLE-STORY.md) |

## Sidecar evidence

| Need | Path |
|------|------|
| Reference bibliography (no digest locks) | [docs/ontology/references/references.bibliography.yaml](ontology/references/references.bibliography.yaml) |
| Terminology cards | [docs/ontology/terminology/](ontology/terminology/) |
| Competency questions | [docs/ontology/competency-questions/](ontology/competency-questions/) |
| SHACL runtime (optional) | [docs/domain/infrastructure/SHACL-RUNTIME-NOTES.md](domain/infrastructure/SHACL-RUNTIME-NOTES.md) |
| pySHACL smoke evidence | [shacl-smoke-evidence.json](domain/infrastructure/shacl-smoke-evidence.json) |
| Module inventory | [ontology/domain/finance/registry/module-registry.yaml](../ontology/domain/finance/registry/module-registry.yaml) |
| Cross-module Slice A CQs | [fin-cross-module-cq.yaml](ontology/competency-questions/fin-cross-module-cq.yaml) (CQ-S1, S2, S5) |
| Practitioner guides (Phase B) | [docs/ontology/practitioner/](ontology/practitioner/) |
| Phase B refactor charter | [ADR-034](domain/decisions/ADR-034-m2-practitioner-first-refactor.md) · [RFC-009](domain/planning/RFC-009-m2-practitioner-authoring-refactor.md) · [M2-DEFINITION-STYLE-GUIDE](domain/planning/M2-DEFINITION-STYLE-GUIDE.md) |
| Module envelope merge | `node scripts/domain/merge-module-envelope.cjs <module> --write` |

## M3 meta-model

| Need | Path |
|------|------|
| Meta-model YAML | [ontology/meta/](meta/) |
| M3 ADRs | [docs/meta/decisions/](meta/decisions/) |
| M3 metatype audit | [docs/meta/m3-metatype-audit.md](meta/m3-metatype-audit.md) |

## Visualization & Protege

| Need | Path |
|------|------|
| M3+M2 graph explorer | [visualization/](visualization/) — `node visualization/generate.cjs` |
| Protege export | `node scripts/protege/sync-protege-project.cjs` → `protege/00-entry/axiolune-all.owl.ttl` |

## Do not cite as completion evidence

- `docs/domain/decisions/superseded/`
- `releases/superseded/`
- v0.2.0 APPROVED narratives
- Round-11 alone as final v1.0.0 sign-off (superseded by Round-12)
- `scripts/domain/release-profile/` gate PASS alone
- Deleted `references.lock.yaml` digest locks

## Smoke commands (development only — not semantic acceptance)

```bash
node scripts/meta/test-all.js
node scripts/domain/test-all-domain.js
node scripts/domain/run-all-cq-probes.cjs   # CQ honesty probes (not acceptance alone)
node scripts/domain/run-pyshacl-smoke.cjs   # optional pySHACL evidence JSON
node scripts/domain/audit-sidecar-sync.cjs  # sidecar/registry sync audit
node visualization/generate.cjs && node visualization/assert-projection.cjs
```
