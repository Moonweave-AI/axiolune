# RFC-004: `fin-orders` Architecture — Layer Separation vs. In-Place Revision

**Status**: Proposed (open for SME discussion)
**Date**: 2026-08-04
**Scope**: `ontology/domain/finance/orders-execution` module structure and v1.0.0 → next-version evolution
**Related**: [M2-REVIEW-ROUND-15](../decisions/M2-REVIEW-ROUND-15.md), [ADR-025](../decisions/ADR-025-orders-execution-architecture.md) (Proposed), [RFC-001](RFC-001-m2-conformance-profile-and-domain-contract.md), [M2-PLAN §5.2](M2-PLAN.md), [ADR-020](../decisions/ADR-020-foundation-identity-architecture.md), [ADR-021](../decisions/ADR-021-instruments-architecture.md), [ADR-022](../decisions/ADR-022-market-data-architecture.md), [ADR-024](../decisions/ADR-024-market-structure-architecture.md)

## Purpose

Decide the **structural** response to the Round-15 architecture review of `fin-orders` v1.0.0. The review confirmed ten P0 issues and a set of P1 corrections (verified against `module.yaml` and `M2-PLAN`); it did **not** modify any file or run any validator. This RFC is the decision input for [ADR-025](../decisions/ADR-025-orders-execution-architecture.md). Per the Moonweave baseline, no `module.yaml` edit proceeds until ADR-025 is Accepted, and the layer-separation option requires SME joint review.

