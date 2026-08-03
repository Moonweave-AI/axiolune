# Portfolio Positions Semantic Gap

**Module**: fin-portfolio-positions  
**Version**: 1.0.0  
**Date**: 2026-08-03  
**Round-12**: all gaps closed at v1.0.0

## Track A (M2-PLAN scope)

- Models accounts, portfolios, holdings, positions, valuations, and PnL as temporal facts - not broker API snapshots as truth.
- Non-goal: conflating externally sourced holdings with execution-derived positions without provenance distinction.
- Central read-only slice A module for "what is held at as-of" queries feeding risk aggregation.

## Track B (reference/ alignment)

- FIBO FBC/SEC portfolio and account concepts inform Portfolio, Account, and membership patterns.
- Lean `Portfolio`/`Holdings` and NautilusTrader position/account models inform lot and signed-quantity stories.
- Lumibot position/cash semantics referenced for backtest-derived vs custodian snapshot distinction.

## Gaps

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| PP-G1 | shallow-definition | P2 | ExternalCostBasis narrative polish | **Closed** (v1.0.0) — external cost basis positive exists |
| PP-G2 | mapping-gap | P2 | Unified valuation mapping walkthrough | **Closed** (v1.0.0) — both input paths have fixtures |
| PP-G3 | weak-cq | P2 | Advanced valuation CQ negatives | **Closed** - money-without-currency negative linked |
| PP-G4 | broken-boundary | P2 | Mandate manager optional vs SHACL | **Closed** - CQ scope aligned with mandatory-manager neg |
| PP-G5 | orphan-type | P2 | SignedPosition in risk CQ deps | **Closed** - signed-position positive + risk CQ-R1 |

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Account/portfolio/holding keys stable and narratable |
| 2 | pass | Money and quantity types enforced; currency required on valuations |
| 3 | pass | Core types have genus/differentia and excludes |
| 4 | pass | v03 negatives cover valuation inputs, membership, mutable knowledge end |
| 5 | pass | Three-axis holding/valuation queries in active CQs |
| 6 | pass | Multiple active CQs with narratable negatives |
| 7 | pass | FIBO FBC + engine references cited |
| 8 | pass | Valuation-holding + external cost basis mapping fixtures |

P0/P1/P2 status: closed (Round-12 v1.0.0 2026-08-03)
