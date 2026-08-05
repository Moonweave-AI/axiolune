# Portfolio Positions Semantic Gap

**Module**: fin-portfolio-positions
**Version**: 1.1.0
**Date**: 2026-08-05
**Round-12**: all gaps closed at v1.0.0 (superseded for the semantically-complete claim by Round-16 below)
**Round-16**: v1.1.0 architecture revision per ADR-029

## Track A (M2-PLAN scope)

- Models accounts, portfolios, holdings, positions, valuations, and PnL as temporal facts - not broker API snapshots as truth.
- Non-goal: conflating externally sourced holdings with execution-derived positions without provenance distinction.
- Central read-only slice A module for "what is held at as-of" queries feeding risk aggregation.
- v1.1.0: generic semantic core + optional direct-unit/execution-driven/strict-closure/data-ingestion profile; position scope, balance dimension, lot lifecycle, and reconciliation comparison/finding/resolution added.

## Track B (reference/ alignment)

- FIBO FBC/SEC portfolio and account concepts inform Portfolio, Account, and membership patterns.
- Lean `Portfolio`/`Holdings` and NautilusTrader position/account models inform lot and signed-quantity stories.
- Lumibot position/cash semantics referenced for backtest-derived vs custodian snapshot distinction.
- FIX Position Report (Tag 702), ISO 15022 MT538, IFRS 13, GIPS, IRS Pub 550 inform v1.1.0 scope/dimension/valuation/lot/reconciliation.

## Gaps

### Round-12 (v1.0.0, closed)

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| PP-G1 | shallow-definition | P2 | ExternalCostBasis narrative polish | **Closed** (v1.0.0) |
| PP-G2 | mapping-gap | P2 | Unified valuation mapping walkthrough | **Closed** (v1.0.0) |
| PP-G3 | weak-cq | P2 | Advanced valuation CQ negatives | **Closed** (v1.0.0) |
| PP-G4 | broken-boundary | P2 | Mandate manager optional vs SHACL | **Closed** (v1.0.0) |
| PP-G5 | orphan-type | P2 | SignedPosition in risk CQ deps | **Closed** (v1.0.0) |

### Round-16 (v1.1.0, ADR-029)

| ID | Class | Severity | Description | Resolution |
|----|-------|----------|-------------|------------|
| PP-A1 | identity-weakness | P0 | Portfolio/membership/mandate logical keys omit identifying authority; stream identity conflated with contract | **Closed** (v1.1.0) — portfolioIdentifyingAuthority in key; stream identity = (provider, streamId) |
| PP-A2 | overloaded-quantity | P0 | Single signed quantity cannot express custody/accounting/economic views or gross long/short/net per bucket | **Closed** (v1.1.0) — PositionScope + BalanceDimension + grossLong/Short |
| PP-A3 | locked-valuation | P0 | Valuation locked to directUnitPriceTimesQuantity; par/accrual/multiplier/notional forbidden; no coverage closure | **Closed** (v1.1.0) — ValuationMethodFamily + DirectUnitValuationProfile + PortfolioValuationSummary |
| PP-A4 | locked-lot-lifecycle | P0 | Lot locked to execution-derived opening-remainder; no transfer/opening-balance/CA/manual-adjustment/realization lifecycle | **Closed** (v1.1.0) — PositionChange + LotAdjustment + LotRealization + lotSourceKind + derivedFromChange |
| PP-A5 | reconciliation-weak | P0 | External basis forced to internal definition; no ambiguous/notComparable/timingDifference/methodologyDifference/resolution | **Closed** (v1.1.0) — ReconciliationComparison/Finding/Resolution + externalBasisMethod/MappingStatus |
| PP-A6 | runtime-mixed | P0 | Domain facts and runtime artifacts (stream contracts, pagination, tool locks, strict closures) mixed in mandatory layer | **Closed** (v1.1.0) — document-scoped execution-and-reproducibility profile (physical split deferred to ADR-030) |
| PP-A7 | constituent-narrow | P0 | Portfolio restricted to account aggregation; mandate is management authority not investment mandate | **Closed** (v1.1.0) — PortfolioConstituent + Sleeve + PortfolioConstituentKind |
| PP-A8 | inconsistent-stream-ref | P1 | HoldingSnapshot exact-version vs PositionSnapshot/ExternalCostBasis logical reference | **Open (P1)** — observedFromStream hook documented; full unification deferred with SME |
| PP-A9 | position-source-narrow | P1 | PositionSourceKind collapsed non-external into executionDerived | **Closed** (v1.1.0) — PositionSourceKind extended with 7 non-execution sources |
| PP-A10 | fx-conversion-imprecise | P1 | FXConversion lacks cross-rate, rate source, quote time, finality | **Closed** (v1.1.0) — rateSource/quoteTime/rateDate/rateFinality/crossRatePath |
| PP-A11 | authority-scope-unstructured | P1 | authorityScope free text; performance/attribution mixed in | **Closed** (v1.1.0) — authorityScopeSubject/Role hooks; performance deferred to future module |

## v1.1.0 status

- Module v1.1.0 implemented and regression-verified (validate-m2-core --all --strict PASS, run-domain-shacl PASS, OWL/SHACL regeneration PASS).
- Staging fixtures created (orders-execution-style `instances:` dialect) for the new types; CQ probes PP8..PP15 wired with staged-count reporting.
- SME joint review on RFC-005 Q1–Q8 outstanding (ADR-029 Proposed).
- Physical runtime-profile split (ADR-030 candidate) and performance-and-attribution module deferred.

## Rubric sign-off

| # | Pass | Reviewer note |
|---|------|---------------|
| 1 | pass | Portfolio/holding/lot keys stable and authority-scoped |
| 2 | pass | Money and quantity types enforced; currency required on valuations |
| 3 | pass | Core types have genus/differentia and excludes (terminology v1.1.0) |
| 4 | pass | v1.1.0 negatives cover lot discriminator, change kind, comparison family, resolution |
| 5 | pass | Three-axis holding/valuation/lot-lifecycle/reconciliation queries in active CQs |
| 6 | pass | Multiple active CQs with narratable negatives (PP1..PP15) |
| 7 | pass | FIBO + FIX + ISO 15022 + IFRS 13 + GIPS + IRS Pub 550 references cited |
| 8 | pass | Valuation-holding + external cost basis + reconciliation mapping fixtures |

P0/P1/P2 status: P0 closed (Round-16 v1.1.0 2026-08-05); PP-A8 open (P1, deferred with SME).
