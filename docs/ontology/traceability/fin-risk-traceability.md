# fin-risk Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| BIAN / M2-PLAN | RiskMeasureDefinition | definition ≠ result instance | CQ-R1 | risk-order-trace-v03-positive | `test-all-domain` PASS |
| ADR-012 | RiskMeasurement | three-axis temporal binding | CQ-R2 | risk-order-trace-v03 | `validate-pit` PASS |
| M2-PLAN | RiskLimit + applicability | limit scope binding | CQ-R3 | risk-order-trace-v03-negative | semantic replay verified |
| M2-PLAN | LimitBreach | measurement + limit evidence | CQ-R4 | risk-order-trace-v03 | `validate-pit` PASS |
| M2-PLAN | ScenarioDefinition + StressTestRun | immutable scenario version | CQ-R5 | risk-stress-scenario-v03-positive | semantic replay verified |
| ADR-012 | StressTestRun output | measurement version trace | CQ-R5 | risk-stress-scenario-v03-negative | `validate-pit` PASS |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: portfolio-level limit aggregation SPARQL probes.
