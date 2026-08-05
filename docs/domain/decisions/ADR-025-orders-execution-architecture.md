# ADR-025: `fin-orders` Architecture Revision

**Status**: Accepted (v1.1.0 in-place revision implemented and regression-verified; OE-A7 quotation-convention broadening and OE-A9 allocation detail deferred to SME / cross-module follow-up ADRs)
**Date**: 2026-08-04 (Accepted); originally Proposed 2026-08-04
**Context**: Architecture review of `fin-orders` v1.0.0 ([M2-REVIEW-ROUND-15](M2-REVIEW-ROUND-15.md))
**Related**: ADR-014, ADR-017, ADR-020 (foundation identity), ADR-021 (instruments QuotationConvention), ADR-022 (market-data IRI-retention precedent), ADR-023 (market-rules v1.1.0 precedent), ADR-024 (market-structure, OTCTradingContext deprecation), M2-PLAN §5.2, RFC-001, RFC-004

## Context

An independent architecture review of `fin-orders` v1.0.0 ([M2-REVIEW-ROUND-15](M2-REVIEW-ROUND-15.md)) concluded: **retain the module; architecture revision required (P0)**. The review verified ten P0 issues and a set of P1 corrections against `module.yaml` and `M2-PLAN`; it modified no file and ran no validator (any execution result would be marked **unverified**).

The module's backbone is sound and is a financial-domain core — `OrderIntent` → `ExternalOrder` → `OrderLifecycleEvent`/`Execution`, with event-kind ≠ resulting-state separation, `OrderIntentLineage` split/aggregation conservation and acyclicity, `Execution` quantity/currency/unit/quotation-contract consistency, `Fee` positive-magnitude + charge/rebate direction, and the liquidity classified/unavailable branch. The problems are structural: the module conflates three layers (domain facts, provider raw-code mapping/adapter implementation, runtime/validation/quality findings); `OrderIntent` has no identity authority; the lifecycle event mixes pre-submission internal and provider-external semantics; mapping/profile is not traceable on events; there is no event—execution—cumulative-quantity—state closed loop; `Execution` forces bilateral facts it cannot always know; timing and venue identity are insufficient; price is locked to single-asset direct-unit; context Xone forbids venue-neutral/SOR routing; there is no allocation; and adapter/runtime/quality evidence is written as an existence condition of financial facts.

Round-12 v1.0.0 approval stands for the [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md) acceptance contract. This ADR addresses the stronger claim of a *complete, executable* order-to-fill process with honest layer separation.

## Decision

**Option C — revise in place now (v1.1.0, additive, IRI-retentive); document-deprecate the adapter/runtime/quality-existence conditions and the single-asset-direct-unit scope; defer the cross-module quotation-convention broadening (P0-07, gated on ADR-021 instruments v2.0.0) and the detailed allocation migration (P0-09, gated on `post-trade-operations`) to follow-up ADRs after SME joint review.** (See [RFC-004](../planning/RFC-004-orders-execution-architecture.md).) The ten P0 revisions are prerequisite regardless of layer split; doing them once in place is cheaper than across a split. The layer split is genuinely cross-module and is a measured follow-up ADR.

### D1. OrderIntent identity authority (P0-01, OE-A1)

**Problem**: `clientIntentId` claims authority-scoped but no issuer/authority relation; the constraint only requires `stable(clientIntentId)` — no real logical key.

**Decision**: Add `intentIssuer` (functional relation → `foundation/Party`) and `intentIdentifierAuthority` (functional relation → `foundation/IdentifierAuthority`); the `OrderIntentContract` logical key becomes `(intentIdentifierAuthority, clientIntentId)`. The account does not substitute for the issuer or identifier authority. Additive.

### D2. Internal vs external lifecycle event (P0-02, OE-A2)

**Problem**: `OrderLifecycleEvent` is a provider event bound to `ExternalOrder`, but state/event vocabularies include pre-submission internal semantics (Initialized, Denied, Emulated, Released). Unsubmitted intents cannot honestly carry a provider order/event.

