# Orders Execution Semantic Gap

**Module**: fin-orders-execution
**Version**: 1.1.0
**Date**: 2026-08-05
**Round-12**: all gaps closed at v1.0.0 (acceptance contract)
**Round-15**: architecture revision implemented at v1.1.0 (ADR-025)

## Track A (M2-PLAN scope)

- Defines order intent, lifecycle events, executions, fees, and external status mapping as event-sourced facts.
- Non-goal: broker-specific enums as canonical ontology; live order routing or write actions in M2.
- Downstream of instruments/listings; upstream of post-trade settlement and portfolio position derivation.

## Track B (reference/ alignment)

- FIX order lifecycle and execution report semantics inform state machine and ExternalOrderStatusMapping.
- NautilusTrader order/event model is primary behavioral reference for intent -> event -> execution ordering.
- Lean `OrderEvent`/`OrderTicket` and vn.py order objects inform state transition negatives, not type imports.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| OE-G1 | weak-cq | P1 | Lifecycle CQs draft vs v03 fixtures | **Closed** - CQ-OE1-OE10 active; probes staged |
| OE-G2 | broken-boundary | P1 | OrderIntentLineage / result-intent trace | **Closed** - lineage negatives + CQ-OE4 trace |
| OE-G3 | shallow-definition | P2 | Listed vs OTC execution context | **Closed** (v1.0.0) — v03 shapes enforce; terminology polish in M1 |
| OE-G4 | mapping-gap | P1 | ExternalOrderStatusMapping synthetic slice | **Closed** - status-mapping positive + raw-code negative |
| OE-G5 | weak-cq | P2 | Fee / partial-fill CQs without staging | **Closed** - fee positive/negative fixtures + CQ-OE7 |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Order key + lineage digest; external status mapping fixture |
| 2 | pass | Execution price/quantity typed; fee money constrained |
| 3 | pass | Intent/event/execution trichotomy in contract negatives |
| 4 | pass | v03 SHACL + CQ-OE6 state machine validator |
| 5 | pass | TemporalFact on events/executions; PIT CQ-OE9 |
| 6 | pass | Ten active CQs; probes 0 pending |
| 7 | pass | FIX + Nautilus references in bibliography |
| 8 | pass | Status mapping positive/negative in v03 fixtures |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)

## Round-15 rows (v1.1.0 additive architecture revision, 2026-08-04/05)

