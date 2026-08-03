# Post-Trade Operations Semantic Gap

**Module**: fin-post-trade-operations  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Models corporate actions, settlement instructions, reconciliation breaks, and operational exceptions as provenanced facts.
- Non-goal: replacing trading front-end order state; full custodian operational workflow automation.
- Largest module by type count; closes lifecycle from execution to settled/reconciled state.

## Track B (reference/ alignment)

- ISO 15022 / SWIFT settlement and corporate action messages inform SettlementInstruction and entitlement semantics.
- FIBO CAE/SEC corporate action events anchor CorporateActionEvent subtypes via terminology alignment.
- Lean settlement model and broker reconciliation patterns in NautilusTrader/vn.py inform break detection ordering.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| PTO-G1 | weak-cq | P0 | Stub CQs vs 300+ types | **Closed** - 10 active CQs (CQ-PTO1-PTO10) per ADR-018 |
| PTO-G2 | orphan-type | P1 | Exotic CA subtypes without CQ | **Closed** (v1.0.0) ? ADR-018 matrix + exotic fixtures (CQ-PTO6-PTO8) |
| PTO-G3 | broken-boundary | P1 | Bilateral break negative | **Closed** - reconciliation negative fixture |
| PTO-G4 | mapping-gap | P1 | Custodian to break mapping | **Closed** - economic-allocation contract fixture |
| PTO-G5 | shallow-definition | P2 | SettlementInstruction vs status | **Closed** - settlement contract negatives |
| PTO-G6 | weak-cq | P0 | CQ probe fake PASS | **Closed** - probes stage events/findings/instructions |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Event/instruction keys + break identity in matrix |
| 2 | pass | Money on entitlements in contract negatives |
| 3 | pass | Subtype excludes via event-field-matrix |
| 4 | pass | Bilateral break stories in reconciliation fixture |
| 5 | pass | TemporalFact + availability in probes |
| 6 | pass | Ten active CQs (CQ-PTO1-PTO10); probes 0 pending |
| 7 | pass | ISO 15022 + FIBO CAE in bibliography |
| 8 | pass | Reconciliation mapping slice in closure fixture |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)
