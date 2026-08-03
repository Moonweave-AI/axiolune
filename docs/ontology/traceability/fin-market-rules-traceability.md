# fin-market-rules Traceability Matrix

**Status**: review (v1.0.0)  
**Date**: 2026-08-03  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO (partial) | MarketRule + tick size | rule parameter binding | CQ-MR1 | market-rules-v03/positive-specificity-instrument | `test-all-domain` PASS |
| M2-PLAN | RuleApplicability | scoped temporal binding | CQ-MR2 | foundation-market-rules-contract-positive | `validate-pit` PASS |
| FIBO Settlement | SettlementConvention | T+N cycle parameter | CQ-MR3 | foundation-market-rules-contract | semantic replay verified |
| nautilus-trader | price_increment evidence | behavior reference only | CQ-MR1 | market-rules-v03/negative | `validate-pit` PASS |
| ADR-012 | TemporalFact on applicability | three-axis intervals | CQ-MR2 | foundation-market-rules-contract-negative | semantic replay verified |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: cross-venue rule precedence SPARQL probes.