Supersedes the "all gaps closed at v1.0.0" line above for the *complete, executable order-to-fill process with honest layer separation* claim. Round-12 v1.0.0 acceptance contract remains the historical baseline. See [M2-REVIEW-ROUND-15](../M2-REVIEW-ROUND-15.md) and [ADR-025](../decisions/ADR-025-orders-execution-architecture.md).

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| OE-A1 | identity-gap | P0 | OrderIntent identity has no authority; clientIntentId claims authority-scoped but no issuer/authority relation; logical key only stable(clientIntentId) | **Closed (v1.1.0)** — added intentIssuer + intentIdentifierAuthority; OrderIntentContract logicalKey(intentIdentifierAuthority, clientIntentId) |
| OE-A2 | layer-conflation | P0 | OrderLifecycleEvent mixes pre-submission internal (Initialized/Denied/Emulated/Released) and provider-external semantics; unsubmitted intents cannot honestly own a provider order/event | **Closed (v1.1.0)** — split OrderIntentLifecycleEvent (internal, no provider order/stream) vs external OrderLifecycleEvent; OrderIntentLifecycleEventContract |
| OE-A3 | audit-gap | P0 | ExternalOrderStatusMapping / OrderTransitionProfile exist but events carry no raw status, applied mapping, or applied profile; state machine not auditable | **Closed (v1.1.0)** — added rawProviderStatusCode + appliedStatusMapping + appliedTransitionProfile on events; declarative transitionTable on profile |
| OE-A4 | closed-loop-gap | P0 | Event and Execution parallel (only stream + sourceOrderKey); no reportsExecution, no cumulative/remaining quantity; sourceOrderKey uniqueness claimed but only non-negativity checked | **Closed (v1.1.0)** — added reportsExecution relation + FillSnapshot (lastQty/cumQty/leavesQty/cancelledQty/averagePrice) + FillSnapshotConsistencyContract |
| OE-A5 | bilateral-overreach | P0 | Execution forces contraAccount/contraParty 1..1; anonymous fills cannot supply these, inviting fabricated counterparties | **Closed (v1.1.0)** — relaxed contra roles to optional + disclosureStatus; added MatchedTrade requiring bilateral roles; unknown placeholder forbidden |
| OE-A6 | timing-identity-gap | P0 | Only observedAt; no executedAt/reportedAt/tradeDate; executionListing ≠ execution venue; no venueTradeId/providerReportId/matchId | **Closed (v1.1.0)** — added executedAt/providerReportedAt/tradeDate, executionVenue → TradingFacility, venueTradeId/providerReportId/matchId |
| OE-A7 | quotation-narrow | P0 | Price locked to MonetaryAmount + forced DirectUnitPriceQuotationContract; FX swap/multi-leg/bond yield/CDS upfront cannot be expressed | **Scoped (v1.1.0)** — module narrowed to single-instrument direct-unit; added executionQuotationConvention hook + OrderLeg/ExecutionLeg scaffolding; broadening to QuotationConvention deferred to cross-module ADR gated on ADR-021 (instruments v2.0.0) |
| OE-A8 | routing-forced | P0 | OrderIntentContextXone forces listing-or-OTC before provider acceptance; venue-neutral/SOR/best-execution/multi-child cannot be expressed | **Closed (v1.1.0)** — added acceptableVenueSet/routingPolicy + OrderRoute; OrderIntentRoutingPolicy admits the venue-neutral alternative |
| OE-A9 | allocation-absent | P0 | No allocation/block/bunched; ExecutionContract forces executionAccount = intentAccount | **Scoped (v1.1.0)** — relaxed account equality when allocation present; added ExecutionAllocation/AllocationLine with conservation; detail deferred to post-trade-operations cross-module ADR (SME-gated) |
| OE-A10 | existence-condition | P0 | Adapter mapping/tool lock/runtime/validation/quality findings written as existence conditions of financial facts | **Document-deprecated (v1.1.0)** — domain invariants retained; adapter/runtime/quality scoped as evidence-of-interpretation; physical migration to boundary modules deferred to layer-split follow-up ADR (SME-gated) |
| OE-A11 | chain-gap | P1 | Updated cannot replace a cancel/replace chain; FIX uses ClOrdID/OrigClOrdID | **Closed (v1.1.0)** — added OrderRevision with revisionRequestId/previousOrder/rootOrder/revisionKind/replacedTerms/priorityPreserved |
| OE-A12 | vocabulary-gap | P1 | State/event vocabularies miss PendingNew, DoneForDay, Stopped, Suspended, Calculated, Restated, PendingReplace, TradeCorrect, TradeCancel | **Closed (v1.1.0)** — extended OrderLifecycleState/OrderEventKind with FIX-aligned values; event x post-state composition retained |
| OE-A13 | marker-gap | P1 | OrderSide only Buy/Sell; no position effect, short-sale indicator, agency/principal capacity; party roles not versionable | **Closed (v1.1.0)** — added positionEffect/shortSaleIndicator/orderCapacity + versionable party-role relations (client/beneficial-owner/IDM/EDM/algorithm/transmitting/executing/reporting/clearing) |
| OE-A14 | fee-scope-gap | P1 | Fee effect not relative to explicit account/party; no payer/payee/basis/tax-jurisdiction; feeId scope not unified | **Closed (v1.1.0)** — added feePayer/feePayee/feeBasis/feeTaxJurisdiction; feeId scope aligned with FeeContract logical key |

## v1.1.0 status

- Architecture revision implemented in `module.yaml` v1.1.0 (ADR-025 Accepted); regression-verified 2026-08-05 (validate-m2-core --strict PASS, run-domain-shacl PASS, run-all-cq-probes 136/0/0 over 72 CQs, OWL/SHACL regen idempotent).
- v1.1.0 staging fixtures created: `tests/m2/fixtures/positive/orders-execution-v11-positive.yaml` (7 fixtures staging all new association/object types) and `tests/m2/fixtures/negative/orders-execution-v11-negative.yaml` (7 structural negatives). CQ-OE12..OE17 now report staged counts (2 internal events, 1 fill snapshot, 1 matched trade, 1 route, 1 allocation + 2 lines, 1 revision).
- Deferred (not blocking): OE-A7 (quotation-convention broadening — [ADR-026](../decisions/ADR-026-orders-quotation-convention-broadening.md) Proposed, gated on ADR-021), OE-A9 (allocation detail — [ADR-027](../decisions/ADR-027-orders-allocation-boundary.md) Proposed, gated on post-trade-operations), OE-A10 (layer split — [ADR-028](../decisions/ADR-028-orders-layer-separation.md) Proposed, gated on SME Q5). SME review document prepared: [RFC-004-SME-REVIEW.md](../decisions/RFC-004-SME-REVIEW.md) with recommended answers for Q1–Q7, awaiting SME sign-off.
- Full SHACL enforcement of the new association types via the generic fixture-to-TTL converter is pending the converter's object-value handling; structural/cardinality enforcement is verified by the strict structural validator.
