# ADR-018: Post-Trade CQ Coverage Matrix (v1.0.0)

**Status**: Accepted  
**Date**: 2026-08-03  
**Context**: fin-post-trade-operations exports 300+ symbols; v1.0.0 cannot require one CQ per type

## Decision

### Coverage matrix (minimum active CQs @ v1.0.0)

| Subdomain | Minimum CQs | v1.0.0 IDs |
|-----------|-------------|------------|
| Corporate action core | 2 | CQ-PTO1, CQ-PTO5 |
| Exotic CA (ADR-016 top-3) | 3 | CQ-PTO6, CQ-PTO7, CQ-PTO8 |
| Settlement | 2 | CQ-PTO3, CQ-PTO4 |
| Reconciliation | 1 | CQ-PTO2 |
| Election / due-bill | 2 | CQ-PTO9, CQ-PTO10 |

**Target:** at least **10 active CQs** with pos/neg fixture pairs.

### Orphan export policy

Exported types without an active CQ must be either:

1. Covered by a subdomain CQ above, or
2. Listed in ADR-016 defer backlog with `status: review` terminology, or
3. Marked `deprecatedExport: true` in module governance notes (future minor only)

Silent orphan exports are **not** allowed at v1.0.0 sign-off.

## References

- [ADR-016](ADR-016-defer-exotic-corporate-actions.md)
- [fin-post-trade-cq.yaml](../../ontology/competency-questions/fin-post-trade-cq.yaml)
