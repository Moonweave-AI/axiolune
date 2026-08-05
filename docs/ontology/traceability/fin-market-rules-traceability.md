# fin-market-rules Traceability Matrix

**Status**: review (v1.1.0)  
**Date**: 2026-08-04  
**Not a release sign-off**

| Source | Term / Element | Constraint | CQ | Fixture | Test run |
|--------|----------------|------------|----|---------|----------|
| FIBO (partial) | MarketRule + tick size | rule parameter binding | CQ-MR1 | market-rules-v03/positive-specificity-instrument | `test-all-domain` PASS |
| M2-PLAN | RuleApplicability | scoped temporal binding | CQ-MR2 | foundation-market-rules-contract-positive | `validate-pit` PASS |
| FIBO Settlement | SettlementConvention | T+N cycle parameter | CQ-MR3 | foundation-market-rules-contract | semantic replay verified |
| nautilus-trader | price_increment evidence | behavior reference only | CQ-MR1 | market-rules-v03/negative | `validate-pit` PASS |
| ADR-012 | TemporalFact on applicability | three-axis intervals | CQ-MR2 | foundation-market-rules-contract-negative | semantic replay verified |
| ADR-023 D1 | RuleSelectionOutcome | RuleSelectionOutcomeIntegrity | CQ-MR1 | market-rules-v03/positive-cq-execution | `run-all-cq-probes` 122/0/0 |
| ADR-023 D3 | ReferencePriceSpecification | PriceLimitReferencePriceBinding | CQ-MR2 | market-rules-v03/positive-cq-execution | `run-all-cq-probes` 122/0/0 |
| ADR-023 D5 | clauseOwnerRule | ClauseOwnerUniqueness | CQ-MR3 | market-rules-v03/positive-cq-execution | `run-all-cq-probes` 122/0/0 |
| ADR-023 D6 | settlementCycleCalendar / scheduleCalendar | ExactVersionReference | CQ-MR1 | market-rules-v03/positive-cq-execution | `run-domain-shacl` PASS |
| ADR-023 D7 | ScopeExpression / ScopeTerm | RuleApplicabilityRequiresExplicitScope v2 | CQ-MR2 | market-rules-v03/positive-cq-execution | `run-all-cq-probes` 122/0/0 |
| ADR-023 D10 | NormativeSource | ExactVersionReference | CQ-MR3 | market-rules-v03/positive-cq-execution | `run-all-cq-probes` 122/0/0 |

Unverified until pinned SPARQL/SHACL engine executes against staging graphs: cross-venue rule precedence SPARQL probes.

Regression (2026-08-04, v1.1.0): `validate-m2-core --all --strict` 10 modules 0 errors; all 10 modules OWL/SHACL regenerated cleanly; `run-domain-shacl` pySHACL PASS; `run-all-cq-probes` 122 PASS / 0 FAIL / 0 PENDING (61 CQs). `test-all-domain` step 2 has an environment-specific concurrent-IO race writing to `generated/` (affects a different unmodified module each run, `errno -4094 UNKNOWN`); individual module regeneration confirmed all 10 modules valid.
