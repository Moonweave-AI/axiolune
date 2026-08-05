# M2 Review Round 15 — `fin-orders` Architecture Review

**Date**: 2026-08-04
**Verdict**: **Retain; architecture revision required (P0). Release status: v1.0.0 → v1.1.0 (additive).**
**Scope**: `fin-orders` module only (post-v1.0.0 in-depth architecture review)
**Basis**: Independent architecture review of `ontology/domain/finance/orders-execution/module.yaml` v1.0.0
**Related**: Round-12 (v1.0.0 approval, acceptance contract), RFC-004 (architecture decision), ADR-025 (Accepted)

## Status of this review

This is a **post-release architecture review**, not a re-run of the Round-12 v1.0.0 acceptance contract. Round-12 approved `fin-orders` against the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance axes. That approval **stands** for the acceptance contract.

This review assesses whether the module covers a **complete, executable order-to-fill process with honest layer separation** — a stronger claim than the acceptance contract. It does not, as released, because the module conflates three layers: order/execution domain facts, provider raw-code mapping and adapter implementation, and runtime/validation/quality findings. The P0 issues below were verified by direct reading of `module.yaml` and `M2-PLAN §5.2`; they are structural, not stylistic.

## What was verified (untrusted-input handling)

Per the Moonweave governance baseline, the originating review text and its external regulatory citations (FIX ExecType/OrdStatus/Order State Changes/ExecutionReport/trade specification, ISO 20022 Business Areas/securities trade, ESMA MiFIR Article 26, CFTC 17 CFR 1.35, SEC Regulation SHO FAQ) were treated as **untrusted input**. Structural and semantic claims were re-derived against `module.yaml` and `M2-PLAN` directly. The external citations are recorded here as **SME-evidence pointers for the RFC**, not as provenance or asserted fact.

## Confirmed structural baseline

Per `module.yaml` v1.0.0: 7 object types, 8 association types, 10 relation types, ~47 attribute types, 15 code lists (82 values), 17 domain constraints, 42 constraint bindings. No files were modified, and no ontology tests, validators, or gates were run for this review (any execution result would be marked **unverified**).

## P0 — architecture issues (verified)