This RFC is **not** a re-litigation of Round-12 v1.0.0 acceptance. Round-12 stands for the [RFC-001](RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This RFC addresses the stronger claim that the module covers a *complete, executable* order-to-fill process with honest layer separation — which the released module does not yet satisfy.

## Background

### Confirmed P0 issues (verified)

1. **OrderIntent identity has no authority.** `clientIntentId` claims authority-scoped but no issuer/authority relation; constraint only requires `stable(clientIntentId)`. No real logical key.
2. **Lifecycle event mixes internal and external.** `OrderLifecycleEvent` is a provider event bound to `ExternalOrder`, but the state/event vocabularies include pre-submission internal semantics (Initialized, Denied, Emulated, Released). Unsubmitted intents cannot honestly carry a provider order/event.
3. **Mapping/profile not traceable on events.** `ExternalOrderStatusMapping` and `OrderTransitionProfile` exist but events carry no raw status, applied mapping, or applied profile. The state machine is not auditable; semantics hide in digests/external implementations.
4. **Event—execution—cumulative-quantity—state no closed loop.** `OrderLifecycleEvent` and `Execution` are parallel, sharing only stream + sourceOrderKey; no "this report records this execution" relation; no cumQty/leavesQty/avgPrice; sourceOrderKey uniqueness is claimed but only non-negativity is checked.
5. **Execution forces bilateral facts it cannot always know.** `Execution` is both provider fill-report and "real bilateral trade" but forces `contraAccount`/`contraParty` 1..1; anonymous order books or client-side reports cannot supply these, inviting fabricated counterparties.
6. **Timing and venue identity insufficient.** Only `observedAt`; no executedAt/reportedAt/tradeDate; `executionListing` is not the execution venue; no venue trade ID / provider report ID / match ID distinction.
7. **Price locked to single-asset direct-unit.** `Execution`/`OrderIntent` price is `MonetaryAmount` + forced `DirectUnitPriceQuotationContract`; FX swap, multi-leg, bond yield/spread/discount, CDS upfront cannot be expressed.
8. **Context Xone forbids venue-neutral/SOR.** `OrderIntentContextXone` forces intent to bind listing or OTC before provider acceptance; venue-neutral, SOR, best-execution, multi-child, broker-decides-venue cannot be expressed.
9. **No allocation/block/bunched; execution account forced = intent account.** `ExecutionContract` forces `executionAccount = intentAccount`; post-execution allocation, average-price allocation, multiple final accounts cannot be expressed.
10. **Data-binding/runtime/quality written as existence conditions of financial facts.** `OrderTransitionProfile` implementation/tool/runtime digests, `OrderIntentLineage` validation runs/reports/ledgers, and `OrderEventIntegrityFinding` probes/digests make a financial fact's existence depend on an Axiolune runtime/validator.

### Design-intent drift (confirmed)

The review's central observation: the module conflates three layers — (1) order/execution domain facts, (2) provider raw-code mapping and adapter implementation, (3) runtime, validation, integrity findings, and evidence locking. FIX separates "why this report was sent (ExecType)" from "current order state (OrdStatus)" and lists cancel/replace/correct/cancel as distinct semantics; ISO 20022 treats order, status, execution confirmation, and allocation as adjacent but different business objects. The module's domain backbone is on-plan; the layer conflation is off-plan.

### Cross-module dependency (critical constraints)

- `Execution` is referenced as an association **range** by `post-trade-operations` (×2) and `portfolio-positions` (×4 incl. `objectType`).
- `Fee` is referenced by `portfolio-positions` (×3 incl. `objectType`).
- The module imports `market-structure` (OTCTradingContext — deprecated in v1.1.0, IRI retained pending ADR-024 MS-A8 migration), `instruments` (DirectUnitPriceQuotationContract — ADR-021 D1 introduces `QuotationConvention` as abstract parent in instruments v2.0.0, not yet implemented), `market-rules`, `foundation`.

**Removing `Execution` or `Fee` is source-breaking across two released v1.0.0 modules.** The quotation-convention broadening (P0-07) depends on `instruments` v2.0.0 (ADR-021, not yet implemented). The allocation migration (P0-09) depends on `post-trade-operations`. These are cross-module and must be deferred or coordinated.

### What must be retained (non-negotiable)

- `OrderIntent` / `ExternalOrder` separation as the correct starting point.
- Event-kind ≠ resulting-state separation (`OrderEventKind` vs `OrderLifecycleState`).
- `OrderIntentLineage` split/aggregation conservation, endpoint closure, acyclicity.
- `Execution` quantity/currency/unit/quotation-contract consistency (the strictness is good; the scope is the issue).
- `Fee` positive-magnitude + charge/rebate direction (no signed amount).
- Liquidity classified/unavailable branch (no fabricated maker/taker).
- All existing `orders-execution` IRIs (object types, association types, relation types, attributes, code lists, constraints) — per the ADR-020/021/022/023/024 IRI-retention precedent.

## Option A — Revise in place (v1.1.0, additive)

Add the missing semantics and separate the layers **within** the single module as an additive, IRI-retentive revision.

### What changes (P0)

- **OE-A1 (intent identity):** add `intentIssuer`/`intentIdentifierAuthority` relations to `foundation/Party`/`IdentifierAuthority`; logical key becomes `(authority, clientIntentId)`. Additive.
- **OE-A2 (internal vs external event):** introduce `OrderIntentLifecycleEvent` (pre-submission, no provider/stream/ExternalOrder) as a sibling to `OrderLifecycleEvent` (external, provider-bound); share `OrderEventKind`/`OrderLifecycleState` vocabularies. Both retained; additive.
- **OE-A3 (mapping/profile traceability):** add `rawProviderStatusCode`, `appliedStatusMapping`, `appliedTransitionProfile` to events; make `OrderTransitionProfile` carry a declarative `transitionTable` (fromState × eventKind → toState + condition) alongside the retained executable digests.
- **OE-A4 (event—execution—cumulative loop):** introduce `reportsExecution` relation; add `lastQty`/`cumQty`/`leavesQty`/cancelledQty`/`averagePrice` to a `FillSnapshot` carried by fill events; constrain Filled/PartiallyFilled vs effective net quantity.
- **OE-A5 (account-side fill vs bilateral):** relax `Execution` `contraAccount`/`contraParty` to optional (0..1); add a `disclosureStatus` attribute; introduce `MatchedTrade` (bilateral, requires contra roles when evidence suffices) as a sibling. Execution becomes the account-side fill/report.
- **OE-A6 (timing + venue identity):** add `executedAt`/`providerReportedAt`/`tradeDate`; add `executionVenue` relation to `market-structure/TradingFacility`; add `venueTradeId`/`providerReportId`/`matchId` distinct identifiers.
- **OE-A7 (price generality, scoped):** retain `DirectUnitPriceQuotationContract` reference; document that v1 covers single-instrument direct-unit only; add an `executionQuotationConvention` hook (typed to `QuotationConvention` when instruments v2.0.0 lands, currently typed to the retained `DirectUnitPriceQuotationContract`); add `OrderLeg`/`ExecutionLeg` extension points (additive, optional). The actual multi-leg/quotation-convention broadening is a cross-module follow-up gated on ADR-021 implementation.
- **OE-A8 (venue-neutral routing):** relax `OrderIntentContextXone` so an intent may specify an `acceptableVenueSet` or `routingPolicy` instead of a single listing/OTC; introduce `OrderRoute` (parent/child, destination, routedQty, routeTime, routeStatus/reason). Actual venue lands on route/external-order/execution.
- **OE-A9 (allocation, scoped):** introduce `ExecutionAllocation`/`AllocationLine` within this module to express source execution → target accounts → quantities → status, with quantity conservation; the detailed allocation/clearing semantics remain in `post-trade-operations`, with a stable cross-module reference. SME confirmation required on the boundary.
- **OE-A10 (layer separation):** retain domain invariants (endpoints, conservation, acyclicity, order chain, time, roles) on `OrderIntentLineage`; document that adapter mapping (`LiquidityRoleMapping`), tool lock, runtime, validation runs, and quality findings are **evidence of an interpretation/check**, not existence conditions of an order fact. Mark the implementation/tool/runtime/validator-evidence fields as belonging to the data-binding/behavior/quality boundary; retain them with deprecation-in-documentation until the boundary modules exist. SME confirmation required.

### P1 corrections (additive where possible)

- Cancel/replace chain: `OrderRevision`/`OrderInstructionChange` with new request ID, previous/root order, replace/cancel request, reject, replaced terms, priority-preserved flag.
- State/event vocabularies: add PendingNew, DoneForDay, Stopped, Suspended, Calculated, Restated, PendingReplace, TradeCorrect, TradeCancel, OrderStatus; allow event×post-state composition rather than a monolithic state enum.
- OrderType/TIF: keep 6 as v1 core; build combination instructions (display/iceberg, min-qty, auction, peg, contingency, short-sale, open/close) as profile hooks governed by `market-rules`/venue; separate double-last/last-or-bid-ask from `TriggerPriceBasis`.
- OrderSide/capacity: separate direction, position-effect, short-sale indicator, agency/principal/riskless-principal capacity.
- Party roles: versionable client/beneficial-owner, investment-decision-maker, execution-decision-maker, algorithm, transmitting firm, executing firm, reporting party, clearing member.
- Liquidity: distinguish domain-level added/removed, source-level neither/routed-out/auction/triggered, notApplicable/notReported/unknown.
- Fee: fee effect relative to account/party; payer/payee/assessor, basis, tax jurisdiction, allocation-level fee; unify `feeId` scope with logical key.
- `OrderEventStream` rename: clarify as `ExternalOrderEventSequence` (definition text; IRI retained); real provider feed/session as a separate optional concept.
- `OrderEventIntegrityFinding`: abstract `Finding` + kind-specific subject subtypes; lateFill not a-priori error (late report, cancel/fill race, trade correction, bust).

### Compatibility

- **Version**: 1.1.0 (additive within major; all existing IRIs retained, new attributes minCount 0, new code values appended, `contraAccount`/`contraParty` relaxed to optional). The fixture-impact check confirms fixtures use domain YAML vocabulary and SHACL path IRIs, not the exact attribute set — additions and cardinality relaxations are non-breaking.
- `Execution`/`Fee` retained (downstream `post-trade-operations`/`portfolio-positions` continue to load).
- Quotation-convention broadening and allocation detailed semantics deferred to cross-module follow-up gated on ADR-021 / SME.

### Pros

- Single module; simplest import DAG; no new registry entries beyond the version bump.
- Lowest migration cost; reuses existing CQs, fixtures, alignments, traceability.
- Does not block two downstream modules; cross-module work is a measured follow-up.

### Cons

- The module remains large and must host domain facts + (documentation-deprecated) adapter/runtime/quality evidence until the boundary modules exist.
- P0-07 (price generality) and P0-09 (allocation) are only scaffolded; full resolution depends on `instruments` v2.0.0 and `post-trade-operations` coordination.
- Single module continues to carry three layers (documented), even after deprecation-in-documentation.

## Option B — Full layer split (v2.0.0)

Split the module into a domain layer (`fin-orders` — intent, route, external order, fill, execution, fee, allocation), an adapter/mapping layer (`fin-orders-adapter` — status mapping, liquidity mapping, transition profile), and move runtime/validator/quality findings to the data-binding/behavior/quality boundary.

### Compatibility

- **Version**: 2.0.0 (major) — new module IRIs, registry entries, import-DAG update for `post-trade-operations`/`portfolio-positions`.
- `Execution`/`Fee` IRIs retained but re-homed; downstream ranges unchanged (IRI stability preserved for the cross-module types).
- CQs, fixtures, alignments, traceability split per layer.

### Pros

- Cleanest layer separation: domain facts no longer depend on adapter/runtime/quality.

### Cons

- Highest migration cost: new registry entries, import-DAG revision, fixture/probe/alignment rework.
- Violates the review's own convergence order ("先决定正式范围... 拆开... 修复身份... 建立闭环... 移出业务主干") — the layer split is the *last* practical step, not the first.
- Requires SME joint review before execution; cannot be completed without coordinating `instruments` v2.0.0 (P0-07) and `post-trade-operations` (P0-09).

## Option C — Revise in place now, defer layer split (recommended path)

Execute Option A's P0 revisions as **v1.1.0** (additive, IRI-retentive). Document-deprecate the adapter/runtime/quality-existence conditions (OE-A10) and the single-asset-direct-unit scope (OE-A7). Defer the cross-module quotation-convention broadening (P0-07, gated on ADR-021) and the detailed allocation migration (P0-09, gated on `post-trade-operations`) to follow-up ADRs requiring SME joint review. After P0 closure and regression pass, re-evaluate the layer split with SME input.

### Rationale

- The review's convergence order begins with scope decision and ends with moving source-schema/mapping/runtime/validation out of the business spine; the layer split depends on the domain facts being correct first.
- The ten P0 revisions (identity, event split, traceability, cumulative loop, bilateral relaxation, timing, price scope, routing, allocation, layer deprecation) are prerequisite regardless of split; doing them once in place is cheaper than across a split.
- The cross-module dependencies (Execution/Fee for 2 modules; QuotationConvention for instruments; allocation for post-trade) make a clean split a measured follow-up, not an in-place edit. This matches the ADR-023/024 precedent.
- SME joint review is required for the layer-split boundary, the quotation-convention adoption, and the allocation boundary; it is not required to begin the additive in-place revision.

### Trade-off

- Accepts adapter/runtime/quality evidence remaining in the module (documented-deprecated) for one revision cycle.
- Defers full price generality and allocation detail to cross-module follow-ups.

## Open questions for SME review

1. **v1 scope.** Is v1 explicitly scoped to single-instrument, direct-unit, single-account, non-anonymous, no-allocation orders? If not, OE-A5/A7/A9 must enter the design. *(SME: execution + multi-asset)*
2. **Bilateral vs account-side.** Confirm the `Execution` (account-side fill/report) vs `MatchedTrade` (bilateral, contra-roles-when-evident) split and the `disclosureStatus` semantics. FIX contra group is optional. *(SME: execution + market microstructure)*
3. **Routing and SOR.** Confirm `OrderRoute` shape (parent/child, destination, routedQty, routeTime, routeStatus/reason) and whether venue-neutral intent is permitted without a listing/OTC binding. *(SME: execution + routing)*
4. **Allocation boundary.** Confirm whether `ExecutionAllocation`/`AllocationLine` lives in `fin-orders` (source execution → target accounts → quantity → status) or in `post-trade-operations`; and the stable cross-module reference. *(SME: execution + post-trade)*
5. **Layer split.** Confirm the boundary between domain facts and adapter/runtime/quality; confirm that implementation/tool/runtime/validator-evidence fields become evidence-of-interpretation, not existence conditions. *(SME: data engineering + quality)*
6. **Price generality.** Confirm the `OrderLeg`/`ExecutionLeg` extension points and the `QuotationConvention` adoption order (gated on ADR-021 instruments v2.0.0). *(SME: multi-asset + instruments)*
7. **Cancel/replace chain.** Confirm `OrderRevision`/`OrderInstructionChange` with ClOrdID/OrigClOrdID-style chain vs a single fixed order ID. *(SME: execution)*

External citations referenced by the review (to be confirmed by SME, **not** asserted as provenance): FIX ExecType/OrdStatus/Order State Changes/ExecutionReport/trade specification, ISO 20022 Business Areas/securities trade, ESMA MiFIR Article 26, CFTC 17 CFR 1.35 (bunched order), SEC Regulation SHO FAQ.

## Versioning sub-decision (for ADR-025)

- Is relaxing `contraAccount`/`contraParty` to optional source-compatible? Yes — fixtures use SHACL path IRIs for violation checks and domain YAML `counterpartyMode` vocabulary; they do not assert the 1..1 cardinality. → **1.1.0**.
- Are the new types (`OrderIntentLifecycleEvent`, `MatchedTrade`, `OrderRoute`, `ExecutionAllocation`, `AllocationLine`, `OrderRevision`, `FillSnapshot`) additive? Yes — new IRIs, existing types unchanged. → **1.1.0**.
- Is the `OrderIntentContextXone` relaxation breaking? The Xone is **retained** but an alternative (`acceptableVenueSet`/`routingPolicy`) is added; existing listing/OTC-bound intents continue to satisfy the Xone. → **1.1.0**.
- Is the `executionQuotationConvention` hook additive? Yes — a new optional attribute alongside the retained `executionQuotationContract`. → **1.1.0**.
- **Conclusion: v1.1.0 (additive minor)**, consistent with the ADR-022/023/024 IRI-retention precedent.

## Recommendation

**Option C** — revise in place now (v1.1.0, additive, IRI-retentive), document-deprecate the adapter/runtime/quality-existence conditions and the single-asset-direct-unit scope, and defer the cross-module quotation-convention broadening and allocation detail to follow-up ADRs after SME joint review. This matches the review's own convergence order and the Moonweave baseline.

## References

- [M2-REVIEW-ROUND-15](../decisions/M2-REVIEW-ROUND-15.md)
- [ADR-025](../decisions/ADR-025-orders-execution-architecture.md) (Proposed)
- [RFC-001](RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](M2-PLAN.md)
- [ADR-020](../decisions/ADR-020-foundation-architecture.md), [ADR-021](../decisions/ADR-021-instruments-architecture.md), [ADR-022](../decisions/ADR-022-market-data-architecture.md), [ADR-024](../decisions/ADR-024-market-structure-architecture.md)
- [orders-execution-semantic-gap.md](../decisions/gap/orders-execution-semantic-gap.md)