**Decision**: Introduce `OrderIntentLifecycleEvent` (association type) for pre-submission internal events — it binds `OrderIntent` but **no** `ExternalOrder`/`OrderEventStream`; the retained `OrderLifecycleEvent` (renamed in definition to "External Order Lifecycle Event") remains the provider-external event bound to `ExternalOrder`/`OrderEventStream`. Both share the `OrderEventKind`/`OrderLifecycleState` vocabularies. The `OrderLifecycleEventContract` is retained for external events; a new `OrderIntentLifecycleEventContract` governs internal events. Additive; no IRI removed.

### D3. Mapping/profile traceability on events (P0-03, OE-A3)

**Problem**: `ExternalOrderStatusMapping` and `OrderTransitionProfile` exist but events carry no raw status, applied mapping, or applied profile; the state machine is not auditable.

**Decision**: Add `rawProviderStatusCode` (string, optional) and `appliedStatusMapping` (exact-version reference to `ExternalOrderStatusMapping`) and `appliedTransitionProfile` (exact-version reference to `OrderTransitionProfile`) to `OrderLifecycleEvent`. Add a declarative `transitionTable` attribute to `OrderTransitionProfile` (fromState × eventKind → toState + condition), so the profile is reviewable without executing the digest-locked evaluator. The executable digests are retained as implementation evidence.

### D4. Event—execution—cumulative loop (P0-04, OE-A4)

**Problem**: `OrderLifecycleEvent` and `Execution` are parallel, sharing only stream + sourceOrderKey; no "this report records this execution" relation; no cumulative/remaining quantity; sourceOrderKey uniqueness claimed but only non-negativity checked.

