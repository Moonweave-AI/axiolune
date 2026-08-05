# RFC-004 SME Review — `fin-orders` Architecture Open Questions

**Date**: 2026-08-05 (prepared for SME joint review)
**Status**: Open — awaiting SME sign-off. This document records recommended answers for SME discussion; it is **not** an approval. No SME has signed off yet.
**Scope**: RFC-004 open questions Q1–Q7, gating the ADR-026/027/028 follow-ups and the final closure of ADR-025.
**Related**: [RFC-004](../planning/RFC-004-orders-execution-architecture.md), [ADR-025](ADR-025-orders-execution-architecture.md), [M2-REVIEW-ROUND-15](M2-REVIEW-ROUND-15.md)

## Purpose

ADR-025 (Accepted, v1.1.0) implemented the ten P0 revisions and the P1 corrections in place. Three items require SME / cross-module input before they can be Accepted: OE-A7 (quotation-convention broadening, gated on ADR-021), OE-A9 (allocation boundary, gated on post-trade-operations), and OE-A10 (layer split). RFC-004 poses seven open questions; this document records a recommended answer for each, derived from the implemented v1.1.0 module, the FIX/ISO 20022/ESMA/SEC evidence pointers, and the ADR-020..024 precedent. SME review may accept, modify, or reject each recommendation.

## Recommended answers

### Q1. v1 scope (SME: execution + multi-asset)

**Question**: Is v1 explicitly scoped to single-instrument, direct-unit, single-account, non-anonymous, no-allocation orders? If not, OE-A5/A7/A9 must enter the design.

**Recommendation**: **Yes — v1.1.0 is explicitly scoped.** ADR-025 D7 narrows the module definition to "single-instrument, direct-unit quotation orders; multi-leg and non-direct-unit quotation are scaffolded as extension points." D5 relaxes bilateral contra roles to optional (anonymous fills expressible). D9 adds allocation as a scaffold. The scope is honest and documented; the broadening is gated on ADR-026 (quotation) and ADR-027 (allocation). v1.1.0 does **not** claim to cover multi-leg, non-direct-unit, or full allocation workflow.

**SME decision**: ☐ Accept ☐ Modify ☐ Reject — _________

### Q2. Bilateral vs account-side (SME: execution + market microstructure)

**Question**: Confirm the `Execution` (account-side fill/report) vs `MatchedTrade` (bilateral, contra-roles-when-evident) split and the `disclosureStatus` semantics. FIX contra group is optional.

**Recommendation**: **Confirm.** v1.1.0 implements exactly this: `Execution` has optional `contraAccount`/`contraParty` (0..1) + `disclosureStatus`; a "unknown Party"/"unknown Account" placeholder is forbidden by `ExecutionContract`. `MatchedTrade` (association) requires `matchedContraParty`/`matchedContraAccount` + `disclosureStatus` + `matchId` only when bilateral evidence suffices. This matches FIX's optional contra group and prevents fabricated counterparties. Staged: `orders-execution-v11-positive.yaml` has a `MatchedTrade` fixture; CQ-OE14 verifies.

**SME decision**: ☐ Accept ☐ Modify ☐ Reject — _________

### Q3. Routing and SOR (SME: execution + routing)

**Question**: Confirm `OrderRoute` shape (parent/child, destination, routedQty, routeTime, routeStatus/reason) and whether venue-neutral intent is permitted without a listing/OTC binding.

**Recommendation**: **Confirm.** v1.1.0 `OrderRoute` has `routeParentIntent` (1..1), `routeChildExternalOrder`/`routeChildIntent` (0..1 each, at least one), `routeDestination` (0..1), `routedQuantity` (1..1), `routeTime` (1..1), `routeStatus` (1..1), `routeReason` (0..1). `OrderIntentRoutingPolicy` admits three mutually exclusive context modes: exactly-one listing/OTC, OR `acceptableVenueSet` (1+), OR `routingPolicy` — so venue-neutral/SOR/broker-decides-venue intents are expressible without a single listing/OTC. Staged: `OrderRoute` fixture; CQ-OE15 verifies.

**SME decision**: ☐ Accept ☐ Modify ☐ Reject — _________

### Q4. Allocation boundary (SME: execution + post-trade)

**Question**: Confirm whether `ExecutionAllocation`/`AllocationLine` lives in `fin-orders` (source execution → target accounts → quantity → status) or in `post-trade-operations`; and the stable cross-module reference.

**Recommendation**: **Scaffold in `fin-orders`, detail in `post-trade-operations`, `Execution` as the stable reference.** ADR-025 D9 placed the conservation-bound scaffold in `fin-orders`; ADR-027 (Proposed) defines the boundary: allocation *fact* in orders, allocation *instruction/workflow/clearing* in post-trade, linked by the `Execution` version IRI (IRI-stable). The import DAG stays orders → post-trade (not reverse). Staged: `ExecutionAllocation`+`AllocationLine` fixtures with 60+40=100 conservation; CQ-OE16 verifies.

