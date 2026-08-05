# ADR-031: `fin-post-trade-runtime` Physical Profile Split (Deferred Design)

**Status**: Proposed (deferred design; not authorized for implementation until ADR-030 Accepted and RFC-006 Q6 SME-confirmed)
**Date**: 2026-08-05 (Proposed)
**Context**: Follow-up to [ADR-030](ADR-030-post-trade-operations-architecture.md) D7 (domain facts vs run-evidence layer separation)
**Related**: ADR-028 (document-deprecation + deferred physical split precedent), ADR-029 D6 (portfolio-positions runtime-profile split precedent), ADR-030, [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md) Q6

## Context

[ADR-030](ADR-030-post-trade-operations-architecture.md) D7 separated domain facts from run-reproducibility evidence by **document-scoped profile annotation** (no physical module split): the execution-and-reproducibility profile fields (`implementationDigest`, `runtimeDigest`, `inputContractDigest`, `outputContractDigest`, `referenceNormalizationDigest`, `canonicalizationDigest`, `numericTolerance`, all `*VersionSetDigest`, `*ProbeRef/Digest`) are optional evidence in the generic core and mandatory only when the profile is active. This kept the core able to express real post-trade state without requiring every business fact to attach to a data extraction or a runtime tool, and avoided a physical split against the M3 v0.6.0 frozen upstream baseline.

This ADR records the **deferred design** for the eventual physical split to a `fin-post-trade-runtime` module, per the ADR-028 document-deprecation precedent and the ADR-029 D6 precedent (which likewise deferred the `fin-portfolio-runtime` split). It is **not authorized for implementation** until ADR-030 is Accepted and RFC-006 Q6 (split boundary) is SME-confirmed.

## Decision (design only, deferred)

When authorized, the physical split will create `fin-post-trade-runtime` to hold the execution-and-reproducibility profile types and their profile-scoped constraint bindings, leaving `fin-post-trade-operations` as the generic semantic core.

### Proposed split boundary

**Move to `fin-post-trade-runtime`** (execution-and-reproducibility profile):
- `SettlementReconciliationComparator` object type and `SettlementReconciliationComparatorContract` (the strict-profile zero-tolerance/digest/runtime fields); the generic comparator abstraction stays in the core
- `StrictTechnicalSettlementReconciliationProfile` object type and `StrictTechnicalSettlementReconciliationProfileContract`
- `CorporateActionElectionProviderPolicy` object type and `ElectionProviderPolicyContract` (the version-set/closure-probe/digest fields); the generic election-policy semantics stay in the core
- The closure/probe/digest attributes on `CorporateActionElectionResolution`, `CorporateActionDueBillTransferFulfillmentClosure`, `CorporateActionSubscriptionFulfillmentClosure` (the strict closure proofs); the generic closure facts stay in the core
- All `*VersionSetDigest`, `*ProbeRef/Digest`, `runtimeDigest`, `implementationDigest`, `inputContractDigest`, `outputContractDigest`, `referenceNormalizationDigest`, `canonicalizationDigest`, `numericTolerance` attribute types and their profile-scoped `ConstraintBinding`s

**Stay in `fin-post-trade-operations`** (generic semantic core):
- All domain fact types: `SettlementInstruction`, `SettlementLeg`, `TradeSettlementAllocation`, `SettlementLegAllocation`, `SettlementStatusEvent`, `SettlementFinalityEvent`, `CorporateActionEvent`, `CorporateActionOption`, `CorporateActionEntitlement`, `CorporateActionElection`, `ExternalSettlementStatement`, `ExternalSettlementStatementLine`, `ReconciliationCase`, `SettlementReconciliationInternalProjection`, `MissingSideAssertion`, `IncompleteSourceCoverageAssertion`, `ReconciliationFinding`, `ReconciliationMatchGroup`, `ReconciliationStatusEvent`, `ReconciliationDisposition`, and the due-bill / subscription chains
- The generic comparator abstraction (`ReconciliationComparator` family) and the `SimpleDvpFopSettlementProfile` / `DirectRightsDueBillCorporateActionProfile` business profiles
- All core constraints (endpoints, conservation, sign, identity, direction, authority)

### Module dependency

`fin-post-trade-runtime` would **import** `fin-post-trade-operations` (the runtime profile depends on the core domain types it locks). The core would not import the runtime module. This preserves the existing DAG (post-trade-operations imports foundation/market-structure/instruments/market-rules/market-data/orders-execution/portfolio-positions) and adds one downstream leaf.

### Compatibility

The split would be a **v2.0.0 major** for `fin-post-trade-operations` (IRIs move between modules) and a **v1.0.0** for `fin-post-trade-runtime`. To preserve IRI stability, the moved IRIs would be retained as `owl:deprecated` re-export aliases in the core pointing to the runtime module, per the ADR-028 document-deprecation precedent, until consumers migrate. This is explicitly **not** the v1.1.0 additive-minor form.

## Required evidence before implementation (never fabricated)

- [ ] ADR-030 **Accepted** (SME sign-off on RFC-006 Q1–Q13).
- [ ] RFC-006 **Q6** SME-confirmed split boundary.
- [ ] M3 v0.6.0 frozen upstream baseline re-baselined to accommodate the new downstream leaf module, or the split deferred to an M3 cycle.
- [ ] Downstream consumer impact assessment (no current peer module imports post-trade-operations, so impact is expected to be none, but must be verified).
- [ ] Regression gates green after the split with actual results recorded.

## Status

**Proposed (deferred design).** No implementation is authorized in this revision. The v1.1.0 module annotates the execution-and-reproducibility profile in place per ADR-030 D7; the physical migration to `fin-post-trade-runtime` is deferred and gated on SME confirmation of RFC-006 Q6 and a follow-up implementation ADR.

## References

- [ADR-030](ADR-030-post-trade-operations-architecture.md) (D7 layer separation)
- [ADR-028](ADR-028-orders-layer-separation.md) (document-deprecation + deferred physical split precedent)
- [ADR-029](ADR-029-portfolio-positions-architecture.md) (D6 portfolio runtime-profile split precedent)
- [RFC-006](../planning/RFC-006-post-trade-operations-architecture.md) (Q6 split boundary)
