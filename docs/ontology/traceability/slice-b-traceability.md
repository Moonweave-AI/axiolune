# Slice B Traceability Matrix (v1.0.0)

**Status**: review v1.0.0 — proves order lifecycle Execution → HoldingSnapshot chain  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| M2-PLAN §6.3 | OrderIntent | quantity + instrument context | CQ-OE1 | orders-v03-positive-intent-listed | pySHACL smoke PASS |
| M2 orders | OrderLifecycleEvent | order key digest | CQ-OE2 | orders-v03-positive-lifecycle-event | pySHACL smoke PASS |
| FIBO / engines | Execution | fill price + parties | CQ-OE3 | orders-v03-positive-execution-listed | pySHACL smoke PASS |
| ADR-012 | Execution → HoldingSnapshot | TemporalFact + sourcing link | CQ-OE4 | orders-portfolio-cq graph | `run-all-cq-probes` PASS |
| M2 portfolio | HoldingSnapshot | execution-sourced quantity | CQ-S3 | portfolio-positions-v03 + orders-portfolio-cq | `validate-pit` PASS (machine) |
| Cross-module | LimitBreach → Execution trace | breach via holding path | CQ-R4 | risk-order-trace-v03 | fixture + CQ probe PASS |
| M2-PLAN | OrderIntentLineage | result intent linkage | CQ-OE6 | orders-v03-positive-order-intent-lineage-split | semantic replay verified |

Chain narrative: **OrderIntent** → **Execution** (fill) → **HoldingSnapshot** (position) → optional **RiskMeasurement** / **LimitBreach** (CQ-R4).

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ-OE10 fee-effect SPARQL probes, promotion ledger digests.
