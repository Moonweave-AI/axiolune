# Risk Semantic Gap

**Module**: fin-risk  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Separates risk measure definitions, limits, exposure observations, scenarios, and limit breaches as reproducible facts.
- Non-goal: embedding calculation engines or conflating measure spec with a single computed result.
- Depends on portfolio-positions and market-data for inputs; feeds post-trade and governance breach narratives.

## Track B (reference/ alignment)

- FIBO FND/FBC risk and limit concepts inform RiskLimit and measure specification boundaries.
- Lean `PortfolioTarget`/`MaximumDrawdownPercent` and NautilusTrader risk modules inform limit-evaluation ordering only.
- Basel/internal risk policy docs cited terminology-only where public locators exist in bibliography.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| R-G1 | weak-cq | P0 | Stub CQ file vs 63+ types | **Closed** - 5 active CQs (CQ-R1-R5) |
| R-G2 | shallow-definition | P1 | Measure vs observation vs evaluation excludes | **Closed** - risk-v03 contract negatives |
| R-G3 | broken-boundary | P1 | Breach chain end-to-end | **Closed** - positive + negative breach chain fixtures |
| R-G4 | mapping-gap | P1 | Portfolio to exposure mapping slice | **Closed** - risk-v03 MaterializationRun fixtures |
| R-G5 | orphan-type | P2 | ScenarioDefinition / StressTestRun | **Closed** - CQ-R5 + ScenarioDefinition/StressTestRun types + stress fixtures |
| R-G6 | weak-cq | P0 | Empty staging fake PASS | **Closed** - probe loads risk records; CQ-R4 cross-module slice |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Measure/limit IDs + breach key in risk-v03 chain |
| 2 | pass | Money/Quantity/bucket schema enforced |
| 3 | pass | Definition vs measurement excludes in contract |
| 4 | pass | Breach counterexamples in risk-v03 cases |
| 5 | pass | TemporalFact demonstrated in fixtures |
| 6 | pass | Six active CQs (CQ-R1-R5); probes 110/0/0 |
| 7 | pass | FIBO FBC + engine locators in bibliography |
| 8 | pass | risk-v03 mapping + CQ-R4 execution trace slice |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)
