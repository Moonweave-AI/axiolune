# ADR-027: `fin-orders` Allocation Boundary (OE-A9 follow-up)

**Status**: Proposed (gated on `post-trade-operations` coordination + SME confirmation per RFC-004 Q4)
**Date**: 2026-08-05 (Proposed)
**Context**: Cross-module follow-up to [ADR-025](ADR-025-orders-execution-architecture.md) OE-A9 (P0-09)
**Related**: ADR-025 (orders v1.1.0), RFC-004 Q4, M2-PLAN §5.2, ISO 20022 securities-trade allocation, CFTC 17 CFR 1.35

## Context

ADR-025 D9 introduced `ExecutionAllocation` and `AllocationLine` in `fin-orders` v1.1.0 as a stable scaffold with quantity conservation (`ExecutionAllocationConservationContract`), and relaxed `ExecutionContract` so `executionAccount` may differ from `intentAccount` when an allocation is present. The detailed allocation, average-price allocation, and clearing semantics remain in `post-trade-operations`. This ADR defines the boundary between the `fin-orders` allocation scaffold and the `post-trade-operations` allocation/clearing detail, and the stable cross-module reference between them.

## Decision (proposed)

**Retain `ExecutionAllocation`/`AllocationLine` in `fin-orders` as the source-execution → target-accounts → quantity → status scaffold with conservation; define `post-trade-operations` as the owner of allocation instructions, average-price allocation, bunched-order back-allocation workflow, and clearing. The stable cross-module reference is the `Execution` version IRI (retained, IRI-stable).**

### D1. Boundary — what stays in `fin-orders`

- `ExecutionAllocation` (source execution → one or more `AllocationLine`s → quantity → status) with `ExecutionAllocationConservationContract`.
- `AllocationLine` (target account + quantity + status).
- The scaffold expresses *that* an execution is allocated across accounts with conservation; it does not express the allocation *instruction*, *workflow*, or *clearing*.

### D2. Boundary — what lives in `post-trade-operations`

- `AllocationInstruction` (the instruction to allocate, with account/quantity targets, cancel/replace/correction).
- Average-price allocation computation and booking.
- Bunched-order back-allocation workflow and status.
- Clearing and settlement allocation semantics.
- The reference back to the source `Execution` (and its `ExecutionAllocation`/`AllocationLine`s) is by the stable `Execution` version IRI.

### D3. Cross-module reference

- `post-trade-operations` references `fin-orders/Execution` (already an imported association range; IRI-stable per ADR-025).
- `fin-orders` does not import `post-trade-operations` (preserves the import DAG: orders → post-trade, not the reverse).
- The `ExecutionAllocation` in `fin-orders` is the allocation *fact*; the `AllocationInstruction` in `post-trade-operations` is the allocation *instruction/workflow*. The two are linked by the shared `Execution` reference, not by a direct IRI dependency from orders into post-trade.

## Compatibility

- **Version**: `fin-orders` remains v1.1.0 (the scaffold is already in place); `post-trade-operations` may extend to add `AllocationInstruction` etc. in its own revision.
- All existing IRIs retained. No new `fin-orders` types required by this ADR (the scaffold exists); the work is in `post-trade-operations` and the boundary documentation.
- **Prerequisite**: `post-trade-operations` coordination on the boundary and SME confirmation (RFC-004 Q4).

## Required evidence before Acceptance

- [ ] SME confirmation (execution + post-trade) on the boundary (RFC-004 Q4): scaffold in orders, detail in post-trade, `Execution` as the stable reference.
- [ ] `post-trade-operations` module updated to reference `fin-orders/Execution` for allocation (if not already).
- [ ] Fixture-impact check confirms the boundary is non-breaking.
- [ ] Regression gates run with actual results.
- [ ] CQs added for allocation boundary (e.g. CQ-OE19 allocation-to-clearing trace).
- [ ] Terminology/alignments/traceability/gap updated.

## Status

**Proposed.** Blocked on `post-trade-operations` coordination and SME confirmation (RFC-004 Q4). The v1.1.0 scaffold (`ExecutionAllocation`/`AllocationLine` with conservation) makes the boundary a documentation + post-trade extension, not a `fin-orders` structural change.

## References

- [ADR-025](ADR-025-orders-execution-architecture.md) D9 (OE-A9)
- [RFC-004](../planning/RFC-004-orders-execution-architecture.md) Q4
- [orders-execution-semantic-gap.md](gap/orders-execution-semantic-gap.md) OE-A9
- ISO 20022 securities-trade allocation; CFTC 17 CFR 1.35 (bunched order)
