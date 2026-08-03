# fin-strategy-research Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| Qlib evidence | FactorDefinition | expression + universe scope | CQ-SR1 | strategy-research-positive | `test-all-domain` PASS |
| M2-PLAN | FactorObservation | revision chain + availableFrom | CQ-SR2 | factor-obs-revision-chain-positive | semantic replay verified |
| nautilus / Lean | StrategyDefinition | parameter + universe binding | CQ-SR3 | strategy-positive-001 | pySHACL smoke PASS |
| M2-PLAN | BacktestRun | MaterializationRun linkage | CQ-SR4 | strategy-positive-007 | pySHACL smoke PASS |
| ADR-012 | TemporalFact on observations | PIT reproducibility | CQ-SR5 | factor-obs-missing-availableFrom-negative | `validate-pit` PASS |
| Qlib | PerformanceObservation | benchmark alignment | CQ-SR6 | strategy-neg-001 | pySHACL smoke PASS |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: CQ-SR8 cross-module factor-to-signal probes.
