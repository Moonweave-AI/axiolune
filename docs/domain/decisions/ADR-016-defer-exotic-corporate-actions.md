# ADR-016: Defer Exotic Corporate Action Subtypes (Post-Trade P2)

**Status**: Accepted  
**Date**: 2026-08-03  
**Context**: M2 v0.3.0 post-trade-operations semantic approval (Round-11)  
**Related**: post-trade-operations-semantic-gap PTO-G2, CQ-PTO1

## Context

`fin-post-trade-operations` exports many corporate-action subtypes. Round-11 approval covers the **lifecycle-critical** matrix:

- cash dividend
- stock split
- rights issue
- due-bill / entitlement closure
- settlement and reconciliation chains (CQ-PTO2–PTO4)

Exotic or rarely modeled action kinds (e.g. tender offer, exchange offer, spin-off with complex entitlement trees, voluntary corporate action elections beyond the rights matrix) remain **exported types without active competency questions** in v0.3.0.

## Decision

1. **Promoted (v1.0.0)** exotic corporate-action subtype CQ coverage per [ADR-018](ADR-018-post-trade-cq-coverage-matrix.md): tender offer (CQ-PTO6), spin-off (CQ-PTO7), exchange offer (CQ-PTO8) with pos/neg fixtures.
2. Terminology cards for promoted kinds use `status: accepted` (see `fin-post-trade-operations-terms.yaml`).
3. **Do require** that any new exotic subtype promoted to `active` CQ must include:
   - narratable definition with genus/differentia/excludes
   - at least one positive contract fixture and one integrity negative
   - explicit consumer module link (portfolio holdings or settlement)
4. **SHACL** shapes for deferred subtypes may remain parse-verified only until a CQ is activated — do not claim runtime pySHACL PASS for deferred kinds.

## P2+ backlog (top deferred exotic kinds)

| Kind | FIBO / ISO anchor | Why deferred | Promotion criteria |
|------|-------------------|--------------|-------------------|
| Tender offer | FIBO CAE tender offer; ISO 15022 MT564 voluntary | Election + consideration tree beyond rights matrix | Active CQ-PTO1 extension + entitlement negative + portfolio consumer |
| Spin-off | FIBO CAE spin-off / demerger | Multi-leg entitlement projection not in v0.3.0 matrix | Positive/negative fixture pair + settlement chain |
| Exchange offer | FIBO CAE exchange offer | Security swap ratio differs from stock split | Mapping slice + reconciliation break narrative |

Terminology cards for these kinds use `status: review` until promotion (see `fin-post-trade-operations-terms.yaml`).

## Consequences

- PTO-G2 closed for v0.3.0 approval with documented deferral, not silent omission.
- Reduces false completeness from type count alone.
- Future work: pick top 3 exotic kinds from reference/ (FIBO CAE + ISO 15022) with engine evidence before expanding CQ-PTO1.

## References

- [post-trade-operations-semantic-gap.md](gap/post-trade-operations-semantic-gap.md)
- [M2-REVIEW-ROUND-11.md](M2-REVIEW-ROUND-11.md)