**SME decision**: ☐ Accept ☐ Modify ☐ Reject — _________

### Q5. Layer split (SME: data engineering + quality)

**Question**: Confirm the boundary between domain facts and adapter/runtime/quality; confirm that implementation/tool/runtime/validator-evidence fields become evidence-of-interpretation, not existence conditions.

**Recommendation**: **Confirm the boundary; defer the physical split.** ADR-025 D10 document-deprecated the adapter/runtime/quality-existence conditions in v1.1.0 (they are evidence-of-interpretation, not existence conditions). ADR-028 (Proposed) defines the three-layer split (domain / adapter-mapping / quality-runtime) as a v2.0.0 major revision after SME sign-off, IRI-retentive (re-homed). This is the last step in the convergence order, not the first — the domain facts must be proven correct first (done in v1.1.0).

**SME decision**: ☐ Accept ☐ Modify ☐ Reject — _________

### Q6. Price generality (SME: multi-asset + instruments)

**Question**: Confirm the `OrderLeg`/`ExecutionLeg` extension points and the `QuotationConvention` adoption order (gated on ADR-021 instruments v2.0.0).

**Recommendation**: **Confirm.** v1.1.0 scaffolds `OrderLeg`/`ExecutionLeg` (optional, no legs for single-instrument) and the `executionQuotationConvention` hook (typed to `DirectUnitPriceQuotationContract` for now). ADR-026 (Proposed) broadens the hook to `QuotationConvention` and completes multi-leg semantics once `instruments` v2.0.0 (ADR-021 D1) ships. FX swap, multi-leg strategies, bond yield/spread, CDS upfront become expressible after that.

**SME decision**: ☐ Accept ☐ Modify ☐ Reject — _________

### Q7. Cancel/replace chain (SME: execution)

**Question**: Confirm `OrderRevision`/`OrderInstructionChange` with ClOrdID/OrigClOrdID-style chain vs a single fixed order ID.

**Recommendation**: **Confirm `OrderRevision`.** v1.1.0 implements `OrderRevision` with `revisionRequestId` (new request id), `revisionPreviousOrder`/`revisionRootOrder` (OrigClOrdID-style), `revisionKind` (replace/cancel/cancelReplace), `replacedTerms` (present only for replace/cancelReplace), `priorityPreserved`. The existing `OrderEventKind/Updated` is retained; rejection is via `ModifyRejected`/`CancelRejected` event kinds (not a flag on the revision). This matches FIX ClOrdID/OrigClOrdID. Staged: `OrderRevision` fixture; CQ-OE17 verifies; negative fixture `oe-v11-neg-revision-cancel-with-replaced-terms` covers the cancel+terms violation.

**SME decision**: ☐ Accept ☐ Modify ☐ Reject — _________

## SME sign-off

| Question | SME (name/role) | Decision | Date |
|---|---|---|---|
| Q1 scope | | | |
| Q2 bilateral | | | |
| Q3 routing | | | |
| Q4 allocation | | | |
| Q5 layer split | | | |
| Q6 price | | | |
| Q7 cancel/replace | | | |

Until SME sign-off is recorded here, ADR-026/027/028 remain Proposed and the ADR-025 "SME joint review" evidence item remains unchecked. The v1.1.0 module is Accepted for its additive in-place revision regardless (the SME-gated items are follow-ups, not blocking).

## External evidence pointers (untrusted input, to be confirmed by SME)

These are recorded from the originating review as SME-evidence pointers, **not** as provenance or asserted fact:
- FIX 5.0 SP2: ExecType, OrdStatus, Order State Changes, ExecutionReport (contra group optional, CumQty/LeavesQty/AvgPx), trade specification (ClOrdID/OrigClOrdID).
- ISO 20022: Business Areas, securities trade (allocation).
- ESMA: MiFIR Article 26 (transaction reporting: execution time, price, quantity, venue transaction ID).
- CFTC: 17 CFR 1.35 (bunched order back-allocation).
- SEC: Regulation SHO FAQ (short-sale long/short/short-exempt marking).

## References

- [RFC-004](../planning/RFC-004-orders-execution-architecture.md)
- [ADR-025](ADR-025-orders-execution-architecture.md), [ADR-026](ADR-026-orders-quotation-convention-broadening.md), [ADR-027](ADR-027-orders-allocation-boundary.md), [ADR-028](ADR-028-orders-layer-separation.md)
- [M2-REVIEW-ROUND-15](M2-REVIEW-ROUND-15.md)
