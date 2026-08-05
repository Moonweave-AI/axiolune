# ADR-026: `fin-orders` Quotation-Convention Broadening (OE-A7 follow-up)

**Status**: Proposed (gated on ADR-021 `instruments` v2.0.0 implementation + SME confirmation per RFC-004 Q6)
**Date**: 2026-08-05 (Proposed)
**Context**: Cross-module follow-up to [ADR-025](ADR-025-orders-execution-architecture.md) OE-A7 (P0-07)
**Related**: ADR-021 (instruments QuotationConvention), ADR-025 (orders v1.1.0), RFC-004 Q6, M2-PLAN §5.2

## Context

ADR-025 D7 narrowed `fin-orders` v1.1.0 to single-instrument, direct-unit quotation orders and scaffolded the extension to general quotation conventions via `executionQuotationConvention` (currently typed to the retained `DirectUnitPriceQuotationContract`) and `OrderLeg`/`ExecutionLeg` extension points. The full broadening — to express FX swaps, multi-leg strategies, bond yield/spread/discount, and CDS upfront — depends on `instruments` v2.0.0 introducing the abstract `QuotationConvention` parent (ADR-021 D1, not yet implemented).

This ADR defines the cross-module broadening once ADR-021 lands. It is **not** executable until `instruments` v2.0.0 ships the `QuotationConvention` hierarchy.

## Decision (proposed)

**Broaden `executionQuotationConvention` from `DirectUnitPriceQuotationContract` to the abstract `QuotationConvention` introduced by ADR-021, and complete the `OrderLeg`/`ExecutionLeg` multi-leg semantics. Retain all existing IRIs (additive); `DirectUnitPriceQuotationContract` becomes one profile of `QuotationConvention`.**

### D1. QuotationConvention adoption

- Change `executionQuotationConvention` range from `instruments/DirectUnitPriceQuotationContract` to `instruments/QuotationConvention` (the abstract parent from ADR-021).
- `executionQuotationContract` (ExactVersion → `DirectUnitPriceQuotationContract`) is **retained** as the v1 direct-unit profile; it becomes a sub-relation / specialized form of the broader hook.
- The module definition's "v1.1.0 covers single-instrument direct-unit" narrowing is lifted to "covers single-instrument and multi-leg orders under their reviewed QuotationConvention".

### D2. Multi-leg completion

- `OrderLeg` and `ExecutionLeg` (scaffolded in v1.1.0) become first-class: a multi-leg `OrderIntent` carries one or more `OrderLeg`s; the corresponding `Execution` carries matching `ExecutionLeg`s.
- `OrderIntentLineage` quantity conservation is extended to operate per-leg and across legs (the v1.1.0 conservation is per-instrument single-leg).
- FIX ExecutionReport multi-leg semantics inform the leg pairing and per-leg price/quantity.

### D3. Scope explicitly supported (after broadening)

- FX swap (two legs, same instrument pair, near/far dates)
- Multi-leg strategies (options spreads, calendar spreads)
- Bond yield/spread/discount quotation
- CDS upfront quotation

These were inexpressible in v1.1.0 and become expressible once `QuotationConvention` is the typed target.

## Compatibility

- **Version**: `fin-orders` v1.2.0 (additive minor) — `executionQuotationConvention` range broadened (a supertype, so existing `DirectUnitPriceQuotationContract` references remain valid); `OrderLeg`/`ExecutionLeg` semantics completed (additive).
- All existing IRIs retained. `Execution`/`Fee` IRIs unchanged (downstream `post-trade-operations`/`portfolio-positions` unaffected).
- **Prerequisite**: `instruments` v2.0.0 (ADR-021 D1) must ship `QuotationConvention` first. This ADR cannot be Accepted until that prerequisite is met and SME confirms the multi-leg semantics (RFC-004 Q6).

## Required evidence before Acceptance

- [ ] `instruments` v2.0.0 (ADR-021) implemented with `QuotationConvention` abstract parent.
- [ ] SME confirmation (execution + multi-asset + instruments) on the `OrderLeg`/`ExecutionLeg` pairing and per-leg conservation (RFC-004 Q6).
- [ ] Fixture-impact check confirms the `executionQuotationConvention` range broadening is non-breaking (supertype widening).
- [ ] Regression gates run (validate-m2-core, run-all-cq-probes, OWL/SHACL regen) with actual results.
- [ ] CQs added/updated for multi-leg quotation (e.g. CQ-OE18 multi-leg execution price).
- [ ] Terminology/alignments/traceability/gap updated for the broadening.

## Status

**Proposed.** Blocked on ADR-021 (`instruments` v2.0.0) and SME confirmation (RFC-004 Q6). The v1.1.0 module's `executionQuotationConvention` hook and `OrderLeg`/`ExecutionLeg` scaffolding make this a bounded, additive broadening once the prerequisite lands.

## References

- [ADR-025](ADR-025-orders-execution-architecture.md) D7 (OE-A7)
- [ADR-021](ADR-021-instruments-architecture.md) D1 (QuotationConvention)
- [RFC-004](../planning/RFC-004-orders-execution-architecture.md) Q6
- [orders-execution-semantic-gap.md](gap/orders-execution-semantic-gap.md) OE-A7