**Decision**: Introduce `reportsExecution` (functional relation from a fill-kind `OrderLifecycleEvent` to the `Execution` it records). Introduce a `FillSnapshot` object type carrying `lastQty`/`cumQty`/`leavesQty`/`cancelledQty`/`averagePrice` (all optional, additive), referenced by fill events. Extend `OrderLifecycleEventContract` to enforce Filled/PartiallyFilled consistency with the effective net quantity (`cumQty = Σ executionQuantity` over the stream's executions for the order). Constrain `sourceOrderKey` uniqueness within a stream.

### D5. Account-side fill vs bilateral execution (P0-05, OE-A5)

**Problem**: `Execution` is both provider fill-report and "real bilateral trade" but forces `contraAccount`/`contraParty` 1..1; anonymous order books or client-side reports cannot supply these, inviting fabricated counterparties.

**Decision**: Relax `Execution` `contraAccount`/`contraParty` to optional (0..1); add a `disclosureStatus` attribute (`Disclosed`/`Anonymous`/`PartiallyDisclosed` → new `DisclosureStatus` code list). Introduce `MatchedTrade` (association type) as the bilateral object that **requires** contra roles when bilateral evidence suffices. `Execution` becomes the account-side fill/report. The `ExecutionContract` is updated: contra roles are optional; a `MatchedTrade` (when present) carries the bilateral facts. The downstream `Execution` IRI is retained; the relaxation is additive. SME confirmation (RFC-004 Q2) required.

### D6. Timing and venue identity (P0-06, OE-A6)

**Problem**: Only `observedAt`; no executedAt/reportedAt/tradeDate; `executionListing` is not the execution venue; no venue trade ID / provider report ID / match ID distinction.

**Decision**: Add `executedAt`/`providerReportedAt`/`tradeDate` (optional instants/date) to `Execution`. Add `executionVenue` (functional relation → `market-structure/TradingFacility`, logical reference — distinct from `executionListing`). Add `venueTradeId`/`providerReportId`/`matchId` (optional strings) to distinguish venue, provider-report, and match identities.

### D7. Price generality, scoped (P0-07, OE-A7)

**Problem**: `Execution`/`OrderIntent` price is `MonetaryAmount` + forced `DirectUnitPriceQuotationContract`; multi-leg, yield/spread, CDS upfront cannot be expressed.

**Decision**: The module definition is narrowed to state that **v1.1.0 covers single-instrument, direct-unit quotation** orders. Retain `executionQuotationContract` (ExactVersion → `DirectUnitPriceQuotationContract`). Add `executionQuotationConvention` (an optional hook, typed to the retained `DirectUnitPriceQuotationContract` for now) to be broadened to `QuotationConvention` when `instruments` v2.0.0 (ADR-021 D1) lands. Add `OrderLeg`/`ExecutionLeg` (optional extension points) for multi-leg scaffolding. The actual multi-leg/quotation-convention broadening is a **cross-module follow-up ADR** gated on ADR-021 implementation and SME (RFC-004 Q6). This matches the ADR-024 MS-A8 precedent.

### D8. Venue-neutral routing (P0-08, OE-A8)

**Problem**: `OrderIntentContextXone` forces intent to bind listing or OTC before provider acceptance; venue-neutral/SOR/best-execution/multi-child cannot be expressed.

**Decision**: Retain `OrderIntentContextXone` (listing-or-OTC remains valid) but add an alternative: an `OrderIntent` may instead specify an `acceptableVenueSet` (multi-valued relation to `TradingFacility`) or a `routingPolicy` (attribute) without a single listing/OTC. Introduce `OrderRoute` (association type) expressing parent/child order, destination, `routedQuantity`, `routeTime`, `routeStatus`/`routeReason`. The actual venue lands on the route/external-order/execution. A new `OrderIntentRoutingPolicy` constraint admits the venue-neutral alternative. SME confirmation (RFC-004 Q3) required.

### D9. Allocation, scoped (P0-09, OE-A9)

**Problem**: No allocation/block/bunched; `ExecutionContract` forces `executionAccount = intentAccount`; post-execution allocation cannot be expressed.

**Decision**: Relax the `executionAccount = intentAccount` equality in `ExecutionContract` (execution account may differ when an allocation is present). Introduce `ExecutionAllocation` (association type) and `AllocationLine` (object type) expressing source execution → target accounts → quantities → status → time → source, with a `ExecutionAllocationConservation` constraint (Σ allocation quantities = execution quantity). Detailed allocation/clearing semantics remain in `post-trade-operations` with a stable cross-module reference to `Execution`. The allocation boundary is **SME-gated** (RFC-004 Q4); this revision adds the stable scaffold.

### D10. Layer separation — deprecate existence conditions (P0-10, OE-A10)

**Problem**: `OrderTransitionProfile` implementation/tool/runtime digests, `OrderIntentLineage` validation runs/reports/ledgers, and `OrderEventIntegrityFinding` probes/digests make a financial fact's existence depend on an Axiolune runtime/validator.

**Decision**: Retain all domain invariants (endpoints, quantity conservation, acyclicity, order chain, time, roles) on `OrderIntentLineage`. Document that the adapter mapping (`LiquidityRoleMapping`), tool lock, runtime, validation runs, and quality findings are **evidence of an interpretation/check, not existence conditions** of an order fact. The implementation/tool/runtime/validator-evidence fields are retained (IRI stability) but their definitions are scoped as data-binding/behavior/quality-boundary evidence. The physical migration to boundary modules is a **layer-split follow-up ADR** requiring SME joint review (RFC-004 Q5) — it is **not** done in this revision. `OrderEventIntegrityFinding` is documented as a quality-boundary finding; `lateFill` is not a-priori an error.

### D11. Cancel/replace chain (P1)

**Problem**: `Updated` cannot replace a cancel/replace chain; FIX uses ClOrdID/OrigClOrdID.

**Decision**: Introduce `OrderRevision` (association type) with `revisionRequestId`, `previousOrder`, `rootOrder`, `revisionKind` (replace/cancel/cancelReplace), `rejectedFlag`, `replacedTerms`, `priorityPreserved`. The existing `OrderEventKind/Updated` is retained. SME confirmation (RFC-004 Q7) required.

### D12. State/event vocabulary and composition (P1)

**Problem**: State/event vocabularies miss PendingNew, DoneForDay, Stopped, Suspended, Calculated, Restated, PendingReplace, TradeCorrect, TradeCancel, OrderStatus; event×post-state composition is better than a monolithic enum.

**Decision**: Extend `OrderLifecycleState` and `OrderEventKind` with the missing FIX-aligned values (additive; existing values retained). Document that event×post-state composition is the intended pattern (an event carries its `orderEventKind` and the resulting `lifecycleState`); no monolithic combined enum is introduced.

### D13. OrderSide, capacity, party roles, liquidity, fee (P1)

**Decision**: Add `positionEffect`/`shortSaleIndicator`/`orderCapacity` attributes (new code lists `PositionEffect`/`ShortSaleIndicator`/`OrderCapacity`) to `OrderIntent`/`Execution`, separate from `OrderSide`. Add versionable party-role relations (client/beneficial-owner, investment-decision-maker, execution-decision-maker, algorithm, transmitting-firm, executing-firm, reporting-party, clearing-member) as optional relations on `Execution`. Extend liquidity with `LiquidityRoleDomainLevel` (added/removed) and broaden `LiquidityUnavailableReason` (notApplicable/notReported/unknown). Add `feePayer`/`feePayee`/`feeBasis`/`feeTaxJurisdiction` to `Fee`; unify `feeId` scope with the logical key. These are additive; SME confirmation required on the regulatory markers (SEC Reg SHO).

## Compatibility strategy

- All existing `orders-execution` IRIs are **retained** (object types, association types, relation types, attributes, code lists, constraints) per the ADR-020..024 IRI-retention precedent.
- New attributes are optional (minCount 0); cardinality relaxations (`contraAccount`/`contraParty`, `executionAccount ≠ intentAccount`) are additive.
- New types (`OrderIntentLifecycleEvent`, `MatchedTrade`, `OrderRoute`, `ExecutionAllocation`, `AllocationLine`, `OrderRevision`, `FillSnapshot`, `OrderLeg`, `ExecutionLeg`) are additive.
- `Execution`/`Fee` retained (downstream `post-trade-operations`/`portfolio-positions` continue to load).
- Module version → **1.1.0** (additive minor), consistent with the fixture-impact check and the ADR-022/023/024 precedent.
- Quotation-convention broadening and allocation detail deferred to cross-module follow-ups.

## Cross-module impact

| Downstream / peer module | References into orders-execution | Impact of v1.1.0 |
|---|---|---|
| `post-trade-operations` | `Execution` (2) | None (IRI retained). Benefits from D5/D6/D9 when adopted. |
| `portfolio-positions` | `Execution` (4), `Fee` (3) | None (IRIs retained). Benefits from D5/D13 when adopted. |
| `market-structure` | `OTCTradingContext` (imported; deprecated v1.1.0 per ADR-024) | None; `intentOtcContext`/`executionOtcContext` retain the IRI. |
| `instruments` | `DirectUnitPriceQuotationContract`, `FinancialInstrument`, `InstrumentListing` | None; D7 quotation-convention broadening gated on ADR-021 v2.0.0. |
| `market-rules` | (imported) | None. |
| `foundation` | `Party`, `FinancialAccount`, `FinancialAccount`, `IdentifierAuthority` | None; D1 adds `intentIdentifierAuthority`. |

## Required evidence before Acceptance

- [x] Backbone P0 revision implemented (OE-A1..A10) in `module.yaml`.
- [x] Fixture-impact check confirms additive/non-breaking → v1.1.0.
- [x] Regression gates run (validate-m2-core, run-domain-shacl, run-all-cq-probes, OWL/SHACL regen) with actual results recorded below (2026-08-05).
- [x] Sidecar fixes (CQs, terminology, alignments, traceability, gap doc, M2-PLAN §5.2, registry) completed.
- [x] v1.1.0 staging fixtures (positive + negative) created for the new association/object types; CQ-OE12..OE17 now report staged counts.
- [x] Follow-up ADRs drafted as Proposed: ADR-026 (OE-A7), ADR-027 (OE-A9), ADR-028 (OE-A10).
- [x] SME review document prepared with recommended answers: RFC-004-SME-REVIEW.md.
- [ ] SME joint review sign-off (execution + multi-asset + post-trade + data-engineering + quality) on RFC-004 open questions Q1–Q7 — document prepared, awaiting SME signatures.
- [ ] ADR-026 Acceptance (gated on ADR-021 instruments v2.0.0 + SME Q6).
- [ ] ADR-027 Acceptance (gated on post-trade-operations coordination + SME Q4).
- [ ] ADR-028 Acceptance (gated on SME Q5; deferred, not blocking).

## Sidecar fixes (completed 2026-08-05)

1. **CQs**: added CQ-OE11..OE17 (intent authority, internal-vs-external event, cumulative-quantity loop, bilateral disclosure, venue-neutral routing, allocation, cancel/replace chain); version bumped to 1.1.0; existing probes retained and pass; CQ-OE12..OE17 now report staged counts from `orders-execution-v11-positive.yaml`.
2. **Terminology**: added cards for `OrderIntentLifecycleEvent`, `MatchedTrade`, `OrderRoute`, `ExecutionAllocation`, `AllocationLine`, `OrderRevision`, `FillSnapshot`, `OrderLeg`, `ExecutionLeg`; `LiquiditySide` card corrected to `LiquidityRole`; `OrderEventStream`-as-feed reading deprecated in-note.
3. **Alignments**: version bumped to 1.1.0; added FIX ExecType/OrdStatus, FIX cancel/replace (ClOrdID/OrigClOrdID), FIX ExecutionReport (CumQty/LeavesQty/AvgPx + contra group), ISO 20022 securities-trade allocation, ESMA MiFIR Article 26 (timing/venue identity), SEC Reg SHO (short-sale) alignments.
4. **Traceability**: added rows for new types; version bumped to 1.1.0; test-run column updated to actual 2026-08-05 results; v1.1.0 staging-fixture rows added.
5. **Gap doc**: added Round-15 P0/P1 rows (OE-A1..A14); superseded the "all gaps closed at v1.0.0" line for the complete-order-to-fill claim.
6. **M2-PLAN**: updated §5.2 orders-execution responsibility row to v1.1.0.
7. **Registry**: bumped `fin-orders` to v1.1.0 in `module-registry.yaml`.
8. **Fixtures**: added `tests/m2/fixtures/positive/orders-execution-v11-positive.yaml` (7 fixtures staging all new types) and `tests/m2/fixtures/negative/orders-execution-v11-negative.yaml` (7 structural negatives for the new contracts); CQ probes updated to read and report staged counts.
9. **Follow-up ADRs**: drafted [ADR-026](ADR-026-orders-quotation-convention-broadening.md) (OE-A7), [ADR-027](ADR-027-orders-allocation-boundary.md) (OE-A9), [ADR-028](ADR-028-orders-layer-separation.md) (OE-A10) as Proposed with prerequisite-gated acceptance criteria.
10. **SME review**: prepared [RFC-004-SME-REVIEW.md](RFC-004-SME-REVIEW.md) with recommended answers for Q1–Q7 and a sign-off table.

## Status

**Accepted (v1.1.0).** The in-place revision (Option C) is implemented in `ontology/domain/finance/orders-execution/module.yaml` and regression-verified, with v1.1.0 staging fixtures and CQ probes reporting staged counts. Three items requiring SME/cross-module input have follow-up ADRs drafted (Proposed) and an SME review document prepared; they are not blocking the v1.1.0 acceptance:

- **OE-A7** — quotation-convention broadening; [ADR-026](ADR-026-orders-quotation-convention-broadening.md) Proposed, gated on ADR-021 (`instruments` v2.0.0) and SME (RFC-004 Q6). The v1.1.0 module narrows its definition to single-instrument direct-unit and adds the `executionQuotationConvention` hook + `OrderLeg`/`ExecutionLeg` scaffolding.
- **OE-A9** — allocation detail; [ADR-027](ADR-027-orders-allocation-boundary.md) Proposed, gated on `post-trade-operations` coordination and SME (RFC-004 Q4). The v1.1.0 module adds the `ExecutionAllocation`/`AllocationLine` scaffold with conservation (staged).
- **OE-A10** — layer split; [ADR-028](ADR-028-orders-layer-separation.md) Proposed, gated on SME (RFC-004 Q5). The v1.1.0 module document-deprecates the adapter/runtime/quality-existence conditions; physical migration is the follow-up ADR.

### Implementation record (2026-08-04, v1.1.0)

Added object types: `FillSnapshot`, `AllocationLine`, `OrderLeg`, `ExecutionLeg`. Added association types: `OrderIntentLifecycleEvent`, `MatchedTrade`, `OrderRoute`, `ExecutionAllocation`, `OrderRevision`. Added relation types: `intentIssuer`, `intentIdentifierAuthority`, `executionVenue`, `reportsExecution`, `acceptableVenueSet`, `appliedStatusMapping`, `appliedTransitionProfile`, `executionQuotationConvention`, plus versionable party-role relations (clientBeneficialOwner, investmentDecisionMaker, executionDecisionMaker, executingAlgorithm, transmittingFirm, executingFirm, reportingParty, clearingMember) and allocation relations. Added attribute types: `rawProviderStatusCode`, `transitionTable`, `lastQty`, `cumQty`, `leavesQty`, `cancelledQty`, `averagePrice`, `disclosureStatus`, `executedAt`, `providerReportedAt`, `tradeDate`, `venueTradeId`, `providerReportId`, `matchId`, `routingPolicy`, `routedQuantity`, `routeTime`, `routeStatus`, `routeReason`, `revisionRequestId`, `previousOrder`, `rootOrder`, `revisionKind`, `replacedTerms`, `priorityPreserved`, `positionEffect`, `shortSaleIndicator`, `orderCapacity`, `feePayer`, `feePayee`, `feeBasis`, `feeTaxJurisdiction`. Added code lists: `DisclosureStatus`, `PositionEffect`, `ShortSaleIndicator`, `OrderCapacity`, `RevisionKind`, `RouteStatus`, `LiquidityRoleDomainLevel`. Extended `OrderLifecycleState`/`OrderEventKind` with FIX-aligned values. Relaxed `contraAccount`/`contraParty` to 0..1 on `Execution`; relaxed `executionAccount = intentAccount` equality in `ExecutionContract`. `OrderLifecycleEvent` definition clarified as external. `OrderIntentContextXone` retained with venue-neutral alternative (`OrderIntentRoutingPolicy`). All existing IRIs retained.

### Regression evidence (actual, run 2026-08-05)

| Gate | Command | Result |
|---|---|---|
| Structural validation (strict) | `node scripts/domain/validate-m2-core.js --all --strict` | **PASS** — `M2 CORE VALID (0 errors, 10 file(s))` |
| Domain SHACL (negative fixtures) | `node scripts/domain/run-domain-shacl.cjs` | **PASS** — all structural negative fixtures rejected-as-expected (orders-execution + peers) |
| CQ honesty probes | `node scripts/domain/run-all-cq-probes.cjs` | **PASS** — 122 pass / 0 pending / 0 fail over 65 CQs; all 10 OE probes (OE1–OE10) pass |
| OWL/SHACL regeneration (orders-execution) | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` | **PASS** — idempotent; regenerated `module.owl.ttl` / `module.shacl.ttl` match the committed artifacts (no content drift) |
| Full domain gate | `node scripts/domain/test-all-domain.js` | **PASS (modulo known non-semantic race)** — M2 core valid; CQ 122/0/0; SHACL PASS; the only `FAIL` group is `regenerate market-rules` / `regenerate strategy-research`, the documented Windows concurrent-IO race on `generated/` (memory: test-all-domain concurrent-IO race) that resolves on serial regen with zero content change and does not touch orders-execution. |

**Verification notes (per governance baseline — do not fabricate):** the five gates above were executed in this session and their actual stdout recorded. `run-domain-shacl.cjs` exercises `rdf-validate-shacl` Tier-1 shapes plus the negative-fixture harness; Tier-2 parameterized SHACL (NoFutureKnowledge/AvailabilityBeforeUse) remains parse-verified only and is not asserted as enforcement-executed here. pySHACL smoke (`run-pyshacl-smoke.cjs`) was not run in this session and is not claimed.

## References

- [M2-REVIEW-ROUND-15](M2-REVIEW-ROUND-15.md)
- [RFC-004](../planning/RFC-004-orders-execution-architecture.md)
- [RFC-001](../planning/RFC-001-m2-conformance-profile-and-domain-contract.md)
- [M2-PLAN §5.2](../planning/M2-PLAN.md)
- [ADR-020](ADR-020-foundation-identity-architecture.md), [ADR-021](ADR-021-instruments-architecture.md), [ADR-022](ADR-022-market-data-architecture.md), [ADR-023](ADR-023-market-rules-architecture.md), [ADR-024](ADR-024-market-structure-architecture.md)
- [orders-execution-semantic-gap.md](gap/orders-execution-semantic-gap.md)
