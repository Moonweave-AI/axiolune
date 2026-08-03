# Axiolune Canonical Documentation Index

**Last updated**: 2026-08-03  
**M2 status**: **Approved** v1.0.0 → see [PROGRESS-REPORT](domain/decisions/PROGRESS-REPORT.md) and [Round-12](domain/decisions/M2-REVIEW-ROUND-12.md)

## M2 domain (finance)

| Need | Path |
|------|------|
| Scope blueprint | [docs/domain/planning/M2-PLAN.md](domain/planning/M2-PLAN.md) |
| Semantic quality rubric | [docs/domain/planning/M2-SEMANTIC-QUALITY-RUBRIC.md](domain/planning/M2-SEMANTIC-QUALITY-RUBRIC.md) |
| Semantic acceptance contract | [docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md](domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md) |
| Honest progress | [docs/domain/decisions/PROGRESS-REPORT.md](domain/decisions/PROGRESS-REPORT.md) |
| Current review | [docs/domain/decisions/M2-REVIEW-ROUND-12.md](domain/decisions/M2-REVIEW-ROUND-12.md) |
| Prior v0.3.0 review | [docs/domain/decisions/M2-REVIEW-ROUND-11.md](domain/decisions/M2-REVIEW-ROUND-11.md) |
| v1.0.0 completion + M1 handoff | [docs/domain/decisions/ADR-017-m2-v1-completion-and-m1-handoff.md](domain/decisions/ADR-017-m2-v1-completion-and-m1-handoff.md) |
| Post-trade CQ matrix | [docs/domain/decisions/ADR-018-post-trade-cq-coverage-matrix.md](domain/decisions/ADR-018-post-trade-cq-coverage-matrix.md) |
| M1 handoff entry | [docs/domain/handoffs/M2-V1.0.0-M1-HANDOFF.md](domain/handoffs/M2-V1.0.0-M1-HANDOFF.md) |
| v0.2.0 revocation | [docs/domain/decisions/ADR-015-revoke-v0.2.0-approval.md](domain/decisions/ADR-015-revoke-v0.2.0-approval.md) |
| Exotic CA defer (P2) | [docs/domain/decisions/ADR-016-defer-exotic-corporate-actions.md](domain/decisions/ADR-016-defer-exotic-corporate-actions.md) |
| Authoring profile | [docs/domain/decisions/ADR-013-m2-authoring-profile.md](domain/decisions/ADR-013-m2-authoring-profile.md) |
| Release governance | [docs/domain/decisions/ADR-014-m2-release-governance.md](domain/decisions/ADR-014-m2-release-governance.md) |
| Module gaps | [docs/domain/decisions/gap/](domain/decisions/gap/) |
| Module alignments | [docs/ontology/alignments/](ontology/alignments/) |
| Traceability matrices | [docs/ontology/traceability/](ontology/traceability/) |
| Risk CQ trace | [risk-order-trace-v03.yaml](../../../tests/m2/fixtures/positive/risk-order-trace-v03.yaml) (CQ-R4) |
| Risk stress CQ | [risk-stress-scenario-v03.yaml](../../../tests/m2/fixtures/positive/risk-stress-scenario-v03.yaml) (CQ-R5) |
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
| Module inventory | [ontology/domain/finance/registry/module-registry.yaml](../../ontology/domain/finance/registry/module-registry.yaml) |

## M3 meta-model

| Need | Path |
|------|------|
| Meta-model YAML | [ontology/meta/](meta/) |
| M3 ADRs | [docs/meta/decisions/](meta/decisions/) |

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
```