| # | Claim | Verified evidence | Required semantic |
|---|---|---|---|
| P0-1 | OrderIntent identity has no authority | [clientIntentId:872](../../ontology/domain/finance/orders-execution/module.yaml#L872) claims authority-scoped but no issuer/authority relation; constraint only `stable(clientIntentId)`. | `intentIssuer`/`intentIdentifierAuthority`; logical key `(authority, clientIntentId)`. |
| P0-2 | Lifecycle event mixes internal and external | [OrderLifecycleEvent:255](../../ontology/domain/finance/orders-execution/module.yaml#L255) is a provider event bound to ExternalOrder; state/event vocabularies include Initialized/Denied/Emulated/Released. | Split `OrderIntentLifecycleEvent` (internal) vs external `OrderLifecycleEvent`; only external binds provider/ExternalOrder/stream. |
| P0-3 | Mapping/profile not traceable on events | [ExternalOrderStatusMapping:531](../../ontology/domain/finance/orders-execution/module.yaml#L531), [OrderTransitionProfile:182](../../ontology/domain/finance/orders-execution/module.yaml#L182) exist but events carry no raw status/applied mapping/applied profile. | `rawProviderStatusCode`, `appliedStatusMapping`, `appliedTransitionProfile` on events; declarative `transitionTable` on profile. |
| P0-4 | Event—execution—cumulative loop missing | [OrderLifecycleEvent:255](../../ontology/domain/finance/orders-execution/module.yaml#L255) and [Execution:369](../../ontology/domain/finance/orders-execution/module.yaml#L369) parallel, sharing only stream + sourceOrderKey; no reportsExecution, no cumQty/leavesQty/avgPrice; [sourceOrderKey:1084](../../ontology/domain/finance/orders-execution/module.yaml#L1084) uniqueness claimed but only non-negativity checked. | `reportsExecution` relation; `FillSnapshot` with lastQty/cumQty/leavesQty/cancelledQty/averagePrice; Filled/PartiallyFilled vs net-quantity consistency; sourceOrderKey uniqueness. |
| P0-5 | Execution forces bilateral facts it cannot always know | [Execution:369](../../ontology/domain/finance/orders-execution/module.yaml#L369) forces contraAccount/contraParty 1..1; anonymous order books / client-side reports cannot supply these. | Relax contra roles to optional; `disclosureStatus`; `MatchedTrade` bilateral sibling requiring contra roles when evidence suffices. |
| P0-6 | Timing and venue identity insufficient | Only [observedAt](../../ontology/domain/finance/orders-execution/module.yaml#L1062); no executedAt/reportedAt/tradeDate; executionListing ≠ execution venue; no venueTradeId/providerReportId/matchId. | executedAt/providerReportedAt/tradeDate; `executionVenue` → TradingFacility; venueTradeId/providerReportId/matchId. |
| P0-7 | Price locked to single-asset direct-unit | Execution/OrderIntent price is MonetaryAmount + forced [DirectUnitPriceQuotationContract:441](../../ontology/domain/finance/orders-execution/module.yaml#L441); FX swap/multi-leg/bond yield/CDS upfront cannot be expressed. | Narrow v1 scope honestly; add `executionQuotationConvention` hook + `OrderLeg`/`ExecutionLeg`; broaden to QuotationConvention gated on ADR-021. |
| P0-8 | Context Xone forbids venue-neutral/SOR | [OrderIntentContextXone:2199](../../ontology/domain/finance/orders-execution/module.yaml#L2199) forces listing-or-OTC before provider acceptance. | `acceptableVenueSet`/`routingPolicy`; `OrderRoute` parent/child/destination/routedQty/routeTime/routeStatus. |
| P0-9 | No allocation; execution account forced = intent account | [ExecutionContract:2352](../../ontology/domain/finance/orders-execution/module.yaml#L2352) forces executionAccount = intentAccount; no allocation/block/bunched. | `ExecutionAllocation`/`AllocationLine` with conservation; relax account equality; detailed allocation in post-trade with stable reference. |
| P0-10 | Data-binding/runtime/quality written as existence conditions | [OrderIntentLineageContract:2321](../../ontology/domain/finance/orders-execution/module.yaml#L2321) validation runs/reports/ledgers; [OrderTransitionProfile:182](../../ontology/domain/finance/orders-execution/module.yaml#L182) impl/tool/runtime digests; [OrderEventIntegrityFinding:661](../../ontology/domain/finance/orders-execution/module.yaml#L661) probes/digests make a fact's existence depend on a runtime/validator. | Retain domain invariants; document-deprecate adapter/runtime/quality as evidence-of-interpretation; migrate to boundary modules in a follow-up ADR. |

## P1 — high-priority design corrections

1. **Cancel/replace chain.** `Updated` cannot replace a cancel/replace chain. Add `OrderRevision` with ClOrdID/OrigClOrdID-style chain, replace/cancel request, reject, replaced terms, priority-preserved.
2. **State/event vocabularies.** Add PendingNew, DoneForDay, Stopped, Suspended, Calculated, Restated, PendingReplace, TradeCorrect, TradeCancel, OrderStatus; allow event×post-state composition rather than a monolithic enum.
3. **OrderType/TIF.** Keep 6 as v1 core; build combination instructions (display/iceberg, min-qty, auction, peg, contingency, short-sale, open/close) as profile hooks governed by market-rules/venue; separate double-last/last-or-bid-ask from TriggerPriceBasis.
4. **OrderSide/capacity.** Separate direction, position-effect, short-sale indicator, agency/principal/riskless-principal capacity. SEC Reg SHO long/short/short-exempt markers.
5. **Party roles.** Versionable client/beneficial-owner, investment-decision-maker, execution-decision-maker, algorithm, transmitting-firm, executing-firm, reporting-party, clearing-member.
6. **Liquidity.** Distinguish domain-level added/removed, source-level neither/routed-out/auction/triggered, notApplicable/notReported/unknown. OTC bilateral is not "source-unsupported maker/taker" but role-not-applicable.
7. **Fee.** Fee effect relative to account/party; payer/payee/assessor, basis, tax jurisdiction, allocation-level fee; unify feeId scope with logical key.
8. **OrderEventStream naming.** Rename (definition) to `ExternalOrderEventSequence`; real provider feed/session as a separate optional concept.
9. **OrderEventIntegrityFinding.** Abstract Finding + kind-specific subject subtypes; lateFill not a-priori error (late report, cancel/fill race, trade correction, bust).

## What should be retained and strengthened

- `OrderIntent` / `ExternalOrder` separation.
- Event-kind ≠ resulting-state separation ([OrderLifecycleState:1829](../../ontology/domain/finance/orders-execution/module.yaml#L1829), [OrderEventKind:1897](../../ontology/domain/finance/orders-execution/module.yaml#L1897)).
- `OrderIntentLineage` split/aggregation conservation, endpoint closure, acyclicity ([OrderIntentLineage:315](../../ontology/domain/finance/orders-execution/module.yaml#L315)).
- `Execution` quantity/currency/unit/quotation-contract consistency ([ExecutionContract:2352](../../ontology/domain/finance/orders-execution/module.yaml#L2352)).
- `Fee` positive-magnitude + charge/rebate direction.
- Liquidity classified/unavailable branch.

## Design-intent drift (confirmed)

The module conflates three layers — (1) order/execution domain facts, (2) provider raw-code mapping and adapter implementation, (3) runtime/validation/quality findings. FIX separates ExecType from OrdStatus and lists cancel/replace/correct/cancel as distinct; ISO 20022 treats order, status, execution confirmation, and allocation as adjacent but different. The domain backbone is on-plan; the layer conflation is off-plan ([M2-PLAN §5.2 line 331](../planning/M2-PLAN.md#L331): "订单意图、生命周期事件、成交和外部状态适配").

## Cross-module dependency (critical)

`Execution` is referenced by `post-trade-operations` (×2) and `portfolio-positions` (×4); `Fee` by `portfolio-positions` (×3). `instruments/DirectUnitPriceQuotationContract` is referenced (ADR-021 introduces `QuotationConvention` in v2.0.0, not yet implemented). `market-structure/OTCTradingContext` is referenced (deprecated v1.1.0 per ADR-024, IRI retained). Removing `Execution`/`Fee` is source-breaking; broadening quotation is gated on ADR-021; allocation detail is gated on post-trade-operations.

## Per-container summary

| Container | Conclusion |
|---|---|
| Object types | Backbone worth retaining; `OrderEventStream` mis-named; needs `FillSnapshot`/`AllocationLine`/`OrderLeg`/`ExecutionLeg`. |
| Association types | `OrderLifecycleEvent` mixes internal/external; `Execution` forces bilateral; needs `OrderIntentLifecycleEvent`/`MatchedTrade`/`OrderRoute`/`ExecutionAllocation`/`OrderRevision`. |
| Relation types | No issuer/authority; no executionVenue/reportsExecution/acceptableVenueSet; needs versionable party roles. |
| Attribute types | No raw status/applied mapping on events; no executedAt/reportedAt/tradeDate; no cumulative qty; needs position-effect/short-sale/capacity/fee-payer-payee. |
| Code lists | 15 good; needs DisclosureStatus/PositionEffect/ShortSaleIndicator/OrderCapacity/RevisionKind/RouteStatus/LiquidityRoleDomainLevel; extend OrderLifecycleState/OrderEventKind with FIX values. |
| Constraints | OrderIntentContract missing authority; ExecutionContract forces bilateral + account equality; OrderIntentContextXone forbids venue-neutral; needs cumulative-quantity, allocation-conservation, routing-policy constraints. |

## Recommended convergence order

1. Decide v1 scope (single-instrument direct-unit?).
2. Split internal intent lifecycle, external order event, provider report, economic execution, correction/cancel.
3. Fix OrderIntent identity authority, ExternalOrder chain, raw mapping/profile traceability.
4. Build event—execution—cumulative/remaining—state closed loop.
5. Move source-schema/mapping/runtime/validation/quality out of the business spine.
6. Add type/TIF, short-sale, capacity, party roles, fee, liquidity extensions.

## Disposition

- **Release status**: `fin-orders` bumped to **v1.1.0, approved**. Round-12 v1.0.0 acceptance contract remains the historical baseline.
- **Architecture status**: P0 revision **implemented and regression-verified** (ADR-025 Accepted, v1.1.0 in-place). The module now separates internal vs external lifecycle events, traces mapping/profile on events, closes the event—execution—cumulative loop, separates account-side fill from bilateral MatchedTrade, adds timing/venue identity, scaffolds venue-neutral routing and allocation, and document-deprecates adapter/runtime/quality-existence conditions. v1.1.0 staging fixtures stage all new association/object types; CQ-OE12..OE17 report staged counts (regression 2026-08-05).
- **Deferred (not blocking)**: OE-A7 (quotation-convention broadening — [ADR-026](ADR-026-orders-quotation-convention-broadening.md) Proposed, gated on ADR-021), OE-A9 (allocation detail — [ADR-027](ADR-027-orders-allocation-boundary.md) Proposed, gated on post-trade-operations), OE-A10 (layer split — [ADR-028](ADR-028-orders-layer-separation.md) Proposed, gated on SME Q5). SME review document prepared: [RFC-004-SME-REVIEW.md](RFC-004-SME-REVIEW.md) with recommended answers for Q1–Q7, awaiting SME sign-off.
- **Regression gate (2026-08-05)**: see ADR-025 regression evidence table for actual results (validate-m2-core --strict PASS, run-domain-shacl PASS, run-all-cq-probes 136/0/0 over 72 CQs, OWL/SHACL regen idempotent).

## References

- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) (acceptance contract)
- [M2-PLAN §5.2](../planning/M2-PLAN.md) (module responsibility)
- [orders-execution-semantic-gap.md](gap/orders-execution-semantic-gap.md)
- [RFC-004](../planning/RFC-004-orders-execution-architecture.md) (Proposed)
- [ADR-025](ADR-025-orders-execution-architecture.md) (Accepted)
