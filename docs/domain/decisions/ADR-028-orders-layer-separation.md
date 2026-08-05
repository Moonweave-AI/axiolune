# ADR-028: `fin-orders` Layer Separation (OE-A10 follow-up)

**Status**: Proposed (gated on SME confirmation per RFC-004 Q5; deferred, not blocking v1.1.0)
**Date**: 2026-08-05 (Proposed)
**Context**: Cross-module follow-up to [ADR-025](ADR-025-orders-execution-architecture.md) OE-A10 (P0-10)
**Related**: ADR-025 (orders v1.1.0), RFC-004 Q5, M2-PLAN §5.2, ADR-011 (canonical data binding), ADR-012 (three-axis temporal)

## Context

ADR-025 D10 document-deprecated the adapter/runtime/quality-existence conditions in `fin-orders` v1.1.0: `OrderTransitionProfile` implementation/tool/runtime digests, `LiquidityRoleMapping` adapter mapping, `OrderIntentLineage` validation runs/reports/ledgers, and `OrderEventIntegrityFinding` probes/digests are scoped as **evidence of an interpretation/check, not existence conditions** of an order fact. The domain invariants (endpoints, quantity conservation, acyclicity, order chain, time, roles) are retained on the domain types. The physical migration of adapter/runtime/quality evidence to boundary modules is a measured follow-up requiring SME joint review.

This ADR defines the layer split: a domain layer (`fin-orders`), an adapter/mapping layer, and a quality/runtime-evidence layer.

## Decision (proposed)

**Split `fin-orders` into three layers in a v2.0.0 major revision (IRIs retained/re-homed), after SME confirms the boundary. The domain layer keeps order/execution facts; the adapter/mapping layer keeps status mapping, liquidity mapping, and transition profile; the quality/runtime layer keeps integrity findings and evidence ledgers. Execute only after the v1.1.0 domain facts are proven correct and the cross-module quotation/allocation follow-ups (ADR-026/027) have landed or been scoped.**

### D1. Domain layer (`fin-orders`, retained IRI)

- `OrderIntent`, `OrderIntentLifecycleEvent`, `OrderLifecycleEvent`, `OrderRoute`, `ExternalOrder`, `Execution`, `MatchedTrade`, `FillSnapshot`, `Fee`, `ExecutionAllocation`, `AllocationLine`, `OrderRevision`, `OrderLeg`, `ExecutionLeg`.
- `OrderIntentLineage` (domain provenance: endpoints, conservation, acyclicity — the domain invariants stay here).
- Domain vocabularies (`OrderSide`, `OrderType`, `TimeInForce`, `OrderLifecycleState`, `OrderEventKind`, `FeeKind`, `FeeEffect`, `DisclosureStatus`, `PositionEffect`, `ShortSaleIndicator`, `OrderCapacity`, `RevisionKind`, `RouteStatus`, `AllocationStatus`).

### D2. Adapter/mapping layer (proposed `fin-orders-adapter`, new module)

- `ExternalOrderStatusMapping`, `ExternalOrderStatusVocabulary`, `LiquidityRoleMapping`, `OrderTransitionProfile`.
- The implementation/tool/runtime digests (`implementationDigest`, `toolLockRef/Digest`, `runtimeDigest`, `inputContractDigest`, `outputContractDigest`) move here as evidence-of-interpretation, not existence conditions.
- The declarative `transitionTable` (fromState × eventKind → toState + condition) stays here as the reviewable evaluator definition.

### D3. Quality/runtime-evidence layer (proposed `fin-orders-quality` or data-binding boundary)

- `OrderEventIntegrityFinding` (with `lateFill` not a-priori an error; abstract `Finding` + kind-specific subject subtypes per Round-15 P1-9).
- `LiquidityRoleDetermination` (the determination fact, with its source-record/absence-probe evidence).
- Evidence ledgers and validation-run references (currently embedded in `OrderIntentLineageContract`).

### D4. IRI stability

- All existing `orders-execution` IRIs are **retained** (re-homed to the appropriate layer module), per the ADR-020..024 IRI-retention precedent. Downstream `post-trade-operations`/`portfolio-positions` ranges (`Execution`, `Fee`) are unchanged.
- The import DAG is revised: `fin-orders` (domain) imports `foundation`/`instruments`/`market-structure`/`market-rules`; `fin-orders-adapter` imports `fin-orders`; `fin-orders-quality` imports `fin-orders` + `fin-orders-adapter`. Downstream modules import only `fin-orders` (domain) — their `Execution`/`Fee` ranges are unaffected.

## Compatibility

- **Version**: 2.0.0 (major) — new module IRIs and registry entries for the adapter and quality layers; `fin-orders` domain layer keeps its IRI at a new major version.
- `Execution`/`Fee` IRIs retained (re-homed to domain layer); downstream unchanged.
- CQs, fixtures, alignments, traceability split per layer.
- **Prerequisite**: SME joint review (data engineering + quality + execution) on the boundary (RFC-004 Q5). This is the *last* practical step in the review's convergence order, after the domain facts are correct.

## Required evidence before Acceptance

- [ ] SME confirmation (data engineering + quality + execution) on the three-layer boundary (RFC-004 Q5).
- [ ] ADR-026 (quotation) and ADR-027 (allocation) scoped or landed (the domain facts must be stable before splitting).
- [ ] Registry entries for `fin-orders-adapter` and the quality layer.
- [ ] Import-DAG revision and fixture/probe/alignment rework plan.
- [ ] Regression gates run with actual results after the split.

## Status

**Proposed.** Blocked on SME joint review (RFC-004 Q5). The v1.1.0 document-deprecation makes the eventual split a migration of already-isolated evidence, not a domain-semantics change. This is the lowest-priority follow-up and is explicitly **not blocking** the v1.1.0 revision.

## References

- [ADR-025](ADR-025-orders-execution-architecture.md) D10 (OE-A10)
- [RFC-004](../planning/RFC-004-orders-execution-architecture.md) Q5, Option B
- [orders-execution-semantic-gap.md](gap/orders-execution-semantic-gap.md) OE-A10
- [M2-REVIEW-ROUND-15](M2-REVIEW-ROUND-15.md) P0-10, P1-9
