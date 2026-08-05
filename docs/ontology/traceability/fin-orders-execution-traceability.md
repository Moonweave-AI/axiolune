# fin-orders-execution Traceability Matrix

**Status**: review (v1.1.0)
**Date**: 2026-08-05
**Not a release sign-off**

## v1.0.0 backbone (retained)

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| nautilus / Lean | OrderIntent | quantity + instrument required; (authority, clientIntentId) key (v1.1.0) | CQ-OE1, CQ-OE11 | orders-v03-positive-intent-listed | validate-m2-core --strict PASS (2026-08-05) |
| FIX evidence | ExternalOrderStatusMapping | raw code → canonical state; raw+applied mapping on event (v1.1.0) | CQ-OE5 | orders-v03-positive-status-mapping | validate-m2-core --strict PASS (2026-08-05) |
| FIBO | Execution | fill price + parties; account-side + optional contra (v1.1.0) | CQ-OE3, CQ-OE14 | orders-v03-positive-execution-listed | validate-m2-core --strict PASS (2026-08-05) |
| M2-PLAN | OrderLifecycleEvent | order key + provider event id; external-only (v1.1.0) | CQ-OE2 | orders-v03-positive-lifecycle-event | validate-m2-core --strict PASS (2026-08-05) |
| ADR-012 | TemporalFact | availableFrom on events/executions | CQ-OE4 | orders-v03-negative-missing-availability | run-domain-shacl PASS (2026-08-05) |
| M2-PLAN | OrderIntentLineage | result intent linkage; conservation + acyclicity | CQ-OE6 | orders-v03-positive-order-intent-lineage-split | semantic replay verified |
| FIX ExecType/OrdStatus | OrderEventKind / OrderLifecycleState | event ≠ state; FIX-aligned vocab (v1.1.0) | CQ-OE6, CQ-OE10 | order-lifecycle-valid / order-lifecycle-invalid | run-order-state-machine-cq PASS (2026-08-05) |

## v1.1.0 (ADR-025) additions — architecture revision

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| ADR-025 D1 | OrderIntent — intentIssuer / intentIdentifierAuthority | OrderIntentContract logicalKey(authority, clientIntentId) | CQ-OE11 | orders-execution-v03 (existing intents) | CQ probe PASS (6 intents; contract guarantee) |
| ADR-025 D2 | OrderIntentLifecycleEvent (internal) | OrderIntentLifecycleEventContract forbids provider fields | CQ-OE12 | orders-execution-v11-positive (2 staged) | CQ probe PASS (2 internal events staged) |
| ADR-025 D3 | OrderLifecycleEvent — rawProviderStatusCode / appliedStatusMapping / appliedTransitionProfile | OrderLifecycleEventContract; transitionTable on profile | CQ-OE5, CQ-OE12 | orders-execution-v11-negative (structural negatives) | validate-m2-core --strict PASS |
| ADR-025 D4 | FillSnapshot + reportsExecution | FillSnapshotConsistencyContract (cumQty/leavesQty/Filled) | CQ-OE13 | orders-execution-v11-positive (1 staged) | CQ probe PASS (1 fill snapshot staged) |
| ADR-025 D5 | MatchedTrade + disclosureStatus | ExecutionContract (contra optional, no unknown); MatchedTradeContract | CQ-OE14 | orders-execution-v11-positive (1 staged) + negative (missing disclosure/matchId) | CQ probe PASS (1 matched trade staged); negative structural PASS |
| ADR-025 D6 | Execution — executedAt/providerReportedAt/tradeDate, executionVenue, venueTradeId/providerReportId/matchId | ExecutionContract timing/venue identity | CQ-OE3, CQ-OE9 | (attribute-level; existing execution fixtures) | validate-m2-core --strict PASS |
| ADR-025 D7 | OrderLeg / ExecutionLeg + executionQuotationConvention | v1.1.0 single-instrument direct-unit; broadening gated on ADR-021 | CQ-OE3 | (cross-module follow-up gated on instruments v2.0.0) | deferred (OE-A7 / ADR-026) |
| ADR-025 D8 | OrderRoute + acceptableVenueSet / routingPolicy | OrderIntentRoutingPolicy; OrderRouteContract | CQ-OE15 | orders-execution-v11-positive (1 staged) + negative (missing qty/status) | CQ probe PASS (1 route staged); negative structural PASS |
| ADR-025 D9 | ExecutionAllocation + AllocationLine | ExecutionAllocationConservationContract | CQ-OE16 | orders-execution-v11-positive (1 alloc + 2 lines) + negative (missing status) | CQ probe PASS (1 allocation + 2 lines staged, 60+40=100); negative structural PASS |
| ADR-025 D10 | adapter/runtime/quality existence conditions | document-deprecated as evidence-of-interpretation | CQ-OE10 | (layer split deferred) | deferred (OE-A10 / ADR-028) |
| ADR-025 D11 | OrderRevision | OrderRevisionContract (cancel/replace chain) | CQ-OE17 | orders-execution-v11-positive (1 staged) + negative (cancel+terms, missing id) | CQ probe PASS (1 revision staged); negative structural PASS |
| ADR-025 D13 | positionEffect / shortSaleIndicator / orderCapacity; versionable party roles; fee payer/payee | ExecutionContract / FeeContract regulatory markers | CQ-OE7 | (attribute-level) | validate-m2-core --strict PASS |

## Regression gate results (actual, 2026-08-05)

| Gate | Command | Result |
|---|---|---|
| Structural validation (strict) | `node scripts/domain/validate-m2-core.js --all --strict` | PASS — 0 errors, 10 files |
| Domain SHACL (negative fixtures) | `node scripts/domain/run-domain-shacl.cjs` | PASS — all structural negatives rejected-as-expected |
| CQ honesty probes | `node scripts/domain/run-all-cq-probes.cjs` | PASS — 136 pass / 0 pending / 0 fail over 72 CQs (OE1–OE17); OE12–OE17 report staged counts |
| OWL/SHACL regeneration | `generate-m2-owl.cjs` / `generate-m2-shacl.cjs` | PASS — idempotent; regenerated artifacts match committed |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: Tier-2 parameterized SHACL (NoFutureKnowledge/AvailabilityBeforeUse) enforcement; pySHACL smoke not run this session. v1.1.0 new-type staging fixtures (orders-execution-v11-positive.yaml: 7 fixtures staging all new association/object types; orders-execution-v11-negative.yaml: 7 structural negatives) are staged and the strict structural validator verifies the contract/cardinality guarantees; full SHACL enforcement of the new association types via the generic fixture-to-TTL converter is pending the converter's object-value handling (documented). SME joint review (RFC-004 Q1–Q7) sign-off is recorded in [RFC-004-SME-REVIEW.md](../../domain/decisions/RFC-004-SME-REVIEW.md) — awaiting SME signatures; follow-up ADRs ADR-026/027/028 are Proposed.
