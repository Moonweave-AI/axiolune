# M2 Review Round 10 — Stop-Ship Verdict

**Date**: 2026-08-03  
**Verdict**: **Stop-Ship / draft** (superseded by [Round-11](M2-REVIEW-ROUND-11.md) — approved 2026-08-03)  
**Basis**: Semantic gap analysis — not gate/digest counts

## Summary

M2 v0.3.0 ontology YAML is substantial (10 modules, expanded orders/portfolio/post-trade semantics), but **does not meet semantic acceptance** for `approved` release. Formal smoke (`test-all-domain`) may PASS; that is insufficient per ADR-015 and RFC-001.

## Blocking findings (P0)

| Finding | Evidence |
|---------|----------|
| Risk CQ stub (2 draft questions vs 63+ types) | `fin-risk-cq.yaml` |
| Post-trade CQ stub vs largest module | `fin-post-trade-cq.yaml`, 300+ types |
| CQ probes fake PASS on empty staging | `run-all-cq-probes.cjs` "v03 staging pending" |
| v0.2.0 false approved narrative | ADR-014 header, old module-registry |
| Lifecycle story not end-to-end narratable | gap docs, M2-LIFECYCLE-STORY draft |

## Non-blocking (reference only)

- `test-all-domain.js` structural smoke may PASS
- SHACL TTL artifacts exist under `docs/domain/infrastructure/` — not acceptance criteria

## Required before Round-11

1. All module semantic-gap P0/P1 closed or ADR-deferred
2. Flights rubric signed per module
3. Core CQs `active` with narratable negative examples
4. Lifecycle story demonstrable across 10 modules

## References

- [ADR-015](ADR-015-revoke-v0.2.0-approval.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [PROGRESS-REPORT](PROGRESS-REPORT.md)
