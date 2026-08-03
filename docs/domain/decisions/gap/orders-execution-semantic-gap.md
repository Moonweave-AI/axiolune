# Orders Execution Semantic Gap

**Module**: fin-orders-execution  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

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
