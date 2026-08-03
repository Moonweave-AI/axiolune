# fin-orders-execution Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| nautilus / Lean | OrderIntent | quantity + instrument required | CQ-OE1 | orders-v03-positive-intent-listed | pySHACL smoke PASS |
| FIX evidence | ExternalOrderStatusMapping | raw code → canonical state | CQ-OE5 | orders-v03-positive-status-mapping | pySHACL smoke PASS |
| FIBO | Execution | fill price + parties | CQ-OE3 | orders-v03-positive-execution-listed | pySHACL smoke PASS |
| M2-PLAN | OrderLifecycleEvent | order key digest required | CQ-OE2 | orders-v03-positive-lifecycle-event | pySHACL smoke PASS |
| ADR-012 | TemporalFact | availableFrom on events | CQ-OE4 | orders-v03-negative-missing-availability | pySHACL smoke PASS |
| M2-PLAN | OrderIntentLineage | result intent linkage | CQ-OE6 | orders-v03-positive-order-intent-lineage-split | semantic replay verified |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ-OE10 fee effect probes.
